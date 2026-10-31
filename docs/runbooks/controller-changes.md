# R14 — changing the controller box (hokon)

Scenario #14 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
No single command composes this one — it is a catalogue of the kinds of
change that are allowed on the controller, and the kinds that are not, because
the controller is not an ordinary fleet node.

## Why this box is different

The controller (`hokon` in this package's code and docs — see
`docs/VOCABULARY.md`) is two things at once:

- **It runs the fast loop and runner-health** — the process making every
  placement decision for the whole fleet runs here, today, always (see
  `docs/control-plane.md` §§1–3).
- **It is also declared in the manifest as a `guest`** (`role: "guest"`,
  `"mint": "on-demand"`) — a node the fleet BORROWS capacity from rather than
  owns. It lends a standing `pm2-host` registration, `taskauto`,
  `av1-nvenc`-labelled jobs, and — only while the backstop holds it —
  overflow `hadoku-builder` capacity. See `docs/control-plane.md` §6 and
  `docs/VOCABULARY.md` "The on-demand guest".

Being a guest is what makes every converger-shaped fleet command (`reconcile`,
`converge-provisioning`, `converge-toolchain`, `bootcamp`'s install path) skip
it by default: "the fleet does not decide its availability for it", and an
unattended install on the production box is the one mistake this skip exists
to prevent. The operator's standing rule (2026-10-09): probe and bootcamp it
freely, but ask before installing anything new, one capability at a time.
**Call it hokon or "the production box" when talking to the operator — never
"the guest".** The code's `role: 'guest'` is the mechanism, not the name.

## Preconditions

- You are not about to drain it for an ordinary change — a drain only removes
  it from `hadoku-builder` eligibility; `pm2-host`, `taskauto` and
  `av1-nvenc` work keep running regardless, so a drain does not make this box
  "safe" to change the way draining a claw does.
- For any install (step 3 below): the operator has named the EXACT capability
  first. Do not run that step speculatively.

## Steps

1. **Check what it can already do — read-only, no install.** Where: control
   host. As: the probe's own role (`ci` by default).
   Command:

   ```
   fleet capabilities --machine hokon --include-guests
   fleet toolchain --machine hokon --include-guests
   ```

   `--include-guests` is the one door every guest-touching command uses the
   same way: it does nothing by itself, and only opens the check when it is
   paired with `--machine hokon` naming this box specifically — a bare
   `--include-guests` with no `--machine` widens nothing
   (`scripts/lib/fleet-exec.mjs`'s guest gate).
   Verify: prints hokon's current proof set / drift, and changes nothing.

2. **Record what it earns.** Where: control host. As: the probe's own role.
   Command: `fleet bootcamp --machine hokon --write`
   Targeting a guest with `--machine` forces this into check-only for that
   node no matter what else is passed — it probes and records hokon's proof
   set, and never installs or drains it (`bootcamp.mjs`'s own role filter).
   Verify: the run's report shows the capability as `EARNED` / `UNEARNED` /
   `BLOCKED`, and nothing was drained to get the answer.

3. **Install ONE new capability — operator approval required, named by
   hand.** Where: control host. As: the role the tool installs under (`ci`
   by default).
   Command:

   ```
   fleet converge-toolchain --machine hokon --include-guests --write
   ```

   This is the only command in the fleet chain that can run an
   `apt-get install`-shaped step on hokon — its own header names the exact
   failure mode this skip exists to prevent: "an unattended `apt-get
install` there". **Never run it against hokon without the operator having
   named the specific capability first.**

   **GAP:** this command converges every currently-applicable repair for
   whatever hokon's manifest already declares — there is no `--only=<tool>`
   door to install exactly one named capability and nothing else. The
   "approve one capability at a time" discipline is therefore a human
   practice today, not something the tool enforces. Closing it needs a
   per-capability selector on `converge-toolchain`, the same shape as
   `--machine`.
   Verify: the capability the operator asked for now PASSES
   `fleet capabilities --machine hokon --include-guests`; diff hokon's proof
   set before/after to confirm nothing else moved.

4. **Sync a fixed fleet node script onto it by hand — no approval needed;
   this is not an install.** Where: control host, pushing onto hokon. As:
   whichever role owns the script on every other node (`ci` for
   `ci-throttle.sh` / `job-metrics.sh` / `jit-provision.sh`).
   There is no `fleet` subcommand for this: every converge path that would
   normally redeploy a node's own scripts (`throttle`, `reconcile`) skips a
   guest the same way step 3's install path does, so nothing updates hokon's
   copies automatically. Compare and copy by hand, keeping a dated backup:

   ```
   cmp ~/.hadoku/ci-throttle.sh <checked-out-package>/scripts/lib/ci-throttle.sh
   cp ~/.hadoku/ci-throttle.sh ~/.hadoku/ci-throttle.sh.bak-$(date +%s)
   # then copy the current package's file over the live one
   ```

   The hook is read fresh per job; nothing needs restarting afterward.
   Verify: `cmp` between hokon's live copy and the package's reports no
   difference.

5. **Earn a workload label on its standing runner.** Where: control host. As:
   `fleet prove-job` reaches GitHub's API only — no ssh, no drain, no mint.
   Command: `fleet prove-job --node hokon --capability <id> --include-guests`
   Verify: the run reports `PASSED` against its measured threshold; a
   follow-up `fleet reconcile --confirm` adds the label to hokon's standing
   registrations (one manifest commit; nothing changes on the node itself).

## Rollback

- Step 3 (an install): `converge-toolchain` never removes a package — there
  is no automated uninstall. Reversing a mistaken install is a manual
  package-manager action on hokon itself, under the same rule that governed
  installing it: ask the operator first.
- Step 4 (a script sync): restore from the `.bak-<timestamp>` made before
  overwriting.
- Step 5 (a proof label): `fleet reconcile --confirm --remove-excluded` strips
  an idle registration or label that no longer belongs — the same narrowing
  path every other repo uses, not a hokon-specific undo.
- Steps 1–2 change nothing and need no rollback.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command above
  exists in the door's table.
- `scripts/lib/node-role-gates.test.mjs` / `scripts/lib/fleet-exec.test.mjs` —
  the guest gate is the one door (`--include-guests` paired with `--machine
<that guest>`); a bare `--include-guests`, or the flag on a node that is not
  a guest, is proven to refuse rather than widen.
- `converge-toolchain`'s and `bootcamp`'s own role filters — a guest is
  skipped by default and the skip is reported (never silently) under `--json`.
- `scripts/lib/publish-safety-guard.test.mjs` — this file names no address,
  MAC, tailnet name, or other site fact.

## Memory lessons this runbook holds

- **Probe and bootcamp hokon freely; ask before every new install, one
  capability at a time** — the operator's standing rule (2026-10-09). The code
  enforces the "freely" half completely and the "one at a time" half only
  partway (step 3's GAP above).
- **The fleet's own node scripts are not installs.** Updating hokon's copy of
  a fixed package script is routine and needs no approval — only a genuinely
  new tool or package does.
- **Routine automation never reaches hokon.** No converge pass, no refresh
  cycle, no `reconcile`'s seed/ensure-tools path ever touches it; only a
  hand-run command carrying both the `--machine hokon` and `--include-guests`
  flags does.
- **It refuses ssh to itself.** `isLocalNode()` (`src/lib/node-identity.ts`)
  answers "is this node the box I am running on" — true, for hokon, from a
  process already running on hokon — so every fleet command that would
  otherwise ssh out runs as a local shell instead when its target is hokon
  and it is already executing there. See R15 for what this means when hokon
  itself is the thing that needs recovering, and `docs/control-plane.md` §1
  for why the OPPOSITE direction (another controller sshing TO hokon) is
  unproven rather than merely untested.
- **AV1 NVENC and `taskauto` exist only here.** A job or capability check
  asking for either mints on hokon regardless of whether the backstop
  currently holds it.
