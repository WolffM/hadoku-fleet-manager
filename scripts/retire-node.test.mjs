/**
 * `fleet retire` composes drain + the reconciler's removal path + manifestEdit
 * + a facet archive into one command (refactor plan §5.3 scenario R3,
 * `docs/runbooks/retire-node.md`). These tests run the REAL script against a
 * throwaway git checkout (manifestEdit's write target) and a throwaway state
 * dir, with `ssh`/`gh` stand-ins on PATH — never a real node, never real
 * GitHub, and `--no-push` keeps every write local.
 *
 * The properties pinned below:
 *   - a dry run (no `--confirm`) never writes anything, whatever state the
 *     node is in;
 *   - a node that is not yet quiet is refused, and `--confirm` drains it
 *     (once, never twice) rather than deregistering anything;
 *   - deregistration happens over EVERY registration the node holds, not
 *     only a warm/JIT one, and a failure there stops before the manifest is
 *     touched;
 *   - the manifest edit and the retired-name ledger land in one write, with
 *     exact bytes;
 *   - a measured facet is copied into the archive and removed from the live
 *     file, in that order;
 *   - a hosting node, an undeclared name and an already-retired
 *     name are each refused for their own stated reason.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';
import { cleanGitEnv } from './lib/test-git-identity.mjs';

afterEach(cleanupTempDirs);

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'retire-node.mjs');

/** `git` in `dir`, with every `GIT_*` stripped — see {@link cleanGitEnv}. */
function git(dir, args) {
	const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: cleanGitEnv() });
	assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

/**
 * A manifest dir (a git checkout, so `manifestEdit`'s write target accepts
 * it), a coverage file, a state dir, and `ssh`/`gh` stand-ins on PATH.
 *
 * `runners`: the gh stub's canned `actions/runners` listing for every repo
 * in `coverage` (the fixtures below only ever need one repo). `busy`: the
 * ssh stub's canned `pgrep` count. `sshUnreachable`: the ssh stub exits 255
 * instead of answering anything — "could not look". `deregisterFails`:
 * the removeScript stand-in (piped over stdin, so NOT the pgrep probe) exits
 * 6 with `DEREGISTER_FAILED`, same as a real `config.sh remove` refusal.
 */
function fixture({
	machines,
	retired,
	coverage = ['WolffM/demo'],
	runners = [],
	busy = 0,
	sshUnreachable = false,
	deregisterFails = false,
} = {}) {
	const dir = tempDir('retire-node-');
	git(dir, ['init', '-q', '-b', 'main']);
	writeFileSync(
		join(dir, 'fleet-runner-manifest.json'),
		JSON.stringify({ machines, ...(retired ? { retired } : {}) }, null, 2)
	);
	writeFileSync(
		join(dir, 'fleet-runner-coverage.json'),
		JSON.stringify({ repos: coverage, facets: {} }, null, 2)
	);
	git(dir, ['add', '-A']);
	git(dir, ['commit', '-q', '-m', 'base']);

	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const touched = join(dir, 'touched.log');
	writeFileSync(
		join(bin, 'ssh'),
		sshUnreachable
			? `#!/bin/sh\necho "ssh $*" >> "${touched}"\nexit 255\n`
			: [
					'#!/bin/sh',
					`echo "ssh $*" >> "${touched}"`,
					'for a in "$@"; do',
					'  case "$a" in',
					`    *pgrep*) echo "${busy}"; exit 0 ;;`,
					'  esac',
					'done',
					'# otherwise the removeScript shell is piped on stdin',
					'cat >/dev/null',
					deregisterFails
						? 'echo "DEREGISTER_FAILED: still registered (DIR=~/runners/x)" >&2\nexit 6'
						: 'exit 0',
					'',
				].join('\n')
	);
	chmodSync(join(bin, 'ssh'), 0o755);
	writeFileSync(
		join(bin, 'gh'),
		[
			'#!/bin/sh',
			// Drain the request body ghWrite pipes in (`--input -`) before
			// answering: exiting unread races the writer into EPIPE, which
			// replaces the failure under test with a different one. Only then:
			// other calls leave stdin open, and cat would block until timeout.
			'case "$*" in *"--input -"*) cat >/dev/null ;; esac',
			`echo "gh $*" >> "${touched}"`,
			'case "$*" in',
			`  *"actions/runners --paginate"*) echo '${JSON.stringify({ total_count: runners.length, runners })}'; exit 0 ;;`,
			'  *"remove-token"*) echo FAKETOKEN; exit 0 ;;',
			'  *"-X DELETE"*"/actions/runners/"*) exit 0 ;;',
			'  *) exit 1 ;;',
			'esac',
		].join('\n')
	);
	chmodSync(join(bin, 'gh'), 0o755);

	const state = join(dir, 'state');
	mkdirSync(state);
	return { dir, bin, state, touched };
}

function seedDrain(fx, record) {
	writeFileSync(
		join(fx.state, 'fleet-drain.json'),
		JSON.stringify({ nodes: record ? { 'claw-fixture': record } : {}, planned: [] })
	);
}

function run(fx, argv) {
	return spawnSync(process.execPath, [SCRIPT, ...argv], {
		encoding: 'utf8',
		timeout: 30_000,
		env: cleanGitEnv({
			PATH: `${fx.bin}:${process.env.PATH}`,
			FLEET_MANIFEST_DIR: fx.dir,
			HADOKU_STATE_DIR: fx.state,
		}),
	});
}

const readManifest = (fx) =>
	JSON.parse(readFileSync(join(fx.dir, 'fleet-runner-manifest.json'), 'utf8'));
const readTouched = (fx) => (existsSync(fx.touched) ? readFileSync(fx.touched, 'utf8') : '');
const readDrainState = (fx) => {
	const p = join(fx.state, 'fleet-drain.json');
	return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const readArchive = (fx) => {
	const p = join(fx.state, 'retired-facets.json');
	return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

const CLAW_FIXTURE = { 'claw-fixture': { role: 'claw', maxConcurrent: 2, labels: [] } };

// ── argv ─────────────────────────────────────────────────────────────────

test('an unknown flag exits 2 and touches nothing — never reaches the manifest or a node', () => {
	const fx = fixture({ machines: CLAW_FIXTURE });
	const before = readManifest(fx);
	const r = run(fx, ['claw-fixture', '--not-a-real-flag']);
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.match(r.stdout + r.stderr, /unknown flag\(s\) --not-a-real-flag/);
	assert.equal(readTouched(fx), '', 'no ssh/gh call before the argv gate');
	assert.deepEqual(readManifest(fx), before);
});

test('no node named exits 1 with a usage error', () => {
	const fx = fixture({ machines: CLAW_FIXTURE });
	const r = run(fx, []);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout + r.stderr, /name a node/);
});

// ── preconditions, refused before any probe ─────────────────────────────

test('a node neither declared nor on the ledger is refused, and nothing is touched', () => {
	const fx = fixture({ machines: CLAW_FIXTURE });
	const r = run(fx, ['claw-404', '--confirm', '--json']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const out = JSON.parse(r.stdout);
	assert.equal(out.ok, false);
	assert.match(out.error, /not declared .* and is not on the retired-name ledger/);
	assert.equal(readTouched(fx), '');
});

test('an already-retired name (ledger only, no machine entry) is a no-op success', () => {
	const fx = fixture({ machines: {}, retired: ['claw-fixture'] });
	const r = run(fx, ['claw-fixture', '--confirm', '--json']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const out = JSON.parse(r.stdout);
	assert.deepEqual(out, { ok: true, node: 'claw-fixture', alreadyRetired: true });
	assert.equal(readTouched(fx), '', 'an already-retired node is never probed');
});

test('a name BOTH declared and on the ledger is an inconsistency, refused rather than guessed', () => {
	const fx = fixture({ machines: CLAW_FIXTURE, retired: ['claw-fixture'] });
	const r = run(fx, ['claw-fixture', '--confirm', '--json']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(JSON.parse(r.stdout).error, /BOTH declared .* AND on the retired-name ledger/);
});

test('a HOSTING node is refused with a pointer to `fleet hosting --end`', () => {
	const fx = fixture({ machines: CLAW_FIXTURE });
	seedDrain(fx, {
		since: new Date().toISOString(),
		kind: 'hosting',
		reason: 'cardtable forge',
		by: 'test',
	});
	const r = run(fx, ['claw-fixture', '--confirm', '--json']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const out = JSON.parse(r.stdout);
	assert.equal(out.hosting, true);
	assert.match(out.error, /fleet hosting claw-fixture --end/);
	assert.deepEqual(readManifest(fx), { machines: CLAW_FIXTURE });
});

// ── dry run: always a plan, never a write ───────────────────────────────

test('dry run on a busy, undrained node: refuses, writes NOTHING, and does not even call gh', () => {
	const fx = fixture({ machines: CLAW_FIXTURE, busy: 3 });
	const r = run(fx, ['claw-fixture', '--json']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const out = JSON.parse(r.stdout);
	assert.equal(out.ok, false);
	assert.equal(out.confirmed, false);
	assert.equal(out.step, 'drain');
	assert.equal(readDrainState(fx), null, 'a dry run never drains');
	assert.deepEqual(readManifest(fx), { machines: CLAW_FIXTURE });
});

test('dry run on a quiet node with a standing registration: lists the plan, still exits 1, writes nothing', () => {
	const fx = fixture({
		machines: CLAW_FIXTURE,
		runners: [{ id: 42, name: 'claw-fixture', labels: [] }],
	});
	seedDrain(fx, { since: new Date().toISOString(), kind: 'maintenance', reason: 'x', by: 't' });
	const r = run(fx, ['claw-fixture', '--json']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const out = JSON.parse(r.stdout);
	assert.equal(out.step, 'plan');
	assert.equal(out.verdict, 'drained');
	assert.deepEqual(out.registrations, [{ repo: 'WolffM/demo', id: 42, name: 'claw-fixture' }]);
	assert.deepEqual(readManifest(fx), { machines: CLAW_FIXTURE });
	assert.ok(!/remove-token/.test(readTouched(fx)), 'a dry run never mints a removal token');
});

// ── --confirm: the drain step ────────────────────────────────────────────

test('--confirm on an undrained, unreachable node DRAINS it exactly once, then refuses to go further', () => {
	const fx = fixture({ machines: CLAW_FIXTURE, sshUnreachable: true });
	const r1 = run(fx, ['claw-fixture', '--confirm', '--no-push', '--json']);
	assert.equal(r1.status, 1, r1.stdout + r1.stderr);
	const out1 = JSON.parse(r1.stdout);
	assert.equal(out1.step, 'drain');
	assert.equal(out1.drainedNow, true);
	const drain1 = readDrainState(fx);
	assert.equal(drain1.nodes['claw-fixture'].kind, 'maintenance');
	assert.equal(drain1.nodes['claw-fixture'].reason, 'retiring — see docs/runbooks/retire-node.md');
	assert.deepEqual(
		readManifest(fx),
		{ machines: CLAW_FIXTURE },
		'a refused drain-only run never touches the manifest'
	);

	// Run again: it must NOT drain a second time.
	const r2 = run(fx, ['claw-fixture', '--confirm', '--no-push', '--json']);
	assert.equal(r2.status, 1, r2.stdout + r2.stderr);
	const out2 = JSON.parse(r2.stdout);
	assert.equal(out2.drainedNow, false, 'a node already draining must not be drained again');
	assert.deepEqual(readDrainState(fx), drain1, 'the existing drain record is untouched');
});

test('a custom --reason is used for the drain this run writes', () => {
	const fx = fixture({ machines: CLAW_FIXTURE, sshUnreachable: true });
	run(fx, ['claw-fixture', '--confirm', '--no-push', '--reason', 'psu failure']);
	assert.equal(readDrainState(fx).nodes['claw-fixture'].reason, 'psu failure');
});

test('a FRESH maintenance drain on an unreachable node stays blocked — it might still come back', () => {
	const fx = fixture({ machines: CLAW_FIXTURE, sshUnreachable: true });
	seedDrain(fx, {
		since: new Date().toISOString(),
		kind: 'maintenance',
		reason: 'reseat RAM',
		by: 't',
	});
	const r = run(fx, ['claw-fixture', '--confirm', '--no-push', '--json']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.equal(JSON.parse(r.stdout).step, 'drain');
	assert.deepEqual(readManifest(fx), { machines: CLAW_FIXTURE });
});

test('dead hardware: a node drained for maintenance and unreachable past the deferral window IS retireable', () => {
	// The primary case this command exists for (per its own header and the
	// runbook: "use this when hardware dies"). ssh will NEVER answer a dead
	// box, so `fleet retire` must not get stuck at "unknown" forever once the
	// drain has sat unanswered well past a normal maintenance window.
	const fx = fixture({ machines: CLAW_FIXTURE, sshUnreachable: true, runners: [] });
	seedDrain(fx, {
		since: new Date(Date.now() - 10 * 86_400_000).toISOString(),
		kind: 'maintenance',
		reason: 'psu failure, confirmed dead via journalctl --list-boots',
		by: 't',
	});
	const r = run(fx, ['claw-fixture', '--confirm', '--no-push', '--json']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.deepEqual(readManifest(fx), { machines: {}, retired: ['claw-fixture'] });
});

// ── --confirm: deregister, manifest + ledger, facet archive ────────────

test('--confirm on a quiet node deregisters every registration, edits the manifest and ledger in one write, and archives facets', () => {
	const fx = fixture({
		machines: CLAW_FIXTURE,
		runners: [{ id: 42, name: 'claw-fixture', labels: [] }],
	});
	seedDrain(fx, { since: new Date().toISOString(), kind: 'maintenance', reason: 'x', by: 't' });
	// Not an absolute date: `recordProblem` only needs SOME parseable `at`, and
	// a fixed literal here would be exactly the "fixture pinned to a calendar
	// date" trap `fixture-clock-guard.test.mjs` exists to catch.
	const healthAt = new Date(Date.now() - 86_400_000).toISOString();
	writeFileSync(
		join(fx.state, 'health.json'),
		JSON.stringify({
			nodes: { 'claw-fixture': { at: healthAt, by: 'fleet doctor', reachable: true } },
		})
	);

	const r = run(fx, ['claw-fixture', '--confirm', '--no-push', '--json']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const out = JSON.parse(r.stdout);
	assert.equal(out.ok, true);
	assert.deepEqual(out.removed, [{ repo: 'WolffM/demo', name: 'claw-fixture', byId: false }]);
	assert.deepEqual(out.failed ?? [], []);

	// THE MANIFEST + LEDGER, EXACT BYTES — one write removed the machine and
	// added the name, nothing else changed.
	assert.deepEqual(readManifest(fx), { machines: {}, retired: ['claw-fixture'] });

	// FACETS: copied into the archive, removed from the live file.
	assert.deepEqual(JSON.parse(readFileSync(join(fx.state, 'health.json'), 'utf8')), { nodes: {} });
	const archive = readArchive(fx);
	assert.ok(archive.nodes['claw-fixture'], 'the archive must hold claw-fixture');
	assert.deepEqual(archive.nodes['claw-fixture'].facets.health, {
		'claw-fixture': { at: healthAt, by: 'fleet doctor', reachable: true },
	});
});

test('--confirm with multiple registrations across repos removes every one', () => {
	const fx = fixture({
		machines: CLAW_FIXTURE,
		coverage: ['WolffM/demo', 'WolffM/other'],
		runners: [{ id: 1, name: 'claw-fixture', labels: [] }],
	});
	// The gh stub above answers every repo identically (one runner named
	// claw-fixture), so BOTH repos report a registration for this node.
	seedDrain(fx, { since: new Date().toISOString(), kind: 'maintenance', reason: 'x', by: 't' });
	const r = run(fx, ['claw-fixture', '--confirm', '--no-push', '--json']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const out = JSON.parse(r.stdout);
	assert.equal(out.removed.length, 2);
	assert.deepEqual(out.removed.map((x) => x.repo).sort(), ['WolffM/demo', 'WolffM/other']);
});

test('--confirm on an already-quiet node with NO registrations still retires it', () => {
	const fx = fixture({ machines: CLAW_FIXTURE, runners: [] });
	seedDrain(fx, { since: new Date().toISOString(), kind: 'maintenance', reason: 'x', by: 't' });
	const r = run(fx, ['claw-fixture', '--confirm', '--no-push', '--json']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.deepEqual(readManifest(fx), { machines: {}, retired: ['claw-fixture'] });
});

test('a deregistration failure STOPS before the manifest edit — nothing retired, failure named', () => {
	const fx = fixture({
		machines: CLAW_FIXTURE,
		runners: [{ id: 42, name: 'claw-fixture', labels: [] }],
		deregisterFails: true,
	});
	seedDrain(fx, { since: new Date().toISOString(), kind: 'maintenance', reason: 'x', by: 't' });
	const r = run(fx, ['claw-fixture', '--confirm', '--no-push', '--json']);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const out = JSON.parse(r.stdout);
	assert.equal(out.step, 'deregister');
	assert.equal(out.failed.length, 1);
	assert.match(out.failed[0].error, /DEREGISTER_FAILED|still registered/);
	assert.deepEqual(
		readManifest(fx),
		{ machines: CLAW_FIXTURE },
		'the manifest must be untouched on a failed dereg'
	);
});

test('retiring a node already appended to an existing retired[] list keeps the earlier names, sorted', () => {
	const fx = fixture({
		machines: { ...CLAW_FIXTURE, 'claw-2': { role: 'claw' } },
		retired: ['claw-11', 'claw-3'],
	});
	seedDrain(fx, { since: new Date().toISOString(), kind: 'maintenance', reason: 'x', by: 't' });
	const r = run(fx, ['claw-fixture', '--confirm', '--no-push', '--json']);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const m = readManifest(fx);
	assert.deepEqual(m.retired, ['claw-11', 'claw-3', 'claw-fixture'].sort());
	assert.deepEqual(Object.keys(m.machines), ['claw-2']);
});

// ── enroll's refusal (the other half of the ledger) ─────────────────────

test('fleet enroll refuses a retired name before it probes anything', async () => {
	const ENROLL = join(dirname(SCRIPT), 'enroll-node.mjs');
	const fx = fixture({ machines: {}, retired: ['claw-fixture'] });
	const r = spawnSync(process.execPath, [ENROLL, 'claw-fixture', '--stdin', '--json'], {
		encoding: 'utf8',
		input: '',
		env: cleanGitEnv({ PATH: `${fx.bin}:${process.env.PATH}`, FLEET_MANIFEST_DIR: fx.dir }),
	});
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const out = JSON.parse(r.stdout);
	assert.equal(out.retired, true);
	assert.match(out.error, /RETIRED node name/);
	assert.equal(readTouched(fx), '', 'enroll must refuse before it ever sshes the box');
});

test('fleet enroll proceeds normally for a fresh, unretired name', () => {
	const ENROLL = join(dirname(SCRIPT), 'enroll-node.mjs');
	const fx = fixture({ machines: {}, retired: ['claw-3'] });
	const r = spawnSync(process.execPath, [ENROLL, 'claw-fixture', '--stdin', '--json'], {
		encoding: 'utf8',
		input: '',
		env: cleanGitEnv({ PATH: `${fx.bin}:${process.env.PATH}`, FLEET_MANIFEST_DIR: fx.dir }),
	});
	// No bootstrap record on stdin, so this fails for an UNRELATED reason
	// (EnrollmentRecordError) — the point here is only that it is NOT refused
	// for being retired.
	const out = JSON.parse(r.stdout);
	assert.notEqual(out.retired, true);
});
