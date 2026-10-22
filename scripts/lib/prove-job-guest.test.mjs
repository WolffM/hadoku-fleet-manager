/**
 * The CLI-side guest layers of `fleet prove-job`: the transport that never
 * reaches a guest, and the post-check that names a guest run as a bug. Each is
 * executable here; in a real process the library has already refused first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { guestGate, runOn } from './fleet-exec.mjs';
import { guestPostCheck, proofShell } from './prove-job-guest.mjs';

const GUEST = 'fixture-guest.invalid';
const CLAW = 'fixture-claw.invalid';
const isGuest = (n) => n === GUEST;

test('proofShell never calls the transport for a guest, and records that it was asked', async () => {
	const calls = [];
	const shell = proofShell({
		runOn: async (...a) => {
			calls.push(a);
			return { ok: true, stdout: 'REACHABLE\n' };
		},
		isGuest,
	});
	assert.equal(await shell.sh(GUEST, 'echo REACHABLE'), null);
	assert.deepEqual(calls, [], 'the transport was not reached for the guest');
	assert.deepEqual(shell.guestReached, [GUEST]);
	assert.equal(await shell.sh(CLAW, 'echo REACHABLE'), 'REACHABLE\n');
	assert.equal(calls.length, 1);
});

test('proofShell arms the transport gate with an EMPTY argv, so --include-guests on the command line cannot open it', async () => {
	const seen = [];
	const shell = proofShell({
		runOn: async (_n, _c, opts) => {
			seen.push(opts);
			return { ok: false, stdout: '' };
		},
		isGuest,
	});
	await shell.sh(CLAW, 'true');
	assert.equal(seen[0].includeGuests, false);
	assert.deepEqual(seen[0].argv, []);

	// Why the empty argv is load-bearing: the REAL transport honours
	// `--include-guests` read from argv when it is not given one.
	const manifest = { machines: { [GUEST]: { role: 'guest' } } };
	const closed = await runOn(GUEST, 'true', { includeGuests: false, argv: [], manifest });
	assert.equal(closed.ok, false, 'closed with an empty argv');
	assert.equal(closed.skippedByRole, 'guest');
	// Asked of the gate itself, so nothing is ever spawned toward the fixture host.
	assert.equal(
		guestGate(GUEST, { includeGuests: false, argv: ['--include-guests'], manifest }).skip,
		false,
		'the flag on argv opens the gate — which is why prove-job never lets it reach it'
	);
});

test('guestPostCheck: a guest not refused WITHOUT the opt-in is a bug', () => {
	const f = guestPostCheck(
		{ verdict: 'pass', mode: 'jit' },
		{ isGuest: true, includeGuests: false, guestReached: [] }
	);
	assert.deepEqual(f, [
		{ rule: 'guest', message: 'a guest was proven without the opt-in — this is a bug' },
	]);
	assert.deepEqual(
		guestPostCheck(
			{ verdict: 'refused', mode: 'jit' },
			{ isGuest: true, includeGuests: false, guestReached: [] }
		),
		[]
	);
});

test('guestPostCheck: with the opt-in, only a STANDING proof of a guest is clean', () => {
	assert.deepEqual(
		guestPostCheck(
			{ verdict: 'pass', mode: 'standing' },
			{ isGuest: true, includeGuests: true, guestReached: [] }
		),
		[]
	);
	const jit = guestPostCheck(
		{ verdict: 'fail', mode: 'jit' },
		{ isGuest: true, includeGuests: true, guestReached: [] }
	);
	assert.equal(jit.length, 1);
	assert.match(jit[0].message, /other than its standing runner/);
});

test('guestPostCheck: a transport asked to reach a guest is a bug, whatever the verdict', () => {
	const f = guestPostCheck(
		{ verdict: 'pass', mode: 'standing' },
		{ isGuest: true, includeGuests: true, guestReached: [GUEST, GUEST] }
	);
	assert.equal(f.length, 1);
	assert.match(f[0].message, new RegExp(`reach a guest \\(${GUEST.replace(/\./g, '\\.')}\\)`));
	assert.deepEqual(
		guestPostCheck(
			{ verdict: 'pass', mode: 'jit' },
			{ isGuest: false, includeGuests: false, guestReached: [] }
		),
		[],
		'a claw is not this module’s business'
	);
});
