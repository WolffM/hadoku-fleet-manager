/**
 * A test that spawns a child and parses its stdout must say WHY it got nothing.
 *
 * THE FAILURE THIS EXISTS FOR (#45). Twice on 2026-09-20 — a pre-push hook at
 * ~05:05Z and a clean-checkout run ten minutes later — the suite failed on
 * exactly two tests, both `SyntaxError: Unexpected end of JSON input`:
 * `check-capabilities.test.mjs` and `ci-throttle.test.mjs`. A third run passed,
 * each file alone passed, and CI on the same sha was green. Both helpers
 * spawned a real child, discarded its status, its signal and its stderr, and
 * handed `''` to `JSON.parse`. The report therefore pointed at the parse — the
 * one place the bug was not.
 *
 * The cause, reproduced 2026-09-19 by renaming `dist/` for one run: both
 * spawned scripts import from `../dist/`, `pnpm run build` opens with
 * `rm -rf dist`, and `pnpm run test` opens with `rm -rf dist/tests`. A second
 * `pnpm run check` running concurrently deletes the tree out from under the
 * first one's children, which then exit 1 having printed
 * `ERR_MODULE_NOT_FOUND` to stderr and nothing at all to stdout. Every symptom
 * follows: two files at once, transient, green alone, green in CI where nothing
 * runs concurrently.
 *
 * The child had already said exactly what was wrong. The helper threw it away.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ASSERTED, AND WHAT DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 * `spawnCapture` THROWS when the child was killed by a signal or never started,
 * because no caller can learn anything from a corpse: there is no exit status
 * to reason about and partial output is not evidence of anything.
 *
 * `parseJsonStdout` THROWS when stdout is empty or unparseable, naming the
 * status, the signal, the elapsed milliseconds against the ceiling, the byte
 * count and the child's stderr.
 *
 * A NON-ZERO EXIT WITH PARSEABLE STDOUT IS NOT A FAILURE, and this file must
 * not make it one. `--json` is a contract in this repo: mgmt-api's cron jobs
 * parse stdout and treat a non-zero exit as a FINDING rather than a crash, so
 * parseable stdout wins over the exit code. `fleet capabilities` exits 1 with a
 * full report whenever a node is unreachable, and the deployer exits 1 with a
 * full report when it has nobody to deploy to; a helper that refused those
 * would be asserting the opposite of the contract the callers exist to hold.
 * The status is therefore DIAGNOSIS, printed on every failure, not a verdict of
 * its own.
 */
import { spawnSync } from 'node:child_process';

/** How much of a child's stderr a failure message carries. */
const STDERR_TAIL = 2000;

/**
 * Node's default `maxBuffer` for a synchronous child, and the size a pipe
 * truncates at when a script prints and then calls `process.exit` (#33). Both
 * are worth naming in a message rather than leaving the reader to recognise a
 * number.
 */
const PIPE_CLIFF = 8192;

/**
 * Spawn a child and capture everything about how it ended.
 *
 * `spawnSync` rather than `execFileSync` on purpose: it reports a kill and a
 * failure-to-start as DATA (`signal`, `error`) instead of as an exception whose
 * fields differ by failure mode, so there is one shape to read.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{env?: NodeJS.ProcessEnv, timeout?: number, cwd?: string, input?: string, label?: string}} options
 * @returns {{code: number, signal: string|null, out: string, err: string, elapsedMs: number, timeoutMs: number|undefined, label: string}}
 */
export function spawnCapture(command, args, options = {}) {
	const { env, timeout, cwd, input, label } = options;
	const name = label ?? `${command} ${args.join(' ')}`.trim();
	const started = Date.now();
	const r = spawnSync(command, [...args], {
		encoding: 'utf8',
		stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
		...(input === undefined ? {} : { input }),
		...(env === undefined ? {} : { env }),
		...(cwd === undefined ? {} : { cwd }),
		...(timeout === undefined ? {} : { timeout }),
	});
	const elapsedMs = Date.now() - started;
	const out = r.stdout ?? '';
	const err = r.stderr ?? '';

	// A corpse or a no-show. Neither has an exit status, so there is nothing a
	// caller could branch on; reporting it as a value would only let it be read
	// as `code: 1`, which is what "refused" looks like.
	if (r.signal || (r.status === null && r.error)) {
		throw new Error(
			describe(name, r.signal ? 'was KILLED' : 'never started', {
				code: r.status,
				signal: r.signal,
				elapsedMs,
				timeoutMs: timeout,
				out,
				err,
				spawnError: r.error,
			})
		);
	}
	if (r.error) {
		// It ran and still errored — ENOBUFS is the one that matters, because the
		// output is then truncated and the parse below would blame the payload.
		throw new Error(
			describe(name, 'failed while running', {
				code: r.status,
				signal: r.signal,
				elapsedMs,
				timeoutMs: timeout,
				out,
				err,
				spawnError: r.error,
			})
		);
	}

	return {
		code: r.status ?? 1,
		signal: r.signal ?? null,
		out,
		err,
		elapsedMs,
		timeoutMs: timeout,
		label: name,
	};
}

/**
 * Parse a captured child's stdout as JSON, or throw saying why it could not be.
 *
 * @param {{code: number, signal: string|null, out: string, err: string, elapsedMs: number, timeoutMs?: number, label?: string}} result
 * @param {string} [label] overrides `result.label` in the message
 * @returns {unknown}
 */
export function parseJsonStdout(result, label) {
	const name = label ?? result.label ?? 'child';
	const out = result.out ?? '';
	const fields = {
		code: result.code,
		signal: result.signal ?? null,
		elapsedMs: result.elapsedMs,
		timeoutMs: result.timeoutMs,
		out,
		err: result.err ?? '',
	};

	if (out.trim() === '') {
		throw new Error(describe(name, 'printed NOTHING to stdout', fields));
	}
	try {
		return JSON.parse(out);
	} catch (e) {
		throw new Error(describe(name, `printed stdout that is not JSON (${e.message})`, fields));
	}
}

/** Spawn, then parse. The two steps are separate because a legitimately empty
 * stdout — a refusal that must not emit a parseable clean report — is a thing
 * callers assert on directly. */
export function spawnJson(command, args, options = {}) {
	return parseJsonStdout(spawnCapture(command, args, options));
}

/**
 * The message. Every failure carries the same six facts, in the same order, so
 * a red in a log is readable without going back to the source.
 */
function describe(name, what, { code, signal, elapsedMs, timeoutMs, out, err, spawnError }) {
	const lines = [
		`${name}: ${what}.`,
		`  exit status: ${code === null || code === undefined ? 'none (no exit)' : code}`,
		`  signal: ${signal ?? 'none'}`,
		`  elapsed: ${elapsedMs}ms${timeoutMs === undefined ? ' (no timeout set)' : ` (timeout: ${timeoutMs}ms)`}`,
	];
	if (signal && timeoutMs !== undefined && elapsedMs >= timeoutMs) {
		lines.push(`  -> killed at the ${timeoutMs}ms TIMEOUT, not by the code under test`);
	}
	if (spawnError) {
		lines.push(`  spawn error: ${spawnError.code ?? ''} ${spawnError.message}`.trimEnd());
	}
	lines.push(`  stdout: ${out.length} bytes${out.length === 0 ? ' (empty)' : ''}`);
	if (out.length === PIPE_CLIFF) {
		lines.push(
			`  -> exactly ${PIPE_CLIFF} bytes is the pipe cliff (#33), not a payload that ends there`
		);
	}
	if (out.length > 0) {
		lines.push(`  stdout (first 200): ${JSON.stringify(out.slice(0, 200))}`);
	}
	const tail = (err ?? '').trim();
	lines.push(
		tail === ''
			? '  stderr: EMPTY — the child said nothing about why'
			: `  stderr (last ${STDERR_TAIL}):\n${indent(tail.slice(-STDERR_TAIL))}`
	);
	return lines.join('\n');
}

function indent(text) {
	return text
		.split('\n')
		.map((l) => `    | ${l}`)
		.join('\n');
}
