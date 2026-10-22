#!/usr/bin/env node
/**
 * collect-job-metrics — what each job actually cost in memory, joined to what it
 * was and where it ran.
 *
 * `job-metrics.sh` runs as the job-completed hook and writes one line per job on
 * the node, straight from the kernel's `memory.peak`. This reads those files and
 * joins them to `job-history.jsonl`. It answers two questions that have been open
 * in docs/planning/tier-assignment-2026-09-03.md and could not be answered from
 * anything the fleet already stored:
 *
 *   OOM ATTRIBUTION (§5.5). `memory.events` gives a cumulative `oom_kill` with no
 *   timestamp and no job. A job killed for memory currently reads as `Tests`
 *   failing — indistinguishable from a broken test, which is how a fleet-manager
 *   fault gets misread as node incapability and demotes a healthy claw.
 *
 *   THE claw-1 INVERSION (§5.1a). claw-1 is second-slowest on synthetic CPU, on
 *   the fleet's worst disk at 98 C, and the fastest claw on real jobs. Orphan
 *   load, sampling bias and contention were each tested and eliminated. The live
 *   hypothesis is memory — 11 GB against claw-2's 7 GB, on a workload of many
 *   small files. Per-unit peak RSS against per-node ceilings is the test.
 *
 * It also produces the row the DEMAND ledger (§5.2) has never had: how much
 * memory a given `repo/job` actually needs. Today "which claws may take this
 * job" is answerable only for capabilities; a unit whose p95 exceeds a node's
 * slice ceiling cannot run there and nothing anywhere knows it.
 *
 * IT ALSO PRINTS WHAT WAS ALREADY BEING HARVESTED. The hook has written
 * `cpuUsageUsec`, `cpuUserUsec`, `cpuSystemUsec`, `ioReadBytes` and
 * `ioWriteBytes` per job for weeks, and this command summarised peak memory
 * only — which is why "nothing records CPU or I/O" was still being written into
 * planning docs in 2026-09. The gap was summarisation. Each of those facets now
 * has a p50/p95 and, beside it, the number of rows that actually carried the
 * field: `io.stat` is missing on some cgroup layouts, so a CPU p95 over 500 rows
 * and an I/O p95 over 4 must not print as if they were the same kind of number.
 *
 * A NODE THAT CANNOT BE READ IS A FAILURE, not an empty result — the same rule
 * every gate here follows. A fleet where every node is unreachable would
 * otherwise report a tidy summary of nothing.
 *
 * A GUEST IS NOT SWEPT, AND IS NOT UNREACHABLE. `role: guest` nodes are skipped
 * by default and the skip is PRINTED; `--machine <guest>` or `--include-guests`
 * asks for one on purpose. `selectMetricTargets` holds the rule and its header
 * holds the reason — including why "it happens to be local when I run it" is
 * not a defence. A deliberate skip that goes unreported is the other half of the
 * same mistake as an unreachable node that does.
 *
 * `unreachable` IS DEFERRABLE; `read-error` IS NOT (#71/#74). `deferralFor`
 * narrows the `unreachable` class only — ssh itself failing is exactly "the
 * node is not there", which is the case a human can take out on purpose with
 * `fleet drain`. A `read-error` means the node answered and the bytes did not
 * come back whole, which is never what a maintenance drain explains, so it
 * still fails the run unconditionally. A deferred node's metrics are still
 * UNREAD, and that is still printed via `deferralNote` — the deferral removes
 * the page, never the evidence. See lib/expected-down.mjs.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { loadManifest, runOnSync, selectMachines, machineArg } from './lib/fleet-exec.mjs';
import { createEmitter } from './lib/emit.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
// The window is job-history's, BUILT, for the same reason `floor-probe.mjs`
// reads it from there: a row older than job-history keeps has nothing left to
// join to, and a second spelling of 14 here would be free to drift from it.
import { RETENTION_DAYS } from '../dist/job-history.js';
import {
	joinMetrics,
	byNode,
	byUnit,
	withUnits,
	perJobCosts,
	selectMetricTargets,
	metricsSince,
	metricsReadScript,
	readOutcome,
	perNodeWithReads,
} from './lib/job-metrics.mjs';

const out = createEmitter();

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	console.log(
		`fleet job-metrics — what each job COST, joined to job history\n\n` +
			`  --json            machine-readable\n` +
			`  --machine <n>     one node only — reaches a GUEST when named exactly\n` +
			`  --include-guests  sweep guests too (default: skipped, and reported)\n` +
			`  --min-runs <n>    units with at least n runs (default 2)\n\n` +
			`A node with role: guest is NOT swept by default — nothing here reaches\n` +
			`across to one as a matter of course. It is skipped by ROLE, never by\n` +
			`name, and the skip is printed rather than silent. Ask for one and you\n` +
			`get one: this command is an inventory of what each node measured, not a\n` +
			`fleet comparison, so a guest's own numbers are a fair question.\n\n` +
			`Reads ~/.hadoku/job-metrics.jsonl (and its one rotated .1) from every\n` +
			`node, ONLY the rows inside job-history's ${RETENTION_DAYS}-day window — written by the\n` +
			`ACTIONS_RUNNER_HOOK_JOB_COMPLETED hook from the kernel's memory.peak,\n` +
			`cpu.stat, io.stat and memory.stat — and joins it to\n` +
			`~/.hadoku-mgmt/job-history.jsonl for wall-clock.\n\n` +
			`Every facet prints its SAMPLE COUNT beside its percentiles: io.stat is\n` +
			`absent on some cgroup layouts and the tmpfs counters only exist on rows\n` +
			`written by a newer hook, so a p95 over 4 of 500 rows must not read as the\n` +
			`node's p95. A null percentile beside n=0 is "nobody measured it".\n\n` +
			`If every node reports 0 rows, the hook is not installed: run\n` +
			`  fleet throttle --confirm --machine <node>\n`
	);
	process.exit(0);
}

function flag(name, fallback = null) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : fallback;
}
const minRuns = Number(flag('--min-runs', '2')) || 2;

/** "p50/p95", or "-" when the facet had no samples at all. Never a fabricated 0. */
function fmtPair(p50, p95) {
	if (p50 == null && p95 == null) return '-';
	return `${p50 ?? '-'}/${p95 ?? '-'}`;
}

const manifest = loadManifest();
// `selectMachines` with no filter is still the one door onto the node model; the
// ROLE question is answered once, in `selectMetricTargets`, so this file cannot
// grow a second opinion about what a guest is.
const only = machineArg(process.argv.slice(2), { valueFlags: ['--min-runs'] });
const { targets: machines, skipped: skippedGuests } = selectMetricTargets(
	selectMachines(manifest),
	{ only, includeGuests: process.argv.includes('--include-guests') }
);

/** job-history lives beside mgmt-api's state, on the host this runs from. */
const HISTORY = join(homedir(), '.hadoku-mgmt', 'job-history.jsonl');
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

// ONLY THE WINDOW CROSSES THE WIRE. The node-side awk drops rows older than
// job-history's retention before they are sent — see `metricsReadScript` for
// why a `ts` filter and not a byte budget. Until #37 this was a bare `cat` of
// the whole file — every row it had ever held, whether or not the join could
// still place it — and on claw-1 at 1.1 MB it overflowed the transport's
// buffer outright.
const since = metricsSince(Date.now(), RETENTION_DAYS);
const readScript = metricsReadScript(since);

const metrics = [];
const reads = [];
let skippedLines = 0;
let olderRows = 0;

for (const [node] of machines) {
	const read = readOutcome(node, runOnSync(node, readScript, { timeoutMs: 60_000 }));
	reads.push(read);
	if (read.read !== 'ok') continue;
	skippedLines += read.skipped;
	olderRows += read.older ?? 0;
	// The hook records the node's own hostname; trust the loop instead, so a row
	// cannot be attributed to a box it did not come from.
	for (const r of read.rows) metrics.push({ ...r, node });
}
// TWO FAILURE CLASSES, both failing the run — see `readOutcome`. A node that
// answered and whose bytes did not come back whole is not a node that is down,
// and saying which is what makes the finding actionable.
const allUnreachable = reads
	.filter((r) => r.read === 'unreachable')
	.map((r) => ({ node: r.node, why: r.why }));
const readErrors = reads
	.filter((r) => r.read !== 'ok' && r.read !== 'unreachable')
	.map((r) => ({ node: r.node, errno: r.errno, why: r.why }));
const probed = reads.filter((r) => r.read === 'ok').length;

// A node a human powered off is EXPECTED down. Its metrics are still unread,
// and that is still PRINTED via `deferralNote` — the deferral suppresses the
// failure, never the evidence, and expires after DEFER_DAYS. Narrowed to the
// `unreachable` class only: a `read-error` is the node answering with broken
// bytes, which a maintenance drain never explains. See lib/expected-down.mjs.
const drains = readDrains();
const expectedDown = allUnreachable
	.filter((u) => deferralFor(u.node, drains).deferred)
	.map((u) => u.node);
const unreachable = allUnreachable.filter((u) => !deferralFor(u.node, drains).deferred);

// A LONG-LIVED CGROUP'S COUNTERS ARE NOT A JOB'S COST until they are
// differenced, and its `memory.peak` cannot be made into one at all. See
// `perJobCosts` for the fleet-wide measurement behind that. Normalise BEFORE the
// join so every downstream summary is looking at per-job numbers.
const { rows: costed, notes: costNotes } = perJobCosts(metrics);
const { joined, unjoined } = joinMetrics(costed, history);
// PER NODE uses EVERY row — `[...joined, ...unjoined]` is `metrics` re-partitioned,
// not a subset — because node, peak, limit, oom_kill, CPU and I/O are all
// self-contained and waiting for the history join would throw away good
// measurements for no gain. It is the JOINED copy rather than the raw one only so
// that the rows history HAS placed carry their `durationSec` into the duration
// facet; `durationSamples` says how many did, and the other facets are unaffected.
const allRows = [...joined, ...unjoined];
const nodes = byNode(allRows);
// EVERY node asked, in one list — a failed read included, with its class. A
// consumer reading `perNode` alone must not see a smaller fleet.
const perNode = perNodeWithReads(nodes, reads);
// PER UNIT prefers the history join and falls back to the row's own repo/job,
// because job-history ingests on a tick and a job that just finished is not in
// it yet — the first live run had all 6 rows unjoined for exactly that reason.
const units = byUnit(withUnits(joined, unjoined), { minRuns });

out.log(`Probed ${probed}/${machines.length} nodes.`);
out.log(
	`Window: rows since ${since} (job-history's ${RETENTION_DAYS} days); ` +
		`${olderRows} older rows left on the nodes, not fetched.`
);
out.log(
	`Metric rows: ${metrics.length}  joined: ${joined.length}  unjoined: ${unjoined.length}` +
		(skippedLines ? `  unparseable: ${skippedLines}` : '')
);

// A DELIBERATE skip is reported, not silent. "I did not need to look" is not
// "nothing is wrong" either: a node that lost its role, or one newly marked a
// guest, has to appear here rather than quietly leave the set.
for (const s of skippedGuests) out.log(`SKIPPED  ${s.node}: ${s.why}`);

if (unreachable.length) {
	out.warn(`UNREACHABLE (${unreachable.length}) — "I could not look" is not "nothing is wrong":`);
	for (const u of unreachable) out.warn(`  ${u.node}: ${u.why}`);
}
for (const n of expectedDown)
	out.log(`  · ${deferralNote(n, deferralFor(n, drains))} — metrics unread`);
if (readErrors.length) {
	out.warn(
		`READ-ERROR (${readErrors.length}) — the node answered; the bytes did not come back whole:`
	);
	for (const e of readErrors) out.warn(`  ${e.node}: ${e.errno ?? 'no errno'} — ${e.why}`);
}

if (costNotes.cumulativeRows) {
	out.log(
		`Cost basis: ${costNotes.jitRows} rows from per-job JIT units, ${costNotes.cumulativeRows} from ` +
			`long-lived (standing/warm) units. On those, the CPU/IO clocks are differenced against the ` +
			`previous job on the same cgroup — 5 readings per row, 3 CPU and 2 I/O: ` +
			`${costNotes.clocksDifferenced} recovered, ${costNotes.clocksUnavailable} absent, without a ` +
			`predecessor, or after a restart — and ` +
			`${costNotes.peaksVoided} memory.peak readings are EXCLUDED from every percentile: ` +
			`they are the unit's high-water mark since it started, not the job's peak. The raw reading ` +
			`is kept as peakBytesCumulative. See perJobCosts() in scripts/lib/job-metrics.mjs.`
	);
	if (costNotes.unitRestarts) {
		out.log(`  ${costNotes.unitRestarts} rows follow a unit restart (a clock went backwards).`);
	}
}

if (!metrics.length) {
	out.warn(
		'No metric rows on any node. The job-completed hook is not installed yet — ' +
			'run `fleet throttle --confirm --machine <node>`, then wait for jobs to run.'
	);
	out.log(
		'  (per node: ' +
			reads.map((r) => `${r.node}=${r.read === 'ok' ? r.rows.length : r.read}`).join(' ') +
			')'
	);
} else {
	out.log('');
	out.log('PER NODE — peak RSS per job against the slice ceiling');
	out.log(
		'  node      jobs  n(mem)   p50MB   p95MB   maxMB   limitMB  p95/limit  oom_kill'.replace(
			/\s+$/,
			''
		)
	);
	for (const n of nodes) {
		out.log(
			`  ${n.node.padEnd(9)} ${String(n.jobs).padStart(4)}  ${String(n.memSamples).padStart(6)}  ` +
				`${String(n.p50Mb ?? '-').padStart(6)}  ` +
				`${String(n.p95Mb ?? '-').padStart(6)}  ${String(n.maxMb ?? '-').padStart(6)}  ` +
				`${String(n.limitMb ?? '-').padStart(7)}  ${String(n.headroomPct == null ? '-' : n.headroomPct + '%').padStart(9)}  ${String(n.oomKills).padStart(8)}`
		);
	}
	out.log(
		"  n(mem) < jobs means rows whose peak is a long-lived unit's high-water mark, not the job's."
	);
	// A column whose every row would read "-" teaches nothing and crowds out one
	// that does, so the tmpfs columns appear only once the hook that writes them
	// has run somewhere. `--json` carries the counts either way (0 samples and a
	// null percentile), so a consumer never has to infer a field's existence from
	// whether a table happened to draw it.
	const shmemSeen = nodes.some((n) => n.shmemPeakSamples > 0 || n.shmemSamples > 0);

	out.log('');
	out.log('PER NODE — what a job SPENT: CPU, disk I/O, wall-clock (p50/p95; n = rows carrying it)');
	out.log(
		'  node       cpuSec p50/p95    n   ioRdMB p95    n   ioWrMB p95    n   durSec p50/p95    n' +
			(shmemSeen ? '   shmemMB p95    n' : '')
	);
	for (const n of nodes) {
		out.log(
			`  ${n.node.padEnd(9)} ${fmtPair(n.cpuP50Sec, n.cpuP95Sec).padStart(14)} ${String(n.cpuSamples).padStart(4)}   ` +
				`${String(n.ioReadP95Mb ?? '-').padStart(10)} ${String(n.ioReadSamples).padStart(4)}   ` +
				`${String(n.ioWriteP95Mb ?? '-').padStart(10)} ${String(n.ioWriteSamples).padStart(4)}   ` +
				`${fmtPair(n.durationP50Sec, n.durationP95Sec).padStart(14)} ${String(n.durationSamples).padStart(4)}` +
				(shmemSeen
					? `   ${String(n.shmemPeakP95Mb ?? '-').padStart(11)} ${String(n.shmemPeakSamples).padStart(4)}`
					: '')
		);
	}

	out.log('');
	out.log(`PER UNIT — what a repo/job actually costs (>=${minRuns} runs)`);
	out.log(
		'   memMB p95   memMB max   cpuSec p95   ioWrMB p95   durSec p95  runs nodes  unit'.replace(
			/\s+$/,
			''
		)
	);
	for (const u of units.slice(0, 25)) {
		out.log(
			`  ${String(u.p95Mb).padStart(10)}  ${String(u.maxMb).padStart(10)}  ` +
				`${String(u.cpuP95Sec ?? '-').padStart(11)}  ${String(u.ioWriteP95Mb ?? '-').padStart(11)}  ` +
				`${String(u.durationP95Sec ?? '-').padStart(11)}  ${String(u.runs).padStart(4)} ${String(u.nodes).padStart(5)}  ${u.unit}`
		);
	}
	if (units.length > 25) out.log(`  ... ${units.length - 25} more`);
}

if (unjoined.length) {
	out.log('');
	out.log(
		`${unjoined.length} rows are not in job-history yet — it ingests on mgmt-api's ` +
			`tick, so a job that just finished lands here first. They still count toward ` +
			`PER NODE, and toward PER UNIT under their own repo/job key. Never dropped.`
	);
}

if (out.json) {
	out.emit({
		nodes: machines.length,
		probed,
		window: { since, days: RETENTION_DAYS, olderRowsNotFetched: olderRows },
		metricRows: metrics.length,
		joined: joined.length,
		unjoined: unjoined.length,
		unparseable: skippedLines,
		costBasis: costNotes,
		skippedGuests,
		perNode,
		perUnit: units,
		unreachable,
		expectedDown,
		readErrors,
		lines: out.held(),
	});
}

// Unreachable fails, and so does a read error — the node being up does not
// make "I could not read it" into "nothing is wrong". An empty result does NOT
// fail: before the hook has run anywhere there is legitimately nothing to
// report, and a gate that goes red on "not deployed yet" trains people to
// ignore it. A node deferred by `deferralFor` above never reaches `unreachable`
// at all, so it cannot hold the exit code back from a real finding either.
process.exit(unreachable.length || readErrors.length ? 1 : 0);
