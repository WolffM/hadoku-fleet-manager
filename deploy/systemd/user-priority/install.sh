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
# daemon-reload loads the drop-ins but does NOT rewrite the weights of cgroups
# that already exist, so the live units are set with --runtime as well.
# Idempotent.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.config/systemd/user"

for d in session.slice.d ci.slice.d tmux-spawn-.scope.d; do
	install -D -m 0644 "$SRC/$d/priority.conf" "$DEST/$d/priority.conf"
	echo "installed $DEST/$d/priority.conf"
done
systemctl --user daemon-reload

systemctl --user set-property --runtime session.slice CPUWeight=1000 IOWeight=1000
systemctl --user set-property --runtime ci.slice CPUWeight=25 IOWeight=25
for u in $(systemctl --user list-units --plain --no-legend 'tmux-spawn-*.scope' | awk '{print $1}'); do
	systemctl --user set-property --runtime "$u" CPUWeight=20 IOWeight=20
done

B="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service"
echo "session.slice cpu.weight=$(cat "$B/session.slice/cpu.weight")"
echo "ci.slice      cpu.weight=$(cat "$B/ci.slice/cpu.weight" 2>/dev/null || echo 'n/a (inactive)')"
