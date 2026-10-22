#!/usr/bin/env bash
# refresh-preseed.sh — rewrite the preseed on an existing stick. No erase.
#
#   sudo bash refresh-preseed.sh            # payload + preseed; keeps wifi/password
#   sudo bash refresh-preseed.sh --reset    # ask for them again
#
# The preseed lives on the Ventoy (exFAT) partition and is the only thing that
# changed. Ventoy itself, the ISO and the CLAWKIT payload are untouched, so this
# takes a second instead of rebuilding a 755MB stick.
#
# It reuses the wifi credentials and console password already on the stick, so a
# refresh after a code change costs no typing. --reset asks for them again. The
# hostname is never asked here — that happens at the node, which is the point of
# one stick imaging a whole fleet.
set -uo pipefail
# Defined, not assumed. `set -u` does not catch an undefined FUNCTION, so a
# status line became a fatal error mid-run.
say() { printf '%s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
die() { printf '\n!!! %s\n\n' "$*" >&2; exit 1; }
# Resolve from this script's own location, never a hardcoded checkout.
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/make-preseed.sh
. "$HERE/lib/make-preseed.sh"

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
OWNER="${SUDO_USER:-$(id -un)}"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"

# The fleet key, derived the same way onboarding does it.
KEY="$(sudo -u "$OWNER" ssh -G claw-1 2>/dev/null | awk '/^identityfile /{print $2; exit}')"
case "$KEY" in "~/"*) KEY="$OWNER_HOME/${KEY#\~/}" ;; esac
KEY="$KEY.pub"
[ -f "$KEY" ] || { echo "cannot find the fleet key at $KEY"; exit 1; }
echo "  fleet key: $(basename "$KEY")"

# THE PAYLOAD FIRST, AND BY DELEGATION.
#
# node-usb-prep.sh is the one piece of code that knows how to lay out a stick.
# Reimplementing the payload write here would be a second copy of that
# knowledge, and the two would drift the first time either changed.
#
# Its output is NOT discarded. It was, to keep this script's own output tidy,
# and the first time the child took longer than a second the operator saw one
# line and then six minutes of nothing — unable to tell a slow write from a hang
# from a prompt waiting on an answer it could not see. Hiding a child's stdout
# is only safe when the child can never need attention, and this one writes to a
# device that can be slow or damaged.
#
# --refresh-payload leaves partition 1 and the installer ISO alone, so this is
# seconds rather than a rebuild. FLEET_CONFIRMED_DEVICE is passed so the
# operator is asked once, here, rather than again by the child.
STICK_DEV="$(blkid -L CLAWKIT | sed 's/[0-9]*$//')"
[ -n "$STICK_DEV" ] || die "no CLAWKIT partition — is the stick in?"
# REUSE AN EXISTING MOUNT RATHER THAN INSISTING ON OUR OWN.
#
# An interrupted usb-prep leaves CLAWKIT mounted at /mnt/clawkit-prep. A fresh
# `mount -o ro` then fails with "would change RO state", and this script died
# telling the operator the stick was unidentifiable when it was merely already
# open. This command runs precisely when a previous attempt went wrong, so it
# has to tolerate that attempt's leftovers.
KIT_PART="$(blkid -L CLAWKIT)"
PROFILE_ON_STICK=""
EXISTING="$(awk -v d="$KIT_PART" '$1==d {print $2; exit}' /proc/mounts)"
if [ -n "$EXISTING" ]; then
	say "  $KIT_PART is already mounted at $EXISTING — reusing it"
	PROFILE_ON_STICK="$(basename "$(ls "$EXISTING"/profiles/*.json 2>/dev/null | head -1)" .json 2>/dev/null)"
else
	KM="$(mktemp -d)"
	if mount -o ro "$KIT_PART" "$KM" 2>/dev/null; then
		PROFILE_ON_STICK="$(basename "$(ls "$KM"/profiles/*.json 2>/dev/null | head -1)" .json 2>/dev/null)"
		umount "$KM"
	fi
	rmdir "$KM" 2>/dev/null
fi

# Not fatal on its own. "Which profile" has one answer when the manifest
# declares one, and refusing to act on it helps nobody.
if [ -z "$PROFILE_ON_STICK" ] || [ "$PROFILE_ON_STICK" = "*" ]; then
	PROFILE_ON_STICK="$(bash "$HERE/node-usb-prep.sh" --list-profiles 2>/dev/null | awk 'NR==1{print $1}')"
	[ -n "$PROFILE_ON_STICK" ] || die "cannot read a profile from the stick or the manifest"
	say "  could not read the profile off the stick — using $PROFILE_ON_STICK"
fi

say "  refreshing the CLAWKIT payload ($PROFILE_ON_STICK)"
FLEET_CONFIRMED_DEVICE="$STICK_DEV" \
	bash "$HERE/node-usb-prep.sh" --device "$STICK_DEV" --profile "$PROFILE_ON_STICK" \
	--pubkey "$KEY" --refresh-payload --confirm \
	|| die "payload refresh failed"
ok "payload updated"

# VENTOY'S ISO FILE IS NOW OPTIONAL — §6.1 (#51).
#
# A stick built with `node-usb-prep.sh --netinst-iso` carries Debian on its
# own DINSTALL partition, never as a file on Ventoy's exFAT partition, so
# Ventoy may legitimately have ZERO .iso files on it — it is kept only for
# "every other image" per the operator's decision. This must not be the "no
# ISO on the stick" refusal it used to be; that refusal is still correct when
# NEITHER delivery mechanism is present (checked below, after CLAWKIT is
# read), which is the actual "this stick cannot install anything" case.
V="$(blkid -L Ventoy)" || { echo "no Ventoy partition — is the stick plugged in?"; exit 1; }
M="$(mktemp -d)"; trap 'umount "$M" 2>/dev/null; rmdir "$M" 2>/dev/null' EXIT
mount "$V" "$M" || exit 1

ISO="$(basename "$(ls "$M"/*.iso 2>/dev/null | head -1)" 2>/dev/null)"
if [ -n "$ISO" ]; then
	echo "  stick: $V   installer (Ventoy, legacy path): $ISO"
else
	echo "  stick: $V   no .iso on Ventoy (expected for a §6.1 netinst-partition stick)"
fi

# CLAWKIT, READ-WRITE THIS TIME — the earlier mount above (for PROFILE_ON_STICK)
# was read-only and is already closed. This is where the netinst partition's
# preseed-carrier (install/preseed-initrd.cpio.gz) and its build record
# (install/NETINST.meta) live; see docs/planning/installer-partition-2026-10-02.md.
EXISTING_KIT="$(awk -v d="$KIT_PART" '$1==d {print $2; exit}' /proc/mounts)"
if [ -n "$EXISTING_KIT" ]; then
	KM="$EXISTING_KIT"
	KM_OURS=false
else
	KM="$(mktemp -d)"
	mount "$KIT_PART" "$KM" || die "could not mount CLAWKIT read-write to write the preseed cpio"
	KM_OURS=true
fi
trap '[ "$KM_OURS" = true ] && { umount "$KM" 2>/dev/null; rmdir "$KM" 2>/dev/null; }; umount "$M" 2>/dev/null; rmdir "$M" 2>/dev/null' EXIT

HAS_NETINST=false
[ -f "$KM/$NETINST_META_REL" ] && HAS_NETINST=true

# could-not-look must never render as nothing-is-wrong: a stick with no ISO
# anywhere and no netinst partition cannot install anything, and that is the
# refusal this used to be for a missing Ventoy ISO alone.
if [ -z "$ISO" ] && [ "$HAS_NETINST" != true ]; then
	die "no installer on this stick at all — no .iso on Ventoy and no $NETINST_PART_NAME partition recorded on CLAWKIT. Rebuild it: node-usb-prep.sh (optionally --netinst-iso), or drop a Debian ISO onto the Ventoy partition yourself."
fi
[ "$HAS_NETINST" = true ] && echo "  stick: $KIT_PART   installer (netinst partition, §6.1): $(netinst_meta_read "$KM" name)"

USER_NAME="$(node -e 'import("$HERE/lib/node-profiles.mjs").then(m=>console.log(m.nodeProfile("desktop-debian-trixie").users.fleetUser))' 2>/dev/null || echo hadoku)"
TZ_NOW="$(timedatectl show -p Timezone --value 2>/dev/null || echo Etc/UTC)"

# REUSE WHAT THE STICK ALREADY CARRIES.
#
# The preseed being replaced holds the SSID, the passphrase and the password
# hash in plain text — netcfg needs them that way. So re-typing them on every
# refresh is asking the operator for something already sitting on the device
# being written. Read them back and default to keeping them; --reset re-asks.
#
# TWO SOURCES, because either half of the stick may be the only one that has
# ever been written: Ventoy's preseed.cfg (the legacy path, when an ISO is
# present there) is preferred when it exists, and the netinst partition's own
# embedded cpio preseed is the fallback for a stick that has only ever used
# §6.1 and never carried a Ventoy-side preseed at all.
OLD="$M/ventoy/script/preseed.cfg"
OLD_SRC=""
if [ -f "$OLD" ]; then
	OLD_SRC="$OLD"
elif [ "$HAS_NETINST" = true ] && [ -f "$KM/$NETINST_CPIO_REL" ]; then
	OLD_SRC="$(mktemp)"
	preseed_initrd_cpio_read "$KM/$NETINST_CPIO_REL" >"$OLD_SRC" 2>/dev/null || OLD_SRC=""
fi
SSID=""; PSK=""; HASH=""; TZ_OLD=""
if [ -n "$OLD_SRC" ] && [ -f "$OLD_SRC" ] && [ "${1:-}" != "--reset" ]; then
	SSID="$(sed -n 's/^d-i netcfg\/wireless_essid string //p' "$OLD_SRC" | head -1)"
	PSK="$(sed -n 's/^d-i netcfg\/wireless_wpa string //p' "$OLD_SRC" | head -1)"
	HASH="$(sed -n 's/^d-i passwd\/user-password-crypted password //p' "$OLD_SRC" | head -1)"
	TZ_OLD="$(sed -n 's/^d-i time\/zone string //p' "$OLD_SRC" | head -1)"
	[ -n "$SSID" ] && echo "  reusing wifi: $SSID" || echo "  no wifi on the existing preseed"
	[ -n "$HASH" ] && echo "  reusing the existing console password"
fi
[ -n "$TZ_OLD" ] && TZ_NOW="$TZ_OLD"

# Only ask for what is genuinely missing.
if [ -z "$SSID" ]; then
	read -r -p "  Preload wifi? [y] [N]: " W </dev/tty
	case "$(printf '%s' "$W" | tr 'A-Z' 'a-z')" in
	y | yes) read -r -p "  SSID: " SSID </dev/tty
		read -r -s -p "  Passphrase: " PSK </dev/tty; echo ;;
	esac
fi

GEN=""
if [ -z "$HASH" ]; then
	read -r -s -p "  Console password for $USER_NAME (enter to generate): " PW </dev/tty; echo
	if [ -z "$PW" ]; then PW="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)"; GEN="$PW"; fi
	HASH="$(printf '%s' "$PW" | openssl passwd -6 -stdin)"
fi

RENDERED="$(mktemp)"
render_preseed "$USER_NAME" "$HASH" "$SSID" "$PSK" "$KEY" "$TZ_NOW" > "$RENDERED"

if [ -n "$ISO" ]; then
	mkdir -p "$M/ventoy/script"
	cp "$RENDERED" "$M/ventoy/script/preseed.cfg"
	chmod 600 "$M/ventoy/script/preseed.cfg"
	cat > "$M/ventoy/ventoy.json" <<J
{
  "control": [
    { "VTOY_DEFAULT_IMAGE": "/$ISO" },
    { "VTOY_MENU_TIMEOUT": "5" },
    { "VTOY_SECONDARY_BOOT_MENU": "0" }
  ],
  "auto_install": [
    { "image": "/$ISO", "template": "/ventoy/script/preseed.cfg", "autosel": 1 }
  ]
}
J
	python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$M/ventoy/ventoy.json" || { echo "ventoy.json invalid"; exit 1; }
fi

if [ "$HAS_NETINST" = true ]; then
	mkdir -p "$KM/$(dirname "$NETINST_CPIO_REL")"
	preseed_build_initrd_cpio "$RENDERED" "$KM/$NETINST_CPIO_REL" ||
		die "could not build $NETINST_CPIO_REL"
	chmod 600 "$KM/$NETINST_CPIO_REL"
fi
rm -f "$RENDERED"
sync

echo
echo "  ✓ preseed rewritten"
PRESEED_FOR_REPORT="${OLD:-}"
[ -f "$M/ventoy/script/preseed.cfg" ] && PRESEED_FOR_REPORT="$M/ventoy/script/preseed.cfg"
if [ -f "$PRESEED_FOR_REPORT" ]; then
	grep -c '^d-i\|^popularity\|^tasksel' "$PRESEED_FOR_REPORT" | xargs -I{} echo "    {} directives"
	grep -q 'get_hostname seen false' "$PRESEED_FOR_REPORT" && echo "    hostname: asked at the node during install"
fi
[ "$HAS_NETINST" = true ] && echo "    netinst partition preseed (cpio) rewritten: $NETINST_CPIO_REL"
[ -n "$SSID" ] && echo "    wifi: $SSID"
[ -n "$GEN" ] && { echo; echo "    CONSOLE PASSWORD (generated — write it down): $GEN"; }
