/**
 * fleet-manager#75: a run past the stuck ceiling behind a pool BUSY RUNNING
 * work is capacity, not "the fleet stopped serving". Three of the four long
 * queue-health red streaks of 2026-10-25..11-08 were cardtable Forge runs
 * queued while runner-health said every label was online and the pool busy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summariseQueue, queueFindings, wedgedClaws, WEDGED_JOB_SECONDS } from './queue-health.mjs';

const NOW = Date.now();
const STUCK_MS = 3_600_000;
const FORGE = ['self-hosted', 'hadoku-builder', 'jdk21'];
const ago = (sec) => new Date(NOW - sec * 1000).toISOString();
const claw = (name, busy = true, labels = FORGE) => ({ name, status: 'online', busy, labels });
const job = (runner, sec, name = 'forge-e2e (2)') => ({ runner, name, startedAt: ago(sec) });
const sum = (runs) => summariseQueue(runs, { stuckMs: STUCK_MS, nowMs: NOW });
const queued = [{ labels: FORGE }];

test('wedgedClaws: every busy matching claw running a live job is capacity', () => {
	const runners = [claw('claw-1'), claw('claw-3'), claw('claw-5', false, ['self-hosted'])];
	assert.deepEqual(
		wedgedClaws(queued, runners, [job('claw-1', 40 * 60), job('claw-3', 70 * 60)], { nowMs: NOW }),
		[]
	);
});

test('wedgedClaws: a claw whose job has run past the timeout ceiling is wedged, and named', () => {
	const reasons = wedgedClaws(
		queued,
		[claw('claw-1'), claw('claw-3')],
		[job('claw-1', 40 * 60), job('claw-3', WEDGED_JOB_SECONDS + 60, 'forge-jvm')],
		{ nowMs: NOW }
	);
	assert.deepEqual(reasons, ['claw-3 has run forge-jvm for 361m']);
});

test('wedgedClaws: a busy claw with no visible job is wedged — GitHub says busy, nothing shows it working', () => {
	assert.deepEqual(wedgedClaws(queued, [claw('claw-1')], [], { nowMs: NOW }), [
		'claw-1 is busy with no in-progress job visible',
	]);
});

test('wedgedClaws: an unread jobs listing is null, never "nothing wedged"', () => {
	assert.equal(wedgedClaws(queued, [claw('claw-1')], undefined, { nowMs: NOW }), null);
});

test('wedgedClaws: the backstop is left out, as isSaturated leaves it out — its long jobs are its own', () => {
	const isBackstop = (n) => n.startsWith('hokon');
	assert.deepEqual(
		wedgedClaws(queued, [claw('claw-1'), claw('hokon-x')], [job('claw-1', 60)], {
			nowMs: NOW,
			isBackstop,
		}),
		[]
	);
});

test('the 11-07 20:10 streak: 111 min behind a busy, turning-over pool is busyPool, not a finding', () => {
	const s = sum([
		{ repo: 'WolffM/hadoku-cardtable', createdAt: ago(111 * 60), saturated: true, wedged: [] },
	]);
	assert.equal(s.stranded.length, 0);
	assert.equal(s.busyPool.length, 1);
	assert.equal(s.stuck.length, 1, '`stuck` stays whole for mgmt-api');
	assert.deepEqual(queueFindings(s, []), []);
});

test('a saturated run behind a WEDGED claw is stranded, and the finding says which claw', () => {
	const s = sum([
		{
			repo: 'WolffM/hadoku-cardtable',
			createdAt: ago(90 * 60),
			saturated: true,
			wedged: ['claw-3 has run forge-jvm for 400m'],
		},
	]);
	assert.equal(s.busyPool.length, 0);
	assert.match(queueFindings(s, []).join(' '), /claw-3 has run forge-jvm for 400m/);
});

test('an unread pool check (null) is stranded — could-not-look never excuses a run', () => {
	const s = sum([
		{ repo: 'WolffM/hadoku-cardtable', createdAt: ago(90 * 60), saturated: true, wedged: null },
	]);
	assert.equal(s.stranded.length, 1);
	assert.equal(queueFindings(s, []).length, 1);
});

test('an UNSATURATED run with an empty wedged list is still stranded — busy-pool needs saturation', () => {
	const s = sum([{ repo: 'WolffM/x', createdAt: ago(90 * 60), saturated: false, wedged: [] }]);
	assert.equal(s.stranded.length, 1);
});

test('a days-old run is a zombie whatever its pool says', () => {
	const s = sum([{ repo: 'WolffM/x', createdAt: ago(2 * 86_400), saturated: true, wedged: [] }]);
	assert.equal(s.zombie.length, 1);
	assert.equal(s.busyPool.length, 0);
});
