/**
 * The cache sweep record (fleet-manager#65): what counts as swept, when a node
 * becomes due for a drained sweep, and when its absence is a finding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	SWEEP_DUE_DAYS,
	SWEEP_OVERDUE_DAYS,
	foldSweeps,
	overdueFindings,
	readSweepLog,
	recordSweeps,
	sweepDue,
} from './cache-sweep-log.mjs';

const DAY = 86_400_000;
const T0 = Date.now();
const ok = (machine, cachesSwept) => ({ machine, ok: true, cachesSwept });

test('only an APPLY run that was not held back by a job counts as swept', () => {
	const log = foldSweeps(
		{},
		[ok('claw-a', true), ok('claw-b', false), { machine: 'claw-c', ok: false }],
		{ confirm: true, nowMs: T0 }
	);
	assert.deepEqual(log['claw-a'], { seenAt: T0, sweptAt: T0 });
	assert.deepEqual(log['claw-b'], { seenAt: T0 }, 'busy: seen, not swept');
	assert.equal(log['claw-c'], undefined, 'unreachable: not even seen');
	const dry = foldSweeps({}, [ok('claw-a', true)], { confirm: false, nowMs: T0 });
	assert.deepEqual(dry['claw-a'], { seenAt: T0 }, 'a dry run deletes nothing, so sweeps nothing');
});

test('a busy night keeps the last sweep and the first sighting; an expected-down node is untouched', () => {
	const before = { 'claw-a': { seenAt: T0 - 30 * DAY, sweptAt: T0 - 3 * DAY } };
	const log = foldSweeps(
		before,
		[ok('claw-a', false), { machine: 'claw-b', ok: true, expectedDown: true }],
		{ confirm: true, nowMs: T0 }
	);
	assert.deepEqual(log['claw-a'], before['claw-a']);
	assert.equal(log['claw-b'], undefined);
});

test('due after SWEEP_DUE_DAYS from the last sweep, or from first sighting; never-seen is not due', () => {
	assert.equal(sweepDue({ sweptAt: T0 - (SWEEP_DUE_DAYS - 1) * DAY }, T0), false);
	assert.equal(sweepDue({ sweptAt: T0 - SWEEP_DUE_DAYS * DAY }, T0), true);
	assert.equal(sweepDue({ seenAt: T0 - SWEEP_DUE_DAYS * DAY }, T0), true, 'never swept since seen');
	assert.equal(sweepDue(undefined, T0), false, 'the clock has not started');
	assert.equal(sweepDue({ seenAt: 'yesterday' }, T0), false, 'a garbage record is not due');
});

test('overdue only past SWEEP_OVERDUE_DAYS, only for the nodes asked about, with the days named', () => {
	const log = {
		'claw-a': { seenAt: T0 - 40 * DAY, sweptAt: T0 - SWEEP_OVERDUE_DAYS * DAY },
		'claw-b': { seenAt: T0 - 40 * DAY, sweptAt: T0 - 9 * DAY },
		'claw-c': { seenAt: T0 - 40 * DAY },
	};
	const f = overdueFindings(log, ['claw-a', 'claw-b', 'claw-new'], T0);
	assert.deepEqual(
		f.map((x) => x.machine),
		['claw-a']
	);
	assert.match(f[0].reason, /14 days/);
	assert.equal(f[0].kind, 'caches-unswept');
});

test('the record round-trips through the state dir; an unreadable one reads as empty', () => {
	const dir = mkdtempSync(join(tmpdir(), 'sweep-log-'));
	const prev = process.env.HADOKU_STATE_DIR;
	process.env.HADOKU_STATE_DIR = dir;
	try {
		assert.deepEqual(readSweepLog(), {});
		recordSweeps([ok('claw-a', true)], { confirm: true, nowMs: T0 });
		assert.deepEqual(readSweepLog(), { 'claw-a': { seenAt: T0, sweptAt: T0 } });
		assert.deepEqual(
			JSON.parse(readFileSync(join(dir, 'cache-sweep-log.json'), 'utf8')),
			readSweepLog()
		);
		writeFileSync(join(dir, 'cache-sweep-log.json'), '{oops');
		assert.deepEqual(readSweepLog(), {});
	} finally {
		if (prev === undefined) delete process.env.HADOKU_STATE_DIR;
		else process.env.HADOKU_STATE_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});
