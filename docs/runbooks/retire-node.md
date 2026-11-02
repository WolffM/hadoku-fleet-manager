# R3 — retire a node

Scenario #3 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
**`fleet retire <node>` composes steps 3, 4 and 6 below** (wave 5m lane A):
drain-check, deregister, the manifest edit and the retired-name ledger, and a
facet archive, in one command. It is a DRY RUN unless you pass `--confirm`;
run it without `--confirm` first and read the plan it prints. Steps 1–2, 5 and
7 still stand on their own — `fleet retire` neither replaces the drain
decision nor touches the tailnet or the hardware inventory.

Use this when hardware dies or is decommissioned — not for a temporary
outage (use `fleet drain --kind maintenance` alone and undo it later) and not
for lending a node to a tenant (that is `fleet hosting`, see
`docs/hosting.md`).

**Node names are immutable.** Retiring `claw-N` does not free the name
`claw-N` for reuse; its replacement, if any, is `claw-N+1` (see R1's
Preconditions, and the memory note `node-names-immutable`). This runbook
retires the node; it does not provision its replacement — that is R1.
`fleet retire --confirm` adds the name to the manifest's `retired` array in
the SAME write that removes `machines.<node>`, and `fleet enroll` refuses any
name on that list before it probes anything — the gap R2 used to name
("nothing checks a proposed name against every claw that has EVER existed")
is closed as of this ledger.

Every `fleet …` command below is checked against `src/cli.ts`'s door table by
`scripts/lib/onboarding-docs.test.mjs`.

## Preconditions

- The node's name and current role (claw, pm2-host, hosting node) confirmed —
  `fleet node-status` lists every node the fleet currently knows about.
- Nothing load-bearing still assumes this node: check `fleet hosting` (is it
  lending anything to a tenant right now) and `fleet backstop --status` (is
  it the standing backstop) before starting. `fleet retire` itself refuses a
  node `fleet hosting` still has a live record for; it does not check the
  backstop.

## Steps

1. **Drain it — soft-close, no `--for`/`--at`.** Where: from the control
   host. As: `fleet drain` connects as `admin`.
   Command:

   ```
   fleet drain <node> --kind maintenance --reason "retiring — see docs/runbooks/retire-node.md"
   ```

   No end time: a retiring node should never silently resume taking jobs
   because a lease expired. You can skip this step: `fleet retire <node>
--confirm` drains the node itself, under the SAME reason, if nothing has
   drained it yet — but it then REFUSES to go any further that run, because a
   drain is a soft close and finishing work takes its own time. Re-run
   `fleet retire <node> --confirm` once the node is quiet.
   Verify: `fleet drain --status` shows `<node>` drained; `fleet drain-check`
   does not flag it as drained-but-unenforced.

2. **Confirm it has actually stopped taking work.** Where: from the control
   host. As: read-only.
   Command: `fleet traffic` (the next-placement explainer) should no longer
   consider `<node>` a candidate.
   Verify: run it twice, a few minutes apart, and confirm `<node>` does not
   appear either time — a drain that only blocks NEW admission can still
   leave a job that was already assigned in flight. `fleet retire` makes the
   same check itself (the same `drainStatus` verdict `fleet drain --status`
   reads, plus a scan of EVERY registration the node holds, not only a
   warm/JIT one) before it deregisters anything.

3. **Deregister its runners.**

   ```
   fleet retire <node> --confirm
   ```

   This scans every covered repo for a registration `nodeOf` attributes to
   `<node>` — standing, warm or JIT alike, not only a repo-level orphan — and
   removes each one through the same path `fleet reconcile`'s own orphan
   removal uses (`removeScript`, with the REST-API-by-id fallback for a
   renamed repo). A single failed removal STOPS the command before step 4:
   nothing is left half-retired. If you need to do this by hand instead —
   `gh api -X DELETE repos/<owner>/<repo>/actions/runners/<runner-id>` per
   registration (`fleet node-status --json` under the node's entry, or the
   manifest's `residentRepos`/roster for an all-JIT claw) — but `fleet retire`
   is the one path that also updates the manifest and the ledger in the SAME
   run, so a hand run should be the exception, not the default.
   Verify: GitHub's repo settings → Actions → Runners no longer lists the
   node for any repo it held.

4. **Remove it from the manifest, and regenerate coverage.** The SAME
   `fleet retire <node> --confirm` call above removes `machines.<node>` and
   adds `<node>` to the retired-name ledger (the manifest's `retired` array)
   through `manifestEdit` — one atomic write, committed to the live manifest's
   home (the `hadoku_site` checkout — see this repo's `AGENTS.md`, "that
   hadoku_site copy is the live one"). Then regenerate coverage from the
   shrunk roster:

   ```
   fleet reconcile --write-coverage
   ```

   `fleet retire` prints this as a remaining step rather than running it
   itself — coverage is a repo roster, not a per-node record, and
   regenerating it is this package's own existing command, not something
   worth composing into a second one. If this is a small fleet and removing
   one node drops the roster by more than half, the write refuses unless you
   add `--allow-shrink` — read why it refused before passing it; that
   refusal exists to catch a manifest read error presenting as a mass
   departure, not to be routinely overridden.
   Verify: `fleet reconcile --check-coverage` reports clean against the new,
   smaller roster; `fleet node-status` no longer lists `<node>`.

5. **Tailnet removal.** GAP, operator-only (manual by design: this repo does
   not hold tailnet admin credentials — see the ownership
   boundaries in this repo's `AGENTS.md`). Where: the Tailscale admin console.
   As: the operator, directly — not through any `fleet` command. `fleet
retire` prints this as a remaining step; it cannot do it for you.
   Remove the node's device from the tailnet (or let its key expire if it is
   tagged for auto-expiry; claws are tagged not to expire, so this is
   normally an explicit removal — see the memory note
   `tailscale-fleet-tagging`).
   Verify: the node no longer appears in the tailnet admin console's device
   list.

6. **Archive its facets.** The SAME `fleet retire <node> --confirm` call
   copies the node's `$benchmark`/`$health`/`$proof` blocks out of the state
   dir's `benchmark.json`/`health.json`/`proof.json` into one archive file
   (`<stateDir>/retired-facets.json`), THEN removes them from the live files
   — archive first, so a failure between the two steps leaves a harmless
   duplicate rather than losing the record. Best-effort: a facet file it
   cannot safely read (unreadable or malformed) is left untouched and named
   as a warning, never a reason to fail the rest of the retirement.
   Verify: n/a — this step is informational, not enforced, same as before
   `fleet retire` existed.

7. **Update the hardware inventory.** Where: wherever the `inventory` skill's
   backing data lives (private repo; this is NOT `fleet inventory`, which is
   the workflow→runner blast-radius gate — a different thing with the same
   word). As: whoever maintains the parts record. `fleet retire` prints this
   as a remaining step; it cannot do it for you.
   Record the node's parts (RAM, disks, GPU, cooler) as returned to the
   shelf, or as scrapped, per R5 (`docs/planning/refactor-plan-2026-10-28.md`
   §5.3).
   Verify: the `inventory` skill no longer lists the retired node as holding
   those parts.

## Rollback

- Steps 1–2 (drain only, including a drain `fleet retire --confirm` itself
  wrote): `fleet drain <node> --undo` restores it to service immediately.
  Nothing else has changed yet.
- A FAILED `fleet retire --confirm` (a deregistration that stopped) leaves
  the node declared and drained, same as if you had stopped by hand after
  step 3 — re-registering is `fleet provision --machine <node> --confirm`,
  or re-running `fleet retire <node> --confirm` once the failure is fixed.
- Once `fleet retire --confirm` lands its manifest edit (step 4): there is no
  undo short of re-running R1 from enrollment under the NEXT name — the node
  is no longer declared, its name is on the retired-name ledger, and a
  removed manifest entry is not reconstructed from memory. This is why steps
  1–3 happen FIRST, while the decision is still cheap to reverse, and why
  `fleet retire` stops at the first failed deregistration rather than editing
  the manifest around it.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command above
  exists in the door's table.
- `scripts/lib/publish-safety-guard.test.mjs` — this file names no address,
  MAC, tailnet name, or other site fact; it never will, because it is public.
- `fleet drain-check` (nightly) — catches a drain from step 1 that was never
  actually enforced.
- `fleet reconcile --check-coverage` (nightly) — catches a manifest edit
  from step 4 that coverage was never regenerated against.
- `fleet enroll`'s refusal of any name on the manifest's `retired` array —
  catches a replacement accidentally declared under the old name (R2's Gap).

## Memory lessons this runbook holds

- **Node names are immutable** — see the callout above; this is the single
  most consequential fact a retirement runbook can get wrong, and it is now
  enforced by the ledger rather than only stated here.
- **`journalctl --list-boots` first** — if the "dead hardware" prompting
  this retirement is actually just unresponsive, check boot history before
  concluding it is gone for good; a forced restart that never completed
  looks identical to dead hardware from the network side alone.
- **`--help` can execute** — never run any step above with `--help` to
  "check" it first; read the script's own header.
- **Tailscale tagging** — claws are tagged not to expire on their own, which
  is exactly why step 5 cannot be skipped in favour of "it'll time out."
