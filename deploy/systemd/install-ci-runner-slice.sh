#!/usr/bin/env bash
#
# Migrate the two GitHub Actions runners out of PM2 into systemd units under
# ci-runner.slice. Run as root:
#
#   sudo deploy/systemd/install-ci-runner-slice.sh
#
# Background: as PM2 apps, CI jobs executed inside
# /system.slice/pm2-hadoku.service alongside mgmt-api, the tunnel and the other
# production services, in a cgroup with no memory limit. On 2026-08-04 ComfyUI (under
# the `conjure` app) grew to 50 GB in that cgroup and took the host down for
# ~11 minutes. CI was not the culprit, but it shared the same unbounded
# budget. See ci-runner.slice for the full story and the sizing rationale.
#
# ORDERING IS LOAD-BEARING. A runner registration permits exactly one active
# session, so the PM2 copy must be gone before the systemd copy starts, or the
# second one fails with "already in use" and you end up with neither working.
# The sequence is: install units (inert) -> remove from PM2 -> start units.
#
# Idempotent: safe to re-run. Rollback instructions at the bottom.
#
# set -u, no set -e: a failed step must still report rather than exit silently
# halfway through a migration.
set -u

# Resolved from THIS script, not from a hardcoded checkout. These units moved
# to @wolffm/fleet-manager on 2026-08-30 and are installed from wherever the
# package is checked out or unpacked — a pinned hadoku_site path would have
# silently installed a stale copy from a repo that no longer owns them.
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/etc/systemd/system
RUNNER_USER=hadoku
PM2_APPS=(github-runner github-runner-tenhands)
UNITS=(github-runner.service github-runner-tenhands.service)

if [ "$(id -u)" -ne 0 ]; then
	echo "Must run as root: sudo $0" >&2
	exit 1
fi

as_hadoku() {
	sudo -u "$RUNNER_USER" PM2_HOME=/home/"$RUNNER_USER"/.pm2 "$@"
}

echo "=== 1. pre-flight: is a CI job in flight? ==="
# Stopping a runner mid-job cancels that job. taskauto jobs hold a board lease
# that then has to expire, so it is worth waiting a minute rather than forcing.
busy=0
# hokon's two HAND-WRITTEN runner instances. They predate the reconciler and
# are the last of the pre-2026-08 divergence: the claws use svc.sh-generated
# units, these do not. Listed explicitly because the package no longer has a
# hadoku_site path to derive them from — and because the right end state is the
# reconciler absorbing them, at which point this loop goes away entirely.
for dir in /home/hadoku/repos/hadoku_site/actions-runner /home/hadoku/actions-runner-tenhands; do
	if pgrep -f "$dir/.*Runner.Worker" >/dev/null 2>&1; then
		echo "  BUSY: a job is running under $dir"
		busy=1
	else
		echo "  idle: $dir"
	fi
done
if [ "$busy" -eq 1 ]; then
	echo
	echo "  A job is mid-flight. Re-run when idle, or accept that it will be" >&2
	echo "  cancelled and re-dispatched. Aborting." >&2
	exit 1
fi

echo
echo "=== 2. installing unit files ==="
for f in ci-runner.slice "${UNITS[@]}"; do
	if install -m 0644 -o root -g root "$SRC/$f" "$DEST/$f"; then
		echo "  installed $DEST/$f"
	else
		echo "  FAILED to install $f" >&2
		exit 1
	fi
done
systemctl daemon-reload && echo "  daemon-reload done"

echo
echo "=== 3. removing the runners from PM2 ==="
# `pm2 delete <name>` then `pm2 save` so the removal survives `pm2 resurrect`.
# Note the single names: `pm2 delete all` is refused by mgmt-api's guard and
# would be wrong here anyway.
for app in "${PM2_APPS[@]}"; do
	if as_hadoku pm2 describe "$app" >/dev/null 2>&1; then
		as_hadoku pm2 delete "$app" >/dev/null 2>&1 && echo "  pm2 delete $app"
	else
		echo "  (not in PM2, nothing to delete): $app"
	fi
done
as_hadoku pm2 save >/dev/null 2>&1 && echo "  pm2 save — dump.pm2 updated"

echo
echo "  waiting for runner processes to exit..."
for _ in $(seq 1 15); do
	pgrep -f 'Runner.Listener' >/dev/null 2>&1 || break
	sleep 1
done
if pgrep -f 'Runner.Listener' >/dev/null 2>&1; then
	echo "  WARNING: a Runner.Listener is still alive; systemd start may fail" >&2
	pgrep -af 'Runner.Listener' | sed 's/^/    /' >&2
fi

echo
echo "=== 4. enabling + starting the systemd units ==="
for u in "${UNITS[@]}"; do
	systemctl enable --now "$u" >/dev/null 2>&1 && echo "  enabled+started $u"
done

echo
echo "  giving the runners a moment to connect to GitHub..."
sleep 12

echo
echo "=== 5. verify ==="
for u in "${UNITS[@]}"; do
	printf '  %-34s %s\n' "$u" "$(systemctl is-active "$u")"
done
echo
echo "  slice limits:"
systemctl show ci-runner.slice -p MemoryHigh -p MemoryMax -p MemorySwapMax -p MemoryCurrent |
	sed 's/^/    /'
echo
echo "  processes now inside ci-runner.slice:"
# Path is /ci.slice/ci-runner.slice, not /ci-runner.slice: systemd treats '-'
# in a slice name as a hierarchy separator, so ci-runner.slice is a CHILD of
# an implicit ci.slice. The short path fails with "No such file or directory",
# which makes a correct migration look like it placed nothing in the slice.
systemd-cgls --no-pager /ci.slice/ci-runner.slice 2>/dev/null | sed 's/^/    /' | head -20
echo
echo "  PM2 should no longer list either runner:"
as_hadoku pm2 list 2>/dev/null | grep -E 'github-runner' | sed 's/^/    /' ||
	echo "    (clean — no github-runner entries)"

cat <<'ROLLBACK'

=== DONE ===

Watch a job land with:
  journalctl -u github-runner-tenhands.service -f

ROLLBACK (if the runners misbehave):
  sudo systemctl disable --now github-runner.service github-runner-tenhands.service
  cd /home/hadoku/repos/hadoku_site && git revert <this commit> && <redeploy>
  pm2 start ecosystem.config.cjs --only github-runner
  pm2 start ecosystem.config.cjs --only github-runner-tenhands
  pm2 save
ROLLBACK
