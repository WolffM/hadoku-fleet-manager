/**
 * floor-probe's two read-only tables — split out of `floor-probe.test.mjs`
 * (wave 5q lane A, whole-block split) so that file reaches the 1,000-line
 * test ceiling. These exercise `floor-probe-rows.mjs`; `classifyZone`/
 * `zoneOf` come from `floor-probe.mjs` (re-exported there), which is what
 * some of these tests check `unitTable`'s own fold against.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MODE_FLAGS, classifyZone, foreignFlags, zoneOf } from './floor-probe.mjs';
import { ZONE_NAMES, nodeZoneTable, unitTable } from './floor-probe-rows.mjs';

const KEY = { repo: 'WolffM/hadoku_site', job: 'Build variants' };

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
