/**
 * `resolveDesired` — reconcile-fleet-runners.mjs's resolution of the manifest
 * against GitHub into the set of (repo, claw) pairs that SHOULD exist (wave
 * 5q lane B, pure move off the 800-line ceiling). Everything it needs from
 * the CLI's run — the committed roster, and `fail` for the one refusal this
 * function makes — is passed in explicitly; it imports nothing out of
 * `reconcile-fleet-runners.mjs`, which still owns MANIFEST, the CLI flags and
 * the final emit/exit (`scripts/lib/json-contract.mjs` scans the CLI file for
 * those, not this one).
 */
import { autoIncludeDrop, vanishedFromUniverse } from './roster-eligibility.mjs';
import { fleetOwner } from '../../dist/lib/fleet-config.js';
import { placementFor } from './reconcile-plan.mjs';
import {
	ghRepoListWithRetry,
	countWorkflows,
	targetsSelfHostedFleet,
	lookupRepo,
} from './reconcile-apply.mjs';

/**
 * Resolve the manifest against GitHub into the set of (repo, claw) pairs that
 * SHOULD exist, plus the repos whose coverage should be torn down.
 *
 * `fail(message)` is the CLI's `failEarly` — it stays the ONE place that
 * decides how a refusal reaches `--json` vs human stdout; this function only
 * calls it, on the single "empty universe" case below.
 */
export function resolveDesired(manifest, committedRoster, { fail }) {
	const explicit = Object.entries(manifest.repos ?? {});
	const ai = manifest.autoInclude ?? {};

	// THE ROSTER SHRINKING IS ITSELF AN EVENT.
	//
	// autoInclude is a DERIVED set: a repo enters when it starts matching and
	// leaves when it stops. Leaving used to be three bare `continue`s — no record,
	// no report, nothing. That is how a coverage gap closes without being fixed:
	//
	//   08-30  29 repos / 87 pairs  missing=9   <- paged, nothing installed
	//   08-31  26 repos / 78 pairs  missing=0   <- "recovered"
	//
	// Nobody installed a runner. Three repos stopped matching autoInclude and took
	// their own gap out of scope with them, and the gate reported a clean fleet.
	// That is precisely "'I could not look' must never render as 'nothing is
	// wrong'" — one level up from the reads it was written about, because here the
	// tool did not even know there was something it had stopped looking at.
	//
	// A repo in the COMMITTED roster that no longer matches is therefore recorded
	// as a DEPARTURE with the rule that dropped it. The operator's answer is an
	// explicit manifest entry — the same shape hadoku-registry already carries for
	// exactly this reason ("Live infra with only one workflow, so autoInclude's
	// minWorkflows would drop it") — or a deliberate `--write-coverage`.
	const covered = new Set(committedRoster);
	const departed = [];
	const leaves = (name, why) => {
		if (covered.has(name)) departed.push({ repo: name, why });
	};

	const all = ghRepoListWithRetry([
		'repo',
		'list',
		// The manifest's `autoInclude.owner` wins; otherwise the ecosystem's own
		// owner, resolved in ONE place (fleet-config) rather than spelled here.
		ai.owner ?? fleetOwner(),
		'--limit',
		'500',
		'--json',
		'nameWithOwner,isFork,isArchived,pushedAt',
	]);

	// AN EMPTY UNIVERSE IS A FAILURE, NOT AN EMPTY FLEET.
	//
	// `gh` exits non-zero on a real error and execFileSync throws, so a BROKEN
	// call already dies loudly. This is the other shape: a call that SUCCEEDS and
	// returns nothing — a token scoped to no repositories, an owner typo in
	// `autoInclude.owner`, a `gh` that authenticated as somebody else. Every
	// count downstream is then legitimately zero, the summary is all zeros, and
	// `ci:fleet-coverage` reads "every covered repo has a runner" off a fleet
	// nobody looked at.
	//
	// This is CLAUDE.md's rule — "zero repos scanned FAILS; exit 0 with no
	// evidence is a failure, not a pass" — and the guard `check-queue-health` and
	// `check-capability-schema` both already carry. The coverage gate, which is
	// the one that would act on the answer, did not.
	if (!all.length) {
		fail(
			`gh repo list returned NO repositories for owner "${ai.owner ?? fleetOwner()}". ` +
				'That is a fleet nobody could look at, not a fleet with nothing to do.'
		);
	}

	const byName = new Map(all.map((r) => [r.nameWithOwner, r]));
	const now = Date.now();

	const desired = new Map(); // repo -> { claws, reason }
	const retired = []; // repos whose coverage may be removed
	const ignored = []; // repos deliberately outside the reconciler's scope

	for (const repo of all) {
		const name = repo.nameWithOwner;
		const entry = manifest.repos?.[name];

		// `ignore` is the third answer, and it has to come first. `skip` means
		// "should have no runners" and therefore MAKES orphans; `ignore` means
		// "whatever it has, leave it and stop telling me". Without this, a dead
		// repo whose leftovers nobody intends to remove reports as an action item
		// forever — and a permanently non-empty report is one nobody reads.
		if (entry?.ignore) {
			ignored.push({ repo: name, why: entry.$why ?? 'ignore: true in the manifest' });
			continue;
		}

		if (entry?.skip) {
			retired.push({ repo: name, why: 'skip: true in the manifest' });
			continue;
		}
		if (repo.isArchived) {
			retired.push({ repo: name, why: 'archived on GitHub' });
			continue;
		}

		// An explicit entry is intent stated by a human and always wins — but it
		// says WHETHER the repo is covered, never WHERE. Where is derived.
		if (entry) {
			desired.set(name, { claws: placementFor(name, manifest), reason: 'manifest' });
			continue;
		}

		// ONE rule, in scripts/lib/roster-eligibility.mjs, returning the REASON.
		// `probe` passes the two expensive answers as functions so the ordering is
		// unchanged: countWorkflows is one API call and targetsSelfHostedFleet is
		// one per workflow file, and only a repo the cheap proxy would drop pays.
		const why = autoIncludeDrop(repo, ai, { countWorkflows, targetsSelfHostedFleet }, now);
		if (why) {
			leaves(name, why);
			continue;
		}

		desired.set(name, { claws: placementFor(name, manifest), reason: 'autoInclude' });
	}

	// A manifest entry naming a repo that no longer exists is a typo or a
	// deletion; either way say so rather than silently dropping it.
	for (const [name] of explicit) {
		if (!byName.has(name)) {
			retired.push({ repo: name, why: 'named in the manifest but not found under the owner' });
		}
	}

	// A covered repo the loop above never visited, because it is no longer in the
	// list at all. See `vanishedFromUniverse` (#135).
	departed.push(
		...vanishedFromUniverse(committedRoster, byName, lookupRepo, new Set(explicit.map(([n]) => n)))
	);

	return { desired, retired, ignored, departed, allRepos: byName };
}
