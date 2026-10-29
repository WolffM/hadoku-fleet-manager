import { join } from 'node:path';

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
 * cover it too; `readProof`/`writeProof`/`markProofStale` are its real
 * interface, built on `readFacetFile`/`writeFacet` directly rather than on
 * `measuredFacets`/`mergeFacet`, which assume the node-keyed, manifest-
 * mergeable shape `proof` does not have.
 */
export const MEASURED_FACETS = ['benchmark', 'health', 'proof'] as const;
export type MeasuredFacetName = (typeof MEASURED_FACETS)[number];

function isFacet(facet: string): facet is MeasuredFacetName {
	return (MEASURED_FACETS as readonly string[]).includes(facet);
}

export function assertFacet(facet: string): asserts facet is MeasuredFacetName {
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

/** Every facet file this module owns, for `host.ts`'s boot check. */
export function measuredFacetPaths(dir: string): { facet: MeasuredFacetName; path: string }[] {
	return MEASURED_FACETS.map((facet) => ({ facet, path: facetPath(facet, dir) }));
}
