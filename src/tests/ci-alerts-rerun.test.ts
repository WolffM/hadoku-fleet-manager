/**
 * Two ways a target's real state stayed out of the state machine, both
 * through `runCiAlerts` end to end:
 *
 *   - fleet-manager#89: a re-run keeps its run id and its `created_at`, so a
 *     red run re-run green more than six hours after it was created is never on
 *     a listing page again. The red row is re-read by id.
 *   - fleet-manager#92: a cancelled run whose timeout lookup can never succeed
 *     (the App's 403 on check-run annotations) froze its target, and every
 *     failure behind it aged past the freshness gate unjudged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmpdir.js';

import { CANCEL_LOOKUP_GIVEUP_MS, runCiAlerts, stateKey } from '../ci-alerts.js';
import { readStates } from '../ci-alerts-state.js';
import { type CiRun, type CiState } from '../ci-alerts-decide.js';
import { type CiTickSummary } from '../ci-alerts-summary.js';
import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';
import { ghRun } from './helpers/ci-alerts-rig.js';

const TARGET = {
	owner: 'WolffM',
	repo: 'site',
	workflow: 'publish-logger.yml',
	label: 'site / publish-logger',
};

interface Tick {
	summary: CiTickSummary;
	posts: string[];
	warns: string[];
	state: CiState | undefined;
	calls: string[];
}

/** One tick against a temp host, with GitHub answered by `answer`. */
async function tick(prior: CiState | undefined, answer: (path: string) => unknown): Promise<Tick> {
	const manifests = tempDir('ci-alerts-rerun-manifests-');
	const stateDir = tempDir('ci-alerts-rerun-state-');
	const posts: string[] = [];
	const warns: string[] = [];
	const calls: string[] = [];
	__setHostForTesting({
		...testHost,
		manifestDir: manifests,
		stateDir,
		logger: { info: () => undefined, warn: (m: string) => warns.push(m), error: () => undefined },
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
			JSON.stringify({ targets: [TARGET] })
		);
		if (prior)
			writeFileSync(
				join(stateDir, 'ci-alert-state.json'),
				JSON.stringify({ [stateKey(TARGET)]: prior })
			);
		const ghGet = async <T>(path: string): Promise<T | null> => {
			calls.push(path);
			if (path === '') return await Promise.resolve({ default_branch: 'main' } as T);
			return await Promise.resolve(answer(path) as T | null);
		};
		const summary = await runCiAlerts('tok', ghGet);
		return { summary, posts, warns, state: readStates()[stateKey(TARGET)], calls };
	} finally {
		__setHostForTesting(testHost);
	}
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 60 * 60_000;

/** A run of the target's workflow, the shape `GET /actions/runs/:id` returns. */
function wfRun(id: number, conclusion: string, created: string, ended: string): CiRun {
	return ghRun(id, conclusion, created, ended, TARGET.workflow);
}

const RED_ROW = (runId: number, endedAt: string): CiState => ({
	lastConclusion: 'failure',
	lastRunId: runId,
	lastSeen: iso(10 * 60_000),
	lastAlertedRunId: runId,
	lastAlertedAt: endedAt,
	lastEndedAt: endedAt,
});

test('#89: a red run re-run green after it left the listing is re-read by id and recovers', async () => {
	// Created 14 h ago, attempt 1 failed 14 h ago, attempt 2 passed a minute ago:
	// below the six-hour floor, so no listing page carries it.
	const failedAt = iso(14 * HOUR);
	const t = await tick(RED_ROW(42932948593, failedAt), (path) => {
		if (path.startsWith('/actions/runs?')) return { workflow_runs: [] };
		if (path === '/actions/runs/42932948593')
			return wfRun(42932948593, 'success', iso(14 * HOUR + 240_000), iso(60_000));
		throw new Error(`unexpected path ${path}`);
	});
	// MUTATION: drop the re-read and the row stays red with nothing said.
	assert.equal(t.summary.recovered, 1, JSON.stringify(t.summary));
	assert.match(t.posts[0] ?? '', /CI recovered/);
	assert.equal(t.state?.lastConclusion, 'success');
});

test('#89: a re-run that went green days ago clears the stale red silently', async () => {
	// publish-logger exactly: attempt 2 passed 2026-11-11 13:53Z and the row was
	// still red on 11-14. It is history now, so no ✅, but the row stops lying.
	const t = await tick(RED_ROW(42932948593, iso(3 * 24 * HOUR)), (path) => {
		if (path.startsWith('/actions/runs?')) return { workflow_runs: [] };
		if (path === '/actions/runs/42932948593')
			return wfRun(42932948593, 'success', iso(3 * 24 * HOUR + 240_000), iso(2.5 * 24 * HOUR));
		throw new Error(`unexpected path ${path}`);
	});
	assert.deepEqual(t.posts, []);
	assert.equal(t.summary.suppressed, 1);
	assert.equal(t.state?.lastConclusion, 'success');
});

test('#89: a green row, or a red run still on the listing, costs no extra call', async () => {
	const onPage = wfRun(77, 'failure', iso(HOUR), iso(HOUR - 60_000));
	const red = await tick(RED_ROW(77, onPage.updated_at ?? ''), (path) => {
		if (path.startsWith('/actions/runs?')) return { workflow_runs: [onPage] };
		throw new Error(`unexpected path ${path}`);
	});
	assert.ok(!red.calls.some((c) => c.startsWith('/actions/runs/')), red.calls.join(' '));

	const green = await tick({ ...RED_ROW(78, iso(HOUR)), lastConclusion: 'success' }, (path) => {
		if (path.startsWith('/actions/runs?')) return { workflow_runs: [] };
		throw new Error(`unexpected path ${path}`);
	});
	assert.ok(!green.calls.some((c) => c.startsWith('/actions/runs/')), green.calls.join(' '));
});

test('#89: a re-read that fails is counted and named, and the target is still judged', async () => {
	const fresh = wfRun(90, 'failure', iso(5 * 60_000), iso(2 * 60_000));
	const t = await tick(RED_ROW(42, iso(2 * 24 * HOUR)), (path) => {
		if (path.startsWith('/actions/runs?')) return { workflow_runs: [fresh] };
		if (path === '/actions/runs/42') return null;
		throw new Error(`unexpected path ${path}`);
	});
	assert.equal(t.summary.rereadUnread, 1);
	assert.ok(t.warns.some((w) => /site \/ publish-logger: could not re-read red run 42/.test(w)));
	assert.equal(t.summary.evaluated, 1, 'the listing was still judged');
	assert.equal(t.state?.lastRunId, 90);
});

/** A cancel the annotations cannot classify, then a fresh failure behind it. */
function cancelThenFailure(cancelEndedMsAgo: number) {
	const cancelled = wfRun(500, 'cancelled', iso(cancelEndedMsAgo + 60_000), iso(cancelEndedMsAgo));
	const failed = wfRun(501, 'failure', iso(40_000), iso(20_000));
	return (path: string): unknown => {
		if (path.startsWith('/actions/runs?')) return { workflow_runs: [failed, cancelled] };
		if (path.startsWith('/actions/runs/500/jobs'))
			return { jobs: [{ id: 5000, conclusion: 'cancelled' }] };
		// The 403 "Resource not accessible by integration" ghGet turns into null.
		if (path === '/check-runs/5000/annotations') return null;
		throw new Error(`unexpected path ${path}`);
	};
}

const GREEN_ROW: CiState = {
	lastConclusion: 'success',
	lastRunId: 499,
	lastSeen: iso(10 * 60_000),
	lastEndedAt: iso(2 * HOUR),
};

test('#92: a fresh cancel whose lookup failed holds the target for the next tick, and says which', async () => {
	const t = await tick(GREEN_ROW, cancelThenFailure(60_000));
	assert.equal(t.summary.unreadable, 1);
	assert.equal(t.summary.broken, 0);
	assert.ok(
		t.warns.some((w) => /site \/ publish-logger: could not tell whether cancelled run 500/.test(w)),
		t.warns.join(' | ')
	);
	assert.equal(
		t.state?.lastEndedAt,
		GREEN_ROW.lastEndedAt,
		'the watermark stays before the cancel'
	);
});

test('#92: a cancel unreadable past the give-up is passed, and the failure behind it pages', async () => {
	// hadoku-crossposter/ci, 2026-11-12: a 06:45Z supersede-cancel, then failures
	// from 07:14Z, judged only at 22:12Z and suppressed as stale.
	const t = await tick(GREEN_ROW, cancelThenFailure(CANCEL_LOOKUP_GIVEUP_MS + 60_000));
	// MUTATION: keep holding (`break`) and broken is 0 on every tick until stale.
	assert.equal(t.summary.broken, 1, JSON.stringify(t.summary));
	assert.equal(t.summary.cancelUnjudged, 1);
	assert.equal(t.summary.unreadable, 0);
	assert.ok(
		t.warns.some((w) => /passing it as not-a-timeout/.test(w)),
		t.warns.join(' | ')
	);
	assert.equal(t.state?.lastRunId, 501);
});
