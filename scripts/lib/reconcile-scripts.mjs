import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLCACHE_RULE = resolve(HERE, 'runner-toolcache.sh');

/**
 * Free disk a claw must keep AFTER a registration, in GB. A runner install is
 * ~835 MB before `_work` checkouts start growing, and claw-2 is the binding
 * constraint at 110 GB total. Registering past this trades a CI gap for a full
 * disk, which is strictly worse.
 */
export const MIN_FREE_GB_AFTER = 15;
export const INSTALL_GB = 1;

/** Same slug rule as register-fleet-runner.sh, so layouts stay comparable. */
export const repoSuffix = (repo) =>
	repo
		.split('/')
		.pop()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-');

/**
 * Registration, as `openclaw`, with a user systemd unit.
 *
 * The runner version is resolved fresh per run and the tarball cache is keyed
 * by it — both lessons from `register-fleet-runner.sh`, where a pinned v2.319.1
 * meant every new registration extracted whatever the claw was provisioned with
 * and failed its first job until self-update caught up. GitHub hard-deprecates
 * old runners, so a stale-enough cache eventually cannot connect at all.
 */
export function registerScript({ repo, claw, version, token, labels, start }) {
	const suffix = repoSuffix(repo);
	// ENABLED, NOT STARTED, on a claw (#1). A unit's first start decides its
	// cgroup, so starting it here put it in app.slice — no group ceiling — and a
	// runner started before its .env carries the throttle hook has no
	// concurrency limit and no shared tool cache. The caller writes both through
	// the drivers and only then starts it; see provisionBeforeStart. A guest
	// (start=true) is out of both drivers' scope and starts here, as it always did.
	const startBlock = start
		? 'systemctl --user enable --now "$UNIT"\nsleep 3\nsystemctl --user is-active "$UNIT"'
		: 'systemctl --user enable "$UNIT"';
	return `
set -euo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

mkdir -p "$HOME/runners"
DIR="$HOME/runners/actions-runner-${suffix}"
CACHE_DIR="$HOME/.cache/gh-runner"
CACHE="$CACHE_DIR/runner-${version}.tar.gz"
UNIT="actions-runner-${suffix}.service"
UNIT_PATH="$HOME/.config/systemd/user/$UNIT"

free_gb=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc '0-9')
if [ "$free_gb" -lt $((${MIN_FREE_GB_AFTER} + ${INSTALL_GB})) ]; then
  echo "REFUSED: only \${free_gb}G free on $(hostname); need $((${MIN_FREE_GB_AFTER} + ${INSTALL_GB}))G" >&2
  exit 3
fi

mkdir -p "$CACHE_DIR"
# Download to a TEMP file, verify it is actually a gzip, and only then publish it
# into the cache. \`curl -sSL -o\` happily writes an HTTP error body to disk and
# exits 0, so a transient GitHub hiccup cached a 54 KB HTML page as
# "runner-2.336.0.tar.gz" on 2026-08-24. Because the cache check is
# \`[ ! -f "$CACHE" ]\`, that one bad download then poisoned every subsequent
# registration on the box: all 24 failed with "gzip: stdin: not in gzip format"
# and 0 were installed. Same shape as a CF challenge page being fed to jq.
if [ ! -s "$CACHE" ] || ! gzip -t "$CACHE" 2>/dev/null; then
  rm -f "$CACHE_DIR"/runner-*.tar.gz
  echo "[cache] downloading runner v${version}"
  TMP="$CACHE.part.$$"
  # -f: fail on 4xx/5xx instead of saving the error page. --retry: the failure
  # that started this was transient.
  if ! curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors -o "$TMP" \\
    "https://github.com/actions/runner/releases/download/v${version}/actions-runner-linux-x64-${version}.tar.gz"; then
    rm -f "$TMP"
    echo "REFUSED: could not download runner v${version}" >&2
    exit 4
  fi
  if ! gzip -t "$TMP" 2>/dev/null; then
    head -c 120 "$TMP" | tr -d '\\0' >&2 || true
    rm -f "$TMP"
    echo "" >&2
    echo "REFUSED: downloaded runner v${version} is not a gzip (see the first bytes above)" >&2
    exit 4
  fi
  mv "$TMP" "$CACHE"
else
  echo "[cache] reusing $CACHE"
fi

# Test for the BINARY, not the directory. \`mkdir -p\` succeeds and \`tar\` then
# fails, so a failed install leaves an EMPTY directory behind — and a
# \`[ ! -d "$DIR" ]\` guard reads that as "already installed", skips extraction,
# and dies on \`./config.sh: No such file or directory\`. That is what every one
# of the 24 hokon registrations hit on the retry after the poisoned-cache
# failure: the first run created the dirs, the second refused to fill them.
# Checking for the thing you are about to RUN makes the retry self-healing.
if [ ! -x "$DIR/config.sh" ]; then
  mkdir -p "$DIR"
  tar xzf "$CACHE" -C "$DIR"
fi
if [ ! -x "$DIR/config.sh" ]; then
  echo "REFUSED: $DIR has no config.sh after extraction" >&2
  exit 5
fi
cd "$DIR"

./config.sh \\
  --url "https://github.com/${repo}" \\
  --token "${token}" \\
  --labels ${labels} \\
  --name "${claw}" \\
  --unattended --replace

${readFileSync(TOOLCACHE_RULE, 'utf8')}
# MERGE, never truncate. This file has THREE writers — config.sh seeds LANG,
# deploy-ci-throttle appends ACTIONS_RUNNER_HOOK_JOB_STARTED, and this sets
# RUNNER_TOOL_CACHE — and it used to be written with \`>\`, so registering or
# re-registering a runner silently deleted the throttle hook from a live
# node. Nothing failed at the time: Runner.Listener reads .env once at start,
# so the runner kept working unthrottled-on-paper until its next restart, and
# check:throttle would have blamed a node nobody had touched.
ENV_FILE="$DIR/.env"
if [ -f "$ENV_FILE" ]; then
  grep -v '^RUNNER_TOOL_CACHE=' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || : > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
fi
echo "RUNNER_TOOL_CACHE=$TOOLCACHE" >> "$ENV_FILE"
echo "[toolcache] $(id -un) -> $TOOLCACHE"
echo "/usr/local/bin:/usr/bin:/bin:/usr/games" > "$DIR/.path"

# REFUSE to become a second supervisor for this runner directory.
#
# register-fleet-runner.sh installs a SYSTEM unit (svc.sh -> runsvc.sh); this
# script installs a USER unit (run.sh). Both drive the same directory and the
# same GitHub registration, and neither used to look for the other. On
# 2026-08-18 both ran within an hour for study, filetransfer and privatebin, on
# all three claws — nine double-supervised runners.
#
# Two listeners race for one session: one wins, the other burns 240s on
# SessionConflictException and exits 5 ("stop the service, no retry needed").
# Any job landing in the overlap shares _diag and _work/_temp with a second
# process, which is what corrupted a hadoku-study run on 2026-08-20
# ("_diag/pages/... already exists", "Missing file at path: ...save_state_*").
# The survivor then runs unsupervised while GitHub still reports it ONLINE, so
# the offline alert is structurally blind to it.
#
# Skipping is the safe direction: a system unit already covers this repo, so
# refusing costs nothing, while installing costs a corrupted job.
if systemctl list-units 'actions.runner.*' --all --no-pager --no-legend 2>/dev/null \
   | awk '{print $1}' \
   | while read -r u; do systemctl show "$u" -p ExecStart --value 2>/dev/null | grep -q "$DIR/" && echo hit; done \
   | grep -q hit; then
  echo "SKIP: $DIR already has a system-level unit — refusing to add a second supervisor" >&2
  exit 0
fi

mkdir -p "$HOME/.config/systemd/user"
cat > "$UNIT_PATH" <<UNIT_EOF
[Unit]
Description=GitHub Actions runner (${repo})
After=network-online.target

[Service]
ExecStart=%h/runners/actions-runner-${suffix}/run.sh
WorkingDirectory=%h/runners/actions-runner-${suffix}
Restart=always
RestartSec=5
# NOT the stock KillMode=process, which signals only run.sh and never reaps its
# children: a stop that outruns TimeoutStopSec then leaves a Runner.Listener
# alive holding the GitHub session, while the restarted unit loops on
# SessionConflictException and GitHub reports the runner ONLINE throughout.
# mixed keeps the graceful path identical and SIGKILLs any survivor.
KillMode=mixed
# Exit 5 IS that session conflict — the runner's deliberate "another listener
# owns this registration, do not retry". Restarting into it loops forever.
RestartPreventExitStatus=5
KillSignal=SIGTERM
TimeoutStopSec=5min

[Install]
WantedBy=default.target
UNIT_EOF
echo "UNIT-WRITTEN $UNIT"

systemctl --user daemon-reload
${startBlock}
`;
}

/**
 * Start a unit whose slice drop-in and throttle env are already on disk, and
 * prove where it landed.
 *
 * THE KERNEL, NOT THE CONFIG. `Slice=` reads right the moment the drop-in
 * exists; only `ControlGroup` says where the processes went. A unit that
 * comes up outside the slice FAILS the registration here, rather than waiting
 * for check:slice to find it the next night.
 *
 * THE ONE-SECOND SLEEP is for check:throttle's staleness rule, which calls a
 * listener stale when its `.env` mtime is NEWER than the listener's start,
 * both in whole seconds. The throttle step wrote that `.env` moments ago, and
 * a start inside the same second can read as one second EARLIER than the
 * write. Then a correctly provisioned runner reports "written but not loaded".
 */
export function startScript({ repo, sliceName }) {
	const unit = 'actions-runner-' + repoSuffix(repo) + '.service';
	return `
set -euo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
UNIT="${unit}"
sleep 1
systemctl --user daemon-reload
systemctl --user start "$UNIT"
sleep 3
systemctl --user is-active "$UNIT"
cg=$(systemctl --user show "$UNIT" -p ControlGroup --value)
parent=\${cg%/*}
parent=\${parent##*/}
if [ "$parent" != "${sliceName}" ]; then
  echo "BORN-OUTSIDE-SLICE $UNIT effective=\${parent:-none} want=${sliceName}" >&2
  exit 6
fi
echo "STARTED $UNIT in ${sliceName}"
`;
}

/**
 * Tear one (repo, node) registration down, whichever systemd manager owns it.
 *
 * TWO MANAGERS, AND THIS KNEW ABOUT ONE. Until 2026-09-01 the only unit this
 * touched was the USER unit `actions-runner-<suffix>.service`. But a runner
 * installed with `sudo ./svc.sh install` is a SYSTEM unit named
 * `actions.runner.<owner>-<repo>.<runner>.service` — GitHub's own naming, which
 * keeps the repo's original case where the directory is lowercased. claw-1
 * carried 24 of those.
 *
 * The consequence, measured that day on claw-1: `systemctl --user disable`
 * matched nothing and said so into `|| true`, the service kept running,
 * `config.sh remove` refused because the runner was still installed as a
 * service, and the old code then deleted the directory ANYWAY on its way out.
 * 3 removed, 21 failed, and 18 services left running with their
 * WorkingDirectory deleted underneath them — 7 of them still `online`, so
 * GitHub could hand them a job that had nowhere to run.
 *
 * TWO RULES COME OUT OF THAT, and both are load-bearing:
 *
 *   1. Ask which manager owns it. A system unit is stopped through `svc.sh`,
 *      which is the only thing that knows how to uninstall what it installed.
 *   2. **NEVER delete the directory when deregistration fails.** That single
 *      `rm -rf` is what turned a retryable failure into an unrecoverable one:
 *      with the directory intact the next run simply tries again, and without
 *      it the only remedy left is the REST API and an operator.
 */
export function removeScript({
	repo,
	token,
	guest = false,
	runnerId = null,
	deregistered = false,
}) {
	const suffix = repoSuffix(repo);
	// THE INSTALL IS FOUND BY THE REGISTRATION IT HOLDS (#123), not only by the
	// repo's CURRENT name. A rename leaves the install under the OLD name:
	// WolffM/hadoku-printTool became hadoku-craft, and hokon's install stayed at
	// actions-runner-hadoku-printtool with a .runner naming the old URL, while
	// GitHub listed the registration under hadoku-craft. Deriving the dir from
	// the current name found nothing and reported NOT_OURS. agentId in .runner
	// is the registration id and survives a rename, so it is the key.
	const id = Number.isInteger(runnerId) ? String(runnerId) : '';
	// deregistered: the controller already deleted the registration through
	// the REST API (the fallback for a config.sh remove that a rename turns into
	// a 404 — the runner API does not follow the redirect). Only the local
	// install is left to remove, so config.sh remove is skipped.
	const deregister = deregistered
		? 'echo "registration already deleted by id through the API; removing the install only"'
		: [
				'# NOT || true. Deregistering is the half that matters: a registration left',
				'# behind is a runner GitHub will SCHEDULE ONTO with nothing listening. On',
				'# 2026-08-29 this swallowed ten consecutive failures on claw-3 and reported',
				'# every one as removed, so the next reconciler run was the only thing that',
				'# noticed.',
				'if ! ./config.sh remove --token "' + token + '"; then',
				'  # THE DIRECTORY STAYS. See the removeScript header: deleting it here is what',
				'  # made the claw-1 failures unrecoverable. Intact, the next run retries; deleted,',
				'  # only the REST API can finish the job.',
				'  echo "DEREGISTER_FAILED: the GitHub registration remains; $DIR was left intact so a retry can work" >&2',
				'  exit 6',
				'fi',
			].join('\n');
	// A GUEST IS NEVER ASKED FOR SUDO (operator, 2026-09-14) — not even the
	// non-prompting kind. INCLUDE_GUESTS keeps the guest's backstop registrations
	// in scope, so a retired repo's registration there IS a removal target, and a
	// system-installed one would have reached for passwordless root on the
	// production host. On a guest the system path stops at NEEDS_ROOT and hands
	// the operator the command, which is what it already does on a claw with no
	// passwordless sudo; the user-unit path needs no root and is unchanged.
	const rootStep = guest
		? '  echo "NEEDS_ROOT: $SYS_UNIT is a system service on a GUEST; the fleet never asks a guest for sudo (DIR=$DIR)" >&2\n' +
			'  exit 5'
		: '  if ! sudo -n true 2>/dev/null; then\n' +
			'    echo "NEEDS_ROOT: $SYS_UNIT is a system service and passwordless sudo is unavailable (DIR=$DIR)" >&2\n' +
			'    exit 5\n' +
			'  fi\n' +
			'  ( cd "$DIR" && sudo -n ./svc.sh stop && sudo -n ./svc.sh uninstall ) >/dev/null 2>&1 || {\n' +
			'    echo "NEEDS_ROOT: svc.sh could not stop/uninstall $SYS_UNIT (DIR=$DIR)" >&2\n' +
			'    exit 5\n' +
			'  }';
	// owner-repo, original case: WolffM/hadoku-printTool installs as
	// actions.runner.WolffM-hadoku-printTool.claw-1.service. The runner name is
	// the trailing field, so it is globbed rather than guessed — a node whose
	// runner name is not its hostname is still found.
	//
	// Concatenation, NOT a template literal, and NO BACKTICKS ANYWHERE IN THIS
	// FUNCTION outside the returned script. The backtick guard below reads
	// everything between the first and last backtick of this function body, so a
	// second literal — or a backtick in a comment like this one used to have —
	// puts unescaped backticks inside the region it scans and blinds it. That
	// guard has caught a truncated script in this file twice. Keeping it sharp is
	// worth the plainer prose.
	const sysGlob = 'actions.runner.' + repo.replace('/', '-') + '.*.service';
	return `
set -uo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
# ~/runners/ since 2026-10-09; a runner not yet moved is still found where it was.
DIR="$HOME/runners/actions-runner-${suffix}"
[ -d "$DIR" ] || DIR="$HOME/actions-runner-${suffix}"
# Not under the current name: look for the install holding this registration.
RUNNER_ID="${id}"
if [ ! -d "$DIR" ] && [ -n "$RUNNER_ID" ]; then
  for f in "$HOME"/runners/*/.runner "$HOME"/actions-runner-*/.runner; do
    [ -f "$f" ] || continue
    if tr -d ' \t\r\n' < "$f" | grep -q '"agentId":'"$RUNNER_ID"'[,}]'; then
      DIR=$(dirname "$f")
      echo "found registration $RUNNER_ID at $DIR (not under the repo's current name)"
      break
    fi
  done
fi
# The unit is named after the directory it runs, so a renamed install's unit
# carries the old name too.
USER_UNIT="$(basename "$DIR").service"

if [ ! -d "$DIR" ]; then
  echo "NOT_OURS: no install of this registration in $HOME (no actions-runner-${suffix}, no .runner with agentId \${RUNNER_ID:-?})" >&2
  exit 4
fi

# Which manager actually holds it. --all so a loaded-but-inactive unit still
# counts: it is installed either way, and svc.sh is what removes the install.
SYS_UNIT=$(systemctl list-units --all --no-legend "${sysGlob}" 2>/dev/null | awk '{print $1}' | head -1)
OWNER="none"

if [ -n "$SYS_UNIT" ]; then
  if [ ! -x "$DIR/svc.sh" ]; then
    echo "NEEDS_ROOT: $SYS_UNIT is a system service but $DIR/svc.sh is missing (DIR=$DIR)" >&2
    exit 5
  fi
  # -n: never prompt. An interactive sudo would hang this ssh forever, and the
  # reconciler runs unattended on a cron. On a guest there is no sudo at all.
${rootStep}
  OWNER="system:$SYS_UNIT"
elif systemctl --user cat "$USER_UNIT" >/dev/null 2>&1; then
  systemctl --user disable --now "$USER_UNIT" >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/$USER_UNIT"
  systemctl --user daemon-reload || true
  OWNER="user:$USER_UNIT"
fi

cd "$DIR"
# THE BREADCRUMB, written BEFORE the deregistration that deletes .runner.
#
# Removal is not atomic and cannot be made so: it deregisters over the network,
# then deletes the tree. Interrupted between those two - a dropped ssh, a
# timeout on the slowest call in the script - it leaves a directory with the
# 678MB package intact, no .runner, no unit and no GitHub registration.
#
# That state was UNATTRIBUTABLE and therefore permanent. Every tool that could
# have found it keys on the record the deregistration just deleted: the
# reconciler sees no registration to remove, nothing can tell which repo the
# directory belonged to, and clean-runner-debris only sweeps _update/_diag/stale
# version dirs - it reported "stale 0.00 GB" on claw-1 while 3.1 GB of these sat
# beside it (printtool, oss-issue-aggregator, vibedispatch, all three long gone
# from the roster).
#
# This file is what survives that window and names the repo, so the sweep can
# finish the job. It is deliberately NOT removed on the failure path: a failed
# deregister leaves .runner in place too, and .removing beside a live .runner
# means "a retry is owed", which is exactly what the next run does.
printf 'repo=%s\nstarted=%s\n' "${repo}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/.removing" 2>/dev/null || true
${deregister}
cd "$HOME"
rm -rf "$DIR"
# The unit's drop-in dir goes with it (#126). runners-slice-install.sh writes
# 10-runners-slice.conf there (hokon's also held a supervision.conf), and
# removing only the unit file left 28 orphan dirs on hokon on 2026-10-19
# for the toolchain check to hand to an operator. Unconditional on OWNER: a
# unit removed by an earlier, interrupted run leaves its drop-ins just the same.
rm -rf "$HOME/.config/systemd/user/$USER_UNIT.d"
echo "removed $DIR ($OWNER)"
`;
}
