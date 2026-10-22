import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	canaryPlan,
	MEASURE_DRAIN_REASON_PREFIX,
	OWN_DRAIN_REASON_PREFIX,
	proofDrainState,
	underIdleHold,
} from './proof-drain.mjs';

const own = { kind: 'training', reason: `${OWN_DRAIN_REASON_PREFIX} jdk21 workload canary` };

test('a busy node is drained and waited for, never skipped (claw-4/8/9 on 2026-10-08)', () => {
	assert.deepEqual(canaryPlan({ alreadyDrained: false, busy: 2 }), { action: 'drain' });
	assert.deepEqual(canaryPlan({ alreadyDrained: false, busy: 0 }), { action: 'drain' });
});

test('someone else’s drain, or an unreachable node, is still a skip', () => {
	assert.equal(canaryPlan({ alreadyDrained: true, busy: 0 }).action, 'skip');
	assert.equal(canaryPlan({ alreadyDrained: false, busy: null }).action, 'skip');
});

test('under its own canary drain, prove-job sees the node as undrained and can mint', () => {
	assert.deepEqual(proofDrainState(own, true), { drained: false });
});

test('without the flag, any drain still refuses the mint', () => {
	assert.deepEqual(proofDrainState(own, false), { drained: true });
	assert.deepEqual(proofDrainState(undefined, false), { drained: false });
});

test('the flag is a claim the drain file must back, not a bypass', () => {
	const maint = { kind: 'maintenance', reason: 'semi-annual stress test' };
	assert.ok('error' in proofDrainState(maint, true), 'a maintenance drain is not ours');
	assert.ok(
		'error' in proofDrainState({ kind: 'training', reason: 'fleet benchmark' }, true),
		'another training drain is not ours'
	);
	assert.ok(
		'error' in proofDrainState(undefined, true),
		'no drain at all: the canary is unprotected'
	);
});

// The live drain → prove-job path cannot run in a fixture (it drains a real
// node over ssh), so the two links that make it work are guarded at the
// source: bootcamp passes the flag, and drains with the reason the flag checks.
test('bootcamp passes --under-own-drain and drains with the reason prove-job accepts', async () => {
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(new URL('../bootcamp.mjs', import.meta.url), 'utf8');
	assert.match(src, /PROVE_JOB_SCRIPT,[^\]]*'--under-own-drain'/);
	assert.match(src, /reason: `\$\{OWN_DRAIN_REASON_PREFIX\} \$\{id\} workload canary`/);
	assert.match(src, /canaryPlan\(\{ alreadyDrained, busy \}\)/);
});

// ── underIdleHold: the drain around an IDLE-ONLY measurement (2026-10-10) ────

/** Fake drain deps that log every call; `over` replaces any of them. */
function fakeDeps(over = {}) {
	const log = [];
	const held = { value: false };
	const deps = {
		isDrained: () => {
			log.push('isDrained');
			return held.value;
		},
		drain: (node, o) => {
			log.push(`drain ${o.kind} ${o.reason}`);
			held.value = true;
			return { ok: true };
		},
		undrain: () => {
			log.push('undrain');
			held.value = false;
			return { ok: true };
		},
		waitQuiet: async () => {
			log.push('wait');
			return { drained: true };
		},
		...over,
	};
	return { deps, log, held };
}

test('idle hold: drain → wait → measure → undrain, with a reason prove-job will NOT accept', async () => {
	const { deps, log } = fakeDeps();
	const state = {};
	const seen = [];
	const r = await underIdleHold(
		'claw-4',
		['cargo-bevy'],
		deps,
		async () => {
			seen.push(state.held);
			return 'reading';
		},
		state
	);
	assert.deepEqual(r, { status: 'measured', result: 'reading', heldBy: 'bootcamp' });
	assert.deepEqual(log, [
		'isDrained',
		`drain training ${MEASURE_DRAIN_REASON_PREFIX} cargo-bevy (returns when measured)`,
		'wait',
		'undrain',
	]);
	assert.deepEqual(seen, ['claw-4'], 'a signal handler must know the node is held mid-measure');
	assert.equal(state.held, null);
	// A measurement drain is not a canary drain: prove-job must refuse to mint under it.
	const row = { kind: 'training', reason: `${MEASURE_DRAIN_REASON_PREFIX} cargo-bevy` };
	assert.ok('error' in proofDrainState(row, true));
});

test('idle hold: a node that never goes quiet is inconclusive, NOTHING is measured, and it is undrained', async () => {
	const { deps, log } = fakeDeps({
		waitQuiet: async () => ({ drained: false, reason: '1 job(s) running' }),
	});
	let measured = false;
	const r = await underIdleHold('claw-6', ['cargo-bevy'], deps, async () => {
		measured = true;
	});
	assert.equal(r.status, 'inconclusive');
	assert.match(r.reason, /never went quiet: 1 job\(s\) running/);
	assert.equal(measured, false);
	assert.equal(log.at(-1), 'undrain');
});

test('idle hold: a measurement that THROWS still undrains', async () => {
	const { deps, held } = fakeDeps();
	await assert.rejects(
		underIdleHold('claw-1', ['cargo-bevy'], deps, async () => {
			throw new Error('probe exploded');
		}),
		/probe exploded/
	);
	assert.equal(held.value, false, 'the node was left drained');
});

test("idle hold: someone else's drain is never written over and never lifted", async () => {
	const { deps, log, held } = fakeDeps();
	held.value = true;
	const r = await underIdleHold('claw-2', ['cargo-bevy'], deps, async () => 'reading');
	assert.deepEqual(r, { status: 'measured', result: 'reading', heldBy: 'someone-else' });
	assert.deepEqual(log, ['isDrained', 'wait']);
	assert.equal(held.value, true);
});

test("idle hold: under someone else's drain, a node that never goes quiet is inconclusive", async () => {
	const { deps, held } = fakeDeps({ waitQuiet: async () => ({ drained: false }) });
	held.value = true;
	const r = await underIdleHold('claw-2', ['cargo-bevy'], deps, async () => 'reading');
	assert.equal(r.status, 'inconclusive');
	assert.match(r.reason, /someone else's drain/);
	assert.equal(held.value, true);
});

test('idle hold: an unreadable drain state is inconclusive, and nothing is written', async () => {
	const { deps, log } = fakeDeps({
		isDrained: () => {
			throw new Error('Unexpected token } in JSON');
		},
	});
	const r = await underIdleHold('claw-3', ['cargo-bevy'], deps, async () => 'reading');
	assert.equal(r.status, 'inconclusive');
	assert.match(r.reason, /could not read the drain state: Unexpected token/);
	assert.deepEqual(log, []);
});

test('idle hold: a refused drain is inconclusive; a drain that THREW after landing is undone', async () => {
	const refused = fakeDeps({ drain: () => ({ ok: false, reason: 'would leave NO node' }) });
	const r1 = await underIdleHold('claw-5', ['cargo-bevy'], refused.deps, async () => 'reading');
	assert.deepEqual(r1, { status: 'inconclusive', reason: 'drain refused: would leave NO node' });
	assert.ok(!refused.log.includes('undrain'), 'nothing landed, so nothing to undo');

	const landed = fakeDeps();
	landed.deps.drain = () => {
		landed.held.value = true;
		throw new Error('timed out after the write');
	};
	const r2 = await underIdleHold('claw-5', ['cargo-bevy'], landed.deps, async () => 'reading');
	assert.equal(r2.status, 'inconclusive');
	assert.equal(landed.held.value, false, 'a drain that landed before failing was left in place');
});

test('idle hold: an undrain that fails is RETURNED, never swallowed', async () => {
	const { deps } = fakeDeps({ undrain: () => ({ ok: false, reason: 'state dir read-only' }) });
	const r = await underIdleHold('claw-7', ['cargo-bevy'], deps, async () => 'reading');
	assert.equal(r.status, 'measured');
	assert.equal(r.undrainFailed, 'state dir read-only');
	const thrown = fakeDeps({
		undrain: () => {
			throw new Error('EACCES');
		},
		waitQuiet: async () => ({ drained: false }),
	});
	const r2 = await underIdleHold('claw-7', ['cargo-bevy'], thrown.deps, async () => 'reading');
	assert.equal(r2.undrainFailed, 'EACCES');
});
