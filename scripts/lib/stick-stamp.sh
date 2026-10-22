#!/usr/bin/env bash
#
# stick-stamp — say which build of the payload a stick is carrying.
#
# WHY A HASH AND NOT A VERSION STRING
# -----------------------------------
# `MANIFEST.sha256` already proves the stick is internally consistent: every
# file matches what was written beside it. It cannot tell you that what was
# written is a WEEK OLD, because it is the writer's own artifact checked against
# the writer's own files. That is the trap this repo names outright — a verifier
# that reads its own writer's output cannot fail.
#
# So `stamp_compare` does NOT trust the version it recorded. It re-hashes the
# scripts ON THE STICK against the scripts IN THE REPO and answers from that.
# A stamp that says 0.20.13 on a payload built at 0.20.9 is a lie the version
# string cannot detect and the hash cannot miss.
#
# The recorded version, commit and build time are for READING, never for
# deciding. They tell an operator holding an unlabelled stick where it came
# from; they are not evidence of currency.
#
# Measured 2026-08-31: the stick in hand carried a node-bootstrap.sh three
# commits old, with neither the hardware inventory nor the network preflight,
# and nothing on it could say so. Finding out took a `cmp` against a checkout
# that happened to be on the same machine.

# WHAT COUNTS AS THE PAYLOAD.
#
# The first version listed two files: bootstrap/node-bootstrap.sh and
# capability-probe.sh. Everything in fixes/ was invisible to it, so when
# claw-net-fix.sh was renamed and rewritten as claw-fix.sh the stick carried the
# OLD script and the stamp reported CURRENT. Measured 2026-09-02. A stamp that
# says current when it is not is worse than no stamp at all, because it is the
# thing telling you not to refresh.
#
# So the comparison covers the whole set of files that come verbatim from the
# repo, INCLUDING THEIR NAMES: a rename must read as stale, and it cannot if
# only a fixed list of paths is hashed. Excluded are the files usb-prep
# generates or the operator supplies -- the profile, authorized_key.pub, the
# STAMP and MANIFEST themselves -- and the *.test.mjs beside the fix scripts,
# which have no business on a stick.
STAMP_BOOTSTRAP_FILES="node-bootstrap.sh capability-probe.sh convert.sh"

# One line per payload file, "name sha256", sorted. Comparing the whole digest
# catches a changed file, a missing file, an extra file and a rename alike.
_stamp_digest() {
	# $1 = bootstrap dir, $2 = fixes dir
	{
		for f in $STAMP_BOOTSTRAP_FILES; do
			[ -f "$1/$f" ] && printf '%s %s\n' "$f" "$(sha256sum "$1/$f" | awk '{print $1}')"
		done
		for f in "$2"/*; do
			[ -f "$f" ] || continue
			case "$f" in *.test.mjs) continue ;; esac
			printf 'fixes/%s %s\n' "$(basename "$f")" "$(sha256sum "$f" | awk '{print $1}')"
		done
	} | sort
}

_stamp_repo_version() {
	local pkg="$1/package.json"
	[ -f "$pkg" ] || { printf 'unknown'; return; }
	sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -1
}

_stamp_repo_commit() {
	git -C "$1" rev-parse --short HEAD 2>/dev/null || printf 'no-git'
}

# Write the stamp. $1 = stick mount, $2 = repo root, $3 = profile id.
stamp_write() {
	local mnt="$1" root="$2" profile="$3" f
	{
		printf 'version=%s\n' "$(_stamp_repo_version "$root")"
		printf 'commit=%s\n' "$(_stamp_repo_commit "$root")"
		printf 'built=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		printf 'builder=%s\n' "$(hostname 2>/dev/null)"
		printf 'profile=%s\n' "$profile"
		# The part that actually decides.
		_stamp_digest "$mnt/bootstrap" "$mnt/fixes" | sed 's/^/sha /'
	} >"$mnt/STAMP"
}

# Print the stamp, or a stated absence. Never silent.
stamp_read() {
	if [ -f "$1/STAMP" ]; then
		cat "$1/STAMP"
	else
		printf 'no STAMP on this stick — built before stamping existed, or not by fleet usb-prep\n'
		return 1
	fi
}

# 0 = payload matches the repo, 1 = STALE, 2 = cannot tell.
#
# Re-hashes rather than reading the recorded version, deliberately. See above.
stamp_compare() {
	local mnt="$1" root="$2" have want
	[ -f "$mnt/STAMP" ] || return 2
	# The repo keeps the bootstrap scripts flat in scripts/ and the fixes in
	# scripts/fixes/; the stick nests them under bootstrap/ and fixes/. Compare
	# content and NAMES, not locations.
	have="$(_stamp_digest "$mnt/bootstrap" "$mnt/fixes")"
	want="$(_stamp_digest "$root/scripts" "$root/scripts/fixes")"
	# NOTHING COMPARED IS NOT A PASS. A stick whose payload is missing would
	# otherwise report "current" -- could-not-look rendering as nothing-is-wrong.
	[ -n "$have" ] && [ -n "$want" ] || return 2
	[ "$have" = "$want" ] || return 1
	return 0
}

# One line an operator can act on.
stamp_verdict() {
	local mnt="$1" root="$2"
	stamp_compare "$mnt" "$root"
	case $? in
	0) printf 'payload is CURRENT (%s)\n' "$(sed -n 's/^version=//p' "$mnt/STAMP")" ;;
	1) printf 'payload is STALE — the stick differs from this checkout. Run: fleet refresh\n' ;;
	2) printf 'CANNOT TELL whether this payload is current (no STAMP, or nothing to compare)\n' ;;
	esac
}
