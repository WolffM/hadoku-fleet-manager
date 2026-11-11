/**
 * doctor-findings-qualify — WHAT A NODE'S maxConcurrent WOULD BE, from its
 * qualification, in SHADOW (wave bootcamp2 Q6). A doctor facet and its
 * advisory, in the observation layer: it reads the qualification ledger
 * (state) and the bars (config), never the qualification code itself. Nothing here writes the manifest. Doctor reports the
 * verdict beside the live value for at least 7 days; the commit that lets a
 * qualification write maxConcurrent states how often the two agreed, and why
 * they differed every time they did (AGENTS.md "A new gate starts quiet").
 *
 * THE PROPOSAL is the concurrency ramp's ceiling (qualify-concurrency.mjs),
 * then LOWERED, never raised, by what the node did in production:
 *   - at its live limit, over the last PRODUCTION_DAYS, the 90th percentile of
 *     CPU pressure (avg300, the perf recorder's own reading) at or above the
 *     operator's 20 % line, on at least PRODUCTION_MIN_TICKS ticks, proposes
 *     one below the live limit. Seven days, not one: on 2026-11-11 a one-day
 *     window called claw-9 clean at 3 jobs where the week read a 25.5 % median.
 * Only a new qualification can raise it: there is no production evidence
 * above a limit the node was never allowed past.
 *
 * The backstop is never qualified ("hokon remains the backstop", operator
 * 2026-11-11), so it has no proposal.
 */
import { ADVISORY } from './preflight.mjs';
import { f } from './doctor-findings-record.mjs';
import { QUALIFY_BARS, QUALIFY_TTL_DAYS } from './qualify-bars.mjs';
import { resultKey } from './qualify-results.mjs';

export const RAMP_TEST_ID = 'concurrency-ramp';
/** The production window that may lower a proposal. */
export const PRODUCTION_DAYS = 7;
/** At-limit perf ticks (5 min each) needed before production may lower: three hours. */
export const PRODUCTION_MIN_TICKS = 36;

const q90 = (xs) => {
	const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
	return a.length ? a[Math.min(a.length - 1, Math.floor(0.9 * (a.length - 1) + 0.5))] : null;
};

/**
 * PURE. The shadow verdict for one node.
 *
 * @param {object} a
 * @param {object} a.machine the node's manifest entry
 * @param {object|null} a.entry the node's `node::concurrency-ramp` ledger entry
 * @param {object[]} a.perfRows the node's perf rows over PRODUCTION_DAYS
 * @param {number} a.nowMs
 * @returns {{ state: string, live: number|null, ceiling: number|null, proposal: number|null,
 *   at: string|null, why: string, production: object }}
 */
export function qualifiedCapacity({ machine, entry, perfRows, nowMs }) {
	const live = Number.isInteger(machine?.maxConcurrent) ? machine.maxConcurrent : null;
	const atLimit =
		live === null
			? []
			: perfRows.filter((r) => r.workers === live && Number.isFinite(r.psi300?.cpuSome));
	const production = {
		atLimitTicks: atLimit.length,
		p90AtLimit: q90(atLimit.map((r) => r.psi300.cpuSome)),
	};
	const base = { live, ceiling: null, proposal: null, at: null, production };
	if (machine?.role === 'backstop')
		return { ...base, state: 'backstop', why: 'the backstop is never qualified' };

	const pass = entry?.lastPass ?? null;
	const last = entry?.last ?? null;
	if (!last) return { ...base, state: 'unqualified', why: 'never qualified' };
	const ageDays = (nowMs - Date.parse(pass?.at ?? last.at)) / 86_400_000;

	if (last.status === 'fail' && Number(last.metrics?.ceiling) === 0)
		return {
			...base,
			state: 'failed',
			at: last.at,
			why: `the last ramp failed at k=1: ${last.reason}`,
		};
	if (!pass)
		return {
			...base,
			state: 'could-not-look',
			at: last.at,
			why: `no ramp has finished: ${last.reason}`,
		};
	if (ageDays > QUALIFY_TTL_DAYS)
		return {
			...base,
			state: 'expired',
			at: pass.at,
			why: `qualified ${Math.floor(ageDays)} days ago, past the ${QUALIFY_TTL_DAYS}-day window`,
		};

	const ceiling = Number(pass.metrics?.ceiling);
	if (!(ceiling >= 1))
		return {
			...base,
			state: 'could-not-look',
			at: pass.at,
			why: 'the passing ramp recorded no ceiling',
		};

	let proposal = ceiling;
	let lowered = null;
	if (
		live !== null &&
		production.atLimitTicks >= PRODUCTION_MIN_TICKS &&
		production.p90AtLimit !== null &&
		production.p90AtLimit >= QUALIFY_BARS.cpuPressureP90Pct &&
		live - 1 < proposal
	) {
		proposal = Math.max(1, live - 1);
		lowered =
			`production lowered it: at ${live} jobs the CPU pressure p90 was ${production.p90AtLimit} % ` +
			`over ${production.atLimitTicks} ticks in ${PRODUCTION_DAYS} d (line ${QUALIFY_BARS.cpuPressureP90Pct} %)`;
	}
	const state =
		live === null
			? 'no-live-limit'
			: proposal === live
				? 'agrees'
				: proposal < live
					? 'would-lower'
					: 'would-raise';
	const why =
		`qualified ${pass.at.slice(0, 10)} with a ceiling of ${ceiling} (${pass.reason})` +
		(lowered ? `; ${lowered}` : '') +
		(live === null ? '; the manifest declares no maxConcurrent' : `; live maxConcurrent ${live}`);
	return { ...base, state, ceiling, proposal, at: pass.at, why };
}

/** The ledger entry for `node`'s ramp, or null. */
export const rampEntry = (results, node) => results?.[resultKey(node, RAMP_TEST_ID)] ?? null;

/**
 * ADVISORY only, in shadow. A finding when the qualification DISAGREES with the
 * live limit, the node failed its ramp, or it could not be judged; nothing when
 * they agree, and nothing
 * for a node not qualified yet (the rolling schedule reaches it; a fleet of
 * "never qualified" advisories would bury the ones that say something).
 *
 * @param {{node: string|null, qualifiedCapacity?: ReturnType<typeof qualifiedCapacity>}} health
 */
export function qualifyFindings(health) {
	const c = health.qualifiedCapacity;
	if (!c) return [];
	const extra = { live: c.live, ceiling: c.ceiling, proposal: c.proposal, qualifiedAt: c.at };
	if (c.state === 'would-lower' || c.state === 'would-raise')
		return [
			f(
				health,
				'qualified-capacity',
				ADVISORY,
				c.state,
				`SHADOW: qualification proposes maxConcurrent ${c.proposal} against the live ${c.live}: ${c.why}. ` +
					'Nothing is written while qualification is in shadow.',
				extra
			),
		];
	if (c.state === 'failed')
		return [f(health, 'qualified-capacity', ADVISORY, 'failed', `SHADOW: ${c.why}.`, extra)];
	// Could not look is SAID: an unreadable ledger or perf week, or a ramp that
	// never finished, is not "agrees".
	if (c.state === 'could-not-look')
		return [
			f(
				health,
				'qualified-capacity',
				ADVISORY,
				'unjudged',
				`SHADOW: could not judge: ${c.why}.`,
				extra
			),
		];
	return [];
}
