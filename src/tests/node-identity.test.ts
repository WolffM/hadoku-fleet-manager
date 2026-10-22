/**
 * One answer to "is this node me?".
 *
 * The cases below are aimed where the guard actually looks. A test that only
 * asserted `hokon === hokon` would pass against every one of the five
 * implementations this replaced, including the three that could not survive an
 * FQDN — which is the vacuous-fixture trap the 2026-08-30 handoff describes.
 *
 * The guard that stops a SIXTH implementation appearing is structural and lives
 * in `scripts/lib/node-identity-guard.test.mjs`: it must blank comments before
 * grepping (every file here quotes the broken form in its own prose) and it must
 * read the SOURCE tree, which a test compiled into `dist/tests/` cannot do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalNode, shortNodeName } from '../lib/node-identity.js';

void test('a bare name matches itself', () => {
	assert.equal(isLocalNode('hokon', 'hokon'), true);
});

void test('an FQDN on either side still matches — the case three of five got wrong', () => {
	// The manifest spells it `hokon`; a reimaged box may introduce itself as
	// `hokon.lan`. `host === hostname()` returns false here and the caller then
	// ssh's a node that refuses ssh to itself.
	assert.equal(isLocalNode('hokon', 'hokon.lan'), true);
	assert.equal(isLocalNode('hokon.lan', 'hokon'), true);
	assert.equal(isLocalNode('hokon.lan', 'hokon.local'), true);
});

void test('case does not decide reachability', () => {
	assert.equal(isLocalNode('HOKON', 'hokon'), true);
	assert.equal(isLocalNode('Claw-1', 'claw-1'), true);
});

void test('a different node is still a different node', () => {
	assert.equal(isLocalNode('claw-1', 'claw-2'), false);
	assert.equal(isLocalNode('claw-1', 'hokon'), false);
});

void test('a shared prefix is NOT a match', () => {
	// The false-TRUE direction is the dangerous one: it runs another node's
	// script here instead of over ssh.
	assert.equal(isLocalNode('claw-1', 'claw-10'), false);
	assert.equal(isLocalNode('hokon', 'hokon-2'), false);
});

void test('normalisation is the first DNS label, lowercased', () => {
	assert.equal(shortNodeName('HOKON.Lan.Example'), 'hokon');
	assert.equal(shortNodeName('claw-3'), 'claw-3');
});
