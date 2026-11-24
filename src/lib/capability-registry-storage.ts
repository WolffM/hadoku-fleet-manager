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

/**
 * A ROOT-DISK ZONE (fleet-manager#141): a node with no spare disk gives the pool
 * a fixed quota of its root filesystem, in this directory, owned by the static
 * `garage` user. F5 (storage-format) never touches a root disk, so the layout
 * manager creates it.
 */
export const ROOT_ZONE_DIR = '/srv/storage/root';
export const ROOT_ZONE_DATA_DIR = `${ROOT_ZONE_DIR}/garage`;
/**
 * The zone's quota in MB, one line, written by the layout manager beside the
 * data directory. CI's `_work` free space subtracts it whenever `_work` is on
 * the same filesystem (`spaceProbeCmd` in runners/ephemeral-shared.ts): the
 * pool is a protected consumer of that disk, never space CI may grow into.
 */
export const ROOT_ZONE_RESERVE = `${ROOT_ZONE_DIR}/garage.reserve-mb`;
