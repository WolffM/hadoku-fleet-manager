# R11 — tenant change or exit

Scenario #11 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
Covers resizing a slice in place, ending one node's slice, removing it,
changing a tenant's TOTAL slice count through demand, and exiting entirely.
Applies to both tenant kinds — see R9 (`tenant-agent.md`) and R10
(`tenant-pm2-service.md`) for how a slice gets declared in the first place.
Tenancy belongs to another owner (fleet-manager#16); this runbook documents
CURRENT commands only, read from `scripts/hosting.mjs`,
`scripts/hosting-demand.mjs` and `scripts/lib/hosting-converge.mjs`.

Every `fleet …` command below is checked against `src/cli.ts`'s door table by
`scripts/lib/onboarding-docs.test.mjs`.

## Preconditions

- The tenant is registered (`fleet hosting-request <owner>/<repo>` reports
  valid) and holds at least one slice (`fleet node-status --json` or `fleet
hosting --check` names it, under the node it is on).
- For a demand-driven change (step 5): know whether the tenant has
  `placement.auto: true`. Only an auto tenant's slice count is met
  unattended by `fleet hosting-converge`; every other tenant's demand is
  only ever `planned`, never acted on.

## Steps

1. **Resize a slice in place** (same node, new memory or cores). Where:
   control host. As: `fleet hosting` as `admin`.
   Command:

   ```
   fleet hosting claw-9 --tenant cardtable --memory 6G --cores 6 --shared
   ```

   Re-declaring the SAME node with the SAME mode (`--shared` or not) and
   role is a resize, not a new slice — `fleet hosting` refuses if either
   differs from what the node already holds ("End and remove that first.").
   A resize restarts the hold-back grace (CI is held back from the new
   ceiling only after the usual delay) and re-deploys the unit's memory/cpu
   limits. **It also silently takes back any scheduled end**: the record
   this writes carries no `until`, so a resize of a slice that was mid-way
   through step 2 below cancels that end as a side effect, the same as step
   3's `--keep` would.
   Verify: `--json`'s `declared` shows the new numbers; `fleet hosting
--check` reads `guaranteed` for the new size, not the old.

2. **Schedule an end for one node's slice.** Where: control host. As:
   `admin`.
   Command:

   ```
   fleet hosting claw-9 --end --in 30m
   fleet hosting claw-9 --end --at 2026-11-01T02:00:00Z
   ```

   The tenant is owed at least 15 minutes (`HOSTING_NOTICE_MS`); a shorter
   window refuses unless `--force` ("the box is failing"). `node-status
--json`'s `notices` and `hosting-demand`'s view both show the scheduled
   end from the moment it is set — the notice is visible before it happens,
   not just logged after.
   Verify: `fleet node-status --json` lists the node's `hosting.until`;
   running `fleet hosting claw-9 --end --in 45m` again before that time
   extends the SAME record rather than scheduling a second one.

3. **Take an end back.** Where: control host. As: `admin`.
   Command:

   ```
   fleet hosting claw-9 --keep
   ```

   Only ever gives the tenant more, so it owes no notice — use this when the
   tenant asks for the slice back before `--remove` has run. (A resize,
   step 1, does the same thing as a side effect if you are changing the size
   anyway; use `--keep` when you are not.)
   Verify: `fleet node-status --json` shows `hosting.until: null` again for
   the node.

4. **Remove it, once the end has passed.** Where: control host. As: `admin`.
   Command:

   ```
   fleet hosting claw-9 --remove
   ```

   Refuses while a scheduled end is still ahead, or while there is NO end
   scheduled at all ("Run --end --in 30m first, so the tenant sees it
   coming.") — unless `--force`. Tears down the unit, the tenant's files and
   the firewall rule, then READS BACK what survived: a leftover cgroup or
   firewall rule keeps the record and reports `remove-incomplete`, not
   success, so re-running `--remove` is always the right next step on a
   partial failure.
   Verify: the command's own output ends `✓ <node> is no longer hosting…`;
   `fleet node-status --json` no longer carries a `hosting` entry for the
   node.

5. **Change the tenant's TOTAL slice count** (an `auto` tenant; every other
   tenant only ever gets a plan). Where: control host, or the tenant's own
   automation — this door is explicitly `CALLED BY A PROGRAM`, every poll.
   As: whoever the tenant authenticates as; not necessarily `admin` on any
   node.
   Command:

   ```
   fleet hosting-demand cardtable --slices 2 --release-order claw-6,claw-5
   fleet hosting-converge --dry-run --json      # decide only, act on nothing
   ```

   Restating the same count is a no-op but for `askedAt`, so a retried call
   or a duplicate poll never drifts it. The controller runs
   `fleet hosting-converge` on its own 5-minute timer; `--dry-run` or a plain
   `fleet hosting-demand <app> --json` (no `--slices`) both show what it
   would do without waiting for that tick.
   - **Growing** the count: the next pass declares on the plan's top picks,
     up to `slices.max`.
   - **Shrinking** it: the pass ends slices from the HEAD of
     `--release-order`, limited to nodes it is actually serving — a node
     named in the order that this tenant does not currently hold is simply
     not in the list it filters against.
   - **With no `--release-order` at all** (or one naming none of the
     currently-serving nodes), **the converger ends nothing and says so** —
     by design: "only the tenant knows what a slice holds", so it never
     guesses which one is safe to give up. This is the current, verified
     behaviour of `decide()` in `scripts/lib/hosting-converge.mjs`
     (`order.length < excess` is reported as a soft block, not silently
     dropped).
   - A slice younger than 10 minutes (`YOUNG_SLICE_MS`) is held through the
     very next pass even if it is first in the release order — cardtable's
     demand went 2 → 1 → 2 within 14 minutes on 2026-10-28, and the
     converger had already removed one node 36 seconds past its end before
     declaring a replacement; this guard is what stops that replacement
     node being ended again on the pass right after.
     Verify: `fleet hosting-demand <app> --json` reports `declared`/`ending`
     matching what was asked for; its `lastPass` (after the controller's next
     tick, or your own `--dry-run`) names the action taken or the `blocked`
     reason it gave for not acting.

6. **Exit entirely** (every slice ended and removed). Repeat steps 2 and 4
   for every node the tenant holds (`fleet node-status --json`'s
   `hosting.declared.tenant === <app>` names each one), or drop
   `hosting-demand`'s count to 0 for an auto tenant and let the converger do
   it with notice.
   **There is no `fleet hosting-request --unregister`.** `registerTenant`
   only ever upserts an entry (`scripts/lib/tenant-registry.mjs`); nothing in
   this repo deletes one. Once the last slice is removed, the tenant's
   normalized request stays in `hosting-tenants.json` — the fleet still
   knows it and would accept a new slice for it on request. This is a real
   gap, not covered by §5.4's engineering table (which only costs R3/R10/R11
   items that already have a size and phase): it has neither.
   Verify: `fleet node-status --json` lists no node for this tenant; `fleet
hosting-request <owner>/<repo>` still reports the request valid —
   confirming the tenant is still registered, which is the current, correct
   (if incomplete) behaviour, not a bug in that command.

## Rollback

- Step 1 (resize): re-declare the previous memory/cores — a resize is
  reversible the same way it was made.
- Step 2 (end scheduled): step 3 (`--keep`) takes it back at any time before
  `--remove` actually runs.
- Step 4 (removed): re-declare it (R9/R10's declare step on the same node).
  The tenant is still registered, so only the slice itself needs recreating
  — for an agent kind, run `--install` again explicitly afterward: a manual
  `fleet hosting` declare does NOT auto-install the kept artifact. (Only
  `fleet hosting-converge`'s own `act()` does that, for a slice IT declares.)
- Step 5/6 (demand change): restate the previous count. Nothing is
  destructive until an `--end`/`--remove` from steps 2/4 actually runs.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command above
  exists in the door's table.
- `scripts/lib/publish-safety-guard.test.mjs` — this file names no address,
  tailnet name or other site fact.
- `fleet hosting --check` / `fleet node-status --json` — a slice whose end or
  removal did not fully take holds a `blocking` finding until the step is
  re-run.
- `fleet hosting-demand <app> --json`'s `lastPass` is the converger's own
  record of what it did and why — read it rather than inferring intent from
  silence between two polls.

## Memory lessons this runbook holds

- **`--help` can execute** (fleet-wide lesson) — never run any step above
  with `--help` to "check" it first.
- **A drain or an end never kills a running job or process.** `--remove`
  only proceeds once the scheduled end has actually passed, and it reads
  back what survived rather than trusting its own teardown script —
  `remove-incomplete` is the expected result of a partial failure, not an
  error to work around.
- **2026-10-28, cardtable's demand flapped 2 → 1 → 2 within 14 minutes.**
  The converger had removed claw-9 36 seconds past its scheduled end and
  declared claw-5 to make up the count before the demand came back; the
  `YOUNG_SLICE_MS` guard (step 5) is what stops the very next pass ending
  the node that was just given back.
- **Plan drift, found writing this runbook:** `docs/planning/refactor-plan
-2026-10-28.md` §5.3/§5.4 describe "no `releaseOrder`" as an open gap for
  R11. Reading the current code (`scripts/lib/hosting-demand.mjs`,
  `scripts/lib/hosting-converge.mjs`'s `decide()`) and `docs/hosting.md`
  shows `--release-order` fully implemented and consumed by the converger's
  shrink path today — the plan appears to predate, or was not updated after,
  `0b0d3d1`/`72a3782` landing it. Step 5 above documents the CURRENT,
  working behaviour; the tracker should reconcile the plan doc separately.
