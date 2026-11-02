/**
 * capability-seeds' LIVE DEPENDENCIES (cut (iii) layer debt, wave layers-3
 * lane T) — the one place `capability-seeds.mjs` wired a REAL `ssh`/`gh` pair
 * into its otherwise-injectable `{ssh, gh}` deps.
 *
 * `capability-seeds.mjs` is `config`: `seedNode`/`seedNodeFor` take `deps` as
 * a parameter and import neither `fleet-exec.mjs` nor `node:child_process`
 * directly, so every decision in that file is exercised by a test with a
 * fake `{ssh, gh}` and reads as pure. `defaultSeedDeps()` was the one
 * exception — the real pair its two callers (`bootcamp.mjs`,
 * `converge-toolchain.mjs`) actually run with — and it needs `runOn`
 * (`fleet-exec.mjs`, `access`), which `config` may not import. Moved here,
 * classified `lifecycle`/`run` like its callers (the same split
 * `refresh-cycle-live.mjs` made off `refresh-cycle.mjs`), with every body
 * byte-identical to its old home.
 */

import { execFile } from 'node:child_process';
import { runOn } from './fleet-exec.mjs';
import { READ_ATTEMPTS, describeReadFailure } from './read-retry-policy.mjs';

/** One `gh api` call, never throwing: `{ok, stdout, stderr, error}`. The controller's own `gh` auth. */
function ghOnce(args, { timeoutMs = 30_000 } = {}) {
	return new Promise((resolve) => {
		execFile(
			'gh',
			args,
			{ encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
			(err, stdout, stderr) => {
				resolve({
					ok: !err,
					stdout: String(stdout ?? ''),
					stderr: String(stderr ?? ''),
					error: err
						? describeReadFailure({ status: err.code, stderr, message: err.message }, timeoutMs)
						: null,
				});
			}
		);
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a one-shot `gh(args)` in {@link READ_ATTEMPTS} retries — the same
 * tolerance for the measured 0.13% transient `gh api` failure rate every other
 * controller-side `gh` reader in this repo applies (CLAUDE.md). Retrying is
 * NOT tolerating: a call that fails every attempt still returns `ok: false`.
 */
export function ghWithRetry(ghOneShot, { attempts = READ_ATTEMPTS, delayMs = 1000 } = {}) {
	return async (args) => {
		let last;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			last = await ghOneShot(args);
			if (last.ok) return last;
			if (attempt < attempts) await sleep(delayMs);
		}
		return { ...last, error: `${last.error} (attempt ${attempts}/${attempts})` };
	};
}

/** The real {ssh, gh} pair: ssh over `fleet-exec.mjs`'s `runOn`, gh retried per {@link READ_ATTEMPTS}. */
export function defaultSeedDeps() {
	return { ssh: runOn, gh: ghWithRetry(ghOnce) };
}
