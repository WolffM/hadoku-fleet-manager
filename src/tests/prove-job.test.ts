/**
 * `fleet prove-job`'s orchestration, against ONE simulated world: GitHub, the
 * node's systemd, and the two runners (the proof runner and hokon's) that race
 * for the job. Every port is injected — no network, no ssh, no real clock.
 *
 * The properties under test are the ones a wrong implementation would pass a
 * happy-path run with: which runner the API says took the job, that the retry
 * loop stops, that nothing is left behind on ANY exit path, that a guest is never
 * reached, and that an unreadable source is a finding rather than a pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nodeOffer, capability, type ManifestNode } from '../capabilities.js';
import { parseJitName } from '../runners/ephemeral.js';
import { __resetTarballCacheForTesting, reapJitRunners } from '../runners/ephemeral-exec.js';
import {
	MAX_ATTEMPTS_CEILING,
	buildProofRecord,
	extractEvidence,
	isDispatchable,
	isProofRunnerName,
	proofRunnerName,
	proveJob,
	runsOnForJob,
	specFromCapability,
	type ProofGh,
	type ProofResult,
	type ProveSpec,
} from '../runners/prove-job.js';
import type { ProofRecord } from '../lib/measured.js';
import { GOOD_JITCONFIG } from './helpers/fleet-fakes.js';

const T0 = 1_790_000_000_000;
const HOKON = 'hokon-runner-3';

// The real workflow's shape: a FLOW list for runs-on, a job `name:` that differs
// from its key, a multi-line `if:` and comments — what the parser must survive.
const WORKFLOW = `name: Tests
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

const LOG = [
	'claude resolved to /home/hadoku/.local/bin/claude',
	'collecting ...',
	'1203 passed, 2 deselected in 41.2s',
].join('\n');

/** `standing`: a guest's own registration, which takes the job only while it carries every aimed label. */
type Who = 'proof' | 'hokon' | 'none' | 'standing';
interface Scenario {
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
	/** The registration name a `standing` winner is. */
	standing?: string;
	/** The standing runner is busy with production work for this many job polls after dispatch. */
	standingBusyPolls?: number;
	/** POST/DELETE of a runner label answers this status instead of succeeding. */
	labelAddStatus?: number;
	labelDeleteStatus?: number;
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

function world(sc: Scenario = {}) {
	__resetTarballCacheForTesting();
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
		runsOn: string[];
	}[] = [];
	const log = {
		writes: [] as string[],
		dispatches: 0,
		dispatchBodies: [] as unknown[],
		mintBodies: [] as { labels: string[] }[],
		/** The last COMPLETED job object the jobs API handed out. */
		completedJob: null as null | Record<string, unknown>,
		sh: [] as string[],
	};

	const hasProof = () => [...runners.values()].find((r) => isProofRunnerName(r.name, 'claw-8'));
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
		if (r.who === 'standing' && r.runner === null) {
			const reg = [...runners.values()].find((x) => x.name === sc.standing);
			const carries = reg && r.runsOn.every((l) => l === 'self-hosted' || reg.labels.includes(l));
			if (!carries || r.polls <= (sc.standingBusyPolls ?? 0))
				return { ...base, status: 'queued', conclusion: null, runner_name: null };
		}
		if (r.who === 'none' || r.polls < 2)
			return { ...base, status: 'queued', conclusion: null, runner_name: null };
		if (r.runner === null)
			r.runner =
				r.who === 'hokon'
					? HOKON
					: r.who === 'standing'
						? (sc.standing ?? null)
						: (hasProof()?.name ?? null);
		// The jobs API's own wall-clock bounds — set once, the instant the job is
		// first seen running, read from the SAME fixture clock `deps.sleep` advances.
		r.startedAtMs ??= clock;
		const ours = r.who === 'proof' || r.who === 'standing';
		if (ours && sc.hang)
			return {
				...base,
				status: 'in_progress',
				conclusion: null,
				runner_name: r.runner,
				started_at: new Date(r.startedAtMs).toISOString(),
			};
		if (ours && r.polls < 3 + (r.who === 'standing' ? (sc.standingBusyPolls ?? 0) : 0))
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
			// A standing one stays.
			if (r.who === 'proof') {
				for (const [id, x] of runners) if (x.name === r.runner) runners.delete(id);
				if (r.runner) units.delete(r.runner);
			}
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
					runsOn: (() => {
						const inputs = (body as { inputs?: Record<string, string> }).inputs;
						return inputs?.runs_on ? (JSON.parse(inputs.runs_on) as string[]) : [];
					})(),
					runner: null,
					polls: 0,
					cancelled: false,
					done: false,
				});
				return { ok: true, status: 204 };
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
			const addLabel = /\/actions\/runners\/(\d+)\/labels$/.exec(path);
			if (method === 'POST' && addLabel) {
				if (sc.labelAddStatus) return { ok: false, status: sc.labelAddStatus };
				const reg = runners.get(Number(addLabel[1]));
				if (!reg) return { ok: false, status: 404 };
				reg.labels.push(...(body as { labels: string[] }).labels);
				return { ok: true, status: 200 };
			}
			const delLabel = /\/actions\/runners\/(\d+)\/labels\/(.+)$/.exec(path);
			if (method === 'DELETE' && delLabel) {
				if (sc.labelDeleteStatus) return { ok: false, status: sc.labelDeleteStatus };
				const reg = runners.get(Number(delLabel[1]));
				const name = decodeURIComponent(delLabel[2]);
				if (!reg || !reg.labels.includes(name)) return { ok: false, status: 404 };
				reg.labels = reg.labels.filter((l) => l !== name);
				return { ok: true, status: 200 };
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
		units: [...units.keys()].filter((u) => isProofRunnerName(u, 'claw-8')),
		registered: [...runners.values()]
			.map((r) => r.name)
			.filter((n) => isProofRunnerName(n, 'claw-8')),
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

const node = (over: Partial<ManifestNode> = {}): ManifestNode =>
	deepFreeze({ role: 'claw', ephemeral: true, maxConcurrent: 3, labels: ['taskauto'], ...over });

function deepFreeze<T>(o: T): T {
	if (o && typeof o === 'object') {
		Object.freeze(o);
		for (const v of Object.values(o)) deepFreeze(v);
	}
	return o;
}

const SPEC: ProveSpec = {
	node: 'claw-8',
	repo: 'WolffM/hadoku-tenhands',
	workflow: 'test.yml',
	job: 'backend pytest',
	ref: 'main',
	evidence: 'claude resolved|\\d+ passed',
	capability: 'taskauto',
};

// --- the happy path, and what it reports --------------------------------------

// cardtable sharded forge-e2e on 2026-10-08: a dispatch carrying `specs`
// runs a one-shard matrix, and the jobs API names it `forge-e2e (1)`.
test('a canary job served as a matrix shard is still found and judged', async () => {
	const w = world({ jobName: 'backend pytest (1)' });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(r.ranOnTarget, true);
});

test('a job that lands on the proof runner and succeeds is a pass, read from the API', async () => {
	const w = world();
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(r.ok, true);
	assert.equal(r.ranOnTarget, true);
	assert.equal(r.jobConclusion, 'success');
	assert.ok(r.runnerName && isProofRunnerName(r.runnerName, 'claw-8'));
	assert.ok(r.runId && r.jobId);
	assert.deepEqual(r.evidence, [
		'claude resolved to /home/hadoku/.local/bin/claude',
		'1203 passed, 2 deselected in 41.2s',
	]);
	assert.deepEqual(w.leaked(), { units: [], registered: [], staged: [] });
});

// --- 1. the label override is this runner's, and only this runner's ------------

test("the proof runner carries the job's runs-on labels; the manifest and the node's offer are untouched", async () => {
	const w = world();
	const n = node({ labels: ['taskauto'] });
	const offerBefore = nodeOffer(n, { eligible: true });
	const snapshot = JSON.stringify(n);
	await proveJob(SPEC, w.deps(n));
	const labels = w.log.mintBodies[0].labels;
	// the implicit three plus EXACTLY what the job asked for — including pm2-host, which claw-8 must not carry
	assert.deepEqual([...labels].sort(), ['Linux', 'X64', 'pm2-host', 'self-hosted', 'taskauto']);
	assert.ok(
		!labels.includes('hadoku-builder'),
		'the node offer (eligibility) must not leak into the proof runner'
	);
	assert.equal(JSON.stringify(n), snapshot, 'the manifest node is READ-ONLY');
	assert.deepEqual(nodeOffer(n, { eligible: true }), offerBefore);
	assert.ok(!nodeOffer(n, { eligible: true }).includes('pm2-host'));
});

test('--labels-override replaces the workflow labels for this runner alone', async () => {
	const w = world();
	const n = node();
	await proveJob({ ...SPEC, labelsOverride: ['self-hosted', 'odd-label'] }, w.deps(n));
	assert.deepEqual([...w.log.mintBodies[0].labels].sort(), [
		'Linux',
		'X64',
		'odd-label',
		'self-hosted',
	]);
	assert.deepEqual(n.labels, ['taskauto']);
});

// --- 2. ranOnTarget is READ, never inferred ------------------------------------

test('a job that concluded SUCCESS on the wrong runner is lost-race, not a pass', async () => {
	const w = world({ winner: () => 'hokon' });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'lost-race');
	assert.equal(r.ok, false);
	assert.equal(r.ranOnTarget, false);
	assert.equal(r.runnerName, HOKON);
	assert.equal(r.jobConclusion, 'success', 'the conclusion is reported — it is just not a proof');
	assert.ok(r.attempts.every((a) => a.ranOnTarget === false && a.jobConclusion === 'success'));
	// and it kept trying, to the cap, rather than accepting the first green job it saw
	assert.equal(w.log.dispatches, 3);
	assert.equal(r.attempts.length, 3);
});

test('a miss is cancelled and retried, and the second dispatch can win', async () => {
	const w = world({ winner: (n) => (n === 1 ? 'none' : 'proof') });
	const r = await proveJob({ ...SPEC, assignTimeoutMs: 5_000 }, w.deps(node()));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(w.log.dispatches, 2);
	assert.ok(
		w.log.writes.includes('POST /actions/runs/5001/cancel'),
		'the missed run is cancelled, not left queued'
	);
	assert.equal(r.attempts.length, 2);
	assert.equal(r.attempts[0].ranOnTarget, false);
	assert.equal(r.attempts[1].ranOnTarget, true);
});

// --- 3. bounded --------------------------------------------------------------

test('retries are capped: never more than the requested attempts, never more than the ceiling', async () => {
	const w = world({ winner: () => 'none' });
	const r = await proveJob({ ...SPEC, maxAttempts: 3, assignTimeoutMs: 3_000 }, w.deps(node()));
	assert.equal(r.verdict, 'lost-race');
	assert.equal(w.log.dispatches, 3);

	const w2 = world({ winner: () => 'none' });
	const r2 = await proveJob({ ...SPEC, maxAttempts: 99, assignTimeoutMs: 3_000 }, w2.deps(node()));
	assert.equal(r2.verdict, 'lost-race');
	assert.equal(w2.log.dispatches, MAX_ATTEMPTS_CEILING);
});

// --- 4. teardown on EVERY path -----------------------------------------------

test('teardown leaves nothing behind on success, failure, lost race, timeout and mint failure', async () => {
	const cases: [string, Scenario, Partial<ProveSpec>, string][] = [
		['success', {}, {}, 'pass'],
		['job failure', { conclusion: 'failure' }, {}, 'fail'],
		['lost race', { winner: () => 'hokon' }, {}, 'lost-race'],
		['job timeout', { hang: true }, { jobTimeoutMs: 10_000 }, 'timeout'],
		[
			'whole-run timeout',
			{ winner: () => 'none' },
			{ timeoutMs: 5_000, assignTimeoutMs: 4_000 },
			'timeout',
		],
	];
	for (const [label, sc, spec, verdict] of cases) {
		const w = world(sc);
		const r = await proveJob({ ...SPEC, ...spec }, w.deps(node()));
		assert.equal(r.verdict, verdict, `${label}: ${JSON.stringify(r.findings)}`);
		assert.deepEqual(w.leaked(), { units: [], registered: [], staged: [] }, `${label} leaked`);
		assert.equal(r.teardown.ok, true, label);
		assert.ok(
			r.teardown.runners.every(
				(t) => t.unitStopped && t.configGone && t.listenerGone && t.deregistered
			),
			label
		);
	}
});

test('a hung job is cancelled on teardown so it cannot outlive the proof', async () => {
	const w = world({ hang: true });
	await proveJob({ ...SPEC, jobTimeoutMs: 10_000 }, w.deps(node()));
	assert.ok(w.log.writes.includes('POST /actions/runs/5001/cancel'));
});

test('an abort (SIGTERM) mid-run still tears down', async () => {
	const ac = new AbortController();
	let polls = 0;
	const w = world({ hang: true, onSleep: () => void (++polls === 6 && ac.abort()) });
	const r = await proveJob(
		{ ...SPEC, jobTimeoutMs: 600_000 },
		w.deps(node(), { signal: ac.signal })
	);
	assert.equal(r.verdict, 'error');
	assert.ok(r.findings.some((f) => f.rule === 'aborted'));
	assert.deepEqual(w.leaked(), { units: [], registered: [], staged: [] });
	assert.equal(r.ok, false);
});

test('a teardown that cannot remove the registration is LOUD: verdict teardown-failed, the leak named', async () => {
	const w = world({ deleteStatus: 500, hang: true });
	const r = await proveJob({ ...SPEC, jobTimeoutMs: 5_000 }, w.deps(node()));
	assert.equal(r.verdict, 'teardown-failed');
	assert.equal(r.ok, false);
	assert.equal(r.teardown.ok, false);
	assert.ok(
		r.findings.some((f) => f.rule === 'teardown-failed' && /LEAK: jit-claw-8-proof/.test(f.message))
	);
});

test('a unit that will not stop is a finding, verified from the node', async () => {
	const w = world({ unkillable: true, hang: true });
	const r = await proveJob({ ...SPEC, jobTimeoutMs: 5_000 }, w.deps(node()));
	assert.equal(r.verdict, 'teardown-failed');
	assert.ok(r.findings.some((f) => /still active/.test(f.message)));
});

test('a node that cannot be reached at teardown is a finding, not a clean exit', async () => {
	const w = world();
	const real = w.sh;
	let down = false;
	const d = w.deps(node());
	const r = await proveJob(SPEC, {
		...d,
		sh: async (n, c) => {
			if (c.includes('UNIT-GONE')) down = true;
			return down ? null : real(n, c);
		},
	});
	assert.equal(r.verdict, 'teardown-failed');
	assert.ok(r.findings.some((f) => /could not reach claw-8 to tear down/.test(f.message)));
});

// --- 5. refusals: nothing is touched -------------------------------------------

function assertUntouched(w: ReturnType<typeof world>) {
	assert.deepEqual(w.log.writes, [], 'a refusal must not write to GitHub');
	assert.ok(
		!w.log.sh.some((c) => c.includes('jit-provision') || c.startsWith('systemd-run')),
		'nor to the node'
	);
}

test('a GUEST is refused before anything is reached', async () => {
	const w = world();
	const r = await proveJob({ ...SPEC, node: 'hokon' }, w.deps(node({ role: 'guest' })));
	assert.equal(r.verdict, 'refused');
	assert.ok(r.findings.some((f) => f.rule === 'guest'));
	assert.deepEqual(w.log.sh, [], 'not even a reachability probe');
	assertUntouched(w);
});

test('a node that does not carry the capability is refused with the reason', async () => {
	const w = world();
	const r = await proveJob(SPEC, w.deps(node({ labels: [] })));
	assert.equal(r.verdict, 'refused');
	assert.ok(
		r.findings.some(
			(f) => f.rule === 'capability-state' && /does not carry "taskauto"/.test(f.message)
		)
	);
	assertUntouched(w);
});

test('a non-ephemeral node, a drained node and a full node are refused', async () => {
	for (const [n, drained, rule] of [
		[node({ ephemeral: false }), false, 'not-ephemeral'],
		[node(), true, 'admission'],
	] as const) {
		const w = world();
		const r = await proveJob(SPEC, w.deps(n, { drained }));
		assert.equal(r.verdict, 'refused', rule);
		assert.ok(
			r.findings.some((f) => f.rule === rule),
			rule
		);
		assertUntouched(w);
	}
	const w = world({ units: ['jit-claw-8-x-j1-r2-3', 'jit-claw-8-y-j1-r2-3'] });
	const r = await proveJob(SPEC, w.deps(node({ maxConcurrent: 2 })));
	assert.ok(r.findings.some((f) => f.rule === 'admission' && /at capacity/.test(f.message)));
	assertUntouched(w);
});

test('a workflow that cannot be dispatched, or whose runs-on is an expression, is refused', async () => {
	const w = world({ workflow: WORKFLOW.replace('  workflow_dispatch:\n', '') });
	assert.equal((await proveJob(SPEC, w.deps(node()))).findings[0].rule, 'not-dispatchable');
	assertUntouched(w);
	const w2 = world();
	const r = await proveJob({ ...SPEC, job: 'frontend lint' }, w2.deps(node()));
	assert.equal(r.findings[0].rule, 'runs-on');
	assert.match(r.findings[0].message, /--labels-override/);
	assertUntouched(w2);
});

// --- 6. "I could not look" is never a pass -------------------------------------

test('an unreadable jobs API is a finding with its reason, and the runner is still torn down', async () => {
	const w = world({ broken: ['/jobs'] });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'error');
	assert.equal(r.ok, false);
	assert.ok(
		r.findings.some((f) => f.rule === 'unreadable' && /jobs listing.*HTTP 502/.test(f.message))
	);
	assert.deepEqual(w.leaked(), { units: [], registered: [], staged: [] });
});

test('an unreadable workflow file stops before any mutation', async () => {
	const w = world({ broken: ['/contents/'] });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'error');
	assert.equal(r.findings[0].rule, 'workflow-unreadable');
	assertUntouched(w);
});

test('an unreachable node is a finding, not a pass', async () => {
	const w = world({ unreachable: true });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'error');
	assert.equal(r.findings[0].rule, 'unreachable');
	assertUntouched(w);
});

test('an unreadable LOG is a finding even though the job went green', async () => {
	const w = world({ log: new Error('HTTP 410 gone') });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.jobConclusion, 'success');
	assert.equal(r.ok, false);
	assert.ok(r.findings.some((f) => f.rule === 'log-unreadable' && /410/.test(f.message)));
});

test('one transient read failure is retried and does not fail the proof', async () => {
	const w = world();
	let failed = false;
	const gh: ProofGh = {
		...w.gh,
		get: async (p, t, repo) => {
			if (p.includes('/jobs') && !failed) {
				failed = true;
				throw new Error('HTTP 502');
			}
			return w.gh.get(p, t, repo);
		},
	};
	const r = await proveJob(SPEC, { ...w.deps(node()), gh });
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
});

// --- 7. evidence -------------------------------------------------------------

test('a green job with NO matching log line is not a pass', async () => {
	const w = world({ log: 'setup\nall quiet\n' });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'fail');
	assert.equal(r.ok, false);
	assert.ok(r.findings.some((f) => f.rule === 'no-evidence'));
});

test('extractEvidence: regex, case, timestamps stripped, de-duplicated, bounded', () => {
	const ts = `${new Date(0).toISOString().replace('.000Z', '.1234567Z')} `;
	const log = [
		`${ts}Claude Resolved to /x`,
		'noise',
		'Claude Resolved to /x',
		'5 passed',
		'x'.repeat(400) + ' passed',
	].join('\n');
	const ev = extractEvidence(log, 'claude resolved|\\d+ passed|passed$');
	assert.equal(ev[0], 'Claude Resolved to /x');
	assert.equal(ev[1], '5 passed');
	assert.equal(ev.length, 3, 'the duplicate is dropped');
	assert.ok(ev[2].length <= 301);
	assert.equal(extractEvidence('a\na\nb', 'a|b', 1).length, 1);
	assert.deepEqual(extractEvidence('nothing', 'zzz'), []);
});

// --- the name, and the reap sweep ----------------------------------------------

test('the proof name parses as a JIT name and the reap sweep protects it while its unit lives', async () => {
	const name = proofRunnerName('claw-8', 'WolffM/hadoku-tenhands', T0 - 3 * 3_600_000);
	assert.ok(name.length <= 64);
	assert.ok(isProofRunnerName(name, 'claw-8'));
	assert.ok(
		!isProofRunnerName(`jit-claw-8-hadoku-site-j1-r2-${T0}`, 'claw-8'),
		'a real mint is not a proof'
	);
	assert.equal(parseJitName(name)?.runId, 0);
	const live = world({ registered: [{ id: 1, name }], units: [name] });
	const kept = await reapJitRunners(['WolffM/hadoku-tenhands'], ['claw-8'], '', live.gh, live.sh, {
		nowMs: T0,
	});
	assert.deepEqual(
		[kept.reaped, kept.kept],
		[0, 1],
		'a live proof runner is kept, even past the grace'
	);
	// and a crash that strands the registration with no unit behind it has a backstop
	const gone = world({ registered: [{ id: 1, name }], units: [] });
	const reaped = await reapJitRunners(
		['WolffM/hadoku-tenhands'],
		['claw-8'],
		'',
		gone.gh,
		gone.sh,
		{ nowMs: T0 }
	);
	assert.equal(reaped.reaped, 1);
});

test('a stale proof registration with no unit is cleaned; a live one refuses unless --reap-stale', async () => {
	const stale = proofRunnerName('claw-8', 'WolffM/hadoku-tenhands', T0 - 3_600_000);
	const w = world({ registered: [{ id: 7, name: stale }] });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.deepEqual(r.staleCleaned, [stale]);

	const w2 = world({ registered: [{ id: 7, name: stale }], units: [stale] });
	const r2 = await proveJob(SPEC, w2.deps(node()));
	assert.equal(r2.verdict, 'refused');
	assert.equal(r2.findings[0].rule, 'stale-proof-live');
	assertUntouched(w2);

	const w3 = world({ registered: [{ id: 7, name: stale }], units: [stale] });
	const r3 = await proveJob({ ...SPEC, reapStale: true }, w3.deps(node()));
	assert.equal(r3.verdict, 'pass', JSON.stringify(r3.findings));

	const w4 = world({ registered: [{ id: 7, name: stale, busy: true }], units: [stale] });
	const r4 = await proveJob({ ...SPEC, reapStale: true }, w4.deps(node()));
	assert.equal(r4.findings[0].rule, 'proof-in-flight', 'a busy proof runner is never touched');
});

// --- the workflow reader -------------------------------------------------------

test('runsOnForJob reads a flow list, a block list and a scalar, by job name or key', () => {
	const flow = runsOnForJob(WORKFLOW, 'backend pytest');
	assert.deepEqual(flow, {
		ok: true,
		labels: ['self-hosted', 'pm2-host', 'taskauto'],
		jobKey: 'backend',
	});
	assert.deepEqual(runsOnForJob(WORKFLOW, 'backend'), flow);
	const block = `jobs:\n  a:\n    runs-on:\n      - self-hosted\n      - "gpu"  # comment\n    steps: []\n  b:\n    runs-on: ubuntu-latest\n`;
	assert.deepEqual(runsOnForJob(block, 'a'), {
		ok: true,
		labels: ['self-hosted', 'gpu'],
		jobKey: 'a',
	});
	assert.deepEqual(runsOnForJob(block, 'b'), { ok: true, labels: ['ubuntu-latest'], jobKey: 'b' });
	const missing = runsOnForJob(block, 'zzz');
	assert.equal(missing.ok, false);
	assert.equal(
		runsOnForJob(WORKFLOW, 'frontend lint').ok,
		false,
		'an expression is refused, not guessed'
	);
});

test('isDispatchable reads the on: section only', () => {
	assert.equal(isDispatchable(WORKFLOW), true);
	assert.equal(
		isDispatchable('on: [push, workflow_dispatch]\njobs:\n  a:\n    runs-on: x\n'),
		true
	);
	assert.equal(isDispatchable('on:\n  push:\njobs:\n  a:\n    name: workflow_dispatch:\n'), false);
});

// --- the declaration -----------------------------------------------------------

test('taskauto declares its proof as data, and the subcommand resolves it from there', () => {
	const cap = capability('taskauto');
	assert.equal(cap?.verify, 'role');
	assert.deepEqual(
		{ ...cap?.jobProof, evidence: undefined },
		{
			repo: 'WolffM/hadoku-tenhands',
			workflow: 'test.yml',
			job: 'backend pytest',
			evidence: undefined,
		}
	);
	assert.doesNotThrow(() => new RegExp(cap!.jobProof!.evidence, 'i'));
	const s = specFromCapability('taskauto', { node: 'claw-8' });
	assert.ok(
		s.ok &&
			s.spec.ref === 'main' &&
			s.spec.capability === 'taskauto' &&
			s.spec.job === 'backend pytest'
	);
	const over = specFromCapability('taskauto', { node: 'claw-8', ref: 'w3q', evidence: 'x' });
	assert.ok(over.ok && over.spec.ref === 'w3q' && over.spec.evidence === 'x');
	assert.equal(
		specFromCapability('jitconfig', { node: 'claw-8' }).ok,
		false,
		'no jobProof declared'
	);
	assert.equal(specFromCapability('nope', { node: 'claw-8' }).ok, false);
});

// ---------------------------------------------------------------------------
// wave 4e (#102) — inputs reach the dispatch body, duration is read from the
// API's own timestamps, excludeRepos never blocks a proof, and the budget
// judgement `buildProofRecord` hands `measured.ts#writeProof`.
// ---------------------------------------------------------------------------

test('spec.inputs are sent verbatim in the dispatch body; omitted entirely when not given', async () => {
	const w = world();
	await proveJob(
		{ ...SPEC, inputs: { only: 'e2e', specs: 'play.spec.ts arrow.spec.ts' } },
		w.deps(node())
	);
	assert.deepEqual(w.log.dispatchBodies[0], {
		ref: 'main',
		inputs: { only: 'e2e', specs: 'play.spec.ts arrow.spec.ts' },
	});

	const w2 = world();
	await proveJob(SPEC, w2.deps(node()));
	assert.deepEqual(
		w2.log.dispatchBodies[0],
		{ ref: 'main' },
		'no inputs key at all when spec carries none'
	);
});

// 2026-10-08: the first live jdk21 canaries were taken by other jdk21
// listeners. An AIMED canary carries a label only its proof runner has, and
// sends that exact label set as the job's runs-on input.
test('an aimed canary mints a unique label and sends it in its runs-on input', async () => {
	const w = world();
	const r = await proveJob(
		{
			...SPEC,
			labelsOverride: ['self-hosted', 'hadoku-builder', 'jdk21'],
			runsOnInput: 'runs_on',
			inputs: { only: 'e2e' },
		},
		w.deps(node())
	);
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	const minted = w.log.mintBodies[0].labels;
	const unique = minted.filter((l) => l.startsWith('proof-'));
	assert.equal(unique.length, 1, `one proof label on the runner: ${minted.join(',')}`);
	const body = w.log.dispatchBodies[0] as { inputs: Record<string, string> };
	assert.equal(body.inputs.only, 'e2e', 'the other inputs still go');
	const runsOn: string[] = JSON.parse(body.inputs.runs_on);
	assert.deepEqual(runsOn, r.labels, 'the input is the label set the proof asked for');
	assert.ok(runsOn.includes(unique[0]), 'and it names the proof label');
	for (const l of runsOn) assert.ok(minted.includes(l), `the proof runner carries ${l}`);
});

// 2026-10-08, claw-4's first aimed canary: forge.yml's `changes` job runs on
// the plain pool labels, which the proof runner also carries, so it took the
// runner and forge-e2e sat queued with nothing left that could take it. Aimed,
// nothing else CAN take the target, so a vanished runner is re-minted in place.
test('an aimed canary whose runner a prerequisite took mints another and lands in ONE dispatch', async () => {
	const w = world({ prereqTakes: 1 });
	const r = await proveJob(
		{
			...SPEC,
			labelsOverride: ['self-hosted', 'hadoku-builder', 'jdk21'],
			runsOnInput: 'runs_on',
			assignTimeoutMs: 30_000,
		},
		w.deps(node())
	);
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(r.ok, true, 'the re-mint is a note, not a finding');
	assert.equal(w.log.dispatches, 1, 'not cancelled and re-dispatched');
	assert.equal(w.log.mintBodies.length, 2);
	assert.match(r.attempts[0].note ?? '', /1 proof runner\(s\) taken/);
	assert.deepEqual(w.leaked(), { units: [], registered: [], staged: [] });
});

test('re-minting is bounded by the attempt ceiling', async () => {
	const w = world({ prereqTakes: 99 });
	const r = await proveJob(
		{
			...SPEC,
			labelsOverride: ['self-hosted', 'hadoku-builder', 'jdk21'],
			runsOnInput: 'runs_on',
			maxAttempts: 1,
			assignTimeoutMs: 30_000,
		},
		w.deps(node())
	);
	assert.equal(r.verdict, 'lost-race');
	assert.equal(w.log.mintBodies.length, 1 + MAX_ATTEMPTS_CEILING);
	assert.deepEqual(w.leaked(), { units: [], registered: [], staged: [] });
});

test('an UNAIMED canary does not re-mint: another listener could have the job, so it cancels and retries', async () => {
	const w = world({ prereqTakes: 1 });
	const r = await proveJob(
		{ ...SPEC, labelsOverride: ['self-hosted', 'hadoku-builder'], assignTimeoutMs: 5_000 },
		w.deps(node())
	);
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(w.log.dispatches, 2);
	assert.ok(w.log.writes.includes('POST /actions/runs/5001/cancel'));
});

test('a canary that is not aimed carries no proof label and sends no runs-on input', async () => {
	const w = world();
	await proveJob({ ...SPEC, labelsOverride: ['self-hosted', 'hadoku-builder'] }, w.deps(node()));
	assert.ok(!w.log.mintBodies[0].labels.some((l) => l.startsWith('proof-')));
	assert.deepEqual(w.log.dispatchBodies[0], { ref: 'main' });
});

// 2026-10-08: claw-3's canary was dispatched on main and sat in main's run
// list as a failed Forge run; cardtable's head watcher paged on it.
const SCRATCH: ProveSpec = { ...SPEC, scratchBranch: true };

test('a scratch-branch canary is dispatched and listed on canary/<node>-*, never on main, and the branch is deleted', async () => {
	const w = world();
	const r = await proveJob(SCRATCH, w.deps(node()));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.match(r.dispatchRef ?? '', /^canary\/claw-8-[0-9a-z]+$/);
	assert.equal(r.ref, 'main', 'the ref it was made FROM is still reported');
	const body = w.log.dispatchBodies[0] as { ref: string };
	assert.equal(body.ref, r.dispatchRef);
	assert.ok(w.runListings.length > 0);
	for (const l of w.runListings)
		assert.ok(l.includes(`branch=${encodeURIComponent(r.dispatchRef!)}`), l);
	assert.ok(w.log.writes.includes('POST /git/refs'));
	assert.deepEqual([...w.branches.keys()], ['main'], 'the scratch branch is gone');
});

test('the scratch branch is deleted on a fail, a lost race and an abort too', async () => {
	for (const [label, sc] of [
		['fail', { conclusion: 'failure' }],
		['lost race', { winner: () => 'hokon' as const }],
	] as const) {
		const w = world(sc);
		await proveJob({ ...SCRATCH, assignTimeoutMs: 3_000 }, w.deps(node()));
		assert.deepEqual([...w.branches.keys()], ['main'], `${label} left a branch`);
	}
	const ac = new AbortController();
	const w = world({ hang: true, onSleep: () => ac.abort() });
	await proveJob(SCRATCH, w.deps(node(), { signal: ac.signal }));
	assert.deepEqual([...w.branches.keys()], ['main'], 'abort left a branch');
});

test('a scratch branch that cannot be made stops before any mint, and is not dispatched on main instead', async () => {
	const w = world({ branchCreateStatus: 403 });
	const r = await proveJob(SCRATCH, w.deps(node()));
	assert.equal(r.verdict, 'error');
	assert.ok(r.findings.some((f) => f.rule === 'scratch-branch'));
	assert.equal(w.log.mintBodies.length, 0);
	assert.equal(w.log.dispatches, 0);
});

test('without scratchBranch the canary is dispatched on its ref and no branch is made', async () => {
	const w = world();
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.dispatchRef, 'main');
	assert.ok(!w.log.writes.some((x) => x.includes('/git/refs')));
});

test('jdk21 is aimed: its spec names the runs_on input and the jdk21 pool', () => {
	const res = specFromCapability('jdk21', { node: 'claw-4' });
	assert.ok(res.ok);
	assert.equal(res.spec.runsOnInput, 'runs_on');
	assert.equal(res.spec.scratchBranch, true, 'and is never dispatched on main');
	assert.deepEqual(res.spec.labelsOverride, ['self-hosted', 'hadoku-builder', 'jdk21']);
});

test("durationSec is read from the jobs API's own started_at/completed_at, never the orchestration clock", async () => {
	const w = world();
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(typeof r.durationSec, 'number');
	assert.ok(r.durationSec! > 0);
});

test('durationSec is null when the API gives no usable timestamps', async () => {
	const w = world({ conclusion: 'failure' });
	const r = await proveJob(SPEC, w.deps(node()));
	assert.equal(r.verdict, 'fail');
	// The fixture DOES stamp started_at/completed_at on every completed job, so
	// this proves the reader itself handles the shape — not that this scenario
	// lacks them. A truly timestamp-less API is exercised by a direct unit
	// test of `buildProofRecord`'s input below instead.
	assert.equal(typeof r.durationSec, 'number');
});

test('excludeRepos is never consulted on the proof path — claw-3 must be able to FAIL its canary', async () => {
	const w = world({ conclusion: 'failure' });
	const n = node({ excludeRepos: { [SPEC.repo]: 'cardtable excluded pending wave 4e' } });
	const r = await proveJob(SPEC, w.deps(n));
	// It minted and dispatched exactly as if excludeRepos were absent — refused
	// for NO reason naming the exclusion, and the job still ran (and failed).
	assert.equal(r.verdict, 'fail', JSON.stringify(r.findings));
	assert.ok(!r.findings.some((f) => /exclude/i.test(f.message)));
	assert.equal(w.log.mintBodies.length, 1, 'the mint still happened');
});

// --- buildProofRecord: the budget judgement, over a REAL ProofResult shape ---

const JDK21 = capability('jdk21')!;

function proofResult(over: Partial<ProofResult> = {}): ProofResult {
	return {
		ok: true,
		verdict: 'pass',
		node: 'claw-4',
		repo: JDK21.jobProof!.repo,
		workflow: JDK21.jobProof!.workflow,
		job: JDK21.jobProof!.job,
		ref: 'main',
		mode: 'jit',
		standingRunner: null,
		dispatchRef: 'main',
		capability: 'jdk21',
		labels: ['self-hosted', 'hadoku-builder', 'jdk21'],
		labelSource: 'runs-on',
		runId: 1,
		jobId: 1,
		jobConclusion: 'success',
		runnerName: 'jit-claw-4-proof-hadoku-cardtable-j0-r0-1',
		durationSec: 300,
		ranOnTarget: true,
		attempts: [],
		evidence: ['two friends play one Forge match'],
		findings: [],
		minted: [],
		staleCleaned: [],
		teardown: { ok: true, runners: [], labels: [], cancelledRuns: [], problems: [] },
		startedAt: new Date(0).toISOString(),
		finishedAt: new Date(1000).toISOString(),
		...over,
	};
}

const otherProof = (over: Partial<ProofRecord> = {}): ProofRecord => ({
	node: 'claw-8',
	capability: 'jdk21',
	runId: 2,
	runner: 'jit-claw-8-proof-hadoku-cardtable-j0-r0-2',
	conclusion: 'success',
	durationSec: 300,
	evidenceMatched: true,
	budgetSec: null,
	verdict: 'pass',
	why: 'pass (budget unbootstrapped: 1/2 proven node(s))',
	at: new Date().toISOString(),
	...over,
});

/** The record, failing the test if the run was judged inconclusive. */
function recordOf(built: ReturnType<typeof buildProofRecord>): ProofRecord {
	assert.ok(
		'record' in built,
		`expected a record, got inconclusive: ${'inconclusive' in built ? built.inconclusive : ''}`
	);
	return built.record;
}

test('buildProofRecord: unbootstrapped PASSES on the raw result alone, and records why', () => {
	const rec = recordOf(buildProofRecord(JDK21, proofResult(), []));
	assert.equal(rec.node, 'claw-4');
	assert.equal(rec.capability, 'jdk21');
	assert.equal(rec.verdict, 'pass');
	assert.match(rec.why, /unbootstrapped: 0\/2/);
	assert.equal(rec.budgetSec, null);
	assert.equal(rec.runId, 1);
	assert.equal(rec.runner, 'jit-claw-4-proof-hadoku-cardtable-j0-r0-1');
	assert.equal(rec.evidenceMatched, true);
});

test('buildProofRecord: bootstrapped and OVER budget FAILS, even though the job itself passed', () => {
	const rec = recordOf(
		buildProofRecord(JDK21, proofResult({ durationSec: 10_000 }), [
			otherProof({ node: 'claw-8', durationSec: 300 }),
			otherProof({ node: 'claw-9', durationSec: 300 }),
		])
	);
	assert.equal(rec.verdict, 'fail');
	assert.match(rec.why, /against a/);
	assert.equal(rec.budgetSec, 300 * 1.5);
});

test('buildProofRecord: bootstrapped and WITHIN budget passes', () => {
	const rec = recordOf(
		buildProofRecord(JDK21, proofResult({ durationSec: 400 }), [
			otherProof({ node: 'claw-8', durationSec: 300 }),
			otherProof({ node: 'claw-9', durationSec: 300 }),
		])
	);
	assert.equal(rec.verdict, 'pass');
});

test('buildProofRecord: a job that ran on the node with no evidence FAILS regardless of budget state', () => {
	const noEvidence = recordOf(buildProofRecord(JDK21, proofResult({ evidence: [] }), []));
	assert.equal(noEvidence.verdict, 'fail');
	assert.match(noEvidence.why, /no evidence/);
	const failed = recordOf(
		buildProofRecord(JDK21, proofResult({ verdict: 'fail', jobConclusion: 'failure' }), [])
	);
	assert.equal(failed.verdict, 'fail');
	assert.match(failed.why, /concluded "failure"/);
});

// 2026-10-08: the first live canaries on claw-4 and claw-8 lost the dispatch
// to other jdk21 listeners and were filed as FAIL, withholding jdk21 from two
// healthy claws. A run that never ran on the node says nothing about it.
test('buildProofRecord: a job that never ran on the node is INCONCLUSIVE and builds no record', () => {
	const lostRace = buildProofRecord(
		JDK21,
		proofResult({
			verdict: 'lost-race',
			ranOnTarget: false,
			jobConclusion: 'success',
			runnerName: 'jit-claw-9-hadoku-cardtable-1',
			attempts: [
				{
					attempt: 1,
					runId: 1,
					jobId: 1,
					runnerName: 'jit-claw-9-hadoku-cardtable-1',
					jobConclusion: null,
					ranOnTarget: false,
				},
			],
		}),
		[]
	);
	assert.ok('inconclusive' in lostRace, 'a lost race must not become a record');
	assert.match(lostRace.inconclusive, /never ran on claw-4.*jit-claw-9/);

	for (const verdict of ['error', 'timeout'] as const) {
		const r = buildProofRecord(
			JDK21,
			proofResult({ verdict, ranOnTarget: false, jobConclusion: null, durationSec: null }),
			[]
		);
		assert.ok('inconclusive' in r, `${verdict} before landing must not become a record`);
	}
});

test('buildProofRecord: a green job whose log could not be read is INCONCLUSIVE, not "no evidence"', () => {
	const r = buildProofRecord(
		JDK21,
		proofResult({
			verdict: 'error',
			evidence: [],
			findings: [{ rule: 'log-unreadable', message: 'HTTP 502' }],
		}),
		[]
	);
	assert.ok('inconclusive' in r);
	assert.match(r.inconclusive, /log could not be read/);
});

test('buildProofRecord: a job that landed and did not finish in time FAILS — the node ran it', () => {
	const r = recordOf(
		buildProofRecord(
			JDK21,
			proofResult({
				verdict: 'timeout',
				ranOnTarget: false,
				jobConclusion: null,
				durationSec: null,
				attempts: [
					{
						attempt: 1,
						runId: 1,
						jobId: 1,
						runnerName: 'jit-claw-4-proof-hadoku-cardtable-j0-r0-1',
						jobConclusion: null,
						ranOnTarget: true,
					},
				],
			}),
			[]
		)
	);
	assert.equal(r.verdict, 'fail');
	assert.match(r.why, /did not finish/);
});

test("buildProofRecord: `at` is NOW, not the proof's own startedAt/finishedAt", () => {
	const now = new Date('2026-10-08T12:00:00Z');
	const rec = recordOf(buildProofRecord(JDK21, proofResult(), [], { now }));
	assert.equal(rec.at, now.toISOString());
});

// ---------------------------------------------------------------------------
// STANDING MODE (2026-10-10, "lets have hokon earn it now"). A guest is proven
// on its OWN standing registration — the path production uses — through the
// GitHub API alone: no mint, no ssh, no drain. The opt-in is explicit, the
// proof label comes off on every path, and queue time behind production work
// is never charged.
// ---------------------------------------------------------------------------

const GUEST_NODE = 'hokon';
const STANDING_ID = 42;
const STANDING_LOG = 'two friends play one Forge match\n3 passed (1.2m)';

const guest = (over: Partial<ManifestNode> = {}): ManifestNode =>
	deepFreeze({ role: 'guest', labels: ['pm2-host', 'jdk21'], maxConcurrent: 4, ...over });

const STANDING_SPEC: ProveSpec = {
	node: GUEST_NODE,
	repo: 'WolffM/hadoku-cardtable',
	workflow: 'forge.yml',
	job: 'forge-e2e',
	ref: 'main',
	evidence: 'two friends play one Forge match|\\d+ passed',
	capability: 'jdk21',
	labelsOverride: ['self-hosted', 'hadoku-builder', 'jdk21'],
	runsOnInput: 'runs_on',
	inputs: { only: 'e2e' },
	scratchBranch: true,
	includeGuests: true,
};

function standingWorld(sc: Scenario = {}) {
	return world({
		jobName: 'forge-e2e (1)',
		log: STANDING_LOG,
		winner: () => 'standing',
		standing: GUEST_NODE,
		registered: [
			{
				id: STANDING_ID,
				name: GUEST_NODE,
				status: 'online',
				labels: ['self-hosted', 'Linux', 'X64', 'pm2-host'],
			},
			{ id: 43, name: 'jit-claw-4-hadoku-cardtable-j1-r1-1', labels: ['self-hosted', 'jdk21'] },
		],
		...sc,
	});
}

/** sh that FAILS the run if it is ever reached: standing mode has no business on the node. */
const noSsh = async (_node: string, cmd: string): Promise<string | null> => {
	throw new Error(`standing mode reached for ssh: ${cmd}`);
};

const standingLabels = (w: ReturnType<typeof world>) =>
	w.runners.get(STANDING_ID)?.labels.filter((l) => l.startsWith('proof-')) ?? [];

test('standing: a guest with the opt-in is proven on its OWN registration, aimed by a proof label, with no ssh', async () => {
	const w = standingWorld();
	const r = await proveJob(STANDING_SPEC, { ...w.deps(guest()), sh: noSsh });
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	assert.equal(r.ok, true);
	assert.equal(r.mode, 'standing');
	assert.deepEqual(r.standingRunner, { id: STANDING_ID, name: GUEST_NODE });
	assert.equal(r.runnerName, GUEST_NODE, 'runner_name is the standing registration');
	assert.equal(r.ranOnTarget, true);
	assert.equal(w.log.mintBodies.length, 0, 'nothing is minted on a guest');
	assert.deepEqual(w.log.sh, [], 'no ssh at all');
	const label = r.labels[1];
	assert.match(label, /^proof-[0-9a-z]+$/);
	assert.deepEqual(r.labels, ['self-hosted', label]);
	const body = w.log.dispatchBodies[0] as { ref: string; inputs: Record<string, string> };
	assert.deepEqual(JSON.parse(body.inputs.runs_on), ['self-hosted', label]);
	assert.equal(body.inputs.only, 'e2e', 'the other inputs still go');
	assert.match(body.ref, /^canary\/hokon-/, 'still a scratch-branch canary');
	const add = w.log.writes.indexOf(`POST /actions/runners/${STANDING_ID}/labels`);
	const dispatch = w.log.writes.findIndex((x) => x.endsWith('/dispatches'));
	const remove = w.log.writes.indexOf(`DELETE /actions/runners/${STANDING_ID}/labels/${label}`);
	assert.ok(add !== -1 && add < dispatch, 'the label is added BEFORE the dispatch');
	assert.ok(remove > dispatch, 'and removed after');
	assert.deepEqual(standingLabels(w), [], 'the proof label is gone');
	assert.deepEqual(r.teardown.labels, [
		{ runner: GUEST_NODE, runnerId: STANDING_ID, label, removed: true },
	]);
	assert.deepEqual([...w.branches.keys()], ['main']);
	assert.ok(
		!w.log.writes.some((x) => x.startsWith('DELETE /actions/runners/') && !x.includes('/labels/')),
		'the standing registration is never deregistered'
	);
});

test('standing: the proof label is removed, and no ssh is made, on fail, timeout, exception and a miss', async () => {
	const cases: [string, Scenario, Partial<ProveSpec>, string][] = [
		['job failure', { conclusion: 'failure' }, {}, 'fail'],
		['job timeout', { hang: true }, { jobTimeoutMs: 10_000 }, 'timeout'],
		['exception (unreadable jobs API)', { broken: ['/jobs'] }, {}, 'error'],
		['never assigned', { winner: () => 'none' }, { assignTimeoutMs: 5_000 }, 'lost-race'],
	];
	for (const [label, sc, spec, verdict] of cases) {
		const w = standingWorld(sc);
		const r = await proveJob({ ...STANDING_SPEC, ...spec }, { ...w.deps(guest()), sh: noSsh });
		assert.equal(r.verdict, verdict, `${label}: ${JSON.stringify(r.findings)}`);
		assert.ok(
			w.log.writes.some((x) =>
				x.startsWith(`DELETE /actions/runners/${STANDING_ID}/labels/proof-`)
			),
			`${label}: the label was removed`
		);
		assert.deepEqual(standingLabels(w), [], `${label} left the proof label`);
		assert.equal(r.teardown.ok, true, label);
		assert.deepEqual(w.log.sh, [], label);
		assert.deepEqual([...w.branches.keys()], ['main'], label);
	}
});

test('standing: an abort (SIGTERM) mid-job still removes the proof label', async () => {
	const ac = new AbortController();
	let polls = 0;
	const w = standingWorld({ hang: true, onSleep: () => void (++polls === 6 && ac.abort()) });
	const r = await proveJob(
		{ ...STANDING_SPEC, jobTimeoutMs: 600_000 },
		{ ...w.deps(guest(), { signal: ac.signal }), sh: noSsh }
	);
	assert.ok(r.findings.some((f) => f.rule === 'aborted'));
	assert.deepEqual(standingLabels(w), [], 'abort left the proof label');
	assert.deepEqual(w.log.sh, []);
});

test('standing: a label write that half-fails is still torn down', async () => {
	const w = standingWorld({ labelAddStatus: 502 });
	// No scratch branch and no run: the owned label ALONE must trigger the teardown.
	const r = await proveJob(
		{ ...STANDING_SPEC, scratchBranch: false },
		{ ...w.deps(guest()), sh: noSsh }
	);
	assert.equal(r.verdict, 'error');
	assert.ok(r.findings.some((f) => f.rule === 'label-add-failed'));
	assert.equal(w.log.dispatches, 0, 'never dispatched without the label');
	assert.ok(
		w.log.writes.some((x) => x.startsWith(`DELETE /actions/runners/${STANDING_ID}/labels/proof-`)),
		'removal is still attempted'
	);
});

test('standing: a proof label that cannot be removed is LOUD — teardown-failed, the label named', async () => {
	const w = standingWorld({ labelDeleteStatus: 500 });
	const r = await proveJob(STANDING_SPEC, { ...w.deps(guest()), sh: noSsh });
	assert.equal(r.verdict, 'teardown-failed');
	assert.equal(r.ok, false);
	assert.equal(r.teardown.labels[0].removed, false);
	assert.ok(
		r.findings.some((f) => /could not remove proof label proof-.* from hokon/.test(f.message))
	);
	assert.ok(r.findings.some((f) => /LEFTOVER: hokon still carries proof label/.test(f.message)));
});

test('standing: runner_name is READ — a job the API reports on another runner is lost-race, not a pass', async () => {
	const w = standingWorld({ winner: () => 'hokon' });
	const r = await proveJob(STANDING_SPEC, { ...w.deps(guest()), sh: noSsh });
	assert.equal(r.verdict, 'lost-race');
	assert.equal(r.ranOnTarget, false);
	assert.equal(r.runnerName, HOKON);
	assert.equal(w.log.dispatches, 1, 'one registration carries the label; a retry asks it again');
	assert.deepEqual(standingLabels(w), []);
});

test('standing: queue time behind production work is NOT charged — duration is started_at to completed_at', async () => {
	// 200 polls x 1 s busy: well past the 120 s a claw's proof waits for assignment.
	const w = standingWorld({ standingBusyPolls: 200 });
	const r = await proveJob(STANDING_SPEC, { ...w.deps(guest()), sh: noSsh });
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
	const job = w.log.completedJob as {
		created_at: string;
		started_at: string;
		completed_at: string;
	};
	const ran = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
	const sinceQueued = (Date.parse(job.completed_at) - Date.parse(job.created_at)) / 1000;
	assert.ok(sinceQueued >= 200, `the fixture really queued: ${sinceQueued}s`);
	assert.equal(r.durationSec, Math.round(ran));
	assert.ok(r.durationSec! < 10, `only the run itself: ${r.durationSec}s`);
});

test('standing: a drained guest is still proven — production work is never stopped, and nothing drains a guest', async () => {
	const w = standingWorld();
	const r = await proveJob(STANDING_SPEC, { ...w.deps(guest(), { drained: true }), sh: noSsh });
	assert.equal(r.verdict, 'pass', JSON.stringify(r.findings));
});

test('standing refusals: no opt-in, opt-in on a claw, offline, missing, unaimed, ephemeral guest — nothing touched', async () => {
	const cases: [string, Scenario, Partial<ProveSpec>, ManifestNode, string][] = [
		['no opt-in', {}, { includeGuests: undefined }, guest(), 'guest'],
		['opt-in on a claw', {}, { node: 'claw-8' }, node({ labels: ['jdk21'] }), 'include-guests'],
		[
			'offline',
			{ registered: [{ id: STANDING_ID, name: GUEST_NODE, status: 'offline', labels: [] }] },
			{},
			guest(),
			'standing-runner-offline',
		],
		[
			"missing (only another node's runner is registered)",
			{ registered: [{ id: 43, name: 'jit-claw-4-hadoku-cardtable-j1-r1-1', labels: ['jdk21'] }] },
			{},
			guest(),
			'standing-runner-missing',
		],
		['unaimed', {}, { runsOnInput: undefined }, guest(), 'standing-not-aimed'],
		['ephemeral guest', {}, {}, guest({ ephemeral: true }), 'guest-ephemeral'],
	];
	for (const [label, sc, spec, n, rule] of cases) {
		const w = standingWorld(sc);
		const r = await proveJob({ ...STANDING_SPEC, ...spec }, { ...w.deps(n), sh: noSsh });
		assert.equal(r.verdict, 'refused', `${label}: ${JSON.stringify(r.findings)}`);
		assert.equal(r.findings[0].rule, rule, label);
		assert.deepEqual(w.log.writes, [], `${label}: a refusal must not write to GitHub`);
		assert.deepEqual(w.log.sh, [], label);
	}
});

test('standing: a stale proof label refuses; --reap-stale removes it and proceeds', async () => {
	const registered = [
		{ id: STANDING_ID, name: GUEST_NODE, status: 'online', labels: ['self-hosted', 'proof-old1'] },
	];
	const w = standingWorld({ registered });
	const r = await proveJob(STANDING_SPEC, { ...w.deps(guest()), sh: noSsh });
	assert.equal(r.verdict, 'refused');
	assert.equal(r.findings[0].rule, 'stale-proof-label');
	assert.deepEqual(w.log.writes, []);

	const w2 = standingWorld({ registered });
	const r2 = await proveJob(
		{ ...STANDING_SPEC, reapStale: true },
		{ ...w2.deps(guest()), sh: noSsh }
	);
	assert.equal(r2.verdict, 'pass', JSON.stringify(r2.findings));
	assert.deepEqual(r2.staleCleaned, ['hokon:proof-old1']);
	assert.deepEqual(standingLabels(w2), []);
});

test('standing: the $proof record is built exactly as for a claw, naming the standing runner', async () => {
	const w = standingWorld();
	const r = await proveJob(STANDING_SPEC, { ...w.deps(guest()), sh: noSsh });
	const rec = recordOf(buildProofRecord(JDK21, r, []));
	assert.equal(rec.node, GUEST_NODE);
	assert.equal(rec.runner, GUEST_NODE);
	assert.equal(rec.verdict, 'pass');
	assert.equal(rec.durationSec, r.durationSec);
	assert.equal(rec.evidenceMatched, true);
});
