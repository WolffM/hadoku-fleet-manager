/**
 * Every writer of the fleet manifest goes through `renderJson`, and the SET of
 * writers is named here rather than counted.
 *
 * WHY (#12, and H's finding after it)
 * -----------------------------------
 * `fleet-runner-manifest.json` is operator config that lives in hadoku_site's
 * checkout, and hadoku_site's prettier (`printWidth: 100`) keeps a short array
 * inline. `JSON.stringify(doc, null, 2)` expands every one of them, so a write
 * that changed twenty lines of measurements produced a 213-line diff and left
 * that checkout failing its own `format:check`. #12 fixed ONE writer
 * (`fleet benchmark --write`). Four re-serialise the file and two of them were
 * still bypassing `renderJson` afterwards — which is the shape of gap a
 * behaviour test cannot see, because each writer is individually correct about
 * the facet it writes.
 *
 * THE LIST IS THE DECLARATION. `json-contract.mjs` carried a bare count of the
 * jobs under contract and was wrong twice; a count of manifest writers would
 * fail the same way, silently, the moment a fifth appeared or one was renamed.
 * So {@link WRITERS} names them, and the discovery scan below must agree with
 * it exactly in both directions: an unlisted writer FAILS, and a listed one
 * that has stopped writing the manifest FAILS too.
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
 * Each one re-serialises the WHOLE document to add its own `{at, by, ...}`
 * block to `machines[node]`, which is why formatting is a property of the
 * writer and not of the edit.
 *
 * TWO, SINCE WAVE 3h. `fleet benchmark --write` (`$benchmark`) and
 * `fleet doctor --write` (`$health`) record into the STATE DIR through
 * `src/lib/measured.ts` and write no manifest byte — they are
 * {@link STATE_WRITERS} below, and the discovery scan here would fail if either
 * went back to binding and writing the manifest path.
 *
 * THREE SINCE WAVE 3l. `fleet provision --machine <node> --confirm` writes the
 * placement fields a serving claw needs — the four hand edits claw-9's
 * onboarding took — and flips `ephemeral` once bootcamp has EARNED `jitconfig`.
 * It is a manifest writer by every test this file applies: it asks
 * `writeTarget` first, renders through `renderJson`, takes a `.bak`, parses the
 * file back, and lands through `landWrite`.
 *
 * IT WAS INVISIBLE TO THE SCAN, and that was the real finding — not a stale
 * list. {@link BINDS_MANIFEST_PATH} tracked one shape of binding, and provision
 * uses the other two: the zero-argument `manifestPath()` spelling, and the path
 * arriving as a PARAMETER of the function that writes it. A writer shaped that
 * way could have appeared undeclared and this guard would have reported the
 * fleet clean, which is the exact failure the list-not-a-count rule exists to
 * prevent. The binder now reads all three spellings.
 */
const WRITERS = [
	{ file: 'scripts/bootcamp.mjs', facet: '$capabilities — `fleet bootcamp --write`' },
	{ file: 'scripts/enroll-node.mjs', facet: '$measured — `fleet enroll --write`' },
	{ file: 'scripts/lan-reserve.mjs', facet: 'lan — `fleet lan-reserve <node> --write`' },
	{
		file: 'scripts/provision-fleet.mjs',
		facet: 'placement + ephemeral — `fleet provision --machine <node> --confirm`',
	},
];

/**
 * The writers of the two STATE-DIR facets. They call `writeFacet` and nothing
 * from `lib/manifest-target.mjs`: the state dir is not a checkout, so there is
 * no commit to land and no deploy tree to refuse.
 */
const STATE_WRITERS = [
	{ file: 'scripts/benchmark-fleet.mjs', facet: 'benchmark — `fleet benchmark --write`' },
	{ file: 'scripts/lib/doctor-run.mjs', facet: 'health — `fleet doctor --write`' },
];

/**
 * A variable bound to the manifest's PATH, which is how all of them reach it —
 * `manifest()`, `manifestPath()` and `manifestFile()` are the three spellings
 * of the one resolver in `lib/paths.mjs`.
 *
 * Tracking the variable rather than the filename is what makes this precise:
 * `check-label-floor.mjs` and `drain-node.mjs` both name the manifest and both
 * call `writeFileSync`, and neither writes the manifest. A filename-and-
 * writeFileSync grep scores both as writers.
 *
 * THREE SHAPES, because a writer only had to use one of the other two to become
 * INVISIBLE here (wave 3l):
 *
 *   1. `const X = manifest('fleet-runner-manifest.json')`   — bootcamp, enroll
 *   2. `const X = manifestPath()`                            — the zero-argument
 *      spelling `fleet-exec.mjs` exports, which resolves the same filename
 *   3. `manifestPath: X,`                                    — the path arriving
 *      as a destructured PARAMETER of the function that does the writing, which
 *      is how a writer separates "which file" from "write it"
 *
 * Shape 1 alone is what this scan read until `provision-fleet.mjs` used both of
 * the others. That is not a missed file in a list; it is a whole class of
 * writer the guard could not see, and an undeclared one would have passed.
 *
 * Widening it does NOT widen what counts as a writer: a match still only
 * matters when the SAME variable is handed to `writeFileSync`, which is what
 * keeps the readers out. Re-measured after the change: exactly three files
 * match, the same three {@link WRITERS} declares.
 */
const BINDS_MANIFEST_PATH =
	/(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:manifest|manifestPath|manifestFile)\(\s*(?:['"]fleet-runner-manifest\.json['"]\s*)?\)|manifestPath\s*:\s*([A-Za-z_$][\w$]*)\s*,)/g;

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

/** Repo-relative path of every non-test source that writes the manifest path. */
function discoverWriters() {
	const found = new Set();
	for (const root of ['src', 'scripts']) {
		for (const abs of sources(join(ROOT, root))) {
			const src = blankComments(readFileSync(abs, 'utf8'));
			// EITHER capture group: a declaration binding, or a parameter alias.
			const bound = new Set([...src.matchAll(BINDS_MANIFEST_PATH)].map((m) => m[1] ?? m[2]));
			for (const name of bound) {
				// The BARE variable only. `writeFileSync(`${mp}.bak`, …)` is the
				// backup every one of these takes before it writes, not the write.
				if (new RegExp(String.raw`writeFileSync\(\s*${name}\s*,`).test(src)) {
					found.add(relative(ROOT, abs).replaceAll('\\', '/'));
				}
			}
		}
	}
	return [...found].sort();
}

void test('the manifest has exactly these writers — the list, not a count', () => {
	assert.deepEqual(
		discoverWriters(),
		WRITERS.map((w) => w.file),
		'a writer of fleet-runner-manifest.json appeared or moved. Add it to WRITERS in\n' +
			'this file AND route its write through renderJson — another writer that\n' +
			'JSON.stringify()s the document undoes #12 for the whole file, not just its\n' +
			'own facet.'
	);
});

void test('every writer renders through renderJson, and none re-serialises by hand', () => {
	for (const { file, facet } of WRITERS) {
		const abs = join(ROOT, file);
		const src = blankComments(readFileSync(abs, 'utf8'));
		const name = [...src.matchAll(BINDS_MANIFEST_PATH)].map((m) => m[1] ?? m[2])[0];
		assert.ok(name, `${file} (${facet}) no longer binds the manifest path`);

		// It must ASK prettier, from the target file's own tree, for this path.
		// `assert.ok` on a boolean rather than `assert.match` on the source: a
		// failing `match` prints the whole blanked file, which buries the one
		// line an operator needs under 300 lines of blanked comment.
		assert.ok(
			new RegExp(String.raw`renderJson\(\s*[\w$.]+\s*,\s*${name}\s*\)`).test(src),
			`${file} (${facet}) must render the manifest with renderJson(doc, ${name}) — ` +
				`hadoku_site's prettier keeps short arrays inline and JSON.stringify does not, ` +
				`so a hand-serialised write rewrites lines it did not change and leaves that ` +
				`checkout failing format:check (#12).`
		);

		// And the bytes it writes must be what came back from it. Rendering and
		// then writing something else is the same bug with an extra step.
		const writes = [
			...src.matchAll(new RegExp(String.raw`writeFileSync\(\s*${name}\s*,\s*([^;]+?)\)\s*;`, 'g')),
		].map((m) => m[1].trim());
		assert.ok(writes.length, `${file} (${facet}) no longer writes ${name}`);
		for (const arg of writes) {
			assert.match(
				arg,
				/^[\w$]+\.text$/,
				`${file} (${facet}) writes ${name} from \`${arg}\`, which did not come from ` +
					`renderJson. The rendered text is the only thing that may reach this file.`
			);
		}
	}
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

void test('writeTarget — the deploy-tree refusal — is called by EXACTLY bootcamp and enroll', () => {
	assert.deepEqual(
		callersOf('writeTarget'),
		WRITERS.map((w) => w.file).sort(),
		'every manifest writer must ask writeTarget before writing (the deploy-tree refusal), ' +
			'and nothing that writes the STATE DIR may — a state-dir write needs no commit.'
	);
	assert.deepEqual(callersOf('landWrite'), WRITERS.map((w) => w.file).sort());
});

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
