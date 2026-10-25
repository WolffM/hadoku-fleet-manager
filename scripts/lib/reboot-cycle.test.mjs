/**
 * The reboot cycle's safety properties, against a fake fleet. Nothing here
 * reaches a node: every side effect is an injected dependency that records
 * what it was asked to do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	BOOT_TIMEOUT_MS,
	REASON_PREFIX,
	oursOn,
	parseRebootProbe,
	rebootReason,
	runRebootCycle,
	verifyAfter,
} from './reboot-cycle.mjs';

/** Anchored to now: the cycle reads only that a record EXISTS, but a pinned date still ages. */
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();
const OLD = '6.12.94+deb13-amd64';
const NEW = '6.12.113+deb13-amd64';
const UNIT = 'actions-runner-hadoku-fleet-manager.service';

const box = (over = {}) => ({
	bootId: 'boot-a',
	running: OLD,
	newest: OLD,
	flag: false,
	packages: [],
	busy: 0,
	unitsEnabled: [],
	unitsActive: [],
	pm2: null,
	...over,
});

/**
 * A fleet the cycle can act on. `reboot` boots the node onto `bootsInto`
 * (default: its newest kernel) with a fresh boot id, its flag cleared and its
 * units active again — unless the test says otherwise.
 */
function world({
	nodes,
	drains = {},
	planned = [],
	pressure = { pressured: false },
	bootsInto = {},
}) {
	const calls = [];
	const doc = { nodes: { ...drains }, planned };
	let clock = 1_800_000_000_000;
	let state = null;
	const deps = {
		isGuest: (entry) => entry?.role === 'guest',
		isLocal: (node) => node === 'hokon',
		probe: (node) => {
			calls.push(`probe ${node}`);
			const b = nodes[node];
			if (!b || b.down) return { ok: false, reason: 'ssh: connect timed out' };
			return { ok: true, ...b };
		},
		drainDoc: () => doc,
		drain: (node, reason) => {
			calls.push(`drain ${node}`);
			doc.nodes[node] = { kind: 'lease', reason, since: 'x', until: 'y' };
			return { ok: true };
		},
		hold: (node, reason) => {
			calls.push(`hold ${node}`);
			doc.nodes[node] = { kind: 'maintenance', reason };
			return { ok: true };
		},
		undrain: (node) => {
			calls.push(`undrain ${node}`);
			delete doc.nodes[node];
			return { ok: true };
		},
		waitDrained: (node) => {
			calls.push(`wait ${node}`);
			if (nodes[node].neverIdle) {
				return { drained: false, reason: 'not drained after 2700000 ms: 1 job(s) running' };
			}
			// Drained: its jobs finished and nothing new was assigned.
			nodes[node] = { ...nodes[node], busy: 0 };
			return { drained: true };
		},
		queuePressure: () => pressure,
		reboot: (node) => {
			calls.push(`reboot ${node}`);
			const b = nodes[node];
			const into = bootsInto[node] ?? {};
			nodes[node] = {
				...b,
				bootId: `${b.bootId}+1`,
				running: b.newest ?? b.running,
				flag: false,
				unitsActive: [...b.unitsEnabled],
				...into,
			};
			return { ok: true };
		},
		sleep: (ms) => {
			clock += ms;
		},
		now: () => clock,
		readState: () => state,
		writeState: (s) => {
			state = JSON.parse(JSON.stringify(s));
		},
	};
	return { deps, calls, doc, state: () => state, nodes };
}

const MACHINES = [
	['hokon', { role: 'guest' }],
	['claw-1', { role: 'claw' }],
	['claw-4', { role: 'claw' }],
	['claw-8', { role: 'claw' }],
];

test('parseRebootProbe: claw-4 live, and an answer cut off is could-not-look', () => {
	const p = parseRebootProbe(
		[
			'BOOTID 681c3edd-72ed-446e-86d3-ae63c38fb90e',
			`RUNNING ${OLD}`,
			`NEWEST ${NEW}`,
			'FLAG REQUIRED',
			'PKGS linux-image-6.12.113+deb13-amd64 libc6 ',
			'BUSY 6',
			`UNITS-ENABLED ${UNIT}`,
			`UNITS-ACTIVE ${UNIT}`,
			'PM2 pygmalion',
			'END reboot-probe',
		].join('\n')
	);
	assert.equal(p.ok, true);
	assert.deepEqual([p.busy, p.pm2, p.packages.length], [6, ['pygmalion'], 2]);
	assert.equal(
		rebootReason(p),
		`running ${OLD}, newest installed ${NEW}; /var/run/reboot-required (linux-image-6.12.113+deb13-amd64, libc6)`
	);
	assert.equal(parseRebootProbe('BOOTID x\nRUNNING y\n').ok, false);
	assert.equal(parseRebootProbe('BOOTID x\nRUNNING y\nPM2 NONE\nEND reboot-probe').pm2, null);
	assert.equal(rebootReason(box()), null);
});

test('verifyAfter: same boot, wrong kernel, a dead runner unit and a lost pm2 app are each named', () => {
	const before = box({
		newest: NEW,
		unitsEnabled: [UNIT],
		unitsActive: [UNIT],
		pm2: ['pygmalion'],
	});
	assert.deepEqual(verifyAfter(before, before), [
		'the boot id did not change: it never rebooted',
		`booted ${OLD}, expected ${NEW}`,
	]);
	assert.deepEqual(
		verifyAfter(before, { ...before, bootId: 'b', running: NEW, unitsActive: [], pm2: [] }),
		[`runner unit(s) not active: ${UNIT}`, 'pm2 app(s) not back online: pygmalion']
	);
	assert.deepEqual(verifyAfter(before, { ...before, bootId: 'b', running: NEW }), []);
});

test('a staged kernel: drained as a lease, idle, rebooted, verified, undrained — and recorded', async () => {
	const w = world({
		nodes: {
			'claw-1': box({ busy: 2 }),
			'claw-4': box({ newest: NEW, unitsEnabled: [UNIT], unitsActive: [UNIT], pm2: [] }),
			'claw-8': box(),
		},
	});
	const r = await runRebootCycle({ machines: MACHINES, deps: w.deps });
	assert.equal(r.ok, true, JSON.stringify(r.findings));
	assert.deepEqual(r.rebooted, ['claw-4']);
	assert.deepEqual(
		w.calls.filter((c) => !c.startsWith('probe')),
		['drain claw-4', 'wait claw-4', 'reboot claw-4', 'undrain claw-4']
	);
	assert.equal(w.calls.includes('probe hokon'), false, 'a guest is never probed');
	assert.deepEqual(r.nodes.find((n) => n.node === 'claw-4').kernel, { from: OLD, to: NEW });
	assert.equal(w.state().inFlight, null);
	assert.ok(w.state().last['claw-4']);
	assert.deepEqual(w.doc.nodes, {});
});

test("NOBODY ELSE'S DRAIN: claw-8/9 held by the operator are reported and never touched", async () => {
	const lease = { kind: 'lease', reason: 'cardtable stress lease', until: inDays(2) };
	const w = world({
		nodes: { 'claw-1': box(), 'claw-4': box(), 'claw-8': box({ newest: NEW, flag: true }) },
		drains: { 'claw-8': lease },
	});
	const r = await runRebootCycle({ machines: MACHINES, deps: w.deps });
	assert.deepEqual(r.rebooted, []);
	assert.deepEqual(
		w.calls.filter((c) => !c.startsWith('probe')),
		[]
	);
	assert.match(
		r.nodes.find((n) => n.node === 'claw-8').why,
		/held by someone else: drained \(lease: cardtable/
	);
	assert.deepEqual(w.doc.nodes['claw-8'], lease);
	// A drain merely PLANNED on a node is someone else's too.
	const p = world({
		nodes: { 'claw-1': box({ flag: true }), 'claw-4': box(), 'claw-8': box() },
		planned: [{ node: 'claw-1', from: inDays(5), reason: 'reseat RAM' }],
	});
	assert.deepEqual((await runRebootCycle({ machines: MACHINES, deps: p.deps })).rebooted, []);
});

test('a SERVICE HOST is never cycled: pm2 apps online, or a pm2 it could not read', async () => {
	// claw-4 serves pygmalion; on 2026-10-25 its state existed nowhere else.
	const w = world({
		nodes: {
			'claw-1': box({ flag: true, pm2: 'unreadable' }),
			'claw-4': box({ flag: true, pm2: ['pygmalion'] }),
			'claw-8': box({ flag: true, pm2: [] }),
		},
	});
	const r = await runRebootCycle({ machines: MACHINES, deps: w.deps });
	assert.deepEqual(r.rebooted, ['claw-8'], 'a pm2 with nothing online is an ordinary claw');
	assert.match(r.nodes.find((n) => n.node === 'claw-4').why, /service host: it serves pygmalion/);
	assert.match(r.nodes.find((n) => n.node === 'claw-1').why, /could not be read/);
	assert.equal(w.calls.includes('drain claw-4'), false);
});

test('never this box, never a guest — even when they need a reboot', async () => {
	const w = world({ nodes: { hokon: box({ flag: true }), 'claw-1': box() } });
	const r = await runRebootCycle({
		machines: [
			['hokon', { role: 'claw' }],
			['claw-1', {}],
		],
		deps: w.deps,
	});
	assert.deepEqual(r.rebooted, []);
	assert.equal(w.calls.includes('probe hokon'), false);
	assert.equal(r.nodes.find((n) => n.node === 'hokon').why, 'local');
});

test('ONE node per pass, the least busy first', async () => {
	const w = world({
		nodes: {
			'claw-1': box({ flag: true, busy: 3 }),
			'claw-4': box({ flag: true, busy: 1 }),
			'claw-8': box(),
		},
	});
	const r = await runRebootCycle({ machines: MACHINES, deps: w.deps });
	assert.deepEqual(r.rebooted, ['claw-4']);
	assert.equal(r.nodes.find((n) => n.node === 'claw-1').why, 'one node per pass');
	assert.equal(w.calls.includes('drain claw-1'), false);
});

test('never rebooted busy: a node that never goes idle is put back and nothing is rebooted', async () => {
	const w = world({ nodes: { 'claw-1': box({ flag: true, neverIdle: true }) } });
	const r = await runRebootCycle({ machines: [['claw-1', {}]], deps: w.deps });
	assert.equal(w.calls.includes('reboot claw-1'), false);
	assert.deepEqual(
		w.calls.filter((c) => !c.startsWith('probe')),
		['drain claw-1', 'wait claw-1', 'undrain claw-1']
	);
	assert.match(r.nodes[0].why, /never went idle/);
	assert.equal(w.state().inFlight, null);
});

test('a job that lands between the wait and the reboot cancels it', async () => {
	const w = world({ nodes: { 'claw-1': box({ flag: true }) } });
	const wait = w.deps.waitDrained;
	w.deps.waitDrained = (n) => {
		const r = wait(n);
		w.nodes['claw-1'] = { ...w.nodes['claw-1'], busy: 1 };
		return r;
	};
	const r = await runRebootCycle({ machines: [['claw-1', {}]], deps: w.deps });
	assert.equal(w.calls.includes('reboot claw-1'), false);
	assert.match(r.nodes[0].why, /1 job\(s\) running at the last check/);
	assert.deepEqual(w.doc.nodes, {});
});

test('queue pressure, or a queue nobody could read, starts nothing', async () => {
	for (const pressure of [
		{ pressured: true, reason: '4 run(s) waiting, oldest 300s' },
		{ pressured: true, unknown: true, reason: 'queue-health produced no JSON' },
	]) {
		const w = world({ nodes: { 'claw-1': box({ flag: true }) }, pressure });
		const r = await runRebootCycle({ machines: [['claw-1', {}]], deps: w.deps });
		assert.deepEqual(
			w.calls.filter((c) => !c.startsWith('probe')),
			[]
		);
		assert.equal(r.ok, !pressure.unknown);
	}
});

test('booted the wrong kernel: HELD as maintenance, not undrained, and a finding', async () => {
	const w = world({
		nodes: { 'claw-1': box({ newest: NEW }) },
		bootsInto: { 'claw-1': { running: OLD } },
	});
	const r = await runRebootCycle({ machines: [['claw-1', {}]], deps: w.deps });
	assert.equal(r.ok, false);
	assert.equal(r.nodes[0].status, 'held');
	assert.equal(w.calls.includes('undrain claw-1'), false);
	assert.equal(w.doc.nodes['claw-1'].kind, 'maintenance');
	assert.ok(
		w.doc.nodes['claw-1'].reason.startsWith(`${REASON_PREFIX} FAILED verification: booted ${OLD}`),
		w.doc.nodes['claw-1'].reason
	);
	assert.equal(r.findings[0].kind, 'verify-failed');
});

test('never came back: held after the boot window, with the last thing it said', async () => {
	const w = world({
		nodes: { 'claw-1': box({ flag: true }) },
		bootsInto: { 'claw-1': { down: true } },
	});
	const r = await runRebootCycle({ machines: [['claw-1', {}]], deps: w.deps });
	assert.match(
		r.findings[0].reason,
		new RegExp(
			`not back on a new boot after ${BOOT_TIMEOUT_MS / 60_000} min \\(ssh: connect timed out\\)`
		)
	);
	assert.equal(w.doc.nodes['claw-1'].kind, 'maintenance');
});

test('RESUME: a pass killed mid-reboot is verified and undrained by the next, long after', async () => {
	const w = world({ nodes: { 'claw-1': box({ flag: true }) } });
	await w.deps.drain('claw-1', `${REASON_PREFIX}: /var/run/reboot-required`);
	const before = { ok: true, ...w.nodes['claw-1'] };
	w.deps.reboot('claw-1');
	w.deps.writeState({
		inFlight: {
			node: 'claw-1',
			phase: 'rebooting',
			before,
			rebootAt: w.deps.now() - 3 * BOOT_TIMEOUT_MS,
		},
		last: {},
	});
	const r = await runRebootCycle({ machines: [['claw-1', {}]], deps: w.deps });
	assert.equal(r.ok, true, JSON.stringify(r.findings));
	assert.deepEqual(r.rebooted, ['claw-1']);
	assert.deepEqual(w.doc.nodes, {});
	assert.equal(w.state().inFlight, null);
});

test('RESUME: killed while draining puts back only a drain that is still ours', async () => {
	const w = world({ nodes: { 'claw-1': box({ flag: true }) } });
	w.deps.writeState({ inFlight: { node: 'claw-1', phase: 'draining' }, last: {} });
	// Meanwhile the operator took the node for real.
	w.doc.nodes['claw-1'] = { kind: 'maintenance', reason: 'reseat RAM' };
	const r = await runRebootCycle({ machines: [['claw-1', {}]], deps: w.deps });
	assert.equal(w.calls.includes('undrain claw-1'), false);
	assert.equal(w.calls.includes('reboot claw-1'), false);
	assert.equal(w.doc.nodes['claw-1'].reason, 'reseat RAM');
	assert.equal(r.nodes[0].status, 'abandoned');
	assert.equal(oursOn(w.doc, 'claw-1'), false);
});

test('--plan picks and drains nothing', async () => {
	const w = world({ nodes: { 'claw-1': box({ flag: true }) } });
	const r = await runRebootCycle({ machines: [['claw-1', {}]], deps: w.deps, plan: true });
	assert.equal(r.nodes[0].status, 'planned');
	assert.deepEqual(
		w.calls.filter((c) => !c.startsWith('probe')),
		[]
	);
});

test('an unreachable claw is a finding, never "current" — unless a human took it out', async () => {
	const w = world({ nodes: { 'claw-1': box({ down: true }) } });
	const r = await runRebootCycle({ machines: [['claw-1', {}]], deps: w.deps });
	assert.equal(r.ok, false);
	assert.deepEqual(
		r.findings.map((f) => f.kind),
		['unreadable']
	);
	w.deps.expectedDown = (n) => n === 'claw-1';
	const d = await runRebootCycle({ machines: [['claw-1', {}]], deps: w.deps });
	assert.equal(d.ok, true);
	assert.equal(d.nodes[0].status, 'expected-down');
});
