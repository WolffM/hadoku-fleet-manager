/**
 * The floor probe's declared intent, and the competitor mint it stops.
 *
 * Wave 3-prep §Q.1. `floor-probe-2026-09-08.md` §2.1 measured the cost this
 * closes — "roughly one wasted mint per probe" — and named the consequence that
 * makes it more than a cost: all four misses in the eleven-probe sweep landed on
 * a node still holding the PREVIOUS probe's leftover competitor, so two idle
 * matching runners existed for one job and GitHub picked.
 *
 * THIS IS A SUPPRESSION, WHICH MEANS IT IS A SAFETY CONTROL IN BOTH DIRECTIONS.
 * Every test below that asserts a mint is SUPPRESSED has a twin that asserts it
 * is NOT: a declaration that suppressed one job too many would stop the fleet
 * minting for real work, and under all-JIT nothing else mints.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	PROBE_INTENT_DIR,
	PROBE_INTENT_MAX_MS,
	readProbeIntents,
	runDispatchTick,
	resetRecoveryClock,
	__resetPollStateForTesting,
	type DispatchTickInput,
} from '../runners/dispatch-tick.js';
import type { NodeState } from '../runners/placement.js';
import { fakeGh, fakeShell } from './helpers/fleet-fakes.js';
import { testStateDir } from './install-test-host.js';

const INTENT_DIR = join(testStateDir, PROBE_INTENT_DIR);
const REPO = 'WolffM/hadoku-pygmalion';
const JOB = 'python-tests';
const NOW = 1_787_797_008_000;

const node = (name: string, over: Partial<NodeState> = {}): NodeState => ({
	name,
	healthy: true,
	eligible: true,
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 3,
	freeMb: 9000,
	requiredMb: 900,
	minFreeMb: 1536,
	...over,
});

const base = (over: Partial<DispatchTickInput> = {}): DispatchTickInput => ({
	order: ['claw-3'],
	nodes: [node('claw-3', { labels: ['hadoku-builder'] })],
	repos: [REPO],
	recentJobCounts: new Map(),
	labelsFor: () => [],
	memoryMaxMbFor: () => 3000,
	homeDirFor: () => '/home/fixture-ci',
	ttlSeconds: 3600,
	...over,
});

const queued = (id: number, agoMs = 120_000) => ({
	id,
	status: 'queued',
	created_at: new Date(NOW - agoMs).toISOString(),
	repository: { full_name: REPO },
	head_repository: { full_name: REPO, fork: false },
	event: 'push',
});

const job = (id: number, name: string) => ({
	id,
	name,
	status: 'queued',
	labels: ['self-hosted', 'hadoku-builder'],
});

/** One probe's declaration, exactly as `declareProbeIntent` writes it. */
function writeIntent(over: Record<string, unknown> = {}): string {
	mkdirSync(INTENT_DIR, { recursive: true });
	const name = String(over.runnerName ?? 'jit-claw-3-hadoku-pygmalion-j0-r0-1789000000');
	const path = join(INTENT_DIR, `${name}.json`);
	writeFileSync(
		path,
		`${JSON.stringify({
			repo: REPO,
			job: JOB,
			node: 'claw-3',
			runnerName: name,
			expiresAtMs: NOW + 600_000,
			at: new Date(NOW).toISOString(),
			...over,
		})}\n`
	);
	return path;
}

async function tick(jobs: unknown[] = [job(1, JOB)]) {
	const gh = fakeGh({ workflowRuns: [queued(1)], jobs });
	const res = await runDispatchTick(base(), 'tok', gh, fakeShell(), NOW);
	return { res, calls: gh.calls };
}

beforeEach(() => {
	__resetPollStateForTesting();
	resetRecoveryClock();
	rmSync(INTENT_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The guard itself
// ---------------------------------------------------------------------------

test('with no declaration the dispatcher mints — this is the competitor being measured', async () => {
	const { res, calls } = await tick();
	assert.equal(res.minted, 1, 'the baseline: one wasted competitor per probe');
	assert.ok(calls.some((c) => c.includes('generate-jitconfig')));
});

test('a declared intent mints NO competitor for that job', async () => {
	writeIntent();
	const { res, calls } = await tick();
	assert.equal(res.minted, 0, 'the probe already has a listener for this job');
	assert.equal(
		calls.filter((c) => c.includes('generate-jitconfig')).length,
		0,
		'and no mint reached GitHub at all — `minted: 0` could also be a failed mint'
	);
});

test('the suppression is scoped to the job NAME, not the repo', async () => {
	// A probe of `python-tests` must not stop the fleet serving `lint` in the same
	// repo. The ledger's own key is the (repo, job) pair and so is this.
	writeIntent();
	const { res } = await tick([job(2, 'lint')]);
	assert.equal(res.minted, 1, 'another job of the same repo is minted for as usual');
});

test('a sibling job of the SAME run is still minted for', async () => {
	// The probe arranged for exactly one job. Suppressing its siblings would leave
	// them queued with nothing listening, which is the failure this must not cause.
	writeIntent();
	const { res } = await tick([job(1, JOB), job(2, 'lint')]);
	assert.equal(res.minted, 1);
});

test('an intent for another repo suppresses nothing', async () => {
	writeIntent({ repo: 'WolffM/hadoku_site' });
	const { res } = await tick();
	assert.equal(res.minted, 1);
});

test('a job with no name is never matched by a declaration', async () => {
	// GitHub always reports a name; a listing that does not is a shape we have not
	// seen, and guessing it matches would suppress a mint on no evidence.
	writeIntent();
	const { res } = await tick([{ id: 1, status: 'queued', labels: ['hadoku-builder'] }]);
	assert.equal(res.minted, 1);
});

// ---------------------------------------------------------------------------
// The expiry — the half that keeps a suppression from stalling the fleet
// ---------------------------------------------------------------------------

test('an EXPIRED declaration suppresses nothing', async () => {
	writeIntent({ expiresAtMs: NOW - 1 });
	const { res } = await tick();
	assert.equal(res.minted, 1, 'a probe that died holding its file must not hold the unit');
});

test('a declaration reaching past the ceiling is refused, not honoured', async () => {
	// The one failure of this mechanism that could stall the fleet: a stale file, a
	// clock skew or a hand-edit claiming hours. `no gate may get EASIER to pass the
	// worse the failure gets` — the suppression may not outlive the probe.
	writeIntent({ expiresAtMs: NOW + PROBE_INTENT_MAX_MS + 1 });
	const { res } = await tick();
	assert.equal(res.minted, 1);
});

test('the ceiling leaves slack over the harness own runner TTL', () => {
	// Two processes, two clocks. A ceiling equal to the harness's TTL refuses every
	// honest declaration the moment the dispatcher's clock sits a millisecond
	// behind. Read from the harness's source, so the two cannot drift apart
	// silently — this is the only place the relationship is checked.
	const HERE = fileURLToPath(new URL('.', import.meta.url));
	const src = readFileSync(resolve(HERE, '..', '..', 'scripts', 'floor-probe.mjs'), 'utf8');
	const m = /const PROBE_TTL_SECONDS = (\d+)/.exec(src);
	assert.ok(m, 'floor-probe.mjs must still declare PROBE_TTL_SECONDS');
	const ttlMs = Number(m[1]) * 1000;
	assert.ok(
		ttlMs < PROBE_INTENT_MAX_MS,
		`a ${ttlMs}ms declaration against a ${PROBE_INTENT_MAX_MS}ms ceiling has no slack`
	);
	assert.ok(
		PROBE_INTENT_MAX_MS - ttlMs >= 30_000,
		'and the slack has to be bigger than any plausible skew between two boxes'
	);
});

// ---------------------------------------------------------------------------
// Reading the directory — "I could not look" must not read as "the fleet is busy"
// ---------------------------------------------------------------------------

test('no directory at all is no suppression, and is the normal state', () => {
	rmSync(INTENT_DIR, { recursive: true, force: true });
	assert.deepEqual(readProbeIntents(NOW), []);
});

test('a malformed file costs one declaration, not the whole directory', () => {
	mkdirSync(INTENT_DIR, { recursive: true });
	writeFileSync(join(INTENT_DIR, 'broken.json'), '{not json');
	writeIntent();
	const live = readProbeIntents(NOW);
	assert.equal(live.length, 1);
	assert.equal(live[0].job, JOB);
});

test('a file missing repo or job is not a declaration', () => {
	writeIntent({ runnerName: 'a', job: undefined });
	writeIntent({ runnerName: 'b', repo: undefined });
	writeIntent({ runnerName: 'c', expiresAtMs: 'soon' });
	assert.deepEqual(readProbeIntents(NOW), []);
});

test('a non-.json file in the directory is ignored', () => {
	mkdirSync(INTENT_DIR, { recursive: true });
	writeFileSync(join(INTENT_DIR, 'README'), 'operator notes');
	assert.deepEqual(readProbeIntents(NOW), []);
});

test('a job name with a space round-trips through the intent key', async () => {
	// `hadoku_site` has a job called `Build variants`. A space separator in the
	// composite key would make `Build` a key of its own — §2.5's mis-attribution,
	// which is why the separator is a NUL.
	writeIntent({ job: 'Build variants' });
	const { res } = await tick([job(1, 'Build variants')]);
	assert.equal(res.minted, 0);
	// The poll cadence is module state: without this the second tick finds the repo
	// not due and mints nothing for a reason that has nothing to do with the key.
	__resetPollStateForTesting();
	const near = await tick([job(1, 'Build')]);
	assert.equal(near.res.minted, 1, 'and the prefix is a DIFFERENT job');
});

test('dispatch-tick.ts carries no literal NUL — it must be an escape', () => {
	// This test exists because the line it guards was written with a literal NUL on
	// the first attempt. It WORKED — the Set joined and compared consistently — and
	// it made git classify the file as binary, so no diff, no grep, no review.
	// §2.5 is the same failure in `scripts/lib/floor-probe.mjs`, seven bytes of it.
	const HERE = fileURLToPath(new URL('.', import.meta.url));
	const src = readFileSync(resolve(HERE, '..', '..', 'src', 'runners', 'dispatch-tick.ts'), 'utf8');
	assert.ok(src.includes(String.raw`'\u0000'`), 'the separator must be spelled as an escape');
	assert.equal(src.indexOf('\u0000'), -1, 'a literal NUL byte makes this file invisible to git');
});

test('an unreadable directory suppresses nothing rather than everything', async () => {
	// Deliberately the OPPOSITE of this file's usual "fail toward doing nothing":
	// everywhere else a failure means fewer mints, and here a failure that produced
	// MORE suppression would stop the fleet minting for real work. The fallback cost
	// is one wasted registration the reaper already clears.
	mkdirSync(INTENT_DIR, { recursive: true });
	writeFileSync(join(INTENT_DIR, 'x.json'), '');
	const { res } = await tick();
	assert.equal(res.minted, 1);
});
