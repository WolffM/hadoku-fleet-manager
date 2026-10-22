# hadoku-fleet-manager

Library + CLI that manages the hadoku CI fleet. Published as
`@wolffm/fleet-manager`, consumed **in-process by mgmt-api**. Not a service, no
port, no PM2 entry.

**This repo is PUBLIC. `WolffM/hadoku-fleet-manager-private` holds the rest.**
It was cut from one squashed commit on 2026-10-20. The private repo
(checkout `~/repos/hadoku-fleet-manager-private`) keeps three things:

- **`docs/planning/`**, at the SAME relative path. `bash scripts/attach-private.sh`
  symlinks it into this checkout, so every `docs/planning/…` path cited here
  and in code comments resolves. Run it once per clone and per worktree. If
  the directory is missing, run that script; nothing was deleted.
- **The issue tracker up to the cut.** A bare `#N` in a comment or doc means
  that tracker's issue N, not this repo's. Cite issues filed here as
  `fleet-manager#N`.
- **The 762 commits before the cut.** The same script grafts them under this
  repo's root, locally, so `git log` and `git blame` reach them.

**Where a thing goes:** code, tests, manifests and anything a stranger may
read go here. Incident write-ups, network or security detail, plans, handoffs
and issues about any of those go to the private repo. Write planning docs
through the symlink and commit them THERE. `publish-safety-guard.test.mjs`
fails the build if anything under `docs/planning` is tracked here, or if any
tracked file carries a private address, MAC, tailnet name or a
`.publish-denylist` entry. That list is gitignored here and mirrored in the
`PUBLISH_DENYLIST` secret. Keep the two in sync.

**Live since 2026-08-30.** mgmt-api consumes it in production and the CLI runs
every fleet gate. Migration record:
`docs/planning/fleet-manager-extraction-2026-08-29.md` — read §3 (the client
contract) before adding any export, and §8 (traps) before touching the fleet.

**The four trees a change can live in — and why "published" is not
"deployed" — are in `docs/planning/deployed-not-published-2026-09-05.md`.**
Six fixes were correct, committed and inert because the thing running was
not the thing changed. Read it before concluding a fix did not work.

**Start at `docs/planning/handoff-2026-09-02.md`** if you are picking this up
cold — the all-JIT conversion and the five latent assumptions it billed at
once. `docs/planning/handoff-2026-08-30.md` is still the record for
everything before it. It is the shipping loop and its five failure points, the three separate
times a COMMENT has been read as evidence in this codebase, the invariants added
the day the extraction was verified, two ways mutation testing gave a false pass,
and what is actually still open.

**Vocabulary is settled in `docs/VOCABULARY.md`.** A **node** is a box; a
**claw** is a node whose only job is CI (a subset, not a synonym); a **runner**
is one `(node, repo)` registration. Never write bare `host` — it means three
different things. Read it before naming anything new.

## Critical rules

- **One question, one answer: `isLocalNode()`.** "Is this node the box I am
  running on?" is asked in `src/lib/node-identity.ts` and nowhere else. hokon
  refuses ssh to itself, so the false answer reads a node as permanently
  unreachable and the true answer runs another node's script here. It had FIVE
  implementations until 2026-08-30 and only one survived an FQDN;
  `scripts/lib/node-identity-guard.test.mjs` fails the build if a sixth appears.
- **The reader for a facet may not read what the writer wrote.** Cgroup limits
  from `/sys/fs/cgroup/$(ControlGroup)/memory.max`, never `systemctl show`.
  Listeners from the process tree, never a `.env`. Registrations from the GitHub
  API, never a local record. Capabilities by EXECUTING the capability. A verifier
  that reads its own writer's artifact cannot fail — that is how `check:slice`
  stayed green while 11 of 97 units held the wrong kernel ceiling. **The
  idempotency check must read observed state too**, or a gate and a repair share
  a blind spot and fail together.
- **"I could not look" must never render as "nothing is wrong."** An unreachable
  machine, a missing checkout, an unreadable runner listing, zero repos scanned —
  each of these FAILS. Exit 0 with no evidence is a failure, not a pass.

  **Say WHY, and look twice before saying it.** Failing is the necessary half;
  a `catch {}` that discards the reason makes the finding unactionable, because
  a rate limit, a timeout and a deleted repo are three different jobs.
  `check-queue-health` named a repo and nothing else until 2026-09-07, and its
  five findings that day were undiagnosable after the fact. It also had no retry
  against a measured 0.13% transient rate — one blip in one repo out of 27 paged
  `@here`, and every one recovered untouched on the next run. `READ_ATTEMPTS` is
  2 and the reason is carried into the finding. Retrying is NOT tolerating: a
  repo that fails every attempt is still unreadable and still fails the gate.

  **Corollary: no gate may get EASIER to pass the worse the failure gets.**
  `queue-health` excludes runs past a one-hour ceiling from its p95, which is
  correct — two uncancellable runs from 2026-08-17/19 would otherwise pin it red
  forever. But it meant a 20-minute stall reddened while a two-hour one went
  green, because every casualty eventually crossed the line and left the
  percentile. On 2026-09-07 the fleet served nothing from 01:56 to 04:08 and the
  gate reported `ok: true, queued: 0` through the back half. If you exclude a
  category, check what happens when a real failure MANUFACTURES that category.
  The fix was an age band — `ZOMBIE_SECONDS`, days-old zombies versus fresh
  casualties — because the data telling them apart was already in hand.

- **`--json` is a contract.** mgmt-api cron jobs parse subcommand stdout and
  treat a non-zero exit as a FINDING, not a crash. Parseable stdout wins over the
  exit code. Breaking that turns every real finding into "the checker broke".
  **Which jobs, by name, is declared in `scripts/lib/json-contract.mjs`** and
  gated by the test beside it. The LIST is the declaration — this file carried a
  bare count instead, and was wrong twice. Renaming a subcommand under contract
  is a CROSS-REPO change; the gate names the mgmt-api file to fix in the same
  pass.
- **Manifests are operator config, not package content.** They live in
  `manifests/` and are resolved through `FLEET_MANIFEST_DIR` — never a
  `__dirname` walk. A node's `maxConcurrent` is its only per-node ceiling,
  thermal included — changing it is a safety decision, not tuning. (The tier
  ladder and `runner-tiers.json` were retired on 2026-09-21; see
  `src/fleet-loop.ts`.) Resolution must THROW on a missing directory: a
  manifest that resolves to nothing reports a healthy fleet of zero machines.
- **A CONDITIONAL GitHub call and an UNCONDITIONAL one do not cost the same, so
  a cadence that is safe for one can be fatal for the other.** The dispatcher's
  queued-runs listing sends an ETag and a 304 is genuinely free — measured, the
  budget does not move — so its ceiling is not its spend and it can run as often
  as you like. **Since 2026-10-16 every `ghGet` is conditional too** (`ghCache`
  in `runner-health.ts`). This file used to say that a reader needing CURRENT
  state cannot send an ETag; that was wrong — a 304 is GitHub saying the body it
  would serve NOW is the one we hold, so the reap may delete on it. What stays
  true is that a listing which CHANGED between calls is charged: a busy repo's
  runner listing flips `busy` constantly. So a conditional read lowers the
  typical bill and leaves the CEILING where it was — size every cadence as if
  each call were charged, and never speed a timer up because 304s are free.
  Speeding up a timer speeds up **everything hanging off it**, and each thing
  needs its own arithmetic.

  This is not hypothetical. Moving dispatch from the ladder's 60s tick to its own
  15s one (2026-09-05) took the reap from 1,620 to 6,480 calls/hr against a
  5,000/hr budget, and the change reasoned carefully about the listing path only.
  The fleet then spent **19 minutes of every hour** unable to poll or mint —
  `remaining: 0` at ~:13 past, reset at ~:33 — which surfaced as `ci:queue-health`
  flapping and jobs that all started at ~:32 regardless of when they arrived.
  `REAP_INTERVAL_MS` now gates the sweep on its own clock, and
  `dispatch-pass.test.ts` asserts the per-hour arithmetic at fleet size.

  **Measure before estimating.** Since 2026-10-16 (#119) `GET /fleet` carries
  `githubBudget[]`: GitHub's own `x-ratelimit-*` per token plus this process's
  calls by caller. One `[gh-budget] window ended` log line per hour names every
  spender, and a page fires below 20% before anything is refused. Four
  blackouts were diagnosed by arithmetic before that existed;
  `docs/planning/api-budget-2026-10-16.md` is the last one.

  When the budget IS spent, `runner-health` suppresses further calls until the
  reset rather than retrying — a spent budget is one fact about the TOKEN, not a
  fault in one call. Suppression returns each function's **"could not look"**
  value (`null`, `{status:'error'}`, `ok:false`) and must NEVER return
  `unchanged`, which would tell the dispatcher its cached queue is still current.

- **When one node works and others do not, diff the NODES before reasoning
  about the code.** Issue #17 took three diagnoses; the two wrong ones were
  confident and came from reading source and a planning doc that described the
  design before a later commit changed it. The one that held was `ls -a` on a
  working node and a broken one, diffed: the broken ones carried a file GitHub
  had written server-side. A planning doc standing in for the code is the
  fourth time a COMMENT has been read as evidence here. Corollary: a backoff
  makes a broken node QUIET, so "zero failures" is not "fixed" — read the
  canary or the backoff file, not the absence of log lines.

- **`createFleetManager` is a singleton.** The moving code holds 16 module-level
  mutable singletons. It throws on a second call — do not "fix" that by removing
  the guard.
- **A host can be passive.** `FleetHost.controller` (default `true`) gates
  `start()`. `docs/control-plane.md` holds the controller assumption, which
  contracted subcommands are host-bound (`scripts/lib/json-contract.mjs`), and
  why `~/.hadoku/jit/*` and `standing.env` are per-node, not controller-local.
- **No AI attribution** in commits or PRs.
- **Never `runs-on: ubuntu-latest`.** The fleet form is
  `${{ fromJSON(vars.CI_RUNNER) }}` — BARE, no `|| '[...]'` fallback.
  `CI_RUNNER` is normally **SET**, to `["self-hosted","hadoku-builder"]`, and
  this package's `src/ci-runner-fallback.ts` writes it to every covered repo on
  every 10-minute tick; mgmt-api moves it to `"ubuntu-latest"` only while every
  claw is offline. Setting it by hand pins the fleet onto billed minutes and gets
  reverted within 10 minutes.

  It is persistent repo state: if this package stops running, the last value
  written stays and CI keeps scheduling. WolffM is a USER account, so there are
  no org-level variables to inherit — every repo carries its own. When auditing
  the form, **blank comments first**: several repos carry a comment reading "do
  NOT restore the `vars.CI_RUNNER || ...` fallback here", and a raw grep scores
  that as usage of the thing it forbids. `fleet check-runner-var` measures the
  live population; do not keep a census in this file.

  **Capacity may be UNMEASURED, and that is not zero.** `syncHostedFallback`
  takes `number | null`; `null` holds the tick and writes nothing. Under all-JIT
  every claw's capacity comes from the fast loop's probe, which is null until its
  first pass ~60s after boot — so runner-health's first tick after any restart
  reads zero claws on a healthy fleet (observed 2026-09-07 over three deploys:
  1, 10, 0, 3, against a steady 6 between them, with `runners_checked=true`).
  `desired` has no debounce, so one such tick would pin every repo to billed
  minutes. `census` draws the line as `ephemeralUnknown` and every consumer must
  consult it. The type does NOT enforce this at the call site: the sum of the two
  counts is a `number`, which satisfies `number | null` perfectly well. The guard
  is held by a tick-level test in `runner-health.test.ts`, not by the compiler.

  **Detection is guarded. WRITING still is not.** `fleet check-runner-var`
  (`scripts/check-runner-var.mjs`) and the `ci:runner-var` cron that consumes it
  catch a repo whose workflows read `CI_RUNNER` without it being set — the case
  `ci-runner-fallback.ts` named for a year before either existed. Neither WRITES
  the variable: `syncHostedFallback` is still the only writer anywhere, and it
  still iterates `coveredRepos()`, so it structurally cannot reach a repo that is
  not in the roster yet. A NEW repo therefore has no `CI_RUNNER` until the
  nightly reconcile admits it. That is why `hadoku_site/templates/*` still carry
  a fallback and must NOT be converted to bare: the bare form is correct for a
  covered repo and fatal for a template, whose output is by definition not
  covered yet.

  Since 2026-09-01 that fallback is `'"ubuntu-latest"'`, **not** the claw labels.
  A scaffolded repo has no runners either, so falling back to labels nothing
  carries aims its jobs at nothing and QUEUES them silently — the 854 minutes
  hadoku-games-host sat on 2026-08-23. Hosted builds it, and the repo moves to
  the fleet on its own once mgmt-api writes the variable. That also removes the
  last copy of the fleet's label set outside this package.
  `hadoku_site/scripts/test/template-runner-form.test.mjs` enforces both halves —
  no claw labels, and no bare form.

- **The CI job must stay named `check`.** It is this repo's required status
  context. Rename it and every PR becomes permanently unmergeable waiting on a
  context that never reports.
- **`pnpm lint` does NOT catch type-aware bugs.** The type-aware set runs only
  under `ESLINT_TYPE_AWARE=1` (`pnpm run lint:types`). A green `pnpm lint` is not
  evidence an async change is safe.

## Known gaps — read before assuming these work

- **This repo is inside the fleet-wide gates.** It is in
  `fleet-runner-coverage.json`, `ci-watch.generated.json`, the token-rotation
  list and branch protection. It is NOT in coverage `facets`, and that is
  CORRECT rather than a gap: `deriveFacets` writes a key only for a repo with
  `@wolffm/*` dependencies, a UI app, or a micro-frontend, and this package has
  no `dependencies` field at all. So `check-header-fleet` / `check-tier-fleet` /
  `check-mf-externals` genuinely have nothing to say about it. Do not "fix" this
  by adding a facets entry by hand — the file is generated by
  `fleet reconcile --write-coverage`.
- **No guarded install.** See above — `pnpm-guarded-install.sh` lives in the
  hadoku_site checkout and cannot be invoked from here without vendoring.
- **`reconcile` truncates the repo universe at 500 and says nothing.** It reads
  `gh repo list <owner> --limit 500`. At 26 covered repos that is nowhere near,
  but nothing signals truncation, so crossing it would silently shorten the
  roster and `ci:fleet-coverage` would report clean coverage of a subset —
  the same shape as the zero-repo case that gate now refuses. Left unfixed
  deliberately: a guard against a limit the fleet is not close to is speculative,
  and the fix is a page-until-empty loop rather than a bigger number.

## Layout

| path           | holds                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/`         | the library: monitors, the fast loop, dispatch, supervision, `routes/fleet`                                   |
| `src/runners/` | JIT provisioning + placement (workstream B)                                                                   |
| `src/cli.ts`   | the single `fleet` CLI entry — one door, `COMMANDS` is the whole table                                        |
| `src/lib/`     | shared helpers — `node-identity` and friends                                                                  |
| `scripts/`     | what the subcommands spawn, plus `lib/` guards that read the source tree                                      |
| `scripts/lib/` | `tier-detectors.mjs` is a published subpath export; hadoku_site imports it                                    |
| `manifests/`   | machine topology, resolved coverage. NOT published.                                                           |
| `herdr/`       | herdr plugins (`hadoku.fleet`, `hadoku.sessions`), linked from a checkout. NOT published. See `docs/herdr.md` |
| `docs/`        | operations + the migration plan                                                                               |

## Secrets

Via the `hadoku_site` broker only. `.devvault.local.json` (gitignored) holds this
checkout's vault key; dev-vault resolves it from CWD, so commands must run from
the repo root. NEVER a `.env` file, never a raw token in an npmrc.
