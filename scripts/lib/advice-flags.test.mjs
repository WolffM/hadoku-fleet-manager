/**
 * A command this fleet PRINTS as advice must be a command that runs.
 *
 * `fleet enroll` closed with "run this FIRST: fleet converge-toolchain --only
 * <node> --write". There is no `--only`; the flag is `--machine`. The advice
 * was wrong from the day it was written, and it was read and typed at the one
 * moment its reader is least able to second-guess it — the first command after
 * a box is declared, when everything is unfamiliar and a refusal reads as the
 * new node being wrong rather than the instruction. It cost a rejected command
 * on claw-8 and again on claw-9 before it was fixed (#49).
 *
 * These strings are the fleet's user interface and nothing was checking them,
 * because they are prose to every tool that looks at this repo. So: find every
 * `fleet <subcommand> --<flag>` this repo prints, resolve the subcommand to the
 * script that implements it, and require that the script mentions the flag. It
 * is a weak check by design — presence, not semantics — but it is exactly
 * strong enough for the failure it exists to catch, which is a flag that does
 * not exist AT ALL.
 *
 * UNTIL the 2026-11-01 test audit, resolution used a hand-rolled regex
 * (`\bname\s*:`) that cannot match a QUOTED table key. `src/cli.ts` quotes any
 * key containing a hyphen (`'converge-toolchain': { ... }`), and a word
 * boundary sits between the opening quote and the name, so that regex never
 * matched it — 54 of the table's ~85 entries resolved to `null` and the loop
 * below `continue`d past them, silently. This file now resolves through
 * `parseCliCommands` (`json-contract.mjs`), which both `cli-commands.test.mjs`
 * and `cli-help.test.mjs` already trust for the same table, and an
 * UNRESOLVABLE subcommand now FAILS the test instead of being skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';
import { parseCliCommands } from './json-contract.mjs';

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(SCRIPTS);
const CLI_SOURCE = readFileSync(join(ROOT, 'src/cli.ts'), 'utf8');
const COMMANDS = parseCliCommands(blankComments(CLI_SOURCE));

/**
 * The table carried ~85 entries at the time of the 2026-11-01 test audit, and
 * the old quoted-key bug still resolved 31 of them (the unquoted ones) — so a
 * floor near that number would not have caught the regression. This floor only
 * has to catch `parseCliCommands` itself returning next to nothing (an empty
 * map asserts nothing below, the same failure mode `cli-commands.test.mjs`
 * guards with its own `MIN_COMMANDS`).
 */
const MIN_COMMANDS = 70;

test('COMMANDS resolves enough of the table to be worth trusting', () => {
	assert.ok(
		COMMANDS.size >= MIN_COMMANDS,
		`parseCliCommands resolved only ${COMMANDS.size} subcommand(s), expected at least ${MIN_COMMANDS}`
	);
});

test('quoted COMMANDS keys resolve — the bug this file replaces', () => {
	// `'converge-toolchain':` is a quoted key. The old `\bname\s*:` regex put a
	// word boundary right where the quote sits and never matched it.
	assert.ok(
		COMMANDS.has('converge-toolchain'),
		'converge-toolchain did not resolve — the quoted-key regression is back'
	);
});

function sourceFiles() {
	const out = [];
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name !== 'node_modules') walk(p);
			} else if (/\.(mjs|ts)$/.test(e.name) && !/\.test\./.test(e.name)) {
				out.push(p);
			}
		}
	};
	walk(SCRIPTS);
	walk(join(ROOT, 'src'));
	return out;
}

/**
 * The mapped script — and for a SHELL subcommand, its wrapper too; and for an
 * `.mjs` that hands a whole flag off to a sibling via a DYNAMIC import, that
 * sibling too.
 *
 * A subcommand's flags are normally parsed in the file the CLI names. `doctor`
 * is the exception: the CLI maps it to a shell script, and the flags are read
 * by the .mjs that spawns it. Resolving only the named file reports three of
 * doctor's flags as missing that are handled perfectly well one hop away, and
 * a guard whose findings are mostly false teaches its reader to skip it.
 *
 * `node-users.mjs --cutover` is the same shape with a second file instead of a
 * shell script: on `--cutover` it does `await import('./node-users-cutover.mjs')`
 * and every flag past that point, including `--back`, is parsed there. That
 * surfaced once resolution started working (`node-users` has a quoted key, so
 * the old regex never checked it at all) — not a wrong flag, a flag this guard
 * could not see yet.
 *
 * The hop is limited to DYNAMIC `await import('./sibling.mjs')` calls in the
 * mapped file itself — one level, not transitive — DELIBERATELY. Following
 * every STATIC import made this test pass while `fleet benchmark --machine` —
 * a real defect, the same one as #49 — was still in the tree, because
 * benchmark imports lib/fleet-exec.mjs and THAT mentioned `--machine` for a
 * role gate. A wider search is not a stricter test; here it was the difference
 * between catching the bug and reporting nothing at all. A dynamic import of a
 * sibling script is a much narrower signal than a static import of a shared
 * helper: it means "this file hands the rest of argv to that one," which is
 * exactly the .sh wrapper's shape.
 */
function implementationText(impl) {
	let head;
	try {
		head = readFileSync(join(SCRIPTS, impl), 'utf8');
	} catch {
		return null;
	}
	if (impl.endsWith('.sh')) {
		let all = head;
		for (const f of readdirSync(join(SCRIPTS, 'lib'))) {
			if (/\.mjs$/.test(f) && !/\.test\./.test(f)) {
				all += readFileSync(join(SCRIPTS, 'lib', f), 'utf8');
			}
		}
		return all;
	}
	let all = head;
	for (const m of head.matchAll(/await import\('\.\/([a-z0-9-]+\.mjs)'\)/g)) {
		try {
			all += readFileSync(join(SCRIPTS, m[1]), 'utf8');
		} catch {
			// The import target not existing is a different, real bug — not this
			// test's to diagnose; leave `all` as-is and let the flag check below
			// report what it can from the file that does exist.
		}
	}
	return all;
}

/** `fleet foo --bar`, with the flag directly after the subcommand or after one
 * interpolated argument, which is how these strings are written. */
const ADVICE = /fleet ([a-z][a-z-]+)((?:\s+(?:--[a-z][a-z-]*|\$\{[^}]+\}|<[^>]+>))+)/g;

/**
 * `resolve(sub)` returns the implementation text to search, `null` if `sub`
 * resolved but its target could not be read, or `undefined` if `sub` is not a
 * real subcommand at all — which now FAILS rather than being skipped.
 *
 * Only a tail carrying at least one literal `--flag` is worth resolving. A
 * tail of nothing but `${...}`/`<...>` has nothing to check, and the grammar
 * alone is not proof the sentence is CLI advice: `seed-node-cache.mjs` prints
 * "no node in the fleet passes ${spec.probe}", which matches `fleet
 * ([a-z-]+)\s+\$\{...\}` perfectly and is plain English about the word
 * "fleet," not a `fleet passes` invocation. Resolving `sub` only when there is
 * a real flag to check keeps this test aimed at its one job.
 */
export function adviceViolations(src, resolve) {
	const bad = [];
	for (const m of src.matchAll(ADVICE)) {
		const [, sub, tail] = m;
		const flags = tail.match(/--[a-z][a-z-]*/g) ?? [];
		if (!flags.length) continue;
		const impl = resolve(sub);
		if (impl === undefined) {
			bad.push(`fleet ${sub}${tail} — \`${sub}\` is not a subcommand`);
			continue;
		}
		if (impl === null) continue; // resolved; target unreadable (packaging, not advice)
		for (const flag of flags) {
			if (!impl.includes(flag)) bad.push(`fleet ${sub} ${flag} — its script has no ${flag}`);
		}
	}
	return bad;
}

// ---------------------------------------------------------------------------
// Planted violations — prove adviceViolations actually bites, with no disk.
// ---------------------------------------------------------------------------

test('prose containing "fleet <word> ${...}" with no real flag checks nothing', () => {
	const bad = adviceViolations('no node in the fleet passes ${spec.probe} right now', () => {
		throw new Error('must not even attempt to resolve — there is no flag to check');
	});
	assert.deepEqual(bad, []);
});

test('planted violation: an unresolvable subcommand name FAILS, not silently skips', () => {
	const bad = adviceViolations('see `fleet nonexistent-sub --write` for details', () => undefined);
	assert.equal(bad.length, 1);
	assert.match(bad[0], /nonexistent-sub.*not a subcommand/);
});

test('planted violation: a resolved subcommand advised with a flag its script never mentions FAILS', () => {
	const bad = adviceViolations('run `fleet doctor --imaginary-flag` first', (sub) =>
		sub === 'doctor' ? 'doctor-run.mjs implements --write and --cadence' : undefined
	);
	assert.equal(bad.length, 1);
	assert.match(bad[0], /--imaginary-flag/);
});

test('a resolved subcommand advised with a flag its script DOES mention passes', () => {
	const bad = adviceViolations('run `fleet doctor --write` first', (sub) =>
		sub === 'doctor' ? 'doctor-run.mjs implements --write and --cadence' : undefined
	);
	assert.deepEqual(bad, []);
});

test('a subcommand resolved but whose target is unreadable is skipped, not failed', () => {
	// `impl === null`: a packaging bug (file moved), which json-contract's own
	// "every subcommand points at a script that exists" test already guards.
	// This test's job is advice text, not packaging.
	const bad = adviceViolations('run `fleet doctor --write` first', () => null);
	assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------------------
// The real scan.
// ---------------------------------------------------------------------------

test('every `fleet <sub> --flag` this repo prints names a flag that subcommand has', () => {
	const cache = new Map();
	const resolve = (sub) => {
		if (!COMMANDS.has(sub)) return undefined;
		if (!cache.has(sub)) cache.set(sub, implementationText(COMMANDS.get(sub)));
		return cache.get(sub);
	};
	const bad = [];
	for (const file of sourceFiles()) {
		const src = blankComments(readFileSync(file, 'utf8'));
		for (const v of adviceViolations(src, resolve)) {
			bad.push(`${file.slice(ROOT.length + 1)}: ${v}`);
		}
	}
	assert.deepEqual(bad, [], `advice problems:\n  ${bad.join('\n  ')}`);
});
