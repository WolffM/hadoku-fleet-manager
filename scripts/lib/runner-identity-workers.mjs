/**
 * runner-identity-workers — a `Runner.Worker` on a node that GitHub does not
 * count as a running job (fleet-manager-private#138).
 *
 * THE GAP. On 2026-11-10 `warm-claw-4-hadoku-cardtable`'s worker ran for 13 h
 * 28 m after GitHub had handed its job to another runner. The tree held 13.4 of
 * runners.slice's 13.5 GB, so the node admitted nothing, and no check saw it:
 *
 *   - hung-job recovery counts runs GitHub still shows in progress. This run
 *     was `completed`.
 *   - `fleet identity` asked "does every registration have a live listener",
 *     and it did.
 *   - every job counter on the node counted the worker as one busy slot, which
 *     is what a real job looks like.
 *
 * Every existing rule starts from a registration or a unit. This one starts
 * from the WORKER and takes one fact from each side: the node says a job is
 * running in this runner's directory; GitHub's listing, read AFTER the probe,
 * says that runner is not busy, or lists no such runner.
 *
 * TWO LOOKS, because one cannot tell an orphan from a job that ended between
 * the probe and the listing. A worker exits within seconds of its job being
 * reported complete, so the same pid still alive WORKER_CONFIRM_DELAY_MS later,
 * with the registration still not busy on a fresh listing, is not that race.
 *
 * ADVISORY (2026-11-16). `orphans` is reported, printed and appended to
 * WORKER_LOOK_FILE; it is in neither the GateDoc nor the exit code. A new check
 * starts quiet (AGENTS.md): promoting it needs the count of real catches and
 * false positives from that ledger, in the commit that promotes it. `unjudged`
 * is this check's "could not look" and stays advisory with it.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Longer than a finished job's worker takes to exit; short enough to wait for in a daily gate. */
export const WORKER_CONFIRM_DELAY_MS = 60_000;

/** One row per run, appended. The record the promotion decision is counted from. */
export const WORKER_LOOK_FILE = 'worker-orphans.jsonl';

/** The `WORKER` lines of one node's probe. */
export function parseWorkers(node, out) {
	const workers = [];
	for (const line of String(out).split('\n')) {
		const p = line.trim().split(/\s+/);
		if (p[0] !== 'WORKER' || p.length < 6) continue;
		const [, dir, repo, name, age, pid] = p;
		const ageSec = Number(age);
		workers.push({
			node,
			dir,
			repo,
			name,
			ageSec: age !== '?' && Number.isFinite(ageSec) ? ageSec : null,
			pid,
		});
	}
	return workers;
}

/**
 * PURE. One worker against its repo's listing.
 *
 * @param {{dir: string, repo: string, name: string}} worker
 * @param {{ok: true, runners: {name: string, status?: string, busy?: boolean}[]} |
 *   {ok: false, reason: string}} listing
 * @returns {{verdict: 'busy'|'suspect'|'unjudged', why: string}}
 */
export function judgeWorker(worker, listing) {
	if (worker.name === '?' || worker.repo === '?')
		return { verdict: 'unjudged', why: `no readable .runner in ${worker.dir}` };
	if (!listing.ok) return { verdict: 'unjudged', why: listing.reason };
	const reg = listing.runners.find((r) => r.name === worker.name);
	if (reg?.busy === true) return { verdict: 'busy', why: 'GitHub reports the runner busy' };
	return {
		verdict: 'suspect',
		why: reg
			? `GitHub lists ${worker.name} as ${reg.status ?? 'unknown'} and not busy`
			: `GitHub lists no runner named ${worker.name} in ${worker.repo}`,
	};
}

/**
 * A repo's WHOLE runner listing, or why not. A listing that holds fewer rows
 * than `total_count` is refused: a runner missing from a truncated page would
 * read as a runner GitHub does not have.
 *
 * @param {(path: string) => Promise<{ok: boolean, data?: any, reason?: string}>} ghOnce
 */
export function listingReader(ghOnce) {
	return async (repo) => {
		const r = await ghOnce(`repos/${repo}/actions/runners?per_page=100`);
		if (!r.ok) return { ok: false, reason: `${repo}: ${r.reason}` };
		const runners = r.data?.runners;
		if (!Array.isArray(runners))
			return { ok: false, reason: `${repo}: gh answered with no \`runners\` array` };
		const total = Number(r.data.total_count);
		if (Number.isFinite(total) && total > runners.length)
			return {
				ok: false,
				reason: `${repo}: the listing holds ${runners.length} of ${total} runners`,
			};
		return { ok: true, runners };
	};
}

/**
 * Both looks. Every worker lands in exactly one of `busy` (a count), `orphans`,
 * `cleared` or `unjudged`.
 *
 * @param {{
 *   workers: ReturnType<typeof parseWorkers>,
 *   probeNode: (node: string) => Promise<{ok: boolean, out?: string, error?: string}>,
 *   readListing: (repo: string) => Promise<{ok: boolean, runners?: object[], reason?: string}>,
 *   canonical: (repo: string) => Promise<string>,
 *   sleep: (ms: number) => Promise<unknown>,
 *   delayMs?: number,
 * }} deps
 */
export async function lookForOrphanWorkers({
	workers,
	probeNode,
	readListing,
	canonical,
	sleep,
	delayMs = WORKER_CONFIRM_DELAY_MS,
}) {
	const look = { seen: workers.length, busy: 0, orphans: [], cleared: [], unjudged: [] };
	const suspects = [];
	const first = new Map();
	for (const w of workers) {
		// A .runner keeps the name the repo had when the runner was configured.
		const repo = w.repo === '?' ? w.repo : await canonical(w.repo);
		const worker = { ...w, repo };
		if (repo !== '?' && w.name !== '?' && !first.has(repo))
			first.set(repo, await readListing(repo));
		const j = judgeWorker(worker, first.get(repo) ?? { ok: false, reason: 'no listing read' });
		if (j.verdict === 'busy') look.busy++;
		else if (j.verdict === 'unjudged') look.unjudged.push({ ...worker, why: j.why });
		else suspects.push({ ...worker, firstWhy: j.why });
	}
	if (!suspects.length) return look;

	await sleep(delayMs);
	const reprobed = new Map();
	const second = new Map();
	for (const s of suspects) {
		if (!reprobed.has(s.node)) reprobed.set(s.node, await probeNode(s.node));
		const again = reprobed.get(s.node);
		if (!again.ok) {
			look.unjudged.push({ ...s, why: `second look at ${s.node} failed: ${again.error}` });
			continue;
		}
		const still = parseWorkers(s.node, again.out).find((w) => w.pid === s.pid && w.dir === s.dir);
		if (!still) {
			look.cleared.push({ ...s, outcome: 'the worker exited before the second look' });
			continue;
		}
		if (!second.has(s.repo)) second.set(s.repo, await readListing(s.repo));
		const j = judgeWorker(s, second.get(s.repo));
		if (j.verdict === 'busy')
			look.cleared.push({ ...s, outcome: 'GitHub reports the runner busy on the second look' });
		else if (j.verdict === 'unjudged')
			look.unjudged.push({ ...s, why: `second listing: ${j.why}` });
		else look.orphans.push({ ...s, ageSec: still.ageSec ?? s.ageSec, why: j.why });
	}
	return look;
}

const age = (sec) => (sec === null ? 'age unknown' : `${Math.round(sec / 60)}m old`);

/** One line per orphan, for the report and for whoever stops the unit. */
export function describeOrphan(o) {
	return (
		`${o.node} pid ${o.pid} in ${o.dir} (${o.repo} ${o.name}, ${age(o.ageSec)}): ` +
		`${o.why}, on two looks`
	);
}

export function printWorkerLook(look, log) {
	if (look.orphans.length) {
		log(
			`\nADVISORY — WORKER WITH NO JOB BEHIND IT (${look.orphans.length}): the node runs a job ` +
				'GitHub does not count. It holds its slot and its memory until its unit is stopped.'
		);
		for (const o of look.orphans) log(`  ${describeOrphan(o)}`);
	}
	if (look.unjudged.length) {
		log(`\nadvisory — worker(s) not judged (${look.unjudged.length}):`);
		for (const u of look.unjudged) log(`  ${u.node} pid ${u.pid} in ${u.dir}: ${u.why}`);
	}
	for (const c of look.cleared)
		log(`  · worker ${c.node} pid ${c.pid} (${c.repo} ${c.name}): ${c.outcome}`);
}

/**
 * Append this run to the ledger. `{ok:true}` or `{ok:false, reason}`; a run
 * that saw no worker at all is still a row, so the window's denominator is the
 * number of looks and not the number of surprises.
 */
export function recordWorkerLook(dir, look, at) {
	const path = join(dir, WORKER_LOOK_FILE);
	try {
		mkdirSync(dir, { recursive: true });
		appendFileSync(path, `${JSON.stringify({ v: 1, at, ...look })}\n`);
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: `${path}: ${err.message}` };
	}
}
