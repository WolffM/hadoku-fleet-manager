/**
 * The job-history index: figures over the window, kept current as the window
 * changes instead of re-derived by scanning it (fleet-manager#86, private plan
 * `history-index-2026-11-16.md`).
 *
 * WHY. The dispatcher asked two questions of the whole ~27k-record window on
 * every tick: when did each node last finish a job, and how many jobs a day does
 * each repo run. Each answer was a fresh scan that parsed every `startedAt` and
 * ran `nodeOf` (a prefix match over every node name) on every record: 656 ms and
 * 396 ms of mgmt-api's event loop per 10 minutes on the 2026-11-15 leader, 72 %
 * of all time spent reading the history.
 *
 * HOW IT STAYS RIGHT. `job-history-store.ts` is the only thing that changes the
 * window, and it reports every change (`onHistoryChange`): records added,
 * records removed, a record patched, or the window replaced wholesale. Each
 * figure here is built from `jobRecords()` the first time it is asked for,
 * then moved by those reports. Nothing here guesses or expires: a figure is
 * either built from the window or dropped and rebuilt.
 *
 * EVERY FIGURE IS A SORTED MULTISET, so removing a record is exact: the value
 * it contributed is found and taken out, and the newest end or the oldest start
 * is read off one end. No "recompute if the evicted one was the max" path.
 *
 * The pure functions over a record list (`idleSecondsFromRecords` in
 * `job-history-stats.ts`) stay: the CLI has no host and reads the JSONL itself,
 * and `job-history-index.test.ts` holds this module equal to them.
 */
import { jobRecords, onHistoryChange, type JobRecord } from './job-history-store.js';
import { jobKind } from './lib/job-kind.js';
import { nodeOf } from './runners/census.js';

/**
 * When a job FINISHED, in epoch ms. `NaN` when its start stamp is unusable.
 *
 * STATED ONCE, because two different questions need it and one of them is a
 * trap. `idleSecondsFromRecords` wants it because a node three seconds into a
 * two-hour job is not idle. `summarise`'s trailing window wants it because
 * cutting that window on `startedAt` would make the measure GET BETTER THE
 * WORSE THE FAILURE GETS — a job that ran three hours and finished a minute ago
 * started three hours ago, so a start-time window drops precisely the slowest
 * jobs, and the slower they get the more certainly they fall out. That is the
 * `queue-health` one-hour-ceiling trap in a new place: an excluded category
 * that a real failure MANUFACTURES. Windowing on completion means every job
 * enters the window exactly once, at the moment it lands, whatever it cost.
 *
 * `durationSec` is added rather than trusted from a second field because it is
 * the only end-of-job figure a record carries.
 */
export function finishedAtMs(r: Readonly<JobRecord>): number {
	return Date.parse(r.startedAt) + (r.durationSec ?? 0) * 1000;
}

/** Insert `v` into ascending `xs`, keeping it sorted. */
function insertSorted(xs: number[], v: number): void {
	let lo = 0;
	let hi = xs.length;
	// Appends are nearly always the newest, so check the end first.
	if (!hi || xs[hi - 1] <= v) {
		xs.push(v);
		return;
	}
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (xs[mid] <= v) lo = mid + 1;
		else hi = mid;
	}
	xs.splice(lo, 0, v);
}

/** Remove one `v` from ascending `xs`. False when it is not there. */
function removeSorted(xs: number[], v: number): boolean {
	let lo = 0;
	let hi = xs.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (xs[mid] < v) lo = mid + 1;
		else hi = mid;
	}
	if (lo >= xs.length || xs[lo] !== v) return false;
	xs.splice(lo, 1);
	return true;
}

const DAY_MS = 86_400_000;

/**
 * What every reader of a record derives from it, derived once per record and
 * node list: its node (`nodeOf`, a prefix match over every node name), its
 * kind (`jobKind`), when it finished and its UTC day. The fold and the speed
 * model each used to derive these themselves on every rebuild; the fold kept
 * them in a WeakMap re-checked against five fields on every hit, to catch a
 * record edited in place. Here a row is derived when its record arrives and
 * re-derived when the store reports a patch, so it is never stale.
 */
export interface HistoryRow {
	r: Readonly<JobRecord>;
	node: string;
	/** Completion in epoch ms ({@link finishedAtMs}); NaN when the start will not parse. */
	finished: number;
	/** Days since the epoch, UTC, by `startedAt`; NaN when it will not parse. */
	day: number;
	kind: string;
}

function deriveRow(r: Readonly<JobRecord>, nodes: readonly string[]): HistoryRow {
	const start = Date.parse(r.startedAt);
	return {
		r,
		node: nodeOf(r.runner, nodes),
		finished: start + (r.durationSec ?? 0) * 1000,
		day: Math.floor(start / DAY_MS),
		kind: jobKind(r.name),
	};
}

/**
 * Rows and job ends per node, for ONE node list. `nodeOf` answers relative to
 * the list it is given (an unlisted node's runners stay unattributed), so both
 * belong to the list. Callers pass the nodes they mean (the dispatcher's
 * minting nodes, the fleet report's, the manifest's), each the same list
 * tick after tick until a node comes or goes, so a handful are held and the
 * least recently asked is dropped.
 */
interface ListState {
	nodes: readonly string[];
	rows: Map<Readonly<JobRecord>, HistoryRow>;
	ends: Map<string, number[]>;
}
const MAX_LISTS = 4;
const byList = new Map<string, ListState>();

/** Starts (ms, finite only) in ascending order, and records per repo. */
let starts: number[] | null = null;
let perRepo: Map<string, number> | null = null;
/** Records in the window: `perRepo`'s total, which an empty window must report as such. */
let held = 0;

function addRow(list: ListState, r: Readonly<JobRecord>): void {
	const row = deriveRow(r, list.nodes);
	list.rows.set(r, row);
	if (!Number.isFinite(row.finished)) return;
	let xs = list.ends.get(row.node);
	if (!xs) list.ends.set(row.node, (xs = []));
	insertSorted(xs, row.finished);
}

/** Take out what `r` added, by the row derived when it was added. */
function removeRow(list: ListState, r: Readonly<JobRecord>): void {
	const row = list.rows.get(r);
	if (!row) return;
	list.rows.delete(r);
	if (!Number.isFinite(row.finished)) return;
	const xs = list.ends.get(row.node);
	if (!xs || !removeSorted(xs, row.finished)) return;
	if (!xs.length) list.ends.delete(row.node);
}

function addRepo(r: Readonly<JobRecord>): void {
	if (!perRepo || !starts) return;
	perRepo.set(r.repo, (perRepo.get(r.repo) ?? 0) + 1);
	held++;
	const t = Date.parse(r.startedAt);
	if (Number.isFinite(t)) insertSorted(starts, t);
}

function removeRepo(r: Readonly<JobRecord>): void {
	if (!perRepo || !starts) return;
	const n = (perRepo.get(r.repo) ?? 0) - 1;
	if (n > 0) perRepo.set(r.repo, n);
	else perRepo.delete(r.repo);
	held--;
	const t = Date.parse(r.startedAt);
	if (Number.isFinite(t)) removeSorted(starts, t);
}

onHistoryChange((c) => {
	switch (c.kind) {
		case 'reset':
			byList.clear();
			starts = null;
			perRepo = null;
			held = 0;
			return;
		case 'added':
			for (const r of c.records) {
				for (const list of byList.values()) addRow(list, r);
				addRepo(r);
			}
			return;
		case 'removed':
			for (const r of c.records) {
				for (const list of byList.values()) removeRow(list, r);
				removeRepo(r);
			}
			return;
		case 'patched':
			// The row held for this record is the one derived BEFORE the patch,
			// so removing by it takes out exactly what it added.
			for (const list of byList.values()) {
				removeRow(list, c.after);
				addRow(list, c.after);
			}
			removeRepo(c.before);
			addRepo(c.after);
			return;
	}
});

function listFor(nodes: readonly string[]): ListState {
	const key = nodes.join('\n');
	let list = byList.get(key);
	if (list) {
		// Re-inserted, so Map order is ask order and the first key is the stalest.
		byList.delete(key);
		byList.set(key, list);
		return list;
	}
	const window = jobRecords(); // loads first: a load resets, then this builds
	list = { nodes: [...nodes], rows: new Map(), ends: new Map() };
	for (const r of window) addRow(list, r);
	byList.set(key, list);
	if (byList.size > MAX_LISTS) byList.delete(byList.keys().next().value as string);
	return list;
}

/**
 * `r`'s row over `nodes`: the held one for a record in the window, derived on
 * the spot (and not kept) for any other, e.g. a test's or a script's own list.
 */
export function historyRowOf(r: Readonly<JobRecord>, nodes: readonly string[]): HistoryRow {
	return listFor(nodes).rows.get(r) ?? deriveRow(r, nodes);
}

/**
 * Seconds since each node last FINISHED a job, from observed history.
 *
 * The second half of `carousel`. Ordering on `busy` alone spreads CONCURRENT
 * work and nothing else: with the fleet idle every node ties at zero, the sort
 * falls through to ladder order, and every sequential job lands on whichever
 * node the manifest lists first. Measured 2026-09-02 — hadoku-pygmalion's test
 * job went to claw-2 on attempt 1 and attempt 2, which is what made a flaky
 * timing test look like a broken node and vice versa.
 *
 * Derived, never counted. `traffic.ts` is explicit that a cursor is a
 * DECLARATION that drifts from what happened — a restart resets it, a job that
 * failed to start still advanced it. This reads what the fleet DID: the end of
 * the most recent job each node served.
 *
 * A node with no history is ABSENT from the map rather than 0 or Infinity.
 * `orderCandidates` reads a missing value as "unmeasured" and sorts it last
 * among equals, which is the right weight for a node nothing is known about —
 * guessing it idle would hand it every placement.
 *
 * Equal to `idleSecondsFromRecords(jobRecords(), nodes, now)`, read from the
 * index rather than a scan of the window.
 */
export function idleSecondsByNode(nodes: readonly string[], now = Date.now()): Map<string, number> {
	const out = new Map<string, number>();
	for (const [node, xs] of listFor(nodes).ends) {
		out.set(node, Math.max(0, Math.round((now - xs[xs.length - 1]) / 1000)));
	}
	return out;
}

/**
 * Jobs per day per repo across the window: each repo's record count over the
 * days since the oldest parseable start (at least one day). Empty for an
 * empty window. Feeds the dispatcher's hot/cold poll split.
 */
export function jobsPerDayByRepo(now = Date.now()): Map<string, number> {
	const window = jobRecords();
	if (!perRepo || !starts) {
		perRepo = new Map();
		starts = [];
		held = 0;
		for (const r of window) addRepo(r);
	}
	const out = new Map<string, number>();
	if (!held) return out;
	const oldest = starts.length ? starts[0] : Infinity;
	const days = Math.max(1, (now - oldest) / 86_400_000);
	for (const [repo, n] of perRepo) out.set(repo, n / days);
	return out;
}
