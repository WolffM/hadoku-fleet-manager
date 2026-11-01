/**
 * A node's CI pressure from the dispatcher's decision log: fresh rows only,
 * newest first, yesterday's file only when the window crosses midnight, and
 * an unreadable day file said, never read as idle. Fixture dirs only.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CI_FRESH_MS, readCiPressure } from './hosting-ci-pressure.mjs';

// Anchored to today's UTC day, so the midnight case is a real midnight.
const DAY_MS = 86_400_000;
const MIDNIGHT = Math.floor(Date.now() / DAY_MS) * DAY_MS;
const NOON = MIDNIGHT + DAY_MS / 2;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const MANIFEST = { machines: { 'claw-8': { cores: 8 }, 'claw-9': { cores: 12 } } };
const cap = (node, busy, heavyJobs = 0, max = 2) => ({ node, busy, heavyJobs, max });
const row = (at, capacity, extra = {}) => ({
	v: 1,
	at: new Date(at).toISOString(),
	capacity,
	...extra,
});

function logDir(files) {
	const dir = mkdtempSync(join(tmpdir(), 'ci-pressure-'));
	for (const [day, rows] of Object.entries(files))
		writeFileSync(join(dir, `${day}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
	return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the newest fresh row naming a node is its pressure; a node only a stale row names is null', () => {
	const now = NOON;
	const f = logDir({
		[dayOf(NOON)]: [
			row(now - CI_FRESH_MS - 1000, [cap('claw-8', 3), cap('claw-9', 4)]),
			row(now - 120_000, [cap('claw-9', 1, 0, 3)]),
			row(now - 60_000, [cap('claw-9', 2, 1, 3)]),
			'{"torn',
		],
	});
	try {
		const { byNode, why } = readCiPressure({
			dir: f.dir,
			nodes: ['claw-8', 'claw-9', 'claw-1'],
			manifest: MANIFEST,
			nowMs: now,
		});
		assert.equal(why, null);
		assert.deepEqual(byNode.get('claw-9'), {
			jobs: 2,
			heavyJobs: 1,
			max: 3,
			load1: null,
			cores: 12,
			at: new Date(now - 60_000).toISOString(),
		});
		assert.equal(byNode.get('claw-8'), null, 'only a stale row names it: unmeasured');
		assert.equal(byNode.get('claw-1'), null);
	} finally {
		f.done();
	}
});

test("near UTC midnight yesterday's file is read too; otherwise it is not", () => {
	const now = MIDNIGHT + 120_000;
	const f = logDir({ [dayOf(MIDNIGHT - 1)]: [row(now - 180_000, [cap('claw-8', 1)])] });
	try {
		const near = readCiPressure({ dir: f.dir, nodes: ['claw-8'], manifest: MANIFEST, nowMs: now });
		assert.equal(near.byNode.get('claw-8').jobs, 1);
		const later = now + 3_600_000;
		const far = readCiPressure({ dir: f.dir, nodes: ['claw-8'], manifest: MANIFEST, nowMs: later });
		assert.equal(far.byNode.get('claw-8'), null);
	} finally {
		f.done();
	}
});

test('a file many chunks long, with multi-byte text across chunk edges, is read from its end', () => {
	const now = NOON;
	const rows = [row(now - 200_000, [cap('claw-8', 5)])];
	for (let i = 0; i < 3000; i++)
		rows.push(row(now - 100_000 + i, [cap('claw-9', i % 3)], { jobName: `büild — ✓ ${i}` }));
	const f = logDir({ [dayOf(NOON)]: rows });
	try {
		const { byNode } = readCiPressure({
			dir: f.dir,
			nodes: ['claw-8', 'claw-9'],
			manifest: MANIFEST,
			nowMs: now,
		});
		assert.equal(byNode.get('claw-9').jobs, 2999 % 3);
		assert.equal(byNode.get('claw-8').jobs, 5, 'found past every chunk edge');
	} finally {
		f.done();
	}
});

test('no log at all is unmeasured; a day file that cannot be read says why', () => {
	const now = NOON;
	const missing = readCiPressure({
		dir: join(tmpdir(), 'ci-pressure-none-here'),
		nodes: ['claw-8'],
		manifest: MANIFEST,
		nowMs: now,
	});
	assert.equal(missing.byNode.get('claw-8'), null);
	assert.equal(missing.why, null);
	const dir = mkdtempSync(join(tmpdir(), 'ci-pressure-'));
	try {
		mkdirSync(join(dir, `${dayOf(NOON)}.jsonl`));
		const broken = readCiPressure({ dir, nodes: ['claw-8'], manifest: MANIFEST, nowMs: now });
		assert.equal(broken.byNode.get('claw-8'), null);
		assert.match(broken.why, new RegExp(`${dayOf(NOON)}\\.jsonl is unreadable`));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
