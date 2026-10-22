import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reapJitRunners } from '../runners/ephemeral-exec.js';
import { fakeGh, fakeShell } from './helpers/fleet-fakes.js';
import { SWEEP_CONCURRENCY } from '../lib/concurrency.js';

const NOW = 1_787_797_008_000;
const mins = (n: number) => n * 60_000;

/** A JIT name minted `agoMs` before NOW. */
const name = (node: string, runId: number, agoMs: number) =>
	`jit-${node}-hadoku-meet-r${runId}-${Math.floor((NOW - agoMs) / 1000)}`;

function harness(opts: {
	runners: { id: number; name: string; busy?: boolean }[];
	liveUnits?: string[];
	unreachable?: string[];
}) {
	const gh = fakeGh({ runners: opts.runners });
	const sh = async (node: string, cmd: string) => {
		if (opts.unreachable?.includes(node)) return null;
		return fakeShell({ units: opts.liveUnits })(node, cmd);
	};
	// Deleted ids, recovered from the paths the shared fake recorded.
	const deleted = {
		get length() {
			return gh.writes.filter((w) => /\/actions\/runners\/\d+$/.test(w)).length;
		},
	};
	void deleted;
	return {
		get deleted() {
			return gh.writes
				.filter((w) => /\/actions\/runners\/(\d+)$/.test(w))
				.map((w) => Number(/(\d+)$/.exec(w)![1]));
		},
		sh,
		gh,
	};
}

test('an orphaned registration past its grace is removed', async () => {
	// A registration GitHub can see is one GitHub will SCHEDULE ONTO. An orphan
	// takes a job and nothing answers, so the job hangs to its timeout.
	const h = harness({ runners: [{ id: 1, name: name('claw-3', 7, mins(30)) }] });
	const r = await reapJitRunners(['WolffM/x'], ['claw-3'], 'tok', h.gh, h.sh, { nowMs: NOW });
	assert.deepEqual(h.deleted, [1]);
	assert.equal(r.reaped, 1);
});

test('a registration whose listener is alive is never touched', async () => {
	const live = name('claw-3', 7, mins(90));
	const h = harness({ runners: [{ id: 1, name: live }], liveUnits: [live] });
	const r = await reapJitRunners(['WolffM/x'], ['claw-3'], 'tok', h.gh, h.sh, { nowMs: NOW });
	assert.deepEqual(h.deleted, [], 'deleting this kills a job mid-flight');
	assert.equal(r.kept, 1);
});

/**
 * THE SAFETY CONTROL FOR ISSUE #22, AND THE ONE THIS FILE IS MUTATION-TESTED ON.
 *
 * Every other guard in the sweep is an inference: no live unit seen, a name too
 * old to vouch for, a node that answered. `busy` is not an inference — it is
 * GitHub saying it has ASSIGNED A JOB to this runner, from the party that did
 * the assigning. Delete the registration under it and the job dies mid-flight.
 *
 * The setup is deliberately the WORST case for every other guard at once: the
 * node is reachable and reports no unit by that name (so `liveUnits` says
 * orphan), and the mint epoch is half an hour past the ten-minute grace (so the
 * age says orphan). Under the pre-#22 sweep that registration is deleted. The
 * ONLY thing standing between the job and its death is `busy`, which is exactly
 * what makes reverting the check a test failure rather than a coverage note.
 */
test('a BUSY registration is never reaped, however orphaned it looks to the node', async () => {
	const h = harness({
		runners: [{ id: 1, name: name('claw-3', 7, mins(30)), busy: true }],
		liveUnits: [],
	});
	const r = await reapJitRunners(['WolffM/x'], ['claw-3'], 'tok', h.gh, h.sh, { nowMs: NOW });
	assert.deepEqual(
		h.deleted,
		[],
		'GitHub says a job is running on it; deleting the registration kills that job'
	);
	assert.equal(r.kept, 1);
});

test('a busy check is not a substitute for the age grace — an IDLE aged orphan still goes', async () => {
	// The other half of the control. A guard that kept everything would pass the
	// test above and disable the sweep, which is the leak §12.8 exists for: an
	// orphan GitHub will schedule onto, with nothing listening.
	const h = harness({
		runners: [{ id: 1, name: name('claw-3', 7, mins(30)), busy: false }],
		liveUnits: [],
	});
	const r = await reapJitRunners(['WolffM/x'], ['claw-3'], 'tok', h.gh, h.sh, { nowMs: NOW });
	assert.deepEqual(h.deleted, [1]);
	assert.equal(r.reaped, 1);
});

test('a fresh mint inside the grace survives — mgmt-api restarts ~5x a day', async () => {
	// The listener may not have appeared yet. Reaping on "no unit seen" alone
	// would clear a fleet's worth of healthy mints on every redeploy, which is
	// why the grace is read from the NAME rather than held in memory.
	const h = harness({ runners: [{ id: 1, name: name('claw-3', 7, mins(1)) }] });
	const r = await reapJitRunners(['WolffM/x'], ['claw-3'], 'tok', h.gh, h.sh, { nowMs: NOW });
	assert.deepEqual(h.deleted, []);
	assert.equal(r.kept, 1);
});

test('nothing belonging to an UNREACHABLE node is reaped', async () => {
	// We cannot know whether its listeners are alive, and deleting one mid-job
	// is the outage this workstream exists to avoid. Waiting costs one sweep.
	const h = harness({
		runners: [{ id: 1, name: name('claw-3', 7, mins(30)) }],
		unreachable: ['claw-3'],
	});
	const r = await reapJitRunners(['WolffM/x'], ['claw-3'], 'tok', h.gh, h.sh, { nowMs: NOW });
	assert.deepEqual(h.deleted, []);
	assert.deepEqual(r.unreachable, ['claw-3']);
});

test('one unreachable node does not freeze the sweep for the others', async () => {
	const h = harness({
		runners: [
			{ id: 1, name: name('claw-3', 7, mins(30)) },
			{ id: 2, name: name('claw-1', 8, mins(30)) },
		],
		unreachable: ['claw-3'],
	});
	await reapJitRunners(['WolffM/x'], ['claw-3', 'claw-1'], 'tok', h.gh, h.sh, { nowMs: NOW });
	assert.deepEqual(h.deleted, [2], 'claw-1 is reachable and its orphan goes');
});

test('a standing (non-JIT) runner is never considered', async () => {
	const h = harness({ runners: [{ id: 9, name: 'claw-3' }] });
	const r = await reapJitRunners(['WolffM/x'], ['claw-3'], 'tok', h.gh, h.sh, { nowMs: NOW });
	assert.deepEqual(h.deleted, [], 'reaping a standing registration would deregister a real runner');
	assert.equal(r.kept, 0, 'it is not even counted — it is not ours');
});

test('an unparseable jit name is reapable immediately — an unaged name cannot be vouched for', async () => {
	const h = harness({ runners: [{ id: 3, name: 'jit-claw-3-legacy-no-epoch' }] });
	await reapJitRunners(['WolffM/x'], ['claw-3'], 'tok', h.gh, h.sh, { nowMs: NOW });
	assert.deepEqual(h.deleted, [3]);
});

/**
 * THE SWEEP MUST NOT BE SEQUENTIAL.
 *
 * Every listing here carries a 10s fetch timeout, and the dispatcher holds
 * `dispatchInFlight` for the whole pass. One repo at a time across 27 repos is
 * therefore up to 270s in which nothing is discovered or minted — and discovery
 * latency IS queue latency under all-JIT.
 *
 * Not theoretical: on 2026-09-07, 866 of these listings timed out in two hours
 * and the fleet stopped serving work from 01:56 to 04:08, missing every
 * 10-minute runner-health tick in between.
 *
 * Bounded, though, not `Promise.all`: one token serves this sweep, the queued-
 * runs poll and runner-health, and a wide simultaneous burst trips GitHub's
 * SECONDARY rate limit — which stalls all three.
 */
test('the repo sweep is bounded-concurrent — neither serial nor a burst', async () => {
	let open = 0;
	let maxOpen = 0;
	const repos = Array.from({ length: 12 }, (_, i) => `WolffM/r${i}`);
	const gh = {
		get: async () => {
			open++;
			maxOpen = Math.max(maxOpen, open);
			await new Promise((r) => setTimeout(r, 5));
			open--;
			return { runners: [] };
		},
		write: async () => ({ ok: true, status: 204 }),
	};

	await reapJitRunners(repos, ['claw-3'], 'tok', gh as never, fakeShell({}), { nowMs: NOW });

	assert.ok(
		maxOpen > 1,
		`sequential sweep: at a 10s timeout each this is minutes of blocked dispatch (max open ${maxOpen})`
	);
	assert.ok(
		maxOpen <= SWEEP_CONCURRENCY,
		`must stay under the shared bound — a burst trips the SECONDARY limit (max open ${maxOpen})`
	);
});
