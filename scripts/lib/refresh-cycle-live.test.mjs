/**
 * `createLiveDeps().markChecked` — F3 characterization (wave clean-1 lane A).
 * Moved off a hand-rolled `writeFileSync` onto the shared `writeFileAtomic`.
 * `refresh-cycle.test.mjs` exercises the pure half of the cycle against a
 * FAKE `markChecked` (`marked.push(n)`); nothing called the real one.
 *
 * `HADOKU_STATE_DIR` points `stateDir()` at a throwaway directory — never the
 * operator's real `recheck-log.json`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLiveDeps } from './refresh-cycle-live.mjs';
import { drain, isDrained, undrain } from './drain-wait.mjs';

/**
 * DELEGATION, NOT REIMPLEMENTATION (wave clean-2 lane C, cut (iii) layer
 * debt): `isDrained`/`drain`/`undrain` moved to `drain-wait.mjs` so
 * `benchmark-fleet.mjs` (observation) can use them without reaching into
 * this (lifecycle) file. This is the characterization that pins
 * `createLiveDeps()`'s behaviour as byte-identical across that move — a
 * plain reference-equality check, no fleet and no fake needed, because
 * `createLiveDeps()` hands back the exact same function objects rather than
 * wrappers around them.
 */
test('createLiveDeps() delegates isDrained/drain/undrain to the shared drain-wait primitive', () => {
	const deps = createLiveDeps();
	assert.equal(deps.isDrained, isDrained);
	assert.equal(deps.drain, drain);
	assert.equal(deps.undrain, undrain);
});

test('markChecked persists recheck-log.json through the shared atomic writer', () => {
	const dir = mkdtempSync(join(tmpdir(), 'refresh-cycle-live-'));
	const saved = process.env.HADOKU_STATE_DIR;
	process.env.HADOKU_STATE_DIR = dir;
	try {
		const deps = createLiveDeps();
		const before = Date.now();
		deps.markChecked('fixture-node');
		const doc = JSON.parse(readFileSync(join(dir, 'recheck-log.json'), 'utf8'));
		assert.ok(
			typeof doc['fixture-node'] === 'number' && doc['fixture-node'] >= before,
			JSON.stringify(doc)
		);
		assert.equal(deps.lastChecked('fixture-node'), doc['fixture-node']);

		// A second mark MERGES onto the same file rather than replacing it wholesale.
		deps.markChecked('fixture-node-2');
		const doc2 = JSON.parse(readFileSync(join(dir, 'recheck-log.json'), 'utf8'));
		assert.ok(doc2['fixture-node'] && doc2['fixture-node-2']);
	} finally {
		process.env.HADOKU_STATE_DIR = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});
