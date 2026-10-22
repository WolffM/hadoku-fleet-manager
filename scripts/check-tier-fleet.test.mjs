/**
 * #98 — `fleet tier-fleet` must fail when it looked at nothing, read every
 * source shape, and exempt reviewed FINDINGS rather than whole files.
 *
 * Exercised as a CLI over `--worktree`, which walks the filesystem, so NOTHING
 * HERE SPAWNS git — see lib/hook-safe-tests.test.mjs for why that matters.
 * `REPOS_DIR` / `HADOKU_SITE_ROOT` / `FLEET_MANIFEST_DIR` all point into a
 * throwaway directory, explicitly, so neither an ambient blinding
 * (`/nonexistent`) nor the operator's real checkouts can leak in.
 *
 * The rules themselves are tested through their export in
 * lib/tier-detectors.test.mjs; this file covers what the CLI does around them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-tier-fleet.mjs');

const NO_GIT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

const CLEAN = 'export const rank = { friend: 1, service: 2, wife: 3, admin: 4 };\n';
const DRIFT = "if (auth.userType === 'service') allow();\n";

/** `repos`: name -> { path: content }. Every name is on the roster. */
function fixture(repos, allowed) {
	const root = mkdtempSync(join(tmpdir(), 'tier-fleet-gate-'));
	const manifestDir = join(root, 'manifest');
	const reposDir = join(root, 'repos');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(reposDir, { recursive: true });
	writeFileSync(
		join(manifestDir, 'fleet-runner-coverage.json'),
		JSON.stringify({ repos: Object.keys(repos).map((r) => `WolffM/${r}`), facets: {} })
	);
	if (allowed) {
		writeFileSync(join(manifestDir, 'tier-fleet-allowlist.json'), JSON.stringify({ allowed }));
	}
	for (const [repo, files] of Object.entries(repos)) {
		mkdirSync(join(reposDir, repo), { recursive: true });
		for (const [rel, body] of Object.entries(files)) {
			mkdirSync(dirname(join(reposDir, repo, rel)), { recursive: true });
			writeFileSync(join(reposDir, repo, rel), body);
		}
	}
	return { root, manifestDir, reposDir };
}

function run(fx) {
	try {
		const out = execFileSync('node', [SCRIPT, '--worktree'], {
			env: {
				...NO_GIT_ENV,
				REPOS_DIR: fx.reposDir,
				HADOKU_SITE_ROOT: fx.root,
				FLEET_MANIFEST_DIR: fx.manifestDir,
			},
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, all: out };
	} catch (e) {
		return { code: e.status ?? -1, all: `${e.stdout ?? ''}${e.stderr ?? ''}` };
	}
}

function withFixture(repos, allowed, fn) {
	const fx = fixture(repos, allowed);
	try {
		fn(run(fx));
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
}

test('floor: a clean repo passes', () => {
	withFixture({ 'tier-a': { 'src/tiers.ts': CLEAN } }, null, (r) => {
		assert.equal(r.code, 0, r.all);
		assert.match(r.all, /Scanned 1 working-copy files across 1\/1 repos/);
	});
});

test('an EMPTY roster fails — "Scanned 0 files across 0/0 repos" is not clean', () => {
	withFixture({}, null, (r) => {
		assert.equal(r.code, 1, r.all);
		assert.match(r.all, /ZERO repos/);
	});
});

test('a repo yielding ZERO scannable files fails, naming the repo', () => {
	withFixture(
		{ 'tier-a': { 'src/tiers.ts': CLEAN }, 'tier-rust': { 'src/main.rs': 'fn main() {}\n' } },
		null,
		(r) => {
			assert.equal(r.code, 1, r.all);
			assert.match(r.all, /tier-rust[\s\S]*nothing scanned/);
		}
	);
});

test('...unless a reviewed `repo:*` entry says it has nothing to scan', () => {
	withFixture(
		{ 'tier-a': { 'src/tiers.ts': CLEAN }, 'tier-rust': { 'src/main.rs': 'fn main() {}\n' } },
		[{ file: 'tier-rust:*', why: 'a Rust crate: no JS/TS/Python by construction' }],
		(r) => assert.equal(r.code, 0, r.all)
	);
});

for (const ext of ['.cjs', '.cts', '.mts', '.vue', '.svelte']) {
	test(`a gate in a ${ext} file is read`, () => {
		withFixture({ 'tier-a': { 'src/tiers.ts': CLEAN, [`src/gate${ext}`]: DRIFT } }, null, (r) => {
			assert.equal(r.code, 1, r.all);
			assert.match(r.all, new RegExp(`src/gate\\${ext}:1`));
		});
	});
}

const INVERSE = "export const REFUSED = ['friend', 'service', 'wife'];\n";

test('a whole-file entry (no `lines`/`count`) still exempts the file, as before', () => {
	withFixture(
		{ 'tier-a': { 'src/inverse.ts': INVERSE } },
		[{ file: 'tier-a:src/inverse.ts', why: 'inverse list' }],
		(r) => assert.equal(r.code, 0, r.all)
	);
});

test('`lines`: NEW drift elsewhere in an exempted file fires', () => {
	withFixture(
		{ 'tier-a': { 'src/inverse.ts': INVERSE + DRIFT } },
		[{ file: 'tier-a:src/inverse.ts', why: 'inverse list', lines: [1] }],
		(r) => {
			assert.equal(r.code, 1, r.all);
			assert.match(r.all, /src\/inverse\.ts:2/);
			assert.doesNotMatch(r.all, /src\/inverse\.ts:1 /);
		}
	);
});

test('`lines`: the reviewed line alone passes', () => {
	withFixture(
		{ 'tier-a': { 'src/inverse.ts': INVERSE } },
		[{ file: 'tier-a:src/inverse.ts', why: 'inverse list', lines: [1] }],
		(r) => assert.equal(r.code, 0, r.all)
	);
});

test('`count`: one finding more than reviewed makes them all live', () => {
	withFixture(
		{ 'tier-a': { 'src/inverse.ts': INVERSE + DRIFT } },
		[{ file: 'tier-a:src/inverse.ts', why: 'inverse list', count: 1 }],
		(r) => {
			assert.equal(r.code, 1, r.all);
			assert.match(r.all, /reviewed 1 here, now 2/);
		}
	);
});

test('`count`: fewer findings than reviewed is a stale entry', () => {
	withFixture(
		{ 'tier-a': { 'src/inverse.ts': INVERSE } },
		[{ file: 'tier-a:src/inverse.ts', why: 'inverse list', count: 2 }],
		(r) => {
			assert.equal(r.code, 1, r.all);
			assert.match(r.all, /stale allowlist entry[\s\S]*lower "count"/);
		}
	);
});

test('an entry for a file that no longer trips any rule is stale', () => {
	withFixture(
		{ 'tier-a': { 'src/inverse.ts': CLEAN } },
		[{ file: 'tier-a:src/inverse.ts', why: 'inverse list' }],
		(r) => {
			assert.equal(r.code, 1, r.all);
			assert.match(r.all, /stale allowlist entry/);
		}
	);
});
