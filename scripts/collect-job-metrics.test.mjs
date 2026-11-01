/**
 * collect-job-metrics' argv (F8, plan §4.1): migrated onto the shared strict
 * parser from a hand-rolled `flag(name, fallback)`. Characterization test —
 * none existed before this migration.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';

afterEach(cleanupTempDirs);

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'collect-job-metrics.mjs');

function run(...args) {
	const state = tempDir('collect-job-metrics-state-');
	const r = spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: join(state, 'no-such-manifests'),
			HADOKU_STATE_DIR: state,
		},
	});
	return { ...r, out: r.stdout + r.stderr };
}

test('--help prints usage, touches nothing, and never reaches the manifest', () => {
	const r = run('--help');
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /fleet job-metrics — what each job COST/);
	assert.match(r.out, /--min-runs <n>/);
	// The real retention-days value is interpolated into the placeholder.
	assert.match(r.out, /job-history's 14-day window/);
	assert.doesNotMatch(r.out, /\{RETENTION_DAYS\}/);
});

test('an unknown flag exits 2 before the manifest is ever read', () => {
	const r = run('--bogus');
	assert.equal(r.status, 2, r.out);
	assert.match(r.out, /unknown flag\(s\)/);
	assert.doesNotMatch(r.out, /ENOENT|siteRoot|manifest/i);
});

test('the known flags pass the guard (and then need a manifest)', () => {
	const r = run('--machine', 'claw-3', '--min-runs', '5', '--json');
	assert.doesNotMatch(r.out, /unknown flag/);
	assert.notEqual(r.status, 2, r.out);
});
