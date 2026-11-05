/**
 * The dispatcher's generic admission-verdict snapshot — moved out of
 * `runners/ephemeral-tick.ts` (wave clean-2 lane A, cut (iii)).
 *
 * `ephemeral-tick.ts` (ci-scheduling) is the one writer, every
 * `dispatchEphemeral` pass; `runner-health-mint.ts` (observation) and
 * `routes/fleet-report.ts` (surfaces) are readers. A domain reading another
 * domain's fact through a STATE RECORD, never the writer's own module
 * directly, is rule 5 of the refactor plan's placement rule (§3.2) — this is
 * that record, same shape as `fleet-probe-store.ts` and
 * `pm2-host-busy-store.ts` beside it. `ephemeral-tick.ts` re-exports every
 * name here under its original path, so no existing importer changes.
 */
import type { AdmissionVerdict } from './lib/fleet-vocabulary.js';

/**
 * THE VERDICT SNAPSHOT — module-level, replaced WHOLESALE once per
 * `dispatchEphemeral` pass, never mutated in place, and only ever handed out
 * as a copy (`admissionVerdictsForReport`).
 *
 * WHOLESALE for the same reason `setWarmRepos` is: a node that stops being
 * reachable, or drops out of `input.ephemeral`, must stop being reported on
 * the very next pass rather than carrying a frozen verdict forever.
 *
 * EMPTY AFTER A RESTART, and that is the honest answer, not a bug — mgmt-api
 * restarts ~5x/day and this is in-memory. An ABSENT entry must NEVER be read
 * as "admitted": it means "this pass could not look", and `runner-health.ts`'s
 * starvation check treats it that way — carrying its last known finding
 * forward rather than clearing an alert on a tick that learned nothing.
 */
let admissionVerdictByNode: ReadonlyMap<string, AdmissionVerdict> = new Map();

/**
 * What the last `dispatchEphemeral` pass's generic admission check found, for
 * `runner-health.ts`'s starvation finding and `routes/fleet.ts`'s panel field.
 *
 * Copied, same rule as `warmReposForPlacement` — a caller must not be able to
 * mutate the fleet's belief about its own admission state.
 */
export function admissionVerdictsForReport(): ReadonlyMap<string, AdmissionVerdict> {
	return new Map(admissionVerdictByNode);
}

/**
 * `ephemeral-tick.ts`'s own production writer: `dispatchEphemeral` calls this
 * once per pass, wholesale, in place of what used to be a direct module-level
 * assignment. Same convention as `fleet-probe-store.ts`'s
 * `__setFleetProbeForTesting`, which is both the production setter and the
 * test seam for the same reason: one write path cannot drift from the other.
 */
export function setAdmissionVerdicts(verdicts: ReadonlyMap<string, AdmissionVerdict>): void {
	admissionVerdictByNode = verdicts;
}

/**
 * Test seam: inject the verdict snapshot directly, bypassing a real
 * `dispatchEphemeral` pass. Not part of the supported API.
 *
 * `runner-health.ts`'s starvation check is this file's READER, not its
 * producer — a test of the reader should not have to drive the dispatcher's
 * whole I/O-heavy pass (GitHub `gh`, `sh`, the warm cache, the speed model)
 * just to get one node refused on memory. `dispatchEphemeral` itself is
 * exercised end to end in `warm-cache.test.ts`.
 */
export function __setAdmissionVerdictsForTesting(
	verdicts: ReadonlyMap<string, AdmissionVerdict>
): void {
	admissionVerdictByNode = new Map(verdicts);
}

/** Test seam. Not part of the supported API. */
export function __resetAdmissionVerdictsForTesting(): void {
	admissionVerdictByNode = new Map();
}

/**
 * WHICH QUEUED RUNS each node actually refused on memory or space
 * (fleet-manager#58). The verdict above is the GENERIC check, made before any
 * queued run is known, so it has no repo: the starved alert that quoted it said
 * "this repo peaks at 4096MB (basis: default)" about no repo at all. The
 * dispatcher knows the real ones; it records them here, per node and per repo,
 * the latest refusal of each.
 *
 * Merged, not replaced wholesale like the verdicts: a run held by its probe
 * backoff is not re-asked every pass, and its last refusal is still the truth
 * until it ages out. In memory, like the verdicts: empty after a restart.
 */
export interface RefusedRun {
	repo: string;
	runId: number;
	/** That node's own refusal of that run, as `admitMint` worded it. */
	reason: string;
	atMs: number;
}

/** A refusal older than this no longer describes the node. */
export const REFUSED_RUN_TTL_MS = 60 * 60_000;
/** How many refused repos a node's entry names, newest first. */
const REFUSED_REPOS_SHOWN = 3;

let refusedRunsByNode = new Map<string, Map<string, RefusedRun>>();

/** Record one pass's memory/space refusals. Every other clause is not starvation and is ignored. */
export function noteRefusedRuns(
	refusals: readonly { node: string; repo: string; runId: number; reason: string }[],
	nowMs: number
): void {
	for (const r of refusals) {
		if (!/^(memory|space):/.test(r.reason)) continue;
		const byRepo = refusedRunsByNode.get(r.node) ?? new Map<string, RefusedRun>();
		byRepo.set(r.repo, { repo: r.repo, runId: r.runId, reason: r.reason, atMs: nowMs });
		refusedRunsByNode.set(r.node, byRepo);
	}
	for (const [node, byRepo] of refusedRunsByNode) {
		for (const [repo, r] of byRepo) if (nowMs - r.atMs > REFUSED_RUN_TTL_MS) byRepo.delete(repo);
		if (!byRepo.size) refusedRunsByNode.delete(node);
	}
}

/** The repos `node` refused on memory or space within the TTL, newest first, at most three. */
export function refusedRunsFor(node: string, nowMs: number): RefusedRun[] {
	return [...(refusedRunsByNode.get(node)?.values() ?? [])]
		.filter((r) => nowMs - r.atMs <= REFUSED_RUN_TTL_MS)
		.sort((a, b) => b.atMs - a.atMs)
		.slice(0, REFUSED_REPOS_SHOWN);
}

/** Test seam. Not part of the supported API. */
export function __resetRefusedRunsForTesting(): void {
	refusedRunsByNode = new Map();
}
