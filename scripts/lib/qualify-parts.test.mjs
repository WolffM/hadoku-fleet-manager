import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUALIFY_TESTS } from './qualify-playlist.mjs';
import { QUALIFY_BARS, normalizeResult, validateTest } from './qualify-registry.mjs';
import {
	QUALIFY_RESULTS_FILE,
	mergeQualifyResults,
	readQualifyResults,
	recordQualifyResults,
} from './qualify-results.mjs';
import { parseSamples, startSamplerScript, stopSamplerScript } from './qualify-sampler.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'qualify-node.mjs');

// ── registry ───────────────────────────────────────────────────────────────

void test('the operator-approved bars (2026-11-11) are the registry constants', () => {
	assert.deepEqual(
		{ ...QUALIFY_BARS },
		{
			cpuPressureP90Pct: 20,
			packageTempC: 90,
			newThrottleEvents: 0,
			durationRatio: 1.5,
			watchdogOrOomEvents: 0,
		}
	);
	assert.ok(Object.isFrozen(QUALIFY_BARS));
});

void test('every registered test meets the contract', () => {
	for (const t of QUALIFY_TESTS) assert.deepEqual(validateTest(t), [], t.id);
});

void test('validateTest names every breach', () => {
	assert.deepEqual(validateTest(null), ['not an object']);
	const bad = validateTest({
		id: 'x',
		track: 'nightly',
		needsDrain: 'yes',
		runsAs: 'root',
		ttlDays: 0,
	});
	assert.equal(bad.length, 6, bad.join(' | '));
});

void test('normalizeResult keeps a good result and refuses to repair a bad one', () => {
	assert.deepEqual(normalizeResult({ status: 'fail', reason: 'hot', metrics: { c: 96 } }), {
		status: 'fail',
		reason: 'hot',
		metrics: { c: 96 },
	});
	assert.equal(normalizeResult(undefined).status, 'could-not-look');
	assert.equal(normalizeResult({ status: 'pass', reason: '  ' }).status, 'could-not-look');
});

// ── results ledger ─────────────────────────────────────────────────────────

void test('a pass sets lastPass; a later fail or could-not-look keeps it', () => {
	let l = mergeQualifyResults({}, 'n', [{ id: 'ramp', status: 'pass', reason: 'k=3' }], 'T1');
	l = mergeQualifyResults(l, 'n', [{ id: 'ramp', status: 'could-not-look', reason: 'busy' }], 'T2');
	assert.equal(l['n::ramp'].last.status, 'could-not-look');
	assert.equal(l['n::ramp'].lastPass.at, 'T1');
	l = mergeQualifyResults(l, 'n', [{ id: 'ramp', status: 'fail', reason: 'hot' }], 'T3');
	assert.equal(l['n::ramp'].lastPass.at, 'T1');
});

void test('the ledger: missing is empty; an unreadable one is said and never overwritten', () => {
	const dir = mkdtempSync(join(tmpdir(), 'qualify-ledger-'));
	try {
		assert.deepEqual(readQualifyResults(dir), { ok: true, results: {} });
		assert.deepEqual(
			recordQualifyResults(dir, 'n', [{ id: 'a', status: 'pass', reason: 'x' }], 'T'),
			{ ok: true }
		);
		assert.equal(readQualifyResults(dir).results['n::a'].last.at, 'T');
		writeFileSync(join(dir, QUALIFY_RESULTS_FILE), '{ torn');
		assert.equal(
			recordQualifyResults(dir, 'n', [{ id: 'a', status: 'pass', reason: 'x' }], 'T2').ok,
			false
		);
		assert.equal(readFileSync(join(dir, QUALIFY_RESULTS_FILE), 'utf8'), '{ torn');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── sampler ────────────────────────────────────────────────────────────────

void test('parseSamples: an unreadable value is null, never 0; a tick cut short is dropped', () => {
	const rows = parseSamples(
		[
			'S 100 cpu10=1.5 cpu300=22.1 io10=U mem10=0 workers=3 throttle=U',
			'T hwmon.1.coretemp.Package_id_0 88000',
			'E',
			'S 105 cpu10=2 cpu300=23 io10=0 mem10=0 workers=3 throttle=4',
			'T hwmon.1.coretemp.Package_id_0 89000',
		].join('\n')
	);
	assert.equal(rows.length, 1);
	assert.deepEqual(rows[0], {
		at: 100,
		cpuSome10: 1.5,
		cpuSome300: 22.1,
		ioSome10: null,
		memSome10: 0,
		workers: 3,
		throttle: null,
		temps: { 'hwmon.1.coretemp.Package_id_0': 88 },
	});
});

void test('the sampler runs for real here: starts detached, samples, stops on the sentinel, cleans up', async () => {
	// everySec 3 is LONGER than the stop script's own 1 s wait: on claw-5
	// (2026-11-11) a loop asleep through the stop woke to a deleted directory,
	// found no `stop` file in it, and kept sampling until maxMinutes.
	const out = execFileSync('bash', ['-s'], {
		input: startSamplerScript({ everySec: 3, maxMinutes: 1 }),
		encoding: 'utf8',
	});
	const dir = out.match(/^SAMPLER (\S+)$/m)?.[1];
	assert.ok(dir, out);
	// WAIT FOR ONE WHOLE TICK, not a fixed 1.5 s. parseSamples rightly drops a
	// tick cut short (no `E`), and on a loaded box (cpu10=72, 2026-11-12) the
	// first tick's sensors read outran 1.5 s, so the stop landed mid-tick and the
	// test saw zero rows. Bounded well inside maxMinutes.
	const samples = join(dir, 'samples');
	const deadline = Date.now() + 20_000;
	while (!(existsSync(samples) && /^E$/m.test(readFileSync(samples, 'utf8')))) {
		assert.ok(Date.now() < deadline, 'the sampler finished no tick within 20 s');
		await new Promise((r) => setTimeout(r, 100));
	}
	const text = execFileSync('bash', ['-s'], { input: stopSamplerScript(dir), encoding: 'utf8' });
	assert.match(text, /SAMPLER-END/);
	const rows = parseSamples(text);
	assert.ok(rows.length >= 1, text);
	assert.ok(Number.isFinite(rows[0].at));
	assert.ok(!existsSync(dir), 'the sampler left its directory behind');
	const left = spawnSync('pgrep', ['-f', dir], { encoding: 'utf8' });
	assert.equal(left.stdout.trim(), '', 'the sampler loop is still running');
});

void test('stopSamplerScript refuses a directory it did not make', () => {
	assert.throws(() => stopSamplerScript('/var/lib'), /unexpected sampler dir/);
	assert.throws(
		() => stopSamplerScript("/tmp/qualify-sample.x'; rm -rf ~"),
		/unexpected sampler dir/
	);
});

// ── the CLI's refusals (no ssh, no drain) ──────────────────────────────────

function cli(args, machines) {
	const root = mkdtempSync(join(tmpdir(), 'qualify-cli-'));
	const manifests = join(root, 'manifests');
	const state = join(root, 'state');
	mkdirSync(manifests);
	mkdirSync(state);
	writeFileSync(join(manifests, 'fleet-runner-manifest.json'), JSON.stringify({ machines }));
	writeFileSync(join(state, 'fleet-drain.json'), JSON.stringify({ nodes: {} }));
	try {
		const r = spawnSync(process.execPath, [CLI, ...args], {
			env: {
				...process.env,
				FLEET_MANIFEST_DIR: manifests,
				HADOKU_STATE_DIR: state,
				HADOKU_SITE_ROOT: root,
			},
			encoding: 'utf8',
			timeout: 60_000,
		});
		return {
			code: r.status,
			doc: r.stdout ? JSON.parse(r.stdout) : null,
			err: r.stderr,
			drain: readFileSync(join(state, 'fleet-drain.json'), 'utf8'),
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

void test('fleet qualify without --machine is refused, exit 2', () => {
	const r = cli(['--json'], { 'claw-fixture': { role: 'claw' } });
	assert.equal(r.code, 2);
	assert.match(r.doc.error, /--machine is required/);
});

void test('fleet qualify on the backstop is refused, exit 2, nothing drained', () => {
	const r = cli(['--machine', 'fixture-backstop', '--json'], {
		'fixture-backstop': { role: 'backstop' },
	});
	assert.equal(r.code, 2, r.err);
	assert.match(r.doc.reason, /hokon remains the backstop/);
	assert.deepEqual(JSON.parse(r.drain), { nodes: {} });
});

void test('--dry-run lists the real playlist with budgets, exit 0, and drains nothing', () => {
	// The empty-playlist case is the runner's (qualify-runner.test.mjs).
	const r = cli(['--machine', 'claw-fixture', '--dry-run', '--json'], {
		'claw-fixture': { role: 'claw' },
	});
	assert.equal(r.code, 0, r.err);
	assert.equal(r.doc.status, 'dry-run');
	assert.deepEqual(
		r.doc.results.map((x) => x.id),
		QUALIFY_TESTS.map((t) => t.id)
	);
	assert.ok(QUALIFY_TESTS.length > 0);
	for (const x of r.doc.results)
		assert.match(x.reason, /^dry run: would run as (ci|admin), up to \d+ min$/);
	assert.deepEqual(JSON.parse(r.drain), { nodes: {} });
});

void test('a node with NO live job still reports every field: pgrep -c prints 0 AND exits 1', async () => {
	// claw-1/claw-5, 2026-11-11: `pgrep -c … || echo 0` printed "0\n0", the tick
	// line broke after `workers=`, and throttle read null on every idle tick.
	const bin = mkdtempSync(join(tmpdir(), 'qualify-pgrep-'));
	writeFileSync(join(bin, 'pgrep'), '#!/bin/sh\necho 0\nexit 1\n', { mode: 0o755 });
	try {
		const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
		const out = execFileSync('bash', ['-s'], {
			input: startSamplerScript({ everySec: 1, maxMinutes: 1 }),
			encoding: 'utf8',
			env,
		});
		const dir = out.match(/^SAMPLER (\S+)$/m)?.[1];
		await new Promise((r) => setTimeout(r, 1500));
		const text = execFileSync('bash', ['-s'], {
			input: stopSamplerScript(dir),
			encoding: 'utf8',
			env,
		});
		const ticks = text.split('\n').filter((l) => l.startsWith('S '));
		assert.ok(ticks.length >= 1, text);
		for (const l of ticks) assert.match(l, / workers=0 throttle=\S+$/, l);
		assert.equal(parseSamples(text)[0].workers, 0);
	} finally {
		rmSync(bin, { recursive: true, force: true });
	}
});

void test('--next with only a backstop: none due, exit 0, nothing drained', () => {
	const r = cli(['--next', '--json'], { 'fixture-backstop': { role: 'backstop' } });
	assert.equal(r.code, 0, r.err);
	assert.deepEqual([r.doc.status, r.doc.node, r.doc.ok], ['none-due', null, true]);
	assert.deepEqual(JSON.parse(r.drain), { nodes: {} });
});

void test('--next and --machine together are refused, exit 2', () => {
	const r = cli(['--next', '--machine', 'claw-fixture', '--json'], {
		'claw-fixture': { role: 'claw' },
	});
	assert.equal(r.code, 2);
	assert.match(r.doc.error, /exclusive/);
});
