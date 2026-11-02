import {
	jobRecords,
	loadHistory,
	records,
	RETENTION_DAYS,
	type JobRecord,
} from './job-history-store.js';
import { jobKind } from './lib/job-kind.js';

/**
 * The TRAILING window the `recent*` figures on {@link NodeJobStats} are cut
 * over, relative to the moment the summary is taken.
 *
 * A TIME window, never "the last N records". `recent` below is the last 40
 * records, and that figure silently changes meaning with fleet load: 40 records
 * is minutes on a busy fleet and days on a quiet one, so a percentile cut over
 * them answers a different question every time it is asked. An hour is an hour.
 *
 * One hour because the question it exists for — issue #18, "is the fleet slower
 * than usual RIGHT NOW" — is asked against a 14-day baseline that is already on
 * the wire beside it. Both travel: the trailing figure does not replace the
 * full-window one, it is the thing the full-window one is the baseline FOR.
 */
export const RECENT_WINDOW_MS = 60 * 60 * 1000;

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
 */
export function idleSecondsByNode(nodes: readonly string[], now = Date.now()): Map<string, number> {
	return idleSecondsFromRecords(jobRecords(), nodes, now);
}

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
export function finishedAtMs(r: JobRecord): number {
	return Date.parse(r.startedAt) + (r.durationSec ?? 0) * 1000;
}

/**
 * The rule itself, over records the caller supplies.
 *
 * Split out so `fleet traffic` can preview the order the DISPATCHER will
 * actually use. That command reimplemented the sort under a comment claiming it
 * "mirrors runners/traffic.ts exactly", with a parenthesis conceding idle was
 * "unknown here, so ladder order breaks the tie" — so the moment carousel was
 * switched on, the preview printed the ladder while the fleet rotated. A
 * diagnostic that disagrees with the thing it describes is worse than none.
 *
 * The CLI cannot call {@link idleSecondsByNode}: that reads `historyFile()`,
 * which resolves through the injected host, and a standalone script has no host.
 * It reads the JSONL itself and calls this, so the RULE stays stated once.
 */
export function idleSecondsFromRecords(
	records: readonly JobRecord[],
	nodes: readonly string[],
	now = Date.now()
): Map<string, number> {
	const out = new Map<string, number>();
	for (const r of records) {
		const node = nodeOf(r.runner, nodes);
		// End, not start: a node three seconds into a two-hour job is not idle.
		const ended = finishedAtMs(r);
		if (!Number.isFinite(ended)) continue;
		const prev = out.get(node);
		const idle = Math.max(0, Math.round((now - ended) / 1000));
		if (prev === undefined || idle < prev) out.set(node, idle);
	}
	return out;
}

export function median(xs: number[]): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function percentile(xs: number[], p: number): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	// Nearest-rank, clamped. Exact interpolation is false precision on a sample
	// this small, and the panel renders it as a rounded number of seconds.
	const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
	return s[idx];
}

/**
 * Which node owns a runner. Re-exported from runners/census.ts, which is the
 * single implementation — this file used to carry its own copy of the same
 * longest-prefix rule, and census.ts carried a DIFFERENT one.
 */
export { nodeOf } from './runners/census.js';
import { nodeOf } from './runners/census.js';

/**
 * The zone classifier (claw-floor-design-2026-09-07.md §5.5) — split to
 * `job-history-zone.ts` (wave shrink-1 lane C, pure move) to bring this file
 * under the 600-line target. Re-exported here so every existing importer of
 * `job-history-stats.js` compiles unchanged; imported (not just re-exported)
 * because `summarise`/`repoStats`/`dailyStats` below still call `failuresByZone`.
 */
export {
	classifyZone,
	isFleetKill,
	zoneOf,
	KNOWN_TTL_SEC,
	TTL_MATCH_SEC,
	type FailureZone,
	type ObservedZone,
	type ZoneInput,
} from './job-history-zone.js';
import { failuresByZone, type FailuresByZone } from './job-history-zone.js';
export { failuresByZone, type FailuresByZone };

export interface NodeJobStats {
	/**
	 * The node's name. The KEY stays `machine`: this shape is what
	 * `FleetMachineJobStats` describes on the `GET /fleet` wire, and the command
	 * station reads it by that name. See docs/VOCABULARY.md §"Where the rename
	 * stops" — the noun in code is `node`, the wire key is not renamed.
	 */
	machine: string;
	jobs: number;
	failures: number;
	/**
	 * THE SAME COUNT, SPLIT BY WHOSE HALF OF THE FENCE IT FELL ON.
	 *
	 * `failures` is a single number and a single number cannot say what to do.
	 * A node with 27 failures that are all the consumer's own test is a healthy
	 * node carrying a busy repo; a node with 3 that are all `Set up runner` is a
	 * box that cannot start a job. Both render identically today, and issue #3
	 * — "is claw-2 failing timing-sensitive jobs" — sat open for ten days
	 * partly because nothing on the wire could tell them apart without an
	 * operator re-deriving §5.5's classifier from `jobs.recent`.
	 *
	 * The buckets and the rule are {@link FailuresByZone} and {@link zoneOf}.
	 * The five sum to `failures` above; they are cut over the SAME full retained
	 * window, never the trailing hour.
	 *
	 * READ THE DENOMINATOR. These are counts, not rates, and the fleet's
	 * runner+seam rate is ~0.15 % — so at any one node's volume a single event
	 * moves the "rate" by more than any real difference between boxes. A
	 * consumer rendering a percentage here must render `jobs` beside it.
	 */
	failuresByZone: FailuresByZone;
	/**
	 * THE BASELINE. Cut over the whole retained window — {@link RETENTION_DAYS}
	 * days, thousands of records — which is what makes a percentile here worth
	 * anything at all.
	 *
	 * `null` only when this node served nothing in that window, which cannot
	 * happen for a node that has a row: a row exists because records exist.
	 */
	medianSec: number | null;
	p95Sec: number | null;
	/** Distinct repos served — how broadly this node is carrying the fleet. */
	repos: number;
	/**
	 * Jobs this node FINISHED inside the trailing {@link RECENT_WINDOW_MS}.
	 *
	 * A COUNT, so `0` is a real reading and means "we looked at the hour and
	 * this node completed nothing in it". The two percentiles beside it are the
	 * ones that must go `null` rather than 0 — see below.
	 */
	recentJobs: number;
	/**
	 * THE COMPARISON. The same two figures over the trailing window, beside the
	 * baseline rather than instead of it: the whole question is "is this node
	 * slower than usual", and one number cannot answer it.
	 *
	 * `null` WHENEVER `recentJobs` IS 0, AND NEVER 0. A percentile over zero
	 * samples is not a fast node, it is no data — the same rule the rest of this
	 * payload applies to an unprobed machine, one level down. A renderer must
	 * show "no data" for it; showing a 0 would draw a node that completed
	 * nothing all hour as the fastest box in the fleet.
	 *
	 * WHAT THESE CANNOT SEE, stated because a reader will otherwise assume they
	 * can: job history holds COMPLETED jobs only (`ingestRuns` skips anything
	 * not `status === 'completed'`), so a fleet where everything is queued or
	 * hung empties this window instead of reddening it. The figures that catch
	 * THAT are `fleet.queuedNow` / `oldestQueuedMin` / `longestRunningMin`, and
	 * a consumer must not read an empty trailing window as a healthy one. What
	 * this window does guarantee is the other half: a job that took three hours
	 * enters it in full the moment it lands, because the cut is on completion.
	 * @see finishedAtMs
	 */
	recentMedianSec: number | null;
	recentP95Sec: number | null;
}

/**
 * One repo's jobs over the retention window — the "which repo is the
 * problem" half of the Fleet panel, cut exactly like {@link NodeJobStats}
 * (same failure zones, same duration figures, same trailing hour) so the two
 * tables can be read against each other.
 */
export interface RepoJobStats {
	repo: string;
	jobs: number;
	failures: number;
	failuresByZone: FailuresByZone;
	/** Whole-job `durationSec`, the same figure `NodeJobStats` reports. */
	medianSec: number | null;
	p95Sec: number | null;
	/** Wait from creation to a runner picking it up; null when no record carries one. */
	queueP50Sec: number | null;
	queueP95Sec: number | null;
	/** The queue split: creation to a listener existing, and listener to assignment. */
	dispatchP50Sec: number | null;
	assignP50Sec: number | null;
	recentJobs: number;
	recentMedianSec: number | null;
	recentP95Sec: number | null;
	/** Where it actually ran, most jobs first. */
	machines: { machine: string; jobs: number }[];
	/** The slowest job KINDS (`jobKind`, so `forge-e2e (2)` folds into `forge-e2e`) by
	 *  p95, at most three, each with at least {@link SLOWEST_MIN_SAMPLES} runs. */
	slowest: { name: string; p95Sec: number; jobs: number }[];
}

/** Runs a job kind needs before it may appear in {@link RepoJobStats.slowest}. */
export const SLOWEST_MIN_SAMPLES = 3;

/**
 * One UTC day of the fleet — the "better or worse" half of the panel.
 *
 * NULL IS "NOTHING LOOKED", ZERO IS "LOOKED AND IT WAS EMPTY". A day before
 * the history's first record carries `jobs: null` and empty per-machine rows,
 * because the file had not started yet; a day after it with no jobs carries
 * `jobs: 0`. Medians and percentiles are null whenever there is nothing to
 * take them of.
 */
export interface DailyJobStats {
	/** `YYYY-MM-DD`, UTC, by `startedAt`. */
	day: string;
	jobs: number | null;
	failuresByZone: FailuresByZone | null;
	/** Whole-job `durationSec`. */
	runMedianSec: number | null;
	runP95Sec: number | null;
	queueMedianSec: number | null;
	queueP95Sec: number | null;
	/** Builder (non-pm2-host) jobs the backstop node served that day. */
	backstopJobs: number | null;
	/** `busySec` is the sum of `durationSec` — against `maxConcurrent × 86400` it is utilisation. */
	byMachine: { machine: string; jobs: number; busySec: number }[];
}

export interface JobHistorySummary {
	since: string | null;
	total: number;
	/** Per-node stats. Wire key — see NodeJobStats.machine. */
	byMachine: NodeJobStats[];
	byRepo: RepoJobStats[];
	/** Every UTC day of the retention window, oldest first, today included. */
	daily: DailyJobStats[];
	/** Builder jobs hokon absorbed — the "had to step in" number. */
	backstopJobs: number;
	backstopShare: number;
	/**
	 * The last 40 records, newest first, each carrying the node that served it.
	 *
	 * @see RecentJobRecord — a RECORD COUNT, unlike the `recent*` figures on
	 * `byMachine`, which are cut over a time window on purpose.
	 */
	recent: RecentJobRecord[];
	/**
	 * THE CLOCK THE `recent*` FIGURES WERE CUT AGAINST, on the wire so a reader
	 * never has to assume one.
	 *
	 * `recentSince` is the START of the trailing window — the summary was taken
	 * at `recentSince + recentWindowSec`, so both ends are recoverable. Present
	 * whether or not anything landed in the window: "we looked at this hour and
	 * it was empty" is a statement, and it needs the hour named to be one.
	 */
	recentSince: string;
	/** Length of that window in seconds. Derived from {@link RECENT_WINDOW_MS}. */
	recentWindowSec: number;
}

/**
 * A job record WITH the node that served it.
 *
 * `machine` is `nodeOf(runner, nodes)` and nothing else — the one
 * implementation, re-exported from `runners/census.ts` below. It is attached
 * HERE, at summarise time, rather than stored on the record: it is a pure
 * function of the runner name and the CURRENT node list, so storing it would
 * put a stale answer on disk that outlives a renamed or retired node, and
 * fourteen days of existing records carry no such field anyway.
 *
 * WHY IT HAS TO BE ON THE WIRE (issue #18). `runner` alone cannot be folded by
 * a consumer. It is `jit-claw-1-hadoku-conjure-j102671642063-r34413053817-...`
 * on a JIT node and `warm-claw-3-hadoku_site` on a warm one, and turning either
 * into `claw-1` needs `JIT_PREFIX`, `WARM_PREFIX`, `HOSTED_NAME` and the
 * longest-prefix rule — none of which this package publishes to a browser
 * bundle. So the command station rendered the raw string and could not relate
 * one of these 40 rows to the 8 `byMachine` rows above it. A sixth `nodeOf`
 * over there would have been the drift `vocabulary` exists to stop; this is the
 * answer travelling instead.
 */
export interface RecentJobRecord extends JobRecord {
	machine: string;
}

/**
 * `pm2-host` work is EXCLUDED from the backstop count. Those five infra
 * workflows always run on hokon by design, so counting them as "hokon stepped
 * in" would report a permanent, meaningless one-third share and bury the signal
 * that actually matters: builder work that the claws could not take.
 */
export function summarise(
	nodes: string[],
	backstopNode = 'hokon',
	history: JobRecord[] = (loadHistory(), records),
	// THE CLOCK, INJECTABLE AND READ EXACTLY ONCE.
	//
	// The trailing window is relative to when the summary is TAKEN, so `now` is
	// a parameter with a default rather than a `Date.now()` inside the loop:
	// a test that cannot pin it can only assert on a window that moves under it,
	// and a second read inside the fold would put two different windows in one
	// payload. `buildFleetReport` leaves it defaulted, which is what makes
	// `GET /fleet` report the hour up to the request.
	now: number = Date.now()
): JobHistorySummary {
	const recentFrom = now - RECENT_WINDOW_MS;
	const byNode = new Map<string, JobRecord[]>();
	for (const r of history) {
		const m = nodeOf(r.runner, nodes);
		pushTo(byNode, m, r);
	}
	const stats: NodeJobStats[] = [...byNode.entries()]
		.map(([node, rs]) => {
			const durations = rs.map((r) => r.durationSec);
			// COMPLETION, not start — see `finishedAtMs`. A record whose start stamp
			// will not parse yields NaN, and `NaN >= recentFrom` is false, so it is
			// left out of the trailing window rather than placed in it by guess. It
			// still counts in the baseline, which needs no clock.
			const recentDurations = rs
				.filter((r) => finishedAtMs(r) >= recentFrom)
				.map((r) => r.durationSec);
			return {
				machine: node,
				jobs: rs.length,
				failures: rs.filter((r) => r.conclusion !== 'success').length,
				// The SAME records the count above folds, split by zone. Computed here
				// rather than by a consumer because §5.5's classifier needs `failedStep`
				// and `failedPhase`, and `byMachine` is a rollup — the only place both
				// the records and the node attribution are in hand at once.
				failuresByZone: failuresByZone(rs),
				medianSec: median(durations),
				p95Sec: percentile(durations, 95),
				repos: new Set(rs.map((r) => r.repo)).size,
				recentJobs: recentDurations.length,
				// `median`/`percentile` already answer `null` for an empty sample, and
				// that is exactly the contract this field needs: no jobs in the hour is
				// NO DATA, never a fast node. Do not `?? 0` these.
				recentMedianSec: median(recentDurations),
				recentP95Sec: percentile(recentDurations, 95),
			};
		})
		.sort((a, b) => b.jobs - a.jobs);

	const builder = history.filter((r) => !r.labels.includes('pm2-host'));
	const backstopJobs = builder.filter((r) => nodeOf(r.runner, nodes) === backstopNode).length;
	const byRepo = repoStats(history, nodes, recentFrom);
	const daily = dailyStats(history, nodes, backstopNode, now);

	return {
		since: history.length
			? history.reduce((a, r) => (r.startedAt < a ? r.startedAt : a), history[0].startedAt)
			: null,
		total: history.length,
		byMachine: stats,
		byRepo,
		daily,
		backstopJobs,
		backstopShare: builder.length ? backstopJobs / builder.length : 0,
		// `machine` attached here, from the same `nodeOf` and the same node list
		// the rollup above folds with, so a row in `recent` and a row in
		// `byMachine` can never disagree about which box served what.
		recent: [...history]
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
			.slice(0, 40)
			.map((r) => ({ ...r, machine: nodeOf(r.runner, nodes) })),
		recentSince: new Date(recentFrom).toISOString(),
		recentWindowSec: RECENT_WINDOW_MS / 1000,
	};
}

/**
 * Append to a grouped list IN PLACE. The folds below grouped by spreading a
 * fresh copy per record, which is quadratic in a group's size — harmless at the
 * old 20,000-row cap, seconds of CPU per `GET /fleet` at the 200,000 budget.
 */
function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
	const xs = m.get(k);
	if (xs) xs.push(v);
	else m.set(k, [v]);
}

const nums = (xs: (number | undefined)[]): number[] =>
	xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

function repoStats(history: JobRecord[], nodes: string[], recentFrom: number): RepoJobStats[] {
	const byRepo = new Map<string, JobRecord[]>();
	for (const r of history) pushTo(byRepo, r.repo, r);
	return [...byRepo.entries()]
		.map(([repo, rs]) => {
			const durations = rs.map((r) => r.durationSec);
			const recent = rs.filter((r) => finishedAtMs(r) >= recentFrom).map((r) => r.durationSec);
			const queue = nums(rs.map((r) => r.queueSec));
			const machines = new Map<string, number>();
			for (const r of rs) {
				const m = nodeOf(r.runner, nodes);
				machines.set(m, (machines.get(m) ?? 0) + 1);
			}
			const kinds = new Map<string, number[]>();
			for (const r of rs) {
				const k = jobKind(r.name);
				pushTo(kinds, k, r.durationSec);
			}
			const slowest = [...kinds.entries()]
				.filter(([, ds]) => ds.length >= SLOWEST_MIN_SAMPLES)
				.map(([name, ds]) => ({ name, p95Sec: percentile(ds, 95) ?? 0, jobs: ds.length }))
				.sort((a, b) => b.p95Sec - a.p95Sec)
				.slice(0, 3);
			return {
				repo,
				jobs: rs.length,
				failures: rs.filter((r) => r.conclusion !== 'success').length,
				failuresByZone: failuresByZone(rs),
				medianSec: median(durations),
				p95Sec: percentile(durations, 95),
				queueP50Sec: median(queue),
				queueP95Sec: percentile(queue, 95),
				dispatchP50Sec: median(nums(rs.map((r) => r.dispatchSec))),
				assignP50Sec: median(nums(rs.map((r) => r.assignSec))),
				recentJobs: recent.length,
				recentMedianSec: median(recent),
				recentP95Sec: percentile(recent, 95),
				machines: [...machines.entries()]
					.map(([machine, jobs]) => ({ machine, jobs }))
					.sort((a, b) => b.jobs - a.jobs),
				slowest,
			};
		})
		.sort((a, b) => b.jobs - a.jobs);
}

const DAY_MS = 86_400_000;
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function dailyStats(
	history: JobRecord[],
	nodes: string[],
	backstopNode: string,
	now: number
): DailyJobStats[] {
	const byDay = new Map<string, JobRecord[]>();
	for (const r of history) {
		const ms = Date.parse(r.startedAt);
		if (!Number.isFinite(ms)) continue;
		const d = utcDay(ms);
		pushTo(byDay, d, r);
	}
	const firstDay = byDay.size ? [...byDay.keys()].sort()[0] : null;
	const today = Date.parse(`${utcDay(now)}T00:00:00Z`);
	const out: DailyJobStats[] = [];
	for (let i = RETENTION_DAYS; i >= 0; i--) {
		const day = utcDay(today - i * DAY_MS);
		// Before the file's first record nothing was looking; after it, an empty
		// day is a real zero.
		if (firstDay === null || day < firstDay) {
			out.push({
				day,
				jobs: null,
				failuresByZone: null,
				runMedianSec: null,
				runP95Sec: null,
				queueMedianSec: null,
				queueP95Sec: null,
				backstopJobs: null,
				byMachine: [],
			});
			continue;
		}
		const rs = byDay.get(day) ?? [];
		const durations = rs.map((r) => r.durationSec);
		const queue = nums(rs.map((r) => r.queueSec));
		const machines = new Map<string, { jobs: number; busySec: number }>();
		for (const r of rs) {
			const m = nodeOf(r.runner, nodes);
			const e = machines.get(m) ?? { jobs: 0, busySec: 0 };
			e.jobs++;
			e.busySec += r.durationSec;
			machines.set(m, e);
		}
		out.push({
			day,
			jobs: rs.length,
			failuresByZone: failuresByZone(rs),
			runMedianSec: median(durations),
			runP95Sec: percentile(durations, 95),
			queueMedianSec: median(queue),
			queueP95Sec: percentile(queue, 95),
			backstopJobs: rs.filter(
				(r) => !r.labels.includes('pm2-host') && nodeOf(r.runner, nodes) === backstopNode
			).length,
			byMachine: [...machines.entries()]
				.map(([machine, e]) => ({ machine, ...e }))
				.sort((a, b) => b.jobs - a.jobs),
		});
	}
	return out;
}
