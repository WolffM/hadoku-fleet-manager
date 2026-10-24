/**
 * #84 parts 1/3/4 — `fleet ci-watch --write` must never replace a GOOD output
 * file with a DEGRADED one.
 *
 * The issue's repro: a wrong `REPOS_DIR` left every roster repo's checkout
 * unreadable, `ci-watch` printed the error and still exited 1 — but only
 * AFTER it had already overwritten both `ci-watch.generated.json` copies
 * with a 0-target result (67 -> 0 in production). `ci-alerts` reads the
 * manifest copy at run time, so that window is a fleet that LOOKS watched
 * and is not.
 *
 * Two independent guards, both gating `--write` only (a plain run or
 * `--check` still reports the same problems and exit code either way):
 *
 *   1. Any roster repo with no checkout refuses the write outright. There is
 *      no override — "I could not look" is never a reason to write anyway.
 *   2. A write that would shrink the target list below 50% of the existing
 *      file refuses too, unless `--allow-shrink` — the floor for the
 *      legitimate "a repo was archived" case, independent of (1).
 *
 * Exercised as a CLI, the same way `reconcile-fleet-runners.test.mjs` does
 * it: a throwaway manifest dir, fixture REMOTES (read through fleet-source,
 * as the gate reads GitHub) and site root, the EXIT CODE and the ON-DISK FILES
 * read directly rather than grepped out of stdout. The remotes' git children
 * run with every GIT_* stripped — see lib/hook-safe-tests.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureRemotes, poisonedClone } from './lib/fleet-source-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'ci-watch.mjs');

/** The ambient environment with every GIT_* variable removed — see
 *  lib/hook-safe-tests.test.mjs. ci-watch.mjs never spawns git itself, but
 *  stripping costs nothing and keeps every fixture in this repo consistent. */
const NO_GIT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

/** A throwaway manifest dir, repos dir and site root, wired together the way
 *  `scripts/lib/paths.mjs` expects via `FLEET_MANIFEST_DIR`, `REPOS_DIR` and
 *  `HADOKU_SITE_ROOT`. */
function fixture(repos) {
	const remotes = fixtureRemotes('ci-watch-gate-');
	const root = remotes.root;
	const manifestDir = join(root, 'manifest');
	const reposDir = join(root, 'repos');
	const siteRoot = join(root, 'site');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(reposDir, { recursive: true });
	mkdirSync(join(siteRoot, 'workers', 'monitoring-api', 'src'), { recursive: true });

	writeFileSync(
		join(manifestDir, 'fleet-runner-coverage.json'),
		JSON.stringify({ repos, facets: {} })
	);
	// No exemptions, no extra watches, no drops — the roster above decides
	// everything for this fixture.
	writeFileSync(join(manifestDir, 'ci-watch-policy.json'), JSON.stringify({}));

	return {
		root,
		remotes,
		manifestDir,
		reposDir,
		siteRoot,
		outSite: join(siteRoot, 'workers', 'monitoring-api', 'src', 'ci-watch.generated.json'),
		outManifest: join(manifestDir, 'ci-watch.generated.json'),
	};
}

const WORKFLOW_BODY = 'jobs:\n  check:\n    runs-on: ubuntu-latest\n';

/** A roster repo that SHIPS one more watched workflow. A repo never given one
 *  has no remote at all, and reads as unreadable. */
function addShipped(fx, repo, { workflow = 'ci.yml' } = {}) {
	fx.remotes.push(repo, { [`.github/workflows/${workflow}`]: WORKFLOW_BODY });
}

/** A believable "already generated" file — only `targets.length` matters to
 *  the shrink guard, so the entries themselves are dummies. */
function priorGenerated(targetCount) {
	return (
		JSON.stringify(
			{
				$comment: 'fixture baseline',
				targets: Array.from({ length: targetCount }, (_, i) => ({
					owner: 'WolffM',
					repo: `prior-${i}`,
					workflow: 'ci.yml',
					label: `prior-${i} / ci`,
				})),
				coveredJobNames: [],
			},
			null,
			2
		) + '\n'
	);
}

function seed(fx, content) {
	writeFileSync(fx.outSite, content);
	writeFileSync(fx.outManifest, content);
}

/** One run of the script. Both streams go to FILES, not pipes — see
 *  json-pipe-8k-cliff: `ci-watch.mjs` calls `keepStdoutWhole()` for exactly
 *  this reason, and a pipe captured only via `e.stderr` on throw would miss
 *  every warning the script prints on a SUCCESSFUL run (exit 0), which is
 *  exactly where `ci-watch.mjs`'s unreadable-baseline warning lands. */
function run(fx, argv = []) {
	const tag = Math.random().toString(36).slice(2);
	const outPath = join(fx.root, `stdout-${tag}.txt`);
	const errPath = join(fx.root, `stderr-${tag}.txt`);
	const outFd = openSync(outPath, 'w');
	const errFd = openSync(errPath, 'w');
	let code = 0;
	try {
		execFileSync('node', [SCRIPT, ...argv], {
			env: {
				...NO_GIT_ENV,
				...fx.remotes.env,
				REPOS_DIR: fx.reposDir,
				FLEET_MANIFEST_DIR: fx.manifestDir,
				HADOKU_SITE_ROOT: fx.siteRoot,
			},
			stdio: ['ignore', outFd, errFd],
		});
	} catch (e) {
		code = e.status ?? -1;
	} finally {
		closeSync(outFd);
		closeSync(errFd);
	}
	return { code, out: readFileSync(outPath, 'utf8'), stderr: readFileSync(errPath, 'utf8') };
}

function cleanup(fx) {
	rmSync(fx.root, { recursive: true, force: true });
}

const REPO_A = 'WolffM/repo-a';
const REPO_B = 'WolffM/repo-b';

// ── the floor: a clean write with no prior file must still work ───────────

test('a fully covered roster with no prior output writes both copies and exits 0', () => {
	const fx = fixture([REPO_A, REPO_B]);
	try {
		addShipped(fx, REPO_A);
		addShipped(fx, REPO_B);
		const r = run(fx, ['--write']);
		assert.equal(
			r.code,
			0,
			`expected a clean write to exit 0, got ${r.code}:\n${r.out}\n${r.stderr}`
		);
		const written = JSON.parse(readFileSync(fx.outManifest, 'utf8'));
		assert.equal(written.targets.length, 2);
		assert.deepEqual(readFileSync(fx.outManifest, 'utf8'), readFileSync(fx.outSite, 'utf8'));
	} finally {
		cleanup(fx);
	}
});

// ── #84 part 1/4: an unreadable roster refuses the write outright ─────────

test('a roster none of whose repos can be read leaves both output files byte-identical and exits non-zero', () => {
	const fx = fixture([REPO_A, REPO_B]);
	try {
		// No addShipped calls: neither repo has a remote, so neither can be read.
		const baseline = priorGenerated(2);
		seed(fx, baseline);

		const r = run(fx, ['--write']);
		assert.notEqual(r.code, 0, 'a roster with no checkouts must not exit 0');
		assert.equal(
			readFileSync(fx.outSite, 'utf8'),
			baseline,
			'the site copy must be untouched when the write is refused'
		);
		assert.equal(
			readFileSync(fx.outManifest, 'utf8'),
			baseline,
			'the manifest copy must be untouched when the write is refused'
		);
	} finally {
		cleanup(fx);
	}
});

test('a roster missing ONE checkout still refuses the write, not just a total wipeout', () => {
	const fx = fixture([REPO_A, REPO_B]);
	try {
		addShipped(fx, REPO_A); // REPO_B has none
		const baseline = priorGenerated(5);
		seed(fx, baseline);

		const r = run(fx, ['--write']);
		assert.notEqual(r.code, 0);
		assert.equal(readFileSync(fx.outManifest, 'utf8'), baseline);
		assert.equal(readFileSync(fx.outSite, 'utf8'), baseline);
	} finally {
		cleanup(fx);
	}
});

// ── #84 part 3: the shrink floor, independent of missing checkouts ────────

test('a write that would shrink targets below 50% is refused without --allow-shrink', () => {
	const fx = fixture([REPO_A, REPO_B]);
	try {
		// Every roster repo HAS a checkout and a watched workflow — this is not
		// the missing-checkout case. 2 new targets against 10 prior is below
		// the 50% floor on its own.
		addShipped(fx, REPO_A);
		addShipped(fx, REPO_B);
		const baseline = priorGenerated(10);
		seed(fx, baseline);

		const r = run(fx, ['--write']);
		assert.notEqual(r.code, 0, 'a 10 -> 2 shrink must not be written silently');
		assert.match(r.out + r.stderr, /shrink|below 50%/i);
		assert.equal(readFileSync(fx.outManifest, 'utf8'), baseline);
		assert.equal(readFileSync(fx.outSite, 'utf8'), baseline);
	} finally {
		cleanup(fx);
	}
});

test('--allow-shrink lifts the floor and the write proceeds', () => {
	const fx = fixture([REPO_A, REPO_B]);
	try {
		addShipped(fx, REPO_A);
		addShipped(fx, REPO_B);
		const baseline = priorGenerated(10);
		seed(fx, baseline);

		const r = run(fx, ['--write', '--allow-shrink']);
		assert.equal(
			r.code,
			0,
			`--allow-shrink must let a legitimate shrink through: ${r.out}\n${r.stderr}`
		);
		const written = JSON.parse(readFileSync(fx.outManifest, 'utf8'));
		assert.equal(written.targets.length, 2);
		assert.notEqual(readFileSync(fx.outManifest, 'utf8'), baseline);
	} finally {
		cleanup(fx);
	}
});

test('a shrink floor at the boundary (exactly 50%) is not refused', () => {
	const fx = fixture([REPO_A, REPO_B]);
	try {
		addShipped(fx, REPO_A);
		addShipped(fx, REPO_B);
		// 2 new targets against 4 prior is exactly 50% — the guard is "below",
		// not "at or below", so this must be allowed to proceed.
		const baseline = priorGenerated(4);
		seed(fx, baseline);

		const r = run(fx, ['--write']);
		assert.equal(r.code, 0, `exactly 50% must not trip the floor: ${r.out}\n${r.stderr}`);
		assert.notEqual(readFileSync(fx.outManifest, 'utf8'), baseline);
	} finally {
		cleanup(fx);
	}
});

test('no prior output file means no shrink baseline — the first write is never a shrink', () => {
	const fx = fixture([REPO_A]);
	try {
		addShipped(fx, REPO_A);
		// Deliberately no seed(): outSite/outManifest do not exist yet.
		const r = run(fx, ['--write']);
		assert.equal(r.code, 0, `a first write has nothing to shrink from: ${r.out}\n${r.stderr}`);
	} finally {
		cleanup(fx);
	}
});

// ── manager send-back: an unreadable (not just absent) baseline must not be
// silent — behaviour stays "no shrink floor", but the reason is named ──────

test('an unreadable existing manifest copy skips the shrink floor AND warns by name, rather than failing silently', () => {
	const fx = fixture([REPO_A]);
	try {
		addShipped(fx, REPO_A);
		// A baseline that exists but is not valid JSON — distinct from "absent".
		writeFileSync(fx.outManifest, '{ not valid json');
		writeFileSync(fx.outSite, '{ not valid json');

		const r = run(fx, ['--write']);
		assert.equal(
			r.code,
			0,
			`an unreadable baseline must not block the write (no baseline = no shrink to compare against): ${r.out}\n${r.stderr}`
		);
		assert.match(
			r.stderr,
			/ci-watch\.generated\.json exists but could not be read as JSON/,
			'the warning must name the file and the reason, not swallow it'
		);
	} finally {
		cleanup(fx);
	}
});

// ── #98: a policy entry that no longer excepts anything is drift ──────────
//
// Each case: REPO_A has a real checkout with `ci.yml` (the convention picks
// it) plus whatever the case adds, and the policy holds ONE stale entry. The
// run uses `--json`, so the drift must land in `problems` — the field the
// contract consumer reads — and fail the exit code.

function policyRun(policy, { extraWorkflows = [] } = {}) {
	const fx = fixture([REPO_A]);
	try {
		addShipped(fx, REPO_A);
		for (const w of extraWorkflows) addShipped(fx, REPO_A, { workflow: w });
		writeFileSync(join(fx.manifestDir, 'ci-watch-policy.json'), JSON.stringify(policy));
		const r = run(fx, ['--json']);
		return { ...r, doc: JSON.parse(r.out) };
	} finally {
		cleanup(fx);
	}
}

test('#98 floor: a policy whose every entry still applies is clean', () => {
	const r = policyRun(
		{
			$comment: 'prose, not an entry',
			alsoWatch: { $comment: 'prose', [REPO_A]: ['release.yml'] },
			neverWatch: { [REPO_A]: ['deploy-preview.yml'] },
		},
		{ extraWorkflows: ['release.yml', 'deploy-preview.yml'] }
	);
	assert.deepEqual(r.doc.problems, []);
	assert.equal(r.code, 0, r.out + r.stderr);
});

for (const [name, policy, pattern] of [
	[
		'an `exempt` entry with no `why`',
		{ exempt: { [REPO_A]: {} } },
		/exempt\["WolffM\/repo-a"\] has no `why`/,
	],
	[
		'an `exempt` entry for a repo not on the roster',
		{ exempt: { 'WolffM/gone': { why: 'archived' } } },
		/exempt\["WolffM\/gone"\] names a repo not on the roster/,
	],
	[
		'an `alsoWatch` naming a workflow the repo does not have',
		{ alsoWatch: { [REPO_A]: ['release.yml'] } },
		/alsoWatch\["WolffM\/repo-a"\] names release\.yml/,
	],
	[
		'a `neverWatch` naming a workflow the convention never picks',
		{ neverWatch: { [REPO_A]: ['pages.yml'] } },
		/neverWatch\["WolffM\/repo-a"\] names pages\.yml/,
	],
]) {
	test(`#98: ${name} is drift in \`problems\`, and fails`, () => {
		const r = policyRun(policy, { extraWorkflows: ['pages.yml'] });
		assert.equal(r.doc.problems.length, 1, r.out);
		assert.match(r.doc.problems[0], pattern);
		assert.equal(r.code, 1);
	});
}

/**
 * fleet-manager#7: A LOCAL CLONE CANNOT CHANGE THE TARGETS. The baseline has
 * clones under REPOS_DIR that MATCH the shipped branches. Then they go CRLF,
 * keep a deploy workflow the remote deleted, and carry an uncommitted
 * `publish.yml` — each a watched name if read off disk. The generated targets
 * must not move. Revert the gate to reading REPOS_DIR and they do.
 */
test('#7: a CRLF, stale, dirty clone under REPOS_DIR does not change the targets', () => {
	const fx = fixture([REPO_A, REPO_B]);
	try {
		addShipped(fx, REPO_A);
		addShipped(fx, REPO_B);
		const shippedFiles = { '.github/workflows/ci.yml': WORKFLOW_BODY };
		poisonedClone(fx.reposDir, REPO_A, shippedFiles);
		poisonedClone(fx.reposDir, REPO_B, shippedFiles);
		const baseline = run(fx, ['--json']);
		assert.equal(baseline.code, 0, baseline.out + baseline.stderr);
		const before = JSON.parse(baseline.out);
		assert.equal(before.targets, 2);
		assert.equal(run(fx, ['--write']).code, 0);
		const written = readFileSync(fx.outManifest, 'utf8');

		rmSync(join(fx.reposDir, 'repo-a'), { recursive: true, force: true });
		rmSync(join(fx.reposDir, 'repo-b'), { recursive: true, force: true });
		poisonedClone(
			fx.reposDir,
			REPO_A,
			{ ...shippedFiles, '.github/workflows/deploy-old.yml': WORKFLOW_BODY },
			{ crlf: true }
		);
		poisonedClone(fx.reposDir, REPO_B, shippedFiles, {
			edit: { '.github/workflows/publish.yml': 'jobs:\n  wip:\n    runs-on: ubuntu-latest\n' },
		});
		const poisoned = run(fx, ['--json']);
		assert.equal(poisoned.code, baseline.code, poisoned.out + poisoned.stderr);
		assert.deepEqual(JSON.parse(poisoned.out), before);
		assert.equal(run(fx, ['--write']).code, 0);
		assert.equal(readFileSync(fx.outManifest, 'utf8'), written, 'the written targets moved');
	} finally {
		cleanup(fx);
	}
});

test('#7: an unreadable roster repo is a problem carrying the reason', () => {
	const fx = fixture([REPO_A, REPO_B]);
	try {
		addShipped(fx, REPO_A);
		const r = run(fx, ['--json']);
		assert.equal(r.code, 1);
		assert.match(
			JSON.parse(r.out).problems.join('\n'),
			/1 roster repo\(s\) could not be read: WolffM\/repo-b \(fetch from .* failed/
		);
	} finally {
		cleanup(fx);
	}
});
