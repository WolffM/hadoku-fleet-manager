import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	BACKSTOP_CALM_TICKS,
	SATURATION_QUEUE_SECONDS,
	backstopLabelWrite,
	clawsAreHealthy,
	decideBackstop,
	explainBackstop,
	isAtCapacity,
	type BackstopState,
	isHostIdle,
	hostMayTakeSaturation,
	describeSaturationHost,
	BACKLOG_QUEUE_SECONDS,
} from '../runners/backstop.js';

const FRESH: BackstopState = { calmTicks: 0, lastReason: null, promoted: null };
const base = {
	clawsOnline: 3,
	clawsRegistered: 3,
	clawsFree: 2,
	queuePressureSec: 0,
	reserved: false,
};

test('zero registered claws is an outage, not a vacuous pass', () => {
	// 0 * 2 >= 0 is true. Without the guard a fleet with no runners at all reads
	// as healthy — the one state where the backstop is most needed.
	assert.equal(clawsAreHealthy(0, 0), false);
	assert.equal(decideBackstop({ ...base, clawsOnline: 0, clawsRegistered: 0 }, FRESH).wanted, true);
});

// 2026-09-02: every mgmt-api deploy posted a 🔻 and then a 🔺. lastFleetProbe is
// null for ~60s after a restart, and under all-JIT every claw count comes from
// it, so runner-health's first tick read 0/0 and promoted the production host
// for a fleet that never faltered.
test('an UNMEASURED fleet does not promote — 0/0 from a missing probe is not an outage', () => {
	const d = decideBackstop(
		{ ...base, clawsOnline: 0, clawsRegistered: 0, ephemeralUnknown: true },
		FRESH
	);
	assert.equal(d.wanted, false, 'no promotion on capacity nothing looked at');
	assert.equal(d.outage, false, 'and it is not reported as an outage');
	assert.equal(d.reason, 'none');
});

test('an unmeasured tick does not DEMOTE an already-promoted backstop either', () => {
	// Conservative in both directions: a real outage keeps its backstop through
	// the blind window rather than flapping down and back up.
	const promoted: BackstopState = { calmTicks: 0, lastReason: 'outage', promoted: true };
	const d = decideBackstop(
		{ ...base, clawsOnline: 0, clawsRegistered: 0, ephemeralUnknown: true },
		promoted
	);
	assert.equal(d.wanted, true, 'stays promoted');
	assert.equal(d.reason, 'holding');
	assert.equal(d.next.promoted, true, 'and the state is carried, not reset');
});

test('once the probe EXISTS, a genuinely dark fleet still promotes', () => {
	// The safety direction. Suppression must last exactly one blind tick, not
	// survive into a tick that could see.
	const d = decideBackstop(
		{ ...base, clawsOnline: 0, clawsRegistered: 0, ephemeralUnknown: false },
		FRESH
	);
	assert.equal(d.wanted, true);
	assert.equal(d.outage, true);
});

test('half the claws online is still healthy; below half is an outage', () => {
	assert.equal(clawsAreHealthy(3, 6), true, 'exactly half holds');
	assert.equal(clawsAreHealthy(2, 6), false);
});

test('at capacity with an EMPTY queue does not promote the production host', () => {
	// Promoting because the fleet is running flat out, with nothing waiting behind
	// it, spends prod capacity to buy nothing. This fired on ordinary load all
	// through 2026-08-24.
	const d = decideBackstop({ ...base, clawsFree: 0, queuePressureSec: 0 }, FRESH);
	assert.equal(d.atCapacity, true);
	assert.equal(d.wanted, false);
	assert.equal(d.reason, 'none');
});

test('at capacity WITH a backed-up queue promotes', () => {
	const d = decideBackstop(
		{ ...base, clawsFree: 0, queuePressureSec: SATURATION_QUEUE_SECONDS },
		FRESH
	);
	assert.equal(d.wanted, true);
	assert.equal(d.reason, 'saturation');
});

test('a reserved node refuses SATURATION but never refuses an OUTAGE', () => {
	// The asymmetry is the whole decision: a backed-up queue is CI being slow,
	// which the nightly crons outrank; an outage is CI being impossible.
	const sat = decideBackstop(
		{ ...base, clawsFree: 0, queuePressureSec: 999, reserved: true },
		FRESH
	);
	assert.equal(sat.wanted, false, 'crons outrank a slow queue');

	const out = decideBackstop(
		{ ...base, clawsOnline: 0, clawsRegistered: 3, reserved: true },
		FRESH
	);
	assert.equal(out.wanted, true, 'nothing outranks a fleet with nowhere to run');
	assert.equal(out.reason, 'outage');
});

test('hysteresis holds a saturation promotion up while the fleet is still calming', () => {
	// One-sided: rise immediately, fall only after BACKSTOP_CALM_TICKS. Without
	// it a flapping claw promotes and demotes the production host every tick.
	//
	// THE FLAP IS A QUEUE CROSSING THE THRESHOLD, not an empty one — 130s, then
	// 40s, then 120s. This case used to pass `base` (queue 0) and so asserted the
	// hold over a queue measured at zero, which is the state the #56 regression
	// lives in; the queue here is the under-threshold reading the damping is
	// actually for. See the `queuePressureSec > 0` clause.
	const promoted: BackstopState = { calmTicks: 0, lastReason: 'saturation', promoted: true };
	const d = decideBackstop({ ...base, queuePressureSec: 40 }, promoted);
	assert.equal(d.wanted, true);
	assert.equal(d.reason, 'holding');
});

test('...and lets go once it has been calm long enough', () => {
	const settled: BackstopState = {
		calmTicks: BACKSTOP_CALM_TICKS,
		lastReason: 'saturation',
		promoted: true,
	};
	assert.equal(decideBackstop({ ...base, queuePressureSec: 40 }, settled).wanted, false);
});

// #56 / the other half of #63. The issue named this clause out loud — "it is the
// same call-site change as tightening the saturation hysteresis (`holdingDown` +
// `queuePressureSec > 0`)" — and only the loosening shipped, on 2026-09-24.
//
// Before `2383b18` the caller handed this function a literal 0 on every
// off-capacity tick, so the clause would have collapsed the hysteresis on
// evidence nobody had gathered. Now the queue is probed every tick and 0 means
// PROBED AND EMPTY, so holding the production host eligible over it is thirty
// minutes of hokon winning GitHub's assignment race for work no claw was slow to
// take (builder queue p50 2s against the claws' 4s).
test('#56: the hold does NOT survive a queue measured EMPTY', () => {
	const promoted: BackstopState = { calmTicks: 0, lastReason: 'saturation', promoted: true };
	const d = decideBackstop({ ...base, queuePressureSec: 0 }, promoted);
	assert.equal(d.wanted, false, 'nothing is waiting — the reserve stands down now, not in 30 min');
	assert.equal(d.reason, 'none');
	assert.equal(d.next.calmTicks, 1, 'and the calm counter still advances');
});

test('#56: one queued second is enough to keep damping — the clause is evidence, not a threshold', () => {
	// Deliberately NOT a second threshold. SATURATION_QUEUE_SECONDS decides
	// whether to PROMOTE; this decides whether there is anything left to damp. A
	// second number here would be a second thing to tune and a second thing to be
	// wrong about, and "is the queue empty" is the question the hold needs.
	const promoted: BackstopState = { calmTicks: 0, lastReason: 'saturation', promoted: true };
	const d = decideBackstop({ ...base, queuePressureSec: 1 }, promoted);
	assert.equal(d.wanted, true);
	assert.equal(d.reason, 'holding');
});

test('#56: the tightening cannot make the backstop easier to keep up as things get worse', () => {
	// CLAUDE.md's rule, checked on this clause: the worse the backlog the LARGER
	// `queuePressureSec`, so a rising queue can only ever satisfy this clause, and
	// past SATURATION_QUEUE_SECONDS it stops mattering because `needed` is true on
	// its own. Monotone in the safe direction at every step.
	const promoted: BackstopState = { calmTicks: 0, lastReason: 'saturation', promoted: true };
	for (const q of [0, 1, 40, 99]) {
		assert.equal(
			decideBackstop({ ...base, queuePressureSec: q }, promoted).wanted,
			q > 0,
			`queue=${q}s`
		);
	}
	// At and past the threshold it is a promotion, not a hold.
	const hot = decideBackstop({ ...base, queuePressureSec: SATURATION_QUEUE_SECONDS }, promoted);
	assert.equal(hot.wanted, true);
	assert.equal(hot.reason, 'saturation');
});

test('#56: an outage still promotes with no queue at all — the clause is saturation-only', () => {
	// The safety direction. `holdingDown` only ever gated a SATURATION stand-down;
	// nothing about an outage may learn to need a queue reading, because nothing
	// can queue behind a fleet with nowhere to run.
	const d = decideBackstop(
		{ ...base, clawsOnline: 0, clawsRegistered: 3, queuePressureSec: 0 },
		FRESH
	);
	assert.equal(d.wanted, true);
	assert.equal(d.reason, 'outage');
});

test('a fleet that was never promoted does not linger waiting to stand down', () => {
	// Queue deliberately non-zero: with 0 this would pass on the
	// `queuePressureSec > 0` clause and stop measuring `promoted === true`.
	const neverUp: BackstopState = { calmTicks: 0, lastReason: 'saturation', promoted: null };
	assert.equal(decideBackstop({ ...base, queuePressureSec: 40 }, neverUp).wanted, false);
});

test('the reservation ladder cuts the hold short — a reserved node comes back NOW', () => {
	// Queue non-zero so the reservation is the only clause that can refuse.
	const promoted: BackstopState = { calmTicks: 0, lastReason: 'saturation', promoted: true };
	assert.equal(
		decideBackstop({ ...base, reserved: true, queuePressureSec: 40 }, promoted).wanted,
		false
	);
});

test('an OUTAGE hold is never released early by calm ticks alone', () => {
	// lastReason 'outage' is deliberately not held down: the claws are back, so
	// there is nothing to damp. Only saturation flaps.
	// Queue non-zero so `lastReason` is the only clause that can refuse.
	const afterOutage: BackstopState = { calmTicks: 0, lastReason: 'outage', promoted: true };
	assert.equal(decideBackstop({ ...base, queuePressureSec: 40 }, afterOutage).wanted, false);
});

// The name of this test used to say "the queue is only worth probing at
// capacity". That stopped being true on 2026-09-24 (`2383b18`): `isAtCapacity`
// no longer gates any probe, it only derives the `atCapacity` FIELD. The
// assertions below are unchanged — the predicate itself never moved.
test('atCapacity is healthy AND nothing free — an outage is not "at capacity"', () => {
	assert.equal(isAtCapacity({ clawsOnline: 3, clawsRegistered: 3, clawsFree: 0 }), true);
	assert.equal(isAtCapacity({ clawsOnline: 3, clawsRegistered: 3, clawsFree: 1 }), false);
	assert.equal(
		isAtCapacity({ clawsOnline: 0, clawsRegistered: 3, clawsFree: 0 }),
		false,
		'an outage is not "at capacity" — there is nothing to queue behind'
	);
});

// --- the counts that feed clawsAreHealthy (moved from runner-health.test.ts) -
//
// These lived in runner-health's suite, which does not own this predicate. The
// incident they pin: both counts used to be taken by BUILDER_LABEL, which is
// ELIGIBILITY and is rewritten by the fast loop every few minutes — so a claw
// that was up and merely DEMOTED disappeared from both. Since tier1 became
// claw-2 alone on 2026-08-25 the fleet routinely reported clawsOnline = 1 with
// three claws reachable. The counts now come from node IDENTITY.

test('outage: every claw offline', () => {
	assert.equal(clawsAreHealthy(0, 3), false);
});

test('healthy: a bare majority of claws online', () => {
	// 2 of 3 is the boundary the proportion was chosen for.
	assert.equal(clawsAreHealthy(2, 3), true);
});

test('outage: only a minority online', () => {
	assert.equal(clawsAreHealthy(1, 3), false);
});

test('THE FIX: two demoted-but-healthy claws are no longer an outage', () => {
	// claw-2 (the only promoted node) goes offline while claw-1 and claw-3 are
	// up but carry no builder label. Counting by LABEL gave registered=1,
	// online=0 -> outage -> the production host promoted as a backstop, with two
	// healthy idle nodes sitting there. Counting by IDENTITY gives 2 of 3.
	assert.equal(clawsAreHealthy(0, 1), false, 'the old label-based counts said outage');
	assert.equal(clawsAreHealthy(2, 3), true, 'identity-based counts see the healthy fleet');
});

// --- the queue is sufficient on its own (2026-09-01) ------------------------
//
// `atCapacity` used to gate saturation. census.ts folds ephemeral nodes'
// mintable slots into `clawsFree` deliberately, so once enough of the fleet
// mints, `clawsFree === 0` never happens and the queue was never consulted
// however long it grew. Three of four nodes were ephemeral that evening: 13
// jobs sat 11-19 minutes across nine repos while this function stayed quiet.

test('THE OUTAGE: a mintable fleet with a long queue promotes the backstop', () => {
	// Exactly the state that night — claws "free" only because their mintable
	// slots are counted, nothing standing able to answer, queue 19 minutes deep.
	const d = decideBackstop(
		{
			...base,
			clawsOnline: 4,
			clawsRegistered: 4,
			clawsFree: 3, // all of it mintable, none of it able to answer now
			queuePressureSec: 19 * 60,
		},
		FRESH
	);
	assert.equal(d.wanted, true, 'a 19-minute queue must reach the production host');
	assert.equal(d.reason, 'saturation');
	assert.equal(d.atCapacity, false, 'and it must do so WITHOUT the fleet reading as full');
});

test('a queue just past the threshold is enough; just under is not', () => {
	const at = (q: number) =>
		decideBackstop({ ...base, clawsFree: 3, queuePressureSec: q }, FRESH).wanted;
	assert.equal(at(SATURATION_QUEUE_SECONDS - 1), false);
	assert.equal(at(SATURATION_QUEUE_SECONDS), true);
});

test('REGRESSION 2026-08-24: a full fleet with nothing waiting still stays out', () => {
	// The bug that made the backstop fire on ordinary load all day. Removing
	// `atCapacity` must not bring it back — `queuePressureSec` is what fixed it.
	const d = decideBackstop({ ...base, clawsFree: 0, queuePressureSec: 0 }, FRESH);
	assert.equal(d.wanted, false, 'flat out with an empty queue buys nothing');
});

test('a reservation still outranks saturation, but never an outage', () => {
	const q = { ...base, clawsFree: 3, queuePressureSec: 19 * 60, reserved: true };
	assert.equal(decideBackstop(q, FRESH).wanted, false, 'saturation yields to the ladder');
	assert.equal(
		decideBackstop({ ...q, clawsOnline: 0, clawsRegistered: 4 }, FRESH).wanted,
		true,
		'an outage ignores the reservation, as it always did'
	);
});

// --- wave 3m §B: a reserve that is never reached last is not a reserve -------
//
// hokon served 204 `hadoku-builder` jobs between 2026-09-10T13:00Z and
// 2026-09-19T20:47Z (job-history, re-measured 2026-09-24; the brief says 210
// over a slightly wider window whose leading edge has since aged out of
// retention). 98 of them started with ZERO claw jobs running anywhere; not one
// started with every claw busy.
//
// The mechanism was NOT this function. There is no `BACKSTOP promote` line in
// any retained mgmt-api log — not one, ever — so `decideBackstop` never asked
// for a single one of those 204. The retired tier ladder wrote the label, and
// what made the damage last for days instead of minutes is that the fan-out
// which removes it only ever LOOKED when its own belief changed. 165 of the 169
// non-prewarm jobs ran on the 26 repos it never looked at; the hub repo, whose
// loop reads the listing every tick, absorbed 4.
//
// So the fix is the one this file can hold: the write is a pure function of the
// OBSERVED registration, identical on both paths, with no clause that lets a
// live label survive because the runner happened to be quiet.

test('a label the backstop does not want is removed even from an OFFLINE runner', () => {
	// 2026-09-18T19:29Z: the fan-out demoted 26 of 27 repos and skipped
	// hadoku-cardtable because its hokon registration was not online. `failed`
	// stayed empty, so the sweep recorded itself as converged and nothing looked
	// again — hokon took seven more builder jobs on that one repo over the next
	// 2h18m, until an unrelated restart forced a fresh converge at 21:47Z.
	assert.equal(backstopLabelWrite({ hasBuilder: true, online: false }, false), 'demote');
	assert.equal(backstopLabelWrite({ hasBuilder: true, online: true }, false), 'demote');
});

test('...but an offline runner is never PROMOTED, because that buys nothing', () => {
	// It is not long-polling, so no job can land on it, and the re-assert every
	// tick labels it the moment it comes back. The asymmetry is the point.
	assert.equal(backstopLabelWrite({ hasBuilder: false, online: false }, true), null);
	assert.equal(backstopLabelWrite({ hasBuilder: false, online: true }, true), 'promote');
});

test('a registration already in the desired state is not written, either way', () => {
	assert.equal(backstopLabelWrite({ hasBuilder: true, online: true }, true), null);
	assert.equal(backstopLabelWrite({ hasBuilder: false, online: true }, false), null);
	// And an offline runner that already matches is still not written.
	assert.equal(backstopLabelWrite({ hasBuilder: false, online: false }, false), null);
});

// --- the log has to say WHY, and has to distinguish the two silences --------

test('the log distinguishes "the queue was empty" from "we never asked"', () => {
	// `queuePressureSec === 0` still means two different things and printing a
	// bare `queue=0s` for both would still be "I could not look" rendering as
	// "nothing is wrong" — but WHICH states are which moved with the caller.
	// Since `2383b18` the caller probes whenever the fleet is up and measured,
	// so the only unasked zero left is the one behind a dark fleet.
	const free = decideBackstop({ ...base, clawsFree: 2, queuePressureSec: 0 }, FRESH);
	assert.equal(free.atCapacity, false, 'off capacity...');
	const offCapacity = explainBackstop({ ...base, clawsFree: 2, queuePressureSec: 0 }, free);
	assert.match(offCapacity, /queue=0s \(probed/, '...and the zero is a READING, because it is');
	assert.doesNotMatch(offCapacity, /NOT PROBED/);

	const full = decideBackstop({ ...base, clawsFree: 0, queuePressureSec: 0 }, FRESH);
	assert.equal(full.atCapacity, true);
	const said = explainBackstop({ ...base, clawsFree: 0, queuePressureSec: 0 }, full);
	assert.match(said, /queue=0s \(probed/, 'at capacity the zero is a reading, and says so');
	assert.doesNotMatch(said, /NOT PROBED/);

	const dark = { ...base, clawsOnline: 0, clawsRegistered: 6, clawsFree: 0, queuePressureSec: 0 };
	const unasked = explainBackstop(dark, decideBackstop(dark, FRESH));
	assert.match(unasked, /NOT PROBED/, 'the dark fleet is the one zero nobody asked for');
});

test('an UNMEASURED tick says it could not look, and says why', () => {
	// Not "the fleet is healthy" and not "the garage is dark" — no counts exist.
	const i = { ...base, clawsOnline: 0, clawsRegistered: 0, ephemeralUnknown: true };
	const d = decideBackstop(i, FRESH);
	assert.equal(d.unmeasured, true);
	const said = explainBackstop(i, d);
	assert.match(said, /UNMEASURED/);
	assert.match(said, /no fleet probe snapshot this tick/);
	assert.match(said, /decided nothing/);
	// And it must NOT claim a claw count it does not have.
	assert.doesNotMatch(said, /0\/0 online/);
});

test('a measured decision prints the counts it rests on', () => {
	const i = { ...base, clawsOnline: 0, clawsRegistered: 6 };
	const d = decideBackstop(i, FRESH);
	assert.equal(d.unmeasured, false, 'absent ephemeralUnknown means MEASURED');
	const said = explainBackstop(i, d);
	assert.match(said, /reason=outage/);
	assert.match(said, /claws=0\/6 online/);
	assert.match(said, /healthy=false/);
});

test('an unprobed queue says WHICH reason it was unprobed for', () => {
	// Only the OUTAGE skips the probe now, and it still says so in its own
	// words rather than sharing a sentence with a state that was measured.
	const dark = { ...base, clawsOnline: 0, clawsRegistered: 6, clawsFree: 0 };
	assert.match(explainBackstop(dark, decideBackstop(dark, FRESH)), /an outage skips it/);
	const free = { ...base, clawsFree: 2 };
	const said = explainBackstop(free, decideBackstop(free, FRESH));
	assert.doesNotMatch(said, /NOT PROBED/, 'a free claw no longer skips anything');
	assert.doesNotMatch(said, /a claw was free/);
});

// --- wave 3n §S2: the caller moved, so the sentence had to ------------------
//
// `2383b18` changed runner-health's probe gate from `isAtCapacity(...)` to
// `fleetIsUp && !c.ephemeralUnknown`, because `atCapacity` was never a
// precondition for saturation and census.ts folds mintable slots into
// `clawsFree`, so under all-JIT the count never reaches zero (#63). This
// explainer still switched on `d.atCapacity`, so the 2026-09-01 shape printed
// "queue=NOT PROBED (a claw was free...)" directly beside `reason=saturation`,
// about a probe that WAS made, hiding the number that drove the promotion.

test('THE 2026-09-01 SHAPE: an off-capacity saturation prints the queue it promoted on', () => {
	const i = {
		...base,
		clawsOnline: 4,
		clawsRegistered: 4,
		clawsFree: 3,
		queuePressureSec: 19 * 60,
	};
	const d = decideBackstop(i, FRESH);
	assert.equal(d.reason, 'saturation', 'the decision this lane must not change');
	assert.equal(d.atCapacity, false, 'and it is reached WITHOUT the fleet reading as full');

	const said = explainBackstop(i, d);
	assert.match(said, /queue=1140s \(probed/, 'the reading that promoted is IN the line');
	assert.match(said, new RegExp(`promotes at ${SATURATION_QUEUE_SECONDS}s`));
	assert.doesNotMatch(said, /NOT PROBED/, 'it was probed; saying otherwise is the defect');
	assert.doesNotMatch(said, /a claw was free/);
});

test('a free claw with a SHORT queue still prints the reading, not a skip', () => {
	// The quiet case matters as much: an operator who sees `queue=12s (probed)`
	// knows the fleet was asked and is fine. `NOT PROBED` there teaches them the
	// line never carries a number off capacity, and they stop reading it.
	const i = { ...base, clawsFree: 2, queuePressureSec: 12 };
	const d = decideBackstop(i, FRESH);
	assert.equal(d.wanted, false, 'below the threshold nothing is promoted');
	const said = explainBackstop(i, d);
	assert.match(said, /queue=12s \(probed/);
	assert.doesNotMatch(said, /NOT PROBED/);
});

test('UNMEASURED never borrows the queue sentence — it cannot reach the clause', () => {
	// decideBackstop returns on ephemeralUnknown before it reads the queue at
	// all, and explainBackstop returns on d.unmeasured above the clause. So the
	// unmeasured line carries NEITHER a reading nor a "not probed" — it says it
	// could not look, which is a third thing.
	const i = {
		...base,
		clawsOnline: 0,
		clawsRegistered: 0,
		queuePressureSec: 999,
		ephemeralUnknown: true,
	};
	const d = decideBackstop(i, FRESH);
	assert.equal(d.unmeasured, true);
	const said = explainBackstop(i, d);
	assert.doesNotMatch(said, /NOT PROBED/);
	assert.doesNotMatch(said, /probed;/, 'and it must not print the 999 it was handed');
	assert.doesNotMatch(said, /999/);
	assert.match(said, /UNMEASURED/);
});

test('the OUTAGE sentence survives, for the reason it was written', () => {
	// Nothing queues behind a dark fleet, and waiting to observe one would add
	// SATURATION_QUEUE_SECONDS to every job's latency during the incident.
	const i = { ...base, clawsOnline: 1, clawsRegistered: 6, clawsFree: 0, queuePressureSec: 0 };
	const d = decideBackstop(i, FRESH);
	assert.equal(d.outage, true);
	const said = explainBackstop(i, d);
	assert.match(said, /queue=NOT PROBED \(an outage skips it/);
	assert.doesNotMatch(said, /\(probed/);
});

test('THE DISASTER CASE: every claw offline still reaches hokon, and says so', () => {
	// The one thing this lane must not break. The backstop is what stands between
	// the fleet and billed minutes when the garage is dark.
	const i = { ...base, clawsOnline: 0, clawsRegistered: 6, clawsFree: 0, queuePressureSec: 0 };
	const d = decideBackstop(i, FRESH);
	assert.equal(d.wanted, true, 'a dark fleet promotes');
	assert.equal(d.outage, true);
	assert.equal(d.reason, 'outage');
	// ...and the write actually lands on the registration, offline claws or not.
	assert.equal(backstopLabelWrite({ hasBuilder: false, online: true }, true), 'promote');
	assert.match(explainBackstop(i, d), /reason=outage/);
});

test('hostMayTakeSaturation: idle takes it; a backlog past 300s takes it at any load; memory is never waived', () => {
	const quiet = { load1: 2, cores: 12, memAvailableMb: 20_000 };
	const pegged = { load1: 90, cores: 12, memAvailableMb: 20_000 };
	const starved = { load1: 2, cores: 12, memAvailableMb: 4_000 };
	assert.deepEqual(hostMayTakeSaturation(quiet, 120), { ok: true, why: 'idle' });
	// 2026-10-21: the queue sat 25 minutes while hokon ran load 30-46 under the
	// operator's sessions. Saturation alone (120s) still respects the desktop…
	const refused = hostMayTakeSaturation(pegged, 120);
	assert.equal(refused.ok, false);
	assert.match(refused.why, /not idle: load 7\.50\/core .*backlog past 300s/);
	// …a BACKLOG does not. Same 300s at which ci:queue-health declares the
	// fleet not serving work.
	assert.deepEqual(hostMayTakeSaturation(pegged, BACKLOG_QUEUE_SECONDS), {
		ok: true,
		why: 'backlog',
	});
	assert.deepEqual(hostMayTakeSaturation(pegged, 2684), { ok: true, why: 'backlog' });
	// Memory is physical: a Forge job without it fails slowly. No backlog waives it.
	const mem = hostMayTakeSaturation(starved, 2684);
	assert.equal(mem.ok, false);
	assert.match(mem.why, /memory: 4000 MB available .*does not override/);
	// Could not look is not idle, backlog or not.
	assert.equal(hostMayTakeSaturation(null, 2684).ok, false);
	assert.equal(
		hostMayTakeSaturation({ load1: 1, cores: 0, memAvailableMb: 20_000 }, 2684).ok,
		false
	);
	assert.equal(describeSaturationHost({ ok: true, why: 'idle' }, 120), 'idle');
	assert.equal(
		describeSaturationHost({ ok: true, why: 'backlog' }, 420),
		'backlog 420s ≥ 300s (load ignored)'
	);
});

test('isHostIdle: quiet on load AND memory; null (could not read) is never idle', () => {
	assert.equal(isHostIdle({ load1: 2, cores: 12, memAvailableMb: 20_000 }), true);
	// 2026-10-21: load 46 on 12 cores (the operator's sessions) is still idle
	// enough — memory is the bound; a pegged box is not.
	assert.equal(isHostIdle({ load1: 46, cores: 12, memAvailableMb: 20_000 }), true);
	assert.equal(isHostIdle({ load1: 60, cores: 12, memAvailableMb: 20_000 }), false, 'load');
	assert.equal(isHostIdle({ load1: 1, cores: 12, memAvailableMb: 4_000 }), false, 'memory');
	assert.equal(isHostIdle(null), false);
});
