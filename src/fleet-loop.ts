/**
 * fleet-loop — the fast loop that keeps the fleet serving: probe every node,
 * quarantine and repair the damaged ones, converge standing-registration labels,
 * and hand the JIT dispatcher its input.
 *
 * ONE RULE FOR `hadoku-builder`: a standing registration carries it iff its node
 * is SAFE — not quarantined, not drained, not disqualified by bootcamp
 * (`nodeIsSafe`). A guest's label is the backstop's (runner-health), under the
 * same rule. Placement among JIT nodes is `runners/traffic.ts`.
 *
 * THIS WAS A PRIORITY LADDER until 2026-09-21. GitHub has no runner priority,
 * so `runner-tiers.json` ranked nodes into tiers and this loop made lower tiers
 * invisible by stripping their label until the ones above filled. The all-JIT
 * conversion left it deciding nothing: every claw mints instead of carrying a
 * label, `carousel` forced every claw tier on, guests were skipped, and the one
 * signal it still fed the dispatcher was a constant. It was retired, along with
 * the file; a per-node ceiling (thermal or otherwise) is `maxConcurrent`.
 *
 * THE SIGNAL
 * ----------
 * Per-node concurrent job count, read over SSH. NOT the GitHub API: a
 * runner's `busy` flag is per-REGISTRATION, so a claw saturated by work for one
 * repo still reports idle on the other nineteen. Every node is probed as its ci
 * user (`src/lib/node-users.ts`); the local node without ssh (`nodeShell`).
 *
 * FAIL-OPEN, ALWAYS
 * -----------------
 * An unreachable node, an unparseable count, a failed label write — none of
 * them strands capacity. The worst outcome of a bug here must be "we used a
 * node we did not need", never "CI queued because a node was left dark".
 */
import { nodeReservation, getPm2HostBusy, type Reservation } from './node-reservation.js';
import { logger, TOKEN_RETRY_MS } from './host.js';
import { withGhCaller } from './gh-budget.js';
import { coveredRepos } from './ci-runner-fallback.js';
import { dispatchEphemeral } from './runners/ephemeral-tick.js';
import type { FleetDispatch } from './fleet-report-types.js';
import { mintsOnDemand } from './lib/node-role.js';
import { isBackstopHeld } from './runners/backstop-hold.js';
import { readDrain } from './runners/drain.js';
import { noteTick, registerLoop, TOKEN_WAIT_GRACE_MS } from './lib/liveness.js';
// The typed manifest reader and loaders moved to the config layer in wave 5c
// (F1): this file is ci-scheduling/run, and a raw manifest read sitting
// sideways of config is exactly the debt `src/lib/manifest.ts`'s header
// explains. `nodeFailsBootcamp` and `loadResidentRepos` moved OUT to
// `./runners/node-eligibility.ts` in wave 5f (split #2, fleet-loop split) —
// imported from there below, not restated here. `readFleetManifest` is still
// needed directly: the tick reads the manifest once per pass to enumerate
// `allNodes` and hands that same `fleetManifest` to `nodeIsSafe`.
import { readFleetManifest, loadEphemeralNodes, loadGuestNodes } from './lib/manifest.js';
import { loadNodeCapacity } from './lib/manifest.js';
import { probeNode, probeFleet, type ProbeResultLike, type NodeProbe } from './lib/node-probe.js';
import { markNodeSick, nodeIsSick, sickNodeNames } from './lib/sick-node.js';
import { repairSickNode } from './runners/node-repair.js';
import { loadResidentRepos, loadRequiredSet } from './runners/node-eligibility.js';
import { nodeIsSafe, setNodeEligibility, type LabelAction } from './runners/node-eligibility.js';

/**
 * Last probe from the fast loop, for readers that must not ssh themselves.
 * In-memory and null until the first tick, exactly like the runner-health
 * snapshot — a restart clears it rather than serving a stale fleet.
 */
let lastFleetProbe: { at: string; nodes: Record<string, NodeProbe> } | null = null;

/**
 * The last dispatch input a fast-loop tick built, so the dispatcher can run WITHOUT one.
 *
 * The dispatcher used to be called at the end of `tickFleet`, which tied its
 * cadence to the ladder's. Two loops doing unrelated work at unrelated natural
 * frequencies: the ladder writes labels and re-probes on a 60s rhythm, while
 * discovery latency IS queue latency and wants to be as fast as the API allows.
 *
 * Measured 2026-09-05, JIT jobs against standing ones on the same fleet:
 *   JIT      queue p50 45s   (mint itself: 3s)
 *   standing queue p50  2s
 * The whole difference is waiting for the next tick to look.
 *
 * That coupling also made a LABEL bug read as a queue bug: when carousel and the
 * backstop fought over hokon, the fast-loop tick stretched to a 119s median and
 * dispatch — riding on it — inherited every second.
 *
 * Conditional polling removed the reason to be slow: unchanged listings now cost
 * nothing, so the fleet spends ~480 calls/hr against 5,000 where it once
 * exhausted the budget. What is left is a timer.
 */
let lastDispatchInput: Parameters<typeof dispatchEphemeral>[0] | null = null;
/** One dispatch pass at a time. Two overlapping passes could both mint for the
 *  same run: `dispatch-pass` reconstructs in-flight work from LIVE units, and a
 *  pass that has not spawned yet is invisible to the one beside it. */
let dispatchInFlight = false;

/**
 * What the JIT dispatcher did last. Same lifetime rules as `lastFleetProbe`:
 * in-memory, cleared by a restart rather than serving a stale answer.
 *
 * `failingSince` is the only field that needs history, and it needs it because
 * the question worth alerting on is not "did a mint fail" — mints fail for
 * ordinary reasons — but "has this node stopped being able to mint at all".
 */
let lastDispatch: FleetDispatch = {
	at: null,
	minted: null,
	failed: null,
	skipped: null,
	inFlight: null,
	reaped: null,
	error: null,
	failingSince: null,
	totals: { minted: 0, failed: 0 },
	lastMintAt: null,
	recent: { since: new Date().toISOString(), minted: 0, failed: 0 },
};

const RECENT_WINDOW_MS = 60 * 60 * 1000;
/** Passes that minted or failed something, for `recent`. Quiet passes add nothing. */
let recentPasses: { atMs: number; minted: number; failed: number }[] = [];
let dispatchStartMs = Date.now();

/** What the last dispatch pass did, for the Fleet panel. */
export function getDispatchSnapshot(nowMs: number = Date.now()): FleetDispatch {
	const sinceMs = Math.max(dispatchStartMs, nowMs - RECENT_WINDOW_MS);
	const inWindow = recentPasses.filter((p) => p.atMs >= sinceMs);
	return {
		...lastDispatch,
		recent: {
			since: new Date(sinceMs).toISOString(),
			minted: inWindow.reduce((n, p) => n + p.minted, 0),
			failed: inWindow.reduce((n, p) => n + p.failed, 0),
		},
	};
}

/**
 * Fold one pass into the snapshot.
 *
 * Exported for tests: the fast loop reaches this only through a real dispatch,
 * and the state that matters (a failing streak across passes) takes several
 * ticks to express.
 */
export function recordDispatch(
	res: {
		minted: number;
		failed: number;
		skipped: number;
		inFlight: number;
		reaped: number | null;
	} | null,
	error: string | null,
	nowIso: string = new Date().toISOString()
): void {
	const prev = lastDispatch;
	// A pass that threw minted nothing we can vouch for, so it counts as failing
	// — but its COUNTS stay null, because we did not observe them.
	const attemptedAndAllFailed = res ? res.failed > 0 && res.minted === 0 : true;
	lastDispatch = {
		at: nowIso,
		minted: res?.minted ?? null,
		failed: res?.failed ?? null,
		skipped: res?.skipped ?? null,
		inFlight: res?.inFlight ?? null,
		reaped: res?.reaped ?? null,
		error,
		failingSince: attemptedAndAllFailed ? (prev.failingSince ?? nowIso) : null,
		totals: {
			minted: prev.totals.minted + (res?.minted ?? 0),
			failed: prev.totals.failed + (res?.failed ?? 0),
		},
		lastMintAt: res && res.minted > 0 ? nowIso : prev.lastMintAt,
		recent: prev.recent,
	};
	if (res && (res.minted || res.failed)) {
		const atMs = Date.parse(nowIso);
		recentPasses = recentPasses.filter((p) => p.atMs >= atMs - RECENT_WINDOW_MS);
		recentPasses.push({ atMs, minted: res.minted, failed: res.failed });
	}
}

let lastReservation: Reservation = { reserved: false, reason: null, detail: null };

/** What the last tick decided about the priority ladder, for the Fleet panel. */
export function getReservationSnapshot(): Reservation {
	return lastReservation;
}

/**
 * One dispatch pass, between fast-loop ticks, on the ladder's last known facts.
 *
 * Returns a reason rather than throwing or logging on the quiet paths, so the
 * caller can stay silent for the ordinary ones — `no-input` is every tick before
 * the first ladder pass, and `busy` is a pass still running, both normal.
 *
 * The staleness this accepts is bounded and deliberate. `fleetProbe` is up to one
 * fast-loop tick old, so `freeMb` can lag; what actually bounds concurrency is
 * `liveUnits`, and `dispatch-pass` re-reads that from the NODES on every pass.
 * So a second pass sees the first pass's units and stops at the same cap the
 * single-pass design stopped at — the count bound is unchanged, only the memory
 * reading is older. A pass that could not probe returns null and mints nothing.
 */
export async function dispatchBetweenTicks(
	token: string,
	gh: Parameters<typeof dispatchEphemeral>[2],
	dispatch: typeof dispatchEphemeral = dispatchEphemeral
): Promise<'ok' | 'no-input' | 'busy'> {
	if (!lastDispatchInput) return 'no-input';
	if (dispatchInFlight) return 'busy';
	dispatchInFlight = true;
	try {
		// `res` is the pass result, `null` its "could not look" answer — see
		// dispatchEphemeral. Passing `res ?? null` with a null error was the bug:
		// the function returned `void`, so EVERY pass recorded a resultless one,
		// `recordDispatch` scored that as attempted-and-all-failed, and the panel
		// pinned `failingSince` to the first pass after each restart forever.
		const input = lastDispatchInput;
		const res = await withGhCaller('dispatch-poll', () => dispatch(input, token, gh));
		recordDispatch(res, res ? null : 'no ephemeral node could be probed — see the warnings above');
		return 'ok';
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// Recorded BEFORE the log line, because the log line is what this whole
		// field exists to stop being the only record. A dispatcher that throws
		// must never take label toggling down with it.
		recordDispatch(null, msg);
		logger.warn(`[fleet-loop] ephemeral dispatch failed (label toggling unaffected): ${msg}`);
		return 'ok';
	} finally {
		dispatchInFlight = false;
	}
}

/** Test seam. Not part of the supported API. */
export function __setDispatchInputForTesting(
	input: Parameters<typeof dispatchEphemeral>[0] | null
): void {
	lastDispatchInput = input;
}

/** Test seam. Not part of the supported API. */
export function __resetDispatchInputForTesting(): void {
	lastDispatchInput = null;
	dispatchInFlight = false;
}

export function getFleetProbeSnapshot(): {
	at: string;
	nodes: Record<string, NodeProbe>;
} | null {
	return lastFleetProbe;
}

/**
 * Test seam. Not part of the supported API.
 *
 * The label floor now asks the census whether any ephemeral node can MINT before
 * it pages, and that answer comes from this probe. Without a seam the only way to
 * reach the suppressing branch from a test is to run a whole fast-loop tick, so the
 * branch that decides whether the fleet pages would go untested — which is the
 * one direction that must not regress silently.
 */
export function __setFleetProbeForTesting(
	probe: { at: string; nodes: Record<string, NodeProbe> } | null
): void {
	lastFleetProbe = probe;
}

/**
 * How often to re-assert every node's labels against GitHub even when nothing
 * this loop can see has changed. At 60s polling this is roughly every 10
 * minutes — frequent enough that external drift is a blip, cheap enough that
 * the common case (already in the desired state) writes nothing at all.
 */
export const RECONCILE_EVERY_TICKS = 10;

/** Ticks since process start. Drives the periodic full reconcile above. */
let tickCount = 0;

/**
 * The label state this loop last converged each node to. Empty after a
 * restart, so the first tick is a full reconcile — which is what makes a
 * restart a valid way to heal drift.
 */
let believedLabel = new Map<string, boolean>();
let started = false;
/**
 * Has a pass run WITH a token since start? Until one has, a missing token is
 * retried every TOKEN_RETRY_MS rather than at the next interval (#133).
 */
let tokenSeen = false;
let tokenWaitHandle: ReturnType<typeof setTimeout> | null = null;
let tokenRetryMs = TOKEN_RETRY_MS;
/** Test seam: shorten the wait between token reads before the first pass. */
export function __setFastLoopTokenRetryForTesting(ms: number | null): void {
	tokenRetryMs = ms ?? TOKEN_RETRY_MS;
}

export function __resetFleetLoopForTesting(): void {
	lastFleetProbe = null;
	lastDispatch = {
		at: null,
		minted: null,
		failed: null,
		skipped: null,
		inFlight: null,
		reaped: null,
		error: null,
		failingSince: null,
		totals: { minted: 0, failed: 0 },
		lastMintAt: null,
		recent: { since: new Date().toISOString(), minted: 0, failed: 0 },
	};
	recentPasses = [];
	dispatchStartMs = Date.now();
	believedLabel = new Map();
	tickCount = 0;
	started = false;
	tokenSeen = false;
	if (tokenWaitHandle) clearTimeout(tokenWaitHandle);
	tokenWaitHandle = null;
}

export interface FleetTickResult {
	actions: LabelAction[];
}

/**
 * One pass of the fast loop: probe, quarantine and repair, converge standing
 * labels, and hand the dispatcher its input. Returns what it did so the caller
 * can log one line and tests can assert without stubbing timers.
 */
export async function tickFleet(
	token: string,
	gh: {
		get: (path: string, token: string, repo?: string) => Promise<unknown>;
		write: (
			method: 'POST' | 'DELETE',
			path: string,
			token: string,
			body?: unknown,
			repo?: string
		) => Promise<{ ok: boolean; status: number }>;
	},
	/** Injectable so the tick is testable. Without it every test sshes for real. */
	probe: (node: string) => Promise<ProbeResultLike | null> = probeNode,
	/**
	 * Whether hokon is currently serving pm2-host work. Passed in because the
	 * caller already holds the runner listing.
	 */
	pm2HostBusy = getPm2HostBusy(),
	/**
	 * Injectable: without it this reads the real wall clock and the real cron
	 * profiles, so a test would assert what time CI happened to run.
	 */
	reserve: (busy: boolean) => Reservation = (busy) => nodeReservation(new Date(), busy),
	/**
	 * Injectable: without it a test that puts a node in the sick set SSHes the
	 * real fleet and runs a real repair against production stores — which is
	 * exactly what happened the first time these tests ran.
	 */
	repair: (node: string) => Promise<boolean> = repairSickNode,
	/**
	 * Injectable: `dispatchEphemeral` shells out to every ephemeral node, so a
	 * unit suite without this needs the fleet powered on.
	 */
	dispatch: typeof dispatchEphemeral = dispatchEphemeral,
	/** Which nodes mint instead of carrying labels. Read ONCE per tick. */
	ephemeralOverride?: ReadonlySet<string>,
	/** Which nodes are GUESTS. Injected for the same reason. */
	guestOverride?: ReadonlySet<string>
): Promise<FleetTickResult> {
	// Counted BEFORE anything can fail, so a reconcile cannot be starved by
	// ticks that bail. tickCount starts at 0: the first tick is a full reconcile.
	const thisTick = tickCount++;

	const fleetManifest = readFleetManifest();
	const allNodes = Object.keys(fleetManifest?.machines ?? {});
	const fleetProbe = await probeFleet(allNodes, loadNodeCapacity(), probe);
	lastFleetProbe = { at: new Date().toISOString(), nodes: Object.fromEntries(fleetProbe) };

	// SICK-NODE RETIREMENT, before anything else reads eligibility. The probe
	// carries the guard's own verdict. Quarantine first so nothing below can
	// promote the node, then repair — a retired node gets no jobs, so nothing
	// else ever would.
	for (const [node, p] of fleetProbe) {
		if (p.sick) markNodeSick(node);
	}
	for (const node of sickNodeNames()) {
		// Only repair a node we can see; an unreachable one keeps its quarantine.
		if (fleetProbe.get(node)?.reachable) await repair(node);
	}

	// Recorded for the Fleet panel. hokon is a guest, so the reservation acts
	// through the BACKSTOP (runner-health), not through a write here.
	lastReservation = reserve(pm2HostBusy);

	const ephemeralNodes = ephemeralOverride ?? loadEphemeralNodes();
	const guestNodes = guestOverride ?? loadGuestNodes();
	// Read ONCE per tick, so every node is judged against the same bar.
	const drainedNodes = new Set(Object.keys(readDrain()));
	const requiredSet = loadRequiredSet();
	const dueReconcile = thisTick % RECONCILE_EVERY_TICKS === 0;

	const actions: LabelAction[] = [];
	for (const node of allNodes) {
		if (guestNodes.has(node)) continue; // the backstop's label, not ours
		const resident = ephemeralNodes.has(node) ? loadResidentRepos(node) : undefined;
		if (resident !== undefined && resident.length === 0) continue; // nothing standing
		const want = nodeIsSafe(node, drainedNodes, fleetManifest, requiredSet);
		if (!dueReconcile && believedLabel.get(node) === want) continue;
		const act = await setNodeEligibility(node, token, gh, want, resident);
		// Believed only once nothing failed, so a partial write is retried next tick.
		if (!act.failed) believedLabel.set(node, want);
		if (act.changed || act.failed) actions.push(act);
	}

	// CACHED for the dispatcher, which runs on its own faster timer — see
	// `dispatchBetweenTicks`. Recomputing these there would mean a second place
	// deciding them, and re-probing would put an ssh sweep on a 15s timer.
	lastDispatchInput = {
		fleetProbe,
		ephemeral: ephemeralNodes,
		nodes: fleetManifest?.machines ?? {},
		isSick: nodeIsSick,
		repos: coveredRepos(),
		// Standing runners that can take a queued job RIGHT NOW: the non-ephemeral
		// nodes carrying the label. A guest carries it only while the backstop
		// has promoted it — its own record of that, not a belief about it. EMPTY
		// (the normal all-JIT case) removes the dispatcher's age gate. An
		// ON-DEMAND guest stands nothing up (#120): promoting it makes it a mint
		// target, which is exactly the case the age gate is removed for.
		standingEligible: new Set(
			allNodes.filter(
				(n) =>
					!ephemeralNodes.has(n) &&
					!mintsOnDemand(fleetManifest?.machines?.[n]) &&
					nodeIsSafe(n, drainedNodes, fleetManifest, requiredSet) &&
					(guestNodes.has(n) ? isBackstopHeld(n) : true)
			)
		),
	};
	await dispatchBetweenTicks(token, gh, dispatch);

	// Recorded last, after everything above that could throw — a tick that
	// threw must never read as alive. See lib/liveness.ts.
	noteTick('fleet-loop', FAST_LOOP_SECONDS * 1000);
	return { actions };
}

/** Seconds between fast-loop passes: probe, repair, labels. */
export const FAST_LOOP_SECONDS = 60;
/**
 * Seconds between dispatcher passes. Faster than the loop because discovery
 * latency IS queue latency under all-JIT: nothing starts until a poll finds it
 * (measured 2026-09-05: JIT queue p50 45s against standing 2s, with the mint
 * itself taking 3s — the gap was waiting for the next tick to look).
 * Conditional polling made an unchanged listing free, so ~480 calls/hr fits
 * the 5,000 budget.
 */
export const DISPATCH_SECONDS = 15;

/**
 * Start the fast loop and the dispatcher. Separate from runner-health's
 * 10-minute tick: this one keeps queues short, so it reacts in seconds.
 */
export function startFastLoop(
	getToken: () => string | undefined,
	gh: Parameters<typeof tickFleet>[1],
	/** Test seam: the pass itself, so a test can start the loop without ssh. */
	tick: typeof tickFleet = tickFleet
): void {
	if (started) return;
	started = true;
	// Registered BEFORE the token wait below, which can legitimately stall on
	// a sealed vault — see lib/liveness.ts. A loop that hangs right here, never
	// reaching its first `tick()`, must still be visible as pending-then-stale,
	// not simply absent.
	registerLoop('fleet-loop', FAST_LOOP_SECONDS * 1000, { firstTickGraceMs: TOKEN_WAIT_GRACE_MS });
	registerLoop('dispatch', DISPATCH_SECONDS * 1000, { firstTickGraceMs: TOKEN_WAIT_GRACE_MS });
	logger.info(
		`[fleet-loop] fast loop every ${FAST_LOOP_SECONDS}s, dispatcher every ${DISPATCH_SECONDS}s`
	);
	// Tick IMMEDIATELY, then on the interval: a restart must not leave the Fleet
	// panel showing every node "unprobed" for the first minute.
	const startedAtMs = Date.now();
	let waitLogged = false;
	//
	// A boot with the vault still sealed has no token yet (#133). That pass
	// used to return silently and the probe waited a whole interval, so an
	// unseal 5s after boot still left the panel `machines probing…` for a
	// minute. Until the first pass with a token, look again every
	// TOKEN_RETRY_MS, and say once that the loop is waiting.
	const run = () => {
		const token = getToken();
		if (!token) {
			if (!tokenSeen && !tokenWaitHandle) {
				if (!waitLogged) {
					logger.warn(
						`[fleet-loop] no GitHub token from host yet (vault sealed?) — first probe waits for it, ` +
							`retrying every ${tokenRetryMs / 1000}s`
					);
					waitLogged = true;
				}
				tokenWaitHandle = setTimeout(() => {
					tokenWaitHandle = null;
					run();
				}, tokenRetryMs);
				tokenWaitHandle.unref?.();
			}
			return;
		}
		if (!tokenSeen && waitLogged) {
			logger.info(
				`[fleet-loop] GitHub token arrived after ${Math.round((Date.now() - startedAtMs) / 1000)}s — probing now`
			);
		}
		tokenSeen = true;
		if (tokenWaitHandle) clearTimeout(tokenWaitHandle);
		tokenWaitHandle = null;
		withGhCaller('fleet-loop', () => tick(token, gh))
			.then((r) => {
				for (const a of r.actions) {
					logger.info(
						`[fleet-loop] ${a.direction} ${a.node}: ${a.changed} label(s) changed, ${a.failed} failed`
					);
				}
			})
			.catch((err) => {
				// Fail-open: a broken tick must never strand capacity.
				logger.warn(
					`[fleet-loop] tick threw: ${err instanceof Error ? err.message : String(err)} — leaving labels as-is`
				);
			});
	};
	run();
	setInterval(run, FAST_LOOP_SECONDS * 1000).unref?.();

	const dispatchRun = () => {
		const token = getToken();
		if (!token) return;
		void dispatchBetweenTicks(token, gh).catch((err: unknown) => {
			// Belt and braces: a timer that can throw would stop dispatching forever.
			logger.warn(
				`[fleet-loop] dispatch timer threw: ${err instanceof Error ? err.message : String(err)}`
			);
		});
	};
	setInterval(dispatchRun, DISPATCH_SECONDS * 1000).unref?.();
}
