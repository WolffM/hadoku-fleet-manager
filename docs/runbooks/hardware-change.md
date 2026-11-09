# R4 — hardware change on an existing node (RAM, disk, GPU, cooler)

Scenario #4 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
For a node that is still alive and keeping its name — swapping a part, not
replacing the box. A dead node is `docs/runbooks/replace-claw.md` (R2); a node
coming out of service for good is `docs/runbooks/retire-node.md` (R3).

The shared frame is drain → change → re-measure → re-earn → review the
safety ceiling → undrain. Which of the middle steps apply depends on WHICH
part changed — a disk swap on the ROOT drive is a reimage, not a refresh, and
that is the one branch below that is not "run a command and read the
number."

Every `fleet …` command below is checked against `src/cli.ts`'s door table by
`scripts/lib/onboarding-docs.test.mjs`.

## Preconditions

- The node is reachable and can be drained cleanly before you touch it. If
  it is not reachable at all, this is R2 or R3, not R4.
- Which hardware is changing is decided before step 1: RAM, a non-root disk,
  the root disk, a GPU, or a cooler. More than one may apply in the same
  visit; run every branch that applies.
- The part itself is already logged in the private inventory as "about to
  move," per `docs/runbooks/inventory.md`, so the parts record and the
  physical change happen in the same visit instead of drifting apart.

## Steps

1. **Drain it.** Where: control host. As: `fleet drain` connects as `admin`.
   Command:

   ```
   fleet drain <node> --kind maintenance --reason "hardware change: <what> — see docs/runbooks/hardware-change.md"
   ```

   Verify: `fleet drain --status` shows `<node>` drained, and job history
   carries no run on it since.

2. **Confirm it is actually idle before opening the case.** Drain blocks NEW
   admission; it does not abort work already in flight. Where: control host.
   As: read-only.
   Command: `fleet traffic --live` (the `--live` flag ssh's each node for its
   real running-job count, rather than the cached figure the plain form
   shows).
   Verify: `<node>`'s busy count reads 0. If it does not, wait — do not open
   the case on a node that still has a job running on it.

3. **Make the physical change.** Where: at the node, console or hands-on.
   As: whoever is doing the work.
   No `fleet` command touches hardware; this step is manual by nature, not
   by gap. If the change involves identifying or mounting a specific disk —
   whether to image it, check SMART, or just confirm which one you are about
   to pull — use its UUID or `/dev/disk/by-id/…` path, never a bare `sdX`
   letter. Device letters are assigned at boot and are not stable across
   reboots or across which disk the controller enumerates first (memory
   `claw-9-disk-letters-swap`); assuming a letter stays put is how the wrong
   disk gets touched.
   Verify: n/a — this step has no fleet-side check. The next step is where
   the fleet first sees the change.

4. **Re-measure and re-earn — the branch depends on what changed.**

   **RAM or CPU core count.** Where: control host. As: `fleet enroll`
   connects as `admin`.

   ```
   fleet enroll <node> --update
   ```

   Run it with no other flags first. `--update` compares the node's
   bootstrap-time record against a fresh re-probe and REFUSES on a
   mismatch in `memTotalKb` or `cores` — which, right after a RAM or CPU
   swap, is exactly what you expect it to do. The refusal naming the
   mismatch is this step's confirmation that the change registered, not an
   error to work around.

   ```
   fleet enroll <node> --update --hardware-changed memTotalKb,cores --reason "<what changed, and when>"
   ```

   This accepts the named field(s) and records `from`, `to`, the reason and
   a timestamp in `$measured.hardwareChanges` — a RAM upgrade is "a known
   hardware change," never a `--force`; nothing is bypassed, the change is
   named. `--update` never touches labels, capacity (`maxConcurrent`,
   `minFreeMb`) or `excludeRepos` — those are step 6, deliberately separate.
   Verify: re-run `fleet enroll <node> --update` a third time with no
   `--hardware-changed` — it should now report no drift, because the
   accepted figures are what the next re-probe measures too.

   **A non-root disk** (scratch, a second drive that is not where the OS
   lives). Nothing in the manifest names a disk directly beyond
   `diskFreeGb`, which `enroll` refreshes silently on every run — no refusal,
   no flag needed. Skip to the benchmark step below; a disk swap shows up
   there, in the I/O timings, not in `enroll`'s output.

   **The root disk.** This is a REIMAGE, not a refresh: the OS that was
   converted and enrolled is gone with the old drive. Re-run
   `docs/runbooks/new-claw.md` (R1)'s steps 1 through 4 against this SAME
   node name — install, convert, reboot + Tailscale, capture — except at
   step 4, use `fleet enroll <node> --update` in place of `--write` (the
   node is already declared; `--update` is what refreshes an existing entry
   without the "ALREADY in the manifest" refusal). Then repeat R1's steps 5
   and 6 (the node-users cutover if this node carries one, then
   `provision --confirm`, which also re-runs the toolpack) to re-earn everything a fresh root disk has no
   copy of. Nothing from before the swap — capabilities, caches, home
   toolchains — survives onto the new disk; `provision` re-derives all of
   it exactly as it would for a brand-new box, because to the filesystem,
   it is one.
   Verify: R1's own step 6 verify (`fleet provision --machine <node>
--verify-only` reports every step converged).

   **A GPU.** Nothing declares a GPU capability by hand — `av1-nvenc` /
   `nvenc-h264` and similar are EARNED labels, probed by executing the
   capability, never typed into the manifest (memory
   `label-revocation`: a probe that FAILS withholds the label until a PASS
   clears it). Removing a GPU needs no step here: the next scheduled probe
   fails and the label drops on its own. Adding one needs step 5 below
   (`fleet bootcamp --write`) to prove it before anything routes to it.

   **A cooler.** Nothing in the manifest names a cooler either. What
   changes is the node's actual thermal behaviour, which is read by
   `fleet doctor`, not declared anywhere — run it after the swap (step 5)
   and feed the result into step 6's `maxConcurrent` review: a cooler fix
   may remove the exact thermal reason a ceiling was lowered in the first
   place, and a cooler that is still marginal argues for leaving it alone.

5. **Re-benchmark and re-bootcamp.** Where: control host. As: `fleet
benchmark` and `fleet bootcamp` each connect over ssh on their own — a
   privileged attempt first, falling back to unprivileged — and `bootcamp`
   installs as `ci` where the instrument it is proving is CI-scoped.
   Command:

   ```
   fleet benchmark <node> --write
   fleet bootcamp --machine <node> --write
   ```

   Run both regardless of which part changed — `benchmark` is where a disk
   swap's I/O numbers and a cooler swap's thermal headroom actually show up,
   and `bootcamp` is where a GPU gain or loss is proved rather than assumed.
   A node earns nothing by having a part installed; it earns it by a probe
   executing against it.
   Verify: `fleet doctor <node>` shows a fresh, clean record;
   `fleet capabilities --machine <node>` lists the label gained (if the
   change added one) or no longer lists one that depended on a part now
   removed.

6. **Review `maxConcurrent` (and `minFreeMb`) as a SAFETY decision, not
   tuning.** Where: in the `hadoku_site` checkout (the live manifest's home
   — see this repo's `AGENTS.md`, "that hadoku_site copy is the live one").
   As: `admin` (the manifest is operator config, not CI-writable — the
   same boundary `docs/runbooks/retire-node.md`'s step 4 crosses).
   **No `fleet` command does this** — `enroll --update` (step 4) deliberately
   leaves capacity untouched, because what a safe ceiling is after a
   hardware change is a judgment call, not a derivation from one
   measurement. More RAM may raise the safe ceiling; a cooler fix may lift
   a THERMAL cap that had nothing to do with RAM at all; a bigger-draw GPU
   can argue for lowering it even when nothing else moved. The same
   floor/concurrency arithmetic `enroll` uses when a node is FIRST declared
   (`floor = MemTotal/8`, clamped to 1536–8192 MB; `concurrency =
min(4, floor((MemTotal-floor)/4096))`) is a reasonable starting point
   after a RAM change specifically — recomputed from step 4's freshly
   measured `MemTotal`, never from the RAM stick's nameplate size — but it
   is a starting point, not an answer; thermal and job-mix history can
   argue for holding the ceiling below what capacity alone would allow.
   The 16 GB heavy-job routing rule is a related but SEPARATE decision —
   whether this node is now eligible for memory-hungry jobs at all —
   re-derived from step 5's FRESH benchmark by `fleet benchmark-join`
   (its Q3 section), never from memory or a stale manifest note.
   Command: hand-edit `machines.<node>.maxConcurrent` (and `minFreeMb` if
   the RAM floor moved) in
   `hadoku_site/scripts/admin/fleet-runner-manifest.json`, commit, push.
   Record the reasoning in that node's `$why` field — there is no gate that
   will remind a future reader why the number is what it is.
   Verify: `fleet traffic --json` shows `<node>`'s new `maxConcurrent`.

7. **Undrain it.** Where: control host. As: `admin`.
   Command: `fleet drain <node> --undo`
   Verify: `fleet drain --status` no longer lists `<node>`; `fleet traffic`
   considers it a candidate again.

8. **Update the hardware inventory.** Where: wherever the `inventory`
   skill's backing data lives (the private repo — not `fleet inventory`,
   the workflow → runner blast-radius gate). As: whoever maintains the
   parts record.
   Follow `docs/runbooks/inventory.md`'s "a part arrives" or "a part moves"
   procedure for the part just installed, and its "a part dies" procedure
   for whatever came out.
   Verify: the `inventory` skill shows the part under `<node>`, not on the
   shelf and not under whatever node it came from.

## Rollback

- Before step 4 (RAM/CPU branch not yet run, or root-disk reimage not yet
  started): `fleet drain <node> --undo` returns the node to service on its
  OLD numbers if the change does not proceed — nothing fleet-side has
  changed yet.
- After step 4 but before step 6 (capacity not yet reviewed): safe to leave
  — a stale-low ceiling under-uses new capacity but never over-commits a
  node. There is no urgency, but record in the manifest's `$why` that the
  review is still pending, so it is not mistaken for a decision already
  made.
- After step 6: reversing it is the same hand-edit in the other direction;
  there is no automated undo because there was no automated application.
- Mid-reimage (root-disk branch, after R1 steps 1–4 but before step 6
  completes): this is now R1's own rollback — a declared-but-unconverged
  node (still under its OLD name here, since this is a reimage, not a
  replacement) does not receive jobs; continue the chain or leave it drained
  until you do.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command above
  exists in the door's table.
- `scripts/lib/publish-safety-guard.test.mjs` — this file names no address,
  MAC, tailnet name, serial or other site fact.
- `fleet reconcile --check-coverage` (nightly) and `fleet toolchain` — catch
  drift left behind by an incomplete root-disk reimage.
- **Nothing** catches a `maxConcurrent` left stale after a hardware change —
  deliberately, since forcing that review would turn a safety decision into
  a gate's guess. The `$why` note in step 6 is this runbook's only defence
  against forgetting the review happened, or that it didn't.

## Memory lessons this runbook holds

- **The 16 GB heavy-job rule** — a routing decision about which nodes are
  eligible for memory-hungry work, re-derived from a FRESH benchmark
  (`fleet benchmark-join`'s Q3), never read off memory or a stale note
  (step 6).
- **Disks by UUID or `/dev/disk/by-id/…` only, never a bare `sdX` letter** —
  letters are assigned at boot and swap (memory `claw-9-disk-letters-swap`;
  step 3).
- **`maxConcurrent` is the node's only per-node ceiling, thermal included,
  and changing it is a safety decision, not tuning** — never derived
  automatically from a hardware change, and never left unreviewed without a
  note saying so (step 6).
- **A capability is earned by executing the probe, never by having the part
  installed** — a GPU gain needs `fleet bootcamp --write` to prove it; a GPU
  loss drops its label on the next probe's FAIL without any action here
  (step 4, 5; memory `label-revocation`).
- **A root-disk swap is a reimage, not a refresh** — nothing from before it
  survives onto the new disk, and the correct response is R1's own chain
  run again against the same name, not `enroll --update` alone.
- **`--help` can execute** — never run any step above with `--help` to
  "check" it first; read this runbook or the script's own header instead.
