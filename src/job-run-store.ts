/**
 * job-run-store — the T7 job sink (refactor plan §6.2/§7.3): one row per
 * completed run of a registry job, loops' sub-cadences included, answering
 * "did the nightly gates run, and what did they find, last month" and
 * feeding the staleness gate §6.2 describes ("every job has a run younger
 * than 2x its cadence").
 *
 * TWO WRITERS, ONE STORE, NO HOST DEPENDENCY. `src/lib/job-runner.ts`'s
 * `finishTick` records every IN-PROCESS registry job (the three `clockMs`
 * convergers, running inside mgmt-api). `scripts/lib/emit.mjs`'s `emit()`
 * records every CRON job (`fleet <sub> --json`, a separate process per run).
 * The two resolve `stateDir()` through different doors — `host.ts` in-process,
 * `lib/fleet-paths.ts` for the CLI (`job-history-store.ts`'s own
 * `PROBE_LEDGER_FILE` comment names this exact split) — so this module takes
 * `dir` as a plain parameter and imports NEITHER door itself, the one way to
 * stay usable from both without an import that would make a cron script
 * depend on a FleetHost nothing ever installs for it.
 *
 * STORAGE: one JSONL file per UTC day, `job-runs/run-<day>.jsonl`, appended.
 * EVERY WRITE IS ONE `appendFileSync` CALL of a single whole JSON line
 * (`JSON.stringify(row) + '\n'`), which is the shape `scripts/lib/f-guards/
 * f3-guard.test.mjs` exempts from the write-then-rename rule: a crash mid-
 * write can only tear the TAIL, which the reader below counts and skips,
 * never a live record it is reading.
 *
 * CONCURRENCY: SEVERAL PROCESSES APPEND TO THE SAME DAY FILE — mgmt-api's own
 * event loop (the three in-process convergers) and however many `fleet <sub>
 * --json` cron invocations are in flight at once, each its own process. A
 * single `appendFileSync` call is one `write(2)` syscall with `O_APPEND`;
 * POSIX guarantees that syscall atomic against other writers of the same
 * file on a local filesystem (ext4/xfs — this is not NFS), so two processes'
 * lines can interleave only at a line boundary, never WITHIN a line. Rows are
 * clamped (`MAX_WHY_CHARS`) to stay comfortably under 4096 bytes (`PIPE_BUF`
 * on Linux) as a second, more conservative bound — the same one
 * `decision-log.ts` and `job-history-store.ts` already lean on for their own
 * single-writer `appendFileSync` calls, just insisted on here explicitly
 * because this file's writers are not single. No lock file: a lock would
 * serialize two things that do not need to be serialized (an append and a
 * concurrent prune), and the prune below is itself written to tolerate racing
 * with another process's prune (see `pruneJobRunDir`).
 *
 * RETENTION: {@link JOB_RUN_RETENTION_DAYS} = 90 days, by whole day file —
 * long enough to answer "did the nightly gates run last month" (plan §7.2)
 * with margin, short enough that even the busiest expected cadence here (the
 * hosting converger, every 5 minutes) stays a few tens of MB over the window.
 * No byte cap: unlike `decision-log.ts`'s refusal-table rows, a job-run row is
 * small and fixed-shape, and the measured worst case (~1,000 rows/day across
 * every registered job, a few hundred bytes each) is nowhere near a cap this
 * store would ever need to reason about.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { listDayFilesSince, readDayFiles } from './day-file-list.js';
import { JOB_REGISTRY, type JobEntry, type JobKind } from './lib/job-registry.js';

export const JOB_RUN_SCHEMA = 1;
/** The directory name under a `stateDir()`-shaped root. */
export const JOB_RUN_DIR = 'job-runs';
export const JOB_RUN_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;
/** `run-<day>.jsonl` — deliberately NOT the same source text as decision-log's
 * `^(\d{4}-\d{2}-\d{2})\.jsonl$` or usage-store's `^usage-...$`: the F3
 * one-writer guard (`f3-one-writer.test.mjs`) keys a per-period pattern by its
 * exact regex SOURCE text, scanned across every file, so reusing either one
 * verbatim would read as a SECOND writer of their declared pattern rather
 * than registering a new one of this module's own. */
const DAY_FILE = /^run-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** Keeps a row comfortably under PIPE_BUF (4096B) even with a long `why`. */
const MAX_WHY_CHARS = 300;

export type JobRunVerdict = 'ok' | 'findings' | 'error' | 'could-not-look';
const VERDICTS: ReadonlySet<string> = new Set<JobRunVerdict>([
	'ok',
	'findings',
	'error',
	'could-not-look',
]);

/** One completed run of a registry job (plan §7.3 T7's own field list). */
export interface JobRunRow {
	v: typeof JOB_RUN_SCHEMA;
	/** The registry job's `name` (in-process) or the cron's `FLEET_CALLER`. */
	job: string;
	startedAt: string;
	durationMs: number;
	kind: JobKind;
	verdict: JobRunVerdict;
	/** A finding/unconverged/deferred count, or `null` when the job's own
	 *  report carries no such count (a recorder; an in-process converger
	 *  tick, which does not plumb one through `finishTick` today). */
	findings: number | null;
	/** A short reason, or `null` for a clean `ok`. Clamped to {@link MAX_WHY_CHARS}. */
	why: string | null;
	host: string;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function jobRunDir(root: string): string {
	return join(root, JOB_RUN_DIR);
}

/**
 * Is `caller` a registry job — directly, or as a `coversSubs` entry
 * discharged by an umbrella (`ci:audit-gates`)? Returns the KIND that
 * actually ran: for a covered sub this is the umbrella's own kind, since the
 * umbrella invocation is what executed, not a second clock of the sub's own.
 * `null` means "not a registry job" — the recording hook's signal to write
 * nothing, so a manual/operator run of `fleet <sub>` never pollutes the sink.
 */
export function registryKindFor(
	caller: string,
	registry: readonly JobEntry[] = JOB_REGISTRY
): JobKind | null {
	for (const e of registry) {
		if (e.name === caller) return e.kind;
		for (const c of e.coversSubs ?? []) if (c.sub === caller) return e.kind;
	}
	return null;
}

function clampWhy(why: string | null | undefined): string | null {
	if (!why) return null;
	return why.length > MAX_WHY_CHARS ? `${why.slice(0, MAX_WHY_CHARS - 1)}…` : why;
}

/** Builds a row from the pieces either caller has to hand. Never throws. */
export function buildRow(input: {
	job: string;
	startedAtMs: number;
	durationMs: number;
	kind: JobKind;
	verdict: JobRunVerdict;
	findings?: number | null;
	why?: string | null;
	host?: string;
}): JobRunRow {
	return {
		v: JOB_RUN_SCHEMA,
		job: input.job,
		startedAt: new Date(input.startedAtMs).toISOString(),
		durationMs: Math.max(0, Math.round(input.durationMs)),
		kind: input.kind,
		verdict: input.verdict,
		findings: input.findings ?? null,
		why: clampWhy(input.why),
		host: input.host ?? hostname(),
	};
}

/**
 * Drops day files older than `retentionDays`. Tolerates another process
 * racing to delete the SAME expired file: every writer prunes on its own
 * append (no single owner), so two of them reaching for the same stale file
 * at once is an expected shape, not a bug — the second `unlinkSync` sees
 * `ENOENT` and that is treated as success, not rethrown.
 */
export function pruneJobRunDir(
	dir: string,
	nowMs: number,
	retentionDays: number = JOB_RUN_RETENTION_DAYS
): string[] {
	if (!existsSync(dir)) return [];
	const oldest = utcDay(nowMs - retentionDays * DAY_MS);
	const removed: string[] = [];
	for (const f of readdirSync(dir)) {
		const m = DAY_FILE.exec(f);
		if (!m || m[1] >= oldest) continue;
		try {
			unlinkSync(join(dir, f));
			removed.push(f);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
		}
	}
	return removed;
}

/**
 * Appends one row under `dir`. NEVER THROWS: a sink outage must not turn a
 * converger tick, or a cron's own `--json` exit, into a failure that was
 * never the job's own finding. Callers decide whether/how to say so (`job-
 * runner.ts` has a logger; `emit.mjs` stays silent — see its own comment).
 */
export function appendJobRun(row: JobRunRow, dir: string): { ok: boolean; why?: string } {
	try {
		mkdirSync(dir, { recursive: true });
		pruneJobRunDir(dir, Date.now());
		const day = utcDay(Date.parse(row.startedAt));
		appendFileSync(join(dir, `run-${day}.jsonl`), `${JSON.stringify(row)}\n`);
		return { ok: true };
	} catch (err) {
		return { ok: false, why: err instanceof Error ? err.message : String(err) };
	}
}

function isJobRunRow(v: unknown): v is JobRunRow {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.job === 'string' &&
		typeof o.startedAt === 'string' &&
		Number.isFinite(Date.parse(o.startedAt)) &&
		typeof o.durationMs === 'number' &&
		typeof o.kind === 'string' &&
		typeof o.verdict === 'string' &&
		VERDICTS.has(o.verdict) &&
		(o.findings === null || typeof o.findings === 'number') &&
		(o.why === null || typeof o.why === 'string') &&
		typeof o.host === 'string'
	);
}

export interface JobRunFilter {
	job?: string;
	sinceMs?: number;
}

export interface JobRunRead {
	/** Newest first. */
	rows: JobRunRow[];
	/** Lines that did not parse as a row — a torn tail counts here, not fatal. */
	badLines: number;
	files: number;
	unreadable: { file: string; why: string }[];
}

/**
 * Every row with `startedAt >= sinceMs`, newest first, optionally narrowed to
 * one `job`. A missing directory reads as NO ROWS YET, not a throw — unlike
 * `decision-log.ts`'s "no log is not no decisions", a fresh job-run-store has
 * a genuinely normal empty state (nothing has completed since the last
 * deploy), and there is no wiring step whose absence this would need to catch.
 */
export function readJobRuns(dir: string, filter: JobRunFilter = {}): JobRunRead {
	const out: JobRunRead = { rows: [], badLines: 0, files: 0, unreadable: [] };
	if (!existsSync(dir)) return out;
	const sinceMs = filter.sinceMs ?? 0;
	const sinceDay = utcDay(sinceMs);
	const files = listDayFilesSince(dir, DAY_FILE, sinceDay);
	const { filesRead, unreadable } = readDayFiles(dir, files, (line) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			out.badLines++;
			return;
		}
		if (!isJobRunRow(parsed)) {
			out.badLines++;
			return;
		}
		const t = Date.parse(parsed.startedAt);
		if (t < sinceMs) return;
		if (filter.job !== undefined && parsed.job !== filter.job) return;
		out.rows.push(parsed);
	});
	out.files = filesRead;
	out.unreadable = unreadable;
	out.rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	return out;
}

function arrLen(v: unknown): number | null {
	return Array.isArray(v) ? v.length : null;
}

function firstReasonIn(v: unknown): string | null {
	if (!Array.isArray(v) || v.length === 0) return null;
	const first = v[0] as unknown;
	if (typeof first !== 'object' || first === null) return null;
	const o = first as Record<string, unknown>;
	if (typeof o.reason === 'string') return o.reason;
	if (typeof o.why === 'string') return o.why;
	return null;
}

/**
 * Classifies ANY `--json` payload `emit.mjs`'s `emit()` ever writes into one
 * of the four verdicts this store understands.
 *
 *   - `GateDoc`/`RecordDoc` carry `unreadable` (+ `GateDoc`'s `findings`).
 *   - `ConvergeDoc` carries `unreadable` + `unconverged`/`deferred` instead of
 *     `findings` — their combined length stands in for a finding count.
 *   - The json-exit-guard's OWN fallback shape, `{ok:false,error,exit}`
 *     (`emit.mjs`, for a script that crashed before reaching its own
 *     `emit()`), carries neither — "ran to completion and still produced
 *     nothing readable" is the SCRIPT's own fault, not an unreadable target,
 *     so this reads as `error`, never `could-not-look` (the same distinction
 *     `job-runner.ts`'s `classifyMissingDoc` draws between `broke` and
 *     `unavailable`).
 *
 * `unreadable` OUTRANKS a findings count (AGENTS.md: "I could not look" must
 * never render as "nothing is wrong" — and must not be out-voted by a real
 * finding on the part the job COULD read either): a doc with both still
 * reports `could-not-look`, carrying the findings count alongside it rather
 * than discarding it.
 */
export function classifyEmittedDoc(doc: unknown): {
	verdict: JobRunVerdict;
	findings: number | null;
	why: string | null;
} {
	if (typeof doc !== 'object' || doc === null) {
		return { verdict: 'error', findings: null, why: 'stdout was not a JSON object' };
	}
	const d = doc as Record<string, unknown>;
	const unreadableLen = arrLen(d.unreadable) ?? 0;
	const findingsLen = arrLen(d.findings);
	const convergeLen =
		d.unconverged !== undefined || d.deferred !== undefined
			? (arrLen(d.unconverged) ?? 0) + (arrLen(d.deferred) ?? 0)
			: null;
	const totalFindings = findingsLen ?? convergeLen;
	const docWhy = typeof d.why === 'string' && d.why ? d.why : null;

	if (unreadableLen > 0) {
		return {
			verdict: 'could-not-look',
			findings: totalFindings,
			why: docWhy ?? firstReasonIn(d.unreadable),
		};
	}
	if (totalFindings !== null) {
		if (totalFindings === 0) return { verdict: 'ok', findings: 0, why: null };
		const why =
			docWhy ??
			firstReasonIn(d.findings) ??
			firstReasonIn(d.unconverged) ??
			firstReasonIn(d.deferred);
		return { verdict: 'findings', findings: totalFindings, why };
	}
	if (d.ok === true) return { verdict: 'ok', findings: null, why: null };
	if (d.ok === false) {
		return {
			verdict: 'error',
			findings: null,
			why:
				typeof d.error === 'string' && d.error
					? d.error
					: (docWhy ?? 'ok:false with no findings/unreadable/error'),
		};
	}
	// No recognisable shape at all (no `ok`, no findings-like array): never
	// invent a finding the script itself did not report.
	return { verdict: 'ok', findings: null, why: null };
}
