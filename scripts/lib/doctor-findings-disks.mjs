/**
 * doctor-findings-disks — SMART on every disk a node carries, not just root
 * (hadoku-fleet-manager#138, storage bootcamp F3).
 *
 * The doctor's own probe reads the ROOT drive (`$health.smart`, judged in
 * doctor-findings-storage.mjs). Every other disk was invisible to it: claw-9's
 * 1 TB data disk and claw-10's two non-root drives had no reading anywhere but
 * smartd's journal (#122). The doctor now runs storage-probe.sh, the one device
 * loop, and `$health.storage` is that inventory's disks with their SMART
 * record (storage-inventory.d.mts). This module builds that facet and judges it.
 *
 * SHIPPED QUIET. Every finding here is ADVISORY until its false-positive rate
 * is known, against preflight.mjs's "only a clean read may be advisory": the
 * storage-probe reads are new, and a new reading starts as a warning, never a
 * page (AGENTS.md, "a new gate starts quiet"). Each carries `shadow: true` so
 * the commit that promotes them can count what fired.
 *
 * THE ABSENCES STAY APART, and none of them reads as healthy: no smartctl on
 * the node, a run that was not root, a USB bridge that hides the drive, SMART
 * switched off, an answer the parser does not recognise. Each is its own
 * status, because each is a different job. An empty card-reader slot (claw-4's
 * four, which the kernel lists at 0 bytes) is not a disk and is not judged.
 *
 * THE ROOT DISK IS SKIPPED here: `smart-health`/`smart-hours` already judge it
 * at their own class, and a second finding for the same drive would double it.
 */

import { ADVISORY } from './preflight.mjs';
import { f } from './doctor-findings-record.mjs';
import { parseStorage } from './storage-inventory.mjs';
import { SMART_HOURS_ADVISORY, SMART_HOURS_BLOCKING } from './doctor-findings-thresholds.mjs';
import { wearText } from './doctor-disk-wear.mjs';

const CATEGORY = 'disk-smart';

/**
 * `$health.storage` out of the probe's `T ` lines.
 *
 * `{read: false, why}` when there is no inventory to judge: the probe was not
 * handed storage-probe.sh, or its block did not finish (`parseStorage` throws
 * rather than read a cut-off probe as a node with fewer disks).
 *
 * @param {string[]} lines the `T `-prefixed lines, already stripped
 * @param {Record<string,string>} unknown the probe's `U` reasons
 */
export function storageFacet(lines, unknown = {}) {
	if (unknown.storage) return { read: false, why: unknown.storage };
	let inv;
	try {
		inv = parseStorage((lines ?? []).join('\n'));
	} catch (e) {
		return { read: false, why: `the storage inventory did not parse: ${e.message}` };
	}
	return {
		read: true,
		root: inv.root,
		smartTool: inv.smartTool,
		disks: inv.disks.map((d) => ({
			device: d.device,
			serial: d.serial,
			model: d.model,
			transport: d.transport,
			sizeBytes: d.sizeBytes,
			mediaPresent: d.mediaPresent,
			rotational: d.rotational,
			isRoot: d.isRoot,
			smart: d.smart,
		})),
	};
}

/** A disk as a person and a converger both name it: device and serial. */
const nameOf = (d) => `${d.device}${d.serial ? ` (serial ${d.serial})` : ''}`;

/** The disks this module judges: media present, not the root drive. */
const judged = (storage) => (storage.disks ?? []).filter((d) => d.mediaPresent && !d.isRoot);

/**
 * @param {{node: string, storage?: object}} health
 * @returns {object[]}
 */
export function diskFindings(health) {
	const quiet = (status, why, extra = {}) =>
		f(health, CATEGORY, ADVISORY, status, why, { shadow: true, ...extra });
	const s = health.storage;
	if (!s) {
		return [
			quiet(
				'not-recorded',
				'this $health record has no storage inventory: it was written before the doctor read ' +
					'every disk, so no disk but root has a SMART reading here.'
			),
		];
	}
	if (!s.read) {
		return [
			quiet(
				'inventory-unreadable',
				`no disk but root was read: ${s.why ?? 'no reason was recorded'}. Not read is not healthy.`
			),
		];
	}
	const disks = judged(s);
	if (!disks.length) return [];
	// Node-wide absences: one finding, not one per disk.
	if (!s.smartTool) {
		return [
			quiet(
				'no-tool',
				`smartctl is not installed, so ${disks.map(nameOf).join(', ')} ha${disks.length > 1 ? 've' : 's'} ` +
					'no SMART reading. Install smartmontools; until then these drives are unread, not healthy.'
			),
		];
	}
	if (!s.root) {
		return [
			quiet(
				'not-root',
				`the storage probe could not run as root (sudo -n was refused), so smartctl could not open ` +
					`${disks.map(nameOf).join(', ')}.`
			),
		];
	}
	const out = [];
	for (const d of disks) out.push(...oneDisk(d, quiet));
	return out;
}

function oneDisk(d, quiet) {
	const sm = d.smart ?? {};
	const extra = { device: d.device, serial: d.serial };
	const name = nameOf(d);
	switch (sm.status) {
		case 'failing':
			return [
				quiet(
					'failing',
					`${name} reports SMART overall-health "${sm.health}": the drive's own firmware says ` +
						'it is failing. Copy anything off it; give it nothing it cannot lose.',
					{ ...extra, health: sm.health }
				),
			];
		case 'disabled':
			return [
				quiet(
					'smart-disabled',
					`${name} has SMART switched off, so it reports no health. \`smartctl -s on\` would ` +
						'answer it, and that is a write to the drive: an operator step, not the doctor’s.',
					extra
				),
			];
		case 'unsupported':
			return [
				quiet(
					d.transport === 'usb' ? 'usb-bridge' : 'unsupported',
					d.transport === 'usb'
						? `${name} sits behind a USB bridge that hides SMART (${sm.why}). Its health is unknown.`
						: `${name} refused SMART: ${sm.why}. Its health is unknown.`,
					extra
				),
			];
		case 'not-root':
		case 'no-tool':
		case 'no-answer':
			return [
				quiet(
					sm.status,
					`${name}: ${sm.why ?? 'SMART gave no reading'}. Its health is unknown.`,
					extra
				),
			];
		case 'ok':
			return okDisk(d, sm, quiet, extra, name);
		default:
			return [
				quiet(
					'no-answer',
					`${name}: the SMART status "${sm.status}" is not one this doctor knows. Unread, not healthy.`,
					extra
				),
			];
	}
}

/** A drive that answered PASSED: its age and its pending sectors still count. */
function okDisk(d, sm, quiet, extra, name) {
	const out = [];
	if (sm.pendingSectors !== null && sm.pendingSectors > 0) {
		out.push(
			quiet(
				'pending-sectors',
				`${name} has ${sm.pendingSectors} sector(s) pending reallocation while it still reports ` +
					'PASSED: sectors it could not read back. A count that grows is a drive on its way out.',
				{ ...extra, pendingSectors: sm.pendingSectors }
			)
		);
	}
	const h = sm.powerOnHours;
	if (h === null) {
		out.push(quiet('no-hours', `${name} answered SMART but reported no power-on hours.`, extra));
	} else if (h >= SMART_HOURS_ADVISORY) {
		const past = h >= SMART_HOURS_BLOCKING ? SMART_HOURS_BLOCKING : SMART_HOURS_ADVISORY;
		out.push(
			quiet(
				h >= SMART_HOURS_BLOCKING ? 'beyond-service-life' : 'aging',
				`${name} reports ${h.toLocaleString('en-US')} power-on hours ` +
					`(${(h / 8766).toFixed(1)} years), past ${past}h. Plan its replacement before it holds ` +
					'a copy of anything.',
				{ ...extra, powerOnHours: h }
			)
		);
	}
	return out;
}

/**
 * One line for the human render: every disk beside root, with its reading.
 *
 * @param {object|undefined} storage `$health.storage`
 */
export function disksLine(storage) {
	if (!storage) return 'not recorded';
	if (!storage.read) return `not read: ${storage.why}`;
	const rest = (storage.disks ?? []).filter((d) => !d.isRoot);
	if (!rest.length) return 'none beside root';
	return rest
		.map((d) => {
			if (!d.mediaPresent) return `${d.device} empty slot`;
			const sm = d.smart ?? {};
			const hours = sm.powerOnHours === null ? '' : ` ${sm.powerOnHours.toLocaleString('en-US')}h`;
			const wear = wearText(sm);
			return `${d.device} ${Math.round(d.sizeBytes / 1e9)}G ${sm.status}${hours}${wear ? ` ${wear}` : ''}`;
		})
		.join(' · ');
}
