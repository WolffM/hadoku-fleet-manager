/**
 * `disk-smart`: is each candidate disk healthy by its own SMART record
 * (storage bootcamp F2, hadoku-fleet-manager#137)?
 *
 * A disk passes when the drive ANSWERED and said:
 *   - overall health PASSED/OK (F1's status `ok`);
 *   - zero pending sectors (197) and zero offline-uncorrectable (198): a
 *     sector the drive already cannot read is lost data on day one;
 *   - reallocated sectors (5; NVMe media errors) at most REALLOCATED_MAX;
 *   - an SSD with at least LIFETIME_MIN_PCT of its rated wear left.
 *
 * A drive that did NOT answer is BLOCKED with F1's reason, never passed: no
 * tool, not root, a USB bridge that hides SMART (claw-4's card reader), SMART
 * switched off on the drive (claw-10's ST3000DM001; `smartctl -s on` would
 * answer it, and that writes to the drive, so not this test). A spinning disk
 * that reports no 197/198 is blocked too: its silence is not zero. An SSD
 * that carries neither attribute (most do not) is judged on the rest.
 *
 * Power-on hours are recorded per serial into node-baselines
 * (qualify-baseline.mjs `disk-smart`), so a counter that goes BACKWARDS, a
 * different drive answering to a serial, shows as drift.
 */
import { QUALIFY_TTL_DAYS } from './qualify-registry.mjs';
import {
	candidates,
	judgeRoot,
	nodeStatus,
	readInventory,
	unnamed,
} from './qualify-disk-inventory.mjs';

/**
 * Reallocated sectors a disk may carry. Not measured against a failure in this
 * fleet (none has had one yet): it admits the SSDs that retire NAND blocks as
 * designed (claw-9's root SSD carries 7 after 30,000 h) and refuses a disk
 * already remapping by the dozen (claw-10's root SSD: 22). Every rotational
 * candidate today reads 0. A disk that reallocates DURING burn-in fails that
 * test, whatever this bar allows.
 */
export const REALLOCATED_MAX = 8;
/** An SSD's remaining rated wear, %, below which it is refused. */
export const LIFETIME_MIN_PCT = 10;

/**
 * PURE. One disk's SMART verdict.
 *
 * @param {import('./storage-inventory.d.mts').StorageDisk} d
 */
export function judgeSmart(d) {
	const s = d.smart;
	const out = (verdict, reason) => ({
		serial: d.serial,
		device: d.device,
		model: d.model,
		verdict,
		reason,
		powerOnHours: s.powerOnHours,
		reallocated: s.reallocated,
		pendingSectors: s.pendingSectors,
		offlineUncorrectable: s.offlineUncorrectable,
	});
	const noName = unnamed(d);
	if (noName) return out('blocked', noName);
	if (s.status === 'failing') return out('fail', s.why ?? `SMART health is ${s.health}`);
	if (s.status !== 'ok') return out('blocked', `SMART ${s.status}: ${s.why ?? 'no reading'}`);

	const refused = [];
	const silent = [];
	if (d.rotational === true) {
		if (s.pendingSectors === null) silent.push('pending sectors (197)');
		if (d.kind === 'ata' && s.offlineUncorrectable === null)
			silent.push('offline-uncorrectable (198)');
	}
	if (s.pendingSectors !== null && s.pendingSectors > 0)
		refused.push(`${s.pendingSectors} pending sector(s)`);
	if (s.offlineUncorrectable !== null && s.offlineUncorrectable > 0)
		refused.push(`${s.offlineUncorrectable} offline-uncorrectable sector(s)`);
	if (s.reallocated === null) silent.push('reallocated sectors');
	else if (s.reallocated > REALLOCATED_MAX)
		refused.push(`${s.reallocated} reallocated sector(s) > ${REALLOCATED_MAX}`);
	if (s.lifetimeRemainingPct !== null && s.lifetimeRemainingPct < LIFETIME_MIN_PCT)
		refused.push(`${s.lifetimeRemainingPct}% rated wear left < ${LIFETIME_MIN_PCT}%`);

	if (refused.length) return out('fail', refused.join(', '));
	if (silent.length)
		return out(
			'blocked',
			`SMART answered but did not report ${silent.join(', ')}; silence is not zero`
		);
	const hours =
		s.powerOnHours === null ? 'power-on hours not reported' : `${s.powerOnHours} h powered on`;
	return out(
		'pass',
		`health ${s.health}, ${s.reallocated} reallocated, ` +
			`${s.pendingSectors ?? 'no'} pending, ${s.offlineUncorrectable ?? 'no'} offline-uncorrectable, ${hours}`
	);
}

export const test = {
	id: 'disk-smart',
	track: 'qualify',
	needsDrain: false,
	runsAs: 'admin',
	ttlDays: QUALIFY_TTL_DAYS,
	minutes: 3,
	async run(ctx) {
		const read = await readInventory(ctx);
		if ('error' in read) return { status: 'could-not-look', reason: read.error, metrics: {} };
		return nodeStatus('the SMART check', candidates(read.inventory).map(judgeSmart), {
			bars: { reallocatedMax: REALLOCATED_MAX, lifetimeMinPct: LIFETIME_MIN_PCT },
			// A root-disk storage zone (#141) needs its root disk judged too; kept
			// apart from `disks`, so the node's status and F5's format rule never
			// read it as a pool disk.
			rootDisk: judgeRoot(read.inventory, judgeSmart),
		});
	},
};
