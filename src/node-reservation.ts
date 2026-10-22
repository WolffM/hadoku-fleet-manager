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
 * The CRON rungs below are genuinely fleet-wide and stay that way: `inFlight`
 * counts dispatches through mgmt-api, which runs on one box, and the declared
 * window comes from one `profiles.json`. Neither has a node to key on.
 *
 * WHY NOT A 12am–6am BLACKOUT
 * ---------------------------
 * A fixed window is a guess about someone else's schedule, and it goes stale
 * silently in both directions: it keeps hokon idle for six hours when the crons
 * finished in forty minutes, and it does nothing at all for a cron that moves to
 * 09:00 or one added next month. Both failures are invisible — nobody notices a
 * runner that was needlessly unavailable.
 *
 * So the window is DERIVED, from the two places that already know the truth:
 *
 *   1. LIVE — cron work is dispatched through mgmt-api (`dispatchJob`), so an
 *      in-flight counter is exact. No schedule, no duration guess: while a cron
 *      job is actually running, hokon is reserved, and the moment it finishes it
 *      is not.
 *   2. DECLARED — `services/cron-worker/profiles.json` holds every schedule.
 *      Some cron work may execute entirely inside cron-worker without touching
 *      mgmt-api, so a profile's cron time opens a bounded reservation window as
 *      a backstop. Adding a cron reserves hokon automatically; nothing here
 *      needs editing.
 *
 * The live signal is the authority; the declared window only covers what it
 * cannot see, and is deliberately short so a stuck window cannot strand the
 * node for a whole night.
 */

import { readFileSync } from 'node:fs';
import { cronProfilesPath } from './host.js';
import { activeLeases } from './host-lease.js';

/**
 * How long after a profile's cron fires we keep the declared reservation open.
 * Deliberately modest: this is a BACKSTOP for cron work the live counter cannot
 * see, not a model of how long the nightly set takes. Overshooting costs idle CI
 * capacity, and the live signal already covers the common case.
 */
export const DECLARED_WINDOW_MINUTES = 90;

let inFlight = 0;

/**
 * Which NODES are serving pm2-host work, published by runner-health.
 *
 * A SET, not a flag. `pm2-host` has been PROBED rather than declared since
 * 2026-09-15 (#6), so a claw can EARN it and migration one's box will; one
 * boolean for two holders answers about the fleet when every caller is asking
 * about a box.
 *
 * A push rather than a probe: runner-health already holds the runner listing and
 * the in-progress runs, so it can answer this for free, while the fast loop runs
 * every 60s and must not spend an API call per tick re-asking. Stale by at most
 * one runner-health tick, which is fine — deploys are minutes long and the cron
 * signal, which is the one that matters at night, is exact.
 */
let pm2HostBusyNodes: ReadonlySet<string> = new Set<string>();

/**
 * Publish the whole set, never one node at a time.
 *
 * The writer holds ONE listing, and a node that has dropped off it is no longer
 * busy — an incremental setter would need a matching clear that nobody would
 * remember to call, and a node stuck `true` is a node silently withheld from CI
 * forever.
 */
export function setPm2HostBusy(nodes: Iterable<string>): void {
	pm2HostBusyNodes = new Set(nodes);
}

/**
 * Is `node` serving pm2-host work right now?
 *
 * WITH NO ARGUMENT it answers "is ANY node", which is the fleet-wide collapse
 * this set exists to end. It is kept for the one caller that has no node in
 * hand — `tickFleet`'s `pm2HostBusy` default parameter in `fleet-loop.ts`,
 * which reserves tiers by `RESERVABLE_NODES` membership rather than by asking
 * per machine. That call site is the last fleet-blind reader of this rung: it
 * over-reserves (a busy holder anywhere forces hokon's tier off), which costs
 * capacity rather than correctness, and converting it means restructuring the
 * fast loop's reservation to run per tier machine.
 */
export function getPm2HostBusy(node?: string): boolean {
	return node === undefined ? pm2HostBusyNodes.size > 0 : pm2HostBusyNodes.has(node);
}

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
	pm2HostBusyNodes = new Set<string>();
}

interface Profile {
	name?: string;
	schedule?: { cron?: string; timezone?: string };
	jobs?: unknown[];
}

function loadProfiles(): Profile[] {
	// No profiles path: the host reports busy periods through leases instead.
	const path = cronProfilesPath();
	if (path) {
		try {
			const raw = JSON.parse(readFileSync(path, 'utf8')) as { profiles?: Profile[] };
			if (Array.isArray(raw.profiles)) return raw.profiles;
		} catch {
			// An unreadable file reserves nothing, which is
			// the fail-open direction — CI keeps working, it just loses the backstop.
		}
	}
	return [];
}

/**
 * Minutes-of-day a 5-field cron expression fires, for the DAILY case only.
 *
 * Deliberately narrow. This exists to place a bounded window around a known
 * daily job, not to reimplement cron: an expression with a step, a list, or a
 * day-of-week constraint returns null and simply contributes no declared
 * window, leaving the live counter to cover it. A half-understood cron parser
 * that silently mis-fires a reservation would be worse than none.
 */
export function dailyCronMinutes(expr: string | undefined): number | null {
	if (!expr) return null;
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [min, hour, dom, mon, dow] = parts;
	if (dom !== '*' || mon !== '*' || dow !== '*') return null;
	if (!/^\d{1,2}$/.test(min ?? '') || !/^\d{1,2}$/.test(hour ?? '')) return null;
	const m = Number(min);
	const h = Number(hour);
	if (m > 59 || h > 23) return null;
	return h * 60 + m;
}

/**
 * Is `now` inside a declared cron window? Schedules are UTC in profiles.json
 * (`timezone: Etc/UTC`), so this compares in UTC and never touches local time —
 * hokon's RTC is local, which has already caused one class of clock confusion.
 */
export function inDeclaredCronWindow(
	now: Date,
	profiles: Profile[] = loadProfiles(),
	windowMinutes: number = DECLARED_WINDOW_MINUTES
): string | null {
	const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
	for (const p of profiles) {
		if ((p.schedule?.timezone ?? 'Etc/UTC') !== 'Etc/UTC') continue;
		const start = dailyCronMinutes(p.schedule?.cron);
		if (start === null) continue;
		// Wrap across midnight: a 23:30 cron with a 90m window covers 00:00–01:00.
		const delta = (nowMin - start + 1440) % 1440;
		if (delta < windowMinutes) return p.name ?? 'cron';
	}
	return null;
}

export interface Reservation {
	reserved: boolean;
	/** 'cron-running' | 'host-lease' | 'cron-window' | 'pm2-host' | null */
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
 * NODE-BLIND on purpose. It takes a clock, a rung and a schedule, and asks
 * nothing about which box is being judged — so a claw that EARNS `pm2-host`
 * (probed since 2026-09-15, #6) is reserved by exactly this function and not by
 * a second copy grown beside it for the non-hokon case. The caller decides WHOSE
 * rung it is passing: `getPm2HostBusy(node)`, once per node it is placing on.
 */
export function nodeReservation(
	now: Date = new Date(),
	pm2HostBusy = false,
	profiles?: Profile[]
): Reservation {
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
	const window = inDeclaredCronWindow(now, profiles);
	if (window) {
		return { reserved: true, reason: 'cron-window', detail: `within ${window} window` };
	}
	return { reserved: false, reason: null, detail: null };
}
