/**
 * ONE FIXTURE IDENTITY FOR EVERY TEST THAT COMMITS, HANDED TO GIT THROUGH THE
 * ENVIRONMENT — NEVER WRITTEN INTO A CONFIG FILE.
 *
 * WHY THIS EXISTS. 59 of the 60 commits on `origin/main` before 2026-09-19 are
 * authored AND committed as `fleet test <fleet-test@invalid>` (38, from 0d1e8c5
 * on 09-15) or `t <t@t>` (21, from 8e932e7 on 09-07) — the operator's real
 * commits, wearing a fixture's name. Those two identities are exactly the ones
 * five test files set with `git config user.name` / `git config user.email`.
 * The history shows two CONTINUOUS windows, each opening the day the test that
 * uses that identity first ran on this box and closing when the other opened,
 * so the repo-local config held a fixture identity for days at a stretch.
 *
 * THE MECHANISM WAS NOT REPRODUCED and this helper does not depend on knowing
 * it. Four attempts, all clean: each of the five run alone; the whole suite in
 * a scratch worktree with the config polled every 500 ms; the suite with
 * `GIT_DIR` exported the way a hook does; and — 2026-09-19, the last one —
 * all 1,135 `scripts/**\/*.test.mjs` run from INSIDE a real `pre-push`, fired by
 * `git push --dry-run` at a throwaway bare repo, with git's own
 * `GIT_DIR=<common>/worktrees/<name>` in the environment and the SHARED config
 * polled every 500 ms throughout. Byte-identical before and after. (The poller
 * was itself checked against a config it watched change, so its silence is an
 * observation and not a broken instrument.) What is certain is the SHAPE:
 * `git config user.email` is a WRITE to a config file, `cwd` does not decide
 * which file (`GIT_DIR`, `GIT_CONFIG*` and a worktree's shared common dir all
 * redirect it), and a repo-local write from inside a worktree lands in the
 * config every other worktree shares. There is no history rewrite — 59 public
 * commits with npm publishes keyed to their shas — so the guard IS the fix.
 *
 * SO: state the identity in the ENVIRONMENT, which is per-process and cannot
 * outlive the child that got it. `GIT_AUTHOR_*` and `GIT_COMMITTER_*` are a
 * complete ident on their own — a commit made with all four set needs no
 * `user.*` anywhere, which is also what makes a fixture safe on a claw whose
 * runner has no global identity at all.
 *
 * `scripts/lib/hook-safe-tests.test.mjs` fails the build if a test file goes
 * back to `git config user.name` / `user.email` without `--file` or `-c`, and
 * `scripts/check-commit-identity.mjs` refuses a real commit that resolves to
 * one of these fixtures.
 */
import process from 'node:process';

/**
 * The one identity every fixture commit in this repo is made under.
 *
 * `.invalid` is reserved by RFC 2606 and can never be a real mailbox, so the
 * identity is self-labelling: `check-commit-identity.mjs` refuses any commit
 * whose author email ends in `@invalid`, which turns a leak from something you
 * find in `git log` weeks later into a refusal at the moment it happens.
 */
export const FIXTURE_IDENTITY = Object.freeze({
	name: 'fleet fixture',
	email: 'fleet-fixture@invalid',
});

/**
 * The four `GIT_*_NAME`/`GIT_*_EMAIL` variables that fully determine who a
 * commit is by, with `extra` merged in last.
 *
 * Author AND committer, both: setting only the author leaves the committer to
 * be resolved from config, which is the half that was wrong on main.
 *
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function fixtureIdentityEnv(extra) {
	return {
		GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name,
		GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
		GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name,
		GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
		...extra,
	};
}

/**
 * The ambient environment with every `GIT_*` variable REMOVED and the fixture
 * identity put back — the env every `git` and every child process in a fixture
 * should get.
 *
 * WHAT THE STRIP IS FOR. A hook's `GIT_DIR`/`GIT_INDEX_FILE` OVERRIDE `cwd`
 * for every git invocation, so a fixture that inherits them points its
 * `git init` at the real repository — that happened on 2026-09-08 and put two
 * commits and `core.bare = true` onto a live branch.
 *
 * WHAT THE ORDER IS FOR, and it is a real trap: the identity travels in
 * variables that START WITH `GIT_`. The strip therefore has to be applied to
 * the AMBIENT environment and the identity added to the result. Written the
 * obvious other way — merge everything, then filter `GIT_*` out — the filter
 * eats the identity along with the hook's variables, and every fixture commit
 * falls through to whatever config git can find. That is the exact failure
 * this file exists to end, and it fails silently on any box where a global
 * identity happens to be set. Mutation-tested: 3 failing / 38 passing.
 *
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function cleanGitEnv(extra) {
	/** @type {Record<string, string>} */
	const env = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
	}
	return { ...env, ...fixtureIdentityEnv(), ...extra };
}
