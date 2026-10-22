import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __setHostForTesting } from '../host.js';
import {
	drainOverrides,
	drainStatus,
	isDraining,
	readDrain,
	writeDrain,
	type DrainState,
} from '../runners/drain.js';

const STATE: DrainState = {
	'claw-3': { since: '2026-09-02T06:00:00Z', reason: 'semi-annual stress test', by: 'hadoku' },
};

test('a drained node is never eligible, whatever the ladder wanted', () => {
	assert.deepEqual(drainOverrides('claw-3', true, STATE).eligible, false);
	assert.match(drainOverrides('claw-3', true, STATE).reason ?? '', /stress test/);
});

test('a drain beats even a backstop promotion', () => {
	// The backstop promotes to relieve a saturated fleet. If the alternative is
	// placing work on a machine somebody has opened, the queue waits.
	assert.equal(drainOverrides('claw-3', true, STATE).eligible, false);
});

test('a node not in the drain set is left exactly as the ladder decided', () => {
	// Both directions: drain must not accidentally PROMOTE anything either.
	assert.equal(drainOverrides('claw-1', true, STATE).eligible, true);
	assert.equal(drainOverrides('claw-1', false, STATE).eligible, false);
	assert.equal(drainOverrides('claw-1', false, STATE).reason, undefined);
});

test('DRAINING IS NOT DRAINED — the whole point of the word soft', () => {
	// Only `drained` is safe to start maintenance on.
	assert.equal(drainStatus('claw-3', 2, STATE), 'draining');
	assert.equal(drainStatus('claw-3', 0, STATE), 'drained');
	assert.equal(drainStatus('claw-1', 0, STATE), 'active');
});

test('a census that has not looked reports unknown, never drained', () => {
	// `null` is "nobody counted the running jobs". Calling that drained is how
	// somebody opens a case on a node that is mid-build.
	assert.equal(drainStatus('claw-3', null, STATE), 'unknown');
});

// ── #90: a live warm/JIT registration overrides `busy` ──────────────────────
//
// A warm listener sitting IDLE is exactly as assignable as a busy one — GitHub
// hands it work directly, without asking the dispatcher — so `busy === 0` on
// that registration is not evidence of anything safe. claw-5 read `drained`
// from a busy-process probe alone while `warm-claw-5-hadoku_site` sat there,
// idle and still live, and went on to serve 23 more jobs.

test('a live registration is `draining`, never `drained`, whatever `busy` says', () => {
	assert.equal(drainStatus('claw-3', 0, STATE, true), 'draining');
	assert.equal(drainStatus('claw-3', null, STATE, true), 'draining');
});

test('no registration falls through to the busy-only rule — the default, unchanged', () => {
	assert.equal(drainStatus('claw-3', 0, STATE, false), 'drained');
	assert.equal(drainStatus('claw-3', 2, STATE, false), 'draining');
	// The 4th argument defaults to `false`, so every caller written before it
	// existed — including every assertion above this block — reproduces
	// today's rule bit for bit.
	assert.equal(drainStatus('claw-3', 0, STATE), 'drained');
});

test('an unreadable registration listing is UNKNOWN, never drained', () => {
	// "I could not look" must never render as "nothing is there" (AGENTS.md).
	// This fails CLOSED exactly like the `busy === null` case, and takes
	// priority over `busy` even when the busy probe DID succeed — a census
	// that answered one question is not a census that answered both.
	assert.equal(drainStatus('claw-3', 0, STATE, null), 'unknown');
	assert.equal(drainStatus('claw-3', 3, STATE, null), 'unknown');
});

test('a node not in the drain set is still `active`, whatever the registration says', () => {
	// The registration check is scoped to `isDraining` exactly like `busy`
	// already was — it must never DRAIN a node on its own.
	assert.equal(drainStatus('claw-1', 0, STATE, true), 'active');
});

test('isDraining is exact, not prefix — claw-3 must not drain claw-30', () => {
	assert.equal(isDraining('claw-3', STATE), true);
	assert.equal(isDraining('claw-30', STATE), false);
	assert.equal(isDraining('claw', STATE), false);
});

// ── Where the file LIVES ────────────────────────────────────────────────────
//
// The 2026-09-04 bug was not in any rule above; every one of them was correct
// and none of them ran, because the dispatcher was reading a different file
// from the one `fleet drain` wrote. claw-5 was drained for a DRAM fault at
// 21:58Z and served jobs for the next nine hours. So the location is now
// asserted as hard as the semantics.

const HOST = (manifestDir: string, stateDir: string) =>
	({
		logger: { info() {}, warn() {}, error() {} },
		alerts: { post: async () => ({ posted: false, sinkRecorded: false }), recordQuietly() {} },
		jobs: { recordJobResult: async () => {} },
		githubToken: () => 'tok',
		manifestDir,
		stateDir,
		storeDoctorPath: '/tmp',
		cronProfilesPath: '/tmp',
	}) as never;

function withDirs(fn: (manifestDir: string, stateDir: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), 'drain-'));
	const manifestDir = join(root, 'manifest');
	const stateDir = join(root, 'state');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	__setHostForTesting(HOST(manifestDir, stateDir));
	try {
		fn(manifestDir, stateDir);
	} finally {
		__setHostForTesting(null as never);
		rmSync(root, { recursive: true, force: true });
	}
}

const doc = (node: string) =>
	`${JSON.stringify({ nodes: { [node]: { since: 's', reason: 'r', by: 'b' } } })}\n`;

test('a drain is written to the STATE dir, not into a git checkout', () => {
	withDirs((manifestDir, stateDir) => {
		writeDrain({ 'claw-5': { since: 's', reason: 'DRAM', by: 'hadoku' } });
		assert.equal(
			existsSync(join(stateDir, 'fleet-drain.json')),
			true,
			'drain must land in the state dir, which both checkouts resolve identically'
		);
		assert.equal(
			existsSync(join(manifestDir, 'fleet-drain.json')),
			false,
			'writing into the manifest dir is the bug: two checkouts, two answers'
		);
	});
});

test('a LEGACY drain in the manifest dir is still honoured', () => {
	// The upgrade must not lift a drain an operator set before the move. That
	// would un-drain a machine somebody is about to open, silently.
	withDirs((manifestDir) => {
		writeFileSync(join(manifestDir, 'fleet-drain.json'), doc('claw-5'));
		assert.equal(isDraining('claw-5', readDrain()), true);
	});
});

test('the state dir wins when both exist', () => {
	withDirs((manifestDir, stateDir) => {
		writeFileSync(join(manifestDir, 'fleet-drain.json'), doc('claw-legacy'));
		writeFileSync(join(stateDir, 'fleet-drain.json'), doc('claw-current'));
		const s = readDrain();
		assert.equal(isDraining('claw-current', s), true);
		assert.equal(isDraining('claw-legacy', s), false);
	});
});

test('writing migrates: the legacy copy is removed, so one file answers', () => {
	withDirs((manifestDir, stateDir) => {
		writeFileSync(join(manifestDir, 'fleet-drain.json'), doc('claw-5'));
		writeDrain(readDrain()); // read legacy, write new
		assert.equal(existsSync(join(manifestDir, 'fleet-drain.json')), false);
		assert.equal(isDraining('claw-5', readDrain()), true);
		assert.equal(existsSync(join(stateDir, 'fleet-drain.json')), true);
	});
});

test('neither file is an EMPTY drain, not an error', () => {
	withDirs(() => {
		assert.deepEqual(readDrain(), {});
	});
});
