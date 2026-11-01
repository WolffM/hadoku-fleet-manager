/**
 * `declareProbeIntent` — F3 characterization (wave clean-1 lane A). Moved off
 * a hand-rolled `writeFileSync` onto the shared `writeFileAtomic`. Nothing
 * covered this write before: `src/tests/probe-intent.test.ts` hand-writes
 * files shaped like its output to test the READER side
 * (`readProbeIntents` in `dispatch-tick.ts`), never calling this writer.
 *
 * `HADOKU_STATE_DIR` points `stateDir()` at a throwaway directory for the
 * call — never the operator's real state dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { declareProbeIntent } from './floor-probe-intent.mjs';
import { PROBE_INTENT_DIR } from '../../dist/runners/dispatch-tick.js';

function withStateDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), 'floor-probe-intent-'));
	const saved = process.env.HADOKU_STATE_DIR;
	process.env.HADOKU_STATE_DIR = dir;
	try {
		return fn(dir);
	} finally {
		process.env.HADOKU_STATE_DIR = saved;
		rmSync(dir, { recursive: true, force: true });
	}
}

test('declareProbeIntent writes one file per runner through the shared atomic writer, and release() removes it', () => {
	withStateDir((dir) => {
		const fail = () => assert.fail('must not fail for a TTL under the ceiling');
		const release = declareProbeIntent(
			{ repo: 'WolffM/app', job: 'check', node: 'claw-3', runnerName: 'probe-xyz' },
			{ fail, ttlSeconds: 60 }
		);
		const path = join(dir, PROBE_INTENT_DIR, 'probe-xyz.json');
		const doc = JSON.parse(readFileSync(path, 'utf8'));
		assert.equal(doc.repo, 'WolffM/app');
		assert.equal(doc.job, 'check');
		assert.equal(doc.node, 'claw-3');
		assert.equal(doc.runnerName, 'probe-xyz');
		assert.equal(typeof doc.expiresAtMs, 'number');
		assert.ok(!Number.isNaN(Date.parse(doc.at)));

		release();
		assert.equal(existsSync(path), false, 'release() unlinks the declared intent');
	});
});

test('declareProbeIntent fails loudly (never writes silently) when the TTL exceeds the dispatcher ceiling', () => {
	withStateDir((dir) => {
		let failed = null;
		declareProbeIntent(
			{ repo: 'WolffM/app', job: 'check', node: 'claw-3', runnerName: 'probe-over' },
			{ fail: (msg) => (failed = msg), ttlSeconds: 1000 }
		);
		assert.match(failed ?? '', /exceeds the dispatcher/);
		// `fail` is a plain callback here (not the CLI's process-exiting one), so
		// execution continues and still writes — proving the write itself is
		// unconditional on the ceiling check, exactly as before this move.
		assert.ok(existsSync(join(dir, PROBE_INTENT_DIR, 'probe-over.json')));
	});
});
