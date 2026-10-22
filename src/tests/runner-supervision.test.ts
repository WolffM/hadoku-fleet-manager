/**
 * Supervision classification — the failure class no GitHub API call can see.
 *
 * On 2026-08-18 two registration tools installed for the same three runner
 * directories on all three claws. Nine runners ended up double-supervised; the
 * listener that lost the session race exited 5, its unit went inactive with
 * Restart=no, and the winner kept serving jobs as an unsupervised orphan.
 * GitHub reported all nine ONLINE for three days, because GitHub can only see
 * the listener — and the listener was fine.
 *
 * The unit is resolved from each process's CGROUP, never by unit name. Four
 * naming conventions are live across this fleet, and a name-based scan reports
 * whichever one it does not know about as unsupervised — which is how this
 * probe produced three separate rounds of false positives before the rewrite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	checkSupervision,
	classify,
	parseListeners,
	describeProblem,
	probeSupervision,
	type ListenerRow,
} from '../runner-supervision.js';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';

const row = (over: Partial<ListenerRow> = {}): ListenerRow => ({
	dir: 'actions-runner-hadoku-task',
	unit: 'actions.runner.WolffM-hadoku-task.claw-2.service',
	scope: 'system',
	unitState: 'active',
	...over,
});

test('a listener in an active unit is healthy', () => {
	assert.deepEqual(classify('claw-2', [row()]), []);
});

test('a listener whose unit is not active is an ORPHAN', () => {
	// The exact 2026-08-21 state: the tree survived, the unit stopped after
	// SessionConflict, and Restart=no meant it never came back.
	for (const state of ['inactive', 'failed', 'deactivating']) {
		const p = classify('claw-2', [row({ unitState: state })]);
		assert.equal(p.length, 1, `state ${state} must be reported`);
		assert.equal(p[0]!.kind, 'orphan');
	}
});

test('a listener in NO unit at all is an ORPHAN', () => {
	// A hand-started ./run.sh lands in a session scope, not a .service cgroup.
	const p = classify('claw-2', [row({ unit: 'none', unitState: 'none' })]);
	assert.equal(p[0]!.kind, 'orphan');
});

test('two listeners on one directory is a DUPLICATE, and outranks orphan', () => {
	// This is the condition that actively corrupts jobs, so it must win even
	// when the units also look wrong.
	const p = classify('claw-2', [
		row({ unitState: 'inactive' }),
		row({ unit: 'none', unitState: 'none' }),
	]);
	assert.equal(p.length, 1);
	assert.equal(p[0]!.kind, 'duplicate');
	assert.equal(p[0]!.listeners, 2);
});

test('listeners in DIFFERENT directories are independent', () => {
	const p = classify('claw-2', [
		row(),
		row({ dir: 'actions-runner-hadoku-study', unitState: 'inactive' }),
	]);
	assert.equal(p.length, 1);
	assert.equal(p[0]!.dir, 'actions-runner-hadoku-study');
});

/**
 * Every one of these cgroup shapes is real, copied from the live fleet. Each of
 * the last three was, at some point, reported as an orphan by a name-matching
 * predecessor of this code.
 */
const REAL_PROBE_OUTPUT = [
	// claw, system scope — the common case
	'actions-runner-hadoku-task|actions.runner.WolffM-hadoku-task.claw-2.service|system|active',
	// claw, USER scope — reconcile-fleet-runners.mjs installs these
	'actions-runner-hadoku-merchant|actions-runner-hadoku-merchant.service|user|active',
	// hokon, user scope, a THIRD naming convention
	'actions-runner-hokon-b|hokon-runner-b.service|user|active',
	// hokon, system scope inside a custom slice, a FOURTH convention
	'actions-runner-tenhands|github-runner-tenhands.service|system|active',
].join('\n');

test('every live supervision convention on the fleet reads as healthy', () => {
	const rows = parseListeners(REAL_PROBE_OUTPUT);
	assert.equal(rows.length, 4);
	assert.deepEqual(
		classify('mixed', rows),
		[],
		'all four naming conventions are legitimately supervised and must not alert'
	);
});

test('parseListeners ignores ssh banners and malformed lines', () => {
	const noisy = ['Welcome to claw-2', '', REAL_PROBE_OUTPUT, 'garbage|line', ''].join('\n');
	assert.equal(parseListeners(noisy).length, 4);
});

test('the user scope is carried through, so the advice names the right manager', () => {
	const userOrphan = classify('claw-2', [
		row({ unit: 'actions-runner-x.service', scope: 'user', unitState: 'inactive' }),
	])[0]!;
	assert.match(describeProblem(userOrphan), /systemctl --user start/);

	const sysOrphan = classify('claw-2', [row({ unitState: 'inactive' })])[0]!;
	assert.match(describeProblem(sysOrphan), /sudo systemctl start/);
});

test('an unsupervised listener never gets `systemctl start none` as advice', () => {
	const p = classify('claw-9', [row({ unit: 'none', unitState: 'none' })])[0]!;
	const msg = describeProblem(p);
	assert.match(msg, /in NO systemd unit/);
	assert.ok(!/start none/.test(msg));
});

test('every problem names the node, the directory and a resolution', () => {
	const problems = [
		...classify('claw-2', [row({ unitState: 'inactive' })]),
		...classify('claw-2', [row(), row()]),
	];
	for (const p of problems) {
		const msg = describeProblem(p);
		assert.ok(msg.includes('claw-2'), 'names the node');
		assert.ok(msg.includes(p.dir), 'names the runner directory');
		assert.match(msg, /Resolve:/);
	}
});

test('the local host is probed directly, never over ssh', async () => {
	// mgmt-api runs on hokon and hokon is in the tier manifest, so an ssh-only
	// probe reported it unreachable every tick and never checked its runners.
	const result = await probeSupervision(hostname());
	assert.notEqual(result, null, 'the box we are running on must never read as unreachable');
});

test('a genuinely unreachable node is null, not an empty healthy result', async () => {
	assert.equal(await probeSupervision('no-such-host.invalid'), null);
});

test('the probe does not match its own process', async () => {
	// The probe's `bash -c <script>` process carries the match pattern inside
	// its own argv, so an unanchored glob matches it on every node: a phantom
	// listener whose directory is the literal glob `actions-runner*`, and a bogus
	// "2 listeners" duplicate for every host. Same self-match trap as `pgrep -f`,
	// one layer down. Anchoring at "/" excludes it, because a real listener's
	// argv[0] is an absolute path and `bash` is not.
	const result = await probeSupervision(hostname());
	assert.notEqual(
		result,
		null,
		`probeSupervision(${hostname()}) returned null — the LOCAL host must always be reachable; ` +
			'null here means the local-probe path regressed to ssh, or the probe timed out'
	);

	// NON-VACUITY, derived from the host rather than assumed of it.
	//
	// This used to assert `rows.length > 0` outright — "this host runs runners".
	// That stopped being true on 2026-08-28 when claw-3 went pure JIT: a JIT
	// runner is minted into ~/.hadoku/jit/slotN, so its listener is
	// `.../slot0/bin/Runner.Listener`, which the probe's `*/actions-runner*/`
	// pattern does not match. The job executing this very test runs under one.
	// So on a claw the count is legitimately zero, and CI failed or passed
	// depending on which node picked the job up.
	//
	// Counting the STANDING installs independently keeps the check meaningful on
	// every host: where they exist the probe must see them, and where they do not
	// zero is the right answer.
	// THE PATTERN MUST NOT APPEAR IN A PROCESS ARGV — count in JS, not in a shell.
	//
	// The first version of this counter shelled out to
	// `ps … | grep -c '/actions-runner[^ ]*/bin/Runner.Listener'`, which puts that
	// string into a bash argv. The probe's own glob then MATCHES it, producing a
	// phantom listener whose directory is the literal `actions-runner[^ ]*` — the
	// exact self-match trap this test exists to detect, reintroduced by its own
	// non-vacuity guard. It failed intermittently for a day before the message
	// above identified it.
	//
	// `ps -eo args=` carries no pattern, so filtering in JS cannot be self-caught.
	const standingCount = execFileSync('ps', ['-eo', 'args='])
		.toString()
		.split('\n')
		.filter((l) => /\/actions-runner[^ ]*\/bin\/Runner\.Listener/.test(l)).length;
	if (standingCount > 0) {
		assert.ok(
			result!.rows.length > 0,
			`this host has ${standingCount} standing listener(s); seeing none means the match broke`
		);
	}

	// The actual subject of this test, asserted unconditionally.
	for (const r of result!.rows) {
		assert.ok(
			!r.dir.includes('*'),
			`a glob character in a runner directory means the probe matched itself: ${r.dir}`
		);
	}
});

// --- 'dead': a unit systemd has given up on (2026-08-27) --------------------
//
// The gap this module's header used to say it deliberately left open. On
// 2026-08-26 github-runner-tenhands.service sat in start-limit-hit with its
// registration deleted and NOTHING noticed for 6h45m: the probe starts from
// PROCESSES, so a unit with no listener produces no row at all, and the only
// GitHub-side signal (the label floor) fires at ZERO online — which one runner
// among twenty-six never reaches.

test('a failed runner unit is a problem even with no listener', () => {
	const rows = parseListeners('DEAD|github-runner-tenhands.service|system|failed');
	const p = classify('hokon', rows);
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, 'dead');
	assert.equal(p[0].unit, 'github-runner-tenhands.service');
	assert.equal(p[0].listeners, 0, 'there is no listener — that is the point');
});

test('the dead message says why nothing else will report it', () => {
	const [p] = classify(
		'hokon',
		parseListeners('DEAD|github-runner-tenhands.service|system|failed')
	);
	const msg = describeProblem(p);
	assert.match(msg, /given up/);
	assert.match(msg, /label-floor alert only fires at zero/);
	assert.match(msg, /registration has been deleted/);
	assert.match(msg, /sudo systemctl start github-runner-tenhands.service/);
});

test('a user-scope dead unit gets the user-scope fix command', () => {
	const [p] = classify(
		'claw-2',
		parseListeners('DEAD|actions-runner-hadoku-hopper.service|user|failed')
	);
	assert.match(describeProblem(p), /systemctl --user start actions-runner-hadoku-hopper.service/);
	assert.doesNotMatch(describeProblem(p), /sudo/);
});

test('dead units do not disturb the listener verdicts', () => {
	// They are not grouped by directory — they have none — so a DEAD row must not
	// become a phantom listener or a duplicate.
	const rows = parseListeners(
		[
			'DEAD|github-runner-tenhands.service|system|failed',
			'actions-runner-hadoku-meet|actions-runner-hadoku-meet.service|user|active',
		].join('\n')
	);
	const p = classify('hokon', rows);
	assert.equal(p.length, 1, 'the healthy listener is not a problem');
	assert.equal(p[0].kind, 'dead');
});

test('no failed units means nothing reported', () => {
	assert.deepEqual(classify('claw-1', parseListeners('')), []);
});

test('a GUEST in the fleet manifest is never probed, and the skip is reported by name', async () => {
	// hokon is a guest (operator, 2026-09-14): its runner units are the identity
	// gate's question only. It is a declared fleet node, so without the role skip
	// this probe reads its listeners every tick and pages on them.
	const probed: string[] = [];
	const report = await checkSupervision({
		nodes: () => ['claw-2', 'hokon'],
		guests: () => new Set(['hokon']),
		probe: async (node) => {
			probed.push(node);
			return { listeners: 1, rows: [], problems: [] };
		},
	});
	assert.deepEqual(probed, ['claw-2'], 'the guest must not be reached at all');
	assert.deepEqual(report?.nodes, ['claw-2']);
	assert.deepEqual(report?.skippedByRole, ['hokon'], 'a skip nobody can see is a silent one');
	assert.equal(report?.listenersSeen, 1);
});

test('no readable guests means every node is probed — the strict direction', async () => {
	// An unreadable fleet manifest yields an empty guest set; that must never
	// exempt anyone, or a missing file would quietly shrink the check.
	const probed: string[] = [];
	const report = await checkSupervision({
		nodes: () => ['claw-2', 'hokon'],
		guests: () => new Set(),
		probe: async (node) => {
			probed.push(node);
			return { listeners: 0, rows: [], problems: [] };
		},
	});
	assert.deepEqual(probed, ['claw-2', 'hokon']);
	assert.deepEqual(report?.skippedByRole, []);
});
