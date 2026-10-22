#!/usr/bin/env bash
# warm-provision — register a STANDING listener in the warm-cache-of-one slot.
#
# Inputs (leading assignments on stdin, like jit-provision.sh):
#   REG_TOKEN=<token>   a registration token from
#                       POST /actions/runners/registration-token (short-lived,
#                       repo-scoped, single-purpose — see mintWarmListener in
#                       src/runners/ephemeral-exec.ts for why that is treated
#                       differently from a jitconfig's `.credentials`)
#   URL=<url>           https://github.com/<owner>/<repo>
#   REPO=<owner/repo>   written to the marker file so a later tick can
#                       discover which repo THIS node last warmed without
#                       remembering it in mgmt-api's own process (§12.8, B9)
#   NAME=<name>         the runner name, from warmRunnerName()
#   LABELS=<csv>        comma-separated labels, GitHub's own config.sh format
#   RESET=0|1           wipe a previous registration's identity (default 1)
#   RUNNER_TARBALL_URL  same bootstrap fallback as jit-provision.sh, for a node
#                       with no standing install to source a payload from
#
# Prints `WARM-READY <path> <version>` on success, or `WARM-FAIL <reason>`.
#
# WHY THIS IS A SEPARATE SCRIPT FROM jit-provision.sh
# ----------------------------------------------------
# A JIT slot is registered by `generate-jitconfig` on the CALLER's side and the
# node only ever reads the result back — `assertSafeJitConfig` REQUIRES
# `Ephemeral: 'True'` on every config that path can produce, and that check is
# load-bearing (§12.16), so a warm (standing) listener cannot be built by
# relaxing it. A standing runner is registered the OLD way instead — a
# registration token handed to `Runner.Listener configure`, with no
# `--ephemeral` — which is a genuinely different remote command, not a flag on
# the same one.
#
# THE PAYLOAD IS THE ONLY THING THIS NEEDS, AND THAT IS THE FIX (issue #7)
# -----------------------------------------------------------------------
# Every fill on claw-1/claw-3/claw-5 failed with
#
#   WARM-FAIL no runner install to source a payload from, and no RUNNER_TARBALL_URL
#
# because the previous version registered by running the tarball's own
# `./config.sh`, which lives at the runner ROOT — not inside `bin/` or
# `externals/`, the only two directories the shared `$PAYLOAD` has ever held.
# It sourced that root from a standing `~/actions-runner*` install, and UNDER
# ALL-JIT NO SUCH INSTALL EXISTS: a node declared `ephemeral: true` is dropped
# from every repo by placementFor(), so it is never given one. claw-4 was the
# only node that worked, and only because it is a resident backstop that still
# carries one. "No standing install" is the NORMAL case now, not the edge case.
#
# So this no longer needs a runner root at all. `config.sh` is a ~60-line
# wrapper whose entire payload-touching body is
#
#   source ./env.sh
#   ./bin/Runner.Listener configure "$@"
#
# and `Runner.Listener` is exactly what `$PAYLOAD/bin` already holds on every
# ephemeral node — put there by jit-provision.sh, which has its own
# `RUNNER_TARBALL_URL` bootstrap for a node that has never held an install.
# Registering through the binary directly means the warm path needs precisely
# what the JIT path already guarantees, on every node, with no second tree and
# no ~200 MB download to extract 15 kB of shell scripts.
#
# What config.sh does that this deliberately does not:
#
#   * `ldd ./bin/libcoreclr.so | grep 'not found'` and friends. Diagnostics for
#     a first-time installer. The `Runner.Listener --version` smoke test below
#     is a STRONGER check of the same thing — it actually starts the .NET
#     runtime, so a missing libicu or libcoreclr fails it — and it was already
#     here.
#   * `source ./env.sh`, whose only real effect is `echo $PATH > .path`.
#     REFUSED ON PURPOSE. This script runs over a non-interactive ssh, so the
#     PATH it would capture is the login-shell stub — measured on claw-4,
#     which the previous version configured this way, `.path` reads
#     `/usr/local/bin:/usr/bin:/bin:/usr/games` and nothing else. The runner
#     hands `.path` to every job it runs, so writing one PINS warm-served jobs
#     to a PATH with no ~/.local/bin, no nvm and no toolpack. A JIT slot has
#     no `.path` at all and the whole fleet's CI runs on those, so the proven
#     configuration is the one with no file: the runner then uses the systemd
#     user manager's own environment, same as every ephemeral mint.
#
# --disableupdate IS NOT OPTIONAL HERE
# ------------------------------------
# The slot's `bin/` is HARDLINKED into `$PAYLOAD` (that is the whole point —
# ~670 MB stored once per node instead of once per slot), and jit-provision.sh
# spells out the hazard: on ext4 a hardlink is a second name for one inode, so
# a runner that self-updated in place would rewrite the payload behind EVERY
# JIT slot on the node at once. The JIT half is safe because
# `generate-jitconfig` sets DisableUpdate and `assertSafeJitConfig` refuses a
# config without it. A standing registration has no such caller-side gate —
# self-update is ON by default — so it must be turned off here, at the only
# place that can. Verified missing on claw-4's first-ever warm listener: its
# `.runner` carried no disableUpdate and its `bin/Runner.Listener` shared inode
# 3551572 with the payload and with `jit/slot0`.
set -u

REG_TOKEN="${REG_TOKEN:-}"
URL="${URL:-}"
REPO="${REPO:-}"
NAME="${NAME:-}"
LABELS="${LABELS:-}"
RESET="${RESET:-1}"

for v in REG_TOKEN URL REPO NAME LABELS; do
	eval "val=\${$v}"
	[ -n "$val" ] || { echo "WARM-FAIL missing $v"; exit 0; }
done

# config.sh's one genuine safety check, kept. A runner configured as root owns
# its work tree as root and every later unprivileged mint on the node fails on
# it — recoverable only by hand.
if [ "$(id -u)" -eq 0 ] && [ -z "${RUNNER_ALLOW_RUNASROOT:-}" ]; then
	echo "WARM-FAIL refusing to configure a runner as root"
	exit 0
fi

ROOT="$HOME/.hadoku"
PAYLOAD="$ROOT/jit/payload"
DIR="$ROOT/warm/listener"

# --- ONE WRITER AT A TIME — issue #17 -------------------------------------
# `$DIR` is a cache of ONE, reused across every fill and rotate on this node,
# and RESET (below) removes `.runner`/`.credentials` before every configure —
# which only stays correct if exactly one provision is ever touching `$DIR`
# at a time. Two overlapping runs (a stray second mgmt-api process during a
# graceful restart, this script invoked by hand alongside a live tick, or any
# other future caller) can interleave: run B's `rm` can land, then run A's
# `configure` can finish and WRITE `.runner`, and only then does run B's own
# `configure` start — B's local "already configured" check runs at process
# start and never rechecks, so it sees A's file and refuses. That is
# `Runner.Listener`'s own `IsConfigured()` check, unconditional on
# `--replace`, which only ever inspects `.runner`'s presence — nothing this
# script does can make a SECOND writer safe, so a second writer is refused
# instead. `flock` on a fixed per-node lock file (not per-slot: there is only
# ever one slot) serializes the whole body, held for the process lifetime.
# Bounded rather than blocking forever: a wedged holder must surface as a
# failure a tick later, not silently queue every future provision behind it.
mkdir -p "$ROOT/warm" 2>/dev/null || true
LOCK="$ROOT/warm/.lock"
exec 9>"$LOCK" || { echo "WARM-FAIL cannot open $LOCK"; exit 0; }
if ! flock -w 15 9; then
	echo "WARM-FAIL could not acquire the warm-slot lock within 15s — another provision is in progress"
	exit 0
fi

# --- the payload (bin/externals only — shared with jit-provision.sh) -------
# Same sourcing jit-provision.sh uses for its own payload: a standing install
# first because it is local, instant and already version-matched, then the
# release tarball the CALLER resolved (it holds the GitHub token this script
# deliberately does not — see runnerTarballUrl in src/runners/ephemeral-exec.ts
# and THE BOOTSTRAP DEADLOCK in jit-provision.sh).
#
# In practice this branch is not taken at all: every ephemeral node already has
# a payload, because dispatch minted a JIT runner there long before the warm
# cache ever looked at it. It exists for the node that has NEVER held either.
if [ ! -x "$PAYLOAD/bin/Runner.Listener" ]; then
	src=""
	for d in "$HOME"/runners/actions-runner-*/ "$HOME"/actions-runner-*/ "$HOME"/actions-runner/; do
		d=${d%/}
		[ -x "$d/bin/Runner.Listener" ] || continue
		src="$d"
		break
	done
	mkdir -p "$PAYLOAD" || { echo "WARM-FAIL cannot create $PAYLOAD"; exit 0; }
	if [ -n "$src" ]; then
		# -L because inside an install `bin` and `externals` are SYMLINKS to
		# bin.<version>/externals.<version>; copying the links yields an empty
		# payload that still passes the `-x` test above.
		cp -aL "$src/bin" "$src/externals" "$PAYLOAD/" 2>/dev/null || {
			echo "WARM-FAIL payload copy from $src failed"
			exit 0
		}
	elif [ -n "${RUNNER_TARBALL_URL:-}" ]; then
		# Extract into STAGING and copy across only once it looks whole: a
		# half-extracted payload is indistinguishable from a good one to `-x`,
		# and would then be hardlinked into every slot.
		stage="$ROOT/jit/payload.staging.$$"
		rm -rf "$stage"
		mkdir -p "$stage" || { echo "WARM-FAIL cannot create $stage"; exit 0; }
		if ! curl -fsSL --retry 3 --retry-delay 2 --max-time 600 "$RUNNER_TARBALL_URL" |
			tar -xz -C "$stage" 2>/dev/null; then
			rm -rf "$stage"
			echo "WARM-FAIL could not fetch or unpack a runner release"
			exit 0
		fi
		if [ ! -x "$stage/bin/Runner.Listener" ]; then
			rm -rf "$stage"
			echo "WARM-FAIL runner release unpacked without bin/Runner.Listener"
			exit 0
		fi
		cp -aL "$stage/bin" "$stage/externals" "$PAYLOAD/" 2>/dev/null || {
			rm -rf "$stage"
			echo "WARM-FAIL payload copy from the downloaded release failed"
			exit 0
		}
		rm -rf "$stage"
		echo "WARM-BOOTSTRAP fetched a runner release; this node had no standing install"
	else
		echo "WARM-FAIL no runner install to source a payload from, and no RUNNER_TARBALL_URL"
		exit 0
	fi
fi

ver=$("$PAYLOAD/bin/Runner.Listener" --version 2>/dev/null | head -1)
[ -n "$ver" ] || { echo "WARM-FAIL payload will not execute"; exit 0; }

# The runner ROOT the 0.22.49 fix seeded here is dead weight now — a few hundred
# KB of real files plus a second set of hardlink names on the ~670 MB binary
# tree, kept only to hold a `config.sh` nothing calls any more. Removed on the
# first provision after the upgrade rather than left to mislead the next reader
# into thinking registration still goes through it. Unlinking names never
# touches the slot's or the payload's copies of the same inodes.
rm -rf "$ROOT/warm/root" 2>/dev/null || true

# --- the slot ------------------------------------------------------------
# Cache of ONE: a single fixed path, never numbered like a JIT slot, because
# there is never more than one warm listener on a node at a time — the
# previous one is evicted (registration removed + unit stopped) before this
# name is ever minted. Hardlinked from $PAYLOAD exactly as a JIT slot is.
if [ ! -x "$DIR/bin/Runner.Listener" ]; then
	rm -rf "$DIR"
	mkdir -p "$DIR"
	cp -al "$PAYLOAD/bin" "$PAYLOAD/externals" "$DIR/" 2>/dev/null || {
		echo "WARM-FAIL hardlink copy into $DIR failed"
		exit 0
	}
fi

# ALLOW-list, not a deny-list — issue #17's third diagnosis.
#
# The previous RESET named `.runner`/`.credentials`/`.credentials_rsaparams`/
# `_diag` and stopped there. `.runner_migrated` is not on that list, and
# `Runner.Listener`'s own `IsConfigured()` treats it exactly like `.runner`:
# `new FileInfo(_configFilePath).Exists || new FileInfo(_migratedConfigFilePath).Exists`
# (`ConfigurationStore.cs`, confirmed against actions/runner's own source).
# GitHub's service writes that file SERVER-side — `RunnerConfigUpdater.
# UpdateRunnerSettingsAsync` calls `SaveMigratedSettings` when a
# `RunnerRefreshConfigMessage` arrives on an actively-registered, listening
# runner (`Runner.cs`) — so this script never controls whether it lands, only
# whether it survives to the next configure. It hit claw-3/4/5 within the same
# second (2026-09-08 15:52:39-40 local), consistent with one server-side push
# reaching all three while they sat registered and idle; the RESET six-plus
# hours later cleared `.runner` but left `.runner_migrated` behind, and every
# fill since read as "already configured" with no `.runner` in sight.
#
# A deny-list fails by omission every time the runner grows a new identity
# file — `.credentials_migrated` is the same shape, written by the same
# message for the credentials half, unused by `IsConfigured()` today but no
# more knowable in advance than `.runner_migrated` was yesterday. An
# allow-list of what belongs in a FRESH slot fails safe instead: keep only the
# hardlinked payload (`bin`, `externals`), the warm checkout cache (`_work`,
# reused across jobs the same way jit-provision.sh keeps it for a JIT slot),
# and `.env` (rewritten in place below, RESET or not) — remove everything
# else, named or not. The next node to acquire a stray identity file, known or
# not yet invented, heals on its very next fill or rotate: RESET=1 is
# hardcoded at the only call site (ephemeral-exec.ts), so there is no manual
# step to repeat.
if [ "$RESET" = 1 ]; then
	find "$DIR" -mindepth 1 -maxdepth 1 \
		! -name bin ! -name externals ! -name _work ! -name .env \
		-exec rm -rf {} +
fi

# --- the environment: ONE writer, and it is not this script ----------------
# A warm listener is a STANDING registration, so it gets what a standing runner
# gets — both hooks and RUNNER_TOOL_CACHE — and it gets them from the file
# `fleet throttle` RENDERS for exactly that purpose:
# `~/.hadoku/standing.env`, written by scripts/lib/standing-runner-env.sh from
# the same `$LINE`/`$TCLINE`/`$MLINE` the throttle deploy writes into every
# other standing runner's `.env`.
#
# IT USED TO READ `runner.env`, AND THAT IS THE BUG (issue #11, #13).
# `~/.hadoku/runner.env` is the JIT SLOT's env. It carries RUNNER_TOOL_CACHE and
# the COMPLETED metrics hook and, deliberately, NOT
# ACTIONS_RUNNER_HOOK_JOB_STARTED — a JIT slot is bounded by the dispatcher's
# admission check and by systemd-run's MemoryMax/RuntimeMaxSec, not by the hook.
# A warm listener has none of those bounds: it is one long-lived process that
# accepts job after job. Built from `runner.env` it ran UNTHROTTLED, which is
# the node cap being bypassed on the one runner shape this package mints for
# itself.
#
# NO KEY IS NAMED HERE. The de-dupe below reads the KEYS OUT OF THE SOURCE FILE
# rather than listing them, so the day the throttle deploy adds a fourth key
# this script carries it with no edit and cannot drift into declaring a
# different set. Naming them here would be a second writer, which is the whole
# thing this is fixing.
#
# ABSENT IS A REFUSAL, NOT A WARNING. The previous version printed WARM-WARN and
# registered anyway; the result was a live standing runner with no cap on a node
# that declares one, and nothing downstream could tell it from a healthy one.
# Better no warm listener at all: the fill fails, the node backs off, and
# `fleet throttle --check` names the node. A node that has never had
# `fleet throttle --confirm` run on it since this shipped is exactly that case.
ENV_SRC="$ROOT/standing.env"
if [ ! -r "$ENV_SRC" ]; then
	echo "WARM-FAIL no $ENV_SRC — a standing listener would run with no throttle hook and no RUNNER_TOOL_CACHE. Run: fleet throttle --confirm --machine \$(hostname -s)"
	exit 0
fi
keys=$(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$ENV_SRC" | sort -u)
if [ -z "$keys" ]; then
	echo "WARM-FAIL $ENV_SRC declares no KEY=value lines — it is empty or truncated"
	exit 0
fi
if [ -f "$DIR/.env" ]; then
	# Drop any previous value of every key the source declares, so a re-provision
	# cannot leave two lines for one key — the runner takes the last one, which
	# makes a stale value win silently.
	cp "$DIR/.env" "$DIR/.env.tmp" 2>/dev/null || : >"$DIR/.env.tmp"
	for k in $keys; do
		grep -v "^$k=" "$DIR/.env.tmp" >"$DIR/.env.tmp2" 2>/dev/null || : >"$DIR/.env.tmp2"
		mv "$DIR/.env.tmp2" "$DIR/.env.tmp"
	done
	mv "$DIR/.env.tmp" "$DIR/.env"
fi
cat "$ENV_SRC" >>"$DIR/.env"
# Defensive, same as jit-provision.sh's twin: a standing listener's TMPDIR must
# exist before its first job, and the path is read back out of what was just
# merged rather than spelled here.
t=$(sed -n 's/^TMPDIR=//p' "$DIR/.env" | tail -1)
[ -n "$t" ] && mkdir -p "$t"

pi=$(stat -c %i "$PAYLOAD/bin/Runner.Listener" 2>/dev/null)
si=$(stat -c %i "$DIR/bin/Runner.Listener" 2>/dev/null)
if [ -n "$pi" ] && [ "$pi" != "$si" ]; then
	echo "WARM-FAIL slot is a real copy, not a hardlink (payload inode $pi, slot inode $si)"
	exit 0
fi

# --- register as a STANDING runner --------------------------------------
# No `--ephemeral`. That is the entire difference from every other registration
# this fleet creates, and it is why this cannot go through generate-jitconfig
# at all: GitHub's JIT config path has no non-ephemeral mode.
#
# `--disableupdate` is the hardlink guard — see the header. It is the caller-side
# `assertSafeJitConfig` check's equivalent for a path that has no caller-side
# config to assert against.
log="${TMPDIR:-/tmp}/warm-config.$$"
if ! (cd "$DIR" && ./bin/Runner.Listener configure --url "$URL" --token "$REG_TOKEN" \
	--name "$NAME" --labels "$LABELS" --unattended --replace --disableupdate \
	>"$log" 2>&1); then
	tail -5 "$log" 2>/dev/null | sed 's/^/warm-config /'
	rm -f "$log"
	echo "WARM-FAIL Runner.Listener configure did not register — see warm-config lines above"
	exit 0
fi
rm -f "$log"

if [ ! -f "$DIR/.credentials" ] || [ ! -f "$DIR/.runner" ]; then
	echo "WARM-FAIL configure reported success but left no .credentials/.runner"
	exit 0
fi

# The marker. Read back by currentWarmSlot() in ephemeral-exec.ts on every
# later tick — the record of which repo this node is warm for lives HERE, on
# the node, not in mgmt-api's memory, for the same reason the JIT units
# themselves are the record rather than anything this process remembers.
mkdir -p "$ROOT/warm"
printf '%s' "$REPO" >"$ROOT/warm/repo"

echo "WARM-READY $DIR $ver"
