#!/usr/bin/env node
/**
 * check-fleet-kills — did the FLEET stop this job, or did the job fail?
 *
 * WHAT IT LOOKS FOR
 * -----------------
 * A JIT runner is a transient systemd unit, and until 2026-09-14 every one of
 * them was minted with `RuntimeMaxSec=3600`. The number was chosen to bound an
 * ORPHANED LISTENER — one that lost the race to a warm runner and would
 * otherwise sit registered forever. systemd cannot tell an orphan from a build
 * at minute 59, so it stopped the unit either way, and the job died with it
 * (issue #22).
 *
 * That failure is invisible to every other gate in this package. `queue-health`,
 * `drain-check`, `label-floor` and the canaries were all green through
 * brave-quartet's `check` on 2026-09-10 — none of them moves a byte for an hour,
 * so none of them can be killed at one. The only place the evidence survives is
 * job history, and there it is unmistakable once you know the shape:
 *
 *   `durationSec` within a few seconds of a TTL the fleet has actually minted,
 *   and a failure in a CLEANUP step (`Post *`, `Complete job`).
 *
 * Both halves matter. The duration alone catches a job that happened to take an
 * hour; the step alone catches every ordinary `Post`-step flake. Together they
 * are the signature of `The runner has received a shutdown signal` — the unit
 * went away under a job whose own steps had all passed.
 *
 * WHY THE TTL LIST IS HISTORICAL, NOT A CONSTANT IMPORT
 * ----------------------------------------------------
 * History spans deploys. A record written while the fleet minted 3600 s units
 * has to stay detectable after the fleet stops minting them, or this check gets
 * EASIER to pass the moment the bug is fixed and loses the ability to say what
 * the bug cost. So every TTL the fleet has ever minted with is listed, with the
 * dates it was live, and a new one is APPENDED rather than swapped in.
 *
 * That list, and the signature that reads it, now live in `src/job-history.ts`
 * as `KNOWN_TTL_SEC` / `TTL_MATCH_SEC` / `isFleetKill`, and this file imports
 * the BUILT copy. It moved when `floor-probe report` needed the same rule to
 * fold a fleet kill into its own zone: a second copy of "did the fleet stop
 * this job" is the `isLocalNode` shape, where five answers to one question
 * disagreed and only one survived contact with reality. The argument above is
 * unchanged and travels with the list — it is still what the fleet minted THEN,
 * and still not `runners/ephemeral.ts`, which holds what it mints TODAY.
 *
 * NEAR MISSES ARE REPORTED, NOT DISCARDED
 * ---------------------------------------
 * A unit killed at its TTL mid-`run` step fails a `run` step, not a `Post` one —
 * that is what a kill at minute 60 of a 90-minute build looks like. Filtering on
 * the cleanup step alone would make this check quieter the LONGER the job it
 * missed, which is the failure mode CLAUDE.md's "no gate may get easier to pass
 * the worse the failure gets" rule exists for. So a duration match that fails
 * the step test is still carried in the payload, under `nearTtl`, where a reader
 * can see what the filter excluded.
 *
 * UNDER THE `--json` CONTRACT SINCE 2026-10-28: `ci:fleet-kills` runs
 * `--days 2 --json` nightly (see its entry in `scripts/lib/json-contract.mjs`).
 * Every path out of this script emits one document, the refusals included —
 * `why: 'bad-days' | 'no-history' | 'no-records-in-window'` with `ok: false`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { stateDir } from './lib/paths.mjs';
import { createEmitter } from './lib/emit.mjs';
import { KNOWN_TTL_SEC, TTL_MATCH_SEC, isFleetKill } from '../dist/job-history-stats.js';

const JSON_OUT = process.argv.includes('--json');
const out = createEmitter({ argv: process.argv });

/** Local alias, so the output below reads the way it always has. */
const MATCH_SEC = TTL_MATCH_SEC;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	out.log('check-fleet-kills — jobs the FLEET stopped, not jobs that failed');
	out.log('');
	out.log('  --days <n>   window to scan, in days (default 14)');
	out.log('  --json       machine-readable findings');
	out.log('');
	out.log(`Reads job history for records whose durationSec lands within ${MATCH_SEC} s of`);
	out.log('a TTL the fleet has minted AND that failed in a cleanup step — the');
	out.log('signature of a unit stopped out from under a live job (issue #22).');
	process.exit(0);
}

const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : 14;
if (!Number.isFinite(DAYS) || DAYS <= 0) {
	out.warn(`--days must be a positive number, got ${JSON.stringify(process.argv[daysArg + 1])}`);
	if (JSON_OUT) out.emit({ ok: false, why: 'bad-days', lines: out.held() });
	process.exit(1);
}

const HISTORY = join(stateDir(), 'job-history.jsonl');
if (!existsSync(HISTORY)) {
	// "I could not look" is not "nothing is wrong". A missing history is the one
	// place this evidence lives; without it the fleet could have killed every job
	// in the window and this would have nothing to say.
	out.warn(`no job history at ${HISTORY}, so fleet kills cannot be detected.`);
	if (JSON_OUT) out.emit({ ok: false, why: 'no-history', path: HISTORY, lines: out.held() });
	process.exit(1);
}

const all = [];
let unparseable = 0;
for (const line of readFileSync(HISTORY, 'utf8').split('\n')) {
	const t = line.trim();
	if (!t) continue;
	try {
		all.push(JSON.parse(t));
	} catch {
		// A truncated final line costs one record, by the writer's design. Counted
		// rather than swallowed: a file that is MOSTLY unparseable is a different
		// fact from a file with one torn tail, and the count is what tells them apart.
		unparseable++;
	}
}

const cutoffMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;
const window = all.filter((r) => Date.parse(r.startedAt ?? '') >= cutoffMs);

if (!window.length) {
	// Zero records scanned is a failure, not a clean bill of health — the same
	// rule the zero-repo case in `reconcile` fails under.
	out.warn(
		`job history holds ${all.length} record(s) but NONE in the last ${DAYS} day(s): ` +
			`nothing was scanned, so nothing can be concluded.`
	);
	if (JSON_OUT)
		out.emit({
			ok: false,
			why: 'no-records-in-window',
			days: DAYS,
			historyRecords: all.length,
			unparseable,
			lines: out.held(),
		});
	process.exit(1);
}

const kills = [];
const nearTtl = [];
for (const r of window) {
	if (typeof r.durationSec !== 'number') continue;
	const hit = KNOWN_TTL_SEC.find((t) => Math.abs(r.durationSec - t.sec) <= MATCH_SEC);
	if (!hit) continue;
	// A job that ran to the TTL and SUCCEEDED is evidence the TTL did not fire —
	// the unit outlived the job. It is a duration coincidence, not a near miss,
	// and carrying it would bury the ones that are.
	if (r.conclusion === 'success') continue;
	const finding = {
		repo: r.repo,
		runId: r.runId,
		jobId: r.jobId,
		job: r.name,
		runner: r.runner,
		startedAt: r.startedAt,
		durationSec: r.durationSec,
		ttlSec: hit.sec,
		overshootSec: r.durationSec - hit.sec,
		conclusion: r.conclusion,
		failedStep: r.failedStep ?? null,
		failedPhase: r.failedPhase ?? null,
	};
	// `isFleetKill` is the whole signature — duration near a minted TTL, not a
	// success, AND a cleanup step. The three guards above have already settled
	// the first two, so what this adds here is the step test; asking the one
	// function for it keeps the FINDING and the report's `fleet` zone reading
	// the same rule rather than two that agree until one moves.
	if (isFleetKill(r)) kills.push(finding);
	else nearTtl.push(finding);
}

out.log(
	`Scanned ${window.length} job record(s) over ${DAYS} day(s) ` +
		`(${all.length} in history, ${unparseable} unparseable).`
);
out.log(`Known TTLs: ${KNOWN_TTL_SEC.map((t) => `${t.sec}s`).join(', ')} (±${MATCH_SEC}s).`);
out.log('');

for (const k of kills) {
	out.warn(`FLEET KILL  ${k.repo}  run ${k.runId}  job "${k.job}"`);
	out.warn(
		`            ${k.startedAt}  ${k.durationSec}s vs TTL ${k.ttlSec}s ` + `(+${k.overshootSec}s)`
	);
	out.warn(`            ${k.conclusion} in ${k.failedStep ?? '(step unknown)'}`);
	out.warn(`            runner ${k.runner}`);
}
if (nearTtl.length) {
	out.log(`${nearTtl.length} record(s) matched a TTL duration but not the cleanup-step test:`);
	for (const n of nearTtl) {
		out.log(
			`  near-ttl  ${n.repo}  run ${n.runId}  ${n.durationSec}s vs ${n.ttlSec}s  ` +
				`${n.conclusion}${n.failedStep ? ` in ${n.failedStep}` : ''}`
		);
	}
}
if (!kills.length && !nearTtl.length) {
	out.log(`✓ no job in the last ${DAYS} day(s) died at a fleet TTL.`);
}

if (JSON_OUT) {
	out.emit({
		ok: kills.length === 0,
		days: DAYS,
		scanned: window.length,
		historyRecords: all.length,
		unparseable,
		matchSec: MATCH_SEC,
		knownTtlSec: KNOWN_TTL_SEC,
		kills,
		nearTtl,
		lines: out.held(),
	});
}

process.exit(kills.length ? 1 : 0);
