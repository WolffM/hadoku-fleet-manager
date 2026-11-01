/**
 * The covered-repo roster reader — moved out of `ci-runner-fallback.ts` (wave
 * clean-1 lane C, cut (iii)). It is a declarative-input read (manifest §3.2
 * rule 1: `fleet-runner-coverage.json`), built entirely from config
 * (`host.ts`'s `manifestDir`/`logger`, `fleet-config.ts`'s `hubRepoFull`),
 * with no ci-scheduling decision in it. `runner-health.ts` (observation)
 * needs the same roster `ci-runner-fallback.ts` (ci-scheduling) steers, and
 * config is the one layer both can legally reach. `ci-runner-fallback.ts`
 * re-exports it under its original path.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger, manifestDir } from '../host.js';
import { hubRepoFull } from './fleet-config.js';

/** Injected — see host.ts. coveredRepos() falls back to the HUB REPO on a read
 *  failure, so a wrong path here silently shrinks the fleet to one repo. */
const COVERAGE_PATH = () => resolve(manifestDir(), 'fleet-runner-coverage.json');

/**
 * Repos to steer. Read fresh each call so a reconcile that adds a repo takes
 * effect without an mgmt-api restart.
 *
 * A missing or unparseable file yields the HUB REPO only, never an empty list
 * and never a throw: degrading to "steer the one repo we are certain about"
 * keeps a packaging mistake from silently turning the whole feature off, which
 * is the failure mode that would be invisible until the next outage.
 *
 * Which repo that is comes from `fleet-config`, not from here. The one repo this
 * degrades to is a fact about the ECOSYSTEM, and spelling it inline made the
 * degraded path steer a second operator's fleet at this operator's repo.
 */
export function coveredRepos(): string[] {
	try {
		const parsed = JSON.parse(readFileSync(COVERAGE_PATH(), 'utf8')) as { repos?: unknown };
		const repos = Array.isArray(parsed.repos)
			? parsed.repos.filter((r): r is string => typeof r === 'string' && r.includes('/'))
			: [];
		if (repos.length) return repos;
		logger.warn(
			`[ci-runner-fallback] ${COVERAGE_PATH()} has no repos — falling back to ${hubRepoFull()}`
		);
	} catch (err) {
		logger.warn(
			`[ci-runner-fallback] cannot read ${COVERAGE_PATH()} ` +
				`(${err instanceof Error ? err.message : String(err)}) — falling back to ${hubRepoFull()}`
		);
	}
	return [hubRepoFull()];
}
