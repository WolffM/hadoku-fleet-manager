/**
 * The rules the forced-placement harness decides by. Everything asserted here is
 * a sentence in `docs/planning/claw-floor-design-2026-09-07.md`; where a test
 * name quotes, it quotes that document.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	CallBudget,
	FLAKY_POINTS,
	MARGIN_BAR,
	MODE_FLAGS,
	MEASURED_RUNS,
	PER_NODE_SAMPLES,
	PROBE_CALLS,
	RANKING_JOBS,
	RECOVERY_PROBES,
	RERUN_CALL_CEILING,
	SHADOW_CALL_BUDGET,
	buildCandidateList,
	callsPerProbe,
	classifyZone,
	dailyCronMinutes,
	flakyVerdicts,
	foreignFlags,
	isBatchLane,
	isCiDemandRow,
	maxProbesPerRun,
	nodeZoneTable,
	parseMode,
	probeGate,
	quietWindow,
	shadowSafety,
	unitTable,
	warrantsForcedRerun,
	ZONE_NAMES,
	zoneOf,
} from './floor-probe.mjs';

// ---------------------------------------------------------------------------
// The zone classifier
// ---------------------------------------------------------------------------

test('GitHub own synthetic steps are the runner zone', () => {
	for (const step of ['Set up job', 'Set up runner', 'Complete job', 'Post Run actions/checkout']) {
		assert.equal(classifyZone({ failedStep: step, failedPhase: 'run' }), 'runner', step);
	}
});

test('no step record at all is the runner zone, not unknown', () => {
	// The master doc's own table: "or no step record". Calling it unknown and
	// declining to probe would discard the failures most likely to be ours.
	assert.equal(classifyZone({ conclusion: 'failure' }), 'runner');
	assert.equal(classifyZone({ failedStep: '   ' }), 'runner');
});

test('the two known real fleet bugs both classify as seam', () => {
	// `Set up Python` on claw-1 is the RUNNER_TOOL_CACHE gap; `Install` on claw-2
	// at hadoku-pygmalion ae94757 is the missing-pip gap. failedPhase calls both
	// of them `run`, which is why the classifier matches on the NAME.
	assert.equal(classifyZone({ failedStep: 'Set up Python', failedPhase: 'run' }), 'seam');
	assert.equal(classifyZone({ failedStep: 'Install', failedPhase: 'run' }), 'seam');
	assert.equal(
		classifyZone({ failedStep: 'Run actions/setup-node@v4', failedPhase: 'run' }),
		'seam'
	);
});

test("a consumer's own run: step is the content zone and does NOT earn a probe", () => {
	const rec = { failedStep: 'Run inventory test', failedPhase: 'run', conclusion: 'failure' };
	assert.equal(classifyZone(rec), 'content');
	const v = warrantsForcedRerun(rec);
	assert.equal(v.ok, false);
	assert.match(v.reason, /consumer/);
});

test('only a failure in the runner or seam zone earns a forced re-run', () => {
	assert.equal(warrantsForcedRerun({ failedStep: 'Set up job', conclusion: 'failure' }).ok, true);
	assert.equal(warrantsForcedRerun({ failedStep: 'Install', conclusion: 'failure' }).ok, true);
	// A SUCCESS never earns one, whatever its steps say. §6's safety property is
	// that a probe is never a consumer's only attempt; spending re-runs on green
	// jobs is the cheapest way to break the budget that protects it.
	assert.equal(warrantsForcedRerun({ failedStep: 'Set up job', conclusion: 'success' }).ok, false);
});

test('a CANCELLED job never earns a probe, whatever step it stopped on', () => {
	// 420 of the 639 non-success records in the live window are cancellations.
	// `cancel-in-progress` means the step a supersede lands on is arbitrary — and
	// `Post Run actions/setup-node@v6` classifies as the RUNNER zone purely
	// because teardown is where it happened to stop.
	for (const step of ['Post Run actions/setup-node@v6', 'Set up job', 'Install', undefined]) {
		const v = warrantsForcedRerun({ failedStep: step, conclusion: 'cancelled' });
		assert.equal(v.ok, false, `${step}`);
		assert.match(v.reason, /cancelled/);
	}
	// The ZONE is unchanged — the master doc's table still reads the same way.
	// What changes is whether a probe is spent on it.
	assert.equal(classifyZone({ failedStep: 'Set up job', conclusion: 'cancelled' }), 'runner');
});

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

// ---------------------------------------------------------------------------
// The flaky rule
// ---------------------------------------------------------------------------

const point = (against, node = 'claw-3') => ({
	node,
	repo: 'WolffM/hadoku-pygmalion',
	job: 'test',
	conclusion: 'success',
	against,
});
const ran = (node, conclusion) => ({
	node,
	repo: 'WolffM/hadoku-pygmalion',
	job: 'test',
	conclusion,
});

test('one cross-node point is never a verdict', () => {
	assert.deepEqual(flakyVerdicts([point('claw-2')]), []);
});

test('two points against the same triple with no intervening pass IS the verdict', () => {
	const v = flakyVerdicts([point('claw-2'), point('claw-2')]);
	assert.equal(v.length, 1);
	assert.equal(v[0].node, 'claw-2');
	assert.equal(v[0].job, 'test');
	assert.equal(v[0].points, FLAKY_POINTS);
});

test('an intervening pass on that node for that unit resets the points', () => {
	assert.deepEqual(
		flakyVerdicts([point('claw-2'), ran('claw-2', 'success'), point('claw-2')]),
		[],
		'"two such points ... with no intervening pass" is the rule, verbatim'
	);
});

test('the verdict is scoped to the unit, never to the node', () => {
	const v = flakyVerdicts([
		point('claw-2'),
		point('claw-2'),
		{ node: 'claw-3', repo: 'WolffM/hadoku_site', job: 'lint', conclusion: 'success' },
	]);
	assert.equal(v.length, 1);
	assert.equal(v[0].repo, 'WolffM/hadoku-pygmalion');
});

test('five consecutive clean probes clear a flaky verdict', () => {
	const history = [point('claw-2'), point('claw-2')];
	for (let i = 0; i < RECOVERY_PROBES; i++) history.push(ran('claw-2', 'success'));
	assert.deepEqual(flakyVerdicts(history), [], 'recovery is symmetric and un-sticky');
});

test('a failure part-way through recovery restarts the count', () => {
	const history = [point('claw-2'), point('claw-2')];
	for (let i = 0; i < RECOVERY_PROBES - 1; i++) history.push(ran('claw-2', 'success'));
	history.push(ran('claw-2', 'failure'));
	history.push(ran('claw-2', 'success'));
	assert.equal(flakyVerdicts(history).length, 1, 'CONSECUTIVE means consecutive');
});

// ---------------------------------------------------------------------------
// §7 — budget, at fleet size
// ---------------------------------------------------------------------------

test('one sweep of every claw fits inside the 200-call shadow cap', () => {
	// THE ARITHMETIC AT FLEET SIZE, which is the assertion the 2026-09-05 reap
	// change did not have. Every call a probe makes is UNCONDITIONAL — none of
	// them can send an ETag, because each poll exists precisely to see state
	// change — so the ceiling IS the spend.
	const CLAWS = 6; // every ephemeral node in fleet-runner-manifest.json today
	const cost = CLAWS * callsPerProbe();
	assert.ok(
		cost <= SHADOW_CALL_BUDGET,
		`a full sweep costs ${cost} calls against a ${SHADOW_CALL_BUDGET} cap`
	);
	assert.equal(maxProbesPerRun(), CLAWS, 'and the cap must not silently allow a seventh');
});

test('the shadow cap stays under 5% of the hourly budget even all in one hour', () => {
	const BUDGET_PER_HOUR = 5000; // GitHub primary limit, per token
	const REAP_PER_HOUR = 1620; // measured, api-budget-outage-2026-09-07.md
	assert.ok(SHADOW_CALL_BUDGET < BUDGET_PER_HOUR * 0.05);
	assert.ok(
		SHADOW_CALL_BUDGET + REAP_PER_HOUR < BUDGET_PER_HOUR / 2,
		'probing must not compete with the reap, the poll or the crons on this token'
	);
});

test('the meter binds within a run, not merely across runs', () => {
	const b = new CallBudget(callsPerProbe() * 2);
	assert.equal(b.take(callsPerProbe()), true);
	assert.equal(b.take(callsPerProbe()), true);
	assert.equal(b.take(callsPerProbe()), false, 'the third probe must not start');
	assert.equal(b.remaining, 0);
});

test('a probe cannot overrun its own declared cost', () => {
	// The declared per-probe cost is the harness's contract with the budget; a
	// component that could exceed it would make the cap arithmetic decorative.
	assert.equal(
		callsPerProbe(),
		PROBE_CALLS.dispatch + PROBE_CALLS.runLookupPolls + PROBE_CALLS.jobPolls + PROBE_CALLS.mint
	);
});

// ---------------------------------------------------------------------------
// §7 — the quiet window
// ---------------------------------------------------------------------------

/** The 11 staggered daily crons, hour 06 UTC, minutes 3..53 (board P6.6). */
const FLEET_SCHEDULES = Array.from({ length: 11 }, (_, i) => ({
	name: `repo-${i}`,
	minutesOfDay: 6 * 60 + 3 + i * 5,
}));

test('the fan-out band is not quiet, at fleet size', () => {
	// Every one of the 11 firings must close the window for the following 15
	// minutes, so the whole 06:03-06:53 band plus its tail is refused.
	for (let m = 6 * 60 + 3; m <= 6 * 60 + 53 + 14; m++) {
		const r = quietWindow({ nowMinutesOfDay: m, schedules: FLEET_SCHEDULES });
		assert.equal(r.quiet, false, `minute-of-day ${m} should not be quiet`);
		assert.equal(r.why, 'cron');
	}
});

test('the rest of the day is quiet — the cap is what bounds cost, not the window', () => {
	for (const m of [0, 5 * 60, 6 * 60 + 2, 7 * 60 + 8, 13 * 60, 23 * 60 + 59]) {
		assert.equal(
			quietWindow({ nowMinutesOfDay: m, schedules: FLEET_SCHEDULES }).quiet,
			true,
			`${m}`
		);
	}
});

test('a reserved hokon closes the window', () => {
	const r = quietWindow({
		nowMinutesOfDay: 13 * 60,
		reserved: true,
		reservationReason: 'cron-running',
		schedules: FLEET_SCHEDULES,
	});
	assert.equal(r.quiet, false);
	assert.equal(r.why, 'reserved');
});

test('no readable schedules is "could not tell", NEVER a quiet window', () => {
	// Eleven repos are known to carry daily crons, so zero schedules means the
	// reader failed. Probing on that basis is "I could not look" rendering as
	// "nothing is wrong" — the failure CLAUDE.md names first.
	const r = quietWindow({ nowMinutesOfDay: 13 * 60, schedules: [] });
	assert.equal(r.quiet, false);
	assert.equal(r.why, 'could-not-tell');
});

test('the cron parser refuses everything it does not fully understand', () => {
	assert.equal(dailyCronMinutes('3 6 * * *'), 6 * 60 + 3);
	assert.equal(dailyCronMinutes('0 6 * * SUN'), null, 'weekly would block the wrong day');
	assert.equal(dailyCronMinutes('*/10 * * * *'), null, 'a step field would block forever');
	assert.equal(dailyCronMinutes('0,30 6 * * *'), null);
	assert.equal(dailyCronMinutes('nonsense'), null);
	assert.equal(dailyCronMinutes(undefined), null);
});

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

test('manufactured samples are counted apart from organic ones', () => {
	const t = unitTable({
		key: KEY,
		roster: ['claw-1', 'claw-2'],
		samples: [
			{ node: 'claw-1', durationSec: 60, conclusion: 'success' },
			{ node: 'claw-1', durationSec: 64, conclusion: 'success', probe: 'shadow' },
			{ node: 'claw-2', durationSec: 90, conclusion: 'failure', probe: 'forced-rerun' },
		],
	});
	const one = t.rows.find((r) => r.node === 'claw-1');
	assert.deepEqual(
		{ organic: one.organic, shadow: one.shadow, rerun: one.rerun },
		{ organic: 1, shadow: 1, rerun: 0 }
	);
	const two = t.rows.find((r) => r.node === 'claw-2');
	assert.equal(two.rerun, 1);
	assert.equal(two.organic, 0, 'a rerun sample is conditioned on failure and is never a rate');
});

test('a node so broken it produced no samples still gets a row', () => {
	// No gate may get EASIER to pass the worse the failure gets. A row that
	// disappears is a row nobody notices.
	const t = unitTable({
		key: KEY,
		roster: ['claw-1', 'claw-4'],
		samples: [{ node: 'claw-1', durationSec: 60, conclusion: 'success' }],
	});
	const four = t.rows.find((r) => r.node === 'claw-4');
	assert.ok(four, 'claw-4 must appear');
	assert.equal(four.samples, 0);
	assert.equal(four.measured, false);
	assert.equal(four.p50Sec, null, 'absent, never guessed as 0');
});

test('the table attributes failures by zone', () => {
	const t = unitTable({
		key: KEY,
		roster: ['claw-2'],
		samples: [
			{ node: 'claw-2', durationSec: 5, conclusion: 'failure', failedStep: 'Set up job' },
			{ node: 'claw-2', durationSec: 50, conclusion: 'failure', failedStep: 'Tests' },
		],
	});
	assert.deepEqual(t.rows[0].zones, { runner: 1, content: 1 });
});

test('a job the fleet KILLED is its own zone, not the box failing to start one', () => {
	// The #22 signature: a duration within 5s of a TTL the fleet has minted, and
	// a failure in a cleanup step. `classifyZone` alone reads that as `runner` —
	// true, and indistinguishable from a node that could not start a job, which
	// is a completely different repair.
	const t = unitTable({
		key: KEY,
		roster: ['claw-3'],
		samples: [
			{
				node: 'claw-3',
				durationSec: 3601,
				conclusion: 'failure',
				failedStep: 'Post Run Swatinem/rust-cache@v2',
			},
		],
	});
	assert.deepEqual(t.rows[0].zones, { fleet: 1 });
	// And the three-zone rule the RERUN gate consults is unchanged — a fleet kill
	// is still runner-zone there, because §5.5 says so and because the gate's
	// question ("is this worth a probe") is a different question.
	assert.equal(
		classifyZone({ failedStep: 'Post Run Swatinem/rust-cache@v2', conclusion: 'failure' }),
		'runner'
	);
	assert.equal(
		zoneOf({ durationSec: 3601, conclusion: 'failure', failedStep: 'Post x' }),
		'fleet',
		'the fold is zoneOf’s, and only zoneOf’s'
	);
});

test('a job that ran to a TTL and PASSED is a coincidence, not a kill', () => {
	// The unit outlived the job. Counting it would report the fleet killing work
	// it demonstrably did not kill.
	assert.equal(
		zoneOf({ durationSec: 3600, conclusion: 'success', failedStep: 'Post x' }),
		'runner'
	);
	assert.equal(
		zoneOf({ durationSec: 3600, conclusion: 'failure', failedStep: 'Tests' }),
		'content',
		'a TTL-length failure in the consumer’s own step is not the cleanup signature'
	);
});

// ---------------------------------------------------------------------------
// The REPORT table — every node, every repo
// ---------------------------------------------------------------------------

/** One record. `conclusion` defaults to success so a fixture states only failures. */
const rec = (node, o = {}) => ({
	node,
	repo: 'WolffM/hadoku-pygmalion',
	durationSec: 60,
	conclusion: 'success',
	...o,
});

test('the report splits every node’s failures into the four zones, with explicit zeros', () => {
	const t = nodeZoneTable({
		roster: ['claw-1', 'claw-2'],
		samples: [
			rec('claw-2'),
			rec('claw-2', { conclusion: 'failure', failedStep: 'Set up runner' }),
			rec('claw-2', { conclusion: 'failure', failedStep: 'Install', failedPhase: 'run' }),
			rec('claw-2', { conclusion: 'failure', failedStep: 'Tests', failedPhase: 'run' }),
			rec('claw-2', {
				conclusion: 'failure',
				failedStep: 'Post Run actions/checkout@v4',
				durationSec: 3602,
			}),
			rec('claw-2', { conclusion: 'cancelled', failedStep: 'Post Run actions/setup-node@v6' }),
			rec('claw-1'),
		],
	});
	const two = t.rows.find((r) => r.node === 'claw-2');
	assert.deepEqual(two.zones, { runner: 1, seam: 1, content: 1, fleet: 1 });
	assert.equal(two.cancelled, 1, 'cancelled is counted, and NOT classified');
	assert.equal(two.failures, 4, 'a cancellation is not a failure');
	assert.equal(two.runnerSeam, 2, 'r+s excludes the fleet’s own kill');
	const one = t.rows.find((r) => r.node === 'claw-1');
	assert.deepEqual(
		one.zones,
		{ runner: 0, seam: 0, content: 0, fleet: 0 },
		'a clean node gets four explicit zeros — a sparse object renders like a node nobody looked at'
	);
});

test('a roster node with no records is a ROW that says why, never an absence', () => {
	// The queue-health lesson in its general form: a node so broken it produced
	// nothing must not vanish from the table that would have shown it.
	const t = nodeZoneTable({ roster: ['claw-1', 'claw-6'], samples: [rec('claw-1')] });
	const six = t.rows.find((r) => r.node === 'claw-6');
	assert.ok(six, 'claw-6 must appear');
	assert.equal(six.jobs, 0);
	assert.equal(six.why, 'no records in the window');
	assert.equal(six.runnerSeamPct, null, 'zero over zero is NO DATA, never 0%');
	assert.deepEqual(t.nodesWithNoData, ['claw-6']);
});

test('a record from outside the roster is kept, flagged, and still counted', () => {
	// `github-hosted` rows and any retired box are real jobs that really failed.
	// Dropping them would shrink the fleet's own denominator silently.
	const t = nodeZoneTable({
		roster: ['claw-1'],
		samples: [
			rec('claw-1'),
			rec('github-hosted', { conclusion: 'failure', failedStep: 'Set up Python' }),
		],
	});
	const hosted = t.rows.find((r) => r.node === 'github-hosted');
	assert.equal(hosted.inRoster, false);
	assert.equal(hosted.zones.seam, 1);
	assert.equal(t.totals.jobs, 2, 'the totals see it too');
	assert.equal(t.totals.seam, 1);
});

test('the report’s totals equal the sum of its rows', () => {
	// Two counts computed in two places is how a table stops adding up without
	// anyone reading it closely enough to notice.
	const t = nodeZoneTable({
		roster: ['claw-1', 'claw-2', 'claw-3'],
		samples: [
			rec('claw-1', { conclusion: 'failure', failedStep: 'Tests' }),
			rec('claw-2', { conclusion: 'failure' }),
			rec('claw-2', { conclusion: 'cancelled' }),
			rec('claw-3'),
		],
	});
	const sum = (f) => t.rows.reduce((a, r) => a + f(r), 0);
	assert.equal(
		t.totals.jobs,
		sum((r) => r.jobs)
	);
	assert.equal(
		t.totals.failures,
		sum((r) => r.failures)
	);
	assert.equal(
		t.totals.cancelled,
		sum((r) => r.cancelled)
	);
	for (const z of ZONE_NAMES)
		assert.equal(
			t.totals[z],
			sum((r) => r.zones[z]),
			z
		);
	// And every non-success record landed in exactly one bucket.
	assert.equal(
		ZONE_NAMES.reduce((a, z) => a + t.totals[z], 0) + t.totals.cancelled,
		3,
		'two failures and one cancellation, each counted once'
	);
});

test('`report` takes --days and --repo, and nothing that mints or re-runs', () => {
	// THE SAFETY PROPERTY of this mode, asserted rather than promised: the read-
	// only report may not be handed the flags that make the harness WRITE.
	assert.deepEqual(MODE_FLAGS.report, ['days', 'repo']);
	for (const writeFlag of ['confirm', 'onto', 'run', 'node', 'workflow', 'ignore-window']) {
		assert.ok(
			!MODE_FLAGS.report.includes(writeFlag),
			`report must not accept --${writeFlag}: it is read-only by construction`
		);
	}
	assert.deepEqual(
		foreignFlags('report', ['report', '--onto', 'claw-6', '--confirm']).map((f) => f.flag),
		['--onto', '--confirm'],
		'and passing one is a refusal, not a default'
	);
});

// ---------------------------------------------------------------------------
// §6 — never a consumer's only attempt
// ---------------------------------------------------------------------------

test('a workflow that ends in a production redeploy is refused as a shadow probe', () => {
	// hadoku-pygmalion's redeploy.yml, reduced. It holds the `test` job issue #3
	// is about AND a dispatch-redeploy job that takes prod pygmalion down and
	// back up. That is not a shadow run.
	const body = [
		'on:',
		'  push:',
		'    branches: [main]',
		'  workflow_dispatch:',
		'jobs:',
		'  dispatch-redeploy:',
		'    steps:',
		'      - run: curl -X POST https://api.github.com/repos/WolffM/hadoku_site/dispatches',
	].join('\n');
	const r = shadowSafety(body);
	assert.equal(r.ok, false);
	assert.match(r.reason, /dispatches/);
});

test('a plain test workflow is safe to dispatch', () => {
	const body = ['on:', '  pull_request:', '  workflow_dispatch:', 'jobs:', '  test:'].join('\n');
	assert.equal(shadowSafety(body).ok, true);
});

test('a workflow with no workflow_dispatch trigger is refused', () => {
	assert.equal(shadowSafety('on:\n  push:\njobs:\n  test:').ok, false);
});

test('the refusal list reads code, not comments', () => {
	// Three separate times this codebase has read a COMMENT as evidence. The
	// caller blanks comments before calling; this asserts the rule survives the
	// case that matters — tests.yml, whose ONLY mention of a dispatch is a
	// comment pointing at the workflow this list exists to refuse.
	const withComment = ['on:', '  workflow_dispatch:', 'jobs:', '  test:'].join('\n');
	assert.equal(shadowSafety(withComment).ok, true, 'the comment is gone by the time we see it');
	const blanked = withComment.replace('# gates the deploy dispatch', '');
	assert.equal(shadowSafety(blanked).ok, true);
});

test('only a probe that landed where it was AIMED counts as evidence about that node', () => {
	// A probe aimed at claw-2 and served by claw-1 is a real sample of claw-1 and
	// says nothing whatever about claw-2. Counting it as claw-2 evidence is how a
	// manufactured comparison manufactures the wrong answer.
	const t = unitTable({
		key: KEY,
		roster: ['claw-1', 'claw-2'],
		samples: [
			{
				node: 'claw-2',
				intendedNode: 'claw-2',
				probe: 'shadow',
				durationSec: 100,
				conclusion: 'success',
			},
			{
				node: 'claw-1',
				intendedNode: 'claw-2',
				probe: 'shadow',
				durationSec: 90,
				conclusion: 'success',
			},
		],
	});
	const two = t.rows.find((r) => r.node === 'claw-2');
	const one = t.rows.find((r) => r.node === 'claw-1');
	assert.equal(two.pinned, 1, 'the one that landed on claw-2');
	assert.equal(one.shadow, 1, 'the missed one is still a sample...');
	assert.equal(one.pinned, 0, '...of claw-1, and it was not aimed there');
});

test('the rerun ceiling is not the shadow cap, and does not eat into it', () => {
	// §7: the forced re-run rides the EXISTING budget. Metering it against the
	// shadow allowance would mean declining to investigate a real fleet failure
	// because a synthetic sweep had spent the allowance first.
	assert.notEqual(RERUN_CALL_CEILING, SHADOW_CALL_BUDGET);
	assert.ok(RERUN_CALL_CEILING < SHADOW_CALL_BUDGET, 'it is a sanity bound, not an allowance');
	// A re-run must still be able to watch a job for as long as a shadow probe can.
	assert.ok(RERUN_CALL_CEILING > PROBE_CALLS.jobPolls);
});

test('a spent blackout stops the probe and SAYS WHICH', () => {
	// A spent token budget, a spent probe allowance and a call that simply failed
	// are three different jobs. The blackout wins, because it is one fact about
	// the TOKEN rather than a fault in one call — retrying it is arithmetic that
	// cannot come out differently until the reset.
	const b = new CallBudget(10);
	assert.match(probeGate(b, 45_000), /primary GitHub budget/);
	assert.equal(b.spent, 0, 'a suppressed call must not spend the allowance too');
	assert.equal(probeGate(b, 0), null);
	assert.equal(b.spent, 1);
});

test('a spent probe allowance stops the probe, and says so differently', () => {
	const b = new CallBudget(1);
	assert.equal(probeGate(b, 0), null);
	assert.match(probeGate(b, 0), /probe budget is spent/);
});

test('the zone classifier is only ever consulted about a job that did not succeed', () => {
	// `unitTable` classifies FAILURES; a success has no failedStep, and asking the
	// classifier about one would return `runner` (its no-step-record answer) and
	// attribute a green run to the fleet.
	const t = unitTable({
		key: KEY,
		roster: ['claw-1'],
		samples: [
			{ node: 'claw-1', durationSec: 10, conclusion: 'success' },
			{ node: 'claw-1', durationSec: 10, conclusion: 'success' },
		],
	});
	assert.deepEqual(t.rows[0].zones, {}, 'a green node has no zones at all');
	assert.equal(t.rows[0].failures, 0);
});

// ---------------------------------------------------------------------------
// The argv parser — `node-scoping.test.mjs` flagged this file and was RIGHT
// ---------------------------------------------------------------------------

test('the mode is the FIRST argument, never a scan for the first non-flag token', () => {
	// `argv.find((a) => !a.startsWith('--'))` was the old parser, and it is the
	// shape bootcamp's `--machine=claw-7 --write` bug was made of. It does not
	// read a positional — it reads the first token not spelled like a flag, which
	// includes A FLAG'S VALUE. Both of these were measured against this command's
	// own arguments before the fix.
	assert.equal(parseMode(['--unit', 'WolffM/hadoku_site#lint']), 'table');
	assert.equal(
		parseMode(['--onto', 'claw-6', '--repo', 'WolffM/x', '--run', '1']),
		'table',
		'the old parser returned "claw-6" here — a NODE NAME read from a bare positional'
	);
});

test('an explicit mode still wins, and an unknown one comes back as itself', () => {
	assert.equal(parseMode(['rerun', '--onto', 'claw-6']), 'rerun');
	assert.equal(parseMode(['window']), 'window');
	// NOT silently defaulted. A typo that falls back to `table` is a report
	// nobody asked for, printed instead of an error.
	assert.equal(parseMode(['tabel']), 'tabel');
	assert.equal(parseMode([]), 'table');
	assert.equal(parseMode(['--json']), 'table');
});

test('a flag belonging to another mode is refused, not silently defaulted', () => {
	// The hole the mode fix opened: with the mode pinned to argv[0],
	// `--onto claw-6 --repo … --run …` parses as no mode, falls back to `table`,
	// and prints a table of an unrelated unit at exit 0.
	const foreign = foreignFlags('table', ['--onto', 'claw-6', '--repo', 'WolffM/x', '--run', '1']);
	assert.deepEqual(
		foreign.map((f) => f.flag),
		['--onto', '--repo', '--run']
	);
	assert.deepEqual(foreign[0].owners, ['rerun'], 'and it says which mode does take it');
});

test('every mode accepts its own flags and --json', () => {
	for (const [mode, flags] of Object.entries(MODE_FLAGS)) {
		const argv = [mode, '--json', ...flags.flatMap((f) => [`--${f}`, 'x'])];
		assert.deepEqual(foreignFlags(mode, argv), [], `${mode} rejected one of its own flags`);
		// `--flag=value` is the spelling machineArg was blind to fleet-wide. It
		// must parse the same way here.
		const eq = [mode, ...flags.map((f) => `--${f}=x`)];
		assert.deepEqual(foreignFlags(mode, eq), [], `${mode} did not understand --flag=value`);
	}
});

test('an unknown mode reports only that, not a cascade of foreign flags', () => {
	assert.deepEqual(foreignFlags('tabel', ['--unit', 'x']), []);
});

// ---------------------------------------------------------------------------
// The composite key
// ---------------------------------------------------------------------------

test('a job name containing a space survives the flaky triple key', () => {
	// `hadoku_site` really has a job called `Build variants`. With a SPACE
	// separator the key destructures to job `Build` — a verdict scoped to a unit
	// that does not exist, which is exactly the mis-attribution §5.4 forbids.
	const v = flakyVerdicts([
		{
			node: 'claw-3',
			repo: 'WolffM/hadoku_site',
			job: 'Build variants',
			conclusion: 'success',
			against: 'claw-2',
		},
		{
			node: 'claw-3',
			repo: 'WolffM/hadoku_site',
			job: 'Build variants',
			conclusion: 'success',
			against: 'claw-2',
		},
	]);
	assert.equal(v.length, 1);
	assert.deepEqual(
		{ node: v[0].node, repo: v[0].repo, job: v[0].job },
		{ node: 'claw-2', repo: 'WolffM/hadoku_site', job: 'Build variants' }
	);
});

test('this module carries no unprintable literals', () => {
	// It carried seven NUL bytes — the composite-key separator, typed rather than
	// escaped. Everything WORKED: join and split agreed. But git classifies a file
	// containing a NUL as binary, so `git diff`, `git grep` and code review all
	// went silent on it, which is how it survived a full review pass.
	const here = new URL('.', import.meta.url).pathname;
	for (const f of ['floor-probe.mjs', 'floor-probe.test.mjs']) {
		const raw = readFileSync(join(here, f));
		const at = raw.indexOf(0);
		assert.equal(at, -1, `${f} contains a NUL byte at offset ${at} — write it as \\u0000`);
	}
});
