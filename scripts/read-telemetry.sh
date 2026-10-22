#!/usr/bin/env bash
# read-telemetry — read what a failed install recorded onto the stick.
#
#   sudo bash scripts/read-telemetry.sh            # newest run
#   sudo bash scripts/read-telemetry.sh --all      # every run on the stick
#
# The installer's own logs live on a ramdisk that dies with it, so a stick that
# comes back from a failure is normally silent. `fleet onboard` writes the
# machine's account of itself to CLAWKIT every ten seconds during the install;
# this reads it back.
#
# It answers the question the failure screen cannot: WHICH interface was chosen,
# whether the driver bound, whether firmware was missing, and whether anything
# ever got an address.
set -uo pipefail
B=$'\033[1m'; DIM=$'\033[2m'; Y=$'\033[33m'; R=$'\033[31m'; G=$'\033[32m'; N=$'\033[0m'
ALL=false
[ "${1:-}" = "--all" ] && ALL=true

[ "$(id -u)" = 0 ] || { echo "run with sudo (it mounts the stick)"; exit 1; }
P="$(blkid -L CLAWKIT 2>/dev/null)" || { echo "no CLAWKIT partition — is the stick in?"; exit 1; }
M="$(mktemp -d)"; trap 'umount "$M" 2>/dev/null; rmdir "$M" 2>/dev/null' EXIT
mount -o ro "$P" "$M" || exit 1

T="$M/telemetry"
if [ ! -d "$T" ] || [ -z "$(ls -A "$T" 2>/dev/null)" ]; then
	echo "no telemetry on this stick."
	echo "  Either the install never reached early_command, or the stick predates it."
	echo "  Rebuild with: bash scripts/onboarding.sh"
	exit 1
fi

runs=$(ls -1 "$T" | sort)
[ "$ALL" = true ] || runs=$(printf '%s\n' "$runs" | tail -1)

for r in $runs; do
	D="$T/$r"
	printf '\n%s━━ install run %s %s\n' "$B" "$r" "$N"

	# The one line that decides everything else.
	if grep -q 'fleet' "$D/syslog.txt" 2>/dev/null; then
		printf '\n%sinterface decision%s\n' "$B" "$N"
		grep 'fleet' "$D/syslog.txt" | sed 's/^/  /'
	else
		printf '\n  %sno fleet decision logged — early_command may not have run%s\n' "$Y" "$N"
	fi

	H="$D/hardware.txt"
	if [ -f "$H" ]; then
		g() { grep -m1 "^$1=" "$H" 2>/dev/null | cut -d= -f2-; }
		printf '\n%swhat this box is%s\n' "$B" "$N"
		printf '  %-14s %s %s\n' "vendor" "$(g vendor)" "$(g product)"
		printf '  %-14s %s (%s threads)\n' "cpu" "$(g cpu_model)" "$(g cpu_threads)"
		printf '  %-14s %s GB\n' "memory" "$(( $(g mem_total_kb) / 1000000 ))"

		# DMI chassis type is the machine's own answer to the question the
		# profile otherwise has to be told: 3 desktop, 8/9/10/14 portable.
		# Cross-checked against a battery and a lid switch, because a DMI string
		# is a manufacturer's claim and those two are physical.
		CT="$(g chassis_type)"; BAT="$(g battery)"; LID="$(g lid_switch)"
		case "$CT" in
		3 | 4 | 5 | 6 | 7 | 15 | 16 | 17 | 23) SHAPE=desktop ;;
		8 | 9 | 10 | 11 | 12 | 14 | 30 | 31 | 32) SHAPE=laptop ;;
		*) SHAPE=unknown ;;
		esac
		[ "${BAT:-0}" != 0 ] && SHAPE=laptop
		[ -n "$LID" ] && SHAPE=laptop
		printf '  %-14s %s  %s(dmi chassis=%s battery=%s lid=%s)%s\n' \
			"shape" "$SHAPE" "$DIM" "${CT:-?}" "${BAT:-0}" "${LID:-none}" "$N"
		case "$SHAPE" in
		desktop) printf '  %-14s %sdesktop-debian-trixie%s\n' "profile" "$G" "$N" ;;
		laptop) printf '  %-14s %slaptop-debian-trixie%s\n' "profile" "$G" "$N" ;;
		*) printf '  %-14s %scannot tell - inspect before choosing%s\n' "profile" "$Y" "$N" ;;
		esac

		printf '\n%snetwork hardware the box actually has%s\n' "$B" "$N"
		grep '^net\.' "$H" | sed 's/^net\.//' | awk -F. '{print $1}' | sort -u | while read -r i; do
			case "$i" in lo | docker* | veth* | br-* | tailscale* | nordlynx*) continue ;; esac
			w=$(grep -m1 "^net\.$i\.wireless=" "$H" | cut -d= -f2)
			d=$(grep -m1 "^net\.$i\.driver=" "$H" | cut -d= -f2)
			c=$(grep -m1 "^net\.$i\.carrier=" "$H" | cut -d= -f2)
			p=$(grep -m1 "^net\.$i\.pci=" "$H" | cut -d= -f2)
			k=$([ "$w" = 1 ] && echo wireless || echo wired)
			if [ -z "$d" ]; then
				printf '  %s%-12s %-9s NO DRIVER BOUND%s  %s%s%s\n' "$R" "$i" "$k" "$N" "$DIM" "$p" "$N"
			else
				printf '  %-12s %-9s driver=%-10s carrier=%s  %s%s%s\n' "$i" "$k" "$d" "${c:-?}" "$DIM" "$p" "$N"
			fi
		done

		printf '\n%sdisks%s\n' "$B" "$N"
		grep '^disk\.' "$H" | awk -F. '{print $2}' | sort -u | while read -r d; do
			case "$d" in dm-* | zram* | md*) continue ;; esac
			b=$(grep -m1 "^disk\.$d\.bytes=" "$H" | cut -d= -f2)
			r=$(grep -m1 "^disk\.$d\.rotational=" "$H" | cut -d= -f2)
			m=$(grep -m1 "^disk\.$d\.model=" "$H" | cut -d= -f2)
			printf '  %-10s %6s GB  %-8s %s\n' "$d" "$(( ${b:-0} / 1000000000 ))" \
				"$([ "$r" = 1 ] && echo spinning || echo ssd)" "$m"
		done
	fi

	printf '\n%snetwork at last snapshot%s\n' "$B" "$N"
	sed -n '/-- links/,/-- carrier/p' "$D/network.txt" 2>/dev/null | sed 's/^/  /'
	printf '\n%scarriers%s\n' "$B" "$N"
	sed -n '/-- carrier/,$p' "$D/network.txt" 2>/dev/null | grep -v '^-- ' | sed 's/^/  /'

	printf '\n%sfirmware the kernel asked for%s\n' "$B" "$N"
	if grep -iqE 'firmware' "$D/dmesg.txt" 2>/dev/null; then
		grep -iE 'firmware' "$D/dmesg.txt" | tail -20 | sed 's/^/  /'
	else
		printf '  %snone — no driver reported a missing firmware file%s\n' "$DIM" "$N"
	fi

	printf '\n%snetwork hardware%s\n' "$B" "$N"
	grep -iE 'ethernet|network|wireless' "$D/lspci.txt" 2>/dev/null | sed 's/^/  /' \
		|| printf '  %slspci not available in the installer%s\n' "$DIM" "$N"

	printf '\n%slast 25 syslog lines%s\n' "$B" "$N"
	tail -25 "$D/syslog.txt" 2>/dev/null | sed 's/^/  /'
done

printf '\n%sfull files:%s %s/telemetry/<run>/{network,dmesg,syslog,lspci,firmware-present}.txt\n' \
	"$DIM" "$N" "$P"
printf '%s(mount it read-only: sudo mount -o ro %s /mnt)%s\n' "$DIM" "$P" "$N"
