/**
 * floor-probe's §7 quiet-window rule — split out of `floor-probe.mjs` (wave 5q
 * lane A, pure move) so that file reaches the 800-line ceiling. No IO here
 * either; see that file's own header for why the split exists at all. The
 * I/O half — reading the covered repos' shipped workflows and cron-worker's
 * profiles, then calling this rule with what they found — is
 * `floor-probe-window-check.mjs`'s `checkQuietWindow`, which is not a pure
 * rule and so does not belong here.
 */

// ---------------------------------------------------------------------------
// §7 — the quiet window
// ---------------------------------------------------------------------------

/** §7 — how far back a daily cron firing still blocks the probe. */
export const QUIET_LOOKBACK_MINUTES = 15;

/**
 * §7 — may the shadow path run right now?
 *
 * Two conditions, both from §7, and the return is a REASON rather than a
 * boolean because "not now" and "I could not tell" are different jobs and the
 * caller must not treat the second as the first.
 *
 *   (a) `nodeReservation()` reports hokon is NOT reserved. Irrelevant to claws
 *       directly, but a cheap correlated signal that the fleet is not
 *       mid-nightly-fan-out.
 *   (b) None of the covered repos' staggered daily crons fired in the preceding
 *       15 minutes. Eleven of them exist, at minutes 3, 8, … 53 of hour 06 UTC
 *       (board P6.6), and this reads their SCHEDULES rather than that sentence —
 *       "a fixed window is a guess about someone else's schedule, and it goes
 *       stale silently", which is node-reservation.ts's own argument and applies
 *       here unchanged.
 *
 * `schedules` IS REQUIRED TO BE NON-EMPTY. A caller that could not read the
 * workflows gets `could-not-tell`, not a quiet window: eleven repos are known
 * to carry daily crons, so zero schedules means the reader failed, and probing
 * on that basis is exactly the "I could not look rendering as nothing is wrong"
 * failure. This is the one place this file differs from `node-reservation.ts`,
 * which fails OPEN on an unreadable profiles file — correctly, because there the
 * failure direction is "CI keeps working". Here it is "add load to a fleet that
 * may be mid-fan-out", so it fails CLOSED.
 */
export function quietWindow({
	nowMinutesOfDay,
	reserved = false,
	reservationReason = null,
	schedules = [],
	lookbackMinutes = QUIET_LOOKBACK_MINUTES,
}) {
	if (!Number.isFinite(nowMinutesOfDay)) {
		return { quiet: false, why: 'could-not-tell', detail: 'no clock' };
	}
	if (!schedules.length) {
		return {
			quiet: false,
			why: 'could-not-tell',
			detail: 'no daily cron schedules could be read — refusing to probe blind',
		};
	}
	if (reserved) {
		return { quiet: false, why: 'reserved', detail: reservationReason ?? 'hokon is reserved' };
	}
	for (const s of schedules) {
		const at = typeof s === 'number' ? s : s.minutesOfDay;
		if (!Number.isFinite(at)) continue;
		const since = (nowMinutesOfDay - at + 1440) % 1440;
		if (since < lookbackMinutes) {
			return {
				quiet: false,
				why: 'cron',
				detail: `${typeof s === 'number' ? 'a daily cron' : (s.name ?? 'a daily cron')} fired ${since}m ago`,
			};
		}
	}
	return { quiet: true, why: null, detail: null };
}

/**
 * Minutes-of-day a 5-field DAILY cron fires, or null for anything else.
 *
 * A deliberate re-derivation of `node-reservation.ts#dailyCronMinutes` over a
 * different input (GitHub workflow `schedule:` expressions, not cron-worker
 * profiles) — and the narrowness is the same on purpose: an expression with a
 * step, a list or a day-of-week constraint contributes NO window rather than a
 * half-understood one. A star-slash-10 minute field firing every ten minutes
 * would otherwise block the probe permanently, and a weekly `0 6 * * SUN` would
 * block it on the wrong day.
 */
export function dailyCronMinutes(expr) {
	if (typeof expr !== 'string') return null;
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [min, hour, dom, mon, dow] = parts;
	if (dom !== '*' || mon !== '*' || (dow !== '*' && dow !== '?')) return null;
	if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null;
	const m = Number(min);
	const h = Number(hour);
	if (m > 59 || h > 23) return null;
	return h * 60 + m;
}
