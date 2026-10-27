#!/usr/bin/env bash
# runner-payload — the runner payload both minters build their slots from.
#
# A LIBRARY, never run on its own. It defines functions and nothing else, and
# `nodeScript()` (src/runners/node-script.ts) sends it ahead of
# jit-provision.sh or warm-provision.sh in the one command the controller runs
# on a node. Neither minter is kept on the node: the text travels with every
# mint, so the code a node runs is always the code the controller holds.
#
# The caller sets, before calling payload_ensure / payload_link:
#   PAYLOAD             the shared tree, ~/.hadoku/jit/payload
#   FAILP               the failure prefix its caller parses (SLOT-FAIL / WARM-FAIL)
#   RUNNER_TARBALL_URL  optional; the release the caller resolved
#
# Until 2026-10-27 these functions were pasted into both minters, with a
# comment naming a guard test that did not exist. They had already been edited
# twice in lockstep (fleet-manager#1).
#
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
