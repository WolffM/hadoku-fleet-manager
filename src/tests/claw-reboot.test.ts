/**
 * What the controller's reboot cycle logs and pages.
 *
 * The cycle's safety properties are pinned in scripts/lib/reboot-cycle.test.mjs.
 * This pins the policy around it: a clean reboot is a NOTE, never a page; a
 * held node pages once per REPAGE_MS and recovers when it comes back; a
 * deferral or an unreadable node is logged only; a cycle that produces no
 * report pages after FAIL_PAGE_MS; and all of it survives a restart because
 * the state is on disk.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { __setHostForTesting } from '../host.js';
import { testHost, testStateDir } from './install-test-host.js';
import {
	clawRebootTick,
	rebootScriptPath,
	runRebootScript,
	FAIL_PAGE_MS,
	REPAGE_MS,
	type RebootDoc,
	type RebootRunner,
} from '../claw-reboot.js';

let posts: string[] = [];
let infos: string[] = [];
let warns: string[] = [];
const STATE = join(testStateDir, 'claw-reboot-controller.json');

beforeEach(() => {
	posts = [];
	infos = [];
	warns = [];
	rmSync(STATE, { force: true });
	__setHostForTesting({
		...testHost,
		logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m), error() {} },
		alerts: {
			post: async (content: string) => {
				posts.push(content);
				return { posted: true, sinkRecorded: true };
			},
			recordQuietly() {},
		},
	});
});
afterEach(() => __setHostForTesting(testHost));

const T0 = 1_792_900_000_000;
const HOUR = 3_600_000;
const doc = (over: Partial<RebootDoc> = {}): RebootDoc => ({
	ok: true,
	nodes: [],
	findings: [],
	rebooted: [],
	...over,
});
const runner =
	(d: RebootDoc | null, why = ''): RebootRunner =>
	() =>
		Promise.resolve({ doc: d, why });

void test('a clean reboot is posted once as a note naming the kernels, and is not a page', async () => {
	const s = await clawRebootTick(
		runner(
			doc({
				nodes: [
					{
						node: 'claw-3',
						status: 'rebooted',
						reason: 'running 6.12.94+deb13-amd64, newest installed 6.12.113+deb13-amd64',
						kernel: { from: '6.12.94+deb13-amd64', to: '6.12.113+deb13-amd64' },
					},
				],
				rebooted: ['claw-3'],
			})
		),
		T0
	);
	assert.deepEqual(s, { ran: true, rebooted: 1, pages: 0, recoveries: 0 });
	assert.equal(posts.length, 1);
	assert.match(posts[0], /^🔄 claw-3 rebooted .*6\.12\.94\+deb13-amd64 → 6\.12\.113\+deb13-amd64/);
});

void test('a held node pages once, again only after REPAGE_MS, and recovers when it is back', async () => {
	const held = doc({
		ok: false,
		nodes: [{ node: 'claw-5', status: 'held', why: 'booted 6.12.94, expected 6.12.113' }],
		findings: [
			{
				node: 'claw-5',
				kind: 'verify-failed',
				reason: 'booted 6.12.94, expected 6.12.113. The node STAYS DRAINED — a human puts it back.',
			},
		],
	});
	await clawRebootTick(runner(held), T0);
	await clawRebootTick(runner(held), T0 + HOUR);
	assert.equal(posts.length, 1);
	assert.match(posts[0], /^🔴 claw-5: .*verify-failed.*fleet drain claw-5 --undo/);
	await clawRebootTick(runner(held), T0 + REPAGE_MS + 1);
	assert.equal(posts.length, 2);
	await clawRebootTick(
		runner(doc({ nodes: [{ node: 'claw-5', status: 'current' }] })),
		T0 + REPAGE_MS + 2 * HOUR
	);
	assert.equal(posts.length, 3);
	assert.match(posts[2], /^✅ claw-5: back in service/);
});

void test('deferrals, an idle wait that timed out and an unreadable claw are logged, never paged', async () => {
	await clawRebootTick(
		runner(
			doc({
				ok: false,
				nodes: [
					{ node: 'claw-8', status: 'deferred', why: 'held by someone else: drained (lease)' },
					{ node: 'claw-1', status: 'unreadable', reason: 'ssh timed out' },
				],
				findings: [{ node: 'claw-1', kind: 'unreadable', reason: 'ssh timed out' }],
			})
		),
		T0
	);
	assert.deepEqual(posts, []);
	assert.ok(infos.some((l) => l.includes('claw-8 deferred')));
	assert.ok(warns.some((l) => l.includes('claw-1 unreadable')));
});

void test('a cycle with no report pages only after FAIL_PAGE_MS, then recovers', async () => {
	await clawRebootTick(runner(null, 'exit 1, no report'), T0);
	await clawRebootTick(runner(null, 'exit 1, no report'), T0 + FAIL_PAGE_MS - 1);
	assert.deepEqual(posts, []);
	await clawRebootTick(runner(null, 'exit 1, no report'), T0 + FAIL_PAGE_MS);
	assert.equal(posts.length, 1);
	assert.match(posts[0], /has not produced a report for 6h/);
	assert.ok(existsSync(STATE));
	await clawRebootTick(runner(doc()), T0 + FAIL_PAGE_MS + HOUR);
	assert.match(posts[1], /reporting again/);
});

void test('the real runner refuses under node --test, and points at the packaged script', async () => {
	assert.match(rebootScriptPath(), /scripts[/\\]reboot-claws\.mjs$/);
	const r = await runRebootScript();
	assert.equal(r.doc, null);
	assert.match(r.why, /refused under node --test/);
});
