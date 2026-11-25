/**
 * `disk-node-impact`'s LOAD SHAPE and VERDICT (hadoku-fleet-manager#156).
 * Pure; the soak itself is qualify-disk-impact.mjs.
 *
 * THE LOAD is what Garage itself puts on a zone when it is working hardest
 * without an operator asking: a resync (copies arriving after a join or a
 * failure) and a scrub (every block read back), at Garage's DEFAULT pacing.
 * A Garage worker with tranquility t sleeps t times as long as it worked, so
 * it holds a disk 1/(1+t) of the time: resync at its default 2 is a third of
 * the zone's measured sequential write, scrub at its default 4 a fifth of its
 * sequential read (Garage v2.5.0 `garage worker get`). The rates come from
 * the zone's own `disk-bench`, so a fast disk is loaded like a fast disk.
 * The soak never goes above that, which is the coordinator's limit for the
 * live pilot zones: resync-shaped load, Garage never stopped.
 *
 * LEVELS. Level 1 is the full default shape; a node that does not hold it is
 * tried at IMPACT_LEVELS' lower fractions. The highest level held is the
 * load the node TOLERATES. Below level 1 the result carries the Garage tuning
 * that keeps the zone at that level (`tuning`): the zone is admitted with it,
 * not rejected. A node that holds no level fails.
 *
 * THE BARS are the ones the node holds without the load, nothing new:
 *   - concurrency-ramp's k=1 step (judgeStep: CPU pressure p90, package
 *     temperature, throttles, OOM kills) with the node's OWN stored p75 unit,
 *     and that unit's wall within QUALIFY_BARS.durationRatio of the wall it
 *     took in its own ramp (the node's learned k=1 time);
 *   - IO pressure p90 (`io some avg10`) under IMPACT_IO_PSI_P90;
 *   - the ROOT disk's 4k O_DSYNC write p99 (what every CI job's fsync waits
 *     on): if it held RAND_SYNC_P99_MS without the load it must hold it with
 *     the load, and it may not grow past IMPACT_ROOT_SYNC_RATIO of itself.
 */
import { RAND_SYNC_P99_MS } from './qualify-io.mjs';

/** Garage's default worker tranquilities (v2.5.0). */
export const RESYNC_TRANQUILITY = 2;
export const SCRUB_TRANQUILITY = 4;
/** Fractions of the default shape, tried in order until one holds. */
export const IMPACT_LEVELS = Object.freeze([1, 0.5, 0.25]);
/**
 * IO pressure p90 (`io some avg10`, %) the node must stay under. claw-10's
 * link resets on W1F41TH6 put avg60 at 13%; 10 is below the reading of a
 * node in trouble and above a busy CI node's normal (doctor reads 0–5% on
 * the SSD claws during a ramp).
 */
export const IMPACT_IO_PSI_P90 = 10;
/** The root disk's synced-write p99 under load, over its own p99 without. */
export const IMPACT_ROOT_SYNC_RATIO = 2;

/**
 * The most a resync can write into a zone, MB/s: what a gigabit link
 * carries. Every block a resync writes arrives over the network from another
 * zone, and no claw has more than 1 GbE (Wi-Fi ones less). Scrub reads stay
 * local and keep the disk's own rate. Without this cap claw-8's NVMe soak
 * wrote 375 MB/s (2026-11-25), ten times what any resync could send it.
 */
export const RESYNC_LINK_MBPS = 117;

/** PURE. The load at one level, MB/s, from the zone's bench reading. */
export function loadAt(reading, level) {
	const fill = Math.min(reading?.seqWriteMbps ?? 0, RESYNC_LINK_MBPS);
	const w = Math.floor((fill * level) / (1 + RESYNC_TRANQUILITY));
	const r = Math.floor(((reading?.seqReadMbps ?? 0) * level) / (1 + SCRUB_TRANQUILITY));
	return { writeMbps: Math.max(1, w), readMbps: Math.max(1, r) };
}

/**
 * PURE. The tranquility that holds a worker to `level` of its default duty:
 * duty 1/(1+t) × level = 1/(1+t'), so t' = (1+t)/level − 1, rounded up.
 */
export function tuningFor(level) {
	if (level >= 1) return null;
	return {
		resyncTranquility: Math.ceil((1 + RESYNC_TRANQUILITY) / level - 1),
		scrubTranquility: Math.ceil((1 + SCRUB_TRANQUILITY) / level - 1),
		why: `the node held ${level} of Garage's default resync/scrub load and no more`,
	};
}

const q90 = (xs) => {
	const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
	return a.length ? a[Math.min(a.length - 1, Math.floor(0.9 * (a.length - 1) + 0.5))] : null;
};

/**
 * PURE. One level's verdict.
 *
 * @param {{ step: { verdict: string, reasons: string[], metrics: object },
 *   samples: { ioSome10: number|null }[], rootP99Base: number|null, rootP99Load: number|null }} a
 * @returns {{ verdict: 'held'|'crossed'|'could-not-look', reasons: string[], metrics: object }}
 */
export function judgeLevel({ step, samples, rootP99Base, rootP99Load }) {
	const reasons = step.verdict === 'crossed' ? [...step.reasons] : [];
	const unknown = step.verdict === 'could-not-look' ? [...step.reasons] : [];
	const ioP90 = q90(samples.map((s) => s.ioSome10));
	if (ioP90 === null) unknown.push('no IO pressure reading (no /proc/pressure/io?)');
	else if (ioP90 >= IMPACT_IO_PSI_P90)
		reasons.push(`IO pressure p90 ${ioP90}% ≥ ${IMPACT_IO_PSI_P90}%`);
	if (rootP99Base === null || rootP99Load === null)
		unknown.push('the root disk synced-write probe produced no reading');
	else {
		if (rootP99Base <= RAND_SYNC_P99_MS && rootP99Load > RAND_SYNC_P99_MS)
			reasons.push(
				`root 4k O_DSYNC write p99 ${rootP99Load} ms > ${RAND_SYNC_P99_MS} ms (${rootP99Base} ms without the load)`
			);
		if (rootP99Load > IMPACT_ROOT_SYNC_RATIO * rootP99Base + 5)
			reasons.push(
				`root 4k O_DSYNC write p99 ${rootP99Load} ms > ${IMPACT_ROOT_SYNC_RATIO}× its ${rootP99Base} ms without the load`
			);
	}
	const metrics = { ...step.metrics, ioP90, rootP99Base, rootP99Load };
	if (reasons.length) return { verdict: 'crossed', reasons: [...reasons, ...unknown], metrics };
	if (unknown.length) return { verdict: 'could-not-look', reasons: unknown, metrics };
	return { verdict: 'held', reasons: [], metrics };
}

/**
 * PURE. The test's result from the levels it ran, in order.
 * @param {{ level: number, load: object, verdict: string, reasons: string[], metrics: object }[]} levels
 */
export function impactResult(serial, levels) {
	const held = levels.find((l) => l.verdict === 'held');
	const last = levels.at(-1);
	const tolerated = held ? held.level : 0;
	const tuning = held ? tuningFor(held.level) : null;
	const where = (l) =>
		`level ${l.level} (resync ${l.load.writeMbps} MB/s + scrub ${l.load.readMbps} MB/s)`;
	const base = { serial, tolerated, tuning, levels };
	if (held)
		return {
			verdict: 'pass',
			reason:
				`${serial}: the node held ${where(held)}` +
				(tuning
					? `, not the default load; admit with resync-tranquility ${tuning.resyncTranquility}, ` +
						`scrub-tranquility ${tuning.scrubTranquility}`
					: ''),
			...base,
		};
	if (levels.some((l) => l.verdict === 'could-not-look'))
		return {
			verdict: 'blocked',
			reason: `${serial}: ${where(last)} could not be judged: ${last.reasons.join('; ')}`,
			...base,
		};
	return {
		verdict: 'fail',
		reason: `${serial}: the node held no level of Garage's load; at ${where(last)}: ${last.reasons.join('; ')}`,
		...base,
	};
}
