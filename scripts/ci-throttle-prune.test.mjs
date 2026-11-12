/**
 * ci-throttle's wave 4b job-start /tmp prune: `maybe_prune_tmp()` exercised
 * through the real admission path, never a copy of its arithmetic — stale
 * game-bundle/vault-resp/cardtable/playwright candidates removed above the
 * free-MB threshold, `pytest-current` and symlink targets outside the root
 * protected, and the whole sweep bounded so a stuck `find`/`rm` cannot hang
 * a job. Split out of ci-throttle.test.mjs (wave 5p lane C) — see
 * `lib/ci-throttle-fixtures.mjs` for the shared `nodeFixture()`/`runHook()`/
 * `run()` this file drives the real `ci-throttle.sh` through.
 *
 * `CI_THROTTLE_PRUNE_ROOT` points every spawn at a fixture directory (see
 * nodeFixture/requirePruneRoot in the fixtures module), so these cases never
 * touch the real host's /tmp. A stub `df` on PATH (`stubDf`, below — prune's
 * alone, unlike the shared helpers) drives the threshold arithmetic
 * deterministically.
 */
import { after, test } from 'node:test';
import { TMP_FREE_FLOOR_MB } from '../dist/lib/jit-naming.js';
import assert from 'node:assert/strict';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import {
	FIXTURE_PREFIX,
	HOOK,
	SCRIPTS,
	installCiThrottleRig,
	installLeakGate,
	nodeFixture,
	run,
	runHook,
} from './lib/ci-throttle-fixtures.mjs';

installCiThrottleRig();

/**
 * A fake `df` on its own PATH entry, reporting a fixed total/used/avail (MB)
 * for any path it is asked about — the only way to drive `maybe_prune_tmp`'s
 * threshold arithmetic without a real tmpfs at a known fill level. Returns
 * the directory to prepend to PATH. Used only here, unlike the shared
 * `defaultDfDir()` in the fixtures module.
 */
function stubDf(scratchDir, { totalMb, usedMb, availMb, fail = false, headerOnly = false }) {
	const bin = mkdtempSync(join(scratchDir, 'df-stub-'));
	const script = fail
		? '#!/bin/sh\necho "df: cannot read" >&2\nexit 1\n'
		: headerOnly
			? '#!/bin/sh\necho "Filesystem 1M-blocks Used Available Use% Mounted"\n'
			: `#!/bin/sh\necho "Filesystem 1M-blocks Used Available Use% Mounted"\necho "fixture ${totalMb} ${usedMb} ${availMb} 0% x"\n`;
	writeFileSync(join(bin, 'df'), script, { mode: 0o755 });
	return bin;
}

// --- wave 4b #100/#101: the job-start /tmp prune ---------------------------
//
// Exercises maybe_prune_tmp() through the real admission path (not a copy of
// its arithmetic). CI_THROTTLE_PRUNE_ROOT points every spawn at a fixture
// directory (see nodeFixture/requirePruneRoot above), so these cases never
// touch the real host's /tmp. A stub `df` on PATH (stubDf) drives the
// threshold arithmetic deterministically.
const PRUNE_SCRATCH = mkdtempSync(join(tmpdir(), `${FIXTURE_PREFIX}prune-scratch-`));
after(() => rmSync(PRUNE_SCRATCH, { recursive: true, force: true }));

/** Make every file inside `dir` (recursively, dir included) look `minutesAgo` old. */
function ageAll(dir, minutesAgo) {
	const t = new Date(Date.now() - minutesAgo * 60_000);
	const walk = (p) => {
		utimesSync(p, t, t);
		for (const entry of readdirSync(p, { withFileTypes: true })) {
			const full = join(p, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) walk(full);
			else utimesSync(full, t, t);
		}
	};
	walk(dir);
}

function withPruneDf(fx, dfOpts) {
	const bin = stubDf(PRUNE_SCRATCH, dfOpts);
	fx.env.PATH = `${bin}:${fx.env.PATH || process.env.PATH}`;
}

test('below both thresholds: nothing removed, log says why', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242'; // a real job, so the df-threshold path is reached
	withPruneDf(fx, { totalMb: 8000, usedMb: 1000, availMb: 7000 }); // 12.5%, 7000MB free
	mkdirSync(join(fx.pruneRoot, 'game-bundle-old'), { recursive: true });
	ageAll(join(fx.pruneRoot, 'game-bundle-old'), 120);
	const r = runHook(fx);
	assert.equal(r.code, 0);
	assert.equal(
		existsSync(join(fx.pruneRoot, 'game-bundle-old')),
		true,
		'below threshold: nothing touched'
	);
	const log = readFileSync(join(fx.home, '.hadoku', 'throttle', 'prune.log'), 'utf8');
	assert.match(log, /below both, nothing to do/);
});

test('above the free-MB threshold: stale candidates of every pattern removed; fresh, exempt and unlisted survive', () => {
	// This is also wave 4b's "above-threshold fixture WITH GITHUB_RUN_ID set →
	// candidates removed" case: a real job id is required below for the prune
	// to run at all now that it is gated on one.
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 }); // under 3072MB free
	const root = fx.pruneRoot;
	for (const name of [
		'game-bundle-x',
		'vault-resp.1',
		'cardtable-e2e-web-y',
		'playwright-transform-cache-z',
	]) {
		mkdirSync(join(root, name, 'inner'), { recursive: true });
		writeFileSync(join(root, name, 'inner', 'f'), 'x');
		ageAll(join(root, name), 120);
	}
	// A candidate with ONE fresh file deep inside must be kept.
	mkdirSync(join(root, 'game-bundle-fresh-inside', 'deep'), { recursive: true });
	writeFileSync(join(root, 'game-bundle-fresh-inside', 'deep', 'f'), 'x');
	ageAll(join(root, 'game-bundle-fresh-inside'), 120);
	writeFileSync(join(root, 'game-bundle-fresh-inside', 'deep', 'newer'), 'x'); // now, fresh
	// node-compile-cache and an unlisted old dir must never be touched.
	mkdirSync(join(root, 'node-compile-cache'), { recursive: true });
	ageAll(join(root, 'node-compile-cache'), 120);
	mkdirSync(join(root, 'totally-unlisted-old'), { recursive: true });
	ageAll(join(root, 'totally-unlisted-old'), 120);
	// pytest-of-*/pytest-<N>: old N removed, pytest-current's target kept
	// however old, even though it is itself old.
	mkdirSync(join(root, 'pytest-of-ci', 'pytest-1'), { recursive: true });
	mkdirSync(join(root, 'pytest-of-ci', 'pytest-2'), { recursive: true });
	ageAll(join(root, 'pytest-of-ci'), 120);
	symlinkSync(join(root, 'pytest-of-ci', 'pytest-2'), join(root, 'pytest-of-ci', 'pytest-current'));
	// A symlink candidate pointing OUTSIDE the root: its target must survive.
	const outsideTarget = mkdtempSync(join(PRUNE_SCRATCH, 'outside-target-'));
	writeFileSync(join(outsideTarget, 'keepme'), 'x');
	ageAll(outsideTarget, 120);
	symlinkSync(outsideTarget, join(root, 'vault-resp.outside'));

	const r = runHook(fx);
	assert.equal(r.code, 0);
	assert.equal(existsSync(join(root, 'game-bundle-x')), false, 'stale game-bundle removed');
	assert.equal(existsSync(join(root, 'vault-resp.1')), false, 'stale vault-resp removed');
	assert.equal(existsSync(join(root, 'cardtable-e2e-web-y')), false, 'stale cardtable removed');
	assert.equal(
		existsSync(join(root, 'playwright-transform-cache-z')),
		false,
		'stale playwright cache removed'
	);
	assert.equal(
		existsSync(join(root, 'game-bundle-fresh-inside')),
		true,
		'one fresh file deep inside keeps the whole candidate'
	);
	assert.equal(
		existsSync(join(root, 'node-compile-cache')),
		true,
		'node-compile-cache is never a candidate'
	);
	assert.equal(
		existsSync(join(root, 'totally-unlisted-old')),
		true,
		'unlisted dirs are never touched'
	);
	assert.equal(existsSync(join(root, 'pytest-of-ci', 'pytest-1')), false, 'old pytest-N removed');
	assert.equal(
		existsSync(join(root, 'pytest-of-ci', 'pytest-2')),
		true,
		"pytest-current's target kept however old"
	);
	assert.equal(
		existsSync(join(outsideTarget, 'keepme')),
		true,
		'symlink pointing outside root: target survives'
	);
});

test('above threshold but NO GITHUB_RUN_ID: this is not a real job, nothing removed, reason logged', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 }); // well under the free-MB floor
	const root = fx.pruneRoot;
	for (const name of [
		'game-bundle-x',
		'vault-resp.1',
		'cardtable-e2e-web-y',
		'playwright-transform-cache-z',
	]) {
		mkdirSync(join(root, name), { recursive: true });
		ageAll(join(root, name), 120);
	}
	const r = runHook(fx);
	assert.equal(r.code, 0, 'a non-job invocation must never fail');
	for (const name of [
		'game-bundle-x',
		'vault-resp.1',
		'cardtable-e2e-web-y',
		'playwright-transform-cache-z',
	]) {
		assert.equal(existsSync(join(root, name)), true, `${name} must survive without GITHUB_RUN_ID`);
	}
	const log = readFileSync(join(fx.home, '.hadoku', 'throttle', 'prune.log'), 'utf8');
	assert.match(log, /skipped: no GITHUB_RUN_ID/);
});

test('GITHUB_RUN_ID set to the empty string is treated as absent: nothing removed', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
	mkdirSync(join(fx.pruneRoot, 'game-bundle-old'), { recursive: true });
	ageAll(join(fx.pruneRoot, 'game-bundle-old'), 120);
	const r = runHook(fx);
	assert.equal(r.code, 0);
	assert.equal(
		existsSync(join(fx.pruneRoot, 'game-bundle-old')),
		true,
		'empty GITHUB_RUN_ID must not count as present'
	);
	const log = readFileSync(join(fx.home, '.hadoku', 'throttle', 'prune.log'), 'utf8');
	assert.match(log, /skipped: no GITHUB_RUN_ID/);
});

test('a pytest-of-* directly under root that is ITSELF a symlink out: the inner glob must not escape through it', () => {
	// The gap the direct-symlink case above does not cover: `pytest-of-evil`
	// sits right under the prune root but IS a symlink to a directory outside
	// it. The outer `for base in "$root_real"/pytest-of-*` picks it up, and the
	// inner `for d in "$base"/pytest-*` walks THROUGH the link into the
	// outside tree — the `case "$real" in "$root_real"/*)` guard on `$d` is the
	// only thing standing between that walk and `rm -rf` on a real directory
	// this fixture does not own.
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
	const root = fx.pruneRoot;
	const outsideBase = mkdtempSync(join(PRUNE_SCRATCH, 'outside-pytest-'));
	mkdirSync(join(outsideBase, 'pytest-3', 'deep'), { recursive: true });
	writeFileSync(join(outsideBase, 'pytest-3', 'deep', 'f'), 'x');
	ageAll(outsideBase, 180);
	symlinkSync(outsideBase, join(root, 'pytest-of-evil'));

	const r = runHook(fx);
	assert.equal(r.code, 0);
	assert.equal(
		existsSync(join(outsideBase, 'pytest-3')),
		true,
		'the real outside pytest-3 directory must survive'
	);
	assert.equal(
		existsSync(join(outsideBase, 'pytest-3', 'deep', 'f')),
		true,
		'the file inside the real outside pytest-3 must survive'
	);
});

test('the PRUNE_BOUND_S deadline, not the per-call timeout, cuts a slow sweep short', () => {
	// Every per-call `timeout 5` on its own would let 8 candidates each
	// costing ~2s run to completion (~16s). Only the deadline check at the top
	// of the loop can stop it early, so a stub `find` that is merely SLOW
	// (not stuck) isolates the deadline's own arithmetic from the per-call cap
	// proven by the stuck-find case above.
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
	for (let i = 0; i < 8; i++) {
		mkdirSync(join(fx.pruneRoot, `game-bundle-${i}`), { recursive: true });
		ageAll(join(fx.pruneRoot, `game-bundle-${i}`), 120);
	}
	const slowBin = mkdtempSync(join(PRUNE_SCRATCH, 'slow-find-2s-'));
	writeFileSync(join(slowBin, 'find'), '#!/bin/sh\nsleep 2\n', { mode: 0o755 });
	fx.env.PATH = `${slowBin}:${fx.env.PATH}`;
	fx.env.PRUNE_BOUND_S = '3';
	const r = runHook(fx);
	assert.equal(r.code, 0, 'the deadline must never fail the job');
	assert.ok(
		r.elapsedMs < 12_000,
		`hook took ${r.elapsedMs}ms, expected the deadline to cut an unbounded (>=16s) sweep well short`
	);
	const remaining = Array.from({ length: 8 }, (_, i) =>
		existsSync(join(fx.pruneRoot, `game-bundle-${i}`))
	);
	assert.ok(
		remaining.some((exists) => exists),
		'the deadline must stop the loop before the end — at least one candidate left untouched'
	);
	assert.ok(
		remaining.some((exists) => !exists),
		'the prune must have actually run — at least one candidate removed'
	);
});

test('tripwire: a canary in a second fixture root is never touched by a prune of the first', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
	const secondRoot = mkdtempSync(join(PRUNE_SCRATCH, 'second-root-'));
	const canary = join(secondRoot, 'game-bundle-canary');
	mkdirSync(canary, { recursive: true });
	ageAll(canary, 120);
	const r = runHook(fx);
	assert.equal(r.code, 0);
	assert.equal(existsSync(canary), true, 'a second root is never reached by this prune');
});

test('unreadable df: nothing removed, logged, never fails the job', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { fail: true });
	mkdirSync(join(fx.pruneRoot, 'game-bundle-old'), { recursive: true });
	ageAll(join(fx.pruneRoot, 'game-bundle-old'), 120);
	const r = runHook(fx);
	assert.equal(r.code, 0);
	assert.equal(existsSync(join(fx.pruneRoot, 'game-bundle-old')), true);
	const log = readFileSync(join(fx.home, '.hadoku', 'throttle', 'prune.log'), 'utf8');
	assert.match(log, /could not read usage/);
});

test('df exits 0 but prints only the header line: hook still exits 0, prune.log says it could not read usage', () => {
	// A real `df` CAN do this (a transient mount race, a weird filesystem
	// driver). `set -- $(awk 'NR==2{...}')` then leaves $1/$2/$3 unset, and
	// under `set -u` an unguarded `total=$1` would abort the WHOLE hook with
	// "unbound variable" — a non-zero exit, which fails the job
	// (actions/runner ADR 1751). Proven by mutation below: removing the
	// `${1:-}` defaults (and the `(...) || true` isolation) together turns
	// this red.
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { headerOnly: true });
	mkdirSync(join(fx.pruneRoot, 'game-bundle-old'), { recursive: true });
	ageAll(join(fx.pruneRoot, 'game-bundle-old'), 120);
	const r = runHook(fx);
	assert.equal(r.code, 0, `header-only df must not fail the hook: ${r.out}`);
	assert.equal(existsSync(join(fx.pruneRoot, 'game-bundle-old')), true);
	const log = readFileSync(join(fx.home, '.hadoku', 'throttle', 'prune.log'), 'utf8');
	assert.match(log, /could not read usage/);
});

test('the prune is bounded even with a stuck find/rm, and still exits 0', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
	for (let i = 0; i < 3; i++) {
		mkdirSync(join(fx.pruneRoot, `game-bundle-${i}`), { recursive: true });
		ageAll(join(fx.pruneRoot, `game-bundle-${i}`), 120);
	}
	// A slow `find` ahead on PATH: each per-candidate `timeout 5 find …` absorbs
	// it, so the outer PRUNE_BOUND_S itself is proven by the overall elapsed
	// time staying within bound + a small margin even though every freshness
	// check is individually slow.
	const slowBin = mkdtempSync(join(PRUNE_SCRATCH, 'slow-find-'));
	writeFileSync(join(slowBin, 'find'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
	fx.env.PATH = `${slowBin}:${fx.env.PATH}`;
	fx.env.PRUNE_BOUND_S = '3';
	const r = runHook(fx);
	assert.equal(r.code, 0, 'a stuck prune step must never fail the job');
	assert.ok(
		r.elapsedMs < 20_000,
		`hook took ${r.elapsedMs}ms, expected to return well under the per-step timeout cap`
	);
});

test('a failing rm never fails the job', () => {
	const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 2 });
	fx.env.GITHUB_RUN_ID = '424242';
	withPruneDf(fx, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
	mkdirSync(join(fx.pruneRoot, 'game-bundle-old'), { recursive: true });
	ageAll(join(fx.pruneRoot, 'game-bundle-old'), 120);
	const badRmBin = mkdtempSync(join(PRUNE_SCRATCH, 'bad-rm-'));
	writeFileSync(join(badRmBin, 'rm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
	fx.env.PATH = `${badRmBin}:${fx.env.PATH}`;
	const r = runHook(fx);
	assert.equal(r.code, 0, 'a failing rm must never fail the job');
});

// The admission floor itself, from the built module that exports it: reading
// the literal out of a source file went silently to `skip` each time the
// constant moved, which is a test that stops testing without failing.
test('PRUNE_FREE_MB default is strictly greater than TMP_FREE_FLOOR_MB', () => {
	const floor = TMP_FREE_FLOOR_MB;
	assert.ok(Number.isInteger(floor) && floor > 0, `TMP_FREE_FLOOR_MB is ${floor}`);
	const src = readFileSync(HOOK, 'utf8');
	const m = src.match(/PRUNE_FREE_MB="\$\{PRUNE_FREE_MB:-(\d+)\}"/);
	assert.ok(m, 'PRUNE_FREE_MB default not found in ci-throttle.sh');
	assert.ok(
		Number(m[1]) > floor,
		`PRUNE_FREE_MB default (${m[1]}) must be > TMP_FREE_FLOOR_MB (${floor})`
	);
});

test('static: no /tmp literal in non-comment lines of the prune block, other than the one default', () => {
	const src = readFileSync(HOOK, 'utf8').split('\n');
	const startIdx = src.findIndex((l) =>
		l.includes('wave 4b #100/#101: a cheap, bounded /tmp prune')
	);
	const endIdx = src.findIndex(
		(l, i) => i > startIdx && l.trim() === '}' && src[i - 1]?.includes('return 0')
	);
	assert.ok(
		startIdx >= 0 && endIdx > startIdx,
		'could not locate the prune block in ci-throttle.sh'
	);
	const block = src.slice(startIdx, endIdx + 1);
	const literalLines = block.filter((l) => !l.trim().startsWith('#') && l.includes('/tmp'));
	assert.equal(
		literalLines.length,
		1,
		`expected exactly one /tmp literal, found: ${literalLines.join(' | ')}`
	);
	assert.match(
		literalLines[0],
		/CI_THROTTLE_PRUNE_ROOT:-\/tmp/,
		'the one literal must be the PRUNE_ROOT default'
	);
});

/**
 * Did a PRODUCTION prune remove anything at or after `sinceIso`, per this
 * host's real ~/.hadoku/throttle/prune.log (`THROTTLE_DIR` in ci-throttle.sh)?
 * Read-only. By timestamp, not by count: the log keeps its last 200 lines, so a
 * count can stand still while a removal lands. No file — every box that runs no
 * CI — is "no".
 */
function realPruneRemovedSince(sinceIso) {
	let text;
	try {
		text = readFileSync(join(homedir(), '.hadoku', 'throttle', 'prune.log'), 'utf8');
	} catch (err) {
		if (err.code === 'ENOENT') return false;
		throw err;
	}
	return text
		.split('\n')
		.some((l) => l.slice(0, 20) >= sinceIso && /removed [1-9]\d* candidate/.test(l));
}

/** One pass of the tripwire: plant, run every spawn path, report what survived. */
function tripwirePass() {
	// A canary under the REAL os.tmpdir(), aged 3h so it would be a candidate
	// if maybe_prune_tmp ever saw it, run through both the oldest spawn
	// helper (`run()`, the one that leaked) and the fixture-based path
	// (`nodeFixture`/`runHook`). If hookEnv() is ever bypassed or its root
	// check weakened, this is the test that goes red — and the only thing
	// the leak could have eaten here is this tripwire plus genuine debris.
	const tripwire = join(tmpdir(), `game-bundle-${Math.random().toString(36).slice(2)}-tripwire`);
	mkdirSync(tripwire, { recursive: true });
	const marker = join(tripwire, 'canary.txt');
	writeFileSync(marker, 'tripwire');
	const threeHoursAgo = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
	utimesSync(tripwire, threeHoursAgo, threeHoursAgo);
	utimesSync(marker, threeHoursAgo, threeHoursAgo);
	// Whole seconds, the log's own resolution.
	const since = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
	try {
		const r1 = run({ conf: { MAX_CONCURRENT: 3, MIN_FREE_MB: 0, MAX_WAIT_S: 5 }, others: 1 });
		assert.equal(r1.code, 0);
		if (!existsSync(tripwire)) return { lost: 'run()', since };

		const fx = nodeFixture({ maxConcurrent: 3, maxWaitS: 5 });
		const r2 = runHook(fx);
		assert.equal(r2.code, 0);
		if (!existsSync(tripwire)) return { lost: 'runHook()/nodeFixture', since };

		// Same again, but with the prune actually ARMED — a real GITHUB_RUN_ID
		// and an above-threshold fixture df — so the tripwire also proves the
		// real root stays untouched once the gate this wave added lets the
		// prune run at all.
		const fx2 = nodeFixture({ maxConcurrent: 3, maxWaitS: 5 });
		fx2.env.GITHUB_RUN_ID = '424242';
		withPruneDf(fx2, { totalMb: 8000, usedMb: 5000, availMb: 2000 });
		const r3 = runHook(fx2);
		assert.equal(r3.code, 0);
		if (!existsSync(tripwire)) {
			return { lost: 'runHook()/nodeFixture with GITHUB_RUN_ID set and the prune armed', since };
		}
		return { lost: null, since };
	} finally {
		rmSync(tripwire, { recursive: true, force: true });
	}
}

test('REAL-ROOT TRIPWIRE: the suite must never prune the real host /tmp', () => {
	// A HOST THAT ALSO RUNS CI PRUNES THE SAME /tmp FOR REAL. hokon is the CI
	// backstop: every job it admits runs this very maybe_prune_tmp against /tmp,
	// and a 3h-old game-bundle-* is exactly what that prune exists to delete.
	// On 2026-11-12 06:00:27Z a hadoku_site Redeploy job's prune removed one
	// ~4KB candidate mid-suite — this tripwire — and the test blamed the suite.
	// So a lost tripwire is excused ONLY when this host's own prune.log shows a
	// production removal inside the pass, and then the pass is re-run. A real
	// leak eats the tripwire on every pass and still fails here.
	for (let attempt = 1; attempt <= 3; attempt++) {
		const { lost, since } = tripwirePass();
		if (!lost) return;
		assert.ok(
			realPruneRemovedSince(since),
			`${lost}: real host /tmp tripwire must survive (no production prune ran in the window)`
		);
	}
	assert.fail(
		'the tripwire was lost to a production prune on 3 passes running — inconclusive, rerun'
	);
});

test('pin: the hook and the cleaner share the same stale-debris pattern list', () => {
	const hookSrc = readFileSync(HOOK, 'utf8');
	const hookMatch = hookSrc.match(/^PRUNE_PATTERNS='([^']*)'/m);
	assert.ok(hookMatch, 'PRUNE_PATTERNS not found in ci-throttle.sh');
	const hookPatterns = hookMatch[1].trim().split(/\s+/).sort();

	const cleanerPath = join(SCRIPTS, 'clean-runner-debris.sh');
	const cleanerSrc = readFileSync(cleanerPath, 'utf8');
	const cleanerPatterns = [...cleanerSrc.matchAll(/sweep_glob\s+"\$TMP_ROOT"\s+'([^']*)'/g)]
		.map((m) => m[1])
		.sort();

	assert.deepEqual(
		hookPatterns,
		cleanerPatterns,
		`ci-throttle.sh PRUNE_PATTERNS ${JSON.stringify(hookPatterns)} must equal clean-runner-debris.sh's sweep_glob patterns ${JSON.stringify(cleanerPatterns)}`
	);
});

installLeakGate();
