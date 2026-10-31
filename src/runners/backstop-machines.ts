import { readManifestState } from '../lib/manifest.js';

/**
 * The manifest's machines, as the backstop reads them: which nodes are guests,
 * and which of those are minted for on demand rather than relabelled.
 *
 * `null` when unreadable. The backstop then falls back to what GitHub says —
 * the registrations carrying `pm2-host` or `backstop` — which is the reading it
 * ran on before the manifest was consulted at all.
 */
function readManifestMachines(): Record<string, unknown> | null {
	const result = readManifestState();
	return result.ok ? (result.doc.machines ?? null) : null;
}
export let backstopMachinesReader: () => Record<string, unknown> | null = readManifestMachines;
/** Test seam: the manifest's machines map, as the backstop reads it. */
export function __setBackstopMachinesForTesting(
	fn: (() => Record<string, unknown> | null) | null
): void {
	backstopMachinesReader = fn ?? readManifestMachines;
}
