/**
 * label-floor-transitions — the audit trail of every label a node gained or
 * lost since this gate last ran, persisted beside the gate's other state.
 *
 * Moved out of `check-label-floor.mjs` (wave shrink-1 lane D), body
 * unchanged.
 *
 * WHY THIS AND NOT AN ENFORCEMENT. The operator's 2026-09-09 decision is that
 * bootcamp demotion is OBSERVED, not forced: the first time a node naturally
 * loses `hadoku-builder` because a probe stopped passing, that has to be
 * REVIEWABLE after the fact rather than silently correct. A derived label with
 * no audit trail is a fleet that reconfigures itself and tells nobody, and the
 * thing an operator needs at 3am is not "why is claw-5 not taking work" but
 * "claw-5 lost hadoku-builder on the 07:00 run because playwright stopped
 * launching". So this NEVER fails the gate. It reports.
 *
 * WHERE THE STATE LIVES. `stateDir()`, beside every other piece of gate state
 * this repo keeps between runs — the precedent is `check-tool-inventory.mjs`'s
 * `tool-inventory-capabilities.json`, which is the same snapshot/diff/persist
 * shape for capability retirement, and `job-history.jsonl` and
 * `fleet-drain.json` live there too. Not the manifest directory: manifests are
 * operator config, and a gate must not write into the file it audits.
 *
 * FIRST RUN IS A BASELINE, NOT A HUNDRED TRANSITIONS. With no previous
 * snapshot every label on every node would read as newly gained, which is
 * noise that trains the reader to skip the block. It records and says so.
 *
 * A SNAPSHOT THAT CANNOT BE READ IS NOT AN EMPTY ONE. An unreadable or corrupt
 * state file is reported as such and treated as a baseline — never silently as
 * "nothing changed", which would hide precisely the transition somebody is
 * looking for.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../../dist/lib/atomic-json.js';
import { causeFor } from './label-floor-check.mjs';
import { stateDir } from './paths.mjs';

/**
 * The basename literal and the write call live in the SAME file on purpose
 * (wave shrink-1 lane D): `scripts/lib/f-guards/f3-one-writer.test.mjs`
 * traces a write call's path argument back to a local literal within one
 * file only, never across a file boundary, so this is also what keeps that
 * guard able to see this module as the one declared writer.
 */
export const HOLDINGS_FILE = 'label-floor-holdings.json';

/** Where this run's label holdings are persisted, for the gate's own ctx. */
export function holdingsPath() {
	return join(stateDir(), HOLDINGS_FILE);
}

/** @param {string} holdingsPath */
function readPreviousHoldings(holdingsPath) {
	let previousHoldings = null;
	let holdingsError = null;
	if (existsSync(holdingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(holdingsPath, 'utf8'));
			previousHoldings = parsed?.holdings ?? null;
			if (!previousHoldings || typeof previousHoldings !== 'object') {
				throw new Error('no `holdings` object in the state file');
			}
		} catch (err) {
			holdingsError = String(err.message ?? err);
		}
	}
	return { previousHoldings, holdingsError };
}

/**
 * Reads the previous run's holdings, diffs them against this run's, reports
 * the result through `log`, and persists this run's holdings for next time.
 *
 * @param {object} manifest
 * @param {Record<string,string[]>} holdings
 * @param {(msg: string) => void} log
 */
export function trackLabelTransitions(manifest, holdings, log) {
	const path = holdingsPath();
	const { previousHoldings, holdingsError } = readPreviousHoldings(path);

	const transitions = [];
	if (previousHoldings) {
		const nodes = [...new Set([...Object.keys(previousHoldings), ...Object.keys(holdings)])].sort();
		for (const node of nodes) {
			const before = new Set(previousHoldings[node] ?? []);
			const after = new Set(holdings[node] ?? []);
			for (const label of [...after].filter((l) => !before.has(l)).sort()) {
				transitions.push({ node, label, change: 'gained', cause: causeFor(manifest, node, label) });
			}
			for (const label of [...before].filter((l) => !after.has(l)).sort()) {
				transitions.push({ node, label, change: 'lost', cause: causeFor(manifest, node, label) });
			}
		}
	}

	if (holdingsError) {
		console.error(
			`! label transitions: could not read ${path} (${holdingsError}) — this run is a ` +
				`new baseline, so a transition since the last run would NOT have been reported.`
		);
	} else if (!previousHoldings) {
		log(
			`label transitions: first run — baseline recorded for ${Object.keys(holdings).length} node(s) ` +
				`at ${path}. Transitions are reported from the next run on.`
		);
	} else if (!transitions.length) {
		log('label transitions: none since the last run.');
	} else {
		log(`label transitions since the last run (${transitions.length}):`);
		for (const t of transitions) {
			log(`  ${t.node} ${t.change === 'gained' ? '+' : '-'}${t.label} — ${t.cause.why}`);
		}
		log(
			'  Observed, not enforced: bootcamp demotion is reviewable after the fact ' +
				'(wave2 §D.4). None of these fails this gate.'
		);
	}

	try {
		// Write-then-rename, fsync'd (F3, `lib/atomic-json.ts`).
		writeFileAtomic(
			path,
			`${JSON.stringify({ at: new Date().toISOString(), holdings }, null, 2)}\n`
		);
	} catch (err) {
		// Reported, never swallowed: without the write, the NEXT run compares against
		// a stale snapshot and re-reports transitions it has already shown, or misses
		// one entirely. That is a real gap in the audit trail and it must be visible.
		console.error(`! could not persist label holdings to ${path}: ${err.message}`);
	}

	return { transitions, holdingsError, holdingsPath: path };
}
