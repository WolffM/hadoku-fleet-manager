#!/usr/bin/env node
// clean-runner-debris.sh — wave 4b (#100, #101). Drives the REAL script
// against fixture roots only: never the real /tmp, ~/.hadoku, or ~/.cache.
//
// FENCE: every spawn of the script goes through run() below, which THROWS
// unless HOME, TMPFS_ROOT, TMPDIR_DISK, NODE_COMPILE_CACHE_DISK, JIT_ROOT and
// RUNNER_ENV_FILE are all set and all resolve inside the fixture root passed
// to it. No test may spawn the script any other way. The ambient process env
// is never spread into the child — only PATH (stub bin dir first) plus the
// fixture vars and the knobs each test is exercising.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	symlinkSync,
	existsSync,
	utimesSync,
	readdirSync,
	readFileSync,
	chmodSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SH = join(__dirname, 'clean-runner-debris.sh');
const REQUIRED_VARS = [
	'HOME',
	'TMPFS_ROOT',
	'TMPDIR_DISK',
	'NODE_COMPILE_CACHE_DISK',
	'JIT_ROOT',
	'RUNNER_ENV_FILE',
];

/** Every fixture and stub dir this file creates, removed when the suite ends.
 *  They used to be left behind: 1,331 `crd-fix-*` and 1,209 `crd-bin-*` sat in
 *  the claws' /tmp on 2026-10-10, from CI runs of this very suite. */
const created = [];
after(() => {
	for (const d of created) rmSync(d, { recursive: true, force: true });
});

/** A fresh fixture root for one test. Nothing outside it may be touched. */
function mkfixture() {
	const d = mkdtempSync(join(tmpdir(), 'crd-fix-'));
	created.push(d);
	return d;
}

/** Age a path N minutes (or days*1440) into the past. */
function age(path, minutesAgo) {
	const t = (Date.now() - minutesAgo * 60_000) / 1000;
	utimesSync(path, t, t);
}

/** Age every entry under root (root included) N minutes into the past. */
function ageAll(root, minutesAgo) {
	age(root, minutesAgo);
	for (const name of readdirSync(root, { recursive: true })) {
		age(join(root, name), minutesAgo);
	}
}

/** Build the standard fenced env for a fixture root; overrides win. */
function baseEnv(fixtureRoot, overrides = {}) {
	const home = join(fixtureRoot, 'home');
	mkdirSync(home, { recursive: true });
	return {
		HOME: home,
		TMPFS_ROOT: join(fixtureRoot, 'tmp'),
		TMPDIR_DISK: join(fixtureRoot, 'disk-tmp'),
		NODE_COMPILE_CACHE_DISK: join(fixtureRoot, 'disk-tmp', 'node-compile-cache'),
		JIT_ROOT: join(home, '.hadoku', 'jit'),
		RUNNER_ENV_FILE: join(home, '.hadoku', 'runner.env'),
		APPLY: '1',
		...overrides,
	};
}

/** Fake pgrep/lsof/fuser. Default: nothing live, nothing open — deterministic
 *  regardless of what is actually installed or running on the host this
 *  suite executes on (CI runs it mid-job, with a real live Worker/Listener
 *  and a real tmpfs /tmp on the node; none of that may leak in). */
function mkStubBin({ workerPid, listenerPid, lsofHit, lsofOpen } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'crd-bin-'));
	created.push(dir);
	writeFileSync(
		join(dir, 'pgrep'),
		`#!/bin/sh\ncase "$2" in\n` +
			`Runner.Worker) ${workerPid ? `echo ${workerPid}; exit 0` : 'exit 1'} ;;\n` +
			`Runner.Listener) ${listenerPid ? `echo ${listenerPid}; exit 0` : 'exit 1'} ;;\n` +
			`esac\nexit 1\n`
	);
	// `lsofOpen`: paths reported open, in `lsof -Fn` form, which is what the
	// bulk passes ask for (one call per root, see open_tops()).
	const lsofBody = lsofOpen
		? lsofOpen.map((p) => `echo 'n${p}'`).join('\n') + '\nexit 0'
		: lsofHit
			? 'echo fake-open; exit 0'
			: 'exit 1';
	writeFileSync(join(dir, 'lsof'), `#!/bin/sh\n${lsofBody}\n`);
	writeFileSync(join(dir, 'fuser'), `#!/bin/sh\nexit 1\n`);
	for (const f of ['pgrep', 'lsof', 'fuser']) chmodSync(join(dir, f), 0o755);
	return dir;
}

/** THE central spawn point. Throws if any required var escapes fixtureRoot. */
function run(fixtureRoot, env, { stubBin } = {}) {
	for (const k of REQUIRED_VARS) {
		if (!(k in env) || !env[k]) throw new Error(`run(): ${k} must be set`);
		const v = resolve(env[k]);
		if (v !== fixtureRoot && !v.startsWith(fixtureRoot + sep)) {
			throw new Error(`run(): ${k}=${env[k]} escapes fixture root ${fixtureRoot}`);
		}
	}
	const bin = stubBin ?? mkStubBin();
	const full = { ...env, PATH: `${bin}:${process.env.PATH}` };
	return spawnSync('bash', [SH], { encoding: 'utf8', env: full });
}

test('run() refuses a var that escapes the fixture root', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot, { TMPDIR_DISK: '/etc' });
	assert.throws(() => run(fixtureRoot, env), /escapes fixture root/);
});

test('script source carries no /tmp literal outside comments, not even as a default', () => {
	const src = readFileSync(SH, 'utf8').split('\n');
	const offenders = [];
	for (let i = 0; i < src.length; i++) {
		const line = src[i];
		if (line.trim().startsWith('#')) continue; // comment line is not code
		if (!line.includes('/tmp')) continue;
		offenders.push(`${i + 1}: ${line}`);
	}
	assert.deepEqual(offenders, [], 'the caller names the tmpfs; the script must not');
});

test('without TMPFS_ROOT the tmpfs is not swept at all, and the script says so', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	const stray = join(env.TMPFS_ROOT, 'liblz4-java-123456.so');
	mkdirSync(env.TMPFS_ROOT, { recursive: true });
	writeFileSync(stray, 'x');
	age(stray, 3 * 1440);
	// The one spawn outside run(), because run() requires TMPFS_ROOT. Every
	// other path var still points inside the fixture.
	const withoutRoot = { ...env };
	delete withoutRoot.TMPFS_ROOT;
	const bin = mkStubBin();
	const r = spawnSync('bash', [SH], {
		encoding: 'utf8',
		env: { ...withoutRoot, PATH: `${bin}:${process.env.PATH}` },
	});
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /^SKIP-TMPFS /m);
	assert.equal(
		existsSync(stray),
		true,
		'nothing under any tmpfs is touched without an explicit root'
	);
});

test('stale pytest basetemp goes, fresh one stays, in both TMPFS_ROOT and TMPDIR_DISK', () => {
	for (const rootKey of ['TMPFS_ROOT', 'TMPDIR_DISK']) {
		const fixtureRoot = mkfixture();
		const env = baseEnv(fixtureRoot);
		const root = env[rootKey];
		const base = join(root, 'pytest-of-x');
		mkdirSync(join(base, 'pytest-old'), { recursive: true });
		mkdirSync(join(base, 'pytest-new'), { recursive: true });
		age(join(base, 'pytest-old'), 120); // 2h, past default 60min
		const r = run(fixtureRoot, env);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(
			existsSync(join(base, 'pytest-old')),
			false,
			`${rootKey}: stale basetemp must be removed`
		);
		assert.equal(
			existsSync(join(base, 'pytest-new')),
			true,
			`${rootKey}: fresh basetemp must survive`
		);
	}
});

test('pytest-current is removed when no worker is live, kept when one is', () => {
	for (const workerLive of [false, true]) {
		const fixtureRoot = mkfixture();
		const env = baseEnv(fixtureRoot);
		const base = join(env.TMPDIR_DISK, 'pytest-of-x');
		const target = join(base, 'pytest-7');
		mkdirSync(target, { recursive: true });
		age(target, 120);
		symlinkSync(target, join(base, 'pytest-current'));
		const stub = mkStubBin(workerLive ? { workerPid: 1 } : {});
		const r = run(fixtureRoot, env, { stubBin: stub });
		assert.equal(r.status, 0, r.stderr);
		if (workerLive) {
			assert.equal(existsSync(target), true, 'live worker: pytest-current target must survive');
		} else {
			assert.equal(existsSync(target), false, 'idle: pytest-current target must be removed');
		}
	}
});

test('a symlink pointing outside the pytest base root is never followed or deleted', () => {
	// The outside target (and everything in it) is aged 3h old and no worker
	// stub is passed (idle, default stub) — otherwise `in_use`'s freshness
	// check protects the canary for a reason that has nothing to do with the
	// root-escape guard, and masks the guard's removal (confirmed by mutation:
	// an UNAGED canary here still survived with both escape guards deleted
	// from the script).
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	const base = join(env.TMPDIR_DISK, 'pytest-of-x');
	mkdirSync(base, { recursive: true });
	const outsideTarget = join(fixtureRoot, 'outside');
	mkdirSync(outsideTarget, { recursive: true });
	writeFileSync(join(outsideTarget, 'canary.txt'), 'do not delete me');
	ageAll(outsideTarget, 180);
	symlinkSync(outsideTarget, join(base, 'pytest-current'));
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(outsideTarget), true, 'escaped symlink target dir must survive');
	assert.equal(
		existsSync(join(outsideTarget, 'canary.txt')),
		true,
		'escaped symlink target must survive untouched'
	);
});

test('a non-current pytest-* entry that symlinks outside the root is never followed into deletion', () => {
	// Sibling of the case above: this time the escaping symlink is a
	// NON-current pytest-N entry rather than pytest-current itself, which
	// exercises the OTHER escape guard in the script (the one on `$rd` inside
	// the per-entry loop, not the one on `$keep`).
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	const base = join(env.TMPDIR_DISK, 'pytest-of-x');
	mkdirSync(base, { recursive: true });
	const outsideTarget = join(fixtureRoot, 'outside-sibling');
	mkdirSync(outsideTarget, { recursive: true });
	writeFileSync(join(outsideTarget, 'canary.txt'), 'do not delete me');
	ageAll(outsideTarget, 180);
	symlinkSync(outsideTarget, join(base, 'pytest-7'));
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(outsideTarget), true, 'escaped symlink target dir must survive');
	assert.equal(
		existsSync(join(outsideTarget, 'canary.txt')),
		true,
		'escaped symlink target must survive untouched'
	);
});

test('in_use looks DEEP: a transform-cache dir that looks old at the top but was written into recently survives', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	const d = join(env.TMPFS_ROOT, 'playwright-transform-cache-abc123');
	mkdirSync(join(d, 'nested', 'deep'), { recursive: true });
	const freshFile = join(d, 'nested', 'deep', 'entry.cache');
	writeFileSync(freshFile, 'x');
	ageAll(d, 120); // everything, including the fresh file, pushed 2h old...
	age(freshFile, 5); // ...then the deep file is touched again 5 min ago: still in use.
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(d), true, 'a dir with a recently-written file deep inside must survive');
});

test('a transform-cache dir with nothing fresh anywhere inside is removed', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	const d = join(env.TMPFS_ROOT, 'playwright-transform-cache-def456');
	mkdirSync(join(d, 'nested'), { recursive: true });
	writeFileSync(join(d, 'nested', 'entry.cache'), 'x');
	ageAll(d, 120);
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(d), false, 'a fully-stale transform-cache dir must be removed');
});

test('a JIT slot beyond maxConcurrent goes, an in-range one stays', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot, { MAX_CONCURRENT_NODE: '3' });
	mkdirSync(join(env.JIT_ROOT, 'slot0'), { recursive: true });
	mkdirSync(join(env.JIT_ROOT, 'slot9'), { recursive: true });
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(
		existsSync(join(env.JIT_ROOT, 'slot9')),
		false,
		'slot9 >= maxConcurrent(3) must be removed'
	);
	assert.equal(
		existsSync(join(env.JIT_ROOT, 'slot0')),
		true,
		'slot0 < maxConcurrent(3) must survive'
	);
});

test('an unknown maxConcurrent refuses to prune any JIT slot — could-not-look is never nothing-to-keep', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot); // MAX_CONCURRENT_NODE unset
	mkdirSync(join(env.JIT_ROOT, 'slot9'), { recursive: true });
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(
		existsSync(join(env.JIT_ROOT, 'slot9')),
		true,
		'slot9 must survive when the ceiling is unknown'
	);
});

test('a slot carrying a live Runner.Listener is never removed, however high its index', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot, { MAX_CONCURRENT_NODE: '3' });
	const slot = join(env.JIT_ROOT, 'slot9');
	mkdirSync(join(slot, 'bin'), { recursive: true });
	// A real executable named exactly Runner.Listener, exec'd directly (not
	// via a parent hop) so its OWN /proc/<pid>/cmdline carries the
	// */bin/Runner.Listener token the script matches on — a true positive,
	// not a stand-in.
	const listenerPath = join(slot, 'bin', 'Runner.Listener');
	writeFileSync(listenerPath, '#!/bin/sh\nsleep 10\n');
	chmodSync(listenerPath, 0o755);
	const proc = spawn(listenerPath, [], { stdio: 'ignore' });
	try {
		const stub = mkStubBin({ listenerPid: proc.pid });
		const r = run(fixtureRoot, env, { stubBin: stub });
		assert.equal(r.status, 0, r.stderr);
		assert.equal(existsSync(slot), true, 'a slot with a live Runner.Listener must survive');
		assert.match(r.stdout, /SKIP-BUSY jit\/slot9/);
	} finally {
		proc.kill();
	}
});

test('_work staleness is depth<=3, not the top dir mtime; _actions is never a candidate', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot, { MAX_CONCURRENT_NODE: '3' });
	const work = join(env.JIT_ROOT, 'slot0', '_work');

	// Warm checkout: top dir looks old (created long ago) but the nested
	// .git was touched recently — must survive.
	const warm = join(work, 'hadoku_site');
	const warmGit = join(warm, 'hadoku_site', '.git');
	mkdirSync(warmGit, { recursive: true });
	ageAll(warm, 10 * 1440);
	age(warmGit, 60); // 1h — fresh relative to WORK_STALE_DAYS=7

	// Fully dormant checkout: nothing anywhere inside touched in 7 days.
	const stale = join(work, 'brave-quartet');
	const staleGit = join(stale, 'brave-quartet', '.git');
	mkdirSync(staleGit, { recursive: true });
	ageAll(stale, 10 * 1440);

	// GitHub's own non-repo scratch dir: old, but must never be a candidate.
	const actions = join(work, '_actions');
	mkdirSync(actions, { recursive: true });
	ageAll(actions, 10 * 1440);

	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(warm), true, 'a warm checkout (fresh .git, old top dir) must survive');
	assert.equal(existsSync(stale), false, 'a fully-dormant checkout must be removed');
	assert.equal(existsSync(actions), true, '_actions must never be swept regardless of age');
});

test('TMPDIR_DISK resolving to $HOME is refused, not swept', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	env.TMPDIR_DISK = env.HOME; // malformed runner.env would produce exactly this
	const canary = join(env.HOME, 'game-bundle-x');
	mkdirSync(canary, { recursive: true });
	age(canary, 120);
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.match(
		r.stdout,
		new RegExp(`SKIP-UNSAFE ${env.HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
	);
	assert.equal(existsSync(canary), true, '$HOME must never be swept as a disk tmp root');
});

test('NODE_COMPILE_CACHE_DISK with the wrong basename is refused, not removed whole', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	env.NODE_COMPILE_CACHE_DISK = join(env.TMPDIR_DISK, 'not-the-right-name'); // malformed runner.env
	mkdirSync(env.NODE_COMPILE_CACHE_DISK, { recursive: true });
	writeFileSync(join(env.NODE_COMPILE_CACHE_DISK, 'blob'), 'x');
	const r = run(fixtureRoot, env); // no worker stub needed: APPLY=1, idle
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /SKIP-UNSAFE/);
	assert.equal(
		existsSync(env.NODE_COMPILE_CACHE_DISK),
		true,
		'a cache dir with the wrong basename must survive'
	);
});

test('dry run (APPLY unset) reports without deleting anything', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot, { APPLY: undefined });
	delete env.APPLY;
	const target = join(env.TMPDIR_DISK, 'pytest-of-x', 'pytest-old');
	mkdirSync(target, { recursive: true });
	age(target, 120);
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(target), true, 'a dry run must never delete');
	assert.match(r.stdout, /WOULD-REMOVE|SUMMARY/);
});

test('HADOKU_SITE_ROOT=/nonexistent REPOS_DIR=/nonexistent does not break the sweep', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot, { HADOKU_SITE_ROOT: '/nonexistent', REPOS_DIR: '/nonexistent' });
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /SUMMARY/);
});

test('tripwire: a full APPLY=1 sweep never touches a second, unpassed fixture root', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	mkdirSync(join(env.TMPFS_ROOT, 'pytest-of-x', 'pytest-old'), { recursive: true });
	age(join(env.TMPFS_ROOT, 'pytest-of-x', 'pytest-old'), 120);

	const untouchedRoot = mkfixture(); // a SECOND fixture, never named to the script
	const canaryBase = join(untouchedRoot, 'tmp', 'pytest-of-x');
	mkdirSync(join(canaryBase, 'pytest-old'), { recursive: true });
	age(join(canaryBase, 'pytest-old'), 120);
	writeFileSync(join(canaryBase, 'pytest-old', 'canary.txt'), 'must not be touched');

	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(
		existsSync(join(env.TMPFS_ROOT, 'pytest-of-x', 'pytest-old')),
		false,
		'the passed fixture IS swept'
	);
	assert.equal(
		existsSync(join(canaryBase, 'pytest-old', 'canary.txt')),
		true,
		'a root never passed to the script must survive untouched'
	);
});

test('a compile cache survives while a worker is live, is reclaimed only when idle', () => {
	for (const workerLive of [false, true]) {
		const fixtureRoot = mkfixture();
		const env = baseEnv(fixtureRoot);
		const tmpfsCache = join(env.TMPFS_ROOT, 'node-compile-cache');
		const diskCache = env.NODE_COMPILE_CACHE_DISK;
		mkdirSync(tmpfsCache, { recursive: true });
		mkdirSync(diskCache, { recursive: true });
		writeFileSync(join(tmpfsCache, 'x'), 'x');
		writeFileSync(join(diskCache, 'x'), 'x');
		ageAll(env.TMPFS_ROOT, 180);
		ageAll(env.TMPDIR_DISK, 180);
		const stub = mkStubBin(workerLive ? { workerPid: 1 } : {});
		const r = run(fixtureRoot, env, { stubBin: stub });
		assert.equal(r.status, 0, r.stderr);
		if (workerLive) {
			assert.equal(existsSync(tmpfsCache), true, 'live worker: TMPFS_ROOT cache must survive');
			assert.equal(
				existsSync(diskCache),
				true,
				'live worker: NODE_COMPILE_CACHE_DISK must survive'
			);
		} else {
			assert.equal(existsSync(tmpfsCache), false, 'idle: TMPFS_ROOT cache must be reclaimed');
			assert.equal(existsSync(diskCache), false, 'idle: NODE_COMPILE_CACHE_DISK must be reclaimed');
		}
	}
});

// ── #102 wave 4c lane E: the cleaner never touches a SEED's cache ───────────
//
// `scripts/lib/capability-seeds.mjs` seeds a capability's artifact under a
// manifest-declared `~`-relative cache (`~/.cache/cardtable-forge` for
// `jdk21`, today's one fixture entry). This script already has no sweep rule
// that names that path — it is not `node-compile-cache`, not an
// `actions-runner*` install, not a JIT slot, and not one of `sweep_glob`'s
// named patterns (`pytest-of-*`, `game-bundle-*`, `vault-resp.*`,
// `cardtable-e2e-web-*`, `playwright-transform-cache-*`). This test plants
// one anyway, aged well past every staleness window the script knows, and
// proves the omission holds — a seed cache survives a full `APPLY=1` sweep
// untouched, declared or not. `CACHE_PATHS` is the SAME mechanism the real
// manifest's `toolCaches` reporting uses: a declared cache is only ever
// REPORTED (`CACHE-PRESENT`), never reclaimed.
test("the cleaner never touches a seed capability's cache, declared or not", () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot, { CACHE_PATHS: '~/.cache/cardtable-forge' });
	const seedCache = join(env.HOME, '.cache', 'cardtable-forge');
	const pinDir = join(seedCache, 'deadbeef00112233445566778899aabbccddeeff');
	mkdirSync(join(pinDir, 'res', 'cardsfolder'), { recursive: true });
	writeFileSync(join(pinDir, 'forge.jar'), 'not a real jar');
	writeFileSync(join(pinDir, '.forge-bundle-marker'), 'built by scripts/forge-bundle.sh\n');
	// Aged past EVERY window this script knows (WORK_STALE_DAYS=7,
	// DIAG_KEEP_DAYS=14, TMP_KEEP_MIN=60) — survival here is not "it looked
	// fresh", it is "nothing sweeps this path at all".
	ageAll(seedCache, 30 * 1440);

	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(join(pinDir, 'forge.jar')), true, 'a seed cache must never be reclaimed');
	assert.equal(existsSync(join(pinDir, 'res', 'cardsfolder')), true);
	// Declaring it for reporting (the real manifest's `toolCaches` mechanism)
	// must still only REPORT it, never reclaim it.
	assert.match(r.stdout, /CACHE-PRESENT ~\/\.cache\/cardtable-forge \d+/);
});

// ── 2026-10-10 (#100/#101): liblz4 extracts, and the backstop for unnamed debris ──

test('stale liblz4-java extracts (plain files) go in one pass; a fresh one stays', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	mkdirSync(env.TMPFS_ROOT, { recursive: true });
	const stale = [];
	for (let i = 0; i < 50; i++) {
		const f = join(env.TMPFS_ROOT, `liblz4-java-${1000000 + i}.so`);
		writeFileSync(f, 'x');
		age(f, 120);
		stale.push(f);
	}
	const lck = join(env.TMPFS_ROOT, 'liblz4-java-1000000.so.lck');
	writeFileSync(lck, '');
	age(lck, 120);
	const fresh = join(env.TMPFS_ROOT, 'liblz4-java-2000000.so');
	writeFileSync(fresh, 'x');
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(stale.filter((f) => existsSync(f)).length, 0, 'every stale extract must be removed');
	assert.equal(existsSync(lck), false, 'its .lck goes with it');
	assert.equal(
		existsSync(fresh),
		true,
		'an extract younger than TMP_KEEP_MIN may still be mapped by a live JVM'
	);
});

test('backstop: an unnamed entry untouched for a day is removed and reported by class', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	mkdirSync(env.TMPFS_ROOT, { recursive: true });
	const oldDirs = ['deferral-aB3xYz', 'deferral-Qw9rTy'].map((n) => join(env.TMPFS_ROOT, n));
	for (const d of oldDirs) {
		mkdirSync(join(d, 'inner'), { recursive: true });
		writeFileSync(join(d, 'inner', 'f'), 'x');
		ageAll(d, 2 * 1440);
	}
	const oldFile = join(env.TMPFS_ROOT, 'tmpxuwe_icb.db');
	writeFileSync(oldFile, 'x');
	age(oldFile, 2 * 1440);
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	for (const d of oldDirs) assert.equal(existsSync(d), false, `${d} must be removed`);
	assert.equal(existsSync(oldFile), false);
	assert.match(r.stdout, /^UNCLASSIFIED root=\S+ class=deferral-\* n=2 kb=\d+$/m);
	assert.match(r.stdout, /^UNCLASSIFIED root=\S+ class=tmp\*\.db n=1 kb=\d+$/m);
	assert.match(r.stdout, /unclassified_kb=\d+/);
});

test('backstop: anything written inside the last day survives, however old its top level looks', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	const d = join(env.TMPFS_ROOT, 'some-tool-run-xyz');
	mkdirSync(join(d, 'deep', 'er'), { recursive: true });
	const f = join(d, 'deep', 'er', 'live.log');
	writeFileSync(f, 'x');
	ageAll(d, 3 * 1440);
	age(f, 30);
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(d), true);
});

test('backstop: the keep list, sockets and symlinks are never touched', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	mkdirSync(env.TMPFS_ROOT, { recursive: true });
	const kept = ['ssh-XXXXabcdef', 'tmux-1000', '.X11-unix', 'systemd-private-abc-def'].map((n) =>
		join(env.TMPFS_ROOT, n)
	);
	for (const d of kept) {
		mkdirSync(d);
		age(d, 5 * 1440);
	}
	const outside = join(fixtureRoot, 'outside-target');
	mkdirSync(outside);
	writeFileSync(join(outside, 'precious'), 'x');
	const link = join(env.TMPFS_ROOT, 'dangling-tool-link');
	symlinkSync(outside, link);
	const sock = join(env.TMPFS_ROOT, 'agent.sock');
	const mk = spawnSync('python3', [
		'-c',
		`import socket; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(sock)})`,
	]);
	assert.equal(mk.status, 0, String(mk.stderr));
	age(sock, 5 * 1440);
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	for (const d of kept) assert.equal(existsSync(d), true, `${d} is on the keep list`);
	assert.equal(existsSync(join(outside, 'precious')), true, 'a symlink is never followed');
	assert.equal(
		existsSync(link),
		true,
		'nor removed: only regular files and real dirs are candidates'
	);
	assert.equal(existsSync(sock), true, 'a socket belongs to a live session');
});

test('backstop: a dry run reports the unnamed debris and deletes none of it', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot, { APPLY: '0' });
	const d = join(env.TMPFS_ROOT, 'wp-fetch-sub-abc123');
	mkdirSync(d, { recursive: true });
	ageAll(d, 2 * 1440);
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(d), true);
	assert.match(r.stdout, /^UNCLASSIFIED .*class=wp-fetch-sub-\* n=1/m);
});

test('an entry something holds open survives, however old: one lsof per root, not one per entry', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	mkdirSync(env.TMPFS_ROOT, { recursive: true });
	const heldDir = join(env.TMPFS_ROOT, 'long-tool-run-abc123');
	const idleDir = join(env.TMPFS_ROOT, 'long-tool-run-def456');
	for (const d of [heldDir, idleDir]) {
		mkdirSync(join(d, 'x'), { recursive: true });
		writeFileSync(join(d, 'x', 'f'), 'x');
		ageAll(d, 3 * 1440);
	}
	const heldSo = join(env.TMPFS_ROOT, 'liblz4-java-111111.so');
	const idleSo = join(env.TMPFS_ROOT, 'liblz4-java-222222.so');
	for (const f of [heldSo, idleSo]) {
		writeFileSync(f, 'x');
		age(f, 120);
	}
	const stubBin = mkStubBin({ lsofOpen: [join(heldDir, 'x', 'f'), heldSo] });
	const r = run(fixtureRoot, env, { stubBin });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(heldDir), true, 'a file open deep inside keeps the whole entry');
	assert.equal(existsSync(heldSo), true, 'a mapped extract stays');
	assert.equal(existsSync(idleDir), false);
	assert.equal(existsSync(idleSo), false);
});

test('a dry run counts named debris once, under its own rule, never again as unclassified', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot, { APPLY: '0' });
	mkdirSync(env.TMPFS_ROOT, { recursive: true });
	const f = join(env.TMPFS_ROOT, 'liblz4-java-333333.so');
	writeFileSync(f, 'x'.repeat(8192));
	age(f, 3 * 1440);
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.doesNotMatch(r.stdout, /^UNCLASSIFIED .*liblz/m);
	assert.match(r.stdout, /unclassified_kb=0 /);
	assert.match(r.stdout, /tmpfs_kb=[1-9]/);
});

// --- A venv whose interpreter is gone (#127) ---
//
// hadoku-registry's drift-check on hokon, 2026-10-17: `.venv/bin/pip: cannot
// execute: required file not found`. The venv in a reused `_work` checkout
// pointed at a Python that a tool-cache refresh had replaced.

/** A venv at `dir`: pyvenv.cfg plus bin/python as a symlink to `target`. */
function mkVenv(dir, target) {
	mkdirSync(join(dir, 'bin'), { recursive: true });
	writeFileSync(join(dir, 'pyvenv.cfg'), `home = ${dirname(target)}\n`);
	symlinkSync(target, join(dir, 'bin', 'python'));
}

test('venv: a broken one in an idle JIT slot goes; a healthy one, a --copies one and the checkout stay', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot, { MAX_CONCURRENT_NODE: '3' });
	const checkout = join(env.JIT_ROOT, 'slot0', '_work', 'hadoku-registry', 'hadoku-registry');
	const broken = join(checkout, '.venv');
	mkVenv(broken, join(fixtureRoot, 'gone', 'python3.11'));
	const healthy = join(env.JIT_ROOT, 'slot1', '_work', 'tenhands', 'tenhands', '.venv-ci');
	mkVenv(healthy, process.execPath);
	const copies = join(env.JIT_ROOT, 'slot2', '_work', 'study', 'study', '.venv');
	mkdirSync(join(copies, 'bin'), { recursive: true });
	writeFileSync(join(copies, 'pyvenv.cfg'), 'home = /nowhere\n');
	writeFileSync(join(copies, 'bin', 'python'), '');

	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(broken), false, 'a venv whose interpreter is gone must be removed');
	assert.equal(existsSync(checkout), true, 'only the venv goes, never the checkout around it');
	assert.equal(existsSync(healthy), true, 'a venv whose interpreter resolves must survive');
	assert.equal(existsSync(copies), true, 'a --copies venv has no link to dangle and must survive');
	assert.match(r.stdout, /BROKEN-VENV .*hadoku-registry\/\.venv -> .*gone\/python3\.11/);
	assert.match(r.stdout, /venv_kb=\d+/);
});

test('venv: a broken one under a standing runner goes too, and a busy runner is never touched', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot);
	const runner = join(env.HOME, 'runners', 'actions-runner-hadoku-registry');
	for (const v of ['bin.2.330.0', 'externals.2.330.0'])
		mkdirSync(join(runner, v), { recursive: true });
	symlinkSync(join(runner, 'bin.2.330.0'), join(runner, 'bin'));
	symlinkSync(join(runner, 'externals.2.330.0'), join(runner, 'externals'));
	writeFileSync(join(runner, '.runner'), '{}');
	const venv = join(runner, '_work', 'hadoku-registry', 'hadoku-registry', '.venv');
	mkVenv(venv, join(fixtureRoot, 'gone', 'python3.12'));

	// Busy first: a worker whose PARENT's argv names this runner's
	// bin/Runner.Listener, which is how the script attributes a live job.
	const listenerPath = join(runner, 'bin', 'Runner.Listener');
	const childPidFile = join(fixtureRoot, 'worker.pid');
	// Written then renamed: `echo > file` creates it empty first, and a poll that
	// lands in that gap under load reads no pid and runs the pass with no worker.
	writeFileSync(
		listenerPath,
		`#!/bin/sh\nsleep 10 &\necho $! > ${childPidFile}.tmp\nmv ${childPidFile}.tmp ${childPidFile}\nwait\n`
	);
	chmodSync(listenerPath, 0o755);
	const listener = spawn(listenerPath, [], { stdio: 'ignore' });
	try {
		const deadline = Date.now() + 5000;
		while (!existsSync(childPidFile) && Date.now() < deadline) spawnSync('sleep', ['0.05']);
		const workerPid = readFileSync(childPidFile, 'utf8').trim();
		const busy = run(fixtureRoot, env, { stubBin: mkStubBin({ workerPid }) });
		assert.equal(busy.status, 0, busy.stderr);
		assert.match(busy.stdout, /SKIP-BUSY runners\/actions-runner-hadoku-registry/);
		assert.equal(existsSync(venv), true, 'a runner mid-job keeps even a broken venv');
	} finally {
		listener.kill();
		try {
			process.kill(Number(readFileSync(childPidFile, 'utf8')));
		} catch {
			// already gone
		}
	}

	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(venv), false, 'an idle standing runner loses its broken venv');
	assert.match(r.stdout, /BROKEN-VENV runners\/actions-runner-hadoku-registry\/_work/);
});

test('venv: a dry run names the broken venv and deletes nothing', () => {
	const fixtureRoot = mkfixture();
	const env = baseEnv(fixtureRoot, { MAX_CONCURRENT_NODE: '3' });
	delete env.APPLY;
	const venv = join(env.JIT_ROOT, 'slot0', '_work', 'r', 'r', '.venv');
	mkVenv(venv, join(fixtureRoot, 'gone', 'python3.11'));
	const r = run(fixtureRoot, env);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(venv), true, 'a dry run must never delete');
	assert.match(r.stdout, /WOULD-REMOVE .*r\/r\/\.venv/);
});
