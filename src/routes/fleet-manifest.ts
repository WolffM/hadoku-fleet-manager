/**
 * The node manifest, as `routes/fleet.ts` reads it — a pure move out of that
 * file (wave 5r lane A), split off because the module crossed the 800-line
 * source ceiling. `ManifestNode` is the per-node shape every other `fleet-*`
 * module in this directory imports; `requireManifestNodes`/
 * `ManifestUnreadableError` are `buildFleetReport`'s own door onto a could-
 * not-read manifest (see that function's own doc for why the throw has to
 * land before any default parameter reads `manifest`); `backstopNodeOf` is
 * the one place the pm2-host label is turned into a node name.
 */
import { readManifestState } from '../lib/manifest.js';
import { logger } from '../host.js';
import { PM2_HOST_LABEL } from '../lib/capability-registry.js';

/** Static per-node facts. The manifest is the single source for placement. */
export interface ManifestNode {
	cores?: number;
	ramGb?: number;
	labels?: string[];
	maxRegistrations?: number;
	maxConcurrent?: number;
	tierCapacity?: number;
	placement?: string;
	excludeRepos?: Record<string, string>;
	/** This node mints a runner per job and holds no standing registration. */
	ephemeral?: boolean;
	/** `backstop` + `mint: 'on-demand'` — read through `mintsOnDemand`, never directly. */
	role?: unknown;
	mint?: unknown;
	/** Bootcamp's record — read through `bootcampFacet`, never directly. */
	$capabilities?: unknown;
	/** Onboarding's hardware/OS measurement — read through `trimMeasured`. */
	$measured?: unknown;
}

/**
 * `null` is "I could not look" — AGENTS.md: never conflated with an empty
 * fleet. This one was missed when the component moved out of mgmt-api on
 * 2026-08-30 (two `__dirname`-relative candidates that resolve, from inside
 * node_modules, to paths that do not exist) and failed exactly the way the
 * extraction was warned about: SOFTLY. The catch returned `{}`, the route
 * answered 200, and the command station's Machines table rendered em dashes
 * in five of seven columns while looking like a working dashboard. Worse,
 * `summarise()` is called with `Object.keys()` of this map, so an empty one
 * robs `nodeOf` of the node list and every JIT runner becomes its own node —
 * 36 rows for a four-node fleet, and an understated backstopShare.
 *
 * NAMED, NOT FIXED, IN WAVE 5C (lane A, F1); FIXED HERE (wave 5d, lane A, F
 * "routes/fleet loadManifestNodes"). The directory-resolution failure above
 * is now a genuine `{}` only through this function's own return — the
 * narrower case (the directory resolves but the FILE does not read or
 * parse) now returns `null` instead of swallowing it into `{}`.
 * `requireManifestNodes()` below is `buildFleetReport`'s own door onto this:
 * it throws the moment the read fails, so every one of `buildFleetReport`'s
 * LATER default parameters and every read of `manifest` in its body keeps
 * assuming a real object — `admission`, `buildVocabulary` and `stateOf`
 * never observe a null manifest at all, because the throw lands before any
 * of them is called.
 */
function loadManifestNodes(): Record<string, ManifestNode> | null {
	const result = readManifestState();
	if (!result.ok) {
		// Reported, never swallowed — the silent `{}` is what hid this for a day.
		logger.error(`[fleet] cannot read the node manifest: ${result.why}`);
		return null;
	}
	return (result.doc.machines as Record<string, ManifestNode> | undefined) ?? {};
}

/** Thrown by {@link requireManifestNodes}; the route answers 503 for it, not 500. */
export class ManifestUnreadableError extends Error {}

/**
 * `loadManifestNodes()`, or a thrown, named error when the manifest could not
 * be read — see that function's own doc. `buildFleetReport` uses this as
 * `manifest`'s default so a could-not-look never reaches `Object.keys()`,
 * `Object.entries()` or an index read as an empty/zero-node fleet.
 */
export function requireManifestNodes(): Record<string, ManifestNode> {
	const nodes = loadManifestNodes();
	if (nodes === null) {
		throw new ManifestUnreadableError(
			'cannot read the node manifest — see the preceding [fleet] log line for why'
		);
	}
	return nodes;
}

/**
 * The node the backstop promotes when the claws cannot cope.
 *
 * DERIVED: it is the box the manifest gives `pm2-host` to. The literal `'hokon'`
 * was a default parameter in `job-history.summarise`, a `RESERVABLE_NODES` set
 * in the retired tier ladder, a `const BACKSTOP` in the command station's charts and two
 * sentences of its prose — four repos-worth of a name that the manifest already
 * states once, structurally.
 *
 * `null` rather than a guess when no node declares the label: a fleet with no
 * backstop is a real (bad) state, and inventing a name for it would make the
 * panel claim a machine is standing by that is not.
 */
export function backstopNodeOf(nodes: Record<string, ManifestNode>): string | null {
	const carriers = Object.entries(nodes)
		.filter(([, m]) => (m.labels ?? []).includes(PM2_HOST_LABEL))
		.map(([name]) => name);
	return carriers[0] ?? null;
}
