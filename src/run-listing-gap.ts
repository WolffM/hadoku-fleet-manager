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
 * SETTLED: listed once completed, and fetched or queued for backfill (#52; it
 * was "listed at least once" until 2026-11-03, which lost every run listed in
 * progress that scrolled off before it finished — see settledThrough). A
 * listing that is FULL and whose oldest id is still newer than the mark may
 * have runs between the two that nothing settled. A
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
 * the backlog with a stale status. It HOLDS THE MARK instead, so a later tick
 * pages back to it again and finds it completed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger, stateDir } from './host.js';
import { FRESH_HORIZON_H } from './job-history-ingest.js';
import { jobHistoryHasRun } from './job-history-store.js';
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
	/**
	 * Every run at or below this id has been SETTLED: listed once it was
	 * completed and either fetched by ingest or queued in the backlog. Not merely
	 * listed — see {@link settledThrough}.
	 */
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
 * The newest id the mark may advance to: just below the oldest UNSETTLED fresh
 * run in `rows`, or `newest` when every one is settled (#52).
 *
 * The mark used to advance to the newest id LISTED. A run listed while still in
 * progress, or completed but left unfetched when the tick's budget ran out, was
 * then below the mark. If it scrolled off page 1 before the next tick, the gap
 * pages, which collect only ids above the mark, never looked at it again. On
 * 2026-11-03 07:33-08:11Z a hadoku_site burst (116 runs in two hours, three
 * mgmt-api restarts stretching the ticks) lost 23 recordable runs that way, and
 * history-coverage read 61/82. Run 41598893060 ran 07:49-08:02: in progress at
 * the tick that set the mark to 41599240436, off page 1 by the 08:03 tick.
 *
 * Unsettled: not completed, or completed and neither fetched by ingest nor
 * already in the backlog. Holding the mark at one makes its scrolling off a gap,
 * and the gap pages then find it completed. Only runs CREATED inside
 * FRESH_HORIZON_H hold: a run queued since August must not pin the mark (and the
 * paging it costs) forever, and nothing older is ingested anyway. An undated
 * run does not hold either, for the same reason.
 */
function settledThrough(
	rows: readonly ListedRun[],
	newest: number,
	backlog: ReadonlySet<number>,
	now: number
): number {
	const horizon = now - FRESH_HORIZON_H * 3600_000;
	let hold = Infinity;
	for (const r of rows) {
		if (typeof r.id !== 'number' || r.id >= hold) continue;
		const created = Date.parse(r.created_at ?? '');
		if (!Number.isFinite(created) || created < horizon) continue;
		const unsettled = r.status !== 'completed' || (!jobHistoryHasRun(r.id) && !backlog.has(r.id));
		if (unsettled) hold = r.id;
	}
	return Math.min(newest, hold - 1);
}

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
		marks.set(repo, { mark: settledThrough(listing, newest, new Set(), now), backlog: [] });
		save();
		return [];
	}
	const startMark = st.mark;
	// `+ 1`: a held mark sits just below the run that holds it, so a listing
	// that still shows that run overlaps. Ids are unique integers; nothing else
	// can be mark + 1.
	const reaches = (id: number) => id <= st.mark + 1;
	if (listing.length < LISTING_PAGE || ids.some(reaches)) {
		st.mark = Math.max(st.mark, settledThrough(listing, newest, new Set(idsOf(st.backlog)), now));
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
			pageIds.some(reaches) ||
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
	const settled = settledThrough(
		[...listing, ...recovered],
		newest,
		new Set(idsOf(st.backlog)),
		now
	);
	const msg =
		`[job-history] ${repo}: the listing skipped past run ${startMark}; read ${pages} more page(s), ` +
		`${added.length} unrecorded run(s) queued for backfill`;
	if (outcome === 'unread') {
		logger.warn(`${msg}. A page could not be read, so the gap stays open for the next tick`);
	} else {
		st.mark = Math.max(st.mark, settled);
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
