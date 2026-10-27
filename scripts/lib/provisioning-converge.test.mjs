/**
 * What the converger repairs, and how it judges the repair — fleet-manager#1.
 *
 * Fixtures are shaped like the drivers' real `--json`: throttle's SUMMARY is a
 * string and its notes name runner DIRECTORIES; slice's SUMMARY is parsed and
 * its notes name UNITS. The two drifted facets are the 2026-10-23 output, verbatim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyRepair, planRepairs, sliceDriftUnits } from './provisioning-converge.mjs';

const DIR = '/home/hadoku/runners/actions-runner-hadoku-fleet-manager';
const UNIT = 'actions-runner-hadoku-fleet-manager.service';
const DRIFT_1023 = `SLICE-PLACEMENT-DRIFT ${UNIT} effective=app.slice declared=app.slice want=under-runners.slice (needs a unit RESTART, not a reload)`;

const thr = (machine, fields, notes = []) => ({
	machine,
	ok: true,
	summary: `SUMMARY conf=1 ${Object.entries({
		wired: 0,
		newly: 0,
		stale: 0,
		stale_remaining: 0,
		restarted: 0,
		busy: 0,
		...fields,
	})
		.map(([k, v]) => `${k}=${v}`)
		.join(' ')} hooksha=abc`,
	notes,
});
const sl = (machine, summary = {}, notes = []) => ({
	machine,
	ok: true,
	role: 'claw',
	advisory: false,
	summary: { changed: '0', restarted: '0', busy: '0', failed: '0', in_slice: '1', ...summary },
	notes,
});

test('planRepairs: the 10-23 nodes are planned on both facets; a clean node is not', () => {
	const plan = planRepairs(
		{
			results: [
				thr('claw-4', { newly: 1 }),
				thr('claw-6', { newly: 1 }),
				thr('claw-1', { wired: 3 }),
			],
		},
		{
			results: [
				sl('claw-4', { in_slice: '0' }, [DRIFT_1023]),
				sl('claw-6', { in_slice: '0' }, [DRIFT_1023]),
				sl('claw-1'),
			],
		}
	);
	assert.deepEqual(
		plan.repair.map((r) => `${r.node}/${r.facet}`),
		['claw-4/throttle', 'claw-6/throttle', 'claw-4/slice', 'claw-6/slice']
	);
	assert.match(plan.repair[0].before, /1 runner\(s\) with the wrong env/);
	assert.equal(plan.repair[2].before, UNIT);
	assert.deepEqual(plan.unreadable, []);
});

test('planRepairs: a node that could not be read is unreadable — never repaired, never clean', () => {
	const plan = planRepairs(
		{ results: [{ machine: 'claw-5', ok: false, error: 'ssh: connect timed out' }] },
		{ results: [{ machine: 'claw-5', ok: false, error: 'unreachable or failed' }] }
	);
	assert.deepEqual(plan.repair, []);
	assert.deepEqual(
		plan.unreadable.map((u) => `${u.node}/${u.facet}: ${u.why}`),
		['claw-5/throttle: ssh: connect timed out', 'claw-5/slice: unreachable or failed']
	);
});

test('planRepairs: a drained node, a guest, and minted-unit drift are none of its business', () => {
	const plan = planRepairs(
		{ results: [{ machine: 'claw-2', ok: true, expectedDown: true, skipped: 'expected down' }] },
		{
			results: [
				{ ...sl('hokon', {}, [DRIFT_1023]), role: 'guest', advisory: true },
				sl('claw-3', {}, [
					'MINT-PLACEMENT-DRIFT jit-claw-3-x.service effective=app.slice want=under-runners.slice',
				]),
			],
		}
	);
	assert.deepEqual(plan, { repair: [], unreadable: [] });
});

test('sliceDriftUnits: placement and cap drift, deduplicated; BUSY and MINT lines are not drift', () => {
	assert.deepEqual(
		sliceDriftUnits(
			sl('claw-4', {}, [
				DRIFT_1023,
				`UNIT-CAP-DRIFT ${UNIT} kernel=max want=1`,
				`BUSY ${UNIT}`,
				'MINT-CAP-DRIFT jit-x.service',
			])
		),
		[UNIT]
	);
});

test('classifyRepair throttle: env written, idle runner restarted, re-check clean -> converged', () => {
	const v = classifyRepair(
		'throttle',
		[thr('claw-4', { newly: 1, restarted: 1 })],
		thr('claw-4', { wired: 1 })
	);
	assert.equal(v.outcome, 'converged');
	assert.equal(v.changed, 'env written on 1 runner(s), 1 restarted');
});

test('classifyRepair throttle: the --no-restart write is counted even though the second pass found it wired', () => {
	const v = classifyRepair(
		'throttle',
		[thr('claw-4', { newly: 1 }), thr('claw-4', { wired: 1 })],
		thr('claw-4', { wired: 1 })
	);
	assert.equal(v.changed, 'env written on 1 runner(s), 0 restarted');
});

test('classifyRepair throttle: a runner left stale because it was BUSY -> deferred, never a page', () => {
	const v = classifyRepair(
		'throttle',
		[thr('claw-4', { newly: 1, stale: 0, busy: 1 }, [`BUSY ${DIR}`])],
		thr('claw-4', { newly: 1, stale: 1 }, [`STALE ${DIR}`])
	);
	assert.equal(v.outcome, 'deferred');
	assert.deepEqual(v.busy, [DIR]);
});

test('classifyRepair throttle: stale and NOT busy, or env still wrong -> unconverged, naming the failed restart', () => {
	const stale = classifyRepair(
		'throttle',
		[thr('claw-4', { newly: 1 }, [`RESTART-FAILED ${DIR}`])],
		thr('claw-4', { newly: 1, stale: 1 }, [`STALE ${DIR}`])
	);
	assert.equal(stale.outcome, 'unconverged');
	assert.match(
		stale.why,
		/restart failed: \/home\/hadoku\/runners\/actions-runner-hadoku-fleet-manager/
	);
	// A busy runner does not excuse a SECOND runner whose env is still wrong.
	const wrong = classifyRepair(
		'throttle',
		[thr('claw-4', { newly: 2, busy: 1 }, [`BUSY ${DIR}`])],
		thr('claw-4', { newly: 2, stale: 1 }, [`STALE ${DIR}`])
	);
	assert.equal(wrong.outcome, 'unconverged');
	assert.match(wrong.why, /1 runner\(s\) still have the wrong env/);
});

test('classifyRepair slice: restarted into the slice -> converged; still misplaced while BUSY -> deferred', () => {
	const done = classifyRepair(
		'slice',
		[sl('claw-4', { changed: '1', restarted: '1' })],
		sl('claw-4')
	);
	assert.equal(done.outcome, 'converged');
	assert.equal(done.changed, '1 slice change(s) written, 1 restarted');
	const later = classifyRepair(
		'slice',
		[sl('claw-4', { changed: '1', busy: '1' }, [`BUSY ${UNIT}`])],
		sl('claw-4', { changed: '1', in_slice: '0' }, [DRIFT_1023])
	);
	assert.equal(later.outcome, 'deferred');
	assert.deepEqual(later.busy, [UNIT]);
});

// 2026-10-27: claw-4 and claw-6 each held this repo's standing runner at
// oom_score_adj 200 for 29 hours after CI_OOM became 500. The gate went red on
// `changed=1`; the converger keys on DRIFT notes and none named the rank.
const OOM_LOW = `OOM-RANK-DRIFT ${UNIT} kernel=200 want>=500`;

test('a standing unit below the CI OOM rank is planned as a slice repair', () => {
	const plan = planRepairs(null, { results: [sl('claw-6', { changed: '1' }, [OOM_LOW])] });
	assert.deepEqual(plan.repair, [{ node: 'claw-6', facet: 'slice', before: UNIT }]);
});

test('classifyRepair slice: a BUSY unit whose rank was raised live is converged, not deferred', () => {
	// The rank needs no restart, so a mid-job runner is fixed by the same pass.
	const v = classifyRepair(
		'slice',
		[sl('claw-6', { changed: '1', busy: '1' }, [`BUSY ${UNIT}`])],
		sl('claw-6')
	);
	assert.equal(v.outcome, 'converged');
	const stuck = classifyRepair(
		'slice',
		[sl('claw-6', { changed: '1' })],
		sl('claw-6', {}, [OOM_LOW])
	);
	assert.equal(stuck.outcome, 'unconverged');
	assert.match(stuck.why, /below the OOM rank/);
});

test('classifyRepair slice: idle and still outside the slice -> unconverged, carrying PLACE-FAILED', () => {
	const v = classifyRepair(
		'slice',
		[
			sl('claw-4', { changed: '1', failed: '1' }, [
				`PLACE-FAILED ${UNIT} (Slice=app.slice want=runners.slice)`,
			]),
		],
		sl('claw-4', { changed: '1', in_slice: '0' }, [DRIFT_1023])
	);
	assert.equal(v.outcome, 'unconverged');
	assert.match(v.why, /PLACE-FAILED/);
});

test('classifyRepair: a confirm or re-check that could not run is unconverged, with its reason', () => {
	const noRun = classifyRepair(
		'slice',
		[{ machine: 'claw-4', ok: false, error: 'ssh died' }],
		sl('claw-4')
	);
	assert.equal(noRun.outcome, 'unconverged');
	assert.match(noRun.why, /could not run: ssh died/);
	const noRead = classifyRepair('throttle', [thr('claw-4', { newly: 1 })], {
		machine: 'claw-4',
		ok: false,
		error: 'timeout',
	});
	assert.equal(noRead.outcome, 'unconverged');
	assert.match(noRead.why, /could not be re-read: timeout/);
});

// A node-side script behind the package is itself drift to repair: a hook
// fixed in the package does nothing until the node runs it.
test('planRepairs: a node whose ci-throttle.sh or standing.env lags the package is planned for throttle', () => {
	const plan = planRepairs(
		{
			results: [
				{ ...thr('claw-1', { wired: 2 }), scriptDrift: ['ci-throttle.sh'], standingEnv: 'ok' },
				{ ...thr('claw-2', { wired: 2 }), scriptDrift: [], standingEnv: 'stale' },
				{ ...thr('claw-3', { wired: 2 }), scriptDrift: [], standingEnv: 'ok' },
			],
		},
		{ results: [] }
	);
	assert.deepEqual(
		plan.repair.map((r) => `${r.node}: ${r.before}`),
		[
			'claw-1: node-side files behind this package: ci-throttle.sh',
			'claw-2: node-side files behind this package: standing.env',
		]
	);
});

test('classifyRepair throttle: scripts still behind after the redeploy is unconverged, never converged', () => {
	const v = classifyRepair('throttle', [thr('claw-1', { wired: 2 })], {
		...thr('claw-1', { wired: 2 }),
		scriptDrift: ['ci-throttle.sh'],
	});
	assert.equal(v.outcome, 'unconverged');
	assert.match(v.why, /node-side files still differ from this package: ci-throttle\.sh/);
	const ok = classifyRepair('throttle', [thr('claw-1', { wired: 2 })], {
		...thr('claw-1', { wired: 2 }),
		scriptDrift: [],
		standingEnv: 'ok',
	});
	assert.equal(ok.outcome, 'converged');
});

// --- what a LIVE JOB sees (2026-10-24) -------------------------------------
// The JOBTMP-BAD line is ci-throttle-install.sh's own shape: `<dir> pid=<n>`.
const SLOT = '/home/hadoku/.hadoku/jit/slot0';
const BAD = (pid) =>
	`JOBTMP-BAD ${SLOT} pid=${pid} TMPDIR=unset fs=tmpfs NODE_COMPILE_CACHE=unset fs=tmpfs`;

test('planRepairs: a live job writing temp to RAM is a throttle repair, though every .env file is right', () => {
	const plan = planRepairs(
		{
			results: [
				thr('claw-2', { jobtmpseen: 1, jobtmpbad: 1 }, [BAD(101)]),
				thr('claw-6', { jobtmpseen: 2, jobtmpbad: 0, runnerenv: 1, runnerenvkeys: 0 }),
				thr('claw-1', { jobtmpseen: 2, jobtmpbad: 0, runnerenv: 1, runnerenvkeys: 1 }),
			],
		},
		{ results: [] }
	);
	assert.deepEqual(
		plan.repair.map((r) => r.node),
		['claw-2', 'claw-6']
	);
	assert.match(plan.repair[0].before, /1 live job\(s\) write temp to RAM/);
	assert.match(plan.repair[1].before, /runner\.env is missing a key/);
});

test('classifyRepair: a job ALREADY bad before the repair is deferred; it keeps the env it started with', () => {
	const confirm = thr('claw-2', { jobtmpseen: 1, jobtmpbad: 1, runnerenv: 1, runnerenvkeys: 1 }, [
		BAD(101),
	]);
	const recheck = thr('claw-2', { jobtmpseen: 1, jobtmpbad: 1, runnerenv: 1, runnerenvkeys: 1 }, [
		BAD(101),
	]);
	const c = classifyRepair('throttle', [confirm], recheck);
	assert.equal(c.outcome, 'deferred', c.why);
	assert.match(c.why, /pid=101/);
});

test('classifyRepair: a job that STARTED after the repair and still writes to RAM is unconverged', () => {
	// Same slot, new pid: the next mint was built from what the repair wrote,
	// and it is still wrong. MUTATION: compare by directory alone and this
	// reads as the old job and defers.
	const confirm = thr('claw-2', { jobtmpseen: 1, jobtmpbad: 1, runnerenv: 1, runnerenvkeys: 1 }, [
		BAD(101),
	]);
	const recheck = thr('claw-2', { jobtmpseen: 1, jobtmpbad: 1, runnerenv: 1, runnerenvkeys: 1 }, [
		BAD(202),
	]);
	const c = classifyRepair('throttle', [confirm], recheck);
	assert.equal(c.outcome, 'unconverged');
	assert.match(c.why, /started since still write temp to RAM: .*pid=202/);
});

test('classifyRepair: runner.env still missing a key after the repair is unconverged; clean jobs converge', () => {
	const confirm = thr('claw-6', { runnerenv: 1, runnerenvkeys: 0 });
	const stillBad = classifyRepair(
		'throttle',
		[confirm],
		thr('claw-6', { jobtmpseen: 0, jobtmpbad: 0, runnerenv: 1, runnerenvkeys: 0 })
	);
	assert.equal(stillBad.outcome, 'unconverged');
	assert.match(stillBad.why, /runner\.env is still missing a key/);
	const fixed = classifyRepair(
		'throttle',
		[confirm],
		thr('claw-6', { jobtmpseen: 2, jobtmpbad: 0, runnerenv: 1, runnerenvkeys: 1 })
	);
	assert.equal(fixed.outcome, 'converged');
});

const apt = (machine, drift = [], extra = '') => ({
	machine,
	ok: true,
	summary: `SUMMARY origins=${drift.length ? 'wrong' : 'ok'} candidates=30 selected=${drift.length ? 0 : 29} drift=${drift.length}${extra}`,
	notes: drift.map((d) => `DRIFT ${d}`),
});
const NOTHING = '30 security update(s) are pending and the dry run selects none of them';

test('planRepairs apt-security: the 10-25 claws are planned, a clean or drained one is not, a locked one is unreadable', () => {
	const plan = planRepairs(null, null, {
		results: [
			apt('claw-4', [NOTHING]),
			apt('claw-1'),
			{ machine: 'claw-8', ok: false, expectedDown: true, error: 'ssh timed out' },
			{ machine: 'claw-9', ok: false, error: 'unattended-upgrade --dry-run exited 1: Cache lock' },
		],
	});
	assert.deepEqual(plan.repair, [{ node: 'claw-4', facet: 'apt-security', before: NOTHING }]);
	assert.deepEqual(plan.unreadable, [
		{
			node: 'claw-9',
			facet: 'apt-security',
			why: 'unattended-upgrade --dry-run exited 1: Cache lock',
		},
	]);
});

test('classifyRepair apt-security: judged by the re-check dry run, never deferred', () => {
	const confirm = apt('claw-4', [NOTHING], ' changed=1');
	assert.deepEqual(classifyRepair('apt-security', confirm, apt('claw-4')), {
		outcome: 'converged',
		changed: 'apt conf rewritten from the profile, timers enabled',
		why: '',
		busy: [],
	});
	const still = classifyRepair('apt-security', confirm, apt('claw-4', [NOTHING]));
	assert.equal(still.outcome, 'unconverged');
	assert.match(still.why, /the dry run still says: 30 security update/);
	const broken = classifyRepair(
		'apt-security',
		{ machine: 'claw-4', ok: false, error: 'repair failed: sudo: a password is required' },
		apt('claw-4')
	);
	assert.equal(broken.outcome, 'unconverged');
	assert.match(broken.why, /could not run: repair failed: sudo/);
});
