#!/usr/bin/env node
/**
 * fleet simulate — replay the whole job history through the REAL dispatch
 * code in virtual time, with no claw behind it, and score a traffic policy on
 * the three objectives (operator, 2026-11-11): the oldest job in the queue,
 * real work over orchestration, and free capacity.
 *
 * Every number is printed beside the same number measured from what really
 * happened over the same window. A policy's result means nothing until the
 * baseline policy lands near history: that is the model's validation.
 *
 * USAGE
 *   fleet simulate [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--policy baseline|legacy-hold|reservation|tuned] [--set key=value] [--tune key=value] [--without node,…] [--clone node=new] [--drop key=v,…]
 *                  [--tick 15] [--contention 0.3] [--min-queued 0] [--json]
 *
 * READS (never writes): <state>/job-history.jsonl, <state>/dispatch-decisions/*.jsonl,
 * the manifest dir's fleet-runner-manifest.json and fleet-runner-coverage.json.
 * An empty corpus FAILS (exit 1): no history is not a fleet with no queue.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { manifest, stateDir } from '../dist/lib/fleet-paths.js';
import { buildSpeedModel } from '../dist/runners/speed-tier.js';
import { buildHeavyModel } from '../dist/runners/heavy-model.js';
import { buildCorpus } from '../dist/runners/sim-corpus.js';
import { buildFleet } from '../dist/runners/sim-fleet.js';
import { simulate } from '../dist/runners/sim-engine.js';
import { POLICIES } from '../dist/runners/sim-registry.js';
import { applyWhatIfs } from '../dist/runners/sim-whatif.js';
import { historicalOutcomes, measure } from '../dist/runners/sim-metrics.js';
import { createEmitter } from './lib/emit.mjs';
import { loadManifest } from './lib/fleet-exec.mjs';

const argv = process.argv.slice(2);
const out = createEmitter({ json: argv.includes('--json') });
if (argv.includes('--help') || argv.includes('-h')) {
	out.log(
		'fleet simulate [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--policy baseline|legacy-hold|reservation|tuned] [--set key=value] [--without node,…] [--clone node=new] [--drop key=v,…] [--tick 15]\n' +
			'               [--contention 0.3] [--min-queued 0] [--json]\n' +
			'  replays job history through the real dispatcher, no claws touched; prints each\n' +
			'  objective simulated beside history over the same window'
	);
	process.exit(0);
}
const arg = (name) => {
	const i = argv.indexOf(name);
	return i > -1 ? argv[i + 1] : undefined;
};
const num = (name, dflt) => {
	const v = arg(name);
	if (v === undefined) return dflt;
	const n = Number(v);
	if (!Number.isFinite(n) || n < 0) {
		out.warn(`fleet simulate: ${name} takes a number of 0 or more, got ${v}`);
		process.exit(2);
	}
	return n;
};
const day = (name) => {
	const v = arg(name);
	if (v === undefined) return undefined;
	const ms = Date.parse(`${v}T00:00:00Z`);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(ms)) {
		out.warn(`fleet simulate: ${name} takes YYYY-MM-DD, got ${v}`);
		process.exit(2);
	}
	return ms;
};
const policyName = arg('--policy') ?? 'baseline';
if (!POLICIES[policyName]) {
	out.warn(
		`fleet simulate: unknown --policy ${policyName} (have: ${Object.keys(POLICIES).join(', ')})`
	);
	process.exit(2);
}
// --set key=value (repeatable): a policy's parameters, numbers only.
const params = {};
argv.forEach((a, i) => {
	if (a !== '--set') return;
	const [k, v] = String(argv[i + 1] ?? '').split('=');
	if (!k || v === undefined || !Number.isFinite(Number(v))) {
		out.warn(`fleet simulate: --set takes key=number, got ${argv[i + 1]}`);
		process.exit(2);
	}
	params[k] = Number(v);
});
// --tune key=value (repeatable): placement constants overridden on every
// node, for this simulated run only (NodeState.tuning).
const TUNE_KEYS = ['heavyFree', 'doubleHoldSec', 'holdSec', 'spillFloorSec'];
const tuning = {};
argv.forEach((a, i) => {
	if (a !== '--tune') return;
	const [k, v] = String(argv[i + 1] ?? '').split('=');
	if (!TUNE_KEYS.includes(k) || v === undefined || !Number.isFinite(Number(v)) || Number(v) < 0) {
		out.warn(
			`fleet simulate: --tune takes one of ${TUNE_KEYS.join(', ')}=number, got ${argv[i + 1]}`
		);
		process.exit(2);
	}
	tuning[k] = Number(v);
});
const opts = {
	...(Object.keys(tuning).length ? { tuning } : {}),
	tickSec: num('--tick', 15),
	contention: num('--contention', 0.3),
	minQueuedSec: num('--min-queued', 0),
	fromMs: day('--from'),
	toMs: (() => {
		const t = day('--to');
		return t === undefined ? undefined : t + 86_400_000;
	})(),
};

/** JSON lines from a file; unparseable lines are counted, never dropped silently. */
function readJsonl(path) {
	const rows = [];
	let bad = 0;
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			bad++;
		}
	}
	return { rows, bad };
}

const state = stateDir();
const historyPath = join(state, 'job-history.jsonl');
if (!existsSync(historyPath)) {
	out.warn(`fleet simulate: no job history at ${historyPath}`);
	if (out.json) out.emit({ ok: false, reason: `no job history at ${historyPath}` });
	process.exit(1);
}
const history = readJsonl(historyPath);

const decisionsDir = join(state, 'dispatch-decisions');
const capacity = [];
const events = new Map();
let decisionBad = 0;
for (const f of existsSync(decisionsDir) ? readdirSync(decisionsDir).sort() : []) {
	if (!f.endsWith('.jsonl')) continue;
	const { rows, bad } = readJsonl(join(decisionsDir, f));
	decisionBad += bad;
	for (const r of rows) {
		if (typeof r.jobId === 'number' && r.event) events.set(r.jobId, r.event);
		if (Array.isArray(r.capacity) && r.capacity.length) {
			capacity.push({ atMs: Date.parse(r.at), rows: r.capacity });
		}
	}
}

let machines;
try {
	machines = loadManifest().machines ?? {};
} catch (err) {
	// Unreadable is "could not look", never a fleet of zero nodes.
	out.warn(`fleet simulate: the fleet manifest is unreadable (${err.message})`);
	if (out.json) out.emit({ ok: false, reason: `manifest unreadable: ${err.message}` });
	process.exit(1);
}
const reserves = new Map();
try {
	const cov = JSON.parse(readFileSync(manifest('fleet-runner-coverage.json'), 'utf8'));
	for (const [repo, f] of Object.entries(cov.facets ?? {})) {
		const r = f?.jobP95Mb;
		if (typeof r?.mb === 'number' && r.mb > 0)
			reserves.set(repo, { mb: r.mb, lowerBound: r.lowerBound === true });
	}
} catch (err) {
	out.warn(
		`fleet simulate: per-repo reserves unreadable (${err.message}); every job reserves its node's figure`
	);
}

const corpus = buildCorpus(history.rows, Object.keys(machines), events);
if (!corpus.jobs.length) {
	out.warn('fleet simulate: the job history holds no fleet job to replay');
	if (out.json) out.emit({ ok: false, reason: 'empty corpus' });
	process.exit(1);
}
const fleet = buildFleet({ jobs: corpus.jobs, capacity, machines });
const lastMs = Math.max(
	...history.rows.map((r) => Date.parse(r.startedAt)).filter(Number.isFinite)
);
const models = {
	speed: buildSpeedModel(history.rows, {
		nowMs: lastMs + 3_600_000,
		nodes: fleet.map((s) => s.name),
	}),
	heavy: buildHeavyModel(history.rows),
	reserves,
};

// WHAT-IFS: a different fleet or workload for the SIMULATED run only.
const listArg = (name) =>
	argv.flatMap((a, i) => (a === name ? [String(argv[i + 1] ?? '')] : [])).filter(Boolean);
let simCorpus;
let simFleet;
let whatIf;
try {
	({
		corpus: simCorpus,
		fleet: simFleet,
		notes: whatIf,
	} = applyWhatIfs(corpus, fleet, {
		without: listArg('--without'),
		clone: listArg('--clone'),
		drop: listArg('--drop'),
	}));
} catch (err) {
	out.warn(`fleet simulate: ${err.message}`);
	process.exit(2);
}

const started = Date.now();
const result = simulate(simCorpus, simFleet, models, POLICIES[policyName](params), opts);
const elapsedSec = (Date.now() - started) / 1000;

const jobs = new Map(corpus.jobs.map((j) => [j.key, j]));
const window = {
	tickSec: opts.tickSec,
	fromMs: opts.fromMs ?? corpus.firstArrivalMs,
	toMs: Math.min(opts.toMs ?? Infinity, corpus.lastArrivalMs),
};
const hist = measure(historicalOutcomes(corpus, opts.fromMs, opts.toMs), jobs, fleet, window);
const sim = measure(result.outcomes, jobs, simFleet, window);

const NOT_MODELLED = [
	'runner steals; warm slots are REPLAYED from the dispatch log, not decided',
	'the real backstop controller: the backstop promotes when a builder job waits 100 s and calms after 10 min',
	'node outages beyond the capacity rows the dispatch log recorded',
	"a job's memory beyond its repo's reserve",
];

if (out.json) {
	out.emit({
		ok: true,
		policy: result.policy,
		params,
		tuning,
		whatIf,
		corpus: {
			jobs: corpus.jobs.length,
			hosted: corpus.hosted,
			unattributed: corpus.unattributed,
			noQueueSec: corpus.noQueueSec,
			noPhases: corpus.noPhases,
			duplicates: corpus.duplicates,
			withDependency: corpus.jobs.filter((j) => j.dependsOn).length,
			badHistoryLines: history.bad,
			badDecisionLines: decisionBad,
		},
		fleet: fleet.map((s) => ({
			name: s.name,
			backstop: s.backstop,
			labels: s.labels,
			points: s.timeline.length,
		})),
		history: hist,
		simulated: {
			metrics: sim,
			starvedJobs: result.starvedJobs,
			starvedJobSec: result.starvedJobSec,
			backstopPromotions: result.backstopPromotions,
			unserved: result.unserved,
			warmServed: result.warmServed,
			ticks: result.ticks,
			policyStats: result.policyStats,
		},
		notModelled: NOT_MODELLED,
		elapsedSec,
	});
	process.exit(0);
}

const f = (v, w = 9) =>
	String(v === null || v === undefined ? '-' : Number.isInteger(v) ? v : v.toFixed(2)).padStart(w);
const row = (label, h, s) => out.log(`${label.padEnd(34)}${f(h)}${f(s)}`);
const span = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
out.log(
	`fleet simulate — policy ${result.policy}, ${corpus.jobs.length} jobs ` +
		`(${corpus.hosted} hosted, ${corpus.jobs.filter((j) => j.dependsOn).length} with an inferred dependency), ` +
		`${span(window.fromMs)} -> ${span(window.toMs)}Z, ${result.ticks} ticks in ${elapsedSec.toFixed(1)} s`
);
if (whatIf.length) out.log(`what-if (simulated column only): ${whatIf.join('; ')}`);
if (Object.keys(tuning).length) out.log(`tuned constants: ${JSON.stringify(tuning)}`);
out.log('');
out.log(`${''.padEnd(34)}${'history'.padStart(9)}${'simulated'.padStart(9)}`);
out.log('1. OLDEST JOB IN QUEUE (s)');
row('   peak', hist.oldest.peakSec, sim.oldest.peakSec);
row('   p95 of ticks', hist.oldest.p95Sec, sim.oldest.p95Sec);
row('   mean', hist.oldest.meanSec, sim.oldest.meanSec);
out.log('2. REAL WORK / SLOT TIME');
row('   ratio', hist.efficiency.ratio, sim.efficiency.ratio);
row('   pickup h', hist.efficiency.pickupSec / 3600, sim.efficiency.pickupSec / 3600);
row('   setup h', hist.efficiency.setupSec / 3600, sim.efficiency.setupSec / 3600);
row('   run h', hist.efficiency.runSec / 3600, sim.efficiency.runSec / 3600);
row('   cleanup h', hist.efficiency.cleanupSec / 3600, sim.efficiency.cleanupSec / 3600);
out.log('3. CAPACITY (claw slots)');
row('   mean slots', hist.capacity.meanSlots, sim.capacity.meanSlots);
row('   mean busy', hist.capacity.meanBusy, sim.capacity.meanBusy);
row('   mean free', hist.capacity.meanFree, sim.capacity.meanFree);
row('   utilization', hist.capacity.utilization, sim.capacity.utilization);
out.log('QUEUE TIME (s)');
row('   p50', hist.queueSec.p50, sim.queueSec.p50);
row('   p95', hist.queueSec.p95, sim.queueSec.p95);
row('   p99', hist.queueSec.p99, sim.queueSec.p99);
out.log('');
out.log(
	`${'class'.padEnd(34)}${'jobs'.padStart(7)}  ${'q95 h/s'.padStart(13)}  ${'oldest pk h/s'.padStart(15)}  ${'free h/s'.padStart(11)}  ${'%free h/s'.padStart(11)}`
);
for (const [c, h] of Object.entries(hist.classes)) {
	const s = sim.classes[c];
	if (h.jobs < 20) continue;
	const pair = (a, b, w) => `${f(a, 0)}/${f(b, 0)}`.padStart(w);
	out.log(
		`${c.slice(0, 33).padEnd(34)}${String(h.jobs).padStart(7)}  ${pair(h.queueSec.p95, s?.queueSec.p95, 13)}  ` +
			`${pair(Math.round(h.oldest.peakSec), Math.round(s?.oldest.peakSec ?? 0), 15)}  ` +
			`${pair(h.freeSlots?.mean, s?.freeSlots?.mean, 11)}  ` +
			`${pair(h.freeSlots ? Math.round(h.freeSlots.shareOfTicksWithFree * 100) : null, s?.freeSlots ? Math.round(s.freeSlots.shareOfTicksWithFree * 100) : null, 11)}`
	);
}
out.log('');
out.log(
	`${'day'.padEnd(12)}${'jobs'.padStart(6)}${'q50 h/s'.padStart(12)}${'q95 h/s'.padStart(14)}${'oldest pk h/s'.padStart(16)}`
);
for (const d of hist.days) {
	const s = sim.days.find((x) => x.day === d.day);
	out.log(
		`${d.day.padEnd(12)}${String(d.jobs).padStart(6)}${`${d.queueP50 ?? '-'}/${s?.queueP50 ?? '-'}`.padStart(12)}` +
			`${`${d.queueP95 ?? '-'}/${s?.queueP95 ?? '-'}`.padStart(14)}` +
			`${`${Math.round(d.oldestPeakSec)}/${Math.round(s?.oldestPeakSec ?? 0)}`.padStart(16)}`
	);
}
out.log('');
out.log(
	`starved (waited > 300 s beside a node today's admission accepts): ${result.starvedJobs} jobs, ` +
		`${Math.round(result.starvedJobSec)} job-s; unserved at end: ${result.unserved}; warm-served: ${result.warmServed}; backstop promotions: ${result.backstopPromotions}`
);
out.log(`not modelled: ${NOT_MODELLED.join('; ')}`);
if (history.bad || decisionBad)
	out.warn(`unparseable lines skipped: history ${history.bad}, decisions ${decisionBad}`);
