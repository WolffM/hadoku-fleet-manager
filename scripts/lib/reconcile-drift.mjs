/**
 * reconcile-drift — diffs desired coverage against the ACTUAL GitHub runner
 * state: capability drift, offline/missing/excluded pairs, orphans on a
 * retired repo, and the per-node registration cap.
 *
 * Moved out of `reconcile-fleet-runners.mjs` (wave shrink-1 lane D), body
 * unchanged. See that file's header for the asymmetry this encodes
 * (registering restores coverage, removing takes it away) and why an
 * offline registration is never read as missing.
 */

import { deferralFor } from './expected-down.mjs';
import { offeredLabels } from './reconcile-apply.mjs';
import { clawOfRunner } from './reconcile-claw-owner.mjs';

/**
 * @param {{repos: string[], retiredScoped: {repo:string, why:string}[],
 *   desired: Map<string,{claws:string[]}>, actual: Map<string,object>,
 *   manifest: object, drains: object}} args
 */
export function computeDrift({ repos, retiredScoped, desired, actual, manifest, drains }) {
	const missing = []; // (repo, claw) to register
	const capDrift = []; // runners lacking a capability their node declares
	const offline = [];
	const unmanaged = [];
	const orphans = []; // removable: retired repo that still has claw runners
	// Registrations on a node the manifest no longer wants for this repo.
	//
	// Until 2026-08-26 this category did not exist and the diff ran in ONE
	// direction only (`want -> seen`), so a registration outside `want` was not
	// missing, not an orphan, not unmanaged — it was invisible. That is why
	// adding a repo to a node's `excludeRepos` appeared to offload it and in
	// fact removed nothing, uninstalled nothing, and reported nothing.
	const excluded = [];
	const unreadable = [];

	for (const repo of repos) {
		const state = actual.get(repo);
		if (!state.ok) {
			unreadable.push({ repo, error: state.error });
			continue;
		}
		const want = desired.get(repo).claws;
		const seen = new Map();
		// EVERY managed registration, recorded before any of the short-circuits
		// below. `seen` deliberately skips demoted and offline runners, so it
		// cannot answer "does this pair exist at all" — which is exactly the
		// question the reverse diff needs.
		const present = new Map();
		for (const r of state.runners) {
			const claw = clawOfRunner(r.name);
			if (!claw) {
				unmanaged.push({ repo, runner: r.name, status: r.status });
				continue;
			}
			present.set(claw, r);

			// --- capability drift ---------------------------------------------
			// A node's declared `labels` are its CAPABILITIES, and until now the
			// only thing that ever applied them was registration. So a capability
			// added to the manifest reached new runners and no existing ones, and
			// 27 hokon runners carried none of hokon's own `pm2-host`.
			//
			// ADDITIVE ONLY. Undeclared labels are reported, never stripped: this
			// file does not know about `hokon-backstop`, which runner-health writes
			// and nothing declares, and a reconcile that removed what it had not
			// been told about would silently unroute live jobs. Same asymmetry the
			// rest of this script uses — registering restores, removing takes away.
			//
			// ELIGIBILITY capabilities are excluded on both sides, and `identityLabels`
			// is what knows which those are. It used to be a literal
			// `.filter(l => l !== BUILDER_LABEL)` — correct, and only ever correct
			// about the one eligibility label whoever wrote it remembered to name.
			// `hadoku-builder` is owned by the fast loop (and, on the backstop, by
			// the backstop decision), which flip it as nodes become safe or unsafe; treating it
			// as a capability here would make the tools fight over the same label.
			// WHAT THE NODE OFFERS — declared AND earned, workload-gated — not the
			// declared array alone. Against `identityLabels` a standing runner never
			// gained a label its node EARNED: hokon earned jdk21 and cargo-bevy on
			// 2026-10-09 and its 28 runners kept the three it declared, so a promoted
			// hokon could never take a Forge job. Additive: nothing is stripped.
			const offered = offeredLabels(manifest, claw);
			const have = new Set(r.labels.map((l) => l.name));
			const missingCaps = offered.filter((l) => !have.has(l));
			if (missingCaps.length) {
				capDrift.push({ repo, claw, runner: r.name, id: r.id, add: missingCaps });
			}

			// A REGISTRATION THAT EXISTS IS COVERAGE, whatever its labels. Labels
			// are eligibility, written by the fast loop as a node becomes safe or
			// unsafe (and by the backstop decision on the backstop); a runner without one is
			// present and simply not eligible right now. Reading it as MISSING made
			// --confirm re-register over it with `config.sh --replace`, stealing a
			// healthy registration. Until 2026-09-21 only surge-tier nodes were
			// spared that reading — so a resident registration on claw-2 or claw-4,
			// born unlabelled, was one reconcile away from being stolen.
			// An OFFLINE runner is a registration that EXISTS, so it is NOT missing
			// coverage. Counting it as both made this tool contradict its own
			// contract ("Reinstall an offline runner. That is an incident" — see the
			// header): `missing` is exactly what --confirm registers, and registering
			// a name that is already taken runs `config.sh --replace`, which STEALS
			// the registration from the live runner and orphans its listener.
			//
			// The trigger is not rare. GitHub reports a runner offline during any
			// blip in its own control plane; on 2026-08-25 a burst of 503s on
			// /acquirejob flipped hadoku_site's claw-3 to `offline busy=true` for
			// under two minutes WHILE IT WAS RUNNING A JOB, and a reconcile in that
			// window listed it as missing. The daily ci:fleet-coverage job auto-
			// applies up to 6 pairs, so a blip was one scheduling coincidence away
			// from killing a healthy mid-job runner.
			//
			// Same rule as the unlabelled case above: the runner is present, so
			// report the anomaly, never re-register over it.
			seen.set(claw, true);
			if (r.status !== 'online') {
				// mgmt-api types this array as `{repo, claw, runner}[]` and ignores
				// extra fields. `expectedDown` is carried ON THE ROW, so
				// the --json consumer and the exit code read the same fact from the
				// same place. Only a node drained for maintenance, dated and fresh,
				// qualifies (`deferralFor`); a registration that is merely offline on
				// an undrained node is exactly the incident this array exists to
				// report, and still fails. See lib/expected-down.mjs.
				//
				// `|| undefined` so `--json` stays additive in the strict sense, not
				// just the loose one: a row for a node nothing has drained is
				// byte-identical to the shape this array has always had —
				// `JSON.stringify` drops an `undefined` property — matching
				// `check-fleet-toolchain.mjs`'s own `drainNote: defer.deferred ? ... :
				// undefined` for the same reason.
				offline.push({
					repo,
					runner: r.name,
					claw,
					expectedDown: deferralFor(claw, drains).deferred || undefined,
				});
			}
		}
		for (const claw of want) if (!seen.has(claw)) missing.push({ repo, claw });
		// The other direction. Reported always; removed only under
		// --remove-excluded, matching this file's standing asymmetry that
		// registering restores coverage while removing takes it away.
		for (const [claw, r] of present) {
			if (want.includes(claw)) continue;
			excluded.push({
				repo,
				claw,
				runner: r.name,
				id: r.id,
				status: r.status,
				busy: r.busy === true,
			});
		}
	}

	for (const { repo, why } of retiredScoped) {
		const state = actual.get(repo);
		if (!state?.ok) continue;
		for (const r of state.runners) {
			const claw = clawOfRunner(r.name);
			if (claw) orphans.push({ repo, claw, runner: r.name, id: r.id, why });
		}
	}

	return { missing, capDrift, offline, unmanaged, orphans, excluded, unreadable };
}

/**
 * A node's limit is enforced here rather than trusted to prose. Until
 * 2026-08-23 the "~2.8 runners per core" rule lived only inside ten repo
 * entries' $why strings, so nothing noticed claw-3 reaching 19 registrations
 * (4.8/core) before the watchdog rebooted it at 92C on 2026-08-17.
 *
 * This bounds REGISTRATIONS, which is a proxy for disk and install footprint
 * — NOT a thermal control. Registrations sit idle at no cost; concurrent
 * builds are what cook a box, and nothing caps those yet.
 *
 * @param {{repos: string[], desired: Map<string,{claws:string[]}>, manifest: object}} args
 */
export function computeCapacityGate({ repos, desired, manifest }) {
	const perNode = new Map();
	for (const r of repos)
		for (const c of desired.get(r).claws) perNode.set(c, (perNode.get(c) ?? 0) + 1);
	const overCapacity = [];
	for (const [node, cfg] of Object.entries(manifest.machines)) {
		const cap = cfg.maxRegistrations;
		if (cap === undefined) continue;
		const want = perNode.get(node) ?? 0;
		// `node` is a --json KEY: this subcommand is in JSON_CONTRACT and
		// ci:fleet-coverage parses its stdout. See docs/VOCABULARY.md.
		if (want > cap) overCapacity.push({ machine: node, want, cap, cores: cfg.cores });
	}
	return { perNode, overCapacity };
}
