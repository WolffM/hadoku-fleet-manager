#!/usr/bin/env node
// capability-seeds.mjs — wave 4c lane E (#102 §E). Every ssh/gh call is a FAKE
// function this file controls; nothing here spawns a real ssh, a real `gh`, or
// touches any real host. See the module header for the cardtable blocking
// finding this suite works around with a fixture script.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	SEED_DISK_FLOOR_MB,
	seedEntries,
	validateSeeds,
	nodeEarnsSeed,
	resolveSeed,
	buildRunScript,
	parseSeedProof,
	seedNode,
	ghWithRetry,
	BUSY_CHECK_SCRIPT,
	diskCheckScript,
	isSeedFinding,
} from './capability-seeds.mjs';

const REPO = 'WolffM/hadoku-cardtable';
const SCRIPT_PATH = 'scripts/forge-bundle.sh';
const CACHE = '~/.cache/cardtable-forge';
const PIN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function seedsManifest(extra = {}) {
	return {
		$seeds: {
			jdk21: {
				repo: REPO,
				script: SCRIPT_PATH,
				argument: { kind: 'submodule-pin', submodule: 'forge', ref: 'default' },
				cache: CACHE,
			},
		},
		repos: { [REPO]: {} },
		machines: {},
		...extra,
	};
}

function earnedNode(overrides = {}) {
	return {
		role: 'claw',
		$capabilities: { earned: ['jdk21'], prereqs: [] },
		...overrides,
	};
}

function b64(text) {
	return Buffer.from(text, 'utf8').toString('base64');
}

// A fixture script shaped like forge-bundle.sh WOULD be after the one
// additive change this lane's report asks cardtable for (see the module
// header): it reads CARDTABLE_FORGE_PIN instead of `git ls-tree HEAD forge`.
// Everything else about the contract under test — what reaches the node,
// what proves currency — is exercised against THIS text, honestly, rather
// than against the real (currently unusable from a no-checkout ssh) script.
const FIXTURE_SCRIPT_HIT = [
	'#!/usr/bin/env bash',
	'set -euo pipefail',
	'echo "forge-bundle: HIT: pin $CARDTABLE_FORGE_PIN already cached at $CARDTABLE_FORGE_CACHE/$CARDTABLE_FORGE_PIN" >&2',
	'echo "CARDTABLE_FORGE_JAR=$CARDTABLE_FORGE_CACHE/$CARDTABLE_FORGE_PIN/forge.jar"',
	'echo "CARDTABLE_FORGE_RES=$CARDTABLE_FORGE_CACHE/$CARDTABLE_FORGE_PIN/res"',
].join('\n');

const FIXTURE_SCRIPT_BUILD = [
	'#!/usr/bin/env bash',
	'set -euo pipefail',
	'echo "forge-bundle: BUILD: pin $CARDTABLE_FORGE_PIN not cached, building" >&2',
	'echo "forge-bundle: BUILD finished in 42s total (mvn 30s of it); bundle size 504M at $CARDTABLE_FORGE_CACHE/$CARDTABLE_FORGE_PIN" >&2',
	'echo "CARDTABLE_FORGE_JAR=$CARDTABLE_FORGE_CACHE/$CARDTABLE_FORGE_PIN/forge.jar"',
	'echo "CARDTABLE_FORGE_RES=$CARDTABLE_FORGE_CACHE/$CARDTABLE_FORGE_PIN/res"',
].join('\n');

const FIXTURE_SCRIPT_SILENT = ['#!/usr/bin/env bash', 'exit 0'].join('\n');
const FIXTURE_SCRIPT_FAIL = ['#!/usr/bin/env bash', 'echo "boom" >&2', 'exit 1'].join('\n');

/** A fake `gh` resolving repos/<repo>, the submodule pin, and the script text. */
function fakeGh({ scriptText = FIXTURE_SCRIPT_HIT, defaultBranch = 'main', pin = PIN } = {}) {
	const calls = [];
	const gh = async (args) => {
		calls.push(args);
		const path = args[1];
		if (path === `repos/${REPO}`) {
			return {
				ok: true,
				stdout: JSON.stringify({ default_branch: defaultBranch }),
				stderr: '',
				error: null,
			};
		}
		if (path.startsWith(`repos/${REPO}/contents/forge?`)) {
			return {
				ok: true,
				stdout: JSON.stringify({ type: 'submodule', sha: pin }),
				stderr: '',
				error: null,
			};
		}
		if (path.startsWith(`repos/${REPO}/contents/${SCRIPT_PATH}?`)) {
			return {
				ok: true,
				stdout: JSON.stringify({ encoding: 'base64', content: b64(scriptText) }),
				stderr: '',
				error: null,
			};
		}
		return { ok: false, stdout: '', stderr: 'not found', error: 'not found' };
	};
	return { gh, calls };
}

/** A fake `ssh` keyed by node name, queueing responses in call order. */
function fakeSsh(responsesByNode) {
	const calls = [];
	const counters = new Map();
	const ssh = async (name, script, opts) => {
		calls.push({ name, script, opts });
		const queue = responsesByNode[name] ?? [];
		const i = counters.get(name) ?? 0;
		counters.set(name, i + 1);
		return queue[i] ?? { ok: true, stdout: '', stderr: '', error: null };
	};
	return { ssh, calls };
}

const IDLE = { ok: true, stdout: 'IDLE\n', stderr: '', error: null };
const BUSY = { ok: true, stdout: 'BUSY\n', stderr: '', error: null };
const ROOMY_DISK = {
	ok: true,
	stdout: `${(SEED_DISK_FLOOR_MB + 1024) * 1024}\n`,
	stderr: '',
	error: null,
};
const TIGHT_DISK = {
	ok: true,
	stdout: `${(SEED_DISK_FLOOR_MB - 100) * 1024}\n`,
	stderr: '',
	error: null,
};

// --- validateSeeds -----------------------------------------------------------

test('validateSeeds: a well-formed $seeds entry produces zero findings', () => {
	assert.deepEqual(validateSeeds(seedsManifest()), []);
});

test('validateSeeds: absent $seeds is not a finding', () => {
	assert.deepEqual(validateSeeds({ machines: {} }), []);
});

test('validateSeeds: unknown capability id', () => {
	const m = seedsManifest();
	m.$seeds['not-a-real-capability'] = m.$seeds.jdk21;
	const findings = validateSeeds(m);
	assert.ok(
		findings.some(
			(f) => f.rule === 'seed-unknown-capability' && f.capability === 'not-a-real-capability'
		)
	);
});

test('validateSeeds: a toolchain-surface capability cannot carry a seed', () => {
	const m = seedsManifest();
	delete m.$seeds.jdk21;
	m.$seeds.ffmpeg = {
		repo: REPO,
		script: SCRIPT_PATH,
		argument: { kind: 'submodule-pin', submodule: 'forge' },
		cache: CACHE,
	};
	const findings = validateSeeds(m);
	assert.ok(findings.some((f) => f.rule === 'seed-surface-mismatch' && f.capability === 'ffmpeg'));
});

test('validateSeeds: cache must be ~-relative — this is the shape contract with lane F', () => {
	const m = seedsManifest();
	m.$seeds.jdk21.cache = '/home/hadoku/.cache/cardtable-forge';
	const findings = validateSeeds(m);
	assert.ok(findings.some((f) => f.rule === 'seed-bad-cache'));
});

test('validateSeeds: an absolute or traversal-carrying script path is refused', () => {
	for (const bad of ['/scripts/forge-bundle.sh', '../forge-bundle.sh']) {
		const m = seedsManifest();
		m.$seeds.jdk21.script = bad;
		const findings = validateSeeds(m);
		assert.ok(
			findings.some((f) => f.rule === 'seed-bad-script'),
			bad
		);
	}
});

test('validateSeeds: an unknown argument.kind is refused', () => {
	const m = seedsManifest();
	m.$seeds.jdk21.argument = { kind: 'something-else' };
	const findings = validateSeeds(m);
	assert.ok(findings.some((f) => f.rule === 'seed-unknown-argument-kind'));
});

test('validateSeeds: argument.ref pinned to a literal branch is refused, "default" or omitted is fine', () => {
	const bad = seedsManifest();
	bad.$seeds.jdk21.argument.ref = 'main';
	assert.ok(validateSeeds(bad).some((f) => f.rule === 'seed-bad-argument'));

	const omitted = seedsManifest();
	delete omitted.$seeds.jdk21.argument.ref;
	assert.deepEqual(validateSeeds(omitted), []);
});

test('validateSeeds: a malformed repo string is refused', () => {
	const m = seedsManifest();
	m.$seeds.jdk21.repo = 'not-an-owner-slash-name';
	assert.ok(validateSeeds(m).some((f) => f.rule === 'seed-bad-repo'));
});

// --- nodeEarnsSeed / seedEntries ---------------------------------------------

test('nodeEarnsSeed: true only once the node has proven the capability', () => {
	assert.equal(nodeEarnsSeed(earnedNode(), 'jdk21'), true);
	assert.equal(nodeEarnsSeed({ $capabilities: { earned: [], prereqs: [] } }, 'jdk21'), false);
	assert.equal(nodeEarnsSeed({}, 'jdk21'), false, 'no bootcamp facet at all: nothing has looked');
});

test('seedEntries: absent, non-object, and array $seeds all yield []', () => {
	assert.deepEqual(seedEntries({}), []);
	assert.deepEqual(seedEntries({ $seeds: 'nope' }), []);
	assert.deepEqual(seedEntries({ $seeds: [] }), []);
});

// --- resolveSeed (controller-side, fake gh) ----------------------------------

test('resolveSeed: resolves the submodule pin and decodes the script, through a fake gh only', async () => {
	const { gh, calls } = fakeGh();
	const spec = seedsManifest().$seeds.jdk21;
	const resolved = await resolveSeed(spec, gh);
	assert.equal(resolved.ok, true);
	assert.equal(resolved.pin, PIN);
	assert.equal(resolved.defaultBranch, 'main');
	assert.match(resolved.scriptText, /forge-bundle/);
	assert.equal(calls.length, 3, 'repo info, submodule contents, script contents — nothing more');
});

test('resolveSeed: an unreadable repo is a reason, not a throw', async () => {
	const gh = async () => ({ ok: false, stdout: '', stderr: 'HTTP 404', error: '404' });
	const spec = seedsManifest().$seeds.jdk21;
	const resolved = await resolveSeed(spec, gh);
	assert.equal(resolved.ok, false);
	assert.match(resolved.reason, /could not read/);
});

test('resolveSeed: a non-submodule entry at the path is refused with the type it actually found', async () => {
	const gh = async (args) => {
		if (args[1] === `repos/${REPO}`)
			return { ok: true, stdout: JSON.stringify({ default_branch: 'main' }) };
		if (args[1].startsWith(`repos/${REPO}/contents/forge?`)) {
			return { ok: true, stdout: JSON.stringify({ type: 'dir', sha: 'whatever' }) };
		}
		return { ok: false, stdout: '', stderr: 'unexpected call' };
	};
	const spec = seedsManifest().$seeds.jdk21;
	const resolved = await resolveSeed(spec, gh);
	assert.equal(resolved.ok, false);
	assert.match(resolved.reason, /not a submodule entry \(got type=dir\)/);
});

// --- buildRunScript / parseSeedProof -----------------------------------------

test('buildRunScript: ships the pin and cache as env vars the fixture script reads, never on an argv', () => {
	const spec = seedsManifest().$seeds.jdk21;
	const script = buildRunScript(spec, { pin: PIN, scriptText: FIXTURE_SCRIPT_HIT });
	assert.match(script, /export CARDTABLE_FORGE_PIN='[0-9a-f]+'/);
	assert.match(script, /export CARDTABLE_FORGE_CACHE="\$HOME\/\.cache\/cardtable-forge"/);
	assert.match(script, /forge-bundle/);
});

test("parseSeedProof: reads the script's own HIT and BUILD lines; silence proves nothing", () => {
	assert.deepEqual(parseSeedProof(`forge-bundle: HIT: pin ${PIN} already cached at /x`), {
		kind: 'HIT',
		pin: PIN,
	});
	const build = parseSeedProof('forge-bundle: BUILD finished in 42s total (mvn 30s of it)');
	assert.equal(build.kind, 'BUILD');
	assert.equal(build.seconds, 42);
	const silent = parseSeedProof('nothing recognisable here');
	assert.equal(silent.kind, null);
	assert.match(silent.reason, /neither a HIT nor a BUILD/);
});

// --- seedNode: the decision ladder, cheapest check first ---------------------

test('seedNode: a node that has not earned the capability costs ZERO ssh or gh calls', async () => {
	const manifest = seedsManifest();
	const { ssh, calls: sshCalls } = fakeSsh({});
	const { gh, calls: ghCalls } = fakeGh();
	const node = { role: 'claw', $capabilities: { earned: [], prereqs: [] } };
	const results = await seedNode('claw-x', node, manifest, { ssh, gh });
	assert.deepEqual(results, [{ id: 'jdk21', status: 'not-earned' }]);
	assert.equal(sshCalls.length, 0);
	assert.equal(ghCalls.length, 0);
});

test("seedNode: a node excluded from the seed's repo is repo-ineligible, no I/O — the claw-5 shape", async () => {
	const manifest = seedsManifest();
	manifest.machines['claw-5'] = { excludeRepos: { [REPO]: 'slow' } };
	const { ssh, calls: sshCalls } = fakeSsh({});
	const { gh, calls: ghCalls } = fakeGh();
	const node = earnedNode({ excludeRepos: { [REPO]: 'slow' } });
	const results = await seedNode('claw-5', node, manifest, { ssh, gh });
	assert.equal(results[0].status, 'repo-ineligible');
	assert.equal(isSeedFinding(results[0].status), false);
	assert.equal(sshCalls.length, 0);
	assert.equal(ghCalls.length, 0);
});

test('seedNode: hokon (a guest) is never seeded, whatever it has earned — zero I/O', async () => {
	const manifest = seedsManifest();
	const { ssh, calls: sshCalls } = fakeSsh({});
	const { gh, calls: ghCalls } = fakeGh();
	const node = earnedNode({ role: 'guest' });
	const results = await seedNode('hokon', node, manifest, { ssh, gh });
	assert.equal(results[0].status, 'guest');
	assert.equal(sshCalls.length, 0);
	assert.equal(ghCalls.length, 0);
});

test('seedNode: a busy node is skipped and reported, never counted as a finding', async () => {
	const manifest = seedsManifest();
	manifest.machines['claw-a'] = earnedNode();
	const { ssh, calls } = fakeSsh({ 'claw-a': [BUSY] });
	const { gh } = fakeGh();
	const results = await seedNode('claw-a', earnedNode(), manifest, { ssh, gh });
	assert.equal(results[0].status, 'busy');
	assert.equal(isSeedFinding(results[0].status), false);
	assert.equal(
		calls.length,
		1,
		'stops after the busy check — never asks for disk or ships anything'
	);
});

test('seedNode: under the disk floor is refused AND counted as a finding, with the free MiB reported', async () => {
	const manifest = seedsManifest();
	manifest.machines['claw-a'] = earnedNode();
	const { ssh } = fakeSsh({ 'claw-a': [IDLE, TIGHT_DISK] });
	const { gh } = fakeGh();
	const results = await seedNode('claw-a', earnedNode(), manifest, { ssh, gh });
	assert.equal(results[0].status, 'refused');
	assert.equal(isSeedFinding('refused'), true);
	assert.equal(results[0].freeMb, SEED_DISK_FLOOR_MB - 100);
});

test('seedNode: an unreadable df is its own finding, never "nothing to keep"', async () => {
	const manifest = seedsManifest();
	manifest.machines['claw-a'] = earnedNode();
	const { ssh } = fakeSsh({
		'claw-a': [IDLE, { ok: false, stdout: '', stderr: 'ssh timeout', error: 'timeout' }],
	});
	const { gh } = fakeGh();
	const results = await seedNode('claw-a', earnedNode(), manifest, { ssh, gh });
	assert.equal(results[0].status, 'unreadable');
	assert.equal(isSeedFinding('unreadable'), true);
});

test('seedNode: a ready, idle, roomy node is seeded — HIT path', async () => {
	const manifest = seedsManifest();
	manifest.machines['claw-a'] = earnedNode();
	const runOutput = {
		ok: true,
		stdout: 'CARDTABLE_FORGE_JAR=/x/forge.jar\nCARDTABLE_FORGE_RES=/x/res\n',
		stderr: `forge-bundle: HIT: pin ${PIN} already cached at /x`,
		error: null,
	};
	const { ssh, calls } = fakeSsh({ 'claw-a': [IDLE, ROOMY_DISK, runOutput] });
	const { gh } = fakeGh({ scriptText: FIXTURE_SCRIPT_HIT });
	const results = await seedNode('claw-a', earnedNode(), manifest, { ssh, gh });
	assert.equal(results[0].status, 'seeded');
	assert.equal(results[0].proof, 'HIT');
	assert.equal(results[0].pin, PIN);
	assert.equal(calls.length, 3);
});

test('seedNode: a ready node that must BUILD is seeded — BUILD path', async () => {
	const manifest = seedsManifest();
	manifest.machines['claw-a'] = earnedNode();
	const runOutput = {
		ok: true,
		stdout: 'CARDTABLE_FORGE_JAR=/x/forge.jar\nCARDTABLE_FORGE_RES=/x/res\n',
		stderr:
			'forge-bundle: BUILD: pin not cached\nforge-bundle: BUILD finished in 88s total (mvn 70s of it)',
		error: null,
	};
	const { ssh } = fakeSsh({ 'claw-a': [IDLE, ROOMY_DISK, runOutput] });
	const { gh } = fakeGh({ scriptText: FIXTURE_SCRIPT_BUILD });
	const results = await seedNode('claw-a', earnedNode(), manifest, { ssh, gh });
	assert.equal(results[0].status, 'seeded');
	assert.equal(results[0].proof, 'BUILD');
});

test('seedNode: a script that exits 0 but proves nothing (no HIT/BUILD line) is a FAILED finding', async () => {
	const manifest = seedsManifest();
	manifest.machines['claw-a'] = earnedNode();
	const runOutput = { ok: true, stdout: '', stderr: '', error: null };
	const { ssh } = fakeSsh({ 'claw-a': [IDLE, ROOMY_DISK, runOutput] });
	const { gh } = fakeGh({ scriptText: FIXTURE_SCRIPT_SILENT });
	const results = await seedNode('claw-a', earnedNode(), manifest, { ssh, gh });
	assert.equal(results[0].status, 'failed');
	assert.match(results[0].reason, /neither a HIT nor a BUILD/);
});

test('seedNode: a script that exits non-zero is a FAILED finding carrying its stderr', async () => {
	const manifest = seedsManifest();
	manifest.machines['claw-a'] = earnedNode();
	const runOutput = {
		ok: false,
		stdout: '',
		stderr: 'forge-bundle: mvn build failed for forge pin',
		error: 'exit 1',
	};
	const { ssh } = fakeSsh({ 'claw-a': [IDLE, ROOMY_DISK, runOutput] });
	const { gh } = fakeGh({ scriptText: FIXTURE_SCRIPT_FAIL });
	const results = await seedNode('claw-a', earnedNode(), manifest, { ssh, gh });
	assert.equal(results[0].status, 'failed');
	assert.match(results[0].reason, /mvn build failed/);
});

test('seedNode: gh resolution failure is a FAILED finding, named, after disk passed', async () => {
	const manifest = seedsManifest();
	manifest.machines['claw-a'] = earnedNode();
	const { ssh } = fakeSsh({ 'claw-a': [IDLE, ROOMY_DISK] });
	const gh = async () => ({
		ok: false,
		stdout: '',
		stderr: 'HTTP 403 rate limited',
		error: 'rate limited',
	});
	const results = await seedNode('claw-a', earnedNode(), manifest, { ssh, gh });
	assert.equal(results[0].status, 'failed');
	assert.match(results[0].reason, /rate limited/);
});

// --- token safety -------------------------------------------------------------

test('seedNode: nothing token-shaped reaches the ssh script text or the gh argv', async () => {
	const CANARY = 'ghp_CANARY_SECRET_VALUE_1234567890';
	const prevEnv = { ...process.env };
	process.env.GH_TOKEN = CANARY;
	process.env.GITHUB_TOKEN = CANARY;
	try {
		const manifest = seedsManifest();
		manifest.machines['claw-a'] = earnedNode();
		const runOutput = {
			ok: true,
			stdout: 'ok\n',
			stderr: `HIT: pin ${PIN} already cached`,
			error: null,
		};
		const { ssh, calls: sshCalls } = fakeSsh({ 'claw-a': [IDLE, ROOMY_DISK, runOutput] });
		const { gh, calls: ghCalls } = fakeGh({ scriptText: FIXTURE_SCRIPT_HIT });
		const results = await seedNode('claw-a', earnedNode(), manifest, { ssh, gh });
		assert.equal(results[0].status, 'seeded');
		for (const call of sshCalls)
			assert.ok(
				!call.script.includes(CANARY),
				'ssh script text must never carry the ambient token'
			);
		for (const call of ghCalls)
			assert.ok(
				!call.some((a) => a.includes(CANARY)),
				'gh argv must never carry the ambient token'
			);
	} finally {
		process.env = prevEnv;
	}
});

test('BUSY_CHECK_SCRIPT and diskCheckScript never reference a literal /tmp or a hardcoded home', () => {
	assert.doesNotMatch(BUSY_CHECK_SCRIPT, /\/tmp|\/home\/\w+/);
	assert.doesNotMatch(diskCheckScript(CACHE), /\/tmp|\/home\/\w+/);
	assert.match(diskCheckScript(CACHE), /\$HOME/);
});

// --- ghWithRetry ---------------------------------------------------------------

test('ghWithRetry: a transient failure recovers within READ_ATTEMPTS, same as every other gh reader', async () => {
	let n = 0;
	const flaky = async () => {
		n++;
		return n === 1
			? { ok: false, stdout: '', stderr: 'blip', error: 'blip' }
			: { ok: true, stdout: '{}', stderr: '', error: null };
	};
	const retried = ghWithRetry(flaky, { delayMs: 0 });
	const r = await retried(['api', 'whatever']);
	assert.equal(r.ok, true);
	assert.equal(n, 2);
});

test('ghWithRetry: a failure on every attempt is still a failure, naming the attempt count', async () => {
	const alwaysFails = async () => ({ ok: false, stdout: '', stderr: 'down', error: 'down' });
	const retried = ghWithRetry(alwaysFails, { attempts: 2, delayMs: 0 });
	const r = await retried(['api', 'whatever']);
	assert.equal(r.ok, false);
	assert.match(r.error, /attempt 2\/2/);
});
