# Hosting nodes and leases

The fleet can lend a node to a **tenant**: another repo's resident workload,
served beside CI or on a box with no CI on it. The scope was set by the operator on 2026-10-24. The fleet
gets nodes online, reports their status, and **serves the resources it declares**.
The tenant decides which node runs what, and owns failover and alerting.
Nothing here picks a node.

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

| fact                 | written by                                                                                                    | read back from                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| memory               | `MemoryMax`, `MemoryMin`, `MemorySwapMax=0` on `hosting.slice/hosting-<t>.slice`                              | `memory.max`, `memory.min`, `memory.swap.max` in its cgroup                         |
| protection reaches   | `MemoryMin` on `hosting.slice`                                                                                | the parent's `memory.min` (a parent at 0 caps the child at 0)                       |
| cores                | `CPUQuota=N*100%`                                                                                             | `cpu.max`                                                                           |
| priority             | `CPUWeight=10000` on `hosting.slice`                                                                          | the parent's `cpu.weight`                                                           |
| the agent's own user | `useradd --system`, nologin, its own group                                                                    | `getent`, `id -G` against the CI user's groups, `sudo -l -U`                        |
| files                | home 0700 owned by the agent; executable and its dir root-owned                                               | `stat`                                                                              |
| agent supervised     | system unit, `User=`, `Restart=always`, started by a `.path` unit                                             | the process on the port: its uid, cgroup and `oom_score_adj`                        |
| CI ranks below       | `ciUnitProperties` on every CI unit, and the standing units' drop-in                                          | every `Runner.*` process: in `runners.slice`, `oom_score_adj ≥ 500`                 |
| no CI (whole only)   | drain record `kind: hosting`                                                                                  | the process tree: no `Runner.Listener`, no `Runner.Worker`                          |
| controller-only port | ufw: the controller's LAN address; its tailnet addresses, then a tailnet deny, prepended above the mesh allow | connecting: the controller must get in, another node must time out on every address |

**The agent runs as its own system user** (cardtable §9). The fleet supervises
it and never ships it: `--install` streams the tenant's file over ssh straight
into a root-owned path, checks its sha256 there, then swaps it in. No step
passes through anything the CI user can write. **The CI user keeps NOPASSWD
sudo on the claws** (operator ruling, 2026-10-25), so the separate user stops a
job reaching the agent without sudo. It does not stop a job that deliberately
becomes root.

**The port is open to the controller and nothing else, and that is tested by
connecting.** Every claw's ufw carries a blanket `Anywhere on tailscale0`
allow, and ufw matches in order, so a port rule appended below it never
applies: on 2026-10-27 claw-8 reached claw-9's agent over the tailnet while
`ufw status` showed the controller-only rule. The deploy now prepends the
tailnet rules, and `--check` and `node-status` probe the port from the
controller (must connect or be refused) and from another node, tried in turn
until one answers (must time out on the LAN and both tailnet addresses). No
node able to look is blocking, not a pass.

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

## Status

`fleet node-status --json` reports, per node: `reachable` and `observedAt`
(live, one ssh per node during the call), `lastSeenAt`, the CI processes on the
box, the drain in force and `notices` of scheduled starts and ends, the earned
capabilities, the daily health record with its age, and for a hosting node its
mode, the declared resources next to the observed ones, and its scheduled end. A node that cannot be reached,
whose answer is cut off, or whose health record is more than 36 h old has a
blocking finding and `ok: false`.
