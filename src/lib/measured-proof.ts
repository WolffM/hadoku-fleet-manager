/**
 * `$proof` — the workload-proof facet (wave 4e, #102). Split out of
 * `measured.ts` (wave shrink-1 lane C, pure move) to bring that file under
 * the 600-line target.
 *
 * "claw-3 earned jdk21 and then failed five full cardtable forge-e2e jobs...
 * bootcamping a claw should catch that" (the operator, 2026-10-07). The TOOL
 * proof (`$capabilities.earned`, in the manifest) says a node CAN run the
 * tool; this facet says whether the node's label's REAL JOB has actually
 * passed on it, recently, within budget — and it can say NO without anybody
 * touching the manifest, which is the entire point: a degraded node loses the
 * label the same tick a bad run is recorded, not after a commit lands.
 *
 * Reuses `readFacetFile`/`writeFacet` directly rather than the node-keyed,
 * manifest-merging `measuredFacets`/`mergeFacet` in `measured.ts` — see
 * `MEASURED_FACETS`'s own doc comment for why `proof` does not fit that shape.
 */
import { stateDir } from './fleet-paths.js';
import {
	readFacetFile,
	writeFacet,
	type FacetRecord,
	type FileUnavailable,
	type WriteFacetResult,
} from './measured.js';
import { facetPath } from './measured-paths.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// `ProofRecord` itself lives in `workload-gate.ts` (config, cut (iii)):
// moving the plain data shape there, rather than importing it from here, is
// what lets `workload-gate.ts` stay config without an edge up into this
// state-layer file. Re-exported so every existing `from './measured.js'` (or
// `./measured-proof.js`) import keeps working unchanged.
import type { ProofRecord } from './workload-gate.js';

/** The composite key a `(node, capability)` proof is filed under in `proof.json`. */
function proofRecordKey(node: string, capability: string): string {
	return `${node}\u0000${capability}`;
}

function isProofRecord(v: unknown): v is ProofRecord {
	return (
		isPlainObject(v) &&
		typeof v.node === 'string' &&
		typeof v.capability === 'string' &&
		typeof v.at === 'string'
	);
}

/**
 * The (node, capability) proof, or `null` when there is none — no state dir,
 * no file, an unreadable/malformed file, or simply no record for this pair
 * yet. Every one of those collapses to `null` here DELIBERATELY: the only
 * consumer is `nodeOffer`'s gate, withholding a label is the safe direction
 * for every one of those reasons alike, and a caller that needs to tell them
 * apart (a reporter rendering "why") reads `readFacetFile('proof', opts)`
 * itself rather than asking this function to be two things at once.
 */
export function readProof(
	node: string,
	capability: string,
	opts: { dir?: string } = {}
): ProofRecord | null {
	const file = readFacetFile('proof', { dir: opts.dir ?? stateDir() });
	if (!file.ok) return null;
	const rec = file.nodes[proofRecordKey(node, capability)];
	return isProofRecord(rec) ? rec : null;
}

/**
 * Is the `$proof` file itself trustworthy — and, separately, is it in the
 * DANGEROUS state? (wave 4e follow-up, #102 — the gate-wiring defect the
 * manager's verification caught before landing.)
 *
 * `readProof`/`readProofsForCapability` collapse every "could not look"
 * reason to an empty answer, which is the right default for a caller that
 * treats absence as "nothing has looked yet" (today's behaviour, safe). It is
 * the WRONG default for a routing caller that is ABOUT TO ACT on the result
 * fleet-wide: a genuinely MISSING file (`no-state-dir`/`no-file`) really does
 * mean nothing has ever recorded a proof, so DORMANT is correct. An
 * UNREADABLE or MALFORMED file could be hiding a FAIL/STALE mark this exact
 * tick was supposed to act on — collapsing that to "no record" would silently
 * RE-GRANT a label a bad reading had just withdrawn. `corrupt` is what tells
 * those two apart; `workloadGateContext`'s `opts.corrupt` is what a caller
 * does about it.
 */
export interface ProofFileStatus {
	ok: boolean;
	/** True only for `unreadable`/`malformed` — never for a plain absence. */
	corrupt: boolean;
	reason?: FileUnavailable;
	why?: string;
}

export function proofFileStatus(opts: { dir?: string } = {}): ProofFileStatus {
	const file = readFacetFile('proof', { dir: opts.dir ?? stateDir() });
	if (file.ok) return { ok: true, corrupt: false };
	return {
		ok: false,
		corrupt: file.reason === 'unreadable' || file.reason === 'malformed',
		reason: file.reason,
		why: file.why,
	};
}

/**
 * Every recorded proof for ONE capability, across every node — the fleet-
 * wide view `proofBudget`/the gate's `provenCount` need. Empty when the file
 * is absent or unreadable: "could not look" must not inflate how many nodes
 * are proven.
 */
export function readProofsForCapability(
	capability: string,
	opts: { dir?: string } = {}
): ProofRecord[] {
	const file = readFacetFile('proof', { dir: opts.dir ?? stateDir() });
	if (!file.ok) return [];
	const out: ProofRecord[] = [];
	// A manual loop, not `.filter(isProofRecord)`: `ProofRecord` carries no
	// index signature (it is a fixed, typed shape, not a bag of unknowns like
	// every OTHER facet), so `filter`'s type-guard overload cannot narrow
	// `FacetRecord[]` to it — `ProofRecord extends FacetRecord` is false by
	// TypeScript's own rule for that, even though every real value here
	// satisfies both. The guard still does its job inside the loop.
	for (const rec of Object.values(file.nodes)) {
		if (isProofRecord(rec) && rec.capability === capability) out.push(rec);
	}
	return out;
}

/**
 * Write one (node, capability) proof. MERGES with whatever else is on file —
 * `writeFacet`'s own rule: a pair not named here keeps its record.
 */
export function writeProof(rec: ProofRecord, opts: { dir?: string } = {}): WriteFacetResult {
	const dir = opts.dir ?? stateDir();
	// Cast, not a structural coincidence: `writeFacet` is generic over any
	// `{at: string, ...}` shape, and `ProofRecord`'s fixed, typed fields (no
	// index signature) are exactly that shape at runtime — the cast is only
	// TypeScript's bag-of-unknowns requirement, which a typed record never
	// needed to satisfy to BE one.
	const record = rec as unknown as FacetRecord;
	return writeFacet('proof', { [proofRecordKey(rec.node, rec.capability)]: record }, { dir });
}

/**
 * Mark a (node, capability) proof STALE — the withdrawal mechanism
 * `src/runners/node-regression.ts` (wave 4e §B) uses for a node that fails
 * PROVEN work in production: a node that passed its canary and then diverges
 * from a passing sibling on the same real job loses the label immediately,
 * without a manifest commit and without re-running the canary.
 *
 * Keeps every other field (`runId`, `runner`, `conclusion`, `durationSec`…)
 * so the record still shows what was last proved; only `verdict` and `why`
 * change, and `at` is restamped to when THIS finding was made, not when the
 * original proof ran — `isProofFresh`/the gate reads `at` as "since when has
 * this been true", and a stale mark is itself a fresh fact.
 *
 * Returns a `WriteFacetResult`-shaped failure (`reason: 'no-proof'`) rather
 * than throwing when there is nothing to mark: a node that was never proven
 * cannot be marked stale, and that is "nothing has looked", not an error.
 */
export function markProofStale(
	node: string,
	capability: string,
	why: string,
	opts: { dir?: string; now?: Date } = {}
): WriteFacetResult | { ok: false; path: string; reason: 'no-proof'; why: string } {
	const dir = opts.dir ?? stateDir();
	const current = readProof(node, capability, { dir });
	if (!current) {
		return {
			ok: false,
			path: facetPath('proof', dir),
			reason: 'no-proof',
			why:
				`no $proof record for ${node}/${capability} to mark stale — nothing has looked, ` +
				'which is not the same as having failed',
		};
	}
	const next: ProofRecord = {
		...current,
		verdict: 'stale',
		why,
		at: (opts.now ?? new Date()).toISOString(),
	};
	return writeProof(next, { dir });
}
