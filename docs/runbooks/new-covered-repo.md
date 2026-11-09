# R7 — new covered repo

Scenario #7 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
Written against `scripts/reconcile-fleet-runners.mjs`'s current chain:
coverage is DECLARATIVE — `autoInclude` derives which repos SHOULD have
fleet runners from what GitHub actually reports (recent pushes, a workflow
that targets the fleet), and a repo joins or leaves that set on its own as
those facts change. "Covering a new repo" is mostly making sure that
derivation reaches it, and verifying what depends on coverage catches up.

Every `fleet …` command below is checked against `src/cli.ts`'s door table by
`scripts/lib/onboarding-docs.test.mjs`.

## Preconditions

- The repo exists under the fleet's owner and has at least one workflow
  whose `runs-on` targets the fleet (the bare
  `${{ fromJSON(vars.CI_RUNNER) }}` form — see "Never `runs-on:
ubuntu-latest`" in this repo's `AGENTS.md`). A repo scaffolded from a
  template inherits a `|| '"ubuntu-latest"'` fallback and MUST keep it until
  this runbook's step 4 confirms it is actually covered — the bare form on
  an uncovered repo queues every job silently (854 minutes burned this way
  on `hadoku-games-host`, 2026-08-23, before the fallback existed).
- Decide whether to let the nightly `ci:fleet-coverage` cron pick the repo up
  on its own (it will, once `autoInclude`'s cheap proxy matches — a recent
  push and a workflow that targets the fleet) or whether you need it covered
  sooner, which is step 1 below.
- If the repo is public, read `docs/planning/refactor-plan-2026-10-28.md`
  §1.4 before continuing: every public repo this fleet covers carries
  fork-PR approval, and step 6 below is where that gets set for a new one.

## Steps

1. **Force it into the desired set now, or wait for `autoInclude`.** Where:
   from the control host, read-only, to check which path you are on. As:
   read-only.
   Command: `fleet reconcile --repo <owner>/<repo>`
   If it reports the repo already in the desired set, `autoInclude` has it —
   skip to step 2. If it refuses with "not in the desired or retired set",
   either wait for the nightly cron (it will match once the repo has a
   recent push and a self-hosted-targeting workflow), or add an explicit
   entry to `manifest.repos["<owner>/<repo>"]` in the LIVE manifest — the
   `hadoku_site` checkout, never `~/srv` (see this repo's `AGENTS.md`, "that
   hadoku_site copy is the live one"). An explicit entry is intent a human
   stated and always wins over the derived rule, same shape `hadoku-registry`
   already carries for "live infra with only one workflow, so autoInclude's
   `minWorkflows` would drop it."
   Verify: `fleet reconcile --repo <owner>/<repo>` now reports the repo in
   the desired set (not a refusal).

2. **Register runners.** Where: from the control host. As: `fleet reconcile`
   connects as `admin` (through the hand-written user systemd unit, not
   root — see the script's own header for why).
   Command: `fleet reconcile --confirm --repo <owner>/<repo>`
   Verify: `fleet reconcile --repo <owner>/<repo> --json` reports no missing
   coverage for this repo, and `gh api
repos/<owner>/<repo>/actions/runners` lists the new registrations ONLINE.

3. **Regenerate the coverage facet.** Where: from the control host. As:
   read/write of the coverage file (no ssh).
   Command: `fleet reconcile --write-coverage`
   This is what `coveredRepos()` — the one function `syncHostedFallback`
   (step 4) and `check-runner-var` both read — resolves fresh on every call.
   A repo registered in step 2 but not yet folded into this file is invisible
   to both.
   Verify: `fleet reconcile --check-coverage` reports clean against the new,
   larger roster.

4. **`CI_RUNNER` catches up.** Nothing to run — `syncHostedFallback` iterates
   `coveredRepos()` on its own tick (every repo-sync pass) and writes
   `vars.CI_RUNNER = '["self-hosted","hadoku-builder"]'` to this repo the
   first time it sees it in that list. **Until step 3 lands, the variable is
   UNSET on this repo**, which is exactly why a template's own workflow must
   keep the hosted `|| '"ubuntu-latest"'` fallback (enforced on the
   `hadoku_site` side by `template-runner-form.test.mjs`) and this repo's own
   bare form must not be copied into a template.
   Verify: `fleet check-runner-var` no longer lists `<owner>/<repo>` as
   "reads `vars.CI_RUNNER` without it being set." Confirm directly with
   `gh variable list --repo <owner>/<repo>` once that passes.

5. **Verify a real job actually mints.** The JIT runner name is
   `jit-<node>-<repo-slug>-j<jobId>-r<runId>-<epochSeconds>`, and GitHub
   answers 422 — not a warning — past 64 characters at
   `generate-jitconfig` (`MAX_RUNNER_NAME`, `src/runners/ephemeral.ts`). This
   is not theoretical: `hadoku-fleet-manager` itself (20 characters) produced
   a 69-character name on 2026-09-02 and could not mint AT ALL, while CI sat
   queued with nothing able to take it. `jitRunnerName`/`warmRunnerName` now
   truncate the REPO SLUG to whatever room is left — the slug is the only
   part of the name nothing reads back, so shortening it cannot collide —
   but a long NODE name stacked against a long repo name can still leave no
   room for any slug at all, and the function's fallback in that case is to
   drop the slug and mint anyway rather than silently failing. Truncation
   makes this graceful, not invisible — still verify with a real run rather
   than assuming the length math works out for this particular repo name.
   Where: from the control host, read-only. As: read-only.
   Command: trigger or wait for a real workflow run, then
   `gh run list --repo <owner>/<repo>`
   Verify: the run actually STARTS (not stuck `queued`), and
   `gh api repos/<owner>/<repo>/actions/runners` briefly shows a `jit-`
   runner for it while the job is live.

6. **Fork-PR approval (public repos only).** Where: the repo's own GitHub
   settings. As: the operator, directly — no `fleet` command does this.
   Set Settings → Actions → General → Fork pull request workflows →
   "Require approval for all outside collaborators"
   (`all_external_contributors`). Every other public repo this fleet covers
   carries this; a new one that does not is the one PR away from running an
   outside contributor's workflow on a claw unattended. As defense in depth,
   also route non-OWNER/MEMBER/COLLABORATOR PRs to `ubuntu-latest` inside the
   repo's own `ci.yml` the way `fleet-manager`/`tenhands`/`task`/`study` do —
   this is the only one of the fleet's public repos that relies on the
   approval setting alone, and §8.2 of the refactor plan calls that gap
   "softened, not urgent" rather than closed.
   Verify: `gh api repos/<owner>/<repo>/actions/permissions/workflow` (or the
   Settings page) reports `all_external_contributors`.
   **GAP**: nothing in this repo checks this setting today — no `fleet`
   gate, no cron. §5.3's own note for R7 is "make it a reconcile check,"
   unsized and unphased in §5.4; until that lands, this step is purely
   manual and silently reversible by anyone with admin on the repo.

## Rollback

- Before step 2 (`reconcile --confirm`): if you added a manifest entry in
  step 1, remove it. Nothing on GitHub has been created.
- After step 2, before step 3 (`--write-coverage`): the registrations exist
  but `coveredRepos()` does not see them yet. Either continue to step 3, or
  mark the repo `skip: true` in the manifest (which makes its runners
  orphans) and run `fleet reconcile --confirm --remove-orphans` to tear them
  down.
- After step 3: the repo is now a normal covered repo. Taking it back out is
  R3 (retire a node) applied at the repo granularity — drain its runners,
  deregister them, mark `skip: true` or remove the manifest entry, then
  `fleet reconcile --write-coverage` again to shrink the roster
  (`--allow-shrink` if removing it drops the roster by more than half — read
  why it refused before passing that flag; it exists to catch a manifest
  read error presenting as a mass departure).

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command above
  exists in the door's table.
- `scripts/lib/publish-safety-guard.test.mjs` — this file names no address,
  MAC, tailnet name, or other site fact.
- `fleet reconcile --check-coverage` (hand-run) — catches a repo whose
  coverage has drifted since step 3; the nightly `ci:fleet-coverage` cron
  runs the same `reconcile` subcommand with `--json` instead, for a
  different question (does every repo have a runner).
- `fleet check-runner-var` (hand-run; its own `ci:runner-var` cron retired
  wave gates2, 2026-11-08 — the SAME check now runs nightly as the
  `runnerVar` finding inside `ci:fleet-coverage`) — catches a repo that asks
  for `vars.CI_RUNNER` without having it, which step 4 depends on being
  clean.
- `hadoku_site`'s `template-runner-form.test.mjs` — keeps a template's hosted
  fallback in place so a not-yet-covered scaffold never queues silently.

## Memory lessons this runbook holds

- **JIT name 64-char ceiling** — step 5; this repo's own name once broke
  minting entirely, which is why `hadoku-fleet-manager` keeps a standing
  resident-repo registration as a backstop even though every other repo is
  all-JIT (`docs/VOCABULARY.md`, "the resident backstop").
- **Security origin matched nothing** — the general lesson behind step 6:
  an assumed-but-unverified security posture (there, missing apt updates;
  here, missing fork-PR approval) survives exactly until someone checks it
  by hand, because nothing pages on its absence.
- **Repo is the traffic controller** — `autoInclude`'s derivation in step 1
  is not a fixed constraint to work around; a repo's own push history and
  workflow shape is the lever that puts it in or out of coverage.
- **`--allow-shrink` refuses for a reason** — Rollback section; read why a
  shrink was refused before overriding it, because the same refusal also
  catches a manifest read error that looks like a mass departure.
