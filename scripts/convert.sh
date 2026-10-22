#!/bin/sh
# convert.sh — repair the box, then make it a fleet node. One command.
#
# CONVERT is the phase between IMAGE and ENROLL (docs/VOCABULARY.md). In
# practice it has always been two commands run back to back, because a freshly
# imaged box usually needs something before node-bootstrap.sh will get through:
# a clock, an apt source, jq. Every node so far has needed at least one.
#
#     sudo sh /mnt/bootstrap/convert.sh
#
# WHY IT IS NOT JUST `claw-fix && node-bootstrap`
# ------------------------------------------------
# claw-fix exits non-zero while ANY check still fails, and on a fresh box one
# always does: the hostname is `localhost`, because Ventoy boots the installer
# at priority=critical and the hostname question is never asked. claw-fix
# correctly calls that a fault and correctly declines to invent a name.
#
# But node-bootstrap.sh is the thing that ASKS for the name. So a plain `&&`
# would refuse to convert every new node in the fleet, for the one reason that
# is guaranteed to be true of all of them.
#
# So this reads claw-fix's own checks.txt and distinguishes:
#
#   - faults bootstrap will resolve  -> proceed (today: the unnamed hostname)
#   - anything else still failing    -> STOP, and say what
#
# Stopping matters. node-bootstrap installs ~400 packages and rewrites sshd; run
# on a box with no apt source or a six-hour clock skew it fails somewhere in the
# middle, and a half-converted node is harder to reason about than an unconverted
# one.
#
# Passes its arguments to claw-fix, so `--check` still works: it diagnoses, then
# stops before bootstrap because nothing was repaired.

set -u

HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
KIT=$(cd "$HERE/.." 2>/dev/null && pwd)
FIX="$KIT/fixes/claw-fix.sh"
BOOT="$HERE/node-bootstrap.sh"

B='' G='' R='' Y='' N=''
if [ -t 1 ]; then
	B=$(printf '\033[1m'); G=$(printf '\033[32m'); R=$(printf '\033[31m')
	Y=$(printf '\033[33m'); N=$(printf '\033[0m')
fi

[ "$(id -u)" = 0 ] || { echo "run as root: sudo sh $0"; exit 1; }
[ -r "$FIX" ] || { echo "cannot find claw-fix.sh at $FIX"; exit 1; }
[ -r "$BOOT" ] || { echo "cannot find node-bootstrap.sh at $BOOT"; exit 1; }

# Checks a freshly imaged box is EXPECTED to fail, and that the next step fixes.
# Keep this list short and justified: every id here is a fault this script
# decides to walk past.
#
#   host — the installer never asks for a hostname (priority=critical suppresses
#          the question), so every new node arrives as `localhost`.
#          node-bootstrap prompts for it and writes /etc/hostname and /etc/hosts
#          together, which is the better place for it anyway.
EXPECTED_BEFORE_BOOTSTRAP="host"

# ── the site facts, off the stick ───────────────────────────────────────────
#
# THIS IS WHY THE CONSOLE COMMAND IS `sudo sh convert.sh` AND NOTHING ELSE.
#
# node-bootstrap needs two things the PUBLISHED profile cannot carry: the LAN
# range (manifests/ ships an RFC 5737 placeholder and node-bootstrap REFUSES it)
# and the wireless credentials. Both are site facts, and both used to be typed
# at the console as environment variables — per box, off a photograph of a
# screen, at the most expensive keyboard in the system. That is the `--surface`
# flag mistake node-profiles.json was written to end, and it is also silently
# lossy: `FLEET_WIFI_PSK=... sudo sh convert.sh` LOOKS right, runs, and produces
# a node with no wireless fallback, because sudo resets the environment. You
# find out when the cable comes out and the box does not come back.
#
# So `fleet usb-prep` works them out ONCE, on the control host where it can
# actually look them up — the LAN from `ip route get` against a claw, the SSIDs
# and PSK read off a claw that already has them working — and writes
# bootstrap/site.env. The stick already carries the PSK for the installer's own
# use (lib/make-preseed.sh states that trust boundary explicitly), so this adds
# nothing to the blast radius of a lost stick.
#
# THE ENVIRONMENT STILL WINS. Sourcing only fills in what is not already set, so
# an operator overriding one value for one box does not have to rebuild a stick.
SITE_ENV="$HERE/site.env"
if [ -r "$SITE_ENV" ]; then
	# Read into the shell, then re-export only the unset ones. A plain `.` would
	# let the file overwrite a deliberate override.
	_lan=${FLEET_LAN_CIDR:-}; _ssid=${FLEET_WIFI_SSID:-}
	_psk=${FLEET_WIFI_PSK:-}; _ssid2=${FLEET_WIFI_SSID_FALLBACK:-}
	# shellcheck disable=SC1090
	. "$SITE_ENV"
	[ -n "$_lan" ] && FLEET_LAN_CIDR=$_lan
	[ -n "$_ssid" ] && FLEET_WIFI_SSID=$_ssid
	[ -n "$_psk" ] && FLEET_WIFI_PSK=$_psk
	[ -n "$_ssid2" ] && FLEET_WIFI_SSID_FALLBACK=$_ssid2
	export FLEET_LAN_CIDR
	[ -n "${FLEET_WIFI_SSID:-}" ] && export FLEET_WIFI_SSID
	[ -n "${FLEET_WIFI_PSK:-}" ] && export FLEET_WIFI_PSK
	[ -n "${FLEET_WIFI_SSID_FALLBACK:-}" ] && export FLEET_WIFI_SSID_FALLBACK
fi

# ── what the environment is carrying ────────────────────────────────────────
#
# Shown, not decided. Whether any of these is REQUIRED is node-bootstrap's
# preflight's business and belongs in exactly one place; this only reports what
# actually arrived, so a stick built without wifi credentials is visible here
# rather than eleven steps later.
printf '\n%s════ site ════%s\n' "$B" "$N"
if [ -r "$SITE_ENV" ]; then
	printf '  %sfrom the stick:%s %s\n' "$G" "$N" "$SITE_ENV"
else
	printf '  %sno site.env on this stick%s — rebuild it with `fleet usb-prep`, or set the\n' "$Y" "$N"
	printf '  variables below by hand: %ssudo VAR=... sh %s%s\n' "$B" "$0" "$N"
fi
for v in FLEET_LAN_CIDR FLEET_WIFI_SSID FLEET_WIFI_PSK FLEET_WIFI_SSID_FALLBACK FLEET_WIFI_PSK_FALLBACK; do
	# eval, because this is /bin/sh and there is no ${!v}. The value of a PSK is
	# never printed — only whether one arrived.
	val=$(eval printf '%s' "\"\${$v:-}\"")
	case "$v" in
	*PSK*) [ -n "$val" ] && val='<set>' ;;
	esac
	if [ -n "$val" ]; then
		printf '  %s%-26s%s %s\n' "$G" "$v" "$N" "$val"
	else
		printf '  %s%-26s%s (unset)\n' "$Y" "$v" "$N"
	fi
done
# FLEET_LAN_CIDR unset here is fatal eleven steps later, so it is called out
# now rather than discovered in the middle of a conversion.
if [ -z "${FLEET_LAN_CIDR:-}" ]; then
	printf '\n%sFLEET_LAN_CIDR is not set and the profile ships a placeholder node-bootstrap refuses.%s\n' "$R" "$N"
	printf 'This stick was built without it. Rebuild with `fleet usb-prep`, or:\n'
	printf '  %ssudo FLEET_LAN_CIDR=<your-lan>/24 sh %s%s\n' "$B" "$0" "$N"
fi

printf '\n%s════ 1/2  repair ════%s\n' "$B" "$N"
sh "$FIX" "$@"
FIXRC=$?

case " $* " in
*--check*)
	printf '\n%s--check: diagnosis only. Nothing repaired, so not converting.%s\n' "$Y" "$N"
	exit "$FIXRC"
	;;
esac

if [ "$FIXRC" -ne 0 ]; then
	# Read claw-fix's own record rather than re-deriving anything. It writes one
	# per run and the newest is this run's.
	CHECKS=$(ls -1dt "$KIT"/diagnostics/*/checks.txt 2>/dev/null | head -1)
	if [ -z "$CHECKS" ] || [ ! -r "$CHECKS" ]; then
		CHECKS=$(ls -1dt /var/log/claw-fix/*/checks.txt 2>/dev/null | head -1)
	fi
	if [ -z "$CHECKS" ] || [ ! -r "$CHECKS" ]; then
		printf '\n%sclaw-fix reported failures and left no checks.txt to read.%s\n' "$R" "$N"
		printf 'Not converting: proceeding blind is how a half-converted node happens.\n'
		exit 1
	fi

	BLOCKING=""
	# `cut -f1` on the id column; a FAIL line is id|FAIL|message.
	for id in $(grep '|FAIL|' "$CHECKS" 2>/dev/null | cut -d'|' -f1 | sort -u); do
		expected=0
		for e in $EXPECTED_BEFORE_BOOTSTRAP; do [ "$id" = "$e" ] && expected=1; done
		[ "$expected" = 1 ] || BLOCKING="$BLOCKING $id"
	done
	BLOCKING=$(echo "$BLOCKING" | sed 's/^ //')

	if [ -n "$BLOCKING" ]; then
		printf '\n%s════ STOPPING ════%s\n' "$R" "$N"
		printf 'claw-fix could not repair:%s\n\n' "$BLOCKING"
		grep '|FAIL|' "$CHECKS" | while IFS='|' read -r id _ msg; do
			for e in $EXPECTED_BEFORE_BOOTSTRAP; do [ "$id" = "$e" ] && continue 2; done
			printf '    %s\n' "$msg"
		done
		printf '\nNot running node-bootstrap. It installs ~400 packages and rewrites sshd;\n'
		printf 'on a box in this state it fails partway and leaves something harder to\n'
		printf 'reason about than what you have now.\n\n'
		printf 'Fix the above, then re-run this script.\n'
		exit 1
	fi

	printf '\n%sclaw-fix left only what node-bootstrap resolves (%s) — continuing.%s\n' \
		"$Y" "$EXPECTED_BEFORE_BOOTSTRAP" "$N"
fi

printf '\n%s════ 2/2  convert ════%s\n' "$B" "$N"
printf 'node-bootstrap will ask for this node name if it has not been set.\n\n'
bash "$BOOT"
BOOTRC=$?

printf '\n'
if [ "$BOOTRC" = 0 ]; then
	printf '%s════ converted ════%s\n' "$G" "$N"
	printf 'Next, from the control host:  fleet enroll %s --write\n' "$(cat /proc/sys/kernel/hostname 2>/dev/null)"
else
	printf '%snode-bootstrap exited %s. Read the log it named above.%s\n' "$R" "$BOOTRC" "$N"
fi
exit "$BOOTRC"
