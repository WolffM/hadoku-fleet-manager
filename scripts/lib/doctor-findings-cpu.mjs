/**
 * doctor-findings-cpu — is a node's `maxConcurrent` more CI than its CPU can
 * run? Judged from what the node DID, never from what it was rated at.
 *
 * WHY THIS EXISTS. claw-10 (i7-2700K, 4 physical cores) was enrolled at
 * maxConcurrent 3 from memory alone, and bootcamp's speed proof times ONE job
 * on an IDLE node, so neither could see that three jobs at once stalled it:
 * 38-42 % CPU pressure (avg300) against 0-20 % on every other claw, found by
 * hand on 2026-11-04 and lowered to 2. Nothing in the fleet would have said so.
 *
 * THE MEASUREMENT is the `fleet:perf-samples` recorder (`src/perf-probe.ts`):
 * every 5 minutes each node reports `/proc/pressure/cpu` avg300 — the whole
 * interval since the previous tick — and how many CI jobs were running at the
 * tick. A tick is AT ITS LIMIT when the jobs running reach `maxConcurrent`.
 * The judgement is the median CPU pressure over a day's at-limit ticks: a
 * node that stalls ≥ {@link CPU_OVERSUB_PCT} % of the time whenever it is
 * full is rated for more than it can run. A median, so one heavy build does
 * not raise it, and a floor of {@link CPU_OVERSUB_MIN_TICKS} at-limit ticks,
 * so an hour of evidence is the least it will judge on.
 *
 * ADVISORY, never blocking: the node is working, just slower than its rating
 * promises, and `maxConcurrent` is a safety decision a human makes
 * (AGENTS.md). The finding names the lower ceiling the same day's data
 * supports, when it has enough ticks at that count to say so.
 *
 * COULD NOT LOOK is said, not skipped: an unreadable perf store, or a day
 * with no rows for the node, is its own advisory with the reason.
 */

import { ADVISORY } from './preflight.mjs';
import { f } from './doctor-findings-record.mjs';

/** Median CPU stall (avg300 %) at the limit at or above which the node is oversubscribed. */
export const CPU_OVERSUB_PCT = 20;
/** At-limit ticks (5 min each) needed before judging: one hour of evidence. */
export const CPU_OVERSUB_MIN_TICKS = 12;
/** The window judged. */
export const CPU_WINDOW_HOURS = 24;

const median = (xs) => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 100) / 100;
};

/**
 * The CPU-load facet for one node: pure, from its perf rows and its ceiling.
 * Joined onto `$health` at run time and never stored (`healthRecord`).
 *
 * @param {object[]} rows the node's perf rows in the window, any order
 * @param {number|null|undefined} maxConcurrent the node's declared ceiling
 * @param {{unreadable?: string|null}} [opts] the store's read failure, if any
 */
export function cpuLoadFacet(rows, maxConcurrent, { unreadable = null } = {}) {
	if (unreadable) return { judged: false, why: unreadable };
	if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
		return { judged: false, why: 'no maxConcurrent is declared for this node' };
	const usable = rows.filter(
		(r) => r.ok && Number.isFinite(r.psi300?.cpuSome) && Number.isInteger(r.workers)
	);
	if (!usable.length)
		return {
			judged: false,
			why:
				rows.length === 0
					? `no perf samples for this node in the last ${CPU_WINDOW_HOURS} h; is fleet:perf-samples running?`
					: `${rows.length} perf sample(s) in the last ${CPU_WINDOW_HOURS} h, none carrying avg300 CPU pressure and a job count`,
		};
	/** @type {Record<number, number[]>} */
	const byWorkers = {};
	for (const r of usable)
		(byWorkers[Math.min(r.workers, maxConcurrent)] ??= []).push(r.psi300.cpuSome);
	const atLimit = byWorkers[maxConcurrent] ?? [];
	const p50AtLimit = median(atLimit);
	const oversubscribed =
		atLimit.length >= CPU_OVERSUB_MIN_TICKS && p50AtLimit !== null && p50AtLimit >= CPU_OVERSUB_PCT;
	// The highest lower count the same window shows running clean, with as much
	// evidence as the limit itself needs.
	let supports = null;
	for (let k = maxConcurrent - 1; k >= 1 && oversubscribed; k--) {
		const at = byWorkers[k] ?? [];
		if (at.length >= CPU_OVERSUB_MIN_TICKS && median(at) < CPU_OVERSUB_PCT) {
			supports = k;
			break;
		}
	}
	return {
		judged: true,
		maxConcurrent,
		ticks: usable.length,
		atLimitTicks: atLimit.length,
		p50AtLimit,
		oversubscribed,
		supports,
		byWorkers: Object.fromEntries(
			Object.entries(byWorkers).map(([k, v]) => [k, { ticks: v.length, p50: median(v) }])
		),
	};
}

/** @param {{node: string|null, cpuLoad?: ReturnType<typeof cpuLoadFacet>}} health */
export function cpuFindings(health) {
	const c = health.cpuLoad;
	if (!c) return [];
	if (!c.judged)
		return [
			f(
				health,
				'cpu-load',
				ADVISORY,
				'unjudged',
				`could not judge whether maxConcurrent fits this node's CPU: ${c.why}.`
			),
		];
	if (!c.oversubscribed) return [];
	return [
		f(
			health,
			'cpu-load',
			ADVISORY,
			'cpu-oversubscribed',
			`at its limit of ${c.maxConcurrent} CI jobs, this node's CPU was stalled a median ` +
				`${c.p50AtLimit} % of the time (avg300) over ${c.atLimitTicks} five-minute ticks in the last ` +
				`${CPU_WINDOW_HOURS} h, at or above the ${CPU_OVERSUB_PCT} % line: it is rated for more CI ` +
				'than it can run, and every job on it runs slower for it. ' +
				(c.supports
					? `At ${c.supports} job(s) the same day read a median ${c.byWorkers[c.supports].p50} %; ` +
						`lowering maxConcurrent to ${c.supports} in the live manifest is what the data supports.`
					: 'No lower job count has an hour of clean evidence yet; see `fleet perf` before lowering it.'),
			{ maxConcurrent: c.maxConcurrent, p50AtLimit: c.p50AtLimit, supports: c.supports }
		),
	];
}
