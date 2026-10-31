/**
 * The cron half of the T7 job sink (`emit.mjs`'s `recordRegistryRun`): every
 * real `fleet <sub> --json` run is a SEPARATE process, so this exercises it
 * exactly that way — spawn a script that imports the real `emit.mjs`, read
 * the row back from the real `job-run-store.js` afterwards.
 *
 * THE CONTRACT THIS MUST NOT TOUCH: stdout and the exit code. Every test
 * below that compares "recording on" against "recording off" asserts BYTE
 * equality on stdout and the SAME exit code, not merely "both looked fine" —
 * that is the whole point of a hook bolted onto the one function this
 * package already gates for exactly this (`emit.test.mjs`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jobRunDir, readJobRuns } from '../../dist/job-run-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EMIT_PATH = join(HERE, 'emit.mjs');

/** A real registered job (JOB_REGISTRY's own `ci:queue-health`), so `registryKindFor` matches it. */
const REAL_JOB = 'ci:queue-health';

/** `createEmitter()` + `emit(payload)` + `process.exit(code)`, the real caller shape. */
function emitterScript(dir, payload, code = 0) {
	const script = join(dir, 'caller.mjs');
	writeFileSync(
		script,
		[
			`import { createEmitter } from ${JSON.stringify(EMIT_PATH)};`,
			'const out = createEmitter({ json: true });',
			`out.emit(${JSON.stringify(payload)});`,
			`process.exit(${code});`,
		].join('\n')
	);
	return script;
}

/** A script that crashes before ever reaching `emit()` — the exit-guard's own fallback path. */
function crashingScript(dir) {
	const script = join(dir, 'crasher.mjs');
	writeFileSync(
		script,
		[
			`import { createEmitter } from ${JSON.stringify(EMIT_PATH)};`,
			'void createEmitter;',
			'throw new Error("fixture crash before emit()");',
		].join('\n')
	);
	return script;
}

function run(script, env) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const child = spawn(process.execPath, [script, '--json'], {
			stdio: ['ignore', 'pipe', 'ignore'],
			env: { ...process.env, ...env },
		});
		child.stdout.on('data', (c) => chunks.push(c));
		child.on('error', reject);
		child.on('exit', (code) => resolve({ code, bytes: Buffer.concat(chunks) }));
	});
}

async function withTempDirs(fn) {
	const scriptDir = mkdtempSync(join(tmpdir(), 'fleet-emit-job-run-script-'));
	const stateDir = mkdtempSync(join(tmpdir(), 'fleet-emit-job-run-state-'));
	try {
		await fn(scriptDir, stateDir);
	} finally {
		rmSync(scriptDir, { recursive: true, force: true });
		rmSync(stateDir, { recursive: true, force: true });
	}
}

test('a cron run with FLEET_CALLER naming a registry job writes exactly one row, verdict from the doc', () =>
	withTempDirs(async (scriptDir, stateDir) => {
		const payload = {
			ok: false,
			findings: [{ node: 'claw-3', kind: 'x', reason: 'drained' }],
			unreadable: [],
		};
		const script = emitterScript(scriptDir, payload, 0);
		const { code, bytes } = await run(script, {
			FLEET_CALLER: REAL_JOB,
			HADOKU_STATE_DIR: stateDir,
		});
		assert.equal(code, 0);
		assert.deepEqual(JSON.parse(bytes.toString('utf8')), payload);

		const read = readJobRuns(jobRunDir(stateDir), { job: REAL_JOB });
		assert.equal(read.rows.length, 1);
		assert.equal(read.rows[0].verdict, 'findings');
		assert.equal(read.rows[0].findings, 1);
		assert.equal(read.rows[0].kind, 'gate');
		assert.equal(read.rows[0].why, 'drained');
	}));

test('the SAME run with no FLEET_CALLER writes no row at all — a manual/operator invocation is not telemetry', () =>
	withTempDirs(async (scriptDir, stateDir) => {
		const payload = { ok: true, findings: [], unreadable: [] };
		const script = emitterScript(scriptDir, payload, 0);
		const { code } = await run(script, { HADOKU_STATE_DIR: stateDir });
		assert.equal(code, 0);
		const read = readJobRuns(jobRunDir(stateDir));
		assert.equal(read.rows.length, 0);
	}));

test('FLEET_CALLER naming something the registry does not track also writes no row', () =>
	withTempDirs(async (scriptDir, stateDir) => {
		const payload = { ok: true, findings: [], unreadable: [] };
		const script = emitterScript(scriptDir, payload, 0);
		const { code } = await run(script, {
			FLEET_CALLER: 'not-a-registry-job',
			HADOKU_STATE_DIR: stateDir,
		});
		assert.equal(code, 0);
		const read = readJobRuns(jobRunDir(stateDir));
		assert.equal(read.rows.length, 0);
	}));

test('stdout and the exit code are BYTE-IDENTICAL whether recording is on or off', () =>
	withTempDirs(async (scriptDir, stateDir) => {
		const payload = { ok: true, findings: [], unreadable: [], recorded: [{ node: 'claw-1' }] };
		const scriptOn = emitterScript(scriptDir, payload, 0);
		const on = await run(scriptOn, { FLEET_CALLER: REAL_JOB, HADOKU_STATE_DIR: stateDir });
		const off = await run(scriptOn, { HADOKU_STATE_DIR: stateDir });
		assert.equal(on.code, off.code);
		assert.deepEqual(on.bytes, off.bytes, 'the --json document must not change one byte');
	}));

test('a NON-ZERO exit still carries its own exit code unchanged, with or without recording', () =>
	withTempDirs(async (scriptDir, stateDir) => {
		const payload = { ok: false, error: 'fixture failure' };
		const script = emitterScript(scriptDir, payload, 1);
		const on = await run(script, { FLEET_CALLER: REAL_JOB, HADOKU_STATE_DIR: stateDir });
		const off = await run(script, { HADOKU_STATE_DIR: stateDir });
		assert.equal(on.code, 1);
		assert.equal(off.code, 1);
		assert.deepEqual(on.bytes, off.bytes);
	}));

test('a script that crashes before emit() still gets one row, via the exit-guard fallback — verdict error', () =>
	withTempDirs(async (scriptDir, stateDir) => {
		const script = crashingScript(scriptDir);
		const { code } = await run(script, { FLEET_CALLER: REAL_JOB, HADOKU_STATE_DIR: stateDir });
		assert.equal(code, 1);
		const read = readJobRuns(jobRunDir(stateDir), { job: REAL_JOB });
		assert.equal(read.rows.length, 1);
		assert.equal(read.rows[0].verdict, 'error');
		assert.match(read.rows[0].why ?? '', /fixture crash before emit\(\)/);
	}));

test('the crash case writes NO row when FLEET_CALLER is unset — the exit-guard fallback itself is unaffected', () =>
	withTempDirs(async (scriptDir, stateDir) => {
		const script = crashingScript(scriptDir);
		const { code, bytes } = await run(script, { HADOKU_STATE_DIR: stateDir });
		assert.equal(code, 1);
		// The json-exit-guard's own document is still written, recording hook or not.
		const doc = JSON.parse(bytes.toString('utf8'));
		assert.equal(doc.ok, false);
		assert.equal(readJobRuns(jobRunDir(stateDir)).rows.length, 0);
	}));

test('a job-run-store write failure never throws into the script and never touches stdout/exit', () =>
	withTempDirs(async (scriptDir, stateDir) => {
		// Block job-run-store's own mkdirSync: a FILE sits where it wants a directory.
		writeFileSync(join(stateDir, 'job-runs'), 'not a directory');
		const payload = { ok: true, findings: [], unreadable: [] };
		const script = emitterScript(scriptDir, payload, 0);
		const { code, bytes } = await run(script, {
			FLEET_CALLER: REAL_JOB,
			HADOKU_STATE_DIR: stateDir,
		});
		assert.equal(code, 0);
		assert.deepEqual(JSON.parse(bytes.toString('utf8')), payload);
	}));
