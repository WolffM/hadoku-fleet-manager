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

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { logger } from './host.js';
import { stateDir } from './host.js';
import { writeFileAtomic } from './lib/atomic-json.js';

/**
 * THE RETENTION RULE. Records are kept by AGE, and this is the only rule that
 * decides what the window holds. The panel is about trend, so it wants days,
 * not job count.
 */
export const RETENTION_DAYS = 14;
/**
 * A SAFETY BUDGET, not the retention rule — it exists so a runaway ingest
 * cannot grow the file and the heap without bound. It must never be the thing
 * that decides what is kept.
 *
 * It WAS, for two weeks. This was a 20,000-row cap, and on 2026-10-28 the live
 * file held exactly 20,000 rows spanning 2026-10-15T21:44Z to 10-28 — thirteen
 * days, not fourteen, and shrinking: 761 rows landed on 10-18 and 2,138 on
 * 10-27, so at that rate the cap held about seven days. Every "14-day" figure
 * on `GET /fleet`, the speed model and node-regression was silently cut over a
 * shorter window, and nothing said so.
 *
 * Sized for 14 days at FOUR TIMES the 2026-10-28 peak (~3,500 jobs/day):
 * 14 x 3,500 x 4 = 196,000. A record is ~410 bytes on disk, so the budget is
 * ~80 MB at its worst; at today's volume the window is ~50,000 rows.
 *
 * Reaching it is LOUD: {@link trimToBudget} logs how many in-window records it
 * dropped and how many days the window actually holds, every time it trims.
 */
export const MAX_RECORDS = 200_000;

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
	/*
	 * NO HOST-LOAD FIELDS, deliberately (removed 2026-10-28). `hostLoad1m`,
	 * `hostCpuPressureAvg10`, `hostCoTenants` and `hostCoTenantRepos` sat here
	 * from wave 4c (#102) and were present in 0 of 20,000 records: this record
	 * is built from the GitHub Jobs API, and the four facts exist only ON THE
	 * NODE — `ci-throttle.sh` prints them into the job's log and
	 * `job-metrics.sh` writes them into that node's `job-metrics.jsonl`. Carrying
	 * them here would cost either an ssh sweep or a log fetch per job on the
	 * runner-health tick. They are already joinable against this record by
	 * `jobId` where they live: `fleet job-metrics` (`joinMetrics`).
	 */
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
	 * `probe` above: `loadHistory` reads an old line
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

export const records: JobRecord[] = [];
export const seenRuns = new Set<number>();

/** Overridable so tests never touch the real host file. */
let historyPath: string | null = null;
let loaded = false;
let diskWarned = false;
let recordBudget = MAX_RECORDS;

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
	recordBudget = MAX_RECORDS;
}

/** Tests shrink the budget instead of writing 200,000 fixture rows. */
export function __setRecordBudgetForTesting(n: number): void {
	recordBudget = n;
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

export const probeRuns = new Map<number, ProbeOrigin>();
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
export const forcedLifted = new Set<number>();

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
export function loadProbeLedger(): void {
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

/**
 * Drop the oldest records past the safety budget — and SAY SO.
 *
 * Every record this drops is younger than {@link RETENTION_DAYS} (retention has
 * already removed the rest), so a trim means the window no longer covers the
 * days it claims to. That is logged every time it happens, naming how many
 * records went and how many days are actually held, because the 20,000-row cap
 * this replaced did exactly this in silence for two weeks.
 *
 * Oldest by `startedAt`, not by insertion: `ingestRuns` appends a tick's records
 * in fetch order, so the array is only roughly sorted.
 */
export function trimToBudget(now = Date.now()): void {
	const excess = records.length - recordBudget;
	if (excess <= 0) return;
	records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	records.splice(0, excess);
	const oldest = Date.parse(records[0]?.startedAt ?? '');
	const keptDays = Number.isFinite(oldest) ? ((now - oldest) / 86_400_000).toFixed(1) : '0';
	logger.warn(
		`[job-history] safety budget of ${recordBudget} record(s) trimmed ${excess} record(s) ` +
			`still inside the ${RETENTION_DAYS}-day window — history now holds ${keptDays} day(s) ` +
			`(since ${records[0]?.startedAt ?? 'nothing'}), not ${RETENTION_DAYS}`
	);
}

/**
 * The instant from which the in-memory window is COMPLETE, in ms — the later of
 * the retention cutoff and the oldest record held.
 *
 * Before the oldest record, nothing proves the window saw everything: retention
 * or the budget may have cut that day in half, or the file may simply have
 * started then. A reader that turns days into durable figures (job-rollups.ts)
 * must not treat a day that began before this as whole. `null` when the window
 * holds nothing, which proves nothing about any day.
 */
export function historyCompleteSinceMs(now = Date.now()): number | null {
	loadHistory(now);
	let oldest = Infinity;
	for (const r of records) {
		const ms = Date.parse(r.startedAt);
		if (ms < oldest) oldest = ms;
	}
	if (!Number.isFinite(oldest)) return null;
	return Math.max(oldest, now - RETENTION_DAYS * 86_400_000);
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
		trimToBudget(now);
		logger.info(`[job-history] loaded ${records.length} record(s) from ${historyFile()}`);
	} catch (err) {
		// ENOENT on first ever run is normal and must not warn.
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') warnOnce('could not read history', err);
	}
}

export function appendToDisk(fresh: JobRecord[]): void {
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
export function persistHistory(): boolean {
	try {
		mkdirSync(dirname(historyFile()), { recursive: true });
		writeFileAtomic(
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

export function jobRecords(): readonly JobRecord[] {
	loadHistory();
	return records;
}

/** Has this run been recorded, or claimed for a fetch this process? */
export function jobHistoryHasRun(runId: number): boolean {
	loadHistory();
	return seenRuns.has(runId);
}

export function remember(runId: number): void {
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
