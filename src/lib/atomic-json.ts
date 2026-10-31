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
 * "I COULD NOT LOOK" IS NEVER "NOTHING IS WRONG" (AGENTS.md). A corrupt file
 * — one that exists, reads back, and does not parse — is a DIFFERENT finding
 * than a missing one, and `readJsonState` never collapses the two: a missing
 * file is `{ok:true, missing:true}` (nothing has been written yet, which is
 * normal on a fresh box), a corrupt one is `{ok:false, why}` (something wrote
 * a file that cannot be trusted, which is never normal and must not be read
 * back as though the state were empty).
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
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
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
 */
function sweepStaleTempFiles(path: string, dir: string): void {
	const base = basename(path);
	const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.tmp$`);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return; // nothing to sweep if the directory cannot even be listed
	}
	for (const entry of entries) {
		const m = pattern.exec(entry);
		if (!m) continue; // not a temp file of THIS path
		const pid = Number(m[1]);
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
 * `fsync: false` is a RECORDED divergence (plan §4.1 step 2), not a default:
 * pass it only for a site hot enough that the two fsyncs measurably cost —
 * `conditional-cache-store.ts` (per conditional GitHub read) and
 * `dispatch-tick.ts` (its 15 s tick) are the two in this wave's divergence
 * table. Everywhere else, durability is free compared to how rarely these
 * files are written.
 */
export interface AtomicWriteOptions {
	fsync?: boolean;
}

/**
 * Replace `path` with `text` so a crash at any instant leaves either the old
 * file or the new one, whole, never a truncated mix: write a sibling temp
 * file in the SAME directory (so the rename is same-filesystem and atomic),
 * fsync it, rename it over the target, then fsync the directory so the
 * rename itself survives a crash too.
 *
 * The parent directory is created if missing — every existing call site did
 * this immediately before its own write-then-rename, so folding it in here
 * removes that duplicate line at each one without changing behaviour.
 */
export function writeFileAtomic(path: string, text: string, opts: AtomicWriteOptions = {}): void {
	const { fsync = true } = opts;
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	sweepStaleTempFiles(path, dir);
	const tmp = `${path}.${process.pid}.tmp`;
	const fd = openSync(tmp, 'w');
	try {
		let buf = Buffer.from(text, 'utf8');
		while (buf.length) buf = buf.subarray(writeSync(fd, buf));
		if (fsync) fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	if (!fsync) return;
	const dirFd = openSync(dir, 'r');
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

/** `writeFileAtomic`, `JSON.stringify`-ing `value` first. `space` matches `JSON.stringify`'s third argument. */
export function writeJsonAtomic(
	path: string,
	value: unknown,
	opts: AtomicWriteOptions & { space?: string | number } = {}
): void {
	const { space, ...rest } = opts;
	writeFileAtomic(path, JSON.stringify(value, null, space), rest);
}

export type JsonStateRead<T> =
	{ ok: true; doc: T; missing?: false } | { ok: true; missing: true } | { ok: false; why: string };

/**
 * Read `path` as JSON. Three outcomes, never collapsed into each other:
 *   - no file at all (ENOENT): `{ok:true, missing:true}` — normal on a fresh
 *     box or before the first write, and the caller's "start from empty"
 *     path is exactly this branch.
 *   - a file that exists but will not parse: `{ok:false, why}` — "I could not
 *     look" (AGENTS.md), never silently treated as empty or missing. Every
 *     caller must decide for itself what a corrupt state file means for its
 *     own domain; this function's job stops at telling the truth about what
 *     it read.
 *   - a file that reads and parses: `{ok:true, doc}`.
 *
 * Any OTHER read failure (permissions, a directory where a file was
 * expected, …) is also `{ok:false, why}` — this never throws.
 */
export function readJsonState<T = unknown>(path: string): JsonStateRead<T> {
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, missing: true };
		return { ok: false, why: err instanceof Error ? err.message : String(err) };
	}
	try {
		return { ok: true, doc: JSON.parse(raw) as T };
	} catch (err) {
		return { ok: false, why: `corrupt JSON: ${err instanceof Error ? err.message : String(err)}` };
	}
}
