#!/usr/bin/env node
/**
 * backfill-failed-steps — P2.1's second half, as a CLIENT of the live writer.
 *
 * `job-history.jsonl` records did not carry `failedStep`/`failedPhase` before
 * `@wolffm/fleet-manager` 0.22.24 (job-history.ts `stepFailure`). GitHub ages
 * its job records out daily, so the reach of any backfill shrinks every day it
 * is not run.
 *
 * WHY THIS FILE NO LONGER TOUCHES THE FILE
 * ----------------------------------------
 * It used to. It read `job-history.jsonl`, fetched each failed job from GitHub,
 * and patched the lines in place — carefully: it re-read the file immediately
 * before writing and refused to write at all if the bytes had moved under it.
 *
 * On 2026-09-07 it patched 502 records and every one of them was gone within
 * the hour, with no error anywhere. The guard was sound and guarded the wrong
 * race. `job-history.jsonl` has exactly ONE writer — the long-running mgmt-api —
 * and that writer reads the file exactly once, at boot (`loadHistory` is
 * `if (loaded) return`). Its in-memory window had therefore never heard of the
 * patches, and its next `compactHistory()` wrote that window over the file. No
 * file-level protocol survives that, because the process is not reading the
 * file to begin with. The `.bak` this script had written was pre-backfill and
 * so preserved nothing either.
 *
 * The only way to durably change a record is to change the object the live
 * process is holding. So the work moved INTO the library — `backfillFailedSteps`
 * in `src/job-history-backfill.ts`, reached over the loopback API — and this file is now
 * the operator's door to it, nothing more.
 *
 *   node scripts/backfill-failed-steps.mjs [--max 2000] [--concurrency 5]
 *                                          [--base http://127.0.0.1:4000]
 *
 * mgmt-api binds loopback only, so this must run ON the mgmt-api host.
 */
import process from 'node:process';
import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { parseStrict } from './lib/argv.mjs';

// F8 (plan §4.1): strict, from the one spec argv-specs.mjs declares.
const parsed = parseStrict(ARGV_SPECS['backfill-failed-steps.mjs'], process.argv.slice(2));

const MAX = Number(parsed.value('--max') ?? '2000') || 2000;
const CONCURRENCY = Number(parsed.value('--concurrency') ?? '5') || 5;
const BASE = (parsed.value('--base') ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

const url = `${BASE}/api/fleet/job-history/backfill?max=${MAX}&concurrency=${CONCURRENCY}`;

let resp;
try {
	resp = await fetch(url, { method: 'POST' });
} catch (err) {
	// "I could not look" is not "nothing to do". Say WHY: a refused connection
	// means mgmt-api is down, which is a different job from a 500 out of it.
	console.error(`✗ could not reach mgmt-api at ${BASE}: ${err.message}`);
	console.error('  This must run on the mgmt-api host; check `pm2 list` for mgmt-api.');
	process.exit(1);
}

const body = await resp.text();
let json;
try {
	json = JSON.parse(body);
} catch {
	console.error(`✗ mgmt-api returned ${resp.status} with an unparseable body:`);
	console.error(body.slice(0, 500));
	process.exit(1);
}

if (!resp.ok || !json.success) {
	console.error(`✗ backfill failed (${resp.status}): ${json.error ?? 'no reason given'}`);
	process.exit(1);
}

console.log(
	`${json.candidates} record(s) missing failedStep. ` +
		`Fetched ${json.fetched}, patched ${json.patched}.`
);
console.log(
	`Expired (aged out of GitHub, unrecoverable): ${json.expired}. ` +
		`Other failures (retryable): ${json.failed}.`
);
if (json.remaining > 0) {
	console.log(`${json.remaining} left by --max ${MAX} — re-run to continue.`);
}
console.log(
	json.patched
		? `Persisted through the live writer: ${json.persisted}.`
		: 'Nothing patched, so nothing written.'
);
// A pass that could not write what it patched is a FAILURE, not a quiet success.
if (json.patched > 0 && !json.persisted) {
	console.error('✗ records were patched in memory but the write failed — see mgmt-api logs.');
	process.exit(1);
}
