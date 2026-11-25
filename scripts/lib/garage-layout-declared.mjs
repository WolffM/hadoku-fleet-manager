/**
 * THE GARAGE POOL'S MEMBERSHIP, read from the declared layout
 * (`<stateDir>/garage-layout.json`; hadoku-fleet-manager#153).
 *
 * ONE SOURCE OF TRUTH. A node is a pool member when garage-layout.json
 * declares it a zone, active or drain: a drained zone holds blocks until
 * `--forget`. Three readers ask, and all three ask here:
 *   - F4's `when` (toolchain-garage.mjs): the toolchain floor keeps Garage,
 *     its config and its unit on every member;
 *   - F7's gate (`fleet storage-pool`) and F3's doctor pool reader: which
 *     nodes the pool is judged over.
 * Garage's own report is what membership is checked AGAINST (down, not in
 * the layout), never where it comes from. The earned `storage` label is not
 * membership: capability-probe.sh answers `storage no` on every node, so a
 * reader keyed on it saw a live 3-zone pool as "no pool" (#153).
 *
 * READER ONLY, and in config so the toolchain floor may import it. The one
 * writer is garage-layout-state.mjs (f3-one-writer.json), which builds on
 * {@link readDeclared} here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../../dist/lib/fleet-paths.js';

export const GARAGE_LAYOUT_FILE = 'garage-layout.json';
/**
 * Whether the pool's Garage fsyncs every data block. toolchain-garage.mjs
 * writes garage.toml without `data_fsync`, so Garage's default holds: false
 * (blocks are written and renamed; three copies stand in for the fsync).
 * Admission judges a zone on what Garage asks of it, so the bench's
 * fsync-per-block rate and the soak's writer follow this, and setting
 * `data_fsync` in the config means setting this with it.
 */
export const GARAGE_DATA_FSYNC = false;
export const LAYOUT_SCHEMA = 1;

export const emptyDeclared = () => ({
	version: LAYOUT_SCHEMA,
	zones: {},
	buckets: {},
	overrides: [],
});

export const declaredPath = (dir = stateDir()) => join(dir, GARAGE_LAYOUT_FILE);

/**
 * A missing file is an empty pool. An unreadable one is said, never read as empty.
 * @returns {{ declared: object, error: null } | { declared: null, error: string }}
 */
export function readDeclared(path = declaredPath()) {
	if (!existsSync(path)) return { declared: emptyDeclared(), error: null };
	let doc;
	try {
		doc = JSON.parse(readFileSync(path, 'utf8'));
	} catch (e) {
		return {
			declared: null,
			error: `${path} is unreadable: ${e instanceof Error ? e.message : e}`,
		};
	}
	if (doc?.version !== LAYOUT_SCHEMA || typeof doc.zones !== 'object' || !doc.zones) {
		return {
			declared: null,
			error: `${path} is not a version ${LAYOUT_SCHEMA} garage layout (version ${doc?.version})`,
		};
	}
	return { declared: { ...emptyDeclared(), ...doc }, error: null };
}

/**
 * The pool's members: every declared zone, sorted. `error` when the
 * declaration could not be read; then `nodes` is empty and means "unknown".
 * @returns {{ nodes: string[], error: string | null }}
 */
export function declaredMembers(path = declaredPath()) {
	const { declared, error } = readDeclared(path);
	if (error) return { nodes: [], error };
	return { nodes: Object.keys(declared.zones).sort(), error: null };
}
