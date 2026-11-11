/**
 * Narrower queued work keeps its nodes (2026-11-11): the dispatcher walks
 * runs with fewer label-homes first, and while a narrower run waits, a run
 * that could go elsewhere ranks that run's homes last. Built from the queue
 * and the nodes' labels alone; no label is named in the rule.
 *
 * Measured before it: in 52% of the minutes a jdk21 job waited (11-09 16Z to
 * 11-11 16Z), plain jobs held slots on jdk21 claws while claws without jdk21
 * had free ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	homesOf,
	narrowerDemand,
	narrowestFirst,
	planTick,
	type PendingRun,
} from '../runners/dispatcher.js';
import { type NodeState } from '../runners/placement-node-state.js';

const NOW = 1_787_797_008_000;
const NONE = { jobIds: new Set<number>(), runIds: new Set<number>() };
const PLAIN = ['self-hosted', 'hadoku-builder'];
const JDK = [...PLAIN, 'jdk21'];

const node = (name: string, labels: string[], over: Partial<NodeState> = {}): NodeState => ({
	name,
	healthy: true,
	eligible: true,
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 2,
	freeMb: 8000,
	requiredMb: 900,
	minFreeMb: 1536,
	labels,
	...over,
});

const run = (id: number, labels: string[], over: Partial<PendingRun> = {}): PendingRun => ({
	id,
	jobId: id * 100,
	repo: 'WolffM/hadoku_site',
	repository: { full_name: 'WolffM/hadoku_site' },
	head_repository: { full_name: 'WolffM/hadoku_site', fork: false },
	event: 'push',
	labels,
	...over,
});

/** A run no node can take this tick: every jdk21 node is full. */
const fleet = () => [
	node('claw-9', JDK, { maxConcurrent: 4, standingBusy: 1 }),
	node('claw-2', PLAIN, { standingBusy: 1 }),
];
/** claw-9 is the least busy and first in the baseline order. */
const ORDER = ['claw-9', 'claw-2'];

test('narrowestFirst: runs are walked by how many nodes can serve them, fewest first, stable', () => {
	const nodes = [node('a', JDK), node('b', JDK), node('c', PLAIN), node('d', PLAIN)];
	const order = narrowestFirst([run(1, PLAIN), run(2, JDK), run(3, PLAIN), run(4, JDK)], nodes).map(
		(r) => r.id
	);
	assert.deepEqual(order, [2, 4, 1, 3]);
	// REVERTED (only one-home runs first): [1, 2, 3, 4] — two homes are not one.
});

test('end to end: a plain run listed AHEAD of a jdk21 run does not take the one jdk21 slot', () => {
	// GitHub's order puts the plain run first; claw-9 has one slot and is the
	// least busy node, so a walk in arrival order with busy first gives it to
	// the plain run and leaves the jdk21 run with nowhere to go.
	const nodes = [
		node('claw-9', JDK, { maxConcurrent: 1 }),
		node('claw-2', PLAIN, { standingBusy: 1 }),
	];
	const p = planTick([run(2, PLAIN), run(1, JDK)], nodes, ORDER, NONE, NOW);
	const where = Object.fromEntries(p.mint.map((m) => [m.runId, m.node]));
	assert.deepEqual(where, { 1: 'claw-9', 2: 'claw-2' });
	assert.equal(p.skipped.length, 0);
});

test('while the narrower run still WAITS, the plain run ranks its homes last', () => {
	// claw-9 refuses the jdk21 run on memory (it needs more than claw-9 can
	// spare now), so the jdk21 run waits; the plain run must not take claw-9
	// while claw-2 has room, or the jdk21 run waits behind it next tick too.
	const nodes = [
		node('claw-9', JDK, { maxConcurrent: 4 }),
		node('claw-2', PLAIN, { standingBusy: 1 }),
	];
	const jdk = run(1, JDK, { repo: 'WolffM/hadoku-cardtable' });
	const ns = nodes.map((n) =>
		n.name === 'claw-9'
			? { ...n, excludedRepos: new Map([['WolffM/hadoku-cardtable', 'held for this test']]) }
			: n
	);
	const p = planTick([jdk, run(2, PLAIN)], ns, ORDER, NONE, NOW);
	assert.deepEqual(
		p.mint.map((m) => [m.runId, m.node]),
		[[2, 'claw-2']]
	);
	assert.equal(p.skipped[0].jobId, 100, 'the jdk21 run waits');
	// REVERTED (no narrower-demand term): [[2, 'claw-9']] — fewest busy wins.
});

test('the plain run still takes the narrower run’s node when nothing else will', () => {
	const nodes = [
		node('claw-9', JDK, { maxConcurrent: 4 }),
		node('claw-2', PLAIN, { maxConcurrent: 1, standingBusy: 1 }),
	].map((n) =>
		n.name === 'claw-9'
			? { ...n, excludedRepos: new Map([['WolffM/hadoku-cardtable', 'held for this test']]) }
			: n
	);
	const p = planTick(
		[run(1, JDK, { repo: 'WolffM/hadoku-cardtable' }), run(2, PLAIN)],
		nodes,
		ORDER,
		NONE,
		NOW
	);
	assert.deepEqual(
		p.mint.map((m) => [m.runId, m.node]),
		[[2, 'claw-9']],
		'a rank, never a refusal: the plain run is not left queued beside a free slot'
	);
});

test('with no narrower run queued, placement is exactly as before', () => {
	const p = planTick([run(2, PLAIN)], fleet(), ORDER, NONE, NOW);
	// claw-9 (busy 1 of 4) ties claw-2 (busy 1 of 2) on busy; baseline order wins.
	assert.deepEqual(
		p.mint.map((m) => [m.runId, m.node]),
		[[2, 'claw-9']]
	);
});

test('a narrower run that was placed this pass stops reserving its homes', () => {
	// One jdk21 run, placed on claw-9 first; claw-9 still has three free slots
	// and nothing else waits for them, so the plain run may use one.
	const nodes = [
		node('claw-9', JDK, { maxConcurrent: 4 }),
		node('claw-2', PLAIN, { standingBusy: 1 }),
	];
	const p = planTick([run(1, JDK), run(2, PLAIN)], nodes, ORDER, NONE, NOW);
	assert.deepEqual(
		p.mint.map((m) => [m.runId, m.node]),
		[
			[1, 'claw-9'],
			[2, 'claw-9'],
		],
		'busy ties at 1, and with nothing narrower waiting the baseline order decides again'
	);
	// REVERTED (a placed run still reserves): [2, 'claw-2'].
	const homes = new Map([
		[run(1, JDK), new Set(['claw-9'])],
		[run(2, PLAIN), new Set(['claw-9', 'claw-2'])],
	]);
	const [jdkRun, plainRun] = [...homes.keys()];
	assert.deepEqual([...narrowerDemand(plainRun, [jdkRun, plainRun], homes)], ['claw-9']);
	assert.deepEqual([...narrowerDemand(plainRun, [plainRun], homes)], [], 'placed: gone');
});

test('narrowerDemand: a peer or an overlapping run reserves nothing — only a strict subset does', () => {
	const hokon = node('hokon', ['self-hosted', 'pm2-host']);
	const promoted = node('hokon', ['self-hosted', 'hadoku-builder', 'pm2-host']);
	const claws = [node('claw-1', PLAIN), node('claw-2', PLAIN)];
	const plain = run(1, PLAIN);
	const pm2 = run(2, ['self-hosted', 'pm2-host']);
	const peer = run(3, PLAIN);

	// hokon not promoted: pm2's homes {hokon} are not inside plain's {claw-1, claw-2}.
	let homes = new Map([plain, pm2, peer].map((r) => [r, homesOf(r, [hokon, ...claws])] as const));
	assert.deepEqual([...narrowerDemand(plain, [plain, pm2, peer], homes)], []);

	// hokon promoted to hadoku-builder: now {hokon} IS inside plain's homes,
	// so a plain run leaves hokon to the pm2-host run while a claw has room.
	homes = new Map([plain, pm2, peer].map((r) => [r, homesOf(r, [promoted, ...claws])] as const));
	assert.deepEqual([...narrowerDemand(plain, [plain, pm2, peer], homes)], ['hokon']);
	assert.deepEqual([...narrowerDemand(pm2, [plain, pm2, peer], homes)], [], 'nothing is narrower');
});
