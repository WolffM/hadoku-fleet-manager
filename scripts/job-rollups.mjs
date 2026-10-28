#!/usr/bin/env node
/**
 * job-rollups — read the fleet's daily CI rollups. READ-ONLY.
 *
 * mgmt-api writes one rollup per closed UTC day (per node, repo and job kind,
 * plus a fleet row `node: "*"` for each repo+kind) from job-history, on the
 * runner-health tick. See `src/job-rollups.ts` for what a row holds, when a day
 * counts as closed and why. This command only reads that store; it writes
 * nothing, calls no GitHub endpoint and reaches no machine.
 *
 * "I COULD NOT LOOK" IS NOT "NOTHING HAPPENED". No store at all exits 1 and
 * says so — the writer has never run on this host's state dir. Days missing
 * from the requested range are listed by name (`missingDays`), never skipped,
 * and lines the store could not parse are counted.
 *
 * NOT UNDER THE `--json` CONTRACT. No cron parses this yet, so it is absent
 * from `scripts/lib/json-contract.mjs`. If one ever does, it is added there in
 * the same pass.
 */
import { join } from 'node:path';
import process from 'node:process';

import { stateDir } from './lib/paths.mjs';
import { createEmitter } from './lib/emit.mjs';
import { ROLLUP_FILE, jsonlRollupStore } from '../dist/job-rollup-store.js';
import { FLEET_NODE, SETTLE_HOURS, utcDay } from '../dist/job-rollups.js';

const argv = process.argv.slice(2);
const out = createEmitter({ argv: process.argv });

if (argv.includes('--help') || argv.includes('-h')) {
	out.log('fleet job-rollups — the daily CI rollups mgmt-api writes from job-history');
	out.log('');
	out.log('  --days <n>     closed days to show, counted back from today (default 14)');
	out.log('  --node <name>  only this node, plus the fleet row for the same repo+kind');
	out.log('  --repo <name>  only this repo (owner/name, or just name)');
	out.log('  --json         the rows themselves');
	out.log('');
	out.log(`A day is written ${SETTLE_HOURS}h after it ends, so the newest two days are`);
	out.log('never here yet. Reads the state dir only; writes nothing.');
	process.exit(0);
}

/** @param {string} name */
function flag(name) {
	const i = argv.indexOf(`--${name}`);
	if (i >= 0) return argv[i + 1] ?? '';
	const eq = argv.find((a) => a.startsWith(`--${name}=`));
	return eq ? eq.slice(name.length + 3) : null;
}

/** @param {string} msg */
function fail(msg) {
	if (out.json) out.emit({ ok: false, error: msg });
	else console.error(`✗ ${msg}`);
	process.exit(1);
}

const daysRaw = flag('days');
const days = daysRaw === null ? 14 : Number(daysRaw);
if (!Number.isInteger(days) || days < 1)
	fail(`--days must be a positive integer, got "${daysRaw}"`);
const node = flag('node');
if (node === '') fail('--node needs a value');
const repoRaw = flag('repo');
if (repoRaw === '') fail('--repo needs a value');
/** @param {string} repo */
const repoMatches = (repo) => repoRaw === null || repo === repoRaw || repo.endsWith(`/${repoRaw}`);

const file = join(stateDir(), ROLLUP_FILE);
/** @type {import('../dist/job-rollup-store.js').RollupRead} */
let read;
try {
	read = jsonlRollupStore(file).read();
} catch (err) {
	fail(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
}
if (!read.exists) {
	fail(
		`no rollups at ${file} — the writer (mgmt-api's runner-health tick) has never written ` +
			'one into this state dir. That is "could not look", not "no jobs".'
	);
}

const DAY_MS = 86_400_000;
const now = Date.now();
const fromDay = utcDay(now - days * DAY_MS);
const inRange = read.days.filter((d) => d.day >= fromDay);

// Every day from the range start up to the newest day that COULD be closed by
// now. One the store lacks is named, so a gap never reads as a quiet day.
const lastClosable = utcDay(now - SETTLE_HOURS * 3600_000 - DAY_MS);
const held = new Set(inRange.map((d) => d.day));
const missingDays = [];
for (let ms = Date.parse(`${fromDay}T00:00:00Z`); utcDay(ms) <= lastClosable; ms += DAY_MS) {
	if (!held.has(utcDay(ms))) missingDays.push(utcDay(ms));
}

/** @param {import('../dist/job-rollups.js').RollupRow} r */
function keep(r, wantedKeys) {
	if (!repoMatches(r.repo)) return false;
	if (node === null) return true;
	if (r.node === node) return true;
	return r.node === FLEET_NODE && wantedKeys.has(`${r.repo}\u0000${r.kind}`);
}

const shown = inRange.map((d) => {
	const wantedKeys = new Set(
		d.rows.filter((r) => r.node === node).map((r) => `${r.repo}\u0000${r.kind}`)
	);
	return { ...d, rows: d.rows.filter((r) => keep(r, wantedKeys)) };
});

if (out.json) {
	out.emit({
		ok: true,
		file,
		days,
		node,
		repo: repoRaw,
		unreadableLines: read.unreadableLines,
		missingDays,
		rollups: shown,
	});
	process.exit(0);
}

const ZONES = ['runner', 'seam', 'content', 'fleet', 'cancelled'];
console.log(`job rollups from ${file}`);
if (read.unreadableLines) console.log(`  ${read.unreadableLines} unreadable line(s) in the store`);
if (missingDays.length) console.log(`  MISSING day(s): ${missingDays.join(', ')}`);
for (const d of shown) {
	// Per node, summed over its repo+kind rows. Counts sum; percentiles do not,
	// so the human view shows counts only — `--json` carries the spreads.
	const perNode = new Map();
	for (const r of d.rows) {
		const e = perNode.get(r.node) ?? {
			jobs: 0,
			ok: 0,
			zones: Object.fromEntries(ZONES.map((z) => [z, 0])),
			jit: 0,
			warm: 0,
		};
		e.jobs += r.jobs;
		e.ok += r.conclusions.success ?? 0;
		for (const z of ZONES) e.zones[z] += r.failuresByZone[z] ?? 0;
		e.jit += r.byClass.jit?.jobs ?? 0;
		e.warm += r.byClass.warm?.jobs ?? 0;
		perNode.set(r.node, e);
	}
	console.log(
		`\n${d.day}  ${d.records} job(s)${d.probesExcluded ? `, ${d.probesExcluded} probe(s) excluded` : ''}`
	);
	const names = [...perNode.keys()].sort((a, b) =>
		a === FLEET_NODE ? -1 : b === FLEET_NODE ? 1 : a.localeCompare(b)
	);
	for (const n of names) {
		const e = perNode.get(n);
		const fails = e.jobs - e.ok;
		const zones = ZONES.filter((z) => e.zones[z])
			.map((z) => `${z} ${e.zones[z]}`)
			.join(', ');
		console.log(
			`  ${(n === FLEET_NODE ? 'fleet' : n).padEnd(14)} ${String(e.jobs).padStart(5)} job(s)` +
				`  ${String(fails).padStart(4)} not ok${zones ? ` (${zones})` : ''}` +
				`  jit ${e.jit} warm ${e.warm}`
		);
	}
}
if (!shown.length) console.log(`\nno rollups since ${fromDay}`);
