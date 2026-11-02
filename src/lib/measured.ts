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
 * THE LOG IS BOUNDED BY TIME (T6, refactor plan §7.3: "bound the facet
 * logs" — `health.log` measured 501KB and climbing on 2026-11-01, with no
 * reader anywhere in `src/` or `scripts/` other than this file's own writer).
 * {@link FACET_LOG_RETENTION_DAYS} = 30: at least 2x `$health`'s own
 * staleness gate (`HEALTH_STALE_DAYS` = 14d, `check-health-freshness.mjs`)
 * and more than two full fleet rotations (`ci:fleet-benchmark` measures one
 * node per run, "about as many days as there are claws"), so a question
 * about "what changed, and to what" over any window anyone has actually
 * asked about is still answerable. Trimmed on every write that has new lines
 * to add — the same "trimmed on append" shape `capacity-sample-store.ts` and
 * `gh-budget-history-store.ts` already use — via a full rewrite through the
 * shared `writeFileAtomic` (F3), never a bare `appendFileSync`: nothing reads
 * this file today, so a rewrite tears no live reader's mid-read the way it
 * would for `job-history.jsonl`, and the atomic rename still makes a crash
 * mid-write leave either the whole old log or the whole new one. A line this
 * cannot determine the age of (corrupt JSON, a missing/unparseable
 * `loggedAt`) is NEVER dropped — see `logLineAgeMs`. If a reader is ever
 * built that needs the FULL history, it says so explicitly and widens or
 * removes this window on purpose, rather than inheriting whatever an
 * unbounded log happened to still hold.
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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-json.js';
import { stateDir } from './fleet-paths.js';
import { assertFacet, facetPath, MEASURED_FACETS, measuredFacetPaths } from './measured-paths.js';
import type { MeasuredFacetName } from './measured-paths.js';

export { MEASURED_FACETS, facetPath, measuredFacetPaths, type MeasuredFacetName };

/** Kept this long in `<facet>.log`; see the module header for why 30. */
export const FACET_LOG_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

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

/** `<dir>/<facet>.log` — one JSON line per node per write, append-only. */
export function facetLogPath(facet: MeasuredFacetName, dir: string = stateDir()): string {
	assertFacet(facet);
	return join(dir, `${facet}.log`);
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

/**
 * One log line's age in ms since epoch, read from its own `loggedAt`, or
 * `null` when that cannot be determined — not JSON, no `loggedAt` string, or
 * one `Date.parse` cannot read. `null` NEVER counts as old: see
 * {@link appendFacetLog}.
 */
function logLineAgeMs(line: string): number | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const loggedAt = (parsed as Record<string, unknown>).loggedAt;
	if (typeof loggedAt !== 'string') return null;
	const ms = Date.parse(loggedAt);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Appends `newLines` to `<facet>.log`, trimming every row older than
 * {@link FACET_LOG_RETENTION_DAYS} in the SAME write — see the module header
 * for why a rewrite (rather than a bare `appendFileSync`) is safe here and
 * why 30 days. A row whose age {@link logLineAgeMs} could not determine is
 * kept regardless: "could not look" must never render as "old enough to
 * discard" (AGENTS.md).
 */
function appendFacetLog(logPath: string, newLines: readonly string[]): void {
	const cutoffMs = Date.now() - FACET_LOG_RETENTION_DAYS * DAY_MS;
	let existing: string[] = [];
	try {
		existing = readFileSync(logPath, 'utf8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
	}
	const kept = existing.filter((l) => {
		const ageMs = logLineAgeMs(l);
		return ageMs === null || ageMs >= cutoffMs;
	});
	writeFileAtomic(logPath, `${[...kept, ...newLines].join('\n')}\n`);
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

	writeFileAtomic(path, `${JSON.stringify({ nodes }, null, 2)}\n`);

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
	if (lines.length) appendFacetLog(logPath, lines);
	return { ok: true, path, logPath, written: Object.keys(records) };
}

/**
 * `$proof` — the workload-proof facet (wave 4e, #102) — split to
 * `measured-proof.ts` (wave shrink-1 lane C, pure move) to bring this file
 * under the 600-line target. Re-exported here so every existing importer of
 * `measured.js` compiles unchanged.
 */
export {
	readProof,
	proofFileStatus,
	readProofsForCapability,
	writeProof,
	markProofStale,
	type ProofFileStatus,
	type ProofRecord,
} from './measured-proof.js';
