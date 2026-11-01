/**
 * floor-probe's §2-4 candidate-ranking rule and the §1.2 demand-ledger class
 * rule — split out of `floor-probe.test.mjs` (wave 5q lane A, whole-block
 * split) so that file reaches the 1,000-line test ceiling. These exercise
 * `floor-probe-ranking.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
	MARGIN_BAR,
	MEASURED_RUNS,
	PER_NODE_SAMPLES,
	RANKING_JOBS,
	buildCandidateList,
	isBatchLane,
	isCiDemandRow,
} from './floor-probe-ranking.mjs';

// ---------------------------------------------------------------------------
// The candidate list
// ---------------------------------------------------------------------------

const ROSTER = ['claw-1', 'claw-2', 'claw-3', 'claw-4', 'claw-5', 'claw-6'];
const KEY = { repo: 'WolffM/hadoku_site', job: 'Build variants' };

const runs = (node, durations, extra = {}) =>
	durations.map((durationSec) => ({ node, durationSec, conclusion: 'success', ...extra }));

/**
 * `n` samples at `typical`, with two slow outliers.
 *
 * THE OUTLIERS ARE THE POINT, not noise in a fixture. §8's batch-lane rule
 * compares a node's median against the REST of the fleet's p95, and a fixture
 * of perfectly flat per-node constants makes that p95 equal to the fastest
 * node's median — so every slower node reads as batch-lane and every ordering
 * assertion below would be testing §8 instead of §2. Real per-node populations
 * have tails (measured: 1.57x within-node spread, master §5.1a); these have two.
 */
const spread = (node, typical, slow = typical * 3, n = RANKING_JOBS) =>
	runs(node, [...Array.from({ length: n - 2 }, () => typical), slow, slow]);

test('"weakest that can carry it" sorts DESCENDING by p50 — the slowest first', () => {
	const samples = [
		...spread('claw-1', 50, 150),
		...spread('claw-2', 110, 110),
		...spread('claw-3', 85, 160),
	];
	const list = buildCandidateList({ key: KEY, samples, roster: ROSTER.slice(0, 3) });
	assert.equal(list.floorConfidence, 'measured');
	assert.deepEqual(
		list.candidates.map((c) => c.node),
		['claw-2', 'claw-3', 'claw-1'],
		'ascending would put the FASTEST node first, which is the whole mistake'
	);
});

test('below 10 measured runs the unit is cold-start and keeps the roster order', () => {
	const samples = runs('claw-3', [10, 11, 12]);
	const list = buildCandidateList({ key: KEY, samples, roster: ROSTER });
	assert.equal(list.floorConfidence, 'cold-start');
	assert.equal(list.measuredRuns, 3);
	assert.ok(list.measuredRuns < MEASURED_RUNS);
	assert.deepEqual(
		list.candidates.map((c) => c.node),
		ROSTER,
		'a cold-start list is unranked but STILL a valid, eligibility-filtered list'
	);
	for (const c of list.candidates) {
		assert.equal(c.p50Sec, undefined);
		assert.equal(c.margin, undefined);
	}
});

test('an unmeasured node sorts LAST, not out', () => {
	const samples = [...spread('claw-1', 50, 150), ...spread('claw-2', 110, 110)];
	const list = buildCandidateList({ key: KEY, samples, roster: ['claw-1', 'claw-2', 'claw-6'] });
	const names = list.candidates.map((c) => c.node);
	assert.equal(names.at(-1), 'claw-6', 'never looked at is not the same as cannot run it');
	assert.equal(names.length, 3, 'and it is still a candidate — sorted last, not dropped');
	assert.equal(list.excluded.length, 0, '`excluded` is for certainties, not for ignorance');
});

test('a candidate below the margin bar is not excluded, only not tried first', () => {
	// claw-2's p95 is 6000s against a 10800s timeout — margin 1.8, under the bar.
	// claw-1's p95 is 600s — margin 18. Weakest-first would put claw-2 first on
	// p50 alone; the margin bar overrides that and nothing is dropped.
	const samples = [
		...runs(
			'claw-1',
			Array.from({ length: RANKING_JOBS }, () => 500)
		),
		...runs(
			'claw-2',
			Array.from({ length: RANKING_JOBS }, () => 6000)
		),
	];
	// claw-2 is batch-lane here too (6000 > claw-1's p95 of 500) — this test is
	// about the margin bar, so the assertion below reads the margin, not the rank.
	const list = buildCandidateList({
		key: KEY,
		samples,
		roster: ['claw-1', 'claw-2'],
		timeoutSec: 10_800,
	});
	const [first, second] = list.candidates;
	assert.equal(first.node, 'claw-1');
	assert.equal(second.node, 'claw-2');
	assert.ok(second.margin < MARGIN_BAR, `margin ${second.margin} should be under ${MARGIN_BAR}`);
	assert.equal(list.candidates.length, 2, "GitHub's own timeout is still the backstop");
});

test('a flaky candidate goes behind every non-flaky one, regardless of margin', () => {
	const samples = [...spread('claw-1', 50, 150), ...spread('claw-2', 110, 110)];
	const list = buildCandidateList({
		key: KEY,
		samples,
		roster: ['claw-1', 'claw-2'],
		flaky: [{ node: 'claw-2', repo: KEY.repo, job: KEY.job }],
	});
	assert.deepEqual(
		list.candidates.map((c) => c.node),
		['claw-1', 'claw-2']
	);
	assert.equal(list.candidates.at(-1).flaky, true);
	assert.equal(list.excluded.length, 0, 'a flaky verdict is elevated risk, not incapability');
});

test('the flaky scope is (node, repo, job) — the same node on another unit is untouched', () => {
	const other = { repo: KEY.repo, job: 'lint' };
	const samples = [...spread('claw-1', 50, 150), ...spread('claw-2', 110, 110)];
	const list = buildCandidateList({
		key: other,
		samples,
		roster: ['claw-1', 'claw-2'],
		flaky: [{ node: 'claw-2', repo: KEY.repo, job: KEY.job }],
	});
	assert.equal(list.candidates[0].node, 'claw-2', "claw-2's OOM history is not incapability");
	assert.equal(list.candidates[0].flaky, false);
});

test('eligibility exclusions are removed before anything is ranked', () => {
	const samples = [...spread('claw-1', 50, 150), ...spread('claw-5', 400, 400)];
	const list = buildCandidateList({
		key: KEY,
		samples,
		roster: ['claw-1', 'claw-5'],
		excluded: [{ node: 'claw-5', reason: 'drained' }],
	});
	assert.deepEqual(
		list.candidates.map((c) => c.node),
		['claw-1'],
		'never rank a drained node — rank it as ABSENT, not slow'
	);
});

test('§8 batch lane is a measured relationship, not a hardcoded machine', () => {
	// claw-5's median exceeds the rest of the fleet's p95 for this unit.
	assert.equal(isBatchLane([180, 179, 181], [60, 62, 58, 61, 70]), true);
	assert.equal(isBatchLane([60, 62, 58], [60, 62, 58, 61, 70]), false);
	// With nobody to compare against there is no fast node being kept free, so
	// the rule has no meaning and must not fire.
	assert.equal(isBatchLane([180, 179], []), false);
});

test('a batch-lane candidate is never tried first', () => {
	const samples = [
		...runs(
			'claw-1',
			Array.from({ length: RANKING_JOBS }, () => 60)
		),
		...runs(
			'claw-2',
			Array.from({ length: RANKING_JOBS }, () => 70)
		),
		...runs(
			'claw-5',
			Array.from({ length: RANKING_JOBS }, () => 900)
		),
	];
	const list = buildCandidateList({ key: KEY, samples, roster: ['claw-1', 'claw-2', 'claw-5'] });
	assert.equal(list.candidates.at(-1).node, 'claw-5');
	assert.equal(list.candidates.at(-1).batchLane, true);
	assert.equal(list.candidates[0].node, 'claw-2', 'weakest of the latency pool, still first');
});

test('a claw under the 20-routable-jobs bar is not ranked even on a measured unit', () => {
	const samples = [...spread('claw-1', 50, 150), ...runs('claw-6', [300, 310])];
	const list = buildCandidateList({ key: KEY, samples, roster: ['claw-1', 'claw-6'] });
	const six = list.candidates.find((c) => c.node === 'claw-6');
	assert.equal(six.measured, false);
	assert.equal(six.p50Sec, undefined, 'two points is not a p50, it is a guess with a decimal');
	assert.equal(six.sampleCount, 2, 'the samples are still reported — they are just not a ranking');
	assert.equal(list.candidates.at(-1).node, 'claw-6');
});

// ---------------------------------------------------------------------------
// The minimum-n rule — PER_NODE_SAMPLES
// ---------------------------------------------------------------------------

/**
 * The live defect, as a fixture.
 *
 * `WolffM/hadoku_site#site-tests`, measured 2026-09-10: claw-6 ranked 4th on
 * n=3 (31 s, 86 s, 93 s) between claw-2 on n=121 and claw-4 on n=24. Every node
 * here is past the 20-routable-jobs bar — that is the point, since
 * `routableJobsByNode` counts ALL units and cannot see a thin (node, unit) —
 * so the only thing that can refuse the ordering is the per-node sample count.
 */
const SITE_TESTS = {
	samples: [
		...runs(
			'claw-2',
			Array.from({ length: 121 }, (_, i) => (i < 115 ? 87 : 160))
		),
		...runs(
			'claw-4',
			Array.from({ length: 24 }, (_, i) => (i < 22 ? 81 : 99))
		),
		...runs('claw-6', [31, 86, 93]),
	],
	routableJobsByNode: { 'claw-2': 1200, 'claw-4': 450, 'claw-6': 380 },
	roster: ['claw-2', 'claw-4', 'claw-6'],
};

test('an n<10 node is never ordered above an n>=10 one, even with a slower p50', () => {
	const list = buildCandidateList({ key: KEY, ...SITE_TESTS });
	assert.equal(list.floorConfidence, 'measured');
	const six = list.candidates.find((c) => c.node === 'claw-6');
	assert.equal(six.sampleCount, 3);
	assert.equal(six.thinSample, true);
	// The fixture only proves anything while claw-6's median BEATS claw-4's on
	// weakest-first: median([31, 86, 93]) = 86 against claw-4's 81, which is the
	// live ordering that put n=3 above n=24.
	assert.equal(six.sampleCount, 3);
	const order = list.candidates.map((c) => c.node);
	assert.ok(
		order.indexOf('claw-6') > order.indexOf('claw-4'),
		`n=3 ranked above n=24 — the live 2026-09-10 defect: ${order.join(' > ')}`
	);
	assert.ok(order.indexOf('claw-6') > order.indexOf('claw-2'), 'and above n=121');
});

test('every thin candidate sits behind every ranked one — no exception by margin', () => {
	const list = buildCandidateList({ key: KEY, ...SITE_TESTS });
	const ranked = list.candidates.filter((c) => c.measured);
	const thin = list.candidates.filter((c) => c.thinSample);
	assert.ok(ranked.length && thin.length, 'the fixture must contain both kinds');
	const lastRanked = Math.max(...ranked.map((c) => list.candidates.indexOf(c)));
	const firstThin = Math.min(...thin.map((c) => list.candidates.indexOf(c)));
	assert.ok(firstThin > lastRanked, 'a thin sample may never outrank a ranked one');
});

test('a thin node is unranked, and says WHICH kind of unranked it is', () => {
	const list = buildCandidateList({ key: KEY, ...SITE_TESTS });
	const six = list.candidates.find((c) => c.node === 'claw-6');
	assert.equal(six.measured, false, 'three points is not a p50, it is a guess with a decimal');
	assert.equal(six.p50Sec, undefined);
	assert.equal(six.margin, undefined);
	assert.equal(six.sampleCount, 3, 'the samples are still reported — they are not a ranking');
	assert.equal(six.thinSample, true, 'three samples is not the same finding as zero');
	assert.equal(six.batchLane, false, 'a batch-lane verdict off three points is not a verdict');
});

test('n=0 and n=3 are both unranked but are NOT the same finding', () => {
	const list = buildCandidateList({
		key: KEY,
		samples: [...SITE_TESTS.samples],
		roster: [...SITE_TESTS.roster, 'claw-7'],
		routableJobsByNode: { ...SITE_TESTS.routableJobsByNode, 'claw-7': 380 },
	});
	const seven = list.candidates.find((c) => c.node === 'claw-7');
	assert.equal(seven.measured, false);
	assert.equal(seven.sampleCount, 0);
	assert.equal(seven.thinSample, false, 'never looked is not barely looked');
	const order = list.candidates.map((c) => c.node);
	assert.ok(
		order.indexOf('claw-6') < order.indexOf('claw-7'),
		'inside the unranked tail, the node we know something about comes first'
	);
});

test('PER_NODE_SAMPLES is MEASURED_RUNS — one definition of "enough runs"', () => {
	// Two thresholds that mean the same thing agree until one of them moves.
	assert.equal(PER_NODE_SAMPLES, MEASURED_RUNS);
	assert.equal(PER_NODE_SAMPLES, 10);
});

test('exactly ten samples is thick — the rule is n<10, not n<=10', () => {
	const ten = buildCandidateList({
		key: KEY,
		// claw-2 carries a slow tail so that claw-6 at 300 s is not ALSO a §8
		// batch-lane node — that key runs first and would hide what this asserts.
		samples: [
			...spread('claw-2', 50, 900),
			...runs(
				'claw-6',
				Array.from({ length: PER_NODE_SAMPLES }, () => 300)
			),
		],
		roster: ['claw-2', 'claw-6'],
		routableJobsByNode: { 'claw-2': 400, 'claw-6': 400 },
	});
	const six = ten.candidates.find((c) => c.node === 'claw-6');
	assert.equal(six.thinSample, false);
	assert.equal(six.measured, true);
	assert.equal(ten.candidates[0].node, 'claw-6', 'and weakest-first then puts it FIRST');
});

test('one node with ten samples still ranks while its thin neighbours do not', () => {
	// The guard must not be a blanket refusal to rank: a unit past MEASURED_RUNS
	// whose samples sit on ONE node still gets that node as its floor.
	const list = buildCandidateList({
		key: KEY,
		samples: [...spread('claw-1', 50, 150), ...runs('claw-6', [900, 910, 920])],
		roster: ['claw-1', 'claw-6'],
		routableJobsByNode: { 'claw-1': 400, 'claw-6': 400 },
	});
	assert.equal(list.candidates[0].node, 'claw-1');
	assert.equal(list.candidates[0].measured, true);
	assert.equal(list.candidates[1].node, 'claw-6');
	assert.equal(
		list.candidates[1].measured,
		false,
		'claw-6 would otherwise be the floor on three samples — and it is the SLOWEST'
	);
});

// ---------------------------------------------------------------------------
// §1.2 — the demand ledger's two classes
// ---------------------------------------------------------------------------

test('a row with no class is a CI row — that is every row in the live ledger', () => {
	// Measured 2026-09-10: 147 rows, `class` absent on all of them.
	const row = { repo: 'WolffM/hadoku_site', job: 'site-tests', capabilities: ['playwright'] };
	assert.equal(isCiDemandRow(row, { repo: 'WolffM/hadoku_site', job: 'site-tests' }), true);
	assert.equal(isCiDemandRow({ ...row, class: 'ci' }, { repo: row.repo, job: row.job }), true);
});

test('a RESIDENT row is never folded into a CI job demand', () => {
	// A PM2 service's capabilities unioned into a CI job's required set excludes
	// every claw that cannot satisfy them — an empty candidate list wearing
	// `excluded`'s certainty.
	const resident = {
		class: 'resident',
		kind: 'pm2',
		repo: 'WolffM/hadoku_site',
		job: 'site-tests',
		capabilities: ['vault-broker', 'raid'],
	};
	assert.equal(isCiDemandRow(resident, { repo: 'WolffM/hadoku_site', job: 'site-tests' }), false);
});

test('a class this reader has never heard of is refused, not adopted', () => {
	const future = { class: 'gpu-batch', repo: 'r', job: 'j', capabilities: ['cuda'] };
	assert.equal(isCiDemandRow(future, { repo: 'r', job: 'j' }), false);
});

test('the (repo, job) scope still applies, and a non-object is not a row', () => {
	const row = { repo: 'r', job: 'j' };
	assert.equal(isCiDemandRow(row, { repo: 'r', job: 'other' }), false);
	assert.equal(isCiDemandRow(row, { repo: 'other', job: 'j' }), false);
	assert.equal(isCiDemandRow(row), true, 'no scope given means class-only');
	assert.equal(isCiDemandRow(null, { repo: 'r', job: 'j' }), false);
	assert.equal(isCiDemandRow('ci', { repo: 'r', job: 'j' }), false);
});
