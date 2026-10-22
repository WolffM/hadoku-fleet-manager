/**
 * Wave 4e §B (#102) — a node that fails PROVEN work loses the label.
 *
 * Every test here is a fixture over `JobRecord[]` plus an injected
 * `markStale` / `gatedKinds` — never GitHub, never the host, never a real
 * state dir (`node-regression.ts`'s own header; the wave's "tests never
 * reach GitHub, the host or a claw" rule).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	detectDivergences,
	groupRegressions,
	filterDivergencesByFreshProof,
	checkNodeRegressions,
	defaultGatedKinds,
	REGRESSION_THRESHOLD,
	DIVERGENCE_MATCH_WINDOW_MS,
	type Divergence,
	type GatedKind,
} from '../runners/node-regression.js';
import type { JobRecord } from '../job-history.js';
import type { ProofRecord, WriteFacetResult } from '../lib/measured.js';

const NODES = ['claw-3', 'claw-4', 'claw-8', 'claw-9', 'hokon'];
const JDK21: GatedKind = { capability: 'jdk21', repo: 'WolffM/hadoku-cardtable', job: 'forge-e2e' };

const T0 = Date.parse('2026-10-07T19:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

/**
 * A fresh PASS, filed under whichever (node, capability) it is asked for —
 * the fixture `readProof` every `checkNodeRegressions` test below injects,
 * so none of them ever reach the real `measured.ts#readProof` (which would
 * read the real state dir). `atIso` is the proof's own `at`; see
 * `filterDivergencesByFreshProof`'s doc for why that date matters.
 */
function passProofAt(atIso: string): (node: string, capability: string) => ProofRecord {
	return (node, capability) => ({
		node,
		capability,
		runId: null,
		runner: null,
		conclusion: null,
		durationSec: null,
		evidenceMatched: true,
		budgetSec: null,
		verdict: 'pass',
		why: 'fixture',
		at: atIso,
	});
}

/** Safely before every divergence timestamp these fixtures ever write. */
const FAR_PAST = new Date(0).toISOString();

let nextId = 1;
function rec(o: Partial<JobRecord> & { runner: string; conclusion: string }): JobRecord {
	const id = nextId++;
	return {
		repo: 'WolffM/hadoku-cardtable',
		runId: id,
		jobId: id,
		name: 'forge-e2e',
		labels: ['self-hosted', 'hadoku-builder', 'jdk21'],
		startedAt: at(0),
		durationSec: 200,
		headSha: 'a'.repeat(40),
		...o,
	};
}

// ── detectDivergences ────────────────────────────────────────────────────────

test('detectDivergences: a fail on one node matched by a pass on another at the same commit, in-window', () => {
	const records = [
		rec({ runner: 'claw-3', conclusion: 'failure', startedAt: at(0) }),
		rec({ runner: 'claw-8', conclusion: 'success', startedAt: at(600) }),
	];
	const divs = detectDivergences(records, NODES);
	assert.equal(divs.length, 1);
	assert.equal(divs[0]?.node, 'claw-3');
	assert.equal(divs[0]?.passedNode, 'claw-8');
});

test('detectDivergences: a job with no headSha never counts', () => {
	const records = [
		rec({ runner: 'claw-3', conclusion: 'failure', headSha: undefined }),
		rec({ runner: 'claw-8', conclusion: 'success', headSha: undefined }),
	];
	assert.equal(detectDivergences(records, NODES).length, 0);
});

test('detectDivergences: two distinct failing nodes at the same commit is a real product red — nobody is charged', () => {
	const records = [
		rec({ runner: 'claw-3', conclusion: 'failure', startedAt: at(0) }),
		rec({ runner: 'claw-4', conclusion: 'failure', startedAt: at(60) }),
		rec({ runner: 'claw-8', conclusion: 'success', startedAt: at(600) }),
	];
	assert.equal(
		detectDivergences(records, NODES).length,
		0,
		'a real product red at the commit must not count as either node regressing'
	);
});

test('detectDivergences: a pass outside the match window does not count', () => {
	const records = [
		rec({ runner: 'claw-3', conclusion: 'failure', startedAt: at(0) }),
		rec({
			runner: 'claw-8',
			conclusion: 'success',
			startedAt: at(DIVERGENCE_MATCH_WINDOW_MS / 1000 + 3600),
		}),
	];
	assert.equal(detectDivergences(records, NODES).length, 0);
});

test('detectDivergences: a pass that only hokon ran still counts as the counter-example', () => {
	const records = [
		rec({ runner: 'claw-3', conclusion: 'failure', startedAt: at(0) }),
		rec({ runner: 'hokon', conclusion: 'success', startedAt: at(600) }),
	];
	const divs = detectDivergences(records, NODES);
	assert.equal(
		divs.length,
		1,
		'hokon supplying the pass is real evidence, even though it can never be charged'
	);
	assert.equal(divs[0]?.passedNode, 'hokon');
});

test('detectDivergences: a group with no passing record at all is not evidence either way', () => {
	const records = [
		rec({ runner: 'claw-3', conclusion: 'failure', startedAt: at(0) }),
		rec({ runner: 'claw-3', conclusion: 'failure', startedAt: at(600) }),
	];
	assert.equal(detectDivergences(records, NODES).length, 0);
});

// ── groupRegressions ─────────────────────────────────────────────────────────

function fiveDivergencesOn(node: string): Divergence[] {
	return Array.from({ length: 5 }, (_, i) => ({
		node,
		repo: JDK21.repo,
		jobName: JDK21.job,
		headSha: `${i}`.repeat(40).slice(0, 40),
		failedRunId: 1000 + i,
		failedJobId: 1000 + i,
		passedNode: 'claw-8',
		passedRunId: 2000 + i,
		passedJobId: 2000 + i,
		at: at(i * 3600),
	}));
}

test('groupRegressions: five claw-3-shaped divergences mark the threshold', () => {
	const divs = fiveDivergencesOn('claw-3');
	assert.equal(divs.length, REGRESSION_THRESHOLD);
	const findings = groupRegressions(divs, [JDK21]);
	assert.equal(findings.length, 1);
	assert.equal(findings[0]?.node, 'claw-3');
	assert.equal(findings[0]?.capability, 'jdk21');
});

// cardtable sharded forge-e2e on 2026-10-08: its push jobs are named
// `forge-e2e (1)`…`(3)`. A gated kind matched on the exact name would stop
// counting them, and lane B would go inert without a sound.
test('groupRegressions: divergences on a SHARD of the gated job count toward the gated kind', () => {
	const divs = fiveDivergencesOn('claw-3').map((d, i) => ({
		...d,
		jobName: `${JDK21.job} (${(i % 3) + 1})`,
	}));
	const findings = groupRegressions(divs, [JDK21]);
	assert.equal(findings.length, 1);
	assert.equal(findings[0]?.node, 'claw-3');
});

test('groupRegressions: one divergence below N does not act', () => {
	const divs = fiveDivergencesOn('claw-3').slice(0, REGRESSION_THRESHOLD - 1);
	assert.equal(groupRegressions(divs, [JDK21]).length, 0);
});

test('groupRegressions: hokon never acts, even with enough divergences, when excluded from watchedNodes', () => {
	const divs = fiveDivergencesOn('hokon');
	const findings = groupRegressions(divs, [JDK21], {
		watchedNodes: ['claw-3', 'claw-4', 'claw-8', 'claw-9'],
	});
	assert.equal(findings.length, 0, 'hokon is a guest and must never be charged');
});

test('groupRegressions: an un-gated (repo, job) is ignored even past the threshold', () => {
	const divs = fiveDivergencesOn('claw-3').map((d) => ({ ...d, repo: 'WolffM/some-other-repo' }));
	assert.equal(groupRegressions(divs, [JDK21]).length, 0);
});

// ── checkNodeRegressions (the injected write) ───────────────────────────────

test('checkNodeRegressions: 5 POST-proof divergences mark the proof stale via the injected markStale, once per finding', () => {
	const records: JobRecord[] = [];
	for (let i = 0; i < REGRESSION_THRESHOLD; i++) {
		records.push(rec({ runner: 'claw-3', conclusion: 'failure', startedAt: at(i * 7200) }));
		records.push(
			rec({
				runner: 'claw-8',
				conclusion: 'success',
				startedAt: at(i * 7200 + 600),
				headSha: records[records.length - 1]!.headSha,
			})
		);
	}
	const marked: { node: string; capability: string; why: string }[] = [];
	// FAR_PAST: every divergence above started well AFTER this proof — the
	// post-proof case, scenario (2) of the manager's send-back.
	const applied = checkNodeRegressions(records, NODES, NODES, {
		gatedKinds: [JDK21],
		readProof: passProofAt(FAR_PAST),
		markStale: (node, capability, why) => {
			marked.push({ node, capability, why });
			return { ok: true, path: '/fake', logPath: '/fake.log', written: [node] };
		},
	});
	assert.equal(applied.length, 1);
	assert.equal(applied[0]?.node, 'claw-3');
	assert.equal(applied[0]?.divergenceCount, REGRESSION_THRESHOLD);
	assert.equal(
		marked.length,
		1,
		'the write happens exactly once per finding, not once per divergence'
	);
	assert.equal(marked[0]?.node, 'claw-3');
	assert.equal(marked[0]?.capability, 'jdk21');
	assert.match(marked[0]!.why, /5/, 'the reason names the count');
});

test('checkNodeRegressions: a failed write is still reported, never silently dropped', () => {
	const records: JobRecord[] = [];
	for (let i = 0; i < REGRESSION_THRESHOLD; i++) {
		const sha = `${i}`.repeat(40).slice(0, 40);
		records.push(
			rec({ runner: 'claw-3', conclusion: 'failure', startedAt: at(i * 7200), headSha: sha })
		);
		records.push(
			rec({ runner: 'claw-8', conclusion: 'success', startedAt: at(i * 7200 + 600), headSha: sha })
		);
	}
	const applied = checkNodeRegressions(records, NODES, NODES, {
		gatedKinds: [JDK21],
		readProof: passProofAt(FAR_PAST),
		markStale: () => ({
			ok: false,
			path: '/fake',
			reason: 'no-proof',
			why: 'nothing to mark stale yet',
		}),
	});
	assert.equal(applied.length, 1);
	assert.equal(applied[0]?.result.ok, false);
});

test('checkNodeRegressions: below threshold, nothing is marked', () => {
	const records: JobRecord[] = [
		rec({ runner: 'claw-3', conclusion: 'failure', startedAt: at(0) }),
		rec({ runner: 'claw-8', conclusion: 'success', startedAt: at(600), headSha: 'a'.repeat(40) }),
	];
	let calls = 0;
	const applied = checkNodeRegressions(records, NODES, NODES, {
		gatedKinds: [JDK21],
		readProof: passProofAt(FAR_PAST),
		markStale: () => {
			calls++;
			return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
		},
	});
	assert.equal(applied.length, 0);
	assert.equal(calls, 0);
});

// ── the manager send-back: a divergence only counts against the CURRENT proof ──

test('checkNodeRegressions (1): 5 PRE-proof divergences + a fresh pass written after them → no mark, no finding', () => {
	const records: JobRecord[] = [];
	for (let i = 0; i < REGRESSION_THRESHOLD; i++) {
		records.push(rec({ runner: 'claw-3', conclusion: 'failure', startedAt: at(i * 7200) }));
		records.push(
			rec({
				runner: 'claw-8',
				conclusion: 'success',
				startedAt: at(i * 7200 + 600),
				headSha: records[records.length - 1]!.headSha,
			})
		);
	}
	// The LATEST failing record above is at(4*7200) = at(28800). A proof
	// written well after that is a re-proof the tracker ran AFTER the incident
	// — every one of these divergences predates it and must not count.
	const freshProofAt = at(28800 + 3600);
	let calls = 0;
	const applied = checkNodeRegressions(records, NODES, NODES, {
		gatedKinds: [JDK21],
		readProof: passProofAt(freshProofAt),
		markStale: () => {
			calls++;
			return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
		},
	});
	assert.equal(calls, 0, 'a fresh proof written after the divergences retires all of them');
	assert.equal(
		applied.length,
		0,
		'no finding is raised for evidence that predates the fresh proof'
	);
});

test('checkNodeRegressions (3): the transition tick marks once; a FOLLOWING tick on the same set does not re-mark', () => {
	const records: JobRecord[] = [];
	for (let i = 0; i < REGRESSION_THRESHOLD; i++) {
		records.push(rec({ runner: 'claw-3', conclusion: 'failure', startedAt: at(i * 7200) }));
		records.push(
			rec({
				runner: 'claw-8',
				conclusion: 'success',
				startedAt: at(i * 7200 + 600),
				headSha: records[records.length - 1]!.headSha,
			})
		);
	}
	// Starts PASS (fresh, FAR_PAST): the transition tick must mark it stale.
	// `markStale` itself flips the fixture's verdict, exactly as the real
	// `measured.ts#markProofStale` flips the record it writes — so the
	// SECOND call reads the SAME state a following real tick would.
	let verdict: 'pass' | 'stale' = 'pass';
	let calls = 0;
	const deps = {
		gatedKinds: [JDK21],
		readProof: (node: string, capability: string) => ({
			...passProofAt(FAR_PAST)(node, capability),
			verdict,
		}),
		markStale: (): WriteFacetResult => {
			calls++;
			verdict = 'stale';
			return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
		},
	};
	checkNodeRegressions(records, NODES, NODES, deps); // transition tick
	assert.equal(calls, 1, 'the transition tick marks it stale exactly once');
	checkNodeRegressions(records, NODES, NODES, deps); // following tick, same records
	assert.equal(
		calls,
		1,
		'a following tick over the SAME divergence set must not re-mark — the proof is already stale'
	);
});

test('filterDivergencesByFreshProof: the transition — a PASS marked stale mid-run stops the SAME set from re-triggering', () => {
	const divs = fiveDivergencesOn('claw-3');
	let verdict: 'pass' | 'stale' = 'pass';
	const readProofFn = (node: string, capability: string) => ({
		...passProofAt(FAR_PAST)(node, capability),
		verdict,
	});
	const first = filterDivergencesByFreshProof(divs, [JDK21], readProofFn);
	assert.equal(first.length, 5, 'a fresh pass lets every post-proof divergence through');
	verdict = 'stale'; // simulate markStale's own write
	const second = filterDivergencesByFreshProof(divs, [JDK21], readProofFn);
	assert.equal(second.length, 0, 'once stale, the identical set no longer survives the filter');
});

// ── defaultGatedKinds — the one seam that touches lane A's real registry ────

test('defaultGatedKinds: every returned kind names a real jobProof (repo + job)', () => {
	for (const kind of defaultGatedKinds()) {
		assert.ok(kind.repo, `${kind.capability} names a repo`);
		assert.ok(kind.job, `${kind.capability} names a job`);
	}
});
