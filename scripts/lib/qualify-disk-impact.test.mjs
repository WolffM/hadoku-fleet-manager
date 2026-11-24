import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	IMPACT_IO_PSI_P90,
	impactResult,
	judgeLevel,
	loadAt,
	tuningFor,
} from './qualify-disk-impact-judge.mjs';
import {
	loadStartScript,
	loadStopScript,
	makeImpactTest,
	parseRootProbe,
	rootProbeScript,
} from './qualify-disk-impact.mjs';
import { validateTest } from './qualify-registry.mjs';
import { CLAW1 } from './storage-fixtures.mjs';

const HELD = { verdict: 'held', reasons: [], metrics: { worstSec: 300 } };
const io = (...xs) => xs.map((x) => ({ ioSome10: x }));

void test("the load is Garage's default resync and scrub share of the zone's own rates", () => {
	// Resync tranquility 2 holds a third of the disk, scrub's 4 a fifth.
	assert.deepEqual(loadAt({ seqWriteMbps: 150, seqReadMbps: 160 }, 1), {
		writeMbps: 50,
		readMbps: 32,
	});
	assert.deepEqual(loadAt({ seqWriteMbps: 150, seqReadMbps: 160 }, 0.5), {
		writeMbps: 25,
		readMbps: 16,
	});
	assert.equal(tuningFor(1), null);
	// Half the default duty: (1+2)/0.5 − 1 = 5, (1+4)/0.5 − 1 = 9.
	assert.deepEqual(
		{ ...tuningFor(0.5), why: undefined },
		{ resyncTranquility: 5, scrubTranquility: 9, why: undefined }
	);
});

void test('a level holds only when every bar the node holds without the load still holds', () => {
	assert.equal(
		judgeLevel({ step: HELD, samples: io(1, 2, 3), rootP99Base: 10, rootP99Load: 18 }).verdict,
		'held'
	);
	const psi = judgeLevel({ step: HELD, samples: io(9, 12, 15), rootP99Base: 10, rootP99Load: 12 });
	assert.match(psi.reasons[0], new RegExp(`IO pressure p90 15% ≥ ${IMPACT_IO_PSI_P90}%`));
	// claw-8-like NVMe root crossing the CI fsync bar it otherwise holds.
	const root = judgeLevel({ step: HELD, samples: io(1), rootP99Base: 25, rootP99Load: 90 });
	assert.ok(root.reasons.some((r) => /> 80 ms \(25 ms without/.test(r)));
	// claw-1-like HDD root already over 80: judged against itself, not the bar it never held.
	assert.equal(
		judgeLevel({ step: HELD, samples: io(1), rootP99Base: 150, rootP99Load: 290 }).verdict,
		'held'
	);
	assert.equal(
		judgeLevel({ step: HELD, samples: io(1), rootP99Base: 150, rootP99Load: 320 }).verdict,
		'crossed'
	);
	const ramp = {
		verdict: 'crossed',
		reasons: ['slowest unit took 1.7x its time alone'],
		metrics: {},
	};
	assert.equal(
		judgeLevel({ step: ramp, samples: io(1), rootP99Base: 10, rootP99Load: 10 }).verdict,
		'crossed'
	);
	const blind = judgeLevel({ step: HELD, samples: [], rootP99Base: null, rootP99Load: 10 });
	assert.equal(blind.verdict, 'could-not-look');
});

void test('the result: the highest level held, with tuning below level 1; none held is a fail', () => {
	const lvl = (level, verdict) => ({
		level,
		verdict,
		load: { writeMbps: 50 * level, readMbps: 32 * level },
		reasons: verdict === 'crossed' ? ['IO pressure p90 15% ≥ 10%'] : [],
		metrics: {},
	});
	const full = impactResult('WD-A', [lvl(1, 'held')]);
	assert.equal(full.verdict, 'pass');
	assert.equal(full.tuning, null);
	const half = impactResult('WD-A', [lvl(1, 'crossed'), lvl(0.5, 'held')]);
	assert.equal(half.verdict, 'pass');
	assert.equal(half.tolerated, 0.5);
	assert.match(half.reason, /admit with resync-tranquility 5, scrub-tranquility 9/);
	const none = impactResult('WD-A', [lvl(1, 'crossed'), lvl(0.5, 'crossed'), lvl(0.25, 'crossed')]);
	assert.equal(none.verdict, 'fail');
	assert.equal(none.tolerated, 0);
	assert.equal(impactResult('WD-A', [lvl(1, 'could-not-look')]).verdict, 'blocked');
});

void test('the load is bounded, guarded and stoppable; the stop names only its own directory', () => {
	const s = loadStartScript({
		dir: '/srv/storage/root',
		serial: 'S6S2NS0TB21436H',
		writeMbps: 50,
		readMbps: 32,
		totalSec: 900,
	});
	assert.match(s, /--rate=50m --fsync=1 --size=2048M/);
	assert.match(s, /--name=scrub .* --rate=32m --direct=1/);
	assert.ok(s.indexOf('LOAD_REFUSE') < s.indexOf('setsid'), 'guards before the load');
	assert.match(s, /setsid nohup/);
	assert.throws(() =>
		loadStartScript({
			dir: '/srv/storage/root/garage',
			serial: 'X1',
			writeMbps: 1,
			readMbps: 1,
			totalSec: 1,
		})
	);
	assert.throws(() => loadStopScript('/srv/storage/root'), /unexpected load dir/);
	assert.match(loadStopScript('/srv/storage/root/qualify-impact.Ab12Cd'), /kill -TERM -- "-\$p"/);
	assert.match(rootProbeScript(), /--sync=dsync/);
	assert.equal(
		parseRootProbe(
			'PROBE_BEGIN\n{"jobs":[{"error":0,"write":{"clat_ns":{"percentile":{"99.000000":25000000}}}}]}\nPROBE_RC 0\nPROBE_END'
		),
		25
	);
	assert.equal(parseRootProbe('PROBE_BEGIN\nPROBE_RC 1\nPROBE_END'), null);
});

const RAMP = {
	shape: { workers: 2, duty: 0.5, chunks: 3, chunkMb: 64, holdMb: 100, writeMb: 50 },
	steps: [{ worstSec: 300 }],
};
const READING = { seqWriteMbps: 60, seqReadMbps: 65 };
const PATHS = { rootZoneDir: '/srv/storage/root', mountPointFor: (s) => `/srv/storage/${s}` };
const PROBE = (p99) =>
	`PROBE_BEGIN\n${JSON.stringify({ jobs: [{ error: 0, write: { clat_ns: { percentile: { '99.000000': p99 * 1e6 } } } }] })}\nPROBE_RC 0\nPROBE_END`;

function fakeNode({ rootLoaded = 20, unitSec = 310, ioP = 2, loadFailed = '' } = {}) {
	const calls = [];
	let probes = 0;
	return {
		calls,
		ctx: {
			node: 'claw-1',
			machine: { thermal: { noDieTemperature: true } },
			log: () => {},
			exec: async (script) => {
				calls.push(script.split('\n')[0]);
				if (/QUALIFY_DISK_PROBE/.test(script)) return { ok: true, stdout: CLAW1 };
				if (/PROBE_BEGIN/.test(script))
					return { ok: true, stdout: PROBE(probes++ % 2 ? rootLoaded : 18) };
				if (/LOAD_DIR/.test(script))
					return { ok: true, stdout: 'LOAD_DIR /srv/storage/root/qualify-impact.Ab12Cd' };
				if (/DISK_IMPACT_STOP_EOF/.test(script))
					return { ok: true, stdout: `LOAD_STOPPED ${loadFailed ? `failed: ${loadFailed}` : ''}` };
				if (/EMU-T0/.test(script))
					return {
						ok: true,
						stdout: `EMU-T0 100\nUNIT 0 ${unitSec * 1000} 0 0\nEMU-T1 400\nOOMKILL 0 0\nEMU-END`,
					};
				return { ok: true, stdout: '' };
			},
			sample: async () => ({
				stopped: false,
				async stop() {
					this.stopped = true;
					return [{ at: 200, cpuSome10: 1, ioSome10: ioP, throttle: 0, temps: {} }];
				},
			}),
		},
	};
}

void test('the soak, on a root-only node: holds level 1, and stops its load every time', async () => {
	const t = makeImpactTest({
		zoneDisks: [{ serial: null, root: true }],
		benchOf: () => READING,
		ramp: RAMP,
		...PATHS,
		sleep: async () => {},
	});
	assert.deepEqual(validateTest(t), []);
	const n = fakeNode();
	const r = await t.run(n.ctx);
	assert.equal(r.status, 'pass', r.reason);
	assert.equal(r.metrics.disks[0].tolerated, 1);
	assert.equal(n.calls.filter((c) => /DISK_IMPACT_STOP/.test(c)).length, 1);
	assert.deepEqual(t.touched(r), ['SERIAL-claw-1-sda']);

	// IO pressure over the bar at every level: three levels, three stops, a fail.
	const hot = fakeNode({ ioP: 30 });
	const f = await t.run(hot.ctx);
	assert.equal(f.status, 'fail');
	assert.equal(hot.calls.filter((c) => /DISK_IMPACT_STOP/.test(c)).length, 3);

	// A load that died early is no reading, never a pass.
	const dead = await t.run(fakeNode({ loadFailed: 'the resync stream wrote 0 bytes' }).ctx);
	assert.equal(dead.status, 'could-not-look');
});

void test('without its own bench or ramp the soak could not look', async () => {
	const noRamp = makeImpactTest({ zoneDisks: null, benchOf: () => READING, ramp: null, ...PATHS });
	assert.match((await noRamp.run(fakeNode().ctx)).reason, /no concurrency-ramp k=1 result/);
	const noBench = makeImpactTest({
		zoneDisks: [{ serial: null, root: true }],
		benchOf: () => null,
		ramp: RAMP,
		...PATHS,
	});
	assert.match((await noBench.run(fakeNode().ctx)).reason, /no disk-bench reading/);
});
