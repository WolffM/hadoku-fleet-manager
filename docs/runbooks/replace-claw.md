# R2 — replace a claw (dead hardware)

Scenario #2 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
**No command exists for "replace" as its own verb**, and none is planned as
one: the catalogue's own gap note says what this runbook is — "Names are
immutable → `claw-N+1`, then R3 for the old one. Inventory moves." R2 is the
ORDER two already-written runbooks run in, plus the two facts that make
"replace" a different scenario from "retire, then separately enroll
something":

1. **The name is never reused.** The replacement is the next integer after the
   highest one any claw has ever carried, dead or alive — never the dead
   node's own name again, and never a gap filled in.
2. **Nothing the dead node earned follows it.** A capability label, a
   benchmark figure, a health record — every one is keyed by node name and
   starts at nothing for the new name, even when the physical part that
   earned it (a GPU, say) moves into the new chassis unchanged.

Every `fleet …` command below is checked against `src/cli.ts`'s door table by
`scripts/lib/onboarding-docs.test.mjs`.

## Preconditions

- **Confirmed dead, not merely unresponsive.** If any path to the box still
  exists — a console, a power button, a boot history worth checking — rule
  those out first. `journalctl --list-boots` first: a forced restart that
  never completed looks identical to dead hardware from the network side
  alone (memory `force-restart-is-power-off`). Replacing a node that was only
  sleeping burns a name for nothing, because names are never reused.
- **The replacement's name decided now**, before step 1 below: `claw-N+1`,
  where N is the highest number ANY claw has ever carried — not the highest
  one currently declared. A name retired months ago is not available again
  (see the Gap below).
- **A decision on which of the dead box's parts survive into the
  replacement** (RAM, disk, GPU, cooler) versus return to the shelf or get
  scrapped, recorded before the carcass is opened — `docs/runbooks/inventory.md`
  needs this decision, not a reconstruction of it afterward.

## Steps

1. **Retire the dead node.** Where/As/Command: run
   `docs/runbooks/retire-node.md` (R3) against the dead node's CURRENT name,
   start to finish. None of R3's steps need the dead box's own cooperation —
   drain, deregistration and the manifest edit all act from the control host
   or against GitHub's API, so a genuinely dead node does not stall any of
   them.
   Verify: R3's own per-step verifies, and in particular its step 4's —
   `fleet node-status` no longer lists the old name at all. The old name must
   be fully gone before step 2, or the new node's coverage math runs against a
   roster that still thinks the dead box exists.

2. **Bring up the replacement under the NEXT name.** Where/As/Command: run
   `docs/runbooks/new-claw.md` (R1) start to finish, naming the new box
   `claw-N+1` at R1's step 1 (the installer's hostname prompt) — never the
   dead node's old name, even when the hardware is physically sitting in the
   same rack slot moments later.
   Verify: R1's own step 9 (`fleet traffic` shows the new name as a
   candidate, or `fleet doctor <new-name>` shows a fresh record) — and that
   `fleet node-status` lists exactly the new name, never the old one and
   never both.

3. **Confirm nothing the dead node earned followed it.** Where: control
   host. As: read-only.
   Command: `fleet node-status --json <new-name>` once R1's provisioning has
   finished, and `fleet capabilities --machine <new-name>` for its labels.
   Why this is a step, not just an observation: `$capabilities`, `$benchmark`
   and `$health` are three independently-provenanced facets on the manifest
   entry, each written by its own command (`bootcamp --write`,
   `benchmark --write`, `doctor --write`), and a FRESH name starts every one
   of them at nothing. R1 step 8 (`provision --confirm`) EARNS labels by
   executing each probe on the new hardware; there is no copy path from an
   old entry to a new one, even for a part that moved unchanged — a disk that
   benchmarked at a given throughput on the dead node is re-measured on the
   new one, never assumed.
   Verify: the new node's `$capabilities`/`$benchmark`/`$health` carry
   timestamps from THIS onboarding. A label the dead node held is present
   only if the new hardware proved it again under R1 step 8 (see
   `docs/runbooks/hardware-change.md`'s capability step for what re-earning
   looks like when just one part moves without a full R1 pass).

4. **Move the inventory record.** Where: wherever the `inventory` skill's
   backing data lives (the private repo — this is NOT `fleet inventory`,
   which is the workflow → runner blast-radius gate, a different thing with
   the same word). As: whoever maintains the parts record.
   Command: follow `docs/runbooks/inventory.md`'s "a part moves between
   nodes" procedure for every part carried over per this runbook's
   Preconditions, and its "a part dies" procedure for whatever stays in the
   dead box.
   Verify: the `inventory` skill shows the carried-over parts filed under the
   NEW node's name, and the dead node holding nothing.

## Rollback

- Before step 2 starts: the old node is retired and nothing new is declared.
  R3's own rollback guidance applies if retirement itself needs reversing
  (only possible before R3's step 4).
- During step 2 (R1 not yet at its own point of no return): R1's own
  rollback applies — abandon the declared-but-unconverged `claw-N+1` by
  removing its manifest entry. This does **not** free the name `claw-N+1` for
  a second attempt, by the same immutability rule that put it there; the next
  attempt is `claw-N+2`.
- After step 2 completes: the replacement is now a normal node. Reverting it
  is R3's job (if it too must come out) or R4's (if something about it needs
  correcting), not R2's.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command above
  exists in the door's table, same as R1 and R3.
- Everything R1 and R3 are each individually enforced by, since this runbook
  is their composition and adds no new mutating command of its own.

## Memory lessons this runbook holds

- **Node names are immutable, restated for the replace case specifically**:
  a dead `claw-5` is replaced by the next number, never a second `claw-5`,
  even though the old entry is long gone from the manifest by the time the
  replacement is declared.
- **Nothing a retired node earned applies to its replacement** — not a
  capability label, not a benchmark figure, not a health record — even for
  identical hardware moved into the same chassis (step 3).
- **`journalctl --list-boots` first** — before spending a replacement name on
  a box that was only unresponsive.

## Gap

Nothing checks a proposed name against every claw that has EVER existed,
only against what is currently declared: the manifest entry for a retired
name is gone by the time this runbook reaches step 2, so nothing refuses
typing it again. This is not in `refactor-plan-2026-10-28.md` §5.4's table,
so no engineering is scheduled to close it; until something is, this
runbook's Precondition ("decided now, before step 1") is the only guard.
