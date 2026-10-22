/**
 * README.md's `createFleetManager` example must match the real `FleetHost`.
 *
 * WHY THIS IS A GATE AND NOT A PROMISE
 * ------------------------------------
 * On 2026-08-30 the example passed a `reservation: { current, pm2HostBusy,
 * setPm2HostBusy }` object that is not on the interface AT ALL, and omitted
 * `jobs`, `stateDir`, `storeDoctorPath` and `cronProfilesPath`. Three of those
 * four omissions are stat-checked by `requirePaths()`, so a new consumer
 * following the README got a construction-time throw naming files it had never
 * heard of — and the sentence above the block, "three injected dependencies and
 * one environment variable, that is the whole host contract", was wrong in both
 * directions at once.
 *
 * `FleetHost` is the ONE thing in this package a consumer must get exactly right
 * before anything runs, which makes its documentation the one piece of prose
 * worth compiling. The rest of the README is narrative and stays unguarded on
 * purpose.
 *
 * WHAT IT CHECKS
 * --------------
 * Set equality on the top-level keys, in both directions. A missing key is the
 * failure above; an extra one is the `reservation` failure, which is worse,
 * because a reader has no way to tell an invented field from a real one. Types
 * and nesting are not checked — TypeScript already rejects a wrong shape at the
 * call site, and a README block is not compiled.
 *
 * COMMENTS ARE BLANKED FIRST, in the TS on both sides: `host.ts` documents every
 * field in prose directly above it, and the README block annotates its own. This
 * repo has been bitten three separate times by a grep that read a comment as
 * evidence.
 *
 * The README is sliced to its fenced ```ts block BEFORE blanking, deliberately.
 * `blankComments` is a JavaScript scanner and treats a backtick as a template
 * literal, so running it over raw Markdown — which is mostly backticks — reads
 * the whole document in string mode and blanks nothing. Extracting the fence
 * first means the scanner only ever sees TypeScript, which is what it is for.
 *
 * It lives in the scripts half for the same two reasons as
 * `node-identity-guard.test.mjs`: it imports `blankComments` (which
 * `tsconfig.json` cannot, with no `allowJs`) and it reads the SOURCE tree, so a
 * test compiled into `dist/tests/` would be looking at the wrong files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The body of the `{ … }` that opens at `open`, brace-matched. */
function braceBody(src, open) {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	return null;
}

/**
 * Keys declared at depth 1 of a body: `name:`, `name(` (a method signature) or
 * `name,` (object shorthand, which is how the README passes `logger`).
 */
function topLevelKeys(body) {
	const keys = [];
	let depth = 0;
	for (const line of body.split('\n')) {
		if (depth === 0) {
			const m = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[:(,]/.exec(line);
			if (m) keys.push(m[1]);
		}
		// Count this line's braces AFTER matching it, so `alerts: {` still reads as
		// a key of the enclosing object rather than as the start of a nested one.
		for (const c of line) {
			if (c === '{') depth++;
			else if (c === '}') depth--;
		}
	}
	return keys;
}

/** `export interface FleetHost { … }` in src/host.ts. */
function fleetHostKeys() {
	const src = blankComments(readFileSync(join(ROOT, 'src', 'host.ts'), 'utf8'));
	// Anchored on the brace, not the name. A plain `indexOf` matches
	// `export interface FleetHostLogger` first — it is declared earlier in the
	// file — and yields its three fields instead. The `>= 4` floor below caught
	// exactly that while this test was being written, which is the argument for
	// the floor.
	const decl = /export interface FleetHost\s*\{/.exec(src);
	assert.ok(decl, 'src/host.ts no longer declares `export interface FleetHost`');
	const body = braceBody(src, decl.index + decl[0].length - 1);
	assert.ok(body, 'could not brace-match the FleetHost body');
	return topLevelKeys(body);
}

/** The object literal passed to `createFleetManager(` in README.md's ts fence. */
function readmeKeys() {
	const md = readFileSync(join(ROOT, 'README.md'), 'utf8');
	const fence = [...md.matchAll(/```ts\n([\s\S]*?)```/g)]
		.map((m) => m[1])
		.find((b) => b.includes('createFleetManager({'));
	assert.ok(
		fence,
		'README.md no longer shows a `createFleetManager({ … })` example in a ```ts fence. ' +
			'That example is the only checked documentation of the host contract; do not ' +
			'delete it to make this test pass.'
	);
	const src = blankComments(fence);
	const at = src.indexOf('createFleetManager({');
	const body = braceBody(src, src.indexOf('{', at));
	assert.ok(body, 'could not brace-match the README example');
	return topLevelKeys(body);
}

void test("README's createFleetManager example matches the FleetHost interface", () => {
	const declared = fleetHostKeys();
	const documented = readmeKeys();

	// A parse of nothing is not a pass — the same rule the fleet checkers follow.
	assert.ok(declared.length >= 4, `parsed ${declared.length} FleetHost field(s); the parse broke`);

	const missing = declared.filter((k) => !documented.includes(k));
	const invented = documented.filter((k) => !declared.includes(k));

	assert.deepEqual(
		{ missing, invented },
		{ missing: [], invented: [] },
		`README.md's createFleetManager example has drifted from FleetHost in src/host.ts.\n` +
			`  missing:  ${missing.join(', ') || '(none)'}\n` +
			`  invented: ${invented.join(', ') || '(none)'}\n\n` +
			'Every FleetHost field is required. A missing one is a construction-time throw for ' +
			'the next consumer — requirePaths() stats manifestDir, its three manifests, ' +
			'storeDoctorPath and cronProfilesPath — and an invented one is worse, because a ' +
			'reader cannot tell it from a real field. Fix the README, not this test.'
	);
});

void test('the parser reads code, not prose', () => {
	// Negative control. Without it this gate degrades into a substring search over
	// two files that both DESCRIBE the fields they declare — the mistake that
	// cleared a security rule in reconcile-repo-policy, credited an unschedulable
	// gate in check-gate-coverage, and planned nine runner registrations off a
	// workflow comment saying the repo was NOT on the fleet.
	const proseOnly = ['{', '\t// reservation: { current, pm2HostBusy },', '\tlogger,', '}'].join(
		'\n'
	);
	assert.deepEqual(topLevelKeys(braceBody(blankComments(proseOnly), 0)), ['logger']);

	// Shorthand, nesting on one line, and nesting across lines all parse, and the
	// nested members are NOT mistaken for top-level fields.
	const real = [
		'{',
		'\tlogger,',
		'\talerts: { post: y, recordQuietly: z },',
		'\tjobs: {',
		'\t\trecordJobResult: q,',
		'\t},',
		'\tgithubToken: () => undefined,',
		'}',
	].join('\n');
	assert.deepEqual(topLevelKeys(braceBody(real, 0)), ['logger', 'alerts', 'jobs', 'githubToken']);
});
