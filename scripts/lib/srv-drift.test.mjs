/**
 * THE DRIFT GATE, AGAINST A REAL GIT FIXTURE.
 *
 * `srvDriftVerdict` is pure and the unit tests below pin its judging rules, but
 * the property this lane actually needs is that the SCRIPT — reading a working
 * tree, a HEAD blob and an `origin/main` blob out of git — goes red on a deploy
 * tree somebody wrote and green on one nobody did. So the fixture is a genuine
 * three-way git setup (work tree, its HEAD, a bare origin), built in a temp
 * directory and pointed at with `FLEET_DEPLOY_SITE_ROOT`.
 *
 * WHY NOT AGAINST `~/srv` ITSELF. It is reset by every publish anywhere in the
 * ecosystem — that is the whole subject of this gate — so a suite asserting
 * anything about its content would be asserting a fact with a lifetime of
 * minutes. The manager's own note for this wave: do not build a check that
 * assumes srv is stable mid-wave. The real install is verified by RUNNING the
 * command, once, by hand; what is pinned here is the logic.
 *
 * `--no-fetch` for all but one of them, and it is not a weakening: the
 * fixture's `origin` is a bare repo on the same disk whose refs are already
 * current, and the run reports `fetched: false` so a reader can see which it
 * was. What `--no-fetch` skips is a network call, not a comparison.
 *
 * THE EXCEPTION IS THE RACE TEST, which is ABOUT the fetch, so it has to run
 * one. Its `origin` is still a bare repo on the same disk — the fetch is real
 * git machinery, not real network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOVED_FACETS, facetDiff, facets, srvDriftVerdict, stable } from './srv-drift.mjs';
import { cleanGitEnv } from './test-git-identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'check-srv-drift.mjs');
const REL = join('scripts', 'admin', 'fleet-runner-manifest.json');

const made = [];
process.on('exit', () => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

function git(dir, args) {
	const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: cleanGitEnv() });
	assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
	return r.stdout.trim();
}

/**
 * FIXTURE STAMPS ARE RELATIVE, and the reason is the one `fixture-clock-guard`
 * exists for: an absolute date here would be a calendar bomb. These `at` values
 * are OPAQUE to this gate — it compares facets for equality and quotes the
 * stamp back in a `why` string, and only `mainAgeSeconds`, which comes from
 * git's own commit date, is ever measured against a clock — but "inert today"
 * is a claim about the reader, and anchoring costs one expression.
 */
const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

const MANIFEST = {
	machines: {
		'claw-4': {
			cores: 8,
			$capabilities: { at: ago(5), by: 'fleet bootcamp', earned: ['node20'] },
			$health: { at: ago(4), by: 'fleet doctor', reachable: true },
		},
		'claw-6': {
			cores: 4,
			$benchmark: { at: ago(6), by: 'fleet benchmark', diskMbs: 480 },
			$measured: { at: ago(30), by: 'fleet enroll', memTotalMb: 15_872 },
		},
	},
};

function write(root, doc) {
	writeFileSync(join(root, REL), `${JSON.stringify(doc, null, 2)}\n`);
}

/** A deploy-tree fixture: a work tree with a bare `origin`, both at the manifest. */
function deployFixture(doc = MANIFEST) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-srvdrift-'));
	made.push(dir);
	const work = join(dir, 'hadoku_site');
	mkdirSync(join(work, 'scripts', 'admin'), { recursive: true });
	git(work, ['init', '-q', '-b', 'main']);
	write(work, doc);
	git(work, ['add', '-A']);
	git(work, ['commit', '-q', '-m', 'base']);
	const bare = join(dir, 'origin.git');
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: cleanGitEnv() });
	git(work, ['remote', 'add', 'origin', bare]);
	git(work, ['push', '-q', 'origin', 'HEAD:main']);
	git(work, ['fetch', '-q', 'origin', 'main']);
	return { dir, work, bare };
}

/**
 * Run the checker against a fixture. Returns {code, json}.
 *
 * `fetch: true` drops `--no-fetch`, which only the race test wants: everything
 * else is a claim about the COMPARISON and a fetch would add a moving part to
 * it for nothing.
 */
function drift(work, env = {}, { fetch = false } = {}) {
	const argv = fetch ? [SCRIPT, '--json'] : [SCRIPT, '--json', '--no-fetch'];
	const r = spawnSync(process.execPath, argv, {
		encoding: 'utf8',
		env: cleanGitEnv({ FLEET_DEPLOY_SITE_ROOT: work, ...env }),
	});
	assert.ok(
		r.stdout.trim().startsWith('{'),
		`stdout must be a JSON document before anything else: ${r.stdout}\n${r.stderr}`
	);
	return { code: r.status, json: JSON.parse(r.stdout) };
}

// ── the script, against git ──────────────────────────────────────────────────

void test('a deploy tree nobody wrote is GREEN, and says what it compared', () => {
	const { work } = deployFixture();
	const { code, json } = drift(work);
	assert.equal(code, 0);
	assert.equal(json.ok, true);
	assert.deepEqual(json.findings, []);
	assert.equal(
		json.facetsCompared,
		2,
		'two `$` facets across two machines — $capabilities and $measured. $health and ' +
			'$benchmark live in the state dir since Wave 3h and are not compared'
	);
	assert.equal(json.fetched, false, '--no-fetch must be reported, not hidden');
	assert.equal(json.headSha, json.mainSha);
});

void test('ONE facet changed on the deploy tree turns it RED as an unlanded write', () => {
	const { work } = deployFixture();
	const doc = JSON.parse(JSON.stringify(MANIFEST));
	doc.machines['claw-4'].$capabilities.earned = ['node20', 'cargo-bevy'];
	write(work, doc);

	const { code, json } = drift(work);
	assert.equal(code, 1, 'a write that will be erased is a finding, not a pass');
	assert.equal(json.ok, false);
	assert.equal(json.findings.length, 1);
	assert.equal(json.findings[0].kind, 'unlanded-write');
	assert.equal(json.findings[0].facet, 'machines.claw-4.$capabilities');
	assert.match(json.findings[0].why, /reset --hard origin\/main/);
});

void test('a facet on main the deploy has not picked up is `undeployed`, not `unlanded-write`', () => {
	// The two have OPPOSITE fixes — recover the numbers, versus fix the redeploy
	// workflow — so the kinds must not collapse into one "drift".
	const { work, bare } = deployFixture();
	const other = mkdtempSync(join(tmpdir(), 'fleet-srvdrift-other-'));
	made.push(other);
	execFileSync('git', ['clone', '-q', bare, other], { env: cleanGitEnv() });
	const doc = JSON.parse(JSON.stringify(MANIFEST));
	doc.machines['claw-6'].$measured.memTotalMb = 31_744;
	write(other, doc);
	git(other, ['commit', '-q', '-a', '-m', 'enroll: claw-6 gained a stick']);
	git(other, ['push', '-q', 'origin', 'HEAD:main']);
	git(work, ['fetch', '-q', 'origin', 'main']);

	// GRACE ZERO: the commit is seconds old, so with the default band this is a
	// deploy in flight. Zero is what proves the finding path.
	const red = drift(work, { SRV_DEPLOY_GRACE_SECONDS: '0' });
	assert.equal(red.code, 1);
	assert.equal(red.json.findings.length, 1);
	assert.equal(red.json.findings[0].kind, 'undeployed');
	assert.equal(red.json.findings[0].facet, 'machines.claw-6.$measured');
	assert.match(red.json.findings[0].why, /redeploy-mgmt-api\.yml/);

	// The SAME state inside the band is deferred, not dropped: a manifest commit
	// triggers the redeploy by path, so pausing on every correct landing is how
	// a gate gets muted.
	const green = drift(work, { SRV_DEPLOY_GRACE_SECONDS: '86400' });
	assert.equal(green.code, 0);
	assert.deepEqual(green.json.findings, []);
	assert.equal(green.json.deferred.length, 1);
	assert.equal(green.json.deferred[0].kind, 'deploy-pending');
});

/**
 * A `git` on PATH that appends a SECOND fetch to every fetch it is handed.
 *
 * THIS IS NOT A SLEEP-AND-HOPE RACE. The window the bug lives in is between the
 * gate's own `git fetch` returning and its first read, and nothing about a real
 * deploy makes that window reliably wide. So the interleaving is FORCED: the
 * shim runs the command it was asked for, then — in the same working directory,
 * before control returns to the gate — runs the fetch a deploy would have run.
 * The gate's next instruction therefore ALWAYS executes against a clobbered
 * `FETCH_HEAD`, on every host and at every speed.
 *
 * The exit code the shim reports is the REAL command's. A deploy's fetch
 * failing is not this gate's fetch failing, and folding the two together would
 * make the fixture test something other than the race.
 */
function fetchRacingGit(refspec) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-srvdrift-shim-'));
	made.push(dir);
	const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
	assert.ok(real.startsWith('/'), `need an absolute path to the real git, got ${real}`);
	const shim = join(dir, 'git');
	writeFileSync(
		shim,
		[
			'#!/bin/sh',
			`"${real}" "$@"`,
			'rc=$?',
			'case " $* " in',
			`  *" fetch "*) "${real}" fetch --quiet origin ${refspec} >/dev/null 2>&1 ;;`,
			'esac',
			'exit $rc',
			'',
		].join('\n')
	);
	chmodSync(shim, 0o755);
	return dir;
}

void test("a deploy's fetch landing between this gate's fetch and its reads does not change the answer", () => {
	// 2026-09-19 06:30Z, one failure, self-healed. `FETCH_HEAD` is ONE FILE PER
	// REPOSITORY and this gate runs in the SHARED deploy clone, so a deploy
	// fetching there between the gate's fetch and its reads hands the gate that
	// deploy's ref in place of main. Self-healing is what makes it worth a test:
	// the evidence is gone by the time anyone looks.
	const { work, bare } = deployFixture();
	const mainSha = git(work, ['rev-parse', 'HEAD']);

	// The deploy's side: a DIFFERENT manifest on a branch that is NOT main.
	// Fetching it is a legitimate thing for another process to do and it must
	// not be able to change this gate's verdict.
	const other = mkdtempSync(join(tmpdir(), 'fleet-srvdrift-deployside-'));
	made.push(other);
	execFileSync('git', ['clone', '-q', bare, other], { env: cleanGitEnv() });
	const doc = JSON.parse(JSON.stringify(MANIFEST));
	doc.machines['claw-4'].$capabilities.earned = ['node20', 'never-landed-on-main'];
	write(other, doc);
	git(other, ['commit', '-q', '-a', '-m', 'a commit that is not on main']);
	git(other, ['push', '-q', 'origin', 'HEAD:refs/heads/deploy-side']);
	const otherSha = git(other, ['rev-parse', 'HEAD']);
	assert.notEqual(otherSha, mainSha);

	// GRACE ZERO so the reverted behaviour renders as a FINDING rather than a
	// deferral: the adversary commit is seconds old and the default band would
	// swallow it, which would let the broken code exit 0 and the test pass.
	const shim = fetchRacingGit('refs/heads/deploy-side');
	const { code, json } = drift(
		work,
		{ PATH: `${shim}:${process.env.PATH}`, SRV_DEPLOY_GRACE_SECONDS: '0' },
		{ fetch: true }
	);

	// THE INTERLEAVING MUST HAVE HAPPENED. Without this the test proves nothing
	// on a host where the shim never got picked up — it would pass for the
	// reason "no race occurred", which is the shape of a green that means
	// nothing.
	assert.equal(
		git(work, ['rev-parse', 'FETCH_HEAD']),
		otherSha,
		"FETCH_HEAD in the deploy clone must carry the OTHER process's fetch — if it still " +
			'holds main, the shim never ran and this test is not testing the race'
	);

	// ONE deepEqual over the whole answer, so a failure prints the verdict AND
	// the sha that caused it. Asserting the sha alone would say what broke
	// without saying what it cost; asserting the verdict alone would say the
	// cost without naming the cause.
	assert.deepEqual(
		{
			ok: json.ok,
			findings: json.findings.length,
			deferred: json.deferred.length,
			mainSha: json.mainSha,
			headSha: json.headSha,
			facetsCompared: json.facetsCompared,
			fetched: json.fetched,
		},
		{
			ok: true,
			findings: 0,
			deferred: 0,
			mainSha,
			headSha: mainSha,
			facetsCompared: 2,
			fetched: true,
		},
		`another process's fetch must move none of it: ${JSON.stringify(json.findings)}`
	);
	assert.equal(code, 0);
});

void test('a manifest with ZERO `$` facets FAILS — it is a gate that could not look', () => {
	const { work } = deployFixture({ machines: { 'claw-4': { cores: 8 } } });
	const { code, json } = drift(work);
	assert.equal(code, 1);
	assert.equal(json.ok, false);
	assert.equal(json.facetsCompared, 0);
	assert.match(json.error, /ZERO `\$` facets/);
	assert.deepEqual(json.findings, [], 'the failure is in `error`, not disguised as a finding');
});

void test('a deploy root that does not exist FAILS, with its own reason', () => {
	const { code, json } = drift(join(tmpdir(), 'fleet-srvdrift-absent-does-not-exist'));
	assert.equal(code, 1);
	assert.match(json.error, /does not exist/);
});

void test('a deploy root that is not a git checkout FAILS, with a different reason', () => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-srvdrift-plain-'));
	made.push(dir);
	mkdirSync(join(dir, 'scripts', 'admin'), { recursive: true });
	write(dir, MANIFEST);
	const { code, json } = drift(dir);
	assert.equal(code, 1);
	assert.match(json.error, /not a git working tree/);
});

// ── the judging rules, in isolation ──────────────────────────────────────────

void test('`facets` finds every `$` key and nothing else', () => {
	assert.deepEqual(
		[...facets(MANIFEST).keys()],
		['machines.claw-4.$capabilities', 'machines.claw-6.$measured']
	);
	// A facet nobody has invented yet is covered by the PREFIX, which is the
	// point — naming the supply facets would go stale silently, in the
	// direction of reporting clean.
	const withNew = { machines: { 'claw-9': { $whatever: { at: 'x' } } } };
	assert.deepEqual([...facets(withNew).keys()], ['machines.claw-9.$whatever']);
});

void test('key ORDER is not drift — two writers produce the same facet differently', () => {
	// `enroll --update` assigns named fields onto an existing entry while a fresh
	// enroll builds an object literal. A plain JSON.stringify comparison scores
	// that as a finding, and a gate that cries wolf on a correct landing is one
	// an operator learns to skip.
	assert.equal(stable({ a: 1, b: 2 }), stable({ b: 2, a: 1 }));
	const left = { machines: { n: { $x: { at: '1', by: 'w' } } } };
	const right = { machines: { n: { $x: { by: 'w', at: '1' } } } };
	assert.deepEqual(facetDiff(left, right), []);
});

void test('an absent facet on one side is reported with the side it is missing from', () => {
	const left = { machines: { n: { $x: { at: '1' } } } };
	const right = { machines: { n: {} } };
	assert.deepEqual(facetDiff(left, right), [
		{ facet: 'machines.n.$x', state: 'only-left', leftAt: '1', rightAt: null },
	]);
	assert.equal(facetDiff(right, left)[0].state, 'only-right');
});

void test('an UNKNOWN main age denies the grace rather than granting it', () => {
	// `null` means the commit date could not be read. Granting a deferral on
	// that would make the gate EASIER to pass the less it knows, which is the
	// exact inversion CLAUDE.md forbids.
	const head = { machines: { n: { $x: { at: '1' } } } };
	const origin = { machines: { n: { $x: { at: '2' } } } };
	const v = srvDriftVerdict({
		working: head,
		head,
		origin,
		mainAgeSeconds: null,
		graceSeconds: 86_400,
	});
	assert.equal(v.ok, false);
	assert.equal(v.findings[0].kind, 'undeployed');
	assert.deepEqual(v.deferred, []);
});

void test('an unlanded write gets NO grace at any age — it is already lost', () => {
	const working = { machines: { n: { $x: { at: '2' } } } };
	const head = { machines: { n: { $x: { at: '1' } } } };
	const v = srvDriftVerdict({
		working,
		head,
		origin: head,
		mainAgeSeconds: 1,
		graceSeconds: 86_400,
	});
	assert.equal(v.ok, false);
	assert.equal(v.findings.length, 1);
	assert.equal(v.findings[0].kind, 'unlanded-write');
	assert.deepEqual(v.deferred, []);
});

// ── the facets that moved to the state dir (Wave 3h; $proof added wave 4e) ───

void test('the moved set is EXACTLY $benchmark, $health and $proof — named, from measured.ts', () => {
	// The exclusion is the only place this gate names facets, so it is pinned by
	// name: a third (now fourth) facet quietly added to it is a facet that
	// stopped being guarded, and one removed would page on the manifest edit
	// that strips it. `$proof` (wave 4e, #102) joined `MEASURED_FACETS` as a
	// state-dir-only facet that never lived in the manifest at all — see
	// `src/lib/measured.ts`'s own doc on why it is listed here anyway.
	assert.deepEqual([...MOVED_FACETS].sort(), ['$benchmark', '$health', '$proof']);
});

void test('a deploy tree that differs ONLY in $health / $benchmark is GREEN — they are not its record', () => {
	// Before Wave 3h this was an unlanded write: `fleet doctor --write` from ~/srv
	// changed the manifest there and the next publish erased it. Those writes now
	// land in `<stateDir>/health.json` and `benchmark.json`, which nothing resets,
	// so the manifest's copies are a field no reader is served from once the
	// state file exists, and the by-hand edit that strips them must not page.
	const { work } = deployFixture();
	const doc = JSON.parse(JSON.stringify(MANIFEST));
	doc.machines['claw-4'].$health.reachable = false;
	delete doc.machines['claw-6'].$benchmark;
	write(work, doc);
	const { code, json } = drift(work);
	assert.equal(code, 0, JSON.stringify(json.findings));
	assert.deepEqual(json.findings, []);
	assert.equal(json.facetsCompared, 2);
});
