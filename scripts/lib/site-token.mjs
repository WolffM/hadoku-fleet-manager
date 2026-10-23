/**
 * Who may hold HADOKU_SITE_TOKEN, and how a repo that should not is spotted.
 *
 * Pure, so the rules can be tested without a checkout or a token — the checker
 * beside it (`scripts/check-site-token.mjs`) does the reading.
 *
 * WHY THIS EXISTS. HADOKU_SITE_TOKEN is a classic PAT with `repo` + `workflow`
 * on the whole account. On 2026-10-23, 28 repos held it, 11 of them public,
 * for two jobs: pushing their own @wolffm bump past branch protection, and
 * dispatching to hadoku_site. Both now go through mgmt-api with each repo's
 * own service key (hadoku_site `lib/repo-actions.ts`, hadoku-actions
 * `update-wolffm` and `repo-action`), so a repo outside HOLDERS has no reason
 * to have it. A copy that comes back is a leak waiting for a compromised
 * workflow, and nothing else would notice it coming back.
 *
 * A repo can hold it three ways, and each is checked:
 *   - an Actions SECRET of that name (read from the GitHub API, never from a
 *     list of where we think we put it);
 *   - a WORKFLOW that references it, comments blanked first so prose warning
 *     against it is not counted;
 *   - a `.devvault.json` that maps a local name to the vault item, which is what
 *     grants the repo's vault key read access to the PAT on the next ACL sync.
 */
import { hubRepoFull, qualifyRepo } from '../../dist/lib/fleet-config.js';
import { stripYamlComments } from './yaml-comments.mjs';

export const SITE_TOKEN = 'HADOKU_SITE_TOKEN';

/**
 * The repos that may hold it, and why. Everything else is a finding.
 *
 * The hub repo always may: it is the control plane, its deploy and update
 * chain read the raw secret so a sealed vault cannot block a deploy, and
 * auto-format pushes to its protected main. Any other holder is OPERATOR
 * CONFIG — `siteTokenHolders` in the hub's `repo-policy-manifest.json`, a map
 * of repo to reason — because adding one hands that repo's workflows a write
 * credential for every repo on the account, and that is a decision, not code.
 *
 * @param {Record<string, unknown> | undefined} declared  `siteTokenHolders`
 * @returns {Map<string, string>}
 */
export function holders(declared = {}) {
	const out = new Map([
		[
			hubRepoFull(),
			'the hub: its deploy and update chain read the raw secret so a sealed vault cannot block a deploy, and auto-format pushes to its protected main',
		],
	]);
	for (const [repo, why] of Object.entries(declared ?? {})) {
		if (repo.startsWith('$')) continue;
		if (typeof why !== 'string' || !why.trim()) {
			throw new Error(`siteTokenHolders["${repo}"] must say why it holds the token`);
		}
		out.set(qualifyRepo(repo), why);
	}
	return out;
}

const TOKEN_RE = new RegExp(`\\b${SITE_TOKEN}\\b`);

/** 1-based line numbers of a workflow that reference the token outside comments. */
export function workflowRefs(body) {
	return stripYamlComments(body)
		.split('\n')
		.flatMap((line, i) => (TOKEN_RE.test(line) ? [i + 1] : []));
}

/**
 * The local names in a `.devvault.json` that map to the token's vault item.
 * Values are vault item names; keys are the env names dev-vault exports.
 * Throws on unparseable JSON — a file we cannot read is not a clean one.
 */
export function devvaultRefs(text) {
	const doc = JSON.parse(text);
	if (!doc || typeof doc !== 'object') return [];
	return Object.entries(doc)
		.filter(([, v]) => v === SITE_TOKEN)
		.map(([k]) => k);
}

/**
 * Findings for one repo. `secret` is true/false, or a string saying why the
 * secrets list could not be read. `workflows` maps a file to its line refs;
 * `devvault` is the local names, or a string saying why the file could not be
 * read. A repo in `allowed` (see `holders`) yields nothing.
 */
export function repoFindings(repo, { secret, workflows = {}, devvault = [] }, allowed = holders()) {
	if (allowed.has(repo)) return [];
	const out = [];
	if (typeof secret === 'string') {
		out.push({ repo, kind: 'unreadable', detail: `could not list Actions secrets: ${secret}` });
	} else if (secret) {
		out.push({ repo, kind: 'secret', detail: `holds an Actions secret named ${SITE_TOKEN}` });
	}
	for (const [file, lines] of Object.entries(workflows)) {
		if (lines.length)
			out.push({
				repo,
				kind: 'workflow',
				detail: `${file} references it on line(s) ${lines.join(', ')}`,
			});
	}
	if (typeof devvault === 'string') {
		out.push({ repo, kind: 'unreadable', detail: `.devvault.json: ${devvault}` });
	} else if (devvault.length) {
		out.push({
			repo,
			kind: 'devvault',
			detail: `.devvault.json maps ${devvault.join(', ')} to it, which grants the repo's key the PAT`,
		});
	}
	return out;
}
