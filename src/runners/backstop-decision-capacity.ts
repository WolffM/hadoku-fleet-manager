/**
 * THE CAPACITY INVARIANT, PAGED (2026-10-21) — pages once the dispatcher's
 * capacity ledger (`capacity-ledger.ts`) has shown a node charged more than
 * it is running for CAPACITY_TICKS_BEFORE_ALERT consecutive ticks. One
 * broken pass is a race between the unit listing and the probe; a quarter
 * of an hour of it is the 2026-10-07 bug, which ran fourteen days unseen
 * because every number on every panel was a different number from the one
 * that was wrong. A ledger older than two ticks is a dispatcher that is not
 * running, which is a different page (`dispatch.failingSince`), not this
 * one. Split out of `backstop-decision.ts` (wave shrink-1 lane B, 800-line
 * ceiling) — self-contained, since it reads only the ledger and its own
 * cross-tick memory; `backstop-decision.ts` re-exports both names here
 * under their original path.
 */
import { getCapacityLedger } from './capacity-ledger.js';
import { alertOnce, clearAlert } from '../lib/alert-ledger.js';
import { TICK_INTERVAL_MS } from '../lib/runner-health-shared.js';

/**
 * Consecutive ticks the dispatcher's capacity ledger (`capacity-ledger.ts`)
 * must show a node charged more than it is running before it pages. Three,
 * not two: a unit listed between a job's end and its unit's exit, or a probe
 * one fast-loop tick behind a warm assignment, can break the invariant for one
 * pass honestly; three ticks is a quarter of an hour, and no race lasts that.
 */
export const CAPACITY_TICKS_BEFORE_ALERT = 3;
/** NODE name → consecutive ticks its ledger entry has been broken. */
const capacityBrokenTicks = new Map<string, number>();

/** Checks the last capacity ledger snapshot and pages if it has stayed broken. */
export async function checkCapacityInvariant(): Promise<void> {
	const capLedger = getCapacityLedger();
	const freshLedger =
		capLedger !== null && Date.now() - Date.parse(capLedger.at) <= 2 * TICK_INTERVAL_MS
			? capLedger
			: null;
	const brokenNow = new Set((freshLedger?.nodes ?? []).filter((e) => !e.ok).map((e) => e.node));
	for (const node of [...capacityBrokenTicks.keys()]) {
		if (!brokenNow.has(node)) capacityBrokenTicks.delete(node);
	}
	const sustainedBroken: string[] = [];
	for (const node of brokenNow) {
		const seen = (capacityBrokenTicks.get(node) ?? 0) + 1;
		capacityBrokenTicks.set(node, seen);
		if (seen >= CAPACITY_TICKS_BEFORE_ALERT) sustainedBroken.push(node);
	}
	if (!sustainedBroken.length) {
		clearAlert('capacity-invariant');
	} else {
		const detail = (freshLedger?.nodes ?? [])
			.filter((e) => sustainedBroken.includes(e.node))
			.map((e) => `${e.node}: ${e.why}`)
			.join('; ');
		const mins = Math.round((CAPACITY_TICKS_BEFORE_ALERT * TICK_INTERVAL_MS) / 60000);
		await alertOnce(
			'capacity-invariant',
			`🚨 **dispatcher accounting** has been wrong on ${sustainedBroken.join(', ')} for ` +
				`${mins}+ min — a node is charged more in-flight jobs than it is running or ` +
				`starting, so it refuses mints it has room for (this is the 2026-10-07 double ` +
				`count's shape). ${detail}. Read \`[dispatch] skipped run\` lines and ` +
				'`GET /fleet` machines[].dispatchLedger.'
		);
	}
}

/** Test seam: cross-tick memory this module owns. */
export function __resetCapacityInvariantForTesting(): void {
	capacityBrokenTicks.clear();
}
