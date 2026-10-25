#!/usr/bin/env node
/**
 * check-history-coverage — is job-history actually recording what ran?
 *
 * WHY THIS EXISTS
 * ---------------
 * Every number the Fleet panel shows about SPEED and PLACEMENT is a statistic
 * over `~/.hadoku-mgmt/job-history.jsonl`: per-node medians, idle times, how
 * often hokon steps in, the queueSec the backstop is tuned against. None of
 * them is more trustworthy than the sample underneath, and nothing measured the
 * sample.
 *
 * On 2026-09-04 it was measured by hand for the first time: 38 of 95 completed
 * hadoku_site runs had NO record. Two in every five, for as long as the file had
 * existed. `ingestRuns` walked a newest-first listing and deferred the oldest
 * runs when its budget ran out, so the deferred ones were outranked by newer
 * arrivals on every subsequent tick until they scrolled out of the 30-run
 * window — starvation, while the module's own header promised "we will catch
 * the rest next tick".
 *
 * The ordering is fixed. This is the part that notices if it regresses, or if
 * some future change starts losing runs a different way. A silent 40% sample
 * loss is worse than an empty panel, because the panel still renders and the
 * numbers still look like answers.
 *
 * WHAT IT DOES NOT CLAIM
 * ----------------------
 * Absence is only evidence once a run has had time to be ingested and while it
 * is still inside the retention window, so both ends are excluded explicitly:
 *
 *   - runs completed within GRACE_MIN are skipped. The ingest tick is 10
 *     minutes; three ticks of slack keeps a busy-but-healthy fleet from
 *     reporting its own newest runs as loss.
 *   - runs older than the OLDEST record on file are skipped. Retention trims by
 *     age and count, so a run legitimately aged out is not a gap.
 *   - runs that COULD NOT HAVE BEEN RECORDED are skipped — see below. This gate
 *     called eight such runs "loss" on 2026-09-14, which was eight of the
 *     eighteen it was reporting fleet-wide.
 *
 * A repo whose listing cannot be read is NOT counted as clean. "I could not
 * look" must never render as "nothing is wrong" — the same rule the queue-health
 * and identity-model gates follow.
 *
 * A RUN WITH NO RECORD IS NOT NECESSARILY A LOST RUN
 * --------------------------------------------------
 * `ingestRuns` writes one record per JOB, and two kinds of completed run yield
 * none however perfectly it behaves:
 *
 *   - GitHub answers `/actions/runs/<id>/jobs` with an EMPTY array. Three
 *     hadoku-fleet-manager runs on 2026-09-10 and two hadoku-pygmalion runs on
 *     2026-09-02 are in this state, and always will be.
 *   - every job in the run has `runner_name: ""` — cancelled or failed before a
 *     runner ever picked it up. `ingestRuns` skips those on purpose ("a job with
 *     no runner or no timing is skipped, not guessed"), because a record with a
 *     guessed node is worse than no record.
 *
 * Counting those against the recorder was this gate reading ITS OWN absence of
 * evidence as evidence — the thing its `unreadable` check already refuses to do
 * one level up. Eight unrecordable runs out of ninety-nine is eight points of
 * coverage, which is the whole distance between this gate's floor and a page.
 *
 * So a run about to be reported as missing is LOOKED AT once, and only counted
 * if a record was actually possible. The cost is one call per MISS, not per run,
 * so a healthy fleet pays nothing. Both failure modes fall the pessimistic way:
 * a jobs call that errors counts as LOST, and so does every miss past
 * MAX_CLASSIFY. The cap can therefore never turn a real regression green — it
 * can only stop a catastrophic one from taking all night.
 *
 * @guards scripts/lib/paths.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { manifest as manifestFile, stateDir } from './lib/paths.mjs';
import { createEmitter } from './lib/emit.mjs';
import { readQueuedWithRetry } from './lib/queue-health.mjs';

const JSON_OUT = process.argv.includes('--json');
const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;

/** Ingest runs on a 10-minute tick; allow three before calling a run missing. */
const GRACE_MIN = 30;
/** Below this, the sample is not describing the fleet any more. */
const MIN_COVERAGE = 0.9;
/**
 * Judge only the last day.
 *
 * The window on disk spans days, so without this the gate would keep reporting
 * historical loss that has already been fixed — red for as long as the old runs
 * take to age out, which trains everyone to ignore it. What is worth alarming on
 * is whether the recorder is healthy NOW; a regression shows up within a day and
 * yesterday's debt ages out on its own.
 */
const LOOKBACK_H = 24;
/**
 * Repos below this many runs are reported but never FAIL on their own.
 *
 * A fleet-wide average is the wrong statistic and was very nearly the bug in
 * this gate: measured 2026-09-04 it read 96% overall while hadoku_site sat at
 * 85% and watchparty at 84%, because two dozen quiet repos diluted the two busy
 * ones. Loss concentrates in bursts, bursts happen in busy repos, so the average
 * hides precisely the case worth catching — this gate would have passed during
 * the 40% loss it exists to detect. Judged per repo instead, with a sample floor
 * so a repo that ran four jobs cannot trip it on one miss.
 */
const MIN_SAMPLE = 20;
/**
 * How many misses may be classified before the rest are simply counted as lost.
 *
 * One `gh api` call each. At the 2026-09-14 reading the 24h window held ZERO
 * misses fleet-wide, and the whole 14-day window held 18, so this is headroom
 * rather than a real ceiling. It exists so the 40%-loss case this gate was
 * written for — ~40 misses in a day on the busiest repo alone — cannot turn a
 * nightly cron into a hundreds-of-calls job against a 5,000/h budget.
 *
 * Past the cap, misses count as LOST. The cap can make the gate report more
 * loss than there is; it can never make it report less.
 */
const MAX_CLASSIFY = 60;

function fail(msg) {
	if (JSON_OUT) emitter.emit({ ok: false, error: msg });
	else console.error(`✗ ${msg}`);
	process.exit(1);
}

const LIST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1_000;

/** Synchronous sleep. The sweep is serial and sync; a promise cannot help here. */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One listing, unretried; throws on failure so the reason survives. */
function completedRunsOnce(repo) {
	const out = execFileSync(
		'gh',
		[
			'api',
			`repos/${repo}/actions/runs?per_page=100`,
			'-q',
			'.workflow_runs[] | select(.status=="completed") | "\\(.id)\\t\\(.updated_at)"',
		],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: LIST_TIMEOUT_MS }
	);
	return out
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			const [id, at] = l.split('\t');
			return { id: Number(id), at };
		})
		.filter((r) => Number.isFinite(r.id) && r.at);
}

/**
 * Completed runs for one repo: `{ ok: true, created }` or `{ ok: false, reason }`.
 *
 * RETRIED ONCE, WITH THE REASON KEPT. This was a bare `catch { return null }`,
 * the shape check-queue-health carried until 2026-09-07: one transient blip on
 * one repo failed the gate and the finding named the repo and nothing else. On
 * 2026-10-25 that reddened the morning digest — `could not list runs for 1
 * repo(s): WolffM/secretProject` at 13:20Z — and the same gate passed on all 26
 * repos when re-run, with no way to tell a blip from a lost grant afterwards.
 * Same helper and policy as queue-health (READ_ATTEMPTS): a repo that fails
 * every attempt is still unreadable and still fails.
 */
function completedRuns(repo) {
	return readQueuedWithRetry(repo, completedRunsOnce, {
		sleep: () => sleepSync(RETRY_DELAY_MS),
		timeoutMs: LIST_TIMEOUT_MS,
	});
}

/**
 * Could this run EVER have produced a job-history record?
 *
 * `false` only when the answer is a definite no — an empty jobs array, or no job
 * carrying a runner name and both timestamps, which are exactly the two skips
 * `ingestRuns` makes. Anything else, INCLUDING a call that fails, is `true`: a
 * run we could not look at must be counted against the recorder, never excused.
 */
function couldHaveBeenRecorded(repo, runId) {
	let jobs;
	try {
		const out = execFileSync(
			'gh',
			[
				'api',
				`repos/${repo}/actions/runs/${runId}/jobs`,
				'-q',
				'.jobs[] | "\\(.runner_name // "")\\t\\(.started_at // "")\\t\\(.completed_at // "")"',
			],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
		);
		jobs = out
			.split('\n')
			.map((l) => l.split('\t'))
			.filter((p) => p.length === 3);
	} catch {
		return true; // could not look — the pessimistic side
	}
	return jobs.some(([runner, started, completed]) => runner && started && completed);
}

let roster = [];
try {
	roster = JSON.parse(readFileSync(manifestFile('fleet-runner-coverage.json'), 'utf8')).repos ?? [];
} catch (err) {
	fail(`cannot read the coverage roster: ${err.message}`);
}
if (!roster.length) fail('the coverage roster lists no repos — refusing to report a clean fleet');

const historyPath = join(stateDir(), 'job-history.jsonl');
if (!existsSync(historyPath)) fail(`no job-history at ${historyPath} — nothing is being recorded`);

/** runId -> true, plus the oldest record we hold, per repo. */
const seen = new Set();
let oldest = Infinity;
for (const line of readFileSync(historyPath, 'utf8').split('\n')) {
	const t = line.trim();
	if (!t) continue;
	let r;
	try {
		r = JSON.parse(t);
	} catch {
		continue; // a torn final line costs one record, by design
	}
	if (typeof r.runId === 'number') seen.add(r.runId);
	const started = Date.parse(r.startedAt ?? '');
	if (Number.isFinite(started)) oldest = Math.min(oldest, started);
}
if (!seen.size) fail('job-history holds no run ids — the recorder is not running at all');

const cutoffNew = Date.now() - GRACE_MIN * 60_000;
const cutoffOld = Date.now() - LOOKBACK_H * 3600_000;
const rows = [];
let eligible = 0;
let recorded = 0;
const unreadable = [];

let unrecordable = 0;
let classified = 0;

for (const repo of roster) {
	const read = completedRuns(repo);
	if (!read.ok) {
		unreadable.push({ repo, reason: read.reason });
		continue;
	}
	const runs = read.created;
	let n = 0;
	let hit = 0;
	let skipped = 0;
	for (const r of runs) {
		const at = Date.parse(r.at);
		if (!Number.isFinite(at) || at > cutoffNew) continue; // too new to judge
		if (at < oldest) continue; // aged out of retention
		if (at < cutoffOld) continue; // older than the day being judged
		if (seen.has(r.id)) {
			n++;
			hit++;
			continue;
		}
		// A miss — but was a record ever POSSIBLE? Asked once per miss, and only
		// while the classify budget holds; past it the run counts as lost.
		if (classified < MAX_CLASSIFY) {
			classified++;
			if (!couldHaveBeenRecorded(repo, r.id)) {
				skipped++;
				unrecordable++;
				continue; // out of the numerator AND the denominator
			}
		}
		n++;
	}
	if (!n) continue;
	eligible += n;
	recorded += hit;
	rows.push({ repo, eligible: n, recorded: hit, coverage: hit / n, unrecordable: skipped });
}

if (unreadable.length) {
	fail(
		`could not list runs for ${unreadable.length} repo(s): ` +
			unreadable.map((u) => `${u.repo} — ${u.reason}`).join('; ') +
			'. ' +
			'Refusing to report coverage over a fleet only partly looked at.'
	);
}
if (!eligible) fail('no run was old enough to judge and young enough to still be retained');

const overall = recorded / eligible;
// PER REPO, not the average — see MIN_SAMPLE.
const worst = rows
	.filter((r) => r.coverage < MIN_COVERAGE && r.eligible >= MIN_SAMPLE)
	.sort((a, b) => a.coverage - b.coverage);
const ok = worst.length === 0;

if (JSON_OUT) {
	emitter.emit({ ok, overall, eligible, recorded, unrecordable, repos: rows });
	process.exit(ok ? 0 : 1);
}

/**
 * Said the same way in both verdicts, so a green reading is auditable too.
 *
 * On its own line: appended to the per-repo list it read as a property of the
 * LAST repo printed, and it is a fleet-wide count.
 */
const unrecordableNote = unrecordable
	? `\n  ${unrecordable} run(s) excluded fleet-wide as unrecordable — no jobs, or no job ` +
		`that reached a runner; there was never a record to lose.`
	: '';

if (!ok) {
	console.error(
		`✗ job-history is losing runs in ${worst.length} repo(s) ` +
			`(floor ${MIN_COVERAGE * 100}%, last ${LOOKBACK_H}h; fleet-wide ${(overall * 100).toFixed(0)}%):\n` +
			worst.map((r) => `    ${r.repo.padEnd(34)} ${r.recorded}/${r.eligible}`).join('\n') +
			unrecordableNote +
			'\n\n  Every per-node median, idle time and backstop threshold is computed over' +
			'\n  this sample, so a gap here is not a missing graph — it is every number' +
			'\n  being quietly wrong, and biased toward whatever the recorder drops.' +
			'\n  Start at ingestRuns in @wolffm/fleet-manager src/job-history.ts.'
	);
	process.exit(1);
}
const judged = rows.filter((r) => r.eligible >= MIN_SAMPLE).length;
log(
	`✓ job-history coverage ${(overall * 100).toFixed(0)}% over the last ${LOOKBACK_H}h — ` +
		`${recorded} of ${eligible} completed runs across ${rows.length} repo(s); ` +
		`${judged} with a judgeable sample, none under ${MIN_COVERAGE * 100}%` +
		unrecordableNote
);
