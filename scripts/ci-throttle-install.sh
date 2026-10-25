#!/usr/bin/env bash
# ci-throttle-install — the NODE half of deploy-ci-throttle.mjs.
#
# A real file, not a JS template literal. The first cut embedded this in one, and
# three separate constructs broke the FILE rather than the script: a numeric sed
# backreference (read as an octal escape), a ${x##*/} expansion (read as JS
# interpolation), and a backtick inside a comment (which simply ended the string).
# Nothing typechecks shell embedded that way — `node --check` is the only signal.
# Here, shellcheck works and the quoting means what it says.
#
# Inputs, supplied as leading variable assignments on stdin by the driver:
#   APPLY=0|1       write anything at all
#   RESTART=0|1     restart idle runners after wiring them
#   HOOK_B64        base64 of scripts/admin/ci-throttle.sh
#   CONF_B64        base64 of this node's rendered ci-throttle.conf
#   METRICS_B64     base64 of scripts/job-metrics.sh (every node)
#   JIT_B64         base64 of scripts/jit-provision.sh (ephemeral nodes only)
#   HARVEST_B64     base64 of scripts/runner-mem-harvest.py (every node)
#   HARVEST_UNIT_B64 base64 of scripts/units/runner-mem-harvest.service
set -u

APPLY="${APPLY:-0}"
RESTART="${RESTART:-0}"

# `systemctl --user` without XDG_RUNTIME_DIR cannot reach the user bus, and it
# then exits 0 with the error only on stderr, which reads as success — the same
# trap that produced four false "unsupervised runner" alerts on 2026-08-21.
# The harvester block below and the SUMMARY's live-state read both need it.
XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR

# THE NODE-SIDE FLEET DIRECTORY, spelled once.
#
# It was spelled twelve times in this file, which is twelve edits to move it and
# eleven chances to miss one — and every miss is a hook path that points at
# nothing, which ADR 1751 turns into a failed job rather than a warning. This is
# NOT an operator knob: `~/.hadoku` is also spelled in jit-provision.sh,
# job-metrics.sh, warm-provision.sh, ephemeral.ts and deploy-ci-throttle.mjs,
# none of which read anything from here, so a variable that could be overridden
# would move THIS script's paths and leave theirs — a split brain worse than the
# hard-coded path. One spelling per file is the step that is available; the
# fleet-wide accessor is the step after it.
NODE_DIR="$HOME/.hadoku"

HOOK="$NODE_DIR/ci-throttle.sh"
CONF="$NODE_DIR/ci-throttle.conf"
LINE="ACTIONS_RUNNER_HOOK_JOB_STARTED=$HOOK"
# The COMPLETED hook. Pure instrumentation — it records the kernel's
# memory.peak for the job that just ended and can never fail one (ADR 1751
# turns a non-zero hook exit into a failed job; scripts/job-metrics.sh ends at
# an unconditional exit 0 and a guard test holds it there).
METRICS="$NODE_DIR/job-metrics.sh"
MLINE="ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$METRICS"

# This script owns the runner .env, not just the throttle hook. RUNNER_TOOL_CACHE
# was previously set by exactly two things: the reconciler AT REGISTRATION, and
# fix-runner-tool-cache.sh — a hand-run script with the wrong value hardcoded, no
# busy check, and a `sudo chown` that would have handed the shared hadoku tree to
# openclaw. Nothing repaired the value on an ALREADY-REGISTERED runner, which is
# the case runner-diag.yml actually fires on. The machinery to do it safely lives
# here already: dedupe the key, write, restart only what is idle.
# TOOLCACHE comes from lib/runner-toolcache.sh, prepended by the driver.
TCLINE="RUNNER_TOOL_CACHE=${TOOLCACHE:?runner-toolcache.sh was not prepended}"

# TEMP AND COMPILE CACHES, off tmpfs and onto disk (#100/#101). claw-4's tmpfs
# filled 03:22-04:14Z and failed 4 jobs while memory admission still passed —
# pytest and most tools follow TMPDIR, so a job's scratch space was riding the
# RAM-sized cliff admission never looks at. Disk is plentiful on every claw
# (claw-4: 808 GB free); tmpfs is not. Rendered as ABSOLUTE paths from THIS
# installing user's $HOME, because an env file does not expand `~` or
# `$HOME` itself — Runner.Listener reads the line literally.
#
# TMPDIR MUST HAVE NO DOT-DIRECTORY IN ITS PATH. The first version was
# `~/.cache/runner-tmp`, and it broke every e2e that serves files out of
# `tmpdir()`: express's `send` answers 404 for any path with a dot segment,
# while `/health` stays 200. hadoku-cardtable's harnesses copy the UI bundle
# into `mkdtemp(tmpdir())`, so check went red with no code change and the repo
# pinned TMPDIR back onto tmpfs to recover (cardtable f72a9ba, 2026-10-06).
# `runner-env.test.mjs` refuses a dotted TMPDIR. NODE_COMPILE_CACHE is read
# only by node itself, so it may stay under ~/.cache.
RUNNER_TMPDIR="$HOME/runner-tmp"
RUNNER_COMPILE_CACHE="$HOME/.cache/node-compile-cache"
TMPLINE="TMPDIR=$RUNNER_TMPDIR"
COMPLINE="NODE_COMPILE_CACHE=$RUNNER_COMPILE_CACHE"

# --- install the payload FIRST ---------------------------------------------
# Order is load-bearing. A .env naming a hook that does not exist makes the runner
# fail to execute it, and actions/runner ADR 1751 turns any non-zero hook exit
# into a FAILED JOB. The first deploy wrote .env first and was killed by an ssh
# timeout before the hook landed, leaving 21 runners on claw-1 one restart away
# from failing every build. Write the payload, then point anything at it.
if [ "$APPLY" = 1 ]; then
	mkdir -p "$NODE_DIR"
	# Created here, not left to the first job: a TMPDIR that does not exist makes
	# mktemp (and anything that calls it) fail outright, so the directory must
	# exist before any job can reach it. 0700 because it is scratch space for
	# whatever a job writes, same posture as a user's own tmp. Gated on APPLY
	# like everything else in this block — a --check run must not create the
	# very directories its next line is about to report on.
	mkdir -p "$RUNNER_TMPDIR" && chmod 0700 "$RUNNER_TMPDIR"
	mkdir -p "$RUNNER_COMPILE_CACHE"
	# REPLACED, NEVER REWRITTEN IN PLACE. `>` truncates the file a running job's
	# hook, or a mint's jit-provision.sh, is reading at that moment, and bash
	# reads a script as it goes. Since #1 the controller redeploys these
	# unattended, so a deploy must be safe mid-job: identical bytes are left
	# untouched, and anything else is written beside the file and renamed over
	# it. A reader already running keeps the inode it opened.
	put_b64() { # $1=dest $2=mode $3=base64 body
		if printf '%s' "$3" | base64 -d | cmp -s - "$1" 2>/dev/null; then
			chmod "$2" "$1"
			return 0
		fi
		printf '%s' "$3" | base64 -d >"$1.new.$$" && chmod "$2" "$1.new.$$" && mv "$1.new.$$" "$1"
	}
	put_b64 "$HOOK" 0755 "${HOOK_B64:-}"
	put_b64 "$CONF" 0644 "${CONF_B64:-}"
	# Payload before .env, for the same reason as the throttle hook above: a
	# .env naming a hook that is not there is one restart away from failing
	# every build on the box.
	if [ -n "${METRICS_B64:-}" ]; then
		put_b64 "$METRICS" 0755 "$METRICS_B64"
	fi
	# The JIT provisioner, for nodes the manifest marks `ephemeral: true`.
	# It ships from here because this script already owns ~/.hadoku and creates
	# it; a second deployer for one file would be a third copy of the harness for
	# no gain. It is INERT on arrival — nothing runs it until the dispatcher
	# mints, and nothing mints until `ephemeral: true` is set.
	if [ -n "${JIT_B64:-}" ]; then
		put_b64 "$NODE_DIR/jit-provision.sh" 0755 "$JIT_B64"
		# THE TOOL CACHE, for jit-provision.sh to stamp into each slot.
		#
		# It is written as a FILE rather than baked into the provisioner because
		# the value depends on `id -un` ON THE NODE (see lib/runner-toolcache.sh),
		# and that rule must keep exactly one statement — hardcoding it a second
		# time is what made fix-runner-tool-cache.sh dangerous.
		#
		# JIT slots had NO .env at all until 2026-09-02. The walker below only
		# writes dirs holding a `.runner`, which a slot has not got until a mint
		# creates one, and it excludes ~/.hadoku/jit/ besides. So every JIT job
		# ran without RUNNER_TOOL_CACHE: actions/setup-python found no interpreter
		# and fell through to a download that cannot succeed on Debian 13 — the
		# exact silent failure runner-toolcache.sh was written about, reappearing
		# on the ephemeral path once the fleet went all-JIT. 9 of 26 covered repos
		# use setup-python; hadoku-pygmalion is where it surfaced.
		printf '%s\n%s\n%s\n%s\n' "$TCLINE" "$MLINE" "$TMPLINE" "$COMPLINE" >"$NODE_DIR/runner.env"
		chmod 0644 "$NODE_DIR/runner.env"
	fi
	if [ ! -s "$HOOK" ] || [ ! -x "$HOOK" ]; then
		echo "HOOK-INSTALL-FAILED $HOOK"
		echo "SUMMARY wired=0 newly=0 stale=0 restarted=0 busy=0 skipped=0"
		exit 1
	fi

	# --- THE MEMORY HARVESTER (#47): sampler + user unit, installed AND -----
	# --- STARTED by the same payload that ships the hook above.             -
	# Until 2026-09-22 this unit was copied onto three claws BY HAND and onto
	# no others; the hand copies then matched zero runner cgroups under all-JIT
	# naming and harvested nothing while staying `active`. Everything about the
	# memory fleet — every cap, every clipped-window verdict — was being read
	# from data that had stopped existing. Notes:
	#   - The sampler lands in $NODE_DIR (beside the hook that self-heals it)
	#     because that is the directory this payload owns and hashes; the UNIT
	#     must land in ~/.config/systemd/user because that is the only tree the
	#     user manager reads.
	#   - The ~/.local/bin copy the 2026-08 hand installs left behind is
	#     REMOVED: the unit now points at $NODE_DIR, and a second copy on disk
	#     is exactly the "which copy is running" ambiguity this deploy ends.
	#   - A sampler is observation-only, so restart-on-change is safe where a
	#     runner restart is not. Since #99 it costs nothing at all: the new
	#     process resumes a running window from inflight.json and writes out
	#     one that ended during the gap.
	#   - STARTED, never just enabled: a payload that leaves the unit stopped
	#     reports harvest=0 below and the driver flags it.
	if [ -n "${HARVEST_B64:-}" ] && [ -n "${HARVEST_UNIT_B64:-}" ]; then
		HARVEST="$NODE_DIR/runner-mem-harvest.py"
		HARVEST_UNIT_DIR="$HOME/.config/systemd/user"
		HARVEST_UNIT="$HARVEST_UNIT_DIR/runner-mem-harvest.service"
		harvest_changed=0
		if ! printf '%s' "$HARVEST_B64" | base64 -d | cmp -s - "$HARVEST" 2>/dev/null; then
			printf '%s' "$HARVEST_B64" | base64 -d >"$HARVEST" &&
				chmod 0755 "$HARVEST" && harvest_changed=1
		fi
		mkdir -p "$HARVEST_UNIT_DIR"
		if ! printf '%s' "$HARVEST_UNIT_B64" | base64 -d | cmp -s - "$HARVEST_UNIT" 2>/dev/null; then
			printf '%s' "$HARVEST_UNIT_B64" | base64 -d >"$HARVEST_UNIT" &&
				chmod 0644 "$HARVEST_UNIT" && harvest_changed=1
		fi
		rm -f "$HOME/.local/bin/runner-mem-harvest.py"
		if systemctl --user daemon-reload 2>/dev/null; then
			if [ "$harvest_changed" = 1 ]; then
				systemctl --user restart runner-mem-harvest.service 2>/dev/null ||
					echo "HARVEST-FAILED restart (unit wrote, could not restart)"
			fi
			systemctl --user enable --now runner-mem-harvest.service >/dev/null 2>&1 ||
				echo "HARVEST-FAILED enable (unit wrote, could not enable/start)"
		else
			echo "HARVEST-FAILED daemon-reload (unit wrote, manager did not reload)"
		fi
	fi
fi

# --- the listener's REAL start time, never the /proc/<pid> INODE's mtime ---
#
# `stat -c %Y /proc/<pid>` is NOT the process start time — it is the time the
# /proc/<pid> DIRECTORY ENTRY was instantiated (first lookup, or re-lookup
# after kernel dcache eviction), which depends on whatever ELSE happens to
# read /proc. On a box where something scans /proc continuously the entry
# exists from spawn and the two times coincide, so this looked correct for
# months. On a quiet standing runner (a Publish job's systemd service, where
# nothing looks at this pid's /proc entry until this script does, AFTER the
# listener started AND after a later .env write), the inode mtime reads as
# "just instantiated" — i.e. NEWER than a .env that is actually older — so a
# genuinely stale listener was read as loaded. Publish run 37662120377 is
# that bug firing for real, not a test artifact: four tests built on the old
# `stat -c %Y` semantics read `stale=0` on an unambiguously stale fixture.
#
# The kernel's own ground truth is /proc/<pid>/stat field 22 (starttime, in
# clock ticks since boot) plus /proc/stat's `btime` (boot time, unix epoch
# seconds) — NEITHER is affected by dcache eviction or by anything else
# reading /proc; both are recorded once and read back unchanged.
proc_start_epoch() {
	pid="$1"
	statline=$(cat "/proc/$pid/stat" 2>/dev/null) || return 1
	[ -n "$statline" ] || return 1
	# Field 2 (comm, in parens) can itself contain spaces and parens, so this
	# splits on the LAST ") " rather than counting fields from the front —
	# the same trap cgroup_of()'s caller avoids by reading the whole cgroup
	# line rather than assuming a fixed shape.
	rest="${statline##*) }"
	[ "$rest" != "$statline" ] || return 1
	# shellcheck disable=SC2086
	set -- $rest
	# $rest starts at field 3 (state); starttime is field 22 overall, i.e.
	# the 20th word of $rest (22 - 2, since $rest begins two fields in).
	shift 19 2>/dev/null || return 1
	starttime_ticks="${1:-}"
	case "$starttime_ticks" in '' | *[!0-9]*) return 1 ;; esac
	clk_tck=$(getconf CLK_TCK 2>/dev/null)
	case "$clk_tck" in '' | *[!0-9]*) clk_tck=100 ;; esac
	btime_line=$(grep '^btime ' /proc/stat 2>/dev/null) || return 1
	btime="${btime_line#btime }"
	case "$btime" in '' | *[!0-9]*) return 1 ;; esac
	echo $((btime + starttime_ticks / clk_tck))
}

# --- resolve a runner's unit FROM ITS CGROUP, never by name ----------------
# Four naming conventions and two systemd scopes are live across this fleet, and
# grepping /etc/systemd/system for the runner directory sees only one of them: it
# missed every reconciler-installed USER unit (games-host, hopper, merchant on
# all three claws) and both hokon units, whose ExecStart is a wrapper script that
# never mentions the runner directory. The cgroup is ground truth and needs no
# convention list — the same lesson runner-supervision.ts learned after three
# rounds of name-matching false positives.
cgroup_of() {
	lp=$(pgrep -f "^$1/bin/Runner.Listener" 2>/dev/null | head -1)
	[ -n "$lp" ] || return 1
	tail -1 "/proc/$lp/cgroup" 2>/dev/null
}

restart_dir() {
	cg=$(cgroup_of "$1") || {
		echo "NO-LISTENER $1"
		return 1
	}
	before=$(pgrep -f "^$1/bin/Runner.Listener" 2>/dev/null | head -1)
	u=$(basename "$cg")
	case "$u" in
	*.service) ;;
	*)
		echo "NO-UNIT $1"
		return 1
		;;
	esac
	# NEVER a bare `systemctl restart`. These units carry KillMode=process with
	# ExecStart=run.sh, so a restart kills only run.sh and leaves the child
	# Runner.Listener alive — systemd then starts a SECOND one. Two listeners race
	# for a single GitHub session, the loser logs
	# TaskAgentSessionConflictException and retries every 30s, and the runner
	# accepts no jobs at all. That is exactly what a bare restart did to
	# games-host, hopper and merchant on all three claws on 2026-08-24: nine
	# runners dark for ~15 minutes.
	#
	# KillMode=process is not a bug to fix — it is what lets an in-flight JOB
	# survive a unit restart. So drain first (callers only reach here when the
	# runner is idle), then reap the whole cgroup explicitly, then start.
	# `kill --kill-whom=all` is UNIT-scoped: it needs no runtime pid selection and
	# therefore cannot target the wrong process.
	# A SYSTEM unit needs root. The first cut checked that sudo was AVAILABLE
	# (`sudo -n true`) and then ran every systemctl call WITHOUT it, so each one
	# died with "Interactive authentication required", the old listener kept
	# running, and restart_dir still returned 0 — restarted=N was reported for
	# units that never restarted. Every runner under system.slice therefore held
	# its previous .env until something unrelated restarted it. Proven on claw-3
	# on 2026-08-26: the bare `stop` exits 1 and leaves the unit active; the same
	# call under `sudo -n` replaces the pid.
	#
	# The invocation prefix is passed as WORDS ("sudo -n systemctl" /
	# "systemctl --user"), never interpolated into a string, so there is no
	# word-splitting to disable and no way to run the wrong binary.
	stop_reap_start() {
		"$@" stop "$u" >/dev/null 2>&1
		"$@" kill --kill-whom=all --signal=SIGTERM "$u" >/dev/null 2>&1
		sleep 2
		"$@" start "$u" >/dev/null 2>&1
	}

	case "$cg" in
	*user@*)
		# `systemctl --user` without XDG_RUNTIME_DIR cannot reach the user bus. It
		# then exits 0 with the error only on stderr, which reads as success — the
		# same trap that produced four false "unsupervised runner" alerts on
		# 2026-08-21. Always set it.
		XDG_RUNTIME_DIR="/run/user/$(id -u)"
		export XDG_RUNTIME_DIR
		stop_reap_start systemctl --user
		;;
	*)
		# hokon's `hadoku` has NO passwordless sudo, unlike all three claws. Say so
		# rather than emitting a bare RESTART-FAILED that reads as a transient.
		if ! sudo -n true 2>/dev/null; then
			echo "NEEDS-OPERATOR $1 ($u — no passwordless sudo on $(hostname))"
			return 1
		fi
		stop_reap_start sudo -n systemctl
		;;
	esac

	# Assert the outcome rather than trusting the command. A restart that leaves
	# two listeners is the failure this whole block exists to prevent, so it must
	# be LOUD rather than counted as a success.
	# Assert the OUTCOME, never the command's exit status. Two distinct failures
	# hide here: a restart that leaves TWO listeners racing for one GitHub
	# session, and a restart that silently did NOTHING. Only the first was
	# checked, which is why the sudo bug above reported success for two days.
	# The listener must come back AND carry a different pid — "still the old pid"
	# is precisely the silent-no-op case, and it means the .env is written but
	# not live.
	after=""
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		sleep 1
		after=$(pgrep -f "^$1/bin/Runner.Listener" 2>/dev/null | head -1)
		[ -n "$after" ] && [ "$after" != "$before" ] && break
	done
	n=$(pgrep -fc "^$1/bin/Runner.Listener" 2>/dev/null || echo 0)
	if [ "$n" -gt 1 ] 2>/dev/null; then
		echo "DUPLICATE-LISTENERS $1 ($n listeners after restart — reap them before this runner can take jobs)"
		return 1
	fi
	if [ -z "$after" ]; then
		echo "NO-LISTENER-AFTER-RESTART $1 ($u did not come back)"
		return 1
	fi
	if [ -n "$before" ] && [ "$after" = "$before" ]; then
		echo "RESTART-DID-NOTHING $1 ($u still on pid $after — .env written but NOT live)"
		return 1
	fi
	return 0
}

# --- which runner dirs are BUSY right now (process tree, not the API) ------
busy_dirs=""
for w in $(pgrep -x Runner.Worker 2>/dev/null); do
	pp=$(awk '{print $4}' "/proc/$w/stat" 2>/dev/null) || continue
	cl=$(tr '\0' ' ' <"/proc/$pp/cmdline" 2>/dev/null) || continue
	for tok in $cl; do
		case "$tok" in
		*/bin/Runner.Listener) busy_dirs="$busy_dirs ${tok%/bin/Runner.Listener}" ;;
		esac
	done
done

changed=0
skipped=0
stalecount=0
already=0
restarted=0
busy=0
# #102: does a "written but NOT LOADED" listener survive THIS run? Busy means
# left alone on purpose; a restart attempted and failed (sudo refused, no
# unit, duplicate listeners) leaves it exactly as stale as it started; nothing
# attempted (a dry run, or --no-restart) is the same. Only a restart that
# actually swaps the pid clears it. The driver gates --confirm's exit code on
# this count, not on `stale` alone, because `stale` is a point-in-time
# detection and says nothing about whether this run then fixed it.
stale_remaining=0
# A correct .env with NO running Runner.Listener at all — not "wrong on disk"
# (the env is right) and not "stale" (there is no listener to have failed to
# reload it). Counted OUTSIDE `changed` on purpose: `changed` feeds `newly` in
# the SUMMARY, and the driver computes `wrong = newly - stale` and reports
# "N runner(s) have the wrong env on disk" for whatever that leaves over — a
# listener-less dir folded into `changed` read as a FALSE "wrong env" finding
# on a correctly-configured, deliberately-stopped runner.
nolistener=0

# --- which directories ARE runners -----------------------------------------
# Enumerate by GLOB **union RUNNING LISTENERS**, never by a hand-kept path list.
#
# The first cut globbed "$HOME"/actions-runner-* and then named one extra path
# explicitly. That pattern requires the DASH, so it never matched the bare
# "$HOME/actions-runner" — which is where every claw keeps its hadoku_site
# runner, the repo generating 49% of all fleet jobs. The named extra path
# ("$HOME/repos/hadoku_site/actions-runner") does not exist on any node, so
# the busiest repo in the fleet ran unthrottled on claw-1, claw-2 and claw-3
# while --check reported "every runner on every node is wired": a directory
# the enumeration cannot see is also a directory it cannot report.
#
# The listener union is what makes that whole CLASS of miss loud rather than
# silent. A live Runner.Listener whose directory the glob did not produce is
# now enumerated anyway, so the next naming convention costs a warning instead
# of an unthrottled node. Same lesson as cgroup_of() above, applied to
# directories instead of units.
# EXCLUDING JIT SLOTS. The listener union above deliberately picks up any live
# Runner.Listener whose directory the glob missed — that is what caught the
# unthrottled hadoku_site runner — and a JIT slot has a live listener and a
# .runner, so it lands in it. It is not a standing runner: it is minted per job,
# its concurrency is bounded by the dispatcher's own admission check, and
# systemd-run gives it MemoryMax and RuntimeMaxSec directly. Reporting it as
# "not wired to the throttle" is a permanent false positive, and the union is
# narrowed by an EXPLICIT known path rather than by tightening the glob, which
# would restore exactly the blind spot the union exists to close.
runner_dirs() {
	{
		for d in "$HOME"/runners/actions-runner*/ "$HOME"/actions-runner*/ "$HOME"/repos/*/actions-runner*/; do
			d=${d%/}
			[ -f "$d/.runner" ] && printf '%s\n' "$d"
		done
		# pgrep -f matches its own shell, so filter on the exact argv token
		# rather than trusting the match.
		pgrep -af "bin/Runner\.Listener" 2>/dev/null | tr ' ' '\n' |
			while IFS= read -r tok; do
				case "$tok" in
				*/bin/Runner.Listener) printf '%s\n' "${tok%/bin/Runner.Listener}" ;;
				esac
			done
		# The `.` in `.hadoku` is a REGEX dot once the variable is expanded, so it is
		# escaped back. The literal this replaced already escaped it; losing that in
		# the substitution would widen the exclusion by one character class.
	} | sort -u | grep -v "^${NODE_DIR//./\\.}/jit/"
}

while IFS= read -r d; do
	[ -n "$d" ] || continue
	[ -d "$d" ] || continue
	[ -f "$d/.runner" ] || continue
	env_file="$d/.env"

	stale_this=0
	# "Wired" is the .env being right; "live" is the LISTENER having loaded it.
	# Runner.Listener calls LoadAndSetEnv() once in Program.Main, so a runner keeps
	# its old environment until restarted — and /proc/<pid>/environ cannot confirm
	# it either, because that is the process's INITIAL environment and never shows
	# a runtime SetEnvironmentVariable. So compare timestamps: the listener's REAL
	# start time (proc_start_epoch(), above — NOT the /proc/<pid> inode's mtime,
	# which is not the same thing) against the .env's mtime; a .env newer than the
	# listener's actual start has not been read yet.
	# Computed unconditionally (not only when $env_file exists) so an EMPTY
	# `lp` is a fact this loop body can act on below, not just a reason to
	# skip the staleness check silently.
	lp=$(pgrep -f "^$d/bin/Runner.Listener" 2>/dev/null | head -1)
	stale=0
	if [ -f "$env_file" ]; then
		if [ -n "$lp" ]; then
			em=$(stat -c %Y "$env_file" 2>/dev/null || echo 0)
			ls_=$(proc_start_epoch "$lp")
			if [ -z "$ls_" ]; then
				# "I could not look" must never render as "nothing is wrong"
				# (AGENTS.md) — the /proc-inode-mtime fallback this replaced
				# was exactly that failure mode wearing a different hat.
				# Conservative here means treating an unreadable start time as
				# POSSIBLY stale rather than silently loaded: the cost of a
				# wrong restart on an actually-current idle listener is a few
				# seconds of listener churn (restart_dir already tolerates
				# that — it is re-runnable and idempotent); the cost of
				# silently calling a genuinely stale listener "loaded" is the
				# #102 production incident this file exists to prevent.
				stale=1
				echo "STALE-UNREADABLE $d (could not read /proc/$lp/stat or /proc/stat's btime — treated as stale rather than assumed loaded)"
			else
				[ "$em" -gt "$ls_" ] 2>/dev/null && stale=1
			fi
		fi
	fi

	# Both keys must be right, not just the hook. A runner wired to the throttle
	# but pointed at a tool cache it cannot read is not a wired runner — it is a
	# runner whose every setup-python silently re-downloads and then fails.
	# EVERY key this script writes must be checked here, or the repair and the
	# idempotency check share a blind spot and fail together — the exact rule
	# CLAUDE.md states. Adding ACTIONS_RUNNER_HOOK_JOB_COMPLETED to the writer
	# without adding it here made the first fleet-wide run report `wired=28` on
	# hokon while writing the new key to none of the 28.
	env_ok=1
	grep -qxF "$LINE" "$env_file" 2>/dev/null || env_ok=0
	grep -qxF "$TCLINE" "$env_file" 2>/dev/null || env_ok=0
	grep -qxF "$MLINE" "$env_file" 2>/dev/null || env_ok=0
	grep -qxF "$TMPLINE" "$env_file" 2>/dev/null || env_ok=0
	grep -qxF "$COMPLINE" "$env_file" 2>/dev/null || env_ok=0

	# A live listener is now part of "wired", not an unchecked assumption. A
	# `.env` can be byte-for-byte correct for a Runner.Listener that crashed,
	# never started, or was reaped and never replaced — `env_ok`'s five greps
	# say nothing about whether ANYTHING is actually running to have read it.
	# Before this, that combination (env_ok=1, lp empty) fell into `stale=0`
	# by construction (the staleness check itself is skipped without a live
	# pid to compare against) and then straight into "already wired" below —
	# a registered runner with no running listener at all read as perfectly
	# healthy, the same "I could not look" rendering as "nothing is wrong"
	# this whole file exists to refuse elsewhere.
	if [ "$env_ok" = 1 ] && [ "$stale" = 0 ] && [ -n "$lp" ]; then
		already=$((already + 1))
		wired=1
	else
		wired=0
		# Several different states share `wired=0`, and an audit that cannot
		# tell them apart tells the reader to re-run a fix that already ran.
		# STALE means the file on disk is CORRECT and the listener has simply
		# not restarted to read it. For a claw this is a `systemctl --user`
		# unit and needs no sudo — --confirm clears it itself below. Only a
		# node with no passwordless sudo (a guest, never reached here by role)
		# is a resting state an operator must clear by hand.
		no_listener_this=0
		if [ "$env_ok" = 1 ] && [ -n "$lp" ]; then
			stalecount=$((stalecount + 1))
			stale_this=1
			echo "STALE $d"
		elif [ "$env_ok" = 1 ] && [ -z "$lp" ]; then
			# NOT "stale" — that label means a listener exists and simply has
			# not reloaded. This is a different failure: there is no listener
			# AT ALL to have loaded anything. restart_dir() below (reached via
			# the same wired=0 path) will independently rediscover this and
			# print its own NO-LISTENER/RESTART-FAILED — but only when APPLY=1.
			# Said here too so a plain `--check` (APPLY=0) is not silent about it.
			no_listener_this=1
			nolistener=$((nolistener + 1))
			echo "NO-LIVE-LISTENER $d (env is correct but no Runner.Listener is running for it)"
		fi
		if [ "$APPLY" = 1 ] && [ "$env_ok" = 0 ]; then
			# Drop any previous values first, so re-pointing a key cannot leave two.
			if [ -f "$env_file" ]; then
				grep -v -e '^ACTIONS_RUNNER_HOOK_JOB_STARTED=' -e '^RUNNER_TOOL_CACHE=' \
					-e '^ACTIONS_RUNNER_HOOK_JOB_COMPLETED=' \
					-e '^TMPDIR=' -e '^NODE_COMPILE_CACHE=' \
					"$env_file" >"$env_file.tmp" 2>/dev/null || : >"$env_file.tmp"
				mv "$env_file.tmp" "$env_file"
			fi
			printf '%s\n%s\n%s\n%s\n%s\n' "$LINE" "$TCLINE" "$MLINE" "$TMPLINE" "$COMPLINE" >>"$env_file"
		fi
		# Excludes the nolistener case on purpose: `changed` feeds `newly` in the
		# SUMMARY, and the driver subtracts `stale` from it to report "wrong env
		# on disk" for the remainder. A listener-less dir's env is NOT wrong —
		# folding it in here is exactly how that false finding would happen.
		[ "$no_listener_this" = 1 ] || changed=$((changed + 1))
	fi

	case " $busy_dirs " in
	*" $d "*) isbusy=1 ;;
	*) isbusy=0 ;;
	esac

	if [ "$wired" = 0 ] && [ "$isbusy" = 1 ]; then
		busy=$((busy + 1))
		echo "BUSY $d"
		# A busy one is left alone ON PURPOSE — draining a live job is the outage
		# this whole idle check exists to avoid — but "left alone" still means
		# the stale listener is exactly as unresolved as it was before this run.
		[ "$stale_this" = 1 ] && stale_remaining=$((stale_remaining + 1))
	elif [ "$wired" = 0 ] && [ "$RESTART" = 1 ] && [ "$APPLY" = 1 ]; then
		if restart_dir "$d"; then
			restarted=$((restarted + 1))
		else
			skipped=$((skipped + 1))
			echo "RESTART-FAILED $d"
			[ "$stale_this" = 1 ] && stale_remaining=$((stale_remaining + 1))
		fi
	elif [ "$wired" = 0 ] && [ "$stale_this" = 1 ]; then
		# Nothing was attempted at all — a dry run, or --no-restart. Exactly as
		# unresolved as --check found it.
		stale_remaining=$((stale_remaining + 1))
	fi
done <<RUNNER_DIRS
$(runner_dirs)
RUNNER_DIRS

# Does the hook's OWN config resolve and load, as the user the hook runs as?
# Auditing the .env line proves only that we wrote something; it cannot see a
# conf the hook will fail to read, which is a silent no-limit runner.
conf_ok=0
[ -r "$CONF" ] && conf_ok=1
# And WHAT IT LOADS TO, read the way the hook reads it. This was a
# `grep -q '^MAX_CONCURRENT='` until #98's mutation pass: presence, not value.
# The hook sources the conf over permissive defaults and then replaces any
# value that is not a non-negative integer with that default — so
# `MAX_CONCURRENT=two` is MAX_CONCURRENT=99 and a missing MIN_FREE_MB is 0, a
# node with no limit at all, and the grep called it loaded. So: source it in
# a subshell over the hook's own defaults, apply the hook's own validation,
# and report the EFFECTIVE values. The driver compares them to the manifest;
# this half only says what the hook would enforce. `-` is "could not look"
# (no readable conf), never a number.
conf_max=-
conf_minfree=-
if [ "$conf_ok" = 1 ]; then
	conf_vals=$(
		MAX_CONCURRENT=99
		MIN_FREE_MB=0
		# shellcheck source=/dev/null
		. "$CONF" >/dev/null 2>&1
		case "$MAX_CONCURRENT" in '' | *[!0-9]*) MAX_CONCURRENT=99 ;; esac
		case "$MIN_FREE_MB" in '' | *[!0-9]*) MIN_FREE_MB=0 ;; esac
		printf '%s %s' "$MAX_CONCURRENT" "$MIN_FREE_MB"
	)
	conf_max="${conf_vals%% *}"
	conf_minfree="${conf_vals##* }"
fi
jit_installed=0
[ -x "$NODE_DIR/jit-provision.sh" ] && jit_installed=1
# The PAYLOAD, separately from the script. A deployed provisioner on a node
# with no payload is the bootstrap deadlock: every mint fails at step one, and
# `jit=1` reported the node as ready the whole time. It is reported rather
# than asserted here because a node that has never minted legitimately has
# none yet — the caller decides whether that is drift.
jit_payload=0
[ -x "$NODE_DIR/jit/payload/bin/Runner.Listener" ] && jit_payload=1

# THE JIT SLOT ENV, same "reported, never judged" posture as jit/payload above:
# a non-ephemeral node legitimately has none, so presence alone is not drift —
# the driver decides that from the manifest. Content IS judged here because it
# needs no manifest: a runner.env that exists but is missing a key is wrong on
# every node, ephemeral or not. This is the gap the comment above names —
# ~/.hadoku/runner.env was missing on 6/6 claws and nothing checked for it.
runnerenv_present=0
[ -r "$NODE_DIR/runner.env" ] && runnerenv_present=1
runnerenv_keys_ok=0
if [ "$runnerenv_present" = 1 ]; then
	if grep -qxF "$TCLINE" "$NODE_DIR/runner.env" 2>/dev/null &&
		grep -qxF "$MLINE" "$NODE_DIR/runner.env" 2>/dev/null &&
		grep -qxF "$TMPLINE" "$NODE_DIR/runner.env" 2>/dev/null &&
		grep -qxF "$COMPLINE" "$NODE_DIR/runner.env" 2>/dev/null; then
		runnerenv_keys_ok=1
	fi
fi

# --- PROVENANCE: is what is deployed here what the package ships? -----------
# A CONTENT HASH, not a version marker written into the file. Two reasons.
#
# A hand-kept marker is a DECLARATION and this repo has been burned three times
# by reading one as evidence — it says what the last editor believed, not what
# the bytes are, and it goes stale exactly when a file is edited without the
# discipline. It would also fight WS-E, which is editing job-metrics.sh in
# parallel: two owners writing one marker line is a merge conflict per release.
# sha256 of the file IS the file, needs no cooperation from either editor, and
# is computed on both sides from the same bytes.
#
# This closes the gap docs/planning/deployed-not-published-2026-09-05.md names
# as still open: ~/.hadoku/runner.env was missing on 6/6 claws two days after
# the fix that writes it shipped, and this command reported every runner wired
# the whole time, because it audited the .env CONTENTS and never asked whether
# the scripts beside it were current.
#
# Reported, never judged. Which of these is drift depends on what the manifest
# says the node is — a non-ephemeral node legitimately has no provisioner — and
# that answer lives with the driver, which has the manifest. The node half's job
# is to say what is on disk.
# Three outcomes, never two. "Not there" and "there but I could not read it"
# send an operator to different places — a deploy versus a trip to the box —
# and collapsing them is what made check-queue-health's findings undiagnosable.
sha_of() {
	if [ ! -e "$1" ]; then
		printf 'absent'
		return
	fi
	h=$(sha256sum "$1" 2>/dev/null | cut -d' ' -f1)
	if [ -n "$h" ]; then printf '%s' "$h"; else printf 'unreadable'; fi
}
jit_sha=$(sha_of "$NODE_DIR/jit-provision.sh")
metrics_sha=$(sha_of "$METRICS")
hook_sha=$(sha_of "$HOOK")
# The conf's bytes too, though it is RENDERED rather than shipped: the driver
# hashes what it would render for this node from the manifest, so a mismatch
# is "the manifest moved and this node was not re-deployed" — a separate
# finding from the shipped-file provenance above, never folded into it.
conf_sha=$(sha_of "$CONF")
# The harvester's LIVE state beside its hashes: deployed-but-stopped is a real
# state (a stopped unit hashes perfectly), and the driver flags harvest=0 as
# drift. is-active is a bus question, answered here ONCE for the unit only —
# whether the sampler is COLLECTING is `fleet mem-report --check`'s question,
# answered from the output files.
harvest_active=0
systemctl --user is-active --quiet runner-mem-harvest.service 2>/dev/null && harvest_active=1
harvest_sha=$(sha_of "$NODE_DIR/runner-mem-harvest.py")
harvest_unit_sha=$(sha_of "$HOME/.config/systemd/user/runner-mem-harvest.service")

echo "SUMMARY conf=$conf_ok conf_max=$conf_max conf_minfree=$conf_minfree confsha=$conf_sha jit=$jit_installed payload=$jit_payload wired=$already newly=$changed stale=$stalecount stale_remaining=$stale_remaining nolistener=$nolistener restarted=$restarted busy=$busy skipped=$skipped hooksha=$hook_sha metricssha=$metrics_sha jitsha=$jit_sha harvest=$harvest_active harvestsha=$harvest_sha harvestunitsha=$harvest_unit_sha runnerenv=$runnerenv_present runnerenvkeys=$runnerenv_keys_ok"
