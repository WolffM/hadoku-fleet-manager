# hadoku-fleet-manager

Fleet manager for the hadoku CI fleet. Published as `@wolffm/fleet-manager` and
consumed **in-process by mgmt-api** — this repo ships a library and one CLI, not
a service.

> **Live since 2026-08-30.** mgmt-api runs it in production, and the CLI runs
> every fleet gate. The package publishes to GitHub Packages on every version
> bump; there is no `private` field to drop. Migration record:
> `docs/planning/fleet-manager-extraction-2026-08-29.md`.
>
> Paths under `docs/planning/`, here and in code comments, are the maintainer's
> design notes. They are kept private and are not part of this repository.

## What it owns

|                  |                                                                                                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runner fleet** | liveness, priority tiering, JIT provisioning, supervision, hosted fallback, throttle + cgroup slice, capability and toolchain probes                                                                                                                       |
| **Repo fleet**   | the auditors that walk every checkout in `fleet-runner-coverage.json` — header contracts, identity model, tier vocabulary, MF externals                                                                                                                    |
| **Manifests**    | `manifests/` — machine topology, resolved runner coverage                                                                                                                                                                                                  |
| **Derived docs** | the fenced GENERATED regions this package writes into `hadoku_site` — the CI alert watch list (`fleet ci-watch`) and the workflow → runner blast-radius table (`fleet inventory`). Each takes `--write` and `--check`, and `--check` is the staleness gate |

It does **not** own general cron dispatch, repo branch-protection policy, or
anything single-repo. Those stay in `hadoku_site`.

## Running it

**Today, production runs it in-process inside mgmt-api** (next section). The
standalone service below is built and tested but not yet deployed; moving to
it is in progress.

As its own service — `node dist/serve.js`, PM2 name `fleet-manager`, bound to
`127.0.0.1` (nothing here is reachable from the edge) — it serves:

| route                        | for                                                              |
| ---------------------------- | ---------------------------------------------------------------- |
| `GET /health`                | liveness + version                                               |
| `GET /api/fleet`             | the Fleet report the command station renders                     |
| `GET /api/runner-health`     | the runner-health snapshot                                       |
| `POST /api/host-lease`       | `{holder, ttlSeconds}` — "the host is busy with this until then" |
| `DELETE /api/host-lease/:id` | release early; every lease also expires on its own               |

A **host lease** is how the host's scheduler tells the fleet that the production
host is doing work GitHub cannot see (see `src/host-lease.ts`). The fleet decides
what that means for routing; it reads nothing of the host's schedule.

Configuration is environment only — this is a published library, so it bakes in
no hostname:

| variable                                   | what                                                   |
| ------------------------------------------ | ------------------------------------------------------ |
| `FLEET_GITHUB_TOKEN`                       | runner-admin token for labels, listings, variables     |
| `FLEET_SERVICE_KEY`, `MONITORING_API_BASE` | job records, telemetry, unsent alerts                  |
| `DISCORD_EMERGENCY_NOTIFICATIONS_WEBHOOK`  | alerts                                                 |
| `FLEET_MANIFEST_DIR`, `HADOKU_STATE_DIR`   | the same resolvers the CLI uses (`lib/fleet-paths.ts`) |
| `FLEET_PORT` (4010), `FLEET_LOOPS`         | `FLEET_LOOPS=off` serves the API without the monitors  |

`FLEET_LOOPS=off` exists for a cutover only: the loops WRITE runner labels, and
two copies running at once would be two writers on one label.

## Consuming it in-process (production today)

mgmt-api builds a `FleetHost` and runs this package inside its own process.
This is the live path; it is being retired in favour of the standalone service
(`docs/planning/leave-hadoku-site-2026-09-21.md`). `serve.ts` is the
reference host — `standaloneHost()` in `src/standalone.ts`.

```ts
import { createFleetManager } from '@wolffm/fleet-manager';

const fleet = createFleetManager({
  // Four output ports.
  logger, // { info, warn, error }
  alerts: { post: postDiscord, recordQuietly: recordAlertQuietly },
  jobs: { recordJobResult },
  githubToken: () => (process.env.FLEET_GITHUB_TOKEN ?? '').trim() || undefined,

  // Three paths. NOT optional, and not derivable here — see below.
  manifestDir,
  stateDir,
  storeDoctorPath,
});
app.use('/api', fleet.router);
fleet.start();
```

**The paths are the load-bearing half.** Every loader behind them fails SOFT: a
manifest that resolves to nothing yields an empty fleet, and an empty fleet is
deliberately read as "unknown, fall back to the label reading". Measured before
the move — `clawsOnline` 2 with the manifest, 1 without — and `clawsOnline` is
what decides whether an outage is declared and the production host promoted as a
builder. So `requirePaths()` in `src/host.ts` **stats `manifestDir`, the manifests
inside it and `storeDoctorPath` at construction and throws naming every one it
could not find**; `stateDir` need not pre-exist but must be set. Loud at boot
beats silent forever. (`cronProfilesPath` is optional and deprecated: host leases
replace it.)

`createFleetManager` **throws on a second call**: the modules hold ~16 mutable
singletons and two instances would silently share every one of them.

The router serves `GET /fleet`. Its payload types are re-exported wholesale from
`fleet-report-types.ts` — the command station imports them rather than keeping a
second copy of the shape.

## The CLI

One door, subcommands — the same convention `administration.py` follows in
`hadoku_site`. **`fleet --help` prints the current list**; it is generated from
the `COMMANDS` table in `src/cli.ts`, which is the only place subcommands are
declared. A hand-copied list here would go stale, and did.

Each subcommand SPAWNS its script rather than importing it, so exit codes and
stdio pass through untouched.

### Install the CLI

The package's `bin` is only on PATH inside a `node_modules/.bin`. So on the
controller, `fleet` is a wrapper in `~/.local/bin` (already on PATH). It
points at the copy production runs: mgmt-api's installed package, which every
deploy keeps current. It does not point at a dev checkout, whose `dist/` goes
stale after a pull.

```sh
cat > ~/.local/bin/fleet <<'EOF'
#!/bin/sh
: "${REPOS_DIR:=$HOME/repos}"
export REPOS_DIR
cli="$HOME/srv/hadoku_site/services/mgmt-api/node_modules/@wolffm/fleet-manager/dist/cli.js"
i=0
while [ ! -f "$cli" ] && [ "$i" -lt 60 ]; do sleep 2; i=$((i + 2)); done
[ -f "$cli" ] || { echo "fleet: $cli is missing (a deploy did not finish?)" >&2; exit 127; }
exec node "$cli" "$@"
EOF
chmod 0755 ~/.local/bin/fleet
```

A deploy replaces `node_modules`, so the CLI is briefly absent; the wrapper
waits up to a minute for it rather than failing (2026-10-28: an install on
claw-6 failed in exactly that window). `REPOS_DIR` is defaulted, not forced, the way the cron jobs set it. So the
wrapper resolves the canonical checkouts from any directory, and
`HADOKU_SITE_ROOT`, or a hadoku_site worktree you are standing in, still wins.
The provenance line below says which install answered. To try an unpublished
change, run the checkout directly: `node dist/cli.js …`, after `pnpm build`.

### Provenance — which tree, and which install, answered

Every subcommand writes one line to **stderr** before it runs anything:

```
site=/home/hadoku/srv/hadoku_site manifests=/home/hadoku/srv/hadoku_site/scripts/admin fleet-manager=0.22.24
```

The same code can live in four trees that update on four different schedules
(`docs/planning/deployed-not-published-2026-09-05.md`), and three of them are
invisible from an operator's checkout. Six fixes between 2026-09-02 and
2026-09-05 were correct, committed and inert because the thing running was not
the thing changed; twice, an operator reproduced a cron finding from `~/repos`
while the cron runs from `~/srv/hadoku_site` and watched a different rule fire.
Nothing about resolution changed — what was missing was any output saying which
answer got used.

The version is read from the `package.json` beside the running module, never
from a manifest: that is the one fact that tells two installs apart. A path that
does not resolve is printed as `<unresolved: …>` with the path it tried — the
banner never throws, because a command that needs a manifest will fail loudly
for itself and `fleet onboard` needs none.

**stderr, always, not "suppressed under `--json`".** Both satisfy the contract
below; only stderr cannot regress, because it makes this CLI's stdout byte-for-
byte the child's stdout for every subcommand and every flag. `FLEET_NO_BANNER=1`
silences it.

`fleet throttle --check` answers the other half — whether the node-side scripts
on each claw are the ones this package ships — by sha256 of `ci-throttle.sh`,
`job-metrics.sh` and the memory harvester against `~/.hadoku/`. The minters
(`jit-provision.sh`, `warm-provision.sh`) are not kept on nodes at all: each
mint sends them, with `runner-payload.sh`, in the command that runs them
([`src/runners/node-script.ts`](src/runners/node-script.ts)). A hash, not a version marker written into the file: a marker says
what the last editor believed, and `job-metrics.sh` has two editors.
[`scripts/lib/script-provenance.mjs`](scripts/lib/script-provenance.mjs) declares
which files are covered, and the test beside it fails the build if the payload
grows a file that is neither hashed nor written down as unhashable.

### The `--json` contract

mgmt-api cron jobs run this CLI and parse its **stdout as JSON, before looking
at the exit code** — these gates exit non-zero ON FINDINGS, so reading the exit
code first would turn every real finding into "the checker broke".

| command                                     | cron job                |
| ------------------------------------------- | ----------------------- |
| `fleet drain-check --json`                  | `ci:drain-enforced`     |
| `fleet benchmark --due 30 --cadence --json` | `ci:fleet-benchmark`    |
| `fleet reconcile --json`                    | `ci:fleet-coverage`     |
| `fleet toolchain --json`                    | `ci:fleet-toolchain`    |
| `fleet converge-toolchain --refresh --json` | `ci:toolchain-refresh`  |
| `fleet header-audit --json`                 | `ci:header-fleet`       |
| `fleet identity-model --fleet --json`       | `ci:identity-model`     |
| `fleet cleanup --json --confirm`            | `ci:claw-cleanup`       |
| `fleet check-runner-var --json`             | `ci:runner-var`         |
| `fleet check-site-token --json`             | `ci:site-token`         |
| `fleet egress-slices --json`                | `ci:egress-slices`      |
| `fleet queue-health --json`                 | `ci:queue-health`       |
| `fleet reap-trend --json`                   | `ci:reap-timeout-trend` |
| `fleet preflight --json`                    | `ci:fleet-preflight`    |
| `fleet srv-drift --json`                    | `ci:srv-drift`          |
| `fleet inventory --check --json`            | `ci:fleet-inventory`    |
| `fleet doctor --cadence --write --json`     | `ci:health-refresh`     |
| `fleet health-freshness --json`             | `ci:health-freshness`   |

That table listed SIX of these ten until 2026-09-07 — `drain-check`,
`benchmark`, `egress-slices` and `queue-health` were under contract and
undocumented here — which is the third time a hand-kept copy of this list has
been wrong. It is now GATED: `json-contract.test.mjs` parses this table out of
this file and fails the build if it does not match `JSON_CONTRACT` exactly, in
both directions. Do not edit it by hand without editing the declaration; the
declaration is the source and this table is a rendering of it.

That table is DECLARED in [`scripts/lib/json-contract.mjs`](scripts/lib/json-contract.mjs),
with the consuming file for each, and gated by the test beside it: renaming one
of these subcommands, or dropping its `--json` handling, fails `pnpm run check`
here rather than a cron in hadoku_site at 03:00. Renaming one is a cross-repo
change — the failure message names the mgmt-api file to fix in the same pass.

`ci:audit-gates` runs thirteen more fleet subcommands, but reads their output as
prose against an `evidence` regex rather than as JSON, so those are deliberately
not in the table above. It is declared separately, as `PROSE_CONTRACT` in the
same file, because reading output as prose has its own failure mode: that job
merges **stdout and stderr** into one value and judges every gate by a regex over
it, so anything this CLI's WRAPPER writes becomes part of thirteen verdicts.

That is not hypothetical — it is what the provenance banner did on 2026-09-07. It
made `spawnError` ("it never started") unreachable for all thirteen, and its
operator-controlled paths could satisfy a gate's `evidence` on their own: with the
site root under `~/repos`, the substring `repos` matched `check:ci-watch`, so a
gate that exited 0 having printed nothing reported a pass. `audit-gates.ts` now
runs its gates with `FLEET_NO_BANNER=1` and reports provenance once for the job;
`fleet contract-consumers` fails if it stops.

### The invocation log — which doors anybody opens

Every invocation through the door appends one line to
`<state dir>/fleet-usage/usage-YYYY-MM.jsonl` (`~/.hadoku-mgmt` unless
`HADOKU_STATE_DIR` says otherwise): subcommand, flag NAMES (never values),
exit code, duration, host, version, and caller hints (tty, process ancestry,
the PM2 app, `FLEET_CALLER` when a caller names itself, agent, ssh, Actions).
The router's routes are counted into the same files, bucketed per five
minutes. `fleet usage [--since 120d] [--json]` reads it back and lists every
subcommand and route with zero runs — candidates for deletion, not verdicts:
it sees this host only, and only what came through the door.

It never writes stdout and never changes an exit code. A failed write says so
once on stderr (not under `FLEET_NO_BANNER=1`). `FLEET_USAGE_DIR=<dir>` moves
it, `FLEET_USAGE_DIR=off` stops it, and under a test runner it is off unless a
directory is named. At least 180 days are kept, under a 128 MB cap.

### Machine scoping

Every machine-scoped subcommand takes **`--machine <name>`**, never a positional.
A bare positional is now REFUSED — `fleet provision claw-3` exits 1 naming the
argument and suggesting the flag.

It used to be silently ignored, and that was worse than it sounds. `machineArg()`
found no `--machine`, `selectMachines` was handed `only: null`, and the run
covered the whole fleet; with `--confirm` it applied to every declared machine
including the production host. Measured 2026-08-30:

```
["claw-3","--confirm"]              -> only=null     claw-1, claw-2, claw-3, hokon
["--machine","claw-3","--confirm"]  -> only=claw-3   claw-3
["claw-4","--confirm"]              -> only=null     claw-1, claw-2, claw-3, hokon
```

The third line is the one an operator onboarding a node types, and it is the
worst: `claw-4` is not in the manifest, so `provision-fleet.mjs`'s "a machine is
provisioned BECAUSE it is declared, add it to the manifest first" guard — the
one written for exactly that moment — never fired, because the other four
machines matched.

A positional is refused rather than read as an implied `--machine`: inferring it
would make the safe spelling and the dangerous one differ only in what the parser
guessed. `--machine` with no value, or with a flag as its value, is refused for
the same reason. `scripts/lib/fleet-exec.test.mjs` pins all of it, and pins that
no subcommand has grown a private `--machine` parser again.

## Development

```bash
pnpm install
pnpm run check      # format:check + lint + typecheck + build + check:exports + test
pnpm run lint:types # type-aware ESLint — NOT covered by `pnpm lint`
```

`pnpm lint` runs cheap syntactic rules only. Run `lint:types` before pushing any
async change. Read `pnpm run check`'s EXIT CODE — do not grep its output. 0.11.0
published with red CI because the output was filtered for test and TS errors and
prettier's two `[warn]` lines went straight past. `cmd | tail` reports `tail`'s
exit code, not `cmd`'s.

## The one rule that is not negotiable

> **The reader for a facet may not read what the writer wrote.**
> Cgroup limits from `/sys/fs/cgroup/$(ControlGroup)/memory.max`, never
> `systemctl show`. Listeners from the process tree, never a `.env` file.
> Registrations from the GitHub API, never a local record. Capabilities by
> _executing_ the capability.

A verifier that reads the artifact its own writer produced cannot fail.
`check:slice` was green while 11 of 97 units held the wrong kernel ceiling and 26
held none. Three independent-looking confirmations, one source, zero contact with
reality.

The corollary is just as load-bearing: **the idempotency check must read observed
state too.** With it still reading config, a fleet-wide apply returned
`changed=0` and fixed nothing.
