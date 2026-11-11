import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';

import {
	judgeStep,
	makeConcurrencyTest,
	MAX_K,
	METRICS_MAX_BUFFER,
} from './qualify-concurrency.mjs';
import {
	emulatorScript,
	jobProfile,
	MIN_FLEET_ROWS,
	MIN_JOB_SEC,
	MIN_NODE_ROWS,
	parseEmulator,
	unitShape,
} from './qualify-emulator.mjs';
import { validateTest } from './qualify-registry.mjs';

const NOW = Date.parse('2026-11-11T18:00:00Z');
const DIE = 'hwmon.3.coretemp.Package_id_0';

/** n jobs (ids from `base`), joined to the controller's history. */
function jobs(n, { cores = 2, peakMb = 2048, writeMb = 150, sec = 600, base = 1000 } = {}) {
	const metrics = [];
	const history = [];
	for (let i = 0; i < n; i++) {
		metrics.push({
			ts: '2026-11-10T12:00:00Z',
			jobId: base + i,
			cpuUsageUsec: cores * sec * 1e6,
			peakBytes: peakMb * 2 ** 20,
			ioWriteBytes: writeMb * 2 ** 20,
		});
		history.push({ jobId: base + i, durationSec: sec });
	}
	return { metrics, history };
}

// ── profile and shape ──────────────────────────────────────────────────────

void test("a unit is, per dimension, the harsher of the fleet p75 job and this node's own p75 job", () => {
	const fleet = jobs(MIN_FLEET_ROWS, { cores: 2, peakMb: 3000, writeMb: 100, base: 10_000 });
	const own = jobs(MIN_NODE_ROWS, { cores: 4, peakMb: 1000, writeMb: 500, base: 20_000 });
	const p = jobProfile(
		{ other: fleet.metrics, me: own.metrics },
		[...fleet.history, ...own.history],
		'me',
		NOW
	);
	assert.equal(p.ok, true);
	// The fleet is mostly the 2-core jobs, so its p75 is 2; this node's own is 4.
	assert.deepEqual([p.cores, p.peakMb, p.writeMb], [4, 3000, 500]);
	assert.equal(p.nodeRows, MIN_NODE_ROWS);
});

void test('short and stale jobs do not count', () => {
	const fleet = jobs(MIN_FLEET_ROWS, { base: 10_000 });
	fleet.metrics.push({
		ts: '2026-11-10T12:00:00Z',
		jobId: 1,
		cpuUsageUsec: 1e12,
		peakBytes: 99 * 2 ** 30,
	});
	fleet.history.push({ jobId: 1, durationSec: MIN_JOB_SEC - 1 });
	fleet.metrics.push({
		ts: '2026-09-01T00:00:00Z',
		jobId: 2,
		cpuUsageUsec: 1e12,
		peakBytes: 99 * 2 ** 30,
	});
	fleet.history.push({ jobId: 2, durationSec: 900 });
	const p = jobProfile({ other: fleet.metrics }, fleet.history, 'me', NOW);
	assert.equal(p.fleetRows, MIN_FLEET_ROWS);
	assert.equal(p.peakMb, 2048);
});

void test('a node with too few jobs of its own is rated on the fleet alone, and says so', () => {
	const fleet = jobs(MIN_FLEET_ROWS, { base: 10_000 });
	const own = jobs(MIN_NODE_ROWS - 1, { cores: 9, base: 20_000 });
	const p = jobProfile(
		{ other: fleet.metrics, me: own.metrics },
		[...fleet.history, ...own.history],
		'me',
		NOW
	);
	assert.equal(p.own, null);
	assert.equal(p.cores, 2);
});

void test('too thin a fleet sample is not a measurement', () => {
	const fleet = jobs(MIN_FLEET_ROWS - 1, { base: 10_000 });
	const p = jobProfile({ other: fleet.metrics }, fleet.history, 'me', NOW);
	assert.equal(p.ok, false);
	assert.match(
		p.reason,
		new RegExp(`only ${MIN_FLEET_ROWS - 1} job\\(s\\).*needs ${MIN_FLEET_ROWS}`)
	);
});

void test('a unit splits its cores over whole workers at a duty, sized to run about 6 minutes alone', () => {
	const s = unitShape({ cores: 1.6, peakMb: 1000, writeMb: 10 }, 400);
	assert.deepEqual([s.workers, s.duty], [2, 0.8]);
	assert.equal(s.chunks, Math.round((360 * 0.8 * 400) / 64));
});

// ── the emulator, run for real here at a tiny size ─────────────────────────

void test('the emulator runs k units, reports each, and leaves nothing running or on disk', () => {
	const shape = { workers: 2, duty: 0.5, chunks: 2, chunkMb: 64, holdMb: 32, writeMb: 8 };
	// The run must END when its units do, not at the deadline: an orphaned
	// watchdog `sleep` holding stdout made every step last its full timeout.
	const started = Date.now();
	const out = execFileSync('bash', ['-s'], {
		input: emulatorScript({ k: 2, shape, timeoutSec: 120 }),
		encoding: 'utf8',
	});
	assert.ok(
		Date.now() - started < 60_000,
		`the run took ${Date.now() - started} ms: it waited out the watchdog`
	);
	const r = parseEmulator(out);
	assert.equal(r.complete, true, out);
	assert.equal(r.units.length, 2);
	assert.ok(
		r.units.every((u) => u.exit === 0 && !u.timedOut && u.wallSec > 0),
		JSON.stringify(r.units)
	);
	assert.ok(Number.isFinite(r.oomKills));
	assert.ok(r.t1 >= r.t0);
	assert.equal(
		spawnSync('pgrep', ['-f', 'qualify-emu/run'], { encoding: 'utf8' }).stdout.trim(),
		''
	);
});

void test('a unit past its deadline is killed with its whole process group, and says it timed out', () => {
	const shape = { workers: 2, duty: 0.2, chunks: 500, chunkMb: 64, holdMb: 16, writeMb: 1 };
	const out = execFileSync('bash', ['-s'], {
		input: emulatorScript({ k: 1, shape, timeoutSec: 2 }),
		encoding: 'utf8',
	});
	const r = parseEmulator(out);
	assert.equal(r.units[0].timedOut, true, out);
	// Killed as a GROUP: no orphaned worker is still hashing.
	assert.equal(
		spawnSync('pgrep', ['-f', 'qualify-emu/run'], { encoding: 'utf8' }).stdout.trim(),
		''
	);
});

void test('emulatorScript refuses a shape that is not whole numbers', () => {
	assert.throws(
		() =>
			emulatorScript({
				k: 1.5,
				shape: { workers: 1, duty: 1, chunks: 1, chunkMb: 64, holdMb: 1, writeMb: 1 },
				timeoutSec: 1,
			}),
		/bad k/
	);
	assert.throws(
		() =>
			emulatorScript({
				k: 1,
				shape: { workers: 1, duty: 0, chunks: 1, chunkMb: 64, holdMb: 1, writeMb: 1 },
				timeoutSec: 1,
			}),
		/bad duty/
	);
});

// ── judging a step ─────────────────────────────────────────────────────────

const row = (at, { cpu = 5, temp = 70, throttle = 1000 } = {}) => ({
	at,
	cpuSome10: cpu,
	cpuSome300: cpu,
	ioSome10: 0,
	memSome10: 0,
	workers: 0,
	throttle,
	temps: { [DIE]: temp },
});
const ok = (k, wall = 300) => ({
	units: Array.from({ length: k }, () => ({ wallSec: wall, exit: 0, timedOut: false })),
	oomKills: 0,
	t0: 0,
	t1: 999,
	complete: true,
});
const rows = (n, o) =>
	Array.from({ length: n }, (_, i) => row(i, typeof o === 'function' ? o(i) : o));

void test('a calm step holds', () => {
	const s = judgeStep({
		k: 2,
		samples: rows(20),
		run: ok(2, 320),
		baselineSec: 300,
		noDieTemperature: false,
	});
	assert.equal(s.verdict, 'held', s.reasons.join());
	assert.equal(s.metrics.ratio, 1.07);
});

void test('each bar, crossed alone, crosses the step and names itself', () => {
	const cases = [
		[{ samples: rows(20, { cpu: 25 }) }, /CPU pressure p90 25% ≥ 20%/],
		[{ samples: rows(20, { temp: 91 }) }, /package reached 91 °C ≥ 90 °C/],
		[{ samples: rows(20, (i) => ({ throttle: 1000 + i })) }, /19 new core throttle event/],
		[{ run: { ...ok(2), oomKills: 1 } }, /1 OOM kill/],
		[{ run: ok(2, 460) }, /slowest unit took 1.53x/],
		[
			{
				run: {
					...ok(2),
					units: [
						{ wallSec: 0, exit: 143, timedOut: true },
						{ wallSec: 300, exit: 0, timedOut: false },
					],
				},
			},
			/still running at the step's deadline/,
		],
	];
	for (const [over, re] of cases) {
		const s = judgeStep({
			k: 2,
			samples: rows(20),
			run: ok(2),
			baselineSec: 300,
			noDieTemperature: false,
			...over,
		});
		assert.equal(s.verdict, 'crossed', re.source);
		assert.match(s.reasons.join('; '), re);
	}
});

void test('the throttle bar is the DELTA in the step, not the lifetime counter', () => {
	const s = judgeStep({
		k: 1,
		samples: rows(20, { throttle: 513_754 }),
		run: ok(1),
		baselineSec: null,
		noDieTemperature: false,
	});
	assert.equal(s.verdict, 'held');
	assert.equal(s.metrics.throttleDelta, 0);
});

void test('a node that declares no die sensor is judged without one; one that does not declare it is unknown', () => {
	const noTemps = rows(20).map((r) => ({ ...r, temps: { 'hwmon.1.k10temp.temp1': 22 } }));
	assert.equal(
		judgeStep({ k: 1, samples: noTemps, run: ok(1), baselineSec: null, noDieTemperature: true })
			.verdict,
		'held'
	);
	const bare = rows(20).map((r) => ({ ...r, temps: {} }));
	const s = judgeStep({
		k: 1,
		samples: bare,
		run: ok(1),
		baselineSec: null,
		noDieTemperature: false,
	});
	assert.equal(s.verdict, 'could-not-look');
	assert.match(s.reasons.join(), /no CPU die sensor/);
});

void test('a cut-short step or an empty sampler is could-not-look, never held', () => {
	assert.equal(
		judgeStep({
			k: 2,
			samples: rows(20),
			run: { ...ok(2), complete: false },
			baselineSec: 300,
			noDieTemperature: false,
		}).verdict,
		'could-not-look'
	);
	assert.equal(
		judgeStep({ k: 2, samples: [], run: ok(2), baselineSec: 300, noDieTemperature: false }).verdict,
		'could-not-look'
	);
});

void test('a crossed bar outranks something unreadable in the same step', () => {
	const s = judgeStep({
		k: 2,
		samples: rows(20, { cpu: 30 }),
		run: { ...ok(2), oomKills: null },
		baselineSec: 300,
		noDieTemperature: false,
	});
	assert.equal(s.verdict, 'crossed');
});

// ── the ramp, against a fake node ──────────────────────────────────────────

/** A node whose step k reads `perK(k)`; records every k it was asked to run. */
function fakeNode({ phys = 4, memMb = 16000, perK, fleetJobs = MIN_FLEET_ROWS } = {}) {
	const { metrics, history: ownHistory } = jobs(MIN_NODE_ROWS);
	const fleet = jobs(fleetJobs, { base: 50_000 });
	const history = [...ownHistory, ...fleet.history];
	const readFleet = async () => ({ byNode: { other: fleet.metrics }, unreadable: {} });
	const ran = [];
	let pending = null;
	const ctx = {
		node: 'claw-fixture',
		machine: { minFreeMb: 2048 },
		nowMs: NOW,
		log: () => {},
		exec: async (script) => {
			if (script.includes('HASHRATE'))
				return { ok: true, stdout: `PHYS ${phys}\nMEM ${memMb}\nHASHRATE 400.0\n` };
			if (script.includes('job-metrics-read-end'))
				return {
					ok: true,
					stdout: `${metrics.map((m) => JSON.stringify(m)).join('\n')}\n#job-metrics-read-end kept=${metrics.length} older=0 files=1\n`,
				};
			const k = Number(script.match(/while \[ \$i -lt (\d+) \]; do run_unit/)[1]);
			ran.push(k);
			const p = perK(k);
			pending = p;
			const units = Array.from(
				{ length: k },
				(_, i) => `UNIT ${i} ${Math.round((p.wall ?? 300) * 1000)} 0 0`
			).join('\n');
			return { ok: true, stdout: `EMU-T0 0\n${units}\nEMU-T1 999\nOOMKILL 5 5\nEMU-END\n` };
		},
		sample: async () => ({
			stop: async () =>
				rows(20, pending ? { cpu: pending.cpu ?? 5, temp: pending.temp ?? 70 } : {}),
		}),
	};
	return { ctx, ran, history, readFleet };
}

const mk = (f, o = {}) =>
	makeConcurrencyTest({
		readHistory: () => f.history,
		readFleetMetrics: f.readFleet,
		sleep: async () => {},
		...o,
	});

void test('the ramp climbs until a bar crosses; the ceiling is the last k that held', async () => {
	const f = fakeNode({ perK: (k) => ({ cpu: k >= 3 ? 26 : 8 }) });
	const t = mk(f);
	assert.deepEqual(validateTest(t), []);
	const r = await t.run(f.ctx);
	assert.deepEqual(f.ran, [1, 2, 3]);
	assert.equal(r.status, 'pass');
	assert.equal(r.metrics.ceiling, 2);
	assert.match(r.reason, /holds 2 p75 job\(s\) side by side; k=3 crossed: CPU pressure p90 26%/);
});

void test('the ramp stops at physical cores, and says that is a cap, not a limit found', async () => {
	const f = fakeNode({ phys: 2, perK: () => ({}) });
	const r = await mk(f).run(f.ctx);
	assert.deepEqual(f.ran, [1, 2]);
	assert.match(r.reason, /reached the cap k=2 \(2 physical cores\) without crossing a bar/);
});

void test("memory caps k: what fits above minFreeMb at the profile's p90 peak", async () => {
	const f = fakeNode({ phys: 12, memMb: 2048 + 2048 * 3 + 100, perK: () => ({}) });
	const r = await mk(f).run(f.ctx);
	assert.equal(r.metrics.kMax, 3);
	assert.match(r.metrics.capWhy, /memory/);
});

void test('never above MAX_K', async () => {
	const f = fakeNode({ phys: 32, memMb: 512_000, perK: () => ({}) });
	await mk(f).run(f.ctx);
	assert.equal(Math.max(...f.ran), MAX_K);
});

void test('a node that cannot hold ONE p75 job fails', async () => {
	const f = fakeNode({ perK: () => ({ temp: 97 }) });
	const r = await mk(f).run(f.ctx);
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /does not hold even one p75 job.*package reached 97 °C/);
});

void test('the duration bar is measured against the k=1 wall', async () => {
	const f = fakeNode({ perK: (k) => ({ wall: k === 1 ? 300 : 300 * (1 + 0.3 * (k - 1)) }) });
	const r = await mk(f).run(f.ctx);
	// k=2 → 1.3x held; k=3 → 1.6x crossed.
	assert.equal(r.metrics.ceiling, 2);
	assert.match(r.reason, /k=3 crossed: slowest unit took 1.6x/);
});

void test('too little history, or an unreadable controller history, is could-not-look and runs nothing', async () => {
	const f = fakeNode({ fleetJobs: 3, perK: () => ({}) });
	const r = await mk(f).run(f.ctx);
	assert.equal(r.status, 'could-not-look');
	assert.deepEqual(f.ran, []);
	const g = fakeNode({ perK: () => ({}) });
	const r2 = await mk(g, {
		readHistory: () => {
			throw new Error('ENOENT');
		},
	}).run(g.ctx);
	assert.match(r2.reason, /job-history is unreadable: ENOENT/);
	assert.deepEqual(g.ran, []);
});

void test('a job-metrics read without its end sentinel is could-not-look, not a smaller history', async () => {
	const f = fakeNode({ perK: () => ({}) });
	const exec = f.ctx.exec;
	f.ctx.exec = async (script) =>
		script.includes('job-metrics-read-end')
			? { ok: false, stdout: '{"ts":"2026-11-10T00:00:00Z"}\n', stderr: 'ssh: connection reset' }
			: exec(script);
	const r = await mk(f).run(f.ctx);
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /job-metrics read did not finish: ssh: connection reset/);
	assert.deepEqual(f.ran, []);
});

void test("the job-metrics read asks for a buffer that holds a busy node's files (claw-9: ~5 MB, cut at 1 MiB)", async () => {
	const f = fakeNode({ perK: () => ({}) });
	const exec = f.ctx.exec;
	let asked = null;
	f.ctx.exec = async (script, o = {}) => {
		if (script.includes('job-metrics-read-end')) asked = o.maxBuffer ?? null;
		return exec(script, o);
	};
	await mk(f).run(f.ctx);
	assert.ok(asked >= 8 * 2 ** 20, `asked for ${asked}`);
	assert.equal(asked, METRICS_MAX_BUFFER);
});

void test('a node whose metrics cannot be read is left out of the fleet profile and named, not counted as no jobs', async () => {
	const f = fakeNode({ perK: () => ({}) });
	const logs = [];
	f.ctx.log = (m) => logs.push(m);
	const base = await f.readFleet();
	f.readFleet = async () => ({ ...base, unreadable: { 'claw-gone': 'ssh: no route to host' } });
	const r = await mk(f).run(f.ctx);
	assert.equal(r.status, 'pass');
	assert.ok(
		logs.some((l) => /claw-gone: job-metrics not read \(ssh: no route to host\)/.test(l)),
		logs.join('\n')
	);
});
