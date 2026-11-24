import assert from 'node:assert/strict';
import { test } from 'node:test';

import { judgeWindow } from './qualify-baseline.mjs';
import { benchScript, makeBenchTest, parseBench } from './qualify-disk-bench.mjs';
import {
	BENCH_WRITE_P99_MAX_MS,
	benchTargets,
	judgeBench,
	poolReadings,
} from './qualify-disk-bench-judge.mjs';
import { validateTest } from './qualify-registry.mjs';
import { CLAW1 } from './storage-fixtures.mjs';

const pctl = (p50, p99) => ({ percentile: { '50.000000': p50 * 1e6, '99.000000': p99 * 1e6 } });
const doc = (jobs) => JSON.stringify({ jobs: jobs.map((j) => ({ error: 0, ...j })) });
const phase = (name, jobs, rc = 0) =>
	[`BENCH_${name}_BEGIN`, doc(jobs), `BENCH_${name}_RC ${rc}`, `BENCH_${name}_END`].join('\n');
const MiB = 1048576;
const OUTPUT = (over = {}) =>
	[
		'BENCH_ON /dev/sdb ext2/ext3',
		phase('seqw', [{ jobname: 'seqw', write: { bw_bytes: (over.seqw ?? 150) * MiB } }]),
		phase('seqr', [{ jobname: 'seqr', read: { bw_bytes: 160 * MiB } }]),
		phase('randr', [{ jobname: 'randr', read: { clat_ns: pctl(8, 25) } }]),
		phase('randw', [{ jobname: 'randw', write: { clat_ns: pctl(9, over.p99 ?? 40) } }]),
		phase('mixed', [
			{ jobname: 'blocks', write: { bw_bytes: 60 * MiB } },
			{ jobname: 'meta', write: { clat_ns: pctl(10, 55) } },
		]),
		'BENCH_END',
	].join('\n');

void test('the bench parses every phase, Garage-shaped ones by job name', () => {
	const b = parseBench(OUTPUT());
	assert.equal(b.complete, true);
	assert.deepEqual(b.reading, {
		seqWriteMbps: 150,
		seqReadMbps: 160,
		randReadP50Ms: 8,
		randReadP99Ms: 25,
		randWriteP50Ms: 9,
		randWriteP99Ms: 40,
		blockMbps: 60,
		metaP99Ms: 55,
	});
	// A phase whose fio failed is no reading, and the zone is not judged.
	const cut = parseBench(OUTPUT().replace('BENCH_randw_RC 0', 'BENCH_randw_RC 124'));
	assert.equal(cut.reading.randWriteP99Ms, null);
	assert.equal(judgeBench(cut.reading, []).verdict, 'blocked');
});

void test('the bars: absolute always, the pool median only with enough zones', () => {
	const r = parseBench(OUTPUT()).reading;
	assert.equal(judgeBench(r, []).verdict, 'pass');
	assert.match(judgeBench(r, []).reason, /pool-relative bar not applied: 0 other/);
	// Pool of NVMe-fast zones: 40 ms is over 4× a 5 ms median.
	const fast = [{ writeP99Ms: 4 }, { writeP99Ms: 6 }];
	const j = judgeBench(r, fast);
	assert.equal(j.verdict, 'fail');
	assert.match(j.reason, /4× the pool's median zone \(5 ms over 2 zone/);
	assert.equal(j.bars.relativeWriteP99MaxMs, 20);
	const slow = parseBench(OUTPUT({ p99: BENCH_WRITE_P99_MAX_MS + 1 })).reading;
	assert.match(judgeBench(slow, []).reason, /> 250 ms/);
	assert.match(judgeBench(parseBench(OUTPUT({ seqw: 12 })).reading, []).reason, /12 MB\/s < 20/);
});

const INV = {
	disks: [
		{
			serial: 'S6S2NS0TB21436H',
			model: 'Samsung 970',
			isRoot: true,
			mediaPresent: true,
			mountpoints: ['/'],
		},
		{
			serial: 'WD-A',
			model: 'WDC',
			isRoot: false,
			mediaPresent: true,
			mountpoints: ['/srv/storage/WD-A'],
		},
		{ serial: 'WD-B', model: 'WDC', isRoot: false, mediaPresent: true, mountpoints: [] },
	],
};
const PATHS = { rootZoneDir: '/srv/storage/root', mountPointFor: (s) => `/srv/storage/${s}` };

void test('targets: the declared zone first, else what is formatted and mounted', () => {
	const rootZone = benchTargets({
		zoneDisks: [{ serial: null, root: true }],
		inventory: INV,
		...PATHS,
	});
	assert.deepEqual(rootZone.targets, [
		{ serial: 'S6S2NS0TB21436H', model: 'Samsung 970', root: true, dir: '/srv/storage/root' },
	]);
	const undeclared = benchTargets({ zoneDisks: null, inventory: INV, ...PATHS });
	assert.deepEqual(
		undeclared.targets.map((t) => t.serial),
		['WD-A'],
		'an unformatted candidate is not benched'
	);
	const notMounted = benchTargets({ zoneDisks: [{ serial: 'WD-B' }], inventory: INV, ...PATHS });
	assert.match(notMounted.why[0], /not mounted at \/srv\/storage\/WD-B/);
	assert.match(
		benchTargets({ zoneDisks: null, inventory: { disks: [] }, ...PATHS }).why[0],
		/storage-format first/
	);
});

void test('the pool is every OTHER active zone that benched whole', () => {
	const declared = {
		zones: {
			'claw-1': { state: 'active' },
			'claw-8': { state: 'active' },
			'claw-9': { state: 'active' },
			'claw-4': { state: 'drain' },
		},
	};
	const bench = (p99) => ({
		last: { metrics: { disks: [{ serial: 'X', reading: { randWriteP99Ms: p99 } }] } },
	});
	const results = {
		'claw-1::disk-bench': bench(150),
		'claw-8::disk-bench': bench(5),
		'claw-4::disk-bench': bench(1),
		'claw-9::disk-bench': {
			last: { metrics: { disks: [{ serial: 'Y', reading: { randWriteP99Ms: null } }] } },
		},
	};
	assert.deepEqual(
		poolReadings({ declared, results, exceptNode: 'claw-8' }).map((p) => [p.node, p.writeP99Ms]),
		[['claw-1', 150]]
	);
});

void test('the script refuses a target that is not a zone directory', () => {
	assert.throws(() => benchScript({ dir: '/tmp/x', serial: 'WD-A' }), /not a storage zone/);
	assert.throws(() => benchScript({ dir: '/srv/storage/../etc', serial: 'WD-A' }));
	const s = benchScript({ dir: '/srv/storage/root', serial: 'S6S2NS0TB21436H' });
	assert.ok(s.indexOf('BENCH_REFUSE') < s.indexOf('fio --output-format'), 'guards first');
	assert.match(s, /--sync=dsync/);
	assert.match(s, /--name=blocks .* --fsync=1 --name=meta .* --fdatasync=1/);
});

void test('the test benches the root zone of a root-only node, and refuses nothing it did not reach', async () => {
	const t = makeBenchTest({ zoneDisks: [{ serial: null, root: true }], pool: [], ...PATHS });
	assert.deepEqual(validateTest(t), []);
	assert.equal(t.needsDrain, true);
	const scripts = [];
	const ctx = {
		node: 'claw-1',
		exec: async (script) => {
			scripts.push(script);
			return { ok: true, stdout: /QUALIFY_DISK_PROBE/.test(script) ? CLAW1 : OUTPUT() };
		},
	};
	const r = await t.run(ctx);
	assert.equal(r.status, 'pass', r.reason);
	assert.equal(r.metrics.disks[0].serial, 'SERIAL-claw-1-sda');
	assert.equal(r.metrics.disks[0].root, true);
	assert.match(scripts[1], /t='\/srv\/storage\/root'/);
	assert.deepEqual(t.touched(r), ['SERIAL-claw-1-sda']);

	const refused = await makeBenchTest({
		zoneDisks: [{ serial: null, root: true }],
		pool: [],
		...PATHS,
	}).run({
		node: 'claw-1',
		exec: async (script) => ({
			ok: true,
			stdout: /QUALIFY_DISK_PROBE/.test(script)
				? CLAW1
				: 'BENCH_REFUSE /srv/storage/root has 900 MiB free',
		}),
	});
	assert.equal(refused.status, 'could-not-look');
	assert.match(refused.reason, /refused on the node: .* 900 MiB free/);
});

void test('each reading is learned per serial and per model, and a slow zone is a weak point', () => {
	const reading = parseBench(OUTPUT({ p99: 400 })).reading;
	const window = judgeWindow({
		node: 'claw-10',
		results: [
			{
				id: 'disk-bench',
				status: 'fail',
				reason: '4k O_DSYNC write p99 400 ms > 250 ms',
				metrics: {
					disks: [{ serial: 'WD-A', model: 'WDC WD1002FAEX-00Z3A0', verdict: 'fail', reading }],
				},
			},
		],
		quantities: {},
	});
	const keys = window.readings.map((x) => x.quantity);
	assert.ok(keys.includes('disk.WD-A.bench.randWriteP99Ms'));
	assert.ok(keys.includes('disk.model.WDC_WD1002FAEX-00Z3A0.bench.blockMbps'));
	assert.deepEqual(window.findings, [], 'hardware is never a finding');
	assert.deepEqual(
		window.weak.map((w) => w.test),
		['disk-bench']
	);
});

void test('admission: shadow until enforced, then known for a member and refused for a newcomer', async () => {
	const { admissionChecks, diskAdmitted } = await import('./garage-admission.mjs');
	const entry = (disks) => ({ last: { at: new Date().toISOString(), metrics: { disks } } });
	const ledger = {
		ok: true,
		results: {
			'claw-8::disk-bench': entry([{ serial: 'S6S', root: true, verdict: 'pass' }]),
			'claw-8::disk-node-impact': entry([
				{
					serial: 'S6S',
					root: true,
					verdict: 'pass',
					tuning: { resyncTranquility: 5, scrubTranquility: 9 },
				},
			]),
			'claw-9::disk-bench': entry([
				{ serial: 'WD-A', verdict: 'fail', reason: 'p99 400 ms > 250 ms' },
			]),
		},
	};
	const ok = diskAdmitted(ledger, 'claw-8', { serial: null, root: true });
	assert.equal(ok.ok, true);
	assert.match(ok.why, /needs resync-tranquility 5/);
	assert.match(
		diskAdmitted(ledger, 'claw-1', { serial: null, root: true }).why,
		/no disk-bench result/
	);
	const declared = {
		zones: {
			'claw-8': { state: 'active', disks: [{ serial: null, root: true }] },
			'claw-9': { state: 'active', disks: [{ serial: 'WD-A' }] },
			'claw-10': { state: 'active', disks: [{ serial: 'WD-B' }] },
		},
	};
	const shadow = admissionChecks({ declared, ledger, inLayout: new Set(['claw-8', 'claw-9']) });
	assert.deepEqual(
		shadow.map((c) => [c.subject, c.status]),
		[
			['claw-10 WD-B', 'shadow'],
			['claw-8 root', 'ok'],
			['claw-9 WD-A', 'shadow'],
		]
	);
	const live = admissionChecks({
		declared,
		ledger,
		inLayout: new Set(['claw-8', 'claw-9']),
		enforced: true,
	});
	assert.deepEqual(
		live.map((c) => c.status),
		['refused', 'ok', 'known']
	);
});
