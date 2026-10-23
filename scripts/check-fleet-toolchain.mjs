#!/usr/bin/env node
/**
 * check-fleet-toolchain — is every node able to BUILD the same things?
 *
 * Runner registration has been declarative for a while; what a node can
 * actually build was not. That gap does not fail loudly — it fails as a job that
 * passes on claw-3 and fails on claw-1, which reads as a flaky test and gets
 * re-run rather than fixed. On 2026-08-25 exactly that: claw-1 and claw-2 had no
 * python3-venv, claw-3 did, and nine repos' Python CI was a coin flip on runner
 * assignment for as long as anyone had been re-running it.
 *
 * So the toolchain is declared in fleet-runner-manifest.json alongside placement
 * and capacity, and this reports drift against it.
 *
 * WHY IT ONLY REPORTS BY DEFAULT
 * ------------------------------
 * Read-only. The tool cache is SEEDED by seed-runner-python.mjs and copied
 * between nodes by the commands this prints; nothing here installs anything.
 * Exit 1 on drift, so a cron can page on it.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	isLocalNode,
	loadManifest,
	machineArg,
	runOnSync,
	selectNodes,
} from './lib/fleet-exec.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { createEmitter } from './lib/emit.mjs';
import { applicableRepairs, isVersionManaged, minAgeOf } from './lib/toolchain-floor.mjs';
import { assess, createReleaseLookup, parseInstalledVersion } from './lib/tool-release.mjs';
import { isGuestNode } from '../dist/lib/node-role.js';

/**
 * WHICH harvester file is judged is read from the RUNNING service, never a
 * constant (#114). This was `~/.local/bin/runner-mem-harvest.py`, the 2026-08
 * hand-install; the throttle payload moved every node to
 * `~/.hadoku/runner-mem-harvest.py` (hokon on 2026-10-11) and removed the old
 * copy, so the doctor hashed a file that no longer existed and reported drift
 * on a harvester that was running fine. The unit's `ExecStart` would be the
 * deployer's own record; the process's argv is what the kernel is executing.
 */
const HARVESTER_UNIT = 'runner-mem-harvest.service';
const HARVESTER_PKG_PATH = new URL('runner-mem-harvest.py', import.meta.url);
/**
 * The ABSOLUTE local path to this package's own `runner-mem-harvest.py`,
 * resolved from wherever THIS module was loaded from. When this doctor runs
 * in-process inside mgmt-api on hokon (the guest it is reporting on), that is
 * already the production path — no assumption about mgmt-api's install
 * layout is baked in here; `import.meta.url` IS that layout. See
 * "verify in the consumer's environment".
 */
const HARVESTER_PKG_LOCAL_PATH = fileURLToPath(HARVESTER_PKG_PATH);

/**
 * `_work` ADVISORY THRESHOLDS (#79 hygiene, re-scaled #126).
 *
 * The finding that motivated this is ~3.2 GB across the `_work` dirs under
 * `~/actions-runner-*` on a root disk at 75% on hokon. Neither number alone
 * is a problem: a few hundred MB of fresh job artifacts is normal churn on
 * any runner, and 3.2 GB is irrelevant on a disk with room to spare. It is a
 * finding only against the disk pressure that makes it one, so both must
 * hold before this advisory fires.
 *
 * THE PRESSURE IS FREE SPACE, NOT A PERCENTAGE (#126). The first version
 * gated on `/` being 70%+ used, and on hokon's 1.8 TB volume that is 387 GB
 * free: the advisory fired, the operator cleared 1.2 GB, and the disk moved
 * 0%. An advisory whose fix cannot change the condition it reports is noise.
 * So `_work` must be at least WORK_ADVISORY_FREE_SHARE of what is free —
 * clearing it would grow free space by a tenth or more — which fires on a
 * small disk running out and never on a large one with room to spare.
 */
export const WORK_ADVISORY_MIN_MB = 1024;
export const WORK_ADVISORY_FREE_SHARE = 0.1;

/**
 * WHICH `*.service.d` NAMES ARE THIS FLEET'S TO ADVISE ON (#79, manager
 * correction 2026-10-03, re-corrected 2026-10-03: no node name baked in).
 *
 * The drop-in scan is generic (any `*.service.d` with no matching unit), but
 * a guest is not a box this package owns outright — it also carries the
 * operator's own desktop session (an `app-…@.service.d` template unit, say).
 * Those `@`-template units commonly have no persistent unit FILE at all (the
 * session instantiates them), so "no unit" there is normal, not drift, and
 * recommending `rm -r` on someone's desktop config is not this doctor's
 * business. `actions-runner-` is the live runner naming everywhere (every
 * `actions-runner-*.service.d` on a real guest has a matching unit); a guest
 * may ALSO carry a legacy PER-NODE naming from before that scheme —
 * `<node>-runner-b/c/d`, verified on hokon: `hokon-runner-b.service.d` exists
 * with `systemctl --user list-unit-files 'hokon-runner*'` finding nothing.
 *
 * The node name is NOT hardcoded here — `lib/ecosystem-literals.test.mjs`
 * gates exactly that (a hostname baked into a published library), and
 * correctly failed when it first was: `hokon-runner-` as a literal moved
 * `hokon`'s count from 39 to 40. It is derived from the node `buildBackstop`
 * is actually being called FOR, which is already known at every call site.
 */
export function fleetDropinPattern(nodeName) {
	const node = typeof nodeName === 'string' ? nodeName : '';
	const escaped = node.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`^(actions-runner-${escaped ? `|${escaped}-runner-` : ''})`);
}

/**
 * HOW FAR BEHIND THE DEBOUNCE A NODE MAY BE BEFORE IT IS A FINDING: 3 days.
 *
 * The cadence (lane B) runs nightly. A release is a candidate once it has been
 * public for `minAge` (7 days), so a healthy node is on it within about a day of
 * it clearing. The tolerance is the slack on top of that: long enough that a
 * busy node which skipped a night, or one night's failed run, is never paged
 * (3 nights would have to be missed), short enough that a cadence that has
 * actually stopped is a finding within days of the release that exposes it,
 * rather than at the next time someone notices.
 *
 * It is applied to the LOOKUP, not to the comparison: upstream is asked for the
 * newest release that cleared `minAge + tolerance` ago — "what the cadence
 * should ALREADY have installed". Comparing against the newest cleared release
 * instead would make this gate easier to pass the faster a tool ships: claude
 * releases every day or two, so the newest cleared version is always a day old
 * and a node stuck for a month would never read as behind it.
 */
export const TOLERANCE_MINUTES = 3 * 24 * 60;

/**
 * Run a shell snippet on a node. The local host is executed directly: mgmt-api
 * runs on hokon and hokon refuses ssh to itself, which is the same trap that made
 * the fast loop read hokon as permanently saturated for weeks.
 */
function onNode(node, script, { timeoutMs = 300_000 } = {}) {
	return runOnSync(node, script, { timeoutMs, connectTimeout: 8 });
}

/** Single-quote a string for the shell. */
const shq = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

/**
 * The shell every tool check runs under: NON-LOGIN, NO rc files.
 *
 * `bash -s` over ssh inherits whatever PATH the session built, and a login shell
 * adds ~/.local/bin and ~/.cargo/bin on top. A workflow `run:` step gets neither.
 * claw-8 (2026-09-30) answered `bash -lc` with a path and this with NOT-ON-PATH,
 * and only the second is what CI sees. So each detect and version command is run
 * in its OWN `bash --noprofile --norc -c`, never inline in the probe shell.
 */
export const NON_LOGIN = 'bash --noprofile --norc -c';

/**
 * THE PATH A RUNNER JOB ACTUALLY GETS (#127), which is neither of the shells above.
 *
 * Every runner on a node inherits its environment from a process systemd
 * started: the user manager for a JIT mint, a warm listener (`systemd-run
 * --user`) and a reconciler user unit (`ExecStart=run.sh`, which never reads
 * `.path`); `runsvc.sh` exports `.path` for a system unit. None of that is the
 * PATH an ssh session builds. On hokon `gh` lives in ~/.local/bin, and
 * hadoku_site's runner there went without it for three days (2026-10-13→15,
 * `spawnSync gh ENOENT` ×5) while a non-login shell over ssh found it fine;
 * whether a runner sees ~/.local/bin depends on whether a login session had
 * imported its PATH into the user manager before the unit last started.
 *
 * So the PATH is READ from the processes that hold it, never derived: the user
 * manager's (what the next mint or restart inherits) and each live
 * Runner.Listener's own environ (what a job on it gets now — a PATH line in its
 * `.env` wins, because the listener loads that file after it starts). One
 * `RUNNERPATH <label> <PATH>` line per distinct PATH. NONE at all means "could
 * not look", and `judgeTool` fails every tool on it.
 */
const RUNNER_PATHS_SCRIPT = `__rp=''
__add() { case "
$__rp
" in *"	$2
"*) return ;; esac; __rp="$__rp
$1	$2"; }
__m=$(systemctl --user show-environment 2>/dev/null | sed -n 's/^PATH=//p')
[ -n "$__m" ] && __add manager "$__m"
for __p in $(pgrep -x Runner.Listener 2>/dev/null); do
  __d=$(tr '\\0' '\\n' < "/proc/$__p/cmdline" 2>/dev/null | grep -m1 '/bin/Runner.Listener$')
  __d=\${__d%/bin/Runner.Listener}
  __l=$(sed -n 's/^PATH=//p' "$__d/.env" 2>/dev/null | tail -n1)
  [ -n "$__l" ] || __l=$(tr '\\0' '\\n' < "/proc/$__p/environ" 2>/dev/null | sed -n 's/^PATH=//p')
  [ -n "$__l" ] && __add "listener:\${__d#"$HOME"/}" "$__l"
done
__rp=\${__rp#?}
__bash=$(command -v bash)
printf '%s\\n' "$__rp" | while IFS='	' read -r __a __b; do [ -n "$__b" ] && printf 'RUNNERPATH\\t%s\\t%s\\n' "$__a" "$__b"; done
# __runner_miss DETECT — the runner PATHs under which DETECT does not print OK,
# as "label=PATH; …"; \`?\` when there is no runner PATH to try at all.
__runner_miss() {
  [ -n "$__rp" ] || { printf '?'; return; }
  printf '%s\\n' "$__rp" | while IFS='	' read -r __a __b; do
    [ -n "$__b" ] || continue
    [ "$(env -i HOME="$HOME" PATH="$__b" "$__bash" --noprofile --norc -c "$1" 2>/dev/null | head -n1)" = OK ] || printf '%s=%s; ' "$__a" "$__b"
  done
}`;

/**
 * The per-tool lines for one node. `tools` is `applicableRepairs(node)`.
 *
 *   TOOL <id> detect <OK|...>     detect, run non-login
 *   TOOL <id> login  <OK|...>     the SAME detect under a login shell. DIAGNOSIS
 *                                 ONLY, consulted when detect failed: it separates
 *                                 "not installed" from "installed but only a login
 *                                 shell can see it". It is never a pass.
 *   TOOL <id> loginversion <text> the version command under the login shell, so a
 *                                 present-but-unreachable binary still has a readable
 *                                 version (the cycle must never downgrade it).
 *   TOOL <id> version <text>      first line of the version command, non-login
 *   TOOL <id> runner <misses>     the runner PATHs (above) detect FAILS under, as
 *                                 `label=PATH; …`; empty when it passes under all
 *                                 of them, `?` when none could be read.
 */
export function toolProbeScript(tools) {
	if (!tools.length) return '';
	const perTool = tools
		.flatMap(([id, t]) => {
			const lines = [
				`printf 'TOOL\\t%s\\tdetect\\t%s\\n' ${shq(id)} "$(${NON_LOGIN} ${shq(t.detect)} 2>/dev/null | head -n1 | tr -d '\\t')"`,
				`printf 'TOOL\\t%s\\tlogin\\t%s\\n' ${shq(id)} "$(bash -lc ${shq(t.detect)} 2>/dev/null | head -n1 | tr -d '\\t')"`,
				`printf 'TOOL\\t%s\\trunner\\t%s\\n' ${shq(id)} "$(__runner_miss ${shq(t.detect)} | tr -d '\\t')"`,
			];
			if (t.apt) {
				// installed|candidate|behind-or-current, decided by dpkg ON the node.
				const q = `i=$(dpkg-query -W -f='\${Version}' ${t.apt} 2>/dev/null); c=$(apt-cache policy ${t.apt} 2>/dev/null | awk '/Candidate:/{print $2}'); s=unknown; if [ -n "$i" ] && [ -n "$c" ] && [ "$c" != "(none)" ]; then if dpkg --compare-versions "$i" lt "$c"; then s=behind; else s=current; fi; fi; echo "$i|$c|$s"`;
				lines.push(
					`printf 'TOOL\\t%s\\tapt\\t%s\\n' ${shq(id)} "$(${NON_LOGIN} ${shq(q)} 2>/dev/null | head -n1 | tr -d '\\t')"`
				);
			}
			if (isVersionManaged(t)) {
				lines.push(
					`printf 'TOOL\\t%s\\tversion\\t%s\\n' ${shq(id)} "$(${NON_LOGIN} ${shq(t.version)} 2>/dev/null | head -n1 | tr -d '\\t')"`
				);
				lines.push(
					`printf 'TOOL\\t%s\\tloginversion\\t%s\\n' ${shq(id)} "$(bash -lc ${shq(t.version)} 2>/dev/null | head -n1 | tr -d '\\t')"`
				);
			}
			return lines;
		})
		.join('\n');
	return `${RUNNER_PATHS_SCRIPT}\n${perTool}`;
}

/** `{ [id]: { detect, login, runner, version, loginversion } }` from the TOOL lines of a probe. */
export function parseToolProbe(out) {
	const seen = {};
	for (const line of String(out).split('\n')) {
		const [kind, id, field, ...rest] = line.split('\t');
		if (kind !== 'TOOL' || !id || !field) continue;
		(seen[id] ??= {})[field] = rest.join('\t').trim();
	}
	return seen;
}

/** An apt-tracked tool from the probe's `installed|candidate|state` line. */
function judgeApt(id, line) {
	const [inst, cand, state] = String(line ?? '').split('|');
	const plain = (v) => (v ? v.replace(/^\d+:/, '') : null);
	if (state === 'behind') {
		return {
			id,
			status: 'behind',
			// ADVISORY — see `aptRepair` in toolchain-floor.mjs: the cycle acts on
			// it; the gate does not page on a release it cannot debounce.
			finding: false,
			installed: plain(inst),
			target: plain(cand),
			reason: `apt has ${cand}; ${inst} is installed`,
		};
	}
	if (state === 'current') return { id, status: 'ok', finding: false, installed: plain(inst) };
	return {
		id,
		status: 'unknown',
		finding: true,
		reason: `apt could not say what is installed or available (${line || 'no answer'})`,
	};
}

/**
 * Judge ONE tool on ONE node. Pure.
 *
 * `status` is one of:
 *   ok       present (and, when version-managed, current or ahead)
 *   ahead    newer than the debounce allows us to install — never a finding
 *   absent   detect did not pass under a non-login shell, or passed there but
 *            not under a PATH a runner job gets (`runnerPathOnly`) — a finding
 *   behind   older than the release that cleared minAge + tolerance — a finding
 *   unknown  version unreadable or upstream unreachable — a finding, with `reason`
 *
 * `latest` is a lookup result taken at `minAge + tolerance`; it is ignored for a
 * presence-only tool. "I could not look" is `unknown`, which FAILS.
 */
export function judgeTool(id, tool, seen, latest) {
	const s = seen ?? {};
	if (s.detect !== 'OK') {
		const why =
			s.login === 'OK'
				? 'installed, but reachable only from a login shell — a workflow step sees a stock PATH'
				: 'not installed, or not reachable from a non-login shell';
		const loginOnly = s.login === 'OK';
		return {
			id,
			status: 'absent',
			finding: true,
			reason: why,
			// Present but unreachable: a REACHABILITY fault, not a missing install. The
			// login-shell version is the only one readable; null = unknown.
			...(loginOnly
				? { loginOnly: true, installed: parseInstalledVersion(s.loginversion) ?? null }
				: {}),
		};
	}
	// Reachable from a non-login shell over ssh is still not reachable from a JOB
	// (#127): the runner's PATH is read from the processes that hold it.
	if (s.runner === undefined || s.runner === '?') {
		return {
			id,
			status: 'unknown',
			finding: true,
			reason:
				'could not read the PATH runner jobs get (no systemd --user manager environment ' +
				'and no live Runner.Listener), so whether a job can reach it is unknown',
		};
	}
	if (s.runner !== '') {
		return {
			id,
			status: 'absent',
			finding: true,
			runnerPathOnly: true,
			installed: parseInstalledVersion(s.version) ?? null,
			reason: `installed, but not on the PATH runner jobs get — ${s.runner.replace(/;\s*$/, '')}`,
		};
	}
	if (tool?.apt) return judgeApt(id, s.apt);
	if (!isVersionManaged(tool)) return { id, status: 'ok', finding: false };
	const installed = parseInstalledVersion(s.version);
	const a = assess(installed, latest);
	if (a.status === 'unknown') {
		return { id, status: 'unknown', finding: true, installed, reason: a.reason };
	}
	if (a.status === 'behind') {
		return {
			id,
			status: 'behind',
			finding: true,
			installed: a.installed,
			target: a.target,
			reason: `${a.installed} is behind ${a.target}, which cleared the ${minAgeOf(tool)}-minute debounce more than ${TOLERANCE_MINUTES} minutes ago`,
		};
	}
	return {
		id,
		status: a.status === 'ahead' ? 'ahead' : 'ok',
		finding: false,
		installed: a.installed,
		target: a.target,
	};
}

/**
 * Judge every tool that applies to a node. `tools` is `applicableRepairs(node)`,
 * which is where `when` and the guest rule are honoured — a tool that does not
 * apply is not in the list, so it is neither probed nor a finding.
 */
export function judgeNode(tools, seen, latestById) {
	return tools.map(([id, t]) => judgeTool(id, t, seen[id], latestById[id]));
}

/**
 * ADVISORY-ONLY readiness facts for a GUEST — never requested for a claw.
 *
 * Every line here READS the kernel or the filesystem; nothing here installs,
 * starts, stops or writes anything, so it carries none of `check-capabilities`'
 * mutation risk. It answers "could the backstop actually take load", not "is
 * the backstop converged" — the fleet still never repairs a guest.
 *
 *   bk-avail-kb      /proc/meminfo MemAvailable — what ci-throttle's floor
 *                    (the node's declared `minFreeMb`) is actually compared
 *                    against.
 *   bk-tophold       the single largest resident process, by RSS — whatever is
 *                    actually holding memory today, not a name hardcoded here.
 *   bk-unitmax       one line per `actions-runner-*` / `actions.runner.*` unit:
 *                    the KERNEL's own `memory.max` for that unit's cgroup, read
 *                    the same way `deploy-runners-slice.mjs` reads it for a claw
 *                    — "the reader for a facet may not read what the writer
 *                    wrote" applies here too: the manifest's declared
 *                    `slice.unitMaxMb` is not asked.
 *   bk-harvest-path  the script the RUNNING harvester executes, from its main
 *                    PID's argv; empty when the service is not running.
 *   bk-harvest-bytes the byte count of that file, or `-1` if absent.
 *                    Compared locally against this package's own copy.
 *   bk-harvest-sha   sha256 of that same file, or empty if absent/unreadable.
 *                    A byte count can coincide (#79) — this is the content
 *                    comparison the drift verdict actually uses.
 *   bk-dropin        one line per `*.service.d` drop-in directory under
 *                    `~/.config/systemd/user/`, with `present`/`orphan`
 *                    depending on whether `systemctl --user list-unit-files`
 *                    knows the unit it is a drop-in FOR. Read-only: no
 *                    `status`, just a listing.
 *   bk-work-kb       total `du -sk` across every `_work` dir under
 *                    `~/actions-runner-*`, summed here rather than left as
 *                    several numbers a consumer would have to add up itself.
 *   bk-root-free-kb  `df`'s available KB on `/`, the free space the `_work`
 *                    total above is judged against.
 */
function backstopProbeScript() {
	return `
printf 'bk-avail-kb\\t%s\\n' "$(awk '/MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null)"
printf 'bk-tophold\\t%s\\n' "$(ps -eo rss,comm --no-headers 2>/dev/null | sort -rn | head -n1 | awk '{rss=$1; $1=""; sub(/^ /,""); printf "%d\\t%s", int(rss/1024), $0}')"
for u in $(systemctl --user list-units 'actions-runner-*' --all --no-legend --plain 2>/dev/null | awk '{print $1}'); do
  cg=$(systemctl --user show "$u" -p ControlGroup --value 2>/dev/null)
  mx=$(cat "/sys/fs/cgroup\${cg}/memory.max" 2>/dev/null)
  printf 'bk-unitmax\\t%s\\t%s\\n' "$u" "$mx"
done
for u in $(systemctl list-units 'actions.runner.*' --all --no-legend --plain 2>/dev/null | awk '{print $1}'); do
  cg=$(systemctl show "$u" -p ControlGroup --value 2>/dev/null)
  mx=$(cat "/sys/fs/cgroup\${cg}/memory.max" 2>/dev/null)
  printf 'bk-unitmax\\t%s\\t%s\\n' "$u" "$mx"
done
hpid=$(systemctl --user show ${HARVESTER_UNIT} -p MainPID --value 2>/dev/null)
hpath=''
[ -n "$hpid" ] && [ "$hpid" != 0 ] && hpath=$(tr '\\0' '\\n' < "/proc/$hpid/cmdline" 2>/dev/null | grep -m1 'runner-mem-harvest\\.py$')
printf 'bk-harvest-path\\t%s\\n' "$hpath"
printf 'bk-harvest-bytes\\t%s\\n' "$([ -n "$hpath" ] && wc -c < "$hpath" 2>/dev/null || echo -1)"
printf 'bk-harvest-sha\\t%s\\n' "$([ -n "$hpath" ] && sha256sum "$hpath" 2>/dev/null | awk '{print $1}')"
for d in "$HOME"/.config/systemd/user/*.service.d; do
  [ -d "$d" ] || continue
  u=$(basename "$d"); u=\${u%.d}
  listed=$(systemctl --user list-unit-files "$u" --no-legend --plain 2>/dev/null)
  printf 'bk-dropin\\t%s\\t%s\\n' "$d" "$([ -n "$listed" ] && echo present || echo orphan)"
done
work_kb=0
for d in "$HOME"/runners/actions-runner-*/_work "$HOME"/actions-runner-*/_work; do
  [ -d "$d" ] || continue
  k=$(du -sk "$d" 2>/dev/null | awk '{print $1}')
  work_kb=$((work_kb + \${k:-0}))
done
printf 'bk-work-kb\\t%s\\n' "$work_kb"
printf 'bk-root-free-kb\\t%s\\n' "$(df -Pk / 2>/dev/null | awk 'NR==2{print $4}')"
`;
}

/**
 * One probe per node, emitting parseable lines. Deliberately tests
 * `ensurepip` rather than `import venv`: on Debian `venv` is stdlib and imports
 * fine on a box that cannot actually build one, because the bootstrap lives in
 * the separate python3-venv package. Testing the wrong one reports a healthy
 * node that then fails two lines into the job.
 */
function probeScript(toolCache, tools = [], { backstop = false } = {}) {
	const cacheChecks = Object.entries(toolCache)
		.filter(([k]) => !k.startsWith('$'))
		.flatMap(([lang, versions]) =>
			versions.map(
				(v) =>
					// RUN the interpreter; do not test that a path exists.
					//
					// The tool-cache entries are SYMLINKS into a uv-managed store in
					// $HOME, so the directory can be present and correctly named while
					// the interpreter behind it is absent — which is precisely what
					// happened on hokon on 2026-08-25 when the tree was copied from a
					// claw without the store behind it. A path check reports that as
					// healthy; setup-python then finds the version and the job dies.
					//
					// (An earlier draft of this line used `ls ... | head -1 >/dev/null`,
					// which reports HEAD's exit status — always 0 — and so could never
					// report a miss at all.)
					//
					// THE VERSION IS MATCHED EXACTLY OR AS A PREFIX ENDING AT A DOT (#98).
					// `${v}*` let a declared `3.1` be satisfied by an installed `3.11.9`
					// — a different interpreter that setup-python would never pick for
					// `python-version: 3.1`.
					`printf 'cache\\t%s/%s\\t%s\\n' "${lang}" "${v}" "$(d=$(ls -d /opt/hostedtoolcache/${lang}/${v} /opt/hostedtoolcache/${lang}/${v}.* 2>/dev/null | head -1); [ -n "$d" ] && "$d/x64/bin/python3" -V >/dev/null 2>&1 && echo yes || echo no)"`
			)
		)
		.join('\n');
	return `
. /etc/os-release 2>/dev/null || true
printf 'os\\t%s\\n' "\${PRETTY_NAME:-unknown}"
printf 'python\\t%s\\n' "$(python3 -V 2>&1 | awk '{print $2}')"
printf 'ensurepip\\t%s\\n' "$(python3 -c 'import ensurepip' 2>/dev/null && echo yes || echo no)"
printf 'toolcache_writable\\t%s\\n' "$([ -w /opt/hostedtoolcache ] && echo yes || echo no)"
# WHICH pnpm answers, and whether it agrees with the store on disk.
#
# A globally npm-installed pnpm shadows corepack's shim, and the two disagree
# about the store: pnpm 10 uses store/v10, pnpm 11 uses store/v11. Found
# 2026-08-27 with /usr/bin/pnpm pointing at an npm-global pnpm 10 from March on
# all three claws, while every install ran pnpm 11.5.0 through corepack. The
# store doctor trusted the reported store path, looked in v10, found nothing and
# exited 0 -- a silent no-op on the repair path for the fleet's most
# corruption-prone workflow. Fixed with corepack enable; this stops it drifting
# back.
#
# NO BACKTICKS in this comment. It sits inside a JS template literal and a
# backtick ends the string -- the trap ci-throttle-install.sh records, hit again
# while writing this.
printf 'pnpm\\t%s\\n' "$(pnpm --version 2>/dev/null)"
printf 'pnpm_bin\\t%s\\n' "$(readlink -f "$(command -v pnpm 2>/dev/null)" 2>/dev/null)"
printf 'pnpm_store_agrees\\t%s\\n' "$(sp=$(pnpm store path 2>/dev/null | tail -1); [ -n "$sp" ] && [ -d "$sp" ] && echo yes || echo no)"
${cacheChecks}
${toolProbeScript(tools)}
${backstop ? backstopProbeScript() : ''}
`;
}

function parseProbe(out) {
	const facts = { cache: {}, unitMax: [], dropins: [] };
	for (const line of out.split('\n')) {
		const [kind, a, b] = line.split('\t');
		if (kind === 'os') facts.os = a;
		else if (kind === 'python') facts.python = a;
		else if (kind === 'ensurepip') facts.ensurepip = a === 'yes';
		else if (kind === 'toolcache_writable') facts.toolCacheWritable = a === 'yes';
		else if (kind === 'pnpm') facts.pnpm = a;
		else if (kind === 'pnpm_bin') facts.pnpmBin = a;
		else if (kind === 'pnpm_store_agrees') facts.pnpmStoreAgrees = a === 'yes';
		else if (kind === 'cache') facts.cache[a] = b === 'yes';
		else if (kind === 'bk-avail-kb') facts.bkAvailKb = Number(a) || null;
		else if (kind === 'bk-tophold') facts.bkTopHold = { rssMb: Number(a) || 0, cmd: b ?? '' };
		else if (kind === 'bk-unitmax') facts.unitMax.push({ unit: a, max: b });
		else if (kind === 'bk-harvest-path') facts.bkHarvestPath = a || null;
		else if (kind === 'bk-harvest-bytes') facts.bkHarvestBytes = Number(a);
		else if (kind === 'bk-harvest-sha') facts.bkHarvestSha = a || null;
		else if (kind === 'bk-dropin') facts.dropins.push({ dir: a, status: b });
		else if (kind === 'bk-work-kb') facts.bkWorkKb = Number(a) || 0;
		else if (kind === 'bk-root-free-kb')
			facts.bkRootFreeKb =
				a !== undefined && a !== '' && Number.isFinite(Number(a)) ? Number(a) : null;
	}
	return facts;
}

/**
 * The advisory backstop-readiness report for ONE guest, from facts the probe
 * above already gathered. Pure, so it is testable against a fixture without a
 * node.
 *
 * NEVER FEEDS `drift`. This answers "could the backstop take load right now",
 * which is a fact about the FLEET's exposure, not about whether the guest
 * itself needs repair — the fleet never repairs it. A consumer (the mgmt-api
 * digest) must not page on anything in here; see `advisory: true`.
 *
 * `sliceMaxMb` is the node's OWN declared `slice.maxMb` (hokon: 16384) —
 * read from the manifest, not measured, because the claim being contrasted
 * is a RULE ("a claw's per-unit cap reaches its slice", issue #26), not a
 * second measurement of another box. Citing hokon's own slice ceiling next
 * to its own measured per-unit cap is in hand already (the manifest entry
 * this node was selected from); nothing is ssh'd for it.
 *
 * `advisories` (#79 hygiene) is the three drifts the big-four audit found
 * that nothing reported: the running harvester's CONTENT (not byte
 * count), orphan systemd drop-in dirs, and `_work` size against disk
 * pressure. Each entry is `{ id, blocking: false, message, fix }` — `fix` is
 * the exact one-line command the OPERATOR runs by hand; this doctor never
 * runs it, and `blocking: false` is asserted by every test below because
 * none of this may ever become an `@here` (operator, 2026-10-01).
 */
export function buildBackstop(
	facts,
	{
		minFreeMb,
		repoHarvestBytes,
		repoHarvestSha,
		sliceMaxMb,
		harvesterPkgPath = HARVESTER_PKG_LOCAL_PATH,
		nodeName,
	}
) {
	const unitMaxMbValues = [
		...new Set(
			(facts.unitMax ?? [])
				.map((u) => u.max)
				.filter((m) => m && m !== 'max')
				.map((m) => Math.round(Number(m) / 1048576))
				.filter((m) => Number.isFinite(m) && m > 0)
		),
	].sort((x, y) => x - y);
	const availableMb =
		typeof facts.bkAvailKb === 'number' ? Math.round(facts.bkAvailKb / 1024) : null;
	const floorMb = typeof minFreeMb === 'number' ? minFreeMb : null;
	const available = availableMb === null || floorMb === null ? null : availableMb >= floorMb;
	const harvesterBytes =
		typeof facts.bkHarvestBytes === 'number' && facts.bkHarvestBytes >= 0
			? facts.bkHarvestBytes
			: null;
	// CONTENT, not byte count — a byte count can coincide (#79's actual find:
	// the hand-installed copy lacks #47's jit-*/warm-* stems and #76's
	// clipped-window flag, and could do so at an unchanged length). Either
	// side's hash missing is "I could not look", which is drift, never a
	// silent match — this never reads `undefined === undefined` as agreement,
	// the same trap `provenanceDrift` documents for the claw-side deploy.
	const harvesterSha =
		typeof facts.bkHarvestSha === 'string' && facts.bkHarvestSha.length > 0
			? facts.bkHarvestSha
			: null;
	const repoSha =
		typeof repoHarvestSha === 'string' && repoHarvestSha.length > 0 ? repoHarvestSha : null;
	const harvesterDrift = harvesterSha === null || repoSha === null || harvesterSha !== repoSha;
	// Does the measured per-unit cap reach this node's OWN slice ceiling? A
	// claw's units are expected to (issue #26); a flat sub-slice cap here is
	// the mismatch this whole readiness block exists to say out loud — a job
	// that would have fit in the slice is OOM-killed at the smaller number.
	const sliceCeilingMb = typeof sliceMaxMb === 'number' ? sliceMaxMb : null;
	const unitCapReachesSlice =
		unitMaxMbValues.length !== 1 || sliceCeilingMb === null
			? null
			: unitMaxMbValues[0] >= sliceCeilingMb;

	// ADVISORY FINDINGS (#79 hygiene). Each fires independently, each carries
	// the exact command an operator runs by hand, and none is folded into
	// `drift` anywhere in this file — see the doc comment above.
	const advisories = [];
	const harvesterPath =
		typeof facts.bkHarvestPath === 'string' && facts.bkHarvestPath.length > 0
			? facts.bkHarvestPath
			: null;
	if (harvesterDrift) {
		// The script is read once at startup, so a reinstall without a restart
		// leaves the old code running and this advisory standing.
		const reinstall = (to) =>
			`install -m 755 ${harvesterPkgPath} ${to} && systemctl --user restart ${HARVESTER_UNIT}`;
		advisories.push({
			id: 'harvester-drift',
			blocking: false,
			message:
				harvesterPath === null
					? `${HARVESTER_UNIT} is not running — there is no harvester process (#47/#76) whose ` +
						`script could be compared, so no per-job memory is being sampled`
					: harvesterSha === null
						? `${harvesterPath}, the script the running harvester executes, is unreadable — ` +
							`its content could not be compared`
						: `${harvesterPath} (the running harvester) does not match this package's ` +
							`runner-mem-harvest.py by CONTENT (installed sha256 ${harvesterSha.slice(0, 12)}…, ` +
							`package ${repoSha === null ? 'unknown' : `${repoSha.slice(0, 12)}…`}) — a byte ` +
							`count can coincide; this is sha256`,
			fix:
				harvesterPath === null
					? `systemctl --user enable --now ${HARVESTER_UNIT}`
					: reinstall(harvesterPath),
		});
	}
	// FLEET-OWNED NAMES ONLY (manager correction, 2026-10-03). The generic scan
	// also catches `app-invokeai@.service.d` / `app-org.kde.dolphin@.service.d`
	// on hokon: those are the OPERATOR's desktop session's own template/
	// transient units, never shipped or managed by this package, and "no unit
	// file" is normal for a `@`-template drop-in — it is not an orphan by this
	// package's definition. Advising `rm -r` on the operator's own desktop
	// config is exactly the "this package has no business recommending that"
	// mistake. `hokon-runner-{b,c,d}` is a LEGACY runner name from before the
	// `actions-runner-<repo>` scheme (confirmed live: `systemctl --user
	// list-unit-files 'hokon-runner*'` finds nothing, while every
	// `actions-runner-*.service.d` on hokon DOES have a matching unit) — both
	// prefixes are the fleet's own naming, so both are in scope; nothing else
	// is.
	const orphanDirs = (facts.dropins ?? [])
		.filter((d) => d.status === 'orphan')
		.filter((d) => fleetDropinPattern(nodeName).test(basename(d.dir).replace(/\.d$/, '')))
		.map((d) => d.dir);
	if (orphanDirs.length) {
		advisories.push({
			id: 'orphan-dropins',
			blocking: false,
			message:
				`${orphanDirs.length} fleet-owned systemd user drop-in dir(s) have no matching unit ` +
				`(systemctl --user list-unit-files reports nothing for them): ${orphanDirs.join(', ')}`,
			fix: `rm -r ${orphanDirs.map(shq).join(' ')}`,
		});
	}
	const workMb = typeof facts.bkWorkKb === 'number' ? Math.round(facts.bkWorkKb / 1024) : 0;
	const freeKb = typeof facts.bkRootFreeKb === 'number' ? facts.bkRootFreeKb : null;
	if (
		workMb >= WORK_ADVISORY_MIN_MB &&
		freeKb !== null &&
		facts.bkWorkKb >= freeKb * WORK_ADVISORY_FREE_SHARE
	) {
		advisories.push({
			id: 'backstop-work-size',
			blocking: false,
			message:
				`~/runners/actions-runner-*/_work totals ~${workMb} MB on a root disk with ` +
				`${Math.round(freeKb / 1024)} MB free (advisory floor: ${WORK_ADVISORY_MIN_MB} MB and ` +
				`${WORK_ADVISORY_FREE_SHARE * 100}%+ of free space)`,
			// Runner.Worker, NOT Runner.Listener (manager correction, 2026-10-03):
			// the Listener is the long-lived poller and is running on every
			// registered runner whether idle or not — `ps -eo args` on hokon shows
			// it live for every cohort member. The Worker process exists only
			// while a job is actually executing, so it is the one signal that
			// means "a job is in progress" — gating the prune on Listener would
			// have pruned nothing, ever.
			fix:
				'for d in ~/runners/actions-runner-*; do pgrep -f "$d/bin/Runner.Worker" >/dev/null 2>&1 || ' +
				'rm -rf "$d"/_work/*; done',
		});
	}

	return {
		advisory: true,
		unitMaxMb: unitMaxMbValues,
		unitCount: (facts.unitMax ?? []).length,
		sliceMaxMb: sliceCeilingMb,
		unitCapReachesSlice,
		floorMb,
		availableMb,
		available,
		topHolder: facts.bkTopHold ?? null,
		harvesterPath,
		harvesterBytes,
		harvesterRepoBytes: repoHarvestBytes,
		harvesterSha,
		harvesterRepoSha: repoSha,
		harvesterDrift,
		advisories,
	};
}

/**
 * Whether a node's toolchain has drifted from what REPAIRS + the tool cache
 * declare. Pure and exported so "zero tools evaluated must never print
 * drift=false" is testable on its own, without constructing a fixture that
 * reaches it through `runDoctor` — every real caller today always carries at
 * least `rust` and `docker` (both unscoped), so the zero case is a defence
 * against a FUTURE regression in `applicableRepairs`, the same shape the
 * 2026-10-01 bug took: `tools: []` rendered as `drift: false`.
 */
export function computeDrift({
	missingCache,
	ensurepip,
	pnpmStoreAgrees,
	toolFindings,
	toolsEvaluated,
}) {
	return (
		missingCache.length > 0 ||
		ensurepip === false ||
		pnpmStoreAgrees === false ||
		toolFindings.length > 0 ||
		toolsEvaluated === 0
	);
}

/**
 * The measuring half: probe every selected node and judge it. No output, no
 * exit — `run`, `lookup`, `now` and `drains` are injectable so a test drives it
 * against fixtures instead of ssh and the npm registry.
 */
export async function runDoctor({
	manifest,
	only = null,
	includeGuests = false,
	run = onNode,
	lookup = createReleaseLookup(),
	drains = readDrains(),
}) {
	const tc = manifest.toolchain;
	if (!tc) throw new Error('fleet-runner-manifest.json has no `toolchain` section');
	const toolCache = tc.toolCache ?? {};

	// A GUEST IS NOT PROBED BY DEFAULT, AND THE SKIP IS REPORTED.
	//
	// "Can each node build what its neighbours can" is a question about CI
	// capacity. A guest builds nothing for the fleet — it lends a registration and
	// is otherwise none of the fleet chain's business (operator, 2026-09-14) — so
	// drift in its tool cache is not drift in the fleet's, and the remedy this
	// command prints (`tar | ssh <node>`) is a write onto a box the fleet may not
	// write to. `selectNodes` is the role-aware door; naming the node with
	// --machine still reaches it, which is how an operator audits one deliberately.
	// `where` goes INSIDE the door, not after it: a node the fleet excludes from
	// placement was never going to be probed, so reporting it as "skipped by role"
	// would put a second reason on a node that already had one.
	//
	// `includeGuests` OPENS the door for VERIFICATION ONLY (operator, 2026-10-01:
	// "the guest rule covers mutation, not verification"). It still never repairs
	// a guest, never installs on it, never pages about it — see `advisory: true`
	// on {@link buildBackstop} — it only reads what is already there.
	const { nodes: selected, skippedByRole } = selectNodes(manifest, {
		only,
		includeGuests,
		where: (m) => m.placement !== 'excluded',
	});

	// THE TOOLS EACH NODE CARRIES come from the ONE declaration (REPAIRS), filtered
	// by `applicableRepairs`: `when` in both directions. `includeGuests: true` is
	// passed UNCONDITIONALLY here — it is safe for a claw (a no-op: the guest
	// check never applied) and correct for a guest, because `selected` already
	// enforced the explicit-inclusion gate above. A guest that was NOT explicitly
	// included is never in `selected` at all; it is in `skippedByRole`.
	const toolsByNode = new Map(
		selected.map(([name, m]) => [name, applicableRepairs(m, { includeGuests: true })])
	);

	// Upstream ONCE PER TOOL PER RUN, and only for tools some selected node
	// carries. The question is "what had cleared minAge + tolerance ago" — see
	// TOLERANCE_MINUTES for why the tolerance is in the lookup.
	const latestById = {};
	const wanted = new Map();
	for (const tools of toolsByNode.values()) {
		for (const [id, t] of tools) if (isVersionManaged(t)) wanted.set(id, t);
	}
	await Promise.all(
		[...wanted].map(async ([id, t]) => {
			latestById[id] = await lookup(t.latest.source, {
				minAge: minAgeOf(t) + TOLERANCE_MINUTES,
			});
		})
	);

	// The repo's own copy, read ONCE — compared against whatever a guest's probe
	// reports is actually deployed. Absent in a context where the file was not
	// published beside this script (never true for the real package); guarded so
	// a test fixture does not need to carry it. `repoHarvestSha` is what the
	// drift verdict actually compares on (#79: a byte count can coincide);
	// `repoHarvestBytes` stays for the diagnostic byte display only.
	let repoHarvestBytes = null;
	let repoHarvestSha = null;
	try {
		const pkgHarvest = readFileSync(HARVESTER_PKG_PATH);
		repoHarvestBytes = pkgHarvest.length;
		repoHarvestSha = createHash('sha256').update(pkgHarvest).digest('hex');
	} catch {
		repoHarvestBytes = null;
		repoHarvestSha = null;
	}

	const report = [];
	for (const [node, m] of selected) {
		const tools = toolsByNode.get(node);
		// The backstop probe is ADDITIONAL lines on a guest's probe only — a claw
		// never pays for cgroup/meminfo reads it has no use for.
		const guest = isGuestNode(m);
		const res = run(node, probeScript(toolCache, tools, { backstop: guest }), {
			timeoutMs: 60_000,
		});
		if (!res.ok && !res.out.includes('os\t')) {
			// `node` is a --json KEY — `toolchain` is in JSON_CONTRACT.
			// A node a human deliberately powered off is EXPECTED down, not a
			// finding — but it stays in the report and stays visible, and the
			// deferral expires. See lib/expected-down.mjs for why that is narrow.
			const defer = deferralFor(node, drains);
			report.push({
				machine: node,
				unreachable: true,
				expectedDown: defer.deferred,
				drainNote: defer.deferred ? deferralNote(node, defer) : undefined,
				error: res.error,
			});
			continue;
		}
		// `unitMax`/`bk*` are the backstop's RAW probe facts — folded into the
		// `backstop` object below rather than spread onto the top level, so they
		// never leak as unlabelled fields on a claw's report (which never carries
		// them) or shadow a future top-level key of the same short name.
		const {
			unitMax,
			bkAvailKb,
			bkTopHold,
			bkHarvestPath,
			bkHarvestBytes,
			bkHarvestSha,
			dropins,
			bkWorkKb,
			bkRootFreeKb,
			...restFacts
		} = parseProbe(res.out);
		const facts = restFacts;
		const missingCache = Object.keys(facts.cache).filter((k) => !facts.cache[k]);
		const toolReports = judgeNode(tools, parseToolProbe(res.out), latestById);
		const toolFindings = toolReports.filter((t) => t.finding);
		report.push({
			machine: node,
			unreachable: false,
			...facts,
			missingCache,
			// A pnpm that disagrees with its own store is drift even when every
			// package is present: the doctor trusts that path, so the disagreement
			// silently disables the fleet's corruption repair.
			pnpmDrift: facts.pnpmStoreAgrees === false,
			// ADDITIVE (#69). `tools` is every tool this node carries and how it
			// judged; `toolFindings` is the failing subset, which is also folded into
			// `drift` so the existing consumer (`ci:fleet-toolchain`, which reads
			// `drift`) fails the node without being changed.
			tools: toolReports,
			toolFindings,
			// `tools.length` guards the bug this doctor shipped once:
			// `--machine hokon --include-guests` reported `drift=false` with
			// `tools: []`, because nothing was evaluated, not because nothing was
			// wrong. See {@link computeDrift}.
			drift: computeDrift({
				missingCache,
				ensurepip: facts.ensurepip,
				pnpmStoreAgrees: facts.pnpmStoreAgrees,
				toolFindings,
				toolsEvaluated: tools.length,
			}),
			// ADVISORY, GUEST ONLY. Never folded into `drift` — a consumer parsing
			// `drift`/`toolFindings` for a page sees nothing new. See `buildBackstop`.
			...(guest
				? {
						backstop: buildBackstop(
							{
								...facts,
								unitMax,
								bkAvailKb,
								bkTopHold,
								bkHarvestPath,
								bkHarvestBytes,
								bkHarvestSha,
								dropins,
								bkWorkKb,
								bkRootFreeKb,
							},
							{
								minFreeMb: m?.minFreeMb,
								repoHarvestBytes,
								repoHarvestSha,
								sliceMaxMb: m?.slice?.maxMb,
								nodeName: node,
							}
						),
					}
				: {}),
		});
	}
	return { toolCache, report, skippedByRole, latest: latestById };
}

async function main() {
	const JSON_OUT = process.argv.includes('--json');
	// One stdout discipline, shared — see lib/emit.mjs. `emit` is the ONLY write
	// to stdout below, which is what makes "print before the JSON" unreachable
	// rather than merely absent.
	const emitter = createEmitter({ json: JSON_OUT });
	const log = emitter.log;

	const manifest = loadManifest();
	// `--include-guests` — the one spelling `converge-toolchain` established.
	// VERIFICATION ONLY: see the note on `runDoctor`'s own `includeGuests`.
	const INCLUDE_GUESTS = process.argv.includes('--include-guests');
	const ONLY = machineArg();
	let result;
	try {
		result = await runDoctor({ manifest, only: ONLY, includeGuests: INCLUDE_GUESTS });
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
	const { toolCache, report, skippedByRole, latest } = result;
	// ZERO NODES PROBED IS NOT A CLEAN FLEET (#98). `--machine` with a typo, or a
	// manifest where every node is excluded, probed nothing and exited 0 with
	// "Every node matches". There is no explained zero: a guest NAMED with
	// `--machine` is reached (`guestGate`), so it is probed and never lands here;
	// a guest that was not named is skipped, and a fleet of nothing else probed
	// nothing.
	const noneProbed =
		report.length === 0
			? ONLY
				? `--machine ${ONLY} selected no probeable node — check the name against the manifest`
				: `no node was probed — every machine in the manifest is excluded` +
					(skippedByRole.length
						? ` or a guest skipped by role (${skippedByRole.map((s) => s.node).join(', ')}; ` +
							'name one with --machine to verify it)'
						: '')
			: null;
	if (noneProbed) console.error(`✗ ${noneProbed}. Nothing probed is not "nothing drifted".`);

	log('Toolchain declared: tool cache, plus every REPAIRS tool each node carries.');
	log(
		`Tool cache: ${Object.entries(toolCache)
			.filter(([k]) => !k.startsWith('$'))
			.map(([l, v]) => `${l} ${v.join('/')}`)
			.join(', ')}\n`
	);

	if (JSON_OUT) {
		// `skippedByRole` rides ALONGSIDE `machines` rather than inside it: `machines`
		// means "the boxes this run probed", and a guest is precisely one it did not.
		// Folding them together would make a skipped guest indistinguishable from a
		// node that answered.
		emitter.emit({
			toolCache,
			machines: report,
			skippedByRole,
			// ADDITIVE: what upstream said per tool, so an `unknown` is diagnosable.
			toolLatest: latest,
			toolToleranceMinutes: TOLERANCE_MINUTES,
			// ADDITIVE (#98): why a run that probed nothing failed. `null` otherwise.
			noneProbed,
		});
	} else {
		for (const s of skippedByRole) log(`── ${s.node}  [skipped: guest]\n   ${s.why}`);
		for (const r of report) {
			if (r.unreachable) {
				log(
					r.expectedDown
						? `── ${r.machine}  [expected down]\n   ${r.drainNote}`
						: `── ${r.machine}\n   UNREACHABLE — ${r.error}`
				);
				continue;
			}
			const flag = r.drift ? 'DRIFT' : 'ok';
			log(`── ${r.machine}  [${flag}]`);
			log(`   ${r.os}   python3 ${r.python}   venv-capable: ${r.ensurepip ? 'yes' : 'NO'}`);
			if (!r.toolCacheWritable) log(`   ! /opt/hostedtoolcache is NOT writable by the runner user`);
			if (r.missingCache.length) log(`   ! missing tool cache: ${r.missingCache.join(', ')}`);
			if (r.tools && r.tools.length === 0) {
				log(
					`   ! zero REPAIRS tools were evaluated here — "nothing checked" is not ` +
						`"nothing wrong"`
				);
			}
			for (const t of r.toolFindings) log(`   ! tool ${t.id} [${t.status}]: ${t.reason}`);
			if (r.pnpmDrift) {
				// TWO CAUSES REACH THIS SAME MISSING DIRECTORY, AND THEY HAVE
				// DIFFERENT REMEDIES. Until 2026-09-09 this printed the shadowing
				// story for both, so claw-7 and claw-8 were told to run
				// `sudo corepack enable` on nodes where pnpm ALREADY resolved to
				// corepack's shim — a no-op that would have left the drift exactly
				// where it was. A finding that names the wrong cause is
				// unactionable, which is the whole point of saying WHY.
				//
				// The probe already carries the evidence that separates them:
				// `pnpm_bin` is the RESOLVED binary. Corepack's shim lives under a
				// corepack dist; an npm-global pnpm does not.
				const shadowed = !/corepack/.test(r.pnpmBin ?? '');
				log(
					`   ! pnpm ${r.pnpm ?? '?'} (${r.pnpmBin ?? '?'}) reports a store directory that ` +
						`does not exist.`
				);
				log(
					shadowed
						? `     A globally-installed pnpm is shadowing corepack, and the store doctor ` +
								`trusts this path — so corruption repair is a silent no-op. ` +
								`Fix: sudo corepack enable`
						: `     pnpm IS corepack's shim here, so nothing is shadowing it — the store has ` +
								`simply never been created. It is made lazily by the first package fetch, ` +
								`and \`pnpm store prune\` against a missing store is a no-op. ` +
								`Fix: fetch one package as the runner user FROM ITS HOME — pnpm keeps the ` +
								`store on the filesystem it hardlinks into, and /tmp is tmpfs here, so a ` +
								`/tmp warm-up builds a store in RAM and changes nothing.`
				);
			}
			if (r.backstop) {
				const b = r.backstop;
				const sliceContrast =
					b.unitCapReachesSlice === null
						? ''
						: b.unitCapReachesSlice
							? ` — reaches its ${b.sliceMaxMb} MB slice, as a claw's units do (#26)`
							: ` against a ${b.sliceMaxMb} MB slice — claws' units reach their slice ` +
								`(#26); a job needing more than ${b.unitMaxMb[0]} MB is OOM-killed here ` +
								`even though the slice could hold it`;
				const unitCapLine =
					b.unitMaxMb.length === 0
						? 'no runner units found'
						: b.unitMaxMb.length === 1
							? `flat ${b.unitMaxMb[0]} MB across ${b.unitCount} unit(s)${sliceContrast}`
							: `NOT FLAT — ${b.unitMaxMb.join('/')} MB across ${b.unitCount} unit(s)`;
				const availLine =
					b.availableMb === null
						? 'unknown — could not read MemAvailable'
						: `${b.available === false ? 'no' : b.available === true ? 'yes' : 'unknown'} — ` +
							`${(b.availableMb / 1024).toFixed(1)} GB free` +
							(b.floorMb === null ? '' : ` (floor ${(b.floorMb / 1024).toFixed(1)} GB)`) +
							(b.topHolder && b.topHolder.cmd
								? ` — top holder: ${b.topHolder.cmd} (~${b.topHolder.rssMb} MB)`
								: '');
				const harvestLine = b.harvesterDrift
					? `STALE — ${b.harvesterPath === null ? 'no running harvester' : b.harvesterBytes === null ? `${b.harvesterPath} unreadable` : `${b.harvesterBytes} B at ${b.harvesterPath}`} vs ${b.harvesterRepoBytes} B shipped by this package (by CONTENT, sha256)`
					: `current (${b.harvesterBytes} B, sha256 matches)`;
				log(`   BACKSTOP READINESS (advisory — informational only, never a finding):`);
				log(`     per-unit memory cap: ${unitCapLine}`);
				log(`     backstop available: ${availLine}`);
				log(`     harvester: ${harvestLine}`);
				// #79 hygiene — reported, never repaired: each advisory names its own
				// one-line fix for the OPERATOR to run by hand on the guest.
				for (const adv of b.advisories ?? []) {
					log(`     advisory [${adv.id}]: ${adv.message}`);
					log(`       fix: ${adv.fix}`);
				}
			}
		}
	}

	const drifted = report.filter((r) => r.drift && !r.unreachable);
	// Only UNEXPECTED unreachability fails. A deferred node is still listed above.
	const unreachable = report.filter((r) => r.unreachable && !r.expectedDown);
	const expectedDown = report.filter((r) => r.unreachable && r.expectedDown);

	if (drifted.length && !JSON_OUT) {
		log('\nTo converge:');
		for (const r of drifted) {
			// One suggestion per LANGUAGE, not per version: the seed copies the whole
			// language tree, so emitting it per missing version prints the same
			// command three times and invites someone to run it three times.
			for (const lang of [...new Set(r.missingCache.map((k) => k.split('/')[0]))]) {
				// Seed from a node that HAS it rather than downloading: the version
				// already on a claw is the one the workflows are pinned to, and
				// actions/python-versions has no trixie build to download anyway.
				const donor = report.find(
					(d) =>
						!d.unreachable &&
						Object.entries(d.cache ?? {}).some(([k, v]) => v && k.startsWith(`${lang}/`))
				);
				if (!donor) {
					log(`  # ${lang} missing on ${r.machine} and NO node has it to copy from`);
					continue;
				}
				// The target may be THIS host, which cannot ssh itself — the same trap
				// that made the fast loop read hokon as permanently saturated.
				const sink = isLocalNode(r.machine)
					? `tar -C /opt/hostedtoolcache -xf -`
					: `ssh ${r.machine} "tar -C /opt/hostedtoolcache -xf -"`;
				log(
					`  # seed ${lang} on ${r.machine} from ${donor.machine}:\n` +
						`  ssh ${donor.machine} "tar -C /opt/hostedtoolcache -cf - ${lang}" | ${sink}`
				);
			}
		}
	}

	if (!JSON_OUT) {
		log(
			`\n${drifted.length ? `${drifted.length} node(s) DRIFTED` : noneProbed ? 'No node was probed.' : 'Every node matches the declared toolchain.'}` +
				(unreachable.length ? `  (${unreachable.length} unreachable)` : '') +
				(expectedDown.length ? `  (${expectedDown.length} expected down)` : '') +
				(skippedByRole.length ? `  (${skippedByRole.length} guest(s) skipped by role)` : '')
		);
	}
	process.exit(drifted.length || unreachable.length || noneProbed ? 1 : 0);
}

// Run only as the entry point, so a test can import the pure halves.
const entry = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (entry === realpathSync(fileURLToPath(import.meta.url))) await main();
