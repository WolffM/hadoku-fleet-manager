#!/usr/bin/env bash
# job-metrics — the ACTIONS_RUNNER_HOOK_JOB_COMPLETED hook. Record what a job
# actually cost in memory, from the kernel, before the evidence is torn down.
#
# WHY THIS EXISTS
# ---------------
# Two open questions in docs/planning/tier-assignment-2026-09-03.md need the same
# number and neither can be answered without it:
#
#   1. OOM ATTRIBUTION. `runners.slice/memory.events` on claw-2 reads
#      `oom_kill 4`. That counter is cumulative, carries no timestamp and names
#      no job, so it proves pressure existed and nothing else. A job killed for
#      memory currently reports as `Tests` failing — indistinguishable from a
#      broken test, which is how a fleet-manager fault gets read as node
#      incapability and demotes a healthy claw.
#   2. THE claw-1 INVERSION. claw-1 is second-slowest on synthetic CPU, on the
#      fleet's worst disk at 98 C, and the FASTEST claw on real jobs. The orphan
#      load, sampling bias and contention were each tested and eliminated
#      (2026-09-04). The live hypothesis is memory — claw-1 has 11 GB against
#      claw-2's 7 GB, and CI here is node_modules, many small files, where page
#      cache plausibly beats clock and sequential disk. Peak RSS per job is the
#      measurement that settles it.
#
# THE HOOK MUST NEVER FAIL A JOB
# ------------------------------
# actions/runner ADR 1751: a non-zero hook exit FAILS THE JOB. This script is
# pure instrumentation — there is no measurement worth failing someone's build
# for. Every path ends at `exit 0`, the whole body runs under `set +e`, and every
# write is best-effort. `scripts/lib/job-metrics-guard.test.mjs` asserts that
# property against the real file, because a future edit that adds a `set -e` or
# an unguarded command would be silent until it broke a build.
#
# WHERE THE NUMBER COMES FROM, AND WHY IT IS TRUSTWORTHY
# -----------------------------------------------------
# `/proc/self/cgroup`, read AT RUN TIME. Not a path this script builds from the
# node's name, the repo, or the manifest — the reader for a facet may not read
# what the writer wrote, and a hardcoded cgroup path is exactly that mistake.
#
# Measured 2026-09-04, a JIT job's leaf cgroup is its own transient unit:
#
#   /user.slice/user-1000.slice/user@1000.service/app.slice/
#     jit-claw-1-hadoku-scraper-j101139462953-r33908618175-1788548255.service
#
# ONE CGROUP PER MINT, holding both Runner.Listener and Runner.Worker. So
# `memory.peak` there is this job's peak and nothing else's — no reset needed, no
# sibling contamination, and the unit name carries `j<jobId>` and `r<runId>`,
# which are the exact keys job-history already stores. That is a far better join
# than matching on a display name.
#
# A STANDING or `warm-*` runner is different, and CANNOT be fixed the way this
# file used to claim. Its cgroup is one long-lived unit serving many jobs, so
# `memory.peak` is a high-water mark over the unit's whole life. Until
# 2026-09-16 this script tried to reset it after reading, guarded on
# `[ -w "$base/memory.peak" ]`, and the header asserted that made every job after
# the first one correct. It never did. The reset accounted for ZERO of the 65
# peak decreases across 1,429 consecutive standing steps on all 7 claws
# (measured 2026-09-16): the CPU clock decreased on exactly those same 65, and a
# CPU clock only goes backwards on a unit restart, so all 65 were restarts.
#
# WHY IT COULD NOT WORK, measured rather than assumed — and NOT the permissions
# story it looks like. In the cgroups where this hook actually runs, the file IS
# writable and the guard IS true:
#
#   claw-7, warm-claw-7-hadoku_site.service -> -rw-r--r-- 1 hadoku hadoku
#   claw-1, warm-claw-1-hadoku-watchparty.service -> the same
#
# and the write returns 0. Since Linux 6.11/6.12, writing `memory.peak` resets it
# **only for the writing FILE DESCRIPTOR's** view. Measured in a transient scope
# under app.slice on claw-7 (6.12.107) and on hokon (6.12.101):
#
#   peak after allocating 60 MiB   66,228,224
#   after write, read on the SAME fd    3,305,472   <- reset, for this fd only
#   after write, read on a NEW fd      66,228,224   <- untouched
#
# A job-completed hook is a separate short-lived process from whatever reads the
# value next, so its fd dies with it and the next reader always sees the
# un-reset high-water. THERE IS NO PRIVILEGE FIX: root's write is per-fd too, so
# `Delegate=`, a chown or a setuid helper would all change nothing. The only
# things that give a per-job peak are a fresh cgroup per job — which is exactly
# what the JIT path above already does — or one process holding the fd open
# across the whole job, which the hook contract does not allow.
#
# So the reset is GONE rather than left in place as a no-op. A guard whose
# condition cannot fail proves nothing, and one that looks like it is working is
# worse than none: `warm-claw-7-hadoku_site.service` published 4,097 MB — its
# 4 GiB ceiling, not a measurement — on all 217 of its rows, a trivial `guard`
# job included, and two of the headline figures in
# docs/planning/workload-benchmark-join-2026-09-07.md were that number.
#
# WHAT `peakBytes` MEANS, AND THE ROW NOW SAYS WHICH (`peakBasis`):
#
#   jit       peakBasis "job"              the cgroup is minted for this job and
#                                          dies with it, so the high-water is
#                                          this job's and nothing else's.
#   standing  peakBasis "unit-cumulative"  the high-water since the unit last
#                                          STARTED, across every job it has
#                                          served and every idle gap between
#                                          them. It may simply be `limitBytes`.
#                                          It is NOT this job's peak and must
#                                          never be averaged, percentiled or
#                                          compared against a JIT row as if it
#                                          were.
#
# `peakBasis` is emitted so a consumer reads the nature of the number instead of
# re-deriving it from the unit name. Normalising it is the READER's job and
# `scripts/lib/job-metrics.mjs` already does it; this file's job is to hand over
# an honest label. The other memory fields are unaffected: `currentBytes`,
# `shmemBytes`, `fileBytes` and `anonBytes` are all instantaneous reads at job
# completion on every unit kind.
#
# WHAT IS DELIBERATELY NOT DONE HERE
# ----------------------------------
# No parsing of the job's logs. No judgement about whether the number is good or
# bad. This writes one line and gets out of the way; `fleet job-metrics` is what
# reads and joins. A hook that phoned home would put a network timeout inside
# every job's critical path.
#
# WHERE io.stat COMES FROM, AND WHY EVERY ROW READ null UNTIL 2026-09-16.
# `io` is enabled at the cgroup root on every claw and it accounts for real, but
# it was never handed down: the user manager was delegated `cpu memory pids`, so
# a leaf unit had no io.stat and this hook correctly wrote null. That is now
# installed by `runners-slice-install.sh` — a `Delegate=` drop-in on
# `user@<uid>.service` plus `DefaultIOAccounting=yes` for the user manager, which
# are TWO writes because delegation alone stops at the slice: a controller
# appears in a cgroup's `cgroup.subtree_control` only because a MEMBER asks for
# it. `fleet slice --check` audits all of it. Nothing here changed, and nothing
# here should: a node where that has not run yet, or any dev box, still reads
# absent, and absent must still be null rather than a job that did no io.
#
# NETWORK BYTES ARE NOT READ, and that is a finding, not an oversight (P2.3):
# there is no cgroup v2 controller for network byte counts at all. systemd's own
# IPAccounting is the only thing that produces one, and it exposes it through a
# bpf map read via `systemctl show`/D-Bus, never a /sys/fs/cgroup file — which
# fails the same "reader may not read what a different writer wrote" rule that
# keeps this hook off `systemctl show` for memory. The mint's `systemd-run`
# invocation (see above) does not pass `--property=IPAccounting=yes` either, so
# there would be nothing to read even through that door. cpu.stat and io.stat
# below are read the same defensive way memory.peak already is: a controller not
# delegated to this leaf reads as absent (null), not as zero.
#
# TMPFS IS MEMORY, AND memory.peak ALREADY COUNTS IT (#28)
# --------------------------------------------------------
# `/tmp` is tmpfs on every claw at ~50 % of installed RAM, so a job writing
# there consumes memory the reserve believes is free. The obvious next step —
# ADD `shmem` to `peakBytes` to get the real footprint — is WRONG and would
# double-count. Measured on kernel 6.12.101+deb13-amd64 in a transient user
# scope (`systemd-run --user --scope`), 2026-09-15:
#
#   200 MiB (209,715,200 B) written to /tmp inside the scope
#     memory.peak        1,634,304 -> 212,049,920   (delta 210,415,616)
#     memory.stat shmem          0 -> 209,715,200   (delta 209,715,200)
#     memory.stat file              209,723,392     (file >= shmem)
#
# The peak moved by the whole write. cgroup v2 charges a tmpfs page to the
# cgroup that first touches it, counts it in the same page counter `memory.peak`
# is the high-water mark of, and reports it under memory.stat's `file`, which is
# the SUPERSET that contains `shmem`. So the containment is
#
#   peakBytes >= memory.current = anonBytes + fileBytes + kernel + sock + ...
#   fileBytes >= shmemBytes
#
# and the fields below are a DECOMPOSITION of a number already recorded, not an
# addition to it. There is deliberately NO `residentPeakBytes`: the sum it would
# carry is `peakBytes`.
#
# `runner-mem-harvest.py` says the same thing from the other direction and was
# written before this note: "memory.peak is the high-water of memory.current,
# which is CACHE-INCLUSIVE", measured there as 1,400 MB of memory.current against
# 30 MB of anon on a live hadoku_site unit. Two independent readings, one
# conclusion — the peak is not a working-set figure and never was.
#
# What the decomposition buys is ATTRIBUTION. `peakBytes` alone cannot tell a
# job that held 3 GB of working set apart from one that held 3 GB of scratch
# files in RAM, and those two want opposite fixes. `anon`, `shmem` and `file` are
# three of the four keys `runner-mem-harvest.py` already samples on a timer —
# and `anon + shmem` is the `unreclaimable` figure it sizes by, the one that
# actually predicts a global OOM — so a per-job row and the timer series are now
# the same numbers and can be compared directly.
#
# THE LIMIT, STATED PLAINLY: memory.stat is CURRENT, not a high-water mark — the
# kernel keeps no per-field peak. This hook runs at job COMPLETION, so
# `shmemBytes` is what the job STILL HELD when it finished. The same measurement
# shows why that is a FLOOR and not a peak: deleting the 200 MiB file dropped
# shmem back to 4,096 while memory.peak stayed at 212,049,920. A job that tidies
# up after itself reports ~0 here — and its tmpfs is still inside `peakBytes`,
# which is the number that matters for the reserve. A true sampled peak would
# have to come from the timer harvester and would be named `shmemPeakBytes`;
# this hook does not and structurally cannot emit it.
#
# memory.stat is read ONCE into a string and parsed from that snapshot, for the
# same reason cpu.stat is (below): three separate reads of a live file are three
# different views, and `file >= shmem` is an invariant only within one of them.
set +e
umask 022

OUT="${JOB_METRICS_OUT:-$HOME/.hadoku/job-metrics.jsonl}"
# ROTATED AT THE RETENTION BOUNDARY, keeping ONE `.1` (#37). The window is
# job-history's `RETENTION_DAYS` (src/job-history.ts) — a row older than that
# has nothing left to join to — and `job-metrics-guard.test.mjs` fails the
# build if the two numbers part. See the rotation block at the end for why it
# is a rename and never a rewrite.
RETENTION_DAYS="${JOB_METRICS_RETENTION_DAYS:-14}"
# A BACKSTOP, not the policy: rotate early if the live file passes this many
# bytes inside one window. Measured 2026-09-18 a row is ~590 bytes and the
# busiest claw wrote 1,935 in 14 days (1,139,097 bytes), so 32 MiB is ~28x
# today's worst node — and half the reader's 64 MiB transport ceiling, so the
# live file plus its `.1` can never outgrow a read even at this bound.
MAX_BYTES="${JOB_METRICS_MAX_BYTES:-33554432}"

cg=$(cut -d: -f3 /proc/self/cgroup 2>/dev/null | head -1)
base="/sys/fs/cgroup${cg}"
# THE UNIT NAME THE IDS ARE PARSED FROM, overridable — and `base` deliberately is
# NOT, so memory still comes from the real cgroup.
#
# The ids below prefer the cgroup leaf and fall back to the environment. Inside a
# JIT unit the leaf ALWAYS matches, so the fallback is unreachable there — and CI
# runs inside a JIT unit. A test that sets GITHUB_RUN_ID and expects to see it
# therefore passes on any dev box and fails on the fleet, which is exactly what
# happened on 2026-09-05: two tests green in every pre-commit run and red in CI,
# on a hook neither the commit nor the tests had touched.
#
# Overriding `base` too would be the obvious shortcut and would break the other
# tests: no readable memory.peak means NO ROW AT ALL, by design a few lines down.
leaf=$(basename "${JOB_METRICS_UNIT:-${cg:-/}}" 2>/dev/null)

read_one() { [ -r "$1" ] && head -1 "$1" 2>/dev/null | tr -d '\n' || echo ""; }
field() { [ -r "$1" ] && awk -v k="$2" '$1==k{print $2; found=1} END{if(!found)print ""}' "$1" 2>/dev/null || echo ""; }
# The same `key value` lookup against a string ALREADY READ, for the two files
# whose fields must be one consistent snapshot rather than N racing reads —
# cpu.stat and memory.stat. See both notes in the header.
field_str() { printf '%s\n' "$1" | awk -v k="$2" '$1==k{print $2; found=1} END{if(!found)print ""}'; }
# io.stat is one line PER DEVICE (`8:0 rbytes=.. wbytes=.. rios=.. ...`), unlike
# the single-value-per-line files above, so it needs its own summer rather than
# `field()`. A readable file with no device lines (io not delegated to this
# leaf, see the header note) leaves `seen` unset and prints nothing — same
# absent-is-null contract as everything else here, not a ceiling of zero.
io_sum() {
	[ -r "$1" ] || { echo ""; return; }
	awk -v k="$2" '
		{ for (i=2;i<=NF;i++) { split($i,a,"="); if (a[1]==k) { sum+=a[2]; seen=1 } } }
		END { if (seen) printf "%d", sum; else print "" }
	' "$1" 2>/dev/null
}

peak=$(read_one "$base/memory.peak")
current=$(read_one "$base/memory.current")
maxbytes=$(read_one "$base/memory.max")
swappeak=$(read_one "$base/memory.swap.peak")
oom=$(field "$base/memory.events" oom)
oomkill=$(field "$base/memory.events" oom_kill)
highev=$(field "$base/memory.events" high)
maxev=$(field "$base/memory.events" max)

# memory.stat, ONE read — the tmpfs note in the header has the arithmetic and
# the measurement. These DECOMPOSE `peak`; they are never added to it. An absent
# or undelegated file leaves every key empty, which num() renders as null rather
# than as a job that used zero bytes of tmpfs.
memstat=$(cat "$base/memory.stat" 2>/dev/null)
shmem=$(field_str "$memstat" shmem)
filebytes=$(field_str "$memstat" file)
anon=$(field_str "$memstat" anon)

# cpu.stat is the same `key value` shape as memory.events, but unlike those
# event counters it is a live, monotonically increasing usage clock — three
# separate `field()` calls each re-read the file from the kernel, and on an
# active cgroup the three numbers can disagree by however much CPU ran between
# reads (caught live by this file's own test against a busy dev shell).
# Reading it once into a string and parsing that snapshot three times makes
# usage/user/system one atomic view instead of three racing ones. usage_usec
# can still differ from user_usec+system_usec by ~1usec even from one atomic
# read — the kernel's cputime_adjust splits ticks proportionally and that
# division rounds — so a small gap here is the kernel, not a stale read.
cpustat=$(cat "$base/cpu.stat" 2>/dev/null)
cpuusage=$(field_str "$cpustat" usage_usec)
cpuuser=$(field_str "$cpustat" user_usec)
cpusystem=$(field_str "$cpustat" system_usec)

ioread=$(io_sum "$base/io.stat" rbytes)
iowrite=$(io_sum "$base/io.stat" wbytes)

# IDs from the cgroup name where the mint put them; env is the fallback for a
# standing runner, whose unit name carries no job id.
jobid=""
runid=""
case "$leaf" in
*-j[0-9]*-r[0-9]*-*)
	jobid=$(printf '%s' "$leaf" | sed -n 's/.*-j\([0-9][0-9]*\)-r[0-9].*/\1/p')
	runid=$(printf '%s' "$leaf" | sed -n 's/.*-j[0-9][0-9]*-r\([0-9][0-9]*\)-.*/\1/p')
	kind="jit"
	;;
*)
	kind="standing"
	;;
esac
[ -n "$runid" ] || runid="${GITHUB_RUN_ID:-}"

# WHAT `peakBytes` IS ON THIS ROW — see the header. Derived from the same `kind`
# the cgroup leaf just decided, so the label cannot disagree with the unit it
# describes, and carried explicitly so no consumer has to infer it from a name.
case "$kind" in
jit) peakbasis="job" ;;
*) peakbasis="unit-cumulative" ;;
esac

esc() { printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
num() { case "${1:-}" in '' | *[!0-9]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }

# --- wave 4c #102 lane C: the same host-load snapshot, recorded at job END -
#
# ci-throttle.sh (the job-STARTED hook) prints these four facts into the job
# log at the OTHER end of the job; see its header for the full story
# (wave4c-2026-10-07.md). Load drifts over a job's run time, so "what else was
# on this box" is a different answer at completion than it was at the start,
# and both are worth having. This hook runs inside the same process that one
# does — the job's own Runner.Worker, synchronously, before it exits (ADR
# 1751) — so the ancestry walk below finds the same pid.
#
# "unreadable" rather than null, DELIBERATELY, unlike every other field on
# this row: null here would read as "measured, and the node was idle", which
# is a confident claim this script cannot make when the read itself failed.
# The other fields on this row use null for "absent facet" (a controller not
# delegated, a cap not set) — these four have no such facet-shaped absence;
# they are either read or they are not, so the sentinel says which.
LOADAVG="${JOB_METRICS_LOADAVG:-/proc/loadavg}"
PRESSURE_CPU="${JOB_METRICS_PRESSURE_CPU:-/proc/pressure/cpu}"
# Where a co-tenant pid's cwd is resolved — "/proc" in production, a fixture
# directory in job-metrics.test.mjs, the same seam ci-throttle.sh uses for the
# same reason: a fixture pid never needs to be a live process, only a
# "$PROC_ROOT/<pid>/cwd" symlink.
PROC_ROOT="${JOB_METRICS_PROC_ROOT:-/proc}"

load1_avg() {
	local out
	[ -r "$LOADAVG" ] || { printf 'unreadable'; return; }
	out=$(awk '{print $1; exit}' "$LOADAVG" 2>/dev/null)
	case "$out" in
	'' | *[!0-9.]*) printf 'unreadable' ;;
	*) printf '%s' "$out" ;;
	esac
}

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

# THIS job's own Runner.Worker pid — the same ancestry walk ci-throttle.sh
# runs at job start, reproduced here rather than shared (the two are separate
# hook invocations, separate processes, with no file between them to share
# one). Falls back to $$ (this hook's own pid, which dies the instant it
# returns) when no Runner.Worker ancestor is found; the cost is bounded and
# the same direction as ci-throttle.sh's own fallback: this job's worker is
# then not excluded from its own co-tenant count, never a crash, and this
# hook never fails a job regardless.
self_worker_pid() {
	local p c
	p=$$
	while [ "$p" -gt 1 ] 2>/dev/null; do
		c=$(cat "$PROC_ROOT/$p/comm" 2>/dev/null) || break
		if [ "$c" = "Runner.Worker" ]; then
			printf '%s' "$p"
			return
		fi
		p=$(awk '{print $4}' "$PROC_ROOT/$p/stat" 2>/dev/null) || break
		[ -n "$p" ] || break
	done
	printf '%s' "$$"
}

HOST_LOAD_SELF_PID=$(self_worker_pid)
# Exported for the same reason ci-throttle.sh exports its SELF_PID: a test's
# fake `pgrep` can echo this exact value back rather than predicting a kernel
# pid from outside. Production pgrep neither reads nor cares about this.
export HOST_LOAD_SELF_PID

# Other Runner.Worker processes on this node and which repo each is running —
# see ci-throttle.sh's cotenant_repos() for the full reasoning (-x guards
# against a self-match; the repo comes from actions/runner's own
# _work/<repo>/<repo> layout, never a guess).
cotenant_repos() {
	local pid cwd repo out=""
	command -v pgrep >/dev/null 2>&1 || { printf 'unreadable'; return; }
	for pid in $(pgrep -x Runner.Worker 2>/dev/null); do
		[ "$pid" = "$HOST_LOAD_SELF_PID" ] && continue
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

hostload=$(load1_avg)
hostpressure=$(cpu_pressure_avg10)
hostreposline=$(cotenant_repos)
if [ "$hostreposline" = "unreadable" ]; then
	hostcotenants="unreadable"
	hostrepos_json='"unreadable"'
elif [ -z "$hostreposline" ]; then
	hostcotenants=0
	hostrepos_json="[]"
else
	hostcotenants=$(($(printf '%s' "$hostreposline" | tr -cd ',' | wc -c) + 1))
	hostrepos_json=$(
		printf '%s' "$hostreposline" | awk -F',' '
			{
				printf "["
				for (i = 1; i <= NF; i++) {
					v = $i
					gsub(/\\/, "\\\\", v)
					gsub(/"/, "\\\"", v)
					printf "%s\"%s\"", (i > 1 ? "," : ""), v
				}
				printf "]"
			}
		'
	)
fi
# A bare numeric token is passed through as a JSON number; the literal
# "unreadable" is quoted as a JSON string. load1_avg/cpu_pressure_avg10/the
# arithmetic above already guarantee every non-"unreadable" value here is a
# plain digit-and-dot token, so nothing else can reach this unescaped.
json_num_or_str() {
	case "$1" in
	unreadable) printf '"unreadable"' ;;
	*) printf '%s' "$1" ;;
	esac
}

# `max` here is memory.max, which is the literal string "max" when uncapped —
# num() turns that into null rather than inventing a ceiling.
line=$(
	printf '{"ts":"%s","node":"%s","kind":"%s","repo":"%s","runId":%s,"jobId":%s,' \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(esc "$(hostname -s)")" "$kind" \
		"$(esc "${GITHUB_REPOSITORY:-}")" "$(num "$runid")" "$(num "$jobid")"
	printf '"job":"%s","runner":"%s","status":"%s",' \
		"$(esc "${GITHUB_JOB:-}")" "$(esc "${RUNNER_NAME:-}")" "$(esc "${JOB_STATUS:-}")"
	printf '"peakBytes":%s,"peakBasis":"%s","currentBytes":%s,"swapPeakBytes":%s,"limitBytes":%s,' \
		"$(num "$peak")" "$(esc "$peakbasis")" "$(num "$current")" "$(num "$swappeak")" \
		"$(num "$maxbytes")"
	printf '"shmemBytes":%s,"fileBytes":%s,"anonBytes":%s,' \
		"$(num "$shmem")" "$(num "$filebytes")" "$(num "$anon")"
	printf '"oom":%s,"oomKill":%s,"highEvents":%s,"maxEvents":%s,' \
		"$(num "$oom")" "$(num "$oomkill")" "$(num "$highev")" "$(num "$maxev")"
	printf '"cpuUsageUsec":%s,"cpuUserUsec":%s,"cpuSystemUsec":%s,' \
		"$(num "$cpuusage")" "$(num "$cpuuser")" "$(num "$cpusystem")"
	printf '"ioReadBytes":%s,"ioWriteBytes":%s,"cgroup":"%s",' \
		"$(num "$ioread")" "$(num "$iowrite")" "$(esc "$cg")"
	printf '"hostLoad1m":%s,"hostCpuPressureAvg10":%s,"hostCoTenants":%s,"hostCoTenantRepos":%s}' \
		"$(json_num_or_str "$hostload")" "$(json_num_or_str "$hostpressure")" \
		"$(json_num_or_str "$hostcotenants")" "$hostrepos_json"
)

# A record with no peak is not a measurement. Say so on stderr — which the job
# log captures — rather than writing a row that reads as "this job used null".
if [ -z "$peak" ]; then
	echo "job-metrics: no readable memory.peak at $base — nothing recorded" >&2
else
	mkdir -p "$(dirname "$OUT")" 2>/dev/null
	printf '%s\n' "$line" >>"$OUT" 2>/dev/null
fi

# NO memory.peak RESET HERE, DELIBERATELY. One used to sit at this point and
# never once took effect — see the standing-runner note in the header for the
# measurement and for why no permission, `Delegate=` or helper change would fix
# it. A standing unit's peak is cumulative at the source; `peakBasis` says so on
# every row rather than a no-op pretending otherwise.

# ROTATE LAST, so a full disk or a race costs the rotation rather than the record.
#
# THE TRIM THAT WAS HERE COULD LOSE A ROW, and it never ran. It was
# `tail -n MAX_LINES > tmp && mv tmp OUT`: a hook on another runner of the same
# node (up to four run at once) that appended between the `tail` and the `mv`
# wrote its row into the inode the `mv` then discarded. And its cap was 20,000
# LINES, sized for a ~250-byte row: at the real ~590 bytes that is ~11.8 MB,
# past the reader's old 1 MiB buffer ten times over, so claw-1 (1.1 MB, 1,935
# rows) broke the read long before the trim would ever have fired.
#
# A RENAME CANNOT LOSE THE ROW BEING WRITTEN. `>>` opens the path, then writes to
# the inode it opened. A writer that opened before the `mv` lands in `.1`,
# which the reader reads; one that opens after creates a fresh file. No bytes
# are copied, so there is no window in which an append goes nowhere.
#
# TWO ROTATORS COULD STILL CLOBBER `.1`: both see an old first row, the first
# renames, a third hook appends a fresh file, and the second renames THAT over
# the `.1` holding the whole previous window. So the decision is re-made under
# `flock`, after the lock is held — the second rotator then sees the fresh file
# and does nothing. `-n`: a hook never waits on another hook, and whoever holds
# the lock is already doing the rotation. No `flock` on the box means no
# rotation, never a failed job; the reader's 64 MiB ceiling is the margin.
#
# The age test is on the FIRST row, which is the oldest because the file is
# append-only. Epoch seconds, not a string comparison, so no locale collation
# can reorder two timestamps.
rotate_due() {
	[ -f "$OUT" ] || return 1
	first_ts=$(head -c 256 "$OUT" 2>/dev/null | head -n 1 | sed -n 's/^{"ts":"\([^"]*\)".*/\1/p')
	if [ -n "$first_ts" ]; then
		first_epoch=$(date -u -d "$first_ts" +%s 2>/dev/null)
		now_epoch=$(date -u +%s 2>/dev/null)
		case "$first_epoch$now_epoch" in
		'' | *[!0-9]*) : ;;
		*) [ $((now_epoch - first_epoch)) -gt $((RETENTION_DAYS * 86400)) ] && return 0 ;;
		esac
	fi
	size=$(wc -c <"$OUT" 2>/dev/null | tr -d ' ')
	case "$size" in
	'' | *[!0-9]*) return 1 ;;
	esac
	[ "$size" -gt "$MAX_BYTES" ]
}

case "$RETENTION_DAYS$MAX_BYTES" in
'' | *[!0-9]*) : ;;
*)
	if rotate_due; then
		(
			flock -n 9 || exit 0
			rotate_due && mv -f "$OUT" "$OUT.1"
		) 2>/dev/null 9>>"$OUT.lock"
	fi
	;;
esac

# THE HARVESTER SELF-HEAL (#47). This hook is the one piece of fleet plumbing
# proven to run on every node on every job — 2026-09-22's finding was that the
# memory harvester was `active` on three claws while matching zero runner
# cgroups and absent on the other five, and NOTHING on the nodes noticed. The
# unit's own `Restart=always` covers a crashed process; it cannot cover a unit
# somebody stopped, or one a daemon-reload lost. One best-effort `start` here
# costs a D-Bus call at job completion and closes that hole: the next job that
# finishes on a node re-arms its sampler. `start` on an already-active unit is
# a no-op, and XDG_RUNTIME_DIR is spelled the same way ci-throttle-install.sh
# spells it — without it `systemctl --user` fails looking for a bus, silently,
# which is the exact quiet failure this line exists to avoid being.
XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR
systemctl --user start runner-mem-harvest.service >/dev/null 2>&1 || :

exit 0
