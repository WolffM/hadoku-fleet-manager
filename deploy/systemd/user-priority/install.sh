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
# Also the disk side: app.slice (every agent pane) gets a hard io.max so it can
# never starve pm2-hadoku.service (app.slice.d/io-cap.conf).
# Also dev-usage.timer: one sample a minute of what each repo's agent sessions
# and CI jobs use, the shadow week for per-repo dev slices (docs/tools/slice.md,
# "Dev slices"). It records; it moves and caps nothing.
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
	tmux-spawn-.scope.d/priority.conf app.slice.d/protect.conf app.slice.d/io-cap.conf \
	dev-usage.service dev-usage.timer; do
	if [ "$DRY" = 1 ]; then
		if cmp -s "$SRC/$f" "$DEST/$f"; then echo "same   $DEST/$f"; else echo "would  $DEST/$f"; fi
		continue
	fi
	install -D -m 0644 "$SRC/$f" "$DEST/$f"
	echo "installed $DEST/$f"
done
if [ "$DRY" = 1 ]; then
	systemctl --user show ci.slice app.slice -p Id,ManagedOOMMemoryPressure,ManagedOOMMemoryPressureLimit,MemoryMin,MemoryLow,IOReadBandwidthMax,IOWriteBandwidthMax
	exit 0
fi
systemctl --user daemon-reload
systemctl --user enable --now dev-usage.timer

systemctl --user set-property --runtime session.slice CPUWeight=1000 IOWeight=1000
systemctl --user set-property --runtime ci.slice CPUWeight=25 IOWeight=25
systemctl --user set-property --runtime app.slice MemoryMin=8G MemoryLow=8G \
	"IOWriteBandwidthMax=/dev/mapper/hokon--vg-root 120M" "IOReadBandwidthMax=/dev/mapper/hokon--vg-root 250M"
for u in $(systemctl --user list-units --plain --no-legend 'tmux-spawn-*.scope' | awk '{print $1}'); do
	systemctl --user set-property --runtime "$u" CPUWeight=20 IOWeight=20
done

B="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service"
echo "session.slice cpu.weight=$(cat "$B/session.slice/cpu.weight")"
echo "ci.slice      cpu.weight=$(cat "$B/ci.slice/cpu.weight" 2>/dev/null || echo 'n/a (inactive)')"
echo "app.slice     memory.min=$(cat "$B/app.slice/memory.min") memory.low=$(cat "$B/app.slice/memory.low") io.max=$(cat "$B/app.slice/io.max")"
echo "dev-usage.timer $(systemctl --user is-active dev-usage.timer)"
oomctl | grep -A2 "user@$(id -u).service/ci.slice$" || echo "oomd: ci.slice not monitored yet (it registers when the slice is active)"
