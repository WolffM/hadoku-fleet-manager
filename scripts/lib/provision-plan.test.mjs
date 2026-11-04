/**
 * The onboarding chain's DECISIONS, held by tests — because the chain itself
 * is fifteen steps of spawning, and the properties that make it safe to run
 * live in the small pure choices between them:
 *
 *   - which capabilities a fresh node owes a SEED for, derived from what
 *     bootcamp EARNED (never from parsing a failure message);
 *   - whether `ephemeral` may be flipped — the one manifest flag with an
 *     ordering dependency, and the one claw-8's gate caught being set without
 *     its provisioner;
 *   - what the health step owes, judged from the STORED record so an
 *     idempotent re-run changes nothing;
 *   - the manifest WRITE PATH (backfill + flip) proven against a FIXTURE
 *     checkout, the way `enroll-node.test.mjs` proves enroll's.
 *
 * The step ORDER is pinned in `onboarding-automation.test.mjs`, which reads
 * the chain as data; this file imports the decisions without running them.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const {
	ONBOARDING_STEPS,
	SEED_REMEDIES,
	seedPlan,
	flipDecision,
	healthStep,
	benchmarkStep,
	lanReserveStep,
	toolpackStep,
	BENCHMARK_DUE_DAYS,
	HEALTH_FRESH_DAYS,
	VERIFY,
	bootcampProbeArgs,
	verifyStepArgs,
	safeJson,
} = await import('./provision-plan.mjs');

// ── safeJson (F6, plan §4.1) ─────────────────────────────────────────────────
//
// The `catch {}` used to be empty — a parse failure vanished with no trace at
// all. It still returns a bare `null` on failure (its three call sites are
// pinned elsewhere, by `onboarding-automation.test.mjs`'s literal-source
// guard and by `benchmarkStep`'s own `!report` check), but the reason is no
// longer silently dropped: it goes to stderr. MUTATION: put the empty
// `catch {}` back and the second test below goes red (nothing on stderr).

test('safeJson parses, same as before', () => {
	assert.deepEqual(safeJson('{"ok":true}'), { ok: true });
	assert.equal(safeJson(''), null);
	assert.equal(safeJson(undefined), null);
});

test('safeJson on unparseable text still returns null, but says WHY on stderr', () => {
	const originalError = console.error;
	const lines = [];
	console.error = (...args) => lines.push(args.join(' '));
	try {
		const v = safeJson('not json at all');
		assert.equal(v, null, 'the return shape at this call site is unchanged');
	} finally {
		console.error = originalError;
	}
	assert.equal(lines.length, 1, 'the parse failure is reported exactly once, not swallowed');
	assert.match(lines[0], /safeJson/);
	assert.match(lines[0], /did not parse as JSON/);
});

// ── seedPlan ─────────────────────────────────────────────────────────────────

test('a fully-earned node owes no seeds — the idempotent re-run seeds nothing', () => {
	const earned = ['ffmpeg', 'python-venv', 'python-toolcache', 'playwright', 'jitconfig', 'gh'];
	assert.deepEqual(seedPlan(earned), []);
});

test('each unearned seedable capability maps to its own remedy command', () => {
	// The manual record's steps 3-5: bootcamp failed on python-toolcache and
	// playwright, the operator read the failure and typed two seed commands.
	// The chain derives the same remedies from the EARNED set.
	const plan = seedPlan(['ffmpeg']);
	assert.deepEqual(
		plan.map((r) => r.capability),
		['python-toolcache', 'playwright', 'jitconfig']
	);
	// The exact command each remedy runs — a wrong --what would seed the wrong
	// gigabytes and report success.
	const py = plan.find((r) => r.capability === 'python-toolcache');
	assert.equal(py.script, 'seed-runner-python.mjs');
	assert.deepEqual(py.argsFor('claw-9'), ['--machine', 'claw-9']);
	const pw = plan.find((r) => r.capability === 'playwright');
	assert.deepEqual(pw.argsFor('claw-9'), ['--machine', 'claw-9', '--what', 'playwright']);
	const jit = plan.find((r) => r.capability === 'jitconfig');
	assert.deepEqual(jit.argsFor('claw-9'), ['--machine', 'claw-9', '--what', 'payload']);
});

test('no earned set at all is every seed, not none — and not a crash', () => {
	assert.equal(seedPlan(null).length, SEED_REMEDIES.length);
	assert.equal(seedPlan(undefined).length, SEED_REMEDIES.length);
});

// ── flipDecision — payload before ephemeral, BOTH halves ─────────────────────

test('an already-ephemeral node is left alone', () => {
	const d = flipDecision({ entry: { ephemeral: true }, earned: [], payloadPresent: false });
	assert.equal(d.flip, false);
	assert.equal(d.state, 'already');
	assert.equal(d.remedy, undefined, 'no remedy — this is the green path');
});

test('jitconfig not earned refuses the flip, with the seed as the remedy', () => {
	const d = flipDecision({
		entry: {},
		earned: ['playwright', 'python-toolcache'],
		payloadPresent: true,
	});
	assert.equal(d.flip, false);
	assert.equal(d.state, 'not-earned');
	assert.match(d.remedy, /seed-cache/);
	assert.match(d.remedy, /payload/);
});

test('jitconfig EARNED but no payload still refuses — the claw-8 trap', () => {
	// The capability probe searches standing installs too, so a node can EARN
	// jitconfig with an empty payload directory. The flip removes the standing
	// install, leaving nothing to mint from. The flag alone is not enough.
	const d = flipDecision({ entry: {}, earned: ['jitconfig'], payloadPresent: false });
	assert.equal(d.flip, false);
	assert.equal(d.state, 'no-payload');
	assert.match(d.remedy, /payload/);
});

test('earned AND present flips — and ephemeral:false is not "already on"', () => {
	assert.deepEqual(flipDecision({ entry: {}, earned: ['jitconfig'], payloadPresent: true }), {
		flip: true,
		state: 'flip',
	});
	// `ephemeral: false` is a decision someone made, not a completed flip; the
	// strict-equality read is what keeps the chain from skipping it.
	assert.equal(
		flipDecision({ entry: { ephemeral: false }, earned: ['jitconfig'], payloadPresent: true }).flip,
		true
	);
});

// ── healthStep — the idempotence gate on the chain's last step ───────────────

/**
 * A clean health record shaped like `health.json`'s, on a controllable clock.
 *
 * The record's `at` is DERIVED FROM the clock the assertions pass in (one day
 * back), not an absolute date: `healthStep` takes `nowMs` injected, so the
 * fixture is a RELATIVE age and cannot rot the way a dated fixture does — the
 * fixture-clock guard exists because an absolute pair silently crosses
 * `HEALTH_FRESH_DAYS` months later and reddens main with no commit.
 */
const AT = Date.now();
const DAY_MS = 86_400_000;
function record(ageDays = 1, over = {}) {
	return {
		value: {
			at: new Date(AT - ageDays * DAY_MS).toISOString(),
			by: 'fleet doctor',
			node: 'claw-9',
			reachable: true,
			thermal: {
				sensor: 'coretemp',
				idleC: 40,
				loadC: 70,
				riseC: 30,
				loadSeconds: 60,
				loadWorkers: 12,
			},
			smart: { health: 'PASSED', device: 'sda', powerOnHours: 100 },
			disk: { freePct: 80 },
		},
		...over,
	};
}

test('a fresh record with no blocking findings skips the 60s load', () => {
	const v = healthStep(record(), { nowMs: AT });
	assert.equal(v.action, 'none');
	assert.match(v.why, /fresh/);
});

test('no record at all is PROBE — never a pass', () => {
	const v = healthStep(null, { nowMs: AT });
	assert.equal(v.action, 'probe');
	assert.match(v.why, /no usable/);
	// "I could not look" carries its reason, it is not swallowed.
	assert.match(healthStep({ unavailable: 'missing' }, { nowMs: AT }).why, /missing/);
});

test('a stale record re-probes at the fleet’s existing freshness window', () => {
	const v = healthStep(record(40), { nowMs: AT });
	assert.equal(v.action, 'probe');
	assert.match(v.why, /past 30d/);
	// The window MATCHES the fleet's conventions rather than inventing a third.
	assert.equal(HEALTH_FRESH_DAYS, 30);
	assert.equal(BENCHMARK_DUE_DAYS, 30);
});

test('a record saying unreachable is stale information, not a verdict — probe', () => {
	assert.equal(
		healthStep(record(1, { value: { ...record().value, reachable: false } }), { nowMs: AT }).action,
		'probe'
	);
});

test('a FRESH record with a blocking finding FAILS instead of re-probing pointlessly', () => {
	// A sensor that does not move is BLOCKING in the record and would be
	// blocking in a fresh probe; re-loading the box for 60s to relearn it helps
	// nobody. The findings are the remedy text.
	const v = healthStep(
		record(1, {
			value: {
				...record().value,
				thermal: { ...record().value.thermal, riseC: 4, loadC: 49 },
			},
		}),
		{ nowMs: AT }
	);
	assert.equal(v.action, 'fail');
	assert.match(v.why, /cpu-thermal/);
});

// ── benchmarkStep — the other idempotence gate, added after the live re-run ──
//
// Found by running the chain on claw-9 on 2026-09-23: the step passed the node
// POSITIONALLY to `benchmark`, and `--due` gates only the report and the
// fleet-wide sweep, so a named node was measured unconditionally. claw-9's
// record was 2.4 days old against a 30-day window and `--due 30 --report
// --json` said `due: []` at the same moment. The needless measurement then
// FAILED the chain: unprivileged, it lost `stability.aerCorrectable` against
// the stored rooted record and the degradation guard refused it.

/** A `benchmark --due N --report --json` document, shaped like the real one. */
const report = (over = {}) => ({
	at: new Date(AT).toISOString(),
	mode: 'report',
	results: {},
	failures: [],
	coverage: { never: [], stale: [], scoped: false },
	due: [],
	skippedByRole: [],
	degraded: [],
	findings: [],
	ok: true,
	...over,
});

test('a node that is NOT due is skipped — the re-run measures nothing', () => {
	// The exact document the live fleet returned while the old step measured anyway.
	const v = benchmarkStep(report(), 'claw-9');
	assert.equal(v.action, 'none');
	assert.match(v.why, /not due/);
});

test('a node that IS due is still measured — the skip must not swallow the work', () => {
	// `due` entries are objects carrying `.node`, which is why the reader
	// normalises rather than comparing raw elements.
	const v = benchmarkStep(report({ due: [{ node: 'claw-9', days: 41 }] }), 'claw-9');
	assert.equal(v.action, 'measure');
	assert.match(v.why, /DUE/);
	// and a DIFFERENT node being due does not drag this one in
	assert.equal(benchmarkStep(report({ due: [{ node: 'claw-2' }] }), 'claw-9').action, 'none');
});

test('never-measured and unreadable records both MEASURE, never skip', () => {
	// `coverage.never` holds bare node names and carries BOTH "no record at all"
	// and "the record exists and cannot be read" — benchmark-fleet's own
	// noRecordFinding keeps them apart in prose. Either way the answer is
	// measure: a box nobody measured is not a box that is fresh.
	assert.equal(
		benchmarkStep(report({ coverage: { never: ['claw-9'], stale: [] } }), 'claw-9').action,
		'measure'
	);
	assert.equal(
		benchmarkStep(
			report({ coverage: { never: [], stale: [{ node: 'claw-9', days: 55 }] } }),
			'claw-9'
		).action,
		'measure'
	);
});

test('a report that could not be READ fails — it is never a silent skip', () => {
	// "I could not look" must never render as "nothing is wrong". A step that
	// skipped here would stop measuring the fleet and keep reporting green,
	// which is the failure the whole freshness window exists to prevent.
	for (const unreadable of [null, undefined, '', 'not json', 42]) {
		const v = benchmarkStep(unreadable, 'claw-9');
		assert.equal(v.action, 'fail', `${JSON.stringify(unreadable)} must not be read as "not due"`);
	}
	// A document that parsed but carries no `due` list is the same thing: the
	// report was not readable, as distinct from a report that said "none due".
	const v = benchmarkStep(report({ due: null }), 'claw-9');
	assert.equal(v.action, 'fail');
	assert.match(v.why, /no `due` list/);
});

// ── lanReserveStep — R1 step 5, now a chain step ─────────────────────────────

test('a record that already matches the box is nothing to do', () => {
	const v = lanReserveStep({ ok: true, node: 'claw-9', written: false, record: { ip: '.9' } });
	assert.equal(v.action, 'none');
	assert.match(v.why, /matches/);
});

test('no record yet (or a mismatch) is WRITE, not a failure', () => {
	const v = lanReserveStep({
		ok: false,
		node: 'claw-9',
		written: false,
		proposal: { ip: '.9' },
		record: null,
	});
	assert.equal(v.action, 'write');
});

test('lan-reserve could not look (no ssh, no ipv4, undeclared) FAILS — never read as "write"', () => {
	const v = lanReserveStep({ ok: false, node: 'claw-9', error: 'claw-9 is not in the manifest' });
	assert.equal(v.action, 'fail');
	assert.match(v.why, /could not look/);
	assert.match(v.why, /not in the manifest/);
});

test('a write that did not land FAILS, distinct from a write never attempted', () => {
	const v = lanReserveStep({
		ok: false,
		node: 'claw-9',
		written: true,
		record: { ip: '.9' },
		landed: { ok: false, why: 'checkout is dirty' },
	});
	assert.equal(v.action, 'fail');
	assert.match(v.why, /dirty/);
});

test('an unparseable lan-reserve report fails, never reads as "already matches"', () => {
	for (const doc of [null, undefined, '', 'not json', 42]) {
		assert.equal(lanReserveStep(doc).action, 'fail', `${JSON.stringify(doc)} must fail`);
	}
});

// ── toolpackStep — R1 step 6, now a chain step ───────────────────────────────

/** A `toolpack <node> --json` document, shaped like the real one. */
const toolpackDoc = (report) => ({ at: new Date().toISOString(), report, findings: [], ok: true });

test('a node with no missing binaries is nothing to do', () => {
	const v = toolpackStep(
		toolpackDoc([{ node: 'claw-9', packs: ['base'], missing: [], apt: [] }]),
		'claw-9'
	);
	assert.equal(v.action, 'none');
	assert.match(v.why, /complete/);
});

test('a node missing a binary is INSTALL, and names the exact apt packages', () => {
	const v = toolpackStep(
		toolpackDoc([
			{
				node: 'claw-9',
				packs: ['base', 'wireless'],
				missing: [{ pack: 'wireless', bin: 'iw' }],
				apt: ['iw'],
			},
		]),
		'claw-9'
	);
	assert.equal(v.action, 'install');
	assert.match(v.why, /iw/);
	assert.deepEqual(v.apt, ['iw']);
});

test('a node toolpack could not look at (unreachable) FAILS, never reads as "complete"', () => {
	const v = toolpackStep(toolpackDoc([{ node: 'claw-9', error: 'ssh timed out' }]), 'claw-9');
	assert.equal(v.action, 'fail');
	assert.match(v.why, /ssh timed out/);
});

test('a report carrying no row for this node fails rather than passing vacuously', () => {
	const v = toolpackStep(toolpackDoc([{ node: 'claw-2', missing: [] }]), 'claw-9');
	assert.equal(v.action, 'fail');
	assert.match(v.why, /no row/);
});

test('an unparseable or mis-shaped toolpack report fails, never reads as "nothing missing"', () => {
	for (const doc of [null, undefined, '', 'not json', 42, { ok: true }]) {
		assert.equal(toolpackStep(doc, 'claw-9').action, 'fail', `${JSON.stringify(doc)} must fail`);
	}
});

// ── the chain table ──────────────────────────────────────────────────────────

test('the onboarding chain is the manual record, in order, ending on health', () => {
	const ids = ONBOARDING_STEPS.map((s) => s.id);
	assert.deepEqual(ids, [
		'declare',
		'lan-reserve',
		'toolpack',
		'node-users',
		'converge',
		'bootcamp',
		'placement',
		'register',
		'throttle',
		'slice',
		'realize',
		'benchmark',
		'health',
	]);
	// lan-reserve and toolpack (R1 steps 5-6) and the node-users reminder (R1
	// step 7) sit exactly where the manual record ran them BY HAND: after
	// declaration, before provision's own chain ever reached `converge`.
	assert.ok(
		ids.indexOf('declare') < ids.indexOf('lan-reserve') &&
			ids.indexOf('lan-reserve') < ids.indexOf('toolpack') &&
			ids.indexOf('toolpack') < ids.indexOf('node-users') &&
			ids.indexOf('node-users') < ids.indexOf('converge'),
		'declare → lan-reserve → toolpack → node-users → converge'
	);
	// toolpack's own constraint — its header: "Run this before bootcamp" —
	// holds with room to spare.
	assert.ok(ids.indexOf('toolpack') < ids.indexOf('bootcamp'));
	// The three deployers the old provision ran are still there, still in their
	// own dependency order, inside the chain.
	const deploys =
		ids.indexOf('register') < ids.indexOf('throttle') &&
		ids.indexOf('throttle') < ids.indexOf('slice');
	assert.ok(deploys, 'register → throttle → slice survives inside the chain');
	// and realize sits BETWEEN slice and benchmark — the hand step, placed
	// where the manual record needed it.
	assert.ok(
		ids.indexOf('slice') < ids.indexOf('realize') &&
			ids.indexOf('realize') < ids.indexOf('benchmark')
	);
	// node-users is a PRINTED reminder, never a call — see
	// onboarding-automation.test.mjs for the guard that it is never spawned.
	assert.equal(ONBOARDING_STEPS.find((s) => s.id === 'node-users').kind, 'print');
});

// --- a dry run installs nothing (2026-10-25 audit) ---------------------------
//
// provision printed "DRY RUN" and then ran bootcamp with no flags in its verify
// step, and bootcamp's default installs tools and seeds artifacts.

test('no verify step of a DRY RUN invokes bootcamp without --check-only', () => {
	const bootcampRows = VERIFY.filter((s) => s.script === 'bootcamp.mjs');
	assert.ok(
		bootcampRows.length > 0,
		'the verify pass still runs bootcamp — this test would be vacuous otherwise'
	);
	for (const step of bootcampRows) {
		assert.ok(verifyStepArgs(step, { confirm: false }).includes('--check-only'), step.name);
		assert.ok(
			!verifyStepArgs(step, { confirm: true }).includes('--check-only'),
			'an applied run installs, as asked'
		);
	}
});

test('the onboarding chain probes with --check-only unless --confirm', () => {
	assert.deepEqual(bootcampProbeArgs('claw-7', { confirm: false }), [
		'--machine',
		'claw-7',
		'--json',
		'--check-only',
	]);
	assert.deepEqual(bootcampProbeArgs('claw-7', { confirm: true }), [
		'--machine',
		'claw-7',
		'--json',
	]);
});
