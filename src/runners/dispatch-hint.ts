/**
 * WEBHOOK HINTS: GitHub telling the dispatcher a job was queued, so it does not
 * wait for its next poll to find out.
 *
 * Under all-JIT nothing starts until the dispatcher sees a job, and a poll sees
 * it up to one cadence late. Measured 2026-11-11..13 over 4,914 jobs: first
 * sight was flat from ~2 s to ~17 s after creation (p50 10 s) — the 15 s
 * dispatch timer plus ~2 s before GitHub's `?status=queued` listing shows a new
 * run. That wait is pure discovery; the mint after it took about a second.
 *
 * A hint is a POINTER, not evidence. It names a run; the dispatch tick reads
 * that run's jobs from GitHub (the same jobs probe every polled candidate gets)
 * and mints only for a job GitHub still reports queued. A forged, replayed or
 * late hint therefore costs one conditional read and mints nothing. That is why
 * the hinted run is probed directly rather than waited for in the listing: the
 * listing is the laggy read, and the jobs read is the one that decides anyway.
 *
 * The poll stays. A hint that never arrives (webhook down, App not subscribed,
 * delivery dropped) leaves the fleet exactly where it was before hints existed.
 */

/** A hint outlives this, then the poll alone is responsible for its run. */
export const HINT_TTL_MS = 120_000;

/** Bound on live hints: a flood of forged-but-signed or replayed deliveries
 *  cannot grow this map, and the oldest are what the poll covers anyway. */
export const MAX_HINTS = 200;

export interface DispatchHint {
	repo: string;
	runId: number;
	jobId: number;
	/** The job's own `created_at`, epoch ms — what the age gates measure from. */
	createdAtMs: number;
	receivedAtMs: number;
}

const hints = new Map<string, DispatchHint>();

export const hintKey = (repo: string, runId: number): string => `${repo}#${runId}`;

const stats = {
	received: 0,
	accepted: 0,
	ignored: {} as Record<string, number>,
	lastAcceptedAt: null as string | null,
	/** Delivery lag of the last accepted hint: receipt minus the job's creation. */
	lastDeliveryLagSec: null as number | null,
	/** `completed` deliveries naming a JIT runner: the reap's input. */
	finished: 0,
};

export type HintVerdict =
	{ accepted: true; hint: DispatchHint } | { accepted: false; reason: string };

function ignore(reason: string): HintVerdict {
	stats.ignored[reason] = (stats.ignored[reason] ?? 0) + 1;
	return { accepted: false, reason };
}

/**
 * Read one `workflow_job` delivery's parsed body. Only `queued` on a
 * self-hosted label set is a hint: anything else is a hosted job, or a job
 * that already has a runner, and the dispatcher has nothing to do for it.
 * Whether the repo is one the fleet serves is the tick's question — it polls
 * only `input.repos`, so a hint for any other repo simply never matches.
 */
export function recordWorkflowJobHint(payload: unknown, nowMs = Date.now()): HintVerdict {
	stats.received++;
	const p = payload as {
		action?: unknown;
		repository?: { full_name?: unknown };
		workflow_job?: {
			id?: unknown;
			run_id?: unknown;
			labels?: unknown;
			created_at?: unknown;
			runner_name?: unknown;
		};
	} | null;
	if (!p || typeof p !== 'object') return ignore('not-an-object');
	if (p.action === 'completed') recordFinishedRunner(p.workflow_job, nowMs);
	if (p.action !== 'queued') return ignore(`action:${String(p.action)}`);
	const j = p.workflow_job;
	const repo = p.repository?.full_name;
	if (typeof repo !== 'string' || !j) return ignore('malformed');
	if (typeof j.id !== 'number' || typeof j.run_id !== 'number') return ignore('malformed');
	const labels = Array.isArray(j.labels) ? j.labels : [];
	if (!labels.includes('self-hosted')) return ignore('not-self-hosted');
	const createdAtMs = typeof j.created_at === 'string' ? Date.parse(j.created_at) : NaN;
	if (!Number.isFinite(createdAtMs)) return ignore('malformed');

	pruneHints(nowMs);
	const hint: DispatchHint = {
		repo,
		runId: j.run_id,
		jobId: j.id,
		createdAtMs,
		receivedAtMs: nowMs,
	};
	// One run, many jobs: keep the OLDEST job's creation, so the age gates never
	// judge a run younger than its longest-waiting job.
	const prev = hints.get(hintKey(repo, j.run_id));
	if (prev && prev.createdAtMs <= createdAtMs) hint.createdAtMs = prev.createdAtMs;
	hints.delete(hintKey(repo, j.run_id));
	hints.set(hintKey(repo, j.run_id), hint);
	while (hints.size > MAX_HINTS) hints.delete(hints.keys().next().value!);

	stats.accepted++;
	stats.lastAcceptedAt = new Date(nowMs).toISOString();
	stats.lastDeliveryLagSec = Math.round((nowMs - createdAtMs) / 100) / 10;
	return { accepted: true, hint };
}

/**
 * FINISHED RUNNERS: GitHub saying a job is over, by the runner that ran it.
 *
 * A JIT unit is supposed to exit when its one job ends, but it ends on the
 * RUNNER's word, and a starved runner can lose that word. On 2026-11-21 three
 * hokon units were throttled at ci-runner.slice's MemoryHigh until GitHub
 * logged "The self-hosted runner lost communication with the server" and closed
 * their jobs (08:06-08:09Z). The units ran on until 09:06:45Z: the cancelled
 * step until 08:28, then `Post Run actions/checkout` for 33 minutes, holding
 * the memory that froze cardtable's prod server. GitHub had already removed
 * the ephemeral registrations, so the reap, which walks registrations, never
 * saw them.
 *
 * Keyed by runner NAME, not job id: GitHub may hand a JIT runner a different
 * job than the one it was minted for (lane steals), and the name is what the
 * unit is called. The reap stops a live unit named here once
 * FINISHED_UNIT_GRACE_MS has passed (ephemeral-exec-reap.ts).
 */
export const FINISHED_TTL_MS = 24 * 60 * 60_000;
export const MAX_FINISHED = 500;
const finished = new Map<string, number>();

function recordFinishedRunner(j: { runner_name?: unknown } | undefined, nowMs: number): void {
	const name = j?.runner_name;
	if (typeof name !== 'string' || !name.startsWith('jit-')) return;
	stats.finished++;
	finished.delete(name);
	finished.set(name, nowMs);
	while (finished.size > MAX_FINISHED) finished.delete(finished.keys().next().value!);
}

/** Runner name -> when GitHub said its job completed, epoch ms. */
export function finishedRunners(nowMs: number): ReadonlyMap<string, number> {
	for (const [k, t] of finished) if (nowMs - t > FINISHED_TTL_MS) finished.delete(k);
	return finished;
}

/** Its unit is gone, by the reap's hand or its own. */
export function forgetFinishedRunner(name: string): void {
	finished.delete(name);
}

export function pruneHints(nowMs: number): void {
	for (const [k, h] of hints) if (nowMs - h.receivedAtMs > HINT_TTL_MS) hints.delete(k);
}

/** Live hints, oldest first. */
export function liveHints(nowMs: number): DispatchHint[] {
	pruneHints(nowMs);
	return [...hints.values()];
}

/** The run is in the listing now, or GitHub says nothing of it is waiting. */
export function dropHint(repo: string, runId: number): void {
	hints.delete(hintKey(repo, runId));
}

export interface HintStats {
	live: number;
	received: number;
	accepted: number;
	ignored: Record<string, number>;
	lastAcceptedAt: string | null;
	lastDeliveryLagSec: number | null;
	finished: number;
}

export function hintStats(nowMs = Date.now()): HintStats {
	pruneHints(nowMs);
	return { live: hints.size, ...stats, ignored: { ...stats.ignored } };
}

/** Tests only. */
export function __resetHintsForTesting(): void {
	hints.clear();
	finished.clear();
	stats.finished = 0;
	stats.received = 0;
	stats.accepted = 0;
	stats.ignored = {};
	stats.lastAcceptedAt = null;
	stats.lastDeliveryLagSec = null;
}
