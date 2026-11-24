/**
 * `disk-bench`'s BARS, TARGETS and the POOL it is judged against
 * (hadoku-fleet-manager#156). Pure; the I/O is qualify-disk-bench.mjs.
 *
 * A zone is judged on what Garage asks of it: 4k O_DSYNC writes (every
 * metadata commit and, with `data_fsync`, every block), 1 MiB block writes
 * with an fsync each, and the sequential rate a resync or a rebuild moves.
 *
 * TWO KINDS OF BAR.
 *   absolute   a zone no pool should hold, whatever the others do.
 *   relative   the zone's 4k O_DSYNC write p99 against the MEDIAN of the
 *              pool's other zones, so the slowest zone cannot drag the
 *              pool's write quorum. Garage acknowledges a write when 2 of its
 *              3 copies are on disk: with every zone up a slow zone is the
 *              third copy and is waited on by nobody, but with one zone down
 *              (a reboot, a drain) it is IN the quorum of every partition it
 *              holds, and the pool writes at its pace. Judged only once the
 *              pool has BENCH_POOL_MIN other benched zones: the median of one
 *              reading is that zone, not the pool.
 *
 * THE NUMBERS and why (2026-11-24):
 *   - BENCH_WRITE_P99_FACTOR 4: the fleet's root disks under `disk-sync-writes`
 *     (one to four writers) read p99 6–25 ms on SSD/NVMe and 150–184 ms on the
 *     two laptop/old HDDs (claw-1, claw-5); a 7,200 rpm desktop disk sits
 *     between. Four times the pool's median lets an HDD zone join a pool of
 *     HDDs and refuses one that is an order of magnitude behind the others.
 *   - BENCH_WRITE_P99_MAX_MS 250: claw-1's root HDD, the slowest zone in the
 *     pilot and already known to cost CI (qualify-io.mjs RAND_SYNC_P99_MS),
 *     reads ~150 ms; a zone above a quarter second per synced 4k write is a
 *     disk retrying or a link renegotiating, not a slow disk.
 *   - BENCH_SEQ_WRITE_FLOOR_MBPS 20: the floor `disk-sync-writes` holds every
 *     CI disk to (qualify-io.mjs SEQ_FLOOR_MBPS). A zone under it rebuilds a
 *     400 GB zone in more than 5.5 hours of a node's full write bandwidth.
 *   - BENCH_BLOCK_FLOOR_MBPS 10: Garage-shaped 1 MiB writes with an fsync
 *     each, beside metadata fsyncs. Half the sequential floor: the fsync per
 *     block is what this phase adds, and on a spinning disk it halves the
 *     rate (one seek per block).
 * Change a number when a pool zone is shown to slow the pool (or a refused
 * disk is shown harmless), with the measurement named here.
 */

export const BENCH_WRITE_P99_FACTOR = 4;
export const BENCH_WRITE_P99_MAX_MS = 250;
export const BENCH_SEQ_WRITE_FLOOR_MBPS = 20;
export const BENCH_BLOCK_FLOOR_MBPS = 10;
/** Other benched zones the pool needs before the relative bar applies. */
export const BENCH_POOL_MIN = 2;

/**
 * PURE. Where to bench on `node`: each DECLARED zone disk (a root zone's
 * directory, or a pool disk's F5 mount), else every candidate already
 * formatted and mounted at its F5 mount point (the disk on its way in).
 *
 * @param {{ zoneDisks: { serial: string|null, root?: boolean }[] | null,
 *   inventory: import('./storage-inventory.d.mts').StorageInventory,
 *   rootZoneDir: string, mountPointFor: (serial: string) => string }} a
 * @returns {{ targets: { serial: string, model: string|null, root: boolean, dir: string }[], why: string[] }}
 */
export function benchTargets({ zoneDisks, inventory, rootZoneDir, mountPointFor }) {
	const why = [];
	const targets = [];
	const root = inventory.disks.find((d) => d.isRoot && d.mediaPresent);
	if (zoneDisks?.length) {
		for (const z of zoneDisks) {
			if (z.root) {
				if (!root?.serial) why.push('the root zone: the node reports no root disk serial');
				else targets.push({ serial: root.serial, model: root.model, root: true, dir: rootZoneDir });
				continue;
			}
			const d = inventory.disks.find((x) => x.serial === z.serial);
			if (!d) why.push(`${z.serial}: declared, and the node reports no such disk`);
			else if (!d.mountpoints.includes(mountPointFor(z.serial)))
				why.push(`${z.serial}: declared, and not mounted at ${mountPointFor(z.serial)}`);
			else
				targets.push({
					serial: z.serial,
					model: d.model,
					root: false,
					dir: mountPointFor(z.serial),
				});
		}
		return { targets, why };
	}
	for (const d of inventory.disks) {
		if (d.isRoot || !d.serial || !d.mountpoints.includes(mountPointFor(d.serial))) continue;
		targets.push({ serial: d.serial, model: d.model, root: false, dir: mountPointFor(d.serial) });
	}
	if (!targets.length)
		why.push(
			'no declared zone and no candidate formatted at its storage mount (fleet storage-format first)'
		);
	return { targets, why };
}

const median = (xs) => {
	const a = [...xs].sort((x, y) => x - y);
	if (!a.length) return null;
	const m = Math.floor(a.length / 2);
	return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * PURE. The pool's zone readings from the ledger: every declared ACTIVE
 * zone's last `disk-bench` (other than `exceptNode`), one reading per disk
 * that the bench measured whole.
 *
 * @returns {{ node: string, serial: string, writeP99Ms: number }[]}
 */
export function poolReadings({ declared, results, exceptNode }) {
	const out = [];
	for (const [node, z] of Object.entries(declared?.zones ?? {})) {
		if (node === exceptNode || z.state !== 'active') continue;
		const disks = results?.[`${node}::disk-bench`]?.last?.metrics?.disks ?? [];
		for (const d of disks)
			if (Number.isFinite(d?.reading?.randWriteP99Ms))
				out.push({ node, serial: d.serial, writeP99Ms: d.reading.randWriteP99Ms });
	}
	return out;
}

/**
 * PURE. One zone's verdict.
 *
 * @param {{ seqWriteMbps: number|null, seqReadMbps: number|null, randReadP50Ms: number|null,
 *   randReadP99Ms: number|null, randWriteP50Ms: number|null, randWriteP99Ms: number|null,
 *   blockMbps: number|null, metaP99Ms: number|null }} reading
 * @param {{ writeP99Ms: number }[]} pool the other zones' readings
 * @returns {{ verdict: 'pass'|'fail'|'blocked', reason: string, bars: object }}
 */
export function judgeBench(reading, pool) {
	const missing = Object.entries(reading)
		.filter(([, v]) => !Number.isFinite(v))
		.map(([k]) => k);
	const poolMedian = pool.length >= BENCH_POOL_MIN ? median(pool.map((p) => p.writeP99Ms)) : null;
	const relMax =
		poolMedian === null ? null : Math.round(BENCH_WRITE_P99_FACTOR * poolMedian * 100) / 100;
	const bars = {
		writeP99MaxMs: BENCH_WRITE_P99_MAX_MS,
		writeP99Factor: BENCH_WRITE_P99_FACTOR,
		poolMedianWriteP99Ms: poolMedian,
		poolZones: pool.length,
		relativeWriteP99MaxMs: relMax,
		seqWriteFloorMbps: BENCH_SEQ_WRITE_FLOOR_MBPS,
		blockFloorMbps: BENCH_BLOCK_FLOOR_MBPS,
	};
	if (missing.length)
		return { verdict: 'blocked', reason: `no reading for ${missing.join(', ')}`, bars };
	const r = reading;
	const crossed = [];
	if (r.randWriteP99Ms > BENCH_WRITE_P99_MAX_MS)
		crossed.push(`4k O_DSYNC write p99 ${r.randWriteP99Ms} ms > ${BENCH_WRITE_P99_MAX_MS} ms`);
	if (relMax !== null && r.randWriteP99Ms > relMax)
		crossed.push(
			`4k O_DSYNC write p99 ${r.randWriteP99Ms} ms > ${BENCH_WRITE_P99_FACTOR}× the pool's median zone ` +
				`(${poolMedian} ms over ${pool.length} zone(s))`
		);
	if (r.seqWriteMbps < BENCH_SEQ_WRITE_FLOOR_MBPS)
		crossed.push(`sequential write ${r.seqWriteMbps} MB/s < ${BENCH_SEQ_WRITE_FLOOR_MBPS}`);
	if (r.blockMbps < BENCH_BLOCK_FLOOR_MBPS)
		crossed.push(`1 MiB block writes with fsync ${r.blockMbps} MB/s < ${BENCH_BLOCK_FLOOR_MBPS}`);
	const summary =
		`seq ${r.seqWriteMbps}/${r.seqReadMbps} MB/s w/r; 4k read p50/p99 ${r.randReadP50Ms}/${r.randReadP99Ms} ms; ` +
		`4k O_DSYNC write p50/p99 ${r.randWriteP50Ms}/${r.randWriteP99Ms} ms; ` +
		`Garage-shaped ${r.blockMbps} MB/s blocks, metadata fsync p99 ${r.metaP99Ms} ms`;
	const relNote =
		relMax === null
			? ` (pool-relative bar not applied: ${pool.length} other benched zone(s), needs ${BENCH_POOL_MIN})`
			: ` (pool median ${poolMedian} ms)`;
	if (crossed.length)
		return { verdict: 'fail', reason: `${crossed.join('; ')} — ${summary}`, bars };
	return { verdict: 'pass', reason: `${summary}${relNote}`, bars };
}
