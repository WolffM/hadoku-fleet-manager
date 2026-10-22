/**
 * `capability-probe.sh`'s `pm2-host` block, EXECUTED against a stub pm2
 * (2026-10-11).
 *
 * `pm2-host` routes six hadoku_site workflows (redeploy-mgmt-api among them),
 * so it must mean "this box is the HUB", not "this box supervises something".
 * Until today the two were the same population. #105 makes claw-4 a remote
 * PM2 host — pygmalion online under its own daemon, no mgmt-api — and the old
 * "any app online" rule would have earned it the label on its next bootcamp.
 *
 * WHAT RUNS. The real script, phase `presence`, under `/bin/bash` with a PATH
 * that is ONLY a fixture bin: a stub `pm2` plus the coreutils the block needs.
 * The daemon is made ALIVE the way the probe checks it — a pid file holding a
 * live pid (this test's own) and a real listening socket at `rpc.sock` — under
 * a fixture PM2_HOME, so the host's real daemon is never asked.
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
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'capability-probe.sh');

function which(u) {
	for (const d of ['/usr/bin', '/bin', '/usr/local/bin']) {
		if (existsSync(join(d, u))) return join(d, u);
	}
	throw new Error(`${u} not found on this host`);
}

/**
 * @param {object} o
 * @param {string[]} o.online  names of the apps the stub jlist reports online
 * @param {string} o.hubPid  what the stub `pm2 pid mgmt-api` prints
 */
async function probePm2Host({ online, hubPid }) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-probe-pm2host-'));
	const bin = join(root, 'bin');
	const home = join(root, 'home');
	const pm2Home = join(home, '.pm2');
	for (const d of [bin, join(root, 'tmp'), pm2Home]) mkdirSync(d, { recursive: true });
	for (const u of [
		'date',
		'mktemp',
		'rm',
		'sleep',
		'cat',
		'hostname',
		'chmod',
		'tr',
		'grep',
		'wc',
	]) {
		symlinkSync(which(u), join(bin, u));
	}
	const jlist = JSON.stringify(
		online
			.map((name) => ({ name, pm2_env: { status: 'online' } }))
			.concat([{ name: 'valheim', pm2_env: { status: 'stopped' } }])
	);
	writeFileSync(join(root, 'jlist.json'), jlist);
	writeFileSync(
		join(bin, 'pm2'),
		[
			'#!/bin/sh',
			`case "$1" in`,
			`jlist) cat ${JSON.stringify(join(root, 'jlist.json'))} ;;`,
			`pid) [ "$2" = mgmt-api ] && printf '%s\\n' ${JSON.stringify(hubPid)} ;;`,
			'esac',
		].join('\n') + '\n'
	);
	chmodSync(join(bin, 'pm2'), 0o755);
	writeFileSync(join(pm2Home, 'pm2.pid'), `${process.pid}\n`);
	const sock = createServer();
	await new Promise((r) => sock.listen(join(pm2Home, 'rpc.sock'), r));
	try {
		const { stdout } = await promisify(execFile)('/bin/bash', [PROBE], {
			encoding: 'utf8',
			cwd: root,
			timeout: 60_000,
			env: { PATH: bin, HOME: home, TMPDIR: join(root, 'tmp'), CAP_PROBE_PHASE: 'presence' },
		});
		const line = stdout.split('\n').find((l) => l.startsWith('CAP pm2-host '));
		assert.ok(line, `no pm2-host line in:\n${stdout}`);
		return line;
	} finally {
		await new Promise((r) => sock.close(r));
		rmSync(root, { recursive: true, force: true });
	}
}

test('the hub — mgmt-api online beside the rest — earns pm2-host', async () => {
	assert.equal(
		await probePm2Host({ online: ['mgmt-api', 'tunnel', 'pygmalion'], hubPid: '1679' }),
		'CAP pm2-host ok 3-online'
	);
});

test('a remote PM2 host — apps online, no mgmt-api — does NOT', async () => {
	assert.equal(
		await probePm2Host({ online: ['pygmalion'], hubPid: '' }),
		'CAP pm2-host no 1-online-without-mgmt-api'
	);
});

test('the hub with mgmt-api STOPPED is not answering as the hub', async () => {
	// `pm2 pid` prints 0 for a known app that is not running.
	assert.equal(
		await probePm2Host({ online: ['tunnel', 'datastore'], hubPid: '0' }),
		'CAP pm2-host no 2-online-without-mgmt-api'
	);
});

test('a daemon supervising nothing is still no', async () => {
	assert.equal(
		await probePm2Host({ online: [], hubPid: '' }),
		'CAP pm2-host no daemon-up-but-no-app-online'
	);
});
