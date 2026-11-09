#!/usr/bin/env node
/**
 * fleet decisions — why a job went where it went, and why every other node
 * was refused it. The reader for the dispatch decision log (T1,
 * `src/runners/decision-log.ts`), which mgmt-api's dispatcher writes.
 *
 * READ-ONLY. It reads the state dir's day files and nothing else: no GitHub,
 * no ssh, no mgmt-api. The rows join to job-history on `jobId`.
 *
 * A DECISION IS NOT WHERE THE JOB RAN. Every JIT runner a pass mints for one
 * repo carries the same labels, so GitHub hands each queued job to whichever
 * of them registers first: on 2026-11-02 (fleet-manager-private#137) the
 * dispatcher placed `unit (1/2)` on claw-8 and the job ran on a claw-1 runner
 * minted for `static`, and this reader reported claw-8. So every job a row
 * names is joined to job-history's `runner` — the census of what served it —
 * and `ranOn` says where it ran, which job its runner was minted for, and
 * whether that differs from the last node the dispatcher picked. A
 * job-history that cannot be read is said, never shown as "no mismatch".
 *
 * ZERO ROWS IS AN ANSWER, NOT A FAILURE. The log writes only when a decision
 * CHANGES, so a quiet hour can hold nothing. What fails (exit 1) is not being
 * able to look: no log directory at all, or a day file in the window that
 * could not be read. The count of rows scanned is always printed, so "nothing
 * matched" and "nothing was there" read differently.
 *
 * NOT UNDER THE `--json` CONTRACT: nothing in mgmt-api parses it. `--json` is
 * offered for people and ad hoc jq; if a cron ever consumes it, it is declared
 * in `scripts/lib/json-contract.mjs` in the same pass.
 */
import process from 'node:process';

import { stateDir } from '../dist/lib/fleet-paths.js';
import { createEmitter } from './lib/emit.mjs';
import {
	DECISION_RETENTION_DAYS,
	decisionLogDir,
	filterDecisions,
	readDecisions,
} from '../dist/runners/decision-log-storage.js';
import { nodeOf } from '../dist/runners/census.js';
import { parseJitName } from '../dist/lib/jit-naming.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const out = createEmitter({ argv: process.argv });
const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
	out.log('fleet decisions — the dispatch decision log: where each job went, and why');
	out.log('');
	out.log('  --job <id>      one job (job-history jobId)');
	out.log('  --run <id>      every job of one run');
	out.log('  --node <name>   decisions a node won or refused');
	out.log('  --repo <o/r>    one repo');
	out.log(
		`  --since <dur>   window: 30m, 6h, 2d (default 1h; ${DECISION_RETENTION_DAYS}d with --job/--run)`
	);
	out.log('  --json          the rows themselves, one JSON document');
	out.log('');
	out.log('Reads <stateDir>/dispatch-decisions/*.jsonl. Rows are written only when a');
	out.log("job's decision changes (candidates, refusals, winner), so one row is one");
	out.log('decision, not one 15 s pass. After an mgmt-api restart a queued job may');
	out.log('repeat once.');
	process.exit(0);
}

/** @param {string} flag */
function value(flag) {
	const i = argv.indexOf(flag);
	if (i === -1) return undefined;
	const v = argv[i + 1];
	if (v === undefined || v.startsWith('--')) fail('bad-args', `${flag} needs a value`);
	return v;
}

/** @param {string} why @param {string} message @param {Record<string, unknown>} [extra] */
function fail(why, message, extra = {}) {
	out.warn(message);
	if (out.json) out.emit({ ok: false, why, message, ...extra });
	process.exit(1);
}

/** @param {string} flag */
function intValue(flag) {
	const v = value(flag);
	if (v === undefined) return undefined;
	if (!/^\d+$/.test(v)) fail('bad-args', `${flag} must be a numeric id, got ${JSON.stringify(v)}`);
	return Number(v);
}

const known = new Set(['--job', '--run', '--node', '--repo', '--since', '--json']);
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (!known.has(a)) fail('bad-args', `unknown argument ${JSON.stringify(a)} (see --help)`);
	if (a !== '--json') i++;
}

const filter = {
	jobId: intValue('--job'),
	runId: intValue('--run'),
	node: value('--node'),
	repo: value('--repo'),
};
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const sinceArg = value('--since');
let windowMs;
if (sinceArg !== undefined) {
	const m = /^(\d+)([mhd])$/.exec(sinceArg);
	if (!m) fail('bad-args', `--since takes <n>m, <n>h or <n>d, got ${JSON.stringify(sinceArg)}`);
	windowMs = Number(m[1]) * UNIT_MS[m[2]];
} else {
	windowMs =
		filter.jobId !== undefined || filter.runId !== undefined
			? DECISION_RETENTION_DAYS * UNIT_MS.d
			: UNIT_MS.h;
}

const nowMs = Date.now();
const sinceMs = nowMs - windowMs;
const dir = decisionLogDir(stateDir());

let read;
try {
	read = readDecisions(dir, { sinceMs });
} catch (err) {
	fail(
		'no-log',
		`no decision log readable at ${dir}: ${err instanceof Error ? err.message : err}`,
		{
			dir,
		}
	);
}
const records = filterDecisions(read.records, filter);
const ran = ranOn(records);
const meta = {
	dir,
	since: new Date(sinceMs).toISOString(),
	filter: Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined)),
	files: read.files,
	scanned: read.records.length,
	badLines: read.badLines,
	unreadable: read.unreadable,
	count: records.length,
	history: ran.history,
};

if (out.json) {
	out.emit({ ok: read.unreadable.length === 0, ...meta, records, ranOn: ran.jobs });
} else {
	for (const r of records) printRow(r);
	printRanOn(ran);
	out.log(
		`${records.length} decision(s) of ${read.records.length} scanned in ${read.files} day file(s) since ${meta.since}` +
			(read.badLines ? `; ${read.badLines} unparseable line(s) skipped` : '')
	);
	for (const u of read.unreadable) out.warn(`could not read ${u.file}: ${u.why}`);
}
process.exit(read.unreadable.length ? 1 : 0);

/** @param {import('../dist/runners/decision-log.js').DecisionRecord} r */
function printRow(r) {
	const ids =
		r.jobId !== null
			? ` run ${r.runId ?? '?'} job ${r.jobId}${r.jobName ? ` (${r.jobName})` : ''}`
			: '';
	let head = `${r.at} ${r.path}/${r.kind} ${r.repo || '-'}${ids}`;
	// Rows about a node's warm slot rather than a placement: `node: action — reason`.
	if (['warm-listener', 'warm-yield', 'warm-yield-refused', 'warm-refill'].includes(r.kind)) {
		head += ` ${r.winner}: ${r.action}${r.reason ? ` — ${r.reason}` : ''}`;
	} else if (r.winner) {
		const over = r.rule?.rankedOver
			? `, ahead of ${r.rule.rankedOver.node} on ${r.rule.rankedOver.key}`
			: '';
		const aff = r.rule?.affinityMoved ? ', moved by warm affinity' : '';
		head += ` -> ${r.winner}`;
		if (r.rule)
			head += ` (walk position ${r.rule.position}${over}${aff}, busy ${r.rule.busyAtChoice})`;
		if (r.outcome) head += ` ${r.outcome}${r.error ? `: ${r.error}` : ''}`;
	} else if (r.reason) {
		head += ` — ${r.reason}`;
	}
	if (r.queuedSec !== null) head += ` [queued ${Math.round(r.queuedSec)}s]`;
	out.log(head);
	for (const x of r.refused) out.log(`    ${x.node}: ${x.reason}`);
}

/**
 * Where each job the rows name actually ran, from job-history.
 *
 * `decidedOn` is the LAST node a `placed` row picked for the job (a job
 * re-minted after its runner was taken has several). `swapped` is true when
 * the runner that served it was minted for a different job, or sits on a node
 * other than `decidedOn`: the decision row is then not where the job ran.
 * A job job-history does not hold yet (still running, or the recorder behind)
 * has `runner: null` — unknown, not "ran nowhere".
 *
 * @param {import('../dist/runners/decision-log.js').DecisionRecord[]} rows
 */
function ranOn(rows) {
	const jobs = new Map();
	const nodes = new Set();
	for (const r of rows) {
		for (const n of [...(r.order ?? []), ...(r.candidates ?? [])]) nodes.add(n);
		if (r.jobId === null || r.path !== 'jit') continue;
		const j = jobs.get(r.jobId) ?? { jobId: r.jobId, jobName: r.jobName, decidedOn: null };
		if (r.kind === 'placed' && r.winner) j.decidedOn = r.winner;
		jobs.set(r.jobId, j);
	}
	if (!jobs.size) return { history: { file: null, ok: true, why: null }, jobs: [] };
	const file = join(stateDir(), 'job-history.jsonl');
	if (!existsSync(file))
		return { history: { file, ok: false, why: 'no job-history file' }, jobs: [] };
	/** @type {Map<number, {runner: string, startedAt: string, conclusion?: string}>} */
	const served = new Map();
	try {
		for (const line of readFileSync(file, 'utf8').split('\n')) {
			if (!line.includes('"jobId"')) continue;
			let h;
			try {
				h = JSON.parse(line);
			} catch {
				continue; // a torn final line is one record, by design (job-history-store.ts)
			}
			if (jobs.has(h.jobId)) served.set(h.jobId, h);
		}
	} catch (err) {
		return {
			history: { file, ok: false, why: err instanceof Error ? err.message : String(err) },
			jobs: [],
		};
	}
	const known = [...nodes];
	return {
		history: { file, ok: true, why: null },
		jobs: [...jobs.values()].map((j) => {
			const h = served.get(j.jobId);
			if (!h) return { ...j, runner: null, node: null, mintedForJobId: null, swapped: null };
			const node = nodeOf(h.runner, known);
			const mintedForJobId = parseJitName(h.runner)?.jobId ?? null;
			const swapped =
				(mintedForJobId !== null && mintedForJobId !== j.jobId) ||
				(j.decidedOn !== null && node !== j.decidedOn);
			return {
				...j,
				runner: h.runner,
				node,
				mintedForJobId,
				swapped,
				conclusion: h.conclusion ?? null,
			};
		}),
	};
}

/** @param {ReturnType<typeof ranOn>} ran */
function printRanOn(ran) {
	if (!ran.history.ok) {
		out.warn(`where each job ran is unknown: ${ran.history.file}: ${ran.history.why}`);
		return;
	}
	if (!ran.jobs.length) return;
	out.log('where each job ran (job-history):');
	for (const j of ran.jobs) {
		const name = `job ${j.jobId}${j.jobName ? ` (${j.jobName})` : ''}`;
		if (j.runner === null) {
			out.log(`  ${name}: not in job-history yet`);
			continue;
		}
		let line = `  ${name}: ran on ${j.node} (${j.runner})`;
		if (j.swapped) {
			const minted =
				j.mintedForJobId !== null && j.mintedForJobId !== j.jobId
					? `runner minted for job ${j.mintedForJobId}`
					: 'runner on another node';
			line += ` — NOT where it was placed: ${minted}${j.decidedOn ? `, decided ${j.decidedOn}` : ''}`;
		}
		out.log(line);
	}
}
