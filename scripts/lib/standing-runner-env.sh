#!/usr/bin/env bash
# standing-runner-env — render `~/.hadoku/standing.env`: the env EVERY standing
# runner on this node gets, published as a file so a runner the walker cannot
# reach still gets exactly what the walker would have written.
#
# APPENDED to ci-throttle-install.sh by deploy-ci-throttle.mjs, exactly the way
# lib/runner-toolcache.sh is PREPENDED. It runs in the same shell, so it reads
# `$LINE`, `$TCLINE` and `$MLINE` — the variables ci-throttle-install.sh derives
# and writes into every standing runner's `.env`. That is the whole point: there
# is ONE derivation of "what a standing runner's environment is on this node",
# and this publishes it rather than restating it. A fourth key added to the
# writer lands here for free, with nothing to keep in step.
#
# WHY A SECOND FILE AND NOT `~/.hadoku/runner.env`
# ------------------------------------------------
# `runner.env` is the JIT SLOT's env, and it is deliberately short two things a
# standing runner has: it carries RUNNER_TOOL_CACHE and the COMPLETED metrics
# hook, and NOT ACTIONS_RUNNER_HOOK_JOB_STARTED. A JIT slot is not throttled by
# the hook on purpose — the dispatcher's own admission check bounds how many can
# exist, and systemd-run gives each one MemoryMax and RuntimeMaxSec directly.
# Adding the throttle to `runner.env` would silently put a 90-second gate in
# front of every JIT job on the fleet, which is a different decision than this
# one. So the two envs are two files, and each consumer takes the one that
# describes what it is.
#
# WHO READS IT
# ------------
# `warm-provision.sh`. A warm listener is a STANDING registration — it exists
# before the job does, it serves job after job, and nothing else bounds how many
# jobs land on it — so it must carry the throttle hook. It was built from
# `runner.env` until 2026-09-09 and therefore ran UNTHROTTLED: the cap the
# throttle enforces on every other standing runner was bypassed on the warm
# path, on the one runner shape that is standing AND minted by this package
# rather than by an operator.
#
# The `ci-throttle-install.sh` walker DOES enumerate a live warm slot (its
# listener-union union picks up any running Runner.Listener, and the JIT
# exclusion is `~/.hadoku/jit/` only) — but only AFTER the listener is running,
# and Runner.Listener reads `.env` once at start. So the walker can repair a
# warm slot on the next deploy; it cannot make the FIRST job on a freshly minted
# one throttled. This file can, because warm-provision.sh writes the `.env`
# before the listener ever starts.
#
# WHY IT REPORTS UNDER `--check` WITHOUT WRITING
# ---------------------------------------------
# `APPLY=0` under `--check`, so the comparison below reads what a PREVIOUS
# `--confirm` left on the box against what this package would write now. A
# verifier that reads its own writer's artifact cannot fail — the driver already
# refuses `--check --confirm` together for exactly that reason, and this obeys
# the same rule.

STANDING_ENV="$HOME/.hadoku/standing.env"
# The same five lines, in the same order, that the walker writes into a
# standing runner's own `.env` — TMPDIR and NODE_COMPILE_CACHE (#100/#101)
# ride along with $LINE/$TCLINE/$MLINE for the same reason those three do:
# one derivation, published once. Nothing is re-derived here.
STANDING_WANT=$(printf '%s\n%s\n%s\n%s\n%s' "$LINE" "$TCLINE" "$MLINE" "$TMPLINE" "$COMPLINE")

if [ "$APPLY" = 1 ]; then
	mkdir -p "$HOME/.hadoku"
	# Written through a temp file: a warm provision reading a half-written
	# standing.env would build a listener missing whichever key had not landed
	# yet, and that listener would look perfectly healthy.
	if printf '%s\n' "$STANDING_WANT" >"$STANDING_ENV.tmp" 2>/dev/null &&
		chmod 0644 "$STANDING_ENV.tmp" 2>/dev/null &&
		mv "$STANDING_ENV.tmp" "$STANDING_ENV" 2>/dev/null; then
		:
	else
		rm -f "$STANDING_ENV.tmp" 2>/dev/null || true
	fi
fi

# Three outcomes, never two — `absent` and `stale` send an operator to the same
# command today but they are different facts, and collapsing them is how a
# finding stops being diagnosable.
if [ ! -r "$STANDING_ENV" ]; then
	echo "STANDING-ENV absent"
elif [ "$(cat "$STANDING_ENV" 2>/dev/null)" = "$STANDING_WANT" ]; then
	echo "STANDING-ENV ok"
else
	echo "STANDING-ENV stale"
fi
