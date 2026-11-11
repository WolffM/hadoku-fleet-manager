import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { doctorProbe, BACKSTOP_CADENCE_NO_LOAD_WHY, PM2_UNITS_PROBE } from './doctor-probe.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// THE PROBE
// ═══════════════════════════════════════════════════════════════════════════

void test('the probe wraps WIFI_MANAGER_PROBE so its `exit 0` cannot end the run', () => {
	const p = doctorProbe();
	// The bug this pins: inlined bare, the shared wifi stanza's trailing `exit 0`
	// terminated the whole probe, every node truncated before DOCTOR-END, and a
	// box that had just answered sixty lines read as UNREACHABLE.
	assert.match(p, /\(\s*r=;[\s\S]*exit 0 \)/, 'the wifi stanza must run in a subshell');
	const afterWifi = p.slice(p.lastIndexOf('exit 0 )'));
	assert.match(afterWifi, /DOCTOR-END/, 'DOCTOR-END must still be reachable after it');
});

void test('the probe emits its own sentinels and a 60s load by default', () => {
	const p = doctorProbe();
	assert.match(p, /DOCTOR-BEGIN v1/);
	assert.match(p, /LOADSECS=60/);
	assert.match(p, /sha512sum \/dev\/zero/);
});

void test('--no-load says WHY there is no reading rather than omitting it', () => {
	const p = doctorProbe({ loadSeconds: 0 });
	assert.doesNotMatch(p, /LOADSECS=/);
	assert.match(p, /unk load "the load phase was disabled with --no-load/);
});

void test('the load phase refuses a busy node unless forced', () => {
	assert.match(doctorProbe().replace(/\n/g, ' '), /BUSY.*-gt 0.*FORCE.*!= 1/);
	assert.match(doctorProbe({ force: true }), /FORCE=1/);
});

void test('sensors() is ONE function, used for idle and for every load sample', () => {
	// If the two halves could enumerate sensors differently, `idle.<key>` and
	// `peak.<key>` would not be the same physical sensor and picking the die
	// sensor on the control side would be worthless.
	const p = doctorProbe();
	assert.equal((p.match(/^sensors\(\) \{$/gm) ?? []).length, 1);
	assert.match(p, /while read -r k v; do printf "D idle\.%s/);
	assert.match(p, /sample\(\) \{ while read -r k v;[\s\S]*< <\(sensors\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// `doctorProbe`'s `seedCachePaths` — embedded into a remote shell, so validated
// ═══════════════════════════════════════════════════════════════════════════

void test('doctorProbe embeds a well-formed seed cache path, expanded under $HOME', () => {
	const probe = doctorProbe({ loadSeconds: 0, seedCachePaths: ['~/.cache/cardtable-forge'] });
	assert.match(probe, /consumer\.seed\|~\/\.cache\/cardtable-forge/);
	assert.match(probe, /\$HOME\/\.cache\/cardtable-forge/);
});

void test('doctorProbe silently drops a seed cache path that does not match SAFE_CACHE_PATH', () => {
	// Not `~`-rooted, and a path carrying a shell metacharacter — neither may
	// reach the remote command line unvalidated.
	const probe = doctorProbe({
		loadSeconds: 0,
		seedCachePaths: ['/etc/passwd', '~/.cache/evil; rm -rf /', '~/ok/path'],
	});
	assert.doesNotMatch(probe, /\/etc\/passwd/);
	assert.doesNotMatch(probe, /rm -rf/);
	assert.match(
		probe,
		/consumer\.seed\|~\/ok\/path/,
		'a well-formed path alongside bad ones still gets through'
	);
});

test('a --cadence backstop probe never loads the box, and says why in the record', () => {
	const probe = doctorProbe({ loadSeconds: 0, noLoadWhy: BACKSTOP_CADENCE_NO_LOAD_WHY });
	assert.ok(!probe.includes('sha512sum'), 'no load generator may reach the backstop');
	assert.ok(probe.includes(BACKSTOP_CADENCE_NO_LOAD_WHY));
	assert.throws(() => doctorProbe({ loadSeconds: 0, noLoadWhy: 'x"; rm -rf ~; "' }), /unsafe/);
});

// ═══════════════════════════════════════════════════════════════════════════
// PM2_UNITS_PROBE — EXECUTED against stub systemctl/ps, not pattern-matched
// ═══════════════════════════════════════════════════════════════════════════

/** Run the pm2 stanza with `systemctl` and `ps` answering from `units`. */
function runPm2Probe(units) {
	const dir = mkdtempSync(join(tmpdir(), 'pm2-probe-'));
	try {
		const list = units.map((u) => `${u.unit} loaded active running x`).join('\n');
		const pid = (u) => u.pid ?? 0;
		writeFileSync(
			join(dir, 'systemctl'),
			[
				'#!/bin/bash',
				`[ "$1" = list-units ] && { printf '%s\\n' '${list}'; exit 0; }`,
				...units.map(
					(u) =>
						`[ "$3" = MainPID ] && [ "$4" = ${u.unit} ] && { echo ${pid(u)}; exit 0; }\n` +
						`[ "$3" = ControlGroup ] && [ "$4" = ${u.unit} ] && { echo /system.slice/${u.unit}; exit 0; }`
				),
				'exit 1',
			].join('\n')
		);
		writeFileSync(
			join(dir, 'ps'),
			[
				'#!/bin/bash',
				...units
					.filter((u) => u.pid)
					.map(
						(u) =>
							`[ "$1 $2 $3" = "-o args= -p" ] && [ "$4" = ${u.pid} ] && { ${u.args === undefined ? 'exit 1' : `echo '${u.args}'`}; exit 0; }\n` +
							`[ "$1" = --ppid ] && [ "$2" = ${u.pid} ] && { for i in $(seq 1 ${u.children ?? 0}); do echo child; done; exit 0; }`
					),
				'exit 1',
			].join('\n')
		);
		chmodSync(join(dir, 'systemctl'), 0o755);
		chmodSync(join(dir, 'ps'), 0o755);
		const script = [
			'say() { if [ -n "${2:-}" ]; then printf "D %s %s\\n" "$1" "$2"; else printf "U %s\\n" "$1"; fi; }',
			'unk() { printf "U %s %s\\n" "$1" "$2"; }',
			'effmax() { echo max; }',
			PM2_UNITS_PROBE,
		].join('\n');
		return execFileSync('bash', ['-c', script], {
			env: { PATH: `${dir}:/usr/bin:/bin` },
			encoding: 'utf8',
		})
			.trim()
			.split('\n');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

void test('a pm2-* unit whose live process is not the God Daemon is not a pm2 manager', () => {
	// hokon, 2026-11-11: pm2-oom-guard.service runs `bash /usr/local/sbin/pm2-oom-guard`
	// and doctor reported it as an unclaimed pm2 manager every night.
	const out = runPm2Probe([
		{
			unit: 'pm2-hadoku.service',
			pid: 1989,
			args: 'PM2 v7.0.1: God Daemon (/home/hadoku/.pm2)',
			children: 3,
		},
		{ unit: 'pm2-oom-guard.service', pid: 2605471, args: 'bash /usr/local/sbin/pm2-oom-guard' },
	]);
	assert.deepEqual(out.sort(), ['D pm2Unit.pm2-hadoku.service max 3', 'D pm2Units.count 1']);
});

void test('a pm2-* unit with no process to read is KEPT, with its app count unknown', () => {
	// A failed manager (MainPID 0) and one that exited between the two reads
	// have nothing to identify them by; dropping them would hide a dead manager.
	const out = runPm2Probe([
		{ unit: 'pm2-dead.service', pid: 0 },
		{ unit: 'pm2-raced.service', pid: 4242, args: undefined },
	]);
	assert.deepEqual(out.sort(), [
		'D pm2Unit.pm2-dead.service max U',
		'D pm2Unit.pm2-raced.service max U',
		'D pm2Units.count 2',
	]);
});
