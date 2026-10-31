# R5 — hardware inventory: a part arrives, moves or dies

Scenario #5 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
**This is the public procedure. It names no part, serial, model or address**
— the data itself lives in `WolffM/hadoku-fleet-manager-private`, never in
this repo, and this file stays correct precisely because it has nothing of
that kind to go stale. The `inventory` skill (`.claude/skills/inventory/`)
is the same procedure written for an agent to follow directly; this runbook
is its human-readable twin, per `docs/planning/refactor-plan-2026-10-28.md`
§5.2's "runbooks double as agent skills."

Feeds `docs/runbooks/replace-claw.md` (R2, "move the inventory record" when
a node dies and its parts are redistributed) and
`docs/runbooks/hardware-change.md` (R4, every step that changes a part).
Run this runbook from inside one of THOSE two when a physical change is
already under way; run it on its own when a part arrives or dies with no
node-side change attached (a shipment, a part failing on the shelf).

## Preconditions

- A checkout of the private repo, or this checkout with
  `bash scripts/attach-private.sh` already run — AGENTS.md's "attach the
  private repo once per clone and per worktree." Without it,
  `docs/planning/inventory/` does not exist here, and nothing below is
  reachable.
- **The file is only as current as its last read.** Before relying on it to
  decide whether a part is free or fits, read the box (step in each
  scenario below), not the file alone — a part can be "found" free that was
  actually installed weeks ago by someone who forgot to write it down.

## Scenario A — a part arrives

1. **Confirm what it is and whether it fits anything.** Where: wherever the
   part physically is. As: whoever received it.
   `spec` decides fit — DDR3, DDR4 and DDR5 are keyed differently from each
   other, and UDIMM (desktop), SODIMM (laptop) and RDIMM (server) do not
   interchange even within the same DDR generation. Some claws have
   soldered RAM and cannot take a stick at all, fit or not.
   Verify: n/a — this is a judgment call the next step's record-keeping
   depends on, not something a command checks.

2. **Add it to the shelf.** Where: in the private checkout
   (`docs/planning/inventory/parts.json`, at the same relative path once
   attached). As: whoever maintains the parts record.
   Add one row: `location: "shelf"`, its spec, and a `history` entry noting
   where it came from and when. Commit it there — never in this checkout,
   and never through this repo's git history (`AGENTS.md`: "docs/planning …
   commit it THERE").
   Verify: `jq '.parts[] | select(.location == "shelf")'` against the
   private file lists the new row.

## Scenario B — a part moves (shelf → node, node → shelf, or node → node)

A physical move and a record update happen in the SAME visit. The install
checklist belongs to whichever runbook sent you here —
`docs/runbooks/hardware-change.md` (R4) for a live node, or
`docs/runbooks/replace-claw.md` (R2) for a dead one's parts moving into its
replacement.

1. **Make the physical move.** Where: at the node(s) involved. As: whoever
   is doing the work. Covered by R2 or R4's own steps, not restated here.

2. **Update the row.** Where: in the private checkout
   (`docs/planning/inventory/parts.json`). As: whoever maintains the parts
   record.
   Edit the part's existing row — `location`, `slot`, `condition`, and
   append a `history` entry — rather than deleting and re-adding it, so the
   part's full history stays on one row. Commit it there.
   Verify: the row's `location` now names the destination (a node name, or
   `shelf`), and its `history` has a new entry; the SOURCE location (the
   node it left, or the shelf) no longer lists it.

3. **Re-measure from the node, not the sticker.** Where: control host. As:
   `fleet benchmark` and `fleet bootcamp` each connect over ssh on their
   own.
   Command:

   ```
   fleet benchmark <node> --write
   fleet bootcamp --machine <node> --write
   ```

   A part does not leave the shelf, in the sense that matters to the fleet,
   until the node's OWN measurement says it is there. A manifest row and a
   parts-record row can both claim a part is installed while nothing
   schedules around it, if nothing ever re-measured.
   Verify: `fleet doctor <node>` shows a fresh record; for a RAM or core
   change specifically, continue into `docs/runbooks/hardware-change.md`'s
   `enroll --update` and `maxConcurrent` review steps — this runbook stops
   at the inventory record, that one covers the manifest.

4. **Cross-check the box against the file.** Where: control host, over
   ssh. As: `admin` (the claws carry passwordless sudo for this; hokon does
   not — an operator runs it there by hand).
   Command:

   ```
   ssh <node> 'sudo -n dmidecode -t memory; lsblk -dno NAME,MODEL,SERIAL,SIZE,ROTA,TRAN; lspci | grep -iE "vga|3d"'
   ```

   Compare INSTALLED RAM against what the row now claims, not against
   `MemTotal` — the kernel reserves some of it, so a 16 GB stick reports
   under 16 GB of total memory even when nothing is wrong.
   Verify: what the box reports matches the row just written. A mismatch
   means the row is wrong, the wrong node was touched, or the wrong part was
   pulled — resolve which before moving on, not after.

## Scenario C — a part dies

1. **Confirm it is actually the part, not the node around it.** Where: at
   the node, or reasoned about remotely if the node itself is still
   partially reachable. As: whoever is diagnosing it.
   If the node itself is unreachable and staying that way, this is
   `docs/runbooks/replace-claw.md` (R2), which has its own step for sorting
   survivors from scrap before this scenario runs on what is left.
   Verify: n/a.

2. **Record it as dead, not as removed.** Where: in the private checkout
   (`docs/planning/inventory/parts.json`). As: whoever maintains the parts
   record.
   Set `condition` to reflect the failure and append a `history` entry
   naming when and how it was found dead; change `location` to `shelf`
   only if the physical part is actually coming out and going somewhere a
   future reader could trip over it — a dead part left installed (common
   for a cooler or a drive nobody has pulled yet) stays at the node's
   location with its condition saying why it should not be trusted.
   Verify: the row no longer reads as a healthy, available part at its
   location — `jq` against the private file should show the new
   `condition`, not just a `history` entry nobody who skims the summary
   field would see.

3. **If something now needs replacing, hand off.** A dead RAM stick, disk,
   GPU or cooler on an otherwise-live node is
   `docs/runbooks/hardware-change.md` (R4); a dead node is
   `docs/runbooks/replace-claw.md` (R2). This runbook's job ends at the
   inventory record.

## Rollback

- A row edited in error (scenario B or C): edit it back, but APPEND a
  correcting `history` entry rather than deleting the mistaken one — the
  row's history is the audit trail for "why does this say what it says,"
  and a silently edited history is the one thing that breaks that trail.
- A part logged as arrived (scenario A) that turns out to be the wrong
  part, or never actually arrived: remove the row only if nothing else has
  referenced it yet (no node's `history` points at it); otherwise correct
  it in place with a `history` entry, for the same reason as above.

## Enforced by

- `scripts/lib/publish-safety-guard.test.mjs` — `docs/planning/` (where the
  private checkout's data lives once attached) is not merely unscanned, it
  is BANNED from this repo: a tracked file under it, or the attach
  symlink itself committed with `git add -f`, fails the build. This is
  what keeps this runbook's own promise — "no part, serial or address
  here" — true of the rest of the public tree too.
- Nothing else. The parts record itself has no gate: it is human-maintained
  data in a repo with its own issue tracker and no CI that reads
  `parts.json`. A row that drifts from the box is caught only by scenario
  B's step 4 (cross-check) or scenario C's own diagnosis, not by anything
  running on a schedule.

## Memory lessons this runbook holds

- **The inventory data lives in the private repo and nowhere else** — this
  repo holds the procedure, never a row.
- **The box is the authority, not the file** — a part is not "installed," in
  the sense the fleet schedules around, until a node's own measurement
  (`fleet benchmark --write` / `fleet bootcamp --write`) says so; the parts
  record and the manifest can both be wrong in the same direction at once if
  nothing ever re-measures.
- **Compare installed RAM, not `MemTotal`** — a 16 GB stick reports under
  16 GB of total memory; reading the gap as a missing or faulty stick is a
  false alarm the kernel's own reservation explains.
- **DDR generation and module form factor both have to match** — fit is not
  "will it physically go in the slot."
