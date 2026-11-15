/**
 * The CPU clock check, end to end: the shell reader EXECUTED (under bash,
 * which doctor runs, and sh, which benchmark runs) against cpuinfo captured
 * from claw-5 and claw-10, then the facet and the judge on the readings
 * `fleet doctor` took on 2026-11-15.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CPU_CLOCK_SH, doctorProbe } from './doctor-probe.mjs';
import { healthRecord } from './doctor-facet.mjs';
import { clockFindings } from './doctor-findings-clock.mjs';
import { doctorFindings } from './doctor-findings.mjs';
import { CLOCK_STUCK_FRACTION } from './doctor-findings-thresholds.mjs';
import { CLAW1, CLAW5, facetOf, find, NOW } from './doctor-fixtures.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// THE READER, EXECUTED
// ═══════════════════════════════════════════════════════════════════════════

/** Captured 2026-11-15 (`/proc/cpuinfo`, core 0's identity lines and three cores' clocks). */
const CPUINFO_CLAW5 = [
	'vendor_id\t: AuthenticAMD',
	'cpu family\t: 21',
	'model name\t: AMD FX(tm)-8350 Eight-Core Processor',
	'flags\t\t: fpu tsc constant_tsc aperfmperf',
	'cpu MHz\t\t: 1399.380',
	'cpu MHz\t\t: 1399.982',
	'cpu MHz\t\t: 1399.744',
].join('\n');
const CPUINFO_CLAW10 = [
	'vendor_id\t: GenuineIntel',
	'cpu family\t: 6',
	'model name\t: Intel(R) Core(TM) i7-2700K CPU @ 3.50GHz',
	'flags\t\t: fpu tsc constant_tsc aperfmperf',
	'cpu MHz\t\t: 3610.721',
	'cpu MHz\t\t: 3635.754',
	'cpu MHz\t\t: 3622.830',
].join('\n');

/** claw-5's P-state MSRs C001_0064..6B, read 2026-11-15. */
const PSTATES_CLAW5 = [
	'800001860000141a',
	'8000018600001619',
	'8000017700001e1b',
	'8000015f00002e12',
	'8000014b0000400c',
	'8000013600005405',
	'800001240000684c',
	'0000000000000000',
];

/**
 * Run one reader call under `shell`, against `cpuinfo` and an optional
 * cpufreq maximum. `SUDO=false` makes every privileged step fail, so nothing
 * here loads a module or reads a register on the machine running the test.
 */
function run(shell, call, { cpuinfo, maxKhz = null } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'cpu-clock-'));
	try {
		const env = { PATH: '/usr/bin:/bin', SUDO: 'false' };
		if (cpuinfo !== undefined) {
			writeFileSync(join(dir, 'cpuinfo'), `${cpuinfo}\n`);
			env.CLOCK_CPUINFO = join(dir, 'cpuinfo');
			env.CLOCK_SYS = join(dir, 'sys');
			if (maxKhz !== null) {
				mkdirSync(join(dir, 'sys/cpu0/cpufreq'), { recursive: true });
				writeFileSync(join(dir, 'sys/cpu0/cpufreq/cpuinfo_max_freq'), `${maxKhz}\n`);
			}
		}
		return execFileSync(shell, ['-c', `set -u\n${CPU_CLOCK_SH}\n${call}`], {
			env,
			encoding: 'utf8',
		}).trim();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

for (const shell of ['bash', 'sh']) {
	void test(`${shell}: claw-5's P-state table decodes to its MHz, and a disabled entry to nothing`, () => {
		const out = PSTATES_CLAW5.map((h) => run(shell, `clock_pstate_mhz ${h}`));
		assert.deepEqual(out, ['4200', '4100', '4300', '3400', '2800', '2100', '1400', '']);
	});

	void test(`${shell}: the ceiling is cpufreq's maximum when there is one`, () => {
		assert.equal(
			run(shell, 'clock_ceiling', { cpuinfo: CPUINFO_CLAW10, maxKhz: 3900000 }),
			'3900 cpufreq'
		);
	});

	void test(`${shell}: with no cpufreq, the clock in the model name`, () => {
		assert.equal(run(shell, 'clock_ceiling', { cpuinfo: CPUINFO_CLAW10 }), '3500 brand');
	});

	void test(`${shell}: claw-5 has neither, and an unreadable P-state table is said, not guessed`, () => {
		const out = run(shell, 'clock_ceiling', { cpuinfo: CPUINFO_CLAW5 });
		assert.match(out, /^- .*AMD P-state registers could not be read/);
	});

	void test(`${shell}: a CPU this reader cannot decode is refused with its vendor and family`, () => {
		const cpuinfo = CPUINFO_CLAW10.replace(' @ 3.50GHz', '');
		assert.equal(
			run(shell, 'clock_ceiling', { cpuinfo }),
			'- no cpufreq driver, no clock in the model name, and no P-state table this reader decodes (GenuineIntel, family 6)'
		);
	});

	void test(`${shell}: the running clock is the median and the max across cores`, () => {
		assert.equal(run(shell, 'clock_now', { cpuinfo: CPUINFO_CLAW5 }), '1400 1400 3');
		assert.equal(run(shell, 'clock_now', { cpuinfo: CPUINFO_CLAW10 }), '3623 3636 3');
	});

	void test(`${shell}: without aperfmperf the per-core figure is nominal, so it is refused`, () => {
		const cpuinfo = CPUINFO_CLAW10.replace(' aperfmperf', '');
		assert.match(run(shell, 'clock_now', { cpuinfo }), /^- .*no aperfmperf flag/);
	});
}

void test('on this machine, both readers answer in their own format', () => {
	// The real /proc and /sys of whatever box runs the suite: a node itself.
	assert.match(run('bash', 'clock_ceiling'), /^(\d+ (cpufreq|brand|msr-pstate)|- .+)$/);
	assert.match(run('bash', 'clock_now'), /^(\d+ \d+ \d+|- .+)$/);
});

// ═══════════════════════════════════════════════════════════════════════════
// THE PROBE: ceiling always, running clock only inside the load
// ═══════════════════════════════════════════════════════════════════════════

void test('the probe reads the ceiling even when there is no load phase', () => {
	assert.match(doctorProbe({ loadSeconds: 0 }), /CC=\$\(clock_ceiling\)/);
	assert.doesNotMatch(doctorProbe({ loadSeconds: 0 }), /csample/);
});

void test('the running clock is sampled inside the load loop, never after it ends', () => {
	const probe = doctorProbe();
	const loop = probe.split('\n').filter((l) => l.includes('csample'));
	// The definition, and one call: inside the `while … date … END` loop.
	assert.equal(loop.length, 2);
	assert.match(
		loop[1],
		/while \[ "\$\(date \+%s\)" -lt "\$END" \]; do sample; csample; sleep 3; done/
	);
	const afterWait = probe.slice(probe.indexOf('wait 2>/dev/null'));
	assert.doesNotMatch(afterWait, /csample;|clock_now/);
});

// ═══════════════════════════════════════════════════════════════════════════
// FACET AND JUDGE, on what doctor read 2026-11-15
// ═══════════════════════════════════════════════════════════════════════════

const withLines = (raw, lines) => raw.replace(/\nDOCTOR-END/, `\n${lines.join('\n')}\nDOCTOR-END`);

const CLOCK_CLAW5 = [
	'D clock.ceilingMhz 4300',
	'D clock.ceilingSource msr-pstate',
	'D load.clockBestMhz 1400',
	'D load.clockLastMhz 1400',
	'D load.clockSamples 20',
];
const CLOCK_CLAW1 = [
	'D clock.ceilingMhz 3500',
	'D clock.ceilingSource cpufreq',
	'D load.clockBestMhz 3293',
	'D load.clockLastMhz 2843',
	'D load.clockSamples 19',
];

void test('claw-5: 1400 MHz under load against a 4300 MHz table is stuck, and says so with the numbers', () => {
	const h = facetOf(withLines(CLAW5, CLOCK_CLAW5));
	assert.deepEqual(h.clock, {
		ceilingMhz: 4300,
		ceilingSource: 'msr-pstate',
		ceilingWhy: null,
		loadBestMhz: 1400,
		loadLastMhz: 1400,
		loadSamples: 20,
		loadWhy: null,
	});
	const fs = find(doctorFindings(h, { nowMs: NOW }), 'cpu-clock');
	assert.equal(fs.length, 1);
	assert.equal(fs[0].class, 'advisory');
	assert.equal(fs[0].status, 'stuck');
	assert.match(fs[0].why, /1400 MHz .* 4300 MHz \(msr-pstate\): 33 %/);
});

void test('claw-1: a laptop holding 3293 of 3500 under load is not stuck', () => {
	const h = facetOf(withLines(CLAW1, CLOCK_CLAW1));
	assert.deepEqual(find(doctorFindings(h, { nowMs: NOW }), 'cpu-clock'), []);
});

void test(`the line is ${CLOCK_STUCK_FRACTION} of the ceiling: at it is clean, one MHz under is stuck`, () => {
	const at = (best) => ({
		node: 'claw-x',
		clock: {
			ceilingMhz: 4000,
			ceilingSource: 'cpufreq',
			loadBestMhz: best,
			loadLastMhz: best,
			loadSamples: 20,
		},
	});
	assert.deepEqual(clockFindings(at(4000 * CLOCK_STUCK_FRACTION)), []);
	assert.equal(clockFindings(at(4000 * CLOCK_STUCK_FRACTION - 1))[0].status, 'stuck');
});

void test('no ceiling is "could not look", with the node\'s own reason', () => {
	const h = facetOf(
		withLines(CLAW5, [
			'U clock.ceiling no cpufreq driver and no clock in the model name, and the AMD P-state registers could not be read (root and the msr module are needed)',
			'D load.clockBestMhz 1400',
		])
	);
	const [fd] = find(doctorFindings(h, { nowMs: NOW }), 'cpu-clock');
	assert.equal(fd.status, 'unjudged');
	assert.equal(fd.class, 'advisory');
	assert.match(fd.why, /P-state registers could not be read/);
});

void test('no load phase is "could not look", carrying why the load did not run', () => {
	const h = facetOf(
		withLines(CLAW5, [
			'D clock.ceilingMhz 4300',
			'D clock.ceilingSource msr-pstate',
			'U load CI was building here (1 worker(s))',
		])
	);
	const [fd] = find(doctorFindings(h, { nowMs: NOW }), 'cpu-clock');
	assert.equal(fd.status, 'unjudged');
	assert.match(fd.why, /CI was building here/);
});

void test('the clock is STORED in the record, so a judgement from the record matches the live one', () => {
	const h = facetOf(withLines(CLAW5, CLOCK_CLAW5));
	const stored = JSON.parse(JSON.stringify(healthRecord(h)));
	assert.deepEqual(clockFindings(stored), clockFindings(h));
});

void test('a record written before the reader existed carries no clock, and gets no clock finding', () => {
	const old = facetOf(CLAW5);
	delete old.clock;
	assert.deepEqual(clockFindings(old), []);
});
