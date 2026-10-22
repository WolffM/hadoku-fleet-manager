#!/usr/bin/env bash
# add-dvd — put a full Debian DVD on the stick so a node with no working
# network during install can still be installed.
#
#   sudo bash scripts/add-dvd.sh
#
# A netinst carries a base system and almost nothing else; everything else comes
# from the mirror. On a node whose wifi does not come up in the installer, that
# means no openssh-server, and a node without ssh needs a console for every
# subsequent step.
#
# DVD-1 carries enough to install offline. It is ~4 GB, fetched once here where
# the link is good, and it lives on the stick beside the netinst — Ventoy lists
# both, so a node with ethernet can still take the small one.
set -uo pipefail
B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
say() { printf '%s\n' "$*"; }
ok() { printf '   %s✓%s %s\n' "$G" "$N" "$*"; }
die() { printf '\n%s!!! %s%s\n\n' "$R" "$*" "$N" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run with sudo"
OWNER="${SUDO_USER:-$(id -un)}"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
CACHE="${XDG_CACHE_HOME:-$OWNER_HOME/.cache}/hadoku-fleet/iso"
MIRROR="${DEBIAN_DVD_MIRROR:-https://cdimage.debian.org/debian-cd/current/amd64/iso-dvd}"
mkdir -p "$CACHE"; chown -R "$OWNER" "${CACHE%/iso}" 2>/dev/null || true

say "fetching the DVD checksum list"
curl -fsSL --retry 2 -o "$CACHE/DVD-SHA256SUMS" "$MIRROR/SHA256SUMS" \
	|| die "could not reach $MIRROR"
ISO_NAME="$(awk '/-DVD-1\.iso$/ {print $2; exit}' "$CACHE/DVD-SHA256SUMS")"
[ -n "$ISO_NAME" ] || die "no DVD-1 image listed at $MIRROR"
ISO_SHA="$(awk -v n="$ISO_NAME" '$2==n {print $1; exit}' "$CACHE/DVD-SHA256SUMS")"
ISO="$CACHE/$ISO_NAME"
ok "$ISO_NAME"

if [ -f "$ISO" ] && [ "$(sha256sum "$ISO" | cut -d' ' -f1)" = "$ISO_SHA" ]; then
	ok "already cached and verified"
else
	say "downloading ~4 GB (resumable — this is the slow part, and it happens here"
	say "on a good link rather than on the node)"
	curl -fL --retry 3 -C - --progress-bar -o "$ISO" "$MIRROR/$ISO_NAME" || die "download failed"
	[ "$(sha256sum "$ISO" | cut -d' ' -f1)" = "$ISO_SHA" ] \
		|| die "CHECKSUM MISMATCH — delete $ISO and retry"
	chown "$OWNER" "$ISO" 2>/dev/null || true
	ok "downloaded and verified"
fi

V="$(blkid -L Ventoy)" || die "no Ventoy partition — is the stick in?"
M="$(mktemp -d)"; trap 'umount "$M" 2>/dev/null; rmdir "$M" 2>/dev/null' EXIT
mount "$V" "$M" || die "could not mount $V"

FREE=$(df -B1 --output=avail "$M" | tail -1)
NEED=$(stat -c%s "$ISO")
[ "$FREE" -gt "$NEED" ] || die "only $((FREE/1000000000))GB free on the stick, need $((NEED/1000000000))GB"

if [ -f "$M/$ISO_NAME" ] && [ "$(sha256sum "$M/$ISO_NAME" | cut -d' ' -f1)" = "$ISO_SHA" ]; then
	ok "already on the stick and verified"
else
	say "copying to the stick"
	cp "$ISO" "$M/$ISO_NAME" || die "copy failed"
	sync
	say "verifying the copy on the stick"
	[ "$(sha256sum "$M/$ISO_NAME" | cut -d' ' -f1)" = "$ISO_SHA" ] \
		|| die "the copy does NOT match — do not use this stick"
	ok "copied and verified"
fi

# Point auto_install at the DVD. The netinst stays; Ventoy lists both.
cat >"$M/ventoy/ventoy.json" <<J
{
  "control": [
    { "VTOY_DEFAULT_IMAGE": "/$ISO_NAME" },
    { "VTOY_MENU_TIMEOUT": "5" },
    { "VTOY_SECONDARY_BOOT_MENU": "0" }
  ],
  "auto_install": [
    { "image": "/$ISO_NAME", "template": "/ventoy/script/preseed.cfg", "autosel": 1 }
  ]
}
J
python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$M/ventoy/ventoy.json" \
	|| die "the ventoy.json just written is not valid JSON"

# An offline install MUST be allowed to use the media as a package source, which
# the netinst preseed deliberately forbids. Flip it here, and have late_command
# strip the cdrom lines afterwards so the INSTALLED system still points at the
# mirror rather than at a disc about to be unplugged.
PS="$M/ventoy/script/preseed.cfg"
if [ -f "$PS" ]; then
	sed -i 's|^d-i apt-setup/cdrom/set-first boolean false|d-i apt-setup/cdrom/set-first boolean true|' "$PS"
	sed -i 's|^d-i apt-setup/disable-cdrom-entries boolean true|d-i apt-setup/disable-cdrom-entries boolean false|' "$PS"
	grep -q 'sources.list.d/cdrom' "$PS" || sed -i \
		's|    in-target systemctl enable ssh|    in-target sed -i "/cdrom:/d" /etc/apt/sources.list ; \\\n    in-target systemctl enable ssh|' "$PS"
	ok "preseed switched to an offline (media-sourced) install"
fi
sync
say ""
printf '%s━━ DVD READY ━━%s\n\n' "$G$B" "$N"
say "   The stick now holds both images. It boots the DVD by default and"
say "   installs with NO network at all."
say ""
say "   ${DIM}netinst is still there — pick it at the Ventoy menu on a node that"
say "   has working ethernet.${N}"
