/**
 * PROVE A JOB ON A NODE — run one real workflow job on a named node and read
 * back, from GitHub, where it actually ran.
 *
 * WHY THIS EXISTS (wave 3q lane E, 2026-09-30)
 * --------------------------------------------
 * `taskauto` is `verify: 'role'`: assigned, so no probe can settle it, and the
 * job that exercises it (`hadoku-tenhands`' `backend pytest`) needs an Actions
 * SECRET that lives only in GitHub. The only honest proof is a workflow run, and
 * a workflow run goes wherever GitHub sends it — the job asks for
 * `[self-hosted, pm2-host, taskauto]`, the claw does not carry `pm2-host` (and
 * must not; that is #6's routing decision), and hokon, which does, wins.
 * Wave 3p aimed one run at claw-8 by a HAND recipe. The operator rejected a
 * recipe: "the whole point of this system is for fleet-manager to provision my
 * claws". This is that recipe, built on the machinery that already mints.
 *
 * WHAT IS REUSED, AND THE ONE SEAM
 * --------------------------------
 * The mint is `mintEphemeralRunner` — slot preparation, `generate-jitconfig`,
 * the DisableUpdate/Ephemeral assertion, the 0600 config, the transient unit in
 * `runners.slice` — called exactly as the dispatcher calls it. The seam is that
 * `MintRequest.labels` is ALREADY per call, so a proof runner carries the label
 * set the target job asks for without the manifest, the node's offer
 * (`nodeOffer`) or the routing of any real job being touched. The manifest node
 * is treated as READ-ONLY here and a test freezes it.
 *
 * THE NAME IS `jit-<node>-proof-<repo>-j0-r0-<epoch>`, AND THAT IS THE ANSWER TO
 * "DOES THE REAP SWEEP PROTECT IT?". `reapJitRunners` keys on the `jit-` prefix,
 * and keeps a registration that is busy, that has a LIVE unit of the same name,
 * or whose mint epoch is inside the grace. A `jit-` name therefore is protected
 * for exactly its bounded lifetime — while the unit lives or a job is on it — and
 * is REAPED AFTER THE GRACE if a crash strands the registration with no unit
 * behind it, so a leak has a backstop. The 3p recipe's non-`jit-` name was
 * invisible to the sweep, which is also why nothing would ever have cleaned it
 * up. `j0-r0` parse as a run id no real run has, so the dispatcher's in-flight
 * reconstruction (`parseJitName`) neither blocks nor is confused by it. The unit
 * and the registration count against the node's `maxConcurrent`, which is honest:
 * the proof spends a slot and real memory.
 *
 * THE RACE, HONESTLY
 * ------------------
 * Two runners match, GitHub picks. There is no way to direct it (hokon is a
 * guest and is never touched), so: dispatch, read the job's `runner_name` from
 * the API, and if it was not ours cancel that run and try again — up to a hard
 * cap. A job that concluded `success` on the WRONG runner is a `lost-race`,
 * never a pass. `ranOnTarget` is read from the job object and from nothing else.
 *
 * NOTHING HERE DECIDES "HEALTHY" BY SILENCE
 * -----------------------------------------
 * Every unreadable thing — the workflow file, the runs listing, the job, the log,
 * the node — is a FINDING carrying its reason and a non-pass verdict. Teardown
 * runs on every path including abort, and what it could not verify is a finding
 * of its own: a leaked registration is a runner GitHub will schedule onto with
 * nothing behind it.
 *
 * STANDING MODE — A GUEST'S OWN RUNNER (2026-10-10)
 * -------------------------------------------------
 * "lets have hokon earn it now" (operator, 2026-10-10). hokon is a GUEST: no
 * JIT mint, no ssh, no drain, ever. In production it would run jdk21 work on
 * its STANDING per-repo registration (named after the node, a systemd --user
 * unit under ~/runners, labels synced by runner-health's backstop) — so a JIT
 * proof minted there would test a path production never takes, in a different
 * environment. Standing mode proves the registration production uses instead,
 * through the GitHub API ALONE:
 *
 *   - only with `includeGuests` (CLI `--include-guests`), which is valid only
 *     for a guest node; without it every guest refusal stands unchanged.
 *   - the registration named exactly like the node, online, in the canary repo.
 *     Offline is the only admission refusal: production work is never stopped.
 *   - the proof label is ADDED to it (additive POST — the backstop's own label
 *     writes are additive POST / targeted DELETE too, so neither erases the
 *     other) and the aimed canary is dispatched with `runs_on` =
 *     `["self-hosted", <proof label>]`: only that registration can take it.
 *   - the label is REMOVED on every path and the removal VERIFIED from the API;
 *     a removal that fails is a teardown finding. A leftover label routes
 *     nothing, but an unreported one is how state drifts.
 *   - the runner may be busy with production work, so the job may queue. That
 *     is not charged: `durationSec` is the job's own `started_at`→`completed_at`
 *     and the job timeout starts at assignment.
 *   - `sh` is never called. The transport keeps refusing guests; nothing here
 *     needed it opened.
 *
 * PURE ORCHESTRATION OVER INJECTED PORTS. `gh`, `sh`, the clock and the sleeper
 * are parameters, so the order of operations — where the leaks live — is tested
 * without a node or a token. `scripts/prove-job.mjs` is the real wiring.
 */

import {
	capability,
	judgeWorkloadProof,
	nodeOffer,
	proofBudget,
	type Capability,
	type JobProof,
	type ManifestNode,
} from '../capabilities.js';
import type { ProofRecord } from '../lib/measured.js';
import { isGuestNode } from '../lib/node-role.js';
import {
	JIT_PREFIX,
	JIT_UNIT_MAX_SEC,
	admitMint,
	jitRunnerName,
	slotDir,
	unitMemoryMaxMb,
} from './ephemeral.js';
import {
	liveJitSlots,
	liveJitUnits,
	mintEphemeralRunner,
	runnerTarballUrl,
	type GhLike,
	type ShellLike,
} from './ephemeral-exec.js';
import { jobKind } from '../lib/job-kind.js';

/** GitHub calls here go through the operator's own `gh` auth, never a token we hold. */
const NO_TOKEN = '';

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
	/**
	 * The operator's explicit opt-in to prove a GUEST, through its standing
	 * registration (see the header). Valid only for a guest node: on a claw it is
	 * refused, and without it a guest is refused exactly as before.
	 */
	includeGuests?: boolean;
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
	/** The node user's home. Required: a default here would be a hostname-shaped literal in a library. */
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

/** Standing mode: the proof label added to a standing registration, and whether it is gone again. */
export interface LabelTeardown {
	runner: string;
	runnerId: number;
	label: string;
	removed: boolean;
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
	/** `jit`: a minted proof runner. `standing`: a guest's own registration, labelled for the proof. */
	mode: 'jit' | 'standing';
	/** Standing mode: the registration proven. Null in jit mode. */
	standingRunner: { id: number; name: string } | null;
	/** The branch actually dispatched on: `ref`, or the scratch branch made from it. */
	dispatchRef: string | null;
	capability: string | null;
	labels: string[];
	labelSource: 'runs-on' | 'override' | 'standing' | null;
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
		labels: LabelTeardown[];
		cancelledRuns: number[];
		problems: string[];
	};
	startedAt: string;
	finishedAt: string;
}

// --- pure helpers -----------------------------------------------------------

/** `owner/repo` -> `repo`, narrowed to what a unit name admits. */
function repoSlug(repo: string): string {
	return repo
		.split('/')
		.pop()!
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, '-');
}

/**
 * The proof runner's name. `proof-` inside the slug is what `isProofRunnerName`
 * keys on; `j0-r0` is a run id no real run has (see the header).
 */
export function proofRunnerName(node: string, repo: string, nowMs: number): string {
	return jitRunnerName(node, `x/proof-${repoSlug(repo)}`, nowMs, 0, 0);
}

/** Is this a proof runner minted for `node`? Stricter than a prefix: a real mint never ends `-j0-r0-`. */
/** A label unique to one proof, so an aimed canary can land nowhere else. */
export function proofLabel(nowMs: number): string {
	return `proof-${nowMs.toString(36)}`;
}

/** The throwaway branch a scratch-branch canary is dispatched on. */
export function scratchBranchName(node: string, nowMs: number): string {
	return `canary/${node}-${nowMs.toString(36)}`;
}

/**
 * The `workflow_dispatch` body. `inputs` only when there is one — a workflow
 * with no `inputs:` declared must see the body it has always seen — and the
 * runs-on input, when the spec names one, carries the proof runner's labels.
 */
export function dispatchBody(
	spec: Pick<ProveSpec, 'ref' | 'inputs' | 'runsOnInput'>,
	labels: readonly string[]
): { ref: string; inputs?: Record<string, string> } {
	const inputs: Record<string, string> = { ...(spec.inputs ?? {}) };
	if (spec.runsOnInput) inputs[spec.runsOnInput] = JSON.stringify(labels);
	return Object.keys(inputs).length ? { ref: spec.ref, inputs } : { ref: spec.ref };
}

export function isProofRunnerName(name: string, node: string): boolean {
	return (
		name.startsWith(`${JIT_PREFIX}${node}-proof-`) &&
		/-j0-r0-\d+$/.test(name.replace(/\.service$/, ''))
	);
}

/** Drop a trailing `# comment` that is not inside quotes. Workflow `runs-on` lines are simple. */
function stripComment(line: string): string {
	let q: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (q) {
			if (c === q) q = null;
		} else if (c === '"' || c === "'") q = c;
		else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
	}
	return line;
}

const unquote = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2');

export type RunsOn = { ok: true; labels: string[]; jobKey: string } | { ok: false; reason: string };

/**
 * The `runs-on` labels of ONE job, read from the workflow text.
 *
 * Deliberately not a YAML parser: this package has no dependencies, and a
 * workflow's `runs-on` is a scalar, a flow list or a block list. Anything else —
 * an expression (`${{ fromJSON(vars.CI_RUNNER) }}`), a `group:` map — is REFUSED
 * with a reason, because guessing the label set would mint a runner the job
 * cannot land on and report it as a lost race. The caller's `--labels-override`
 * is the explicit way out.
 */
export function runsOnForJob(yaml: string, jobName: string): RunsOn {
	const lines = yaml.split('\n').map(stripComment);
	const jobsAt = lines.findIndex((l) => /^jobs\s*:\s*$/.test(l));
	if (jobsAt === -1) return { ok: false, reason: 'the workflow has no top-level `jobs:`' };
	const indentOf = (l: string): number => l.length - l.trimStart().length;
	const blank = (l: string): boolean => l.trim() === '';
	let keyIndent = -1;
	const blocks: { key: string; body: string[] }[] = [];
	for (let i = jobsAt + 1; i < lines.length; i++) {
		const l = lines[i];
		if (blank(l)) continue;
		if (indentOf(l) === 0) break;
		if (keyIndent === -1) keyIndent = indentOf(l);
		if (indentOf(l) === keyIndent) {
			const m = /^\s*([\w.-]+)\s*:/.exec(l);
			if (m) blocks.push({ key: m[1], body: [] });
			continue;
		}
		blocks[blocks.length - 1]?.body.push(l);
	}
	const hit = blocks.find((b) => {
		const nm = b.body.find((l) => indentOf(l) === keyIndent + 2 && /^\s*name\s*:/.test(l));
		return (
			b.key === jobName || (nm !== undefined && unquote(nm.replace(/^\s*name\s*:/, '')) === jobName)
		);
	});
	if (!hit) {
		return {
			ok: false,
			reason: `no job named "${jobName}" in the workflow (jobs: ${blocks.map((b) => b.key).join(', ') || 'none'})`,
		};
	}
	const at = hit.body.findIndex((l) => indentOf(l) === keyIndent + 2 && /^\s*runs-on\s*:/.test(l));
	if (at === -1) return { ok: false, reason: `job "${jobName}" has no \`runs-on\`` };
	const inline = hit.body[at].replace(/^\s*runs-on\s*:/, '').trim();
	let raw: string[];
	if (inline.startsWith('[')) {
		const end = inline.indexOf(']');
		if (end === -1)
			return { ok: false, reason: '`runs-on` is a flow list this reader cannot parse' };
		raw = inline.slice(1, end).split(',');
	} else if (inline) raw = [inline];
	else {
		raw = [];
		for (let i = at + 1; i < hit.body.length; i++) {
			const l = hit.body[i];
			if (blank(l)) continue;
			if (indentOf(l) <= keyIndent + 2) break;
			const m = /^\s*-\s*(.+)$/.exec(l);
			if (!m)
				return {
					ok: false,
					reason: '`runs-on` is a map (group/labels) this reader does not resolve',
				};
			raw.push(m[1]);
		}
	}
	const labels = raw.map(unquote).filter(Boolean);
	if (!labels.length) return { ok: false, reason: '`runs-on` is empty' };
	const dynamic = labels.find((x) => x.includes('${{'));
	if (dynamic) {
		return {
			ok: false,
			reason: `\`runs-on\` is an expression (${dynamic}) that only GitHub can resolve — pass the labels with --labels-override`,
		};
	}
	return { ok: true, labels: [...new Set(labels)], jobKey: hit.key };
}

/** Does the workflow accept `workflow_dispatch`? Read from the `on:` section only. */
export function isDispatchable(yaml: string): boolean {
	const head = yaml.split('\n').map(stripComment);
	const jobsAt = head.findIndex((l) => /^jobs\s*:/.test(l));
	const on = (jobsAt === -1 ? head : head.slice(0, jobsAt)).join('\n');
	return /(^|[\s[,])workflow_dispatch\s*(:|,|\]|$)/m.test(on);
}

/**
 * The log lines that show the capability was EXERCISED.
 *
 * Timestamps are stripped so the evidence reads as the job printed it, and lines
 * are de-duplicated and truncated so a chatty job cannot bloat the JSON past the
 * 8 KB pipe cliff (`keepStdoutWhole` copes, but a consumer reading a file should
 * not have to).
 */
export function extractEvidence(log: string, pattern: string, max = 40): string[] {
	const re = new RegExp(pattern, 'i');
	const seen = new Set<string>();
	for (const raw of log.split(/\r?\n/)) {
		const line = raw.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').trim();
		if (line && re.test(line)) seen.add(line.length > 300 ? `${line.slice(0, 300)}…` : line);
		if (seen.size >= max) break;
	}
	return [...seen];
}

/** Resolve the job a capability declares, with an explicit operator override winning per field. */
export function specFromCapability(
	capabilityId: string,
	over: Partial<ProveSpec> & { node: string }
): { ok: true; spec: ProveSpec } | { ok: false; reason: string } {
	const cap = capability(capabilityId);
	if (!cap) return { ok: false, reason: `"${capabilityId}" is not a registered capability` };
	const p: JobProof | undefined = cap.jobProof;
	if (!p) {
		return {
			ok: false,
			reason: `capability "${capabilityId}" declares no jobProof — name the job with --repo/--workflow/--job`,
		};
	}
	return {
		ok: true,
		spec: {
			repo: over.repo ?? p.repo,
			workflow: over.workflow ?? p.workflow,
			job: over.job ?? p.job,
			ref: over.ref ?? p.ref ?? 'main',
			evidence: over.evidence ?? p.evidence,
			inputs: over.inputs ?? p.inputs,
			...(p.runsOn ? { labelsOverride: p.runsOn.labels, runsOnInput: p.runsOn.input } : {}),
			...(p.scratchBranch ? { scratchBranch: true } : {}),
			...over,
			capability: capabilityId,
		},
	};
}

// --- orchestration ----------------------------------------------------------

interface Owned {
	name: string;
	unit: string;
	slotIndex: number;
	slot: string;
}

interface RunRow {
	id: number;
	status?: string;
	conclusion?: string | null;
}

interface JobRow {
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
 * or unparseable. `started_at`, never `created_at`: a standing runner busy with
 * production work queues the canary, and that wait says nothing about the node.
 */
function jobDurationSec(job: JobRow | null | undefined): number | null {
	if (!job?.started_at || !job?.completed_at) return null;
	const start = Date.parse(job.started_at);
	const end = Date.parse(job.completed_at);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	return Math.round((end - start) / 1000);
}

class Abort extends Error {}
class Unreadable extends Error {}

const sq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

/** Standing mode: how long the canary may queue behind the guest's own production work. */
export const STANDING_ASSIGN_TIMEOUT_MS = 20 * 60_000;

interface ListedRunner {
	id: number;
	name: string;
	busy?: boolean;
	status?: string;
	labels?: { name: string }[];
}

export async function proveJob(spec: ProveSpec, d: ProveDeps): Promise<ProofResult> {
	const started = d.now();
	const home = d.homeDir;
	const pollMs = d.pollMs ?? 4_000;
	// Decided once, here, and only for a guest the operator explicitly opted in.
	const standing = isGuestNode(d.node) && spec.includeGuests === true;
	// Standing, the proof label is unique to this run and only one registration
	// carries it: a retry would ask the same registration the same question.
	const maxAttempts = standing
		? 1
		: Math.min(
				Math.max(1, Math.floor(spec.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)),
				MAX_ATTEMPTS_CEILING
			);
	const deadline = started + (spec.timeoutMs ?? 40 * 60_000);
	const assignMs = spec.assignTimeoutMs ?? (standing ? STANDING_ASSIGN_TIMEOUT_MS : 120_000);
	const jobMs = spec.jobTimeoutMs ?? 25 * 60_000;

	const r: ProofResult = {
		ok: false,
		verdict: 'error',
		node: spec.node,
		repo: spec.repo,
		workflow: spec.workflow,
		job: spec.job,
		ref: spec.ref,
		mode: standing ? 'standing' : 'jit',
		standingRunner: null,
		dispatchRef: null,
		capability: spec.capability ?? null,
		labels: [],
		labelSource: null,
		runId: null,
		jobId: null,
		jobConclusion: null,
		runnerName: null,
		durationSec: null,
		ranOnTarget: false,
		attempts: [],
		evidence: [],
		findings: [],
		minted: [],
		staleCleaned: [],
		teardown: { ok: true, runners: [], labels: [], cancelledRuns: [], problems: [] },
		startedAt: new Date(started).toISOString(),
		finishedAt: '',
	};
	const find = (rule: string, message: string): void => void r.findings.push({ rule, message });
	const owned: Owned[] = [];
	/** Standing mode: proof labels this run added (or tried to add) to a standing registration. */
	const ownedLabels: { runnerId: number; runner: string; label: string }[] = [];
	const dispatched = new Set<number>();
	let scratch: string | null = null;
	const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

	// Teardown must not itself be abortable: the signal is WHY it is running.
	let tornDown = false;
	const checkAbort = (): void => {
		if (!tornDown && d.signal?.aborted) throw new Abort('aborted by signal');
	};
	const nap = async (ms: number): Promise<void> => {
		checkAbort();
		try {
			await d.sleep(ms, tornDown ? undefined : d.signal);
		} catch (e) {
			// A sleeper rejects when the signal fires; that is an abort, not a fault.
			checkAbort();
			throw e;
		}
		checkAbort();
	};
	/** One read, retried once, carrying the reason. "I could not look" is never a pass. */
	const read = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
		try {
			return await fn();
		} catch (first) {
			checkAbort();
			await nap(1_000);
			try {
				return await fn();
			} catch (second) {
				throw new Unreadable(`${what}: ${why(second)} (first attempt: ${why(first)})`);
			}
		}
	};
	const listRunners = async (): Promise<ListedRunner[]> => {
		const res = (await read('runner listing', () =>
			d.gh.get('/actions/runners?per_page=100', NO_TOKEN, spec.repo)
		)) as { runners?: ListedRunner[] } | null;
		if (!res || !Array.isArray(res.runners))
			throw new Unreadable('runner listing: no `runners` array');
		return res.runners;
	};

	/** Teardown, once. Never throws; what it could not do is recorded, loudly. */
	const teardown = async (): Promise<void> => {
		if (tornDown) return;
		tornDown = true;
		const td = r.teardown;
		const problem = (m: string): void => {
			td.ok = false;
			td.problems.push(m);
			find('teardown-failed', m);
		};
		// 1. A run we dispatched that is still going holds the workflow's concurrency
		//    group and, worse, may still be using the proof runner.
		for (const id of dispatched) {
			try {
				const run = (await d.gh.get(`/actions/runs/${id}`, NO_TOKEN, spec.repo)) as RunRow | null;
				if (run?.status && run.status !== 'completed') {
					const res = await d.gh.write(
						'POST',
						`/actions/runs/${id}/cancel`,
						NO_TOKEN,
						undefined,
						spec.repo
					);
					if (!res.ok && res.status !== 409)
						problem(`could not cancel run ${id}: HTTP ${res.status}`);
					else td.cancelledRuns.push(id);
				}
			} catch (e) {
				problem(`could not read or cancel run ${id}: ${why(e)}`);
			}
		}
		// 1b. The scratch branch. Deleted even when a run on it was just cancelled:
		//     a cancelled run keeps its record, and a left branch is litter in the repo.
		if (scratch) {
			try {
				const res = await d.gh.write(
					'DELETE',
					`/git/refs/heads/${scratch}`,
					NO_TOKEN,
					undefined,
					spec.repo
				);
				if (!res.ok && res.status !== 404 && res.status !== 422)
					problem(`could not delete the scratch branch ${scratch}: HTTP ${res.status}`);
			} catch (e) {
				problem(`could not delete the scratch branch ${scratch}: ${why(e)}`);
			}
		}
		// 1c. Standing mode: the proof label comes off the guest's registration,
		//     and is VERIFIED gone from the API. 404 is "already gone".
		if (ownedLabels.length) {
			for (const l of ownedLabels) {
				const t: LabelTeardown = {
					runner: l.runner,
					runnerId: l.runnerId,
					label: l.label,
					removed: false,
				};
				td.labels.push(t);
				try {
					const res = await d.gh.write(
						'DELETE',
						`/actions/runners/${l.runnerId}/labels/${encodeURIComponent(l.label)}`,
						NO_TOKEN,
						undefined,
						spec.repo
					);
					if (!res.ok && res.status !== 404)
						problem(`could not remove proof label ${l.label} from ${l.runner}: HTTP ${res.status}`);
				} catch (e) {
					problem(`could not remove proof label ${l.label} from ${l.runner}: ${why(e)}`);
				}
			}
			try {
				const after = await listRunners();
				for (const t of td.labels) {
					const reg = after.find((x) => x.id === t.runnerId);
					t.removed = !(reg?.labels ?? []).some((x) => x.name === t.label);
					if (!t.removed)
						problem(`LEFTOVER: ${t.runner} still carries proof label ${t.label} in ${spec.repo}`);
				}
			} catch (e) {
				problem(`could not verify the proof label is gone from the standing runner: ${why(e)}`);
			}
		}
		// 2. The node: stop the unit, remove any staged config, prove both from the node.
		for (const o of owned) {
			const t: RunnerTeardown = {
				name: o.name,
				unitStopped: false,
				configGone: false,
				listenerGone: false,
				deregistered: false,
			};
			td.runners.push(t);
			const cfg = `${o.slot}/.jitconfig`;
			const out = await d.sh(
				spec.node,
				[
					`XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop ${sq(o.unit)} 2>/dev/null`,
					`rm -f ${sq(cfg)}`,
					`if XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active --quiet ${sq(o.unit)}; then echo UNIT-ACTIVE; else echo UNIT-GONE; fi`,
					`if [ -e ${sq(cfg)} ]; then echo CFG-PRESENT; else echo CFG-GONE; fi`,
					`if pgrep -f ${sq(`jit/slot${o.slotIndex}/bin/Runner\\.Listener`)} >/dev/null 2>&1; then echo LISTENER-UP; else echo LISTENER-GONE; fi`,
					'true',
				].join('\n')
			);
			if (out === null) {
				problem(
					`could not reach ${spec.node} to tear down ${o.name} — its unit may still be running`
				);
			} else {
				t.unitStopped = out.includes('UNIT-GONE');
				t.configGone = out.includes('CFG-GONE');
				t.listenerGone = out.includes('LISTENER-GONE');
				if (!t.unitStopped) problem(`unit ${o.unit} is still active on ${spec.node} after stop`);
				if (!t.configGone) problem(`${cfg} is still staged on ${spec.node}`);
				if (!t.listenerGone)
					problem(`a Runner.Listener is still running in slot${o.slotIndex} on ${spec.node}`);
			}
		}
		// 3. GitHub: an ephemeral runner deregisters itself after its job, so give it a
		//    moment, then delete whatever is left and VERIFY from the API.
		if (owned.length) {
			const names = new Set(owned.map((o) => o.name));
			try {
				let left: { id: number; name: string }[] = [];
				for (let i = 0; i < 6; i++) {
					left = (await listRunners()).filter((x) => names.has(x.name));
					if (!left.length) break;
					if (i < 2) await nap(3_000);
					else break;
				}
				for (const x of left) {
					const res = await d.gh.write(
						'DELETE',
						`/actions/runners/${x.id}`,
						NO_TOKEN,
						undefined,
						spec.repo
					);
					if (!res.ok && res.status !== 404)
						problem(`could not deregister ${x.name}: HTTP ${res.status}`);
				}
				const after = (await listRunners()).filter((x) => names.has(x.name));
				for (const t of td.runners) t.deregistered = !after.some((x) => x.name === t.name);
				for (const x of after) problem(`LEAK: ${x.name} is still registered in ${spec.repo}`);
			} catch (e) {
				problem(`could not verify the proof runner is deregistered: ${why(e)}`);
			}
		}
	};

	const mint = async (): Promise<Owned | null> => {
		const used = await liveJitSlots(spec.node, d.sh);
		let slotIndex = 0;
		for (const o of owned) used.add(o.slotIndex);
		while (used.has(slotIndex)) slotIndex++;
		const name = proofRunnerName(spec.node, spec.repo, d.now() + owned.length * 1_000);
		// Fail-soft by design (null): only a node with no payload needs it.
		const tarball = await runnerTarballUrl(
			(p, t, repo) => d.gh.get(p, t, repo),
			NO_TOKEN,
			spec.repo,
			d.now()
		);
		// REGISTERED BEFORE THE MINT RETURNS, so teardown covers a mint that half-succeeds:
		// a jitconfig that was issued and whose listener never started is the black hole.
		const o: Owned = { name, unit: name, slotIndex, slot: slotDir(home, slotIndex) };
		owned.push(o);
		r.minted.push(name);
		const res = await mintEphemeralRunner(
			{
				node: spec.node,
				repo: spec.repo,
				runnerName: name,
				// THE SEAM: per-call, this runner only. Not `nodeOffer`, not the manifest.
				labels: r.labels,
				slotIndex,
				homeDir: home,
				memoryMaxMb: unitMemoryMaxMb({
					requestedMb: (d.node.slice as { unitMaxMb?: number } | undefined)?.unitMaxMb,
				}),
				ttlSeconds: JIT_UNIT_MAX_SEC,
				tarballUrl: tarball,
			},
			NO_TOKEN,
			d.gh,
			d.sh
		);
		if (!res.ok) {
			find('mint-failed', `could not mint the proof runner on ${spec.node}: ${res.reason}`);
			return null;
		}
		return o;
	};

	const runnerAlive = async (name: string): Promise<boolean> => {
		const units = await liveJitUnits(spec.node, d.sh);
		if (!units.includes(name)) return false;
		return (await listRunners()).some((x) => x.name === name);
	};

	try {
		// --- refusals: nothing has been touched yet -----------------------------
		const refuse = (rule: string, message: string): ProofResult => {
			find(rule, message);
			r.verdict = 'refused';
			return r;
		};
		if (isGuestNode(d.node) && !standing) {
			return finalise(
				refuse(
					'guest',
					`${spec.node} is a GUEST — the fleet chain never mints on, probes or proves a guest (operator, 2026-09-14); an operator may prove its standing runner with --include-guests`
				)
			);
		}
		if (spec.includeGuests === true && !isGuestNode(d.node)) {
			return finalise(
				refuse(
					'include-guests',
					`--include-guests proves a GUEST's standing runner; ${spec.node} is not a guest`
				)
			);
		}
		if (standing && d.node.ephemeral === true) {
			return finalise(
				refuse(
					'guest-ephemeral',
					`${spec.node} is a guest AND ephemeral; the JIT mint would need ssh to a guest, which the transport refuses`
				)
			);
		}
		if (spec.capability) {
			if (!capability(spec.capability)) {
				return finalise(
					refuse('capability', `"${spec.capability}" is not a registered capability`)
				);
			}
			if (!nodeOffer(d.node, { eligible: false }).includes(spec.capability)) {
				return finalise(
					refuse(
						'capability-state',
						`${spec.node} does not carry "${spec.capability}" (assigned or earned) — proving a capability a node was never given would only show it CAN, not that it IS`
					)
				);
			}
		}
		if (!standing && d.node.ephemeral !== true) {
			return finalise(
				refuse(
					'not-ephemeral',
					`${spec.node} is not \`ephemeral: true\`; the proof runner goes through the JIT mint, which is an ephemeral node's path`
				)
			);
		}
		if (spec.evidence !== undefined) {
			try {
				new RegExp(spec.evidence, 'i');
			} catch (e) {
				return finalise(refuse('bad-evidence', `--evidence is not a regex: ${why(e)}`));
			}
		}

		// --- read the job's label needs (reads only) -----------------------------
		let workflowText: string;
		try {
			workflowText = await read('workflow file', () =>
				d.gh.text(
					`/contents/.github/workflows/${encodeURIComponent(spec.workflow)}?ref=${encodeURIComponent(spec.ref)}`,
					NO_TOKEN,
					spec.repo,
					'application/vnd.github.raw'
				)
			);
		} catch (e) {
			find('workflow-unreadable', why(e));
			r.verdict = 'error';
			return finalise(r);
		}
		if (!isDispatchable(workflowText)) {
			return finalise(
				refuse(
					'not-dispatchable',
					`${spec.workflow} has no workflow_dispatch trigger — a proof cannot start it`
				)
			);
		}
		if (standing) {
			// Aimed or nothing: an unaimed job would need the guest's production
			// registration to carry the job's own labels, and that is not ours to add.
			if (!spec.runsOnInput) {
				return finalise(
					refuse(
						'standing-not-aimed',
						`a standing-runner proof needs an aimed canary (a runs-on dispatch input); ${spec.workflow} declares none here`
					)
				);
			}
			r.labels = ['self-hosted', proofLabel(d.now())];
			r.labelSource = 'standing';
		} else if (spec.labelsOverride?.length) {
			r.labels = [...new Set(spec.labelsOverride)];
			r.labelSource = 'override';
			// Aimed: one label nothing else in the fleet carries, sent as the job's
			// `runs-on` — the canary cannot be taken by another listener.
			if (spec.runsOnInput) r.labels.push(proofLabel(d.now()));
		} else {
			const ro = runsOnForJob(workflowText, spec.job);
			if (!ro.ok) return finalise(refuse('runs-on', ro.reason));
			r.labels = ro.labels;
			r.labelSource = 'runs-on';
		}

		// --- standing: the guest's own registration, from the API alone ---------
		if (standing) {
			const listed = await listRunners();
			const reg = listed.find((x) => x.name === spec.node);
			if (!reg) {
				return finalise(
					refuse(
						'standing-runner-missing',
						`${spec.repo} has no standing registration named "${spec.node}" (registered: ${listed.map((x) => x.name).join(', ') || 'none'})`
					)
				);
			}
			if (reg.status !== 'online') {
				return finalise(
					refuse(
						'standing-runner-offline',
						`${spec.node}'s standing runner in ${spec.repo} is ${reg.status ?? 'of unknown status'} — the only admission refusal for a guest`
					)
				);
			}
			const stale = (reg.labels ?? []).map((x) => x.name).filter((n) => n.startsWith('proof-'));
			if (stale.length && !spec.reapStale) {
				return finalise(
					refuse(
						'stale-proof-label',
						`${spec.node} already carries ${stale.join(', ')}: another prove-job is running, or one was killed. Re-run with --reap-stale to remove it`
					)
				);
			}
			for (const label of stale) {
				const res = await d.gh.write(
					'DELETE',
					`/actions/runners/${reg.id}/labels/${encodeURIComponent(label)}`,
					NO_TOKEN,
					undefined,
					spec.repo
				);
				if (!res.ok && res.status !== 404) {
					find(
						'stale-cleanup',
						`could not remove stale proof label ${label} from ${spec.node}: HTTP ${res.status}`
					);
					r.verdict = 'error';
					return finalise(r);
				}
				r.staleCleaned.push(`${spec.node}:${label}`);
			}
			r.standingRunner = { id: reg.id, name: reg.name };
		} else {
			// --- the node: reachable, not drained, room for one more -----------------
			const probe = await d.sh(spec.node, 'echo REACHABLE');
			if (probe === null || !probe.includes('REACHABLE')) {
				find('unreachable', `${spec.node} did not answer ssh — "I could not look" is not a pass`);
				r.verdict = 'error';
				return finalise(r);
			}
			const units = await liveJitUnits(spec.node, d.sh);
			const admission = admitMint({
				drained: d.drained,
				liveUnits: units.length,
				standingBusy: 0,
				maxConcurrent: typeof d.node.maxConcurrent === 'number' ? d.node.maxConcurrent : 1,
				freeMb: Number.POSITIVE_INFINITY,
				requiredMb: 0,
				minFreeMb: 0,
			});
			if (!admission.ok) return finalise(refuse('admission', `${spec.node}: ${admission.reason}`));

			// --- a proof runner an earlier run left behind ---------------------------
			const listed = await listRunners();
			const stale = listed.filter((x) => isProofRunnerName(x.name, spec.node));
			for (const x of stale) {
				if (x.busy) {
					return finalise(
						refuse(
							'proof-in-flight',
							`${x.name} is BUSY — another proof is running a job on ${spec.node}`
						)
					);
				}
				if (units.includes(x.name) && !spec.reapStale) {
					return finalise(
						refuse(
							'stale-proof-live',
							`${x.name} has a LIVE unit on ${spec.node}: another prove-job is running, or one was killed. Re-run with --reap-stale to tear it down`
						)
					);
				}
			}
			for (const x of stale) {
				if (units.includes(x.name)) {
					await d.sh(
						spec.node,
						`XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop ${sq(x.name)} 2>/dev/null; true`
					);
				}
				const res = await d.gh.write(
					'DELETE',
					`/actions/runners/${x.id}`,
					NO_TOKEN,
					undefined,
					spec.repo
				);
				if (!res.ok) {
					find(
						'stale-cleanup',
						`could not remove stale proof runner ${x.name}: HTTP ${res.status}`
					);
					r.verdict = 'error';
					return finalise(r);
				}
				r.staleCleaned.push(x.name);
			}
		}

		// --- the branch the run is dispatched on -------------------------------------
		r.dispatchRef = spec.ref;
		if (spec.scratchBranch) {
			let sha: string | undefined;
			try {
				const head = (await read(`ref ${spec.ref}`, () =>
					d.gh.get(`/git/ref/heads/${encodeURIComponent(spec.ref)}`, NO_TOKEN, spec.repo)
				)) as { object?: { sha?: string } } | null;
				sha = head?.object?.sha;
			} catch (e) {
				find('ref-unreadable', why(e));
			}
			if (!sha) {
				if (!r.findings.length) find('ref-unreadable', `${spec.ref} has no head sha`);
				r.verdict = 'error';
				return finalise(r);
			}
			const name = scratchBranchName(spec.node, d.now());
			scratch = name; // before the write, so a half-made branch is still torn down
			const made = await d.gh.write(
				'POST',
				'/git/refs',
				NO_TOKEN,
				{ ref: `refs/heads/${name}`, sha },
				spec.repo
			);
			if (!made.ok) {
				find('scratch-branch', `could not create ${name} at ${spec.ref}: HTTP ${made.status}`);
				r.verdict = 'error';
				return finalise(r);
			}
			r.dispatchRef = name;
		}
		const on = { ...spec, ref: r.dispatchRef };

		// --- mint once (or label the standing runner), then dispatch -------------
		checkAbort();
		if (r.standingRunner) {
			const sr = r.standingRunner;
			const label = r.labels[r.labels.length - 1];
			// Owned BEFORE the write, so a write that half-succeeds is still removed.
			ownedLabels.push({ runnerId: sr.id, runner: sr.name, label });
			const added = await d.gh.write(
				'POST',
				`/actions/runners/${sr.id}/labels`,
				NO_TOKEN,
				{ labels: [label] },
				spec.repo
			);
			if (!added.ok) {
				find('label-add-failed', `could not add ${label} to ${sr.name}: HTTP ${added.status}`);
				r.verdict = 'error';
				return finalise(r);
			}
		} else if (!(await mint())) {
			r.verdict = 'error';
			return finalise(r);
		}
		/** The registration names the job counts on: the standing runner, or a proof runner minted here. */
		const isTarget = (name: string | null | undefined): boolean =>
			Boolean(name) &&
			(r.standingRunner ? name === r.standingRunner.name : owned.some((o) => o.name === name));

		let landed: { run: RunRow; job: JobRow } | null = null;
		for (let attempt = 1; attempt <= maxAttempts && !landed; attempt++) {
			checkAbort();
			if (d.now() >= deadline) {
				r.verdict = 'timeout';
				find(
					'timeout',
					`the ${Math.round((spec.timeoutMs ?? 40 * 60_000) / 60_000)} minute bound ran out before the job landed`
				);
				return finalise(r);
			}
			// A proof runner that took someone else's job is gone (ephemeral): re-mint.
			if (!standing && attempt > 1 && !(await runnerAlive(owned[owned.length - 1].name))) {
				if (!(await mint())) {
					r.verdict = 'error';
					return finalise(r);
				}
			}
			const wf = `/actions/workflows/${encodeURIComponent(spec.workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(on.ref)}&per_page=20`;
			const before = new Set<number>(
				(
					(await read('runs listing', () => d.gh.get(wf, NO_TOKEN, spec.repo))) as {
						workflow_runs?: RunRow[];
					} | null
				)?.workflow_runs?.map((x) => x.id) ?? []
			);
			const disp = await d.gh.write(
				'POST',
				`/actions/workflows/${encodeURIComponent(spec.workflow)}/dispatches`,
				NO_TOKEN,
				dispatchBody(on, r.labels),
				spec.repo
			);
			if (!disp.ok) {
				find('dispatch-failed', `workflow_dispatch answered HTTP ${disp.status}`);
				r.verdict = 'error';
				return finalise(r);
			}
			// Attribute the run by set difference against the pre-dispatch listing.
			let fresh: RunRow[] = [];
			for (let t = d.now(); d.now() - t < 90_000 && !fresh.length;) {
				await nap(pollMs);
				const now = (await read('runs listing', () => d.gh.get(wf, NO_TOKEN, spec.repo))) as {
					workflow_runs?: RunRow[];
				} | null;
				fresh = (now?.workflow_runs ?? []).filter((x) => !before.has(x.id));
			}
			if (!fresh.length) {
				find('run-not-found', 'the dispatch was accepted but no new run appeared within 90s');
				r.verdict = 'error';
				return finalise(r);
			}
			if (fresh.length > 1) {
				fresh.forEach((x) => dispatched.add(x.id));
				find(
					'ambiguous-run',
					`${fresh.length} new runs appeared (${fresh.map((x) => x.id).join(', ')}) — someone else dispatched the same workflow, so which one is ours cannot be told`
				);
				r.verdict = 'error';
				return finalise(r);
			}
			const run = fresh[0];
			dispatched.add(run.id);
			r.runId = run.id;

			// Which runner took the job — from the API, never inferred.
			const pick = async (): Promise<JobRow | null> => {
				const res = (await read('jobs listing', () =>
					d.gh.get(`/actions/runs/${run.id}/jobs?per_page=100`, NO_TOKEN, spec.repo)
				)) as { jobs?: JobRow[] } | null;
				return res?.jobs?.find((j) => jobKind(j.name) === spec.job) ?? null;
			};
			// AIMED, the target job can land on nothing but a proof runner, so a proof
			// runner that is gone before it landed was taken by an unaimed job in the
			// same run — a `needs:` prerequisite such as forge.yml's `changes`, which
			// runs on the plain pool labels the proof runner also carries. Cancelling
			// would only repeat that on every attempt (claw-4, 2026-10-08): mint another
			// in place and restart the assignment clock, up to the attempt ceiling.
			let job: JobRow | null = null;
			let reminted = 0;
			for (let t = d.now(); d.now() - t < assignMs;) {
				job = await pick();
				if (job && (job.runner_name || job.status === 'completed')) break;
				if (
					!standing &&
					spec.runsOnInput &&
					reminted < MAX_ATTEMPTS_CEILING &&
					!(await runnerAlive(owned[owned.length - 1].name))
				) {
					reminted++;
					if (!(await mint())) {
						r.verdict = 'error';
						return finalise(r);
					}
					t = d.now();
				}
				await nap(pollMs);
			}
			const row: ProofAttempt = {
				attempt,
				runId: run.id,
				jobId: job?.id ?? null,
				runnerName: job?.runner_name ?? null,
				jobConclusion: job?.conclusion ?? null,
				ranOnTarget: isTarget(job?.runner_name),
				// Not a finding: a finding fails the proof, and this is the fleet's own
				// prerequisite job, not anything the node did.
				...(reminted
					? { note: `${reminted} proof runner(s) taken by another job in the run first; re-minted` }
					: {}),
			};
			r.attempts.push(row);
			if (!job) {
				find('job-not-found', `run ${run.id} never listed a job named "${spec.job}"`);
				r.verdict = 'error';
				return finalise(r);
			}
			if (row.ranOnTarget) {
				landed = { run, job };
				break;
			}
			// MISSED. Cancel our run so it frees the concurrency group and stops burning
			// the other runner, then let the next attempt try again.
			row.note = job.runner_name
				? `took ${job.runner_name}, not ${standing ? 'the standing runner' : 'a proof runner'} on ${spec.node}`
				: `no runner took the job within ${Math.round(assignMs / 1000)}s`;
			if (job.status !== 'completed') {
				const c = await d.gh.write(
					'POST',
					`/actions/runs/${run.id}/cancel`,
					NO_TOKEN,
					undefined,
					spec.repo
				);
				if (c.ok) r.teardown.cancelledRuns.push(run.id);
				else if (c.status !== 409)
					find('cancel-failed', `could not cancel run ${run.id}: HTTP ${c.status}`);
				for (let t = d.now(); d.now() - t < 60_000;) {
					const cur = (await d.gh.get(
						`/actions/runs/${run.id}`,
						NO_TOKEN,
						spec.repo
					)) as RunRow | null;
					if (cur?.status === 'completed') break;
					await nap(pollMs);
				}
			}
		}

		if (!landed) {
			const last = r.attempts[r.attempts.length - 1];
			r.jobConclusion = last?.jobConclusion ?? null;
			r.runnerName = last?.runnerName ?? null;
			r.verdict = 'lost-race';
			find(
				'lost-race',
				`the job never landed on ${spec.node} in ${r.attempts.length} attempt(s) (runners that took it: ${r.attempts.map((a) => a.runnerName ?? 'none').join(', ')})`
			);
			return finalise(r);
		}

		// --- landed: wait for it, read the verdict from the API ------------------
		let done: JobRow | null = landed.job;
		for (let t = d.now(); done && done.status !== 'completed' && d.now() - t < jobMs;) {
			await nap(pollMs);
			const res = (await read('jobs listing', () =>
				d.gh.get(`/actions/runs/${landed.run.id}/jobs?per_page=100`, NO_TOKEN, spec.repo)
			)) as { jobs?: JobRow[] } | null;
			done = res?.jobs?.find((j) => j.id === landed.job.id) ?? null;
		}
		if (!done || done.status !== 'completed') {
			r.verdict = 'timeout';
			find(
				'timeout',
				`the job was still ${done?.status ?? 'unreadable'} after ${Math.round(jobMs / 60_000)} minutes`
			);
			return finalise(r);
		}
		r.jobId = done.id;
		r.jobConclusion = done.conclusion ?? null;
		r.runnerName = done.runner_name ?? null;
		r.durationSec = jobDurationSec(done);
		// Read AGAIN from the final object: what counts is where it finished.
		r.ranOnTarget = isTarget(done.runner_name);
		const last = r.attempts[r.attempts.length - 1];
		last.jobConclusion = r.jobConclusion;
		last.ranOnTarget = r.ranOnTarget;
		if (!r.ranOnTarget) {
			r.verdict = 'lost-race';
			find(
				'lost-race',
				`the job finished on ${done.runner_name ?? 'no runner'}, not ${standing ? 'the standing runner' : 'a proof runner'} on ${spec.node}`
			);
			return finalise(r);
		}

		let logFound = false;
		if (spec.evidence !== undefined) {
			try {
				const log = await read('job log', () =>
					d.gh.text(`/actions/jobs/${done.id}/logs`, NO_TOKEN, spec.repo)
				);
				logFound = true;
				r.evidence = extractEvidence(log, spec.evidence);
			} catch (e) {
				find('log-unreadable', why(e));
			}
		}
		if (r.jobConclusion !== 'success') {
			r.verdict = 'fail';
			find('job-failed', `the job ran on ${spec.node} and concluded "${r.jobConclusion}"`);
		} else if (spec.evidence !== undefined && !logFound) {
			r.verdict = 'error';
		} else if (spec.evidence !== undefined && !r.evidence.length) {
			r.verdict = 'fail';
			find(
				'no-evidence',
				`the job went green on ${spec.node} but no log line matched /${spec.evidence}/i — a pass with no evidence is not a pass`
			);
		} else r.verdict = 'pass';
		return finalise(r);
	} catch (e) {
		if (e instanceof Abort) {
			find('aborted', 'stopped by a signal; tearing down');
			r.verdict = 'error';
		} else {
			find(e instanceof Unreadable ? 'unreadable' : 'unexpected', why(e));
			r.verdict = 'error';
		}
		return finalise(r);
	}

	/** Teardown, then the verdict. Awaited on every return path above. */
	async function finalise(res: ProofResult): Promise<ProofResult> {
		if (owned.length || ownedLabels.length || dispatched.size || scratch) await teardown();
		if (!res.teardown.ok) res.verdict = 'teardown-failed';
		res.ok = res.verdict === 'pass' && res.ranOnTarget && res.findings.length === 0;
		res.finishedAt = new Date(d.now()).toISOString();
		return res;
	}
}

/**
 * Did this canary run say anything about the NODE? Only a job that ran on the
 * target does: it passed, failed, or was still running when the bound ran out.
 * Everything else is "could not look" — the job went to another runner
 * (`lost-race`), a read or dispatch failed, the run was aborted, or a green
 * job's log could not be read for evidence — and must never be filed as a
 * verdict on the node.
 *
 * WHY (2026-10-08). The first live `bootcamp --prove` recorded FAIL for claw-4
 * and claw-8, both "the job did not land on the target node": every other
 * `jdk21` listener in the fleet could take the dispatched canary, and did. An
 * explicit FAIL withholds the label even while the gate is dormant, so a
 * dispatch race on the canary pulled `jdk21` off two healthy claws and left
 * cardtable's Forge jobs one node.
 */
export function proofConclusive(
	result: ProofResult
): { conclusive: true; timedOut: boolean } | { conclusive: false; why: string } {
	const lastAttempt = result.attempts[result.attempts.length - 1];
	// A timeout AFTER landing is the node's own result (it ran and did not
	// finish) — the claw-3 shape. `r.ranOnTarget` is only set on completion, so
	// the landing is read from the attempt that landed.
	if (result.verdict === 'timeout' && lastAttempt?.ranOnTarget) {
		return { conclusive: true, timedOut: true };
	}
	if (!result.ranOnTarget || result.jobConclusion === null) {
		const took = result.attempts.map((a) => a.runnerName ?? 'none').join(', ');
		return {
			conclusive: false,
			why:
				result.verdict === 'lost-race'
					? `the job never ran on ${result.node} (taken by: ${took || 'none'}) — says nothing about the node`
					: `the job never completed on ${result.node} (${result.verdict}) — says nothing about the node`,
		};
	}
	if (
		result.jobConclusion === 'success' &&
		result.findings.some((f) => f.rule === 'log-unreadable')
	) {
		return {
			conclusive: false,
			why: `the job went green on ${result.node} but its log could not be read for evidence`,
		};
	}
	return { conclusive: true, timedOut: false };
}

/**
 * Turn a FRESH `proveJob` result into the `$proof` record `measured.ts#writeProof`
 * files — the one place `proveJob`'s raw facts (conclusion, ranOnTarget,
 * evidence, duration) meet the registry's budget judgement (`proofBudget`,
 * `judgeWorkloadProof`). `scripts/prove-job.mjs` is the only writer, and
 * `scripts/bootcamp.mjs --prove` reaches it through that script.
 *
 * Returns `{ inconclusive }` instead of a record when the run said nothing
 * about the node ({@link proofConclusive}); the caller writes nothing then.
 *
 * Only meaningful for a capability whose `jobProof` declares a `budget` — see
 * `workloadGatedCapabilities()`. Callers check that before calling this; it is
 * not re-checked here (`judgeWorkloadProof` already fails loudly when it is
 * missing, rather than silently).
 *
 * `otherNodesProofs` MUST already exclude `result.node` — this is the budget
 * computed from NODES OTHER THAN the one just proven, so a node cannot bootstrap
 * its own bar from a stale reading of itself.
 */
export function buildProofRecord(
	cap: Capability,
	result: ProofResult,
	otherNodesProofs: readonly ProofRecord[],
	opts: { now?: Date } = {}
): { record: ProofRecord } | { inconclusive: string } {
	const c = proofConclusive(result);
	if (!c.conclusive) return { inconclusive: c.why };
	const now = opts.now ?? new Date();
	const budget = proofBudget(cap, otherNodesProofs, now);
	const evidenceMatched = result.evidence.length > 0;
	const judged = judgeWorkloadProof(
		cap,
		{
			conclusion: result.jobConclusion,
			ranOnTarget: true,
			evidenceMatched,
			durationSec: result.durationSec,
			timedOut: c.timedOut,
		},
		budget
	);
	return {
		record: {
			node: result.node,
			capability: cap.id,
			runId: result.runId,
			runner: result.runnerName,
			conclusion: result.jobConclusion,
			durationSec: result.durationSec,
			evidenceMatched,
			budgetSec: budget.budgetSec,
			verdict: judged.verdict,
			why: judged.why,
			at: now.toISOString(),
		},
	};
}
