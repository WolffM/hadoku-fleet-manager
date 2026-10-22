/**
 * THE TEST SUITE MUST BE SAFE TO RUN FROM INSIDE A GIT HOOK.
 *
 * On 2026-09-08 it was not, and running it rewrote the repository it was run
 * from. The mechanism is small and completely invisible from a normal shell:
 *
 *   1. `git` reads `GIT_DIR` and `GIT_INDEX_FILE` from the ENVIRONMENT, and
 *      those OVERRIDE the process working directory. `cwd` does not win.
 *   2. A hook's children inherit them — that is how a hook finds the repo it
 *      was invoked for.
 *   3. `.husky/pre-push` (added in d7e15a1) runs the full `pnpm run check`.
 *   4. `scripts/version-bump.test.mjs` built its fixture with
 *      `execFileSync('git', ['init'], { cwd: tmpdir })` and no `env`.
 *
 * So `git init` reinitialised the REAL repo, `git add -A` staged the fixture's
 * two files against the REAL index, and `git commit` landed a commit authored
 * `t <t@t>` subject `init` on whatever branch the pusher was standing on. The
 * observed damage on branch ws-n was two such commits (one per fakeRepo call),
 * a HEAD tree reduced to two files, and `core.bare = true` written into the
 * shared config — which made every OTHER worktree report the primary checkout
 * as bare. The temp directory never even received a `.git`.
 *
 * It was green for as long as nobody ran it from a hook, which is exactly when
 * it does damage. A plain `pnpm run check` at a terminal exports no GIT_*, so
 * `cwd` decides and everything passes.
 *
 * This guard is BEHAVIOURAL rather than a grep, because the property is "does
 * it write to the ambient repo", not "does the source mention env". It poisons
 * GIT_DIR at a throwaway repo — precisely what a hook does — runs the suspect
 * suite, and asserts the throwaway is untouched. It has been checked against
 * the pre-fix file and it does fail on it.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';
import { fixtureIdentityEnv } from './test-git-identity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The ambient environment with every GIT_* variable removed. */
const NO_GIT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

/** Every test source in the tree, walked from disk so a NEW file is covered. */
function testSources(root = ROOT) {
	const out = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // a tree that is not there is not a silent pass — see the
			// vacuity assertions, which fail if a walk finds nothing.
		}
		for (const e of entries) {
			if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
			const abs = join(dir, e.name);
			if (e.isDirectory()) walk(abs);
			else if (e.name.endsWith('.test.mjs') || e.name.endsWith('.test.ts')) out.push(abs);
		}
	};
	walk(join(root, 'scripts'));
	walk(join(root, 'src'));
	return out;
}

/**
 * Every test source that spawns git, EXCEPT this file.
 *
 * Discovered rather than listed: a hand-kept list is one more copy to forget,
 * and the whole failure above is a thing nobody thought to keep in sync.
 *
 * IT SCANS THE WHOLE TREE, AND UNTIL 2026-09-24 IT DID NOT. It read
 * `scripts/` and `scripts/lib/` with two non-recursive `readdirSync` calls,
 * which left out `scripts/fixes/` (three suites) and ALL of `src/tests/`
 * (40 suites) — and `src/tests` runs in the same `pnpm run check`, under the
 * same `.husky/pre-push`, in the same GIT_DIR-poisoned environment this whole
 * file is about. No src suite spawns git today, so the hole cost nothing and
 * showed nothing: the guard was green over half the suite and silent about
 * the other half. A guard whose blind spot is invisible is one nobody will
 * ever be told to widen, so it is walked from disk like the identity rule
 * below, and the fixture-tree test proves the walk reaches every location.
 */
function gitSpawningTests(root = ROOT) {
	const here = fileURLToPath(import.meta.url);
	return testSources(root).filter(
		(abs) => abs !== here && /['"]git['"]\s*,/.test(readFileSync(abs, 'utf8'))
	);
}

/**
 * WHICH FORM OF A FILE THE GUARD ACTUALLY RUNS.
 *
 * Discovery reads SOURCE and execution runs the ARTIFACT, and they differ for
 * the src half. `pnpm test` runs those suites as compiled
 * `dist/tests/**\/*.test.js` (`rm -rf dist/tests && tsc && node --test
 * 'dist/tests/**\/*.test.js'`), so the compiled file is what a hook actually
 * executes and therefore what has to be proven hook-safe — asserting about the
 * `.ts` would be asserting about something no hook runs. Discovery cannot use
 * the same form: `dist/` is a build output that may be stale or absent, and a
 * git spawn added to a `.ts` would then be invisible to this guard until
 * someone happened to rebuild. Source decides WHO is in scope; the artifact is
 * WHAT gets run.
 *
 * `pnpm run build` does NOT emit these — `tsconfig.build.json` excludes
 * `src/tests/**`, and only the full `tsc` in `pnpm test` writes them, which it
 * does immediately before the scripts suites run. So inside `pnpm run check`,
 * the context that matters, the artifact is always present and always freshly
 * compiled from the source just scanned. Outside it, a missing artifact is
 * reported as a suite that never ran, never as a pass.
 */
function runnableForm(abs) {
	if (!abs.endsWith('.test.ts')) return { run: abs, source: abs, compiled: false };
	const rel = relative(join(ROOT, 'src'), abs);
	return {
		run: join(ROOT, 'dist', rel.replace(/\.ts$/, '.js')),
		source: abs,
		compiled: true,
	};
}

test('the suite finds test files that spawn git — otherwise this guard is vacuous', () => {
	const files = gitSpawningTests();
	assert.ok(
		files.length > 0,
		'no test file appears to spawn git; either the discovery broke or the guard is pointless'
	);
});

/**
 * The mapping is asserted on its own because the path that uses it is
 * unreachable while no src suite spawns git — and an unreachable branch that
 * has never been executed is not a working one. `dist/tests/` is absent
 * outside `pnpm test`, so this is checked as a mapping, not by building.
 */
test('a src test is run as the compiled artifact a hook would execute', () => {
	const ts = runnableForm(join(ROOT, 'src', 'tests', 'drain.test.ts'));
	assert.equal(ts.run, join(ROOT, 'dist', 'tests', 'drain.test.js'));
	assert.equal(ts.compiled, true);

	const mjs = runnableForm(join(ROOT, 'scripts', 'lib', 'doctor.test.mjs'));
	assert.equal(mjs.run, join(ROOT, 'scripts', 'lib', 'doctor.test.mjs'));
	assert.equal(mjs.compiled, false, 'a .mjs script test has no build step and runs from source');
});

/**
 * THE VACUITY CHECK FOR THE WIDENED HALF.
 *
 * The assertion above is satisfied by the `scripts/` suites alone, so it stays
 * green whatever `src/tests/` does — which is exactly how the old two-directory
 * scan went unnoticed. This one puts the ONLY git spawn in the tree in
 * `src/tests/`, plus one in a nested `scripts/` subdirectory the old scan also
 * missed, and requires discovery to come back with all of them.
 *
 * The fixture is a TREE OF ITS OWN in a temp directory, mimicking the layout,
 * and never a file dropped into the real `src/tests/`. A stray `.test.ts` there
 * would be compiled by `tsc` and run by the suite, and a failed or interrupted
 * run is precisely when the cleanup would not happen — so the debris would
 * arrive attached to a red build. Nothing here can outlive the `finally`.
 */
test('discovery reaches src/tests and nested script directories, not just scripts/', () => {
	const root = mkdtempSync(join(tmpdir(), 'fleet-discovery-fixture-'));
	try {
		const spawner =
			"import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['init']);\n";
		const innocent = 'export const noop = 1;\n';
		const put = (rel, body) => {
			const abs = join(root, rel);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, body);
			return rel;
		};
		// The widened locations, each holding a git spawn...
		const expected = [
			put('src/tests/synthetic-git-spawner.test.ts', spawner),
			put('scripts/fixes/nested-git-spawner.test.mjs', spawner),
			put('scripts/lib/old-location.test.mjs', spawner),
		].sort();
		// ...and files that must NOT be picked up.
		put('scripts/quiet.test.mjs', innocent);
		put('src/tests/quiet.test.ts', innocent);
		put('src/not-a-test.ts', spawner);
		put('dist/tests/synthetic-git-spawner.test.js', spawner);
		put('node_modules/pkg/vendored.test.mjs', spawner);

		const found = gitSpawningTests(root)
			.map((f) => relative(root, f).split('\\').join('/'))
			.sort();
		assert.deepEqual(
			found,
			expected,
			'discovery does not see every place a hook-run test can live. A git spawn added to ' +
				'src/tests/ runs under .husky/pre-push exactly like a scripts/ one does, and a ' +
				'guard that cannot see it reports green over the half where nothing can trip it.'
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a test suite run with GIT_DIR poisoned does not write to that repo', () => {
	const files = gitSpawningTests();
	const canary = mkdtempSync(join(tmpdir(), 'fleet-hook-canary-'));
	try {
		// The canary's identity rides in the ENVIRONMENT, not in its config — see
		// the rule two tests below, and `lib/test-git-identity.mjs` for the eleven
		// days of main that a `git config user.email` in a fixture cost.
		const CANARY_ENV = { ...NO_GIT_ENV, ...fixtureIdentityEnv() };
		const g = (...a) => execFileSync('git', a, { cwd: canary, env: CANARY_ENV, stdio: 'ignore' });
		g('init', '-q');
		g('commit', '-q', '--allow-empty', '-m', 'base');

		const count = () =>
			execFileSync('git', ['rev-list', '--count', 'HEAD'], {
				cwd: canary,
				env: CANARY_ENV,
				encoding: 'utf8',
			}).trim();
		const before = count();

		// EXACTLY what a hook hands its children. If any spawned git honours this
		// instead of its own cwd, the canary grows a commit and this fails.
		// `NODE_TEST_*` MUST BE STRIPPED, or the spawned suites never run.
		//
		// `node --test` marks its children with NODE_TEST_CONTEXT=child-v8 (and
		// NODE_TEST_WORKER_ID). A grandchild that inherits them believes it is a
		// reporter child of the outer runner and exits immediately instead of
		// executing the file. That is what made the first version of this guard
		// report PASS in 130ms with a known-corrupting file in its list: four node
		// processes, none of which ran anything, and a canary that was untouched
		// because nothing had touched it.
		//
		// The lesson is the same one this whole file is about — an inherited
		// environment variable silently overriding what the caller asked for.
		const poisoned = Object.fromEntries(
			Object.entries(NO_GIT_ENV).filter(([k]) => !k.startsWith('NODE_TEST_'))
		);
		poisoned.GIT_DIR = join(canary, '.git');
		poisoned.GIT_INDEX_FILE = join(canary, '.git', 'index');

		// EVERY SPAWN'S OUTCOME IS RECORDED, and the first version of this loop
		// swallowed them with a bare `catch {}`. That made the guard VACUOUS in the
		// most embarrassing possible way: the child processes were failing to start,
		// all four "ran" in 130ms total — less than node's own boot time — and the
		// canary was untouched because nothing had ever executed. It reported PASS
		// with a known-corrupting file sitting right there in the list.
		//
		// "I could not look" must never render as "nothing is wrong", and a
		// `catch {}` that discards the reason is precisely how that happens.
		const outcomes = [];
		for (const f of files) {
			const { run, compiled } = runnableForm(f);
			const name = f.slice(ROOT.length + 1);
			// A SUITE THAT IS NOT BUILT IS ONE THIS GUARD COULD NOT LOOK AT, and
			// "could not look" is not "nothing is wrong". It is recorded as a suite
			// that never ran, which fails below with the command that fixes it.
			if (compiled && !existsSync(run)) {
				outcomes.push({
					name,
					ran: false,
					how:
						`not compiled — ${run.slice(ROOT.length + 1)} is missing; run \`pnpm test\` ` +
						'(or `tsc`), which is what builds the src suites this guard has to execute',
				});
				continue;
			}
			try {
				execFileSync(process.execPath, ['--test', run], {
					cwd: ROOT,
					env: poisoned,
					stdio: 'ignore',
					timeout: 120000,
				});
				outcomes.push({ name, ran: true, how: 'exit 0' });
			} catch (e) {
				// A FAILING test is not this guard's business — a suite may legitimately
				// go red under a poisoned environment, and several do. But a child that
				// never STARTED proves nothing, so the two are told apart: a numeric
				// exit status means node ran the file, anything else means it did not.
				outcomes.push({
					name,
					ran: typeof e.status === 'number',
					how: typeof e.status === 'number' ? `exit ${e.status}` : `${e.code ?? e.message}`,
				});
			}
		}

		const neverRan = outcomes.filter((o) => !o.ran);
		assert.deepEqual(
			neverRan,
			[],
			'these suites never executed, so this guard proved nothing about them: ' +
				neverRan.map((o) => `${o.name} (${o.how})`).join(', ')
		);

		assert.equal(
			count(),
			before,
			'a test suite run under a hook-like GIT_DIR committed to that repository. ' +
				'Pass `env` (with every GIT_* stripped) to every child process that runs git — ' +
				'`cwd` alone does NOT win against GIT_DIR.'
		);
		assert.equal(
			execFileSync('git', ['config', '--get', 'core.bare'], {
				cwd: canary,
				env: NO_GIT_ENV,
				encoding: 'utf8',
			}).trim(),
			'false',
			'a stray `git init` rewrote the canary config — this is what set core.bare on the ' +
				'shared repo and made every worktree report the primary checkout as bare'
		);
	} finally {
		rmSync(canary, { recursive: true, force: true });
	}
});

/**
 * ── AND A TEST MUST NOT WRITE AN IDENTITY INTO A CONFIG FILE ────────────────
 *
 * Same family as everything above, one step further along. `git config
 * user.email` is a WRITE, and `cwd` is not what decides which file receives it:
 * `GIT_DIR`, `GIT_CONFIG*` and a worktree's shared common dir all redirect it,
 * and the file a worktree writes with `--local` is the one EVERY worktree of
 * that checkout reads.
 *
 * It is not hypothetical here. 59 of the 60 commits on `origin/main` before
 * 2026-09-19 are authored AND committed as `fleet test <fleet-test@invalid>`
 * (38, from 0d1e8c5 on 09-15) or `t <t@t>` (21, from 8e932e7 on 09-07) — both
 * strings lifted verbatim out of this repo's own fixtures. Two CONTINUOUS
 * windows, each opening the day the test that uses that identity first ran on
 * this box: the repo-local config held a fixture identity for eleven days.
 *
 * THE MECHANISM WAS NEVER REPRODUCED, and this rule is deliberately not built
 * on one. It is a SOURCE rule, not a behavioural one, because the behavioural
 * version is exactly what four attempts failed to trigger — running each file
 * alone, the whole suite in a scratch worktree with the config polled every
 * 500 ms, the suite with `GIT_DIR` exported the way a hook does, and the suite
 * under a live `.husky/pre-push`. A guard that only fires on a reproduction
 * nobody has is a guard that reports green. So the rule bans the CAPABILITY:
 * a fixture states its identity in `GIT_AUTHOR_*` / `GIT_COMMITTER_*` (see
 * `lib/test-git-identity.mjs`), which is per-process and cannot outlive the
 * child that got it.
 *
 * WHAT IS STILL ALLOWED, and why:
 *   - `git config --file <path> user.email …` — the target is named in the
 *     command, so no environment variable can move it;
 *   - `git -c user.email=… <cmd>` — one process, no file at all.
 * Both appear in `scripts/check-commit-identity.test.mjs`, which has to build
 * config files to test the gate that reads them.
 */

/**
 * The offending `git config … user.name|user.email` calls in one source.
 *
 * Comments are blanked FIRST. Half the files here explain in prose the very
 * line they removed, and a guard that reports its own documentation is a guard
 * people turn off.
 *
 * Matching is done over a WINDOW after each `'config'` token rather than with
 * one regex, so `'config', '--local', 'user.email'` is caught too — `--local`
 * is not an exemption, it is the most dangerous form of all.
 */
const ALLOWED_TARGETING = /--file|--blob|-f\b/;
function identityWrites(src) {
	const clean = blankComments(src);
	const found = [];
	for (const m of clean.matchAll(/['"`]config['"`]/g)) {
		const window = clean.slice(m.index, m.index + 160);
		const hit = /['"`]user\.(name|email)['"`]/.exec(window);
		if (!hit) continue;
		if (ALLOWED_TARGETING.test(window.slice(0, hit.index))) continue;
		found.push(window.slice(0, hit.index + hit[0].length).replace(/\s+/g, ' '));
	}
	// The shell-string form, e.g. execSync(`git config user.email x`).
	for (const m of clean.matchAll(/git\s+(?:-C\s+\S+\s+)?config\s+([^\n'"`]*)/g)) {
		const rest = m[1];
		if (!/\buser\.(name|email)\b/.test(rest)) continue;
		if (ALLOWED_TARGETING.test(rest)) continue;
		found.push(`git config ${rest.trim()}`);
	}
	return found;
}

test('the identity detector fires on the banned form and not on the allowed ones', () => {
	// The positive control is BUILT rather than written out: this file is itself
	// scanned by the rule below, so a literal banned call sitting in its source
	// would make the guard report itself.
	const key = `user.${'email'}`;
	const nameKey = `user.${'name'}`;
	const banned = [
		`git(dir, ['config', '${key}', 'x@y']);`,
		`git(dir, ['config', '--local', '${key}', 'x@y']);`,
		`execSync(\`git config ${nameKey} fleet test\`);`,
	];
	for (const sample of banned) {
		assert.equal(identityWrites(sample).length, 1, `not detected: ${sample}`);
	}
	const allowed = [
		`git(dir, ['config', '--file', cfg, '${key}', 'x@y']);`,
		`git(dir, ['-c', '${key}=x@y', 'commit', '-m', 'x']);`,
		"git(dir, ['config', 'core.hooksPath', hooks]);",
		`// git(dir, ['config', '${key}', 'x@y']); — removed 2026-09-19`,
	];
	for (const sample of allowed) {
		assert.deepEqual(identityWrites(sample), [], `false positive on: ${sample}`);
	}
});

test('no test file writes a git identity into a config file', () => {
	const files = testSources();
	assert.ok(
		files.length > 10,
		`the test-source walk found ${files.length} files — the discovery broke, and a rule ` +
			'that scans nothing passes every time'
	);
	const offenders = [];
	for (const f of files) {
		for (const call of identityWrites(readFileSync(f, 'utf8'))) {
			offenders.push(`${f.slice(ROOT.length + 1)} — ${call}`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		'a test writes a git identity into a config file, which is how 59 commits on main came ' +
			'to be authored by a fixture. Use `cleanGitEnv()` from `lib/test-git-identity.mjs` ' +
			'(GIT_AUTHOR_*/GIT_COMMITTER_*), or name the target with `--file`:\n  ' +
			offenders.join('\n  ')
	);
});
