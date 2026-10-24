/**
 * #98 — `fleet tier-fleet` must fail when it looked at nothing, read every
 * source shape, and exempt reviewed FINDINGS rather than whole files.
 *
 * Every case runs in BOTH modes: the default, which reads each repo's shipped
 * branch through lib/fleet-source.mjs from fixture REMOTES with REPOS_DIR
 * EMPTY, and `--worktree`, which walks the same files under REPOS_DIR. The
 * remotes' git children strip GIT_* (lib/fleet-source-fixture.mjs, and see
 * lib/hook-safe-tests.test.mjs). `REPOS_DIR` / `HADOKU_SITE_ROOT` /
 * `FLEET_MANIFEST_DIR` all point into a throwaway directory, explicitly, so
 * neither an ambient blinding (`/nonexistent`) nor the operator's real
 * checkouts can leak in.
 *
 * The rules themselves are tested through their export in
 * lib/tier-detectors.test.mjs; this file covers what the CLI does around them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureRemotes, poisonedClone } from './lib/fleet-source-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-tier-fleet.mjs');

const NO_GIT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

const CLEAN = 'export const rank = { friend: 1, service: 2, wife: 3, admin: 4 };\n';
const DRIFT = "if (auth.userType === 'service') allow();\n";

/**
 * `repos`: name -> { path: content }. Every name is on the roster. `worktree`
 * writes the files under REPOS_DIR; otherwise they are pushed to fixture
 * remotes and REPOS_DIR stays empty.
 */
function fixture(repos, allowed, mode) {
	const remotes = fixtureRemotes('tier-fleet-gate-');
	const root = remotes.root;
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
		if (mode !== 'worktree') {
			remotes.push(`WolffM/${repo}`, files);
			continue;
		}
		mkdirSync(join(reposDir, repo), { recursive: true });
		for (const [rel, body] of Object.entries(files)) {
			mkdirSync(dirname(join(reposDir, repo, rel)), { recursive: true });
			writeFileSync(join(reposDir, repo, rel), body);
		}
	}
	return { root, manifestDir, reposDir, remotes, mode };
}

function run(fx) {
	try {
		const out = execFileSync('node', [SCRIPT, ...(fx.mode === 'worktree' ? ['--worktree'] : [])], {
			env: {
				...NO_GIT_ENV,
				...fx.remotes.env,
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

/** Runs `fn` once per mode, each against a fresh fixture. */
function withFixture(repos, allowed, fn) {
	for (const mode of ['shipped', 'worktree']) {
		const fx = fixture(repos, allowed, mode);
		try {
			fn(run(fx), mode);
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	}
}

test('floor: a clean repo passes', () => {
	withFixture({ 'tier-a': { 'src/tiers.ts': CLEAN } }, null, (r, mode) => {
		assert.equal(r.code, 0, `${mode}: ${r.all}`);
		const kind = mode === 'worktree' ? 'working-copy' : 'origin/main';
		assert.match(r.all, new RegExp(`Scanned 1 ${kind} files across 1/1 repos`));
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

test("#7: an unreadable repo is ONE finding carrying the reader's reason", () => {
	const fx = fixture({ 'tier-a': { 'src/tiers.ts': CLEAN } }, null, 'shipped');
	try {
		writeFileSync(
			join(fx.manifestDir, 'fleet-runner-coverage.json'),
			JSON.stringify({ repos: ['WolffM/tier-a', 'WolffM/never-pushed'], facets: {} })
		);
		const r = run(fx);
		assert.equal(r.code, 1, r.all);
		assert.match(r.all, /never-pushed\n\s+-:0\s+\[unreadable\]\n\s+fetch from .* failed/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

/**
 * fleet-manager#7: A LOCAL CLONE CANNOT CHANGE THE VERDICT. The baseline holds
 * a clone under REPOS_DIR whose origin is the shipped remote. Then it is
 * replaced by one that is CRLF, carries an uncommitted edit adding a
 * non-top-tier equality, and is BEHIND: its origin/main holds a file the remote
 * never shipped, and it cannot fetch (no origin — the host's credential is
 * gone). The default run must not move. Revert the gate to reading the clone
 * and the poisoned run audits the stale origin/main.
 */
test('#7: a CRLF, stale, dirty clone under REPOS_DIR does not change the verdict', () => {
	const files = { 'src/tiers.ts': CLEAN };
	const fx = fixture({ 'tier-a': files }, null, 'shipped');
	try {
		// A clone whose origin really is the remote, so a gate reading its
		// fetched origin/main passes the baseline too.
		const clone = poisonedClone(fx.reposDir, 'WolffM/tier-a', files);
		execFileSync('git', ['remote', 'add', 'origin', fx.remotes.remote('WolffM/tier-a')], {
			cwd: clone,
			env: NO_GIT_ENV,
		});
		const baseline = run(fx);
		assert.equal(baseline.code, 0, baseline.all);

		rmSync(join(fx.reposDir, 'tier-a'), { recursive: true, force: true });
		poisonedClone(
			fx.reposDir,
			'WolffM/tier-a',
			{ ...files, 'src/stale.ts': DRIFT },
			{ crlf: true, edit: { 'src/tiers.ts': CLEAN + DRIFT } }
		);
		const poisoned = run(fx);
		assert.equal(poisoned.code, baseline.code, poisoned.all);
		assert.equal(poisoned.all, baseline.all);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});
