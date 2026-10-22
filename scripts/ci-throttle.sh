#!/usr/bin/env bash
# ci-throttle — the ACTIONS_RUNNER_HOOK_JOB_STARTED hook. Hold a job at the gate
# until the node can afford to run it.
#
# WHY THIS EXISTS
# ---------------
# On 2026-08-24 the 13:00 UTC fan-out dispatched 14 repos in 4 seconds. Eleven
# landed on claw-2 — which has the LEAST RAM in the fleet (7G against claw-1's
# 11G and claw-3's 15G) — and the kernel OOM-killer reaped two of them. ~20GB
# sat free on the other two claws throughout.
#
# Nothing in the fleet caps concurrent jobs on a node, and nothing could:
#
#   - Registrations are per-repo, so N registered repos means N independent
#     listeners and therefore up to N simultaneous jobs. claw-2 carries 26.
#   - `maxRegistrations` bounds that N, but 26 is the bound where ~3 is safe.
#   - `maxConcurrent` bounds what the JIT dispatcher MINTS on a node; it does
#     not bound a STANDING registration, which GitHub assigns to directly.
#   - GitHub assigns arbitrarily among a repo's eligible runners and offers no
#     way to say "this node is full".
#
# The runner itself is the only place left that can say no, and the job-started
# hook is the only synchronous point in it. Per actions/runner ADR 1751: "These
# are synchronous hooks, so they will block job execution while they are being
# run", and "There will be no timeout option on launch" — so the wait is
# unbounded unless this script bounds it, and it must.
#
# WHAT IT DOES AND DOES NOT DO
# ----------------------------
# It delays a job's START on the node GitHub already chose, for up to
# MAX_WAIT_S. It cannot move a job elsewhere — that decision is made and gone
# by the time this runs. So for a job that gets a slot inside the wait, it
# spreads a burst over time rather than relieving it, which is exactly what
# stops a 7G box from having eleven Node builds resident at once. A job that
# does NOT get a slot inside the wait is REFUSED — see below.
#
# FAILS OPEN ON UNCERTAINTY, REFUSES ON A CONFIRMED BREACH. ADR 1751: "any
# other exit code will fail the job with an appropriate annotation." Every
# failure mode this hook cannot reason about — no config, unreadable /proc, bad
# arithmetic, an exempt workflow — falls through to "run the job now", because a
# throttle that turns a healthy build red over its OWN uncertainty is worse than
# the contention it exists to avoid.
#
# WHAT COUNTS AS LOAD: ADMITTED JOBS, NOT PROCESSES
# -------------------------------------------------
# `others()` used to be `pgrep -x Runner.Worker` minus this job's own worker.
# Every job blocked in THIS script also has a Runner.Worker, because the hook
# runs inside it — so a burst counted itself. Four jobs arriving together on
# hokon each saw the other three plus the real load, `4 < 4` was false for all
# four, nobody was ever admitted, and all four were refused at the 90s ceiling
# with 26GB free and a real load of one. It recurred on 2026-09-17, -18 and -19
# (pygmalion, resume-bot, study, task). Memory was never the constraint: a
# waiter is not load, it is a job WAITING to become load, and counting it makes
# the gate strictly harder to pass the more jobs are waiting at it — a gate
# that gets harder the worse the pile-up is cannot drain one.
#
# So a job counts only once it has been ADMITTED, and it says so itself: on
# admission it writes `$HOME/.hadoku/throttle/admitted/<pid>.<starttime>`, where
# <pid> is its Runner.Worker and <starttime> is field 22 of that pid's
# /proc/<pid>/stat. `others()` counts the markers whose pid is STILL THAT
# PROCESS.
#
#   - THE MARKER IS NEVER DELETED BY A COMPLETION HOOK. The runner's
#     ACTIONS_RUNNER_HOOK_JOB_COMPLETED slot is already taken by
#     job-metrics.sh, and there is exactly one of those slots — so a second
#     owner for it does not exist to be written. The marker is instead
#     SELF-REAPING: the Runner.Worker it names IS the job, so when the job ends
#     the pid ends with it, the marker stops counting the moment that happens,
#     and the next hook run unlinks it on sight. A marker that is never removed
#     is therefore not a leak that inflates the count; it is a dead file worth
#     nothing that the next pass deletes.
#   - LIVENESS, NEVER AGE. Nothing here expires a marker on a clock. A job that
#     legitimately runs for two hours must keep its slot for two hours, and an
#     age cut-off would hand its slot away while it was still using it. The
#     starttime is carried because a pid alone is reusable: a recycled pid with
#     a different start time is a DIFFERENT process and the marker is stale. A
#     zombie is stale too — it answers /proc with the starttime it always had
#     and runs nothing.
#   - THE COUNT AND THE CLAIM ARE ONE ATOMIC STEP, under flock. Without it the
#     four waiters above would all read "under the limit" in the same instant
#     and all admit, which is the pile-up this file exists to prevent, arrived
#     at from the other side.
#   - THIS ONLY SEES JOBS THAT RAN THIS HOOK. A JIT slot is deliberately not
#     hook-throttled (its concurrency is the dispatcher's, and systemd-run gives
#     it MemoryMax directly), so its jobs hold no marker and are not counted
#     here. MIN_FREE_MB is what still sees them: it reads the kernel, which
#     counts every job on the box however it was started.
#
# The one path that does NOT fail open: a job that waited the full MAX_WAIT_S
# and the node is STILL over its declared limit when the wait ends.
# MAX_WAIT_S=90 used to admit there too ("spreads a burst, cannot cap one" —
# true only for a burst that clears in time), and that is exactly what let four
# concurrent jobs pile onto claw-1's `maxConcurrent: 3` on 2026-09-01 and thrash
# vitest's worker fork into a 3m21s stall
# (docs/planning/jit-rollout-retro-2026-09-01.md), the same shape that
# OOM-killed two jobs on claw-2 on 2026-08-24. A cap that always eventually
# admits is not a cap. So that exit is deliberately non-zero — the one finding
# in this file confident enough (the node stayed over the line for the whole
# wait, not a guess) to fail a job over.
#
# TWO REFUSALS, NOT ONE: CONTENTION AND PLACEMENT (#67)
# -----------------------------------------------------
# That one non-zero exit answers two different questions, and until 2026-09-28
# it gave both the same answer. On 2026-09-26 21:18 hokon refused
# `hadoku-tenhands / Task automation` with:
#
#   ci-throttle: refused on hokon after 91s — 0 concurrent job(s), 7120MB
#   available (limit 4 job(s) / 8192MB free). Re-run once the node has a free
#   slot.
#
# ZERO concurrent jobs. The slot it told the operator to wait for was already
# free — all four of them were — and the ~1GB it was short of the floor was held
# by hokon's own resident load, which no job of this fleet's is ever going to
# hand back. So the advice could not be acted on and re-running refused again,
# deterministically, for as long as the box stayed as it was.
#
# At zero admitted jobs a memory floor is not protecting a running job from a
# new one. It is asserting the node is too small for this job, and that is a
# PLACEMENT statement, not a throttling one. The hook cannot act on it — the
# node was chosen before this ran and ADR 1751 gives it no way to hand the job
# back (see WHAT IT DOES AND DOES NOT DO) — so the one thing it can do is say
# which of the two findings it has, and give advice that matches.
#
#   CONTENTION  this gate saw another admitted job during the wait. Something
#               will finish; "re-run once the node has a free slot" is true.
#   PLACEMENT   it never saw one. There is no slot to wait for, so waiting is
#               not the fix and the message must not ask for it.
#
# The discriminator is PEAK_OTHERS over the whole wait, not the final sample,
# and not "which test failed" — a memory floor breached with two of four slots
# in use is genuinely contention, and a `maxConcurrent: 0` node is genuinely
# unable, so the failing test does not decide it on its own.
#
# The wait is still the FULL MAX_WAIT_S on the placement path, deliberately. One
# sample cannot tell a resident baseline from a JIT job finishing in 30s — a JIT
# slot holds memory and no marker, so it is invisible to PEAK_OTHERS and only
# MemAvailable moving over time shows it at all. The wait is the second look
# that earns the word "cannot".
#
# A THIRD FINDING, STATIC: KNOWN NEED VS THIS UNIT'S CAP (#76's hokon half)
# --------------------------------------------------------------------------
# In an outage the backstop promotes hokon onto `hadoku-builder`, and GitHub
# then assigns jobs to it directly — `admitMint` (the JIT admission path) never
# sees them, so this hook is the ONLY gate hokon's standing registrations pass
# through. Everything above answers "is this node busy right now"; this answers
# a different, STATIC question that does not need a wait at all: does GitHub's
# own PAST measurement of what this repo's jobs need already exceed what this
# runner UNIT is cgroup-capped to ever hold, however idle the node is this
# instant?
#
# REACHABLE WITHOUT A NEW DATA PATH, on both sides:
#   - THE NEED. `reconcile-fleet-runners.mjs --write-coverage` already writes
#     `facets[<owner>/<repo>].jobP95Mb.mb` to fleet-runner-coverage.json, the
#     same file `admitMint` reads in-process. On hokon that file already lives
#     on the SAME box this hook runs on. This hook does not go looking for it
#     itself, though — `RESERVE_FILE` below carries no hardcoded guess at
#     where (that was tried, and was both a worse resolver than the one that
#     already exists and an ecosystem literal baked into a node hook; see
#     `RESERVE_FILE`'s own comment). `deploy-ci-throttle.mjs` resolves the
#     real path through `manifestDir()`/`FLEET_MANIFEST_DIR` — the one
#     resolver every other manifest path in this package already uses — and
#     writes it into THIS node's rendered conf, only when this is the node it
#     resolved it on. So this hook learns the path the same way it learns
#     MAX_CONCURRENT: from its own conf, deployer-rendered, nothing to invent.
#     `GITHUB_REPOSITORY` is already "owner/repo", the ledger's own key, with
#     no translation needed.
#   - THE CAP. `job-metrics.sh` (this package's completed-job hook) already
#     derives a job's cgroup from `/proc/self/cgroup`'s third field and reads
#     `memory.max` under `/sys/fs/cgroup` there — "the reader for a facet may
#     not read what the writer wrote" (CLAUDE.md) does not forbid reading the
#     SAME kernel fact a sibling hook already reads the same way; it forbids a
#     verifier reading its own writer's claim about that fact. This hook runs
#     inside the job's own unit (the standing runner's systemd service on
#     hokon, or a JIT slot's transient unit elsewhere), so its own
#     `memory.max` IS the per-unit cap. Measured 2026-10-02: every standing
#     runner unit on hokon reads exactly 4294967296 (4096 MiB) — Lane B's
#     finding, from the kernel, independently confirmed here.
#
# Both numbers are FACTS ABOUT THE PAST AND THE CGROUP, neither of which
# changes while this hook waits — so unlike the memory-floor finding above,
# there is nothing a wait could learn. This refuses IMMEDIATELY, before the
# admission loop, the same way the exemption check above short-circuits it.
# Absent either number — no reserve on file for this repo, no readable
# `memory.max`, no `jq` on this node — this says nothing and falls through to
# the ordinary wait, which is the same fail-open direction as everything else
# here: "I could not look" must refuse to BUILD a finding, not invent one.
set -u

# $HOME, not a hardcoded /home/hadoku. The hook runs AS the runner's user, and
# /home/hadoku is mode 0700 — so a runner owned by any other user (the retired
# `-b` pool ran as openclaw, and runner-toolcache.sh still branches on it) could
# not read the config at all. It would then fall through to the permissive
# defaults below: MAX_CONCURRENT=99 and MIN_FREE_MB=0, i.e. NO LIMIT, silently —
# an unreadable config is uncertainty, and this hook only ever refuses a job on
# a CONFIRMED breach of an intentional limit, never on not knowing what the
# limit is. That is the exact state that OOM-killed two jobs on claw-2 on
# 2026-08-24, and check:throttle would have called the node wired throughout —
# it audited the .env line, not whether the config could be loaded.
CONF="${CI_THROTTLE_CONF:-$HOME/.hadoku/ci-throttle.conf}"
# Where free_mb() reads MemAvailable. Overridable for the same reason CONF is:
# ci-throttle.test.mjs (P3.4) drives the REAL script rather than a rewrite of
# its arithmetic, and a fixture file is the only way to hand it a MemAvailable
# without a kernel underneath it. No legitimate deploy ever sets this.
MEMINFO="${CI_THROTTLE_MEMINFO:-/proc/meminfo}"

# #76's hokon half. The admission ledger `reconcile-fleet-runners.mjs
# --write-coverage` already writes and `admitMint` already reads — same file,
# second reader, not a new path.
#
# NO HARDCODED FALLBACK HERE, DELIBERATELY. An earlier version of this
# defaulted to `$HOME/srv/hadoku_site/scripts/admin/fleet-runner-coverage.json`
# — a guess, baked into a node hook, at a path only `deploy-ci-throttle.mjs`'s
# `resolveReserveFile()` actually knows how to resolve (through `manifestDir()`
# / `FLEET_MANIFEST_DIR`, per CLAUDE.md's manifest rule: never a hardcoded
# tree). It was also, independently, an ECOSYSTEM LITERAL
# (`ecosystem-literals.test.mjs`) — this file spelling out this garage's
# deploy-tree layout is exactly the thing that gate exists to stop growing.
# `deploy-ci-throttle.mjs` now resolves the path on the DEPLOYING box and
# writes it into THIS node's rendered `ci-throttle.conf` as `RESERVE_FILE=…`
# — but only when this IS that box (`isLocalNode`; see that script for why a
# remote node must never get a path resolved on someone else's filesystem).
# No line in the conf is the same "I don't know" every other gap here falls
# open on: `reserve_mb()` below already treats an empty/unreadable
# `RESERVE_FILE` as "say nothing", so an undeployed or remote node simply
# never runs this check, exactly as before #76 existed.
RESERVE_FILE="${CI_THROTTLE_RESERVE_FILE:-}"
# Where unit_cap_mb() reads this job's cgroup memory.max. Unset by default —
# production always derives the path from /proc/self/cgroup, because the cap
# that matters is THIS job's own unit, not a path any caller could predict.
# Set only by ci-throttle.test.mjs, to a fixture file standing in for
# memory.max without a real cgroup tree underneath it.
CGROUP_MEMORY_MAX="${CI_THROTTLE_CGROUP_MEMORY_MAX:-}"

# Where admitted jobs announce themselves. Derived from $HOME for exactly the
# reason CONF is — the hook runs as the runner's user, and that user is the only
# one guaranteed to be able to write here. The consequence, stated rather than
# hidden: runners owned by DIFFERENT users do not share a marker directory and
# therefore do not see each other's jobs. The fleet has run single-user since
# the `-b`/openclaw pool was retired on 2026-09-10, so today that set has one
# member; if a second user ever registers a runner, this becomes a shared
# directory question and not a $HOME one.
THROTTLE_DIR="$HOME/.hadoku/throttle"
ADMIT_DIR="$THROTTLE_DIR/admitted"
LOCK_FILE="$THROTTLE_DIR/admit.lock"

# Defaults are deliberately permissive: an absent or broken config must not
# throttle harder than an intentional one.
MAX_CONCURRENT=99
MIN_FREE_MB=0
MAX_WAIT_S=90
# Matched against GITHUB_WORKFLOW, which carries the workflow's DISPLAY NAME
# ("Runner smoke test"), not its file slug ("runner-smoke"). The first version
# matched only the slug, so neither exempt workflow was actually exempt — caught
# by dispatching a real smoke run and reading the hook's own output.
EXEMPT_WORKFLOWS='runner[ _-]?smoke|runner[ _-]?diag'

# shellcheck source=/dev/null
[ -r "$CONF" ] && . "$CONF" 2>/dev/null

# The test seam wins over whatever the conf just set, always. Production never
# sets CI_THROTTLE_RESERVE_FILE, so this is a no-op there: RESERVE_FILE stays
# whatever the (possibly deployer-rendered) conf gave it, empty if the conf
# gave nothing. ci-throttle.test.mjs sets the env var directly rather than
# plumbing a RESERVE_FILE= line through its own conf fixtures, the same way
# every other test seam here bypasses the conf entirely.
[ -n "${CI_THROTTLE_RESERVE_FILE:-}" ] && RESERVE_FILE="$CI_THROTTLE_RESERVE_FILE"

say() { echo "ci-throttle: $*"; }

# --- wave 4c #102 lane C: one line of host-load context per job ------------
#
# Slow reds are unattributable (wave4c-2026-10-07.md): a 0.95s test taking
# >5s, a 9s match start taking >60s, and nothing in the job log says what
# ELSE the host was doing. This hook already runs synchronously at job start
# (ADR 1751), so it is the one place that can capture the node's state at the
# moment THIS job began, before it piles onto whatever is already there.
# `job-metrics.sh` (the completed-job hook) records the same four facts again
# at the end, into the metrics record.
#
# NEVER FAILS THE JOB OVER IT. Each of the four values is read independently
# and prints the literal string "unreadable" on its own if it could not be
# taken — never a guessed number, because a fabricated 0 would read as a LESS
# loaded node than reality, the opposite direction every other fallback in
# this file takes (those fall open toward ADMITTING a job, never toward
# UNDERSTATING what is already on the box). `host_load_line` always returns 0.

# Where load1_avg() reads the 1-minute load average. Overridable for the same
# reason MEMINFO is: ci-throttle.test.mjs drives the real script against a
# fixture file rather than a rewrite of its parsing. No legitimate deploy
# ever sets this.
LOADAVG="${CI_THROTTLE_LOADAVG:-/proc/loadavg}"
# Where cpu_pressure_avg10() reads PSI. Same reason, same pattern — and it is
# what makes the brief's "where present" half literal: PSI is a cgroup v2 /
# kernel 4.20+ feature, absent entirely on some nodes and not surfaced to
# every leaf cgroup, and a missing file at this path IS that case, not a
# separate flag to thread through.
PRESSURE_CPU="${CI_THROTTLE_PRESSURE_CPU:-/proc/pressure/cpu}"
# Where cotenant_repos() resolves a co-tenant pid's cwd — "/proc" in
# production, a fixture directory in ci-throttle.test.mjs. A fixture pid
# never needs to be a live process: all this hook ever reads about one is
# "$PROC_ROOT/<pid>/cwd", so the test seam is a directory of symlinks, not a
# kernel underneath it.
PROC_ROOT="${CI_THROTTLE_PROC_ROOT:-/proc}"

# The 1-minute load average, field 1 of /proc/loadavg.
load1_avg() {
	local out
	[ -r "$LOADAVG" ] || { printf 'unreadable'; return; }
	out=$(awk '{print $1; exit}' "$LOADAVG" 2>/dev/null)
	case "$out" in
	'' | *[!0-9.]*) printf 'unreadable' ;;
	*) printf '%s' "$out" ;;
	esac
}

# CPU pressure (PSI), avg10 off the "some" line — "some tasks stalled on
# CPU", the metric PSI reports for CPU specifically (there is no "full" line
# for cpu: the kernel never reports every task stalled on it at once). A
# missing file and an unparseable one both resolve to "unreadable", same as
# load1_avg.
cpu_pressure_avg10() {
	local out
	[ -r "$PRESSURE_CPU" ] || { printf 'unreadable'; return; }
	out=$(awk '
		/^some/ {
			for (i = 1; i <= NF; i++) {
				if (index($i, "avg10=") == 1) { print substr($i, 7); exit }
			}
		}
	' "$PRESSURE_CPU" 2>/dev/null)
	case "$out" in
	'' | *[!0-9.]*) printf 'unreadable' ;;
	*) printf '%s' "$out" ;;
	esac
}

# Other Runner.Worker processes on this node, and which repo each is
# running — comma-separated; "" when there are none and the count could
# still be taken; "unreadable" when it could not.
#
# Guarded with -x so a grep of our own argv can never match itself (CLAUDE.md:
# "guard any live-worker matching with pgrep -x Runner.Worker or the
# [R]unner.Worker bracket form"). SELF_PID — found by the ancestry walk below,
# the one place this file already answers "which process IS this job" — is
# excluded BY PID, never by counting-minus-one, the same reason the admission
# marker's self-exclusion a few lines down is by pid rather than arithmetic.
#
# A co-tenant's repo comes from its OWN cwd, never a guess: actions/runner
# puts every job's Worker inside RUNNER_HOME/_work/<repo>/<repo> for the life
# of the job, so the first path segment after "_work/" IS the repo that
# worker is running — read from something the node really has.
cotenant_repos() {
	local pid cwd repo out=""
	command -v pgrep >/dev/null 2>&1 || { printf 'unreadable'; return; }
	for pid in $(pgrep -x Runner.Worker 2>/dev/null); do
		[ "$pid" = "$SELF_PID" ] && continue
		cwd=$(readlink -f "$PROC_ROOT/$pid/cwd" 2>/dev/null)
		case "$cwd" in
		*/_work/*)
			repo=${cwd#*/_work/}
			repo=${repo%%/*}
			;;
		*)
			repo="unknown"
			;;
		esac
		[ -n "$repo" ] || repo="unknown"
		out="${out:+$out,}$repo"
	done
	printf '%s' "$out"
}

# The one job-log line: all four facts, independently "unreadable" where they
# could not be taken. Always returns 0 — see the header.
host_load_line() {
	local load pressure reposline cotenants
	load=$(load1_avg)
	pressure=$(cpu_pressure_avg10)
	reposline=$(cotenant_repos)
	if [ "$reposline" = "unreadable" ]; then
		cotenants="unreadable"
	elif [ -z "$reposline" ]; then
		cotenants=0
		reposline="none"
	else
		cotenants=$(($(printf '%s' "$reposline" | tr -cd ',' | wc -c) + 1))
	fi
	say "host load: 1m=${load} cpu_pressure_avg10=${pressure} co-tenants=${cotenants} repos=${reposline}"
	return 0
}

# --- wave 4b #100/#101: a cheap, bounded /tmp prune at job start -----------
#
# The daily `ci:claw-cleanup` is too slow — claw-4 filled its tmpfs within
# hours, not a day. This hook already runs synchronously at the start of
# every ordinary job (ADR 1751), so it is the one place a prune can run more
# often than nightly without a cron of its own. INLINE, not an exec of
# clean-runner-debris.sh: that script is never installed on a node (the
# nightly cron pipes it over ssh from elsewhere), so a prior cut here execed
# a binary that is never present and so never ran anywhere, forever, silently
# (`[ -x "$PRUNE_BIN" ] || return 0` reading as "nothing to prune").
#
# ONE ROOT, NO LITERAL: PRUNE_ROOT is the ONLY place "/tmp" appears as a
# literal in this block's code (comments aside); every usage read and every
# delete goes through it, so the test suite can point it at a fixture
# directory and never touch the real host's /tmp.
PRUNE_ROOT="${CI_THROTTLE_PRUNE_ROOT:-/tmp}"
#
# WHY THESE NUMBERS, NOT A tmpfs-only % check: a sibling lane (#101) makes
# admission REFUSE a node whose /tmp has under TMP_FREE_FLOOR_MB=2048 MB free
# (src/runners/ephemeral.ts). A refused node starts no jobs, so a job-START
# hook can never run again once the node is refused — this prune MUST fire
# with margin ABOVE that floor, not after crossing it. PRUNE_FREE_MB=3072 is
# the floor plus a 1 GB margin. PRUNE_USED_PCT=50 catches the 16 GB claws
# (~7.9 GB tmpfs, where 50% used is ~3,950 MB — the free-MB rule alone would
# not fire there until ~4.9 GB used) earlier than the free-MB rule reaches
# them. `findmnt`/tmpfs-only gating is deliberately dropped: if PRUNE_ROOT is
# ever not a tmpfs, these same thresholds are still the right call.
PRUNE_FREE_MB="${PRUNE_FREE_MB:-3072}"
PRUNE_USED_PCT="${PRUNE_USED_PCT:-50}"
# How old (minutes; by the newest file INSIDE a candidate, never the
# directory's own top-level mtime — a live playwright/pytest run writes deep
# inside a directory whose top-level mtime stays old) a candidate must be
# throughout before it is removable. NOT derived from a found per-job
# ceiling: GitHub's own per-job bound (`timeout-minutes`) defaults to 360
# minutes (src/runners/ephemeral.ts: "GitHub's own bound on ONE JOB, in
# seconds"), and this hook's own two tightest jobs, runner-smoke/-diag at
# 2-3 minutes, are EXEMPT from this hook entirely (see EXEMPT_WORKFLOWS
# above) — so no in-tree job bound under 60 minutes exists to anchor this
# number against. 60 is a conservative default, not a derived one.
PRUNE_KEEP_MIN="${PRUNE_KEEP_MIN:-60}"
# Wall-clock ceiling for the whole prune. A job is delayed by at most this
# many seconds plus the small constant cost of the usage read and loop
# bookkeeping before it — SECONDS is checked before each candidate AND each
# individual `find`/`du`/`rm` is itself wrapped in `timeout 5`, so one stuck
# filesystem call cannot by itself blow past the bound; being killed mid-`rm`
# of an old debris directory is acceptable (it is debris either way).
PRUNE_BOUND_S="${PRUNE_BOUND_S:-20}"

# Directly-under-root candidate patterns, matched by name only — never
# recursed into. pytest-of-*/pytest-<N> is handled separately below because
# its keep-exempt member (pytest-current's resolved target) is a second
# level down and decided by symlink resolution, not by name.
PRUNE_PATTERNS='game-bundle-* vault-resp.* cardtable-e2e-web-* playwright-transform-cache-* liblz4-java-*'

_prune_log() {
	mkdir -p "$THROTTLE_DIR" 2>/dev/null
	printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$THROTTLE_DIR/prune.log" 2>/dev/null
	# Cap the log itself so the janitor cannot become its own debris.
	if [ -f "$THROTTLE_DIR/prune.log" ]; then
		tail -n 200 "$THROTTLE_DIR/prune.log" >"$THROTTLE_DIR/prune.log.tmp" 2>/dev/null &&
			mv "$THROTTLE_DIR/prune.log.tmp" "$THROTTLE_DIR/prune.log" 2>/dev/null
	fi
}

# Is anything inside $1 newer than PRUNE_KEEP_MIN minutes?
_prune_is_fresh() {
	[ -n "$(timeout 5 find "$1" -mmin "-$PRUNE_KEEP_MIN" -print -quit 2>/dev/null)" ]
}

# $1's resolved path, or empty if it cannot be resolved. Used only to decide
# whether a candidate's TARGET is inside the resolved root — a candidate
# whose target resolves outside it is left alone entirely, so a symlink is
# never followed out of PRUNE_ROOT.
_prune_realpath() { readlink -f -- "$1" 2>/dev/null; }

maybe_prune_tmp() {
	local out total used avail pct why start deadline removed_n freed_kb
	local root_real base d real sz keep_real keep_target
	# GITHUB_RUN_ID is set by the Actions runner for the lifetime of a real
	# job and nowhere else — production already proves this: the admit
	# marker this hook writes (claim_slot, ~line 669) carries
	# `run=${GITHUB_RUN_ID:-?}` and a live marker on this host reads
	# `run=37532893898`, never `run=?`. A prune belongs to a job start; a
	# hook invocation with no run id is a test harness or a hand run against
	# whatever PRUNE_ROOT happens to resolve to, and neither may delete from
	# the node's real temp root. warm-provision.test.mjs ran this hook with
	# only PATH/HOME/CI_THROTTLE_TEST_OTHERS set and it pruned the
	# workstation's real /tmp — this gate is what keeps that from recurring.
	if [ -z "${GITHUB_RUN_ID:-}" ]; then
		_prune_log "skipped: no GITHUB_RUN_ID (not running inside a GitHub Actions job)"
		return 0
	fi
	start=$SECONDS
	out=$(timeout 5 df -Pm "$PRUNE_ROOT" 2>/dev/null) ||
		{ _prune_log "could not read usage of $PRUNE_ROOT (df failed)"; return 0; }
	set -- $(printf '%s\n' "$out" | awk 'NR==2{print $2,$3,$4}')
	# `${N:-}`: `df` can exit 0 and print only the header line (no NR==2 row),
	# which leaves `set --` with zero positional params. Under `set -u`,
	# referencing `$1`/`$2`/`$3` unguarded then aborts the WHOLE hook with
	# "unbound variable" — and a hook that exits non-zero fails the job
	# (actions/runner ADR 1751). The unparseable-output check right below
	# still catches the empty case; this just keeps it from killing the hook
	# first.
	total=${1:-}; used=${2:-}; avail=${3:-}
	case "$total$used$avail" in
	'' | *[!0-9]*)
		_prune_log "could not read usage of $PRUNE_ROOT (unparseable df output: $out)"
		return 0
		;;
	esac
	[ "$total" -gt 0 ] ||
		{ _prune_log "could not read usage of $PRUNE_ROOT (df reported 0 total)"; return 0; }
	pct=$((used * 100 / total))
	if [ "$avail" -ge "$PRUNE_FREE_MB" ] && [ "$pct" -lt "$PRUNE_USED_PCT" ]; then
		_prune_log "avail=${avail}MB(floor ${PRUNE_FREE_MB}) used=${pct}%(floor ${PRUNE_USED_PCT}): below both, nothing to do"
		return 0
	fi
	why="avail=${avail}MB(floor ${PRUNE_FREE_MB}) used=${pct}%(floor ${PRUNE_USED_PCT})"

	root_real=$(_prune_realpath "$PRUNE_ROOT")
	[ -n "$root_real" ] || { _prune_log "could not resolve $PRUNE_ROOT, prune skipped ($why)"; return 0; }

	deadline=$((start + PRUNE_BOUND_S))
	removed_n=0
	freed_kb=0

	for pat in $PRUNE_PATTERNS; do
		for d in "$root_real"/$pat; do
			[ -e "$d" ] || continue
			[ "$SECONDS" -lt "$deadline" ] || break 2
			real=$(_prune_realpath "$d")
			case "$real" in "$root_real"/*) ;; *) continue ;; esac
			_prune_is_fresh "$d" && continue
			sz=$(timeout 5 du -sk -- "$d" 2>/dev/null | awk '{print $1}')
			freed_kb=$((freed_kb + ${sz:-0}))
			timeout 5 rm -rf -- "$d" 2>/dev/null
			removed_n=$((removed_n + 1))
		done
	done

	for base in "$root_real"/pytest-of-*; do
		[ -e "$base" ] || continue
		keep_target=''
		if [ -L "$base/pytest-current" ] || [ -e "$base/pytest-current" ]; then
			keep_real=$(_prune_realpath "$base/pytest-current")
			case "$keep_real" in "$root_real"/*) keep_target=$keep_real ;; esac
		fi
		for d in "$base"/pytest-*; do
			[ -e "$d" ] || continue
			[ "$SECONDS" -lt "$deadline" ] || break 2
			case "$d" in */pytest-current) continue ;; esac
			[ "$d" != "$keep_target" ] || continue
			real=$(_prune_realpath "$d")
			case "$real" in "$root_real"/*) ;; *) continue ;; esac
			[ "$real" != "$keep_target" ] || continue
			_prune_is_fresh "$d" && continue
			sz=$(timeout 5 du -sk -- "$d" 2>/dev/null | awk '{print $1}')
			freed_kb=$((freed_kb + ${sz:-0}))
			timeout 5 rm -rf -- "$d" 2>/dev/null
			removed_n=$((removed_n + 1))
		done
	done

	_prune_log "$why: removed ${removed_n} candidate(s), freed ~${freed_kb}KB, elapsed $((SECONDS - start))s"
	[ "$removed_n" -gt 0 ] &&
		echo "ci-throttle: job-start prune removed ${removed_n} stale dir(s) under $PRUNE_ROOT (~${freed_kb}KB)"
	return 0
}

# Validate what the config actually set. A non-numeric value makes every later
# `[ x -lt y ]` return FALSE, which does not fail open — it waits the entire
# ceiling and throttles HARDER than any intentional setting. Found by feeding
# the script a deliberately malformed config: it held a job for 91s on a
# completely idle node. Anything unparseable is discarded for the permissive
# default, loudly.
for _v in MAX_CONCURRENT MIN_FREE_MB MAX_WAIT_S; do
	eval "_val=\${$_v}"
	case "$_val" in
	'' | *[!0-9]*)
		case "$_v" in
		MAX_CONCURRENT) _def=99 ;;
		MIN_FREE_MB) _def=0 ;;
		*) _def=90 ;;
		esac
		echo "ci-throttle: ${_v}='${_val}' is not a non-negative integer — using ${_def}" >&2
		eval "$_v=$_def"
		;;
	esac
done
unset _v _val _def

# --- exemptions ------------------------------------------------------------
# The fleet's two tightest job budgets are runner-smoke (timeout-minutes: 2) and
# runner-diag (3). Both are DIAGNOSTICS whose whole purpose is to report on the
# runner, so delaying them is both risky against those budgets and defeats the
# point. Everything else in the fleet allows 5 minutes or more, which the
# MAX_WAIT_S ceiling below is sized against.
if [ -n "${GITHUB_WORKFLOW:-}" ] &&
	printf '%s' "$GITHUB_WORKFLOW" | grep -Eqi "$EXEMPT_WORKFLOWS"; then
	say "workflow '${GITHUB_WORKFLOW}' is exempt — starting immediately"
	exit 0
fi

# --- #76's hokon half: known need vs THIS UNIT's cap, a STATIC finding -----
# See the header ("A THIRD FINDING, STATIC") for why this needs no wait and no
# new data path. Anything missing here (no repo, no readable ledger, no `jq`,
# no readable memory.max) is uncertainty, not a breach, and falls through to
# the ordinary admission loop below exactly as every other gap in this file
# does — this function says nothing rather than guess.
#
# `facets[<repo>].jobP95Mb.mb` is the number whether it was measured directly
# or is a lower bound raised off a capped run — either way, the job's real
# need is AT LEAST this, so a cap already below it can never hold the job and
# nothing is lost by using it unconditionally here.
reserve_mb() {
	[ -n "${GITHUB_REPOSITORY:-}" ] || return 0
	[ -r "$RESERVE_FILE" ] || return 0
	command -v jq >/dev/null 2>&1 || return 0
	local v
	v=$(jq -r --arg repo "$GITHUB_REPOSITORY" '.facets[$repo].jobP95Mb.mb // empty' \
		"$RESERVE_FILE" 2>/dev/null)
	case "$v" in
	'' | *[!0-9]*) return 0 ;;
	esac
	printf '%s' "$v"
}

# This job's own unit's memory.max, in MB — the ceiling THIS cgroup will ever
# be allowed to use, however idle the node is. `/proc/self/cgroup`'s third
# field is read the same way job-metrics.sh already reads it (ADR: the reader
# for a facet may read the same kernel fact a sibling reader does; it may not
# read what a VERIFIER's own writer claimed about it, which this is not).
# "max" is cgroup v2's literal string for uncapped, and counts as unknown here
# — an uncapped unit cannot be in breach of a cap it does not have.
unit_cap_mb() {
	local path raw cg
	if [ -n "$CGROUP_MEMORY_MAX" ]; then
		path="$CGROUP_MEMORY_MAX"
	else
		cg=$(cut -d: -f3 /proc/self/cgroup 2>/dev/null | head -1)
		[ -n "$cg" ] || return 0
		path="/sys/fs/cgroup${cg}/memory.max"
	fi
	raw=$(cat "$path" 2>/dev/null)
	case "$raw" in
	'' | max | *[!0-9]*) return 0 ;;
	esac
	printf '%s' "$((raw / 1024 / 1024))"
}

KNOWN_NEED_MB=$(reserve_mb)
UNIT_CAP_MB=$(unit_cap_mb)
if [ -n "$KNOWN_NEED_MB" ] && [ -n "$UNIT_CAP_MB" ] && [ "$KNOWN_NEED_MB" -gt "$UNIT_CAP_MB" ]; then
	# PLACEMENT, not contention — see the header. Nothing about THIS wait could
	# change either number, so there is no wait to run first.
	say "refusing immediately — ${GITHUB_REPOSITORY}'s known need (${KNOWN_NEED_MB}MB, from" \
		"${RESERVE_FILE}) exceeds this unit's ${UNIT_CAP_MB}MB memory.max cap"
	echo "::error::ci-throttle: refused on $(hostname) before waiting — $(hostname) cannot" \
		"host this job: ${GITHUB_REPOSITORY:-this repo}'s known memory need (${KNOWN_NEED_MB}MB)" \
		"exceeds this runner unit's ${UNIT_CAP_MB}MB memory.max. This is a placement problem," \
		"not a throttling one: no amount of waiting raises this unit's cap. Route this job to a" \
		"node whose per-unit cap can hold it."
	exit 1
fi
unset KNOWN_NEED_MB UNIT_CAP_MB

# --- how many OTHER jobs are on this node -------------------------------
# This hook runs inside its own job's Runner.Worker, so a naive `pgrep -c` counts
# this job as contention against itself — with MAX_CONCURRENT=1 that deadlocks
# until the ceiling. Walk up /proc to find THIS job's worker and exclude exactly
# that pid, rather than blindly subtracting one (which would be wrong whenever
# the ancestry is not what we assume).
self_worker=""
p=$$
while [ "$p" -gt 1 ] 2>/dev/null; do
	c=$(cat "/proc/$p/comm" 2>/dev/null) || break
	if [ "$c" = "Runner.Worker" ]; then
		self_worker="$p"
		break
	fi
	p=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null) || break
	[ -n "$p" ] || break
done

# The pid whose life IS this job's life. The ancestry walk above is the only
# thing that can answer it: $$ is this SCRIPT, which ends the moment the job is
# admitted and starts running, so a marker named after it would evaporate at the
# exact instant the job began consuming the slot it just took.
#
# When the walk finds nothing we fall back to $$ and SAY SO, rather than
# refusing. That is the same fail-open direction the rest of this file takes,
# and its cost is bounded and known: the job runs, but holds no slot while it
# does, so the node can seat one more than MAX_CONCURRENT. Refusing instead
# would fail a healthy build over an ancestry assumption of ours.
if [ -n "$self_worker" ]; then
	SELF_PID="$self_worker"
else
	SELF_PID=$$
	echo "ci-throttle: no Runner.Worker ancestor of pid $$ — this job will hold a slot only while the hook runs" >&2
fi
# Exported so a test's fake `pgrep` (ci-throttle.test.mjs, wave 4c #102) can
# echo this job's OWN pid back without having to predict what the kernel
# assigned it — cotenant_repos()'s self-exclusion is then exercised against
# the exact value this run actually computed, not a guess at it from outside.
# Production pgrep neither reads nor cares about this.
export SELF_PID

# Field 22 of /proc/<pid>/stat, which is what makes a pid unambiguous.
# `comm` (field 2) is parenthesised and may contain spaces, so the leading
# "<pid> (<comm>) " is removed before splitting rather than trusting $22.
starttime_of() {
	awk '{ s = $0; sub(/^[0-9]+ \(.*\) /, "", s); split(s, f, " "); print f[20] }' \
		"/proc/$1/stat" 2>/dev/null
}

SELF_START=$(starttime_of "$SELF_PID")
[ -n "$SELF_START" ] || SELF_START=0

# wave 4c #102 lane C. After SELF_PID — cotenant_repos() needs it to exclude
# this job's own worker — and before the admission wait, so the line appears
# for every ordinary job regardless of how the wait that follows ends.
host_load_line

# Is <pid> still the process <starttime> names, AND still running one?
#
# Two ways to be a marker worth nothing, and /proc answers them in the same
# read. The pid may be gone, or recycled onto an unrelated process — the
# starttime is what tells those apart from the job that wrote the marker. Or it
# may be a ZOMBIE, which answers /proc with exactly the starttime it always had
# while running nothing at all: an unreaped Runner.Worker would otherwise hold
# a slot open for as long as its listener took to notice it.
#
# Anything unreadable is non-zero, i.e. not live. That is the permissive
# direction here — an uncountable marker lowers the count, and a lower count
# admits — which is the same way every other uncertainty in this file falls.
marker_is_live() {
	awk -v want="$2" '{
		s = $0
		sub(/^[0-9]+ \(.*\) /, "", s)
		split(s, f, " ")
		if (f[1] == "Z") exit 1
		exit (f[20] == want) ? 0 : 1
	}' "/proc/$1/stat" 2>/dev/null
}

# Can we see the marker directory at all? Creating it here rather than at
# install time keeps the deployed payload — and therefore its provenance hash —
# a single file; the hook is the only thing that reads or writes this tree.
admit_dir_ready() {
	[ -d "$ADMIT_DIR" ] || mkdir -p "$ADMIT_DIR" 2>/dev/null
	[ -d "$ADMIT_DIR" ] && [ -r "$ADMIT_DIR" ] && [ -x "$ADMIT_DIR" ] && [ -w "$ADMIT_DIR" ]
}

others() {
	# Test-only. There is no real deployment where "how many other jobs are on
	# this node" should be handed in rather than counted — the wait loop that
	# CLAUDE.md's rule about a reader and a writer sharing an artifact would flag
	# instantly if this were read anywhere but a fixture. ci-throttle.test.mjs
	# (P3.4) sets it because there is no other way to pin the count for a whole
	# run. The marker cases in that file deliberately leave it UNSET and drive
	# the real accounting below.
	if [ -n "${CI_THROTTLE_TEST_OTHERS:-}" ]; then
		echo "$CI_THROTTLE_TEST_OTHERS"
		return
	fi
	# FAILS OPEN, exactly as the pgrep this replaced did: a count we could not
	# take is 0, which admits. An unreadable marker directory is uncertainty
	# about the limit, and this hook only ever refuses on a confirmed breach.
	if ! admit_dir_ready; then
		echo 0
		return
	fi
	local n entry base pid st
	n=0
	for entry in "$ADMIT_DIR"/*; do
		# An unmatched glob leaves the pattern itself; -e rejects it.
		[ -e "$entry" ] || continue
		base=${entry##*/}
		case "$base" in
		*.*) ;;
		*) continue ;;
		esac
		pid=${base%%.*}
		st=${base#*.}
		case "$pid" in '' | *[!0-9]*) continue ;; esac
		case "$st" in '' | *[!0-9]*) continue ;; esac
		# The self-exclusion. A re-entered hook must not count the marker it
		# wrote on its own previous pass as contention against itself — the same
		# deadlock the ancestry walk above was written for, one layer up.
		[ "$pid" = "$SELF_PID" ] && continue
		if marker_is_live "$pid" "$st"; then
			n=$((n + 1))
		else
			# Gone, recycled, or a zombie. Either way it is not the job this
			# marker claims, so it counts as nothing and goes. By LIVENESS, never
			# by age — see the header.
			rm -f "$entry" 2>/dev/null
		fi
	done
	echo "$n"
}

# Could the count above actually be TAKEN, or is its 0 a "could not look"?
#
# `others()` returns 0 when the marker directory is unreadable, which is the
# right fail-open direction for ADMITTING — but that 0 does not mean "nothing is
# running", and the placement finding below reasons from a zero. Reading "I could
# not look" as "nothing is wrong" is the one thing CLAUDE.md forbids outright, so
# the finding that says a node CANNOT host a job requires a count this hook
# actually took. Asked separately rather than returned from `others()` because
# that runs in a `$( )` subshell and cannot set a variable here.
count_trusted() {
	# The test seam pins the count, which is a count, just not a measured one.
	[ -n "${CI_THROTTLE_TEST_OTHERS:-}" ] && return 0
	admit_dir_ready
}

# Announce the slot. Written under the same lock as the count that decided it,
# so the decision cannot be made twice on the same free slot.
claim_slot() {
	local marker
	marker="$ADMIT_DIR/$SELF_PID.$SELF_START"
	if ! printf 'pid=%s start=%s repo=%s workflow=%s run=%s at=%s\n' \
		"$SELF_PID" "$SELF_START" "${GITHUB_REPOSITORY:-?}" "${GITHUB_WORKFLOW:-?}" \
		"${GITHUB_RUN_ID:-?}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$marker" 2>/dev/null; then
		# Fail open, loudly. The job runs; it just will not be visible as load to
		# the next one, so the node can seat one over the cap.
		echo "ci-throttle: could not write $marker — this job will not count as load for the next one" >&2
	fi
}

free_mb() {
	awk '/^MemAvailable:/ {printf "%d", $2/1024; found=1} END{if(!found) print 999999}' \
		"$MEMINFO" 2>/dev/null || echo 999999
}

# --- wait for a slot -------------------------------------------------------
# THE LOCK. `others()` reading "3 of 4 taken" is only true until the next job
# reads the same thing, so the read and the write that answers it are one
# critical section. It is held for a directory scan of a handful of files and
# nothing else — never across the sleep, which would serialise the whole wait.
#
# Not being able to take it is uncertainty, not a breach: we proceed unlocked,
# which is precisely the behaviour of the version before this lock existed.
LOCKED_FD=0
if admit_dir_ready && command -v flock >/dev/null 2>&1 && : >>"$LOCK_FILE" 2>/dev/null; then
	exec 9>>"$LOCK_FILE" && LOCKED_FD=1
fi

start=$SECONDS
waited=0
# #73, test-only. The bug this reproduces needs the FIRST loop iteration's
# `waited` to already read >= 1 — which in production happens only when real
# wall-clock time between `start=$SECONDS` above and the first read below
# happens to straddle a whole-second boundary, a race that depends on machine
# load and cannot be made to happen on demand. Sleeping here, after `start` is
# captured and before the loop's first read, makes that boundary-crossing
# certain instead of waited-for. No legitimate deploy ever sets this.
if [ -n "${CI_THROTTLE_TEST_FIRST_PASS_DELAY_S:-}" ]; then
	sleep "$CI_THROTTLE_TEST_FIRST_PASS_DELAY_S"
fi
# What the wait SAW, across every pass — the refusal at the ceiling is written
# from these and not from the last sample. See "TWO REFUSALS" in the header.
PEAK_OTHERS=0     # the most admitted jobs seen at once; 0 for the whole wait is the discriminator
FREE_MIN=''       # how MemAvailable moved. A floor breach that never moved is a baseline,
FREE_MAX=''       # not a burst draining.
COUNT_TRUSTED=1   # cleared for the whole run the first time the count could not be taken
HOLDING_SAID=0    # #73: has the "holding:" line already been said. A flag set the instant
                  # it is, never re-derived from $SECONDS — see below for why.
while :; do
	# COMPUTED AT THE TOP, not after the admission check. It used to be set at
	# the END of the previous iteration, so a job admitted on its second pass
	# read the value from before it slept: "$SECONDS - $start" is whole seconds
	# and the first pass takes milliseconds, so `waited` was 0 and the "slot free
	# after Ns" line never printed for the jobs that had actually waited. The
	# only externally visible evidence that this hook held a job and then let it
	# in was therefore missing from exactly the runs that had it.
	waited=$((SECONDS - start))
	f=$(free_mb)
	held=0
	if [ "$LOCKED_FD" = 1 ] && flock -w 10 9 2>/dev/null; then held=1; fi
	count_trusted || COUNT_TRUSTED=0
	n=$(others)
	if [ -z "$FREE_MIN" ] || [ "$f" -lt "$FREE_MIN" ]; then FREE_MIN=$f; fi
	if [ -z "$FREE_MAX" ] || [ "$f" -gt "$FREE_MAX" ]; then FREE_MAX=$f; fi
	if [ "$n" -gt "$PEAK_OTHERS" ]; then PEAK_OTHERS=$n; fi
	if [ "$n" -lt "$MAX_CONCURRENT" ] && [ "$f" -ge "$MIN_FREE_MB" ]; then
		claim_slot
		[ "$held" = 1 ] && flock -u 9
		[ "$waited" -gt 0 ] && say "slot free after ${waited}s (${n} other job(s), ${f}MB available)"
		# Isolated in a subshell: nothing inside the prune — an unset variable,
		# a failing command, anything under `set -u`/`set -e` semantics it
		# inherits — may change the hook's own exit status or kill it. Its one
		# informational stdout line still prints; only its exit status is
		# discarded.
		( maybe_prune_tmp ) || true
		exit 0
	fi
	[ "$held" = 1 ] && flock -u 9

	if [ "$waited" -ge "$MAX_WAIT_S" ]; then
		# REFUSED, not admitted — see the header. The wait held the full
		# MAX_WAIT_S and the node is STILL over its declared limit, which is a
		# confirmed breach, not a guess. ADR 1751 fails the job on any non-zero
		# exit "with an appropriate annotation"; that annotation (below) is the
		# only way this hook can say no, and this is the one place in the file it
		# is worth saying.
		#
		# How MemAvailable moved over the wait, which is what tells a baseline
		# apart from something draining. Collapsed to one figure when it did not
		# move, so a reader is not left wondering what the range means.
		span="${FREE_MIN}MB"
		[ "$FREE_MIN" = "$FREE_MAX" ] || span="${FREE_MIN}-${FREE_MAX}MB"

		# PLACEMENT (#67). This gate never saw another admitted job at any point
		# in the wait, so it was not waiting for one to leave and there is no
		# slot to ask the operator to wait for. Whatever holds the memory is
		# outside what this hook manages, and re-running lands in exactly the
		# same state.
		if [ "$COUNT_TRUSTED" = 1 ] && [ "$PEAK_OTHERS" -eq 0 ]; then
			if [ "$f" -lt "$MIN_FREE_MB" ]; then
				short=$((MIN_FREE_MB - f))
				# NOT "held by the node's resident load" — that is a guess. A JIT
				# slot holds memory and no marker, so it is invisible here too,
				# and naming the wrong owner is how a finding becomes
				# unactionable. Say what is held and by whom it is NOT.
				why="it is ${short}MB short of its ${MIN_FREE_MB}MB memory floor, and MemAvailable stayed ${span} for the whole wait — held by something this gate does not admit or account for, not by a job it could wait out"
				fix="Place this job on a node with more free memory, or — if ${f}MB is in fact enough for it — lower minFreeMb for this node in fleet-runner-manifest.json and redeploy with \`fleet throttle --confirm\`."
			else
				# maxConcurrent: 0. Not a configuration the fleet uses, but the
				# rule above already covers it correctly and a message that read
				# "re-run once the node has a free slot" for a node that has
				# none, ever, would be the same lie in a different shape.
				why="its declared concurrency limit is ${MAX_CONCURRENT}, so no job can be admitted here at all"
				fix="Raise maxConcurrent for this node in fleet-runner-manifest.json and redeploy with \`fleet throttle --confirm\`, or place this job elsewhere."
			fi
			say "waited ${waited}s and REFUSING the job — this node cannot host it" \
				"(0 of ${MAX_CONCURRENT} slot(s) in use for the whole wait, ${span} available, floor ${MIN_FREE_MB}MB)"
			echo "::error::ci-throttle: refused on $(hostname) after ${waited}s — this node cannot host this job: ${why}. Concurrency was never the constraint: 0 of ${MAX_CONCURRENT} slot(s) were in use at any point in the wait, so there is no free slot to wait for and re-running will refuse again. This is a placement problem, not a throttling one. ${fix}"
			exit 1
		fi

		# CONTENTION. Something was running, so something will finish, and
		# waiting IS the fix. `peak` rather than the final `n` for the same
		# reason the placement branch reads it: the last sample can be lower
		# than what actually blocked this job.
		count="${n} concurrent job(s), peak ${PEAK_OTHERS}"
		[ "$COUNT_TRUSTED" = 1 ] || count="an UNREADABLE admitted-job count (${ADMIT_DIR} could not be read, so 0 here means 'could not look')"
		say "waited ${waited}s for a slot and REFUSING the job" \
			"(${n} other job(s), ${f}MB available, limit ${MAX_CONCURRENT}/${MIN_FREE_MB}MB)"
		echo "::error::ci-throttle: refused on $(hostname) after ${waited}s — ${count}, ${span} available (limit ${MAX_CONCURRENT} job(s) / ${MIN_FREE_MB}MB free). Re-run once the node has a free slot."
		exit 1
	fi

	# #73: gated on a flag this loop sets, NOT on `[ "$waited" -eq 0 ]`. `waited`
	# is whole-second $SECONDS arithmetic, and the first iteration's read of it
	# can already be >= 1 — real wall-clock time elapses between `start=$SECONDS`
	# above and this line (config parsing, the ancestry walk, `others()`,
	# flock), and if that elapsed time happens to straddle a one-second
	# boundary, `waited` is never 0 on ANY iteration of this run: not the first
	# (already past it) and not any later one (further still). The old gate then
	# never announced holding at all for that job — it failed one publish (wave
	# 3s) while CI on the same commit passed, because whether the boundary is
	# crossed depends on machine load at the moment the job happens to run.
	# This flag has no such dependency: it says exactly once, the first time
	# through, regardless of what $SECONDS reads.
	if [ "$HOLDING_SAID" = 0 ]; then
		say "holding: ${n} other job(s), ${f}MB available; want <${MAX_CONCURRENT} and >=${MIN_FREE_MB}MB (max ${MAX_WAIT_S}s)"
		HOLDING_SAID=1
	fi

	# Jitter. Without it every job blocked by the same burst re-checks in
	# lockstep and they all pass the test in the same instant, which recreates
	# the pile-up this exists to prevent.
	sleep "$(awk -v s=$$ 'BEGIN{srand(s); printf "%.2f", 1.5 + rand()*2.0}')"
done
