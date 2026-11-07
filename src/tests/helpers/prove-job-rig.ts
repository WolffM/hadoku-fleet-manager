/**
 * Shared fixture for `prove-job.test.ts`'s split: the stateful world —
 * GitHub, the node's systemd, and the two runners (the proof runner and
 * hokon's) that race for the job — plus the base `ManifestNode` builder, the
 * real workflow fixture every file that reads `runs-on` or dispatches needs,
 * and `assertUntouched`, shared by every file that asserts a refusal path
 * never writes.
 *
 * Every port `world()` hands out is injected — no network, no ssh, no real
 * clock — so every file split out of `prove-job.test.ts` gets the exact same
 * simulated world the original file exercised, not a second one that could
 * drift from it.
 */
import assert from 'node:assert/strict';

import type { ManifestNode } from '../../lib/capability-registry.js';
import { isProofRunnerName } from '../../lib/jit-naming.js';
import type { ProofGh, ProveSpec } from '../../runners/prove-job-types.js';
import { __resetTarballCacheForTesting } from '../../runners/ephemeral-exec-jit.js';
import { proveJob } from '../../runners/prove-job.js';
import { GOOD_JITCONFIG } from './fleet-fakes.js';

export const T0 = 1_790_000_000_000;
export const HOKON = 'hokon-runner-3';

// The real workflow's shape: a FLOW list for runs-on, a job `name:` that differs
// from its key, a multi-line `if:` and comments — what the parser must survive.
export const WORKFLOW = `name: Tests
on:
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  backend:
    name: backend pytest
    if: >-
      github.event_name != 'pull_request' ||
      contains(fromJSON('["OWNER"]'), github.event.pull_request.author_association)
    # the pm2 host via its tenhands registration
    runs-on: [self-hosted, pm2-host, taskauto]
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
  frontend:
    name: frontend lint
    runs-on: \${{ fromJSON(vars.CI_RUNNER) }}
`;

export const LOG = [
	'claude resolved to /home/hadoku/.local/bin/claude',
	'collecting ...',
	'1203 passed, 2 deselected in 41.2s',
].join('\n');

/** `skipped`: the workflow's own gate skips the job; no runner is ever asked. */
export type Who = 'proof' | 'hokon' | 'none' | 'skipped';
export interface Scenario {
	/** The node the proof runner is minted on. Default: claw-8. */
	target?: string;
	/** Who wins attempt N (1-based). Default: the proof runner. */
	winner?: (attempt: number) => Who;
	conclusion?: string;
	/** The proof runner takes the job and never finishes it. */
	hang?: boolean;
	workflow?: string;
	log?: string | Error;
	unreachable?: boolean;
	/** API reads that throw, by path fragment. */
	broken?: string[];
	/** DELETE of a registration answers this status instead of succeeding. */
	deleteStatus?: number;
	/** An unkillable unit: `systemctl stop` does nothing. */
	unkillable?: boolean;
	registered?: {
		id: number;
		name: string;
		busy?: boolean;
		status?: string;
		labels?: string[];
	}[];
	units?: string[];
	onSleep?: () => void;
	/** POST /git/refs answers this status instead of creating the branch. */
	branchCreateStatus?: number;
	/** The name the jobs API reports — a matrix shard reads `<job> (<n>)`. */
	jobName?: string;
	/**
	 * The first N proof runners are taken by a `needs:` prerequisite in the same
	 * run (forge.yml's `changes`), run it, and exit, before the target is queued.
	 */
	prereqTakes?: number;
}

export function world(sc: Scenario = {}) {
	__resetTarballCacheForTesting();
	const target = sc.target ?? 'claw-8';
	let clock = T0;
	let nextId = 100;
	const runners = new Map<
		number,
		{ name: string; busy: boolean; status: string; labels: string[] }
	>();
	for (const x of sc.registered ?? [])
		runners.set(x.id, {
			name: x.name,
			busy: x.busy ?? false,
			status: x.status ?? 'online',
			labels: [...(x.labels ?? [])],
		});
	const units = new Map<string, number>();
	for (const u of sc.units ?? []) units.set(u, 0);
	const staged = new Set<number>();
	const branches = new Map<string, string>([['main', 'ddda60a']]);
	const runListings: string[] = [];
	const runs: {
		id: number;
		jobId: number;
		attempt: number;
		who: Who;
		runner: string | null;
		polls: number;
		cancelled: boolean;
		done: boolean;
		startedAtMs?: number;
		createdAtMs: number;
	}[] = [];
	const log = {
		writes: [] as string[],
		dispatches: 0,
		dispatchBodies: [] as unknown[],
		mintBodies: [] as { labels: string[] }[],
		commits: [] as { message?: string; tree: string; parents: string[] }[],
		/** The last COMPLETED job object the jobs API handed out. */
		completedJob: null as null | Record<string, unknown>,
		sh: [] as string[],
	};

	const hasProof = () => [...runners.values()].find((r) => isProofRunnerName(r.name, target));
	let prereqTaken = 0;
	const job = (r: (typeof runs)[number]) => {
		// queued on the first look, taken on the second, finished on the third
		r.polls++;
		const base = {
			id: r.jobId,
			name: sc.jobName ?? 'backend pytest',
			created_at: new Date(r.createdAtMs).toISOString(),
		};
		if (r.cancelled)
			return { ...base, status: 'completed', conclusion: 'cancelled', runner_name: r.runner };
		if (r.who === 'skipped')
			return { ...base, status: 'completed', conclusion: 'skipped', runner_name: null };
		if (r.runner === null && r.who === 'proof') {
			const p = hasProof();
			if (p && prereqTaken < (sc.prereqTakes ?? 0)) {
				// The prerequisite ran on it; ephemeral, so it deregisters and its unit exits.
				prereqTaken++;
				for (const [id, x] of runners) if (x.name === p.name) runners.delete(id);
				units.delete(p.name);
			}
			if (!hasProof()) return { ...base, status: 'queued', conclusion: null, runner_name: null };
		}
		if (r.who === 'none' || r.polls < 2)
			return { ...base, status: 'queued', conclusion: null, runner_name: null };
		if (r.runner === null) r.runner = r.who === 'hokon' ? HOKON : (hasProof()?.name ?? null);
		// The jobs API's own wall-clock bounds — set once, the instant the job is
		// first seen running, read from the SAME fixture clock `deps.sleep` advances.
		r.startedAtMs ??= clock;
		const ours = r.who === 'proof';
		if (ours && sc.hang)
			return {
				...base,
				status: 'in_progress',
				conclusion: null,
				runner_name: r.runner,
				started_at: new Date(r.startedAtMs).toISOString(),
			};
		if (ours && r.polls < 3)
			return {
				...base,
				status: 'in_progress',
				conclusion: null,
				runner_name: r.runner,
				started_at: new Date(r.startedAtMs).toISOString(),
			};
		if (ours && !r.done) {
			r.done = true;
			// An ephemeral runner deregisters itself, and its unit exits, after one job.
			for (const [id, x] of runners) if (x.name === r.runner) runners.delete(id);
			if (r.runner) units.delete(r.runner);
		}
		log.completedJob = {
			...base,
			status: 'completed',
			conclusion: sc.conclusion ?? 'success',
			runner_name: r.runner,
			started_at: new Date(r.startedAtMs).toISOString(),
			completed_at: new Date(clock).toISOString(),
		};
		return log.completedJob;
	};

	const gh: ProofGh = {
		get: async (path) => {
			if (sc.broken?.some((b) => path.includes(b))) throw new Error(`GET ${path}: HTTP 502`);
			if (path.startsWith('/actions/runners/downloads')) return [];
			if (path.startsWith('/actions/runners'))
				return {
					runners: [...runners].map(([id, x]) => ({
						id,
						name: x.name,
						busy: x.busy,
						status: x.status,
						labels: x.labels.map((name) => ({ name })),
					})),
				};
			const commit = /^\/git\/commits\/(\w+)$/.exec(path);
			if (commit) return { sha: commit[1], tree: { sha: `tree-of-${commit[1]}` } };
			if (path.startsWith('/git/ref/heads/')) {
				const sha = branches.get(decodeURIComponent(path.slice('/git/ref/heads/'.length)));
				if (!sha) throw new Error(`GET ${path}: HTTP 404`);
				return { object: { sha } };
			}
			if (/\/workflows\/.+\/runs/.test(path)) runListings.push(path);
			if (/\/workflows\/.+\/runs/.test(path))
				return { workflow_runs: runs.map((r) => ({ id: r.id, status: 'queued' })) };
			const jobs = /\/actions\/runs\/(\d+)\/jobs/.exec(path);
			if (jobs) {
				const r = runs.find((x) => x.id === Number(jobs[1]))!;
				return { jobs: [job(r)] };
			}
			const one = /\/actions\/runs\/(\d+)$/.exec(path);
			if (one) {
				const r = runs.find((x) => x.id === Number(one[1]))!;
				const finished = r.cancelled || (r.done && true);
				return { id: r.id, status: finished ? 'completed' : 'in_progress' };
			}
			throw new Error(`unexpected GET ${path}`);
		},
		text: async (path) => {
			if (sc.broken?.some((b) => path.includes(b))) throw new Error(`GET ${path}: HTTP 502`);
			if (path.includes('/contents/')) return sc.workflow ?? WORKFLOW;
			if (path.includes('/logs')) {
				if (sc.log instanceof Error) throw sc.log;
				return sc.log ?? LOG;
			}
			throw new Error(`unexpected text ${path}`);
		},
		write: async (method, path, _t, body) => {
			log.writes.push(`${method} ${path}`);
			if (path.endsWith('/generate-jitconfig')) {
				const b = body as { name: string; labels: string[] };
				log.mintBodies.push(b);
				runners.set(nextId++, { name: b.name, busy: false, status: 'online', labels: b.labels });
				return { ok: true, status: 201, body: { encoded_jit_config: GOOD_JITCONFIG } };
			}
			if (path.endsWith('/dispatches')) {
				log.dispatches++;
				log.dispatchBodies.push(body);
				const attempt = log.dispatches;
				runs.push({
					id: 5000 + attempt,
					jobId: 9000 + attempt,
					attempt,
					who: sc.winner ? sc.winner(attempt) : 'proof',
					createdAtMs: clock,
					runner: null,
					polls: 0,
					cancelled: false,
					done: false,
				});
				return { ok: true, status: 204 };
			}
			if (method === 'POST' && path === '/git/commits') {
				const b = body as { message?: string; tree: string; parents: string[] };
				log.commits.push(b);
				return {
					ok: true,
					status: 201,
					body: { sha: `own-${log.commits.length}-${b.parents[0]}` },
				};
			}
			if (method === 'POST' && path === '/git/refs') {
				if (sc.branchCreateStatus) return { ok: false, status: sc.branchCreateStatus };
				const b = body as { ref: string; sha: string };
				branches.set(b.ref.replace(/^refs\/heads\//, ''), b.sha);
				return { ok: true, status: 201 };
			}
			if (method === 'DELETE' && path.startsWith('/git/refs/heads/')) {
				branches.delete(path.slice('/git/refs/heads/'.length));
				return { ok: true, status: 204 };
			}
			const cancel = /\/actions\/runs\/(\d+)\/cancel$/.exec(path);
			if (cancel) {
				runs.find((x) => x.id === Number(cancel[1]))!.cancelled = true;
				return { ok: true, status: 202 };
			}
			const del = /\/actions\/runners\/(\d+)$/.exec(path);
			if (method === 'DELETE' && del) {
				if (sc.deleteStatus) return { ok: false, status: sc.deleteStatus };
				runners.delete(Number(del[1]));
				return { ok: true, status: 204 };
			}
			throw new Error(`unexpected write ${method} ${path}`);
		},
	};

	const sh = async (_node: string, cmd: string): Promise<string | null> => {
		log.sh.push(cmd);
		if (sc.unreachable) return null;
		if (cmd === 'echo REACHABLE') return 'REACHABLE\n';
		if (cmd.includes("list-units 'jit-*'"))
			return [...units.keys()].map((u) => `${u}.service loaded active running x`).join('\n');
		if (cmd.includes('pgrep -af'))
			return [...units.values()]
				.map((n) => `1 /home/hadoku/.hadoku/jit/slot${n}/bin/Runner.Listener run`)
				.join('\n');
		if (cmd.includes('jit-provision')) {
			const slot = Number(/SLOT=(\d+)/.exec(cmd)![1]);
			return `SLOT-READY /home/hadoku/.hadoku/jit/slot${slot} 2.336.0`;
		}
		if (cmd.includes('CFG-OK')) {
			staged.add(Number(/slot(\d+)/.exec(cmd)![1]));
			return 'CFG-OK';
		}
		if (cmd.startsWith('systemd-run')) {
			const unit = /--unit=(\S+)/.exec(cmd)![1];
			const slot = Number(/slot(\d+)\/bin\/Runner\.Listener/.exec(cmd)![1]);
			units.set(unit, slot);
			staged.delete(slot);
			return 'Running as unit';
		}
		if (cmd.includes('systemctl --user stop')) {
			const unit = /stop '?(jit-[^' ]+)/.exec(cmd)![1];
			const slot = units.get(unit);
			if (!sc.unkillable) {
				units.delete(unit);
				const m = /rm -f '?[^\n]*slot(\d+)\/\.jitconfig/.exec(cmd);
				if (m) staged.delete(Number(m[1]));
			}
			for (const x of runners.values()) if (x.name === unit) x.busy = false;
			if (!cmd.includes('UNIT-GONE')) return '';
			const cfg = slot !== undefined && staged.has(slot);
			return [
				units.has(unit) ? 'UNIT-ACTIVE' : 'UNIT-GONE',
				cfg ? 'CFG-PRESENT' : 'CFG-GONE',
				units.has(unit) ? 'LISTENER-UP' : 'LISTENER-GONE',
			].join('\n');
		}
		throw new Error(`unexpected sh: ${cmd}`);
	};

	const deps = (node: ManifestNode, extra: Partial<Parameters<typeof proveJob>[1]> = {}) => {
		return {
			gh,
			sh,
			homeDir: '/home/hadoku',
			node,
			drained: false,
			now: () => clock,
			sleep: async (ms: number, signal?: AbortSignal) => {
				sc.onSleep?.();
				if (signal?.aborted) throw new Error('aborted');
				clock += ms;
			},
			pollMs: 1_000,
			...extra,
		};
	};
	const leaked = () => ({
		units: [...units.keys()].filter((u) => isProofRunnerName(u, target)),
		registered: [...runners.values()]
			.map((r) => r.name)
			.filter((n) => isProofRunnerName(n, target)),
		staged: [...staged],
	});
	return {
		gh,
		sh,
		deps,
		log,
		leaked,
		units,
		runners,
		branches,
		runListings,
		advance: (ms: number) => (clock += ms),
	};
}

export const node = (over: Partial<ManifestNode> = {}): ManifestNode =>
	deepFreeze({ role: 'claw', ephemeral: true, maxConcurrent: 3, labels: ['taskauto'], ...over });

function deepFreeze<T>(o: T): T {
	if (o && typeof o === 'object') {
		Object.freeze(o);
		for (const v of Object.values(o)) deepFreeze(v);
	}
	return o;
}

export const SPEC: ProveSpec = {
	node: 'claw-8',
	repo: 'WolffM/hadoku-tenhands',
	workflow: 'test.yml',
	job: 'backend pytest',
	ref: 'main',
	evidence: 'claude resolved|\\d+ passed',
	capability: 'taskauto',
};

export function assertUntouched(w: ReturnType<typeof world>) {
	assert.deepEqual(w.log.writes, [], 'a refusal must not write to GitHub');
	assert.ok(
		!w.log.sh.some((c) => c.includes('jit-provision') || c.startsWith('systemd-run')),
		'nor to the node'
	);
}
