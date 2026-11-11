/**
 * WHEN `fleet bootcamp` RUNS ITS IDLE-ONLY BENCHMARKS — once a week per node,
 * on a weekday of its own (operator, 2026-11-11).
 *
 * `ci:bootcamp` runs nightly (hadoku_site f160c9faf, 2026-11-04) so the
 * `$capabilities` record placement reads never goes stale. Until this module,
 * every one of those runs also ran `cargo-bevy`'s all-core compile benchmark
 * on every node: a full-CPU minute beside whatever CI the node was running,
 * and a drain of up to 20 minutes to re-take it whenever a job was there. The
 * benchmark measures hardware, and hardware does not change nightly. The
 * presence probes (is the tool still there, does it still run) stay nightly.
 *
 * THE SLOT IS DERIVED, NOT DECLARED. Every machine in the manifest, sorted by
 * name, takes weekday `index % 7` (UTC, the cron's clock). Ten nodes fill each
 * day with one or two and never more, which a hash of the name cannot promise.
 * Adding a node can move others to a new day; one week then runs a node twice
 * or waits eight days, which is harmless. The slot uses the WHOLE fleet, never
 * the run's `--machine` scope, so a node's day does not depend on who asked.
 *
 * DUE regardless of the day:
 *   - `--measure`, the operator asking for a measurement now;
 *   - a node with no recorded measurement for that capability. A new node is
 *     benchmarked at its first bootcamp, never left waiting up to a week.
 *
 * A node that is not due keeps its record. That is a SCHEDULE, not a finding:
 * the judge carries the previous verdict (bootcamp-judge.mjs `deferred`), so
 * no label moves and the run stays green. A slot day the node spends
 * unreachable or busy is INCONCLUSIVE as before, and the record waits a week.
 */

/** Weekday names, indexed by `Date#getUTCDay`. */
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The UTC weekday (0 = Sunday) `node` runs its benchmark on, or null for a
 * node the manifest does not list.
 *
 * @param {string} node
 * @param {string[]} fleet every machine name in the manifest
 */
export function benchmarkWeekday(node, fleet) {
	const i = [...fleet].sort().indexOf(node);
	return i < 0 ? null : i % 7;
}

/** The next UTC date (YYYY-MM-DD) after `nowMs` whose weekday is `day`. */
function nextOn(day, nowMs) {
	const now = new Date(nowMs);
	const ahead = (day - now.getUTCDay() + 7) % 7 || 7;
	return new Date(nowMs + ahead * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Which of `idleOnly` this run measures on `node`, and which it defers.
 *
 * @param {object} args
 * @param {string} args.node
 * @param {object} args.machine the node's manifest entry
 * @param {string[]} args.fleet every machine name in the manifest
 * @param {string[]} args.idleOnly the registry's idle-only measured capabilities
 * @param {number} args.nowMs
 * @param {boolean} [args.force] `--measure`
 * @returns {{ measure: boolean, weekday: string|null, deferred: {id: string, nextOn: string}[], why: string }}
 */
export function benchmarkPlan({ node, machine, fleet, idleOnly, nowMs, force = false }) {
	const day = benchmarkWeekday(node, fleet);
	const weekday = day === null ? null : WEEKDAYS[day];
	if (!idleOnly.length) return { measure: false, weekday, deferred: [], why: 'nothing to measure' };
	if (force) return { measure: true, weekday, deferred: [], why: '--measure' };
	const recorded = machine?.$capabilities?.measurements ?? {};
	const missing = idleOnly.filter((id) => !recorded[id]);
	if (missing.length)
		return {
			measure: true,
			weekday,
			deferred: [],
			why: `no measurement on record: ${missing.join(', ')}`,
		};
	if (day === null) return { measure: true, weekday, deferred: [], why: 'not in the manifest' };
	if (new Date(nowMs).getUTCDay() === day)
		return { measure: true, weekday, deferred: [], why: `its weekday (${weekday})` };
	const next = nextOn(day, nowMs);
	return {
		measure: false,
		weekday,
		deferred: idleOnly.map((id) => ({ id, nextOn: next })),
		why: `measured ${weekday}s; next ${next}`,
	};
}
