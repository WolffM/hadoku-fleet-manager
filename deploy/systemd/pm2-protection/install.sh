#!/usr/bin/env bash
#
# hokon: give PM2 a memory floor the kernel honours. Run as root:
#
#   sudo deploy/systemd/pm2-protection/install.sh --dry-run   # prints, touches nothing
#   sudo deploy/systemd/pm2-protection/install.sh
#
# Why each file exists is in its own header. The user-manager half (ci.slice
# oomd kill, app.slice claim) is deploy/systemd/user-priority/install.sh and
# needs no root. Idempotent.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
ETC=/etc/systemd/system
CTL=/etc/systemd/system.control
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
[ "$DRY" = 1 ] || [ "$(id -u)" -eq 0 ] || { echo "run with sudo (or --dry-run)" >&2; exit 1; }

cg() { # unit -> "min=… low=…" read from the kernel, not from systemd
	local p
	p=$(systemctl show -p ControlGroup --value "$1")
	[ -n "$p" ] || { echo "no cgroup"; return; }
	echo "min=$(numfmt --to=iec <"/sys/fs/cgroup$p/memory.min") low=$(numfmt --to=iec <"/sys/fs/cgroup$p/memory.low")"
}

# unit | target drop-in | section | source | runtime properties
PLAN=(
	"system.slice|$ETC/system.slice.d/50-protect-pm2.conf|Slice|system.slice-protect.conf|MemoryMin=13G MemoryLow=17G"
	"pm2-hadoku.service|$ETC/pm2-hadoku.service.d/65-memory-floor.conf|Service|pm2-hadoku-floor.conf|MemoryMin=12G MemoryLow=16G"
	"user.slice|$ETC/user.slice.d/50-user-floor.conf|Slice|user-floor.conf|"
	"user-1000.slice|$ETC/user-1000.slice.d/50-user-floor.conf|Slice|user-floor.conf|"
	"user@1000.service|$ETC/user@1000.service.d/50-user-floor.conf|Service|user-floor.conf|"
)

render() { # section source -> drop-in body
	if grep -q '^\[' "$SRC/$2"; then cat "$SRC/$2"; else
		sed -n '/^#/p' "$SRC/$2"; echo "[$1]"; grep -v '^#' "$SRC/$2" | grep .; fi
}

for row in "${PLAN[@]}"; do
	IFS='|' read -r unit dest section src props <<<"$row"
	echo "== $unit   now: $(cg "$unit")"
	if render "$section" "$src" | cmp -s - "$dest" 2>/dev/null; then
		echo "   same   $dest"
	elif [ "$DRY" = 1 ]; then
		echo "   would  write $dest:"; render "$section" "$src" | grep -v '^#' | sed 's/^/            /'
	else
		install -d "$(dirname "$dest")"; render "$section" "$src" >"$dest"; echo "   wrote  $dest"
	fi
	# `systemctl set-property` (without --runtime) writes these 50- files. The
	# drop-in above sorts after them and wins, so a leftover one is dead config
	# that reads as live, and a later set-property would silently lose to the
	# drop-in at the next reload. The drop-in is the one place the value lives.
	for f in "$CTL/$unit.d/50-MemoryMin.conf" "$CTL/$unit.d/50-MemoryLow.conf"; do
		[ -f "$f" ] || continue
		if [ "$DRY" = 1 ]; then echo "   would  remove $f ($(grep -h '^Memory' "$f"), superseded by $dest)"; else rm "$f"; echo "   removed $f"; fi
	done
done

[ "$DRY" = 1 ] && { echo; echo "dry run: nothing changed"; exit 0; }

systemctl daemon-reload
# daemon-reload does not rewrite a running cgroup's limits; set them live too.
for row in "${PLAN[@]}"; do
	IFS='|' read -r unit _ _ _ props <<<"$row"
	[ -n "$props" ] && systemctl set-property --runtime "$unit" $props
done
echo
for row in "${PLAN[@]}"; do IFS='|' read -r unit _ <<<"$row"; echo "$unit  $(cg "$unit")"; done
