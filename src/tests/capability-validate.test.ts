import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
	validateCapabilities,
	jobProofBudgetFindings,
	parseProbeCapabilities,
} from '../lib/capability-validate.js';
import {
	capability,
	type Capability,
	type FleetManifestShape,
	type ManifestNode,
} from '../lib/capability-registry.js';
import { probeableIds } from '../lib/capability-labels.js';
import { registrationLabels } from '../lib/capability-offer.js';
import { workloadGateContext, type WorkloadGateContext } from '../lib/workload-gate.js';
import type { ProofRecord } from '../lib/workload-gate.js';
import { healthyClaw, proof, ROOT } from './capability-fixtures.js';

/**
 * The capability registry, and the manifest read through it.
 *
 * Two layers, deliberately:
 *
 *   1. UNIT — hand-built manifests, one per rule. Each asserts the rule FIRES,
 *      because a validator arm that cannot fail reads as coverage and is worse
 *      than none.
 *   2. PIN — the committed `manifests/` fixture, which is a copy of the live
 *      fleet manifest, must validate clean. This is what would have caught the
 *      derivations below changing what the fleet writes to GitHub.
 *
 * The fixture can go stale (see manifests/README.md) and that is accepted: these
 * rules are shape-driven, so a renamed claw ages the fixture without weakening
 * what is checked. `fleet capability-schema` is what reads the REAL manifest.
 */

const rules = (m: FleetManifestShape, probe?: Set<string>): string[] =>
	validateCapabilities(m, probe).map((f) => f.rule);

/** Enough nodes that the floor rules are satisfied by default. */
const baseManifest = (nodes: Record<string, ManifestNode>): FleetManifestShape => ({
	machines: {
		hokon: hokonEarned(['pm2-host', 'av1-nvenc']),
		...nodes,
	},
	toolchain: { capabilities: ['ffmpeg', 'python-venv'], toolCache: { Python: ['3.12'] } },
});

// ---------------------------------------------------------------------------
// Validation — one test per arm, each proving the arm FIRES
// ---------------------------------------------------------------------------

/** hokon's live shape (2026-10-31): backstop, standing, earned what a claw earns. */
const hokonEarned = (earned: string[]): ManifestNode => ({
	role: 'backstop',
	labels: ['pm2-host', 'taskauto', 'av1-nvenc'],
	minFreeMb: 8192,
	$capabilities: {
		at: new Date().toISOString(),
		by: 'fleet bootcamp',
		declared: [],
		earned,
		blocked: [],
		unprobed: [],
		prereqs: [],
	},
});

/** A workload gate where `jdk21` is ACTIVE (two fresh passes elsewhere) and hokon holds `record`. */
const activeJdkGate = (record: ProofRecord | null): WorkloadGateContext =>
	workloadGateContext(['hokon', 'claw-4', 'claw-8'], {
		jdk21: [
			proof({ node: 'claw-4' }),
			proof({ node: 'claw-8' }),
			...(record ? [{ ...record, node: 'hokon' }] : []),
		],
	});

// ---------------------------------------------------------------------------
// The probe parser, and the real artefacts
// ---------------------------------------------------------------------------

test('jobProofBudgetFindings fires on each malformed shape, and is clean on the real jdk21 entry', () => {
	const base = capability('jdk21')!;
	assert.deepEqual(jobProofBudgetFindings(base), [], 'the real entry is clean');
	const badFactor: Capability = {
		...base,
		jobProof: { ...base.jobProof!, budget: { factor: 1, minProven: 2 } },
	};
	assert.deepEqual(
		jobProofBudgetFindings(badFactor).map((f) => f.rule),
		['invalid-job-proof-budget']
	);
	const badMinProven: Capability = {
		...base,
		jobProof: { ...base.jobProof!, budget: { factor: 1.5, minProven: 0 } },
	};
	assert.equal(jobProofBudgetFindings(badMinProven).length, 1);
	const fractionalMinProven: Capability = {
		...base,
		jobProof: { ...base.jobProof!, budget: { factor: 1.5, minProven: 1.5 } },
	};
	assert.equal(jobProofBudgetFindings(fractionalMinProven).length, 1);
	const badEvidence: Capability = {
		...base,
		jobProof: { ...base.jobProof!, evidence: '(unterminated' },
	};
	assert.equal(jobProofBudgetFindings(badEvidence).length, 1);
	assert.equal(
		jobProofBudgetFindings({ ...base, jobProof: undefined }).length,
		0,
		'no jobProof, nothing to say'
	);
});

test('the committed manifest validates clean against the new budget rule too', () => {
	assert.deepEqual(
		validateCapabilities(baseManifest({ 'claw-1': healthyClaw() })).filter(
			(f) => f.rule === 'invalid-job-proof-budget'
		),
		[]
	);
});

test('a clean manifest yields no findings', () => {
	assert.deepEqual(rules(baseManifest({ 'claw-1': healthyClaw() })), []);
});

test('unknown-capability: a label no registry entry defines', () => {
	assert.deepEqual(
		rules(baseManifest({ 'claw-1': healthyClaw({ labels: ['hadoku-builder', 'gpu-fast'] }) })),
		['unknown-capability']
	);
});

test('unknown-capability: a toolchain requirement no registry entry defines', () => {
	const m = baseManifest({ 'claw-1': healthyClaw() });
	m.toolchain = { ...m.toolchain, capabilities: ['ffmpeg', 'rustup'] };
	assert.deepEqual(rules(m), ['unknown-capability']);
});

test('surface-mismatch: a toolchain capability used as a node label', () => {
	assert.deepEqual(
		rules(baseManifest({ 'claw-1': healthyClaw({ labels: ['hadoku-builder', 'ffmpeg'] }) })),
		['surface-mismatch']
	);
});

test('surface-mismatch: a routable label required of every node', () => {
	const m = baseManifest({ 'claw-1': healthyClaw() });
	m.toolchain = { ...m.toolchain, capabilities: ['ffmpeg', 'python-venv', 'av1-nvenc'] };
	assert.deepEqual(rules(m), ['surface-mismatch']);
});

test('missing-required-field: an eligible node with no concurrency cap', () => {
	// `fleet throttle` renders MAX_CONCURRENT straight from this field, and
	// ci-throttle.sh falls through to 99 — no limit — on a non-numeric value.
	const claw = healthyClaw();
	delete claw.maxConcurrent;
	assert.deepEqual(rules(baseManifest({ 'claw-1': claw })), ['missing-required-field']);
});

test('missing-required-field: an eligible node with no memory floor', () => {
	const claw = healthyClaw();
	delete claw.minFreeMb;
	assert.deepEqual(rules(baseManifest({ 'claw-1': claw })), ['missing-required-field']);
});

test('#98 missing-required-field: a claw that DECLARES nothing still owes the builder throttle', () => {
	// The live shape since 2026-09-09: no claw declares `hadoku-builder`, the
	// fast loop grants it. Reading declared labels only, this rule checked the
	// THROTTLE_FIELDS on no node at all.
	const claw = healthyClaw({ labels: [] });
	delete claw.maxConcurrent;
	const findings = validateCapabilities(baseManifest({ 'claw-1': claw }));
	assert.deepEqual(
		findings.map((f) => [f.rule, f.machine, f.capability]),
		[['missing-required-field', 'claw-1', 'hadoku-builder']]
	);
});

test('#98 missing-required-field: a BACKSTOP is not eligible, so it does not owe the builder throttle', () => {
	const m = baseManifest({ 'claw-1': healthyClaw() });
	assert.equal(m.machines?.hokon?.maxConcurrent, undefined, 'the fixture backstop declares none');
	assert.deepEqual(rules(m), []);
});

test('floor-bypassed: a standing node that EARNED jdk21/cargo-bevy the way a claw does is clean', () => {
	// THE UNIFIED MODEL (2026-10-10). The old rule flagged exactly this — a
	// standing offerer of a `floor: false` label — because the old floor was
	// standing-only. Earning it the claw way (probe + fresh workload proof) is
	// now what a standing offerer SHOULD do.
	const m = baseManifest({ 'claw-1': healthyClaw() });
	m.machines!.hokon = hokonEarned(['pm2-host', 'av1-nvenc', 'jdk21', 'cargo-bevy']);
	const findings = validateCapabilities(m, undefined, { workloadGate: activeJdkGate(proof()) });
	assert.deepEqual(
		findings.filter((f) => f.rule === 'floor-bypassed'),
		[]
	);
});

test('floor-bypassed: a backstop whose record does NOT earn a declared probe label does not offer it', () => {
	// The record answers the declaration on every node, so the standing offer
	// never carries the contradicted label and the floor has nothing to bypass.
	const m = baseManifest({ 'claw-1': healthyClaw() });
	m.machines!.hokon = hokonEarned(['pm2-host']);
	assert.ok(!registrationLabels(m.machines!.hokon).includes('av1-nvenc'));
	const findings = validateCapabilities(m, undefined, { workloadGate: activeJdkGate(null) });
	assert.deepEqual(
		findings.filter((f) => f.rule === 'floor-bypassed'),
		[]
	);
});

test('floor-bypassed: a standing workload-gated label with NO gate context is reported, not passed', () => {
	// "I could not look" is a finding: without the $proof state nobody can say
	// whether a minting node in hokon's place would be offered jdk21.
	const m = baseManifest({ 'claw-1': healthyClaw() });
	m.machines!.hokon = hokonEarned(['pm2-host', 'av1-nvenc', 'jdk21']);
	const findings = validateCapabilities(m).filter((f) => f.rule === 'floor-bypassed');
	assert.deepEqual(
		findings.map((f) => [f.machine, f.capability]),
		[['hokon', 'jdk21']]
	);
	assert.match(findings[0].message, /no workload-proof context/);
});

test('floor-bypassed: a STALE workload proof keeps jdk21 off the standing offer, so nothing is bypassed', () => {
	// The reconciler projects `registrationLabels` with the same gate, so a
	// standing node whose proof went stale stops carrying jdk21 — the floor then
	// counts nothing for it. The rule reads that same offer.
	const m = baseManifest({ 'claw-1': healthyClaw() });
	m.machines!.hokon = hokonEarned(['pm2-host', 'av1-nvenc', 'jdk21']);
	const gate = activeJdkGate(proof({ verdict: 'stale', why: 'marked stale' }));
	assert.ok(
		!registrationLabels(m.machines!.hokon, {
			workloadProofs: gate.byNode.hokon,
			provenCounts: gate.provenCounts,
		}).includes('jdk21'),
		'precondition: the gate withholds it from the standing offer'
	);
	assert.deepEqual(
		validateCapabilities(m, undefined, { workloadGate: gate }).filter(
			(f) => f.rule === 'floor-bypassed'
		),
		[]
	);
});

test('floor-bypassed: a backstop nothing has bootcamped is reported like any standing node', () => {
	// Until 2026-10-31 the backstop's declarations stood without a record. Now
	// "nothing has executed the probe" is a finding on every node.
	const m = baseManifest({ 'claw-1': healthyClaw() });
	m.machines!.hokon = {
		role: 'backstop',
		labels: ['pm2-host', 'taskauto', 'av1-nvenc'],
		minFreeMb: 8192,
	};
	const findings = validateCapabilities(m).filter((f) => f.rule === 'floor-bypassed');
	assert.deepEqual(findings.map((f) => [f.machine, f.capability]).sort(), [
		['hokon', 'av1-nvenc'],
		['hokon', 'pm2-host'],
	]);
	assert.match(findings[0].message, /no bootcamp record/);
});

test('#98 toolchain-unset: a missing or empty toolchain.capabilities fails', () => {
	for (const capabilities of [undefined, []]) {
		const m = baseManifest({ 'claw-1': healthyClaw() });
		m.toolchain = { ...m.toolchain, capabilities };
		assert.deepEqual(rules(m), ['toolchain-unset'], JSON.stringify(capabilities));
	}
});

test('#98 toolchain-unset: a missing or empty toolchain.toolCache fails', () => {
	for (const toolCache of [undefined, {}, { $why: 'x' }, { Python: [] }]) {
		const m = baseManifest({ 'claw-1': healthyClaw() });
		m.toolchain = { ...m.toolchain, toolCache };
		assert.deepEqual(rules(m), ['toolchain-unset'], JSON.stringify(toolCache));
	}
});

test('unsupported-claim: jit-canary on a node that holds standing runners', () => {
	// ONE finding. `registrationLabels` never projects a mint-only label onto a
	// standing registration, so the floor cannot count one as serving the
	// canary label — the claim itself is the mistake, and this is where it is
	// reported.
	assert.deepEqual(
		rules(baseManifest({ 'claw-1': healthyClaw({ labels: ['hadoku-builder', 'jit-canary'] }) })),
		['unsupported-claim']
	);
});

test('jit-canary on an ephemeral node is clean', () => {
	assert.deepEqual(
		rules(
			baseManifest({
				'claw-3': healthyClaw({ labels: ['hadoku-builder', 'jit-canary'], ephemeral: true }),
			})
		),
		[]
	);
});

test("a demanded label no node offers is NOT this static gate's finding any more", () => {
	// `floor-unoffered` read "watched" off a per-capability `floor` flag. What
	// the floor watches is now DEMAND, which only `fleet label-floor` can read
	// (every covered repo's workflows + job history), and that gate fails on
	// this exact case as `unoffered` (scripts/lib/label-floor.test.mjs).
	const m: FleetManifestShape = {
		machines: { hokon: hokonEarned(['pm2-host']) },
		toolchain: { capabilities: ['ffmpeg', 'python-venv'], toolCache: { Python: ['3.12'] } },
	};
	assert.deepEqual(rules(m), []);
});

test('probe-drift: a probeable capability the probe script never emits', () => {
	// av1-nvenc dropped; every other probeable capability present. Built by
	// REMOVING one from the registry rather than by listing the rest, so the test
	// still means "exactly one is missing" after a capability is added — spelling
	// the others out made adding `gh` produce two findings and fail a test that
	// was not about `gh`.
	const emits = probeableIds();
	emits.delete('av1-nvenc');
	assert.deepEqual(rules(baseManifest({ 'claw-1': healthyClaw() }), emits), ['probe-drift']);
});

test('probe-drift: a CAP line no registry entry claims', () => {
	// Everything the registry declares, plus one the registry does not.
	const emits = probeableIds();
	emits.add('not-a-capability'); // the stray
	assert.deepEqual(rules(baseManifest({ 'claw-1': healthyClaw() }), emits), ['probe-drift']);
});

test('omitting probeEmits skips the drift rule rather than passing it', () => {
	// A caller that could not read the probe must not report it as consistent.
	assert.deepEqual(rules(baseManifest({ 'claw-1': healthyClaw() }), undefined), []);
});

test('parseProbeCapabilities reads the probe script this package ships', () => {
	const text = readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8');
	const emits = parseProbeCapabilities(text);
	assert.ok(emits, 'the probe script must yield at least one `say` call');
	// Compared against the REGISTRY, not against a literal. The message below is
	// the whole point of the test — the registry and the script are the two
	// artefacts that must agree — and a hand-maintained third list is one more
	// copy to forget, which is how `gh` reached three nodes without one.
	assert.deepEqual(
		[...emits].sort(),
		[...probeableIds()].sort(),
		'the registry and the probe script must name the same capabilities'
	);
});

test('parseProbeCapabilities returns null rather than an empty set', () => {
	// An empty set would make the drift rule report every probeable capability as
	// missing — a parser failure rendering as a fleet finding.
	assert.equal(parseProbeCapabilities('#!/usr/bin/env bash\nset -u\n'), null);
});

test('the committed fleet manifest validates clean against the registry', () => {
	const text = readFileSync(resolve(ROOT, 'manifests', 'fleet-runner-manifest.json'), 'utf8');
	const probe = parseProbeCapabilities(
		readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8')
	);
	assert.ok(probe);
	const manifest = JSON.parse(text) as FleetManifestShape;
	// No `$proof` records exist for a fixture, which is a DORMANT gate — what
	// `workloadGateContext` builds from an empty state dir, exactly as the
	// reconciler and the schema gate would.
	const findings = validateCapabilities(manifest, probe, {
		workloadGate: workloadGateContext(Object.keys(manifest.machines ?? {}), {}),
	});
	assert.deepEqual(
		findings.map((f) => `[${f.rule}] ${f.machine ?? '-'} ${f.capability ?? '-'}`),
		[]
	);
});
