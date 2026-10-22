/**
 * "WHICH NODE" MUST HAVE ONE ANSWER.
 *
 * `docs/VOCABULARY.md` gives "is this node the box I am running on" exactly one
 * implementation, and `node-identity-guard.test.mjs` fails the build if a sixth
 * appears — because it had five and only one survived an FQDN. "Which node does
 * this command act on" is the same shape of question and, on 2026-09-08, had
 * four answers across one CLI:
 *
 *   enroll        a bare positional
 *   bootcamp      a bare positional, so `--machine claw-7` worked BY ACCIDENT
 *                 (the flag was skipped, its value was the first positional)
 *   provision     `--machine`, REFUSING a positional in a five-line paragraph
 *   seed-python   nothing at all — `--machine claw-7 --confirm` seeded all seven
 *
 * And the shared parser itself did not understand `--machine=NAME`: it looked
 * for a bare `--machine` token, `unconsumedArgs` skipped `--machine=claw-7` as a
 * boolean flag, and machineArg returned null — WHOLE FLEET. So
 * `fleet provision --machine=claw-7 --confirm` applied to every declared node
 * including the production host, which is verbatim what its own refusal message
 * warns about for positionals.
 *
 * Nothing here can be checked by running the deployers — they ssh to seven
 * boxes. What CAN be checked is that one parser is used and that it understands
 * both spellings.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineArg } from './fleet-exec.mjs';
import { blankComments } from './blank-comments.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('both spellings of --machine mean the same thing', () => {
	assert.equal(machineArg(['--machine', 'claw-7']), 'claw-7');
	assert.equal(machineArg(['--machine=claw-7']), 'claw-7');
	assert.equal(
		machineArg(['--machine=claw-7', '--confirm']),
		'claw-7',
		'--machine=NAME beside --confirm must still scope. Returning null here means the ' +
			'apply covers every declared node including the production host.'
	);
	assert.equal(machineArg(['--confirm']), null, 'no scope is still no scope');
});

test('a scoped run never silently widens to the whole fleet', () => {
	// The property that matters, stated as itself: for every spelling that
	// NAMES a node, the parser must return that node and never null.
	for (const argv of [
		['--machine', 'claw-7'],
		['--machine=claw-7'],
		['--json', '--machine', 'claw-7'],
		['--machine=claw-7', '--confirm'],
		['--machine', 'claw-7', '--confirm'],
	]) {
		assert.equal(
			machineArg(argv),
			'claw-7',
			`${JSON.stringify(argv)} names a node and must not scope to the fleet`
		);
	}
});

test('every script that selects nodes resolves scope through the ONE parser', () => {
	// A script may legitimately be fleet-wide — a census has nothing to scope.
	// What it may NOT do is accept a scope argument and ignore it, which is what
	// seed-runner-python.mjs did, or reimplement the parser, which is what
	// bootcamp.mjs did. So: if it calls selectMachines AND takes a scope, the
	// scope must come from machineArg.
	const dir = join(ROOT, 'scripts');
	const offenders = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith('.mjs') || f.endsWith('.test.mjs')) continue;
		const src = blankComments(readFileSync(join(dir, f), 'utf8'));
		if (!src.includes('selectMachines(')) continue;
		// Does it try to scope at all? Either by naming --machine, or by filtering
		// the selected list by a name.
		const scopes = src.includes('--machine') || /only:\s*[A-Z_]/.test(src);
		if (scopes && !src.includes('machineArg')) offenders.push(f);
	}
	assert.deepEqual(
		offenders,
		[],
		'these scripts scope by node without using machineArg — a second implementation of ' +
			'"which node", which is the mistake isLocalNode is guarded against:\n  ' +
			offenders.join('\n  ')
	);
});

test('no script reads a node name from a bare positional', () => {
	// bootcamp's parser was `argv.find(a => !a.startsWith('--'))`. It made
	// `--machine=claw-7 --write` mean "write for every node", silently.
	const dir = join(ROOT, 'scripts');
	const offenders = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith('.mjs') || f.endsWith('.test.mjs')) continue;
		const src = blankComments(readFileSync(join(dir, f), 'utf8'));
		if (/find\(\s*\(?\s*\w+\s*\)?\s*=>\s*!\s*\w+\.startsWith\('--'\)\s*\)/.test(src)) {
			offenders.push(f);
		}
	}
	assert.deepEqual(offenders, [], `bare-positional node scoping found in: ${offenders.join(', ')}`);
});
