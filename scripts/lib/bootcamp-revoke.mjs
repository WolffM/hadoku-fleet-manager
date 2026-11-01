/**
 * `fleet bootcamp`'s revocation write — split out of scripts/bootcamp.mjs
 * (wave 5p lane D) so the CLI stays under the 800-line ceiling. Takes the
 * CLI's flags and run-scoped state through `ctx`; never imports the CLI.
 */
import {
	applyVerdicts,
	readRevocations,
	writeRevocations,
} from '../../dist/capability-revocations.js';
import { stateDir } from './paths.mjs';

/**
 * Revoke what this run saw fail and clear what it saw pass — one write, after
 * every node answered. An unreadable record is left alone and said: rewriting
 * it from this run's partial view would re-grant whatever it held for nodes
 * this run did not probe.
 *
 * THIS WRITE IS NOT GATED BY `--write`, DELIBERATELY (#15). `--write` governs
 * the `$capabilities` facet alone; a revocation is a SAFETY stop, not a
 * finding to record later — a label a probe just watched FAIL must stop
 * routing to it immediately, or the next dispatch sends a job at a node this
 * very run proved cannot do it. Saying so only in a code comment is how a
 * dry run came to read as fully read-only: the output below says it in every
 * run that actually changes a revocation, and the `--json` document carries
 * it as `writesEvenWithoutWrite` so a caller never has to infer the rule from
 * prose.
 */
export function computeRevocationChanges(ctx) {
	const { log, revocationVerdicts, WRITE } = ctx;
	const read = readRevocations(stateDir());
	if (read.corrupt) {
		log(`── revocations: the record is unreadable (${read.why}) — nothing revoked or cleared.`);
		return { revoked: [], cleared: [], unreadable: read.why, writesEvenWithoutWrite: true };
	}
	const applied = applyVerdicts(read.nodes, revocationVerdicts, 'bootcamp');
	const changedRevocations = applied.revoked.length > 0 || applied.cleared.length > 0;
	if (changedRevocations) writeRevocations(stateDir(), applied.nodes);
	for (const v of applied.revoked) {
		log(
			`── ${v.node}  REVOKED ${v.capability} — withheld from routing until a probe passes (${v.reason})`
		);
	}
	for (const v of applied.cleared)
		log(`── ${v.node}  cleared ${v.capability} — proven again, routable`);
	// SAID OUT LOUD, NOT ONLY IN A COMMENT (#15). Without this line a `--write`-
	// less run that just revoked or cleared a label reads as a dry run that
	// changed nothing on disk — exactly backwards.
	if (!WRITE && changedRevocations) {
		log(
			`  revocations are written in every mode, with or without --write: a label this run\n` +
				`  saw FAIL must stop routing immediately, so the above was not a dry run.`
		);
	}
	return { revoked: applied.revoked, cleared: applied.cleared, writesEvenWithoutWrite: true };
}
