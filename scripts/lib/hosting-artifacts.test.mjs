import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { keepArtifact, readArtifact } from './hosting-artifacts.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const opts = { by: 'test', nowIso: new Date().toISOString() };

test('nothing kept is null; a kept artifact reads back with its hash; the same bytes twice write nothing', () => {
	const dir = mkdtempSync(join(tmpdir(), 'artifacts-'));
	try {
		assert.equal(readArtifact(dir, 'cardtable'), null);
		const bytes = Buffer.from('#!/bin/sh\necho agent\n');
		assert.deepEqual(keepArtifact(dir, 'cardtable', bytes, opts), { changed: true });
		const got = readArtifact(dir, 'cardtable');
		assert.equal(got.ok, true);
		assert.equal(got.sha256, sha(bytes));
		assert.deepEqual(keepArtifact(dir, 'cardtable', bytes, opts), { changed: false });
		const next = Buffer.from('#!/bin/sh\necho agent v2\n');
		assert.deepEqual(keepArtifact(dir, 'cardtable', next, opts), { changed: true });
		assert.equal(readArtifact(dir, 'cardtable').sha256, sha(next), 'the next install replaces it');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('bytes that no longer match their record are refused with the reason, never installed', () => {
	const dir = mkdtempSync(join(tmpdir(), 'artifacts-'));
	try {
		keepArtifact(dir, 'cardtable', Buffer.from('good'), opts);
		writeFileSync(join(dir, 'hosting-artifacts', 'cardtable', 'run'), 'tampered');
		const got = readArtifact(dir, 'cardtable');
		assert.equal(got.ok, false);
		assert.match(got.why, /hashes to .*, its record says/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
