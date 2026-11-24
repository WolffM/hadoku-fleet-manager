import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDoctor, cpuSensor, independentCpuSensors } from './doctor-parse.mjs';
import { healthFacet } from './doctor-facet.mjs';
import { doctorFindings } from './doctor-findings.mjs';
import { BLOCKING } from './preflight.mjs';
import { CLAW1, CLAW9, facetOf } from './doctor-fixtures.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// PARSING
// ═══════════════════════════════════════════════════════════════════════════

void test('a run without DOCTOR-END is SILENCE, not an empty result', () => {
	const truncated = CLAW1.slice(0, CLAW1.indexOf('DOCTOR-END'));
	assert.equal(parseDoctor(truncated).complete, false);
	assert.equal(parseDoctor(CLAW1).complete, true);
	assert.equal(parseDoctor('').complete, false);
	const h = healthFacet({ node: 'claw-1', probe: parseDoctor(truncated) });
	assert.equal(h.reachable, false);
	assert.equal(doctorFindings(h)[0].category, 'unreachable');
	assert.equal(doctorFindings(h)[0].class, BLOCKING);
});

void test('cpuSensor picks ONE die sensor in a fixed order, never the maximum', () => {
	// claw-1's acpitz zone 2 read 96 °C in one sample with the package at 76 °C.
	// A max-of-all-zones reader calls that node pinned at idle, which is very
	// probably where the "claw-1 98 °C" in the planning docs came from.
	assert.equal(
		cpuSensor(['zone.0.acpitz', 'zone.2.acpitz', 'zone.3.x86_pkg_temp']),
		'zone.3.x86_pkg_temp'
	);
	assert.equal(
		cpuSensor(['zone.3.x86_pkg_temp', 'hwmon.3.coretemp.Package_id_0']),
		'hwmon.3.coretemp.Package_id_0',
		'coretemp package outranks the thermal zone'
	);
	assert.equal(
		cpuSensor(['hwmon.5.k10temp.Tctl', 'hwmon.5.k10temp.Tccd1']),
		'hwmon.5.k10temp.Tccd1',
		'the AMD die outranks Tctl, which may carry a vendor offset'
	);
	assert.equal(
		cpuSensor(['hwmon.1.k10temp.temp1', 'hwmon.2.nouveau.temp1']),
		'hwmon.1.k10temp.temp1',
		"claw-5's unlabelled family-15h k10temp is still a die sensor"
	);
	assert.equal(cpuSensor(['hwmon.2.nouveau.temp1', 'hwmon.0.nvme.Composite']), null);
});

void test('independentCpuSensors: only readings of the SAME package vouch for the die', () => {
	// The "independent readings" of the tracking rule. claw-9 as captured:
	// six per-core sensors beside the package, and the x86_pkg_temp ZONE is not
	// one of them — it is the package reading exposed twice, and counting it
	// would let a sensor vouch for itself.
	const claw9 = Object.keys(facetOf(CLAW9).thermal.idleSensors);
	assert.deepEqual(independentCpuSensors('hwmon.1.coretemp.Package_id_0', claw9), [
		'hwmon.1.coretemp.Core_0',
		'hwmon.1.coretemp.Core_1',
		'hwmon.1.coretemp.Core_2',
		'hwmon.1.coretemp.Core_3',
		'hwmon.1.coretemp.Core_4',
		'hwmon.1.coretemp.Core_5',
	]);
	// hokon: Tctl is a sibling channel on the same k10temp chip — the only
	// witness an AMD part offers, and a real one (Tctl moved +10 while Tccd1
	// moved +11 on the recorded run).
	assert.deepEqual(
		independentCpuSensors('hwmon.5.k10temp.Tccd1', [
			'hwmon.5.k10temp.Tctl',
			'hwmon.5.k10temp.Tccd1',
			'hwmon.4.amdgpu.edge',
			'hwmon.3.nvme.Composite',
		]),
		['hwmon.5.k10temp.Tctl'],
		'same chip, same driver, other channel'
	);
	// claw-5: the unlabelled family-15h k10temp is ALONE on its chip — the
	// nouveau beside it is a GPU on another device and must not vouch.
	assert.deepEqual(
		independentCpuSensors('hwmon.1.k10temp.temp1', [
			'hwmon.1.k10temp.temp1',
			'hwmon.2.nouveau.temp1',
		]),
		[],
		'a GPU never vouches for a CPU die'
	);
	// A second socket's package cannot move with this die under a load pinned
	// here, and as a reference it could only drag the median down.
	assert.deepEqual(
		independentCpuSensors('hwmon.2.coretemp.Package_id_0', [
			'hwmon.2.coretemp.Package_id_0',
			'hwmon.2.coretemp.Package_id_1',
			'hwmon.2.coretemp.Core_0',
		]),
		['hwmon.2.coretemp.Core_0'],
		'Package_id_1 is another socket'
	);
	// A core die is vouched for by its siblings and its own package …
	assert.deepEqual(
		independentCpuSensors('hwmon.2.coretemp.Core_0', [
			'hwmon.2.coretemp.Core_0',
			'hwmon.2.coretemp.Core_1',
			'hwmon.2.coretemp.Package_id_0',
		]),
		['hwmon.2.coretemp.Core_1', 'hwmon.2.coretemp.Package_id_0']
	);
	// … and a zone die key has no per-core zones beside it — nothing vouches.
	assert.deepEqual(
		independentCpuSensors('zone.3.x86_pkg_temp', ['zone.3.x86_pkg_temp', 'zone.2.acpitz']),
		[]
	);
});

void test('a counter sharing the `idle.` prefix is not read as a sensor', () => {
	// `idle.throttleCount` is 2,022,029 lifetime events on claw-1; a prefix-only
	// filter read it as 2022 °C and raised a sensor-disagreement finding on a
	// healthy node.
	const h = facetOf(CLAW1);
	assert.ok(!('throttleCount' in h.thermal.idleSensors));
	assert.equal(h.thermal.throttleTotal, 2_022_029);
	assert.equal(h.thermal.throttleEvents, 23_650);
});
