#!/bin/sh
# storage-probe.sh — every disk on this node, as the kernel and the drive see it.
#
# THE ONE DEVICE LOOP. benchmark-node.sh used to walk /sys/block itself; that
# loop moved here so the storage bootcamp's inventory and the benchmark record
# read the same facts gathered the same way. benchmark-node.sh CALLS
# `storage_probe` — `fleet benchmark` sends this file ahead of it on stdin, and
# a by-hand `sh benchmark-node.sh` sources it from beside itself. Nothing else
# may walk /sys/block for disks.
#
# READ-ONLY. It never mounts, formats, partitions or writes to a disk: it reads
# sysfs, lsblk (the udev database) and `smartctl -i -H -A`, which only queries.
#
# OUTPUT is line-oriented and parsed by scripts/lib/storage-inventory.mjs
# (`parseStorage`), which owns the record shape:
#   disk <dev>                 one per device, in /sys/block order
#   disk.<dev>.<key> <value>   sysfs/lsblk facts (`unknown <reason>` when not)
#   P <dev> NAME="…" TYPE="…"  lsblk -P rows for the device and its partitions
#   S <dev> <line>             smartctl's output, verbatim, for parseSmart
#
# SMART HAS THREE DIFFERENT ABSENCES and they must not read alike: the tool is
# not installed (`storage.smartTool absent`), it is installed but this run is
# not root (`storage.root no`), and the drive itself refused (a USB bridge, or
# SMART disabled — smartctl's own words, kept in the S lines). The tool lives
# in /usr/sbin, which a non-root PATH does not carry: `command -v smartctl`
# alone reads as "absent" on a claw that has it.
#
# USAGE
#   sudo sh storage-probe.sh             # print the inventory
#   . storage-probe.sh; storage_probe    # what benchmark-node.sh does

storage_probe() {
	_sp_unk() { printf '%s unknown %s\n' "$1" "$2"; }
	_sp_tool=""
	if [ -n "${STORAGE_SMARTCTL:-}" ]; then
		# Tests only: run this against a real node with the tool hidden, which
		# is how the "no SMART tool" fixture was captured. Nothing on a node sets it.
		[ -x "$STORAGE_SMARTCTL" ] && _sp_tool=$STORAGE_SMARTCTL
	elif command -v smartctl >/dev/null 2>&1; then
		_sp_tool=$(command -v smartctl)
	elif [ -x /usr/sbin/smartctl ]; then
		_sp_tool=/usr/sbin/smartctl
	fi
	echo "STORAGE-BEGIN v1"
	printf 'storage.root %s\n' "$([ "$(id -u)" = 0 ] && echo yes || echo no)"
	printf 'storage.smartTool %s\n' "${_sp_tool:-absent}"
	if ! command -v lsblk >/dev/null 2>&1; then
		_sp_unk storage.lsblk "lsblk absent: no filesystem, UUID, serial or mount facts"
	fi
	for _sp_b in /sys/block/*; do
		_sp_d=$(basename "$_sp_b")
		case $_sp_d in loop* | ram* | sr* | dm-* | zram* | md*) continue ;; esac
		printf 'disk %s\n' "$_sp_d"
		printf 'disk.%s.sizeBytes %s\n' "$_sp_d" "$(($(cat "$_sp_b/size" 2>/dev/null || echo 0) * 512))"
		printf 'disk.%s.rotational %s\n' "$_sp_d" "$(cat "$_sp_b/queue/rotational" 2>/dev/null)"
		printf 'disk.%s.removable %s\n' "$_sp_d" "$(cat "$_sp_b/removable" 2>/dev/null)"
		printf 'disk.%s.model %s\n' "$_sp_d" "$(sed 's/ *$//' "$_sp_b/device/model" 2>/dev/null)"
		printf 'disk.%s.scheduler %s\n' "$_sp_d" "$(sed 's/.*\[\(.*\)\].*/\1/' "$_sp_b/queue/scheduler" 2>/dev/null)"
		# The kernel's zone model: `none`, or `host-aware`/`host-managed` for a
		# drive that SAYS it is shingled. A drive-managed SMR disk says `none`,
		# which is why the SMR judge never reads `none` as CMR (qualify-disk-smr.mjs).
		printf 'disk.%s.zoned %s\n' "$_sp_d" "$(cat "$_sp_b/queue/zoned" 2>/dev/null)"
		# BUS TYPE COMES FROM THE DEVICE, NOT FROM smartctl BEING AVAILABLE.
		# kind used to be chosen by whether smartctl's OUTPUT mentioned "NVMe
		# Log", so on a box where smartctl cannot run every drive fell through
		# to `ata` — hokon's four NVMe devices were all recorded as ata.
		case "$_sp_d" in
		nvme*) printf 'disk.%s.kind nvme\n' "$_sp_d" ;;
		*) printf 'disk.%s.kind ata\n' "$_sp_d" ;;
		esac
		if command -v lsblk >/dev/null 2>&1; then
			_sp_mp=$(lsblk -nro MOUNTPOINT "/dev/$_sp_d" 2>/dev/null | grep -v '^$' | tr '\n' ',' | sed 's/,$//')
			printf 'disk.%s.mountpoints %s\n' "$_sp_d" "${_sp_mp:-none}"
			# lsblk's MODEL is the whole name; sysfs's (above, kept for the
			# benchmark record) is the 16-byte ATA inquiry string.
			lsblk -P -b -o NAME,TYPE,SIZE,MODEL,SERIAL,TRAN,FSTYPE,UUID,PTTYPE,LABEL,MOUNTPOINT "/dev/$_sp_d" 2>/dev/null |
				sed "s/^/P $_sp_d /"
		fi
		if [ -n "$_sp_tool" ]; then
			"$_sp_tool" -i -H -A "/dev/$_sp_d" 2>&1 | sed "s/^/S $_sp_d /"
		fi
	done
	echo "STORAGE-END"
}

case "${0##*/}" in
storage-probe.sh) storage_probe ;;
esac
