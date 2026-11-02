import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDoctor, cpuSensor, independentCpuSensors, parseSmart } from './doctor-parse.mjs';
import { healthFacet } from './doctor-facet.mjs';
import { doctorFindings } from './doctor-findings.mjs';
import { BLOCKING } from './preflight.mjs';
import { CLAW1, CLAW9, CLAW7_SMART, facetOf } from './doctor-fixtures.mjs';

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

void test('SMART reads the RAW_VALUE column, not the normalised one', () => {
	// claw-1's drive is 19,727 hours at 39 °C. Reading the wrong column gave
	// 55 hours at 150 °C — both plausible-looking numbers, both the normalised
	// columns, and neither of them a measurement of anything.
	const s = parseSmart(parseDoctor(CLAW1).smart);
	assert.equal(s.health, 'PASSED');
	assert.equal(s.powerOnHours, 19_727);
	assert.equal(s.temperatureC, 39);
	assert.equal(s.reallocated, 0);
	assert.equal(s.pendingSectors, 0);
});

void test('Percent_Lifetime_Remain is a percent USED in the raw column', () => {
	// claw-7's MX100: normalised 067, raw 33, summing to 100. The attribute NAME
	// describes the normalised column; the raw column is the used half.
	const s = parseSmart(CLAW7_SMART);
	assert.equal(s.powerOnHours, 91_529);
	assert.equal(s.lifetimeRemainingPct, 67);
	assert.equal(s.temperatureC, 35);
	assert.equal(s.reallocated, 1);
});

void test('an NVMe SMART log is read from its key/value shape', () => {
	const s = parseSmart([
		'SMART/Health Information (NVMe Log 0x02)',
		'SMART overall-health self-assessment test result: PASSED',
		'Temperature:                        44 Celsius',
		'Available Spare:                    100%',
		'Percentage Used:                    4%',
		'Power On Hours:                     1,280',
		'Media and Data Integrity Errors:    0',
	]);
	assert.equal(s.powerOnHours, 1280, 'thousands separators are stripped');
	assert.equal(s.temperatureC, 44);
	assert.equal(s.lifetimeRemainingPct, 96);
});

void test('a drive that REFUSED SMART is never read as PASSED', () => {
	// claw-4 carries four empty USB card-reader slots that answer exactly this.
	const s = parseSmart([
		'smartctl 7.4 2023-08-01 r5530 [x86_64-linux-6.12.94+deb13-amd64] (local build)',
		'/dev/sdc: Unknown USB bridge [0x058f:0x6362 (0x100)]',
		'Please specify device type with the -d option.',
	]);
	assert.equal(s.health, null);
	assert.match(s.reason, /Unknown USB bridge/);
});
