/**
 * Two convergers built from one factory keep their own state, their own words
 * and their own alert source. The paging policy itself is pinned by
 * provisioning-converge.test.ts, which runs through the same factory.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { __setHostForTesting } from '../host.js';
import { testHost, testStateDir } from './install-test-host.js';
import { createConverger, type ConvergeDoc, type ConvergeRunner } from '../scheduled-converger.js';

let posts: { content: string; source?: string }[] = [];
let recorded: string[] = [];

// Two real in-process registry rows: createConverger refuses any other name.
const JOBS = {
	alpha: { job: 'fleet:hosting-converge', intervalMs: 5 * 60_000 },
	beta: { job: 'fleet:hosting-verify', intervalMs: 60 * 60_000 },
} as const;

const config = (name: keyof typeof JOBS) => ({
	name,
	...JOBS[name],
	stateFile: `${name}.json`,
	deferPageMs: 3_600_000,
	repageMs: 86_400_000,
	firstPassMinMs: 1_000,
	words: {
		silent: (h: string) => `${name} silent ${h}`,
		reporting: `${name} reporting`,
		deferred: (r: { node: string }) => `${name} deferred ${r.node}`,
		unconverged: (r: { node: string; facet: string }) => `${name} stuck ${r.node} ${r.facet}`,
		recovered: (node: string, facet: string) => `${name} ok ${node} ${facet}`,
	},
});

beforeEach(() => {
	posts = [];
	recorded = [];
	for (const n of ['alpha', 'beta']) rmSync(join(testStateDir, `${n}.json`), { force: true });
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn() {}, error() {} },
		alerts: {
			post: async (content: string, source?: string) => {
				posts.push({ content, source });
				return { posted: true, sinkRecorded: true };
			},
			recordQuietly() {},
		},
		// Every tick now reports to the job sink (job-runner.ts's `finishTick`).
		// The real `recordJobResult` fetches a live URL; stubbed here so this
		// suite stays hermetic, same as fleet-loop.test.ts/drain.test.ts.
		jobs: {
			recordJobResult: async (jobName: string) => {
				recorded.push(jobName);
			},
		},
	});
});
afterEach(() => __setHostForTesting(testHost));

const doc = (over: Partial<ConvergeDoc> = {}): ConvergeDoc => ({
	ok: true,
	planned: [],
	converged: [],
	deferred: [],
	unconverged: [],
	unreadable: [],
	changed: [],
	...over,
});
const runner =
	(d: ConvergeDoc): ConvergeRunner =>
	() =>
		Promise.resolve({ doc: d, why: '' });

void test('each converger pages under its own name, into its own state file', async () => {
	const alpha = createConverger(config('alpha'));
	const beta = createConverger(config('beta'));
	await alpha.tick(runner(doc({ unconverged: [{ node: 'claw-1', facet: 'x' }] })), 1_000);
	await beta.tick(runner(doc()), 1_000);

	assert.deepEqual(posts, [{ content: 'alpha stuck claw-1 x', source: 'alpha' }]);
	const a = JSON.parse(readFileSync(join(testStateDir, 'alpha.json'), 'utf8'));
	const b = JSON.parse(readFileSync(join(testStateDir, 'beta.json'), 'utf8'));
	assert.ok(a.paged['claw-1|x'], 'alpha holds its open page');
	assert.deepEqual(b.paged, {}, "beta never sees alpha's page");

	// Beta reading claw-1 clean must not close alpha's page.
	await beta.tick(runner(doc()), 2_000);
	assert.equal(posts.length, 1);
	await alpha.tick(runner(doc()), 2_000);
	assert.deepEqual(posts.at(-1), { content: 'alpha ok claw-1 x', source: 'alpha' });
	assert.ok(existsSync(join(testStateDir, 'beta.json')));
});

void test('each converger reports to the job sink under its registry row, not its alert name (fleet-manager#35)', async () => {
	await createConverger(config('alpha')).tick(runner(doc()), 1_000);
	await createConverger(config('beta')).tick(runner(doc()), 1_000);
	assert.deepEqual(recorded, ['fleet:hosting-converge', 'fleet:hosting-verify']);
});

void test('a converger with no registry row, or a clock its row does not declare, refuses to be built', () => {
	assert.throws(
		() => createConverger({ ...config('alpha'), job: 'hosting' }),
		/hosting declares no in-process clock/
	);
	assert.throws(
		() => createConverger({ ...config('alpha'), intervalMs: 60_000 }),
		/fleet:hosting-converge ticks every 60000ms, its row declares 300000ms/
	);
});
