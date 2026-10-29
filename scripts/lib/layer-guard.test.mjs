/**
 * THE IMPORT-DIRECTION GUARD, debt-list mode, cut (i) only (wave 5a §A step 3).
 *
 * `measure-layers.mjs --json` is the MEASURING tool; this is the GATE built
 * on top of it, in the same shape `node-identity-guard.test.mjs` and
 * `node-role-guard.test.mjs` already use for a source-reading rule: a NEW
 * violation fails the build, and a debt entry that stopped being a violation
 * must be DELETED from `layer-debt.json` — the list may only shrink, which is
 * what keeps it a ratchet instead of a parking lot (the same failure mode
 * CLAUDE.md names for the mint advisory: "no gate may get EASIER to pass the
 * worse the failure gets" has a mirror image here — no gate may stay EASY to
 * pass once the thing it is forgiving has been fixed).
 *
 * WHY CUT (i) ONLY. `measure-layers.mjs` counts all four candidate cuts so
 * the operator can see what each one costs (plan §3.3). Nothing has signed
 * off on (ii)/(iii)/(iv) yet — that sign-off is wave 5b's job (plan: "5b |
 * operator signs off the cut … | 5a counts"). Gating the build on a cut
 * nobody has agreed to would make this guard the decision instead of the
 * measurement informing one.
 *
 * DEBT ENTRIES ARE `{from, to}` FILE PAIRS, never line numbers — the same
 * reason `node-users-guard.test.mjs`'s debt entries are `file:symbol`: a line
 * number rots the moment either file is edited for an unrelated reason, and a
 * rotted debt entry either matches nothing (silently loosening the guard) or
 * matches the wrong line (silently approving a different violation than the
 * one it was recorded for).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	listSourceFiles,
	classifyFiles,
	buildImportEdges,
	violationsForCut,
	CUTS,
} from '../measure-layers.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEBT_PATH = join(ROOT, 'scripts/lib/layer-debt.json');
const CUT_I = CUTS.find((c) => c.id === 'i');

function pairKey(v) {
	return `${v.from}\u0000${v.to}`;
}

/** Recomputed once per test file run; four tests below ask about the same tree. */
let cached;
function liveViolations() {
	if (cached) return cached;
	const { classified, unmatched } = classifyFiles(listSourceFiles());
	assert.deepEqual(
		unmatched,
		[],
		'layer-map.mjs must be total before this guard can mean anything'
	);
	const { edges } = buildImportEdges(classified);
	cached = violationsForCut(edges, classified, CUT_I);
	return cached;
}

function readDebt() {
	/** @type {Array<{from: string, to: string}>} */
	const debt = JSON.parse(readFileSync(DEBT_PATH, 'utf8'));
	for (const d of debt) {
		assert.equal(typeof d.from, 'string', `debt entry missing "from": ${JSON.stringify(d)}`);
		assert.equal(typeof d.to, 'string', `debt entry missing "to": ${JSON.stringify(d)}`);
	}
	return debt;
}

test('no NEW import-direction violation beyond the recorded debt', () => {
	const live = new Set(liveViolations().map(pairKey));
	const debt = new Set(readDebt().map(pairKey));
	const brandNew = [...live].filter((k) => !debt.has(k)).map((k) => k.split('\u0000').join(' -> '));
	assert.deepEqual(
		brandNew,
		[],
		`these imports go UP a layer or sideways across domains, and are not in ` +
			`scripts/lib/layer-debt.json:\n  ${brandNew.join('\n  ')}\n\n` +
			'Fix the import — reach the fact through a state record, an access/config ' +
			'reader, or move the decision to the layer that owns it — rather than adding ' +
			'to the debt list: this guard only ever lets the list shrink.'
	);
});

test('the debt list only ever SHRINKS — a fixed entry must be deleted from layer-debt.json', () => {
	const live = new Set(liveViolations().map(pairKey));
	const debt = readDebt();
	const healed = debt.filter((d) => !live.has(pairKey(d)));
	assert.deepEqual(
		healed,
		[],
		`these are no longer violations and must be REMOVED from scripts/lib/layer-debt.json:\n  ` +
			`${healed.map((d) => `${d.from} -> ${d.to}`).join('\n  ')}`
	);
});

test('every debt entry still names two files this run actually classifies', () => {
	// A rename on either side would otherwise leave a debt entry matching
	// nothing, silently narrowing what the guard enforces — the same "a
	// rotted exemption list hides what it stopped covering" trap
	// node-role-guard.test.mjs closes for UNGATED.
	const { classified } = classifyFiles(listSourceFiles());
	const debt = readDebt();
	const dangling = debt.filter((d) => !classified.has(d.from) || !classified.has(d.to));
	assert.deepEqual(
		dangling,
		[],
		`these debt entries name a file this run does not classify (renamed, moved, or ` +
			`deleted) and must be fixed or removed:\n  ` +
			`${dangling.map((d) => `${d.from} -> ${d.to}`).join('\n  ')}`
	);
});

test('MUTATION — an upward import added in a FIXTURE fails the guard', () => {
	// Against FIXTURE entries, never the real tree: lane A shares this
	// worktree with three others, and mutating a real import to watch the
	// guard fail would be a change to a file none of this lane owns.
	const classified = new Map([
		['fixture/config-file.mjs', { layer: 'config' }],
		['fixture/ci-scheduling-core.ts', { layer: 'domain', domain: 'ci-scheduling', part: 'core' }],
		['fixture/tenancy-core.ts', { layer: 'domain', domain: 'tenancy', part: 'core' }],
	]);

	const clean = violationsForCut(
		[{ from: 'fixture/ci-scheduling-core.ts', to: 'fixture/config-file.mjs' }], // DOWN: allowed
		classified,
		CUT_I
	);
	assert.deepEqual(clean, [], 'a domain file importing config (downward) must not be flagged');

	const upward = violationsForCut(
		[{ from: 'fixture/config-file.mjs', to: 'fixture/ci-scheduling-core.ts' }], // UP: a violation
		classified,
		CUT_I
	);
	assert.deepEqual(
		upward,
		[{ from: 'fixture/config-file.mjs', to: 'fixture/ci-scheduling-core.ts' }],
		'config importing a domain file (upward) must be flagged'
	);

	const lateral = violationsForCut(
		[{ from: 'fixture/ci-scheduling-core.ts', to: 'fixture/tenancy-core.ts' }], // sideways: a violation under cut (i)
		classified,
		CUT_I
	);
	assert.deepEqual(
		lateral,
		[{ from: 'fixture/ci-scheduling-core.ts', to: 'fixture/tenancy-core.ts' }],
		'one domain importing a sibling domain must be flagged under cut (i)'
	);
});
