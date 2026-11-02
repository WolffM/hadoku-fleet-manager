/**
 * refresh-cycle — the CADENCE half of issue #69: regularly move every claw's
 * tools to the newest release that has cleared its debounce.
 *
 * ONE DECLARATION, THREE CONSUMERS. This reads `REPAIRS` (through
 * `applicableRepairs`) and judges with the DOCTOR's own `judgeTool`, so the
 * cadence and the backstop cannot disagree about what "behind" means.
 *
 * SHAPE
 * -----
 *   detect every node            cheap, no drain
 *     -> only nodes with work    behind by the debounce rule, or absent
 *     -> ONE node at a time:     drain -> wait until DRAINED -> update
 *                                -> re-probe -> undrain
 *
 * The orchestration takes every side effect as an injected dependency, so the
 * safety properties below are tested against fixtures and never against a node:
 *
 *   - Detect first; drain only when there is work.
 *   - NEVER update before the node is DRAINED. `draining` (jobs still running)
 *     is not `drained`; apt under a running job is the hazard `ci:fleet-toolchain`
 *     refuses `--confirm` over. The wait is time-bounded: a timeout undrains and
 *     nothing is updated.
 *   - Undrain on EVERY path after a successful drain — EXCEPT a node whose
 *     re-probe says it is BROKEN (a worked tool absent/unknown, or the node
 *     unreadable). That node stays drained, is re-held as `maintenance` so a
 *     human must lift it, and is a loud finding. The cycle then HALTS: a second
 *     node drained behind a broken one is how capacity drains by accident.
 *   - A node that is merely STILL BEHIND after a failed update is unchanged, so
 *     it is undrained and reported (`update-failed`), not held.
 *   - We only undrain what WE drained. A node an operator already holds is
 *     deferred, never lifted.
 *   - One node at a time; do not START a node while the queue is under pressure.
 *     Backing off is `deferred`, never `ok`. A queue we could not read is a
 *     finding: "I could not look" is not "quiet".
 *   - The backstop is in the same pool as every claw: updated, drained and
 *     rechecked by the same rules (it was check-only until 2026-10-31). The
 *     fleet has no sudo there, so a work item whose script needs root is not
 *     run on it: it is an ADVISORY naming the operator's hand-run, carried in
 *     `advisories`, never a finding (lib/operator-sudo.mjs).
 *   - Unknown upstream, unreadable node, unreadable queue: findings with the
 *     reason carried, non-zero exit. Never "current".
 */
import { judgeTool } from '../check-fleet-toolchain.mjs';
import { fleetHasSudo } from '../../dist/lib/node-role.js';
import { rootAdvisory } from './operator-sudo.mjs';
import {
	applicableRepairs,
	installScript,
	isVersionManaged,
	linkScript,
	repairNeedsRoot,
} from './toolchain-floor.mjs';
import { compareVersions, parseVersion } from './tool-release.mjs';
import { errText } from './term.mjs';

/** A waiting run younger than this is the normal trickle, not pressure. */
export const PRESSURE_OLDEST_SECONDS = 60;

/**
 * A node whose bootcamp record is older than this gets a RECHECK turn even with
 * no tool work: drain, re-run bootcamp, undrain. Records went stale because
 * bootcamp ran only when a human typed it — claw-1/2/6 sat at 2026-09-26 for
 * two weeks, and claw-1's never showed the rust it had, because the one run
 * that probed it did not pass and nothing ever asked again. At most ONE recheck
 * per run, the most stale first, so the cycle stays one node out at a time.
 */
export const RECHECK_DAYS = 7;

/**
 * Turn a node's probe into work and findings. Pure.
 *
 *   behind            -> update to the newest cleared release
 *   absent, but the   -> LINK ONLY: the binary is there and only a login shell
 *   login shell can      can see it, so the fault is stock-PATH reachability.
 *   see it, or only      The same for one a non-login shell finds but a runner's
 *   a runner's PATH      own PATH does not (#127); with no `link` that is a
 *   misses it            finding, never an install.
 *                        Never an install: a pinned install would DOWNGRADE a
 *                        binary newer than the newest debounce-cleared release,
 *                        and an unreadable version must not be reinstalled over.
 *                        A login-only tool with no declared `link` keeps the old path.
 *   absent            -> version-managed: install pinned to the cleared release
 *                        (needs a KNOWN latest, or it is a finding — an install
 *                        with no debounce answer would skip the debounce);
 *                        presence-only: run the repair
 *   unknown           -> finding, reason carried
 *   ok / ahead        -> nothing
 */
export function planNode(tools, seen, latestById) {
	const work = [];
	const findings = [];
	for (const [id, tool] of tools) {
		const latest = latestById[id];
		const j = judgeTool(id, tool, seen[id], latest);
		if (j.status === 'behind') {
			work.push({ id, action: 'update', from: j.installed, target: j.target });
		} else if (j.status === 'absent') {
			if ((j.loginOnly || j.runnerPathOnly) && tool.link) {
				work.push({
					id,
					action: 'link',
					from: j.installed ?? null,
					installed: j.installed ?? 'unknown',
					reason: j.reason,
				});
			} else if (j.runnerPathOnly) {
				// Installed and current; only a runner's PATH misses it. An install
				// cannot fix where a binary lives, so with no `link` it is a finding.
				findings.push({ tool: id, kind: 'unreachable', reason: j.reason });
			} else if (!isVersionManaged(tool)) {
				work.push({ id, action: 'repair', reason: j.reason });
			} else if (latest?.status === 'known') {
				work.push({ id, action: 'install', target: latest.version, reason: j.reason });
			} else {
				findings.push({
					tool: id,
					kind: 'unknown',
					reason: `${j.reason}; and upstream could not say what to install: ${latest?.reason ?? 'not consulted'}`,
				});
			}
		} else if (j.status === 'unknown') {
			findings.push({ tool: id, kind: 'unknown', reason: j.reason });
		}
	}
	return { work, findings };
}

/**
 * How a node looks AFTER the update. `broken` = held; `stale` = unchanged.
 * The install's exit code is the writer describing itself; this is the probe.
 */
export function verdictAfter(work, tools, seen, latestById) {
	const toolById = new Map(tools);
	const problems = [];
	let stale = false;
	for (const w of work) {
		const j = judgeTool(w.id, toolById.get(w.id), seen[w.id], latestById[w.id]);
		if (j.status === 'absent' || j.status === 'unknown') {
			problems.push(`${w.id} [${j.status}]: ${j.reason}`);
		} else if (j.status === 'behind' && w.action !== 'link') {
			// A link moves no version: a tool that is reachable now but still behind is
			// the NEXT cycle's upgrade, not a failed link.
			stale = true;
		}
	}
	if (problems.length) return { status: 'broken', reason: problems.join('; ') };
	return { status: stale ? 'stale' : 'ok' };
}

/**
 * Run ONE work item on a node. `run(script)` returns `{ ok, stderr?, error? }`.
 *
 * THE DOWNGRADE GUARD lives here, as well as in the planner and the install
 * script: any install/update whose target is LOWER than the installed version
 * (when that is readable) is refused with the reason carried. A `link` runs the
 * tool's declared reachability script and nothing else. `context` is the
 * node's `installScript` options (fleet-exec's `repairContext`).
 */
export function runWorkItem(w, run, context = {}) {
	if (w.action === 'link') {
		const script = linkScript(w.id);
		if (!script) return { id: w.id, ok: false, reason: `${w.id} declares no link repair` };
		return settle(w.id, run(`set -u\n${script}`));
	}
	if (w.target && w.from && parseVersion(w.from) && parseVersion(w.target)) {
		if (compareVersions(w.from, w.target) > 0) {
			return {
				id: w.id,
				ok: false,
				reason: `refusing to DOWNGRADE ${w.id} ${w.from} -> ${w.target}; nothing was run`,
			};
		}
	}
	const script = `set -u\nexport DEBIAN_FRONTEND=noninteractive\n${installScript(w.id, w.target, context)}`;
	return settle(w.id, run(script));
}

function settle(id, res) {
	return {
		id,
		ok: res.ok,
		reason: res.ok ? null : (res.stderr || res.error || 'install failed').trim().slice(0, 300),
	};
}

/**
 * @param {object} p
 * @param {Array<[string, object]>} p.machines  manifest `[name, entry]` pairs
 * @param {object} p.deps  detect, latest, isDrained, drain, undrain, waitDrained,
 *                         update, reprobe, queuePressure
 * @param {boolean} [p.plan]  detect and report only; drain nothing
 * @param {(line:string)=>void} [p.log]
 * @param {(name:string, entry:object)=>boolean} [p.sudo]  may this run use sudo
 *        on the node; `--operator-sudo` widens it for the operator's hand-run
 */
export async function runRefreshCycle({
	machines,
	deps,
	plan = false,
	log = () => {},
	// `state.held` is the node WE currently hold drained, so a signal handler can
	// put it back: a cycle killed mid-node must not leave an outage behind.
	state = {},
	// Epoch ms after which no NEW node is started. The job's own wall-clock kill
	// would otherwise land mid-node.
	deadline = null,
	now = () => Date.now(),
	sudo = (_name, entry) => fleetHasSudo(entry),
}) {
	const nodes = [];
	const findings = [];
	const advisories = [];
	const finding = (node, kind, reason) => findings.push({ node, kind, reason });

	// Upstream ONCE PER TOOL PER RUN, for tools some node carries.
	const toolsByNode = new Map(machines.map(([name, entry]) => [name, applicableRepairs(entry)]));
	const latestById = {};
	const wanted = new Map();
	for (const tools of toolsByNode.values()) {
		for (const [id, t] of tools) if (isVersionManaged(t)) wanted.set(id, t);
	}
	for (const [id, t] of wanted) {
		latestById[id] = await deps.latest(id, t);
	}

	// PASS 1 — detect everything. No drain, no write.
	const todo = [];
	for (const [name, entry] of machines) {
		const tools = toolsByNode.get(name);
		let probe;
		try {
			probe = await deps.detect(name, tools);
		} catch (e) {
			probe = { ok: false, reason: errText(e) };
		}
		if (!probe.ok) {
			if (probe.expectedDown) {
				log(`── ${name}  [expected down]  ${probe.reason}`);
				nodes.push({ node: name, status: 'expected-down', reason: probe.reason });
			} else {
				log(`── ${name}  [UNREADABLE]  ${probe.reason}`);
				nodes.push({ node: name, status: 'unreadable', reason: probe.reason });
				finding(name, 'unreadable', probe.reason);
			}
			continue;
		}
		const planned = planNode(tools, probe.seen, latestById);
		const toolFindings = planned.findings;
		for (const f of toolFindings) finding(name, f.kind, `${f.tool}: ${f.reason}`);
		// Root work is withheld where the fleet has no sudo, and said.
		const mayRoot = sudo(name, entry);
		const work = planned.work.filter((w) => mayRoot || !repairNeedsRoot(w.id, w.action));
		const withheld = planned.work
			.filter((w) => !work.includes(w))
			.map((w) =>
				rootAdvisory(
					name,
					`${w.id} ${w.action}${w.target ? ` to ${w.target}` : ''}`,
					`fleet converge-toolchain --refresh --machine ${name}`
				)
			);
		advisories.push(...withheld);
		for (const a of withheld) log(`── ${name}  [advisory] ${a.message}\n     ${a.fix}`);
		if (!work.length) {
			const status = toolFindings.length ? 'finding' : withheld.length ? 'advisory' : 'current';
			log(`── ${name}  [${status === 'finding' ? 'FINDING' : status}]`);
			nodes.push({ node: name, status, findings: toolFindings });
			continue;
		}
		log(
			`── ${name}  [work: ${work.map((w) => `${w.id} ${w.action}${w.target ? ` -> ${w.target}` : ''}`).join(', ')}]`
		);
		todo.push({ name, tools, work, toolFindings });
	}

	// ONE RECHECK, the most stale record among nodes with no tool work and no
	// finding. `deps.rebootcamp` absent means this caller cannot re-run
	// bootcamp, so there is nothing for a recheck turn to do.
	if (deps.rebootcamp) {
		const busy = new Set(todo.map((t) => t.name));
		const stale = machines
			.filter(([name]) => {
				const rec = nodes.find((n) => n.node === name);
				return !busy.has(name) && (rec?.status === 'current' || rec?.status === 'advisory');
			})
			// `$capabilities.at` moves only when the record CHANGES (#59 — an
			// unchanged re-probe must not redeploy mgmt-api), so it cannot say
			// when a node was last CHECKED; the cycle keeps that itself, or the
			// same unchanged node would be picked every run.
			.map(([name, entry]) => ({ name, at: lastRecordedMs(deps, name, entry) }))
			.filter((n) => isDue(n.at, now()))
			.sort(byStalest);
		if (stale.length) {
			const { name } = stale[0];
			const i = nodes.findIndex((n) => n.node === name);
			nodes.splice(i, 1);
			log(`── ${name}  [recheck: bootcamp record older than ${RECHECK_DAYS} days]`);
			todo.push({ name, tools: toolsByNode.get(name), work: [], toolFindings: [], recheck: true });
		}
	}

	if (plan) {
		for (const t of todo) {
			nodes.push({
				node: t.name,
				status: 'planned',
				work: t.work,
				findings: t.toolFindings,
			});
		}
		return finish({ nodes, findings, advisories, latestById, plan });
	}

	// PASS 2 — ONE node at a time.
	let halted = null;
	for (const t of todo) {
		const { name, tools, work, toolFindings } = t;
		const rec = { node: name, work, findings: toolFindings };
		nodes.push(rec);

		if (halted) {
			rec.status = 'deferred';
			rec.reason = `cycle halted: ${halted}`;
			log(`── ${name}  [deferred] ${rec.reason}`);
			continue;
		}

		if (deadline !== null && now() >= deadline) {
			rec.status = 'deferred';
			rec.reason = 'out of time budget; not started (the next run picks it up)';
			log(`── ${name}  [deferred] ${rec.reason}`);
			continue;
		}

		// An operator's hold is not ours to lift.
		let held;
		try {
			held = await deps.isDrained(name);
		} catch (e) {
			rec.status = 'finding';
			finding(name, 'drain-state-unreadable', errText(e));
			continue;
		}
		if (held) {
			rec.status = 'deferred';
			rec.reason = 'already drained by someone else; not ours to lift, and not updated';
			log(`── ${name}  [deferred] ${rec.reason}`);
			continue;
		}

		let pressure;
		try {
			pressure = await deps.queuePressure();
		} catch (e) {
			pressure = { pressured: true, unknown: true, reason: errText(e) };
		}
		if (pressure.unknown) {
			rec.status = 'deferred';
			rec.reason = `could not read the queue, so not starting a node: ${pressure.reason}`;
			finding(name, 'queue-unreadable', rec.reason);
			log(`── ${name}  [deferred, FINDING] ${rec.reason}`);
			continue;
		}
		if (pressure.pressured) {
			rec.status = 'deferred';
			rec.reason = `queue under pressure: ${pressure.reason}`;
			log(`── ${name}  [deferred] ${rec.reason}`);
			continue;
		}

		// DRAIN.
		let d = await attempt(() =>
			deps.drain(name, {
				kind: 'training',
				reason: 'toolchain refresh (automated); returns after re-probe',
			})
		);
		if (d.ok && d.value?.ok === false) d = { ok: false, reason: d.value.reason ?? 'drain refused' };
		if (!d.ok) {
			// Nothing to undo unless the write landed before the failure surfaced.
			let landed = false;
			try {
				landed = await deps.isDrained(name);
			} catch {
				landed = true; // cannot tell, so assume it did and try to undo
			}
			if (landed) await attempt(() => deps.undrain(name));
			rec.status = 'finding';
			finding(name, 'drain-failed', d.reason);
			log(`── ${name}  [FINDING] drain failed: ${d.reason}`);
			continue;
		}

		// From here every path ends in exactly one of: undrain, or hold-and-halt.
		state.held = name;
		const w = await attempt(() => deps.waitDrained(name));
		if (!w.ok || !w.value?.drained) {
			rec.status = 'finding';
			const why = w.ok ? (w.value?.reason ?? 'not drained') : w.reason;
			finding(name, 'drain-timeout', `${why}; nothing was updated`);
			await putBack(name, rec, deps, finding, log, state);
			continue;
		}

		if (t.recheck) {
			await rebootcamp(name, rec, deps, finding, log);
			rec.status = rec.status ?? 'rechecked';
			await putBack(name, rec, deps, finding, log, state);
			if (rec.status === 'rechecked') log(`── ${name}  [rechecked]`);
			continue;
		}

		const u = await attempt(() => deps.update(name, work));
		const results = u.ok ? (u.value ?? []) : [];
		const updateFailures = u.ok
			? results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.reason}`)
			: [u.reason];
		rec.update = u.ok ? results : [{ ok: false, reason: u.reason }];

		// The re-probe decides, not the installer's exit status.
		const rp = await attempt(() => deps.reprobe(name, tools));
		let verdict;
		if (!rp.ok || !rp.value?.ok) {
			verdict = {
				status: 'broken',
				reason: `re-probe could not read the node: ${rp.ok ? rp.value?.reason : rp.reason}`,
			};
		} else {
			verdict = verdictAfter(work, tools, rp.value.seen, latestById);
		}
		rec.verdict = verdict;

		if (verdict.status === 'broken') {
			rec.status = 'held';
			halted = `${name} failed its re-probe`;
			finding(
				name,
				'reprobe-failed',
				`${verdict.reason}. The node STAYS DRAINED — a human puts it back.` +
					(updateFailures.length ? ` Update said: ${updateFailures.join('; ')}` : '')
			);
			state.held = null; // a deliberate hold: a human lifts it, not a signal handler
			await attempt(() =>
				deps.drain(name, {
					kind: 'maintenance',
					reason: `toolchain refresh FAILED its re-probe: ${verdict.reason}`.slice(0, 300),
				})
			);
			log(`── ${name}  [HELD: re-probe failed] ${verdict.reason}`);
			continue;
		}

		if (updateFailures.length || verdict.status === 'stale') {
			rec.status = 'update-failed';
			finding(
				name,
				'update-failed',
				`${updateFailures.join('; ') || 'tool still behind after the update'}; node unchanged and healthy`
			);
		} else {
			rec.status = 'updated';
		}
		// The node is drained and its tools just moved: the moment to re-record
		// what it can do, so the record follows the toolchain instead of lagging it.
		if (deps.rebootcamp) await rebootcamp(name, rec, deps, finding, log);
		await putBack(name, rec, deps, finding, log, state);
		if (rec.status === 'updated') log(`── ${name}  [updated]`);
	}

	return finish({ nodes, findings, advisories, latestById, plan });
}

/**
 * Re-run bootcamp for a node the cycle holds drained. A failure is a finding but
 * never a hold: the re-probe already decided whether the toolchain is healthy,
 * and bootcamp failing to WRITE is a record problem, not a broken node.
 */
async function rebootcamp(name, rec, deps, finding, log) {
	const b = await attempt(() => deps.rebootcamp(name));
	const ok = b.ok && b.value?.ok !== false;
	if (ok) await attempt(() => deps.markChecked?.(name));
	rec.rebootcamp = ok ? 'ok' : ((b.ok ? b.value?.reason : b.reason) ?? 'failed');
	if (!ok) {
		finding(name, 'rebootcamp-failed', `bootcamp did not re-record this node: ${rec.rebootcamp}`);
		log(`── ${name}  [FINDING] re-bootcamp failed: ${rec.rebootcamp}`);
	}
}

/** When this node was last recorded or rechecked, epoch ms; NaN for never. */
function lastRecordedMs(deps, name, entry) {
	return (
		Math.max(Date.parse(entry?.$capabilities?.at ?? '') || 0, lastCheckedMs(deps, name)) || NaN
	);
}
const isDue = (at, nowMs) => !Number.isFinite(at) || nowMs - at > RECHECK_DAYS * 86_400_000;
const byStalest = (a, b) => (Number.isFinite(a.at) ? a.at : 0) - (Number.isFinite(b.at) ? b.at : 0);

async function attempt(fn) {
	try {
		return { ok: true, value: await fn() };
	} catch (e) {
		return { ok: false, reason: errText(e) };
	}
}

/** Undrain; a failure to do so is itself loud. */
async function putBack(name, rec, deps, finding, log, state) {
	const r = await attempt(() => deps.undrain(name));
	state.held = null;
	if (!r.ok || r.value?.ok === false) {
		rec.undrained = false;
		finding(
			name,
			'undrain-failed',
			`the node is STILL DRAINED: ${r.ok ? r.value.reason : r.reason}`
		);
		log(`── ${name}  [FINDING] undrain failed`);
	} else {
		rec.undrained = true;
	}
}

function finish({ nodes, findings, advisories, latestById, plan }) {
	if (nodes.length === 0) {
		findings.push({
			node: null,
			kind: 'nothing-looked-at',
			reason: 'no node was examined; that is not a pass',
		});
	}
	return {
		ok: findings.length === 0,
		plan,
		nodes,
		findings,
		advisories,
		deferred: nodes.filter((n) => n.status === 'deferred').length,
		toolLatest: latestById,
	};
}

/** A node's last recheck from `deps.lastChecked`, or 0 — a non-number is "no record here". */
function lastCheckedMs(deps, name) {
	const v = deps.lastChecked?.(name);
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// LIVE DEPENDENCIES moved to refresh-cycle-live.mjs (800-line ceiling, wave
// 5s lane D): everything that touches a real node, `ssh`, or this package's
// own CLIs lives there now. Re-exported here so every existing importer
// (`./lib/refresh-cycle.mjs` / `./refresh-cycle.mjs`) keeps compiling
// unchanged.
// ---------------------------------------------------------------------------
export { createLiveDeps, judgePressure, liveQueuePressure } from './refresh-cycle-live.mjs';

// ---------------------------------------------------------------------------
// THE DRAIN-AND-WAIT PRIMITIVE moved to drain-wait.mjs (wave clean-2 lane C,
// cut (iii) layer debt): busyCount/drainCli/waitUntilDrained, plus the
// timing constants waitUntilDrained defaults from, are observation/run so
// `benchmark-fleet.mjs` may import them directly without reaching into this
// (lifecycle) file. Re-exported here so every existing importer of THIS file
// (bootcamp.mjs, bootcamp-idle.mjs, bootcamp-canary.mjs, reboot-claws.mjs,
// refresh-cycle.test.mjs) keeps compiling and behaving unchanged.
// ---------------------------------------------------------------------------
export {
	busyCount,
	drainCli,
	waitUntilDrained,
	DRAIN_TIMEOUT_MS,
	POLL_MS,
	SETTLE_MS,
} from './drain-wait.mjs';
