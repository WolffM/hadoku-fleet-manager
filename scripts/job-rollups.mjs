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

import { stateDir } from '../dist/lib/fleet-paths.js';
import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { parseStrict } from './lib/argv.mjs';
import { createEmitter } from './lib/emit.mjs';
import { FLEET_NODE, SETTLE_HOURS } from '../dist/job-rollups.js';
import {
	makeFail,
	missingDaysSince,
	parseDaysArg,
	rawFlag as sharedRawFlag,
	readRollupStore,
	rollupWindow,
} from './lib/rollup-cli.mjs';
import { ROLLUP_FILE } from '../dist/job-rollup-store.js';

const argv = process.argv.slice(2);
// F8 (plan §4.1): strict, from the one spec `argv-specs.mjs` declares and the
// door reads too. The spec's usage carries a `{SETTLE_HOURS}` placeholder —
// see that file's note on why a pure data module does not import a build
// artifact just to interpolate one constant into its own help text.
const SPEC = {
	...ARGV_SPECS['job-rollups.mjs'],
	usage: ARGV_SPECS['job-rollups.mjs'].usage.replace('{SETTLE_HOURS}', String(SETTLE_HOURS)),
};
const parsed = parseStrict(SPEC, argv);
const out = createEmitter({ argv: process.argv });
const fail = makeFail(out);

const rawFlag = (name) => sharedRawFlag(argv, parsed, name);

const { days, error: daysError } = parseDaysArg(rawFlag('--days'));
if (daysError) fail(daysError);
const node = rawFlag('--node');
if (node === '') fail('--node needs a value');
const repoRaw = rawFlag('--repo');
if (repoRaw === '') fail('--repo needs a value');
/** @param {string} repo */
const repoMatches = (repo) => repoRaw === null || repo === repoRaw || repo.endsWith(`/${repoRaw}`);

const file = join(stateDir(), ROLLUP_FILE);
const { read, error: storeError } = readRollupStore(file, {
	requireDays: false,
	contrastPhrase: '"no jobs"',
});
if (storeError) fail(storeError);

const now = Date.now();
const { fromDay, inRange } = rollupWindow(read, { days, now });
const missingDays = missingDaysSince(inRange, { fromDay, now });

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
