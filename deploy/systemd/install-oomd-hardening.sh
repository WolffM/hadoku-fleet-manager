#!/usr/bin/env bash
#
# Install the systemd-oomd drop-ins that keep a runaway process from taking the
# host down. Run as root:
#
#   sudo deploy/systemd/install-oomd-hardening.sh
#
# Idempotent: safe to re-run. Re-run it after any edit to the two .conf files,
# and after a reimage.
#
# WHY THIS SCRIPT VERIFIES INSTEAD OF JUST COPYING
#
# systemd ignores an unknown directive with a single journal line and no error.
# `ManagedOOMSwapUsed` (not a real key; the real one is `ManagedOOMSwap`) sat in
# the root-slice drop-in from 2026-08-05 to 2026-08-11 doing nothing at all.
# oomd was active and enabled the whole time, so every check anyone thought to
# run said "protected". On 2026-08-11 InvokeAI reached 32.4 GB RSS, the box
# thrashed into swap, journald's watchdog timed out at 13:05 and hokon had to be
# power-cycled at 13:13.
#
# So a successful `install` proves nothing. The checks below read back the
# EFFECTIVE state from systemd and oomd, and the script exits non-zero if the
# protection is not actually live.
#
# set -u, no set -e: a failed step must report rather than exit silently
# halfway through.
set -u

# Resolved from THIS script, not from a hardcoded checkout. These units moved
# to @wolffm/fleet-manager on 2026-08-30 and are installed from wherever the
# package is checked out or unpacked — a pinned hadoku_site path would have
# silently installed a stale copy from a repo that no longer owns them.
SRC="$(cd "$(dirname "$0")" && pwd)"

# src file -> destination drop-in path
declare -A DROPINS=(
	["oomd-root-slice.conf"]="/etc/systemd/system/-.slice.d/10-oomd-root-slice.conf"
	["oomd-ci-slice.conf"]="/etc/systemd/system/ci.slice.d/10-oomd.conf"
)

if [ "$(id -u)" -ne 0 ]; then
	echo "Must run as root: sudo $0" >&2
	exit 1
fi

rc=0
fail() {
	echo "  FAIL: $*" >&2
	rc=1
}

echo "=== 1. installing drop-ins ==="
for src in "${!DROPINS[@]}"; do
	dest="${DROPINS[$src]}"
	if [ ! -f "$SRC/$src" ]; then
		fail "source missing: $SRC/$src"
		continue
	fi
	install -d -m 0755 -o root -g root "$(dirname "$dest")" || fail "mkdir $(dirname "$dest")"
	if install -m 0644 -o root -g root "$SRC/$src" "$dest"; then
		echo "  installed $dest"
	else
		fail "could not install $dest"
	fi
done
[ "$rc" -eq 0 ] || { echo "install step failed; not reloading" >&2; exit 1; }

echo
echo "=== 2. reloading systemd + oomd ==="
# Cursor for the journal check in step 3. It must only consider warnings emitted
# by the reload we are about to do — `journalctl -b 0` also returns warnings
# from EARLIER in this boot, including the very ones a run of this script just
# fixed, which would report a repaired host as broken.
reload_since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl daemon-reload || fail "daemon-reload"
# oomd re-reads its monitored-cgroup set from systemd on start, so a restart is
# required for a changed drop-in to take effect. A reload is not enough.
systemctl restart systemd-oomd.service || fail "restart systemd-oomd"
systemctl enable systemd-oomd.service >/dev/null 2>&1 || fail "enable systemd-oomd"

echo
echo "=== 3. verifying the directives actually LOADED ==="
# The check the 2026-08-11 freeze needed. An ignored key leaves this line in the
# journal and the protection absent; a clean load prints nothing.
unknown=$(journalctl --since "$reload_since" --no-pager 2>/dev/null | grep -F "Unknown key" | grep -F "oomd")
if [ -n "$unknown" ]; then
	fail "systemd IGNORED a directive in an oomd drop-in:"
	printf '%s\n' "$unknown" >&2
else
	echo "  no ignored directives in any oomd drop-in"
fi

# Effective, post-merge value straight from systemd — not the file's contents.
#
# Option order matters: the options must precede `--`. `systemctl show --
# -.slice -p ManagedOOMSwap --value` parses -p/ManagedOOMSwap/--value as UNIT
# NAMES (yielding a "ManagedOOMSwap.service not found" dump) and this check
# silently never passes.
root_swap=$(systemctl show -p ManagedOOMSwap --value -- -.slice 2>/dev/null)
if [ "$root_swap" = "kill" ]; then
	echo "  root slice ManagedOOMSwap=kill"
else
	fail "root slice ManagedOOMSwap is '${root_swap:-unset}', expected 'kill'"
fi

ci_pressure=$(systemctl show ci.slice -p ManagedOOMMemoryPressure --value 2>/dev/null)
if [ "$ci_pressure" = "kill" ]; then
	echo "  ci.slice ManagedOOMMemoryPressure=kill"
else
	fail "ci.slice ManagedOOMMemoryPressure is '${ci_pressure:-unset}', expected 'kill'"
fi

echo
echo "=== 4. verifying oomd is actually WATCHING ==="
# systemd can hold the directive while oomd still monitors nothing — e.g. if it
# started before swap was activated ("No swap; memory pressure usage will be
# degraded"). Only oomctl's own view proves the protection is live.
oomd_view=$(oomctl 2>/dev/null)
if printf '%s' "$oomd_view" | grep -qE '^Swap Monitored CGroups:'; then
	if printf '%s' "$oomd_view" | sed -n '/^Swap Monitored CGroups:/,/^[A-Z]/p' | grep -qE '^\s+Path: /$'; then
		echo "  oomd is monitoring swap on the root cgroup"
	else
		fail "oomd reports no root cgroup under 'Swap Monitored CGroups'"
	fi
else
	fail "oomctl reports no swap monitoring at all"
fi

if printf '%s' "$oomd_view" | grep -qE '^\s+Path: /ci\.slice$'; then
	echo "  oomd is monitoring memory pressure on /ci.slice"
else
	fail "oomd is not monitoring /ci.slice for memory pressure"
fi

# Swap has to EXIST for a swap-based kill policy to mean anything.
swap_total_kb=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
if [ "${swap_total_kb:-0}" -gt 0 ]; then
	echo "  swap is active ($((swap_total_kb / 1024 / 1024)) GiB)"
else
	fail "no swap is active — ManagedOOMSwap=kill can never fire"
fi

echo
if [ "$rc" -eq 0 ]; then
	echo "OK — oomd hardening installed and verified live."
else
	echo "PROBLEM — the host is NOT protected. Do not treat this as installed." >&2
fi
exit "$rc"
