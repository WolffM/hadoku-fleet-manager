/**
 * `concurrency-ramp` — how many demanding jobs this node holds side by side
 * before it stops being a good place to run one (wave bootcamp2 Q1).
 *
 * k = 1, 2, … job emulators (lib/qualify-emulator.mjs), each the harsher of
 * the fleet's p75 job and this node's own p75 job
 * of THIS node's own measured mix. Every step is sampled (lib/qualify-sampler)
 * and judged against the operator's bars (QUALIFY_BARS, 2026-11-11):
 *
 *   - CPU pressure: p90 of `cpu some avg10` over the step under 20%. avg10,
 *     not avg300: a 300 s average smears one step into the next, and the p90
 *     of 10 s averages is the harsher reading of the two, which is the point.
 *   - package temperature under 90 °C, from the die sensor doctor itself picks
 *     (`cpuSensor`). A node that DECLARES it has none (claw-5's FX-8350,
 *     `thermal.noDieTemperature`) is judged without it, and the step says so.
 *   - no new core throttle events. The counter is cumulative since boot
 *     (claw-1 read 513,754 on 2026-11-11), so the bar is the DELTA in the step.
 *   - every unit's wall within 1.5x of the same unit alone (k = 1).
 *   - no OOM kill (`/proc/vmstat oom_kill` delta) and no unit failing.
 *
 * The ceiling is the last k that held. k stops at the node's physical cores,
 * at what its memory can hold above `minFreeMb`, and at MAX_K; reaching that
 * cap is said, because "never crossed a bar" is not "has no limit".
 *
 * A node that fails at k = 1 does not hold even one such job:
 * that is `fail`, and Q6 decides what it means for placement.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../../dist/lib/fleet-paths.js';
import { cpuSensor } from './doctor-parse.mjs';
import { runOn } from './fleet-exec.mjs';
import { metricsReadScript, metricsSince, parseMetrics, READ_END } from './job-metrics-read.mjs';
import { QUALIFY_BARS, QUALIFY_TTL_DAYS } from './qualify-registry.mjs';
import {
	HASH_RATE_SCRIPT,
	PROFILE_DAYS,
	UNIT_TARGET_SEC,
	emulatorScript,
	jobProfile,
	parseEmulator,
	unitShape,
} from './qualify-emulator.mjs';

/** The highest k ever tried. Above every node's maxConcurrent today (claw-9's 4), with room to find more. */
export const MAX_K = 6;
/**
 * The stdout the job-metrics read may bring back. Async runOn keeps Node's
 * 1 MiB default, and claw-9's two files held ~5 MB on 2026-11-11: the read came
 * back cut at exactly 1,048,576 bytes with no end sentinel. 64 MiB is the sync
 * transport's own ceiling (fleet-exec.mjs SYNC_MAX_BUFFER), a ceiling and not
 * an allocation.
 */
export const METRICS_MAX_BUFFER = 64 * 2 ** 20;
/** Seconds between steps, so one step's tail is not the next step's start. */
const SETTLE_SEC = 30;

const q90 = (xs) => {
	const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
	return a.length ? a[Math.min(a.length - 1, Math.floor(0.9 * (a.length - 1) + 0.5))] : null;
};

/**
 * PURE. One step's verdict.
 *
 * @param {object} a
 * @param {number} a.k
 * @param {object[]} a.samples sampler rows inside the step
 * @param {ReturnType<typeof parseEmulator>} a.run
 * @param {number|null} a.baselineSec the k=1 unit wall; null when judging k=1 itself
 * @param {boolean} a.noDieTemperature the node declares it has no die sensor
 * @returns {{ k: number, verdict: 'held'|'crossed'|'could-not-look', reasons: string[], metrics: object }}
 */
export function judgeStep({ k, samples, run, baselineSec, noDieTemperature }) {
	const reasons = [];
	const unknown = [];
	if (!run.complete || run.units.length !== k)
		unknown.push(`the step's output was cut short (${run.units.length}/${k} units reported)`);
	if (!samples.length) unknown.push('the sampler recorded nothing during the step');

	const cpuP90 = q90(samples.map((s) => s.cpuSome10));
	if (samples.length && cpuP90 === null)
		unknown.push('no CPU pressure reading (no /proc/pressure/cpu?)');
	else if (cpuP90 !== null && cpuP90 >= QUALIFY_BARS.cpuPressureP90Pct)
		reasons.push(`CPU pressure p90 ${cpuP90}% ≥ ${QUALIFY_BARS.cpuPressureP90Pct}%`);

	let tempMax = null;
	let dieKey = null;
	if (!noDieTemperature && samples.length) {
		dieKey = cpuSensor(Object.keys(samples.find((s) => Object.keys(s.temps).length)?.temps ?? {}));
		if (!dieKey)
			unknown.push(
				'no CPU die sensor among the readings, and the node does not declare it has none'
			);
		else {
			const t = samples.map((s) => s.temps[dieKey]).filter(Number.isFinite);
			tempMax = t.length ? Math.max(...t) : null;
			if (tempMax === null) unknown.push(`the die sensor ${dieKey} never read`);
			else if (tempMax >= QUALIFY_BARS.packageTempC)
				reasons.push(`package reached ${tempMax} °C ≥ ${QUALIFY_BARS.packageTempC} °C`);
		}
	}

	const thr = samples.map((s) => s.throttle).filter(Number.isFinite);
	const throttleDelta = thr.length >= 2 ? thr[thr.length - 1] - thr[0] : null;
	if (throttleDelta !== null && throttleDelta > QUALIFY_BARS.newThrottleEvents)
		reasons.push(`${throttleDelta} new core throttle event(s)`);

	if (run.oomKills === null) unknown.push('the OOM-kill counter could not be read');
	else if (run.oomKills > QUALIFY_BARS.watchdogOrOomEvents)
		reasons.push(`${run.oomKills} OOM kill(s) during the step`);

	const walls = run.units.map((u) => u.wallSec);
	const worstSec = walls.length ? Math.max(...walls) : null;
	for (const u of run.units) {
		if (u.timedOut)
			reasons.push(
				`a unit was still running at the step's deadline (> ${QUALIFY_BARS.durationRatio}x alone)`
			);
		else if (u.exit !== 0) reasons.push(`a unit exited ${u.exit}`);
	}
	const ratio = baselineSec && worstSec ? Math.round((worstSec / baselineSec) * 100) / 100 : null;
	if (ratio !== null && ratio > QUALIFY_BARS.durationRatio)
		reasons.push(`slowest unit took ${ratio}x its time alone (> ${QUALIFY_BARS.durationRatio}x)`);

	const metrics = {
		k,
		cpuP90,
		tempMax,
		dieKey,
		noDieTemperature,
		throttleDelta,
		oomKills: run.oomKills,
		worstSec,
		ratio,
		samples: samples.length,
	};
	// A crossed bar is a verdict even when something else was unreadable: the
	// node DID cross it. Only a step with no crossing and an unknown is unknown.
	if (reasons.length) return { k, verdict: 'crossed', reasons: [...reasons, ...unknown], metrics };
	if (unknown.length) return { k, verdict: 'could-not-look', reasons: unknown, metrics };
	return { k, verdict: 'held', reasons: [], metrics };
}

const jsonl = (text) =>
	String(text)
		.split('\n')
		.filter((l) => l.trim().startsWith('{'))
		.flatMap((l) => {
			try {
				return [JSON.parse(l)];
			} catch {
				return [];
			}
		});

/** The controller's job-history, read where the dispatcher writes it. */
function readControllerHistory() {
	return jsonl(readFileSync(join(stateDir(), 'job-history.jsonl'), 'utf8'));
}

/**
 * The test, with its two outside reads injectable for tests.
 *
 * @param {{ readHistory?: () => object[], sleep?: (ms: number) => Promise<void> }} [o]
 */
/**
 * Every node's job-metrics but `node`'s, read as the CI user (whose file it
 * is) through the same reader and sentinel. `{ byNode, unreadable }`: a node
 * that cannot be read is named with its reason, never read as no jobs.
 */
async function readFleetMetricsLive(manifest, node, nowMs) {
	const script = metricsReadScript(metricsSince(nowMs, PROFILE_DAYS));
	const names = Object.keys(manifest?.machines ?? {}).filter((n) => n !== node);
	const byNode = {};
	const unreadable = {};
	await Promise.all(
		names.map(async (n) => {
			const r = await runOn(n, script, {
				as: 'ci',
				timeoutMs: 120_000,
				maxBuffer: METRICS_MAX_BUFFER,
			});
			if (String(r.stdout ?? '').includes(READ_END))
				byNode[n] = parseMetrics(String(r.stdout).split(READ_END)[0]).rows;
			else unreadable[n] = (r.stderr || 'no end sentinel').trim().slice(-160);
		})
	);
	return { byNode, unreadable };
}

export function makeConcurrencyTest({
	readHistory = readControllerHistory,
	readFleetMetrics = readFleetMetricsLive,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
	return {
		id: 'concurrency-ramp',
		track: 'qualify',
		needsDrain: true,
		runsAs: 'ci',
		ttlDays: QUALIFY_TTL_DAYS,
		minutes: 75,
		async run(ctx) {
			const noDie = ctx.machine?.thermal?.noDieTemperature === true;
			const minFreeMb = Number(ctx.machine?.minFreeMb) || 0;

			const facts = await ctx.exec(
				[
					'echo "PHYS $(lscpu -p=Core,Socket 2>/dev/null | grep -v \'^#\' | sort -u | wc -l)"',
					'echo "MEM $(awk \'/^MemTotal:/{print int($2/1024)}\' /proc/meminfo)"',
					HASH_RATE_SCRIPT,
				].join('\n'),
				{ timeoutMs: 120_000 }
			);
			if (!facts.ok && !facts.stdout)
				return {
					status: 'could-not-look',
					reason: `could not read the node: ${(facts.stderr || '').trim().slice(-200)}`,
					metrics: {},
				};
			const out = String(facts.stdout);
			const phys = Number(out.match(/^PHYS (\d+)$/m)?.[1]);
			const memMb = Number(out.match(/^MEM (\d+)$/m)?.[1]);
			const hashRate = Number(out.match(/^HASHRATE ([\d.]+)$/m)?.[1]);
			if (!(phys > 0) || !(memMb > 0) || !(hashRate > 0))
				return {
					status: 'could-not-look',
					reason: `node facts unreadable (physical cores=${phys}, MemTotal=${memMb} MiB, hash rate=${hashRate} MiB/s)`,
					metrics: {},
				};
			// The node's own job-metrics, through the fleet's one reader: it reads the
			// rotated file too, and a read without its end sentinel is a truncated read.
			const read = await ctx.exec(metricsReadScript(metricsSince(ctx.nowMs, PROFILE_DAYS)), {
				timeoutMs: 120_000,
				maxBuffer: METRICS_MAX_BUFFER,
			});
			if (!String(read.stdout ?? '').includes(READ_END))
				return {
					status: 'could-not-look',
					reason: `the node's job-metrics read did not finish: ${(read.stderr || 'no end sentinel').trim().slice(-200)}`,
					metrics: {},
				};
			const metricsByNode = {
				[ctx.node]: parseMetrics(String(read.stdout).split(READ_END)[0]).rows,
			};
			// Every OTHER node's, for the fleet half of the unit. One that cannot be
			// read is left out and named; the profile's own row minimum still applies.
			let others;
			try {
				others = await readFleetMetrics(ctx.manifest, ctx.node, ctx.nowMs);
			} catch (e) {
				return {
					status: 'could-not-look',
					reason: `the fleet's job-metrics could not be read: ${e.message}`,
					metrics: {},
				};
			}
			Object.assign(metricsByNode, others.byNode);
			for (const [n, why] of Object.entries(others.unreadable))
				ctx.log(`   ${n}: job-metrics not read (${why}); left out of the fleet profile`);

			let history;
			try {
				history = readHistory();
			} catch (e) {
				return {
					status: 'could-not-look',
					reason: `the controller's job-history is unreadable: ${e.message}`,
					metrics: {},
				};
			}
			const profile = jobProfile(metricsByNode, history, ctx.node, ctx.nowMs);
			if (!profile.ok) return { status: 'could-not-look', reason: profile.reason, metrics: {} };

			const shape = unitShape(profile, hashRate);
			const byMem = Math.floor((memMb - minFreeMb) / Math.max(1, profile.peakMb));
			const kMax = Math.max(1, Math.min(phys, byMem, MAX_K));
			const capWhy =
				kMax === MAX_K
					? `MAX_K ${MAX_K}`
					: kMax === phys
						? `${phys} physical cores`
						: `memory (${memMb} MiB − ${minFreeMb} floor, ${profile.peakMb} MiB a unit)`;
			ctx.log(
				`   unit: ${profile.cores.toFixed(2)} cores, ${profile.peakMb} MiB, ${profile.writeMb} MiB written ` +
					`(fleet p75 of ${profile.fleetRows} jobs: ${profile.fleet.cores.toFixed(2)} cores; ` +
					`${profile.own ? `this node's p75 of ${profile.nodeRows}: ${profile.own.cores.toFixed(2)} cores` : `this node has ${profile.nodeRows} jobs, too few to count`}); ` +
					`${shape.workers}×${shape.chunks} chunks; k ≤ ${kMax} (${capWhy})`
			);

			const steps = [];
			let baselineSec = null;
			for (let k = 1; k <= kMax; k++) {
				const timeoutSec = baselineSec
					? Math.ceil(baselineSec * QUALIFY_BARS.durationRatio) + 30
					: UNIT_TARGET_SEC * 3;
				const sampler = await ctx.sample({
					everySec: 5,
					maxMinutes: Math.ceil(timeoutSec / 60) + 5,
				});
				const res = await ctx.exec(emulatorScript({ k, shape, timeoutSec }), {
					timeoutMs: (timeoutSec + 120) * 1000,
				});
				const rows = await sampler.stop();
				const run = parseEmulator(res.stdout ?? '');
				const inStep = rows.filter(
					(r) => (run.t0 === null || r.at >= run.t0) && (run.t1 === null || r.at <= run.t1)
				);
				const step = judgeStep({ k, samples: inStep, run, baselineSec, noDieTemperature: noDie });
				steps.push(step);
				ctx.log(
					`   k=${k}: ${step.verdict}${step.reasons.length ? ` — ${step.reasons.join('; ')}` : ''}`
				);
				if (step.verdict !== 'held') break;
				if (k === 1) baselineSec = step.metrics.worstSec;
				if (k < kMax) await sleep(SETTLE_SEC * 1000);
			}

			const held = steps.filter((s) => s.verdict === 'held').map((s) => s.k);
			const ceiling = held.length ? Math.max(...held) : 0;
			const last = steps.at(-1);
			const metrics = {
				ceiling,
				kMax,
				capWhy,
				profile,
				shape,
				hashRate,
				steps: steps.map((s) => ({ ...s.metrics, verdict: s.verdict, reasons: s.reasons })),
			};
			if (last.verdict === 'could-not-look')
				return {
					status: 'could-not-look',
					reason: `k=${last.k} could not be judged: ${last.reasons.join('; ')}${ceiling ? ` (held through k=${ceiling})` : ''}`,
					metrics,
				};
			if (!ceiling)
				return {
					status: 'fail',
					reason: `does not hold even one p75 job: ${last.reasons.join('; ')}`,
					metrics,
				};
			const why =
				last.verdict === 'crossed'
					? `k=${last.k} crossed: ${last.reasons.join('; ')}`
					: `reached the cap k=${kMax} (${capWhy}) without crossing a bar`;
			return {
				status: 'pass',
				reason: `holds ${ceiling} p75 job(s) side by side; ${why}`,
				metrics,
			};
		},
	};
}

export const test = makeConcurrencyTest();
