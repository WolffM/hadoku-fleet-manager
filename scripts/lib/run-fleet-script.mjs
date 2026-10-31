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
 * THE SPAWN+CAPTURE+PARSE ITSELF IS `spawn-json.mjs`'s `spawnJsonToFile` (F6,
 * plan §4.1): stdout to a FILE, never a pipe (#33/#45), parseable stdout
 * winning over a non-zero exit, and a parse failure that never collapses to a
 * bare `null` with the reason dropped. This module is now a thin adapter onto
 * that one shape, kept for its own external shape (`{code, signal, json,
 * why}`) and its callers' defaults (a node script, a 15-minute ceiling, a
 * 4000-byte stderr tail) rather than re-deriving them at every call site.
 */
import { spawnJsonToFile } from './spawn-json.mjs';

/**
 * @param {string} script absolute path to a `scripts/*.mjs` subcommand
 * @param {string[]} argv its arguments; `--json` is the caller's to pass
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ code: number | null, signal: string | null, json: any, why: string }>}
 */
export async function runFleetScript(
	script,
	argv,
	{ timeoutMs = 15 * 60_000, env = process.env } = {}
) {
	const { doc, code, signal, why } = await spawnJsonToFile(process.execPath, [script, ...argv], {
		env,
		timeoutMs,
		stderrTailBytes: 4000,
	});
	return { code, signal, json: doc, why };
}
