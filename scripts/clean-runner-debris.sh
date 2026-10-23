#!/usr/bin/env bash
# clean-runner-debris — reclaim disk the GitHub runner's self-update leaves behind.
#
# WHY
# ---
# The runner updates itself in place and never cleans up. Each upgrade leaves the
# PREVIOUS version's `bin.<v>` and `externals.<v>` (~675 MB together) plus a
# `_work/_update` staging tree (~674 MB), forever. Measured on claw-2 on
# 2026-08-24: 28 stale version directories and 14 staging trees across 27
# runners — 18.3 GB of a 110 GB disk, on the box that also has the least RAM and
# the most work. One runner was still carrying `bin.2.319.1`, seventeen releases
# back.
#
# Reclaimable fleet-wide at that point: 51.2 GB.
#
# WHAT IS SAFE TO REMOVE, AND WHY
# -------------------------------
#   bin.<v> / externals.<v>   ONLY when <v> is not what `bin` / `externals`
#                             symlink to. The live version is resolved with
#                             readlink, never assumed from a version string or a
#                             sort order — a runner mid-upgrade legitimately has
#                             two, and which one is live is a fact on disk.
#   _work/_update             self-update staging, re-created on the next update.
#   _diag/*.log               older than DIAG_KEEP_DAYS. Rotation, not deletion:
#                             recent logs are how a failed job gets diagnosed.
#   _work/**/<venv>           a virtualenv whose bin/python is a symlink to an
#                             interpreter that no longer exists (#127). It can
#                             never run again, and the next job that reuses the
#                             checkout dies on `.venv/bin/pip: cannot execute`
#                             instead of building a fresh one.
#
# NEVER touched: `.credentials`, `.runner`, `.env`, anything under a runner
# that is currently RUNNING A JOB, or a path any live process still has open
# or has written to inside TMP_KEEP_MIN (the `in_use` helper, used by every
# tmpfs/disk sweep below). `_work/<repo>` checkouts are warm caches kept by
# default too — only a tree untouched for WORK_STALE_DAYS, measured at depth
# <=3 so a live checkout's own mtime (which moves on the top dir only at
# creation) is not mistaken for staleness, is pruned, and only inside an
# idle, in-range JIT slot with no live Runner.Listener.
#
# THE IDLE RULE IS THE IMPORTANT ONE. Deleting `_work/_update` under a runner
# that is mid-self-update, or a `bin.<v>` it is about to switch to, breaks that
# runner. A runner with a live `Runner.Worker` is skipped entirely and picked up
# next week; this is a janitor, and a janitor that interrupts work is worse than
# dust.
#
# THREE GUARDS besides the above: (1) the tmpfs root is `TMPFS_ROOT`, never a
# hardcoded `/tmp` — a test run or a hook must be able to fence this script
# into a fixture; (2) `sweep_compile_cache` on a disk path refuses anything
# whose basename is not exactly `node-compile-cache`, or that is `/` or
# `$HOME`; (3) the `TMPDIR_DISK` sweep refuses a path that is `/` or `$HOME`.
# A refused path prints `SKIP-UNSAFE <path>` and is never touched — both
# knobs are read from `~/.hadoku/runner.env`, operator-writable, so a `rm -rf`
# of a whole directory sourced from a file needs its own fence.
#
# The job-start prune in ci-throttle.sh's `maybe_prune_tmp` is a separate,
# more conservative inline implementation — it does not call into this
# script. The two share only their pattern list (see PRUNE_PATTERNS /
# sweep_glob).
#
# Inputs (leading assignments on stdin, supplied by clean-runner-debris.mjs):
#   APPLY=0|1               actually delete
#   DIAG_KEEP_DAYS=N        keep _diag logs newer than this
#   MAX_CONCURRENT_NODE=N   this node's declared ceiling, from the manifest ON
#                           THE CONTROLLER (clean-runner-debris.mjs reads it;
#                           this script has no other way to know it). Empty or
#                           non-numeric means "could not look" and the JIT-slot
#                           sweep below is skipped entirely — never delete a
#                           slot because the ceiling was not given.
set -u

APPLY="${APPLY:-0}"
DIAG_KEEP_DAYS="${DIAG_KEEP_DAYS:-14}"
MAX_CONCURRENT_NODE="${MAX_CONCURRENT_NODE:-}"
# A pytest basetemp older than this is from a finished job: nothing in the fleet
# allows more than 15 minutes per job. Age is the right gate here rather than the
# per-runner idle rule the rest of this script uses, because /tmp is NODE-wide
# — a run dir cannot be attributed to the runner that made it, so "is that runner
# busy" is the wrong question.
TMP_KEEP_MIN="${TMP_KEEP_MIN:-60}"
# A JIT slot's `_work/<repo>` tree untouched for this many days is stale — sized
# well past the fleet's dispatch cadence (every covered repo sees a tick inside
# a day), so a tree this old belongs to a repo that has gone dormant on this
# slot, not one waiting on its next job. claw-4's brave-quartet (11 GB, last
# touched 09-24, 12 days before this was measured) is the case this catches.
WORK_STALE_DAYS="${WORK_STALE_DAYS:-7}"
# The backstop sweep (`sweep_unclassified`) removes an entry no rule above
# names only once it is this old. A day, not TMP_KEEP_MIN: these are files
# nobody has classified, so the margin is deliberately wide.
UNKNOWN_KEEP_MIN="${UNKNOWN_KEEP_MIN:-1440}"
# THE NODE-SIDE FLEET DIRECTORY, spelled once — same name and reason as
# NODE_DIR in ci-throttle-install.sh: not an operator knob, just one spelling
# per file instead of two.
NODE_DIR="$HOME/.hadoku"
# Where a slot's JIT tree lives (src/runners/ephemeral.ts: `~/.hadoku/jit/slot<N>`).
JIT_ROOT="${JIT_ROOT:-$NODE_DIR/jit}"
# Disk TMPDIR / NODE_COMPILE_CACHE lane B's runners now write to. Preferred
# source is the rendered `runner.env` (same file jit-provision.sh merges into
# every slot's `.env`); these defaults match what wave 4b settled on when it
# is absent — never the real `/tmp`.
RUNNER_ENV_FILE="${RUNNER_ENV_FILE:-$NODE_DIR/runner.env}"
# The tmpfs root this node's runners see as `/tmp`. NO DEFAULT: the caller
# names it (clean-runner-debris.mjs passes it on every run), and when it is
# absent every tmpfs sweep is skipped. It used to default to `/tmp`, and that
# made a test that fenced only HOME a test that swept the real /tmp of
# whatever box ran it. On 2026-10-10 orphan-removal.test.mjs did exactly that
# on hokon, under APPLY=1, the first time a sweep existed that its
# TMP_KEEP_MIN escape hatch did not cover, and removed about 90 of the
# operator's own /tmp entries before it was killed. A default that points at
# shared state turns every forgotten variable into an incident.
TMPFS_ROOT="${TMPFS_ROOT:-}"
TMPDIR_DISK="${TMPDIR_DISK:-}"
NODE_COMPILE_CACHE_DISK="${NODE_COMPILE_CACHE_DISK:-}"
if [ -z "$TMPDIR_DISK" ] || [ -z "$NODE_COMPILE_CACHE_DISK" ]; then
	if [ -r "$RUNNER_ENV_FILE" ]; then
		[ -z "$TMPDIR_DISK" ] && TMPDIR_DISK=$(sed -n 's/^TMPDIR=//p' "$RUNNER_ENV_FILE" | tail -1)
		[ -z "$NODE_COMPILE_CACHE_DISK" ] &&
			NODE_COMPILE_CACHE_DISK=$(sed -n 's/^NODE_COMPILE_CACHE=//p' "$RUNNER_ENV_FILE" | tail -1)
	fi
fi
[ -z "$TMPDIR_DISK" ] && TMPDIR_DISK="$HOME/runner-tmp"
[ -z "$NODE_COMPILE_CACHE_DISK" ] && NODE_COMPILE_CACHE_DISK="$HOME/.cache/node-compile-cache"

case "$DIAG_KEEP_DAYS" in '' | *[!0-9]*) DIAG_KEEP_DAYS=14 ;; esac
case "$TMP_KEEP_MIN" in '' | *[!0-9]*) TMP_KEEP_MIN=60 ;; esac
case "$WORK_STALE_DAYS" in '' | *[!0-9]*) WORK_STALE_DAYS=7 ;; esac
case "$UNKNOWN_KEEP_MIN" in '' | *[!0-9]*) UNKNOWN_KEEP_MIN=1440 ;; esac
case "$MAX_CONCURRENT_NODE" in '' | *[!0-9]*) MAX_CONCURRENT_NODE='' ;; esac

kb_stale=0
kb_update=0
kb_orphan=0
kb_diag=0
kb_tmpfs=0
kb_slot=0
kb_work=0
kb_venv=0
kb_unclassified=0
tmpfs_used_kb=0
skipped_busy=0
removed=0

# Any Runner.Worker alive ANYWHERE on this node — the question the tmpfs/disk
# debris passes below need, since /tmp and the disk tmp dirs are NODE-wide, not
# attributable to one runner. Safe as `-x` (comm match) rather than needing the
# `[R]unner.Worker` bracket trick: `-x` matches only the process's own name, not
# a substring of ITS OWN command line, so this script (named
# clean-runner-debris.sh / clean-runner-debris.mjs, never "Runner.Worker") can
# never self-match the way a `pgrep -f 'Runner.Worker'` invoked AS a worker's
# own hook could.
worker_pids=$(pgrep -x Runner.Worker 2>/dev/null)
if [ -n "$worker_pids" ]; then any_worker_live=1; else any_worker_live=0; fi

# Runner dirs with a live worker. Resolved from the process tree: a runner's
# `busy` flag in the GitHub API is per-registration and lags reality.
busy_dirs=""
for w in $worker_pids; do
	pp=$(awk '{print $4}' "/proc/$w/stat" 2>/dev/null) || continue
	cl=$(tr '\0' ' ' <"/proc/$pp/cmdline" 2>/dev/null) || continue
	for tok in $cl; do
		case "$tok" in
		*/bin/Runner.Listener) busy_dirs="$busy_dirs ${tok%/bin/Runner.Listener}" ;;
		esac
	done
done

# Dirs with a live Runner.Listener — a MINTED JIT slot waiting for its job, or
# an idle WARM listener, has no Runner.Worker yet busy_dirs alone would call
# it dead. Same argv-token precedent as ci-throttle-install.sh's runner_dirs()
# (scripts/ci-throttle-install.sh:~330-365): match `*/bin/Runner.Listener`
# directly off the process's own cmdline, since the listener IS the process
# (no parent hop needed, unlike the worker case above).
listener_pids=$(pgrep -x Runner.Listener 2>/dev/null)
listener_dirs=""
for lp in $listener_pids; do
	cl=$(tr '\0' ' ' <"/proc/$lp/cmdline" 2>/dev/null) || continue
	for tok in $cl; do
		case "$tok" in
		*/bin/Runner.Listener) listener_dirs="$listener_dirs ${tok%/bin/Runner.Listener}" ;;
		esac
	done
done

# in_use PATH — true (shell 0) when PATH is still being used by a live job:
# ANY file or directory anywhere inside it (not just the top level — a
# playwright-transform-cache or a pytest basetemp is written DEEP inside for
# a whole run) changed within TMP_KEEP_MIN minutes, or a process holds a file
# under it open. The open-file check uses `lsof +D` (falling back to `fuser`)
# when one is installed; tests stub both. The claws DO have lsof (2026-10-10,
# though this comment said otherwise for a month), and `lsof +D` scans every
# process on the box, so it is fine here, on the handful of named debris
# dirs, and ruinous per entry: see open_tops() for the bulk passes.
in_use() {
	d="$1"
	[ -n "$(find "$d" -mmin "-$TMP_KEEP_MIN" -print -quit 2>/dev/null)" ] && return 0
	if command -v lsof >/dev/null 2>&1; then
		[ -n "$(lsof +D "$d" 2>/dev/null)" ] && return 0
	elif command -v fuser >/dev/null 2>&1; then
		fuser -s "$d" >/dev/null 2>&1 && return 0
	fi
	return 1
}

# open_tops ROOT — fill OPEN_TOP with every direct child of ROOT that holds an
# open file (anything under it: a file descriptor, a mapped library, a cwd),
# from ONE lsof call. Per-entry `lsof +D` cost 313 of a 320 s dry run on
# claw-6 (10,454 calls); one call is about 0.1 s. Without lsof, OPEN_TOP stays
# empty and the age rule alone decides, as it always did on such a node.
declare -A OPEN_TOP=()
open_tops() {
	OPEN_TOP=()
	command -v lsof >/dev/null 2>&1 || return 0
	local line rel
	while IFS= read -r line; do
		case "$line" in
		n"$1"/*)
			rel="${line#n"$1"/}"
			OPEN_TOP[${rel%%/*}]=1
			;;
		esac
	done < <(lsof -u "$(id -u)" -Fn 2>/dev/null)
}

# is_safe_compile_cache_dir PATH — guards a WHOLE-directory rm -rf sourced
# from runner.env (operator-writable, never trust it blind): absolute, not
# `/`, not `$HOME`, and its basename is exactly `node-compile-cache`.
is_safe_compile_cache_dir() {
	case "$1" in /*) ;; *) return 1 ;; esac
	[ "$1" = "/" ] && return 1
	[ "$1" = "$HOME" ] && return 1
	[ "$(basename "$1")" = "node-compile-cache" ] || return 1
	return 0
}

# is_safe_disk_dir PATH — same family of guard for TMPDIR_DISK, which this
# script sweeps INSIDE (not whole): absolute, not `/`, not `$HOME`.
is_safe_disk_dir() {
	case "$1" in /*) ;; *) return 1 ;; esac
	[ "$1" = "/" ] && return 1
	[ "$1" = "$HOME" ] && return 1
	return 0
}

drop() { # path kind
	sz=$(du -sk "$1" 2>/dev/null | cut -f1) || return 0
	case "$2" in
	stale) kb_stale=$((kb_stale + sz)) ;;
	update) kb_update=$((kb_update + sz)) ;;
	orphan) kb_orphan=$((kb_orphan + sz)) ;;
	slot) kb_slot=$((kb_slot + sz)) ;;
	work) kb_work=$((kb_work + sz)) ;;
	venv) kb_venv=$((kb_venv + sz)) ;;
	esac
	if [ "$APPLY" = 1 ]; then
		rm -rf -- "$1" && removed=$((removed + 1)) && echo "REMOVED ${1#"$HOME"/}"
	else
		echo "WOULD-REMOVE ${1#"$HOME"/} ($((sz / 1024))M)"
	fi
}

# sweep_broken_venvs RUNNER_DIR — drop every virtualenv under its `_work`
# whose interpreter is gone (#127). A venv's bin/python is a SYMLINK to the
# interpreter that built it; when a tool-cache refresh replaces that Python, the
# link dangles, the venv can never run again, and a workflow that reuses the
# checkout (`[ -d .venv ] || python3 -m venv .venv`) fails on the old one —
# hadoku-registry's drift-check on hokon, 2026-10-17. Identified by
# `pyvenv.cfg`, which only a venv carries, at the depth a checkout puts one
# (`_work/<repo>/<repo>/.venv`). A venv built with --copies has a real file,
# not a link, and is never a candidate. Callers have already ruled out a busy
# runner.
sweep_broken_venvs() {
	[ -d "$1/_work" ] || return 0
	local cfg v py
	while IFS= read -r cfg; do
		v=$(dirname "$cfg")
		py="$v/bin/python"
		[ -L "$py" ] || py="$v/bin/python3"
		[ -L "$py" ] && [ ! -e "$py" ] || continue
		echo "BROKEN-VENV ${v#"$HOME"/} -> $(readlink "$py")"
		drop "$v" venv
	done < <(find "$1/_work" -mindepth 2 -maxdepth 4 -name pyvenv.cfg -type f 2>/dev/null)
}

# $HOME/actions-runner (no suffix) is deliberate, not redundant with the glob
# above: register-fleet-runner.sh installs the SYSTEM runner there, so on every
# claw that is where hadoku_site's own claw-N runner lives. The glob only
# matches the reconciler's `actions-runner-<repo>` installs, so this directory
# was never cleaned and held a full stale toolchain (674MB per claw, ~2GB
# fleet-wide) that grew by that much on every runner version bump.
for d in "$HOME"/runners/actions-runner-* "$HOME"/actions-runner-* "$HOME/actions-runner" "$HOME/repos/hadoku_site/actions-runner"; do
	[ -d "$d" ] || continue

	# AN INTERRUPTED REMOVAL, swept whole.
	#
	# `.removing` is written by reconcile-fleet-runners' removeScript BEFORE the
	# deregistration that deletes `.runner`. So this exact pair - marker present,
	# .runner absent - can only mean the removal reached GitHub and died before
	# its `rm -rf`. The registration is already gone, so the reconciler will
	# never look at this tree again and nothing else can attribute it.
	#
	# Measured on claw-1, 2026-09-01: three such directories holding 3.1 GB
	# (printtool, oss-issue-aggregator, vibedispatch - all three long gone from
	# the roster), while this script reported stale=0.00 GB standing right next
	# to them. The `.runner` guard below is why: it skipped every directory whose
	# defining feature is that .runner is missing.
	#
	# BOTH conditions, never the missing .runner alone. A directory mid-CONFIG
	# also has no .runner, and claw-5 sat in precisely that state for hours while
	# it was being provisioned on 2026-09-01. Sweeping on the absence by itself
	# would delete an install somebody was in the middle of creating.
	if [ -f "$d/.removing" ] && [ ! -f "$d/.runner" ]; then
		case " $busy_dirs " in
		*" $d "*)
			skipped_busy=$((skipped_busy + 1))
			echo "SKIP-BUSY ${d#"$HOME"/}"
			continue
			;;
		esac
		drop "$d" orphan
		continue
	fi

	[ -f "$d/.runner" ] || continue

	case " $busy_dirs " in
	*" $d "*)
		skipped_busy=$((skipped_busy + 1))
		echo "SKIP-BUSY ${d#"$HOME"/}"
		continue
		;;
	esac

	# Live version from the symlink, never inferred.
	cur_bin=$(basename "$(readlink -f "$d/bin" 2>/dev/null)" 2>/dev/null)
	cur_ext=$(basename "$(readlink -f "$d/externals" 2>/dev/null)" 2>/dev/null)
	# A runner with no resolvable symlink is one we do not understand. Leave it.
	if [ -z "$cur_bin" ] || [ -z "$cur_ext" ] || [ "$cur_bin" = "." ] || [ "$cur_ext" = "." ]; then
		echo "SKIP-UNRESOLVED ${d#"$HOME"/}"
		continue
	fi

	for p in "$d"/bin.* "$d"/externals.*; do
		[ -d "$p" ] || continue
		b=$(basename "$p")
		[ "$b" = "$cur_bin" ] && continue
		[ "$b" = "$cur_ext" ] && continue
		drop "$p" stale
	done

	[ -d "$d/_work/_update" ] && drop "$d/_work/_update" update
	sweep_broken_venvs "$d"

	if [ -d "$d/_diag" ]; then
		sz=$(find "$d/_diag" -name '*.log' -mtime "+$DIAG_KEEP_DAYS" -printf '%k\n' 2>/dev/null |
			awk '{s+=$1} END {print s+0}')
		kb_diag=$((kb_diag + sz))
		if [ "$APPLY" = 1 ] && [ "$sz" -gt 0 ]; then
			find "$d/_diag" -name '*.log' -mtime "+$DIAG_KEEP_DAYS" -delete 2>/dev/null
		fi
	fi
done

# --- JIT slots beyond maxConcurrent, and stale _work trees ----------------
#
# `slot<N>` is created by jit-provision.sh and lives at $JIT_ROOT/slot<N>
# (src/runners/ephemeral.ts). A slot numbered >= the node's declared
# maxConcurrent cannot ever be minted into by the dispatcher (it never asks
# for an index that high), so a directory there is pure leftover — claw-4's
# `slot9` on a `maxConcurrent: 3` node.
#
# MAX_CONCURRENT_NODE UNKNOWN MEANS SKIP, NOT "DELETE EVERYTHING ABOVE 0" — the
# ceiling lives on the controller's manifest, not on this node, and "could not
# look" must never render as "nothing to keep" (CLAUDE.md).
if [ -n "$MAX_CONCURRENT_NODE" ] && [ -d "$JIT_ROOT" ]; then
	for sd in "$JIT_ROOT"/slot*; do
		[ -d "$sd" ] || continue
		sbase=$(basename "$sd")
		idx="${sbase#slot}"
		case "$idx" in '' | *[!0-9]*) continue ;; esac

		# live if EITHER a Runner.Worker is busy under this slot OR a
		# Runner.Listener is parked on it (minted-but-idle JIT, or a warm
		# listener if one ever lands under JIT_ROOT) — a listener with no
		# job yet is not dead, it is waiting.
		live=0
		for bd in $busy_dirs $listener_dirs; do
			case "$bd" in "$sd" | "$sd"/*) live=1 ;; esac
		done
		if [ "$live" = 1 ]; then
			echo "SKIP-BUSY jit/$sbase"
			continue
		fi

		if [ "$idx" -ge "$MAX_CONCURRENT_NODE" ]; then
			drop "$sd" slot
			continue
		fi

		# In-range and idle: still prune a `_work/<repo>` tree this slot has not
		# touched in WORK_STALE_DAYS. Staleness is "nothing at depth <=3 under
		# this tree changed recently" — NOT the top dir's own mtime, which is its
		# CREATION time and only moves when an entry is added/removed directly
		# under it; depth 3 reaches `<repo>/<repo>/.git`, whose mtime moves on
		# every checkout, so an actively-used tree is correctly seen as fresh.
		# Non-repo entries (_actions, _temp, _tool, _update, _PipelineMapping —
		# anything GitHub's runner itself names with a leading underscore) are
		# skipped by name: only repo trees are staleness candidates here.
		[ -d "$sd/_work" ] || continue
		sweep_broken_venvs "$sd"
		for wd in "$sd"/_work/*; do
			[ -d "$wd" ] || continue
			wdbase=$(basename "$wd")
			case "$wdbase" in _*) continue ;; esac
			[ -n "$(find "$wd" -maxdepth 3 -mtime "-$WORK_STALE_DAYS" -print -quit 2>/dev/null)" ] && continue
			drop "$wd" work
		done
	done
fi

# --- declared tool caches: report SIZE, and only if actually present -------
#
# The auditor decides WHICH caches are abandoned (ownership, not age — see
# tool-caches.mjs); this only answers "is it here and how big". Splitting it that
# way is what stops the report naming a cache that was already deleted: the first
# version reported claw-3's ~/.cache/trunk from ownership alone and kept doing it
# after the directory was gone, with no size attached to act on.
for c in ${CACHE_PATHS:-}; do
	cp="${c#\~/}"
	cp="$HOME/$cp"
	[ -d "$cp" ] || continue
	csz=$(du -sk "$cp" 2>/dev/null | cut -f1) || continue
	echo "CACHE-PRESENT $c $csz"
done

# --- tmpfs /tmp: debris that costs RAM, not disk --------------------------
# This script was written for DISK, and everything above it reclaims disk. But
# `/tmp` is a tmpfs on every claw — systemd sizes it at 50% of RAM — so a file
# left there is resident memory that only swap can relieve, and it is charged as
# `shmem` to the cgroup of whichever runner created it.
#
# Measured 2026-08-26, with no job running: claw-2 held 2.1 GB of
# /tmp/pytest-of-hadoku on a 7.7 GB box (27% of RAM), claw-1 2.6 GB of 11.6 GB.
# claw-2's 27 idle runner units held 428 MB of anon between them, so the pytest
# leftovers were FIVE TIMES the idle-registration cost that P3 is about — and
# nothing was watching, because `minFreeGb` asserts DISK and this node's disk
# was fine.
#
# pytest keeps its last three basetemps by design. That policy is a debugging
# convenience sized for a laptop, not for a shared 7.7 GB CI box.
if [ -n "$TMPFS_ROOT" ] && [ "$(findmnt -no FSTYPE "$TMPFS_ROOT" 2>/dev/null)" = tmpfs ]; then
	tmpfs_used_kb=$(df -Pk "$TMPFS_ROOT" | tail -1 | awk '{print $3}')
fi

# sweep_pytest ROOT — ROOT may be tmpfs (TMPFS_ROOT) or lane B's disk
# TMPDIR; the basetemp rule is identical either way, so one implementation
# covers both.
sweep_pytest() {
	root="$1"
	for base in "$root"/pytest-of-*; do
		[ -d "$base" ] || continue
		# `pytest-current` is a SYMLINK. Resolve it and confirm the target is
		# actually inside this base before treating it as "keep" or as a
		# deletion candidate — a symlink pointing OUTSIDE the root must never be
		# followed either way. `case` against the resolved base, not a prefix of
		# the unresolved one, so a base that is itself a symlink cannot be
		# escaped by a `../` target.
		rbase=$(readlink -f "$base" 2>/dev/null) || continue
		keep=$(readlink -f "$base/pytest-current" 2>/dev/null || true)
		case "$keep" in "$rbase"/*) ;; *) keep="" ;; esac
		for d in "$base"/pytest-*; do
			[ -d "$d" ] || continue
			rd=$(readlink -f "$d" 2>/dev/null) || continue
			case "$rd" in "$rbase"/*) ;; *) continue ;; esac # never escape root
			if [ "$d" = "$base/pytest-current" ]; then
				# The symlink itself. Removed only when no worker is live
				# anywhere on the node — /tmp is node-wide, so "idle" cannot
				# mean "this one runner is idle". A live worker means SOME job
				# could still be using the run pytest-current points at. A hand
				# -run pytest on an otherwise-idle node is still a user, so the
				# in_use helper (deep mtime / open-file check) gates it too.
				[ "$any_worker_live" = 0 ] || continue
				[ -n "$keep" ] && in_use "$keep" && continue
				sz=$(du -sk "$keep" 2>/dev/null | awk '{print $1+0}')
				kb_tmpfs=$((kb_tmpfs + sz))
				if [ "$APPLY" = 1 ]; then
					rm -f "$d" 2>/dev/null
					[ -n "$keep" ] && rm -rf "$keep" 2>/dev/null
					removed=$((removed + 1))
				fi
				continue
			fi
			[ -n "$keep" ] && [ "$rd" = "$keep" ] && continue
			# in_use checks the WHOLE tree, not just the top dir: a basetemp
			# is written deep inside for an entire run, so a top-level-only
			# mtime check would see it as old the moment it is created.
			in_use "$d" && continue
			sz=$(du -sk "$d" 2>/dev/null | awk '{print $1+0}')
			kb_tmpfs=$((kb_tmpfs + sz))
			if [ "$APPLY" = 1 ]; then
				rm -rf "$d" 2>/dev/null && removed=$((removed + 1))
			fi
		done
	done
}

# sweep_glob ROOT PATTERN — age-only debris named per-run, so a live job's own
# directory is always younger than TMP_KEEP_MIN and is never a candidate.
#
# PLAIN FILES TAKE ONE `find`, not a fork per file. `liblz4-java-*` arrived as
# ~24,000 files per claw (2026-10-10), and an `in_use` + `du` per file is two
# forks each. A file has no "deep" contents, so its own mtime is the whole
# freshness test, and the open-file check is one lsof for the whole root
# (open_tops), never one per file.
sweep_glob() {
	root="$1" pat="$2"
	open_tops "$root"
	while IFS= read -r -d '' rec; do
		f="${rec#* }"
		[ -n "${OPEN_TOP[${f##*/}]+x}" ] && continue
		kb_tmpfs=$((kb_tmpfs + ${rec%% *}))
		if [ "$APPLY" = 1 ]; then
			rm -f -- "$f" 2>/dev/null && removed=$((removed + 1))
		fi
	done < <(find "$root" -mindepth 1 -maxdepth 1 -name "$pat" -type f -mmin "+$TMP_KEEP_MIN" -printf '%k %p\0' 2>/dev/null)
	for d in "$root"/$pat; do
		[ -d "$d" ] && [ ! -L "$d" ] || continue
		in_use "$d" && continue
		sz=$(du -sk "$d" 2>/dev/null | awk '{print $1+0}')
		kb_tmpfs=$((kb_tmpfs + sz))
		if [ "$APPLY" = 1 ]; then
			rm -rf "$d" 2>/dev/null && removed=$((removed + 1))
		fi
	done
}

# sweep_unclassified ROOT — the backstop for debris no rule above names.
#
# WHY. Every rule above was written after its debris had already filled a
# tmpfs: pytest basetemps, the compile cache, playwright caches, and on
# 2026-10-10 Forge's `liblz4-java-*.so`, about 7 GB across claw-4, claw-8 and
# claw-9 that this script could not see because nobody had named it. A list of
# known names is always one incident behind. This pass removes anything that
#   - is a direct child of ROOT owned by this user,
#   - is a regular file or a real directory (never a socket, fifo or symlink),
#   - is not on the KEEP list below,
#   - and has nothing inside it newer than UNKNOWN_KEEP_MIN (a day).
# It also reports what it found, grouped by name with digit and hex runs
# folded (`UNCLASSIFIED liblz4-java-*.so n=… kb=…`), so a new class shows up
# in the nightly log on its first day and can be given a rule of its own.
#
# KEEP: session sockets and service dirs, which a login or a daemon owns, and
# the compile cache and pytest bases, which the passes above handle under
# their own rules.
sweep_unclassified() {
	root="$1"
	# FORKS ARE THE COST, so everything per-entry is collected first and done in
	# one process afterwards: one `du` for every directory's size, one `sed` to
	# fold every name, one `xargs rm`. The first version forked sed, du and rm
	# per entry and took 4m16s for claw-6's 6,618 entries (2026-10-10), against
	# a 600 s per-node budget. Freshness is one walk and the open-file check one
	# lsof (open_tops), so nothing here forks per entry at all.
	local -a paths=() names=() kbs=() dirs=()
	# Which top-level entries hold ANYTHING written inside UNKNOWN_KEEP_MIN, in
	# one walk of the whole root. Asking each directory separately was a fork
	# per directory, about 4,000 of them in claw-6's runner-tmp.
	open_tops "$root"
	local -A fresh=()
	local top
	while IFS= read -r -d '' top; do
		fresh[${top%%/*}]=1
	done < <(find "$root" -mindepth 1 -mmin "-$UNKNOWN_KEEP_MIN" -printf '%P\0' 2>/dev/null)
	while IFS= read -r -d '' rec; do
		kind="${rec%% *}"
		rest="${rec#* }"
		kb="${rest%% *}"
		e="${rest#* }"
		name="${e##*/}"
		case "$name" in
		.X11-unix | .ICE-unix | .font-unix | .XIM-unix | .Test-unix | systemd-private-* | \
			ssh-* | tmux-* | snap-private-tmp | node-compile-cache | pytest-*)
			continue
			;;
		# Named debris belongs to sweep_glob's own rule. Under APPLY it is gone
		# before this pass runs; in a dry run it is still there, and counting it
		# here as well reported 1.73 GB of claw-8's liblz4 extracts twice.
		game-bundle-* | vault-resp.* | cardtable-e2e-web-* | playwright-transform-cache-* | liblz4-java-*)
			continue
			;;
		esac
		[ -n "${fresh[$name]+x}" ] && continue
		[ -n "${OPEN_TOP[$name]+x}" ] && continue
		paths+=("$e")
		# A newline or tab in a name would misalign the report's columns; the
		# name is only a label there, so it is flattened for the report alone.
		name="${name//$'\n'/?}"
		names+=("${name//$'\t'/?}")
		if [ "$kind" = d ]; then
			kbs+=(0)
			dirs+=("$e")
		else
			kbs+=("$kb")
		fi
	done < <(find "$root" -mindepth 1 -maxdepth 1 -user "$(id -u)" \( -type f -o -type d \) \
		-mmin "+$UNKNOWN_KEEP_MIN" -printf '%y %k %p\0' 2>/dev/null)
	[ "${#paths[@]}" -gt 0 ] || return 0

	if [ "${#dirs[@]}" -gt 0 ]; then
		local -A dkb=()
		while IFS=$'\t' read -r k p; do
			dkb[$p]=$k
		done < <(printf '%s\0' "${dirs[@]}" | xargs -0 du -sk -- 2>/dev/null)
		local i
		for i in "${!paths[@]}"; do
			[ -n "${dkb[${paths[$i]}]+x}" ] && kbs[i]=${dkb[${paths[$i]}]}
		done
	fi
	local k
	for k in "${kbs[@]}"; do kb_unclassified=$((kb_unclassified + k)); done

	# The ten largest classes. A node that has never been swept holds thousands
	# of classes, and the nightly log is read by a person. Folded: hex runs,
	# mktemp/mkstemp suffixes and digits are what varies per run.
	paste <(printf '%s\n' "${names[@]}" |
		sed -E 's/[0-9a-fA-F]{6,}/*/g; s|^tmp[A-Za-z0-9_]{6,}|tmp*|; s/([-._])[A-Za-z0-9]{6,}$/\1*/; s/([-._])[A-Za-z0-9]{6,}([-._])/\1*\2/g; s/[0-9]+/*/g; s/\*+/*/g') \
		<(printf '%s\n' "${kbs[@]}") |
		awk -F'\t' '{ n[$1]++; kb[$1] += $2 } END { for (c in n) printf "%d\t%d\t%s\n", kb[c], n[c], c }' |
		sort -rn | head -10 | while IFS=$'\t' read -r kb n key; do
		echo "UNCLASSIFIED root=$root class=$key n=$n kb=$kb"
	done

	if [ "$APPLY" = 1 ]; then
		printf '%s\0' "${paths[@]}" | xargs -0 rm -rf -- 2>/dev/null
		# Counted from what is actually gone, with the builtin test, not from
		# what was asked for.
		local p
		for p in "${paths[@]}"; do
			[ -e "$p" ] || [ -L "$p" ] || removed=$((removed + 1))
		done
	fi
}

# sweep_compile_cache DIR — a compile cache is one opaque hash-keyed blob, not
# individually-ageable entries, so it is reclaimed WHOLE and only when no
# worker is live anywhere on the node (any concurrent job could still be
# reading it) — never partially, which could hand a live job a half-deleted
# cache.
sweep_compile_cache() {
	dir="$1"
	[ -d "$dir" ] || return 0
	[ "$any_worker_live" = 0 ] || return 0
	# A hand-run build on an otherwise-idle node is still a user of the cache.
	in_use "$dir" && return 0
	sz=$(du -sk "$dir" 2>/dev/null | awk '{print $1+0}')
	kb_tmpfs=$((kb_tmpfs + sz))
	if [ "$APPLY" = 1 ]; then
		rm -rf "$dir" 2>/dev/null && removed=$((removed + 1))
	fi
}

[ -n "$TMPFS_ROOT" ] || echo "SKIP-TMPFS TMPFS_ROOT not given; the tmpfs is not swept"
for TMP_ROOT in "$TMPFS_ROOT" "$TMPDIR_DISK"; do
	[ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ] || continue
	# TMPDIR_DISK is read from runner.env (operator-writable); TMPFS_ROOT is
	# the caller's, trusted the way HOME is.
	if [ "$TMP_ROOT" = "$TMPDIR_DISK" ] && ! is_safe_disk_dir "$TMP_ROOT"; then
		echo "SKIP-UNSAFE $TMP_ROOT"
		continue
	fi
	sweep_pytest "$TMP_ROOT"
	sweep_glob "$TMP_ROOT" 'game-bundle-*'
	sweep_glob "$TMP_ROOT" 'vault-resp.*'
	sweep_glob "$TMP_ROOT" 'cardtable-e2e-web-*'
	sweep_glob "$TMP_ROOT" 'playwright-transform-cache-*'
	sweep_glob "$TMP_ROOT" 'liblz4-java-*'
	sweep_unclassified "$TMP_ROOT"
done
[ -n "$TMPFS_ROOT" ] && sweep_compile_cache "$TMPFS_ROOT/node-compile-cache"
if is_safe_compile_cache_dir "$NODE_COMPILE_CACHE_DISK"; then
	sweep_compile_cache "$NODE_COMPILE_CACHE_DISK"
else
	echo "SKIP-UNSAFE $NODE_COMPILE_CACHE_DISK"
fi

free_kb=$(df -Pk "$HOME" | tail -1 | awk '{print $4}')
echo "SUMMARY host=$(hostname) stale_kb=$kb_stale update_kb=$kb_update orphan_kb=$kb_orphan diag_kb=$kb_diag tmpfs_kb=$kb_tmpfs tmpfs_used_kb=$tmpfs_used_kb slot_kb=$kb_slot work_kb=$kb_work venv_kb=$kb_venv unclassified_kb=$kb_unclassified removed=$removed busy_skipped=$skipped_busy free_kb=$free_kb"
