# scripts/fixes — recovery scripts that live on the stick

Everything in this directory is copied verbatim onto the `CLAWKIT` partition by
`fleet usb-prep`, under `fixes/`.

## What belongs here

A script belongs here if all three are true:

1. **It runs from recovery media.** Not over ssh, not from a checkout — off a
   USB stick, at the physical console, into a node that is not going to boot
   normally or is not going to let you in.
2. **It runs as root**, typically inside an `init=/bin/bash` shell where systemd
   never started. That means POSIX `/bin/sh`, no bash-isms, and mounting `/proc`
   and `/sys` itself, because nothing else has.
3. **The box cannot be reached over the network.** If ssh works, the fix belongs
   in a deployer with a `--check`, where it can be applied to the whole fleet and
   verified against observed state. This directory is for the case where that
   whole apparatus is unreachable.

Everything here must be **idempotent** — re-running it on an already-fixed
node is a no-op — and must **refuse rather than guess**. `claw-admin-fix.sh`
aborts if the user it is about to fix does not exist, because "this is not the
node you think it is" and "this node needs fixing" must not produce the
same action.

## What does NOT belong here

**Anything speculative.** This is not a toolbox of fixes for failures that have
not happened. Every script here should exist because a real node was in a
real state that a real operator could not otherwise get out of, and the header
should say which one and when. A directory of imagined recoveries is a directory
nobody trusts at 2am, because the one script that has actually worked is
indistinguishable from the nine that have never been run.

Anything that needs the network, a package install, or a working systemd also
does not belong here — by the time those work, so does ssh.

## What is here

| script              | the failure it exists for                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claw-admin-fix.sh` | The one that has actually saved the operator. `garage-server-bazooka.sh` added the fleet user to the `sudo` GROUP but never wrote a NOPASSWD rule, and the only password it set was random and printed once. Discovered 2026-08-17: a crashing claw could not be diagnosed because nothing could read its journal, and recovering it took a physical console and a USB stick per node.                  |
| `nm-convert.sh`     | The 2026-09-07 SSID rename. claw-1 (NetworkManager) reassociated unaided; claw-3 (ifupdown) did not, because ifupdown never retries, and recovering it cost a garage trip. Moves a node's radio to NetworkManager — verifying with `nmcli` BEFORE it touches the ifupdown config, and arming a boot watchdog that undoes the whole thing if the node comes back without an address. See the note below. |

## Running one

The stick is Ventoy-formatted: partition 1 is Ventoy's ISO store, and the data
partition is labelled `CLAWKIT`. **Ventoy puts its own 32MB `VTOYEFI` partition
at number 2, so `CLAWKIT` is usually partition 3** — `fleet usb-prep` prints the
device it actually created rather than assuming a number, and `blkid -L CLAWKIT`
finds it on the target.

At the console, with the stick plugged in BEFORE power-on:

```
GRUB -> e -> append  init=/bin/bash  -> Ctrl-X

mount -t proc proc /proc
mount /dev/sdb3 /mnt          # the device usb-prep printed; blkid -L CLAWKIT
sh /mnt/fixes/claw-admin-fix.sh

sync && exec /sbin/init
```

The device letter is the node's, not the control host's, and it differs
between boxes — it was `/dev/sdb1` on claw-1 and `/dev/sda1` on claw-2 and
claw-3 under the old single-partition layout. Check `ls /dev/sd*` from the
recovery shell rather than assuming.

## claw-fix.sh — Debian installed, but node-bootstrap will not run

Different from `claw-admin-fix.sh` in one important way: this one runs on a
**booted, working system** at the console, not in an `init=/bin/bash` recovery
shell. The box is healthy. It just cannot reach anything.

```
sudo mount LABEL=CLAWKIT /mnt
sudo sh /mnt/fixes/claw-fix.sh
```

Add `--check` to diagnose without changing anything.

### Why it exists

Debian's installer will happily build a system with networking skipped — and it
then writes **no interface stanza at all**, because netcfg configures the
interface it was told to configure and it was told none. The box boots, the
ethernet port is live, you plug a cable in, and nothing happens: no DHCP client
runs, because nothing on the box has ever been told that interface exists.

`node-bootstrap.sh` then dies at the jq install saying "check networking", which
is true and useless. claw-5 arrived in exactly this state.

It runs in three phases: **diagnose everything**, then **repair**, then
**re-verify**. It never stops at the first fault — claw-5 had four independent
problems (no interface config, a six-hour clock skew, no apt sources, no jq),
and a stop-on-first-error script means one trip to the garage per fault.

Every check is three-valued: `ok`, `FAIL`, `????`. A check that could not run is
never reported as a pass, and never as a failure either.

### What it checks

Each is a different fault with a different fix, reported separately:

| #   | link                               | a failure here means                          |
| --- | ---------------------------------- | --------------------------------------------- |
| 1   | ethernet controller on the PCI bus | no wired hardware; a cable cannot help        |
| 2   | a driver bound to it               | usually a missing firmware package            |
| 3   | carrier                            | nothing plugged in                            |
| 4   | an interface stanza                | **the claw-5 case** — repaired in place       |
| 5   | an address                         | DHCP did not answer; is the bridge bridging?  |
| 6   | a default route                    | DHCP handed out no gateway                    |
| 7   | DNS resolves                       | resolver problem, not a routing one           |
| 8   | the archive answers                | reachable is not the same as resolvable       |
| 9   | apt has a network source           | a netless install can leave only a CD entry   |
| 10  | jq, curl, ca-certificates          | what node-bootstrap needs to read the profile |

Link 1 is why it exists at all: six trips to the garage were spent on a box
whose only fault was that it had no wireless hardware, and nobody had written
that down.

### It always leaves evidence

Every run writes a diagnostic bundle to `diagnostics/<host>-<stamp>/` **on the
stick**, before the first check and again after any repair. That is deliberate:
a trip that ends in failure still comes back up the stairs carrying data.
Summary, network, netconfig, apt state, PCI, USB, dmesg, failed units, block
devices, and the node-bootstrap log if there is one.

Read it back on the control host with `fleet telemetry`.

If the stick is not writable it falls back to `/var/log/claw-fix/` and says
so. It refuses to believe a kit path that does not contain the kit's own
directories — piped in over ssh it once wrote a bundle to `/home/diagnostics`,
which is not a diagnostic, it is litter.

### Adding a new check

It is expected to grow. Two edits, always the same shape:

1. In `diagnose()`: `record <id> ok|FAIL|???? "what is true"`
2. In `repair()`: a block guarded by `[ "$(state_of <id>)" = FAIL ]`

If it cannot be fixed from software, add the id to `UNREPAIRABLE` instead of
writing an empty repair. `claw-fix.test.mjs` fails the build when a check has
neither a repair nor an entry there, so the halves cannot drift — it caught two
orphaned checks and one contradiction the first time it ran.

## nm-convert.sh — moving a claw's radio from ifupdown to NetworkManager

### Why it is here at all

This directory's rule is "if ssh works, the fix belongs in a deployer with a
`--check`". `nm-convert.sh` is the exception that rule needs, and for the reason
the rule is about: **the thing it changes IS the link a deployer would arrive
over.** claw-2 and claw-3 are Surfaces with no ethernet port at all, so a bad
profile leaves nothing to ssh in on and the recovery is a console at the
physical box, off this stick. It therefore ships here, runs identically over ssh
and at the console, and has a `--rollback` that needs no network.

### Why it exists

On 2026-09-07 the gateway's 5 GHz SSID was renamed. claw-1 (NetworkManager)
reassociated unaided; claw-3 (ifupdown) did not, because **ifupdown never
retries**, and recovering it cost a trip to the garage. claw-2 and claw-3 are
still on ifupdown, so every future SSID or band change carries that bill twice.
Decided by the operator 2026-09-09: NetworkManager everywhere, because it is the
one that self-recovered.

### What stops it stranding a node

Four things, in this order, and the order is the mechanism:

1. **It reads the SSIDs and PSKs off the node's own `wpa_supplicant` config.**
   No secret travels, and a node cannot be converted onto a network it was never
   on.
2. **Verify before teardown.** The NM profiles are written and reloaded while
   ifupdown still owns the radio — a step that cannot break anything. Only after
   `nmcli` reports the radio `connected` on a `fleet-wifi-*` connection, with an
   address and a default route, is `/etc/network/interfaces` touched at all. If
   verification fails the script restores ifupdown in place, exits non-zero, and
   the config file is byte-identical to how it started.
3. **The address must be UNCHANGED.** "Stranded" here does not only mean off the
   air. hokon reaches every claw by a LAN IP pinned in `~/.ssh/config`, and those
   are DHCP leases keyed on the radio's MAC — NetworkManager randomises a wifi
   MAC per connection unless told not to, which draws a NEW lease. A node can
   come back perfectly healthy on a new address and be unreachable from every
   gate in the fleet. `cloned-mac-address=permanent` + `dhcp-client-id=mac`
   prevent it; refusing a conversion whose address moved is what catches it when
   they do not.
4. **A boot watchdog covers the window an in-script rollback cannot.** Armed
   before the radio moves, it runs 45 s after the next boot: if the radio has no
   address and no default route two minutes later, it restores ifupdown and
   reboots, unattended. On a healthy boot it disarms itself — left armed forever
   it would revert a long-converted node the first time the gateway was slow at
   boot, which turns a safety net into a time bomb.

It **reboots**; it never runs `ifdown; ifup`. The 2026-09-07 outage was a failed
`ifdown` leaving `/run/network/ifstate` claiming the interface was still
configured, which made the following `ifup` a silent no-op. `/run` is tmpfs — a
reboot cannot hit that trap.

### IT CANNOT CONVERT A WIFI-ONLY NODE, AND REFUSES TO TRY (2026-09-10)

Read `docs/planning/nm-convert-impasse-2026-09-10.md` before running the runbook
below, because on claw-2 and claw-3 it will stop at the first `--convert`.

ifupdown's `wpa-conf` stanza runs its **own** `wpa_supplicant` for the radio, and
that process owns `/run/wpa_supplicant/<iface>`. NetworkManager drives a
different supplicant, which cannot create a control interface over a socket
another process holds — `wpa_supplicant couldn't grab this interface`, five
retries, then `giving up`. The radio reaches `unavailable` and stops there.

That makes point 2 above — verify before teardown — **unreachable by
construction** on such a node: NM cannot be `connected` until ifupdown lets the
radio go, and only the teardown makes it let go. The script now detects the
competing supplicant and refuses before writing a profile, arming the watchdog or
touching the radio.

claw-7 converted cleanly on 2026-09-09 because its radio was never on ifupdown at
all (its own `interfaces.fleet-pre-nm` carries `allow-hotplug enp8s0` and no wifi
stanza). **No wifi-only node has ever been converted by this script.** The
runbook below is correct for a node whose radio is not held by ifupdown, and is
blocked for one that is, pending the teardown-first redesign in that doc.

### The runbook — one node at a time, drained, in the quiet window

Conversion reboots a live CI node. Drain it first, and do claw-2 and claw-3
**separately**: they are the fleet's only two wifi-only nodes, and taking both
off at once removes the only evidence of what a working one looks like.

```sh
N=claw-3                                    # then repeat the whole block for claw-2

fleet drain "$N" --reason "nm-convert to NetworkManager (issue #8)"
fleet drain --status                        # wait until "$N" has gone quiet
fleet drain-check                           # expect exit 0

ssh "$N" sudo sh -s -- --check         < scripts/fixes/nm-convert.sh  # expect 1, "on IFUPDOWN"
ssh "$N" sudo sh -s -- --convert --yes < scripts/fixes/nm-convert.sh
# The ssh session dies with the reboot. That is expected. Give it ~90s.

ssh "$N" sudo sh -s -- --check  < scripts/fixes/nm-convert.sh  # expect 0, "converged"
ssh "$N" sudo sh -s -- --commit < scripts/fixes/nm-convert.sh  # disarm the watchdog

fleet drain-check                           # expect exit 0
fleet throttle --check                      # expect exit 0
fleet drain "$N" --undo
```

If `--check` does not return 0 after the reboot, **do not re-run `--convert`**:
the watchdog has either already restored ifupdown (the node is reachable and
back where it started — read `journalctl -t fleet-net-rollback`) or the node is
off the network, in which case it is a console job with this stick.
