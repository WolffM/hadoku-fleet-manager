/**
 * hadoku.fleet — what each fleet pane in herdr reports, and the one snapshot
 * they all read it from.
 *
 * The plugin (`herdr/hadoku-fleet/`) holds one herdr pane per node plus a `ci`
 * and a `fleet` pane, and each reports itself as an AGENT with herdr's
 * semantic state. That state drives herdr's sidebar rollup and notifications,
 * so the mapping below is the whole product: get it wrong and herdr is either
 * a second pager or a quiet one.
 *
 * BLOCKED, NEVER UNKNOWN, FOR "I COULD NOT LOOK"
 * ----------------------------------------------
 * herdr rolls `blocked` up into notifications and leaves `unknown` quiet. An
 * unreadable snapshot, a stale probe, a state this file has never heard of —
 * every one of them is `blocked` with the reason in the message. A quiet pane
 * that is quiet because it could not look is the failure CLAUDE.md names first.
 *
 * NO OPINION ABOUT FLEET STATES
 * -----------------------------
 * Node severity is read from `vocabulary.states[state].kind`, which
 * `fleet-report-types.ts` ships precisely so a reader "stops holding an opinion
 * about the fleet's states". Every threshold is imported from the module that
 * owns it, built, the way `fleet-exec.mjs` imports `isLocalNode` — a copied
 * constant is a second answer that drifts.
 *
 * ONE FETCH FOR ALL PANES
 * -----------------------
 * `GET /fleet` costs mgmt-api ~190 ms of a production event loop (measured
 * 2026-10-20). Ten panes polling it each would spend ~7% of that process on a
 * display, so the panes share `snapshot.json` in the plugin state dir: whoever
 * finds it older than one fast-loop tick takes a lock and refetches. The fleet
 * cannot change faster than the loop that probes it, so a faster read buys
 * nothing.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from 'node:fs';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STALE_STATE_MS } from '../../dist/ci-alerts.js';
import { FAST_LOOP_SECONDS } from '../../dist/fleet-loop.js';
import { BUDGET_ALERT_FRACTION } from '../../dist/gh-budget.js';
import { TICK_INTERVAL_MS } from '../../dist/runner-health.js';

/**
 * The herdr states this plugin reports, and only these two.
 *
 * `unknown` is absent because herdr keeps it quiet. `working` is absent because
 * herdr toasts and plays its "finished" sound on every working -> idle
 * transition, and a claw makes that transition dozens of times an hour: the
 * one signal worth hearing would drown. With two states herdr speaks exactly
 * twice — `blocked` (needs input) when something breaks, and `done` when a
 * blocked pane returns to idle, which is a recovery. Busy is in the message.
 */
export const STATES = Object.freeze(['blocked', 'idle']);

/** Refetch once the snapshot is older than one probe tick. */
export const SNAPSHOT_REFRESH_MS = FAST_LOOP_SECONDS * 1000;

/**
 * A probe or snapshot older than three ticks is not current. Three, not one,
 * so a single slow tick or a lost lock race does not page; past that, nothing
 * is refreshing and the data on screen is history.
 */
export const PROBE_STALE_MS = 3 * FAST_LOOP_SECONDS * 1000;

/** runner-health computes `starved` and the queue figures; it ticks every TICK_INTERVAL_MS. */
export const HEALTH_STALE_MS = 2.5 * TICK_INTERVAL_MS;

/** A lock older than this belongs to a fetcher that died holding it. */
export const LOCK_STALE_MS = 30_000;

/** Two reads, the reason carried — CLAUDE.md's READ_ATTEMPTS rule. */
export const READ_ATTEMPTS = 2;

const ageMin = (ms) => Math.round(ms / 60_000);

const blocked = (message, detail = []) => ({ state: 'blocked', message, detail });

/**
 * Is the snapshot itself fit to judge from? Returns a `blocked` verdict when it
 * is not, `null` when it is. Every classifier asks this first, so an unreadable
 * fleet turns EVERY pane blocked — a node pane showing last hour's `idle`
 * because the fetch broke would be a lie with a green light on it.
 */
export function snapshotVerdict(snap, now) {
	if (!snap) return blocked('no snapshot yet: the first fetch has not completed');
	if (snap.error) return blocked(`could not read mgmt-api: ${snap.error}`);
	const age = now - Date.parse(snap.fetchedAt);
	if (!(age <= PROBE_STALE_MS)) {
		return blocked(`snapshot is ${ageMin(age)}m old: nothing is refreshing it`);
	}
	if (!snap.fleet?.success) return blocked('GET /fleet answered without success');
	return null;
}

/**
 * One node's pane. `kind` comes from the server's own vocabulary: `fault`,
 * `degraded` and `unknown` page; `ok` and `reserve` do not.
 */
export function classifyNode(snap, name, now) {
	const bad = snapshotVerdict(snap, now);
	if (bad) return bad;
	const report = snap.fleet;
	const probedAge = now - Date.parse(report.probedAt ?? '');
	if (!(probedAge <= PROBE_STALE_MS)) {
		return blocked(
			report.probedAt
				? `fast-loop probe is ${ageMin(probedAge)}m old`
				: 'the fast loop has not probed yet'
		);
	}
	const m = (report.machines ?? []).find((x) => x.name === name);
	if (!m) return blocked(`${name} is not in the /fleet roster`);
	const vocab = report.vocabulary?.states?.[m.state];
	const detail = [
		`state      ${m.state}${vocab ? ` (${vocab.kind}): ${vocab.description}` : ''}`,
		`jobs       ${m.workers ?? '?'} running, admission ${m.admissionFree ?? '?'}/${m.admissionCapacity ?? '?'} free`,
	];
	if (m.admissionRefusal) detail.push(`refusing   ${m.admissionRefusal.reason}`);
	if (!vocab) return blocked(`state "${m.state}" is not in the server's vocabulary`, detail);
	if (m.starved) return blocked('starved: memory refusals while other nodes take work', detail);
	// fault, degraded, unknown — and any kind added later — page.
	if (vocab.kind !== 'ok' && vocab.kind !== 'reserve') {
		return blocked(`${m.state}: ${vocab.description}`, detail);
	}
	const busy = m.workers > 0 ? `, ${m.workers} job${m.workers > 1 ? 's' : ''} running` : '';
	return { state: 'idle', message: `${m.state}${busy}`, detail };
}

/**
 * Red by ci-alerts' reading of a STORED row (`wasFailure` in `decideCiAlert`):
 * any conclusion that is not `success`. Cancelled and skipped runs are never
 * stored, so they cannot turn a row red here either. `herdr-fleet.test.mjs`
 * checks the two agree on every conclusion GitHub documents.
 */
export const isRedConclusion = (c) => c !== null && c !== 'success';

/**
 * The watched workflows, as the alerter last decided from them. A row that was
 * never polled, or that the poll has not reached within ci-alerts' own
 * STALE_STATE_MS, is unread — not green.
 */
export function classifyCi(snap, now) {
	const bad = snapshotVerdict(snap, now);
	if (bad) return bad;
	const ci = snap.ciState;
	if (!ci?.success || !Array.isArray(ci.workflows))
		return blocked('GET /fleet/ci-state did not answer');
	if (ci.workflows.length === 0) return blocked('ci-state lists zero watched workflows');
	const red = ci.workflows.filter((w) => isRedConclusion(w.conclusion));
	const unread = ci.workflows.filter(
		(w) => w.conclusion === null || !(now - Date.parse(w.lastSeen ?? '') <= STALE_STATE_MS)
	);
	const detail = [
		...red.map((w) => `red      ${w.label} (${w.conclusion})`),
		...unread.map((w) => `unread   ${w.label} (last seen ${w.lastSeen ?? 'never'})`),
	];
	if (red.length || unread.length) {
		const parts = [];
		if (red.length)
			parts.push(`${red.length} red: ${red[0].label}${red.length > 1 ? ', ...' : ''}`);
		if (unread.length) parts.push(`${unread.length} unread`);
		return blocked(parts.join('; '), detail);
	}
	return { state: 'idle', message: `${ci.workflows.length} workflows green`, detail };
}

/**
 * Fleet-level health that belongs to no single node: the GitHub budget (paged
 * by gh-budget below BUDGET_ALERT_FRACTION), whether runner-health is still
 * ticking (it computes `starved`), and whether every node in the roster has a
 * pane. A node that joins after the panes were opened would otherwise be
 * absent from herdr — the zero-repo shape, one node wide.
 */
export function classifyFleet(snap, now, panedNodes, panedPm2 = null) {
	const bad = snapshotVerdict(snap, now);
	if (bad) return bad;
	const report = snap.fleet;
	const problems = [];
	const detail = [];
	const healthAge = now - Date.parse(report.healthAt ?? '');
	if (!(healthAge <= HEALTH_STALE_MS)) {
		problems.push(
			report.healthAt ? `runner-health ${ageMin(healthAge)}m stale` : 'runner-health never ran'
		);
	}
	for (const b of report.githubBudget ?? []) {
		detail.push(`budget   ${b.token} ${b.resource}: ${b.remaining}/${b.limit}`);
		if (b.expired) problems.push(`budget window for ${b.token} expired unread`);
		else if (b.fractionLeft < BUDGET_ALERT_FRACTION) {
			problems.push(`GitHub budget ${Math.floor(b.fractionLeft * 100)}% left`);
		}
	}
	if (!report.githubBudget?.length) problems.push('no GitHub budget reading');
	const roster = (report.machines ?? []).map((m) => m.name);
	const missing = roster.filter((n) => !panedNodes.includes(n));
	const gone = panedNodes.filter((n) => !roster.includes(n));
	if (missing.length) problems.push(`no pane for ${missing.join(', ')}: re-run hadoku.fleet.open`);
	// pm2 hosts get the same coverage check: a host declared after the panes
	// were opened would otherwise have no pane and say nothing.
	if (snap.pm2?.error) problems.push(`pm2: ${snap.pm2.error}`);
	const pm2Hosts = Object.keys(snap.pm2?.hosts ?? {});
	const missingPm2 = panedPm2 ? pm2Hosts.filter((h) => !panedPm2.includes(h)) : [];
	if (missingPm2.length)
		problems.push(`no pm2 pane for ${missingPm2.join(', ')}: re-run hadoku.fleet.open`);
	if (gone.length) detail.push(`left     ${gone.join(', ')} (pane kept, reads blocked)`);
	const f = report.fleet ?? {};
	detail.push(
		`queue    ${f.queuedNow ?? '?'} queued (oldest ${f.oldestQueuedMin ?? '?'}m), ${f.runningNow ?? '?'} running, ${f.hung ?? '?'} hung`
	);
	if (problems.length) return blocked(problems.join('; '), detail);
	return { state: 'idle', message: `${roster.length} nodes, budget ok`, detail };
}

/** The capability bootcamp awards a node that can host pm2 services. */
export const PM2_CAPABLE = 'pm2-capable';

const ageH = (ms) => {
	if (ms < 3_600_000) return `${Math.max(0, Math.round(ms / 60_000))}m`;
	if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
};

/**
 * One pm2 host's pane: does what runs there match what the deployed config
 * places there?
 *
 * Blocked when the host cannot be read, has not earned `pm2-capable`, is
 * missing an enabled service placed on it, or runs one placed ELSEWHERE — the
 * double run, which for a single-writer app means two processes on one state
 * dir. Not the `pm2-host` label: that one means "this is the HUB" and is false
 * on every other pm2 host by design.
 *
 * Processes the deploy config does not place (a game server, a utility) are
 * listed and never judged; nothing here knows whether `valheim` should be up.
 */
export function classifyPm2Host(snap, host, now) {
	const bad = snapshotVerdict(snap, now);
	if (bad) return bad;
	const p = snap.pm2;
	if (!p) return blocked('pm2 state was not read');
	if (p.error) return blocked(p.error);
	const h = p.hosts?.[host];
	if (!h) return blocked(`${host} is not in pm2-hosts.json`);
	if (h.error || !Array.isArray(h.procs))
		return blocked(`could not read pm2 on ${host}: ${h.error ?? 'no listing'}`);
	const problems = [];
	const machine = (snap.fleet.machines ?? []).find((m) => m.name === host);
	if (!machine) problems.push(`${host} is not in the /fleet roster`);
	else if (!(machine.capabilities?.earned ?? []).includes(PM2_CAPABLE)) {
		problems.push(`${host} has not earned ${PM2_CAPABLE}`);
	}
	const enabled = p.services.filter((s) => s.enabled);
	const here = enabled.filter((s) => s.host === host);
	const proc = (name) => h.procs.find((x) => x.name === name);
	const detail = [];
	for (const s of here) {
		const x = proc(s.pm2);
		if (!x) problems.push(`${s.name} is not running here`);
		else if (x.status !== 'online') problems.push(`${s.name} is ${x.status}`);
		const up = x?.since ? ageH(now - x.since) : '-';
		detail.push(
			`${(x?.status ?? 'absent').padEnd(8)} ${s.name.padEnd(18)} up ${up.padEnd(4)} restarts ${x?.restarts ?? '-'}`
		);
	}
	for (const s of enabled.filter((x) => x.host !== host)) {
		const x = proc(s.pm2);
		if (x?.status === 'online')
			problems.push(`${s.name} is online here AND placed on ${s.host}: a double run`);
	}
	// `enabled: false` is "not deployed by this path" (mgmt-api deploys itself),
	// not "should be down", so those are shown beside the unplaced ones.
	const disabled = p.services.filter((s) => !s.enabled && s.host === host);
	const placed = new Set(p.services.map((s) => s.pm2));
	const unmanaged = h.procs.filter((x) => !placed.has(x.name));
	const shown = [
		...disabled.map((s) => [
			proc(s.pm2)?.status ?? 'absent',
			`${s.name} (disabled in deploy-config)`,
		]),
		...unmanaged.map((x) => [x.status, x.name]),
	];
	if (shown.length) {
		detail.push('', 'not judged:');
		for (const [status, name] of shown) detail.push(`${String(status).padEnd(8)} ${name}`);
	}
	if (problems.length) return blocked(problems.join('; '), detail);
	const extra = unmanaged.length ? `, ${unmanaged.length} unmanaged` : '';
	return { state: 'idle', message: `${here.length} placed services online${extra}`, detail };
}

/** Which classifier a pane target uses. `node:<name>`, `ci` or `fleet`. */
export function classify(target, snap, now, panedNodes = [], panedPm2 = null) {
	if (target === 'ci') return classifyCi(snap, now);
	if (target === 'fleet') return classifyFleet(snap, now, panedNodes, panedPm2);
	if (target.startsWith('pm2:')) return classifyPm2Host(snap, target.slice(4), now);
	if (target.startsWith('node:')) return classifyNode(snap, target.slice(5), now);
	return blocked(`unknown pane target "${target}"`);
}

/** The herdr agent label a target reports under. */
export const agentLabel = (target) => (target.startsWith('node:') ? target.slice(5) : target);

/** GET a JSON document, `READ_ATTEMPTS` tries, the last reason kept. */
async function getJson(url, { fetchImpl, sleep, timeoutMs }) {
	let reason = null;
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		try {
			const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
			if (res.ok) return { body: await res.json(), reason: null };
			reason = `${url} answered HTTP ${res.status}`;
		} catch (err) {
			reason = `${url}: ${err?.cause?.code ?? err?.name ?? 'error'} ${err?.message ?? err}`;
		}
		if (attempt < READ_ATTEMPTS) await sleep(5_000);
	}
	return { body: null, reason };
}

/**
 * NO DEFAULT pm2 reader, on purpose. The real one ssh's to every pm2 host, and
 * a test that forgot to inject a fake would reach claw-4 from the suite — the
 * shape of every "fixture HOME is not isolation" incident this repo has had.
 * Production passes `readPm2` from `herdr-pm2.mjs`; a test passes a fake; a
 * caller that passes neither fails here, loudly, before any host is asked.
 */
function noPm2Reader() {
	throw new Error('fetchSnapshot needs a pm2Reader: readPm2 in production, a fake in tests');
}

/** Fetch both documents into one snapshot. Never throws on a read failure: that IS a snapshot. */
export async function fetchSnapshot(
	apiBase,
	{
		fetchImpl = fetch,
		sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
		now = Date.now,
		pm2Reader = noPm2Reader,
	} = {}
) {
	const opts = { fetchImpl, sleep, timeoutMs: 10_000 };
	const [fleet, ciState, pm2] = await Promise.all([
		getJson(`${apiBase}/fleet`, opts),
		getJson(`${apiBase}/fleet/ci-state`, opts),
		pm2Reader(),
	]);
	const error = fleet.reason ?? ciState.reason;
	// A pm2 failure stays inside `pm2`: it blocks the pm2 panes, not the node
	// and CI panes whose data arrived fine.
	return {
		fetchedAt: new Date(now()).toISOString(),
		error,
		fleet: fleet.body,
		ciState: ciState.body,
		pm2,
	};
}

export function readSnapshot(stateDir) {
	try {
		return JSON.parse(readFileSync(join(stateDir, 'snapshot.json'), 'utf8'));
	} catch (err) {
		if (err?.code === 'ENOENT') return null;
		return {
			fetchedAt: new Date().toISOString(),
			error: `snapshot.json unreadable: ${err.message}`,
		};
	}
}

/**
 * The shared snapshot, refreshed by whichever pane gets the lock first.
 *
 * Losing the race is not an error: the loser reads what is there and the
 * staleness check in `snapshotVerdict` turns it blocked if nobody ever wins.
 * The write is tmp + rename so a reader never parses half a file.
 */
export async function loadSnapshot(stateDir, apiBase, deps = {}) {
	const now = deps.now ?? Date.now;
	mkdirSync(stateDir, { recursive: true });
	const current = readSnapshot(stateDir);
	if (current && !current.error && now() - Date.parse(current.fetchedAt) < SNAPSHOT_REFRESH_MS) {
		return current;
	}
	const lock = join(stateDir, 'snapshot.lock');
	let fd;
	try {
		fd = openSync(lock, 'wx');
	} catch (err) {
		if (err?.code !== 'EEXIST') throw err;
		if (now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
		return current;
	}
	try {
		const snap = await fetchSnapshot(apiBase, deps);
		const tmp = join(stateDir, `snapshot.json.${process.pid}`);
		writeFileSync(tmp, JSON.stringify(snap));
		renameSync(tmp, join(stateDir, 'snapshot.json'));
		return snap;
	} finally {
		closeSync(fd);
		unlinkSync(lock);
	}
}
