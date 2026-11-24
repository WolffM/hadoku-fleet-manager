#!/usr/bin/env bash
# io-cost.sh: make io.weight real on the root filesystem's disk(s)
# (hadoku-fleet-manager#158).
#
# cgroup v2's io.weight does nothing on a disk whose scheduler is `none` or
# mq-deadline unless io.cost is enabled for it. This turns io.cost on with the
# kernel's automatic QoS and cost model (`ctrl=auto`), for every whole disk
# under `/`, found from the root mount down (through dm-crypt and LVM), never
# by a hard-coded device number.
#
#   io-cost.sh [plan]   DRY RUN, needs no root: the disks, their scheduler,
#                       today's io.cost.qos/model line, and what `on` writes
#   io-cost.sh status   one line per disk: on | off
#   io-cost.sh on       enable io.cost now (root; lost at reboot)
#   io-cost.sh off      disable it now (root)
#   io-cost.sh persist  enable the boot unit, so `on` survives a reboot (root)
#   io-cost.sh unpersist
#   io-cost.sh install  ONCE, as root via sudo: put this script at
#                       /usr/local/sbin/fleet-io-cost (root-owned), add the
#                       boot unit (disabled), and let the sudo-ing user run
#                       exactly `fleet-io-cost on|off|status|persist|unpersist`
#                       without a password. That is what lets the A/B harness
#                       (scripts/io-cost-ab.mjs) switch io.cost under real load
#                       and nothing else.
#
# Every verb takes no other argument, so the sudoers grant is the five fixed
# command lines and nothing wider.
set -euo pipefail

QOS=/sys/fs/cgroup/io.cost.qos
MODEL=/sys/fs/cgroup/io.cost.model
BIN=/usr/local/sbin/fleet-io-cost
UNIT=fleet-io-cost.service
UNIT_FILE=/etc/systemd/system/$UNIT
SUDOERS=/etc/sudoers.d/fleet-io-cost

die() { echo "io-cost: $*" >&2; exit 1; }

# "MAJ:MIN NAME" for every whole disk under the root filesystem.
root_disks() {
	local src
	src=$(findmnt -no SOURCE / | head -n1 | sed 's/\[.*//')
	[ -n "$src" ] || die "findmnt named no device for /"
	lsblk -snro MAJ:MIN,TYPE,NAME "$src" | awk '$2=="disk"{print $1" "$3}' | sort -u
}

need_iocost() { [ -e "$QOS" ] || die "this kernel has no io.cost ($QOS is absent)"; }
need_root() { [ "$(id -u)" = 0 ] || die "'$1' needs root"; }
qos_of() { awk -v d="$1" '$1==d' "$QOS"; }
is_on() { qos_of "$1" | grep -q 'enable=1'; }

disks=$(root_disks)
[ -n "$disks" ] || die "no whole disk found under the root filesystem"

verb=${1:-plan}
[ $# -le 1 ] || die "takes one verb and nothing else"
case "$verb" in
plan)
	need_iocost
	echo "DRY RUN: nothing is written."
	while read -r dev name; do
		sch=$(sed -n 's/.*\[\(.*\)\].*/\1/p' "/sys/block/$name/queue/scheduler")
		echo "disk $name ($dev): scheduler $sch"
		echo "  io.cost.qos   now: $(qos_of "$dev" || true)"
		echo "  io.cost.model now: $(awk -v d="$dev" '$1==d' "$MODEL" || true)"
		echo "  on would write:  $dev enable=1 ctrl=auto  > $QOS  (model left automatic)"
		echo "  off would write: $dev enable=0            > $QOS"
	done <<<"$disks"
	if [ -x "$BIN" ]; then echo "installed: $BIN"; else echo "not installed: $BIN"; fi
	if systemctl is-enabled --quiet "$UNIT" 2>/dev/null; then echo "boot unit: enabled"; else echo "boot unit: not enabled"; fi
	;;
status)
	need_iocost
	while read -r dev name; do
		if is_on "$dev"; then echo "$name $dev on"; else echo "$name $dev off"; fi
	done <<<"$disks"
	;;
on | off)
	need_root "$verb"; need_iocost
	want=1; [ "$verb" = off ] && want=0
	while read -r dev name; do
		if [ "$want" = 1 ]; then echo "$dev enable=1 ctrl=auto" >"$QOS"; else echo "$dev enable=0" >"$QOS"; fi
		# Read back: the kernel's file is the judge, not the write's exit code.
		if [ "$want" = 1 ] && ! is_on "$dev"; then die "$name ($dev): wrote enable=1, reads back: $(qos_of "$dev")"; fi
		if [ "$want" = 0 ] && is_on "$dev"; then die "$name ($dev): wrote enable=0, reads back: $(qos_of "$dev")"; fi
		echo "$name $dev $verb: $(qos_of "$dev")"
	done <<<"$disks"
	;;
persist)
	need_root "$verb"
	[ -f "$UNIT_FILE" ] || die "$UNIT is not installed; run 'install' first"
	systemctl enable "$UNIT" >/dev/null
	systemctl is-enabled "$UNIT"
	;;
unpersist)
	need_root "$verb"
	systemctl disable "$UNIT" >/dev/null 2>&1 || true
	systemctl is-enabled "$UNIT" 2>/dev/null || true
	;;
install)
	need_root "$verb"; need_iocost
	user=${SUDO_USER:-}
	[ -n "$user" ] && [ "$user" != root ] || die "run install through sudo, so it knows whose grant to write"
	install -o root -g root -m 0755 "$0" "$BIN"
	cat >"$UNIT_FILE" <<EOF
[Unit]
Description=io.cost on the root filesystem's disks, so io.weight is enforced
After=local-fs.target

[Service]
Type=oneshot
ExecStart=$BIN on
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
	systemctl daemon-reload
	tmp=$(mktemp)
	printf '%s ALL=(root) NOPASSWD: %s on, %s off, %s status, %s persist, %s unpersist\n' \
		"$user" "$BIN" "$BIN" "$BIN" "$BIN" "$BIN" >"$tmp"
	visudo -cqf "$tmp" || { rm -f "$tmp"; die "the sudoers line did not validate"; }
	install -o root -g root -m 0440 "$tmp" "$SUDOERS"
	rm -f "$tmp"
	echo "installed $BIN, $UNIT (not enabled) and $SUDOERS for $user"
	echo "io.cost is still OFF; the A/B harness turns it on and off, and 'persist' keeps it."
	;;
*) die "unknown verb '$verb' (plan | status | on | off | persist | unpersist | install)" ;;
esac
