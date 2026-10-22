/**
 * The glue between the fleet loop and the dispatcher.
 *
 * Everything under `runners/` was pure or testable and NONE of it was called by
 * production code — this is the join that was missing. It is deliberately thin:
 * it gathers inputs and hands them to `runDispatchPass`, which already owns the
 * decisions. Anything smarter belongs in the modules that have tests for it.
 *
 * API COST IS THE DESIGN CONSTRAINT (B1, §12.17). One queued-runs listing per
 * repo per tick would be 26 calls every 60 s — 1,560/hour against a 5,000/hour
 * budget shared with everything else mgmt-api does. `reposDue` tiers the poll so
 * hot repos are checked every tick and quiet ones far less often, and the sweep
 * that follows costs one reachability probe per ephemeral node.
 *
 * FAIL TOWARD DOING NOTHING. Every failure here — an unreadable listing, an
 * unreachable node, a missing manifest — results in fewer mints, never more.
 * A dispatcher that mints on bad data is the OOM this workstream exists to stop;
 * one that declines simply leaves the work to the standing runners above it.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger, stateDir } from '../host.js';
import { withGhCaller } from '../gh-budget.js';
import {
	runDispatchPass,
	__resetReapClockForTesting,
	type DispatchPassResult,
	type RunningJob,
} from './dispatch-pass.js';
import type { SkipReason } from './dispatcher.js';
import { SWEEP_CONCURRENCY, mapConcurrent } from '../lib/concurrency.js';
import {
	DEFAULT_POLL_POLICY,
	deriveHotRepos,
	mintableRuns,
	reposDue,
	runnableJobs,
	type QueuedJob,
	type QueuedRun,
} from './queue-discovery.js';
import { satisfiesLabels, type NodeState } from './placement.js';
import { runnerTarballUrl } from './ephemeral-exec.js';
import type { GhLike, ShellLike } from './ephemeral-exec.js';

/** Last poll time per repo. Module state, and safe to lose: `reposDue` treats an
 * unknown repo as due, so a restart polls everything once and re-tiers itself. */
/**
 * Per-repo ETag and the body it belongs to.
 *
 * Module-level, like `lastPolledMs`, and lost on restart — which is correct and
 * cheap: a missing ETag costs one full listing, and the next answer refills it.
 * Persisting it would risk serving a body from before a restart that the fleet
 * has already acted on.
 */
const etagByRepo = new Map<string, string>();
const cachedRunsByRepo = new Map<string, { workflow_runs?: QueuedRun[] }>();

const lastPolledMs = new Map<string, number>();

/**
 * Per candidate run (`repo#runId`): the jobs listing's ETag and the body it
 * belongs to (#117). Same reasoning, and the same restart behaviour, as
 * `etagByRepo`: a 304 is free (measured 2026-10-16 on this endpoint — three
 * conditional `/runs/{id}/jobs` requests answered 304 and `used` did not move),
 * and it means the cached body IS the current one.
 */
const jobsCacheByRun = new Map<string, { etag: string | null; body: { jobs?: QueuedJob[] } }>();

/**
 * How long a run that NO node could take goes un-probed (#117).
 *
 * The jobs probe ran for every candidate on every 15s tick, and a run nothing
 * could serve got the same answer every time and paid for it every time: on
 * 2026-10-16 hadoku-cardtable run 38948244350 was probed and skipped 65 times
 * between 18:33 and 18:50Z — 240 calls an hour for one run — because the three
 * jdk21 nodes were full. Its siblings were RUNNING, so their steps changed the
 * body and the ETag above rarely answered 304. 251 such skips in the window
 * that ended in that day's blackout.
 *
 * The backoff is BOUNDED and lifts early on exactly the two things that can
 * change the answer: a node that could take the job changing state (see
 * `placementFingerprint`), and a time-based hold reaching its release
 * (`SkipReason.releaseAtMs`). So a full fleet stops paying per tick, and a
 * freed slot is still seen on the very next one.
 */
export const PROBE_BACKOFF_MS = 120_000;

/** `repo#runId` -> do not re-probe before `untilMs` while `fingerprint` holds. */
const probeBackoff = new Map<
	string,
	{ untilMs: number; fingerprint: string; wanted: string[][] }
>();

/**
 * What a job's placement answer depends on, over the nodes that could ever
 * take it — the ones carrying one of its label sets and not excluding its
 * repo. A node that lacks `jdk21` finishing a job elsewhere cannot change
 * whether a jdk21 job places, so it must not lift the backoff; one of the
 * three jdk21 nodes freeing a slot must.
 *
 * NOT `freeMb`: it is re-read every tick and never repeats, so including it
 * would lift every backoff on every tick. A memory refusal is re-asked when a
 * relevant node's unit count moves (a job finishing is what frees memory) and
 * at the latest after PROBE_BACKOFF_MS.
 */
export function placementFingerprint(
	nodes: readonly NodeState[],
	repo: string,
	wanted: readonly (readonly string[])[]
): string {
	return nodes
		.filter(
			(n) =>
				!n.excludedRepos?.has(repo) &&
				(!wanted.length || wanted.some((w) => satisfiesLabels(n.labels ?? [], w)))
		)
		.map((n) =>
			[
				n.name,
				n.healthy,
				n.eligible,
				n.schedulable ?? '',
				n.liveUnits,
				n.standingBusy,
				n.maxConcurrent,
				n.heavyJobs ?? 0,
				n.runningHeavy ?? false,
			].join(':')
		)
		.sort()
		.join('|');
}

/**
 * Stuck runs already warned about.
 *
 * A stuck run stays stuck — that is what makes it stuck — so warning every tick
 * turns a real finding into 6 lines an hour, forever, and the fleet's own logs
 * become the thing nobody reads.
 *
 * THE TWO ZOMBIES CANNOT BE CLEARED AT ALL — not "until someone gets to it".
 * Tested to exhaustion on 2026-09-07, by API and by a human in the web UI.
 *
 * The REST API is CONSISTENT, and an earlier version of this comment got that
 * wrong by listing four "contradictory" answers. Two of those were client
 * renderings — the `gh` CLI says "is completed", the web UI says "is not in
 * progress" — and quoting them as server states overstated the evidence. The
 * server says one thing:
 *
 *   POST /cancel        -> 409 "Cannot cancel a workflow run that has not been queued yet."
 *   POST /force-cancel  -> 409 (identical)
 *   DELETE /runs/<id>   -> 403 "Could not delete the workflow run"
 *
 * The real contradiction is smaller and much sharper, and it is between two
 * endpoints of the same API for the same run:
 *
 *   GET  /runs/<id>     -> "status": "queued"
 *   POST /runs/<id>/cancel -> "has not been queued yet"
 *
 * Both cannot be true. And the two refusals close the loop on each other: it
 * cannot be cancelled because the cancel endpoint says it was never queued, and
 * it cannot be deleted because DELETE wants a COMPLETED run. There is no
 * transition out.
 *
 * The 403 is a STATE refusal rather than a scope one: retried with the
 * owner's own credential, same answer.
 *
 * The cause is visible in the runs themselves — both report `total_count: 0`
 * jobs. A run that never produced a job was never queued in the sense the
 * cancel endpoint means, so no state transition it offers applies, and the
 * record is stranded server-side. That is also why minting for them could never
 * have helped: there is no job to assign.
 *
 * Note this is NOT the same as a genuinely queued run that will not cancel.
 * hadoku-jobplatform#34076512658 refused a plain cancel on 2026-09-07 and
 * force-cancel cleared it in one call — it had real jobs. Reach for
 * force-cancel there; it is not the answer here.
 *
 * So they stay until GitHub Support removes them. `summariseQueue` already
 * contains the cost: they are classified `zombie` and reported rather than
 * failed, so they cannot pin the gate red.
 *
 * ---------------------------------------------------------------------------
 * AND THE SET IS A FILE, BECAUSE THE PROCESS IS NOT DURABLE (issue #25).
 * ---------------------------------------------------------------------------
 *
 * "Said ONCE per run" was true of one PROCESS and of nothing else, and that is
 * not what an operator reading the logs experiences. mgmt-api restarts on every
 * deploy — 28 in one morning is on record — and each restart handed this set
 * back empty, so the same ids were announced again. Counted in
 * `~/.pm2/logs/mgmt-api-out__*.log`, the line about the same two permanent
 * zombies appeared 32 times on 2026-09-08 and 23 on 2026-09-09. The in-process
 * dedup was working perfectly the whole time; it was simply scoped to the wrong
 * lifetime.
 *
 * So the announcement is booked in `STUCK_ANNOUNCED_FILE` under `stateDir()`,
 * which outlives the process. Three properties this has to keep:
 *
 *  1. IT NEVER GETS QUIETER AS THE FAILURE GETS WORSE. Suppression is keyed on
 *     the RUN ID, so a new unclearable run is a new key and is announced even
 *     while a dozen old ones are suppressed; and every line carries the TOTAL
 *     alongside the new ones, so a growing population is visible in the one
 *     line it does emit. (The key is the full `repo#id` STRING — it was a
 *     32-bit hash, which at this file's new lifetime and size is a way for a
 *     genuinely new run to be silenced by a collision nobody could ever
 *     diagnose.)
 *  2. IT NEVER RETRACTS THE FINDING. The runs stay in `stuckRuns` and stay
 *     classified `zombie`; `ci:queue-health` counts them on every run, every
 *     run, regardless of what this file says. What is suppressed is a repeated
 *     LINE, never the count.
 *  3. "I COULD NOT LOOK" DOES NOT PRUNE. An entry is dropped only when its
 *     repo's listing was READ on this tick and the run was absent from it — so
 *     an API failure leaves the book untouched rather than forgetting six
 *     zombies and re-announcing them the moment it recovers.
 */
export const STUCK_ANNOUNCED_FILE = 'dispatch-stuck-announced.json';

/**
 * Ceiling on the announced set, because a persisted file grows where a process
 * one could not.
 *
 * The prune above handles every run that leaves a queue this dispatcher still
 * polls. It cannot handle a repo that leaves the ROSTER while holding a zombie:
 * nothing polls it again, so its entries are never observed gone. That leaks
 * slowly — six ids in a month of the worst incident on record — and a cap of 500
 * is far past any honest population.
 *
 * DROPS THE OLDEST, and says so. Dropping the newest would silence exactly the
 * findings this mechanism exists to surface; dropping the oldest re-announces a
 * long-known zombie once, which is noise rather than a lost signal.
 */
export const MAX_ANNOUNCED_STUCK = 500;

/** `repo#id` -> the ISO time it was first announced. Loaded lazily from disk. */
const warnedStuck = new Map<string, string>();
let warnedStuckLoaded = false;

/** Store failures are announced once per process, never once per tick. */
const stuckStoreComplaints = new Set<string>();

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function complainOnce(key: string, message: string): void {
	if (stuckStoreComplaints.has(key)) return;
	stuckStoreComplaints.add(key);
	logger.warn(`[dispatch-tick] ${message}`);
}

const stuckStorePath = (): string => join(stateDir(), STUCK_ANNOUNCED_FILE);

/** Oldest-first, so the cap and the prune both have one ordering to agree on. */
function capAnnouncedStuck(): void {
	if (warnedStuck.size <= MAX_ANNOUNCED_STUCK) return;
	const oldestFirst = [...warnedStuck.entries()].sort((a, b) => a[1].localeCompare(b[1]));
	const drop = oldestFirst.slice(0, warnedStuck.size - MAX_ANNOUNCED_STUCK);
	for (const [k] of drop) warnedStuck.delete(k);
	complainOnce(
		'cap',
		`the announced-stuck book passed ${MAX_ANNOUNCED_STUCK} entries — dropped the ` +
			`${drop.length} oldest, which WILL be announced again: ${drop
				.slice(0, 5)
				.map(([k]) => k)
				.join(', ')}. A book this size means runs are being written off faster than ` +
			`they leave the queue; that is the finding, not this line.`
	);
}

/**
 * The book, from disk. Once per process.
 *
 * UNREADABLE MEANS RE-ANNOUNCE, which is the safe direction and the opposite of
 * `readProbeIntents`'s. A lost book costs one duplicated warning per run; a book
 * that failed open in the other direction would swallow a genuinely new zombie
 * and this whole mechanism would have made the fleet quieter about a real
 * failure. It still SAYS WHY — a corrupt file and a missing one are different
 * jobs, and only one of them is normal.
 */
function loadWarnedStuck(): void {
	if (warnedStuckLoaded) return;
	warnedStuckLoaded = true;
	const path = stuckStorePath();
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (e) {
		// ENOENT is the normal state of a fleet that has never seen a zombie.
		if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			complainOnce(
				'read',
				`could not read ${path}: ${reasonOf(e)} — stuck runs will be re-announced`
			);
		}
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		complainOnce('parse', `${path} is not parseable JSON (${reasonOf(e)}) — starting a fresh book`);
		return;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		complainOnce('parse', `${path} is not a JSON object — starting a fresh book`);
		return;
	}
	for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof v === 'string') warnedStuck.set(k, v);
	}
	capAnnouncedStuck();
}

/**
 * Write the book back. ONLY when it changed — this is on the 15 s dispatch tick,
 * and a steady fleet must not write a file 240 times an hour to say nothing.
 *
 * Temp-and-rename, so a torn write cannot leave a half-object behind; the parse
 * failure that would follow is survivable but costs a duplicated announcement of
 * every zombie on the fleet.
 */
function persistWarnedStuck(): void {
	capAnnouncedStuck();
	const path = stuckStorePath();
	const tmp = `${path}.tmp`;
	try {
		mkdirSync(stateDir(), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(warnedStuck), null, '\t')}\n`);
		renameSync(tmp, path);
	} catch (e) {
		// SAY WHY, and say what it costs. A silent persist failure is invisibly
		// identical to the bug this file was written to close.
		complainOnce(
			'write',
			`could not persist ${path}: ${reasonOf(e)} — every stuck run will be announced ` +
				`again on the next restart, which is issue #25 back`
		);
	}
}

/** `WolffM/hadoku_site#34749048183` -> `WolffM/hadoku_site`. */
function repoOfStuckKey(key: string): string {
	const i = key.lastIndexOf('#');
	return i === -1 ? key : key.slice(0, i);
}

/**
 * How often the dispatcher re-examines STUCK runs for stranded work.
 *
 * ON ITS OWN CLOCK, for the reason `REAP_INTERVAL_MS` is: this adds a
 * `/actions/runs/<id>/jobs` call per candidate, and while `ghGet` revalidates
 * with an ETag, a stranded run with live siblings changes its body between
 * calls, so the ceiling is sized as if every call were charged. Riding
 * the 15 s dispatch tick, a single outage's worth of debris — say 20 stranded
 * runs — would cost 4,800 calls/hr against a 5,000/hr budget and starve the
 * fleet of the very calls it needs to recover. That is the 2026-09-05 reap
 * regression exactly, and the arithmetic has to be done separately for each
 * thing hanging off a timer.
 *
 * 10 minutes with the cap below is at most 30 calls/hr. Recovery is not urgent:
 * every candidate has by definition already waited an hour.
 */
export const RECOVERY_INTERVAL_MS = 600_000;

// ---------------------------------------------------------------------------
// The probe's declared intent — the one thing that stops the wasted competitor
// ---------------------------------------------------------------------------

/**
 * Where the forced-placement harness declares a job it is about to serve itself.
 *
 * WHAT THIS BUYS, MEASURED. `scripts/floor-probe.mjs` mints a runner on the
 * chosen node and only then dispatches, because a runner already listening gets
 * the job from GitHub in about two seconds. The dispatcher sees the same job
 * queued on its next 15 s tick and mints a SECOND runner for it —
 * `floor-probe-2026-09-08.md` §2.1: "roughly one wasted mint per probe". That
 * cost is absorbed, but it is not only a cost: all four of the eleven-probe
 * sweep's MISSES landed on a node still holding a leftover competitor from the
 * previous probe, so two idle matching runners existed and GitHub picked. The
 * probe's misses were self-inflicted and correlated.
 *
 * A DIRECTORY, ONE FILE PER PROBE, NOT AN APPEND-ONLY LEDGER. The probe has to
 * RELEASE its intent the moment it is done — an intent that lingers suppresses
 * minting for a real queued job of the same unit, and under all-JIT nothing else
 * would mint for it, so the job waits. A file per probe means release is an
 * unlink and two concurrent probes never rewrite each other's line. The probe
 * ledger is append-only for the opposite reason: nothing ever has to take a line
 * out of it.
 *
 * NOT `job-history.jsonl`, and not the probe ledger, for the reason
 * `PROBE_LEDGER_FILE` names: the in-process writer rewrites history wholesale
 * from its own window and deletes an out-of-process writer's lines. This
 * direction is the mirror image — the harness writes, this module only reads and
 * never writes — which is again the only arrangement where both can be right.
 */
export const PROBE_INTENT_DIR = 'floor-probe-intents';

/**
 * One declared intent. The harness writes these; nothing here writes them.
 *
 * `job` is GitHub's job NAME, because that is what the jobs listing answers with
 * and it is the wave's settled job key. `node` and `runnerName` are carried for
 * the log line and for an operator reading the directory by eye — the SUPPRESSION
 * does not consult them, because what matters is that somebody has already
 * arranged for this job to be served, not where.
 */
export interface ProbeIntent {
	repo: string;
	job: string;
	node?: string;
	runnerName?: string;
	/** Absolute epoch ms. Past it the declaration is ignored — see below. */
	expiresAtMs: number;
}

/**
 * The longest a declaration may reach into the future.
 *
 * AN INTENT IS A LICENCE TO NOT MINT, so an unbounded one is a licence to let a
 * unit queue forever. The harness's own runner lives `PROBE_TTL_SECONDS` = 900 s
 * and its watch loop is bounded well inside that, so 15 minutes covers every
 * honest declaration; anything claiming longer is a stale file, a clock skew or a
 * hand-edit, and is refused with a reason rather than honoured. This is the
 * `no gate may get EASIER to pass the worse the failure gets` rule applied to a
 * suppression: the failure mode of the mechanism must not be "mints nothing".
 *
 * SIXTEEN minutes and not fifteen, which is the harness's `PROBE_TTL_SECONDS`
 * exactly: the writer and the reader are different processes on different boxes
 * reading different clocks, and a ceiling equal to the honest TTL refuses every
 * declaration the moment the dispatcher's clock sits a millisecond behind the
 * harness's. The 60 s of slack is the tolerance, and `probe-intent.test.ts`
 * asserts the two numbers stay in this relationship.
 */
export const PROBE_INTENT_MAX_MS = 960_000;

/**
 * Separator for the `(repo, job name)` key, spelled as an ESCAPE.
 *
 * A job name can contain a space — `hadoku_site` has one called `Build variants`
 * — so a space separator makes two different keys collide in shapes nobody
 * notices until a suppression lands on the wrong job. NUL cannot appear in
 * either half.
 *
 * WRITTEN `\u0000` AND NEVER AS THE BYTE, which is not style.
 * `floor-probe-2026-09-08.md` §2.5 records seven literal NULs in
 * `scripts/lib/floor-probe.mjs` that WORKED perfectly — join and split agreed,
 * every gate passed — while making git classify the file as binary: no
 * `git diff`, no `git grep`, no code review. That file went through a full
 * review pass invisible. This very line reproduced the trap on the first
 * attempt, caught only because `grep` stopped answering about this file, and the
 * test beside it now fails on a re-introduced literal.
 */
const INTENT_KEY_SEP = '\u0000';

/** Intents already logged this process, so a live probe is announced once. */
const announcedIntents = new Set<string>();

/**
 * Live probe intents, from disk.
 *
 * UNREADABLE IS NO SUPPRESSION, which is the opposite of this file's usual
 * "fail toward doing nothing" and is deliberate. Everywhere else a failure here
 * means fewer mints; here a failure that produced MORE suppression would stop
 * the fleet minting for real work, and "I could not look" would render as "the
 * fleet is busy". The cost of the other direction is one wasted registration the
 * reaper already clears — exactly the cost this mechanism exists to remove, and
 * the right one to fall back to.
 */
export function readProbeIntents(nowMs: number): ProbeIntent[] {
	const dir = join(stateDir(), PROBE_INTENT_DIR);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		// ENOENT is the normal state on a fleet that is not probing.
		return [];
	}
	const live: ProbeIntent[] = [];
	for (const name of names) {
		if (!name.endsWith('.json')) continue;
		let e: Partial<ProbeIntent>;
		try {
			e = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<ProbeIntent>;
		} catch {
			// One bad file is not a bad directory — same rule as loadProbeLedger.
			continue;
		}
		if (typeof e.repo !== 'string' || typeof e.job !== 'string') continue;
		if (typeof e.expiresAtMs !== 'number' || !Number.isFinite(e.expiresAtMs)) continue;
		if (e.expiresAtMs <= nowMs) continue;
		if (e.expiresAtMs - nowMs > PROBE_INTENT_MAX_MS) {
			// SAY WHY. A declaration reaching past the harness's own runner TTL is
			// the one failure of this mechanism that could stall the fleet, and a
			// silent refusal would leave an operator staring at a probe that keeps
			// losing the race for no visible reason.
			if (!announcedIntents.has(`bad:${name}`)) {
				announcedIntents.add(`bad:${name}`);
				logger.warn(
					`[dispatch-tick] ignoring probe intent ${name}: expires ` +
						`${Math.round((e.expiresAtMs - nowMs) / 1000)}s out, past the ` +
						`${PROBE_INTENT_MAX_MS / 1000}s ceiling — a stale file or a clock skew, not a probe`
				);
			}
			continue;
		}
		live.push({
			repo: e.repo,
			job: e.job,
			node: e.node,
			runnerName: e.runnerName,
			expiresAtMs: e.expiresAtMs,
		});
	}
	return live;
}

/** Tests only: the announce-once set is module state. */
export function __resetProbeIntentStateForTesting(): void {
	announcedIntents.clear();
}

/**
 * Recovery probes per pass. Bounds the cost of a large outage's debris, and the
 * remainder is simply picked up on the following interval — a starved run that
 * gets minted for leaves the queue, so the set drains rather than repeating.
 */
export const MAX_RECOVERY_PROBES = 5;

let lastRecoveryMs = 0;

/** Tests only: the clock is module state, so it must be resettable between them. */
export function resetRecoveryClock(): void {
	lastRecoveryMs = 0;
}

export interface DispatchTickInput {
	/**
	 * Nodes the dispatcher may mint on, in placement order (see
	 * runners/traffic.ts): the ephemeral claws, then any on-demand guest.
	 */
	order: string[];
	nodes: NodeState[];
	/** Every fleet repo — the poll universe and the reap universe. */
	repos: string[];
	/** Jobs per day per repo, for the hot/cold poll split. */
	recentJobCounts: ReadonlyMap<string, number>;
	labelsFor: (node: string) => string[];
	memoryMaxMbFor: (repo: string, node: string) => number;
	/** See `DispatchPassInput.sliceNameFor`. */
	sliceNameFor?: (node: string) => string | null | undefined;
	homeDir: string;
	ttlSeconds: number;
	/**
	 * Age a run must reach before it is mintable. Omit for `MIN_QUEUED_MS`.
	 *
	 * The caller passes `SATURATED_QUEUED_MS` when it has OBSERVED that the
	 * standing nodes above an ephemeral one have no free slots — see that
	 * constant for why the default gate is a proxy for exactly that, and what
	 * the proxy costs.
	 */
	minQueuedMs?: number;
}

export async function runDispatchTick(
	input: DispatchTickInput,
	token: string,
	gh: GhLike & {
		get: (path: string, token: string, repo?: string) => Promise<unknown>;
		/**
		 * Conditional GET. OPTIONAL so every existing caller and test keeps working
		 * — absent means fall back to the plain `get`, which is correct, just paid
		 * for. See ghGetConditional.
		 */
		getConditional?: <T>(
			path: string,
			token: string,
			repo: string,
			etag: string | null
		) => Promise<
			{ status: 'ok'; body: T; etag: string | null } | { status: 'unchanged' } | { status: 'error' }
		>;
	},
	sh: ShellLike,
	nowMs = Date.now()
): Promise<DispatchPassResult> {
	const empty = { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	if (!input.order.length) return empty;

	// deriveHotRepos, not an inlined `>= 20`. The threshold was duplicated here
	// while the function that owns it sat uncalled — and a comment two files away
	// claimed it was what stopped the hot list going stale. One definition.
	const hotRepos = deriveHotRepos(input.recentJobCounts);
	const due = reposDue(input.repos, { ...DEFAULT_POLL_POLICY, hotRepos }, lastPolledMs, nowMs);

	// STAMPED BEFORE THE AWAITS, for the reason the reap gate is: a slow pass must
	// not let the next one in behind it and double the cost this was gated to
	// bound. Decided once for the whole tick so every repo in the fan-out agrees.
	const recoveryDue = nowMs - lastRecoveryMs >= RECOVERY_INTERVAL_MS;
	if (recoveryDue) lastRecoveryMs = nowMs;

	// READ ONCE PER TICK, like the reap gate, so every repo in the fan-out below
	// agrees about what is declared. One readdir of a directory that is empty
	// except while somebody is probing.
	const intents = readProbeIntents(nowMs);
	const declared = new Set(intents.map((i) => `${i.repo}${INTENT_KEY_SEP}${i.job}`));
	/** Jobs this tick did not mint for because a probe said it was serving them. */
	const yielded: string[] = [];

	const pending: (QueuedRun & {
		id: number;
		repo: string;
		jobId: number;
		jobName?: string;
		jobCreatedAt?: string;
	})[] = [];
	const stuckRuns: string[] = [];
	/**
	 * Repos whose queued listing was actually READ this tick — including a 304,
	 * which is a read of the cached body and not a failure to look.
	 *
	 * The prune of the announced-stuck book consults this and nothing else: a
	 * repo missing from it was not observed, and an entry may never be dropped on
	 * the strength of a listing nobody managed to fetch.
	 */
	const polledOk = new Set<string>();
	/** Past the age gate but with no job waiting — held by concurrency or a dependency. */
	const blockedRuns: string[] = [];
	const runningJobs: RunningJob[] = [];
	/** `repo#runId` of every candidate this tick, probed or backed off. */
	const candidateKeys = new Set<string>();
	/** Candidates not probed this tick because no node could take them (#117). */
	const backedOff: string[] = [];
	// BOUNDED, not `Promise.all`. One token serves the dispatcher, the fleet loop
	// and runner-health, and a wide simultaneous burst trips GitHub's SECONDARY
	// rate limit — which returns 403 and stalls all three, not just this sweep.
	//
	// This was unbounded and survived only because most repos were COLD, so few
	// came due per tick. Once the poll interval went below the tick every repo
	// came due EVERY tick, and `ci:queue-health` started failing with "could not
	// read the queue for 26 repo(s)" — all 26 at once, which is a burst
	// signature rather than 26 independent faults.
	//
	// Costs no discovery latency: 26 listings at six-wide is five rounds of
	// single-digit seconds inside a 60s tick.
	await mapConcurrent(due, SWEEP_CONCURRENCY, async (repo) => {
		lastPolledMs.set(repo, nowMs);
		type RunsResponse = { workflow_runs?: QueuedRun[] } | null;
		let resp: RunsResponse = null;
		const PATH = '/actions/runs?status=queued&per_page=30';
		try {
			if (gh.getConditional) {
				// CONDITIONAL, because a 304 is free and almost every poll is one.
				// This listing is 26 calls a tick; on 2026-09-04 it exhausted the
				// 5,000/hr budget and 424 of 478 rate-limited calls were this exact
				// path. Sending If-None-Match makes the unchanged case cost nothing
				// while keeping the discovery cadence that got queue time down.
				const c = await gh.getConditional<NonNullable<RunsResponse>>(
					PATH,
					token,
					repo,
					etagByRepo.get(repo) ?? null
				);
				if (c.status === 'unchanged') {
					// The listing is IDENTICAL to last tick — but runs AGE, so a run
					// that was too young then may be mintable now. Re-evaluate the
					// cached body rather than skipping the repo, or a job discovered
					// inside the age gate would wait for its content to change.
					resp = cachedRunsByRepo.get(repo) ?? null;
				} else if (c.status === 'ok') {
					resp = c.body;
					if (c.etag) etagByRepo.set(repo, c.etag);
					else etagByRepo.delete(repo);
					cachedRunsByRepo.set(repo, c.body);
				} else {
					// An error must NOT reuse the cache: stale queued runs would be
					// minted for again on every tick while the API is down.
					resp = null;
				}
			} else {
				resp = (await gh.get(PATH, token, repo)) as RunsResponse;
			}
		} catch {
			resp = null;
		}
		// `null` is the error return, NOT an empty queue. Treating the two the
		// same is how a fleet-wide API failure reads as "nothing to do".
		if (!resp?.workflow_runs) return;
		polledOk.add(repo);
		const { mintable, stuck, stranded } = mintableRuns(resp.workflow_runs, {
			nowMs,
			minQueuedMs: input.minQueuedMs,
		});
		for (const r of stuck) stuckRuns.push(`${repo}#${r.id}`);
		// STARVED IS NOT UNSERVABLE, and only the jobs probe can tell them apart.
		// A run past the age ceiling gets the same question a mintable one gets,
		// and the existing `runnableJobs` answer below decides it: queued job ->
		// mint, no queued job -> `blockedRuns`, never minted for. Folding these
		// into the same list rather than writing a second path is deliberate —
		// two probe paths would be two places for the "no jobs" guard to be
		// forgotten, and forgetting it is what burns a slot an hour forever.
		const candidates = recoveryDue
			? [...mintable, ...stranded.slice(0, MAX_RECOVERY_PROBES)]
			: mintable;

		// One call per CANDIDATE run — only runs already past the age gate, which
		// is a small set — to find out what is actually waiting for a runner and
		// what it asked for. A run's own `queued` answers neither question.
		await Promise.all(
			candidates.map(async (r) => {
				type JobsResponse = { jobs?: QueuedJob[] } | null;
				const key = `${repo}#${r.id}`;
				candidateKeys.add(key);
				const held = probeBackoff.get(key);
				if (
					held &&
					nowMs < held.untilMs &&
					held.fingerprint === placementFingerprint(input.nodes, repo, held.wanted)
				) {
					backedOff.push(key);
					// Its last-seen RUNNING siblings still count toward their nodes —
					// the direction that holds work back, never the one that overfills.
					for (const j of jobsCacheByRun.get(key)?.body.jobs ?? []) {
						if (j.status === 'in_progress' && j.runner_name && j.name) {
							runningJobs.push({ repo, runner: j.runner_name, jobName: j.name });
						}
					}
					return;
				}
				// Probed now, so the pass below decides afresh whether it backs off.
				probeBackoff.delete(key);
				const path = `/actions/runs/${r.id}/jobs`;
				let jobs: JobsResponse = null;
				try {
					jobs = await withGhCaller('dispatch-probe', async () => {
						if (!gh.getConditional) return (await gh.get(path, token, repo)) as JobsResponse;
						const cached = jobsCacheByRun.get(key);
						const c = await gh.getConditional<NonNullable<JobsResponse>>(
							path,
							token,
							repo,
							cached?.etag ?? null
						);
						if (c.status === 'unchanged') return cached?.body ?? null;
						if (c.status === 'ok') {
							jobsCacheByRun.set(key, { etag: c.etag, body: c.body });
							return c.body;
						}
						// An error must NOT reuse the cache, for the reason the runs
						// listing's error path gives: a stale "queued" would be minted
						// for while GitHub cannot be read.
						return null;
					});
				} catch {
					jobs = null;
				}
				// Unreadable is NOT "no jobs waiting". Fail toward not minting.
				if (!jobs?.jobs) return;
				// THE SIBLINGS ALREADY RUNNING, from the listing just read — free,
				// and fresher than the fleet probe, which is up to a fast-loop tick
				// old and did not yet see the warm listener that took a Forge shard
				// 11 s before the 22:08:09Z tick of 2026-10-08 (see
				// `DispatchPassInput.runningJobs`).
				for (const j of jobs.jobs) {
					if (j.status === 'in_progress' && j.runner_name && j.name) {
						runningJobs.push({ repo, runner: j.runner_name, jobName: j.name });
					}
				}
				const waiting = runnableJobs(jobs.jobs);
				if (!waiting.length) {
					blockedRuns.push(`${repo}#${r.id}`);
					return;
				}
				// One mint serves one job. Labels come from the job that is waiting,
				// and so does `jobId` — carrying it is what makes the entries of a
				// multi-job run distinguishable downstream. Without it they differ
				// only in `labels`, and the name derived from them collided.
				for (const j of waiting) {
					// THE PROBE'S DECLARED INTENT, AND THE ONLY PLACE IT IS HONOURED.
					// A job somebody has already minted a listener for does not need a
					// second one, and minting anyway is the wasted competitor of
					// floor-probe-2026-09-08.md §2.1 — which is not only a cost: all four
					// misses in the eleven-probe sweep landed on a node still holding the
					// PREVIOUS probe's leftover competitor, so two idle matching runners
					// existed and GitHub picked.
					//
					// SCOPED TO ONE (repo, job NAME) and nothing wider. Every other job of
					// the same run is minted for as usual: the probe arranged for exactly
					// one job, and suppressing its siblings would leave them queued with
					// nothing listening.
					//
					// FILTERED HERE rather than inside `planTick`, where this decision
					// conceptually belongs: `PendingRun` carries `jobId` and `labels` and no
					// job NAME, and the name is the only key the harness can declare BEFORE
					// a run id exists — which it must, because the dispatcher mints within
					// ~3s of seeing the job and a declaration that waits for the run id has
					// already lost the race (§2.1, measured). So the skip is logged here
					// rather than arriving in planTick's `skipped`: a dispatcher that
					// silently drops a job is indistinguishable from one that never saw it.
					if (typeof j.name === 'string' && declared.has(`${repo}${INTENT_KEY_SEP}${j.name}`)) {
						yielded.push(`${repo}#${j.name}`);
						continue;
					}
					// #89: the queued JOB's own name, not the run's — `PendingRun.jobName`
					// is what `SpeedModel.expectedExtraSec` needs for its (repo, job)
					// lookup. Without it every placement decision ran at the coarser
					// repo-level estimate; this is the one line that was missing.
					pending.push({
						...r,
						id: r.id,
						repo,
						jobId: j.id,
						labels: j.labels ?? [],
						jobName: j.name,
						// #96: the JOB's own wait, not the run's.
						jobCreatedAt: j.created_at,
					});
				}
			})
		);
	});

	// Resolved ONCE per tick, memoised for a day inside runnerTarballUrl, and
	// only ever read by a node that has no JIT payload yet. Null is fine: it
	// degrades to the behaviour that existed before the bootstrap fix.
	const tarballUrl = await runnerTarballUrl(gh.get, token, input.repos[0] ?? '');

	const res = await runDispatchPass(
		{
			order: input.order,
			tarballUrl,
			nodes: input.nodes,
			pending,
			runningJobs,
			repos: input.repos,
			labelsFor: input.labelsFor,
			homeDir: input.homeDir,
			memoryMaxMbFor: input.memoryMaxMbFor,
			sliceNameFor: input.sliceNameFor,
			ttlSeconds: input.ttlSeconds,
			// ONE clock for the tick. `reposDue` above already gates on this
			// `nowMs`; letting the reap gate read `Date.now()` separately would put
			// two cadences on one tick and make the sweep untestable from here.
			nowMs,
		},
		token,
		gh,
		sh
	);
	recordProbeBackoff(input.nodes, pending, res.unplaceable ?? [], nowMs);
	// Forget runs that have left the queue, so neither book grows for ever. Only
	// for repos read this tick: a repo not polled has not shown its runs gone.
	for (const book of [jobsCacheByRun, probeBackoff]) {
		for (const k of book.keys()) {
			if (polledOk.has(k.slice(0, k.lastIndexOf('#'))) && !candidateKeys.has(k)) book.delete(k);
		}
	}
	if (yielded.length) {
		// ONE LINE PER PROBE, not per tick. The declaration stands for the life of the
		// probe — a dozen ticks — and a line every 15 s would turn the thing that
		// proves the mechanism works into the thing nobody reads, which is the rule
		// `warnedStuck` exists for. Keyed on the (repo, job) pair, so a second probe
		// of the same unit after the first released its intent says so again.
		const fresh = [...new Set(yielded)].filter((k) => !announcedIntents.has(k));
		for (const k of fresh) announcedIntents.add(k);
		if (fresh.length) {
			logger.info(
				`[dispatch-tick] not minting for ${fresh.length} job(s) a floor probe declared it is ` +
					`serving (said ONCE per unit): ${fresh.slice(0, 5).join(', ')}` +
					(fresh.length > 5 ? ` (+${fresh.length - 5} more)` : '')
			);
		}
	}
	if (blockedRuns.length) {
		logger.info(
			`[dispatch-tick] ${blockedRuns.length} queued run(s) have no job waiting for a runner ` +
				`(concurrency group, needs:, or approval) — capacity cannot help them: ` +
				blockedRuns.slice(0, 5).join(', ')
		);
	}
	loadWarnedStuck();
	const stuckNow = new Set(stuckRuns);
	const newlyStuck = stuckRuns.filter((k) => !warnedStuck.has(k));
	// OBSERVED GONE, never merely absent — see property 3 on the book above.
	// Caveat worth knowing: the listing is `per_page=30`, so a repo holding more
	// than 30 queued runs could push an old zombie off the page and have it read
	// as cleared. It would then be announced once more when the queue drains,
	// which is the harmless direction; the fleet's worst recorded queue was six.
	const clearedStuck = [...warnedStuck.keys()].filter(
		(k) => !stuckNow.has(k) && polledOk.has(repoOfStuckKey(k))
	);
	if (newlyStuck.length || clearedStuck.length) {
		const at = new Date(nowMs).toISOString();
		for (const k of newlyStuck) warnedStuck.set(k, at);
		for (const k of clearedStuck) warnedStuck.delete(k);
		persistWarnedStuck();
	}
	if (newlyStuck.length) {
		// THE TOTAL IS IN THE LINE, not just the new ids. This is the one line the
		// mechanism emits, and a reader who cannot see the population from it would
		// have no way to tell one new zombie from a fleet drowning in them.
		logger.warn(
			`[dispatch-tick] ${newlyStuck.length} NEW run(s) queued past the stuck ceiling ` +
				`(${stuckRuns.length} stuck in total) — nothing will take these and minting cannot ` +
				`help. Said ONCE per run and the book SURVIVES A RESTART (${STUCK_ANNOUNCED_FILE}); ` +
				`ci:queue-health counts the standing population on every run: ` +
				`${newlyStuck.slice(0, 5).join(', ')}` +
				(newlyStuck.length > 5 ? ` (+${newlyStuck.length - 5} more)` : '')
		);
	}
	if (clearedStuck.length) {
		// The other half of "only on change". Without it the book empties silently
		// and an operator has no way to learn that the thing they were paged about
		// is gone — or that the prune works at all.
		logger.info(
			`[dispatch-tick] ${clearedStuck.length} previously-stuck run(s) are gone from the queue ` +
				`and will be announced again if they return: ${clearedStuck.slice(0, 5).join(', ')}` +
				(clearedStuck.length > 5 ? ` (+${clearedStuck.length - 5} more)` : '')
		);
	}
	if (res.minted || res.failed || res.reaped) {
		logger.info(
			`[dispatch-tick] polled=${due.length}/${input.repos.length} queued=${pending.length} ` +
				`minted=${res.minted} failed=${res.failed} ` +
				// `skipped`, never a bare 0. The reap runs on its own clock now, so
				// most passes do not sweep — and a line reading `reaped=0` on every
				// tick is exactly how a sweep that has stopped running goes unnoticed.
				`reaped=${res.reaped ?? 'skipped'}`
		);
	}
	return res;
}

/**
 * Back off every run whose EVERY pending job this pass refused as unplaceable.
 * A run with one job minted or in flight is moving, and is probed as usual.
 */
function recordProbeBackoff(
	nodes: readonly NodeState[],
	pending: readonly { id: number; repo: string; labels?: string[] }[],
	unplaceable: readonly SkipReason[],
	nowMs: number
): void {
	const jobsOf = new Map<string, { labels?: string[] }[]>();
	for (const p of pending) {
		const k = `${p.repo}#${p.id}`;
		jobsOf.set(k, [...(jobsOf.get(k) ?? []), p]);
	}
	const skipsOf = new Map<string, SkipReason[]>();
	for (const s of unplaceable) {
		const k = `${s.repo}#${s.runId}`;
		skipsOf.set(k, [...(skipsOf.get(k) ?? []), s]);
	}
	const fresh: string[] = [];
	for (const [k, skips] of skipsOf) {
		const jobs = jobsOf.get(k) ?? [];
		if (skips.length !== jobs.length) continue;
		const release = Math.min(...skips.map((s) => s.releaseAtMs ?? Infinity));
		const untilMs = Math.min(nowMs + PROBE_BACKOFF_MS, release);
		if (untilMs <= nowMs) continue;
		const repo = skips[0].repo;
		const wanted = jobs.map((j) => j.labels ?? []);
		probeBackoff.set(k, {
			untilMs,
			fingerprint: placementFingerprint(nodes, repo, wanted),
			wanted,
		});
		fresh.push(`${k} ${Math.round((untilMs - nowMs) / 1000)}s`);
	}
	if (fresh.length) {
		// Says why the `skipped run` lines go quiet: the run is still queued and
		// still unplaceable, it is simply not being re-asked every tick.
		logger.info(
			`[dispatch-tick] no node can take ${fresh.length} run(s); not re-probing until a node ` +
				`that could changes or the hold releases: ${fresh.slice(0, 5).join(', ')}` +
				(fresh.length > 5 ? ` (+${fresh.length - 5} more)` : '')
		);
	}
}

/** Test seam: the poll cadence is module state and a test must be able to reset it. */
export function __resetPollStateForTesting(): void {
	lastPolledMs.clear();
	// The announced-stuck book is a FILE now, so clearing the Map is only half a
	// reset. Left on disk, the first test's zombie silences the next test's and
	// the suppression passes a test it never earned.
	warnedStuck.clear();
	warnedStuckLoaded = false;
	stuckStoreComplaints.clear();
	rmSync(join(stateDir(), STUCK_ANNOUNCED_FILE), { force: true });
	// The conditional-poll cache is poll state too. Left behind, one test's ETag
	// makes the next test's first poll answer 304 against a body it never set.
	etagByRepo.clear();
	cachedRunsByRepo.clear();
	jobsCacheByRun.clear();
	probeBackoff.clear();
	// The reap clock is the OTHER cadence a tick carries. Left behind, the first
	// test's sweep gates every later test's, and they assert `reaped: skipped`
	// while believing they proved something about dispatch.
	__resetReapClockForTesting();
	// The announce-once set for probe intents is poll state too: left behind, a
	// second test's suppression is silent and a test asserting the log line reads
	// the first test's.
	announcedIntents.clear();
}

/**
 * Tests only: drop the PROCESS's half of the announced-stuck book and leave the
 * file, which is exactly what an mgmt-api deploy does.
 *
 * Without this seam a ten-tick test proves only what the old code already did —
 * dedup inside one process — and issue #25 was never about one process.
 */
export function __restartAnnouncedStuckForTesting(): void {
	warnedStuck.clear();
	warnedStuckLoaded = false;
	stuckStoreComplaints.clear();
}
