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
- **It is also declared in the manifest as the `backstop`** (`role:
"backstop"`, `"mint": "on-demand"`) — the fleet's emergency backstop, not
  general capacity. It takes `taskauto` and `av1-nvenc` jobs, which exist
  nowhere else, and — only while the backstop holds it — overflow
  `hadoku-builder` work. See `docs/control-plane.md` §6 and
  `docs/VOCABULARY.md` "The backstop node".
- **It is the production host** (mgmt-api, the tunnel, vaultwarden).

Those are the only two ways it differs from a claw (operator, 2026-10-31: "we
can do drains and installs. hokon is our emergency backstop when things go
wrong"). The fleet drains it, probes it, bootcamps it, installs on it and
converges it exactly like a claw — a backstop nobody keeps current cannot save
the fleet. What it keeps out of: the census, the routing rank, the warm cache,
hosting tenants and bootcamp's required set (not capacity), and the reboot
cycle and the CI-user cutover (the production host: when it reboots is the
operator's call, and its node-health findings are advisory). It was called a
`guest` until 2026-10-31, when every fleet command skipped it by default.

## Preconditions

- A drain stops new work landing on it, but the production services keep
  running, so a drain does not make this box "safe" to change the way
  draining a claw does.
- Anything that needs a reboot is the operator's to schedule. The fleet never
  reboots it.

## Steps

1. **Check what it can already do — read-only, no install.** Where: control
   host. As: the probe's own role (`ci` by default).
   Command:

   ```
   fleet capabilities --machine hokon
   fleet toolchain --machine hokon
   ```

   Verify: prints hokon's current proof set / drift, and changes nothing.

2. **Record what it earns.** Where: control host. As: the probe's own role.
   Command: `fleet bootcamp --machine hokon --write`
   A full run, the same as on a claw: it drains hokon to take idle-only
   measurements and undrains it afterwards.
   Verify: the run's report shows the capability as `EARNED` / `UNEARNED` /
   `BLOCKED`.

3. **Install or refresh its toolchain.** Where: control host. As: the role
   the tool installs under (`ci` by default).
   Command:

   ```
   fleet converge-toolchain --machine hokon --write
   ```

   Converges every currently-applicable repair for what hokon's manifest
   declares, as on any claw. The scheduled refresh cycle does the same.
   Verify: the capability now PASSES `fleet capabilities --machine hokon`;
   diff hokon's proof set before/after to confirm nothing else moved.

4. **Fleet node scripts.** `fleet throttle` and the provisioning converger
   redeploy hokon's `ci-throttle.sh` / `job-metrics.sh` like every other
   node's. Nothing is copied by hand.
   Verify: `fleet throttle --machine hokon --check` reports no drift.

5. **Earn a workload label.** Where: control host.
   Command: `fleet prove-job --node hokon --capability <id>`
   It mints a JIT proof runner on hokon, as the dispatcher does for its jobs.
   Verify: the run reports `PASSED` against its measured threshold.

## Rollback

- Step 3 (an install): `converge-toolchain` never removes a package — there
  is no automated uninstall. Reversing a mistaken install is a manual
  package-manager action on hokon itself.
- Step 5 (a proof label): `fleet reconcile --confirm --remove-excluded` strips
  an idle registration or label that no longer belongs — the same narrowing
  path every other repo uses, not a hokon-specific undo.
- Steps 1–2 change nothing and need no rollback.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command above
  exists in the door's table.
- `src/tests/node-role.test.ts` — the role's one reader, `isBackstopNode`, and
  that the legacy value `guest` still reads as `backstop`.
- `scripts/lib/reboot-cycle.test.mjs` — the reboot cycle never probes or
  reboots the backstop.
- `scripts/lib/publish-safety-guard.test.mjs` — this file names no address,
  MAC, tailnet name, or other site fact.

## Memory lessons this runbook holds

- **Drain, probe, bootcamp and install on hokon like a claw** (operator,
  2026-10-31). Only capacity and the production host set it apart.
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
