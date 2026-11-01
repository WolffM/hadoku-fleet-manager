/**
 * Declaring a probe's intent to the dispatcher — split out of
 * `scripts/floor-probe.mjs` (wave 5q lane A, ctx restructure) so that file
 * reaches the 800-line ceiling. Takes the CLI's `fail` (its `--json`-aware
 * refusal, which exits the process) rather than importing the CLI: no lib
 * imports it, per `docs/planning/wave5q-2026-10-31.md`.
 *
 * NOT IN `floor-probe-state.mjs` BESIDE THE LEDGER, even though both are
 * "declared, read back by something else" state: that file is the flat
 * `state` layer and this one imports `PROBE_INTENT_DIR`/`PROBE_INTENT_MAX_MS`
 * from `dispatch-tick.ts`, a `ci-scheduling`/`run` DOMAIN fact. `state`
 * importing a domain constant is itself a layer violation (`measure-layers.mjs`
 * cut iii) the ledger functions do not carry — this file stays in the
 * domain's `run` part instead, same stratum as the dispatcher it declares to.
 */
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { writeFileAtomic } from '../../dist/lib/atomic-json.js';
import { PROBE_INTENT_DIR, PROBE_INTENT_MAX_MS } from '../../dist/runners/dispatch-tick.js';
import { stateDir } from './paths.mjs';

/**
 * Tell the dispatcher this job is already being served, so it mints no competitor.
 *
 * THE WASTED COMPETITOR, CLOSED. §2.1 measured "roughly one wasted mint per
 * probe": this harness mints a listener and dispatches, mgmt-api sees the same
 * job queued on its next 15 s tick and mints a second runner for it. The cost is
 * absorbed, but it is also what made the sweep's MISSES correlated — all four
 * landed on a node still holding the previous probe's leftover, so two idle
 * matching runners existed and GitHub picked. `readProbeIntents` in
 * `dispatch-tick.ts` is the reader; this is the only writer.
 *
 * DECLARED BEFORE THE MINT, not before the dispatch. Nothing can queue the job
 * until the dispatch, so either would be correct on paper — but the mint is the
 * first irreversible thing, and an intent written after it has a window in which
 * the process can die holding a registration it never declared.
 *
 * RELEASED ON EVERY EXIT, via `process.on('exit')` rather than a `finally`:
 * `fail()` calls `process.exit`, which a `finally` does not run. An intent left
 * behind is a licence to NOT MINT for that unit, and under all-JIT nothing else
 * would mint — so a real job of the same unit would sit queued until the expiry
 * below. The expiry is the backstop for a SIGKILL, not the normal path.
 *
 * `fail` and `ttlSeconds` come from the CLI (its `--json`-aware refusal and
 * `PROBE_TTL_SECONDS`) rather than an import of it: no lib imports the CLI.
 */
export function declareProbeIntent({ repo, job, node, runnerName }, { fail, ttlSeconds }) {
	const dir = join(stateDir(), PROBE_INTENT_DIR);
	const path = join(dir, `${runnerName}.json`);
	// The runner's own TTL, which is the longest this probe can possibly be waiting
	// for the job. PROBE_INTENT_MAX_MS is the reader's ceiling and is deliberately
	// wider, for the two clocks; see that constant.
	const expiresAtMs = Date.now() + ttlSeconds * 1000;
	if (expiresAtMs - Date.now() > PROBE_INTENT_MAX_MS) {
		// Unreachable while PROBE_TTL_SECONDS is 900 — and asserted in the tests —
		// but a declaration the reader will refuse must not be written silently: the
		// probe would lose the race it thinks it has already won.
		fail(
			`a probe intent of ${ttlSeconds}s exceeds the dispatcher's ` +
				`${PROBE_INTENT_MAX_MS / 1000}s ceiling — it would be ignored, not honoured`
		);
	}
	writeFileAtomic(
		path,
		`${JSON.stringify({ repo, job, node, runnerName, expiresAtMs, at: new Date().toISOString() })}\n`
	);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		try {
			unlinkSync(path);
		} catch {
			// Already gone is the success case — another exit path released it.
		}
	};
	process.on('exit', release);
	return release;
}
