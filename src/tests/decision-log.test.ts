/**
 * The dispatch decision log (T1): what it records, when it writes, where it
 * keeps it — and that switching it on changes NOTHING about placement.
 *
 * The equivalence half runs each scenario twice, once with the log off (no
 * observer reaches planTick at all) and once capturing rows, and asserts the
 * same plan, the same pass result and the same calls to GitHub and the nodes.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	DECISION_LOG_MAX_BYTES,
	DECISION_RETENTION_DAYS,
	__resetDecisionLogForTesting,
	__restoreDecisionSinkForTesting,
	__setDecisionSinkForTesting,
	decisionLogDir,
	emitDecisions,
	filterDecisions,
	pruneDecisionLog,
	readDecisions,
	recordWarmListenerDecisions,
	type DecisionRecord,
} from '../runners/decision-log.js';
import {
	runDispatchPass,
	__resetAffinityCountersForTesting,
	__resetHeavyMarksForTesting,
	__resetReapClockForTesting,
	type DispatchPassInput,
} from '../runners/dispatch-pass.js';
import { planTick, type PendingRun, type PlanObservation } from '../runners/dispatcher.js';
import type { NodeState } from '../runners/placement.js';
import type { HeavyModel } from '../runners/traffic.js';
import { __setHostForTesting, stateDir } from '../host.js';
import { testHost } from './install-test-host.js';
import { fakeGh, fakeShell } from './helpers/fleet-fakes.js';
import { tempDir, cleanupTempDirs } from './tmpdir.js';
import { jitRunnerName } from '../runners/ephemeral.js';

const NOW = Date.now();
/** A live unit minted for job 9006 a minute ago, named the way the mint names it. */
const INFLIGHT_UNIT = jitRunnerName('claw-4', 'WolffM/hadoku-rally', NOW - 60_000, 41005, 9006);
const iso = (agoSec: number) => new Date(NOW - agoSec * 1000).toISOString();

function resetAll(): void {
	__resetReapClockForTesting();
	__resetHeavyMarksForTesting();
	__resetAffinityCountersForTesting();
	__resetDecisionLogForTesting();
}
beforeEach(resetAll);
afterEach(() => {
	__restoreDecisionSinkForTesting();
	__setHostForTesting(testHost);
	cleanupTempDirs();
});

const node = (name: string, over: Partial<NodeState> = {}): NodeState => ({
	name,
	healthy: true,
	eligible: true,
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 2,
	freeMb: 9000,
	requiredMb: 900,
	minFreeMb: 1536,
	labels: ['self-hosted', 'hadoku-builder'],
	...over,
});

/** A queued job the way dispatch-tick's `entryFor` builds one. */
const job = (
	runId: number,
	jobId: number,
	repo: string,
	over: Partial<PendingRun> = {}
): PendingRun => ({
	id: runId,
	jobId,
	repo,
	repository: { full_name: repo },
	head_repository: { full_name: repo, fork: false },
	event: 'push',
	labels: ['self-hosted', 'hadoku-builder'],
	jobName: 'check',
	created_at: iso(40),
	jobCreatedAt: iso(30),
	...over,
});

const heavyModel: HeavyModel = {
	isHeavy: (repo, jobName) => repo === 'WolffM/hadoku-cardtable' && /^forge/.test(jobName ?? ''),
	isHeavyRepo: (repo) => repo === 'WolffM/hadoku-cardtable',
} as HeavyModel;

/** The fleet the scenarios share: a jdk21 node, a warm one, an excluded one, a heavy one. */
function fleet(): NodeState[] {
	return [
		node('claw-8', {
			labels: ['self-hosted', 'hadoku-builder', 'jdk21'],
			heavyModel,
			heavyJobs: 1,
			runningHeavy: true,
			standingBusy: 1,
		}),
		node('claw-4', { warmRepo: 'WolffM/hadoku_site', heavyModel }),
		node('claw-3', {
			excludedRepos: new Map([['WolffM/hadoku-cardtable', 'Forge OOMs on 8 GB']]),
			heavyModel,
		}),
		node('claw-9', {
			labels: ['self-hosted', 'hadoku-builder', 'jdk21'],
			heavyModel,
			maxConcurrent: 1,
			liveUnits: 0,
		}),
	];
}

const ORDER = ['claw-8', 'claw-4', 'claw-3', 'claw-9'];

function scenarioJobs(): PendingRun[] {
	return [
		job(41001, 9001, 'WolffM/hadoku_site'),
		job(41002, 9002, 'WolffM/hadoku-cardtable', {
			jobName: 'forge-e2e (1)',
			labels: ['self-hosted', 'hadoku-builder', 'jdk21'],
		}),
		job(41002, 9003, 'WolffM/hadoku-cardtable', {
			jobName: 'forge-e2e (2)',
			labels: ['self-hosted', 'hadoku-builder', 'jdk21'],
		}),
		job(41003, 9004, 'WolffM/hadoku-rally', { event: 'workflow_dispatch' }),
		job(41004, 9005, 'WolffM/hadoku-rally', {
			head_repository: { full_name: 'someone/hadoku-rally', fork: true },
		}),
		job(41005, 9006, 'WolffM/hadoku-rally'),
		job(41006, 9007, 'WolffM/hadoku-study'),
	];
}

const passInput = (over: Partial<DispatchPassInput> = {}): DispatchPassInput => ({
	order: ORDER,
	nodes: fleet(),
	pending: scenarioJobs(),
	labelsFor: () => ['self-hosted', 'hadoku-builder'],
	homeDirFor: () => '/home/fixture-ci',
	memoryMaxMbFor: () => 3000,
	ttlSeconds: 900,
	nowMs: NOW,
	fingerprintFor: (repo, labels) => `${repo}|${labels.join(',')}`,
	runningJobs: [
		{
			repo: 'WolffM/hadoku_site',
			runner: 'warm-claw-4-hadoku_site',
			jobName: 'lint',
			jobId: 8999,
			runId: 41001,
		},
	],
	...over,
});

/** One pass, recording every call it made to GitHub and the nodes. */
async function recordedPass(input: DispatchPassInput, units: string[] = [], mintOk = true) {
	const gh = fakeGh({ mintOk });
	const shCalls: string[] = [];
	const inner = fakeShell({ units });
	const sh = async (n: string, cmd: string) => {
		shCalls.push(`${n}: ${cmd}`);
		return inner(n, cmd);
	};
	const result = await runDispatchPass(input, 'tok', gh, sh);
	return { result, ghCalls: [...gh.calls], shCalls };
}

const capture = (): DecisionRecord[] => {
	const rows: DecisionRecord[] = [];
	__setDecisionSinkForTesting((rs) => rows.push(...rs));
	return rows;
};

// --- equivalence -----------------------------------------------------------

const SCENARIOS: {
	name: string;
	units?: string[];
	mintOk?: boolean;
	over?: () => Partial<DispatchPassInput>;
}[] = [
	{ name: 'mixed fleet: labels, exclusion, warm affinity, heavy hold, fork' },
	{ name: 'a job already in flight', units: [INFLIGHT_UNIT] },
	{ name: 'every mint fails', mintOk: false },
	{
		name: 'a full fleet',
		over: () => ({ nodes: fleet().map((n) => ({ ...n, standingBusy: n.maxConcurrent })) }),
	},
	{
		name: 'a backed-off run rides along',
		over: () => ({
			pending: [
				...scenarioJobs(),
				job(40999, 8990, 'WolffM/hadoku-resume-bot', { held: true, jobCreatedAt: iso(900) }),
			],
		}),
	},
];

for (const s of SCENARIOS) {
	test(`EQUIVALENCE: ${s.name} — the same pass with the log off and on`, async () => {
		__setDecisionSinkForTesting(null);
		const off = await recordedPass(passInput(s.over?.()), s.units, s.mintOk);
		resetAll();
		const rows = capture();
		const on = await recordedPass(passInput(s.over?.()), s.units, s.mintOk);
		assert.deepEqual(on.result, off.result);
		assert.deepEqual(on.ghCalls, off.ghCalls, 'the log made or skipped a GitHub call');
		assert.deepEqual(on.shCalls, off.shCalls, 'the log made or skipped a node command');
		assert.ok(rows.length > 0, 'the log-on pass recorded nothing, so this compared nothing');
	});
}

test('EQUIVALENCE: planTick with and without an observer, over the scenario and its permutations', () => {
	const jobs = scenarioJobs();
	const perms = [
		jobs,
		[...jobs].reverse(),
		[jobs[3], jobs[1], jobs[0], jobs[2], jobs[6], jobs[5], jobs[4]],
	];
	for (const pending of perms) {
		const inFlight = { jobIds: new Set([9006]), runIds: new Set<number>() };
		const without = planTick(pending, fleet(), ORDER, inFlight, NOW);
		const seen: PlanObservation[] = [];
		const withObs = planTick(pending, fleet(), ORDER, inFlight, NOW, (o) => seen.push(o));
		assert.deepEqual(withObs, without);
		assert.equal(seen.length, pending.length, 'one observation per job');
	}
});

test('an observer that throws is caught by the book, and the pass is unchanged', async () => {
	__setDecisionSinkForTesting(null);
	const off = await recordedPass(passInput());
	resetAll();
	const warnings: string[] = [];
	__setHostForTesting({
		...testHost,
		logger: { ...testHost.logger, warn: (m: string) => warnings.push(m) },
	});
	__setDecisionSinkForTesting(() => {
		throw new Error('EROFS: read-only file system');
	});
	const on = await recordedPass(passInput());
	assert.deepEqual(on.result, off.result);
	assert.deepEqual(on.ghCalls, off.ghCalls);
	const ours = warnings.filter((w) => w.startsWith('[decision-log]'));
	assert.equal(ours.length, 1, `one warning, rate limited: ${ours.join(' / ')}`);
	assert.match(ours[0], /EROFS/);
	assert.match(ours[0], /dispatch is unaffected/);
});

// --- what a row says -------------------------------------------------------

test('a placed job: candidates, every refusal ahead of the winner, the rule, the figures, the mint', async () => {
	const rows = capture();
	await recordedPass(passInput());
	const forge1 = rows.find((r) => r.jobId === 9002)!;
	const forge2 = rows.find((r) => r.jobId === 9003)!;
	assert.ok(forge1 && forge2, 'both Forge shards recorded');

	// The heavy shard: claw-9 is the empty jdk21 node and is first in the walk.
	assert.equal(forge1.path, 'jit');
	assert.equal(forge1.kind, 'placed');
	assert.equal(forge1.winner, 'claw-9');
	assert.equal(forge1.outcome, 'minted');
	assert.match(forge1.runner ?? '', /^jit-claw-9-/);
	assert.equal(forge1.heavy, true);
	assert.deepEqual(forge1.order, ORDER);
	assert.equal(forge1.rule?.position, 0);
	assert.deepEqual(forge1.refused, []);
	assert.deepEqual(forge1.rule?.rankedOver, { node: 'claw-4', key: 'busy' });
	assert.equal(forge1.capacity.length, 4, 'every eligible node, as the walk saw it');
	const c9 = forge1.capacity.find((c) => c.node === 'claw-9')!;
	assert.deepEqual(
		[c9.busy, c9.max, c9.units],
		[0, 1, 0],
		'figures BEFORE this job consumed its slot'
	);
	assert.match(forge1.fingerprint ?? '', /^[0-9a-f]{12}$/);

	// The second shard: every node asked, every one refused, each for its own
	// reason — the four different waits the skip line used to fold into one.
	assert.equal(forge2.kind, 'unplaceable');
	assert.equal(forge2.winner, null);
	assert.equal(forge2.rule, null);
	assert.deepEqual(
		forge2.refused.map((x) => x.node),
		forge2.candidates,
		'nobody placed it, so every node in the walk refused'
	);
	const why = Object.fromEntries(forge2.refused.map((x) => [x.node, x.reason]));
	assert.match(why['claw-3'], /repo excluded here: Forge OOMs on 8 GB/);
	assert.match(why['claw-4'], /does not carry/);
	assert.match(why['claw-8'], /heavy hold/);
	assert.match(why['claw-9'], /at capacity: 1\/1/);
	assert.equal(forge2.refused.find((x) => x.node === 'claw-8')?.holdSec, 3600);
	assert.equal(forge2.queuedSec, 30);

	// The site job: claw-4 is warm for it, but its listener is RUNNING a job
	// (the warm sibling), so busy outranks affinity and claw-3 takes it.
	const site = rows.find((r) => r.jobId === 9001)!;
	assert.equal(site.winner, 'claw-3');
	assert.equal(site.rule?.viaAffinity, false);
	assert.equal(site.capacity.find((c) => c.node === 'claw-4')?.busy, 1);

	// The fork, and the warm path's job.
	assert.equal(rows.find((r) => r.jobId === 9005)?.kind, 'fork');
	const warm = rows.find((r) => r.jobId === 8999)!;
	assert.equal(warm.path, 'warm');
	assert.equal(warm.kind, 'warm-assigned');
	assert.equal(warm.winner, 'claw-4');
	assert.equal(warm.runner, 'warm-claw-4-hadoku_site');
});

test('rankedOver names the term that ordered the winner ahead: busy', async () => {
	const rows = capture();
	await recordedPass(
		passInput({
			order: ['claw-1', 'claw-2'],
			nodes: [node('claw-1', { standingBusy: 1 }), node('claw-2')],
			pending: [job(42001, 9101, 'WolffM/hadoku-rally')],
			runningJobs: [],
		})
	);
	const r = rows.find((x) => x.jobId === 9101)!;
	assert.equal(r.winner, 'claw-2');
	assert.deepEqual(r.rule?.rankedOver, { node: 'claw-1', key: 'busy' });
	assert.deepEqual(r.candidates, ['claw-2', 'claw-1']);
	assert.equal(r.rule?.position, 0);
});

test('rankedOver: warm affinity breaks a tie between two idle nodes', async () => {
	const rows = capture();
	await recordedPass(
		passInput({
			order: ['claw-1', 'claw-2'],
			nodes: [node('claw-1'), node('claw-2', { warmRepo: 'WolffM/hadoku_site' })],
			pending: [job(42002, 9102, 'WolffM/hadoku_site')],
			runningJobs: [],
		})
	);
	const r = rows.find((x) => x.jobId === 9102)!;
	assert.equal(r.winner, 'claw-2');
	assert.equal(r.rule?.viaAffinity, true);
	assert.equal(r.rule?.affinityMoved, true);
	assert.deepEqual(r.rule?.rankedOver, { node: 'claw-1', key: 'warm-affinity' });
});

test('a failed mint is recorded as such, with the reason', async () => {
	const rows = capture();
	await recordedPass(passInput(), [], false);
	const site = rows.find((r) => r.jobId === 9001)!;
	assert.equal(site.outcome, 'mint-failed');
	assert.ok(site.error && site.error.length > 0);
});

test('a job already in flight is one in-flight row', async () => {
	const rows = capture();
	await recordedPass(passInput(), [INFLIGHT_UNIT]);
	const r = rows.filter((x) => x.jobId === 9006);
	assert.equal(r.length, 1);
	assert.equal(r[0].kind, 'in-flight');
	assert.equal(r[0].reason, 'already has a runner in flight');
});

// --- dedup -----------------------------------------------------------------

test('DEDUP: a job waiting across passes writes once while nothing changes, again when it does', async () => {
	const rows = capture();
	const full = () =>
		passInput({
			nodes: fleet().map((n) => ({ ...n, standingBusy: n.maxConcurrent })),
			pending: [job(43001, 9201, 'WolffM/hadoku-rally')],
			runningJobs: [],
		});
	// Twenty passes 15 s apart: queue age and the refusals' numbers move every
	// time, the decision does not.
	for (let i = 0; i < 20; i++) {
		__resetReapClockForTesting();
		await recordedPass({ ...full(), nowMs: NOW + i * 15_000 });
	}
	assert.equal(rows.filter((r) => r.jobId === 9201).length, 1, '20 passes, one decision');

	// A node frees a slot: the job places — a new decision.
	await recordedPass({
		...passInput({ pending: [job(43001, 9201, 'WolffM/hadoku-rally')], runningJobs: [] }),
		nowMs: NOW + 21 * 15_000,
	});
	const mine = rows.filter((r) => r.jobId === 9201);
	assert.equal(mine.length, 2);
	assert.equal(mine[1].kind, 'placed');

	// A restart forgets the signatures: ONE duplicate, by design.
	__resetDecisionLogForTesting();
	await recordedPass({
		...passInput({ pending: [job(43001, 9201, 'WolffM/hadoku-rally')], runningJobs: [] }),
		nowMs: NOW + 22 * 15_000,
	});
	assert.equal(rows.filter((r) => r.jobId === 9201).length, 3);
});

test('DEDUP: held and unplaceable are one decision — a backed-off job does not flap', () => {
	const rows = capture();
	const base: DecisionRecord = {
		v: 1,
		at: iso(0),
		path: 'jit',
		kind: 'unplaceable',
		repo: 'WolffM/hadoku-cardtable',
		runId: 1,
		jobId: 2,
		jobName: 'forge-e2e (3)',
		labels: [],
		event: 'push',
		queuedSec: 12,
		heavy: true,
		order: [],
		candidates: ['claw-8'],
		refused: [
			{ node: 'claw-8', reason: 'heavy hold: already running 1 heavy job(s) (queued 12s < 3600s)' },
		],
		winner: null,
		rule: null,
		outcome: null,
		runner: null,
		error: null,
		reason: 'no node can take this job right now',
		action: null,
		capacity: [],
		fingerprint: null,
	};
	emitDecisions([base], NOW);
	emitDecisions(
		[
			{
				...base,
				kind: 'held',
				refused: [{ node: 'claw-8', reason: base.refused[0].reason.replace('12s', '140s') }],
			},
		],
		NOW + 120_000
	);
	assert.equal(rows.length, 1);
});

test('a write that fails is retried on the next pass, not marked as written', () => {
	let fail = true;
	const rows: DecisionRecord[] = [];
	__setDecisionSinkForTesting((rs) => {
		if (fail) throw new Error('ENOSPC');
		rows.push(...rs);
	});
	const r = { ...minimalRow(), jobId: 77 };
	assert.equal(emitDecisions([r], NOW), 0);
	fail = false;
	assert.equal(emitDecisions([r], NOW + 15_000), 1);
	assert.equal(rows.length, 1);
});

function minimalRow(): DecisionRecord {
	return {
		v: 1,
		at: iso(0),
		path: 'jit',
		kind: 'placed',
		repo: 'WolffM/hadoku-rally',
		runId: 5,
		jobId: 6,
		jobName: 'check',
		labels: ['self-hosted', 'hadoku-builder'],
		event: 'push',
		queuedSec: 3,
		heavy: false,
		order: ['claw-1'],
		candidates: ['claw-1'],
		refused: [],
		winner: 'claw-1',
		rule: null,
		outcome: 'minted',
		runner: 'jit-claw-1-hadoku-rally-5-6-aaaaaa',
		error: null,
		reason: null,
		action: null,
		capacity: [],
		fingerprint: null,
	};
}

// --- the warm listener -----------------------------------------------------

test('warm-listener rows: one per node decision, again only when the decision changes', () => {
	const rows = capture();
	const tick = (action: 'fill' | 'keep', at: number) =>
		recordWarmListenerDecisions(
			() => [
				{ node: 'claw-4', action, repo: 'WolffM/hadoku_site', reason: null },
				{ node: 'claw-5', action: 'never-warm', repo: null, reason: 'slow tier' },
			],
			at
		);
	tick('fill', NOW);
	tick('keep', NOW + 60_000);
	tick('keep', NOW + 120_000);
	tick('keep', NOW + 180_000);
	assert.deepEqual(
		rows.map((r) => `${r.winner}:${r.action}`),
		['claw-4:fill', 'claw-5:never-warm', 'claw-4:keep']
	);
	assert.ok(rows.every((r) => r.path === 'warm' && r.kind === 'warm-listener' && r.jobId === null));
});

test('warm-listener: a builder that throws is a warning, not a crash', () => {
	capture();
	assert.equal(
		recordWarmListenerDecisions(() => {
			throw new Error('boom');
		}, NOW),
		0
	);
});

// --- storage ---------------------------------------------------------------

test('the day-file store: appended under the state dir, read back by window', async () => {
	__restoreDecisionSinkForTesting();
	const dir = decisionLogDir();
	assert.equal(dir, join(stateDir(), 'dispatch-decisions'));
	await recordedPass(passInput());
	const day = new Date(NOW).toISOString().slice(0, 10);
	assert.ok(existsSync(join(dir, `${day}.jsonl`)));
	const read = readDecisions(dir, { sinceMs: NOW - 1000 });
	assert.ok(read.records.some((r) => r.jobId === 9002 && r.winner === 'claw-9'));
	assert.equal(read.badLines, 0);
	assert.deepEqual(
		filterDecisions(read.records, { node: 'claw-9' })
			.map((r) => r.jobId)
			.sort(),
		[9002, 9003].sort(),
		'claw-9 won one shard and refused the other'
	);
	assert.deepEqual(
		filterDecisions(read.records, { runId: 41002 })
			.map((r) => r.jobId)
			.sort(),
		[9002, 9003]
	);
});

test('a torn last line is counted, not fatal; rows outside the window are left out', () => {
	const dir = tempDir('decisions-');
	const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
	const old = { ...minimalRow(), at: iso(3 * 86_400), jobId: 1 };
	const fresh = { ...minimalRow(), at: iso(60), jobId: 2 };
	writeFileSync(join(dir, `${day(NOW - 3 * 86_400_000)}.jsonl`), JSON.stringify(old) + '\n');
	appendFileSync(
		join(dir, `${day(NOW - 60_000)}.jsonl`),
		JSON.stringify(fresh) + '\n{"v":1,"at":"20'
	);
	const read = readDecisions(dir, { sinceMs: NOW - 3_600_000 });
	assert.deepEqual(
		read.records.map((r) => r.jobId),
		[2]
	);
	assert.equal(read.badLines, 1);
	assert.equal(readDecisions(dir).records.length, 2);
});

test('a missing log directory throws — "no log" is not "no decisions"', () => {
	assert.throws(() => readDecisions(join(tempDir('decisions-'), 'absent')));
});

test('retention: day files past the window go; the byte cap drops the oldest and warns inside the window', () => {
	const dir = tempDir('decisions-');
	mkdirSync(dir, { recursive: true });
	const day = (agoDays: number) => new Date(NOW - agoDays * 86_400_000).toISOString().slice(0, 10);
	const expired = day(DECISION_RETENTION_DAYS + 2);
	writeFileSync(join(dir, `${expired}.jsonl`), 'x\n');
	for (const d of [5, 3, 1, 0]) writeFileSync(join(dir, `${day(d)}.jsonl`), 'y'.repeat(1000));
	writeFileSync(join(dir, 'notes.txt'), 'not a day file');

	const warnings: string[] = [];
	__setHostForTesting({
		...testHost,
		logger: { ...testHost.logger, warn: (m: string) => warnings.push(m) },
	});
	const r = pruneDecisionLog(dir, NOW, 2500);
	assert.ok(r.removed.includes(`${expired}.jsonl`), 'past retention');
	assert.deepEqual(r.trimmedInWindow, [`${day(5)}.jsonl`, `${day(3)}.jsonl`]);
	assert.equal(r.bytes, 2000);
	assert.equal(r.overCap, false);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /inside the \d+-day window/);
	assert.deepEqual(
		readdirSync(dir).sort(),
		[`${day(0)}.jsonl`, `${day(1)}.jsonl`, 'notes.txt'].sort()
	);

	// Today alone over the cap: kept, and said.
	assert.equal(pruneDecisionLog(dir, NOW, 500).overCap, true);
	assert.ok(existsSync(join(dir, `${day(0)}.jsonl`)), "today's file is never the one dropped");
});

test('the cap holds the window at peak with room to spare', async () => {
	const rows = capture();
	await recordedPass(passInput());
	const bytes = Math.max(...rows.map((r) => JSON.stringify(r).length + 1));
	// ~2,600 jobs/day at two rows each, every row as large as this pass's largest.
	const perWindow = bytes * 2600 * 2 * DECISION_RETENTION_DAYS;
	assert.ok(
		perWindow < DECISION_LOG_MAX_BYTES,
		`a ${bytes}-byte row would need ${perWindow} bytes against a ${DECISION_LOG_MAX_BYTES} cap`
	);
});
