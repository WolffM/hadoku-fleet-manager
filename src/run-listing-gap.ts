/**
 * Runs that scrolled out of a repo's listing while runner-health could not
 * read it, found again once it can (fleet-manager#9, ask 3).
 *
 * WHY THIS EXISTS
 * ---------------
 * job-history learns about runs only from the `per_page=30` listing the
 * runner-health sweep already pays for. When the GitHub budget is spent, the
 * sweep is suppressed and reads nothing. A busy repo turns its 30 runs over in
 * well under an hour (hadoku_site has done ~84/h), so by the time the budget
 * refills, the runs completed during the blackout are past the end of the
 * listing and no later tick can see them. After 10-25 05:30Z, history-coverage
 * went red on exactly that hole: hadoku_site 15/42, task 27/38, watchparty
 * 24/31, tenhands 29/35. The coverage gate was right; the recorder had lost
 * them.
 *
 * HOW A GAP IS FOUND: FROM THE LISTINGS, NOT FROM THE BLACKOUT
 * ------------------------------------------------------------
 * A per-repo MARK is the newest run id every older run of which has been
 * listed at least once. A listing that is FULL and whose oldest id is still
 * newer than the mark may have runs between the two that nothing listed. A
 * short listing is the whole repo, and one that reaches the mark overlaps, so
 * neither has a gap. Run ids are monotonic per repo, which job-history's
 * oldest-first ordering already relies on.
 *
 * This does not ask why a gap opened. A blackout, a sweep that failed for any
 * other reason, and a controller that was down for an hour all leave the same
 * evidence, and the mark is persisted so a restart does not forget it.
 *
 * CLOSING IT
 * ----------
 * Pages 2, 3, … of the same listing, until a page reaches the mark, comes back
 * short, or holds nothing inside FRESH_HORIZON_H (nothing older is ingested
 * anyway). Each page is one charged call and only a gap costs any, so a
 * healthy tick costs nothing extra. `MAX_GAP_PAGES` bounds a gap at 180 runs.
 * A gap still open at that bound is given up and SAID, because the runs beyond
 * it are lost and the coverage gate will report them.
 *
 * A page that cannot be read leaves the mark where it was, so the next tick
 * pages again. The runs already recovered are kept.
 *
 * What is recovered is a BACKLOG, not an ingest. Its job fetches go through the
 * tick's shared `FetchBudget` like every other run's (30 per tick), as safe
 * runs, behind the listing's own at-risk tail: a backlog run is held here until
 * it ages past the horizon, while a listing's oldest runs can still be lost.
 * So a gap adds page calls, never extra job fetches per tick.
 *
 * Only COMPLETED runs are kept. A run still in progress on a gap page has no
 * jobs to record yet, and this module never re-reads a run, so it would sit in
 * the backlog with a stale status. Those are lost; a 48-hour backlog of
 * in-flight runs would be the cure, and a blackout leaves a handful at most.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger, stateDir } from './host.js';
import { FRESH_HORIZON_H, jobHistoryHasRun } from './job-history.js';
import { writeJsonAtomic } from './lib/atomic-json.js';

/** The listing's page size. runner-health asks for exactly this. */
export const LISTING_PAGE = 30;
/** Pages read back past the first before a gap is given up. */
export const MAX_GAP_PAGES = 6;
/** Backlog runs held per repo. A full gap is 180; this is headroom, not a target. */
const MAX_BACKLOG = 400;

/** Under `stateDir()`. */
export const LISTING_GAP_FILE = 'run-listing-marks.json';

/** The fields of a listed run that `ingestRuns` reads. */
export interface ListedRun {
	id?: number;
	status?: string;
	created_at?: string;
	updated_at?: string;
}

interface RepoMark {
	/** Every run at or below this id has been listed. */
	mark: number;
	backlog: ListedRun[];
}

const marks = new Map<string, RepoMark>();
let loaded = false;
let saveComplained = false;

const filePath = (): string => join(stateDir(), LISTING_GAP_FILE);

function load(): void {
	if (loaded) return;
	loaded = true;
	try {
		const raw = JSON.parse(readFileSync(filePath(), 'utf8')) as Record<string, RepoMark>;
		for (const [repo, m] of Object.entries(raw)) {
			if (typeof m?.mark !== 'number' || !Array.isArray(m.backlog)) continue;
			marks.set(repo, { mark: m.mark, backlog: m.backlog });
		}
	} catch (e) {
		if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return;
		// Starting without marks finds no gap until each repo is listed twice,
		// so a gap open across this restart goes unnoticed. Say so.
		logger.warn(
			`[job-history] could not restore ${filePath()}: ${e instanceof Error ? e.message : String(e)} — ` +
				'a listing gap open across this restart will not be backfilled'
		);
	}
}

function save(): void {
	const path = filePath();
	try {
		// Write-then-rename, fsync'd (F3, `lib/atomic-json.ts`).
		writeJsonAtomic(path, Object.fromEntries(marks));
	} catch (e) {
		if (saveComplained) return;
		saveComplained = true;
		logger.warn(
			`[job-history] could not persist ${path}: ${e instanceof Error ? e.message : String(e)} — ` +
				'a restart will forget any listing gap still open'
		);
	}
}

const idsOf = (runs: readonly ListedRun[]): number[] =>
	runs.map((r) => r.id).filter((id): id is number => typeof id === 'number');

const freshAt = (r: ListedRun): number => Date.parse(r.updated_at ?? r.created_at ?? '');

/**
 * Note the listing `repo` just returned, close any gap behind it with
 * `fetchPage(n)` (page `n` of the same listing, or null when it could not be
 * read), and return the repo's backlog: runs past the end of the listing that
 * job-history has not recorded yet.
 */
export async function closeListingGap(
	repo: string,
	listing: readonly ListedRun[],
	fetchPage: (page: number) => Promise<ListedRun[] | null>,
	now = Date.now()
): Promise<ListedRun[]> {
	load();
	const ids = idsOf(listing);
	const st = marks.get(repo);
	if (!ids.length) return st ? prune(repo, st, now) : [];
	const newest = Math.max(...ids);
	if (!st) {
		// First sight of this repo: nothing to compare against, so nothing is a gap.
		marks.set(repo, { mark: newest, backlog: [] });
		save();
		return [];
	}
	const startMark = st.mark;
	if (listing.length < LISTING_PAGE || Math.min(...ids) <= st.mark) {
		st.mark = Math.max(st.mark, newest);
		if (st.mark !== startMark) save();
		return prune(repo, st, now);
	}

	const horizon = now - FRESH_HORIZON_H * 3600_000;
	const recovered: ListedRun[] = [];
	let outcome: 'closed' | 'unread' | 'abandoned' = 'abandoned';
	let pages = 0;
	for (let page = 2; page <= MAX_GAP_PAGES + 1; page++) {
		const rows = await fetchPage(page);
		if (!rows) {
			outcome = 'unread';
			break;
		}
		pages++;
		recovered.push(...rows.filter((r) => typeof r.id === 'number' && r.id > st.mark));
		const pageIds = idsOf(rows);
		if (
			rows.length < LISTING_PAGE ||
			pageIds.some((id) => id <= st.mark) ||
			rows.every((r) => freshAt(r) < horizon)
		) {
			outcome = 'closed';
			break;
		}
	}
	const known = new Set(idsOf(st.backlog));
	const added = recovered.filter(
		(r) => r.status === 'completed' && !known.has(r.id!) && !jobHistoryHasRun(r.id!)
	);
	st.backlog.push(...added);
	const msg =
		`[job-history] ${repo}: the listing skipped past run ${startMark}; read ${pages} more page(s), ` +
		`${added.length} unrecorded run(s) queued for backfill`;
	if (outcome === 'unread') {
		logger.warn(`${msg}. A page could not be read, so the gap stays open for the next tick`);
	} else {
		st.mark = Math.max(st.mark, newest);
		if (outcome === 'closed') logger.info(msg);
		else
			logger.warn(
				`${msg}. Still not closed after ${MAX_GAP_PAGES} pages: older runs in the gap are lost, ` +
					'and history-coverage will count them'
			);
	}
	save();
	return prune(repo, st, now);
}

/** Drop what has been recorded or aged out, and cap the rest. Returns what is left. */
function prune(repo: string, st: RepoMark, now: number): ListedRun[] {
	const horizon = now - FRESH_HORIZON_H * 3600_000;
	const before = st.backlog.length;
	st.backlog = st.backlog.filter((r) => !jobHistoryHasRun(r.id!) && !(freshAt(r) < horizon));
	if (st.backlog.length > MAX_BACKLOG) {
		const dropped = st.backlog.length - MAX_BACKLOG;
		st.backlog.sort((a, b) => b.id! - a.id!).length = MAX_BACKLOG;
		logger.warn(
			`[job-history] ${repo}: backfill backlog over ${MAX_BACKLOG}; ${dropped} oldest dropped`
		);
	}
	if (st.backlog.length !== before) save();
	return [...st.backlog];
}

/** Test seam. Not part of the supported API. */
export function __resetListingGapForTesting(): void {
	marks.clear();
	loaded = false;
	saveComplained = false;
}
