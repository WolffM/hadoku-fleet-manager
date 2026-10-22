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
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanGitEnv, FIXTURE_IDENTITY } from './lib/test-git-identity.mjs';

const {
	ONBOARDING_STEPS,
	SEED_REMEDIES,
	seedPlan,
	flipDecision,
	healthStep,
	benchmarkStep,
	fastForwardManifest,
	applyPlacementWrite,
	BENCHMARK_DUE_DAYS,
	HEALTH_FRESH_DAYS,
} = await import('./provision-fleet.mjs');

const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

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

test('the step asks the report BEFORE it measures, and asks the cron’s question', () => {
	const src = readFileSync(new URL('./provision-fleet.mjs', import.meta.url), 'utf8');
	const phase = src.slice(
		src.indexOf('function benchmarkPhase'),
		src.indexOf('function healthPhase')
	);
	// The report call is `--report --json`, with no node positional: a node
	// named positionally is measured unconditionally, which is the whole bug.
	const reportAt = phase.indexOf("'--report'");
	const decideAt = phase.indexOf('benchmarkStep(');
	const measureAt = phase.indexOf("'--write'");
	assert.ok(reportAt >= 0 && decideAt > reportAt, 'the report is read before the decision');
	assert.ok(measureAt > decideAt, 'nothing is measured before the decision');
	assert.ok(
		!/node,\n\t\t\t'--due',\n\t\t\tString\(BENCHMARK_DUE_DAYS\),\n\t\t\t'--report'/.test(phase),
		'the REPORT invocation must not name the node positionally'
	);
});

// ── the chain table ──────────────────────────────────────────────────────────

test('the onboarding chain is the manual record, in order, ending on health', () => {
	const ids = ONBOARDING_STEPS.map((s) => s.id);
	assert.deepEqual(ids, [
		'declare',
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
});

// ── the manifest write path, against a FIXTURE checkout ─────────────────────

/**
 * A scratch hadoku_site-shaped checkout holding a manifest.
 *
 * IT STATES ITS OWN IDENTITY IN ITS OWN CONFIG FILE, and that is the one thing
 * here that is not obvious. `applyPlacementWrite` makes a REAL commit through
 * `landWrite`, which reaches git through `manifest-target.mjs`'s `runGit` —
 * and that helper strips every `GIT_*` variable from the environment before it
 * spawns, to keep a hook's `GIT_DIR`/`GIT_INDEX_FILE` from redirecting the
 * write. The fixture identity travels in `GIT_AUTHOR_*`/`GIT_COMMITTER_*`,
 * which start with `GIT_`, so the strip eats it too — verbatim the trap
 * `lib/test-git-identity.mjs`'s own header describes. No environment this test
 * can set will survive into that child.
 *
 * So the identity has to be config, and `hook-safe-tests.test.mjs` names the
 * form that is safe: `git config --file <path>` — the target is stated in the
 * command, so no `GIT_DIR`, `GIT_CONFIG*` or shared worktree common dir can
 * move it somewhere real. The path here is inside a `mkdtemp` directory this
 * test created and deletes, so the write cannot reach this repository even in
 * principle. (Bare `git config user.email` is what put 59 wrongly-authored
 * commits on `origin/main`, and stays banned.)
 *
 * WITHOUT IT, THIS TEST PASSES ON THE WRONG BOX FOR THE WRONG REASON. With no
 * identity anywhere, git falls back to `user@hostname`: on a workstation whose
 * hostname resolves that guess SUCCEEDS and the commit lands under a real
 * person's name, while on a claw the hostname is `claw-N.(none)` and git
 * refuses with "unable to auto-detect email address". That is exactly how this
 * file passed here and reddened main from CI. The assertion below therefore
 * checks WHO the commit is by, not just that one happened — so the failure is
 * deterministic on every box rather than only on the runner.
 */
function site(machines) {
	const d = mkdtempSync(join(tmpdir(), 'fleet-provision-'));
	made.push(d);
	git(d, ['init', '-q', '-b', 'main']);
	for (const [key, value] of [
		['user.name', FIXTURE_IDENTITY.name],
		['user.email', FIXTURE_IDENTITY.email],
	]) {
		git(d, ['config', '--file', join(d, '.git', 'config'), key, value]);
	}
	writeFileSync(
		join(d, 'fleet-runner-manifest.json'),
		JSON.stringify({ machines }, null, 2) + '\n'
	);
	git(d, ['add', '-A']);
	git(d, ['commit', '-q', '-m', 'base']);
	return d;
}

function git(dir, args) {
	const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: cleanGitEnv() });
	assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

const readManifest = (d) => JSON.parse(readFileSync(join(d, 'fleet-runner-manifest.json'), 'utf8'));

test('applyPlacementWrite lands backfill + ephemeral as ONE surgical commit', async () => {
	// The claw-8 pre-fix shape: declared before placement was derived, so the
	// entry carries none of the fields a serving claw needs.
	const d = site({
		'claw-8': { cores: 8, ramGb: 15, maxConcurrent: 3, minFreeMb: 2048, $why: 'human prose' },
	});
	const mp = join(d, 'fleet-runner-manifest.json');
	const w = await applyPlacementWrite({
		manifestPath: mp,
		node: 'claw-8',
		backfill: {
			labels: [],
			role: 'claw',
			maxRegistrations: 32,
			minFreeGb: 25,
			slice: { swapMb: 4096, unitMaxMb: 4096 },
		},
		ephemeral: true,
		noPush: true,
	});
	assert.equal(w.ok, true, w.why ?? w.note);
	const e = readManifest(d).machines['claw-8'];
	assert.equal(e.ephemeral, true);
	assert.deepEqual(e.labels, []);
	assert.equal(e.minFreeGb, 25);
	// SURGICAL: the human fields survive beside what the chain wrote.
	assert.equal(e.cores, 8);
	assert.equal(e.$why, 'human prose');
	// IT LANDED: a commit exists on the fixture, carrying only the manifest.
	const log = git(d, ['log', '--format=%s', '-1']);
	assert.match(log, /^fleet\(provision\): placement for claw-8 \(ephemeral on\)/);
	// AND IT IS BY THE FIXTURE, not by whoever git could guess from the hostname.
	// `landWrite` strips `GIT_*` before spawning, so an identity that reached
	// this commit by any route other than the fixture's own config file is git
	// falling back to `user@host` — which SUCCEEDS on a workstation and FAILS on
	// a claw ("unable to auto-detect email address (got 'hadoku@claw-6.(none)')").
	// Asserting the author is what makes that difference visible everywhere
	// instead of only on the runner that reddened main.
	assert.equal(
		git(d, ['log', '--format=%ae', '-1']).trim(),
		FIXTURE_IDENTITY.email,
		'the landed commit is not authored by the fixture identity — git guessed one'
	);
	assert.equal(git(d, ['log', '--format=%ce', '-1']).trim(), FIXTURE_IDENTITY.email);
	// SURGICAL means ONE commit and ONE file in it.
	assert.deepEqual(git(d, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n'), [
		'fleet-runner-manifest.json',
	]);
});

test('applyPlacementWrite with nothing owed writes NOTHING — the idempotent half', async () => {
	const d = site({ 'claw-9': { ephemeral: true, labels: [] } });
	const before = git(d, ['rev-parse', 'HEAD']);
	const w = await applyPlacementWrite({
		manifestPath: join(d, 'fleet-runner-manifest.json'),
		node: 'claw-9',
		backfill: {},
		ephemeral: false,
		noPush: true,
	});
	assert.equal(w.ok, true);
	assert.match(w.note, /nothing to write/);
	assert.equal(
		git(d, ['rev-parse', 'HEAD']),
		before,
		'an idempotent re-run must not manufacture a commit'
	);
});

test('a target already carrying uncommitted changes is refused, not folded in', async () => {
	// Landing on a dirty file would file somebody else's edit under this
	// writer's commit and let the drift gate read the result as landed —
	// `writeTarget`'s third refusal, reached here through the real path.
	const d = site({ 'claw-9': { labels: [] } });
	const mp = join(d, 'fleet-runner-manifest.json');
	writeFileSync(
		mp,
		JSON.stringify({ machines: { 'claw-9': { labels: ['someone-elses-edit'] } } }, null, 2)
	);
	const w = await applyPlacementWrite({
		manifestPath: mp,
		node: 'claw-9',
		backfill: { role: 'claw' },
		ephemeral: false,
		noPush: true,
	});
	assert.equal(w.ok, false);
	assert.match(w.why, /dirty/);
	// and the foreign edit is still sitting there, uncommitted and unclaimed
	assert.deepEqual(readManifest(d).machines['claw-9'].labels, ['someone-elses-edit']);
});

test('an undeclared node is refused — placement writes an EXISTING entry', async () => {
	const d = site({ 'claw-1': { labels: [] } });
	const w = await applyPlacementWrite({
		manifestPath: join(d, 'fleet-runner-manifest.json'),
		node: 'claw-42',
		backfill: { labels: [] },
		ephemeral: true,
		noPush: true,
	});
	assert.equal(w.ok, false);
	assert.match(w.why, /not in .* — placement writes an EXISTING entry/);
});

test('a target outside a git checkout is refused before anything is written', async () => {
	const d = mkdtempSync(join(tmpdir(), 'fleet-provision-bare-'));
	made.push(d);
	const mp = join(d, 'fleet-runner-manifest.json');
	writeFileSync(mp, JSON.stringify({ machines: { 'claw-9': {} } }));
	const w = await applyPlacementWrite({
		manifestPath: mp,
		node: 'claw-9',
		backfill: {},
		ephemeral: true,
	});
	assert.equal(w.ok, false);
	assert.match(w.why, /not-a-checkout|REFUSES/);
});

test('fastForward uses --ff-only — it cannot lose local work', () => {
	// The manual record's step 1 failed on "checkout behind origin". The fix is
	// a FAST-FORWARD, and the flag is the safety property: anything else could
	// merge or rebase operator state out from under another session.
	const src = readFileSync(new URL('./provision-fleet.mjs', import.meta.url), 'utf8');
	assert.match(src, /\['merge', '--ff-only', 'FETCH_HEAD'\]/);
	// and a diverged checkout is refused with the by-hand remedy, not forced.
	const d = site({});
	const ff = fastForwardManifest(join(d, 'fleet-runner-manifest.json'), {
		git: (args) => {
			if (args[0] === 'rev-parse') return { status: 0, stdout: `${d}\n`, stderr: '' };
			if (args[0] === 'remote') return { status: 0, stdout: 'url\n', stderr: '' };
			if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
			if (args[0] === 'merge')
				return { status: 1, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.' };
			throw new Error(`unexpected git call ${args.join(' ')}`);
		},
	});
	assert.equal(ff.ok, false);
	assert.match(ff.why, /cannot be fast-forwarded/);
	assert.match(ff.why, /by hand/);
});
