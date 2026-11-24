/**
 * DID JOINING THE POOL COST THE NODE? (hadoku-fleet-manager#156, item 4).
 *
 * Admission (disk-bench, disk-node-impact) is a test on a quiet node. What a
 * zone does to the node's real work shows only after it joins, under real CI
 * and real tenant traffic. So for every active zone, `fleet storage-pool`
 * compares the node's week BEFORE the join with its week AFTER:
 *
 *   job time   for each job kind (repo + job name) with JOIN_MIN_RUNS runs on
 *              both sides, the median runSec after over before; the node's
 *              ratio is the median over those kinds, so a node that simply
 *              ran different work that week is not read as slower.
 *   pressure   the median `io some` and `cpu some` (perf samples, every five
 *              minutes) after, against before, in percentage points.
 *
 * A ratio over JOIN_JOB_RATIO, or pressure up by more than JOIN_PSI_POINTS,
 * is a WARNING in the gate, never a page (advisory first: a new check starts
 * quiet). A zone that joined less than a week ago, or a side without enough
 * runs, is `known` with what it has: "not enough to compare" is never "no
 * regression".
 *
 * The join time is the zone's `at` in garage-layout.json, written when the
 * zone was declared. PURE: storage-pool.mjs reads the files.
 */

export const JOIN_WINDOW_DAYS = 7;
/** Runs of one job kind needed on each side before the kind is compared. */
export const JOIN_MIN_RUNS = 3;
/** Kinds compared before a node's ratio means anything. */
export const JOIN_MIN_KINDS = 3;
/**
 * Median job-time ratio after/before above which the join is suspected.
 * 1.15 is a FIRST number, not yet measured against a join: the check is a
 * warning only, and its readings over the pilot zones' first weeks are what
 * set it. Change it with those readings named here.
 */
export const JOIN_JOB_RATIO = 1.15;
/** Points of median `some` pressure the week after may add. */
export const JOIN_PSI_POINTS = 5;
/**
 * Days after the join before a regression is said. On 2026-11-24, 0.3 days
 * after claw-9's WD joined, three job kinds read 1.83x; a third of a day of
 * one node's jobs is the hour's mix, not the join.
 */
export const JOIN_MIN_AFTER_DAYS = 2;

const DAY = 86_400_000;

const median = (xs) => {
	const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
	if (!a.length) return null;
	const m = Math.floor(a.length / 2);
	return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);

/** PURE. The fleet node a job-history row ran on, or null. */
export function nodeOfRunner(runner, nodes) {
	const r = String(runner ?? '');
	const byLength = [...nodes].sort((a, b) => b.length - a.length);
	return (
		byLength.find(
			(n) =>
				r === n || r.startsWith(`jit-${n}-`) || r.startsWith(`warm-${n}-`) || r.startsWith(`${n}-`)
		) ?? null
	);
}

/**
 * PURE. One zone's comparison.
 *
 * @param {{ node: string, joinedMs: number, nowMs: number,
 *   jobs: { repo: string, name: string, runSec: number, startedAt: string, conclusion?: string }[],
 *   perf: { at: string, psi?: { ioSome?: number, cpuSome?: number } }[] }} a  the node's own rows
 * @returns {{ node: string, status: 'ok'|'regressed'|'known', reason: string, metrics: object }}
 */
export function compareJoin({ node, joinedMs, nowMs, jobs, perf }) {
	const before = [joinedMs - JOIN_WINDOW_DAYS * DAY, joinedMs];
	const after = [joinedMs, Math.min(nowMs, joinedMs + JOIN_WINDOW_DAYS * DAY)];
	const inside = (ms, [a, b]) => ms >= a && ms < b;
	const kinds = new Map();
	for (const j of jobs) {
		if (j.conclusion && j.conclusion !== 'success') continue;
		const t = Date.parse(j.startedAt);
		const side = inside(t, before) ? 0 : inside(t, after) ? 1 : -1;
		if (side < 0 || !Number.isFinite(j.runSec)) continue;
		const k = `${j.repo}::${j.name}`;
		if (!kinds.has(k)) kinds.set(k, [[], []]);
		kinds.get(k)[side].push(j.runSec);
	}
	const ratios = [...kinds.values()]
		.filter(([b, a]) => b.length >= JOIN_MIN_RUNS && a.length >= JOIN_MIN_RUNS)
		.map(([b, a]) => median(a) / median(b))
		.filter((x) => Number.isFinite(x) && x > 0);
	const psi = (side, key) =>
		median(
			perf
				.filter((p) => inside(Date.parse(p.at), side))
				.map((p) => p.psi?.[key])
				.filter(Number.isFinite)
		);
	const metrics = {
		joinedAt: new Date(joinedMs).toISOString(),
		afterDays: r2((after[1] - after[0]) / DAY),
		kindsCompared: ratios.length,
		jobRatio: r2(median(ratios)),
		ioBefore: r2(psi(before, 'ioSome')),
		ioAfter: r2(psi(after, 'ioSome')),
		cpuBefore: r2(psi(before, 'cpuSome')),
		cpuAfter: r2(psi(after, 'cpuSome')),
	};
	const partial = nowMs - joinedMs < JOIN_WINDOW_DAYS * DAY;
	const findings = [];
	if (
		metrics.jobRatio !== null &&
		ratios.length >= JOIN_MIN_KINDS &&
		metrics.jobRatio > JOIN_JOB_RATIO
	)
		findings.push(
			`CI jobs run ${metrics.jobRatio}x their week-before time (median over ${ratios.length} job kinds; > ${JOIN_JOB_RATIO}x)`
		);
	for (const [k, b, a] of [
		['IO', metrics.ioBefore, metrics.ioAfter],
		['CPU', metrics.cpuBefore, metrics.cpuAfter],
	])
		if (b !== null && a !== null && a - b > JOIN_PSI_POINTS)
			findings.push(
				`${k} pressure median ${a}% vs ${b}% the week before (> +${JOIN_PSI_POINTS} points)`
			);
	const window = `${metrics.afterDays} of ${JOIN_WINDOW_DAYS} days since the join (${metrics.joinedAt})`;
	const early = metrics.afterDays < JOIN_MIN_AFTER_DAYS;
	if (findings.length && early)
		return {
			node,
			status: 'known',
			reason: `${node}: too early to judge the join (${window}; needs ${JOIN_MIN_AFTER_DAYS}); so far: ${findings.join('; ')}`,
			metrics,
		};
	if (findings.length)
		return {
			node,
			status: 'regressed',
			reason: `${node} after joining the pool: ${findings.join('; ')}; ${window}`,
			metrics,
		};
	const thin = [];
	if (ratios.length < JOIN_MIN_KINDS)
		thin.push(
			`${ratios.length} job kind(s) with ${JOIN_MIN_RUNS}+ runs on both sides, needs ${JOIN_MIN_KINDS}`
		);
	if (metrics.ioBefore === null || metrics.ioAfter === null)
		thin.push('no perf samples on one side');
	if (partial || thin.length)
		return {
			node,
			status: 'known',
			reason: `${node}: before/after the join not judged yet: ${[partial ? window : '', ...thin].filter(Boolean).join('; ')}`,
			metrics,
		};
	return {
		node,
		status: 'ok',
		reason: `${node}: jobs ${metrics.jobRatio}x, IO ${metrics.ioBefore}→${metrics.ioAfter}%, CPU ${metrics.cpuBefore}→${metrics.cpuAfter}% across the join`,
		metrics,
	};
}

/**
 * PURE. Every active declared zone's comparison.
 * @param {{ declared: object, nodes: string[], nowMs: number, jobs: object[], perf: object[] }} a
 */
export function joinImpact({ declared, nodes, nowMs, jobs, perf }) {
	const out = [];
	for (const [node, z] of Object.entries(declared?.zones ?? {}).sort()) {
		if (z.state !== 'active') continue;
		const joinedMs = Date.parse(z.at ?? '');
		if (!Number.isFinite(joinedMs)) {
			out.push({
				node,
				status: 'known',
				reason: `${node}: the declaration has no join time`,
				metrics: {},
			});
			continue;
		}
		out.push(
			compareJoin({
				node,
				joinedMs,
				nowMs,
				jobs: jobs.filter((j) => nodeOfRunner(j.runner, nodes) === node),
				perf: perf.filter((p) => p.node === node),
			})
		);
	}
	return out;
}
