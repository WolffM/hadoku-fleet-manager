#!/usr/bin/env node
/**
 * failures — per-node CI failure rate, standardized against the FLEET's own
 * rate for the same (repo, job kind). READ-ONLY. Refactor plan §7.3, T3;
 * replaces the hand-written `docs/planning/failures-by-node-*.md` analyses
 * (see `src/failure-rates.ts` for the statistic and why a raw per-node rate
 * is the wrong question).
 *
 * Reads the same T2 daily rollup store `fleet job-rollups` reads
 * (`src/job-rollup-store.ts`, written by mgmt-api's runner-health tick from
 * job-history). Writes nothing, calls no GitHub endpoint, reaches no machine.
 *
 * "I COULD NOT LOOK" IS NOT "ZERO FAILURES". No store at all, or a store with
 * no days ever written, exits 1 and says so — same contract `job-rollups.mjs`
 * already keeps. A node (or a cell) below the significance floor is
 * `insufficientData`, never folded into "healthy".
 *
 * NOT UNDER THE `--json` CONTRACT (`scripts/lib/json-contract.mjs`). No cron
 * parses this yet; if one ever does, it is added there in the same pass.
 */
import { join } from 'node:path';
import process from 'node:process';

import { stateDir } from './lib/paths.mjs';
import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { parseStrict } from './lib/argv.mjs';
import { createEmitter } from './lib/emit.mjs';
import { ROLLUP_FILE, jsonlRollupStore } from '../dist/job-rollup-store.js';
import { FLEET_NODE, SETTLE_HOURS, utcDay } from '../dist/job-rollups.js';
import { computeFailureRates, FLEET_ORIGIN_ZONES } from '../dist/failure-rates.js';

const argv = process.argv.slice(2);
const SPEC = {
	...ARGV_SPECS['failures.mjs'],
	usage: ARGV_SPECS['failures.mjs'].usage.replace('{SETTLE_HOURS}', String(SETTLE_HOURS)),
};
const parsed = parseStrict(SPEC, argv);
const out = createEmitter({ argv: process.argv });

/** @param {string} msg */
function fail(msg) {
	if (out.json) out.emit({ ok: false, error: msg });
	else console.error(`✗ ${msg}`);
	process.exit(1);
}

// See job-rollups.mjs's own note on why `parsed.value` is not enough here:
// "given with nothing after it" must refuse loudly, not default silently.
/** @param {string} name */
function rawFlag(name) {
	const present = argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`));
	if (!present) return null;
	return parsed.value(name) ?? '';
}

const daysRaw = rawFlag('--days');
const days = daysRaw === null ? 14 : Number(daysRaw);
if (!Number.isInteger(days) || days < 1)
	fail(`--days must be a positive integer, got "${daysRaw}"`);
const nodeFilter = rawFlag('--node');
if (nodeFilter === '') fail('--node needs a value');

const file = join(stateDir(), ROLLUP_FILE);
/** @type {import('../dist/job-rollup-store.js').RollupRead} */
let read;
try {
	read = jsonlRollupStore(file).read();
} catch (err) {
	fail(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
}
if (!read.exists || !read.days.length) {
	fail(
		`no rollups at ${file} — the writer (mgmt-api's runner-health tick) has never written ` +
			'one into this state dir. That is "could not look", not "zero failures".'
	);
}

const DAY_MS = 86_400_000;
const now = Date.now();
const fromDay = utcDay(now - days * DAY_MS);
const inRange = read.days.filter((d) => d.day >= fromDay);

// Same "name every gap" discipline as job-rollups.mjs: a day the writer never
// closed is listed, never silently skipped.
const lastClosable = utcDay(now - SETTLE_HOURS * 3600_000 - DAY_MS);
const held = new Set(inRange.map((d) => d.day));
const missingDays = [];
for (let ms = Date.parse(`${fromDay}T00:00:00Z`); utcDay(ms) <= lastClosable; ms += DAY_MS) {
	if (!held.has(utcDay(ms))) missingDays.push(utcDay(ms));
}

const report = computeFailureRates(inRange, { zones: FLEET_ORIGIN_ZONES, fleetNode: FLEET_NODE });
const shownNodes =
	nodeFilter === null ? report.nodes : report.nodes.filter((n) => n.node === nodeFilter);

if (out.json) {
	out.emit({
		ok: true,
		file,
		days,
		node: nodeFilter,
		unreadableLines: read.unreadableLines,
		missingDays,
		zones: report.zones,
		minCellFleetJobs: report.minCellFleetJobs,
		minNodeJobs: report.minNodeJobs,
		minExpected: report.minExpected,
		daysConsidered: report.days,
		nodes: shownNodes,
	});
	process.exit(0);
}

console.log(
	`fleet failures from ${file} (${report.days} day(s), zones: ${report.zones.join('+')})`
);
if (read.unreadableLines) console.log(`  ${read.unreadableLines} unreadable line(s) in the store`);
if (missingDays.length) console.log(`  MISSING day(s): ${missingDays.join(', ')}`);
if (!shownNodes.length) {
	console.log(
		nodeFilter
			? `\nno rollups for node "${nodeFilter}" since ${fromDay}`
			: `\nno rollups since ${fromDay}`
	);
} else {
	console.log(
		`\n  ${'node'.padEnd(14)} ${'jobs'.padStart(6)} ${'observed'.padStart(9)} ${'expected'.padStart(9)} ${'excess'.padStart(8)}  significance  top zone`
	);
	for (const n of shownNodes) {
		const sig = n.insufficientData
			? 'insufficient'
			: `z=${n.z.toFixed(2).padStart(6)} p=${n.pValue.toFixed(4)}`;
		console.log(
			`  ${n.node.padEnd(14)} ${String(n.jobs).padStart(6)} ${String(n.observed).padStart(9)} ` +
				`${n.expected.toFixed(1).padStart(9)} ${n.excess.toFixed(1).padStart(8)}  ${sig.padEnd(18)} ${n.topZone ?? '-'}`
		);
		if (n.insufficientData) console.log(`      ${n.insufficientReason}`);
		if (n.cellsExcluded)
			console.log(`      ${n.cellsExcluded} cell(s) excluded (thin fleet baseline)`);
	}
}
