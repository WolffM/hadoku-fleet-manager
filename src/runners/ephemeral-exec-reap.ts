/**
 * The reap half of `ephemeral-exec.ts` (wave 5o lane D split, pure move):
 * sweep `jit-*` registrations whose listener is gone. The JIT mint and the
 * warm (standing) listener moved to `ephemeral-exec-jit.ts` and
 * `ephemeral-exec.ts` respectively — see those files for why.
 */
import { logger } from '../host.js';
import { SWEEP_CONCURRENCY, mapConcurrent } from '../lib/concurrency.js';
import { JIT_PREFIX, parseJitName } from '../lib/jit-naming.js';
import { liveJitUnits } from './ephemeral-exec-jit.js';
import { type GhLike, type ShellLike } from '../lib/fleet-vocabulary.js';

/**
 * `REAP_INTERVAL_MS`/`JIT_REAP_GRACE_MS` moved to `src/lib/jit-reap-cadence.ts`
 * (wave clean-1 lane C/D, cut (iii)): `scripts/reconcile-runner-identity.mjs`
 * (observation) needs the same two numbers. Re-exported here under their
 * original path.
 */
import { JIT_REAP_GRACE_MS } from '../lib/jit-reap-cadence.js';

/**
 * How often the sweep re-lists a repo that has NOTHING TO REAP (#116).
 *
 * REAP_INTERVAL_MS bounded how often the sweep runs; it did not bound what one
 * sweep costs, and that grew with the roster: 30 repos x 60/hr = 1,800 calls an
 * hour, the largest single spender on HADOKU_SITE_TOKEN, paid whether anything
 * had been minted or not. In the 2026-10-16 18:30-19:15Z window that ended in
 * the fourth blackout in six days it was ~1,350 of the calls.
 *
 * Almost none of them could find anything. An orphan is a `jit-*` registration,
 * and one exists in a repo only if something minted there — so a repo whose
 * last listing held no `jit-*` registration, and that this process has not
 * minted to since, has nothing to reap until someone mints again. The sweep
 * still walks it, every five minutes rather than every minute, because the
 * process that minted may not be THIS one: `fleet prove-job` mints from the
 * CLI, and the previous mgmt-api's mints outlive it (the first sweep after a
 * restart walks every repo, since none has been listed yet).
 *
 *   idle fleet:  30 repos x 12/hr            =   360 calls/hr
 *   each repo holding or minting JIT         +    48 calls/hr while it does
 *
 * THE REAP LATENCY DOES NOT MOVE, and that is a constraint on this number, not
 * luck: it must stay at most JIT_REAP_GRACE_MS - REAP_INTERVAL_MS. A repo that
 * receives a mint from outside this process is then listed BEFORE that mint's
 * grace runs out, the listing shows the `jit-*` name, the repo becomes active,
 * and the orphan goes on the first sweep past its grace — grace + one sweep,
 * as before. `fleet identity`'s UNREAPED_AFTER_MS (grace + two sweeps) depends
 * on exactly that, and `dispatch-pass.test.ts` asserts the inequality.
 */
export const REAP_IDLE_INTERVAL_MS = 5 * 60_000;

/**
 * Reap JIT registrations whose listener is gone — §12.8's sweep, which the rest
 * of this workstream referred to and nothing implemented.
 *
 * WHY A LEAK HERE IS WORSE THAN A LEAK USUALLY IS
 * ------------------------------------------------
 * A registration GitHub can see is a runner GitHub will SCHEDULE ONTO. An
 * orphan does not sit harmlessly in a list: it takes a job, nothing answers,
 * and the job hangs until its timeout. Every successful mint created one of
 * these, because `deleteRunnerByName` was only ever called on failure paths.
 *
 * THE GRACE COMES FROM THE NAME, NOT FROM MEMORY. mgmt-api restarts ~5x a day
 * and the sweep must not treat a 30-second-old mint as an orphan just because
 * the process that made it is gone — that would reap a fleet's worth of healthy
 * runners on every redeploy. The mint epoch is in the name for exactly this, and
 * a name that cannot be parsed is treated as IMMEDIATELY reapable, per §12.8:
 * an unaged name is one we cannot vouch for.
 *
 * A BUSY REGISTRATION IS NEVER TOUCHED, whatever the node says. `busy` comes
 * free in the listing this sweep already makes, and it is the only witness that
 * comes from the party that ASSIGNED the job. The node probe answers wrongly in
 * the quiet direction when it is partial; GitHub's `busy` does not depend on the
 * node being reachable at all. Both have to fail before a running job dies.
 *
 * FAIL-SAFE ON AN UNREACHABLE NODE. If a node cannot be probed we cannot
 * know whether its listeners are alive, so nothing belonging to it is reaped.
 * Deleting a registration whose listener is mid-job kills the job — the exact
 * outage this workstream exists to avoid — and the cost of waiting is one more
 * sweep.
 */
export async function reapJitRunners(
	repos: readonly string[],
	nodes: readonly string[],
	token: string,
	gh: GhLike & { get: (path: string, token: string, repo?: string) => Promise<unknown> },
	sh: ShellLike,
	opts: {
		graceMs?: number;
		nowMs?: number;
		/**
		 * Jobs observed QUEUED this pass. A live idle JIT minted for one of them
		 * past the grace is STRANDED and released (fleet-manager#2). Absent,
		 * nothing live is.
		 */
		queuedJobIds?: ReadonlySet<number>;
	} = {}
): Promise<{
	reaped: number;
	kept: number;
	unreachable: string[];
	/**
	 * Every repo whose listing was READ, and whether it held any `jit-*`
	 * registration after this sweep's deletes. A repo whose listing could not be
	 * read is ABSENT, never `heldJit: false` — the caller decides from this which
	 * repos it may leave alone, and "I could not look" must not clean a repo.
	 */
	observed: { repo: string; heldJit: boolean }[];
}> {
	const graceMs = opts.graceMs ?? JIT_REAP_GRACE_MS;
	const nowMs = opts.nowMs ?? Date.now();

	const liveUnits = new Set<string>();
	const unreachable: string[] = [];
	await Promise.all(
		nodes.map(async (m) => {
			const probe = await sh(m, 'echo REACHABLE');
			if (probe === null || !probe.includes('REACHABLE')) {
				unreachable.push(m);
				return;
			}
			for (const u of await liveJitUnits(m, sh)) liveUnits.add(u);
		})
	);

	let reaped = 0;
	let kept = 0;
	const observed: { repo: string; heldJit: boolean }[] = [];
	// BOUNDED, not sequential and not `Promise.all` — the same shape, and the same
	// SWEEP_CONCURRENCY, as the queued-runs poll in dispatch-tick.
	//
	// Sequential was a latency bug with teeth. Every listing here carries a 10s
	// fetch timeout, so at 27 repos one sweep could run 270s while the dispatcher
	// that calls it holds `dispatchInFlight` — 17 ticks skipped, and discovery
	// latency IS queue latency under all-JIT. That is not theoretical: on
	// 2026-09-07 the API slowed under a burst of its own making, 866 of these
	// listings timed out in two hours, and the fleet stopped serving work from
	// 01:56 to 04:08. runner-health missed every 10-minute tick in that window.
	//
	// Six-wide turns the worst case into ~45s and the ordinary case into a round
	// or two. Not unbounded: one token serves this sweep, the poll and
	// runner-health, and a wide simultaneous burst trips GitHub's SECONDARY rate
	// limit, which stalls all three rather than just this one.
	//
	// Counters are plain increments because the event loop is single-threaded —
	// no interleaving can land between the read and the write of `reaped++`. The
	// only thing that changes is the ORDER of the per-repo log lines.
	await mapConcurrent(repos, SWEEP_CONCURRENCY, async (repo) => {
		const list = (await gh.get('/actions/runners?per_page=100', token, repo)) as
			{ runners?: { id: number; name: string; busy?: boolean }[] } | undefined;
		// Held AFTER this sweep: a registration it deleted is not one to come back
		// for, and a failed delete is (it is still there).
		let jitSeen = 0;
		let deletedHere = 0;
		for (const r of list?.runners ?? []) {
			if (!r.name.startsWith(JIT_PREFIX)) continue;
			jitSeen++;
			// BUSY MEANS A JOB IS RUNNING ON IT RIGHT NOW. Deleting the registration
			// under a live job kills the job — the outage this whole sweep exists to
			// avoid — so this is checked before anything else can conclude "orphan".
			//
			// It is a SECOND, INDEPENDENT witness, not a duplicate of the liveUnits
			// check below. That one asks the NODE ("is a unit by this name running?")
			// over ssh, and it answers wrongly in the quiet direction whenever the
			// probe is partial, the glob listing is truncated, or the unit is named
			// something the parser did not expect. This one asks GITHUB, which is the
			// party that assigned the job and the only one that knows a job was
			// accepted. Two sources have to fail together before a job dies.
			//
			// It costs NOTHING. `busy` is already in the listing this sweep performs
			// per repo — the field was simply not read. That matters here more than
			// usual: a listing with a busy runner in it is one that keeps changing,
			// so its ETag rarely answers 304 and the ceiling is the spend — a second
			// call per runner would have been unaffordable at fleet size. See
			// REAP_INTERVAL_MS.
			//
			// `busy` absent is NOT treated as busy: the other guards (live unit,
			// mint-epoch grace) still stand behind it, and treating every listing
			// that omitted the field as busy would disable the sweep entirely the
			// first time GitHub changed its serialisation.
			if (r.busy) {
				kept++;
				continue;
			}
			// Scoped by node, so one unreachable box does not freeze the sweep
			// for the rest of the fleet.
			if (unreachable.some((m) => r.name.startsWith(`${JIT_PREFIX}${m}-`))) {
				kept++;
				continue;
			}
			const parsed = parseJitName(r.name);
			// A live listener is kept unless it is STRANDED: idle (busy was checked
			// above) while the job it was minted for is still queued, and — by the
			// grace below — past any honest mint-to-assignment gap. GitHub assigns a
			// matching idle runner in seconds, so one that has listened this long
			// beside its own job is one GitHub will not give the job to. On
			// 2026-10-23 a hokon mint for hadoku-bomberman registered without
			// `hadoku-builder`, and "already has a runner in flight" held the job
			// off every claw until a hand delete 59 minutes later; nothing else
			// would have cleared it before JIT_UNIT_MAX_SEC, six and a half hours.
			// Deleting the registration is the whole release: the listener sees
			// "runner no longer exists on the server" and exits, its unit goes, and
			// the next pass places the job again. Only a job-scoped name can say
			// which job it was minted for.
			const stranded =
				liveUnits.has(r.name) && parsed?.jobId != null && opts.queuedJobIds?.has(parsed.jobId)
					? parsed
					: null;
			if (liveUnits.has(r.name) && !stranded) {
				kept++;
				continue;
			}
			if (parsed && nowMs - parsed.mintedAtMs < graceMs) {
				kept++;
				continue;
			}
			const res = await gh.write('DELETE', `/actions/runners/${r.id}`, token, undefined, repo);
			if (res.ok) {
				reaped++;
				deletedHere++;
				logger.info(
					stranded
						? `[ephemeral] released stranded registration ${r.name} from ${repo}: idle ` +
								`${Math.round((nowMs - stranded.mintedAtMs) / 60_000)}m beside its still-queued ` +
								`job ${stranded.jobId} — GitHub will not assign it there`
						: `[ephemeral] reaped orphaned registration ${r.name} from ${repo}`
				);
			} else {
				logger.warn(`[ephemeral] failed to reap ${r.name} from ${repo}: ${res.status}`);
			}
		}
		if (Array.isArray(list?.runners)) observed.push({ repo, heldJit: jitSeen > deletedHere });
	});
	if (reaped || unreachable.length) {
		logger.info(
			`[ephemeral] reap: ${reaped} removed, ${kept} kept` +
				(unreachable.length ? `, skipped nodes ${unreachable.join(',')}` : '')
		);
	}
	return { reaped, kept, unreachable, observed };
}
