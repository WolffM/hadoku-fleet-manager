/**
 * The node cooldown (#103): what counts as busy, the backoff, the reset, and
 * the shadow note a dispatch decision carries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobRecord } from '../job-history-store.js';
import {
	COOLDOWN_BASE_MIN,
	COOLDOWN_CAP_MIN,
	COOLDOWN_ENFORCED,
	COOLDOWN_LONG_SEC,
	COOLDOWN_NORM_MIN_SUCCESSES,
	LiveCooldowns,
	classifyOutcome,
	cooldownMinutes,
	kindNorms,
	nodeCooldowns,
} from '../runners/node-cooldown.js';
import { JitDecisionBook } from '../runners/decision-log-record.js';
import {
	__resetDecisionLogForTesting,
	__restoreDecisionSinkForTesting,
	__setDecisionSinkForTesting,
} from '../runners/decision-log.js';

const NODES = ['hokon', 'claw-fixture', 'claw-other'];
const NOW = Date.now();
const H = 3_600_000;
let id = 1;

function rec(o: {
	node: string;
	name?: string;
	repo?: string;
	conclusion: string;
	durationSec: number;
	endMsAgo: number;
}): JobRecord {
	const jobId = id++;
	const startedMs = NOW - o.endMsAgo - o.durationSec * 1000;
	return {
		repo: o.repo ?? 'WolffM/forge-fixture',
		runId: 9000 + jobId,
		jobId,
		name: o.name ?? 'forge-e2e (1)',
		runner: `jit-${o.node}-forge-fixture-j${jobId}-r1-1`,
		labels: ['self-hosted'],
		startedAt: new Date(startedMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
		durationSec: o.durationSec,
		conclusion: o.conclusion,
	};
}

/** A norm for the long kind: successes on claw-other at 3000 s, old enough to end before anything else. */
function norm(
	n = COOLDOWN_NORM_MIN_SUCCESSES,
	durationSec = 3000,
	name = 'forge-e2e (2)'
): JobRecord[] {
	return Array.from({ length: n }, () =>
		rec({ node: 'claw-other', name, conclusion: 'success', durationSec, endMsAgo: 48 * H })
	);
}

void test('the cooldown ships in shadow', () => {
	assert.equal(COOLDOWN_ENFORCED, false);
});

void test('a cancel that outlived the kind p90 is busy; an early cancel and a failure are not', () => {
	const records = norm();
	const norms = kindNorms(records, NOW - 7 * 24 * H);
	// Shards fold to one kind.
	assert.equal(norms.get('WolffM/forge-fixture|forge-e2e'), 3000);
	const at = (conclusion: string, durationSec: number) =>
		classifyOutcome(rec({ node: 'hokon', conclusion, durationSec, endMsAgo: H }), norms);
	assert.equal(at('cancelled', 4500), 'busy');
	assert.equal(at('cancelled', 600), 'neutral');
	assert.equal(at('failure', 4500), 'neutral');
	assert.equal(at('success', 2900), 'clean');
	// Past the norm but under the slow bar: it neither vouches for the node nor charges it.
	assert.equal(at('success', 3200), 'neutral');
	assert.equal(at('success', 4600), 'busy');
});

void test('short kinds and kinds without enough successes are never judged', () => {
	const short = norm(COOLDOWN_NORM_MIN_SUCCESSES, COOLDOWN_LONG_SEC - 1, 'lint');
	const thin = norm(COOLDOWN_NORM_MIN_SUCCESSES - 1, 3000, 'thin');
	const norms = kindNorms([...short, ...thin], NOW - 7 * 24 * H);
	for (const name of ['lint', 'thin'])
		assert.equal(
			classifyOutcome(
				rec({ node: 'hokon', name, conclusion: 'cancelled', durationSec: 99_999, endMsAgo: H }),
				norms
			),
			'neutral'
		);
});

void test('the backoff doubles from the base and stops at the cap', () => {
	assert.equal(cooldownMinutes(1), COOLDOWN_BASE_MIN);
	assert.equal(cooldownMinutes(2), 2 * COOLDOWN_BASE_MIN);
	assert.equal(cooldownMinutes(3), 4 * COOLDOWN_BASE_MIN);
	assert.equal(cooldownMinutes(50), COOLDOWN_CAP_MIN);
});

void test('busy outcomes in a row lengthen the cooldown; it runs from the last one', () => {
	const records = [
		...norm(),
		rec({ node: 'hokon', conclusion: 'cancelled', durationSec: 4500, endMsAgo: 3 * H }),
		rec({ node: 'hokon', conclusion: 'cancelled', durationSec: 4500, endMsAgo: 2 * H }),
		rec({ node: 'hokon', conclusion: 'cancelled', durationSec: 4500, endMsAgo: 10 * 60_000 }),
	];
	const c = nodeCooldowns(records, NODES, NOW).get('hokon');
	assert.ok(c, 'hokon should be cooling');
	assert.equal(c.streak, 3);
	// startedAt is whole seconds, as GitHub writes it: the end is within one of NOW - 10 min.
	assert.ok(Math.abs(c.untilMs - (NOW - 10 * 60_000 + cooldownMinutes(3) * 60_000)) < 1000);
	assert.equal(c.last.conclusion, 'cancelled');
	assert.equal(nodeCooldowns(records, NODES, NOW).has('claw-other'), false);
});

void test('a clean long success resets the streak and ends the cooldown; a short success does not', () => {
	const busy = rec({
		node: 'hokon',
		conclusion: 'cancelled',
		durationSec: 4500,
		endMsAgo: 20 * 60_000,
	});
	const shortOk = [
		...norm(COOLDOWN_NORM_MIN_SUCCESSES, 30, 'lint'),
		rec({
			node: 'hokon',
			name: 'lint',
			conclusion: 'success',
			durationSec: 30,
			endMsAgo: 5 * 60_000,
		}),
	];
	assert.ok(nodeCooldowns([...norm(), busy, ...shortOk], NODES, NOW).get('hokon'));
	const clean = rec({
		node: 'hokon',
		conclusion: 'success',
		durationSec: 2900,
		endMsAgo: 5 * 60_000,
	});
	assert.equal(nodeCooldowns([...norm(), busy, clean], NODES, NOW).has('hokon'), false);
});

void test('an expired cooldown is not cooling', () => {
	const records = [
		...norm(),
		rec({
			node: 'hokon',
			conclusion: 'cancelled',
			durationSec: 4500,
			endMsAgo: (COOLDOWN_BASE_MIN + 1) * 60_000,
		}),
	];
	assert.equal(nodeCooldowns(records, NODES, NOW).has('hokon'), false);
});

void test('the live view notes a long job on a cooling node, in shadow, and nothing for a short job', () => {
	const records = [
		...norm(),
		...norm(COOLDOWN_NORM_MIN_SUCCESSES, 30, 'lint'),
		rec({ node: 'hokon', conclusion: 'cancelled', durationSec: 4500, endMsAgo: 60_000 }),
	];
	const live = new LiveCooldowns(() => records);
	assert.equal(live.refresh(NODES, NOW).size, 1);
	const note = live.noteFor('hokon', 'WolffM/forge-fixture', 'forge-e2e (4)', NOW);
	assert.ok(note);
	assert.equal(note.enforced, false);
	assert.equal(note.streak, 1);
	assert.match(
		note.why,
		/hokon cooling \d+ min more \(streak 1\).*cancelled at 4500s, kind p90 3000s/
	);
	assert.equal(live.noteFor('hokon', 'WolffM/forge-fixture', 'lint', NOW), null);
	assert.equal(live.noteFor('claw-fixture', 'WolffM/forge-fixture', 'forge-e2e (4)', NOW), null);
});

void test('a placed decision onto a cooling node carries the note; others carry none', () => {
	__resetDecisionLogForTesting();
	const rows: { jobId: number | null; cooldown?: unknown }[] = [];
	__setDecisionSinkForTesting((rs) => rows.push(...rs));
	try {
		const note = {
			enforced: false,
			streak: 2,
			until: new Date(NOW + H).toISOString(),
			why: 'hokon cooling',
		};
		const book = new JitDecisionBook(NOW, ['hokon', 'claw-fixture'], undefined, (n) =>
			n === 'hokon' ? note : null
		);
		const placed = (jobId: number, node: string) =>
			book.observe({
				run: { id: jobId, jobId, jobName: 'forge-e2e (1)', repo: 'WolffM/forge-fixture' },
				passIndex: 0,
				outcome: 'placed',
				candidates: [],
				placed: { heavy: true, passed: [], node, viaAffinity: false },
			});
		placed(1, 'hokon');
		placed(2, 'claw-fixture');
		book.flush();
		assert.deepEqual(rows.find((r) => r.jobId === 1)?.cooldown, note);
		assert.equal(rows.find((r) => r.jobId === 2)?.cooldown, undefined);
	} finally {
		__restoreDecisionSinkForTesting();
	}
});
