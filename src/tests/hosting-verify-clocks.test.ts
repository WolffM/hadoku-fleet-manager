/**
 * The words and repage of the two clocks added for fleet-manager#31 and #34.
 * The policy is the shared converger's, pinned by provisioning-converge.test.ts;
 * the decisions are pinned by scripts/lib/hosting-verify.test.mjs and
 * scripts/lib/backstop-tools.test.mjs.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { __setHostForTesting } from '../host.js';
import { testHost, testStateDir } from './install-test-host.js';
import { backstopToolsTick } from '../backstop-tools.js';
import { inProcessClock } from '../lib/job-registry.js';
import { verifyHostingTick } from '../hosting-verify.js';
import type { ConvergeDoc } from '../scheduled-converger.js';

let posts: { content: string; source?: string }[] = [];
/** Recoveries go to the quiet ledger since #61. */
let quiet: { content: string; source?: string }[] = [];
beforeEach(() => {
	posts = [];
	quiet = [];
	rmSync(join(testStateDir, 'hosting-verify.json'), { force: true });
	rmSync(join(testStateDir, 'backstop-tools.json'), { force: true });
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn() {}, error() {} },
		alerts: {
			post: async (content: string, source?: string) => {
				posts.push({ content, source });
				return { posted: true, sinkRecorded: true };
			},
			recordQuietly(content: string, source?: string) {
				quiet.push({ content, source });
			},
		},
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
const run = (d: ConvergeDoc) => () => Promise.resolve({ doc: d, why: '' });

void test('#31: a slice a re-assert did not fix pages once, naming the check; a repaired one does not', async () => {
	const broken = doc({
		unconverged: [
			{ node: 'claw-4', facet: 'hosting:archivebot', why: 'hosting-files: .npmrc is missing' },
		],
	});
	await verifyHostingTick(run(broken), 1_000);
	await verifyHostingTick(run(broken), 1_000 + 60 * 60_000);
	assert.deepEqual(posts, [
		{
			content:
				'🔴 claw-4: hosting:archivebot is not guaranteed and a re-assert did not fix it: ' +
				'hosting-files: .npmrc is missing. Check: fleet hosting --check',
			source: 'hosting-verify',
		},
	]);
	posts = [];
	await verifyHostingTick(run(doc({ ok: true })), 1_000 + 2 * 60 * 60_000);
	assert.deepEqual(posts, [], 'a recovery is not posted (#61)');
	assert.deepEqual(
		quiet.map((p) => p.content),
		['✅ claw-4: hosting:archivebot is guaranteed again.']
	);
	posts = [];
	const fixed = doc({
		ok: true,
		converged: [{ node: 'claw-8', facet: 'hosting:cardtable', changed: 're-asserted' }],
		changed: [{ node: 'claw-8', facet: 'hosting:cardtable', changed: 're-asserted' }],
	});
	await verifyHostingTick(run(fixed), 1_000 + 3 * 60 * 60_000);
	assert.deepEqual(posts, []);
});

void test('#34: a stale tool posts once, not again inside 30 days, and again after', async () => {
	const stale = doc({
		unconverged: [
			{
				node: 'backstop-1',
				facet: 'tool:yt-dlp',
				before: '2026.08.19',
				why: 'yt-dlp 2026.08.19 on backstop-1 is 67 days behind 2026.10.26. Update it: x',
			},
		],
	});
	const day = 24 * 60 * 60_000;
	await backstopToolsTick(run(stale), 1_000);
	for (let d = 1; d < 30; d++) await backstopToolsTick(run(stale), 1_000 + d * day);
	assert.deepEqual(posts, [
		{
			content:
				'🛠️ backstop-1: yt-dlp 2026.08.19 on backstop-1 is 67 days behind 2026.10.26. Update it: x ' +
				'(monthly reminder; fleet backstop-tools)',
			source: 'backstop-tools',
		},
	]);
	await backstopToolsTick(
		run(stale),
		1_000 + inProcessClock('fleet:backstop-tools').repageMs + day
	);
	assert.equal(posts.length, 2, 'reminded again once the month is up');
	await backstopToolsTick(
		run(doc({ ok: true })),
		1_000 + inProcessClock('fleet:backstop-tools').repageMs + 2 * day
	);
	assert.equal(posts.length, 2, 'the recovery is not posted (#61)');
	assert.equal(quiet.at(-1)?.content, '✅ backstop-1: yt-dlp is current.');
});
