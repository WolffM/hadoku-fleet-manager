/**
 * WHEN GITHUB QUEUED A JOB, as its `workflow_job` `queued` delivery said.
 *
 * GitHub's API has no such field. A job held by a job-level `concurrency`
 * group is listed `pending` until the group releases it, then `queued`, and
 * through both its `created_at` (and `started_at`) stay at the moment it was
 * created. Measured 2026-11-22 on hadoku_site job 137323873295: `pending`
 * 19:19:31-19:22:49, then `queued`, with `created_at` 19:19:31 throughout; the
 * check-run API says the same. The `queued` delivery is the only record of
 * the release.
 *
 * `ci:queue-health` aged jobs from `created_at`, so a job the fleet received
 * seconds ago read as however long its group held it. tsunami-surfer's browser
 * parts wait on the previous push's parts (`check-browser-<n>-<ref>`, since
 * 2026-11-20): on 11-22 they were held 304-1,673 s, the fleet started each
 * within ~10 s-4.7 min of its delivery, and the gate reported them as runs
 * "waiting for a runner past the dispatcher's pending pass" 7 times that day.
 * Across 6,241 jobs 11-19..11-22, 48 crossed the 300 s floor ONLY on held time.
 *
 * STORAGE: one JSONL file per UTC day, `<stateDir>/job-queued/queued-<day>.jsonl`, appended
 * one row per accepted delivery. Both mgmt-api processes of the HA pair receive
 * deliveries and append to the same file; O_APPEND keeps their rows whole, and
 * the reader keeps the EARLIEST receipt per job, so a second or a re-queued
 * delivery can only make a job older. Two days are kept: a hold measured in
 * hours, not days, is what this answers.
 *
 * WHAT THIS CAN AND CANNOT HIDE. The reader credits a job with
 * `receipt - created_at` and nothing more. A missing row (no delivery, the
 * webhook down, mgmt-api not running, the file unreadable) credits nothing, so
 * the gate falls back to `created_at`: the strict direction. A receipt that
 * lags GitHub's real queue moment (a slow delivery, or mgmt-api's event loop
 * stalled) makes the gate go red that much LATER, never not at all: the job's
 * age still runs from the receipt.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../host.js';
import { listDayFilesSince, readDayFiles } from '../day-file-list.js';

export const JOB_QUEUED_DIR = 'job-queued';
/** Today and yesterday. */
export const JOB_QUEUED_RETENTION_DAYS = 2;

const DAY_MS = 86_400_000;
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** `queued-<day>.jsonl` — this file's own regex SOURCE text; see `day-file-list.ts`. */
const QUEUED_DAY_FILE = /^queued-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function jobQueuedDir(root: string): string {
	return join(root, JOB_QUEUED_DIR);
}

export interface JobQueuedRow {
	job: number;
	repo: string;
	/** Receipt of the `queued` delivery, ISO. */
	at: string;
}

let prunedDay: string | null = null;

/** Test seam: forget which day was last pruned. */
export function __resetJobQueuedLogForTesting(): void {
	prunedDay = null;
}

/** Drop day files older than the retention window. Returns the names removed. */
export function pruneJobQueuedLog(dir: string, nowMs: number): string[] {
	if (!existsSync(dir)) return [];
	const keepFrom = utcDay(nowMs - (JOB_QUEUED_RETENTION_DAYS - 1) * DAY_MS);
	const removed: string[] = [];
	for (const f of readdirSync(dir)) {
		const m = QUEUED_DAY_FILE.exec(f);
		if (m && m[1] < keepFrom) {
			unlinkSync(join(dir, f));
			removed.push(f);
		}
	}
	return removed;
}

/** Append one delivery's row; prunes old days on the first append of a day. */
export function appendJobQueued(
	row: { jobId: number; repo: string; receivedAtMs: number },
	root: string = stateDir()
): void {
	const dir = jobQueuedDir(root);
	const day = utcDay(row.receivedAtMs);
	if (prunedDay !== day) {
		pruneJobQueuedLog(dir, row.receivedAtMs);
		prunedDay = day;
	}
	mkdirSync(dir, { recursive: true });
	const rec: JobQueuedRow = {
		job: row.jobId,
		repo: row.repo,
		at: new Date(row.receivedAtMs).toISOString(),
	};
	appendFileSync(join(dir, `queued-${day}.jsonl`), JSON.stringify(rec) + '\n');
}

export interface JobQueuedRead {
	/** Job id → earliest receipt, epoch ms. */
	queuedAt: Map<number, number>;
	/** Lines that did not parse into a row (a torn tail): counted, skipped. */
	torn: number;
	/** Files that could not be read, with the reason. */
	unreadable: string[];
	/** `false` when the directory does not exist (no delivery recorded yet). */
	present: boolean;
}

/**
 * Every recorded receipt in the retention window. `root` is the state dir: a
 * standalone script passes `fleet-paths.ts#stateDir()`, the same directory
 * mgmt-api hands its host.
 */
export function readJobQueued(nowMs: number, root: string): JobQueuedRead {
	const dir = jobQueuedDir(root);
	const res: JobQueuedRead = { queuedAt: new Map(), torn: 0, unreadable: [], present: false };
	if (!existsSync(dir)) return res;
	res.present = true;
	const since = utcDay(nowMs - (JOB_QUEUED_RETENTION_DAYS - 1) * DAY_MS);
	const files = listDayFilesSince(dir, QUEUED_DAY_FILE, since);
	const read = readDayFiles(dir, files, (line) => {
		let row: Partial<JobQueuedRow>;
		try {
			row = JSON.parse(line) as Partial<JobQueuedRow>;
		} catch {
			res.torn++;
			return;
		}
		const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
		if (typeof row.job !== 'number' || !Number.isFinite(at)) {
			res.torn++;
			return;
		}
		const prev = res.queuedAt.get(row.job);
		if (prev === undefined || at < prev) res.queuedAt.set(row.job, at);
	});
	res.unreadable = read.unreadable.map((u) => `${u.file}: ${u.why}`);
	return res;
}
