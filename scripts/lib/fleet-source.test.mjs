/**
 * fleet-source — the shared reader of another repo's SHIPPED files
 * (fleet-manager#7). Run against real bare remotes over `file://`
 * (lib/fleet-source-fixture.mjs), never a mock of git.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { fixtureRemotes } from './fleet-source-fixture.mjs';
import { fixtureIdentityEnv } from './test-git-identity.mjs';
import {
	forgetHandles,
	shipped,
	shippedMany,
	tryShipped,
	UnreadableRepo,
} from './fleet-source.mjs';

const NO_GIT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

/** Run `fn` with the reader pointed at a fresh set of fixture remotes. */
function withRemotes(fn) {
	const fx = fixtureRemotes();
	const saved = {};
	for (const [k, v] of Object.entries(fx.env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	forgetHandles();
	try {
		return fn(fx);
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		forgetHandles();
		fx.cleanup();
	}
}

test('reads the default branch as pushed, with list/read/workflows', () => {
	withRemotes((fx) => {
		const sha = fx.push('WolffM/app', {
			'.github/workflows/ci.yml': 'jobs:\n  check:\n    runs-on: x\n',
			'.github/workflows/nested/skip.yml': 'not a workflow GitHub runs\n',
			'src/a.ts': 'export const a = 1;\n',
		});
		const h = shipped('WolffM/app');
		assert.equal(h.sha, sha);
		assert.deepEqual(h.list('src'), ['src/a.ts']);
		assert.deepEqual(h.list('src/'), ['src/a.ts']);
		assert.equal(h.read('src/a.ts'), 'export const a = 1;\n');
		assert.equal(h.read('src/missing.ts'), null, 'a path not in the tree is null, not a throw');
		assert.deepEqual(
			h.workflows().map((w) => w.file),
			['ci.yml'],
			'only direct children of .github/workflows are workflows'
		);
		assert.equal(h.hasWorkflowsDir(), true);
	});
});

test('a CRLF file reads with LF endings, and so does a lone CR (fleet-manager#5)', () => {
	withRemotes((fx) => {
		fx.push('WolffM/win', {
			'.github/workflows/daily.yml': 'jobs:\r\n  run:\r\n    runs-on: x\r\n',
			'old-mac.txt': 'a\rb\r',
		});
		const h = shipped('WolffM/win');
		assert.equal(h.workflows()[0].text, 'jobs:\n  run:\n    runs-on: x\n');
		assert.equal(h.read('old-mac.txt'), 'a\nb\n');
	});
});

test('the default branch is the remote HEAD, whatever it is called', () => {
	withRemotes((fx) => {
		fx.push('WolffM/trunked', { 'f.txt': 'on main\n' });
		const bare = fx.remote('WolffM/trunked');
		const g = (...a) =>
			execFileSync('git', a, { cwd: bare, env: NO_GIT_ENV, encoding: 'utf8' }).trim();
		const main = g('rev-parse', 'main');
		// A second branch with different content, made the default.
		const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
			cwd: bare,
			env: NO_GIT_ENV,
			input: 'on trunk\n',
			encoding: 'utf8',
		}).trim();
		const t = execFileSync('git', ['mktree'], {
			cwd: bare,
			env: NO_GIT_ENV,
			input: `100644 blob ${blob}\tf.txt\n`,
			encoding: 'utf8',
		}).trim();
		const c = execFileSync('git', ['commit-tree', t, '-p', main, '-m', 'trunk'], {
			cwd: bare,
			env: { ...NO_GIT_ENV, ...fixtureIdentityEnv() },
			encoding: 'utf8',
		}).trim();
		g('update-ref', 'refs/heads/trunk', c);
		g('symbolic-ref', 'HEAD', 'refs/heads/trunk');
		assert.equal(shipped('WolffM/trunked').read('f.txt'), 'on trunk\n');
	});
});

test('the mirror is blobless: a blob is fetched only when read', () => {
	withRemotes((fx) => {
		fx.push('WolffM/lazy', { 'big.txt': 'x'.repeat(10_000), 'small.txt': 'y\n' });
		const h = shipped('WolffM/lazy');
		const mirror = join(process.env.FLEET_SOURCE_CACHE, 'WolffM', 'lazy.git');
		const has = (path) => {
			try {
				execFileSync('git', ['-C', mirror, 'cat-file', '-e', `${h.sha}:${path}`], {
					env: { ...NO_GIT_ENV, GIT_NO_LAZY_FETCH: '1' },
					stdio: 'ignore',
				});
				return true;
			} catch {
				return false;
			}
		};
		assert.equal(has('big.txt'), false, 'opening the repo must not download blobs');
		h.read('small.txt');
		assert.equal(has('small.txt'), true);
		assert.equal(has('big.txt'), false, 'reading one file must not download the others');
	});
});

test('a new push is seen on the next read, and the reader fetches it itself', () => {
	withRemotes((fx) => {
		fx.push('WolffM/moving', { 'v.txt': '1\n' });
		assert.equal(shipped('WolffM/moving').read('v.txt'), '1\n');
		fx.push('WolffM/moving', { 'v.txt': '2\n' });
		forgetHandles();
		assert.equal(shipped('WolffM/moving').read('v.txt'), '2\n');
	});
});

test('within FLEET_SOURCE_MAX_AGE_S the reader reuses ITS OWN last fetch', () => {
	withRemotes((fx) => {
		fx.push('WolffM/fresh', { 'v.txt': '1\n' });
		shipped('WolffM/fresh');
		fx.push('WolffM/fresh', { 'v.txt': '2\n' });
		forgetHandles();
		process.env.FLEET_SOURCE_MAX_AGE_S = '3600';
		assert.equal(shipped('WolffM/fresh').read('v.txt'), '1\n');
	});
});

test('a repo that does not exist is UnreadableRepo with the reason', () => {
	withRemotes(() => {
		assert.throws(
			() => shipped('WolffM/nowhere'),
			(err) => err instanceof UnreadableRepo && /fetch from .* failed/.test(err.reason)
		);
		const t = tryShipped('WolffM/nowhere');
		assert.match(t.unreadable, /does not appear to be a git repository|not found|No such/);
	});
});

test('a failed fetch over an OLD mirror is unreadable, never "last known"', () => {
	withRemotes((fx) => {
		fx.push('WolffM/gone', { 'v.txt': '1\n' });
		assert.equal(shipped('WolffM/gone').read('v.txt'), '1\n');
		renameSync(fx.remote('WolffM/gone'), fx.remote('WolffM/gone') + '.moved');
		forgetHandles();
		assert.throws(() => shipped('WolffM/gone'), UnreadableRepo);
	});
});

test('fetch: false reads the mirror as it stands, and refuses when there is none', () => {
	withRemotes((fx) => {
		assert.throws(() => shipped('WolffM/offline', { fetch: false }), UnreadableRepo);
		fx.push('WolffM/offline', { 'v.txt': '1\n' });
		shipped('WolffM/offline').read('v.txt');
		fx.push('WolffM/offline', { 'v.txt': '2\n' });
		forgetHandles();
		assert.equal(shipped('WolffM/offline', { fetch: false }).read('v.txt'), '1\n');
	});
});

test('readMany over a whole tree, lastCommitSec, materialize', () => {
	withRemotes((fx) => {
		const files = {};
		for (let i = 0; i < 300; i++) files[`src/f${i}.ts`] = `export const n = ${i};\r\n`;
		files['bin.dat'] = Buffer.from([0, 1, 2, 13, 10]).toString('latin1');
		fx.push('WolffM/wide', files);
		const h = shipped('WolffM/wide');
		const all = h.readMany(h.list('src'));
		assert.equal(all.size, 300);
		assert.equal(all.get('src/f7.ts'), 'export const n = 7;\n');
		assert.ok(h.lastCommitSec('src/f7.ts') > 0);
		assert.equal(h.lastCommitSec('never/was.ts'), null);
		const root = h.materialize({ include: (p) => p.endsWith('.ts') || p === 'bin.dat' });
		assert.equal(readFileSync(join(root, 'src/f9.ts'), 'utf8'), 'export const n = 9;\n');
		assert.ok(readFileSync(join(root, 'bin.dat')).includes(13), 'binary bytes are not rewritten');
	});
});

test('shippedMany splits readable from unreadable and drops neither', () => {
	withRemotes((fx) => {
		fx.push('WolffM/a', { 'x.txt': 'x\n' });
		const many = shippedMany(['WolffM/a', 'WolffM/missing']);
		assert.deepEqual([...many.repos.keys()], ['WolffM/a']);
		assert.deepEqual(
			many.unreadable.map((u) => u.repo),
			['WolffM/missing']
		);
		assert.ok(many.unreadable[0].reason);
	});
});

test('four processes reading one mirror at once all succeed (ci:audit-gates beside a pre-push)', async () => {
	const fx = fixtureRemotes();
	try {
		const files = {};
		for (let i = 0; i < 200; i++) files[`src/f${i}.ts`] = `export const n = ${i};\n`;
		fx.push('WolffM/shared', files);
		const reader = new URL('./fleet-source.mjs', import.meta.url).href;
		const code =
			`const m = await import(${JSON.stringify(reader)});` +
			`const h = m.shipped('WolffM/shared');` +
			`const all = h.readMany(h.list('src'));` +
			`if (all.get('src/f7.ts') !== 'export const n = 7;\\n') throw new Error('bad read');` +
			`console.log(all.size);`;
		const { spawn } = await import('node:child_process');
		const runs = Array.from(
			{ length: 4 },
			() =>
				new Promise((done) => {
					const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
						env: { ...NO_GIT_ENV, ...fx.env },
					});
					let out = '';
					let err = '';
					child.stdout.on('data', (d) => (out += d));
					child.stderr.on('data', (d) => (err += d));
					child.on('close', (status) => done({ status, out: out.trim(), err }));
				})
		);
		for (const r of await Promise.all(runs)) {
			assert.equal(r.status, 0, r.err);
			assert.equal(r.out, '200');
		}
	} finally {
		fx.cleanup();
	}
});

test('under node --test, a reader with no FLEET_SOURCE_URL refuses instead of reading GitHub', () => {
	const saved = process.env.FLEET_SOURCE_URL;
	delete process.env.FLEET_SOURCE_URL;
	forgetHandles();
	try {
		assert.ok(process.env.NODE_TEST_CONTEXT, 'this file must run under node --test');
		assert.match(tryShipped('WolffM/hadoku_site').unreadable, /no FLEET_SOURCE_URL/);
	} finally {
		if (saved !== undefined) process.env.FLEET_SOURCE_URL = saved;
	}
});
