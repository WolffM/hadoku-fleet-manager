#!/usr/bin/env bash
# usb-device-guard — the refusals `fleet usb-prep` makes before it erases a disk.
#
# WHY THESE ARE SEPARATE FROM THE SCRIPT THAT USES THEM
# ----------------------------------------------------
# Every function here takes OBSERVED VALUES and returns a verdict. Not one of
# them opens a device, reads /sys, or shells out to lsblk. That split is the
# whole point: the observation needs real hardware and cannot be tested, and the
# refusal is where the bugs live and now can be.
#
# It is also the repo's own declared-vs-observed axis applied to a shell script.
# `node-usb-prep.sh` OBSERVES (sysfs, findmnt, lsblk, blockdev) and these
# functions DECIDE. A guard that did its own reading would have to be tested
# against a device the test would first have to create, which is how a check
# ends up never running in CI and being wrong the one time it matters.
#
# THE BUG THIS SPLIT WOULD HAVE CAUGHT, restated from the original script's own
# comment: `lsblk -no PKNAME` returns EMPTY for a btrfs -> LVM -> LUKS -> nvme
# root, so the root-disk guard compared against "" and PASSED FOR EVERY DEVICE,
# including the root disk. Nothing about that is visible from reading the code —
# it needs a test that hands the guard an empty observation and demands a
# refusal. `usb_guard_not_root_disk` refuses an empty list for that reason, and
# `usb-device-guard.test.mjs` is aimed exactly there.
#
# EVERY CHECK IS A REFUSAL, NOT A WARNING. A function here either returns 0 in
# silence or prints why and returns 1. There is no third outcome, and no caller
# is expected to weigh anything.
#
# Sourced, never executed:
#     . "$(dirname "$0")/lib/usb-device-guard.sh"
#
# @guards scripts/node-usb-prep.sh

# The largest stick the fleet uses, in GB. A device bigger than this is being
# mis-targeted — an external backup drive, or an internal disk that somehow
# passed the removable check.
USB_MAX_SIZE_GB="${USB_MAX_SIZE_GB:-512}"

usb_refuse() {
	printf '\n!!! %s\n' "$1" >&2
	return 1
}

# usb_guard_whole_disk <device-path>
#
# We repartition, so a partition is never a valid target. Passing /dev/sdb1
# would wipe the partition table of whatever /dev/sdb turns out to be.
#
# This deliberately OVER-refuses: /dev/nvme0n1 and /dev/mmcblk0 end in a digit
# too and are rejected by the same rule. That is the right trade for a script
# whose only job is USB sticks — the cost is an operator who has to use a plain
# /dev/sd* enclosure, and the alternative is a rule with an exception list, on
# the one code path where being clever destroys data.
usb_guard_whole_disk() {
	local dev="${1:-}" base
	if [ -z "$dev" ]; then
		usb_refuse "no device given. The device is an explicit argument and is NEVER guessed."
		return 1
	fi
	base="${dev##*/}"
	case "$base" in
	*[0-9]) usb_refuse "$dev looks like a PARTITION (or an nvme/mmc device). Pass a whole USB disk, e.g. /dev/sdb" ;;
	*) return 0 ;;
	esac
}

# usb_guard_removable <contents-of-/sys/block/NAME/removable> <device-path>
#
# The single strongest signal that this is the stick and not an internal disk.
# An EMPTY value means the read failed — no such device, or sysfs not mounted —
# and that must refuse. "I could not look" is not "it is removable".
usb_guard_removable() {
	local flag="$1" dev="$2"
	if [ -z "$flag" ]; then
		usb_refuse "could not read the removable flag for $dev — refusing rather than assuming it is a stick"
		return 1
	fi
	if [ "$flag" != "1" ]; then
		usb_refuse "$dev is NOT flagged removable — refusing. Internal disk?"
		return 1
	fi
	return 0
}

# usb_guard_not_root_disk <device-basename> <root-disk-names...>
#
# The root disks are passed in already resolved all the way down the stack —
# hokon's root is btrfs -> LVM -> LUKS -> nvme1n1p3 and only walking it with
# `lsblk -s` reaches the physical disk.
#
# AN EMPTY LIST REFUSES. That is not defensive coding, it is the actual bug:
# with `lsblk -no PKNAME` the list came back empty, the loop below ran zero
# times, and the guard passed for the root disk itself.
usb_guard_not_root_disk() {
	local base="$1"
	shift
	if [ "$#" -eq 0 ] || [ -z "${1:-}" ]; then
		usb_refuse "could not resolve which disk / lives on — refusing rather than guessing"
		return 1
	fi
	local rd
	for rd in "$@"; do
		[ -n "$rd" ] || continue
		if [ "$base" = "$rd" ]; then
			usb_refuse "/dev/$base is the ROOT disk — refusing"
			return 1
		fi
	done
	return 0
}

# usb_guard_no_system_mounts <"part mountpoint" lines...>
#
# A stick auto-mounted under /media or /run is fine and gets unmounted later.
# A partition mounted at a system path means this is not a stick at all.
# No mounts is a PASS here — unlike the root-disk list, an empty result from
# `lsblk -o NAME,MOUNTPOINT` is a real observation and not a failed read.
usb_guard_no_system_mounts() {
	local line part mnt
	for line in "$@"; do
		[ -n "$line" ] || continue
		part="${line%% *}"
		mnt="${line#* }"
		[ "$mnt" != "$line" ] || continue # no mountpoint field: not mounted
		[ -n "$mnt" ] || continue
		case "$mnt" in
		/ | /boot | /boot/* | /home | /usr | /var | /etc | /srv | /opt)
			usb_refuse "$part is mounted at $mnt — refusing"
			return 1
			;;
		esac
	done
	return 0
}

# usb_guard_size <size-in-bytes> <device-path>
#
# A ceiling, because the removable flag is set on some external drives too, and
# a 4TB backup disk that survives every check above is the worst thing this
# script could be pointed at. Zero or empty refuses: a device reporting no size
# was not readable.
usb_guard_size() {
	local bytes="$1" dev="$2" gb
	case "$bytes" in
	'' | *[!0-9]*)
		usb_refuse "could not read the size of $dev (got ${bytes:-empty}) — refusing"
		return 1
		;;
	esac
	if [ "$bytes" -eq 0 ]; then
		usb_refuse "$dev reports a size of 0 bytes — refusing"
		return 1
	fi
	gb=$((bytes / 1000000000))
	if [ "$gb" -gt "$USB_MAX_SIZE_GB" ]; then
		usb_refuse "${gb}GB is larger than any stick we use (ceiling ${USB_MAX_SIZE_GB}GB) — refusing as a mis-target"
		return 1
	fi
	return 0
}

# usb_guard_reserve <reserve-MB> <device-size-bytes>
#
# Ventoy takes the front of the disk and we reserve the tail for CLAWKIT. If the
# reserve does not leave Ventoy room for at least one ISO the operator gets a
# stick that boots nothing, and finds out at the console of a node with no OS.
usb_guard_reserve() {
	local reserve_mb="$1" bytes="$2" total_mb
	case "$reserve_mb" in
	'' | *[!0-9]*)
		usb_refuse "reserve size must be a whole number of MB, got '${reserve_mb}'"
		return 1
		;;
	esac
	if [ "$reserve_mb" -lt 64 ]; then
		usb_refuse "a ${reserve_mb}MB CLAWKIT partition is too small to hold the profile, the fixes and the bootstrap"
		return 1
	fi
	total_mb=$((bytes / 1000000))
	if [ "$((reserve_mb + 4096))" -gt "$total_mb" ]; then
		usb_refuse "reserving ${reserve_mb}MB of a ${total_mb}MB device leaves Ventoy under 4GB — not enough for a Debian ISO"
		return 1
	fi
	return 0
}

# usb_guard_ventoy <path-to-Ventoy2Disk.sh-or-empty>
#
# Ventoy is a THIRD-PARTY INSTALLER and this script does not vendor it, does not
# download it, and does not run an installer it found by guessing. It says
# exactly what to fetch and stops.
usb_guard_ventoy() {
	local path="$1"
	if [ -n "$path" ] && [ -r "$path" ]; then
		return 0
	fi
	usb_refuse "$(
		cat <<'EOF'
Ventoy is not installed and this script will not download it.

  Ventoy is third-party software that writes a bootloader to the stick. Fetch it
  yourself, from a release you have looked at:

      https://github.com/ventoy/Ventoy/releases

      tar xf ventoy-*-linux.tar.gz
      sudo bash scripts/node-usb-prep.sh --ventoy-dir ./ventoy-*/ ...

  Or set VENTOY_DIR. If Ventoy is already on the stick and you only want to
  refresh the CLAWKIT partition, pass --skip-ventoy instead.
EOF
	)"
	return 1
}

# usb_guard_pubkey <path>
#
# Validate the operator's key HERE, on the control host, where it can still be
# fixed — not on the box that is about to harden sshd around it.
#
# garage-server-bazooka.sh v6 validates the key too, and that check stays: this
# one catches a bad key one whole phase earlier, before it is written to a stick
# and carried to a garage. Findings 1 and 2 of the claw-1 retrospective are both
# "sshd was hardened around a key that was not there", and four of that cluster
# were unrecoverable over the network.
usb_guard_pubkey() {
	local key="$1"
	if [ -z "$key" ]; then
		usb_refuse "no ssh public key given. node-bootstrap.sh hardens sshd around it, and a node imaged without one is a node with no way in."
		return 1
	fi
	if [ ! -f "$key" ]; then
		usb_refuse "ssh public key not found: $key"
		return 1
	fi
	if [ ! -s "$key" ]; then
		usb_refuse "ssh public key is EMPTY: $key"
		return 1
	fi
	# THE PRIVATE-KEY CHECK COMES FIRST, and the order is the whole point. A
	# private key file contains no `ssh-ed25519 ...` line, so the key-type check
	# below would already refuse it — with "this does not look like a public key",
	# which is true and unhelpful. Naming the actual mistake is what stops the
	# operator retrying with the same file. It also catches the case the type
	# check CANNOT: a file holding a private key AND a public line is still a
	# private key, and copying one onto a stick that gets carried between nodes
	# is a different and much worse mistake than copying the wrong public key.
	if grep -q 'PRIVATE KEY' "$key"; then
		usb_refuse "$key contains a PRIVATE KEY. Pass the .pub file — this stick is carried between nodes."
		return 1
	fi
	if ! grep -qE '^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp|sk-ssh-ed25519|sk-ecdsa-sha2) ' "$key"; then
		usb_refuse "$key does not contain a public key. Expected a line starting ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp…"
		return 1
	fi
	return 0
}
