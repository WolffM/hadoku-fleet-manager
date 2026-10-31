/**
 * THE GENERIC AUTOMATION RUNNER (refactor plan §6.2, wave5e-2026-10-31 lane
 * B). `src/scheduled-converger.ts`'s `createConverger` and
 * `src/claw-reboot.ts`'s hand copy each implemented, independently: a
 * no-overlap clock that is due one interval after the LAST pass on disk and
 * never sooner than a minimum after boot; a paging ledger that debounces a
 * repeat page against `now - lastPagedAt < repageMs` and clears on recovery;
 * and a "the job itself produced nothing" branch that pages only once it has
 * stayed silent past a threshold. This module is the one copy of each of
 * those mechanics. It does NOT force every job's report into one shape —
 * `ConvergeDoc`'s (node, facet) rows and `RebootDoc`'s (node, finding) pairs
 * are read by code that stays with each job (its own `classify*` + its own
 * entity loop), because collapsing a reboot cycle's report into a converger's
 * row shape would be a behaviour change, not a move, and this wave is
 * explicitly a port, not a redesign (wave5e-2026-10-31.md, lane B's row).
 *
 * THE PIPELINE (plan §6.2: "spawn-json → classify → pager ledger → the job
 * sink"):
 *   1. spawn (F6's `spawnScriptJson`, unmoved — see scheduled-converger.ts)
 *      returns `{ doc: T | null, why }`.
 *   2. CLASSIFY. `doc === null` is read by {@link classifyMissingDoc}: the
 *      process either never finished normally (`unavailable` — "I could not
 *      look", never "nothing is wrong", AGENTS.md) or finished and still
 *      produced nothing readable (`broke` — the SCRIPT is what is wrong, not
 *      the box it ran on). `doc !== null` is read by each job's own
 *      doc-shaped classifier into `ok` or `findings`. All four verdicts are
 *      exactly one of {@link Verdict}; `ok` is reserved for "ran, and found
 *      nothing wrong, and could read everything it needed to".
 *   3. PAGER LEDGER. {@link createPager} is the shared debounce+recovery
 *      primitive; each job still decides WHICH keys page and with what
 *      words, because that decision is the job's, not the runner's.
 *   4. JOB SINK. {@link finishTick} calls `recordJobResult` (the host port
 *      already used by `runner-health.ts`'s own tick) once per pass, mapping
 *      `ok`/`findings` to `succeeded` and `unavailable`/`broke` to `failed` —
 *      a gate that found real problems still RAN; a gate that could not look
 *      did not.
 *
 * LIVENESS. {@link finishTick} is also the ONE place a completed tick is
 * finalised, and it notes the tick (`noteTick`, `src/lib/liveness.ts`);
 * {@link scheduleRepeating} registers the job when it is scheduled. Every job
 * this runner starts is therefore visible to the off-box heartbeat, including
 * one whose first pass never completes.
 */
import { noteTick, registerLoop, TOKEN_WAIT_GRACE_MS } from './liveness.js';
import { logger, recordJobResult } from '../host.js';

/** A job registry entry's kind (plan §6.2): what reading its doc MEANS. */
export type JobKind = 'converger' | 'gate' | 'recorder';

/**
 * The one verdict every job tick reduces to, regardless of its report shape.
 *
 *   ok           ran; read everything it needed; nothing wrong.
 *   findings     ran; read what it needed; found something that needs a
 *                human or a repair — this is still a SUCCESSFUL run.
 *   unavailable  could not look: the process never finished normally (it was
 *                never started, or was killed before it reported — by the
 *                run's own timeout or otherwise), or the job's own report
 *                says it could not read something it needed to. Never `ok`.
 *   broke        the process finished and still produced nothing readable —
 *                empty stdout or stdout that will not parse as JSON. The
 *                SCRIPT is what is wrong, not its environment. Never `ok`.
 */
export type Verdict = 'ok' | 'findings' | 'unavailable' | 'broke';

/**
 * Classifies a `doc === null` spawn result. `why` is `spawnScriptJson`'s own
 * string: `"exit <code>[, no report|, unparseable (...)]"` when the process
 * ran to completion, or `"could not start: ..."` / `"exit <code> (<signal>)"`
 * — a signal means it was killed, almost always by the run's own timeout —
 * when it did not. Only a bare numeric exit with no signal counts as "ran to
 * completion"; that is the one case where a document's absence is the
 * SCRIPT's own fault rather than the environment's.
 */
export function classifyMissingDoc(why: string): 'unavailable' | 'broke' {
	const ranToCompletion = /^exit\s+\d+(?:[,\s]|$)/.test(why);
	return ranToCompletion ? 'broke' : 'unavailable';
}

/** One hour, in ms. A duration literal, not a pager policy — `repageDue`'s callers each pick their own window. */
export const HOUR_MS = 60 * 60_000;
/** One day, in ms. */
export const DAY_MS = 24 * HOUR_MS;

/** `Math.round(ms / 1h)` + `h`, e.g. `6h` — every page/recovery message's duration. */
export function hours(ms: number): string {
	return `${Math.round(ms / HOUR_MS)}h`;
}

export interface PagerCounts {
	pages: number;
	recoveries: number;
}

/**
 * Is a repage due? No previous page (`lastPagedIso` absent or unparseable)
 * is always due — a cold ledger must not read as "inside the window". This
 * is the one comparison every pager in the fleet makes, and it is pulled out
 * on its own (not just inlined in {@link createPager}) because `ci-alerts.ts`'s
 * `decideCiAlert` needs the SAME arithmetic from a pure function that does not
 * own the post — its announcement happens one layer up, after the decision,
 * not inside this check (F12, plan §4.1).
 */
export function repageDue(
	lastPagedIso: string | undefined,
	now: number,
	repageMs: number
): boolean {
	if (!lastPagedIso) return true;
	const last = Date.parse(lastPagedIso);
	return Number.isNaN(last) || now - last >= repageMs;
}

/**
 * THE SHARED PAGING LEDGER. Both `createConverger`'s and `claw-reboot.ts`'s
 * `page`/`recover` closures were this exact logic, hand-copied (F12's
 * `page-ledger` debt). `paged` is the caller's own on-disk state slice — this
 * function never persists anything itself, so the caller's existing
 * write-then-rename (F3, `writeJsonAtomic`) is untouched.
 */
export function createPager(params: {
	/** The state slice this pager mutates in place; the caller persists it. */
	paged: Record<string, string>;
	now: number;
	repageMs: number;
	post: (content: string, source: string) => Promise<unknown>;
	source: string;
}): {
	page(key: string, content: string): Promise<void>;
	recover(key: string, content: string): Promise<void>;
	counts: PagerCounts;
} {
	const counts: PagerCounts = { pages: 0, recoveries: 0 };
	return {
		counts,
		async page(key, content) {
			if (!repageDue(params.paged[key], params.now, params.repageMs)) return;
			params.paged[key] = new Date(params.now).toISOString();
			counts.pages++;
			await params.post(content, params.source);
		},
		async recover(key, content) {
			if (!params.paged[key]) return;
			delete params.paged[key];
			counts.recoveries++;
			await params.post(content, params.source);
		},
	};
}

export interface ScheduleClock {
	intervalMs: number;
	firstPassMinMs: number;
}

/**
 * "Due one interval after the LAST pass on disk, never sooner than
 * `firstPassMinMs`" — both jobs' identical boot-timing rule, so a restart
 * neither skips the interval nor reruns it, and the first pass never lands on
 * the fast loop's own boot probe.
 */
export function computeFirstDelayMs(
	cfg: ScheduleClock,
	lastRunAt: string | null,
	now: number = Date.now()
): number {
	const sinceLast = lastRunAt ? now - Date.parse(lastRunAt) : Infinity;
	return Math.max(cfg.firstPassMinMs, Math.min(cfg.intervalMs, cfg.intervalMs - sinceLast));
}

export interface ScheduledJob {
	stop(): void;
}

/**
 * One `setTimeout` due at `firstInMs`, then a `setInterval` every
 * `intervalMs` — both unref'd, so neither ever holds the process open. The
 * caller owns what `pass` does; this only owns the clock.
 */
export function scheduleRepeating(
	firstInMs: number,
	intervalMs: number,
	pass: () => void,
	loopName?: string
): ScheduledJob {
	// Registered BEFORE the first pass is due, so a job whose first pass never
	// completes reads as stale on the off-box heartbeat once its first run plus
	// the token-wait grace has passed, rather than as absent (liveness.ts).
	if (loopName)
		registerLoop(loopName, intervalMs, { firstTickGraceMs: firstInMs + TOKEN_WAIT_GRACE_MS });
	let timers: ReturnType<typeof setTimeout>[] = [];
	const first = setTimeout(() => {
		pass();
		const every = setInterval(pass, intervalMs);
		every.unref?.();
		timers.push(every);
	}, firstInMs);
	first.unref?.();
	timers.push(first);
	return {
		stop() {
			for (const t of timers) clearTimeout(t);
			timers = [];
		},
	};
}

/**
 * No two passes of the same job run at once. A slow pass (a stuck ssh sweep)
 * must not stack a second one on top of it rather than skip a tick.
 */
export function createOverlapGuard(): { run(pass: () => Promise<void>): void } {
	let inFlight = false;
	return {
		run(pass) {
			if (inFlight) return;
			inFlight = true;
			// `pass` is expected to handle its own rejections (both callers chain
			// their own `.catch`); `void` only tells the linter this one is not
			// awaited, not that failures are swallowed twice.
			void pass().finally(() => {
				inFlight = false;
			});
		},
	};
}

/**
 * The job-result sink call (T7, plan §7.3): one `recordJobResult` per tick,
 * through the host port already used by `runner-health.ts`'s own tick.
 * `ok`/`findings` are a SUCCESSFUL run (the job did its job, even if what it
 * found was bad news); `unavailable`/`broke` are a run that produced nothing
 * usable. Never throws: a sink outage must not turn a converger pass into an
 * unhandled rejection — it is logged and the tick still returns its summary.
 */
export async function reportJobResult(
	jobName: string,
	verdict: Verdict,
	durationMs: number,
	opts: { why?: string; data?: Record<string, unknown> } = {}
): Promise<void> {
	const jobState: 'succeeded' | 'failed' =
		verdict === 'ok' || verdict === 'findings' ? 'succeeded' : 'failed';
	try {
		await recordJobResult(jobName, jobState, durationMs, {
			error: jobState === 'failed' ? opts.why : undefined,
			data: { verdict, ...opts.data },
		});
	} catch (err) {
		logger.warn(
			`[job-runner] ${jobName}: recordJobResult failed, continuing: ` +
				(err instanceof Error ? err.message : String(err))
		);
	}
}

export interface FinishTickParams {
	jobName: string;
	/** The job's cadence: the line its liveness is judged against. */
	intervalMs: number;
	now: number;
	verdict: Verdict;
	durationMs: number;
	why?: string;
	data?: Record<string, unknown>;
}

/**
 * THE ONE PLACE A COMPLETED TICK IS FINALISED. Every job's tick — converger,
 * claw-reboot, and whatever a `gate`/`recorder` kind adds later — calls this
 * exactly once, at the end, on every path (doc present or not). It notes the
 * tick for the off-box heartbeat (liveness.ts) and reports to the job sink. A
 * pass that could not look still COMPLETED: the loop is alive, and the sink
 * records the run as failed.
 */
export async function finishTick(params: FinishTickParams): Promise<void> {
	noteTick(params.jobName, params.intervalMs);
	await reportJobResult(params.jobName, params.verdict, params.durationMs, {
		why: params.why,
		data: params.data,
	});
}
