# R1 — new claw: bare metal → admitted

Scenario #1 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
Written against `provision`'s CURRENT chain (`scripts/provision-fleet.mjs:19`
onward: declare → converge → bootcamp → placement → register → throttle →
slice → realize → benchmark → health). `lan-reserve`, `toolpack` and the
node-users cutover are **explicit manual steps below** until
`refactor-plan-2026-10-28.md` §5.4 folds them into `provision` (tracked
there, not here — this runbook is written against today's behaviour and
tightens as the code lands).

Every `fleet …` command below is checked against `src/cli.ts`'s door table by
`scripts/lib/onboarding-docs.test.mjs`: a command this file prints that the
door does not know fails the build.

## Preconditions

- A CLAWKIT stick built by `fleet usb-prep` (interactive) or `fleet onboard`
  (guided; prints the same steps as this runbook — start there if you want a
  live wizard instead of this document).
- A console (keyboard + monitor, or IPMI/KVM) for the new box. Step 2 below
  rewrites `sshd`'s config; losing the console before that is verified means
  losing the box.
- An Ethernet cable. The installer and the toolchain floor both fetch
  packages from the mirror; wifi works but removes a whole class of
  reachability failure from this already-long chain.
- A name for the node. **Names are immutable — a replacement for dead
  hardware is `claw-N+1`, never a reused name** (see R3, and the memory note
  `node-names-immutable`).

## Steps

1. **Boot the stick.** Where: at the new box, console. As: nobody (no OS yet).
   Command: boot from the stick; it auto-selects the installer after 5s and
   installs unattended, asking only the **hostname** and, if the box has more
   than one, the **disk**.
   Verify: the box reboots into the name you gave it.

2. **Convert it to a fleet node.** Where: at the new box, over the console
   (keep it attached for this step — see Preconditions). As: `admin` (the
   installer leaves your key and passwordless sudo already in place).
   Command:

   ```
   sudo mount LABEL=CLAWKIT /mnt
   sudo bash /mnt/bootstrap/node-bootstrap.sh
   ```

   This infers the profile, the key and the hostname from the stick and the
   box; it prints what it chose and refuses rather than guessing when the
   answer is not unique (`node-bootstrap requires no flag it can infer`,
   proven against a fixture stick by
   `scripts/lib/onboarding-docs.test.mjs`).
   Verify, **before disconnecting the console**, both:
   - `ssh <admin>@<node> true` from the control host (key auth)
   - the console password still logs in

3. **Reboot, then authenticate Tailscale — both manual by design.**
   Where: at the new box (reboot) and over ssh from the control host
   (Tailscale). As: `admin`.
   `node-bootstrap.sh` deliberately does neither itself: "a script that
   reboots is one whose output you read or not", and Tailscale's login needs
   a browser session the box does not have. It prints the exact `tailscale
up` invocation it chose (tags come from the node's profile) at the end of
   step 2's run; use that line verbatim.
   Verify: `tailscale status` on the node reports logged in, and the node's
   tailnet name resolves from the control host (do not hardcode what it
   resolves to anywhere in this public repo).

4. **Capture and enroll.** Where: step 4a over ssh from the control host (no
   console needed any more); step 4b from the `hadoku-fleet-manager`
   checkout. As: `fleet enroll` connects as `admin`.
   Command:

   ```
   fleet enroll <node>              # propose — reads the node's own
                                     # /var/log/node-bootstrap-*.log over ssh,
                                     # re-probes it independently, and exits
                                     # non-zero: nothing is written yet
   fleet enroll <node> --write      # commit the proposal to the manifest
   ```

   No manual `tee`/copy-down step exists any more: `fleet enroll <node>`
   reads the node's newest bootstrap log itself. Measurement is automated;
   **declaration stays a human act** — `--write` is the only thing that
   commits it (`docs/VOCABULARY.md`, "ENROLL is the only inversion in the
   system").
   Verify: `fleet enroll <node>` a second time reports the node already
   declared, not a fresh proposal.

5. **LAN reservation** (manual until §5.4). Where: from the control host.
   As: `fleet lan-reserve` connects as `admin`.
   Command:

   ```
   fleet lan-reserve --machine <node>            # propose, read off the box
   fleet lan-reserve --machine <node> --write    # record it
   ```

   hokon reaches every claw by a LAN IP in `~/.ssh/config`; without a gateway
   reservation on record, that IP is a DHCP lease that can move under the
   node (memory `lan-reservations`).
   Verify: `fleet preflight` no longer lists `<node>` under
   `lan-reservation`.

6. **Toolchain floor** (manual until §5.4). Where: from the control host.
   As: `fleet toolpack` connects as `admin`, installs as `ci` where the
   instrument is CI-scoped.
   Command:

   ```
   fleet toolpack                 # report gaps against the TOOLS floor
   fleet toolpack --confirm       # install what is missing
   ```

   Run this **before** bootcamp (step 7, inside `provision`): bootcamp
   proves a capability by executing it, and a probe run against a box
   missing its toolchain floor fails the capability rather than reporting
   "not yet installed" (memory `converge-toolchain`, the sibling check for
   the package floor specifically).
   Verify: `fleet toolpack` reports no gaps.

7. **Node-users cutover** (manual until §5.4; owned by the node-users
   workstream, d3). Where: from the control host. As: `fleet node-users`
   connects as `admin`; the cutover itself creates and moves the node's `ci`
   role user.
   Command:

   ```
   fleet node-users --machine <node>                     # check only
   fleet node-users --cutover <node> --confirm            # create + move the ci role
   ```

   Until this runs, the node's CI jobs execute as `admin` — correct for a
   node mid-migration, not a target state (see `docs/VOCABULARY.md` §"Node
   users").
   Verify: `fleet node-users --machine <node>` reports the `ci` role present
   and not drifted.

8. **Provision.** Where: from the control host. As: `fleet provision`
   connects as both roles in turn, per internal step (declare as itself,
   converge/bootcamp as `ci`, placement/register/throttle/slice/realize as
   `admin`).
   Command:

   ```
   fleet provision --machine <node>              # dry run — reports, writes nothing
   fleet provision --machine <node> --confirm    # runs the full chain
   ```

   **This installs.** The door's own summary text ("a dry run unless
   --confirm, and installs nothing") reads as if `--confirm` _also_ installs
   nothing; it does not — `--confirm` is the mode that runs bootcamp
   `--write` and seeds remedies (`scripts/provision-fleet.mjs:788-862`).
   Without `--confirm` nothing is written anywhere; with it, the node is
   converged.
   Verify: `fleet provision --machine <node> --verify-only` reports every
   step converged.

9. **Admit.** Nothing to run — this is the fast loop's own job
   (`nodeIsSafe`, `docs/VOCABULARY.md`'s ADMIT phase). Once provisioning
   above reports converged, the fast loop starts routing real CI to the node
   on its own next tick.
   Verify: `fleet traffic` shows the node as a candidate for the next job, or
   `fleet doctor <node>` shows a fresh, clean record.

## Rollback

- Before step 4 (`enroll --write`): nothing is declared. Wipe the box and
  start over, or walk away — the fleet has no record of it.
- After step 4, before step 8 (`provision --confirm`): `fleet drain <node>
--undo` is a no-op (nothing has ever scheduled to it); remove the manifest
  entry by hand if the node is being abandoned, or continue the chain later —
  a declared-but-unconverged node does not receive jobs.
- After step 8: this is now R3's job. Drain it (`fleet drain <node> --reason
"<why>"`), then follow R3 to take it out cleanly rather than deleting
  manifest state out from under a node that may still have jobs assigned.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command printed
  above exists in the door's table (`src/cli.ts`'s `COMMANDS`), and the
  flagless `node-bootstrap.sh` invocation resolves against a fixture stick.
- `scripts/lib/node-users-guard.test.mjs` — step 7 is read through the role,
  never a user literal.
- `fleet preflight` (nightly) — pages if step 5 (LAN reservation) is skipped
  and the node is later admitted anyway.
- `fleet drain-check` — catches a node this runbook's rollback drained but
  whose drain was never actually enforced.

## Memory lessons this runbook holds

Each of these was a real incident; the lesson now lives here instead of only
in agent memory (plan §5.2, "runbooks drain agent memory"):

- **Node names are immutable** — a replacement claw always increments
  (`claw-N+1`); a name is never reused (Preconditions, and R3).
- **Seed the payload before flipping a node ephemeral** — `provision`'s
  internal ordering (step 8 above) does this for you; never flip
  `ephemeral` by hand ahead of it.
- **LAN reservation** — step 5; a node without one is reachable until its
  DHCP lease moves, silently, under a live fleet.
- **Mount the kit at `/mnt`**, never `/mnt/kit` — step 2's exact command.
- **`journalctl --list-boots` first** — if step 3's reboot looks like it
  never happened, check boot history before any Linux-side theory; a box
  that never powered back on has no boot entry at all.
- **`--help` can execute** — never run a step above with `--help` to "check"
  it; read this runbook or the script's own header instead. `reboot-claws
--help` once rebooted a node.
- **`converge-toolchain`/`toolpack` before bootcamp** — step 6 before step 8;
  bootcamping a node with a missing instrument fails the capability instead
  of reporting it as not-yet-installed.
