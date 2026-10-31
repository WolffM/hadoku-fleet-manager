#!/usr/bin/env node
/**
 * join-workload-benchmark — P2.4: `$benchmark` (state dir) x job-metrics
 * (per node) x job-history, joined into the three answers neither half can
 * give alone. See `warm-listener-cache-2026-09-05.md` "Next: connect
 * benchmarking to the job inventory" and `tier-assignment-2026-09-03.md` §5.1a.
 *
 * READ-ONLY. It ssh's every node for `~/.hadoku/job-metrics.jsonl` (same probe
 * `collect-job-metrics.mjs` already makes — this reuses its join, not a second
 * copy of it) and reads `job-history.jsonl` and each node's stored `$benchmark`
 * locally — `<stateDir>/benchmark.json` since Wave 3h, merged with the
 * manifest's older copy through `src/lib/measured.ts`. Nothing is written to
 * the fleet.
 *
 * A NODE WITH NO BENCHMARK RECORD IS NAMED, NOT DROPPED. Q3 reads installed RAM
 * off the record; a node without one would simply vanish from the heavy-rule
 * table, which renders "could not look" as "not eligible". So such a node is
 * listed with the reason, Q3's `selected` is withheld as incomplete, and the
 * run exits 1.
 *
 * THREE QUESTIONS, AND WHY EACH NEEDS THE JOIN
 * ---------------------------------------------
 *   1. Is peak memory per-node or per-repo? `jobP95Mb` today is ONE fleet-wide
 *      number because nobody checked. Answered by grouping the SAME unit
 *      (repo/job) across the different nodes it ran on: if peak memory is a
 *      property of the workload, a unit's per-node medians should agree with
 *      each other far more than different units agree with EACH OTHER.
 *   2. Does claw-5's DDR3-800 cost wall-clock, or is it invisible behind I/O?
 *      Answered by comparing claw-5's median durationSec against the rest of
 *      the fleet's, per unit — but claw-5's CPU benchmarked far weaker too
 *      (see the CAVEAT below), so this join can show THAT claw-5 is slower and
 *      cannot by itself say memory bandwidth specifically is why.
 *   3. Which nodes does the 16 GB heavy rule select if re-derived from CURRENT
 *      `$benchmark.memory.totalKb`, not from memory or a stale manifest note.
 *
 * AND THE TABLE THE DECISION ACTUALLY NEEDS: NODE x REPO
 * ------------------------------------------------------
 * Q1 compares UNITS (repo/job) across nodes, which is the right grain for "does
 * this job need more memory here than there" and the wrong grain for the field
 * it would change. `jobP95Mb` is written per NODE on `ManifestNode` — one
 * fleet-wide scalar today — and applied to whatever that node is handed, so the
 * cell the decision is made in is `(node, repo)`. Every `(node, repo)` with at
 * least `--min-runs` rows gets p95 peak memory, p95 duration and p95 cpu-seconds
 * beside that node's `$benchmark` proxies, and two answers are computed from
 * those same cells rather than read off the table by eye:
 *
 *   (a) hold the repo and vary the NODE, then hold the node and vary the REPO.
 *       The larger median spread is the axis a single scalar loses the most to.
 *   (b) each node's p95 duration against the fleet-median node on the SAME repo,
 *       printed next to that node's sha512 / memory / disk figures — is the
 *       hardware visible in wall-clock at all, and does it track any one proxy.
 *
 * Answer (b) inherits the CAVEAT below in full: it is the wall-clock fact, never
 * its attribution.
 *
 * CAVEAT ON QUESTION 2 — READ BEFORE QUOTING THE NUMBERS
 * --------------------------------------------------------
 * This is an OBSERVATIONAL join, not a controlled experiment. claw-5 differs
 * from the rest of the fleet on MULTIPLE benchmarked axes at once — CPU
 * (sha512 single-core 184 MB/s against 604-708 elsewhere, no AVX2), disk
 * (7200rpm, 106 MB/s read), AND memory (DDR3-800 against 1600-6000 MT/s
 * elsewhere) — so a wall-clock gap on claw-5 is consistent with "memory is
 * slow" and equally consistent with "the CPU is slow", and this join cannot
 * tell them apart. Isolating memory bandwidth specifically needs the SAME unit
 * forced onto claw-5 and a fast-CPU/slow-memory or slow-CPU/fast-memory
 * comparator, which is P3.2's forced-placement harness (not yet built). What
 * this CAN say on its own: whether claw-5 is slower at all on memory-heavy
 * work, and by how much — the wall-clock fact, not its attribution.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { loadManifest, runOnSync, selectMachines } from './lib/fleet-exec.mjs';
import { stateDir } from './lib/paths.mjs';
import { createEmitter } from './lib/emit.mjs';
// job-history's window, BUILT — the same import `collect-job-metrics` makes, so
// the two commands read the same rows from every node.
import { RETENTION_DAYS } from '../dist/job-history-store.js';
import {
	metricsSince,
	metricsReadScript,
	readOutcome,
	joinMetrics,
	percentile,
	mb,
	byNodeRepo,
	varianceAxis,
	durationRatios,
	perJobCosts,
} from './lib/job-metrics.mjs';
import { isGuestNode } from '../dist/lib/node-role.js';
import { measuredFacets } from '../dist/lib/measured.js';

const out = createEmitter();

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	console.log(
		// THE SUBCOMMAND, NOT THE SCRIPT. `src/cli.ts` spells this `benchmark-join`;
		// the file is `join-workload-benchmark.mjs` and the usage line carried the
		// filename, so the one command `--help` exists to teach was one nobody could
		// type. The script name is an implementation detail of the package layout.
		`fleet benchmark-join — P2.4: benchmark x job-metrics x job-history\n\n` +
			`  --json                    machine-readable\n` +
			`  --min-nodes <n>           a unit must have this many QUALIFYING nodes to be\n` +
			`                            compared across nodes (default 2)\n` +
			`  --min-runs-per-node <n>   a node needs this many runs of a unit before its\n` +
			`                            median counts toward Q1 (default 3) -- 1-2 runs is\n` +
			`                            a single sample wearing a node's name, not a trend\n` +
			`  --min-runs <n>            a (node, repo) cell needs this many rows before it\n` +
			`                            enters the node x repo table (default 5)\n` +
			`  --min-groups <n>          a repo needs this many nodes (and a node this many\n` +
			`                            repos) before it can answer the variance question\n` +
			`                            (default 3)\n` +
			`  --write <path>            also save the JSON report to <path>\n\n` +
			`Read-only. See the file header for what each of the three questions means\n` +
			`and the CAVEAT on question 2 before quoting a number out of this report.\n`
	);
	process.exit(0);
}

function flag(name, fallback = null) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : fallback;
}
const MIN_NODES = Number(flag('--min-nodes', '2')) || 2;
// A node with 1-2 runs on a unit can only report a single sample as its
// "median" — noise, not a node effect. A single off-trend run (e.g. a
// dispatch-redeploy that actually had something to redeploy, against fourteen
// that no-opped) then reads as "this node uses 10x the memory", which is a
// workload fact wearing a node's name. Requiring several runs per node before
// it counts toward Q1 is what tells the two apart.
const MIN_RUNS_PER_NODE = Number(flag('--min-runs-per-node', '3')) || 3;
// The (node, repo) cell floor. Higher than MIN_RUNS_PER_NODE on purpose: a cell
// aggregates every job in a repo, so five rows is a low bar for it and three
// would be a low bar only for a single unit.
const MIN_RUNS = Number(flag('--min-runs', '5')) || 5;
const MIN_GROUPS = Number(flag('--min-groups', '3')) || 3;
const WRITE = flag('--write');

/**
 * `owner/name` -> `name`, for the table only — the report keeps the full name.
 *
 * Deliberately not `^WolffM/`. This package is published and read by another
 * repo, and a hardcoded owner is the same class of literal `ecosystem-literals`
 * exists to keep out: one garage's account name baked into a library. Stripping
 * whatever owner is actually there is also simply more correct.
 */
function shortRepo(repo) {
	return String(repo).replace(/^[^/]+\//, '');
}

const manifest = loadManifest();
const machines = selectMachines(manifest);

// THE GUEST IS NOT PROBED AND IS NOT A COMPARATOR.
//
// hokon is `role: guest` (2026-09-14): nothing here ssh's it, and this command
// would have, on any box that is not hokon itself — `runOnSync` only takes the
// local branch when the node IS this box, so running the same command from a
// claw would have reached across. Skipping by ROLE rather than by name is what
// makes that true wherever it runs.
//
// It is also the right answer for the arithmetic, not just the etiquette. Every
// question below compares nodes that jobs can be PLACED on; hokon is another
// hardware class (64 GB, 1,223 MB/s sha512 against the claws' 184-708) and
// folding it into a "fleet median" moves the yardstick toward a box the
// dispatcher will not choose. Its `$benchmark` still appears in Q3, which reads
// the local manifest and touches no node.
const guests = machines.filter(([, m]) => isGuestNode(m)).map(([name]) => name);
const probeTargets = machines.filter(([, m]) => !isGuestNode(m));

// ── gather: $benchmark per node ─────────────────────────────────────────────

// ONE READ, the state dir merged with the manifest's older copy. A node whose
// record is unavailable is kept, WITH its reason, in `benchmarkUnavailable`.
const stored = measuredFacets('benchmark', manifest.machines ?? {});
const benchmark = {};
const benchmarkUnavailable = [];
for (const [node] of machines) {
	const r = stored.nodes[node];
	if (r.unavailable) {
		benchmarkUnavailable.push({ node, reason: r.unavailable, why: r.why });
		continue;
	}
	const b = r.value;
	benchmark[node] = {
		at: b.at ?? null,
		from: r.from,
		cpuModel: b.cpu?.model ?? null,
		sha512SingleMBps: b.cpu?.sha512SingleMBps ?? null,
		avx2: b.cpu?.avx2 ?? null,
		memType: b.memory?.type ?? null,
		memSpeedMTs: b.memory?.speedMTs ?? null,
		memTotalKb: b.memory?.totalKb ?? null,
		diskReadMBps: b.rootDisk?.readMBps ?? null,
		diskRotational: b.rootDisk?.rotational ?? null,
	};
}

// ── gather: job-history (local — this runs on the mgmt-api host) ───────────

// The same state dir `benchmark.json` is read from — one resolver
// (`stateDir()`), not a second spelling of `~/.hadoku-mgmt`.
const HISTORY = join(stateDir(), 'job-history.jsonl');
const history = [];
if (existsSync(HISTORY)) {
	for (const line of readFileSync(HISTORY, 'utf8').split('\n')) {
		const t = line.trim();
		if (!t) continue;
		try {
			history.push(JSON.parse(t));
		} catch {
			/* a truncated final line costs one record, by design of the writer */
		}
	}
}

// ── gather: job-metrics per node, over ssh — same probe collect-job-metrics
// makes, so the two commands never disagree about what a node reported. ─────

// Only rows inside job-history's window are fetched: a row older than that has
// no duration to join, so it could never become a usable row here anyway. And
// a failed read is classed — `unreachable` (ssh could not connect) versus
// `readErrors` (the node answered; the bytes did not come back whole), see
// `readOutcome`. Until #37 both were `unreachable`, and claw-1 was one.
const readScript = metricsReadScript(metricsSince(Date.now(), RETENTION_DAYS));
const metrics = [];
const unreachable = [];
const readErrors = [];
for (const [node] of probeTargets) {
	const read = readOutcome(node, runOnSync(node, readScript, { as: 'ci', timeoutMs: 60_000 }));
	if (read.read === 'unreachable') {
		unreachable.push({ node, why: read.why });
		continue;
	}
	if (read.read !== 'ok') {
		readErrors.push({ node, errno: read.errno, why: read.why });
		continue;
	}
	for (const r of read.rows) metrics.push({ ...r, node });
}

// A long-lived unit's counters are not a job's cost. Differencing the clocks and
// VOIDING the high-water peak happens before anything is grouped — see
// `perJobCosts`. This is why the numbers here no longer match the 2026-09-07
// snapshot: that pass counted a warm listener's cumulative `memory.peak` as a
// job's peak, and on `warm-claw-7-hadoku_site.service` that reading is its 4 GiB
// ceiling on every one of 217 rows.
const { rows: costed, notes: costNotes } = perJobCosts(metrics);
const { joined } = joinMetrics(costed, history);
// Only jobs job-history actually has duration for — a durationSec-less row
// cannot answer either wall-clock question and would silently zero a median.
const usable = joined.filter(
	(r) => typeof r.durationSec === 'number' && typeof r.peakBytes === 'number'
);

// ── Q1: is peak memory per-node or per-unit? ────────────────────────────────
//
// Group by unit, then by node within it. A unit that ran on fewer than
// MIN_NODES distinct nodes cannot answer a per-node-vs-per-unit question at
// all and is excluded rather than padding the comparison with a single point.

function groupBy(rows, keyFn) {
	const m = new Map();
	for (const r of rows) {
		const k = keyFn(r);
		if (!m.has(k)) m.set(k, []);
		m.get(k).push(r);
	}
	return m;
}

const byUnitAll = groupBy(usable, (r) => r.unit);
const memoryRows = [];
for (const [unit, rows] of byUnitAll) {
	const byNode = groupBy(rows, (r) => r.node);
	// Every node's OWN run-to-run spread first — this is what tells "the
	// workload varies" apart from "the node varies". Reported alongside the
	// cross-node spread so a reader can see both, not just the headline number.
	const perNodeAll = [...byNode.entries()].map(([node, rs]) => {
		const peaks = rs.map((r) => r.peakBytes);
		const minMb = mb(Math.min(...peaks));
		const maxMb = mb(Math.max(...peaks));
		return {
			node,
			runs: rs.length,
			medianMb: mb(percentile(peaks, 0.5)),
			p95Mb: mb(percentile(peaks, 0.95)),
			minMb,
			maxMb,
			// This node's OWN run-to-run spread on this same unit — the number
			// that tells "the workload varies run to run" apart from "the node
			// varies". Compared below against the spread BETWEEN nodes.
			ownSpreadPct: minMb > 0 ? Math.round(((maxMb - minMb) / minMb) * 100) : null,
		};
	});
	const perNode = perNodeAll
		.filter((n) => n.runs >= MIN_RUNS_PER_NODE)
		.sort((a, b) => a.node.localeCompare(b.node));
	if (perNode.length < MIN_NODES) continue;
	const medians = perNode.map((n) => n.medianMb).filter((v) => typeof v === 'number');
	if (medians.length < MIN_NODES) continue;
	const lo = Math.min(...medians);
	const hi = Math.max(...medians);
	const ownSpreads = perNode.map((n) => n.ownSpreadPct).filter((v) => typeof v === 'number');
	memoryRows.push({
		unit,
		nodes: perNode.length,
		totalRuns: rows.length,
		perNode,
		spreadMb: hi - lo,
		spreadPct: lo > 0 ? Math.round(((hi - lo) / lo) * 100) : null,
		avgOwnSpreadPct: ownSpreads.length
			? Math.round(ownSpreads.reduce((s, v) => s + v, 0) / ownSpreads.length)
			: null,
	});
}
memoryRows.sort((a, b) => (b.spreadPct ?? 0) - (a.spreadPct ?? 0));

const withinUnitSpreads = memoryRows.map((r) => r.spreadPct).filter((v) => typeof v === 'number');
const medianWithinUnitSpreadPct = withinUnitSpreads.length
	? percentile(
			withinUnitSpreads.sort((a, b) => a - b),
			0.5
		)
	: null;
const ownSpreadsAll = memoryRows.map((r) => r.avgOwnSpreadPct).filter((v) => typeof v === 'number');
const medianOwnSpreadPct = ownSpreadsAll.length
	? percentile(
			ownSpreadsAll.sort((a, b) => a - b),
			0.5
		)
	: null;

// For contrast: how much units differ from EACH OTHER (across all units, not
// within one) — the between-unit spread the within-unit number is judged against.
const allUnitMedians = [...byUnitAll.entries()]
	.map(([, rows]) =>
		mb(
			percentile(
				rows.map((r) => r.peakBytes),
				0.5
			)
		)
	)
	.filter((v) => typeof v === 'number')
	.sort((a, b) => a - b);
const betweenUnitP10 = allUnitMedians.length
	? allUnitMedians[Math.floor(0.1 * allUnitMedians.length)]
	: null;
const betweenUnitP90 = allUnitMedians.length
	? allUnitMedians[Math.min(allUnitMedians.length - 1, Math.floor(0.9 * allUnitMedians.length))]
	: null;

// ── Q2: does claw-5's DDR3-800 show in wall-clock? ──────────────────────────

const CLAW5 = 'claw-5';
const wallClockRows = [];
for (const [unit, rows] of byUnitAll) {
	const claw5Rows = rows.filter((r) => r.node === CLAW5);
	const restRows = rows.filter((r) => r.node !== CLAW5);
	if (!claw5Rows.length || restRows.length < 2) continue;
	const claw5Median = percentile(
		claw5Rows.map((r) => r.durationSec),
		0.5
	);
	const restMedian = percentile(
		restRows.map((r) => r.durationSec),
		0.5
	);
	const unitPeakMb = mb(
		percentile(
			rows.map((r) => r.peakBytes),
			0.5
		)
	);
	if (claw5Median == null || restMedian == null || restMedian <= 0) continue;
	wallClockRows.push({
		unit,
		claw5Runs: claw5Rows.length,
		restRuns: restRows.length,
		restNodes: new Set(restRows.map((r) => r.node)).size,
		claw5MedianSec: claw5Median,
		restMedianSec: restMedian,
		ratio: Math.round((claw5Median / restMedian) * 100) / 100,
		unitPeakMb,
	});
}
wallClockRows.sort((a, b) => b.ratio - a.ratio);

// Correlate the ratio against memory pressure: is claw-5 relatively SLOWER on
// the memory-heavy units than on the light ones? Split at the fleet-wide
// median peak MB among the compared units.
const peaks = wallClockRows
	.map((r) => r.unitPeakMb)
	.filter((v) => typeof v === 'number')
	.sort((a, b) => a - b);
const peakMedian = peaks.length ? peaks[Math.floor(peaks.length / 2)] : null;
const heavy = peakMedian != null ? wallClockRows.filter((r) => r.unitPeakMb >= peakMedian) : [];
const light = peakMedian != null ? wallClockRows.filter((r) => r.unitPeakMb < peakMedian) : [];
const avgRatio = (rows) =>
	rows.length
		? Math.round((rows.reduce((s, r) => s + r.ratio, 0) / rows.length) * 100) / 100
		: null;

// ── Q3: which nodes does the 16 GB rule select, re-derived from $benchmark ──
//
// INSTALLED capacity, not kernel MemTotal — a 16 GB stick reports ~15.5-15.6GB
// to the kernel (warm-listener-cache-2026-09-05.md "The 16 GB threshold is
// sound"). Round MemTotal to the nearest common DIMM total (8/12/16/32/64 GB)
// rather than trusting the manifest's separate, hand-derived `ramGb`, which is
// exactly the kind of second copy that can drift from what was actually
// measured.
const DIMM_STEPS_GB = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128];
function installedGb(totalKb) {
	if (typeof totalKb !== 'number') return null;
	const gb = totalKb / 1024 / 1024;
	return DIMM_STEPS_GB.reduce((best, step) =>
		Math.abs(step - gb) < Math.abs(best - gb) ? step : best
	);
}
const heavyRule = Object.entries(benchmark)
	.map(([node, b]) => ({
		node,
		memTotalKb: b.memTotalKb,
		installedGb: installedGb(b.memTotalKb),
	}))
	.sort((a, b) => (b.installedGb ?? 0) - (a.installedGb ?? 0));
// WITHHELD, not guessed, when any node's record is missing: a node the rule
// cannot see is not a node the rule excluded, and "Selected: a, b" over a
// partial roster reads as the whole answer.
const selected16Gb = benchmarkUnavailable.length
	? null
	: heavyRule.filter((r) => (r.installedGb ?? 0) >= 16).map((r) => r.node);

// ── the node x repo table, and the two answers computed from it ────────────
//
// Q1 above compares UNITS (repo/job) across nodes. `jobP95Mb`, the thing that
// would actually have to change, is written per NODE and applied to whatever
// that node is handed — so the grain the decision needs is (node, repo), and
// this is it. The two answers are derived from the same cells so they cannot
// disagree with the table printed above them.
const cells = byNodeRepo(usable, { minRuns: MIN_RUNS });
const axis = varianceAxis(cells, { minGroups: MIN_GROUPS });
const ratios = durationRatios(cells, { proxies: benchmark });

// ── report ───────────────────────────────────────────────────────────────

out.log(
	`Probed ${probeTargets.length - unreachable.length - readErrors.length}/${probeTargets.length} placement nodes for job-metrics.`
);
if (guests.length) {
	out.log(
		`  Guest${guests.length > 1 ? 's' : ''} NOT probed and NOT used as a comparator: ${guests.join(', ')} ` +
			`(role: guest — see the note in this file). Still listed under Q3, which reads the stored record only.`
	);
}
out.log(
	`Cost basis: ${costNotes.jitRows} per-job (JIT) rows, ${costNotes.cumulativeRows} from long-lived ` +
		`units — their CPU/IO clock readings differenced (5 per row: 3 CPU, 2 I/O; ` +
		`${costNotes.clocksDifferenced} recovered, ${costNotes.clocksUnavailable} absent, without a ` +
		`predecessor, or after a restart), their ${costNotes.peaksVoided} ` +
		`memory.peak readings EXCLUDED as unit high-water marks. See perJobCosts().`
);
out.log(`Usable rows (has both peak memory and job-history duration): ${usable.length}`);
if (unreachable.length) {
	out.warn(`UNREACHABLE (${unreachable.length}) — excluded, not counted as zero:`);
	for (const u of unreachable) out.warn(`  ${u.node}: ${u.why}`);
}
if (readErrors.length) {
	out.warn(
		`READ-ERROR (${readErrors.length}) — the node answered, the read did not finish; excluded:`
	);
	for (const e of readErrors) out.warn(`  ${e.node}: ${e.errno ?? 'no errno'} — ${e.why}`);
}

out.log('');
out.log(`Q1 — peak memory: per-node or per-unit? (units on >=${MIN_NODES} nodes)`);
out.log(
	`  ${memoryRows.length} comparable units. Median CROSS-NODE spread (between nodes' medians): ` +
		`${medianWithinUnitSpreadPct == null ? 'n/a' : medianWithinUnitSpreadPct + '%'}. ` +
		`Median OWN-NODE spread (one node's run-to-run range, same unit): ` +
		`${medianOwnSpreadPct == null ? 'n/a' : medianOwnSpreadPct + '%'}. ` +
		`Between-UNIT spread (p10-p90 across ALL units' medians): ${betweenUnitP10}-${betweenUnitP90} MB.`
);
for (const r of memoryRows.slice(0, 10)) {
	out.log(
		`    cross-node=${String(r.spreadPct ?? '-').padStart(5)}%  own-node=${String(r.avgOwnSpreadPct ?? '-').padStart(5)}%  ${r.unit}`
	);
	out.log(
		`        [${r.perNode.map((n) => `${n.node}=${n.medianMb}MB(range ${n.minMb}-${n.maxMb},n=${n.runs})`).join(' ')}]`
	);
}
if (memoryRows.length > 10) out.log(`    ... ${memoryRows.length - 10} more`);

out.log('');
out.log(`Q2 — claw-5 wall-clock vs the rest of the fleet, per unit (CAVEAT: see file header)`);
out.log(
	`  ${wallClockRows.length} comparable units. Mean ratio, memory-heavy half: ` +
		`${avgRatio(heavy) ?? 'n/a'}  |  light half: ${avgRatio(light) ?? 'n/a'}  (1.00 = same speed)`
);
for (const r of wallClockRows.slice(0, 10)) {
	out.log(
		`    ratio=${r.ratio.toFixed(2)}  claw-5=${r.claw5MedianSec}s (n=${r.claw5Runs})  ` +
			`rest=${r.restMedianSec}s (n=${r.restRuns} across ${r.restNodes} nodes)  ` +
			`peak=${r.unitPeakMb}MB  ${r.unit}`
	);
}
if (wallClockRows.length > 10) out.log(`    ... ${wallClockRows.length - 10} more`);

out.log('');
out.log('Q3 — the 16 GB heavy rule, re-derived from $benchmark.memory.totalKb');
for (const r of heavyRule) {
	out.log(
		`    ${r.node.padEnd(8)} totalKb=${r.memTotalKb ?? '-'}  installed~${r.installedGb ?? '-'}GB  ` +
			`${(r.installedGb ?? 0) >= 16 ? 'ELIGIBLE' : 'excluded'}`
	);
}
for (const u of benchmarkUnavailable) {
	out.log(`    ${u.node.padEnd(8)} NO RECORD (${u.reason}) — ${u.why}`);
}
out.log(
	selected16Gb
		? `  Selected: ${selected16Gb.join(', ') || '(none)'}`
		: `  Selected: WITHHELD — ${benchmarkUnavailable.length} node(s) have no benchmark record, ` +
				'so the rule cannot be applied to the whole fleet. Measure them: fleet benchmark <node> --write'
);

out.log('');
out.log(`NODE x REPO — every cell with >=${MIN_RUNS} rows (${cells.length} cells)`);
out.log(
	'  node      repo                              runs  memMB p95  durSec p95  cpuSec p95   n(cpu)  | node proxy: sha512 MB/s  mem MT/s  disk MB/s'
);
for (const c of cells) {
	const b = benchmark[c.node] ?? {};
	out.log(
		`  ${c.node.padEnd(9)} ${shortRepo(c.repo).padEnd(32)} ${String(c.runs).padStart(4)}  ` +
			`${String(c.p95Mb ?? '-').padStart(9)}  ${String(c.durationP95Sec ?? '-').padStart(10)}  ` +
			`${String(c.cpuP95Sec ?? '-').padStart(10)}  ${String(c.cpuSamples).padStart(6)}  | ` +
			`${String(b.sha512SingleMBps ?? '-').padStart(21)}  ${String(b.memSpeedMTs ?? '-').padStart(8)}  ${String(b.diskReadMBps ?? '-').padStart(9)}`
	);
}

out.log('');
out.log(
	`ANSWER (a) — which axis explains p95 peak memory? (groups of >=${MIN_GROUPS}) -> ${axis.verdict.toUpperCase()}`
);
out.log(
	`  hold the repo, vary the NODE: median spread ${axis.medianAcrossNodesPct == null ? 'n/a (no repo on >=' + MIN_GROUPS + ' nodes)' : axis.medianAcrossNodesPct + '%'} ` +
		`over ${axis.acrossNodes.length} repos`
);
out.log(
	`  hold the node, vary the REPO: median spread ${axis.medianAcrossReposPct == null ? 'n/a (no node with >=' + MIN_GROUPS + ' repos)' : axis.medianAcrossReposPct + '%'} ` +
		`over ${axis.acrossRepos.length} nodes`
);
for (const r of axis.acrossNodes.slice(0, 8)) {
	out.log(
		`    across nodes  ${String(r.spreadPct).padStart(6)}%  ${String(r.loMb).padStart(6)}-${String(r.hiMb).padEnd(6)} MB  n=${r.nodes} nodes  ${r.repo}`
	);
}
for (const r of axis.acrossRepos.slice(0, 8)) {
	out.log(
		`    across repos  ${String(r.spreadPct).padStart(6)}%  ${String(r.loMb).padStart(6)}-${String(r.hiMb).padEnd(6)} MB  n=${r.repos} repos  ${r.node}`
	);
}

out.log('');
out.log(
	'ANSWER (b) — p95 duration against the fleet-median node on the SAME repo (CAVEAT: see file header)'
);
out.log('  node      repos  medianRatio  sha512 MB/s  mem MT/s  disk MB/s');
for (const r of ratios) {
	const b = r.proxy ?? {};
	out.log(
		`  ${r.node.padEnd(9)} ${String(r.repos).padStart(5)}  ${String(r.medianRatio ?? '-').padStart(11)}  ` +
			`${String(b.sha512SingleMBps ?? '-').padStart(11)}  ${String(b.memSpeedMTs ?? '-').padStart(8)}  ${String(b.diskReadMBps ?? '-').padStart(9)}`
	);
}

const report = {
	generatedAt: new Date().toISOString(),
	probed: probeTargets.length - unreachable.length - readErrors.length,
	totalNodes: probeTargets.length,
	guestsSkipped: guests,
	unreachable,
	readErrors,
	costBasis: costNotes,
	usableRows: usable.length,
	q1PeakMemory: {
		comparableUnits: memoryRows.length,
		medianCrossNodeSpreadPct: medianWithinUnitSpreadPct,
		medianOwnNodeSpreadPct: medianOwnSpreadPct,
		betweenUnitP10Mb: betweenUnitP10,
		betweenUnitP90Mb: betweenUnitP90,
		units: memoryRows,
	},
	q2Claw5WallClock: {
		comparableUnits: wallClockRows.length,
		meanRatioHeavyHalf: avgRatio(heavy),
		meanRatioLightHalf: avgRatio(light),
		units: wallClockRows,
	},
	q3HeavyRule: {
		selected: selected16Gb,
		nodes: heavyRule,
		unavailable: benchmarkUnavailable,
	},
	nodeRepo: {
		minRuns: MIN_RUNS,
		cells: cells.length,
		rows: cells,
	},
	answerVarianceAxis: axis,
	answerDurationVsProxy: ratios,
	benchmark,
};

if (out.json) out.emit(report);
if (WRITE) {
	writeFileSync(WRITE, `${JSON.stringify(report, null, 2)}\n`);
	if (!out.json) out.log(`\nWrote ${WRITE}`);
}

// Read-only analysis: an unreachable node is reported, never hidden, but it
// does not fail the run — the report is still honest about what it covers. A
// node with NO BENCHMARK RECORD does: Q3's answer is withheld, and an answer
// withheld with exit 0 is "I could not look" rendered as "nothing is wrong".
process.exit(benchmarkUnavailable.length ? 1 : 0);
