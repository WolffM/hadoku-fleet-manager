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
import { LEDGER_FRESH_MS } from './runners/capacity-ledger.js';
import {
	capacitySampleStore,
	CAPACITY_SAMPLE_FILE,
	type CapacitySampleRow,
} from './capacity-sample-store.js';
import {
	computeFirstDelayMs,
	createOverlapGuard,
	finishTick,
	scheduleRepeating,
	type Verdict,
} from './lib/job-runner.js';

/** Between passes. Matches the job-registry row's `clockMs`. */
export const CAPACITY_SAMPLE_MS = 5 * 60_000;
/** Not in the boot window, when the fast loop is still taking its first probe. */
const FIRST_PASS_MIN_MS = 5 * 60_000;

const JOB_NAME = 'fleet:capacity-samples';

function samplePath(): string {
	return join(stateDir(), CAPACITY_SAMPLE_FILE);
}

/**
 * `admissionFree` THE WAY THE DISPATCHER WOULD ANSWER, NOT THE DISPLAY PATH'S
 * OWN GUESS. `routes/fleet-admission.ts`'s `admission()` — what every other
 * reader of `m.admissionFree` still gets — derives it from the raw probe
 * (`mintBudget(m).slots - p.workers`), which is exactly the double-count
 * `capacity-ledger.ts` was built to fix on the DISPATCH path and, per that
 * file's own header, "never [fixed] in the display path": measured
 * 2026-11-08 03:41Z, every jdk21 claw sampled `admissionFree: 1` while the
 * dispatcher's own charge for the same node, the same instant, was `at
 * capacity: 1/1` — `p.workers` read 0 (the warm listener holding the slot
 * was not yet counted as a running worker) while `liveUnits + standingBusy`
 * correctly read 1.
 *
 * `m.dispatchLedger` (`capacity-ledger.ts`'s own per-pass charge) is the
 * authoritative figure: `budget` is already `maxConcurrent` less the
 * warm-held slots, `inFlight` is the corrected `liveUnits + standingBusy`.
 * Used only while fresh (`LEDGER_FRESH_MS`, the same bar
 * `chargedLikeDispatch` holds it to) — a stale ledger describes a pass this
 * process no longer trusts, and the probe-derived figure is the better guess
 * then. `null` when the ledger carries no entry at all, which is every
 * standing node (`admitMint` never runs for one) and every ephemeral node
 * before this process's first dispatch pass: both fall back to the report's
 * own figure unchanged.
 */
function ledgerAdmissionFree(
	m: ReturnType<typeof buildFleetReport>['machines'][number],
	nowMs: number
): number | null {
	const ledger = m.dispatchLedger;
	if (!ledger) return m.admissionFree;
	const at = Date.parse(ledger.at);
	if (!Number.isFinite(at) || nowMs - at > LEDGER_FRESH_MS) return m.admissionFree;
	// A fresh ledger can still predate a maxConcurrent cut: at 2026-11-09
	// 15:31:25Z claw-1 sampled free 2 against capacity 1 — the operator had
	// just cut it 2→1, the report had re-read the manifest, and the last pass
	// had not (budget 2, inFlight 0). Free can never exceed what the node may
	// run NOW, so the ledger's budget is capped by the report's capacity and
	// the result clamped to [0, capacity].
	const cap = m.admissionCapacity;
	const budget = cap === null ? ledger.budget : Math.min(ledger.budget, cap);
	const free = Math.max(0, budget - ledger.inFlight);
	return cap === null ? free : Math.min(free, cap);
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
		admissionFree: ledgerAdmissionFree(m, nowMs),
		admissionBasis: m.admissionBasis,
		state: m.state,
		drained: isDraining(m.name, drain),
		refusalReason: m.admissionRefusal ? m.admissionRefusal.reason : null,
		unmeasured: m.admissionCaveat === 'unreachable',
	}));
}

/**
 * One tick: sample, then append. NEVER THROWS — a sampling fault or a write
 * fault is logged and returned as the tick's verdict here, the same contract every other
 * in-process loop in this package keeps (`decision-log.ts`'s own `warn`):
 * this job's only job is to have an opinion about admission state, and a
 * fault in forming that opinion must never cost the dispatcher, the fast
 * loop or any other tick sharing this process.
 */
export function capacitySampleTick(
	nowMs: number = Date.now(),
	report?: ReturnType<typeof buildFleetReport>,
	drain?: DrainState
): { verdict: Verdict; why?: string; rows: number } {
	let rows: CapacitySampleRow[];
	try {
		rows =
			report === undefined
				? sampleCapacityNow(nowMs)
				: sampleCapacityNow(nowMs, report, drain ?? readDrain(nowMs));
	} catch (err) {
		const why = `could not sample this tick: ${err instanceof Error ? err.message : String(err)}`;
		logger.warn(`[capacity-sample] ${why}`);
		return { verdict: 'unavailable', why, rows: 0 };
	}
	if (!rows.length) return { verdict: 'ok', rows: 0 };
	try {
		capacitySampleStore(samplePath()).append(rows, nowMs);
	} catch (err) {
		const why = `could not record ${rows.length} row(s): ${err instanceof Error ? err.message : String(err)}`;
		logger.warn(`[capacity-sample] ${why}`);
		return { verdict: 'broke', why, rows: 0 };
	}
	return { verdict: 'ok', rows: rows.length };
}

/**
 * One scheduled pass: the tick, then {@link finishTick}. Without it the loop
 * registered with liveness and never noted a tick, so it read `stale` from
 * ~5 minutes after every boot and paged as a critical outage (2026-11-02).
 */
export async function capacitySamplePass(nowMs: number = Date.now()): Promise<void> {
	const r = capacitySampleTick(nowMs);
	await finishTick({
		jobName: JOB_NAME,
		intervalMs: CAPACITY_SAMPLE_MS,
		now: nowMs,
		verdict: r.verdict,
		durationMs: Date.now() - nowMs,
		why: r.why,
		data: { rows: r.rows },
		kind: 'recorder',
	});
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
	const pass = () => guard.run(() => capacitySamplePass());
	const firstIn = computeFirstDelayMs(
		{ intervalMs: CAPACITY_SAMPLE_MS, firstPassMinMs: FIRST_PASS_MIN_MS },
		null
	);
	scheduled = scheduleRepeating(firstIn, CAPACITY_SAMPLE_MS, pass, JOB_NAME);
}
