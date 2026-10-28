# Hosting nodes and leases

The fleet can lend a node to a **tenant**: another repo's resident workload,
served beside CI or on a box with no CI on it. The scope was set by the operator on 2026-10-24. The fleet
gets nodes online, reports their status, and **serves the resources it declares**.
The tenant decides which node runs its work INSIDE its slices, and owns
failover and alerting. Since 2026-10-28 (operator ruling, fleet-manager#16)
the fleet can also pick the nodes for a tenant's slices and meet its demand
for them: see "Slices on demand" below. A tenant opts into that with
`placement.auto: true`; without it, the fleet only plans.

The first tenant is hadoku-cardtable, which hosts Forge matches. Its request is
`docs/requests/FLEET_MANAGER_FORGE_HOSTING.md` in that repo.

## Leases: a node for a window

```sh
fleet drain claw-8 --kind lease --for 48h --reason "cardtable stress lease"
fleet drain claw-3 --kind lease --for 20m --reason "cardtable calibration"
fleet drain claw-3 --undo                     # end it early
```

A lease is a drain that **ends by the clock**. Every reader treats a record past
its `until` as absent, through one function (`effectiveDrains`), so the
dispatcher, the gates and `--status` cannot disagree about whether a lease is
over. A drain never kills a running job: wait for `fleet drain --status` to say
`drained` before starting load.

`--in 30m` / `--at <iso>` schedule a drain instead of starting it. Scheduled
drains appear in `fleet node-status --json` under `notices` until they start.

## Hosting nodes

```sh
fleet hosting claw-9 --tenant cardtable --memory 4G --cores 4 --shared   # CI stays
fleet hosting claw-8 --tenant cardtable --memory 12G --cores 6           # whole box, no CI
fleet hosting claw-9 --install ./run --sha256 <hex>   # the tenant's executable, root-owned
fleet hosting claw-9 --restart                        # after the agent upgrades itself
fleet hosting --check                                 # declared vs observed, from the kernel
fleet hosting claw-9 --end --in 30m                   # at least 15 min of notice
fleet hosting claw-9 --remove                         # after the end has passed
fleet hosting claw-9 --ci-shaped [--wait] -- <cmd>    # a process contained as a CI job is (tests)
```

Every action takes `--json`: one document on stdout, `{ ok, action, node,
state, reason, ... }`, and exit 0 only when the action was done. A declaration
is `ok` only once `--check` reads the whole guarantee back.

### Two modes

**Shared** (`--shared`) is the default for cardtable. CI keeps the box and ranks
below the slice. The operator's priority, 2026-10-25, is pm2 and deploy CI first,
then the tenant, then all other CI. Deploys run on hokon, which never hosts, so
on a claw the tenant outranks every CI job. **What the slice is not using goes
back to CI**:

- **CPU**: the slice's parent `hosting.slice` has `CPUWeight=10000` against
  `user.slice`'s 100 (where CI runs). The slice's own `CPUQuota` caps it at the
  declared cores. Measured on claw-9 on 2026-10-25 with CI saturating 8 CPUs:
  the slice got 3.96 of its 4. Equal weight gave 3.35. When the slice is idle,
  CI gets all of them.
- **Memory**: `MemoryMin` on the slice and its parent. CI's ceiling does not
  move. Instead the dispatcher **holds back** the part of the slice the tenant
  is not using, reading the slice's `memory.current` on the same ssh as free
  memory, so no new job is admitted into it. The whole declaration is held
  back for 10 minutes after a declaration, and while the slice holds less than
  256 MiB (the agent is not up yet).
- **OOM order**: every CI unit runs at `oom_score_adj` 500, and the agent at
  -500. A CI job that grows into the tenant's share anyway is the one the
  kernel kills.

**Whole** (no `--shared`) holds CI off the node with a drain of `kind:
hosting`, so the tenant has the box alone. Use it for a node too small to share,
or one the tenant wants free of CI.

### What is served, and where it is read back

Nothing is read from a unit file the fleet wrote.

| fact                   | written by                                                                                                                                                       | read back from                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| memory                 | `MemoryMax`, `MemoryMin`, `MemorySwapMax=0` on `hosting.slice/hosting-<t>.slice`                                                                                 | `memory.max`, `memory.min`, `memory.swap.max` in its cgroup                         |
| protection reaches     | `MemoryMin` on `hosting.slice`                                                                                                                                   | the parent's `memory.min` (a parent at 0 caps the child at 0)                       |
| cores                  | `CPUQuota=N*100%`                                                                                                                                                | `cpu.max`                                                                           |
| priority               | `CPUWeight=10000` on `hosting.slice`                                                                                                                             | the parent's `cpu.weight`                                                           |
| the agent's own user   | `useradd --system`, nologin, its own group                                                                                                                       | `getent`, `id -G` against the CI user's groups, `sudo -l -U`                        |
| files                  | home 0700 owned by the agent; executable and its dir root-owned                                                                                                  | `stat`                                                                              |
| agent supervised       | system unit, `User=`, `Restart=always`, started by a `.path` unit                                                                                                | the process on the port: its uid, cgroup and `oom_score_adj`                        |
| CI ranks below         | `ciUnitProperties` on every CI unit, and the standing units' drop-in                                                                                             | every `Runner.*` process: in `runners.slice`, `oom_score_adj ≥ 500`                 |
| CI's headroom (shared) | `MemoryHigh` on `runners.slice` = its `MemoryMax` less the declared slice                                                                                        | `memory.high` against `memory.max` in its cgroup                                    |
| no CI (whole only)     | drain record `kind: hosting`                                                                                                                                     | the process tree: no `Runner.Listener`, no `Runner.Worker`                          |
| controller-only port   | ufw: the controller's LAN address. Tailnet: `hosting-<t>-port.service` drops the port in the `raw` table for every source but the controller's tailnet addresses | connecting: the controller must get in, another node must time out on every address |

**The agent runs as its own system user** (cardtable §9). The fleet supervises
it and never ships it: `--install` streams the tenant's file over ssh straight
into a root-owned path, checks its sha256 there, then swaps it in. No step
passes through anything the CI user can write. **The CI user keeps NOPASSWD
sudo on the claws** (operator ruling, 2026-10-25), so the separate user stops a
job reaching the agent without sudo. It does not stop a job that deliberately
becomes root.

**The port is open to the controller and nothing else, and that is tested by
connecting.** tailscaled puts its own `ts-input` chain first in INPUT, and it
ACCEPTs everything on `tailscale0`, so ufw never sees tailnet traffic. Any ufw
rule for the tailnet, the mesh allow included, is decoration. On 2026-10-27
claw-8 reached claw-9's agent over the tailnet while `ufw status` showed a
controller-only rule; 0.34.91 then prepended tailnet rules to ufw, and claw-1
still got in. The drop now lives in the `raw` table's PREROUTING, which runs
before every filter chain and which tailscaled never touches, held by a oneshot
unit that re-asserts it at boot and on every deploy. `--check` and
`node-status` probe the port from the controller (must connect or be refused)
and from another node, tried in turn until one answers (must time out on the
LAN and both tailnet addresses). No node able to look is blocking, not a pass.

**A re-deploy that changes no unit leaves the agent running.** A restart kills
the tenant's JVMs, so the agent restarts only when its slice or service unit
actually changed. And a restart signals only the agent: the unit carries
`Delegate=yes` and `KillMode=process`, so the tenant places its workers in its
own sub-cgroups and they outlive the agent (cardtable's JVMs keep their
matches). The slice's `MemoryMax` and `CPUQuota` still bound the whole subtree.
`--remove` kills the workers before it removes the unit.

**Protection keeps pages, not latency.** In cardtable's A6 (2026-10-27) a
global memory squeeze left every one of the slice's pages in place, because
`memory.min` held, and its threads still stalled 66 s in direct reclaim. CI's
ceiling is the node's RAM less its floor and does not subtract the slice, so CI
alone can cause that squeeze. On a shared node the deploy therefore gives
`runners.slice` a `MemoryHigh` of its `MemoryMax` less the slice: past that, CI
reclaims its own cache and is throttled before the box is. Minted units run at
`MemorySwapMax=0`, so this cannot become the swap thrash that keeps
`MemoryHigh` off `runners.slice` everywhere else.

**The firewall does not reach loopback.** A CI job on the same node connects to
the agent over `127.0.0.1`, which ufw never filters. So the port being closed to
other nodes is not authentication: the tenant authenticates every request
(cardtable signs them).

**Cores are a quota, not pinned CPUs.** A JVM may not read a nested cgroup's
quota, so size thread pools explicitly (`-XX:ActiveProcessorCount=N`).

**Swap is off for the slice.** A JVM that swaps misses the 5 s AI decision
cutoff and plays worse without raising an error. Running out of memory fails
loudly, and the tenant can handle that.

**The tenant is owed notice.** `--end`, and a `reboot` drain on a hosting node,
must start at least 15 minutes ahead unless `--force`. On a whole-box node any
drain is refused at short notice. On a shared node, a maintenance drain only
takes CI off and needs no notice. `node-status` reports a hosting node that
rebooted with no reboot drain ahead of it.

## Slices on demand

```sh
fleet hosting-demand cardtable --slices 2 --release-order claw-6,claw-5 --json
fleet hosting-demand cardtable --json        # the view only
fleet hosting-converge --dry-run --json      # what the converger would do now
```

The tenant says how many slices it wants, as a **count**, on every poll. The
same N is a no-op, so a restart, a lost call or a duplicate cannot drift it.
The controller runs `fleet hosting-converge` every 5 minutes, and it meets
the count within the request's `slices.min..max`:

- **Too few:** it declares on `fleet hosting-plan`'s top picks through `fleet
hosting`, which observes the node and applies the tenant's placement again.
- **Too many:** it ends slices from the head of the tenant's
  `--release-order`, always with the tenant's `noticeMin`. Only the tenant
  knows what a slice holds, so with no order it ends nothing and says so.
- **Past an end:** it removes the units.

It **acts only for a tenant whose hosting.json says `placement.auto: true`**.
For every other tenant it reports what it would do (`planned`), and
`hosting-demand` returns that view, so a tenant can compare it with its own
judgement first.

A slice on a node that cannot be reached, that fails a required rule, or
that has another drain starting within its notice is **unplaceable**. It is
not counted as serving, and it is never ended by the converger: the tenant
moves its work off and names the slice in its release order.

**A singleton service is never given a second slice.** Its move goes through
hadoku_site's mover (`service-move`, hadoku_site#491), and the converger says
which node the plan would pick. A singleton on a node that cannot be reached
is never moved off unless it declares `availability.fence: "data-lease"`.
That means a dataplatform lease, with state kept off the node, as pygmalion
does. Two writers are worse than none.
A fenced singleton may also ask for `availability.standby: N`: N more running
copies, each on its own node, that wait on the lease. The plan lists them in
their own `standby` entry, held to every rule the primary is, `runtime`
included. A standby's record carries `role: "standby"`, so it never counts
toward `slices.max`, as serving, or as a second writer. What a service must do
to earn that fence, and how to request it, is
[service-state.md](service-state.md).

## Status

`fleet node-status --json` reports, per node: `reachable` and `observedAt`
(live, one ssh per node during the call), `lastSeenAt`, the CI processes on the
box, the drain in force and `notices` of scheduled starts and ends, the earned
capabilities, the daily health record with its age, and for a hosting node its
mode, the declared resources next to the observed ones, and its scheduled end. A node that cannot be reached,
whose answer is cut off, or whose health record is more than 36 h old has a
blocking finding and `ok: false`.
