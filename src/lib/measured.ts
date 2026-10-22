/**
 * Where `$benchmark` and `$health` live now: the STATE DIR, one file per facet.
 *
 * WHY THEY LEFT THE MANIFEST
 * --------------------------
 * `docs/planning/measured-facets-home-2026-09-16.md` (Wave 3f lane S) is the
 * design; Wave 3h lane M3 built it. The two facets are pure measurement: neither
 * routes a job, both are re-measured on a cadence, and together they were 36% of
 * `fleet-runner-manifest.json` and all of its churn. In the manifest every
 * re-measure cost a commit to hadoku_site, and a re-measure run from the deploy
 * tree was erased by the next publish (2026-09-14). `~/.hadoku-mgmt` is not a
 * checkout and nothing resets it, so for these two the whole `unlanded-write`
 * failure class stops existing rather than going unobserved. It IS backed up —
 * `ci:state-backup` (hadoku_site, Wave 3h lane K) — and S §4 made that backup a
 * blocking precondition of this file being authoritative for anything.
 *
 * `$capabilities` and `$measured` stay in the manifest (S §3): the first is the
 * routing input and partly declared, the second is written once per node.
 *
 * THE SHAPE
 * ---------
 * `<stateDir>/benchmark.json` and `<stateDir>/health.json`, each
 * `{ "nodes": { "<node>": { at, by, … } } }` — the same provenanced block the
 * manifest carried, minus the `$`. The `$` marks a provenanced block INSIDE
 * config; in a file that is nothing but provenanced blocks it is noise, and
 * keeping it would let a `$`-prefix scanner such as `srv-drift` match the
 * wrong tree. Every write also appends one JSON line per node to
 * `<stateDir>/<facet>.log`, because git history went when the data left the
 * repo and "when did this change, and to what" must still have an answer.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: A MISSING FILE IS NEVER "HEALTHY"
 * -------------------------------------------------------------------
 * `stateDir()` has no existence guard (`fleet-paths.ts`), unlike `manifestDir()`.
 * A fact moved there loses the construction-time check the manifest had, and an
 * absent file then answers every reader with the absent-facet value. So no
 * reader here ever gets a bare `null`: a lookup returns either `{ value, from }`
 * or `{ unavailable, why }`, and the reason is one of five distinct jobs —
 *
 *   no-state-dir        the directory itself is not there
 *   no-file             the directory is, the facet file is not
 *   unreadable          the file exists and could not be read
 *   malformed           it was read and is not the shape above
 *   no-record-for-node  a good file (or the manifest) has no block for this node
 *
 * — which a GATE renders as "could not look" and a WRITER renders as "due".
 * Neither may render it as "nothing is wrong".
 *
 * THE MERGE, AND WHY IT IS ONE-DIRECTIONAL (S §2.3 rule 3)
 * --------------------------------------------------------
 * Until the manifest edit lands (S §4 step 5) a node can carry the facet in
 * both trees. The state copy wins only when it is STRICTLY newer by `at`; a
 * manifest copy with no state counterpart is served marked `from: 'manifest'`,
 * so a reader can always say which tree answered. A state file that exists but
 * is UNREADABLE or MALFORMED is not a missing one: it might hold a newer record
 * than the manifest, so serving the manifest's would present a possibly stale
 * reading as the current one. Those two reasons are therefore unavailable for
 * every node, manifest copy or not. Only a file that is genuinely absent
 * (`no-state-dir` / `no-file`) falls back.
 */
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { stateDir } from './fleet-paths.js';

/**
 * The facets that live in the state dir. The rest stay in the manifest.
 *
 * `proof` (wave 4e, #102) is the odd one of the three: `benchmark`/`health`
 * are keyed by NODE NAME alone and have a manifest-era fallback key
 * (`MANIFEST_KEY`) because they used to live there. `$proof` never lived in
 * the manifest at all — "a failed or stale workload proof stops routing
 * WITHOUT a manifest commit" is the whole point of it being a state-dir facet
 * from day one — so it is keyed `<node>::<capability>` (see `proofRecordKey`)
 * and never merged against a manifest copy. It joins `MEASURED_FACETS` only
 * so `facetPath`/`facetLogPath`/`measuredFacetPaths` (the host boot check)
 * cover it too; `readProof`/`writeProof`/`markProofStale` below are its real
 * interface, built on `readFacetFile`/`writeFacet` directly rather than on
 * `measuredFacets`/`mergeFacet`, which assume the node-keyed, manifest-
 * mergeable shape `proof` does not have.
 */
export const MEASURED_FACETS = ['benchmark', 'health', 'proof'] as const;
export type MeasuredFacetName = (typeof MEASURED_FACETS)[number];

/**
 * The key each one had inside `machines[node]` of the manifest. `proof` never
 * had one — it is named here only so every `MeasuredFacetName` has an entry,
 * the way `assertFacet`'s error message and `mergeFacet`'s manifest-lookup
 * expect; no machine entry will ever carry `$proof`.
 */
export const MANIFEST_KEY: Readonly<Record<MeasuredFacetName, string>> = {
	benchmark: '$benchmark',
	health: '$health',
	proof: '$proof',
};

export type FileUnavailable = 'no-state-dir' | 'no-file' | 'unreadable' | 'malformed';
export type UnavailableReason = FileUnavailable | 'no-record-for-node';

/** One node's block. `at` is required — the merge and every staleness rule read it. */
export type FacetRecord = Record<string, unknown> & { at: string };

export type FacetFileRead =
	| { ok: true; path: string; nodes: Record<string, FacetRecord> }
	| { ok: false; path: string; reason: FileUnavailable; why: string };

export type MeasuredResult =
	| {
			value: FacetRecord;
			/** Which tree answered. */
			from: 'state' | 'manifest';
			/** Why the state file did not answer, when the manifest did. */
			stateFile: FileUnavailable | null;
	  }
	| { unavailable: UnavailableReason; why: string };

function isFacet(facet: string): facet is MeasuredFacetName {
	return (MEASURED_FACETS as readonly string[]).includes(facet);
}

function assertFacet(facet: string): asserts facet is MeasuredFacetName {
	if (!isFacet(facet)) {
		throw new Error(
			`measured: '${facet}' is not a state-dir facet. The ones that moved are ` +
				`${MEASURED_FACETS.join(', ')}; $capabilities and $measured stay in the manifest.`
		);
	}
}

/** `<dir>/<facet>.json`. */
export function facetPath(facet: MeasuredFacetName, dir: string = stateDir()): string {
	assertFacet(facet);
	return join(dir, `${facet}.json`);
}

/** `<dir>/<facet>.log` — one JSON line per node per write, append-only. */
export function facetLogPath(facet: MeasuredFacetName, dir: string = stateDir()): string {
	assertFacet(facet);
	return join(dir, `${facet}.log`);
}

/** Every facet file this module owns, for `host.ts`'s boot check. */
export function measuredFacetPaths(dir: string): { facet: MeasuredFacetName; path: string }[] {
	return MEASURED_FACETS.map((facet) => ({ facet, path: facetPath(facet, dir) }));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A block the rest of this file may trust: an object carrying a parseable `at`. */
function recordProblem(v: unknown): string | null {
	if (!isPlainObject(v)) return 'is not an object';
	if (typeof v.at !== 'string') return 'carries no `at` string';
	if (!Number.isFinite(Date.parse(v.at))) return `carries an unparseable \`at\` (${v.at})`;
	return null;
}

/**
 * Read one facet file. Never throws; the reason is the answer.
 *
 * Every node block is validated, and ONE bad block makes the whole file
 * `malformed`. A partially trusted file would let the good blocks answer while
 * the bad one reads as `no-record-for-node` — and that node would then look
 * never-measured when it is in fact unreadable, which is a different job.
 */
export function readFacetFile(
	facet: MeasuredFacetName,
	{ dir = stateDir() }: { dir?: string } = {}
): FacetFileRead {
	const path = facetPath(facet, dir);
	if (!existsSync(dir)) {
		return {
			ok: false,
			path,
			reason: 'no-state-dir',
			why: `the state directory ${dir} does not exist, so no ${facet} record could be read`,
		};
	}
	if (!existsSync(path)) {
		return {
			ok: false,
			path,
			reason: 'no-file',
			why: `${path} does not exist — nothing has written a ${facet} record into this state dir`,
		};
	}
	let text: string;
	try {
		if (!statSync(path).isFile()) throw new Error('not a regular file');
		text = readFileSync(path, 'utf8');
	} catch (err) {
		return {
			ok: false,
			path,
			reason: 'unreadable',
			why: `${path} exists and could not be read: ${(err as Error).message}`,
		};
	}
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch (err) {
		return {
			ok: false,
			path,
			reason: 'malformed',
			why: `${path} is not JSON: ${(err as Error).message}`,
		};
	}
	if (!isPlainObject(doc) || !isPlainObject(doc.nodes)) {
		return {
			ok: false,
			path,
			reason: 'malformed',
			why: `${path} has no \`nodes\` object — it is not a ${facet} file`,
		};
	}
	for (const [node, rec] of Object.entries(doc.nodes)) {
		const problem = recordProblem(rec);
		if (problem) {
			return {
				ok: false,
				path,
				reason: 'malformed',
				why: `${path}: the block for ${node} ${problem}`,
			};
		}
	}
	return { ok: true, path, nodes: doc.nodes as Record<string, FacetRecord> };
}

const atMs = (rec: FacetRecord): number => Date.parse(rec.at);

/**
 * The merge, pure: one node, one facet, given the state file already read and
 * the node's manifest entry (or nothing).
 */
export function mergeFacet(
	node: string,
	facet: MeasuredFacetName,
	machine: Record<string, unknown> | null | undefined,
	file: FacetFileRead
): MeasuredResult {
	// A state file that exists and cannot be trusted may hold a NEWER record
	// than the manifest; serving the manifest's would present a possibly stale
	// reading as current. So this is unavailable, whatever the manifest holds.
	if (!file.ok && (file.reason === 'unreadable' || file.reason === 'malformed')) {
		return { unavailable: file.reason, why: file.why };
	}
	const stateRec = file.ok ? file.nodes[node] : undefined;
	const rawManifest = machine?.[MANIFEST_KEY[facet]];
	const manifestRec =
		rawManifest !== undefined && recordProblem(rawManifest) === null
			? (rawManifest as FacetRecord)
			: undefined;

	if (stateRec && manifestRec) {
		return atMs(stateRec) > atMs(manifestRec)
			? { value: stateRec, from: 'state', stateFile: null }
			: { value: manifestRec, from: 'manifest', stateFile: null };
	}
	if (stateRec) return { value: stateRec, from: 'state', stateFile: null };
	if (manifestRec) {
		return { value: manifestRec, from: 'manifest', stateFile: file.ok ? null : file.reason };
	}
	if (rawManifest !== undefined) {
		// The manifest HAS a block and it is not one this file can trust. Said as
		// malformed, not as never-measured.
		return {
			unavailable: 'malformed',
			why: `the manifest's ${MANIFEST_KEY[facet]} for ${node} ${recordProblem(rawManifest)}`,
		};
	}
	if (!file.ok) {
		return {
			unavailable: file.reason,
			why: `${file.why}; the manifest carries no ${MANIFEST_KEY[facet]} for ${node} either`,
		};
	}
	return {
		unavailable: 'no-record-for-node',
		why:
			`${file.path} has no ${facet} block for ${node}, and the manifest carries no ` +
			`${MANIFEST_KEY[facet]} for it`,
	};
}

/**
 * One facet for every node in `machines`, reading the state file ONCE.
 *
 * `machines` is the manifest's `machines` object: the roster, and the fallback
 * copy of the facet while the migration is in flight.
 */
export function measuredFacets(
	facet: MeasuredFacetName,
	machines: Record<string, Record<string, unknown>>,
	{ dir = stateDir() }: { dir?: string } = {}
): { file: FacetFileRead; nodes: Record<string, MeasuredResult> } {
	const file = readFacetFile(facet, { dir });
	const nodes: Record<string, MeasuredResult> = {};
	for (const [node, machine] of Object.entries(machines)) {
		nodes[node] = mergeFacet(node, facet, machine, file);
	}
	return { file, nodes };
}

/** One node, one facet. Prefer {@link measuredFacets} in a loop — it reads once. */
export function measuredFacet(
	node: string,
	facet: MeasuredFacetName,
	{ machine, dir = stateDir() }: { machine?: Record<string, unknown> | null; dir?: string } = {}
): MeasuredResult {
	return mergeFacet(node, facet, machine, readFacetFile(facet, { dir }));
}

/** A stable serialisation — keys sorted, recursively — for the log's digest. */
function stable(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
		.join(',')}}`;
}

export type WriteFacetResult =
	| { ok: true; path: string; logPath: string; written: string[] }
	| { ok: false; path: string; reason: FileUnavailable | 'invalid-record'; why: string };

/**
 * Write node blocks into a facet file, and log each one.
 *
 * MERGES into what is there: a node not named in `records` keeps its block —
 * the "an unreachable node keeps the record it already had" rule both writers
 * state. A MISSING file or directory is created, which is what "due" means to a
 * writer. An UNREADABLE or MALFORMED file is REFUSED, never overwritten: it may
 * hold other nodes' readings that cost a loaded box minutes each, and replacing
 * it with this run's subset would destroy them with nothing said.
 *
 * The file is replaced atomically (write a sibling, then rename), so a reader
 * never sees half a document. The log is appended after the rename, so a log
 * line never describes a write that did not happen.
 *
 * @param extra per-node fields to carry in the LOG line only (the benchmark
 *   writer's raw capture, which the file does not keep).
 */
export function writeFacet(
	facet: MeasuredFacetName,
	records: Record<string, FacetRecord>,
	{
		dir = stateDir(),
		extra = {},
	}: { dir?: string; extra?: Record<string, Record<string, unknown>> } = {}
): WriteFacetResult {
	const path = facetPath(facet, dir);
	for (const [node, rec] of Object.entries(records)) {
		const problem = recordProblem(rec);
		if (problem) {
			return {
				ok: false,
				path,
				reason: 'invalid-record',
				why: `refusing to write ${facet} for ${node}: the block ${problem}`,
			};
		}
	}
	const current = readFacetFile(facet, { dir });
	if (!current.ok && (current.reason === 'unreadable' || current.reason === 'malformed')) {
		return {
			ok: false,
			path,
			reason: current.reason,
			why:
				`${current.why}. NOT overwritten: it may hold other nodes' readings, and ` +
				'replacing it with this run would destroy them. Move it aside and re-run.',
		};
	}
	const nodes: Record<string, FacetRecord> = current.ok ? { ...current.nodes } : {};
	for (const [node, rec] of Object.entries(records)) nodes[node] = rec;

	mkdirSync(dir, { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ nodes }, null, 2)}\n`);
	renameSync(tmp, path);

	const logPath = facetLogPath(facet, dir);
	const loggedAt = new Date().toISOString();
	const lines = Object.entries(records).map(([node, rec]) =>
		JSON.stringify({
			loggedAt,
			facet,
			node,
			at: rec.at,
			by: typeof rec.by === 'string' ? rec.by : null,
			digest: createHash('sha256').update(stable(rec)).digest('hex').slice(0, 16),
			record: rec,
			...(extra[node] ?? {}),
		})
	);
	if (lines.length) appendFileSync(logPath, `${lines.join('\n')}\n`);
	return { ok: true, path, logPath, written: Object.keys(records) };
}

// ---------------------------------------------------------------------------
// `$proof` — the workload-proof facet (wave 4e, #102)
// ---------------------------------------------------------------------------
//
// "claw-3 earned jdk21 and then failed five full cardtable forge-e2e jobs...
// bootcamping a claw should catch that" (the operator, 2026-10-07). The TOOL
// proof (`$capabilities.earned`, in the manifest) says a node CAN run the
// tool; this facet says whether the node's label's REAL JOB has actually
// passed on it, recently, within budget — and it can say NO without anybody
// touching the manifest, which is the entire point: a degraded node loses the
// label the same tick a bad run is recorded, not after a commit lands.
//
// Reuses `readFacetFile`/`writeFacet` directly rather than the node-keyed,
// manifest-merging `measuredFacets`/`mergeFacet` above — see `MEASURED_FACETS`'s
// own doc comment for why `proof` does not fit that shape.

/** One (node, capability) workload-proof result. */
export interface ProofRecord {
	node: string;
	capability: string;
	runId: number | null;
	runner: string | null;
	conclusion: string | null;
	durationSec: number | null;
	evidenceMatched: boolean;
	budgetSec: number | null;
	verdict: 'pass' | 'fail' | 'stale';
	why: string;
	at: string;
}

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
