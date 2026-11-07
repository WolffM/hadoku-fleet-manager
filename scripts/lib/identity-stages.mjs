/**
 * Every identity-model rule's STAGE: advisory, or enforced (fleet-manager#67).
 *
 * WHY. G9 enforced the moment the package carrying it landed, and hadoku_site's
 * Lint went red 13 times before anyone could fix what it found. A rule this
 * gate learns is a rule the fleet has been breaking all along; the release that
 * TEACHES it must not also be the one that FAILS everyone on it.
 *
 * THE RULE. A new check ships `advisory`: its findings print (and ride in
 * `--json` as `advisories`) but never set the exit code. The NEXT release flips
 * it to `enforced`, recording `advisorySince` as the evidence it was staged.
 * A check id with no entry here fails this repo's own tests
 * (identity-stages.test.mjs), so a rule cannot arrive unstaged.
 *
 * An advisory rule older than {@link ADVISORY_MAX_DAYS} is reported by the gate
 * itself as OVERDUE, in its output and in `--json`, rather than reddening this
 * repo's CI on a calendar date: a test that goes red with no commit blocks every
 * landing at once (fixture-clock-guard.test.mjs is that lesson).
 *
 * G1..G9 predate staging and are `grandfathered`.
 */

/** @typedef {{ stage: 'advisory', since: string } | { stage: 'enforced', advisorySince?: string, grandfathered?: true }} RuleStage */

/** @type {Record<string, RuleStage>} keyed by rule family: `G9` covers G9a, G9b and G9c. */
export const RULE_STAGES = {
	G1: { stage: 'enforced', grandfathered: true },
	G2: { stage: 'enforced', grandfathered: true },
	G3: { stage: 'enforced', grandfathered: true },
	G4: { stage: 'enforced', grandfathered: true },
	G5: { stage: 'enforced', grandfathered: true },
	G6: { stage: 'enforced', grandfathered: true },
	G7: { stage: 'enforced', grandfathered: true },
	G8: { stage: 'enforced', grandfathered: true },
	G9: { stage: 'enforced', grandfathered: true },
};

/** How long a rule may stay advisory before the gate calls it overdue. */
export const ADVISORY_MAX_DAYS = 21;

/** A check id's family: `G9b` -> `G9`. */
export const familyOf = (check) => String(check).replace(/[a-z]+$/, '');

/** The stage entry for a check id, or null when nothing declares it. */
export function stageOf(check, stages = RULE_STAGES) {
	return stages[check] ?? stages[familyOf(check)] ?? null;
}

/**
 * Split findings by their rule's stage. An UNDECLARED rule is enforced: a gap
 * in this table must never quietly soften a finding.
 */
export function splitByStage(violations, stages = RULE_STAGES) {
	const enforced = [];
	const advisory = [];
	for (const v of violations)
		(stageOf(v.check, stages)?.stage === 'advisory' ? advisory : enforced).push(v);
	return { enforced, advisory };
}

/** Advisory rules past {@link ADVISORY_MAX_DAYS}: each is a flip to `enforced` that is due. */
export function overdueAdvisories(nowMs = Date.now(), stages = RULE_STAGES) {
	return Object.entries(stages)
		.filter(
			([, s]) =>
				s.stage === 'advisory' && nowMs - Date.parse(s.since) > ADVISORY_MAX_DAYS * 86_400_000
		)
		.map(
			([id, s]) =>
				`${id} advisory since ${s.since}: flip it to enforced in scripts/lib/identity-stages.mjs`
		);
}
