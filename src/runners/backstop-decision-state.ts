/**
 * THE BACKSTOP DECISION'S CROSS-TICK MEMORY — five independent trackers
 * `runBackstopDecision` reads and updates on every call, all in-memory only
 * (lost on an mgmt-api restart, which is the SAFE direction for all five —
 * each one's own doc below says why). Split out of `backstop-decision.ts`
 * (wave shrink-1 lane B, 800-line ceiling) so the bookkeeping sits apart
 * from the decision that reads and updates it.
 *
 * Exposed as getter/setter pairs rather than bare bindings: a REASSIGNED
 * primitive (unlike a `Map`, which `runBackstopDecision` could still mutate
 * directly by reference) cannot be written from outside the module that
 * declares it, so crossing the file boundary needs a function either way.
 * `backstop-decision.ts` re-exports every name here under its original path.
 */
import type { Reservation } from '../node-reservation.js';

/**
 * Last backstop state we pushed to the NON-self repos. `null` = unknown, which
 * is the state after every mgmt-api restart, and it deliberately forces one
 * converge pass rather than assuming the fleet matches: a restart during an
 * outage would otherwise leave 25 repos promoted with nothing left to demote
 * them.
 */
let backstopFleetState: boolean | null = null;
export const getBackstopFleetState = (): boolean | null => backstopFleetState;
export const setBackstopFleetState = (v: boolean | null): void => {
	backstopFleetState = v;
};

/**
 * Whether the operator has an open 🔻 for the backstop. Gates the 🔺 so a
 * recovery note only ever closes a promote the operator actually saw — a
 * saturation promote is silent, and a silent promote must not produce a loud
 * "a claw is back" for an outage that never happened.
 */
let backstopAlerted = false;
export const getBackstopAlerted = (): boolean => backstopAlerted;
export const setBackstopAlerted = (v: boolean): void => {
	backstopAlerted = v;
};

/**
 * Consecutive ticks the backstop has been UNwanted. Demotion waits for this to
 * reach BACKSTOP_CALM_TICKS; promotion never waits.
 *
 * The asymmetry is the point. Promoting early costs one extra label on a box
 * that was going to sit idle; demoting early costs a flap, because saturation
 * is computed from an instantaneous `atCapacity && queuePressure >= 100s` that
 * toggles every time a job starts or finishes. Measured on 2026-08-25 the
 * backstop promoted and demoted on almost every tick:
 *
 *   05:04 promote (saturation): 2/2 online, 0 free
 *   05:13 promote (saturation): 2/2 online, 0 free
 *   05:23 demote: 3 claw(s) online → stripped temporary labels
 *   05:25 promote (saturation): 3/3 online, 0 free
 *   05:51 promote (saturation): 3/3 online, 0 free
 *
 * Each of those rewrites `hadoku-builder` on 13-25 runners across the fleet, so
 * the flap is both the source of the 🔺 spam and a standing pile of GitHub API
 * writes. It also defeats the `backstopAlerted` gate below: over the fifteen
 * days to 2026-08-28 the channel got 19 "a claw is back online" against 3
 * outage notices, six of them on 2026-08-21 alone, a day with no outage at all.
 */
let backstopCalmTicks = 0;
export const getBackstopCalmTicks = (): number => backstopCalmTicks;
export const setBackstopCalmTicks = (v: number): void => {
	backstopCalmTicks = v;
};

/**
 * Why the backstop was last wanted. Hysteresis applies to SATURATION only.
 *
 * Every flap in the logs says `(saturation)` — that is the condition computed
 * from an instantaneous `atCapacity && queuePressure >= 100s`, and it is the one
 * that oscillates. An outage ending is a real state change, and a cron
 * reservation taking the node back is a priority decision that must land in
 * the same tick: "declining to promote is not enough — a promotion from 23:50
 * would otherwise sit through the whole run." Damping either of those would turn
 * a noise fix into a 30-minute delay on the thing the ladder exists to protect.
 */
let backstopLastReason: 'outage' | 'saturation' | null = null;
export const getBackstopLastReason = (): 'outage' | 'saturation' | null => backstopLastReason;
export const setBackstopLastReason = (v: 'outage' | 'saturation' | null): void => {
	backstopLastReason = v;
};

/**
 * Zombie count last announced, so the warning fires on CHANGE rather than every
 * tick. `null` is "never announced", which is why zero is not the initial value:
 * a fleet that starts with zero zombies must not print the all-clear.
 *
 * Cross-tick memory, so it is in `__resetBackstopDecisionForTesting`.
 */
let queueZombiesLogged: number | null = null;
export const getQueueZombiesLogged = (): number | null => queueZombiesLogged;
export const setQueueZombiesLogged = (v: number | null): void => {
	queueZombiesLogged = v;
};

/**
 * Reservation override for tests.
 *
 * REQUIRED, not a convenience: the real `nodeReservation` consults the
 * DECLARED cron window derived from profiles.json, so a suite run inside the 90
 * minutes after any daily cron would see the backstop correctly decline to
 * promote and read that as a broken test. A wall-clock-dependent test is a flake
 * with a schedule.
 */
let reservationOverride: ((pm2Busy: boolean) => Reservation) | null = null;
export function __setReservationForTesting(fn: ((pm2Busy: boolean) => Reservation) | null): void {
	reservationOverride = fn;
}
export const getReservationOverride = (): ((pm2Busy: boolean) => Reservation) | null =>
	reservationOverride;

/** Test seam: cross-tick memory this module owns. */
export function __resetBackstopDecisionStateForTesting(): void {
	backstopFleetState = null;
	backstopAlerted = false;
	backstopCalmTicks = 0;
	backstopLastReason = null;
	queueZombiesLogged = null;
}
