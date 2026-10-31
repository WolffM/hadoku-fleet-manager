# R13 — new gate, converger or recorder

Scenario #13 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
Since wave 5e: every automated fleet job — gate (read-only check), converger
(mutates toward a declaration) or recorder (writes a measurement, converges
nothing) — has exactly one declaration, `src/lib/job-registry.ts`'s
`JOB_REGISTRY`. `scripts/lib/json-contract.mjs`'s `JSON_CONTRACT` and
`PROSE_CONTRACT` are DERIVED from it; there is no second list to keep in
sync by hand.

This is a 4-file change across 2 repos — two here (`src/cli.ts`,
`src/lib/job-registry.ts`), two in `hadoku_site` (the mgmt-api wrapper route,
and the cron profile). Steps 4–5 below are in the OTHER repo; this runbook
names what they must do without editing them from here.

Every `fleet …` command below is checked against `src/cli.ts`'s door table by
`scripts/lib/onboarding-docs.test.mjs`.

## Preconditions

- Decide the **kind**: `gate` (never mutates — a guard checks this),
  `converger` (changes state toward a declared shape, default
  `--confirm`/`--write`/`--refresh` to apply), or `recorder` (writes one
  declared measurement as its whole job).
- Decide the **clock**:
  - `{ cron }` — Temporal's cron-worker dispatches it on a schedule; a
    hand-written wrapper in `hadoku_site` turns that into
    `fleet <sub> --json`. This is the right choice for almost every new
    gate/recorder.
  - `{ clockMs }` — an in-process control loop inside mgmt-api's own Node
    process (`createConverger`, `src/scheduled-converger.ts`). Only choose
    this if the job is genuinely a converger this package already drives on
    its own clock (`src/provisioning-converge.ts`,
    `src/hosting-converge.ts`, `src/claw-reboot.ts` are the only three
    today) — it has no `mgmtApiFile` because there is no mgmt-api route at
    all.
- Decide the **detection budget** — how stale the job's last verdict may get
  before it is itself a finding. The honest default, absent a stated reason,
  is 2x the cadence period; `validateRegistry` checks the cadence can
  actually MEET whatever budget you declare, it does not invent one for you.

## Steps

1. **Write the script and its `COMMANDS` entry.** Where: this checkout,
   `scripts/<name>.mjs` plus an entry in `src/cli.ts`'s `COMMANDS` table
   (`kind: 'gate' | 'converger' | 'recorder'`, `flags`, `summary`). As: code
   author.
   The script's own stdout discipline matters: under `--json` it must write
   through `scripts/lib/emit.mjs`'s `emit()` and nothing else —
   `emit.test.mjs` scans every contracted script's source for a stray
   `console.log`/`process.stdout.write`, because one stray human line before
   the JSON turns a real finding into "the checker broke" for every
   consumer that does `if (out.trim().startsWith('{'))` before it looks at
   the exit code. A `gate` must never accept `--confirm`/`--write`/`--apply`
   in its own flags — plan §3.4's rule, and `validateRegistry` enforces it
   at the registry level in step 2.
   Verify: `fleet <sub> --json` run by hand against a real or fixture
   environment prints exactly one parseable JSON document, first byte `{`.

2. **Add the `JOB_REGISTRY` entry.** Where: this checkout, `src/lib/
job-registry.ts`'s `JOB_REGISTRY` array. As: code author.
   Fields: `name` (`ci:<thing>`), `sub` (the `COMMANDS` key from step 1),
   `args` (the actual argv — `['--json']` at minimum; `--json` is required
   once you set `contract: 'json'`), `kind`, `detectionBudget`, `cadence`,
   `timeoutS`, `hostBound` (true only if it reads something that belongs to
   THIS box rather than the fleet — mgmt-api's own pm2 log, for example),
   `mgmtApiFile` (the route file step 4 will create — name it now so the
   two repos agree on the path), `contract: 'json'` (or `'prose'` only if
   you are folding into the `ci:audit-gates` umbrella — avoid this for a new
   job; prose gates are being migrated OFF, not onto), and `why` (one real
   sentence — not restating the name).
   Verify:

   ```
   pnpm run build
   node --test scripts/lib/job-registry-guard.test.mjs
   ```

   This guard fails the build if your new `COMMANDS` entry's kind
   (`gate`/`converger`/`recorder`) has no row here and no `MANUAL['<sub>']`
   reason — there is no way to add a scheduled-kind subcommand and forget
   to register it without this test naming exactly which one.

3. **Confirm the derived contract picked it up.** Nothing to edit —
   `JSON_CONTRACT`/`PROSE_CONTRACT` in `scripts/lib/json-contract.mjs` are a
   pure function of `JOB_REGISTRY`.
   Verify: `node --test scripts/lib/json-contract.test.mjs`.

4. **The mgmt-api wrapper (`hadoku_site`, not this repo).** Where: that
   checkout, `services/mgmt-api/src/routes/jobs/<name>.ts` — the exact path
   you named as `mgmtApiFile` in step 2. As: whoever owns that repo's
   changes (cross-repo; this runbook documents the requirement, it does not
   authorize editing that repo from here).
   The file must import `fleetCli` from `./lib/site-paths.ts` and spawn
   `fleet <sub>` with the SAME args as the registry entry. It must be
   **error-first**: a non-zero exit or an unparseable stdout is a FINDING
   returned to the caller, never a thrown exception that becomes an
   unhandled 500 — verified on that side by `fleet-wrapper-error-first.test.ts`.
   Verify (from there): that test, plus a manual dispatch against the
   route and a read of the response shape (`GateDoc`/`ConvergeDoc`/
   `RecordDoc`, not a stack trace).

5. **The cron profile (`hadoku_site`, not this repo).** Where: that
   checkout, `services/cron-worker/profiles.json`, under the matching
   scheduler bucket (`fleet-pulse` */10, `fleet-benchmark` 12:00Z,
   `repo-sync` 13:00Z, or its own entry) with the SAME cron string as step
   2's `cadence`. Skip this step entirely for a `{ clockMs }` job — there is
   no profiles.json entry for an in-process loop; its clock is this
   package's own, wired through `src/index.ts`.
   Verify: from THIS repo, once the profile change has landed —
   `fleet check-schedule`.

6. **Prove the schedule actually meets the budget.** Where: from the
   control host. As: read-only, offline except for one read of
   `profiles.json` through `lib/fleet-source.mjs`.
   Command: `fleet check-schedule`
   This cross-checks three ways: a `{ cron }` registry entry with no job in
   `profiles.json` at all (MISSING-FROM-SCHEDULE), a scheduled cron whose
   own period cannot meet the registry's `detectionBudget`
   (CRON-CANNOT-MEET-BUDGET), and a scheduled job that spawns the `fleet`
   CLI with no registry row naming it (UNREGISTERED-FLEET-JOB).
   Verify: exit 0, with no finding naming your new job.

7. **Staleness — both clocks are watched; know which one watches your job.**
   - **An in-process job** (`{ clockMs }`, run by the job runner,
     `src/lib/job-runner.ts`): `scheduleRepeating` registers its loop and
     `finishTick` notes each completed tick (`src/lib/liveness.ts`).
     mgmt-api's `/api/status` carries every loop in its `fleet` block, and
     the off-box Cloudflare heartbeat (hadoku_site
     `workers/monitoring-api`) alarms when a loop goes stale, or never ticks
     after a restart once its first-run grace has passed.
     Verify: the job's name appears in `/api/status`'s `fleet.loops` with
     `status: "ok"` after its first run (`"pending"` before it).
   - **A cron job** (`{ cron }`, the common case): hadoku_site mgmt-api's
     schedule-staleness watcher (`services/mgmt-api/src/schedule-staleness.ts`)
     runs on mgmt-api's OWN timer, so the Temporal clock is watched from the
     other clock. Every hour it reads each registry cron job's newest run from
     monitoring-api's job executions and alerts once when it is older than
     the job's `detectionBudget`, with a recovery line when it runs again. It
     reads `JOB_REGISTRY` from the installed fleet-manager, so a new registry
     row is watched as soon as that version is deployed.
     Verify: after deploy, the watcher's log shows it starting, and no
     `schedule-staleness` alert names your job once its first run lands.

## Rollback

- Before step 2 (registry entry) lands: delete the `COMMANDS` entry and the
  script. Nothing dispatches it; nothing to undo elsewhere.
- After step 2, before steps 4–5 (the other repo's wiring): the job is
  declared but nothing runs it on a schedule. `fleet check-schedule` will
  report MISSING-FROM-SCHEDULE for it — expected at this point, not a bug.
  `fleet <sub> --json` still works by hand.
- After the cron lands (step 5 committed in `hadoku_site`): remove the
  `profiles.json` entry and the mgmt-api route file FIRST, in that repo, then
  remove the `JOB_REGISTRY` row here. Removing the registry row first makes
  `job-registry-guard.test.mjs` fail (the `COMMANDS` entry becomes
  "uncovered") without actually stopping the live cron — the two repos must
  come down in that order, same as they went up in the reverse order.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command above
  exists in the door's table.
- `scripts/lib/publish-safety-guard.test.mjs` — this file names no address,
  MAC, tailnet name, or other site fact.
- `scripts/lib/job-registry-guard.test.mjs` — no gate/converger/recorder
  `COMMANDS` entry may exist without a `JOB_REGISTRY` row or a `MANUAL`
  reason; a `gate` may never carry a mutating flag.
- `scripts/lib/json-contract.test.mjs` — the derived `JSON_CONTRACT`/
  `PROSE_CONTRACT` lists track `JOB_REGISTRY`, not a frozen snapshot.
- `fleet check-schedule` (this repo, reads `hadoku_site`'s
  `profiles.json`) — the cron actually declared matches what this registry
  says it needs.
- `fleet-wrapper-error-first.test.ts` (`hadoku_site`, not this repo) — the
  mgmt-api wrapper treats a failure as a finding, never a crash.

## Memory lessons this runbook holds

- **`--json` is a contract** — step 1; parseable stdout wins over the exit
  code for every consumer on the other end, and `emit()` is the only way a
  script here may write it.
- **Opt-in gate is inert** — a gate wired behind an optional flag nobody
  passes, or a job declared in the registry with nothing in `profiles.json`
  dispatching it, routes to nobody. Step 6 exists precisely to catch that
  gap before it is discovered by its absence rather than by a gate.
- **Guards must be automated** — the manual subcommand from step 1 is not
  "done" until BOTH the cron profile (step 5) and `check-schedule` (step 6)
  confirm it actually runs on a schedule that meets its own budget.
- **JSON pipe 8K cliff** — if this job's `--json` output can grow large,
  verify it by writing to a file rather than piping it through something
  that truncates past 8 KB; this bit a real `--json` consumer once (#33).
- **Converge only sees notes** — a finding this job reports must land
  somewhere a CONVERGER actually reads, or it reddens a gate forever with
  nothing able to repair it; decide at design time whether this is a gate
  that merely reports, or a converger that also fixes.
