/**
 * toolchain-doctor — is every node able to BUILD the same things, and is its
 * tool CACHE (python/node hostedtoolcache, pnpm's store) intact?
 *
 * MOVED HERE (wave gates2 lane F1a) from the former `check-fleet-toolchain.mjs`,
 * a standalone CLI (`ci:fleet-toolchain`, 13:00) that re-read exactly what
 * `fleet converge-toolchain --refresh` (`ci:toolchain-refresh`, 12:00) had just
 * repaired an hour earlier. The CADENCE and the DOCTOR shared one declaration
 * (`REPAIRS`/`judgeTool`) already; this file is that shared declaration plus
 * everything fleet-toolchain checked that the refresh cycle did not — the tool
 * CACHE (hostedtoolcache python/node versions, `ensurepip`, pnpm's store
 * agreement) and the backstop's advisory readiness block. `converge-toolchain
 * --refresh` now calls {@link runDoctor} itself and folds `missingCache`/
 * `ensurepip`/`pnpmDrift` into its OWN findings, so nothing has to re-read the
 * fleet an hour later to learn it. `fleet toolchain` (now `scripts/toolchain.mjs`)
 * keeps calling {@link runDoctor} too, unchanged, because mgmt-api's
 * `ci:fleet-toolchain` cron still parses its `{machines:[...]}` shape until the
 * site lane retires that cron (lane S1) — see that file's header.
 *
 * `judgeTool` is the one other load-bearing export: `scripts/lib/refresh-cycle.mjs`
 * imports it directly (the cadence and the doctor must never judge a tool
 * differently), and it used to live in `check-fleet-toolchain.mjs` too.
 *
 * WHY IT ONLY REPORTS BY DEFAULT
 * ------------------------------
 * Read-only. The tool cache is SEEDED by seed-runner-python.mjs and copied
 * between nodes by the commands this prints; nothing here installs anything.
 * Exit 1 on drift, so a cron can page on it.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { runOnSync, selectMachines } from './fleet-exec.mjs';
import { backstopProbeScript, buildBackstop, HARVESTER_PKG_PATH } from './toolchain-backstop.mjs';
// Re-exported, unchanged in meaning: `toolchain-doctor.test.mjs` (and anything
// else) imports these two from HERE, same as before the backstop block moved
// out to `toolchain-backstop.mjs` for size.
export {
	buildBackstop,
	WORK_ADVISORY_FREE_SHARE,
	WORK_ADVISORY_MIN_MB,
} from './toolchain-backstop.mjs';
import { deferralFor, deferralNote, readDrains } from './expected-down.mjs';
import {
	applicableRepairs,
	byRole,
	isVersionManaged,
	minAgeOf,
	probeRole,
	repairNeedsRoot,
	REPAIRS,
} from './toolchain-floor.mjs';
import { shadowVerdict } from './tool-shadow.mjs';
import { maySudo, rootAdvisory } from './operator-sudo.mjs';
import { createReleaseLookup } from './tool-release.mjs';
import { assess, parseInstalledVersion } from './version-algebra.mjs';
import { isBackstopNode } from '../../dist/lib/node-role.js';

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
function onNode(node, script, { role = 'ci', timeoutMs = 300_000 } = {}) {
	return runOnSync(node, script, { as: role, timeoutMs, connectTimeout: 8 });
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
			];
			// No job runs as admin, so an admin tool has no runner PATH to reach.
			if (probeRole(t) === 'ci') {
				lines.push(
					`printf 'TOOL\\t%s\\trunner\\t%s\\n' ${shq(id)} "$(__runner_miss ${shq(t.detect)} | tr -d '\\t')"`
				);
			}
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
	// The tool already passed detect, so dpkg owning nothing means it was put on
	// PATH some other way. apt DID answer; nothing on the node tracks that copy,
	// and the candidate may come from a source the fleet does not use.
	if (!inst && cand && cand !== '(none)') {
		return {
			id,
			status: 'unknown',
			finding: true,
			reason:
				`installed outside apt, so nothing keeps it current — dpkg has no ${id} ` +
				`package (apt would install ${cand}; check it comes from the source the fleet uses)`,
		};
	}
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
	const shadow = shadowVerdict(id, s.detect, probeRole(tool));
	if (shadow) return shadow;
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
	// (#127): the runner's PATH is read from the processes that hold it. An admin
	// tool (`role`) is not used by jobs, so it has no runner PATH to judge.
	if (probeRole(tool) === 'ci') {
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
 * which is where `when` is honoured — a tool that does not
 * apply is not in the list, so it is neither probed nor a finding.
 */
export function judgeNode(tools, seen, latestById) {
	return tools.map(([id, t]) => judgeTool(id, t, seen[id], latestById[id]));
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
	run = onNode,
	lookup = createReleaseLookup(),
	drains = readDrains(),
}) {
	const tc = manifest.toolchain;
	if (!tc) throw new Error('fleet-runner-manifest.json has no `toolchain` section');
	const toolCache = tc.toolCache ?? {};

	// A node the fleet excludes from placement is not probed.
	const selected = selectMachines(manifest, { only, where: (m) => m.placement !== 'excluded' });

	// THE TOOLS EACH NODE CARRIES come from the ONE declaration (REPAIRS), filtered
	// by `applicableRepairs`: `when` in both directions.
	const toolsByNode = new Map(selected.map(([name, m]) => [name, applicableRepairs(m)]));

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

	// The repo's own copy, read ONCE — compared against whatever the backstop's probe
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
		// The backstop probe is ADDITIONAL lines on the backstop's probe only — a
		// claw never pays for cgroup/meminfo reads it has no use for.
		const backstop = isBackstopNode(m);
		// The main probe reads as ci; a tool another role owns (`byRole`) is read
		// as that role, and its lines are appended to the same output.
		const groups = new Map(byRole(tools));
		const ciTools = groups.get('ci') ?? [];
		groups.delete('ci');
		const res = run(node, probeScript(toolCache, ciTools, { backstop }), {
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
		const seen = parseToolProbe(res.out);
		const unread = new Map();
		for (const [role, group] of groups) {
			const r = run(node, toolProbeScript(group), { role, timeoutMs: 60_000 });
			const part = parseToolProbe(r.out ?? '');
			if (!r.ok && !Object.keys(part).length) {
				for (const [id] of group) unread.set(id, `could not read it as ${role}: ${r.error}`);
			}
			Object.assign(seen, part);
		}
		const toolReports = judgeNode(tools, seen, latestById).map((t) =>
			unread.has(t.id)
				? { id: t.id, status: 'unknown', finding: true, reason: unread.get(t.id) }
				: t
		);
		// A finding the fleet could only fix with root, on a node it has no sudo on
		// (the backstop), is the operator's: an ADVISORY with the hand-run, never
		// drift that pages (lib/operator-sudo.mjs).
		const sudo = maySudo(m);
		const rootOnly = (t) => !sudo && REPAIRS[t.id] && repairNeedsRoot(t.id, 'install', m);
		const toolFindings = toolReports.filter((t) => t.finding && !rootOnly(t));
		const advisories = toolReports
			.filter((t) => t.finding && rootOnly(t))
			.map((t) =>
				rootAdvisory(
					node,
					`repairing "${t.id}" (${t.status}: ${t.reason})`,
					`fleet converge-toolchain --machine ${node} --write`
				)
			);
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
			// `tools.length` guards the bug this doctor shipped once: a node
			// reported `drift=false` with `tools: []`, because nothing was
			// evaluated, not because nothing was wrong. See {@link computeDrift}.
			drift: computeDrift({
				missingCache,
				ensurepip: facts.ensurepip,
				pnpmStoreAgrees: facts.pnpmStoreAgrees,
				toolFindings,
				toolsEvaluated: tools.length,
			}),
			...(advisories.length ? { advisories } : {}),
			// ADVISORY, BACKSTOP ONLY. Never folded into `drift` — a consumer parsing
			// `drift`/`toolFindings` for a page sees nothing new. See `buildBackstop`.
			...(backstop
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
	return { toolCache, report, latest: latestById };
}
