import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FINISHED_UNIT_GRACE_MS, stopFinishedUnits } from '../runners/ephemeral-exec-reap.js';
import {
	__resetHintsForTesting,
	finishedRunners,
	hintStats,
	recordWorkflowJobHint,
} from '../runners/dispatch-hint.js';
import { fakeShell } from './helpers/fleet-fakes.js';

const NOW = 1_787_797_008_000;
const mins = (n: number) => n * 60_000;
// The 2026-11-21 unit, as hokon named it.
const HOKON = 'jit-hokon-hadoku-cardtable-j136775086827-r44880684892-1795246325';

function recordingShell(units: string[], unreachable: string[] = []) {
	const cmds: { node: string; cmd: string }[] = [];
	const inner = fakeShell({ units });
	const sh = async (node: string, cmd: string) => {
		cmds.push({ node, cmd });
		if (unreachable.includes(node)) return null;
		return inner(node, cmd);
	};
	return { sh, stops: () => cmds.filter((c) => c.cmd.includes('systemctl --user stop')), cmds };
}

const completed = (runnerName: unknown) => ({
	action: 'completed',
	repository: { full_name: 'WolffM/hadoku-cardtable' },
	workflow_job: {
		id: 136775086827,
		run_id: 44880684892,
		labels: ['self-hosted'],
		runner_name: runnerName,
	},
});

test('a completed delivery records its JIT runner, and nothing else does', () => {
	__resetHintsForTesting();
	recordWorkflowJobHint(completed(HOKON), NOW);
	recordWorkflowJobHint(completed('warm-claw-4-hadoku-cardtable-1'), NOW);
	recordWorkflowJobHint(completed(null), NOW); // cancelled before a runner took it
	recordWorkflowJobHint({ ...completed('jit-claw-6-x-j1-r2-3'), action: 'in_progress' }, NOW);
	assert.deepEqual([...finishedRunners(NOW).keys()], [HOKON]);
	assert.equal(hintStats(NOW).finished, 1);
	// A completed job is still not a dispatch hint.
	assert.equal(hintStats(NOW).accepted, 0);
});

test('the record expires, so a name that is never settled cannot pin the map', () => {
	__resetHintsForTesting();
	recordWorkflowJobHint(completed(HOKON), NOW);
	assert.equal(finishedRunners(NOW + 25 * 60 * 60_000).size, 0);
});

test('a unit still running past the grace after GitHub closed its job is stopped', async () => {
	const h = recordingShell([HOKON]);
	const r = await stopFinishedUnits(['hokon'], h.sh, new Map([[HOKON, NOW - mins(11)]]), NOW);
	assert.deepEqual(r.stopped, [HOKON]);
	assert.deepEqual(r.settled, [HOKON]);
	assert.equal(h.stops().length, 1);
	assert.equal(h.stops()[0]!.node, 'hokon');
	assert.ok(h.stops()[0]!.cmd.includes(HOKON));
});

test('inside the grace nothing is touched, and the node is not even probed', async () => {
	const h = recordingShell([HOKON]);
	const r = await stopFinishedUnits(
		['hokon'],
		h.sh,
		new Map([[HOKON, NOW - FINISHED_UNIT_GRACE_MS + 1000]]),
		NOW
	);
	assert.deepEqual(r, { stopped: [], settled: [], unreachable: [] });
	assert.equal(h.cmds.length, 0);
});

test('a unit that already exited is settled without a stop', async () => {
	const h = recordingShell([]);
	const r = await stopFinishedUnits(['hokon'], h.sh, new Map([[HOKON, NOW - mins(30)]]), NOW);
	assert.deepEqual(r.stopped, []);
	assert.deepEqual(r.settled, [HOKON], 'answered once, then forgotten');
	assert.equal(h.stops().length, 0);
});

test('an unreachable node is "could not look": the name stays for the next sweep', async () => {
	const h = recordingShell([HOKON], ['hokon']);
	const r = await stopFinishedUnits(['hokon'], h.sh, new Map([[HOKON, NOW - mins(30)]]), NOW);
	assert.deepEqual(r.settled, []);
	assert.deepEqual(r.unreachable, ['hokon']);
	assert.equal(h.stops().length, 0);
});

test('claw-1 never claims a claw-10 unit', async () => {
	const unit = 'jit-claw-10-hadoku-site-j5-r6-1795246325';
	const h = recordingShell([unit]);
	await stopFinishedUnits(['claw-1', 'claw-10'], h.sh, new Map([[unit, NOW - mins(30)]]), NOW);
	assert.deepEqual(
		h.stops().map((c) => c.node),
		['claw-10']
	);
});
