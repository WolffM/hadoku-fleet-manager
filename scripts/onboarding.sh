#!/usr/bin/env bash
# onboarding.sh — one guided walk from a blank USB stick to a booting installer.
#
#     bash scripts/onboarding.sh
#
# That is the whole interface. It asks; you answer, and it elevates itself when
# it needs root. No flags to remember, no order to know, no manual to read
# first, and no sudo to prefix.
#
# Wherever the CLI is on PATH, `fleet onboard` reaches the same script. Do NOT
# write `sudo fleet onboard` anywhere: sudo resets PATH to secure_path, so that
# form fails with "command not found" even on a machine where `fleet` works.
#
# IT DOES THE SLOW THING FIRST, IN THE BACKGROUND. The 755MB installer is
# needed whatever you answer, so it starts downloading before the first question
# and is joined at step 6. On any reasonable link the wait disappears entirely.
#
# WHAT IT DOES, IN ORDER
#   1. checks every tool it needs and INSTALLS what is missing; finds or fetches
#      Ventoy. Nothing that can stop the run survives this step.
#   2. starts the Debian netinst download in the background
#   3-5. asks: which stick, which profile, which ssh key
#   6. joins the download and verifies it against Debian's signed SHA256SUMS
#   7. hands the destructive part to node-usb-prep.sh, which owns every refusal
#      and is tested (`scripts/lib/usb-device-guard.sh`)
#   8. copies the ISO on, verifies the copy ON THE STICK, and says what to do next
#
# WHY IT DELEGATES RATHER THAN REIMPLEMENTS
# ------------------------------------------
# Everything that can destroy data stays in node-usb-prep.sh. This script is a
# conversation; that one is the surgeon. Duplicating the removable check or the
# root-disk walk here would create a second copy of a guard that has already
# been wrong once — `lsblk -no PKNAME` returning empty for a btrfs->LVM->LUKS
# root, so the check compared against "" and passed for every device including
# the root disk.
#
# THE ISO IS NEVER COMMITTED. It is cached in
# ${XDG_CACHE_HOME:-~/.cache}/hadoku-fleet/iso — outside the repository
# entirely, so there is no path by which `git add` could pick it up. A ~700MB
# binary in a package that publishes `scripts/` would ship to every consumer.
#
# @guards scripts/node-usb-prep.sh

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/make-preseed.sh
. "$HERE/lib/make-preseed.sh"
# THE INVOKING USER'S HOME, not root's. This re-execs under sudo, after which
# $HOME is /root: caching 755MB there means the operator cannot find it, cannot
# clear it, and pays to fetch it again the first time anything runs
# unprivileged. Same for the ssh key — the key that authorises a node lives in
# the operator's ~/.ssh, never root's.
OWNER="${SUDO_USER:-$(id -un)}"
OWNER_HOME="$(getent passwd "$OWNER" 2>/dev/null | cut -d: -f6)"
[ -n "$OWNER_HOME" ] || OWNER_HOME="$HOME"
CACHE="${XDG_CACHE_HOME:-$OWNER_HOME/.cache}/hadoku-fleet/iso"
MIRROR="${DEBIAN_MIRROR:-https://cdimage.debian.org/debian-cd/current/amd64/iso-cd}"
MNT=/mnt/fleet-onboard-ventoy
# Only ever mounted when a netinst partition (#51, §6.1) turns out to be on
# the stick — see the ONBOARD-NETINST-CPIO block below.
MNT_KIT=/mnt/fleet-onboard-clawkit

B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'

say()  { printf '%s\n' "$*"; }
# Bytes -> "755MB". Integer arithmetic only: this runs on a fresh Debian
# netinstall where bc and python are not guaranteed to exist.
fmt_mb() { [ "${1:-0}" -gt 0 ] 2>/dev/null && printf '%sMB' "$(( $1 / 1000000 ))" || printf '~755MB'; }

# asksecret <prompt> - read without echoing. `ask` echoes, which is wrong for a
# wifi PSK typed at a desk with someone else in the room, and wrong for anything
# that ends up in a scrollback the operator later pastes into a chat window.
asksecret() {
	local prompt="$1" reply
	[ -t 0 ] || die "onboarding is interactive and stdin is not a terminal."
	read -r -s -p "   $prompt: " reply </dev/tty || die "cancelled"
	printf '\n' >&2
	printf '%s' "$reply"
}

# pick <keys> - read one of them, or enter for the first.
#
# It owns the WHOLE prompt, which `ask` does not: `ask` appends its own
# "[default]", so a menu built on it rendered "Which profile? [ab] [a]:" — the
# option list and the default, both in brackets, meaning two different things.
# One function, one bracket convention, nothing to reconcile.
pick() {
	local keys="$1" prompt="$2" def="${3:-}" reply i k out=""
	[ -n "$def" ] || def="$(printf '%s' "$keys" | cut -c1)"
	i=1
	while [ "$i" -le "${#keys}" ]; do
		k="$(printf '%s' "$keys" | cut -c"$i")"
		# THE DEFAULT IS UPPERCASE, not a second bracketed value.
		#
		# `ask` appends its own "[default]", so a yes/no built on it rendered
		# "Preload wifi credentials? [no]:" — which the operator read as "no is
		# the only option", and reasonably so. The option list and the default
		# cannot both be brackets. Uppercase is how every other CLI says it.
		# All lowercase. Case-marking the default was a third attempt at encoding
		# two things in one bracket list, after "[ab] [a]" and "(a or b) [a]".
		# It produced "[A] [b]", which reads as a typo rather than as meaning.
		# The options are the options; enter takes the first.
		out="$out[$k] "
		i=$((i + 1))
	done
	[ -t 0 ] || die "onboarding is interactive and stdin is not a terminal. Run it from a shell."
	while :; do
		read -r -p "   $prompt ${out%% }: " reply </dev/tty || die "cancelled"
		reply="$(printf '%s' "$reply" | tr 'A-Z' 'a-z')"
		# People type the whole word. Rejecting "yes" at a prompt that shows
		# [Y] [n] is technically consistent and practically obnoxious.
		case "$reply" in
		yes) reply=y ;;
		no) reply=n ;;
		esac
		# Enter takes the first option. Never a destructive one — the erase is
		# confirmed separately by retyping the device path.
		[ -z "$reply" ] && { printf '%s' "$def"; return 0; }
		case "$keys" in *"$reply"*)
			[ "${#reply}" = 1 ] && { printf '%s' "$reply"; return 0; } ;;
		esac
		printf '   %s!%s pick one of: %s\n' "$Y" "$N" "$keys" >&2
	done
}
step() { printf '\n%s━━ %s %s\n' "$B" "$*" "$N"; }
note() { printf '   %s%s%s\n' "$DIM" "$*" "$N"; }
ok()   { printf '   %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '   %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '\n%s!!! %s%s\n\n' "$R" "$*" "$N" >&2; exit 1; }

cleanup() {
	mountpoint -q "$MNT" 2>/dev/null && umount "$MNT" 2>/dev/null
	rmdir "$MNT" 2>/dev/null
	mountpoint -q "$MNT_KIT" 2>/dev/null && umount "$MNT_KIT" 2>/dev/null
	rmdir "$MNT_KIT" 2>/dev/null
	true
}
trap cleanup EXIT

# A prompt that refuses to guess. Never defaults to a destructive answer, and
# refuses to run at all without a terminal — a guided script piped into
# something has no way to ask, and answering for the operator is how the wrong
# disk gets erased.
ask() {
	local prompt="$1" default="${2:-}" reply
	[ -t 0 ] || die "onboarding is interactive and stdin is not a terminal. Run it from a shell."
	if [ -n "$default" ]; then
		read -r -p "   $prompt [$default]: " reply </dev/tty || die "cancelled"
		printf '%s' "${reply:-$default}"
	else
		read -r -p "   $prompt: " reply </dev/tty || die "cancelled"
		printf '%s' "$reply"
	fi
}

# SELF-ELEVATE rather than telling the operator to prefix it themselves.
#
# `sudo fleet onboard` DOES NOT WORK on Debian and telling anyone to type it was
# wrong: sudo resets PATH to `secure_path` (/usr/sbin:/usr/bin:/sbin:/bin), so a
# node bin on the user's PATH is invisible to root even when `fleet` resolves
# fine unprivileged. Re-execing ourselves by absolute path sidesteps that
# entirely, and means the entry point is the same string whether or not you
# remember the sudo.
if [ "$(id -u)" != 0 ]; then
	command -v sudo >/dev/null 2>&1 || die "this needs root and sudo is not installed"
	say "   this needs root to write a disk — re-running under sudo"
	exec sudo -- "$HERE/$(basename "$0")" "$@"
fi

cat <<BANNER

${B}Fleet node onboarding${N}
${DIM}Builds the USB stick that images and converts a new node.
Nothing is written until you confirm the device by name.${N}
BANNER

# ── 1. the stick ────────────────────────────────────────────────────────────
# ── 1/7  preflight: fix what is missing, then start the download ────────────
#
# TOOLS FIRST, AND INSTALLED RATHER THAN REPORTED. Everything that can stop this
# run is resolved before a single question is asked. Discovering at step 6 that
# Ventoy is absent costs a 755MB round trip for a stop that was predictable in
# the first two seconds.
#
# sbin is searched EXPLICITLY: blkid, mkfs.ext4, sfdisk and partprobe live in
# /sbin, which is not on a normal user's PATH. A preflight that reports a false
# absence sends someone installing packages they already have.
step "1/9  Preflight — tools, Ventoy"

have() {
	command -v "$1" >/dev/null 2>&1 && return 0
	for d in /usr/local/sbin /usr/sbin /sbin; do [ -x "$d/$1" ] && return 0; done
	return 1
}

# tool -> the Debian package that provides it
tool_pkg() {
	case "$1" in
	curl) echo curl ;;
	sha256sum) echo coreutils ;;
	lsblk | blkid | sfdisk) echo util-linux ;;
	mkfs.ext4) echo e2fsprogs ;;
	partprobe) echo parted ;;
	*) echo "" ;;
	esac
}

MISSING=""
PKGS=""
for t in curl sha256sum lsblk blkid mkfs.ext4 sfdisk partprobe; do
	have "$t" && continue
	MISSING="$MISSING $t"
	pkg="$(tool_pkg "$t")"
	case " $PKGS " in *" $pkg "*) ;; *) PKGS="$PKGS $pkg" ;; esac
done

if [ -n "$MISSING" ]; then
	warn "missing:$MISSING"
	if have apt-get; then
		note "provided by:$PKGS"
		# We are already root here, so this can just be done. It is still asked,
		# because installing packages on someone's machine is their call.
		ANS="$(pick 'yn' 'Install them now?' y)"
		case "$ANS" in
		y | Y | yes | YES)
			say "   installing:$PKGS"
			apt-get update -qq && apt-get install -y $PKGS || die "install failed - fix it and re-run"
			STILL=""
			for t in $MISSING; do have "$t" || STILL="$STILL $t"; done
			[ -z "$STILL" ] || die "still missing after install:$STILL"
			ok "installed"
			;;
		*) die "cannot continue without:$MISSING" ;;
		esac
	else
		die "missing:$MISSING and this is not an apt system - install them and re-run"
	fi
else
	ok "required tools present"
fi

# VENTOY. Third-party, so it is fetched only with a yes, from a release the
# operator can see, and its checksum is verified before anything runs it.
VENTOY_SH=""
for c in "${VENTOY_DIR:-}/Ventoy2Disk.sh" "$OWNER_HOME"/ventoy-*/Ventoy2Disk.sh \
	"$OWNER_HOME"/Downloads/ventoy-*/Ventoy2Disk.sh ./ventoy-*/Ventoy2Disk.sh; do
	[ -r "$c" ] && { VENTOY_SH="$c"; break; }
done

if [ -n "$VENTOY_SH" ]; then
	ok "Ventoy: $VENTOY_SH"
	VENTOY_DIR="$(dirname "$VENTOY_SH")"
	export VENTOY_DIR
elif blkid -L Ventoy >/dev/null 2>&1; then
	warn "no Ventoy installer here, but a stick already carries Ventoy"
	note "the CLAWKIT payload can be refreshed without reinstalling the bootloader"
else
	warn "Ventoy is not installed"
	note "It writes the bootloader that lets one stick hold several installers."
	note "Releases: https://github.com/ventoy/Ventoy/releases"
	ANS="$(pick 'yn' 'Download the latest Ventoy release now?' y)"
	case "$ANS" in
	y | Y | yes | YES)
		VT_JSON="$(curl -fsSL https://api.github.com/repos/ventoy/Ventoy/releases/latest)" \
			|| die "could not reach the GitHub API"
		VT_URL="$(printf '%s' "$VT_JSON" | grep -oE 'https://[^"]*ventoy-[0-9.]+-linux\.tar\.gz' | head -1)"
		[ -n "$VT_URL" ] || die "no linux tarball in the latest Ventoy release"
		VT_TGZ="$CACHE/$(basename "$VT_URL")"
		mkdir -p "$CACHE"
		say "   $VT_URL"
		# --progress-bar, not curl's default meter. The default redraws a
		# multi-column table that wraps and smears in a normal terminal; this is
		# one line that fills.
		curl -fL --retry 3 --progress-bar -o "$VT_TGZ" "$VT_URL" \
			|| die "Ventoy download failed"
		tar xf "$VT_TGZ" -C "$OWNER_HOME" || die "could not extract Ventoy"
		chown -R "$OWNER" "$OWNER_HOME"/ventoy-* 2>/dev/null || true
		for c in "$OWNER_HOME"/ventoy-*/Ventoy2Disk.sh; do [ -r "$c" ] && VENTOY_SH="$c"; done
		[ -n "$VENTOY_SH" ] || die "extracted, but Ventoy2Disk.sh is not where expected"
		VENTOY_DIR="$(dirname "$VENTOY_SH")"
		export VENTOY_DIR
		ok "Ventoy ready: $VENTOY_SH"
		;;
	*) die "Ventoy is required to make the stick bootable. Fetch it and re-run." ;;
	esac
fi

# ── 2/7  start the installer download NOW, in the background ────────────────
#
# We know we need it whatever the operator answers, and it is 755MB. Fetching it
# WHILE the questions are being answered turns a two-minute wait into no wait at
# all on any reasonable link. The checksum is verified after the join, never
# before, so a truncated download cannot slip through.
step "2/9  Debian installer — downloading while you answer"
mkdir -p "$CACHE"
chown -R "$OWNER" "${CACHE%/iso}" 2>/dev/null || true

SUMS="$CACHE/SHA256SUMS"
curl -fsSL --retry 2 -o "$SUMS.tmp" "$MIRROR/SHA256SUMS" \
	|| die "could not reach $MIRROR - check the network, or set DEBIAN_MIRROR"
mv "$SUMS.tmp" "$SUMS"

# The point release moves. Read the name from the signed list rather than
# hardcoding a version that 404s silently two months from now.
ISO_NAME="$(awk '/-netinst\.iso$/ {print $2; exit}' "$SUMS")"
[ -n "$ISO_NAME" ] || die "no netinst image listed at $MIRROR"
ISO_SHA="$(awk -v n="$ISO_NAME" '$2==n {print $1; exit}' "$SUMS")"
ISO="$CACHE/$ISO_NAME"
ok "image: $ISO_NAME"

DL_PID=""
DL_LOG="$CACHE/.download.log"
if [ -f "$ISO" ] && [ "$(sha256sum "$ISO" | cut -d" " -f1)" = "$ISO_SHA" ]; then
	ok "already cached and verified - no download needed"
else
	[ -f "$ISO" ] && warn "cached copy failed its checksum - refetching"
	# The real size, so the join can show a percentage rather than a spinner
	# that tells the operator nothing. Best-effort: a mirror that will not answer
	# a HEAD request costs us the percentage, not the download.
	ISO_BYTES="$(curl -fsSIL "$MIRROR/$ISO_NAME" 2>/dev/null \
		| awk 'BEGIN{IGNORECASE=1} /^content-length:/ {n=$2} END{gsub(/\r/,"",n); print n}')"
	say "   starting download in the background ($(fmt_mb "${ISO_BYTES:-0}"), resumable)"
	( curl -fL --retry 3 -C - -o "$ISO" "$MIRROR/$ISO_NAME" >"$DL_LOG" 2>&1 ) &
	DL_PID=$!
	note "carry on - it downloads while you answer the next three questions"
fi

step "3/9  Which USB stick?"
note "Removable disks this machine can see:"
# LETTERED CHOICES, because /dev/sdg and /dev/sdb differ by one character and
# the operator is choosing which disk to destroy. A typo in a free-text device
# path can name a real other disk; a typo in a letter is simply rejected.
#
# The CONFIRMATION later is deliberately NOT a letter. Selecting should be easy,
# destroying should not: the operator retypes the full device path, so the last
# thing they do before the erase is read the name of the thing being erased.
FOUND=0
DEV_LIST=""
DEV_KEYS=""
LETTERS=abcdefghijklmnopqrstuvwxyz
# `lsblk --pairs`, NOT positional fields. MODEL contains spaces on essentially
# every real device ("USB Flash Drive", "Samsung SSD 870 EVO 2TB"), so
# `read -r name size model rm tran` shifts every field after MODEL, `rm` lands
# on the word "Flash", and `[ "$rm" = 1 ]` is false for EVERY disk. That is how
# this reported "no removable disk found" on hokon with the stick plugged in
# and mounted, 2026-08-30.
while IFS= read -r line; do
	NAME=""; SIZE=""; MODEL=""; RM=""; TRAN=""
	eval "$line" 2>/dev/null || continue
	[ "$RM" = "1" ] || continue
	K="$(printf '%s' "$LETTERS" | cut -c$((FOUND + 1)))"
	printf '     %s%s)%s  /dev/%-6s %-9s %-24s %s\n' "$B" "$K" "$N" "$NAME" "$SIZE" "${MODEL:--}" "${TRAN:-?}"
	while read -r _p mp; do
		[ -n "$mp" ] && printf '            %sin use at %s - will be unmounted%s\n' "$DIM" "$mp" "$N"
	done < <(lsblk -nro NAME,MOUNTPOINT "/dev/$NAME" 2>/dev/null | awk 'NF>1{print $1, $2}')
	for lbl in $(lsblk -nro LABEL "/dev/$NAME" 2>/dev/null); do
		case "$lbl" in
		CLAWFIX) printf '            %srecovery stick - will be rebuilt as CLAWKIT (recovery scripts kept)%s\n' "$Y" "$N" ;;
		CLAWKIT) printf '            %salready a CLAWKIT stick - rebuilding it%s\n' "$DIM" "$N" ;;
		Ventoy)  printf '            %salready has Ventoy%s\n' "$DIM" "$N" ;;
		esac
	done
	DEV_KEYS="$DEV_KEYS$K"
	DEV_LIST="$DEV_LIST$K=/dev/$NAME "
	FOUND=$((FOUND + 1))
done < <(lsblk -dnP -o NAME,SIZE,MODEL,RM,TRAN 2>/dev/null)

# Restored guard. An earlier refactor incremented FOUND and never checked it,
# which would have prompted for a choice from an empty list.
if [ "$FOUND" -eq 0 ]; then
	warn "No removable disk found. Plug the stick in and run again."
	note "If it is plugged in it may not report removable - check: lsblk -o NAME,SIZE,MODEL,TRAN,RM"
	exit 1
fi
note "If you are not certain: unplug it, re-run lsblk, plug it back in, diff."

# One candidate is still a choice, not an assumption - it is only the DEFAULT,
# so a confident operator presses enter and a surprised one does not.
while :; do
	K="$(pick "$DEV_KEYS" 'Which stick?')"
	DEV=""
	for pair in $DEV_LIST; do
		[ "${pair%%=*}" = "$K" ] && DEV="${pair#*=}"
	done
	[ -n "$DEV" ] && break
	warn "pick one of: $DEV_KEYS"
done
[ -b "$DEV" ] || die "$DEV is not a block device"
ok "selected $DEV"

# ── 2. the profile ──────────────────────────────────────────────────────────
step "4/9  Which node profile?"
PROF_KEYS=""
PROF_LIST=""
PI=0
while IFS= read -r pline; do
	pid="$(printf '%s' "$pline" | awk '{print $1}')"
	[ -n "$pid" ] || continue
	K="$(printf '%s' "$LETTERS" | cut -c$((PI + 1)))"
	printf '     %s%s)%s  %-24s %s\n' "$B" "$K" "$N" "$pid" "$(printf '%s' "$pline" | cut -f2- | tr '\t' ' ')"
	PROF_KEYS="$PROF_KEYS$K"
	PROF_LIST="$PROF_LIST$K=$pid "
	PI=$((PI + 1))
done < <(bash "$HERE/node-usb-prep.sh" --list-profiles 2>/dev/null)
[ -n "$PROF_KEYS" ] || die "no node profiles found - is FLEET_MANIFEST_DIR pointing at the manifests?"

while :; do
	K="$(pick "$PROF_KEYS" 'Which profile?')"
	PROFILE=""
	for pair in $PROF_LIST; do
		[ "${pair%%=*}" = "$K" ] && PROFILE="${pair#*=}"
	done
	[ -n "$PROFILE" ] && break
	warn "pick one of: $PROF_KEYS"
done
# users.fleetUser, from the profile. Not a guess: the profile is what declares
# which account holds passwordless sudo, and provision-fleet.mjs needs that
# account to exist before it can write system units remotely.
FLEET_USER="$(node -e '
  import("./scripts/lib/node-profiles.mjs")
    .then((m) => console.log(m.nodeProfile(process.argv[1]).users.fleetUser))
    .catch(() => process.exit(1));
' "$PROFILE" 2>/dev/null)"
[ -n "$FLEET_USER" ] || die "profile $PROFILE declares no users.fleetUser"
# The control host's zone, since the profile does not carry one and a fleet in
# one garage is in one timezone.
NODE_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo Etc/UTC)"
ok "selected $PROFILE  (fleet user: $FLEET_USER)"

step "5/9  The fleet ssh key"
# DERIVED FROM ssh ITSELF, NOT ASKED.
#
# This key is not the operator's identity, it is the FLEET's: what
# `scripts/lib/fleet-exec.mjs` presents when it reaches a node, from a cron
# tick, unattended. There is exactly one right answer on any given control host,
# so asking was the wrong shape — and the menu it replaced offered three keys of
# which two were actively wrong, and DEFAULTED to the wrong one.
#
# On hokon (measured 2026-08-30) the three keys in ~/.ssh were:
#   id_ed25519_hokon   the fleet key, passphraseless, what every claw trusts
#   id_ed25519         the operator's GitHub key - HAS A PASSPHRASE
#   phone_landing      a phone's pull key
#
# A node authorised with the middle one comes up fine and is then permanently
# unreachable to every fleet loop, because an unattended ssh cannot answer a
# passphrase prompt. It reads as a dead box. That is the exact failure class
# this codebase is built to refuse, and the onboarding script was walking into
# it by default.
#
# `ssh -G <node>` is the authority: it reports the identity ssh WILL use, after
# config, wildcards and IdentitiesOnly are resolved. Observed state, not a
# guess, and the same discipline as reading a cgroup limit from the kernel
# rather than from systemctl.
FLEET_KEY=""
# Any declared node will do as the reference — the ssh config's fleet Host block
# covers all of them, which is the point of asking ssh rather than reading a
# path out of a file ourselves.
REF_NODE="$(node -e '
  import("./scripts/lib/fleet-exec.mjs")
    .then((m) => { const n = Object.keys(m.loadManifest().nodes ?? m.loadManifest().machines ?? {}); console.log(n[0] ?? ""); })
    .catch(() => console.log(""));
' 2>/dev/null)"
[ -n "$REF_NODE" ] || REF_NODE="claw-1"

KEY_PRIV="$(sudo -u "$OWNER" ssh -G "$REF_NODE" 2>/dev/null | awk '/^identityfile /{print $2; exit}')"
case "$KEY_PRIV" in
"~/"*) KEY_PRIV="$OWNER_HOME/${KEY_PRIV#\~/}" ;;
esac

if [ -n "$KEY_PRIV" ] && [ -f "$KEY_PRIV.pub" ]; then
	FLEET_KEY="$KEY_PRIV.pub"
	note "derived from: ssh -G $REF_NODE  (the identity fleet-exec presents)"
else
	warn "could not derive the fleet key from ssh config"
	note "That means this control host has no Host entry for the fleet, so a new"
	note "node would be reachable only by whatever ssh happens to default to."
	FLEET_KEY="$(ask 'Path to the fleet ssh PUBLIC key')"
fi

[ -f "$FLEET_KEY" ] || die "no such file: $FLEET_KEY"
grep -qE '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-) ' "$FLEET_KEY" \
	|| die "$FLEET_KEY does not look like an ssh PUBLIC key. Never pass a private key here."

# A PASSPHRASE HERE IS FATAL, NOT A WARNING. The fleet's ssh runs from a cron
# tick with nothing to type a passphrase into; a node trusting only this key
# would be unreachable forever and would report as offline rather than as
# misconfigured.
PRIV="${FLEET_KEY%.pub}"
if [ -f "$PRIV" ]; then
	sudo -u "$OWNER" ssh-keygen -y -P '' -f "$PRIV" >/dev/null 2>&1 \
		|| die "$PRIV has a passphrase. The fleet ssh's unattended from a cron tick and
  cannot answer a prompt, so a node trusting only this key is unreachable the
  moment the console is unplugged - and reports as a dead box, not as a
  misconfigured one. Use the fleet's passphraseless key."
	ok "passphraseless - usable unattended"
fi
ok "$(basename "$FLEET_KEY")  $(awk '{print $1, substr($2,1,16)"...", $3}' "$FLEET_KEY" | head -1)"
PUBKEY="$FLEET_KEY"

step "6/9  The new node"
# NO HOSTNAME HERE.
#
# It was asked for and baked into the preseed until 2026-08-30, which quietly
# made this a single-use stick: every node it imaged came up as claw-4. The
# hostname is the one genuinely per-node fact, so the Debian installer asks it
# at the box, and node-bootstrap.sh then reads it back off the running system.
note "The hostname is asked at the node during install, so one stick images the"
note "whole fleet."

# Wifi is OPTIONAL and the offer says why it might not be wanted: a CI node on
# wifi is a node whose builds share a link with everything else on the network.
say ""
note "Used during install if no ethernet is present, and configured on the node"
note "so it keeps working after first boot. Ethernet is still the reliable path."
WIFI_SSID=""
WIFI_PSK=""
case "$(pick 'yn' 'Preload wifi credentials?' n)" in
y | Y | yes | YES)
	WIFI_SSID="$(ask 'SSID')"
	[ -n "$WIFI_SSID" ] || die "an SSID is required once wifi is chosen"
	WIFI_PSK="$(asksecret "Passphrase for $WIFI_SSID")"
	[ ${#WIFI_PSK} -ge 8 ] || die "a WPA passphrase is at least 8 characters"
	ok "$WIFI_SSID (passphrase held, not echoed)"
	;;
*) note "no wifi - this node will need ethernet to install" ;;
esac

# A console password. The claw-1 retrospective is explicit that v5 generated one
# and stored it NOWHERE, which is how the claws ended up with no reachable root.
# Generated here is fine; unrecorded is not, so it is shown and written to the
# stick's README.
NODE_PW="$(asksecret "Console password for $FLEET_USER (enter to generate one)")"
GENERATED_PW=""
if [ -z "$NODE_PW" ]; then
	NODE_PW="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)"
	GENERATED_PW="$NODE_PW"
fi
PW_HASH="$(printf '%s' "$NODE_PW" | openssl passwd -6 -stdin)" \
	|| die "could not hash the password (openssl passwd -6 failed)"
ok "console password set$([ -n "$GENERATED_PW" ] && printf ' (generated - shown at the end)')"

step "7/9  Installer image — checksum"
if [ -n "$DL_PID" ]; then
	# A live percentage, drawn on ONE line, from the file actually growing on
	# disk. Reading the file is better than parsing curl's output: it is what
	# was really written, and it still works after a resume.
	if kill -0 "$DL_PID" 2>/dev/null; then
		while kill -0 "$DL_PID" 2>/dev/null; do
			now="$(stat -c%s "$ISO" 2>/dev/null || echo 0)"
			if [ "${ISO_BYTES:-0}" -gt 0 ] 2>/dev/null; then
				pct=$(( now * 100 / ISO_BYTES ))
				filled=$(( pct * 30 / 100 ))
				bar=""
				i=0
				while [ $i -lt 30 ]; do
					[ $i -lt $filled ] && bar="$bar#" || bar="$bar."
					i=$((i + 1))
				done
				printf '\r   [%s] %3d%%  %s / %s' "$bar" "$pct" "$(fmt_mb "$now")" "$(fmt_mb "$ISO_BYTES")"
			else
				printf '\r   downloaded %s' "$(fmt_mb "$now")"
			fi
			sleep 1
		done
		printf '\r%*s\r' 60 ''
	fi
	# A background download that DIED must not read as one that finished. curl's
	# exit status is the only thing that separates them, and its log says why.
	if ! wait "$DL_PID"; then
		[ -s "$DL_LOG" ] && sed 's/^/     /' "$DL_LOG" >&2
		die "the installer download failed. Nothing has been written to any disk."
	fi
fi
say "   verifying checksum..."
[ -f "$ISO" ] || die "the installer is not where it should be: $ISO"
[ "$(sha256sum "$ISO" | cut -d' ' -f1)" = "$ISO_SHA" ] \
	|| die "CHECKSUM MISMATCH. Do not use this image. Delete $ISO and re-run."
chown "$OWNER" "$ISO" 2>/dev/null || true
ok "$ISO_NAME verified"

# ── 5. hand the destructive part to the tested script ───────────────────────
step "8/9  Prepare the stick"
say ""
say "   ${B}This ERASES $DEV.${N}"
say "   A dry run comes first and changes nothing."
say ""
FLEET_CONFIRMED_DEVICE="$DEV" \
	bash "$HERE/node-usb-prep.sh" --device "$DEV" --profile "$PROFILE" --pubkey "$PUBKEY" \
	|| die "the dry run refused. Nothing was changed — read the refusal above."
say ""
# YES, not the device path.
#
# Retyping the path sounded like the safer ceremony and is not: the operator has
# just read that exact string twice in the dry run, so copying it is muscle
# memory rather than a decision. `YES` is a word nothing on screen supplies, so
# typing it is an act of assent rather than transcription — and node-usb-prep
# still verifies the DEVICE independently, from FLEET_CONFIRMED_DEVICE, so the
# thing being checked is unchanged.
say ""
say "   ${B}Everything on $DEV will be destroyed.${N}"
CONF="$(ask "Type YES to erase $DEV")"
[ "$CONF" = "YES" ] || die "aborted - you typed '$CONF', not YES. Nothing was changed."
FLEET_CONFIRMED_DEVICE="$DEV" \
	bash "$HERE/node-usb-prep.sh" --device "$DEV" --profile "$PROFILE" --pubkey "$PUBKEY" --confirm \
	|| die "usb-prep failed — read above. The stick may be half-written; re-run before using it."

# ── 6. put the ISO on the Ventoy partition ──────────────────────────────────
step "9/9  Installer, preseed and Ventoy config"
# Ventoy's own VTOYEFI is partition 2, so the exFAT data partition is 1. Found
# by label rather than by number, because the numbering is Ventoy's to choose.
VENTOY_PART="$(blkid -L Ventoy 2>/dev/null || true)"
[ -n "$VENTOY_PART" ] || VENTOY_PART="${DEV}1"
[ -b "$VENTOY_PART" ] || die "cannot find the Ventoy partition on $DEV (looked for label 'Ventoy' and ${DEV}1)"
note "Ventoy partition: $VENTOY_PART"

mkdir -p "$MNT"
mount "$VENTOY_PART" "$MNT" || die "could not mount $VENTOY_PART"
# The preseed and Ventoy's own config go on beside the ISO. Both live on the
# Ventoy (exFAT) partition because that is the one Ventoy reads at boot; CLAWKIT
# is not mounted until after the OS is installed.
mkdir -p "$MNT/ventoy/script"
# Rendered ONCE, to a file, rather than piped straight to the Ventoy copy:
# the netinst-partition block below (#81) needs the SAME rendered bytes to
# build install/preseed-initrd.cpio.gz, and rendering is not idempotent on
# its own first line (it stamps the render time), so a second render_preseed
# call here would produce a file that is bytewise different from the one just
# written to Ventoy's partition for no reason a diff could explain.
RENDERED="$(mktemp)"
render_preseed "$FLEET_USER" "$PW_HASH" "$WIFI_SSID" "$WIFI_PSK" "$PUBKEY" "$NODE_TZ" \
	>"$RENDERED" || die "could not render the preseed"
cp "$RENDERED" "$MNT/ventoy/script/preseed.cfg" || die "could not write the preseed"
chmod 600 "$MNT/ventoy/script/preseed.cfg"

# ── the netinst partition's preseed cpio, ONLY WHEN THE STICK HAS ONE (#81) ─
#
# §6.1 (#51): a stick built with `node-usb-prep.sh --netinst-iso` carries a
# SECOND, independent install path — F6 at Ventoy's own boot menu loads d-i
# straight off its own partition, fed by a cpio-wrapped preseed on CLAWKIT
# (install/preseed-initrd.cpio.gz; lib/make-preseed.sh's
# preseed_build_initrd_cpio, the same function refresh-preseed.sh calls).
# Nothing above writes it: node-usb-prep.sh records install/NETINST.meta when
# it lays the partition down but explicitly defers the cpio to a SEPARATE
# run of refresh-preseed.sh afterward — which left a freshly built
# netinst-partition stick with nothing for its own F6 entry to boot into
# until the operator remembered the second command. This reuses the preseed
# `fleet onboard` already rendered above through that SAME shared writer,
# rather than inventing a second way to build the archive.
#
# A STICK WITHOUT THE PARTITION BEHAVES EXACTLY AS BEFORE THIS BLOCK EXISTED.
# `fleet onboard`'s own call to node-usb-prep.sh never passes --netinst-iso
# today, so install/NETINST.meta will not exist on CLAWKIT and this is a
# no-op — the check below, not an assumption about what onboarding builds.
#
# clawkit_part_on_dev <dev> — the device node of the CLAWKIT partition ON
# <dev>, and ONLY on <dev>, to stdout; nothing if <dev> carries none.
#
# NEVER `blkid -L CLAWKIT` (a whole-system, first-match lookup) here. Two
# sticks plugged in at once — the fleet's real installer, which already
# carries a netinst partition, beside the one this run just finished
# building — and a global label lookup can resolve to EITHER one; resolving
# to the wrong one means writing this run's preseed cpio onto a stick nobody
# asked to touch, which is exactly the class of mistake "never touch the
# real CLAWKIT stick" exists to rule out. `lsblk <dev>` only ever lists
# <dev>'s own partitions, so it cannot cross onto a different device no
# matter how many CLAWKIT-labelled sticks happen to be attached.
: CLAWKIT-PART-ON-DEV-BEGIN
clawkit_part_on_dev() {
	local dev="$1"
	lsblk -lnpo NAME,LABEL "$dev" 2>/dev/null | awk '$2=="CLAWKIT"{print $1; exit}'
}
: CLAWKIT-PART-ON-DEV-END

# MNT_KIT IS OVERRIDABLE, the same move make-preseed.sh's early_command makes
# with FLEET_TG_TARGET/FLEET_TG_MOUNTS: production resolves CLAWKIT scoped to
# $DEV (above) and mounts it here; a test points this at a plain directory it
# already populated (or deliberately left empty) and never touches a block
# device — see scripts/lib/onboarding-automation.test.mjs.
: ONBOARD-NETINST-CPIO-BEGIN
KIT_MOUNTED_HERE=false
if [ -n "${FLEET_ONBOARD_CLAWKIT_MNT:-}" ]; then
	MNT_KIT="$FLEET_ONBOARD_CLAWKIT_MNT"
else
	KIT_PART="$(clawkit_part_on_dev "$DEV")"
	if [ -n "$KIT_PART" ]; then
		mkdir -p "$MNT_KIT"
		if mount "$KIT_PART" "$MNT_KIT" 2>/dev/null; then
			KIT_MOUNTED_HERE=true
		else
			warn "could not mount CLAWKIT ($KIT_PART) to check for a netinst partition"
		fi
	fi
fi
if [ -f "$MNT_KIT/$NETINST_META_REL" ]; then
	mkdir -p "$MNT_KIT/$(dirname "$NETINST_CPIO_REL")"
	preseed_build_initrd_cpio "$RENDERED" "$MNT_KIT/$NETINST_CPIO_REL" \
		|| die "could not build $NETINST_CPIO_REL for the netinst partition"
	chmod 600 "$MNT_KIT/$NETINST_CPIO_REL"
	sync
	ok "netinst partition preseed cpio written: $NETINST_CPIO_REL"
fi
if [ "$KIT_MOUNTED_HERE" = true ]; then
	umount "$MNT_KIT" 2>/dev/null
	rmdir "$MNT_KIT" 2>/dev/null || true
fi
: ONBOARD-NETINST-CPIO-END
rm -f "$RENDERED"

# Ventoy's own plugin config. `VTOY_SECONDARY_BOOT_MENU: 0` is the "which mode
# do I pick" question the operator hit — with a Linux ISO the answer is always
# normal mode, so it stops asking. `auto_install` is what injects the preseed;
# without it the file on the stick is inert.
cat >"$MNT/ventoy/ventoy.json" <<VENTOYJSON
{
  "control": [
    { "VTOY_DEFAULT_IMAGE": "/$ISO_NAME" },
    { "VTOY_MENU_TIMEOUT": "5" },
    { "VTOY_SECONDARY_BOOT_MENU": "0" }
  ],
  "auto_install": [
    {
      "image": "/$ISO_NAME",
      "template": "/ventoy/script/preseed.cfg",
      "autosel": 1
    }
  ]
}
VENTOYJSON
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$MNT/ventoy/ventoy.json" 2>/dev/null \
	|| node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$MNT/ventoy/ventoy.json" \
	|| die "the ventoy.json just written is not valid JSON"
ok "preseed + ventoy.json written"

say "   copying $ISO_NAME …"
cp "$ISO" "$MNT/$ISO_NAME" || die "copy failed — is the stick large enough?"
sync
say "   verifying the copy on the stick…"
[ "$(sha256sum "$MNT/$ISO_NAME" | cut -d' ' -f1)" = "$ISO_SHA" ] \
	|| die "the copy on the stick does NOT match its checksum. Do not use this stick."
ok "copied and verified"
ls -la "$MNT" | sed 's/^/     /'
umount "$MNT"; rmdir "$MNT" 2>/dev/null
sync

CLAWKIT="$(blkid -L CLAWKIT 2>/dev/null || echo '(label CLAWKIT)')"

cat <<DONE

${G}${B}━━ STICK READY — safe to unplug ━━${N}

   installer   $ISO_NAME  ${DIM}(checksum verified on the stick)${N}
   profile     $PROFILE
   payload     $CLAWKIT

${B}At the new node${N}

   0. ${Y}Ethernet is the reliable path.${N} The installer fetches every package
      from the mirror. It will use wifi if that is all it finds and credentials
      were preloaded, but a cable removes a whole class of failure.
   1. Boot from the stick. It auto-selects the installer after 5s and installs
      ${B}unattended${N}. It asks exactly two things: the ${B}hostname${N}, and the
      ${B}disk${N} — the latter only if the box has more than one.
      ${DIM}The same stick images every claw; the name is per node.${N}
   2. It reboots into the name you gave it, already holding your key and
      passwordless sudo, so the rest can happen over ssh:

        ssh $FLEET_USER@<the name you typed>

   3. Convert it to a fleet node:

        sudo mount LABEL=CLAWKIT /mnt
        sudo bash /mnt/bootstrap/node-bootstrap.sh

      It infers the profile, the key and the hostname from the stick and the
      box, prints what it chose, and refuses rather than guessing when the
      answer is not unique.

   4. ${Y}Keep the console attached for step 3.${N} It rewrites sshd's config; if
      that goes wrong the node is unreachable and only a console gets you back.
      Before unplugging, prove BOTH:
        • ssh $FLEET_USER@<node> true      ${DIM}(key auth, from hokon)${N}
        • the console password still logs in

   5. Bootstrap ends with ENROLL-BEGIN … ENROLL-END and leaves it in
      /var/log/node-bootstrap-*.log on the node. ${Y}Do not copy it down.${N}
      'fleet enroll <node>' reads that file over ssh, re-probes the box
      against it, and writes fleet-runner-manifest.json itself:

        ${DIM}# from the hadoku-fleet-manager checkout:${N}
        node dist/cli.js enroll <node> --write

   6. ${Y}Reserve its address on the gateway.${N} Enroll prints the MAC and IP.
      On the gateway admin page: Advanced -> DHCP Reservation, delete any Auto row
      for that MAC, add a manual reservation, then record it:

        node dist/cli.js lan-reserve --machine <node> --write

      ${DIM}'fleet preflight' fails every night until this is recorded (#65).${N}

      then:

        ${DIM}# from the hadoku-fleet-manager checkout:${N}
        node dist/cli.js provision --machine <node> --confirm
        node dist/cli.js capabilities
        node dist/cli.js provision --machine <node> --verify-only
DONE

if [ -n "$GENERATED_PW" ]; then
	printf '\n   %sCONSOLE PASSWORD for %s — generated, write it down now:%s\n' "$Y" "$FLEET_USER" "$N"
	printf '      %s%s%s\n' "$B" "$GENERATED_PW" "$N"
	printf '   %sIt is the only console login on the node. Also saved to README.txt on%s\n' "$DIM" "$N"
	printf '   %sthe CLAWKIT partition.%s\n\n' "$DIM" "$N"
fi

