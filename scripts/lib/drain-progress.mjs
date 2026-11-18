/**
 * THE REFRESH CYCLE'S DRAIN WAIT, ON SIGNALS (fleet-manager#114).
 *
 * `waitUntilDrained` (drain-wait.mjs) gives up after a fixed 45 minutes. A
 * Forge e2e shard runs 50-80 min (p90 65, max 80 over 2,030 jobs), so on
 * 2026-11-18 claw-9 sat drained for 45 min under two healthy shards, went back
 * un-refreshed and paged. The wall clock measured nothing about those jobs.
 *
 * This wait ends on what the jobs themselves say:
 *   - QUIET: the node's counted Runner.Worker processes reach 0 and stay 0
 *     past SETTLE_MS (drain-wait.mjs: the fast loop's label strip lands on its
 *     next tick, so one zero between jobs is not quiet). The node is refreshed
 *     at once.
 *   - STUCK, a finding: a running job that has not finished a step for longer
 *     than its own allowance (`stepAllowance`, the rule runner-health pages a
 *     hung job on), or a count or a job's progress that could not be read
 *     UNREADABLE_READS times running. Never because N minutes passed.
 *   - THE RUN'S BUDGET: the caller's `deadline` (converge-toolchain's
 *     `--budget-min`), so the cron's own ceiling ends the wait and says that
 *     is why. No deadline, no clock: the wait runs on signals alone.
 *
 * WHICH JOB a worker runs is read from the worker, not from the runner's name:
 * the name carries the job it was MINTED for, and GitHub hands a JIT runner
 * any job its labels cover (measured 11-18: three claws' runners all named
 * j135031304064, the claw-4 worker's log said check_run_id 135031304097).
 * The worker's own `_diag/Worker_*.log` carries the real `check_run_id`, and
 * `.runner` the repo, as node-probe.ts already reads it.
 *
 * GITHUB COST: one `GET /repos/{repo}/actions/jobs/{id}` per running job per
 * PROGRESS_POLL_MS, and only while the cycle waits on ONE node (it drains one
 * at a time). A claw runs at most 4 jobs: 4 x 30/h = 120 calls/h ceiling,
 * against 5,000/h, for the length of one wait.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../../dist/lib/fleet-paths.js';
import { STUCK_MINUTES, stepAllowance } from '../../dist/runner-health-step-allowance.js';
import { POLL_MS, SETTLE_MS } from './drain-wait.mjs';
import { runOnSync } from './fleet-exec.mjs';

/** How often a running job's steps are re-read from GitHub. A sampling rate, not a limit. */
export const PROGRESS_POLL_MS = 120_000;
/** Consecutive failed reads of one thing before "could not look" is the finding. */
export const UNREADABLE_READS = 2;

/**
 * The one "is this directory a runner install?" rule (lib/runner-install.sh).
 * This package's own suite starts fake workers in a temp dir while it runs as
 * a CI job on a claw; without the rule a refresh would wait on, and call
 * stuck, a fixture with no job.
 */
const RUNNER_INSTALL_RULE = readFileSync(new URL('./runner-install.sh', import.meta.url), 'utf8');

/**
 * One `W <repo> <job id>` line per running worker (`-` for a half it could not
 * read), then `END`. The marker is what tells "read, and nothing runs" from a
 * read that died part way: no `END`, no answer.
 */
export const WORKER_JOBS_SCRIPT =
	`${RUNNER_INSTALL_RULE}\n` +
	'pgrep -ax Runner.Worker 2>/dev/null | grep " spawnclient " | while read -r _ c _; do ' +
	'd=${c%/bin*/Runner.Worker}; runner_install_dir "$d" || continue; ' +
	'u=$(sed -n \'s#.*"[gG]itHubUrl"[^"]*"https://github.com/\\([^"]*\\)".*#\\1#p\' "$d/.runner" 2>/dev/null); ' +
	'f=$(ls -t "$d"/_diag/Worker_*.log 2>/dev/null | head -1); j=; ' +
	'[ -n "$f" ] && j=$(grep -A1 \'"k": "check_run_id"\' "$f" | sed -n \'s/.*"v": *\\([0-9][0-9]*\\).*/\\1/p\' | head -1); ' +
	'printf "W %s %s\\n" "${u:--}" "${j:--}"; done; echo END';

/** The script's output as `[{ repo, jobId }]`, a half it could not read as null; null when it did not finish. */
export function parseWorkerJobs(out) {
	const lines = String(out ?? '')
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.at(-1) !== 'END') return null;
	const jobs = [];
	for (const l of lines.slice(0, -1)) {
		const m = /^W (\S+) (\S+)$/.exec(l);
		if (!m) return null;
		jobs.push({
			repo: m[1] === '-' ? null : m[1],
			jobId: /^\d+$/.test(m[2]) ? Number(m[2]) : null,
		});
	}
	return jobs;
}

/** The jobs running on `node` now, read as the CI role (claw-1..3 mount /proc hidepid). */
export function readWorkerJobs(node) {
	const res = runOnSync(node, WORKER_JOBS_SCRIPT, {
		as: 'ci',
		timeoutMs: 20_000,
		connectTimeout: 6,
	});
	return res.ok ? parseWorkerJobs(res.out) : null;
}

/** `{ status, name, done, step }` for one job as GitHub reports it now, or null. */
export function readJobProgress(repo, jobId) {
	let doc;
	try {
		doc = JSON.parse(
			execFileSync('gh', ['api', `repos/${repo}/actions/jobs/${jobId}`], {
				encoding: 'utf8',
				timeout: 20_000,
				stdio: ['ignore', 'pipe', 'pipe'],
			})
		);
	} catch {
		// The caller counts consecutive nulls; one blip is not a finding.
		return null;
	}
	const steps = Array.isArray(doc?.steps) ? doc.steps : null;
	if (!steps || typeof doc.status !== 'string') return null;
	return {
		status: doc.status,
		name: typeof doc.name === 'string' ? doc.name : '',
		done: steps.filter((s) => s.conclusion).length,
		step: steps.find((s) => !s.conclusion)?.name ?? '(no step reported)',
	};
}

/**
 * The job-history window, read from its file. NOT through job-history-store:
 * that store reports through the mgmt-api host, which a CLI process has not
 * installed, and it threw here on the first live read (11-18). Unreadable reads
 * as no history, so every job gets the floor, which is the LOUDER answer.
 */
export function readJobHistory(path = join(stateDir(), 'job-history.jsonl')) {
	let raw;
	try {
		raw = readFileSync(path, 'utf8');
	} catch {
		return [];
	}
	const out = [];
	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// A torn last line from a concurrent append: the rest still counts.
		}
	}
	return out;
}

let history = null;
/** Minutes this job may go without finishing a step: its own green history, floored. */
export function liveAllowance(repo, name) {
	history ??= readJobHistory();
	return stepAllowance(repo, name, STUCK_MINUTES, history);
}

/**
 * Wait for `node` to go quiet, on signals. See the header for the three ways
 * it ends. Returns `{ drained: true }`, or `{ drained: false, running, reason }`
 * plus `budget: true` when the caller's deadline ended it, or `stuck: true`
 * when a signal said stuck or unreadable.
 */
export async function waitUntilQuiet({
	node,
	clock,
	deadline = null,
	readWorkers = readWorkerJobs,
	readJob = readJobProgress,
	allowance = liveAllowance,
	pollMs = POLL_MS,
	progressPollMs = PROGRESS_POLL_MS,
	settleMs = SETTLE_MS,
}) {
	let quietSince = null;
	let unreadableCounts = 0;
	/** jobKey -> { done, since, misses, lastRead } */
	const progress = new Map();
	for (;;) {
		const jobs = await readWorkers(node);
		if (jobs === null) {
			if (++unreadableCounts >= UNREADABLE_READS)
				return {
					drained: false,
					running: null,
					stuck: true,
					reason: `could not count running jobs on ${node} (${unreadableCounts} reads in a row)`,
				};
		} else {
			unreadableCounts = 0;
			if (jobs.length === 0) {
				quietSince ??= clock.now();
				if (clock.now() - quietSince >= settleMs) return { drained: true };
			} else {
				quietSince = null;
				const stuck = await judgeJobs(jobs, progress, {
					clock,
					readJob,
					allowance,
					progressPollMs,
				});
				if (stuck) return { drained: false, running: jobs.length, stuck: true, reason: stuck };
			}
		}
		if (deadline !== null && clock.now() >= deadline) {
			const n = jobs?.length ?? null;
			return {
				drained: false,
				running: n,
				budget: true,
				reason:
					`the run's time budget ended while ${n ?? 'an uncounted number of'} job(s) ` +
					'were still running and advancing',
			};
		}
		await clock.sleep(pollMs);
	}
}

/** The first stuck or unreadable job among `jobs`, as a reason; null when every one is advancing. */
async function judgeJobs(jobs, progress, { clock, readJob, allowance, progressPollMs }) {
	const now = clock.now();
	const live = new Set();
	for (const { repo, jobId } of jobs) {
		if (repo === null || jobId === null) {
			// A worker whose job cannot be named cannot show progress. Its log is
			// written as it starts, so one miss is a race; two is the finding.
			const key = `unnamed:${live.size}`;
			live.add(key);
			const p = progress.get(key) ?? { misses: 0, lastRead: -Infinity };
			if (now - p.lastRead >= progressPollMs) {
				p.misses++;
				p.lastRead = now;
			}
			progress.set(key, p);
			if (p.misses >= UNREADABLE_READS)
				return `a running job's ${repo === null ? 'repo' : 'job id'} could not be read from its worker, so its progress cannot be judged`;
			continue;
		}
		const key = `${repo}#${jobId}`;
		live.add(key);
		const p = progress.get(key);
		if (p && now - p.lastRead < progressPollMs) continue;
		const r = await readJob(repo, jobId);
		if (r === null) {
			const misses = (p?.misses ?? 0) + 1;
			progress.set(key, { ...(p ?? { done: -1, since: now }), misses, lastRead: now });
			if (misses >= UNREADABLE_READS)
				return `could not read the progress of ${repo} job ${jobId} (${misses} reads in a row)`;
			continue;
		}
		// Finished on GitHub's side: its worker is on its way out.
		if (r.status === 'completed') {
			progress.set(key, { done: r.done, since: now, misses: 0, lastRead: now });
			continue;
		}
		const since = !p || p.done !== r.done ? now : p.since;
		progress.set(key, { done: r.done, since, misses: 0, lastRead: now });
		const stuckMin = (now - since) / 60000;
		const allow = allowance(repo, r.name);
		if (stuckMin > allow.minutes) {
			const basis = allow.samples
				? `the longest of its ${allow.samples} green runs was ${Math.round(allow.minutes)}m`
				: `>${Math.round(allow.minutes)}m`;
			return (
				`${repo} job ${jobId} (${r.name}) has not finished a step in ${Math.round(stuckMin)}m ` +
				`(${basis}); stuck on \`${r.step}\``
			);
		}
	}
	for (const k of progress.keys()) if (!live.has(k)) progress.delete(k);
	return null;
}
