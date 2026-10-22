#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# nm-convert.sh — move a claw's radio from ifupdown to NetworkManager
# ═══════════════════════════════════════════════════════════════════════════
#
# THE FAILURE IT EXISTS FOR. On 2026-09-07 the gateway's 5 GHz SSID was renamed.
# claw-1 (NetworkManager) reassociated unaided. claw-3 (ifupdown) did not, and
# recovering it cost a trip to the garage with a console and a USB stick —
# because ifupdown never retries. claw-2 and claw-3 are still on ifupdown; every
# future SSID or band change carries the same bill twice. Decided by the
# operator 2026-09-09: NetworkManager everywhere, because it is the one that
# self-recovered.
#
# WHY IT IS HERE AND NOT IN A DEPLOYER. fixes/README.md's rule is "if ssh works,
# the fix belongs in a deployer with a --check". This one is the exception the
# rule needs, and for the reason the rule is about: the thing it changes IS the
# link the deployer would arrive over. claw-2 and claw-3 are Surfaces with NO
# ethernet port at all, so a bad profile leaves nothing to ssh in on and the
# recovery is a console at the physical box — with this script, off the stick.
# It therefore ships on CLAWKIT, runs identically over ssh and at the console,
# and has a --rollback that needs no network.
#
# WHAT "STRANDED" MEANS HERE, AND IT IS NOT ONLY "OFF THE AIR". hokon reaches
# every claw by a LAN IP pinned in ~/.ssh/config (claw-2 = .181, claw-3 = .203),
# and those are DHCP leases keyed on the radio's MAC. NetworkManager will
# randomise a wifi MAC per connection unless told not to, which draws a NEW
# lease — so a node can come back perfectly healthy on a new address and still
# be unreachable from every gate in the fleet. Both halves are guarded:
# `cloned-mac-address=permanent` + `dhcp-client-id=mac` in the profile, and a
# verification that refuses the conversion unless the address is UNCHANGED.
#
# ─── THE ORDERING THAT MAKES STRANDING IMPOSSIBLE ──────────────────────────
#
#   1. Read the SSIDs and PSKs off the NODE'S OWN wpa_supplicant config. No
#      secret travels, and the node cannot be converted onto an SSID it was
#      never on.
#   2. Record the address it is reachable at RIGHT NOW.
#   3. Write the NM profiles and `nmcli con reload`. ifupdown is untouched and
#      still owns the radio; this step cannot break anything.
#   4. ARM A BOOT WATCHDOG. From here until the node is proven healthy after
#      its reboot, a boot that comes up without a default route and an address
#      restores ifupdown and reboots again, unattended. This is the only part
#      that covers the window an in-script rollback cannot: after the reboot.
#   5. RESTART NetworkManager so it re-reads conf.d, hand the radio over, WAIT
#      for it to leave `unmanaged`, then activate. THE RISKY MOMENT. Each of
#      those three is load-bearing and the first two were learned the hard way
#      on claw-3, 2026-09-10 — see the comments at that step.
#   6. VERIFY WITH nmcli: the radio is `connected` on a `fleet-wifi-*`
#      connection, it has an IPv4 address, that address is the SAME one from
#      step 2, and a default route runs over it. Anything less rolls back in
#      place, immediately, and exits non-zero WITHOUT having touched
#      /etc/network/interfaces.
#   7. ONLY THEN neutralise the ifupdown stanza and reboot. `ifdown; ifup` is
#      never used: the 2026-09-07 outage was a failed `ifdown` leaving
#      /run/network/ifstate saying the interface was still configured, which
#      made the following `ifup` a silent no-op. /run is tmpfs. A reboot cannot
#      hit that trap.
#   8. On the next boot the watchdog sees a healthy node and DISARMS ITSELF.
#
# Steps 6 and 7 are the safety gate: `NM_VERIFIED` is set in exactly one place
# and nothing after it runs unless it is `yes`. nm-convert.test.mjs drives the
# whole script against a stubbed nmcli that never converges and asserts that
# /etc/network/interfaces is untouched and `reboot` is never called.
#
# ─── USAGE ─────────────────────────────────────────────────────────────────
#
#   sh nm-convert.sh --check            # diagnose only. 0 converged, 1 not, 2 could not look
#   sh nm-convert.sh --convert --yes    # convert, verify, reboot
#   sh nm-convert.sh --commit           # disarm the watchdog by hand (it also self-disarms)
#   sh nm-convert.sh --rollback --yes   # back to ifupdown, then reboot
#
# Over ssh: `ssh claw-3 sudo sh -s -- --convert --yes < scripts/fixes/nm-convert.sh`
# At the console: `sudo mount LABEL=CLAWKIT /mnt && sudo sh /mnt/fixes/nm-convert.sh --check`
#
# @guards scripts/lib/node-interfaces.mjs

set -u

MODE=check
YES=no
WLAN_METRIC=600

for a in "$@"; do
	case "$a" in
	--check) MODE=check ;;
	--convert) MODE=convert ;;
	--commit) MODE=commit ;;
	--rollback) MODE=rollback ;;
	--yes) YES=yes ;;
	--metric=*) WLAN_METRIC="${a#--metric=}" ;;
	-h | --help)
		sed -n '2,60p' "$0" 2>/dev/null || true
		exit 0
		;;
	*)
		echo "nm-convert: unknown argument '$a'" >&2
		exit 2
		;;
	esac
done

# THE TEST ROOT. Every path below is prefixed with it so the whole script can be
# driven end-to-end in a temp directory against stubbed commands — which is the
# only way a script that reboots a machine gets a test that actually EXECUTES
# its safety gate rather than grepping for it. It is honoured only when it names
# a directory that exists, it is announced loudly, and `--convert` still refuses
# to run as a non-root user with no root set. claw-fix.sh's kit-path refusal is
# the precedent: a path this script does not believe is a path it will not use.
ROOT="${NM_CONVERT_ROOT:-}"
if [ -n "$ROOT" ]; then
	[ -d "$ROOT" ] || {
		echo "nm-convert: NM_CONVERT_ROOT=$ROOT is not a directory" >&2
		exit 2
	}
	echo "nm-convert: *** NM_CONVERT_ROOT=$ROOT — writing under a test root, NOT the real system ***"
fi

IFACES="$ROOT/etc/network/interfaces"
IFACES_BACKUP="$ROOT/etc/network/interfaces.fleet-pre-nm"
NM_CONNS="$ROOT/etc/NetworkManager/system-connections"
NM_CONFD="$ROOT/etc/NetworkManager/conf.d"
WPA_DIR="$ROOT/etc/wpa_supplicant"
IFSTATE="$ROOT/run/network/ifstate"
WATCHDOG_BIN="$ROOT/usr/local/sbin/fleet-net-rollback"
WATCHDOG_UNIT="$ROOT/etc/systemd/system/fleet-net-rollback.service"
WATCHDOG_TIMER="$ROOT/etc/systemd/system/fleet-net-rollback.timer"
ARMED="$ROOT/etc/fleet-net-rollback.armed"

RED=''
GRN=''
YEL=''
NC=''
if [ -t 1 ]; then
	RED='\033[0;31m'
	GRN='\033[0;32m'
	YEL='\033[1;33m'
	NC='\033[0m'
fi
log() { printf '%b[nm-convert]%b %s\n' "$GRN" "$NC" "$*"; }
warn() { printf '%b[WARNING]%b %s\n' "$YEL" "$NC" "$*"; }
err() { printf '%b[ERROR]%b %s\n' "$RED" "$NC" "$*" >&2; }
die() {
	err "$2"
	exit "$1"
}

# ── OBSERVE ────────────────────────────────────────────────────────────────
# Every fact below is read from the stack that WROTE it: the radio from
# /sys/class/net, ifupdown's ownership from its own /run/network/ifstate, NM's
# from nmcli. Never from a config file this script or node-bootstrap wrote —
# a verifier that reads its own writer's artifact cannot fail.

WLAN=""
for d in "$ROOT"/sys/class/net/*/wireless; do
	[ -e "$d" ] || continue
	WLAN="$(basename "$(dirname "$d")")"
	break
done

have() { command -v "$1" >/dev/null 2>&1; }

nm_dev_field() { # $1=iface $2=field index (1..4 of DEVICE,TYPE,STATE,CONNECTION)
	have nmcli || return 1
	nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status 2>/dev/null |
		awk -F: -v i="$1" -v f="$2" '$1 == i { print $f }' | head -1
}

# The address the fleet reaches this node at, read from the kernel.
addr_of() {
	have ip || return 1
	ip -o -4 addr show "$1" 2>/dev/null |
		awk '{ split($4, a, "/"); print a[1]; exit }'
}

default_via() {
	have ip || return 1
	ip route show default 2>/dev/null | awk -v i="$1" '$0 ~ ("dev " i " ") || $0 ~ ("dev " i "$") { print; exit }'
}

ifupdown_holds() { # $1=iface
	[ -f "$IFSTATE" ] || return 1
	awk -F= -v i="$1" '$1 == i { found = 1 } END { exit found ? 0 : 1 }' "$IFSTATE"
}

# CAN THIS PROCESS SEE OTHER USERS' PROCESSES AT ALL?
#
# Measured on the fleet 2026-09-26: claw-2 and claw-3 — the only two nodes this
# script exists for — mount /proc with `hidepid=invisible`. A non-root
# `ps -eo args=` there lists SEVEN processes, all of them the caller's own, and
# the two wpa_supplicants that decide whether this node is convertible are both
# invisible. claw-4 has no hidepid and lists 202. The difference is between the
# NODES, which is the third question this file has had to answer by diffing them.
#
# pid 1 is the canary, and it is read from the kernel rather than from /proc's
# mount options: it exists on every Linux box, it belongs to root, and a reader
# that cannot see IT cannot see anything it does not own. Empty output here means
# every later process question answers "no" for the wrong reason.
proc_table_readable() {
	have ps || return 1
	[ -n "$(ps -p 1 -o args= 2>/dev/null)" ]
}

# Is a wpa_supplicant SPAWNED BY IFUPDOWN bound to this radio? Read from the
# process table, not from the `wpa-conf` line in /etc/network/interfaces: the
# stanza says what should be true at boot, the process table says what owns the
# control socket right now, and those are different questions. ifupdown's
# instance carries `-i <iface>`; the one NetworkManager drives is the D-Bus
# instance and carries `-u` with no interface of its own.
#
# THREE ANSWERS, NOT TWO, and the third is the whole reason this function has a
# `case` at every call site:
#   0 — ifupdown's own supplicant holds this radio. The impasse. Refuse.
#   1 — it does not. claw-7's shape; the conversion can proceed.
#   2 — COULD NOT LOOK, and that is NOT 1. Until 2026-09-26 an unreadable process
#       table returned "no competing supplicant", so on a hidepid node run by a
#       non-root caller this function cleared the single most dangerous
#       conversion in the fleet — a wifi-only Surface with no ethernet port — on
#       the strength of a question it never got to ask.
ifupdown_supplicant() { # $1=iface
	proc_table_readable || return 2
	ps -eo args= 2>/dev/null | grep wpa_supplicant | grep -v grep | grep -q -- "-i $1" || return 1
	return 0
}

# ── DIAGNOSE ───────────────────────────────────────────────────────────────

diagnose() {
	if [ -z "$WLAN" ]; then
		log "no wireless interface on this box. That is a fact about the machine,"
		log "  not a fault — a wired-only claw has no radio to convert."
		return 3
	fi
	DIAG_STATE="$(nm_dev_field "$WLAN" 3 || true)"
	DIAG_CONN="$(nm_dev_field "$WLAN" 4 || true)"
	DIAG_ADDR="$(addr_of "$WLAN" || true)"
	log "radio:      $WLAN"
	log "address:    ${DIAG_ADDR:-<none>}"
	log "nmcli:      $(have nmcli && nmcli --version 2>/dev/null | awk '{print $NF}' || echo 'not installed')"
	log "nm state:   ${DIAG_STATE:-<no nmcli, or device absent from its list>}"
	log "nm conn:    ${DIAG_CONN:-<none>}"
	# Read from ifupdown's own state file, never from a config this script wrote:
	# a verifier that reads its own writer's artifact cannot fail.
	DIAG_STRAYS=""
	if [ -f "$IFSTATE" ]; then
		DIAG_STRAYS="$(awk -F= -v r="$WLAN" '$1 != "lo" && $1 != "" && $1 != r { printf " %s", $1 }' "$IFSTATE")"
	fi
	if ifupdown_holds "$WLAN"; then
		log "ifupdown:   HOLDS $WLAN (recorded in /run/network/ifstate)"
	else
		log "ifupdown:   does not hold $WLAN"
	fi
	[ -z "$DIAG_STRAYS" ] || log "ifupdown:   also holds:$DIAG_STRAYS"
	log "watchdog:   $([ -f "$ARMED" ] && echo 'ARMED — this node has not yet proven a healthy boot' || echo 'not armed')"

	if [ -z "$DIAG_STATE" ]; then
		err "could not read NetworkManager's view of $WLAN. That is 'I could not look',"
		err "  which is not 'nothing is wrong' — install network-manager or run as root."
		return 2
	fi
	if ifupdown_holds "$WLAN"; then
		if [ "$DIAG_STATE" = unmanaged ]; then
			warn "$WLAN is on IFUPDOWN. This node will not reassociate after an SSID change."
			ifupdown_supplicant "$WLAN"
			case $? in
			0)
				warn "  and ifupdown holds it through its OWN wpa_supplicant, which this script"
				warn "  cannot convert away from — see the IMPASSE note in --convert."
				;;
			2)
				err "  and whether a competing wpa_supplicant holds it COULD NOT BE READ: this"
				err "  process cannot see pid 1, so /proc is restricted (hidepid) or ps is absent."
				err "  That is the one fact that decides whether this node is convertible at all,"
				err "  and an unreadable answer is not a 'no'. Re-run as root:"
				err "    sudo sh nm-convert.sh --check"
				;;
			esac
			return 1
		fi
		err "SPLIT STACK: NetworkManager reports '$DIAG_STATE' for $WLAN and ifupdown still"
		err "  records it. Two managers on one radio is a race, not a merge. Reboot first."
		return 1
	fi
	# A NODE IS NOT CONVERGED WHILE ANY INTERFACE IS STILL ON THE OTHER STACK,
	# radio or not. claw-7 read "converged" here on 2026-09-09 with NM on its
	# radio and ifupdown still holding enp8s0 from before its conversion — two
	# default routes, metric 600 and 1002. The wired one was learned on a carrier
	# that is gone, and a stale default route at a better metric is precisely how
	# a box blackholes itself. /run is tmpfs, so a reboot is the whole fix.
	if [ -n "$DIAG_STRAYS" ]; then
		err "SPLIT STACK: NetworkManager holds $WLAN, but ifupdown still holds:$DIAG_STRAYS"
		err "  Those interfaces keep a lease and a default route their carrier no longer"
		err "  justifies. /run/network/ifstate is tmpfs — REBOOT this node, then re-check."
		return 1
	fi

	case "$DIAG_CONN" in
	fleet-wifi-*)
		log "converged: NetworkManager holds $WLAN on '$DIAG_CONN'"
		return 0
		;;
	esac
	if [ "$DIAG_STATE" = connected ]; then
		warn "NetworkManager holds $WLAN, but on connection '$DIAG_CONN' rather than a"
		warn "  fleet-wifi-* profile. That is claw-1's hand-made shape, not this script's."
		return 1
	fi
	warn "$WLAN is neither on ifupdown nor connected under NetworkManager (state '$DIAG_STATE')."
	return 1
}

# ── THE WATCHDOG ───────────────────────────────────────────────────────────
# The ONLY thing that covers the window between "reboot" and "the operator can
# ssh in again". An in-script rollback cannot reach past the reboot it schedules;
# this can, and it needs no network, no operator and no console.

arm_watchdog() {
	mkdir -p "$(dirname "$WATCHDOG_BIN")" "$(dirname "$WATCHDOG_UNIT")"
	cat >"$WATCHDOG_BIN" <<EOF
#!/bin/sh
# Written by nm-convert.sh. Removed by \`nm-convert.sh --commit\`, and by this
# script itself on the first boot that comes up healthy.
#
# IT IS SELF-LIMITING ON PURPOSE. Left armed forever it would revert a
# long-converted node the first time the gateway happened to be slow at boot,
# which turns a safety net into a time bomb. It covers exactly the one reboot
# the conversion depends on.
set -u
[ -f "$ARMED" ] || exit 0
WLAN="$WLAN"
healthy() {
	ip route show default 2>/dev/null | grep -q "dev \$WLAN" || return 1
	ip -o -4 addr show "\$WLAN" 2>/dev/null | grep -q inet || return 1
	return 0
}
# Association plus DHCP is genuinely slower than a wired renew. Two minutes of
# grace before declaring the conversion failed.
i=0
while [ \$i -lt 24 ]; do
	if healthy; then
		logger -t fleet-net-rollback "healthy on \$WLAN; disarming"
		rm -f "$ARMED"
		systemctl disable fleet-net-rollback.timer >/dev/null 2>&1 || true
		exit 0
	fi
	sleep 5
	i=\$((i + 1))
done
logger -t fleet-net-rollback "no address or default route on \$WLAN after 2min; restoring ifupdown and rebooting"
[ -f "$IFACES_BACKUP" ] && cp -a "$IFACES_BACKUP" "$IFACES"
rm -f "$NM_CONFD/10-fleet-managed.conf"
rm -f "$ARMED"
systemctl disable fleet-net-rollback.timer >/dev/null 2>&1 || true
systemctl disable NetworkManager >/dev/null 2>&1 || true
systemctl reboot
EOF
	chmod 755 "$WATCHDOG_BIN"
	cat >"$WATCHDOG_UNIT" <<EOF
[Unit]
Description=fleet: roll back to ifupdown if NetworkManager did not bring the network up
DefaultDependencies=no
After=basic.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/fleet-net-rollback
EOF
	# A TIMER, NOT network-online.target. The failure this guards against is the
	# network never coming up — and network-online.target is never reached in
	# exactly that case, so a unit ordered after it would never run on the one
	# boot it exists for.
	cat >"$WATCHDOG_TIMER" <<EOF
[Unit]
Description=fleet: net rollback check shortly after boot

[Timer]
OnBootSec=45
AccuracySec=5

[Install]
WantedBy=timers.target
EOF
	: >"$ARMED"
	systemctl daemon-reload >/dev/null 2>&1 || true
	systemctl enable fleet-net-rollback.timer >/dev/null 2>&1 || true
	log "watchdog ARMED: a boot without an address on $WLAN restores ifupdown and reboots"
}

disarm_watchdog() {
	rm -f "$ARMED"
	systemctl disable fleet-net-rollback.timer >/dev/null 2>&1 || true
	log "watchdog disarmed"
}

# ── THE PROFILES ───────────────────────────────────────────────────────────

# The node's own SSIDs and PSKs. Never passed in: the PSK on the box is the one
# the box is currently associated with, and a typo'd one supplied from outside
# is a conversion onto a network that does not exist.
read_networks() {
	f="$WPA_DIR/wpa_supplicant-$WLAN.conf"
	[ -f "$f" ] || f="$WPA_DIR/wpa_supplicant.conf"
	[ -f "$f" ] || return 1
	awk '
		/network[[:space:]]*=[[:space:]]*{/ { inb = 1; ssid = ""; psk = ""; prio = 1; next }
		inb && /^[[:space:]]*}/ {
			if (ssid != "" && psk != "") printf "%s\t%s\t%s\n", prio, ssid, psk
			inb = 0; next
		}
		inb {
			line = $0
			sub(/^[[:space:]]+/, "", line)
			if (line ~ /^ssid=/)     { v = substr(line, 6); gsub(/^"|"$/, "", v); ssid = v }
			if (line ~ /^psk=/)      { v = substr(line, 5); gsub(/^"|"$/, "", v); psk = v }
			if (line ~ /^priority=/) { prio = substr(line, 10) }
		}
	' "$f" | sort -rn
}

write_profile() { # $1=name $2=ssid $3=psk $4=priority
	mkdir -p "$NM_CONNS"
	dest="$NM_CONNS/$1.nmconnection"
	cat >"$dest" <<EOF
[connection]
id=$1
type=wifi
interface-name=$WLAN
autoconnect=true
autoconnect-priority=$4

[wifi]
mode=infrastructure
ssid=$2
# THE RESERVATION'S FOUNDATION, not a hardening detail. NM randomises a wifi MAC
# per connection by default, and a randomised MAC draws a NEW DHCP lease — so
# the node's address would move on its own, and ~/.ssh/config pins it. dhcp-client-id
# keys the lease on the same MAC the gateway's reservation list keys on.
cloned-mac-address=permanent

[wifi-security]
key-mgmt=wpa-psk
psk=$3

[ipv4]
method=auto
route-metric=$WLAN_METRIC
dhcp-client-id=mac
dhcp-send-hostname=true

[ipv6]
method=auto
route-metric=$WLAN_METRIC
EOF
	# NM refuses to load a connection file that is group- or world-readable,
	# which is also the PSK's protection.
	chmod 600 "$dest"
	log "wrote $1 (ssid '$2', autoconnect-priority $4, route metric $WLAN_METRIC)"
}

# ── THE TEARDOWN, AND ITS ROLLBACK ─────────────────────────────────────────

neutralise_ifupdown() {
	[ -f "$IFACES" ] || return 0
	awk '
		/^[[:space:]]*(auto|allow-hotplug)[[:space:]]+lo([[:space:]]|$)/ { print; next }
		/^[[:space:]]*iface[[:space:]]+lo([[:space:]]|$)/ { inlo = 1; print; next }
		/^[[:space:]]*(auto|allow-hotplug|iface)[[:space:]]/ {
			inlo = 0
			print "# fleet: managed by NetworkManager (nm-convert.sh) -- " $0
			next
		}
		inlo { print; next }
		/^[[:space:]]*(address|netmask|gateway|dns-|wpa-|hwaddress|pre-up|post-up|up|down)/ {
			print "# fleet: managed by NetworkManager (nm-convert.sh) -- " $0
			next
		}
		{ print }
	' "$IFACES_BACKUP" >"$IFACES.fleet-new" && mv "$IFACES.fleet-new" "$IFACES"
	log "commented the ifupdown stanza out of $IFACES (backup: $IFACES_BACKUP)"
}

restore_ifupdown() {
	[ -f "$IFACES_BACKUP" ] && cp -a "$IFACES_BACKUP" "$IFACES"
	rm -f "$NM_CONFD/10-fleet-managed.conf"
	nmcli device set "$WLAN" managed no >/dev/null 2>&1 || true
	systemctl stop NetworkManager >/dev/null 2>&1 || true
	systemctl disable NetworkManager >/dev/null 2>&1 || true
	systemctl restart networking >/dev/null 2>&1 || true
	log "restored ifupdown"
}

# ── VERIFY ─────────────────────────────────────────────────────────────────
# THE ONLY PLACE NM_VERIFIED IS SET. Four conditions, and the third is the one
# that is easy to leave out and expensive to leave out: a node that comes back
# on a DIFFERENT address is healthy and unreachable at the same time, because
# every ssh path in the fleet resolves it through a pinned lease.

nm_verify() { # $1 = the address it must still be on
	want="$1"
	i=0
	while [ "$i" -lt 20 ]; do
		st="$(nm_dev_field "$WLAN" 3 || true)"
		cn="$(nm_dev_field "$WLAN" 4 || true)"
		got="$(addr_of "$WLAN" || true)"
		rt="$(default_via "$WLAN" || true)"
		case "$cn" in
		fleet-wifi-*)
			if [ "$st" = connected ] && [ -n "$got" ] && [ -n "$rt" ]; then
				if [ "$got" != "$want" ]; then
					err "NetworkManager associated, but $WLAN came back on $got and the fleet"
					err "  reaches this node at $want. A new lease means a new MAC — check"
					err "  cloned-mac-address=permanent. Healthy and unreachable is still unreachable."
					return 1
				fi
				log "verified: $WLAN connected on '$cn', address $got (unchanged), default route present"
				return 0
			fi
			;;
		esac
		sleep 3
		i=$((i + 1))
	done
	err "after 60s: $WLAN state='${st:-?}' connection='${cn:-none}' address='${got:-none}' route='${rt:-none}'"
	return 1
}

# ═══════════════════════════════════════════════════════════════════════════
# MODES
# ═══════════════════════════════════════════════════════════════════════════

case "$MODE" in
check)
	diagnose
	rc=$?
	# A box with no radio has nothing to convert and is not a failure.
	[ "$rc" = 3 ] && rc=0
	exit "$rc"
	;;

commit)
	[ -f "$ARMED" ] || {
		log "watchdog was not armed; nothing to commit"
		exit 0
	}
	diagnose >/dev/null 2>&1 || die 1 "refusing to disarm: this node is not converged. Run --check."
	disarm_watchdog
	rm -f "$WATCHDOG_BIN" "$WATCHDOG_UNIT" "$WATCHDOG_TIMER"
	systemctl daemon-reload >/dev/null 2>&1 || true
	log "committed. This node is NetworkManager-managed and the rollback net is removed."
	exit 0
	;;

rollback)
	[ "$YES" = yes ] || die 2 "--rollback reboots this node. Pass --yes when you mean it."
	restore_ifupdown
	disarm_watchdog
	log "rebooting into ifupdown"
	systemctl reboot
	exit 0
	;;

convert) ;;
*) die 2 "unreachable mode '$MODE'" ;;
esac

# ═══════════════════════════════════════════════════════════════════════════
# CONVERT
# ═══════════════════════════════════════════════════════════════════════════

[ "$YES" = yes ] || die 2 "--convert REBOOTS this node. Pass --yes when you mean it."
[ -z "$ROOT" ] && [ "$(id -u)" != 0 ] && die 2 "--convert needs root"

[ -n "$WLAN" ] || die 3 "no wireless interface on this box — nothing to convert"
have nmcli || die 2 "nmcli is not installed. \`apt-get install network-manager\` first; converting
  a radio with no manager to hand it to is how a node ends up on neither stack."

if diagnose >/dev/null 2>&1; then
	log "already converged — nothing to do (idempotent)"
	exit 0
fi

# A SPLIT BOX NEEDS A REBOOT, NOT A CONVERSION. If the radio is already off
# ifupdown, there is nothing here to convert and the only thing wrong is the
# stale /run/network/ifstate entry — which is tmpfs and clears itself on boot.
# Converting anyway would rewrite profiles from a wpa_supplicant config that may
# no longer describe this radio at all, which is claw-7's shape exactly.
if ! ifupdown_holds "$WLAN" && [ -n "${DIAG_STRAYS:-}" ]; then
	err "$WLAN is not on ifupdown — there is nothing to convert. What is wrong is that"
	err "  ifupdown still holds:$DIAG_STRAYS from a boot before the conversion."
	die 1 "  /run is tmpfs. Reboot this node and re-run --check. Do not convert it."
fi

# ── THE IMPASSE THIS SCRIPT CANNOT CONVERT THROUGH ─────────────────────────
#
# ifupdown's `wpa-conf` stanza starts its OWN wpa_supplicant for the radio, and
# that process owns /run/wpa_supplicant/<iface>. NetworkManager drives a
# DIFFERENT supplicant — the D-Bus instance — which cannot create a control
# interface for a device whose socket another process already holds. Measured on
# claw-3, 2026-09-10 05:00Z, with NM having correctly taken the device:
#
#   device (wlp3s0): Couldn't initialize supplicant interface:
#     fi.w1.wpa_supplicant1.UnknownError: wpa_supplicant couldn't grab this interface.
#   device (wlp3s0): re-acquiring supplicant interface (#1) ... (#5)
#   device (wlp3s0): supplicant interface keeps failing, giving up
#   wpa_supplicant[583]: ctrl_iface exists and seems to be in use - cannot override it
#   wpa_supplicant[583]: Delete '/run/wpa_supplicant/wlp3s0' manually if it is not used
#
# The radio goes `unmanaged` -> `unavailable` and stops there for as long as
# ifupdown holds it. THAT MAKES THE CENTRAL SAFETY PROPERTY OF THIS SCRIPT
# UNREACHABLE HERE: step 6 must see NM `connected` BEFORE step 7 touches
# /etc/network/interfaces, but NM cannot reach `connected` until ifupdown's
# supplicant lets go, and the only thing that makes it let go is the teardown
# the gate refuses to run first. Verify-before-teardown and a wifi-only node on
# `wpa-conf` are mutually exclusive; no amount of waiting resolves it.
#
# WHY NOBODY NOTICED. claw-7 converted cleanly on 2026-09-09, and its own
# interfaces.fleet-pre-nm backup shows why: `allow-hotplug enp8s0` and no wifi
# stanza at all. Its radio was never on ifupdown, so no second supplicant ever
# competed for it. This script has never converted a wifi-only node.
#
# Refusing here rather than at the safety gate is not just a nicer message: it
# means the watchdog is never armed and the radio is never handed over, so a
# node it cannot convert is not touched at all. Breaking the impasse means
# deliberately dropping the link this script arrived over, on a box with no
# ethernet port — an operator decision that wants a console booked or this
# stick in hand, not a retry.
if ifupdown_holds "$WLAN"; then
	ifupdown_supplicant "$WLAN"
	case $? in
	0)
		err "ifupdown holds $WLAN through its own wpa_supplicant (-i $WLAN), so NetworkManager"
		err "  cannot initialize a supplicant interface for it: 'wpa_supplicant couldn't grab"
		err "  this interface'. The radio would reach 'unavailable' and stop, and this script"
		err "  verifies NM is 'connected' BEFORE it touches /etc/network/interfaces — which it"
		err "  can never be while ifupdown owns the radio."
		err "  Nothing has been changed and the watchdog was not armed."
		die 1 "  This needs the teardown-first redesign and a console; it is not a retry."
		;;
	2)
		# THE ANSWER THAT USED TO READ AS "GO". `--convert` demands root, so this
		# is not the ordinary path — but `[ -z "$ROOT" ]` exempts the test root,
		# `ps` can be absent from a minimal image, and a caller reached through
		# `sudo -u` or a container is root by uid and blind by namespace. In every
		# one of those the old `&&` scored an unasked question as "no competing
		# supplicant" and armed a watchdog on a box with no ethernet port.
		err "whether ifupdown holds $WLAN through its own wpa_supplicant COULD NOT BE READ:"
		err "  this process cannot see pid 1, so /proc is restricted (hidepid=invisible on"
		err "  claw-2 and claw-3) or ps is not installed. That fact is the difference between"
		err "  a node this script converts cleanly and one it cannot convert at all, and an"
		err "  unreadable answer is not a 'no'."
		err "  Nothing has been changed and the watchdog was not armed."
		die 2 "  Re-run as root: sudo sh nm-convert.sh --convert --yes"
		;;
	esac
fi

# ── 2. the address the fleet reaches this node at, BEFORE anything moves ───
PRE_ADDR="$(addr_of "$WLAN" || true)"
[ -n "$PRE_ADDR" ] || die 2 "$WLAN has no IPv4 address right now. Converting a radio that is
  already down means there is no 'before' to compare against, and no way to tell
  a successful conversion from a node that never came back."
log "reachable at $PRE_ADDR on $WLAN — that address must survive the conversion"

# ── 1. the node's own credentials ──────────────────────────────────────────
NETS="$(read_networks || true)"
[ -n "$NETS" ] || die 2 "no wpa_supplicant network blocks found under $WPA_DIR.
  This node's SSIDs and PSKs are not readable, and this script will not accept
  them from outside — a typo'd PSK converts the node onto a network that does
  not exist."
NET_COUNT="$(printf '%s\n' "$NETS" | wc -l | tr -d ' ')"
if [ "$NET_COUNT" -lt 2 ]; then
	warn "only one SSID in this node's config — it will have no second-band fallback,"
	warn "  and an SSID rename would strand it (2026-09-07 is the precedent)."
fi

# ── 3. write the profiles. ifupdown still owns the radio; nothing can break yet
mkdir -p "$NM_CONFD" "$(dirname "$IFACES_BACKUP")"
[ -f "$IFACES" ] && [ ! -f "$IFACES_BACKUP" ] && cp -a "$IFACES" "$IFACES_BACKUP"

n=0
TAB='	'
printf '%s\n' "$NETS" | while IFS="$TAB" read -r prio ssid psk; do
	[ -n "${ssid:-}" ] || continue
	n=$((n + 1))
	case "$n" in
	1) name=fleet-wifi-primary ;;
	2) name=fleet-wifi-fallback ;;
	*) name="fleet-wifi-$n" ;;
	esac
	write_profile "$name" "$ssid" "$psk" "$prio"
done

# NM's ifupdown plugin defaults to managed=false, which would leave anything
# named in /etc/network/interfaces outside NM's reach — the split that makes a
# pulled cable blackhole a box. One manager owns everything, or neither does.
cat >"$NM_CONFD/10-fleet-managed.conf" <<'EOF'
# Written by nm-convert.sh. NM's ifupdown plugin defaults to managed=false,
# which would leave the wired port on ifupdown while NM held only the radio —
# the split that makes a pulled cable blackhole the box (the stale wired default
# route outlives the carrier). One manager owns both interfaces, or neither.
[ifupdown]
managed=true
EOF

# MEASURED, not chosen on taste: claw-1 (NM, with this file) reads
# `Power save: off`; claw-2 and claw-3 (ifupdown) both read `Power save: on`
# (2026-09-09). Converting without it would hand a CI node NM's default and
# quietly regress its link stability under the banner of "same shape".
cat >"$NM_CONFD/99-no-powersave.conf" <<'EOF'
[connection]
wifi.powersave = 2
EOF

nmcli con reload >/dev/null 2>&1 || true
log "profiles written and reloaded; ifupdown still holds $WLAN"

# ── 4. arm the watchdog BEFORE the risky step ──────────────────────────────
arm_watchdog

# ── 5. the risky moment ────────────────────────────────────────────────────
#
# RESTART, NOT START. NetworkManager reads /etc/NetworkManager/conf.d ONLY when
# it starts or is explicitly told to re-read its configuration. `nmcli con
# reload` above reloads CONNECTION PROFILES and nothing else, and `systemctl
# start` on an already-running unit is a no-op — so on a node where NM is
# already up, 10-fleet-managed.conf is written and never read, `[ifupdown]
# managed=false` from /etc/NetworkManager/NetworkManager.conf stays in force,
# and the radio — which IS named in /etc/network/interfaces — stays `unmanaged`
# no matter what it is asked.
#
# That is the difference between the node this worked on and the nodes it did
# not, and it is a difference between the NODES, not the code: claw-7 converted
# cleanly on 2026-09-09 because NM was not running there, so `start` genuinely
# started it and read the file on the way up. claw-2 and claw-3 both report
# NetworkManager `active` (measured 2026-09-10 04:45Z), so `start` did nothing.
# On claw-3 at 04:47Z the audit log read `op="device-managed" args="true"
# result="success"` and NM then logged no device state change at all; 60s later
# the verify loop still saw `unmanaged` and rolled the conversion back.
#
# `restart` is used rather than `reload` because it is the path with field
# evidence behind it — it is exactly what claw-7 did. It is safe here: this
# point is unreachable on an already-converged node (the idempotent exit above),
# so NM is holding nothing but externally-managed devices when it goes down.
systemctl enable NetworkManager >/dev/null 2>&1 || true
systemctl restart NetworkManager >/dev/null 2>&1 || true
nmcli device set "$WLAN" managed yes >/dev/null 2>&1 || true

# WAIT FOR THE RADIO TO LEAVE `unmanaged` BEFORE ACTIVATING ANYTHING. Handing a
# device over is asynchronous: it has to leave `unmanaged`, become `unavailable`
# and then `disconnected` before any profile can bind to it. Activating 30ms
# after the handover searches a device list the radio is not in yet, and NM
# refuses with a message that names the wrong device entirely — claw-3, 04:47Z:
#   op="connection-activate" name="fleet-wifi-primary" result="fail"
#   reason="No suitable device found for this connection (device lo not
#           available because profile is not compatible with device ...)"
# On claw-7 `autoconnect=true` quietly rescued that, which is why it shipped.
# A conversion that only works when autoconnect happens to win a race is a coin
# flip, so wait for the state the activation actually needs.
i=0
DEV_STATE=""
while [ "$i" -lt 20 ]; do
	DEV_STATE="$(nm_dev_field "$WLAN" 3 || true)"
	[ -n "$DEV_STATE" ] && [ "$DEV_STATE" != unmanaged ] && break
	sleep 1
	i=$((i + 1))
done

# NO SECOND EXIT PATH. NM_VERIFIED below is the one gate, and this stays a
# diagnosis rather than a `die` so that a failure here still rolls back through
# the same rollback everything else uses.
if [ "${DEV_STATE:-unmanaged}" = unmanaged ]; then
	err "$WLAN is STILL 'unmanaged' after 20s. NetworkManager was asked to take this"
	err "  radio and did not. Check that $NM_CONFD/10-fleet-managed.conf exists and"
	err "  that NetworkManager actually restarted — an NM that never re-read its"
	err "  config still has [ifupdown] managed=false. Not activating a profile"
	err "  against a radio no manager owns."
else
	log "$WLAN left 'unmanaged' after ${i}s (state '$DEV_STATE'); activating fleet-wifi-primary"
	nmcli con up fleet-wifi-primary >/dev/null 2>&1 || true
fi

# ── 6. THE SAFETY GATE ─────────────────────────────────────────────────────
NM_VERIFIED=no
if nm_verify "$PRE_ADDR"; then NM_VERIFIED=yes; fi

if [ "$NM_VERIFIED" != yes ]; then
	err "NetworkManager did not verify. Rolling back to ifupdown IN PLACE and NOT rebooting."
	restore_ifupdown
	disarm_watchdog
	err "  /etc/network/interfaces was never modified; this node is exactly as it was."
	err "  The profiles are still in $NM_CONNS for inspection."
	exit 1
fi

# ── 7. teardown. UNREACHABLE unless nmcli verified above ───────────────────
neutralise_ifupdown
log "rebooting. \`ifdown; ifup\` is deliberately not used — a failed ifdown leaves"
log "  /run/network/ifstate claiming the interface is still configured and makes"
log "  the following ifup a silent no-op. /run is tmpfs; a reboot cannot hit that."
log "After it comes back: sh nm-convert.sh --check, then --commit."
systemctl reboot
