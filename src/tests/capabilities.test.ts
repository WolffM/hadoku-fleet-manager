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
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	CAPABILITIES,
	capability,
	eligibilityLabels,
	freshPassingProofs,
	identityLabels,
	isProofFresh,
	jobProofBudgetFindings,
	judgeMeasurement,
	judgeWorkloadProof,
	labelCapabilities,
	measuredIdleOnly,
	meetsBar,
	nodeOffer,
	parseProbeCapabilities,
	probeableIds,
	proofBudget,
	registrationLabels,
	requiredIdentitySet,
	validateCapabilities,
	workloadGateContext,
	workloadGateReasons,
	workloadGateStatus,
	workloadGatedCapabilities,
	WORKLOAD_PROOF_DUE_DAYS,
	type Capability,
	type FleetManifestShape,
	type ManifestNode,
	type WorkloadGateContext,
	ephemeralOnlyLabels,
	verificationFor,
	IMPLICIT_LABELS,
} from '../capabilities.js';
import type { ProofRecord } from '../lib/measured.js';
import { BUILDER_LABEL, PM2_HOST_LABEL, BACKSTOP_LABEL } from '../runners/census.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
/** dist/tests/ -> dist/ -> <repo root> */
const ROOT = resolve(HERE, '..', '..');

const rules = (m: FleetManifestShape, probe?: Set<string>): string[] =>
	validateCapabilities(m, probe).map((f) => f.rule);

/** A node that satisfies every requirement, so a test perturbs ONE thing. */
const healthyClaw = (over: Partial<ManifestNode> = {}): ManifestNode => ({
	labels: ['hadoku-builder'],
	maxConcurrent: 2,
	minFreeMb: 1536,
	...over,
});

/** Enough nodes that the floor rules are satisfied by default. */
const baseManifest = (nodes: Record<string, ManifestNode>): FleetManifestShape => ({
	machines: {
		hokon: { role: 'guest', labels: ['pm2-host', 'taskauto', 'av1-nvenc'], minFreeMb: 8192 },
		...nodes,
	},
	toolchain: { capabilities: ['ffmpeg', 'python-venv'], toolCache: { Python: ['3.12'] } },
});

// ---------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------

test('every capability id is unique', () => {
	const ids = CAPABILITIES.map((c) => c.id);
	assert.equal(new Set(ids).size, ids.length);
});

test('exactly one capability is ELIGIBILITY, and it is hadoku-builder', () => {
	// Not style. Every derivation below assumes eligibility is the fast loop's
	// exclusive property; a second one would need fleet-loop.ts to learn about
	// it in the same change, and this is the assertion that says so.
	assert.deepEqual(eligibilityLabels(), ['hadoku-builder']);
	assert.equal(capability('hadoku-builder')?.kind, 'eligibility');
});

test('census re-exports resolve to the registry ids', () => {
	assert.equal(BUILDER_LABEL, 'hadoku-builder');
	assert.equal(PM2_HOST_LABEL, 'pm2-host');
	assert.equal(BACKSTOP_LABEL, 'hokon-backstop');
	for (const id of [BUILDER_LABEL, PM2_HOST_LABEL, BACKSTOP_LABEL]) {
		assert.ok(capability(id), `${id} must be a registry entry`);
	}
});

test('no capability carries a floor flag — what the floor watches is DEMAND (label-floor.ts)', () => {
	// The per-capability `floor` boolean is how `jdk21` and `cargo-bevy` came to
	// be watched by nothing: a standing-only floor could not express a label
	// claws serve by minting, so they were flagged out of it. One rule for every
	// label replaced the flag; a flag reappearing is a second policy beside it.
	for (const c of CAPABILITIES) {
		assert.ok(!Object.hasOwn(c, 'floor'), `${c.id} carries a floor flag again`);
	}
});

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

// ---------------------------------------------------------------------------
// requiredIdentitySet — hadoku-builder's required set, from ledger records
// ---------------------------------------------------------------------------

test('requiredIdentitySet unions capabilities across general-pool records only', () => {
	assert.deepEqual(
		[
			...requiredIdentitySet([
				{ fleetForm: true, selfHosted: true, hosted: false, capabilities: ['python-toolcache'] },
				{ fleetForm: true, selfHosted: true, hosted: false, capabilities: ['playwright'] },
				{ fleetForm: true, selfHosted: true, hosted: false, capabilities: ['python-toolcache'] },
			]),
		].sort(),
		['playwright', 'python-toolcache']
	);
});

test('requiredIdentitySet excludes hosted and non-fleet-form jobs', () => {
	// A repo must not raise the fleet-wide bar with a job no claw will ever run.
	assert.deepEqual(
		[
			...requiredIdentitySet([
				{ fleetForm: false, selfHosted: true, hosted: false, capabilities: ['docker'] },
				{ fleetForm: true, selfHosted: true, hosted: true, capabilities: ['ffmpeg'] },
				{ fleetForm: true, selfHosted: false, hosted: false, capabilities: ['playwright'] },
			]),
		],
		[]
	);
});

test('requiredIdentitySet on empty demand is the empty set', () => {
	assert.deepEqual([...requiredIdentitySet([])], []);
});

// ---------------------------------------------------------------------------
// jdk21 — cardtable#5, added 2026-10-05. forge-e2e/forge-jvm move off the
// production host onto claws with room for the JVM; the capability is EARNED
// (like cargo-bevy, av1-nvenc), never declared, and must never widen the
// general pool's REQUIRED SET (the label floor watches it like any demanded label).
// ---------------------------------------------------------------------------

test('jdk21 is registered as a differentiator between claws, earned by probe', () => {
	const cap = capability('jdk21');
	assert.ok(cap, 'jdk21 must be registered');
	assert.equal(cap.surface, 'label', 'routable by runs-on, like cargo-bevy/av1-nvenc');
	assert.equal(cap.kind, 'identity');
	assert.equal(cap.verify, 'probe', 'a declaration is a claim; only execution proves it');
	assert.equal(cap.rung, undefined, 'not on the priority ladder');
	assert.equal(cap.mintOnly, undefined, 'not a mint-only label like jit-canary');
});

test(
	"jdk21 is absent from the general pool's required set even when a PINNED job demands it " +
		"(cardtable#5's own forge-e2e shape)",
	() => {
		// The exact shape the wave brief names: forge-e2e runs on
		// [self-hosted, pm2-host] — pinned to one machine, not the general pool
		// — so `fleetForm` is false and the row must never raise the floor.
		const pinnedForgeE2e = {
			fleetForm: false,
			selfHosted: true,
			hosted: false,
			capabilities: ['jdk21'],
		};
		assert.deepEqual([...requiredIdentitySet([pinnedForgeE2e])], []);
		// And if jdk21 ever DID appear in a general-pool row (it does not today —
		// no covered repo asks for it on fromJSON(vars.CI_RUNNER) — the union
		// still works exactly like every other capability; this is not a
		// jdk21-specific exemption inside requiredIdentitySet itself).
		const generalPoolRow = {
			fleetForm: true,
			selfHosted: true,
			hosted: false,
			capabilities: ['jdk21'],
		};
		assert.deepEqual([...requiredIdentitySet([generalPoolRow])], ['jdk21']);
	}
);

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

// ---------------------------------------------------------------------------
// wave 4e (#102) — bootcamp earns the workload, not just the tool
// ---------------------------------------------------------------------------

/** One (node, capability) proof, with sane defaults a test perturbs. */
const proof = (over: Partial<ProofRecord> = {}): ProofRecord => ({
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

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

test('jdk21 declares a WORKLOAD jobProof — inputs, budget, and a regex that compiles', () => {
	const cap = capability('jdk21')!;
	assert.ok(cap.jobProof, 'jdk21 must declare a jobProof');
	assert.equal(cap.jobProof!.repo, 'WolffM/hadoku-cardtable');
	assert.equal(cap.jobProof!.workflow, 'forge.yml');
	assert.equal(cap.jobProof!.job, 'forge-e2e');
	assert.deepEqual(cap.jobProof!.inputs, { only: 'e2e', specs: 'play.spec.ts arrow.spec.ts' });
	assert.deepEqual(cap.jobProof!.budget, { factor: 1.5, minProven: 2 });
	assert.doesNotThrow(() => new RegExp(cap.jobProof!.evidence, 'i'));
	// taskauto keeps its OLD shape exactly — a plain jobProof, no budget, no inputs.
	const taskauto = capability('taskauto')!;
	assert.equal(taskauto.jobProof?.budget, undefined);
	assert.equal(taskauto.jobProof?.inputs, undefined);
});

test('workloadGatedCapabilities is jdk21 alone — a budget is the discriminator, not merely having a jobProof', () => {
	assert.deepEqual(workloadGatedCapabilities(), ['jdk21']);
});

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

test('isProofFresh: within the 30-day cadence is fresh, past it is not, and a tie is fresh', () => {
	// ONE clock for both sides. `ago()` reads Date.now() and isProofFresh reads
	// it again, so under load the "exact tie" landed a millisecond past 30 days
	// and failed: it refused two pushes on 2026-10-10 inside the shifted-clock
	// guard, and passed every time it was rerun alone.
	const now = new Date();
	const at = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
	assert.equal(isProofFresh(proof({ at: at(1) }), now), true);
	assert.equal(isProofFresh(proof({ at: at(29) }), now), true);
	assert.equal(
		isProofFresh(proof({ at: at(30) }), now),
		true,
		'exactly the boundary counts as fresh'
	);
	assert.equal(isProofFresh(proof({ at: at(31) }), now), false);
	assert.equal(
		WORKLOAD_PROOF_DUE_DAYS,
		30,
		'pinned to the same cadence as fleet benchmark --due 30'
	);
});

test('freshPassingProofs: only the matching capability, a PASS, and fresh', () => {
	const records = [
		proof({ node: 'claw-4' }),
		proof({ node: 'claw-8', verdict: 'fail' }),
		proof({ node: 'claw-9', at: ago(60) }),
		proof({ node: 'claw-5', capability: 'other' }),
	];
	assert.deepEqual(
		freshPassingProofs(records, 'jdk21').map((r) => r.node),
		['claw-4']
	);
});

test('proofBudget: unbootstrapped below minProven, bootstrapped at it, median x factor', () => {
	const cap = capability('jdk21')!; // factor 1.5, minProven 2
	const one = proofBudget(cap, [proof({ node: 'claw-4', durationSec: 300 })]);
	assert.equal(one.bootstrapped, false);
	assert.equal(one.budgetSec, null);
	assert.equal(one.provenCount, 1);

	const two = proofBudget(cap, [
		proof({ node: 'claw-4', durationSec: 300 }),
		proof({ node: 'claw-8', durationSec: 500 }),
	]);
	assert.equal(two.bootstrapped, true);
	assert.equal(two.provenCount, 2);
	assert.equal(two.budgetSec, 400 * 1.5, 'median of 300/500 is 400, x the 1.5 factor');

	const three = proofBudget(cap, [
		proof({ node: 'claw-4', durationSec: 300 }),
		proof({ node: 'claw-8', durationSec: 500 }),
		proof({ node: 'claw-9', durationSec: 700 }),
	]);
	assert.equal(three.budgetSec, 500 * 1.5, 'odd count: the middle value, no averaging');

	// STALE and FAIL records, and a different capability, never feed the median.
	const poisoned = proofBudget(cap, [
		proof({ node: 'claw-4', durationSec: 300 }),
		proof({ node: 'claw-8', durationSec: 999_999, verdict: 'stale' }),
		proof({ node: 'claw-9', durationSec: 999_999, verdict: 'fail' }),
		proof({ node: 'claw-5', durationSec: 999_999, capability: 'other' }),
	]);
	assert.equal(poisoned.provenCount, 1, 'only the one real pass counts');

	assert.deepEqual(proofBudget(undefined, []), {
		bootstrapped: false,
		budgetSec: null,
		provenCount: 0,
	});
});

test('judgeWorkloadProof: a job that did not land, failed, or had no evidence is FAIL, named why', () => {
	const cap = capability('jdk21')!;
	const unbootstrapped = { bootstrapped: false, budgetSec: null, provenCount: 0 };
	assert.equal(
		judgeWorkloadProof(
			cap,
			{ conclusion: null, ranOnTarget: false, evidenceMatched: false, durationSec: null },
			unbootstrapped
		).verdict,
		'fail'
	);
	assert.equal(
		judgeWorkloadProof(
			cap,
			{ conclusion: 'failure', ranOnTarget: true, evidenceMatched: false, durationSec: 100 },
			unbootstrapped
		).verdict,
		'fail'
	);
	assert.match(
		judgeWorkloadProof(
			cap,
			{ conclusion: 'failure', ranOnTarget: true, evidenceMatched: false, durationSec: 100 },
			unbootstrapped
		).why,
		/concluded "failure"/
	);
	const noEvidence = judgeWorkloadProof(
		cap,
		{ conclusion: 'success', ranOnTarget: true, evidenceMatched: false, durationSec: 100 },
		unbootstrapped
	);
	assert.equal(noEvidence.verdict, 'fail');
	assert.match(noEvidence.why, /no evidence/);
});

test('judgeWorkloadProof: unbootstrapped PASSES on conclusion+evidence alone, and says so', () => {
	const cap = capability('jdk21')!;
	const r = judgeWorkloadProof(
		cap,
		{ conclusion: 'success', ranOnTarget: true, evidenceMatched: true, durationSec: 100_000 },
		{ bootstrapped: false, budgetSec: null, provenCount: 1 }
	);
	assert.equal(r.verdict, 'pass');
	assert.match(r.why, /unbootstrapped: 1\/2/);
});

test('judgeWorkloadProof: bootstrapped enforces the budget — within it passes, over it fails', () => {
	const cap = capability('jdk21')!;
	const bootstrapped = { bootstrapped: true, budgetSec: 600, provenCount: 2 };
	const within = judgeWorkloadProof(
		cap,
		{ conclusion: 'success', ranOnTarget: true, evidenceMatched: true, durationSec: 599 },
		bootstrapped
	);
	assert.equal(within.verdict, 'pass');
	const over = judgeWorkloadProof(
		cap,
		{ conclusion: 'success', ranOnTarget: true, evidenceMatched: true, durationSec: 601 },
		bootstrapped
	);
	assert.equal(over.verdict, 'fail');
	assert.match(over.why, /against a 10\.0 min/);
	const noDuration = judgeWorkloadProof(
		cap,
		{ conclusion: 'success', ranOnTarget: true, evidenceMatched: true, durationSec: null },
		bootstrapped
	);
	assert.equal(noDuration.verdict, 'fail');
	assert.match(noDuration.why, /no duration recorded/);
});

test('workloadGateStatus: DORMANT offers regardless of a missing record — "routing stays exactly as today"', () => {
	const cap = capability('jdk21')!; // minProven 2
	const s = workloadGateStatus(cap, null, 1);
	assert.equal(s.offer, true);
	assert.equal(s.active, false);
	assert.match(s.reason, /dormant: 1\/2/);
});

test('workloadGateStatus: ACTIVE withholds with no record, offers a fresh pass', () => {
	const cap = capability('jdk21')!;
	const noRecord = workloadGateStatus(cap, null, 2);
	assert.equal(noRecord.offer, false);
	assert.equal(noRecord.active, true);
	assert.match(noRecord.reason, /no workload proof/);
	const fresh = workloadGateStatus(cap, proof({ at: ago(1) }), 2);
	assert.equal(fresh.offer, true);
	assert.match(fresh.reason, /PASSED/);
});

test('workloadGateStatus: an EXPLICIT fail or stale withdraws the label whether the gate is active or dormant', () => {
	const cap = capability('jdk21')!;
	for (const provenCount of [0, 2]) {
		const failed = workloadGateStatus(
			cap,
			proof({ verdict: 'fail', why: '27/62 specs' }),
			provenCount
		);
		assert.equal(failed.offer, false, `provenCount=${provenCount}`);
		assert.match(failed.reason, /workload FAILED: 27\/62 specs/);
		const stale = workloadGateStatus(
			cap,
			proof({ verdict: 'stale', why: 'diverged' }),
			provenCount
		);
		assert.equal(stale.offer, false, `provenCount=${provenCount}`);
		assert.match(stale.reason, /workload STALE: diverged/);
	}
});

test('workloadGateStatus: an ACTIVE gate also withholds an EXPIRED pass — age, not just verdict', () => {
	const cap = capability('jdk21')!;
	const expired = workloadGateStatus(cap, proof({ at: ago(31) }), 2);
	assert.equal(expired.offer, false);
	assert.match(expired.reason, /EXPIRED/);
});

test('workloadGateStatus: a capability with no budget is never gated', () => {
	assert.deepEqual(workloadGateStatus(capability('taskauto'), null, 0), {
		offer: true,
		active: false,
		provenCount: 0,
		reason: 'not workload-gated',
	});
});

// ---------------------------------------------------------------------------
// nodeOffer's fourth kind of evidence — the workload gate itself
// ---------------------------------------------------------------------------

/** A node that has EARNED jdk21's tool proof this run (or on record). */
const jdk21Earner = (extra: Partial<ManifestNode> = {}): ManifestNode => ({
	labels: [],
	$capabilities: { earned: ['jdk21'], prereqs: [] },
	...extra,
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

test('workloadGateReasons: reports only ids the node EARNED the tool for, one gate status each', () => {
	assert.deepEqual(workloadGateReasons({ labels: [] }, { jdk21: null }, { jdk21: 2 }), {});
	const reasons = workloadGateReasons(jdk21Earner(), { jdk21: null }, { jdk21: 2 });
	assert.deepEqual(Object.keys(reasons), ['jdk21']);
	assert.equal(reasons.jdk21.offer, false);
});

// ---------------------------------------------------------------------------
// excludeRepos must never gate a proof dispatch (wave 4e §A.5) — nodeOffer/the
// registry side. The dispatch-path regression test lives in prove-job.test.ts.
// ---------------------------------------------------------------------------

test('nodeOffer and the registry know nothing about excludeRepos — a proof can target an excluded node', () => {
	// A structural pin: excludeRepos is not even a field this module reads
	// anywhere. The real proof is prove-job.test.ts's dispatch against a node
	// whose excludeRepos names the proof's own repo.
	const src = readFileSync(resolve(ROOT, 'src', 'capabilities.ts'), 'utf8');
	assert.doesNotMatch(src, /excludeRepos/, 'capabilities.ts must never consult excludeRepos');
});

// ---------------------------------------------------------------------------
// Validation — one test per arm, each proving the arm FIRES
// ---------------------------------------------------------------------------

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

test('#98 missing-required-field: a GUEST is not eligible, so it does not owe the builder throttle', () => {
	const m = baseManifest({ 'claw-1': healthyClaw() });
	assert.equal(m.machines?.hokon?.maxConcurrent, undefined, 'the fixture guest declares none');
	assert.deepEqual(rules(m), []);
});

/** hokon's live shape (2026-10-10): guest, standing, earned what a claw earns. */
const hokonEarned = (earned: string[]): ManifestNode => ({
	role: 'guest',
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

test('floor-bypassed: a guest whose bootcamp record does NOT earn a declared probe label is reported', () => {
	// The floor counts hokon's standing runners online as SERVING av1-nvenc;
	// the record bootcamp wrote says the probe never earned it.
	const m = baseManifest({ 'claw-1': healthyClaw() });
	m.machines!.hokon = hokonEarned(['pm2-host']);
	const findings = validateCapabilities(m, undefined, { workloadGate: activeJdkGate(null) });
	assert.deepEqual(
		findings.filter((f) => f.rule === 'floor-bypassed').map((f) => [f.machine, f.capability]),
		[['hokon', 'av1-nvenc']]
	);
	assert.match(findings.find((f) => f.rule === 'floor-bypassed')!.message, /evidence contradicts/);
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

test('floor-bypassed: a guest nothing has bootcamped keeps its declarations (the documented exception)', () => {
	assert.deepEqual(rules(baseManifest({ 'claw-1': healthyClaw() })), []);
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
		machines: { hokon: { role: 'guest', labels: ['pm2-host', 'taskauto'], minFreeMb: 8192 } },
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
	emits.add('docker'); // the stray
	assert.deepEqual(rules(baseManifest({ 'claw-1': healthyClaw() }), emits), ['probe-drift']);
});

test('omitting probeEmits skips the drift rule rather than passing it', () => {
	// A caller that could not read the probe must not report it as consistent.
	assert.deepEqual(rules(baseManifest({ 'claw-1': healthyClaw() }), undefined), []);
});

// ---------------------------------------------------------------------------
// The probe parser, and the real artefacts
// ---------------------------------------------------------------------------

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
	// `nvenc-h264` and `watchparty-media` joined it 2026-10-23 (fleet-manager#3)
	// on `jdk21`'s reasoning: earned from the bootcamp record, never declared.
	const runtimeWritten = new Set([
		'hokon-backstop',
		'hadoku-builder',
		'cargo-bevy',
		'jdk21',
		'jit-canary',
		'nvenc-h264',
		'watchparty-media',
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

/**
 * THE PROBE MEASURES; THE REGISTRY JUDGES.
 *
 * These cover `meetsBar`, the single comparator every MEASURED capability goes
 * through. The point of it is that the next payload capability — a bigger JVM
 * build, a GPU transcode, whatever earns a label next — is a registry entry and
 * a probe block that prints a number, not another branch in bootcamp. If this
 * comparator is right once, it is right for all of them.
 */
test('meetsBar: a binary capability still passes on ok alone', () => {
	const cap = capability('gh');
	assert.equal(cap?.measure, undefined, 'gh is binary and must stay that way');
	assert.equal(meetsBar(cap, true, 'gh version 2.46.0').proven, true);
	assert.equal(meetsBar(cap, false, 'absent').proven, false);
});

test('meetsBar: an unknown capability is never proven', () => {
	assert.equal(meetsBar(undefined, true, '999').proven, false);
});

test('meetsBar: a measured capability is judged by the NUMBER, not by ok', () => {
	const cap = {
		id: 'x',
		kind: 'eligibility',
		surface: 'label',
		verify: 'probe',
		label: 'test',
		description: 'test',
		measure: { metric: 'throughput', unit: '/min', atLeast: 100, why: 'test' },
	} as const;
	// `ok` from the probe means "I measured it", not "it passed".
	assert.equal(meetsBar(cap, true, '150').proven, true);
	assert.equal(meetsBar(cap, true, '99').proven, false);
	assert.match(meetsBar(cap, true, '99').reason, /99\/min < 100\/min required/);
});

test('meetsBar: atMost bounds the other direction', () => {
	const cap = {
		id: 'x',
		kind: 'eligibility',
		surface: 'label',
		verify: 'probe',
		label: 'test',
		description: 'test',
		measure: { metric: 'build time', unit: 's', atMost: 600, why: 'test' },
	} as const;
	assert.equal(meetsBar(cap, true, '420').proven, true);
	assert.equal(meetsBar(cap, true, '900').proven, false);
	assert.match(meetsBar(cap, true, '900').reason, /900s > 600s allowed/);
});

/**
 * A probe that printed prose where a number was declared has not shown the node
 * can do anything. Reading that as a pass is the same silence this registry
 * refuses everywhere else — and it is the likeliest failure when someone adds
 * the next measured capability and forgets to print the figure.
 */
test('meetsBar: an unparseable measurement FAILS and says so', () => {
	const cap = {
		id: 'x',
		kind: 'eligibility',
		surface: 'label',
		verify: 'probe',
		description: 'test',
		label: 'test',
		measure: { metric: 'throughput', unit: '/min', atLeast: 10, why: 'test' },
	} as const;
	const v = meetsBar(cap, true, 'looked fine');
	assert.equal(v.proven, false);
	assert.match(v.reason, /not a number/);
});

test('meetsBar: the first number wins, so a probe may print units after it', () => {
	const cap = {
		id: 'x',
		kind: 'eligibility',
		surface: 'label',
		label: 'test',
		description: 'test',
		verify: 'probe',
		measure: { metric: 'throughput', unit: ' crates/min', atLeast: 10, why: 'test' },
	} as const;
	assert.equal(meetsBar(cap, true, '42 crates/min (430 in 612s)').proven, true);
});

/** Every declared bar must carry its derivation — a number with no why is a guess. */
test('every measured capability states WHY its bar is that number', () => {
	for (const c of CAPABILITIES) {
		if (!c.measure) continue;
		assert.ok(c.measure.why && c.measure.why.length > 30, `${c.id}'s bar needs a real why`);
		assert.ok(
			typeof c.measure.atLeast === 'number' || typeof c.measure.atMost === 'number',
			`${c.id} declares a measure with no bound`
		);
	}
});

// ---------------------------------------------------------------------------
// cargo-bevy — the first measured capability, pinned to the data it came from
// ---------------------------------------------------------------------------

/**
 * THE SEVEN MEASUREMENTS THE BAR WAS DERIVED FROM
 * (`docs/planning/payload-routing-2026-09-14.md` §6, taken 2026-09-14).
 *
 * `proxy` is what `capability-probe.sh`'s cargo-bevy block printed on that node;
 * `buildMinutes` is the cold `cargo build --workspace --locked` of
 * brave-quartet's 12-crate Bevy 0.18 workspace on real disk; `earns` is the
 * routing decision §6 argued for.
 *
 * Kept here rather than only in prose because a bar with no data beside it is
 * re-tunable by anyone who finds it inconvenient. Move the number and this test
 * names which node changed sides.
 */
const CARGO_BEVY_MEASURED = [
	{ node: 'claw-7', proxy: 3528, buildMinutes: 6.9, earns: true },
	{ node: 'claw-4', proxy: 2281, buildMinutes: 10.9, earns: true },
	{ node: 'claw-6', proxy: 1529, buildMinutes: 17.0, earns: true },
	{ node: 'claw-2', proxy: 1521, buildMinutes: 24.0, earns: true },
	{ node: 'claw-1', proxy: 1495, buildMinutes: 18.7, earns: true },
	{ node: 'claw-3', proxy: 923, buildMinutes: 47.0, earns: false },
	{ node: 'claw-5', proxy: 734, buildMinutes: 33.4, earns: false },
] as const;

test('cargo-bevy is a LABEL identity capability', () => {
	const cap = capability('cargo-bevy');
	assert.ok(cap, 'cargo-bevy must be registered');
	// Each of these is load-bearing somewhere else:
	//   surface 'label'   — routable by brave-quartet's runs-on at all
	//   kind 'identity'   — `nodeOffer` promotes only identity labels out of the
	//                       bootcamp record; an 'eligibility' one is the tier
	//                       ladder's to write and bootcamp NEVER_WRITTEN would
	//                       skip it entirely
	//   verify 'probe'    — a declaration is a claim, and the whole point here is
	//                       that the box demonstrates the speed
	// (The label floor watches it like every demanded label — label-floor.ts.)
	assert.equal(cap.surface, 'label');
	assert.equal(cap.kind, 'identity');
	assert.equal(cap.verify, 'probe');
	assert.equal(cap.measure?.atLeast, 1200, 'the bar §6 derived');
	assert.equal(cap.measure?.atMost, undefined, 'faster is never worse');
});

test('the bar admits exactly the five nodes the payload measurement says it should', () => {
	const cap = capability('cargo-bevy');
	for (const m of CARGO_BEVY_MEASURED) {
		const v = meetsBar(cap, true, String(m.proxy));
		assert.equal(
			v.proven,
			m.earns,
			`${m.node} measured ${m.proxy} (${m.buildMinutes} min build) and the bar says ` +
				`${v.proven ? 'earns' : 'does not earn'}: ${v.reason}`
		);
	}
	assert.equal(CARGO_BEVY_MEASURED.filter((m) => m.earns).length, 5);
});

test('the bar sits in the empty band, so the proxy inversion cannot flip anybody', () => {
	// §6's two inversions vs the real build: claw-2 (24.0 min) proxies 2% above
	// claw-1 (18.7 min), and claw-5 (33.4 min) proxies below claw-3 (47.0 min).
	// Both are harmless ONLY because the bar has clear air on either side — the
	// nearest earner is 1495 and the nearest refusal 923. A re-tune that lands
	// inside that band is a coin flip deciding where a 40-minute compile goes.
	const bar = capability('cargo-bevy')?.measure?.atLeast ?? 0;
	const lowestEarner = Math.min(...CARGO_BEVY_MEASURED.filter((m) => m.earns).map((m) => m.proxy));
	const highestRefusal = Math.max(
		...CARGO_BEVY_MEASURED.filter((m) => !m.earns).map((m) => m.proxy)
	);
	assert.ok(
		highestRefusal < bar && bar < lowestEarner,
		`${highestRefusal} < ${bar} < ${lowestEarner}`
	);
	// The gap must stay WIDER than the inversion it has to absorb.
	const inversion = 1521 - 1495;
	assert.ok(
		bar - highestRefusal > inversion && lowestEarner - bar > inversion,
		'the bar has less clear air than the proxy has noise'
	);
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

test('an absent rustc reports why, and is never read as a slow node', () => {
	// The probe prints `no no-rustc` / `no compile-failed` rather than `0`. A
	// zero would clear `Number.isFinite` and be judged as a measurement that
	// failed the bar — "this box is slow" — when the truth is that the question
	// was never asked. Different finding, different remedy.
	const cap = capability('cargo-bevy');
	const v = meetsBar(cap, false, 'no-rustc');
	assert.equal(v.proven, false);
	assert.equal(v.reason, 'no-rustc');
	assert.match(meetsBar(cap, true, 'measured-it').reason, /not a number/);
});

// ---------------------------------------------------------------------------
// IDLE-ONLY measurements (2026-10-10). claw-4 2281 idle / 1169 beside CI,
// claw-6 1529 / 1024: a throughput figure taken beside a job measures the job.
// ---------------------------------------------------------------------------

test('cargo-bevy is IDLE-ONLY; pm2-capable (installed memory) declares why load cannot move it', () => {
	assert.equal(measuredIdleOnly(capability('cargo-bevy')), true);
	assert.equal(measuredIdleOnly(capability('pm2-capable')), false);
	assert.equal(
		measuredIdleOnly(capability('ffmpeg')),
		false,
		'a binary capability is not measured'
	);
	// THE DEFAULT IS IDLE-ONLY. A new measured capability that says nothing
	// about load must not be judged beside a job by omission.
	const bare: Capability = {
		...(capability('cargo-bevy') as Capability),
		measure: { metric: 'm', unit: 'u', atLeast: 1, why: 'w' },
	};
	assert.equal(measuredIdleOnly(bare), true);
});

test('judgeMeasurement: only a counted ZERO lets an idle-only measurement be judged', () => {
	const cap = capability('cargo-bevy');
	// Idle and below the bar IS a verdict — the node is slow.
	const slowIdle = judgeMeasurement(cap, true, '1024', 0);
	assert.deepEqual(
		{ proven: slowIdle.proven, judged: slowIdle.judged },
		{ proven: false, judged: true }
	);
	assert.match(slowIdle.reason, /1024.* < 1200/);
	assert.equal(judgeMeasurement(cap, true, '2281', 0).proven, true);
	// Busy, or uncounted: neither earned nor failed. Both directions — a busy
	// node can read low (claw-6, 1024) and must not be stripped; a high reading
	// beside a job is not evidence either.
	for (const workers of [1, 3, null, undefined]) {
		for (const [ok, detail] of [
			[true, '1024'],
			[true, '2281'],
			[false, 'compile-failed'],
		] as const) {
			const v = judgeMeasurement(cap, ok, detail, workers);
			assert.equal(v.judged, false, `judged under load (${workers}) for ${detail}`);
			assert.equal(v.proven, false);
			assert.match(v.reason, /measured under load .* not judged/);
		}
	}
	assert.match(judgeMeasurement(cap, true, '1024', 2).reason, /2 live Runner\.Worker/);
	assert.match(judgeMeasurement(cap, true, '1024', null).reason, /count unknown/);
});

test('judgeMeasurement: a load-invariant or binary capability is judged whatever the load', () => {
	const pm2 = judgeMeasurement(capability('pm2-capable'), true, '7849', 4);
	assert.equal(pm2.judged, true);
	assert.equal(pm2.proven, false, 'installed memory below the bar is a verdict even on a busy box');
	const ff = judgeMeasurement(capability('ffmpeg'), true, '7.1.5', null);
	assert.deepEqual({ proven: ff.proven, judged: ff.judged }, { proven: true, judged: true });
});

test('the probe measures EXACTLY the registry’s idle-only set between its markers, each with a LOAD line', () => {
	// The registry says WHICH capabilities are idle-only; the probe says which
	// block bootcamp re-runs on a drained node. A measured capability added to
	// the registry but measured OUTSIDE the markers would be taken beside CI by
	// every bootcamp — and one inside them with no LOAD line would never be
	// judged at all, since an uncounted measurement is unjudged.
	const text = readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8');
	const start = text.indexOf('# >>> IDLE-ONLY MEASUREMENTS');
	const end = text.indexOf('# <<< IDLE-ONLY MEASUREMENTS');
	assert.ok(start > 0 && end > start, 'both markers must exist, in order');
	const section = text.slice(start, end);
	const said = parseProbeCapabilities(section) ?? new Set<string>();
	const idleOnly = new Set(CAPABILITIES.filter(measuredIdleOnly).map((c) => c.id));
	assert.deepEqual([...said].sort(), [...idleOnly].sort());
	for (const id of idleOnly) {
		assert.match(section, new RegExp(`printf 'LOAD ${id} `), `${id} must print its LOAD line`);
	}
	// And the measured phase ENDS at the marker: nothing after it runs on a
	// drained node.
	const after = text.slice(end);
	assert.match(after.slice(0, 200), /CAP_PROBE_PHASE" = measured[\s\S]*exit 0/);
});

// ---------------------------------------------------------------------------
// pm2-host — IS this box the host (proved since #6, NARROWED in wave 3o), and
// role-honoured on a guest. "Could it be" is `pm2-capable`, further down.
// ---------------------------------------------------------------------------

test('pm2-host is PROVEN BY EXECUTION, not by somebody typing it', () => {
	// The DECLARED path is retired for every non-guest: `nodeOffer` REPLACES a
	// declared probe-verified label with the proof record, so a claw cannot type
	// its way into the six workflows that route on this. hokon's declaration
	// survives because it is a GUEST and `verificationFor` reads every label on a
	// guest as `role` — that exception is held by the ROLE, not by this entry,
	// and the test below pins it.
	//
	// REVERT `verify` TO 'role' AND THIS FAILS, which is the point: every other
	// assertion in this file is derived from the registry and would quietly
	// follow the entry back.
	const cap = capability('pm2-host');
	assert.ok(cap, 'pm2-host must be registered');
	assert.equal(cap.verify, 'probe');
	assert.equal(cap.surface, 'label');
	assert.equal(cap.kind, 'identity');
	assert.equal(cap.rung, 1, 'and it is still the top rung of the ladder');
	assert.equal(cap.measure, undefined, 'binary: pm2 supervises a process or it does not');
});

test('the probe script really emits pm2-host — a registry claim is not evidence', () => {
	// The drift rule is what turns a `verify: "probe"` nothing executes into a
	// finding, and it reads the script. This reads it too, by name, so the entry
	// above cannot be flipped without the shell block that answers it.
	const emits = parseProbeCapabilities(
		readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8')
	);
	assert.ok(emits?.has('pm2-host'));
});

test('verificationFor: a GUEST label is role-verified whatever the registry says', () => {
	const cap = capability('pm2-host');
	assert.equal(verificationFor({ role: 'guest' }, cap), 'role');
	assert.equal(verificationFor({ role: 'claw' }, cap), 'probe');
	// ABSENT reads as claw — the strict direction. A node nobody classified is
	// held to the bar rather than exempted from it.
	assert.equal(verificationFor({}, cap), 'probe');
	assert.equal(verificationFor({ role: 'gest' }, cap), 'probe', 'a typo must not exempt');
});

test('verificationFor narrows nothing that is not a routable label', () => {
	// A guest declares labels; it does not declare a toolchain or implicit
	// capability, and neither is routable, so neither may be silently downgraded
	// to "the declaration is the evidence".
	assert.equal(verificationFor({ role: 'guest' }, capability('ffmpeg')), 'probe');
	assert.equal(verificationFor({ role: 'guest' }, capability('jitconfig')), 'probe');
	// And an id the registry does not know has no verification at all, rather
	// than a guessed one.
	assert.equal(verificationFor({ role: 'guest' }, capability('docker')), undefined);
});

// ---------------------------------------------------------------------------
// pm2-capable — CAN this box host the role, asked apart from whether it IS the
// host (wave 3o, lane C)
// ---------------------------------------------------------------------------

test('pm2-capable is probed, measured, and NOT a routing label', () => {
	const cap = capability('pm2-capable');
	assert.ok(cap, 'pm2-capable must be registered');
	assert.equal(cap.verify, 'probe', 'a capability is proved by execution or it is a claim');
	assert.equal(cap.kind, 'identity');
	// THE LOAD-BEARING ONE. See the routing test below for what a `label` here
	// would do; this is the same property asserted at the registry, so a flip is
	// caught by the entry as well as by the behaviour.
	assert.equal(cap.surface, 'implicit');
	assert.equal(cap.rung, undefined, 'it is not a rung of the priority ladder — pm2-host is');
	assert.equal(cap.measure?.atLeast, 9784, 'resident-placement §1.6, the ROLE steady figure');
	assert.equal(cap.measure?.unit, 'MiB');
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

test('the bar admits the six claws that can hold the role and refuses the two that cannot', () => {
	// Installed memory, measured on every claw 2026-09-26 (`/proc/meminfo`
	// MemTotal). The bar is `resident-placement-2026-09-10.md` §1.6's steady
	// figure for the ROLE — 9,784 MiB — not its first tenant's footprint.
	const MEASURED = [
		{ node: 'claw-1', memTotalMib: 11885, earns: true },
		{ node: 'claw-2', memTotalMib: 7872, earns: false },
		{ node: 'claw-3', memTotalMib: 15918, earns: true },
		{ node: 'claw-4', memTotalMib: 15936, earns: true },
		{ node: 'claw-5', memTotalMib: 15877, earns: true },
		{ node: 'claw-6', memTotalMib: 7849, earns: false },
		{ node: 'claw-8', memTotalMib: 15915, earns: true },
		{ node: 'claw-9', memTotalMib: 32003, earns: true },
	] as const;
	const cap = capability('pm2-capable');
	for (const m of MEASURED) {
		const v = meetsBar(cap, true, String(m.memTotalMib));
		assert.equal(v.proven, m.earns, `${m.node} measured ${m.memTotalMib} MiB: ${v.reason}`);
	}
	assert.equal(MEASURED.filter((m) => m.earns).length, 6);
	// AND THE REFUSAL SAYS THE NUMBER. "did not earn it" and "has 7,872 MiB
	// against a 9,784 MiB role" are different findings with different remedies —
	// the second one names the RAM stick that would fix it.
	assert.match(meetsBar(cap, true, '7849').reason, /7849MiB < 9784MiB required/);
});

test('a pm2-capable probe that could not run reports WHY, and is never read as a small box', () => {
	// The probe prints a named token — `supervisor-install-failed`,
	// `did-not-survive-supervisor-restart` — rather than `0`. A zero clears
	// `Number.isFinite` and would be judged as a box that is too small, when the
	// truth is that the question was never answered. Same rule the `cargo-bevy`
	// block above states; asserted here because this probe has SIX failure modes
	// and a firewall, a dead dump file and 8 GB of RAM are three different jobs.
	const cap = capability('pm2-capable');
	for (const token of [
		'no-node-runtime-on-stock-path',
		'no-workdir-under-home',
		'supervisor-install-failed',
		'could-not-save-process-list',
		'did-not-survive-supervisor-restart',
		'resurrect-reattached-rather-than-restarted',
	]) {
		const v = meetsBar(cap, false, token);
		assert.equal(v.proven, false);
		assert.equal(v.reason, token, 'the probe’s reason must survive to the report verbatim');
	}
	assert.match(meetsBar(cap, true, 'it-worked').reason, /not a number/);
});

test('the probe script really emits pm2-capable — a registry claim is not evidence', () => {
	const emits = parseProbeCapabilities(
		readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8')
	);
	assert.ok(emits?.has('pm2-capable'));
});

test('the pm2-capable probe provisions under $HOME and leaves no cache behind', () => {
	// READ OFF THE SHIPPED SCRIPT, not off a comment. Two properties, both
	// measured failures elsewhere in this fleet:
	//
	//   1. NOT /tmp. `/tmp` is TMPFS at ~50% of installed on every claw, so a
	//      41 MB npm tree there is 41 MB of RAM taken out of the very headroom
	//      this capability is about — on the node least able to spare it. A probe
	//      that wrote to tmpfs has already faked one capability failure here.
	//   2. THE NPM CACHE IS REDIRECTED. Without `--cache` npm populates `~/.npm`,
	//      which SURVIVES the probe. An install that leaves a cache behind has
	//      persisted, whatever it did with node_modules — and "prove without
	//      persisting" is the whole shape of this capability.
	const text = readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8');
	const block = text.slice(text.indexOf('pm2cap_try() {'));
	assert.ok(block.length > 0, 'the pm2-capable probe function must exist');
	assert.match(block, /mktemp -d "\$HOME\//, 'the work directory must be under $HOME, not /tmp');
	assert.ok(!/mktemp -d\s*\)/.test(block), 'a bare mktemp lands in /tmp');
	assert.match(block, /--cache "\$pc_d/, 'the npm cache must be redirected into the throwaway dir');
	// AND PM2_HOME IS EXPORTED BEFORE ANY pm2 RUNS. `pm2 kill` against the
	// DEFAULT home stops mgmt-api, the tunnel and the other production services on whatever box ran
	// it; the override is the only thing between this probe and that.
	const firstPm2 = block.indexOf('node "$pc_pm2"');
	const exported = block.indexOf('export PM2_HOME=');
	assert.ok(exported > 0 && exported < firstPm2, 'PM2_HOME must be exported before pm2 runs');
});

test('the pm2-host probe never LAUNCHES a daemon to find out whether one is running', () => {
	// `pm2 jlist` starts the God daemon when none is up, so asking the question
	// naively CREATES the footprint the answer is about — and on the production
	// host it would be a second daemon beside the real one. The liveness check is
	// therefore the pid file and the socket, and pm2 is only run after both.
	const text = readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8');
	const block = text.slice(text.indexOf('pm2_host_try() {'), text.indexOf('pm2cap_try() {'));
	const guard = block.indexOf('kill -0 "$ph_pid"');
	const firstRun = block.indexOf('pm2 jlist');
	assert.ok(guard > 0, 'the daemon must be confirmed alive from its own pid file');
	assert.ok(firstRun > guard, 'nothing may run pm2 before that guard');
	assert.match(block, /-S "\$ph_home\/rpc\.sock"/, 'and the socket must exist');
});

test('the pm2-capable probe proves SURVIVAL, not merely that a process started', () => {
	// THE GAP A MUTATION FOUND. Every other assertion in this file survived
	// deleting the `resurrect` step from the probe — so "it survives the
	// supervisor restarting, not merely starting" was a sentence in a comment
	// with nothing behind it, which is the fifth thing CLAUDE.md says gets read
	// as evidence in this codebase.
	//
	// The property matters because a pm2 that cannot write its dump starts
	// everything perfectly and loses the lot the first time the daemon restarts —
	// invisible to a start-only probe, and the exact failure a resident service
	// meets. And the PID MUST CHANGE: `resurrect` returning 0 against a process
	// the kill never reached proves nothing at all.
	const text = readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8');
	const block = text.slice(text.indexOf('pm2cap_try() {'));
	const at = (s: string) => {
		const i = block.indexOf(s);
		assert.ok(i > 0, `the probe must ${s}`);
		return i;
	};
	// IN ORDER. Saving after the kill, or resurrecting before it, would each pass
	// a bare "these four strings are present" check and prove nothing.
	const save = at('node "$pc_pm2" save');
	const kill = at('node "$pc_pm2" kill');
	const resurrect = at('node "$pc_pm2" resurrect');
	assert.ok(save < kill && kill < resurrect, 'save, then kill, then resurrect');
	assert.ok(
		block.indexOf('"$pc_second" != "$pc_first"') > resurrect,
		'the resurrected pid must be compared against the original, after the resurrect'
	);
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
