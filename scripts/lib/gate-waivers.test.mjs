/**
 * lib/gate-waivers.mjs, the parser and ledger both fleet gates share
 * (fleet-manager#82). The gates' own tests cover what each CLI does with it.
 *
 * Every marker is assembled at runtime (`mark`) so this file holds no literal
 * waiver for the fleet's own scans of this repo to read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commentFor, createWaiverLedger, parseWaivers, waiverText } from './gate-waivers.mjs';

const GATE = 'demo-gate';
const mark = (rest) => `${GATE}-${'disable-next-line'} ${rest}`;
const RULES = new Set(['R1', 'two-part']);

test('every comment syntax the gates read carries a waiver', () => {
	const text = [
		`// ${mark('R1: slashes')}`,
		'a();',
		`# ${mark('R1: hash')}`,
		'b = 1',
		`-- ${mark('two-part: sql')}`,
		'CREATE TABLE t (x TEXT);',
		`/* ${mark('R1: block')} */`,
		'c();',
	].join('\n');
	assert.deepEqual(
		parseWaivers(text, GATE, RULES).map((w) => [w.rule, w.why, w.markerLine, w.target]),
		[
			['R1', 'slashes', 1, 2],
			['R1', 'hash', 3, 4],
			['two-part', 'sql', 5, 6],
			['R1', 'block', 7, 8],
		]
	);
});

test('the target skips blank and comment-only lines; none left is null', () => {
	const text = `// ${mark('R1: why')}\n\n// more why\n  # and more\ncode();\n// ${mark('R1: end')}\n`;
	assert.deepEqual(
		parseWaivers(text, GATE, RULES).map((w) => w.target),
		[5, null]
	);
});

test('an unknown rule is not a waiver, and a missing reason is empty', () => {
	const text = `// ${mark('<rule>: prose')}\nx();\n// ${mark('R1')}\ny();\n`;
	assert.deepEqual(
		parseWaivers(text, GATE, RULES).map((w) => [w.rule, w.why]),
		[['R1', '']]
	);
});

test('the ledger absorbs only a valid waiver on its own line and rule, and names the rest', () => {
	const ledger = createWaiverLedger({ gate: GATE, rules: RULES, nonWaivable: ['two-part'] });
	ledger.addFile(
		'f.ts',
		[
			`// ${mark('R1: ok')}`,
			'a();',
			`// ${mark('R1')}`,
			'b();',
			`// ${mark('two-part: locked')}`,
			'c();',
			`// ${mark('R1: nothing here')}`,
			'd();',
		].join('\n')
	);
	assert.equal(ledger.absorbs('f.ts', 'R1', 2), true);
	assert.equal(ledger.absorbs('f.ts', 'R1', 4), false, 'no reason');
	assert.equal(ledger.absorbs('f.ts', 'two-part', 6), false, 'non-waivable');
	assert.equal(ledger.absorbs('f.ts', 'two-part', 2), false, 'wrong rule');
	assert.equal(ledger.absorbs('g.ts', 'R1', 2), false, 'wrong file');
	assert.equal(ledger.absorbed, 1);
	assert.deepEqual(
		ledger.problems().map((p) => [p.line, p.problem]),
		[
			[3, 'no reason'],
			[5, 'non-waivable'],
			[7, 'unused'],
		]
	);
});

test('waiverText wraps the reason under the marker, and every line parses back', () => {
	const why = 'word '.repeat(60).trim();
	const lines = waiverText(GATE, 'R1', why, 'x.py', 60);
	assert.ok(lines.length > 2);
	assert.ok(lines.every((l) => l.startsWith('# ') && l.length <= 60));
	const parsed = parseWaivers(`${lines.join('\n')}\ncode = 1\n`, GATE, RULES);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].target, lines.length + 1);
});

test('the marker line keeps a word of reason however long the word', () => {
	const [first] = waiverText(GATE, 'R1', 'x'.repeat(200), 'x.ts', 40);
	assert.ok(first.endsWith('x'.repeat(200)));
});

test('commentFor picks the language opener', () => {
	assert.deepEqual(['a.py', 'b.sql', 'c.ts', 'd.yml'].map(commentFor), ['#', '--', '//', '#']);
});
