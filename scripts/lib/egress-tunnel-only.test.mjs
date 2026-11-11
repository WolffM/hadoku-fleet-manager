/**
 * The tunnel-only class of the egress taxonomy (fleet-manager#85): the pure
 * rules, the real manifest, and the real gate run against a stub PM2.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { tunnelOnlyPlacement, tunnelOnlyProblems } from './egress-tunnel-only.mjs';
import {
	FIXTURE_ANCHOR_ENTRY,
	appFindings,
	fixtureAnchor,
	runGate,
	spec,
} from './egress-slices-fixtures.mjs';

const XP = '/user.slice/user-1000.slice/user@1000.service/crossposter.slice';
const entry = (cgroup, apps = ['crossposter']) => ({ cgroup, apps, holds: 'x', why: 'a decision' });
const taxonomy = (tunnelOnly) => ({ directEgress: spec.directEgress, tunnelOnly });

void test('the real manifest declares crossposter tunnel-only, with no conflict', () => {
	assert.deepEqual(tunnelOnlyProblems(spec), []);
	const xp = spec.tunnelOnly.find((e) => e.apps.includes('crossposter'));
	assert.equal(xp?.cgroup, XP);
});

void test('no tunnelOnly key is no class and no problem: local-hawk reads it as optional', () => {
	assert.deepEqual(tunnelOnlyProblems({ directEgress: spec.directEgress }), []);
	assert.deepEqual(tunnelOnlyPlacement({ directEgress: [] }, 'crossposter', XP), {});
});

void test('a tunnel-only path may not overlap a direct-egress one, either way round', () => {
	const pm2 = '/system.slice/pm2-hadoku.service';
	for (const cgroup of [pm2, `${pm2}/inner.scope`, '/system.slice']) {
		const problems = tunnelOnlyProblems(taxonomy([entry(cgroup)]));
		assert.ok(
			problems.some((p) => p.status === 'tunnel-only-conflict'),
			`${cgroup} overlaps ${pm2} and must be refused`
		);
	}
	// A sibling whose name merely starts the same way is not under it.
	assert.deepEqual(tunnelOnlyProblems(taxonomy([entry(`${pm2}-other`)])), []);
});

void test('two tunnel-only entries may not overlap each other', () => {
	const problems = tunnelOnlyProblems(
		taxonomy([entry(XP), entry(`${XP}/workers.slice`, ['crossposter-worker'])])
	);
	assert.ok(problems.some((p) => p.status === 'tunnel-only-conflict'));
});

void test('an entry without a path, its apps or its reason is malformed', () => {
	const statuses = (e) => tunnelOnlyProblems(taxonomy([e])).map((p) => p.status);
	assert.ok(
		statuses({ cgroup: 'relative.slice', apps: ['a'], why: 'w' }).includes('tunnel-only-malformed')
	);
	assert.ok(statuses({ cgroup: XP, apps: [], why: 'w' }).includes('tunnel-only-malformed'));
	assert.ok(statuses({ cgroup: XP, apps: ['a'] }).includes('tunnel-only-malformed'));
	assert.ok(
		tunnelOnlyProblems({ directEgress: [], tunnelOnly: {} }).some(
			(p) => p.status === 'tunnel-only-malformed'
		)
	);
});

void test('placement: named and inside is tunnel-only, unnamed inside fails, named outside is pending', () => {
	const t = taxonomy([entry(XP)]);
	const scope = `${XP}/crossposter-run.slice/run-p1-i2.scope`;
	assert.deepEqual(tunnelOnlyPlacement(t, 'crossposter', scope).ok, {
		egress: 'tunnel-only',
		tunnelOnly: XP,
	});
	assert.equal(tunnelOnlyPlacement(t, 'wiki', scope).finding?.status, 'tunnel-only-unnamed');
	const pending = tunnelOnlyPlacement(t, 'crossposter', '/system.slice/pm2-hadoku.service');
	assert.equal(pending.pending?.tunnelOnly, XP);
	assert.equal(pending.ok, undefined);
	assert.equal(pending.finding, undefined);
	assert.deepEqual(tunnelOnlyPlacement(t, 'wiki', '/system.slice/pm2-hadoku.service'), {});
});

// THE REAL GATE. The tunnel-only cgroup is THIS process's own, so an app given
// this pid is observed inside it on any box the suite runs on, a claw's runner
// slice included. directEgress is a path nothing holds, so it cannot overlap.
const own = readFileSync('/proc/self/cgroup', 'utf8').trim().replace(/^0::/, '');
const gateSpec = (apps) => ({
	directEgress: [{ cgroup: '/fixture-direct.slice', holds: 'nothing', why: 'fixture' }],
	tunnelOnly: [{ cgroup: own, apps: ['fixture-anchor', ...apps], holds: 'x', why: 'fixture' }],
	ecosystemRoot: spec.ecosystemRoot,
	hokonLocal: [FIXTURE_ANCHOR_ENTRY],
});
const ecosystemApp = (name) => ({
	name,
	pid: process.pid,
	pm2_env: {
		status: 'online',
		pm_cwd: `/home/hadoku/srv/hadoku_site/apps/${name}`,
		unstable_restarts: 0,
		restart_time: 0,
	},
});

void test('gate: an ecosystem app named tunnel-only and placed there passes as tunnel-only', () => {
	const { report } = runGate([[fixtureAnchor, ecosystemApp('crossposter')]], {
		spec: gateSpec(['crossposter']),
	});
	assert.deepEqual(appFindings(report), []);
	const row = report.ok.find((o) => o.name === 'crossposter');
	assert.equal(row?.egress, 'tunnel-only');
	assert.equal(row?.tunnelOnly, own);
});

void test('gate: any OTHER app found in the tunnel-only cgroup fails', () => {
	const { report, code } = runGate([[fixtureAnchor, ecosystemApp('wiki')]], {
		spec: gateSpec(['crossposter']),
	});
	assert.deepEqual(
		appFindings(report).map((f) => [f.name, f.status]),
		[['wiki', 'tunnel-only-unnamed']]
	);
	assert.notEqual(code, 0);
});

void test('gate: a named app not moved yet is pending, and still judged where it runs', () => {
	// pid 1 is readable everywhere and sits outside both the tunnel-only cgroup
	// and the fixture's direct one: pending, AND the ecosystem finding it earns there.
	const notMoved = { ...ecosystemApp('crossposter'), pid: 1 };
	const { report } = runGate([[fixtureAnchor, notMoved]], { spec: gateSpec(['crossposter']) });
	assert.deepEqual(
		report.tunnelOnlyPending.map((p) => [p.name, p.tunnelOnly]),
		[['crossposter', own]]
	);
	assert.deepEqual(
		appFindings(report).map((f) => [f.name, f.status]),
		[['crossposter', 'ecosystem-outside-direct']]
	);
});
