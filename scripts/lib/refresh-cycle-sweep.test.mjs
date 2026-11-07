/**
 * The refresh cycle's CACHE SWEEP turn (fleet-manager#65), against fixtures.
 * A node busy at every nightly pass is drained for a sweep by the same rules as
 * every other turn: one at a time, never under queue pressure, never someone
 * else's hold, and put back on every path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runRefreshCycle } from './refresh-cycle.mjs';
import { judgeSweep } from './refresh-cycle-live.mjs';
import { CLAW, TASKAUTO, harness, seenFor } from './refresh-cycle-fixtures.mjs';

/** Sweep deps over a harness. `due[node]` is how long it has gone unswept. */
function withSweep(h, { due = {}, fail = false, throws = false, stillBusy = false } = {}) {
	const calls = [];
	return {
		calls,
		sweepDue: (node) => (due[node] ? { due: true, days: due[node] } : { due: false, days: 0 }),
		sweepCaches: async (node) => {
			h.events.push(`sweep ${node}`);
			assert.ok(h.drained.has(node), 'SWEPT A NODE THAT IS NOT DRAINED');
			assert.equal(h.state.held, node, 'state.held does not name the node we hold');
			calls.push(node);
			if (throws) throw new Error('ssh died');
			if (fail) return { ok: false, reason: 'unreachable' };
			return { ok: true, swept: !stillBusy, reclaimGb: 1.3 };
		},
	};
}

const current = (...names) => {
	const machines = names.map((n) => [n, CLAW]);
	const world = Object.fromEntries(names.map((n) => [n, seenFor(CLAW)]));
	return { machines, world };
};

async function cycle(machines, world, sweepOpts, over = {}, opts = {}) {
	const h = harness(machines, world, over);
	const sw = withSweep(h, sweepOpts);
	const r = await runRefreshCycle({
		machines,
		deps: { ...h.deps, ...sw },
		state: h.state,
		...opts,
	});
	return { h, sw, r, node: (n) => r.nodes.find((x) => x.node === n) };
}

test('a current node unswept past due is drained, swept and put back, in that order', async () => {
	const { machines, world } = current('claw-a');
	const { h, r, node } = await cycle(machines, world, { due: { 'claw-a': 9 } });
	assert.deepEqual(h.events.slice(1), [
		'drain claw-a training',
		'wait claw-a',
		'sweep claw-a',
		'undrain claw-a',
	]);
	assert.equal(node('claw-a').status, 'swept');
	assert.equal(node('claw-a').reclaimGb, 1.3);
	assert.ok(!h.drained.has('claw-a'));
	assert.equal(r.ok, true);
});

test('a node that is not due is never drained for a sweep', async () => {
	const { machines, world } = current('claw-a');
	const { h, node } = await cycle(machines, world, { due: {} });
	assert.equal(node('claw-a').status, 'current');
	assert.ok(!h.events.some((e) => /^(drain|sweep)/.test(e)));
});

test('ONE sweep turn per run, the longest unswept first', async () => {
	const { machines, world } = current('claw-a', 'claw-b', 'claw-c');
	const { sw, node } = await cycle(machines, world, {
		due: { 'claw-a': 8, 'claw-b': 20, 'claw-c': 11 },
	});
	assert.deepEqual(sw.calls, ['claw-b']);
	assert.equal(node('claw-a').status, 'current', 'the next run picks it up');
});

test('a due node that already has a turn is swept inside it, and another still gets its own', async () => {
	const machines = [
		['claw-a', TASKAUTO],
		['claw-b', TASKAUTO],
	];
	const world = {
		'claw-a': seenFor(TASKAUTO, { claude: '2.1.284' }),
		'claw-b': seenFor(TASKAUTO),
	};
	const { h, sw, node } = await cycle(machines, world, { due: { 'claw-a': 9, 'claw-b': 9 } });
	assert.deepEqual(sw.calls, ['claw-a', 'claw-b']);
	const a = h.events.filter((e) => e.endsWith('claw-a'));
	assert.deepEqual(a.slice(-3), ['reprobe claw-a', 'sweep claw-a', 'undrain claw-a']);
	assert.equal(node('claw-a').status, 'updated');
	assert.equal(node('claw-b').status, 'swept');
});

test('a node with an update turn that is NOT due is not swept', async () => {
	const machines = [['claw-a', TASKAUTO]];
	const world = { 'claw-a': seenFor(TASKAUTO, { claude: '2.1.284' }) };
	const { sw } = await cycle(machines, world, { due: {} });
	assert.deepEqual(sw.calls, []);
});

test('BACK OFF under queue pressure: deferred, nothing drained or swept', async () => {
	const { machines, world } = current('claw-a');
	const { h, node } = await cycle(
		machines,
		world,
		{ due: { 'claw-a': 9 } },
		{ pressure: { pressured: true, reason: 'busy' } }
	);
	assert.equal(node('claw-a').status, 'deferred');
	assert.ok(!h.events.some((e) => /^(drain|sweep)/.test(e)));
});

test("someone else's drain is not ours: deferred, never swept, never lifted", async () => {
	const { machines, world } = current('claw-a');
	const { h, node } = await cycle(
		machines,
		world,
		{ due: { 'claw-a': 9 } },
		{ alreadyDrained: ['claw-a'] }
	);
	assert.equal(node('claw-a').status, 'deferred');
	assert.ok(h.drained.has('claw-a'), 'still held by its owner');
	assert.ok(!h.events.some((e) => /^(sweep|undrain)/.test(e)));
});

test('a node that never goes quiet is put back unswept, and that is a finding', async () => {
	const { machines, world } = current('claw-a');
	const { h, r } = await cycle(
		machines,
		world,
		{ due: { 'claw-a': 9 } },
		{ waitResult: { drained: false, reason: 'timed out' } }
	);
	assert.ok(!h.events.some((e) => e.startsWith('sweep')));
	assert.ok(!h.drained.has('claw-a'));
	assert.ok(r.findings.some((f) => f.kind === 'drain-timeout'));
});

test('a sweep that fails, throws, or still sees a job is a finding; the node is put back regardless', async () => {
	for (const opts of [{ fail: true }, { throws: true }, { stillBusy: true }]) {
		const { machines, world } = current('claw-a');
		const { h, r, node } = await cycle(machines, world, { due: { 'claw-a': 9 }, ...opts });
		assert.equal(node('claw-a').status, 'finding', JSON.stringify(opts));
		assert.ok(r.findings.some((f) => f.kind === 'cache-sweep-failed'));
		assert.ok(!h.drained.has('claw-a'), 'never a hold');
		assert.equal(h.state.held, null);
	}
});

test('--plan names the sweep and drains nothing', async () => {
	const { machines, world } = current('claw-a');
	const { h, node } = await cycle(machines, world, { due: { 'claw-a': 9 } }, {}, { plan: true });
	assert.equal(node('claw-a').status, 'planned');
	assert.equal(node('claw-a').sweep, true);
	assert.ok(!h.events.some((e) => /^(drain|sweep)/.test(e)));
});

test('no sweepCaches dependency means no sweep turn', async () => {
	const { machines, world } = current('claw-a');
	const h = harness(machines, world);
	const r = await runRefreshCycle({ machines, deps: h.deps, state: h.state });
	assert.equal(r.nodes[0].status, 'current');
	assert.ok(!h.events.some((e) => e.startsWith('drain')));
});

test('judgeSweep: the node own result decides, never the exit code', () => {
	const doc = (r) => JSON.stringify({ results: [{ machine: 'claw-a', ...r }], findings: [] });
	assert.deepEqual(
		judgeSweep('claw-a', doc({ ok: true, cachesSwept: true, reclaimKb: 1048576 }), 'exit 1'),
		{
			ok: true,
			swept: true,
			reclaimGb: 1,
		}
	);
	assert.equal(judgeSweep('claw-a', doc({ ok: true, cachesSwept: false }), 'exit 0').swept, false);
	assert.equal(judgeSweep('claw-a', doc({ ok: false, error: 'unreachable' }), 'exit 1').ok, false);
	assert.match(
		judgeSweep('claw-a', 'not json', 'exit 2').reason,
		/no result for claw-a \(exit 2\)/
	);
	assert.equal(
		judgeSweep('claw-a', doc({ ok: true }), 'exit 0').swept,
		false,
		'absent is not swept'
	);
});
