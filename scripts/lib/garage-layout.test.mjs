import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bucketAlias, diskCeiling, parseSize, planBuckets, planLayout } from './garage-layout.mjs';

const TB = 1e12;
const GB = 1e9;

const active = (disks) => ({ state: 'active', disks });
const disk = (serial, capacityBytes) => ({ serial, capacityBytes });
/** A node probed with Garage running and the given disks. */
const up = (id, disks, root = null) => ({ probe: 'ok', why: null, nodeId: id, disks, root });
/** A layout role as GetClusterLayout returns it. */
const role = (id, node, capacity) => ({
	id,
	zone: node,
	tags: [node],
	capacity,
	storedPartitions: 256,
});
/** A cluster with `roles`, every node up unless named in `down`. */
const cluster = (roles, { down = [], history = [], version = 1 } = {}) => ({
	layout: { version, roles },
	status: { nodes: roles.map((r) => ({ id: r.id, isUp: !down.includes(r.tags[0]) })) },
	history: { versions: history },
});
const used = (pairs) => ({
	nodes: Object.entries(pairs).map(([node, usedBytes]) => ({ node, usedBytes })),
});
const check = (p, rule) => p.checks.filter((c) => c.rule === rule);

describe('parseSize', () => {
	it('reads decimal units and bytes, and refuses anything else', () => {
		assert.equal(parseSize('800G'), 800 * GB);
		assert.equal(parseSize('3.2T'), 3.2 * TB);
		assert.equal(parseSize('500000000'), 5e8);
		assert.equal(parseSize('200GB'), 200 * GB);
		assert.equal(parseSize('lots'), null);
		assert.equal(parseSize(''), null);
	});
});

describe('the ceiling: 80% of the disk as the node reports it', () => {
	const obs = up('a', [{ serial: 'S1', sizeBytes: TB }]);
	it('fits at 80% and is refused above it', () => {
		assert.deepEqual(diskCeiling(disk('S1', 800 * GB), obs, 0), { ceiling: 800 * GB });
		const p = planLayout({
			declared: { zones: { 'claw-x': active([disk('S1', 801 * GB)]) } },
			cluster: null,
			state: null,
			zones: { 'claw-x': obs },
		});
		const [c] = check(p, 'ceiling');
		assert.equal(c.status, 'refused');
		assert.match(c.why, /801\.0 GB is over its 80% ceiling of 800\.0 GB/);
	});
	it('a serial the node does not report, or disks not read, is could-not-look', () => {
		assert.match(diskCeiling(disk('NOPE', 1), obs, 0).why, /no disk with serial NOPE/);
		assert.match(
			diskCeiling(disk('S1', 1), { ...obs, disks: null, disksWhy: 'sudo refused' }, 0).why,
			/sudo refused/
		);
	});
	it("a zone on root gets 80% less what the system already holds there, not counting the pool's own data", () => {
		const root = { sizeBytes: 500 * GB, usedBytes: 150 * GB };
		const r = { serial: null, capacityBytes: 0, root: true };
		assert.deepEqual(diskCeiling(r, up('a', [], root), 0), { ceiling: 250 * GB });
		// 50 GB of the 150 used is Garage's: the rest of the system holds 100.
		assert.deepEqual(diskCeiling(r, up('a', [], root), 50 * GB), { ceiling: 300 * GB });
		assert.match(diskCeiling(r, { ...up('a', []), rootWhy: 'df failed' }, 0).why, /df failed/);
	});
});

describe('the pilot: claw-8, claw-9, claw-1 on its root, no cluster yet', () => {
	const declared = {
		zones: {
			'claw-8': active([disk('S8', 800 * GB)]),
			'claw-9': active([disk('S9', 800 * GB)]),
			'claw-1': active([{ serial: null, capacityBytes: 200 * GB, root: true }]),
		},
	};
	const absent = (disks, root = null) => ({
		probe: 'absent',
		why: 'Garage is not installed',
		nodeId: null,
		disks,
		root,
	});
	const zones = {
		'claw-8': absent([{ serial: 'S8', sizeBytes: TB }]),
		'claw-9': absent([{ serial: 'S9', sizeBytes: TB }]),
		'claw-1': absent([], { sizeBytes: 500 * GB, usedBytes: 120 * GB }),
	};
	it('brings all three up, adds three zones, and reports N+1 as known, not refused', () => {
		const p = planLayout({ declared, cluster: null, state: null, zones });
		assert.equal(p.refused, false);
		assert.deepEqual(
			p.bringUp.map((s) => `${s.node} ${s.step}`),
			[
				'claw-1 secrets',
				'claw-1 install',
				'claw-8 secrets',
				'claw-8 install',
				'claw-9 secrets',
				'claw-9 install',
			]
		);
		assert.deepEqual(
			p.changes.map((c) => [c.node, c.kind, c.to]),
			[
				['claw-1', 'add', 200 * GB],
				['claw-8', 'add', 800 * GB],
				['claw-9', 'add', 800 * GB],
			]
		);
		assert.equal(check(p, 'floor')[0].status, 'ok');
		assert.equal(check(p, 'n-plus-1')[0].status, 'known');
		assert.deepEqual(
			check(p, 'ceiling').map((c) => c.status),
			['ok', 'ok', 'ok']
		);
		assert.equal(p.layout.version, 1);
		assert.equal(p.layout.pendingBringUp, true);
	});
	it('without the vault items in the environment, each secrets step is BLOCKED and names them', () => {
		const p = planLayout({
			declared,
			cluster: null,
			state: null,
			zones,
			secretsMissing: ['GARAGE_RPC_SECRET', 'GARAGE_ADMIN_TOKEN'],
		});
		const s = p.bringUp.filter((x) => x.step === 'secrets');
		assert.equal(s.length, 3);
		assert.ok(s.every((x) => x.blocked && /GARAGE_RPC_SECRET, GARAGE_ADMIN_TOKEN/.test(x.why)));
		assert.equal(p.blocked, true);
	});
	it('an unreachable node is a blocked bring-up step, never a silent skip', () => {
		const p = planLayout({
			declared,
			cluster: null,
			state: null,
			zones: {
				...zones,
				'claw-9': { probe: 'unreachable', why: 'ssh: timed out', nodeId: null, disks: null },
			},
		});
		const reach = p.bringUp.find((s) => s.node === 'claw-9');
		assert.equal(reach.step, 'reach');
		assert.equal(reach.blocked, true);
		assert.equal(
			check(p, 'ceiling').find((c) => c.subject.startsWith('claw-9')).status,
			'could-not-look'
		);
		assert.equal(p.refused, true);
	});
});

describe('the floor: never below 3 healthy zones', () => {
	const roles3 = [role('a', 'claw-a', TB), role('b', 'claw-b', TB), role('c', 'claw-c', TB)];
	const zones = {
		'claw-a': up('a', [{ serial: 'A', sizeBytes: 2 * TB }]),
		'claw-b': up('b', [{ serial: 'B', sizeBytes: 2 * TB }]),
		'claw-c': up('c', [{ serial: 'C', sizeBytes: 2 * TB }]),
	};
	const three = {
		zones: {
			'claw-a': active([disk('A', TB)]),
			'claw-b': active([disk('B', TB)]),
			'claw-c': active([disk('C', TB)]),
		},
	};
	it('two zones to start a pool are refused', () => {
		const p = planLayout({
			declared: { zones: { 'claw-a': three.zones['claw-a'], 'claw-b': three.zones['claw-b'] } },
			cluster: null,
			state: null,
			zones,
		});
		assert.equal(check(p, 'floor')[0].status, 'refused');
		assert.equal(p.layout, null);
	});
	it('draining one of three is refused; --override goes ahead and names the rule', () => {
		const declared = {
			zones: { ...three.zones, 'claw-c': { ...three.zones['claw-c'], state: 'drain' } },
		};
		const c = cluster(roles3);
		const st = used({ 'claw-a': 0, 'claw-b': 0, 'claw-c': 0 });
		const p = planLayout({ declared, cluster: c, state: st, zones });
		assert.equal(p.refused, true);
		assert.equal(p.layout, null);
		const o = planLayout({
			declared,
			cluster: c,
			state: st,
			zones,
			override: 'retiring the pilot',
		});
		assert.equal(o.refused, false);
		assert.deepEqual(o.overridden, ['floor']);
		assert.deepEqual(o.layout.roles, [{ id: 'c', remove: true }]);
	});
	it('a change while a zone is DOWN counts only the healthy ones', () => {
		const declared = { zones: { ...three.zones, 'claw-a': active([disk('A', 1.5 * TB)]) } };
		const p = planLayout({
			declared,
			cluster: cluster(roles3, { down: ['claw-b'] }),
			state: used({ 'claw-a': 0, 'claw-b': 0, 'claw-c': 0 }),
			zones,
		});
		assert.match(check(p, 'floor')[0].why, /^2 healthy zone\(s\) after the change \(2 now\)/);
		assert.equal(check(p, 'floor')[0].status, 'refused');
	});
	it('with no change, a degraded pool is reported as known, not refused', () => {
		const p = planLayout({
			declared: three,
			cluster: cluster(roles3, { down: ['claw-b'] }),
			state: used({ 'claw-a': 0, 'claw-b': 0, 'claw-c': 0 }),
			zones,
		});
		assert.equal(check(p, 'floor')[0].status, 'known');
		assert.equal(p.refused, false);
	});
});

describe('N+1: free outside the biggest zone holds its used bytes', () => {
	const big = { serial: 'X', sizeBytes: 10 * TB };
	const zones = Object.fromEntries(
		['a', 'b', 'c', 'd'].map((n) => [`claw-${n}`, up(n, [{ ...big, serial: n.toUpperCase() }])])
	);
	const roles = [
		role('a', 'claw-a', 4 * TB),
		role('b', 'claw-b', TB),
		role('c', 'claw-c', TB),
		role('d', 'claw-d', TB),
	];
	const declared = (caps) => ({
		zones: Object.fromEntries(
			Object.entries(caps).map(([n, cap]) => [n, active([disk(n.slice(-1).toUpperCase(), cap)])])
		),
	});
	it('holds when the others have room for the biggest zone', () => {
		const p = planLayout({
			declared: declared({ 'claw-a': 4 * TB, 'claw-b': TB, 'claw-c': TB, 'claw-d': TB }),
			cluster: cluster(roles),
			state: used({
				'claw-a': 0.9 * TB,
				'claw-b': 0.3 * TB,
				'claw-c': 0.3 * TB,
				'claw-d': 0.3 * TB,
			}),
			zones,
		});
		const [n] = check(p, 'n-plus-1');
		assert.equal(n.status, 'ok');
		assert.match(
			n.why,
			/free outside claw-a \(the biggest zone\) is 2100\.0 GB; it holds 900\.0 GB/
		);
	});
	it('a shrink that leaves too little room outside the biggest zone is refused', () => {
		const p = planLayout({
			declared: declared({
				'claw-a': 4 * TB,
				'claw-b': 0.5 * TB,
				'claw-c': 0.5 * TB,
				'claw-d': 0.5 * TB,
			}),
			cluster: cluster(roles),
			state: used({
				'claw-a': 1.2 * TB,
				'claw-b': 0.3 * TB,
				'claw-c': 0.3 * TB,
				'claw-d': 0.3 * TB,
			}),
			zones,
		});
		assert.equal(check(p, 'n-plus-1')[0].status, 'refused');
		assert.equal(p.refused, true);
	});
	it('already short and not made worse is known, so a fix can go through', () => {
		const p = planLayout({
			declared: declared({ 'claw-a': 4 * TB, 'claw-b': 1.2 * TB, 'claw-c': TB, 'claw-d': TB }),
			cluster: cluster(roles),
			state: used({ 'claw-a': 3 * TB, 'claw-b': 0.3 * TB, 'claw-c': 0.3 * TB, 'claw-d': 0.3 * TB }),
			zones,
		});
		assert.equal(check(p, 'n-plus-1')[0].status, 'known');
		assert.equal(p.refused, false);
	});
	it('a member with no used reading is could-not-look, and no override passes it', () => {
		const p = planLayout({
			declared: declared({ 'claw-a': 4 * TB, 'claw-b': TB, 'claw-c': TB, 'claw-d': 2 * TB }),
			cluster: cluster(roles),
			state: used({ 'claw-a': 0, 'claw-b': null, 'claw-c': 0, 'claw-d': 0 }),
			zones,
			override: 'please',
		});
		assert.equal(check(p, 'n-plus-1')[0].status, 'could-not-look');
		assert.equal(p.refused, true);
		assert.deepEqual(p.overridden, []);
	});
});

describe('drain before remove', () => {
	const roles = ['a', 'b', 'c', 'd'].map((n) => role(n, `claw-${n}`, TB));
	const zones = Object.fromEntries(
		['a', 'b', 'c', 'd'].map((n) => [`claw-${n}`, up(n, [{ serial: n, sizeBytes: 2 * TB }])])
	);
	const all = Object.fromEntries(
		['a', 'b', 'c', 'd'].map((n) => [`claw-${n}`, active([disk(n, TB)])])
	);
	const st = used({ 'claw-a': 0, 'claw-b': 0, 'claw-c': 0, 'claw-d': 0 });
	const drainD = { zones: { ...all, 'claw-d': { ...all['claw-d'], state: 'drain' } } };
	it('a draining zone in the layout comes out of it', () => {
		const p = planLayout({ declared: drainD, cluster: cluster(roles), state: st, zones });
		assert.deepEqual(p.changes, [{ node: 'claw-d', kind: 'remove', from: TB, to: null }]);
		assert.deepEqual(p.layout.roles, [{ id: 'd', remove: true }]);
	});
	it('out of the layout while an older version drains: wait, and nothing else is staged', () => {
		const p = planLayout({
			declared: drainD,
			cluster: cluster(roles.slice(0, 3), { history: [{ version: 4, status: 'Draining' }] }),
			state: st,
			zones,
		});
		assert.deepEqual(
			p.waiting.map((w) => w.node),
			['claw-d']
		);
		assert.deepEqual(p.changes, []);
	});
	it('drained and Garage still running: stop it; drained and gone: forget it', () => {
		const p = planLayout({
			declared: drainD,
			cluster: cluster(roles.slice(0, 3)),
			state: st,
			zones,
		});
		assert.deepEqual(p.changes, [{ node: 'claw-d', kind: 'stop', from: null, to: null }]);
		const q = planLayout({
			declared: drainD,
			cluster: cluster(roles.slice(0, 3)),
			state: st,
			zones: { ...zones, 'claw-d': { probe: 'absent', why: null, nodeId: null, disks: [] } },
		});
		assert.match(q.known[0].why, /--forget claw-d/);
	});
	it('a member the file does not declare is left in place, never dropped', () => {
		const three = { ...all };
		delete three['claw-d'];
		const p = planLayout({ declared: { zones: three }, cluster: cluster(roles), state: st, zones });
		assert.deepEqual(p.changes, []);
		assert.match(p.known.find((k) => k.node === 'claw-d').why, /not declared; left as it is/);
	});
	it('any staged change waits while an older layout version drains', () => {
		const p = planLayout({
			declared: { zones: { ...all, 'claw-a': active([disk('a', 1.5 * TB)]) } },
			cluster: cluster(roles, {
				history: [
					{ version: 1, status: 'Draining' },
					{ version: 2, status: 'Current' },
				],
			}),
			state: st,
			zones,
		});
		assert.equal(p.layout, null);
		assert.match(p.waiting[0].why, /one layout change at a time/);
	});
});

describe('buckets', () => {
	const declared = { buckets: { photos: { key: 'dp-photos' } } };
	it('a namespace makes dp-<ns>, and a name S3 would refuse is refused', () => {
		assert.equal(bucketAlias('photos'), 'dp-photos');
		assert.throws(() => bucketAlias('Photos'), /does not make an S3 bucket name/);
		assert.throws(() => bucketAlias('a'.repeat(61)), /at most 60 characters/);
		assert.throws(() => bucketAlias('-x'), /S3 bucket name/);
	});
	it('nothing there: create the bucket, the key, then grant', () => {
		const b = planBuckets({
			declared,
			observed: { photos: { bucket: null, key: null, error: null } },
		});
		assert.deepEqual(b.ops, [
			{ ns: 'photos', op: 'create-bucket', alias: 'dp-photos' },
			{ ns: 'photos', op: 'create-key', key: 'dp-photos' },
			{ ns: 'photos', op: 'grant', alias: 'dp-photos', key: 'dp-photos' },
		]);
	});
	it('a key granted read but not write is re-granted; a full grant is nothing to do', () => {
		const key = { accessKeyId: 'GK1' };
		const bucket = (permissions) => ({ keys: [{ accessKeyId: 'GK1', permissions }] });
		const half = planBuckets({
			declared,
			observed: { photos: { bucket: bucket({ read: true, write: false }), key } },
		});
		assert.deepEqual(
			half.ops.map((o) => o.op),
			['grant']
		);
		const full = planBuckets({
			declared,
			observed: { photos: { bucket: bucket({ read: true, write: true }), key } },
		});
		assert.deepEqual(full.ops, []);
	});
	it('a read that failed is a problem, not a create', () => {
		const b = planBuckets({
			declared,
			observed: { photos: { bucket: null, key: null, error: 'HTTP 500' } },
		});
		assert.deepEqual(b.ops, []);
		assert.match(b.problems[0].why, /dp-photos could not be read: HTTP 500/);
	});
	it('a dp- bucket nobody declares is reported, never removed', () => {
		const b = planBuckets({
			declared,
			observed: {
				photos: {
					bucket: { keys: [{ accessKeyId: 'K', permissions: { read: true, write: true } }] },
					key: { accessKeyId: 'K' },
				},
			},
			buckets: [
				{ globalAliases: ['dp-photos'] },
				{ globalAliases: ['dp-old'] },
				{ globalAliases: ['other'] },
			],
		});
		assert.deepEqual(b.undeclared, ['dp-old']);
		assert.deepEqual(b.ops, []);
	});
});
