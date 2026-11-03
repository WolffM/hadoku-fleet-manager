import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDispatchPass } from '../runners/dispatch-pass.js';
import { byPriority, BAND_HEAD_START_MS } from '../runners/dispatch-pass-order.js';
import { heavyMarkedRecently, HEAVY_MARK_MS } from '../runners/dispatch-pass-state.js';
import type { HeavyModel } from '../runners/heavy-model.js';
import type { PendingRun } from '../runners/dispatcher.js';
import { fakeGh, fakeShell } from './helpers/fleet-fakes.js';
import {
	node,
	run,
	base,
	harness,
	recordInfos,
	installDispatchPassRig,
} from './helpers/dispatch-pass-rig.js';

installDispatchPassRig();

// --- #102: the warm half of the heavy hold ----------------------------------

const CT = 'WolffM/hadoku-cardtable';
const FORGE: HeavyModel = {
	isHeavy: (repo, jobName) => repo === CT && /^forge-(jvm|e2e)/.test(jobName ?? ''),
	isHeavyRepo: (repo) => repo === CT,
};
const forgeJob = (jobId: number, jobName: string): PendingRun => ({
	id: 37857873226,
	jobId,
	repo: CT,
	jobName,
	repository: { full_name: CT },
	head_repository: { full_name: CT, fork: false },
	event: 'push',
});
function recordingShell(): { sh: ReturnType<typeof fakeShell>; cmds: string[] } {
	const inner = fakeShell();
	const cmds: string[] = [];
	return {
		cmds,
		sh: async (node, cmd) => {
			cmds.push(`${node}: ${cmd}`);
			return inner(node, cmd);
		},
	};
}

test("#102 REPLAY 23:10Z: a heavy mint evicts the node's IDLE warm listener for a heavy repo, and marks the node", async () => {
	const gh = fakeGh({ runners: [{ id: 77, name: 'warm-claw-4-hadoku-cardtable', busy: false }] });
	const { sh, cmds } = recordingShell();
	const r = await runDispatchPass(
		base({
			order: ['claw-4'],
			nodes: [node('claw-4', { maxConcurrent: 4, warmRepo: CT, heavyModel: FORGE })],
			pending: [forgeJob(1, 'forge-e2e (1)')],
			nowMs: 1_000_000,
		}),
		'tok',
		gh,
		sh
	);
	assert.equal(r.minted, 1);
	assert.ok(
		cmds.some(
			(c) =>
				c.startsWith('claw-4:') && c.includes('stop') && c.includes('warm-claw-4-hadoku-cardtable')
		),
		`the warm unit was not stopped:\n  ${cmds.join('\n  ')}`
	);
	assert.ok(
		gh.writes.some((w) => w.includes('/actions/runners/77')),
		'the registration was not deleted'
	);
	assert.equal(heavyMarkedRecently('claw-4', 1_000_000 + 60_000), true);
	assert.equal(heavyMarkedRecently('claw-4', 1_000_000 + HEAVY_MARK_MS), false, 'the mark lapses');
});

test('#102: a BUSY warm listener beside a heavy job is left running — stopping it would kill its job', async () => {
	const gh = fakeGh({ runners: [{ id: 77, name: 'warm-claw-4-hadoku-cardtable', busy: true }] });
	const { sh, cmds } = recordingShell();
	await runDispatchPass(
		base({
			order: ['claw-4'],
			nodes: [node('claw-4', { maxConcurrent: 4, warmRepo: CT, heavyModel: FORGE })],
			pending: [forgeJob(1, 'forge-e2e (1)')],
		}),
		'tok',
		gh,
		sh
	);
	assert.equal(
		cmds.some((c) => c.includes('stop') && c.includes('warm-claw-4')),
		false
	);
	assert.equal(
		gh.writes.some((w) => w.includes('/actions/runners/77')),
		false
	);
});

test('#102: a LIGHT mint never touches the warm listener', async () => {
	const gh = fakeGh({ runners: [{ id: 77, name: 'warm-claw-4-hadoku-cardtable', busy: false }] });
	const { sh, cmds } = recordingShell();
	await runDispatchPass(
		base({
			order: ['claw-4'],
			nodes: [node('claw-4', { maxConcurrent: 4, warmRepo: CT, heavyModel: FORGE })],
			pending: [forgeJob(1, 'check')],
		}),
		'tok',
		gh,
		sh
	);
	assert.equal(
		cmds.some((c) => c.includes('stop') && c.includes('warm-claw-4')),
		false
	);
	assert.equal(heavyMarkedRecently('claw-4', Date.now()), false);
});

test('#102: a heavy SIBLING already running marks the node and evicts once — a long shard is one runner listing, not one per pass', async () => {
	const gh = fakeGh({ runners: [{ id: 77, name: 'warm-claw-4-hadoku-cardtable', busy: true }] });
	const { sh } = recordingShell();
	const input = (nowMs: number) =>
		base({
			order: ['claw-4'],
			nodes: [node('claw-4', { maxConcurrent: 4, warmRepo: CT, heavyModel: FORGE })],
			pending: [forgeJob(2, 'check')],
			runningJobs: [
				{
					repo: CT,
					runner: 'jit-claw-4-hadoku-cardtabl-j1-r9-1791497283',
					jobName: 'forge-e2e (1)',
				},
			],
			nowMs,
		});
	await runDispatchPass(input(1_000_000), 'tok', gh, sh);
	await runDispatchPass(input(1_015_000), 'tok', gh, sh);
	await runDispatchPass(input(1_030_000), 'tok', gh, sh);
	assert.equal(gh.reads.filter((r) => r.startsWith('/actions/runners?')).length, 1);
	assert.equal(
		heavyMarkedRecently('claw-4', 1_030_000 + 60_000),
		true,
		'refreshed every pass it is seen'
	);
});

// --- a runner GitHub gave to a different job --------------------------------

const MINTED_FOR_100 = 'jit-claw-2-hadoku-rally-j100-r1-1791000000';

test('2026-10-09 18:46Z: a runner minted for a still-queued job but BUSY elsewhere does not hold that job "in flight"', async () => {
	const infos = recordInfos();
	const h = harness([MINTED_FOR_100]);
	const r = await runDispatchPass(
		base({
			order: ['claw-2'],
			nodes: [node('claw-2', { maxConcurrent: 3 })],
			pending: [run(1)],
			runningJobs: [
				{ repo: 'WolffM/hadoku-rally', runner: MINTED_FOR_100, jobName: 'other-run-shard' },
			],
		}),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 1, 'job 100 is placed again — its own runner is serving another job');
	assert.ok(infos.some((i) => i.includes('serving another job')));
	const line = infos.find((i) => i.startsWith('[dispatch] minted='));
	assert.match(line!, /placed=claw-2@1$/, 'the busy unit still counts toward the node');
});

test('a runner minted for a queued job that is NOT busy yet is still in flight — the normal mint window', async () => {
	const h = harness([MINTED_FOR_100]);
	const r = await runDispatchPass(
		base({ order: ['claw-2'], nodes: [node('claw-2', { maxConcurrent: 3 })], pending: [run(1)] }),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 0, 'no second runner while the first is still coming up');
});

// --- a runner whose labels can never take its own job -----------------------

/** A shell whose one live unit is MINTED_FOR_100, described as `description`. */
function strandedShell(description: string, seen: string[]) {
	const base = fakeShell();
	return async (n: string, cmd: string) => {
		seen.push(cmd);
		if (cmd.includes('list-units'))
			return `${MINTED_FOR_100}.service loaded active running ${description}`;
		return base(n, cmd);
	};
}
const BUILDER_JOB = { ...run(1), labels: ['self-hosted', 'hadoku-builder'] };
const builderNode = () => node('claw-2', { maxConcurrent: 3, labels: ['hadoku-builder'] });

test('2026-10-23: a runner minted WITHOUT its job’s label is retired, and the job is placed again', async () => {
	const seen: string[] = [];
	const gh = fakeGh({ runners: [{ id: 218, name: MINTED_FOR_100 }] });
	const r = await runDispatchPass(
		base({ nodes: [builderNode()], pending: [BUILDER_JOB] }),
		'tok',
		gh,
		strandedShell('jit labels=self-hosted,Linux,X64,pm2-host,taskauto', seen)
	);
	assert.equal(r.minted, 1, 'job 100 is not held in flight by a runner that cannot take it');
	assert.ok(gh.writes.includes('/actions/runners/218'), 'its registration is deleted');
	assert.ok(
		seen.some((c) => c.includes('systemctl --user stop') && c.includes(MINTED_FOR_100)),
		'and its unit stopped, so it stops holding a slot'
	);
});

test('a runner whose stamp DOES fit its job is still in flight — no second mint, nothing retired', async () => {
	const seen: string[] = [];
	const gh = fakeGh({ runners: [{ id: 218, name: MINTED_FOR_100 }] });
	const r = await runDispatchPass(
		base({ nodes: [builderNode()], pending: [BUILDER_JOB] }),
		'tok',
		gh,
		strandedShell('jit labels=self-hosted,Linux,X64,hadoku-builder', seen)
	);
	assert.equal(r.minted, 0);
	assert.equal(gh.writes.includes('/actions/runners/218'), false);
});

test('a BUSY mismatched runner is serving another job — it is never deleted out from under it', async () => {
	const seen: string[] = [];
	const gh = fakeGh({ runners: [{ id: 218, name: MINTED_FOR_100, busy: true }] });
	const r = await runDispatchPass(
		base({
			nodes: [builderNode()],
			pending: [BUILDER_JOB],
			runningJobs: [{ repo: 'WolffM/hadoku-rally', runner: MINTED_FOR_100, jobName: 'deploy' }],
		}),
		'tok',
		gh,
		strandedShell('jit labels=self-hosted,Linux,X64,pm2-host', seen)
	);
	assert.equal(r.minted, 1, 'job 100 is placed again, as for any reassigned runner');
	assert.equal(gh.writes.includes('/actions/runners/218'), false, 'the busy runner is left alone');
});

// --- order: a push before a manual dispatch ---------------------------------

test('2026-10-09 20:27Z: a PUSH run’s job places before verify-branch dispatches queued after… and before', async () => {
	const at = (m: number) => new Date(Date.parse('2026-10-09T20:00:00Z') + m * 60_000).toISOString();
	const job = (id: number, event: string, minute: number): PendingRun => ({
		...run(id),
		event,
		jobCreatedAt: at(minute),
	});
	const ordered = byPriority([
		job(1, 'workflow_dispatch', 1),
		job(2, 'workflow_dispatch', 20),
		job(3, 'push', 5),
		job(4, 'schedule', 2),
		job(5, 'push', 3),
	]);
	assert.deepEqual(
		ordered.map((r) => r.id),
		[5, 3, 4, 1, 2]
	);
});

test('the push wins the one free node in a real pass', async () => {
	const infos = recordInfos();
	const h = harness();
	const r = await runDispatchPass(
		base({
			order: ['claw-2'],
			nodes: [node('claw-2', { maxConcurrent: 1 })],
			pending: [
				{ ...run(1), event: 'workflow_dispatch', jobCreatedAt: '2026-10-09T20:01:00Z' },
				{ ...run(2), event: 'push', jobCreatedAt: '2026-10-09T20:05:00Z' },
			],
		}),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 1);
	assert.ok(h.minted[0], 'one mint');
	assert.ok(
		infos.some((i) => i.includes('skipped run 1 ')),
		`the dispatch is the one that waits:\n  ${infos.join('\n  ')}`
	);
});

test('2026-10-25: a push is a head start, not a lane — an auto-update queued 47 minutes outranks pushes that came after it', async () => {
	// hadoku-study run 40165607402 (repository_dispatch, 05:27:37Z) waited until
	// 06:14 while the dispatcher minted 65 runners for pushes created after it.
	const at = (hms: string) => `2026-10-25T${hms}Z`;
	const job = (id: number, event: string, hms: string): PendingRun => ({
		...run(id),
		event,
		jobCreatedAt: at(hms),
	});
	const ordered = byPriority([
		job(1, 'push', '06:11:00'),
		job(2, 'repository_dispatch', '05:27:37'),
		job(3, 'push', '05:34:14'),
		job(4, 'push', '05:29:02'),
		job(5, 'workflow_dispatch', '05:20:00'),
	]);
	assert.deepEqual(
		ordered.map((r) => r.id),
		// 05:29:02 push is inside the dispatch's five-minute head start; 05:34:14 is
		// not. The manual dispatch starts ten minutes back, so 05:30:00, between them.
		[4, 5, 2, 3, 1]
	);
	assert.equal(BAND_HEAD_START_MS, 300_000);
});

test('2026-10-25: the old auto-update wins the one free node over a fresh push in a real pass', async () => {
	const infos = recordInfos();
	const h = harness();
	const r = await runDispatchPass(
		base({
			order: ['claw-2'],
			nodes: [node('claw-2', { maxConcurrent: 1 })],
			pending: [
				{ ...run(1), event: 'push', jobCreatedAt: '2026-10-25T06:11:00Z' },
				{ ...run(2), event: 'repository_dispatch', jobCreatedAt: '2026-10-25T05:27:37Z' },
			],
		}),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 1);
	assert.ok(
		infos.some((i) => i.includes('skipped run 1 ')),
		`the young push is the one that waits:\n  ${infos.join('\n  ')}`
	);
});
