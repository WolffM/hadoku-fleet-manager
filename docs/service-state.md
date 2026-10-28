# A hosted service's state: the contract

Every hosted service that keeps data follows this contract, whichever node it
runs on. It says where a service's state must live before the fleet may move
the service by itself, give it a standby, or fail it over. It sits on top of
the hosting request ([hosting.md](hosting.md), `hosting.json` in the app's
repo) and dataplatform's data endpoint (hadoku-dataplatform
`server/dataplatform/data/AGENTS.md`, the HTTP contract). This file does not
repeat either one.

The rule is one sentence: **no node holds the only copy of anything.** A node
may cache. The store is the truth.

## Two levels

| level        | the service declares                                               | what the fleet may do                                                                                                                          |
| ------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **on-node**  | `availability.stateful: true`                                      | move it off a REACHABLE node only: stop, copy, start (hadoku_site's `service-move`). An unreachable node pages, and nothing moves. No standby. |
| **off-node** | `availability.singleton: true`, `availability.fence: "data-lease"` | everything above, plus move it off an UNREACHABLE node, run a standby, and fail over to it.                                                    |

A service with no state at all declares `stateful: false` and is out of
scope.

**On-node is a valid place to stop.** It is the right level for a service
whose data is large, cheap to rebuild, or rarely written. Off-node is the
price of a standby, and only a service that wants one pays it.

## Off-node: what the service must do

Every item is something the fleet or the placement layer READS from the
running service. A claim in a README does not count.

1. **A namespace.** The operator binds one namespace to the service's own key
   (`dataplatform data grant <ns> --user-id <uuid>`). The service never
   shares a namespace or a key with another service.
2. **Configured from placement, not code.** The service reads
   `HADOKU_DATA_URL` and `HADOKU_SERVICE_KEY` from its environment, which the
   hadoku_site wrapper injects from the vault. No literal address is ever
   written in its code. With `HADOKU_DATA_URL` unset, the service runs
   on-node, as before: local development, tests, and the moment before the
   cutover.
3. **The vendored client.** Copy dataplatform's `client.py` verbatim, and
   pin its digest in a test so that an edit made locally fails the build. A
   fix belongs upstream, and you copy it again from there.
4. **One lease fences the writer.** The process takes a lease over
   everything it writes before it serves anything. It holds the lease for as
   long as it serves, and sends the lease's token with every write. A process
   that loses the lease stops writing and exits, so its manager starts it
   again as a standby. Per-key leases are optional. Only the outer lease is
   required.
5. **Health follows the lease.** `/health` answers **503 until** the process
   holds the lease and has reconciled. Once it serves, the body carries
   `central: {state, committed_s_ago}`. This is what placement routes by: the
   node whose `/health` is 200 is the primary, whatever any record says.
6. **The disk is a working copy.** On takeover, the process reconciles its
   tree against the store. Revalidate with the change feed, not by reading
   everything again. Never delete what reconcile cannot account for: a local
   file the store lacks goes to an orphans directory. **An empty store next
   to a full tree refuses to start.** That is a node pointed at the store
   before its import ran.
7. **Write in shapes the store makes cheap.** Logs are appended, never
   rewritten. A large structure rewritten on every request becomes immutable
   records plus a small index. dataplatform's "What is cheap" section has
   the numbers.
8. **No credential lives on the node.** Every secret arrives through the
   wrapper's `vaultKeys`. A login stored in a home directory (`~/.claude`,
   `~/.config/...`) breaks the contract: the standby does not have it, and
   failover breaks the feature without a sound.
9. **No undeclared node files.** Every executable the service runs is listed
   in `runtime.tools`. The planner executes each one on every candidate node,
   so a node that lacks one is refused before a move finds out.
10. **A loss bound you chose.** State what you could lose in a disaster (your
    RPO) and ask dataplatform for the backup cadence that meets it. The
    default is nightly.
11. **A one-shot import.** A dry run, then `--apply`, then a third run that
    reads `same` for every file. pygmalion's cutover section is the worked
    example.

## How to request it

Send fleet-manager a request with these five parts. File it in your repo, or
ask the operator to relay it. fleet-manager checks each answer against the
running service before the fence goes live.

1. **`hosting.json`**, with `availability.singleton`, `availability.fence:
"data-lease"`, `availability.standby` (how many standbys) and `placement.require: ["label:data-peer"]`. A node without
   that label cannot reach the store.
2. **A state inventory.** One row per path: its size, how it is written
   (append, whole rewrite, create once), whether it can be rebuilt, and who
   else writes it, including offline tools.
3. **The lease.** What prefix it covers, its TTL, and what the process does
   when it loses the lease.
4. **Proof from a rehearsal.** Run against the real listener code with a copy
   of your real data. Report the import (`same` for every file), a cold
   takeover, a warm takeover, a frozen primary past its TTL (its late write
   refused), and a rejoin (orphans, not deletions).
5. **What is left on the node.** Every credential, file or login the process
   still reads from the node it runs on. The list must be empty before the
   fence is accepted.

## What the fleet and the placement layer do in return

- **The fleet** brings a standby node to the same level as the primary:
  toolchain, `runtime.tools`, the `data-peer` label, and a tunnel whose
  ingress already carries the hostname
  (`scripts/lib/service-tunnels.mjs`). It moves the service off an
  unreachable node only when the request declares the fence.
- **hadoku_site** (placement and deploy) deploys the same commit with the
  same env to the primary and the standby, and runs both. The lease decides
  which one serves. It points the hostname at whichever node's `/health` is 200.
- **dataplatform** keeps the namespace, the lease and the backups.

## Who is on it

| service                        | level                                | notes                                                                                                                                     |
| ------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| hopper, ArchiveBot, watchparty | data in the store, no fence declared | media and records in their namespaces. None declares `fence` yet, so each is moved only off a reachable node.                             |
| pygmalion                      | off-node, built, not cut over        | `pygmalion/state/central.py`, rehearsed 2026-10-27. Item 8 is still open: extraction runs the `claude` CLI on a login stored on the node. |
