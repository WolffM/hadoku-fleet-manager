/**
 * Which repos to ask about, and how often — B1's decision as code.
 *
 * A JIT dispatcher has to find out that a job is waiting. §12.17 settled that a
 * POLL does this, with no webhook: the poll is O(repos) where today's fast loop
 * is O(repos x nodes), so adding nodes stops costing API budget, and a
 * poll is its own reconciliation so an mgmt-api restart costs one cadence of
 * latency rather than a dropped job.
 *
 * The cadence is TIERED because the load is. Two repos are 71% of 20,129 runs a
 * month and roughly two dozen run 1-10 jobs each (§4), so polling all of them at
 * the same rate spends most of its budget on repos that are almost never busy.
 * Hot at 60s / cold at 10 min is 264 calls/hr against a measured 585/hr for
 * today's control plane.
 */

export interface PollPolicy {
	/** Repos worth asking about every cadence. Derived from observed volume, not
	 * hand-listed — a repo that becomes busy must become hot on its own. */
	hotRepos: ReadonlySet<string>;
	hotIntervalMs: number;
	coldIntervalMs: number;
}

/**
 * COLD MUST FIT INSIDE THE QUEUE-HEALTH FLOOR. It did not, and that alone made
 * `ci:queue-health` fail on healthy fleets.
 *
 * check-queue-health.mjs budgets the worst legitimate serve as "MIN_QUEUED_MS
 * plus a fast-loop tick plus a ~9 s mint, so ~160 s" and sets FAIL_SECONDS to 300.
 * That budget never included DISCOVERY. A cold repo was not looked at for up to
 * 600 s — twice the fail threshold before any work could begin — so a job in any
 * of the ~24 cold repos aged past the floor while the fleet sat idle and the
 * dispatcher minted every run it could actually see. Measured 2026-09-02:
 * hadoku-jobplatform waited 592 s, one cold interval almost exactly, while
 * every tick reported `minted == queued`.
 *
 * 120 s makes the gate's own arithmetic true: 120 s discovery + the 30 s
 * SATURATED_QUEUED_MS gate an all-JIT fleet always takes + ~9 s to mint = 159 s,
 * which is the ~160 s that file already claims is the worst legitimate serve.
 *
 * The cost is API calls, and there is room: ~24 cold repos at 120 s plus the hot
 * ones is ~840 calls/hr against GitHub's 5,000/hr authenticated ceiling. The
 * 264/hr this file used to cite was measured against a fleet where standing
 * runners answered without being asked; under all-JIT nothing starts until a
 * poll finds it, so discovery latency IS queue latency and the budget is worth
 * spending.
 *
 * `queue-cadence.test.mjs` fails the build if these two ever contradict again.
 */
/**
 * THE INTERVAL MUST BE BELOW THE TICK PERIOD, OR THE REAL CADENCE DOUBLES.
 *
 * `reposDue` is only consulted when the fast loop ticks, and that tick is
 * `pollSeconds` (60 s). A repo polled DURING a tick has its `lastPolled` set a
 * few seconds after the tick began, so at exactly 60 s it is not yet due when
 * the next tick asks — it waits for the one after. Interval == tick period
 * therefore polls every repo every OTHER tick.
 *
 * Measured 2026-09-02, after "uniform 60 s" shipped and changed nothing:
 *   tick polls all 26 repos, finishes 17:30:24 (craft's lastPolled ~17:30:20)
 *   job created                17:30:32
 *   next tick ~17:31:05        craft due at 17:31:20 — SKIPPED
 *   tick after ~17:32:05       polled, minted 17:32:01, started 17:32:04
 * 89 s of queue, of which the mint was 3 s.
 *
 * 30 s is half the tick, so every repo is due on every tick and the effective
 * cadence is the tick itself. It does NOT double the API cost: nothing can be
 * polled more often than the tick fires, so the ceiling stays 26 calls/tick =
 * ~1,560/hr against GitHub's 5,000.
 *
 * THE TICK THIS MUST SIT BELOW IS THE DISPATCHER'S, NOT THE LADDER'S. It was 30s
 * against a 60s ladder tick, which was right until 2026-09-05, when the
 * dispatcher moved to its own 15s timer and this was left behind — so a repo
 * came due every 30s and the extra passes found nothing new. Measured
 * immediately after that change: queue 32-37s where the timer alone predicted
 * ~17s. Decoupling the loops without re-checking this relationship reintroduced
 * exactly the bug the relationship exists to prevent.
 *
 * `queue-cadence.test.mjs` asserts the relationship rather than the number.
 */
export const DEFAULT_POLL_POLICY: Omit<PollPolicy, 'hotRepos'> = {
	hotIntervalMs: 10_000,
	// EQUAL TO HOT, deliberately. The split bought API budget that is no longer
	// scarce, and it was being paid for in queue time. Both are below the tick
	// period — see the note above; at 60 s this polled every repo every OTHER
	// tick and the "uniform 60 s" change measured as no change at all.
	//
	// Measured 2026-09-02, JIT jobs, created_at -> started_at:
	//   hadoku_site (hot, 60 s)   40 s, 41 s
	//   hadoku-craft (cold, 120s) 100 s, 107 s, 108 s
	// The whole difference is the cadence: a cold repo waits half its interval to
	// be LOOKED at before anything else can begin.
	//
	// Under all-JIT that wait is the job's wait. Nothing starts until a poll finds
	// it, so a cheaper poll is not a saving — it is latency charged to every job in
	// 24 of the 26 covered repos, on a fleet whose claws are usually idle. The
	// note on `recentJobsPerDay` records the same failure from the other side: an
	// empty history made every repo cold and jobs waited up to eleven minutes.
	//
	// 26 repos at 60 s is ~1,560 calls/hr against GitHub's 5,000/hr, and the poll
	// is flat in node count — the fast loop it replaced costs 2,925/hr at twenty
	// nodes. The knob stays because repo count can grow; today it should not be
	// spent.
	coldIntervalMs: 10_000,
};

/**
 * Promote a repo to hot from its own recent history.
 *
 * Hand-maintained hot lists go stale silently — a repo that gets busy keeps
 * being polled every ten minutes and nobody notices the added latency. The
 * threshold is deliberately low: being wrong costs 60 API calls an hour, and
 * being wrong the other way costs a repo up to ten minutes of queue latency.
 */
export function deriveHotRepos(
	recentJobCounts: ReadonlyMap<string, number>,
	minJobsPerDay = 20
): Set<string> {
	const hot = new Set<string>();
	for (const [repo, n] of recentJobCounts) if (n >= minJobsPerDay) hot.add(repo);
	return hot;
}

/**
 * The repos due for a poll right now.
 *
 * A repo never polled before is always due: startup must not wait out a cold
 * interval before noticing work that is already queued — which is exactly the
 * state an mgmt-api restart leaves behind, ~5 times a day.
 */
export function reposDue(
	repos: readonly string[],
	policy: PollPolicy,
	lastPolledMs: ReadonlyMap<string, number>,
	nowMs: number
): string[] {
	const due: string[] = [];
	for (const repo of repos) {
		const last = lastPolledMs.get(repo);
		if (last === undefined) {
			due.push(repo);
			continue;
		}
		const interval = policy.hotRepos.has(repo) ? policy.hotIntervalMs : policy.coldIntervalMs;
		if (nowMs - last >= interval) due.push(repo);
	}
	return due;
}

/** Steady-state API cost, so a cadence change is costed rather than guessed. */
export function pollCallsPerHour(repos: readonly string[], policy: PollPolicy): number {
	let n = 0;
	for (const r of repos) {
		n += 3_600_000 / (policy.hotRepos.has(r) ? policy.hotIntervalMs : policy.coldIntervalMs);
	}
	return Math.round(n);
}

/** One job inside a run, as the jobs endpoint reports it. */
export interface QueuedJob {
	id: number;
	name?: string;
	/** `queued` here means WAITING FOR A RUNNER — unlike a run's `queued`. */
	status?: string;
	/** Exactly what this job's `runs-on` asked for. */
	labels?: string[];
	/**
	 * When THIS JOB was created. A dependent job (`needs:`) is created only once
	 * its dependencies finish, so for every job after a run's first wave this is
	 * minutes later than the run's own timestamps (#96).
	 */
	created_at?: string;
	/** The runner GitHub assigned the job to; absent until it is assigned. */
	runner_name?: string | null;
}

/**
 * Jobs of a run that are actually waiting for a runner.
 *
 * THE DISTINCTION THIS FILE EXISTS TO MAKE. A queued RUN is not a job waiting
 * for a runner: it can be held by a `concurrency` group, a `needs:` dependency
 * or an environment approval, none of which more capacity solves. On 2026-08-29
 * the pilot minted a runner for `hadoku_site` #33257620981, which was blocked by
 * `concurrency: group: e2e-canary` — our listener came online, sat idle for its
 * full hour, and the job started on claw-2 seven minutes later when the group
 * freed. A run also carries no labels, so run-level polling cannot tell that a
 * job wants `pm2-host` on a node that has never had it.
 */
export function runnableJobs(jobs: readonly QueuedJob[]): QueuedJob[] {
	return jobs.filter((j) => j.status === 'queued');
}

export interface QueuedRun {
	id: number;
	name?: string;
	status?: string;
	/** ISO timestamp from the runs API. The age gate below needs it. */
	created_at?: string;
	/**
	 * When the CURRENT attempt started. Resets on a re-run; `created_at` does not.
	 *
	 * Without this a re-run inherits the original run's age, so re-running
	 * anything older than MAX_QUEUED_MS produced a run that was STUCK the instant
	 * it was dispatched and could never be minted for. Observed 2026-09-02:
	 * attempt 2 dispatched at 17:51:29 against created_at 16:49:21 read as 63
	 * minutes old and sat unserved for over an hour — "NO online runner matches
	 * its labels", which was true and permanent, because the dispatcher had
	 * written it off before looking.
	 */
	run_started_at?: string;
	/** Labels the job asked for. A run wanting labels this fleet cannot offer must
	 * not be minted for — it would spawn a runner nothing schedules onto. */
	labels?: string[];
}

/**
 * When the CURRENT attempt started queuing, epoch ms — the later of
 * `run_started_at` and `created_at`, exactly the precedence {@link mintableRuns}
 * already used before this was pulled out (see `run_started_at`'s own comment
 * above for why the later one, not the newer field alone, is correct: a run
 * nobody has re-run has `run_started_at == created_at` and is unaffected).
 *
 * `undefined` when neither timestamp parses — a run whose age cannot be
 * established, which `mintableRuns` already treats as "not minted for" rather
 * than as instantly stale or instantly fresh. PendingRun's `queuedSinceMs`
 * (wave 3w, #83) is this same answer, carried onto the per-job entry the
 * dispatcher actually walks — see `dispatcher.ts`'s `planTick`, which is where
 * it is computed today because the producer that builds `PendingRun`
 * (`dispatch-tick.ts`, outside this lane) does not yet call this itself.
 */
export function queuedSinceMs(
	run: Pick<QueuedRun, 'created_at' | 'run_started_at'>
): number | undefined {
	const createdAt = run.created_at ? Date.parse(run.created_at) : Number.NaN;
	const restartedAt = run.run_started_at ? Date.parse(run.run_started_at) : Number.NaN;
	const queuedAt = Number.isFinite(restartedAt) ? Math.max(createdAt || 0, restartedAt) : createdAt;
	return Number.isFinite(queuedAt) ? queuedAt : undefined;
}

/**
 * Epoch ms THIS JOB started waiting for a runner (#96).
 *
 * The run's age is the wrong clock for a job: a dependent job only exists once
 * its `needs:` finish, so a `deploy` or `publish` inside a run that started
 * minutes ago looked minutes old the instant it appeared, and the slow-tier
 * spill gate (#83) sent it straight to the slow node while normal claws had
 * room (hadoku-pygmalion run 37314167062: created 13:08:22, minted on claw-5
 * at 13:08:33). The job's own `created_at` is the start of its wait, bounded
 * below by the current attempt's start so a re-run is not read as older than
 * it is. A job with no parsable `created_at` falls back to the run's age, the
 * conservative-for-tests path production never takes (the jobs API always
 * carries it).
 */
export function jobQueuedSinceMs(
	run: Pick<QueuedRun, 'created_at' | 'run_started_at'>,
	jobCreatedAt: string | undefined
): number | undefined {
	const runQueued = queuedSinceMs(run);
	const jobCreated = jobCreatedAt ? Date.parse(jobCreatedAt) : Number.NaN;
	if (!Number.isFinite(jobCreated)) return runQueued;
	return runQueued === undefined ? jobCreated : Math.max(jobCreated, runQueued);
}

/**
 * How long a run must sit queued before JIT will mint for it.
 *
 * 90 s, matching the throttle's own give-up ceiling: that is the fleet's
 * existing answer to "how long is a wait that means something".
 */
export const MIN_QUEUED_MS = 90_000;

/**
 * The gate when the standing fleet is OBSERVED full.
 *
 * `MIN_QUEUED_MS` is a PROXY for "a standing runner would have taken this by
 * now". The fast loop measures the same thing directly, every 60 s, and the
 * proxy costs 90 seconds on every JIT job — so when free slots above an
 * ephemeral node are actually zero, the proxy is redundant and only expensive.
 *
 * MEASURED, 2026-09-01, against 4,997 standing-runner pickups and the 138 JIT
 * jobs of the pilot:
 *
 *   standing pickup queue   p50 4 s   p75 54 s   p90 117 s   p95 155 s
 *   54.5% of standing pickups land within 10 s — a slot was simply free
 *   claw-3 JIT queue medians ran 109-154 s against 6-95 s when it held
 *   standing runners, for jobs whose EXECUTION time was unchanged (0.95-1.13x)
 *
 * The pilot costed this as "13 cold mints/day at ~9 s each, about two minutes
 * of added latency per DAY". The mint was never the cost: the gate is, at ~90 s
 * per job. `Build variants` is 12 s of work behind 154 s of waiting.
 *
 * 30 s, and the three numbers that pick it:
 *
 *   - ABOVE the 54.5% mass that lands inside 10 s, so the common "a slot was
 *     free" case still never mints. Minting for those is pure waste.
 *   - BELOW the 60 s fast-loop tick, so an ephemeral node gets its chance a full
 *     tick before the ladder promotes the tier BELOW it. That is the whole
 *     point: hokon carries ~26 standing registrations and answers in seconds,
 *     claw-3 answers in ~2.5 minutes, so tier3 lost every race it outranks
 *     tier4 to win — and the production host absorbed the surge instead.
 *   - roughly the median claw job duration (20-38 s), so a slot freeing inside
 *     the window is possible but most of the p75=54 s tail is still ahead.
 *
 * It is NOT zero. Saturation is observed at most 60 s ago and a slot can free
 * in the meantime; a floor keeps the dispatcher honest about that. It is also
 * only ever REACHED when saturation was measured — never assumed.
 */
export const SATURATED_QUEUED_MS = 30_000;

/**
 * Past this, a run is STUCK rather than starved and minting cannot help it.
 *
 * The pilot's first two mints went to runs queued since 2026-08-17 and
 * 2026-08-19 — ten and twelve days. Nothing will ever pick those up (a deleted
 * branch, a label no runner carries, a cancelled dependency), so a floor-only
 * gate mints for them every time the previous attempt TTLs out: a treadmill that
 * burns a slot an hour, forever, on work that does not exist.
 *
 * One hour is ~22x the fleet's measured queue p95 of 161 s. A run that has
 * genuinely waited that long in a 12-slot fleet is not waiting for capacity.
 */
export const MAX_QUEUED_MS = 3_600_000;

/**
 * Past THIS, a stuck run is a ZOMBIE rather than merely stranded.
 *
 * ONE BOUNDARY, ONE NAME. `scripts/lib/queue-health.mjs` splits the same
 * population with `ZOMBIE_SECONDS`, and the two must agree or the gate reports
 * a run as recoverable that the dispatcher will never mint for —
 * `queue-discovery.test.ts` asserts the equality rather than trusting it.
 *
 * `MAX_QUEUED_MS` answers "is this still waiting for capacity". It is not the
 * same question as "could this ever run again", and conflating them is what
 * left six serviceable runs orphaned by the egress outage of 2026-09-07: the
 * control plane was down 2h04m, everything queued during it aged past the
 * one-hour ceiling, and the dispatcher then refused them FOREVER. They were not
 * stuck in the sense that constant means — nothing was wrong with them at all,
 * and each ran green the moment it was re-queued by hand.
 *
 * So a stuck run inside this window is offered the SAME jobs probe a mintable
 * run gets, and the answer decides it: a run with a queued job is STARVED and
 * gets minted for; a run with none is UNSERVABLE and is left alone. That is not
 * a new judgement, it is the one `runnableJobs` already makes for every
 * candidate — the bug was never asking.
 *
 * 24 hours, and the ceiling is what keeps the pilot's treadmill dead. The two
 * runs `MAX_QUEUED_MS` was written for (2026-08-17, 2026-08-19) are 488 h and
 * 457 h old, so they are excluded by AGE before any call is made for them —
 * they cost nothing to keep refusing. They are also excluded a second time on
 * the merits: both report `total_count: 0` jobs, which is why nothing was ever
 * going to pick them up and why minting for them burned a slot an hour.
 */
export const ZOMBIE_MS = 86_400_000;

/**
 * Runs this dispatcher should consider minting for.
 *
 * Filters to `queued` only. An `in_progress` run already has a runner, and
 * minting for one is how a fleet grows a second listener for work that is
 * already being done — the leak §12.8 describes, arrived at from the other end.
 *
 * AND TO RUNS THE STANDING FLEET DID NOT ABSORB. Every repo still has standing
 * runners on the non-ephemeral nodes, and those pick work up within seconds.
 * Minting the instant something appears in the queue therefore races them for a
 * run only ONE runner can have — and the loser is a live listener holding a slot
 * until its RuntimeMaxSec, which is `JIT_UNIT_MAX_SEC` — GitHub's own job
 * ceiling plus a cleanup margin, six and a half hours, NOT the hour this said
 * until 2026-09-14. That number was 3600 and was read as an orphan timeout;
 * issue #22 is what it cost. The reasoning below is unchanged and only gets
 * stronger: a loser now holds its slot for longer, not less, so racing the
 * standing fleet for a run is more expensive than this paragraph claimed.
 * Orphans are collected by the reap sweep, which deletes the REGISTRATION; the
 * unit ceiling is only a backstop against a wedged one.
 * A run still queued after 90 s is one nothing standing could take, which is
 * exactly the case JIT exists for.
 *
 * A run with no `created_at` is NOT minted for. Age is the whole gate, and a run
 * whose age cannot be established is one we cannot say is starved — failing
 * toward doing nothing costs a delayed job, failing the other way costs a
 * speculative runner on every queued run in the fleet.
 */
export function mintableRuns(
	runs: readonly QueuedRun[],
	opts: {
		nowMs?: number;
		minQueuedMs?: number;
		maxQueuedMs?: number;
		zombieMs?: number;
	} = {}
): { mintable: QueuedRun[]; stuck: QueuedRun[]; stranded: QueuedRun[] } {
	const nowMs = opts.nowMs ?? Date.now();
	const minQueuedMs = opts.minQueuedMs ?? MIN_QUEUED_MS;
	const maxQueuedMs = opts.maxQueuedMs ?? MAX_QUEUED_MS;
	const zombieMs = opts.zombieMs ?? ZOMBIE_MS;
	const mintable: QueuedRun[] = [];
	const stuck: QueuedRun[] = [];
	// A SUBSET of `stuck`, never a fourth bucket. `stuck` keeps meaning exactly
	// what it always did — everything past the age ceiling — so the reporting
	// built on it is unchanged and a recovery candidate is still visible as the
	// stuck run it is.
	const stranded: QueuedRun[] = [];
	for (const r of runs) {
		if (r.status !== 'queued' || !r.created_at) continue;
		// The LATER of the two, so a re-run is aged from the attempt that is
		// actually waiting. Taking the later one keeps the stuck ceiling honest:
		// a run nobody has re-run has run_started_at == created_at and is
		// unaffected, so this can only ever make a run look YOUNGER when GitHub
		// says a new attempt began. Pulled out as `queuedSinceMs` (above) so
		// `PendingRun`'s own queue age (wave 3w, #83) is the SAME answer rather
		// than a second copy of this arithmetic.
		const queuedAt = queuedSinceMs(r);
		if (queuedAt === undefined) continue;
		const age = nowMs - queuedAt;
		if (age < minQueuedMs) continue;
		// Reported, not silently dropped. A run nothing will ever take is a real
		// problem for someone — it just is not one more capacity can solve.
		if (age > maxQueuedMs) {
			stuck.push(r);
			if (age <= zombieMs) stranded.push(r);
		} else mintable.push(r);
	}
	return { mintable, stuck, stranded };
}
