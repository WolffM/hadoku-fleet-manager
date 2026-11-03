/**
 * The ppe sweep: the one promotion wake-up no GitHub event provides
 * (docs/planning/ppe-promotion-2026-11-01.md). ppe is this repo's alone
 * (operator, 2026-11-01): today only hadoku-fleet-manager has a `ppe` branch.
 *
 * `.github/workflows/ppe-promote.yml` runs when CI finishes on a `ppe` push,
 * and promotes then if `main` last moved 30+ minutes ago. A burst that ends
 * INSIDE that window leaves a green `ppe` that should promote once it has
 * been quiet for 10 minutes, and no event fires at that moment. This loop is
 * that event: every 5 minutes, ONE GraphQL query reads `ppe` against `main`,
 * and a `ppe` that is ahead, settled and quiet gets a `workflow_dispatch` of
 * the promoter. The promoter (scripts/ppe/promote.mjs) makes the real
 * decision (required checks, cadence, reverts); this only wakes it.
 *
 * DATA-DRIVEN, NOT CONFIGURED. The query covers the covered-repo roster, and a
 * repo without a `ppe` branch is skipped, so nothing here names a repo. That
 * is a property of the code, not a rollout plan.
 *
 * WHY HERE AND NOT A CRON. A 5-minute cron is 12 claw mints an hour for a
 * question whose answer is almost always "not yet". This process already holds
 * a token and a clock, and spends no runner at all.
 *
 * COST, sized as if every call were charged (AGENTS.md): 12 GraphQL queries
 * an hour, each 1 point of the token's SEPARATE 5,000-point GraphQL budget
 * (measured: 1 point with every covered repo aliased in, because no
 * connections are requested). REST: at most one dispatch per settled `ppe` tip
 * per {@link REDISPATCH_MS}, a ceiling of 2 an hour per repo with a `ppe`.
 *
 * NOT A GATE. A failed query logs and dispatches nothing; the promoter still
 * runs on every CI completion.
 */
import { coveredRepos } from './lib/covered-repos.js';
import { withGhCaller } from './gh-budget.js';
import { githubToken, logger } from './host.js';
import { userAgent } from './lib/fleet-config.js';
import { ghFetchRaw } from './lib/github-client.js';
import {
	computeFirstDelayMs,
	createOverlapGuard,
	finishTick,
	scheduleRepeating,
	type Verdict,
} from './lib/job-runner.js';

/** Between passes. Matches `fleet:ppe-sweep`'s registry row. */
export const PPE_SWEEP_MS = 5 * 60_000;
/** The promoter's quiet threshold: a tip younger than this is left to its own CI completion. */
export const PPE_QUIET_MS = 10 * 60_000;
/** The same tip is not woken again sooner than this. */
export const REDISPATCH_MS = 30 * 60_000;
const FIRST_PASS_MIN_MS = 5 * 60_000;
const JOB_NAME = 'fleet:ppe-sweep';
const PROMOTE_WORKFLOW = 'ppe-promote.yml';
const GRAPHQL_URL = 'https://api.github.com/graphql';
/** Rollups worth a wake-up. null (nothing reported) is too: the promoter decides what an untested tip means. */
const SETTLED_GREEN = new Set(['SUCCESS']);

export interface PpeState {
	repo: string;
	/** `ppe`'s tip, or null when the repo has no `ppe` branch (not adopted). */
	ppeSha: string | null;
	/** Commits on `ppe` that `main` lacks. */
	ppeAhead: number;
	/** Commits on `main` that `ppe` lacks: a bot push sync-main-to-ppe has not merged yet. */
	mainAhead: number;
	/** The tip's committer date: when it was made, which a rebase-then-push sets to about push time. */
	tipAtMs: number | null;
	/** GitHub's rollup of every check on the tip (SUCCESS, FAILURE, PENDING, ...), or null when none reported. */
	rollup: string | null;
}

/** One query for every repo, aliased r0..rN. `compare` hangs off `ppe`, so a repo without one asks nothing. */
export function sweepQuery(repos: string[]): string {
	const parts = repos.map((full, i) => {
		const [owner, name] = full.split('/');
		return (
			`r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {` +
			` ppe: ref(qualifiedName: "refs/heads/ppe") {` +
			` target { oid ... on Commit { committedDate statusCheckRollup { state } } }` +
			` compare(headRef: "refs/heads/main") { aheadBy behindBy } } }`
		);
	});
	return `query { ${parts.join(' ')} }`;
}

interface RepoNode {
	ppe: {
		target: { oid: string; committedDate?: string; statusCheckRollup?: { state: string } | null };
		compare: { aheadBy: number; behindBy: number } | null;
	} | null;
}

/**
 * The query's answer per repo. A repo GitHub could not resolve (renamed,
 * deleted) is left out and named in `unreadable`, never read as "no ppe".
 */
export function parseSweep(
	repos: string[],
	data: Record<string, RepoNode | null>
): { states: PpeState[]; unreadable: string[] } {
	const states: PpeState[] = [];
	const unreadable: string[] = [];
	repos.forEach((repo, i) => {
		const node = data[`r${i}`];
		if (!node) return unreadable.push(repo);
		const ppe = node.ppe;
		if (!ppe) {
			states.push({ repo, ppeSha: null, ppeAhead: 0, mainAhead: 0, tipAtMs: null, rollup: null });
			return;
		}
		if (!ppe.compare) return unreadable.push(repo);
		// compare() is `ppe` as base and `main` as head: aheadBy is main's lead.
		states.push({
			repo,
			ppeSha: ppe.target.oid,
			ppeAhead: ppe.compare.behindBy,
			mainAhead: ppe.compare.aheadBy,
			tipAtMs: ppe.target.committedDate ? Date.parse(ppe.target.committedDate) : null,
			rollup: ppe.target.statusCheckRollup?.state ?? null,
		});
	});
	return { states, unreadable };
}

/**
 * Which repos to wake. Skipped: not adopted, nothing to promote, `main` ahead
 * (no fast-forward exists until the sync merges it), checks still running (the
 * CI completion will wake the promoter itself), a red tip (its CI completion
 * already ran the promoter, whose revert is not cadence-gated; what is left is
 * a red it handed to a human, and waking it again only repeats that), a tip
 * younger than the quiet threshold, and a tip already woken within
 * {@link REDISPATCH_MS}.
 */
export function dueForPromotion(
	states: PpeState[],
	nowMs: number,
	woken: ReadonlyMap<string, { sha: string; atMs: number }>
): PpeState[] {
	return states.filter((s) => {
		if (!s.ppeSha || s.ppeAhead === 0 || s.mainAhead > 0) return false;
		if (s.rollup !== null && !SETTLED_GREEN.has(s.rollup)) return false;
		if (s.tipAtMs === null || nowMs - s.tipAtMs < PPE_QUIET_MS) return false;
		const last = woken.get(s.repo);
		return !(last && last.sha === s.ppeSha && nowMs - last.atMs < REDISPATCH_MS);
	});
}

/**
 * Per repo, the tip last woken and when. Module state, so a restart forgets
 * it and may wake a tip once more: one extra promoter run, which decides the
 * same thing again.
 */
const woken = new Map<string, { sha: string; atMs: number }>();

async function readStates(
	token: string,
	repos: string[]
): Promise<{ states: PpeState[]; unreadable: string[] } | string> {
	const { resp, error } = await ghFetchRaw('POST', GRAPHQL_URL, token, {
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			'User-Agent': userAgent('ppe-sweep'),
		},
		body: { query: sweepQuery(repos) },
	});
	if (!resp) return `network: ${error}`;
	const text = await resp.text();
	if (!resp.ok) return `HTTP ${resp.status}: ${text.slice(0, 200)}`;
	let body: { data?: Record<string, RepoNode | null> | null; errors?: { message: string }[] };
	try {
		body = JSON.parse(text) as typeof body;
	} catch {
		return 'unparseable GraphQL answer';
	}
	if (!body.data)
		return `GraphQL: ${(body.errors ?? []).map((e) => e.message).join('; ') || 'no data'}`;
	return parseSweep(repos, body.data);
}

/** One pass. Never throws: a wake-up that fails costs one cadence, not the process. */
export async function ppeSweepTick(
	nowMs: number = Date.now(),
	token: string | undefined = githubToken(),
	repos: string[] = coveredRepos()
): Promise<{ woke: string[]; failed: string[] } | null> {
	if (!token) {
		logger.warn('[ppe-sweep] no GitHub token yet: could not look, woke nothing');
		return null;
	}
	const read = await withGhCaller('ppe-sweep', () => readStates(token, repos));
	if (typeof read === 'string') {
		logger.warn(`[ppe-sweep] could not read ppe state (${read}); woke nothing`);
		return null;
	}
	if (read.unreadable.length)
		logger.warn(`[ppe-sweep] could not read ${read.unreadable.join(', ')}; skipped`);
	const woke: string[] = [];
	const failed: string[] = [];
	for (const s of dueForPromotion(read.states, nowMs, woken)) {
		const { resp, error } = await withGhCaller('ppe-sweep', () =>
			ghFetchRaw(
				'POST',
				`https://api.github.com/repos/${s.repo}/actions/workflows/${PROMOTE_WORKFLOW}/dispatches`,
				token,
				{
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: 'application/vnd.github+json',
						'Content-Type': 'application/json',
						'User-Agent': userAgent('ppe-sweep'),
					},
					body: { ref: 'main' },
				}
			)
		);
		// Recorded either way: a repo with a `ppe` branch and no promoter (404)
		// is retried per tip, not every pass.
		woken.set(s.repo, { sha: s.ppeSha as string, atMs: nowMs });
		if (resp?.ok) woke.push(s.repo);
		else {
			failed.push(s.repo);
			logger.warn(
				`[ppe-sweep] could not dispatch ${PROMOTE_WORKFLOW} in ${s.repo}: ${resp ? `HTTP ${resp.status}` : error}`
			);
		}
	}
	if (woke.length) logger.info(`[ppe-sweep] woke the promoter in ${woke.join(', ')}`);
	return { woke, failed };
}

/**
 * One scheduled pass: the tick, then {@link finishTick}. The loop registers
 * with liveness when it is scheduled, so a pass that never notes its tick
 * reads as `stale` on GET /mgmt/api/status from ~5 minutes after every boot
 * and pages as a critical outage (2026-11-02, both this loop and
 * capacity-sample, since they shipped). Could not look is still a COMPLETED
 * pass: the loop is alive, and the run row says it could not look.
 */
export async function ppeSweepPass(nowMs: number = Date.now()): Promise<void> {
	const r = await ppeSweepTick(nowMs);
	const verdict: Verdict = r === null ? 'unavailable' : r.failed.length ? 'findings' : 'ok';
	await finishTick({
		jobName: JOB_NAME,
		intervalMs: PPE_SWEEP_MS,
		now: nowMs,
		verdict,
		durationMs: Date.now() - nowMs,
		why: r === null ? 'could not read ppe state' : undefined,
		data: r ? { woke: r.woke, failed: r.failed } : undefined,
	});
}

let started = false;
let guard = createOverlapGuard();
let scheduled: ReturnType<typeof scheduleRepeating> | null = null;

/** Test seam: clear the timer, the `started` guard and the woken tips. */
export function __stopPpeSweepForTesting(): void {
	scheduled?.stop();
	scheduled = null;
	started = false;
	guard = createOverlapGuard();
	woken.clear();
}

/** Start the clock. Controller-only: `createFleetManager().start()` gates it. */
export function startPpeSweep(): void {
	if (started) return;
	started = true;
	const pass = () => guard.run(() => ppeSweepPass());
	const firstIn = computeFirstDelayMs(
		{ intervalMs: PPE_SWEEP_MS, firstPassMinMs: FIRST_PASS_MIN_MS },
		null
	);
	scheduled = scheduleRepeating(firstIn, PPE_SWEEP_MS, pass, JOB_NAME);
}
