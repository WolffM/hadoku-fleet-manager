/**
 * THE ONE TIMER PRIMITIVE FOR THE FLEET'S CONTROL LOOPS (refactor plan §6.2
 * tier 1, wave5j-2026-10-31 lane D). Today each of the three in-process
 * control loops — the fast loop (`fleet-loop.ts`, 60s), its dispatch timer
 * (15s) and runner-health's monitor (`runner-health.ts`, 10min) — hand-rolled
 * its own `setInterval`, its own "wait for the GitHub token" retry loop, and
 * its own liveness registration. `every()` is the one copy of that clock.
 *
 * WHAT IT OWNS:
 *   - the `setTimeout`-then-`setInterval` schedule, both unref'd so neither
 *     ever holds the process open (same shape as `job-runner.ts`'s
 *     `scheduleRepeating`, which this does NOT reuse — see below);
 *   - an overlap guard: a tick still running when the next one is due is
 *     skipped, never stacked (`job-runner.ts`'s `createOverlapGuard`, inlined
 *     here rather than imported so this module has no dependency on the job
 *     runner — plan §6.2 draws tier 1 and tier 2 as separate primitives, and
 *     `AGENTS.md`'s job-runner header says `every()` "may reuse pieces but
 *     must not change the job runner"; reusing the TYPE of the guard without
 *     importing the job runner's module keeps that boundary literal);
 *   - optionally, waiting for a token to become available (retrying on its
 *     own clock) before the schedule starts at all — the exact shape every
 *     one of today's three loops already implements by hand for "mgmt-api
 *     boots with its vault sealed, so no token at start() is a normal boot,
 *     not a disabled loop" (`host.ts`'s `TOKEN_RETRY_MS`, #133);
 *   - liveness registration (`registerLoop`, `src/lib/liveness.ts`) at the
 *     moment `every()` is called — before any token wait, so a loop stuck
 *     waiting for a token forever is still visible as `pending`-then-`stale`,
 *     never silently absent;
 *   - OPTIONALLY noting each completed tick (`noteTick`) — see `noteTick`
 *     below for why this wave's three ports all pass `noteTick: false`.
 *
 * WHAT IT DOES NOT OWN: what `tick` does, and whether `tick` itself decides to
 * skip a pass (e.g. "no token this turn" after the bootstrap wait is already
 * satisfied — `fleet-loop.ts`'s dispatch timer never waits for a token at
 * all, it just no-ops when one is briefly missing; that stays inside the
 * wrapped `tick`, not here).
 *
 * TICK IS CALLED SYNCHRONOUSLY. `runOnce` invokes `tick()` directly, not
 * behind a `Promise.resolve().then(...)`, and only chains `.then`/`.catch` on
 * whatever it returns. This is load-bearing: `fleet-loop.test.ts`'s "a token
 * present at boot ticks immediately" pins that the FIRST pass's synchronous
 * side effects (today: pushing onto a test's own array) are visible the
 * instant the loop's `start*()` call returns, with no `await` in between —
 * exactly matching `withGhCaller(caller, fn)`'s own synchronous-call
 * semantics (`AsyncLocalStorage.run` invokes `fn` synchronously and returns
 * its result unwrapped).
 */
import { registerLoop, noteTick as noteLivenessTick, TOKEN_WAIT_GRACE_MS } from './liveness.js';
import { logger } from '../host.js';

export interface TokenWaitOptions {
	/**
	 * Read fresh on every retry — never cached, since the token can arrive
	 * after `every()` was called (a vault that unseals mid-boot). A plain
	 * property type, not a method signature: it is always called as a bare
	 * function, never as `this.getToken()`, and a method signature here
	 * trips `@typescript-eslint/unbound-method` the moment it is destructured
	 * below.
	 */
	getToken: () => string | undefined;
	/** How long to wait between retries while no token is available. */
	retryMs: number;
	/** Called once, the first time the token is found missing. */
	onWaiting?: () => void;
	/** Called once, only if `onWaiting` fired, with how long the wait took. */
	onReady?: (waitedMs: number) => void;
}

export interface EveryOptions {
	/**
	 * Delay before the FIRST tick, ms. `0` ticks immediately (synchronously,
	 * on the turn `every()` is called — or, with `tokenWait`, on the turn the
	 * token is found). Omitted: plain `setInterval` semantics — the first tick
	 * waits a full `intervalMs`, matching `fleet-loop.ts`'s dispatch timer,
	 * which has never ticked immediately on start.
	 */
	firstRunMs?: number;
	/** Block the schedule from starting at all until a token is seen. */
	tokenWait?: TokenWaitOptions;
	/**
	 * Call `registerLoop` immediately. Default `true`. `false` when the
	 * caller already registered the loop itself, at an EARLIER moment than
	 * this `every()` call — `runner-health.ts`'s port is the one case: it
	 * must register before its own hand-rolled token wait (which does more
	 * than block a schedule — it also runs one-shot boot work, like logging
	 * the token's scopes, that does not fit `tokenWait`'s generic shape), and
	 * only calls `every()` once a token is already in hand, to set up the
	 * ONGOING interval. Calling `registerLoop` a second time there would
	 * reset `registeredAtMs` to that LATER moment, which — if the first tick
	 * had already failed without ever reaching `noteTick` — would hand a
	 * loop that has been failing since boot a fresh grace window, exactly
	 * the silent-stale case `lib/liveness.ts` exists to refuse.
	 */
	registerLiveness?: boolean;
	/**
	 * Call `noteTick` after each tick that resolves without throwing.
	 * Default `true` — the primitive's own liveness-noting, for a tick whose
	 * body does not already do this itself.
	 *
	 * All THREE of this wave's ports pass `false`: `tickFleet`,
	 * `runDispatchTick` and `runner-health.ts`'s `runTick` already call
	 * `noteTick` themselves, at the end of their own success path — deep
	 * inside each tick's own business logic, which this lane does not own
	 * (see AGENTS.md's reader/writer-must-differ spirit: the thing that
	 * decided the tick succeeded is the thing that should say so). Having
	 * `every()` ALSO note the tick would double the call without changing
	 * the answer (`noteTick` just overwrites a map entry), but it would
	 * change the call COUNT a test can observe — so it is off wherever the
	 * wrapped tick already owns that call, and stays on for a future loop
	 * whose tick does not.
	 */
	noteTick?: boolean;
	/**
	 * A promise for work ALREADY in flight when `every()` is called, so the
	 * overlap guard treats it as occupying the very first slot: the regular
	 * schedule's first `tick()` call waits for this to settle, exactly as it
	 * would wait for one of its own ticks.
	 *
	 * `runner-health.ts`'s port is why this exists: its first tick runs
	 * BEFORE `every()` is ever called — it does one-shot boot work (logging
	 * the token's scopes, a `ciAlertsBootPassDue`-conditioned alert pass)
	 * that does not fit `tick`'s generic per-call shape, so it stays a
	 * manual call, not `firstRunMs: 0`. Without this, that manual call is
	 * invisible to the guard: the first REGULAR interval would start a
	 * second `runTick` while the manual one was still running — genuinely
	 * overlapping, the exact failure mode `every()` otherwise prevents. (The
	 * ORIGINAL bare `setInterval` had this same gap for its entire
	 * lifetime — this closes it rather than merely not widening it.)
	 */
	seedInFlight?: Promise<unknown>;
}

export interface EveryHandle {
	/** Cancel every pending timer. A tick already in flight still runs to
	 *  completion; nothing new is scheduled after this. */
	stop(): void;
}

/**
 * Run `tick` on its own clock: `registerLoop` immediately, optionally wait
 * for a token, then an un-overlapping `setTimeout`-then-`setInterval`
 * schedule, each tick optionally `noteTick`-ed on success.
 */
export function every(
	name: string,
	intervalMs: number,
	tick: () => void | Promise<void>,
	opts: EveryOptions = {}
): EveryHandle {
	// Registered BEFORE any token wait — see lib/liveness.ts: a loop that
	// hangs right here, never reaching its first tick, must still be visible
	// as pending-then-stale, not simply absent. (Unless the caller already
	// did this at an earlier moment — see `EveryOptions.registerLiveness`.)
	if (opts.registerLiveness !== false) {
		registerLoop(name, intervalMs, { firstTickGraceMs: TOKEN_WAIT_GRACE_MS });
	}

	let stopped = false;
	let inFlight = false;
	let intervalHandle: ReturnType<typeof setInterval> | null = null;
	let firstHandle: ReturnType<typeof setTimeout> | null = null;
	let tokenWaitHandle: ReturnType<typeof setTimeout> | null = null;

	if (opts.seedInFlight) {
		inFlight = true;
		// Both arms reset the SAME flag: this primitive never reads the
		// seed's resolved value or its rejection, only that it has settled.
		// `.then(onFulfilled, onRejected)` — not `.finally` — because a
		// rejected seed's derived promise would otherwise be unhandled: the
		// caller already owns the seed's own error handling (it is already
		// in flight before `every()` ever sees it), so this must not surface
		// a second, unhandled rejection for the same failure.
		opts.seedInFlight.then(
			() => {
				inFlight = false;
			},
			() => {
				inFlight = false;
			}
		);
	}

	const runOnce = (): void => {
		// No overlap: a tick still running when the next is due is skipped,
		// never stacked on top of it.
		if (stopped || inFlight) return;
		inFlight = true;
		let result: void | Promise<void>;
		try {
			// Called SYNCHRONOUSLY — see the module header.
			result = tick();
		} catch (err) {
			inFlight = false;
			logger.warn(
				`[every:${name}] tick threw: ${err instanceof Error ? err.message : String(err)}`
			);
			return;
		}
		if (!(result instanceof Promise)) {
			// A synchronous tick completes entirely synchronously — no artificial
			// microtask hop, so it behaves exactly like a plain `setInterval`
			// callback. (All three of this wave's production ports are async, so
			// this branch exists for a simple or future caller, not for them.)
			if (opts.noteTick !== false) noteLivenessTick(name, intervalMs);
			inFlight = false;
			return;
		}
		result
			// Recorded only on the success path, and only when this primitive
			// owns the note — see `EveryOptions.noteTick` above.
			.then(() => {
				if (opts.noteTick !== false) noteLivenessTick(name, intervalMs);
			})
			.catch((err: unknown) => {
				logger.warn(
					`[every:${name}] tick threw: ${err instanceof Error ? err.message : String(err)}`
				);
			})
			.finally(() => {
				inFlight = false;
			});
	};

	const startSchedule = (): void => {
		if (stopped) return;
		const firstRunMs = opts.firstRunMs;
		const armInterval = (): void => {
			intervalHandle = setInterval(runOnce, intervalMs);
			intervalHandle.unref?.();
		};
		if (firstRunMs === undefined) {
			// Plain setInterval semantics: no immediate tick.
			armInterval();
		} else if (firstRunMs <= 0) {
			runOnce();
			armInterval();
		} else {
			firstHandle = setTimeout(() => {
				firstHandle = null;
				runOnce();
				armInterval();
			}, firstRunMs);
			firstHandle.unref?.();
		}
	};

	if (opts.tokenWait) {
		const { getToken, retryMs, onWaiting, onReady } = opts.tokenWait;
		const startedAtMs = Date.now();
		let waited = false;
		const wait = (): void => {
			tokenWaitHandle = null;
			if (stopped) return;
			if (getToken()) {
				if (waited) onReady?.(Date.now() - startedAtMs);
				startSchedule();
				return;
			}
			if (!waited) onWaiting?.();
			waited = true;
			tokenWaitHandle = setTimeout(wait, retryMs);
			tokenWaitHandle.unref?.();
		};
		wait();
	} else {
		startSchedule();
	}

	return {
		stop(): void {
			stopped = true;
			if (firstHandle) clearTimeout(firstHandle);
			if (tokenWaitHandle) clearTimeout(tokenWaitHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			firstHandle = null;
			tokenWaitHandle = null;
			intervalHandle = null;
		},
	};
}

/**
 * ONE "LAST-RUN GATE" PRIMITIVE for a check that must run less often than its
 * own loop (plan §6.2: "`subCadence(name, ms)` for the six or more last-run
 * gates"). A tick asks "has `name` run within `ms`?"; a `true` answer also
 * MARKS it as having run now, so the next ask inside `ms` answers `false`.
 *
 * MIGRATED ONTO THIS (wave5m lane C, 2026-10-31), all in-memory, global,
 * mark-when-due regardless of outcome — exactly this primitive's shape:
 * `dispatch-tick.ts`'s `recoveryDue`/`pendingDue` and `dispatch-pass.ts`'s
 * `lastReapMs` (each already stamped BEFORE its awaits, for the same reason —
 * "a slow pass must not let the next one in behind it"), and
 * `speed-heavy-cache.ts`'s two model-rebuild gates (the due/mark half only —
 * the built MODEL stays a local cache `subCadence` has no slot for).
 *
 * NOT MIGRATED, with the reason named at each call site:
 *   - `backstop-decision.ts`'s `convergeDue` marks only AFTER the fan-out
 *     succeeds ("a partial fan-out is retried next tick instead of being
 *     recorded as done") — the opposite of this function's unconditional
 *     mark-on-due. It uses `subCadenceDue`/`markSubCadence` below instead,
 *     the same cadence with the mark pulled out to the caller's success
 *     branch.
 *   - `ci-alerts.ts`'s `ciAlertsBootPassDue` is read from a file (asked by
 *     the NEXT process after a restart) and marked only on a clean pass by a
 *     separate writer (`recordCleanPass`) — persisted, not in-memory, so it
 *     cannot sit on this module-global map at all.
 */
const lastRunAtMs = new Map<string, number>();

/**
 * Has `name` run within `ms`? Never marks — see `markSubCadence`, its pair.
 * `subCadence` below is `subCadenceDue` immediately followed by
 * `markSubCadence` on a `true` answer; this split exists for a gate whose
 * mark must wait on the outcome of the work the check gated (see
 * `backstop-decision.ts`'s `convergeDue`).
 */
export function subCadenceDue(name: string, ms: number, now: number = Date.now()): boolean {
	const last = lastRunAtMs.get(name);
	return last === undefined || now - last >= ms;
}

/** Mark `name` as having run at `now`. See `subCadenceDue`. */
export function markSubCadence(name: string, now: number = Date.now()): void {
	lastRunAtMs.set(name, now);
}

export function subCadence(name: string, ms: number, now: number = Date.now()): boolean {
	const due = subCadenceDue(name, ms, now);
	if (due) markSubCadence(name, now);
	return due;
}

/** Test seam: forget every gate's last-run time. Not part of the supported API. */
export function __resetSubCadenceForTesting(): void {
	lastRunAtMs.clear();
}

/**
 * Test seam: forget ONE gate's last-run time, leaving every other name's
 * cadence untouched. `__resetSubCadenceForTesting` clears the whole shared
 * map, which is right for a suite that owns the entire process's cadence
 * state but wrong once two independently-reset gates share this one map —
 * `speed-heavy-cache.ts`'s speed and heavy models reset separately today
 * (`__resetSpeedModelForTesting`/`__resetHeavyModelForTesting`, called from
 * different test files, not always both), and a shared clear-all would make
 * resetting one silently reset the other too. Not part of the supported API.
 */
export function __resetSubCadenceKeyForTesting(name: string): void {
	lastRunAtMs.delete(name);
}
