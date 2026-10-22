/**
 * convert.sh walks past exactly one class of failure, and it has to name it by
 * an id that claw-fix.sh actually records.
 *
 * If claw-fix ever renames the `host` check, convert.sh keeps refusing to walk
 * past it — and since EVERY freshly imaged node fails that check (the installer
 * never asks for a hostname at priority=critical), convert would then block the
 * entire fleet on a string mismatch, with a message about a fault that is
 * completely normal.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONVERT = join(HERE, '..', 'convert.sh');
const FIX = join(HERE, 'claw-fix.sh');
const src = readFileSync(CONVERT, 'utf8');
const fix = readFileSync(FIX, 'utf8');

const EXPECTED = (src.match(/^EXPECTED_BEFORE_BOOTSTRAP="([^"]*)"/m)?.[1] ?? '')
	.split(/\s+/)
	.filter(Boolean);

test('convert.sh is valid POSIX sh', () => {
	const r = spawnSync('sh', ['-n', CONVERT], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
});

test('every id it walks past is a check claw-fix actually records', () => {
	assert.ok(EXPECTED.length > 0, 'EXPECTED_BEFORE_BOOTSTRAP did not parse');
	const recorded = new Set([...fix.matchAll(/\brecord\s+([a-z0-9_]+)\s/g)].map((m) => m[1]));
	for (const id of EXPECTED) {
		assert.ok(
			recorded.has(id),
			`convert.sh walks past "${id}", which claw-fix.sh does not record. ` +
				`Every new node fails that check, so convert would block the whole fleet.`
		);
	}
});

test('it walks past the unnamed hostname, and ONLY that', () => {
	// Deliberately tight. Each id here is a fault this script decides to ignore,
	// and the list growing quietly is how "it stopped before half-converting"
	// turns back into "it half-converted".
	assert.deepEqual(EXPECTED, ['host']);
});

test('it refuses to convert when it cannot read what failed', () => {
	// Proceeding blind is exactly how a half-converted node happens.
	assert.match(src, /left no checks\.txt to read/);
	assert.match(src, /Not converting/);
});

test('--check never reaches node-bootstrap', () => {
	assert.match(src, /\*--check\*\)/, '--check is not intercepted before the convert step');
});
