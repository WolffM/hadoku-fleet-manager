import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ManifestNode } from '../lib/capability-registry.js';
import type { ProofRecord } from '../lib/measured.js';

export const HERE = fileURLToPath(new URL('.', import.meta.url));
/** dist/tests/ -> dist/ -> <repo root> */
export const ROOT = resolve(HERE, '..', '..');

/** A node that satisfies every requirement, so a test perturbs ONE thing. */
export const healthyClaw = (over: Partial<ManifestNode> = {}): ManifestNode => ({
	labels: ['hadoku-builder'],
	maxConcurrent: 2,
	minFreeMb: 1536,
	...over,
});

/** One (node, capability) proof, with sane defaults a test perturbs. */
export const proof = (over: Partial<ProofRecord> = {}): ProofRecord => ({
	node: 'claw-4',
	capability: 'jdk21',
	runId: 1,
	runner: 'jit-claw-4-proof-hadoku-cardtable-j0-r0-1',
	conclusion: 'success',
	durationSec: 300,
	evidenceMatched: true,
	budgetSec: null,
	verdict: 'pass',
	why: 'pass (budget unbootstrapped: 0/2 proven node(s))',
	at: new Date().toISOString(),
	...over,
});

/** A node that has EARNED jdk21's tool proof this run (or on record). */
export const jdk21Earner = (extra: Partial<ManifestNode> = {}): ManifestNode => ({
	labels: [],
	$capabilities: { earned: ['jdk21'], prereqs: [] },
	...extra,
});
