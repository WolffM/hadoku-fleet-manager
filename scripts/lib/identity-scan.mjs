/**
 * THE REPO SCAN for the identity-model gate (split of
 * scripts/lib/identity-rules.mjs, wave 5q lane C, pure move): which
 * extensions and directories the walk reads, the walk itself, the repo's
 * tracked-file list (git over the denylist, when git can answer), how stale
 * a checkout is against its remote, and the sibling-repo roster `scanRepo`
 * (identity-rules.mjs) iterates. Nothing here knows about G1..G8; it only
 * says which bytes the rules get to look at.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { allRepos } from './fleet-roster.mjs';
import { tryShipped } from './fleet-source.mjs';
import { EDGE_INDEX } from './identity-constants.mjs';

/**
 * THE SCAN IS A DENYLIST, not a list of roots — and that inversion is the fix
 * for a whole class of miss rather than for three repos.
 *
 * It used to name its roots: `workers, services, src, scripts, templates, e2e,
 * worker`. Four repos keep their code somewhere else — hadoku-watchparty and
 * hadoku-cardtable under `apps/server/src`, hadoku-contact-ui under `api/`,
 * hadoku-dataplatform under `server/` — so all four were walked as ZERO FILES
 * and reported clean while holding live credential-keyed ownership. Surveyed
 * 2026-09-24, the fleet's twenty app repos use at least nine different top-level
 * layouts (`backend`, `frontend`, `engine`, `crates`, `pygmalion`,
 * `hadoku_scrape`, `tunnel`, `builder`, `web`), so any inclusion list is a list
 * that rots — and it rots SILENTLY, which is the whole problem.
 *
 * Inverting it inverts the failure mode: a new layout is covered by default, and
 * the cost of getting the denylist wrong is noise, which is loud, rather than
 * blindness, which is not. Extension filtering does most of the work (only
 * code and schema extensions are ever read), so artifact directories full of
 * images or logs cost a readdir and nothing more.
 */
export const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
export const SQL_EXT = ['.sql'];

/**
 * Files searched for an EMBEDDED schema — a `CREATE TABLE` inside a string
 * literal rather than in a `.sql` file. G2 is the only check that runs on these.
 *
 * Two live schemas are written this way, and both were invisible: hadoku-
 * watchparty's `stats.sqlite` is a TypeScript template literal
 * (`apps/server/src/stats/db.ts`) and hadoku-dataplatform's catalog is a Python
 * string constant (`catalog/_migrations.py`). Between them they declared twelve
 * credential-keyed ownership columns that G2 — the check written BECAUSE of
 * `friend_key` — walked straight past.
 *
 * `.py` appears HERE and deliberately not in `CODE_EXT`: the other checks match
 * JS/TS shapes (`c.req.json()`, `const x =`, `.bind(`), so running them over
 * Python would report nothing useful and risk noise. Teaching G1/G3/G5/G8 a
 * Python dialect is separate work; a schema is a schema in any host language.
 */
export const SCHEMA_CODE_EXT = ['.ts', '.tsx', '.js', '.mjs', '.py'];

/** Every extension any check reads. Anything else is never opened. */
export const SCANNED_EXT = [...new Set([...CODE_EXT, ...SQL_EXT, ...SCHEMA_CODE_EXT])];

/** Cheap pre-test so only files that declare tables are parsed as schema. */
export const DECLARES_TABLE = /\bCREATE\s+TABLE\b/i;

const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'build',
	'.astro',
	'.wrangler',
	'coverage',
	'.claude',
	'.git',
	'playwright-report',
	'test-results',
	// Added with the denylist walk. A Python virtualenv is the one that matters:
	// `.venv/lib/python3.x/site-packages` holds tens of thousands of .py files,
	// none of them ours, and several of them would match a rule.
	'.venv',
	'venv',
	'site-packages',
	'__pycache__',
	'.pytest_cache',
	'.mypy_cache',
	'.ruff_cache',
	'target',
	'vendor',
	'.next',
	'.svelte-kit',
	'htmlcov',
	'.turbo',
	'.cache',
]);

/** Generated Python metadata dirs — matched by suffix, not by exact name. */
const SKIP_DIR_SUFFIXES = ['.egg-info'];

/**
 * How far behind its remote is this checkout?
 *
 * THE TWIN OF `missingCheckouts`. That one answers "could I look?"; this answers
 * "did I look at TODAY'S code?". Both failures produce a confident verdict about
 * something other than the fleet's current state, and the second is the worse of
 * the two because it looks like a normal run.
 *
 * It bit on 2026-09-24: an ad-hoc fleet audit at 18:00 read `~/repos/hadoku_site`
 * as it stood after the 13:00 `repos:main-sync`, 30 commits back, and reported 16
 * violations — one of them in a file whose fix was already on origin/main. Stale
 * code lies in BOTH directions: a fix you cannot see, and a finding that is not
 * there any more.
 *
 * The nightly path is already correct — `repos:main-sync` runs first in the same
 * profile, precisely so the audits read fresh checkouts — so this is about the
 * ad-hoc run, which has no such guarantee and no way to notice.
 *
 * `ls-remote` is the authoritative comparison and the reason this does not read
 * the local `origin/main` ref: that ref is only as fresh as the last fetch, so a
 * repo nobody has fetched for a week reports "current" against a week-old idea of
 * the remote. Network failure returns `unknown`, which never fails a run — an
 * offline audit is degraded, not wrong, and saying so is the honest outcome.
 */
export function checkoutFreshness(dir) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
	const git = (args) =>
		execFileSync('git', ['-C', dir, ...args], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			env,
			cwd: dir,
			timeout: 20_000,
		}).trim();
	let head;
	try {
		head = git(['rev-parse', 'HEAD']);
	} catch {
		return { state: 'unknown', reason: 'HEAD unreadable' };
	}
	let remote;
	try {
		// The default branch by name, not `HEAD`: `ls-remote origin HEAD` answers
		// with the remote's own default, which a repo on a differently-named branch
		// would silently be measured against.
		const out = git(['ls-remote', 'origin', 'main', 'master']);
		remote = out.split('\n').filter(Boolean)[0]?.split('\t')[0];
	} catch {
		return { state: 'unknown', reason: 'ls-remote failed (offline?)' };
	}
	if (!remote) return { state: 'unknown', reason: 'no main/master on origin' };
	if (remote === head) return { state: 'current' };
	let behind;
	try {
		behind = Number(git(['rev-list', '--count', `HEAD..${remote}`]));
	} catch {
		// The remote commit is not in this object store, so it has never been
		// fetched — which is itself proof the checkout is behind.
		return { state: 'behind', behind: null, reason: 'remote commit not fetched' };
	}
	// Ahead-only (local commits not yet pushed) is NORMAL mid-work and is not
	// staleness: the files on disk are newer than the remote, not older.
	if (!behind) return { state: 'current' };
	return { state: 'behind', behind };
}

/**
 * The repo's own tracked-file list, or null when it cannot be read.
 *
 * GIT IS THE DENYLIST THAT MAINTAINS ITSELF. Walking whole repos immediately
 * found hadoku_site's `public/mf/**` bundles — contact-ui's worker and
 * watchparty's UI, COMPILED INTO THIS REPO — and reported five findings against
 * generated code that only exists because the source repos have the same bug.
 * Fixing the source would not clear them; rebuilding would move their line
 * numbers. A hand-kept list would have to learn every bundler output path in
 * the fleet, and would rot the same way the root list did.
 *
 * `.gitignore` already states exactly this, in every repo, maintained by the
 * people who added the build step. A file git does not track is not source.
 *
 * Unreadable (not a checkout, git missing) returns null and the walk falls back
 * to the SKIP_DIRS denylist — degraded but never blind, because an audit that
 * silently inspects nothing is the failure this whole change is about.
 */
export function trackedFiles(root) {
	try {
		// EVERY GIT_* VARIABLE MUST BE CLEARED, and `-C` is not enough: `-C` sets the
		// working directory, `GIT_DIR` names the repository, and GIT_DIR wins. Git
		// hooks export it — hadoku_site's own pre-commit runs this gate — so an
		// inherited GIT_DIR would make this ask HADOKU_SITE's index which of a
		// SIBLING repo's files are tracked. The answer is "none of them", every file
		// would be skipped, and each sibling would be scanned as zero files: the
		// precise blindness this whole change removed, reintroduced one layer down
		// and quieter, since a clean run is indistinguishable from a real one.
		// Caught by the suite failing 13 cases under a simulated hook env.
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
		const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'ignore'],
			env,
			cwd: root,
		});
		const set = new Set(out.split('\0').filter(Boolean));
		return set.size ? set : null;
	} catch {
		return null;
	}
}

/**
 * Every file under `dir`, recursively, past the SKIP_DIRS/SKIP_DIR_SUFFIXES
 * denylist — the fallback walk `scanRepo` (identity-rules.mjs) uses when
 * `trackedFiles` could not read git's own list.
 */
export function* walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch (err) {
		if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
		throw err;
	}
	for (const name of entries) {
		if (SKIP_DIRS.has(name)) continue;
		if (SKIP_DIR_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
		const full = resolve(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) yield* walk(full);
		else yield full;
	}
}

/**
 * The sibling repos to scan, and the roster entries that could NOT be read.
 *
 * DERIVED from `fleet-runner-coverage.json` via lib/fleet-roster.mjs, never from
 * a directory listing. The filter used to be `name.startsWith('hadoku')`,
 * which is a naming convention doing the job of a membership list — and the
 * convention is not universal: `brave-quartet` and `ArchiveBot` are both in the
 * roster and neither would ever have been scanned. Nothing would have reported
 * that, because a repo the sweep never looks at produces no findings and no
 * findings reads as clean. Same defect class as check-header-fleet's
 * `not-in-fleet` rule, which exists for exactly this.
 *
 * EACH SIBLING IS ITS SHIPPED TREE, through lib/fleet-source.mjs: the default
 * branch, fetched by the reader itself and written out as a clean tree, never a
 * clone under REPOS_DIR (fleet-manager#7). A sibling checkout was whatever its
 * last pull left — 30 commits behind on 2026-09-24, reporting a violation whose
 * fix was already shipped. The tracked set comes from the shipped tree's own
 * listing, so git, not the denylist, still says what is source.
 *
 * UNREADABLE REPOS ARE RETURNED, NOT SKIPPED. A roster repo the reader could not
 * read is a repo this run did not audit, and "I could not look" must never
 * render as "nothing is wrong" — the `no-checkout` trap named in
 * scripts/CLAUDE.md. The caller decides what to do with them; the JSON report
 * carries them and the cron fails on them.
 */
export function siblingRepos() {
	const trees = [];
	const missing = [];
	/** slug -> why it could not be read. */
	const why = new Map();
	for (const slug of allRepos()) {
		const source = tryShipped(slug);
		if ('unreadable' in source) {
			missing.push(slug);
			why.set(slug, source.unreadable);
			continue;
		}
		try {
			const root = source.materialize({
				include: (p) => SCANNED_EXT.some((e) => p.endsWith(e)) || p === EDGE_INDEX,
			});
			trees.push({ root, label: slug.split('/')[1], tracked: new Set(source.list()) });
		} catch (err) {
			missing.push(slug);
			why.set(slug, err.reason ?? String(err));
		}
	}
	return { trees, missing, why };
}
