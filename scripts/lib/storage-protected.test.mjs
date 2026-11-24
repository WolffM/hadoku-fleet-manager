/**
 * THE POOL IS A PROTECTED CONSUMER (fleet-manager#141): no sweep, debris
 * cleaner or cache reclaim may name the storage root. A root-disk zone holds
 * pool data on the same filesystem CI's `_work` and caches live on, so a
 * cleaner that reached `/srv/storage` would delete one of three copies.
 *
 * Measured 2026-11-23: no file that deletes anything names `/srv/storage`
 * (ci-throttle.sh's `/srv` is `$HOME/srv/hadoku_site`). This keeps it so. The
 * storage modules themselves create and own the directory and are listed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

import { STORAGE_ROOT } from './storage-format.mjs';

const OWNERS = new Set([
	'scripts/lib/storage-format.mjs',
	'scripts/lib/garage-apply.mjs',
	'scripts/lib/garage-layout.mjs',
	'scripts/lib/toolchain-garage.mjs',
	'src/lib/capability-registry-storage.ts',
]);
const DELETES = /\brm\s+-[a-z]*r|\brmSync\b|\bunlinkSync\b|\s-delete\b|\brmdir\b/;

test('no file that deletes anything names the storage root, outside the storage modules', () => {
	const files = execFileSync('git', ['ls-files', 'scripts', 'src', 'deploy', 'herdr'], {
		encoding: 'utf8',
	})
		.split('\n')
		.filter(
			(f) => /\.(sh|mjs|ts|js)$/.test(f) && !/\.test\.(mjs|ts)$/.test(f) && !f.includes('/tests/')
		);
	assert.ok(files.length > 100, `only ${files.length} files listed: the guard would see nothing`);
	const bad = files.filter((f) => {
		if (OWNERS.has(f)) return false;
		const text = readFileSync(f, 'utf8');
		return DELETES.test(text) && text.includes(STORAGE_ROOT);
	});
	assert.deepEqual(
		bad,
		[],
		`these delete files and name ${STORAGE_ROOT}: the pool is never reclaimable`
	);
});
