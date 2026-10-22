/**
 * A node that fails PROVEN work loses the label. Wave 4e §B (#102).
 *
 * The operator, 2026-10-07: "this is exactly the thing that bootcamping a
 * claw should catch. if they are not suitable to handle a job, then we
 * should have seen that coming before we allowed them to earn that tag."
 * claw-3 earned `jdk21` on a RAM floor and a tool probe (neither of which
 * says anything about the WORK the label routes), then failed five full
 * cardtable `forge-e2e` jobs on 2026-10-07 — runs 37672172494, 37690040302,
 * 37699767450, 37705155176, 37706044217 — and every one of them was green on
 * another claw within the hour. Lane A (same wave) makes the label's
 * `$proof` facet something a node can EARN by running the real job; this
 * file is the other half — the facet a node can LOSE by failing it in
 * production, without a manifest commit, the moment the evidence is in.
 *
 * THE SHAPE, PRECISELY. A job on node X whose (repo, job name, head sha)
 * also ran on node Y within {@link DIVERGENCE_MATCH_WINDOW_MS}, where X
 * FAILED and Y PASSED. That pairing is the exact one named above — "each
 * tree was green on another claw within the hour" is this wave's own words
 * for it, which is where the match window comes from (see that constant).
 *
 * A REAL PRODUCT RED NEVER COUNTS. When two or more DISTINCT nodes failed
 * the same (repo, job name, head sha), the workflow is broken for everyone
 * at that commit, not for one node — see {@link detectDivergences}. Nobody
 * is charged for it, and a single flaky commit cannot be laundered into a
 * false regression by having a retry land on a second node.
 *
 * HEAD SHA IS AN ADDITIVE FIELD (`job-history.ts`'s `JobRecord.headSha`,
 * wave 4e §B.2) THAT DID NOT EXIST BEFORE THIS WAVE. Every record on disk
 * before this deploys has no `headSha`, and a record with none NEVER counts
 * (see {@link detectDivergences}'s first filter) — there is no way to tell
 * "same commit" from "different commit" without it, and guessing would be
 * exactly the kind of silent failure CLAUDE.md refuses. The practical
 * consequence: THE FIRST REAL TRIGGER OF THIS GATE CAN ONLY COME FROM RUNS
 * INGESTED AFTER THIS DEPLOYS. The five claw-3 runs that motivated this wave
 * predate the field and this module cannot see them — the tracker's own
 * `docs/planning/workstreams.md` watch for "the first real trigger" is
 * exactly this fact stated as an operational expectation, not a gap to close
 * here.
 *
 * WHY N = 5 AND THE WINDOW = 1 HOUR. Scoping the comparison to one SPECIFIC
 * (repo, job name) kind — the gated capability's own `jobProof` — is
 * load-bearing, not incidental: a read-only pass over the fleet's real
 * `~/.hadoku-mgmt/job-history.jsonl` (7,203 records, 14 days to 2026-10-08),
 * scoring every repo/job pair fleet-wide for the same cross-node fail/pass
 * shape in a 60-minute window (ignoring head sha, which the old data does not
 * have — see above), found 17-24 such "divergences" each for claw-3, claw-4
 * and claw-5 in just those 14 days — a count that would false-page
 * constantly at any single-digit N if every repo/job pair were in scope.
 * Narrowed to cardtable's `forge-e2e` alone — the one kind `jdk21`'s workload
 * proof actually gates — the same proxy finds at most one or two such
 * clusters for any OTHER node in the whole window; the only node that ever
 * produced a cluster of FIVE in one sitting was claw-3, and that cluster is
 * the five runs this wave is named after. N = 5 is therefore not an
 * arbitrary round number: it is the number of divergences the real incident
 * actually produced before a human concluded "claw-3 cannot do this", so the
 * gate asks for no more evidence than already proved that call, and
 * (done-when) one fewer must not act. THE PROXY IS NOT PROOF — it cannot
 * confirm "same commit" without head sha, so it is reported here only to
 * show the SCOPING choice (one gated kind, not the whole fleet) is what
 * keeps this rare, not to re-derive the count a different way. The 1-hour
 * window is instead taken directly from the wave's own description of the
 * shape it exists to catch ("each tree was green on another claw within the
 * hour"), which is the one case here that DOES have exact run ids to check
 * against, and does.
 *
 * ACCUMULATION HAS NO SEPARATE DECAY WINDOW. Divergences are counted over
 * whatever `job-history.ts` currently retains (`RETENTION_DAYS`, 14 days,
 * already a rolling window) — a second decay clock on top of that would be
 * one more number to tune for no observed failure mode it fixes.
 *
 * A DIVERGENCE ONLY COUNTS AGAINST THE NODE'S CURRENT PROOF, NOT FOREVER.
 * 14 days of retained history is exactly what makes this necessary: once the
 * tracker re-proves a node — a fresh `$proof` PASS written at some instant T
 * — the same pre-T divergences must not keep re-triggering for the rest of
 * their 14-day life, or a re-proved node could never regain the label, and a
 * node already marked stale would have its stale mark (and a facet log line)
 * rewritten every ~10-minute tick forever. So {@link checkNodeRegressions}
 * reads the node's CURRENT proof (`readProof`, injected, defaulting to lane
 * A's real `measured.ts#readProof`) before acting, via
 * {@link filterDivergencesByFreshProof}, and a divergence counts only when
 * both hold: the proof's own `verdict` is `'pass'` (no proof at all, or a
 * proof already `'fail'`/`'stale'`, means the label is already withdrawn or
 * never offered — nothing to mark, no finding), and the failing job's own
 * `startedAt` is AFTER the proof's `at`. This is also what gives the
 * "page once" rule its other half: once a mark lands the proof's own
 * `verdict` becomes `'stale'`, so every later tick's filter drops that
 * node's divergences before they ever reach the threshold again — the write
 * stops repeating on its own, not because of a separate debounce.
 *
 * DETECTION IS PURE; STALE-MARKING AND THE PROOF READ ARE BOTH INJECTED.
 * `detectDivergences` and {@link groupRegressions} take only job records and
 * return data — no I/O, no fleet host, testable with fixtures alone.
 * {@link checkNodeRegressions} is the one seam that touches the outside
 * world, and even there both the read (`readProof`) and the write
 * (`markStale`) are parameters defaulting to lane A's real
 * `measured.ts#readProof`/`measured.ts#markProofStale`, so a test can inject
 * fakes and assert exactly what was read and what was (or was not) written,
 * without touching the state dir.
 *
 * HOKON NEVER ACTS. `groupRegressions` (and therefore `checkNodeRegressions`)
 * takes `watchedNodes` and refuses to charge any node outside it;
 * `runner-health.ts`'s call site passes `loadEphemeralNodes()`, the same set
 * `checkStarvation`/`checkDiskWatch` already walk for the identical reason —
 * hokon is a guest, never proven and never canaried (CLAUDE.md,
 * `docs/planning/wave4e-2026-10-08.md` Settled). hokon's own PASSING runs are
 * still valid counter-evidence against a claw's failure; only the charged
 * (failing) side is restricted.
 */

import { nodeOf } from './census.js';
import type { JobRecord } from '../job-history.js';
import { capability, workloadGatedCapabilities } from '../capabilities.js';
import { markProofStale, readProof, type WriteFacetResult } from '../lib/measured.js';
import { jobKind } from '../lib/job-kind.js';

/**
 * How close in time a passing run of the SAME (repo, job name, head sha)
 * must land to a failing one to count as the counter-example. 1 hour — this
 * wave's own description of the shape it exists to catch ("each tree was
 * green on another claw within the hour"); see this module's own header for
 * why that number could not be re-derived from old history instead.
 */
export const DIVERGENCE_MATCH_WINDOW_MS = 60 * 60 * 1000;

/**
 * Divergences a node must accumulate, on one workload-gated kind, before its
 * proof is marked stale. See this module's own header for the data behind
 * the number — it equals the real claw-3 incident exactly, no more and no
 * fewer.
 */
export const REGRESSION_THRESHOLD = 5;

/** One (repo, job name, head sha) divergence: X failed where Y passed. */
export interface Divergence {
	/** The node charged — the one that failed. */
	node: string;
	repo: string;
	jobName: string;
	headSha: string;
	failedRunId: number;
	failedJobId: number;
	/** The node whose run is the counter-example. */
	passedNode: string;
	passedRunId: number;
	passedJobId: number;
	/** The failing job's own `startedAt`, for the finding's log line. */
	at: string;
}

/** One workload-gated kind: a capability and the (repo, job) its proof runs. */
export interface GatedKind {
	capability: string;
	repo: string;
	job: string;
}

/** A node that has accumulated enough divergences on one gated kind. */
export interface RegressionFinding {
	node: string;
	capability: string;
	divergences: Divergence[];
}

/** What `checkNodeRegressions` did for one finding. */
export interface AppliedRegression {
	node: string;
	capability: string;
	divergenceCount: number;
	runIds: number[];
	result: WriteFacetResult | { ok: false; path: string; reason: 'no-proof'; why: string };
}

/**
 * The pure detector: every (node, repo, job name, head sha) divergence in
 * `records` — a job that FAILED on one node while the SAME commit PASSED on
 * another, within {@link DIVERGENCE_MATCH_WINDOW_MS}.
 *
 * `nodes` is the full fleet node-name list `nodeOf` needs for its
 * longest-prefix match (the same argument `idleSecondsByNode` and
 * `checkStarvation` already pass it) — this function does not restrict WHO
 * may be charged; that is {@link groupRegressions}'s `watchedNodes` job, kept
 * separate so hokon can still supply a PASSING counter-example here without
 * ever being chargeable.
 *
 * A record with no `headSha` is skipped outright (see this module's own
 * header: old history has none, and nothing here may guess "same commit"
 * from timing alone). A `(repo, job name, head sha)` group with no passing
 * record at all is also skipped — that is either a real product red with no
 * counter-example yet, or a commit nobody has retried; either way there is
 * no EVIDENCE a specific node is at fault, which is what a divergence must
 * show.
 */
export function detectDivergences(
	records: readonly JobRecord[],
	nodes: readonly string[],
	opts: { matchWindowMs?: number } = {}
): Divergence[] {
	const matchWindowMs = opts.matchWindowMs ?? DIVERGENCE_MATCH_WINDOW_MS;
	const groups = new Map<string, JobRecord[]>();
	for (const r of records) {
		// A job without a head sha never counts — see this module's own header.
		if (!r.headSha) continue;
		if (typeof r.runId !== 'number' || typeof r.jobId !== 'number') continue;
		const key = `${r.repo}\u0000${r.name}\u0000${r.headSha}`;
		const arr = groups.get(key);
		if (arr) arr.push(r);
		else groups.set(key, [r]);
	}

	const out: Divergence[] = [];
	for (const group of groups.values()) {
		const failing = group.filter((r) => r.conclusion !== 'success');
		const passing = group.filter((r) => r.conclusion === 'success');
		if (!failing.length || !passing.length) continue;
		const failingNodes = new Set(failing.map((r) => nodeOf(r.runner, nodes)));
		// TWO OR MORE DISTINCT NODES FAILED THE SAME COMMIT: a real product red,
		// not a node-specific regression (this module's own header). Nobody in
		// this group is charged, even though a pass also exists elsewhere.
		if (failingNodes.size !== 1) continue;
		const [node] = failingNodes;
		if (!node) continue;
		for (const f of failing) {
			const fStart = Date.parse(f.startedAt);
			if (!Number.isFinite(fStart)) continue;
			const match = passing.find((p) => {
				const pStart = Date.parse(p.startedAt);
				return Number.isFinite(pStart) && Math.abs(pStart - fStart) <= matchWindowMs;
			});
			if (!match) continue;
			out.push({
				node,
				repo: f.repo,
				jobName: f.name,
				headSha: f.headSha as string,
				failedRunId: f.runId,
				failedJobId: f.jobId,
				passedNode: nodeOf(match.runner, nodes),
				passedRunId: match.runId,
				passedJobId: match.jobId,
				at: f.startedAt,
			});
		}
	}
	return out;
}

/**
 * Fold divergences into per-node, per-capability findings — only for the
 * (repo, job) pairs `gatedKinds` names, and only for a node present in
 * `watchedNodes` when given.
 *
 * SCOPING TO `gatedKinds` IS WHAT KEEPS THIS FINDING RARE. Counting every
 * repo/job divergence fleet-wide (this module's own header) produces
 * 17-24 hits per busy node in two weeks — scoped to the one kind a label's
 * workload proof actually gates, every node but the real incident never
 * clears a handful. A future gated label adds its own `GatedKind`; nothing
 * here needs to change for it.
 *
 * `watchedNodes`, WHEN GIVEN, IS THE ONLY GUARD AGAINST CHARGING HOKON (or
 * any other guest). `detectDivergences` does not know about guests at all —
 * hokon may appear as a `passedNode` there, correctly, since its PASS is
 * still real evidence the commit is fine. Restricting here, at the fold, is
 * what keeps that evidence usable without ever making hokon the node a
 * finding names.
 */
export function groupRegressions(
	divergences: readonly Divergence[],
	gatedKinds: readonly GatedKind[],
	opts: { threshold?: number; watchedNodes?: readonly string[] } = {}
): RegressionFinding[] {
	const threshold = opts.threshold ?? REGRESSION_THRESHOLD;
	const watched = opts.watchedNodes;
	const byKey = new Map<string, Divergence[]>();
	for (const kind of gatedKinds) {
		for (const d of divergences) {
			if (d.repo !== kind.repo || jobKind(d.jobName) !== kind.job) continue;
			if (watched && !watched.includes(d.node)) continue;
			const key = `${d.node}\u0000${kind.capability}`;
			const arr = byKey.get(key);
			if (arr) arr.push(d);
			else byKey.set(key, [d]);
		}
	}
	const out: RegressionFinding[] = [];
	for (const [key, divs] of byKey) {
		if (divs.length < threshold) continue; // one divergence below N does not act
		const [node, cap] = key.split('\u0000') as [string, string];
		out.push({ node, capability: cap, divergences: divs });
	}
	return out;
}

/**
 * Drop every divergence that does not count against the node's CURRENT
 * `$proof` — see this module's own header ("A DIVERGENCE ONLY COUNTS AGAINST
 * THE NODE'S CURRENT PROOF, NOT FOREVER") for why this exists at all.
 *
 * A divergence survives only when `readProofFn(node, capability)` returns a
 * record whose `verdict` is `'pass'` AND whose failing job started strictly
 * AFTER that proof's own `at`. Every other case drops it SILENTLY (not as a
 * "could not look" finding): no proof, or a proof already `'fail'`/`'stale'`,
 * means the label is already withdrawn or was never offered, which is not
 * this module's finding to raise again — `nodeOffer`'s gate (lane A) already
 * reports that. An unparseable `at` on either side is treated the same as "no
 * proof" (excluded) rather than guessed, for the same reason a divergence
 * with no `headSha` is excluded outright in `detectDivergences`: a comparison
 * this module cannot actually perform must never silently resolve to "yes".
 *
 * `gatedKinds` is needed here, separately from {@link groupRegressions}'s own
 * use of it, because a `Divergence` carries `repo`/`jobName` but not the
 * capability id the proof is filed under — this is the one place that joins
 * them back together via the same (repo, job) match `groupRegressions` makes.
 */
export function filterDivergencesByFreshProof(
	divergences: readonly Divergence[],
	gatedKinds: readonly GatedKind[],
	readProofFn: typeof readProof
): Divergence[] {
	const capabilityByRepoJob = new Map<string, string>();
	for (const kind of gatedKinds) {
		capabilityByRepoJob.set(`${kind.repo}\u0000${kind.job}`, kind.capability);
	}
	return divergences.filter((d) => {
		const capabilityId = capabilityByRepoJob.get(`${d.repo}\u0000${d.jobName}`);
		if (!capabilityId) return false; // not a gated kind at all
		const proof = readProofFn(d.node, capabilityId);
		if (!proof || proof.verdict !== 'pass') return false;
		const proofAtMs = Date.parse(proof.at);
		const divergenceAtMs = Date.parse(d.at);
		if (!Number.isFinite(proofAtMs) || !Number.isFinite(divergenceAtMs)) return false;
		return divergenceAtMs > proofAtMs;
	});
}

/**
 * Every workload-gated capability's (repo, job) — the default `gatedKinds`
 * for {@link checkNodeRegressions}, derived from lane A's registry so a new
 * gated label needs no edit here.
 */
export function defaultGatedKinds(): GatedKind[] {
	const out: GatedKind[] = [];
	for (const id of workloadGatedCapabilities()) {
		const cap = capability(id);
		if (!cap?.jobProof) continue;
		out.push({ capability: id, repo: cap.jobProof.repo, job: cap.jobProof.job });
	}
	return out;
}

/**
 * Test-only overrides for the two defaults {@link checkNodeRegressions}
 * resolves when `deps` leaves them out — `runner-health.ts`'s call site
 * takes no `deps` at all (production always wants the real registry and the
 * real write), so an INTEGRATION test exercising that exact call site
 * (`runner-health.test.ts`, "tests of that finding only") has no other seam
 * to drive it with a fixture `GatedKind` or without touching the real state
 * dir. Same shape as `disk-watch.ts`'s `__setDiskReadingsForTesting`: a
 * module-level override, `null` meaning "use the real thing".
 */
let gatedKindsOverride: readonly GatedKind[] | null = null;
let markStaleOverride: typeof markProofStale | null = null;
let readProofOverride: typeof readProof | null = null;

/** Test seam. Not part of the supported API. */
export function __setGatedKindsForTesting(kinds: readonly GatedKind[] | null): void {
	gatedKindsOverride = kinds;
}

/** Test seam. Not part of the supported API. */
export function __setMarkStaleForTesting(fn: typeof markProofStale | null): void {
	markStaleOverride = fn;
}

/** Test seam. Not part of the supported API. */
export function __setReadProofForTesting(fn: typeof readProof | null): void {
	readProofOverride = fn;
}

/** Test seam: clear every override. Not part of the supported API. */
export function __resetNodeRegressionForTesting(): void {
	gatedKindsOverride = null;
	markStaleOverride = null;
	readProofOverride = null;
}

/**
 * Detect, filter, fold and act: every node that has accumulated {@link
 * REGRESSION_THRESHOLD} divergences on a gated kind, SINCE its current
 * `$proof` was last a fresh PASS, has that proof marked STALE (withdrawing
 * the label the same tick, no manifest commit — wave4e Settled) via
 * `markStale`.
 *
 * `readProof`/`markStale` EACH DEFAULT TO THE REAL `measured.ts` export so
 * production needs no wiring beyond the call site in `runner-health.ts`, and
 * are PARAMETERS so a test can inject fakes and assert exactly what was read
 * and what was (or was not) written, without touching the state dir (this
 * module's own header, and the wave's "tests never reach the host" rule).
 *
 * THE PROOF FILTER IS WHAT MAKES THIS SAFE TO CALL EVERY TICK FOREVER. See
 * {@link filterDivergencesByFreshProof}: once a mark lands, the proof's own
 * `verdict` becomes `'stale'`, so the SAME divergence set no longer survives
 * the filter on the next tick — `markStale` is not called again for it, and a
 * node the tracker re-proves (a fresh PASS written after the old
 * divergences) is judged only on what happens AFTER that, never pinned by
 * its own pre-proof history for the rest of the 14-day retention window.
 *
 * Returns one {@link AppliedRegression} per finding, whether or not the
 * write itself succeeded — `runner-health.ts`'s finding reports a failed
 * write too (CLAUDE.md: "I could not look" must never render as "nothing is
 * wrong", which applies to a facet write exactly as much as to a read).
 */
export function checkNodeRegressions(
	records: readonly JobRecord[],
	nodes: readonly string[],
	watchedNodes: readonly string[],
	deps: {
		gatedKinds?: readonly GatedKind[];
		markStale?: typeof markProofStale;
		readProof?: typeof readProof;
		threshold?: number;
		matchWindowMs?: number;
	} = {}
): AppliedRegression[] {
	const gatedKinds = deps.gatedKinds ?? gatedKindsOverride ?? defaultGatedKinds();
	const markStale = deps.markStale ?? markStaleOverride ?? markProofStale;
	const readProofFn = deps.readProof ?? readProofOverride ?? readProof;
	const divergences = detectDivergences(records, nodes, { matchWindowMs: deps.matchWindowMs });
	const eligible = filterDivergencesByFreshProof(divergences, gatedKinds, readProofFn);
	const findings = groupRegressions(eligible, gatedKinds, {
		threshold: deps.threshold,
		watchedNodes,
	});
	const applied: AppliedRegression[] = [];
	for (const f of findings) {
		const why =
			`${f.divergences.length} ${f.capability} run(s) failed on ${f.node} while the same ` +
			`commit passed elsewhere within the hour: ` +
			f.divergences
				.map(
					(d) =>
						`run ${d.failedRunId} (head ${d.headSha.slice(0, 8)}, vs ${d.passedNode}#${d.passedRunId})`
				)
				.join('; ');
		const result = markStale(f.node, f.capability, why);
		applied.push({
			node: f.node,
			capability: f.capability,
			divergenceCount: f.divergences.length,
			runIds: f.divergences.map((d) => d.failedRunId),
			result,
		});
	}
	return applied;
}
