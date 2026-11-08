/**
 * label-floor-resident — the fleet's ONE backstop (resident CI holders),
 * checked by reading GitHub directly: at least two holders, never a drained
 * one.
 *
 * Moved out of `check-label-floor.mjs` (wave shrink-1 lane D), body
 * unchanged.
 *
 * RESIDENT FLOOR — the reason it moved off claw-1 on 2026-09-07 (WS-R,
 * operator decision).
 *
 * `residentRepos` on an ephemeral node is a STANDING registration kept so a
 * repo's own CI can run even when the dispatcher is broken — the guarantee
 * that ended the 2026-09-02 deadlock (jit-name-length-ceiling in this
 * package's memory: `check` and `publish` both queued forever, because
 * minting was broken and nothing could fix it without CI). The rule since
 * 2026-09-07 is AT LEAST TWO HOLDERS, NEVER A DRAINED ONE — one holder is
 * exactly the single point of failure the move away from claw-1 exists to
 * remove.
 *
 * Neither half is provable from the manifest alone: a declared holder can be
 * offline, unlabelled (born that way, awaiting the fast loop's next promote),
 * or drained. So this reads GitHub directly, same as everything else in this
 * gate reads live state rather than a declaration.
 *
 * `resident-drained`/`resident-understaffed` are DEMOTED to notes (wave
 * gates2 lane F1b, operator-approved): queue-health already measures the
 * outcome an understaffed or drained backstop would cause (jobs queueing),
 * so this gate reports the condition without failing on it or counting it as
 * a finding. Every OTHER resident-floor conclusion — above all a `gh` read
 * that exhausted its retries, which is "I could not look", never a note —
 * still fails the gate exactly as before.
 */

import { BUILDER_LABEL } from '../../dist/lib/capability-registry-ids.js';
import { READ_ATTEMPTS, describeReadFailure } from './read-retry-policy.mjs';
import { listRunners } from './gh-runners.mjs';
import { drainedNodeNames } from './label-floor-check.mjs';

/**
 * @param {object} manifest
 * @param {object[]} gateFindings mutated: resident failures are pushed here
 * @param {object[]} gateUnreadable mutated: unreadable resident repos are pushed here
 * @param {object[]} gateNotes mutated: demoted resident conclusions (drained/understaffed) are pushed here
 */
export async function checkResidentFloor(manifest, gateFindings, gateUnreadable, gateNotes) {
	const residentHolders = new Map();
	for (const [name, m] of Object.entries(manifest.machines ?? {})) {
		for (const repo of m.residentRepos ?? []) {
			if (!residentHolders.has(repo)) residentHolders.set(repo, []);
			residentHolders.get(repo).push(name);
		}
	}

	const residentFailures = [];
	const residentNotes = [];
	if (residentHolders.size) {
		const drained = drainedNodeNames();
		for (const [repo, holders] of residentHolders) {
			const drainedHolders = holders.filter((n) => drained.has(n));
			const probe = await listRunners(repo, {
				attempts: READ_ATTEMPTS,
				describeFailure: describeReadFailure,
			});
			if (!probe.ok) {
				// "I could not look" must never render as "the floor holds" — see
				// CLAUDE.md. A repo whose registrations could not be read is reported
				// as a failure naming why, not skipped. GateDoc (wave 5i lane B): a
				// `gh` read that exhausted READ_ATTEMPTS is "I could not look",
				// never a finding — same reasoning check-boundary-contracts.mjs's
				// own `bad(..., { unreadable: true })` applies to its exhausted
				// reads.
				const why =
					`could not read its runner registrations from GitHub ` +
					`(${String(probe.error ?? '')
						.trim()
						.slice(0, 160)}). Declared holder(s): ${holders.join(', ')}.`;
				residentFailures.push(`"${repo}" — ${why}`);
				gateUnreadable.push({ node: null, why: `"${repo}" — ${why}` });
				continue;
			}
			const runners = probe.runners;
			const online = holders.filter((node) =>
				runners.some(
					(r) =>
						(r.name === node || r.name.startsWith(`${node}-`)) &&
						r.status === 'online' &&
						(r.labels ?? []).some((l) => l.name === BUILDER_LABEL)
				)
			);
			if (drainedHolders.length) {
				// DEMOTED (wave gates2 lane F1b): a note, not a finding — pushed to
				// `residentNotes`/`gateNotes` ONLY, never `residentFailures`/
				// `gateFindings`, so it is reported but never fails the gate.
				const reason =
					`"${repo}" — resident holder(s) ${drainedHolders.join(', ')} are DRAINED. ` +
					`The rule is at least two holders and never a drained one: drain a ` +
					`replacement holder in first, then drain this one.`;
				residentNotes.push(reason);
				gateNotes.push({ node: null, kind: 'resident-drained', reason });
			}
			if (online.length < 2) {
				// DEMOTED (wave gates2 lane F1b): same as above.
				const reason =
					`"${repo}" — only ${online.length} of its declared resident holder(s) ` +
					`(${holders.join(', ')}) are online carrying ${BUILDER_LABEL}. Need at ` +
					`least 2: this is the fleet's ONE backstop repo and a single holder is the ` +
					`single point of failure the 2026-09-07 move off claw-1 exists to remove.`;
				residentNotes.push(reason);
				gateNotes.push({ node: null, kind: 'resident-understaffed', reason });
			}
		}
	}

	return { residentHolders, residentFailures, residentNotes };
}
