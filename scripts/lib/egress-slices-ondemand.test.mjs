/**
 * An on-demand ECOSYSTEM service at rest is dormant, not `not-running`
 * (fleet-manager#64).
 *
 * `invoke` is declared `autostart: false` in hadoku_site's ecosystem
 * (dc003dfda): PM2 registers it stopped and only an explicit start runs it.
 * `ci:egress-slices` went red on 2026-11-02 and 2026-11-06, the days it rested,
 * and green 11-03 → 11-05 while it ran. The gate read its normal state as an
 * outage.
 *
 * The exemption is NARROW on purpose, and most of this file is the narrow half.
 * A stopped on-demand service is resting. The same service crash-looping,
 * `errored`, or stopped after a non-zero exit is broken. So is an
 * `autostart: true` ecosystem service PM2 would have started itself. None of
 * those may borrow the dormant answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { app, appFindings, fixtureAnchor, runGate, specWith } from './egress-slices-fixtures.mjs';

const spec = specWith([]);

/** invoke as `pm2 jlist` reported it on hokon, 2026-11-06. */
const invoke = (pm2_env = {}) =>
	app('invoke', {
		status: 'stopped',
		autostart: false,
		autorestart: true,
		// A STRING: that is what PM2 writes. The first draft of this fix compared
		// it with `=== 0`, passed a fixture holding a number, and missed invoke live.
		exit_code: '0',
		restart_time: 0,
		...pm2_env,
	});

void test('a resting on-demand service is dormant, not a finding, and costs no settle window', () => {
	const down = [fixtureAnchor, invoke()];
	const { report, calls } = runGate([down, down], { spec });

	// APP findings only, never the exit code: a box without the direct-egress
	// slices (every CI runner) adds slice-level findings this case is not about.
	assert.deepEqual(appFindings(report), [], 'resting is its normal state; it must not page');
	assert.equal(calls, 1, 'and it must not wait 9s to be told what PM2 already said');

	const d = (report.dormant ?? []).find((x) => x.name === 'invoke');
	assert.ok(d, 'still REPORTED: dormant is a third answer, not a pass');
	assert.equal(d.class, 'ecosystem');
	assert.equal(d.onDemand, true);
	assert.equal(d.pm2Status, 'stopped');
	assert.match(d.why, /autostart: false/);
	assert.ok(!(report.ok ?? []).some((o) => o.name === 'invoke'), 'no process, so not `ok`');
	assert.ok(!(report.deferred ?? []).some((o) => o.name === 'invoke'), 'and not a deferral');
});

void test('a numeric 0, or no exit code at all (never started), is resting too', () => {
	for (const exit_code of [0, undefined]) {
		const down = [fixtureAnchor, invoke({ exit_code })];
		const { report } = runGate([down, down], { spec });
		assert.deepEqual(appFindings(report), [], `exit_code=${JSON.stringify(exit_code)}`);
		assert.ok((report.dormant ?? []).some((x) => x.name === 'invoke'));
	}
});

/** Each of these is the on-demand service BROKEN, and each must still fail. */
const broken = [
	['crash-looping', { status: 'launching', unstable_restarts: 4 }],
	['errored', { status: 'errored' }],
	['waiting out a crash backoff', { status: 'waiting restart' }],
	['stopped by a flap', { unstable_restarts: 2 }],
	['stopped after a non-zero exit', { exit_code: '1' }],
	['stopped after a numeric non-zero exit', { exit_code: 1 }],
	['stopped by a signal', { exit_code: 'SIGKILL' }],
];

for (const [label, env] of broken) {
	void test(`an on-demand service ${label} is still a finding`, () => {
		const down = [fixtureAnchor, invoke(env)];
		const { report, code } = runGate([down, down], { spec });
		const f = appFindings(report).find((x) => x.name === 'invoke');
		assert.ok(f, `${label} must fail the gate`);
		assert.equal(f.status, 'not-running');
		assert.ok(!(report.dormant ?? []).some((x) => x.name === 'invoke'), 'never dormant');
		assert.notEqual(code, 0);
	});
}

void test('the exemption reads autostart from PM2 strictly: only an explicit false', () => {
	// `true` is every other ecosystem service, which PM2 starts on its own, so
	// stopped IS an outage. Missing reads as "nobody declared it", the strict side.
	for (const autostart of [true, undefined, 'false', 0]) {
		const down = [fixtureAnchor, invoke({ autostart })];
		const { report, code } = runGate([down, down], { spec });
		assert.ok(
			appFindings(report).some((x) => x.name === 'invoke' && x.status === 'not-running'),
			`autostart=${JSON.stringify(autostart)} must not exempt it`
		);
		assert.notEqual(code, 0);
	}
});

void test('only an ECOSYSTEM app earns it: an unclassified autostart:false app still fails', () => {
	// Classification comes first. `autostart: false` says when PM2 starts an app,
	// not what it is, so it cannot classify one.
	const stray = {
		...invoke(),
		name: 'stray',
		pm2_env: { ...invoke().pm2_env, pm_cwd: '/home/hadoku/stray' },
	};
	const down = [fixtureAnchor, stray];
	const { report, code } = runGate([down, down], { spec });
	assert.ok(
		appFindings(report).some((x) => x.name === 'stray'),
		'unclassified is a finding'
	);
	assert.ok(!(report.dormant ?? []).some((x) => x.name === 'stray'));
	assert.notEqual(code, 0);
});

void test('a resting on-demand service counts toward nothing-observed, so it is no off switch', () => {
	const down = [invoke()];
	const { report, code } = runGate([down, down], { spec });
	assert.ok(
		report.findings.some((f) => f.status === 'nothing-observed'),
		'a box whose whole PM2 list is resting on-demand services has lost the ecosystem'
	);
	assert.notEqual(code, 0);
});
