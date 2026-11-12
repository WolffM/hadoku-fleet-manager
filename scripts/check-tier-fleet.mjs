#!/usr/bin/env node
/**
 * Fleet-wide tier-drift audit — the child-repo half of the tier model.
 *
 * WHY THIS EXISTS
 * ---------------
 * `check-tier-gating.mjs` runs in hadoku_site's CI and pre-commit hook. It
 * reaches nothing else. Every child repo — 12 of them, holding most of the
 * ecosystem's actual auth gates — can drift with nothing to stop it, and the
 * 2026-08-04 `wife` rollout is what proved that: eight backends had silently
 * fallen behind the tier vocabulary, and two carried exact-match allowlists
 * that were already wrong before any new tier existed.
 *
 * This is the same shape as `check-key-sync.mjs`: a hadoku_site script that
 * audits sibling checkouts, because hadoku_site is the only place that knows
 * what the whole ecosystem is supposed to agree on.
 *
 * WHAT IT READS
 * -------------
 * Each repo's default branch through `lib/fleet-source.mjs` — what is SHIPPED,
 * not what happens to be on disk, and fetched by the reader itself rather than
 * read off a sibling clone somebody else fetched (fleet-manager#7). Scanning
 * working copies makes the result meaningless: a local checkout may be behind
 * (so it reports drift that is already fixed) or dirty (so it reports drift
 * nobody pushed). Use `--worktree` to scan the working copies under REPOS_DIR
 * instead, which is what you want while fixing things.
 *
 * WHAT IT CANNOT DO
 * -----------------
 * It is an AUDIT, not a gate. It cannot block a child repo's CI — only that
 * repo can. It reports; a human or a cron acts.
 *
 * Two rules, covering each other's blind spot (see lib/tier-detectors.mjs):
 *   - incomplete tier vocabulary (3+ tiers, one missing) — fails CLOSED and
 *     silently, so nothing surfaces it at runtime
 *   - equality against a NON-TOP tier — excludes every tier above the one
 *     named; this is the two-tier allowlist shape the vocabulary rule misses
 *
 * USAGE
 *   fleet tier-fleet             # audit each default branch, exit 1 on drift
 *   fleet tier-fleet --worktree  # audit the working copies under REPOS_DIR
 *   fleet tier-fleet --warn      # report, always exit 0
 *   fleet tier-fleet --no-fetch  # read the reader's mirror as it stands (offline)
 *   fleet tier-fleet --json      # a GateDoc instead of prose
 *   fleet tier-fleet --print-waivers  # each central entry as the inline waiver to add
 *   REPOS_DIR=/path fleet tier-fleet --worktree
 *
 * MIGRATED (wave 5h lane B): `ci:audit-gates` now runs this one with `--json`
 * (default args, never `--worktree`, so every read stays `hostBound: false`
 * — see `src/lib/job-registry.ts`'s `coversSubs` entry) and judges it by the
 * `GateDoc` below rather than a regex over stdout+stderr. A repo this file
 * could not fetch or could not find a checkout for (`missing checkout`,
 * `unreadable`) is "I could not look" — `unreadable`, never a finding; every
 * other kind here IS a finding, drift the gate actually observed.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import {
	blankComments,
	findStaleVocabularies,
	findNonTopTierEquality,
} from './lib/tier-detectors.mjs';
import { allRepos } from './lib/fleet-roster.mjs';
import { reposDir, manifest as manifestFile } from '../dist/lib/fleet-paths.js';
import { fleetOwner } from '../dist/lib/fleet-config.js';
import { tryShipped } from './lib/fleet-source.mjs';
import { createEmitter } from './lib/emit.mjs';
import { buildGateDoc } from './lib/gate-doc.mjs';
import { createWaiverLedger, waiverText } from './lib/gate-waivers.mjs';

const out = createEmitter();

const ALLOWLIST_JSON = manifestFile('tier-fleet-allowlist.json');

/**
 * INLINE WAIVERS come first (fleet-manager#82, lib/gate-waivers.mjs): a repo
 * exempts its own code with `tier-fleet-disable-next-line <rule>: <why>` on the
 * line above it. The rule is the finding's kind, by its short name below. A
 * waiver with no reason, one that covers no finding, and one on a rule the
 * central list's `nonWaivable` names are findings in that repo.
 */
const WAIVER_GATE = 'tier-fleet';
const RULE_OF_KIND = {
	'incomplete tier vocabulary': 'vocabulary',
	'equality against a non-top tier': 'non-top-equality',
};

/**
 * Central exemptions, keyed `repo:path`. Every entry needs a `why`, and an entry that
 * stops matching FAILS — an exemption must not outlive its reason. Mirrors
 * `tier-gating-allowlist.json`.
 *
 * AN ENTRY EXEMPTS FINDINGS, NOT A FILE. Without a scope, a `repo:path` entry
 * blinded the whole file forever: the one reviewed inverse list it was written
 * for, and every tier bug anyone added to that file afterwards. Two optional
 * fields narrow it, and an entry with neither keeps the old whole-file meaning:
 *
 *   `lines`  the reviewed findings' line numbers. Any finding on another line
 *            is live; a listed line with no finding left is stale.
 *   `count`  the number of reviewed findings in the file. A file with MORE is
 *            all live (something new arrived and cannot be told apart from
 *            the reviewed ones without `lines`); FEWER is stale.
 *
 * An entry that shields NOTHING is stale too — a file that still exists but no
 * longer trips any rule used to keep its exemption indefinitely.
 */
function loadAllowlist() {
	let obj;
	try {
		obj = JSON.parse(readFileSync(ALLOWLIST_JSON, 'utf8'));
	} catch (err) {
		if (err.code === 'ENOENT') return { map: new Map(), nonWaivable: [] };
		throw err;
	}
	const rules = Object.values(RULE_OF_KIND);
	const nonWaivable = obj.nonWaivable ?? [];
	if (!Array.isArray(nonWaivable) || nonWaivable.some((r) => !rules.includes(r))) {
		console.error(
			`✗ allowlist "nonWaivable" must list rules (${rules.join(' ')}): ${JSON.stringify(nonWaivable)}`
		);
		process.exit(1);
	}
	const map = new Map();
	for (const entry of obj.allowed || []) {
		const badLines =
			entry.lines !== undefined &&
			!(Array.isArray(entry.lines) && entry.lines.every((n) => Number.isInteger(n) && n > 0));
		const badCount =
			entry.count !== undefined && !(Number.isInteger(entry.count) && entry.count > 0);
		if (!entry.file || !entry.why || badLines || badCount) {
			console.error(
				`✗ allowlist entry needs "file" and "why"; "lines" (positive integers) and "count" ` +
					`(a positive integer) are optional: ${JSON.stringify(entry)}`
			);
			process.exit(1);
		}
		map.set(entry.file, entry);
	}
	return { map, nonWaivable };
}
const { map: allowlist, nonWaivable } = loadAllowlist();
const usedAllowlist = new Set();
/** central key -> the findings its entry shielded, for --print-waivers. */
const shieldedBy = new Map();
/**
 * Central keys whose file the repo now waives inline. SUPERSEDED, never stale:
 * the child's waiver lands before the site deletes the row, and that gap
 * must not turn the gate red. Reported, so the row does not wait forever.
 */
const supersededKeys = new Set();
const waivers = createWaiverLedger({
	gate: WAIVER_GATE,
	rules: Object.values(RULE_OF_KIND),
	nonWaivable,
});

/**
 * Every covered child repo. Tier vocabulary can appear anywhere auth is
 * enforced, so this audit deliberately takes the WHOLE roster rather than a
 * subset — the detectors are pattern-based, so a repo with no JS/TS auth code
 * simply yields nothing.
 *
 * DERIVED from the one roster, never hand-listed: the array this replaces held
 * 15 repos and disagreed with the header checker's 14 on seven names in both
 * directions. See scripts/lib/fleet-roster.mjs.
 */
const FLEET = allRepos().map((r) => r.split('/')[1]);

/**
 * Every source shape an auth gate can be written in. `.cjs`, `.cts`, `.mts`,
 * `.vue` and `.svelte` were missing, so a gate in a CommonJS worker shim or a
 * component's `<script>` block was never read, and the "Scanned N files"
 * line counted only what it could see.
 */
const EXTENSIONS = [
	'.ts',
	'.tsx',
	'.mts',
	'.cts',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.vue',
	'.svelte',
	'.py',
];
const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'build',
	'.astro',
	'.wrangler',
	'coverage',
	'.claude',
	'.venv',
	'venv',
	'site-packages',
	'.git',
	'test-history',
	'__pycache__',
]);

/**
 * Tests are scanned for VOCABULARIES but not for equality comparisons: a test
 * asserting `userType === 'service'` behaves correctly is the point of the
 * test, not drift. A test's tier LIST going stale is still real — that is how a
 * tier ends up untested rather than exempt.
 */
function isTest(rel) {
	return (
		/(^|\/)(tests?|__tests__|e2e)\//.test(rel) ||
		/\.(test|spec)\.[a-z]+$/.test(rel) ||
		/(^|\/)(conftest|test_)[^/]*$/.test(rel)
	);
}

function* walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (SKIP_DIRS.has(name)) continue;
		const full = resolve(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) yield* walk(full);
		else if (EXTENSIONS.some((e) => name.endsWith(e))) yield full;
	}
}

const warnOnly = process.argv.includes('--warn');
const printWaivers = process.argv.includes('--print-waivers');
const useWorktree = process.argv.includes('--worktree');
const noFetch = process.argv.includes('--no-fetch');
const ROOT = reposDir();
const findings = [];
let scannedRepos = 0;
let scannedFiles = 0;

function scanText(repo, rel, raw) {
	// Python docstrings are bare prose, so the line-prefix test cannot see them —
	// and a tier module's docstring is exactly where a description of a FIXED tier
	// bug lives. See blankComments.
	const text = blankComments(raw, { python: rel.endsWith('.py') });
	const found = [];
	for (const v of findStaleVocabularies(text)) {
		found.push({
			repo,
			kind: 'incomplete tier vocabulary',
			file: rel,
			line: v.line,
			detail: `names ${v.found.join(', ')} but not ${v.missing.join(', ')}`,
		});
	}
	if (!isTest(rel)) {
		for (const e of findNonTopTierEquality(text)) {
			found.push({
				repo,
				kind: 'equality against a non-top tier',
				file: rel,
				line: e.line,
				detail: e.text.slice(0, 100),
			});
		}
	}
	const key = `${repo}:${rel}`;
	waivers.addFile(key, raw);
	const live = found.filter((f) => !waivers.absorbs(key, RULE_OF_KIND[f.kind], f.line));
	if (live.length < found.length && allowlist.has(key)) supersededKeys.add(key);
	findings.push(...applyExemption(key, live));
}

/** The findings an allowlist entry for `key` does NOT cover, plus any staleness
 *  in the entry itself. See `loadAllowlist` for the `lines` / `count` rules. */
function applyExemption(key, found) {
	const entry = allowlist.get(key);
	if (!entry || found.length === 0) return found;
	usedAllowlist.add(key);
	const [repo, ...rest] = key.split(':');
	const file = rest.join(':');
	const stale = (detail) => ({ repo, kind: 'stale allowlist entry', file, line: 0, detail });
	const out = [];
	// Superseded (see supersededKeys): its lines and count stop describing the
	// file once part of it is waived inline, so neither is judged stale.
	const lenient = supersededKeys.has(key);
	let shielded = found;
	if (entry.lines) {
		out.push(...found.filter((f) => !entry.lines.includes(f.line)));
		shielded = found.filter((f) => entry.lines.includes(f.line));
		const gone = entry.lines.filter((n) => !found.some((f) => f.line === n));
		if (gone.length && !lenient) {
			out.push(stale(`lines ${gone.join(', ')} no longer hold a finding — update "lines"`));
		}
	}
	shieldedBy.set(key, shielded);
	if (entry.count !== undefined && shielded.length !== entry.count) {
		if (shielded.length > entry.count) {
			return [
				...out,
				...shielded.map((f) => ({
					...f,
					detail: `${f.detail} (allowlist reviewed ${entry.count} here, now ${shielded.length})`,
				})),
			];
		}
		if (!lenient) {
			out.push(
				stale(`reviewed ${entry.count} finding(s), ${shielded.length} remain — lower "count"`)
			);
		}
	}
	return out;
}

/**
 * A covered repo that yielded no scannable file at all. The roster is the
 * WHOLE fleet on purpose (see `FLEET`), so this is either a repo with genuinely
 * no JS/TS/Python — which deserves one reviewed `repo:*` allowlist entry saying
 * so — or a listing that came back empty for a reason nobody looked at. The two
 * are indistinguishable from here, which is exactly why it cannot pass silently.
 */
function noteEmptyRepo(repo, n) {
	if (n > 0) return;
	findings.push(
		...applyExemption(`${repo}:*`, [
			{
				repo,
				kind: 'nothing scanned',
				file: '-',
				line: 0,
				detail:
					`yielded ZERO files with a scanned extension (${EXTENSIONS.join(' ')}). If it truly ` +
					`has none, allowlist "${repo}:*" with a why`,
			},
		])
	);
}

for (const repo of FLEET) {
	if (useWorktree) {
		const root = resolve(ROOT, repo);
		if (!existsSync(root)) {
			findings.push({
				repo,
				kind: 'missing checkout',
				file: '-',
				line: 0,
				detail: `not found under ${ROOT}`,
			});
			continue;
		}
		scannedRepos++;
		const filesBefore = scannedFiles;
		for (const file of walk(root)) {
			const rel = relative(root, file).split(sep).join('/');
			scannedFiles++;
			try {
				scanText(repo, rel, readFileSync(file, 'utf8'));
			} catch {
				/* unreadable file — skip */
			}
		}
		noteEmptyRepo(repo, scannedFiles - filesBefore);
		continue;
	}

	// THE SHIPPED TREE, fetched by the reader itself. An unreadable repo — no
	// such repo, a failed fetch, a failed blob read — is ONE finding carrying the
	// reader's reason; there is no stale "last known" ref to fall back to.
	const source = tryShipped(`${fleetOwner()}/${repo}`, { fetch: !noFetch });
	if ('unreadable' in source) {
		findings.push({ repo, kind: 'unreadable', file: '-', line: 0, detail: source.unreadable });
		continue;
	}
	scannedRepos++;
	const filesBefore = scannedFiles;
	const files = source
		.list()
		.filter((f) => EXTENSIONS.some((e) => f.endsWith(e)))
		.filter((rel) => !rel.split('/').some((seg) => SKIP_DIRS.has(seg)));
	let texts;
	try {
		texts = source.readMany(files);
	} catch (err) {
		findings.push({
			repo,
			kind: 'unreadable',
			file: '-',
			line: 0,
			detail: err.reason ?? String(err),
		});
		continue;
	}
	for (const rel of files) {
		scannedFiles++;
		scanText(repo, rel, texts.get(rel));
	}
	noteEmptyRepo(repo, scannedFiles - filesBefore);
}

// A scan that silently finds nothing is indistinguishable from a clean one —
// the failure mode check-key-sync learned to report loudly.
out.log(
	`Scanned ${scannedFiles} ${useWorktree ? 'working-copy' : 'origin/main'} files ` +
		`across ${scannedRepos}/${FLEET.length} repos ${useWorktree ? `under ${ROOT}` : 'at their default branch'}`
);

// ...and PRINTING the count was as far as that lesson got. A roster that
// resolved to no repos, or repos that yielded no files, printed "Scanned 0
// files across 0/0 repos" and then "✓ fleet tier model clean" with exit 0.
// The floor is now enforced, not narrated.
if (FLEET.length === 0 || scannedFiles === 0) {
	findings.push({
		repo: '(fleet)',
		kind: 'nothing scanned',
		file: '-',
		line: 0,
		detail:
			FLEET.length === 0
				? 'the roster named ZERO repos — refusing to call that clean'
				: `${scannedRepos} repo(s) yielded ZERO scannable files — refusing to call that clean`,
	});
}

// A waiver's own problems, in the repo it lives in, at the marker's line.
for (const p of waivers.problems()) {
	const [repo, ...rest] = p.file.split(':');
	findings.push({ repo, kind: 'waiver', file: rest.join(':'), line: p.line, detail: p.message });
}

// A stale entry shields nothing and hides that the code was cleaned up.
for (const f of allowlist.keys()) {
	if (supersededKeys.has(f)) {
		out.log(`⚠ ${f}: waived inline in its repo now; delete the central allowlist row`);
	} else if (!usedAllowlist.has(f)) {
		findings.push({
			repo: f.split(':')[0],
			kind: 'stale allowlist entry',
			file: f.split(':').slice(1).join(':'),
			line: 0,
			detail: 'shields no finding in any scanned file — remove it from tier-fleet-allowlist.json',
		});
	}
}

// GateDoc (wave 5h lane B). `missing checkout` (--worktree) and `unreadable`
// (shipped mode's own fetch failures) are "I could not look" — every other
// kind here is drift the gate actually observed. `ok` is left to its
// default: the two arrays below are a straight partition of `findings`, the
// same array `warnOnly`'s own exit-code branch below keys on.
const UNREADABLE_KINDS = new Set(['missing checkout', 'unreadable']);
const gateUnreadable = findings
	.filter((f) => UNREADABLE_KINDS.has(f.kind))
	.map((f) => ({ node: null, why: `${f.repo}: ${f.detail}`, repo: f.repo }));
const gateFindings = findings
	.filter((f) => !UNREADABLE_KINDS.has(f.kind))
	.map((f) => ({
		node: null,
		kind: f.kind,
		reason:
			f.file !== '-' ? `${f.repo} ${f.file}:${f.line} — ${f.detail}` : `${f.repo}: ${f.detail}`,
		repo: f.repo,
		...(f.file !== '-' ? { file: f.file, line: f.line } : {}),
	}));

// THE MIGRATION (fleet-manager#82): each central entry as the inline waivers
// that replace it, aimed at the lines its findings sit on today. Bottom-up per
// file, because each insert shifts the lines below it.
if (printWaivers) {
	const moved = [];
	const keep = [];
	for (const [key, entry] of allowlist) {
		const [repo, ...rest] = key.split(':');
		const file = rest.join(':');
		const shielded = shieldedBy.get(key);
		if (file === '*' || !shielded) {
			const reason =
				file === '*'
					? 'a whole-repo entry: stays central'
					: supersededKeys.has(key)
						? 'already waived in its repo: delete it'
						: 'matches nothing: delete it';
			keep.push({ file: key, reason });
			continue;
		}
		const byLine = new Map(shielded.map((f) => [`${f.line}:${RULE_OF_KIND[f.kind]}`, f]));
		const sorted = [...byLine.values()].sort((a, b) => b.line - a.line);
		const lockedHere = sorted.filter((f) => nonWaivable.includes(RULE_OF_KIND[f.kind]));
		if (lockedHere.length) {
			keep.push({ file: key, reason: 'a non-waivable rule: stays central' });
			continue;
		}
		const top = sorted.at(-1);
		for (const f of sorted) {
			const why = f === top ? entry.why : 'same reason as the waiver above';
			const rule = RULE_OF_KIND[f.kind];
			moved.push({
				repo,
				file,
				line: f.line,
				rule,
				insert: waiverText(WAIVER_GATE, rule, why, file),
			});
		}
	}
	const unreadable = findings.filter((f) => UNREADABLE_KINDS.has(f.kind)).map((f) => f.repo);
	const complete = unreadable.length === 0 && scannedFiles > 0;
	if (out.json) out.emit({ complete, waivers: moved, keep, unreadable });
	else {
		for (const w of moved) {
			out.log(`${w.repo}:${w.file}  above line ${w.line}`);
			for (const l of w.insert) out.log(`    ${l}`);
		}
		for (const k of keep) out.log(`(not moved) ${k.file} — ${k.reason}`);
		if (!complete) out.log(`✗ incomplete scan: ${unreadable.join(', ') || 'nothing scanned'}`);
	}
	process.exit(complete ? 0 : 1);
}

if (out.json) {
	out.emit({
		scannedFiles,
		scannedRepos,
		fleetSize: FLEET.length,
		superseded: [...supersededKeys],
		...buildGateDoc({ findings: gateFindings, unreadable: gateUnreadable }),
	});
	process.exit(warnOnly ? 0 : findings.length ? 1 : 0);
}

if (findings.length === 0) {
	out.log('✓ fleet tier model clean — every vocabulary complete, every gate ranked');
	process.exit(0);
}

let current = null;
console.error(`\n✗ ${findings.length} tier finding(s):\n`);
for (const f of findings) {
	if (f.repo !== current) {
		current = f.repo;
		console.error(`  ${f.repo}`);
	}
	console.error(`    ${f.file}:${f.line}  [${f.kind}]`);
	console.error(`        ${f.detail}`);
}
console.error(`
  An incomplete vocabulary fails CLOSED and SILENTLY: the unlisted tier is
  rewritten to 'public' or ranked -1, so the caller authenticates at the edge
  and then gets public data — no 401, no 403, no log line.

  Equality against friend/service/wife excludes every tier ABOVE it. Use a rank
  check. Comparisons against 'admin' are exempt (nothing outranks the top).
`);

process.exit(warnOnly ? 0 : 1);
