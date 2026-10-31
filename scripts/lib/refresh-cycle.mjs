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
 *   - A guest's tools are never touched. Its only turn is a CHECK-ONLY recheck
 *     (fleet-manager#17): `bootcamp --machine <guest> --write`, which on a guest
 *     probes the presence half and installs nothing, so it may earn a label
 *     whose tool is already there and may revoke one that fails. No drain, no
 *     queue gate: it takes no capacity out. Same due rule as a claw's. A probe
 *     that could not reach it is `unreachable`, never a pass, and every label
 *     it revokes is a finding, because a guest carries production routing.
 *   - Unknown upstream, unreadable node, unreadable queue: findings with the
 *     reason carried, non-zero exit. Never "current".
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hubRepo } from '../../dist/lib/fleet-config.js';
import { reposDir, stateDir } from './paths.mjs';
import { isGuestNode } from '../../dist/lib/node-role.js';
import { judgeTool, parseToolProbe, toolProbeScript } from '../check-fleet-toolchain.mjs';
import { deferralFor, readDrains } from './expected-down.mjs';
import { runOnSync, separateCiUser } from './fleet-exec.mjs';
import {
	applicableRepairs,
	byRole,
	installScript,
	isVersionManaged,
	linkScript,
	resolveInstallTarget,
} from './toolchain-floor.mjs';
import { compareVersions, createReleaseLookup, parseVersion } from './tool-release.mjs';
import { errText } from './term.mjs';

/** How long to wait for a node to go quiet before giving up and putting it back. */
export const DRAIN_TIMEOUT_MS = 45 * 60_000;
export const POLL_MS = 15_000;
/**
 * A standing node's `hadoku-builder` label is stripped on the fast loop's NEXT
 * tick (~60s), so zero jobs at one instant is not quiet: a job can still be
 * assigned before the strip lands. Zero must HOLD for longer than a tick.
 */
export const SETTLE_MS = 90_000;
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

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');

/**
 * Poll `busy(node)` until it has read ZERO continuously for `settleMs`.
 * `busy` returns a job count, or null for "could not look", which is BUSY.
 * Pure over an injected clock `{ now(), sleep(ms) }`.
 */
export async function waitUntilDrained({
	node,
	busy,
	clock,
	timeoutMs = DRAIN_TIMEOUT_MS,
	pollMs = POLL_MS,
	settleMs = SETTLE_MS,
}) {
	const start = clock.now();
	let quietSince = null;
	let last = 'no reading';
	for (;;) {
		const n = await busy(node);
		if (n === 0) {
			quietSince ??= clock.now();
			if (clock.now() - quietSince >= settleMs) return { drained: true };
			last = `idle for ${clock.now() - quietSince} ms of the ${settleMs} ms settle`;
		} else {
			quietSince = null;
			last = n === null ? 'could not count running jobs (treated as busy)' : `${n} job(s) running`;
		}
		if (clock.now() - start >= timeoutMs) {
			return { drained: false, reason: `not drained after ${timeoutMs} ms: ${last}` };
		}
		await clock.sleep(pollMs);
	}
}

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
 * tool's declared reachability script and nothing else.
 */
export function runWorkItem(w, run, { ciUser } = {}) {
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
	const script = `set -u\nexport DEBIAN_FRONTEND=noninteractive\n${installScript(w.id, w.target, { ciUser })}`;
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
}) {
	const nodes = [];
	const findings = [];
	const finding = (node, kind, reason) => findings.push({ node, kind, reason });

	// Upstream ONCE PER TOOL PER RUN, for tools some non-guest node carries.
	const toolsByNode = new Map(
		machines.map(([name, entry]) => [name, isGuestNode(entry) ? [] : applicableRepairs(entry)])
	);
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
		if (isGuestNode(entry)) {
			log(`── ${name}  [skipped: guest]`);
			nodes.push({ node: name, status: 'guest' });
			continue;
		}
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
		const { work, findings: toolFindings } = planNode(tools, probe.seen, latestById);
		for (const f of toolFindings) finding(name, f.kind, `${f.tool}: ${f.reason}`);
		if (!work.length) {
			log(`── ${name}  [${toolFindings.length ? 'FINDING' : 'current'}]`);
			nodes.push({
				node: name,
				status: toolFindings.length ? 'finding' : 'current',
				findings: toolFindings,
			});
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
			.filter(([name, entry]) => {
				const rec = nodes.find((n) => n.node === name);
				return !isGuestNode(entry) && !busy.has(name) && rec?.status === 'current';
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

		// ONE GUEST RECHECK, on its own turn: it drains nothing, so it does not
		// compete with a claw's. Before #17 a guest was never rechecked, and hokon
		// could not earn `data-peer` until someone bootcamped it by hand.
		const guest = machines
			.filter(([, entry]) => isGuestNode(entry))
			.map(([name, entry]) => ({ name, at: lastRecordedMs(deps, name, entry) }))
			.filter((n) => isDue(n.at, now()))
			.sort(byStalest)[0];
		if (guest) {
			const i = nodes.findIndex((n) => n.node === guest.name);
			nodes.splice(i, 1);
			log(`── ${guest.name}  [guest recheck: check-only, record older than ${RECHECK_DAYS} days]`);
			todo.push({ name: guest.name, tools: [], work: [], toolFindings: [], guest: true });
		}
	}

	if (plan) {
		for (const t of todo) {
			nodes.push({
				node: t.name,
				status: 'planned',
				work: t.work,
				findings: t.toolFindings,
				...(t.guest ? { guest: true } : {}),
			});
		}
		return finish({ nodes, findings, latestById, plan });
	}

	// PASS 2 — ONE node at a time.
	let halted = null;
	for (const t of todo) {
		const { name, tools, work, toolFindings } = t;
		const rec = { node: name, work, findings: toolFindings };
		nodes.push(rec);

		if (t.guest) {
			rec.guest = true;
			if (deadline !== null && now() >= deadline) {
				rec.status = 'deferred';
				rec.reason = 'out of time budget; not started (the next run picks it up)';
				log(`── ${name}  [deferred] ${rec.reason}`);
				continue;
			}
			await recheckGuest(name, rec, deps, finding, log);
			continue;
		}

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

	return finish({ nodes, findings, latestById, plan });
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

/**
 * A guest's check-only recheck (#17). Reached and recorded is `rechecked`, even
 * when bootcamp exits 1 on a finding of its own: the record moved, so the turn is
 * spent. Not reached is `unreachable`. Each label it revoked is a finding of
 * its own, named, because on a guest it withdraws production routing at once.
 */
async function recheckGuest(name, rec, deps, finding, log) {
	const b = await attempt(() => deps.rebootcamp(name));
	const r = b.ok ? (b.value ?? {}) : { ok: false, reason: b.reason };
	if (r.unreachable) {
		rec.status = 'unreachable';
		rec.reason = r.reason ?? 'the probe did not reach the node';
		finding(name, 'unreachable', `guest recheck: ${rec.reason}`);
		log(`── ${name}  [UNREACHABLE] guest recheck: ${rec.reason}`);
		return;
	}
	if (!r.recorded) {
		rec.status = 'finding';
		rec.rebootcamp = r.reason ?? 'failed';
		finding(name, 'rebootcamp-failed', `bootcamp did not re-record this guest: ${rec.rebootcamp}`);
		log(`── ${name}  [FINDING] guest recheck failed: ${rec.rebootcamp}`);
		return;
	}
	await attempt(() => deps.markChecked?.(name));
	rec.status = 'rechecked';
	rec.revoked = r.revoked ?? [];
	rec.cleared = r.cleared ?? [];
	for (const v of rec.revoked) {
		finding(
			name,
			'guest-revoked',
			`REVOKED ${v.capability} on a guest — its routing is withdrawn now: ${v.reason ?? 'its probe failed'}`
		);
		log(`── ${name}  REVOKED ${v.capability} (guest): ${v.reason ?? 'its probe failed'}`);
	}
	log(`── ${name}  [rechecked: guest, check-only]`);
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

function finish({ nodes, findings, latestById, plan }) {
	const looked = nodes.filter((n) => n.status !== 'guest' && !n.guest).length;
	if (looked === 0) {
		findings.push({
			node: null,
			kind: 'nothing-looked-at',
			reason: 'no non-guest node was examined; that is not a pass',
		});
	}
	return {
		ok: findings.length === 0,
		plan,
		nodes,
		findings,
		deferred: nodes.filter((n) => n.status === 'deferred').length,
		toolLatest: latestById,
	};
}

// ---------------------------------------------------------------------------
// LIVE DEPENDENCIES. Everything below touches real nodes and is exercised only
// by the CLI (`fleet converge-toolchain --refresh`); the tests inject fixtures.
// ---------------------------------------------------------------------------

/**
 * Job count on a node, or null for "could not look" (treated as busy).
 *
 * EXPORTED (wave 3x, #87) so `benchmark-fleet.mjs`'s cadence mode can ask the
 * same question before committing to a drain, rather than growing a second
 * "is this node busy" prober. No behaviour change — this is the function
 * `createLiveDeps()` already wired into `waitUntilDrained` below.
 */
export function busyCount(node) {
	const res = runOnSync(node, 'pgrep -c -f "[R]unner\\.Worker" || true', {
		as: 'admin',
		timeoutMs: 20_000,
		connectTimeout: 6,
	});
	if (!res.ok) return null;
	const n = parseInt(String(res.out).trim().split('\n')[0], 10);
	return Number.isFinite(n) ? n : null;
}

/** `fleet drain <args>`, as `{ ok, reason? }`. Also the reboot cycle's (lib/reboot-cycle.mjs) one way to drain. */
export function drainCli(args) {
	try {
		execFileSync(process.execPath, [join(SCRIPTS, 'drain-node.mjs'), ...args], {
			encoding: 'utf8',
			timeout: 60_000,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			reason: String(e.stderr || e.message)
				.trim()
				.slice(0, 300),
		};
	}
}

/** Queue pressure from `check-queue-health --json` (its zombie band applies). */
export function judgePressure(doc) {
	if (!doc || typeof doc !== 'object' || typeof doc.queued !== 'number') {
		return { pressured: true, unknown: true, reason: doc?.error ?? 'queue health gave no summary' };
	}
	if (doc.unreadable > 0) {
		return {
			pressured: true,
			unknown: true,
			reason: `${doc.unreadable} repo queue(s) unreadable`,
		};
	}
	if (doc.stranded > 0) {
		return {
			pressured: true,
			reason: `${doc.stranded} stranded run(s) — the fleet is not serving`,
		};
	}
	if (doc.queued > 0 && doc.oldest >= PRESSURE_OLDEST_SECONDS) {
		return {
			pressured: true,
			reason: `${doc.queued} run(s) waiting, oldest ${doc.oldest}s (>= ${PRESSURE_OLDEST_SECONDS}s)`,
		};
	}
	return { pressured: false };
}

/** {@link judgePressure} over a live `check-queue-health --json`. Shared with the reboot cycle. */
export function liveQueuePressure() {
	const r = spawnSync(process.execPath, [join(SCRIPTS, 'check-queue-health.mjs'), '--json'], {
		encoding: 'utf8',
		timeout: 300_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	// Parseable stdout wins over the exit code: a non-zero exit is a finding.
	const out = String(r.stdout ?? '').trim();
	if (!out.startsWith('{')) {
		return {
			pressured: true,
			unknown: true,
			reason: `queue-health produced no JSON (${r.error?.message ?? `exit ${r.status}`})`,
		};
	}
	try {
		return judgePressure(JSON.parse(out));
	} catch (e) {
		return {
			pressured: true,
			unknown: true,
			reason: `queue-health JSON unparseable: ${e.message}`,
		};
	}
}

export function createLiveDeps() {
	const lookup = createReleaseLookup();
	// One read per role (`byRole`): a tool is read as the user whose state it is.
	const probe = (node, tools) => {
		const seen = {};
		for (const [role, group] of byRole(tools)) {
			const res = runOnSync(node, toolProbeScript(group), {
				as: role,
				timeoutMs: 60_000,
				connectTimeout: 8,
			});
			const part = parseToolProbe(res.out ?? '');
			if (!res.ok && !Object.keys(part).length) {
				return {
					ok: false,
					reason: `as ${role}: ${(res.error || 'unreadable').trim().slice(0, 200)}`,
				};
			}
			Object.assign(seen, part);
		}
		return { ok: true, seen };
	};
	const clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
	return {
		// THE ONE RESOLVER (issue #70): the same function bootcamp calls, so the
		// two cannot compute "what to install" differently. minAge only — the
		// cadence moves to the newest release that has cleared the debounce; the
		// doctor adds a tolerance on top of that, and we do not.
		latest: (_id, tool) => resolveInstallTarget(tool, { lookup }),
		detect: (node, tools) => {
			const p = probe(node, tools);
			if (p.ok) return p;
			const defer = deferralFor(node, readDrains());
			return { ...p, expectedDown: defer.deferred };
		},
		reprobe: (node, tools) => probe(node, tools),
		isDrained: (node) => Boolean(readDrains()[node]),
		drain: (node, { kind, reason }) => {
			const r = drainCli([node, '--reason', reason, '--kind', kind]);
			if (!r.ok) throw new Error(r.reason);
			return r;
		},
		undrain: (node) => drainCli([node, '--undo']),
		waitDrained: (node) => waitUntilDrained({ node, busy: busyCount, clock }),
		update: (node, work) =>
			work.map((w) =>
				runWorkItem(
					w,
					(script) =>
						runOnSync(node, script, { as: 'admin', timeoutMs: 600_000, connectTimeout: 8 }),
					{ ciUser: separateCiUser(node) }
				)
			),
		queuePressure: liveQueuePressure,
		lastChecked: (node) => readRecheckLog()[node] ?? 0,
		markChecked: (node) => {
			const log = readRecheckLog();
			log[node] = Date.now();
			writeFileSync(recheckLogPath(), `${JSON.stringify(log, null, 2)}\n`);
		},
		// Re-record the node while the cycle holds it drained, through the cycle's
		// OWN worktree reset to origin/main first (`writerManifestDir`). A refusal
		// comes back as a finding, never a hold.
		rebootcamp: (node) => {
			let dir;
			try {
				dir = writerManifestDir();
			} catch (e) {
				return { ok: false, reason: `could not prepare the writer tree: ${errText(e)}` };
			}
			const r = spawnSync(
				process.execPath,
				[join(SCRIPTS, 'bootcamp.mjs'), '--machine', node, '--write', '--json'],
				{
					encoding: 'utf8',
					timeout: REBOOTCAMP_TIMEOUT_MS,
					// SKIP_GATES: hadoku_site's pre-push hook runs its whole code-gate
					// set (predev, lint, gate-coverage…) and the writer tree has no
					// dev environment, so every automated record was committed and
					// NOT pushed (claw-2, 2026-10-09). The commit is a data record;
					// hadoku_site's CI runs every gate on main after it lands.
					env: { ...process.env, FLEET_MANIFEST_DIR: dir, SKIP_GATES: '1' },
				}
			);
			if (r.error) return { ok: false, reason: errText(r.error) };
			// The document, for a guest's recheck (#17): whether the node was
			// reached, whether the record landed, and what was revoked. No
			// document is a failed run, not proof the node is down.
			let doc = null;
			try {
				doc = JSON.parse(r.stdout);
			} catch {
				doc = null;
			}
			const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ');
			const forNode = (list) => (list ?? []).filter((v) => v.node === node);
			const outcome = {
				unreachable: (doc?.unreachable ?? []).includes(node),
				recorded: doc?.written?.ok === true,
				revoked: forNode(doc?.revocations?.revoked),
				cleared: forNode(doc?.revocations?.cleared),
			};
			if (r.status !== 0) {
				const reason =
					doc === null
						? `exit ${r.status} with no document: ${tail}`
						: (doc.error ?? doc.written?.reason ?? `exit ${r.status}: ${tail}`);
				return { ok: false, reason: String(reason).slice(0, 300), ...outcome };
			}
			return { ok: true, ...outcome };
		},
	};
}

/** Bootcamp probes every capability, cargo-bevy's build included. */
const REBOOTCAMP_TIMEOUT_MS = 30 * 60_000;

/** A node's last recheck from `deps.lastChecked`, or 0 — a non-number is "no record here". */
function lastCheckedMs(deps, name) {
	const v = deps.lastChecked?.(name);
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** node -> epoch ms the cycle last re-bootcamped it, in the state dir (never a checkout). */
function recheckLogPath() {
	return join(stateDir(), 'recheck-log.json');
}
function readRecheckLog() {
	try {
		return JSON.parse(readFileSync(recheckLogPath(), 'utf8'));
	} catch {
		// Absent or unreadable: every node reads as never rechecked, which only
		// makes the cycle MORE eager to recheck — the safe direction.
		return {};
	}
}

/**
 * The manifest dir bootcamp writes through: a detached worktree of the dev
 * repo, owned by this cycle and RESET to a fresh origin/main before every write.
 *
 * Not the dev checkout itself. The writer commits on whatever HEAD it finds and
 * pushes only a fast-forward, and the shared checkout drifts: on 2026-10-09 it
 * sat 18 commits behind, so claw-1's re-recorded `$capabilities` was committed
 * there and NOT pushed — the record the cycle exists to refresh would never
 * have reached main. Not ~/srv either: the writer refuses it (every deploy
 * resets it). A tree of its own, reset each time, always fast-forwards.
 */
function writerManifestDir() {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
	);
	const git = (args) => execFileSync('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
	const repo = join(reposDir(), hubRepo());
	const tree = join(stateDir(), 'site-writer');
	git(['-C', repo, 'fetch', '-q', 'origin', 'main']);
	if (!existsSync(join(tree, '.git'))) {
		git(['-C', repo, 'worktree', 'add', '-q', '--detach', '-f', tree, 'origin/main']);
	} else {
		git(['-C', tree, 'checkout', '-q', '--detach', '-f', 'origin/main']);
		git(['-C', tree, 'clean', '-fdq', '--', 'scripts/admin']);
	}
	return join(tree, 'scripts', 'admin');
}
