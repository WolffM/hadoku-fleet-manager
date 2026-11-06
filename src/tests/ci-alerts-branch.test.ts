/**
 * fleet-manager#61 — a target judges only runs on its repo's default branch.
 *
 * hadoku-cardtable dispatches Forge on `verify/*` branches as a red/green lane
 * for mutation proofs; the `verify/*-red` runs are meant to fail. Judged as CI,
 * each one booked a break and the next verify-green run a recovery — 26 of 41
 * "CI broken — hadoku-cardtable / forge" in 48h had nothing else behind them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCiAlerts } from '../ci-alerts.js';
import { isOffDefaultBranch, type CiRun } from '../ci-alerts-decide.js';
import { __setHostForTesting, stateDir } from '../host.js';
import { testHost } from './install-test-host.js';
import { ghRun, withTempHost } from './helpers/ci-alerts-rig.js';

const TARGET = {
	owner: 'WolffM',
	repo: 'cardtable',
	workflow: 'forge.yml',
	label: 'cardtable / forge',
};

const onBranch = (r: CiRun, head_branch: string): CiRun => ({ ...r, head_branch });

test('isOffDefaultBranch: only a run named on ANOTHER branch is off it', () => {
	const r = ghRun(1, 'failure', '2026-11-06T00:00:00Z', '2026-11-06T00:05:00Z', 'forge.yml');
	assert.equal(isOffDefaultBranch(onBranch(r, 'verify/w59-red'), 'main'), true);
	assert.equal(isOffDefaultBranch(onBranch(r, 'main'), 'main'), false);
	// A default this pass could not read keeps every run: never quiet on a guess.
	assert.equal(isOffDefaultBranch(onBranch(r, 'verify/w59-red'), null), false);
	// A run with no branch named is kept, the same direction as isForeignRun.
	assert.equal(isOffDefaultBranch(r, 'main'), false);
});

/** One tick over `runs`, answering the repo read with `repoAnswer`. */
async function tick(runs: CiRun[], repoAnswer: () => unknown) {
	const booked: string[] = [];
	const calls: string[] = [];
	const out = await withTempHost(async (manifests, log) => {
		writeFileSync(
			join(manifests, 'ci-watch.generated.json'),
			JSON.stringify({ targets: [TARGET] })
		);
		__setHostForTesting({
			...testHost,
			manifestDir: manifests,
			stateDir: stateDir(),
			logger: {
				info: (m: string) => log.info.push(m),
				warn: (m: string) => log.warn.push(m),
				error: () => undefined,
			},
			alerts: {
				post: () => {
					throw new Error('ci-alerts must not page Discord');
				},
				recordQuietly: (content: string) => {
					booked.push(content);
				},
			},
		});
		const ghGet = async <T>(path: string): Promise<T | null> => {
			calls.push(path);
			if (path === '') return await Promise.resolve(repoAnswer() as T);
			if (path.startsWith('/actions/runs?'))
				return await Promise.resolve({ workflow_runs: runs } as T);
			throw new Error(`unexpected path ${path}`);
		};
		const summary = await runCiAlerts('tok', ghGet);
		return { summary, warn: [...log.warn] };
	});
	return { ...out, booked, calls };
}

const minAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

test('a verify/* red run books nothing; the same red on main books a break', async () => {
	const red = ghRun(11, 'failure', minAgo(9), minAgo(2), 'forge.yml');

	const off = await tick([onBranch(red, 'verify/w59-red')], () => ({ default_branch: 'main' }));
	assert.equal(off.summary.offBranch, 1);
	assert.equal(off.summary.evaluated, 0);
	assert.equal(off.booked.length, 0, `nothing booked, got ${off.booked.join(' | ')}`);

	const on = await tick([onBranch(red, 'main')], () => ({ default_branch: 'main' }));
	assert.equal(on.summary.offBranch, 0);
	assert.equal(on.summary.evaluated, 1);
	assert.equal(on.summary.broken, 1);
	assert.match(on.booked[0], /CI broken/);
});

test('a default branch that cannot be read judges every branch, and says so at WARN', async () => {
	const red = ghRun(12, 'failure', minAgo(9), minAgo(2), 'forge.yml');
	const r = await tick([onBranch(red, 'verify/w59-red')], () => null);
	assert.equal(r.summary.branchUnread, 1);
	assert.equal(r.summary.offBranch, 0);
	assert.equal(r.summary.broken, 1, 'judged as before #61, never dropped on a failed read');
	assert.ok(
		r.warn.some((l) => /could not read its default branch \(the read failed\)/.test(l)),
		`the reason is named, got ${r.warn.join(' | ')}`
	);
	assert.ok(
		r.warn.some((l) => /branch-unread 1/.test(l)),
		'the tick summary carries it, at WARN'
	);
});
