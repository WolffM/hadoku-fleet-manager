# R3 — retire a node

Scenario #3 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
**No "fleet retire" command exists yet** (plan §5.4: sized M, phase P5a,
"composes existing drain/deregister/manifest-edit; waits on F4"). Every step
below marked **GAP** is manual today and is exactly what that future command
will compose; the rest already have a `fleet` command, used here as a VERIFY
step or as part of the sequence.

Use this when hardware dies or is decommissioned — not for a temporary
outage (use `fleet drain --kind maintenance` alone and undo it later) and not
for lending a node to a tenant (that is `fleet hosting`, see
`docs/hosting.md`).

**Node names are immutable.** Retiring `claw-N` does not free the name
`claw-N` for reuse; its replacement, if any, is `claw-N+1` (see R1's
Preconditions, and the memory note `node-names-immutable`). This runbook
retires the node; it does not provision its replacement — that is R1.

Every `fleet …` command below is checked against `src/cli.ts`'s door table by
`scripts/lib/onboarding-docs.test.mjs`.

## Preconditions

- The node's name and current role (claw, pm2-host, hosting node) confirmed —
  `fleet node-status` lists every node the fleet currently knows about.
- Nothing load-bearing still assumes this node: check `fleet hosting` (is it
  lending anything to a tenant right now) and `fleet backstop --status` (is
  it the standing backstop) before starting.

## Steps

1. **Drain it — soft-close, no `--for`/`--at`.** Where: from the control
   host. As: `fleet drain` connects as `admin`.
   Command:

   ```
   fleet drain <node> --kind maintenance --reason "retiring — see docs/runbooks/retire-node.md"
   ```

   No end time: a retiring node should never silently resume taking jobs
   because a lease expired.
   Verify: `fleet drain --status` shows `<node>` drained; `fleet drain-check`
   does not flag it as drained-but-unenforced.

2. **Confirm it has actually stopped taking work.** Where: from the control
   host. As: read-only.
   Command: `fleet traffic` (the next-placement explainer) should no longer
   consider `<node>` a candidate.
   Verify: run it twice, a few minutes apart, and confirm `<node>` does not
   appear either time — a drain that only blocks NEW admission can still
   leave a job that was already assigned in flight.

3. **Deregister its runners.** GAP (P5a composes this; today it is manual).
   Where: from the control host, or on the node itself if still reachable.
   As: `admin`.
   For each repo the node is registered against (`fleet node-status --json`
   under the node's entry, or the manifest's `residentRepos`/roster for an
   all-JIT claw), remove its registration:

   ```
   gh api -X DELETE repos/<owner>/<repo>/actions/runners/<runner-id>
   ```

   `scripts/reconcile-fleet-runners.mjs` does exactly this call internally
   (`removeScript`/the DELETE call beside it) when it recognizes a
   registration as orphaned; `fleet reconcile --confirm --remove-orphans`
   sweeps registrations for a repo that left the covered roster, which is
   close to this case but not the same one (that flag is scoped to
   REPO-level orphans, not a specific node) — do not rely on it alone for a
   single node's retirement until P5a folds this in.
   Verify: GitHub's repo settings → Actions → Runners no longer lists the
   node for any repo it held.

4. **Remove it from the manifest and coverage.** GAP (P5a composes this).
   Where: in the `hadoku_site` checkout (the live manifest's home — see this
   repo's `AGENTS.md`, "that hadoku_site copy is the live one"). As: `admin`
   (the manifest is operator config, not CI-writable).
   Delete the node's `machines.<node>` entry by hand, commit, and push —
   there is no `fleet` subcommand that removes a machine entry today; every
   existing writer (`enroll`, `bootcamp --write`, `provision`,
   `lan-reserve --write`) only ADDS or UPDATES one.
   Then regenerate coverage from the shrunk roster:

   ```
   fleet reconcile --write-coverage
   ```

   If this is a small fleet and removing one node drops the roster by more
   than half, the write refuses unless you add `--allow-shrink` — read why
   it refused before passing it; that refusal exists to catch a manifest
   read error presenting as a mass departure, not to be routinely overridden.
   Verify: `fleet reconcile --check-coverage` reports clean against the new,
   smaller roster; `fleet node-status` no longer lists `<node>`.

5. **Tailnet removal.** GAP, operator-only (manual by design: this repo does
   not hold tailnet admin credentials — see `docs/hokon-fleet-ownership`-style
   boundaries in this repo's `AGENTS.md`). Where: the Tailscale admin console.
   As: the operator, directly — not through any `fleet` command.
   Remove the node's device from the tailnet (or let its key expire if it is
   tagged for auto-expiry; claws are tagged not to expire, so this is
   normally an explicit removal — see the memory note
   `tailscale-fleet-tagging`).
   Verify: the node no longer appears in the tailnet admin console's device
   list.

6. **Archive its facets.** GAP (P5a composes this). Where: from the control
   host, reading the LIVE state dir (`~/.hadoku-mgmt` on the controller —
   read-only here, never write it by hand). As: `admin`.
   Before the node's entries age out of `benchmark.json`/`health.json`/
   `proof.json` on their own, copy the record somewhere durable if you want
   a historical reference (there is no fleet-side archive for a retired
   node's facet history today; `writeFacet`'s MERGE behaviour means a
   retired node's last-known record otherwise just sits there, unreferenced,
   until something prunes it).
   Verify: n/a — this step is informational, not enforced.

7. **Update the hardware inventory.** Where: wherever the `inventory` skill's
   backing data lives (private repo; this is NOT `fleet inventory`, which is
   the workflow→runner blast-radius gate — a different thing with the same
   word). As: whoever maintains the parts record.
   Record the node's parts (RAM, disks, GPU, cooler) as returned to the
   shelf, or as scrapped, per R5 (`docs/planning/refactor-plan-2026-10-28.md`
   §5.3).
   Verify: the `inventory` skill no longer lists the retired node as holding
   those parts.

## Rollback

- Steps 1–2 (drain only): `fleet drain <node> --undo` restores it to service
  immediately. Nothing else has changed yet.
- After step 3 (runners deregistered) but before step 4 (manifest edit):
  re-registering is `fleet provision --machine <node> --confirm` run again —
  the node is still declared, so this just re-runs the chain's later steps.
- After step 4 (manifest entry removed): there is no undo short of re-running
  R1 from enrollment — the node is no longer declared, and a removed manifest
  entry is not reconstructed from memory. This is why step 1–3 happen FIRST,
  while the decision is still cheap to reverse.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command above
  exists in the door's table.
- `scripts/lib/publish-safety-guard.test.mjs` — this file names no address,
  MAC, tailnet name, or other site fact; it never will, because it is public.
- `fleet drain-check` (nightly) — catches a drain from step 1 that was never
  actually enforced.
- `fleet reconcile --check-coverage` (nightly) — catches a manifest edit
  from step 4 that coverage was never regenerated against.

## Memory lessons this runbook holds

- **Node names are immutable** — see the callout above; this is the single
  most consequential fact a retirement runbook can get wrong.
- **`journalctl --list-boots` first** — if the "dead hardware" prompting
  this retirement is actually just unresponsive, check boot history before
  concluding it is gone for good; a forced restart that never completed
  looks identical to dead hardware from the network side alone.
- **`--help` can execute** — never run any step above with `--help` to
  "check" it first; read the script's own header.
- **Tailscale tagging** — claws are tagged not to expire on their own, which
  is exactly why step 5 cannot be skipped in favour of "it'll time out."
