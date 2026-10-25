#!/usr/bin/env bash
# capability-probe — EXECUTE each capability a node claims, never list it.
#
# "An encoder listing lies." Debian's ffmpeg reports av1_nvenc in `-encoders`
# whether or not the GPU can use it, so `ffmpeg -encoders | grep av1_nvenc`
# passes on claw-1's GTX 860M and on nodes with Intel graphics — and the
# 22 dataplatform tests that need it then fail at runtime, on a node the
# fleet believed was capable. Only a real encode answered that question.
#
# Same principle for every line below: run the thing, do not ask about it.
#
# Prints one `CAP <name> <ok|no> <detail>` per capability, and never exits
# non-zero — a probe that fails a job it was only meant to describe is worse
# than the drift it was looking for.
set -u

say() { printf 'CAP %s %s %s\n' "$1" "$2" "$3"; }

# EVERY SCRATCH DIR IS REMOVED ON EVERY EXIT PATH. Each probe below cleans up
# after itself on the paths it expects, and none of them expected to be killed:
# bootcamp runs this under a timeout, and a javac at load 90 does not finish.
# On 2026-10-21 hokon's 10 GB tmpfs held 435 `tmp.XXXXXX/Probe.java` dirs from
# ONE hour of the jdk21 probe dying mid-compile, among 23,000 leaked temp dirs
# that put /tmp under the dispatcher's 2 GB mint floor — which refused even
# the pm2-host deploys only hokon can run. A scratch dir is registered the
# moment it exists and reaped by the trap, whichever way the script ends.
#
# THE REGISTRY ALONE DID NOT DO THAT, AND COULD NOT. Almost every probe runs as
# `say <cap> $(<cap>_try)`, and a command substitution is a SUBSHELL: its
# `SCRATCH+=` lands in a copy of the array that dies with it, so this trap
# reaped only the one or two dirs made at top level. claw-4 and claw-6 still
# held 455 and 513 such dirs on 2026-10-24. So the probe makes ONE root here,
# in this shell, and points TMPDIR at it: every `mktemp` below, in whatever
# subshell, and every tool a probe runs (javac, python, rustc) lands inside
# it, and the root is what the trap removes. HUP is trapped too: the probe
# runs over ssh, and a dropped session is a HUP, not a TERM. The name has no
# leading dot — a dotted TMPDIR breaks tools that refuse dot segments
# (ci-throttle-install.sh's TMPDIR note). The pm2 probe's dir is under $HOME
# on purpose and so outside the root; it runs in a subshell too, so it is
# reaped by that probe's own `rm -rf`, which runs on every path but a kill.
SCRATCH=()
SCRATCH_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/cap-probe-XXXXXX" 2>/dev/null) || SCRATCH_ROOT=""
if [ -n "$SCRATCH_ROOT" ]; then
	SCRATCH+=("$SCRATCH_ROOT")
	export TMPDIR="$SCRATCH_ROOT"
fi
scratch_reap() { rm -rf -- ${SCRATCH[@]+"${SCRATCH[@]}"} 2>/dev/null || true; }
trap scratch_reap EXIT
trap 'scratch_reap; exit 143' TERM
trap 'scratch_reap; exit 130' INT
trap 'scratch_reap; exit 129' HUP

# --- WHICH HALF OF THE PROBE TO RUN ------------------------------------------
#
# `CAP_PROBE_PHASE` (default `all`, which is every caller but `fleet bootcamp`):
#   all       every capability, as this file always ran
#   presence  everything EXCEPT the idle-only measurements below
#   measured  ONLY the idle-only measurements, then PROBE-END
#
# WHY THERE ARE HALVES (2026-10-10). A measured capability whose number moves
# with load is worthless beside a running job: claw-4 scored 2281 on
# `cargo-bevy` idle and 1169 beside CI, claw-6 1529 and 1024 — both now under
# the bar for a reason that has nothing to do with the box. `fleet bootcamp`
# therefore re-takes such a measurement on a node it has DRAINED and waited
# out (`measured`), and skips it on a guest it may not drain (`presence`).
# Which capabilities are idle-only is the REGISTRY's answer
# (`measuredIdleOnly` in src/capabilities.ts); `capabilities.test.ts` holds
# the section between the two markers below to exactly that set.
CAP_PROBE_PHASE="${CAP_PROBE_PHASE:-all}"

# A counted number of live CI jobs, or `unknown`. The SAME question, in the same
# words, that `busyCount` (scripts/lib/refresh-cycle.mjs) asks over ssh — the
# `[R]` keeps pgrep from counting the shell that asks.
live_workers() {
	if ! command -v pgrep >/dev/null 2>&1; then
		echo unknown
		return
	fi
	lw_n=$(pgrep -c -f '[R]unner\.Worker' 2>/dev/null)
	case "$lw_n" in
	'' | *[!0-9]*) echo unknown ;;
	*) echo "$lw_n" ;;
	esac
}

# The most live jobs seen in a sample file: `unknown` if ANY sample was, since
# one blind second is enough for a job to have come and gone.
max_workers() {
	mw_max=0
	while read -r mw_s; do
		case "$mw_s" in
		'' | *[!0-9]*)
			echo unknown
			return
			;;
		esac
		[ "$mw_s" -gt "$mw_max" ] && mw_max=$mw_s
	done <"$1"
	echo "$mw_max"
}

# >>> IDLE-ONLY MEASUREMENTS — every `say` between these markers is a measured
# capability without `loadInvariant`, and each is followed by its `LOAD` line.

# --- cargo-bevy: MEASURE the throughput, and NEVER judge it ------------------
#
# THE PROBE MEASURES; THE REGISTRY JUDGES. The bar (`>= 1200`) lives in exactly
# one place — `cargo-bevy`'s `measure` entry in src/capabilities.ts, with its
# derivation beside it — and `meetsBar` is the only comparator. Putting the
# number here would give it two homes and make re-tuning it an edit to a file
# that runs on every node on every pass. So this block prints a bare integer
# and stops.
#
# ALL-CORE, AND THAT IS THE WHOLE DESIGN. A cargo build is massively parallel:
# claw-7 spent 4,709 CPU-seconds over 414 wall seconds, ~11 cores busy. A
# single-threaded rustc probe measures PER-CORE speed and is blind to core
# count, which would rank 4-core claw-3 above 8-core claw-5 and be wrong about
# the thing being routed. One rustc per core, wall time of the batch:
# cores x per-core speed, which is what the payload actually consumes.
#
# NO CARGO, NO REGISTRY, NO NETWORK. `rustc` straight on generated files. A
# probe that needs crates.io fails on a node behind a firewall rather than on a
# node that is slow, and those are different findings with different remedies.
#
# SYNTHETIC ON PURPOSE. It cannot build a 12-crate Bevy workspace — that is
# 6.9 to 47 minutes and the whole probe gets 180 s for every capability
# together. It compiles monomorphisation-heavy generic code with optimisations,
# the shape a Bevy build spends its time on, and the correlation is measured
# rather than asserted: Spearman 0.929 against build rank across all seven
# nodes, Pearson 0.984 against 1/build-seconds. ~4 s on hokon, ~16 s on the
# slowest claw.
#
# mktemp, i.e. /tmp, i.e. TMPFS on every claw — deliberately, and the opposite
# call from the payload measurement. That one wrote a 6.2 G `target/` and had
# to go to real disk under $HOME or it filled RAM and reported `No space left
# on device` as if it were a capability verdict. This writes a few MB of
# generated .rs and one small binary per core, and it is what the 2026-09-14
# figures behind the bar were taken with, so keeping the location keeps the
# measurement comparable to the number it is judged against.
CB_PER_UNIT=1500

# One generated crate: PER_UNIT distinct const-generic instantiations of an
# `#[inline(never)]` function, so the compiler must emit PER_UNIT bodies and
# cannot fold them together. `$1` offsets the const so each unit's work is
# distinct.
cb_gen() {
	echo 'trait Op { fn go(&self, x: u64) -> u64; }'
	echo 'struct M<const N: usize>;'
	echo 'impl<const N: usize> Op for M<N> {'
	echo '  #[inline(never)] fn go(&self, x: u64) -> u64 {'
	echo '    let mut a = x ^ (N as u64);'
	echo '    for i in 0..64u64 { a = a.wrapping_mul(0x9E3779B97F4A7C15).rotate_left((i % 31) as u32) ^ i; }'
	echo '    a'
	echo '  }'
	echo '}'
	echo 'fn main() {'
	echo '  let mut t = 0u64;'
	cb_i=0
	while [ "$cb_i" -lt "$CB_PER_UNIT" ]; do
		echo "  t = t.wrapping_add(M::<$((cb_i + $1 * CB_PER_UNIT))>.go(t));"
		cb_i=$((cb_i + 1))
	done
	echo '  println!("{}", t);'
	echo '}'
}

# Returns the two tokens `say` wants. A FAILURE IS NAMED, never a zero: "rustc
# is absent" and "rustc is present and this box is slow" are different findings,
# and `meetsBar` would read a `0` as a measurement that failed the bar rather
# than as a measurement that was never taken.
#
# PATH-SENSITIVE for the same reason the `rust` block above is: nothing widens
# PATH here, because a workflow `run:` step gets none either.
cb_try() {
	if ! command -v rustc >/dev/null 2>&1; then
		printf 'no no-rustc'
		return
	fi
	cb_d=$(mktemp -d 2>/dev/null) || cb_d=""
	[ -n "$cb_d" ] && SCRATCH+=("$cb_d")
	if [ -z "$cb_d" ]; then
		printf 'no no-tmpdir'
		return
	fi
	cb_n=$(nproc 2>/dev/null || echo 1)
	cb_u=0
	while [ "$cb_u" -lt "$cb_n" ]; do
		cb_gen "$cb_u" >"$cb_d/u$cb_u.rs"
		cb_u=$((cb_u + 1))
	done
	cb_start=$(date +%s%N)
	cb_u=0
	while [ "$cb_u" -lt "$cb_n" ]; do
		rustc -O -C codegen-units=1 --edition 2021 -o "$cb_d/u$cb_u" "$cb_d/u$cb_u.rs" 2>/dev/null &
		cb_u=$((cb_u + 1))
	done
	wait
	cb_end=$(date +%s%N)
	# EVERY unit must have produced a binary. A rustc that died — OOM, no disk,
	# a toolchain without a working linker — leaves the batch finishing FAST,
	# which without this check is the fastest node in the fleet.
	cb_u=0
	while [ "$cb_u" -lt "$cb_n" ]; do
		if [ ! -x "$cb_d/u$cb_u" ]; then
			rm -rf "$cb_d"
			printf 'no compile-failed'
			return
		fi
		cb_u=$((cb_u + 1))
	done
	cb_ms=$(((cb_end - cb_start) / 1000000))
	[ "$cb_ms" -lt 1 ] && cb_ms=1
	rm -rf "$cb_d"
	# Monomorphisations per second across the WHOLE box, as a bare integer so
	# the registry's bar is a plain number.
	printf 'ok %s' "$((cb_n * CB_PER_UNIT * 1000 / cb_ms))"
}


# LOAD IS SAMPLED THROUGHOUT, not at the ends. One sample before and one after
# misses a job that starts and finishes inside the batch (a lint job runs in
# seconds; the batch is ~16 s on the slowest claw). A sampler counts once a
# second for the whole run and `LOAD` prints the MOST it saw, so `0` means no
# second of the measurement shared the node with a job. The sampler is a child
# of THIS shell, not of `cb_try`'s command substitution, so `cb_try`'s bare
# `wait` cannot wait on it.
if [ "$CAP_PROBE_PHASE" != presence ]; then
	cb_lw=$(mktemp 2>/dev/null) || cb_lw=""
	[ -n "$cb_lw" ] && SCRATCH+=("$cb_lw")
	if [ -n "$cb_lw" ]; then
		# One sample BEFORE the batch starts, taken here rather than left to the
		# sampler's first tick, which a fast batch can beat.
		live_workers >>"$cb_lw"
		(while :; do
			live_workers >>"$cb_lw"
			sleep 1
		done) >/dev/null 2>&1 &
		cb_lw_pid=$!
	fi
	# Unquoted on purpose — two whitespace-free tokens into `say`'s $2 and $3, the
	# same convention every line in this file keeps.
	# shellcheck disable=SC2046
	say cargo-bevy $(cb_try)
	if [ -n "$cb_lw" ]; then
		kill "$cb_lw_pid" 2>/dev/null
		wait "$cb_lw_pid" 2>/dev/null
		live_workers >>"$cb_lw"
		printf 'LOAD cargo-bevy %s\n' "$(max_workers "$cb_lw")"
		rm -f "$cb_lw"
	else
		# Could not keep the samples, so could not count: never a zero.
		printf 'LOAD cargo-bevy unknown\n'
	fi
fi
# <<< IDLE-ONLY MEASUREMENTS

if [ "$CAP_PROBE_PHASE" = measured ]; then
	printf 'PROBE-END %s\n' "$(hostname)"
	exit 0
fi

# --- ffmpeg -----------------------------------------------------------------
if command -v ffmpeg >/dev/null 2>&1; then
	say ffmpeg ok "$(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
else
	say ffmpeg no absent
fi

# --- the NVENC family: a REAL encode per codec, never an encoder listing -----
#
# One loop, because the trap is identical for every codec and it was written out
# once for av1_nvenc alone: Debian's ffmpeg reports an encoder in `-encoders`
# whether or not the GPU can use it, so a listing check passes on hardware that
# then fails at runtime. Only a real encode separates them.
#
# `capability_id ffmpeg_encoder` pairs. Extending this is one line, which is the
# point — claw-7 (Maxwell GM200) and claw-8 (Turing TU104) do H.264 and HEVC and
# CANNOT do AV1, since NVENC AV1 encode arrived with Ada (RTX 40). av1-nvenc is
# probed on them anyway and is EXPECTED to answer `no not-built-in`. Trimming the
# list to the answers we expect would make the probe a restatement of the
# profile — "a verifier that reads its own writer's artifact cannot fail".
#
# 256x256 for one frame: fast enough to run on every probe, big enough that the
# encoder really initialises the GPU rather than short-circuiting.
# THE HELPER RETURNS A VERDICT; THE CALL SITE SAYS IT. That split is not style
# — it is what keeps this script STATICALLY READABLE, and the test suite caught
# the version that was not. `parseProbeCapabilities` (src/capabilities.ts) finds
# a capability by matching a literal `say <id>` at the start of a line, and it
# exists so the registry and this script can be checked against each other with
# nothing hand-maintained in between. A first attempt folded the `say` inside
# the helper as `say "$cap" ...`, which is tidier and made three capability
# names invisible to that parser: `av1-nvenc` — probed here since the file was
# written — silently stopped being detectable, and the drift rule reported all
# three as capabilities the probe never emits.
#
# So the encode attempt is shared and each `say` stays literal. One
# implementation, three greppable names.
nvenc_try() {
	enc="$1"
	if ! command -v ffmpeg >/dev/null 2>&1; then
		printf 'no no-ffmpeg'
		return
	fi
	if ffmpeg -hide_banner -loglevel error -f lavfi -i color=black:s=256x256:d=0.04 \
		-c:v "$enc" -f null - >/dev/null 2>&1; then
		printf 'ok encoded-256x256-%s' "$enc"
	elif ffmpeg -hide_banner -encoders 2>/dev/null | grep -q "$enc"; then
		# The trap, named. "Listed but unusable" and "not built in" are different
		# faults with different remedies — a driver problem versus a wrong ffmpeg
		# build — and reporting them identically hides which one you have.
		printf 'no listed-but-encode-failed-%s' "$enc"
	else
		printf 'no not-built-in-%s' "$enc"
	fi
}

# Unquoted on purpose: each verdict is exactly two whitespace-free tokens, which
# word-split into `say`'s $2 (status) and $3 (detail).
#
# EVERY DETAIL IN THIS FILE IS ONE TOKEN, and it is not a style rule — the
# consumer splits on whitespace. `check-capabilities` renders the detail's FIRST
# WORD, so the multi-word details this file briefly carried came out as
# `nvdec=cuda` and `cuda=no` across five claws: meaningless, and in the second
# case indistinguishable from a real `no`. Written in the same edit as the
# comment that stated the convention.
# shellcheck disable=SC2046
say av1-nvenc $(nvenc_try av1_nvenc)
# shellcheck disable=SC2046
say nvenc-h264 $(nvenc_try h264_nvenc)
# shellcheck disable=SC2046
say nvenc-hevc $(nvenc_try hevc_nvenc)

# --- watchparty-media: is the library HERE, where ingest will read it --------
# hadoku-watchparty's ingest encodes in place against `INGEST_MEDIA_ROOT`, a
# repo variable on that side. This path is that variable's value, and it is a
# CROSS-REPO CONTRACT: change one, change both, or the label leaves the node
# that holds the library. Present, non-empty and writable, because the job
# reads `input/` and writes its outputs under the root. Never a size or a
# listing of titles — this repo is public.
watchparty_media_try() {
	root="$HOME/srv/hadoku-watchparty/media"
	if [ ! -d "$root/input" ]; then
		printf 'no no-input-dir'
	elif [ -z "$(ls -A "$root/input" 2>/dev/null)" ]; then
		printf 'no input-empty'
	elif [ ! -w "$root" ]; then
		printf 'no root-not-writable'
	else
		printf 'ok input-present'
	fi
}
# shellcheck disable=SC2046
say watchparty-media $(watchparty_media_try)

# --- nvdec: DECODE something, on the GPU -------------------------------------
# Encode and decode are separate silicon and separate driver paths; a card can
# lose one and keep the other. Generated on the CPU first so the decode is
# reading a real bitstream rather than a synthetic pattern that never exercises
# the decoder.
if command -v ffmpeg >/dev/null 2>&1; then
	nvd_tmp=$(mktemp -d 2>/dev/null) || nvd_tmp=""
	[ -n "$nvd_tmp" ] && SCRATCH+=("$nvd_tmp")
	if [ -n "$nvd_tmp" ] &&
		ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=s=256x256:d=0.2 \
			-c:v libx264 -pix_fmt yuv420p "$nvd_tmp/t.mp4" >/dev/null 2>&1; then
		if ffmpeg -hide_banner -loglevel error -hwaccel cuda -i "$nvd_tmp/t.mp4" \
			-f null - >/dev/null 2>&1; then
			say nvdec ok decoded-256x256-h264
		else
			say nvdec no cuda-hwaccel-decode-failed
		fi
	else
		# Cannot make the input, so the question was never asked. `no` here would
		# blame the GPU for an ffmpeg build without libx264.
		say nvdec unknown could-not-make-test-clip
	fi
	[ -n "$nvd_tmp" ] && rm -rf "$nvd_tmp"
else
	say nvdec no no-ffmpeg
fi

# --- cuda: RUN something on the device ---------------------------------------
# NOT `nvidia-smi` and NOT the presence of /dev/nvidia0. nvidia-smi talks to the
# DRIVER, and a driver answering says nothing about whether the CUDA runtime can
# get a context on the device — which is the thing a GPU job actually needs, and
# the thing that breaks when a DKMS module and the userspace libraries drift
# apart after a kernel upgrade. `scale_cuda` uploads a frame, runs a CUDA kernel
# on it and reads it back, which is a real context on real silicon and needs no
# toolkit installed.
if command -v ffmpeg >/dev/null 2>&1; then
	if ffmpeg -hide_banner -loglevel error -init_hw_device cuda=c -filter_hw_device c \
		-f lavfi -i color=black:s=256x256:d=0.04 \
		-vf 'hwupload_cuda,scale_cuda=128:128' -f null - >/dev/null 2>&1; then
		say cuda ok scale_cuda-ran-on-device
	elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
		# The distinction that matters operationally: the driver is alive and the
		# compute path is not. That is a drift fault, not a missing card.
		say cuda no driver-up-but-no-cuda-context
	else
		say cuda no no-cuda-device
	fi
else
	say cuda no no-ffmpeg
fi

# --- what the GPU actually IS, for the record --------------------------------
# Not a capability and deliberately not a `CAP` line: it grants nothing and
# routes nothing. It is here because every probe above answers `no` on a box
# whose driver is installed but not yet loaded, and without the model line an
# operator reading that output cannot tell a card that cannot from a card that
# has not rebooted.
if command -v nvidia-smi >/dev/null 2>&1 && gpu_name=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null) && [ -n "$gpu_name" ]; then
	printf 'GPU %s\n' "$(printf '%s\n' "$gpu_name" | head -1)"
else
	printf 'GPU none-or-driver-not-loaded\n'
fi

# --- python venv ------------------------------------------------------------
# `python3 -m venv --help` succeeds on a box where venv creation then fails for
# want of ensurepip, which is exactly the claw-1/claw-2 drift of 2026-08-25. So
# create one.
tmp=$(mktemp -d 2>/dev/null) || tmp=""
[ -n "$tmp" ] && SCRATCH+=("$tmp")
if [ -n "$tmp" ]; then
	if python3 -m venv "$tmp/v" >/dev/null 2>&1 && [ -x "$tmp/v/bin/python" ]; then
		say python-venv ok "$("$tmp/v/bin/python" -V 2>&1 | cut -d' ' -f2)"
	else
		say python-venv no creation-failed
	fi
	rm -rf "$tmp"
else
	say python-venv no no-tmpdir
fi

# --- the JIT path -----------------------------------------------------------
# `--jitconfig` appears in NO `Runner.Listener --help` output on 2.336.0. The
# whole ephemeral dispatcher depends on it, and a runner self-update could
# remove it silently, so the fleet should find out from a probe rather than from
# a dispatcher that has stopped working.
#
# Probed WITHOUT minting: an invalid config must be REJECTED for parsing, which
# proves the flag is understood. A flag that does not exist produces a different
# failure ("Unrecognized command-line input"), and that difference is the test.
# THE JIT PAYLOAD IS SEARCHED FIRST, and on an ephemeral node it is the only
# binary that exists. claw-3 went pure JIT on 2026-08-29 and its standing runner
# installs were removed, so this loop found nothing and reported
# `jitconfig no no-runner-binary` — "the ephemeral dispatcher cannot mint here"
# about the one node that was, at that moment, successfully minting.
#
# It is also the RIGHT binary to probe: on an ephemeral node the payload is
# what every mint actually execs, so probing a standing install would answer a
# question about a binary the dispatcher never runs.
bin=""
for d in "$HOME"/.hadoku/jit/payload/ "$HOME"/runners/actions-runner*/ "$HOME"/actions-runner*/ "$HOME"/repos/*/actions-runner*/; do
	d=${d%/}
	[ -x "$d/bin/Runner.Listener" ] && bin="$d/bin/Runner.Listener" && break
done
if [ -n "$bin" ]; then
	out=$("$bin" run --jitconfig not-a-real-config 2>&1 | head -5)
	case "$out" in
	*"Unrecognized"* | *"unknown option"*)
		say jitconfig no flag-not-recognised
		;;
	*)
		say jitconfig ok flag-accepted
		;;
	esac
else
	say jitconfig no no-runner-binary
fi


# --- python-toolcache: EXECUTE the cached interpreter -----------------------
# NOT `ls /opt/hostedtoolcache/Python`. That directory is the presence-check
# trap in miniature: on claw-1 it lists 3.11.15 and 3.12.13, `du` reports 20K,
# and both versions are symlinks into uv's store. A listing passes on an empty
# shell, and `actions/setup-python` then fails at runtime on a node the fleet
# believed was ready — with no fallback, because the claws run trixie and
# actions/python-versions publishes no trixie build.
tc_found=""
tc_fail=""
for v in 3.11 3.12; do
	hit=""
	for py in /opt/hostedtoolcache/Python/"$v".*/x64/bin/python3; do
		[ -x "$py" ] || continue
		if out=$("$py" -c 'import sys;print(".".join(map(str,sys.version_info[:2])))' 2>/dev/null); then
			[ "$out" = "$v" ] && hit="$v" && break
		fi
	done
	if [ -n "$hit" ]; then tc_found="${tc_found}${hit} "; else tc_fail="${tc_fail}${v} "; fi
done
if [ -z "$tc_fail" ]; then
	say python-toolcache ok "executed ${tc_found% }"
elif [ -n "$tc_found" ]; then
	say python-toolcache no "missing ${tc_fail% } (have ${tc_found% })"
else
	say python-toolcache no "no cached interpreter executes"
fi

# --- playwright: LAUNCH a browser, not `--version` --------------------------
# `npx playwright --version` answers about the npm package; the question is
# whether a BROWSER starts. ~/.cache/ms-playwright can hold 631MB and still be
# missing the binary a spec needs, and hadoku_site's e2e-canary.yml carries no
# `playwright install` step DELIBERATELY - it depends on the node having one.
# --no-sandbox because the runner user is unprivileged and Chromium's sandbox
# needs either root or user namespaces the claws do not grant.
pw_bin="$(find "$HOME/.cache/ms-playwright" -maxdepth 3 \( -name chrome -o -name headless_shell \) -type f 2>/dev/null | head -1)"
if [ -z "$pw_bin" ]; then
	say playwright no "no browser binary under ~/.cache/ms-playwright"
elif "$pw_bin" --headless --no-sandbox --disable-gpu --dump-dom about:blank 2>/dev/null | grep -qi '<html'; then
	# The COUNT matters as much as the launch. A node can hold seven chromium
	# builds or one, and playwright runs the version its package.json pins - so a
	# repo pinning anything but the one version a node has fails THERE and passes
	# on its neighbour, which reads as a flaky test rather than as fleet drift.
	# Measured 2026-09-02: claw-1/2/3 carried chromium-1217 alone while claw-5,
	# claw-6 and hokon carried seven builds, 1194 through 1234.
	pw_n=$(ls -d "$HOME"/.cache/ms-playwright/chromium-* 2>/dev/null | wc -l)
	say playwright ok "launched $(basename "$(dirname "$(dirname "$pw_bin")")"), ${pw_n} build(s) present"
else
	say playwright no "binary present but would not launch"
fi

# --- gh: RUN it, not `command -v` -------------------------------------------
# `command -v gh` is the presence check this file exists to refuse, so the
# binary is executed. Auth is deliberately NOT probed: the token is injected per
# job by the workflow, so there is nothing here to authenticate with, and a
# probe that reported "no" on every node would be worse than no probe at all.
#
# Absence is the failure that actually happened. claw-4/5/6 were enrolled on
# 2026-09-02 without gh and nobody found out until 2026-09-05, when a publish
# fanned out to six repos and the four that drew one of those nodes died on
# `gh: command not found` — exit 127, in the alert step, AFTER the update they
# existed to perform had already succeeded and pushed. The same jobs were green
# on claw-1/2/3 all week, so it read as flaky rather than as drift.
#
# NOT `gh --version | head -1`. A command substitution takes the exit status of
# the LAST command in the pipeline, and `head` succeeds on empty input — so an
# absent gh produced an empty version string and reported `CAP gh ok`, which is
# precisely the lie this file exists to refuse. Caught by running the probe on a
# box whose gh sits outside the stock PATH. Status first, then trim.
if gh_v=$(gh --version 2>/dev/null) && [ -n "$gh_v" ]; then
	gh_v=$(printf '%s\n' "$gh_v" | head -1)
	say gh ok "${gh_v#gh version }"
elif command -v gh >/dev/null 2>&1; then
	say gh no "present but would not run"
else
	say gh no absent
fi

# --- rust ---------------------------------------------------------------
# CARGO MUST BE ON THE STOCK PATH, which is the whole point of probing it here
# rather than trusting that rustup was installed.
#
# On 2026-09-10 every claw was given rustup, and a hand-check over ssh reported
# all seven healthy — because that check exported ~/.cargo/bin onto PATH first,
# the way an interactive login does. A workflow `run:` step gets none of that:
# it is a non-interactive shell whose PATH is the stock
# /usr/local/bin:/usr/local/sbin:/usr/bin:... and nothing sources a profile. So
# brave-quartet's first fleet run died on `rustup: command not found` against
# seven boxes that all "had" rustup. The fix was symlinking the rustup proxies
# into /usr/local/bin; this probe is what keeps that true, and it deliberately
# does NOT widen PATH before looking.
#
# `cargo metadata` rather than `cargo --version`, for the same reason the gh
# block above takes the exit status first: a rustup PROXY answers --version
# happily when no toolchain is actually installed behind it, so the version
# string proves the shim exists and nothing more. Building needs a toolchain.
if rustc_v=$(rustc --version 2>/dev/null) && [ -n "$rustc_v" ]; then
	rs_t=$(mktemp -d)
	SCRATCH+=("$rs_t")
	printf '[package]\nname="p"\nversion="0.0.0"\nedition="2021"\n' >"$rs_t/Cargo.toml"
	mkdir -p "$rs_t/src" && : >"$rs_t/src/lib.rs"
	if (cd "$rs_t" && cargo metadata --format-version 1 --no-deps >/dev/null 2>&1); then
		say rust ok "${rustc_v#rustc } $(rustup target list --installed 2>/dev/null | tr '\n' ' ' | grep -o 'wasm32-unknown-unknown' || echo 'no-wasm32')"
	else
		say rust no "rustc on PATH but cargo could not read a crate — no usable toolchain"
	fi
	rm -rf "$rs_t"
elif command -v rustup >/dev/null 2>&1; then
	say rust no "rustup present but rustc is not on the stock PATH (needs /usr/local/bin symlinks)"
else
	say rust no absent
fi

# --- pm2-host: is this box the production host — NOT could it be -------------
#
# TWO QUESTIONS, AND MERGING THEM ROUTES A PRODUCTION DEPLOY ONTO THE WRONG BOX.
# `pm2-host` is a ROUTING LABEL. Six workflows in the SITE REPO carry
# `runs-on: [self-hosted, pm2-host]` — redeploy-mgmt-api, redeploy-service,
# reload-ecosystem, cron-schedules-sync, recreate-pm2-registrations and
# temporal-cluster-diag — and every one acts on the pm2 stack of whatever
# machine picks the job up. `nodeOffer` puts every EARNED identity label on a
# node's registrations and JIT mints, so "could this box host pm2" and "is this
# box the host" cannot share an id: the first claw to prove the former would
# start answering redeploy-mgmt-api on a box with no ecosystem file and no
# vault. `census.clawPool` subtracts every runner carrying this label too, so
# the same earn would silently shrink the CI pool, and `census.pm2Busy` would
# read a busy claw as the production host being busy and hold CI off the ladder.
#
# So this block answers the NARROW question and `pm2-capable` below answers the
# wide one. Both are EXECUTED; neither is typed.
#
# AND IT STARTS NOTHING. `pm2 jlist` LAUNCHES a daemon when none is running, so
# on a box that merely has pm2 installed it would leave a God daemon behind —
# a footprint this probe has no business creating, and on the production host
# a second daemon is worse than that. The daemon is therefore confirmed ALIVE
# from its own pid file and socket BEFORE pm2 is run at all. (A stale socket
# whose pid is dead reads as `no-daemon` and pm2 is never invoked, which is the
# direction that cannot damage anything.)
#
# THE STOCK PATH, NOT A LOGIN SHELL'S — same discipline as the `rust` block and
# the same measured reason: on 2026-09-10 a hand-check over ssh passed on seven
# boxes a workflow `run:` step then could not use, because the check had
# exported ~/.cargo/bin first. Nothing is widened here.
pm2_host_try() {
	if ! command -v pm2 >/dev/null 2>&1; then
		printf 'no absent'
		return
	fi
	ph_home="${PM2_HOME:-$HOME/.pm2}"
	ph_pid=$(cat "$ph_home/pm2.pid" 2>/dev/null || true)
	if [ ! -S "$ph_home/rpc.sock" ] || [ -z "$ph_pid" ] || ! kill -0 "$ph_pid" 2>/dev/null; then
		# Installed and supervising nothing. A CLAW answers here, and answering
		# `no` is what keeps it out of the six workflows above.
		printf 'no no-daemon'
		return
	fi
	ph_json=$(pm2 jlist 2>/dev/null | tr -d ' \n')
	ph_n=$(printf '%s' "$ph_json" | grep -o '"status":"online"' | wc -l | tr -d ' ')
	# THE HUB IS THE BOX RUNNING mgmt-api, NOT ANY BOX RUNNING AN APP. Since
	# 2026-10-11 a claw can be a remote PM2 host (hadoku_site
	# scripts/pm2-hosts.json; pygmalion → claw-4, #105): a supervisor with apps
	# online, no ecosystem.config.cjs and no vault. "Any app online" would hand
	# that claw this label on its next bootcamp, and with it redeploy-mgmt-api.
	# The six workflows act on the HUB'S stack, and mgmt-api is what makes a box
	# the hub, so it is the one app asked about by name. `pm2 pid` prints 0 for
	# a stopped app and nothing for an unknown one; both are "not here".
	ph_hub=$(pm2 pid mgmt-api 2>/dev/null | tr -dc '0-9')
	if [ -z "$ph_json" ]; then
		printf 'no daemon-alive-but-jlist-unreadable'
	elif [ "${ph_n:-0}" -gt 0 ] && [ "${ph_hub:-0}" -gt 0 ]; then
		# ONE TOKEN, and the count is in it: "the daemon is up and supervising
		# nothing" and "supervising 23 services" are the same verdict to a reader
		# who only gets a yes.
		printf 'ok %s-online' "$ph_n"
	elif [ "${ph_n:-0}" -gt 0 ]; then
		printf 'no %s-online-without-mgmt-api' "$ph_n"
	else
		printf 'no daemon-up-but-no-app-online'
	fi
}

# Unquoted on purpose — the same two-token convention as every other line.
# shellcheck disable=SC2046
say pm2-host $(pm2_host_try)

# --- pm2-capable: PROVISION a supervisor, prove it, and take it off again ----
#
# THE CAPABILITY THE ROLE NEEDS, HELD ONE STEP SHORT OF BEING A ROUTING LEVER.
# `surface: 'implicit'` is the documented shape for exactly this and `cuda`,
# `nvdec` and the NVENC pair are the precedent: measured because the answer
# matters, exposed to no `runs-on` because no workflow may route on it. It
# lands in `$capabilities.earned`, which is what `resident-placement`'s filter 1
# reads, and `nodeOffer` skips it because it is not a label. That is the whole
# separation — see the pm2-host block above for what merging them costs.
#
# PROVE WITHOUT PERSISTING. A permanent pm2 on nine boxes is ~540 MB of
# node/pm2 footprint per box and is precisely what issue #6 wants moved OFF a
# machine, not onto eight more; it also contradicts the standing rule against
# memory squatters. So the supervisor is INSTALLED for the length of the probe
# and removed. Measured on claw-9 2026-09-26: 2 s to install, 5 s end to end,
# 41 MB under $HOME, `~/.npm` byte-identical before and after, nothing left in
# $HOME and no pm2 process surviving.
#
# UNDER $HOME, NOT mktemp's /tmp — deliberately, and the opposite call from the
# `cargo-bevy` block at the top of this file. `/tmp` is TMPFS at ~50% of installed on
# every claw, so a 41 MB npm tree there is 41 MB of RAM taken out of the very
# headroom this capability is about, on the node least able to spare it. A
# probe that wrote to tmpfs has already faked one capability failure in this
# fleet.
#
# `--cache "$pc_d/npmcache"` IS NOT TIDINESS. Without it npm populates
# `~/.npm`, which survives the probe — an install that leaves a cache behind
# has persisted, whatever it did with node_modules.
#
# THE NETWORK FAILURE IS NAMED, NOT SCORED AS INCAPACITY. `cargo-bevy` refuses
# to touch crates.io because a node behind a firewall would rank as a slow node;
# here the registry IS a real dependency — a box that cannot fetch pm2 cannot be
# provisioned as a host either — so it is probed, with its own token, and with
# a `timeout` so one unreachable registry cannot eat the 180 s every other
# capability on the node shares. A probe that hung here would take the node's
# whole answer down with it and report as UNREACHABLE.
#
# WHAT "CAN HOST" IS TAKEN TO MEAN, in four parts:
#   1. a supervisor RUNS here — installed, started, and a real process reported
#      `online` by the daemon, not `pm2 -v`;
#   2. the process SURVIVES THE SUPERVISOR RESTARTING, not merely starting:
#      `save`, `kill`, `resurrect`, and online again. That is the property a
#      resident service actually needs and the one a start-only probe cannot
#      see — a pm2 that cannot write its dump starts everything perfectly and
#      loses the lot on the first daemon restart;
#   3. AND THE PID MUST CHANGE. `resurrect` returning 0 against a process the
#      kill did not reach proves nothing; a different pid is what separates a
#      restart from a re-attach;
#   4. installed memory, printed as a bare integer for the registry to judge
#      (`meetsBar`). THE PROBE MEASURES, THE REGISTRY JUDGES — the bar and its
#      derivation live in `pm2-capable`'s `measure` entry in src/capabilities.ts
#      and nowhere else, exactly as `cargo-bevy` does it.
#
# AND IT STOPS THERE. Whether the node has ROOM for the role today is
# `resident-placement-2026-09-10.md` filters 2-4, computed from `slack` over the
# manifest; re-deriving that here would give one question two answers that
# disagree, because free memory moves with whatever CI is running and a
# capability is an IDENTITY — "facts do not change between ticks". A capability
# that flickers with load is an eligibility lever wearing an identity's clothes,
# which is the P2 collapse src/capabilities.ts opens with. Installed memory is
# the hardware floor and does not move; the fit is the rule's to decide.
pm2cap_try() {
	if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
		printf 'no no-node-runtime-on-stock-path'
		return
	fi
	pc_d=$(mktemp -d "$HOME/.pm2-probe.XXXXXX" 2>/dev/null) || pc_d=""
	[ -n "$pc_d" ] && SCRATCH+=("$pc_d")
	if [ -z "$pc_d" ]; then
		printf 'no no-workdir-under-home'
		return
	fi
	pc_to=""
	command -v timeout >/dev/null 2>&1 && pc_to="timeout 90"
	if ! $pc_to npm install --prefix "$pc_d" --cache "$pc_d/npmcache" \
		--no-audit --no-fund --no-package-lock --loglevel error \
		--fetch-timeout 20000 --fetch-retries 1 pm2 >"$pc_d/npm.log" 2>&1; then
		rm -rf "$pc_d"
		printf 'no supervisor-install-failed'
		return
	fi
	pc_pm2="$pc_d/node_modules/pm2/bin/pm2"
	if [ ! -f "$pc_pm2" ]; then
		rm -rf "$pc_d"
		printf 'no supervisor-install-incomplete'
		return
	fi
	# ONE SUBSHELL, AND PM2_HOME IS EXPORTED BEFORE THE FIRST pm2 RUNS. This is
	# the one line in the file that could damage a box: `pm2 kill` against the
	# DEFAULT home would stop mgmt-api, the tunnel and the other production services on whatever
	# machine ran it. Nothing after the subshell inherits the variable, so the
	# kills below can never reach a real daemon. (The fleet must not probe a
	# guest at all — but a probe whose safety depends on never reaching one box
	# is not safe.)
	(
		export PM2_HOME="$pc_d/home"
		node "$pc_pm2" start "$(command -v sleep)" --name hadoku-pm2-probe \
			--interpreter none -- 120 >/dev/null 2>&1 || exit 3
		pc_first=$(node "$pc_pm2" jlist 2>/dev/null | tr -d ' \n')
		case "$pc_first" in
		*'"status":"online"'*) : ;;
		*) exit 4 ;;
		esac
		pc_first=$(printf '%s' "$pc_first" | grep -o '"pid":[0-9]*' | head -1)
		[ -n "$pc_first" ] || exit 4
		node "$pc_pm2" save >/dev/null 2>&1 || exit 5
		node "$pc_pm2" kill >/dev/null 2>&1 || exit 6
		node "$pc_pm2" resurrect >/dev/null 2>&1 || exit 7
		pc_second=$(node "$pc_pm2" jlist 2>/dev/null | tr -d ' \n')
		case "$pc_second" in
		*'"status":"online"'*) : ;;
		*) exit 8 ;;
		esac
		pc_second=$(printf '%s' "$pc_second" | grep -o '"pid":[0-9]*' | head -1)
		[ -n "$pc_second" ] && [ "$pc_second" != "$pc_first" ] || exit 9
		exit 0
	)
	pc_rc=$?
	# Kill the throwaway daemon whatever happened, then remove its home and the
	# supervisor with it. Skipped only when nothing was ever started.
	if [ "$pc_rc" != 3 ]; then
		(
			export PM2_HOME="$pc_d/home"
			node "$pc_pm2" kill >/dev/null 2>&1
		)
	fi
	rm -rf "$pc_d"
	case "$pc_rc" in
	0)
		# A FAILURE IS NAMED, NEVER A ZERO — `meetsBar` would read a `0` as a
		# measurement that failed the bar rather than one that was never taken.
		pc_mem=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo 2>/dev/null)
		if [ -n "$pc_mem" ]; then
			printf 'ok %s' "$pc_mem"
		else
			printf 'no could-not-read-meminfo'
		fi
		;;
	3) printf 'no start-failed' ;;
	4) printf 'no started-but-not-online' ;;
	5) printf 'no could-not-save-process-list' ;;
	6) printf 'no supervisor-would-not-stop' ;;
	7) printf 'no resurrect-failed' ;;
	8) printf 'no did-not-survive-supervisor-restart' ;;
	9) printf 'no resurrect-reattached-rather-than-restarted' ;;
	*) printf 'no probe-failed' ;;
	esac
}

# Unquoted on purpose — the same two-token convention as every other line.
# shellcheck disable=SC2046
say pm2-capable $(pm2cap_try)

# --- jdk21: compile and RUN a class, then run mvn -v -------------------------
#
# cardtable#5, added 2026-10-05. `command -v java` is not proof — a `java` that
# exists and exits non-zero is exactly what a half-broken or stubbed install
# looks like. This runs the SAME execution `REPAIRS.jdk21`/`REPAIRS.maven`'s
# own `detect` scripts do in `scripts/lib/toolchain-floor.mjs`, so bootcamp's
# earned record and the cadence's own convergence check agree about what
# "works" means for this capability — one question, not two.
jdk21_try() {
	if ! command -v javac >/dev/null 2>&1; then
		printf 'no no-javac'
		return
	fi
	if ! command -v java >/dev/null 2>&1; then
		printf 'no no-java'
		return
	fi
	if ! command -v mvn >/dev/null 2>&1; then
		printf 'no no-mvn'
		return
	fi
	jd_d=$(mktemp -d 2>/dev/null) || jd_d=""
	[ -n "$jd_d" ] && SCRATCH+=("$jd_d")
	if [ -z "$jd_d" ]; then
		printf 'no no-tmpdir'
		return
	fi
	printf 'public class Probe{public static void main(String[] a){System.out.println("JDK21-PROBE-OK");}}' \
		>"$jd_d/Probe.java"
	if ! javac -d "$jd_d" "$jd_d/Probe.java" >/dev/null 2>&1; then
		rm -rf "$jd_d"
		printf 'no compile-failed'
		return
	fi
	jd_out=$(java -cp "$jd_d" Probe 2>/dev/null)
	rm -rf "$jd_d"
	if [ "$jd_out" != "JDK21-PROBE-OK" ]; then
		printf 'no run-failed'
		return
	fi
	if ! mvn -v 2>&1 | grep -q 'Apache Maven'; then
		printf 'no mvn-failed'
		return
	fi
	# The installed JDK's own version, for the operator-facing detail — never a
	# bare "ok" with nothing behind it.
	jd_v=$(java -version 2>&1 | sed -n '1s/.*"\([0-9][0-9.]*\)".*/\1/p')
	[ -n "$jd_v" ] || jd_v="unknown"
	printf 'ok %s' "$jd_v"
}

# shellcheck disable=SC2046
say jdk21 $(jdk21_try)

# --- java21: a Java 21 that RUNS, nothing more -------------------------------
#
# What a node needs to host Forge matches (src/capabilities.ts `java21`). The
# same compile-and-run as jdk21 above without Maven, plus the MAJOR version:
# a working Java 17 is a working Java, and the wrong one for Forge.
java21_try() {
	if ! command -v javac >/dev/null 2>&1 || ! command -v java >/dev/null 2>&1; then
		printf 'no no-jdk'
		return
	fi
	j21_v=$(java -version 2>&1 | sed -n '1s/.*"\([0-9][0-9.]*\)".*/\1/p')
	if [ "${j21_v%%.*}" != "21" ]; then
		printf 'no major-%s' "${j21_v:-unknown}"
		return
	fi
	j21_d=$(mktemp -d 2>/dev/null) || j21_d=""
	[ -n "$j21_d" ] && SCRATCH+=("$j21_d")
	if [ -z "$j21_d" ]; then
		printf 'no no-tmpdir'
		return
	fi
	printf 'public class Probe{public static void main(String[] a){System.out.println("JAVA21-PROBE-OK");}}' \
		>"$j21_d/Probe.java"
	if ! javac -d "$j21_d" "$j21_d/Probe.java" >/dev/null 2>&1; then
		rm -rf "$j21_d"
		printf 'no compile-failed'
		return
	fi
	j21_out=$(java -cp "$j21_d" Probe 2>/dev/null)
	rm -rf "$j21_d"
	if [ "$j21_out" != "JAVA21-PROBE-OK" ]; then
		printf 'no run-failed'
		return
	fi
	printf 'ok %s' "$j21_v"
}

# shellcheck disable=SC2046
say java21 $(java21_try)

printf 'PROBE-END %s\n' "$(hostname)"
