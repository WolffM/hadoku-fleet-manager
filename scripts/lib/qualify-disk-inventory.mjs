/**
 * THE DISKS A DISK QUALIFICATION JUDGES (storage bootcamp F2,
 * hadoku-fleet-manager#137): `storage-probe.sh` run as root on the node,
 * parsed by F1's `parseStorage`, narrowed to the CANDIDATES.
 *
 * A candidate is any disk that is not the root disk and has media in it. An
 * empty card-reader slot (claw-4's four, listed at 0 bytes) is not a disk. A
 * USB disk IS a candidate: its bridge usually hides SMART, so it is judged
 * `blocked` with that reason, never skipped and never passed.
 *
 * ONE VERDICT SHAPE for every disk test, per disk, by SERIAL (the device name
 * moves between boots):
 *   pass     judged and fit for the pool, for this test
 *   fail     judged and refused (SMR, a failing drive, a burn-in error)
 *   blocked  could not be judged, with why (no serial, SMART unreadable, an
 *            unidentified rotational model). Never a pass.
 *
 * And ONE NODE STATUS from them (`nodeStatus`), the question the node-level
 * ledger answers: "does this node have a disk that passes this test?"
 *   pass            yes; every disk's own verdict is in `metrics.disks`
 *   fail            no, and every candidate was judged (or there is none)
 *   could-not-look  no passing disk, and at least one could not be judged
 * A failing disk is a fact about the hardware: qualify-baseline.mjs records it
 * as a weak point of the node, never a finding and never an operator task
 * (hadoku-fleet-manager#129).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStorage } from './storage-inventory.mjs';

const PROBE = join(dirname(fileURLToPath(import.meta.url)), '..', 'storage-probe.sh');

/**
 * The probe as one admin-role script, run as root (SMART needs it). The probe
 * is fed to the root shell as a heredoc, so nothing in it is re-quoted.
 */
export function probeScript() {
	return [
		'# QUALIFY_DISK_PROBE',
		"sudo -n sh -s <<'QUALIFY_DISK_PROBE_EOF'",
		readFileSync(PROBE, 'utf8'),
		'storage_probe',
		'QUALIFY_DISK_PROBE_EOF',
	].join('\n');
}

const tail = (r) =>
	String(r?.error || r?.stderr || r?.stdout || '')
		.trim()
		.slice(-300);

/**
 * The node's inventory, or why there is none. A probe that ran without root
 * is refused here: a non-root probe reads every drive as `not-root`, which
 * would block every disk for a reason that is ours, not the disk's.
 *
 * @returns {Promise<{ inventory: import('./storage-inventory.d.mts').StorageInventory } | { error: string }>}
 */
export async function readInventory(ctx) {
	const r = await ctx.exec(probeScript(), { timeoutMs: 120_000 });
	let inventory;
	try {
		inventory = parseStorage(r.stdout);
	} catch (e) {
		return {
			error: `the storage probe did not run: ${e instanceof Error ? e.message : e}; ${tail(r) || 'no output'}`,
		};
	}
	if (!inventory.root)
		return { error: "the storage probe did not run as root (admin's sudo -n was refused)" };
	return { inventory };
}

/** Disks a qualification judges: not the root disk, media present. */
export function candidates(inventory) {
	return inventory.disks.filter((d) => !d.isRoot && d.mediaPresent);
}

/** A disk's name in a reason: serial first, then where it is today. */
export function diskName(d) {
	return `${d.serial ?? '(no serial)'} (${d.device}, ${d.model ?? 'unknown model'})`;
}

/**
 * The verdict every disk test starts from: a disk without a serial cannot be
 * named by anything that later acts on it, so it is blocked before any judge.
 */
export function unnamed(d) {
	return d.serial
		? null
		: 'the disk reports no serial, and every storage step names a disk by serial';
}

/**
 * PURE. The node-level result of one disk test.
 *
 * @param {string} testName what a passing disk passed, for the reason
 * @param {{ serial: string|null, device: string, verdict: 'pass'|'fail'|'blocked', reason: string }[]} disks
 * @param {object} [extra] more metrics
 */
export function nodeStatus(testName, disks, extra = {}) {
	const metrics = { disks, ...extra };
	const line = (v) =>
		disks
			.filter((d) => d.verdict === v)
			.map((d) => `${d.serial ?? d.device}: ${d.reason}`)
			.join('; ');
	if (!disks.length)
		return {
			status: 'fail',
			reason: `no disk besides the root disk to qualify for ${testName}`,
			metrics,
		};
	const passed = disks.filter((d) => d.verdict === 'pass');
	const blocked = disks.filter((d) => d.verdict === 'blocked');
	const failed = disks.filter((d) => d.verdict === 'fail');
	const rest = [
		failed.length ? `refused: ${line('fail')}` : '',
		blocked.length ? `blocked: ${line('blocked')}` : '',
	]
		.filter(Boolean)
		.join(' | ');
	if (passed.length)
		return {
			status: 'pass',
			reason: `${passed.length} disk(s) pass ${testName}: ${line('pass')}${rest ? ` | ${rest}` : ''}`,
			metrics,
		};
	if (blocked.length)
		return {
			status: 'could-not-look',
			reason: `no disk passes ${testName}, and ${blocked.length} could not be judged: ${rest}`,
			metrics,
		};
	return { status: 'fail', reason: `no disk passes ${testName}: ${rest}`, metrics };
}
