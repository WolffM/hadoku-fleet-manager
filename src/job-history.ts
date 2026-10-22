/**
 * job-history — a rolling window of which node served which CI job, and how
 * long it took.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE SITREP
 * ------------------------------------------
 * The sitrep's `ci` domain answers "is anything red". This answers a different
 * question the fleet could not previously answer at all: WHERE work runs, how
 * fast each node is, and how often the prod host has to step in. Those are
 * the numbers that tell you whether the claws are actually keeping up — a fleet
 * can be entirely green while hokon quietly carries a third of the load.
 *
 * COST
 * ----
 * Bounded on purpose. GitHub has no "list jobs across a repo" endpoint, so job
 * detail costs one call per run. This never lists runs itself: runner-health
 * already does that for every fleet repo on its tick, and hands the listing
 * here. We then fetch jobs only for runs we have not already recorded, capped
 * per tick — so a quiet fleet costs nothing and a burst degrades into "we will
 * catch the rest next tick" rather than a rate-limit stall.
 *
 * That last claim was FALSE until 2026-09-04, and believing it is what hid a
 * 40% loss for as long as this file has existed. The cap is fine; the ORDER was
 * not. Spending it in listing order (newest-first) always deferred the oldest
 * runs, which are the ones nearest to falling out of the 30-run window, and the
 * next tick brought newer runs that outranked them again — starvation, not
 * deferral. `ingestRuns` now spends the budget oldest-first, so "next tick"
 * means what it says.
 *
 * Oldest-first is the WITHIN-repo half. The ACROSS-repo half was still
 * first-come until 2026-09-14: the sweep walks the roster in order and the
 * busiest repo on the fleet is #26 of 27, so a repo swept early could spend
 * every slot on runs in no danger and leave none for one whose oldest runs were
 * about to scroll out. `FetchBudget` now reserves a third of the allowance for
 * runs near the END of their repo's listing. Same total, ranked by risk.
 *
 * PERSISTED TO DISK, because in-memory was useless here.
 * ------------------------------------------------------
 * The first version kept the window in memory only and argued that a restart
 * clearing it was an acceptable trade against a D1 schema. That reasoning was
 * wrong on a fact I had in front of me all along: mgmt-api redeploys on every
 * push to its own tree, so it restarts many times a day. A median over a window
 * that resets several times an hour is not a median, and "how often does hokon
 * step in" cannot be answered at all — the panel would show `total: 0` most
 * times anyone opened it.
 *
 * So records append to ~/.hadoku-mgmt/job-history.jsonl and are read back at
 * startup. JSONL rather than a database: the write is one append per ingested
 * job on a path mgmt-api already owns, there is no schema to migrate, and a
 * truncated final line costs exactly one record instead of a corrupt file.
 * Retention is by AGE, not just count, so the window spans days of fleet
 * behaviour rather than however many jobs happened to fit.
 *
 * Every disk operation is best-effort: a failure to read or write history must
 * never take down the runner-health tick that produces it, so it is logged once
 * and the in-memory window carries on.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { logger } from './host.js';
import { stateDir } from './host.js';

/** Records kept in the window. Bounded so a busy week cannot grow unbounded. */
export const MAX_RECORDS = 20_000;
/** Age cutoff. The panel is about trend, so it wants days, not job count. */
export const RETENTION_DAYS = 14;
/**
 * Runs whose jobs we may fetch per tick, SHARED across every repo in the sweep.
 *
 * 12 until 2026-09-05, which was below the fleet's own burst rate and therefore
 * lost data rather than merely delaying it. Measured that evening: hadoku_site
 * alone completed 28 runs in 20 minutes (~84/h) while 12 per 10-minute tick caps
 * the WHOLE fleet at 72/h. The queue could not drain, and runs fell out of the
 * 30-run listing before the budget reached them — 2 confirmed permanently lost
 * inside a single 10-minute window, with 21 still queued behind them.
 *
 * 30/tick = 180/h, comfortably above the observed burst. The cost is bounded and
 * small: at most 30 extra jobs-calls per tick against a 5000/h limit that was
 * sitting at 954 when this was measured. It does not touch SWEEP_CONCURRENCY, so
 * the secondary-rate-limit exposure the sweep guards is unchanged.
 *
 * The alternative — widening the runs listing from `per_page=30` — was REJECTED.
 * That listing is not ours alone: the loop after `ingestRuns` alerts on queued
 * and in-progress runs by age, and the fleet carries two runs queued since
 * 2026-08-17 that cannot be cancelled. A wider page would pull those back into
 * view and re-alert on them, and cost an extra `queuedLabelsAreCovered` call
 * each. Raising throughput has no such coupling.
 *
 * The number is still a proxy, and it stays where it is. The property that
 * actually governs loss is nearness to the END of a repo's listing, which
 * differs per repo by turnover rate; a fleet-wide COUNT cannot express that, so
 * as of 2026-09-14 the budget is RANKED by listing position instead — see
 * {@link FetchBudget}'s reserve. Raising this number is not the next move if
 * loss recurs; look at the reserve.
 */
export const MAX_FETCH_PER_TICK = 30;
/**
 * Only runs this fresh are worth spending the budget on.
 *
 * Oldest-first fixed the starvation that lost 40% of runs, and immediately
 * introduced the opposite failure: observed within half an hour of deploying it,
 * the newest APPENDS were runs from NINE DAYS earlier. A quiet repo's 30-run
 * listing spans weeks, so "oldest unseen" reached back into ancient history and
 * spent the shared budget there while today's runs waited.
 *
 * Both failures are the same mistake — ranking by the wrong thing. The property
 * that matters is RISK OF LOSS, and a run is at risk when it is close to falling
 * out of its repo's listing, which for a busy repo is a matter of hours. A
 * nine-day-old run in a quiet repo is in no danger at all and contributes
 * nothing anyone reads; every panel figure is about recent behaviour.
 *
 * So: among unseen runs, oldest first — but only within this horizon. Comfortably
 * wider than any busy repo's listing turnover, far short of RETENTION_DAYS.
 */
export const FRESH_HORIZON_H = 48;
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
/** Run ids remembered, so we never re-fetch a run's jobs. */
const MAX_SEEN_RUNS = 4000;

export interface JobRecord {
	repo: string;
	runId: number;
	jobId: number;
	name: string;
	/** The runner that served it, e.g. 'claw-2' or 'hokon'. */
	runner: string;
	/** Labels the job requested — how we tell builder work from pm2-host work. */
	labels: string[];
	startedAt: string;
	durationSec: number;
	/**
	 * Seconds the job waited for a runner: job `created_at` -> `started_at`.
	 *
	 * JOB level, never run level. A run reports ~0s of queue because
	 * `run_started_at` is stamped when the FIRST job starts, so a run whose
	 * second job waited four minutes still reads as instant. It is also why
	 * `oldest_queued_min` under-reports: it keys off `run.status === 'queued'`,
	 * and a run with three jobs running and three waiting is `in_progress`.
	 *
	 * undefined when GitHub omitted `created_at` — absent, never guessed as 0,
	 * because a fabricated zero would drag every percentile down silently.
	 */
	queueSec?: number;
	/**
	 * Of `queueSec`, the part the DISPATCHER owns: job created -> runner minted.
	 *
	 * Only present for a job served by a `jit-` runner, because the mint time is
	 * read from the runner's own name — the epoch it already carries so the
	 * reaper can age it. Nothing new is stored to get this.
	 */
	dispatchSec?: number;
	/**
	 * Of `queueSec`, the part GITHUB owns: runner minted -> job started.
	 *
	 * A minted runner is online within ~2s and holds one job. Anything large here
	 * is GitHub not dispatching to a runner that was already waiting, and there is
	 * nothing on this side to tune.
	 *
	 * SPLITTING THESE IS THE POINT. On 2026-09-03 a run sat 628s and
	 * `ci:queue-health` called it "the fleet is not serving work". The fleet had
	 * minted in 19 seconds; the runner then idled ten minutes on an idle node with
	 * its concurrency group free. Establishing that took a subagent, a log
	 * archaeology pass and a journal query. One number cannot say which half was
	 * slow, so every future occurrence asked the same question from scratch.
	 */
	assignSec?: number;
	/**
	 * Wall time split into phases — see `jobPhases`. All three are absent
	 * together when the steps were unusable, never guessed as 0.
	 *
	 * `setupSec` is the interesting one on an all-JIT fleet: it contains the
	 * runner coming up, which for a minted runner is the mint, and no other
	 * figure in this payload exposes it.
	 */
	setupSec?: number;
	runSec?: number;
	cleanupSec?: number;
	conclusion: string;
	/**
	 * Name of the step that failed — the discriminator
	 * `tier-assignment-2026-09-03.md` §5.5 needs to tell a fleet-origin failure
	 * from the consumer's own test failing. Read from `steps[].conclusion`,
	 * which `/actions/runs/{id}/jobs` already returns and this module discarded,
	 * so it costs no extra request — the same argument `jobPhases`'s own comment
	 * makes for the phase timings.
	 *
	 * Present only when the job did not succeed and GitHub returned a usable
	 * step record naming which one failed; absent, never guessed, otherwise.
	 */
	failedStep?: string;
	/**
	 * Which phase (see `jobPhases`) the failed step falls in.
	 *
	 * A PRIOR, not a verdict, and a COARSER one than §5.5's zone table draws.
	 * `setup` is only GitHub's own synthetic first step (`Set up job`) and
	 * `cleanup` only `Post *`/`Complete job` — a failure in either is very
	 * likely the fleet's (runner infrastructure), rarely the consumer's.
	 * `run` is everything ELSE, which is NOT the same as "the consumer's own
	 * test": it also holds seam steps the WORKFLOW named but did not write —
	 * `uses: actions/setup-python`, `actions/checkout` — so a `run` failure
	 * needs `failedStep`'s own NAME to tell a seam step from a `run:` step the
	 * consumer actually wrote. §5.5's zone table draws that finer line by
	 * pattern-matching the name; this field alone only narrows to "probably
	 * not GitHub's own machinery" for `run`. Upgrading either to a verdict is
	 * P3.1's forced-placement harness, not this field. Absent when
	 * `failedStep` is absent, or when the step's own timestamp cannot be
	 * placed in a phase.
	 */
	failedPhase?: 'setup' | 'run' | 'cleanup';
	/**
	 * This record came from a PROBE, not from organic traffic.
	 *
	 * `claw-floor-design-2026-09-07.md` §6 reserved this field and deliberately
	 * did not name it: "both write to `job-history.jsonl` exactly like real
	 * traffic (so the ranking in §2 sees them), tagged so a later reader can tell
	 * manufactured samples from organic ones".
	 *
	 * WHY IT IS OPTIONAL, AND WHY ABSENT MEANS ORGANIC. The alternative shape was
	 * a required `origin: 'organic' | 'shadow' | 'forced-rerun'`. Two facts kill
	 * it. First, fourteen days of records are already on disk with no such field,
	 * and `loadHistory` reads them back verbatim — a required field would be
	 * absent on every one of them anyway, so the type would be lying about the
	 * data. Second, the overwhelming majority of every future record is organic;
	 * spending a field on saying so costs bytes on every append to state the
	 * default. So: present means manufactured, absent means organic-or-predates-
	 * the-harness, and no reader may ever infer "organic" from absence alone
	 * without also checking `startedAt` against when the harness started running.
	 *
	 * WHY IT IS A UNION AND NOT A BOOLEAN. The two probe shapes have opposite
	 * selection biases and a reader that cannot tell them apart will draw the
	 * wrong conclusion from either. A `forced-rerun` sample exists BECAUSE
	 * something already failed (§6: "a REACTION, bounded by how often the fleet
	 * actually fails"), so a population of them is conditioned on failure and its
	 * failure rate means nothing. A `shadow` sample is unconditional and is the
	 * only manufactured population a rate may be computed over. `boolean` would
	 * have let a gate average the two.
	 *
	 * WRITTEN HERE AND NOWHERE ELSE. The harness runs out of process and cannot
	 * write this file — see `persistHistory`, and the 502 records lost on
	 * 2026-09-07 for what happens when something tries. It declares its probes in
	 * the probe ledger ({@link PROBE_LEDGER_FILE}); `ingestRuns` reads that and
	 * stamps the tag as the run is recorded, in the one process that owns the
	 * window.
	 */
	probe?: ProbeOrigin;
	/**
	 * The node's own state at the moment this job ran, from the hooks wave 4c
	 * (#102) added: `ci-throttle.sh` (job-STARTED) prints these four facts into
	 * the job's own log at admission and `job-metrics.sh` (job-COMPLETED)
	 * records them again into the node's metrics record. Slow reds were
	 * otherwise unattributable — a 0.95s test taking >5s, a 9s match start
	 * taking >60s, with nothing in the job saying what ELSE the host was doing
	 * (wave4c-2026-10-07.md).
	 *
	 * NEITHER HOOK WRITES job-history.jsonl, and this module does not read
	 * either hook's output either — `JobRecord` is built from the GitHub Jobs
	 * API (`GhJob`), which has no notion of host load at all. These four fields
	 * exist here so the SHAPE is ready for whichever future reader joins the
	 * two (the way `job-metrics.mjs`'s `joinMetrics` already joins job-history
	 * against the per-job memory record by `jobId`): a schema a future join has
	 * to invent under deadline is a schema invented badly. Until that join
	 * exists, every record on disk simply omits them, same as `probe` above
	 * omits itself from every record that predates it — and `loadHistory`
	 * already reads a record back `as JobRecord` with no field-by-field
	 * validation beyond `jobId`/`startedAt`, so an old line with none of these
	 * keys parses exactly as it did before this type gained them.
	 *
	 * "unreadable" (never a guessed number, never null) is the literal value
	 * BOTH hooks emit when a read failed — see either script's own comment —
	 * carried through here as-is rather than normalised to `undefined`, so a
	 * reader can tell "the node tried and could not look" from "nothing joined
	 * for this job yet" (the two are different findings; CLAUDE.md: "'I could
	 * not look' must never render as 'nothing is wrong'").
	 */
	hostLoad1m?: number | 'unreadable';
	hostCpuPressureAvg10?: number | 'unreadable';
	hostCoTenants?: number | 'unreadable';
	hostCoTenantRepos?: string[] | 'unreadable';
	/**
	 * The commit this job ran at. ADDITIVE, wave 4e §B: node-regression.ts needs
	 * to tell "the same commit failed here and passed there" (a node-specific
	 * regression) apart from "this commit is broken everywhere" (a real product
	 * red), and (repo, job name, head sha) is the only key that says which.
	 *
	 * Read from `/actions/runs/{id}/jobs`'s own `head_sha` — a field the API
	 * already returns on every job and this module discarded, same as
	 * `failedStep`'s own doc comment argues for `steps`. No new call.
	 *
	 * Absent on every record written before this field existed, exactly like
	 * `probe` and the `hostLoad1m` family above: `loadHistory` reads an old line
	 * back `as JobRecord` with no field-by-field validation, so a record with no
	 * `headSha` parses exactly as it did before this type gained it. A reader
	 * that needs the same-commit comparison (node-regression.ts) treats an
	 * absent `headSha` as "cannot compare" and skips the record, never as a
	 * match against another record that also happens to lack it.
	 */
	headSha?: string;
}

/**
 * How a manufactured sample was produced. See {@link JobRecord.probe}.
 *
 * `shadow` — a synthetic, non-blocking dispatch onto a chosen node, run in the
 * quiet window against the shadow budget. Unconditional, so a rate may be
 * computed over it.
 *
 * `forced-rerun` — Control A: a re-dispatch of a job that ALREADY failed in the
 * runner or seam zone, with the failing node excluded. Conditioned on failure;
 * never a denominator.
 */
export type ProbeOrigin = 'shadow' | 'forced-rerun';

const records: JobRecord[] = [];
const seenRuns = new Set<number>();

/** Overridable so tests never touch the real host file. */
let historyPath: string | null = null;
let loaded = false;
let diskWarned = false;

export function historyFile(): string {
	return historyPath ?? join(stateDir(), 'job-history.jsonl');
}

export function __setHistoryPathForTesting(p: string | null): void {
	historyPath = p;
	loaded = false;
}

export function __resetJobHistoryForTesting(): void {
	records.length = 0;
	seenRuns.clear();
	loaded = false;
	diskWarned = false;
	probeRuns.clear();
	probeLedgerMtimeMs = -1;
	forcedLifted.clear();
	ledgerWarned = false;
}

// ---------------------------------------------------------------------------
// The probe ledger — the forced-placement harness's half of the contract
// ---------------------------------------------------------------------------

/**
 * Where the harness declares the runs it manufactured.
 *
 * ONE FILENAME, DECLARED ONCE. `scripts/floor-probe.mjs` writes this file and
 * this module reads it, and the two run in different processes resolving
 * `stateDir()` through different doors (`host.ts` in-process, `lib/paths.mjs`
 * for the CLI). A second literal in the script is the isLocalNode shape — two
 * answers to one question, agreeing until one of them moves — so the script
 * imports this constant from the built copy rather than spelling it again.
 *
 * A SEPARATE FILE FROM `job-history.jsonl`, and that is not tidiness. This
 * process rewrites the history file wholesale from its in-memory window
 * (`persistHistory`) and merges nothing, so an out-of-process writer's lines
 * are deleted without an error — measured 2026-09-07, 502 records. The ledger
 * is append-only and this module never writes it, which is the only arrangement
 * where both writers can be right.
 */
export const PROBE_LEDGER_FILE = 'floor-probe-runs.jsonl';

/** One declared probe. The harness appends; nothing here writes it. */
export interface ProbeLedgerEntry {
	runId: number;
	repo: string;
	origin: ProbeOrigin;
	/** ISO stamp of the declaration, for the operator reading the file by eye. */
	at?: string;
}

const probeRuns = new Map<number, ProbeOrigin>();
/** mtime of the ledger as last read. -1 means "never looked". */
let probeLedgerMtimeMs = -1;
/** One warning per process for an unreadable ledger. See the catch below. */
let ledgerWarned = false;
/**
 * Forced runs whose `seenRuns` skip has already been spent, this process.
 *
 * THIS IS THE THING THAT KEEPS THE DEDUPE HOLE SHUT. The skip below is lifted
 * for a forced re-dispatch because the second attempt of an already-seen run is
 * exactly the record Control A needs and today it is never fetched. Lifting it
 * on EVERY tick for as long as the ledger entry exists would re-fetch that run
 * forever, which is the unbounded re-poll `seenRuns` was added to stop. One
 * lift per run id per process: enough to pick up the attempt the harness just
 * forced, bounded whether or not the harness ever prunes its ledger.
 */
const forcedLifted = new Set<number>();

export function probeLedgerFile(): string {
	return join(stateDir(), PROBE_LEDGER_FILE);
}

/**
 * Re-read the ledger when it has changed on disk.
 *
 * mtime-gated rather than once-only: mgmt-api is long-lived and the harness
 * declares a probe SECONDS before the run it names completes, so a load-once
 * reader would never see the entry that matters. One `statSync` per ingest
 * call — 26 repos on a 10-minute tick — against a file with a handful of lines.
 *
 * A missing ledger is an empty ledger and is correct: nothing has been
 * manufactured. An unreadable one is not, but it is also not fatal here — the
 * cost is a probe recorded as organic, which is a mislabelled sample and not a
 * wrong verdict, so it warns and carries on rather than taking the tick down.
 */
function loadProbeLedger(): void {
	let mtime: number;
	try {
		mtime = statSync(probeLedgerFile()).mtimeMs;
	} catch {
		// ENOENT is the normal state on a fleet that has never probed.
		probeRuns.clear();
		probeLedgerMtimeMs = -1;
		return;
	}
	if (mtime === probeLedgerMtimeMs) return;
	probeLedgerMtimeMs = mtime;
	probeRuns.clear();
	// The same window the records themselves live in. Past it the run has already
	// aged out of `records`, so there is nothing left for the tag to land on and
	// holding the entry in memory would grow this map for the life of the process
	// with no reader. An entry with no `at` is KEPT: unknown age must not silently
	// drop a declaration, which is the same rule `ingestRuns` applies to an
	// undated run.
	const cutoff = cutoffIso();
	try {
		for (const line of readFileSync(probeLedgerFile(), 'utf8').split('\n')) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line) as ProbeLedgerEntry;
				if (typeof e.runId !== 'number') continue;
				if (e.origin !== 'shadow' && e.origin !== 'forced-rerun') continue;
				if (typeof e.at === 'string' && e.at < cutoff) continue;
				probeRuns.set(e.runId, e.origin);
			} catch {
				// one bad line, not a bad file — same rule as loadHistory
			}
		}
	} catch (err) {
		// Its OWN once-flag, not `warnOnce`'s. Sharing that flag would let a
		// mislabelled probe sample silently consume the one warning a genuinely
		// unreadable history file gets — the less important failure muting the
		// more important one.
		if (!ledgerWarned) {
			ledgerWarned = true;
			logger.warn(
				`[job-history] could not read the probe ledger: ` +
					`${err instanceof Error ? err.message : String(err)} — ` +
					'manufactured samples this tick will record as organic'
			);
		}
	}
}

/** How run `runId` was manufactured, or undefined for organic traffic. */
export function probeOriginOf(runId: number): ProbeOrigin | undefined {
	loadProbeLedger();
	return probeRuns.get(runId);
}

function cutoffIso(now = Date.now()): string {
	return new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function warnOnce(what: string, err: unknown): void {
	if (diskWarned) return;
	diskWarned = true;
	logger.warn(
		`[job-history] ${what}: ${err instanceof Error ? err.message : String(err)} — ` +
			'continuing with the in-memory window only'
	);
}

/**
 * Read the window back from disk. Idempotent and lazy: called before every
 * ingest and every summary, so a restart mid-tick cannot serve an empty window
 * as though the fleet were quiet.
 *
 * A malformed line is SKIPPED rather than fatal. The file is append-only and a
 * process killed mid-write leaves a partial final line, which must cost one
 * record, not the entire history.
 */
export function loadHistory(now = Date.now()): void {
	if (loaded) return;
	loaded = true;
	const cutoff = cutoffIso(now);
	try {
		const raw = readFileSync(historyFile(), 'utf8');
		for (const line of raw.split('\n')) {
			if (!line.trim()) continue;
			try {
				const r = JSON.parse(line) as JobRecord;
				if (typeof r.jobId !== 'number' || typeof r.startedAt !== 'string') continue;
				if (r.startedAt < cutoff) continue;
				records.push(r);
				seenRuns.add(r.runId);
			} catch {
				// one bad line, not a bad file
			}
		}
		records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
		while (records.length > MAX_RECORDS) records.shift();
		logger.info(`[job-history] loaded ${records.length} record(s) from ${historyFile()}`);
	} catch (err) {
		// ENOENT on first ever run is normal and must not warn.
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') warnOnce('could not read history', err);
	}
}

function appendToDisk(fresh: JobRecord[]): void {
	if (!fresh.length) return;
	try {
		mkdirSync(dirname(historyFile()), { recursive: true });
		appendFileSync(historyFile(), fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
	} catch (err) {
		warnOnce('could not append history', err);
	}
}

/**
 * Rewrite the file from the in-memory window, unconditionally.
 *
 * THE IN-MEMORY WINDOW IS THE ONLY AUTHORITY. Everything below `compactHistory`
 * writes through here, and nothing else may write this file at all: this process
 * is long-lived, `loadHistory` reads the file exactly once (`if (loaded) return`),
 * and every later write replaces the file with `records`. So an edit made to the
 * file by any OTHER writer is not merged, not detected and not preserved — it is
 * simply overwritten by the next compaction, silently, with no error anywhere.
 *
 * That is not a hypothetical. On 2026-09-07 a one-shot script patched 502
 * records into the file directly; the running mgmt-api compacted at 15:50 and
 * every one of them was gone, along with the only copy — GitHub had already
 * begun aging the underlying jobs out. `backfillFailedSteps` exists so that work
 * goes through THIS function instead.
 */
function persistHistory(): boolean {
	try {
		mkdirSync(dirname(historyFile()), { recursive: true });
		writeFileSync(
			historyFile(),
			records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')
		);
		return true;
	} catch (err) {
		warnOnce('could not write history', err);
		return false;
	}
}

/**
 * Rewrite the file from the in-memory window, dropping what retention has aged
 * out. Append-only would otherwise grow forever; this runs only when the file
 * has meaningfully outgrown the window it represents, so the common tick pays
 * one append and nothing else.
 */
export function compactHistory(now = Date.now()): boolean {
	const cutoff = cutoffIso(now);
	const keep = records.filter((r) => r.startedAt >= cutoff);
	if (keep.length === records.length) {
		try {
			const size = statSync(historyFile()).size;
			// Rewrite only when the file is far larger than the live window implies.
			if (size < keep.length * 400 + 65_536) return false;
		} catch {
			return false;
		}
	}
	records.length = 0;
	records.push(...keep);
	return persistHistory();
}

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

export function jobRecords(): readonly JobRecord[] {
	loadHistory();
	return records;
}

function remember(runId: number): void {
	seenRuns.add(runId);
	if (seenRuns.size > MAX_SEEN_RUNS) {
		// Drop oldest insertions; Set preserves insertion order.
		const drop = seenRuns.size - MAX_SEEN_RUNS;
		let i = 0;
		for (const id of seenRuns) {
			if (i++ >= drop) break;
			seenRuns.delete(id);
		}
	}
}

// Exported since 2026-09-07: `backfillFailedSteps` takes a fetcher that returns
// one of these, so the shape is part of this module's public surface whether or
// not the name is — and an un-exported name in an exported signature is a .d.ts
// that consumers cannot implement against.
export interface GhJob {
	id?: number;
	name?: string;
	runner_name?: string | null;
	labels?: string[];
	created_at?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
	conclusion?: string | null;
	status?: string;
	/** The commit this job ran at. See {@link JobRecord.headSha}. */
	head_sha?: string | null;
	/**
	 * Per-step timings. ALREADY IN THE RESPONSE — `/actions/runs/{id}/jobs`
	 * returns them and this module discarded them, so the phase breakdown below
	 * costs no extra request against a budget that is deliberately small.
	 */
	steps?: {
		name?: string;
		number?: number;
		started_at?: string | null;
		completed_at?: string | null;
		conclusion?: string | null;
	}[];
}

/** GitHub's own synthetic first step. Everything before it ends is setup. */
const SETUP_STEP = 'Set up job';
/** GitHub's own synthetic last step, and the `Post <name>` teardown before it. */
const CLEANUP_STEP = 'Complete job';

/**
 * Split a job's wall time into the phases an operator can act on.
 *
 * DERIVED FROM STEPS WE ALREADY FETCH, not from new telemetry. The four phases
 * are the ones GitHub actually distinguishes:
 *
 *   setup    `started_at` -> end of "Set up job". Includes the gap BEFORE the
 *            first step, which is the runner coming up — on a JIT node that is
 *            the mint itself, and it is invisible in every other number here.
 *   run      the job's own steps.
 *   cleanup  the first `Post *` / "Complete job" step -> `completed_at`.
 *
 * Queue time is not in here: it precedes `started_at` and is `queueSec`.
 *
 * There is deliberately no "waiting" or "finalizing" bucket. The API exposes no
 * signal that separates either from `run` and `cleanup`, and a phase invented to
 * fill out a legend is a bar segment that means nothing.
 *
 * Returns undefined when the steps are absent or unusable — never a guessed
 * zero, for the same reason `queueSec` is optional: a fabricated 0 drags every
 * percentile down silently.
 */
export function jobPhases(
	j: GhJob,
	start: number,
	end: number
): { setupSec: number; runSec: number; cleanupSec: number } | undefined {
	const steps = (j.steps ?? []).filter((st) => st.started_at && st.completed_at);
	if (!steps.length) return undefined;
	const setup = steps.find((st) => st.name === SETUP_STEP);
	// `Post *` are the teardown halves of composite actions and always trail the
	// job's own work; "Complete job" is GitHub's own last step. The earliest of
	// them opens cleanup.
	const teardown = steps.filter(
		(st) => st.name === CLEANUP_STEP || (st.name ?? '').startsWith('Post ')
	);
	const setupEnd = setup?.completed_at ? Date.parse(setup.completed_at) : start;
	const cleanupStart = teardown.length
		? Math.min(...teardown.map((st) => Date.parse(st.started_at as string)))
		: end;
	if (![setupEnd, cleanupStart].every(Number.isFinite)) return undefined;
	// Clamp rather than trust: a step clock that disagrees with the job clock
	// must not produce a negative segment that renders as a bar running backwards.
	const a = Math.min(Math.max(setupEnd, start), end);
	const b = Math.min(Math.max(cleanupStart, a), end);
	return {
		setupSec: Math.round((a - start) / 1000),
		runSec: Math.round((b - a) / 1000),
		cleanupSec: Math.round((end - b) / 1000),
	};
}

/** GitHub step conclusions that mean the step is why the job did not pass. */
const FAILURE_STEP_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);

/**
 * Which step failed, and which phase it falls in — see `jobPhases`, and
 * `JobRecord.failedStep`/`failedPhase` for what each field means.
 *
 * DERIVED FROM STEPS WE ALREADY FETCH, same as `jobPhases`: zero extra API
 * calls. Boundaries come from `jobPhases` itself so the two never disagree
 * about where setup ends and cleanup begins.
 *
 * undefined when the job succeeded, when no step record names a failure, or
 * when the failing step has no usable timestamp — never guessed, for the same
 * reason `queueSec` and the phase fields are optional rather than zeroed.
 */
export function stepFailure(
	j: GhJob,
	start: number,
	end: number
): { failedStep: string; failedPhase?: 'setup' | 'run' | 'cleanup' } | undefined {
	if (!j.conclusion || j.conclusion === 'success') return undefined;
	const failed = (j.steps ?? []).find(
		(st) => st.conclusion && FAILURE_STEP_CONCLUSIONS.has(st.conclusion)
	);
	if (!failed?.name) return undefined;
	const phases = jobPhases(j, start, end);
	const startedAt = failed.started_at ? Date.parse(failed.started_at) : NaN;
	if (!phases || !Number.isFinite(startedAt)) return { failedStep: failed.name };
	const setupEndAbs = start + phases.setupSec * 1000;
	const cleanupStartAbs = end - phases.cleanupSec * 1000;
	const failedPhase: 'setup' | 'run' | 'cleanup' =
		startedAt < setupEndAbs ? 'setup' : startedAt < cleanupStartAbs ? 'run' : 'cleanup';
	return { failedStep: failed.name, failedPhase };
}

/**
 * The share of a listing that counts as AT RISK of scrolling out before the
 * next tick reaches it — the oldest third of the page GitHub returned.
 *
 * Risk is a POSITION IN THE PAGE, not an age. The oldest run of a `per_page=30`
 * listing is one push away from being unreachable; the newest has a whole page
 * of slack no matter how old it is — which is why FRESH_HORIZON_H is a separate
 * question and answers a different one. Measured 2026-09-14 across the
 * 14-day window, the busiest repo in its busiest hour (hadoku_site, 20 runs/h)
 * turns its 30-run listing over in 1.5 hours — nine ticks. A third of the page
 * is therefore ~3 ticks of warning at the worst rate the fleet has ever run,
 * which is the margin the reserve below is sized to protect.
 *
 * Both fractions are of the listing/budget actually in hand, never absolute: a
 * test that hands `ingestRuns` a budget of 2 and a listing of 5 must behave
 * exactly as it did before this existed, and with a floor()ed reserve of 0 it
 * does.
 */
export const AT_RISK_TAIL_FRACTION = 1 / 3;
/** The share of the shared budget held back for at-risk runs. See below. */
export const RISK_RESERVE_FRACTION = 1 / 3;

/**
 * A per-tick allowance of jobs fetches, SHARED across every repo in the sweep.
 *
 * The sweep fans out across repos, so the budget cannot be a number handed to
 * each `ingestRuns` call: six repos in flight would each see the full allowance
 * and spend it six times over. One object, decremented at the moment a fetch is
 * decided on (there is no await between `take()` and the call), keeps the cap
 * exact however the repos interleave.
 *
 * THE RESERVE, AND WHY IT IS NOT A PER-REPO BUDGET
 * -----------------------------------------------
 * Oldest-first (2026-09-04) fixed starvation WITHIN a repo. Across repos the
 * budget was still first-come: `runner-health` runs
 * `mapConcurrent(fleetRepos, SWEEP_CONCURRENCY, sweepRepo)`, which walks the
 * roster in order, and hadoku_site — the busiest repo on the fleet — is #26 of
 * 27. A repo swept early could spend all 30 slots on runs in no danger at all
 * and leave nothing for a repo swept later whose oldest runs were one tick from
 * scrolling out. Same mistake as newest-first, one level up: ranking by arrival
 * instead of by risk of loss.
 *
 * So a third of the allowance is reserved for runs that are near the END of
 * their repo's listing. `take(atRisk)` refuses a SAFE run once the budget is
 * down to the reserve; an at-risk run is served while anything is left at all.
 * The risk signal costs nothing — it is the position in the listing
 * runner-health already paid for.
 *
 * A PER-REPO BUDGET WAS REJECTED, and the arithmetic is the reason. Ingest
 * asks for each completed run's jobs ONCE, so there is never an ETag to send
 * and for this path the ceiling IS the spend — the distinction AGENTS.md draws
 * between a conditional and an unconditional call. 27 repos x 30 = 810 calls/tick =
 * 4,860/h against a 5,000/h budget, from a path that spends 180/h today. That
 * is the 2026-09-05 dispatch-cadence error over again (1,620 -> 6,480/h, and 19
 * minutes of every hour at `remaining: 0`). The reserve REDISTRIBUTES the same
 * 30 slots and adds none: per-tick spend is unchanged at MAX_FETCH_PER_TICK,
 * 180/h.
 */
export class FetchBudget {
	/**
	 * Slots that only an at-risk run may claim. Floor()ed, so a small budget —
	 * every test fixture, and `ingestRuns`' own numeric default path — reserves
	 * nothing and behaves exactly as it did before.
	 */
	readonly reserve: number;
	constructor(public remaining: number) {
		this.reserve = Math.floor(Math.max(0, remaining) * RISK_RESERVE_FRACTION);
	}
	/**
	 * Claim one fetch. False once the allowance is spent — or, for a run that is
	 * NOT at risk of scrolling out, once the allowance is down to the reserve.
	 *
	 * Defaults to at-risk: an unknown risk must never be a reason to skip a run,
	 * the same rule the undated-run filter in `ingestRuns` follows.
	 */
	take(atRisk = true): boolean {
		if (this.remaining <= 0) return false;
		if (!atRisk && this.remaining <= this.reserve) return false;
		this.remaining--;
		return true;
	}
}

/**
 * Ingest one repo's recent runs. `runs` is the listing runner-health already
 * holds; only COMPLETED, unseen runs cost a call.
 *
 * `budget` is either this call's own allowance or a {@link FetchBudget} shared
 * with the other repos of the same tick. Returns how many fetches this call made.
 */
export async function ingestRuns(
	repo: string,
	runs: { id?: number; status?: string; created_at?: string; updated_at?: string }[],
	fetchJobs: (repo: string, runId: number) => Promise<{ jobs?: GhJob[] } | null>,
	budget: number | FetchBudget = MAX_FETCH_PER_TICK
): Promise<number> {
	// Read the window back BEFORE deciding what is new. Without this a restart
	// would re-fetch every run it had already recorded, and the dedupe that keeps
	// this cheap would be defeated on exactly the tick after every deploy.
	loadHistory();
	// The harness declares its probes seconds before they finish, so this is read
	// per call rather than per process. See loadProbeLedger.
	loadProbeLedger();
	const allowance = typeof budget === 'number' ? new FetchBudget(budget) : budget;
	const fresh: JobRecord[] = [];
	let fetched = 0;
	/**
	 * Job ids already in the window, built ONLY when a forced re-fetch is
	 * possible.
	 *
	 * A forced re-fetch asks GitHub for a run this module has already recorded.
	 * GitHub's jobs endpoint answers with the LATEST attempt, so the new attempt
	 * carries new job ids and appends cleanly — but a forced entry for a run
	 * whose attempt has not been re-queued yet answers with the SAME jobs, and
	 * pushing those again would double every duration that run contributes to a
	 * median. O(window) once, on the rare tick that has a forced entry to spend;
	 * never on an ordinary poll.
	 */
	let knownJobIds: Set<number> | null = null;
	// OLDEST FIRST, and this is the difference between deferral and STARVATION.
	//
	// The listing arrives newest-first. Spending the budget in that order serves
	// the newest runs and defers the oldest — which are precisely the ones about
	// to fall off the end of the `per_page=30` window. On the next tick there are
	// newer runs again, so the deferred ones are outranked again, and again, until
	// they scroll out unfetched. They are never "caught next tick": under any
	// continuous load they are never caught at all.
	//
	// That is not a theoretical ordering nit. Measured 2026-09-04 against the
	// Actions API: 38 of 95 completed hadoku_site runs — 40% — had no record at
	// all, clustered exactly in the bursts. Every number derived from this file
	// (per-node medians, idle times, how often hokon steps in, the queueSec the
	// backstop is tuned against) was therefore computed on a 60% sample biased
	// AGAINST busy periods, which is when the fleet's behaviour actually matters.
	//
	// Ascending run id is ascending age: GitHub run ids are monotonic per repo,
	// so this needs no extra field from the listing.
	//
	// Bounded by FRESH_HORIZON_H, or oldest-first walks a quiet repo's listing
	// back into runs that no statistic will ever read. See that constant.
	const freshFrom = Date.now() - FRESH_HORIZON_H * 3600_000;
	// HOW FAR DOWN THE LISTING a run sits is the per-repo risk the shared budget
	// cannot otherwise see — see AT_RISK_TAIL_FRACTION and FetchBudget's reserve.
	//
	// By RANK AMONG THE IDS, not by array index. Run ids are monotonic per repo,
	// which is the property oldest-first already rests on, so the oldest third by
	// id IS the last third of the page however the array arrived. Indexing the
	// array instead would invert the whole signal the one time a caller handed the
	// listing in a different order — and the existing budget fixtures do exactly
	// that, which is how this was caught rather than shipped.
	const idsAsc = runs
		.map((r) => r.id)
		.filter((id): id is number => typeof id === 'number')
		.sort((a, b) => a - b);
	// The id of the newest run still counted as at risk. -Infinity for an empty
	// listing, which makes nothing at-risk and costs nothing: there is no run.
	const atRiskThrough = idsAsc[Math.ceil(idsAsc.length * AT_RISK_TAIL_FRACTION) - 1] ?? -Infinity;
	const ordered = [...runs]
		.filter((r) => {
			const at = Date.parse(r.updated_at ?? r.created_at ?? '');
			// An undated run is NOT skipped: unknown age must not silently drop a
			// run, and the seenRuns dedupe keeps it from being re-fetched forever.
			return !Number.isFinite(at) || at >= freshFrom;
		})
		.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
	for (const run of ordered) {
		if (allowance.remaining <= 0) break;
		const id = run.id;
		if (typeof id !== 'number') continue;
		// Only completed runs: an in-progress run's jobs have no duration yet, and
		// recording them would freeze a partial time that never gets corrected.
		if (run.status !== 'completed') continue;
		// THE DEDUPE, AND THE ONE HOLE DELIBERATELY PUNCHED IN IT.
		//
		// `seenRuns` stops the poller re-fetching a run forever, and that must keep
		// holding: it is what makes a quiet fleet cost nothing. But it also means a
		// SECOND ATTEMPT of an already-seen run is never fetched, and that second
		// attempt is precisely the record Control A needs
		// (`tier-assignment-2026-09-03.md` §5.5, `claw-floor-design-2026-09-07.md`
		// §1.3): the fleet has served `(repo, runId, jobName)` on two distinct
		// nodes 0 times in 7,033 jobs, so "did it fail elsewhere" cannot be
		// answered from history — it has to be manufactured, and then READ BACK.
		//
		// So the skip is lifted for a FORCED RE-DISPATCH ONLY, exactly once per run
		// id per process (`forcedLifted`), and only for a run the harness has
		// declared in the ledger. A shadow run needs nothing here: it is a new run
		// id and was never seen.
		const forced = probeRuns.get(id) === 'forced-rerun' && !forcedLifted.has(id);
		if (seenRuns.has(id) && !forced) continue;
		// Claim the fetch BEFORE remembering the run: a run remembered without its
		// jobs fetched would never be fetched, and the shared budget may have been
		// spent by another repo since the check at the top of the loop.
		//
		// `break` rather than `continue` stays correct with the reserve in play.
		// `ordered` is ascending id and at-risk is the oldest third by id, so every
		// at-risk run comes first. Once one SAFE run is refused, every run left in
		// this repo is safe and would be refused for the same reason.
		if (!allowance.take(id <= atRiskThrough)) break;
		remember(id);
		// Spent at the moment the fetch is claimed, NOT when it succeeds. A forced
		// entry whose fetch comes back null has still had its one lift: the run is
		// forgotten below and the ordinary unseen path retries it next tick, which
		// is the same recovery every other run gets. Spending it on success only
		// would let a repeatedly-failing fetch re-lift forever.
		if (forced) forcedLifted.add(id);
		fetched++;
		const body = await fetchJobs(repo, id);
		// A FAILED FETCH MUST NOT COUNT AS SEEN. `remember` has to happen before
		// the await — the budget is shared and there is no other safe point — but
		// a null body means the API did not answer, not that the run had no jobs.
		// Leaving it remembered retires the run permanently on one transient 5xx,
		// silently and with no way to notice. Forgetting it costs one retried
		// fetch on a later tick.
		if (!body) {
			seenRuns.delete(id);
			continue;
		}
		const origin = probeRuns.get(id);
		for (const j of body?.jobs ?? []) {
			if (!j.runner_name || !j.started_at || !j.completed_at || typeof j.id !== 'number') continue;
			if (forced) {
				knownJobIds ??= new Set(records.map((r) => r.jobId));
				if (knownJobIds.has(j.id)) continue;
				knownJobIds.add(j.id);
			}
			const start = Date.parse(j.started_at);
			const end = Date.parse(j.completed_at);
			if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
			const created = j.created_at ? Date.parse(j.created_at) : NaN;
			// A dependent job (`needs:`) is CREATED only once it is eligible, so this
			// is genuine runner-wait rather than time spent waiting on an upstream
			// job — verified against 270 jobs on 2026-08-25, where `deploy` sat at a
			// 4s median while the first job of each run carried the whole tail.
			const queueSec =
				Number.isFinite(created) && start >= created
					? Math.round((start - created) / 1000)
					: undefined;
			// The mint epoch is already in the runner's NAME — parseJitName reads the
			// same trailing `-<epoch>` the reaper ages on. A standing runner has no
			// mint, so both halves stay undefined rather than being guessed as 0.
			const minted = parseJitName(j.runner_name ?? '')?.mintedAtMs;
			// The halves must SUM to queueSec, so assign is the remainder rather than
			// its own subtraction. A JIT runner minted for one run can be handed a
			// different run's job, which makes `minted` predate `created`; clamping
			// each half independently then produced an assignSec LARGER than the
			// whole queue — measured across 636 real jobs, max assign 3553s against
			// a max queue of 2455s. A split that does not add up is worse than no
			// split, because it looks authoritative.
			//
			// dispatchSec 0 with a positive assignSec is meaningful, not a gap: a
			// runner was ALREADY waiting when the job was created, so none of the
			// wait is ours.
			//
			// A WARM listener has no mint to age, so the branch above leaves both
			// halves undefined — which is how issue #15 happened: `assignSec` was
			// structurally absent from every warm-served job, on exactly the path
			// P4.1 exists to measure (298 warm records to 2026-09-09, zero with an
			// assignSec). It is not missing data, it is a missing case. A warm
			// listener is a STANDING registration that predates the job and is
			// already long-polling, so there is no dispatch step to charge: the
			// whole wait belongs to GitHub deciding where to send the job, and
			// `dispatchSec` is 0 by construction rather than by measurement.
			//
			// The one case this over-attributes is a job created BEFORE the listener
			// that served it existed — the six 2026-09-08 06:14Z records in
			// `warm-latency-2026-09-08.md` §4(a), created seconds before the first
			// fill of the day. Those read as a large `assignSec` when part of the
			// wait was really the cache warming up. Correcting it would need a
			// per-job mint epoch, and a warm name deliberately carries none (there
			// is only ever one warm listener per node, so nothing needs
			// disambiguating). Over-attributing to the half that is already the
			// larger one beats leaving the number absent, which is what P4 got.
			const split =
				queueSec !== undefined && (j.runner_name ?? '').startsWith(WARM_PREFIX)
					? { dispatchSec: 0, assignSec: queueSec }
					: minted !== undefined && queueSec !== undefined && Number.isFinite(created)
						? (() => {
								const dispatchSec = Math.min(
									queueSec,
									Math.max(0, Math.round((minted - created) / 1000))
								);
								return { dispatchSec, assignSec: queueSec - dispatchSec };
							})()
						: {};
			fresh.push({
				repo,
				runId: id,
				jobId: j.id,
				name: j.name ?? 'job',
				runner: j.runner_name,
				...split,
				labels: j.labels ?? [],
				startedAt: j.started_at,
				durationSec: Math.round((end - start) / 1000),
				queueSec,
				...jobPhases(j, start, end),
				...stepFailure(j, start, end),
				conclusion: j.conclusion ?? 'unknown',
				// Spread like `probe` below: an organic-old record on disk never
				// carried this key, so a record with no head_sha in the API response
				// (should not happen, but GhJob declares it optional) gets no key at
				// all rather than an explicit `undefined`.
				...(j.head_sha ? { headSha: j.head_sha } : {}),
				// Spread, so an organic record carries no key at all rather than an
				// explicit `undefined` that JSON.stringify would drop anyway — the
				// shape on disk and the shape in memory stay the same object.
				...(origin ? { probe: origin } : {}),
			});
		}
	}
	records.push(...fresh);
	// Append the new records only — the whole point of JSONL here. Rewriting the
	// file every tick would turn a cheap append into O(window) IO on the same
	// loop that talks to GitHub.
	appendToDisk(fresh);
	while (records.length > MAX_RECORDS) records.shift();
	compactHistory();
	return fetched;
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
import { WARM_PREFIX, parseJitName } from './runners/ephemeral.js';
import { jobKind } from './lib/job-kind.js';

// ---------------------------------------------------------------------------
// The zone classifier — claw-floor-design-2026-09-07.md §5.5
// ---------------------------------------------------------------------------

/**
 * Whose half of the fence a failure fell on. **A ZONE IS A PRIOR, NOT A
 * VERDICT** (master §5.5).
 *
 * WHY THIS LIVES IN `src/` AND NOT IN `scripts/lib/floor-probe.mjs`, WHERE IT
 * WAS WRITTEN. It was the harness's rule for deciding whether one failure was
 * worth a forced re-run. It is now also the rule `summarise` folds
 * {@link NodeJobStats.failuresByZone} with, and therefore the rule `GET /fleet`
 * puts on the wire — so a second copy in the script half would be two answers
 * to one question, drifting the moment either moved. This is `isLocalNode`'s
 * lesson applied before it costs anything: `scripts/lib/floor-probe.mjs`
 * re-exports the BUILT copy of this, exactly as `fleet-exec.mjs` re-exports the
 * built `isLocalNode`, so there is only one implementation to drift from.
 */
export type FailureZone = 'runner' | 'seam' | 'content';

/**
 * A zone AFTER the fleet's own kills have been separated out — see
 * {@link zoneOf}. `fleet` is not one of §5.5's three; it is the fold this
 * package adds on top so a job the fleet STOPPED is never counted against the
 * consumer who wrote it.
 */
export type ObservedZone = FailureZone | 'fleet';

/**
 * GitHub's own synthetic steps, plus the `Post *` teardown it generates for
 * every `uses:` step. A failure in one of these is the fleet's: nothing the
 * consumer wrote has run yet, or everything they wrote has already finished.
 *
 * `Set up runner` is on this list because of the shape it produced on
 * 2026-09-03: claw-2 at 01:49 showing `Set up runner[cancelled]` across three
 * repos inside one minute. That is one node event, and a classifier that read
 * it as three consumer bugs would have hidden the only fleet-origin failure in
 * the window.
 */
const RUNNER_STEPS = [/^set up job$/, /^set up runner$/, /^complete job$/, /^complete runner$/];
const RUNNER_PREFIXES = [/^post /];

/**
 * Steps the WORKFLOW named but did not write — the seam between the consumer's
 * yaml and the fleet's boxes.
 *
 * Both known real fleet bugs landed here and neither is visible from the phase
 * alone: `Set up Python` failing on claw-1 is the `RUNNER_TOOL_CACHE` gap, and
 * `Install` failing on claw-2 at hadoku-pygmalion `ae94757` is the missing-pip
 * gap on one of the two boxes that lacks it. `failedPhase` calls both of them
 * `run`, which is why this matches on the NAME.
 *
 * `Install` is here on the master doc's hand classification of all 17 failures
 * in the all-JIT window and it is the weakest entry on the list — a consumer
 * can perfectly well name a `run:` step `Install`. That is tolerable because a
 * zone is a PRIOR: over-reading a content failure as a seam one costs one
 * forced re-run, which is the cheap direction. Under-reading a seam failure as
 * content costs the evidence Control A exists to manufacture.
 */
const SEAM_STEPS = [
	/^set ?up [\w .+-]+$/, // setup-python / setup-node / setup-pnpm, however named
	/^install$/,
	/^checkout/,
	/^run [\w.-]+\/[\w.-]+@/, // an unnamed `uses:` step renders exactly like this
];

/** The fields a zone can be decided from. Looser than `JobRecord` on purpose:
 * the probe ledger's own settled entries carry the same two fields and are
 * classified by the same rule. */
export interface ZoneInput {
	failedStep?: string | null;
	failedPhase?: string | null;
	conclusion?: string | null;
	durationSec?: number | null;
}

/**
 * Which zone a failure falls in — `runner`, `seam` or `content`.
 *
 * **A ZONE IS A PRIOR, NOT A VERDICT** (master §5.5). A content-zone step can
 * still be ours (an OOM-killed test reports as `Tests` failing) and a seam step
 * can still be theirs (pinning `python-version: '3.13'` fails `Set up Python`
 * everywhere). This decides only whether a failure is worth spending a forced
 * re-run on; §5's two-point rule is what turns evidence into a claim.
 *
 * NO STEP RECORD IS `runner`, NOT `unknown`. A job that failed without GitHub
 * returning a usable step record generally never got far enough to run one —
 * that is the fleet's half by elimination, and the master doc's own table says
 * so ("or no step record"). Calling it unknown and declining to probe would
 * discard exactly the failures most likely to be ours.
 */
export function classifyZone(record: ZoneInput | null | undefined): FailureZone {
	const name = (record?.failedStep ?? '').trim().toLowerCase();
	if (!name) return 'runner';
	if (RUNNER_STEPS.some((re) => re.test(name))) return 'runner';
	if (RUNNER_PREFIXES.some((re) => re.test(name))) return 'runner';
	// The phase is consulted only AFTER the name has had its say: GitHub's
	// synthetic steps are already matched above, and a consumer step that happens
	// to land in the setup phase is still theirs.
	if (record?.failedPhase === 'setup' || record?.failedPhase === 'cleanup') return 'runner';
	if (SEAM_STEPS.some((re) => re.test(name))) return 'seam';
	return 'content';
}

/**
 * Every `RuntimeMaxSec` the fleet has minted a JIT unit with, newest last.
 *
 * `sec` is the value; `from`/`until` are when it was the live value, for a
 * reader trying to work out which deploy a finding belongs to. Nothing here is
 * imported from `runners/ephemeral.ts` on purpose — that file holds what the
 * fleet mints TODAY, and this needs what it minted THEN. History spans deploys:
 * a record written while the fleet minted 3600 s units has to stay detectable
 * after the fleet stops minting them, or this check gets EASIER to pass the
 * moment the bug is fixed and loses the ability to say what the bug cost. A new
 * TTL is APPENDED here, never swapped in.
 *
 * Moved out of `scripts/check-fleet-kills.mjs` when the report path needed the
 * same rule: that script re-exports its view of this list rather than keeping a
 * second one.
 */
export const KNOWN_TTL_SEC: readonly {
	sec: number;
	from: string;
	until: string | null;
	why: string;
}[] = [
	{
		sec: 3600,
		from: '2026-08-24',
		until: '2026-09-14',
		why: 'the #22 orphan TTL, applied to jobs',
	},
	{
		sec: 23_400,
		from: '2026-09-14',
		until: null,
		why: "backstop above GitHub's 360-minute ceiling",
	},
];

/** How close to a TTL counts. The kill lands a beat after the deadline (3,601). */
export const TTL_MATCH_SEC = 5;

/** A step GitHub runs after the job's own work — where a shutdown signal shows up. */
function isCleanupStep(r: ZoneInput): boolean {
	return (
		r.failedPhase === 'cleanup' ||
		(r.failedStep ?? '').startsWith('Post ') ||
		r.failedStep === 'Complete job'
	);
}

/**
 * Did the FLEET stop this job, rather than the job failing? Issue #22.
 *
 * Both halves matter and neither is sufficient. The duration alone catches a
 * job that happened to take an hour; the cleanup step alone catches every
 * ordinary `Post`-step flake. Together they are the signature of `The runner
 * has received a shutdown signal` — the unit went away under a job whose own
 * steps had all passed.
 *
 * A job that ran to the TTL and SUCCEEDED is evidence the TTL did NOT fire —
 * the unit outlived the job — so it is a duration coincidence, not a kill.
 */
export function isFleetKill(r: ZoneInput | null | undefined): boolean {
	if (!r) return false;
	if (typeof r.durationSec !== 'number' || !Number.isFinite(r.durationSec)) return false;
	if (r.conclusion === 'success') return false;
	if (!KNOWN_TTL_SEC.some((t) => Math.abs((r.durationSec as number) - t.sec) <= TTL_MATCH_SEC))
		return false;
	return isCleanupStep(r);
}

/**
 * The zone a failure is COUNTED in — {@link classifyZone}, except that a job the
 * fleet's own unit TTL killed is its own zone.
 *
 * WHY THE FOLD IS HERE AND NOT INSIDE `classifyZone`. `warrantsForcedRerun`
 * asks `classifyZone` whether a failure is worth spending a probe on, and a
 * fleet kill is not a placement question at all — re-running it elsewhere
 * measures nothing, because the next unit would be killed at the same TTL.
 * Folding `fleet` into the three-zone function would have changed that
 * decision as a side effect of adding a counter. So the three zones stay
 * exactly what §5.5 says they are, and this is the strictly-later refinement
 * built on top of them.
 *
 * A KILL THE FLEET CAUSED IS NEVER COUNTED AS THE CONSUMER'S FAILURE, which is
 * the whole reason the bucket exists: without it, a unit stopped at minute 60
 * of a 90-minute build lands in `runner` — true, but indistinguishable from a
 * box that could not start a job, which is a different repair.
 */
export function zoneOf(r: ZoneInput | null | undefined): ObservedZone {
	return isFleetKill(r) ? 'fleet' : classifyZone(r);
}

/**
 * Non-success records on one node, split by whose half of the fence they fell
 * on. See {@link NodeJobStats.failuresByZone}.
 */
export interface FailuresByZone {
	/** GitHub's own synthetic steps, or no step record at all. */
	runner: number;
	/** Steps the workflow NAMED but did not write — setup-*, checkout, install. */
	seam: number;
	/** The consumer's own step. */
	content: number;
	/** The fleet's unit TTL stopped it. {@link isFleetKill}, issue #22. */
	fleet: number;
	/**
	 * CANCELLED, and deliberately NOT classified into a zone.
	 *
	 * Measured over the live window 2026-09-08: 420 of 639 non-success records
	 * were cancellations, mostly `cancel-in-progress` supersedes whose step is
	 * arbitrary — three sampled ones stood on `Post Run actions/setup-node@v6`,
	 * `Update packages` and `Admin script tests (python)`. Classifying those
	 * would have put supersede noise in the `runner` bucket, which is the one an
	 * operator acts on. It is still COUNTED, because a bucket that vanishes is a
	 * fact nobody notices.
	 */
	cancelled: number;
}

/**
 * Fold a node's records into {@link FailuresByZone}. Every bucket is present
 * with an explicit zero — a sparse map would let a node with no runner-zone
 * failures and a node nobody looked at render identically.
 *
 * THE FIVE BUCKETS SUM TO {@link NodeJobStats.failures}, which is
 * `conclusion !== 'success'`. That invariant is asserted in the tests rather
 * than merely stated, because the two counts are computed in different places
 * and "the zones do not add up" is exactly the kind of drift nobody reads a
 * dashboard closely enough to catch.
 */
export function failuresByZone(records: readonly ZoneInput[]): FailuresByZone {
	const out: FailuresByZone = { runner: 0, seam: 0, content: 0, fleet: 0, cancelled: 0 };
	for (const r of records) {
		if (r.conclusion === 'success') continue;
		if (r.conclusion === 'cancelled') {
			out.cancelled += 1;
			continue;
		}
		out[zoneOf(r)] += 1;
	}
	return out;
}

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
		byNode.set(m, [...(byNode.get(m) ?? []), r]);
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

const nums = (xs: (number | undefined)[]): number[] =>
	xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

function repoStats(history: JobRecord[], nodes: string[], recentFrom: number): RepoJobStats[] {
	const byRepo = new Map<string, JobRecord[]>();
	for (const r of history) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
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
				kinds.set(k, [...(kinds.get(k) ?? []), r.durationSec]);
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
		byDay.set(d, [...(byDay.get(d) ?? []), r]);
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
