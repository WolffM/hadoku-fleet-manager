#!/usr/bin/env bash
# register-fleet-runner.sh — register a self-hosted GH Actions runner on
# one claw for one repo. Idempotent (runs config.sh --replace).
#
# Background: WolffM is a personal GitHub account, not an org. Personal-
# account self-hosted runners are repo-scoped — they're only visible to
# the repo they're registered to. To run a self-hosted pool across N
# sibling repos, each runner node must register N times (one runner
# instance per target repo, each in its own ~/actions-runner-<repo>/
# directory with its own systemd unit).
#
# Each repo's runner picks up jobs only from THAT repo. Multiple jobs
# across repos can run concurrently on the same physical node — this
# changes the "1 job per node" property of single-runner setup, so
# watch for resource contention on heavier claws (especially claw-1's
# HDD).
#
# Usage:
#   fleet register <claw_ssh_alias> <runner_name> <full_repo>
#
# Examples:
#   fleet register claw1-admin claw-1 WolffM/hadoku-trader
#   fleet register claw3-admin claw-3 WolffM/hadoku-task-mobile
#
# To remove (run on the claw):
#   cd ~/actions-runner-<repo-suffix>
#   sudo ./svc.sh stop && sudo ./svc.sh uninstall
#   ./config.sh remove --token "$(gh api -X POST repos/<repo>/actions/runners/remove-token -q .token)"
#   rm -rf ~/actions-runner-<repo-suffix>

set -euo pipefail

CLAW_SSH="${1:?usage: $0 <claw_ssh_alias> <runner_name> <full_repo>}"
RUNNER_NAME="${2:?missing runner_name (e.g. claw-1)}"
FULL_REPO="${3:?missing full repo (e.g. WolffM/hadoku-trader)}"

# Repo dir suffix: the repo name without the owner/ prefix, lowercased,
# with anything that's not alnum or dash collapsed to dash. Keeps the
# claw filesystem layout predictable across repo-name variations.
REPO_SLUG="${FULL_REPO##*/}"
REPO_SUFFIX="$(echo "$REPO_SLUG" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g')"

echo "[register-fleet-runner] claw=$CLAW_SSH name=$RUNNER_NAME repo=$FULL_REPO suffix=$REPO_SUFFIX"

# Mint a fresh registration token. Tokens are single-use, expire in 1h.
# Requires `gh auth status` to have `repo` scope on the target.
TOKEN="$(gh api -X POST "repos/$FULL_REPO/actions/runners/registration-token" -q .token)"
if [[ -z "$TOKEN" ]]; then
  echo "[ERROR] failed to mint registration token for $FULL_REPO" >&2
  exit 1
fi

# Resolve the CURRENT runner release. This used to be pinned (v2.319.1) with
# the claw's cached tarball preferred unconditionally — so every new
# registration extracted whatever version the claw was originally provisioned
# with, and a fresh runner failed its first job ("'using: node24' is not
# supported", actions/checkout@v6) until self-update kicked in a minute later.
# GitHub also hard-deprecates old runner versions (that outage took all three
# hadoku-jobplatform runners down on 2026-08-06), so a stale-enough cache
# eventually cannot connect at all.
RUNNER_VERSION="$(gh api repos/actions/runner/releases/latest -q .tag_name)"
RUNNER_VERSION="${RUNNER_VERSION#v}"
if [[ -z "$RUNNER_VERSION" ]]; then
  echo "[ERROR] failed to resolve the latest actions/runner release" >&2
  exit 1
fi
echo "[register-fleet-runner] runner release: $RUNNER_VERSION"

# All work happens on the claw via a single ssh + bash heredoc.
# Per-claw layout:
#   ~/runners/actions-runner-<repo-suffix>/  — one dir per repo (moved out of ~ on 2026-10-09)
#   ~/runners/_cache/                        — version-keyed runner tarballs
ssh "$CLAW_SSH" bash <<EOF
set -e
RUNNER_DIR="\$HOME/runners/actions-runner-$REPO_SUFFIX"
SERVICE_NAME="actions.runner.$(echo "$FULL_REPO" | tr '/' '-').$RUNNER_NAME.service"

# Version-keyed tarball cache in ~/runners/_cache/, shared by every instance
# on this claw. A cache hit costs nothing; a miss refreshes the cache to the
# CURRENT release and drops stale tarballs (including the legacy unversioned
# runner.tar.gz, which sat at 2.319.1 from original provisioning). Each runner
# instance still needs its own dir — config.sh writes per-instance state
# (.runner, .credentials).
CACHE="\$HOME/runners/_cache/runner-$RUNNER_VERSION.tar.gz"
if [[ ! -f "\$CACHE" ]]; then
  mkdir -p "\$HOME/runners/_cache"
  rm -f "\$HOME"/runners/_cache/runner-*.tar.gz
  echo "[cache] downloading runner v$RUNNER_VERSION"
  curl -sSL -o "\$CACHE" "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"
else
  echo "[cache] reusing \$CACHE"
fi
if [[ ! -d "\$RUNNER_DIR" ]]; then
  mkdir -p "\$RUNNER_DIR"
  tar xzf "\$CACHE" -C "\$RUNNER_DIR"
fi

cd "\$RUNNER_DIR"

# Configure (or reconfigure with --replace).
./config.sh \\
  --url "https://github.com/$FULL_REPO" \\
  --token "$TOKEN" \\
  --labels hadoku-builder \\
  --name "$RUNNER_NAME" \\
  --unattended --replace

# config.sh writes .credentials under the login umask (0664 on hokon, where 27
# of 30 sat group-writable until 2026-10-10). Only the runner's own user reads
# them.
chmod 600 .runner .credentials .credentials_rsaparams 2>/dev/null || true

# .path so npm-global bin works for any workflow that does pnpm/wrangler/etc.
echo "\$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:/usr/games" > "\$RUNNER_DIR/.path"

# Clear any USER-level unit reconcile-fleet-runners.mjs left for this same
# directory. That script supervises \$DIR via run.sh; this one supervises it via
# svc.sh/runsvc.sh, and two supervisors on one runner directory means two
# listeners racing for one GitHub session — the loser burns 240s on
# SessionConflictException and exits 5, and any job caught in the overlap shares
# _diag and _work/_temp with a second process. That is what corrupted a
# hadoku-study run on 2026-08-20. This side wins because the system unit is what
# the other ~22 runners on each claw use; the reconciler now refuses the reverse.
USER_UNIT="actions-runner-$REPO_SUFFIX.service"
if systemctl --user list-unit-files "\$USER_UNIT" --no-pager --no-legend 2>/dev/null | grep -q .; then
  echo "[dedupe] removing competing user-level unit \$USER_UNIT"
  systemctl --user disable --now "\$USER_UNIT" 2>/dev/null || true
  rm -f "\$HOME/.config/systemd/user/\$USER_UNIT"
  systemctl --user daemon-reload 2>/dev/null || true
  # KillMode=process lets the listener outlive its unit, so it must be reaped
  # explicitly or it keeps the session and the new unit cannot start.
  for p in \$(pgrep -f "\$RUNNER_DIR/bin/Runner.Listener" || true); do kill "\$p" 2>/dev/null || true; done
  sleep 3
fi

# systemd unit; second arg = unix user, required when multiple runners
# share one host (which is exactly the case here).
sudo ./svc.sh install hadoku

# The vendored runner template (bin/actions.runner.service.template) sets NO
# Restart= directive, so systemd defaults to Restart=no and a runner that exits
# for ANY reason stays down until someone notices. On 2026-08-21 that had left
# three runners dead on every claw. The drop-in is applied here, at install, so
# a re-registration cannot quietly restore the stock template's behaviour.
#
# RestartPreventExitStatus=5 is load-bearing. Exit 5 is the runner's deliberate
# "A session for this runner already exists ... stop the service, no retry
# needed" — restarting into that is an endless conflict loop, so it is the one
# status we must honour rather than fight.
#
# KillMode=mixed is the other half of that same failure. The stock `process`
# signals only run.sh and never reaps its children, so a stop that outruns
# TimeoutStopSec leaves a Runner.Listener alive holding the single GitHub
# session — which is what MAKES the exit-5 conflict above. GitHub reports such a
# runner ONLINE the whole time, because it answers about the listener.
# `scripts/admin/fix-runner-supervision.sh` reconciles this across the fleet.
sudo mkdir -p "/etc/systemd/system/\$SERVICE_NAME.d"
printf '%s\n' \\
  '# Managed by fleet register — do not hand-edit.' \\
  '[Service]' \\
  'Restart=always' \\
  'RestartSec=15' \\
  'RestartPreventExitStatus=5' \\
  'KillMode=mixed' \\
  | sudo tee "/etc/systemd/system/\$SERVICE_NAME.d/restart.conf" >/dev/null
sudo systemctl daemon-reload

sudo ./svc.sh start

# Wait briefly + report status
sleep 2
sudo journalctl -u "\$SERVICE_NAME" --no-pager -n 6 | grep -E 'Connected|Listening' | tail -2 || true
EOF

echo "[register-fleet-runner] OK: $RUNNER_NAME → $FULL_REPO"
