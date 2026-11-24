/**
 * THE DISKS ONBOARDING HAS REJECTED — `disk-rejections.json` in the state
 * directory (hadoku-fleet-manager#156).
 *
 * A rejection is a fact about a disk, by SERIAL, that outlives the evidence:
 * claw-10's W1F41TH6 dropped off the bus when SMART was enabled, and the next
 * reboot clears the kernel ring that said so. Without this record the next
 * scan would read it as SMART-`blocked` and list it as a candidate again.
 *
 * Keyed by serial: `{ node, at, rule, step, reason, evidence[] }`. A disk is
 * never un-rejected by a later pass; remove its entry by hand (with the reason
 * in the commit or issue that says why) to let it be onboarded again.
 *
 * Readers: `fleet qualify --disks` (disk-link lists it as rejected),
 * storage-format and garage-layout (`qualifiedFor` / `diskQualified` refuse
 * it). SOLE WRITER: this module (f3-one-writer.json). A missing file is an
 * empty record; an UNREADABLE one is said and never overwritten.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomicSync } from '../../dist/lib/atomic-json.js';

export const DISK_REJECTIONS_FILE = 'disk-rejections.json';

/** `{ok:true, rejected}` (serial → record) or `{ok:false, reason}`. */
export function readDiskRejections(dir) {
	const path = join(dir, DISK_REJECTIONS_FILE);
	if (!existsSync(path)) return { ok: true, rejected: {} };
	try {
		const doc = JSON.parse(readFileSync(path, 'utf8'));
		if (!doc || typeof doc !== 'object' || Array.isArray(doc))
			return { ok: false, reason: `${path} is not a JSON object` };
		return { ok: true, rejected: doc };
	} catch (err) {
		return { ok: false, reason: `${path}: ${err.message}` };
	}
}

/**
 * PURE. Every rejection a window's results carry: a disk entry in
 * `metrics.disks` with a `rejection` object.
 *
 * @param {{ metrics?: { disks?: { rejection?: object|null }[] } }[]} results
 */
export function rejectionsIn(results) {
	return (results ?? []).flatMap((r) =>
		(r.metrics?.disks ?? []).map((d) => d?.rejection).filter((x) => x && x.serial)
	);
}

/** PURE. The record after `found` rejections on `node`; a known serial keeps its first. */
export function mergeRejections(rejected, node, found, at) {
	const next = { ...rejected };
	for (const f of found)
		next[f.serial] ??= {
			node,
			at,
			rule: f.rule,
			step: f.step,
			reason: f.reason,
			evidence: f.evidence ?? [],
		};
	return next;
}

/** Persist a window's rejections. `{ok:true, added}` or `{ok:false, reason}`; never throws. */
export function recordDiskRejections(dir, node, results, at) {
	const found = rejectionsIn(results);
	if (!found.length) return { ok: true, added: [] };
	const read = readDiskRejections(dir);
	if (!read.ok) return { ok: false, reason: read.reason };
	const added = found.filter((f) => !read.rejected[f.serial]).map((f) => f.serial);
	if (!added.length) return { ok: true, added };
	try {
		const next = mergeRejections(read.rejected, node, found, at);
		writeFileAtomicSync(join(dir, DISK_REJECTIONS_FILE), `${JSON.stringify(next, null, 2)}\n`);
		return { ok: true, added };
	} catch (err) {
		return { ok: false, reason: `${join(dir, DISK_REJECTIONS_FILE)}: ${err.message}` };
	}
}

/**
 * The qualification ledger with the rejections attached as `rejected`, the
 * shape `qualifiedFor` and `diskQualified` read. An unreadable rejection
 * record makes the whole ledger unreadable: "could not look" never reads as
 * "nothing rejected".
 */
export function withRejections(ledger, rejections) {
	if (!ledger?.ok) return ledger;
	if (!rejections.ok)
		return { ok: false, reason: `the disk rejections are unreadable: ${rejections.reason}` };
	return { ...ledger, rejected: rejections.rejected };
}
