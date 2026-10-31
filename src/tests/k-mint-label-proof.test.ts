/**
 * ISSUE #19's PROOF, PINNED — run against a STRIPPED manifest, by execution.
 *
 * Wave 3-prep lane K. The issue was found by reading six call sites and then
 * PROVED by running the real dispatcher against a manifest with the
 * `hadoku-builder` declarations removed:
 *
 *   declared ["hadoku-builder"] -> minted:1  mint requested
 *       ["self-hosted","Linux","X64","hadoku-builder"]  placement: claw-2
 *   stripped []                 -> minted:0 skipped:1  mint requested []
 *       placement: "does not carry self-hosted, hadoku-builder"
 *
 * This file is that experiment as a test, so the regression cannot come back
 * quietly. It deliberately uses production code the whole way down —
 * `dispatchEphemeral` builds `NodeState.labels` and `labelsFor`, the real
 * `runDispatchPass` calls the real `planTick`/`choosePlacement`, and the real
 * `mintEphemeralRunner` calls the real `mintLabels` — and fakes only GitHub and
 * the shell, at the same seams every other test in this workstream fakes.
 *
 * THE MANIFEST IS READ THROUGH `FLEET_MANIFEST_DIR`, from a scratch copy this
 * test strips, exactly as `fleet-loop.ts:1721` reads it in production. Never a
 * `__dirname` walk and never the live file.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchEphemeral } from '../runners/ephemeral-tick.js';
import type { EphemeralTickInput } from '../runners/ephemeral-shared.js';
import { runDispatchPass, __resetReapClockForTesting } from '../runners/dispatch-pass.js';
import { choosePlacement, satisfiesLabels, type NodeState } from '../runners/placement.js';
import { nodeOffer } from '../capabilities.js';
import { manifest as manifestPath } from '../lib/fleet-paths.js';
import { fakeGh, fakeShell, type GhFake, type ShellFake } from './helpers/fleet-fakes.js';
import { TMP_FREE_FLOOR_MB, WORK_FREE_FLOOR_MB } from '../runners/ephemeral.js';

/** What `vars.CI_RUNNER` resolves to on every covered repo. */
const FLEET_LABELS = ['self-hosted', 'hadoku-builder'];
const REPO = 'WolffM/hadoku-rally';

/** The five prereqs every claw on the live manifest proves. */
const PREREQS = ['ffmpeg', 'python-venv', 'python-toolcache', 'playwright', 'gh'].map((id) => ({
	id,
	detail: 'ok',
}));

let dir: string | null = null;
let savedManifestDir: string | undefined;

/**
 * Write a two-claw manifest and point `FLEET_MANIFEST_DIR` at it.
 *
 * @param declareBuilder keep the `hadoku-builder` declaration (today's fleet) or
 *        strip it (what the 2026-09-07 decision requires).
 * @param earned what bootcamp has promoted. `[]` is the live state on every claw
 *        before the producer has run.
 */
function writeManifest(declareBuilder: boolean, earned: string[]): Record<string, unknown> {
	const node = (labels: string[]) => ({
		labels,
		ephemeral: true,
		maxConcurrent: 3,
		minFreeMb: 1536,
		slice: { unitMaxMb: 4096 },
		jobP95Mb: 900,
		$capabilities: { at: '2026-09-10T00:00:00Z', by: 'fleet bootcamp', earned, prereqs: PREREQS },
	});
	const machines = {
		'claw-2': node(declareBuilder ? ['hadoku-builder'] : []),
		'claw-3': node(declareBuilder ? ['hadoku-builder', 'jit-canary'] : ['jit-canary']),
	};
	writeFileSync(
		join(dir!, 'fleet-runner-manifest.json'),
		`${JSON.stringify({ machines }, null, 2)}\n`
	);
	return machines;
}

/** The manifest as production reads it: through FLEET_MANIFEST_DIR, never a walk. */
function machinesFromManifest(): EphemeralTickInput['nodes'] {
	const raw = JSON.parse(readFileSync(manifestPath('fleet-runner-manifest.json'), 'utf8')) as {
		machines?: EphemeralTickInput['nodes'];
	};
	return raw.machines ?? {};
}

function tickInput(nodes: EphemeralTickInput['nodes']): EphemeralTickInput {
	return {
		fleetProbe: new Map([
			['claw-2', { reachable: true, busyRepos: null }],
			['claw-3', { reachable: true, busyRepos: null }],
		]),
		ephemeral: new Set(['claw-2', 'claw-3']),
		nodes,
		isSick: () => false,
		repos: [REPO],
		// Nothing standing can take the job — the all-JIT fleet's normal state, and
		// it removes the age gate so the pass does not depend on wall-clock.
		standingEligible: new Set(),
	};
}

/** One queued job asking for exactly what `vars.CI_RUNNER` resolves to. */
const PENDING = [
	{
		id: 9001,
		jobId: 77,
		repo: REPO,
		labels: FLEET_LABELS,
		repository: { full_name: REPO },
		head_repository: { full_name: REPO, fork: false },
		event: 'push',
	},
];

/**
 * Run one dispatch through production's own glue.
 *
 * The `run` seam is the ONE thing injected: it forwards to the real
 * `runDispatchPass` with an explicit `pending`, instead of letting
 * `runDispatchTick` poll GitHub for it. Everything the substitution touches —
 * `NodeState.labels` and `labelsFor`, both built inside `dispatchEphemeral` — is
 * production code, and so is every decision downstream of it.
 */
/** #101: free MB this fixture answers for the `df -Pm` tail of the space
 * probe — comfortably clear of `TMP_FREE_FLOOR_MB`/`WORK_FREE_FLOOR_MB` so
 * this file's label-proof assertions never trip the space clause instead. */
const SPACE_FREE_MB = Math.max(TMP_FREE_FLOOR_MB, WORK_FREE_FLOOR_MB) * 4;

/**
 * The shared `fakeShell` predates the `df -Pm` tail `dispatchEphemeral` now
 * appends to its `free -m` probes (#101) and answers only the first line.
 * Wrap it locally rather than editing the shared helper: append two
 * comfortably-free lines whenever the combined command carries `df -Pm`.
 */
function spaceOkShell(): ShellFake {
	const base = fakeShell();
	return async (node: string, cmd: string): Promise<string | null> => {
		const out = await base(node, cmd);
		if (out === null || !cmd.includes('df -Pm')) return out;
		// #101: trailing newline, the way `execFile`'s real stdout always has
		// one.
		return `${out}\n${SPACE_FREE_MB}\n${SPACE_FREE_MB}\n`;
	};
}

async function dispatchOnce(nodes: EphemeralTickInput['nodes'], gh: GhFake) {
	const sh = spaceOkShell();
	return await dispatchEphemeral(tickInput(nodes), 'tok', gh, sh, async (inp, token, g, s) =>
		runDispatchPass({ ...inp, pending: PENDING, tarballUrl: null }, token, g, s)
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'k-mint-proof-'));
	savedManifestDir = process.env.FLEET_MANIFEST_DIR;
	process.env.FLEET_MANIFEST_DIR = dir;
	__resetReapClockForTesting();
});

afterEach(() => {
	if (savedManifestDir === undefined) delete process.env.FLEET_MANIFEST_DIR;
	else process.env.FLEET_MANIFEST_DIR = savedManifestDir;
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = null;
});

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

test('#19: a STRIPPED manifest still mints hadoku-builder — minted:1, and the mint requested it', async () => {
	// The eight declarations are gone from the manifest and bootcamp has promoted.
	// Before this lane, this is the run that produced `minted:0 skipped:1` and
	// `mint requested []` while `fleet label-floor` exited 0.
	writeManifest(false, [...PREREQS.map((p) => p.id), 'jitconfig']);
	const gh = fakeGh({});
	const res = await dispatchOnce(machinesFromManifest(), gh);

	assert.equal(res?.minted, 1, 'one queued job, one mint');
	assert.equal(res?.skipped, 0, 'nothing may be skipped for want of a label');
	// THE MINT'S LABELS, as they reached generate-jitconfig. `mintLabels` adds the
	// three implicit ones because `generate-jitconfig` adds nothing itself.
	assert.deepEqual(gh.mintedLabels, [
		'self-hosted',
		'Linux',
		'X64',
		'jit-canary',
		'hadoku-builder',
	]);
	assert.ok(
		satisfiesLabels(gh.mintedLabels, FLEET_LABELS),
		'the minted runner must satisfy what vars.CI_RUNNER asks for'
	);
});

test('#19: placement ACCEPTS the node whose offer is derived from a stripped manifest', async () => {
	// `placement.ts:287` refuses a node whose labels do not satisfy the job, so
	// the fleet breaks one step BEFORE the mint. Asserted through the real
	// `choosePlacement`, on the same derived offer `dispatchEphemeral` builds.
	writeManifest(false, [...PREREQS.map((p) => p.id)]);
	const machines = machinesFromManifest();
	const nodes: NodeState[] = Object.keys(machines).map((name) => ({
		name,
		healthy: true,
		eligible: true,
		labels: nodeOffer(machines[name], { eligible: true }),
		liveUnits: 0,
		standingBusy: 0,
		maxConcurrent: 3,
		freeMb: 9000,
		requiredMb: 900,
		minFreeMb: 1536,
	}));
	const placed = choosePlacement(['claw-2', 'claw-3'], nodes, FLEET_LABELS);
	assert.equal(placed.node, 'claw-2');
	assert.deepEqual(
		placed.passed.filter((p) => /does not carry/.test(p.reason)),
		[],
		'no node may be refused for want of a label it has proven'
	);
});

test('#19: the DECLARED manifest mints exactly the same set — the substitution is a no-op first', async () => {
	// K2 may land before the strip does, so the derived offer has to reproduce
	// today's fleet byte for byte. `earned: []` here is the live state on every
	// claw: the producer has not run yet.
	writeManifest(true, []);
	const gh = fakeGh({});
	const res = await dispatchOnce(machinesFromManifest(), gh);
	assert.equal(res?.minted, 1);
	assert.deepEqual(gh.mintedLabels, [
		'self-hosted',
		'Linux',
		'X64',
		'jit-canary',
		'hadoku-builder',
	]);
});

test('#19: a stripped manifest with `earned` still EMPTY also mints — no dark-fleet window', async () => {
	// Eligibility is the dispatcher's answer, not a derivation from `earned`, so
	// the two halves of this wave have no ordering cliff between them. The gate's
	// RED condition still needs the producer; the MINT does not.
	writeManifest(false, []);
	const gh = fakeGh({});
	const res = await dispatchOnce(machinesFromManifest(), gh);
	assert.equal(res?.minted, 1);
	assert.deepEqual(gh.mintedLabels, [
		'self-hosted',
		'Linux',
		'X64',
		'jit-canary',
		'hadoku-builder',
	]);
});

test('the canary label rides on EVERY ephemeral claw, derived — not on whichever one declared it', async () => {
	// `jit-canary` is `verify: 'mint'` — no probe can settle it — and what it
	// asserts ("this node mints a runner per job") is the ephemeral fact itself,
	// so it is derived from that fact. It used to ride on claw-3 alone, because
	// only claw-3 declared it, and the hourly canary proved one claw of eight.
	writeManifest(false, [...PREREQS.map((p) => p.id)]);
	const machines = machinesFromManifest();
	assert.deepEqual(nodeOffer(machines['claw-3'], { eligible: true }), [
		'jit-canary',
		'hadoku-builder',
	]);
	assert.deepEqual(nodeOffer(machines['claw-2'], { eligible: true }), [
		'jit-canary',
		'hadoku-builder',
	]);
});

test('#19: an unreadable scratch manifest is "could not look", never a mint with no labels', async () => {
	// The direction every failure in this workstream takes. An empty machines map
	// means no node is ephemeral-and-reachable, so the pass declines rather than
	// minting a runner nothing can route to.
	writeFileSync(join(dir!, 'fleet-runner-manifest.json'), '{}\n');
	const gh = fakeGh({});
	const res = await dispatchOnce(machinesFromManifest(), gh);
	assert.equal(res, null, 'null is COULD NOT LOOK, distinct from a zeroed result');
	assert.deepEqual(gh.mintedLabels, []);
});
