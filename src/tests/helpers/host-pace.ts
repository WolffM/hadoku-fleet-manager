/**
 * Scale a fixed test time budget to the box running it (fleet-manager#68).
 *
 * Two measured inputs, both read at call time and both only ever WIDEN:
 * - `HOST_PACE`, the node's measured speed factor, written into every fleet
 *   runner's `.env` at mint (`hostPaceOf`, src/runners/speed-tier.ts). Unset
 *   off the fleet, which reads as 1.
 * - the 1-minute load average per CPU, so a box that is busy right now (the
 *   suite runs its files in parallel, beside other jobs) gets room too.
 *
 * A fast or idle box never tightens a budget below what the test asked for,
 * and the product is capped so a genuinely hung path still fails.
 */
import { cpus, loadavg } from 'node:os';

export const MAX_SCALE = 8;

export function budgetScale(env: NodeJS.ProcessEnv = process.env): number {
	const pace = Number(env.HOST_PACE);
	const paceScale = Number.isFinite(pace) && pace > 1 ? pace : 1;
	const perCpu = loadavg()[0] / Math.max(1, cpus().length);
	const loadScale = Number.isFinite(perCpu) && perCpu > 1 ? perCpu : 1;
	return Math.min(MAX_SCALE, paceScale * loadScale);
}

export const scaledMs = (ms: number): number => Math.ceil(ms * budgetScale());
