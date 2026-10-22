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
 * in `src/job-history.ts`, reached over the loopback API — and this file is now
 * the operator's door to it, nothing more.
 *
 *   node scripts/backfill-failed-steps.mjs [--max 2000] [--concurrency 5]
 *                                          [--base http://127.0.0.1:4000]
 *
 * mgmt-api binds loopback only, so this must run ON the mgmt-api host.
 */
import process from 'node:process';

function flag(name, fallback = null) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : fallback;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	console.log(
		`fleet backfill-failed-steps — fill failedStep/failedPhase on existing failed\n` +
			`job-history records, as far as GitHub still serves them.\n\n` +
			`Runs INSIDE mgmt-api (POST /api/fleet/job-history/backfill) because that\n` +
			`process is the only writer of job-history.jsonl and never re-reads it —\n` +
			`a patch applied to the file is silently overwritten by its next compaction.\n\n` +
			`  --max <n>          cap the gh calls this pass makes (default 2000)\n` +
			`  --concurrency <n>  parallel job fetches, capped at 10 (default 5)\n` +
			`  --base <url>       mgmt-api base (default http://127.0.0.1:4000)\n`
	);
	process.exit(0);
}

const MAX = Number(flag('--max', '2000')) || 2000;
const CONCURRENCY = Number(flag('--concurrency', '5')) || 5;
const BASE = (flag('--base', 'http://127.0.0.1:4000') ?? '').replace(/\/+$/, '');

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
