#!/usr/bin/env bash
# runner-identity-probe — the NODE half of reconcile-runner-identity.mjs.
#
# Reports what this node ACTUALLY has: which runner installs exist, which
# repo each one is configured against, whether its listener is alive, and which
# ephemeral JIT units are running. The driver diffs that against what GitHub
# believes.
#
# Emits one record per line, never JSON — a node that half-fails should still
# produce usable lines rather than an unparseable blob.
#
#   RUNNER <dir> <repo|?> <agentName|?> <listenerAlive:0|1>
#   JITUNIT <unit> <activeState>
#   WARMUNIT <unit> <activeState>
#   PROBE-END <host> <runnerCount> <jitCount>
set -u

HOST=$(hostname)

# Same union as ci-throttle-install.sh: a glob that matches both naming shapes,
# plus every directory a live listener is actually running from. A directory the
# enumeration cannot see is one it cannot report, and that is exactly how
# hadoku_site went unthrottled on three nodes for two days.
# EXCLUDING JIT SLOTS. The listener union above deliberately picks up any live
# Runner.Listener whose directory the glob missed — that is what caught the
# unthrottled hadoku_site runner — and a JIT slot has a live listener and a
# .runner, so it lands in it. It is not a standing runner: it is minted per job,
# its concurrency is bounded by the dispatcher's own admission check, and
# systemd-run gives it MemoryMax and RuntimeMaxSec directly. Reporting it as
# "not wired to the throttle" is a permanent false positive, and the union is
# narrowed by an EXPLICIT known path rather than by tightening the glob, which
# would restore exactly the blind spot the union exists to close.
#
# AND EXCLUDING LISTENERS THAT ARE NOT INSTALLS (#103). The union took every
# `*/bin/Runner.Listener` in the process table, so a test suite's fake listener
# under /tmp (runner-env-drift.test.mjs spawns two) was reported as an
# UNCONFIGURED LISTENER whenever CI ran on this node during the probe — and
# reddened `check:runner-identity` over a fixture. A runner install belongs to
# the runner user and lives under its $HOME; the union still catches any naming
# convention there the glob misses (the bare ~/actions-runner it was built for),
# but a path outside $HOME, or inside a temp dir (TMPDIR may sit under $HOME on
# a claw whose /tmp is tmpfs), is not one and is dropped.
tmp_root=${TMPDIR:-/tmp}
tmp_root=${tmp_root%/}
runner_dirs() {
	{
		for d in "$HOME"/runners/actions-runner*/ "$HOME"/actions-runner*/ "$HOME"/repos/*/actions-runner*/; do
			d=${d%/}
			[ -d "$d" ] && printf '%s\n' "$d"
		done
		pgrep -af "bin/Runner\.Listener" 2>/dev/null | tr ' ' '\n' |
			while IFS= read -r tok; do
				case "$tok" in
				*/bin/Runner.Listener)
					dir=${tok%/bin/Runner.Listener}
					case "$dir" in
					"$tmp_root"/*) ;;
					"$HOME"/*) printf '%s\n' "$dir" ;;
					esac
					;;
				esac
			done
	} | sort -u | grep -v "^$HOME/\\.hadoku/jit/"
}

# .runner is UTF-8 with a BOM, which breaks every naive JSON reader — python's
# json.load included. Strip it rather than grepping, so a reformatted file does
# not silently read as absent.
#
# TWO KEY CASINGS. `config.sh` writes `agentName` / `gitHubUrl`; a JIT listener
# writes `AgentName` / `GitHubUrl` and adds `Ephemeral: "True"`. Reading only the
# lowercase form makes a JIT-clobbered install look like an unreadable file
# rather than what it is, which is exactly how ~/actions-runner-vibecheck sat
# crash-looping on hokon for a day: 12,621 restarts, its identity replaced by a
# probe's, and nothing in the fleet able to say so.
read_field() {
	sed 's/^\xEF\xBB\xBF//' "$1" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print('?'); raise SystemExit
low = {k.lower(): v for k, v in d.items()}
v = low.get('$2'.lower()) or '?'
print(str(v).replace('https://github.com/', '').strip() or '?')
" 2>/dev/null || echo '?'
}

n=0
for d in $(runner_dirs); do
	[ -d "$d" ] || continue
	repo='?'
	name='?'
	if [ -f "$d/.runner" ]; then
		repo=$(read_field "$d/.runner" gitHubUrl)
		name=$(read_field "$d/.runner" agentName)
	fi
	# `Ephemeral: "True"` in a PERSISTENT install's config is the clobber
	# signature: a JIT listener was launched from this directory and overwrote the
	# real runner's identity. It is reported separately because the install still
	# parses fine and would otherwise look healthy.
	eph=$(read_field "$d/.runner" Ephemeral)
	case "$eph" in True | true) echo "EPHEMERAL-CLOBBER $d $repo $name" ;; esac

	alive=0
	pgrep -f "^$d/bin/Runner.Listener" >/dev/null 2>&1 && alive=1
	# A dir with neither config nor a listener is not a runner at all — most
	# likely a leftover extraction. Report it only if it has one or the other.
	if [ "$repo" = '?' ] && [ "$alive" = 0 ]; then continue; fi
	echo "RUNNER $d $repo $name $alive"
	n=$((n + 1))
done

j=0
if XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user list-units 'jit-*' --all --no-legend >/dev/null 2>&1; then
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		u=$(printf '%s' "$line" | awk '{print $1}')
		st=$(printf '%s' "$line" | awk '{print $3}')
		echo "JITUNIT $u ${st:-unknown}"
		j=$((j + 1))
	done <<EOF
$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user list-units 'jit-*' --all --no-legend 2>/dev/null)
EOF
fi

# A warm listener is a STANDING registration served from a transient unit, not
# from an install dir (#112). Its slot under ~/.hadoku/warm/ does surface in the
# listener union above, but only while the process is up — so the driver judges
# a `warm-` registration by its UNIT, the same object the warm tick reaps on.
# Not counted in PROBE-END: that line's fields are a contract older than this.
while IFS= read -r line; do
	[ -n "$line" ] || continue
	u=$(printf '%s' "$line" | awk '{print $1}')
	st=$(printf '%s' "$line" | awk '{print $3}')
	echo "WARMUNIT $u ${st:-unknown}"
done <<EOF
$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user list-units 'warm-*' --all --no-legend 2>/dev/null)
EOF

echo "PROBE-END $HOST $n $j"
