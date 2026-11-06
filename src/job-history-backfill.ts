/**
 * Filling `failedStep`/`failedPhase` on job-history records that predate
 * 0.22.24, in the live window. Split out of `job-history-ingest.ts` (wave
 * shrink-1 lane C, pure move) to bring that file under the 600-line target.
 */
import { logger } from './host.js';
import { loadHistory, noteHistoryChanged, persistHistory, records } from './job-history-store.js';
import { type GhJob, stepFailure } from './job-history-phases.js';

/** What one {@link backfillFailedSteps} pass did. */
export interface BackfillReport {
	/** Records in the window that lacked `failedStep` and could be looked up. */
	candidates: number;
	/** Jobs actually fetched from GitHub this pass (bounded by `max`). */
	fetched: number;
	/** Records that gained a `failedStep`. */
	patched: number;
	/** Fetches GitHub answered with "no such job" — aged out, unrecoverable. */
	expired: number;
	/** Fetches that failed for any OTHER reason — retryable, unlike `expired`. */
	failed: number;
	/** True when the window was written back to disk. */
	persisted: boolean;
	/** Candidates left because `max` ran out — re-run to continue. */
	remaining: number;
}

/**
 * Fill `failedStep`/`failedPhase` on records that predate 0.22.24, IN THE LIVE
 * WINDOW, and persist through the one writer.
 *
 * WHY THIS IS A LIBRARY FUNCTION AND NOT A SCRIPT. `scripts/backfill-failed-steps.mjs`
 * did this correctly against the FILE — it even re-read immediately before
 * writing and refused to write if the file had moved under it. It still lost all
 * 502 records, because the race it guarded is not the race that exists: the
 * running mgmt-api does not read this file after boot, so the window it holds
 * had never heard of the patches, and its next `compactHistory()` wrote that
 * window over them. There is no file-level protocol that survives that. The only
 * way to durably change a record is to change the object the live process is
 * holding — which means running inside that process.
 *
 * `fetchJob` is injected for the same reason `ingestRuns` injects its fetcher:
 * the tests must not reach the network, and the caller owns the credential.
 * It returns null for "I could not look" and must distinguish that from a 404
 * via `expired`, because the two mean opposite things — an aged-out job is
 * permanently gone and a timeout is worth another pass.
 *
 * Idempotent: a record that already has `failedStep` is never a candidate, and a
 * job whose steps do not explain the failure is left alone rather than guessed,
 * so re-running costs only the fetches for what is still missing.
 */
export async function backfillFailedSteps(
	fetchJob: (repo: string, jobId: number) => Promise<{ job: GhJob | null; expired: boolean }>,
	opts: { max?: number; concurrency?: number } = {}
): Promise<BackfillReport> {
	// Read the window back first, exactly as `ingestRuns` does: a backfill that
	// ran before the first load would patch an empty window and then persist it
	// OVER the file, which is the very failure this function exists to prevent.
	loadHistory();
	const max = opts.max ?? 2000;
	const concurrency = Math.max(1, opts.concurrency ?? 5);

	const candidates = records.filter(
		(r) =>
			r.conclusion &&
			r.conclusion !== 'success' &&
			!r.failedStep &&
			typeof r.jobId === 'number' &&
			typeof r.startedAt === 'string' &&
			typeof r.durationSec === 'number' &&
			Number.isFinite(Date.parse(r.startedAt))
	);
	const toFetch = candidates.slice(0, max);

	let fetched = 0;
	let patched = 0;
	let expired = 0;
	let failed = 0;

	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < toFetch.length) {
			const rec = toFetch[next++];
			if (!rec) continue;
			const res = await fetchJob(rec.repo, rec.jobId);
			fetched++;
			if (!res.job) {
				if (res.expired) expired++;
				else failed++;
				continue;
			}
			const start = Date.parse(rec.startedAt);
			const end = start + rec.durationSec * 1000;
			// The record's OWN stored conclusion is the frame — a rerun since then
			// may have changed the job's live one, which is not what this record
			// described. Only the step data is being backfilled.
			const sf = stepFailure({ ...res.job, conclusion: rec.conclusion }, start, end);
			if (!sf) continue; // steps do not explain it either — left as it was, never guessed
			// Mutating the object the live window holds IS the mechanism. A copy
			// would be written once and then lost to the next compaction.
			Object.assign(rec, sf);
			noteHistoryChanged();
			patched++;
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, toFetch.length) }, worker));

	// Persist even when nothing was patched? No — an unconditional rewrite of an
	// unchanged window is pure risk for no gain. But when anything WAS patched the
	// write is mandatory, or the whole pass evaporates at the next restart.
	const persisted = patched > 0 ? persistHistory() : false;
	if (patched) {
		logger.info(
			`[job-history] backfill: ${patched} record(s) gained failedStep ` +
				`(fetched ${fetched}, expired ${expired}, failed ${failed}, persisted ${persisted})`
		);
	}
	return {
		candidates: candidates.length,
		fetched,
		patched,
		expired,
		failed,
		persisted,
		remaining: candidates.length - toFetch.length,
	};
}
