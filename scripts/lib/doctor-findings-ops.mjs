/**
 * doctor-findings-ops — judges the operational bookkeeping facets of
 * `$health`: a staged/cycled reboot, failed `actions.runner` units, every
 * other failed systemd unit, unclaimed pm2 managers, and the age of the
 * bootcamp pointer.
 *
 * Moved out of `doctor-findings.mjs` (wave shrink-1 lane D), body unchanged.
 */

import { ADVISORY, BLOCKING, rebootFinding } from './preflight.mjs';
import { f } from './doctor-findings-record.mjs';
import { BOOTCAMP_STALE_DAYS } from './doctor-findings-thresholds.mjs';

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

	// ── pm2 managers nothing claims ───────────────────────────────────────────
	// `pm2Claims` is ATTACHED by doctor-run from the tenant registry, the hosting
	// declarations and the app layer's host list (lib/hosting-claims.mjs), like
	// the bootcamp pointer: never stored, so a reader without those records
	// draws nothing rather than a stale verdict. An unclaimed manager is memory
	// no budget counts and keeps `not-beside-unbounded` tenants off the node, so
	// it BLOCKS; a declared host with no apps and no ceiling is hadoku_site's
	// call and is advisory.
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
