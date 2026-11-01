# usb-prep-site.sh — the site-facts resolver for scripts/node-usb-prep.sh:
# the LAN/wifi lookups (resolve_site_facts, netaddr) and the write of
# bootstrap/site.env (write_site_env). Sourced by node-usb-prep.sh; not
# standalone.

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
