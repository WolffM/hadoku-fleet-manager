# The control plane: one controller, one host

Written for #79 Lane 2/3, the day `FleetHost.controller` landed. It exists
because hadoku_site is designing active/passive pm2 hosting (operator,
2026-10-01) — more than one mgmt-api process able to run, with only one of
them actually driving the fleet at a time — and that design has to answer
three questions this package never had to answer before: what does "the
fleet" even mean when two processes could ask, which of this CLI's gates
answer a question about THIS BOX rather than the fleet, and which on-disk
state is safe to hand from one controller to the next versus state that only
ever made sense held by exactly one process.

Every claim below cites the file and line it was read from, in this
checkout, today. Re-read the line before trusting it — this doc itself warns
that line numbers drift.

## 1. The controller assumption this package has always made

Nothing in this package was written asking "which controller am I." It asks a
narrower, older question — **"is this node the box I am running on"** —
`isLocalNode(node, self)` in `src/lib/node-identity.ts:56-58`:

```ts
export function isLocalNode(node: string, self: string = hostname()): boolean {
  return shortNodeName(node) === shortNodeName(self);
}
```

Every place this package runs a command on a node branches on it. The sharpest
is `scripts/lib/fleet-exec.mjs:437-438` (`runOn`):

```js
const local = isLocalNode(node);
const [cmd, argv] = local
  ? ['bash', ['-s']]
  : ['ssh', sshArgv(node, connectTimeout)];
```

and the in-process path carries the identical branch — `src/runners/node-repair.ts`
(`doctorCommand`), with the comment that is the whole reason it exists: "mgmt-api
runs on hokon and `ssh hokon` from hokon is REFUSED." `self` defaults to
`os.hostname()` of the CALLING PROCESS, so this question is answered **once per
process**, from wherever that process happens to be running — never from a
config value, never from a notion of "the controller."

This is exactly the assumption active/passive hosting puts pressure on.
**Whichever box runs the controller IS "self," and every other node — hokon
included — becomes an `ssh` target from it.** Today mgmt-api always runs on
hokon, so `isLocalNode('hokon')` is always true there and every claw is always
the `ssh` branch. If the active controller ever runs somewhere other than
hokon (a passive replica promoted, or any future host), `isLocalNode('hokon')`
on THAT box is false, and hokon switches from the process's own shell to an
inbound `ssh hokon` from whichever box is now active.

**That inbound path is unverified.** Nothing in this package, and nothing
found in this pass, proves `ssh` reaches hokon FROM another controller host —
only that hokon refuses `ssh` to itself, and that every claw accepts `ssh`
from hokon today. This is the operator's open item (#65) and stays open here:
a controller switch answers "should this process start the loops," not "can
this process reach hokon by ssh." Treat it as unproven until it is measured
from the actual second host, the same way #17 (AGENTS.md) was only settled by
diffing a working node against a broken one, not by reading source.

## 2. `HADOKU_STATE_DIR`, and which of its files are single-controller state

`src/lib/fleet-paths.ts:227-229`:

```ts
export function stateDir(): string {
  return process.env.HADOKU_STATE_DIR || join(homedir(), '.hadoku-mgmt');
}
```

In-process the host injects the same value (`host.ts` — `FleetHost.stateDir`,
read via the `stateDir()` accessor at `src/host.ts:275`); a standalone CLI
subcommand reads the same environment variable directly. Every file this
package persists lives under it:

| file                            | written by                                                                          | what it is                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `job-history.jsonl`             | `src/job-history.ts:286,480` (`appendFileSync`)                                     | the append-only job ledger every placement decision reads  |
| `probe-ledger.json`-shaped file | `src/job-history.ts:356` (`PROBE_LEDGER_FILE`)                                      | per-node probe history                                     |
| `benchmark.json`, `health.json` | `src/lib/measured.ts:22`                                                            | the `$benchmark` / `$health` measured facets (Wave 3h)     |
| the stuck-run announcement book | `src/runners/dispatch-tick.ts:174,245-252` (`stuckStorePath`, `persistWarnedStuck`) | which (repo, job) zombies have already been announced once |

None of these is readable-by-many, writable-by-one in any enforced sense —
there is no lock file and no lease on any of them. **They are safe to hand
from one controller to the next (a failover reads what the previous
controller left) but are NOT safe for two controllers to write at once.**
`persistWarnedStuck`'s own doc comment says why for its file — "temp-and-
rename, so a torn write cannot leave a half-object behind" guards against a
crash mid-write, not against two writers racing the same rename. Two
controllers ticking the fast loop would mean two processes periodically
replacing the same file with two different beliefs about what has already
been announced.

**The state that matters more, and is NOT on disk at all, is the in-process
singleton state `createFleetManager`'s own doc comment already names** —
`src/index.ts:76-78`: `started`, `tickCount`, `sickNodes`, `offlineTicks`,
`labelZeroTicks`, `lastAlertAt`, `hostedRepos`, `failoverReran`,
`converged`, plus (not named there but the same shape) the backstop's own
module state in `src/runner-health.ts`:

- `backstopFleetState: boolean | null` (`src/runner-health.ts:160`) — whether
  hokon's backstop label is currently believed to be ON across the fleet
- `backstopConvergedMs` (`:194`), `backstopAlerted` (`:205`),
  `backstopCalmTicks` (`:229`), `backstopLastReason` (`:242`) — the
  hysteresis state the backstop decision (`src/runners/backstop.ts:1-15`,
  deliberately PURE) is driven by

and `src/runners/backstop-hold.ts:1-26` (`held`, `setBackstopHold` /
`isBackstopHeld`), whose own doc comment states the property directly:
"Deliberately NOT persisted. It is a statement about what this process did a
few seconds ago." **This is why two controllers running the fast loop is not
redundancy — it is two independent, unsynchronized beliefs about whether
hokon's backstop label is on**, each capable of writing that label to all 26+
repos (`src/runner-health.ts:254-284`, `syncBackstopAcrossFleet` — the fan-out
this file's own doc comment says exists because a full claw outage once left
25 of 26 repos' hokon runners unlabelled). A restarted single controller
starting with this state blank is fine — "Empty after a restart, so the first
tick is a full reconcile" (`src/fleet-loop.ts`, on `believedLabel`).
Two controllers holding two blank-or-diverged copies AT THE SAME TIME is the
double-dispatch, double-label-write failure mode #79 exists to prevent.

## 3. The switch: `FleetHost.controller`

`src/host.ts` (`FleetHost.controller?: boolean`) and `src/index.ts`
(`FleetManager.start()`). Omitted or `true` — today's behaviour, unconditionally,
for the one existing consumer (hadoku_site `services/mgmt-api/src/fleet.ts:35-47`,
which sets no such field and is correspondingly unaffected). `false` makes the
host PASSIVE:

- `start()` calls neither `startRunnerHealthMonitor()` nor `startFastLoop()` —
  gated at the call site in `index.ts`, not inside `fleet-loop.ts` or
  `runner-health.ts`, which stay unaware the concept exists and keep their own
  already-singleton `started` guards exactly as they are.
- One log line is written saying so (`[fleet-manager] controller=false —
passive host, no loop started`).
- `router` is unaffected — it was never gated on controller state, so
  `GET /fleet` is served either way.
- `snapshot()` returns `null` on a passive host, **always** — not "the last
  known state." A passive host's `runner-health` monitor never started, so no
  tick ever ran and nothing was ever recorded; there is no prior state to
  return. See `FleetManager.snapshot`'s own doc comment in `index.ts` for the
  same statement at the point a consumer would read it.
- `createFleetManager` is still the singleton AGENTS.md requires — it still
  throws on a second call, whether or not the host that wins the race is
  active or passive. The switch decides what an already-constructed manager's
  `start()` DOES, not whether a second manager can exist.

Proven in `src/tests/controller-switch.test.ts`: `controller: false` starts
neither real loop (checked by log line, not by waiting on a timer — see that
file's own header comment for why `runner-health.ts`'s interval is not
`.unref()`'d and must never actually be given a token in this test);
`controller` omitted, and `controller: true` explicitly, both start both.
Reverting either branch of the switch fails its test.

## 4. The host-bound gates

`scripts/lib/json-contract.mjs` — every `JSON_CONTRACT` entry now carries
`hostBound: true | false`. `true` means the subcommand reads something that
belongs to THIS box specifically, not the fleet:

| sub             | reads                                            | evidence                                     |
| --------------- | ------------------------------------------------ | -------------------------------------------- |
| `egress-slices` | this host's `pm2 jlist` and `/proc/<pid>/cgroup` | `scripts/check-egress-slices.mjs:39-40`      |
| `reap-trend`    | this host's own mgmt-api pm2 log file            | `scripts/check-reap-timeout-trend.mjs:46-48` |
| `srv-drift`     | the `~/srv/hadoku_site` checkout ON this box     | `scripts/check-srv-drift.mjs:8`              |

There were eight. `header-audit`, `identity-model`, `inventory`,
`check-runner-var` and `check-site-token` read the operator's sibling
checkouts under `REPOS_DIR`, which only hokon holds. Since fleet-manager#7
they read each repo's default branch through `scripts/lib/fleet-source.mjs`
(the `@wolffm/fleet-manager/fleet-source` export), a blobless mirror the
reader fetches itself, so any host gives the same answer and they carry
`hostBound: false`. `REPOS_DIR` is now read only under an explicit
`--worktree` flag.

The other entries read the fleet — GitHub's API, the manifest, or a node
reached by the `isLocalNode`-or-`ssh` branch from §1 — and give the same
answer regardless of which box asks, so they carry `hostBound: false`.

**Why this matters for active/passive hosting specifically:** a host-bound
subcommand run from a PASSIVE box's cron would answer a question about the
passive box, not about the box the fleet actually depends on (`~/srv`'s drift,
this process's own pm2 log). Splitting
cron jobs across active/passive hosts is therefore not a question of which
host is "the controller" at all — every `hostBound: true` job must keep
running from wherever its own inputs physically live, independent of which
box is currently driving the fleet's loops.

`scripts/lib/json-contract.test.mjs` requires every entry to declare
`hostBound` as a literal boolean (present on a hypothetical new entry too,
not just the current ones) and separately pins the three above by name, so
flipping any one of them — or quietly dropping the field from a new entry —
fails the gate rather than drifting unnoticed the way the `--json` consumer
count itself did twice before (`scripts/lib/json-contract.mjs`'s own header
comment).

## 5. Per-node state: `~/.hadoku/jit/*`, `standing.env`

None of this is controller-local, and none of it is read or written by the
process running the loops — it lives and is resolved entirely ON the target
node, which is exactly why a controller switch does not need to touch it.

- **Minting.** `mintEphemeralRunner` (`src/runners/ephemeral-exec.ts`) sends
  `jit-provision.sh`, with `runner-payload.sh` ahead of it, inside the command
  itself (`src/runners/node-script.ts`), via the injected `sh: ShellLike`,
  whose real implementation is the same `isLocalNode`-or-`ssh` branch as §1.
  No copy of the script lives on the node. `$HOME` is expanded by the shell ON
  THE TARGET — local via `bash -c`, remote via `ssh node …` — so the slot
  directories (`src/runners/ephemeral.ts:137`:
  `` `${home}/.hadoku/jit/slot${index}` ``) resolve against the TARGET node's
  home directory, never the controller's. `scripts/jit-provision.sh`
  confirms the same thing from the other side: `ROOT="$HOME/.hadoku/jit"`,
  evaluated once the script is already running on the node.
- **The standing runner's environment.** `~/.hadoku/standing.env`
  (`scripts/deploy-ci-throttle.mjs:10`, `scripts/lib/standing-runner-env.sh:52`)
  is rendered and deployed onto each node by that node's own deploy pass — not
  read or written by the fast loop or runner-health, and not a function of
  which box is currently the controller.

A controller failover therefore changes nothing about a node's JIT payload,
slot layout or standing environment — those are facts about the NODE, written
the same way regardless of which process last told it to mint.

## 6. The backstop is minted, not standing (#120, 2026-10-19)

Until 2026-10-19 hokon carried a standing registration on roughly 28 repos,
and promotion was a label flip: `syncBackstopAcrossFleet` wrote
`hadoku-builder` onto all of them, and demotion stripped it. The listeners ran
around the clock either way — about 2.8 GB of RSS and swap on the production
host. Operator, 2026-10-19: "the runners get brought online the same way the
JIT process does. not having standing runners squatting on ram."

So hokon is an **on-demand guest** (`"mint": "on-demand"` in the manifest):

- **Promotion is a mint.** `src/runners/backstop.ts` still decides, purely,
  whether the backstop is wanted (outage, or saturation while hokon is idle).
  The decision reaches the dispatcher through the hold
  (`runners/backstop-hold.ts`), and `offerFor` offers `hadoku-builder` on
  hokon's mints only while it is held. hokon is placed after every claw.
- **Its own work is always minted for.** `taskauto` and `av1-nvenc` exist
  nowhere else, so a job asking for them mints on hokon whether or not the
  backstop holds it.
- **Overflow never takes its last slot (fleet-manager#15).** A job that some
  healthy, undrained claw offers the labels for is overflow on hokon. It may
  hold every slot but one, and must leave one more job reserve
  (`requiredMb`) above the memory floor (`GUEST_SOLE_CARRIER_SLOTS` in
  `runners/placement.ts`). On 2026-10-27 three Forge e2e units filled hokon
  for 40 minutes while an `av1-nvenc` job waited 24 of them.
- **Demotion leaves nothing listening.** A JIT unit serves one job and exits,
  in `ci-runner.slice`, capped at the guest's own `slice.unitMaxMb`.
- **The red light is `fleet drain hokon`.** A drained node is never held
  (outage included) and never placed. The `backstop: "outage-only"` manifest
  mode is gone: hokon's live entry never carried it, so the block it was
  meant to impose was never in force.
- **Saturation asks the host; a backlog does not.** Past 100 s of queue the
  backstop promotes hokon only while it is quiet (load ≤ 4.0/core, ≥ 12 GB
  available). Past 300 s — the same floor at which `ci:queue-health` declares
  the fleet not serving work, held equal by a test — the load clause is
  waived and only memory is required (`hostMayTakeSaturation`, 2026-10-21:
  "hokon MUST come in when the queue shows up"). An outage never asks.
- **The green light is `fleet backstop --force hokon [--for 60m]`**
  (`runners/backstop-force.ts`, 2026-10-21). A time-boxed record in the state
  dir, read on every runner-health tick: the node is held eligible whether or
  not saturation wants it and whether or not the box reads idle. It never
  beats a drain, a quarantine or the pm2-host rung, and the dispatcher's
  admission (memory, the `/tmp` floor, `maxConcurrent`) still applies.
  `fleet backstop --status` prints the switch, this box's load, memory and
  `/tmp` against the thresholds, and the controller's last verdict — the
  first thing to type when the queue is full and hokon is not helping. The
  panel reads it as `fleet.backstopForced` on `GET /fleet`.
- **One registration stays standing**: hadoku_site's, listed in
  `standingRepos`. It is the `pm2-host` deploy runner, and the minter runs
  inside mgmt-api, which hadoku_site deploys — a deploy that broke the minter
  must not need the minter to deploy its fix. The backstop never labels it.

The reconciler narrows hokon to `standingRepos` the same way it narrows an
ephemeral claw to `residentRepos`, so the other registrations surface as
`excluded` pairs and are removed by `fleet reconcile --confirm
--remove-excluded` (idle ones only). A cleanup pass that sees hokon with one
registration is looking at the design, not drift.

## 7. Placement constraints before a pm2 app lands on a claw

The first pilot is hadoku-pygmalion (#105). These are the facts that decide
which apps can move and where, recorded here (#79) so the pilot does not
rediscover them one outage at a time. Re-check each before relying on it.

- **cardtable's match servers are not yet claw-safe.** Its listener binding
  has to change in cardtable first; until it does, cardtable stays on hokon.
- **AV1 NVENC exists only on hokon** (`$why-av1-nvenc` in the manifest). That
  pins dataplatform's clip rendering, the nightly encode and CI `pytest (gpu)`.
  watchparty's default ingest needs h264 NVENC, which claw-8 (RTX 2060 SUPER)
  and claw-9 (GTX 980 Ti) both offer. claw-8 is back in service since its
  cooler was fixed.
- **`/tmp` is tmpfs on the claws**, sized at about half of RAM, and JIT jobs
  share it. An app that stages large files must use a disk-backed path, and
  so must anything that ignores `TMPDIR`: the JVM reads `java.io.tmpdir`, which
  is why Forge's `liblz4-java-*.so` extracts piled up in `/tmp` (#100).
- **`taskauto` lives only on hokon** and is the backstop pool's one non-CI
  duty. Moving it needs gh, claude, a site-token npmrc, a `systemd --user`
  scope and the `~/.taskauto/repos` cache on the target.
- **Docker is not a claw capability.** It has zero CI demand, so it is not
  registered (`src/capabilities.ts`). games-host, cardtable's stream
  containers, privatebin and filetransfer's gokapi all need it, so none of
  them can move until a claw earns Docker through bootcamp.
- **No claw has a stable name** (#65). ssh pins each claw to a LAN IP, so a
  DHCP lease change strands it. That is tolerable for a CI claw and not for
  one hosting a service.
