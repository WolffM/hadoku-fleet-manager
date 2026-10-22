#!/bin/sh
# Keep one pane's watcher alive, and never let its death go quiet.
#
# herdr drops a pane's agent the moment the process holding it exits, so a
# watcher that crashed would make its node VANISH from the sidebar rather than
# turn red. This loop holds the pane between runs and reports the exit as
# blocked. Ctrl+C in the pane stops both, which is the one quiet exit there is.
target="$1"
here=$(cd "$(dirname "$0")" && pwd)
herdr="${HERDR_BIN_PATH:-herdr}"
agent="${target#node:}"
#
# --seq is epoch MILLISECONDS, the same clock watch.mjs uses. herdr ignores a
# report whose seq is older than the last one from this source, so a report
# without one is dropped and the dead watcher's last state stays on screen
# (found live on 0.9.5: SIGKILL left the pane `idle`).
#
# Exit 75 (RELOAD_EXIT) is the watcher saying the code it loaded changed on
# disk: restart at once, and do not report it as a failure.
while :; do
	node "$here/watch.mjs" "$target"
	rc=$?
	[ "$rc" -eq 75 ] && continue
	why="watcher exited $rc; restarting in 10s"
	"$herdr" pane report-agent "$HERDR_PANE_ID" --source hadoku.fleet --agent "$agent" \
		--state blocked --message "$why" --seq "$(date +%s%3N)"
	"$herdr" pane report-metadata "$HERDR_PANE_ID" --source hadoku.fleet:display \
		--token "summary=$why"
	sleep 10
done
