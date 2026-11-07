/**
 * cache-sweep-log — when each node's tool caches were last FULLY swept.
 *
 * WHY (fleet-manager#65). clean-runner-debris bounds the caches a node still
 * uses (trunk by age, the Android SDK by read time), and it never touches them
 * while a job runs: it prints SKIP-CACHES and moves on. That is the right call
 * for one night and the wrong one for every night. On 2026-11-06 five of seven
 * claws were mid-job at the moment of a sweep, and in the 45 minutes after
 * none had a gap long enough to catch. A node that is busy every night at
 * 13:15 would never be swept, and the report would say "skipped" each time
 * without anyone adding the nights up.
 *
 * So the skip is COUNTED here, and two things read the count:
 *   - the refresh cycle gives a node unswept for SWEEP_DUE_DAYS a drained
 *     turn: drain, wait for quiet, sweep, undrain (refresh-cycle.mjs);
 *   - ci:claw-cleanup reports a node unswept for SWEEP_OVERDUE_DAYS as a
 *     finding, because by then the cycle has failed to do it too.
 *
 * ONE WRITER: clean-runner-debris.mjs, through {@link recordSweeps}, because
 * it is the only thing that sees whether the caches were really swept. The
 * cycle's drained turn runs that same CLI and lets it record.
 *
 * A node never seen before is not overdue on day one: its clock starts at
 * `seenAt`, the first run that observed it. An unreadable log reads as empty,
 * which restarts every clock: the node becomes due a week later rather than
 * never, and the overdue finding fires a fortnight later rather than at once.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../../dist/lib/atomic-json.js';
import { stateDir } from '../../dist/lib/fleet-paths.js';

/** The refresh cycle drains a node for a sweep once it is this long unswept. */
export const SWEEP_DUE_DAYS = 7;
/** ci:claw-cleanup reports a node unswept this long: the cycle failed too. */
export const SWEEP_OVERDUE_DAYS = 14;
const DAY_MS = 86_400_000;

const logPath = () => join(stateDir(), 'cache-sweep-log.json');

/** `{ [node]: { sweptAt?: ms, seenAt: ms } }`; empty when absent or unreadable. */
export function readSweepLog() {
	try {
		const doc = JSON.parse(readFileSync(logPath(), 'utf8'));
		return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
	} catch {
		return {};
	}
}

/**
 * Fold one clean-runner-debris run into the log. Pure.
 * A node counts as swept only on an APPLY run that reached it and was not held
 * back by a running job; every node the run reached starts its clock.
 */
export function foldSweeps(log, results, { confirm, nowMs }) {
	const next = { ...log };
	for (const r of results) {
		if (!r.ok || r.expectedDown) continue;
		const rec = { seenAt: nowMs, ...next[r.machine] };
		if (confirm && r.cachesSwept === true) rec.sweptAt = nowMs;
		next[r.machine] = rec;
	}
	return next;
}

export function recordSweeps(results, { confirm, nowMs = Date.now() }) {
	const next = foldSweeps(readSweepLog(), results, { confirm, nowMs });
	writeFileAtomic(logPath(), `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

/** Epoch ms the node's clock started: its last full sweep, else first sighting; NaN if unknown. */
export function sweepClock(rec) {
	const at = rec?.sweptAt ?? rec?.seenAt;
	return typeof at === 'number' && Number.isFinite(at) ? at : NaN;
}

/** Whole days since the node's clock started; null for a node never seen. */
export function daysUnswept(rec, nowMs) {
	const at = sweepClock(rec);
	return Number.isFinite(at) ? Math.floor((nowMs - at) / DAY_MS) : null;
}

/** Due for a drained sweep. A node never seen is NOT due: its clock has not started. */
export function sweepDue(rec, nowMs, days = SWEEP_DUE_DAYS) {
	const d = daysUnswept(rec, nowMs);
	return d !== null && d >= days;
}

/** One finding per node in `nodes` unswept for SWEEP_OVERDUE_DAYS. Pure. */
export function overdueFindings(log, nodes, nowMs) {
	return nodes
		.filter((n) => sweepDue(log[n], nowMs, SWEEP_OVERDUE_DAYS))
		.map((n) => ({
			machine: n,
			kind: 'caches-unswept',
			reason:
				`${n}'s tool caches have not been swept in ${daysUnswept(log[n], nowMs)} days: ` +
				`a job was running at every nightly pass, and the refresh cycle's drained ` +
				`turn has not landed either (fleet converge-toolchain --refresh --plan says why)`,
		}));
}
