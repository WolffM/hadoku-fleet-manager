import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { nodeOffer, registrationLabels } from '../lib/capability-offer.js';
import { capability, verificationFor, type ManifestNode } from '../lib/capability-registry.js';
import { BUILDER_LABEL, PM2_HOST_LABEL } from '../runners/census.js';
import { healthyClaw, jdk21Earner, proof, ROOT } from './capability-fixtures.js';

// ---------------------------------------------------------------------------
// nodeOffer's fourth kind of evidence — the workload gate itself
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// excludeRepos must never gate a proof dispatch (wave 4e §A.5) — nodeOffer/the
// registry side. The dispatch-path regression test lives in prove-job.test.ts.
// ---------------------------------------------------------------------------

test('no node is ever REGISTERED eligible — the fast loop grants it once the node is judged safe', () => {
	// The 24-hokon-runners bug, as an assertion: a registration must not be born
	// schedulable, whatever the node is.
	assert.deepEqual(registrationLabels(healthyClaw()), []);
});

test('registrationLabels carries the node capabilities and nothing that grants CI', () => {
	// A declared `hadoku-builder` is dropped, and so is a mint-only label —
	// a standing runner carrying jit-canary would answer the canary unminted.
	assert.deepEqual(registrationLabels({ labels: ['hadoku-builder', 'jit-canary'] }), []);
	assert.deepEqual(registrationLabels({ labels: ['pm2-host', 'taskauto', 'av1-nvenc'] }), [
		'pm2-host',
		'taskauto',
		'av1-nvenc',
	]);
});

test('jdk21 is routed from the bootcamp record, never from a declaration — same contract as cargo-bevy', () => {
	const proved: ManifestNode = {
		labels: [],
		$capabilities: { earned: ['jdk21'], prereqs: [] },
	};
	assert.ok(nodeOffer(proved, { eligible: false }).includes('jdk21'));

	const claimsButFailed: ManifestNode = {
		labels: ['jdk21'],
		$capabilities: { earned: [], prereqs: [{ id: 'rust' }] },
	};
	assert.ok(
		!nodeOffer(claimsButFailed, { eligible: false }).includes('jdk21'),
		'a declaration must not survive a bootcamp record that did not earn it'
	);

	// A GUEST declaring it (hokon never will, but the rule is general) stays
	// declared — verificationFor reads every label on a guest as `role`.
	const guest: ManifestNode = { role: 'guest', labels: ['jdk21'] };
	assert.equal(verificationFor(guest, capability('jdk21')), 'role');
});

test('nodeOffer: omitting workloadProofs is BYTE-IDENTICAL to today — the wave 4e rollout constraint', () => {
	// No caller does this yet (production wiring is a later change); this pins
	// that every EXISTING call site keeps behaving exactly as it always has.
	assert.ok(nodeOffer(jdk21Earner(), { eligible: false }).includes('jdk21'));
});

test('nodeOffer: gate ACTIVE (>= minProven) and no $proof withholds jdk21', () => {
	const offer = nodeOffer(jdk21Earner(), {
		eligible: false,
		workloadProofs: { jdk21: null },
		provenCounts: { jdk21: 2 },
	});
	assert.ok(!offer.includes('jdk21'));
});

test('nodeOffer: gate ACTIVE with a fresh pass offers jdk21', () => {
	const offer = nodeOffer(jdk21Earner(), {
		eligible: false,
		workloadProofs: { jdk21: proof({ node: 'claw-4' }) },
		provenCounts: { jdk21: 2 },
	});
	assert.ok(offer.includes('jdk21'));
});

test('nodeOffer: gate DORMANT (< minProven) offers jdk21 even with no $proof — routing stays as today', () => {
	const offer = nodeOffer(jdk21Earner(), {
		eligible: false,
		workloadProofs: { jdk21: null },
		provenCounts: { jdk21: 1 },
	});
	assert.ok(offer.includes('jdk21'));
});

test('nodeOffer: a FAIL or STALE $proof withdraws jdk21 with NO manifest change, dormant or active', () => {
	for (const provenCount of [0, 2]) {
		const failing = nodeOffer(jdk21Earner(), {
			eligible: false,
			workloadProofs: { jdk21: proof({ verdict: 'fail' }) },
			provenCounts: { jdk21: provenCount },
		});
		assert.ok(!failing.includes('jdk21'), `provenCount=${provenCount}`);
		const stale = nodeOffer(jdk21Earner(), {
			eligible: false,
			workloadProofs: { jdk21: proof({ verdict: 'stale' }) },
			provenCounts: { jdk21: provenCount },
		});
		assert.ok(!stale.includes('jdk21'), `provenCount=${provenCount}`);
	}
	// And the manifest node object itself was never touched — no write, no commit.
	const frozen = Object.freeze(jdk21Earner());
	assert.doesNotThrow(() =>
		nodeOffer(frozen, {
			eligible: false,
			workloadProofs: { jdk21: proof({ verdict: 'fail' }) },
			provenCounts: { jdk21: 2 },
		})
	);
});

test('nodeOffer: a node that never earned the TOOL is unaffected by the workload gate either way', () => {
	const notEarned: ManifestNode = { labels: ['jdk21'], $capabilities: { earned: [], prereqs: [] } };
	assert.ok(
		!nodeOffer(notEarned, {
			eligible: false,
			workloadProofs: { jdk21: proof() },
			provenCounts: { jdk21: 2 },
		}).includes('jdk21')
	);
});

test('nodeOffer and the registry know nothing about excludeRepos — a proof can target an excluded node', () => {
	// A structural pin: excludeRepos is not even a field this module reads
	// anywhere. The real proof is prove-job.test.ts's dispatch against a node
	// whose excludeRepos names the proof's own repo.
	const src = readFileSync(resolve(ROOT, 'src', 'lib', 'capability-offer.ts'), 'utf8');
	assert.doesNotMatch(src, /excludeRepos/, 'capability-offer.ts must never consult excludeRepos');
});

test('cargo-bevy is routed from the bootcamp record, never from a declaration', () => {
	// The whole "eligibility is earned" contract for this label, end to end: a
	// node that declares nothing but has PROVED it offers it, and a node that
	// declares it but has proved otherwise does NOT — which is the direction
	// that matters, because a manifest claiming a compile speed is exactly the
	// assertion a measured capability exists to refuse.
	const proved: ManifestNode = {
		labels: [],
		$capabilities: { earned: ['cargo-bevy'], prereqs: [] },
	};
	assert.ok(nodeOffer(proved, { eligible: false }).includes('cargo-bevy'));

	const claimsButFailed: ManifestNode = {
		labels: ['cargo-bevy'],
		$capabilities: { earned: [], prereqs: [{ id: 'rust' }] },
	};
	assert.ok(
		!nodeOffer(claimsButFailed, { eligible: false }).includes('cargo-bevy'),
		'a declaration must not survive a bootcamp record that did not earn it'
	);
});

test('proving pm2-capable must never put a label on the node', () => {
	// WHAT THIS STOPS, end to end. Six workflows carry
	// `runs-on: [self-hosted, pm2-host]` and act on the pm2 stack of whatever
	// machine takes the job. `nodeOffer` puts every EARNED identity LABEL onto a
	// node's registrations and JIT mints — so if the "could this box host pm2"
	// question were asked under the `pm2-host` id, or under any `surface:
	// 'label'` id, the first claw to answer yes would start serving
	// redeploy-mgmt-api on a box with no ecosystem file and no vault.
	// `census.clawPool` also subtracts every runner carrying `pm2-host`, so the
	// same earn would silently shrink the CI pool.
	//
	// FLIP `surface` TO 'label' IN THE REGISTRY AND THIS FAILS. That is the
	// mutation it is written against.
	const capableClaw: ManifestNode = {
		role: 'claw',
		labels: [],
		$capabilities: { earned: ['pm2-capable', 'ffmpeg'], prereqs: [] },
	};
	const offer = nodeOffer(capableClaw, { eligible: true });
	assert.ok(!offer.includes('pm2-capable'), `pm2-capable must not be routable, got ${offer}`);
	assert.ok(
		!offer.includes(PM2_HOST_LABEL),
		`proving the capability must not make a claw the host, got ${offer}`
	);
	assert.deepEqual(offer, [BUILDER_LABEL], 'eligibility and nothing else');
});

test('jit-canary is DERIVED for every ephemeral node — nothing declares it', () => {
	// It was hand-declared on claw-3 alone, so the hourly canary only proved
	// claw-3's JIT path and the panel showed it on one claw of eight.
	const record = { $capabilities: { earned: [], prereqs: [] } };
	assert.ok(
		nodeOffer({ ephemeral: true, labels: [], ...record }, { eligible: true }).includes('jit-canary')
	);
	assert.ok(
		!nodeOffer({ ephemeral: true, labels: [] }, { eligible: true }).includes('jit-canary'),
		'a node bootcamp never reached offers nothing routable'
	);
	assert.ok(
		!nodeOffer({ ephemeral: false, labels: [], ...record }, { eligible: true }).includes(
			'jit-canary'
		),
		'a standing node must never offer it — it would answer the canary without minting'
	);
	assert.ok(!nodeOffer({ labels: [] }, { eligible: true }).includes('jit-canary'));
});

test('a STANDING registration never carries a mint-only label, even on an ephemeral node with a record', () => {
	// 0.29.5 derived jit-canary for every bootcamped ephemeral node; through
	// registrationLabels it reached the standing fleet-manager runners on
	// claw-4/claw-6, which would have answered the canary without minting.
	const node = {
		ephemeral: true,
		labels: [],
		$capabilities: { earned: ['cargo-bevy'], prereqs: [] },
	};
	const labels = registrationLabels(node);
	assert.ok(!labels.includes('jit-canary'), labels.join(','));
	assert.ok(labels.includes('cargo-bevy'), 'earned identity labels still apply');
	assert.ok(
		nodeOffer(node, { eligible: true }).includes('jit-canary'),
		'the MINT still carries it'
	);
});
