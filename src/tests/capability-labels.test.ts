import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
	identityLabels,
	ephemeralOnlyLabels,
	IMPLICIT_LABELS,
	labelCapabilities,
} from '../lib/capability-labels.js';
import { capability, type FleetManifestShape } from '../lib/capability-registry.js';
import { ROOT } from './capability-fixtures.js';

// ---------------------------------------------------------------------------
// Derivation — what the reconciler now asks instead of filtering by hand
// ---------------------------------------------------------------------------

test('identityLabels drops eligibility and keeps everything else', () => {
	assert.deepEqual(identityLabels({ labels: ['hadoku-builder', 'jit-canary', 'pm2-host'] }), [
		'jit-canary',
		'pm2-host',
	]);
});

test('identityLabels passes an UNDECLARED label through', () => {
	// The reconciler is additive on purpose. A derivation that silently swallowed
	// an unknown label would unroute live jobs on a manifest typo; the schema gate
	// is what rejects the typo.
	assert.deepEqual(identityLabels({ labels: ['not-a-capability'] }), ['not-a-capability']);
});

test('every label the committed manifest declares is a registry entry', () => {
	const m = JSON.parse(
		readFileSync(resolve(ROOT, 'manifests', 'fleet-runner-manifest.json'), 'utf8')
	) as FleetManifestShape;
	const declared = new Set(Object.values(m.machines ?? {}).flatMap((x) => x.labels ?? []));
	assert.ok(declared.size > 0, 'a manifest declaring no labels is not a pass');
	for (const id of declared) {
		assert.ok(capability(id), `${id} is declared by a node and defined nowhere`);
	}
	// And the registry is not merely a superset of dead entries: every label
	// capability except the ones the fleet writes at runtime is actually in use.
	// `hadoku-builder` joined this set on 2026-09-07 (P1.2/P1.3): it is now
	// EARNED by the fast loop against a bootcamp finding and must never be
	// declared in `machines[].labels`, so "declared by no node" is its correct,
	// permanent state rather than a fixture gap.
	// `cargo-bevy` joined this set on 2026-09-14 for the same reason: it is
	// EARNED from the bootcamp record and routed by `nodeOffer`, so a node must
	// never declare it either. A manifest that claimed it would be asserting a
	// compile speed nothing measured — the one thing a measured capability
	// exists to refuse.
	// `jdk21` joined this set 2026-10-05 (cardtable#5) for the identical
	// reason `cargo-bevy` did: EARNED from the bootcamp record and routed by
	// `nodeOffer`, never declared — a manifest claiming it would assert a
	// toolchain nothing executed.
	// `jit-canary` joined it 2026-10-09: `nodeOffer` DERIVES it for every
	// ephemeral node, so the live manifest stopped declaring it on claw-3.
	// `nvenc-h264` joined it 2026-10-23 (fleet-manager#3) on `jdk21`'s
	// reasoning: earned from the bootcamp record, never declared.
	// `docker` joined it 2026-10-27 (node-users): earned by building an image.
	// `data-peer` joined it 2026-10-27 (fleet-manager#16): earned by connecting.
	// `service-host` joined it 2026-10-31 (fleet-manager#16): earned by the node
	// proving it can serve a placed service.
	const runtimeWritten = new Set([
		'data-peer',
		'service-host',
		'docker',
		'hokon-backstop',
		'hadoku-builder',
		'cargo-bevy',
		'jdk21',
		'jit-canary',
		'nvenc-h264',
	]);
	for (const c of labelCapabilities()) {
		if (runtimeWritten.has(c.id)) continue;
		assert.ok(declared.has(c.id), `${c.id} is registered as a label and declared by no node`);
	}
});

test('ephemeralOnlyLabels names every label a STANDING listener must not carry', () => {
	// Derived from `requires.facts`, so a new ephemeral-only capability is
	// excluded from warm listeners without editing a second list.
	const only = ephemeralOnlyLabels();
	assert.ok(only.includes('jit-canary'), 'jit-canary requires ephemeral and must be listed');
	// And nothing that a standing runner legitimately carries.
	for (const safe of ['hadoku-builder', 'pm2-host', 'taskauto', 'av1-nvenc']) {
		assert.ok(!only.includes(safe), `${safe} is not mint-only and must not be stripped`);
	}
});

test('a warm listener never carries a mint-only label', () => {
	// THE LIVE FAILURE, 2026-09-08/09. The warm cache provisioned listeners with
	// the same labels a JIT mint gets, so `warm-claw-3-hadoku_site` carried
	// `jit-canary` and answered the canary — five consecutive site:jit-canary
	// failures, each failing the step "prove this ran on a minted runner".
	//
	// capabilities.ts states the rule the warm path broke: "A standing runner
	// carrying this label would answer the canary without minting anything."
	const declared = ['hadoku-builder', 'jit-canary'];
	const forbidden = new Set(ephemeralOnlyLabels());
	const warm = [...new Set([...IMPLICIT_LABELS, ...declared])].filter((l) => !forbidden.has(l));
	assert.ok(
		!warm.includes('jit-canary'),
		'a standing listener must not be able to answer the canary'
	);
	assert.ok(warm.includes('hadoku-builder'), 'but it still takes general CI');
	assert.ok(warm.includes('self-hosted'), 'and keeps the implicit labels GitHub needs');
});
