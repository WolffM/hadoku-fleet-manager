import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
	declareBucket,
	declareZone,
	drainZone,
	recordOverride,
	updateDeclared,
} from './garage-layout-state.mjs';
import { GARAGE_LAYOUT_FILE, readDeclared } from './garage-layout-declared.mjs';

const withDir = (fn) => {
	const dir = mkdtempSync(join(tmpdir(), 'garage-layout-state-'));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

test('a missing file is an empty pool; declarations round-trip', () =>
	withDir((dir) => {
		const path = join(dir, GARAGE_LAYOUT_FILE);
		assert.deepEqual(readDeclared(path).declared, {
			version: 1,
			zones: {},
			buckets: {},
			overrides: [],
		});
		updateDeclared(
			(d) => declareZone(d, 'claw-9', [{ serial: 'S9', capacityBytes: 8e11 }], 'T1'),
			dir
		);
		updateDeclared((d) => declareBucket(d, 'photos', 'dp-photos', 'T2'), dir);
		updateDeclared((d) => drainZone(d, 'claw-9', 'T3'), dir);
		updateDeclared((d) => recordOverride(d, ['floor'], 'retiring the pilot', 'T4'), dir);
		const { declared } = readDeclared(path);
		assert.deepEqual(declared.zones['claw-9'], {
			state: 'drain',
			disks: [{ serial: 'S9', capacityBytes: 8e11 }],
			at: 'T3',
		});
		assert.deepEqual(declared.buckets.photos, { key: 'dp-photos', at: 'T2' });
		assert.deepEqual(declared.overrides, [
			{ at: 'T4', rules: ['floor'], reason: 'retiring the pilot' },
		]);
	}));

test('an unreadable file is said and never written over', () =>
	withDir((dir) => {
		const path = join(dir, GARAGE_LAYOUT_FILE);
		writeFileSync(path, '{ not json');
		assert.match(readDeclared(path).error, /is unreadable/);
		assert.throws(
			() => updateDeclared((d) => declareBucket(d, 'x', 'k', 'T'), dir),
			/not writing over it/
		);
		assert.equal(readFileSync(path, 'utf8'), '{ not json');
	}));

test('draining an undeclared zone is refused', () => {
	assert.throws(() => drainZone({ zones: {} }, 'claw-9', 'T'), /claw-9 is not a declared zone/);
});
