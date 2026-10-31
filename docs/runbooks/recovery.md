# R15 — recovery: when the CLI, the controller, or the network might be what's broken

Scenario #15 of `docs/planning/refactor-plan-2026-10-28.md` §5.3's catalogue.
Every other runbook in this directory assumes `fleet <command>` runs and
answers truthfully. This one is for when that assumption is itself in
question — the CLI could be the thing that's broken (a stale build, the wrong
checkout), the controller box could be down or unreachable, or the network
between here and a node could be the actual fault. **This runbook is prose,
on purpose, and uses nothing but ssh, a console, and standard Linux tools —
no `fleet` subcommand is required to get through it.**

## Preconditions

- Console or out-of-band access (IPMI/KVM, or a keyboard and monitor at the
  box) for the case where ssh itself is what's down.
- Decide which of three things is actually unreachable before reaching for a
  fix: one specific node, the controller itself, or "the network" in
  general (nodes reachable from nowhere, or from some places and not
  others). The next three steps answer exactly one of those each.
- Never run a script with `--help` "just to check" before using it for real —
  several of this fleet's scripts execute real steps on `--help`. Read the
  script's own header, or this runbook, instead.
- Never `git stash` in a shared checkout if this diagnosis takes you into one
  mid-use — the stash is repo-global, not per-worktree, and will swallow
  someone else's uncommitted work.

## Steps

1. **Decide power-off vs. a Linux-side fault — before theorising.** Where:
   wherever you can get ANY shell on the box in question — ssh if it still
   answers, the console if it does not. As: whoever you can log in as
   (`admin` is enough; this only reads logs).
   Command:

   ```
   journalctl --list-boots
   ```

   Read the boot entries against the outage window. **No boot entry at all
   in that window means the box never reached Linux** — it was powered off.
   A held-down power button, or a "force restart", turns a machine OFF; it
   does not restart it, and it stays off until the button is pressed again.
   Every Linux-side theory (fsck, a hung service, a kernel panic) is dead on
   arrival when there is no boot entry to explain. A boot entry that IS
   there, ending abruptly, is the other family — read
   `journalctl -b <that boot's offset>` for what it logged right before it
   stopped.
   Verify: you can say which of the two families this is — "never booted" or
   "booted, then something failed" — before doing anything else. They need
   opposite responses (a trip to the box vs. a software fix), and guessing
   wrong wastes a trip.

   If a BIOS-level question is still open after that ("did it lose its clock
   or its settings"), compare the RTC to real time at the boot that followed:

   ```
   journalctl -b 0 | grep "setting system clock"
   ```

   A small drift proportional to how long the box sat unpowered is normal
   and rules out a dead CMOS battery; a large, unexplained jump is not.

2. **Get a shell on a node — `admin` first, `ci` only if that's actually
   what you need.** Where: from anything that can reach it — the controller,
   another box, or the console at the node itself. As: whichever role you
   mean to reach. Since the node-users cutover (R12), `admin` and `ci` are
   **separate ssh LOGINS**, not separate sudo rules on one account.
   Command:

   ```
   ssh <admin-user>@<node>   # management: sudo, the journal, pm2 — never runs a job
   ssh <ci-user>@<node>      # only once the node has been cut over — runs CI, no sudo
   ```

   A ci login only exists on a node that has actually been through R12. On
   one that has not, CI still runs AS the admin user, and there is no
   separate ci login to reach — asking for one just fails to connect, which
   is not evidence of anything broken. **Do not guess which state a node is
   in from memory** — if you cannot already reach it to check, assume "no
   separate ci login" until you have evidence otherwise.

   If the `admin` login itself is what's broken (the key is gone, sudo is
   gone), that is the recovery stick's job:
   `scripts/fixes/README.md`'s `claw-admin-fix.sh` — boot the stick, drop to
   an `init=/bin/bash` shell, mount the kit partition, run the fix script. It
   restores key-based access and group membership for the admin user only.
   **GAP:** it has no equivalent for a cut-over node whose `ci` login is the
   one that's broken — today the only path is to restore `admin` access by
   whatever means (including the stick), then, once ordinary fleet tooling
   is reachable again, re-run the node side of R12's cutover (it is
   idempotent, so re-running it against an already-cut-over node that merely
   lost its ci key repairs that key). Closing this gap means teaching the
   recovery stick (which runs before any network is up, and so cannot read
   the manifest) which user name a given node's ci role actually has.
   Verify: the shell's own `id -un` is the role you meant to reach, not
   whatever sshd silently dropped you into instead — the same mismatch the
   cutover's own login check exists to catch (see R12), done here by hand.

3. **The controller refuses ssh to itself — so if the controller IS the
   broken box, you are not diagnosing it from a session already running on
   it.** Where: at the controller's own console, or ssh'd in from somewhere
   else entirely — never from a process already executing there. As:
   `admin`.
   Why this matters: `isLocalNode()` (`src/lib/node-identity.ts`) is the
   fleet code's one answer to "is this node the box I am running on", and the
   controller answers `true` about itself — every fleet command that would
   otherwise ssh out to a node instead runs as a plain local shell when its
   target is the box it is already on. That is a property of the FLEET
   CODE, not of the controller's ssh daemon, so it does not stop you from
   sshing INTO the controller from some other machine for recovery purposes —
   it only means a `fleet` command run while standing on the controller was
   never going to ssh to itself in the first place, whatever you are
   debugging in it.
   Verify: n/a — this is a fact to know before spending time trying to make
   the controller "ssh to itself" as a diagnostic step; it was never going
   to.

4. **Network trouble: separate "this box" from "the network" before
   changing anything.** Where: at the node in question (console, if ssh is
   what's down) or from the controller. As: `admin`. Check, in order,
   read-only:

   ```
   ip addr                                                 # an address at all?
   ip route                                                 # a default route?
   cat /etc/resolv.conf; getent hosts <some known-good name>   # DNS, separately
   ```

   A box with an address and a route but no working DNS is a different fault
   from one with neither — do not jump to "the network is down" off one
   failed `ping`. If a wifi radio's own stack is the suspect (ifupdown vs.
   NetworkManager, or a recent access-point change), that procedure lives in
   `scripts/fixes/README.md`'s `nm-convert.sh` section and
   `docs/VOCABULARY.md`'s "Changing the SSID" section — read both before
   touching a live radio; converting it the wrong way has stranded a node
   before.

   ssh targets in this fleet are always NAMES, never bare addresses — if a
   name that used to resolve now points nowhere, or somewhere wrong, the
   underlying DHCP lease moved, which is a LAN-reservation problem (see R1
   step 6, provision's lan-reserve step), not a cabling one.
   Verify: you can name which single thing is actually missing — no address,
   no route, no DNS, or a changed address — not just "unreachable". Each
   needs a different next step.

5. **Before touching anything, from any of the steps above, confirm the box
   in front of you is the box you think it is.**
   - **Disk device letters are not stable across every reboot on every
     node** — `/dev/sda` and `/dev/sdb` have been observed to swap between
     boots on the same hardware, same filesystem, nothing wrong. Address a
     disk by its filesystem UUID or `/dev/disk/by-id/...` for anything that
     writes to it; never a bare `/dev/sdX`.
   - **A node's name is permanent and never reused.** If the box in front of
     you claims a name you believe was already retired, that mismatch IS the
     finding — stop and say so rather than proceeding as if it were that
     name's live node.
   - If you reached a shell through anything other than the two logins in
     step 2 (a recovery stick, a rescue environment), remount `/`
     read-write explicitly before changing anything — several of those
     environments boot read-only by design, and a change that silently
     no-ops because of that is worse than one that errors loudly.

## Rollback

- This runbook only reads state; nothing in it needs rolling back by itself.
- If step 2's recovery-stick path was used against the wrong box: the fix
  script checks that the admin account it is about to repair already exists
  and refuses otherwise — verify that refusal fired rather than assuming it
  did. Nothing it does is ever written to the manifest or to GitHub, so
  there is no fleet-side state to unwind either way — only whatever ssh keys
  or group membership it added to that one box's own `/etc`, which can be
  removed by hand on that box if it really was the wrong one.

## Enforced by

- Nothing here is gated — it is prose by design (plan §5.3, R15: "prose that
  depends on nothing it might be recovering"). The two facts that would
  matter most if this drifted — `journalctl --list-boots` as the first move,
  and never trusting a `/dev/sdX` letter — were previously standing agent
  memory notes and now live here instead.
- `scripts/lib/node-identity-guard.test.mjs` is the one code-level guard
  touching this doc's content: it fails the build if `isLocalNode()` grows a
  second implementation, which is the fact step 3 depends on staying true.
- `scripts/lib/publish-safety-guard.test.mjs` — this file names no address,
  MAC, tailnet name, or other site fact.

## Memory lessons this runbook holds

- **`journalctl --list-boots` first** — step 1; the single cheapest check
  that rules out several wrong theories at once, and the reason three of four
  theories tried on one real outage were wrong before this was written down.
- **A forced or held-button restart is a power-OFF, not a restart** — it
  stays off until the box is physically powered back on; no amount of
  Linux-side diagnosis will explain a box that never left that state.
- **`admin` and `ci` are separate LOGINS, not one account with two sudo
  rules** — step 2; and only a cut-over node has the second one at all.
- **The controller refuses ssh to itself as a consequence of `isLocalNode()`,
  not of its ssh daemon** — step 3; the opposite direction (another
  controller sshing TO it) is unproven, not merely untested
  (`docs/control-plane.md` §1).
- **Disk letters are not stable across a reboot on every node** — step 5;
  address disks by UUID or by-id.
- **`--help` can execute** — never run any step above, or any fleet script,
  with `--help` "to check" first; read the header or this runbook instead.
