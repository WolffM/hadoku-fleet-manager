/**
 * Every edit of the fleet manifest goes through `manifestEdit`
 * (`scripts/lib/manifest-edit.mjs`, wave 5c F4), and the SET of callers is
 * named here rather than counted.
 *
 * WHY (#12, H's finding after it, and 5c's consolidation)
 * ---------------------------------------------------------
 * `fleet-runner-manifest.json` is operator config that lives in hadoku_site's
 * checkout, and hadoku_site's prettier (`printWidth: 100`) keeps a short array
 * inline. `JSON.stringify(doc, null, 2)` expands every one of them, so a write
 * that changed twenty lines of measurements produced a 213-line diff and left
 * that checkout failing its own `format:check`. #12 fixed ONE writer
 * (`fleet benchmark --write`); by wave 5c FOUR MORE still re-serialised the
 * file by hand, each individually correct about the facet it wrote and each
 * drifted from the other three in some other way (see `manifestEdit`'s own
 * header for the divergence table). Consolidating them into one function
 * closes that whole class of drift rather than fixing it four times.
 *
 * THE LIST IS STILL THE DECLARATION. `json-contract.mjs` carried a bare count
 * of the jobs under contract and was wrong twice; a count of manifest writers
 * would fail the same way, silently, the moment a fifth appeared or one was
 * renamed. So {@link WRITERS} names them, and the discovery scan below must
 * agree with it exactly in both directions: an unlisted caller FAILS, and a
 * listed one that has stopped calling `manifestEdit` FAILS too.
 *
 * COMMENTS ARE BLANKED FIRST. Every file involved here quotes the broken form
 * in its own prose — including the paragraph you are reading, which names
 * `JSON.stringify(doc, null, 2)` twice. This repo has read a COMMENT as
 * evidence three separate times; a rule about source must never be satisfiable
 * by writing about it.
 *
 * TEST FILES ARE OUT OF SCOPE, deliberately. A test that writes a fixture
 * manifest into a temp dir is not writing the fleet's manifest, and the
 * formatting of a file that exists for one assertion is nobody's diff.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';
import { formatEnrollmentRecord } from './enrollment-record.mjs';
import { fixtureIdentityEnv } from './test-git-identity.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * THE WRITERS OF `fleet-runner-manifest.json`, by the facet each records.
 *
 * ONE TRANSACTIONAL EDITOR SINCE WAVE 5c (plan §4.1 F4, lane B).
 * `scripts/lib/manifest-edit.mjs`'s `manifestEdit` is now the only place that
 * asks `writeTarget`, reads fresh, renders through `renderJson`, writes
 * ATOMICALLY (`writeFileAtomic`) and lands through `landWrite` — every writer
 * below calls it instead of re-implementing those steps by hand. Before this
 * wave there were FOUR separate copies (5b's one-writer guard counted them at
 * `scripts/bootcamp.mjs:1208-1371`, `scripts/enroll-node.mjs:849-979`,
 * `scripts/lan-reserve.mjs:131-149` and `scripts/provision-fleet.mjs:447-650`),
 * and they had already drifted: `provision-fleet.mjs` and `lan-reserve.mjs`
 * wrote with a bare `writeFileSync` (no atomicity at all — F3-non-atomic
 * debt), the refusal/landing prose differed line by line though the manifest
 * is the same file, and only three of the four restored a `.bak` on a
 * read-back mismatch (`manifestEdit` replaces the `.bak` entirely — the
 * atomic rename IS the crash safety now; see `manifest-edit.mjs`'s header).
 *
 * `scripts/node-users-cutover.mjs` (`users.ci + containers` — `fleet
 * node-users --cutover <node> --confirm`) is STILL ON THE OLD DIRECT PATTERN,
 * deliberately: wave 5c's lane B owns exactly the four files above, and
 * node-users-cutover.mjs belongs to a different, concurrent lane ("d3").
 * {@link LEGACY_DIRECT_WRITER} names it so a scan that finds a fifth direct
 * caller of `writeTarget`/`landWrite` is not mistaken for a stray — removing
 * it from this list is that lane's call, not this file's.
 *
 * THE LIST IS STILL THE DECLARATION, not a count — `json-contract.mjs`
 * carried a bare count of the jobs under contract and was wrong twice.
 * {@link WRITERS} names `manifestEdit`'s callers; the discovery scan below
 * must agree with it exactly in both directions: an unlisted caller FAILS,
 * and a listed one that has stopped calling `manifestEdit` FAILS too.
 */
const WRITERS = [
	{ file: 'scripts/bootcamp.mjs', facet: '$capabilities — `fleet bootcamp --write`' },
	{ file: 'scripts/enroll-node.mjs', facet: '$measured — `fleet enroll --write`' },
	{ file: 'scripts/lan-reserve.mjs', facet: 'lan — `fleet lan-reserve <node> --write`' },
	{
		file: 'scripts/lib/provision-phases.mjs',
		facet: 'placement + ephemeral — `fleet provision --machine <node> --confirm`',
	},
];

/** The one caller still on the old direct pattern — a different lane's file; see {@link WRITERS}'s header. */
const LEGACY_DIRECT_WRITER = {
	file: 'scripts/node-users-cutover.mjs',
	facet: 'users.ci + containers — `fleet node-users --cutover <node> --confirm`',
};

/** `scripts/lib/manifest-edit.mjs` itself, the one place `manifestEdit` is DEFINED rather than called. */
const MANIFEST_EDIT_FILE = 'scripts/lib/manifest-edit.mjs';

/**
 * The writers of the two STATE-DIR facets. They call `writeFacet` and nothing
 * from `lib/manifest-target.mjs`: the state dir is not a checkout, so there is
 * no commit to land and no deploy tree to refuse.
 */
const STATE_WRITERS = [
	{ file: 'scripts/benchmark-fleet.mjs', facet: 'benchmark — `fleet benchmark --write`' },
	{ file: 'scripts/lib/doctor-run.mjs', facet: 'health — `fleet doctor --write`' },
];

function sources(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry === 'dist') continue;
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) {
			sources(p, out);
			continue;
		}
		if (/\.(ts|mjs)$/.test(entry) && !/\.test\.(ts|mjs)$/.test(entry)) out.push(p);
	}
	return out;
}

void test('fleet-runner-manifest.json is edited by EXACTLY these callers of manifestEdit', () => {
	assert.deepEqual(
		// `callersOf` (below) also matches a function's own DEFINITION, since
		// `function manifestEdit(` is textually indistinguishable from a call
		// by this regex — excluded here the same way `writeTarget`'s own
		// definition file is excluded from ITS callers, below.
		callersOf('manifestEdit').filter((f) => f !== MANIFEST_EDIT_FILE),
		WRITERS.map((w) => w.file).sort(),
		'a caller of manifestEdit appeared, moved, or stopped calling it. Add or remove it in ' +
			'WRITERS in this file — manifestEdit (scripts/lib/manifest-edit.mjs) is the only place ' +
			'that renders, writes atomically and lands a manifest edit, so a caller of it is a ' +
			'writer of the manifest by definition.'
	);
});

void test('writeTarget, landWrite and renderJson are called by manifestEdit and the one legacy direct writer — nothing else', () => {
	const expected = [MANIFEST_EDIT_FILE, LEGACY_DIRECT_WRITER.file].sort();
	assert.deepEqual(
		callersOf('writeTarget'),
		expected,
		'every manifest edit must ask writeTarget before writing (the deploy-tree refusal), and ' +
			'nothing that writes the STATE DIR may — a state-dir write needs no commit. Since wave ' +
			"5c that is manifestEdit alone, plus node-users-cutover.mjs (a different lane's file, " +
			'still on the old direct pattern).'
	);
	assert.deepEqual(callersOf('landWrite'), expected);
	assert.deepEqual(
		// `renderJson`'s own definition file (`prettier-json.mjs`) matches the
		// same way a function's definition always does — excluded for the same
		// reason `manifestEdit`'s is, above.
		callersOf('renderJson').filter((f) => f !== 'scripts/lib/prettier-json.mjs'),
		expected,
		"renderJson (#12 — the owning repo's own prettier, never a hand-rolled JSON.stringify) " +
			'must be asked by exactly the same two places that ask writeTarget and landWrite — a ' +
			'manifest write that renders through one and not the others is the same bug with an ' +
			'extra step.'
	);
});

// ── WHO LANDS A COMMIT, AND WHO DOES NOT (Wave 3h) ───────────────────────────
//
// `lib/manifest-target.mjs`'s `deploy-tree` refusal exists because a manifest
// write into `~/srv/hadoku_site` reads back true and is erased by the next
// publish. It no longer applies to `benchmark --write` and `doctor --write`,
// whose facets moved to the state dir — and it MUST still apply to `bootcamp`
// and `enroll`, whose facets stayed. Both halves are pinned here, once by the
// source (the callers of `writeTarget`, named, both directions) and once by
// running each writer against a fixture that IS a deploy root.

/** Non-test sources whose code (comments blanked) calls `name(`. */
/** Every non-test source, comments blanked — read ONCE; blanking is the slow part. */
let blankedCache = null;
function blankedSources() {
	blankedCache ??= ['src', 'scripts'].flatMap((root) =>
		sources(join(ROOT, root)).map((abs) => ({
			file: relative(ROOT, abs).replaceAll('\\', '/'),
			src: blankComments(readFileSync(abs, 'utf8')),
		}))
	);
	return blankedCache;
}

function callersOf(name) {
	const found = blankedSources()
		.filter(({ src }) => new RegExp(String.raw`(?<![\w$.])${name}\(`).test(src))
		.map(({ file }) => file);
	// The definitions are not callers.
	return found
		.filter((f) => f !== 'scripts/lib/manifest-target.mjs' && f !== 'src/lib/measured.ts')
		.sort();
}

void test('the state-dir facets are written by EXACTLY benchmark and doctor, through writeFacet', () => {
	assert.deepEqual(
		callersOf('writeFacet'),
		STATE_WRITERS.map((w) => w.file).sort(),
		'a writer of <stateDir>/benchmark.json or health.json appeared or moved'
	);
});

/**
 * Every `GIT_*` stripped — a hook's GIT_DIR overrides cwd. See manifest-target.mjs.
 *
 * Then the FIXTURE IDENTITY put back, in `GIT_AUTHOR_*`/`GIT_COMMITTER_*`. The
 * order matters and is the whole reason `fixtureIdentityEnv` is separate from
 * `cleanGitEnv`: the identity travels in variables that start with `GIT_`, so a
 * strip applied after the merge would eat it. This fixture cannot use
 * `cleanGitEnv` directly because it drops two FLEET_* variables as well.
 */
function cleanEnv(extra) {
	const env = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (k.startsWith('GIT_')) continue;
		if (k === 'FLEET_MANIFEST_DIR' || k === 'HADOKU_STATE_DIR') continue;
		env[k] = v;
	}
	return { ...env, ...fixtureIdentityEnv(), ...extra };
}

/**
 * A manifest dir that is a clean, committed git checkout AND a declared deploy
 * root (`FLEET_DEPLOY_ROOTS`) — the shape of `~/srv/hadoku_site/scripts/admin`,
 * in a temp dir. `ssh` is shadowed (consume stdin, fail: an unreachable node),
 * so nothing here can reach a machine.
 *
 * NO `git config` HERE. The identity comes from `cleanEnv`, in the environment.
 * The old reasoning — the config write runs with `cwd` inside the fixture and
 * only after `git init` there succeeded, so it can only ever touch the
 * fixture's own `.git/config` — is exactly the argument that failed: `cwd` is
 * not what decides which config file a write lands in, and 38 commits on
 * `origin/main` between 09-15 and 09-18 are authored `fleet test
 * <fleet-test@invalid>` by a sibling fixture that reasoned the same way.
 */
function deployRootFixture(machines) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-writers-deploy-'));
	const mdir = join(dir, 'admin');
	const state = join(dir, 'state');
	const bin = join(dir, 'bin');
	for (const d of [mdir, state, bin]) mkdirSync(d);
	writeFileSync(
		join(mdir, 'fleet-runner-manifest.json'),
		`${JSON.stringify({ toolchain: { capabilities: [] }, machines }, null, 2)}\n`
	);
	const git = (args) => execFileSync('git', args, { cwd: mdir, env: cleanEnv(), stdio: 'pipe' });
	git(['init', '-q', '-b', 'main']);
	git(['add', '-A']);
	git(['commit', '-q', '-m', 'base']);
	writeFileSync(join(bin, 'ssh'), '#!/bin/sh\ncat >/dev/null\nexit 255\n', { mode: 0o755 });
	const env = cleanEnv({
		PATH: `${bin}:${process.env.PATH ?? ''}`,
		FLEET_MANIFEST_DIR: mdir,
		HADOKU_STATE_DIR: state,
		FLEET_DEPLOY_ROOTS: mdir,
		FLEET_NO_BANNER: '1',
		HADOKU_SITE_ROOT: '/nonexistent-fleet-site',
		REPOS_DIR: '/nonexistent-fleet-repos',
	});
	const manifestBytes = () => readFileSync(join(mdir, 'fleet-runner-manifest.json'), 'utf8');
	return { dir, mdir, state, env, manifestBytes };
}

const run = (script, argv, env, input) =>
	spawnSync(process.execPath, [join(ROOT, script), ...argv], {
		env,
		encoding: 'utf8',
		input,
		timeout: 120_000,
	});

void test('HALF 1: bootcamp --write inside a deploy root is REFUSED, and writes nothing', () => {
	const fx = deployRootFixture({ 'writers-test-node.invalid': { cores: 4 } });
	try {
		const before = fx.manifestBytes();
		const r = run('scripts/bootcamp.mjs', ['--write', '--no-push'], fx.env);
		assert.match(r.stdout + r.stderr, /bootcamp REFUSES to write[\s\S]*reason: deploy-tree/);
		assert.notEqual(r.status, 0);
		assert.equal(fx.manifestBytes(), before);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('HALF 1: enroll --write inside a deploy root is REFUSED, and writes nothing', () => {
	const fx = deployRootFixture({});
	try {
		const before = fx.manifestBytes();
		// The same capture shape `manifest-target.test.mjs` enrolls from.
		const capture = `${formatEnrollmentRecord({
			fields: {
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
		})}\n`;
		const r = run(
			'scripts/enroll-node.mjs',
			['--stdin', '--write', '--json', '--no-push'],
			fx.env,
			capture
		);
		assert.equal(r.status, 1, r.stdout + r.stderr);
		assert.equal(JSON.parse(r.stdout).refusal, 'deploy-tree');
		assert.equal(fx.manifestBytes(), before);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('HALF 2: benchmark --write inside the SAME deploy root records the state dir, no manifest byte', () => {
	const node = 'writers-test-node.invalid';
	const fx = deployRootFixture({ [node]: { cores: 4 } });
	try {
		const before = fx.manifestBytes();
		const capture = join(fx.dir, 'capture.txt');
		writeFileSync(
			capture,
			[
				'BENCH-BEGIN v1',
				`hostname ${node}`,
				'cpu.model Test CPU',
				'cpu.cores 4',
				'cpu.threads 8',
				'mem.totalKb 16000000',
				'BENCH-END',
			].join('\n')
		);
		const r = run(
			'scripts/benchmark-fleet.mjs',
			[node, '--from', capture, '--write', '--json'],
			fx.env
		);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.equal(fx.manifestBytes(), before, 'not one manifest byte');
		const stored = JSON.parse(readFileSync(join(fx.state, 'benchmark.json'), 'utf8'));
		assert.equal(stored.nodes[node].by, 'fleet benchmark');
		assert.equal(stored.nodes[node].cpu.model, 'Test CPU');
		const log = readFileSync(join(fx.state, 'benchmark.log'), 'utf8').trim().split('\n');
		assert.equal(log.length, 1);
		assert.equal(JSON.parse(log[0]).node, node);
		assert.equal(JSON.parse(log[0]).raw['cpu.model'], 'Test CPU', 'the log keeps the raw capture');
		assert.equal(existsSync(join(fx.mdir, 'fleet-benchmarks.json')), false, 'no ledger append');
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});
