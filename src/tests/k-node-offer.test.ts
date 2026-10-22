/**
 * `nodeOffer` — the one answer to "what labels does this node offer" (issue #19).
 *
 * Wave 3-prep lane K. The question had FOUR readers off `machines[].labels`, and
 * the array was simultaneously the JIT mint's label WRITER and a filtered
 * identity source, with no type and no gate separating the two. These tests pin
 * the three kinds of evidence apart, and pin the two live cases the substitution
 * has to be correct for at once: a claw, where the array is a verbatim mint set,
 * and hokon, where it is a filtered identity source.
 *
 * Fixtures are the LIVE manifest's shapes, measured 2026-09-10 against
 * `~/srv/hadoku_site/scripts/admin/fleet-runner-manifest.json`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	nodeOffer,
	provenCapabilities,
	provesRequiredSet,
	registrationLabels,
	isCiDemandRecord,
	requiredIdentitySet,
	workloadGateStatus,
	type ManifestNode,
} from '../capabilities.js';
import type { ProofRecord } from '../lib/measured.js';

/** The five capabilities every claw on the live manifest proves today. */
const LIVE_PREREQS = [
	{ id: 'ffmpeg', detail: 'n6.1.1' },
	{ id: 'python-venv', detail: 'ok' },
	{ id: 'python-toolcache', detail: '3.11, 3.12' },
	{ id: 'playwright', detail: 'chromium' },
	{ id: 'gh', detail: '2.45.0' },
];

/** A claw as the live manifest has it TODAY: declared builder, `earned: []`. */
function liveClaw(extra: Partial<ManifestNode> = {}): ManifestNode {
	return {
		labels: ['hadoku-builder'],
		ephemeral: true,
		maxConcurrent: 4,
		minFreeMb: 1536,
		$capabilities: { at: '2026-09-07T00:00:00Z', earned: [], prereqs: LIVE_PREREQS },
		...extra,
	} as ManifestNode;
}

/** The same claw after the manifest strip AND after bootcamp promotes. */
function promotedClaw(extra: Partial<ManifestNode> = {}): ManifestNode {
	return {
		labels: [],
		ephemeral: true,
		maxConcurrent: 4,
		minFreeMb: 1536,
		$capabilities: {
			at: '2026-09-11T00:00:00Z',
			earned: ['ffmpeg', 'gh', 'jitconfig', 'playwright', 'python-toolcache', 'python-venv'],
			prereqs: LIVE_PREREQS,
		},
		...extra,
	} as ManifestNode;
}

// ---------------------------------------------------------------------------
// provenCapabilities — and the "I could not look" answer
// ---------------------------------------------------------------------------

test('provenCapabilities is null when nothing has ever looked', () => {
	assert.equal(provenCapabilities({ labels: ['hadoku-builder'] }), null);
});

test('provenCapabilities is null for a facet with no `earned` array', () => {
	// Something that is not this bootcamp wrote the record; it cannot answer the
	// question, and guessing is what "I could not look" forbids.
	assert.equal(provenCapabilities({ $capabilities: { at: 'x' } } as ManifestNode), null);
});

test('provenCapabilities unions earned with prereqs — the transition bridge', () => {
	// `earned` is [] on all seven claws on the live manifest because nothing has
	// promoted yet. Reading it alone would say every claw has proven NOTHING.
	assert.deepEqual([...provenCapabilities(liveClaw())!].sort(), [
		'ffmpeg',
		'gh',
		'playwright',
		'python-toolcache',
		'python-venv',
	]);
});

// ---------------------------------------------------------------------------
// nodeOffer — the three kinds of evidence
// ---------------------------------------------------------------------------

test('nodeOffer on TODAY’s live claw is byte-for-byte what the mint produces now', () => {
	// THE SUBSTITUTION MUST BE A NO-OP BEFORE THE STRIP. `ephemeral-tick.ts:759`
	// returns `m.labels ?? []` = ['hadoku-builder']; this is the fleet as it runs.
	assert.deepEqual(nodeOffer(liveClaw(), { eligible: true }), ['jit-canary', 'hadoku-builder']);
});

test('nodeOffer on a STRIPPED manifest still offers hadoku-builder — issue #19', () => {
	// The whole point. With the declaration gone and `earned` populated, the mint
	// set is unchanged; without this function it is `self-hosted,Linux,X64` and
	// every job in the fleet queues silently.
	assert.deepEqual(nodeOffer(promotedClaw(), { eligible: true }), ['jit-canary', 'hadoku-builder']);
});

test('nodeOffer on a stripped manifest is ALSO correct while `earned` is still empty', () => {
	// Eligibility is the caller's answer, never derived from `earned`, so the
	// substitution cannot take the fleet dark by shipping before the producer
	// runs. The ordering constraint stays (the gate's RED condition needs the
	// producer), but this cliff does not exist.
	const stripped = liveClaw({ labels: [] });
	assert.deepEqual(nodeOffer(stripped, { eligible: true }), ['jit-canary', 'hadoku-builder']);
});

test('nodeOffer keeps a role/mint label, which no probe can settle', () => {
	// claw-3 carries jit-canary (verify: 'mint') and it stays through the strip.
	assert.deepEqual(nodeOffer(promotedClaw({ labels: ['jit-canary'] }), { eligible: true }), [
		'jit-canary',
		'hadoku-builder',
	]);
});

test('nodeOffer REPLACES a declared probe-verified label with what was proven', () => {
	// av1-nvenc is the registry's own example of a claim that lies: Debian's
	// ffmpeg reports the encoder whether or not the GPU can use it. So a node
	// declaring it with a record that does not earn it does not offer it — and
	// this is what lets check-label-floor's disagreement check be non-vacuous.
	const liar = {
		labels: ['av1-nvenc'],
		$capabilities: { earned: [], prereqs: LIVE_PREREQS },
	} as ManifestNode;
	assert.deepEqual(nodeOffer(liar, { eligible: false }), []);
});

test('nodeOffer projects an EARNED probe label nothing declares', () => {
	const prover = {
		labels: [],
		$capabilities: { earned: ['av1-nvenc'], prereqs: LIVE_PREREQS },
	} as ManifestNode;
	assert.deepEqual(nodeOffer(prover, { eligible: false }), ['av1-nvenc']);
});

test('nodeOffer falls back to the DECLARATION when nothing has looked', () => {
	// The only safe direction. The alternative silently strips av1-nvenc off
	// hokon — one node deep, and the reason 22 dataplatform tests skip when it is
	// dark — on an unreadable or missing state record.
	const unprobed = { labels: ['pm2-host', 'taskauto', 'av1-nvenc'] } as ManifestNode;
	assert.deepEqual(nodeOffer(unprobed, { eligible: false }), ['pm2-host', 'taskauto', 'av1-nvenc']);
});

test('nodeOffer never derives eligibility from `earned`', () => {
	// A node that proves everything is still not eligible unless the caller says
	// so. The tier ladder is the fleet's single eligibility authority; a second
	// one here would disagree with it exactly when the ledger is unreadable.
	// `jit-canary` is derived from the ephemeral FACT, not from `earned`, and is
	// not an eligibility label — what this pins is that `hadoku-builder` is absent.
	assert.deepEqual(nodeOffer(promotedClaw(), { eligible: false }), ['jit-canary']);
});

test('nodeOffer passes an UNREGISTERED label through, like identityLabels', () => {
	const typo = { labels: ['hadoku-buidler'], $capabilities: { earned: [] } } as ManifestNode;
	assert.deepEqual(nodeOffer(typo, { eligible: false }), ['hadoku-buidler']);
});

test('nodeOffer is hokon-correct: the array is a FILTERED identity source there', () => {
	// hokon is non-ephemeral and takes the fast loop's label-toggle path. Live
	// GitHub shows it as self-hosted,Linux,X64,pm2-host,taskauto,av1-nvenc —
	// WITHOUT hadoku-builder, despite declaring it — and that must not change.
	//
	// `role: 'guest'` is on the fixture because it is on the LIVE manifest (wave
	// 3c §G) and because it is now load-bearing rather than decorative: since #6
	// made `pm2-host` probe-verified, the role is the only thing keeping the
	// declaration in the offer. The mutation below is the proof.
	const hokon = {
		role: 'guest',
		labels: ['pm2-host', 'taskauto', 'av1-nvenc', 'hadoku-builder'],
		minFreeMb: 4096,
		$capabilities: { earned: ['av1-nvenc'], prereqs: LIVE_PREREQS },
	} as ManifestNode;
	assert.deepEqual(nodeOffer(hokon, { eligible: false }).sort(), [
		'av1-nvenc',
		'pm2-host',
		'taskauto',
	]);
	// And after the strip, with av1-nvenc still declared and still earned.
	const stripped = { ...hokon, labels: ['pm2-host', 'taskauto', 'av1-nvenc'] } as ManifestNode;
	assert.deepEqual(nodeOffer(stripped, { eligible: false }).sort(), [
		'av1-nvenc',
		'pm2-host',
		'taskauto',
	]);
});

// ---------------------------------------------------------------------------
// the GUEST carve-out — #6's other half
// ---------------------------------------------------------------------------

test('a GUEST keeps a declared pm2-host, which no probe of ours may settle', () => {
	// THE OUTAGE THIS PREVENTS. `pm2-host` became `verify: "probe"` on 2026-09-15
	// so a CLAW has a bar to clear. The production host is a GUEST and carries a
	// `$capabilities` record from before the role existed, so without the role
	// narrowing, `nodeOffer` would read "probe-verified, and the record does not
	// earn it" and drop the label the five infra workflows route on.
	const guest = {
		role: 'guest',
		labels: ['pm2-host', 'taskauto', 'av1-nvenc'],
		$capabilities: { earned: ['av1-nvenc'], prereqs: LIVE_PREREQS },
	} as ManifestNode;
	assert.ok(nodeOffer(guest, { eligible: false }).includes('pm2-host'));
	assert.deepEqual(registrationLabels(guest).sort(), ['av1-nvenc', 'pm2-host', 'taskauto']);
});

test('MUTATION: the same node WITHOUT the guest role loses the declaration', () => {
	// Same fixture, one field. This is what makes the test above non-vacuous: it
	// fails if `verificationFor` stops consulting the role, AND it fails if the
	// registry entry slides back to `verify: "role"` (then the declaration
	// survives here too and this assertion goes green in the wrong direction).
	const asClaw = {
		role: 'claw',
		labels: ['pm2-host', 'taskauto', 'av1-nvenc'],
		$capabilities: { earned: ['av1-nvenc'], prereqs: LIVE_PREREQS },
	} as ManifestNode;
	assert.ok(
		!nodeOffer(asClaw, { eligible: false }).includes('pm2-host'),
		'a claw must EARN pm2-host, never type it'
	);
	// And an UNRECOGNISED role reads as claw, so a typo cannot exempt a node —
	// `nodeRole`'s strict default, asserted here because this is where it bites.
	const typo = { ...asClaw, role: 'gest' } as ManifestNode;
	assert.ok(!nodeOffer(typo, { eligible: false }).includes('pm2-host'));
});

test('a CLAW that EARNS pm2-host offers it, without declaring anything', () => {
	// The state migration one needs: the label arrives from the bootcamp record,
	// `machines[].labels` stays empty, and the manifest cannot claim a role the
	// box has not demonstrated.
	const earner = promotedClaw({
		$capabilities: {
			at: '2026-09-20T00:00:00Z',
			earned: ['ffmpeg', 'gh', 'jitconfig', 'pm2-host', 'playwright'],
			prereqs: LIVE_PREREQS,
		},
	});
	assert.deepEqual(nodeOffer(earner, { eligible: true }).sort(), [
		'hadoku-builder',
		'jit-canary',
		'pm2-host',
	]);
});

test('nodeOffer never emits a toolchain capability as a routable label', () => {
	// Under the 2026-09-10 `earned` semantics a node proves ffmpeg, gh,
	// python-venv, python-toolcache, playwright and jitconfig. None of them is a
	// label: routing on something every node has says nothing, and declaring one
	// is what `validateCapabilities` rejects as surface-mismatch.
	for (const l of nodeOffer(promotedClaw(), { eligible: true })) {
		assert.ok(['hadoku-builder', 'jit-canary'].includes(l), `${l} is not a routable label`);
	}
});

test('registrationLabels is nodeOffer, so there is one implementation to drift from', () => {
	const n = promotedClaw({ labels: ['jit-canary'] });
	assert.deepEqual(
		registrationLabels(n),
		nodeOffer(n, { eligible: false }).filter((l) => l !== 'jit-canary'),
		'nodeOffer minus the mint-only labels a standing registration must never carry'
	);
});

// ---------------------------------------------------------------------------
// provesRequiredSet — hadoku-builder's consumer contract
// ---------------------------------------------------------------------------

/** The live required set, measured 2026-09-10 from the 147-row demand ledger. */
const LIVE_REQUIRED = new Set(['ffmpeg', 'playwright', 'python-toolcache']);

test('provesRequiredSet holds for every claw on the LIVE manifest today', () => {
	const v = provesRequiredSet(liveClaw(), LIVE_REQUIRED);
	assert.equal(v.ok, true);
	assert.deepEqual(v.missing, []);
	assert.equal(v.reason, null);
});

test('provesRequiredSet says WHY when nothing has looked, and does not fail open', () => {
	const v = provesRequiredSet({ labels: ['hadoku-builder'] }, LIVE_REQUIRED);
	assert.equal(v.ok, false);
	assert.match(v.reason!, /nothing has looked/);
	assert.deepEqual(v.missing, ['ffmpeg', 'playwright', 'python-toolcache']);
});

test('provesRequiredSet names the missing capability, not just a verdict', () => {
	const thin = {
		$capabilities: { earned: ['ffmpeg'], prereqs: [{ id: 'ffmpeg' }] },
	} as ManifestNode;
	const v = provesRequiredSet(thin, LIVE_REQUIRED);
	assert.equal(v.ok, false);
	assert.deepEqual(v.missing, ['playwright', 'python-toolcache']);
	assert.match(v.reason!, /does not prove playwright, python-toolcache/);
});

test('provesRequiredSet disqualifies on blocked/unprobed and says which', () => {
	const blocked = {
		$capabilities: {
			at: '2026-09-10T00:00:00Z',
			earned: ['ffmpeg', 'playwright', 'python-toolcache'],
			prereqs: LIVE_PREREQS,
			blocked: [{ id: 'gh', detail: 'exit 127' }],
		},
	} as ManifestNode;
	const v = provesRequiredSet(blocked, LIVE_REQUIRED);
	assert.equal(v.ok, false);
	assert.match(v.reason!, /blocked gh/);
});

test('provesRequiredSet on an empty required set holds for a probed node', () => {
	assert.equal(provesRequiredSet(liveClaw(), new Set()).ok, true);
});

// ---------------------------------------------------------------------------
// the ledger's class discriminator
// ---------------------------------------------------------------------------

test('a resident row can never enter a CI capability set', () => {
	const records = [
		{ class: 'ci', fleetForm: true, selfHosted: true, capabilities: ['ffmpeg'] },
		// A resident row carries no fleetForm today, which is why it is dropped by
		// accident. The explicit guard is what survives the next reader.
		{ class: 'resident', fleetForm: true, selfHosted: true, capabilities: ['cuda'] },
	];
	assert.deepEqual([...requiredIdentitySet(records)], ['ffmpeg']);
});

test('a row with NO class is a legacy CI row — the live ledger is 147 of them', () => {
	assert.equal(isCiDemandRecord({}), true);
	assert.equal(isCiDemandRecord({ class: 'ci' }), true);
	assert.equal(isCiDemandRecord({ class: 'resident' }), false);
	// And the consequence: today's unlabelled ledger still produces a required
	// set, rather than an empty one that would pass the gate having checked
	// nothing.
	assert.deepEqual(
		[...requiredIdentitySet([{ fleetForm: true, selfHosted: true, capabilities: ['playwright'] }])],
		['playwright']
	);
});

// ---------------------------------------------------------------------------
// nodeOffer's FOURTH kind of evidence — wave 4e (#102): a workload-gated
// label's PROVEN tool is no longer sufficient on its own. Built on the SAME
// `promotedClaw` fixture shape the other three kinds of evidence are proven
// against above, with `jdk21` standing in for the earned label under test.
// ---------------------------------------------------------------------------

// RELATIVE TO NOW, never an absolute date: `fixture-clock-guard.test.mjs` runs
// this whole suite with the clock 30 and 400 days ahead specifically to catch
// a fixture pinned to a date the retention/freshness cutoffs will reach on
// their own (CLAUDE.md, "fixture dates cross retention"). `isProofFresh` reads
// `at` against `Date.now()`, so a literal timestamp here is exactly that trap.
const proofAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

const proof = (over: Partial<ProofRecord> = {}): ProofRecord => ({
	node: 'claw-4',
	capability: 'jdk21',
	runId: 37672172494,
	runner: 'jit-claw-4-proof-hadoku-cardtable-j0-r0-1',
	conclusion: 'success',
	durationSec: 300,
	evidenceMatched: true,
	budgetSec: 450,
	verdict: 'pass',
	why: 'tool present, workload PASSED',
	at: proofAgo(1),
	...over,
});

/** `promotedClaw`, but it earned jdk21 too — the exact shape claw-4/8/9 take once bootcamp proves them. */
const jdk21Claw = (extra: Partial<ManifestNode> = {}): ManifestNode =>
	promotedClaw({
		$capabilities: {
			at: proofAgo(1),
			earned: [
				'ffmpeg',
				'gh',
				'jitconfig',
				'playwright',
				'python-toolcache',
				'python-venv',
				'jdk21',
			],
			prereqs: LIVE_PREREQS,
		},
		...extra,
	});

test('nodeOffer: no workloadProofs at all is BYTE-IDENTICAL to the pre-wave-4e offer', () => {
	// The wave's own rollout constraint: every call site that has not been
	// wired to the state dir yet (every one, today) must see jdk21 exactly as
	// it would have before this gate existed.
	assert.deepEqual(
		nodeOffer(jdk21Claw(), { eligible: true }).sort(),
		nodeOffer(jdk21Claw(), { eligible: true, workloadProofs: undefined }).sort()
	);
	assert.ok(nodeOffer(jdk21Claw(), { eligible: true }).includes('jdk21'));
});

test('nodeOffer: DORMANT gate (fewer than minProven fresh passes anywhere) offers jdk21 with no $proof at all', () => {
	assert.ok(
		nodeOffer(jdk21Claw(), {
			eligible: true,
			workloadProofs: { jdk21: null },
			provenCounts: { jdk21: 1 },
		}).includes('jdk21')
	);
});

test('nodeOffer: ACTIVE gate (>= minProven) withholds jdk21 from a node with no $proof', () => {
	const offer = nodeOffer(jdk21Claw(), {
		eligible: true,
		workloadProofs: { jdk21: null },
		provenCounts: { jdk21: 2 },
	});
	assert.ok(!offer.includes('jdk21'));
	assert.ok(offer.includes('hadoku-builder'), 'nothing ELSE about the offer changes');
});

test('nodeOffer: ACTIVE gate with a FRESH PASS offers jdk21', () => {
	assert.ok(
		nodeOffer(jdk21Claw(), {
			eligible: true,
			workloadProofs: { jdk21: proof() },
			provenCounts: { jdk21: 2 },
		}).includes('jdk21')
	);
});

test('nodeOffer: a FAILED canary withdraws jdk21 — claw-3-shaped, no manifest change', () => {
	// The exact incident this wave exists for: five failing cardtable forge-e2e
	// runs, read back as a $proof record, no manifest commit anywhere in sight.
	const claw3Shaped = jdk21Claw();
	const snapshot = JSON.stringify(claw3Shaped);
	const offer = nodeOffer(claw3Shaped, {
		eligible: true,
		workloadProofs: {
			jdk21: proof({
				node: 'claw-3',
				conclusion: 'failure',
				evidenceMatched: false,
				verdict: 'fail',
				why: 'the job ran on the node and concluded "failure"',
			}),
		},
		provenCounts: { jdk21: 0 }, // dormant fleet-wide — and it STILL loses the label
	});
	assert.ok(!offer.includes('jdk21'));
	assert.equal(JSON.stringify(claw3Shaped), snapshot, 'the manifest node is untouched');
});

test('nodeOffer: a STALE canary (node-regression wave 4e §B) withdraws jdk21 the same way', () => {
	assert.ok(
		!nodeOffer(jdk21Claw(), {
			eligible: true,
			workloadProofs: {
				jdk21: proof({
					node: 'claw-3',
					verdict: 'stale',
					why: '5 jdk21 run(s) failed on claw-3 while the same commit passed elsewhere within the hour',
				}),
			},
			provenCounts: { jdk21: 2 },
		}).includes('jdk21')
	);
});

test('workloadGateStatus renders the brief’s own example reasons, verbatim in shape', () => {
	const cap = { jobProof: { budget: { factor: 1.5, minProven: 2 } } } as Parameters<
		typeof workloadGateStatus
	>[0];
	const failed = workloadGateStatus(
		cap,
		proof({
			verdict: 'fail',
			why: '27/62 specs, 25.7 min against a 9.0 min budget, run 37672172494',
		}),
		2
	);
	assert.match(failed.reason, /workload FAILED: 27\/62 specs, 25\.7 min against a 9\.0 min budget/);
	const none = workloadGateStatus(cap, null, 2);
	assert.equal(none.reason, 'tool present, no workload proof');
});
