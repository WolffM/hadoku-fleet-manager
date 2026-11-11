/**
 * The simulator's `tuned` policy (one technique per switch) and its what-ifs,
 * each on a tick or a workload small enough to work out by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PendingRun } from '../runners/dispatcher.js';
import type { NodeState } from '../runners/placement-node-state.js';
import type { SimTick } from '../runners/sim-engine.js';
import { tunedPolicy } from '../runners/sim-tuned.js';
import { applyWhatIfs } from '../runners/sim-whatif.js';
import type { Corpus, SimJob } from '../runners/sim-corpus.js';
import type { SimNodeSpec } from '../runners/sim-fleet.js';

const T0 = Date.parse('2026-11-01T00:00:00Z');
const PLAIN = ['self-hosted', 'hadoku-builder'];
const JDK = [...PLAIN, 'jdk21'];

const ns = (name: string, labels: string[], over: Partial<NodeState> = {}): NodeState => ({
	name,
	healthy: true,
	eligible: true,
	drained: false,
	schedulable: true,
	labels,
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 4,
	freeMb: 20_000,
	requiredMb: 900,
	minFreeMb: 1536,
	...over,
});
const pr = (jobId: number, labels: string[], queuedSinceMs = T0): PendingRun => ({
	id: jobId,
	jobId,
	repo: 'WolffM/hadoku_site',
	repository: { full_name: 'WolffM/hadoku_site' },
	head_repository: { full_name: 'WolffM/hadoku_site', fork: false },
	event: 'push',
	labels,
	jobName: 'check',
	queuedSinceMs,
});
const tick = (over: Partial<SimTick>): SimTick => ({
	nowMs: T0 + 60_000,
	nodes: [],
	order: [],
	pending: [],
	estimate: () => null,
	...over,
});
const placed = (plan: { mint: { jobId: number; node: string }[] }) =>
	Object.fromEntries(plan.mint.map((m) => [m.jobId, m.node]));

test('tuned: an unknown parameter is refused, never silently ignored', () => {
	assert.throws(() => tunedPolicy({ narowFirst: 1 } as never), /unknown parameter narowFirst/);
});

test('tuned order=1: the oldest job takes the one slot, whatever order the queue came in', () => {
	const t = tick({
		nodes: [ns('claw-1', PLAIN, { maxConcurrent: 1 })],
		order: ['claw-1'],
		pending: [pr(1, PLAIN, T0 + 30_000), pr(2, PLAIN, T0)],
	});
	assert.deepEqual(placed(tunedPolicy({ order: 1 }).plan(t)), { 2: 'claw-1' });
	assert.deepEqual(placed(tunedPolicy().plan(t)), { 1: 'claw-1' }, 'default keeps the queue order');
});

test('tuned order=2: the job expected to hold its slot shortest goes first', () => {
	const t = tick({
		nodes: [ns('claw-1', PLAIN, { maxConcurrent: 1 })],
		order: ['claw-1'],
		pending: [pr(1, PLAIN), pr(2, PLAIN)],
		estimate: (jobId) => (jobId === 1 ? 900 : 60),
	});
	assert.deepEqual(placed(tunedPolicy({ order: 2 }).plan(t)), { 2: 'claw-1' });
});

test('tuned narrowFirst=1: plain jobs listed ahead do not fill both jdk21 claws', () => {
	const t = tick({
		nodes: [
			ns('claw-9', JDK, { maxConcurrent: 1 }),
			ns('claw-8', JDK, { maxConcurrent: 1 }),
			ns('claw-1', PLAIN, { liveUnits: 1, maxConcurrent: 3 }),
		],
		order: ['claw-9', 'claw-8', 'claw-1'],
		pending: [pr(1, PLAIN), pr(2, PLAIN), pr(3, JDK)],
	});
	assert.deepEqual(placed(tunedPolicy({ narrowFirst: 1 }).plan(t)), {
		1: 'claw-8',
		2: 'claw-1',
		3: 'claw-9',
	});
	assert.deepEqual(placed(tunedPolicy().plan(t)), { 1: 'claw-9', 2: 'claw-8' });
});

test('tuned kindPlacement=1: a job goes where its kind runs fastest, not where it is least busy', () => {
	const t = tick({
		nodes: [ns('claw-1', PLAIN), ns('claw-8', PLAIN, { liveUnits: 2 })],
		order: ['claw-1', 'claw-8'],
		pending: [pr(1, PLAIN)],
		estimate: (_jobId, node) => (node === 'claw-8' ? 100 : 300),
	});
	assert.deepEqual(placed(tunedPolicy({ kindPlacement: 1 }).plan(t)), { 1: 'claw-8' });
	assert.deepEqual(placed(tunedPolicy().plan(t)), { 1: 'claw-1' }, 'default: fewest busy');
	const full = tick({ ...t, nodes: [ns('claw-1', PLAIN), ns('claw-8', PLAIN, { liveUnits: 4 })] });
	assert.deepEqual(
		placed(tunedPolicy({ kindPlacement: 1 }).plan(full)),
		{ 1: 'claw-1' },
		'fastest is full: next'
	);
});

test('tuned warm=0: replayed warm slots take nothing', () => {
	assert.equal(tunedPolicy({ warm: 0 }).warmAllowed!('claw-1'), false);
	assert.equal(tunedPolicy().warmAllowed!('claw-1'), true);
});

const job = (key: number, over: Partial<SimJob> = {}): SimJob => ({
	key,
	repo: 'WolffM/hadoku-cardtable',
	runId: key,
	jobId: key,
	name: 'forge-e2e (2)',
	labels: JDK,
	event: 'schedule',
	arrivalMs: T0,
	workSec: 100,
	setupSec: 0,
	runSec: 100,
	cleanupSec: 0,
	assignSec: 5,
	histNode: 'claw-9',
	histClass: 'jit',
	histQueueSec: 0,
	histStartMs: T0,
	...over,
});
const corpus = (jobs: SimJob[]): Corpus => ({
	jobs,
	hosted: 0,
	unattributed: 0,
	noQueueSec: 0,
	noPhases: 0,
	duplicates: 0,
	firstArrivalMs: T0,
	lastArrivalMs: T0,
});
const spec = (name: string): SimNodeSpec => ({
	name,
	labels: JDK,
	backstop: false,
	excludeRepos: new Map(),
	idleFreeMb: 30_000,
	mbPerJob: { light: 500, heavy: 1000 },
	timeline: [],
});

test('what-if: without removes nodes, clone adds one, and a name that is not there is refused', () => {
	const fleet = [spec('claw-1'), spec('claw-3'), spec('claw-9')];
	const w = applyWhatIfs(corpus([]), fleet, {
		without: ['claw-1,claw-3'],
		clone: ['claw-9=claw-11'],
	});
	assert.deepEqual(
		w.fleet.map((s) => s.name),
		['claw-9', 'claw-11']
	);
	assert.deepEqual(w.notes, ['without claw-1', 'without claw-3', 'claw-11 cloned from claw-9']);
	assert.throws(() => applyWhatIfs(corpus([]), fleet, { without: ['claw-7'] }), /no such node/);
	assert.throws(
		() => applyWhatIfs(corpus([]), fleet, { clone: ['claw-9=claw-1'] }),
		/existing=new/
	);
});

test('what-if: drop removes jobs matching EVERY term; a spec that matches nothing is refused', () => {
	const c = corpus([job(1), job(2, { event: 'push' }), job(3, { labels: PLAIN })]);
	const w = applyWhatIfs(c, [], { drop: ['event=schedule,label=jdk21'] });
	assert.deepEqual(
		w.corpus.jobs.map((j) => j.key),
		[2, 3]
	);
	assert.deepEqual(w.notes, ['dropped 1 jobs matching event=schedule,label=jdk21']);
	assert.deepEqual(applyWhatIfs(c, [], { drop: ['name=forge'] }).corpus.jobs, []);
	assert.throws(() => applyWhatIfs(c, [], { drop: ['repo=WolffM/nothing'] }), /matched no job/);
	assert.throws(
		() => applyWhatIfs(c, [], { drop: ['colour=red'] }),
		/keys event, label, repo, name/
	);
	assert.equal(applyWhatIfs(c, [], {}).corpus, c, 'no what-if: the corpus untouched');
});
