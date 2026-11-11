/**
 * THE PER-NODE MEMORY/SPACE PROBE — one `free -m` + `df` ssh per minting
 * node per tick, read once and shared by every consumer that needs it
 * (admission's free/ceiling figures, the shared-hosting held-back share,
 * disk-watch's early warning registry). Split out of `ephemeral-tick.ts`
 * (wave shrink-1 lane B, 800-line ceiling): this is the one place that
 * reaches the nodes; `dispatchEphemeral` itself only reads the maps back.
 */
import { logger } from '../host.js';
import { recordDiskReadings } from './disk-watch.js';
import type { HostingHold } from './ephemeral-admission.js';
import {
	heldBackMb,
	sliceUsageProbe,
	takeSliceUsage,
	type SharedHosting,
} from './hosting-record.js';
import {
	SPACE_PROBE_DF_CMD,
	parseSpaceProbe,
	shellOnNode,
	type EphemeralTickInput,
} from './ephemeral-shared.js';

/** #101: which nodes have already had their `/tmp`/`_work` free space logged
 * once this process's lifetime — see `probeNodeMemory`'s own call below.
 * Module-level so "once" means once per mgmt-api process, not once per
 * 15 s tick; reset is never needed because a restart clears it along with
 * everything else in-memory here. */
const loggedSpaceProbeOnce = new Set<string>();

/** Test seam. Not part of the supported API. */
export function __resetSpaceProbeLogForTesting(): void {
	loggedSpaceProbeOnce.clear();
}

export interface NodeMemoryProbe {
	freeMbByNode: Map<string, number>;
	sliceCeilingMbByNode: Map<string, number>;
	tmpFreeMbByNode: Map<string, number | null>;
	tmpSizeMbByNode: Map<string, number | null>;
	workFreeMbByNode: Map<string, number | null>;
	/** Per node, each shared hosting slice's held-back share (fleet-manager#58). */
	heldBackByNode: Map<string, HostingHold[]>;
}

/**
 * REAL free memory, in MB, read from the nodes.
 *
 * The tier probe's `free` is FREE SLOTS (`cap - workers`), not megabytes, and
 * passing it as `freeMb` made admission compute `3 - 4096` and refuse every
 * mint forever — a units mismatch that reads as a correctly-wired dispatcher
 * declining work. One ssh per EPHEMERAL node per tick, so the cost is
 * bounded by the pilot's size, not the fleet's.
 *
 * INSTALLED capacity rides the same call, in the same `free -m` line. It is
 * what the per-unit cap is derived from (`MemTotal − minFreeMb`, the slice's
 * own ceiling — see `unitMemoryMaxMb`), and adding a second ssh for a number
 * already on this line would have doubled the tick's per-node cost for
 * nothing. `$7` is available, `$2` is total; the warm half reads the same two
 * columns the same way.
 *
 * #101: SPACE, read on the SAME ssh call as `free -m` rather than a second
 * round-trip — the fleet already blacked itself out once on an
 * unconditional per-node call run too often (REAP_INTERVAL_MS,
 * 2026-09-06), and this one piggybacks on a call this tick already makes.
 * `df -Pm` (POSIX, MB) on `/tmp`, and on whichever of `~/.hadoku/jit`,
 * `~/.hadoku`, or `$HOME` exists — a node that has never minted has no
 * `jit` directory yet, and that absence is not "unreadable". ALWAYS set,
 * never left unset: `undefined` on `AdmissionInput.tmpFreeMb`/`workFreeMb`
 * means "this caller never looked" (prove-job's literal only) and the
 * live tick must never silently become that caller — see `AdmissionInput`.
 *
 * SHARED HOSTING (src/runners/hosting-record.ts): a hosting node's probe also
 * reads the tenant slice's usage, on the same ssh, so admission can hold back
 * exactly the part of the slice the tenant is not using yet.
 */
export async function probeNodeMemory(
	minting: readonly string[],
	input: EphemeralTickInput,
	sh: typeof shellOnNode,
	isBackstop: (name: string) => boolean,
	sharedHosting: Record<string, SharedHosting[]>
): Promise<NodeMemoryProbe> {
	const freeMbByNode = new Map<string, number>();
	const sliceCeilingMbByNode = new Map<string, number>();
	const tmpFreeMbByNode = new Map<string, number | null>();
	const tmpSizeMbByNode = new Map<string, number | null>();
	const workFreeMbByNode = new Map<string, number | null>();
	const heldBackByNode = new Map<string, HostingHold[]>();
	await Promise.all(
		minting.map(async (name) => {
			const hosted = sharedHosting[name] ?? [];
			const raw = await sh(
				name,
				"free -m | awk '/^Mem:/{print $7, $2}'; " +
					SPACE_PROBE_DF_CMD +
					(hosted.length ? `; ${sliceUsageProbe(hosted.map((h) => h.tenant))}` : '')
			);
			const { rest: out, sliceCurrentMb } = takeSliceUsage(raw);
			if (hosted.length) {
				heldBackByNode.set(
					name,
					hosted.map((h) => ({
						tenant: h.tenant,
						mb: heldBackMb({
							declaredMb: h.memoryMb,
							sliceCurrentMb: sliceCurrentMb.get(h.tenant) ?? null,
							since: h.since,
							...(h.steadyMb !== undefined ? { steadyMb: h.steadyMb } : {}),
						}),
					}))
				);
			}
			const { first, tmpFreeMb, tmpSizeMb, workFreeMb } = parseSpaceProbe(out);
			const [free, total] = first.split(/\s+/).map(Number);
			if (Number.isFinite(free) && free > 0) freeMbByNode.set(name, free);
			// The FLOOR that keeps the claw alive, subtracted here rather than on
			// the node: `minFreeMb` is operator config and MemTotal is measured, so
			// this is the one place both are in hand. A node whose total is smaller
			// than its own floor is a manifest error — `runners-slice-install.sh`
			// answers SLICE-FAIL for it — and it must not become a cap of zero.
			//
			// A BACKSTOP'S CEILING IS ITS ALLOWANCE. On the production host CI gets
			// `slice.maxMb`, deliberately far below MemTotal − minFreeMb, and
			// admission must measure a backstop job against what the slice will
			// actually let it have, not against memory production is using.
			const floorCeiling = total - (input.nodes[name]?.minFreeMb ?? 1536);
			const allowance = isBackstop(name) ? input.nodes[name]?.slice?.maxMb : undefined;
			const ceiling =
				typeof allowance === 'number' && allowance > 0
					? Math.min(floorCeiling, allowance)
					: floorCeiling;
			if (Number.isFinite(total) && total > 0 && ceiling > 0)
				sliceCeilingMbByNode.set(name, ceiling);
			tmpFreeMbByNode.set(name, tmpFreeMb);
			tmpSizeMbByNode.set(name, tmpSizeMb);
			workFreeMbByNode.set(name, workFreeMb);
			// LOGGED ONCE PER PROCESS LIFETIME PER NODE, not every 15 s tick —
			// `runner-health.ts`'s own tick, and any verdict CHANGE below, are the
			// other two places this is visible. grep: "space probe".
			if (!loggedSpaceProbeOnce.has(name)) {
				loggedSpaceProbeOnce.add(name);
				logger.info(
					`[ephemeral-tick] space probe ${name}: /tmp free=${tmpFreeMb ?? 'unreadable'}MB ` +
						`of ${tmpSizeMb ?? 'unknown'}MB, ` +
						`_work free=${workFreeMb ?? 'unreadable'}MB`
				);
			}
		})
	);
	// Wave 4c §F: hand the SAME per-node space-probe maps this tick already
	// built for admission's own space clause to the early-warning registry in
	// disk-watch.ts/runner-health.ts. No second probe, no second ssh — see
	// disk-watch.ts's own header for why this registry lives there instead of
	// beside the admission verdict snapshot here, and why WHOLESALE replace is the rule.
	recordDiskReadings(tmpFreeMbByNode, workFreeMbByNode, tmpSizeMbByNode);
	return {
		freeMbByNode,
		sliceCeilingMbByNode,
		tmpFreeMbByNode,
		tmpSizeMbByNode,
		workFreeMbByNode,
		heldBackByNode,
	};
}
