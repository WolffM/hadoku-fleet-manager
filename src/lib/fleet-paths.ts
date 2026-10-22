/**
 * Where this package's two halves find things that are NOT part of the package.
 *
 * Three categories, and conflating them is what broke the runtime half:
 *
 *   1. Sibling assets (`ci-throttle.sh`, `runners-slice-install.sh`, the probes)
 *      ship INSIDE the package. They stay `resolve(__dirname, …)` — see
 *      `PKG_SCRIPTS` in `scripts/lib/paths.mjs`, which is the only thing that
 *      question needs and the only thing left in that file.
 *   2. Operator config — the manifests and allowlists — lives in the hadoku_site
 *      checkout, because `reconcile-repo-policy.mjs` still reads it there and
 *      `fleet-runner-coverage.json` is a GENERATED, COMMITTED artifact. A file
 *      that must be written and committed cannot live in node_modules.
 *   3. The site checkout itself, which several auditors read directly
 *      (`src/layouts/Base.astro`, `templates/`, its git index).
 *
 * Categories 2 and 3 used to be `resolve(__dirname, '..')` arithmetic that
 * happened to be right while these scripts lived in `hadoku_site/scripts/admin`.
 * Moved, that arithmetic points into node_modules — and every consumer of it
 * degrades QUIETLY: an unreadable allowlist means "no exemptions", an
 * unreachable site root means "no templates to check". Both read as a clean
 * audit. So both resolvers THROW.
 *
 * WHY THIS IS TYPESCRIPT AND NOT `scripts/lib/paths.mjs` ANY MORE
 * ---------------------------------------------------------------
 * `src/cli.ts` has to answer "which tree answered?" for the provenance banner
 * (issue #4), and `tsconfig.json` sets no `allowJs`, so it cannot import a
 * `.mjs`. The alternative was a second implementation of `siteRoot()` inside
 * the CLI — the exact shape of the isLocalNode bug this repo has already paid
 * for once, where five answers to one question disagreed and only one survived
 * an FQDN. So the answer moved HERE, and `scripts/lib/paths.mjs` and
 * `scripts/lib/sibling-repos.mjs` re-export the built copy, the same way
 * `fleet-exec.mjs` already imports the built `isLocalNode`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

// WHICH repo is the hub is `fleet-config`'s question, not this file's — the same
// one-question-one-answer rule `node-identity.ts` enforces. The two modules
// import each other (this one for `hubRepo`, that one to RE-EXPORT `stateDir`),
// which is a cycle ESM resolves cleanly here because both bindings are hoisted
// FUNCTION declarations and neither module body calls the other at evaluation
// time. Keep it that way: turning either accessor into a module-level `const`
// would make the cycle's evaluation order start to matter.
import { hubRepo } from './fleet-config.js';

function must(label: string, path: string, hint: string): string {
	if (!path || !existsSync(path)) {
		throw new Error(
			`fleet: ${label} does not exist: ${path}\n  ${hint}\n  ` +
				'This is fatal on purpose. Every reader behind this path turns a failed ' +
				'read into an empty result, which renders as a clean audit rather than an error.'
		);
	}
	return path;
}

/**
 * The ambient environment with every `GIT_*` variable REMOVED.
 *
 * BOTH QUESTIONS BELOW ARE ABOUT `cwd`, AND `GIT_DIR` SILENTLY ANSWERS A
 * DIFFERENT ONE. `git` reads `GIT_DIR` and `GIT_INDEX_FILE` from the
 * environment and they OVERRIDE the working directory — so `git rev-parse
 * --show-toplevel` run with `cwd: /tmp/whatever` reports the repo named by
 * `GIT_DIR`, not the one containing `cwd`. The `cwd` option becomes decoration.
 *
 * A git hook exports exactly those variables to its children, which is how any
 * `fleet` command invoked from a hook — `.husky/pre-push` runs the full check —
 * gets a `reposDir()` pointing at the hook's repository instead of at the
 * directory it was actually asked about. `siteRoot()` then resolves to a real,
 * existing, WRONG hadoku_site, and every manifest read behind it succeeds
 * against the wrong tree.
 *
 * That is worse than the empty-resolution failure `must()` exists to catch. An
 * empty read renders as a clean audit of a fleet with nothing in it and at least
 * throws; a read against the wrong checkout renders as a clean audit of the
 * wrong fleet, and nothing anywhere fails.
 *
 * Caught 2026-09-08 by paths.test.mjs — "a directory that is not a site checkout
 * does not masquerade as one" stopped throwing under a pre-push hook, which is
 * precisely the masquerade its name describes, arriving through the environment
 * rather than through the path.
 */
const NO_GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

/** The MAIN checkout of this repo, even when called from inside a worktree. */
function mainCheckout(from: string): string | null {
	try {
		const common = execFileSync(
			'git',
			['rev-parse', '--path-format=absolute', '--git-common-dir'],
			{ cwd: from, env: NO_GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
		).trim();
		if (common) return dirname(common);
	} catch {
		/* not a repo, or a git too old for --path-format; fall through */
	}
	return null;
}

let cachedReposDir: string | null = null;

/**
 * The directory holding the sibling checkouts.
 *
 * WHY THIS IS NOT A ONE-LINER. Four checkers each grew their own copy and all
 * four disagreed:
 *
 *   check-tier-fleet       walk up 5 levels looking for a dir named hadoku_site
 *   check-header-fleet     cut the path at `/.claude/worktrees/`
 *   check-mf-externals     same cut, written again
 *   check-identity-model   `resolve(REPO_ROOT, '..')` — no worktree handling at all
 *
 * The last one matters. CLAUDE.md tells every agent to work from a worktree, and
 * from one, `REPO_ROOT/..` is `.claude/worktrees/`, which contains no repos. So
 * `check:identity-model --fleet` audited ONE repo instead of 26 and then declared
 * three allowlist entries stale — for repos it had never opened. Acting on that
 * advice would have deleted three live exemptions. It failed loudly about the
 * missing checkouts, which is the only reason this was recoverable.
 *
 * ASK GIT, DO NOT PATTERN-MATCH THE PATH. `--git-common-dir` resolves to the MAIN
 * checkout's .git from inside any worktree, at any depth, under any name. Every
 * heuristic above encodes a convention that a differently-named or differently-
 * nested worktree breaks silently — and silently is the whole problem: the
 * failure mode is an audit that inspects nothing and reports clean.
 *
 * `REPOS_DIR` still wins — CI and the cron set it explicitly.
 */
export function reposDir({ from = process.cwd(), refresh = false } = {}): string {
	if (!refresh && cachedReposDir) return cachedReposDir;
	if (process.env.REPOS_DIR) return (cachedReposDir = resolve(process.env.REPOS_DIR));
	const main = mainCheckout(from);
	if (main) return (cachedReposDir = dirname(main));
	// Last resort for a non-git context. Cut worktree nesting rather than walking
	// a fixed number of levels: an off-by-one points the audit at an empty
	// directory, which reads as "everything is fine".
	const marker = '/.claude/worktrees/';
	const i = from.indexOf(marker);
	return (cachedReposDir = resolve(i === -1 ? from : from.slice(0, i), '..'));
}

/** The working tree containing `cwd` — a worktree resolves to ITSELF. */
function gitToplevel(): string | null {
	try {
		// `env: NO_GIT_ENV` — see the note on that constant. Without it this asks
		// "what repo does GIT_DIR name?" while claiming to ask "what working tree
		// contains cwd?", and the two differ inside every git hook.
		const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
			cwd: process.cwd(),
			env: NO_GIT_ENV,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
		return top || null;
	} catch {
		return null; // not a git repo (a deployed clone, a bare tarball)
	}
}

/**
 * The hadoku_site checkout. `HADOKU_SITE_ROOT` wins; otherwise it is derived
 * from `reposDir()`, which asks git for the main checkout and honours
 * `REPOS_DIR` — the variable the cron jobs already set.
 */
export function siteRoot(): string {
	const fromEnv = process.env.HADOKU_SITE_ROOT?.trim();
	if (fromEnv)
		return must('HADOKU_SITE_ROOT', resolve(fromEnv), `Set it to the ${hubRepo()} checkout.`);

	// THE CHECKOUT YOU ARE STANDING IN, not the main one.
	//
	// `reposDir()` deliberately resolves the MAIN checkout even from a worktree,
	// because a worktree's parent is `.claude/worktrees/` and a sibling scan
	// rooted there finds nothing. That is right for FINDING SIBLINGS and wrong
	// for manifests: deriving the site root from it means `fleet reconcile
	// --write-coverage`, run inside a worktree, silently READS AND WRITES the
	// shared main checkout — another agent's working tree. That happened once
	// while cutting this over, and the only reason it was caught is that the
	// reconciler prints the manifest path it used.
	//
	// So: ask git for the toplevel of the CURRENT directory, and accept it only
	// if it actually looks like hadoku_site. A worktree gets its own manifests;
	// anywhere else falls back to the canonical checkout.
	const here = gitToplevel();
	if (here && existsSync(join(here, 'scripts', 'admin'))) return here;

	return must(
		`the ${hubRepo()} checkout`,
		join(reposDir(), hubRepo()),
		'Set HADOKU_SITE_ROOT, or REPOS_DIR to the directory holding the sibling checkouts.'
	);
}

/**
 * Manifests and allowlists. `FLEET_MANIFEST_DIR` wins — the same variable
 * mgmt-api passes to the runtime half, so both halves name one location.
 */
export function manifestDir(): string {
	const fromEnv = process.env.FLEET_MANIFEST_DIR?.trim();
	if (fromEnv)
		return must('FLEET_MANIFEST_DIR', resolve(fromEnv), 'It must hold the fleet manifests.');
	return must(
		'the manifest directory',
		join(siteRoot(), 'scripts', 'admin'),
		'Set FLEET_MANIFEST_DIR to the directory holding fleet-runner-manifest.json.'
	);
}

/** A named manifest or allowlist. Throws if the directory is wrong. */
export function manifest(name: string): string {
	return join(manifestDir(), name);
}

/**
 * Where mgmt-api keeps operator state — `job-history.jsonl` lives here.
 *
 * From the ENVIRONMENT, never arithmetic, like every other path in this file.
 * In-process the host injects it (`host.ts#stateDir`); a standalone script has
 * no host, so it reads the same location the host is configured with. Override
 * with HADOKU_STATE_DIR when pointing a command at another operator's state.
 */
export function stateDir(): string {
	return process.env.HADOKU_STATE_DIR || join(homedir(), '.hadoku-mgmt');
}
