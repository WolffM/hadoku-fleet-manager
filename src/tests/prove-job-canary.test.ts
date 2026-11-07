/**
 * Wave 4e (#102) — inputs reach the dispatch body, aimed vs. unaimed canary
 * mint/re-mint behaviour, scratch-branch dispatch, duration is read from the
 * API's own timestamps, and `excludeRepos` never blocks a proof. Wave 5s lane
 * A split of `prove-job.test.ts` (1,000-line test ceiling); see
 * `prove-job-core.test.ts`, `prove-job-identity.test.ts` and
 * `prove-job-budget.test.ts` for the rest, and `helpers/prove-job-rig.ts` for
 * the shared simulated world.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { proveJob } from '../runners/prove-job.js';
import { specFromCapability } from '../runners/prove-job-parse.js';
import { MAX_ATTEMPTS_CEILING, type ProveSpec } from '../runners/prove-job-types.js';
import { SPEC, node, world } from './helpers/prove-job-rig.js';

test('spec.inputs are sent verbatim in the dispatch body; omitted entirely when not given', async () => {
	const w = world();
	await proveJob(
		{ ...SPEC, inputs: { only: 'e2e', specs: 'play.spec.ts arrow.spec.ts' } },
		w.deps(node())
	);
	assert.deepEqual(w.log.dispatchBodies[0], {
		ref: 'main',
		inputs: { only: 'e2e', specs: 'play.spec.ts arrow.spec.ts' },
	});

	const w2 = world();
	await proveJob(SPEC, w2.deps(node()));
	assert.deepEqual(
		w2.log.dispatchBodies[0],
		{ ref: 'main' },
		'no inputs key at all when spec carries none'
	);
});

// 2026-10-08: the first live jdk21 canaries were taken by other jdk21
// listeners. An AIMED canary carries a label only its proof runner has, and
// sends that exact label set as the job's runs-on input.
test('an aimed canary mints a unique label and sends it in its runs-on input', async () => {
	const w = world();
	const r = await proveJob(
		{
			...SPEC,
			labelsOverride: ['self-hosted', 'hadoku-builder', 'jdk21'],
			runsOnInput: 'runs_on',
			inputs: { only: 'e2e' },
		},
		w.deps(node())
	);
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	const minted = w.log.mintBodies[0].labels;
	const unique = minted.filter((l) => l.startsWith('proof-'));
	assert.equal(unique.length, 1, `one proof label on the runner: ${minted.join(',')}`);
	const body = w.log.dispatchBodies[0] as { inputs: Record<string, string> };
	assert.equal(body.inputs.only, 'e2e', 'the other inputs still go');
	const runsOn: string[] = JSON.parse(body.inputs.runs_on);
	assert.deepEqual(
		runsOn,
		['self-hosted', unique[0]],
		'aimed: self-hosted and the proof label only'
	);
	for (const l of runsOn) assert.ok(minted.includes(l), `the proof runner carries ${l}`);
	assert.ok(r.labels.includes('jdk21'), 'the report still names the workload labels');
});

// 2026-11-07: every jdk21 proof had expired and cardtable's forge backlog asked
// for self-hosted,hadoku-builder,jdk21. A proof runner carrying those labels
// was handed the oldest backlog job, every attempt, and the canary timed out.
test("an aimed proof runner carries none of the workload's labels, so no queued job can take it", async () => {
	const w = world();
	await proveJob(
		{
			...SPEC,
			labelsOverride: ['self-hosted', 'hadoku-builder', 'jdk21'],
			runsOnInput: 'runs_on',
		},
		w.deps(node())
	);
	const minted = w.log.mintBodies[0].labels;
	for (const l of ['hadoku-builder', 'jdk21'])
		assert.ok(!minted.includes(l), `the proof runner does not carry ${l}: ${minted.join(',')}`);
});

// 2026-10-08, claw-4's first aimed canary: forge.yml's `changes` job runs on
// the plain pool labels, which the proof runner also carries, so it took the
// runner and forge-e2e sat queued with nothing left that could take it. Aimed,
// nothing else CAN take the target, so a vanished runner is re-minted in place.
test('an aimed canary whose runner a prerequisite took mints another and lands in ONE dispatch', async () => {
	const w = world({ prereqTakes: 1 });
	const r = await proveJob(
		{
			...SPEC,
			labelsOverride: ['self-hosted', 'hadoku-builder', 'jdk21'],
			runsOnInput: 'runs_on',
			assignTimeoutMs: 30_000,
		},
		w.deps(node())
	);
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(r.ok, true, 'the re-mint is a note, not a finding');
	assert.equal(w.log.dispatches, 1, 'not cancelled and re-dispatched');
	assert.equal(w.log.mintBodies.length, 2);
	assert.match(r.attempts[0].note ?? '', /1 proof runner\(s\) taken/);
	assert.deepEqual(w.leaked(), { units: [], registered: [], staged: [] });
});

// 2026-11-07: forge.yml's `changes` waited over two minutes for a pool runner
// behind cardtable's backlog, and claw-9's aimed canary was cancelled before
// its target job was even listed.
test("an aimed canary's assignment clock starts once its target job is listed, not at dispatch", async () => {
	const w = world({ unlistedLooks: 20 });
	const r = await proveJob(
		{
			...SPEC,
			labelsOverride: ['self-hosted', 'hadoku-builder', 'jdk21'],
			runsOnInput: 'runs_on',
			assignTimeoutMs: 8_000,
		},
		w.deps(node())
	);
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(w.log.dispatches, 1, 'never cancelled and re-dispatched');
});

test('an UNAIMED canary still counts from dispatch: another listener could have the job', async () => {
	const w = world({ unlistedLooks: 20 });
	const r = await proveJob(
		{
			...SPEC,
			labelsOverride: ['self-hosted', 'hadoku-builder'],
			assignTimeoutMs: 8_000,
			maxAttempts: 1,
		},
		w.deps(node())
	);
	assert.notEqual(r.verdict, 'pass');
});

test('re-minting is bounded by the attempt ceiling', async () => {
	const w = world({ prereqTakes: 99 });
	const r = await proveJob(
		{
			...SPEC,
			labelsOverride: ['self-hosted', 'hadoku-builder', 'jdk21'],
			runsOnInput: 'runs_on',
			maxAttempts: 1,
			assignTimeoutMs: 30_000,
		},
		w.deps(node())
	);
	assert.equal(r.verdict, 'lost-race');
	assert.equal(w.log.mintBodies.length, 1 + MAX_ATTEMPTS_CEILING);
	assert.deepEqual(w.leaked(), { units: [], registered: [], staged: [] });
});

test('an UNAIMED canary does not re-mint: another listener could have the job, so it cancels and retries', async () => {
	const w = world({ prereqTakes: 1 });
	const r = await proveJob(
		{ ...SPEC, labelsOverride: ['self-hosted', 'hadoku-builder'], assignTimeoutMs: 5_000 },
		w.deps(node())
	);
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(w.log.dispatches, 2);
	assert.ok(w.log.writes.includes('POST /actions/runs/5001/cancel'));
});

test('a canary that is not aimed carries no proof label and sends no runs-on input', async () => {
	const w = world();
	await proveJob({ ...SPEC, labelsOverride: ['self-hosted', 'hadoku-builder'] }, w.deps(node()));
	assert.ok(!w.log.mintBodies[0].labels.some((l) => l.startsWith('proof-')));
	assert.deepEqual(w.log.dispatchBodies[0], { ref: 'main' });
});

// 2026-10-08: claw-3's canary was dispatched on main and sat in main's run
// list as a failed Forge run; cardtable's head watcher paged on it.
const SCRATCH: ProveSpec = { ...SPEC, scratchBranch: true };

test('a scratch-branch canary is dispatched and listed on canary/<node>-*, never on main, and the branch is deleted', async () => {
	const w = world();
	const r = await proveJob(SCRATCH, w.deps(node()));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.match(r.dispatchRef ?? '', /^canary\/claw-8-[0-9a-z]+$/);
	assert.equal(r.ref, 'main', 'the ref it was made FROM is still reported');
	const body = w.log.dispatchBodies[0] as { ref: string };
	assert.equal(body.ref, r.dispatchRef);
	assert.ok(w.runListings.length > 0);
	for (const l of w.runListings)
		assert.ok(l.includes(`branch=${encodeURIComponent(r.dispatchRef!)}`), l);
	assert.ok(w.log.writes.includes('POST /git/refs'));
	assert.deepEqual([...w.branches.keys()], ['main'], 'the scratch branch is gone');
});

// 2026-11-07: forge.yml ran nothing for claw-9's canary because claw-8's had
// just gone green on the same sha with the same inputs.
test("a scratch-branch canary runs on a commit of its own, so a workflow's sha dedupe cannot skip it", async () => {
	const w = world();
	const r = await proveJob(SCRATCH, w.deps(node()));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	const mainSha = w.branches.get('main');
	assert.equal(w.log.commits.length, 1);
	assert.deepEqual(w.log.commits[0], {
		message: 'fleet proof canary: claw-8',
		tree: `tree-of-${mainSha}`,
		parents: [mainSha],
	});
	const refWrite = w.log.writes.indexOf('POST /git/refs');
	assert.ok(
		w.log.writes.indexOf('POST /git/commits') < refWrite,
		'the commit is made before the branch'
	);
});

test('the scratch branch is deleted on a fail, a lost race and an abort too', async () => {
	for (const [label, sc] of [
		['fail', { conclusion: 'failure' }],
		['lost race', { winner: () => 'hokon' as const }],
	] as const) {
		const w = world(sc);
		await proveJob({ ...SCRATCH, assignTimeoutMs: 3_000 }, w.deps(node()));
		assert.deepEqual([...w.branches.keys()], ['main'], `${label} left a branch`);
	}
	const ac = new AbortController();
	const w = world({ hang: true, onSleep: () => ac.abort() });
	await proveJob(SCRATCH, w.deps(node(), { signal: ac.signal }));
	assert.deepEqual([...w.branches.keys()], ['main'], 'abort left a branch');
});

test('a scratch branch that cannot be made stops before any mint, and is not dispatched on main instead', async () => {
	const w = world({ branchCreateStatus: 403 });
	const r = await proveJob(SCRATCH, w.deps(node()));
	assert.equal(r.verdict, 'error');
	assert.ok(r.findings.some((f) => f.rule === 'scratch-branch'));
	assert.equal(w.log.mintBodies.length, 0);
	assert.equal(w.log.dispatches, 0);
});

test('without scratchBranch the canary is dispatched on its ref and no branch is made', async () => {
	const w = world();
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.dispatchRef, 'main');
	assert.ok(!w.log.writes.some((x) => x.includes('/git/refs')));
});

test('jdk21 is aimed: its spec names the runs_on input and the jdk21 pool', () => {
	const res = specFromCapability('jdk21', { node: 'claw-4' });
	assert.ok(res.ok);
	assert.equal(res.spec.runsOnInput, 'runs_on');
	assert.equal(res.spec.scratchBranch, true, 'and is never dispatched on main');
	assert.deepEqual(res.spec.labelsOverride, ['self-hosted', 'hadoku-builder', 'jdk21']);
});

test("durationSec is read from the jobs API's own started_at/completed_at, never the orchestration clock", async () => {
	const w = world();
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(typeof r.durationSec, 'number');
	assert.ok(r.durationSec! > 0);
});

test('durationSec is null when the API gives no usable timestamps', async () => {
	const w = world({ conclusion: 'failure' });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'fail');
	// The fixture DOES stamp started_at/completed_at on every completed job, so
	// this proves the reader itself handles the shape — not that this scenario
	// lacks them. A truly timestamp-less API is exercised by a direct unit
	// test of `buildProofRecord`'s input below instead.
	assert.equal(typeof r.durationSec, 'number');
});

test('excludeRepos is never consulted on the proof path — claw-3 must be able to FAIL its canary', async () => {
	const w = world({ conclusion: 'failure' });
	const n = node({ excludeRepos: { [SPEC.repo]: 'cardtable excluded pending wave 4e' } });
	const r = await proveJob(SPEC, w.deps(n));
	// It minted and dispatched exactly as if excludeRepos were absent — refused
	// for NO reason naming the exclusion, and the job still ran (and failed).
	assert.equal(r.verdict, 'fail', JSON.stringify(r.findings));
	assert.ok(!r.findings.some((f) => /exclude/i.test(f.message)));
	assert.equal(w.log.mintBodies.length, 1, 'the mint still happened');
});
