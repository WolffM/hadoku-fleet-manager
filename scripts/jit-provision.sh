#!/usr/bin/env bash
# jit-provision — prepare one hardlinked slot for an ephemeral runner mint.
#
# Inputs (leading assignments on stdin, like the other node-half scripts):
#   SLOT=<n>          which slot to prepare
#   RESET=0|1         wipe the previous mint's identity out of it (default 1)
#   RUNNER_TARBALL_URL  where to fetch a runner release when this node has no
#                     standing install to copy one out of. Optional; see THE
#                     BOOTSTRAP DEADLOCK below.
#
# Prints `SLOT-READY <path> <version>` on success, or `SLOT-FAIL <reason>`.
#
# WHY A SHARED PAYLOAD PLUS HARDLINKED SLOTS
# ------------------------------------------
# A JIT listener resolves its root from the BINARY's real path and writes its
# config there. Measured on claw-3 2026-08-26:
#
#   bin/externals as SYMLINKS into a shared payload -> config lands in the
#     SHARED payload. No isolation, and two concurrent mints collide.
#   bin/externals HARDLINKED (cp -al)               -> config lands in the SLOT,
#     while the files share inodes with the payload.
#
# So a slot costs ~8 MB of real disk against 674 MB for the payload: one payload
# plus four slots is 706 MB, not 2.7 GB.
#
# THE HARDLINK HAZARD IS REAL AND THIS REPO HAS ALREADY BEEN BITTEN BY IT.
# On ext4 there is no reflink, so a hardlink is a second name for one inode and
# a truncating write through either name zeroes the other — the same mechanism
# that corrupts the pnpm store (see CLAUDE.md). A runner that self-updated in
# place would rewrite the payload for every slot at once. `generate-jitconfig`
# sets DisableUpdate, and the caller asserts it (assertSafeJitConfig), but the
# payload is also kept read-only-ish by never being the tree a runner is
# CONFIGURED in.
set -u

SLOT="${SLOT:-0}"
RESET="${RESET:-1}"
case "$SLOT" in '' | *[!0-9]*) echo "SLOT-FAIL slot '$SLOT' is not a number"; exit 0 ;; esac

ROOT="$HOME/.hadoku/jit"
PAYLOAD="$ROOT/payload"
DIR="$ROOT/slot$SLOT"

# --- the payload -----------------------------------------------------------
# Sourced from an existing runner install, dereferenced: `bin` and `externals`
# inside an install are SYMLINKS to bin.<version>/externals.<version>, so a
# plain `cp -a` copies the links and yields an empty payload that still passes a
# cursory look. Caught exactly that way on 2026-08-26.
#
# THE BOOTSTRAP DEADLOCK, AND WHY THE DOWNLOAD BRANCH EXISTS
# ---------------------------------------------------------
# Copying out of a standing install was the ONLY way to get a payload, and that
# closed a loop no ephemeral node could ever escape:
#
#   a mint needs a payload
#     -> a payload needs a standing install on this node
#       -> standing installs come from reconcile-fleet-runners' registerScript
#         -> which acts on placementFor(), whose last filter is
#            `m.ephemeral !== true || m.residentRepos.includes(repo)`
#           -> so a node declared `ephemeral: true` is dropped from EVERY
#              repo, gets no standing install, and can never mint.
#
# A node declared ephemeral from the outset is therefore dead on arrival, and
# it reports GREEN the whole way: provisioning step 1 is a no-op by design for an
# ephemeral node and exits 0, `fleet throttle --check` asserts only that this
# script EXISTS, and runnerCensus counts the box at its full budget off a bare
# SSH probe — so the fleet believes it has capacity it does not have, and the
# backstop that would have covered the gap is suppressed by the phantom.
#
# claw-3 works only by historical accident: it was registered as a standing
# node first, its payload was built on 2026-08-26 while those installs
# existed, and only then was it flipped ephemeral and torn down.
#
# So the payload has a second source. `RUNNER_TARBALL_URL` is resolved by the
# CALLER, which holds the GitHub token this script deliberately does not — see
# runnerTarballUrl() in src/runners/ephemeral-exec.ts. Same artifact GitHub
# hands a first-time installer; the standing-install copy is kept as the first
# choice because it is local, instant, and already version-matched to the fleet.
# >>> payload — IDENTICAL in jit-provision.sh and warm-provision.sh
# (lib/payload-block-guard.test.mjs fails the build if the two copies differ).
#
# THE PAYLOAD FOLLOWS THE RELEASE (fleet-manager#1). It used to be built once
# and never again: on 2026-10-24 five nodes were minting every job from a
# 2.336.0 payload built 2026-07-20, against a 2.338.1 release, and only a
# preflight sample of whichever jit-* happened to be registered noticed. The
# caller resolves RUNNER_TARBALL_URL on every mint (runnerTarballUrl, cached
# 24h), and the file name carries the version. A payload BEHIND it is
# rebuilt here: fetched into a staging tree, proved to run at that version,
# and swapped in with two renames. Never a downgrade: a cached URL a day old
# must not undo a newer payload.
#
# UNDER A LOCK, because two mints on one node can both see a stale payload, and
# a mint that read the tree between the two renames would find nothing.
#
# A SLOT LINKED TO AN OLD PAYLOAD IS RELINKED, not refused. Slots are reused,
# and each one's bin/externals are hardlinks into the payload it was built
# from. After a swap every existing slot's inode differs, and the hardlink
# assertion below used to fail every mint on the node until someone cleared
# them. A slot is only ever handed to this script idle, so its bin/externals
# are replaced and its _work cache is kept. Running listeners hold the old
# inodes open, so removing the old tree does not touch them.
payload_want() {
	case "${RUNNER_TARBALL_URL:-}" in
	*/actions-runner-linux-x64-*.tar.gz)
		pw=${RUNNER_TARBALL_URL##*/actions-runner-linux-x64-}
		printf '%s' "${pw%.tar.gz}"
		;;
	esac
}
payload_fetch() { # $1 = destination tree; unpacks the release there, dereferenced
	pf_stage="$1.staging"
	rm -rf "$pf_stage" "$1"
	mkdir -p "$pf_stage" "$1" || return 1
	if ! curl -fsSL --retry 3 --retry-delay 2 --max-time 600 "$RUNNER_TARBALL_URL" |
		tar -xz -C "$pf_stage" 2>/dev/null; then
		rm -rf "$pf_stage" "$1"
		return 1
	fi
	# -L: inside a release `bin` and `externals` are symlinks to
	# bin.<version>/externals.<version>; copying the links yields an empty tree
	# that still passes a cursory `-x` look. Caught exactly that way 2026-08-26.
	if [ ! -x "$pf_stage/bin/Runner.Listener" ] ||
		! cp -aL "$pf_stage/bin" "$pf_stage/externals" "$1/" 2>/dev/null; then
		rm -rf "$pf_stage" "$1"
		return 1
	fi
	rm -rf "$pf_stage"
}
payload_ensure() { # -> 0 with $PAYLOAD runnable, or prints <FAILP> <reason> and returns 1
	pdir=$(dirname "$PAYLOAD")
	mkdir -p "$pdir" || { echo "$FAILP cannot create $pdir"; return 1; }
	exec 8>"$pdir/.payload.lock" || { echo "$FAILP cannot open $pdir/.payload.lock"; return 1; }
	flock -w 300 8 || { echo "$FAILP the payload lock was held for 300s — another mint is building it"; return 1; }
	if [ ! -x "$PAYLOAD/bin/Runner.Listener" ]; then
		src=""
		for d in "$HOME"/runners/actions-runner-*/ "$HOME"/actions-runner-*/ "$HOME"/actions-runner/; do
			d=${d%/}
			[ -x "$d/bin/Runner.Listener" ] || continue
			src="$d"
			break
		done
		if [ -n "$src" ]; then
			mkdir -p "$PAYLOAD" && cp -aL "$src/bin" "$src/externals" "$PAYLOAD/" 2>/dev/null ||
				{ echo "$FAILP payload copy from $src failed"; return 1; }
		elif [ -n "${RUNNER_TARBALL_URL:-}" ]; then
			payload_fetch "$PAYLOAD" || { echo "$FAILP could not fetch or unpack a runner release"; return 1; }
			echo "PAYLOAD-BOOTSTRAP fetched a runner release; this node had no standing install"
		else
			echo "$FAILP no runner install to source a payload from, and no RUNNER_TARBALL_URL"
			return 1
		fi
	fi
	have=$("$PAYLOAD/bin/Runner.Listener" --version 2>/dev/null | head -1)
	want=$(payload_want)
	if [ -n "$have" ] && [ -n "$want" ] && [ "$have" != "$want" ] &&
		[ "$(printf '%s\n%s\n' "$have" "$want" | sort -V | head -1)" = "$have" ]; then
		next="$pdir/payload.next.$$"
		if payload_fetch "$next" &&
			[ "$("$next/bin/Runner.Listener" --version 2>/dev/null | head -1)" = "$want" ]; then
			old="$pdir/payload.old.$$"
			if mv "$PAYLOAD" "$old" && mv "$next" "$PAYLOAD"; then
				rm -rf "$old"
				echo "PAYLOAD-REFRESHED $have -> $want"
			else
				[ -d "$PAYLOAD" ] || mv "$old" "$PAYLOAD"
				rm -rf "$next"
				echo "PAYLOAD-REFRESH-FAILED $have, wanted $want: the swap failed; kept $have"
			fi
		else
			# Not fatal: the old payload still runs, and preflight's jit-payload
			# finding names a node that stays behind.
			rm -rf "$next"
			echo "PAYLOAD-REFRESH-FAILED $have, wanted $want: the release did not fetch or run; kept $have"
		fi
	fi
	flock -u 8
	return 0
}
payload_link() { # $1 = an IDLE slot: give it bin/externals hardlinked to the current payload
	pl_p=$(stat -c %i "$PAYLOAD/bin/Runner.Listener" 2>/dev/null)
	pl_s=$(stat -c %i "$1/bin/Runner.Listener" 2>/dev/null)
	if [ ! -x "$1/bin/Runner.Listener" ]; then
		rm -rf "$1"
		mkdir -p "$1"
	elif [ "$pl_p" = "$pl_s" ]; then
		return 0
	else
		rm -rf "$1/bin" "$1/externals"
		echo "SLOT-RELINKED $1 (it was built from an older payload)"
	fi
	cp -al "$PAYLOAD/bin" "$PAYLOAD/externals" "$1/" 2>/dev/null ||
		{ echo "$FAILP hardlink copy into $1 failed"; return 1; }
}
# <<< payload
FAILP=SLOT-FAIL
payload_ensure || exit 0

ver=$("$PAYLOAD/bin/Runner.Listener" --version 2>/dev/null | head -1)
[ -n "$ver" ] || { echo "SLOT-FAIL payload will not execute"; exit 0; }

# --- the slot --------------------------------------------------------------
payload_link "$DIR" || exit 0

# A slot carries the PREVIOUS mint's identity until it is cleared, and a stale
# .credentials is exactly what makes a runner authenticate as something it is
# not (§12.9). _work is deliberately KEPT: the runner namespaces it per repo and
# it is the warm checkout cache that makes a mint worth reusing a slot for.
if [ "$RESET" = 1 ]; then
	rm -f "$DIR/.runner" "$DIR/.credentials" "$DIR/.credentials_rsaparams"
	rm -rf "$DIR/_diag"
fi

# THE TOOL CACHE. Runner.Listener reads .env from its own root once at start, so
# a slot without one runs every job with no RUNNER_TOOL_CACHE.
#
# That was the state of every JIT slot until 2026-09-02: ci-throttle-install.sh
# writes .env only into directories holding a `.runner`, which a slot has not got
# until a mint creates one, and it skips ~/.hadoku/jit/ as well. The result was
# silent in exactly the way lib/runner-toolcache.sh warns about — actions/setup-python
# finds no interpreter and falls through to a download that cannot succeed on
# Debian 13. It only became fleet-wide when the last standing runner went away,
# because until then those jobs landed on runners that DID have the value.
#
# Written every run, not just on RESET: a slot provisioned before this existed
# must pick it up too. The value comes from ~/.hadoku/runner.env, which the
# installer derives from lib/runner-toolcache.sh — the one place that rule is
# stated. If it is missing, say so rather than guessing at /opt/hostedtoolcache:
# guessing is wrong for the openclaw instances and would send them at a tree they
# cannot even traverse.
if [ -r "$HOME/.hadoku/runner.env" ]; then
	# MERGE, never truncate — .env is shared with anything else that writes it.
	if [ -f "$DIR/.env" ]; then
		grep -v -e '^RUNNER_TOOL_CACHE=' -e '^ACTIONS_RUNNER_HOOK_JOB_COMPLETED=' \
			-e '^TMPDIR=' -e '^NODE_COMPILE_CACHE=' \
			"$DIR/.env" >"$DIR/.env.tmp" 2>/dev/null || : >"$DIR/.env.tmp"
		mv "$DIR/.env.tmp" "$DIR/.env"
	fi
	cat "$HOME/.hadoku/runner.env" >>"$DIR/.env"
	# Defensive: the installer creates TMPDIR on this node, but a slot merging
	# a DIFFERENT node's stale runner.env (or one hand-edited) must not hand a
	# job a path that does not exist — mktemp fails loudly on that, every job.
	# The path is read back out of what was just merged, never spelled here, so
	# this stays the one place ($HOME/runner-tmp in ci-throttle-install.sh)
	# that names it.
	t=$(sed -n 's/^TMPDIR=//p' "$DIR/.env" | tail -1)
	[ -n "$t" ] && mkdir -p "$t"
else
	echo "SLOT-WARN no ~/.hadoku/runner.env — this slot has no RUNNER_TOOL_CACHE, so setup-python will fail on it. Re-run: fleet throttle --confirm --machine \$(hostname -s)"
fi

# Assert the slot is genuinely hardlinked rather than deep-copied — the failure
# is silent and only visible as disk that quietly grows per mint.
pi=$(stat -c %i "$PAYLOAD/bin/Runner.Listener" 2>/dev/null)
si=$(stat -c %i "$DIR/bin/Runner.Listener" 2>/dev/null)
if [ -n "$pi" ] && [ "$pi" != "$si" ]; then
	echo "SLOT-FAIL slot$SLOT is a real copy, not a hardlink (payload inode $pi, slot inode $si)"
	exit 0
fi

echo "SLOT-READY $DIR $ver"
