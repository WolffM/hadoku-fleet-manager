/**
 * `fleet prove-job`'s core orchestration, against ONE simulated world: the
 * happy path, label handling, `ranOnTarget` being READ rather than inferred,
 * the attempt bound, teardown on every exit path, the refusal gates, and "I
 * could not look" never reading as a pass. Wave 5s lane A split of
 * `prove-job.test.ts` (1,000-line test ceiling); see `prove-job-identity.test.ts`,
 * `prove-job-canary.test.ts` and `prove-job-budget.test.ts` for the rest, and
 * `helpers/prove-job-rig.ts` for the shared simulated world.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nodeOffer } from '../lib/capability-offer.js';
import type { ManifestNode } from '../lib/capability-registry.js';
import { isProofRunnerName } from '../runners/prove-job-parse.js';
import { proveJob } from '../runners/prove-job.js';
import { MAX_ATTEMPTS_CEILING, type ProofGh, type ProveSpec } from '../runners/prove-job-types.js';
import { extractEvidence } from '../runners/prove-job-parse.js';
import {
	HOKON,
	SPEC,
	WORKFLOW,
	assertUntouched,
	node,
	world,
	type Scenario,
} from './helpers/prove-job-rig.js';

// --- the happy path, and what it reports --------------------------------------

// cardtable sharded forge-e2e on 2026-10-08: a dispatch carrying `specs`
// runs a one-shard matrix, and the jobs API names it `forge-e2e (1)`.
test('a canary job served as a matrix shard is still found and judged', async () => {
	const w = world({ jobName: 'backend pytest (1)' });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(r.ranOnTarget, true);
});

test('a job that lands on the proof runner and succeeds is a pass, read from the API', async () => {
	const w = world();
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(r.ok, true);
	assert.equal(r.ranOnTarget, true);
	assert.equal(r.jobConclusion, 'success');
	assert.ok(r.runnerName && isProofRunnerName(r.runnerName, 'claw-8'));
	assert.ok(r.runId && r.jobId);
	assert.deepEqual(r.evidence, [
		'claude resolved to /home/hadoku/.local/bin/claude',
		'1203 passed, 2 deselected in 41.2s',
	]);
	assert.deepEqual(w.leaked(), { units: [], registered: [], staged: [] });
});

// --- 1. the label override is this runner's, and only this runner's ------------

test("the proof runner carries the job's runs-on labels; the manifest and the node's offer are untouched", async () => {
	const w = world();
	const n = node({ labels: ['taskauto'] });
	const offerBefore = nodeOffer(n, { eligible: true });
	const snapshot = JSON.stringify(n);
	await proveJob(SPEC, w.deps(n));
	const labels = w.log.mintBodies[0].labels;
	// the implicit three plus EXACTLY what the job asked for — including pm2-host, which claw-8 must not carry
	assert.deepEqual([...labels].sort(), ['Linux', 'X64', 'pm2-host', 'self-hosted', 'taskauto']);
	assert.ok(
		!labels.includes('hadoku-builder'),
		'the node offer (eligibility) must not leak into the proof runner'
	);
	assert.equal(JSON.stringify(n), snapshot, 'the manifest node is READ-ONLY');
	assert.deepEqual(nodeOffer(n, { eligible: true }), offerBefore);
	assert.ok(!nodeOffer(n, { eligible: true }).includes('pm2-host'));
});

test('--labels-override replaces the workflow labels for this runner alone', async () => {
	const w = world();
	const n = node();
	await proveJob({ ...SPEC, labelsOverride: ['self-hosted', 'odd-label'] }, w.deps(n));
	assert.deepEqual([...w.log.mintBodies[0].labels].sort(), [
		'Linux',
		'X64',
		'odd-label',
		'self-hosted',
	]);
	assert.deepEqual(n.labels, ['taskauto']);
});

// --- 2. ranOnTarget is READ, never inferred ------------------------------------

test('a job that concluded SUCCESS on the wrong runner is lost-race, not a pass', async () => {
	const w = world({ winner: () => 'hokon' });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'lost-race');
	assert.equal(r.ok, false);
	assert.equal(r.ranOnTarget, false);
	assert.equal(r.runnerName, HOKON);
	assert.equal(r.jobConclusion, 'success', 'the conclusion is reported — it is just not a proof');
	assert.ok(r.attempts.every((a) => a.ranOnTarget === false && a.jobConclusion === 'success'));
	// and it kept trying, to the cap, rather than accepting the first green job it saw
	assert.equal(w.log.dispatches, 3);
	assert.equal(r.attempts.length, 3);
});

test('a miss is cancelled and retried, and the second dispatch can win', async () => {
	const w = world({ winner: (n) => (n === 1 ? 'none' : 'proof') });
	const r = await proveJob({ ...SPEC, assignTimeoutMs: 5_000 }, w.deps(node()));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(w.log.dispatches, 2);
	assert.ok(
		w.log.writes.includes('POST /actions/runs/5001/cancel'),
		'the missed run is cancelled, not left queued'
	);
	assert.equal(r.attempts.length, 2);
	assert.equal(r.attempts[0].ranOnTarget, false);
	assert.equal(r.attempts[1].ranOnTarget, true);
});

// --- 3. bounded --------------------------------------------------------------

test('retries are capped: never more than the requested attempts, never more than the ceiling', async () => {
	const w = world({ winner: () => 'none' });
	const r = await proveJob({ ...SPEC, maxAttempts: 3, assignTimeoutMs: 3_000 }, w.deps(node()));
	assert.equal(r.verdict, 'lost-race');
	assert.equal(w.log.dispatches, 3);

	const w2 = world({ winner: () => 'none' });
	const r2 = await proveJob({ ...SPEC, maxAttempts: 99, assignTimeoutMs: 3_000 }, w2.deps(node()));
	assert.equal(r2.verdict, 'lost-race');
	assert.equal(w2.log.dispatches, MAX_ATTEMPTS_CEILING);
});

// --- 4. teardown on EVERY path -----------------------------------------------

test('teardown leaves nothing behind on success, failure, lost race, timeout and mint failure', async () => {
	const cases: [string, Scenario, Partial<ProveSpec>, string][] = [
		['success', {}, {}, 'pass'],
		['job failure', { conclusion: 'failure' }, {}, 'fail'],
		['lost race', { winner: () => 'hokon' }, {}, 'lost-race'],
		['job timeout', { hang: true }, { jobTimeoutMs: 10_000 }, 'timeout'],
		[
			'whole-run timeout',
			{ winner: () => 'none' },
			{ timeoutMs: 5_000, assignTimeoutMs: 4_000 },
			'timeout',
		],
	];
	for (const [label, sc, spec, verdict] of cases) {
		const w = world(sc);
		const r = await proveJob({ ...SPEC, ...spec }, w.deps(node()));
		assert.equal(r.verdict, verdict, `${label}: ${JSON.stringify(r.findings)}`);
		assert.deepEqual(w.leaked(), { units: [], registered: [], staged: [] }, `${label} leaked`);
		assert.equal(r.teardown.ok, true, label);
		assert.ok(
			r.teardown.runners.every(
				(t) => t.unitStopped && t.configGone && t.listenerGone && t.deregistered
			),
			label
		);
	}
});

test('a hung job is cancelled on teardown so it cannot outlive the proof', async () => {
	const w = world({ hang: true });
	await proveJob({ ...SPEC, jobTimeoutMs: 10_000 }, w.deps(node()));
	assert.ok(w.log.writes.includes('POST /actions/runs/5001/cancel'));
});

test('an abort (SIGTERM) mid-run still tears down', async () => {
	const ac = new AbortController();
	let polls = 0;
	const w = world({ hang: true, onSleep: () => void (++polls === 6 && ac.abort()) });
	const r = await proveJob(
		{ ...SPEC, jobTimeoutMs: 600_000 },
		w.deps(node(), { signal: ac.signal })
	);
	assert.equal(r.verdict, 'error');
	assert.ok(r.findings.some((f) => f.rule === 'aborted'));
	assert.deepEqual(w.leaked(), { units: [], registered: [], staged: [] });
	assert.equal(r.ok, false);
});

test('a teardown that cannot remove the registration is LOUD: verdict teardown-failed, the leak named', async () => {
	const w = world({ deleteStatus: 500, hang: true });
	const r = await proveJob({ ...SPEC, jobTimeoutMs: 5_000 }, w.deps(node()));
	assert.equal(r.verdict, 'teardown-failed');
	assert.equal(r.ok, false);
	assert.equal(r.teardown.ok, false);
	assert.ok(
		r.findings.some((f) => f.rule === 'teardown-failed' && /LEAK: jit-claw-8-proof/.test(f.message))
	);
});

test('a unit that will not stop is a finding, verified from the node', async () => {
	const w = world({ unkillable: true, hang: true });
	const r = await proveJob({ ...SPEC, jobTimeoutMs: 5_000 }, w.deps(node()));
	assert.equal(r.verdict, 'teardown-failed');
	assert.ok(r.findings.some((f) => /still active/.test(f.message)));
});

test('a node that cannot be reached at teardown is a finding, not a clean exit', async () => {
	const w = world();
	const real = w.sh;
	let down = false;
	const d = w.deps(node());
	const r = await proveJob(SPEC, {
		...d,
		sh: async (n, c) => {
			if (c.includes('UNIT-GONE')) down = true;
			return down ? null : real(n, c);
		},
	});
	assert.equal(r.verdict, 'teardown-failed');
	assert.ok(r.findings.some((f) => /could not reach claw-8 to tear down/.test(f.message)));
});

// --- 5. refusals: nothing is touched -------------------------------------------

test('an on-demand backstop takes the JIT path, its unit capped by the backstop allowance', async () => {
	const w = world({ target: 'hokon' });
	const backstop = node({
		role: 'backstop',
		mint: 'on-demand',
		ephemeral: undefined,
		slice: { unitMaxMb: 4096, maxMb: 16384 },
	} as Partial<ManifestNode>);
	const r = await proveJob({ ...SPEC, node: 'hokon' }, w.deps(backstop));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(r.minted.length, 1);
	assert.ok(r.runnerName && isProofRunnerName(r.runnerName, 'hokon'));
	const run = w.log.sh.find((c) => c.startsWith('systemd-run'));
	assert.ok(run, 'the proof runner is minted on the node');
	// The backstop's declared per-unit cap, not the claw rule's widening to the slice.
	assert.match(run, /MemoryMax=4096M/);
	assert.deepEqual(w.leaked(), { units: [], registered: [], staged: [] });
});

test('a backstop that does not mint on demand is refused before anything is reached', async () => {
	const w = world({ target: 'hokon' });
	const r = await proveJob(
		{ ...SPEC, node: 'hokon' },
		w.deps(node({ role: 'backstop', ephemeral: undefined }))
	);
	assert.equal(r.verdict, 'refused');
	assert.ok(r.findings.some((f) => f.rule === 'not-minted'));
	assert.deepEqual(w.log.sh, [], 'not even a reachability probe');
	assertUntouched(w);
});

test('a node that does not carry the capability is refused with the reason', async () => {
	const w = world();
	const r = await proveJob(SPEC, w.deps(node({ labels: [] })));
	assert.equal(r.verdict, 'refused');
	assert.ok(
		r.findings.some(
			(f) => f.rule === 'capability-state' && /does not carry "taskauto"/.test(f.message)
		)
	);
	assertUntouched(w);
});

test('a non-ephemeral node, a drained node and a full node are refused', async () => {
	for (const [n, drained, rule] of [
		[node({ ephemeral: false }), false, 'not-minted'],
		[node(), true, 'admission'],
	] as const) {
		const w = world();
		const r = await proveJob(SPEC, w.deps(n, { drained }));
		assert.equal(r.verdict, 'refused', rule);
		assert.ok(
			r.findings.some((f) => f.rule === rule),
			rule
		);
		assertUntouched(w);
	}
	const w = world({ units: ['jit-claw-8-x-j1-r2-3', 'jit-claw-8-y-j1-r2-3'] });
	const r = await proveJob(SPEC, w.deps(node({ maxConcurrent: 2 })));
	assert.ok(r.findings.some((f) => f.rule === 'admission' && /at capacity/.test(f.message)));
	assertUntouched(w);
});

test('a workflow that cannot be dispatched, or whose runs-on is an expression, is refused', async () => {
	const w = world({ workflow: WORKFLOW.replace('  workflow_dispatch:\n', '') });
	assert.equal((await proveJob(SPEC, w.deps(node()))).findings[0].rule, 'not-dispatchable');
	assertUntouched(w);
	const w2 = world();
	const r = await proveJob({ ...SPEC, job: 'frontend lint' }, w2.deps(node()));
	assert.equal(r.findings[0].rule, 'runs-on');
	assert.match(r.findings[0].message, /--labels-override/);
	assertUntouched(w2);
});

// --- 6. "I could not look" is never a pass -------------------------------------

test('an unreadable jobs API is a finding with its reason, and the runner is still torn down', async () => {
	const w = world({ broken: ['/jobs'] });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'error');
	assert.equal(r.ok, false);
	assert.ok(
		r.findings.some((f) => f.rule === 'unreadable' && /jobs listing.*HTTP 502/.test(f.message))
	);
	assert.deepEqual(w.leaked(), { units: [], registered: [], staged: [] });
});

test('an unreadable workflow file stops before any mutation', async () => {
	const w = world({ broken: ['/contents/'] });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'error');
	assert.equal(r.findings[0].rule, 'workflow-unreadable');
	assertUntouched(w);
});

test('an unreachable node is a finding, not a pass', async () => {
	const w = world({ unreachable: true });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'error');
	assert.equal(r.findings[0].rule, 'unreachable');
	assertUntouched(w);
});

test('an unreadable LOG is a finding even though the job went green', async () => {
	const w = world({ log: new Error('HTTP 410 gone') });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.jobConclusion, 'success');
	assert.equal(r.ok, false);
	assert.ok(r.findings.some((f) => f.rule === 'log-unreadable' && /410/.test(f.message)));
});

test('one transient read failure is retried and does not fail the proof', async () => {
	const w = world();
	let failed = false;
	const gh: ProofGh = {
		...w.gh,
		get: async (p, t, repo) => {
			if (p.includes('/jobs') && !failed) {
				failed = true;
				throw new Error('HTTP 502');
			}
			return w.gh.get(p, t, repo);
		},
	};
	const r = await proveJob(SPEC, { ...w.deps(node()), gh });
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
});

// --- 7. evidence -------------------------------------------------------------

test('a green job with NO matching log line is not a pass', async () => {
	const w = world({ log: 'setup\nall quiet\n' });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'fail');
	assert.equal(r.ok, false);
	assert.ok(r.findings.some((f) => f.rule === 'no-evidence'));
});

test('extractEvidence: regex, case, timestamps stripped, de-duplicated, bounded', () => {
	const ts = `${new Date(0).toISOString().replace('.000Z', '.1234567Z')} `;
	const log = [
		`${ts}Claude Resolved to /x`,
		'noise',
		'Claude Resolved to /x',
		'5 passed',
		'x'.repeat(400) + ' passed',
	].join('\n');
	const ev = extractEvidence(log, 'claude resolved|\\d+ passed|passed$');
	assert.equal(ev[0], 'Claude Resolved to /x');
	assert.equal(ev[1], '5 passed');
	assert.equal(ev.length, 3, 'the duplicate is dropped');
	assert.ok(ev[2].length <= 301);
	assert.equal(extractEvidence('a\na\nb', 'a|b', 1).length, 1);
	assert.deepEqual(extractEvidence('nothing', 'zzz'), []);
});
