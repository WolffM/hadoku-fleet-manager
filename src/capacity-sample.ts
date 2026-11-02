/**
 * T4 — capacity samples (refactor plan §7.3): "admission/capacity state at
 * time T" is not answerable today. Every 5 minutes this writes one row per
 * node naming what the fleet's own control loops already believe about it —
 * the declared ceiling, the budget that actually admits work, whether it is
 * drained, and the admission refusal reason when one is on record.
 *
 * NO NEW READ OF ANY KIND. `buildFleetReport()` (`routes/fleet.ts`) is the
 * same join `GET /fleet` performs on every request, over snapshots other
 * loops already hold: the fast loop's probe, runner-health's snapshot, the
 * dispatcher's own admission-verdict and capacity-ledger module state. Called
 * with no arguments it reads those same live module-level snapshots and
 * nothing else — no ssh, no GitHub call this sampler itself triggers. The one
 * thing it adds beyond that join is `isDraining()`, a read of the operator's
 * own `fleet-drain.json` (`runners/drain.ts`) — again a local state-dir read,
 * never a network call.
 *
 * This file is also where the 5-minute clock lives: `startCapacitySampling`
 * wires `scheduleRepeating` (`lib/job-runner.ts`, unedited by this module —
 * only imported) the same way `claw-reboot.ts` does for its own hourly cycle,
 * since this job neither spawns a script nor classifies a doc and so has no
 * use for `scheduled-converger.ts`'s heavier spawn+classify+pager machinery.
 */
import { join } from 'node:path';

import { logger, stateDir } from './host.js';
import { buildFleetReport } from './routes/fleet-report.js';
import { isDraining, readDrain, type DrainState } from './runners/drain.js';
import {
	capacitySampleStore,
	CAPACITY_SAMPLE_FILE,
	type CapacitySampleRow,
} from './capacity-sample-store.js';
import { computeFirstDelayMs, createOverlapGuard, scheduleRepeating } from './lib/job-runner.js';

/** Between passes. Matches the job-registry row's `clockMs`. */
export const CAPACITY_SAMPLE_MS = 5 * 60_000;
/** Not in the boot window, when the fast loop is still taking its first probe. */
const FIRST_PASS_MIN_MS = 5 * 60_000;

const JOB_NAME = 'fleet:capacity-samples';

function samplePath(): string {
	return join(stateDir(), CAPACITY_SAMPLE_FILE);
}

/**
 * One row per node, for the current in-memory fleet state.
 *
 * `report`/`drain` default to the REAL reads (`buildFleetReport()`,
 * `readDrain(nowMs)`) — the zero-argument call in production is what proves
 * this adds no new ssh/GitHub call, since `buildFleetReport` is the exact
 * join `GET /fleet` already performs over live module state. Both are
 * injectable so a test can hand this a fabricated report without driving the
 * fast loop, runner-health and the dispatcher to populate one — the same
 * default-parameter test seam `buildFleetReport` itself uses.
 */
export function sampleCapacityNow(
	nowMs: number = Date.now(),
	report: ReturnType<typeof buildFleetReport> = buildFleetReport(),
	drain: DrainState = readDrain(nowMs)
): CapacitySampleRow[] {
	const at = new Date(nowMs).toISOString();
	return report.machines.map((m) => ({
		at,
		node: m.name,
		maxConcurrent: m.maxConcurrent,
		admissionCapacity: m.admissionCapacity,
		admissionFree: m.admissionFree,
		admissionBasis: m.admissionBasis,
		state: m.state,
		drained: isDraining(m.name, drain),
		refusalReason: m.admissionRefusal ? m.admissionRefusal.reason : null,
		unmeasured: m.admissionCaveat === 'unreachable',
	}));
}

/**
 * One tick: sample, then append. NEVER THROWS — a sampling fault or a write
 * fault is logged and swallowed here, the same contract every other
 * in-process loop in this package keeps (`decision-log.ts`'s own `warn`):
 * this job's only job is to have an opinion about admission state, and a
 * fault in forming that opinion must never cost the dispatcher, the fast
 * loop or any other tick sharing this process.
 */
export function capacitySampleTick(
	nowMs: number = Date.now(),
	report?: ReturnType<typeof buildFleetReport>,
	drain?: DrainState
): void {
	let rows: CapacitySampleRow[];
	try {
		rows =
			report === undefined
				? sampleCapacityNow(nowMs)
				: sampleCapacityNow(nowMs, report, drain ?? readDrain(nowMs));
	} catch (err) {
		logger.warn(
			`[capacity-sample] could not sample this tick: ${err instanceof Error ? err.message : String(err)}`
		);
		return;
	}
	if (!rows.length) return;
	try {
		capacitySampleStore(samplePath()).append(rows, nowMs);
	} catch (err) {
		logger.warn(
			`[capacity-sample] could not record ${rows.length} row(s): ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

let started = false;
let guard = createOverlapGuard();
let scheduled: ReturnType<typeof scheduleRepeating> | null = null;

/** Test seam: clear the timer and the `started` guard. */
export function __stopCapacitySamplingForTesting(): void {
	scheduled?.stop();
	scheduled = null;
	started = false;
	guard = createOverlapGuard();
}

/** Start the clock. Controller-only: `createFleetManager().start()` gates it. */
export function startCapacitySampling(): void {
	if (started) return;
	started = true;
	const pass = () => guard.run(() => Promise.resolve(capacitySampleTick()));
	const firstIn = computeFirstDelayMs(
		{ intervalMs: CAPACITY_SAMPLE_MS, firstPassMinMs: FIRST_PASS_MIN_MS },
		null
	);
	scheduled = scheduleRepeating(firstIn, CAPACITY_SAMPLE_MS, pass, JOB_NAME);
}
