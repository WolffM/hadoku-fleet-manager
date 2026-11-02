/**
 * The proof runner's name — parsed as a JIT name, protected by the reap
 * sweep while its unit lives, and cleaned when stale — plus the workflow
 * reader (`runsOnForJob`/`isDispatchable`) and the capability declaration
 * `fleet prove-job` resolves a spec from. Wave 5s lane A split of
 * `prove-job.test.ts` (1,000-line test ceiling); see `prove-job-core.test.ts`,
 * `prove-job-canary.test.ts` and `prove-job-budget.test.ts` for the rest, and
 * `helpers/prove-job-rig.ts` for the shared simulated world.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { capability } from '../lib/capability-registry.js';
import { parseJitName, isProofRunnerName } from '../lib/jit-naming.js';
import { reapJitRunners } from '../runners/ephemeral-exec-reap.js';
import {
	isDispatchable,
	proofRunnerName,
	runsOnForJob,
	specFromCapability,
} from '../runners/prove-job-parse.js';
import { proveJob } from '../runners/prove-job.js';
import { SPEC, T0, WORKFLOW, assertUntouched, node, world } from './helpers/prove-job-rig.js';

// --- the name, and the reap sweep ----------------------------------------------

test('the proof name parses as a JIT name and the reap sweep protects it while its unit lives', async () => {
	const name = proofRunnerName('claw-8', 'WolffM/hadoku-tenhands', T0 - 3 * 3_600_000);
	assert.ok(name.length <= 64);
	assert.ok(isProofRunnerName(name, 'claw-8'));
	assert.ok(
		!isProofRunnerName(`jit-claw-8-hadoku-site-j1-r2-${T0}`, 'claw-8'),
		'a real mint is not a proof'
	);
	assert.equal(parseJitName(name)?.runId, 0);
	const live = world({ registered: [{ id: 1, name }], units: [name] });
	const kept = await reapJitRunners(['WolffM/hadoku-tenhands'], ['claw-8'], '', live.gh, live.sh, {
		nowMs: T0,
	});
	assert.deepEqual(
		[kept.reaped, kept.kept],
		[0, 1],
		'a live proof runner is kept, even past the grace'
	);
	// and a crash that strands the registration with no unit behind it has a backstop
	const gone = world({ registered: [{ id: 1, name }], units: [] });
	const reaped = await reapJitRunners(
		['WolffM/hadoku-tenhands'],
		['claw-8'],
		'',
		gone.gh,
		gone.sh,
		{ nowMs: T0 }
	);
	assert.equal(reaped.reaped, 1);
});

test('a stale proof registration with no unit is cleaned; a live one refuses unless --reap-stale', async () => {
	const stale = proofRunnerName('claw-8', 'WolffM/hadoku-tenhands', T0 - 3_600_000);
	const w = world({ registered: [{ id: 7, name: stale }] });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.deepEqual(r.staleCleaned, [stale]);

	const w2 = world({ registered: [{ id: 7, name: stale }], units: [stale] });
	const r2 = await proveJob(SPEC, w2.deps(node()));
	assert.equal(r2.verdict, 'refused');
	assert.equal(r2.findings[0].rule, 'stale-proof-live');
	assertUntouched(w2);

	const w3 = world({ registered: [{ id: 7, name: stale }], units: [stale] });
	const r3 = await proveJob({ ...SPEC, reapStale: true }, w3.deps(node()));
	assert.equal(r3.verdict, 'pass', JSON.stringify(r3.findings));

	const w4 = world({ registered: [{ id: 7, name: stale, busy: true }], units: [stale] });
	const r4 = await proveJob({ ...SPEC, reapStale: true }, w4.deps(node()));
	assert.equal(r4.findings[0].rule, 'proof-in-flight', 'a busy proof runner is never touched');
});

// --- the workflow reader -------------------------------------------------------

test('runsOnForJob reads a flow list, a block list and a scalar, by job name or key', () => {
	const flow = runsOnForJob(WORKFLOW, 'backend pytest');
	assert.deepEqual(flow, {
		ok: true,
		labels: ['self-hosted', 'pm2-host', 'taskauto'],
		jobKey: 'backend',
	});
	assert.deepEqual(runsOnForJob(WORKFLOW, 'backend'), flow);
	const block = `jobs:\n  a:\n    runs-on:\n      - self-hosted\n      - "gpu"  # comment\n    steps: []\n  b:\n    runs-on: ubuntu-latest\n`;
	assert.deepEqual(runsOnForJob(block, 'a'), {
		ok: true,
		labels: ['self-hosted', 'gpu'],
		jobKey: 'a',
	});
	assert.deepEqual(runsOnForJob(block, 'b'), { ok: true, labels: ['ubuntu-latest'], jobKey: 'b' });
	const missing = runsOnForJob(block, 'zzz');
	assert.equal(missing.ok, false);
	assert.equal(
		runsOnForJob(WORKFLOW, 'frontend lint').ok,
		false,
		'an expression is refused, not guessed'
	);
});

test('isDispatchable reads the on: section only', () => {
	assert.equal(isDispatchable(WORKFLOW), true);
	assert.equal(
		isDispatchable('on: [push, workflow_dispatch]\njobs:\n  a:\n    runs-on: x\n'),
		true
	);
	assert.equal(isDispatchable('on:\n  push:\njobs:\n  a:\n    name: workflow_dispatch:\n'), false);
});

// --- the declaration -----------------------------------------------------------

test('taskauto declares its proof as data, and the subcommand resolves it from there', () => {
	const cap = capability('taskauto');
	assert.equal(cap?.verify, 'role');
	assert.deepEqual(
		{ ...cap?.jobProof, evidence: undefined },
		{
			repo: 'WolffM/hadoku-tenhands',
			workflow: 'test.yml',
			job: 'backend pytest',
			evidence: undefined,
		}
	);
	assert.doesNotThrow(() => new RegExp(cap!.jobProof!.evidence, 'i'));
	const s = specFromCapability('taskauto', { node: 'claw-8' });
	assert.ok(
		s.ok &&
			s.spec.ref === 'main' &&
			s.spec.capability === 'taskauto' &&
			s.spec.job === 'backend pytest'
	);
	const over = specFromCapability('taskauto', { node: 'claw-8', ref: 'w3q', evidence: 'x' });
	assert.ok(over.ok && over.spec.ref === 'w3q' && over.spec.evidence === 'x');
	assert.equal(
		specFromCapability('jitconfig', { node: 'claw-8' }).ok,
		false,
		'no jobProof declared'
	);
	assert.equal(specFromCapability('nope', { node: 'claw-8' }).ok, false);
});
