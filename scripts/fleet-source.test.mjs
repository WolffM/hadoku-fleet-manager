/**
 * `fleet source` — the CLI door onto lib/fleet-source.mjs (hadoku_site#483's
 * Python and TypeScript consumers read through it). Against fixture remotes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureRemotes } from './lib/fleet-source-fixture.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'fleet-source.mjs');

function run(fx, ...args) {
	try {
		const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
			env: { ...process.env, ...fx.env },
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, stdout, stderr: '' };
	} catch (err) {
		return { code: err.status, stdout: err.stdout, stderr: err.stderr };
	}
}

test('list and read, plain and --json', () => {
	const fx = fixtureRemotes();
	try {
		const sha = fx.push('WolffM/app', {
			'.devvault.json': '{"keys":[]}\r\n',
			'src/a.ts': 'a\n',
			'src/b.ts': 'b\n',
		});
		assert.equal(run(fx, 'list', 'WolffM/app', 'src').stdout, 'src/a.ts\nsrc/b.ts\n');
		const listed = JSON.parse(run(fx, 'list', 'WolffM/app', '--json').stdout);
		assert.deepEqual(listed, {
			repo: 'WolffM/app',
			sha,
			files: ['.devvault.json', 'src/a.ts', 'src/b.ts'],
		});
		assert.equal(run(fx, 'read', 'WolffM/app', '.devvault.json').stdout, '{"keys":[]}\n');
		const read = JSON.parse(run(fx, 'read', 'WolffM/app', 'src/a.ts', '--json').stdout);
		assert.deepEqual(read, { repo: 'WolffM/app', sha, path: 'src/a.ts', text: 'a\n' });
	} finally {
		fx.cleanup();
	}
});

test('a path not in the tree is text null and exit 1; an unreadable repo says why', () => {
	const fx = fixtureRemotes();
	try {
		fx.push('WolffM/app', { 'x.txt': 'x\n' });
		const missing = run(fx, 'read', 'WolffM/app', 'nope.txt', '--json');
		assert.equal(missing.code, 1);
		assert.equal(JSON.parse(missing.stdout).text, null);
		const gone = run(fx, 'list', 'WolffM/nowhere', '--json');
		assert.equal(gone.code, 1);
		assert.match(JSON.parse(gone.stdout).unreadable, /fetch from .* failed/);
		assert.equal(run(fx, 'frob', 'WolffM/app').code, 2);
	} finally {
		fx.cleanup();
	}
});

test('a file past the 8 KB pipe cliff arrives whole', () => {
	const fx = fixtureRemotes();
	try {
		const big = 'line of text\n'.repeat(20_000);
		fx.push('WolffM/app', { 'big.txt': big });
		const out = run(fx, 'read', 'WolffM/app', 'big.txt');
		assert.equal(out.code, 0);
		assert.equal(out.stdout.length, big.length);
	} finally {
		fx.cleanup();
	}
});
