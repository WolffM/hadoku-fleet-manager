/**
 * Reading `job-history.jsonl` for the forced-placement harness — split out of
 * `scripts/floor-probe.mjs` (wave 5q lane A, ctx restructure) so that file
 * reaches the 800-line ceiling. Takes the CLI's `fail` (its `--json`-aware
 * refusal, which exits the process) rather than importing the CLI: no lib
 * imports it, per `docs/planning/wave5q-2026-10-31.md`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../../dist/lib/fleet-paths.js';

const historyPath = join(stateDir(), 'job-history.jsonl');

/**
 * `fail` is called (and never returns — it's the CLI's `process.exit(1)`
 * wrapper) when there is nothing measured to build a table from. ZERO IS A
 * FAILURE: "I could not look" must never render as "nothing is wrong".
 */
export function loadHistory(fail) {
	if (!existsSync(historyPath)) {
		fail(`no job-history at ${historyPath} — there is nothing measured to build a table from`);
	}
	const rows = [];
	let bad = 0;
	for (const line of readFileSync(historyPath, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			bad++;
		}
	}
	if (!rows.length)
		fail(`job-history at ${historyPath} holds no records — a window of zero is not a pass`);
	return { rows, bad };
}
