#!/usr/bin/env bash
# attach-private.sh — connect this public checkout to the private one.
#
#   bash scripts/attach-private.sh        # from any worktree of this repo
#
# This repo was cut public from ONE squashed commit on 2026-10-20. Everything it
# left behind lives in WolffM/hadoku-fleet-manager-private: docs/planning/, the
# issues cited as bare `#N` in comments, and the 762 commits before the cut.
# This script makes both reachable locally and publishes neither:
#
#   1. docs/planning becomes a symlink into the private checkout, so every
#      `docs/planning/…` path cited in AGENTS.md and the code resolves. It is
#      gitignored, and publish-safety-guard fails if it is ever tracked.
#   2. The squashed root is grafted onto the private repo's `public-cut` tag, so
#      `git log` and `git blame` run through the old history. A graft is a
#      refs/replace/ ref: local, never pushed by `git push origin HEAD:main`.
#
# Re-running is safe. Run it once per clone and once per new worktree (the
# symlink is per working tree; the graft is shared).
#
#   FLEET_PRIVATE_DIR   the private checkout
#                       (default: hadoku-fleet-manager-private beside the main checkout)
set -euo pipefail

die() { echo "attach-private: $*" >&2; exit 1; }

TOP="$(git rev-parse --show-toplevel)"
COMMON="$(cd "$TOP" && cd "$(git rev-parse --git-common-dir)" && pwd)"
MAIN="$(dirname "$COMMON")"
PRIV="${FLEET_PRIVATE_DIR:-$(dirname "$MAIN")/hadoku-fleet-manager-private}"

# The private repo's URL is this one's with -private on the end, so no owner is
# spelled out in a published script.
ORIGIN="$(git remote get-url origin)"
[ -d "$PRIV/docs/planning" ] || die "no $PRIV/docs/planning.
  git clone ${ORIGIN%.git}-private.git $PRIV
  or set FLEET_PRIVATE_DIR to where it is."

LINK="$TOP/docs/planning"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
	die "$LINK is a real directory, not the symlink. Move anything in it to $PRIV/docs/planning, delete it, and re-run."
fi
ln -sfn "$PRIV/docs/planning" "$LINK"
echo "docs/planning -> $PRIV/docs/planning"

# --no-replace-objects: once grafted, the root git reports is the PRIVATE root.
ROOT="$(git --no-replace-objects rev-list --max-parents=0 HEAD)"
[ "$(wc -l <<<"$ROOT")" = 1 ] || die "expected one root commit, found: $ROOT"
git -C "$TOP" fetch --quiet --no-tags "$PRIV" "+refs/tags/public-cut:refs/private/public-cut" \
	|| die "could not fetch the public-cut tag from $PRIV"
PARENT="$(git rev-parse refs/private/public-cut^{commit})"
if [ "$(git replace -l "$ROOT")" = "$ROOT" ] \
	&& [ "$(git rev-parse "refs/replace/$ROOT^")" = "$PARENT" ]; then
	echo "history already attached (root ${ROOT:0:12} -> ${PARENT:0:12})"
else
	git replace -f --graft "$ROOT" "$PARENT"
	echo "history attached: root ${ROOT:0:12} -> private ${PARENT:0:12}"
fi
