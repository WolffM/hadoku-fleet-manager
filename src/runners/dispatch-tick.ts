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
 *
 * SPLIT (wave shrink-1 lane B, 800-line ceiling): the cadence constants and
 * `DispatchTickInput` live in `dispatch-tick-config.ts`; the test-only reset
 * seams, most of which aggregate state this file's own sub-modules already
 * own, live in `dispatch-tick-reset.ts` — both re-exported here under their
 * original path.
 */

import { logger } from '../host.js';
import { noteTick } from '../lib/liveness.js';
import { subCadence } from '../lib/every.js';
import { withGhCaller } from '../gh-budget.js';
import { runDispatchPass } from './dispatch-pass.js';
import { type DispatchPassResult, type RunningJob } from './dispatch-pass-types.js';
import { SWEEP_CONCURRENCY, mapConcurrent } from '../lib/concurrency.js';
import {
	DEFAULT_POLL_POLICY,
	deriveHotRepos,
	observedQueuedSinceMs,
	MIN_QUEUED_MS,
	ZOMBIE_MS,
	mintableRuns,
	reposDue,
	runnableJobs,
} from './queue-discovery.js';
import type { QueuedJob, QueuedRun } from './queue-discovery.js';
import { runnerTarballUrl } from './ephemeral-exec-jit.js';
import type { GhLike, ShellLike } from '../lib/fleet-vocabulary.js';
import {
	etagByRepo,
	runsDisk,
	jobsDisk,
	pendingEtagByRepo,
	pendingDisk,
	diskKey,
	lastPolledMs,
	pendingKeysByRepo,
} from '../lib/dispatch-poll-cache.js';
import { probeBackoff, placementFingerprint, recordProbeBackoff } from './probe-backoff.js';
import {
	STUCK_ANNOUNCED_FILE,
	warnedStuck,
	persistWarnedStuck,
	repoOfStuckKey,
} from './stuck-runs.js';
import {
	hydratePollCache,
	cachedRunsByRepo,
	cachedPendingByRepo,
	lastReadByRepo,
	jobsCacheByRun,
} from './dispatch-tick-poll.js';
import { loadWarnedStuck } from './dispatch-tick-stuck-load.js';
import {
	INTENT_KEY_SEP,
	announcedIntents,
	readProbeIntents,
} from './dispatch-tick-probe-intents.js';
import {
	DISPATCH_TICK_EXPECTED_MS,
	RECOVERY_INTERVAL_MS,
	PENDING_INTERVAL_MS,
	MAX_PENDING_PROBES,
	PENDING_CADENCE_NAME,
	MAX_RECOVERY_PROBES,
	RECOVERY_CADENCE_NAME,
	entryFor,
	type DispatchTickInput,
} from './dispatch-tick-config.js';

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
	if (!input.order.length) {
		// Still a completed tick (no node to mint on is a config fact, not a
		// hang) — see lib/liveness.ts.
		noteTick('dispatch', DISPATCH_TICK_EXPECTED_MS);
		return empty;
	}
	hydratePollCache(token);

	// deriveHotRepos, not an inlined `>= 20`. The threshold was duplicated here
	// while the function that owns it sat uncalled — and a comment two files away
	// claimed it was what stopped the hot list going stale. One definition.
	const hotRepos = deriveHotRepos(input.recentJobCounts);
	const due = reposDue(input.repos, { ...DEFAULT_POLL_POLICY, hotRepos }, lastPolledMs, nowMs);

	// STAMPED BEFORE THE AWAITS, for the reason the reap gate is: a slow pass must
	// not let the next one in behind it and double the cost this was gated to
	// bound. Decided once for the whole tick so every repo in the fan-out agrees.
	const recoveryDue = subCadence(RECOVERY_CADENCE_NAME, RECOVERY_INTERVAL_MS, nowMs);

	// READ ONCE PER TICK, like the reap gate, so every repo in the fan-out below
	// agrees about what is declared. One readdir of a directory that is empty
	// except while somebody is probing.
	const intents = readProbeIntents(nowMs);
	const declared = new Set(intents.map((i) => `${i.repo}${INTENT_KEY_SEP}${i.job}`));
	/** Jobs this tick did not mint for because a probe said it was serving them. */
	const yielded: string[] = [];

	type Entry = QueuedRun & {
		id: number;
		repo: string;
		jobId: number;
		jobName?: string;
		jobCreatedAt?: string;
		held?: boolean;
	};
	const pending: Entry[] = [];
	/**
	 * Backed-off runs' waiting jobs from their LAST listing, so they keep their
	 * place in the age order without a call (see `PendingRun.held`).
	 */
	const heldPending: Entry[] = [];
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
	type RunsResponse = { workflow_runs?: QueuedRun[] };
	/**
	 * One runs listing for one repo, CONDITIONAL when the caller can be: the
	 * queued listing is 26 calls a tick, and on 2026-09-04 it exhausted the
	 * 5,000/hr budget, with 424 of 478 rate-limited calls on that one path.
	 * Sending If-None-Match makes the unchanged case free and keeps the discovery
	 * cadence that got queue time down.
	 *
	 * `null` is the error return, NOT an empty queue. Treating the two the same
	 * is how a fleet-wide API failure reads as "nothing to do".
	 */
	const readListing = async (
		path: string,
		repo: string,
		etags: Map<string, string>,
		bodies: Map<string, RunsResponse>,
		disk: typeof runsDisk
	): Promise<QueuedRun[] | null> => {
		try {
			if (!gh.getConditional) {
				return ((await gh.get(path, token, repo)) as RunsResponse | null)?.workflow_runs ?? null;
			}
			const c = await gh.getConditional<RunsResponse>(path, token, repo, etags.get(repo) ?? null);
			// The listing is IDENTICAL to last tick — but runs AGE, so a run that was
			// too young then may be mintable now. Re-evaluate the cached body rather
			// than skipping the repo, or a job discovered inside the age gate would
			// wait for its content to change.
			if (c.status === 'unchanged') return bodies.get(repo)?.workflow_runs ?? null;
			// An error must NOT reuse the cache: stale queued runs would be minted
			// for again on every tick while the API is down.
			if (c.status !== 'ok') return null;
			if (c.etag) {
				etags.set(repo, c.etag);
				disk.save(diskKey(token, repo), c.etag, JSON.stringify(c.body));
			} else {
				etags.delete(repo);
				disk.remove(diskKey(token, repo));
			}
			bodies.set(repo, c.body);
			return c.body.workflow_runs ?? null;
		} catch {
			return null;
		}
	};

	const queuedCandidates = async (repo: string): Promise<QueuedRun[]> => {
		lastPolledMs.set(repo, nowMs);
		const runs = await readListing(
			'/actions/runs?status=queued&per_page=30',
			repo,
			etagByRepo,
			cachedRunsByRepo,
			runsDisk
		);
		if (!runs) return [];
		polledOk.add(repo);
		lastReadByRepo.set(repo, { atMs: nowMs, runs });
		const { mintable, stuck, stranded } = mintableRuns(runs, {
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
		return recoveryDue ? [...mintable, ...stranded.slice(0, MAX_RECOVERY_PROBES)] : mintable;
	};

	/**
	 * Runs GitHub lists as `pending`, for the SAME jobs probe to sort
	 * (fleet-manager#11) — the split queue-health makes in `summarisePending`:
	 * zero jobs is HELD by its own concurrency group and never minted for; a
	 * queued job is waiting on the fleet and is.
	 *
	 * No run-level age gate. A pending run's age includes however long its group
	 * held it with no jobs at all — 52 minutes for cardtable 40285146065 — which
	 * is not time spent waiting for a runner. Each JOB is aged instead, in
	 * `waitingJobs`.
	 */
	/** Fleet-wide count against MAX_PENDING_PROBES; the fan-out shares it. */
	let pendingProbes = 0;
	const pendingCandidates = async (repo: string): Promise<QueuedRun[]> => {
		const runs = await readListing(
			'/actions/runs?status=pending&per_page=30',
			repo,
			pendingEtagByRepo,
			cachedPendingByRepo,
			pendingDisk
		);
		// Unread keeps the last keys, so their caches are not pruned on a blip.
		if (!runs) return [];
		const listed = runs.filter((r) => r.status === 'pending');
		pendingKeysByRepo.set(repo, new Set(listed.map((r) => `${repo}#${r.id}`)));
		const take = Math.max(0, Math.min(listed.length, MAX_PENDING_PROBES - pendingProbes));
		pendingProbes += take;
		return listed.slice(0, take);
	};

	/**
	 * The jobs worth a runner. For a pending run, only those past the same floor
	 * a queued run must clear and inside the zombie band, both measured from the
	 * job's own creation: a pending run is never listed `queued`, so the run-level
	 * gates in `mintableRuns` never saw it.
	 */
	const waitingJobs = (r: QueuedRun, jobs: readonly QueuedJob[], isPending: boolean) =>
		runnableJobs(jobs).filter((j) => {
			if (!isPending) return true;
			const since = observedQueuedSinceMs(r, nowMs, j.created_at);
			if (since === undefined) return false;
			const age = nowMs - since;
			return age >= (input.minQueuedMs ?? MIN_QUEUED_MS) && age <= ZOMBIE_MS;
		});

	const pendingDue = subCadence(PENDING_CADENCE_NAME, PENDING_INTERVAL_MS, nowMs);
	const dueSet = new Set(due);
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
	// single-digit seconds inside a 60s tick. A pending pass adds one listing per repo
	// every PENDING_INTERVAL_MS, through the same six-wide gate.
	await mapConcurrent(pendingDue ? input.repos : due, SWEEP_CONCURRENCY, async (repo) => {
		const candidates: { r: QueuedRun; isPending: boolean }[] = [];
		if (dueSet.has(repo)) {
			for (const r of await queuedCandidates(repo)) candidates.push({ r, isPending: false });
		}
		if (pendingDue) {
			for (const r of await pendingCandidates(repo)) candidates.push({ r, isPending: true });
		}

		// One call per CANDIDATE run — only runs already past the age gate, which
		// is a small set — to find out what is actually waiting for a runner and
		// what it asked for. A run's own `queued` answers neither question.
		await Promise.all(
			candidates.map(async ({ r, isPending }) => {
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
					const cachedJobs = jobsCacheByRun.get(key)?.body.jobs ?? [];
					// Its last-seen RUNNING siblings still count toward their nodes —
					// the direction that holds work back, never the one that overfills.
					for (const j of cachedJobs) {
						if (j.status === 'in_progress' && j.runner_name && j.name) {
							runningJobs.push({ repo, runner: j.runner_name, jobName: j.name });
						}
					}
					for (const j of waitingJobs(r, cachedJobs, isPending)) {
						if (typeof j.name === 'string' && declared.has(`${repo}${INTENT_KEY_SEP}${j.name}`)) {
							continue;
						}
						heldPending.push({ ...entryFor(r, repo, j), held: true });
					}
					return;
				}
				// Probed now, so the pass below decides afresh whether it backs off.
				probeBackoff.delete(key);
				const path = `/actions/runs/${r.id}/jobs`;
				let jobs: JobsResponse = null;
				try {
					jobs = await withGhCaller('dispatch-probe', async () => {
						if (!gh.getConditional) {
							const body = (await gh.get(path, token, repo)) as JobsResponse;
							// Kept even without an ETag: a backed-off run is placed from it.
							if (body?.jobs) jobsCacheByRun.set(key, { etag: null, body });
							return body;
						}
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
							if (c.etag) jobsDisk.save(diskKey(token, key), c.etag, JSON.stringify(c.body));
							else jobsDisk.remove(diskKey(token, key));
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
						runningJobs.push({
							repo,
							runner: j.runner_name,
							jobName: j.name,
							jobId: j.id,
							runId: r.id,
						});
					}
				}
				const waiting = waitingJobs(r, jobs.jobs, isPending);
				if (!waiting.length) {
					// A pending run with nothing waiting is held by its own group or
					// not old enough yet. Neither is news; queue-health reports both.
					if (!isPending) blockedRuns.push(`${repo}#${r.id}`);
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
					pending.push(entryFor(r, repo, j));
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
			// Held entries ride along only when a FRESH job could take their slot;
			// alone, nothing can overtake them and the pass has nothing to do.
			pending: pending.length ? [...pending, ...heldPending] : pending,
			runningJobs,
			fingerprintFor: (repo, labels) => placementFingerprint(input.nodes, repo, [labels]),
			repos: input.repos,
			labelsFor: input.labelsFor,
			homeDirFor: input.homeDirFor,
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
	// A held run the pass kept a slot for is re-read on the next tick, which
	// mints from a fresh listing — one call per slot it actually won.
	for (const k of res.reserved ?? []) probeBackoff.delete(k);
	// Forget runs that have left the queue, so neither book grows for ever. Only
	// for repos read this tick: a repo not polled has not shown its runs gone.
	// A run the last pending listing still holds is kept between pending polls.
	for (const book of [jobsCacheByRun, probeBackoff]) {
		for (const k of book.keys()) {
			const repo = k.slice(0, k.lastIndexOf('#'));
			if (polledOk.has(repo) && !candidateKeys.has(k) && !pendingKeysByRepo.get(repo)?.has(k)) {
				book.delete(k);
				if (book === jobsCacheByRun) jobsDisk.remove(diskKey(token, k));
			}
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
	// Recorded last, after everything above that could throw — see lib/liveness.ts.
	noteTick('dispatch', DISPATCH_TICK_EXPECTED_MS);
	return res;
}
