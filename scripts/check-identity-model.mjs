#!/usr/bin/env node
/**
 * The identity-model gate — enforcement for `docs/architecture/IDENTITY_MODEL.md`.
 *
 * Ratification without enforcement is the situation that produced the incident:
 * a doc comment asserted something false about `userId`, another repo cited it
 * while deleting a correct guard, and a display name landed in an ownership
 * column. A rule that lives only in prose gets cited, not checked.
 *
 * NOT `check:identity`. That one already exists and it is
 * `scripts/build/sync-identity.mjs` — SITE BRANDING, nothing to do with users.
 * The names are close enough to mislead exactly the way the comment did.
 *
 * Nine checks, all statically decidable:
 *
 *   G1 · one type            a registry-record type declared outside
 *                            @wolffm/worker-utils/identity
 *   G2 · no key columns      a schema declares an ownership column named *_key
 *   G3 · body never owns     an ownership identifier read off a request body
 *   G4 · no false fixtures   a display-name-shaped literal used as a userId
 *   G5 · no self-stamp       non-edge code SETS X-User-Id / X-Hadoku-Tier on a
 *                            request
 *   G6 · the edge stamps it  a worker READS X-User-Id with no injectUserId on
 *                            its edge mount
 *   G7 · resolvers are bound  code RESOLVES an identity in a worker whose
 *                            wrangler.toml binds neither registry nor edge
 *   G8 · credentials don't own  a value read from a CREDENTIAL source reaches
 *                            storage as an owner
 *   G9 · R12, data lives in prefs-api  (a) a store keyed per person outside
 *                            prefs-api, (b) a name/sprite/avatar stored beside
 *                            a userId, (c) an id derived from a credential —
 *                            see lib/identity-r12.mjs (fleet-manager#39)
 *
 * The header said "five" for a day after G6 landed, and "six" for the length of
 * one commit after G7 did, and "eight" until G9. That is the same class of
 * defect the whole contract is about — a comment asserting something about the
 * code that the code no longer does — so it is worth the pedantry.
 *
 * G3 is the one that matters: it would have caught BOTH incidents, and it is
 * the clause the contract exists for (R5).
 *
 * ALLOWLIST: `scripts/admin/identity-model-allowlist.json`, keyed by
 * `{check, file}`, every entry carrying a `why`. A stale entry FAILS — an
 * exemption that no longer matches anything is a rule nobody is reading.
 * A sibling repo's file is named WITH its repo prefix (`hadoku-task:src/x.ts`);
 * a bare path only ever means hadoku_site's own file.
 *
 * INLINE WAIVERS come first (fleet-manager#82, lib/gate-waivers.mjs): a repo
 * exempts its own code with `identity-model-disable-next-line <check>: <why>`
 * on the line above, in the repo the code ships in. The central list keeps
 * the site's own files and `nonWaivable`, the checks no repo may waive for
 * itself. `--print-waivers` turns each central entry that names a sibling
 * repo into the waiver to add there, so the central rows can be deleted.
 *
 * An entry WITHOUT `count` exempts every finding of its check in its file, so
 * a new violation landing in that file is invisible — prefer adding
 * `"count": N` (the number of findings it exists for). More than N then
 * reports all of them, and fewer than N is stale until the count is lowered.
 *
 * Run from repo root:  fleet identity-model
 * Sibling repos too:   fleet identity-model --fleet
 * For the cron:        fleet identity-model --fleet --json
 * Exit 0 = clean. Exit 1 = a violation (file:line printed with the fix).
 *
 * @guards workers/**
 * @guards services/**
 * @guards src/**
 */

import { readFileSync, writeSync } from 'node:fs';
import { relative, basename } from 'node:path';

import { allRepos } from './lib/fleet-roster.mjs';
import { manifest as manifestFile } from '../dist/lib/fleet-paths.js';
import { createEmitter } from './lib/emit.mjs';
import { REPO_ROOT, scanRepo } from './lib/identity-rules.mjs';
import { overdueAdvisories, splitByStage } from './lib/identity-stages.mjs';
import {
	OWNER_MODULE,
	OWNER_IMPORT,
	EDGE_INDEX,
	IDENTITY_CHECKS,
	IDENTITY_WAIVER_GATE,
} from './lib/identity-constants.mjs';
import { waiverText } from './lib/gate-waivers.mjs';
import { checkoutFreshness, siblingRepos } from './lib/identity-scan.mjs';

/** When this run started. Every exit path reports against this. */
const START_MS = Date.now();

/**
 * This run's own wall clock, to STDERR, right before every `process.exit`.
 *
 * A fleet-wide scan walks every sibling checkout and has quietly run long
 * before (`ci:identity-model` is a cron, not a person watching a terminal) —
 * the next regression of that kind should be visible before it trips a
 * caller's timeout, not discovered after the fact from a cron's own clock.
 *
 * Written with `writeSync(2, …)` rather than `console.error`, for the same
 * reason `lib/emit.mjs` stopped trusting `console.log` on fd 1: on a PIPE,
 * Node's stdio write is queued, and `process.exit` on the next line abandons
 * whatever had not yet reached the kernel. stderr is not exempt from that on
 * POSIX, so this line uses the same synchronous primitive `emit.mjs` uses for
 * stdout, applied to fd 2. Never stdout: `--json` is a contract and a human
 * line on fd 1 in that mode turns a real finding into "the checker broke".
 *
 * Deliberately NOT prefixed with this file's own basename. The test suite's
 * `run()` helper concatenates stdout AND stderr on purpose (so a warning on a
 * clean run is still visible to an assertion), and "the gate does not report
 * ITSELF when scanned as a sibling repo" asserts the combined output never
 * contains the literal substring `check-identity-model` — a real finding would
 * mean the self-exclusion in `scanRepo` regressed. A timing line is not a
 * finding, but it would trip that same regex for an unrelated reason, so it
 * says `identity-model` rather than the file's full name.
 */
function reportWallClock() {
	try {
		writeSync(2, Buffer.from(`identity-model wall-clock: ${Date.now() - START_MS}ms\n`, 'utf8'));
	} catch {
		// A timing line is best-effort; it must never be why the gate crashes.
	}
}

const ALLOWLIST_JSON = manifestFile('identity-model-allowlist.json');

const FLEET = process.argv.includes('--fleet');
const PRINT_WAIVERS = process.argv.includes('--print-waivers');
const JSON_OUT = process.argv.includes('--json');
// One stdout discipline, shared — see lib/emit.mjs. `emit` is the only write
// to stdout; every human line goes through `log` and is held in --json mode.
const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;

/**
 * Refuse to run on a broken allowlist — and in `--json` mode say so ON STDOUT
 * first. It exited with only a stderr line, so the cron parsed no document and
 * read the finding as "the checker broke": the `--json` contract (#98).
 */
function allowlistError(error) {
	if (JSON_OUT) emitter.emit({ fleet: FLEET, violations: [], error });
	else console.error(`✗ ${error}`);
	reportWallClock();
	process.exit(1);
}

function loadAllowlist() {
	let obj;
	try {
		obj = JSON.parse(readFileSync(ALLOWLIST_JSON, 'utf8'));
	} catch (err) {
		if (err.code === 'ENOENT') return { map: new Map(), entries: [], nonWaivable: [] };
		allowlistError(`allowlist ${ALLOWLIST_JSON} is unreadable: ${err.message}`);
	}
	const map = new Map();
	for (const entry of obj.allowed || []) {
		if (!entry.check || !entry.file || !entry.why) {
			allowlistError(`allowlist entry needs "check", "file" and "why": ${JSON.stringify(entry)}`);
		}
		if ('count' in entry && !(Number.isInteger(entry.count) && entry.count > 0)) {
			allowlistError(
				`allowlist entry "count" must be a positive integer: ${JSON.stringify(entry)}`
			);
		}
		map.set(`${entry.check}::${entry.file}`, entry);
	}
	const nonWaivable = obj.nonWaivable ?? [];
	const unknown = Array.isArray(nonWaivable)
		? nonWaivable.filter((c) => !IDENTITY_CHECKS.includes(c))
		: [nonWaivable];
	if (unknown.length) {
		allowlistError(
			`allowlist "nonWaivable" must list check ids (${IDENTITY_CHECKS.join(' ')}); not: ${JSON.stringify(unknown)}`
		);
	}
	return { map, entries: obj.allowed || [], nonWaivable };
}

const { map: allow, entries, nonWaivable } = loadAllowlist();
const violations = [];
/** allowlist entry -> the violations it absorbed, across every repo scanned. */
const hitEntries = new Map();
/** central entries an inline waiver made redundant: reported, never fatal. */
const superseded = new Set();
let waived = scanRepo(REPO_ROOT, null, allow, violations, hitEntries, undefined, {
	nonWaivable,
	superseded,
}).waived;

/**
 * Repos whose files are OLDER than origin — see checkoutFreshness. Only the
 * site root can land here: a sibling is read at its shipped commit, so it is
 * never behind.
 */
const staleCheckouts = [];
const ALLOW_STALE = process.argv.includes('--allow-stale');
const noteFreshness = (dir, label) => {
	if (ALLOW_STALE) return;
	const f = checkoutFreshness(dir);
	if (f.state === 'behind') {
		staleCheckouts.push({ repo: label, behind: f.behind, reason: f.reason });
	}
};

let scanned = 1;
let missingCheckouts = [];
/** slug -> the reader's reason, for the text report. */
let missingWhy = new Map();
/**
 * Why a `--fleet` run scanned no sibling at all, or null. An EMPTY roster — or
 * one whose every entry was skipped — scanned only the site and printed "clean
 * across the fleet (1 repos)" (#98). Zero siblings opened is not a fleet audit,
 * however the roster came to say so.
 */
let rosterError = null;
noteFreshness(REPO_ROOT, basename(REPO_ROOT));
if (FLEET) {
	const { trees, missing, why } = siblingRepos();
	missingCheckouts = missing;
	missingWhy = why;
	for (const { root, label, tracked } of trees) {
		waived += scanRepo(root, label, allow, violations, hitEntries, tracked, {
			nonWaivable,
			superseded,
		}).waived;
	}
	scanned += trees.length;
	if (!trees.length) {
		const listed = allRepos().length;
		rosterError = listed
			? `--fleet opened ZERO sibling repos (the roster lists ${listed}) — this was not a fleet audit`
			: '--fleet found an EMPTY roster (fleet-runner-coverage.json lists no sibling repos) — this was not a fleet audit';
	}
}

// AN ENTRY'S `count` IS A CEILING. Absent, the entry exempts every finding of
// its check in its file — today's behaviour, kept so the live allowlist's
// entries keep working — but that means a NEW violation landing in an
// allowlisted file is invisible. With `count: N`, more than N findings surface
// ALL of them: the gate cannot tell which one is new, and a human can.
for (const [entry, absorbed] of hitEntries) {
	if (typeof entry.count !== 'number' || absorbed.length <= entry.count) continue;
	for (const v of absorbed) {
		violations.push({
			...v,
			message: `${v.message} (allowlisted for ${entry.count}, ${absorbed.length} found — one is new)`,
		});
	}
}

// STAGED RULES (lib/identity-stages.mjs, fleet-manager#67). A rule's first
// release reports without failing; only an ENFORCED rule's findings reach the
// exit code. Split after the allowlist and its counts, so an exemption absorbs
// an advisory finding exactly as it would an enforced one.
const staged = splitByStage(violations);
const advisories = staged.advisory;
violations.length = 0;
violations.push(...staged.enforced);
const overdue = overdueAdvisories();

// A stale exemption is a rule nobody is reading. Only enforced on a COMPLETE
// scan — and complete means every roster repo was actually opened, not merely
// that --fleet was passed. Run from a worktree before 2026-08-28 this scanned
// one repo and then told the operator to delete three live exemptions belonging
// to repos it had never looked at: an unmatched entry is evidence of staleness
// only if the thing it exempts was in scope. Missing checkouts are already
// reported on their own; deriving a second, wrong verdict from the same gap is
// how "I could not look" becomes "nothing is there".
//
// A `count` ABOVE what was found is stale the same way: the headroom is room
// for a new violation to land unseen, so it must be lowered as fixes land.
const completeScan = FLEET && missingCheckouts.length === 0 && !rosterError;
//
// A SUPERSEDED entry is never stale: the repo it names waives the finding
// inline now, and the row waits for the site to delete it. Reported, so it
// does not wait forever.
const stale = completeScan
	? entries.filter(
			(e) =>
				!superseded.has(e) &&
				(!hitEntries.has(e) || (typeof e.count === 'number' && hitEntries.get(e).length < e.count))
		)
	: [];
const supersededExemptions = entries
	.filter((e) => superseded.has(e))
	.map((e) => `${e.check} ${e.file}`);
const describeStale = (e) =>
	hitEntries.has(e)
		? `${e.check} ${e.file} — count is ${e.count} but only ${hitEntries.get(e).length} found; lower it`
		: `${e.check} ${e.file}`;

// THE MIGRATION (fleet-manager#82): every central entry that names a sibling
// repo, as the inline waiver that replaces it. Read from what this run's scan
// actually matched, so each waiver lands on a line that holds its finding
// today. Lines are listed bottom-up per file: inserting a waiver shifts every
// line below it, so working top-down would aim each later one wrong.
if (PRINT_WAIVERS) {
	if (!FLEET) {
		allowlistError('--print-waivers needs --fleet: the entries it moves name sibling repos');
	}
	const waivers = [];
	const keep = [];
	for (const e of entries) {
		const sep = e.file.indexOf(':');
		if (sep < 0) continue; // the site's own file: it stays central
		const [repo, file] = [e.file.slice(0, sep), e.file.slice(sep + 1)];
		if (nonWaivable.includes(e.check)) {
			keep.push({ check: e.check, file: e.file, reason: 'non-waivable: stays central' });
			continue;
		}
		const hit = hitEntries.get(e);
		if (!hit) {
			const reason = superseded.has(e)
				? 'already waived in its repo: delete it'
				: 'matches nothing: delete it';
			keep.push({ check: e.check, file: e.file, reason });
			continue;
		}
		const lines = [...new Set(hit.map((v) => v.line))].sort((a, b) => b - a);
		const top = lines.at(-1);
		for (const line of lines) {
			// The full reason once, on the topmost; the rest point up at it.
			const why = line === top ? e.why : 'same reason as the waiver above';
			waivers.push({
				repo,
				file,
				line,
				check: e.check,
				insert: waiverText(IDENTITY_WAIVER_GATE, e.check, why, file),
			});
		}
	}
	if (JSON_OUT) emitter.emit({ complete: completeScan, waivers, keep, missingCheckouts });
	else {
		for (const w of waivers) {
			log(`${w.repo}:${w.file}  above line ${w.line}`);
			for (const l of w.insert) log(`    ${l}`);
		}
		for (const k of keep) log(`(not moved) ${k.check} ${k.file} — ${k.reason}`);
		if (!completeScan) log(`✗ incomplete scan: ${missingCheckouts.join(', ') || rosterError}`);
	}
	reportWallClock();
	process.exit(completeScan ? 0 : 1);
}

// The machine-readable form, for ci:identity-model. Printed on EVERY path,
// clean or not, so the caller parses one shape rather than branching on the
// exit code — the same contract check-header-fleet.mjs offers its job.
if (JSON_OUT) {
	emitter.emit({
		fleet: FLEET,
		scanned,
		violations,
		// Additive to the contract: never part of the exit code.
		advisories,
		overdueAdvisories: overdue,
		staleExemptions: stale.map(describeStale),
		waived,
		supersededExemptions,
		missingCheckouts,
		staleCheckouts,
		rosterError,
	});
	// staleCheckouts is REPORTED, never fatal. `repos:main-sync` sets the
	// precedent: repos it cannot safely ff are reported and the ci-digest renders
	// them, because a sync problem is not an identity finding. And the nightly
	// window makes strictness actively wrong — main-sync runs minutes before this,
	// so any bot push in between (format-bot, the package bumps) puts a repo one
	// commit behind and would fail this gate for a reason that is not its business.
	// A daily false alarm is how a real one stops being read.
	reportWallClock();
	process.exit(violations.length || stale.length || missingCheckouts.length || rosterError ? 1 : 0);
}

if (advisories.length) {
	console.error(
		`\n⚠ ${advisories.length} finding(s) from ADVISORY rule(s) — reported, not failing; they enforce next release:\n`
	);
	for (const v of advisories) console.error(`  ${v.check} ${v.file}:${v.line}  ${v.message}`);
	console.error('');
}
for (const o of overdue) console.error(`⚠ OVERDUE: ${o}`);
for (const e of supersededExemptions) {
	console.error(`⚠ ${e}: waived inline in its repo now; delete the central allowlist row`);
}

if (rosterError) console.error(`\n✗ ${rosterError}\n`);

if (missingCheckouts.length) {
	console.error(
		`\n✗ ${missingCheckouts.length} roster repo(s) could not be read, so this run did not audit them:\n`
	);
	for (const r of missingCheckouts) console.error(`  ${r}: ${missingWhy.get(r)}`);
	console.error(
		`\n  An audit that asserts cleanliness without looking is worse than no audit.\n` +
			`  Fix the read, or drop them from fleet-runner-coverage.json if they are\n` +
			`  genuinely gone.\n`
	);
}

// Printed BEFORE the verdict, and on every path. A stale checkout falsifies both
// outcomes — a fix it cannot see, and a finding already fixed on origin — so this
// is not a footnote to a clean run, it is a caveat on whatever the run said.
if (staleCheckouts.length) {
	console.error(
		`\n⚠ ${staleCheckouts.length} checkout(s) are BEHIND origin, so this audit read old code:\n`
	);
	for (const c of staleCheckouts) {
		console.error(`  ${c.repo}  ${c.behind === null ? c.reason : `${c.behind} commit(s) behind`}`);
	}
	console.error(
		`\n  Findings from those repos may already be fixed, and fixes already landed are\n` +
			`  invisible here — the 2026-09-24 run reported a violation in a file whose fix was\n` +
			`  on origin/main at the time.\n` +
			`  Not fatal: the nightly syncs first (repos:main-sync, ordered ahead of the audits\n` +
			`  in the same profile), so this is the ad-hoc case, and a bot push landing between\n` +
			`  that sync and this run is normal.\n` +
			`  Catch up with: git -C <repo> merge --ff-only origin/main\n` +
			`  Suppress deliberately with --allow-stale.\n`
	);
}

if (!violations.length && !stale.length && !missingCheckouts.length && !rosterError) {
	const scope = FLEET ? `the fleet (${scanned} repos)` : basename(REPO_ROOT);
	// The caveat rides ON the verdict line, not only in the banner above it. A
	// clean line is what gets quoted into a digest or a commit message, and
	// "clean across 28 repos" is the exact sentence that was wrong on 2026-09-24.
	log(
		staleCheckouts.length
			? `✓ identity model clean — G1..G9 across ${scope}, BUT ${staleCheckouts.length} checkout(s) were behind origin (see above): this verdict is partly about old code`
			: `✓ identity model clean — G1..G9 across ${scope}`
	);
	reportWallClock();
	process.exit(0);
}

const FIXES = {
	G1: `Import it: import type { KeyRegistryRecord } from '${OWNER_IMPORT}'.
     One definition, in ${OWNER_MODULE}. Four hand-copied ones drifted into four
     different doc comments and one of them asserted something false.`,
	G2: `Store the resolved userId, not the credential. Credentials ROTATE, and a
     rotation detaches every row keyed on one (R7). Resolve at ingest through
     ${OWNER_IMPORT} and name the column owner_user_id.`,
	G8: `Store the resolved userId, not the credential. A credential read is fine —
     forwarding one is normal — but the value must never become ownership. Resolve
     it through ${OWNER_IMPORT}, or read the edge-stamped X-User-Id, and store
     THAT (R3/R7). Masking or hashing does not help: a truncated credential is
     still key-derived and still detaches on rotation.`,
	G3: `Resolve it or reject it (R5). A userId/friendKey in a request body is a
     CLAIM, not an identity — take a display \`name\` and resolve it through
     resolveGrantee() from ${OWNER_IMPORT}. This is the clause both incidents
     broke; a registry lookup rejects "hadoku" AND a well-formed UUID belonging
     to nobody, which a regex waves through.`,
	G4: `That literal is a display NAME. A userId is a v4 UUID minted by the
     registry (R2); the name lives on the same record, which is how they get
     confused. Use a UUID, or a fixture with a separator in it.`,
	G6: `R1 lets a worker trust X-User-Id — but only if the edge STAMPS it. Add
     \`injectUserId: true\` to that worker's proxyRequest config in
     ${EDGE_INDEX}. \`injectSessionKey\` is NOT a substitute: it stamps
     X-User-Key, a credential, and keying reads on one is what the identity
     model exists to undo.`,
	G7: `A resolver that cannot reach a registry answers every name with an
     outage — and it typechecks, deploys and passes its tests first, which is
     why this is a gate and not a comment. Give that worker ONE of:
       [[kv_namespaces]] binding = "SESSIONS_KV"   — direct, and note what it
         costs: that namespace is keyed \`key:{rawKey}\`, so the binding grants
         the worker list() over every live credential, plus write. Right only
         for a worker that resolves BY RAW KEY already.
       [[services]] service = "edge-router"        — resolveGranteeVia(), which
         answers one name and discloses nothing else. Right for everything
         else, and for anything new.`,
	waiver: `Fix the waiver (lib/gate-waivers.mjs): give it a reason after the
     colon, delete it once the code it covered no longer trips the check, or,
     for a non-waivable check, fix the code, since only the site's central
     list can exempt it.`,
	G5: `Only edge-router establishes identity (R1). A script acting for someone
     authenticates with ITS OWN credential and names the target as a parameter
     the app authorizes by tier (R11) — it never asserts the target's headers.`,
	G9a: `A record that belongs to ONE person is a prefs-api row, not a table or
     file on the app's disk (R12): an account delete erases prefs-api and cannot
     see a per-app copy. Write it as a prefs row — the browser's own PUT
     /prefs/api/v1/:appId, or the server's writeFor() from
     @wolffm/prefs-client/service — read across people with read()/all(), then
     add a migration that drops or re-keys the table. Shared state (a room, a
     queue, a share between two people) stays and names people by userId only.`,
	G9b: `Store the userId only and look the name, sprite or avatar up when shown
     (R4, R12): a stored copy outlives the person who chose it, and an account
     delete cannot reach it. Drop the column in a migration (or the field from
     the persisted record).`,
	G9c: `Never derive an identity from a credential (R7, R12): a hashed or
     truncated key still changes when the key rotates, and the person becomes a
     stranger. Pass the registry userId — the edge-stamped X-User-Id after
     sanitizeHeaders, or one resolved through whoami — as the account material.`,
};

if (violations.length) {
	console.error(`\n✗ ${violations.length} identity-model violation(s):\n`);
	const byCheck = new Map();
	for (const v of violations) byCheck.set(v.check, [...(byCheck.get(v.check) ?? []), v]);
	for (const check of [...byCheck.keys()].sort()) {
		console.error(`  ${check}:`);
		for (const v of byCheck.get(check)) console.error(`    ${v.file}:${v.line}  ${v.message}`);
		console.error(`\n  Fix — ${FIXES[check]}\n`);
	}
	console.error(`  Contract: docs/architecture/IDENTITY_MODEL.md\n`);
}

if (stale.length) {
	console.error(
		`\n✗ ${stale.length} stale allowlist entr(ies) in ${relative(REPO_ROOT, ALLOWLIST_JSON)}:\n`
	);
	for (const e of stale) {
		console.error(
			`  ${describeStale(e)}${hitEntries.has(e) ? '' : ' — matches nothing; remove it'}`
		);
	}
	console.error('');
}

reportWallClock();
process.exit(1);
