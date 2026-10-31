import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGateDoc } from './gate-doc.mjs';

void test('no findings and nothing unreadable: ok, no why', () => {
	const doc = buildGateDoc({});
	assert.deepEqual(doc, { ok: true, findings: [], unreadable: [] });
	assert.ok(!('why' in doc), 'a clean doc must not carry why');
});

void test('a finding alone makes it not-ok and fills in why', () => {
	const doc = buildGateDoc({ findings: [{ node: 'claw-1', kind: 'x', reason: 'y' }] });
	assert.equal(doc.ok, false);
	assert.equal(doc.why, '1 finding(s)');
});

void test('unreadable alone — "could not look" — is never folded into ok:true', () => {
	const doc = buildGateDoc({ unreadable: [{ node: 'claw-2', why: 'ssh timed out' }] });
	assert.equal(doc.ok, false);
	assert.equal(doc.why, '1 unreadable');
	assert.deepEqual(doc.findings, []);
});

void test('both arrays non-empty: why names both counts', () => {
	const doc = buildGateDoc({
		findings: [{ node: null, kind: 'a', reason: 'b' }],
		unreadable: [
			{ node: 'claw-3', why: 'c' },
			{ node: 'claw-4', why: 'd' },
		],
	});
	assert.equal(doc.ok, false);
	assert.equal(doc.why, '1 finding(s), 2 unreadable');
});

void test('an explicit why always wins over the summary', () => {
	const doc = buildGateDoc({
		findings: [{ node: null, kind: 'a', reason: 'b' }],
		why: 'a custom explanation',
	});
	assert.equal(doc.why, 'a custom explanation');
});

void test('an explicit ok:true with findings present is honoured by the shape, never silently overridden', () => {
	// buildGateDoc trusts an explicit `ok` — the CALLER is the one that must
	// never pass true with unreadable non-empty; this proves the function
	// does not second-guess it (the consumer side, not this builder, is where
	// "ok:true must never co-exist with unreadable" is enforced defensively —
	// see audit-gates.ts).
	const doc = buildGateDoc({ ok: true, findings: [{ node: null, kind: 'a', reason: 'b' }] });
	assert.equal(doc.ok, true);
	assert.ok(!('why' in doc));
});

void test('an explicit ok:false with empty arrays still carries why', () => {
	const doc = buildGateDoc({ ok: false });
	assert.equal(doc.why, 'not ok');
});
