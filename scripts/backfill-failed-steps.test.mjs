/**
 * backfill-failed-steps' argv (F8, plan §4.1): migrated onto the shared
 * strict parser (`scripts/lib/argv.mjs`/`argv-specs.mjs`) from a hand-rolled
 * `flag(name, fallback)`. `--help`/an unknown flag must exit before the
 * script ever reaches `fetch` (no mgmt-api, no network needed to prove it);
 * a known flag must reach the fetch — proven by pointing `--base` at a port
 * nothing listens on and asserting the failure is a CONNECTION error, never
 * "unknown flag".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'backfill-failed-steps.mjs');

function run(...args) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
	return { ...r, out: r.stdout + r.stderr };
}

test('--help prints usage and never reaches fetch', () => {
	const r = run('--help');
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /fleet backfill-failed-steps/);
	assert.match(r.out, /--max <n>/);
	assert.match(r.out, /--concurrency <n>/);
	assert.match(r.out, /--base <url>/);
	assert.doesNotMatch(r.out, /could not reach mgmt-api/);
});

test('an unknown flag exits 2 and never reaches fetch', () => {
	const r = run('--bogus');
	assert.equal(r.status, 2, r.out);
	assert.match(r.out, /unknown flag\(s\)/);
	assert.doesNotMatch(r.out, /could not reach mgmt-api/);
});

test('--max/--concurrency/--base pass the guard and reach fetch', () => {
	const r = run('--max', '7', '--concurrency', '2', '--base', 'http://127.0.0.1:1');
	assert.doesNotMatch(r.out, /unknown flag/);
	assert.equal(r.status, 1, r.out);
	assert.match(r.out, /could not reach mgmt-api at http:\/\/127\.0\.0\.1:1/);
});

test('--base=<url> (the = spelling) also reaches fetch', () => {
	const r = run('--base=http://127.0.0.1:1');
	assert.doesNotMatch(r.out, /unknown flag/);
	assert.equal(r.status, 1, r.out);
	assert.match(r.out, /could not reach mgmt-api at http:\/\/127\.0\.0\.1:1/);
});
