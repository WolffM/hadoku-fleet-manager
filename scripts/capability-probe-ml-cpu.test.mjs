/**
 * `ml-cpu`: the probe block EXECUTED, and the registry's bar applied to what
 * it prints.
 *
 * WHAT RUNS. The real script, phase `presence`, under `/bin/bash` with a PATH
 * that is ONLY a fixture bin: a stub `python3` that reports the version it is
 * told to, plus the coreutils the block needs, and a fixture meminfo through
 * `CAP_MEMINFO`. So nothing on the host is asked: not its interpreter, not its
 * memory.
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

import { capability, measuredIdleOnly, meetsBar } from '../dist/lib/capability-registry.js';

const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'capability-probe.sh');

function which(u) {
	for (const d of ['/usr/bin', '/bin', '/usr/local/bin']) {
		if (existsSync(join(d, u))) return join(d, u);
	}
	throw new Error(`${u} not found on this host`);
}

/**
 * @param {object} o
 * @param {string | null} [o.python]  the version python3 reports, `3.13`; null = no python3
 * @param {number | null} [o.memKb]  MemTotal in kB; null = unreadable meminfo
 */
async function probeMlCpu({ python = '3.13', memKb = 32_000_000 } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-probe-ml-cpu-'));
	const bin = join(root, 'bin');
	for (const d of [bin, join(root, 'tmp'), join(root, 'home')]) mkdirSync(d, { recursive: true });
	for (const u of ['date', 'mktemp', 'rm', 'cat', 'hostname', 'cut', 'awk']) {
		symlinkSync(which(u), join(bin, u));
	}
	if (python !== null) {
		// The block's own check is `sys.version_info >= (3, 11)`; the stub answers
		// it the way that one-liner would, for the version it is given.
		const [maj, min] = python.split('.').map(Number);
		const ok = maj > 3 || (maj === 3 && min >= 11);
		writeFileSync(join(bin, 'python3'), `#!/bin/sh\n${ok ? `echo ${python}` : 'exit 1'}\n`);
		chmodSync(join(bin, 'python3'), 0o755);
	}
	const meminfo = join(root, 'meminfo');
	if (memKb !== null) writeFileSync(meminfo, `MemTotal:       ${memKb} kB\nMemFree:  1 kB\n`);
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
				CAP_MEMINFO: meminfo,
			},
		});
		return stdout.split('\n').find((l) => l.startsWith('CAP ml-cpu ')) ?? null;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** The registry's verdict on one probe line. */
function judge(line) {
	const [, , status, detail] = line.split(' ');
	return meetsBar(capability('ml-cpu'), status === 'ok', detail);
}

const BAR = capability('ml-cpu').measure.atLeast;

test('a big enough box with a new enough python: ok, the memory first, then the interpreter', async () => {
	const line = await probeMlCpu({ memKb: 31.2 * 1048576 });
	assert.equal(line, 'CAP ml-cpu ok 31.2GB,python-3.13');
	assert.deepEqual(judge(line), { proven: true, reason: 'installed memory 31.2 GB' });
});

test('the probe measures and never judges: a small box prints ok, the registry refuses it', async () => {
	const kb = Math.round((BAR - 1) * 1048576);
	const line = await probeMlCpu({ memKb: kb });
	assert.match(line, /^CAP ml-cpu ok \d+\.\dGB,python-3\.13$/);
	assert.equal(judge(line).proven, false);
	assert.match(judge(line).reason, new RegExp(`< ${BAR} GB required$`));
});

test('each failure is named, never a zero', async () => {
	assert.equal(await probeMlCpu({ python: null }), 'CAP ml-cpu no no-python3');
	assert.equal(await probeMlCpu({ python: '3.10' }), 'CAP ml-cpu no python-below-3.11');
	assert.equal(await probeMlCpu({ memKb: null }), 'CAP ml-cpu no meminfo-unreadable');
});

test('installed memory is a property of the box, so it is read on a busy node too', () => {
	assert.equal(measuredIdleOnly(capability('ml-cpu')), false);
});
