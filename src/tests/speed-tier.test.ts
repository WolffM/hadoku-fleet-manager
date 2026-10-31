/**
 * speed-tier — pure model, pure fixtures. Every test here builds its own
 * `JobRecord[]` and asserts against `buildSpeedModel` directly; nothing
 * touches a file or a clock except the injected `nowMs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	buildSpeedModel,
	MIN_KIND_SAMPLES,
	MIN_KINDS,
	MIN_OTHER_NODES,
	MIN_SAMPLES,
	SLOW_P25,
	TRIVIAL_SEC,
	WINDOW_DAYS,
} from '../runners/speed-tier.js';
import { RETENTION_DAYS, type JobRecord, type ProbeOrigin } from '../job-history-store.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const RECENT_ISO = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();

/** The declared node list most fixtures pass as `opts.nodes` — the thing a
 * real caller gets from the manifest. Every fixture below spells runner names
 * BARE ("claw-5"), which `nodeOf` returns unchanged whether or not this list
 * is supplied (see the two tests dedicated to the JIT-name shape, which
 * exercise the list for real). It is passed anyway, for the same reason a
 * real caller always has one in hand. */
const FLEET_NODES = ['claw-1', 'claw-2', 'claw-3', 'claw-4', 'claw-5', 'claw-6', 'claw-7', 'hokon'];

let nextId = 1;

/** One successful job record. `runner` is normally a bare node name
 * ("claw-5"); the JIT-shape tests below build a realistic
 * `jit-<node>-<slug>-j<jobId>-r<runId>-<epoch>` name instead. */
function rec(opts: {
	repo: string;
	name: string;
	runner: string;
	runSec: number;
	startedAt?: string;
	conclusion?: string;
	probe?: ProbeOrigin;
}): JobRecord {
	const id = nextId++;
	return {
		repo: opts.repo,
		runId: id,
		jobId: id,
		name: opts.name,
		runner: opts.runner,
		labels: ['self-hosted', 'hadoku-builder'],
		startedAt: opts.startedAt ?? RECENT_ISO,
		durationSec: opts.runSec,
		runSec: opts.runSec,
		conclusion: opts.conclusion ?? 'success',
		...(opts.probe ? { probe: opts.probe } : {}),
	};
}

/** `n` records for one (repo, job, node) kind, all at `runSec`. */
function kindSamples(
	repo: string,
	name: string,
	node: string,
	runSec: number,
	n = MIN_SAMPLES
): JobRecord[] {
	return Array.from({ length: n }, () => rec({ repo, name, runner: node, runSec }));
}

// ---------------------------------------------------------------------------
// (a) a uniformly slow node is 'slow'
// ---------------------------------------------------------------------------

test('(a) a node slow on every kind is tiered slow', () => {
	const records: JobRecord[] = [];
	const OTHERS = ['claw-1', 'claw-2', 'claw-3'];
	// MIN_KINDS (5) kinds, each with the slow node at 2.5x every other claw's
	// median, each others-median well above TRIVIAL_SEC.
	for (let i = 0; i < MIN_KINDS; i++) {
		const repo = `WolffM/repo-${i}`;
		records.push(...kindSamples(repo, 'check', 'claw-9', 150));
		for (const other of OTHERS) records.push(...kindSamples(repo, 'check', other, 60));
	}
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	assert.equal(model.tierOf('claw-9'), 'slow');
	const d = model.describe('claw-9');
	assert.equal(d.kinds, MIN_KINDS);
	assert.ok(d.p25 !== null && d.p25 >= SLOW_P25, `p25 ${d.p25} should clear SLOW_P25 ${SLOW_P25}`);
});

// The 2026-10-07 shape: claw-5's real per-kind ratios. One kind ran near fleet
// speed (promptsmith:check, 1.29x) and eight ran 2.16x-3.70x. Under the old
// p10 rule that one kind WAS the decile at 9 kinds, so claw-5 read 'normal' and
// lost both the spill gate and the never-warm rule. One outlier kind must not
// take a node out of the slow tier.
test('one fast kind among nine does not take a uniformly slow node out of the slow tier', () => {
	const records: JobRecord[] = [];
	const OTHERS = ['claw-2', 'claw-4'];
	const ratios = [1.29, 2.16, 2.38, 2.89, 2.97, 3.11, 3.17, 3.24, 3.7];
	ratios.forEach((ratio, i) => {
		const repo = `WolffM/claw5-shape-${i}`;
		const othersSec = 100;
		records.push(...kindSamples(repo, 'check', 'claw-9', Math.round(othersSec * ratio)));
		for (const other of OTHERS) records.push(...kindSamples(repo, 'check', other, othersSec));
	});
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	const d = model.describe('claw-9');
	assert.equal(d.kinds, ratios.length);
	assert.equal(model.tierOf('claw-9'), 'slow', `p25 ${d.p25} with one outlier kind`);
});

// ---------------------------------------------------------------------------
// (b) slow on only SOME kinds (claw-1/claw-3 shape) stays 'normal'
// ---------------------------------------------------------------------------

test('(b) a node slow on only some kinds (p50 1.2-1.5, p25 near 1) is normal', () => {
	const records: JobRecord[] = [];
	const OTHERS = ['claw-2', 'claw-4'];
	// Ratios chosen to land p25 near 1 and p50 in [1.2, 1.5] for 8 kinds.
	const ratios = [0.8, 0.95, 1.2, 1.3, 1.4, 1.6, 1.8, 2.0];
	ratios.forEach((ratio, i) => {
		const repo = `WolffM/uneven-${i}`;
		const othersSec = 100;
		records.push(...kindSamples(repo, 'test', 'claw-1', Math.round(othersSec * ratio)));
		for (const other of OTHERS) records.push(...kindSamples(repo, 'test', other, othersSec));
	});
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	const d = model.describe('claw-1');
	assert.equal(d.kinds, ratios.length);
	assert.ok(d.p25 !== null && d.p25 < SLOW_P25, `p25 ${d.p25} should be under SLOW_P25`);
	assert.ok(d.p50 !== null && d.p50 >= 1.2 && d.p50 <= 1.5, `p50 ${d.p50} should be in [1.2, 1.5]`);
	assert.equal(model.tierOf('claw-1'), 'normal');
});

// ---------------------------------------------------------------------------
// (c) thin history is 'unknown', never 'slow'
// ---------------------------------------------------------------------------

test('(c) a node with too few qualifying kinds is unknown, even with a high ratio', () => {
	const records: JobRecord[] = [];
	const OTHERS = ['claw-2', 'claw-3'];
	// Only 2 kinds -- below MIN_KINDS -- each at a ratio (3.0) that would read
	// as slow if it had enough kinds behind it.
	for (let i = 0; i < 2; i++) {
		const repo = `WolffM/thin-${i}`;
		records.push(...kindSamples(repo, 'check', 'claw-7', 300));
		for (const other of OTHERS) records.push(...kindSamples(repo, 'check', other, 100));
	}
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	const d = model.describe('claw-7');
	assert.ok(d.kinds < MIN_KINDS);
	assert.equal(model.tierOf('claw-7'), 'unknown');
});

test('(c) a node with no history at all is unknown', () => {
	const model = buildSpeedModel([], { nowMs: NOW, nodes: FLEET_NODES });
	assert.equal(model.tierOf('claw-99'), 'unknown');
	assert.deepEqual(model.describe('claw-99'), { tier: 'unknown', p25: null, p50: null, kinds: 0 });
});

// ---------------------------------------------------------------------------
// (d) hokon's records never enter the baseline
// ---------------------------------------------------------------------------

test("(d) hokon's records do not enter the others baseline", () => {
	const repo = 'WolffM/hokon-test';
	const records: JobRecord[] = [
		...kindSamples(repo, 'check', 'claw-2', 160), // the node under test
		...kindSamples(repo, 'check', 'claw-1', 80), // the only REAL claw baseline
		// hokon: wildly different duration. If this ever entered "others" the
		// combined median (and therefore claw-2's ratio) would move far from 2.0.
		...kindSamples(repo, 'check', 'hokon', 100_000),
	];
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	const extra = model.expectedExtraSec('claw-2', repo, 'check');
	// 160 - 80 = 80 if hokon is excluded, as it must be. If hokon's 100,000s
	// samples leaked into the others pool the median would be enormous and
	// this difference would be deeply negative instead.
	assert.equal(extra, 80);
});

test('(d) hokon itself is never tiered (not a claw node)', () => {
	const repo = 'WolffM/hokon-only';
	const records = kindSamples(repo, 'redeploy', 'hokon', 20, 50);
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	assert.equal(model.tierOf('hokon'), 'unknown');
});

// ---------------------------------------------------------------------------
// (e) expectedExtraSec falls back in the documented order, null when nothing
// applies
// ---------------------------------------------------------------------------

test('(e1) exact (repo, job) match is used when both sides have data, ahead of the repo fallback', () => {
	const repo = 'WolffM/exact';
	const records: JobRecord[] = [
		...kindSamples(repo, 'check', 'claw-5', 200),
		...kindSamples(repo, 'check', 'claw-1', 100),
		// A second job in the SAME repo with very different numbers, so the
		// repo-level fallback would give a DIFFERENT answer than the exact kind
		// — this is what makes the test actually distinguish "used the exact
		// match" from "fell through to the repo level and got lucky".
		...kindSamples(repo, 'build', 'claw-5', 900),
		...kindSamples(repo, 'build', 'claw-1', 100),
	];
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	// Exact (repo, 'check'): 200 - 100 = 100. The repo-level fallback (per-kind
	// deltas: check=100, build=800) would give median([100,800]) = 450.
	assert.equal(model.expectedExtraSec('claw-5', repo, 'check'), 100);
});

// cardtable sharded forge-e2e on 2026-10-08. A shard's name has no history of
// its own; it must resolve to the unsharded kind's exact answer, not fall
// through to the repo level (which a sibling job would skew).
test('(e1) a matrix shard resolves to its unsharded kind', () => {
	const repo = 'WolffM/sharded';
	const records: JobRecord[] = [
		...kindSamples(repo, 'forge-e2e', 'claw-5', 200),
		...kindSamples(repo, 'forge-e2e', 'claw-1', 100),
		...kindSamples(repo, 'build', 'claw-5', 900),
		...kindSamples(repo, 'build', 'claw-1', 100),
	];
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	assert.equal(model.expectedExtraSec('claw-5', repo, 'forge-e2e (2)'), 100);
});

test('(e2) falls back to (repo) when the exact job is missing on the node — PER KIND, not pooled', () => {
	const repo = 'WolffM/repo-fallback';
	const records: JobRecord[] = [
		// The node never ran 'check' in this repo, only 'build'.
		...kindSamples(repo, 'build', 'claw-5', 300),
		...kindSamples(repo, 'build', 'claw-1', 100),
		// Other claws HAVE run 'check', but the queried node has not — this kind
		// contributes NOTHING (the node side never clears MIN_SAMPLES for it),
		// unlike the old pooled approach, which would have folded its 50s rows
		// into the others side and dragged the baseline down.
		...kindSamples(repo, 'check', 'claw-1', 50),
	];
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	// Only 'build' qualifies on both sides: delta = 300 - 100 = 200. The old
	// pooled answer would have been 300 - median([100x5,50x5]) = 300 - 75 = 225.
	assert.equal(model.expectedExtraSec('claw-5', repo, 'check'), 200);
});

test('(e2b) the repo-level fallback compares like with like — a uniformly SLOW node must never read as faster', () => {
	// The Simpson's-paradox shape that made the pooled approach wrong, measured
	// live on 2026-10-04: `expectedExtraSec('claw-5', 'hadoku-cardtable',
	// undefined)` returned -133 (reads as FASTER) while the one job both sides
	// share returned +149. Reproduced here as a controlled fixture: claw-5 is
	// uniformly 2x slower than claw-1 on EVERY kind, but the two ran very
	// different MIXES of a short job and a long one.
	const repo = 'WolffM/simpson';
	const records: JobRecord[] = [
		// 'short': claw-5 ran it a LOT (20x, @40s = 2x claw-1's 20s). claw-1 ran it
		// only the minimum to qualify (5x).
		...kindSamples(repo, 'short', 'claw-5', 40, 20),
		...kindSamples(repo, 'short', 'claw-1', 20, 5),
		// 'long': claw-5 ran it only the minimum (5x, @2000s = 2x claw-1's
		// 1000s). claw-1 ran it a LOT (20x).
		...kindSamples(repo, 'long', 'claw-5', 2000, 5),
		...kindSamples(repo, 'long', 'claw-1', 1000, 20),
	];
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	// jobName undefined -- exactly the dispatch-tick.ts shape (it never puts a
	// job name on PendingRun), and exactly what skips level 1 straight to the
	// repo-level fallback being tested.
	const extra = model.expectedExtraSec('claw-5', repo, undefined);
	// Per-kind (correct): delta(short)=40-20=20, delta(long)=2000-1000=1000;
	// median([20,1000]) = 510. POSITIVE -- claw-5 correctly reads as slower.
	assert.equal(extra, 510);
	// The POOLED approach this replaced would have given: claw-5's 25 pooled
	// samples (20x40, 5x2000) median to 40; claw-1's 25 pooled samples (5x20,
	// 20x1000) median to 1000; 40 - 1000 = -960 -- claw-5 would have read as
	// dramatically FASTER. Assert the fix is nowhere near that shape.
	assert.ok(extra !== null && extra > 0, `expected a positive extra, got ${extra}`);
});

test("(e3) falls back to the node's overall ratio x the job's others-median", () => {
	const records: JobRecord[] = [];
	// Establish claw-5's overall ratio (2.0) from kinds in OTHER repos, enough
	// to clear MIN_KINDS so ratiosByNode has real data for it.
	for (let i = 0; i < MIN_KINDS; i++) {
		const repo = `WolffM/established-${i}`;
		records.push(...kindSamples(repo, 'check', 'claw-5', 200));
		records.push(...kindSamples(repo, 'check', 'claw-1', 100));
	}
	// A DIFFERENT repo/job claw-5 has never run, but another claw has.
	const target = 'WolffM/never-run-by-5';
	records.push(...kindSamples(target, 'publish', 'claw-1', 40));
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	const overallRatio = model.describe('claw-5').p50;
	assert.equal(overallRatio, 2.0);
	// othersMed for (target, publish) = 40; extra = (2.0 - 1) * 40 = 40.
	assert.equal(model.expectedExtraSec('claw-5', target, 'publish'), 40);
});

test('(e3) the overall ratio is not rounded to a whole number on an even count of kinds', () => {
	// median() rounds the mean of its two middle values, which is right for
	// seconds and wrong for a ratio: an even count of 2.5x kinds read as 3x,
	// and claw-5 (20 kinds, ~2.7x) held work about 18% longer than it should.
	const records: JobRecord[] = [];
	const kinds = MIN_KINDS + (MIN_KINDS % 2);
	for (let i = 0; i < kinds; i++) {
		const repo = `WolffM/even-${i}`;
		records.push(...kindSamples(repo, 'check', 'claw-5', 250));
		records.push(...kindSamples(repo, 'check', 'claw-1', 100));
	}
	const target = 'WolffM/never-run-by-5';
	records.push(...kindSamples(target, 'publish', 'claw-1', 40));
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	assert.equal(model.describe('claw-5').p50, 2.5);
	// (2.5 - 1) * 40 = 60; the rounded ratio gave (3 - 1) * 40 = 80.
	assert.equal(model.expectedExtraSec('claw-5', target, 'publish'), 60);
});

test('(e4) returns null when nothing applies', () => {
	const model = buildSpeedModel([], { nowMs: NOW, nodes: FLEET_NODES });
	assert.equal(model.expectedExtraSec('claw-5', 'WolffM/nothing-known', 'anything'), null);
});

test('(e4) returns null for an undefined job name with no repo-level data either', () => {
	const records = kindSamples('WolffM/elsewhere', 'check', 'claw-5', 200);
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	assert.equal(model.expectedExtraSec('claw-5', 'WolffM/totally-unrelated', undefined), null);
});

// ---------------------------------------------------------------------------
// Extra coverage: the time window, and the trivial-kind filter. Not lettered
// in §B.4, but both are explicit rules in §B.2/§B.3 and both are
// mutation-tested the same way.
// ---------------------------------------------------------------------------

test('the window never claims more days than job-history keeps', () => {
	// It said 30 over a ledger that keeps 14 (and, under the old 20,000-row
	// cap, held ~7). A window wider than retention is not a wider window; it is
	// a number that describes data the model never sees.
	assert.ok(
		WINDOW_DAYS <= RETENTION_DAYS,
		`WINDOW_DAYS (${WINDOW_DAYS}) exceeds job-history's RETENTION_DAYS (${RETENTION_DAYS})`
	);
});

test('a node is re-tiered from the window, not its whole history', () => {
	const STALE = new Date(NOW - (WINDOW_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();
	const records: JobRecord[] = [];
	const OTHERS = ['claw-2', 'claw-3'];
	for (let i = 0; i < MIN_KINDS; i++) {
		const repo = `WolffM/stale-${i}`;
		// claw-9 was slow, but every one of those records is OUTSIDE the window.
		records.push(
			...kindSamples(repo, 'check', 'claw-9', 300, MIN_SAMPLES).map((r) => ({
				...r,
				startedAt: STALE,
			}))
		);
		for (const other of OTHERS) records.push(...kindSamples(repo, 'check', other, 100));
	}
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	// claw-9 has zero records inside the window at all -> unknown, never slow.
	assert.equal(model.tierOf('claw-9'), 'unknown');
});

test('a kind whose others-median is trivial (dispatch-ping-sized) is ignored', () => {
	const records: JobRecord[] = [];
	const OTHERS = ['claw-2', 'claw-3'];
	// 5 "real" kinds establish claw-9 as otherwise normal (ratio 1.0).
	for (let i = 0; i < MIN_KINDS; i++) {
		const repo = `WolffM/real-${i}`;
		records.push(...kindSamples(repo, 'check', 'claw-9', 100));
		for (const other of OTHERS) records.push(...kindSamples(repo, 'check', other, 100));
	}
	// One trivial kind where claw-9 looks 5x slower in absolute terms, but the
	// others-median is under TRIVIAL_SEC -- must not count toward its kinds or
	// pull its tier.
	const trivialRepo = 'WolffM/trivial';
	records.push(...kindSamples(trivialRepo, 'ping', 'claw-9', 10));
	for (const other of OTHERS)
		records.push(...kindSamples(trivialRepo, 'ping', other, Math.round(TRIVIAL_SEC / 2)));
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	const d = model.describe('claw-9');
	assert.equal(d.kinds, MIN_KINDS, 'the trivial kind must not be counted');
	assert.equal(model.tierOf('claw-9'), 'normal');
});

test('a forced-rerun / shadow probe sample never enters the model', () => {
	const repo = 'WolffM/probe-only';
	const records: JobRecord[] = [
		...kindSamples(repo, 'check', 'claw-1', 100),
		// A probe-tagged record claiming claw-5 is catastrophically slow. If this
		// leaked in, expectedExtraSec would see it; it must not.
		rec({ repo, name: 'check', runner: 'claw-5', runSec: 999_999, probe: 'shadow' }),
	];
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	assert.equal(model.expectedExtraSec('claw-5', repo, 'check'), null);
});

// ---------------------------------------------------------------------------
// Node attribution via a REAL JIT-shaped runner name, through `nodeOf` —
// §B.1's "node parsed from the runner name the way job-history.ts already
// does". These two tests are the ones that actually exercise `opts.nodes`;
// every fixture above spells the runner name bare, which resolves the same
// with or without a declared list.
// ---------------------------------------------------------------------------

/** `jit-<node>-<slug>-j<jobId>-r<runId>-<epoch>` — the exact shape
 * `jitRunnerName` (runners/ephemeral.ts) mints. */
function jitName(node: string, slug: string, jobId: number, runId: number): string {
	return `jit-${node}-${slug}-j${jobId}-r${runId}-1700000000`;
}

test('a JIT-shaped runner name resolves to its node when `nodes` is supplied', () => {
	const repo = 'WolffM/jit-shape-repo';
	const records: JobRecord[] = [];
	for (let i = 0; i < MIN_SAMPLES; i++) {
		records.push(
			rec({ repo, name: 'check', runner: jitName('claw-5', 'jit-shape-repo', i, i), runSec: 200 }),
			rec({
				repo,
				name: 'check',
				runner: jitName('claw-1', 'jit-shape-repo', 100 + i, 100 + i),
				runSec: 100,
			})
		);
	}
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	// If the JIT names had failed to resolve to 'claw-5'/'claw-1' this would be
	// null (no kind would ever accumulate >= MIN_SAMPLES on either side).
	assert.equal(model.expectedExtraSec('claw-5', repo, 'check'), 100);
});

// ---------------------------------------------------------------------------
// factorOf — the continuous per-node factor placement ties on (wave 3z, #83's
// continuous sibling). IS `describe().p50`, gated on the TIER rather than on
// `kinds > 0`: see the dedicated "gated on tier" test below for why those
// differ.
// ---------------------------------------------------------------------------

test('factorOf is the measured p50 ratio for a node with real history', () => {
	const records: JobRecord[] = [];
	const OTHERS = ['claw-2', 'claw-4'];
	for (let i = 0; i < MIN_KINDS; i++) {
		const repo = `WolffM/factor-${i}`;
		records.push(...kindSamples(repo, 'check', 'claw-8', 60)); // 0.6x the others
		for (const other of OTHERS) records.push(...kindSamples(repo, 'check', other, 100));
	}
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	const d = model.describe('claw-8');
	assert.equal(model.factorOf?.('claw-8'), d.p50);
	assert.equal(model.factorOf?.('claw-8'), 0.6);
});

test('factorOf is null for an unknown node, even with no history at all', () => {
	const model = buildSpeedModel([], { nowMs: NOW, nodes: FLEET_NODES });
	assert.equal(model.factorOf?.('claw-99'), null);
});

test('factorOf is null (NEUTRAL) for thin history, gated on the TIER rather than merely `kinds > 0`', () => {
	// Mirrors test (c): below MIN_KINDS the tier is 'unknown' even though
	// `describe().p50` is a real (non-null) number — factorOf must still read
	// null here, not that numeric p50, or a thin-history node would be judged
	// fast/slow before it has earned the confidence bar `tierOf` already
	// enforces.
	const records: JobRecord[] = [];
	const OTHERS = ['claw-2', 'claw-3'];
	for (let i = 0; i < 2; i++) {
		const repo = `WolffM/thin-factor-${i}`;
		records.push(...kindSamples(repo, 'check', 'claw-7', 300));
		for (const other of OTHERS) records.push(...kindSamples(repo, 'check', other, 100));
	}
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	const d = model.describe('claw-7');
	assert.equal(model.tierOf('claw-7'), 'unknown');
	assert.ok(d.p50 !== null, 'precondition: describe().p50 is numeric despite the unknown tier');
	assert.equal(model.factorOf?.('claw-7'), null);
});

test('factorOf is null for hokon (never a claw node) regardless of history', () => {
	const repo = 'WolffM/hokon-factor';
	const records = kindSamples(repo, 'redeploy', 'hokon', 20, 50);
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	assert.equal(model.factorOf?.('hokon'), null);
});

test('factorOf reproduces the measured fleet order against the real 30-day job-history.jsonl read (2026-10-05)', () => {
	// Not a read of the real file (this module is pure and takes no path) —
	// a fixture built to the SAME per-kind ratios measured live, confirming
	// the ranking factorOf would produce matches the operator's independently
	// fit additive-model order: claw-8 < claw-4 < claw-6 < claw-9 < claw-2 <
	// claw-1 < claw-3. See speed-tier.ts's `factorOf` doc for the full
	// comparison against a discarded alternative.
	const records: JobRecord[] = [];
	const nodeRatios: Record<string, number> = {
		'claw-8': 0.6,
		'claw-4': 0.77,
		'claw-6': 0.81,
		'claw-9': 0.97,
		'claw-2': 1.0,
		'claw-1': 1.12,
		'claw-3': 1.42,
	};
	for (let i = 0; i < MIN_KINDS; i++) {
		const repo = `WolffM/fleet-order-${i}`;
		for (const [node, ratio] of Object.entries(nodeRatios)) {
			records.push(...kindSamples(repo, 'check', node, Math.round(100 * ratio)));
		}
	}
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	const order = Object.keys(nodeRatios).sort(
		(a, b) => (model.factorOf?.(a) ?? 1) - (model.factorOf?.(b) ?? 1)
	);
	assert.deepEqual(order, ['claw-8', 'claw-4', 'claw-6', 'claw-9', 'claw-2', 'claw-1', 'claw-3']);
});

test('without `nodes`, JIT-named records fail SAFE (unknown, never slow, never a crash)', () => {
	const repo = 'WolffM/jit-shape-no-list';
	const records: JobRecord[] = [];
	for (let i = 0; i < MIN_SAMPLES; i++) {
		records.push(
			rec({
				repo,
				name: 'check',
				runner: jitName('claw-5', 'jit-shape-no-list', i, i),
				runSec: 900,
			}),
			rec({
				repo,
				name: 'check',
				runner: jitName('claw-1', 'jit-shape-no-list', 100 + i, 100 + i),
				runSec: 100,
			})
		);
	}
	// No `opts.nodes` at all. Each JIT name's de-prefixed remainder embeds this
	// record's own job/run/epoch, so it is unique per record, never reaches
	// MIN_SAMPLES, and never looks like a claw at all -- 'unknown', not a wrong
	// answer and not a crash.
	const model = buildSpeedModel(records, { nowMs: NOW });
	assert.equal(model.tierOf('claw-5'), 'unknown');
	assert.equal(model.expectedExtraSec('claw-5', repo, 'check'), null);
});

// ---------------------------------------------------------------------------
// #8: one kind, read on its own — a normal node can be slow at one job
// ---------------------------------------------------------------------------

const E2E_REPO = 'WolffM/hadoku-dataplatform';

/** The other claws' baseline for one kind: MIN_SAMPLES successes each on two
 * nodes, at 1500s (the ~25-minute e2e). */
function e2eBaseline(): JobRecord[] {
	return [
		...kindSamples(E2E_REPO, 'e2e', 'claw-2', 1500),
		...kindSamples(E2E_REPO, 'e2e', 'claw-4', 1500),
	];
}

test('#8: kindSlowness reads one kind from successes, with no tier needed', () => {
	const records = [...e2eBaseline(), ...kindSamples(E2E_REPO, 'e2e', 'claw-1', 4500, 2)];
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	assert.equal(model.tierOf('claw-1'), 'unknown', 'one kind is far below MIN_KINDS');
	const k = model.kindSlowness?.('claw-1', E2E_REPO, 'e2e');
	assert.deepEqual(k, {
		repo: E2E_REPO,
		job: 'e2e',
		ratio: 3,
		extraSec: 3000,
		samples: 2,
		lowerBounds: 0,
	});
});

test('#8: a timeout and a long failure count as lower bounds — the worst node is not the unmeasured one', () => {
	// claw-1's real shape on 2026-10-27: a 60-minute timeout and an 82-minute
	// failure, no success. Successes alone would leave it unreadable.
	const records = [
		...e2eBaseline(),
		rec({ repo: E2E_REPO, name: 'e2e', runner: 'claw-1', runSec: 3600, conclusion: 'cancelled' }),
		rec({ repo: E2E_REPO, name: 'e2e', runner: 'claw-1', runSec: 4920, conclusion: 'failure' }),
	];
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	const k = model.kindSlowness?.('claw-1', E2E_REPO, 'e2e');
	assert.ok(k, 'two lower bounds clear MIN_KIND_SAMPLES');
	assert.equal(k.lowerBounds, 2);
	assert.equal(k.ratio, (3600 + 4920) / 2 / 1500);
	// The tier never sees them: a failure is not a speed sample there.
	assert.equal(model.describe('claw-1').kinds, 0);
});

test('#8: a failure SHORTER than the others-median says nothing about speed', () => {
	const records = [
		...e2eBaseline(),
		rec({ repo: E2E_REPO, name: 'e2e', runner: 'claw-1', runSec: 200, conclusion: 'failure' }),
		rec({ repo: E2E_REPO, name: 'e2e', runner: 'claw-1', runSec: 300, conclusion: 'failure' }),
	];
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	assert.equal(model.kindSlowness?.('claw-1', E2E_REPO, 'e2e'), null);
});

test('#8: kindSlowness is null below MIN_KIND_SAMPLES, below MIN_SAMPLES of others, and under TRIVIAL_SEC', () => {
	const one = buildSpeedModel(
		[...e2eBaseline(), ...kindSamples(E2E_REPO, 'e2e', 'claw-1', 4500, MIN_KIND_SAMPLES - 1)],
		{ nowMs: NOW, nodes: FLEET_NODES }
	);
	assert.equal(one.kindSlowness?.('claw-1', E2E_REPO, 'e2e'), null);

	// Two other claws, so only the sample count is short.
	const thinOthers = buildSpeedModel(
		[
			...kindSamples(E2E_REPO, 'e2e', 'claw-2', 1500, 2),
			...kindSamples(E2E_REPO, 'e2e', 'claw-4', 1500, MIN_SAMPLES - 3),
			...kindSamples(E2E_REPO, 'e2e', 'claw-1', 4500, 3),
		],
		{ nowMs: NOW, nodes: FLEET_NODES }
	);
	assert.equal(thinOthers.kindSlowness?.('claw-1', E2E_REPO, 'e2e'), null);

	const trivial = buildSpeedModel(
		[
			...kindSamples(E2E_REPO, 'ping', 'claw-2', TRIVIAL_SEC - 1),
			...kindSamples(E2E_REPO, 'ping', 'claw-1', 100, 3),
		],
		{ nowMs: NOW, nodes: FLEET_NODES }
	);
	assert.equal(trivial.kindSlowness?.('claw-1', E2E_REPO, 'ping'), null);
});

test('#8: kindsOn lists every readable kind on a node, matrix shards folded', () => {
	const records = [
		...e2eBaseline(),
		...kindSamples(E2E_REPO, 'e2e (3)', 'claw-1', 4500, 2),
		...kindSamples(E2E_REPO, 'lint', 'claw-2', 60),
		...kindSamples(E2E_REPO, 'lint', 'claw-4', 60),
		...kindSamples(E2E_REPO, 'lint', 'claw-1', 60, 2),
	];
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	const kinds = (model.kindsOn?.('claw-1') ?? []).map((k) => `${k.job}:${k.ratio}`).sort();
	assert.deepEqual(kinds, ['e2e:3', 'lint:1']);
});

test('#8: one other claw is not a baseline — a kind run by two claws reads nothing', () => {
	assert.equal(MIN_OTHER_NODES, 2);
	const records = [
		...kindSamples(E2E_REPO, 'forge-e2e', 'claw-8', 200, 20),
		...kindSamples(E2E_REPO, 'forge-e2e', 'claw-9', 400, 20),
	];
	const model = buildSpeedModel(records, {
		nowMs: NOW,
		nodes: [...FLEET_NODES, 'claw-8', 'claw-9'],
	});
	assert.equal(model.kindSlowness?.('claw-9', E2E_REPO, 'forge-e2e'), null);
});

test('#8: the guest is never read per kind, however slow', () => {
	const records = [...e2eBaseline(), ...kindSamples(E2E_REPO, 'e2e', 'hokon', 6000, 5)];
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	assert.equal(model.kindSlowness?.('hokon', E2E_REPO, 'e2e'), null);
	assert.deepEqual(model.kindsOn?.('hokon'), []);
});

test('#8: a node with enough successes is read from them — long failures of a flaky kind do not count', () => {
	// The baseline is successes only. Adding one side's failures would read a
	// kind that fails often everywhere as slow on whichever node is asked.
	const records = [
		...e2eBaseline(),
		...kindSamples(E2E_REPO, 'e2e', 'claw-1', 1600, MIN_SAMPLES),
		...Array.from({ length: 10 }, () =>
			rec({ repo: E2E_REPO, name: 'e2e', runner: 'claw-1', runSec: 5000, conclusion: 'failure' })
		),
	];
	const model = buildSpeedModel(records, { nowMs: NOW, nodes: FLEET_NODES });
	const k = model.kindSlowness?.('claw-1', E2E_REPO, 'e2e');
	assert.equal(k?.lowerBounds, 0);
	assert.equal(k?.ratio, 1600 / 1500);
});
