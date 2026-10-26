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
	REBOOT_LEASE,
	HELD_PREFIX,
	oursOn,
	parseRebootProbe,
	dkmsGap,
	judgeReprove,
	rebootDrainArgs,
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
	reprove = {},
	noReprove = false,
	hosting = {},
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
		// As `fleet drain` does: a drain laid over a whole-box hosting record
		// goes to `planned`, from now, and never erases the tenant's record.
		drain: (node, reason, { force = false } = {}) => {
			calls.push(`drain ${node}${force ? ' --force' : ''}`);
			const rec = { kind: 'reboot', reason, since: 'x', until: 'y' };
			if (doc.nodes[node]?.kind === 'hosting')
				doc.planned.push({ node, from: new Date(clock).toISOString(), ...rec });
			else doc.nodes[node] = rec;
			return { ok: true };
		},
		announce: (node, reason, min) => {
			calls.push(`announce ${node} ${min}m`);
			doc.planned.push({
				node,
				from: new Date(clock + min * 60_000).toISOString(),
				kind: 'reboot',
				reason,
			});
			return { ok: true };
		},
		noticeMs: 15 * 60_000,
		hostingOn: (node) => hosting[node] ?? null,
		hold: (node, reason) => {
			calls.push(`hold ${node}`);
			const rec = { kind: 'maintenance', reason };
			if (doc.nodes[node]?.kind === 'hosting')
				doc.planned.push({ node, from: new Date(clock).toISOString(), ...rec });
			else doc.nodes[node] = rec;
			return { ok: true };
		},
		// `fleet drain --undo`: cancels anything planned; a hosting record stays.
		undrain: (node) => {
			calls.push(`undrain ${node}`);
			doc.planned = doc.planned.filter((p) => p.node !== node);
			if (doc.nodes[node]?.kind !== 'hosting') delete doc.nodes[node];
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
		...(noReprove
			? {}
			: {
					reprove: (node) => {
						calls.push(`reprove ${node}`);
						return reprove[node] ?? { ok: true };
					},
				}),
		sleep: (ms) => {
			calls.push(`sleep ${ms}`);
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

test('a staged kernel: drained as a reboot, idle, rebooted, verified, undrained — and recorded', async () => {
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
		w.calls.filter((c) => !c.startsWith('probe') && !c.startsWith('sleep')),
		['drain claw-4', 'wait claw-4', 'reboot claw-4', 'reprove claw-4', 'undrain claw-4']
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

test('the cycle drains as kind `reboot`, with an end — never as a tenant lease', () => {
	const args = rebootDrainArgs('claw-6', `${REASON_PREFIX}: running ${OLD}`);
	assert.deepEqual(args.slice(0, 5), ['claw-6', '--kind', 'reboot', '--for', REBOOT_LEASE]);
	assert.equal(args[args.indexOf('--reason') + 1].startsWith(REASON_PREFIX), true);
});

test("oursOn: the `reboot` kind, a pre-kind lease it wrote, and never anyone else's lease", () => {
	const doc = {
		nodes: {
			'claw-6': { kind: 'reboot', reason: 'anything' },
			'claw-4': { kind: 'lease', reason: `${REASON_PREFIX}: running ${OLD}` },
			'claw-8': { kind: 'lease', reason: 'cardtable stress lease' },
		},
	};
	assert.equal(oursOn(doc, 'claw-6'), true);
	assert.equal(
		oursOn(doc, 'claw-4'),
		true,
		'a record written before the kind existed is still finished'
	);
	assert.equal(oursOn(doc, 'claw-8'), false);
	assert.equal(oursOn(doc, 'claw-1'), false);
});

test('a node held by a FAILED verification HALTS the rollout: nothing else is drained', async () => {
	const since = inDays(-0.05);
	const w = world({
		nodes: { 'claw-8': box({ newest: NEW }), 'claw-9': box({ running: NEW, newest: NEW }) },
		drains: {
			'claw-9': {
				kind: 'maintenance',
				reason: `${HELD_PREFIX}: DKMS module(s) not loaded after the reboot: nvidia_uvm`,
				since,
			},
		},
	});
	const r = await runRebootCycle({
		machines: [
			['claw-8', {}],
			['claw-9', {}],
		],
		deps: w.deps,
	});
	assert.deepEqual(
		w.calls.filter((c) => !c.startsWith('probe')),
		[]
	);
	const f = r.findings.find((x) => x.kind === 'halted');
	assert.equal(f?.node, 'claw-9', JSON.stringify(r.findings));
	assert.ok(f.reason.includes(`claw-9 (since ${since}) failed reboot verification`), f.reason);
	const c8 = r.nodes.find((n) => n.node === 'claw-8');
	assert.equal(c8.status, 'deferred');
	assert.match(c8.why, /^halted: /);
});

test("someone else's maintenance drain does not halt the rollout", async () => {
	const w = world({
		nodes: { 'claw-8': box({ newest: NEW }), 'claw-9': box({ running: NEW, newest: NEW }) },
		drains: { 'claw-9': { kind: 'maintenance', reason: 'reseat RAM' } },
	});
	const r = await runRebootCycle({
		machines: [
			['claw-8', {}],
			['claw-9', {}],
		],
		deps: w.deps,
	});
	assert.deepEqual(r.rebooted, ['claw-8']);
});

test("oursOn never claims a FAILED hold, though it starts with the cycle's prefix", () => {
	const doc = { nodes: { 'claw-9': { kind: 'maintenance', reason: `${HELD_PREFIX}: x` } } };
	assert.equal(oursOn(doc, 'claw-9'), false);
});

test('a real pass records its decision per node on disk; a plan pass records nothing', async () => {
	const w = world({
		nodes: { 'claw-8': box({ newest: NEW }), 'claw-4': box({ flag: true, pm2: ['pygmalion'] }) },
	});
	await runRebootCycle({
		machines: [
			['claw-8', {}],
			['claw-4', {}],
		],
		deps: w.deps,
		plan: true,
	});
	assert.equal(w.state()?.decisions, undefined, 'a plan decides nothing');
	await runRebootCycle({
		machines: [
			['claw-8', {}],
			['claw-4', {}],
		],
		deps: w.deps,
	});
	const d = w.state().decisions;
	assert.equal(d['claw-8'].status, 'rebooted');
	assert.deepEqual(d['claw-8'].kernel, { from: OLD, to: NEW });
	assert.equal(d['claw-4'].status, 'deferred');
	assert.match(d['claw-4'].why, /service host: it serves pygmalion/);
	assert.ok(d['claw-4'].at);
});

// --- a tenant is owed notice (cardtable §7) ---------------------------------

const SHARED = { mode: 'shared', tenant: 'cardtable', memoryMb: 4096, cores: 2, port: 25565 };

test('a SHARED hosting node is announced 15 min ahead, the pass waits it out, then reboots', async () => {
	const w = world({ nodes: { 'claw-8': box({ newest: NEW }) }, hosting: { 'claw-8': SHARED } });
	const r = await runRebootCycle({ machines: [['claw-8', {}]], deps: w.deps });
	assert.equal(r.ok, true, JSON.stringify(r.findings));
	assert.deepEqual(r.rebooted, ['claw-8']);
	const steps = w.calls.filter((c) => !c.startsWith('probe') && !c.startsWith('sleep 15000'));
	assert.deepEqual(steps.slice(0, 4), [
		'announce claw-8 15m',
		'sleep 900000',
		'wait claw-8',
		'reboot claw-8',
	]);
	assert.equal(w.calls.includes('drain claw-8'), false, 'the notice IS the drain; no second one');
	assert.deepEqual(
		w.doc.planned,
		[],
		'undrained after the verified reboot: the notice is cancelled'
	);
});

test('a WHOLE-box hosting node: the notice sits over the hosting record, which survives the reboot', async () => {
	const hostingRec = { kind: 'hosting', reason: 'cardtable', hosting: { tenant: 'cardtable' } };
	const w = world({
		nodes: { 'claw-9': box({ newest: NEW }) },
		drains: { 'claw-9': hostingRec },
		hosting: { 'claw-9': { ...SHARED, mode: 'whole' } },
	});
	const r = await runRebootCycle({ machines: [['claw-9', {}]], deps: w.deps });
	assert.deepEqual(r.rebooted, ['claw-9'], JSON.stringify(r.nodes));
	assert.ok(w.calls.includes('announce claw-9 15m'));
	assert.deepEqual(w.doc.nodes['claw-9'], hostingRec, "the tenant's record is untouched");
});

test('a notice already announced and still in the future defers the node, and nothing is drained', async () => {
	const from = new Date(1_800_000_000_000 + 10 * 60_000).toISOString();
	const w = world({
		nodes: { 'claw-8': box({ newest: NEW }) },
		hosting: { 'claw-8': SHARED },
		planned: [{ node: 'claw-8', from, kind: 'reboot', reason: `${REASON_PREFIX}: x` }],
	});
	const r = await runRebootCycle({ machines: [['claw-8', {}]], deps: w.deps });
	assert.equal(r.nodes[0].status, 'deferred');
	assert.match(r.nodes[0].why, /announced: reboot drain starts .* \(hosting cardtable\)/);
	assert.deepEqual(
		w.calls.filter((c) => !c.startsWith('probe')),
		[]
	);
});

test('a notice in force is the drain: the pass reboots without announcing again', async () => {
	const from = new Date(1_800_000_000_000 - 60_000).toISOString();
	const w = world({
		nodes: { 'claw-8': box({ newest: NEW }) },
		hosting: { 'claw-8': SHARED },
		planned: [{ node: 'claw-8', from, kind: 'reboot', reason: `${REASON_PREFIX}: x` }],
	});
	const r = await runRebootCycle({ machines: [['claw-8', {}]], deps: w.deps });
	assert.deepEqual(r.rebooted, ['claw-8'], JSON.stringify(r.nodes));
	assert.equal(
		w.calls.some((c) => c.startsWith('announce') || c.startsWith('drain')),
		false
	);
});

test('--force skips the notice and drains at once, forced past the refusal', async () => {
	const w = world({ nodes: { 'claw-8': box({ newest: NEW }) }, hosting: { 'claw-8': SHARED } });
	const r = await runRebootCycle({ machines: [['claw-8', {}]], deps: w.deps, force: true });
	assert.deepEqual(r.rebooted, ['claw-8']);
	assert.ok(w.calls.includes('drain claw-8 --force'), w.calls.join(', '));
	assert.equal(
		w.calls.some((c) => c.startsWith('announce')),
		false
	);
});

test('queue pressure with a notice in force cancels the notice rather than holding the node', async () => {
	const from = new Date(1_800_000_000_000 - 60_000).toISOString();
	const w = world({
		nodes: { 'claw-8': box({ newest: NEW }) },
		hosting: { 'claw-8': SHARED },
		planned: [{ node: 'claw-8', from, kind: 'reboot', reason: `${REASON_PREFIX}: x` }],
		pressure: { pressured: true, reason: '9 queued' },
	});
	await runRebootCycle({ machines: [['claw-8', {}]], deps: w.deps });
	assert.deepEqual(w.doc.planned, []);
	assert.equal(w.calls.includes('reboot claw-8'), false);
});

test('a pass killed during the notice cancels it on resume, like one killed while draining', async () => {
	const w = world({ nodes: { 'claw-8': box({ newest: NEW }) }, hosting: { 'claw-8': SHARED } });
	w.deps.announce('claw-8', `${REASON_PREFIX}: x`, 15);
	w.deps.writeState({ inFlight: { node: 'claw-8', phase: 'notice' }, last: {} });
	const r = await runRebootCycle({ machines: [['claw-8', {}]], deps: w.deps });
	assert.equal(r.nodes[0].status, 'abandoned');
	assert.deepEqual(w.doc.planned, []);
});

test('a FAILED hold on a whole-box host (in `planned`) still halts the rollout', async () => {
	const w = world({
		nodes: { 'claw-8': box({ newest: NEW }), 'claw-9': box({ running: NEW, newest: NEW }) },
		drains: { 'claw-9': { kind: 'hosting', reason: 'cardtable' } },
		planned: [
			{ node: 'claw-9', from: inDays(-0.01), kind: 'maintenance', reason: `${HELD_PREFIX}: x` },
		],
	});
	const r = await runRebootCycle({
		machines: [
			['claw-8', {}],
			['claw-9', {}],
		],
		deps: w.deps,
	});
	assert.ok(
		r.findings.some((f) => f.kind === 'halted' && f.node === 'claw-9'),
		JSON.stringify(r.findings)
	);
	assert.equal(
		w.calls.some((c) => c.startsWith('drain') || c.startsWith('announce')),
		false
	);
});

test('--plan names the notice a hosting node would get, and announces nothing', async () => {
	const w = world({ nodes: { 'claw-8': box({ newest: NEW }) }, hosting: { 'claw-8': SHARED } });
	const lines = [];
	await runRebootCycle({
		machines: [['claw-8', {}]],
		deps: w.deps,
		plan: true,
		log: (l) => lines.push(l),
	});
	assert.ok(
		lines.some((l) => /after 15 min notice to cardtable/.test(l)),
		lines.join('\n')
	);
	assert.equal(
		w.calls.some((c) => c.startsWith('announce')),
		false
	);
});

// --- a reboot must not lose a driver (claw-1, 2026-10-25) --------------------

const NV = ['nvidia-current.ko.xz', 'nvidia-current-uvm.ko.xz'];

test('parseRebootProbe reads the DKMS lines', () => {
	const p = parseRebootProbe(
		[
			'BOOTID b',
			`RUNNING ${OLD}`,
			`NEWEST ${NEW}`,
			`DKMS-RUNNING ${NV.join(' ')}`,
			'DKMS-NEWEST nvidia-current.ko.xz',
			'DKMS-LOADED nvidia nvidia_uvm',
			'DKMS-READY nvidia nvidia_uvm nvidia_peermem',
			'END reboot-probe',
		].join('\n')
	);
	assert.deepEqual(p.dkmsRunning, NV);
	assert.deepEqual(p.dkmsNewest, ['nvidia-current.ko.xz']);
	assert.deepEqual(p.dkmsLoaded, ['nvidia', 'nvidia_uvm']);
	assert.deepEqual(p.dkmsReady, ['nvidia', 'nvidia_uvm', 'nvidia_peermem']);
	assert.deepEqual(dkmsGap(p), ['nvidia-current-uvm.ko.xz']);
});

test('a staged kernel with no DKMS build of a running module is DEFERRED, never drained', async () => {
	const w = world({
		nodes: {
			'claw-1': box({ newest: NEW, dkmsRunning: NV, dkmsNewest: [], dkmsLoaded: ['nvidia'] }),
		},
	});
	const r = await runRebootCycle({ machines: [['claw-1', { role: 'claw' }]], deps: w.deps });
	assert.deepEqual(r.rebooted, []);
	assert.equal(
		w.calls.includes('drain claw-1'),
		false,
		'a node that would lose a driver is never taken out'
	);
	const f = r.findings.find((x) => x.kind === 'dkms-missing');
	assert.ok(f, JSON.stringify(r.findings));
	assert.match(f.reason, /linux-headers-amd64/);
	assert.match(f.reason, /nvidia-current\.ko\.xz/);
});

test('the gap is only about the TARGET kernel: a node already on its newest kernel has none', () => {
	assert.deepEqual(dkmsGap(box({ dkmsRunning: NV, dkmsNewest: [] })), []);
});

test('a DKMS module loaded before the reboot and neither loaded nor loadable after HOLDS the node', async () => {
	const w = world({
		nodes: {
			'claw-1': box({ newest: NEW, dkmsRunning: NV, dkmsNewest: NV, dkmsLoaded: ['nvidia'] }),
		},
		bootsInto: { 'claw-1': { dkmsLoaded: [] } },
	});
	const r = await runRebootCycle({ machines: [['claw-1', { role: 'claw' }]], deps: w.deps });
	assert.deepEqual(r.rebooted, []);
	const held = r.findings.find((x) => x.kind === 'verify-failed');
	assert.match(
		held?.reason ?? '',
		/DKMS module\(s\) neither loaded nor loadable after the reboot: nvidia/
	);
	assert.equal(w.doc.nodes['claw-1']?.kind, 'maintenance', 'held drained for a human');
});

test('an on-demand module (nvidia_uvm) not yet loaded after a fresh boot, but loadable, is back', async () => {
	// claw-9 and claw-8, 2026-10-25: uvm was loaded before because a CUDA job
	// had run; nothing loads it at boot. Both were held for it.
	const w = world({
		nodes: {
			'claw-8': box({
				newest: NEW,
				dkmsRunning: NV,
				dkmsNewest: NV,
				dkmsLoaded: ['nvidia', 'nvidia_uvm'],
			}),
		},
		bootsInto: {
			'claw-8': { dkmsLoaded: ['nvidia'], dkmsReady: ['nvidia', 'nvidia_uvm'] },
		},
	});
	const r = await runRebootCycle({ machines: [['claw-8', { role: 'claw' }]], deps: w.deps });
	assert.equal(r.ok, true, JSON.stringify(r.findings));
	assert.deepEqual(r.rebooted, ['claw-8']);
	assert.deepEqual(w.doc.nodes, {});
});

test('capabilities that do not re-prove after the reboot HOLD the node — no unproven label', async () => {
	const w = world({
		nodes: { 'claw-1': box({ newest: NEW }) },
		reprove: { 'claw-1': { ok: false, reason: 'nvenc-h264: listed-but-encode-failed' } },
	});
	const r = await runRebootCycle({ machines: [['claw-1', { role: 'claw' }]], deps: w.deps });
	assert.deepEqual(r.rebooted, []);
	assert.match(r.findings.find((x) => x.kind === 'verify-failed')?.reason ?? '', /nvenc-h264/);
	assert.equal(w.calls.includes('undrain claw-1'), false);
});

test('a pass with NO way to re-prove holds the node rather than trusting it', async () => {
	const w = world({ nodes: { 'claw-1': box({ newest: NEW }) }, noReprove: true });
	const r = await runRebootCycle({ machines: [['claw-1', { role: 'claw' }]], deps: w.deps });
	assert.deepEqual(r.rebooted, []);
	assert.match(
		r.findings.find((x) => x.kind === 'verify-failed')?.reason ?? '',
		/no way to re-prove/
	);
});

test('judgeReprove: exit 0, no findings, and the node actually in the results', () => {
	const ok = JSON.stringify({ findings: [], unreachable: [], results: { 'claw-1': {} } });
	assert.deepEqual(judgeReprove('claw-1', 0, ok), { ok: true });
	const failed = JSON.stringify({
		findings: ['claw-1 nvenc-h264 failed'],
		results: { 'claw-1': {} },
	});
	assert.match(judgeReprove('claw-1', 1, failed).reason, /nvenc-h264/);
	assert.match(
		judgeReprove('claw-1', 0, JSON.stringify({ findings: [], results: {} })).reason,
		/not in the capability results/
	);
	assert.match(
		judgeReprove(
			'claw-1',
			0,
			JSON.stringify({ findings: [], unreachable: ['claw-1'], results: { 'claw-1': {} } })
		).reason,
		/unreachable/
	);
	assert.equal(judgeReprove('claw-1', 0, 'not json').ok, false);
	assert.equal(judgeReprove('claw-1', 0, '').ok, false);
});
