# Hosting nodes and leases

The fleet can lend a node to a **tenant**: another repo's workload that needs a
box with no CI on it. The scope was set by the operator on 2026-10-24. The fleet
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
fleet hosting claw-8 --tenant cardtable --memory 12G --cores 6
fleet hosting --check [--json]
fleet hosting claw-8 --end --in 30m           # at least 15 min of notice
fleet hosting claw-8 --remove                 # after the end has passed
```

Each fact is written in one place and read back from another:

| fact             | written by                                                | read back from                                                   |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| no CI            | drain record `kind: hosting`                              | the process tree: no `Runner.Listener`, no `Runner.Worker`       |
| memory           | `MemoryMax`, `MemorySwapMax=0` on the user slice          | `memory.max`, `memory.swap.max` in the slice's cgroup            |
| cores            | `CPUQuota=N*100%` on the user slice                       | `cpu.max` in the slice's cgroup                                  |
| agent supervised | user service, `Restart=always`, started by a `.path` unit | the process listening on the port, and that it sits in the slice |
| one LAN port     | ufw: the controller's reserved LAN address to the port    | `ufw status`                                                     |

**Cores are a quota, not pinned CPUs.** The claws' user manager delegates `cpu`,
`io`, `memory` and `pids`, but not `cpuset`, so a user slice cannot be given
`AllowedCPUs`. A JVM may not read a nested cgroup's quota, so size thread pools
explicitly (`-XX:ActiveProcessorCount=N`).

**Swap is off for the slice.** A JVM that swaps misses the 5 s AI decision
cutoff and plays worse without raising an error. Running out of memory fails
loudly, and the tenant can handle that.

**The fleet supervises the agent but never ships it.** The tenant installs an
executable at `~/.local/share/cardtable-agent/run`. A `.path` unit starts it as
soon as it exists, with `CARDTABLE_AGENT_PORT` set. Until then the agent reads
`not-installed`, which is advisory, not blocking.

**The tenant is owed notice.** Any drain on a hosting node, and `--end`, must
start at least 15 minutes ahead unless `--force`. A maintenance window on a
hosting node is stored as a planned drain on top of the hosting record. It does
not erase the hosting record, and the record applies again once the window closes.

## Status

`fleet node-status --json` reports, per node: `reachable` and `observedAt`
(live, one ssh per node during the call), `lastSeenAt`, the CI processes on the
box, the drain in force and `notices` of scheduled starts and ends, the earned
capabilities, the daily health record with its age, and for a hosting node the
declared resources next to the observed ones. A node that cannot be reached,
whose answer is cut off, or whose health record is more than 36 h old has a
blocking finding and `ok: false`.
