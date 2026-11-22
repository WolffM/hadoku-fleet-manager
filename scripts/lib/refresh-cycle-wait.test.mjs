/**
 * The refresh cycle's drain wait, as the CYCLE sees it (fleet-manager#114):
 * the wait is handed this run's deadline, a budget end is a deferral, a stuck
 * or unreadable signal is a finding, and a node busy right now goes behind the
 * idle ones. The wait itself is drain-progress.test.mjs's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TASKAUTO, harness, seenFor } from './refresh-cycle-fixtures.mjs';

const stale = () => seenFor(TASKAUTO, { claude: '2.1.284' });

test("the wait is handed THIS run's deadline, and no clock of its own", async () => {
	const world = { 'claw-b': stale() };
	const h = harness([['claw-b', TASKAUTO]], world);
	const deadline = Date.now() + 90 * 60_000;
	await h.run({ deadline });
	assert.deepEqual(h.waitOpts()['claw-b'], { deadline });
});

test("the run's budget ending mid-wait is a DEFERRAL: put back, not updated, no finding", async () => {
	const world = { 'claw-b': stale() };
	const h = harness([['claw-b', TASKAUTO]], world, {
		waitResult: {
			drained: false,
			running: 2,
			budget: true,
			reason: "the run's time budget ended while 2 job(s) were still running and advancing",
		},
	});
	const r = await h.run();
	assert.ok(!h.events.includes('update claw-b'), 'updated a node that was still busy');
	assert.ok(h.events.includes('undrain claw-b'), 'left the node drained');
	assert.equal(r.ok, true, JSON.stringify(r.findings));
	const rec = r.nodes.find((n) => n.node === 'claw-b');
	assert.equal(rec.status, 'deferred');
	assert.match(rec.reason, /time budget ended/);
	assert.equal(world['claw-b'].claude.version, '2.1.284');
});

test('a STUCK or unreadable signal is a finding, the node put back and not updated', async () => {
	for (const waitResult of [
		{ drained: false, running: 1, stuck: true, reason: 'job 7 has not finished a step in 90m' },
		{ drained: false, running: null, stuck: true, reason: 'could not count running jobs' },
		// No `budget: true` is never read as one, whatever the reason says.
		{ drained: false, reason: 'not drained' },
	]) {
		const world = { 'claw-b': stale() };
		const h = harness([['claw-b', TASKAUTO]], world, { waitResult });
		const r = await h.run();
		assert.ok(!h.events.includes('update claw-b'));
		assert.ok(h.events.includes('undrain claw-b'));
		assert.equal(r.ok, false);
		assert.equal(r.findings[0].kind, 'drain-stuck');
		assert.ok(r.findings[0].reason.startsWith(waitResult.reason));
		assert.equal(world['claw-b'].claude.version, '2.1.284');
	}
});

test('a node busy right now goes BEHIND the idle one, once; then it is drained whatever it runs', async () => {
	const world = { 'claw-a': stale(), 'claw-b': stale() };
	const h = harness(
		[
			['claw-a', TASKAUTO],
			['claw-b', TASKAUTO],
		],
		world,
		{ busy: { 'claw-a': 2, 'claw-b': 0 } }
	);
	const r = await h.run();
	const order = h.events.filter((e) => /^(drain|busy\?) /.test(e));
	assert.deepEqual(order, [
		'busy? claw-a',
		'busy? claw-b',
		'drain claw-b training',
		'drain claw-a training',
	]);
	assert.equal(r.ok, true, JSON.stringify(r.findings));
	assert.equal(r.nodes.length, 2, 'each node reported once');
});

test('an unreadable busy count also goes behind; nothing is skipped for being busy', async () => {
	const world = { 'claw-a': stale(), 'claw-b': stale() };
	const h = harness(
		[
			['claw-a', TASKAUTO],
			['claw-b', TASKAUTO],
		],
		world,
		{ busy: { 'claw-a': null, 'claw-b': 3 } }
	);
	await h.run();
	// claw-a: unknown, behind. claw-b: busy, behind. claw-a again: moved once, drained.
	// claw-b again: moved once, drained. Nothing is skipped for being busy.
	assert.deepEqual(
		h.events.filter((e) => /^(drain|busy\?) /.test(e)),
		['busy? claw-a', 'busy? claw-b', 'drain claw-a training', 'drain claw-b training']
	);
});

test('a LIVE SESSION defers the node before any drain: nothing drained, nothing updated, no finding', async () => {
	const world = { 'claw-b': stale() };
	const h = harness([['claw-b', TASKAUTO]], world, {
		sessions: { 'claw-b': { live: 1, pastCap: 0 } },
	});
	const r = await h.run();
	assert.ok(!h.events.some((e) => e.startsWith('drain ')), 'drained a node with a live session');
	assert.ok(!h.events.includes('update claw-b'));
	assert.equal(r.ok, true, JSON.stringify(r.findings));
	const rec = r.nodes.find((n) => n.node === 'claw-b');
	assert.equal(rec.status, 'deferred');
	assert.match(rec.reason, /1 live session\(s\)/);
});

test('sessions past the cap do not defer it, and sessions that cannot be counted are a finding', async () => {
	const past = harness(
		[['claw-b', TASKAUTO]],
		{ 'claw-b': stale() },
		{
			sessions: { 'claw-b': { live: 0, pastCap: 2 } },
		}
	);
	await past.run();
	assert.ok(past.events.includes('update claw-b'), 'a day-old session held the refresh off');

	const blind = harness(
		[['claw-b', TASKAUTO]],
		{ 'claw-b': stale() },
		{
			sessions: { 'claw-b': null },
		}
	);
	const r = await blind.run();
	assert.ok(!blind.events.some((e) => e.startsWith('drain ')));
	assert.equal(r.ok, false);
	assert.equal(r.findings[0].kind, 'sessions-unreadable');
});
