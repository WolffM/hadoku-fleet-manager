import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import fs, {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonState, writeFileAtomic, writeJsonAtomic } from '../lib/atomic-json.js';

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), 'atomic-json-test-'));
}

/** This test runs COMPILED, from `dist/tests/`, so reaching the TypeScript source means climbing
 *  back out of `dist/` to the repo root first. */
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * A pid that is GUARANTEED dead — never a real process this test signals.
 * `spawnSync` blocks until the child exits and is reaped, so by the time it
 * returns, that pid no longer belongs to any process (short of the kernel
 * reusing it before this test calls `process.kill(pid, 0)`, a race no test
 * of pid liveness can fully rule out, same as production's own check).
 */
function deadPid(): number {
	const r = spawnSync(process.execPath, ['-e', '0']);
	if (typeof r.pid !== 'number') throw new Error('spawnSync did not report a pid');
	return r.pid;
}

/** 11 minutes ago — just past `STALE_TMP_MS` (10 minutes). */
function elevenMinutesAgo(): Date {
	return new Date(Date.now() - 11 * 60 * 1000);
}

/**
 * Replace `fs[key]` with `replacement`, then `syncBuiltinESMExports()` so a
 * module that did `import { writeSync } from 'node:fs'` (exactly what
 * `atomic-json.ts` does) sees the patched function too — ESM named imports
 * are live bindings to the CJS module object's properties, and that sync is
 * what keeps the two in step. Returns the restore function; callers MUST run
 * it (and re-sync) in a `finally`, or every later test in the process keeps
 * the patch.
 *
 * NEVER log, assert or otherwise touch stdout/stderr from inside a
 * replacement while it is installed: `console.log`/`process.stdout.write`
 * can themselves go through a synchronous `fs.writeSync` on this platform,
 * and a patched `writeSync` that logs recurses into itself forever. Record
 * to a plain array instead and inspect it after restoring.
 */
function patchFs<K extends 'writeSync' | 'fsyncSync' | 'renameSync'>(
	key: K,
	replacement: (typeof fs)[K]
): () => void {
	const original = fs[key];
	fs[key] = replacement;
	syncBuiltinESMExports();
	return () => {
		fs[key] = original;
		syncBuiltinESMExports();
	};
}

test('writeJsonAtomic + readJsonState round-trip', () => {
	const dir = tmpDir();
	try {
		const path = join(dir, 'state.json');
		writeJsonAtomic(path, { a: 1, b: ['x', 'y'] });
		const read = readJsonState<{ a: number; b: string[] }>(path);
		assert.equal(read.ok, true);
		assert.ok(read.ok && !read.missing);
		assert.deepEqual(read.ok && !read.missing ? read.doc : null, { a: 1, b: ['x', 'y'] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('writeJsonAtomic creates the parent directory, like every call site did by hand before', () => {
	const dir = tmpDir();
	try {
		const path = join(dir, 'nested', 'deeper', 'state.json');
		writeJsonAtomic(path, { ok: true });
		const read = readJsonState(path);
		assert.deepEqual(read, { ok: true, doc: { ok: true } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('readJsonState: a missing file is {ok:true, missing:true}, never {ok:false}', () => {
	const dir = tmpDir();
	try {
		const read = readJsonState(join(dir, 'does-not-exist.json'));
		assert.deepEqual(read, { ok: true, missing: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('readJsonState: a corrupt file is {ok:false, why} — "I could not look" is never "nothing is wrong"', () => {
	const dir = tmpDir();
	try {
		const path = join(dir, 'corrupt.json');
		writeFileSync(path, '{"a": 1, "b": [unterminated');
		const read = readJsonState(path);
		assert.equal(read.ok, false);
		assert.ok(!read.ok && typeof read.why === 'string' && read.why.length > 0);
		// Never collapsed into "missing" or an empty-looking success.
		assert.notDeepEqual(read, { ok: true, missing: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('readJsonState: an empty file (the exact failure mode a bare rename without fsync can leave) is corrupt, not empty-as-valid', () => {
	const dir = tmpDir();
	try {
		const path = join(dir, 'empty.json');
		writeFileSync(path, '');
		const read = readJsonState(path);
		assert.equal(read.ok, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('writeFileAtomic: fsync:false still writes complete, readable content (the recorded divergence for a hot path)', () => {
	const dir = tmpDir();
	try {
		const path = join(dir, 'hot.json');
		writeFileAtomic(path, JSON.stringify({ hot: true }), { fsync: false });
		assert.deepEqual(readJsonState(path), { ok: true, doc: { hot: true } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * BASELINE: the OLD pattern (no helper at all, no temp file) really can leave
 * a live file corrupt after a kill mid-write. This does not call
 * `writeFileAtomic` — it is deliberately the thing F3 replaces, kept as the
 * documented baseline the next test is contrasted against.
 */
test('mutation baseline: the OLD no-temp-file write can leave the live file truncated after a kill mid-write', () => {
	const dir = tmpDir();
	try {
		const path = join(dir, 'old-style.json');
		const full = JSON.stringify({ day: '2026-10-29', rows: [1, 2, 3, 4, 5, 6, 7, 8] });
		// "Before" fixture: there is already good state on disk.
		writeFileSync(path, full);
		// The old pattern writes the SAME live path directly, no temp file. A
		// kill partway through a write() leaves whatever bytes landed before
		// the kernel delivered the signal — modelled here as a short write.
		writeFileSync(path, full.slice(0, Math.floor(full.length / 2)));
		const read = readJsonState(path);
		assert.equal(
			read.ok,
			false,
			'REVERTED (old pattern): the live file is now corrupt — this is the bug F3 fixes'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * THE REAL MUTATION PROOF (done-when, §C step 5): the crash is injected INTO
 * `writeFileAtomic` itself, not simulated beside it — a sent-back version of
 * this test hand-wrote a `.tmp` file next to the real call and never invoked
 * the helper at all, so a broken helper (e.g. one that wrote straight to
 * `path`) would have passed it anyway. `fs.writeSync` is patched to perform
 * one real PARTIAL write and then throw, exactly once, so the exact code
 * path inside `writeFileAtomic`'s `while (buf.length) buf =
 * buf.subarray(writeSync(fd, buf))` loop is exercised and dies mid-loop,
 * before `renameSync` is ever reached.
 */
test('mutation: writeFileAtomic cannot be left corrupt by a kill between the temp write and the rename (fault-injected)', () => {
	const dir = tmpDir();
	try {
		const path = join(dir, 'new-style.json');
		const good = { day: '2026-10-28', rows: [1, 2, 3] };
		writeJsonAtomic(path, good); // "before" state, written through the REAL helper.

		const realWriteSync = fs.writeSync;
		let crashed = false;
		const restore = patchFs('writeSync', ((fd: number, buffer: NodeJS.ArrayBufferView) => {
			if (crashed) return (realWriteSync as (...a: unknown[]) => number)(fd, buffer);
			crashed = true;
			const half = (buffer as Uint8Array).subarray(
				0,
				Math.floor((buffer as Uint8Array).length / 2)
			);
			(realWriteSync as (...a: unknown[]) => number)(fd, half); // a REAL partial write lands…
			throw new Error('simulated crash mid-write'); // …then the process "dies".
		}) as unknown as (typeof fs)['writeSync']);

		let threw = false;
		try {
			writeJsonAtomic(path, { day: '2026-10-29', rows: [4, 5, 6, 7] });
		} catch {
			threw = true;
		} finally {
			restore();
		}
		assert.ok(threw, 'the injected crash must propagate out of writeJsonAtomic, not be swallowed');

		const read = readJsonState<typeof good>(path);
		assert.equal(read.ok, true, 'RESTORED: the live file is untouched by the crashed write');
		assert.ok(read.ok && !read.missing);
		assert.deepEqual(
			read.ok && !read.missing ? read.doc : null,
			good,
			'still the prior, complete day — the half-written temp file was never renamed over it'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * ORDERING PROOF: patch `writeSync`/`fsyncSync`/`renameSync` to each record a
 * tag (and still perform the real call), so the call LOG proves the temp
 * file is fsync'd BEFORE the rename and the directory is fsync'd AFTER it —
 * not merely that two fsyncs happen somewhere. `fsync:false` is proven to
 * skip both.
 */
test('writeFileAtomic: fsync happens BEFORE the rename and AFTER it; fsync:false calls neither', () => {
	const dir = tmpDir();
	const realWriteSync = fs.writeSync;
	const realFsyncSync = fs.fsyncSync;
	const realRenameSync = fs.renameSync;
	try {
		const path = join(dir, 'order.json');
		const log: string[] = [];
		const restoreWrite = patchFs('writeSync', ((fd: number, buffer: NodeJS.ArrayBufferView) => {
			log.push('write');
			return (realWriteSync as (...a: unknown[]) => number)(fd, buffer);
		}) as unknown as (typeof fs)['writeSync']);
		const restoreFsync = patchFs('fsyncSync', ((fd: number) => {
			log.push('fsync');
			(realFsyncSync as (...a: unknown[]) => void)(fd);
		}) as unknown as (typeof fs)['fsyncSync']);
		const restoreRename = patchFs('renameSync', ((from: string, to: string) => {
			log.push('rename');
			(realRenameSync as (...a: unknown[]) => void)(from, to);
		}) as unknown as (typeof fs)['renameSync']);

		try {
			writeJsonAtomic(path, { ok: true });
		} finally {
			restoreRename();
			restoreFsync();
			restoreWrite();
		}

		const firstFsync = log.indexOf('fsync');
		const rename = log.indexOf('rename');
		const secondFsync = log.indexOf('fsync', rename + 1);
		assert.ok(
			firstFsync >= 0 && firstFsync < rename,
			`fsync must precede rename: ${JSON.stringify(log)}`
		);
		assert.ok(
			secondFsync > rename,
			`a second fsync must follow rename (the directory): ${JSON.stringify(log)}`
		);
		assert.equal(
			log.filter((e) => e === 'fsync').length,
			2,
			`exactly two fsyncs: ${JSON.stringify(log)}`
		);

		// fsync:false — neither fsync call happens, write and rename still do.
		const log2: string[] = [];
		const path2 = join(dir, 'order-nofsync.json');
		const restoreWrite2 = patchFs('writeSync', ((fd: number, buffer: NodeJS.ArrayBufferView) => {
			log2.push('write');
			return (realWriteSync as (...a: unknown[]) => number)(fd, buffer);
		}) as unknown as (typeof fs)['writeSync']);
		const restoreFsync2 = patchFs('fsyncSync', ((fd: number) => {
			log2.push('fsync');
			(realFsyncSync as (...a: unknown[]) => void)(fd);
		}) as unknown as (typeof fs)['fsyncSync']);
		const restoreRename2 = patchFs('renameSync', ((from: string, to: string) => {
			log2.push('rename');
			(realRenameSync as (...a: unknown[]) => void)(from, to);
		}) as unknown as (typeof fs)['renameSync']);
		try {
			writeFileAtomic(path2, JSON.stringify({ ok: true }), { fsync: false });
		} finally {
			restoreRename2();
			restoreFsync2();
			restoreWrite2();
		}
		assert.equal(
			log2.filter((e) => e === 'fsync').length,
			0,
			`fsync:false must call fsyncSync zero times: ${JSON.stringify(log2)}`
		);
		assert.ok(
			log2.includes('write') && log2.includes('rename'),
			'the write and the rename still happen'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- stale temp sweep (wave 5c §D step 4) -----------------------------------
//
// All through the PUBLIC API (`writeJsonAtomic`), never a testing-only export
// of `sweepStaleTempFiles` — the thing being proven is that a normal write
// cleans up after a crashed earlier one, not a unit of internal logic in
// isolation. Fixture directories only; the live state dir is never touched
// from a test (AGENTS.md, this wave's brief).

test('stale temp sweep: a dead-pid, >10-minute-old sibling tmp for the SAME path is removed by the next write', () => {
	const dir = tmpDir();
	try {
		const path = join(dir, 'state.json');
		const pid = deadPid();
		const stale = `${path}.${pid}.tmp`;
		writeFileSync(stale, '{"half":');
		const old = elevenMinutesAgo();
		utimesSync(stale, old, old);

		writeJsonAtomic(path, { fresh: true });

		assert.ok(!existsSync(stale), 'the stale temp file must be swept');
		assert.deepEqual(readJsonState(path), { ok: true, doc: { fresh: true } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('stale temp sweep: a dead-pid sibling tmp UNDER 10 minutes old is left alone — too young to be a confirmed orphan', () => {
	const dir = tmpDir();
	try {
		const path = join(dir, 'state.json');
		const pid = deadPid();
		const recent = `${path}.${pid}.tmp`;
		writeFileSync(recent, '{"half":');
		// Explicit "now", from THIS process's own `Date` — never the OS-default
		// mtime a bare writeFileSync leaves. `fixture-clock-guard.test.mjs` reruns
		// this whole suite with `Date` shifted decades forward while the real
		// filesystem clock does not move; an mtime left at the untouched OS clock
		// would then read as ancient relative to the shifted `Date.now()` the
		// production sweep compares against, failing this test for a reason that
		// has nothing to do with staleness. Setting it from `Date` keeps both
		// sides of that comparison on the same clock, shifted or not — exactly
		// `elevenMinutesAgo()`'s own reasoning below, for the opposite case.
		const now = new Date();
		utimesSync(recent, now, now);

		writeJsonAtomic(path, { fresh: true });

		assert.ok(existsSync(recent), 'a recent dead-pid temp file must survive — it is not yet stale');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stale temp sweep: a LIVE pid's sibling tmp is never removed, no matter how old its mtime is", () => {
	const dir = tmpDir();
	// A real child process this test starts and owns, kept alive for the
	// duration of the check — never the test's OWN pid, which would collide
	// with writeFileAtomic's own `${path}.${process.pid}.tmp` naming for its
	// REAL new temp file and make the rename (not the sweep) consume the
	// fixture. Killing it after is this test terminating its OWN child, not
	// signalling an unrelated process.
	const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)']);
	try {
		if (typeof child.pid !== 'number') throw new Error('spawn did not report a pid');
		const path = join(dir, 'state.json');
		const live = `${path}.${child.pid}.tmp`;
		writeFileSync(live, '{"half":');
		const old = elevenMinutesAgo();
		utimesSync(live, old, old);

		writeJsonAtomic(path, { fresh: true });

		assert.ok(existsSync(live), "a live pid's temp file must never be removed, however old");
	} finally {
		child.kill('SIGKILL');
		rmSync(dir, { recursive: true, force: true });
	}
});

test('stale temp sweep: a stale tmp for a DIFFERENT path in the same directory is never touched', () => {
	const dir = tmpDir();
	try {
		const path = join(dir, 'state.json');
		const otherPath = join(dir, 'other.json');
		const pid = deadPid();
		const staleOther = `${otherPath}.${pid}.tmp`;
		writeFileSync(staleOther, '{"half":');
		const old = elevenMinutesAgo();
		utimesSync(staleOther, old, old);

		writeJsonAtomic(path, { fresh: true }); // writes state.json, not other.json

		assert.ok(existsSync(staleOther), "another path's temp file must never be swept");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('stale temp sweep: never the live state dir — writeFileAtomic only sweeps siblings of the path IT was called with', () => {
	// Documents the invariant rather than exercising ~/.hadoku-mgmt directly
	// (never touched from a test): sweepStaleTempFiles's only caller is
	// writeFileAtomic, scoped to dirname(path) for that one call's own
	// target — there is no directory-wide glob and no separate cron.
	const src = readFileSync(join(REPO_ROOT, 'src', 'lib', 'atomic-json.ts'), 'utf8');
	assert.match(src, /sweepStaleTempFiles\(path, dir\);/);
	assert.equal(
		[...src.matchAll(/sweepStaleTempFiles\(/g)].length,
		2, // the function's own declaration site + its one call site
		'sweepStaleTempFiles must be called from exactly one place'
	);
});
