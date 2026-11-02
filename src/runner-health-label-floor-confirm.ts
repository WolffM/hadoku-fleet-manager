/**
 * Confirming a label-floor zero with a second look, seconds after the first,
 * before paging on it — split out of `runner-health-label-floor.ts` (wave
 * shrink-1 lane C).
 */
import { ghGet, type GhRunner } from './lib/github-client.js';
import { countLabels } from './runner-health-mint.js';

/**
 * SELF_REPO's self-hosted runner listing, asked for a page big enough to BE a
 * census. `null` is "I could not look" and every caller treats it that way.
 *
 * One door for this read so the floor check and the read that CONFIRMS a floor
 * breach cannot drift apart — a confirmation taken through a differently-shaped
 * request is not a confirmation of anything.
 */
export async function readRunnerListing(
	token: string
): Promise<{ runners?: GhRunner[]; total_count?: number } | null> {
	return ghGet<{ runners?: GhRunner[]; total_count?: number }>(
		'/actions/runners?per_page=100',
		token
	);
}

/**
 * A floor zero is READ TWICE, seconds apart, before the tick counts as a breach.
 *
 * The tick debounce above absorbs a blip that clears within ten minutes. It does
 * NOT absorb the failure mode it was written for when that failure lasts hours:
 * on 2026-09-12 GitHub's broker answered hokon's message long-poll with
 * `InternalServerError` repeatedly between 19:21Z and 22:45Z, and through that
 * window `/actions/runners` reported hokon — and every warm claw — `offline`
 * on some reads and `online` on others, ten minutes apart. Eighteen 🚨 went out
 * over eleven hours claiming `pm2-host`, `taskauto` and `av1-nvenc` had no
 * online runner and that jobs "will queue" (#24).
 *
 * They had not. GitHub scheduled and completed a `redeploy` job ON hokon at
 * 06:12:32-06:12:50Z, and the 06:13:49Z tick then read `pm2-host=0
 * hokon:offline` seventy-seven seconds later. The listing was faithful to what
 * the API returned; the API's `status` was momentarily wrong. Two consecutive
 * TICKS can both land in such a window — and did, twelve times in a row —
 * because the degradation outlives the debounce. Two READS seconds apart do
 * not, because the listener re-polls in between.
 *
 * Retrying is NOT tolerating (see `check-queue-health`'s READ_ATTEMPTS): a zero
 * both reads agree on still advances the streak and still pages. Only an
 * UNCONFIRMED zero is held — and held, not cleared, so a sustained outage that
 * flaps keeps its streak instead of being reset by the flapping.
 */
export const FLOOR_CONFIRM_DELAY_MS = 5000;

/** Test seam for {@link FLOOR_CONFIRM_DELAY_MS}. Not part of the supported API. */
let floorConfirmDelayMs: number = FLOOR_CONFIRM_DELAY_MS;
export function __setFloorConfirmDelayForTesting(ms: number | null): void {
	floorConfirmDelayMs = ms ?? FLOOR_CONFIRM_DELAY_MS;
}

/** The delay actually in effect, in whole seconds — for an alert message that names it. */
export function floorConfirmDelaySec(): number {
	return Math.round(floorConfirmDelayMs / 1000);
}

/** What a second look at the listing found, or `null` for "I could not look". */
export interface FloorConfirmation {
	/** Online-runner label census from the CONFIRMING read. */
	labels: Record<string, number>;
	/** Online runner names from the confirming read, for the message. */
	names: string;
	/** Registrations the confirming read saw, online or not. */
	registrations: number;
}

/**
 * Look a second time before saying a routing label has no online runner.
 *
 * Seconds apart, not ticks: see FLOOR_CONFIRM_DELAY_MS for the 2026-09-12
 * measurement that distinguishes the two. Costs one GitHub call, and only on a
 * tick that is about to page.
 *
 * `null` for anything it could not READ — an unreadable listing, a suppressed
 * budget, or a listing that came back TRUNCATED. A partial census cannot
 * confirm a zero any more than it can produce one.
 */
export async function confirmFloorZero(token: string): Promise<FloorConfirmation | null> {
	if (floorConfirmDelayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, floorConfirmDelayMs));
	}
	const resp = await readRunnerListing(token);
	if (!resp || !Array.isArray(resp.runners)) return null;
	if (typeof resp.total_count === 'number' && resp.total_count > resp.runners.length) return null;
	const online = resp.runners.filter((r) => r.status === 'online');
	return {
		labels: countLabels(online),
		names: online.map((r) => r.name).join(', ') || '(none)',
		registrations: resp.runners.length,
	};
}
