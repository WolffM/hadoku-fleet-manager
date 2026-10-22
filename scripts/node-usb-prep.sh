#!/usr/bin/env bash
# node-usb-prep.sh — build the stick that images and repairs a fleet node.
#
# `fleet usb-prep`. Phase IMAGE in docs/VOCABULARY.md: bare metal -> an OS that
# boots. Was claw-usb-prep.sh, which made a single-purpose ext4 stick carrying
# one recovery script.
#
#   sudo bash scripts/node-usb-prep.sh                                     # interactive, dry run
#   sudo bash scripts/node-usb-prep.sh --device /dev/sdb --profile desktop-debian-trixie \
#        --pubkey ~/.ssh/id_ed25519.pub --confirm            # scriptable
#
# THE LAYOUT, AND WHY IT IS VENTOY
# --------------------------------
# Partition 1 is Ventoy's. Drop `debian-13.iso` onto it and it boots; drop a
# second ISO beside it later and you pick at boot.
#
# Multi-ISO is NOT here because a distro change is planned — it is not. Every
# node runs Debian Trixie and `os.distro` in the profile says so per node. It is
# here because the alternative, one dd'd stick per ISO, means the recovery
# script lives on whichever stick you did not bring, and because a stick that
# can carry a second image costs nothing until the day it is needed.
#
# The tail of the disk is an ext4 partition labelled CLAWKIT carrying the
# profile, the fixes and the bootstrap. ext4, NOT vfat, and that is inherited
# reasoning worth restating: the stick gets read inside an `init=/bin/bash`
# shell where there is no udev and no auto-modprobe, so vfat may not be loadable
# at all. ext4 is already the root filesystem on every claw.
#
# VENTOY'S OWN LAYOUT PUTS ITS 32MB `VTOYEFI` PARTITION AT NUMBER 2, so CLAWKIT
# lands at 3 on a normal install. This script does not assume a number — it
# diffs the partition table before and after, and prints the device it actually
# created. `blkid -L CLAWKIT` finds it on the target.
#
# WHAT WAS KEPT FROM claw-usb-prep.sh, VERBATIM IN SPIRIT
# -------------------------------------------------------
# All of the safety scaffolding, now in `lib/usb-device-guard.sh` so it can be
# tested without a block device:
#
#   - the removable-flag check, refusing on an unreadable flag as well as on 0
#   - the root disk resolved ALL THE WAY DOWN the btrfs -> LVM -> LUKS stack,
#     because `lsblk -no PKNAME` returns empty for hokon's root and the guard
#     then compared against "" and passed for every device including that root
#   - the size ceiling
#   - refusal on a partition rather than a whole disk
#   - sha256 verify after copy, and a parse check on the copy
#   - DRY RUN BY DEFAULT; `--confirm` acts
#
# THE DEVICE IS AN EXPLICIT ARGUMENT AND IS NEVER GUESSED. The interactive mode
# below LISTS candidates with size and model so the operator can recognise
# theirs; it does not preselect one, and there is no default. Every check is a
# refusal, not a warning.
#
# VENTOY IS THIRD-PARTY AND IS NOT VENDORED. If it is not present the script
# says exactly what to fetch and stops. It does not download an installer that
# writes a bootloader.
#
# @guards scripts/lib/usb-device-guard.sh
# @guards manifests/node-profiles.json

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/usb-device-guard.sh
. "$HERE/lib/usb-device-guard.sh"
. "$HERE/lib/stick-stamp.sh"
# shellcheck source=lib/make-preseed.sh
. "$HERE/lib/make-preseed.sh"

LABEL=CLAWKIT
MNT=/mnt/clawkit-prep
VENTOY_MNT=/mnt/clawkit-prep-ventoy
RESERVE_MB_DEFAULT=1024
# Headroom added on top of the ISO's own size when sizing the netinst
# partition — sfdisk aligns to 1MiB boundaries, and this absorbs that
# rounding plus a little slack rather than sizing the partition to the exact
# byte count the ISO happened to be built at.
NETINST_PAD_MB=8

DEV=""
PROFILE=""
PUBKEY=""
CONFIRM=false
SKIP_VENTOY=false
# Rewrite the payload on an existing stick WITHOUT reformatting it. A refresh
# must not destroy telemetry or saved installer logs sitting on CLAWKIT — that
# is usually the reason the refresh is happening.
REFRESH_PAYLOAD=false
VENTOY_DIR="${VENTOY_DIR:-}"
RESERVE_MB="$RESERVE_MB_DEFAULT"
# §6.1 (#51): the Debian netinst ISO, written RAW onto its own GPT partition —
# see docs/planning/installer-partition-2026-10-02.md. Empty means "no
# netinst partition on this build", which is the default and leaves the
# existing Ventoy-ISO-file workflow untouched for every other image.
NETINST_ISO=""

die() {
	printf '\n!!! %s\n' "$1" >&2
	exit 1
}
say() { printf '\n=== %s ===\n' "$1"; }

# ── the site facts, RESOLVED IN PREFLIGHT ───────────────────────────────────
#
# Split from the write on purpose, and the split is the whole lesson. The first
# version resolved and wrote in one function, called where the payload is
# assembled — which is AFTER `rm -rf bootstrap fixes` and after mkfs. So the
# first real run died on an unresolvable LAN having already cleared the stick,
# and left a CLAWKIT partition with no payload on it at all. The refusal was
# right; its POSITION was not.
#
# Anything that can refuse must refuse before anything is destroyed. These
# lookups touch the network and another host, so they are exactly the kind that
# fails on a bad day.
SITE_LAN=""
SITE_SSID=""
SITE_PSK=""
SITE_SSID2=""

# The network address of `ip/prefix`, in BASH ARITHMETIC.
#
# NOT awk. The first version used and()/or()/lshift()/rshift(), which are GAWK
# EXTENSIONS — Debian ships mawk, and mawk answers "function and never defined"
# five times and yields an empty string. It was written against gawk semantics
# and never run on the machine that builds sticks. Bash's own arithmetic needs
# no external binary at all, which is the better answer regardless.
netaddr() {
	local ip="$1" plen="$2" a b c d v m
	case "$plen" in
	'' | *[!0-9]*) return 1 ;;
	esac
	[ "$plen" -ge 1 ] && [ "$plen" -le 32 ] || return 1
	IFS=. read -r a b c d <<<"$ip" || return 1
	[ -n "$d" ] || return 1
	v=$(((a << 24) | (b << 16) | (c << 8) | d))
	m=$(((0xFFFFFFFF << (32 - plen)) & 0xFFFFFFFF))
	v=$((v & m))
	printf '%d.%d.%d.%d/%d' $(((v >> 24) & 255)) $(((v >> 16) & 255)) $(((v >> 8) & 255)) $((v & 255)) "$plen"
}

resolve_site_facts() {
	local owner="${SUDO_USER:-$(id -un)}"
	local peer="" dev="" src="" plen="" harvest=""
	SITE_LAN="${FLEET_LAN_CIDR:-}"
	SITE_SSID="${FLEET_WIFI_SSID:-}"
	SITE_PSK="${FLEET_WIFI_PSK:-}"
	SITE_SSID2="${FLEET_WIFI_SSID_FALLBACK:-}"

	# EVERY LOOKUP IS `|| true`. This file runs under `set -euo pipefail`, where a
	# command substitution exiting non-zero takes the whole script down — and an
	# unreachable claw-1 is a normal Tuesday, not a reason to abort a stick build.
	if [ -z "$SITE_LAN" ]; then
		# THE LAN IS "THE NETWORK THIS HOST REACHES THE FLEET ON" — a definition,
		# not a guess. NOT the default-route interface: hokon carries a NordVPN
		# tunnel that can hold the default route, and 10.5.0.0/16 is a range no
		# claw is on. `ssh -G` for the address, as the INVOKING user, because this
		# runs under sudo and root has no ~/.ssh/config.
		peer="$(sudo -u "$owner" ssh -G claw-1 2>/dev/null | awk '/^hostname /{print $2; exit}' || true)"
		if [ -n "$peer" ]; then
			dev="$(ip route get "$peer" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}' || true)"
			src="$(ip route get "$peer" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
			if [ -n "$dev" ] && [ -n "$src" ]; then
				plen="$(ip -o -4 addr show dev "$dev" 2>/dev/null | awk -v s="$src" '{split($4,a,"/"); if(a[1]==s){print a[2]; exit}}' || true)"
			fi
			if [ -n "$src" ] && [ -n "$plen" ]; then
				SITE_LAN="$(netaddr "$src" "$plen" || true)"
			fi
		fi
	fi

	# REFUSED, never defaulted — and refused HERE, where nothing has been touched
	# yet. A stick without this produces a box that stops at a console asking for
	# a variable, which is the burden this whole mechanism removes.
	if [ -z "$SITE_LAN" ]; then
		die "could not work out the LAN range, and the profile ships a documentation placeholder that node-bootstrap REFUSES.
  Nothing has been changed. Set it explicitly and re-run:

    sudo FLEET_LAN_CIDR=<your-lan>/24 bash $0 ...

  It is derived with 'ip route get' against claw-1's address from ~/.ssh/config, so this
  usually means ssh config has no claw-1, or this host is not on the fleet LAN right now."
	fi

	# WIFI, READ OFF A NODE THAT ALREADY HAS IT WORKING. Deliberately NOT from the
	# preseed: that holds ONE SSID chosen for the INSTALLER, and on this LAN it is
	# the 2.4 GHz name — handing it to the converted node as its primary would pin
	# a claw to a band measured at 33-38 Mbit/s against 5 GHz's 146-218. The claws
	# already carry both in the right priority order, worked out the hard way, so
	# it is copied rather than re-decided. Highest autoconnect-priority first.
	if [ -z "$SITE_SSID" ]; then
		harvest="$(sudo -u "$owner" ssh -o BatchMode=yes -o ConnectTimeout=8 claw-1 \
			'for c in $(sudo nmcli -t -f NAME con show 2>/dev/null); do
			   s=$(sudo nmcli -t -g 802-11-wireless.ssid con show "$c" 2>/dev/null)
			   p=$(sudo nmcli -t -g connection.autoconnect-priority con show "$c" 2>/dev/null)
			   k=$(sudo nmcli -s -t -g 802-11-wireless-security.psk con show "$c" 2>/dev/null)
			   [ -n "$s" ] && printf "%s\t%s\t%s\n" "${p:-0}" "$s" "$k"
			 done' 2>/dev/null | sort -rn || true)"
		if [ -n "$harvest" ]; then
			SITE_SSID="$(printf '%s\n' "$harvest" | awk -F'\t' 'NR==1{print $2}' || true)"
			SITE_PSK="$(printf '%s\n' "$harvest" | awk -F'\t' 'NR==1{print $3}' || true)"
			SITE_SSID2="$(printf '%s\n' "$harvest" | awk -F'\t' 'NR==2{print $2}' || true)"
		fi
	fi
}

write_site_env() {
	local dest="$MNT/bootstrap/site.env"
	umask 077
	{
		echo "# Written by node-usb-prep.sh. Site facts node-bootstrap needs that the"
		echo "# PUBLISHED profile must not carry. Sourced by convert.sh; a variable"
		echo "# already set in the environment WINS over this file."
		echo "FLEET_LAN_CIDR='$SITE_LAN'"
		if [ -n "$SITE_SSID" ]; then echo "FLEET_WIFI_SSID='$SITE_SSID'"; fi
		if [ -n "$SITE_PSK" ]; then echo "FLEET_WIFI_PSK='$SITE_PSK'"; fi
		if [ -n "$SITE_SSID2" ]; then echo "FLEET_WIFI_SSID_FALLBACK='$SITE_SSID2'"; fi
	} >"$dest"
	chmod 600 "$dest"
	say "wrote bootstrap/site.env (mode 600)"
}

usage() {
	# QUOTED delimiter. This block takes no variables, and unquoted it made
	# `bash scripts/onboarding.sh` in the prose a command substitution — so
	# printing --help would have RUN onboarding.
	cat <<'EOF'
usage: sudo bash scripts/node-usb-prep.sh [options]

  Most operators want `bash scripts/onboarding.sh` instead — it asks for all
  of the below and elevates itself. This is the scriptable half.

  --device /dev/sdX      the whole USB disk. NEVER guessed, never defaulted.
  --profile ID           node profile to install (see: fleet usb-prep --list-profiles)
  --pubkey FILE          ssh PUBLIC key to authorise on the new node
  --confirm              actually do it. Without this it is a dry run.
  --ventoy-dir DIR       extracted ventoy-*-linux release (or set VENTOY_DIR)
  --skip-ventoy          the stick already has Ventoy; only refresh $LABEL
  --refresh-payload      rewrite the payload in place; do NOT reformat $LABEL
  --reserve-mb N         size of the $LABEL partition (default $RESERVE_MB_DEFAULT)
  --netinst-iso FILE     write FILE raw onto its own partition (#51, §6.1) so
                         d-i boots from it directly, never through Ventoy's
                         loop presentation. FULL REBUILD ONLY — refused with
                         --refresh-payload or --skip-ventoy, because it needs
                         to grow Ventoy's own reservation to make room.
  --list-profiles        print the declared profiles and exit

With --device, --profile and --pubkey all given, nothing is prompted for and the
run is scriptable. With any of them missing it walks you through it — but only on
a terminal: it will not prompt into a pipe.
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
	--device) DEV="${2:-}" && shift 2 ;;
	--profile) PROFILE="${2:-}" && shift 2 ;;
	--pubkey) PUBKEY="${2:-}" && shift 2 ;;
	--ventoy-dir) VENTOY_DIR="${2:-}" && shift 2 ;;
	--reserve-mb) RESERVE_MB="${2:-}" && shift 2 ;;
	--netinst-iso) NETINST_ISO="${2:-}" && shift 2 ;;
	--confirm) CONFIRM=true && shift ;;
	--skip-ventoy) SKIP_VENTOY=true && shift ;;
	--refresh-payload) REFRESH_PAYLOAD=true && SKIP_VENTOY=true && shift ;;
	--list-profiles) LIST_ONLY=true && shift ;;
	-h | --help)
		usage
		exit 0
		;;
	*) die "unknown option: $1 (try --help)" ;;
	esac
done

# ── the profile resolver ────────────────────────────────────────────────────
# Shelled out to, never reimplemented here. node-profiles.mjs is the single
# implementation of "which profile is that, and is it coherent", and it THROWS
# on a missing manifest rather than handing back an empty profile — a stick
# written from an empty profile images a node into a shape nobody declared and
# prints a green summary doing it.
#
# `sudo` resets PATH through secure_path, so root may not see the node the
# operator installed. Say that plainly instead of failing as "command not found".
NODE_BIN="${FLEET_NODE_BIN:-$(command -v node || command -v nodejs || true)}"
profiles() {
	[ -n "$NODE_BIN" ] || die "node is not on PATH (sudo resets it). Re-run with 'sudo -E', or set FLEET_NODE_BIN=/path/to/node."
	"$NODE_BIN" "$HERE/lib/node-profiles.mjs" "$@"
}

if [ "${LIST_ONLY:-false}" = true ]; then
	profiles list
	exit 0
fi

[ "$(id -u)" = 0 ] || die "must run as root (use sudo)"

for tool in lsblk findmnt blockdev wipefs sfdisk partprobe mkfs.ext4 sha256sum blkid; do
	command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

# ── §6.1 (#51): preflight the netinst partition before anything is touched ──
#
# Same rule resolve_site_facts states above: anything that can refuse must
# refuse before anything is destroyed. This is a FULL REBUILD feature — it has
# to grow Ventoy's own reservation to make room for a new partition, and
# Ventoy's reservation is only chosen when Ventoy itself is (re)installed.
NETINST_ISO_BYTES=""
NETINST_ISO_MB=""
if [ -n "$NETINST_ISO" ]; then
	for tool in dd cpio gzip; do
		command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool (needed for --netinst-iso)"
	done
	[ "$SKIP_VENTOY" != true ] ||
		die "--netinst-iso needs a full rebuild (it grows Ventoy's own reservation) — refused with --refresh-payload or --skip-ventoy. Rebuild the whole stick, or omit --netinst-iso and run it once as a separate full rebuild."
	[ -f "$NETINST_ISO" ] || die "--netinst-iso $NETINST_ISO does not exist"
	NETINST_ISO_BYTES="$(wc -c <"$NETINST_ISO" | tr -d '[:space:]')"
	[ "$NETINST_ISO_BYTES" -gt 0 ] || die "--netinst-iso $NETINST_ISO is empty"
	NETINST_ISO_MB=$(((NETINST_ISO_BYTES + 1048575) / 1048576 + NETINST_PAD_MB))
	KIT_MB="$RESERVE_MB"
	RESERVE_MB=$((RESERVE_MB + NETINST_ISO_MB))
	echo "    netinst iso:   $NETINST_ISO ($((NETINST_ISO_BYTES / 1000000))MB, partition sized ${NETINST_ISO_MB}MB)"
fi

# ── interactive walkthrough ─────────────────────────────────────────────────
# Only on a terminal. Prompting into a pipe either hangs a cron job forever or
# reads whatever the pipe happened to contain as an answer to "which disk shall I
# erase", and the second is far worse than the first.
interactive() { [ -t 0 ] && [ -t 1 ]; }

ask() {
	local prompt="$1" reply
	printf '%s' "$prompt" >&2
	IFS= read -r reply || die "input closed"
	printf '%s' "$reply"
}

# ── one shape for every question ──────────────────────────────────────────────
# This walkthrough used to ask three questions three different ways: type a
# whole device path, type a profile name, type a filesystem path. The operator
# had to already know the valid answer to each, and the formats did not even
# agree with one another. Every question is now the same numbered menu and the
# answer is always a number.
#
# Each item is "LABEL<TAB>VALUE": the label is shown, the value is returned. No
# tab means the two are the same string.
choose() {
	local title="$1"
	shift
	local -a items=("$@")
	local i reply n="$#"
	printf '\n  \033[1m%s\033[0m\n' "$title" >&2
	for i in "${!items[@]}"; do
		printf '    %2d) %s\n' "$((i + 1))" "${items[$i]%%$'\t'*}" >&2
	done
	while :; do
		printf '\n  number [1-%d]: ' "$n" >&2
		IFS= read -r reply || die "input closed"
		case "$reply" in
		'' | *[!0-9]*)
			printf '  not a number. Type one of 1-%d.\n' "$n" >&2
			continue
			;;
		esac
		if [ "$reply" -ge 1 ] && [ "$reply" -le "$n" ]; then
			printf '%s' "${items[$((reply - 1))]##*$'\t'}"
			return 0
		fi
		printf '  out of range. Type one of 1-%d.\n' "$n" >&2
	done
}

# WHOSE home, not root's. This script runs under sudo, so `$HOME` is /root and
# the operator's keys are not in it. `SUDO_USER` is the only thing that knows
# who actually invoked it.
oper_home() {
	if [ -n "${SUDO_USER:-}" ]; then
		getent passwd "$SUDO_USER" | cut -d: -f6
	else
		printf '%s' "$HOME"
	fi
}

# THE KEY THE FLEET ALREADY USES, read rather than guessed.
#
# A menu of every .pub in ~/.ssh is honest and useless: the operator's GitHub
# key and a landing-pull key look exactly as plausible as the fleet's, and
# picking one of those authorises a key no node holds and then hardens sshd
# around it — locking the fleet out of the box it just imaged.
#
# Whatever `IdentityFile` the claw Host blocks name IS that key, by definition:
# it is what every existing node already authorises. Empty output is fine and
# means "no opinion" — the menu just loses its marker.
fleet_key() {
	awk '
		/^[Hh]ost[ \t]/ { claw = ($0 ~ /claw/) }
		claw && $1 ~ /^[Ii]dentity[Ff]ile$/ { print $2; exit }
	' "$(oper_home)/.ssh/config" 2>/dev/null
}

# Candidates as menu items, one per line, "LABEL<TAB>/dev/NAME".
# Zero candidates is a FINDING, not an empty menu: a stick that is plugged in
# but not flagged removable is refused by the guard below anyway, so the caller
# stops rather than offering a menu with nothing in it.
list_candidates() {
	local name size model rm_flag
	while read -r name size model; do
		rm_flag="$(cat "/sys/block/$name/removable" 2>/dev/null || echo '?')"
		[ "$rm_flag" = 1 ] || continue
		printf '%-12s %-9s %s\t/dev/%s\n' "/dev/$name" "$size" "${model:-unknown}" "$name"
	done < <(lsblk -dno NAME,SIZE,MODEL 2>/dev/null)
}

if [ -z "$DEV" ] || [ -z "$PROFILE" ] || [ -z "$PUBKEY" ]; then
	interactive || die "--device, --profile and --pubkey are all required when not on a terminal. This script will not prompt into a pipe."
fi

if [ -z "$DEV" ]; then
	mapfile -t DEV_CHOICES < <(list_candidates)
	[ "${#DEV_CHOICES[@]}" -gt 0 ] ||
		die "no removable devices found — plug the stick in, or check \`lsblk\`"
	DEV="$(choose 'Which USB stick?' "${DEV_CHOICES[@]}")"
fi

# ── canonicalize DEV, BEFORE ANY GUARD SEES IT ──────────────────────────────
#
# The manager's own instruction is to name the device by its stable
# /dev/disk/by-id/... path — but that path is a SYMLINK, and its name
# routinely ends in a digit that has nothing to do with partitioning (a SCSI
# target:lun suffix, e.g. "...-0:0"). `usb_guard_whole_disk`'s `*[0-9]`
# partition heuristic (lib/usb-device-guard.sh, not this file's to edit)
# cannot tell that apart from a real partition number and refuses it as a
# partition. Even past that guard, `BASE="${DEV##*/}"` below and every
# `"${DEV}1"`-style partition path built further down would resolve against
# the SYMLINK's own name, not the device it points at, and silently fail.
#
# So DEV is resolved to its real block-device path HERE, immediately after it
# is chosen (by flag or by prompt) and before the first guard runs — every
# later use, including every guard, then sees only the canonical path.
# `readlink -f` on an already-canonical `/dev/sdX` is a no-op, so this runs
# unconditionally rather than special-casing symlinks.
#
# Marked with inert sentinels (`:` is the shell no-op builtin, same device
# make-preseed.sh's TARGET-GUARD-CHECK uses) so make-preseed.test.mjs can
# slice this exact span out of THIS file and execute it against a real
# symlink fixture, without sourcing the rest of a script that assumes it is
# root and about to partition a disk.
: DEV-RESOLVE-BEGIN
GIVEN_DEV="$DEV"
DEV="$(readlink -f "$GIVEN_DEV" 2>/dev/null || true)"
[ -n "$DEV" ] && [ -b "$DEV" ] ||
	die "$GIVEN_DEV did not resolve to a block device (readlink -f gave '${DEV:-nothing}') — refusing to guess"
echo "    given:         $GIVEN_DEV"
echo "    resolved to:   $DEV"
: DEV-RESOLVE-END

if [ -z "$PROFILE" ]; then
	mapfile -t PROFILE_CHOICES < <(profiles list | awk 'NF {print $0 "\t" $1}')
	[ "${#PROFILE_CHOICES[@]}" -gt 0 ] || die "no profiles declared in node-profiles.json"
	PROFILE="$(choose 'Which node profile?' "${PROFILE_CHOICES[@]}")"
fi

if [ -z "$PUBKEY" ]; then
	# The PUBLIC half. node-bootstrap.sh authorises this for the fleet user and
	# then hardens sshd around it, so the wrong key here locks the fleet out of
	# the node it just imaged.
	FLEET_KEY="$(fleet_key)"
	FLEET_KEY="${FLEET_KEY/#\~/$(oper_home)}"
	: PUBKEY-CHOICES-BEGIN
	# SEEN is set before the loop and read with a default. Under `set -u` the
	# first `case " $SEEN "` used to kill this subshell on its first key, so the
	# list came back EMPTY and the die below blamed a missing ~/.ssh/*.pub that
	# was present all along.
	SEEN=''
	mapfile -t KEY_CHOICES < <(
		# The fleet's key first and marked, every other key after it. Sorting
		# rather than filtering: an operator re-keying the fleet needs the
		# others to still be reachable.
		for f in "$FLEET_KEY.pub" "$(oper_home)"/.ssh/*.pub; do
			[ -f "$f" ] || continue
			case " ${SEEN:-} " in *" $f "*) continue ;; esac
			SEEN="${SEEN:-} $f"
			if [ "$f" = "$FLEET_KEY.pub" ]; then
				printf '%-28s %-42s  <- the key every claw already authorises\t%s\n' \
					"${f##*/}" "$(cut -d' ' -f3 "$f")" "$f"
			else
				printf '%-28s %s\t%s\n' "${f##*/}" "$(cut -d' ' -f3 "$f")" "$f"
			fi
		done
	)
	: PUBKEY-CHOICES-END
	[ "${#KEY_CHOICES[@]}" -gt 0 ] ||
		die "no .pub files in $(oper_home)/.ssh — pass --pubkey with the path"
	PUBKEY="$(choose 'Which ssh PUBLIC key should the new node authorise?' "${KEY_CHOICES[@]}")"
fi
# Tilde survives a prompt as a literal; expand it rather than failing on a path
# the operator typed correctly.
case "$PUBKEY" in "~/"*) PUBKEY="$HOME/${PUBKEY#\~/}" ;; esac

# ── refusals ────────────────────────────────────────────────────────────────
say "safety checks on $DEV"

usb_guard_whole_disk "$DEV" || exit 1
[ -b "$DEV" ] || die "$DEV is not a block device"
BASE="${DEV##*/}"

usb_guard_removable "$(cat "/sys/block/$BASE/removable" 2>/dev/null || true)" "$DEV" || exit 1
echo "    removable:     yes"

# The root disk, resolved all the way down. findmnt's btrfs subvolume suffix
# (`/dev/mapper/x[/@rootfs]`) is stripped first because lsblk cannot parse it,
# then `lsblk -s` walks the whole stack to the physical disks underneath.
ROOT_SRC="$(findmnt -no SOURCE / | sed 's/\[.*//' || true)"
ROOT_DISKS="$(lsblk -sln -o NAME,TYPE "$ROOT_SRC" 2>/dev/null | awk '$2=="disk"{print $1}')"
# Unquoted on purpose: the guard takes the disks as separate arguments, and an
# empty expansion becomes zero arguments — which is exactly what it refuses.
# shellcheck disable=SC2086
usb_guard_not_root_disk "$BASE" $ROOT_DISKS || exit 1
echo "    not root disk: yes (root is on: $(echo "$ROOT_DISKS" | tr '\n' ' '))"

mapfile -t MOUNTS < <(lsblk -nr -o NAME,MOUNTPOINT "$DEV" | awk 'NF>1{print "/dev/"$1, $2}')
usb_guard_no_system_mounts "${MOUNTS[@]}" || exit 1
echo "    no system mounts on it: yes"

SIZE_BYTES="$(blockdev --getsize64 "$DEV" 2>/dev/null || true)"
usb_guard_size "$SIZE_BYTES" "$DEV" || exit 1
SIZE_GB=$((SIZE_BYTES / 1000000000))
MODEL="$(lsblk -ndo MODEL "$DEV" 2>/dev/null | sed 's/  */ /g;s/^ //;s/ $//')"
echo "    size:          ${SIZE_GB}GB"
echo "    model:         ${MODEL:-unknown}"

usb_guard_reserve "$RESERVE_MB" "$SIZE_BYTES" || exit 1
echo "    ${LABEL} reserve: ${RESERVE_MB}MB"

usb_guard_pubkey "$PUBKEY" || exit 1
echo "    ssh pubkey:    $(cut -d' ' -f1,3- <"$PUBKEY" | head -1)"

# Resolving the profile is itself a check: an unknown id, a malformed profile or
# an unreadable manifest all fail HERE, before anything is erased.
PROFILE_JSON="$(profiles show "$PROFILE")" || die "could not resolve profile '$PROFILE' — nothing was changed"
PROFILE_ROLE="$(printf '%s' "$PROFILE_JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).role))')"
PROFILE_CHASSIS="$(printf '%s' "$PROFILE_JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).power.chassis))')"
echo "    profile:       $PROFILE (role=$PROFILE_ROLE chassis=$PROFILE_CHASSIS)"

# RESOLVED HERE, IN PREFLIGHT, BESIDE THE OTHER SAFETY CHECKS — before the
# confirm gate and long before mkfs. See resolve_site_facts: doing this at
# payload-assembly time meant the first real run refused AFTER clearing the
# stick, leaving a CLAWKIT partition with nothing on it.
resolve_site_facts
echo "    site LAN:      $SITE_LAN"
if [ -n "$SITE_SSID" ]; then
	echo "    site wifi:     $SITE_SSID${SITE_SSID2:+ (fallback $SITE_SSID2)}"
else
	echo "    site wifi:     NONE resolved — a box with a radio will refuse to convert"
fi

VENTOY_SH=""
if [ "$SKIP_VENTOY" != true ]; then
	for cand in "${VENTOY_DIR%/}/Ventoy2Disk.sh" "$(command -v Ventoy2Disk.sh 2>/dev/null || true)"; do
		[ -n "$cand" ] && [ -r "$cand" ] && VENTOY_SH="$cand" && break
	done
	usb_guard_ventoy "$VENTOY_SH" || exit 1
	echo "    ventoy:        $VENTOY_SH"
else
	# --skip-ventoy must not become "no Ventoy at all". If partition 1 does not
	# look like Ventoy's, the stick will not boot anything and the operator would
	# only discover that at the console of a node with no OS.
	P1_LABEL="$(blkid -o value -s LABEL "${DEV}1" 2>/dev/null || true)"
	[ "$P1_LABEL" = "Ventoy" ] || die "--skip-ventoy given, but ${DEV}1 is labelled '${P1_LABEL:-nothing}', not 'Ventoy'. Refusing: this stick would boot nothing."
	echo "    ventoy:        already present on ${DEV}1 (kept)"
fi

# ── the summary ─────────────────────────────────────────────────────────────
if [ -n "${FLEET_CONFIRMED_DEVICE:-}" ]; then
	ISO_NOTE="fleet onboard copies the installer on and verifies it once this finishes."
elif [ -n "$NETINST_ISO" ]; then
	ISO_NOTE="nothing — the F6 entry boots the netinst partition written in step 5,
              not an ISO on the Ventoy partition."
else
	ISO_NOTE="put an installer ISO on the Ventoy partition yourself. This script
              does not fetch ISOs and does not check that one is there."
fi
say "what will happen"
if [ "$SKIP_VENTOY" = true ]; then
	cat <<EOF
    DEVICE:   $DEV  (${SIZE_GB}GB, ${MODEL:-unknown})
    KEEP:     ${DEV}1 — Ventoy and every ISO already on it
    ACTION:   reformat the $LABEL partition (or create it in free space) and
              write the payload below onto it.
    THE $LABEL PARTITION'S CONTENTS WILL BE DESTROYED. The ISOs will not.
EOF
else
	NETINST_STEP=""
	if [ -n "$NETINST_ISO" ]; then
		NETINST_STEP="
              5. write $NETINST_ISO raw onto its own partition ($NETINST_PART_NAME)
                 and a custom GRUB menu that boots d-i from it directly (#51)"
	fi
	cat <<EOF
    DEVICE:   $DEV  (${SIZE_GB}GB, ${MODEL:-unknown})
    ACTION:   1. ERASE the whole disk
              2. install Ventoy, reserving ${RESERVE_MB}MB at the end
              3. make that reserve an ext4 partition labelled $LABEL
              4. write the payload below onto it${NETINST_STEP}
    ALL EXISTING DATA ON $DEV WILL BE DESTROYED — including any ISOs on it.
EOF
fi
cat <<EOF

    PAYLOAD:  profiles/$PROFILE.json      (role=$PROFILE_ROLE chassis=$PROFILE_CHASSIS)
              bootstrap/node-bootstrap.sh
              bootstrap/capability-probe.sh
              bootstrap/authorized_key.pub  ($(basename "$PUBKEY"))
              fixes/                        ($(find "$HERE/fixes" -maxdepth 1 -type f ! -name '*.test.mjs' | wc -l) file(s))
              bootstrap/site.env            (LAN + wifi, mode 600)
              README.txt, MANIFEST.sha256

    AFTER:    ${ISO_NOTE}
EOF
if [ -n "$NETINST_ISO" ]; then
	cat <<EOF
    THEN:     run refresh-preseed.sh before this stick installs anything — it
              is what writes CLAWKIT's $NETINST_CPIO_REL. Until then the GRUB
              menu entry's second initrd image does not exist yet and that
              boot option will fail to load it (loud, at the console, not
              silently).
EOF
fi

if [ "$CONFIRM" != true ]; then
	KEEP_FLAG=""
	[ "$SKIP_VENTOY" = true ] && KEEP_FLAG="--skip-ventoy"
	[ -n "$NETINST_ISO" ] && KEEP_FLAG="$KEEP_FLAG --netinst-iso $NETINST_ISO"
	cat <<EOF

    DRY RUN — nothing was changed.
    Re-run with --confirm to proceed:

        sudo bash scripts/node-usb-prep.sh --device $DEV --profile $PROFILE \\
             --pubkey $PUBKEY $KEEP_FLAG --confirm

EOF
	exit 0
fi

# The second confirmation is skipped when `fleet onboard` already took one for
# THIS EXACT DEVICE. It sets FLEET_CONFIRMED_DEVICE to the path the operator
# confirmed, so the check is still a comparison against what they typed — not a
# blanket "someone said yes". Running this script directly still prompts.
if [ "${FLEET_CONFIRMED_DEVICE:-}" = "$DEV" ]; then
	say "confirmed via fleet onboard"
elif interactive; then
	printf '\n  Type the device path again to confirm you mean it: ' >&2
	IFS= read -r ECHOED || die "input closed"
	[ "$ECHOED" = "$DEV" ] || die "you typed '$ECHOED', not '$DEV' — nothing was changed"
fi

# ── act ─────────────────────────────────────────────────────────────────────
say "unmounting anything already mounted from $DEV"
while read -r part mnt; do
	[ -n "$mnt" ] && umount "$part" 2>/dev/null && echo "    unmounted $part"
done < <(lsblk -nr -o NAME,MOUNTPOINT "$DEV" | awk 'NF>1{print "/dev/"$1, $2}') || true

parts_now() { lsblk -nlo NAME,TYPE "$DEV" | awk '$2=="part"{print $1}' | sort; }

if [ "$SKIP_VENTOY" != true ]; then
	say "installing Ventoy (reserving ${RESERVE_MB}MB)"
	wipefs -a "$DEV" >/dev/null
	# -I forces an install over whatever is there; -r reserves MB at the END of
	# the disk, which is the only supported way to get a partition of our own
	# beside Ventoy's. Ventoy prompts twice for confirmation and would otherwise
	# hang a scripted run — our own confirmation has already happened above, twice.
	printf 'y\ny\n' | sh "$VENTOY_SH" -I -r "$RESERVE_MB" "$DEV" || die "Ventoy install failed — the stick is in an unknown state, re-run from the top"
	partprobe "$DEV" 2>/dev/null || true
	sleep 2
fi

BEFORE="$(parts_now)"
KIT_PART="$(blkid -L "$LABEL" 2>/dev/null || true)"
case "$KIT_PART" in
"$DEV"*) : ;; # an existing CLAWKIT on THIS disk — reuse it
*) KIT_PART="" ;;
esac

if [ -z "$KIT_PART" ]; then
	say "creating the $LABEL partition in free space"
	# `--append` uses the free space that is there rather than a number we
	# computed. Ventoy's own VTOYEFI sits at 2, so this normally lands at 3 —
	# and the diff below is what tells us, instead of an assumption.
	: KIT-SPEC-BEGIN
	# With --netinst-iso the Ventoy reserve is CLAWKIT + the netinst partition,
	# so CLAWKIT gets an explicit size and the rest stays free for partition 4.
	# `,,83` (all free space) here took the whole 1,787 MB reserve on the first
	# real rebuild (2026-10-02) and left the netinst append "Invalid argument".
	KIT_SPEC=',,83'
	[ -z "${NETINST_ISO_MB:-}" ] || KIT_SPEC="size=${KIT_MB}MiB, type=83"
	: KIT-SPEC-END
	echo "$KIT_SPEC" | sfdisk --append "$DEV" >/dev/null || die "could not append a partition to $DEV"
	partprobe "$DEV" 2>/dev/null || true
	sleep 2
	KIT_PART="/dev/$(comm -13 <(printf '%s\n' "$BEFORE") <(parts_now) | tail -1)"
	[ -b "$KIT_PART" ] || die "expected a new partition on $DEV and did not find one — refusing to guess which it is"
	echo "    created $KIT_PART"
else
	echo "    reusing existing $LABEL at $KIT_PART"
fi

# ── §6.1 (#51): the netinst partition — dd the ISO raw, verify, boot menu ──
#
# THE REAL STICK IS MBR (`dos`), NOT GPT — `lsblk -o NAME,PTTYPE,PARTLABEL,LABEL
# /dev/sdg` reads `PTTYPE dos`, `sdg1 Ventoy/exfat`, `sdg2 VTOYEFI`,
# `sdg3 CLAWKIT`, because the Ventoy install above runs `-I -r` with no `-g`.
# Staying `dos` — rather than switching to `-g` for GPT's partition NAME
# field — is deliberate: that would change the operator-approved layout for a
# lookup convenience. So the netinst partition is identified by a FIXED
# NUMBER (`NETINST_PART_NUMBER`, make-preseed.sh) instead of a name, which
# resolves the same way on `dos` and `gpt` alike.
#
# MBR HAS EXACTLY FOUR PRIMARY SLOTS. Ventoy, VTOYEFI and CLAWKIT already use
# three; this is the fourth and LAST one that fits. Refused here, before
# anything is written, if the table is not already exactly three partitions
# deep — a stick with a different history (an old 4th partition from a
# previous attempt, say) gets a named reason instead of sfdisk's own generic
# "no space" error, or worse, silently landing at the wrong number.
NETINST_FS_UUID=""
if [ -n "$NETINST_ISO" ]; then
	EXISTING_PARTS="$(partition_count "$DEV")"
	[ "$EXISTING_PARTS" -lt "$NETINST_PART_NUMBER" ] ||
		die "MBR allows exactly 4 primary partitions, and $DEV already has $EXISTING_PARTS (Ventoy, VTOYEFI, CLAWKIT, +$((EXISTING_PARTS - 3)) more) — there is no room left for a netinst partition on this layout. This should not happen on a fresh Ventoy install; investigate before rebuilding."

	say "creating partition $NETINST_PART_NUMBER (${NETINST_ISO_MB}MB, the $NETINST_PART_NAME label by convention) and writing $NETINST_ISO raw"
	BEFORE2="$(parts_now)"
	printf 'size=%sMiB\n' "$NETINST_ISO_MB" |
		sfdisk --append "$DEV" >/dev/null || die "could not append the netinst partition to $DEV"
	partprobe "$DEV" 2>/dev/null || true
	sleep 2
	DINSTALL_PART="/dev/$(comm -13 <(printf '%s\n' "$BEFORE2") <(parts_now) | tail -1)"
	[ -b "$DINSTALL_PART" ] || die "expected a new partition on $DEV and did not find one — refusing to guess which it is"
	# THE NUMBER IS CROSS-CHECKED, NOT JUST ASSUMED. If the new partition did
	# not land at NETINST_PART_NUMBER — an unexpected pre-existing layout, a
	# sfdisk quirk — every later lookup by number would silently target the
	# wrong partition. Refuse instead of guessing.
	case "$DINSTALL_PART" in
	"${DEV}${NETINST_PART_NUMBER}") : ;;
	*) die "the new partition landed at $DINSTALL_PART, not ${DEV}${NETINST_PART_NUMBER} as expected — refusing to guess which number to use. Nothing after this point ran." ;;
	esac
	echo "    created $DINSTALL_PART (partition $NETINST_PART_NUMBER)"

	# RAW BYTES, NOT A FILESYSTEM WRITE. `conv=fsync` makes dd itself wait for
	# the device to confirm the write rather than returning as soon as the page
	# cache accepted it — on a USB stick that is the difference between "wrote
	# it" and "queued it".
	dd if="$NETINST_ISO" of="$DINSTALL_PART" bs=4M conv=fsync status=progress ||
		die "writing $NETINST_ISO to $DINSTALL_PART failed — the stick is in an unknown state, re-run from the top"
	sync

	# VERIFY WHAT IS ACTUALLY ON THE DEVICE, not what dd claimed to write. Read
	# the partition back through the SAME sfdisk-offset path verify-stick.sh
	# uses, independent of dd's own exit code.
	NETINST_ISO_SHA256="$(sha256sum "$NETINST_ISO" | awk '{print $1}')"
	netinst_verify "$DEV" "$NETINST_PART_NUMBER" "$NETINST_ISO_BYTES" "$NETINST_ISO_SHA256" ||
		die "partition $NETINST_PART_NUMBER does not match $NETINST_ISO after writing it — do NOT use this stick"
	echo "    sha256 verified against the partition's own bytes (not dd's exit code)"

	NETINST_FS_UUID="$(netinst_partition_fs_uuid "$DEV" "$NETINST_PART_NUMBER")"
	[ -n "$NETINST_FS_UUID" ] || die "could not read an iso9660 UUID back off $DINSTALL_PART — the ISO may not be a valid iso9660 image"
	echo "    iso9660 fs-uuid: $NETINST_FS_UUID"

	say "writing the GRUB boot menu to Ventoy's partition"
	mkdir -p "$VENTOY_MNT"
	mount "${DEV}1" "$VENTOY_MNT" || die "could not mount Ventoy's partition (${DEV}1) to write the boot menu"
	mkdir -p "$VENTOY_MNT/ventoy"
	render_netinst_grub_cfg "$NETINST_FS_UUID" "$NETINST_CPIO_REL" >"$VENTOY_MNT/ventoy/ventoy_grub.cfg"
	sync
	umount "$VENTOY_MNT"
	rmdir "$VENTOY_MNT" 2>/dev/null || true
	echo "    wrote ventoy/ventoy_grub.cfg (F6 at Ventoy's boot menu)"
fi

# A stale mount from an interrupted run blocks everything below it. Clear it
# before doing anything, rather than failing on it.
STALE="$(awk -v d="$KIT_PART" '$1==d {print $2; exit}' /proc/mounts)"
if [ -n "$STALE" ]; then
	say "unmounting a leftover $LABEL mount at $STALE"
	umount "$STALE" 2>/dev/null || umount -l "$STALE" 2>/dev/null || true
	rmdir "$STALE" 2>/dev/null || true
fi

if [ "$REFRESH_PAYLOAD" = true ]; then
	say "keeping the existing $LABEL filesystem (payload refresh)"
else
	say "formatting ext4 (label: $LABEL) on $KIT_PART"
	umount "$KIT_PART" 2>/dev/null || true
	mkfs.ext4 -F -L "$LABEL" "$KIT_PART" >/dev/null
fi
echo "    formatted"

say "writing the payload"
mkdir -p "$MNT"
mount "$KIT_PART" "$MNT"
mkdir -p "$MNT/profiles" "$MNT/bootstrap" "$MNT/fixes"

if [ -n "$NETINST_ISO" ]; then
	# Recorded on CLAWKIT (ext4, mutable) rather than on the netinst partition
	# itself (iso9660, dd'd raw — nowhere to append a record to afterward).
	# verify-stick.sh still re-derives the fs-uuid and the checksum live rather
	# than trusting this; it supplies only what nothing else on the stick can
	# re-derive without the original ISO in hand (its recorded byte count and
	# sha256).
	netinst_meta_write "$MNT" "$NETINST_ISO" "$NETINST_FS_UUID"
	echo "    wrote $NETINST_META_REL"
fi

# REPLACE, DO NOT OVERLAY. A payload refresh keeps the filesystem, and copying
# over it leaves behind every file the repo has since deleted or renamed. On
# 2026-09-02 claw-net-fix.sh was renamed to claw-fix.sh; the next refresh wrote
# the new one, kept the old one, and then FAILED verifying — because the verify
# loop walks the STICK and looks each file up in the repo, and the repo no
# longer had it. A stale script on a recovery stick is worse than the failure it
# caused: it is the one an operator reaches for at 1am.
#
# Only the directories this script owns are cleared. telemetry/, diagnostics/
# and inventory/ are the node's own writing and are never touched.
rm -rf "$MNT/bootstrap" "$MNT/fixes"
mkdir -p "$MNT/bootstrap" "$MNT/fixes"

# ── site.env: everything node-bootstrap needs that the PROFILE must not hold ──
#
# THE POINT OF THIS FILE IS THAT THE CONSOLE COMMAND IS `sh convert.sh` AND
# NOTHING ELSE.
#
# node-bootstrap needs two site facts the published profile cannot carry: the
# LAN range (manifests/ is published, so it ships an RFC 5737 placeholder and
# REFUSES it) and the wireless credentials. Until now both had to be typed at
# the console as environment variables, which is the `--surface` flag mistake
# this whole profile system was built to end — a fact living in an operator's
# shell history, retyped per box, at the most expensive keyboard in the system.
# It is also easy to lose silently: `VAR=x sudo sh convert.sh` looks right and
# drops the variable, because sudo resets the environment.
#
# So the CONTROL HOST works them out once, here, where it can actually look
# things up, and the stick carries the answer.
#
# THIS IS NOT A NEW SECRET EXPOSURE. lib/make-preseed.sh's header already states
# the trust boundary: "the wifi PSK and the password hash are written onto the
# CLAWKIT partition, which is unencrypted. Whoever holds the stick holds them.
# That is the same trust boundary as the ssh private key the fleet already
# relies on." The PSK is already on this stick, in the preseed, so the installer
# can associate. Writing it once more for the CONVERT phase adds nothing to the
# blast radius of a lost stick, and README.txt says so.

printf '%s\n' "$PROFILE_JSON" >"$MNT/profiles/$PROFILE.json"
cp "$HERE/node-bootstrap.sh" "$MNT/bootstrap/node-bootstrap.sh"
cp "$HERE/capability-probe.sh" "$MNT/bootstrap/capability-probe.sh"
cp "$HERE/convert.sh" "$MNT/bootstrap/convert.sh"
cp "$PUBKEY" "$MNT/bootstrap/authorized_key.pub"
write_site_env
# Tests are not payload. They shipped once by accident and have no job on a node.
for f in "$HERE"/fixes/*; do
	case "$f" in *.test.mjs) continue ;; esac
	[ -f "$f" ] && cp -a "$f" "$MNT/fixes/"
done

# NO BACKTICKS IN THIS HEREDOC. It is unquoted, because it interpolates $LABEL
# and $PROFILE, so every backtick is command substitution. A line documenting
# the telemetry wrote 'logger -t fleet' in backticks; logger with no message
# reads stdin, and the install hung there with no output and no I/O. Single
# quotes in the prose. usb-prep.test.mjs fails if one reappears.
cat >"$MNT/README.txt" <<EOF
CLAWKIT — hadoku fleet node kit

BEFORE YOU BOOT
  CHECK FOR A REALTEK WIFI CARD AND PULL IT. An RTL8723BE in claw-4 threw
  millions of PCIe errors during install, USB reads timed out, and the
  installer lost this stick mid-run. Two hours of recovery. If the box has one
  and you cannot remove it, boot with pcie_aspm=off.

  Ethernet is the reliable path: the installer fetches every package from the
  Debian mirror. It will use wifi if that is all it finds and credentials were
  preloaded on this stick.

AFTER THE INSTALL, ONE COMMAND DOES BOTH
  Repairs whatever the install left behind, then converts the box into a node:

      sudo mount LABEL=CLAWKIT /mnt
      sudo sh /mnt/bootstrap/convert.sh

  It stops before converting if anything it could not repair is still broken,
  rather than half-converting a box. It will ask for the node name.

IF THE NODE HAS NO NETWORK AFTER INSTALLING
  A network-less install leaves NO interface stanza behind, so the port is live,
  a cable does nothing, and node-bootstrap dies at the jq install. At the
  node's console:

      sudo mount LABEL=CLAWKIT /mnt
      sudo sh /mnt/fixes/claw-fix.sh

  It walks ten links -- controller, driver, cable, config, address, route, DNS,
  archive, apt sources, packages -- repairs what it can, and always writes a
  bundle to diagnostics/ on this stick so a failed trip still returns with data.

IF THE INSTALLER STOPS ON 'Media change' AT 'Select and install software'
  There is NO in-place recovery. Editing sources.list does not reach the apt
  that is already running, and pressing Enter loops forever. Ctrl+Alt+F2 for a
  shell, then:

      mount -t proc proc /proc          # the rescue shell has none; do this first
      nano /target/etc/apt/sources.list # comment the 'deb cdrom:' line
      ps                                # find the stuck apt-get. OUTSIDE any chroot
      kill <that pid>

  Then chroot in and finish by hand -- see docs/planning/, claw-4 post-mortem.

  BEWARE: pkgsel and user-setup fail together, so the fleet user and the sudo
  package may BOTH be missing. Every instruction above that starts with 'sudo'
  is then unusable until you 'adduser hadoku' and 'usermod -aG sudo hadoku'
  from the chroot.

IF THE INSTALL FAILS
  This stick records the machine's own account of itself every ten seconds
  during the install. Bring it back and run:

      sudo bash scripts/read-telemetry.sh

  It says which network interface was chosen, whether the driver bound, and
  whether any firmware was missing.

  The installer's own logs live on its ramdisk, not on this stick. From the failure
  screen: <Go Back> -> "Save debug logs" -> mounted filesystem -> this partition.
  Or Ctrl+Alt+F2 for a shell; 'logger -t fleet' lines in /var/log/syslog say
  which network interface was chosen and why.
built $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(hostname) for profile: $PROFILE

BOOT THE INSTALLER
  Partition 1 is Ventoy. Copy debian-13.iso onto it from any machine and pick it
  at boot. Install Debian minimal: no desktop, ssh server, one user named as the
  profile's users.fleetUser.

CONVERT THE BOX (phase CONVERT)
  Boot the installed system, log in at the console, then:

    sudo mount LABEL=$LABEL /mnt
    sudo bash /mnt/bootstrap/node-bootstrap.sh

    It infers the profile, the key and the hostname. Pass --profile/--pubkey/
    --hostname only to override; it refuses rather than guessing.

  It ends by printing an enrollment record between ENROLL-BEGIN and ENROLL-END.
  KEEP THAT — it is what \'fleet enroll\' reads, and it is the only measurement
  of this box anything will have. Capture it with:

    ... 2>&1 | tee /mnt/enrollment-<hostname>.txt

RECOVER A BOX YOU CANNOT SSH TO
  See fixes/README.md. Short version, at the console with this stick in:

    GRUB -> e -> append  init=/bin/bash  -> Ctrl-X
    mount -t proc proc /proc
    mount \$(blkid -L $LABEL) /mnt
    sh /mnt/fixes/claw-admin-fix.sh
    sync && exec /sbin/init

VERIFY THIS STICK
  cd /mnt && sha256sum -c MANIFEST.sha256
EOF

# Root-owned: the claws read this out of a recovery shell as root, and a uid from
# the control host means nothing over there.
chown -R 0:0 "$MNT"
chmod 755 "$MNT/bootstrap/node-bootstrap.sh" "$MNT/bootstrap/capability-probe.sh"
find "$MNT/fixes" -name '*.sh' -exec chmod 755 {} +
chmod 644 "$MNT/bootstrap/authorized_key.pub" "$MNT/profiles/$PROFILE.json" "$MNT/README.txt"
sync

say "verifying"

# Parse-check with the interpreter the shebang actually names. The original
# script ran `sh -n` because claw-admin-fix.sh is POSIX sh; node-bootstrap.sh is
# bash and `sh -n` would reject it for using arrays. Checking with the wrong
# interpreter is not a weaker check, it is a different and wrong one.
parse_check() {
	local f="$1" shebang
	shebang="$(head -1 "$f")"
	case "$shebang" in
	*bash*) bash -n "$f" || die "the copied $f is not valid bash" ;;
	*) sh -n "$f" || die "the copied $f is not valid sh" ;;
	esac
}

FAILED=0
while IFS= read -r rel; do
	src=""
	case "$rel" in
	bootstrap/node-bootstrap.sh) src="$HERE/node-bootstrap.sh" ;;
	bootstrap/capability-probe.sh) src="$HERE/capability-probe.sh" ;;
	bootstrap/convert.sh) src="$HERE/convert.sh" ;;
	bootstrap/authorized_key.pub) src="$PUBKEY" ;;
	fixes/*) src="$HERE/${rel}" ;;
	esac
	[ -n "$src" ] || continue
	# A FILE ON THE STICK WITH NO SOURCE IN THE REPO is a finding, not a crash.
	# When claw-net-fix.sh was renamed, this loop ran sha256sum against a path
	# that no longer existed and the refresh died on the tool's own error
	# message -- which named the missing source but not what it meant, and left
	# an operator with a half-written stick and no next step.
	if [ ! -f "$src" ]; then
		echo "    STALE  $rel is on the stick but no longer in the repo" >&2
		FAILED=1
		continue
	fi
	a="$(sha256sum "$src" | cut -d' ' -f1)"
	b="$(sha256sum "$MNT/$rel" | cut -d' ' -f1)"
	if [ "$a" != "$b" ]; then
		echo "    MISMATCH $rel" >&2
		FAILED=1
	else
		echo "    sha256 ok  $rel  ${a:0:16}…"
	fi
done < <(cd "$MNT" && find bootstrap fixes -type f | sort)
[ "$FAILED" = 0 ] || die "the stick does not match this checkout after copy — do NOT use this stick"

while IFS= read -r f; do parse_check "$MNT/$f"; done < <(cd "$MNT" && find . -name '*.sh' | sed 's|^\./||')
echo "    every copied script parses"

# The profile has to survive the copy as a PROFILE, not merely as bytes. Read it
# back through the same loader node-bootstrap.sh will use, pointed at the copy on
# the stick — so a truncated write, a full filesystem or a mangled quote is
# caught here rather than in a garage.
profiles check-resolved --file "$MNT/profiles/$PROFILE.json" >/dev/null ||
	die "the profile written to the stick does not load — do NOT use this stick"
echo "    profile on the stick loads and validates"

# SPACE, REPORTED WHILE THE STICK IS STILL IN YOUR HAND. Telemetry and
# diagnostics accumulate on this partition and nothing prunes them -- deleting a
# node's own account of itself is not a decision a build script should make. So
# it is SAID, here, where an operator can act on it, rather than discovered when
# an install has nowhere to write.
KIT_AVAIL_MB=$(df -Pm "$MNT" 2>/dev/null | awk 'NR==2{print $4}')
KIT_USEDPCT=$(df -Pm "$MNT" 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}')
if [ -n "${KIT_AVAIL_MB:-}" ]; then
	echo "    free space: ${KIT_AVAIL_MB}MB (${KIT_USEDPCT}% used)"
	if [ "$KIT_AVAIL_MB" -lt 200 ]; then
		echo ""
		echo "    ⚠  LOW SPACE. An install writes telemetry here every ten seconds, and"
		echo "       a stick that fills mid-install loses the evidence you would need to"
		echo "       diagnose that install. Biggest consumers:"
		du -sh "$MNT"/telemetry/* "$MNT"/diagnostics/* 2>/dev/null | sort -rh | head -5 | sed 's/^/         /'
		echo "       Prune with:  sudo rm -rf $MNT/telemetry/<oldest>"
	fi
fi

# STAMPED BEFORE THE MANIFEST, so the stamp is itself checksummed. A stamp
# outside MANIFEST.sha256 could be edited without the stick noticing, which
# would make it a claim rather than a record.
stamp_write "$MNT" "$(cd "$HERE/.." && pwd)" "$PROFILE"
echo "    stamped: $(sed -n 's/^version=//p' "$MNT/STAMP") $(sed -n 's/^commit=//p' "$MNT/STAMP")"

(cd "$MNT" && find . -type f ! -name MANIFEST.sha256 | sed 's|^\./||' | sort | xargs sha256sum >MANIFEST.sha256)
sync

KIT_REPORT="$KIT_PART"
umount "$MNT"
rmdir "$MNT" 2>/dev/null || true
sync

# "SAFE TO UNPLUG" IS ONLY TRUE WHEN THIS SCRIPT IS THE WHOLE JOB.
#
# Under `fleet onboard` it is not: the installer ISO is copied on AFTER this
# returns. A completion banner here told the operator the stick was finished one
# step early, and unplugging on it yields a bootable stick with no installer —
# which fails at the target, in the garage, rather than here.
if [ -n "${FLEET_CONFIRMED_DEVICE:-}" ]; then
	say "stick prepared"
	echo "    Ventoy:   ${DEV}1"
	echo "    $LABEL:  $KIT_REPORT   (NOT partition 2 — Ventoy's VTOYEFI takes that)"
	echo "    returning to fleet onboard, which copies the installer on next"
else
if [ -n "$NETINST_ISO" ]; then
	NEXT_STEPS="    1. run refresh-preseed.sh — it writes CLAWKIT's $NETINST_CPIO_REL,
       which the GRUB menu entry below needs before it can install anything
    2. DISCONNECT every disk in the node except the one you are
       installing onto (same reason as always — see below)
    3. boot the new node from this stick, at Ventoy's menu press F6 and
       pick 'Install Debian (fleet netinst partition — #51)' — d-i boots
       straight off the $NETINST_PART_NAME partition, never through Ventoy's
       loop-mounted-ISO presentation (§6.1)
    4. mount LABEL=$LABEL and run bootstrap/node-bootstrap.sh
       (README.txt on the stick has the exact command)"
else
	NEXT_STEPS="    1. copy an installer ISO onto the Ventoy partition
    2. DISCONNECT every disk in the node except the one you are
       installing onto. Not optional on a reused chassis: d-i puts
       GRUB on the FIRST disk it sees, not the one it just
       partitioned, and the install then fails at the very last step
       with \"embedding is not possible\" — which reads as a dead
       drive. claw-9 lost an evening and two healthy SSDs to it.
       Add the data disk back AFTER the node is up.
    3. boot the new node from this stick, install Debian minimal
    4. mount LABEL=$LABEL and run bootstrap/node-bootstrap.sh
       (README.txt on the stick has the exact command)"
fi
if [ -n "$NETINST_ISO" ]; then
	VENTOY_NOTE="(no ISO needed — F6 boots partition $NETINST_PART_NUMBER)"
else
	VENTOY_NOTE="(copy an installer ISO onto it yourself)"
fi
cat <<DONE

==========================================================
  USB READY — safe to unplug.

  Ventoy:   ${DEV}1   ${VENTOY_NOTE}
  $LABEL:  $KIT_REPORT
            — NOT partition 2. Ventoy's VTOYEFI takes that number.
            — on the target, find it with: blkid -L $LABEL

  Next, in order:
$NEXT_STEPS

  The enrollment record is read off the node automatically by
  'fleet enroll <name>' — nothing to copy down.

  Verify the stick any time:  sha256sum -c MANIFEST.sha256
==========================================================

DONE
fi
