/**
 * Stopping the controller's loops, for a process about to exit.
 *
 * mgmt-api runs as a leader/standby pair (hadoku_site HA phase 1, 2026-11-05):
 * every redeploy stops the leader and the standby takes over within seconds.
 * A leader that exits in the middle of a pass loses whatever that pass had
 * done but not yet recorded, and the new leader repeats it. On the first
 * handover, "CI broken — hadoku-cardtable / forge" paged twice, 21 s apart.
 *
 * So every scheduler in this package (`scheduleRepeating`, `every`, the
 * runner-health tick) registers its timers here, and every pass it starts is
 * tracked. {@link stopLoops} clears every timer, refuses every pass due from
 * then on, and resolves once the passes already running have finished, or
 * the bound runs out. `FleetManager.stop()` is its public face.
 *
 * Once stopping, it stays stopping: the process is on its way out, and a pass
 * that starts after the drain began is exactly what the drain is there to
 * prevent.
 */

let stopping = false;
const timers = new Set<{ stop(): void }>();
const passes = new Set<Promise<unknown>>();

/** Has {@link stopLoops} been called? A scheduler starts no new pass once it has. */
export const isStopping = (): boolean => stopping;

/** A loop's timer handle, cleared by {@link stopLoops}. Returns the handle. */
export function registerLoopTimer<H extends { stop(): void }>(handle: H): H {
	if (stopping) handle.stop();
	else timers.add(handle);
	return handle;
}

/** A pass in flight: {@link stopLoops} waits for it. Returns the same promise. */
export function trackPass<T>(pass: Promise<T>): Promise<T> {
	passes.add(pass);
	const done = (): void => {
		passes.delete(pass);
	};
	pass.then(done, done);
	return pass;
}

export interface StopResult {
	/** Every pass that was running when the stop began has finished. */
	drained: boolean;
	/** Passes still running when the bound ran out (0 when drained). */
	pending: number;
	waitedMs: number;
}

/** How long {@link stopLoops} waits for running passes by default. */
export const STOP_DRAIN_MS = 20_000;

/**
 * Stop every loop: no timer fires again and no new pass starts. Resolves once
 * the passes already running have settled, or after `boundMs`, whichever is
 * first. Never rejects: a pass that fails has still finished.
 */
export async function stopLoops(boundMs: number = STOP_DRAIN_MS): Promise<StopResult> {
	const started = Date.now();
	stopping = true;
	for (const t of timers) t.stop();
	timers.clear();
	if (!passes.size) return { drained: true, pending: 0, waitedMs: 0 };
	let bound: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<'bound'>((res) => {
		bound = setTimeout(() => res('bound'), boundMs);
		bound.unref?.();
	});
	const settled = Promise.allSettled([...passes]).then(() => 'settled' as const);
	const how = await Promise.race([settled, timedOut]);
	clearTimeout(bound);
	return {
		drained: how === 'settled',
		pending: how === 'settled' ? 0 : passes.size,
		waitedMs: Date.now() - started,
	};
}

/** Test seam. Not part of the supported API. */
export function __resetLoopLifecycleForTesting(): void {
	stopping = false;
	timers.clear();
	passes.clear();
}
