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
#   io-cost.sh slices-on   weigh the top-level slices (root; lost at reboot):
#                       system.slice IOWeight=1000, user.slice IOWeight=100
#   io-cost.sh slices-off  put both back to systemd's default (root)
#   io-cost.sh persist  keep both, now and across a reboot (root): enable the
#                       boot unit for io.cost, write the slice weights as
#                       drop-ins, and apply both now
#   io-cost.sh unpersist   undo persist: disable the boot unit, remove the
#                       drop-ins, and turn both off now
#   io-cost.sh install  ONCE, as root via sudo: put this script at
#                       /usr/local/sbin/fleet-io-cost (root-owned), add the
#                       boot unit (disabled), and let the sudo-ing user run
#                       exactly `fleet-io-cost on|off|status|slices-on|
#                       slices-off|persist|unpersist` without a password. That
#                       is what lets the A/B harness (scripts/io-cost-ab.mjs)
#                       switch both under real load, and nothing else.
#                       Re-running it rewrites the grant.
#
# Why the slices: io.weight is hierarchical. With io.cost on, a weight only
# competes against its siblings, so production's 1000 inside system.slice still
# gets at most half the disk while system.slice and user.slice both weigh 100
# and the agent sessions (in user.slice) are busy (#158, A/B of 2026-11-24).
#
# Every verb takes no other argument, so the sudoers grant is seven fixed
# command lines and nothing wider. Every value is read back from cgroupfs, the
# kernel's own file, not from systemd's record of what it was asked.
set -euo pipefail

QOS=/sys/fs/cgroup/io.cost.qos
MODEL=/sys/fs/cgroup/io.cost.model
BIN=/usr/local/sbin/fleet-io-cost
UNIT=fleet-io-cost.service
UNIT_FILE=/etc/systemd/system/$UNIT
SUDOERS=/etc/sudoers.d/fleet-io-cost

# The top-level slice weights slices-on sets: "slice weight" per line.
SLICE_WEIGHTS="system.slice 1000
user.slice 100"
DEFAULT_WEIGHT=100
DROPIN=60-fleet-io-weight.conf

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
# A slice's io.weight as the kernel holds it: the number after "default".
cg_weight() { awk '$1=="default"{print $2}' "/sys/fs/cgroup/$1/io.weight"; }
# on when every slice reads its target, off when every slice reads the default.
slices_state() {
	local all_on=1 all_off=1 slice want got
	while read -r slice want; do
		got=$(cg_weight "$slice")
		[ "$got" = "$want" ] || all_on=0
		[ "$got" = "$DEFAULT_WEIGHT" ] || all_off=0
	done <<<"$SLICE_WEIGHTS"
	if [ $all_on = 1 ]; then echo on; elif [ $all_off = 1 ]; then echo off; else echo mixed; fi
}
slices_line() {
	local slice want out=""
	while read -r slice want; do out="$out $slice=$(cg_weight "$slice")"; done <<<"$SLICE_WEIGHTS"
	echo "slices$out ($(slices_state))"
}
# Set each slice now, and read it back. $1 = on | off.
slices_apply() {
	local slice want
	while read -r slice want; do
		if [ "$1" = on ]; then
			systemctl set-property --runtime "$slice" "IOWeight=$want"
		else
			# An empty assignment resets the property; the file it leaves says only
			# that, so it goes too.
			systemctl set-property --runtime "$slice" IOWeight=
			rm -f "/run/systemd/system.control/$slice.d/50-IOWeight.conf"
			want=$DEFAULT_WEIGHT
		fi
		[ "$(cg_weight "$slice")" = "$want" ] ||
			die "$slice: set IOWeight=$want, cgroupfs reads $(cg_weight "$slice")"
	done <<<"$SLICE_WEIGHTS"
	slices_line
}

# io.cost on every root disk now, read back from the kernel. $1 = on | off.
iocost_apply() {
	local dev name
	while read -r dev name; do
		if [ "$1" = on ]; then echo "$dev enable=1 ctrl=auto" >"$QOS"; else echo "$dev enable=0" >"$QOS"; fi
		# Read back: the kernel's file is the judge, not the write's exit code.
		if [ "$1" = on ] && ! is_on "$dev"; then die "$name ($dev): wrote enable=1, reads back: $(qos_of "$dev")"; fi
		if [ "$1" = off ] && is_on "$dev"; then die "$name ($dev): wrote enable=0, reads back: $(qos_of "$dev")"; fi
		echo "$name $dev $1: $(qos_of "$dev")"
	done <<<"$disks"
}

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
	while read -r slice want; do
		echo "slice $slice: io.weight now $(cg_weight "$slice"); slices-on would set IOWeight=$want, slices-off the default $DEFAULT_WEIGHT"
	done <<<"$SLICE_WEIGHTS"
	if [ -x "$BIN" ]; then echo "installed: $BIN"; else echo "not installed: $BIN"; fi
	# The grant is read from sudo's own listing: the file is 0440, and
	# `sudo -l <cmd>` says yes to anything a password would allow.
	# sudo may wrap one entry across lines: rejoin before matching.
	grants=$(sudo -n -l 2>/dev/null | tr -s ' \t\n' ' ' | grep -o "NOPASSWD:[^(]*" || true)
	if grep -qE "$BIN slices-on(,| |$)" <<<"$grants"; then echo "grant: covers slices-on/slices-off"
	elif grep -qE "$BIN on(,| |$)" <<<"$grants"; then echo "grant: io.cost verbs only; re-run 'sudo bash io-cost.sh install' for slices-on/slices-off"
	else echo "grant: none for this user"; fi
	if systemctl is-enabled --quiet "$UNIT" 2>/dev/null; then echo "boot unit: enabled"; else echo "boot unit: not enabled"; fi
	;;
status)
	need_iocost
	while read -r dev name; do
		if is_on "$dev"; then echo "$name $dev on"; else echo "$name $dev off"; fi
	done <<<"$disks"
	slices_line
	;;
slices-on | slices-off)
	need_root "$verb"
	slices_apply "${verb#slices-}"
	;;
on | off)
	need_root "$verb"; need_iocost
	iocost_apply "$verb"
	;;
persist)
	need_root "$verb"
	[ -f "$UNIT_FILE" ] || die "$UNIT is not installed; run 'install' first"
	systemctl enable "$UNIT" >/dev/null
	echo "boot unit: $(systemctl is-enabled "$UNIT")"
	while read -r slice want; do
		mkdir -p "/etc/systemd/system/$slice.d"
		printf '# fleet-io-cost persist (#158)\n[Slice]\nIOWeight=%s\n' "$want" \
			>"/etc/systemd/system/$slice.d/$DROPIN"
		echo "wrote /etc/systemd/system/$slice.d/$DROPIN"
	done <<<"$SLICE_WEIGHTS"
	systemctl daemon-reload
	# daemon-reload records a drop-in but does not write it to a running slice's
	# cgroup (measured on a claw), so apply both now as well.
	need_iocost
	iocost_apply on
	slices_apply on
	;;
unpersist)
	need_root "$verb"
	systemctl disable "$UNIT" >/dev/null 2>&1 || true
	echo "boot unit: $(systemctl is-enabled "$UNIT" 2>/dev/null || true)"
	while read -r slice want; do
		rm -f "/etc/systemd/system/$slice.d/$DROPIN"
		rmdir "/etc/systemd/system/$slice.d" 2>/dev/null || true
	done <<<"$SLICE_WEIGHTS"
	systemctl daemon-reload
	need_iocost
	iocost_apply off
	slices_apply off
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
	verbs="on off status slices-on slices-off persist unpersist"
	line="$user ALL=(root) NOPASSWD:"
	sep=" "
	for v in $verbs; do line="$line$sep$BIN $v"; sep=", "; done
	echo "$line" >"$tmp"
	visudo -cqf "$tmp" || { rm -f "$tmp"; die "the sudoers line did not validate"; }
	install -o root -g root -m 0440 "$tmp" "$SUDOERS"
	rm -f "$tmp"
	echo "installed $BIN, $UNIT (not enabled) and $SUDOERS for $user"
	echo "grant: $verbs"
	echo "io.cost and the slice weights are unchanged; the A/B harness switches them, and 'persist' keeps them."
	;;
*) die "unknown verb '$verb' (plan | status | on | off | slices-on | slices-off | persist | unpersist | install)" ;;
esac
