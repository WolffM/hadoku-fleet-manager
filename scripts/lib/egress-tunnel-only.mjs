/**
 * THE TUNNEL-ONLY CLASS of the egress taxonomy (fleet-manager#85).
 *
 * `directEgress` names the cgroups that must leave hokon on the real WAN
 * address. `tunnelOnly` is the opposite promise: traffic from these cgroups
 * may leave only through the VPN, and is DROPPED when the VPN is down. It is
 * the kill switch for these processes alone, because hokon's own kill switch
 * stays off. fleet-manager states the class; local-hawk enforces it, as it
 * does the direct class.
 *
 * Each entry names its `apps`. A PM2 app in a tunnel-only cgroup that its
 * entry does not name is a finding, because a cgroup that accepts whatever
 * lands in it would be the drift this taxonomy exists to catch. An app the
 * class names that still runs somewhere else is reported as PENDING, never as
 * a finding: the class lands before the app moves, and the gate must pass on
 * the box as it is today (a new gate starts quiet).
 *
 * Zero imports, so the gate and its tests read one definition.
 */

/** Two cgroup paths that one prefix match could confuse: equal, or one under the other. */
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * Problems with the `tunnelOnly` half of `spec`, as gate findings. An absent
 * key is no class and no problem: local-hawk reads it as optional too.
 */
export function tunnelOnlyProblems(spec) {
	const entries = spec.tunnelOnly ?? [];
	if (!Array.isArray(entries))
		return [{ status: 'tunnel-only-malformed', why: '`tunnelOnly` must be an array of entries.' }];
	const problems = [];
	const bad = (cgroup, why) => problems.push({ status: 'tunnel-only-malformed', cgroup, why });
	entries.forEach((e, i) => {
		const cgroup = e?.cgroup;
		if (typeof cgroup !== 'string' || !cgroup.startsWith('/') || cgroup.endsWith('/'))
			bad(cgroup ?? `tunnelOnly[${i}]`, 'needs `cgroup`: an absolute path, no trailing slash.');
		if (!Array.isArray(e?.apps) || !e.apps.length || !e.apps.every((a) => typeof a === 'string'))
			bad(cgroup ?? `tunnelOnly[${i}]`, 'needs `apps`: the PM2 apps placed in it, by name.');
		if (typeof e?.why !== 'string' || !e.why.trim())
			bad(cgroup ?? `tunnelOnly[${i}]`, 'needs `why`: the decision that put it there.');
	});
	const paths = entries.map((e) => e?.cgroup).filter((c) => typeof c === 'string');
	for (const t of paths) {
		for (const d of (spec.directEgress ?? []).map((x) => x.cgroup)) {
			if (overlaps(t, d))
				problems.push({
					status: 'tunnel-only-conflict',
					cgroup: t,
					why:
						`overlaps the direct-egress cgroup ${d}: one process cannot both wear the real ` +
						'address and be dropped without the tunnel. Pick one class.',
				});
		}
	}
	paths.forEach((t, i) => {
		for (const u of paths.slice(i + 1))
			if (overlaps(t, u))
				problems.push({
					status: 'tunnel-only-conflict',
					cgroup: t,
					why: `overlaps the tunnel-only cgroup ${u}; each path belongs to one entry.`,
				});
	});
	return problems;
}

/**
 * Where `name`, observed in `cgroup`, stands against the tunnel-only class:
 *
 *   { ok }       placed in the entry that names it: egress `tunnel-only`
 *   { finding }  in a tunnel-only cgroup whose entry does not name it
 *   { pending }  named by an entry, observed somewhere else (not moved yet)
 *   {}           the class has nothing to say about it
 *
 * `ok` and `finding` decide the app; `pending` is additive, and the caller
 * still judges the app where it actually is.
 */
export function tunnelOnlyPlacement(spec, name, cgroup) {
	const entries = Array.isArray(spec.tunnelOnly) ? spec.tunnelOnly : [];
	const holding = entries.find(
		(e) =>
			typeof e?.cgroup === 'string' && (cgroup === e.cgroup || cgroup?.startsWith(`${e.cgroup}/`))
	);
	if (holding) {
		if (Array.isArray(holding.apps) && holding.apps.includes(name))
			return { ok: { egress: 'tunnel-only', tunnelOnly: holding.cgroup } };
		return {
			finding: {
				status: 'tunnel-only-unnamed',
				why:
					`sits in the tunnel-only cgroup ${holding.cgroup}, whose entry does not name it. ` +
					'Its traffic is dropped whenever the VPN is down; name it in that entry if that ' +
					'is the decision, or move it back.',
			},
		};
	}
	const naming = entries.find((e) => Array.isArray(e?.apps) && e.apps.includes(name));
	if (naming)
		return {
			pending: {
				tunnelOnly: naming.cgroup,
				observed: cgroup,
				why:
					`is named tunnel-only (${naming.cgroup}) but runs in ${cgroup ?? 'an unread cgroup'}, ` +
					'so it is not yet under that class. Expected until its wrapper moves it.',
			},
		};
	return {};
}
