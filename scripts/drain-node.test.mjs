/**
 * `fleet drain --kind reboot`: the reboot cycle's own drain kind.
 *
 * Runs the real script against a fixture manifest and an empty state dir.
 * Setting a drain sshes to the node afterwards to count running jobs, so `ssh`
 * is a stand-in on PATH that fails — the script's "could not reach" path, and
 * never a real claw.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';
import { oursOn, rebootNotice, rebootNoticeArgs } from './lib/reboot-cycle.mjs';

afterEach(cleanupTempDirs);

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'drain-node.mjs');

function run(...args) {
	return runIn(null, ...args);
}

/** `seed`: a drain doc written before the script runs. Returns the dir for a second run. */
function runIn(seed, ...args) {
	const dir = seed?.dir ?? tempDir('drain-node-');
	const bin = join(dir, 'bin');
	if (seed?.doc) writeFileSync(join(dir, 'fleet-drain.json'), JSON.stringify(seed.doc));
	if (!seed?.dir) mkdirSync(bin);
	writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nexit 255\n');
	chmodSync(join(bin, 'ssh'), 0o755);
	writeFileSync(
		join(dir, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				'claw-5': { role: 'claw', maxConcurrent: 2 },
				'claw-6': { role: 'claw', maxConcurrent: 2 },
			},
		})
	);
	const r = spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FLEET_MANIFEST_DIR: dir,
			HADOKU_STATE_DIR: dir,
		},
	});
	const file = join(dir, 'fleet-drain.json');
	return {
		dir,
		status: r.status,
		out: r.stdout + r.stderr,
		doc: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null,
	};
}

test('a reboot drain is accepted, and recorded as kind `reboot` with its end', () => {
	const r = run('claw-6', '--kind', 'reboot', '--for', '2h', '--reason', 'automated reboot: x');
	assert.equal(r.status, 0, r.out);
	const rec = r.doc?.nodes?.['claw-6'];
	assert.equal(rec?.kind, 'reboot');
	assert.equal(rec?.reason, 'automated reboot: x');
	assert.ok(Date.parse(rec?.until) > Date.now(), `until must be in the future: ${rec?.until}`);
});

test('a reboot drain with no end is refused — a reboot that never returns must lapse', () => {
	const r = run('claw-6', '--kind', 'reboot', '--reason', 'automated reboot: x');
	assert.equal(r.status, 1, r.out);
	assert.match(r.out, /a reboot needs an end/);
	assert.equal(r.doc?.nodes?.['claw-6'], undefined);
});

test("the reboot cycle's notice, written by the real script, is one the cycle recognises as its own", () => {
	const r = run(...rebootNoticeArgs('claw-6', 'automated reboot: x', 15));
	assert.equal(r.status, 0, r.out);
	const notice = rebootNotice(r.doc, 'claw-6');
	assert.ok(notice, JSON.stringify(r.doc));
	assert.ok(Date.parse(notice.from) - Date.now() > 14 * 60_000, `starts ${notice.from}`);
	assert.equal(oursOn(r.doc, 'claw-6'), true);
});

test('on a whole-box host the notice goes over the hosting record, and --undo cancels only the notice', () => {
	const hosting = {
		kind: 'hosting',
		reason: 'cardtable forge',
		since: new Date().toISOString(),
		hosting: { tenant: 'cardtable', memoryMb: 4096, cores: 2, port: 25565 },
	};
	const first = runIn(
		{ doc: { nodes: { 'claw-6': hosting }, planned: [] } },
		...rebootNoticeArgs('claw-6', 'automated reboot: x', 15)
	);
	assert.equal(first.status, 0, first.out);
	assert.ok(rebootNotice(first.doc, 'claw-6'), JSON.stringify(first.doc));
	assert.equal(first.doc.nodes['claw-6'].kind, 'hosting');
	const undo = runIn({ dir: first.dir }, 'claw-6', '--undo');
	assert.equal(undo.status, 0, undo.out);
	assert.equal(rebootNotice(undo.doc, 'claw-6'), undefined);
	assert.equal(undo.doc.nodes['claw-6'].kind, 'hosting', "the tenant's record survives");
});
