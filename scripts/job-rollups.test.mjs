/**
 * `fleet job-rollups` strict argv, run DIRECTLY (bypassing the door) — one
 * of the per-script tests wave 5b left open (plan §4.1 F8).
 *
 * job-rollups is read-only (its own header: "writes nothing, calls no
 * GitHub endpoint and reaches no machine"), but the strict-argv contract is
 * the same for every script: an unknown flag reaching it by some path other
 * than the door must be refused — exit 2, nothing run — before it reads the
 * rollup store. Modelled on `scripts/lib/cli-help.test.mjs`'s sandbox for
 * consistency with the other four scripts in this sweep, even though this
 * one script has no node-reaching tool to stand in for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'job-rollups.mjs');

const STUBS = [
	'ssh',
	'scp',
	'rsync',
	'gh',
	'sudo',
	'apt',
	'apt-get',
	'systemctl',
	'npm',
	'pnpm',
	'curl',
];

const madeDirs = [];
test.after(() => {
	for (const d of madeDirs) rmSync(d, { recursive: true, force: true });
});

function sandbox() {
	const dir = mkdtempSync(join(tmpdir(), 'job-rollups-strict-argv-'));
	madeDirs.push(dir);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	mkdirSync(join(dir, 'home'));
	mkdirSync(join(dir, 'state'));
	const log = join(dir, 'touched.log');
	for (const s of STUBS) {
		writeFileSync(join(bin, s), `#!/bin/sh\necho "${s} $*" >> "${log}"\nexit 97\n`);
		chmodSync(join(bin, s), 0o755);
	}
	return { dir, bin, log };
}

function run(args, sb) {
	return spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: 'utf8',
		timeout: 15_000,
		env: {
			PATH: `${sb.bin}:${process.env.PATH}`,
			HOME: join(sb.dir, 'home'),
			HADOKU_STATE_DIR: join(sb.dir, 'state'),
			FLEET_MANIFEST_DIR: join(sb.dir, 'no-manifests'),
			HADOKU_SITE_ROOT: join(sb.dir, 'no-site'),
			REPOS_DIR: join(sb.dir, 'no-repos'),
			MGMT_API_URL: 'http://127.0.0.1:9',
			FLEET_NO_BANNER: '1',
		},
	});
}

test('fleet-manager#F8: job-rollups.mjs run DIRECTLY with an unknown flag exits 2 and touches nothing', () => {
	const sb = sandbox();
	const r = run(['--not-a-real-flag'], sb);
	const touched = existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim() : '';
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.match(r.stdout + r.stderr, /unknown flag\(s\) --not-a-real-flag/);
	assert.equal(touched, '', `job-rollups.mjs called external tools:\n${touched}`);
});

test('fleet-manager#F8: --help still answers, even in the same sandbox', () => {
	const sb = sandbox();
	const r = run(['--help'], sb);
	const touched = existsSync(sb.log) ? readFileSync(sb.log, 'utf8').trim() : '';
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(touched, '', `job-rollups.mjs --help called external tools:\n${touched}`);
});

/**
 * Characterization for wave shrink-1 lane A dedup: `--days` validation, the
 * "no store" refusal and the `missingDays` gap-naming moved to
 * `scripts/lib/rollup-cli.mjs`, shared with `failures.mjs`/`stats.mjs`.
 * Nothing here was covered before this move — this file previously carried
 * only the two strict-argv tests above.
 */
test('--days must be a positive integer', () => {
	const sb = sandbox();
	const r = run(['--days', 'nope', '--json'], sb);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, false);
	assert.match(doc.error, /--days must be a positive integer, got "nope"/);
});

test('no store at all is "could not look", not "no jobs" — exit 1', () => {
	const sb = sandbox();
	const r = run(['--json'], sb);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, false);
	assert.match(doc.error, /no rollups at/);
	assert.match(doc.error, /not "no jobs"/);
});

test('an EXISTING store with zero days is not a failure here (unlike failures.mjs/stats.mjs) — job-rollups.mjs still has a fromDay to report against', () => {
	const sb = sandbox();
	writeFileSync(join(sb.dir, 'state', 'job-rollups.jsonl'), '');
	const r = run(['--json'], sb);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, true);
	assert.deepEqual(doc.rollups, []);
});

test('missingDays: a day the store never closed is named, not silently skipped', () => {
	const sb = sandbox();
	// A rollup 10 days ago — `--days 14` pulls it into range. 12 days ago sits
	// well inside that window and well past the settle horizon (comfortably
	// closable), but nothing was ever written for it, so it must be named.
	// Both days are picked well clear of either window edge (the fixture-dates
	// note: a boundary pinned to "today" is one UTC midnight from flaking).
	const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
	const held = day(10);
	const gap = day(12);
	const rollup = {
		schema: 1,
		day: held,
		writtenAt: `${held}T06:00:00.000Z`,
		completeSince: `${held}T00:00:00.000Z`,
		records: 1,
		probesExcluded: 0,
		rows: [],
	};
	writeFileSync(join(sb.dir, 'state', 'job-rollups.jsonl'), `${JSON.stringify(rollup)}\n`);
	const r = run(['--days', '14', '--json'], sb);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, true);
	assert.ok(doc.missingDays.includes(gap), JSON.stringify(doc.missingDays));
	assert.ok(!doc.missingDays.includes(held), JSON.stringify(doc.missingDays));
});
