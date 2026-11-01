#!/usr/bin/env node
/**
 * stats — the operator surface over the fleet's telemetry (refactor plan
 * §7.3, T6). READ-ONLY, same contract as `job-rollups.mjs`/`failures.mjs`
 * beside it: no GitHub call, no ssh, no write — every section reads exactly
 * one local store (CLAUDE.md's GitHub-budget rule: `fleet stats` must never
 * spend any of it).
 *
 * FIVE INDEPENDENT SECTIONS, each its own store:
 *
 *   daily     T2 rollups (`job-rollup-store.ts`) — jobs, conclusions and a
 *             sample-weighted queue p50/p95 (see `fleet-stats.ts`'s header
 *             for why that is an approximation, named as one), per day.
 *   byRepo    the same T2 rollups, folded by repo over the whole window.
 *   automation T7 job-run sink (`job-run-store.ts`) — per registry job, the
 *             last run, the verdict mix and the run count. A registry job
 *             with ZERO runs in the window is reported `runs: 0` explicitly,
 *             never silently absent.
 *   capacity  T4 capacity samples (`capacity-sample-store.ts`) — per node,
 *             what SHARE of its samples were unmeasured, drained or sitting
 *             at its admission ceiling.
 *   budget    T5 GitHub-budget window history (`gh-budget-history-store.ts`)
 *             — per token, the peak hourly `used/limit` and the top callers
 *             by charged calls.
 *
 * "NO DATA" IS NEVER A ZERO. A section whose store is missing, or holds
 * nothing in the requested `--days` window, reports COULD NOT LOOK for
 * itself — `{ok:false, why}` in `--json`, one explicit line in human mode —
 * rather than an empty table that would read as "nothing happened" (AGENTS.md:
 * "'I could not look' must never render as 'nothing is wrong'"). Each
 * section decides this independently: a controller that has never sampled
 * capacity must not blank out the daily rollups too. The command's own `ok`
 * is false only when EVERY section came back could-not-look — one working
 * section is still a real answer to a real operator question, same
 * reasoning `check-queue-health.mjs` and friends already use for a partial
 * finding.
 *
 * NOT UNDER THE `--json` CONTRACT (`scripts/lib/json-contract.mjs`) — no
 * cron parses this yet, the same footing `job-rollups.mjs` and `failures.mjs`
 * started on. If one ever does, it is added there in the same pass.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { stateDir } from './lib/paths.mjs';
import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { parseStrict } from './lib/argv.mjs';
import { createEmitter } from './lib/emit.mjs';

import { ROLLUP_FILE, jsonlRollupStore } from '../dist/job-rollup-store.js';
import { SETTLE_HOURS, utcDay } from '../dist/job-rollups.js';
import { jobRunDir, readJobRuns } from '../dist/job-run-store.js';
import { JOB_REGISTRY } from '../dist/lib/job-registry.js';
import { CAPACITY_SAMPLE_FILE, capacitySampleStore } from '../dist/capacity-sample-store.js';
import { GH_BUDGET_HISTORY_FILE, ghBudgetHistoryStore } from '../dist/gh-budget-history-store.js';
import {
	automationHealthStats,
	budgetStats,
	capacityStats,
	dailyJobStats,
	repoJobStats,
} from '../dist/fleet-stats.js';

const argv = process.argv.slice(2);
const parsed = parseStrict(ARGV_SPECS['stats.mjs'], argv);
const out = createEmitter({ argv: process.argv });

/**
 * `null` when the flag was never given; `''` when given with nothing after
 * it — same "say loudly, never default quietly" rule `job-rollups.mjs`'s own
 * `rawFlag` states.
 * @param {string} name
 */
function rawFlag(name) {
	const present = argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`));
	if (!present) return null;
	return parsed.value(name) ?? '';
}

const daysRaw = rawFlag('--days');
const days = daysRaw === null ? 14 : Number(daysRaw);
if (!Number.isInteger(days) || days < 1) {
	const error = `--days must be a positive integer, got "${daysRaw}"`;
	if (out.json) out.emit({ ok: false, error });
	else console.error(`✗ ${error}`);
	process.exit(1);
}

const DAY_MS = 86_400_000;
const now = Date.now();
const fromDay = utcDay(now - days * DAY_MS);
const sinceMs = now - days * DAY_MS;
const sinceIso = new Date(sinceMs).toISOString();
const dir = stateDir();

// ── (a)+(b): the T2 daily rollups ───────────────────────────────────────────

function rollupSection() {
	const file = join(dir, ROLLUP_FILE);
	let read;
	try {
		read = jsonlRollupStore(file).read();
	} catch (err) {
		return {
			ok: false,
			why: `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (!read.exists || !read.days.length) {
		return {
			ok: false,
			why:
				`no rollups at ${file} — the writer (mgmt-api's runner-health tick) has never ` +
				'written one into this state dir. That is "could not look", not "no jobs".',
		};
	}
	const inRange = read.days.filter((d) => d.day >= fromDay);
	if (!inRange.length) {
		return {
			ok: false,
			why: `rollups exist at ${file} but none fall in the last ${days} day(s) (since ${fromDay})`,
		};
	}
	// Same "name every gap" discipline as job-rollups.mjs: a day the writer
	// never closed is listed, never silently skipped.
	const lastClosable = utcDay(now - SETTLE_HOURS * 3600_000 - DAY_MS);
	const held = new Set(inRange.map((d) => d.day));
	const missingDays = [];
	for (let ms = Date.parse(`${fromDay}T00:00:00Z`); utcDay(ms) <= lastClosable; ms += DAY_MS) {
		if (!held.has(utcDay(ms))) missingDays.push(utcDay(ms));
	}
	return {
		ok: true,
		file,
		unreadableLines: read.unreadableLines,
		missingDays,
		daily: dailyJobStats(inRange),
		byRepo: repoJobStats(inRange),
	};
}

// ── (c): the T7 job-run sink ─────────────────────────────────────────────────

function automationSection() {
	const runsDir = jobRunDir(dir);
	if (!existsSync(runsDir)) {
		return {
			ok: false,
			why:
				`no job-run sink at ${runsDir} — nothing has recorded a registry job run into ` +
				'this state dir yet',
		};
	}
	const read = readJobRuns(runsDir, { sinceMs });
	if (!read.rows.length) {
		return {
			ok: false,
			why: `${runsDir} exists but holds no run in the last ${days} day(s) (since ${sinceIso})`,
		};
	}
	const jobNames = [...new Set(JOB_REGISTRY.map((e) => e.name))];
	return {
		ok: true,
		dir: runsDir,
		badLines: read.badLines,
		unreadable: read.unreadable,
		rows: automationHealthStats(read.rows, jobNames),
	};
}

// ── (d): the T4 capacity samples ─────────────────────────────────────────────

function capacitySection() {
	const file = join(dir, CAPACITY_SAMPLE_FILE);
	let read;
	try {
		read = capacitySampleStore(file).read();
	} catch (err) {
		return {
			ok: false,
			why: `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (!read.exists || !read.rows.length) {
		return {
			ok: false,
			why: `no capacity samples at ${file} — the sampler has never written one into this state dir`,
		};
	}
	const inRange = read.rows.filter((r) => r.at >= sinceIso);
	if (!inRange.length) {
		return {
			ok: false,
			why: `samples exist at ${file} but none fall in the last ${days} day(s) (since ${sinceIso})`,
		};
	}
	return { ok: true, file, unreadableLines: read.unreadableLines, rows: capacityStats(inRange) };
}

// ── (e): the T5 GitHub-budget window history ────────────────────────────────

function budgetSection() {
	const file = join(dir, GH_BUDGET_HISTORY_FILE);
	let read;
	try {
		read = ghBudgetHistoryStore(file).read();
	} catch (err) {
		return {
			ok: false,
			why: `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (!read.exists || !read.rows.length) {
		return {
			ok: false,
			why: `no GitHub budget history at ${file} — gh-budget.ts has never closed a window into this state dir`,
		};
	}
	const inRange = read.rows.filter((r) => r.windowEnd >= sinceIso);
	if (!inRange.length) {
		return {
			ok: false,
			why: `budget history exists at ${file} but no window closed in the last ${days} day(s) (since ${sinceIso})`,
		};
	}
	return { ok: true, file, unreadableLines: read.unreadableLines, rows: budgetStats(inRange) };
}

const rollup = rollupSection();
/** @param {'daily'|'byRepo'} key */
const fromRollup = (key) =>
	rollup.ok
		? {
				ok: true,
				file: rollup.file,
				unreadableLines: rollup.unreadableLines,
				missingDays: rollup.missingDays,
				rows: rollup[key],
			}
		: rollup;

const daily = fromRollup('daily');
const byRepo = fromRollup('byRepo');
const automation = automationSection();
const capacity = capacitySection();
const budget = budgetSection();

const sections = { daily, byRepo, automation, capacity, budget };
const ok = Object.values(sections).some((s) => s.ok);

if (out.json) {
	out.emit({ ok, days, generatedAt: new Date(now).toISOString(), ...sections });
	process.exit(ok ? 0 : 1);
}

// ── human mode ───────────────────────────────────────────────────────────────

console.log(`fleet stats — last ${days} day(s), state dir ${dir}`);

/**
 * @param {string} title
 * @param {{ok: boolean, why?: string}} result
 * @param {(r: any) => void} renderOk
 */
function section(title, result, renderOk) {
	console.log(`\n${title}`);
	if (!result.ok) {
		console.log(`  COULD NOT LOOK: ${result.why}`);
		return;
	}
	renderOk(result);
}

section('daily jobs / queue / conclusions (T2 rollups)', daily, (r) => {
	if (r.unreadableLines)
		console.log(`  ${r.unreadableLines} unreadable line(s) in the rollup store`);
	if (r.missingDays.length) console.log(`  MISSING day(s): ${r.missingDays.join(', ')}`);
	if (!r.rows.length) console.log('  (no days in range)');
	for (const d of r.rows) {
		const notOk = d.jobs - (d.conclusions.success ?? 0);
		const q =
			d.queueSec.n > 0
				? `queue p50~${d.queueSec.p50.toFixed(0)}s p95~${d.queueSec.p95.toFixed(0)}s (n=${d.queueSec.n}, weighted mean)`
				: 'no queue samples';
		console.log(
			`  ${d.day}  ${String(d.jobs).padStart(5)} job(s)  ${String(notOk).padStart(4)} not ok  ${q}`
		);
	}
});

section('per-repo totals (T2 rollups)', byRepo, (r) => {
	if (!r.rows.length) console.log('  (no repos in range)');
	for (const repo of r.rows) {
		const notOk = repo.jobs - (repo.conclusions.success ?? 0);
		console.log(
			`  ${repo.repo.padEnd(32)} ${String(repo.jobs).padStart(6)} job(s)  ${String(notOk).padStart(4)} not ok`
		);
	}
});

section('automation health (T7 job-run sink)', automation, (r) => {
	if (r.badLines) console.log(`  ${r.badLines} unreadable line(s) in the job-run sink`);
	for (const u of r.unreadable) console.log(`  unreadable: ${u.file} (${u.why})`);
	for (const j of r.rows) {
		if (j.runs === 0) {
			console.log(`  ${j.job.padEnd(28)} NO RUNS observed in this window`);
			continue;
		}
		const vc = j.verdictCounts;
		console.log(
			`  ${j.job.padEnd(28)} ${String(j.runs).padStart(4)} run(s)  ok ${vc.ok} findings ${vc.findings} ` +
				`error ${vc.error} could-not-look ${vc['could-not-look']}  last ${j.lastRun.startedAt} (${j.lastRun.verdict})`
		);
	}
});

section('capacity / admission (T4 samples)', capacity, (r) => {
	for (const n of r.rows) {
		const pct = (x) => ((x / n.samples) * 100).toFixed(0);
		console.log(
			`  ${n.node.padEnd(14)} ${String(n.samples).padStart(5)} sample(s)  unmeasured ${pct(n.unmeasured)}%` +
				`  drained ${pct(n.drained)}%  at-capacity ${pct(n.atCapacity)}%`
		);
	}
});

section('GitHub budget (T5 history)', budget, (r) => {
	for (const t of r.rows) {
		const pct = t.peakUsedPct === null ? '?' : t.peakUsedPct.toFixed(0);
		console.log(
			`  ${t.token}/${t.resource}  peak ${t.peakUsed}/${t.limit} (${pct}%), exhausted in ${t.exhaustedWindows} of ${t.windows} window(s)`
		);
		for (const c of t.topCallers) console.log(`      ${c.caller.padEnd(28)} ${c.charged} charged`);
	}
});

process.exit(ok ? 0 : 1);
