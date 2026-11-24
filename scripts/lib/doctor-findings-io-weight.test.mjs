/**
 * An io.weight the root disk does not enforce (hadoku-fleet-manager#158).
 *
 * HUB is the stanza's output shape on the hub host on 2026-11-24, cut to the
 * cgroups that matter: the root NVMe on `none` with io.cost empty, production
 * at 1000 in system.slice, agent scopes at 20 and CI at 25 in user.slice.
 * Cgroup paths below user.slice are synthetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
	IO_WEIGHT_SH,
	dilution,
	enableLine,
	ioWeightFacet,
	ioWeightFindings,
	ioWeightLine,
	parseQos,
} from './doctor-findings-io-weight.mjs';
import { parseDoctor } from './doctor-parse.mjs';
import { doctorProbe } from './doctor-probe.mjs';
import { doctorFindings } from './doctor-findings.mjs';
import { ADVISORY } from './preflight.mjs';
import { CLAW1, facetOf } from './doctor-fixtures.mjs';

const U = 'user.slice/user-fixture.slice/user@fixture.service';
const HUB = [
	'disk\t259:8\tnvme1n1\tnone',
	'weight\tsystem.slice\t100',
	'weight\tuser.slice\t100',
	'weight\tinit.scope\t100',
	'weight\tsystem.slice/pm2-prod.service\t1000',
	`weight\t${U}/app.slice/tmux-a.scope\t20`,
	`weight\t${U}/app.slice/tmux-b.scope\t20`,
	`weight\t${U}/ci.slice\t25`,
	'end',
];
const node = 'claw-fixture';
const ON =
	'qos\t259:8 enable=1 ctrl=auto rpct=95.00 rlat=25000 wpct=95.00 wlat=25000 min=50.00 max=150.00';

void test('the hub as measured: weights declared, the disk enforces none, production capped at half', () => {
	const w = ioWeightFacet(HUB);
	assert.equal(w.read, true);
	assert.deepEqual(w.disks, [
		{ dev: '259:8', name: 'nvme1n1', scheduler: 'none', ioCost: false, ctrl: null },
	]);
	assert.equal(w.declared.length, 4);
	const fs = ioWeightFindings({ node, ioWeight: w });
	assert.deepEqual(
		fs.map((x) => [x.category, x.status, x.class, x.shadow]),
		[
			['io-weight', 'unenforced', ADVISORY, true],
			['io-weight', 'diluted', ADVISORY, true],
		]
	);
	assert.match(fs[0].why, /echo "259:8 enable=1 ctrl=auto" > \/sys\/fs\/cgroup\/io\.cost\.qos/);
	assert.deepEqual(fs[0].disks, ['259:8']);
	assert.equal(fs[1].high, 'system.slice/pm2-prod.service');
	assert.equal(fs[1].share, 0.5);
	assert.match(fs[1].why, /holding .*tmux-a\.scope at 20/);
	assert.equal(
		ioWeightLine(w),
		'nvme1n1 none UNENFORCED; 4 cgroups declare io.weight 20..1000; system.slice/pm2-prod.service capped at 50%'
	);
});

void test('io.cost on, or bfq, enforces; a heavier system.slice is not diluted', () => {
	const on = ioWeightFacet([...HUB.slice(0, -1), ON, 'end']);
	assert.equal(on.disks[0].ioCost, true);
	assert.equal(on.disks[0].ctrl, 'auto');
	assert.deepEqual(
		ioWeightFindings({ node, ioWeight: on }).map((x) => x.status),
		['diluted']
	);

	const bfq = HUB.map((l) => l.replace('\tnone', '\tbfq'));
	const heavy = bfq.map((l) =>
		l === 'weight\tsystem.slice\t100' ? 'weight\tsystem.slice\t800' : l
	);
	assert.deepEqual(ioWeightFindings({ node, ioWeight: ioWeightFacet(heavy) }), []);
	assert.match(ioWeightLine(ioWeightFacet(heavy)), /^nvme1n1 bfq; 4 cgroups/);
});

void test('an enable=0 line is off, and a kernel without io.cost says so', () => {
	const off = ioWeightFacet([...HUB.slice(0, -1), 'qos\t259:8 enable=0 ctrl=auto', 'end']);
	assert.equal(off.disks[0].ioCost, false);
	const none = ioWeightFacet([...HUB.slice(0, -1), 'noiocost\tno io.cost', 'end']);
	assert.equal(none.ioCostAvailable, false);
	assert.equal(none.disks[0].ioCost, null);
	const [u] = ioWeightFindings({ node, ioWeight: none });
	assert.match(u.why, /io\.cost absent.*only the bfq scheduler/);
	assert.equal(parseQos('not a line'), null);
	assert.equal(enableLine('8:0'), '8:0 enable=1 ctrl=auto');
});

void test('nothing declared is nothing to enforce: a claw with default weights draws no finding', () => {
	const claw = [
		'disk\t8:0\tsda\tmq-deadline',
		'weight\tsystem.slice\t100',
		'weight\tuser.slice\t100',
		'end',
	];
	const w = ioWeightFacet(claw);
	assert.deepEqual(w.declared, []);
	assert.deepEqual(ioWeightFindings({ node, ioWeight: w }), []);
	assert.equal(ioWeightLine(w), 'sda mq-deadline UNENFORCED; no cgroup declares a weight');

	const one = ioWeightFacet([
		...claw.slice(0, -1),
		'weight\tuser.slice/user-fixture.slice\t25',
		'end',
	]);
	const [u] = ioWeightFindings({ node, ioWeight: one });
	assert.equal(u.status, 'unenforced');
	assert.match(u.why, /^user\.slice\/user-fixture\.slice declares io\.weight 25, but/);
});

void test('dilution only across top-level slices that hold a lower weight', () => {
	assert.equal(dilution([{ cgroup: 'system.slice', weight: 100 }]), null);
	// Same top-level slice: the weights compete directly, no cap.
	assert.equal(
		dilution([
			{ cgroup: 'user.slice/a', weight: 1000 },
			{ cgroup: 'user.slice/b', weight: 20 },
		]),
		null
	);
	// The heaviest cgroup is not diluted; the next one is, and that one is named.
	const d = dilution([
		{ cgroup: 'system.slice', weight: 100 },
		{ cgroup: 'user.slice', weight: 300 },
		{ cgroup: 'user.slice/s', weight: 1000 },
		{ cgroup: 'user.slice/low', weight: 20 },
		{ cgroup: 'system.slice/prod', weight: 500 },
	]);
	assert.equal(d.high, 'system.slice/prod');
	assert.equal(d.share, 0.25);
});

void test('could not look is never clean: cut off, no disk, not recorded', () => {
	const cut = ioWeightFacet(HUB.slice(0, -1));
	assert.equal(cut.read, false);
	assert.equal(ioWeightFindings({ node, ioWeight: cut })[0].status, 'unreadable');
	const fail = ioWeightFacet(['fail\tlsblk found no whole disk under /dev/x', 'end']);
	assert.equal(fail.why, 'lsblk found no whole disk under /dev/x');
	assert.equal(ioWeightFacet(['end']).read, false);
	assert.equal(ioWeightFacet(HUB, { ioWeight: 'probe refused' }).why, 'probe refused');
	const [old] = ioWeightFindings({ node });
	assert.equal(old.status, 'not-recorded');
	assert.equal(old.class, ADVISORY);
	assert.equal(ioWeightLine(undefined), 'not recorded');
	assert.match(ioWeightLine(cut), /^unread: /);
});

void test('the probe carries the stanza, parse keeps its lines, and doctorFindings judges them', () => {
	const probe = doctorProbe({ loadSeconds: 0 });
	assert.ok(probe.includes(IO_WEIGHT_SH));
	assert.match(probe, /^io_weight$/m);
	const parsed = parseDoctor(
		['DOCTOR-BEGIN v1', ...HUB.map((l) => `W ${l}`), 'DOCTOR-END claw-fixture'].join('\n')
	);
	assert.deepEqual(parsed.ioWeight, HUB);
	const health = { ...facetOf(CLAW1), ioWeight: ioWeightFacet(HUB) };
	assert.deepEqual(
		doctorFindings(health)
			.filter((x) => x.category === 'io-weight')
			.map((x) => x.status),
		['unenforced', 'diluted']
	);
});

void test('the stanza runs to its end on this box and finds the root disk', () => {
	const out = execFileSync('bash', ['-c', `${IO_WEIGHT_SH}\nio_weight`], { encoding: 'utf8' });
	const lines = out
		.split('\n')
		.filter((l) => l.startsWith('W '))
		.map((l) => l.slice(2));
	assert.ok(lines.includes('end'));
	const w = ioWeightFacet(lines);
	assert.equal(w.read, true, w.why);
	assert.ok(w.disks.length >= 1);
	assert.ok(w.disks.every((d) => /^\d+:\d+$/.test(d.dev)));
});
