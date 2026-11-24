/**
 * THE DECLARED GARAGE POOL (storage bootcamp F6, hadoku-fleet-manager#141):
 * which nodes are zones, with what capacity on which disk, and which tenant
 * buckets exist. `<stateDir>/garage-layout.json`.
 *
 * SOLE WRITER: this module (f3-one-writer.json). `fleet garage-layout
 * --declare/--drain/--forget/--bucket` change it through {@link updateDeclared};
 * `--apply` appends to `overrides` when a refused change goes ahead with a
 * reason. Nothing else edits it, and the plan READS the cluster, never this
 * file, to learn what is: declared is what should be.
 *
 * The reader, and who counts as a member, is garage-layout-declared.mjs
 * (config, #153). An UNREADABLE file is never overwritten: writing over a
 * file nobody could parse would forget every zone.
 *
 * Shape (version 1):
 *   zones[node] = {
 *     state: 'active' | 'drain',
 *     disks: [{ serial, capacityBytes, root? }],   // root: the pool shares `/`
 *     at,                                          // when it was last declared
 *   }
 *   buckets[ns] = { key, at }   // global alias dp-<ns>; `key` is the tenant key's name
 *   overrides[] = { at, rules, reason }
 */
import { join } from 'node:path';

import { writeFileAtomicSync } from '../../dist/lib/atomic-json.js';
import { stateDir } from '../../dist/lib/fleet-paths.js';
import { declaredPath, readDeclared } from './garage-layout-declared.mjs';

/**
 * The file this module writes: garage-layout-declared.mjs's GARAGE_LAYOUT_FILE,
 * spelled here because the F3 one-writer guard traces a writer by the literal
 * in its own file. The round-trip test reads it back by the reader's name.
 */
const WRITTEN_FILE = 'garage-layout.json';

/**
 * Read, change, write. `change(declared)` returns the new document; a file
 * that could not be read is never written over.
 */
export function updateDeclared(change, dir = stateDir()) {
	const path = join(dir, WRITTEN_FILE);
	const { declared, error } = readDeclared(path);
	if (error) throw new Error(`${error}; not writing over it`);
	const next = change(structuredClone(declared));
	writeFileAtomicSync(path, `${JSON.stringify(next, null, '\t')}\n`);
	return next;
}

/** PURE. Declare (or re-declare) `node` as an active zone on `disks`. */
export function declareZone(declared, node, disks, at) {
	declared.zones[node] = { state: 'active', disks, at };
	return declared;
}

/** PURE. Mark `node` for drain: the plan takes its role out, then waits for Garage. */
export function drainZone(declared, node, at) {
	const z = declared.zones[node];
	if (!z) throw new Error(`${node} is not a declared zone`);
	declared.zones[node] = { ...z, state: 'drain', at };
	return declared;
}

/** PURE. Forget a drained zone. Only `--forget` after the plan says it is drained. */
export function forgetZone(declared, node) {
	delete declared.zones[node];
	return declared;
}

/** PURE. Declare a tenant namespace's bucket. */
export function declareBucket(declared, ns, key, at) {
	declared.buckets[ns] = { key, at };
	return declared;
}

/** PURE. Record that refused rules went ahead, and why. */
export function recordOverride(declared, rules, reason, at) {
	declared.overrides = [...(declared.overrides ?? []), { at, rules, reason }];
	return declared;
}

/**
 * The declared zones that hold pool data on their root filesystem, for the
 * doctor's root fill, or why the declaration could not be read.
 * @returns {{ nodes: string[], error: string | null }}
 */
export function rootZoneNodes(path = declaredPath()) {
	const { declared, error } = readDeclared(path);
	if (error) return { nodes: [], error };
	return {
		nodes: Object.entries(declared.zones)
			.filter(([, z]) => z.state === 'active' && z.disks?.some((d) => d.root))
			.map(([node]) => node),
		error: null,
	};
}
