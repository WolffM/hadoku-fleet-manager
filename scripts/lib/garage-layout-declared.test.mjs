import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { GARAGE_LAYOUT_FILE, declaredMembers } from './garage-layout-declared.mjs';

const withFile = (text, fn) => {
	const dir = mkdtempSync(join(tmpdir(), 'garage-layout-declared-'));
	try {
		const path = join(dir, GARAGE_LAYOUT_FILE);
		if (text !== null) writeFileSync(path, text);
		fn(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

test('every declared zone is a member, drained ones included, sorted', () =>
	withFile(
		JSON.stringify({
			version: 1,
			zones: {
				'claw-9': { state: 'active', disks: [] },
				'claw-1': { state: 'drain', disks: [] },
			},
		}),
		(path) => assert.deepEqual(declaredMembers(path), { nodes: ['claw-1', 'claw-9'], error: null })
	));

test('no file is no members, said as no error', () =>
	withFile(null, (path) => assert.deepEqual(declaredMembers(path), { nodes: [], error: null })));

test('an unreadable file is an error, never an empty pool', () =>
	withFile('{ not json', (path) => {
		const m = declaredMembers(path);
		assert.deepEqual(m.nodes, []);
		assert.match(m.error, /is unreadable/);
	}));
