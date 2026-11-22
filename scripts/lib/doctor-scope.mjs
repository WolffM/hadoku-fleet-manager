/**
 * `fleet doctor --disk`: judge a run on the DISK findings alone.
 *
 * Why a scope exists (fleet-manager-private#140): `doctor` fails on every
 * blocking finding, and on any night that set holds findings that are red by
 * construction (hokon's `cpu-thermal/no-load-reading` and `smart-health/
 * unreadable`, every night). A gate over the whole set would page every day and
 * be muted by the first week, so the one finding that mattered went nowhere.
 * claw-5's root went from 42% free on 2026-11-14 to 3.2% on 11-21. `disk-free`
 * was blocking in the record from 11-21, but health-refresh, a recorder, only
 * logged it at INFO.
 *
 * A fixed scope, not a `--category <list>` flag: a typo in a free-form list
 * judges nothing and passes forever, which is a gate nobody can tell is dead.
 *
 * What counts:
 *   - `disk-free` and `disk-work-free` at blocking class (under
 *     `DISK_BLOCKING_FREE_PCT`, 10%).
 *   - THE BACKSTOP INCLUDED. `backstopAdvisory` demotes the backstop's node
 *     findings because its reboots and kernel are the operator's. A full root
 *     is not a reboot. On hokon it stops every PM2 service along with CI, so
 *     the demotion (`wasBlocking: true`) is undone here, for disk only.
 *   - `unreachable` (no usable `$health` record) stays in: "I could not look"
 *     never renders as "nothing is wrong".
 */
import { ADVISORY } from './preflight.mjs';

export const DISK_CATEGORIES = new Set(['disk-free', 'disk-work-free']);

/** The findings that decide a `--disk` run, from the classified set. */
export function diskVerdict(classified) {
	return (classified ?? []).filter((f) => {
		if (!f) return false;
		if (f.category === 'unreachable') return f.class !== ADVISORY;
		if (!DISK_CATEGORIES.has(f.category)) return false;
		return f.class !== ADVISORY || f.wasBlocking === true;
	});
}
