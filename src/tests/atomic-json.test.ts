import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJsonState, writeFileAtomic, writeJsonAtomic } from '../lib/atomic-json.js';

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), 'atomic-json-test-'));
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
