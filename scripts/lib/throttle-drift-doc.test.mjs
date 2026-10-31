// throttle-drift-doc.test.mjs — wave 5i lane B. `deploy-ci-throttle.mjs`
// reaches real nodes over ssh and has no hermetic path to execute in a
// test (see that file's own header, and `runner-env-drift.mjs`'s, which is
// pulled out for the identical reason) — so this file drives `classifyDrift`
// directly, as a pure function, over the REAL strings `deploy-ci-throttle.mjs`,
// `runner-env-drift.mjs` and `script-provenance.mjs` actually produce.
//
// "I could not look" (an unreachable node, a read that never completed) must
// land in `unreadable`, never folded into `findings` — the same rule every
// other migrated gate's GateDoc tests pin.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyDrift } from './throttle-drift-doc.mjs';
import { runnerEnvDrift, throttleSummaryDrift } from './runner-env-drift.mjs';
import { provenanceDrift } from './script-provenance.mjs';

test('a clean drift array (nothing wrong) classifies to two empty arrays', () => {
	assert.deepEqual(classifyDrift([]), { findings: [], unreadable: [] });
});

test('an unreachable node (deploy-ci-throttle.mjs own unreachable-node line) is unreadable', () => {
	const entry = 'claw-9: could not be reached, so NOTHING on it was checked — ETIMEDOUT';
	const { findings, unreadable } = classifyDrift([entry]);
	assert.deepEqual(findings, []);
	assert.deepEqual(unreadable, [{ node: 'claw-9', why: entry }]);
});

test('runnerEnvDrift: no SUMMARY tokens at all is unreadable, never a finding', () => {
	const entry = runnerEnvDrift({ name: 'claw-3', ephemeral: true, summary: 'conf=1' });
	assert.match(entry, /could not read runner\.env state/);
	const { findings, unreadable } = classifyDrift([entry]);
	assert.deepEqual(findings, []);
	assert.equal(unreadable.length, 1);
	assert.equal(unreadable[0].node, 'claw-3');
});

test('runnerEnvDrift: an ephemeral node with no runner.env is a finding, not unreadable', () => {
	const entry = runnerEnvDrift({
		name: 'claw-3',
		ephemeral: true,
		summary: 'runnerenv=0 runnerenvkeys=0',
	});
	assert.match(entry, /declares ephemeral but has no runner\.env/);
	const { findings, unreadable } = classifyDrift([entry]);
	assert.deepEqual(unreadable, []);
	assert.equal(findings.length, 1);
	assert.equal(findings[0].node, 'claw-3');
	assert.equal(findings[0].kind, 'throttle-drift');
});

test('provenanceDrift: no hash reported at all is unreadable', () => {
	const entry = provenanceDrift('claw-5', 'job-metrics.sh', undefined, 'a'.repeat(64), '9.9.9');
	assert.match(entry, /reported no hash/i);
	const { findings, unreadable } = classifyDrift([entry]);
	assert.deepEqual(findings, []);
	assert.equal(unreadable.length, 1);
	assert.equal(unreadable[0].node, 'claw-5');
});

test('provenanceDrift: unreadable-on-the-node is unreadable here too', () => {
	const entry = provenanceDrift('claw-5', 'x.sh', 'unreadable', 'a'.repeat(64), '9.9.9');
	const { unreadable } = classifyDrift([entry]);
	assert.equal(unreadable.length, 1);
});

test('provenanceDrift: absent (not deployed at all) is a FINDING — this gate actually observed it', () => {
	const entry = provenanceDrift('claw-5', 'x.sh', 'absent', 'a'.repeat(64), '9.9.9');
	assert.match(entry, /is not deployed at all/);
	const { findings, unreadable } = classifyDrift([entry]);
	assert.deepEqual(unreadable, []);
	assert.equal(findings.length, 1);
	assert.equal(findings[0].node, 'claw-5');
});

test('provenanceDrift: a hash that simply differs is a finding', () => {
	const want = 'a'.repeat(64);
	const entry = provenanceDrift('claw-5', 'x.sh', 'b'.repeat(64), want, '9.9.9');
	const { findings, unreadable } = classifyDrift([entry]);
	assert.deepEqual(unreadable, []);
	assert.equal(findings.length, 1);
});

test('throttleSummaryDrift: no SUMMARY line at all is unreadable', () => {
	const [entry] = throttleSummaryDrift({
		name: 'claw-2',
		m: { maxConcurrent: 4, minFreeMb: 1024 },
		kv: null,
		wantConfSha: 'x',
	});
	assert.match(entry, /nothing about this node was verified/);
	const { findings, unreadable } = classifyDrift([entry]);
	assert.deepEqual(findings, []);
	assert.equal(unreadable.length, 1);
	assert.equal(unreadable[0].node, 'claw-2');
});

test('throttleSummaryDrift: the hook running with no limit (conf=0) is a finding', () => {
	const [entry] = throttleSummaryDrift({
		name: 'claw-2',
		m: { maxConcurrent: 4, minFreeMb: 1024 },
		kv: { conf: '0', harvest: '1', newly: '0', stale: '0', nolistener: '0' },
		wantConfSha: 'x',
	});
	assert.match(entry, /cannot load its config/);
	const { findings, unreadable } = classifyDrift([entry]);
	assert.deepEqual(unreadable, []);
	assert.equal(findings.length, 1);
});

test("throttleSummaryDrift: a missing token (unread()) is unreadable, via the shared 'could not read' marker", () => {
	const [entry] = throttleSummaryDrift({
		name: 'claw-2',
		m: { maxConcurrent: 4, minFreeMb: 1024 },
		kv: { conf: '2', harvest: '1', newly: '0', stale: '0', nolistener: '0' },
		wantConfSha: 'x',
	});
	assert.match(entry, /could not read whether the throttle hook can load its config/);
	const { findings, unreadable } = classifyDrift([entry]);
	assert.deepEqual(findings, []);
	assert.equal(unreadable.length, 1);
	assert.equal(unreadable[0].node, 'claw-2');
});

test('the standing-env "never reached the rule" case is unreadable, not a finding', () => {
	const entry =
		'claw-6: the node half never reached the standing-env rule, so nothing about it was checked ' +
		'— every warm-cache fill on this node REFUSES rather than minting an unthrottled standing listener';
	const { findings, unreadable } = classifyDrift([entry]);
	assert.deepEqual(findings, []);
	assert.equal(unreadable.length, 1);
	assert.equal(unreadable[0].node, 'claw-6');
});

test('the standing-env "absent"/"stale" cases are findings — this gate DID observe them', () => {
	const entry =
		'claw-6: ~/.hadoku/standing.env is not deployed — every warm-cache fill on this node REFUSES';
	const { findings, unreadable } = classifyDrift([entry]);
	assert.deepEqual(unreadable, []);
	assert.equal(findings.length, 1);
});

test('the unbounded-node line (no colon after the node name) classifies with node: null', () => {
	// deploy-ci-throttle.mjs reports `unbounded` as ONE combined, un-prefixed
	// string across every unbounded node — this module's own caller instead
	// builds a per-node finding directly from `unbounded`, never through this
	// classifier, so a bare mismatch here (no leading "name: ") must fall
	// back to node: null rather than misparsing the first word as a node.
	const entry = 'claw-7 declares no maxConcurrent/minFreeMb, so it was NOT deployed to';
	const { findings, unreadable } = classifyDrift([entry]);
	assert.deepEqual(unreadable, []);
	assert.equal(findings.length, 1);
	assert.equal(findings[0].node, null);
});

test('a mixed array keeps findings and unreadable in their own buckets, each 1:1 with its source', () => {
	const unreachable = 'claw-1: could not be reached, so NOTHING on it was checked — ETIMEDOUT';
	const mismatch = provenanceDrift('claw-4', 'x.sh', 'b'.repeat(64), 'a'.repeat(64), '9.9.9');
	const { findings, unreadable } = classifyDrift([unreachable, mismatch]);
	assert.equal(findings.length, 1);
	assert.equal(unreadable.length, 1);
	assert.equal(findings[0].node, 'claw-4');
	assert.equal(unreadable[0].node, 'claw-1');
});
