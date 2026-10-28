# `fleet reconcile`

Script: `scripts/reconcile-fleet-runners.mjs`, `scripts/lib/fleet-roster.mjs`.

Source: `hadoku_site/scripts/AGENTS.md`, two sections at commit `da0653c5`
(2026-10-05):

- `### reconcile-fleet-runners.mjs (2026-08-08)`, lines 342–504
- `### One roster: fleet-runner-coverage.json facets (2026-08-23)`, lines
  505–565

Moved here per #97 (both map to this one tool: the facets are written by
`fleet reconcile --write-coverage`). hadoku_site replaces both sections with a
pointer to this file. Usage details that are properties of the hadoku_site
checkout (`REPOS_DIR`, worktree caveats) stay there.

## Why this exists

Declarative self-hosted runner coverage. `manifests/fleet-runner-manifest.json`
(resolved through `FLEET_MANIFEST_DIR`, never a `__dirname` walk — see
`AGENTS.md`'s "Manifests are operator config" rule) describes **machines**;
which repo gets a runner **where** is **derived**. `fleet reconcile` converges
the fleet onto that plan. Read-only by default; `--confirm` applies it.

```
fleet reconcile                       # plan only, exit 1 on missing coverage
fleet reconcile --confirm             # register what is missing
fleet reconcile --repo WolffM/x --confirm
fleet reconcile --confirm --remove-orphans
fleet reconcile --write-coverage      # regenerate fleet-runner-coverage.json
fleet reconcile --json
```

## Two supervision models, never both on one directory

It writes a **user** unit
(`~/.config/systemd/user/actions-runner-<repo>.service`,
`ExecStart=…/run.sh`) — the model the retired `-b` pool proved on 2026-07-25 —
while `register-fleet-runner.sh` installs a **system** unit via `svc.sh` →
`runsvc.sh`. Two supervision models for one fleet exist because the user-unit
model was originally the _only_ unattended path: as `openclaw`, `sudo` over
`ssh claw-N` demanded a password. That rationale expired 2026-08-17, when
every runner install migrated to `hadoku`, which holds passwordless sudo on
every claw. The two tools now overlap, and both guard against double-
supervision: the reconciler **skips** a directory that already has a system
unit, and `register-fleet-runner.sh` removes a competing user unit before
installing. System wins — it's what the other ~22 runners on each claw use.

This guard exists because of a real incident: on 2026-08-18 both tools ran
within an hour for the same three repos on all three claws — nine
double-supervised runners. Two listeners racing for one GitHub session means
the loser burns 240s on `SessionConflictException` and exits 5, a job landing
in the overlap corrupts `_diag`/`_work/_temp` shared between two processes
(this happened to a `hadoku-study` run on 2026-08-20), and — worse — the
_surviving_ listener runs unsupervised while GitHub still reports it ONLINE,
so the offline alert can't see it. The nine sat that way for three days.

`register-fleet-runner.sh` now writes a `restart.conf` drop-in carrying
`RestartPreventExitStatus=5` (exit 5 is the session-conflict stop; restarting
into that is an endless conflict loop) — GitHub's stock `svc.sh` template sets
no `Restart=` at all, which is why runners stayed silently dead on 2026-08-06
and again on 2026-08-21.

`register-fleet-runner.sh` remains the tool for a `hadoku`-user registration
and is still the only way to **remove** one.

## Born provisioned since 2026-10-24 (fleet-manager#1)

A claw's new unit is **enabled, not started**. The reconciler then runs
`fleet slice --machine <claw> --confirm` and `fleet throttle --machine <claw>
--confirm --no-restart` for that node, starts the unit, and fails the
registration unless its `ControlGroup` is under the node's slice. A unit's
first start decides its cgroup, so the drop-in and the throttle `.env` must
both exist before it. On 2026-10-22 they did not: `enable --now` started
hadoku-fleet-manager's standing runners on claw-4/claw-6 in `app.slice` with
no hook, and they needed `slice --confirm --restart` two nights later. A unit
whose provisioning fails stays stopped and the run fails with the fix
commands. A guest still starts at registration, because both drivers refuse
it by role. `scripts/registration-provisioning.test.mjs` registers on a fake
node and runs the real `--check` of both afterwards, with nothing between.

## It holds 1,500 GitHub calls back (fleet-manager#9)

The 5,000/h core limit belongs to the GitHub user, so every token and the
host `gh` login spend one pool with runner-health, dispatch and minting. A
`--check-coverage` run costs ~440 of it. Before spending, `reconcile`,
`check-history-coverage` and `reconcile-runner-identity` read `/rate_limit`
(free) through `scripts/lib/gh-reserve.mjs`, and under 1,500 left they are
**not run** and fail with the reason and the reset time. That is "could not
look", not a pass. An unreadable `/rate_limit` does not refuse: the gate's
own first call fails and names the real fault. `FLEET_GH_RESERVE=<n>` sets
the floor for one run, and `0` turns it off.

**They spend a GitHub App's pool, not yours.** Before the reserve check each
of the three calls `useAppPool` (`scripts/lib/gh-app.mjs`). With
`FLEET_GH_APP_ID` and `FLEET_GH_APP_KEY` set (mgmt-api passes them from the
vault), it mints a one-hour installation token for the `hadoku-fleet-gates`
App and sets `GH_TOKEN`, so every `gh` the gate spawns, `/rate_limit`
included, is charged to the installation: 10,050/h, separate from the user's
5,000. Without the credentials, or when GitHub refuses the mint, the gate
runs on the user pool under the reserve as before and says so on stderr with
the reason. A `GH_TOKEN` already set is left alone.

Measured 2026-10-27: `--check-coverage`, `identity` and `history-coverage`
return the same results on the App token as on the user login. GitHub counts
an installation's calls in more than one bucket, as it does the user's (see
`gh-budget.ts`): `/rate_limit` read 18 used while a `hadoku-rally` listing in
the same second read 246. So `/rate_limit` is one bucket's view, on either
pool.

Who spent the pool is in mgmt-api's hourly `[gh-budget] window ended` line.
Beyond its own loops, it names each cron by what the pool rose while it ran
(`crons while running`, upper bounds that overlap; mgmt-api wraps each
dispatch in `meterGhPool`), and the busiest five-minute slices of spend that
was not mgmt-api's. If a blackout makes runs scroll out of a repo's listing
before job-history reads them, runner-health pages back to recover them once
the budget returns (`src/run-listing-gap.ts`). It says in the log when a gap
was too long to close, so a `check-history-coverage` failure afterwards
counts runs that were really lost.

## Machine-centric since 2026-08-23

The manifest used to be repo-centric: ten repo entries each carried a `claws`
whitelist, and all ten encoded ONE fact — "not claw-3" — in three
near-identical `$why` paragraphs. Nothing could enforce the "~2.8 runners per
core" rule those paragraphs cited (claw-3 reached 4.8/core and the watchdog
rebooted it at 92°C on 2026-08-17), and a new repo silently defaulted onto the
weakest box. Now:

```
machines: { claw-3: { cores, labels, maxRegistrations, tierCapacity,
                      excludeRepos: { "WolffM/x": "why" } } }

placement = machines
    .filter(not placement:"excluded")   // hokon is described, never placed
    .filter(repo not in excludeRepos)   // the machine declines, with a reason
    .filter(machine has repo's `needs`) // capability matching
```

`maxRegistrations` is a **gate**: over capacity the reconciler reports, exits
1, and **refuses to apply** — a gate that reports and proceeds is the
dead-guard shape (confirmed: `scripts/reconcile-fleet-runners.mjs:1854-1897,
2013`, "REFUSING to apply: the plan exceeds a node's maxRegistrations"). It
bounds disk/install footprint as a proxy for load; the real concurrency limit
is `maxConcurrent`/`minFreeMb` — see `docs/tools/throttle.md`.
(`tierCapacity` and `runner-tiers.json` were retired with the tier ladder in
`@wolffm/fleet-manager` 0.23.0 — confirmed: no reference to either remains in
`scripts/reconcile-fleet-runners.mjs`.)

**Auto-include needs CI, not just recency.** `pushedWithinDays` alone matches
far more repos than have any `.github/workflows` at all, and a runner install
costs ~835 MB per claw. `minWorkflows` is the entitlement signal. An explicit
manifest entry overrides in both directions.

**Asymmetric by design:** it will not revoke coverage because a repo aged out
of a recency window (only archived/deleted/`skip: true` yield removable
orphans — a quiet month must not delete a live repo's CI — confirmed at
`scripts/reconcile-fleet-runners.mjs:1016-1021`), will not reinstall an
offline runner (that's an incident, not drift), and will never touch a runner
not named for a managed node. It cannot remove a `hadoku`-owned registration
on a claw either (no sudo) — it prints the operator command instead.

**Three answers, not two:** `skip: true` means "should have no runners" and so
_makes_ orphans; `ignore: true` means "whatever it has, leave it, stop
reporting it" and collapses to one line (archived `hadoku-trader` is the live
example). Reach for `ignore` whenever the honest answer is "don't care" — a
report that is permanently non-empty is a report nobody reads.

## hokon is a guest, not excluded

hokon became a managed machine on 2026-08-24 — superseding, not ignoring, the
old "touch hokon, never" rule: a backstop with runners for 2 of 26 repos
cannot back anything up, which is exactly what happened when two jobs were
OOM-killed on claw-2 that day and the retry had nowhere to go but the box that
had just killed them. What made the old rule safe is now explicit: hokon
carries none of `hadoku-builder` in steady state (the backstop owns it, and
GitHub cannot schedule onto it until the backstop promotes it — placement
makes it _possible_, not used); `minFreeMb: 8192` protects mgmt-api, the
tunnel and the other production services; `maxConcurrent: 4` caps concurrency; orphan removal
only ever targets repos being _retired_, so nothing here removes a live hokon
runner; ssh to hokon _from_ hokon is refused, so the runner exec path runs
locally when the target machine is the current host.

**Changed since 2026-08-08/23 — `clawOfRunner` is now fully derived, not
hand-enumerated.** The source section describes it as having "learned hokon's
three hand-made names — `hokon` (pm2-host), `hokon-b|c|d` (surge, retired) and
`hokon-tenhands`." That hardcoding is **gone**. The current implementation
(`scripts/reconcile-fleet-runners.mjs:210-234`) derives ownership from the
declared node names in the manifest: a runner belongs to the node whose name
it exactly matches, or to the _longest_ declared node name it's prefixed by
(longest wins so a future `claw-1x` can't be captured by `claw-1`). The
function's own comment states why: the previous version hardcoded two
_incompatible_ patterns (`/^(claw-[123])(-b)?$/` and
`/^hokon(-b|-c|-d|-tenhands)?$/`), so every new instance or hand-made runner
name needed a code change, and the two forms had already drifted apart. This
also means the `-b` pool retirement narrative below is now purely historical —
nothing in the current matching logic depends on which runner names happen to
exist.

**The `-b` pool was retired on 2026-08-24** (historical, still accurate as
history). `claw-1-b`, `claw-2-b`, `claw-3-b` and `hokon-b|c|d` were six extra
runner instances, all on `hadoku_site` — the busiest repo — and carrying real
work (12 of its last 38 jobs). They went because `maxConcurrent` now caps each
machine independently (a second instance no longer adds machine capacity, only
more chances to win GitHub's arbitrary placement), hokon now carries a runner
for all 26 repos rather than just hadoku_site, and uniform `instances: N` was
never affordable (~43 GB per claw against claw-2's 110 GB disk). hadoku_site's
maximum parallelism dropped from 10 slots to 4 as the honest cost; "one runner
per (repo, machine)" became true without exception as the honest benefit,
which is what lets `clawOfRunner` derive ownership instead of enumerating
suffixes. The prefix match deliberately survives the retirement: re-introducing
an instance is a config change, not a code change.

**There is ONE runner type: `hadoku-builder`.** `hadoku-builder-heavy` was
retired 2026-08-19 — a RAM pin on claw-3 for Android builds, retired because a
single-machine label is a queue-forever hazard (the hokon backstop only fires
when _all_ claws are down), it pinned heavy work to the _weakest_ box by CPU
(92–96°C), the measured RAM spread (7.7/11/15 GB) was a 2x difference rather
than an order of magnitude, and nothing actually requested it anymore. If a job
genuinely needs a big box, express it as **coverage** (which claws serve that
repo), not a label — coverage degrades to "run on the other one," a label
degrades to "queue until cancelled." Confirmed: no reference to
`hadoku-builder-heavy` remains in `scripts/reconcile-fleet-runners.mjs`.

## One roster: `fleet-runner-coverage.json` facets

**Every fleet-wide checker derives its membership from one file**, written by
`fleet reconcile --write-coverage`. They used to each carry a hand-written
`const FLEET = [...]`, and those had already drifted (coverage.json 24 repos
derived vs. 15/14/9 hand-kept across the three checkers, disagreeing on seven
repos in both directions, nine covered repos inspected by neither).
`hadoku-filetransfer` is the worked example: it declares
`@wolffm/task-ui-components` in its own `packages/ui/package.json`, was never
added to the header list, and so every header rule skipped it — including
`no-update-flow`, which fired the moment the roster included it and revealed
the repo had no `update-wolffm.yml` at all.

**One flat list would be wrong**, which is why this is **facets** rather than
a single roster — brave-quartet is a Rust/Bevy crate and auditing it for a
React `AppHeader` is permanent noise:

| facet            | derived from                                                | consumer            |
| ---------------- | ----------------------------------------------------------- | ------------------- |
| `wolffmConsumer` | any `package.json` in the tree declaring `@wolffm/*`        | `not-in-fleet` rule |
| `uiApp`          | that set including `@wolffm/task-ui-components`             | check-header-fleet  |
| `microFrontend`  | mounted per `child-apps.json` + vite/src paths off the tree | check-mf-externals  |

`check-tier-fleet` takes the **whole** roster (`allRepos()`) rather than a
facet, because tier vocabulary can appear anywhere auth is enforced.

Confirmed unchanged in this worktree: the derivation logic lives in
`scripts/reconcile-fleet-runners.mjs` (facet computation, `--write-coverage`
flag, `--allow-shrink` guard) and `scripts/lib/fleet-roster.mjs` (`allRepos`,
`reposWith`, `namesWith` — the read side). The roster moved **into**
`@wolffm/fleet-manager` with the rest of the CLI in `38b31870`;
`fleet-roster.mjs` under `scripts/admin/lib/` in hadoku_site has not existed
since — confirmed, it now lives at `scripts/lib/fleet-roster.mjs` in this
repo. It excludes `hadoku_site` by default (`HOST_REPO`,
`scripts/lib/fleet-roster.mjs:46`): the host earns the facets but is audited
in-repo, and treating it as a sibling would make a checker look for a checkout
of itself under `REPOS_DIR`.

**Two traps this hit while being built, both still true:** enumerate layouts,
never guess them (a hardcoded `['', 'frontend/', 'apps/ui/']` probe missed
`packages/ui/` entirely); depth disambiguates an app from a package it builds
(shallowest `src/` wins, so a vendored library beside its consuming app isn't
mistaken for the app).

## Verified against this worktree (2026-10-07)

Checked `scripts/reconcile-fleet-runners.mjs` (2,244 lines) and
`scripts/lib/fleet-roster.mjs` against both source sections.

**9 claims verified unchanged**: the two-supervision-model guard and its
2026-08-18 incident, `maxRegistrations` as a gate, `tierCapacity`/
`runner-tiers.json` retirement, the asymmetric orphan rules, the
skip/ignore/explicit three-answer model, the hokon-as-guest model and its
`minFreeMb`/`maxConcurrent`, the `-b` pool retirement history,
`hadoku-builder-heavy` retirement, and the facets table + its two traps.
**1 claim changed**: `clawOfRunner` no longer hand-enumerates `hokon-b|c|d`/
`hokon-tenhands` — it derives ownership from the manifest's declared node
names via exact-or-longest-prefix match
(`scripts/reconcile-fleet-runners.mjs:210-234`), specifically because the old
hardcoded version had already drifted from reality once.
