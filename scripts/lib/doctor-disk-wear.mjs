/**
 * doctor-disk-wear — every disk's SMART error counts, root included, learned
 * per serial and judged for GROWTH (hadoku-fleet-manager#155).
 *
 * SMART's overall PASSED is a threshold verdict, and a drive keeps it long
 * after it starts reallocating. claw-10's root (Samsung 870 EVO, measured
 * 2026-11-24) read PASSED with 22 reallocated sectors and 2886 reported
 * uncorrectable errors, and no check read either: the doctor's root judge
 * reads the verdict and the hours, and doctor-findings-disks.mjs skips root.
 * The Garage pool places zones on root disks (claw-1, claw-8), so this was the
 * pool's early-warning gap too.
 *
 * A COUNT IS NOT THE SIGNAL, ITS GROWTH IS. A non-zero count that holds still
 * is shown and never warns; one that rises between two readings is a drive
 * still losing sectors. So each count is a quantity in node-baselines.json,
 * `disk.<serial>.<count>`, beside qualify's `disk.<serial>.powerOnHours`, and
 * judged by the same `judgeReading`. The band is EXACT (rel 0, abs 0, and a
 * spread that stays 0 because every reading either equals the mean or
 * re-seeds it): one more sector is drift, worse. The range then re-learns at
 * the new count, so a count that grew once warns once.
 *
 * Judged where doctor's other baselines are (doctor-baseline.mjs `judgeDoctor`,
 * stamped into `health.baseline.diskWear` by the run that probed) and learned
 * only under `--write`. SHIPPED QUIET: the finding is advisory with
 * `shadow: true`, never a page, until its false-positive rate is known.
 */
import { ADVISORY } from './preflight.mjs';
import { f } from './doctor-findings-record.mjs';
import { judgeReading } from './node-baselines.mjs';

const CATEGORY = 'disk-wear';

/** The counts read, in render order, with the word each is shown as. */
export const WEAR_COUNTS = Object.freeze([
	{ key: 'reallocated', label: 'realloc' },
	{ key: 'pendingSectors', label: 'pending' },
	{ key: 'offlineUncorrectable', label: 'offline-unc' },
	{ key: 'reportedUncorrect', label: 'uncorrectable' },
]);

/** Exact: a counter that only climbs has no noise to tolerate. */
export const WEAR_SPEC = Object.freeze({ unit: '', worse: 'higher', rel: 0, abs: 0 });

/** SMART statuses whose counts are a reading: the drive answered. */
const ANSWERED = new Set(['ok', 'failing']);

/**
 * PURE. Every count a disk with a serial answered, root included.
 *
 * @param {{ storage?: object }} health
 * @returns {{ device: string, serial: string, isRoot: boolean, key: string,
 *   quantity: string, value: number }[]}
 */
export function wearReadings(health) {
	const s = health?.storage;
	if (!s?.read) return [];
	const out = [];
	for (const d of s.disks ?? []) {
		if (!d.mediaPresent || !d.serial || !ANSWERED.has(d.smart?.status)) continue;
		for (const { key } of WEAR_COUNTS) {
			const value = d.smart[key];
			if (!Number.isFinite(value)) continue;
			out.push({
				device: d.device,
				serial: d.serial,
				isRoot: !!d.isRoot,
				key,
				quantity: `disk.${d.serial}.${key}`,
				value,
			});
		}
	}
	return out;
}

/**
 * PURE. Judge every count against the node's stored estimates.
 *
 * @param {object} health
 * @param {Record<string, object>} quantities this node's estimates
 * @returns {{ stamp: object[], readings: object[] }} the stamp rides in
 *   `health.baseline.diskWear`; the readings join judgeDoctor's window
 */
export function judgeWear(health, quantities) {
	const stamp = [];
	const readings = [];
	for (const r of wearReadings(health)) {
		const v = judgeReading(quantities[r.quantity], r.value, WEAR_SPEC);
		stamp.push({ ...r, ...v });
		readings.push({
			quantity: r.quantity,
			value: r.value,
			spec: WEAR_SPEC,
			drifted: v.verdict === 'drift',
		});
	}
	return { stamp, readings };
}

const labelOf = (key) => WEAR_COUNTS.find((c) => c.key === key)?.label ?? key;

/**
 * The stamp's growths as advisory findings. A count that FELL re-learns
 * silently: it is not wear, and the hours quantity already says when a
 * different drive answers to a serial.
 *
 * @param {{ node: string, baseline?: object }} health
 */
export function wearFindings(health) {
	const stamp = health?.baseline?.diskWear;
	if (!Array.isArray(stamp)) return [];
	return stamp
		.filter((x) => x.verdict === 'drift' && x.direction === 'worse')
		.map((x) =>
			f(
				health,
				CATEGORY,
				ADVISORY,
				`${x.key}-grew`,
				`${x.device} (serial ${x.serial}${x.isRoot ? ', root' : ''}) ${labelOf(x.key)} count grew ` +
					`${x.mean} → ${x.value} since ${health.node}'s last reading. SMART can still say ` +
					'PASSED; a count that keeps climbing is a drive on its way out.',
				{
					shadow: true,
					device: x.device,
					serial: x.serial,
					count: x.key,
					from: x.mean,
					to: x.value,
				}
			)
		);
}

/**
 * The counts for the human render, `realloc 22 uncorrectable 2886`, or `''`
 * when the drive reported none of them.
 *
 * @param {object|undefined} smart a StorageSmart, or `$health.smart`
 */
export function wearText(smart) {
	if (!smart) return '';
	return WEAR_COUNTS.filter(({ key }) => Number.isFinite(smart[key]))
		.map(({ key, label }) => `${label} ${smart[key]}`)
		.join(' ');
}

/**
 * The root drive's counts: its storage-inventory record when there is one
 * (all four counts), else the root SMART facet (which carries two).
 *
 * @param {{ smart?: object, storage?: object }} health
 */
export function rootWearText(health) {
	const root = health?.storage?.read
		? (health.storage.disks ?? []).find((d) => d.isRoot && d.mediaPresent)
		: null;
	return wearText(root?.smart ?? health?.smart);
}
