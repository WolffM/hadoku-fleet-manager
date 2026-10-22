#!/usr/bin/env bash
#
# net-survey — read the site network the fleet lives on, and say what is on it.
#
# WHY THIS EXISTS
# ---------------
# On 2026-08-31 onboarding stopped being an install problem and became a NETWORK
# problem: claw-5 has no wireless hardware, the garage has no cable, and "so what
# do we plug it into" needed the actual topology. Three model numbers were
# guessed at before this existed and all three guesses were wrong. Twenty ad-hoc
# commands later the answer was one table. This is that table, as one command.
#
# THE MEASUREMENT THAT MATTERS IS TAKEN ON THE NODES, NOT HERE
# ------------------------------------------------------------
# The single most expensive mistake of that session was trusting this host's own
# wifi scan uncritically. nmcli returns STALE entries beside fresh ones for the
# same BSSID — the gateway showed up at both 15% and 97% in one listing — and
# reading the stale row made the site's 5GHz look unusable. Two conclusions were
# drawn from it and both were wrong ("5GHz is too weak for the garage", "DFS
# channel 100 is a problem") when all three claws in fact hold 5GHz ch100 at -56
# to -68 dBm and 234-650 Mbit/s. Section 6 now keeps only the strongest reading
# per BSSID, which is what makes a local scan worth printing at all.
#
# So section 5 ssh's into each reachable fleet node and reads `iw dev link`
# THERE. A local scan is still printed, because the RF neighbourhood is worth
# seeing, but it is labelled with the receiver's credibility rather than
# presented as fact. A radio that has never associated is an instrument nobody
# has calibrated.
#
# WHAT IT WILL NOT DO
# -------------------
# It reads. It never associates, never writes a config, never authenticates to a
# device. Everything is a ping, an ARP read, a TCP connect, a passive scan, or an
# ssh that runs read-only commands the fleet already has keys for.
#
# It does NOT probe port 7547 (TR-069 CPE management), deliberately. That port
# has a history of poorly-written consumer gateway firmware behaving badly on
# unexpected traffic, and a survey that reboots the router it is surveying is
# worse than no survey.
#
# THREE-VALUED, like every other reader in this repo. "I could not look" must
# never render as "nothing is there": a sweep that could not run says so, and a
# host that answered ARP but served no port is present-and-quiet, not absent. An
# empty map from a broken probe is the most expensive output this could produce,
# because it reads as a finished answer.
#
# NO SUDO REQUIRED, and it says what root would have added.
#
# USAGE
#   fleet net-survey                  # sweep the interface holding the default route
#   fleet net-survey --cidr 192.0.2.0/24
#   fleet net-survey --no-sweep       # passive: existing ARP cache only
#   fleet net-survey --no-nodes       # skip the ssh-into-each-node pass
#   fleet net-survey --quick          # skip the per-host port probes

set -u

CIDR=""
DO_SWEEP=true
DO_PORTS=true
DO_NODES=true

while [ $# -gt 0 ]; do
	case "$1" in
	--cidr) CIDR="${2:-}" && shift 2 ;;
	--no-sweep) DO_SWEEP=false && shift ;;
	--no-nodes) DO_NODES=false && shift ;;
	--quick) DO_PORTS=false && shift ;;
	-h | --help)
		sed -n '3,60p' "$0" | sed 's/^#\{1,\} \{0,1\}//'
		exit 0
		;;
	*)
		echo "net-survey: unknown option: $1 (try --help)" >&2
		exit 1
		;;
	esac
done

B=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
CYAN=$'\033[0;36m'
NC=$'\033[0m'

hdr() { printf '\n%s══ %s%s\n' "$B" "$1" "$NC"; }
note() { printf '%s   %s%s\n' "$DIM" "$*" "$NC"; }
miss() { printf '%s   [could not look] %s%s\n' "$YELLOW" "$*" "$NC"; }

# /usr/sbin is not on a non-root PATH on Debian, and arp-scan and iw both live
# there. Measured: `command -v arp-scan` returned nothing on a host that had it
# installed, which read as "the tool is missing" — a false negative that sends
# you to install a package you already have.
PATH="$PATH:/usr/sbin:/sbin"

MACPREFIX=""
for c in /usr/share/nmap/nmap-mac-prefixes /usr/share/arp-scan/ieee-oui.txt; do
	[ -f "$c" ] && MACPREFIX="$c" && break
done

# ── 1. where this host sits ─────────────────────────────────────────────────
hdr "this host"
printf '   %-16s %s\n' hostname "$(hostname)"
GW="$(ip route show default 2>/dev/null | awk '{print $3; exit}')"
GWIF="$(ip route show default 2>/dev/null | awk '{print $5; exit}')"
printf '   %-16s %s\n' "default via" "${GW:-<none>} on ${GWIF:-<none>}"
printf '   %-16s %s\n' "this address" "$(ip -4 -o addr show dev "${GWIF:-lo}" 2>/dev/null | awk '{print $4; exit}')"
printf '   %-16s %s\n' "DNS" "$(awk '/^nameserver/{printf "%s ", $2}' /etc/resolv.conf 2>/dev/null)"

if [ -z "$GW" ]; then
	miss "no default route — there is nothing to survey from here."
	exit 1
fi
[ -n "$CIDR" ] || CIDR="$(ip -4 -o addr show dev "$GWIF" 2>/dev/null | awk '{print $4; exit}')"
BASE="${CIDR%.*}"
BASE="${BASE#*:}"

# ── 2. the sweep ────────────────────────────────────────────────────────────
# Ping to POPULATE the neighbour table, then read the neighbour table. The ping
# is not the measurement: plenty of devices drop ICMP but must answer ARP to
# exist on the segment at all. Measured on a real /24 — `nmap -sn` as a
# non-root user found 21 hosts and the ARP cache held 28, because unprivileged
# nmap probes TCP/80 and /443 and anything without a web server reads as down.
hdr "LAN sweep — $BASE.0/24"
if [ "$DO_SWEEP" = true ]; then
	if [ "$(id -u)" = 0 ] && command -v arp-scan >/dev/null 2>&1; then
		note "arp-scan on $GWIF (layer 2, authoritative)…"
		arp-scan -l -I "$GWIF" >/dev/null 2>&1
	else
		note "pinging $BASE.1-254 to populate the neighbour table…"
		[ "$(id -u)" = 0 ] || note "not root: arp-scan would be faster and more complete."
		for h in $(seq 1 254); do
			ping -c1 -W1 -n "$BASE.$h" >/dev/null 2>&1 &
			# Bounded fan-out. 254 concurrent pings makes some kernels drop ARP
			# requests, which surfaces as hosts that "are not there".
			[ $((h % 64)) -eq 0 ] && wait
		done
		wait
	fi
else
	note "--no-sweep: existing neighbour table only; this WILL under-report."
fi

NEIGH="$(ip neigh show 2>/dev/null | grep -E "^$BASE\." | grep -viE 'FAILED|INCOMPLETE' |
	awk '{ if ($5 != "" && !seen[$1]++) print $1, $5 }' | sort -t. -k4 -n)"
if [ -z "$NEIGH" ]; then
	miss "the neighbour table is EMPTY, yet this host routes through $GW. That is a broken probe, not an empty network."
	exit 1
fi
note "$(printf '%s\n' "$NEIGH" | grep -c .) hosts answered."

# ── 3. what each one is ─────────────────────────────────────────────────────
vendor_of() {
	[ -n "$MACPREFIX" ] || { echo "-"; return; }
	local k
	k="$(printf '%s' "$1" | tr -d ':-' | tr 'a-z' 'A-Z' | cut -c1-6)"
	# Bit 1 of the first octet marks a locally-administered address: randomised
	# or virtual, and it decodes to no manufacturer at all. Reporting "unknown
	# vendor" for one states a fact that does not exist.
	case "$(printf '%s' "$1" | tr 'a-z' 'A-Z' | cut -c2)" in
	2 | 6 | A | E) echo "(randomised)" && return ;;
	esac
	grep -i "^$k " "$MACPREFIX" 2>/dev/null | head -1 | cut -d' ' -f2- | cut -c1-26
}

printf '\n   %-16s %-18s %-27s %s\n' ADDRESS MAC VENDOR "OPEN PORTS"
printf '   %s\n' "$(printf '─%.0s' $(seq 1 88))"
printf '%s\n' "$NEIGH" | while read -r ip mac; do
	[ -n "$mac" ] || continue
	v="$(vendor_of "$mac")"
	[ -n "$v" ] || v="-"
	open=""
	if [ "$DO_PORTS" = true ]; then
		# NOT 7547. See the header.
		for p in 22 53 80 443 8006 8080 8443; do
			timeout 1 bash -c "exec 3<>/dev/tcp/$ip/$p" 2>/dev/null && open="$open $p"
		done
	fi
	mark=""
	[ "$ip" = "$GW" ] && mark="${GREEN} ← gateway${NC}"
	printf '   %-16s %-18s %-27s %s%b\n' "$ip" "$mac" "$v" "${open# }" "$mark"
done

# ── 4. the fleet, declared against observed ─────────────────────────────────
# A node the manifest declares and the network cannot reach is the finding this
# section exists for. Addresses come from ssh config because that is what the
# fleet loops actually dial; the manifest supplies the roster.
hdr "fleet nodes — declared vs observed"
SSHCFG="$HOME/.ssh/config"
NODES=""
if [ -r "$SSHCFG" ]; then
	NODES="$(awk '/^[Hh]ost /{h=$2}
		/[Hh]ostName/{ if (h ~ /^(claw|hokon)/ && h !~ /-admin$/ && !seen[$2]++) print h, $2 }' \
		"$SSHCFG")"
fi
if [ -z "$NODES" ]; then
	miss "no claw/hokon entries in $SSHCFG — cannot map node names to addresses."
else
	printf '   %-10s %-16s %-8s %-8s %s\n' NODE ADDRESS PING 'SSH/22' NOTE
	printf '%s\n' "$NODES" | while read -r name ip; do
		ping -c1 -W1 -n "$ip" >/dev/null 2>&1 && p="up" || p="${YELLOW}DOWN${NC}"
		timeout 2 bash -c "exec 3<>/dev/tcp/$ip/22" 2>/dev/null && s="open" || s="closed"
		n=""
		# hokon refuses ssh to itself — that is the documented behaviour the
		# whole of src/lib/node-identity.ts exists for, not a fault.
		[ "$ip" = "$(ip -4 -o addr show dev "$GWIF" | awk '{print $4}' | cut -d/ -f1)" ] &&
			n="this host (refusing ssh to itself is correct)"
		printf '   %-10s %-16s %-8b %-8s %s\n' "$name" "$ip" "$p" "$s" "$n"
	done
fi

# ── 5. wifi, READ ON THE NODES ──────────────────────────────────────────────
# The trustworthy measurement. See the header for why this is not done locally.
hdr "wifi as each node actually sees it"
if [ "$DO_NODES" != true ]; then
	note "--no-nodes: skipped."
elif [ -z "$NODES" ]; then
	miss "no node list, so no node-side readings."
else
	printf '   %-10s %-22s %-9s %-7s %s\n' NODE SSID SIGNAL BAND 'RX/TX'
	printf '%s\n' "$NODES" | while read -r name ip; do
		out="$(timeout 15 ssh -n -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$name" \
			'export PATH=$PATH:/usr/sbin:/sbin; for n in /sys/class/net/*/wireless; do [ -e "$n" ] || continue; i=$(basename $(dirname $n)); iw dev $i link 2>/dev/null; done' 2>/dev/null)"
		if [ -z "$out" ]; then
			printf '   %-10s %s\n' "$name" "${DIM}no wireless interface, or unreachable${NC}"
			continue
		fi
		ssid="$(printf '%s' "$out" | awk '/SSID:/{print $2; exit}')"
		sig="$(printf '%s' "$out" | awk '/signal:/{print $2; exit}')"
		frq="$(printf '%s' "$out" | awk '/freq:/{print $2; exit}')"
		rx="$(printf '%s' "$out" | awk '/rx bitrate:/{print $3; exit}')"
		tx="$(printf '%s' "$out" | awk '/tx bitrate:/{print $3; exit}')"
		band="2.4GHz"
		case "$frq" in 5* | 6*) band="5GHz" ;; esac
		printf '   %-10s %-22s %-9s %-7s %s\n' "$name" "${ssid:--}" "${sig:--} dBm" "$band" "${rx:--}/${tx:--} Mb"
	done
	note "-30 excellent · -60 good · -70 workable · -80 marginal (dBm, higher is better)"
fi

# ── 6. the local RF picture, labelled with its own credibility ──────────────
hdr "local wifi scan (this host's radio)"
WIF="$(for n in /sys/class/net/*/wireless; do [ -e "$n" ] && basename "$(dirname "$n")" && break; done)"
if [ -z "$WIF" ]; then
	miss "this host has no wifi radio."
elif ! command -v nmcli >/dev/null 2>&1; then
	miss "no nmcli."
else
	# THE CALIBRATION CHECK. A radio with no saved connection has very likely
	# never had its antennas attached, and its numbers are not comparable to a
	# phone's or a node's. Saying so is the difference between data and noise.
	if ! nmcli -t -f TYPE connection show 2>/dev/null | grep -q '^802-11-wireless$'; then
		printf '%s   WARNING: %s has never been associated (no saved wifi connection).\n' "$YELLOW" "$WIF"
		printf '   Its antennas may not be attached. Treat every number below as UNCALIBRATED\n'
		printf '   and prefer the node-side readings above.%s\n' "$NC"
	fi
	nmcli device wifi rescan >/dev/null 2>&1
	sleep 3
	SCAN="$(nmcli -t -f SSID,BSSID,CHAN,FREQ,SIGNAL,SECURITY device wifi list 2>/dev/null | sed 's/\\:/%/g')"
	if [ -z "$SCAN" ]; then
		miss "the scan returned nothing (check 'nmcli radio')."
	else
		printf '%s\n' "$SCAN" | awk -F: '
			{ b=$2; gsub(/%/,":",b);
			  if (b == "") next;
			  s=($1==""?"<hidden>":$1);
			  band=($4+0>=5000)?"5GHz ":"2.4GHz";
			  # STRONGEST READING WINS, and this is not cosmetic. The nmcli list
			  # carries stale entries alongside fresh ones for the same BSSID:
			  # measured 2026-08-31, the gateway appeared at both 15% and 97% in
			  # a single listing. Reading the stale row produced a two-hour
			  # detour into "the antennas on this host must be disconnected",
			  # and two confident, wrong conclusions about 5GHz coverage here.
			  # A radio seen twice is one radio, and the live reading is the
			  # larger one.
			  if (!(b in sig) || $5+0 > sig[b]) {
			    sig[b]=$5+0;
			    row[b]=sprintf("   %-26s %-19s %-6s ch%-4s %3s%%  %s", substr(s,1,26), b, band, $3, $5, $6);
			  } }
			END { for (b in row) print row[b] }' | sort
		# An AP's radio MAC sits within a few of its wired MAC, so a BSSID
		# sharing octets 2-5 with a LAN device IS that device. This is what
		# identifies which box on the network is serving which SSID.
		echo
		printf '   %sradios belonging to a device on this LAN:%s\n' "$B" "$NC"
		# Built into a variable, NOT printed from inside the pipeline. The
		# `while` on the right of a `|` runs in a SUBSHELL, so a flag set in
		# there never reaches this scope: the first cut printed five matches and
		# then "none matched" directly underneath them.
		MATCHES="$(printf '%s\n' "$SCAN" |
			awk -F: '{b=$2; gsub(/%/,":",b); print tolower(b), ($1==""?"<hidden>":$1)}' | sort -u |
			while read -r bss ssid; do
				pre="$(printf '%s' "$bss" | cut -d: -f2-5)"
				hit="$(printf '%s\n' "$NEIGH" | grep -i -- "$pre" | head -1)"
				[ -n "$hit" ] && printf '     %-24s radio %s  <-->  LAN %s\n' "$ssid" "$bss" "$hit"
			done)"
		if [ -n "$MATCHES" ]; then printf '%s\n' "$MATCHES"; else
			note "none matched — the APs here use MACs unrelated to their wired side."
		fi
	fi
fi

hdr "reading this"
cat <<'EOF'
   Two BSSIDs under one SSID means a second AP or mesh node already serves that
   network. Find it in the sweep above before buying another one.

   For a node that has no radio, whatever goes in front of it must BRIDGE, not
   NAT. The test is that the node gets an address on THIS subnet and that this
   host can open a connection TO it. Internet access from the node proves
   nothing — those are different properties and only the first one matters.
EOF
