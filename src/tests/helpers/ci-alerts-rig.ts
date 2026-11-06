/**
 * Shared fixtures for `ci-alerts-*.test.ts` (wave 5r lane C): the run/state
 * factories, the real watch-list payloads (`WATCHPARTY`, the push storms),
 * the temp-host harness and the repo-listing fakes every split test file
 * drives `decideCiAlert` / `runCiAlerts` / `pollRepo` through. Split out of
 * `ci-alerts.test.ts` verbatim — no test body here, only the rig.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../tmpdir.js';

import { runCiAlerts, stateKey } from '../../ci-alerts.js';
import {
	decideCiAlert,
	runEndedAt,
	runsEndedSince,
	type CiAction,
	type CiDecision,
	type CiRun,
	type CiState,
} from '../../ci-alerts-decide.js';
import { type CiTickSummary } from '../../ci-alerts-summary.js';
import { __setHostForTesting } from '../../host.js';
import { testHost } from '../install-test-host.js';

export const NOW = Date.parse('2026-09-08T12:00:00.000Z');

export function run(conclusion: string | null, over: Partial<CiRun> = {}): CiRun {
	return {
		id: 42,
		conclusion,
		status: 'completed',
		html_url: 'https://github.com/WolffM/hadoku-fleet-manager/actions/runs/42',
		created_at: new Date(NOW - 60_000).toISOString(), // a minute old: fresh
		...over,
	};
}

export function state(over: Partial<CiState> = {}): CiState {
	return {
		lastConclusion: 'success',
		lastRunId: 41,
		lastSeen: new Date(NOW - 60_000).toISOString(),
		...over,
	};
}

/** A run exactly as the API returns it: queued at `created`, concluded at `ended`. */
export function ghRun(
	id: number,
	conclusion: string | null,
	created: string,
	ended: string,
	workflow = 'ci.yml'
): CiRun {
	return {
		id,
		conclusion,
		status: 'completed',
		path: `.github/workflows/${workflow}`,
		html_url: `https://github.com/WolffM/x/actions/runs/${id}`,
		created_at: created,
		updated_at: ended,
	};
}

/**
 * Replays a real run sequence the way the 10-minute poller meets it: each run
 * becomes the latest completed run shortly after it concludes, and the ticks in
 * between see nothing new and only refresh `lastSeen` (folded in, rather than
 * looped, so the fixtures stay the runs and not the clock).
 */
export function poll(runs: CiRun[], start: CiState | null = null) {
	let state = start;
	const decisions: CiDecision[] = [];
	for (const r of runs) {
		const at = Date.parse(r.updated_at ?? r.created_at) + 5 * 60_000;
		const prev = state ? { ...state, lastSeen: new Date(at - 10 * 60_000).toISOString() } : null;
		const d = decideCiAlert(prev, r, at);
		decisions.push(d);
		if (d.next) state = d.next;
	}
	return { decisions, actions: decisions.map((d) => d.action), state };
}

/** The tick, as `runCiAlerts` runs it: no GitHub, no disk, no Discord. */
export function pollTicks(all: CiRun[], tickTimes: number[], start: CiState | null = null) {
	let row = start;
	const seen: Array<{ at: number; id: number; action: CiAction; reason?: string }> = [];
	for (const at of tickTimes) {
		// What the repo listing yields for this workflow: completed runs, newest
		// `created_at` first — that ordering is the whole trap — down to the
		// floor, which `pollRepo` guarantees reaches every run that concluded
		// since the last poll (fleet-manager#37; the floor's own tests are below).
		const page = all
			.filter((r) => runEndedAt(r) <= at)
			.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
		if (!page.length) continue;
		const fresh = runsEndedSince(page, row);
		if (!fresh.length) continue;
		let watermark = row?.lastEndedAt ? Date.parse(row.lastEndedAt) : 0;
		for (const r of fresh) {
			const d = decideCiAlert(row, r, at);
			seen.push({ at, id: r.id, action: d.action, reason: d.reason });
			if (d.next) row = d.next;
			watermark = Math.max(watermark, runEndedAt(r));
		}
		if (row) row = { ...row, lastEndedAt: new Date(watermark).toISOString() };
	}
	return { seen, actions: seen.map((s) => s.action), state: row };
}

/** hadoku-watchparty / ci, exactly as the API records it. */
export const WATCHPARTY = [
	ghRun(34898026676, 'cancelled', '2026-09-14T21:18:09Z', '2026-09-14T21:18:29Z'),
	ghRun(34898057754, 'success', '2026-09-14T21:18:27Z', '2026-09-14T21:20:17Z'),
	// The lint job. Nobody was told.
	ghRun(35021074573, 'failure', '2026-09-15T20:40:27Z', '2026-09-15T20:41:57Z'),
	// Pushed 2m53s later; GREEN 3m58s after the failure concluded, and created
	// AFTER it — so from this moment on it is what `per_page=1` returns.
	ghRun(35021360153, 'success', '2026-09-15T20:43:20Z', '2026-09-15T20:45:55Z'),
	ghRun(35023767551, 'success', '2026-09-15T21:07:32Z', '2026-09-15T21:09:38Z'),
];

/**
 * The real ticks. mgmt-api's runner-health summary lands at the END of a tick
 * and `runCiAlerts` is fired at its start, ~13s earlier (measured from the
 * 21:52:25 "monitor started" / 21:52:38 summary pair in the same log), so these
 * are the summary stamps minus 13s — the EARLIEST the poll can have happened.
 * The adversarial choice: at 20:45:58 the green run has been complete for three
 * seconds, so `per_page=1` is already answering with it.
 */
export const TICKS = [
	Date.parse('2026-09-15T20:35:56Z'),
	Date.parse('2026-09-15T20:45:58Z'),
	Date.parse('2026-09-15T20:55:57Z'),
];

/** State as the poller held it at the 20:36 tick: green since 09-14. */
export const BEFORE: CiState = {
	lastConclusion: 'success',
	lastRunId: 34898057754,
	lastSeen: '2026-09-15T20:25:55.000Z',
	lastAlertedRunId: 34683448906,
	lastEndedAt: '2026-09-14T21:20:17.000Z',
};

/**
 * A host whose manifests and state live in throwaway directories, and whose
 * logger keeps what it was told. The log is the deliverable here — a summary
 * that is computed and not written down is the same silence in a new place — so
 * the tests below read it rather than the return value alone.
 */
export async function withTempHost<T>(
	fn: (manifests: string, log: { info: string[]; warn: string[] }) => Promise<T>
): Promise<T> {
	const manifests = tempDir('ci-alerts-manifests-');
	const state = tempDir('ci-alerts-state-');
	const log = { info: [] as string[], warn: [] as string[] };
	__setHostForTesting({
		...testHost,
		manifestDir: manifests,
		stateDir: state,
		logger: {
			info: (m: string) => log.info.push(m),
			warn: (m: string) => log.warn.push(m),
			error: () => undefined,
		},
	});
	try {
		return await fn(manifests, log);
	} finally {
		__setHostForTesting(testHost);
	}
}

/**
 * #124: a `timeout-minutes` expiry concludes as `cancelled`, the same word a
 * concurrency supersede gets. The annotations below are the real ones, read
 * from hadoku-promptsmith run 39336748764 (timeout) and hadoku-fleet-manager
 * run 39517025915 (supersede) on 2026-10-20.
 */
export const TIMEOUT_NOTES = [
	{ message: 'The job has exceeded the maximum execution time of 10m0s' },
	{ message: 'The operation was canceled.' },
];
export const SUPERSEDE_NOTES = [
	{ message: 'Canceling since a higher priority waiting request for ci-refs/heads/main exists' },
	{ message: 'The operation was canceled.' },
];

export async function tickOnCancelled(
	notes: { message: string }[] | null,
	prior?: CiState
): Promise<{ summary: CiTickSummary; posts: string[]; state: Record<string, CiState> }> {
	const target = {
		owner: 'WolffM',
		repo: 'promptsmith',
		workflow: 'ci.yml',
		label: 'promptsmith / ci',
	};
	const posts: string[] = [];
	const manifests = tempDir('ci-alerts-manifests-');
	const stateDir = tempDir('ci-alerts-state-');
	__setHostForTesting({
		...testHost,
		manifestDir: manifests,
		stateDir,
		alerts: {
			post: () => {
				throw new Error('ci-alerts must not page Discord — CI outcomes are booked quietly');
			},
			recordQuietly: (content: string) => {
				posts.push(content);
			},
		},
	});
	try {
		writeFileSync(
			join(manifests, 'ci-watch.generated.json'),
			JSON.stringify({ targets: [target] })
		);
		if (prior)
			writeFileSync(
				join(stateDir, 'ci-alert-state.json'),
				JSON.stringify({ [stateKey(target)]: prior })
			);
		const ended = new Date(Date.now() - 60_000).toISOString();
		const ghGet = async <T>(path: string): Promise<T | null> => {
			if (path.startsWith('/actions/runs?'))
				return await Promise.resolve({
					workflow_runs: [ghRun(7, 'cancelled', ended, ended)],
				} as T);
			if (path.startsWith('/actions/runs/7/jobs'))
				return await Promise.resolve({
					jobs: [
						{ id: 70, conclusion: 'success' },
						{ id: 71, conclusion: 'cancelled' },
					],
				} as T);
			if (path === '/check-runs/71/annotations') return await Promise.resolve(notes as T);
			throw new Error(`unexpected path ${path}`);
		};
		const summary = await runCiAlerts('tok', ghGet);
		const file = join(stateDir, 'ci-alert-state.json');
		const state = existsSync(file)
			? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, CiState>)
			: {};
		return { summary, posts, state };
	} finally {
		__setHostForTesting(testHost);
	}
}

export const TICK_MS = 10 * 60_000;

/** A run as the repo listing returns it, with its status and source repo. */
export function listed(
	id: number,
	opts: {
		created: number;
		ended?: number;
		conclusion?: string | null;
		status?: string;
		workflow?: string;
		head?: { full_name?: string; fork?: boolean } | null;
	}
): CiRun {
	const created = new Date(opts.created).toISOString();
	return {
		...ghRun(
			id,
			opts.conclusion ?? 'success',
			created,
			new Date(opts.ended ?? opts.created).toISOString(),
			opts.workflow
		),
		status: opts.status ?? 'completed',
		head_repository: opts.head === undefined ? { full_name: 'WolffM/r', fork: false } : opts.head,
	};
}

/** A fake GitHub serving `all()` for one repo, newest created first, paged. */
export function listingGh(all: () => CiRun[], calls: string[] = []) {
	return async <T>(path: string): Promise<T | null> => {
		calls.push(path);
		const m = /^\/actions\/runs\?per_page=(\d+)&page=(\d+)/.exec(path);
		if (!m) throw new Error(`unexpected path ${path}`);
		const [size, page] = [Number(m[1]), Number(m[2])];
		const sorted = [...all()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
		return await Promise.resolve({
			workflow_runs: sorted.slice((page - 1) * size, page * size),
		} as T);
	};
}
