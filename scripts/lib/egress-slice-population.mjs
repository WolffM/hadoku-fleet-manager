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

/**
 * Findings and idle reports for every `directEgress` entry, from `population`
 * (cgroup -> process count, or null when the cgroup does not exist).
 *
 * @returns {{ findings: object[], idle: object[] }}
 */
export function slicePopulationFindings(spec, population) {
	const findings = [];
	const idle = [];
	for (const entry of spec.directEgress ?? []) {
		const cgroup = entry.cgroup;
		const count = population.get(cgroup);
		const rec = idleRecord(entry);
		if (rec.malformed) {
			findings.push({ status: 'idle-malformed', cgroup, why: rec.malformed });
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
		} else if (count === 0) {
			findings.push({
				status: 'empty-slice',
				cgroup,
				why:
					'is declared direct-egress but the kernel has no process in it. A policy keyed ' +
					'on it would route nothing and still look exactly as green as a working one. ' +
					'If it is empty on purpose, record that on its entry as ' +
					'`idle: { since, why }` in egress-slices.json.',
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
	return { findings, idle };
}
