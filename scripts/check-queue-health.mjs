#!/usr/bin/env node
/**
 * check-queue-health — is the fleet actually SERVING work?
 *
 * THE ONE QUESTION NO OTHER GATE ASKS
 * -----------------------------------
 * Every gate this fleet owns checks a DECLARATION or a MECHANISM. `slice`
 * checks a ceiling matches the manifest. `label-floor` checks a label has an
 * offerer. `capabilities` checks a node can do what it claims. `reconcile`
 * checks registrations match desired state. All of them can be green while no
 * job is moving — and on 2026-09-01 all of them WERE: thirteen jobs sat queued
 * 11-19 minutes across nine repos while the full sweep passed and the census
 * read `claws_online=4`. Both numbers were true. Neither was the question.
 *
 * So this reads the only thing that cannot be green while CI is broken: the age
 * of what is waiting. It touches no census, no label state, no capacity count
 * and no manifest arithmetic — the manifest is read for one fact, which node is
 * the backstop (see isSaturated). If the fleet is serving work this passes, however
 * wrong every other number is; if it is not, this fails, however right they are.
 *
 * WHY IT GOES RED BEFORE THE ALERTER DOES
 * ---------------------------------------
 * `QUEUED_WARN_MINUTES` is 10, and the external alerter pages there. Ten minutes
 * is the right threshold for waking someone up and the wrong one for a gate: by
 * then the queue has already built. The fleet's MEASURED queue p95 is 161 s
 * (queue-discovery.ts), and the worst legitimate JIT serve is MIN_QUEUED_MS 90 s
 * plus a 60 s fast-loop tick plus a ~9 s mint, so ~160 s. FAIL_SECONDS is 300 — a
 * little under twice the measured p95, comfortably above a legitimate slow
 * serve, and half the alerter's threshold. A run older than that is not waiting
 * for capacity in any normal sense.
 *
 * STUCK IS NOT SLOW, AND COUNTING IT AS SLOW MAKES THIS GATE USELESS
 * -----------------------------------------------------------------
 * Two runs on this fleet have been queued since 2026-08-18 — a deleted branch,
 * a label nothing carries, a cancelled dependency. Nothing will ever pick them
 * up. Folding them into a p95 pins this gate red forever, and a gate that is
 * always red is one nobody reads, which is how the 2026-09-01 outage went ten
 * minutes without anyone looking at a sweep. They are reported SEPARATELY,
 * using the same one-hour boundary `MAX_QUEUED_MS` already draws for the
 * dispatcher, so the two agree on what "stuck" means.
 *
 * IT ALSO LISTS `pending`, WHICH THE DISPATCHER DOES NOT
 * ------------------------------------------------------
 * A run can wait for a runner while GitHub lists it `pending` rather than
 * `queued`, and then nothing mints for it (fleet-manager#6). Only this gate
 * reads that listing. It is one more call per repo per sweep, plus a jobs read
 * for each pending run past the floor; the dispatcher's cadence is untouched.
 * See summarisePending for how a run held by its concurrency group is told
 * apart.
 *
 * `--json` for the cron; stdout stays parseable and the exit code carries the
 * finding, per scripts/lib/json-contract.mjs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { manifest as manifestFile } from './lib/paths.mjs';
import {
	summariseQueue,
	summarisePending,
	queueFindings,
	readQueuedWithRetry,
	isSaturated,
	FAIL_SECONDS,
} from './lib/queue-health.mjs';
import { MAX_QUEUED_MS } from '../dist/runners/queue-discovery.js';
import { guestNodeNames } from '../dist/lib/node-role.js';
import { nodeOf } from '../dist/runners/census.js';
import { loadManifest } from './lib/fleet-exec.mjs';
import { createEmitter } from './lib/emit.mjs';

const JSON_OUT = process.argv.includes('--json');
// One stdout discipline, shared — see lib/emit.mjs. `emit` is the ONLY write
// to stdout below, which is what makes "print before the JSON" unreachable
// rather than merely absent.
const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;

const READ_TIMEOUT_MS = 20_000;
/** Long enough for a blip to pass, short enough to be invisible at a 0.13% rate. */
const RETRY_DELAY_MS = 1_000;

/** Synchronous sleep. The sweep is serial and sync; a promise cannot help here. */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One read, unretried. The retry and the diagnosis live in lib/queue-health. */
function readRunsOnce(repo, status) {
	const out = execFileSync(
		'gh',
		[
			'api',
			`repos/${repo}/actions/runs?status=${status}&per_page=100`,
			'-q',
			'.workflow_runs[] | "\\(.id) \\(.created_at)"',
		],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: READ_TIMEOUT_MS }
	);
	return out
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * One repo's runs in one status, `queued` or `pending`.
 *
 * `{ ok: false, reason }` = COULD NOT LOOK, which is never a pass.
 */
function runsIn(repo, status) {
	return readQueuedWithRetry(repo, (r) => readRunsOnce(r, status), {
		sleep: () => sleepSync(RETRY_DELAY_MS),
		timeoutMs: READ_TIMEOUT_MS,
	});
}

let roster = [];
try {
	roster = JSON.parse(readFileSync(manifestFile('fleet-runner-coverage.json'), 'utf8')).repos ?? [];
} catch (err) {
	// A roster we cannot read is not an empty fleet. Reported as a failure rather
	// than scanned as zero repos — "I could not look" must never render as
	// "nothing is wrong".
	const msg = `cannot read the coverage roster: ${err.message}`;
	if (JSON_OUT) emitter.emit({ ok: false, error: msg });
	else console.error(`✗ ${msg}`);
	process.exit(1);
}
if (!roster.length) {
	const msg = 'the coverage roster is EMPTY. A fleet of zero repos is not a pass.';
	if (JSON_OUT) emitter.emit({ ok: false, error: msg });
	else console.error(`✗ ${msg}`);
	process.exit(1);
}

/**
 * One jobs read per old run, for both questions asked of it: did GitHub ever
 * expand it into jobs (`jobless` — `true` only when the endpoint ANSWERED zero,
 * see summariseQueue's `unscheduled`), and what do its QUEUED jobs want
 * (`queuedJobs`, for isSaturated). `undefined` for either is "could not read",
 * and both callers treat that in the strict direction — fleet work, not
 * saturated. The same read answers `started` (no job queued, one past it) and
 * `queuedSince` (the earliest queued job's creation) — see summariseQueue.
 */
function readJobs(repo, id) {
	try {
		const out = execFileSync(
			'gh',
			[
				'api',
				`repos/${repo}/actions/runs/${id}/jobs?per_page=100`,
				'-q',
				'{total: .total_count, ' +
					'queued: [.jobs[] | select(.status == "queued") | {labels, created_at}], ' +
					'running: ([.jobs[] | select(.status == "in_progress" or .status == "completed")] | length)}',
			],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: READ_TIMEOUT_MS }
		);
		const doc = JSON.parse(out);
		const n = Number(doc.total);
		const queued = Array.isArray(doc.queued) ? doc.queued : undefined;
		const firstQueued = (queued ?? [])
			.map((j) => j.created_at)
			.filter((at) => Number.isFinite(Date.parse(at)))
			.sort()[0];
		return {
			jobless: Number.isFinite(n) ? n === 0 : undefined,
			queuedJobs: queued,
			started: queued !== undefined && queued.length === 0 && Number(doc.running) > 0,
			queuedSince: firstQueued,
		};
	} catch (err) {
		log(
			`  could not read jobs for ${repo} run ${id}: ${err.message.split('\n')[0]} — counted as fleet work`
		);
		return { jobless: undefined, queuedJobs: undefined, started: false, queuedSince: undefined };
	}
}

/** The repo's runner listing as GitHub reports it, once per repo per sweep;
 *  `undefined` when unreadable, which isSaturated reads as "not saturated". */
const runnersByRepo = new Map();
function repoRunners(repo) {
	if (runnersByRepo.has(repo)) return runnersByRepo.get(repo);
	let runners;
	try {
		const out = execFileSync(
			'gh',
			[
				'api',
				`repos/${repo}/actions/runners?per_page=100`,
				'-q',
				'[.runners[] | {name, status, busy, labels: [.labels[].name]}]',
			],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: READ_TIMEOUT_MS }
		);
		runners = JSON.parse(out);
	} catch (err) {
		log(
			`  could not read runners for ${repo}: ${err.message.split('\n')[0]} — not called saturated`
		);
		runners = undefined;
	}
	runnersByRepo.set(repo, runners);
	return runners;
}

/**
 * Which registrations belong to a BACKSTOP node — see isSaturated for why an
 * idle one does not break saturation. Read from the manifest's roles, the one
 * answer to "is this node a guest". A manifest that cannot be read exempts
 * NOTHING: the strict direction, in which an idle hokon still reads as a stall.
 */
let isBackstop = () => false;
try {
	const manifest = loadManifest();
	const machines = Object.keys(manifest.machines ?? {});
	const guests = guestNodeNames(manifest);
	isBackstop = (name) => guests.has(nodeOf(String(name ?? ''), machines));
} catch (err) {
	log(`  could not read the fleet manifest: ${err.message} — no runner is treated as a backstop`);
}

const runs = [];
const pendingRuns = [];
const unreadable = [];

for (const repo of roster) {
	const read = runsIn(repo, 'queued');
	if (!read.ok) {
		unreadable.push({ repo, reason: read.reason });
		continue;
	}
	for (const line of read.created) {
		const [id, createdAt] = line.split(' ');
		runs.push({ repo, id, createdAt });
	}
	const pending = runsIn(repo, 'pending');
	if (!pending.ok) {
		unreadable.push({ repo, reason: `pending listing: ${pending.reason}` });
	} else {
		for (const line of pending.created) {
			const [id, createdAt] = line.split(' ');
			pendingRuns.push({ repo, id, createdAt });
		}
	}
}

// Only a run old enough to move the verdict costs a jobs read: one call per
// run past the floor, none on a healthy fleet.
const sweptAt = Date.now();
for (const r of runs) {
	const ageSec = (sweptAt - Date.parse(r.createdAt)) / 1000;
	if (ageSec > FAIL_SECONDS) {
		const jobs = readJobs(r.repo, r.id);
		r.jobless = jobs.jobless;
		r.started = jobs.started;
		r.queuedSince = jobs.queuedSince;
		r.saturated = isSaturated(jobs.queuedJobs, repoRunners(r.repo), { isBackstop });
	}
}
// The same floor for pending runs: a run held by its concurrency group is
// usually well under it, so a healthy fleet pays nothing here either.
for (const r of pendingRuns) {
	if ((sweptAt - Date.parse(r.createdAt)) / 1000 > FAIL_SECONDS) {
		const jobs = readJobs(r.repo, r.id);
		r.jobless = jobs.jobless;
		r.started = jobs.started;
		r.queuedSince = jobs.queuedSince;
	}
}

// STAMPED AFTER THE SWEEP, not before it.
//
// The loop above is serial over the whole roster and each iteration shells out
// to `gh`, so it runs for seconds. A clock read BEFORE that is already stale by
// the time the last repo answers, and any run created while the sweep was in
// flight then has `createdAt` in the future — producing a NEGATIVE age, which
// is not a thing a queue can have. Observed 2026-09-07: `p50=-9s` against
// `oldest=15s`, the nine seconds being roughly how long the sweep had been
// running when that run was created.
//
// It was not merely cosmetic. A negative sorts to the front of the percentile
// array and drags p50 down, so the gate reported the queue as HEALTHIER than it
// was — the one direction an outage gate must never round.
//
// Reading the clock here instead makes every age "as of when I finished
// looking", which is both honest and never negative. It overstates by at most
// the sweep's own duration, seconds against a 300s threshold, and it overstates
// rather than understates — the safe direction for this gate.
const now = Date.now();

// The verdict is lib/queue-health.mjs's, so the rule that decides an outage is
// the one the tests beside it exercise — not a second copy living here.
const q = summariseQueue(runs, { stuckMs: MAX_QUEUED_MS, nowMs: now });
const { waiting, stuck, stranded, zombie, unscheduled, saturated, started } = q;
const { held, invisible } = summarisePending(pendingRuns, { nowMs: now });
const summary = {
	queued: q.queued,
	p50: q.p50,
	p95: q.p95,
	oldest: q.oldest,
	// `stuck` stays WHOLE and keeps its name: mgmt-api's queue-health-check reads
	// it, and renaming a field under the --json contract is a cross-repo change.
	// The split is additive beside it.
	stuck: stuck.length,
	stranded: stranded.length,
	zombie: zombie.length,
	unscheduled: unscheduled.length,
	saturated: saturated.length,
	started: started.length,
	held: held.length,
	invisible: invisible.length,
	unreadable: unreadable.length,
	failSeconds: FAIL_SECONDS,
};

log(`Queue health across ${roster.length} covered repo(s)`);
log(
	`  waiting=${summary.queued}  p50=${summary.p50}s  p95=${summary.p95}s  ` +
		`oldest=${summary.oldest}s  (fail above ${FAIL_SECONDS}s)`
);
if (stranded.length) {
	log(
		`  stranded=${stranded.length} (past the stuck ceiling but far too new to be zombies — ` +
			`the fleet stopped serving)`
	);
	for (const s of stranded.slice(0, 5)) {
		log(`    ${s.repo}  ${Math.round(s.ageSec / 60)}m`);
	}
}
if (zombie.length) {
	log(`  zombie=${zombie.length} (queued over a day — cannot be cancelled, cleared by hand)`);
	for (const s of zombie.slice(0, 5)) {
		log(`    ${s.repo}  ${Math.round(s.ageSec / 3600)}h`);
	}
	// SAY WHAT IS NOT SHOWN. The count above is honest, which is exactly what
	// makes a truncated list convincing: on 2026-09-07 the outage debris was
	// sized off these five lines and reported as four stranded runs when there
	// were six — the two that mattered were the ones past the cut. An
	// incompleteness that is invisible at the point of reading is the same defect
	// as an unreported failure.
	if (stuck.length > 5) {
		log(`    … and ${stuck.length - 5} more not shown — use --json for the full list`);
	}
}

if (unscheduled.length) {
	log(
		`  unscheduled=${unscheduled.length} (queued with ZERO jobs — GitHub never scheduled them; ` +
			`not fleet work, paged by runner-health)`
	);
	for (const s of unscheduled.slice(0, 5)) log(`    ${s.repo}  ${Math.round(s.ageSec / 60)}m`);
}

if (started.length) {
	log(
		`  started=${started.length} (listed queued, but every job is past queued and one has ` +
			'started — the run status lags its jobs; not waiting, not counted)'
	);
	for (const s of started.slice(0, 5)) log(`    ${s.repo}  ${s.ageSec}s`);
}
if (saturated.length) {
	log(
		`  saturated=${saturated.length} (every runner that could take them is busy — capacity, ` +
			`not a stall; out of the p95, and stranded like any other run past the stuck ceiling)`
	);
	for (const s of saturated.slice(0, 5)) log(`    ${s.repo}  ${s.ageSec}s`);
}

if (invisible.length) {
	log(
		`  invisible=${invisible.length} (listed pending with jobs waiting for a runner — ` +
			'the dispatcher lists only queued runs and will never mint for these)'
	);
	for (const s of invisible.slice(0, 5)) log(`    ${s.repo}  run ${s.id}  ${s.ageSec}s`);
}
if (held.length) {
	log(
		`  held=${held.length} (pending with no jobs — waiting on their own concurrency group, ` +
			'not on the fleet; not counted)'
	);
	for (const s of held.slice(0, 5)) log(`    ${s.repo}  ${s.ageSec}s`);
}

const findings = queueFindings({ ...q, invisible }, unreadable, FAIL_SECONDS);

if (JSON_OUT) {
	emitter.emit({
		ok: findings.length === 0,
		...summary,
		findings,
		waiting: waiting.slice(0, 20),
		// The stuck LIST, not just `summary.stuck`'s count. The human output
		// truncates at five and now says so, and it points here for the rest — a
		// pointer to a field that did not exist would be the same defect one
		// level down. Additive, so every existing consumer of this contract is
		// unaffected.
		stuckRuns: stuck.map((r) => ({ repo: r.repo, ageSec: r.ageSec })),
		// Additive: runs GitHub never expanded into jobs. Reported, never a finding.
		unscheduledRuns: unscheduled,
		saturatedRuns: saturated,
		startedRuns: started,
		// Additive (#6): pending runs past the floor, split by whether they have jobs.
		invisibleRuns: invisible,
		heldRuns: held,
		// NAMES ONLY, exactly as before. This field has been a string[] for every
		// consumer that has ever parsed it, and widening it to objects under the
		// --json contract would be a cross-repo change for a diagnostic. The
		// reasons go in `unreadableDetail` beside it, and into the findings text,
		// which is what actually reaches an operator.
		unreadable: unreadable.map((u) => u.repo),
		unreadableDetail: unreadable,
	});
} else if (findings.length) {
	console.error('');
	for (const f of findings) console.error(`✗ ${f}`);
	if (waiting.length) {
		console.error('\n  oldest waiting:');
		for (const w of waiting.slice(0, 8)) console.error(`    ${w.repo}  ${w.ageSec}s`);
	}
	console.error(
		'\n  This gate reads ONLY the age of queued work. Every capacity count, label\n' +
			'  and census can be green while it fails — on 2026-09-01 they all were.'
	);
} else {
	log(`\n✓ the fleet is serving work`);
}

process.exit(findings.length ? 1 : 0);
