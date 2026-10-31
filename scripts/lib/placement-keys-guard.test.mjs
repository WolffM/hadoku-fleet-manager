/**
 * The "two assignment paths" class, for manifest machine keys (#82's shape).
 *
 * `excludeRepos` was declared, documented and read by the reconciler's
 * `mayRunRepo` for over six weeks while the JIT dispatcher — a completely
 * separate assignment path, `ephemeral-tick.ts` -> `placement.ts` — hardcoded
 * `eligible: true` for every node and never looked at it. claw-3 ran 122 of
 * its 815 jobs (15%) for repos it excludes, as recently as 2026-10-03T09:21Z.
 * Nothing was wrong with `excludeRepos` itself; nothing connected its SECOND
 * reader to it.
 *
 * This guard is the structural check that stops that recurring for the next
 * key someone adds to `mayRunRepo`/`placementFor`. It does NOT re-verify the
 * behaviour (`placement.test.ts` / `src/tests` already do that against real
 * `NodeState`s) — it verifies that every key the RECONCILER treats as a
 * placement decision is EITHER also referenced somewhere on the JIT mint
 * path, or is named in `RECONCILER_ONLY` with a reason a reviewer can read
 * and disagree with.
 *
 * COMMENTS ARE BLANKED FIRST — the same reason `node-identity-guard.test.mjs`
 * does it: several of the files this reads quote the very key names in prose
 * (this file included), and a raw grep would score that as "honoured".
 *
 * WHY THIS LIVES IN scripts/, NOT src/tests/: same two reasons as
 * `node-identity-guard.test.mjs` — it must read the SOURCE tree (a test
 * compiled into `dist/tests/` is looking at the wrong files), and it imports
 * `blankComments`, which a `.ts` file cannot reach with `allowJs` off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const PLACEMENT_RULES = 'scripts/lib/placement-rules.mjs';
// placementFor moved to reconcile-plan.mjs (wave 5g lane C, pure move) — this
// constant still names wherever the fleet reconciler's placement decision
// lives, not a fixed file.
const RECONCILER = 'scripts/lib/reconcile-plan.mjs';
const MINT_TICK = 'src/runners/ephemeral-tick.ts';
const MINT_PLACEMENT = 'src/runners/placement.ts';

function read(rel) {
	return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * The text between a function's own `function name(` and the brace that
 * closes it, found by counting braces rather than matching a regex up to the
 * next `\n}` — this file's functions nest `.filter()` chains, so the first
 * UNINDENTED `}` is not necessarily the function's own.
 *
 * THE PARAMETER LIST IS SKIPPED BY PAREN-DEPTH FIRST, not by jumping straight
 * to the first `{` after the name: a TS parameter's type annotation can carry
 * its own object-type literal (`gh: GhLike & { get: (...) => Promise<T> }`,
 * exactly what `dispatchWarmCache` takes) whose `{` and `}` would otherwise be
 * mistaken for the function's own body — the very first version of this
 * function read `{ get: ... }` as the whole of `dispatchWarmCache` and passed
 * vacuously.
 */
function functionBody(blanked, name) {
	const start = blanked.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `could not find "function ${name}(" — did it get renamed?`);
	const openParen = blanked.indexOf('(', start);
	let depth = 0;
	let afterParams = -1;
	for (let i = openParen; i < blanked.length; i++) {
		if (blanked[i] === '(') depth++;
		else if (blanked[i] === ')') {
			depth--;
			if (depth === 0) {
				afterParams = i + 1;
				break;
			}
		}
	}
	assert.ok(afterParams >= 0, `unbalanced parens reading function ${name}'s parameter list`);
	// Past the params, skip any `: ReturnType` annotation (which can itself
	// nest `<...>` and `{...}` for a generic or inline object return type) by
	// taking the FIRST `{` at paren/angle-bracket depth 0.
	let anglesAndParens = 0;
	let openBrace = -1;
	for (let i = afterParams; i < blanked.length; i++) {
		const c = blanked[i];
		if (c === '<' || c === '(') anglesAndParens++;
		else if (c === '>' || c === ')') anglesAndParens--;
		else if (c === '{' && anglesAndParens === 0) {
			openBrace = i;
			break;
		}
	}
	assert.ok(openBrace >= 0, `could not find the body's opening brace for function ${name}`);
	let bodyDepth = 0;
	for (let i = openBrace; i < blanked.length; i++) {
		if (blanked[i] === '{') bodyDepth++;
		else if (blanked[i] === '}') {
			bodyDepth--;
			if (bodyDepth === 0) return blanked.slice(openBrace, i + 1);
		}
	}
	throw new Error(`unbalanced braces reading function ${name}`);
}

/** Every `m.<key>` (or `(m.<key> ?? ...)`) property access in `body`, where
 *  `m` is the manifest MACHINE entry — the variable name both
 *  `placement-rules.mjs` and `reconcile-plan.mjs` use for it. */
function machineKeysReferenced(body) {
	const keys = new Set();
	for (const match of body.matchAll(/\bm\.(\w+)\b/g)) keys.add(match[1]);
	// A key read THROUGH its one reader in `src/lib/node-role.ts` is still a key
	// read. Without this a placement lever moved behind a helper would vanish
	// from the table — the guard reporting the keys it can see, not the ones the
	// function reads.
	for (const [helper, key] of Object.entries(NODE_ROLE_READERS)) {
		if (new RegExp(`\\b${helper}\\(m\\)`).test(body)) keys.add(key);
	}
	return keys;
}

/** `src/lib/node-role.ts` readers, by the manifest key each one reads. */
const NODE_ROLE_READERS = { mintsOnDemand: 'mint', standingRepos: 'standingRepos' };

/**
 * `mayRunRepo` answers "whose box may this repo's work land on AT ALL" —
 * its own docblock's words — which is the question BOTH assignment paths
 * must agree on. Its keys, as of this writing: `placement`, `excludeRepos`,
 * `labels` (via `needs.every(...).includes`).
 */
const MAY_RUN_REPO_KEYS = ['placement', 'excludeRepos', 'labels'];

/**
 * `placementFor`'s OWN filter, layered on top of `mayRunRepo`, answers a
 * narrower question — "who HOLDS A STANDING REGISTRATION" — which the
 * function's own docblock says diverges from `mayRunRepo` exactly on
 * ephemeral nodes (claw-3 holds no standing registration for anything and
 * still mints constantly). Its keys: `ephemeral`, `residentRepos`.
 */
const PLACEMENT_FOR_EXTRA_KEYS = ['ephemeral', 'residentRepos', 'mint', 'standingRepos'];

/**
 * The full table. Each entry is either `mint: <file>` naming the file on the
 * JIT mint path that honours it (checked below with a pattern, not just a
 * grep for the bare key name — a bare name would match this guard's own
 * strings) or `reconcilerOnly: <reason>` — a reason a reviewer can disagree
 * with, not a loophole with no text in it.
 */
const PLACEMENT_KEYS = {
	placement: {
		mint: MINT_TICK,
		// `m.placement !== 'excluded'` — added wave 3w (#82's shape, found while
		// writing this guard: nothing on the mint path read this key before).
		pattern: /m\.placement\s*!==\s*['"]excluded['"]/,
	},
	excludeRepos: {
		mint: MINT_TICK,
		// `m.excludeRepos ? new Map(Object.entries(m.excludeRepos)) : undefined` —
		// carried into `NodeState.excludedRepos`, enforced in `placement.ts`'s
		// `refusalFor`. Added wave 3w, #82.
		pattern: /m\.excludeRepos/,
	},
	labels: {
		mint: MINT_TICK,
		// Not read as `m.labels` directly here — `offerFor` DERIVES the offer
		// from the manifest node through `nodeOffer` (src/capabilities.ts),
		// which is the whole point (labels are EARNED, not declared verbatim).
		// The structural fact this checks is that the mint path still asks that
		// function rather than hardcoding a label list.
		pattern: /offerFor\(/,
	},
	ephemeral: {
		reconcilerOnly:
			'this key IS the mint path’s own eligibility set (`input.ephemeral`, built by ' +
			'`loadEphemeralNodes` in fleet-loop.ts): a node is a JIT target BECAUSE it carries ' +
			'`ephemeral: true`, so there is no further "does the mint path honour this" question ' +
			'to ask — asking it would be circular. `placementFor` consults it only to decide the ' +
			'DIFFERENT, STANDING-registration question (see `placementFor`’s own docblock: ' +
			'claw-3 holds no standing registration for anything and mints constantly anyway).',
	},
	mint: {
		mint: MINT_TICK,
		// `onDemandGuests` (#120): the same key that narrows a guest's standing
		// registrations here is what makes the dispatcher mint for it, read
		// through the same `mintsOnDemand`.
		pattern: /mintsOnDemand\(input\.nodes\[n\]\)/,
	},
	standingRepos: {
		reconcilerOnly:
			'a STANDING-registration list, the on-demand guest’s counterpart of `residentRepos`: ' +
			'which repos keep a registration that does not wait for the dispatcher (hadoku_site’s ' +
			'deploy runner, because the dispatcher lives in what it deploys). The mint path has ' +
			'nothing to decide with it — the guest is minted for every repo `mayRunRepo` allows.',
	},
	residentRepos: {
		reconcilerOnly:
			'residency is a STANDING-registration concept and has no meaning on an ephemeral node ' +
			'— `placementFor`’s own docblock: "An EPHEMERAL node mints a runner per job, so the ' +
			'only standing registrations it keeps are its resident set". The JIT mint path never ' +
			'reads it because there is nothing for it to decide there; see ' +
			'`ephemeral-tick.ts`’s own `$why-residentRepos-empty` manifest notes for the same ' +
			'point from the operator side.',
	},
};

void test('every key mayRunRepo reads is in this guard’s table (fails the build on a NEW one)', () => {
	const body = functionBody(blankComments(read(PLACEMENT_RULES)), 'mayRunRepo');
	const found = [...machineKeysReferenced(body)].sort();
	assert.deepEqual(
		found,
		[...MAY_RUN_REPO_KEYS].sort(),
		`mayRunRepo now reads ${JSON.stringify(found)}, but this guard only knows about ` +
			`${JSON.stringify(MAY_RUN_REPO_KEYS)}. A key present in one list and not the other is ` +
			'either a new placement lever the JIT mint path has never heard of, or a key this guard ' +
			'can retire — add it to PLACEMENT_KEYS (with a `mint` pattern or a `reconcilerOnly` ' +
			'reason) and to MAY_RUN_REPO_KEYS above, deliberately.'
	);
});

void test('every key placementFor adds beyond mayRunRepo is in this guard’s table', () => {
	const body = functionBody(blankComments(read(RECONCILER)), 'placementFor');
	// Exclude the `mayRunRepo(repo, manifest)` call itself — that is not a
	// property access on a machine entry and matches nothing below — so what
	// is left is placementFor's OWN filter chain.
	const found = [...machineKeysReferenced(body)].sort();
	assert.deepEqual(
		found,
		[...PLACEMENT_FOR_EXTRA_KEYS].sort(),
		`placementFor now reads ${JSON.stringify(found)} beyond mayRunRepo, but this guard only ` +
			`knows about ${JSON.stringify(PLACEMENT_FOR_EXTRA_KEYS)}. Same remedy as the test above.`
	);
});

void test('every placement key is honoured by the JIT mint path, or explicitly reconciler-only with a reason', () => {
	const sources = {
		[MINT_TICK]: blankComments(read(MINT_TICK)),
		[MINT_PLACEMENT]: blankComments(read(MINT_PLACEMENT)),
	};
	const offenders = [];
	for (const [key, rule] of Object.entries(PLACEMENT_KEYS)) {
		if (rule.reconcilerOnly) {
			assert.ok(
				rule.reconcilerOnly.trim().length > 20,
				`${key} is marked reconcilerOnly with no real reason — that is a loophole, not a decision`
			);
			continue;
		}
		const src = sources[rule.mint];
		assert.ok(src !== undefined, `${key} names an unread file ${rule.mint} — fix PLACEMENT_KEYS`);
		if (!rule.pattern.test(src))
			offenders.push(`${key} (expected ${rule.pattern} in ${rule.mint})`);
	}
	assert.deepEqual(
		offenders,
		[],
		'these placement keys are honoured by the reconciler but NOT found on the JIT mint path, ' +
			`and are not listed as reconcilerOnly:\n  ${offenders.join('\n  ')}\n\n` +
			'Either wire the mint path to read them (ephemeral-tick.ts builds NodeState; ' +
			'placement.ts enforces it in refusalFor — see excludeRepos/placement for the shape), ' +
			'or add a reconcilerOnly reason to PLACEMENT_KEYS if the key genuinely has no JIT-side ' +
			'meaning.'
	);
});

/**
 * `excludeRepos` ALONE gets a dedicated, narrower check: `ephemeral-tick.ts`
 * holds TWO assignment paths of its own, not one. `dispatchEphemeral` mints
 * JIT runners; `dispatchWarmCache` maintains STANDING warm listeners that
 * GitHub schedules onto DIRECTLY, bypassing `choosePlacement` entirely. #82
 * was fixed on the mint path first and the manifest's exclusion still reached
 * production through the warm one: claw-5 served 23 `hadoku-cardtable` jobs
 * and 164 `hadoku_site` jobs through `warm-claw-5-*` listeners while it was
 * excluded from JIT only (send-back, wave 3w). The generic table above would
 * have passed the whole time — `excludeRepos` WAS "honoured by the JIT mint
 * path" exactly as recorded. This is the "two assignment paths IN ONE FILE"
 * case that table cannot see, so it is asserted directly, per function body.
 */
void test('excludeRepos is honoured on BOTH of ephemeral-tick.ts’s own assignment paths — mint AND warm', () => {
	const blanked = blankComments(read(MINT_TICK));
	const pattern = /\.excludeRepos\b/;
	const mintBody = functionBody(blanked, 'dispatchEphemeral');
	assert.match(
		mintBody,
		pattern,
		'excludeRepos is not read anywhere in dispatchEphemeral (the JIT mint path) any more'
	);
	const warmBody = functionBody(blanked, 'dispatchWarmCache');
	assert.match(
		warmBody,
		pattern,
		'excludeRepos is not read anywhere in dispatchWarmCache (the WARM path) — a warm listener is ' +
			'a standing registration GitHub assigns to directly, bypassing choosePlacement entirely, ' +
			'so the mint path alone enforcing this is not enough (see this test’s own docblock for ' +
			'the live evidence this was found from)'
	);
});

void test('the canonical functions this guard reads still exist where it expects them', () => {
	// A rename or a move would otherwise leave every assertion above checking
	// nothing, the same failure mode `node-identity-guard.test.mjs` guards
	// against for its own canonical file.
	assert.match(read(PLACEMENT_RULES), /export function mayRunRepo\(/);
	assert.match(read(RECONCILER), /function placementFor\(/);
	assert.match(read(MINT_TICK), /function offerFor\(/);
	assert.match(read(MINT_TICK), /function dispatchEphemeral\(/);
	assert.match(read(MINT_TICK), /function dispatchWarmCache\(/);
});
