/**
 * header-roster-completeness — is the FLEET list itself complete?
 *
 * Moved out of `check-header-fleet.mjs` (wave shrink-1 lane D), body
 * unchanged.
 *
 * Every rule in `header-fleet-audit.mjs` only inspects repos named in
 * FLEET, and FLEET is derived from the coverage manifest (`namesWith`) — so
 * a child app missing from THAT is invisible to all of them. Deriving the
 * list moved the problem; it did not remove it. That is not hypothetical:
 * conjure was absent from the fan-out list until 2026-08-04 and sat on a
 * stale task-ui-components for weeks, and pygmalion had NO update path at
 * all from creation until 2026-08-05. Both were found by hand, twice,
 * because nothing checked the list against reality. This module is that
 * check — the manifest is a claim about the world, and the world is the
 * owner's account on GitHub.
 *
 * Reality here is "consumes an @wolffm package". Any repo that does is part
 * of the ecosystem and must appear in the roster, or carry an allowlist
 * entry saying why not. (The fan-out half of that assertion was
 * `not-in-fanout`, retired 2026-08-26 — see the CLI's own header.)
 */

import { resolve } from 'node:path';
import { tryShipped } from './fleet-source.mjs';
import { fleetOwner, hubRepo, qualifyRepo } from '../../dist/lib/fleet-config.js';
import {
	report,
	reportAdvisory,
	ownerRepos,
	repoAgeHours,
	catalogueBlindFor,
} from './header-rules.mjs';
import { ROOT } from './header-source.mjs';

/**
 * `new-repo-grace` (#95) — hours a brand-new repo's `not-in-fleet` is advisory
 * rather than failing.
 *
 * hadoku_site's `reconcile-fleet-coverage.yml` is what actually admits a repo
 * into the roster (scheduled `30 12` / `0 14` UTC, observed to fire HOURS
 * late), and nothing else writes it. `ci:header-fleet` runs far more often
 * than that, so a repo created minutes before a run is reliably `not-in-fleet`
 * through no fault of its own — found 2026-10-05 when `hadoku-housemodel`,
 * created 21:04Z, paged `@here` at 06:11Z, hours before the regen could
 * possibly have run. 24h covers the observed worst-case lag with room to
 * spare; past it, an absent roster entry is a real gap again.
 */
export const NEW_REPO_GRACE_HOURS = 24;

/**
 * @param {string[]} knownConsumers every covered repo's `wolffmConsumer` facet
 * @param {{useWorktree: boolean, noFetch: boolean, ref: string}} opts
 */
export function auditRosterCompleteness(knownConsumers, { useWorktree, noFetch, ref }) {
	const universe = ownerRepos();
	if (universe.reason) {
		// A FAILED LISTING IS NOT AN EMPTY ACCOUNT. Every repo outside the roster
		// would go unexamined while the summary said the roster was complete.
		report(
			fleetOwner(),
			'unreadable',
			`could not list ${fleetOwner()}'s repos (${universe.reason}), so whether the fleet ` +
				'roster misses an @wolffm consumer was not checked'
		);
	}

	for (const repo of universe.names ?? []) {
		if (repo === hubRepo()) continue; // the parent, not a consumer
		// Shipped manifests, whatever --worktree says: whether a repo consumes
		// @wolffm is a fact about what it ships.
		const shipped = tryShipped(qualifyRepo(repo), { fetch: !noFetch });
		if ('unreadable' in shipped) {
			report(
				repo,
				'unreadable',
				`cannot read ${ref} (${shipped.unreadable}), so whether it consumes @wolffm ` +
					'packages — and so belongs in the roster — is unknown'
			);
			continue;
		}

		// Cheap check: does any tracked manifest name an @wolffm dependency?
		let consumes = false;
		try {
			const manifests = shipped
				.list()
				// EVERY manifest. A `.slice(0, 8)` here read the first eight in path
				// order and stopped, so a monorepo whose @wolffm consumer sorted ninth
				// (`packages/ui/` behind seven `packages/a…` siblings) was never
				// admitted as a consumer — and therefore never reported missing.
				.filter((f) => f.endsWith('package.json') && !f.includes('node_modules'));
			shipped.readMany(manifests); // one fetch for all of them, not one per manifest
			for (const m of manifests) {
				const raw = shipped.read(m);
				if (!raw) continue;
				// DEPENDENCY FIELDS, not the raw text. `/"@wolffm\//` also matches a
				// manifest's own `"name": "@wolffm/…"`, so a repo that PUBLISHES an
				// @wolffm package and consumes none read as a consumer — and then as
				// `not-in-fleet`, because publishing earns no roster facet.
				// hadoku-fleet-manager tripped exactly that on its first nightly.
				// A malformed manifest is skipped rather than guessed at.
				let pkg;
				try {
					pkg = JSON.parse(raw);
				} catch {
					continue;
				}
				const deps = [
					pkg?.dependencies,
					pkg?.devDependencies,
					pkg?.peerDependencies,
					pkg?.optionalDependencies,
				];
				if (deps.some((d) => d && Object.keys(d).some((k) => k.startsWith('@wolffm/')))) {
					consumes = true;
					break;
				}
			}
		} catch (err) {
			report(
				repo,
				'unreadable',
				`cannot read ${ref}'s manifests (${err.reason ?? err.message}), so whether it ` +
					'consumes @wolffm packages is unknown'
			);
			continue;
		}
		if (!consumes) continue;

		// Compared against the ROSTER's consumer facet, not against FLEET.
		// FLEET is the uiApp subset now, and a repo can legitimately consume
		// @wolffm without shipping the header — ArchiveBot and hadoku-merchant
		// take worker-utils only. Asserting FLEET membership here reported both
		// as drift the moment membership became facet-scoped. What the rule
		// actually means is "this consumer is unknown to the fleet", and the
		// roster is what knows.
		if (!knownConsumers.includes(repo)) {
			const ageHours = repoAgeHours(repo, { noFetch });
			if (ageHours !== null && ageHours < NEW_REPO_GRACE_HOURS) {
				reportAdvisory(
					repo,
					'new-repo-grace',
					`consumes @wolffm packages but is in no fleet roster yet — ${ageHours.toFixed(1)}h old, ` +
						`under the ${NEW_REPO_GRACE_HOURS}h grace. The site repo's reconcile-fleet-coverage.yml ` +
						'(scheduled 30 12 / 0 14 UTC, observed to fire hours late) has not necessarily had a ' +
						`chance to admit it yet; past ${NEW_REPO_GRACE_HOURS}h this becomes a failing ` +
						'not-in-fleet finding. Regenerate early: fleet reconcile --write-coverage',
					{ ageHours, graceHours: NEW_REPO_GRACE_HOURS }
				);
			} else {
				report(
					repo,
					'not-in-fleet',
					'consumes @wolffm packages but is in no fleet roster — every rule above skips it. ' +
						'Regenerate: fleet reconcile --write-coverage'
				);
			}
		}
	}

	// ---- the catalogue the header-name rules read -----------------------------
	// Once, during the fleet pass — see `checkHeaderName`. Only when some repo
	// actually needed it: a fleet with no app roots asked the catalogue nothing.
	if (catalogueBlindFor.length) {
		report(
			hubRepo(),
			'catalogue-unreadable',
			`spec/categories.json / scripts/child-apps.json unreadable at ${
				useWorktree ? `the working copy of ${resolve(ROOT, hubRepo())}` : `${ref} of ${hubRepo()}`
			}, so header-name-hardcoded and header-name-unverified did not run for ` +
				`${catalogueBlindFor.length} repo(s): ${catalogueBlindFor.join(', ')}`
		);
	}
}
