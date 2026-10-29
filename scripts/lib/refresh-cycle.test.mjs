/**
 * The refresh cycle's safety properties, against FIXTURES — no node, no ssh, no
 * registry. Every property has a test that fails without it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	RECHECK_DAYS,
	judgePressure,
	planNode,
	runRefreshCycle,
	runWorkItem,
	verdictAfter,
	waitUntilDrained,
} from './refresh-cycle.mjs';
import { REPAIRS, applicableRepairs, isVersionManaged } from './toolchain-floor.mjs';

const CLAW = { labels: [] };
const TASKAUTO = { labels: ['taskauto'] };
const GUEST = { role: 'guest', labels: ['taskauto'] };

const KNOWN = {
	status: 'known',
	version: '2.1.285',
	publishedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
};

/** A healthy probe for everything the node carries, claude at `claude`. */
function seenFor(entry, { claude = '2.1.285', rust = true, apt = {} } = {}) {
	const seen = {};
	for (const [id, t] of applicableRepairs(entry)) {
		const ok = id === 'rust' || id === 'rust-wasm32' ? rust : true;
		seen[id] = {
			detect: ok ? 'OK' : '',
			login: ok ? 'OK' : '',
			// Reachable under every runner PATH the probe read (#127).
			runner: '',
			// `claude` is the version under test; any OTHER version-managed tool
			// (the JDK, on every claw since 2026-10-24) reads as current.
			...(t.version ? { version: id === 'claude' ? claude : KNOWN.version } : {}),
			// An apt-tracked tool reports `installed|candidate|state`; current by default.
			...(t.apt ? { apt: apt[id] ?? '1.0.0|1.0.0|current' } : {}),
		};
	}
	return seen;
}

/**
 * A fleet of fixture nodes. `world[node]` is what a probe returns RIGHT NOW;
 * `update` mutates it the way a real install would, unless told to fail.
 */
function harness(machines, world, over = {}) {
	const events = [];
	const drained = new Set(over.alreadyDrained ?? []);
	const calls = { latest: 0 };
	let inFlight = 0;
	let maxInFlight = 0;
	const deps = {
		latest: async () => {
			calls.latest++;
			return over.latest ?? KNOWN;
		},
		detect: async (node, tools) => {
			events.push(`detect ${node}`);
			if (over.detectFails?.has(node)) return { ok: false, reason: 'ssh: no route' };
			assert.ok(
				tools.every(([id]) => REPAIRS[id]),
				'detect got a tool that is not declared'
			);
			(over.toolsSeen ??= {})[node] = tools.map(([id]) => id);
			return { ok: true, seen: structuredClone(world[node]) };
		},
		reprobe: async (node) => {
			events.push(`reprobe ${node}`);
			if (over.reprobeThrows) throw new Error('ssh died');
			if (over.reprobeUnreadable) return { ok: false, reason: 'unreadable after update' };
			return { ok: true, seen: structuredClone(world[node]) };
		},
		isDrained: async (node) => drained.has(node),
		drain: async (node, { kind }) => {
			events.push(`drain ${node} ${kind}`);
			if (over.drainFails) throw new Error('refused: would leave no node');
			if (kind === 'training') {
				assert.equal(drained.size, 0, 'a second node was drained while another was held');
			}
			drained.add(node);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
		},
		undrain: async (node) => {
			events.push(`undrain ${node}`);
			drained.delete(node);
			inFlight--;
			return { ok: !over.undrainFails, reason: 'write failed' };
		},
		waitDrained: async (node) => {
			events.push(`wait ${node}`);
			return over.waitResult ?? { drained: true };
		},
		update: async (node, work) => {
			events.push(`update ${node}`);
			assert.ok(drained.has(node), 'UPDATE RAN ON A NODE THAT IS NOT DRAINED');
			assert.equal(over.state.held, node, 'state.held does not name the node we hold');
			await new Promise((r) => setImmediate(r));
			if (over.updateThrows) throw new Error('curl: connection reset');
			return work.map((w) => {
				if (over.updateFails) return { id: w.id, ok: false, reason: 'install exited 1' };
				if (w.action === 'link') {
					if (over.linkFails)
						return { id: w.id, ok: false, reason: 'sudo: a password is required' };
					if (!over.updateNoEffect) {
						// The link makes the login-shell view the stock-PATH view.
						// The link lands in /usr/local/bin, which every runner PATH carries.
						const t = world[node][w.id];
						t.detect = 'OK';
						t.runner = '';
						t.version = t.loginversion ?? '';
					}
					return { id: w.id, ok: true };
				}
				if (over.breakOnUpdate) {
					for (const k of Object.keys(world[node])) world[node][k].detect = '';
				} else if (!over.updateNoEffect) {
					if (w.id === 'claude') world[node].claude.version = w.target;
					else if (world[node][w.id].apt) {
						const [, cand] = world[node][w.id].apt.split('|');
						world[node][w.id].apt = `${cand}|${cand}|current`;
					} else Object.assign(world[node][w.id], { detect: 'OK', runner: '' });
				}
				return { id: w.id, ok: true };
			});
		},
		queuePressure: async () => over.pressure ?? { pressured: false },
	};
	over.state = { held: null };
	const run = (opts = {}) => runRefreshCycle({ machines, deps, state: over.state, ...opts });
	return {
		run,
		deps,
		state: over.state,
		events,
		drained,
		calls,
		get maxInFlight() {
			return maxInFlight;
		},
		toolsSeen: () => over.toolsSeen,
	};
}

const two = () => [
	['claw-a', TASKAUTO],
	['claw-b', TASKAUTO],
];

test('only nodes with something to move are drained; a current node is never touched', async () => {
	const machines = two();
	const world = {
		'claw-a': seenFor(TASKAUTO, { claude: '2.1.285' }),
		'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }),
	};
	const h = harness(machines, world);
	const r = await h.run();
	assert.equal(r.ok, true);
	assert.deepEqual(
		r.nodes.map((n) => [n.node, n.status]),
		[
			['claw-a', 'current'],
			['claw-b', 'updated'],
		]
	);
	assert.ok(!h.events.some((e) => /^(drain|undrain|update) claw-a/.test(e)), h.events.join('\n'));
	assert.equal(world['claw-b'].claude.version, '2.1.285');
});

test('the happy path is drain -> wait -> update -> reprobe -> undrain, in that order', async () => {
	const world = { 'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }) };
	const h = harness([['claw-b', TASKAUTO]], world);
	await h.run();
	assert.deepEqual(
		h.events.filter((e) => !e.startsWith('detect')),
		['drain claw-b training', 'wait claw-b', 'update claw-b', 'reprobe claw-b', 'undrain claw-b']
	);
});

test('a node that never goes quiet is undrained and NOT updated — a finding, not a pass', async () => {
	const world = { 'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }) };
	const h = harness([['claw-b', TASKAUTO]], world, {
		waitResult: { drained: false, reason: 'not drained after 2700000 ms: 1 job(s) running' },
	});
	const r = await h.run();
	assert.ok(!h.events.includes('update claw-b'), 'updated a node that was still draining');
	assert.ok(h.events.includes('undrain claw-b'), 'left a timed-out node drained');
	assert.equal(r.ok, false);
	assert.equal(r.findings[0].kind, 'drain-timeout');
	assert.match(r.findings[0].reason, /1 job\(s\) running/);
	assert.equal(world['claw-b'].claude.version, '2.1.284');
});

test('waitUntilDrained: draining is not drained, unknown is busy, zero must HOLD past the settle', async () => {
	let t = 0;
	const clock = { now: () => t, sleep: async (ms) => void (t += ms) };
	// Busy, busy, then zero — but a stray zero between jobs must not count.
	const seq = [2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
	let i = 0;
	const r = await waitUntilDrained({
		node: 'n',
		busy: async () => seq[Math.min(i++, seq.length - 1)],
		clock,
		timeoutMs: 600_000,
		pollMs: 10_000,
		settleMs: 30_000,
	});
	assert.equal(r.drained, true);
	assert.ok(i >= 7, `declared drained after only ${i} readings — the early zero counted`);

	t = 0;
	const unknown = await waitUntilDrained({
		node: 'n',
		busy: async () => null,
		clock,
		timeoutMs: 60_000,
		pollMs: 10_000,
		settleMs: 0,
	});
	assert.equal(unknown.drained, false, 'could-not-look was read as idle');
	assert.match(unknown.reason, /could not count/);

	t = 0;
	const stuck = await waitUntilDrained({
		node: 'n',
		busy: async () => 3,
		clock,
		timeoutMs: 60_000,
		pollMs: 10_000,
		settleMs: 0,
	});
	assert.equal(stuck.drained, false);
	assert.match(stuck.reason, /3 job\(s\) running/);
});

test('UNDRAIN ON FAILURE: an update that throws, or exits 1 and moves nothing, still puts the node back', async () => {
	for (const over of [{ updateThrows: true, updateNoEffect: true }, { updateFails: true }]) {
		const world = { 'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }) };
		const h = harness([['claw-b', TASKAUTO]], world, over);
		const r = await h.run();
		assert.ok(h.events.includes('undrain claw-b'), `left drained after ${JSON.stringify(over)}`);
		assert.equal(h.drained.size, 0);
		assert.equal(r.ok, false);
		assert.equal(r.nodes[0].status, 'update-failed');
		assert.equal(r.findings[0].kind, 'update-failed');
	}
});

test('a drain that is refused is a finding and nothing is updated', async () => {
	const world = { 'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }) };
	const h = harness([['claw-b', TASKAUTO]], world, { drainFails: true });
	const r = await h.run();
	assert.ok(!h.events.includes('update claw-b'));
	assert.equal(r.findings[0].kind, 'drain-failed');
	assert.match(r.findings[0].reason, /would leave no node/);
});

test('STAY DRAINED: a node that fails its re-probe is held as maintenance, never undrained, and the cycle halts', async () => {
	const machines = two();
	const world = {
		'claw-a': seenFor(TASKAUTO, { claude: '2.1.284' }),
		'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }),
	};
	const h = harness(machines, world, { breakOnUpdate: true });
	const r = await h.run();
	assert.ok(!h.events.includes('undrain claw-a'), 'undrained a node whose re-probe failed');
	assert.ok(h.events.includes('drain claw-a maintenance'), 'not re-held for a human');
	assert.ok(h.drained.has('claw-a'));
	assert.equal(r.nodes[0].status, 'held');
	assert.equal(r.findings[0].kind, 'reprobe-failed');
	assert.match(r.findings[0].reason, /STAYS DRAINED/);
	// The second node is NOT started behind a broken one.
	assert.equal(r.nodes[1].status, 'deferred');
	assert.ok(!h.events.includes('drain claw-b training'));
	assert.equal(r.ok, false);
});

test('STAY DRAINED also when the re-probe cannot read the node, or throws', async () => {
	for (const over of [{ reprobeUnreadable: true }, { reprobeThrows: true }]) {
		const world = { 'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }) };
		const h = harness([['claw-b', TASKAUTO]], world, over);
		const r = await h.run();
		assert.ok(!h.events.includes('undrain claw-b'), JSON.stringify(over));
		assert.equal(r.nodes[0].status, 'held');
	}
});

test('ONE AT A TIME: never two nodes drained at once', async () => {
	const machines = [
		['claw-a', TASKAUTO],
		['claw-b', TASKAUTO],
		['claw-c', TASKAUTO],
	];
	const world = Object.fromEntries(
		machines.map(([n, e]) => [n, seenFor(e, { claude: '2.1.284' })])
	);
	const h = harness(machines, world);
	const r = await h.run();
	assert.equal(h.maxInFlight, 1);
	assert.deepEqual(
		r.nodes.map((n) => n.status),
		['updated', 'updated', 'updated']
	);
});

test('BACK OFF under queue pressure: deferred, nothing drained, and deferred is not ok-by-stealth', async () => {
	const world = { 'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }) };
	const h = harness([['claw-b', TASKAUTO]], world, {
		pressure: { pressured: true, reason: '3 run(s) waiting, oldest 240s' },
	});
	const r = await h.run();
	assert.ok(!h.events.some((e) => e.startsWith('drain')), 'drained under pressure');
	assert.equal(r.nodes[0].status, 'deferred');
	assert.match(r.nodes[0].reason, /queue under pressure/);
	assert.equal(r.deferred, 1);
	assert.equal(world['claw-b'].claude.version, '2.1.284', 'the node was not updated');
});

test('a queue we could not read is a FINDING and a deferral — could-not-look is not quiet', async () => {
	const world = { 'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }) };
	const h = harness([['claw-b', TASKAUTO]], world, {
		pressure: { pressured: true, unknown: true, reason: '2 repo queue(s) unreadable' },
	});
	const r = await h.run();
	assert.ok(!h.events.some((e) => e.startsWith('drain')));
	assert.equal(r.ok, false);
	assert.equal(r.findings[0].kind, 'queue-unreadable');
});

test('judgePressure: zombies are not pressure, stranded and old waiters are, unreadable is unknown', () => {
	const quiet = { queued: 0, oldest: 0, stranded: 0, zombie: 2, unreadable: 0 };
	assert.equal(judgePressure(quiet).pressured, false, 'two days-old zombies pinned the cycle off');
	assert.equal(judgePressure({ ...quiet, queued: 2, oldest: 10 }).pressured, false);
	assert.equal(judgePressure({ ...quiet, queued: 2, oldest: 120 }).pressured, true);
	assert.equal(judgePressure({ ...quiet, stranded: 1 }).pressured, true);
	const unread = judgePressure({ ...quiet, unreadable: 1 });
	assert.equal(unread.unknown, true);
	assert.equal(judgePressure({ error: 'cannot read the coverage roster' }).unknown, true);
	assert.equal(judgePressure(null).unknown, true);
});

test('A GUEST IS NEVER TOUCHED: not probed, not drained, not updated — and it is reported', async () => {
	const tripwire = new Proxy(
		{},
		{
			get: (_t, name) => async (node) => {
				if (name === 'latest') return KNOWN;
				assert.notEqual(node, 'hokon', `${String(name)} was called for the guest`);
				if (name === 'detect') return { ok: true, seen: seenFor(CLAW) };
				if (name === 'queuePressure') return { pressured: false };
				return undefined;
			},
		}
	);
	const r = await runRefreshCycle({
		machines: [
			['hokon', GUEST],
			// A fresh record, so claw-a gets no RECHECK turn — this test is about the guest.
			['claw-a', { ...CLAW, $capabilities: { at: new Date().toISOString() } }],
		],
		deps: tripwire,
	});
	assert.equal(r.nodes[0].status, 'guest');
	assert.equal(r.nodes[1].status, 'current');
});

test('ONLY guests selected is not a pass', async () => {
	const r = await runRefreshCycle({
		machines: [['hokon', GUEST]],
		deps: { latest: async () => KNOWN },
	});
	assert.equal(r.ok, false);
	assert.equal(r.findings[0].kind, 'nothing-looked-at');
});

test('COULD-NOT-LOOK IS NOT CURRENT: unknown upstream is a finding, nothing drained, even on a node that would otherwise be behind', async () => {
	const world = { 'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }) };
	const h = harness([['claw-b', TASKAUTO]], world, {
		latest: { status: 'unknown', reason: 'rate limited (HTTP 429); gave up after 2 attempt(s)' },
	});
	const r = await h.run();
	assert.equal(r.ok, false);
	assert.notEqual(r.nodes[0].status, 'current');
	assert.equal(r.findings[0].kind, 'unknown');
	assert.match(r.findings[0].reason, /rate limited/);
	assert.ok(!h.events.some((e) => e.startsWith('drain')));
});

test('COULD-NOT-LOOK IS NOT CURRENT: an unreadable node is a finding with the reason; expected-down is reported but is not', async () => {
	const world = { 'claw-a': seenFor(CLAW), 'claw-b': seenFor(CLAW) };
	const h = harness(
		[
			['claw-a', CLAW],
			['claw-b', CLAW],
		],
		world,
		{
			detectFails: new Set(['claw-a']),
		}
	);
	const r = await h.run();
	assert.equal(r.nodes[0].status, 'unreadable');
	assert.equal(r.findings[0].kind, 'unreadable');
	assert.match(r.findings[0].reason, /no route/);
	assert.equal(r.ok, false);

	const down = await runRefreshCycle({
		machines: [
			['claw-a', CLAW],
			['claw-b', CLAW],
		],
		deps: {
			latest: async () => KNOWN,
			detect: async (n) =>
				n === 'claw-a'
					? { ok: false, reason: 'drained for a fan swap', expectedDown: true }
					: { ok: true, seen: seenFor(CLAW) },
		},
	});
	assert.equal(down.nodes[0].status, 'expected-down');
	assert.equal(down.ok, true);
});

test('`when` FILTER: claude is not probed, not installed, and not a finding on a node without taskauto', async () => {
	const world = { 'claw-a': seenFor(CLAW), 'claw-b': seenFor(TASKAUTO, { claude: '2.1.285' }) };
	const h = harness(
		[
			['claw-a', CLAW],
			['claw-b', TASKAUTO],
		],
		world
	);
	const r = await h.run();
	assert.ok(
		!h.toolsSeen()['claw-a'].includes('claude'),
		'claude was probed on a non-taskauto node'
	);
	assert.ok(h.toolsSeen()['claw-b'].includes('claude'));
	assert.equal(r.ok, true);

	// Even with a probe that says claude is absent, a node that does not carry the
	// capability gets no work — planNode only sees applicableRepairs.
	const plan = planNode(applicableRepairs(CLAW), seenFor(CLAW), { claude: KNOWN, jdk21: KNOWN });
	assert.deepEqual(plan, { work: [], findings: [] });
});

test('an ABSENT version-managed tool is INSTALLED pinned to the cleared release; unknown upstream refuses to install unpinned', () => {
	const tools = applicableRepairs(TASKAUTO);
	const absent = { ...seenFor(TASKAUTO), claude: { detect: '', login: '' } };
	const p = planNode(tools, absent, { claude: KNOWN, jdk21: KNOWN });
	assert.deepEqual(
		p.work.map((w) => [w.id, w.action, w.target]),
		[['claude', 'install', '2.1.285']]
	);
	const blind = planNode(tools, absent, { claude: { status: 'unknown', reason: 'timed out' } });
	assert.deepEqual(blind.work, [], 'installed with no debounce answer');
	assert.match(blind.findings[0].reason, /timed out/);
});

test('REPAIR for a presence-only tool: claw-1s broken rust is repaired via REPAIRS.rust, and the re-probe confirms it', async () => {
	const world = { 'claw-1': seenFor(CLAW, { rust: false }) };
	const h = harness([['claw-1', CLAW]], world);
	const r = await h.run();
	const n = r.nodes[0];
	assert.deepEqual(
		n.work.map((w) => [w.id, w.action]),
		[
			['rust', 'repair'],
			['rust-wasm32', 'repair'],
		]
	);
	assert.equal(n.status, 'updated');
	assert.equal(world['claw-1'].rust.detect, 'OK');
	assert.ok(h.events.includes('undrain claw-1'));
});

test('a repair that leaves the tool absent STAYS DRAINED — the re-probe, not the installer, decides', async () => {
	const world = { 'claw-1': seenFor(CLAW, { rust: false }) };
	const h = harness([['claw-1', CLAW]], world, { updateNoEffect: true });
	const r = await h.run();
	assert.equal(r.nodes[0].status, 'held');
	assert.ok(!h.events.includes('undrain claw-1'));
});

test('an operator hold is not ours to lift: deferred, never drained or undrained', async () => {
	const world = { 'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }) };
	const h = harness([['claw-b', TASKAUTO]], world, { alreadyDrained: ['claw-b'] });
	const r = await h.run();
	assert.ok(!h.events.some((e) => /^(drain|undrain|update)/.test(e)), h.events.join('\n'));
	assert.equal(r.nodes[0].status, 'deferred');
	assert.ok(h.drained.has('claw-b'));
});

test('a failing undrain is loud', async () => {
	const world = { 'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }) };
	const h = harness([['claw-b', TASKAUTO]], world, { undrainFails: true });
	const r = await h.run();
	assert.equal(r.ok, false);
	assert.ok(r.findings.some((f) => f.kind === 'undrain-failed' && /STILL DRAINED/.test(f.reason)));
});

test('--plan detects and reports the work and drains NOTHING', async () => {
	const world = { 'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }) };
	const h = harness([['claw-b', TASKAUTO]], world);
	const r = await h.run({ plan: true });
	assert.equal(r.nodes[0].status, 'planned');
	assert.equal(r.nodes[0].work[0].target, '2.1.285');
	assert.ok(!h.events.some((e) => /^(drain|undrain|update|wait|reprobe)/.test(e)));
	assert.equal(world['claw-b'].claude.version, '2.1.284');
});

test('upstream is asked ONCE PER TOOL per run, not once per node', async () => {
	const machines = [
		['claw-a', TASKAUTO],
		['claw-b', TASKAUTO],
		['claw-c', TASKAUTO],
	];
	const world = Object.fromEntries(machines.map(([n, e]) => [n, seenFor(e)]));
	const h = harness(machines, world);
	await h.run({ plan: true });
	// One lookup per version-managed TOOL (claude, and the JDK every claw
	// carries since 2026-10-24) — never one per node.
	const tools = new Set(
		machines.flatMap(([, e]) =>
			applicableRepairs(e)
				.filter(([, t]) => isVersionManaged(t))
				.map(([id]) => id)
		)
	);
	assert.equal(tools.size, 2);
	assert.equal(h.calls.latest, tools.size);
});

test('verdictAfter: still-behind is STALE (unchanged, undrain), absent is BROKEN (hold)', () => {
	const tools = applicableRepairs(TASKAUTO);
	const work = [{ id: 'claude', action: 'update', target: '2.1.285' }];
	const latest = { claude: KNOWN, jdk21: KNOWN };
	assert.equal(
		verdictAfter(work, tools, seenFor(TASKAUTO, { claude: '2.1.285' }), latest).status,
		'ok'
	);
	assert.equal(
		verdictAfter(work, tools, seenFor(TASKAUTO, { claude: '2.1.284' }), latest).status,
		'stale'
	);
	assert.equal(
		verdictAfter(work, tools, { ...seenFor(TASKAUTO), claude: { detect: '', login: '' } }, latest)
			.status,
		'broken'
	);
});

test('converge-toolchain filters REPAIRS through applicableRepairs — claude must not be installed on every claw', async () => {
	const { readFileSync } = await import('node:fs');
	const { blankComments } = await import('./blank-comments.mjs');
	const src = blankComments(
		readFileSync(new URL('../converge-toolchain.mjs', import.meta.url), 'utf8')
	);
	assert.match(src, /applicableRepairs\s*\(\s*manifest\.machines/);
	assert.doesNotMatch(
		src,
		/Object\.entries\s*\(\s*REPAIRS\s*\)/,
		'an unfiltered walk of REPAIRS would converge a scoped tool onto nodes that do not carry its capability'
	);
});

test('converge-toolchain reads as ci and installs through installScript, never the raw repair', async () => {
	// claw-5, 2026-10-28: read as admin it called ci's jdk21/maven broken and
	// admin's docker fine, then ran REPAIRS[id].repair with no TARGET_VERSION
	// and died on `unbound variable`.
	const { readFileSync } = await import('node:fs');
	const { blankComments } = await import('./blank-comments.mjs');
	const src = blankComments(
		readFileSync(new URL('../converge-toolchain.mjs', import.meta.url), 'utf8')
	);
	assert.match(src, /byRole\(repairs\)/, 'each tool is read as its role');
	assert.match(src, /onNode\(node, `[^`]*`, \{ role \}\)/, 'one read per role');
	assert.match(src, /installScript\(id, version, \{ ciUser \}\)/);
	assert.match(src, /resolveInstallTarget\(/);
	assert.doesNotMatch(
		src,
		/REPAIRS\[id\]\.repair/,
		'the raw repair text has no version and no ci user'
	);
});

test('state.held names the node we hold so a signal can put it back — and is clear after undrain, and after a deliberate hold', async () => {
	const world = { 'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }) };
	const h = harness([['claw-b', TASKAUTO]], world);
	await h.run();
	assert.equal(h.state.held, null);

	const w2 = { 'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }) };
	const h2 = harness([['claw-b', TASKAUTO]], w2, { breakOnUpdate: true });
	await h2.run();
	assert.equal(h2.state.held, null, 'a deliberate hold must not be undone by a signal handler');
});

test('past the time budget no NEW node is started — deferred, not drained', async () => {
	const machines = two();
	const world = {
		'claw-a': seenFor(TASKAUTO, { claude: '2.1.284' }),
		'claw-b': seenFor(TASKAUTO, { claude: '2.1.284' }),
	};
	const h = harness(machines, world);
	let t = 0;
	const r = await h.run({ deadline: 1000, now: () => (t += 600) });
	assert.deepEqual(
		r.nodes.map((n) => n.status),
		['updated', 'deferred']
	);
	assert.match(r.nodes[1].reason, /time budget/);
	assert.ok(!h.events.includes('drain claw-b training'));
});

// ---------------------------------------------------------------------------
// PATH-ONLY REPAIR, AND NO DOWNGRADES (claw-8, 2026-09-30). The cycle planned a
// pinned install of 2.1.281 over a working 2.1.284 that only a login shell saw.
// ---------------------------------------------------------------------------

/** claw-8: the binary works under a login shell and is invisible to a stock one. */
const loginOnly = (loginversion) => ({
	detect: '',
	login: 'OK',
	version: '',
	...(loginversion === undefined ? {} : { loginversion }),
});
const withClaude = (entry, claude) => ({ ...seenFor(entry), claude });
const OLD_TARGET = { ...KNOWN, version: '2.1.281' };

test('PATH-ONLY: present but login-only plans a LINK and no install, even when the binary is newer than the pin', () => {
	const tools = applicableRepairs(TASKAUTO);
	const p = planNode(tools, withClaude(TASKAUTO, loginOnly('2.1.284 (Claude Code)')), {
		claude: OLD_TARGET,
		jdk21: KNOWN,
	});
	assert.deepEqual(
		p.work.map((w) => [w.id, w.action, w.target, w.from]),
		[['claude', 'link', undefined, '2.1.284']]
	);
	assert.deepEqual(p.findings, []);
});

test('PATH-ONLY with an UNREADABLE version: link only, installed reported unknown, never reinstalled over', () => {
	const tools = applicableRepairs(TASKAUTO);
	const p = planNode(tools, withClaude(TASKAUTO, loginOnly('')), {
		claude: OLD_TARGET,
		jdk21: KNOWN,
	});
	assert.equal(p.work.length, 1);
	assert.equal(p.work[0].action, 'link');
	assert.equal(p.work[0].target, undefined);
	assert.equal(p.work[0].from, null);
	assert.equal(p.work[0].installed, 'unknown');
});

test('PATH-ONLY, end to end: drain -> link -> the SAME non-login re-probe -> undrain; no install runs', async () => {
	const world = { 'claw-8': withClaude(TASKAUTO, loginOnly('2.1.284')) };
	const h = harness([['claw-8', TASKAUTO]], world, { latest: OLD_TARGET });
	const r = await h.run();
	assert.equal(r.ok, true);
	assert.equal(r.nodes[0].status, 'updated');
	assert.deepEqual(r.nodes[0].update, [{ id: 'claude', ok: true }]);
	assert.equal(world['claw-8'].claude.detect, 'OK');
	assert.equal(h.drained.size, 0);
});

test('PATH-ONLY --plan reads link with no install target, and drains nothing', async () => {
	const world = { 'claw-8': withClaude(TASKAUTO, loginOnly('2.1.284')) };
	const h = harness([['claw-8', TASKAUTO]], world, { latest: OLD_TARGET });
	const r = await h.run({ plan: true });
	assert.equal(r.nodes[0].work[0].action, 'link');
	assert.equal('target' in r.nodes[0].work[0], false);
	assert.ok(!h.events.some((e) => /^(drain|undrain|update|wait|reprobe)/.test(e)));
});

test('a LINK that cannot fix it is a finding: the re-probe still says absent, so the node is HELD and the cycle halts', async () => {
	const world = { 'claw-8': withClaude(TASKAUTO, loginOnly('2.1.284')) };
	const h = harness([['claw-8', TASKAUTO]], world, { latest: OLD_TARGET, linkFails: true });
	const r = await h.run();
	assert.equal(r.ok, false);
	assert.equal(r.nodes[0].status, 'held');
	assert.match(r.findings[0].reason, /claude \[absent\]/);
	assert.match(r.findings[0].reason, /password is required/);
	assert.ok(h.drained.has('claw-8'), 'a broken node must stay drained');
});

test('a link that works on a tool that is ALSO behind is not a failed link: reachable now, upgraded next cycle', () => {
	const tools = applicableRepairs(TASKAUTO);
	const v = verdictAfter(
		[{ id: 'claude', action: 'link', from: null }],
		tools,
		withClaude(TASKAUTO, { detect: 'OK', login: 'OK', runner: '', version: '2.1.200' }),
		{ claude: OLD_TARGET, jdk21: KNOWN }
	);
	assert.equal(v.status, 'ok');
});

test('NO DOWNGRADE: a node whose claude is NEWER than the newest cleared release is never work, never drained', async () => {
	const world = {
		'claw-8': withClaude(TASKAUTO, { detect: 'OK', login: 'OK', runner: '', version: '2.1.284' }),
	};
	const h = harness([['claw-8', TASKAUTO]], world, { latest: OLD_TARGET });
	const r = await h.run();
	assert.equal(r.ok, true);
	assert.equal(r.nodes[0].status, 'current');
	assert.deepEqual(h.events, ['detect claw-8']);
});

test('NO DOWNGRADE: the install step itself refuses a target below the installed version, running nothing', () => {
	const ran = [];
	const run = (script) => (ran.push(script), { ok: true });
	for (const action of ['install', 'update']) {
		const r = runWorkItem({ id: 'claude', action, from: '2.1.284', target: '2.1.281' }, run);
		assert.equal(r.ok, false);
		assert.match(r.reason, /refusing to DOWNGRADE claude 2\.1\.284 -> 2\.1\.281/);
	}
	assert.deepEqual(ran, [], 'the installer was run');
});

test('the install step still INSTALLS an upgrade, and a LINK runs the declared link text and not the installer', () => {
	const ran = [];
	const run = (script) => (ran.push(script), { ok: true });
	assert.equal(
		runWorkItem({ id: 'claude', action: 'update', from: '2.1.280', target: '2.1.281' }, run).ok,
		true
	);
	assert.match(ran[0], /TARGET_VERSION='2\.1\.281'/);
	assert.match(ran[0], /claude\.ai\/install\.sh/);
	assert.equal(runWorkItem({ id: 'claude', action: 'link', from: null }, run).ok, true);
	assert.equal(ran[1], `set -u\n${REPAIRS.claude.link}`);
	assert.doesNotMatch(ran[1], /install\.sh|TARGET_VERSION/);
	const failed = runWorkItem({ id: 'claude', action: 'link' }, () => ({
		ok: false,
		stderr: 'no binary',
	}));
	assert.deepEqual(failed, { id: 'claude', ok: false, reason: 'no binary' });
});

test('BEHIND still upgrades, and ABSENT (not login-only) still installs pinned to the newest cleared release', async () => {
	const behind = planNode(
		applicableRepairs(TASKAUTO),
		withClaude(TASKAUTO, { detect: 'OK', login: 'OK', runner: '', version: '2.1.270' }),
		{ claude: OLD_TARGET, jdk21: KNOWN }
	);
	assert.deepEqual(
		behind.work.map((w) => [w.action, w.from, w.target]),
		[['update', '2.1.270', '2.1.281']]
	);
	const absent = planNode(
		applicableRepairs(TASKAUTO),
		withClaude(TASKAUTO, { detect: '', login: '' }),
		{ claude: OLD_TARGET, jdk21: KNOWN }
	);
	assert.deepEqual(
		absent.work.map((w) => [w.action, w.target]),
		[['install', '2.1.281']]
	);
	const world = {
		'claw-a': withClaude(TASKAUTO, { detect: 'OK', login: 'OK', runner: '', version: '2.1.270' }),
	};
	const h = harness([['claw-a', TASKAUTO]], world, { latest: OLD_TARGET });
	const r = await h.run();
	assert.equal(r.nodes[0].status, 'updated');
	assert.equal(world['claw-a'].claude.version, '2.1.281');
});

// --- apt-tracked tools and self-correcting records (2026-10-09) -------------

const DAY = 86_400_000;
const NOW = Date.now();
const recordAt = (daysAgo) => ({
	$capabilities: { at: new Date(NOW - daysAgo * DAY).toISOString() },
});

function withRebootcamp(h, { fail = false } = {}) {
	const calls = [];
	return {
		calls,
		rebootcamp: async (node) => {
			h.events.push(`rebootcamp ${node}`);
			calls.push(node);
			return fail ? { ok: false, reason: 'dirty tree' } : { ok: true };
		},
	};
}

test('an apt package behind its candidate is UPDATED in the cycle, drained, like any tool', async () => {
	const entry = { ...CLAW, ...recordAt(1) };
	const world = { 'claw-a': seenFor(entry, { apt: { gh: '2.92.0|2.102.0|behind' } }) };
	const h = harness([['claw-a', entry]], world);
	const r = await h.run({ now: () => NOW });
	assert.equal(r.nodes[0].status, 'updated');
	assert.deepEqual(
		r.nodes[0].work.map((w) => [w.id, w.action, w.target]),
		[['gh', 'update', '2.102.0']]
	);
	assert.equal(world['claw-a'].gh.apt, '2.102.0|2.102.0|current');
});

test('after an update the node is RE-BOOTCAMPED while still drained, then put back', async () => {
	const entry = { ...CLAW, ...recordAt(1) };
	const world = {
		'claw-a': seenFor(entry, { apt: { ffmpeg: '7:7.1.3-0+deb13u1|7:7.1.5-0+deb13u1|behind' } }),
	};
	const h = harness([['claw-a', entry]], world);
	const rb = withRebootcamp(h);
	const r = await runRefreshCycle({
		machines: [['claw-a', entry]],
		deps: { ...h.deps, ...rb },
		state: h.state,
		now: () => NOW,
	});
	assert.equal(r.nodes[0].status, 'updated');
	const order = h.events.filter((e) => !e.startsWith('detect'));
	assert.deepEqual(order.slice(-3), ['reprobe claw-a', 'rebootcamp claw-a', 'undrain claw-a']);
});

test('RECHECK: a current node whose record is past RECHECK_DAYS is drained, re-bootcamped and put back — one per run, most stale first', async () => {
	const machines = [
		['claw-a', { ...CLAW, ...recordAt(RECHECK_DAYS + 1) }],
		['claw-b', { ...CLAW, ...recordAt(RECHECK_DAYS + 9) }],
		['claw-c', { ...CLAW, ...recordAt(1) }],
	];
	const world = Object.fromEntries(machines.map(([n, e]) => [n, seenFor(e)]));
	const h = harness(machines, world);
	const rb = withRebootcamp(h);
	const r = await runRefreshCycle({
		machines,
		deps: { ...h.deps, ...rb },
		state: h.state,
		now: () => NOW,
	});
	assert.deepEqual(rb.calls, ['claw-b'], 'only the most stale node, and only one');
	assert.equal(r.nodes.find((n) => n.node === 'claw-b').status, 'rechecked');
	assert.ok(!h.drained.has('claw-b'), 'put back');
	assert.equal(r.nodes.find((n) => n.node === 'claw-c').status, 'current');
});

test('RECHECK respects the same rules: deferred under queue pressure, nothing drained', async () => {
	const machines = [['claw-a', { ...CLAW, ...recordAt(RECHECK_DAYS + 1) }]];
	const h = harness(
		machines,
		{ 'claw-a': seenFor(machines[0][1]) },
		{ pressure: { pressured: true, reason: 'busy' } }
	);
	const rb = withRebootcamp(h);
	const r = await runRefreshCycle({
		machines,
		deps: { ...h.deps, ...rb },
		state: h.state,
		now: () => NOW,
	});
	assert.equal(r.nodes[0].status, 'deferred');
	assert.deepEqual(rb.calls, []);
});

test('a re-bootcamp that fails is a finding, never a hold — the node is still put back', async () => {
	const machines = [['claw-a', { ...CLAW, ...recordAt(RECHECK_DAYS + 1) }]];
	const h = harness(machines, { 'claw-a': seenFor(machines[0][1]) });
	const rb = withRebootcamp(h, { fail: true });
	const r = await runRefreshCycle({
		machines,
		deps: { ...h.deps, ...rb },
		state: h.state,
		now: () => NOW,
	});
	assert.ok(r.findings.some((f) => f.kind === 'rebootcamp-failed'));
	assert.ok(!h.drained.has('claw-a'));
});

test('no rebootcamp dependency means no recheck turn — a caller that cannot re-run bootcamp drains nothing for it', async () => {
	const machines = [['claw-a', { ...CLAW, ...recordAt(RECHECK_DAYS + 1) }]];
	const h = harness(machines, { 'claw-a': seenFor(machines[0][1]) });
	const r = await h.run({ now: () => NOW });
	assert.equal(r.nodes[0].status, 'current');
	assert.ok(!h.events.some((e) => e.startsWith('drain')));
});

test("RECHECK uses the cycle's own last-checked time — an unchanged record is not re-picked every run", async () => {
	// `$capabilities.at` moves only when a record CHANGES, so a node rechecked
	// yesterday with no change still carries an old `at`.
	const machines = [
		['claw-a', { ...CLAW, ...recordAt(RECHECK_DAYS + 9) }],
		['claw-b', { ...CLAW, ...recordAt(RECHECK_DAYS + 1) }],
	];
	const world = Object.fromEntries(machines.map(([n, e]) => [n, seenFor(e)]));
	const h = harness(machines, world);
	const rb = withRebootcamp(h);
	const checked = { 'claw-a': NOW - DAY };
	const marked = [];
	const r = await runRefreshCycle({
		machines,
		deps: {
			...h.deps,
			...rb,
			lastChecked: (n) => checked[n] ?? 0,
			markChecked: (n) => marked.push(n),
		},
		state: h.state,
		now: () => NOW,
	});
	assert.deepEqual(rb.calls, ['claw-b'], 'claw-a was checked yesterday, so claw-b goes');
	assert.deepEqual(marked, ['claw-b'], 'and the cycle records that it checked it');
	assert.equal(r.nodes.find((n) => n.node === 'claw-a').status, 'current');
});

// ---------------------------------------------------------------------------
// RUNNER-PATH ONLY (#127). Installed, current, found by a non-login shell — and
// missing from the PATH a runner job gets. An install cannot move a binary onto
// a PATH, so the remedy is the declared link or a finding, never an install.
// ---------------------------------------------------------------------------

const runnerMiss = (version) => ({
	detect: 'OK',
	login: 'OK',
	runner: 'listener:runners/actions-runner-hadoku-site=/usr/bin:/bin; ',
	version,
});

test('#127: a runner-PATH miss on a tool WITH a link plans the link, not an install', () => {
	const { work, findings } = planNode(
		applicableRepairs(TASKAUTO),
		withClaude(TASKAUTO, runnerMiss('2.1.285')),
		{ claude: KNOWN, jdk21: KNOWN }
	);
	assert.deepEqual(
		work.map((w) => [w.id, w.action]),
		[['claude', 'link']]
	);
	assert.deepEqual(findings, []);
});

test('#127: a runner-PATH miss on a tool with NO link is a finding, and nothing is installed', () => {
	const tools = applicableRepairs(TASKAUTO);
	const [id] = tools.find(([, t]) => !t.link && !t.apt) ?? [];
	assert.ok(id, 'the fixture node carries a tool with no declared link');
	const seen = {
		...seenFor(TASKAUTO),
		[id]: { ...seenFor(TASKAUTO)[id], runner: 'manager=/usr/bin; ' },
	};
	const { work, findings } = planNode(tools, seen, { claude: KNOWN, jdk21: KNOWN });
	assert.deepEqual(work, [], `nothing may be installed for ${id}`);
	assert.equal(findings.length, 1);
	assert.equal(findings[0].tool, id);
	assert.equal(findings[0].kind, 'unreachable');
	assert.match(findings[0].reason, /not on the PATH runner jobs get/);
});
