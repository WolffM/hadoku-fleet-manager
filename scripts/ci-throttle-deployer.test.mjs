/**
 * ci-throttle's deployer (`deploy-ci-throttle.mjs`): the hook is deployed to
 * every node like a claw's own config, plus the two functions
 * (`renderConf`/`resolveReserveFile`) that CONTENT-test the conf this script
 * renders and never touches ssh. Split out of ci-throttle.test.mjs (wave 5p
 * lane C) — see `lib/ci-throttle-fixtures.mjs` for the shared `SCRIPTS`
 * this file resolves `deploy-ci-throttle.mjs` and `lib/paths.mjs` against.
 *
 * EVERY CASE BELOW IS DRIVEN AGAINST A TEMP MANIFEST AND REACHES NO NODE —
 * see the DEPLOYER section's own header comment below for why `--confirm`
 * is safe to exercise here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import {
	FIXTURE_PREFIX,
	SCRIPTS,
	installCiThrottleRig,
	installLeakGate,
} from './lib/ci-throttle-fixtures.mjs';
import { blankComments } from './lib/blank-comments.mjs';
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
// dependency (`manifest` from `./lib/paths.mjs`) is imported by its real
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
	const pathsUrl = pathToFileURL(join(SCRIPTS, 'lib', 'paths.mjs')).href;
	// Aliased `manifest as manifestFile`, matching the REAL source's own import
	// (`import { manifest as manifestFile } from './lib/paths.mjs';`) — the
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
	// install payload at all, read-only or not). `isLocalNode` itself is
	// already guarded elsewhere (`node-identity-guard.test.mjs`); what matters
	// here is only that THIS call site still asks it, rather than reading
	// `RESERVE_FILE` unconditionally or gating on something else — a structural
	// check, the same kind `node-identity-guard.test.mjs` already uses for the
	// same reason: a behavioural test cannot catch a line being deleted or
	// loosened, only a reader of the source can.
	const source = readFileSync(DEPLOYER, 'utf8');
	assert.match(
		source,
		/const reserveFile = isLocalNode\(name\) \? RESERVE_FILE : null;/,
		'the per-node RESERVE_FILE gate must read exactly isLocalNode(name) ? RESERVE_FILE : null — ' +
			'found something else, so a remote node may now be getting a path resolved on this box'
	);
	// And it must be the value renderConf is actually called with, not a
	// sibling variable nobody passes on.
	assert.match(
		source,
		/renderConf\(name, m, reserveFile\)/,
		'renderConf must be called with the gated reserveFile, not m/name alone or RESERVE_FILE directly'
	);
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

test('#120: fleet throttle asks the MINT predicate, never `ephemeral` — or an on-demand backstop gets no slot env', () => {
	// Shipped 0.34.0 with one call site still reading `m.ephemeral === true`:
	// the dry run reported "hokon has no jit-provision.sh", --confirm wrote
	// nothing, and every mint on the backstop would have failed at step one. The
	// slot env and the payload check are questions about the MINT PATH, which
	// an on-demand backstop is on and `ephemeral` does not see. (The provisioner
	// itself has travelled with each mint since 2026-10-27.)
	const src = blankComments(readFileSync(DEPLOYER, 'utf8'));
	assert.deepEqual(src.match(/\.ephemeral\s*[!=]==/g) ?? [], []);
	assert.equal(
		(src.match(/mintsJitRunners\(m\)/g) ?? []).length,
		2,
		'the slot env (MINTS) and the payload check'
	);
});

installLeakGate();
