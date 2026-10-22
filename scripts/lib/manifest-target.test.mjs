/**
 * A FLEET WRITE THAT IS NOT A COMMIT IS NOT A WRITE.
 *
 * `manifest-target.mjs` has one job and three refusals, and the refusals are
 * the part worth testing: on 2026-09-14 a `fleet bootcamp --write` recorded a
 * capability into `~/srv/hadoku_site`, rendered it through that repo's own
 * prettier, took a backup, read the file back true — and was erased 40 seconds
 * later by a redeploy's `git reset --hard origin/main`. Every existing check
 * passed. Only refusing the target could have caught it.
 *
 * EACH REFUSAL MUST CARRY ITS OWN REASON, which is why every test below asserts
 * the `reason` and not merely `ok: false`. CLAUDE.md: "a rate limit, a timeout
 * and a deleted repo are three different jobs" — `deploy-tree` means point the
 * writer somewhere else, `not-a-checkout` means the operator's
 * `FLEET_MANIFEST_DIR` is wrong, and `dirty` means somebody else's edit is in
 * the way. Collapsing them would leave an operator with a refusal and no move.
 *
 * NOTHING HERE PUSHES TO A REAL REPOSITORY. Two kinds of fixture, and the split
 * is deliberate:
 *
 *   - the DEPLOY-TREE refusal is exercised against the real `~/srv/hadoku_site`
 *     path. It is safe because that branch is answered from the path alone,
 *     before any filesystem or git call, and asserting it against the real
 *     default is the only way to prove the default itself is right rather than
 *     proving that an env var this test set works.
 *   - everything else runs in temp git repositories, including the push, which
 *     goes to a local bare repo. A test of a writer that pushes must never be a
 *     test that mutates a repository somebody uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deployRoots, deploySiteRoot, landWrite, writeTarget } from './manifest-target.mjs';
import { formatEnrollmentRecord } from './enrollment-record.mjs';
/**
 * The env every child and every `git` here gets, with `GIT_*` REMOVED.
 *
 * `.husky/pre-push` runs this suite and a hook exports `GIT_DIR` and
 * `GIT_INDEX_FILE`, which OVERRIDE `cwd` for git. Without this, `writeTarget`
 * would answer about THIS repository while claiming to answer about a temp one
 * — a confident wrong answer, which is worse than a failed read and is the bug
 * `src/lib/fleet-paths.ts` already paid for once.
 *
 * IT ALSO CARRIES THE FIXTURE IDENTITY, so nothing here needs `git config
 * user.email`. That line used to sit in `repo()` reading `fleet-test@invalid`
 * — the same string that authored 38 commits on `origin/main` between 09-15
 * and 09-18. A config WRITE outlives the process; an env var does not.
 */
import { FIXTURE_IDENTITY, cleanGitEnv } from './test-git-identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENROLL = join(HERE, '..', 'enroll-node.mjs');

const made = [];
process.on('exit', () => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

function git(dir, args) {
	const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: cleanGitEnv() });
	assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
	return r.stdout.trim();
}

/** A temp git repo with a manifest committed at HEAD. Returns paths. */
function repo({ remote = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-target-'));
	made.push(dir);
	const work = join(dir, 'work');
	mkdirSync(work, { recursive: true });
	git(work, ['init', '-q', '-b', 'main']);
	// THE IDENTITY GOES IN THE FIXTURE'S OWN CONFIG, not just in our env.
	// `landWrite`/`enroll` commit through `runGit`, which calls `noGitEnv()` and
	// strips every GIT_* before spawning git — so GIT_AUTHOR_*/GIT_COMMITTER_*
	// from `cleanGitEnv()` reach OUR git calls and never theirs. Their commit
	// falls back to config, and a CI claw has no ~/.gitconfig and a hostname with
	// no domain, so auto-detection fails and the commit does not happen: 5 tests
	// here went red on claw-4 while passing on a workstation that has a global
	// identity. `--file` is the form the hook-safe-tests rule permits, and it
	// writes where every process that opens this repo can see it.
	for (const [k, v] of [
		['user.name', FIXTURE_IDENTITY.name],
		['user.email', FIXTURE_IDENTITY.email],
	])
		git(work, ['config', '--file', join(work, '.git', 'config'), k, v]);
	const file = join(work, 'fleet-runner-manifest.json');
	writeFileSync(file, `${JSON.stringify({ machines: {} }, null, 2)}\n`);
	git(work, ['add', '-A']);
	git(work, ['commit', '-q', '-m', 'base']);

	let bare = null;
	if (remote) {
		bare = join(dir, 'origin.git');
		execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: cleanGitEnv() });
		git(work, ['remote', 'add', 'origin', bare]);
		git(work, ['push', '-q', 'origin', 'HEAD:main']);
	}
	return { dir, work, file, bare };
}

// ── the three refusals, each with its own reason ─────────────────────────────

void test('the DEPLOY TREE is refused, against the real ~/srv default', () => {
	// Path-only: no file is read and nothing is written. Asserting the real
	// default rather than one this test set is the whole point — an env var
	// proving itself would prove nothing about the path the cron actually uses.
	const inSrv = join(deploySiteRoot(), 'scripts', 'admin', 'fleet-runner-manifest.json');
	const r = writeTarget(inSrv);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'deploy-tree');
	assert.match(r.why, /reset --hard origin\/main/);
	assert.match(r.why, /FLEET_MANIFEST_DIR/, 'the refusal must say what to do next');
	assert.ok(
		deployRoots().includes(join(homedir(), 'srv')),
		'~/srv is the deploy root by DEFAULT, not because an environment set it'
	);
});

void test('the deploy tree is refused even when it is a clean git checkout', () => {
	// The ordering trap this file's header names: `~/srv/hadoku_site` IS a
	// checkout and IS normally clean, so `not-a-checkout` and `dirty` both pass
	// on it. If the deploy question were asked last, this would be a clean ok.
	const { work, file } = repo();
	assert.equal(writeTarget(file).ok, true, 'the fixture itself is landable');
	const r = writeTarget(file, { env: cleanGitEnv({ FLEET_DEPLOY_ROOTS: work }) });
	assert.equal(r.reason, 'deploy-tree');
});

void test('FLEET_DEPLOY_ROOTS can only ADD roots, never turn the guard off', () => {
	const inSrv = join(deploySiteRoot(), 'scripts', 'admin', 'fleet-runner-manifest.json');
	const r = writeTarget(inSrv, { env: cleanGitEnv({ FLEET_DEPLOY_ROOTS: '' }) });
	assert.equal(r.reason, 'deploy-tree', 'an empty list must not empty the defaults');
});

void test('a directory that is not a checkout is refused, and says so', () => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-target-plain-'));
	made.push(dir);
	const file = join(dir, 'fleet-runner-manifest.json');
	writeFileSync(file, '{}\n');
	const r = writeTarget(file);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'not-a-checkout');
	assert.match(r.why, /never become a commit/);
});

void test('a target that is ALREADY dirty on that file is refused', () => {
	const { file } = repo();
	writeFileSync(file, `${JSON.stringify({ machines: { 'claw-9': {} } }, null, 2)}\n`);
	const r = writeTarget(file);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'dirty');
	assert.match(r.why, /fold that edit into this writer/);
});

void test('dirtiness is scoped to the target — an unrelated edit does not refuse', () => {
	// The manifest writers drop a `.bak` beside the file and hadoku_site's tree
	// is rarely pristine. A repo-wide `git status` test would refuse every real
	// landing, which is how a guard gets removed instead of fixed.
	const { work, file } = repo();
	writeFileSync(join(work, 'unrelated.txt'), 'hello\n');
	assert.equal(writeTarget(file).ok, true);
});

void test('the three refusals are three DIFFERENT reasons', () => {
	const { work, file } = repo();
	const plain = mkdtempSync(join(tmpdir(), 'fleet-target-plain2-'));
	made.push(plain);
	writeFileSync(join(plain, 'm.json'), '{}\n');
	const deploy = writeTarget(file, { env: cleanGitEnv({ FLEET_DEPLOY_ROOTS: work }) }).reason;
	const notRepo = writeTarget(join(plain, 'm.json')).reason;
	writeFileSync(file, '{"machines":{}}\n');
	const dirty = writeTarget(file).reason;
	assert.deepEqual(
		[...new Set([deploy, notRepo, dirty])].sort(),
		['deploy-tree', 'dirty', 'not-a-checkout'],
		'each failure has a different fix, so each must arrive under a different name'
	);
});

void test('files in two different working trees cannot share one commit', () => {
	const a = repo();
	const b = repo();
	const r = writeTarget([a.file, b.file]);
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'split-repo');
});

// ── landing ──────────────────────────────────────────────────────────────────

void test('--no-push commits and STOPS, and says the record is not on main yet', () => {
	const { work, file } = repo();
	writeFileSync(file, `${JSON.stringify({ machines: { 'claw-9': {} } }, null, 2)}\n`);
	const landed = landWrite(file, {
		writer: 'doctor',
		summary: '$health on 1 node(s)',
		push: false,
	});
	assert.equal(landed.ok, true);
	assert.equal(landed.committed, true);
	assert.equal(landed.pushed, false);
	assert.equal(landed.reason, 'no-push');
	assert.match(landed.why, /not on main yet/);
	assert.equal(git(work, ['log', '-1', '--format=%s']), 'fleet(doctor): $health on 1 node(s)');
	assert.equal(git(work, ['status', '--porcelain']), '', 'the file is committed, not left staged');
});

void test('a write that changed no bytes is `unchanged`, not a failure', () => {
	const { file } = repo();
	const landed = landWrite(file, { writer: 'benchmark', summary: 'nothing', push: false });
	assert.equal(landed.ok, true);
	assert.equal(landed.committed, false);
	assert.equal(landed.reason, 'unchanged');
});

void test('with a remote it pushes HEAD:main, and the bare repo has the commit', () => {
	const { work, file, bare } = repo({ remote: true });
	writeFileSync(file, `${JSON.stringify({ machines: { 'claw-9': {} } }, null, 2)}\n`);
	const landed = landWrite(file, { writer: 'enroll', summary: 'declare claw-9' });
	assert.equal(landed.ok, true, landed.why ?? '');
	assert.equal(landed.pushed, true);
	assert.equal(
		execFileSync('git', ['-C', bare, 'log', '-1', '--format=%s', 'main'], {
			encoding: 'utf8',
			env: cleanGitEnv(),
		}).trim(),
		'fleet(enroll): declare claw-9'
	);
	assert.equal(git(work, ['rev-parse', 'HEAD']), landed.sha);
});

void test('a DIVERGENT branch is not pushed — HEAD:main would overwrite main', () => {
	// The reason the guard is an ancestor test and not a branch-name test: from
	// a worktree sitting on somebody else's feature branch, `HEAD:main` would
	// push that whole branch onto main.
	const { file, bare } = repo({ remote: true });
	// main moves on the remote, behind this checkout's back.
	const other = mkdtempSync(join(tmpdir(), 'fleet-target-other-'));
	made.push(other);
	execFileSync('git', ['clone', '-q', bare, other], { env: cleanGitEnv() });
	writeFileSync(join(other, 'elsewhere.txt'), 'x\n');
	git(other, ['add', '-A']);
	git(other, ['commit', '-q', '-m', 'somebody else']);
	git(other, ['push', '-q', 'origin', 'HEAD:main']);

	writeFileSync(file, `${JSON.stringify({ machines: { 'claw-9': {} } }, null, 2)}\n`);
	const landed = landWrite(file, { writer: 'doctor', summary: 'mid-air collision' });
	assert.equal(landed.committed, true, 'the commit is still made — the numbers are not lost');
	assert.equal(landed.pushed, false);
	assert.equal(landed.ok, false, 'a record that did not reach main is a finding');
	assert.equal(landed.reason, 'not-fast-forward');
	assert.match(landed.why, /Rebase/);
	assert.equal(
		execFileSync('git', ['-C', bare, 'log', '-1', '--format=%s', 'main'], {
			encoding: 'utf8',
			env: cleanGitEnv(),
		}).trim(),
		'somebody else',
		"main must still hold the other writer's commit"
	);
});

void test('no origin remote is its own reason — the commit exists, main cannot see it', () => {
	const { file } = repo();
	writeFileSync(file, `${JSON.stringify({ machines: { 'claw-9': {} } }, null, 2)}\n`);
	const landed = landWrite(file, { writer: 'bootcamp', summary: '$capabilities for 1 node(s)' });
	assert.equal(landed.committed, true);
	assert.equal(landed.ok, false);
	assert.equal(landed.reason, 'no-remote');
});

// ── a real writer, end to end ────────────────────────────────────────────────
//
// `enroll` is the one manifest writer that runs with no ssh, no token and no
// node: `--stdin` takes a capture. So it is the only one that can prove the
// whole path — refuse, or write AND commit — rather than proving the module in
// isolation and hoping the four call sites use it.

const CAPTURE = `noise from apt\n${formatEnrollmentRecord({
	fields: {
		// RELATIVE, not a calendar bomb — see `fixture-clock-guard.test.mjs`.
		recordedAt: new Date(Date.now() - 86_400_000).toISOString(),
		hostname: 'claw-9',
		profile: 'desktop-debian-trixie',
		role: 'runner',
		cores: 8,
		memTotalKb: 16258756,
		diskModel: 'WDC WD10EZEX-08W',
		diskFreeGb: 842,
		osId: 'debian',
		osCodename: 'trixie',
		kernel: '6.12.94+deb13-amd64',
		fleetUser: 'hadoku',
		sshPort: 22,
		sudoNoPasswd: 'ok',
		sshKeyAuthLoopback: 'ok',
		sshFromControl: null,
		authMode: 'key',
		ready: 'ok',
	},
	details: { sshFromControl: 'no inbound session at a console' },
	capabilities: [{ id: 'node20', ok: true, detail: 'v20.11.0' }],
})}trailing noise\n`;

function enroll(dir, extra = []) {
	return spawnSync(process.execPath, [ENROLL, '--stdin', '--write', '--json', ...extra], {
		encoding: 'utf8',
		input: CAPTURE,
		env: cleanGitEnv({ FLEET_MANIFEST_DIR: dir }),
	});
}

void test('`enroll --write` against a non-checkout REFUSES and writes nothing', () => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-enroll-plain-'));
	made.push(dir);
	const file = join(dir, 'fleet-runner-manifest.json');
	writeFileSync(file, `${JSON.stringify({ machines: {} }, null, 2)}\n`);
	const before = readFileSync(file, 'utf8');

	const r = enroll(dir, ['--no-push']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const out = JSON.parse(r.stdout);
	assert.equal(out.ok, false);
	assert.equal(out.refusal, 'not-a-checkout');
	assert.equal(readFileSync(file, 'utf8'), before, 'REFUSES means nothing was written');
});

void test('`enroll --write` against a DEPLOY TREE refuses, naming the reset', () => {
	const { work, file } = repo();
	const before = readFileSync(file, 'utf8');
	const r = spawnSync(process.execPath, [ENROLL, '--stdin', '--write', '--json', '--no-push'], {
		encoding: 'utf8',
		input: CAPTURE,
		env: cleanGitEnv({ FLEET_MANIFEST_DIR: work, FLEET_DEPLOY_ROOTS: work }),
	});
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const out = JSON.parse(r.stdout);
	assert.equal(out.refusal, 'deploy-tree');
	assert.match(out.error, /reset --hard origin\/main/);
	assert.equal(readFileSync(file, 'utf8'), before);
});

void test('`enroll --write` against a real checkout writes AND commits', () => {
	const { work, file } = repo();
	const r = enroll(work, ['--no-push']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.ok(JSON.parse(readFileSync(file, 'utf8')).machines['claw-9'], 'the entry was written');
	assert.equal(git(work, ['log', '-1', '--format=%s']), 'fleet(enroll): declare claw-9');
	// The COMMITTED copy carries the entry, which is the whole claim this lane
	// makes — a read-back of the working file proves only what the writer just
	// wrote, and that read-back passed on 2026-09-14 too.
	const committed = JSON.parse(git(work, ['show', 'HEAD:fleet-runner-manifest.json']));
	assert.ok(committed.machines['claw-9'], 'the entry is in the COMMIT, not just on disk');
	assert.equal(committed.machines['claw-9'].cores, 8);
});

void test('a dirty manifest stops `enroll --write` before it touches the file', () => {
	const { work, file } = repo();
	writeFileSync(file, `${JSON.stringify({ machines: { 'claw-3': { cores: 4 } } }, null, 2)}\n`);
	const before = readFileSync(file, 'utf8');
	const r = enroll(work, ['--no-push']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.equal(JSON.parse(r.stdout).refusal, 'dirty');
	assert.equal(readFileSync(file, 'utf8'), before);
});
