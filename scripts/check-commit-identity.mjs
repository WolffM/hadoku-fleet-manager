#!/usr/bin/env node
/**
 * REFUSE A COMMIT THAT WOULD BE AUTHORED BY A TEST FIXTURE.
 *
 * WHY. 59 of the 60 commits on `origin/main` before 2026-09-19 are authored AND
 * committed as `fleet test <fleet-test@invalid>` (38, from 0d1e8c5 on 09-15) or
 * `t <t@t>` (21, from 8e932e7 on 09-07). Both strings came from this repo's own
 * test fixtures, which set them with `git config user.email` — a WRITE to a
 * config file, and `cwd` is not what decides which file receives it. The two
 * windows are CONTINUOUS: `t@t` from 09-07 21:29 to 09-15 15:18 -0700, then
 * `fleet-test@invalid` from 15:19 to 09-18 22:34. So the repo-local config held
 * a fixture identity for eleven days, and nothing said a word.
 *
 * The mechanism has NOT been reproduced — see the docblock in
 * `scripts/lib/test-git-identity.mjs` for the four attempts. This gate does not
 * need it. It does not ask how an identity got into a config file; it asks the
 * only question that matters at the only moment it can still be answered
 * cheaply: WHO IS THIS COMMIT ABOUT TO BE BY? There is no history rewrite —
 * those 59 commits are public and npm publishes are keyed to their shas — so
 * catching the 60th is the entire remedy.
 *
 * WHAT IT REFUSES
 *   1. an author or committer email that IS a fixture: `…@invalid` (RFC 2606
 *      reserved, never a real mailbox) or exactly `t@t`;
 *   2. an author email that DIFFERS from the global one — which is what a
 *      repo-local `user.email` looks like from here, fixture or not;
 *   3. no global identity at all. "I could not look" is not "nothing is
 *      wrong": with no global to compare against, rule 2 would silently stop
 *      being a rule.
 *
 * The committer is checked for (1) only. A deliberate `git commit --author=…`
 * is a real thing and rule 2 would break it; a fixture NAME never is.
 *
 * WHAT IT PRINTS. The resolved ident and WHERE it came from, via
 * `git config --show-origin`, because "your identity is wrong" with no file
 * path leaves an operator guessing between three config files and an
 * environment variable.
 *
 * ESCAPE HATCH: `git commit --no-verify`, or `HUSKY=0 git commit`.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

/** An email that can only have come from a test fixture. */
const FIXTURE_EMAIL = [
	[/@invalid$/, '`.invalid` is RFC 2606 reserved — only a test fixture uses it'],
	[/^t@t$/, 'the literal fixture identity that authored 21 commits on main'],
];

/**
 * `git <args>`, as { status, stdout, stderr }.
 *
 * No `env` scrubbing here, deliberately, and it is the opposite of what the
 * fixtures do: this runs INSIDE a hook and must see exactly what the commit
 * will see — including `GIT_AUTHOR_EMAIL` and the `GIT_CONFIG_PARAMETERS` that
 * `git -c user.email=… commit` exports to its children. Stripping `GIT_*` here
 * would make the gate answer about a different commit than the one being made.
 */
function git(...args) {
	const r = spawnSync('git', args, { encoding: 'utf8' });
	return {
		status: r.status,
		stdout: (r.stdout ?? '').trim(),
		stderr: (r.stderr ?? '').trim(),
		failed: r.error != null || r.status !== 0,
	};
}

/** The email out of a `Name <email> 1234567890 +0000` ident, or null. */
function emailOf(ident) {
	const m = /<([^>]*)>/.exec(ident);
	return m ? m[1] : null;
}

/** Where `user.email` is coming from, as git itself reports it. */
function origin() {
	if (process.env.GIT_AUTHOR_EMAIL) {
		return `the GIT_AUTHOR_EMAIL environment variable (${process.env.GIT_AUTHOR_EMAIL})`;
	}
	const r = git('config', '--show-origin', '--get', 'user.email');
	if (r.failed) return 'no user.email in any config file';
	// `file:/path\tvalue`
	const [where, ...rest] = r.stdout.split('\t');
	return `${where} (${rest.join('\t')})`;
}

const problems = [];

const author = git('var', 'GIT_AUTHOR_IDENT');
const committer = git('var', 'GIT_COMMITTER_IDENT');

if (author.failed || committer.failed) {
	// Not "probably fine". git itself could not decide who this commit is by,
	// which is the case rule 3 exists for, reached by a different road.
	problems.push(
		`git could not resolve an identity for this commit: ${author.stderr || committer.stderr || 'unknown error'}`
	);
}

const authorEmail = emailOf(author.stdout);
const committerEmail = emailOf(committer.stdout);

for (const [role, email] of [
	['author', authorEmail],
	['committer', committerEmail],
]) {
	if (!email) continue;
	for (const [re, why] of FIXTURE_EMAIL) {
		if (re.test(email)) problems.push(`the ${role} email <${email}> is a TEST FIXTURE — ${why}`);
	}
}

const globalEmail = git('config', '--global', '--get', 'user.email');
if (globalEmail.failed || globalEmail.stdout === '') {
	problems.push(
		'no global user.email is set, so there is nothing to check this commit against. ' +
			'Set one: git config --global user.email "you@example.com"'
	);
} else if (authorEmail && authorEmail !== globalEmail.stdout) {
	problems.push(
		`the author email <${authorEmail}> is not your global identity <${globalEmail.stdout}>. ` +
			'A repo-local user.email is exactly what put 59 fixture-authored commits on main.'
	);
}

if (problems.length === 0) process.exit(0);

console.error('❌ This commit would be made under the wrong identity.');
console.error('');
console.error(`   author:    ${author.stdout || '(unresolved)'}`);
console.error(`   committer: ${committer.stdout || '(unresolved)'}`);
console.error(`   resolved from: ${origin()}`);
console.error('');
for (const p of problems) console.error(`   • ${p}`);
console.error('');
console.error('   Every config file holding a user.email:');
const all = git('config', '--show-origin', '--get-all', 'user.email');
console.error(all.stdout ? `     ${all.stdout.split('\n').join('\n     ')}` : '     (none)');
console.error('');
console.error('   Fix the identity, or bypass deliberately with: git commit --no-verify');
process.exit(1);
