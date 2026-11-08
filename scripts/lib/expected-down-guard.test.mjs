/**
 * Nothing may ssh a node without asking whether it is EXPECTED down.
 *
 * Six gates already deferred a node drained with `kind: maintenance`
 * (`deferralFor` + `deferralNote`, `lib/expected-down.mjs`) before issue #71.
 * Five more sshed nodes and failed on plain unreachability with no such
 * question asked, so draining a node for maintenance quieted six gates and
 * left five paging `@here` (hadoku_site#420). Behaviour tests catch a wrong
 * ANSWER; they cannot catch a SIXTH SCRIPT that never asks the question — that
 * is exactly how five accumulated beside the first six. Only a structural
 * check over the source tree keeps the count from growing again, the same
 * shape `node-identity-guard.test.mjs` holds for `isLocalNode()`.
 *
 * It lives here, beside that guard, for the same two reasons: it must import
 * `blankComments` (which `tsconfig.json` cannot see, with no `allowJs`), and it
 * must read the SOURCE tree — a test compiled into `dist/tests/` is looking at
 * the wrong files.
 *
 * COMMENTS ARE BLANKED FIRST. This repo has been bitten three times by a grep
 * that read a COMMENT as evidence (CLAUDE.md), and every file this guard
 * inspects — including this one — quotes `deferralFor` and `runOn` in its own
 * prose. A rule about source must never be satisfiable by writing about it.
 *
 * WHAT COUNTS AS "SSHES A NODE": a top-level `scripts/*.mjs` file (never a
 * `.test.mjs`, never `scripts/lib/**`) that imports `runOn` or `runOnSync`
 * from `./lib/fleet-exec.mjs` — the one place this package reaches a node over
 * ssh (`src/lib/node-identity.ts`'s sibling rule for REACHING a box, where
 * `isLocalNode()` is the rule for NAMING one).
 *
 * WHAT COUNTS AS "ASKS THE QUESTION": the same two facts
 * `expected-down.test.mjs`'s own wiring test already requires of its seven —
 * an import of `deferralFor` (or `deferralNote`, which no caller takes without
 * it) from `./lib/expected-down.mjs`, AND a call to `deferralFor(`. An import
 * with no call is exactly the "wired nothing calls" shape CLAUDE.md warns a
 * helper can fall into.
 *
 * EXEMPTIONS ARE NAMED, NOT INFERRED. A script that sshes a node but never
 * turns an unreachable result into a blocking finding — or whose unreachable
 * result IS the thing an operator explicitly asked this one invocation to
 * answer — has nothing for `deferralFor` to narrow. Widening the guard to
 * those scripts would not add a safety property; it would make the guard
 * unsatisfiable by a script that is already correct, which is how a guard
 * gets disabled instead of obeyed. Each entry below says WHY, by the same
 * rule CLAUDE.md gives `check-queue-health`'s findings: a reason, not a mark.
 *
 * Two exemptions WERE a NAMED GAP, not a clean bill, until #74 closed them:
 * `check-runner-units.mjs` and `collect-job-metrics.mjs` both failed the run
 * on a plain unreachable node with no `deferralFor` call, which was the #71
 * bug in two more places #71 never named. Both now ask the question the same
 * way the first five do — same `deferralFor`/`deferralNote`/`readDrains`
 * import, unreachability only, `DEFER_DAYS` expiry — so the KNOWN-GAP count is
 * zero. EXEMPT below is NOT empty: it still holds entries for scripts that ssh
 * a node and correctly have nothing for `deferralFor` to narrow (see the WHY on
 * each one) — those are reasoned exemptions, not debt. The debt-list shape
 * (named and shrinking, not silent) is kept here in prose rather than in a Map
 * so a diff adding a KNOWN-GAP row back is still a one-line diff with no other
 * entries to disturb.
 *
 * THE STRUCTURAL HALF ONLY (wave 5s lane B, pure move): the behavioural
 * fixtures that run each of the seven gates for real against a throwaway
 * manifest now live in `expected-down-guard-behaviour.test.mjs`, split off to
 * bring this file under the 1,000-line test ceiling. Every test body there is
 * unchanged from where it lived here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRIPTS_DIR = join(ROOT, 'scripts');

/** The one place this package reaches a node over ssh. */
const SSH_IMPORT = /from\s+'\.\/lib\/fleet-exec\.mjs'/;
const SSH_CALL = /\brunOn(?:Sync)?\s*\(/;
const DEFER_IMPORT = /from\s+'\.\/lib\/expected-down\.mjs'/;
const DEFER_CALL = /\bdeferralFor\s*\(/;

/**
 * Named exemptions. Each entry is a top-level `scripts/*.mjs` filename and the
 * reason it sshes a node without `deferralFor` and is still correct.
 *
 * SORTED, so a diff adding one is a one-line diff.
 */
const EXEMPT = new Map([
	[
		'backstop-tools.mjs',
		'reads the backstop, the controller where mgmt-api itself runs: the probe is local, ' +
			'never ssh, and a controller that is down is not running this at all.',
	],
	[
		'node-users-cutover.mjs',
		'operator-invoked against ONE named node that it REQUIRES to be drained: ' +
			'the drain is its precondition, not a reason to defer. An unreachable node ' +
			'there stops the cutover with the reason, and nothing is changed.',
	],
	[
		'node-status.mjs',
		'a TENANT reads this to decide whether a node can hold live work, and a node ' +
			'drained for maintenance is exactly one that cannot. Deferring its ' +
			'unreachability would report a powered-off box as fine to the one reader ' +
			'that must not be told so. Its drain is reported beside it instead.',
	],
	[
		'hosting.mjs',
		'operator-invoked against ONE named node, and an unreachable node is a ' +
			'refusal to change what it serves, not a finding. `--check` reports the ' +
			'hosting nodes, which are held by a `hosting` drain that deferralFor never ' +
			'defers anyway (only `maintenance` is expected down).',
	],
	[
		'lan-reserve.mjs',
		'operator-invoked against ONE named node, and it writes a record about that ' +
			'node. A drained node is still on its address, so it can still be recorded; an ' +
			'unreachable one cannot be, and refusing loudly is the only honest answer. No ' +
			'cron runs it — the nightly LAN check lives in check-fleet-preflight.mjs, which ' +
			'does consult expected-down.',
	],
	[
		'floor-probe.mjs',
		'the forced-placement harness. `--node`/`--onto` name the ONE box a mode ' +
			'acts on, explicitly, by the operator invoking it; its default `report` ' +
			'mode makes no ssh call at all. Per wave1-2026-09-08: "the floor-probe ' +
			'cron is unwired" — nothing runs this unattended, so an unreachable node ' +
			'is the probe answering the question it was asked, not a background page.',
	],
	[
		'join-workload-benchmark.mjs',
		'READ-ONLY analysis. Its ssh probe classes a failure as `unreachable` and ' +
			'excludes that node from the join — EXPLICITLY never counted toward the ' +
			'exit code (`process.exit(benchmarkUnavailable.length ? 1 : 0)`, a LOCAL, ' +
			'non-ssh fact). An unreachable node changes what gets measured, never ' +
			'whether the run passes, so there is no blocking finding for `deferralFor` ' +
			'to narrow.',
	],
	[
		'prove-job.mjs',
		'`--node <name>` is REQUIRED and names the one node being proved. An ' +
			'unreachable node here is not a background page about the fleet — it is ' +
			'the proof the operator asked for, failing on its own subject.',
	],
	[
		'provision-fleet.mjs',
		'`--machine <node>` runs the onboarding chain FOR that one node, which must ' +
			"be reachable as the chain's own job — bringing it up. Deferring its " +
			'unreachability would silently skip onboarding steps rather than report ' +
			'the fact actually being provisioned.',
	],
	[
		'seed-node-cache.mjs',
		'A WRITE operation. Invoked either by an operator directly, or by ' +
			"`provision-fleet`'s onboarding chain scoped to the ONE node it is " +
			'currently bringing up (`--machine <node>`) — an unreachable node there ' +
			"is that seeding step's own failure, not a fleet-health page, and no cron " +
			'runs this against the idle fleet.',
	],
	[
		'seed-runner-python.mjs',
		'A WRITE operation, operator-run, not cron-wired. An unreachable node is ' +
			'the seeding attempt failing on its own target, the same shape as ' +
			'seed-node-cache.mjs above.',
	],
	[
		'traffic-status.mjs',
		'SIMULATES placement; never writes, dispatches or labels. `busyOf()` ' +
			'returns null for an unreachable node — "UNREACHABLE IS NOT IDLE", its ' +
			'own comment — which changes the PREVIEWED order, never the exit code: ' +
			'every path through this file calls `process.exit(0)`.',
	],
]);

function topLevelScripts() {
	return readdirSync(SCRIPTS_DIR)
		.filter((f) => /\.mjs$/.test(f) && !/\.test\.mjs$/.test(f))
		.sort();
}

function sshingScripts() {
	const out = [];
	for (const f of topLevelScripts()) {
		const blanked = blankComments(readFileSync(join(SCRIPTS_DIR, f), 'utf8'));
		if (SSH_IMPORT.test(blanked) && SSH_CALL.test(blanked)) out.push(f);
	}
	return out;
}

void test('every script that sshes a node asks whether it is expected down, or is a named exemption', () => {
	const offenders = [];
	for (const f of sshingScripts()) {
		if (EXEMPT.has(f)) continue;
		const blanked = blankComments(readFileSync(join(SCRIPTS_DIR, f), 'utf8'));
		const asksImport = DEFER_IMPORT.test(blanked);
		const asksCall = DEFER_CALL.test(blanked);
		if (!asksImport || !asksCall) {
			offenders.push(
				`${f}: ${!asksImport ? 'never imports' : 'imports but never calls'} deferralFor`
			);
		}
	}

	assert.deepEqual(
		offenders,
		[],
		`these script(s) ssh a node and fail on plain unreachability with no ` +
			`deferralFor call — draining a node for maintenance will page them ` +
			`(issue #71, hadoku_site#420):\n  ${offenders.join('\n  ')}\n\n` +
			'Either import { deferralFor, deferralNote, readDrains } from ' +
			"'./lib/expected-down.mjs' and defer a drained node's unreachability " +
			'the way the other gates do, or add a named entry to EXEMPT in this ' +
			'file explaining why an unreachable node there is not a blocking finding.'
	);
});

void test('the guard is not vacuous — it actually finds ssh-ing scripts', () => {
	// A guard with nothing to check passes by construction. This repo has three
	// prior instances of a rule reading as enforced because nobody fed it any
	// input — the same failure `check-tool-inventory.mjs`'s "examined 0" guard
	// and `check-boundary-contracts.mjs`'s zero-machines guard both exist for.
	const found = sshingScripts();
	assert.ok(
		found.length > 10,
		`expected well over a dozen ssh-ing scripts, found ${found.length}: ${found.join(', ')} — ` +
			'the SSH_IMPORT/SSH_CALL pattern may have stopped matching'
	);
});

void test('every EXEMPT entry still names a real, ssh-ing script, with a real reason', () => {
	const sshing = new Set(sshingScripts());
	const stale = [];
	for (const [f, why] of EXEMPT) {
		if (!sshing.has(f))
			stale.push(
				`${f}: no longer sshes a node (or no longer exists) — ` +
					'drop this exemption, it is not protecting anything'
			);
		if (!why || why.length < 20)
			stale.push(`${f}: exemption reason is missing or too thin to audit`);
	}
	assert.deepEqual(stale, []);
});

void test('the seven gates fixed for #71/#74 each hold the full pattern: import, read, call, note', () => {
	// Narrower than the structural scan above, and deliberately redundant with
	// it: this is the fixed list from the lane briefs, so a regression here
	// names the exact file rather than waiting for the general scan to notice.
	// The last two are #74's half: the two gaps #71 named but did not fix.
	for (const f of [
		'clean-runner-debris.mjs',
		'reconcile-fleet-runners.mjs',
		// RENAMED wave gates2 lane F1a: check-tool-inventory.mjs -> tool-inventory.mjs,
		// check-runner-units.mjs -> runner-units.mjs. Both still carry the full
		// pattern directly, unchanged in substance.
		'tool-inventory.mjs',
		'check-boundary-contracts.mjs',
		'check-warm-canary.mjs',
		'runner-units.mjs',
		'collect-job-metrics.mjs',
	]) {
		const blanked = blankComments(readFileSync(join(SCRIPTS_DIR, f), 'utf8'));
		assert.match(blanked, DEFER_IMPORT, `${f} no longer imports lib/expected-down.mjs`);
		assert.match(blanked, /\bdeferralFor\s*\(/, `${f} no longer calls deferralFor(`);
		assert.match(
			blanked,
			/\bdeferralNote\s*\(/,
			`${f} no longer calls deferralNote( — a deferred node must still be PRINTED`
		);
		assert.match(blanked, /\breadDrains\s*\(/, `${f} no longer calls readDrains(`);
	}
});
