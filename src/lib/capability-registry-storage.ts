/**
 * The `storage` capability — wave 0 (F0) of the storage bootcamp, the contract
 * F1-F7 import. Its own file so the bootcamp's modules name one small leaf
 * rather than reaching into the label array.
 *
 * WHAT EARNS IT. A node earns `storage` when at least one of its disks has
 * passed disk qualification (F2: SMR, SMART, burn-in) AND is a member of the
 * Garage layout (F6). Until both exist the probe line in
 * `scripts/capability-probe.sh` answers `no` on every node, so no node earns
 * it and nothing changes anywhere. A `no` revokes nothing either: bootcamp
 * records a revocation only for a label the node was already offering.
 *
 * WHY A LABEL. F4 installs Garage through a REPAIRS entry with
 * `when: 'storage'`, and a string `when` is read through `nodeOffer`, which
 * carries `surface: 'label'` capabilities only. An implicit entry would make
 * that install unreachable.
 *
 * Design: hadoku-dataplatform (private) `docs/planning/distributed-storage-20261123.md`.
 */

import type { Capability } from './capability-registry.js';

export const STORAGE_LABEL = 'storage';

export const STORAGE_CAPABILITY: Capability = {
	id: STORAGE_LABEL,
	label: 'Garage storage member',
	kind: 'identity',
	surface: 'label',
	verify: 'probe',
	description:
		'At least one disk on this node passed disk qualification (SMR, SMART, burn-in) and ' +
		'is a member of the Garage layout, the 3-copy pool dataplatform stores blobs in.',
};
