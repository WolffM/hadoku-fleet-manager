import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { BACKSTOP, CLAW, fixture, run } from './lib/bootcamp-fixtures.mjs';

test('the backstop is bootcamped like a claw, named or fleet-wide', () => {
	// The fixture nodes do not resolve, so each probe attempt shows up as
	// unreachable — proof it was TRIED.
	const f = fixture();
	try {
		const named = JSON.parse(run(['--machine', BACKSTOP, '--json'], f.env).out);
		assert.deepEqual(named.unreachable, [BACKSTOP]);
		const all = JSON.parse(run(['--json'], f.env).out);
		assert.deepEqual(all.unreachable.sort(), [BACKSTOP, CLAW].sort());
		assert.equal(all.ok, false);
		assert.equal(all.roleDeclared, undefined);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a manifest of no nodes still FAILS LOUDLY rather than passing on zero nodes', () => {
	// Zero probed yields zero findings, which is byte-identical to a healthy
	// fleet — the shape `check-capability-schema` already refuses for a manifest
	// of no machines.
	const f = fixture();
	try {
		const doc = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
		doc.machines = {};
		writeFileSync(f.manifestPath, JSON.stringify(doc, null, 2));
		const r = run(['--json'], f.env);
		assert.equal(r.code, 1);
		// Since fleet-manager#20-#26 a --json refusal is a document that says
		// why, never empty stdout — and never a clean report.
		const refusal = JSON.parse(r.out);
		assert.equal(refusal.ok, false, 'no clean report from a run that probed nobody');
		assert.match(refusal.error, /before writing its --json document: ./);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a run without --write leaves the manifest byte-identical', () => {
	// The refusal path runs before every other guard in the script, so this is
	// belt and braces on the fixture as much as on the reporting path.
	const f = fixture();
	try {
		const before = readFileSync(f.manifestPath, 'utf8');
		run(['--json'], f.env);
		run(['--machine', BACKSTOP, '--json'], f.env);
		assert.equal(readFileSync(f.manifestPath, 'utf8'), before, 'byte-identical');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// --- --check-only installs and seeds nothing (2026-10-25 audit) -------------
//
// `fleet provision`'s "DRY RUN" ran bootcamp with no flags, and bootcamp's
// default installs. `ssh` here is a stand-in: every tool's detect answers
// present EXCEPT pm2 (absent), and any script carrying pm2's install is
// recorded. pm2 is presence-only (no release lookup), so nothing leaves the box.

function pm2Fixture() {
	const f = fixture();
	const doc = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
	doc.machines[CLAW] = { ...doc.machines[CLAW], services: 'pm2' };
	writeFileSync(f.manifestPath, JSON.stringify(doc, null, 2));
	const bin = join(f.root, 'bin');
	mkdirSync(bin);
	const log = join(f.root, 'installs.log');
	writeFileSync(
		join(bin, 'ssh'),
		[
			'#!/bin/sh',
			'script=$(cat)',
			'case "$script" in',
			`  *"npm install -g"*pm2*) echo "INSTALL pm2" >> "${log}" ;;`,
			'  *"command -v pm2 >/dev/null 2>&1 && pm2 --version"*) : ;;',
			'  *"echo OK"*) echo OK ;;',
			'esac',
			'exit 0',
			'',
		].join('\n')
	);
	chmodSync(join(bin, 'ssh'), 0o755);
	return { ...f, log, env: { ...f.env, PATH: `${bin}:${process.env.PATH}` } };
}

test('the default run INSTALLS a missing tool — the baseline that makes the next test meaningful', () => {
	const f = pm2Fixture();
	try {
		run(['--machine', CLAW, '--json'], f.env);
		assert.match(existsSync(f.log) ? readFileSync(f.log, 'utf8') : '', /INSTALL pm2/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--check-only probes the same node and installs NOTHING', () => {
	const f = pm2Fixture();
	try {
		const r = run(['--machine', CLAW, '--json', '--check-only'], f.env);
		assert.equal(existsSync(f.log) ? readFileSync(f.log, 'utf8') : '', '', 'nothing installed');
		const report = JSON.parse(r.out);
		assert.deepEqual(report.tools[CLAW], [], 'no install was even attempted');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
