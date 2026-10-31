import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanGitEnv, FIXTURE_IDENTITY } from './lib/test-git-identity.mjs';

const { fastForwardManifest, applyPlacementWrite } = await import('./lib/provision-phases.mjs');

const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('the step asks the report BEFORE it measures, and asks the cron’s question', () => {
	const src = readFileSync(new URL('./lib/provision-phases.mjs', import.meta.url), 'utf8');
	const phase = src.slice(
		src.indexOf('function benchmarkPhase'),
		src.indexOf('function healthPhase')
	);
	// The report call is `--report --json`, with no node positional: a node
	// named positionally is measured unconditionally, which is the whole bug.
	const reportAt = phase.indexOf("'--report'");
	const decideAt = phase.indexOf('benchmarkStep(');
	const measureAt = phase.indexOf("'--write'");
	assert.ok(reportAt >= 0 && decideAt > reportAt, 'the report is read before the decision');
	assert.ok(measureAt > decideAt, 'nothing is measured before the decision');
	assert.ok(
		!/node,\n\t\t\t'--due',\n\t\t\tString\(BENCHMARK_DUE_DAYS\),\n\t\t\t'--report'/.test(phase),
		'the REPORT invocation must not name the node positionally'
	);
});

// ── the manifest write path, against a FIXTURE checkout ─────────────────────

/**
 * A scratch hadoku_site-shaped checkout holding a manifest.
 *
 * IT STATES ITS OWN IDENTITY IN ITS OWN CONFIG FILE, and that is the one thing
 * here that is not obvious. `applyPlacementWrite` makes a REAL commit through
 * `landWrite`, which reaches git through `manifest-target.mjs`'s `runGit` —
 * and that helper strips every `GIT_*` variable from the environment before it
 * spawns, to keep a hook's `GIT_DIR`/`GIT_INDEX_FILE` from redirecting the
 * write. The fixture identity travels in `GIT_AUTHOR_*`/`GIT_COMMITTER_*`,
 * which start with `GIT_`, so the strip eats it too — verbatim the trap
 * `lib/test-git-identity.mjs`'s own header describes. No environment this test
 * can set will survive into that child.
 *
 * So the identity has to be config, and `hook-safe-tests.test.mjs` names the
 * form that is safe: `git config --file <path>` — the target is stated in the
 * command, so no `GIT_DIR`, `GIT_CONFIG*` or shared worktree common dir can
 * move it somewhere real. The path here is inside a `mkdtemp` directory this
 * test created and deletes, so the write cannot reach this repository even in
 * principle. (Bare `git config user.email` is what put 59 wrongly-authored
 * commits on `origin/main`, and stays banned.)
 *
 * WITHOUT IT, THIS TEST PASSES ON THE WRONG BOX FOR THE WRONG REASON. With no
 * identity anywhere, git falls back to `user@hostname`: on a workstation whose
 * hostname resolves that guess SUCCEEDS and the commit lands under a real
 * person's name, while on a claw the hostname is `claw-N.(none)` and git
 * refuses with "unable to auto-detect email address". That is exactly how this
 * file passed here and reddened main from CI. The assertion below therefore
 * checks WHO the commit is by, not just that one happened — so the failure is
 * deterministic on every box rather than only on the runner.
 */
function site(machines) {
	const d = mkdtempSync(join(tmpdir(), 'fleet-provision-'));
	made.push(d);
	git(d, ['init', '-q', '-b', 'main']);
	for (const [key, value] of [
		['user.name', FIXTURE_IDENTITY.name],
		['user.email', FIXTURE_IDENTITY.email],
	]) {
		git(d, ['config', '--file', join(d, '.git', 'config'), key, value]);
	}
	writeFileSync(
		join(d, 'fleet-runner-manifest.json'),
		JSON.stringify({ machines }, null, 2) + '\n'
	);
	git(d, ['add', '-A']);
	git(d, ['commit', '-q', '-m', 'base']);
	return d;
}

function git(dir, args) {
	const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: cleanGitEnv() });
	assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

const readManifest = (d) => JSON.parse(readFileSync(join(d, 'fleet-runner-manifest.json'), 'utf8'));

test('applyPlacementWrite lands backfill + ephemeral as ONE surgical commit', async () => {
	// The claw-8 pre-fix shape: declared before placement was derived, so the
	// entry carries none of the fields a serving claw needs.
	const d = site({
		'claw-8': { cores: 8, ramGb: 15, maxConcurrent: 3, minFreeMb: 2048, $why: 'human prose' },
	});
	const mp = join(d, 'fleet-runner-manifest.json');
	const w = await applyPlacementWrite({
		manifestPath: mp,
		node: 'claw-8',
		backfill: {
			labels: [],
			role: 'claw',
			maxRegistrations: 32,
			minFreeGb: 25,
			slice: { swapMb: 4096, unitMaxMb: 4096 },
		},
		ephemeral: true,
		noPush: true,
	});
	assert.equal(w.ok, true, w.why ?? w.note);
	const e = readManifest(d).machines['claw-8'];
	assert.equal(e.ephemeral, true);
	assert.deepEqual(e.labels, []);
	assert.equal(e.minFreeGb, 25);
	// SURGICAL: the human fields survive beside what the chain wrote.
	assert.equal(e.cores, 8);
	assert.equal(e.$why, 'human prose');
	// IT LANDED: a commit exists on the fixture, carrying only the manifest.
	const log = git(d, ['log', '--format=%s', '-1']);
	assert.match(log, /^fleet\(provision\): placement for claw-8 \(ephemeral on\)/);
	// AND IT IS BY THE FIXTURE, not by whoever git could guess from the hostname.
	// `landWrite` strips `GIT_*` before spawning, so an identity that reached
	// this commit by any route other than the fixture's own config file is git
	// falling back to `user@host` — which SUCCEEDS on a workstation and FAILS on
	// a claw ("unable to auto-detect email address (got 'hadoku@claw-6.(none)')").
	// Asserting the author is what makes that difference visible everywhere
	// instead of only on the runner that reddened main.
	assert.equal(
		git(d, ['log', '--format=%ae', '-1']).trim(),
		FIXTURE_IDENTITY.email,
		'the landed commit is not authored by the fixture identity — git guessed one'
	);
	assert.equal(git(d, ['log', '--format=%ce', '-1']).trim(), FIXTURE_IDENTITY.email);
	// SURGICAL means ONE commit and ONE file in it.
	assert.deepEqual(git(d, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n'), [
		'fleet-runner-manifest.json',
	]);
});

test('applyPlacementWrite with nothing owed writes NOTHING — the idempotent half', async () => {
	const d = site({ 'claw-9': { ephemeral: true, labels: [] } });
	const before = git(d, ['rev-parse', 'HEAD']);
	const w = await applyPlacementWrite({
		manifestPath: join(d, 'fleet-runner-manifest.json'),
		node: 'claw-9',
		backfill: {},
		ephemeral: false,
		noPush: true,
	});
	assert.equal(w.ok, true);
	assert.match(w.note, /nothing to write/);
	assert.equal(
		git(d, ['rev-parse', 'HEAD']),
		before,
		'an idempotent re-run must not manufacture a commit'
	);
});

test('a target already carrying uncommitted changes is refused, not folded in', async () => {
	// Landing on a dirty file would file somebody else's edit under this
	// writer's commit and let the drift gate read the result as landed —
	// `writeTarget`'s third refusal, reached here through the real path.
	const d = site({ 'claw-9': { labels: [] } });
	const mp = join(d, 'fleet-runner-manifest.json');
	writeFileSync(
		mp,
		JSON.stringify({ machines: { 'claw-9': { labels: ['someone-elses-edit'] } } }, null, 2)
	);
	const w = await applyPlacementWrite({
		manifestPath: mp,
		node: 'claw-9',
		backfill: { role: 'claw' },
		ephemeral: false,
		noPush: true,
	});
	assert.equal(w.ok, false);
	assert.match(w.why, /dirty/);
	// and the foreign edit is still sitting there, uncommitted and unclaimed
	assert.deepEqual(readManifest(d).machines['claw-9'].labels, ['someone-elses-edit']);
});

test('an undeclared node is refused — placement writes an EXISTING entry', async () => {
	const d = site({ 'claw-1': { labels: [] } });
	const w = await applyPlacementWrite({
		manifestPath: join(d, 'fleet-runner-manifest.json'),
		node: 'claw-42',
		backfill: { labels: [] },
		ephemeral: true,
		noPush: true,
	});
	assert.equal(w.ok, false);
	assert.match(w.why, /not in .* — placement writes an EXISTING entry/);
});

test('a target outside a git checkout is refused before anything is written', async () => {
	const d = mkdtempSync(join(tmpdir(), 'fleet-provision-bare-'));
	made.push(d);
	const mp = join(d, 'fleet-runner-manifest.json');
	writeFileSync(mp, JSON.stringify({ machines: { 'claw-9': {} } }));
	const w = await applyPlacementWrite({
		manifestPath: mp,
		node: 'claw-9',
		backfill: {},
		ephemeral: true,
	});
	assert.equal(w.ok, false);
	assert.match(w.why, /not-a-checkout|REFUSES/);
});

test('fastForward uses --ff-only — it cannot lose local work', () => {
	// The manual record's step 1 failed on "checkout behind origin". The fix is
	// a FAST-FORWARD, and the flag is the safety property: anything else could
	// merge or rebase operator state out from under another session.
	const src = readFileSync(new URL('./lib/provision-phases.mjs', import.meta.url), 'utf8');
	assert.match(src, /\['merge', '--ff-only', 'FETCH_HEAD'\]/);
	// and a diverged checkout is refused with the by-hand remedy, not forced.
	const d = site({});
	const ff = fastForwardManifest(join(d, 'fleet-runner-manifest.json'), {
		git: (args) => {
			if (args[0] === 'rev-parse') return { status: 0, stdout: `${d}\n`, stderr: '' };
			if (args[0] === 'remote') return { status: 0, stdout: 'url\n', stderr: '' };
			if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
			if (args[0] === 'merge')
				return { status: 1, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.' };
			throw new Error(`unexpected git call ${args.join(' ')}`);
		},
	});
	assert.equal(ff.ok, false);
	assert.match(ff.why, /cannot be fast-forwarded/);
	assert.match(ff.why, /by hand/);
});
