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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { readRunnerVar, runnerVarForm, repoVerdict } from './runner-var.mjs';

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

/** Run the real checker against a throwaway REPOS_DIR. */
function run(reposDir) {
	return spawnSync(process.execPath, [CHECKER, '--json'], {
		encoding: 'utf8',
		env: { ...process.env, REPOS_DIR: reposDir, FLEET_MANIFEST_DIR: reposDir },
	});
}

test('scanning ZERO repos FAILS — an empty report is not a clean one', () => {
	// The failure this whole file exists to prevent, one level up: a wrong
	// REPOS_DIR examines nothing and every finding list comes back empty.
	const dir = mkdtempSync(join(tmpdir(), 'runnervar-empty-'));
	try {
		const r = run(dir);
		assert.equal(r.status, 1, `zero repos must exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
		assert.match(r.stdout + r.stderr, /ZERO repos/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a covered repo with NO checkout is reported, not skipped', () => {
	// Silently skipping what you could not read is how a roster shrinks into a
	// clean bill of health.
	const dir = mkdtempSync(join(tmpdir(), 'runnervar-nocheckout-'));
	try {
		// A roster naming a repo that is not on disk, plus one repo that IS.
		writeFileSync(
			join(dir, 'fleet-runner-coverage.json'),
			JSON.stringify({ repos: ['WolffM/ghost', 'WolffM/present'] })
		);
		const p = join(dir, 'present', '.github', 'workflows');
		mkdirSync(p, { recursive: true });
		mkdirSync(join(dir, 'present', '.git'), { recursive: true });
		writeFileSync(join(p, 'ci.yml'), BARE);

		const r = run(dir);
		const out = JSON.parse(r.stdout);
		const ghost = out.findings.find((f) => f.repo === 'WolffM/ghost');
		assert.ok(ghost, `the un-checked-out repo must be reported: ${r.stdout}`);
		assert.equal(ghost.status, 'no-checkout');
		assert.equal(r.status, 1, 'and it must fail the run');
	} finally {
		rmSync(dir, { recursive: true, force: true });
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
