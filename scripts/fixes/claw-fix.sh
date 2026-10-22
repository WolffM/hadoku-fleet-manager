#!/bin/sh
# claw-fix.sh — Debian is installed, node-bootstrap will not run. Find out why.
#
# THE ONE SCRIPT TO RUN when a freshly imaged box does not become a fleet node.
# It does not assume the fault is the network, or the clock, or apt. It checks
# everything that stands between "Debian booted" and "node-bootstrap.sh
# succeeds", and it checks ALL of it before repairing ANY of it.
#
# WHY DIAGNOSE-THEN-REPAIR, AND NOT CHECK-AND-FIX-AS-YOU-GO
# ----------------------------------------------------------
# The first version stopped at the first failure. That is the wrong shape for a
# script whose user is standing in a garage: it means one trip per fault. claw-5
# had FOUR independent problems -- no interface config, a six-hour clock skew,
# no apt sources, and no jq -- and a stop-on-first-error script reports one of
# them, gets fixed, and sends you back down the stairs for the next.
#
# So phase 1 runs every check and stops for nothing. Phase 2 repairs what is
# repairable, in dependency order. Phase 3 re-checks and reports what is left.
#
# EVERY CHECK IS THREE-VALUED. `ok`, `FAIL`, and `????` are different answers.
# A check that could not run is never reported as a pass, and never as a
# failure either: claw-5 cost six trips to a garage because "no wired carrier"
# was printed when the truth was "the driver had not loaded yet", and somebody
# read a could-not-look as a definite no.
#
# EVERY RUN LEAVES A BUNDLE ON THE STICK, before and after, so a trip that ends
# badly still comes back up the stairs carrying data.
#
# HOW TO ADD A CHECK -- this script is expected to grow as faults are found
# -------------------------------------------------------------------------
# Two edits, always in this shape:
#
#   1. In diagnose(), one line:
#          record <id> ok|FAIL|???? "what is true, in the operator's words"
#   2. In repair(), a block guarded by that id:
#          if [ "$(state_of <id>)" = FAIL ]; then ... DID=1; fi
#
# If a fault CANNOT be repaired from software -- no controller, no cable, an
# unnamed box, a full disk -- add the id to UNREPAIRABLE below instead of
# writing an empty repair. That list is what tells the reader "this one needs
# hands or a decision", and `fixes/claw-fix.test.mjs` fails the build if a check
# has neither a repair nor an entry there. The two halves cannot drift.
#
# POSIX sh. Runs on a booted system at the console, not in a recovery shell --
# for that, see claw-admin-fix.sh beside it.
#
# USAGE
#   sudo sh /mnt/fixes/claw-fix.sh            # diagnose, then repair
#   sudo sh /mnt/fixes/claw-fix.sh --check    # diagnose only, change nothing
#
# Then bring the stick back and read the bundle with:  fleet telemetry

set -u

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

G='' R='' Y='' B='' N=''
if [ -t 1 ]; then
	G=$(printf '\033[32m'); R=$(printf '\033[31m'); Y=$(printf '\033[33m')
	B=$(printf '\033[1m'); N=$(printf '\033[0m')
fi

[ "$(id -u)" = 0 ] || { echo "run as root: sudo sh $0"; exit 1; }

HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
KIT=$(cd "$HERE/.." 2>/dev/null && pwd)
HOST=$(cat /proc/sys/kernel/hostname 2>/dev/null || echo unknown)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# Believe $0 only if it looks like the kit. Piped in over ssh, $0 is "sh" and
# the parent of the CWD is wherever the shell started -- which once wrote a
# bundle to /home/diagnostics. That is not a diagnostic, it is litter.
if [ -n "$KIT" ] && [ -w "$KIT" ] && { [ -d "$KIT/bootstrap" ] || [ -d "$KIT/profiles" ]; }; then
	OUT="$KIT/diagnostics/$HOST-$STAMP"
else
	KIT=""
	OUT="/var/log/claw-fix/$HOST-$STAMP"
fi
mkdir -p "$OUT" 2>/dev/null || OUT=""
LOG="${OUT:+$OUT/run.log}"
RESULTS="${OUT:+$OUT/checks.txt}"
[ -n "$RESULTS" ] || RESULTS=/tmp/claw-fix-checks.$$
: >"$RESULTS"

emit() { printf '%s\n' "$2" >>"${LOG:-/dev/null}" 2>/dev/null; printf '%s%s%s\n' "$1" "$2" "$N"; }
info() { emit '' "$(printf '        %s' "$1")"; }
act()  { emit "$Y" "$(printf '     ->  %s' "$1")"; }
head2(){ emit "$B" "$(printf '\n== %s' "$1")"; }

# Command output belongs in the bundle too. The first version printed apt's
# error to the screen and nowhere else, so the ONE line explaining the failure
# was missing from the bundle it had just written.
run_logged() {
	printf '\n$ %s\n' "$*" >>"${LOG:-/dev/null}" 2>/dev/null
	"$@" 2>&1 | tee -a "${LOG:-/dev/null}" | sed 's/^/        /'
}

# record <id> <ok|FAIL|????> <message>
record() {
	printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$RESULTS"
	case "$2" in
	ok)   emit "$G" "$(printf '  [ ok ] %s' "$3")" ;;
	FAIL) emit "$R" "$(printf '  [FAIL] %s' "$3")" ;;
	*)    emit "$Y" "$(printf '  [????] %s' "$3")" ;;
	esac
}
state_of() { grep "^$1|" "$RESULTS" 2>/dev/null | tail -1 | cut -d'|' -f2; }
FLEET_USER="${SUDO_USER:-hadoku}"

# Checks that software cannot fix: they need hands, hardware, or a human
# decision. Declared, so the gate can tell a deliberate omission from a
# forgotten repair. See "HOW TO ADD A CHECK" in the header.
UNREPAIRABLE="nic drv link host disk route sshconf pcie" 

collect() {
	[ -n "$OUT" ] || return 0
	d="$OUT/$1"; mkdir -p "$d" 2>/dev/null || return 0
	{
		echo "host=$HOST"; echo "when=$(date -u +%FT%TZ)"; echo "kernel=$(uname -r)"
		echo "arch=$(uname -m)"
		echo "distro=$(. /etc/os-release 2>/dev/null && echo "${ID:-} ${VERSION_CODENAME:-}")"
		echo "vendor=$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)"
		echo "product=$(cat /sys/class/dmi/id/product_name 2>/dev/null)"
		echo "cpu_model=$(grep -m1 '^model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //')"
		echo "cpu_threads=$(grep -c ^processor /proc/cpuinfo)"
		echo "mem_total_kb=$(grep -m1 MemTotal /proc/meminfo | tr -dc 0-9)"
		echo "uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
		echo "clock_utc=$(date -u +%FT%TZ)"
		echo "wired_interfaces=$(ls -d /sys/class/net/e* 2>/dev/null | wc -l)"
		echo "wireless_interfaces=$(ls -d /sys/class/net/*/wireless 2>/dev/null | wc -l)"
		for n in /sys/class/net/*; do
			i=$(basename "$n"); [ "$i" = lo ] && continue
			echo "net.$i.mac=$(cat "$n/address" 2>/dev/null)"
			echo "net.$i.carrier=$(cat "$n/carrier" 2>/dev/null)"
			echo "net.$i.operstate=$(cat "$n/operstate" 2>/dev/null)"
			echo "net.$i.driver=$(basename "$(readlink -f "$n/device/driver" 2>/dev/null)" 2>/dev/null)"
		done
		for b in /sys/block/*; do
			i=$(basename "$b")
			case $i in loop*|ram*|sr*|dm-*|zram*|md*) continue ;; esac
			echo "disk.$i.bytes=$(( $(cat "$b/size" 2>/dev/null || echo 0) * 512 ))"
			echo "disk.$i.model=$(cat "$b/device/model" 2>/dev/null)"
		done
	} >"$d/summary.txt" 2>&1

	{ echo '-- link'; ip link; echo '-- addr'; ip addr; echo '-- route'; ip route
	  echo '-- resolv.conf'; cat /etc/resolv.conf; echo '-- hosts'; cat /etc/hosts
	} >"$d/network.txt" 2>&1
	{ echo '-- interfaces'; cat /etc/network/interfaces
	  for f in /etc/network/interfaces.d/* /etc/systemd/network/*; do
	    [ -f "$f" ] && { echo "---- $f"; cat "$f"; }
	  done
	  echo '-- NetworkManager'; systemctl is-active NetworkManager 2>&1
	} >"$d/netconfig.txt" 2>&1
	{ echo '-- sources.list'; cat /etc/apt/sources.list
	  for f in /etc/apt/sources.list.d/*; do [ -f "$f" ] && { echo "---- $f"; cat "$f"; }; done
	  echo '-- packages'
	  for p in jq curl ca-certificates systemd-timesyncd openssh-server sudo ifupdown isc-dhcp-client; do
	    printf '%-20s %s\n' "$p" "$(dpkg -s "$p" 2>/dev/null | sed -n 's/^Status: //p' || echo 'not installed')"
	  done
	} >"$d/apt.txt" 2>&1
	{ timedatectl 2>&1; echo '-- date -u'; date -u; } >"$d/clock.txt" 2>&1
	{ echo "-- $FLEET_USER sudoers"; ls -la /etc/sudoers.d/ 2>&1
	  echo '-- authorized_keys'
	  wc -c "/home/$FLEET_USER/.ssh/authorized_keys" 2>&1
	  echo '-- sshd'; systemctl is-enabled ssh 2>&1; systemctl is-active ssh 2>&1
	} >"$d/access.txt" 2>&1
	if command -v lspci >/dev/null 2>&1; then lspci -nnk >"$d/pci.txt" 2>&1; else
		for n in /sys/bus/pci/devices/*; do
			echo "$(basename "$n") $(cat "$n/vendor" 2>/dev/null):$(cat "$n/device" 2>/dev/null) class=$(cat "$n/class" 2>/dev/null) driver=$(basename "$(readlink -f "$n/driver" 2>/dev/null)" 2>/dev/null)"
		done >"$d/pci.txt" 2>&1
	fi
	dmesg >"$d/dmesg.txt" 2>&1
	systemctl --failed --no-pager >"$d/failed-units.txt" 2>&1
	df -h >"$d/disk.txt" 2>&1
	ls -t /var/log/node-bootstrap-*.log 2>/dev/null | head -1 | while read -r f; do
		cp "$f" "$d/node-bootstrap.log" 2>/dev/null
	done
	cp "$RESULTS" "$d/checks.txt" 2>/dev/null
	sync 2>/dev/null || true
	return 0
}

# ════════════════════════════════════════════════════════════════════════════
# PHASE 1 — DIAGNOSE. Runs every check. Stops for nothing.
# ════════════════════════════════════════════════════════════════════════════
LINK=""
diagnose() {
	LINK=""
	: >"$RESULTS"

	head2 "identity"
	case "$HOST" in
	'' | localhost | localhost.localdomain | debian)
		record host FAIL "hostname is '$HOST' — nobody has named this box" ;;
	*) record host ok "hostname is $HOST" ;;
	esac
	# The "sudo: unable to resolve host" stall. Every sudo waits on a DNS
	# timeout until this is fixed, which makes every other repair slow.
	if [ "$HOST" = localhost ] || grep -qsE "^127\.0\.[01]\.1[[:space:]].*[[:space:]]$HOST( |\$)" /etc/hosts ||
		grep -qs "[[:space:]]$HOST\$" /etc/hosts; then
		record hosts ok "/etc/hosts resolves $HOST"
	else
		record hosts FAIL "/etc/hosts does not resolve $HOST — every sudo stalls on DNS"
	fi

	# THE SYSTEM BUS, and it goes here because half the checks below are
	# systemctl calls that cannot work without it.
	#
	# claw-4, 2026-09-02: dbus.socket was inactive on a booted system with
	# systemd as PID 1. hostnamectl failed in node-bootstrap step 3 and the run
	# carried on and declared the node converged with the wrong hostname; and
	# claw-fix could not enable ssh, the one repair it reported and could not
	# perform. Two unrelated-looking failures, one cause, and neither message
	# named it -- both said "Failed to connect to system scope bus", which reads
	# as systemd being broken rather than one socket being down.
	if [ -S /run/dbus/system_bus_socket ] && systemctl is-system-running >/dev/null 2>&1; then
		record dbus ok "the system bus is up"
	elif [ -S /run/dbus/system_bus_socket ]; then
		# The socket exists but systemctl still cannot talk to systemd. Degraded
		# is not down: is-system-running reports non-zero for "degraded" too.
		record dbus ok "the system bus socket exists (systemd reports $(systemctl is-system-running 2>&1 | head -1))"
	else
		record dbus FAIL "NO system bus socket — every systemctl and hostnamectl call will fail"
	fi

	head2 "network hardware"
	CTRL=0
	for d in /sys/bus/pci/devices/*; do
		[ -r "$d/class" ] || continue
		case "$(cat "$d/class")" in 0x0200*)
			CTRL=$((CTRL+1))
			DRV=$(basename "$(readlink -f "$d/driver" 2>/dev/null)" 2>/dev/null)
			info "controller $(cat "$d/vendor" 2>/dev/null):$(cat "$d/device" 2>/dev/null) driver=${DRV:-NONE}" ;;
		esac
	done
	[ "$CTRL" -gt 0 ] && record nic ok "ethernet controller present ($CTRL)" \
		|| record nic FAIL "no ethernet controller on the PCI bus — a cable cannot help"

	WIRED=""
	for n in /sys/class/net/*; do
		i=$(basename "$n")
		case "$i" in lo|wl*|docker*|veth*|br-*|tail*|nordlynx) continue ;; esac
		[ -d "$n/device" ] || continue
		WIRED="$WIRED $i"
	done
	WIRED=$(echo "$WIRED" | sed 's/^ //')
	[ -n "$WIRED" ] && record drv ok "wired interface(s): $WIRED" \
		|| record drv FAIL "controller present but no interface — the driver did not bind"

	if [ -n "$WIRED" ]; then
		[ "$CHECK_ONLY" = 0 ] && { for i in $WIRED; do ip link set "$i" up 2>/dev/null || true; done; sleep 2; }
		DOWN=0
		for i in $WIRED; do
			C=$(cat "/sys/class/net/$i/carrier" 2>/dev/null || echo 0)
			O=$(cat "/sys/class/net/$i/operstate" 2>/dev/null || echo unknown)
			if [ "$C" = 1 ]; then LINK="$i"; break; fi
			[ "$O" = down ] && DOWN=1
		done
		if [ -n "$LINK" ]; then
			record link ok "cable detected on $LINK ($(cat "/sys/class/net/$LINK/speed" 2>/dev/null)Mb)"
		elif [ "$CHECK_ONLY" = 1 ] && [ "$DOWN" = 1 ]; then
			record link '????' "every wired interface is DOWN, so carrier cannot be read"
		else
			record link FAIL "no cable in any wired interface ($WIRED)"
		fi
	fi

	head2 "network configuration"
	if [ -n "$LINK" ]; then
		CFG=0
		grep -qsE "^[[:space:]]*iface[[:space:]]+$LINK[[:space:]]" /etc/network/interfaces && CFG=1
		grep -qrsE "^[[:space:]]*iface[[:space:]]+$LINK[[:space:]]" /etc/network/interfaces.d 2>/dev/null && CFG=1
		grep -qrs "$LINK" /etc/systemd/network 2>/dev/null && CFG=1
		systemctl is-active --quiet NetworkManager 2>/dev/null && CFG=1
		[ "$CFG" = 1 ] && record ifcfg ok "$LINK is configured" \
			|| record ifcfg FAIL "$LINK has NO configuration — what a netless install leaves behind"
		ip -4 -o addr show dev "$LINK" 2>/dev/null | grep -q 'inet ' \
			&& record addr ok "$LINK has $(ip -4 -o addr show dev "$LINK" | awk '{print $4}')" \
			|| record addr FAIL "$LINK has no address"
	else
		record ifcfg '????' "no live link, so interface configuration was not checked"
		record addr '????' "no live link, so addressing was not checked"
	fi
	ip route show default 2>/dev/null | grep -q . \
		&& record route ok "default via $(ip route show default | awk '{print $3; exit}')" \
		|| record route FAIL "no default route"
	getent hosts deb.debian.org >/dev/null 2>&1 \
		&& record dns ok "DNS resolves deb.debian.org" \
		|| record dns FAIL "DNS does not resolve deb.debian.org"

	head2 "pci health"
	# THE FAULT THAT DESTROYED claw-4's INSTALL, and that no amount of preseed
	# tuning could have prevented.
	#
	# Its Realtek RTL8723BE wifi card (02:00.0, behind root port 00:1c.0) threw a
	# storm of PCIe correctable errors during the install: 7.5 MILLION AER
	# messages in the installer's syslog. That flood consumed the bus and the
	# kernel log, USB reads timed out, /dev/sdc1 stopped opening, and Ventoy's
	# ISO mapping -- which is a dm-linear window over an extent on that very
	# device -- died with it. pkgsel then lost its media and the install was
	# unrecoverable in place. The post-mortem blamed Ventoy; the culprit was a
	# $10 wifi card.
	#
	# claw-5 sailed through the same stick because it has no wifi card at all.
	#
	# Correctable errors are, individually, harmless. A MILLION of them is not:
	# the cost is the reporting, not the error.
	AERSUM=0
	AERDEV=""
	AERSEEN=0
	for d in /sys/bus/pci/devices/*/aer_dev_correctable; do
		[ -r "$d" ] && AERSEEN=1
		[ -r "$d" ] || continue
		n=$(awk '{s+=$2} END{print s+0}' "$d" 2>/dev/null)
		[ "${n:-0}" -gt 1000 ] 2>/dev/null || continue
		AERSUM=$((AERSUM + n))
		AERDEV="$AERDEV $(basename "$(dirname "$d")")"
	done
	if [ "$AERSUM" -gt 1000 ]; then
		record pcie FAIL "PCIe correctable-error STORM: $AERSUM errors on$AERDEV"
		for x in $AERDEV; do
			info "  $x = $(lspci -s "${x#0000:}" 2>/dev/null | cut -c1-70)"
		done
		info "  This starves the bus and can make USB and disk reads time out."
		info "  Remedy: blacklist that device's driver, physically remove the card,"
		info "  or boot with pcie_aspm=off. It is a hardware fault, not a config one."
	elif [ "$AERSEEN" = 1 ]; then
		# Counters exist and are quiet. Only root ports and endpoints with AER
		# capability expose them, so testing one fixed address (the host bridge,
		# which has none) reported "unknown" on a perfectly healthy machine.
		record pcie ok "no PCIe error storm (${AERSUM} correctable)"
	else
		record pcie '????' "the kernel is not reporting AER counters, so PCI health is unknown"
	fi

	head2 "clock"
	# APT SIGNATURES ARE TIME-SENSITIVE, and a wrong clock reports as
	# "Not live until <date>" or "Release file is not valid yet" -- four layers
	# from the cause. claw-5 was SIX HOURS behind, because a netless install
	# never ran NTP and nothing since had corrected the RTC. Diagnosed as an apt
	# problem it is unfixable; diagnosed as a clock it takes one command.
	NOW=$(date -u +%s)
	SYNC=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)
	# The stick's own build time is a FLOOR that needs no network: this box
	# cannot legitimately believe it is earlier than the moment the stick that
	# is currently plugged into it was written.
	FLOOR=""
	[ -n "$KIT" ] && [ -r "$KIT/STAMP" ] && FLOOR=$(sed -n 's/^built=//p' "$KIT/STAMP" | head -1)
	if [ -n "$FLOOR" ]; then
		FS=$(date -u -d "$FLOOR" +%s 2>/dev/null || echo '')
		if [ -n "$FS" ] && [ "$NOW" -lt "$FS" ]; then
			record clock FAIL "clock reads $(date -u +%FT%TZ), BEFORE this stick was built ($FLOOR)"
		elif [ "$SYNC" = yes ]; then
			record clock ok "clock $(date -u +%FT%TZ), NTP synchronized"
		else
			record clock '????' "clock $(date -u +%FT%TZ) is plausible but NTP is not synchronized"
		fi
	elif [ "$SYNC" = yes ]; then
		record clock ok "clock $(date -u +%FT%TZ), NTP synchronized"
	else
		record clock '????' "no reference to check the clock against, and NTP is not synchronized"
	fi

	head2 "apt"
	SRC=0
	for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
		[ -r "$f" ] || continue
		grep -qsE '^[[:space:]]*(deb|URIs:)[[:space:]]+https?://' "$f" && SRC=1
	done
	[ "$SRC" = 1 ] && record aptsrc ok "apt has a network source" \
		|| record aptsrc FAIL "apt has NO network source — only a CD entry, or none"
	if [ "$(state_of dns)" = ok ] && [ "$SRC" = 1 ]; then
		if apt-get update -qq >/dev/null 2>&1; then record aptupd ok "apt-get update succeeds"
		else record aptupd FAIL "apt-get update FAILS"; fi
	else
		record aptupd '????' "not tested — DNS or sources are not ready"
	fi

	head2 "what node-bootstrap needs"
	MISSING=""
	for p in jq curl ca-certificates; do dpkg -s "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"; done
	MISSING=$(echo "$MISSING" | sed 's/^ //')
	[ -z "$MISSING" ] && record pkgs ok "jq, curl, ca-certificates present" \
		|| record pkgs FAIL "missing: $MISSING"
	dpkg -s systemd-timesyncd >/dev/null 2>&1 && record ntp ok "systemd-timesyncd installed" \
		|| record ntp FAIL "systemd-timesyncd absent — the clock will drift again"
	# SSH IS THE WHOLE POINT OF A FLEET NODE, so it gets a chain rather than one
	# check. "the unit is enabled" says nothing about whether the package is
	# installed, whether host keys exist, whether the config parses, or whether
	# anything is listening -- and on claw-4 the earlier one-line check reported
	# a fault it could not repair, which is the worst of both.
	dpkg -s openssh-server >/dev/null 2>&1 \
		&& record sshpkg ok "openssh-server installed" \
		|| record sshpkg FAIL "openssh-server is NOT installed"

	# A failed or interrupted install routinely leaves /etc/ssh with no host
	# keys. sshd refuses to start without one and the unit just fails, which
	# reads as "ssh is broken" rather than "one command away".
	HK=$(ls /etc/ssh/ssh_host_*_key 2>/dev/null | wc -l)
	[ "$HK" -gt 0 ] && record sshhost ok "$HK host key(s) present" \
		|| record sshhost FAIL "NO ssh host keys — sshd cannot start without one"

	if command -v sshd >/dev/null 2>&1 || [ -x /usr/sbin/sshd ]; then
		if "$(command -v sshd || echo /usr/sbin/sshd)" -t 2>/dev/null; then
			record sshconf ok "sshd config parses"
		else
			record sshconf FAIL "sshd config does NOT parse — it will refuse to start"
		fi
	else
		record sshconf '????' "no sshd binary, so its config was not checked"
	fi

	if [ -s "/home/$FLEET_USER/.ssh/authorized_keys" ]; then
		record sshkey ok "$FLEET_USER has an authorized_keys ($(wc -c <"/home/$FLEET_USER/.ssh/authorized_keys") bytes)"
	else
		record sshkey FAIL "$FLEET_USER has no authorized_keys — the fleet cannot ssh in"
	fi

	# sshd SILENTLY IGNORES a key it thinks anyone else could have written. Loose
	# permissions produce "Permission denied (publickey)" with a correct key in
	# place, which is the single most misleading failure in this whole chain.
	SSHDIR="/home/$FLEET_USER/.ssh"
	if [ -d "$SSHDIR" ]; then
		PERM_OK=1
		[ "$(stat -c %U "$SSHDIR" 2>/dev/null)" = "$FLEET_USER" ] || PERM_OK=0
		case "$(stat -c %a "$SSHDIR" 2>/dev/null)" in 700 | 750) ;; *) PERM_OK=0 ;; esac
		if [ -f "$SSHDIR/authorized_keys" ]; then
			case "$(stat -c %a "$SSHDIR/authorized_keys" 2>/dev/null)" in 600 | 644 | 640) ;; *) PERM_OK=0 ;; esac
			[ "$(stat -c %U "$SSHDIR/authorized_keys" 2>/dev/null)" = "$FLEET_USER" ] || PERM_OK=0
		fi
		[ "$PERM_OK" = 1 ] && record sshperm ok "$SSHDIR ownership and modes are sane" \
			|| record sshperm FAIL "$SSHDIR perms/ownership are wrong — sshd ignores keys it distrusts"
	else
		record sshperm FAIL "$SSHDIR does not exist"
	fi

	systemctl is-enabled ssh >/dev/null 2>&1 && record sshd ok "ssh is enabled" \
		|| record sshd FAIL "ssh is not enabled"
	systemctl is-active ssh >/dev/null 2>&1 && record sshrun ok "sshd is running" \
		|| record sshrun FAIL "sshd is NOT running"

	# THE ONLY CHECK THAT PROVES ANYTHING END TO END. A unit can be enabled,
	# active, and listening on nothing.
	SSHPORT=$(awk '/^[[:space:]]*Port[[:space:]]/{print $2; exit}' /etc/ssh/sshd_config 2>/dev/null)
	[ -n "$SSHPORT" ] || SSHPORT=22
	if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE "[:.]$SSHPORT[[:space:]]"; then
		record sshlisten ok "something is listening on port $SSHPORT"
	else
		record sshlisten FAIL "NOTHING is listening on port $SSHPORT — the fleet cannot reach this node"
	fi

	if grep -qrs "$FLEET_USER.*NOPASSWD" /etc/sudoers.d/ 2>/dev/null; then
		record sudo ok "$FLEET_USER has passwordless sudo"
	else
		record sudo FAIL "$FLEET_USER has no NOPASSWD rule — provision-fleet needs it"
	fi
	FREE=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc 0-9)
	[ -n "$FREE" ] && [ "$FREE" -ge 10 ] && record disk ok "${FREE}G free on /" \
		|| record disk FAIL "only ${FREE:-?}G free on / — the toolchain needs more"

	# pnpm. NodeSource ships corepack inside nodejs but writes no shims until
	# `corepack enable` runs, so a node can come off bootstrap with node present
	# and no pnpm on PATH at all. claw-4 ran that way from onboarding until
	# 2026-09-02 and every pnpm-based CI job on it would have failed.
	if ! command -v node >/dev/null 2>&1; then
		record pnpm ???? "node is not installed — pnpm cannot be judged yet"
	elif command -v pnpm >/dev/null 2>&1; then
		record pnpm ok "pnpm $(pnpm --version 2>/dev/null) is on PATH"
	elif command -v corepack >/dev/null 2>&1; then
		record pnpm FAIL "no pnpm on PATH — corepack is installed but was never enabled"
	else
		record pnpm FAIL "no pnpm and no corepack — this node cannot build anything"
	fi
}

# ════════════════════════════════════════════════════════════════════════════
# PHASE 2 — REPAIR, in dependency order.
# ════════════════════════════════════════════════════════════════════════════
repair() {
	head2 "repairs"
	DID=0

	# BEFORE EVERYTHING ELSE. Enabling ssh, starting timesyncd and setting a
	# hostname are all bus calls; repairing them first against a dead bus just
	# produces a second round of the same failures.
	if [ "$(state_of dbus)" = FAIL ]; then
		act "starting the system bus (dbus.socket)"
		systemctl start dbus.socket >/dev/null 2>&1 || true
		systemctl start dbus.service >/dev/null 2>&1 || true
		sleep 2
		if [ -S /run/dbus/system_bus_socket ]; then
			info "the bus is up — systemctl and hostnamectl will work now"
		else
			act "the bus did not come up. A reboot is the reliable fix; until then"
			info "systemctl, hostnamectl and anything else bus-backed will keep failing."
		fi
		DID=1
	fi

	if [ "$(state_of hosts)" = FAIL ]; then
		act "adding $HOST to /etc/hosts (stops every sudo stalling on DNS)"
		cp /etc/hosts "/etc/hosts.bak.$STAMP" 2>/dev/null
		if grep -qs '^127.0.1.1' /etc/hosts; then
			sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$HOST/" /etc/hosts
		else
			printf '127.0.1.1\t%s\n' "$HOST" >>/etc/hosts
		fi
		DID=1
	fi

	if [ "$(state_of ifcfg)" = FAIL ] && [ -n "$LINK" ]; then
		act "writing a DHCP stanza for $LINK"
		[ -f /etc/network/interfaces ] && cp /etc/network/interfaces "/etc/network/interfaces.bak.$STAMP"
		[ -f /etc/network/interfaces ] || printf 'auto lo\niface lo inet loopback\n' >/etc/network/interfaces
		printf '\n# added by claw-fix.sh\nauto %s\niface %s inet dhcp\n' "$LINK" "$LINK" >>/etc/network/interfaces
		DID=1
	fi

	if [ "$(state_of addr)" = FAIL ] && [ -n "$LINK" ]; then
		act "asking for a DHCP lease on $LINK"
		if command -v dhclient >/dev/null 2>&1; then dhclient -v "$LINK" >/dev/null 2>&1 || true
		elif command -v ifup >/dev/null 2>&1; then ifup "$LINK" >/dev/null 2>&1 || true
		elif command -v udhcpc >/dev/null 2>&1; then udhcpc -i "$LINK" -n >/dev/null 2>&1 || true
		fi
		sleep 3; DID=1
	fi

	if [ "$(state_of clock)" = FAIL ]; then
		# No network time source is guaranteed here -- curl and wget are both
		# absent from a minimal install, which is the very thing being repaired.
		# The stick's build time is a floor that needs nothing, and it is enough
		# to make archive signatures verify: the stick was written after the
		# archive signed what this box is about to fetch.
		if [ -n "$FLOOR" ]; then
			act "setting the clock forward to the stick's build time ($FLOOR)"
			date -u -s "$FLOOR" >/dev/null 2>&1 && DID=1
			info "this is a FLOOR, not the real time — timesyncd corrects it below"
		else
			act "clock is wrong and there is no reference to correct it from"
			info "set it by hand:  sudo date -u -s 'YYYY-MM-DD HH:MM:SS'"
		fi
	fi

	if [ "$(state_of dns)" = FAIL ] && [ "$(state_of route)" = ok ]; then
		# Routing works and names do not resolve. The overwhelmingly common
		# cause is a resolv.conf with no nameserver at all, which is what a
		# netless install leaves. The default gateway answers DNS on virtually
		# every home LAN, so ask it — and only when nothing is configured, so
		# this can never fight a resolver that DHCP did set.
		if ! grep -qs '^nameserver' /etc/resolv.conf; then
			GW=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
			if [ -n "$GW" ]; then
				act "resolv.conf has no nameserver — adding the gateway ($GW)"
				cp /etc/resolv.conf "/etc/resolv.conf.bak.$STAMP" 2>/dev/null
				printf 'nameserver %s\n' "$GW" >>/etc/resolv.conf
				DID=1
			fi
		else
			act "resolv.conf HAS a nameserver but names do not resolve"
			info "that is the resolver itself failing, not a missing config"
		fi
	fi

	if [ "$(state_of aptsrc)" = FAIL ]; then
		CODENAME=$(. /etc/os-release 2>/dev/null && echo "${VERSION_CODENAME:-}")
		if [ -z "$CODENAME" ]; then
			act "cannot tell which Debian release this is; not guessing at sources"
		else
			act "writing deb.debian.org sources for $CODENAME"
			[ -f /etc/apt/sources.list ] && cp /etc/apt/sources.list "/etc/apt/sources.list.bak.$STAMP"
			{
				printf '# written by claw-fix.sh\n'
				printf 'deb http://deb.debian.org/debian %s main contrib non-free-firmware\n' "$CODENAME"
				printf 'deb http://deb.debian.org/debian %s-updates main contrib non-free-firmware\n' "$CODENAME"
				printf 'deb http://security.debian.org/debian-security %s-security main contrib non-free-firmware\n' "$CODENAME"
			} >/etc/apt/sources.list
			DID=1
		fi
	fi

	if [ "$(state_of pkgs)" = FAIL ] || [ "$(state_of ntp)" = FAIL ] || [ "$(state_of aptupd)" = FAIL ]; then
		act "apt-get update"
		if ! apt-get update -qq >/dev/null 2>&1; then
			act "apt-get update failed — the error it gave:"
			run_logged apt-get update
		else
			WANT=""
			for p in jq curl ca-certificates systemd-timesyncd; do
				dpkg -s "$p" >/dev/null 2>&1 || WANT="$WANT $p"
			done
			if [ -n "$WANT" ]; then
				act "installing:$WANT"
				# shellcheck disable=SC2086
				DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $WANT >/dev/null 2>&1 || true
				DID=1
			fi
		fi
	fi

	# Real time, once there is a network and a client to get it with. The floor
	# above only unblocks apt; this is what makes the clock correct and keeps it
	# correct across reboots.
	if command -v timedatectl >/dev/null 2>&1 && dpkg -s systemd-timesyncd >/dev/null 2>&1; then
		if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" != yes ]; then
			act "enabling NTP"
			timedatectl set-ntp true >/dev/null 2>&1 || true
			sleep 4; DID=1
		fi
	fi

	if [ "$(state_of sshkey)" = FAIL ] && [ -n "$KIT" ] && [ -s "$KIT/bootstrap/authorized_key.pub" ]; then
		act "installing the fleet key for $FLEET_USER from the stick"
		mkdir -p "/home/$FLEET_USER/.ssh"
		cat "$KIT/bootstrap/authorized_key.pub" >>"/home/$FLEET_USER/.ssh/authorized_keys"
		chown -R "$FLEET_USER:$FLEET_USER" "/home/$FLEET_USER/.ssh"
		chmod 700 "/home/$FLEET_USER/.ssh"; chmod 600 "/home/$FLEET_USER/.ssh/authorized_keys"
		DID=1
	fi

	if [ "$(state_of sudo)" = FAIL ]; then
		act "granting $FLEET_USER passwordless sudo"
		printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$FLEET_USER" >"/etc/sudoers.d/90-$FLEET_USER"
		chmod 440 "/etc/sudoers.d/90-$FLEET_USER"; DID=1
	fi

	if [ "$(state_of sshpkg)" = FAIL ]; then
		act "installing openssh-server"
		DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null 2>&1 || true
		DID=1
	fi

	if [ "$(state_of sshhost)" = FAIL ]; then
		# -A generates one key of each type it does not already have. Safe to
		# re-run, and it is what the package's own postinst does.
		act "generating the missing ssh host keys"
		ssh-keygen -A >/dev/null 2>&1 || true
		DID=1
	fi

	if [ "$(state_of sshperm)" = FAIL ]; then
		act "correcting ownership and modes on /home/$FLEET_USER/.ssh"
		mkdir -p "/home/$FLEET_USER/.ssh"
		chown -R "$FLEET_USER:$FLEET_USER" "/home/$FLEET_USER/.ssh"
		chmod 700 "/home/$FLEET_USER/.ssh"
		[ -f "/home/$FLEET_USER/.ssh/authorized_keys" ] &&
			chmod 600 "/home/$FLEET_USER/.ssh/authorized_keys"
		DID=1
	fi

	if [ "$(state_of sshd)" = FAIL ] || [ "$(state_of sshrun)" = FAIL ] ||
		[ "$(state_of sshlisten)" = FAIL ]; then
		act "enabling and starting ssh"
		systemctl enable ssh >/dev/null 2>&1 || true
		systemctl restart ssh >/dev/null 2>&1 || systemctl start ssh >/dev/null 2>&1 || true
		sleep 2
		if ! systemctl is-active ssh >/dev/null 2>&1; then
			# WHY it would not start, in the bundle and on the screen. "ssh is not
			# running" without the reason is what sent an operator to configure
			# sshd by hand.
			act "ssh still will not start — what systemd says:"
			run_logged systemctl --no-pager --lines=15 status ssh
		fi
		DID=1
	fi

	# The firewall can be the reason nothing answers on 22 even with sshd up.
	if [ "$(state_of sshlisten)" = FAIL ] && command -v ufw >/dev/null 2>&1; then
		if ufw status 2>/dev/null | grep -q '^Status: active'; then
			act "ufw is active — allowing ssh from the local network"
			LANCIDR=$(ip -4 -o addr show 2>/dev/null | awk '$2!="lo"{print $4; exit}' |
				sed 's|\.[0-9]*/|.0/|')
			[ -n "$LANCIDR" ] && ufw allow from "$LANCIDR" to any port "$SSHPORT" proto tcp >/dev/null 2>&1 || true
			DID=1
		fi
	fi

	# pnpm, via corepack's shim ONLY.
	#
	# Never `npm i -g pnpm`: a globally-installed pnpm shadows the shim and the
	# two disagree about the store (pnpm 10 -> store/v10, pnpm 11 -> store/v11).
	# check-fleet-toolchain.mjs exists because of exactly that split on all three
	# claws in August, so repairing it that way here would trade a missing pnpm
	# for a silent one — the harder fault to see.
	if [ "$(state_of pnpm)" = FAIL ] && command -v corepack >/dev/null 2>&1; then
		act "enabling corepack so this node has a pnpm"
		corepack enable >/dev/null 2>&1 || true
		DID=1
	fi

	[ "$DID" = 0 ] && info "nothing to repair."
	return 0
}

# ════════════════════════════════════════════════════════════════════════════
printf '\n%s=== claw-fix on %s ===%s\n' "$B" "$HOST" "$N"
[ -n "$OUT" ] && info "diagnostics: $OUT" || info "WARNING: nowhere writable for a bundle"
collect before

printf '\n%s──────── PHASE 1: diagnose ────────%s\n' "$B" "$N"
diagnose
count() { c=$(grep -c "$1" "$RESULTS" 2>/dev/null); echo "${c:-0}"; }
BAD=$(count '|FAIL|')
UNK=$(count '|????|')
printf '\n  %s%s failing%s, %s%s could not be determined%s, %s ok\n' \
	"$R" "$BAD" "$N" "$Y" "$UNK" "$N" "$(count '|ok|')"

if [ "$CHECK_ONLY" = 1 ]; then
	printf '\n%s--check: nothing was changed.%s\n' "$Y" "$N"
elif [ "$BAD" = 0 ]; then
	printf '\n%sNothing to repair.%s\n' "$G" "$N"
else
	printf '\n%s──────── PHASE 2: repair ────────%s\n' "$B" "$N"
	repair
	printf '\n%s──────── PHASE 3: verify ────────%s\n' "$B" "$N"
	HOST=$(cat /proc/sys/kernel/hostname 2>/dev/null || echo unknown)
	diagnose
	BAD=$(count '|FAIL|')
	collect after
fi

printf '\n'
if [ "$BAD" = 0 ]; then
	printf '%s=== every check passes — run node-bootstrap next ===%s\n' "$G" "$N"
	printf '\n  sudo bash %s/bootstrap/node-bootstrap.sh\n' "${KIT:-/mnt}"
else
	printf '%s=== %s check(s) still failing ===%s\n' "$R" "$BAD" "$N"
	grep '|FAIL|' "$RESULTS" 2>/dev/null | cut -d'|' -f3 | sed 's/^/    /'
fi
[ -n "$OUT" ] && printf '\n%sDiagnostics:%s %s\n  read them with:  fleet telemetry\n' "$G" "$N" "$OUT"
[ "$BAD" = 0 ] || exit 1
exit 0
