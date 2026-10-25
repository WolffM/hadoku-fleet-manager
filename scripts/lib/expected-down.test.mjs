/**
 * The deferral must be NARROW. Every test here is a case that must still FAIL,
 * except the one that must not.
 *
 * The rule being protected is CLAUDE.md's: no gate may get easier to pass the
 * worse the failure gets. A deferral is a hole in a reachability gate, so each
 * edge of the hole is pinned.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DEFER_DAYS, deferralFor } from './expected-down.mjs';

const NOW = Date.parse('2026-09-09T21:00:00Z');
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();

test('a node drained for maintenance today is deferred', () => {
	const d = deferralFor(
		'claw-8',
		{ 'claw-8': { since: ago(0), kind: 'maintenance', reason: 'cooler dead' } },
		NOW
	);
	assert.equal(d.deferred, true);
	assert.match(d.why, /maintenance/);
});

test('a node that was never drained still FAILS', () => {
	const d = deferralFor('claw-4', { 'claw-8': { since: ago(0), kind: 'maintenance' } }, NOW);
	assert.equal(
		d.deferred,
		false,
		'an undrained machine vanishing is the case this gate exists for'
	);
	assert.match(d.why, /not drained/);
});

test("a node drained as 'training' still FAILS — bootcamp nodes are meant to be RUNNING", () => {
	const d = deferralFor('claw-8', { 'claw-8': { since: ago(0), kind: 'training' } }, NOW);
	assert.equal(d.deferred, false);
	assert.match(d.why, /training/);
});

test('a drain with no parseable `since` FAILS — an unbounded deferral is a silencer', () => {
	for (const since of [undefined, '', 'yesterday', null]) {
		const d = deferralFor('claw-8', { 'claw-8': { since, kind: 'maintenance' } }, NOW);
		assert.equal(d.deferred, false, `since=${JSON.stringify(since)} must not defer`);
		assert.match(d.why, /cannot be bounded/);
	}
});

test('the deferral EXPIRES — time makes the gate stricter, never more forgiving', () => {
	const inside = deferralFor(
		'claw-8',
		{ 'claw-8': { since: ago(DEFER_DAYS - 1), kind: 'maintenance' } },
		NOW
	);
	assert.equal(inside.deferred, true, `${DEFER_DAYS - 1}d is inside the window`);

	const outside = deferralFor(
		'claw-8',
		{ 'claw-8': { since: ago(DEFER_DAYS + 1), kind: 'maintenance' } },
		NOW
	);
	assert.equal(outside.deferred, false, `${DEFER_DAYS + 1}d must fail again`);
	assert.match(outside.why, /is it coming back/);
	assert.match(outside.why, new RegExp(`${DEFER_DAYS}-day`));
});

test('kind defaults to maintenance, matching drain-node.mjs', () => {
	const d = deferralFor('claw-8', { 'claw-8': { since: ago(0) } }, NOW);
	assert.equal(d.deferred, true);
	assert.equal(d.kind, 'maintenance');
});

test('a non-deferred drain says WHY, so it never looks like a node that was never drained', () => {
	const training = deferralFor('claw-8', { 'claw-8': { since: ago(0), kind: 'training' } }, NOW);
	const never = deferralFor('claw-9', {}, NOW);
	assert.notEqual(training.why, never.why, 'the two must be distinguishable in a finding');
});

test('an empty or missing drain map defers nothing', () => {
	for (const drains of [undefined, null, {}]) {
		assert.equal(deferralFor('claw-8', drains, NOW).deferred, false);
	}
});

/**
 * THE WIRING ITSELF. A deferral helper nothing calls is worse than none: the
 * gates go red, someone concludes the feature does not work, and the next fix
 * is to widen the helper rather than to reconnect it.
 *
 * These are the four gates that fail on an unreachable node. If a fifth is
 * added it will not be caught here — but these four cannot be silently
 * unhooked, which is the regression that actually happens on a refactor.
 */
import { readFileSync as _read } from 'node:fs';
import { dirname as _dir, resolve as _res } from 'node:path';
import { fileURLToPath as _f2u } from 'node:url';

const SCRIPTS = _res(_dir(_f2u(import.meta.url)), '..');

for (const f of [
	'check-fleet-toolchain.mjs',
	'check-fleet-preflight.mjs',
	'deploy-ci-throttle.mjs',
	'deploy-runners-slice.mjs',
	'bootcamp.mjs',
	'check-capabilities.mjs',
	'reconcile-runner-identity.mjs',
]) {
	test(`${f} consults the drain record before failing on an unreachable node`, () => {
		const src = _read(_res(SCRIPTS, f), 'utf8');
		assert.match(
			src,
			/from '\.\/lib\/expected-down\.mjs'/,
			`${f} fails on unreachable nodes but no longer asks whether the node is down ON PURPOSE`
		);
		assert.match(src, /deferralFor\(/, `${f} imports the helper but never calls it`);
	});
}

test('a node drained as a REBOOT is deferred — briefly down is the expected state', () => {
	const drains = {
		'claw-6': { kind: 'reboot', since: new Date().toISOString(), reason: 'automated reboot: x' },
	};
	const d = deferralFor('claw-6', drains);
	assert.equal(d.deferred, true);
	assert.match(d.why, /rebooting: automated reboot/);
});
