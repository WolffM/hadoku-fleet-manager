/**
 * `items.map(fn)` with at most `limit` calls in flight.
 *
 * Results come back in INPUT order, not completion order, so a caller that
 * cares which item produced which result does not have to carry the index
 * itself. A rejection from any `fn` rejects the whole map, the same as
 * `Promise.all` — callers that must survive one bad item catch inside `fn`.
 *
 * Why not `Promise.all(items.map(fn))`: the GitHub token behind the fleet
 * sweeps is shared with the fast loop, and 27 simultaneous listings is the
 * kind of burst that trips GitHub's secondary rate limit and stalls BOTH loops.
 * A bounded fan-out keeps the sweep short without spending the token wide.
 */
/**
 * How many GitHub listings any fleet sweep may have in flight at once.
 *
 * ONE number, because there is ONE token behind every sweep. runner-health had
 * this at 6 with the reasoning below; the dispatcher had no cap at all and ran
 * `Promise.all` over every due repo — the exact shape this file's header warns
 * about. That was survivable only while most repos were COLD and few came due
 * per tick. On 2026-09-02 the poll interval dropped below the fast-loop tick so every
 * repo became due EVERY tick, turning a tiered poll into a sustained 26-wide
 * burst once a minute, and `ci:queue-health` began failing with "could not read
 * the queue for 26 repo(s)" — all 26 at once, which is a burst signature, not
 * a per-repo fault.
 *
 * Six turns 26 listings into five rounds of single-digit seconds, inside a 60s
 * tick, so bounding it costs no discovery latency.
 */
export const SWEEP_CONCURRENCY = 6;

export async function mapConcurrent<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new Error(`mapConcurrent: limit must be a positive integer, got ${limit}`);
	}
	const results: R[] = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	};
	const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}
