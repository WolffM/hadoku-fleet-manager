/**
 * node-reservation — keep the PM2 HOST off low-priority work while it is doing
 * high-priority work.
 *
 * The pm2 host is not just a builder. It runs mgmt-api, the tunnel, the other production services,
 * and the nightly cron set. Those matter more than any CI job, so the node
 * carries a PRIORITY LADDER rather than a single "is it busy" flag:
 *
 *     pm2-host  >  hadoku-builder  >  taskauto
 *
 * While it is serving a rung, nothing below that rung may be scheduled onto it.
 * The fast loop consults this before promoting that node's tier.
 *
 * THE NODE IS NOT NAMED HERE, AND THAT IS NOT TIDINESS. `pm2-host` stopped being
 * a declared fact about hokon on 2026-09-15 (#6): it is PROBED now, so a claw can
 * EARN it, and migration one's box will. Everything below already keys on the
 * rung rather than on a hostname — `nodeReservation` takes the busy flag as an
 * argument and asks nothing about who is asking — so the ladder transfers to
 * whichever node carries the label, and `node-reservation.test.ts` pins that it
 * gives the same answer either way.
 *
 * THE pm2-host RUNG IS NOW PER NODE. It was one module-level boolean until
 * 2026-09-16, which was exact only while exactly one node carried the label:
 * with two holders it collapsed both into one answer, so a busy claw would hold
 * an idle hokon off builder work and an idle claw would clear a busy one.
 * `setPm2HostBusy` takes the SET of nodes serving that rung, and
 * `getPm2HostBusy(node)` answers for the box being placed on. runner-health is
 * still the only writer — it holds the runner listing already.
 *
 * The CRON rung is genuinely fleet-wide and stays that way: `inFlight` counts
 * dispatches through mgmt-api, which runs on one box, so it has no node to key
 * on.
 *
 * NO SCHEDULE, NO WINDOW — ONLY WHAT IS RUNNING
 * ---------------------------------------------
 * A fixed window is a guess about someone else's schedule. It goes stale in both
 * directions and silently: it holds hokon idle after the work is done, and does
 * nothing for work that moved. Two signals replace it, both observed:
 *
 *   1. LIVE — every cron dispatch in mgmt-api (scheduled, privileged, manual)
 *      runs through one helper that counts it for its whole duration, so while
 *      nightly work is actually running here, CI is not admitted on top of it.
 *   2. THE HOST ITSELF — the backstop promotes a node only on its measured load
 *      and memory (`hostMayTakeSaturation`), and a node whose load cannot be read
 *      is refused. Work the counter cannot see (a service that answers 202 and
 *      keeps going) still shows up there.
 *
 * Until 2026-11-06 each daily profile in cron-worker's `profiles.json` also
 * opened a 90-minute "declared window". Three overlapping ones held hokon off CI
 * from 06:00 to 09:30Z every morning, against ~27 minutes of real cron work, while
 * cardtable's queue sat 35 minutes behind a full fleet. The window was meant as a
 * backstop for what the counter could not see; it never was one, because with the
 * host gate above there is no case where it adds protection — only cases where it
 * blocks. And the counter could not see most of the nightly set, which was the
 * real gap: it lived inside the HTTP forwarder and missed every systemd one-shot,
 * `fleet` CLI check and privileged job. That is fixed at the dispatch boundary.
 */

// `activeLeases` is read from the ledger directly, not through `host-lease.ts`
// (`tenancy`): a domain reading another domain's facts through that other
// domain's own module, rather than through a state record, is the rule-5
// violation plan §3.2 describes. `host-lease-record.ts` is the state record
// (wave layers-3 lane S, cut (iii)); `host-lease.ts` re-exports the same name
// for its own callers.
import { activeLeases } from './host-lease-record.js';
import { __resetPm2HostBusyForTesting } from './pm2-host-busy-store.js';

let inFlight = 0;

/** Wrap a cron dispatch so the node is reserved for exactly its duration. */
export function noteCronStart(): void {
	inFlight++;
}
export function noteCronEnd(): void {
	if (inFlight > 0) inFlight--;
}
export function inFlightCronJobs(): number {
	return inFlight;
}
export function __resetReservationForTesting(): void {
	inFlight = 0;
	__resetPm2HostBusyForTesting();
}

export interface Reservation {
	reserved: boolean;
	/** 'cron-running' | 'host-lease' | 'pm2-host' | null */
	reason: string | null;
	detail: string | null;
}

/**
 * Should the pm2 host be kept off `hadoku-builder` work right now?
 *
 * `pm2HostBusy` is passed in rather than probed here: the caller already holds
 * the GitHub runner listing, and a reservation check must not cost an API call
 * on every fast-loop tick.
 *
 * NODE-BLIND on purpose. It takes a clock and a rung, and asks
 * nothing about which box is being judged — so a claw that EARNS `pm2-host`
 * (probed since 2026-09-15, #6) is reserved by exactly this function and not by
 * a second copy grown beside it for the non-hokon case. The caller decides WHOSE
 * rung it is passing: `getPm2HostBusy(node)`, once per node it is placing on.
 */
export function nodeReservation(now: Date = new Date(), pm2HostBusy = false): Reservation {
	if (inFlight > 0) {
		return { reserved: true, reason: 'cron-running', detail: `${inFlight} cron job(s) in flight` };
	}
	// A lease is the host's own statement that it is busy, so it ranks with the
	// live counter, ahead of anything inferred.
	const held = activeLeases(now.getTime());
	if (held.length) {
		return {
			reserved: true,
			reason: 'host-lease',
			detail: `held by ${held.map((l) => l.holder).join(', ')}`,
		};
	}
	if (pm2HostBusy) {
		return { reserved: true, reason: 'pm2-host', detail: 'serving pm2-host work' };
	}
	return { reserved: false, reason: null, detail: null };
}
