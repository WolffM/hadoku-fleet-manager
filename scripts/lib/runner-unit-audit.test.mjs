/**
 * The classification rules, asserted against the six real cases that produced
 * them on 2026-09-03. Every test here names an install that actually existed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	repoFromUrl,
	classifyInstall,
	classifyUnit,
	IGNORABLE,
	lookupOutcome,
} from './runner-unit-audit.mjs';

const roster = new Set([1129970414, 1124924177, 1116902949]); // tenhands, craft, aggregator

test('repoFromUrl reads what .runner actually stores', () => {
	assert.equal(repoFromUrl('https://github.com/WolffM/hadoku-trader'), 'WolffM/hadoku-trader');
	assert.equal(repoFromUrl('https://github.com/WolffM/hadoku-craft/'), 'WolffM/hadoku-craft');
	assert.equal(repoFromUrl('https://github.com/WolffM/x.git'), 'WolffM/x');
	assert.equal(repoFromUrl(''), null);
	assert.equal(repoFromUrl(undefined), null);
	// A URL that is not github.com is not a repo we can judge.
	assert.equal(repoFromUrl('https://example.com/WolffM/x'), null);
});

test('RENAMED beats every other verdict — this is the whole point of the gate', () => {
	// WolffM/vibedispatch redirects to WolffM/hadoku-tenhands, which is ON the
	// roster and perfectly healthy. A name-based check calls this fine.
	const v = classifyInstall({
		requested: 'WolffM/vibedispatch',
		resolved: { fullName: 'WolffM/hadoku-tenhands', id: 1129970414, archived: false },
		rosterIds: roster,
	});
	assert.equal(v.kind, 'RENAMED');
	assert.match(v.why, /redirects to WolffM\/hadoku-tenhands/);
});

test('a renamed repo is not misreported as off-roster', () => {
	// hadoku-printTool -> hadoku-craft. Were the roster check first, the operator
	// would be sent to the coverage file instead of to the rename.
	const v = classifyInstall({
		requested: 'WolffM/hadoku-printTool',
		resolved: { fullName: 'WolffM/hadoku-craft', id: 1124924177, archived: false },
		rosterIds: roster,
	});
	assert.equal(v.kind, 'RENAMED');
});

test('ARCHIVED is a rule, not a repo name — it cannot drift to the next one', () => {
	const v = classifyInstall({
		requested: 'WolffM/anything-at-all',
		resolved: { fullName: 'WolffM/anything-at-all', id: 999, archived: true },
		rosterIds: roster,
	});
	assert.equal(v.kind, 'ARCHIVED');
});

test('ignore: true downgrades OFF-ROSTER and NOTHING else', () => {
	const off = classifyInstall({
		requested: 'WolffM/hadoku-games-host',
		resolved: { fullName: 'WolffM/hadoku-games-host', id: 1310501989, archived: false },
		rosterIds: roster,
		ignored: true,
	});
	assert.equal(off.kind, 'OFF-ROSTER');
	assert.equal(off.note, true, 'off-roster is quietable');

	// hadoku-trader is BOTH archived and ignore:true in the manifest. The
	// decision to keep it is not a decision to stop measuring what it costs.
	const arch = classifyInstall({
		requested: 'WolffM/hadoku-trader',
		resolved: { fullName: 'WolffM/hadoku-trader', id: 111, archived: true },
		rosterIds: roster,
		ignored: true,
	});
	assert.equal(arch.kind, 'ARCHIVED');
	assert.notEqual(arch.note, true, 'ignore must not quiet an archived repo');
	assert.ok(!IGNORABLE.has('ARCHIVED'));
});

test('a healthy on-roster install is not a finding', () => {
	assert.equal(
		classifyInstall({
			requested: 'WolffM/hadoku-craft',
			resolved: { fullName: 'WolffM/hadoku-craft', id: 1124924177, archived: false },
			rosterIds: roster,
		}),
		null
	);
});

test('a 404 and an unreadable .runner both read as GONE, never as healthy', () => {
	assert.equal(
		classifyInstall({ requested: 'WolffM/deleted', resolved: null, rosterIds: roster }).kind,
		'GONE'
	);
	assert.equal(
		classifyInstall({ requested: null, resolved: null, rosterIds: roster }).kind,
		'GONE'
	);
});

test('STRAY: a unit whose WorkingDirectory is gone', () => {
	const v = classifyUnit({
		unit: 'actions.runner.WolffM-vibedispatch.claw-1.service',
		active: 'activating',
		sub: 'auto-restart',
		restarts: 11125,
		workingDir: '/home/hadoku/actions-runner-vibedispatch',
		installDirs: new Set(['actions-runner-hadoku-trader']),
	});
	assert.equal(v.kind, 'STRAY');
	assert.match(v.why, /11125 times/);
});

test('STRAY beats SICK — the missing tree is the cause, the restart is the symptom', () => {
	const v = classifyUnit({
		unit: 'u',
		active: 'activating',
		sub: 'auto-restart',
		restarts: 5,
		workingDir: '/home/hadoku/actions-runner-gone',
		installDirs: new Set(),
	});
	assert.equal(v.kind, 'STRAY');
});

test('SICK: the tree is there but the unit is not running', () => {
	const v = classifyUnit({
		unit: 'u',
		active: 'failed',
		sub: 'failed',
		restarts: 3,
		workingDir: '/home/hadoku/actions-runner-x',
		installDirs: new Set(['actions-runner-x']),
	});
	assert.equal(v.kind, 'SICK');
});

test('a running unit over a real tree is not a finding', () => {
	assert.equal(
		classifyUnit({
			unit: 'u',
			active: 'active',
			sub: 'running',
			workingDir: '/home/hadoku/actions-runner-x',
			installDirs: new Set(['actions-runner-x']),
		}),
		null
	);
});

test('a unit with no WorkingDirectory is judged on its state alone', () => {
	// Not every unit declares one; absent must not read as "directory missing".
	assert.equal(
		classifyUnit({
			unit: 'u',
			active: 'active',
			sub: 'running',
			workingDir: '',
			installDirs: new Set(),
		}),
		null
	);
});

test('a rename with a RUNNING install is cosmetic, not a dead registration', () => {
	// hokon's actions-runner-hadoku-printtool serves WolffM/hadoku-craft today.
	// A runner authenticates on repo id, so the rename never reached it.
	const v = classifyInstall({
		requested: 'WolffM/hadoku-printTool',
		resolved: { fullName: 'WolffM/hadoku-craft', id: 1124924177, archived: false },
		rosterIds: roster,
		running: true,
	});
	assert.equal(v.kind, 'STALE-NAME');
	assert.equal(v.note, true);
	assert.ok(IGNORABLE.has('STALE-NAME'));
});

test('the same rename with a stopped install IS a finding', () => {
	const v = classifyInstall({
		requested: 'WolffM/hadoku-printTool',
		resolved: { fullName: 'WolffM/hadoku-craft', id: 1124924177, archived: false },
		rosterIds: roster,
		running: false,
	});
	assert.equal(v.kind, 'RENAMED');
	assert.notEqual(v.note, true);
});

test("only GitHub's own 404 is GONE — a failed lookup keeps its reason", () => {
	assert.deepEqual(lookupOutcome({ ok: false, stderr: 'gh: Not Found (HTTP 404)\n' }), {
		status: 'gone',
	});
	// The shape that used to read as GONE for every install at once.
	const limited = lookupOutcome({
		ok: false,
		stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)\n',
	});
	assert.equal(limited.status, 'error');
	assert.match(limited.why, /rate limit/);
	assert.equal(lookupOutcome({ ok: false, stderr: '' }).status, 'error');
});

test('a lookup that answered must carry an id and a name to count as found', () => {
	assert.deepEqual(
		lookupOutcome({
			ok: true,
			stdout: JSON.stringify({ id: 1124924177, full_name: 'WolffM/hadoku-craft', archived: false }),
		}),
		{ status: 'found', repo: { fullName: 'WolffM/hadoku-craft', id: 1124924177, archived: false } }
	);
	assert.equal(lookupOutcome({ ok: true, stdout: '<html>' }).status, 'error');
	assert.equal(lookupOutcome({ ok: true, stdout: '{"message":"x"}' }).status, 'error');
});
