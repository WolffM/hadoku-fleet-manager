/**
 * ci-throttle's deployer (`deploy-ci-throttle.mjs`): the hook is deployed to
 * every node like a claw's own config, plus the two functions
 * (`renderConf`/`resolveReserveFile`) that CONTENT-test the conf this script
 * renders and never touches ssh. Split out of ci-throttle.test.mjs (wave 5p
 * lane C) — see `lib/ci-throttle-fixtures.mjs` for the shared `SCRIPTS`
 * this file resolves `deploy-ci-throttle.mjs` and `dist/lib/fleet-paths.js` against.
 *
 * EVERY CASE BELOW IS DRIVEN AGAINST A TEMP MANIFEST AND REACHES NO NODE —
 * see the DEPLOYER section's own header comment below for why `--confirm`
 * is safe to exercise here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import {
	FIXTURE_PREFIX,
	SCRIPTS,
	installCiThrottleRig,
	installLeakGate,
} from './lib/ci-throttle-fixtures.mjs';
import { parseJsonStdout, spawnCapture } from './lib/spawn-json.mjs';
import { tempDir } from './lib/test-tmpdir.mjs';

const DEPLOYER = join(SCRIPTS, 'deploy-ci-throttle.mjs');

installCiThrottleRig();

// ── the DEPLOYER ─────────────────────────────────────────────────────────────
//
// `deploy-ci-throttle.mjs` writes the hook above onto every node it selects.
//
// EVERY CASE BELOW IS DRIVEN AGAINST A TEMP MANIFEST AND REACHES NO NODE. The
// fixture nodes are named under `.invalid`, which RFC 2606 reserves so it can
// never resolve, and each case is chosen so the script returns before its one
// `ssh` call site (the loop over `nodes`) — which is also what makes it safe to
// exercise `--confirm` here.

/** A temp manifest dir holding `machines`, plus the state dir the script wants. */
function manifestFixture(machines) {
	const root = tempDir(`${FIXTURE_PREFIX}role-`);
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(
		join(manifestDir, 'fleet-runner-manifest.json'),
		JSON.stringify({ toolchain: { capabilities: [] }, machines }, null, 2)
	);
	return {
		root,
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: manifestDir,
			HADOKU_STATE_DIR: stateDir,
			HADOKU_SITE_ROOT: root,
		},
	};
}

/**
 * Run the deployer. Never throws on a non-zero exit — refusing IS the behaviour
 * under test — but DOES throw if the child was killed or never started, which
 * is neither a refusal nor a report.
 */
function deploy(args, env) {
	return spawnCapture(process.execPath, [DEPLOYER, ...args], {
		env,
		timeout: 60_000,
		label: `deploy-ci-throttle ${args.join(' ')}`,
	});
}

/**
 * The deployer's `--json` report, or a failure naming the status, the signal,
 * the elapsed time and the child's stderr.
 *
 * This is the line #45 was reported at. Both spawned scripts import from
 * `../dist/`, `pnpm run build` opens with `rm -rf dist` and `pnpm run test`
 * with `rm -rf dist/tests`; a second `pnpm run check` running concurrently
 * therefore deletes the tree out from under this child, which exits 1 having
 * written ERR_MODULE_NOT_FOUND to stderr and nothing to stdout. Parsing that
 * blind reported "Unexpected end of JSON input" — the one place the fault was
 * not.
 */
function json(r) {
	return parseJsonStdout(r);
}

/**
 * A fake `ssh` on PATH that captures exactly what the deployer would have
 * piped to a real node, then exits 0 without touching a network — the same
 * `script="$(cat)"` technique `bootcamp-prove.test.mjs`'s `sshShim` already
 * uses to read what was actually SENT rather than trust what the source says
 * it sends. Still reaches no real node: `.invalid` fixture names resolve to
 * nothing, but here that no longer matters, because this `ssh` never
 * resolves anything either.
 *
 * The destination (`<user>@<node>`) is whichever argv token contains an `@`
 * — `scriptCommand`'s own shape (`ssh <user>@<node> bash -s`) — so the
 * capture file is named after it without this fixture having to predict the
 * manifest's default admin user.
 */
function sshCaptureFixture() {
	const bin = tempDir(`${FIXTURE_PREFIX}ssh-bin-`);
	const captureDir = tempDir(`${FIXTURE_PREFIX}ssh-capture-`);
	writeFileSync(
		join(bin, 'ssh'),
		[
			'#!/bin/sh',
			'dest=""',
			'for a in "$@"; do',
			'  case "$a" in *@*) dest="$a" ;; esac',
			'done',
			`cat >"${captureDir}/$dest.payload"`,
			'exit 0',
		].join('\n')
	);
	chmodSync(join(bin, 'ssh'), 0o755);
	return {
		bin,
		/** The one captured payload for a destination containing `node` — fails loudly if there is not exactly one. */
		payloadFor(node) {
			const files = readdirSync(captureDir).filter((f) => f.includes(node));
			assert.equal(
				files.length,
				1,
				`expected exactly one captured ssh payload for ${node}, found ${files.length}: ${files.join(', ')}`
			);
			return readFileSync(join(captureDir, files[0]), 'utf8');
		},
	};
}

/** `KEY_B64=...` from a captured payload, base64-decoded — `remotePayload()`'s own shape. */
function b64Field(payload, key) {
	const m = new RegExp(`^${key}_B64=(\\S+)$`, 'm').exec(payload);
	assert.ok(m, `captured payload has no ${key}_B64= line:\n${payload}`);
	return Buffer.from(m[1], 'base64').toString('utf8');
}

// ── #76: `resolveReserveFile()` / `renderConf()`, run as the REAL code ─────
//
// `deploy-ci-throttle.mjs` is a CLI entry point: importing it runs its whole
// argv-parsing-through-`process.exit` body as a side effect, so it cannot be
// `import`ed here to unit-test one function in isolation — and spawning it as
// a subprocess (the pattern every other deployer test above uses) can only
// observe `results`/exit code/stdout, never the CONTENT of the conf this
// script renders: that text is piped to `ssh`/local `bash` and never echoed
// back, by design.
//
// So these two functions are pulled out of the REAL, CURRENT file — not a
// hand-copied duplicate that could silently drift from it — by balanced-brace
// extraction (a non-greedy regex would stop at the first inner `}`, e.g. the
// `catch { }` block's own close, truncating the function), and run as their
// own tiny module via a `data:` URL import. `resolveReserveFile()`'s one real
// dependency (`manifest` from `../dist/lib/fleet-paths.js`) is imported by its real
// absolute path, so the resolution under test is the production resolver
// (`manifestDir()` -> `FLEET_MANIFEST_DIR`/`siteRoot()`), not a stand-in.

/**
 * One top-level `function <name>(...) { … }` declaration's exact source text,
 * found by counting braces from its `{` to the matching `}` — safe here
 * because every `{`/`}` inside either function's body is either a template
 * expression's own matched pair (`${…}`) or absent; neither function's prose
 * comments contain a stray brace.
 */
function extractFunction(source, name) {
	const at = source.indexOf(`function ${name}(`);
	assert.ok(at >= 0, `function ${name} not found in ${DEPLOYER} — extraction is stale`);
	const bodyStart = source.indexOf('{', at);
	let depth = 0;
	let i = bodyStart;
	for (; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) break;
		}
	}
	assert.ok(depth === 0, `function ${name}: braces never balanced — extraction is stale`);
	return source.slice(at, i + 1);
}

/** Import `name` out of the real deploy-ci-throttle.mjs as its own module. */
async function loadRealFunction(name, { needsPaths = false } = {}) {
	const source = readFileSync(DEPLOYER, 'utf8');
	const fn = extractFunction(source, name);
	const pathsUrl = pathToFileURL(join(SCRIPTS, '..', 'dist', 'lib', 'fleet-paths.js')).href;
	// Aliased `manifest as manifestFile`, matching the REAL source's own import
	// (`import { manifest as manifestFile } from '../dist/lib/fleet-paths.js';`) — the
	// extracted function body calls it as `manifestFile(...)`, so an unaliased
	// import here would leave that name undefined and silently fall into the
	// function's own `catch`, returning `null` for every case alike.
	const moduleSrc =
		(needsPaths
			? `import { existsSync } from 'node:fs';\nimport { manifest as manifestFile } from '${pathsUrl}';\n`
			: '') + `export ${fn}`;
	const mod = await import(
		`data:text/javascript;base64,${Buffer.from(moduleSrc).toString('base64')}`
	);
	return mod[name];
}

test('#76: renderConf() includes RESERVE_FILE only when given a path, verbatim', async () => {
	const renderConf = await loadRealFunction('renderConf');
	const withoutReserve = renderConf(
		'claw-a',
		{ cores: 8, ramGb: 16, maxConcurrent: 2, minFreeMb: 1024 },
		null
	);
	assert.doesNotMatch(withoutReserve, /RESERVE_FILE/, withoutReserve);

	const withReserve = renderConf(
		'hokon',
		{ cores: 12, ramGb: 61, maxConcurrent: 4, minFreeMb: 8192 },
		'/some/resolved/fleet-runner-coverage.json'
	);
	assert.match(
		withReserve,
		/^RESERVE_FILE=\/some\/resolved\/fleet-runner-coverage\.json$/m,
		withReserve
	);
});

test('#76: resolveReserveFile() resolves through the REAL manifestDir(), and is null when nothing is there yet', async () => {
	const resolveReserveFile = await loadRealFunction('resolveReserveFile', { needsPaths: true });
	const f = manifestFixture({ 'claw-a.invalid': { cores: 4, labels: [], role: 'claw' } });
	const saved = { ...process.env };
	try {
		// Everything synchronous from here to the `finally` restore — no `await`
		// in between — so no other test in this file can observe the mutated env.
		Object.assign(process.env, f.env);

		// manifestDir() resolves (FLEET_MANIFEST_DIR points at the fixture), but
		// nothing has written a coverage file into it yet.
		assert.equal(resolveReserveFile(), null);

		// Write it at the EXACT path manifestFile() resolves — not a path this
		// test invents — and resolveReserveFile() must return that same path.
		const expected = join(f.env.FLEET_MANIFEST_DIR, 'fleet-runner-coverage.json');
		writeFileSync(expected, '{"facets":{}}');
		assert.equal(resolveReserveFile(), expected);
	} finally {
		process.env = saved;
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('#76: the per-node call site gates RESERVE_FILE on isLocalNode, never on CONFIRM/CHECK alone', () => {
	// The one line this follow-up exists for: `resolveReserveFile()` resolves a
	// path on the DEPLOYING box, and that path means nothing on a REMOTE node's
	// filesystem, so it must reach `renderConf` ONLY for the node that IS this
	// box. Behaviourally exercising `isLocalNode(name)` reading TRUE would mean
	// actually running this script's local-execution path against the real
	// node it happens to run on in this environment — out of scope for a test
	// (no writes of any kind to a node, and no real local execution of the
	// install payload at all, read-only or not).
	//
	// What IS in scope, and is what this now drives instead of a source-text
	// regex: `isLocalNode(name)` reading FALSE for a manifest node that is
	// certainly not this box (any `.invalid` name), through the REAL per-node
	// loop, over the REAL ssh payload — captured by `sshCaptureFixture()`
	// rather than trusted from source text, which cannot tell a textually
	// different but behaviourally equivalent rewrite (a false failure) from an
	// inversion that reads the WRONG boolean while still matching no fixed
	// pattern at all (a false pass). Reading the actual `CONF_B64` this run
	// would have shipped settles both: either the line was asking the right
	// question or RESERVE_FILE leaked into a remote node's conf.
	const capture = sshCaptureFixture();
	const f = manifestFixture({
		'claw-a.invalid': { cores: 8, maxConcurrent: 2, minFreeMb: 1024, role: 'claw' },
	});
	try {
		// RESERVE_FILE resolves to a real, truthy path only when a coverage file
		// sits exactly where resolveReserveFile() looks — without this the gate
		// being tested can never leak anything, because there is nothing to leak.
		writeFileSync(join(f.env.FLEET_MANIFEST_DIR, 'fleet-runner-coverage.json'), '{"facets":{}}');
		deploy(['--check'], { ...f.env, PATH: `${capture.bin}:${f.env.PATH}` });
		const conf = b64Field(capture.payloadFor('claw-a.invalid'), 'CONF');
		assert.doesNotMatch(
			conf,
			/RESERVE_FILE/,
			`a path resolved on the deploying box leaked into a remote node's conf:\n${conf}`
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

const BACKSTOP_NODE = {
	cores: 12,
	labels: ['pm2-host'],
	maxConcurrent: 4,
	minFreeMb: 8192,
	role: 'backstop',
};
const CLAW_NODE = { cores: 8, labels: [], maxConcurrent: 2, minFreeMb: 1024, role: 'claw' };

test('deployer: the backstop is deployed to like a claw, by --machine and fleet-wide', () => {
	// The throttle hook is the fleet's own admission script and the backstop
	// runs the fleet's jobs, so it is in scope on every path. Both nodes are
	// selected; neither resolves (`.invalid`), so each is an unreachable row.
	const f = manifestFixture({ 'backstop.invalid': BACKSTOP_NODE, 'claw-a.invalid': CLAW_NODE });
	try {
		const all = json(deploy(['--check', '--json'], f.env));
		assert.deepEqual(all.results.map((x) => x.machine).sort(), [
			'backstop.invalid',
			'claw-a.invalid',
		]);
		const one = json(deploy(['--check', '--json', '--machine', 'backstop.invalid'], f.env));
		assert.deepEqual(
			one.results.map((x) => x.machine),
			['backstop.invalid']
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('wave gates1 §A: a node already paged down by runner-health is skipped, not a fresh failure', () => {
	const f = manifestFixture({ 'claw-a.invalid': CLAW_NODE });
	try {
		writeFileSync(
			join(f.env.HADOKU_STATE_DIR, 'runner-down-page.json'),
			JSON.stringify({
				'claw-a.invalid': {
					since: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
					lastPage: new Date(Date.now() - 60_000).toISOString(),
				},
			})
		);
		const r = deploy(['--check', '--json'], f.env);
		const doc = json(r);
		assert.equal(
			r.code,
			0,
			`claw-a.invalid is the only unreachable node and is already paged down`
		);
		assert.equal(doc.results[0].ok, true);
		assert.equal(doc.results[0].skipped, 'known down');
		assert.equal(doc.knownDown.length, 1);
		assert.equal(doc.knownDown[0].node, 'claw-a.invalid');
		assert.match(doc.knownDown[0].pagedBy, /runner-health/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('wave gates1 §A: the same unreachable node, NOT known down, still fails (control)', () => {
	const f = manifestFixture({ 'claw-a.invalid': CLAW_NODE });
	try {
		// No runner-down-page.json at all — the safe-direction empty set.
		const r = deploy(['--check', '--json'], f.env);
		const doc = json(r);
		assert.equal(r.code, 1);
		assert.equal(doc.results[0].ok, false);
		assert.deepEqual(doc.knownDown, []);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('#120: fleet throttle asks the MINT predicate, never `ephemeral` — or an on-demand backstop gets no slot env', () => {
	// Shipped 0.34.0 with one call site still reading `m.ephemeral === true`:
	// the dry run reported "hokon has no jit-provision.sh", --confirm wrote
	// nothing, and every mint on the backstop would have failed at step one. The
	// slot env and the payload check are questions about the MINT PATH, which
	// an on-demand backstop is on and `ephemeral` does not see. (The provisioner
	// itself has travelled with each mint since 2026-10-27.)
	//
	// A source-text regex for `.ephemeral\s*[!=]==` and a count of
	// `mintsJitRunners(m)` both still pass an INVERTED predicate —
	// `ephemeral: !mintsJitRunners(m)` mentions no `.ephemeral` comparison at
	// all and still calls `mintsJitRunners(m)` exactly twice, so every
	// assertion here would read green while MINTS was backwards for every node
	// in the fleet. Driven over the real captured ssh payload instead: an
	// on-demand backstop (role backstop, `mint: 'on-demand'`, no `ephemeral`
	// field at all — the exact #120 shape) must get `MINTS=1`, and an ordinary
	// claw that mints nothing must get `MINTS=0`.
	const capture = sshCaptureFixture();
	const onDemandBackstop = { ...BACKSTOP_NODE, mint: 'on-demand' };
	const f = manifestFixture({
		'backstop.invalid': onDemandBackstop,
		'claw-a.invalid': CLAW_NODE,
	});
	try {
		deploy(['--check'], { ...f.env, PATH: `${capture.bin}:${f.env.PATH}` });
		const backstopPayload = capture.payloadFor('backstop.invalid');
		assert.match(
			backstopPayload,
			/^MINTS=1$/m,
			`an on-demand backstop must get the slot env:\n${backstopPayload}`
		);
		const clawPayload = capture.payloadFor('claw-a.invalid');
		assert.match(
			clawPayload,
			/^MINTS=0$/m,
			`a claw that mints nothing must not get the slot env:\n${clawPayload}`
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

installLeakGate();
