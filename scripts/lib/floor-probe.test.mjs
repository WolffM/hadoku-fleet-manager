/**
 * The rules the forced-placement harness decides by. Everything asserted here is
 * a sentence in `docs/planning/claw-floor-design-2026-09-07.md`; where a test
 * name quotes, it quotes that document.
 *
 * SPLIT, WAVE 5Q LANE A (whole-block split, this file was 1,058 lines): the
 * candidate ranking and demand-ledger tests are `floor-probe-ranking.test.mjs`;
 * the flaky-rule and composite-key tests are `floor-probe-flaky.test.mjs`; the
 * quiet-window tests are `floor-probe-window.test.mjs`; the two table tests are
 * `floor-probe-rows.test.mjs`; the shadow-safety tests are
 * `floor-probe-safety.test.mjs`. What stays here is the zone classifier, the
 * call budget and the argv/mode contract — `floor-probe.mjs`'s own remaining
 * surface after that split.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
	CallBudget,
	MODE_FLAGS,
	PROBE_CALLS,
	RERUN_CALL_CEILING,
	SHADOW_CALL_BUDGET,
	callsPerProbe,
	foreignFlags,
	maxProbesPerRun,
	parseMode,
	probeGate,
	warrantsForcedRerun,
} from './floor-probe.mjs';
import { classifyZone } from '../../dist/job-history-zone.js';

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

test('a consumer-named step is content whatever its recorded phase (records before the order fix)', () => {
	// Records written before 2026-11-02 carry clock-derived phases: a one-second
	// tie put hadoku-cardtable's `check` aggregator in cleanup, and the DST hour
	// put hadoku_site's `Identity-model gate` in setup. The NAME decides.
	assert.equal(
		classifyZone({
			failedStep: 'Every job is green',
			failedPhase: 'cleanup',
			conclusion: 'failure',
		}),
		'content'
	);
	assert.equal(
		classifyZone({
			failedStep: 'Identity-model gate',
			failedPhase: 'setup',
			conclusion: 'failure',
		}),
		'content'
	);
	assert.equal(classifyZone({ failedStep: 'Complete job', failedPhase: 'cleanup' }), 'runner');
	assert.equal(
		classifyZone({ failedStep: 'Post Cache cargo build', failedPhase: 'cleanup' }),
		'runner'
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
// §7 — the forced re-run ceiling, and the blackout
// ---------------------------------------------------------------------------

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
