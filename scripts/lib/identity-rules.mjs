/**
 * The identity-model gate's ORCHESTRATION (scripts/check-identity-model.mjs,
 * split #8 — pure move; re-split wave 5q lane C to reach the 800-line
 * ceiling). `scanRepo` ties the one walk to every check: G1, G3, G4, G5 and
 * G8 (identity-checks.mjs) and G9 (identity-r12.mjs, R12) run per file; G6
 * (identity-checks.mjs) and G7
 * (identity-resolver.mjs) reason about the whole repo and run once at the
 * end, because they need the input every per-file pass collected along the
 * way. `trackedFiles`/`walk` (identity-scan.mjs) choose what gets read;
 * `SELF`/`isSelfFixture`/`IDENTITY_BOUNDARY` (identity-constants.mjs) choose
 * what does not. Kept together here, rather than splitting the walk into
 * its own module, so `scanRepo` does not have to import back from whatever
 * held it — the exact circular edge the original split (#8) avoided by
 * keeping repo-shape and rule-shape in one file; this lane only breaks that
 * one file further apart, not the shape of the dependency.
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, sep, basename } from 'node:path';

import { blankComments } from './blank-comments.mjs';
import { siteRoot } from '../../dist/lib/fleet-paths.js';
import {
	IDENTITY_BOUNDARY,
	IDENTITY_CHECKS,
	IDENTITY_WAIVER_GATE,
	SELF,
	isSelfFixture,
} from './identity-constants.mjs';
import { createWaiverLedger } from './gate-waivers.mjs';
import {
	CODE_EXT,
	SQL_EXT,
	SCHEMA_CODE_EXT,
	SCANNED_EXT,
	DECLARES_TABLE,
	trackedFiles,
	walk,
} from './identity-scan.mjs';
import {
	checkG1,
	checkG2Dir,
	checkG3,
	checkG4,
	checkG5,
	checkG6,
	checkG8,
	collectUserIdReader,
} from './identity-checks.mjs';
import { checkG7, collectResolver } from './identity-resolver.mjs';
import { checkG9Schemas, checkG9Files, checkG9Derived, erasableFrom } from './identity-r12.mjs';
import { readChildApps } from './site-docs.mjs';
import { isTestFile } from './identity-source-parse.mjs';

export const REPO_ROOT = siteRoot();

/**
 * The apps account deletion reaches (R12 as amended), read once from the site's
 * child-apps.json. An unreadable file THROWS: a scan that could not read the
 * declarations would report every per-person table for the wrong reason.
 */
let erasableMemo;
function erasable() {
	if (!erasableMemo) {
		const doc = readChildApps({ root: REPO_ROOT });
		if (!doc.ok) throw new Error(`G9 cannot tell which apps are erasable: ${doc.why}`);
		erasableMemo = erasableFrom(doc.doc);
	}
	return erasableMemo;
}

/**
 * Scan one repo root. `label` prefixes findings from a sibling checkout.
 *
 * A finding is offered first to the repo's own INLINE waivers
 * (lib/gate-waivers.mjs, fleet-manager#82), then to the central allowlist.
 * Allowlisted findings go into `hits` (entry -> the violations it absorbed),
 * shared across every repo so the count and stale checks see the whole run.
 * A waiver's own problems (no reason, unused, on a `nonWaivable` check) land in
 * `violations` as check `waiver`, in THIS repo, at the marker's line. A
 * central entry whose finding a waiver absorbed goes into `superseded`.
 *
 * @returns {{ waived: number }} findings an inline waiver absorbed
 */
export function scanRepo(
	root,
	label,
	allow,
	violations,
	hits,
	tracked = trackedFiles(root),
	{ nonWaivable = [], superseded = new Set() } = {}
) {
	const waivers = createWaiverLedger({
		gate: IDENTITY_WAIVER_GATE,
		rules: IDENTITY_CHECKS,
		nonWaivable,
	});
	const sqlByDir = new Map();
	/** worker -> first `workers/<w>/src` file reading X-User-Id. G6's input. */
	const userIdReaders = new Map();
	/** worker -> where it resolves an identity, and by which of the two ways. G7's input. */
	const resolvers = new Map();
	const add = (check, file, line, message) => {
		const rel = label ? `${label}:${file}` : file;
		const violation = { check, file: rel, line, message };
		if (waivers.absorbs(file, check, line)) {
			// A central entry for a finding the repo now waives itself is
			// SUPERSEDED, not stale: the child's waiver lands before the site
			// deletes the row, and that gap must not turn the gate red.
			const central = allow.get(`${check}::${rel}`);
			if (central) superseded.add(central);
			return;
		}
		// The LABELLED path only. An unprefixed lookup also ran for siblings, so a
		// site entry for `src/x.ts` exempted `src/x.ts` in every sibling repo too —
		// and counted as a hit there, so the stale check could not see the site
		// entry had stopped matching (#98).
		const entry = allow.get(`${check}::${rel}`);
		if (entry) {
			hits.set(entry, [...(hits.get(entry) ?? []), violation]);
			return;
		}
		violations.push(violation);
	};

	{
		// GIT'S LIST WHEN THERE IS ONE, the denylist walk only when there is not.
		// Walking the directory and then filtering by the tracked set applied
		// SKIP_DIRS first, so a TRACKED `build/`, `vendor/` or `target/` — source
		// someone chose to commit under a name the denylist guesses is generated —
		// was never read (#98). The tracked set already says what is source.
		const files = tracked
			? [...tracked]
					.filter((rel) => SCANNED_EXT.some((e) => rel.endsWith(e)))
					.sort()
					.map((rel) => resolve(root, rel))
					.filter((full) => {
						try {
							return statSync(full).isFile();
						} catch {
							return false; // tracked but deleted in the working tree
						}
					})
			: walk(root);
		for (const full of files) {
			const rel = relative(root, full).split(sep).join('/');
			if (basename(rel) === SELF || isSelfFixture(basename(rel))) continue;
			waivers.addFile(rel, readFileSync(full, 'utf8'));
			// `e2e/` is a test tree too: cardtable's `e2e/edge.ts` and bomberman's
			// `e2e/edge-stub.mjs` stand in for edge-router under playwright, so
			// stamping identity headers is their whole job (G5 fired on both,
			// 2026-10-11). A directory, not a `*.stub.*` name: a stub under `src/`
			// can ship.
			const isTest = isTestFile(basename(full)) || /(^|\/)(tests?|e2e)\//.test(rel);
			if (SQL_EXT.some((e) => full.endsWith(e))) {
				// Collected, not judged: G2 replays a whole migrations directory
				// in order, because a rename in a later file is the only way to
				// retire a column an earlier one created.
				const dir = rel.slice(0, rel.lastIndexOf('/'));
				sqlByDir.set(dir, [...(sqlByDir.get(dir) ?? []), { rel, sql: readFileSync(full, 'utf8') }]);
				continue;
			}
			// An EMBEDDED schema is judged on its own, before the code checks, and
			// as its OWN group rather than joining a directory replay: the rename/
			// drop bookkeeping G2 does across a migrations dir is meaningful within
			// one such file and meaningless across unrelated code files.
			//
			// Read RAW, not through blankComments: the SQL lives inside a string
			// literal, and `--` inside it is a SQL comment that checkG2Dir strips
			// itself. A test file is skipped — a harness declaring a fixture table
			// is not a production schema.
			if (!isTest && SCHEMA_CODE_EXT.some((e) => full.endsWith(e))) {
				const raw = readFileSync(full, 'utf8');
				if (DECLARES_TABLE.test(raw)) {
					checkG2Dir([{ rel, sql: raw }], add);
					checkG9Schemas([{ rel, sql: raw }], label, add, erasable());
				}
			}
			if (!CODE_EXT.some((e) => full.endsWith(e))) continue;
			const src = blankComments(readFileSync(full, 'utf8'));
			collectUserIdReader(rel, src, userIdReaders);
			collectResolver(rel, full, src, label, resolvers, add);
			checkG1(rel, src, add);
			checkG3(rel, src, add);
			checkG4(rel, src, add);
			// G8, like G5, exempts tests: a harness holds raw keys on purpose. It
			// carries its own custodian list rather than reusing IDENTITY_BOUNDARY,
			// because storing a credential is edge-router's registry's job but not
			// every edge-router file's job.
			if (!isTest) checkG8(rel, src, add);
			// G9 (R12), like G8, exempts tests: a fixture writing a record with a
			// name, or hashing a fake key, is not a store.
			if (!isTest) {
				checkG9Files(rel, src, label, add, erasable());
				checkG9Derived(rel, src, label, add);
			}
			// G5 is about code OUTSIDE the boundary impersonating a user. A test
			// harness stamping the header is how a worker gets exercised at all,
			// and inside edge-router stamping it is the point. The boundary is a
			// path in HADOKU_SITE: a sibling repo that happens to have a
			// `workers/edge-router/src/` directory is not the edge, and was exempt.
			const atBoundary = label === null && rel.startsWith(IDENTITY_BOUNDARY);
			if (!isTest && !atBoundary) checkG5(rel, src, add);
		}
	}
	// G6 reasons about the WHOLE repo (a worker plus edge-router's config), so it
	// runs once per repo rather than per file.
	checkG6(root, userIdReaders, add);
	// G7 crosses repos: a sibling's resolver is deployed by a wrangler.toml in
	// hadoku_site, so it is always measured against the SITE root, never the
	// root currently being scanned.
	checkG7(resolvers, label, REPO_ROOT, add);
	for (const [, files] of sqlByDir) {
		files.sort((a, b) => a.rel.localeCompare(b.rel));
		checkG2Dir(files, add);
		checkG9Schemas(files, label, add, erasable());
	}
	for (const p of waivers.problems()) {
		violations.push({
			check: 'waiver',
			file: label ? `${label}:${p.file}` : p.file,
			line: p.line,
			message: p.message,
		});
	}
	return { waived: waivers.absorbed };
}
