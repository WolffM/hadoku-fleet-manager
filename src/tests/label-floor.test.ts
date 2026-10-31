/**
 * The label floor's one model, pure (`src/label-floor.ts`). runner-health's
 * tick-level tests drive the same functions end to end; these pin each
 * verdict on its own so a regression names the rule it broke.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	buildMintView,
	floorLabels,
	isFloorDemandLabel,
	isHostedLabel,
	judgeJobMint,
	judgeLabelFloor,
	observedFloorDemand,
	PROOF_LABEL_RE,
	type MintingNode,
	type MintView,
} from '../label-floor.js';
import { workloadGateContext, type ManifestNode } from '../capabilities.js';
import { proofLabel } from '../runners/prove-job.js';
import type { ProofRecord } from '../lib/measured.js';

const node = (over: Partial<MintingNode> = {}): MintingNode => ({
	name: 'claw-4',
	offers: ['hadoku-builder', 'jdk21'],
	drained: false,
	sick: false,
	excluded: false,
	probe: { reachable: true, sick: false },
	...over,
});
const view = (nodes: MintingNode[], measured = true): MintView => ({ measured, nodes });

test('a standing online runner serves a label whatever the minting half says', () => {
	assert.deepEqual(judgeLabelFloor('pm2-host', 1, view([], false)), {
		state: 'standing',
		count: 1,
	});
});

test('a label served ONLY by an eligible minting node is served', () => {
	assert.deepEqual(judgeLabelFloor('jdk21', 0, view([node()])), {
		state: 'minting',
		nodes: ['claw-4'],
	});
});

test('no standing runner and no minting offerer is unserved, and says so', () => {
	const v = judgeLabelFloor('av1-nvenc', 0, view([node()]));
	assert.equal(v.state, 'unserved');
	assert.match((v as { why: string }).why, /no minting node offers it/);
});

test('every minting offerer drained, sick or excluded is unserved, naming each and why', () => {
	const v = judgeLabelFloor(
		'jdk21',
		0,
		view([
			node({ name: 'claw-4', drained: true }),
			node({ name: 'claw-8', sick: true }),
			node({ name: 'claw-9', excluded: true }),
		])
	);
	assert.equal(v.state, 'unserved');
	const why = (v as { why: string }).why;
	assert.match(why, /claw-4 \(drained\)/);
	assert.match(why, /claw-8 \(sick\)/);
	assert.match(why, /claw-9 \(excluded\)/);
});

test('UNMEASURED holds: an undrained offerer with no probe yet is neither served nor unserved', () => {
	assert.deepEqual(judgeLabelFloor('jdk21', 0, view([node({ probe: undefined })], false)), {
		state: 'unmeasured',
		nodes: ['claw-4'],
	});
});

test('unmeasured does not rescue a label whose every offerer is drained — that is known without a probe', () => {
	const v = judgeLabelFloor('jdk21', 0, view([node({ drained: true, probe: undefined })], false));
	assert.equal(v.state, 'unserved');
});

test('measured and every offerer unreachable or probe-sick is unserved; a node absent from the probe is down', () => {
	for (const probe of [{ reachable: false }, { reachable: true, sick: true }, undefined]) {
		const v = judgeLabelFloor('jdk21', 0, view([node({ probe })]));
		assert.equal(v.state, 'unserved', JSON.stringify(probe));
	}
});

// ---------------------------------------------------------------------------
// buildMintView — the dispatcher's own answer, workload gate included
// ---------------------------------------------------------------------------

const earnedJdk: ManifestNode = {
	ephemeral: true,
	$capabilities: {
		at: new Date().toISOString(),
		by: 'fleet bootcamp',
		declared: [],
		earned: ['jdk21'],
		blocked: [],
		unprobed: [],
		prereqs: [],
	},
};
const proof = (n: string, verdict: ProofRecord['verdict']): ProofRecord => ({
	node: n,
	capability: 'jdk21',
	runId: 1,
	runner: null,
	conclusion: 'success',
	durationSec: 300,
	evidenceMatched: true,
	budgetSec: null,
	verdict,
	why: verdict,
	at: new Date().toISOString(),
});

test('buildMintView: a claw whose jdk21 workload proof is STALE does not offer it', () => {
	const machines = { 'claw-4': earnedJdk, 'claw-8': earnedJdk, 'claw-9': earnedJdk };
	const gate = workloadGateContext(Object.keys(machines), {
		jdk21: [proof('claw-8', 'pass'), proof('claw-9', 'pass'), proof('claw-4', 'stale')],
	});
	const v = buildMintView({
		machines,
		gate,
		drained: new Set(),
		isSick: () => false,
		probe: { nodes: { 'claw-4': { reachable: true } } },
	});
	assert.ok(!v.nodes.find((n) => n.name === 'claw-4')!.offers.includes('jdk21'));
	assert.ok(v.nodes.find((n) => n.name === 'claw-8')!.offers.includes('jdk21'));
	assert.equal(judgeLabelFloor('jdk21', 0, v).state, 'unserved', 'claw-8/9 offer it but are down');
});

test('buildMintView: only ephemeral nodes mint — a standing guest is arm (a), not arm (b)', () => {
	const v = buildMintView({
		machines: { hokon: { ...earnedJdk, ephemeral: undefined, role: 'guest' }, 'claw-4': earnedJdk },
		gate: workloadGateContext(['hokon', 'claw-4'], {}),
		drained: new Set(['claw-4']),
		isSick: () => false,
		probe: null,
	});
	assert.deepEqual(
		v.nodes.map((n) => [n.name, n.drained]),
		[['claw-4', true]]
	);
	assert.equal(v.measured, false, 'no probe is UNMEASURED, not an empty reading');
});

test('buildMintView, #120: an ON-DEMAND guest mints its own labels always, hadoku-builder only while held', () => {
	const hokon = {
		...earnedJdk,
		ephemeral: undefined,
		role: 'guest',
		mint: 'on-demand',
		labels: ['taskauto'],
	};
	const view = (held: boolean) =>
		buildMintView({
			machines: { hokon },
			gate: workloadGateContext(['hokon'], {}),
			drained: new Set(),
			isSick: () => false,
			probe: { nodes: { hokon: { reachable: true } } },
			held: () => held,
		});
	const unheld = view(false).nodes.find((n) => n.name === 'hokon')!;
	assert.ok(
		unheld.offers.includes('taskauto'),
		'its standing runners are gone, so a mint serves it'
	);
	assert.equal(
		unheld.offers.includes('hadoku-builder'),
		false,
		"general CI is the backstop's to grant"
	);
	assert.equal(judgeLabelFloor('taskauto', 0, view(false)).state, 'minting');
	assert.ok(
		view(true)
			.nodes.find((n) => n.name === 'hokon')!
			.offers.includes('hadoku-builder')
	);
});

// ---------------------------------------------------------------------------
// Demand
// ---------------------------------------------------------------------------

test('demand excludes implicit labels (any case) and hosted images, and nothing else', () => {
	for (const l of [
		'self-hosted',
		'Linux',
		'X64',
		'ubuntu-latest',
		'ubuntu-24.04',
		'macos-14',
		'windows-2022',
	]) {
		assert.equal(isFloorDemandLabel(l), false, l);
	}
	for (const l of ['hadoku-builder', 'jdk21', 'cargo-bevy', 'docker']) {
		assert.equal(isFloorDemandLabel(l), true, l);
	}
});

/**
 * F13 (plan §4.1): the CANONICAL hosted-label predicate, exported so
 * `runner-health.ts` and (via the compiled `dist/label-floor.js`)
 * `scripts/lib/runs-on-demand.mjs` can both drop their own copy.
 *
 * A bare `ubuntu`/`macos`/`windows` — no `-` at all — is the case
 * `runner-health.ts`'s OWN former copy missed (5a, §8.3): its regex required
 * a dash and at least one character after it
 * (`/^(ubuntu|windows|macos)-[\w.]+$/`), so `isHostedLabel('ubuntu')` read
 * `false` there while this file's own (unexported) `HOSTED_PREFIX` already
 * covered it. Pinned here on the canonical export so the gap cannot reopen
 * in whichever copy survives.
 */
test('isHostedLabel: a bare ubuntu/macos/windows with no dash is still hosted', () => {
	for (const l of ['ubuntu', 'macos', 'windows']) assert.ok(isHostedLabel(l), l);
	for (const l of ['ubuntu-latest', 'ubuntu-24.04', 'windows-2022', 'macos-14']) {
		assert.ok(isHostedLabel(l), l);
	}
	for (const l of ['hadoku-builder', 'jdk21', 'cargo-bevy', 'ubuntuish']) {
		assert.ok(!isHostedLabel(l), l);
	}
});

test('floorLabels keeps a demanded label NO capability registers — it is still a routing dependency', () => {
	assert.deepEqual(floorLabels(['self-hosted', 'jdk21', 'docker', 'jdk21']), ['docker', 'jdk21']);
});

test('observed demand: the retention window and proof canaries bound it', () => {
	const now = Date.now();
	const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
	const got = observedFloorDemand(
		[
			{ runner: 'claw-4', labels: ['self-hosted', 'jdk21'], startedAt: iso(60_000) },
			{ runner: 'claw-4', labels: ['self-hosted', 'old-label'], startedAt: iso(30 * 86_400_000) },
			{ runner: 'jit-claw-4-proof-x', labels: ['proof-abc'], startedAt: iso(60_000) },
		],
		{ sinceIso: iso(14 * 86_400_000), isProof: (r) => r.includes('-proof-') }
	);
	assert.deepEqual([...got], ['jdk21']);
});

test('a standing-mode proof (runner = the node itself) is not demand: matched by its proof label', () => {
	// 2026-10-10: hokon's jdk21 proof ran on registration `hokon`, so the
	// runner-name filter missed it and the floor paged for `proof-mv334990`.
	const now = Date.now();
	const got = observedFloorDemand(
		[
			{
				runner: 'hokon',
				labels: ['self-hosted', proofLabel(now)],
				startedAt: new Date(now).toISOString(),
			},
			{ runner: 'hokon', labels: ['self-hosted', 'jdk21'], startedAt: new Date(now).toISOString() },
		],
		{ sinceIso: new Date(now - 60_000).toISOString(), isProof: () => false }
	);
	assert.deepEqual([...got], ['jdk21']);
	assert.equal(isFloorDemandLabel(proofLabel(now)), false, 'the static half drops it too');
	assert.match(proofLabel(now), PROOF_LABEL_RE, 'pinned to the label prove-job actually mints');
});

test('a JOB needs one node offering every label it asks for — offers on two nodes do not add up (#110)', () => {
	const fleet = view([
		node({ name: 'claw-3', offers: ['hadoku-builder', 'jdk21'] }),
		node({ name: 'claw-8', offers: ['hadoku-builder', 'claw-8'] }),
	]);
	assert.deepEqual(judgeJobMint(['self-hosted', 'jdk21', 'claw-8'], fleet), {
		state: 'unserved',
		why: 'no standing runner of this repo can take it and no minting node offers it',
	});
	assert.deepEqual(judgeJobMint(['self-hosted', 'hadoku-builder', 'claw-8'], fleet), {
		state: 'minting',
		nodes: ['claw-8'],
	});
});

test("a job: implicit labels match in any case, and the floor's filters and hold still apply", () => {
	assert.equal(
		judgeJobMint(['Self-Hosted', 'Linux', 'X64', 'hadoku-builder'], view([node()])).state,
		'minting'
	);
	assert.equal(judgeJobMint(['hadoku-builder'], view([node({ drained: true })])).state, 'unserved');
	assert.equal(
		judgeJobMint(['hadoku-builder'], view([node({ probe: undefined })], false)).state,
		'unmeasured'
	);
	assert.equal(
		judgeJobMint(['hadoku-builder'], view([node({ probe: { reachable: false } })])).state,
		'unserved'
	);
});
