/**
 * `clamav`: the probe block EXECUTED, the registry's bar applied to what it
 * prints, and the toolchain entry that installs it on ingest nodes.
 *
 * WHAT RUNS. The real script, phase `presence`, under `/bin/bash` with a PATH
 * that is ONLY a fixture bin: stub `clamscan`, `systemctl` and `pgrep`, plus
 * the coreutils the block needs. So nothing on the host is asked: not its
 * clamav, not its units, not its processes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { capability, meetsBar } from '../dist/lib/capability-registry.js';
import {
	REPAIRS,
	applicableRepairs,
	installScript,
	toolAppliesTo,
} from './lib/toolchain-floor.mjs';
import { INGEST_LABELS } from './lib/toolchain-clamav.mjs';

const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'capability-probe.sh');

function which(u) {
	for (const d of ['/usr/bin', '/bin', '/usr/local/bin']) {
		if (existsSync(join(d, u))) return join(d, u);
	}
	throw new Error(`${u} not found on this host`);
}

/** `Sat Nov 14 22:27:28 2026`, the date clamscan prints, `days` ago, in UTC. */
function ctime(days) {
	const d = new Date(Date.now() - days * 86_400_000);
	const [dow, mon] = [
		['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()],
		['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
			d.getUTCMonth()
		],
	];
	return `${dow} ${mon} ${d.getUTCDate()} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`;
}

/**
 * @param {object} o
 * @param {string | null} [o.version]  what `clamscan --version` prints; null = no clamscan
 * @param {Record<string, string[]>} [o.units]  per unit, the `is-*` verbs that succeed
 * @param {boolean} [o.clamd]  whether a clamd process is running
 */
async function probeClamav({
	version = `ClamAV 1.4.3/28184/${ctime(0.5)}`,
	units = { 'clamav-freshclam': ['is-active', 'is-enabled'] },
	clamd = false,
} = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-probe-clamav-'));
	const bin = join(root, 'bin');
	for (const d of [bin, join(root, 'tmp'), join(root, 'home')]) mkdirSync(d, { recursive: true });
	for (const u of ['date', 'mktemp', 'rm', 'cat', 'hostname', 'cut', 'awk']) {
		symlinkSync(which(u), join(bin, u));
	}
	const stub = (name, body) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	if (version !== null) stub('clamscan', `echo '${version}'`);
	const cases = Object.entries(units)
		.flatMap(([unit, verbs]) => verbs.map((v) => `"${v} -q ${unit}") exit 0 ;;`))
		.join('\n');
	stub('systemctl', `case "$1 $2 $3" in\n${cases}\nesac\nexit 1`);
	stub('pgrep', clamd ? '[ "$2" = clamd ] && exit 0; exit 1' : 'exit 1');
	try {
		const { stdout } = await promisify(execFile)('/bin/bash', [PROBE], {
			encoding: 'utf8',
			cwd: root,
			timeout: 60_000,
			env: {
				PATH: bin,
				HOME: join(root, 'home'),
				TMPDIR: join(root, 'tmp'),
				TZ: 'UTC',
				CAP_PROBE_PHASE: 'presence',
			},
		});
		return stdout.split('\n').find((l) => l.startsWith('CAP clamav ')) ?? null;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** The registry's verdict on one probe line. */
function judge(line) {
	const [, , status, detail] = line.split(' ');
	return meetsBar(capability('clamav'), status === 'ok', detail);
}

test('fresh signatures and an enabled, active freshclam: ok, the age first, then version and clamd', async () => {
	const line = await probeClamav();
	assert.equal(line, 'CAP clamav ok 0.5d,clamav-1.4.3,clamd-off');
	assert.deepEqual(judge(line), { proven: true, reason: 'signature age 0.5 days' });
});

test('the probe measures and never judges: 9-day-old signatures print ok, the registry refuses them', async () => {
	const line = await probeClamav({ version: `ClamAV 1.4.3/28000/${ctime(9)}` });
	assert.equal(line, 'CAP clamav ok 9.0d,clamav-1.4.3,clamd-off');
	assert.deepEqual(judge(line), {
		proven: false,
		reason: 'signature age 9 days > 7 days allowed',
	});
});

test('each failure is named, never a zero', async () => {
	assert.equal(await probeClamav({ version: null }), 'CAP clamav no no-clamscan');
	assert.equal(await probeClamav({ version: 'ClamAV 1.4.3' }), 'CAP clamav no no-signature-date');
	assert.equal(await probeClamav({ units: {} }), 'CAP clamav no freshclam-inactive');
	// hokon, 2026-11-15: freshclam running, but not enabled, so it stops at the next reboot.
	assert.equal(
		await probeClamav({ units: { 'clamav-freshclam': ['is-active'] } }),
		'CAP clamav no freshclam-not-enabled'
	);
});

test('a standing clamd is named in the detail and does not change the verdict', async () => {
	const enabled = await probeClamav({
		units: {
			'clamav-freshclam': ['is-active', 'is-enabled'],
			'clamav-daemon.socket': ['is-enabled'],
		},
	});
	assert.equal(enabled, 'CAP clamav ok 0.5d,clamav-1.4.3,clamd-enabled');
	const running = await probeClamav({ clamd: true });
	assert.equal(running, 'CAP clamav ok 0.5d,clamav-1.4.3,clamd-running');
	assert.equal(judge(running).proven, true);
});

/** A node whose bootcamp record earned `earned`. */
const node = (earned) => ({ role: 'claw', $capabilities: { earned } });

test('the clamav tool goes only where the ingest can land: every one of its other labels', () => {
	assert.deepEqual(INGEST_LABELS, ['nvenc-h264', 'data-peer']);
	assert.equal(toolAppliesTo('clamav', node(['nvenc-h264', 'data-peer'])), true);
	assert.equal(toolAppliesTo('clamav', node(['data-peer'])), false, 'no encoder: claw-2');
	assert.equal(toolAppliesTo('clamav', node(['nvenc-h264'])), false, 'not admitted');
	assert.equal(toolAppliesTo('clamav', {}), false);
	assert.ok(
		applicableRepairs(node(['nvenc-h264', 'data-peer'])).some(([id]) => id === 'clamav'),
		'bootcamp installs only tools that declare a `when`, so it must have one'
	);
	assert.match(String(REPAIRS.clamav.when), /nvenc-h264 and data-peer/);
});

test('the install is apt-tracked, enables freshclam, and never installs the daemon', () => {
	const script = installScript('clamav');
	assert.equal(REPAIRS.clamav.apt, 'clamav');
	assert.match(script, /apt-get install -y -qq clamav clamav-freshclam$/m);
	assert.match(script, /systemctl enable --now clamav-freshclam/);
	assert.doesNotMatch(script, /clamav-daemon|clamdscan/);
	assert.match(script, /systemctl disable --now clamav-freshclam-once\.timer/);
});

/**
 * Runs the repair's detect against a stub `clamscan` and `systemctl` that
 * answer from `units` (unit -> the verbs it passes), as the toolchain does.
 */
async function detect(units) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-detect-clamav-'));
	try {
		const bin = join(root, 'bin');
		mkdirSync(bin);
		writeFileSync(join(bin, 'clamscan'), '#!/bin/sh\necho "ClamAV 1.4.6"\n', { mode: 0o755 });
		const cases = Object.entries(units)
			.flatMap(([unit, verbs]) => verbs.map((v) => `"${v} ${unit}") exit 0 ;;`))
			.join('\n\t');
		writeFileSync(
			join(bin, 'systemctl'),
			`#!/bin/sh\n[ "$2" = -q ] && shift_q="$1 $3" || shift_q="$1 $2"\ncase "$shift_q" in\n\t${cases}\nesac\nexit 1\n`,
			{ mode: 0o755 }
		);
		const r = await promisify(execFile)('sh', ['-c', REPAIRS.clamav.detect], {
			env: { PATH: `${bin}:/usr/bin:/bin` },
		}).catch((e) => e);
		return (r.stdout ?? '').trim();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('detect: one updater running and enabled is OK', async () => {
	assert.equal(await detect({ 'clamav-freshclam': ['is-active', 'is-enabled'] }), 'OK');
});

test('detect: the daily -once timer still enabled beside the daemon is drift (claw-1, 11-23)', async () => {
	assert.equal(
		await detect({
			'clamav-freshclam': ['is-active', 'is-enabled'],
			'clamav-freshclam-once.timer': ['is-enabled'],
		}),
		''
	);
});

test('detect: a daemon that lost the lock race and stayed dead is drift', async () => {
	assert.equal(
		await detect({
			'clamav-freshclam': ['is-enabled'],
			'clamav-freshclam-once.timer': ['is-enabled'],
		}),
		''
	);
});
