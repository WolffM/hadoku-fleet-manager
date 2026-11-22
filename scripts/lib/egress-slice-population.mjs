/**
 * The population half of the egress-slices gate: does each direct-egress
 * cgroup the taxonomy declares hold anything? (fleet-manager#106)
 *
 * A TAXONOMY ENTRY THAT MATCHES NOTHING ROUTES NOTHING. The same shape as a
 * manifest resolving to an empty directory and reporting a healthy fleet of
 * zero machines: the policy would be installed, apply to no process, and look
 * exactly as green as a working one. So a declared cgroup that is missing, or
 * that the kernel shows empty, is a finding.
 *
 * Unless the emptiness is a DECISION. An entry may carry
 * `idle: { since: 'YYYY-MM-DD', why }`: declared, kept, and empty on purpose
 * (gameservers.slice from 2026-11-16, its servers stopped and kept for a later
 * move). An idle entry that is empty is reported, never failed. The record
 * covers emptiness and nothing else: the day a process appears in an idle
 * cgroup it is a finding, because something moved in under a classification
 * nobody re-decided, and a missing cgroup is still missing.
 *
 * Or unless the slice is OCCUPIED ON DEMAND. An entry may carry
 * `onDemand: { why }`: a slice whose members are started and stopped by a
 * person, not by the fleet (vpnbypass.slice holds the operator's desktop
 * Discord and Battle.net, and is empty whenever neither is open; hadoku_site#616).
 * Empty and populated are both its normal states, so emptiness is reported and
 * a process in it is not a finding. The cgroup itself must still exist: the
 * routing rule is keyed on its path, and a missing path is the one thing this
 * gate can check with nobody in the slice. `idle` and `onDemand` contradict
 * each other (a process appearing is a finding under one and normal under the
 * other), so an entry carrying both is malformed.
 *
 * The gate's JSON carries both reports ADDITIVELY, as `idleSlices` and
 * `onDemandSlices`: ci:egress-slices reads `findings` and ignores the rest.
 *
 * Zero imports, so the gate and its tests read one definition.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The entry's `idle` record when it is well formed, else a reason it is not. */
function idleRecord(entry) {
	const idle = entry?.idle;
	if (idle === undefined) return { idle: null };
	if (
		typeof idle?.since !== 'string' ||
		!DAY.test(idle.since) ||
		typeof idle?.why !== 'string' ||
		!idle.why.trim()
	)
		return { malformed: '`idle` needs `since` (YYYY-MM-DD) and `why`: who decided, and why.' };
	return { idle };
}

/** The entry's `onDemand` record when it is well formed, else a reason it is not. */
function onDemandRecord(entry) {
	const onDemand = entry?.onDemand;
	if (onDemand === undefined) return { onDemand: null };
	if (entry.idle !== undefined)
		return {
			malformed:
				'`idle` and `onDemand` contradict each other: idle says a process appearing is a ' +
				'finding, onDemand says it is normal. Keep the one that is true.',
		};
	if (typeof onDemand?.why !== 'string' || !onDemand.why.trim())
		return { malformed: '`onDemand` needs `why`: who starts what runs in it, and why.' };
	return { onDemand };
}

/**
 * Findings, idle and on-demand reports for every `directEgress` entry, from `population`
 * (cgroup -> process count, or null when the cgroup does not exist).
 *
 * @returns {{ findings: object[], idle: object[], onDemand: object[] }}
 */
export function slicePopulationFindings(spec, population) {
	const findings = [];
	const idle = [];
	const onDemand = [];
	for (const entry of spec.directEgress ?? []) {
		const cgroup = entry.cgroup;
		const count = population.get(cgroup);
		const rec = idleRecord(entry);
		if (rec.malformed) {
			findings.push({ status: 'idle-malformed', cgroup, why: rec.malformed });
			continue;
		}
		const demand = onDemandRecord(entry);
		if (demand.malformed) {
			findings.push({ status: 'on-demand-malformed', cgroup, why: demand.malformed });
			continue;
		}
		if (count === null || count === undefined) {
			findings.push({
				status: 'missing-slice',
				cgroup,
				why:
					'is declared direct-egress but does not exist under /sys/fs/cgroup. The path ' +
					'moved or was never created, and a policy keyed on it matches nothing.',
			});
		} else if (count === 0 && rec.idle) {
			idle.push({ cgroup, since: rec.idle.since, why: rec.idle.why });
		} else if (count === 0 && demand.onDemand) {
			onDemand.push({ cgroup, why: demand.onDemand.why });
		} else if (count === 0) {
			findings.push({
				status: 'empty-slice',
				cgroup,
				why:
					'is declared direct-egress but the kernel has no process in it. A policy keyed ' +
					'on it would route nothing and still look exactly as green as a working one. ' +
					'If it is empty on purpose, record that on its entry as ' +
					'`idle: { since, why }` in egress-slices.json; if a person starts and stops ' +
					'what runs in it, as `onDemand: { why }`.',
			});
		} else if (rec.idle) {
			findings.push({
				status: 'idle-slice-populated',
				cgroup,
				why:
					`is recorded idle since ${rec.idle.since} but holds ${count} process(es). ` +
					'Something moved in without its egress class being re-decided: confirm it ' +
					'belongs in a direct-egress cgroup, then remove the `idle` record.',
			});
		}
	}
	return { findings, idle, onDemand };
}
