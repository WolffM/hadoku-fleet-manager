/**
 * The fleet manifest — ONE typed reader, one primitive, and the six loaders
 * that used to live inline in `fleet-loop.ts` (lines 152-470 before this
 * move). Extracted to the config layer (plan §3.2: "declarative input ->
 * config") because the fast loop's own layer is ci-scheduling/run, and a
 * reader of operator config has no business sitting sideways of it.
 *
 * `fleet-runner-manifest.json` is operator config (AGENTS.md: "Manifests are
 * operator config, not package content"), resolved through
 * `manifestDir()`/`FLEET_MANIFEST_DIR` — never `__dirname` arithmetic. Before
 * this file existed, the fleet had FIFTEEN raw `JSON.parse(readFileSync(...))`
 * copies of this one read (the F1 guard's debt list, `scripts/lib/f-guards/
 * debt.json`); four of them were TS (this module's callers) because
 * `tsconfig.json` sets no `allowJs`, so the existing JS-side canonical reader
 * (`scripts/lib/fleet-exec.mjs#loadManifest`) could not be imported from `src/`.
 * This module is the TS-side canonical: the F1 guard
 * (`scripts/lib/f-guards/f1-guard.test.mjs`) now allows the literal filename
 * in exactly two places, this one and `fleet-exec.mjs`.
 *
 * THE CONTRACT: `null`/`{ok:false}` means "I could not look" and is NEVER
 * conflated with an empty fleet. `fleet-loop.ts:365-372`'s own comment says
 * why: an empty fleet pages every label at once. Every loader below honours
 * this; see the divergence table in this wave's closing note for the sites
 * that did NOT (routes/fleet.ts's `loadManifestNodes` turns an unreadable
 * manifest into `{}`, which is exactly the bug this paragraph warns against —
 * named, not silently kept, in that file's own comment and in this wave's
 * notes; fixing it would change `loadManifestNodes`'s return type and ripple
 * into every caller in that file, which is outside "the F1 read only").
 *
 * IMPORTS NOTHING ABOVE CONFIG. `host.ts` (config) for the injected
 * `manifestDir()`/`logger`; `capabilities.ts` (config) for the manifest
 * vocabulary (`ManifestNode`, `BootcampFacet`, the label constants) — NOT
 * `runners/census.ts` (domain/observation), which only re-exports those same
 * constants from `capabilities.ts`; `lib/node-role.ts` (config) for
 * `isGuestNode`. A domain-layer import here would be a NEW layer violation,
 * not debt reduction.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { logger, manifestDir } from '../host.js';
import {
	PM2_HOST_LABEL,
	type BootcampFacet,
	type ManifestNode as RegistryNode,
} from '../capabilities.js';
import { isGuestNode } from './node-role.js';

const MANIFEST_FILE = 'fleet-runner-manifest.json';

/**
 * EXTENDS the registry's node shape rather than restating it. `provesRequiredSet`
 * and `isGuestNode` take `capabilities.ManifestNode`, and an interface without
 * that type's index signature is not assignable to it — so the choice was to
 * inherit or to cast at every call, and a cast is a second declaration of the
 * same shape that nothing keeps in step. The members below are the ones THIS
 * module reads; the registry's are the ones the capability vocabulary reads.
 */
export interface ManifestNode extends RegistryNode {
	labels?: string[];
	placement?: string;
	excludeRepos?: Record<string, string>;
	/**
	 * This node mints runners on demand instead of carrying standing ones.
	 *
	 * Workstream B. claw-3 has carried this since 2026-08-28 and serves every
	 * job through a just-in-time mint; it holds no standing registrations at all.
	 * Enabling it on a node alters live scheduling, so it stays a deliberate
	 * edit to the manifest rather than a consequence of a deploy.
	 */
	ephemeral?: boolean;
	/** Concurrency cap. The dispatcher's admission budget for this node. */
	maxConcurrent?: number;
	/** Node memory floor, in MB. A mint must not push below it. */
	minFreeMb?: number;
	/** cgroup containment. `unitMaxMb` is the per-unit HARD CAP (MemoryMax). */
	slice?: { unitMaxMb?: number };
	/**
	 * Measured p95 of a JIT job's peak memory on this node, in MB.
	 *
	 * ADMISSION'S ESTIMATE, which is not the same thing as the hard cap and was
	 * conflated with it until 2026-09-01. `admitMint` reserves `requiredMb`
	 * against observed free memory; using `unitMaxMb` there reserves the
	 * WORST case for every job, so a node admits far fewer than it can hold.
	 * Measured that day from systemd's own per-unit accounting: p95 2970MB
	 * against a 4096MB cap on both nodes with enough JIT history to ask
	 * (claw-1 n=41, claw-3 n=227 — the same workload, so the agreement is
	 * expected rather than lucky).
	 *
	 * The cap still binds: MemoryMax stays `unitMaxMb` and MemorySwapMax is 0,
	 * so a job above the estimate is OOM-killed inside its own unit — bounded
	 * and attributable — rather than dragging the node down. Absent, admission
	 * falls back to `JOB_RESERVE_DEFAULT_MB` (not the cap, since 2026-09-14).
	 *
	 * SECOND ANSWER SINCE WAVE 3g (J2). The memory axis is the REPO, not the
	 * node, so admission first reads the queued run's repo figure —
	 * `fleet-runner-coverage.json`'s `facets[repo].jobP95Mb`, DERIVED by
	 * `reconcile --write-coverage` from job-metrics — and reaches this hand-set
	 * value only for a repo the roster has no figure for. See `jobReserve` in
	 * `runners/ephemeral-tick.ts`.
	 */
	jobP95Mb?: number;
	/**
	 * Repos that keep a STANDING runner here even when the node mints.
	 * Justified by availability, never by speed — see runners/residency.ts. An
	 * empty list is a real answer, and is claw-3's: a standing registration is
	 * assignable without asking the dispatcher, which is exactly what its
	 * thermal demotion exists to prevent.
	 */
	/**
	 * Repos this ephemeral node keeps a STANDING runner for. Declared in the
	 * manifest and read by scripts/admin/reconcile-fleet-runners.mjs, which
	 * parses the file itself — nothing in mgmt-api reads it, so this member
	 * exists to describe the file, not to be consumed here.
	 */
	residentRepos?: string[];
	/**
	 * The last `fleet bootcamp --write` finding for this node — same shape
	 * `docs/planning/supply-ledger-2026-09-07.md` documents for `$benchmark`,
	 * `$measured`: `{at, by, ...}` written straight onto this machine's entry.
	 *
	 * The REGISTRY'S shape, not a local subset. It used to declare only the two
	 * fields the old `nodeFailsBootcamp` read; since the ladder adopted
	 * `provesRequiredSet` the answer is computed from `earned` and `prereqs` as
	 * well, and a narrower copy here would mean a fixture that satisfies this
	 * module's types while proving nothing to the registry's.
	 */
	$capabilities?: BootcampFacet;
	/** `"claw"` | `"guest"`. Read through `isGuestNode`, never directly. */
	role?: string;
	/** `"on-demand"` on a guest. Read through `mintsOnDemand`, never directly. */
	mint?: string;
	/** An on-demand guest's standing exceptions. Read through `standingRepos`. */
	standingRepos?: string[];
}
export interface FleetManifest {
	/** The manifest KEY. Operator config, not an identifier. */
	machines?: Record<string, ManifestNode>;
	repos?: Record<string, { needs?: string[]; skip?: boolean; ignore?: boolean }>;
}

/** `{ok:true, doc}` on a successful read+parse, `{ok:false, why}` otherwise. */
export type ManifestReadResult = { ok: true; doc: FleetManifest } | { ok: false; why: string };

/**
 * The one primitive the rest of this module (and `scripts/lib/manifest-edit.mjs`,
 * wave 5c's lane B) is built on. `null`/`{ok:false}` means "I could not look",
 * and is DISTINCT at every step: resolving the directory, reading the file and
 * parsing it each fail with their OWN `why`, never collapsed into one message
 * that cannot tell a missing checkout from a truncated write.
 *
 * `dir` is an ESCAPE HATCH for a caller that has already resolved the manifest
 * directory itself (a standalone script via `scripts/lib/paths.mjs`, which
 * does not call `createFleetManager`/`installHost` and so cannot ask
 * `manifestDir()` here for it) — omitted, this reads the IN-PROCESS host's
 * configured directory, which is the only path every library caller in `src/`
 * has ever used.
 */
export function readManifestState(dir?: string): ManifestReadResult {
	let path: string;
	try {
		path = resolve(dir ?? manifestDir(), MANIFEST_FILE);
	} catch (err) {
		return {
			ok: false,
			why: `cannot resolve the manifest directory (${err instanceof Error ? err.message : String(err)})`,
		};
	}
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (err) {
		return {
			ok: false,
			why: `cannot read ${path} (${err instanceof Error ? err.message : String(err)})`,
		};
	}
	try {
		return { ok: true, doc: JSON.parse(text) as FleetManifest };
	} catch (err) {
		return {
			ok: false,
			why: `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
		};
	}
}

/**
 * `FleetManifest | null` compatibility shim over {@link readManifestState}, for
 * the callers that already treat "could not read" as `null` and log their own
 * warning rather than carrying `why` further (`fleet-loop.ts`'s `nodeFailsBootcamp`
 * and `loadResidentRepos`, which stayed there — see this wave's divergence
 * table for why those two did not move).
 */
export function readFleetManifest(): FleetManifest | null {
	const result = readManifestState();
	if (!result.ok) {
		logger.warn(`[manifest] ${result.why}`);
		return null;
	}
	return result.doc;
}

/**
 * Nodes that mint on demand rather than standing runners.
 *
 * Read from the manifest each call rather than cached, so turning a node
 * ephemeral takes effect on the next tick instead of needing a restart — the
 * restart being the thing (~5 a day) this workstream is trying to stop
 * depending on.
 */
export function loadEphemeralNodes(): Set<string> {
	const raw = readFleetManifest();
	const out = new Set<string>();
	for (const [name, m] of Object.entries(raw?.machines ?? {})) {
		if (m.ephemeral === true) out.add(name);
	}
	return out;
}

/** Guest nodes, by name — `machines[<node>].role`, read fresh each tick. */
export function loadGuestNodes(): Set<string> {
	const raw = readFleetManifest();
	const out = new Set<string>();
	for (const [name, m] of Object.entries(raw?.machines ?? {})) {
		if (isGuestNode(m)) out.add(name);
	}
	return out;
}

/**
 * The nodes that are CLAWS — i.e. general CI capacity, not the production
 * host. Derived from the manifest by absence of `pm2-host`, so adding a node
 * needs no second list to update.
 *
 * Exported for runner-health, which must decide "is a claw alive" from node
 * IDENTITY rather than from label presence. Labels are ELIGIBILITY, which the
 * fast loop rewrites as nodes become safe or unsafe; conflating the two makes a
 * healthy unlabelled node read as absent. See P2.
 */
export function loadClawNodes(): Set<string> {
	// An unreadable manifest must not silently declare the fleet clawless — that
	// would read as a total outage. readFleetManifest() returns null there, and
	// the empty set means "unknown", which callers treat as "fall back".
	const raw = readFleetManifest();
	const out = new Set<string>();
	for (const [name, m] of Object.entries(raw?.machines ?? {})) {
		if (!(m.labels ?? []).includes(PM2_HOST_LABEL)) out.add(name);
	}
	return out;
}

/**
 * Every node the fleet manifest declares, pm2-host included.
 *
 * `loadClawNodes` deliberately excludes the pm2-host because it answers "is
 * this a claw". Attributing a runner to its node is a different question and
 * needs the whole list, or `hokon-tenhands` folds onto nothing.
 */
export function loadFleetNodeNames(): string[] {
	return Object.keys(readFleetManifest()?.machines ?? {});
}

/**
 * Every machine entry, or `null` when the manifest could not be read.
 *
 * For the label floor's MINTING arm, which must ask `nodeOffer` the same
 * question the dispatcher asks and so needs the whole entry, not a name. `null`
 * is "I could not look" — never an empty fleet, which would read as "no minting
 * node offers anything" and page every label at once.
 */
export function loadFleetManifestMachines(): Record<string, RegistryNode> | null {
	const raw = readFleetManifest();
	return raw ? (raw.machines ?? {}) : null;
}

/**
 * Per-node concurrent-job budget: the node's declared `maxConcurrent`, the one
 * number admission mints against. The probe reports `free` against it.
 */
export function loadNodeCapacity(): Record<string, number> {
	const raw = readFleetManifest();
	const out: Record<string, number> = {};
	for (const [name, m] of Object.entries(raw?.machines ?? {})) {
		if (typeof m.maxConcurrent === 'number') out[name] = m.maxConcurrent;
	}
	return out;
}
