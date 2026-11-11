import { test } from 'node:test';
import assert from 'node:assert/strict';

import { QUALIFY_DRAIN_REASON_PREFIX, proofDrainState } from './proof-drain.mjs';
import { refusal, runQualification } from './qualify-runner.mjs';

const NODE = 'claw-fixture';
const CLAW = { role: 'claw', maxConcurrent: 2 };

/** A fleet of fakes: drains in memory, a settable clock, every remote call logged. */
function rig({ drains = {}, quiet = true, runOnReply = null } = {}) {
	const calls = [];
	let clock = 1_000_000;
	const deps = {
		readDrains: () => ({ ...drains }),
		isDrained: (n) => Boolean(drains[n]),
		drain: (n, row) => {
			calls.push(['drain', n, row.kind, row.reason]);
			drains[n] = row;
			return { ok: true };
		},
		undrain: (n) => {
			calls.push(['undrain', n]);
			delete drains[n];
			return { ok: true };
		},
		waitQuiet: async () =>
			quiet ? { drained: true } : { drained: false, reason: 'timed out after 45 min' },
		runOn: async (n, script, o) => {
			calls.push(['runOn', n, o.as, script.split('\n')[0]]);
			if (runOnReply) return runOnReply(script);
			if (script.includes('mktemp -d'))
				return { ok: true, stdout: 'SAMPLER /tmp/qualify-sample.abc123\n' };
			if (script.includes('touch "$d/stop"'))
				return {
					ok: true,
					stdout: 'S 1 cpu10=1 cpu300=2 io10=0 mem10=0 workers=0 throttle=0\nE\nSAMPLER-END\n',
				};
			return { ok: true, stdout: 'ok\n' };
		},
		proveJob: async (args) => {
			calls.push(['proveJob', ...args]);
			return {
				doc: {
					ok: true,
					verdict: 'pass',
					runId: 7,
					durationSec: 600,
					jobConclusion: 'success',
					ranOnTarget: true,
				},
			};
		},
		now: () => clock,
	};
	return { deps, calls, drains, advance: (min) => (clock += min * 60_000) };
}

const T = (id, run, extra = {}) => ({
	id,
	track: 'qualify',
	needsDrain: true,
	runsAs: 'ci',
	ttlDays: 21,
	minutes: 10,
	run,
	...extra,
});

const go = (r, tests, extra = {}) =>
	runQualification({
		node: NODE,
		machine: CLAW,
		manifest: { machines: { [NODE]: CLAW } },
		tests,
		windowMinutes: 60,
		log: () => {},
		deps: r.deps,
		...extra,
	});

void test('the backstop is never qualified, and nothing is drained', async () => {
	const r = rig();
	const out = await go(r, [T('a', async () => ({ status: 'pass', reason: 'x' }))], {
		machine: { role: 'backstop' },
	});
	assert.equal(out.status, 'refused');
	assert.match(out.reason, /hokon remains the backstop/);
	assert.deepEqual(r.calls, []);
});

void test('a node someone else already holds is refused, not measured under their drain', async () => {
	const r = rig({ drains: { [NODE]: { kind: 'maintenance', reason: 'operator: new fan' } } });
	const out = await go(r, [T('a', async () => ({ status: 'pass', reason: 'x' }))]);
	assert.equal(out.status, 'refused');
	assert.match(out.reason, /already drained \(kind=maintenance/);
	assert.deepEqual(r.calls, [], 'it drained or ran something anyway');
});

void test('one qualification at a time, fleet-wide', () => {
	const drains = {
		'claw-other': { kind: 'training', reason: `${QUALIFY_DRAIN_REASON_PREFIX} concurrency-ramp` },
	};
	assert.match(refusal({ node: NODE, machine: CLAW, drains }), /claw-other is being qualified now/);
	// A bootcamp canary elsewhere is not a qualification.
	assert.equal(
		refusal({
			node: NODE,
			machine: CLAW,
			drains: { x: { kind: 'training', reason: 'fleet bootcamp --prove: jdk21' } },
		}),
		null
	);
});

void test('an empty playlist is could-not-look, never a pass, and drains nothing', async () => {
	const r = rig();
	const out = await go(r, []);
	assert.equal(out.status, 'could-not-look');
	assert.match(out.reason, /no qualification tests are registered/);
	assert.deepEqual(r.calls, []);
});

void test('a test that breaks the contract stops the window before it opens', async () => {
	const r = rig();
	const out = await go(r, [{ id: 'Bad Id', track: 'qualify', run: () => {} }]);
	assert.equal(out.status, 'could-not-look');
	assert.match(
		out.reason,
		/playlist breaks the test contract: Bad Id: id must be a kebab-case string/
	);
	assert.deepEqual(r.calls, []);
});

void test('the window drains with the qualify prefix, runs every test HELD, and undrains', async () => {
	const r = rig();
	const seen = [];
	const out = await go(r, [
		T('a', async () => {
			seen.push(r.drains[NODE]?.reason);
			return { status: 'pass', reason: 'held 15 min at 20%', metrics: { k: 2 } };
		}),
		T('b', async () => ({ status: 'fail', reason: 'package hit 96 °C at k=3' })),
	]);
	assert.equal(out.status, 'ran');
	assert.deepEqual(
		out.results.map((x) => [x.id, x.status]),
		[
			['a', 'pass'],
			['b', 'fail'],
		]
	);
	assert.deepEqual(out.results[0].metrics, { k: 2 });
	assert.ok(seen[0]?.startsWith(QUALIFY_DRAIN_REASON_PREFIX), `ran outside the drain: ${seen[0]}`);
	assert.deepEqual(r.calls.at(-1), ['undrain', NODE]);
	assert.deepEqual(r.drains, {}, 'the node was left out of service');
	// The drain it took is one prove-job --under-own-drain accepts.
	assert.deepEqual(proofDrainState({ kind: 'training', reason: r.calls[0][3] }, true), {
		drained: false,
	});
});

void test('a test that throws is could-not-look with its reason; the rest still run and the node comes back', async () => {
	const r = rig();
	const out = await go(r, [
		T('boom', async () => {
			throw new Error('ssh: connection reset');
		}),
		T('after', async () => ({ status: 'pass', reason: 'fine' })),
	]);
	assert.deepEqual(out.results[0], {
		id: 'boom',
		status: 'could-not-look',
		reason: 'the test threw: ssh: connection reset',
		metrics: {},
	});
	assert.equal(out.results[1].status, 'pass');
	assert.deepEqual(r.drains, {});
});

void test('a result outside the contract is could-not-look, never passed through', async () => {
	const r = rig();
	const out = await go(r, [
		T('no-reason', async () => ({ status: 'pass' })),
		T('odd-status', async () => ({ status: 'ok', reason: 'x' })),
	]);
	assert.match(out.results[0].reason, /returned pass with no reason/);
	assert.match(out.results[1].reason, /returned status "ok"/);
	assert.ok(out.results.every((x) => x.status === 'could-not-look'));
});

void test('a test that would overrun the window is not started, and says so', async () => {
	const r = rig();
	const out = await go(r, [
		T('long', async () => {
			r.advance(55);
			return { status: 'pass', reason: 'done' };
		}),
		T('next', async () => assert.fail('started past the window'), { minutes: 10 }),
	]);
	assert.equal(out.results[1].status, 'could-not-look');
	assert.match(
		out.results[1].reason,
		/not started: 55 min used, it budgets 10, and the window is 60/
	);
});

void test('a node that never goes quiet: the window never opens, every test could-not-look, drain lifted', async () => {
	const r = rig({ quiet: false });
	const out = await go(r, [T('a', async () => assert.fail('ran on a busy node'))]);
	assert.equal(out.status, 'could-not-look');
	assert.match(out.reason, /window never opened: never went quiet: timed out after 45 min/);
	assert.equal(out.results[0].status, 'could-not-look');
	assert.deepEqual(r.drains, {});
});

void test('ctx.exec acts as the role the test declares', async () => {
	const r = rig();
	await go(r, [
		T(
			'as-admin',
			async (ctx) => {
				await ctx.exec('true');
				return { status: 'pass', reason: 'x' };
			},
			{ runsAs: 'admin' }
		),
	]);
	assert.deepEqual(r.calls.find((c) => c[0] === 'runOn').slice(1, 3), [NODE, 'admin']);
});

void test('mintJob runs `count` real jobs on this node under the window, recording nothing', async () => {
	const r = rig();
	let runs;
	await go(r, [
		T('mint', async (ctx) => {
			runs = await ctx.mintJob({ repo: 'WolffM/x', workflow: 'ci.yml', job: 'test', count: 3 });
			return { status: 'pass', reason: 'x' };
		}),
	]);
	const proves = r.calls.filter((c) => c[0] === 'proveJob');
	assert.equal(proves.length, 3);
	for (const p of proves) {
		assert.equal(p[p.indexOf('--node') + 1], NODE);
		assert.ok(p.includes('--under-own-drain') && p.includes('--no-record'), p.join(' '));
	}
	assert.deepEqual(runs[0], {
		ok: true,
		verdict: 'pass',
		runId: 7,
		durationSec: 600,
		jobConclusion: 'success',
		ranOnTarget: true,
		reason: 'pass',
	});
});

void test('a sampler the test never stopped is stopped by the runner, even when the test throws', async () => {
	const r = rig();
	await go(r, [
		T('leaky', async (ctx) => {
			await ctx.sample({ everySec: 5 });
			throw new Error('mid-step failure');
		}),
	]);
	const remote = r.calls.filter((c) => c[0] === 'runOn').map((c) => c[3]);
	assert.equal(remote.length, 2, 'started and stopped');
	assert.ok(
		r.calls.some((c) => c[0] === 'runOn') && remote[1].startsWith("d='/tmp/qualify-sample.abc123'")
	);
});

void test('a stopped sampler returns parsed rows', async () => {
	const r = rig();
	let rows;
	await go(r, [
		T('sampled', async (ctx) => {
			const s = await ctx.sample();
			rows = await s.stop();
			return { status: 'pass', reason: 'x' };
		}),
	]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].cpuSome300, 2);
});

void test('--dry-run drains nothing, runs nothing, and says what would not fit', async () => {
	const r = rig();
	const out = await go(
		r,
		[
			T('a', async () => assert.fail('ran'), { minutes: 50 }),
			T('b', async () => assert.fail('ran'), { minutes: 20 }),
		],
		{ dryRun: true }
	);
	assert.equal(out.status, 'dry-run');
	assert.match(out.results[1].reason, /would NOT start \(70 min > the 60-min window\)/);
	assert.deepEqual(r.calls, []);
});
