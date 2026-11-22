/**
 * kind-failures — which job KINDS fail on one node far more than on the rest
 * of the fleet (hadoku-fleet-manager#129 point 3, operator 2026-11-21:
 * "repeated failure of expected work is a placement bug").
 *
 * WHY NOT "N FAILURES ON A NODE". Measured over job-history 11-07..11-22, the
 * jobs that failed on one node and passed on another for the same sha were
 * mostly hadoku-cardtable's Forge shards, and they failed on EVERY node that
 * ran them (claw-4, 8, 9, 10 and hokon): a flaky suite, not a node. A plain
 * count would take jdk21 work off the whole fleet. So a kind is judged against
 * ITSELF elsewhere: the node's failure count is tested against the binomial
 * tail of the kind's failure rate on every other node, and only an outlier
 * beyond P_MAX, with at least MIN_FAILURES failures and RATE_MULTIPLE times
 * the others' rate, is reported. Over the same window that names claw-5's
 * hadoku-watchparty unit-tests (4 of 8 against 1.1% elsewhere) and
 * hadoku_site lint (3 of 40 against 0.2%), and nothing on the Forge shards.
 *
 * PURE: records in, verdicts out. What the fleet does with a verdict (hold the
 * kind for another node, as `slowKind` does for a slow one, or withhold a
 * capability label through bootcamp) is a later step; until then the verdicts
 * are SHADOW, logged by the speed-model rebuild and acted on by nothing
 * (AGENTS.md "A new gate starts quiet").
 */
import type { JobRecord } from '../job-history-store.js';
import { jobKind } from '../lib/job-kind.js';

/** The same window the speed model reads, and job-history keeps. */
export const KIND_FAILURE_WINDOW_DAYS = 14;
/** Fewer failures than this is never a placement verdict, however rare elsewhere. */
export const MIN_FAILURES = 3;
/** Runs of the kind on OTHER nodes needed before "its rate elsewhere" means anything. */
export const MIN_OTHER_RUNS = 10;
/** The binomial tail a node's count must fall under: one in a thousand. */
export const P_MAX = 1e-3;
/** The node's own rate must also be at least this multiple of the others'. */
export const RATE_MULTIPLE = 3;
/**
 * The rate floor used for a kind that never failed elsewhere: zero failures in
 * n runs is consistent with a true rate near 1/n, not with zero, so a single
 * failure on a node never reads as an infinite outlier.
 */
const ZERO_RATE_FLOOR = (otherRuns: number) => 1 / (otherRuns + 1);

export interface KindFailure {
	node: string;
	repo: string;
	/** The job KIND (`jobKind`), so matrix shards share one verdict. */
	job: string;
	runs: number;
	failures: number;
	otherRuns: number;
	otherFailures: number;
	/** P(X >= failures) for X ~ Binomial(runs, the others' rate). */
	p: number;
}

const FAILED = new Set(['failure', 'timed_out']);
const JUDGED = new Set(['success', 'failure', 'timed_out']);

/** P(X >= k) for X ~ Binomial(n, p), summed in log space so n in the hundreds is exact enough. */
export function binomialTail(n: number, k: number, p: number): number {
	if (k <= 0) return 1;
	if (p <= 0) return 0;
	if (p >= 1) return 1;
	let logC = 0;
	for (let i = 1; i <= k; i++) logC += Math.log(n - k + i) - Math.log(i);
	let sum = 0;
	let term = Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p));
	for (let i = k; i <= n; i++) {
		sum += term;
		term *= ((n - i) / (i + 1)) * (p / (1 - p));
	}
	return Math.min(1, sum);
}

/**
 * PURE. Every (node, kind) whose failures are an outlier against the same kind
 * on the other nodes. A record whose node cannot be attributed (`nodeOf`
 * returns null or an empty name) is skipped; a cancelled run is no verdict on
 * the node and is not counted either way.
 */
export function failingKinds(
	records: readonly JobRecord[],
	opts: { nowMs: number; nodeOf: (r: JobRecord) => string | null }
): KindFailure[] {
	const since = opts.nowMs - KIND_FAILURE_WINDOW_DAYS * 86_400_000;
	const cells = new Map<
		string,
		{ node: string; repo: string; job: string; runs: number; failures: number }
	>();
	const kinds = new Map<string, { runs: number; failures: number }>();
	for (const r of records) {
		if (!JUDGED.has(r.conclusion ?? '')) continue;
		const at = Date.parse(r.startedAt);
		if (!Number.isFinite(at) || at < since) continue;
		const node = opts.nodeOf(r);
		if (!node) continue;
		const job = jobKind(r.name);
		const kindKey = `${r.repo}\u0000${job}`;
		const key = `${node}\u0000${kindKey}`;
		const failed = FAILED.has(r.conclusion ?? '') ? 1 : 0;
		const c = cells.get(key) ?? { node, repo: r.repo, job, runs: 0, failures: 0 };
		c.runs++;
		c.failures += failed;
		cells.set(key, c);
		const k = kinds.get(kindKey) ?? { runs: 0, failures: 0 };
		k.runs++;
		k.failures += failed;
		kinds.set(kindKey, k);
	}
	const out: KindFailure[] = [];
	for (const c of cells.values()) {
		if (c.failures < MIN_FAILURES) continue;
		const all = kinds.get(`${c.repo}\u0000${c.job}`);
		if (!all) continue;
		const otherRuns = all.runs - c.runs;
		const otherFailures = all.failures - c.failures;
		if (otherRuns < MIN_OTHER_RUNS) continue;
		const rate = otherFailures ? otherFailures / otherRuns : ZERO_RATE_FLOOR(otherRuns);
		if (c.failures / c.runs < RATE_MULTIPLE * rate) continue;
		const p = binomialTail(c.runs, c.failures, rate);
		if (p >= P_MAX) continue;
		out.push({ ...c, otherRuns, otherFailures, p });
	}
	return out.sort((a, b) => a.p - b.p || a.node.localeCompare(b.node));
}

/** For logs: one verdict, short. */
export function describeKindFailure(k: KindFailure): string {
	const others = k.otherRuns ? ((100 * k.otherFailures) / k.otherRuns).toFixed(1) : '0';
	return `${k.node} ${k.repo.split('/').pop()}/${k.job} failed ${k.failures}/${k.runs} vs ${others}% on ${k.otherRuns} run(s) elsewhere (p=${k.p.toExponential(1)})`;
}
