import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const LIB = fileURLToPath(new URL('.', import.meta.url));
const SCRIPTS = join(LIB, '..');
const reader = `import(${JSON.stringify(pathToFileURL(join(LIB, 'stdin.mjs')).href)})
	.then((m) => process.stdout.write(String(m.readStdinWhole().length)))`;

test('spawnSync input (a non-blocking socketpair) is read whole', () => {
	const input = 'x'.repeat(300_000);
	const r = spawnSync(process.execPath, ['-e', reader], { input, encoding: 'utf8' });
	assert.equal(r.stderr, '');
	assert.equal(r.stdout, String(input.length));
});

test('a writer that is slow to start is waited for, not read as EAGAIN', async () => {
	const child = spawn(process.execPath, ['-e', reader]);
	let out = '';
	let err = '';
	child.stdout.on('data', (d) => (out += d));
	child.stderr.on('data', (d) => (err += d));
	await new Promise((r) => setTimeout(r, 300));
	child.stdin.end('late but whole');
	await new Promise((r) => child.on('close', r));
	assert.equal(err, '');
	assert.equal(out, String('late but whole'.length));
});

test('no script reads fd 0 with readFileSync', () => {
	const files = [
		...readdirSync(SCRIPTS).map((f) => join(SCRIPTS, f)),
		...readdirSync(LIB).map((f) => join(LIB, f)),
	].filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
	const bad = files.filter((f) =>
		/readFileSync\(\s*(0|['"]\/dev\/stdin['"])/.test(blankComments(readFileSync(f, 'utf8')))
	);
	assert.deepEqual(bad, [], 'use readStdinWhole() from lib/stdin.mjs');
});
