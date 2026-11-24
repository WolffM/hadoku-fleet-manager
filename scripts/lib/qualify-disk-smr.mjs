/**
 * `disk-smr`: is each candidate disk shingled (SMR)? An SMR disk is REFUSED
 * for the storage pool (storage bootcamp F2, hadoku-fleet-manager#137;
 * operator rule 2026-11-23). Shingling is a property of the hardware: no
 * partitioning or filesystem choice fixes it, and a Garage rebuild's
 * sustained random writes are exactly the load a drive-managed SMR disk stalls
 * under.
 *
 * SILENCE IS NEVER CMR. A drive-managed SMR disk (the kind in the 2020 WD Red,
 * Seagate Barracuda and Toshiba P300/DT02 disclosures) hides its zones: the
 * kernel reports `zoned: none` and the drive answers like any other. So the
 * judge reads, in order:
 *
 *   1. solid state (rotational false): no shingled recording. pass.
 *   2. rotational unknown: blocked, it could be either.
 *   3. the kernel's zone model `host-aware`/`host-managed`: the drive SAYS it
 *      is shingled. fail.
 *   4. a rotational disk that advertises TRIM: the drive-managed SMR tell
 *      (a CMR platter has nothing to trim). fail, whatever the table says.
 *   5. the model in RECORDING: CMR passes, SMR fails.
 *   6. anything else: BLOCKED until the model is identified and added to
 *      RECORDING with its source. Never assumed CMR.
 */
import { QUALIFY_TTL_DAYS } from './qualify-registry.mjs';
import { candidates, nodeStatus, readInventory, unnamed } from './qualify-disk-inventory.mjs';

/**
 * Identified rotational models: a pattern on the full model string (lsblk's
 * MODEL, e.g. `WDC WD10EZEX-08WN4A0`), its recording, and where that comes
 * from. A model is added here only with a source. Patterns stop at the
 * capacity/family code so one entry covers a family's revisions.
 */
export const RECORDING = Object.freeze([
	// CMR: every rotational disk the fleet carries (inventory 2026-11-23).
	{
		re: /^(WDC )?WD10EZEX-/,
		recording: 'CMR',
		source: 'WD Blue 1 TB 7200 rpm (claw-9, claw-5); WD lists the EZEX line as CMR',
	},
	{
		re: /^(WDC )?WD1002FAEX-/,
		recording: 'CMR',
		source: 'WD Black 1 TB, 2010 (claw-10); predates SMR desktop drives',
	},
	{
		re: /^ST1000DM003-/,
		recording: 'CMR',
		source: 'Seagate Barracuda 7200.14 1 TB (claw-4); Seagate lists DM003 as CMR',
	},
	{
		re: /^ST3000DM001-/,
		recording: 'CMR',
		source: 'Seagate Barracuda 7200.14 3 TB, 2012 (claw-10); predates SMR desktop drives',
	},
	{
		re: /^HGST HTS721010A9E630/,
		recording: 'CMR',
		source: 'HGST Travelstar 7K1000 (claw-1); HGST shipped no SMR 2.5" 7200 rpm drive',
	},
	// SMR: the manufacturers' 2020 disclosures.
	{
		re: /^(WDC )?WD[2-6]0EFAX-/,
		recording: 'SMR',
		source: 'WD Red 2-6 TB EFAX (WD disclosure, April 2020)',
	},
	{
		re: /^(WDC )?WD(20|60)EZAZ-/,
		recording: 'SMR',
		source: 'WD Blue EZAZ (WD disclosure, April 2020)',
	},
	{
		re: /^(WDC )?WD(10|20)SPZX-/,
		recording: 'SMR',
		source: 'WD Blue 2.5" SPZX (WD disclosure, April 2020)',
	},
	{
		re: /^(WDC )?WD(10|20)SPSX-/,
		recording: 'SMR',
		source: 'WD Black 2.5" SPSX (WD disclosure, April 2020)',
	},
	{
		re: /^ST(2000|4000|8000)DM00[48]-/,
		recording: 'SMR',
		source: 'Seagate Barracuda DM004/DM008 (Seagate disclosure, April 2020)',
	},
	{
		re: /^ST(500|1000|2000|3000|4000|5000)LM0(15|24|30|34|48|00)-/,
		recording: 'SMR',
		source: 'Seagate Barracuda 2.5" LM (Seagate disclosure, April 2020)',
	},
	{
		re: /^ST5000DM000-/,
		recording: 'SMR',
		source: 'Seagate Desktop HDD 5 TB (Seagate disclosure, April 2020)',
	},
	{
		re: /^ST8000AS0002-/,
		recording: 'SMR',
		source: 'Seagate Archive v2 8 TB (Seagate product line)',
	},
	{
		re: /^(TOSHIBA )?HDWD2[46]0/,
		recording: 'SMR',
		source: 'Toshiba P300 4/6 TB (Toshiba disclosure, April 2020)',
	},
	{
		re: /^(TOSHIBA )?DT02ABA[246]00/,
		recording: 'SMR',
		source: 'Toshiba DT02 (Toshiba disclosure, April 2020)',
	},
	{
		re: /^(TOSHIBA )?MQ04AB[DF][12]00/,
		recording: 'SMR',
		source: 'Toshiba MQ04 2.5" (Toshiba disclosure, April 2020)',
	},
]);

/** The table row for a model, or null. */
export function recordingOf(model) {
	const m = String(model ?? '').trim();
	return (m && RECORDING.find((r) => r.re.test(m))) || null;
}

const ZONED = new Set(['host-aware', 'host-managed']);

/**
 * PURE. One disk's SMR verdict.
 *
 * @param {import('./storage-inventory.d.mts').StorageDisk} d
 * @returns {{ serial: string|null, device: string, model: string|null, verdict: 'pass'|'fail'|'blocked', reason: string }}
 */
export function judgeSmr(d) {
	const v = (verdict, reason) => ({
		serial: d.serial,
		device: d.device,
		model: d.model,
		verdict,
		reason,
	});
	const noName = unnamed(d);
	if (noName) return v('blocked', noName);
	if (d.rotational === false) return v('pass', 'solid state: no shingled recording');
	if (d.rotational !== true)
		return v('blocked', 'the kernel did not say whether it is rotational, so it could be SMR');
	if (ZONED.has(String(d.zoned)))
		return v('fail', `SMR: the kernel reports the drive as zoned (${d.zoned})`);
	if (d.trim === true)
		return v('fail', 'SMR: a rotational disk that advertises TRIM is drive-managed SMR');
	const row = recordingOf(d.model);
	if (row?.recording === 'SMR') return v('fail', `SMR: ${row.source}`);
	if (row?.recording === 'CMR') return v('pass', `CMR: ${row.source}`);
	return v(
		'blocked',
		`rotational model ${JSON.stringify(d.model ?? null)} is not identified; it stays blocked until its ` +
			'recording is added to RECORDING in qualify-disk-smr.mjs with a source (never assumed CMR)'
	);
}

export const test = {
	id: 'disk-smr',
	track: 'qualify',
	needsDrain: false,
	runsAs: 'admin',
	ttlDays: QUALIFY_TTL_DAYS,
	minutes: 3,
	async run(ctx) {
		const read = await readInventory(ctx);
		if ('error' in read) return { status: 'could-not-look', reason: read.error, metrics: {} };
		return nodeStatus('the SMR check', candidates(read.inventory).map(judgeSmr));
	},
};
