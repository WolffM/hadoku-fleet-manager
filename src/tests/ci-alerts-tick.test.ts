/**
 * `runCiAlerts` end to end — what a tick counts when it cannot read a
 * target, the boot-pass skip, the `timeout-minutes` annotation check
 * (#124), and the one-listing-per-repo poll (#37) — split out of
 * `ci-alerts.test.ts` (wave 5r lane C) over `helpers/ci-alerts-rig.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmpdir.js';

import {
	runCiAlerts,
	REPO_PAGE_SIZE,
	EXTRA_PAGES_PER_TICK,
	MAX_LOOKBACK_MS,
	ciAlertsCallCeilingPerHour,
	pollRepo,
} from '../ci-alerts.js';
import {
	ciAlertsBootPassDue,
	lastCleanCiAlertsPassMs,
	CI_ALERTS_BOOT_SKIP_MS,
	CI_ALERTS_PASS_FILE,
	readRepoStates,
} from '../ci-alerts-state.js';
import { decideCiAlert, isForeignRun, type CiRun, type CiState } from '../ci-alerts-decide.js';
import { formatCiTickSummary, type CiTickSummary } from '../ci-alerts-summary.js';
import { __setHostForTesting, stateDir } from '../host.js';
import { testHost } from './install-test-host.js';
import {
	ghRun,
	listed,
	listingGh,
	NOW,
	run,
	SUPERSEDE_NOTES,
	TICK_MS,
	tickOnCancelled,
	TIMEOUT_NOTES,
	withTempHost,
} from './helpers/ci-alerts-rig.js';

test('a tick counts what it could not read, and does not call that health', async () => {
	// End to end through `runCiAlerts` with no announcement in it, deliberately:
	// this asserts on the accounting, and the alerter's real sink must not fire
	// from a test.
	const targets = [
		{ owner: 'WolffM', repo: 'unreachable', workflow: 'ci.yml', label: 'unreachable / ci' },
		{ owner: 'WolffM', repo: 'never-ran', workflow: 'ci.yml', label: 'never-ran / ci' },
		{ owner: 'WolffM', repo: 'quiet', workflow: 'ci.yml', label: 'quiet / ci' },
	];
	const lines: string[] = [];
	const summary: CiTickSummary = await withTempHost(async (manifests, log) => {
		writeFileSync(join(manifests, 'ci-watch.generated.json'), JSON.stringify({ targets }));
		const ghGet = async <T>(_p: string, _t: string, repo?: string): Promise<T | null> => {
			if (repo === 'WolffM/unreachable') return await Promise.resolve(null);
			const workflow_runs =
				repo === 'WolffM/never-ran'
					? []
					: [ghRun(1, 'success', '2026-09-19T10:00:00Z', '2026-09-19T10:05:00Z')];
			return await Promise.resolve({ workflow_runs } as T);
		};
		const s = await runCiAlerts('tok', ghGet);
		lines.push(...log.info, ...log.warn);
		return s;
	});

	assert.equal(summary.targets, 3);
	// Three targets, three different silences, three different counters. Before
	// 2026-09-19 all three produced the same output: none.
	assert.equal(summary.unreadable, 1, 'a target we could not read is a finding, not a pass');
	assert.equal(summary.noRuns, 1);
	assert.equal(summary.evaluated, 1);
	assert.equal(summary.broken + summary.recovered, 0, 'nothing may be announced by this test');

	// The tick WROTE the summary down, and at WARN, because it could not read one
	// of its three targets. An unreadable target is a finding.
	const summaryLines = lines.filter((l) => l.startsWith('[ci-alerts] polled '));
	assert.equal(summaryLines.length, 1, `exactly one summary per tick, got ${lines.join(' | ')}`);
	assert.equal(summaryLines[0], formatCiTickSummary(summary));
	assert.match(summaryLines[0], /polled 3 targets/);
	assert.match(summaryLines[0], /unreadable 1/);
});

test('a tick with an EMPTY watch list still reports, because it watched nothing', async () => {
	const warned: string[] = [];
	const summary = await withTempHost(async (manifests, log) => {
		writeFileSync(join(manifests, 'ci-watch.generated.json'), JSON.stringify({ targets: [] }));
		const ghGet = async <T>(): Promise<T | null> => await Promise.resolve(null);
		const s = await runCiAlerts('tok', ghGet);
		warned.push(...log.warn);
		// A watch list of zero is the shape of "resolution found nothing", and a
		// gate that reports a healthy fleet of zero machines is this repo's
		// oldest failure. It has to be loud.
		assert.equal(log.info.length, 0, 'an empty watch list is not an INFO');
		return s;
	});
	assert.equal(summary.targets, 0);
	assert.ok(
		warned.some((l) => l === formatCiTickSummary(summary)),
		`the empty tick must warn its summary, got ${warned.join(' | ')}`
	);
	assert.match(formatCiTickSummary(summary), /polled 0 targets/);
});

test('#124: a cancel the annotations call a TIMEOUT pages as broken, and the row stores timed_out', async () => {
	const { summary, posts, state } = await tickOnCancelled(TIMEOUT_NOTES);
	assert.equal(summary.broken, 1);
	assert.equal(posts.length, 1);
	assert.match(posts[0], /CI broken/);
	assert.match(posts[0], /timed_out/);
	assert.equal(Object.values(state)[0]?.lastConclusion, 'timed_out');
});

test('#124: a SUPERSEDED cancel is still inert — nothing paged, nothing stored', async () => {
	// MUTATION: treat every cancelled job as a timeout and this pages.
	const { summary, posts, state } = await tickOnCancelled(SUPERSEDE_NOTES);
	assert.equal(summary.broken, 0);
	assert.equal(summary.ignored, 1);
	assert.deepEqual(posts, []);
	assert.deepEqual(state, {}, 'first sighting of an inert run persists nothing');
});

test('#124: unreadable annotations are "could not look" — no page, no watermark past the run', async () => {
	const prior: CiState = {
		lastConclusion: 'success',
		lastRunId: 6,
		lastSeen: new Date(Date.now() - 5 * 60_000).toISOString(),
		lastEndedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
	};
	const { summary, posts, state } = await tickOnCancelled(null, prior);
	assert.equal(summary.unreadable, 1);
	assert.equal(summary.evaluated, 0);
	assert.deepEqual(posts, []);
	// The run stays past the watermark, so the next tick asks about it again.
	const row = Object.values(state)[0];
	assert.ok(row === undefined || row.lastEndedAt === prior.lastEndedAt);
});

test('#124: a timeout after green is a fresh break; the next green recovers from it', () => {
	const prev: CiState = {
		lastConclusion: 'timed_out',
		lastRunId: 7,
		lastSeen: new Date(NOW - 5 * 60_000).toISOString(),
		lastAlertedRunId: 7,
	};
	const d = decideCiAlert(prev, run('success', { id: 8 }), NOW);
	assert.equal(d.action, 'recovered');
});

// 2026-10-25: 12 boots in two hours, each running a full 75-target pass a few
// minutes after its predecessor's. A boot now skips its pass when a CLEAN one
// is recent — and only a clean one, since a blind pass proves nothing.
test('a boot right after a clean pass skips its own; after a blind one it does not', async () => {
	const targets = [
		{ owner: 'WolffM', repo: 'a', workflow: 'ci.yml', label: 'a / ci' },
		{ owner: 'WolffM', repo: 'b', workflow: 'ci.yml', label: 'b / ci' },
	];
	await withTempHost(async (manifests) => {
		writeFileSync(join(manifests, 'ci-watch.generated.json'), JSON.stringify({ targets }));
		assert.equal(ciAlertsBootPassDue(), true, 'no pass on record: the boot runs one');

		let blind = false;
		const ghGet = async <T>(_p: string, _t: string, repo?: string): Promise<T | null> => {
			if (blind && repo === 'WolffM/b') return await Promise.resolve(null);
			return await Promise.resolve({
				workflow_runs: [ghRun(1, 'success', '2026-09-19T10:00:00Z', '2026-09-19T10:05:00Z')],
			} as T);
		};
		await runCiAlerts('tok', ghGet);
		assert.equal(ciAlertsBootPassDue(), false, 'a clean pass just finished');
		const clean = lastCleanCiAlertsPassMs();
		assert.ok(clean !== null, 'the clean pass is on record');
		assert.equal(ciAlertsBootPassDue(clean + CI_ALERTS_BOOT_SKIP_MS), true, 'and it ages out');

		// A blind pass is not recorded, so it cannot extend the skip. Judged from
		// the RECORD, never from a second Date.now(): on a loaded runner the blind
		// pass alone took over a second and aged the clean one out (2026-10-31).
		blind = true;
		await runCiAlerts('tok', ghGet);
		assert.equal(
			lastCleanCiAlertsPassMs(),
			clean,
			'still anchored on the clean pass, not the blind one'
		);
		assert.equal(ciAlertsBootPassDue(clean + CI_ALERTS_BOOT_SKIP_MS - 1000), false);
	});
});

test('an unreadable pass record runs the boot pass, and says why', async () => {
	await withTempHost((_m, log) => {
		writeFileSync(join(stateDir(), CI_ALERTS_PASS_FILE), '{not json');
		assert.equal(ciAlertsBootPassDue(), true);
		assert.ok(log.warn.some((w) => w.includes('not parseable')));
		return Promise.resolve();
	});
});

/*
 * ---------------------------------------------------------------------------
 * ONE LISTING PER REPO (fleet-manager#37).
 *
 * The watch list went from 77 to 122 targets when every workflow had to be
 * classified, which took the per-workflow poll's ceiling from 462 to 732
 * charged calls an hour on a pool that ran dry the same day. The poll now reads
 * one repo listing and pages it down to a FLOOR — see REPO_PAGE_SIZE.
 * ---------------------------------------------------------------------------
 */

test('#37: a fork PR run is foreign, a same-repo run is not, and a missing head is kept', () => {
	const at = Date.now();
	assert.equal(
		isForeignRun(listed(1, { created: at, head: { full_name: 'x/r', fork: true } }), 'WolffM/r'),
		true
	);
	assert.equal(
		isForeignRun(listed(1, { created: at, head: { full_name: 'someone/r' } }), 'WolffM/r'),
		true
	);
	assert.equal(
		isForeignRun(listed(1, { created: at, head: { full_name: 'wolffm/R' } }), 'WolffM/r'),
		false
	);
	assert.equal(isForeignRun(listed(1, { created: at, head: null }), 'WolffM/r'), false);
});

test('#37: a failing fork PR run does not page; the same failure from the repo itself does', async () => {
	const target = { owner: 'WolffM', repo: 'r', workflow: 'ci.yml', label: 'r / ci' };
	const posts: string[] = [];
	const manifests = tempDir('ci-alerts-manifests-');
	const state = tempDir('ci-alerts-state-');
	__setHostForTesting({
		...testHost,
		manifestDir: manifests,
		stateDir: state,
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
		const now = Date.now();
		const runs = [listed(1, { created: now - 20 * 60_000, ended: now - 15 * 60_000 })];
		const gh = listingGh(() => runs);
		await runCiAlerts('tok', gh); // first sighting: green
		runs.push(
			listed(2, {
				created: now - 8 * 60_000,
				ended: now - 2 * 60_000,
				conclusion: 'failure',
				head: { full_name: 'stranger/r', fork: true },
			})
		);
		const s1 = await runCiAlerts('tok', gh);
		assert.equal(s1.foreign, 1, 'counted, so a public repo’s quiet is legible');
		assert.equal(s1.broken, 0);
		assert.deepEqual(posts, []);
		assert.match(formatCiTickSummary(s1), /fork-runs 1/);

		runs.push(listed(3, { created: now - 7 * 60_000, ended: now - 60_000, conclusion: 'failure' }));
		const s2 = await runCiAlerts('tok', gh);
		assert.equal(s2.broken, 1);
		assert.equal(posts.length, 1);
		assert.match(posts[0], /CI broken/);
	} finally {
		__setHostForTesting(testHost);
	}
});

test('#37: a cold start reads one page and vouches only for the lookback', async () => {
	const now = Date.now();
	const runs = Array.from({ length: 250 }, (_, i) => listed(i + 1, { created: now - i * 60_000 }));
	const calls: string[] = [];
	const pool = { extra: EXTRA_PAGES_PER_TICK };
	const r = await pollRepo(
		'WolffM/r',
		undefined,
		'tok',
		listingGh(() => runs, calls),
		pool,
		now
	);
	assert.equal(r.kind, 'ok');
	assert.equal(calls.length, 1);
	assert.equal(pool.extra, EXTRA_PAGES_PER_TICK);
	if (r.kind === 'ok') assert.equal(Date.parse(r.floor), now - MAX_LOOKBACK_MS);
});

test('#37: the next poll pages down to the floor, and an open run holds the floor at its creation', async () => {
	const now = Date.now();
	// 150 runs in the last 150 minutes; run 150 was created first and is open.
	const runs = Array.from({ length: 150 }, (_, i) =>
		listed(i + 1, {
			created: now - (i + 1) * 60_000,
			status: i === 149 ? 'in_progress' : 'completed',
		})
	);
	const calls: string[] = [];
	const pool = { extra: EXTRA_PAGES_PER_TICK };
	const prev = { floor: new Date(now - 140 * 60_000).toISOString() };
	const r = await pollRepo(
		'WolffM/r',
		prev,
		'tok',
		listingGh(() => runs, calls),
		pool,
		now
	);
	assert.equal(r.kind, 'ok');
	assert.equal(calls.length, 2, 'page 1 ends above the floor, so page 2 is read');
	assert.equal(pool.extra, EXTRA_PAGES_PER_TICK - 1);
	if (r.kind === 'ok') {
		assert.equal(r.runs.length, 150);
		assert.equal(Date.parse(r.floor), now - 150 * 60_000, 'the open run is the floor');
	}
});

test('#37: a run stuck open for days cannot drag the floor past the lookback', async () => {
	const now = Date.now();
	const runs = [
		listed(1, { created: now - 60_000 }),
		listed(2, { created: now - 9 * 86_400_000, status: 'queued' }),
	];
	const r = await pollRepo(
		'WolffM/r',
		{ floor: new Date(now - TICK_MS).toISOString() },
		'tok',
		listingGh(() => runs),
		{ extra: 0 },
		now
	);
	assert.equal(r.kind, 'ok');
	if (r.kind === 'ok') assert.equal(Date.parse(r.floor), now - MAX_LOOKBACK_MS);
});

test('#37: a window the page pool cannot reach the bottom of is unreadable, not a partial read', async () => {
	const now = Date.now();
	const runs = Array.from({ length: 300 }, (_, i) => listed(i + 1, { created: now - i * 1000 }));
	const prev = { floor: new Date(now - 3_600_000).toISOString() };
	const r = await pollRepo(
		'WolffM/r',
		prev,
		'tok',
		listingGh(() => runs),
		{ extra: 1 },
		now
	);
	assert.equal(r.kind, 'unreadable');
	if (r.kind === 'unreadable') assert.match(r.why, /pool is spent/);
});

test('#37: a run open at the last poll that fails deep in the listing still pages', async () => {
	// The reason the poll was per-workflow: on a busy repo, a run that concludes
	// during a tick can sit far down the created_at order by the next poll
	// (hadoku_site, 2026-10-31: as deep as 79). Here it sits at 151.
	const target = { owner: 'WolffM', repo: 'r', workflow: 'deploy.yml', label: 'r / deploy' };
	const posts: string[] = [];
	const manifests = tempDir('ci-alerts-manifests-');
	const state = tempDir('ci-alerts-state-');
	__setHostForTesting({
		...testHost,
		manifestDir: manifests,
		stateDir: state,
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
		const now = Date.now();
		const green = listed(1, {
			created: now - 40 * 60_000,
			ended: now - 35 * 60_000,
			workflow: 'deploy.yml',
		});
		const slow = listed(2, {
			created: now - 30 * 60_000,
			status: 'in_progress',
			workflow: 'deploy.yml',
		});
		let runs: CiRun[] = [green, slow];
		const gh = listingGh(() => runs);
		await runCiAlerts('tok', gh);
		assert.ok(readRepoStates()['WolffM/r'], 'the floor is on disk');
		// 150 other runs land on top of it, then it fails.
		const noise = Array.from({ length: 150 }, (_, i) =>
			listed(100 + i, { created: now - 20 * 60_000 + i * 1000, ended: now - 60_000 })
		);
		runs = [
			green,
			{
				...slow,
				status: 'completed',
				conclusion: 'failure',
				updated_at: new Date(now - 30_000).toISOString(),
			},
			...noise,
		];
		const s = await runCiAlerts('tok', gh);
		assert.equal(s.broken, 1, formatCiTickSummary(s));
		assert.equal(posts.length, 1);
		assert.ok(REPO_PAGE_SIZE < 152, 'the run really was past the first page');
	} finally {
		__setHostForTesting(testHost);
	}
});

test('#37: the listing ceiling at fleet size is at or below the per-workflow 462/hr it replaced', async () => {
	// The fleet on 2026-10-31: 122 targets across 34 repos. Worst case — every
	// repo's listing changed (no 304) and every repo needs extra pages — counted
	// by driving the real tick, not by restating the formula.
	const REPOS = 34;
	const TARGETS = 122;
	const targets = Array.from({ length: TARGETS }, (_, i) => ({
		owner: 'WolffM',
		repo: `r${i % REPOS}`,
		workflow: `w${i}.yml`,
		label: `r${i % REPOS} / w${i}`,
	}));
	const calls: string[] = [];
	await withTempHost(async (manifests) => {
		writeFileSync(join(manifests, 'ci-watch.generated.json'), JSON.stringify({ targets }));
		const now = Date.now();
		// Every repo has a floor an hour back and 1,000 runs since: as deep as
		// a listing goes.
		const floors = Object.fromEntries(
			Array.from({ length: REPOS }, (_, i) => [
				`WolffM/r${i}`,
				{ floor: new Date(now - 3_600_000).toISOString() },
			])
		);
		writeFileSync(join(stateDir(), 'ci-alert-repos.json'), JSON.stringify(floors));
		const runs = Array.from({ length: 1000 }, (_, i) => listed(i + 1, { created: now - i * 1000 }));
		await runCiAlerts(
			'tok',
			listingGh(() => runs, calls)
		);
	});
	const perTick = calls.length;
	const ticksPerHour = 3_600_000 / TICK_MS;
	assert.equal(
		perTick,
		REPOS + EXTRA_PAGES_PER_TICK,
		'one first page per repo plus the pool, no more'
	);
	assert.equal(perTick * ticksPerHour, ciAlertsCallCeilingPerHour(REPOS));
	assert.ok(
		perTick * ticksPerHour <= 77 * ticksPerHour,
		`${perTick * ticksPerHour}/hr must not exceed the 462/hr the 77-target per-workflow poll cost`
	);
	// For the record: per-workflow at today's list would have been 732/hr.
	assert.equal(TARGETS * ticksPerHour, 732);
});

// The 2026-11-05 18:53Z handover: instance a paged "CI broken — hadoku-cardtable
// / forge", was stopped before its pass reached the end-of-pass state write,
// and instance b's first pass paged it again. Pass 1 here pages, then never
// finishes (the second repo's listing never answers: the process that died).
// Pass 2 is the next process, reading the same state dir.
test('a page that went out is on disk before the pass ends, so the next process does not send it again', async () => {
	const targets = [
		{
			owner: 'WolffM',
			repo: 'hadoku-cardtable',
			workflow: 'forge.yml',
			label: 'hadoku-cardtable / forge',
		},
		{ owner: 'WolffM', repo: 'quiet', workflow: 'ci.yml', label: 'quiet / ci' },
	];
	const posts: string[] = [];
	const manifests = tempDir('ci-alerts-manifests-');
	const state = tempDir('ci-alerts-state-');
	__setHostForTesting({
		...testHost,
		manifestDir: manifests,
		stateDir: state,
		logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
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
		writeFileSync(join(manifests, 'ci-watch.generated.json'), JSON.stringify({ targets }));
		const ended = new Date(Date.now() - 60_000).toISOString();
		const failed = ghRun(9, 'failure', ended, ended, 'forge.yml');
		let reachedSecondRepo!: () => void;
		const atSecondRepo = new Promise<void>((r) => (reachedSecondRepo = r));
		const dying = async <T>(_p: string, _t: string, repo?: string): Promise<T | null> => {
			if (repo === 'WolffM/quiet') {
				reachedSecondRepo();
				return await new Promise<T | null>(() => undefined);
			}
			return await Promise.resolve({ workflow_runs: [failed] } as T);
		};
		void runCiAlerts('tok', dying);
		await atSecondRepo;
		assert.equal(posts.length, 1);
		assert.match(posts[0], /CI broken\*\* — hadoku-cardtable \/ forge/);

		const healthy = async <T>(_p: string, _t: string, repo?: string): Promise<T | null> =>
			await Promise.resolve({ workflow_runs: repo === 'WolffM/quiet' ? [] : [failed] } as T);
		await runCiAlerts('tok', healthy);
		assert.equal(posts.length, 1, 'the next process must not page the same run again');
	} finally {
		__setHostForTesting(testHost);
	}
});
