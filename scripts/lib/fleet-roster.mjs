/**
 * ONE roster for every fleet-wide checker.
 *
 * `check-header-fleet.mjs`, `check-tier-fleet.mjs` and `check-mf-externals.mjs`
 * each carried a hand-written `const FLEET = [...]`. They had already drifted —
 * measured 2026-08-23, before this existed:
 *
 *   coverage (derived)      24 repos
 *   check-tier-fleet        15
 *   check-header-fleet      14
 *   check-mf-externals       9
 *
 * header and tier disagreed on SEVEN repos in both directions, and nine repos
 * with live CI coverage — vibecheck, hadoku-task-mobile, hadoku-registry,
 * hadoku-privatebin, hadoku-filetransfer, brave-quartet among them — were
 * inspected by neither. `hadoku-filetransfer` is the worked example: it declares
 * `@wolffm/task-ui-components` in `packages/ui/package.json` and had simply
 * never been added to the header list, so every header rule silently skipped it.
 *
 * The lists are NOT interchangeable, which is why one flat roster would be
 * wrong: brave-quartet is a Rust/Bevy crate and auditing it for a React
 * `AppHeader` is permanent noise. So membership is per FACET — derived from
 * evidence by `reconcile-fleet-runners.mjs --write-coverage` and committed into
 * `fleet-runner-coverage.json` — and each checker filters the facet it cares
 * about. A new child app is in scope everywhere by default, and taking it OUT
 * becomes an explicit allowlist entry with a stated reason rather than an
 * absence nobody notices.
 *
 * Facets are recomputed from the repos themselves, never declared, for the same
 * reason `getCronIdentities` is derived: a list that must be edited in lockstep
 * with reality is a list that will be wrong.
 */
import { readFileSync } from 'node:fs';
import { manifest as manifestFile } from './paths.mjs';

const COVERAGE = manifestFile('fleet-runner-coverage.json');

/**
 * The repo this fleet is hosted FROM. It legitimately consumes
 * `task-ui-components` and mounts micro-frontends, so it earns the facets — but
 * the fleet checkers exist to audit CHILD repos from here, and hadoku_site is
 * already covered in-repo by `check-tier-gating.mjs`, `check:mf-externals`'s
 * import-map source and its own CI. Auditing it as a sibling would double-report
 * and, worse, look for a checkout of itself under REPOS_DIR.
 */
const HOST_REPO = 'WolffM/hadoku_site';

function load() {
	try {
		const raw = JSON.parse(readFileSync(COVERAGE, 'utf8'));
		return { repos: raw.repos ?? [], facets: raw.facets ?? {} };
	} catch (err) {
		// A missing or unparseable roster must never read as "an empty fleet" —
		// that is the `no-checkout` trap: an audit that asserts cleanliness
		// without looking is worse than no audit.
		throw new Error(
			`fleet-roster: cannot read ${COVERAGE} (${err.message}). ` +
				`Regenerate with: fleet reconcile --write-coverage`
		);
	}
}

/** Every covered repo, `owner/name`. */
export function allRepos({ includeHost = false } = {}) {
	const { repos } = load();
	return repos.filter((r) => includeHost || r !== HOST_REPO);
}

/**
 * Repos carrying `facet`. `microFrontend` yields the facet VALUE (its build
 * paths); the boolean facets yield just the name.
 */
export function reposWith(facet, { includeHost = false } = {}) {
	const { repos, facets } = load();
	const out = [];
	for (const repo of repos) {
		if (!includeHost && repo === HOST_REPO) continue;
		const v = facets[repo]?.[facet];
		if (!v) continue;
		out.push(v === true ? { repo } : { repo, ...(typeof v === 'object' ? v : { value: v }) });
	}
	return out;
}

/** Bare repo names (no owner) for a facet — the shape the checkers scan with. */
export function namesWith(facet, opts) {
	return reposWith(facet, opts).map((e) => e.repo.split('/')[1]);
}

export { HOST_REPO };
