import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	bucketAlias,
	dataDirsToml,
	diskCeiling,
	diskQualified,
	parseSize,
	planBuckets,
	planLayout as planWith,
	quotaMb,
} from './garage-layout.mjs';
import { resultKey } from './qualify-results.mjs';

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

/** A qualify ledger in which every disk, root included, passed every disk test. */
const passDisks = Object.assign([], {
	find: (f) => [{ serial: '*', verdict: 'pass' }].find(() => f),
});
const PASS = {
	ok: true,
	results: new Proxy(
		{},
		{
			get: () => ({
				last: { at: 'T', metrics: { disks: passDisks, rootDisk: { verdict: 'pass' } } },
			}),
		}
	),
};
/** The plan with every disk qualified, unless a test hands its own ledger. */
const planLayout = (input) => planWith({ ledger: PASS, ...input });

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
		assert.deepEqual(diskCeiling(disk('S1', 800 * GB), obs), { ceiling: 800 * GB });
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
		assert.match(diskCeiling(disk('NOPE', 1), obs).why, /no disk with serial NOPE/);
		assert.match(
			diskCeiling(disk('S1', 1), { ...obs, disks: null, disksWhy: 'sudo refused' }).why,
			/sudo refused/
		);
	});
	it("a root zone: quota + the system's own use of / stays under 80%, the pool dir measured by du", () => {
		const root = { sizeBytes: 500 * GB, usedBytes: 150 * GB };
		const r = { serial: null, capacityBytes: 0, root: true };
		const rz = (duBytes, dir = true) => ({
			...up('a', [], root),
			rootZone: { dir, reserveMb: null, duBytes },
		});
		assert.deepEqual(diskCeiling(r, rz(null, false)), { ceiling: 250 * GB });
		// 50 GB of the 150 used is the pool's own directory: the rest of the system holds 100.
		assert.deepEqual(diskCeiling(r, rz(50 * GB)), { ceiling: 300 * GB });
		assert.match(diskCeiling(r, rz(null)).why, /size of \/srv\/storage\/root\/garage was not read/);
		assert.match(diskCeiling(r, { ...up('a', []), rootWhy: 'df failed' }).why, /df failed/);
		assert.match(diskCeiling(r, up('a', [], root)).why, /root zone directory was not read/);
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
		dataDirs: '',
		rootZone: { dir: false, reserveMb: null, duBytes: null },
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
				'claw-1 root-dir',
				'claw-1 data-dirs',
				'claw-1 install',
				'claw-8 secrets',
				'claw-8 data-dirs',
				'claw-8 install',
				'claw-9 secrets',
				'claw-9 data-dirs',
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

describe('root-disk zones (claw-8, claw-1: no spare disk)', () => {
	// Measured 2026-11-23 with df -B1 / on each node.
	const ROOT = {
		'claw-8': { sizeBytes: 1950014128128, usedBytes: 91752902656 },
		'claw-1': { sizeBytes: 969742974976, usedBytes: 129827389440 },
	};
	const rootZone = (quota) => active([{ serial: null, capacityBytes: quota, root: true }]);
	const node = (name, extra = {}) => ({
		probe: 'ok',
		why: null,
		nodeId: name,
		disks: [],
		root: ROOT[name],
		dataDirs: '',
		rootZone: { dir: false, reserveMb: null, duBytes: null },
		...extra,
	});

	it('the data dirs are the root zone directory with the quota as quoted bytes', () => {
		assert.equal(
			dataDirsToml([{ serial: null, capacityBytes: 2e11, root: true }]),
			'data_dir = [ { path = "/srv/storage/root/garage", capacity = "200000000000" } ]\n'
		);
		assert.equal(
			dataDirsToml([disk('S9', 8e11), disk('SA', 1e12)]),
			'data_dir = [ { path = "/srv/storage/S9/garage", capacity = "800000000000" }, ' +
				'{ path = "/srv/storage/SA/garage", capacity = "1000000000000" } ]\n'
		);
	});

	it('a new root zone: create the dir, reserve the quota from CI, write the data dirs, re-render', () => {
		const p = planLayout({
			declared: { zones: { 'claw-1': rootZone(200 * GB) } },
			cluster: null,
			state: null,
			zones: { 'claw-1': node('claw-1') },
		});
		assert.deepEqual(
			p.bringUp.map((s) => s.step),
			['root-dir', 'data-dirs', 'install']
		);
		assert.equal(p.bringUp[0].reserveMb, quotaMb(200 * GB));
		assert.equal(quotaMb(200 * GB), 190735);
		assert.match(p.bringUp[1].text, /\/srv\/storage\/root\/garage/);
	});

	it('read back as written, nothing is left to do; a changed quota re-reserves and re-renders', () => {
		const z = rootZone(200 * GB);
		const done = node('claw-1', {
			dataDirs: dataDirsToml(z.disks),
			rootZone: { dir: true, reserveMb: quotaMb(200 * GB), duBytes: 4096 },
		});
		const declared = { zones: { 'claw-1': z } };
		assert.deepEqual(
			planLayout({ declared, cluster: null, state: null, zones: { 'claw-1': done } }).bringUp,
			[]
		);
		const bigger = { zones: { 'claw-1': rootZone(300 * GB) } };
		assert.deepEqual(
			planLayout({
				declared: bigger,
				cluster: null,
				state: null,
				zones: { 'claw-1': done },
			}).bringUp.map((s) => s.step),
			['root-dir', 'data-dirs', 'install']
		);
	});

	it('a running zone whose config drifted gets an install step, nothing else (#153)', () => {
		const z = rootZone(200 * GB);
		const drifted = node('claw-1', {
			dataDirs: dataDirsToml(z.disks),
			rootZone: { dir: true, reserveMb: quotaMb(200 * GB), duBytes: 4096 },
			drift: '/etc/garage.toml not what this version renders',
		});
		const steps = planLayout({
			declared: { zones: { 'claw-1': z } },
			cluster: null,
			state: null,
			zones: { 'claw-1': drifted },
		}).bringUp;
		assert.deepEqual(
			steps.map((s) => `${s.node} ${s.step}`),
			['claw-1 install']
		);
		assert.match(steps[0].why, /re-render and restart: \/etc\/garage\.toml/);
	});

	it("quota + the node's non-Garage use must stay under 80% of /: claw-8 and claw-1 as measured", () => {
		const zones = { 'claw-8': node('claw-8'), 'claw-1': node('claw-1') };
		const at = (q8, q1) =>
			check(
				planLayout({
					declared: { zones: { 'claw-8': rootZone(q8), 'claw-1': rootZone(q1) } },
					cluster: null,
					state: null,
					zones,
				}),
				'ceiling'
			).map((c) => [c.subject, c.status]);
		// claw-1: 0.8 × 969.7 GB − 129.8 GB = 646.0 GB; claw-8: 1560.0 − 91.8 = 1468.3 GB.
		assert.deepEqual(at(1400 * GB, 600 * GB), [
			['claw-1 root', 'ok'],
			['claw-8 root', 'ok'],
		]);
		assert.deepEqual(at(1500 * GB, 700 * GB), [
			['claw-1 root', 'refused'],
			['claw-8 root', 'refused'],
		]);
	});

	it('a root disk must have passed SMR and SMART; a pool disk every disk test', () => {
		const ledger = (rootVerdict) => ({
			ok: true,
			results: {
				[resultKey('claw-1', 'disk-smr')]: {
					last: { at: 'T', metrics: { disks: [], rootDisk: { verdict: 'pass' } } },
				},
				[resultKey('claw-1', 'disk-smart')]: {
					last: {
						at: 'T',
						metrics: { disks: [], rootDisk: { verdict: rootVerdict, reason: '22 reallocated' } },
					},
				},
			},
		});
		const r = { serial: null, capacityBytes: 1, root: true };
		assert.deepEqual(diskQualified(ledger('pass'), 'claw-1', r), { ok: true });
		assert.match(
			diskQualified(ledger('fail'), 'claw-1', r).why,
			/disk-smart \(T\) says fail: 22 reallocated/
		);
		assert.match(
			diskQualified({ ok: true, results: {} }, 'claw-1', r).why,
			/no disk-smr result for claw-1/
		);
		// A pool disk is F5's rule: burn-in too, which this ledger has none of.
		assert.match(diskQualified(ledger('pass'), 'claw-1', disk('S1', 1)).why, /not qualified/);

		const p = planWith({
			declared: { zones: { 'claw-1': rootZone(200 * GB) } },
			cluster: null,
			state: null,
			zones: { 'claw-1': node('claw-1') },
			ledger: ledger('fail'),
		});
		assert.equal(check(p, 'qualified')[0].status, 'refused');
		assert.equal(p.refused, true);
	});
});
