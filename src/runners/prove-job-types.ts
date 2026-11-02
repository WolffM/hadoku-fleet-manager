/**
 * The shared shapes of `prove-job.ts` (wave 5o lane D split, pure move): the
 * spec a caller hands in, the ports it is run against, and the result it
 * hands back. No logic lives here — see `prove-job.ts` for the orchestration,
 * `prove-job-parse.ts` for the pure naming/parsing helpers, and
 * `prove-job-record.ts` for turning a result into a `$proof` record.
 *
 * WAVE CLEAN2 LANE B: `GhLike`/`ShellLike` come from `fleet-vocabulary.ts`
 * (config), not `ephemeral-exec.ts` (ci-scheduling) — moving just the TYPE
 * closed that edge
 * (`docs/planning/wave-clean2-2026-11-01.md`). `ProveDeps.gh`/`.sh` are the
 * only ci-scheduling-shaped ports this file still needs; `prove-job.ts`
 * itself still calls `ephemeral-exec.ts`'s real mint functions directly — a
 * `MintPort`-style indirection was designed but not landed; see this wave's
 * report for why (every call site that could construct the real adapter is
 * itself classified `domain` by `layer-map.json`, so the edge only
 * relocates, it does not close).
 */
import type { ManifestNode } from '../lib/capability-registry.js';
import type { GhLike, ShellLike } from '../lib/fleet-vocabulary.js';
// prove-job-parse's two naming names. JIT_PREFIX/jitRunnerName are config
// (wave clean-1 lane C, cut (iii) — src/lib/jit-naming.ts).

/** A retry of the WHOLE dispatch is bounded; this is the ceiling, not the default. */
export const MAX_ATTEMPTS_CEILING = 6;
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Read-only GitHub, plus the raw-text read a job log needs. Both THROW on failure. */
export interface ProofGh extends GhLike {
	get: (path: string, token: string, repo?: string) => Promise<unknown>;
	text: (path: string, token: string, repo?: string, accept?: string) => Promise<string>;
}

export interface ProveSpec {
	node: string;
	repo: string;
	workflow: string;
	job: string;
	ref: string;
	/** Case-insensitive regex for the log lines that show the capability ran. */
	evidence?: string;
	/** Replaces the labels read from the workflow. Scoped to THIS proof runner only. */
	labelsOverride?: string[];
	/** The capability this proves; the node must carry it. Omitted for an ad-hoc job. */
	capability?: string;
	/**
	 * `workflow_dispatch` inputs, sent verbatim in the dispatch body's `inputs`
	 * — a targeted canary (e.g. jdk21's fixed cardtable Forge specs) instead of
	 * the workflow's full default. Omitted entirely when empty/undefined, so a
	 * workflow with no `inputs:` declared at all is never sent one.
	 */
	inputs?: Record<string, string>;
	/**
	 * The dispatch input that sets the job's `runs-on` (a JSON label array). When
	 * set, the proof runner also carries a label unique to this proof, and that
	 * full set is sent as this input: only the proof runner can take the job.
	 */
	runsOnInput?: string;
	/** Dispatch on a throwaway `canary/<node>-<nonce>` branch at `ref`'s head — see `JobProof.scratchBranch`. */
	scratchBranch?: boolean;
	maxAttempts?: number;
	/** Tear down a proof runner a previous (crashed) run left LIVE, instead of refusing. */
	reapStale?: boolean;
	/** Whole-run bound. */
	timeoutMs?: number;
	/** How long a dispatched job may sit unassigned before it counts as a miss. */
	assignTimeoutMs?: number;
	/** How long a job that DID land on the proof runner may run. */
	jobTimeoutMs?: number;
}

export interface ProveDeps {
	gh: ProofGh;
	sh: ShellLike;
	/** The node's manifest entry. READ ONLY — frozen in the tests. */
	node: ManifestNode;
	/** Is the node held out of service? Read by the caller from the drain file. */
	drained: boolean;
	now: () => number;
	/** Resolves after `ms`, or rejects if `signal` aborts first. */
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	signal?: AbortSignal;
	/** The node's ci user's home (`nodeHome(machine, 'ci')`). Required: a default would be a literal in a library. */
	homeDir: string;
	pollMs?: number;
}

export type ProofVerdict =
	'pass' | 'fail' | 'lost-race' | 'refused' | 'timeout' | 'error' | 'teardown-failed';

export interface ProofFinding {
	rule: string;
	message: string;
}

export interface ProofAttempt {
	attempt: number;
	runId: number | null;
	jobId: number | null;
	runnerName: string | null;
	jobConclusion: string | null;
	ranOnTarget: boolean;
	note?: string;
}

export interface RunnerTeardown {
	name: string;
	unitStopped: boolean;
	configGone: boolean;
	listenerGone: boolean;
	deregistered: boolean;
}

export interface ProofResult {
	ok: boolean;
	verdict: ProofVerdict;
	node: string;
	repo: string;
	workflow: string;
	job: string;
	ref: string;
	/** The branch actually dispatched on: `ref`, or the scratch branch made from it. */
	dispatchRef: string | null;
	capability: string | null;
	labels: string[];
	labelSource: 'runs-on' | 'override' | null;
	runId: number | null;
	jobId: number | null;
	jobConclusion: string | null;
	runnerName: string | null;
	/** Wall time the job itself ran, from the jobs API's own `started_at`/`completed_at` — null when either is missing. Never the whole proof's orchestration time (minting, polling, teardown). */
	durationSec: number | null;
	ranOnTarget: boolean;
	attempts: ProofAttempt[];
	evidence: string[];
	findings: ProofFinding[];
	minted: string[];
	staleCleaned: string[];
	teardown: {
		ok: boolean;
		runners: RunnerTeardown[];
		cancelledRuns: number[];
		problems: string[];
	};
	startedAt: string;
	finishedAt: string;
}

export interface Owned {
	name: string;
	unit: string;
	slotIndex: number;
	slot: string;
}

export interface RunRow {
	id: number;
	status?: string;
	conclusion?: string | null;
}

export interface JobRow {
	id: number;
	name: string;
	status?: string;
	conclusion?: string | null;
	runner_name?: string | null;
	/** When the job was QUEUED. Never read for duration: a busy runner's queue is not the node's time. */
	created_at?: string | null;
	/** The jobs API's own wall-clock bounds — read, never computed from poll timing. */
	started_at?: string | null;
	completed_at?: string | null;
}

/**
 * Wall time the job ran, from the API's own timestamps. Null if either is missing
 * or unparseable. `started_at`, never `created_at`: a job that queued for a
 * runner says nothing about the node in that wait.
 */
export function jobDurationSec(job: JobRow | null | undefined): number | null {
	if (!job?.started_at || !job?.completed_at) return null;
	const start = Date.parse(job.started_at);
	const end = Date.parse(job.completed_at);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	return Math.round((end - start) / 1000);
}

export class Abort extends Error {}
export class Unreadable extends Error {}

export const sq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

export interface ListedRunner {
	id: number;
	name: string;
	busy?: boolean;
	status?: string;
	labels?: { name: string }[];
}
