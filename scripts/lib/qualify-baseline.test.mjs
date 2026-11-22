/**
 * The node-relative judgement (#129), against results as the live ledger
 * recorded them: claw-1's window of 2026-11-21 and claw-6's of 11-17,
 * trimmed to the fields the policy reads.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { learnReading } from './node-baselines.mjs';
import { ABSOLUTE_TESTS, RELATIVE, judgeWindow } from './qualify-baseline.mjs';
import { QUALIFY_TESTS } from './qualify-playlist.mjs';

const RAMP_CLAW1 = {
	id: 'concurrency-ramp',
	status: 'fail',
	reason:
		'does not hold even one p75 job: package reached 98 °C ≥ 90 °C; 109832 new core throttle event(s)',
	metrics: {
		ceiling: 0,
		kMax: 2,
		hashRate: 543.8,
		steps: [
			{
				k: 1,
				cpuP90: 0.18,
				tempMax: 98,
				throttleDelta: 109832,
				oomKills: 0,
				verdict: 'crossed',
				reasons: ['package reached 98 °C ≥ 90 °C', '109832 new core throttle event(s)'],
			},
		],
	},
};
const DISK_CLAW1 = {
	id: 'disk-sync-writes',
	status: 'fail',
	reason: '4k O_DSYNC random-write p99 149.95 ms > 80 ms at k=1 parallel writers',
	metrics: { k: 1, rand: { p99Ms: 149.95 }, holdRatio: 0.91, sustainedMbps: 59 },
};
const TMPFS_CLAW1 = {
	id: 'tmpfs-headroom',
	status: 'pass',
	reason: 'with /tmp at 5348 of 5943 MiB, MemAvailable 5591 MiB ≥ 4151 MiB',
	metrics: { fullAvailMb: 5591 },
};
const FLOOR_CLAW10 = {
	id: 'floor-admin',
	status: 'fail',
	reason: 'smartmontools.service is failed (timeout), so it monitors no disk',
	metrics: {},
};
const NET_CLAW6 = {
	id: 'network-soak',
	status: 'fail',
	reason: 'HTTPS: p95 2.176679 s > 2 s',
	metrics: {
		dnsFailures: {},
		https: { fetches: 33, failed: 0, p95Sec: 2.176679 },
		lostAddrSamples: null,
		lostRouteSamples: null,
		bars: { httpsP95Sec: 2, httpsFailures: 1, dnsFailures: 0 },
	},
};

void test('every playlist test has a policy: absolute with a reason, or node-relative', () => {
	for (const t of QUALIFY_TESTS) {
		const abs = ABSOLUTE_TESTS[t.id];
		assert.ok(
			(typeof abs === 'string' && abs.length > 20) || RELATIVE[t.id],
			`${t.id} has no node-baseline policy`
		);
		assert.ok(!(abs && RELATIVE[t.id]), `${t.id} is both absolute and relative`);
	}
});

void test('claw-1 11-21 on an empty store: hardware misses are weak points, nothing is a finding', () => {
	const j = judgeWindow({
		node: 'claw-1',
		results: [RAMP_CLAW1, DISK_CLAW1, TMPFS_CLAW1],
		quantities: {},
	});
	assert.deepEqual(j.findings, []);
	assert.deepEqual(
		j.weak.map((w) => w.test),
		['concurrency-ramp', 'disk-sync-writes']
	);
	assert.deepEqual(j.cleared, ['tmpfs-headroom']);
	assert.ok(j.judged.every((x) => x.verdict === 'learning'));
	assert.deepEqual(
		j.readings.map((r) => [r.quantity, r.value]),
		[
			['ramp.ceiling', 0],
			['ramp.k1.packageTempC', 98],
			['ramp.k1.cpuPressureP90Pct', 0.18],
			['cpu.hashRate', 543.8],
			['disk.randSyncP99Ms.k1', 149.95],
			['disk.sustainedMbps', 59],
			['disk.holdRatio', 0.91],
			['mem.availWithTmpFullMb', 5591],
		]
	);
});

void test('the same window against its own range is clean; a disk that got worse is drift', () => {
	const seed = (v, spec) => learnReading(undefined, v, spec, new Date().toISOString(), false);
	const spec = (q) =>
		[...RELATIVE['disk-sync-writes'].quantities({ k: 1 })].find((x) => x.quantity === q).spec;
	const own = {
		'disk.randSyncP99Ms.k1': seed(140, spec('disk.randSyncP99Ms.k1')),
		'disk.sustainedMbps': seed(62, spec('disk.sustainedMbps')),
		'disk.holdRatio': seed(0.9, spec('disk.holdRatio')),
	};
	assert.deepEqual(
		judgeWindow({ node: 'claw-1', results: [DISK_CLAW1], quantities: own }).findings,
		[]
	);
	const worse = {
		...DISK_CLAW1,
		metrics: { ...DISK_CLAW1.metrics, rand: { p99Ms: 400 } },
	};
	const j = judgeWindow({ node: 'claw-1', results: [worse], quantities: own });
	assert.equal(j.findings.length, 1);
	assert.equal(j.findings[0].kind, 'drift');
	assert.match(
		j.findings[0].reason,
		/disk\.randSyncP99Ms\.k1 400 ms is worse than claw-1's range 140 ± 70 \(n=1\)/
	);
	assert.equal(j.readings.find((r) => r.quantity === 'disk.randSyncP99Ms.k1').drifted, true);
});

void test('an absolute bar stays a finding on any hardware', () => {
	const j = judgeWindow({ node: 'claw-10', results: [FLOOR_CLAW10], quantities: {} });
	assert.deepEqual(j.findings, [
		{
			node: 'claw-10',
			test: 'floor-admin',
			kind: 'absolute',
			reason: 'floor-admin: smartmontools.service is failed (timeout), so it monitors no disk',
		},
	]);
	assert.deepEqual(j.weak, []);
});

void test('a test with no policy is absolute, and says so', () => {
	const j = judgeWindow({
		node: 'claw-1',
		results: [{ id: 'brand-new', status: 'fail', reason: 'x', metrics: {} }],
		quantities: {},
	});
	assert.match(j.findings[0].reason, /no node-relative policy, so the bar is absolute/);
});

void test('network: slow HTTPS is a weak point; a failed name or fetch is a finding', () => {
	assert.deepEqual(
		judgeWindow({ node: 'claw-6', results: [NET_CLAW6], quantities: {} }).findings,
		[]
	);
	const dns = {
		...NET_CLAW6,
		metrics: { ...NET_CLAW6.metrics, dnsFailures: { 'github.com': 3 } },
	};
	const j = judgeWindow({ node: 'claw-6', results: [dns], quantities: {} });
	assert.deepEqual(
		j.findings.map((f) => f.reason),
		['network-soak: 3 DNS failure(s)']
	);
	assert.deepEqual(j.weak, []);
});

void test('ramp: an emulated unit that exited non-zero is a finding, not a weak point', () => {
	const broke = {
		...RAMP_CLAW1,
		metrics: {
			...RAMP_CLAW1.metrics,
			steps: [{ ...RAMP_CLAW1.metrics.steps[0], reasons: ['a unit exited 2'] }],
		},
	};
	const j = judgeWindow({ node: 'claw-1', results: [broke], quantities: {} });
	assert.deepEqual(
		j.findings.map((f) => f.reason),
		['concurrency-ramp k=1: a unit exited 2']
	);
});

void test('a could-not-look teaches the range nothing and clears no weak point', () => {
	const j = judgeWindow({
		node: 'claw-1',
		results: [{ ...DISK_CLAW1, status: 'could-not-look' }],
		quantities: {},
	});
	assert.deepEqual(j, { findings: [], weak: [], cleared: [], readings: [], judged: [] });
});
