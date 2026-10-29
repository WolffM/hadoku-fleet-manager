/**
 * Shared debt-list mechanics for the F-item guards (plan §4.1 step 1, wave
 * 5a §D). Each `<F>-guard.test.mjs` finds today's copies of one
 * pattern-detectable duplication with its own regex, then hands the list to
 * `assertDebt` here, which is the only place that compares a finding against
 * `debt.json` and decides pass/fail. One mechanism, eight callers — a second
 * copy of "a new entry fails, a stale entry fails" would be exactly the kind
 * of duplication this directory exists to guard against.
 *
 * COMMENTS ARE BLANKED FIRST (`blank-comments.mjs`), as in node-identity-guard
 * and node-users-guard: the prose explaining a rule quotes the shape it
 * forbids, and a regex that read comments as code would trip on its own
 * documentation.
 *
 * Fixtures and tests are excluded from the walk, the same way the existing
 * guards exclude them — by directory name and by the two fixture files this
 * repo already has that are not named `*.test.*` but exist only for tests to
 * import (`scripts/lib/fake-node.mjs`, `scripts/lib/fleet-source-fixture.mjs`).
 * Both are confirmed by grep to have zero non-test importers; a third file
 * that earns the same treatment should be added here with the same kind of
 * check, not guessed at.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from '../blank-comments.mjs';

export const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

/** Directories never walked: build output, deps, and known test/fixture trees. */
const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'__pycache__',
	'tests',
	'planning',
	'fake-node',
]);

/** Non-test files that exist only to be imported BY tests (zero non-test importers). */
const FIXTURE_FILES = new Set([
	'scripts/lib/fake-node.mjs',
	'scripts/lib/fleet-source-fixture.mjs',
]);

function walk(dir, out) {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const p = join(dir, entry);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

/**
 * Every non-test `.ts`/`.mjs` source file under `src/` and `scripts/`, as
 * `{ rel, code }` with comments blanked. Shared across every F-guard so each
 * one pays the read-and-blank cost once per test process, not once per guard.
 */
export function tsAndMjsSources() {
	const abs = [...walk(join(ROOT, 'src'), []), ...walk(join(ROOT, 'scripts'), [])];
	const out = [];
	for (const p of abs) {
		if (!/\.(ts|mjs)$/.test(p)) continue;
		if (/\.test\.(ts|mjs)$/.test(p)) continue;
		const rel = relative(ROOT, p);
		if (FIXTURE_FILES.has(rel)) continue;
		out.push({ rel, code: blankComments(readFileSync(p, 'utf8')) });
	}
	return out;
}

/** 1-based line number of a character offset in `code`. */
export function lineOf(code, at) {
	return code.slice(0, at).split('\n').length;
}

/**
 * The identifier of the function/const the given offset falls inside, by
 * walking backward for the nearest `function NAME(` or `const NAME =`. Falls
 * back to `null` (the caller then names the site by pattern+index instead).
 * This is a heuristic, not a parser — good enough to produce a stable,
 * readable debt key, not to be load-bearing for correctness.
 */
export function enclosingSymbol(code, at) {
	const head = code.slice(0, at);
	const fn = head.match(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*$/);
	let best = null;
	let bestIndex = -1;
	for (const m of head.matchAll(
		/(?:function\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=)/g
	)) {
		if (m.index > bestIndex) {
			bestIndex = m.index;
			best = m[1] ?? m[2];
		}
	}
	return best ?? (fn ? fn[1] : null);
}

/**
 * Debt-list assertion, shared by every `<F>-guard.test.mjs`.
 *
 * `found` is the list of `file:symbol` keys the guard's own regex matched
 * against the CURRENT tree. `debtKey` selects the list inside `debt.json`
 * this F-item owns. `helperHint` is folded into the failure message so a
 * contributor who trips the guard is told what to build or where the entry
 * goes, not just that something broke.
 *
 * Two directions fail, by design (plan §4.1 step 1 / §10): a key present in
 * `found` but not in the debt list is a NEW copy; a key present in the debt
 * list but not in `found` is STALE (the thing it named no longer matches, so
 * the list is lying about what is left). The list may only shrink.
 */
export function assertDebt(assert, debt, debtKey, found, helperHint) {
	const known = new Set(debt[debtKey] ?? []);
	const foundSet = new Set(found);

	// `debtKey` is always `F<n>` or `F<n>-<shape>` (e.g. `F3-non-atomic`), so
	// the item number is its own leading digits — one extraction point for
	// the plan pointer every NEW-copy message below carries.
	const itemNumber = debtKey.match(/^F(\d+)/)?.[1];
	const planPointer = itemNumber
		? `See docs/planning/refactor-plan-2026-10-28.md §4.1 (F${itemNumber}).`
		: '';

	const fresh = found.filter((k) => !known.has(k)).sort();
	assert.deepEqual(
		fresh,
		[],
		`${debtKey}: NEW copy not in scripts/lib/f-guards/debt.json["${debtKey}"]:\n  ${fresh.join(
			'\n  '
		)}\n\n${helperHint} ${planPointer}\n\nEither build the helper and migrate this site, or — only ` +
			`if it is a genuine, reviewed addition to the debt — add its key to debt.json with the rest.`
	);

	const stale = [...known].filter((k) => !foundSet.has(k)).sort();
	assert.deepEqual(
		stale,
		[],
		`${debtKey}: debt.json names a copy that no longer matches the pattern:\n  ${stale.join(
			'\n  '
		)}\n\nRemove it from debt.json — the list only shrinks, never drifts. If this was a ` +
			`rename rather than a fix, the new key belongs in debt.json too.`
	);
}

export function loadDebt() {
	return JSON.parse(readFileSync(join(ROOT, 'scripts/lib/f-guards/debt.json'), 'utf8'));
}
