/**
 * THE FILE-SIZE CEILING GUARD (wave 5n lane D).
 *
 * Operator, 2026-10-31 (`docs/planning/wave5n-2026-10-31.md`): the post-waves
 * refactor pass is judged on duplicates down, files organized, biggest files
 * smaller. Six waves of pure-move splits kept stopping at 1,200-1,450 lines
 * because nothing made a file's SIZE the target — a split that shaved a file
 * from 1,800 to 1,300 lines satisfied every test and every guard this repo
 * had, and the file was still too big to read in one sitting. The ceiling is
 * **800 lines for source, 1,000 for test files**, settled and not to be
 * re-opened in this guard.
 *
 * SHAPE: the same ratchet `scripts/lib/layer-guard.test.mjs` and
 * `scripts/lib/f-guards/*` already use for a debt list that may only shrink.
 * `scripts/lib/file-size-debt.json` is `{ "<path>": <recorded line count> }`,
 * sorted by path. A file over its ceiling must be on the list AT EXACTLY its
 * recorded size:
 *
 *   - over ceiling, not listed                -> FAILS (rule a: new debt)
 *   - listed, now LARGER than recorded         -> FAILS (rule b: no growth)
 *   - listed, now SMALLER than recorded,
 *     or now at/under the ceiling, or deleted  -> FAILS (rule c: stale credit)
 *   - listed at/under its own ceiling          -> FAILS (rule d: list hygiene)
 *
 * Rule (c) is the one that makes this a RATCHET rather than a ledger: a file
 * that shrank still fails until a human lowers (or removes) its entry, so
 * slack can never silently accumulate between the recorded number and the
 * real one. The corollary CLAUDE.md states for the mint advisory applies
 * here too — no gate may get EASIER to pass as the thing it watches improves
 * out from under it.
 *
 * CORPUS: every git-TRACKED file (`git ls-files`, so `.claude/worktrees/**`,
 * `node_modules`, `dist` and any vendored tree are excluded by construction —
 * the same reason `measure-layers.mjs` had to special-case a stale worktree
 * copy by hand; a tracked-files reader never sees one) under `src/`,
 * `scripts/`, `herdr/`, `deploy/` with extension `.ts` `.mjs` `.js` `.sh`
 * `.py`.
 *
 * TEST-FILE CLASSIFICATION (gets the 1,000 ceiling instead of 800): the
 * basename contains `.test.` (covers `*.test.ts` and `*.test.mjs`), ends
 * `_test.py`, ends `-fixtures.mjs`, or the path starts `src/tests/` (test
 * support that ships no production code — `capability-fixtures.ts`,
 * `helpers/fleet-fakes.ts`, `install-test-host.ts`, `tmpdir.ts` — none of
 * which matches `*.test.*` on its own).
 *
 * LINE COUNT = `wc -l` SEMANTICS, DELIBERATELY: the count of `\n` bytes, not
 * the count of non-empty lines and not `split('\n').length`. A file with no
 * trailing newline therefore reads ONE LOWER than its visible line count,
 * because `wc -l` does not count a final line that is never terminated. This
 * guard does not special-case that: it would rather match the number every
 * contributor can reproduce with `wc -l path` on their own machine than a
 * bespoke count that disagrees with the obvious command by one.
 *
 * LOWERING AN ENTRY: edit `file-size-debt.json` by hand, or run
 * `node scripts/file-size-debt.mjs --write`, which recomputes every size from
 * the tree and only ever lowers or removes an entry. Raising one, or adding a
 * brand-new one, needs `--allow-growth <path>` (repeatable; the generator
 * prints a warning for each path it was told to let grow) — without it, a
 * file that grew past its recorded size, or past its ceiling for the first
 * time, is left for the guard to fail rather than silently absorbed into the
 * list. See `scripts/file-size-debt.mjs` for the CLI.
 *
 * THE POST-WAVES REFACTOR PASS MUST EMPTY THIS LIST. A non-empty
 * `file-size-debt.json` is not a steady state; it is the inventory of what
 * that pass has not reached yet. Nothing here enforces that on its own — a
 * list that never shrinks is still a valid ratchet, just a stalled one — so
 * it is a human invariant, not a mechanical one, same as "the list only ever
 * shrinks" being a rule about the humans editing the file rather than
 * something this module could force by itself.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Source files over this many lines are debt. */
export const SOURCE_CEILING = 800;

/** Test files over this many lines are debt. */
export const TEST_CEILING = 1000;

/** Top-level directories this guard scans. Trailing slash matters for the prefix check. */
export const SCAN_DIRS = ['src/', 'scripts/', 'herdr/', 'deploy/'];

/** Extensions this guard counts as code. */
export const CODE_EXTENSIONS = new Set(['.ts', '.mjs', '.js', '.sh', '.py']);

/** The extension of `path`, including the dot, or `''` if it has none. */
export function extOf(path) {
	const base = path.slice(path.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	return dot <= 0 ? '' : base.slice(dot);
}

/**
 * True for a path this guard holds to the 1,000-line test ceiling rather
 * than the 800-line source ceiling. Pure string matching — see the header
 * for why each shape is in the list.
 */
export function isTestFile(path) {
	const base = path.slice(path.lastIndexOf('/') + 1);
	if (base.includes('.test.')) return true;
	if (base.endsWith('_test.py')) return true;
	if (base.endsWith('-fixtures.mjs')) return true;
	if (path.startsWith('src/tests/')) return true;
	return false;
}

/** The line ceiling that applies to `path`. */
export function ceilingFor(path) {
	return isTestFile(path) ? TEST_CEILING : SOURCE_CEILING;
}

/**
 * `wc -l` semantics over file CONTENT already read into memory: the count of
 * `\n` characters. See the header for why this, and not a split-length count,
 * is the deliberate choice for a file with no trailing newline.
 */
export function lineCount(content) {
	if (content.length === 0) return 0;
	let n = 0;
	for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
	return n;
}

/** True when `path` falls under one of `SCAN_DIRS` and carries a counted extension. */
export function inScope(path) {
	return SCAN_DIRS.some((d) => path.startsWith(d)) && CODE_EXTENSIONS.has(extOf(path));
}

/**
 * Every git-tracked, in-scope path under `repoRoot`, as repo-relative POSIX
 * paths. `git ls-files` is the totality guarantee: a worktree, `node_modules`,
 * `dist`, or a vendored copy is untracked or tracked elsewhere and never
 * appears here, with no SKIP_DIRS list to keep in sync by hand.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function listTrackedCodeFiles(repoRoot) {
	// Every GIT_* stripped: a git hook that runs the check exports GIT_DIR and
	// GIT_INDEX_FILE, which beat `-C` and would list the hook's repository
	// instead of `repoRoot` (src/lib/fleet-paths.ts).
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
	);
	const out = execFileSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8', env });
	return out.split('\n').filter(Boolean).filter(inScope).sort();
}

/**
 * `path -> line count` for every in-scope tracked file under `repoRoot`.
 * A file this lists is, by construction, both tracked and present on disk —
 * `git ls-files` only names files the index holds, and a path that was
 * deleted on disk but not from the index would throw here rather than lie.
 *
 * @param {string} repoRoot
 * @returns {Map<string, number>}
 */
export function collectSizes(repoRoot) {
	const sizes = new Map();
	for (const path of listTrackedCodeFiles(repoRoot)) {
		const content = readFileSync(join(repoRoot, path), 'utf8');
		sizes.set(path, lineCount(content));
	}
	return sizes;
}

/**
 * Parse `scripts/lib/file-size-debt.json`'s shape and check every value is a
 * non-negative integer naming a real debt (i.e. itself over the ceiling for
 * its own path) — the structural half of rule (d); `evaluate` below checks
 * the same number against the CURRENT tree.
 *
 * @param {Record<string, number>} debt
 * @returns {string[]} descriptions of any malformed entry
 */
export function malformedEntries(debt) {
	const bad = [];
	for (const [path, recorded] of Object.entries(debt)) {
		if (!Number.isInteger(recorded) || recorded < 0) {
			bad.push(
				`${path}: recorded size must be a non-negative integer, got ${JSON.stringify(recorded)}`
			);
		}
	}
	return bad;
}

/**
 * The four rules, evaluated once over a tree's actual sizes against a debt
 * list. Pure: no filesystem access, so the mutation tests below can hand it
 * a fixture `sizes` map without touching a real repo.
 *
 * @param {Map<string, number>} sizes path -> actual current line count, for
 *   every in-scope tracked file (a path absent from `sizes` is treated as
 *   deleted/moved/untracked, never as "no violation")
 * @param {Record<string, number>} debt path -> recorded line count
 * @returns {{
 *   unlisted: Array<{path: string, lines: number, ceiling: number}>,
 *   grown: Array<{path: string, lines: number, recorded: number, ceiling: number}>,
 *   stale: Array<{path: string, reason: 'shrunk'|'under-ceiling'|'deleted', lines: number|null, recorded: number, ceiling: number}>,
 *   listedAtOrUnderCeiling: Array<{path: string, recorded: number, ceiling: number}>,
 * }}
 */
export function evaluate(sizes, debt) {
	const unlisted = [];
	const grown = [];
	const stale = [];
	const listedAtOrUnderCeiling = [];

	for (const [path, lines] of sizes) {
		const ceiling = ceilingFor(path);
		const recorded = debt[path];
		if (lines <= ceiling) continue; // compliant, listed or not
		if (recorded === undefined) {
			unlisted.push({ path, lines, ceiling });
		} else if (lines > recorded) {
			grown.push({ path, lines, recorded, ceiling });
		}
		// lines <= recorded (and lines > ceiling): compliant debt, nothing to report here.
	}

	for (const [path, recorded] of Object.entries(debt)) {
		const ceiling = ceilingFor(path);
		if (recorded <= ceiling) {
			listedAtOrUnderCeiling.push({ path, recorded, ceiling });
			continue;
		}
		const lines = sizes.has(path) ? sizes.get(path) : null;
		if (lines === null) {
			stale.push({ path, reason: 'deleted', lines, recorded, ceiling });
		} else if (lines <= ceiling) {
			stale.push({ path, reason: 'under-ceiling', lines, recorded, ceiling });
		} else if (lines < recorded) {
			stale.push({ path, reason: 'shrunk', lines, recorded, ceiling });
		}
		// lines === recorded and lines > ceiling: exactly current, nothing to report.
		// lines > recorded: that is `grown`, reported above, not duplicated here.
	}

	return { unlisted, grown, stale, listedAtOrUnderCeiling };
}

/**
 * Regenerate a debt list from `sizes` against the `existingDebt` currently on
 * disk. Never raises an existing entry's recorded size, and never adds a
 * brand-new entry for a file that just crossed its ceiling, UNLESS that
 * path is named in `allowGrowth` (or `allowGrowth === 'all'`, used once to
 * seed the very first list from a tree that already has violations with no
 * prior entries to compare against). Every other change — ratcheting an
 * entry DOWN to a file's current size, or dropping an entry whose file
 * shrank to the ceiling or was deleted — always happens: those are the
 * directions this guard exists to allow.
 *
 * @param {Map<string, number>} sizes
 * @param {Record<string, number>} existingDebt
 * @param {Set<string>|'all'} allowGrowth
 * @returns {{ debt: Record<string, number>, warnings: string[] }}
 */
export function regenerate(sizes, existingDebt, allowGrowth = new Set()) {
	const allowAll = allowGrowth === 'all';
	const allowed = allowAll ? null : allowGrowth;
	const next = {};
	const warnings = [];

	for (const [path, lines] of sizes) {
		const ceiling = ceilingFor(path);
		const recorded = Object.prototype.hasOwnProperty.call(existingDebt, path)
			? existingDebt[path]
			: undefined;

		if (lines <= ceiling) continue; // healed or never violated: no entry

		if (recorded === undefined) {
			if (allowAll || allowed.has(path)) {
				next[path] = lines;
				warnings.push(`growth allowed: new debt entry ${path} = ${lines} (ceiling ${ceiling})`);
			}
			// else: deliberately omitted. The guard's "unlisted" rule names it.
			continue;
		}

		if (lines > recorded) {
			if (allowAll || allowed.has(path)) {
				next[path] = lines;
				warnings.push(`growth allowed: ${path} raised ${recorded} -> ${lines}`);
			} else {
				next[path] = recorded; // unchanged: the guard's "grown" rule names it.
			}
		} else {
			next[path] = lines; // ratchet down, including lines === recorded (no-op write)
		}
	}

	const sorted = Object.fromEntries(
		Object.keys(next)
			.sort()
			.map((k) => [k, next[k]])
	);
	return { debt: sorted, warnings };
}
