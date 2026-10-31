/**
 * Runs the repo's Python test suite — `scripts/runner_mem_report_test.py`
 * (fleet-manager#19) — as part of `pnpm run check`. Added be18c6e, it was run
 * by nobody until wave 5h lane D wired it in here.
 *
 * stdlib `unittest`, not pytest: this repo's CI job runs on the generic
 * `hadoku-builder` label (`.github/workflows/ci.yml`'s `vars.CI_RUNNER`), not
 * on a node that has earned — and been PROBED for — the `python-venv`
 * capability. The fleet's toolchain floor (`manifests/node-profiles.json`'s
 * `toolchain.packages`) images every node with `python3`/`python3-pip`/
 * `python3-venv` via apt, but pytest is a separate pip package that nothing
 * in that floor, `scripts/lib/toolchain-floor.mjs`, or
 * `scripts/capability-probe.sh` installs, earns, or probes for. Requiring it
 * on the box running `pnpm run check` would be requiring something unproven.
 * `python3` itself IS the one thing the floor guarantees — and even that is
 * checked below, not trusted on faith: AGENTS.md — "I could not look must
 * never render as nothing is wrong" — so a missing `python3` FAILS this gate
 * BY NAME, never a silent skip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(HERE, '..');

void test('python3 is on PATH — a missing interpreter fails this gate, never a silent skip', () => {
	const r = spawnSync('python3', ['--version'], { encoding: 'utf8' });
	assert.equal(
		r.error,
		undefined,
		`python3 could not be run (${r.error?.message ?? 'spawn failed'}) — this node is ` +
			"missing python3, which manifests/node-profiles.json's toolchain floor is " +
			'supposed to guarantee on every fleet node'
	);
	assert.equal(r.status, 0, `python3 --version exited ${r.status}: ${r.stderr}`);
});

void test('scripts/runner_mem_report_test.py passes under stdlib unittest', () => {
	const r = spawnSync('python3', ['-m', 'unittest', 'runner_mem_report_test', '-v'], {
		cwd: SCRIPTS_DIR,
		encoding: 'utf8',
	});
	assert.equal(
		r.error,
		undefined,
		`could not run python3 -m unittest (${r.error?.message ?? 'spawn failed'})`
	);
	const output = `${r.stdout}\n${r.stderr}`;
	const ran = output.match(/Ran (\d+) tests?/);
	assert.ok(ran, `unittest's own summary line was not found in its output:\n${output}`);
	const count = Number(ran[1]);
	assert.ok(
		count > 0,
		`unittest reported zero tests collected — that is a failure, not a pass:\n${output}`
	);
	assert.equal(
		r.status,
		0,
		`scripts/runner_mem_report_test.py failed under unittest (${count} tests ran):\n${output}`
	);
	// A SKIP is "could not look", not a pass: the suite skips every case when
	// dist/lib/node-users.js is missing, and unittest still exits 0 with
	// "OK (skipped=11)".
	const skipped = output.match(/skipped=(\d+)/);
	assert.equal(
		skipped,
		null,
		`unittest skipped ${skipped?.[1]} test(s) — a skip is not a pass (build dist first):\n${output}`
	);
});
