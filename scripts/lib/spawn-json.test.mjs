/**
 * The helper must name the CAUSE, and these cases are the reason it cannot
 * quietly stop doing so.
 *
 * Every child here is `node -e`, so the cases are about the HELPER rather than
 * about any fleet script: a child that exits 0 saying nothing, a child killed
 * at its timeout, and a child that dies the way the real #45 flake died — exit
 * 1, nothing on stdout, the whole explanation on stderr. Fixtures, not the live
 * target, so the mutation below is safe to run: revert either assertion in
 * spawn-json.mjs and these go red without anything else being touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseJsonStdout, spawnCapture, spawnJson } from './spawn-json.mjs';

/**
 * `assert.throws` returns undefined, so the message — the whole point of this
 * file — has to be captured by hand. A miss is a failure, never a silent pass.
 */
function threw(fn) {
	try {
		fn();
	} catch (e) {
		return e;
	}
	return assert.fail('expected a throw, and nothing was thrown');
}

/** A child, described by the one-liner it runs. */
function child(src, options = {}) {
	return () => spawnCapture(process.execPath, ['-e', src], { label: 'fixture-child', ...options });
}

test('exit 0 with empty stdout names the status, the elapsed time and the stderr', () => {
	const r = child('process.stderr.write("I had nothing to say\\n"); process.exit(0)')();
	assert.equal(
		r.code,
		0,
		'the child really did exit 0 — otherwise this case is testing something else'
	);
	assert.equal(r.out, '', 'and it really did print nothing');

	const e = threw(() => parseJsonStdout(r));
	assert.match(e.message, /printed NOTHING to stdout/);
	assert.match(e.message, /exit status: 0/);
	assert.match(e.message, /signal: none/);
	assert.match(e.message, /elapsed: \d+ms/);
	assert.match(e.message, /I had nothing to say/, 'the stderr is the only evidence there is');
	assert.doesNotMatch(
		e.message,
		/Unexpected end of JSON input/,
		'the parse is what it must STOP reporting'
	);
});

test('a timeout kill says it was killed, by which signal, and at which ceiling', () => {
	// Sleeps far past the ceiling. The stderr is written first, so the message
	// has to carry output from a child that never finished.
	const e = threw(
		child('process.stderr.write("started, now hanging\\n"); setTimeout(() => {}, 60_000)', {
			timeout: 400,
		})
	);
	assert.match(e.message, /was KILLED/);
	assert.match(e.message, /signal: SIGTERM/);
	assert.match(e.message, /timeout: 400ms/);
	assert.match(e.message, /killed at the 400ms TIMEOUT/);
	assert.match(e.message, /started, now hanging/, 'a killed child still said something');
	assert.doesNotMatch(e.message, /Unexpected end of JSON input/);
});

test('a 1ms timeout reads as a timeout, not as a parse failure', () => {
	// The ceiling is below node's own startup, so there is no stderr to carry.
	// Saying so is the point: "the child said nothing" is a different finding
	// from "the child said nothing about why", and neither is a bad payload.
	const e = threw(child('setTimeout(() => {}, 60_000)', { timeout: 1 }));
	assert.match(e.message, /was KILLED/);
	assert.match(e.message, /timeout: 1ms/);
	assert.match(e.message, /stderr: EMPTY/);
});

test('the #45 shape: exit 1, no stdout, the whole answer on stderr', () => {
	// This is what `rm -rf dist` under a concurrent `pnpm run check` does to a
	// script that imports from dist: ERR_MODULE_NOT_FOUND, stdout untouched.
	const r = child(
		'process.stderr.write("Error [ERR_MODULE_NOT_FOUND]: Cannot find module \'/x/dist/capabilities.js\'\\n"); process.exit(1)'
	)();
	const e = threw(() => parseJsonStdout(r, 'fleet capabilities --json'));
	assert.match(e.message, /fleet capabilities --json: printed NOTHING/);
	assert.match(e.message, /exit status: 1/);
	assert.match(e.message, /ERR_MODULE_NOT_FOUND/);
	assert.match(e.message, /dist\/capabilities\.js/);
});

test('a NON-ZERO exit with parseable stdout is a finding, not a failure', () => {
	// `--json` is a contract: mgmt-api parses stdout and treats a non-zero exit
	// as a FINDING. `fleet capabilities` exits 1 with a full report whenever a
	// node is unreachable. A helper that refused that would break every caller
	// it was written for, so this is the half that keeps the strictness honest.
	const report = spawnJson(
		process.execPath,
		['-e', 'console.log(JSON.stringify({ unreachable: ["a"] })); process.exit(1)'],
		{ label: 'a gate with a finding' }
	);
	assert.deepEqual(report, { unreachable: ['a'] });
});

test('stdout that is not JSON reports the bytes and the parser, not "end of input"', () => {
	const r = child('process.stdout.write("Usage: fleet <cmd>\\n"); process.exit(2)')();
	const e = threw(() => parseJsonStdout(r));
	assert.match(e.message, /is not JSON/);
	assert.match(e.message, /stdout: 19 bytes/);
	assert.match(e.message, /Usage: fleet/);
	assert.match(e.message, /exit status: 2/);
});

test('a command that never starts says so, with the errno', () => {
	const e = threw(() =>
		spawnCapture('/nonexistent/definitely-not-a-command', [], { label: 'a missing binary' })
	);
	assert.match(e.message, /never started/);
	assert.match(e.message, /spawn error: ENOENT/);
});
