/**
 * Should the PRODUCTION HOST be pulled into CI right now?
 *
 * Extracted from `checkLabelFloor` on 2026-08-29. It is the single highest-
 * consequence decision the fleet makes — promoting hokon spends the box that
 * runs mgmt-api, the tunnel and the other production services — and it was 70 lines in the middle
 * of a 480-line function, reachable only by driving a whole `tick()` against a
 * mocked `fetch`. Every argument the comments make below (the saturation
 * asymmetry, the one-sided hysteresis, the reservation ladder) was untestable
 * on its own terms.
 *
 * PURE. State goes in and comes back out rather than living in module
 * variables, so a test can put the fleet in any history — mid-hysteresis, just
 * recovered, promoted-but-calming — without simulating the ticks that got it
 * there.
 */
import type { BackstopReason } from '../fleet-report-types.js';

/**
 * How many calm ticks before a saturation promotion is allowed to stand down.
 *
 * At runner-health's TICK_INTERVAL_MS that is half an hour of sustained free
 * capacity — longer than any flap observed, and cheap to be wrong about in this
 * direction.
 *
 * IT IS A CEILING, NOT A DURATION. Since the queue is probed on every tick the
 * hold also ends the moment the queue is measured EMPTY (see `holdingDown`), so
 * this bounds how long a still-oscillating queue can keep the production host
 * eligible; it is not how long every saturation promotion lasts.
 */
export const BACKSTOP_CALM_TICKS = 3;

/**
 * Queue seconds that must ALREADY have elapsed before SATURATION promotes the
 * backstop. An OUTAGE ignores this entirely — jobs have nowhere to run at all.
 *
 * WHY A GATE AT ALL
 * -----------------
 * `clawsFree === 0` says every claw is busy. It does NOT say anything is
 * waiting: a fleet running exactly at capacity with nothing queued behind it is
 * a fleet working perfectly, and promoting the production host into that is
 * pure cost. The trigger shipped without this on 2026-08-24 and fired on
 * ordinary load all day.
 *
 * WHERE 100 COMES FROM
 * --------------------
 * Measured, not chosen. 1,849 self-hosted jobs across six repos and 3.5 months,
 * JOB level (`created_at` -> `started_at`), 2026-08-25:
 *
 *     builder jobs (n=1444)   p50 3s   p80 46s   p90 90s   p95 131s   p99 309s
 *     last 30 days (n=1247)   p90 100s
 *
 * 100s is the last-30-days p90, and 30 days is the right window because the
 * fleet's shape changed inside it (the `-b` instance pool retired, hokon gained
 * full coverage, ci-throttle installed). Nine jobs in ten are served faster than
 * this without help; the tenth is what hokon is for.
 *
 * Sanity-checked two ways. Eight hadoku-study jobs from 2026-08-18 sat ~8.7h
 * (one incident, runners dead) and pull the MEAN to 189s — excluding them moves
 * p90 by 2s, which is why this is a percentile and not an average. And a single
 * congested 10h window that same day reported p90 141s: measuring a busy
 * afternoon and calling it the fleet's shape is exactly the p95-as-p50 mistake
 * that `docs/planning/ci-latency-2026-08-20.md` was built to avoid.
 *
 * IT IS A CONSTANT, DERIVED FROM A PERCENTILE — NOT A PERCENTILE.
 * A live p90 would be self-referencing: as saturation gets worse the
 * distribution shifts right, p90 rises, and the trigger LOOSENS exactly when it
 * should tighten. Re-derive this deliberately from `queueSec` in job-history
 * (persisted since 2026-08-25) when the fleet's shape changes again.
 */
export const SATURATION_QUEUE_SECONDS = 100;

export interface BackstopState {
	/** Consecutive ticks with no reason to promote. */
	calmTicks: number;
	/** Why we promoted last, or null if we never did. */
	lastReason: 'outage' | 'saturation' | null;
	/** Whether the fleet currently carries the backstop label. */
	promoted: boolean | null;
}

export interface BackstopInput {
	clawsOnline: number;
	clawsRegistered: number;
	/** Claws that could take a job this instant. */
	clawsFree: number;
	/**
	 * Age of the oldest queued run, EXCLUDING runs too old to be waiting for
	 * capacity, or 0 when it was not worth probing.
	 *
	 * 0 therefore means one of two things and the caller knows which: "probed, and
	 * nothing is waiting" on a healthy fleet, or "not asked" behind an outage.
	 * `explainBackstop` says which; `outage` is what tells them apart.
	 *
	 * IT MUST NOT CARRY A ZOMBIE. runner-health's `QUEUE_ZOMBIE_SECONDS` drops
	 * runs past the dispatcher's own age boundary before this value is built,
	 * because a run queued since 2026-08-17 that cannot be cancelled is not work
	 * the backstop can serve — and an unbanded probe fed 3.5 million seconds in
	 * here every tick from 2026-09-25, which made `saturated` permanently true.
	 */
	queuePressureSec: number;
	/** The priority ladder says hokon is busy with work GitHub cannot see. */
	reserved: boolean;
	/**
	 * Ephemeral capacity was NOT MEASURED this tick (no probe snapshot yet).
	 *
	 * Optional, and absent means measured — a caller that forgets it gets the old
	 * behaviour rather than a silent suppression.
	 */
	ephemeralUnknown?: boolean;
}

export interface BackstopDecision {
	wanted: boolean;
	/** Named in the wire contract so the panel's switch cannot fall behind it. */
	reason: BackstopReason;
	outage: boolean;
	atCapacity: boolean;
	/**
	 * The counts this decision rests on were NOT MEASURED — no probe snapshot
	 * this tick, so nothing was decided and the previous answer was held.
	 *
	 * Distinct from `reason: 'holding'`, which also means "no fresh reason this
	 * tick" but on evidence we HAVE. Collapsing the two is how "I could not
	 * look" renders as "nothing is wrong": the log line for the two states has
	 * to say which one it is, and `reason` cannot carry it without widening
	 * BackstopReason past the four values the panel switches on.
	 */
	unmeasured: boolean;
	next: BackstopState;
}

/**
 * At least half the REGISTERED claws are answering.
 *
 * A proportion rather than a fixed count, deliberately: the fleet has grown from
 * 3 instances to 6 and will change again, and a hardcoded floor silently means
 * something different every time it does. Presence was the old test — any single
 * claw returning demoted the whole backstop — and it is the wrong one: on
 * 2026-08-17 claw-1 came back alone while claw-2 and claw-3 stayed dark, so two
 * slots served all 20 repos with 11 jobs queued and three idle backstop
 * instances standing down beside them.
 *
 * ZERO REGISTERED IS AN OUTAGE, not a vacuous pass. `0 * 2 >= 0` is true, so
 * without this line a fleet with no runners at all reads as healthy — which is
 * the one state where the backstop is most needed. Dropped in a first cut of
 * this extraction and caught by the test that exists for it.
 */
export function clawsAreHealthy(clawsOnline: number, clawsRegistered: number): boolean {
	if (clawsRegistered === 0) return false;
	return clawsOnline * 2 >= clawsRegistered;
}

/**
 * Whether every healthy claw is busy this instant.
 *
 * NOT the probe gate, and it has not been one since 2026-09-24. It gated
 * runner-health's queue listing until `2383b18` moved that to
 * `fleetIsUp && !ephemeralUnknown` — `atCapacity` was never a precondition for
 * saturation (2026-09-01), and census.ts folds mintable slots into `clawsFree`,
 * so under all-JIT the one state the caller was willing to pay for never
 * arrives (#63).
 *
 * What it is now: the derivation of the `atCapacity` FIELD on the decision,
 * which is reporting — `clawsFree === 0` is still a true and useful thing to
 * say about a fleet. Nothing branches on it.
 */
export function isAtCapacity(
	i: Pick<BackstopInput, 'clawsOnline' | 'clawsRegistered' | 'clawsFree'>
): boolean {
	return clawsAreHealthy(i.clawsOnline, i.clawsRegistered) && i.clawsFree === 0;
}

export function decideBackstop(i: BackstopInput, s: BackstopState): BackstopDecision {
	// AN UNMEASURED FLEET IS NOT A DARK FLEET.
	//
	// Under all-JIT every claw count comes from the fast loop's probe, which is
	// null for the first ~60s after any mgmt-api restart. runner-health's first
	// tick lands inside that window, so on 2026-09-02 each deploy read 0/0 claws,
	// declared an outage, promoted the production host, and demoted it again a
	// minute later — a 🔻/🔺 pair per deploy for a fleet that never faltered.
	//
	// Holding the CURRENT state is the conservative move in both directions: an
	// already-promoted hokon stays promoted (a real outage keeps its backstop),
	// and an un-promoted one is not promoted on evidence we do not have. The next
	// tick has the probe and decides normally, so a genuine outage is delayed by
	// one tick at most and still surfaces — it is not suppressed, because the
	// counts it rests on are unaffected once the snapshot exists.
	if (i.ephemeralUnknown) {
		// `holding` already means "still promoted, with no fresh reason this tick",
		// which is exactly this state. Reusing it keeps BackstopReason at four
		// values — the panel switches on them, and an unknown value renders as a
		// grey pill on the one page opened when something is already wrong.
		return {
			wanted: s.promoted === true,
			reason: s.promoted === true ? 'holding' : 'none',
			outage: false,
			atCapacity: false,
			unmeasured: true,
			next: { calmTicks: s.calmTicks, lastReason: s.lastReason, promoted: s.promoted },
		};
	}
	const outage = !clawsAreHealthy(i.clawsOnline, i.clawsRegistered);
	const atCapacity = isAtCapacity(i);

	// At capacity is not the same as backed up. Promoting the production host
	// because the fleet is running flat out, with nothing actually waiting behind
	// it, spends prod capacity to buy nothing — and it is what made the backstop
	// fire on ordinary load all through 2026-08-24. So saturation has to show its
	// work: something must already have waited past the fleet's measured p90.
	//
	// Saturation yields to the reservation ladder; an OUTAGE does not. That
	// asymmetry is the whole decision — a backed-up queue is CI being slow, which
	// the nightly crons outrank, while an outage is CI being impossible, and a
	// fleet with nowhere to run is worth interrupting a cron for.
	// A BACKED-UP QUEUE IS SUFFICIENT ON ITS OWN. `atCapacity` is deliberately
	// NOT a precondition here, and removing it on 2026-09-01 is the fix for an
	// outage rather than a loosening.
	//
	// `atCapacity` is `healthy && clawsFree === 0`, and census.ts folds ephemeral
	// nodes' mintable slots into `clawsFree` - correctly, and on purpose, because
	// counting them out makes the backstop reach for the production host over an
	// idle fleet. The consequence is that once enough of the fleet mints, the
	// count never reaches zero, so `atCapacity` is never true, so the queue
	// NEVER GETS CONSULTED however long it grows. That evening three of four
	// nodes were ephemeral: 13 jobs sat 11-19 minutes across nine repos while
	// this function stayed quiet, because it asked "is the fleet full?" before it
	// asked "is anything stuck?" and the first question could no longer be true.
	//
	// The queue is the DIRECT OBSERVATION; `clawsFree === 0` was only ever a
	// proxy for "work is not being served", and mintable capacity broke the
	// proxy. So the proxy goes and the measurement stays. The property this buys
	// is the one that was missing: NO CAPACITY ACCOUNTING HAS TO BE CORRECT for
	// CI to keep working. A phantom count, a demote race, a dispatcher outage, a
	// bug not yet written - all of them show up as a queue, and the queue is now
	// enough on its own.
	//
	// Neither lesson this function records is undone:
	//   - 2026-08-24, fired on ordinary load: that was `clawsFree === 0` with
	//     NOTHING waiting. `queuePressureSec` is what fixed it and it stays.
	//     Something must still have waited past the fleet's measured p90.
	//   - 2026-08-29, took 46 jobs while claw-1 sat idle at 0/3 and the tier
	//     ladder promoted it 43s later. That guard (`ladderHasRoom`) went with
	//     the ladder on 2026-09-21: every claw is JIT, so an idle claw's slots
	//     are MINTABLE capacity already inside `clawsFree`, and the dispatcher
	//     serves them without anyone switching them on.
	const saturated = i.queuePressureSec >= SATURATION_QUEUE_SECONDS && !i.reserved;
	const needed = outage || saturated;

	// Hysteresis, ONE-SIDED: rise immediately, fall only after the fleet has been
	// calm for BACKSTOP_CALM_TICKS. `promoted === true` is the "we are currently
	// promoted" test, so a fleet that was never promoted does not linger here
	// waiting to stand down from nothing.
	const next: BackstopState = needed
		? { calmTicks: 0, lastReason: outage ? 'outage' : 'saturation', promoted: s.promoted }
		: { calmTicks: s.calmTicks + 1, lastReason: s.lastReason, promoted: s.promoted };

	// THE HOLD NEEDS LIVE EVIDENCE, and until now it could not have any.
	//
	// This is the other half of #63, which said so in its own text: the fix
	// "loosens the trigger and makes hokon reachable more often, which is the
	// opposite direction to #56, and it is the same call-site change as tightening
	// the saturation hysteresis (`holdingDown` + `queuePressureSec > 0`). Both
	// belong in one follow-up with its own measurement." Only the loosening
	// shipped, on 2026-09-24.
	//
	// It could not have shipped earlier and been meaningful. While the caller gated
	// the probe on `isAtCapacity(...)`, `queuePressureSec` arrived here as the
	// literal 0 on every off-capacity tick — so this clause would have collapsed
	// the hysteresis to nothing on evidence nobody had gathered. `2383b18` is what
	// makes 0 mean "probed, and nothing is waiting", and that is the fact the hold
	// was always missing: it damped a flap by holding for a FIXED thirty minutes
	// whether or not anything was still queued.
	//
	// WHAT IT STILL DAMPS. The flap this exists for is a queue oscillating ACROSS
	// the 100s threshold — 130s, then 40s, then 120s — and a queue at 40s is not
	// an empty one, so the hold survives it exactly as before. What it no longer
	// does is keep the production host eligible over a queue measured at zero,
	// which is the state the fleet is in on most ticks and where a standing hokon
	// registration wins GitHub's assignment race outright (builder queue p50 2s
	// against the claws' 4s — a genuine last resort would wait LONGER, not less).
	// The hold now ends when the queue drains rather than on a timer, which is
	// shorter in the common case and is the point.
	//
	// The direction is safe by construction: the worse the backlog, the larger
	// `queuePressureSec`, so this clause can only ever release the hold EARLIER on
	// a fleet that is doing fine. It cannot make the backstop easier to keep up
	// the worse things get.
	const holdingDown =
		!needed &&
		// The reservation outranks the damping: a reserved node comes back NOW.
		!i.reserved &&
		s.lastReason === 'saturation' &&
		s.promoted === true &&
		i.queuePressureSec > 0 &&
		next.calmTicks < BACKSTOP_CALM_TICKS;

	return {
		wanted: needed || holdingDown,
		reason: outage ? 'outage' : saturated ? 'saturation' : holdingDown ? 'holding' : 'none',
		outage,
		atCapacity,
		unmeasured: false,
		next,
	};
}

/**
 * ONE RENDERING OF THE DECISION, so the log and the decision cannot drift.
 *
 * `decideBackstop` is the only thing that decides whether the production host
 * is pulled into CI, and until 2026-09-24 nothing printed WHY except at the two
 * edges — the promote line and the demote line. Between them the label sat on
 * hokon for days and the only way to answer "why is hokon taking this job" was
 * to reconstruct a tick from the snapshot. Measured over 2026-09-10 → 09-19,
 * hokon took 204 `hadoku-builder` jobs and **no promote line exists in any
 * retained log**: every one of them was served by a label this decision never
 * asked for. A rendering that lives beside the decision is how the next one
 * says so at the time rather than four days later.
 *
 * "I COULD NOT LOOK" IS SPELLED OUT, and so is "I DID NOT ASK".
 *   - `unmeasured` says the counts do not exist yet (no probe snapshot), which
 *     is not the same as a healthy fleet and is not the same as a dark one.
 *   - the queue is probed by the caller whenever the fleet is UP and MEASURED,
 *     so `queuePressureSec === 0` means "empty, measured" everywhere except
 *     behind a dark fleet, where nothing was asked. Printing a bare `queue=0s`
 *     for both is the same collapse one line up, so the OUTAGE says it did not
 *     ask. `d.outage` is what tells them apart.
 *
 * THIS BLOCK DESCRIBED THE CALLER, SO IT AGED WITH IT. Until 2026-09-24 the
 * gate was `isAtCapacity(...)` and both bullets read off `atCapacity`; that is
 * what `2383b18` changed, and a rendering that kept saying "I did not ask"
 * about a call the caller now makes is the failure this file exists to avoid.
 * If the gate in `runner-health.ts` moves again, this comment and the clause
 * below move with it.
 */
export function explainBackstop(i: BackstopInput, d: BackstopDecision): string {
	if (d.unmeasured) {
		return (
			`reason=${d.reason} claws=UNMEASURED (no fleet probe snapshot this tick — ` +
			'the fast loop has not completed a pass since the last restart) ' +
			`— held the previous answer (${d.wanted ? 'promoted' : 'not promoted'}), decided nothing`
		);
	}
	// THERE IS EXACTLY ONE REASON LEFT NOT TO HAVE PROBED, and it is the OUTAGE.
	// Nothing can queue BEHIND a fleet with nowhere to run, and waiting to
	// observe a queue there would add the threshold to every job's latency
	// during the incident — the skip buys latency, it does not save a call that
	// mattered. Everything else that reaches this line was probed: the caller's
	// gate is `fleetIsUp && !ephemeralUnknown`, and `fleetIsUp` is
	// `clawsAreHealthy(...)`, which is exactly `!d.outage` off the same counts.
	//
	// THE OTHER SENTENCE IS GONE BECAUSE THE CALLER CHANGED. This branch read
	// `d.atCapacity` and printed "a claw was free, so the answer could not
	// change this decision" — true while runner-health gated the listing on
	// `isAtCapacity(...)`, false since `2383b18` moved that gate, because
	// `atCapacity` was never a precondition for saturation and census.ts folds
	// mintable slots into `clawsFree` (#63). Off capacity the queue is now
	// probed and its reading is what PROMOTES, so the old sentence printed "NOT
	// PROBED" directly beside `reason=saturation` and hid the number that drove
	// the call. A message asserting the opposite of the code is this repo's most
	// expensive failure shape; the value goes in the log instead.
	//
	// UNMEASURED cannot reach here at all: `decideBackstop` returns on
	// `ephemeralUnknown` before it ever reads `queuePressureSec`, and the
	// `d.unmeasured` branch above returns before this line. That state has its
	// own sentence and never borrows this one.
	const queue = d.outage
		? 'queue=NOT PROBED (an outage skips it — nothing can queue behind a dark fleet)'
		: `queue=${i.queuePressureSec}s (probed; promotes at ${SATURATION_QUEUE_SECONDS}s)`;
	return (
		`reason=${d.reason} claws=${i.clawsOnline}/${i.clawsRegistered} online ` +
		`free=${i.clawsFree} healthy=${clawsAreHealthy(i.clawsOnline, i.clawsRegistered)} ` +
		`${queue} reserved=${i.reserved} calmTicks=${d.next.calmTicks}/${BACKSTOP_CALM_TICKS}`
	);
}

/** What the backstop must do to ONE registration to make it match the decision. */
export type BackstopLabelWrite = 'promote' | 'demote' | null;

/**
 * ONE PREDICATE for the label write, shared by both paths that perform it.
 *
 * `runner-health` writes `hadoku-builder` on the guest pool in two places — by
 * runner id on the hub repo, and by listing on each of the other 26 — and they
 * disagreed on exactly one clause: the fan-out skipped a runner that was not
 * `online`, for the DEMOTE as well as the promote. That is not a symmetric
 * rule, and the asymmetry has a measured cost:
 *
 *   - PROMOTING an offline runner buys nothing. It is not long-polling, so no
 *     job can land on it, and the re-assert that runs every tick while the
 *     backstop is up labels it the moment it comes back.
 *   - DEMOTING is not optional for the same reason in reverse. The label is
 *     live exposure the instant the listener reconnects, and the sweep that
 *     skipped it recorded itself as converged — `failed` stayed empty — so
 *     nothing looked at that repo again. On 2026-09-18T19:29Z the fan-out
 *     demoted 26 of 27 repos and missed hadoku-cardtable this way; hokon then
 *     took seven `hadoku-builder` jobs on that one repo before an unrelated
 *     restart forced a fresh converge at 21:47Z.
 *
 * Pure and in this file so the rule is under test on its own terms, rather than
 * only reachable by driving a whole tick against a mocked `fetch` — the same
 * reason `decideBackstop` was extracted here in the first place.
 */
export function backstopLabelWrite(
	reg: { hasBuilder: boolean; online: boolean },
	wanted: boolean
): BackstopLabelWrite {
	if (wanted === reg.hasBuilder) return null; // already in the desired state
	if (wanted) return reg.online ? 'promote' : null;
	return 'demote';
}

/**
 * Is the backstop host quiet enough to take CI on SATURATION (operator,
 * 2026-10-09: "hokon should get promoted if the queue is full and hokon is
 * idle")? hokon is the production box and a desktop; a game, an AI app or the
 * nightly pipeline is its own work, and saturation is CI merely being slow.
 * An OUTAGE does not ask — the caller lets it override, the same asymmetry
 * `decideBackstop` already draws for the reservation ladder.
 *
 * Load is per core so the line means the same on any box; memory is absolute
 * because a Forge job's footprint is (p95 5.5 GB, max 10 GB measured on this
 * host). `null` (could not read) is NOT idle.
 */
export const BACKSTOP_IDLE_MAX_LOAD_PER_CORE = 4.0;
export const BACKSTOP_IDLE_MIN_AVAILABLE_MB = 12 * 1024;

export function isHostIdle(
	h: { load1: number; cores: number; memAvailableMb: number } | null
): boolean {
	if (!h || !(h.cores > 0)) return false;
	return (
		h.load1 / h.cores <= BACKSTOP_IDLE_MAX_LOAD_PER_CORE &&
		h.memAvailableMb >= BACKSTOP_IDLE_MIN_AVAILABLE_MB
	);
}

/**
 * Queue seconds past which a BACKLOG promotes the backstop host whatever its
 * load — the escalation above the idle gate (2026-10-21).
 *
 * THE SAME NUMBER AS `ci:queue-health`'s FAIL floor (`scripts/lib/queue-health.mjs`
 * `FAIL_SECONDS`), on purpose, and a guard test holds the two equal. The floor
 * is where the fleet is declared "not serving work" and pages the operator;
 * the question that night was why the page and the backstop disagreed — the
 * gate that pages and the gate that acts now read one line. Saturation at
 * 100 s is CI being slow, and a loaded desktop may keep its cores; a backlog
 * at 300 s is CI being broken, and the operator's instruction for that case
 * (2026-10-21, four times) is "hokon MUST come in to help". Memory is still
 * required: a Forge job's footprint is physical and a box without it fails
 * the job, slowly.
 */
export const BACKLOG_QUEUE_SECONDS = 300;

export type SaturationHostVerdict =
	{ ok: true; why: 'idle' | 'backlog' } | { ok: false; why: string };

/**
 * May the backstop host take CI on SATURATION right now? ONE answer with its
 * reason, so the log line, the status CLI and the decision cannot drift.
 *
 *   - unreadable load → no ("could not look" is not idle)
 *   - memory under the floor → no, whatever the queue (physical)
 *   - load under the idle ceiling → yes, idle
 *   - queue past BACKLOG_QUEUE_SECONDS → yes, backlog (load ignored, and said)
 *   - otherwise → no, not idle — and the line says how far the queue is from
 *     the backlog threshold, which is what would have to change
 */
export function hostMayTakeSaturation(
	h: { load1: number; cores: number; memAvailableMb: number } | null,
	queuePressureSec: number
): SaturationHostVerdict {
	if (!h || !(h.cores > 0)) return { ok: false, why: 'not idle: load unreadable from here' };
	const perCore = h.load1 / h.cores;
	const mem = Math.round(h.memAvailableMb);
	if (h.memAvailableMb < BACKSTOP_IDLE_MIN_AVAILABLE_MB) {
		return {
			ok: false,
			why: `memory: ${mem} MB available (needs ≥${BACKSTOP_IDLE_MIN_AVAILABLE_MB}); a backlog does not override this`,
		};
	}
	if (perCore <= BACKSTOP_IDLE_MAX_LOAD_PER_CORE) return { ok: true, why: 'idle' };
	if (queuePressureSec >= BACKLOG_QUEUE_SECONDS) return { ok: true, why: 'backlog' };
	return {
		ok: false,
		why:
			`not idle: load ${perCore.toFixed(2)}/core (idle is ≤${BACKSTOP_IDLE_MAX_LOAD_PER_CORE}), ` +
			`${mem} MB available; queue ${queuePressureSec}s — a backlog past ${BACKLOG_QUEUE_SECONDS}s promotes regardless of load`,
	};
}

/** The verdict as one phrase for a log: `idle`, `backlog 420s ≥ 300s (load ignored)`, or the refusal. */
export function describeSaturationHost(v: SaturationHostVerdict, queuePressureSec: number): string {
	if (!v.ok) return v.why;
	return v.why === 'idle'
		? 'idle'
		: `backlog ${queuePressureSec}s ≥ ${BACKLOG_QUEUE_SECONDS}s (load ignored)`;
}
