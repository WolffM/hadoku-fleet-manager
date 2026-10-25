/**
 * Run one of this package's own subcommand scripts and read its `--json`.
 *
 * Registration (#1) and the provisioning converger both act through the SAME
 * drivers the operator runs — `deploy-runners-slice.mjs` and
 * `deploy-ci-throttle.mjs` — rather than a second copy of what those write.
 * The drivers are the only statement of the slice drop-in, the per-unit cap
 * and the five `.env` keys; a caller that re-derived any of them would be one
 * more place for the rule to drift, and the checks would go on reading the
 * drivers' version.
 *
 * STDOUT GOES TO A FILE, NEVER A PIPE. A child that prints and then calls
 * `process.exit` into a pipe loses everything past 8 KB (#33), and a
 * fleet-wide `--json` from either driver is well past that.
 *
 * A NON-ZERO EXIT WITH PARSEABLE STDOUT IS NOT A CRASH. `--json` is a
 * contract here: the document wins over the exit code, and the caller judges
 * the per-machine result. `json` is null only when there was nothing to parse,
 * and `why` then says what the child reported instead.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {string} script absolute path to a `scripts/*.mjs` subcommand
 * @param {string[]} argv its arguments; `--json` is the caller's to pass
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ code: number | null, signal: string | null, json: any, why: string }>}
 */
export function runFleetScript(script, argv, { timeoutMs = 15 * 60_000, env = process.env } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-script-'));
	const outPath = join(dir, 'stdout.json');
	const fd = openSync(outPath, 'w');
	return new Promise((resolvePromise) => {
		let stderr = '';
		let settled = false;
		const finish = (code, signal, startError) => {
			if (settled) return;
			settled = true;
			closeSync(fd);
			const stdout = readFileSync(outPath, 'utf8');
			rmSync(dir, { recursive: true, force: true });
			let json = null;
			let parseError = '';
			try {
				json = stdout.trim() ? JSON.parse(stdout) : null;
			} catch (err) {
				parseError = err instanceof Error ? err.message : String(err);
			}
			const tail = stderr.trim().split('\n').slice(-3).join(' | ');
			const why = startError
				? `could not start: ${startError}`
				: json !== null
					? ''
					: `exit ${code ?? 'none'}${signal ? ` signal ${signal}` : ''}, ` +
						(parseError ? `stdout unparseable (${parseError})` : 'no stdout') +
						(tail ? ` — ${tail}` : '');
			resolvePromise({ code, signal, json, why });
		};
		const child = spawn(process.execPath, [script, ...argv], {
			env,
			stdio: ['ignore', fd, 'pipe'],
			timeout: timeoutMs,
		});
		child.stderr.on('data', (d) => {
			stderr = (stderr + d.toString()).slice(-4000);
		});
		child.on('error', (err) => finish(null, null, err.message));
		child.on('close', (code, signal) => finish(code, signal, null));
	});
}
