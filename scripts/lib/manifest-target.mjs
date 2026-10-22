/**
 * A FLEET WRITE IS NOT DONE UNTIL IT IS A COMMIT ON hadoku_site's `main`.
 *
 * WHAT THIS EXISTS FOR, MEASURED
 * ------------------------------
 * `fleet-runner-manifest.json` is operator config that lives in hadoku_site's
 * checkout (`src/lib/fleet-paths.ts` explains why it cannot live in this
 * package). Two commands write it — `bootcamp --write` (`$capabilities`) and
 * `enroll --write` (`$measured`) — and both resolve their target through
 * `FLEET_MANIFEST_DIR`, which in the cron and srv environment IS
 * `~/srv/hadoku_site/scripts/admin`.
 *
 * THERE WERE FOUR UNTIL WAVE 3h. `benchmark --write` and `doctor --write` now
 * record `$benchmark` / `$health` in the STATE DIR (`src/lib/measured.ts`),
 * which is not a checkout and which no publish resets — so the failure this
 * file exists for cannot happen to them, and they do not call it. The refusals
 * below still hold for the two facets that stayed, and must: those writes are
 * fleet decisions with consequences, and the commit is the review.
 * `manifest-writers.test.mjs` names the callers of {@link writeTarget} and
 * fails in both directions if that set changes.
 *
 * `~/srv/hadoku_site` is not a deploy artifact. It is a git checkout, and every
 * redeploy runs `git reset --hard origin/main` on it. Every `@wolffm/*` publish
 * lands a `chore: update packages` commit in hadoku_site, which triggers
 * `redeploy-mgmt-api.yml`, which resets that checkout. On 2026-09-14 the Wave 3b
 * manager's five landings produced FIVE resets in 36 minutes, and lane C's
 * `fleet bootcamp --write` — which had written `cargo-bevy` into
 * `$capabilities.earned`, printed `✓ wrote`, and read the file back true — was
 * gone 40 seconds later. The loss was silent in both directions: nothing told
 * the writer, and nothing told the next reader that a measurement had ever
 * existed.
 *
 * Note what the writer had already done right. It rendered through the owning
 * repo's prettier (#12), it took a `.bak`, and it PARSED THE FILE BACK. All
 * three passed. CLAUDE.md's rule is "the reader for a facet may not read what
 * the writer wrote" — a verifier that reads its own writer's artifact cannot
 * fail — and a read-back one second after the write is exactly that verifier.
 * The only observation that could have caught it is one made against the thing
 * that survives: the commit.
 *
 * THE THREE REFUSALS, AND WHY EACH IS ITS OWN REASON
 * -------------------------------------------------
 * CLAUDE.md: "a rate limit, a timeout and a deleted repo are three different
 * jobs". These three failures have three different fixes and must never
 * collapse into one "cannot write here":
 *
 *   deploy-tree     the target is under a tree a publish resets. The write
 *                   would succeed and then vanish. Fix: point the writer at a
 *                   development checkout.
 *   not-a-checkout  the target is not inside a git working tree at all, so no
 *                   commit is even possible. Fix: the operator pointed
 *                   FLEET_MANIFEST_DIR somewhere that is not the manifest's
 *                   home.
 *   dirty           the target file already carries uncommitted changes. Fix:
 *                   commit or discard them — landing on top would fold
 *                   somebody else's edit into this writer's commit, under this
 *                   writer's subject, and `check-srv-drift` would then report
 *                   it clean.
 *
 * ORDER MATTERS AND IT IS NOT THE OBVIOUS ONE. `~/srv/hadoku_site` IS a git
 * checkout and is normally CLEAN, so it passes both of the other two tests.
 * The deploy-tree question is asked first and answered from the path, because
 * there is nothing inside that repository distinguishing it from a development
 * one — being reset is a fact about what the DEPLOY does to it, not a property
 * the tree carries. That is a real limitation, so the set of deploy roots is
 * named here (and extensible through `FLEET_DEPLOY_ROOTS`) rather than guessed.
 *
 * THE PUSH IS GUARDED BY AN ANCESTOR TEST, NOT BY A BRANCH NAME. CLAUDE.md
 * requires the explicit `HEAD:main` refspec — the bare `git push origin main`
 * pushes the local `main` ref regardless of where HEAD is — but `HEAD:main`
 * from a checkout sitting on somebody else's feature branch would push that
 * whole branch onto main. So the push happens only when the fetched
 * `origin/main` is an ANCESTOR of the new commit, which is true exactly when
 * this commit is a fast-forward of what main holds and false for every
 * divergent branch, every stale checkout and every mid-air collision with
 * another writer.
 *
 * NOTHING HERE FETCHES OR PUSHES UNDER `--no-push`. That is what the writers'
 * own `--no-push` flag routes to, and it is how this file's own tests run: a
 * test of a writer that pushes is a test that mutates a real repository.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

// THE HUB REPO'S NAME IS CONFIG, NOT A LITERAL. `hubRepo()` is the one
// resolver (`src/lib/fleet-config.ts`); the BUILT copy is imported for the
// reason `lib/paths.mjs` gives — one implementation for both halves, so the
// library and the scripts cannot drift apart. It reads `process.env` on every
// call and caches nothing, which is why the deploy root below is a function.
import { hubRepo } from '../../dist/lib/fleet-config.js';

/**
 * The ambient environment with every `GIT_*` variable REMOVED.
 *
 * Verbatim the reasoning in `src/lib/fleet-paths.ts`: `git` reads `GIT_DIR` and
 * `GIT_INDEX_FILE` from the environment and they OVERRIDE `cwd`, so
 * `rev-parse --show-toplevel` run with `cwd: /tmp/whatever` reports the repo
 * named by `GIT_DIR`. A git hook exports exactly those to its children and
 * `.husky/pre-push` runs the whole check — so without this, a writer invoked
 * from a hook resolves its target against the HOOK's repository and this file's
 * every answer is about the wrong tree. That is not a failed read; it is a
 * confident wrong one, which is worse.
 */
function noGitEnv(env) {
	return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('GIT_')));
}

/**
 * Run git in `cwd`. Never throws — the exit code and stderr are the answer.
 *
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function runGit(args, cwd, env = process.env) {
	try {
		const stdout = execFileSync('git', args, {
			cwd,
			env: noGitEnv(env),
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { status: 0, stdout: stdout ?? '', stderr: '' };
	} catch (err) {
		return {
			status: typeof err.status === 'number' ? err.status : 1,
			stdout: String(err.stdout ?? ''),
			stderr: String(err.stderr ?? err.message ?? ''),
		};
	}
}

/**
 * The DEPLOYED hadoku_site checkout — the one mgmt-api serves from and the one
 * every redeploy resets.
 *
 * One answer to "where is the deploy tree", for the reason CLAUDE.md gives
 * about `isLocalNode()`: `check-srv-drift` reads this tree and the manifest writers
 * refuse it, and two implementations of that question would disagree the first
 * time the path moved. `FLEET_DEPLOY_SITE_ROOT` overrides it — the fixture
 * tests need a tree they may safely mutate, and an operator whose deploy lives
 * elsewhere needs the same door.
 */
export function deploySiteRoot(env = process.env) {
	const fromEnv = env.FLEET_DEPLOY_SITE_ROOT?.trim();
	return fromEnv ? resolve(fromEnv) : join(homedir(), 'srv', hubRepo());
}

/**
 * Every tree a publish resets. A write landing under one of these is lost.
 *
 * `FLEET_DEPLOY_ROOTS` (colon-separated) ADDS to the list and cannot replace
 * it. A variable that could empty the set would be a way to turn this guard off
 * from the environment, and the environment is exactly where the mistake this
 * file exists for comes from — the cron's own `FLEET_MANIFEST_DIR`.
 */
export function deployRoots(env = process.env) {
	const roots = [join(homedir(), 'srv'), deploySiteRoot(env)];
	for (const extra of (env.FLEET_DEPLOY_ROOTS ?? '').split(':')) {
		if (extra.trim()) roots.push(resolve(extra.trim()));
	}
	return [...new Set(roots)];
}

/** Path containment on a SEPARATOR boundary — `~/srvo` is not under `~/srv`. */
function under(path, root) {
	return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function refuse(reason, why) {
	return { ok: false, reason, why };
}

/**
 * Can these files be written AND landed? Ask BEFORE writing.
 *
 * @param {string|string[]} files one or more paths that one commit will carry
 * @returns {{ ok: true, repo: string, paths: string[] }
 *           | { ok: false, reason: 'deploy-tree'|'not-a-checkout'|'dirty'|'split-repo', why: string }}
 */
export function writeTarget(files, { env = process.env, git = runGit } = {}) {
	const abs = (Array.isArray(files) ? files : [files]).map((f) => resolve(f));
	if (!abs.length) return refuse('not-a-checkout', 'no target file was named');

	// 1. THE DEPLOY TREE, FIRST. It is a git checkout and it is normally clean,
	//    so both tests below pass on it and the write is lost anyway.
	for (const root of deployRoots(env)) {
		const hit = abs.find((f) => under(f, root));
		if (hit) {
			return refuse(
				'deploy-tree',
				`${hit} is inside the deploy tree ${root}. Every @wolffm publish lands a ` +
					`\`chore: update packages\` commit in ${hubRepo()}, which redeploys mgmt-api, which ` +
					'runs `git reset --hard origin/main` on this checkout — so this write would ' +
					'succeed, read back true, and be gone at the next publish anywhere in the ' +
					'ecosystem, with nothing said. Point FLEET_MANIFEST_DIR at a DEVELOPMENT ' +
					`checkout (${join(homedir(), 'repos', hubRepo(), 'scripts', 'admin')}) and ` +
					're-run; the writer commits and pushes from there.'
			);
		}
	}

	// 2. A GIT WORKING TREE, or no commit is possible at all.
	const top = git(['rev-parse', '--show-toplevel'], dirname(abs[0]), env);
	if (top.status !== 0 || !top.stdout.trim()) {
		return refuse(
			'not-a-checkout',
			`${dirname(abs[0])} is not inside a git working tree, so this write can never become ` +
				'a commit — nothing could review it, revert it, or deploy it, and the next reader ' +
				'would have no way to tell a measurement from a file somebody edited by hand. ' +
				`git said: ${top.stderr.trim() || 'no toplevel'}`
		);
	}
	const repo = resolve(top.stdout.trim());

	const outside = abs.filter((f) => !under(f, repo));
	if (outside.length) {
		return refuse(
			'split-repo',
			`one commit cannot carry ${outside.join(', ')} — they are outside ${repo}, which is ` +
				'the working tree holding the first target. All of a writer’s files land together ' +
				'or the record is half-written.'
		);
	}

	// 3. NOT ALREADY DIRTY ON THESE PATHS. Landing on top of somebody else's
	//    uncommitted edit files it under this writer's subject and makes
	//    `check-srv-drift` report the result clean.
	const st = git(['status', '--porcelain', '--', ...abs], repo, env);
	if (st.status !== 0) {
		return refuse(
			'not-a-checkout',
			`git could not read the status of ${repo}: ${st.stderr.trim() || 'unknown error'}`
		);
	}
	if (st.stdout.trim()) {
		return refuse(
			'dirty',
			`${abs.map((f) => relative(repo, f)).join(', ')} already carries uncommitted changes in ` +
				`${repo}:\n    ${st.stdout.trim().split('\n').join('\n    ')}\n  Writing now would fold ` +
				'that edit into this writer’s commit, under this writer’s subject, and the drift ' +
				'gate would then read the result as landed. Commit or discard it first: ' +
				`\`git -C ${repo} diff -- ${abs.map((f) => relative(repo, f)).join(' ')}\``
		);
	}

	return { ok: true, repo, paths: abs.map((f) => relative(repo, f)) };
}

/**
 * Commit what was just written, and push it to `main`.
 *
 * @param {string|string[]} files the same targets {@link writeTarget} approved
 * @param {{ writer: string, summary: string, push?: boolean,
 *           env?: NodeJS.ProcessEnv, git?: typeof runGit }} opts
 * @returns {{ ok: boolean, committed: boolean, sha: string|null, pushed: boolean,
 *             repo: string|null, reason: string|null, why: string|null }}
 */
export function landWrite(
	files,
	{ writer, summary, push = true, env = process.env, git = runGit }
) {
	const abs = (Array.isArray(files) ? files : [files]).map((f) => resolve(f));
	const base = {
		ok: false,
		committed: false,
		sha: null,
		pushed: false,
		repo: null,
		reason: null,
		why: null,
	};

	const top = git(['rev-parse', '--show-toplevel'], dirname(abs[0]), env);
	if (top.status !== 0 || !top.stdout.trim()) {
		return {
			...base,
			reason: 'not-a-checkout',
			why: `${dirname(abs[0])} is not inside a git working tree: ${top.stderr.trim()}`,
		};
	}
	const repo = resolve(top.stdout.trim());
	const rel = abs.map((f) => relative(repo, f));

	// NOTHING TO COMMIT IS NOT A FAILURE. A writer that re-measured and found
	// the same numbers wrote byte-identical bytes; there is no commit to make
	// and the record already on main is the record it wanted.
	const st = git(['status', '--porcelain', '--', ...abs], repo, env);
	if (st.status !== 0) {
		return { ...base, repo, reason: 'status-failed', why: st.stderr.trim() };
	}
	if (!st.stdout.trim()) {
		return { ...base, ok: true, repo, reason: 'unchanged', why: 'the write changed no bytes' };
	}

	// `--no-verify`: the manifest is ALREADY rendered by the owning repo's own
	// prettier on the way in (`renderJson`, #12), so the hook has nothing left
	// to fix — and a fleet writer running inside a cron must not be blocked by
	// another repository's whole pre-commit suite. Losing a thermal reading that
	// cost a loaded box a minute to a hook timeout is the wrong trade.
	const msg = `fleet(${writer}): ${summary}`;
	const commit = git(['commit', '--no-verify', '--only', '-m', msg, '--', ...rel], repo, env);
	if (commit.status !== 0) {
		return {
			...base,
			repo,
			reason: 'commit-failed',
			why: `${commit.stderr.trim() || commit.stdout.trim() || 'git commit failed'}`,
		};
	}
	const sha = git(['rev-parse', 'HEAD'], repo, env).stdout.trim() || null;
	const committed = { ...base, committed: true, sha, repo };

	if (!push) {
		return {
			...committed,
			ok: true,
			reason: 'no-push',
			why:
				`committed ${sha?.slice(0, 8)} to ${repo} and STOPPED — --no-push was given, so this ` +
				'record is not on main yet and no deployed reader can see it. Push it with ' +
				`\`git -C ${repo} push origin HEAD:main\`.`,
		};
	}

	if (git(['remote', 'get-url', 'origin'], repo, env).status !== 0) {
		return {
			...committed,
			reason: 'no-remote',
			why: `${repo} has no \`origin\` remote, so the commit cannot reach main from here.`,
		};
	}
	const fetch = git(['fetch', 'origin', 'main'], repo, env);
	if (fetch.status !== 0) {
		return {
			...committed,
			reason: 'fetch-failed',
			why:
				`could not fetch origin/main in ${repo}, so whether this commit fast-forwards main ` +
				`is UNKNOWN and pushing blind could clobber it: ${fetch.stderr.trim()}`,
		};
	}
	// THE ANCESTOR TEST IS THE GUARD, not the branch name — see the header.
	if (git(['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'], repo, env).status !== 0) {
		return {
			...committed,
			reason: 'not-fast-forward',
			why:
				`${repo} HEAD does not contain origin/main, so \`HEAD:main\` would either be ` +
				'rejected or push a divergent branch over main. Rebase this checkout onto ' +
				`origin/main and push \`git -C ${repo} push origin HEAD:main\` by hand.`,
		};
	}
	const pushed = git(['push', 'origin', 'HEAD:main'], repo, env);
	if (pushed.status !== 0) {
		return {
			...committed,
			reason: 'push-failed',
			why: `commit ${sha?.slice(0, 8)} is local only: ${pushed.stderr.trim()}`,
		};
	}
	return { ...committed, ok: true, pushed: true };
}

/**
 * The one line a writer prints about a refusal, and the one it prints about a
 * landing. Here rather than in each writer, so an operator reading a
 * bootcamp log and an enroll log sees the same sentence for the same event.
 */
export function refusalLine(target, { writer, file }) {
	return (
		`\n✗ ${writer} REFUSES to write ${file}\n` +
		`  reason: ${target.reason}\n` +
		`  ${target.why}\n` +
		'  Nothing was written. A fleet write is not done until it is a commit on ' +
		`${hubRepo()}'s main.`
	);
}

/** Same, for the result of {@link landWrite}. */
export function landingLine(landed, { writer }) {
	if (landed.reason === 'unchanged') return `  nothing to commit — ${writer} changed no bytes`;
	if (landed.pushed) return `  landed ${landed.sha?.slice(0, 8)} on ${hubRepo()} main`;
	if (landed.committed)
		return `  ! committed ${landed.sha?.slice(0, 8)}, NOT pushed: ${landed.why}`;
	return `  ! NOT COMMITTED (${landed.reason}): ${landed.why}`;
}

/** True when the deployed site checkout is actually on disk to be read. */
export function deploySiteExists(env = process.env) {
	return existsSync(deploySiteRoot(env));
}
