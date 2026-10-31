/**
 * The hosting converger's words and clock (fleet-manager#16). The policy is
 * the shared converger's, pinned by provisioning-converge.test.ts; the
 * decision is pinned by scripts/lib/hosting-converge.test.mjs.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { __setHostForTesting } from '../host.js';
import { testHost, testStateDir } from './install-test-host.js';
import { convergeHostingTick } from '../hosting-converge.js';
import type { ConvergeDoc } from '../scheduled-converger.js';

let posts: { content: string; source?: string }[] = [];
beforeEach(() => {
	posts = [];
	rmSync(join(testStateDir, 'hosting-converge.json'), { force: true });
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
		// See scheduled-converger.test.ts: every tick now reports to the job sink.
		jobs: { recordJobResult: async () => {} },
	});
});
afterEach(() => __setHostForTesting(testHost));

const doc = (over: Partial<ConvergeDoc>): ConvergeDoc => ({
	ok: false,
	planned: [],
	converged: [],
	deferred: [],
	unconverged: [],
	unreadable: [],
	changed: [],
	...over,
});

void test('an auto tenant whose demand cannot be met pages under hosting, naming its view', async () => {
	await convergeHostingTick(
		() =>
			Promise.resolve({
				doc: doc({ unconverged: [{ node: '*', facet: 'hosting:cardtable', why: 'no node fits' }] }),
				why: '',
			}),
		1_000
	);
	assert.deepEqual(posts, [
		{
			content:
				'🔴 hosting:cardtable: no node fits. Its view: fleet hosting-demand cardtable --json',
			source: 'hosting',
		},
	]);
});

void test('a dry-run plan is never a page', async () => {
	await convergeHostingTick(
		() =>
			Promise.resolve({
				doc: doc({
					ok: true,
					planned: [{ node: 'claw-5', facet: 'hosting:cardtable', changed: 'would declare' }],
				}),
				why: '',
			}),
		1_000
	);
	assert.deepEqual(posts, []);
});
