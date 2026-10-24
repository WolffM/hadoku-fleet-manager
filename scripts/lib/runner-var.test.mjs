/**
 * The guard `ci-runner-fallback.ts` claimed existed for a year and did not.
 *
 * The property under test is not "does it look at repos" but "can it FAIL" — a
 * checker that reports a clean fleet by construction is the exact shape this
 * repo's rules exist to forbid.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { readRunnerVar, runnerVarForm, repoVerdict } from './runner-var.mjs';
import { fixtureRemotes, poisonedClone } from './fleet-source-fixture.mjs';

const BARE = 'jobs:\n  check:\n    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}\n';
const FALLBACK =
	'jobs:\n  check:\n    runs-on: ${{ fromJSON(vars.CI_RUNNER || \'["self-hosted"]\') }}\n';

// ── the two forms are not equivalent, and comments are not evidence ──────────

test('the bare form and the fallback form are told apart', () => {
	assert.equal(runnerVarForm(BARE), 'bare');
	assert.equal(runnerVarForm(FALLBACK), 'fallback');
	assert.equal(runnerVarForm('jobs:\n  check:\n    runs-on: ubuntu-latest\n'), null);
});

test('a COMMENT mentioning the fallback is not a use of it', () => {
	// Four repos in this fleet carry "do NOT restore the `vars.CI_RUNNER || ...`
	// fallback here". A raw grep scores that as usage of the thing it forbids and
	// reported 7 users where there are 3.
	const src = '# do not restore the vars.CI_RUNNER || ... fallback here\n' + BARE;
	assert.equal(runnerVarForm(src), 'bare', 'the comment must not flip it to fallback');
});

test('a comment is not a REFERENCE either', () => {
	const src = '# this repo used to read vars.CI_RUNNER\njobs:\n  a:\n    runs-on: ubuntu-latest\n';
	assert.equal(runnerVarForm(src), null);
});

// ── the verdicts ────────────────────────────────────────────────────────────

const uses = (form, file = 'ci.yml') => [{ file, form }];

test('bare + UNSET is the finding: those workflows fail to start', () => {
	const v = repoVerdict('WolffM/x', uses('bare'), null);
	assert.equal(v.status, 'missing');
	assert.match(v.why, /FAIL TO START/);
	assert.deepEqual(v.files, ['ci.yml']);
});

test('fallback + unset is SAFE, and says not to convert it', () => {
	// This is why hadoku_site/templates/* keep the fallback: it is the only thing
	// making a freshly scaffolded repo's CI run before its first reconcile.
	const v = repoVerdict('WolffM/x', uses('fallback'), null);
	assert.equal(v.status, 'unset-but-safe');
	assert.match(v.why, /still schedule/);
});

test('bare + set is fine', () => {
	assert.equal(repoVerdict('WolffM/x', uses('bare'), '["self-hosted"]').status, 'ok');
});

test('UNREADABLE is its own answer, never a pass', () => {
	// "I could not look" must not render as "nothing is wrong". `undefined` and
	// `null` mean different things and collapsing them is the bug.
	const v = repoVerdict('WolffM/x', uses('bare'), undefined);
	assert.equal(v.status, 'unreadable');
	assert.notEqual(v.status, 'ok');
});

test('a repo that does not reference CI_RUNNER is not judged at all', () => {
	assert.equal(repoVerdict('WolffM/x', [], null), null);
});

test('one bare file among fallbacks still fails the repo', () => {
	// The weakest link decides: one workflow that cannot start is an outage for
	// that workflow, whatever its neighbours do.
	const v = repoVerdict('WolffM/x', [...uses('fallback', 'a.yml'), ...uses('bare', 'b.yml')], null);
	assert.equal(v.status, 'missing');
	assert.deepEqual(v.files, ['b.yml']);
});

// ── the checker itself must be able to fail ─────────────────────────────────

const CHECKER = new URL('../check-runner-var.mjs', import.meta.url).pathname;

/**
 * A `gh` that answers from a JSON fixture: `repos` for `repo list` (or
 * `listFail: true` to fail it), `vars` for the CI_RUNNER read — absent is a 404.
 */
const GH_SHIM = `const fx = JSON.parse(require('fs').readFileSync(process.env.GH_FIXTURE, 'utf8'));
const argv = process.argv.slice(2).join(' ');
if (argv.startsWith('repo list')) {
	if (fx.listFail) { process.stderr.write('gh: HTTP 502\\n'); process.exit(1); }
	const listing = fx.repos.map((nameWithOwner) => ({
		nameWithOwner,
		isFork: (fx.forks ?? []).includes(nameWithOwner),
		isEmpty: false,
	}));
	process.stdout.write(JSON.stringify(listing));
	process.exit(0);
}
const m = argv.match(new RegExp('repos/([^ ]+)/actions/variables/CI_RUNNER'));
if (m && fx.vars[m[1]] !== undefined) { process.stdout.write(fx.vars[m[1]] + '\\n'); process.exit(0); }
process.stderr.write('gh: Not Found (HTTP 404)\\n');
process.exit(1);
`;

/**
 * A throwaway fleet: fixture REMOTES read through fleet-source, a `gh` shim,
 * a manifest dir, and an EMPTY REPOS_DIR — nothing on disk may matter.
 */
function fleet({
	repos = [],
	roster = [],
	vars = {},
	listFail = false,
	forks = [],
	remotes: files = {},
} = {}) {
	const remotes = fixtureRemotes('runnervar-');
	const { root } = remotes;
	for (const [repo, f] of Object.entries(files)) remotes.push(repo, f);
	const manifests = join(root, 'manifests');
	const reposDir = join(root, 'repos');
	const bin = join(root, 'bin');
	for (const d of [manifests, reposDir, bin]) mkdirSync(d, { recursive: true });
	writeFileSync(join(manifests, 'fleet-runner-coverage.json'), JSON.stringify({ repos: roster }));
	writeFileSync(join(root, 'gh.json'), JSON.stringify({ repos, vars, listFail, forks }));
	// A .cjs beside a bash wrapper: an extensionless node script would be loaded
	// as ESM under any ancestor package.json with "type": "module".
	writeFileSync(join(bin, 'gh.cjs'), GH_SHIM);
	writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\nexec node "$0.cjs" "$@"\n`);
	chmodSync(join(bin, 'gh'), 0o755);
	const env = {
		...process.env,
		...remotes.env,
		PATH: `${bin}:${process.env.PATH}`,
		GH_FIXTURE: join(root, 'gh.json'),
		REPOS_DIR: reposDir,
		FLEET_MANIFEST_DIR: manifests,
	};
	return { root, reposDir, env, cleanup: remotes.cleanup };
}

function run(env) {
	const r = spawnSync(process.execPath, [CHECKER, '--json'], { encoding: 'utf8', env });
	return { ...r, out: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null };
}

test('scanning ZERO repos FAILS — an empty report is not a clean one', () => {
	// The failure this whole file exists to prevent, one level up: a broken
	// listing examines nothing and every finding list comes back empty.
	const fx = fleet();
	try {
		const r = run(fx.env);
		assert.equal(r.status, 1, `zero repos must exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
		assert.match(r.stdout + r.stderr, /ZERO repos/);
	} finally {
		fx.cleanup();
	}
});

test('a repo listing that fails is exit 1 with the error shape, never zero findings', () => {
	const fx = fleet({ listFail: true });
	try {
		const r = run(fx.env);
		assert.equal(r.status, 1);
		assert.match(r.out.error, /could not list .*HTTP 502/);
		assert.equal(r.out.examined, 0);
	} finally {
		fx.cleanup();
	}
});

test('a covered repo whose source cannot be read is reported, not skipped', () => {
	// Silently skipping what you could not read is how a roster shrinks into a
	// clean bill of health.
	const fx = fleet({
		repos: ['WolffM/present'],
		roster: ['WolffM/ghost', 'WolffM/present'],
		vars: { 'WolffM/present': '["self-hosted"]' },
		remotes: { 'WolffM/present': { '.github/workflows/ci.yml': BARE } },
	});
	try {
		const r = run(fx.env);
		const ghost = r.out.findings.find((f) => f.repo === 'WolffM/ghost');
		assert.ok(ghost, `the unreadable repo must be reported: ${r.stdout}`);
		assert.equal(ghost.status, 'no-checkout');
		assert.match(ghost.why, /fetch from .* failed/, 'the reader says WHY');
		assert.equal(r.status, 1, 'and it must fail the run');
	} finally {
		fx.cleanup();
	}
});

test('a listed repo with NO clone anywhere is still read', () => {
	// A cron host holds no ~/repos. Its population is the owner's list.
	const fx = fleet({
		repos: ['WolffM/unset'],
		remotes: { 'WolffM/unset': { '.github/workflows/ci.yml': BARE } },
	});
	try {
		const r = run(fx.env);
		assert.equal(r.status, 1);
		assert.deepEqual(
			r.out.findings.map((f) => [f.repo, f.status]),
			[['WolffM/unset', 'missing']]
		);
	} finally {
		fx.cleanup();
	}
});

/**
 * fleet-manager#7: A LOCAL CLONE CANNOT CHANGE THE VERDICT. Baseline clones
 * under REPOS_DIR match the shipped branches, so a gate reading disk passes it
 * too. Then they are poisoned — CRLF, a workflow the remote deleted, and an
 * uncommitted workflow on the bare form in a repo whose variable is unset —
 * and the verdict must not move. Revert the gate to reading disk and the
 * poisoned run reports `missing`.
 */
test('#7: a CRLF, stale, dirty clone under REPOS_DIR does not change the verdict', () => {
	const present = { '.github/workflows/ci.yml': BARE };
	const plain = { '.github/workflows/ci.yml': 'jobs:\n  a:\n    runs-on: ubuntu-latest\n' };
	const fx = fleet({
		repos: ['WolffM/present', 'WolffM/plain'],
		roster: ['WolffM/present'],
		vars: { 'WolffM/present': '["self-hosted"]' },
		remotes: { 'WolffM/present': present, 'WolffM/plain': plain },
	});
	try {
		poisonedClone(fx.reposDir, 'WolffM/present', present);
		poisonedClone(fx.reposDir, 'WolffM/plain', plain);
		const baseline = run(fx.env);
		assert.equal(baseline.status, 0, `the clean fleet must pass: ${baseline.stdout}`);

		rmSync(join(fx.reposDir, 'present'), { recursive: true, force: true });
		rmSync(join(fx.reposDir, 'plain'), { recursive: true, force: true });
		poisonedClone(
			fx.reposDir,
			'WolffM/present',
			{ ...present, '.github/workflows/deleted-upstream.yml': FALLBACK },
			{ crlf: true }
		);
		poisonedClone(fx.reposDir, 'WolffM/plain', plain, {
			crlf: true,
			edit: { '.github/workflows/wip.yml': BARE },
		});
		const poisoned = run(fx.env);
		assert.equal(poisoned.status, baseline.status, poisoned.stdout);
		assert.deepEqual(poisoned.out.findings, baseline.out.findings);
		assert.deepEqual(poisoned.out.ok, baseline.out.ok);
		assert.equal(poisoned.out.examined, baseline.out.examined);
	} finally {
		fx.cleanup();
	}
});

/**
 * The roster's direct-evidence override reads this helper, so these two cases
 * are what keeps a single-workflow fleet repo on the roster.
 *
 * Regression: `targetsSelfHostedFleet` used to test only `/self-hosted/` against
 * the file. The 2026-08-30 sweep moved every covered repo onto the bare
 * `${{ fromJSON(vars.CI_RUNNER) }}` form, which does not contain that literal —
 * so the override matched nothing and hadoku-games-host stayed off the roster
 * with two claws and hokon quietly running its runners.
 */
test('the bare fleet form is evidence a repo wants the fleet', () => {
	assert.equal(
		runnerVarForm('jobs:\n  x:\n    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}\n'),
		'bare'
	);
});

test('a comment naming CI_RUNNER is not evidence', () => {
	assert.equal(
		runnerVarForm('# do NOT restore the vars.CI_RUNNER fallback here\njobs: {}\n'),
		null
	);
});

/** gh's own failure shape: a non-zero exit with the HTTP status on stderr. */
const ghError = (stderr, status = 1) => Object.assign(new Error('gh failed'), { stderr, status });

test('#125: one transient failure is retried, and the second answer stands', () => {
	let calls = 0;
	let slept = 0;
	const r = readRunnerVar(
		'WolffM/brave-quartet',
		() => {
			calls++;
			if (calls === 1) throw ghError('gh: Server Error (HTTP 502)');
			return '["self-hosted","hadoku-builder"]';
		},
		{ sleep: () => slept++ }
	);
	assert.deepEqual(r, { value: '["self-hosted","hadoku-builder"]' });
	assert.equal(calls, 2);
	assert.equal(slept, 1);
});

test('#125: a read that fails every attempt is unreadable, and the finding says why', () => {
	// MUTATION: drop the reason from repoVerdict's `why` and the last assertion fails.
	let calls = 0;
	const r = readRunnerVar('WolffM/x', () => {
		calls++;
		throw ghError('gh: API rate limit exceeded (HTTP 403)');
	});
	assert.equal(calls, 2, 'looked twice before saying so');
	assert.equal(r.value, undefined, 'still could-not-look — retrying is not tolerating');
	const v = repoVerdict('WolffM/x', uses('bare'), r.value, r.reason);
	assert.equal(v.status, 'unreadable');
	assert.match(v.why, /HTTP 403/);
	assert.match(v.why, /attempt 2\/2/);
});

test('#125: a 404 is the answer "not set", returned at once and never retried', () => {
	let calls = 0;
	const r = readRunnerVar('WolffM/x', () => {
		calls++;
		throw ghError('gh: Not Found (HTTP 404)');
	});
	assert.deepEqual(r, { value: null });
	assert.equal(calls, 1);
});

test('a FORK is not in the population — upstream code, never mirrored — unless the roster names it', () => {
	// WolffM/microsoft-vscode has no remote: reading it would be unreadable.
	const fx = fleet({
		repos: ['WolffM/present', 'WolffM/microsoft-vscode'],
		forks: ['WolffM/microsoft-vscode'],
		vars: { 'WolffM/present': '["self-hosted"]' },
		remotes: { 'WolffM/present': { '.github/workflows/ci.yml': BARE } },
	});
	try {
		const r = run(fx.env);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.ok(!r.stdout.includes('microsoft-vscode'), r.stdout);
	} finally {
		fx.cleanup();
	}
});
