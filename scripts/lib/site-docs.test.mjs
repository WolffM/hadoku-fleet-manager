/**
 * F7 (plan §4.1): the shared reader every migrated caller now goes through
 * instead of its own `join(siteRoot(), 'scripts', '<file>.json')` +
 * `readFileSync` + `try`/`catch`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHILD_APPS_FILE, PM2_HOSTS_FILE, readChildApps, readPm2Hosts } from './site-docs.mjs';
import { tempDir } from './test-tmpdir.mjs';

/** A fake hadoku_site checkout with `scripts/<file>.json`, or neither. */
function site({ pm2Hosts, childApps } = {}) {
	const root = tempDir('site-docs-');
	mkdirSync(join(root, 'scripts'), { recursive: true });
	if (pm2Hosts !== undefined) writeFileSync(join(root, PM2_HOSTS_FILE), JSON.stringify(pm2Hosts));
	if (childApps !== undefined)
		writeFileSync(join(root, CHILD_APPS_FILE), JSON.stringify(childApps));
	return root;
}

test('an explicit root reads the doc, never consulting siteRoot()', () => {
	const root = site({ pm2Hosts: { hub: 'hokon', hosts: { hokon: {} } } });
	const r = readPm2Hosts({ root });
	assert.equal(r.ok, true);
	assert.deepEqual(r.doc, { hub: 'hokon', hosts: { hokon: {} } });
	assert.equal(r.path, join(root, PM2_HOSTS_FILE));
});

test('child-apps.json reads the same way', () => {
	const root = site({ childApps: { apps: [{ id: 'x', repoName: 'hadoku-x' }] } });
	const r = readChildApps({ root });
	assert.equal(r.ok, true);
	assert.deepEqual(r.doc.apps, [{ id: 'x', repoName: 'hadoku-x' }]);
});

test('a missing file is {ok:false}, never {} — "I could not look" names the path', () => {
	const root = site({});
	const r = readPm2Hosts({ root });
	assert.equal(r.ok, false);
	assert.match(r.why, /pm2-hosts\.json/);
	assert.match(r.why, /ENOENT/);
	assert.equal(r.path, join(root, PM2_HOSTS_FILE));
});

test('unparseable JSON is {ok:false} with the parse reason, not a thrown exception', () => {
	const root = site({});
	writeFileSync(join(root, PM2_HOSTS_FILE), 'not json');
	const r = readPm2Hosts({ root });
	assert.equal(r.ok, false);
	assert.match(r.why, /pm2-hosts\.json/);
	assert.doesNotMatch(r.why, /ENOENT/);
});

test('siteRoot() is the default when no root is given', () => {
	const root = site({ pm2Hosts: { hub: 'h', hosts: {} } });
	const before = process.env.HADOKU_SITE_ROOT;
	process.env.HADOKU_SITE_ROOT = root;
	try {
		const r = readPm2Hosts();
		assert.equal(r.ok, true);
		assert.equal(r.path, join(root, PM2_HOSTS_FILE));
	} finally {
		if (before === undefined) delete process.env.HADOKU_SITE_ROOT;
		else process.env.HADOKU_SITE_ROOT = before;
	}
});

test('a `read` option replaces path resolution entirely, for a ref-pinned caller', () => {
	const calls = [];
	const r = readChildApps({
		read: (file) => {
			calls.push(file);
			return JSON.stringify({ apps: [{ id: 'y' }] });
		},
	});
	assert.deepEqual(calls, [CHILD_APPS_FILE], 'the bare relative name, no directory joined');
	assert.equal(r.ok, true);
	assert.deepEqual(r.doc.apps, [{ id: 'y' }]);
	assert.equal(r.path, CHILD_APPS_FILE);
});

test('a `read` that returns null (a ref-pinned miss) is {ok:false}, matching a missing file', () => {
	const r = readChildApps({ read: () => null });
	assert.equal(r.ok, false);
	assert.match(r.why, /could not be read/);
});

test('siteRoot() itself throwing (misconfigured HADOKU_SITE_ROOT) is {ok:false}, not an escaping throw', () => {
	const before = process.env.HADOKU_SITE_ROOT;
	process.env.HADOKU_SITE_ROOT = '/nonexistent-site-root-for-this-test';
	try {
		const r = readPm2Hosts();
		assert.equal(r.ok, false);
		assert.ok(r.why.length > 0, 'the reason is said, not dropped');
	} finally {
		if (before === undefined) delete process.env.HADOKU_SITE_ROOT;
		else process.env.HADOKU_SITE_ROOT = before;
	}
});
