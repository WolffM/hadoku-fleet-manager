/**
 * atomic-json — the one way a state file is replaced on disk (refactor plan
 * §4.1 F3, state layer).
 *
 * WHY. A forced restart on these boxes is a power cut, not a clean shutdown
 * (memory `force-restart-is-power-off`), and a bare `writeFileSync` followed
 * by a `renameSync` is not enough protection against one: without an fsync of
 * the temp file BEFORE the rename, the kernel is free to reorder the rename
 * ahead of the data actually landing on disk, so a crash at the wrong instant
 * can rename in a file of zeros or a short write. Without an fsync of the
 * DIRECTORY after the rename, the rename itself — a metadata change — can be
 * lost on the next boot even though the data was flushed, which can leave the
 * OLD file in place with no visible error. `job-history.ts` and
 * `job-rollup-store.ts` already did both; this is that pattern, pulled out
 * once so every other state file gets it for free (23 copies wrote
 * write-then-rename by hand without the fsyncs; 35 call sites had no rename
 * at all — `scripts/lib/f-guards/f3-guard.test.mjs`).
 *
 * "I COULD NOT LOOK" IS NEVER "NOTHING IS WRONG" (AGENTS.md). A corrupt state
 * file — one that exists, reads back, and does not parse — is a DIFFERENT
 * finding than a missing one: a missing file is normal on a fresh box or
 * before the first write, a corrupt one means something wrote a file that
 * cannot be trusted, and the two must never collapse into each other. Every
 * reader of a file this module writes is responsible for keeping that
 * distinction on its own read path.
 *
 * WHAT THIS IS NOT. The JSONL appenders (`job-history.ts`'s history file,
 * `usage-store.ts`, `decision-log.ts`'s per-day files) are NOT routed through
 * `writeJsonAtomic` — rewriting the whole file on every row would turn an
 * O(1) append into an O(n) rewrite. They keep `appendFileSync` and are
 * declared writers in the one-writer guard instead
 * (`scripts/lib/f-guards/f3-one-writer.test.mjs`).
 *
 * THE TEMP FILE ITSELF CAN OUTLIVE THE PROCESS (wave 5c §D step 4). The crash
 * this module protects `path` against can just as easily land between
 * `openSync(tmp, 'w')` and `renameSync(tmp, path)` — there is no fsync that
 * makes a `renameSync` call happen before a power cut reaches it — and a
 * forced restart means the pid that created `tmp` is never coming back to
 * clean it up. `writeFileAtomic` therefore sweeps stale siblings of ITS OWN
 * target `path` before writing: see `sweepStaleTempFiles` below for exactly
 * what "stale" means (dead pid AND old enough not to race a write genuinely
 * in flight right now). It never touches the live state dir except through
 * this same call path — there is no separate cron or subcommand for it.
 */
import {
	close,
	closeSync,
	fsync,
	fsyncSync,
	mkdirSync,
	open,
	openSync,
	readdirSync,
	rename,
	renameSync,
	statSync,
	unlinkSync,
	write,
	writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * A sibling `${path}.<pid>.tmp` is swept only once it is this stale — long
 * enough that a write genuinely in progress right now (this process mid-write,
 * or another one that started moments ago) is never mistaken for an orphan.
 * The live example this sweep fixes: `~/.hadoku-mgmt/job-history.jsonl.2791194.tmp`,
 * 0 bytes, sitting since a crash on 2026-10-29 — a forced restart is a power
 * cut here (`force-restart-is-power-off`), so the pid that made it is gone for
 * good and nothing else will ever clean it up.
 */
const STALE_TMP_MS = 10 * 60 * 1000;

/**
 * Is `pid` still a live process? `process.kill(pid, 0)` sends no signal — it
 * only asks the kernel whether that pid could be signaled. `ESRCH` means no
 * such process, i.e. dead. Anything else — no throw, or `EPERM` for a pid
 * owned by another user this process cannot query — is treated as ALIVE:
 * never delete a file whose writer this code cannot positively rule out.
 */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
	}
}

/**
 * Before `writeFileAtomic` creates its OWN temp file, sweep any sibling
 * `${path}.<pid>.tmp` a CRASHED write of this same `path` left behind —
 * never a live pid's (including this process's own, though it has not
 * created its temp file yet when this runs), and never another path's: the
 * pattern is anchored to `path`'s exact basename, so `job-history.jsonl` and
 * `job-history.jsonl.bak` never match each other's temp files.
 *
 * Best-effort only. A failure here (a raced delete against another sweep, a
 * permissions surprise on an unrelated directory entry) must never block the
 * real write this function exists to make durable — each candidate is
 * handled independently and a failure on one is skipped, not propagated.
 *
 * ONCE PER PATH PER PROCESS (fleet-manager#86). The sweep lists the whole
 * directory, and `gh-conditional-cache/runner-health` holds ~4,800 entries
 * written one at a time: run on every write, the listing was 7.2 s of
 * mgmt-api's event loop in one 300 s profile (2026-11-16 01:39Z). An orphan
 * is left only by a process that died, and this process's own temp file is
 * never one, so the first write of a path is the one that can find anything.
 * An orphan still under {@link STALE_TMP_MS} old at that moment waits for the
 * next process; it is a dead temp file, never the live one.
 */
const swept = new Set<string>();

/**
 * Each directory is LISTED once per process, too: the first write of each of
 * `gh-conditional-cache/runner-health`'s ~4,800 paths would otherwise list all
 * ~4,800 entries again (47 ms per 300 s on 0.34.433 after a restart). The one
 * listing is grouped by the path a temp file belongs to, `<base>.<pid>.tmp`,
 * and a path's first write takes only its own group, so the rule above —
 * never another path's temp file — is the same rule.
 */
const tempsByDir = new Map<string, Map<string, { entry: string; pid: number }[]>>();
const TEMP_NAME = /^(.+)\.(\d+)\.tmp$/;

function tempsOf(dir: string): Map<string, { entry: string; pid: number }[]> {
	let byBase = tempsByDir.get(dir);
	if (byBase) return byBase;
	byBase = new Map();
	tempsByDir.set(dir, byBase);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return byBase; // nothing to sweep if the directory cannot even be listed
	}
	for (const entry of entries) {
		const m = TEMP_NAME.exec(entry);
		if (!m) continue;
		const group = byBase.get(m[1]) ?? [];
		group.push({ entry, pid: Number(m[2]) });
		byBase.set(m[1], group);
	}
	return byBase;
}

function sweepStaleTempFiles(path: string, dir: string): void {
	if (swept.has(path)) return;
	swept.add(path);
	const byBase = tempsOf(dir);
	const base = basename(path);
	const group = byBase.get(base);
	if (!group) return;
	byBase.delete(base);
	for (const { entry, pid } of group) {
		if (pid === process.pid || isPidAlive(pid)) continue; // never a live pid's
		const full = join(dir, entry);
		try {
			if (Date.now() - statSync(full).mtimeMs < STALE_TMP_MS) continue; // too recent to be a confirmed orphan
			unlinkSync(full);
		} catch {
			// Best-effort cleanup — see the function header.
		}
	}
}

/**
 * THE WRITE, ONCE. Each step is a syscall the protocol yields; a driver runs
 * it. `writeFileAtomicSync` runs every step on the calling thread,
 * `writeFileAtomic` runs each on libuv's threadpool. Both execute this one
 * sequence, so the two cannot drift: write a sibling temp file in the SAME
 * directory (so the rename is same-filesystem and atomic), fsync it, rename it
 * over the target, then fsync the directory so the rename itself survives a
 * crash too. A crash at any instant leaves either the old file or the new one,
 * whole, never a truncated mix.
 *
 * There is no way to skip the fsyncs. Nine call sites used to pass
 * `fsync: false` because two fsyncs on the event loop cost too much on a hot
 * path; off the loop they cost the loop nothing, and the coalescing in
 * `writeFileAtomic` bounds how many a hot path can queue (fleet-manager#86).
 *
 * The parent directory is created if missing — every existing call site did
 * this immediately before its own write-then-rename.
 */
type Step =
	| { op: 'open'; path: string; flags: 'w' | 'r' }
	| { op: 'write'; fd: number; buf: Buffer }
	| { op: 'fsync'; fd: number }
	| { op: 'close'; fd: number }
	| { op: 'rename'; from: string; to: string };

function* protocol(path: string, text: string): Generator<Step, void, number> {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	sweepStaleTempFiles(path, dir);
	const tmp = `${path}.${process.pid}.tmp`;
	const fd = yield { op: 'open', path: tmp, flags: 'w' };
	try {
		let buf = Buffer.from(text, 'utf8');
		while (buf.length) buf = buf.subarray(yield { op: 'write', fd, buf });
		yield { op: 'fsync', fd };
	} finally {
		yield { op: 'close', fd };
	}
	yield { op: 'rename', from: tmp, to: path };
	const dirFd = yield { op: 'open', path: dir, flags: 'r' };
	try {
		yield { op: 'fsync', fd: dirFd };
	} finally {
		yield { op: 'close', fd: dirFd };
	}
}

function stepSync(s: Step): number {
	switch (s.op) {
		case 'open':
			return openSync(s.path, s.flags);
		case 'write':
			return writeSync(s.fd, s.buf);
		case 'fsync':
			fsyncSync(s.fd);
			return 0;
		case 'close':
			closeSync(s.fd);
			return 0;
		case 'rename':
			renameSync(s.from, s.to);
			return 0;
	}
}

function stepAsync(s: Step): Promise<number> {
	return new Promise((resolve, reject) => {
		const done = (err: NodeJS.ErrnoException | null, n = 0): void =>
			err ? reject(err) : resolve(n);
		switch (s.op) {
			case 'open':
				return open(s.path, s.flags, done);
			case 'write':
				return write(s.fd, s.buf, done);
			case 'fsync':
				return fsync(s.fd, (err) => done(err));
			case 'close':
				return close(s.fd, (err) => done(err));
			case 'rename':
				return rename(s.from, s.to, (err) => done(err));
		}
	});
}

/**
 * Drive the protocol, feeding each step's result back in. A failed step is
 * thrown INTO the generator so its `finally` blocks still close what is open.
 */
function runSync(path: string, text: string): void {
	const g = protocol(path, text);
	let r = g.next();
	while (!r.done) {
		let out: number;
		try {
			out = stepSync(r.value);
		} catch (err) {
			r = g.throw(err);
			continue;
		}
		r = g.next(out);
	}
}

async function runAsync(path: string, text: string): Promise<void> {
	const g = protocol(path, text);
	let r = g.next();
	while (!r.done) {
		let out: number;
		try {
			out = await stepAsync(r.value);
		} catch (err) {
			r = g.throw(err);
			continue;
		}
		r = g.next(out);
	}
}

/**
 * For short-lived processes only: the CLI's `scripts/`, which have no event
 * loop serving anyone else. Inside `src/`, which runs in mgmt-api, use
 * `writeFileAtomic`; `scripts/lib/f-guards/f3-one-writer.test.mjs` holds that.
 */
export function writeFileAtomicSync(path: string, text: string): void {
	runSync(path, text);
}

/** `writeFileAtomicSync`, `JSON.stringify`-ing `value` first. */
export function writeJsonAtomicSync(
	path: string,
	value: unknown,
	opts: { space?: string | number } = {}
): void {
	runSync(path, JSON.stringify(value, null, opts.space));
}

/**
 * The in-process writer: the protocol with every syscall on libuv's
 * threadpool. An fsync's latency is the disk's, not the file's — one 33 KB
 * write held mgmt-api's loop 52.6 ms in a single `fsyncSync` (fleet-manager#86).
 *
 * WRITES TO ONE PATH RUN ONE AT A TIME, IN CALL ORDER. They share the temp
 * name `${path}.<pid>.tmp`, so they cannot overlap. A failed write rejects its
 * own caller and never blocks the next one.
 *
 * TWO WAYS TO CALL IT. A caller that acts on the write — a store returning
 * what it kept, a page recorded before the next one is sent, a controller's
 * state before it reboots a node — awaits it. A module whose in-memory state is
 * the truth and whose file is only its mirror across restarts starts the write
 * and goes on, reporting a failure with `.catch`; `flushWrites` lands those
 * before an exit.
 *
 * A READ-MODIFY-WRITE PASSES A FUNCTION. `text` may be `() => string`; it is
 * called when this write's turn comes, after every earlier write to the path
 * has landed. A store that reads its file, merges, and writes it back does the
 * read inside that function, so two overlapping calls cannot both read the old
 * file and lose one another's rows.
 */
const queues = new Map<string, Promise<void>>();

export function writeFileAtomic(path: string, text: string | (() => string)): Promise<void> {
	const prev = queues.get(path) ?? Promise.resolve();
	const run = (): Promise<void> => runAsync(path, typeof text === 'function' ? text() : text);
	const next = prev.then(run, run);
	queues.set(path, next);
	const clear = (): void => {
		if (queues.get(path) === next) queues.delete(path);
	};
	next.then(clear, clear);
	return next;
}

/**
 * Every write started in this process, landed. A module that mirrors in-memory
 * state to disk starts its write and goes on (write-behind); a process that is
 * about to exit awaits this first, so no such write is cut short.
 */
export async function flushWrites(): Promise<void> {
	while (queues.size) await Promise.allSettled([...queues.values()]);
}

/** `writeFileAtomic`, `JSON.stringify`-ing `value` first. */
export function writeJsonAtomic(
	path: string,
	value: unknown,
	opts: { space?: string | number } = {}
): Promise<void> {
	return writeFileAtomic(path, () => JSON.stringify(value, null, opts.space));
}
