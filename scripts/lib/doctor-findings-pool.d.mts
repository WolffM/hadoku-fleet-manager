/**
 * THE POOL INPUT `poolFindings` judges (hadoku-fleet-manager#138, F3).
 *
 * The doctor reads it through the first member whose admin API answers
 * (`readPool` in garage-admin.mjs, #141); `garage: null` with `why` when none
 * does. Members are the zones garage-layout.json declares
 * (garage-layout-declared.mjs, #153); none declared is `state: 'none'`, which
 * is not a finding, and a declaration that could not be read is `unread`.
 *
 * NULL MEANS "NOT REPORTED", never zero: a node whose capacity is null was not
 * measured, and the N+1 sum refuses to run over it.
 */

export interface PoolNodeState {
	/** The fleet node name (claw-9), which is also its one Garage zone. */
	node: string;
	zone: string | null;
	up: boolean;
	capacityBytes: number | null;
	usedBytes: number | null;
	/**
	 * A ROOT-DISK zone's root filesystem (#141): its share of the pool is a
	 * fixed quota on `/`, so its fill is judged against the quota AND the 80%
	 * line of `/`. Absent for a zone on its own disks; null when not read.
	 */
	rootFs?: { sizeBytes: number; availBytes: number } | null;
}

export interface GarageState {
	/** `replication_factor` the cluster runs with; the design is 3. */
	replicationFactor: number | null;
	nodes: PoolNodeState[];
	/** Blocks held on fewer copies than the factor. Null: not read. */
	underReplicatedBlocks: number | null;
	/** When this state was read, ISO. */
	at: string;
}

export interface PoolInput {
	/** The declared zones (`declaredMembers`); empty and meaningless when `membersWhy` is set. */
	members: string[];
	/** Why the members are unknown: the declared layout could not be read. */
	membersWhy?: string | null;
	/** The cluster as Garage reports it, or null when nothing read it. */
	garage: GarageState | null;
	/** Why `garage` is null. */
	why: string | null;
}

export interface PoolSummary {
	state: 'none' | 'unread' | 'read';
	members: string[];
	why: string | null;
}

export interface PoolFinding {
	node: string;
	category: 'pool-copies' | 'pool-fill' | 'pool-node' | 'pool-n-plus-1';
	class: 'advisory';
	status: string;
	why: string;
	shadow: true;
	[k: string]: unknown;
}

export const POOL_COPIES: 3;
export const POOL_FILL_ADVISORY_PCT: number;
export const POOL_FILL_FULL_PCT: number;
export function poolSummary(input: PoolInput): PoolSummary;
export function poolFindings(input: PoolInput): PoolFinding[];
export const ROOT_FS_CEILING_PCT: number;
export function withRootZones(
	state: GarageState | null,
	rootFs: Record<string, { sizeBytes: number; availBytes: number } | null>
): GarageState | null;
