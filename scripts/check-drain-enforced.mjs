#!/usr/bin/env node
/**
 * check-drain-enforced — is a drained node ACTUALLY not receiving work?
 *
 * WHY IT IS A SEPARATE SCRIPT FROM `fleet drain`
 * ---------------------------------------------
 * It began as `fleet drain --check`, sharing a file with the human drain CLI,
 * and `emit.test.mjs` refused it: `drain-node.mjs` writes fourteen `console.log`
 * lines for its status table and its confirmation text, and a subcommand under
 * the `--json` contract must write stdout ONLY through `lib/emit.mjs`.
 *
 * That rule looked pedantic here — the `--check` branch returned before any of
 * those lines could run — and it is not. `ci:drain-enforced` reads stdout and
 * tests `startsWith('{')` BEFORE the exit code, so one human line printed ahead
 * of the payload turns a real finding into "the checker broke". The gate proves
 * the property for EVERY input rather than for the paths anyone happened to
 * trace, which is exactly the strength being asked for. So the checker got its
 * own file, and the human CLI keeps its colours.
 *
 * WHAT IT CHECKS, AND WHY NOT THE OBVIOUS THING
 * ---------------------------------------------
 * `fleet drain --status` reads the drain file and reports what it says. That is
 * a statement of intent, and it was the only check anyone had. On 2026-09-06
 * claw-5 was believed drained by three separate documents — the measurement
 * handoff says "do not undrain it" — while the file read `"nodes": {}` and the
 * box had served 61 jobs. Nothing detected it, because the only check available
 * read the same file that was wrong. A verifier that reads its own writer's
 * artifact cannot fail.
 *
 * This reads JOB HISTORY: what the fleet DID. A drained node that STARTED a job
 * after it was drained is a drain that is not being enforced, whichever of the
 * two enforcement paths failed — dispatcher placement for an ephemeral node, or
 * the `hadoku-builder` label for a standing one. `src/runners/drain.ts` is
 * explicit that implementing only one "is worse than none".
 *
 * NOTHING DRAINED IS A PASS. An empty drain set has nothing to enforce, and that
 * is the one case here where silence is the right answer. AN UNREADABLE HISTORY
 * IS NOT: it is a question we could not answer, and answering "every drain is
 * holding" would put work back onto a box somebody is holding a screwdriver
 * over.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { manifest, stateDir } from './lib/paths.mjs';
import { createEmitter } from './lib/emit.mjs';
import { drainViolations, drainHonoured, recordNodeOf } from './lib/drain-enforcement.mjs';

// `--json` bound to a flag, as json-contract.test.mjs requires of every script
// under contract. The emitter reads argv itself; this const is the binding the
// gate looks for and the thing a reader greps.
const JSON_OUT = process.argv.includes('--json');
const out = createEmitter({ argv: process.argv });

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	// Through the emitter, not console.log: this script is under the --json
	// contract and emit.test.mjs holds every stdout write to one channel. The
	// emitter already gives --help precedence over --json, so a person asking
	// for usage gets prose and no consumer ever passes both.
	out.log('fleet drain-check — is every drain actually being enforced?');
	out.log('');
	out.log('  --json    machine-readable findings');
	out.log('');
	out.log('Reads the drain set and compares it against job history: a drained node');
	out.log('that STARTED work after its drain is a drain that is not in force.');
	out.log('Set or clear a drain with `fleet drain`.');
	process.exit(0);
}

const FILE = 'fleet-drain.json';
/** New location first; the pre-2026-09-04 manifest-dir copy is still honoured. */
const path = [join(stateDir(), FILE), manifest(FILE)].find((p) => existsSync(p));

let state = {};
if (path) {
	const raw = readFileSync(path, 'utf8');
	if (raw.trim()) {
		const doc = JSON.parse(raw);
		state = doc.nodes ?? doc;
	}
}

const HISTORY = join(stateDir(), 'job-history.jsonl');
if (!existsSync(HISTORY)) {
	out.warn(`no job history at ${HISTORY}, so enforcement cannot be verified.`);
	if (JSON_OUT)
		out.emit({
			ok: false,
			why: 'no-history',
			drained: Object.keys(state).length,
			violations: [],
			honoured: [],
			lines: out.held(),
		});
	process.exit(1);
}

const history = [];
for (const line of readFileSync(HISTORY, 'utf8').split('\n')) {
	const t = line.trim();
	if (!t) continue;
	try {
		history.push(JSON.parse(t));
	} catch {
		/* a truncated final line costs one record, by the writer's design */
	}
}

const nodeOf = recordNodeOf(Object.keys(state));

const violations = drainViolations(state, history, nodeOf);
const honoured = drainHonoured(state, violations);
const names = Object.keys(state);

out.log(`Drained nodes: ${names.length}   history records: ${history.length}`);
for (const v of violations) {
	out.warn(`${v.kind.padEnd(13)} ${v.node}`);
	out.warn(`              ${v.why}`);
	for (const j of v.jobs) out.warn(`                ${j.startedAt}  ${j.unit}`);
}
for (const h of honoured) {
	out.log(`  honoured   ${h.node}  (${h.kind}, since ${h.since.slice(0, 19)})`);
}
if (!names.length) out.log('nothing is drained — nothing to enforce.');
else if (!violations.length) {
	out.log('✓ every drain is being enforced — no drained node has started work since');
}

if (JSON_OUT) {
	out.emit({
		ok: violations.length === 0,
		drained: names.length,
		historyRecords: history.length,
		violations,
		honoured,
		lines: out.held(),
	});
}

process.exit(violations.length ? 1 : 0);
