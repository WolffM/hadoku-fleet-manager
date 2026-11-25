/**
 * THE ADMISSION HALF OF `garage-layout`'s `qualified` RULE
 * (hadoku-fleet-manager#156): a zone needs smr + smart + burnin (the F2 half,
 * garage-layout.mjs `diskQualified`) AND bench + node-impact, all pass.
 *
 * Each declared disk is read against its node's last `disk-bench` and
 * `disk-node-impact` (by serial; a root zone by the root disk's serial, the
 * entry the bench marks `root`). The verdict per disk:
 *   ok       both passed. A node-impact pass that needed Garage tuning names it.
 *   missing  no result yet, or one that did not judge this disk.
 *   failed   a result judged it and refused it.
 *
 * ENFORCED since #159 (2026-11-25), after the pilot dry run posted there:
 * claw-8 and claw-9 admitted, claw-9 at resync 5 / scrub 9. A zone ALREADY in
 * the layout that does not pass is `known` (reported, never evicted, until
 * someone has read it), and a zone the change would ADD is `refused`.
 * `enforced: false` gives the shadow reading again (`shadow`, never refusing).
 */
import { resultKey } from './qualify-results.mjs';

export const ZONE_ADMISSION_TESTS = Object.freeze(['disk-bench', 'disk-node-impact']);
/** Flipped on #159 with the pilot dry run; see the header. */
export const ADMISSION_ENFORCED = true;

/**
 * PURE. One declared disk against the admission tests.
 * @returns {{ ok: boolean, missing: boolean, why: string, tuning: object|null }}
 */
export function diskAdmitted(ledger, node, disk) {
	if (!ledger?.ok)
		return { ok: false, missing: true, why: `no ledger: ${ledger?.reason}`, tuning: null };
	let tuning = null;
	const passed = [];
	for (const id of ZONE_ADMISSION_TESTS) {
		const last = ledger.results?.[resultKey(node, id)]?.last;
		if (!last) return { ok: false, missing: true, why: `no ${id} result for ${node}`, tuning };
		const disks = Array.isArray(last.metrics?.disks) ? last.metrics.disks : [];
		const mine = disks.find((d) => (disk.root ? d?.root === true : d?.serial === disk.serial));
		if (!mine)
			return {
				ok: false,
				missing: true,
				why: `${id} (${last.at}) did not judge ${disk.root ? 'the root zone' : disk.serial}`,
				tuning,
			};
		if (mine.verdict !== 'pass')
			return {
				ok: false,
				missing: mine.verdict === 'blocked',
				why: `${id} (${last.at}) says ${mine.verdict}: ${mine.reason ?? 'no reason'}`,
				tuning,
			};
		if (mine.tuning) tuning = mine.tuning;
		passed.push(`${id} ${last.at.slice(0, 10)}`);
	}
	const tuned = tuning
		? `; needs resync-tranquility ${tuning.resyncTranquility}, scrub-tranquility ${tuning.scrubTranquility}`
		: '';
	return { ok: true, missing: false, why: `passed ${passed.join(' + ')}${tuned}`, tuning };
}

/**
 * PURE. The admission checks for every active declared zone.
 * @param {{ declared: object, ledger: object, inLayout: Set<string>, enforced?: boolean }} a
 */
export function admissionChecks({ declared, ledger, inLayout, enforced = ADMISSION_ENFORCED }) {
	const out = [];
	for (const [node, z] of Object.entries(declared?.zones ?? {}).sort()) {
		if (z.state !== 'active') continue;
		for (const disk of z.disks) {
			const name = disk.root ? `${node} root` : `${node} ${disk.serial}`;
			const a = diskAdmitted(ledger, node, disk);
			const status = a.ok ? 'ok' : !enforced ? 'shadow' : inLayout.has(node) ? 'known' : 'refused';
			out.push({
				rule: 'admitted',
				status,
				subject: name,
				why: `${name}: ${a.ok ? '' : 'not admitted: '}${a.why}${status === 'shadow' ? ' (shadow: not enforced yet)' : ''}`,
				...(a.tuning ? { tuning: a.tuning } : {}),
			});
		}
	}
	return out;
}
