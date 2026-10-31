import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
	cadenceBands,
	CADENCE_MEASURE_TIMEOUT_MS,
	cadenceSignalHandler,
	CADENCE_WAIT_TIMEOUT_MS,
	CADENCE_WORST_CASE_MS,
	dueNodes,
	runCadence,
} from './benchmark-cadence.mjs';

/**
 * THE CADENCE MAY NEVER MEASURE A GUEST (#87 §1, done-when #6). The cadence
 * picks its candidate list from `dueNodes(leadDays, null).due`, exactly like
 * `--report` does — one role split, reused rather than re-asked. This proves
 * that split still holds a guest out of `due` even when it is by far the most
 * overdue thing in the fleet, feeding `runCadence` candidates directly so the
 * property is checked at the seam the cadence actually depends on.
 *
 * `process.env` is set and restored around the call: `dueNodes` is called
 * IN-PROCESS (not through the CLI subprocess) so a plain fixture dir is enough
 * — no node is reached either way.
 */
test('dueNodes never puts a guest in the candidate list, however overdue it is', (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-benchmark-guest-test-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const manifests = join(dir, 'manifests');
	const state = join(dir, 'state');
	mkdirSync(manifests, { recursive: true });
	mkdirSync(state, { recursive: true });
	writeFileSync(
		join(manifests, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				'claw-x': { role: 'claw', cores: 4, labels: [], maxRegistrations: 4 },
				hokon: { role: 'guest', cores: 8, labels: [], maxRegistrations: 1 },
			},
		})
	);
	// Neither node has ever been measured, so both are maximally overdue —
	// the shape that would have picked the guest first if the split failed.
	const prevManifestDir = process.env.FLEET_MANIFEST_DIR;
	const prevStateDir = process.env.HADOKU_STATE_DIR;
	process.env.FLEET_MANIFEST_DIR = manifests;
	process.env.HADOKU_STATE_DIR = state;
	try {
		const { due, skippedByRole } = dueNodes(25, null);
		assert.deepEqual(
			due.map((d) => d.node),
			['claw-x']
		);
		assert.deepEqual(
			skippedByRole.map((d) => d.node),
			['hokon']
		);
		assert.equal(skippedByRole[0].role, 'guest');
	} finally {
		if (prevManifestDir === undefined) delete process.env.FLEET_MANIFEST_DIR;
		else process.env.FLEET_MANIFEST_DIR = prevManifestDir;
		if (prevStateDir === undefined) delete process.env.HADOKU_STATE_DIR;
		else process.env.HADOKU_STATE_DIR = prevStateDir;
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// `cadenceBands` — pure, no fleet, no fake ssh, no subprocess (#87 §2).
// ─────────────────────────────────────────────────────────────────────────────

test('a node at 26 days (--due 30) is an advisory; at 38 days it is a finding', () => {
	const { advisories, findings } = cadenceBands({
		due: [
			{ node: 'claw-26', ageDays: 26 },
			{ node: 'claw-38', ageDays: 38 },
		],
		measuredNode: null,
		dueDays: 30,
		graceDays: 37,
	});
	assert.deepEqual(advisories, ['benchmark due in 4d: claw-26']);
	assert.equal(findings.length, 1);
	assert.match(findings[0], /claw-38/);
	assert.doesNotMatch(advisories.join(' '), /claw-38/);
	assert.doesNotMatch(findings.join(' '), /claw-26/);
});

test('a node with NO record at all is a finding, never an advisory, inside the lead window', () => {
	const { advisories, findings } = cadenceBands({
		due: [{ node: 'claw-never', ageDays: null }],
		measuredNode: null,
		dueDays: 30,
		graceDays: 37,
	});
	assert.deepEqual(advisories, []);
	assert.match(findings[0], /claw-never/);
	assert.match(findings[0], /NEVER measured/);
});

test('the node this run just measured is left out of both the advisory and the finding list', () => {
	const { advisories, findings } = cadenceBands({
		due: [
			{ node: 'claw-just-measured', ageDays: 50 },
			{ node: 'claw-other', ageDays: 26 },
		],
		measuredNode: 'claw-just-measured',
		dueDays: 30,
		graceDays: 37,
	});
	assert.doesNotMatch([...advisories, ...findings].join(' '), /claw-just-measured/);
	assert.deepEqual(advisories, ['benchmark due in 4d: claw-other']);
});

// ─────────────────────────────────────────────────────────────────────────────
// `runCadence` — one node, drained around the measurement, always put back
// (#87 §1). Fakes track every call in `events`; no ssh, no fleet, no subprocess.
// ─────────────────────────────────────────────────────────────────────────────

/** @param {{busy?: Record<string,number>, alreadyDrained?: string[]}} [over] */
function cadenceDeps(over = {}) {
	const events = [];
	const drained = new Set(over.alreadyDrained ?? []);
	const busyByNode = over.busy ?? {};
	const deps = {
		isDrained: async (node) => {
			events.push(`isDrained ${node}`);
			if (over.isDrainedThrows) throw new Error('could not read drain state');
			return drained.has(node);
		},
		busy: async (node) => {
			events.push(`busy ${node}`);
			if (over.busyThrows?.has?.(node)) throw new Error('ssh died');
			return busyByNode[node] ?? 0;
		},
		drain: async (node, opts) => {
			events.push(`drain ${node} ${opts.kind}`);
			if (over.drainThrows) throw new Error('drain-node.mjs exploded');
			if (over.drainRefused) return { ok: false, reason: 'would leave no node able to take a job' };
			drained.add(node);
			return { ok: true };
		},
		waitDrained: async (node) => {
			events.push(`waitDrained ${node}`);
			if (over.waitThrows) throw new Error('poll died');
			if (over.neverDrains) return { drained: false, reason: 'still 1 job(s) running' };
			return { drained: true };
		},
		undrain: async (node) => {
			events.push(`undrain ${node}`);
			drained.delete(node);
			if (over.undrainFails) return { ok: false, reason: 'drain-node.mjs refused the undo' };
			return { ok: true };
		},
	};
	return { events, drained, deps };
}

const OLDEST_FIRST = [
	{ node: 'claw-oldest', ageDays: 50 },
	{ node: 'claw-older', ageDays: 40 },
	{ node: 'claw-newest', ageDays: 26 },
];

test('measures exactly the single most-overdue node, drain -> wait -> measure -> undrain, in order', async () => {
	const { events, deps } = cadenceDeps();
	const measured = [];
	const out = await runCadence({
		candidates: OLDEST_FIRST,
		deps,
		measure: async (node) => {
			measured.push(node);
			return { hostname: node };
		},
	});
	assert.equal(out.node, 'claw-oldest');
	assert.deepEqual(out.record, { hostname: 'claw-oldest' });
	assert.deepEqual(measured, ['claw-oldest'], 'exactly one node was measured');
	assert.deepEqual(
		events.filter((e) => /^(drain|waitDrained|undrain) /.test(e)),
		['drain claw-oldest training', 'waitDrained claw-oldest', 'undrain claw-oldest']
	);
	assert.ok(out.undrained, 'the measured node must be undrained');
});

test('a busy node is never picked: the next-oldest idle node is measured instead', async () => {
	const { events, deps } = cadenceDeps({ busy: { 'claw-oldest': 1 } });
	const out = await runCadence({
		candidates: OLDEST_FIRST,
		deps,
		measure: async (node) => ({ hostname: node }),
	});
	assert.equal(out.node, 'claw-older', 'the busy, more-overdue node must be skipped');
	assert.ok(
		!events.some((e) => e.startsWith('drain claw-oldest')),
		'a busy node must never be drained'
	);
	assert.ok(out.skipped.some((s) => s.node === 'claw-oldest' && /busy/.test(s.reason)));
});

test('a node already drained by someone else is skipped, not lifted, and not measured', async () => {
	const { events, deps } = cadenceDeps({ alreadyDrained: ['claw-oldest'] });
	const out = await runCadence({
		candidates: OLDEST_FIRST,
		deps,
		measure: async (node) => ({ hostname: node }),
	});
	assert.equal(out.node, 'claw-older');
	assert.ok(
		!events.some((e) => e.startsWith('drain claw-oldest') || e.startsWith('undrain claw-oldest')),
		'an operator-held node must never be touched'
	);
	assert.ok(out.skipped.some((s) => s.node === 'claw-oldest' && /not ours to lift/.test(s.reason)));
});

test('every candidate busy or already drained: nothing is measured, and nothing is drained or undrained', async () => {
	const { events, deps } = cadenceDeps({
		busy: { 'claw-oldest': 1 },
		alreadyDrained: ['claw-older', 'claw-newest'],
	});
	const out = await runCadence({
		candidates: OLDEST_FIRST,
		deps,
		measure: async () => {
			throw new Error('must never be called');
		},
	});
	assert.equal(out.node, null);
	assert.ok(!events.some((e) => /^(drain|undrain) /.test(e)));
	assert.equal(out.skipped.length, 3);
});

test('UNDRAIN IN A finally: a measurement that throws still puts the node back', async () => {
	const { events, deps } = cadenceDeps();
	const out = await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async () => {
			throw new Error('boom: the probe died mid-run');
		},
	});
	assert.equal(out.node, 'claw-oldest');
	assert.equal(out.record, null);
	assert.match(out.error, /boom: the probe died mid-run/);
	assert.ok(
		events.includes('undrain claw-oldest'),
		'a throwing measurement must still be undrained'
	);
	assert.ok(out.undrained, 'undrain must have succeeded');
});

test('a node that never settles is not measured, but is still undrained', async () => {
	const { events, deps } = cadenceDeps({ neverDrains: true });
	let measureCalled = false;
	const out = await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async () => {
			measureCalled = true;
			return {};
		},
	});
	assert.equal(
		measureCalled,
		false,
		'measuring a node that never went quiet would skew the numbers'
	);
	assert.match(out.error, /not drained in time/);
	assert.ok(events.includes('undrain claw-oldest'));
	assert.ok(out.undrained);
});

test('a failed undrain is reported, not swallowed', async () => {
	const { deps } = cadenceDeps({ undrainFails: true });
	const out = await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async () => ({ hostname: 'claw-oldest' }),
	});
	assert.equal(out.undrained, false);
	assert.match(out.undrainReason, /refused the undo/);
});

test('a drain that throws mid-flight is recovered: isDrained is checked and the node is not left stranded', async () => {
	const { events, deps } = cadenceDeps({ drainThrows: true });
	const out = await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async () => {
			throw new Error('must never be called — the drain itself failed');
		},
	});
	assert.equal(out.node, null);
	assert.ok(out.skipped.some((s) => /drain failed/.test(s.reason)));
	// `isDrained` is consulted to decide whether the failed drain landed anyway.
	assert.ok(events.includes('isDrained claw-oldest'));
});

test('a node this run cannot reach (busy check fails) is skipped, not drained', async () => {
	const { events, deps } = cadenceDeps({ busyThrows: new Set(['claw-oldest']) });
	const out = await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async () => {
			throw new Error('must never be called');
		},
	});
	assert.equal(out.node, null);
	assert.ok(!events.some((e) => e.startsWith('drain ')));
	assert.ok(out.skipped.some((s) => /could not reach it/.test(s.reason)));
});

// ─────────────────────────────────────────────────────────────────────────────
// SAFETY: a process KILL abandons `runCadence`'s own `finally`. Two layers —
// a bounded budget (so mgmt-api's own timeout is never what fires) and a
// signal handler backstop (`state.held` + `cadenceSignalHandler`) for when
// something outside this file's control kills it anyway.
// ─────────────────────────────────────────────────────────────────────────────

test('state.held names the node while it is drained, and is cleared once the undrain attempt starts', async () => {
	const { deps } = cadenceDeps();
	const state = { held: undefined };
	const seenDuringMeasure = [];
	await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async (node) => {
			seenDuringMeasure.push(state.held);
			return { hostname: node };
		},
		state,
	});
	assert.deepEqual(seenDuringMeasure, ['claw-oldest'], 'held during the measurement window');
	assert.equal(state.held, null, 'cleared once the normal undrain path is reached');
});

test('state.held is cleared even when the measurement throws — a killed process would have had the chance to see it held first', async () => {
	const { deps } = cadenceDeps();
	const state = {};
	let heldWhileThrowing;
	await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async () => {
			heldWhileThrowing = state.held;
			throw new Error('boom');
		},
		state,
	});
	assert.equal(heldWhileThrowing, 'claw-oldest');
	assert.equal(state.held, null);
});

test('state.held never names a node that was only a SKIPPED candidate (busy/drained), only the one actually drained', async () => {
	const { deps } = cadenceDeps({ busy: { 'claw-oldest': 1 } });
	const state = {};
	await runCadence({
		candidates: OLDEST_FIRST,
		deps,
		measure: async (node) => ({ hostname: node }),
		state,
	});
	// claw-oldest (busy) must never have been recorded as held; claw-older
	// (the one actually drained and measured) ends cleared, same as above.
	assert.equal(state.held, null);
});

/**
 * `cadenceSignalHandler` — the backstop for a process kill between drain and
 * undrain. `undrainSync`/`exit`/`log` are injected so this proves the LOGIC
 * without sending the test process a real signal.
 */
test('cadenceSignalHandler: a held node is undrained synchronously and the process exits non-zero naming the signal', () => {
	const calls = [];
	cadenceSignalHandler({ held: 'claw-5' }, 'SIGTERM', {
		undrainSync: (node) => calls.push(['undrain', node]),
		log: (line) => calls.push(['log', line]),
		exit: (code) => calls.push(['exit', code]),
	});
	assert.deepEqual(calls[0], ['undrain', 'claw-5']);
	assert.match(calls[1][1], /SIGTERM/);
	assert.match(calls[1][1], /claw-5/);
	assert.deepEqual(calls[2], ['exit', 1]);
});

test('cadenceSignalHandler: nothing held means no undrain call, but the process still exits', () => {
	const calls = [];
	cadenceSignalHandler({ held: null }, 'SIGINT', {
		undrainSync: (node) => calls.push(['undrain', node]),
		log: (line) => calls.push(['log', line]),
		exit: (code) => calls.push(['exit', code]),
	});
	assert.ok(!calls.some((c) => c[0] === 'undrain'), 'nothing was held; nothing to undrain');
	assert.deepEqual(calls.at(-1), ['exit', 1]);
});

test('cadenceSignalHandler: an undrain that itself fails is reported, not swallowed, and still exits', () => {
	const calls = [];
	cadenceSignalHandler({ held: 'claw-5' }, 'SIGTERM', {
		undrainSync: () => {
			throw new Error('drain-node.mjs: could not write fleet-drain.json');
		},
		log: (line) => calls.push(['log', line]),
		exit: (code) => calls.push(['exit', code]),
	});
	assert.ok(calls.some((c) => c[0] === 'log' && /FAILED to undrain/.test(c[1])));
	assert.ok(calls.some((c) => c[0] === 'log' && /fleet drain claw-5 --undo/.test(c[1])));
	assert.deepEqual(calls.at(-1), ['exit', 1]);
});

/**
 * THE ARITHMETIC (the manager's ask #1): drain-wait + measure (two attempts,
 * worst case) + the fixed busy/drain/undrain costs + margin must still fit
 * comfortably under BOTH mgmt-api's child-process timeout and the cron's own
 * `timeout_s`. The two outside figures are STATED, not imported — the manager
 * asked this file not to import a number across repos — and must be kept in
 * sync by hand with `fleet-benchmark-check.ts`'s `TIMEOUT_MS` comment and
 * `services/cron-worker/profiles.json`'s `timeout_s: 1500` in hadoku_site.
 */
test("the cadence budget fits under mgmt-api's timeout, which fits under the cron's", () => {
	const MGMT_API_TIMEOUT_MS = 20 * 60_000; // fleet-benchmark-check.ts's TIMEOUT_MS
	const CRON_TIMEOUT_MS = 1500 * 1000; // services/cron-worker/profiles.json, hadoku_site
	assert.ok(
		CADENCE_WORST_CASE_MS < MGMT_API_TIMEOUT_MS,
		`worst case ${CADENCE_WORST_CASE_MS}ms must leave margin under mgmt-api's ${MGMT_API_TIMEOUT_MS}ms`
	);
	assert.ok(
		MGMT_API_TIMEOUT_MS < CRON_TIMEOUT_MS,
		`mgmt-api's ${MGMT_API_TIMEOUT_MS}ms must itself fire before the cron's ${CRON_TIMEOUT_MS}ms`
	);
	// Sanity on the two constants this sum is built from, so a future edit to
	// either cannot silently drift from the figures named in the comment above
	// `CADENCE_WAIT_TIMEOUT_MS`.
	assert.equal(CADENCE_WAIT_TIMEOUT_MS, 5 * 60_000);
	assert.equal(CADENCE_MEASURE_TIMEOUT_MS, 4 * 60_000);
});
