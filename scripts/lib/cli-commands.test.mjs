/**
 * Every door in the CLI must open onto a file that exists.
 *
 * `src/cli.ts` resolves `scripts/<script>` at RUN time and prints "this is a
 * packaging bug — check the `files` field" when the target is missing. That
 * message is correct and it arrives far too late: the operator finds out in a
 * garage, holding a USB stick, that `fleet admin-fix` points at a path that
 * moved three commits ago.
 *
 * `json-contract.test.mjs` already checks this for the five subcommands under
 * the `--json` contract. The other eighteen had nothing, and the ones with
 * nothing are precisely the recovery commands — `admin-fix`, `usb-prep`,
 * `doctor` — that are used exactly when everything else has already failed.
 * `scripts/claw-admin-fix.sh` moved to `scripts/fixes/` on 2026-08-30 and only a
 * hand-check caught the stale table entry.
 *
 * Reads the SOURCE tree with comments blanked, so a commented-out table entry
 * cannot satisfy the rule and a mention of a filename in prose cannot trip it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';
import { parseCliCommands } from './json-contract.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI = join(ROOT, 'src', 'cli.ts');

const commands = parseCliCommands(blankComments(readFileSync(CLI, 'utf8')));

/** Same floor, same reason, as json-contract.test.mjs: a parse of nothing is not a pass. */
const MIN_COMMANDS = 15;

void test('the COMMANDS table parses — an empty map would assert nothing below', () => {
	assert.ok(
		commands.size >= MIN_COMMANDS,
		`parsed ${commands.size} subcommand(s), expected at least ${MIN_COMMANDS}`
	);
});

void test('every subcommand points at a script that exists', () => {
	const missing = [];
	for (const [sub, script] of commands) {
		if (!existsSync(join(ROOT, 'scripts', script))) missing.push(`${sub} -> scripts/${script}`);
	}
	assert.deepEqual(
		missing,
		[],
		`${missing.length} subcommand(s) resolve to nothing. The CLI reports this at run time ` +
			`as a packaging bug, which is true and arrives when the operator already needs the ` +
			`command to work.`
	);
});

void test('the onboarding phases each have a door', () => {
	// IMAGE and CONVERT, added 2026-08-30 (docs/VOCABULARY.md's phase table).
	// Named individually rather than counted: `fleet provision` picks a node up
	// only once it is reachable over ssh and declared, and everything before that
	// was unowned. A subcommand quietly dropped from the table would leave the
	// phase unreachable with nothing failing.
	assert.equal(commands.get('usb-prep'), 'node-usb-prep.sh', 'IMAGE');
	assert.equal(commands.get('node-bootstrap'), 'node-bootstrap.sh', 'CONVERT');
	assert.equal(commands.get('admin-fix'), 'fixes/claw-admin-fix.sh', 'recovery, from the stick');
});
