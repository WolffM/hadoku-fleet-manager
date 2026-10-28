#!/usr/bin/env bash
# runners-slice-install — step 1c: put every CI runner in ONE cgroup with a
# memory ceiling, so CI cannot take the host down.
#
# Inputs (leading assignments on stdin, as the other node-half scripts do):
#   APPLY=0|1        write anything
#   RESTART=0|1      restart idle runners so Slice= takes effect
#   MAX_MB=<n>       MemoryMax for the whole runner set
#   SWAP_MB=<n>      MemorySwapMax for the whole runner set
#   UNIT_MB=<n>      MemoryMax for EACH runner unit (0 = leave unset).
#                    REQUIRED — there is NO default. See step 6 below: the
#                    number is the node's own slice ceiling, which only the
#                    caller knows, and a default here would be a SECOND rule
#                    for a question that already has one.
#   SLICE_NAME=<s>   which slice to create and place units in.
#                    Defaults to runners.slice. hokon overrides it to
#                    ci-runner.slice, which ALREADY contains its two runner
#                    units — defaulting there would migrate them out of a
#                    capped slice, a containment change wearing a cap's
#                    clothes. Never hardcode this again.
#   MANAGE_UNIT=0|1  write the slice UNIT FILE itself. Default 1.
#                    0 = the slice is HAND-AUTHORED; place units into it and
#                    set per-unit caps, but never rewrite it. hokon's
#                    ci-runner.slice carries MemoryHigh=12G, CPUWeight=50 and
#                    IOWeight=50 — none of which this script's body has, and
#                    the CPU/IO weights are the whole reason that unit exists:
#                    "CI should lose to interactive work, not compete with it."
#                    Overwriting it would silently restore the condition that
#                    left the box unusable for 11 minutes on 2026-08-04.
#                    The ceilings are still AUDITED against the manifest, so a
#                    hand-authored unit cannot quietly drift.
#   MIN_FREE_MB=<n>  derive MAX_MB as (measured MemTotal - MIN_FREE_MB).
#                    Ignored when MAX_MB is given. Deriving on the NODE is
#                    deliberate: the manifest's ramGb is rounded (claw-1 says
#                    11G and measures 11885MiB), and a ceiling computed from
#                    the rounded figure silently reserves the wrong amount.
#
# WHY AN AGGREGATE SLICE AND NOT PER-UNIT LIMITS
# ----------------------------------------------
# Every runner unit reports MemoryMax=infinity and MemorySwapMax=infinity today,
# so a burst is bounded only by the kernel's OOM killer picking victims — which
# on 2026-08-24/25 it did, five times, always on claw-2. An aggregate ceiling
# needs no per-job distribution to be safe: it says "CI in total may not exceed
# this", which is the one guarantee the host actually needs. Per-unit limits are
# step 6, and the harvest has now delivered them — see below.
#
# STEP 6: THE PER-UNIT CEILING COMES FROM THE CALLER, AND HAS NO DEFAULT
# ----------------------------------------------------------------------
# It was a flat 4096, chosen from a harvest of 674 job windows >= 15s whose
# peak ANON per window was p50 433, p95 2663, p99 2906, max 2954 MB. The tail
# was tight and 4096 killed zero of them, so the number looked safe.
#
# IT WAS NOT. Issue #26: brave-quartet's `wasm-size` job was OOM-killed on
# claw-2 against this unit's own 4 GiB — eight parallel `rustc` processes, and
# a sample that contained no such build cannot bound one. GitHub recorded the
# step as CANCELLED, so nothing in CI said "out of memory" either.
#
# THE RULE NOW IS `unitMemoryMaxMb()` IN src/runners/ephemeral.ts, and it is
# ONE rule with ONE implementation: the per-unit cap is the node's own slice
# ceiling (measured MemTotal - MIN_FREE_MB), and a declared `unitMaxMb` may
# only WIDEN it. The operator's rule of 2026-09-12 is that there is no hard
# per-job cap; the floor that keeps the claw alive is MIN_FREE_MB, and the
# slice ceiling already expresses it.
#
# WHY NO DEFAULT HERE. Until 2026-09-19 this script defaulted to 4096 while the
# MINTER computed the ceiling — two provisioning paths, two rules, and measured
# on claw-4: the standing `actions-runner-hadoku-fleet-manager.service` read
# MemoryMax=4294967296 while `warm-claw-4-hadoku-fleet-manager.service` on the
# same box read 14562623488. A default is what let those diverge silently, so a
# caller that supplies no UNIT_MB now gets a REFUSAL rather than a guess. The
# caller is `deploy-runners-slice.mjs`, which imports the rule from dist/.
#
# This is still not right-sizing, and it cannot prevent slice exhaustion: N
# units at the ceiling exceed every claw's aggregate cap. MAX_MB bounds the
# total; this bounds ONE unit, and keeps a kill ATTRIBUTABLE to a named unit
# instead of an unexplained exit 137.
#
# NO MemoryHigh. It would throttle by reclaiming into swap, and on claw-1's
# 7200rpm disk at 13.6% iowait that thrashes rather than protects — the same
# reasoning the plan gives for not using MemoryHigh-driven sampling there.
# One exception, owned elsewhere: a SHARED HOSTING node's runners.slice gets a
# MemoryHigh from `fleet hosting` (scripts/lib/hosting.mjs CI_HEADROOM), where
# every minted unit runs at MemorySwapMax=0. This script never writes or resets it.
#
# BOTH MANAGERS. claw-2 runs 24 units under system.slice and 3 under user@1000,
# and BOTH produced OOM victims. A slice created only in the system manager
# silently misses the second set — the failure mode this script exists to close.
#
# MINTED UNITS ARE AUDITED, NEVER REPAIRED (2026-09-14)
# -----------------------------------------------------
# The three globs this script places (`actions.runner.*`, `actions-runner-*`,
# `github-runner*`) are all STANDING units, and under all-JIT the claws have
# none: every runner is now a transient `systemd-run --user` unit named `jit-*`
# or `warm-*`. So this script placed nothing on six of seven claws and said so
# by reporting in_slice=0/0 — a clean sheet for an empty set, which is the
# "asserts cleanliness without looking" failure the enumeration notes above
# already name once. Measured on claw-3 2026-09-14 20:20Z: three live units, all
# Slice=app.slice (MemoryMax=infinity), while runners.slice sat loaded at
# 13,870 MiB and held nothing.
#
# They are counted here and fixed ELSEWHERE, and the split is not squeamishness:
#   - a transient unit has no unit FILE, so a drop-in is not the mechanism that
#     places it; `--property=Slice=` at `systemd-run` time is. The minter
#     (src/runners/ephemeral.ts, buildSpawnPlan/buildWarmSpawnPlan) is the only
#     writer, exactly as `syncHostedFallback` is the only writer of CI_RUNNER.
#   - a `jit-*` name is single-use, so a drop-in written for one would be dead
#     config the moment the job ends, accumulating one file per mint forever.
#   - RESTARTING one kills the job it is running and orphans its registration.
#     `place()` restarts to relocate; that repair must never reach these.
# So drift here reports "the next mint fixes this", never "--restart".
#
# Supervision (KillMode=mixed, Restart=always) is NOT asserted on them either: a
# transient unit is Restart=no by design and serves one job. Asserting it would
# paint every JIT unit as drift and leave the gate permanently red, which is a
# gate nobody reads.
#
# THE io CONTROLLER REACHES THE SLICE (2026-09-16)
# ------------------------------------------------
# Every job row `job-metrics.sh` writes carries `ioReadBytes: null`, because it
# reads `io.stat` out of the job's own cgroup and that file does not exist there.
# Nothing about the hardware is in the way. Measured 2026-09-16:
#
#   - the kernel's ROOT cgroup exposes io on all seven claws
#     (`cgroup.controllers` lists `cpuset cpu io memory hugetlb pids rdma misc`)
#   - and it ACCOUNTS: `system.slice/ssh.service/io.stat` on claw-4 reads
#     `8:16 rbytes=405504 wbytes=262144 rios=65 wios=64 dbytes=0 dios=0`, over
#     mq-deadline on every device. So a delegated controller would report real
#     numbers rather than an empty file.
#   - but `user@<uid>.service` is delegated `cpu memory pids`, and
#     `runners.slice` offers its children `memory pids`.
#
# IT TAKES TWO WRITES, NOT ONE, and the second is the easy one to miss.
#
#  1. DELEGATION, so the user manager may use the controller at all. The
#     UNIT-FILE key is `Delegate=`. `DelegateControllers=` is the READ-ONLY D-Bus
#     property that `systemctl show` prints, and systemd IGNORES it in a unit
#     file — "Unknown key 'DelegateControllers' in section [Service]", systemd
#     257, checked with `systemd-analyze verify`. A drop-in written with the
#     property name installs cleanly, reloads cleanly and changes nothing.
#
#  2. A MEMBER THAT ASKS FOR IT. A controller lands in a cgroup's
#     `cgroup.subtree_control` because one of that cgroup's MEMBERS needs it,
#     never because the cgroup itself does. That is why `runners.slice` carries
#     no `cpu` in its subtree_control on any claw even though the manager says
#     `DefaultCPUAccounting=yes`: cgroup-v2 CPU accounting is free (`cpu.stat` is
#     a core file, not a controller file), so systemd does not enable the
#     controller merely to account. io has no such exemption, and nothing under
#     the slice asks for io — a minted unit carries `MemoryMax` and nothing else.
#     `DefaultIOAccounting=yes` in the USER manager is what makes every unit
#     below it ask.
#
#     The same mechanism is already visible on the claws, for this exact
#     controller: `docker.service` and `containerd.service` are `Delegate=yes`,
#     which carries io up into `system.slice`'s subtree_control, and
#     `ssh.service` — which declares `IOAccounting=no` and asks for nothing — has
#     a working io.stat purely as their sibling.
#
# THE MINTER IS NOT THE LEVER HERE. `--property=IOAccounting=yes` at
# `systemd-run` time would arm one unit at a time, but the minter is
# `src/runners/ephemeral.ts` and this is the node half. The manager-level default
# also covers the standing `actions-runner-*` units and the `warm-*` listeners
# without a second writer, which is the `syncHostedFallback` rule: one writer.
#
# daemon-reexec, NEVER a restart. A systemd manager computes the controllers it
# may use ONCE, when it starts, so a user manager that was already running when
# the delegation landed cannot use io until it re-executes. `daemon-reexec`
# serializes its state, re-execs the binary and restores it — every running unit
# survives it, which is exactly what a restart of `user@<uid>.service` would NOT
# do: that kills every live job on the node. It is deferred anyway while any
# runner is BUSY, on the same rule as `place()`.
set -u

APPLY="${APPLY:-0}"
RESTART="${RESTART:-0}"
MAX_MB="${MAX_MB:-0}"
SWAP_MB="${SWAP_MB:-0}"
UNIT_MB="${UNIT_MB-}"
CI_OOM="${CI_OOM-}"
SLICE_NAME="${SLICE_NAME:-runners.slice}"
MIN_FREE_MB="${MIN_FREE_MB:-0}"
MANAGE_UNIT="${MANAGE_UNIT:-1}"
case "$SLICE_NAME" in
*.slice) ;;
*) echo "SLICE-FAIL SLICE_NAME='$SLICE_NAME' must end in .slice"; exit 0 ;;
esac
# NO DEFAULT, deliberately — see step 6. A missing UNIT_MB used to mean 4096,
# which is a second rule for a number `unitMemoryMaxMb()` already answers, and
# the two drifted on every node that also mints. Refusing is the only reading
# of "I was not told" that cannot quietly install the wrong ceiling.
case "$UNIT_MB" in
'') echo "SLICE-FAIL UNIT_MB is required and has no default — the caller computes it with unitMemoryMaxMb() (the node's slice ceiling); pass 0 to leave the per-unit cap unset"; exit 0 ;;
esac
# The OOM rank has no default either: it is CI_OOM_SCORE_ADJ in
# src/runners/hosting-record.ts, and the caller imports it from there.
case "$CI_OOM" in
'') echo "SLICE-FAIL CI_OOM is required and has no default — the caller passes CI_OOM_SCORE_ADJ"; exit 0 ;;
esac
for v in MAX_MB SWAP_MB UNIT_MB MIN_FREE_MB CI_OOM; do
	eval "val=\${$v}"
	case "$val" in '' | *[!0-9]*) echo "SLICE-FAIL $v='$val' is not a number"; exit 0 ;; esac
done
# Derive the ceiling from what this box actually has, when asked to.
if [ "$MAX_MB" = 0 ] && [ "$MIN_FREE_MB" -gt 0 ]; then
	memtotal_mb=$(awk '/^MemTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)
	case "$memtotal_mb" in '' | *[!0-9]*) memtotal_mb=0 ;; esac
	if [ "$memtotal_mb" -le "$MIN_FREE_MB" ]; then
		echo "SLICE-FAIL MemTotal=${memtotal_mb}MiB is not above MIN_FREE_MB=${MIN_FREE_MB}"
		exit 0
	fi
	MAX_MB=$((memtotal_mb - MIN_FREE_MB))
fi
[ "$MAX_MB" -gt 0 ] || { echo "SLICE-FAIL MAX_MB must be set (or MIN_FREE_MB, to derive it)"; exit 0; }

# Overridable ONLY so the write path can be exercised against a scratch root —
# nothing in production sets these, and `deploy-runners-slice.mjs` prepends no
# assignment for them. Mutation-testing an installer against the live target is
# the failure the guards exist to stop, so the seam is the cheaper half.
SYS_DIR="${SYS_DIR:-/etc/systemd/system}"
USER_CONF_DIR="${USER_CONF_DIR:-/etc/systemd/user.conf.d}"
CGROOT="${CGROUP_ROOT:-/sys/fs/cgroup}"
# /proc, for the OOM rank, with a seam for the same reason: a fixture's pids
# must name fixture files, never a real process on the box running the test.
PROCROOT="${PROC_ROOT:-/proc}"
# How long to wait for the system manager's realize queue to hand io to the
# user manager before giving up and saying so. Seconds, polled once per second.
IO_WAIT_SECS="${IO_WAIT_SECS:-10}"
USR_DIR="$HOME/.config/systemd/user"
UNIT_BODY="[Unit]
Description=CI runners, memory-capped as a group (step 1c)
Documentation=file:///home/hadoku/repos/hadoku_site/docs/planning/fleet-rearchitecture-2026-08-25.md
Before=slices.target

[Slice]
MemoryAccounting=yes
MemoryMax=${MAX_MB}M
MemorySwapMax=${SWAP_MB}M
"

changed=0
capped=0
needs_operator=0

# READS DO NOT NEED ROOT — and routing them through `sudo -n` is how hokon's two
# system runner units became invisible to this script. There, sudo -n fails, so
# `sudo -n systemctl list-units` returned NOTHING and the run reported on the 24
# user-manager units alone while claiming to have covered the node. An
# enumeration that silently returns empty is the "asserts cleanliness without
# looking" failure, and it is worse here than a hard error would have been.
# `systemctl show` and `list-units` both work unprivileged; only WRITES need sudo.
sysshow() { systemctl show "$1" -p "$2" --value 2>/dev/null; }

# THE KERNEL, not the config. `systemctl show -p MemoryMax` reports the LOADED
# DROP-IN, which is what systemd would apply at next start — not what the cgroup
# currently enforces. Those diverge whenever a drop-in was written without the
# value being pushed onto the live cgroup, and on 2026-08-28 they diverged on 36
# of 71 claw units and all 26 hokon units while `check:slice` reported green.
#
# §12.28 concluded the opposite ("a bare daemon-reload moved all 24 to 4096") and
# was measured with sysshow, so it could not see the difference. Re-measured
# against /sys/fs/cgroup: daemon-reload does NOT re-realize MemoryMax on a
# running unit; `systemctl set-property --runtime` does.
#
# THREE ANSWERS, NEVER TWO (#98). "" means the unit has NO cgroup — it is
# stopped, holds no process, and a caller may fall back to its config because
# there is nothing live to diverge from it. A unit that HAS a cgroup whose
# memory.max could not be read answers `unreadable`, never "": that was the
# same empty string until the mutation pass, so every caller's config fallback
# fired for a RUNNING unit and the kernel read this function exists for was
# replaced by the very `systemctl show` it was written to avoid.
kernelmax() { # $1=unit -> live memory.max in bytes or `max`, `unreadable`, or "" if no cgroup
	cg=$(systemctl show "$1" -p ControlGroup --value 2>/dev/null)
	[ -n "$cg" ] || cg=$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user show "$1" -p ControlGroup --value 2>/dev/null)
	[ -n "$cg" ] || return 0
	km_v=$(cat "${CGROOT}${cg}/memory.max" 2>/dev/null)
	printf '%s\n' "${km_v:-unreadable}"
}
# The SLICE's ceiling, from the kernel, in one named manager — the slice
# counterpart of kernelmax(), which resolves units and so tries the system
# manager first. A slice exists in BOTH managers under one name, so the caller
# must say which copy it means.
#
# `inactive` is its own answer: a slice holding nothing has no ControlGroup and
# no cgroup directory (hokon's user-manager runners.slice, measured 2026-10-10),
# so there is no kernel value to read and nothing running for one to bound. The
# driver judges that case against the CONFIG token reported beside it, because
# config is what systemd applies the moment the slice next activates — and only
# then, never as a stand-in for a cgroup that exists.
slicemax() { # $1=system|user $2=memory.max|memory.swap.max -> bytes|max|inactive|unreadable
	if [ "$1" = system ]; then
		sm_cg=$(systemctl show "$SLICE_NAME" -p ControlGroup --value 2>/dev/null)
	else
		sm_cg=$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user show "$SLICE_NAME" -p ControlGroup --value 2>/dev/null)
	fi
	if [ -z "$sm_cg" ]; then
		echo inactive
		return 0
	fi
	sm_v=$(cat "${CGROOT}${sm_cg}/$2" 2>/dev/null)
	printf '%s\n' "${sm_v:-unreadable}"
}
# Resolve a property from WHICHEVER manager actually has the unit.
#
# `systemctl show` answers for a unit it has never heard of, and the answer looks
# real: for a USER unit the SYSTEM manager returns `infinity`, not an error and
# not an empty string. An emptiness check therefore never fires, and every one of
# hokon's 24 user units read as uncapped moments after being capped. LoadState is
# the only honest discriminator — it says `not-found` where MemoryMax says
# `infinity`.
# The slice a unit's processes are ACTUALLY in, derived from its cgroup path.
#
# `Slice=` is config and `ControlGroup` is the kernel, and they disagree for as
# long as a unit keeps running after its drop-in changed — systemd relocates on
# the next START, never on a reload. Reading config here is what let 24 of
# hokon's 27 runners declare ci-runner.slice, run in app.slice, and be skipped by
# the very repair that exists to move them.
#
# A STOPPED unit reports no ControlGroup. That is not drift: it has no processes
# to be misplaced and it will land in its declared slice when it next starts. So
# fall back to the declared value — which also stops a repair from START-ing a
# unit somebody deliberately stopped.
effslice() { # $1=unit -> slice name its processes run in
	ecg=$(unitprop "$1" ControlGroup)
	if [ -n "$ecg" ]; then
		ecg=${ecg%/*}
		printf '%s\n' "${ecg##*/}"
	else
		unitprop "$1" Slice
	fi
}
unitprop() { # $1=unit $2=prop
	if [ "$(systemctl show "$1" -p LoadState --value 2>/dev/null)" = "loaded" ]; then
		systemctl show "$1" -p "$2" --value 2>/dev/null
		return 0
	fi
	XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user show "$1" -p "$2" --value 2>/dev/null
}
# The LOWEST OOM rank among a unit's live processes, from the kernel; empty
# when the unit has no process. Every process counts, not the main one: the
# repair raises them all, and a job's worker is not the unit's MainPID.
minoom() { # $1=unit
	mo_cg=$(unitprop "$1" ControlGroup)
	[ -n "$mo_cg" ] || return 0
	for mo_p in $(cat "${CGROOT}${mo_cg}/cgroup.procs" 2>/dev/null); do
		cat "${PROCROOT}/${mo_p}/oom_score_adj" 2>/dev/null
	done | sort -n | head -n 1
}
syslist() { systemctl list-units "$@" --all --no-legend 2>/dev/null | awk '{print $1}'; }
usrlist() { XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user list-units "$@" --all --no-legend 2>/dev/null | awk '{print $1}'; }
# Transient minted runners, USER manager only — `systemd-run --user` is the only
# thing that creates them (see the MINTED UNITS note in the header), so a system
# scan here would be a scan of a set that cannot exist. The two prefixes are
# JIT_PREFIX and WARM_PREFIX in src/runners/ephemeral.ts; the guard test beside
# this script fails if they drift apart.
mintlist() { usrlist 'jit-*' 'warm-*'; }

restarted=0
busy=0
skipped=0

# Which runner dirs are BUSY — never restart one mid-job.
busy_units=""
for w in $(pgrep -x Runner.Worker 2>/dev/null); do
	cg=$(tail -1 "/proc/$w/cgroup" 2>/dev/null) || continue
	busy_units="$busy_units $(basename "$cg")"
done

write_if_changed() { # $1=path $2=content
	if [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; then return 1; fi
	[ "$APPLY" = 1 ] || return 0
	printf '%s' "$2" >"$1"
	return 0
}

# --- the slice units --------------------------------------------------------
# NEVER blind-overwrite an existing slice unit. hokon's ci-runner.slice is
# hand-authored and carries MemoryHigh=12G, CPUWeight=50 and IOWeight=50 on top of
# the two ceilings this script manages. UNIT_BODY has none of those, and the CPU
# and IO weights are the entire point of that unit — "CI should lose to
# interactive work, not compete with it", written after a runaway job left the box
# unusable for 11 minutes on 2026-08-04. Rewriting it would have restored exactly
# that condition while reporting success.
#
# MANAGE_UNIT=0 says the unit is somebody else's; place runners into it and cap
# them, but do not author it. The ceilings are still ASSERTED against the
# manifest below, so a hand-authored unit cannot silently drift either.
if [ "$APPLY" = 1 ] && [ "$MANAGE_UNIT" = 1 ]; then
	# Written only when it differs: on a cut-over node admin's run writes it and
	# ci's run, which has no sudo, finds it already right.
	if [ "$(cat "$SYS_DIR/$SLICE_NAME" 2>/dev/null)" != "$(printf '%s' "$UNIT_BODY")" ]; then
		sudo -n mkdir -p "$SYS_DIR" 2>/dev/null
		printf '%s' "$UNIT_BODY" | sudo -n tee "$SYS_DIR/$SLICE_NAME" >/dev/null 2>&1 ||
			echo "SLICE-WARN could not write the system slice (no passwordless sudo?)"
	fi
	mkdir -p "$USR_DIR"
	printf '%s' "$UNIT_BODY" >"$USR_DIR/$SLICE_NAME"
	sudo -n systemctl daemon-reload 2>/dev/null
	XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user daemon-reload 2>/dev/null
elif [ "$APPLY" = 1 ]; then
	echo "SLICE-UNMANAGED $SLICE_NAME left as authored; ceilings audited, not written"
	# A user-manager copy is still needed when user units are placed into it: a
	# user unit cannot join a slice its own manager has never heard of.
	if [ "$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user show "$SLICE_NAME" -p LoadState --value 2>/dev/null)" != "loaded" ]; then
		mkdir -p "$USR_DIR"
		printf '%s' "$UNIT_BODY" >"$USR_DIR/$SLICE_NAME"
		echo "SLICE-USER-CREATED $SLICE_NAME in the user manager (none existed)"
	fi
	XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user daemon-reload 2>/dev/null
fi

# --- put each runner unit in it --------------------------------------------
place() { # $1=unit $2=scope(system|user)
	unit="$1"
	scope="$2"
	# Compare BOTH properties. Keying only on Slice= meant a unit already in the
	# slice was skipped before the per-unit cap could be written, so step 6 applied
	# to nothing and reported changed=0 — a no-op that looked like "already done".
	want_unit=$((UNIT_MB * 1024 * 1024))
	[ "$UNIT_MB" = 0 ] && want_unit=infinity
	if [ "$scope" = system ]; then
		d="$SYS_DIR/$unit.d"
		# EFFECTIVE, not declared — see effslice. This read is the idempotency
		# gate, and a gate reading config shares its blind spot with the repair
		# below, so both fail together and report changed=0.
		cur=$(effslice "$unit")
		# KERNEL, not config — this comparison is the idempotency gate, so reading
		# the drop-in here makes every config-correct-but-unrealized unit skip the
		# very fix it needs. That is what made a fleet-wide APPLY report changed=0
		# while 11 units sat at the wrong ceiling.
		cur_mem=$(kernelmax "$unit")
		[ -n "$cur_mem" ] || cur_mem=$(sysshow "$unit" MemoryMax)
	else
		d="$USR_DIR/$unit.d"
		export XDG_RUNTIME_DIR="/run/user/$(id -u)"
		cur=$(effslice "$unit")
		cur_mem=$(kernelmax "$unit")
		[ -n "$cur_mem" ] || cur_mem=$(systemctl --user show "$unit" -p MemoryMax --value 2>/dev/null)
	fi
	# The OOM rank, from the KERNEL: the lowest oom_score_adj in the unit, not
	# the drop-in. CI is the first thing a global OOM takes (CI_OOM in
	# src/runners/hosting-record.ts). A unit with no process has nothing to
	# rank, and its drop-in carries the score into the next start.
	cur_oom=$(minoom "$unit")
	[ -n "$cur_oom" ] || cur_oom=$CI_OOM
	[ "$cur" = "$SLICE_NAME" ] && [ "$cur_mem" = "$want_unit" ] && [ "$cur_oom" -ge "$CI_OOM" ] && return 0
	changed=$((changed + 1))
	[ "$APPLY" = 1 ] || return 0
	# STEP 6, the per-unit cap. The slice ceiling protects the HOST; this stops one
	# runaway consuming the entire CI budget and taking every sibling job with it.
	# hokon's ci-runner.slice exists because a taskauto job reached 50.2 GB on
	# 2026-08-04 — a per-unit cap is what turns that into one failed job.
	#
	# THE NUMBER IS THE CALLER'S, AND IT IS THIS NODE'S SLICE CEILING. Not one
	# fleet-wide constant and not twenty-six per-repo ones: `unitMemoryMaxMb()`
	# says a unit may reach everything the slice is allowed to hold, because the
	# floor that protects the box is MIN_FREE_MB and the ceiling already carries
	# it. A cap BELOW that ceiling is a second, tighter limit nobody declared —
	# which is what killed brave-quartet's build (#26).
	unit_cap=""
	[ "$UNIT_MB" -gt 0 ] && unit_cap="MemoryMax=${UNIT_MB}M
"
	body="[Service]
Slice=${SLICE_NAME}
OOMScoreAdjust=${CI_OOM}
${unit_cap}"
	if [ "$scope" = system ]; then
		# A system drop-in needs root. On a node without passwordless sudo
		# (hokon) this is the honest stopping point: say which unit could not be
		# written and keep going, rather than reporting `changed` for a file that
		# was never created.
		sudo -n mkdir -p "$d" 2>/dev/null
		if ! printf '%s' "$body" | sudo -n tee "$d/10-runners-slice.conf" >/dev/null 2>&1; then
			needs_operator=$((needs_operator + 1))
			echo "NEEDS-OPERATOR $unit (no passwordless sudo; system drop-in not written)"
			return 0
		fi
	else
		mkdir -p "$d"
		printf '%s' "$body" >"$d/10-runners-slice.conf"
	fi
	# PUSH THE CEILING ONTO THE LIVE CGROUP. The drop-in alone governs only the
	# NEXT start; `set-property --runtime` is what reaches the running cgroup.
	# §12.28 removed this on the belief that daemon-reload sufficed — measured
	# with `systemctl show`, which reports config. It does not. --runtime keeps
	# the persistent drop-in the single durable source of truth.
	#
	# Slice= placement genuinely CANNOT be changed live; that still waits for a
	# restart, which is why a unit can be correctly capped and still sit in the
	# wrong slice.
	if [ "$UNIT_MB" -gt 0 ]; then
		if [ "$scope" = system ]; then
			sudo -n systemctl set-property --runtime "$unit" "MemoryMax=${UNIT_MB}M" >/dev/null 2>&1
		else
			XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user set-property --runtime "$unit" "MemoryMax=${UNIT_MB}M" >/dev/null 2>&1
		fi
	fi

	# RAISE THE LIVE PROCESSES' OOM RANK. OOMScoreAdjust= applies only at the next
	# start, and a restart kills the job, so every process already in the unit's
	# cgroup is raised in place. Raising needs no privilege; children inherit.
	if [ "$scope" = system ]; then cg=$(systemctl show "$unit" -p ControlGroup --value 2>/dev/null)
	else cg=$(systemctl --user show "$unit" -p ControlGroup --value 2>/dev/null); fi
	# The cgroup is read under CGROOT, so a fixture's cgroup tree names the
	# fixture's pids and never a real process on the box running the test.
	# A process that is not the CI user's own is left alone; this never sudos.
	if [ -n "$cg" ]; then
		for p in $(cat "$CGROOT$cg/cgroup.procs" 2>/dev/null); do
			[ -O "$PROCROOT/$p" ] || continue
			cur=$(cat "$PROCROOT/$p/oom_score_adj" 2>/dev/null) || continue
			[ "$cur" -lt "$CI_OOM" ] && { echo "$CI_OOM" >"$PROCROOT/$p/oom_score_adj"; } 2>/dev/null || true
		done
	fi

	# Slice= only takes effect on a fresh start, and restarting a runner mid-job
	# kills that job — so busy ones are reported and picked up next run, exactly
	# as the throttle installer does.
	case " $busy_units " in
	*" $unit "*)
		busy=$((busy + 1))
		echo "BUSY $unit"
		return 0
		;;
	esac
	[ "$RESTART" = 1 ] || return 0
	if [ "$scope" = system ]; then
		sudo -n systemctl daemon-reload 2>/dev/null
		sudo -n systemctl stop "$unit" >/dev/null 2>&1
		sudo -n systemctl kill --kill-whom=all --signal=SIGTERM "$unit" >/dev/null 2>&1
		sleep 1
		sudo -n systemctl start "$unit" >/dev/null 2>&1
		new=$(effslice "$unit")
	else
		export XDG_RUNTIME_DIR="/run/user/$(id -u)"
		systemctl --user daemon-reload 2>/dev/null
		systemctl --user stop "$unit" >/dev/null 2>&1
		systemctl --user kill --kill-whom=all --signal=SIGTERM "$unit" >/dev/null 2>&1
		sleep 1
		systemctl --user start "$unit" >/dev/null 2>&1
		new=$(effslice "$unit")
	fi
	if [ "$new" = "$SLICE_NAME" ]; then
		restarted=$((restarted + 1))
	else
		skipped=$((skipped + 1))
		echo "PLACE-FAILED $unit (Slice=$new want=$SLICE_NAME)"
	fi
}

for u in $(syslist 'actions.runner.*' 'actions-runner-*' 'github-runner*'); do
	case "$u" in *.service) place "$u" system ;; esac
done
for u in $(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user list-units 'actions-runner-*' 'actions.runner.*' --all --no-legend 2>/dev/null | awk '{print $1}'); do
	case "$u" in *.service) place "$u" user ;; esac
done

# A per-unit drop-in is INERT until a daemon-reload, and with RESTART=0 nothing
# here used to issue one: the only reload lived in the slice branch above, which
# is skipped whenever the slice is already correct. So a run could write 27
# drop-ins, report changed=27, and leave every unit on its previous ceiling —
# the mirror of the changed=0 no-op the Slice=/MemoryMax comparison above exists
# to prevent. Measured on claw-2 on 2026-08-27: 24 units sat at 4608 MiB with the
# drop-in already reading 4096M, and a bare `daemon-reload` moved all 24 to 4096
# with no restart and no set-property. MemoryMax, unlike Slice=, applies to a
# RUNNING unit on reload — which is why this costs nothing and why omitting it
# was invisible.
if [ "$APPLY" = 1 ]; then
	sudo -n systemctl daemon-reload 2>/dev/null
	XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user daemon-reload 2>/dev/null
fi

# --- the io controller ------------------------------------------------------
# The header has the measurement and the two-writes argument. Both writes are
# SYSTEM-side and therefore need root; both are gated on APPLY alone, which is
# also the guest door — `deploy-runners-slice.mjs` forces `apply` off for a guest
# whether or not the operator named it, so nothing here can converge one.
USER_UNIT="user@$(id -u).service"
# The TEMPLATE's drop-in, for every user manager: on a cut-over node only admin
# has sudo, and a per-uid drop-in written by admin's run named admin's own
# manager, never ci's (claw-5, 2026-10-28: IO-DELEGATE-PENDING on user@ci).
IO_DELEGATE_DIR="$SYS_DIR/user@.service.d"
IO_DELEGATE_FILE="$IO_DELEGATE_DIR/10-runners-io.conf"
# THE FULL LIST, not `Delegate=io` alone. systemd ORs a controller list into the
# mask the unit already carries, so either spelling reaches the same place today
# — but restating what the stock `user@.service` delegates (`pids memory cpu`,
# systemd 257) is correct under either semantics and reads on its own.
IO_DELEGATE_BODY="[Service]
Delegate=pids memory cpu io
"
IO_ACCT_FILE="$USER_CONF_DIR/10-runners-io.conf"
IO_ACCT_BODY="[Manager]
DefaultIOAccounting=yes
"

# 0 = wrote it, 1 = already correct, 2 = could not (no passwordless sudo).
#
# Both sides of the comparison go through command substitution on purpose: `$3`
# ends in a newline and `$(cat …)` strips trailing newlines, so comparing the raw
# variable against the file would never match and every run would rewrite and
# report `changed`.
has_io() { # $1=cgroup interface file -> yes|no|-  ("-" is "I could not look")
	[ -r "$1" ] || { echo "-"; return 0; }
	case " $(cat "$1" 2>/dev/null) " in
	*" io "*) echo yes ;;
	*) echo no ;;
	esac
}

root_write() { # $1=dir $2=path $3=body
	[ "$(cat "$2" 2>/dev/null)" = "$(printf '%s' "$3")" ] && return 1
	sudo -n mkdir -p "$1" 2>/dev/null || return 2
	printf '%s' "$3" | sudo -n tee "$2" >/dev/null 2>&1 || return 2
	return 0
}

io_wrote=0
if [ "$APPLY" = 1 ]; then
	for io_what in delegate accounting; do
		case "$io_what" in
		delegate)
			io_dir="$IO_DELEGATE_DIR"
			io_file="$IO_DELEGATE_FILE"
			io_body="$IO_DELEGATE_BODY"
			;;
		*)
			io_dir="$USER_CONF_DIR"
			io_file="$IO_ACCT_FILE"
			io_body="$IO_ACCT_BODY"
			;;
		esac
		root_write "$io_dir" "$io_file" "$io_body"
		case $? in
		0)
			io_wrote=$((io_wrote + 1))
			changed=$((changed + 1))
			;;
		2)
			needs_operator=$((needs_operator + 1))
			echo "NEEDS-OPERATOR $io_file (no passwordless sudo; the io controller cannot be delegated, so every job row keeps ioReadBytes=null)"
			;;
		esac
	done
	# NEEDED, not WROTE. The first fleet-wide converge wrote both drop-ins and then
	# correctly DEFERRED the re-exec on five claws that were mid-job. On the next
	# pass those files are already right, so `io_wrote` is 0 — and keying the
	# re-exec on that would mean the five deferred nodes could never converge no
	# matter how often --confirm ran, while every run reported changed=0 and exited
	# clean. That is the no-op-that-looks-like-done shape `place()` carries a note
	# about, and the idempotency check must read OBSERVED state for the same reason
	# the repair does.
	io_mgr_cg=$(systemctl show "$USER_UNIT" -p ControlGroup --value 2>/dev/null)
	io_in_use=$(has_io "$CGROOT$io_mgr_cg/$SLICE_NAME/cgroup.controllers")
	if [ "$io_wrote" -gt 0 ] || [ "$io_in_use" != yes ]; then
		# The SYSTEM manager re-realizes user@<uid>.service's cgroup and pushes
		# `+io` into its subtree_control; the USER manager must then re-exec to
		# notice a controller it did not have when it started. See the header for
		# why this is a reexec and not a restart.
		sudo -n systemctl daemon-reload 2>/dev/null
		if [ -n "$busy_units" ]; then
			echo "IO-REEXEC-DEFERRED a runner is mid-job on this node, so the user manager keeps the controller set it started with; re-run --confirm when this node is idle"
		else
			# WAIT FOR THE KERNEL, NOT FOR THE CLIENT. `systemctl daemon-reload`
			# answers on D-Bus as soon as the reload is accepted; the cgroup realize
			# queue drains AFTER that. So the controller can still be missing from
			# the user manager's own cgroup a second later — and a manager that
			# re-execs at that moment samples a controller set WITHOUT io and keeps
			# it until something re-execs it again. That is a race whose loser is
			# silent: everything reports success and the delegation does nothing.
			#
			# Poll the file the manager is about to read, and say so when it never
			# arrives rather than re-execing into the wrong answer.
			io_deleg_cg=$(systemctl show "$USER_UNIT" -p ControlGroup --value 2>/dev/null)
			io_ready=no
			io_wait=0
			while [ "$io_wait" -lt "$IO_WAIT_SECS" ]; do
				case " $(cat "$CGROOT$io_deleg_cg/cgroup.controllers" 2>/dev/null) " in
				*" io "*)
					io_ready=yes
					break
					;;
				esac
				io_wait=$((io_wait + 1))
				sleep 1
			done
			if [ "$io_ready" != yes ]; then
				echo "IO-DELEGATE-PENDING the system manager has not handed io to $USER_UNIT after ${io_wait}s (cgroup.controllers=[$(cat "$CGROOT$io_deleg_cg/cgroup.controllers" 2>/dev/null)]); not re-execing into a stale controller set"
			# THE REASON, not just the failure. A re-exec that cannot reach the bus
			# and one the manager refuses are different jobs, and `2>/dev/null` made
			# both of them into silence.
			elif ! io_err=$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user daemon-reexec 2>&1); then
				echo "IO-REEXEC-FAILED $(printf '%s' "$io_err" | tr '\n' ' ')"
			else
				# AFTER the re-exec, never before. A re-exec restores the units it
				# was already running, so nothing it restores is re-realized: on
				# claw-2 and claw-4 (2026-09-16) the manager came back knowing
				# DefaultIOAccounting=yes, every unit reported IOAccounting=yes, and
				# the cgroup subtree_control chain was untouched. The reload is what
				# re-reads the unit files against the new manager defaults and
				# queues the realization that writes `+io`. Ordering it the other
				# way round — which is what shipped — reloads against the OLD
				# controller set and then throws the result away.
				XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user daemon-reload 2>/dev/null
			fi
		fi
	fi
fi

# READ THE KERNEL AND THE LIVE MANAGER, never the files written above. A verifier
# that reads its own writer's artifact cannot fail, and these two writes are
# exactly the case where config and effect diverge for a while: the drop-ins are
# on disk the instant they land, and the controller is usable only after the
# system manager has re-realized the cgroup and the user manager has re-exec'd.
mgr_cg=$(systemctl show "$USER_UNIT" -p ControlGroup --value 2>/dev/null)
slice_cg=$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user show "$SLICE_NAME" -p ControlGroup --value 2>/dev/null)
# An EMPTY slice is inactive and reports no ControlGroup at all, so derive the
# path — a user slice with no `Slice=` of its own sits directly under the user
# manager's own cgroup. Same omission the `live_user_load` note above records.
if [ -z "$slice_cg" ] || [ ! -d "$CGROOT$slice_cg" ]; then
	slice_cg="${mgr_cg}/$SLICE_NAME"
fi
# DID THE DELEGATION LAND, separately from whether anything is USING it.
#
# This is the one io fact that depends on nothing but the system manager and the
# drop-in: io in the user manager's OWN `cgroup.controllers` is what its parent
# hands it, so it is true whether or not the user manager has re-exec'd, whether
# or not any unit asks for io, and whether or not the slice holds anything.
#
# It exists because without it the two halves are indistinguishable in the
# report. On 2026-09-16 the first fleet-wide converge left all seven claws with
# `io_ctrl=no`, and that single value covered two completely different jobs: the
# Delegate= drop-in HAD landed on 7/7 (io_deleg would have read yes) and the user
# manager had not picked it up on 5/7 because it was mid-job and the re-exec was
# deferred. "The delegation failed" and "the delegation is not in use yet" send
# an operator to different places, which is the rule `check-queue-health` learned
# the hard way: carry the reason, or the finding is undiagnosable after the fact.
io_deleg=$(has_io "$CGROOT$mgr_cg/cgroup.controllers")
io_ctrl=$(has_io "$CGROOT$slice_cg/cgroup.controllers")
io_subtree=$(has_io "$CGROOT$slice_cg/cgroup.subtree_control")
# NOTHING TO MEASURE IS NOT A MEASUREMENT OF "no". `cgroup.subtree_control` lists
# what a cgroup enables for its MEMBERS, so a slice with no members carries an
# empty one for every controller, not just io — measured on claw-2 2026-09-16,
# 0 children and a blank subtree_control, against `memory pids` on the six claws
# that held something. Under all-JIT an idle claw is routinely in that state, and
# reading it as drift would redden a correctly configured fleet every time it
# went quiet. It is reported as its own value so the auditor can tell the two
# apart instead of having to guess which one it is looking at.
#
# `find`, not the obvious directory glob. Two audit gates blank comments out of
# this file before matching against it, with the JS/TS scanner in
# `scripts/lib/blank-comments.mjs`, and to that scanner the slash-star in a shell
# glob opens a BLOCK COMMENT — everything from there to the next star-slash is
# deleted before any rule gets to see it. Measured: one such glob here blanked
# seven of `slice-placement-guard`'s assertions at once, silently, and they went
# on reporting green. That guard now reads this file with a shell scanner, and
# this avoids handing it the construct in the first place.
if [ "$io_subtree" = no ]; then
	io_kids=$(find "$CGROOT$slice_cg" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
	case "$io_kids" in '' | 0) io_subtree=empty ;; esac
fi
# The MANAGER's parsed value, not the drop-in's text: a file written but not yet
# re-read is precisely the state this must report as not-yet-in-effect.
io_acct=$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user show -p DefaultIOAccounting --value 2>/dev/null)
[ -n "$io_acct" ] || io_acct="-"

# ASSERT THE LIVE VALUE, not the file we wrote. `changed` counts intentions;
# this counts outcomes, and they disagreed for a full fleet-wide run.
# Supervision is asserted on the SAME walk. `fix-runner-supervision.sh` writes
# Restart=always + KillMode=mixed by hand and NOTHING ever checked the result:
# runner-supervision.ts watches for orphans and duplicates, which are the
# SYMPTOMS of these two properties being wrong, so a single drifted unit stayed
# invisible until it produced a stuck listener. Walking every unit in both
# managers is the expensive, easy-to-get-wrong part and this loop already does
# it; adding a second property to it costs one systemctl call per unit.
#
# `systemctl show` is legitimate here, unlike for MemoryMax. There is no
# separate kernel copy of these to diverge from the loaded config — systemd
# acts on exactly what it reports — and a drop-in written without a reload
# shows the OLD value, so the read is honest in the one way that matters.
#
# control-group is ACCEPTED, not just mixed: it is strictly stronger, and it is
# what hokon's two PM2-wrapper units already carry. `process` is the stock
# default and the actual bug — it signals run.sh alone and never reaps
# run-helper.sh, leaving a Runner.Listener alive after the unit stops.
supervised=0
sup_total=0
# EFFECTIVE slice membership, counted from ControlGroup and never from `Slice=`.
#
# `Slice=` is the DECLARED property and it is what a drop-in sets, so it reads
# correct the instant the drop-in lands. But systemd only moves a unit into a
# slice on the unit's next START — a daemon-reload does not relocate a running
# process. So a unit can report `Slice=ci-runner.slice` while its processes are
# still in app.slice, and the two disagree for as long as the unit keeps running.
#
# Measured on hokon 2026-09-01: 24 of 27 runners declared ci-runner.slice and ran
# in app.slice, which is MemoryMax=infinity and held 33.7 GB. The per-unit 4 GiB
# cap WAS applied to all 27 — that part was always checked against the kernel —
# so the check reported `capped_live=27` and printed "every runner ... is in its
# declared slice", a claim it never tested. Placement correlates exactly with
# restart order: a unit is in the slice iff it started after its own drop-in was
# written.
#
# What is lost is the AGGREGATE ceiling, which is the entire reason the slice
# exists: 27 units x 4 GiB per-unit with no group bound on a 61 GB box, against
# a slice meant to hold the total at 16 GiB. That is the 2026-08-04 shape — an
# uncontained process reaching 51 GB anon-RSS and the OOM kill taking
# pm2-hadoku.service down with it, 23 services, host unreachable ~11 minutes.
in_slice=0
if [ "$UNIT_MB" -ge 0 ]; then
	want_bytes=$((UNIT_MB * 1024 * 1024))
	# BOTH MANAGERS, for the same reason the placement loops cover both: hokon
	# carries 24 of its 26 runners in the USER manager, so a system-only assertion
	# reported capped_live=0 immediately after successfully capping all 24 of them.
	# An assertion narrower than the thing it asserts about is worse than none.
	for u in $(syslist 'actions.runner.*' 'actions-runner-*' 'github-runner*') \
		$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user list-units 'actions-runner-*' 'actions.runner.*' --all --no-legend 2>/dev/null | awk '{print $1}'); do
		case "$u" in *.service) ;; *) continue ;; esac
		sup_total=$((sup_total + 1))
		km=$(unitprop "$u" KillMode)
		rs=$(unitprop "$u" Restart)
		case "$km:$rs" in
		mixed:always | control-group:always) supervised=$((supervised + 1)) ;;
		*) echo "SUPERVISION-DRIFT $u KillMode=$km Restart=$rs (want KillMode=mixed|control-group, Restart=always)" ;;
		esac

		# Membership BEFORE the per-unit cap check, and never gated on UNIT_MB:
		# the group ceiling is what the slice is for, so a node that declares no
		# per-unit ceiling must still be told its units are outside the slice.
		ucg=$(effslice "$u")
		case "$ucg" in
		"$SLICE_NAME") in_slice=$((in_slice + 1)) ;;
		*)
			echo "SLICE-PLACEMENT-DRIFT $u effective=${ucg:-unknown} declared=$(unitprop "$u" Slice) want=under-$SLICE_NAME (needs a unit RESTART, not a reload)"
			;;
		esac

		# THE OOM RANK, asserted like the cap. The repair above raises it, and
		# until 2026-10-27 nothing here checked the result, so `changed` was the
		# only trace: the gate went red and the converger, which repairs what a
		# DRIFT note names, saw nothing. claw-4 and claw-6 held a standing runner
		# at 200 for 29 hours after CI_OOM became 500.
		low=$(minoom "$u")
		if [ -n "$low" ] && [ "$low" -lt "$CI_OOM" ]; then
			echo "OOM-RANK-DRIFT $u kernel=$low want>=$CI_OOM"
		fi

		[ "$UNIT_MB" -gt 0 ] || continue
		got=$(kernelmax "$u")
		# Config ONLY for a unit with no cgroup at all (stopped — see kernelmax).
		# A running unit whose memory.max could not be read stays `unreadable`
		# and is drift: "I could not look" is not "it is capped".
		[ -n "$got" ] || got=$(unitprop "$u" MemoryMax)
		if [ "$got" = "$want_bytes" ]; then
			capped=$((capped + 1))
		else
			echo "UNIT-CAP-DRIFT $u kernel=$got want=$want_bytes"
		fi
	done
fi

# --- the minted units -------------------------------------------------------
# AUDITED, never placed, capped or restarted from here. See the MINTED UNITS
# note in the header for why.
#
# The per-unit ceiling is asserted in ONE direction only: never ABOVE UNIT_MB.
# The minter owns the number and computes it with the same `unitMemoryMaxMb()`
# the caller used for UNIT_MB, and that rule only ever WIDENS a cap up to the
# slice's own ceiling — so a cap at or below UNIT_MB is the minter's business,
# and a gate asserting equality would go red the day it legitimately changes.
# A cap above it, or none at all (`max`), is not a tuning question: it is a
# unit nothing bounds below the slice's whole budget. Until #98 nothing read a
# minted unit's kernel cap at all — the standing-unit loop above did, for units
# all-JIT left the claws without.
#
# The KERNEL value (kernelmax), never config. A unit with no cgroup holds no
# process and is skipped; one whose memory.max could not be read is drift.
mint_total=0
mint_in_slice=0
for u in $(mintlist); do
	case "$u" in *.service) ;; *) continue ;; esac
	mint_total=$((mint_total + 1))
	mcg=$(effslice "$u")
	case "$mcg" in
	"$SLICE_NAME") mint_in_slice=$((mint_in_slice + 1)) ;;
	*)
		echo "MINT-PLACEMENT-DRIFT $u effective=${mcg:-unknown} want=under-$SLICE_NAME (minted without Slice=; the MINTER fixes this on the next mint — never restart a live JIT unit)"
		;;
	esac
	[ "$UNIT_MB" -gt 0 ] || continue
	mkm=$(kernelmax "$u")
	case "$mkm" in
	'') ;;
	*[!0-9]*)
		echo "MINT-CAP-DRIFT $u kernel=$mkm want<=$((UNIT_MB * 1024 * 1024)) (the MINTER fixes this on the next mint — never restart a live JIT unit)"
		;;
	*)
		[ "$mkm" -gt $((UNIT_MB * 1024 * 1024)) ] &&
			echo "MINT-CAP-DRIFT $u kernel=$mkm want<=$((UNIT_MB * 1024 * 1024)) (the MINTER fixes this on the next mint — never restart a live JIT unit)"
		;;
	esac
done

# Probed unconditionally, so a --check run (which never attempts a write) can
# still tell "this node has drifted" from "this node has drifted AND
# cannot be fixed without an operator". Those need different next actions.
if sudo -n true 2>/dev/null; then sudo_ok=yes; else sudo_ok=no; fi
# THE SLICE CEILING FROM THE KERNEL (#98), through slicemax(). Ask systemd for
# the slice's cgroup PATH rather than guessing it — /sys/fs/cgroup/$SLICE_NAME
# only resolves for a top-level system slice, and hokon's ci-runner.slice is
# nested under ci.slice — but read the LIMIT from the cgroup it names. This was
# `systemctl show -p MemoryMax` until the mutation pass: the loaded config,
# which is what systemd WOULD apply, not what the kernel enforces — the exact
# read AGENTS.md forbids for a cgroup limit, kept here after kernelmax() fixed
# it for units. The config value is still reported, as `cfg_max`/`cfg_swap`,
# for the one case it is the only fact there is (an `inactive` slice — see
# slicemax) and as a diagnostic beside a kernel value that disagrees.
live_max=$(slicemax system memory.max)
live_swap=$(slicemax system memory.swap.max)
cfg_max=$(sysshow "$SLICE_NAME" MemoryMax)
[ -n "$cfg_max" ] || cfg_max="-"
cfg_swap=$(sysshow "$SLICE_NAME" MemorySwapMax)
[ -n "$cfg_swap" ] || cfg_swap="-"
# The USER manager's copy of the slice is a SECOND, independent ceiling — user
# units live under user@UID.service, not under the system slice, so the two do
# not share a budget. Reported so the deployer can see that the declared cap is
# being enforced twice rather than once.
#
# IT IS ALSO THE ONLY ONE THAT BOUNDS A MINTED RUNNER. Every `jit-*`/`warm-*`
# unit is `systemd-run --user`, so under all-JIT the SYSTEM manager's copy —
# the one `live_max` reports and the one the deployer has always asserted —
# bounds nothing on a claw. The deployer asserts this value too from 2026-09-14;
# it was a note for as long as the units it governs were a rounding error.
#
# Kernel first, config as `user_cfg_*` — same split as the system copy above.
live_user_max=$(slicemax user memory.max)
live_user_swap=$(slicemax user memory.swap.max)
user_cfg_max=$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user show "$SLICE_NAME" -p MemoryMax --value 2>/dev/null)
[ -n "$user_cfg_max" ] || user_cfg_max="-"
user_cfg_swap=$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user show "$SLICE_NAME" -p MemorySwapMax --value 2>/dev/null)
[ -n "$user_cfg_swap" ] || user_cfg_swap="-"
# LOADED, not ACTIVE. A slice with nothing in it yet is inactive and therefore
# ABSENT from `systemctl --user list-units --type=slice` — measured on claw-2,
# claw-3, claw-5 and claw-7 on 2026-09-14, where runners.slice is loaded with
# the node's derived ceiling and invisible to list-units because all-JIT left it
# empty. That is the same omission the bad_slices note below already records for
# a never-activated slice, and reading it the other way round ("the slice is
# missing, so a mint would materialise an uncapped default") is a false alarm
# the deployer must not be able to raise.
live_user_load=$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user show "$SLICE_NAME" -p LoadState --value 2>/dev/null)
[ -n "$live_user_load" ] || live_user_load="-"
# A slice the user manager cannot LOAD blocks every new unit placed into it,
# while everything already running keeps running — so nothing looks wrong.
# hokon sat like that from 2026-08-11 to 2026-08-30 after a hand-placed
# ManagedOOMMemoryPressure=kill drop-in on the user app.slice: 2.5 weeks in
# which no runner could be registered and no login session could start its
# dbus/gpg-agent/pipewire sockets. It surfaced only because a registration was
# finally attempted. Count slices in load-error so the NEXT one is caught the
# day it lands, not the next time somebody needs the node.
#
# Read per-unit with `show`, NOT `list-units`: that omits a slice which has
# never been activated, so a freshly-broken one is invisible there. Verified by
# planting a broken slice — list-units showed nothing, list-unit-files + show
# found it. app.slice appeared in both only because it was already running.
bad_slices=""
for u in $(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user list-unit-files --type=slice --no-legend 2>/dev/null | awk '{print $1}'); do
	st=$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user show "$u" -p LoadState --value 2>/dev/null)
	[ "$st" = "error" ] && bad_slices="${bad_slices}${bad_slices:+,}$u"
done
bad_slice_n=0
# NOT `printf '%s' ... | wc -l`: wc counts NEWLINES, and printf without \n emits
# none — so a single broken slice counted as ZERO and the guard reported clean
# while naming the very unit it had found. Caught by planting one.
[ -n "$bad_slices" ] && bad_slice_n=$(printf '%s\n' "$bad_slices" | tr ',' '\n' | wc -l)

user_units=$(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user list-units 'actions-runner-*' 'actions.runner.*' --all --no-legend 2>/dev/null | wc -l)
echo "SUMMARY io_deleg=$io_deleg io_ctrl=$io_ctrl io_subtree=$io_subtree io_acct=$io_acct host=$(hostname) sudo_ok=$sudo_ok slice=$SLICE_NAME max_mb=$MAX_MB swap_mb=$SWAP_MB changed=$changed restarted=$restarted busy=$busy needs_operator=$needs_operator failed=$skipped live_max=$live_max live_swap=$live_swap cfg_max=$cfg_max cfg_swap=$cfg_swap user_max=$live_user_max user_swap=$live_user_swap user_cfg_max=$user_cfg_max user_cfg_swap=$user_cfg_swap user_load=$live_user_load user_units=$user_units unit_mb=$UNIT_MB capped_live=$capped in_slice=$in_slice supervised=$supervised sup_total=$sup_total mint_total=$mint_total mint_in_slice=$mint_in_slice bad_slices=$bad_slice_n bad_slice_names=${bad_slices:-none}"
