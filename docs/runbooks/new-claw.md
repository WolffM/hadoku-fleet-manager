# R1 — new claw: bare metal → admitted

Scenario #1 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
Written against `provision`'s CURRENT chain (`scripts/provision-fleet.mjs:19`
onward: declare → lan-reserve → toolpack → node-users (printed reminder) →
converge → bootcamp → placement → register → throttle → slice → realize →
benchmark → health). Wave 5m lane B folded `lan-reserve --write` and
`toolpack --confirm` into that chain (`refactor-plan-2026-10-28.md` §5.4);
the **node-users cutover is still an explicit manual step below** — it is a
different workstream's (d3's), and `provision` only ever PRINTS a reminder
for it, never calls it.

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

## Who does what

**The operator does steps 1–3, at the box, and nothing else** except the
one gateway click in step 6. Everything from step 4 on runs from the control
host and is the agent's job, not the operator's, the moment
`ssh <admin>@<node>` works. Do not hand the operator a list of `fleet …`
commands to type (operator, 2026-11-03: "all of those things should be
handled by you as soon as ssh works"). What the agent needs from the operator
is "ssh works" plus the node's LAN IP, then later a DHCP reservation for one
MAC/IP pair. No code holds the gateway's credential, so that click stays
human. Report back when step 7 verifies, not after each step in between.

## Steps

1. **Boot the stick.** Where: at the new box, console. As: nobody (no OS yet).
   Command: boot from the stick (claw-10 installed from a rear USB 2.0 port;
   on an old board, prefer one over USB 3.0 or the front panel). Ventoy's
   menu auto-selects the Debian
   `.iso` after 5s. At **Debian's own menu, pick `Install`** (the text
   installer). Do **not** pick `Graphical install`: it went to a black screen
   on claw-10's GTX 1060. Debian's menu has no timeout, so this is always a
   choice. The installer then runs unattended, asking only the **hostname**
   (type the node's name exactly), the **disk** if the box has more than
   one, and, again on a box with more than one fixed disk, **where to
   install GRUB**.

   **The GRUB question:** answer it with the disk that holds `/target`.
   Ctrl+Alt+F2, then `mount | grep target`, then strip the partition number
   (`/dev/sdc1` → `/dev/sdc`), then Ctrl+Alt+F1 to go back and type it. The
   preseed pins GRUB only when there is exactly one fixed disk; Debian's own
   default would be the first disk, which is the claw-9 failure
   (`make-preseed-render.sh`, "Bootloader").

   **When the install reboots, pull the stick before Ventoy's 5s
   countdown.** The BIOS boots USB first, and Ventoy will start the
   installer again. Device letters also change between the installer and
   the installed system (claw-10's root was `sdc` in d-i and `sdb` after),
   so name disks by model, never by letter.

   **A stick built with `--netinst-iso` and no `.iso` on Ventoy** says "no
   ISO available" and boots only through F6, then _Install Debian (fleet
   netinst partition)_. That path **hung on the first real board it met**
   (claw-10, a 2011 Award legacy BIOS, at GRUB's `linux` load, on every USB
   port; that board cannot boot USB in UEFI). Put the `.iso` on Ventoy's
   partition for any board you have not booted this way before.
   `fleet verify-stick` says which kind of stick you are holding.
   Verify: the box reboots into the name you gave it. **If its console is
   black after GRUB** on a box with an NVIDIA card, the system is probably
   up and the display is not: check over ssh before rebooting anything.

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
   fleet enroll <node> --address <lan-ip>          # propose — reads the node's own
                                                    # /var/log/node-bootstrap-*.log over ssh,
                                                    # re-probes it independently, and exits
                                                    # non-zero: nothing is written yet
   fleet enroll <node> --address <lan-ip> --write  # commit the proposal to the manifest
   ```

   **`--address` is not optional on a new node.** The control host has no
   `~/.ssh/config` entry for `<node>` yet, so without it enroll has nothing
   to connect to. `--address` is what writes that entry: a delimited block,
   appended, with the file backed up first. It prefers the node's tailnet
   name once that name actually opens a session, and otherwise pins the
   LAN IP (`scripts/lib/enroll-ssh.mjs`). Once the entry exists,
   `--address` is redundant and harmless.

   No manual `tee`/copy-down step exists any more: `fleet enroll <node>`
   reads the node's newest bootstrap log itself. Measurement is automated;
   declaration is a deliberate act, and `--write` is the only thing that
   commits it (`docs/VOCABULARY.md`, "ENROLL is the only inversion in the
   system"). The agent runs it once the proposal's measured hardware matches
   the box (see "Who does what").
   Verify: `fleet enroll <node>` a second time reports the node already
   declared, not a fresh proposal.

5. **Node-users cutover** (a separate command, never chained; owned by the
   node-users workstream, d3. The agent runs it, not the operator).
   Where: from the control host. As: `fleet node-users` connects as `admin`;
   the cutover itself creates and moves the node's `ci` role user.
   Command:

   ```
   fleet node-users --machine <node>                     # check only
   fleet drain <node> --reason "node-users cutover"      # the cutover refuses an undrained node
   fleet node-users --cutover <node> --confirm            # create + move the ci role
   ```

   The drain is required even on a node that has never served a job. Leave
   it in place through step 6 and undo it (`fleet drain <node> --undo`)
   once provision verifies: the cutover's own closing line says when the
   deployed manifest agrees.

   Until this runs, the node's CI jobs execute as `admin` — correct for a
   node mid-migration, not a target state (see `docs/VOCABULARY.md` §"Node
   users"). `provision` (next) prints a reminder of this exact step on every
   run; it never calls it — that area is a different workstream's.
   Verify: `fleet node-users --machine <node>` reports the `ci` role present
   and not drifted.

6. **Provision.** Where: from the control host. As: `fleet provision`
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

   Since wave 5m lane B, the chain's own second and third steps absorb what
   used to be two more hand commands here:

   - **LAN reservation.** The chain records the node's gateway DHCP
     reservation (`lan-reserve --write`) and re-reads it to verify, rather
     than trusting its own write. It CANNOT make the reservation itself — no
     code holds the gateway's admin credential (memory `lan-reservations`) —
     so a dry run (`fleet provision --machine <node>`, no `--confirm`) prints
     the exact MAC/IP to reserve if the gateway doesn't have it yet. This is
     the operator's one control-host-side action: the agent asks for exactly
     that pair (Advanced → DHCP Reservation → delete any Auto row for that
     MAC → select the MAC → pick the address → Add) and waits for it BEFORE
     re-running with `--confirm`. hokon reaches every claw by this LAN IP in `~/.ssh/config`;
     without the reservation on record, it is a DHCP lease that can move
     under the node.
   - **Toolchain floor.** The chain installs the benchmark instrument floor
     (`toolpack --confirm`) and re-reads it to verify — fully automatic,
     unlike the LAN step. It runs before bootcamp inside the chain
     (memory `converge-toolchain`): bootcamp proves a capability by
     executing it, and a probe run against a box missing this floor fails
     the capability rather than reporting "not yet installed".

   Verify: `fleet provision --machine <node> --verify-only` reports every
   step converged; `fleet preflight` no longer lists `<node>` under
   `lan-reservation`; `fleet toolpack <node>` reports no gaps.

7. **Admit.** Nothing to run — this is the fast loop's own job
   (`nodeIsSafe`, `docs/VOCABULARY.md`'s ADMIT phase). Once provisioning
   above reports converged, the fast loop starts routing real CI to the node
   on its own next tick.
   Verify: `fleet traffic` shows the node as a candidate for the next job, or
   `fleet doctor <node>` shows a fresh, clean record.

## Rollback

- Before step 4 (`enroll --write`): nothing is declared. Wipe the box and
  start over, or walk away — the fleet has no record of it.
- After step 4, before step 6 (`provision --confirm`): `fleet drain <node>
--undo` is a no-op (nothing has ever scheduled to it); remove the manifest
  entry by hand if the node is being abandoned, or continue the chain later —
  a declared-but-unconverged node does not receive jobs.
- After step 6: this is now R3's job. Drain it (`fleet drain <node> --reason
"<why>"`), then follow R3 to take it out cleanly rather than deleting
  manifest state out from under a node that may still have jobs assigned.

## Enforced by

- `scripts/lib/onboarding-docs.test.mjs` — every `fleet …` command printed
  above exists in the door's table (`src/cli.ts`'s `COMMANDS`), and the
  flagless `node-bootstrap.sh` invocation resolves against a fixture stick.
- `scripts/lib/node-users-guard.test.mjs` — step 5 is read through the role,
  never a user literal.
- `scripts/lib/onboarding-automation.test.mjs` — the chain's own `lan-reserve`
  and `toolpack` steps (inside step 6) run in the order this runbook
  documents, write/install only with `--confirm`, verify with an independent
  re-read, and the `node-users` step is never spawned — only printed.
- `fleet preflight` (nightly) — pages if the LAN reservation (step 6) is
  skipped and the node is later admitted anyway.
- `fleet drain-check` — catches a node this runbook's rollback drained but
  whose drain was never actually enforced.

## Memory lessons this runbook holds

Each of these was a real incident; the lesson now lives here instead of only
in agent memory (plan §5.2, "runbooks drain agent memory"):

- **Node names are immutable** — a replacement claw always increments
  (`claw-N+1`); a name is never reused (Preconditions, and R3).
- **Seed the payload before flipping a node ephemeral** — `provision`'s
  internal ordering (step 6 above) does this for you; never flip
  `ephemeral` by hand ahead of it.
- **LAN reservation** — step 6; a node without one is reachable until its
  DHCP lease moves, silently, under a live fleet. Since wave 5m lane B the
  chain records it for you; the gateway click itself still cannot be
  automated — no code holds that credential.
- **Mount the kit at `/mnt`**, never `/mnt/kit` — step 2's exact command.
- **`journalctl --list-boots` first** — if step 3's reboot looks like it
  never happened, check boot history before any Linux-side theory; a box
  that never powered back on has no boot entry at all.
- **`--help` can execute** — never run a step above with `--help` to "check"
  it; read this runbook or the script's own header instead. `reboot-claws
--help` once rebooted a node.
- **`converge-toolchain`/`toolpack` before bootcamp** — both run inside step
  6's chain, in that order, ahead of bootcamp; bootcamping a node with a
  missing instrument fails the capability instead of reporting it as
  not-yet-installed.
