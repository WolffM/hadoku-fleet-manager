#!/usr/bin/env bash
#
# Install hokon's user-manager CPU priority drop-ins. Run as the desktop user
# (no root):
#
#   deploy/systemd/user-priority/install.sh
#
# Desktop (session.slice) 1000 : apps 100 : CI (ci.slice) 25 : each agent tmux
# pane 20. See docs/tools/slice.md, "Desktop priority (hokon)".
#
# Also the memory side: ci.slice gets an oomd pressure kill, and app.slice
# claims the user manager's memory floor so none of it shields CI.
# --dry-run prints what would change and touches nothing.
#
# daemon-reload loads the drop-ins but does NOT rewrite the weights of cgroups
# that already exist, so the live units are set with --runtime as well.
# Idempotent.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.config/systemd/user"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

for f in session.slice.d/priority.conf ci.slice.d/priority.conf ci.slice.d/oomd.conf \
	tmux-spawn-.scope.d/priority.conf app.slice.d/protect.conf; do
	if [ "$DRY" = 1 ]; then
		if cmp -s "$SRC/$f" "$DEST/$f"; then echo "same   $DEST/$f"; else echo "would  $DEST/$f"; fi
		continue
	fi
	install -D -m 0644 "$SRC/$f" "$DEST/$f"
	echo "installed $DEST/$f"
done
if [ "$DRY" = 1 ]; then
	systemctl --user show ci.slice app.slice -p Id,ManagedOOMMemoryPressure,ManagedOOMMemoryPressureLimit,MemoryMin,MemoryLow
	exit 0
fi
systemctl --user daemon-reload

systemctl --user set-property --runtime session.slice CPUWeight=1000 IOWeight=1000
systemctl --user set-property --runtime ci.slice CPUWeight=25 IOWeight=25
systemctl --user set-property --runtime app.slice MemoryMin=8G MemoryLow=8G
for u in $(systemctl --user list-units --plain --no-legend 'tmux-spawn-*.scope' | awk '{print $1}'); do
	systemctl --user set-property --runtime "$u" CPUWeight=20 IOWeight=20
done

B="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service"
echo "session.slice cpu.weight=$(cat "$B/session.slice/cpu.weight")"
echo "ci.slice      cpu.weight=$(cat "$B/ci.slice/cpu.weight" 2>/dev/null || echo 'n/a (inactive)')"
echo "app.slice     memory.min=$(cat "$B/app.slice/memory.min") memory.low=$(cat "$B/app.slice/memory.low")"
oomctl | grep -A2 "user@$(id -u).service/ci.slice$" || echo "oomd: ci.slice not monitored yet (it registers when the slice is active)"
