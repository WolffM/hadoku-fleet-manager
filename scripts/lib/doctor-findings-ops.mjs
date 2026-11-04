/**
 * doctor-findings-ops — judges the operational bookkeeping facets of
 * `$health`: a staged/cycled reboot, failed `actions.runner` units, every
 * other failed systemd unit, the default-route NIC's link, unclaimed pm2
 * managers, and the age of the bootcamp pointer.
 *
 * Moved out of `doctor-findings.mjs` (wave shrink-1 lane D), body unchanged.
 */

import { ADVISORY, BLOCKING, rebootFinding } from './preflight.mjs';
import { f } from './doctor-findings-record.mjs';

import { BOOTCAMP_STALE_DAYS } from '../../dist/lib/workload-gate.js';

/** A wired link below this has lost a pair or a port: every wired node read 1000 on 2026-11-03. */
export const NIC_FULL_MBPS = 1000;
/** More link drops than this in one boot is flapping: the same evening every node read 0-1, claw-4 633. */
export const NIC_FLAP_DOWNS = 5;

/**
 * @param {ReturnType<import('./doctor-facet.mjs').healthFacet>} health
 * @param {{nowMs?: number}} [opts]
 * @returns {object[]}
 */
export function opsFindings(health, { nowMs = Date.now() } = {}) {
	const out = [];

	// ── a staged reboot. preflight.mjs already owns this judgement. ───────────
	const reboot = rebootFinding(
		{
			node: health.node,
			ok: true,
			rebootRequired: health.reboot?.required ?? false,
			packages: health.reboot?.packages ?? [],
			stagedAtMs: health.reboot?.stagedAt ? Date.parse(health.reboot.stagedAt) : null,
		},
		{ nowMs }
	);
	// WHAT THE REBOOT CYCLE DECIDED (fleet reboot-claws, hourly), attached by
	// doctor-run from the cycle's own state. The staged flag says a reboot is
	// owed; this says whether one is coming, and if not, what is stopping it.
	const cycle = health.reboot?.cycle ?? null;
	const cycleNote = cycle
		? ` The reboot cycle last looked at ${cycle.at}: ${cycle.status}${cycle.why ? ` — ${cycle.why}` : ''}.`
		: '';
	if (reboot) out.push({ ...reboot, node: health.node, why: `${reboot.why}${cycleNote}` });
	if (cycle?.status === 'held') {
		out.push(
			f(
				health,
				'reboot-held',
				BLOCKING,
				'held',
				`${health.node} was rebooted by the reboot cycle and FAILED verification, so it is held ` +
					`out of service and no other claw reboots until a human lifts it:${cycleNote} ` +
					`Check it, then \`fleet drain ${health.node} --undo\`.`
			)
		);
	}

	// ── failed CI units ───────────────────────────────────────────────────────
	if ((health.runners?.failed ?? 0) > 0) {
		out.push(
			f(
				health,
				'runner-units',
				BLOCKING,
				'failed',
				`${health.runners.failed} actions.runner unit(s) are in the failed state on this node.`,
				{ failed: health.runners.failed }
			)
		);
	}

	// ── every other failed unit ───────────────────────────────────────────────
	// ADVISORY, both ways. The first three this found (claw-5/6 networkd, claw-3's
	// cktest-runner retired 07-30, claw-1's modules-load from a boot before DKMS
	// rebuilt nvidia) were leftovers, not outages, and none is a reason to refuse
	// a node work. Being unable to list units is advisory for the same reason: it
	// may not render as clean, and it is no worse than finding one. `actions.runner.*`
	// is left to the BLOCKING `runner-units` finding above. A record written before
	// this probe existed has no `failedUnits` and draws nothing — it never asked.
	const fu = health.failedUnits;
	if (fu && fu.units === null) {
		out.push(
			f(
				health,
				'failed-units',
				ADVISORY,
				'unknown',
				`whether any systemd unit has failed on this node could not be read: ${fu.why}.`
			)
		);
	} else if (fu) {
		const units = fu.units.filter((u) => !u.unit.startsWith('actions.runner.'));
		if (units.length > 0) {
			out.push(
				f(
					health,
					'failed-units',
					ADVISORY,
					'failed',
					`${units.length} systemd unit(s) failed: ` +
						units.map((u) => `${u.unit} (since ${u.since ?? 'an unreported time'})`).join(', ') +
						'. `systemctl status <unit>` on the node says why; `systemctl reset-failed` clears a ' +
						'stale one only once its cause is gone.',
					{ units }
				)
			);
		}
	}

	// ── the default-route NIC ─────────────────────────────────────────────────
	// ADVISORY. 2026-11-03: claw-4's link dropped 633 times in 1h43m, each time
	// back at 100 Mbps (a damaged cable), with two services on the node. A wired
	// link below gigabit, or more than NIC_FLAP_DOWNS drops this boot, is a cable
	// or port to look at before it becomes an outage; every wired node read 1000
	// Mbps and 0-1 drops the same evening. Wi-Fi links are not judged here. A
	// record written before this probe existed has no `nic` and draws nothing.
	const nic = health.nic;
	if (nic && nic.iface === null) {
		out.push(
			f(
				health,
				'nic-link',
				ADVISORY,
				'unknown',
				`the default-route NIC could not be read: ${nic.why}.`
			)
		);
	} else if (nic?.kind === 'wired') {
		if (nic.speedMbps === null || nic.linkDowns === null) {
			out.push(
				f(
					health,
					'nic-link',
					ADVISORY,
					'unknown',
					`${nic.iface}'s link could not be fully read: ${nic.why}.`
				)
			);
		}
		if (nic.speedMbps !== null && nic.speedMbps < NIC_FULL_MBPS) {
			out.push(
				f(
					health,
					'nic-link',
					ADVISORY,
					'degraded',
					`${nic.iface} negotiated ${nic.speedMbps} Mbps, below ${NIC_FULL_MBPS}. Gigabit needs all four ` +
						'pairs, so a damaged or half-seated cable falls back to 100: reseat or replace it, then check ' +
						`\`cat /sys/class/net/${nic.iface}/speed\`.`,
					{ iface: nic.iface, speedMbps: nic.speedMbps }
				)
			);
		}
		if (nic.linkDowns !== null && nic.linkDowns > NIC_FLAP_DOWNS) {
			out.push(
				f(
					health,
					'nic-link',
					ADVISORY,
					'flapping',
					`${nic.iface} dropped its link ${nic.linkDowns} times this boot (more than ${NIC_FLAP_DOWNS}). ` +
						`\`journalctl -k -b | grep "${nic.iface}.*Link is"\` shows when, and at what speed it came back.`,
					{ iface: nic.iface, linkDowns: nic.linkDowns }
				)
			);
		}
	}

	// ── pm2 managers nothing claims ───────────────────────────────────────────
	// `pm2Claims` is ATTACHED by doctor-run from the tenant registry, the hosting
	// declarations and the app layer's host list (lib/hosting-claims.mjs), like
	// the bootcamp pointer: never stored, so a reader without those records
	// draws nothing rather than a stale verdict. An unclaimed manager is memory
	// no budget counts and keeps `not-beside-unbounded` tenants off the node, so
	// it BLOCKS; a declared host with no apps and no ceiling is advisory until
	// the toolchain floor's pm2-boot bounds it.
	if (health.pm2Units?.units === null) {
		out.push(
			f(
				health,
				'pm2-claims',
				ADVISORY,
				'unknown',
				`which pm2 managers run on this node could not be read: ${health.pm2Units.why}.`
			)
		);
	}
	for (const c of health.pm2Claims ?? []) {
		if (c.severity === 'ok') continue;
		out.push(
			f(
				health,
				'pm2-claims',
				c.severity === 'advisory' ? ADVISORY : BLOCKING,
				c.claim,
				`${c.unit}: ${c.why}.`,
				{
					unit: c.unit,
					by: c.by,
				}
			)
		);
	}

	// ── the bootcamp pointer, aged ────────────────────────────────────────────
	const b = health.bootcamp ?? {};
	if (!b.at) {
		out.push(
			f(
				health,
				'bootcamp-record',
				ADVISORY,
				'missing',
				b.why ?? 'this node carries no $capabilities record, so nothing has proved what it can do.'
			)
		);
	} else {
		const ageDays = (nowMs - Date.parse(b.at)) / 86_400_000;
		if (!Number.isFinite(ageDays) || ageDays > BOOTCAMP_STALE_DAYS) {
			out.push(
				f(
					health,
					'bootcamp-record',
					ADVISORY,
					'stale',
					`$capabilities was last written ${Number.isFinite(ageDays) ? `${Math.round(ageDays)}d` : 'at an unparseable time'} ` +
						`ago (${b.at}) — past ${BOOTCAMP_STALE_DAYS}d. What this node can do is being read ` +
						'off a record older than the toolchain on it.',
					{ capabilitiesAt: b.at }
				)
			);
		}
	}

	return out;
}
