/**
 * Liveness ledger for the fleet's own control loops — dispatch (15s,
 * `runners/dispatch-tick.ts`), the fast loop (60s, `fleet-loop.ts`),
 * runner-health (10min, `runner-health.ts`), and — via the generic job
 * runner lane B is building on `scheduled-converger.ts` — every scheduled
 * converger and `claw-reboot.ts`.
 *
 * THE GAP THIS CLOSES. mgmt-api's `/api/status` has always said whether the
 * PROCESS is up (monitoring-api's heartbeat probes it every minute). It has
 * never said whether any of the loops INSIDE that process are still ticking.
 * An unhandled rejection, a stuck `await`, or a timer that silently failed to
 * re-arm leaves the process alive, `/api/status` answering 200, and every
 * loop dark — nothing before this noticed. `getFleetLiveness()` is read by
 * mgmt-api's status route and folded into that same body (wave 5e lane C).
 *
 * TWO CALLS, TWO DIFFERENT MOMENTS:
 *
 *   - `registerLoop(name, expectedMs, opts)` — called ONCE, where a loop
 *     STARTS (its `start*()` function), REGARDLESS of whether it ever ticks.
 *     A passive host that never calls `start()` never registers anything,
 *     which is correct: nothing was promised to run there.
 *   - `noteTick(name, expectedMs)` — called at the END of every tick that
 *     completed WITHOUT THROWING. A tick that throws must never reach this
 *     call — that is what makes "last tick age" mean "the loop is still
 *     running", not merely "the loop started something".
 *
 * WHY BOTH ARE NEEDED. `noteTick` alone cannot see a loop that never ticks AT
 * ALL — a `start()` that hangs forever awaiting a token, or whose first pass
 * deadlocks before reaching its own `noteTick` line, would simply never
 * create an entry, and "absent" would read as "nothing to report" exactly
 * the way a thrown tick must NOT read as "alive". That is "I could not look"
 * rendering as "nothing is wrong" — the one failure this whole layer exists
 * to refuse. `registerLoop` records the loop's existence and start time
 * independently of whether it ever ticks, so a loop that hangs from boot is
 * visible (as `pending`, then `stale`) instead of invisible.
 *
 * WHY IN-MEMORY, NOT PERSISTED. The question this answers is "is THIS
 * process's instance of the loop still turning", which is exactly the
 * question a restart answers trivially (yes, as of the restart) — so there is
 * nothing a persisted ledger would add, and persisting it would let a loop
 * that died ten minutes before a restart read as "ticked ten minutes ago"
 * after the restart, which is the wrong answer for a NEW process. `startedAt`
 * below exists so a reader can see how young that "ticked recently" claim is
 * allowed to be.
 *
 * THREE STATUSES. `pending` — registered, never ticked, still inside its
 * grace window: a restart (fresh `registeredAt`) is always `pending`, never
 * `stale`, so a restart cannot page on its own. `ok` — ticked recently
 * enough. `stale` — either a tick that stopped landing (`lastTickAt` set,
 * too old) or a loop that never ticked at all past its grace window
 * (`lastTickAt: null`) — the exact case this module exists to stop being
 * silent.
 */

/** One loop's last completed tick, as recorded by `noteTick`. */
interface TickRecord {
	atMs: number;
	expectedMs: number;
}

/** One loop's registration, as recorded by `registerLoop`. */
interface LoopRegistration {
	expectedMs: number;
	registeredAtMs: number;
	firstTickGraceMs: number;
}

const lastTick = new Map<string, TickRecord>();
const registered = new Map<string, LoopRegistration>();

/** Process start, for `FleetLiveness.startedAt`. Module load time: this file
 *  is imported once, at process boot, by `src/index.ts`. */
const startedAtMs = Date.now();

/**
 * How far past its OWN expected interval a loop may run before its tick
 * counts as stopped, as a multiple of that interval rather than a fixed
 * duration — a loop ticking every 15s and one ticking every 10min need
 * different absolute slack, but the same tolerance for "one slow pass".
 *
 * 3x absorbs an ordinary slow pass (a wide ssh sweep, a GitHub blackout
 * suppressing calls until the budget resets, a repair that ran long) without
 * hiding a loop whose timer has genuinely stopped re-arming — which, on any
 * of these cadences, means several consecutive missed ticks, not one.
 */
export const STALE_MULTIPLIER = 3;

/**
 * Floor under `STALE_MULTIPLIER × expectedMs`, so a short cadence (dispatch's
 * 15s, or a sub-second value a test passes) cannot turn ordinary event-loop
 * jitter into a false `stale`. 60s is comfortably inside every real loop's
 * own tolerance (dispatch's un-floored threshold is already 45s) and is the
 * same order of magnitude as the shortest alert debounce elsewhere in this
 * package (`OFFLINE_TICKS_BEFORE_ALERT` ≈ 20min, `FLOOR_CONFIRM_DELAY_MS` 5s).
 */
export const STALE_FLOOR_MS = 60_000;

/**
 * Extra slack for a loop's FIRST tick only, on top of its ordinary
 * `max(STALE_MULTIPLIER × expectedMs, STALE_FLOOR_MS)` threshold — the time a
 * loop may legitimately sit `pending` before its own cadence-derived
 * threshold would have called it `stale` anyway.
 *
 * SIZED OFF THE TOKEN WAIT every one of today's three loops shares
 * (`dispatch`'s and the fast loop's `run()`, runner-health's
 * `startRunnerHealthMonitor`): all three poll `githubToken()` every
 * `TOKEN_RETRY_MS` (`host.ts`, 5s) until the host has one, because "mgmt-api
 * boots with its vault SEALED whenever an ecosystem reload restarts
 * Vaultwarden beside it, so 'no token at start()' is a normal boot" — that
 * file's own words, and its own close: "the first tick goes out within this
 * long [5s] of the unseal." An ordinary boot therefore resolves within a
 * handful of 5s retries. 5 minutes is 60x that interval: comfortably past
 * any boot jitter (a slow deploy, Vaultwarden restarting alongside mgmt-api)
 * while still bounding how long a GENUINELY stuck wait — the vault left
 * sealed, a deadlocked first pass — can stay invisible. One shared constant
 * rather than three guessed numbers, because all three loops race the exact
 * same mechanism: if the token path is healthy they all clear it within
 * seconds of each other, and if it is stuck all three share that fate.
 *
 * For runner-health specifically this adds almost nothing on top of its own
 * 3x cadence (10min x 3 = 30min already dwarfs 5min) — it is carried here
 * anyway so one call site, one constant, one explanation covers all three.
 */
export const TOKEN_WAIT_GRACE_MS = 5 * 60_000;

/**
 * Record that `loop` exists and has started, independent of whether it ever
 * ticks. Call ONCE, at the top of the loop's `start*()` function — before
 * any `await` that could hang (a token wait, a vault read) — so a loop that
 * never completes a single tick is still visible as `pending`, then `stale`,
 * rather than simply absent forever.
 *
 * Idempotent per process restart only: calling it again resets
 * `registeredAt` to now, which is exactly what a restart should do — the new
 * process's clock, not the old one's.
 */
export function registerLoop(
	name: string,
	expectedMs: number,
	opts: { firstTickGraceMs?: number } = {}
): void {
	registered.set(name, {
		expectedMs,
		registeredAtMs: Date.now(),
		firstTickGraceMs: opts.firstTickGraceMs ?? 0,
	});
}

/**
 * Record that `loop` just completed a tick. Cheap and synchronous — a single
 * `Map.set` — so calling it from inside a 15s tick costs nothing worth
 * measuring. Call it ONCE per tick, after everything else in that tick's
 * success path: a tick that throws before reaching its call must not be
 * recorded as alive.
 */
export function noteTick(loop: string, expectedMs: number): void {
	lastTick.set(loop, { atMs: Date.now(), expectedMs });
}

export type LoopStatus = 'ok' | 'pending' | 'stale';

export interface LoopLiveness {
	name: string;
	/** ISO timestamp of the loop's last completed tick, or `null` if it has
	 *  never ticked since this process registered it. */
	lastTickAt: string | null;
	/** The interval that loop's own caller declared, ms. */
	expectedMs: number;
	/** `now` minus the last tick, or — when `lastTickAt` is `null` — `now`
	 *  minus the loop's registration. Never negative. */
	ageMs: number;
	/**
	 * `true` iff `status === 'stale'`. Kept alongside `status` (rather than
	 * folded away) because it is the one field `heartbeat.ts`'s `fleetAlerts`
	 * filters on, and a boolean reads better at that call site than a string
	 * comparison.
	 */
	stale: boolean;
	/**
	 * `ok` — ticked inside its own threshold.
	 * `pending` — registered, never ticked, still inside its first-tick grace.
	 *             A restart is ALWAYS `pending` on every loop it starts, never
	 *             `stale` — `registeredAtMs` resets to now on every call to
	 *             `registerLoop`.
	 * `stale` — either a tick that stopped landing (`lastTickAt` set, too
	 *           old), or a loop that never ticked at all past its grace
	 *           window (`lastTickAt: null`) — the case this module exists to
	 *           stop being silent.
	 */
	status: LoopStatus;
}

export interface FleetLiveness {
	/** One entry per loop this process has ever REGISTERED (via
	 *  `registerLoop`) or ticked (via `noteTick`) — which, by construction, is
	 *  every loop that called either, i.e. every loop that started. A loop
	 *  never started (a passive host) has no entry at all. */
	loops: LoopLiveness[];
	/** ISO timestamp this process (this module) started. */
	startedAt: string;
}

/**
 * The fleet's control loops as of `now`. Pure read of in-memory state — no
 * I/O, so this is safe to call from an HTTP route on every request.
 */
export function getFleetLiveness(now: number = Date.now()): FleetLiveness {
	const names = new Set<string>([...registered.keys(), ...lastTick.keys()]);
	const loops: LoopLiveness[] = [];
	for (const name of names) {
		const tick = lastTick.get(name);
		const reg = registered.get(name);
		const expectedMs = tick?.expectedMs ?? reg?.expectedMs ?? 0;
		const threshold = Math.max(expectedMs * STALE_MULTIPLIER, STALE_FLOOR_MS);
		if (tick) {
			const ageMs = Math.max(0, now - tick.atMs);
			const stale = ageMs > threshold;
			loops.push({
				name,
				lastTickAt: new Date(tick.atMs).toISOString(),
				expectedMs,
				ageMs,
				stale,
				status: stale ? 'stale' : 'ok',
			});
			continue;
		}
		// Registered, never ticked. `names` is built from the union of both
		// maps and this branch is reached only when `tick` is absent, so `reg`
		// is guaranteed set here.
		const sinceRegMs = Math.max(0, now - reg!.registeredAtMs);
		const grace = threshold + reg!.firstTickGraceMs;
		const stale = sinceRegMs > grace;
		loops.push({
			name,
			lastTickAt: null,
			expectedMs,
			ageMs: sinceRegMs,
			stale,
			status: stale ? 'stale' : 'pending',
		});
	}
	loops.sort((a, b) => a.name.localeCompare(b.name));
	return { loops, startedAt: new Date(startedAtMs).toISOString() };
}

/** Test seam: forget every registration and recorded tick, so one test's
 *  loops cannot read as already-started or already-ticked in the next. Not
 *  part of the supported API. */
export function __resetLivenessForTesting(): void {
	lastTick.clear();
	registered.clear();
}
