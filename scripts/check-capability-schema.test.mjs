/**
 * `fleet capability-schema`, RUN FOR REAL, on the keys that say what a node IS:
 * its `role`, the on-demand backstop's `mint`/`standingRepos` (#120), and
 * `services` against hadoku_site's pm2-hosts.json (#6).
 *
 * `src/tests/node-role.test.ts` proves the predicate. What regresses is the
 * WIRING: that the gate actually refuses a manifest with no role, and that it
 * still emits parseable JSON when it does (the cron reads stdout BEFORE the
 * exit code). Driven against a TEMP manifest, never the operator's; the gate is
 * pure and reaches no node. (These lived in `lib/node-role-gates.test.mjs`
 * until 2026-10-31.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPTS);

/**
 * ONE PROFILE, SHAPED THE WAY `node-profiles.mjs` DEMANDS — not the way
 * `converge-toolchain` happens to read.
 *
 * Why a fixture manifest dir has to carry `node-profiles.json` at all is issue
 * #58: `converge-toolchain` used to find the profile manifest by `__dirname`
 * arithmetic into this package's own `manifests/`, a directory
 * `package.json` `files` deliberately does not ship, so the step was dead from
 * every deployed install. It resolves through `FLEET_MANIFEST_DIR` now
 * (`profileManifestPath()`), which means a fixture that points
 * `FLEET_MANIFEST_DIR` at a directory with no profile manifest gets the real
 * "not found" throw. These tests passed before ONLY by falling back onto the
 * package's own copy — i.e. by riding the exact defect #58 removed. Do not
 * "simplify" this back out.
 *
 * It is a FULL profile rather than the two keys `declaredPackages` reads
 * (`profiles.<id>.toolchain.packages`), because that reader is the lenient one.
 * `loadNodeProfiles` validates hard and on purpose — power policy, sudo model,
 * chassis, trusted CIDRs, a probe-provable capability floor — and a fixture
 * built to satisfy only the lenient reader is a fixture that starts failing the
 * day anything in this directory reaches for the strict one. The test at the
 * bottom of this file spawns that loader against this very object, so the claim
 * is checked rather than asserted in a comment.
 *
 * Values are deliberately boring: TEST-NET-1 (RFC 5737) for the LAN, one
 * package, one probe-verified capability.
 */
const PROFILE = {
	role: 'runner',
	os: { distro: 'debian', codename: 'trixie', kernelExtras: {} },
	power: {
		chassis: 'desktop',
		lid: 'none',
		maskSleepTargets: ['sleep.target'],
		logind: { IdleAction: 'ignore' },
		watchdog: { modules: ['softdog'] },
	},
	users: { fleetUser: 'hadoku', sudo: 'nopasswd', groups: ['sudo'] },
	network: {
		lanCidr: '192.0.2.0/24',
		sshPort: 22,
		trustedCidrs: ['127.0.0.1/8', '192.0.2.0/24'],
		tailscale: { install: true, ssh: true, tags: ['tag:claw'] },
		sshd: { maxAuthTries: 6 },
	},
	capabilities: ['ffmpeg'],
	toolchain: { packages: ['git'], thirdPartySources: {} },
};

/** A temp manifest directory holding `machines`, plus a state dir. */
function fixture(machines) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-node-role-'));
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(
		join(manifestDir, 'fleet-runner-manifest.json'),
		JSON.stringify(
			{ toolchain: { capabilities: ['ffmpeg'], toolCache: { Python: ['3.12'] } }, machines },
			null,
			2
		)
	);
	// See PROFILE above — #58 made this the operator's directory for BOTH
	// manifests, so a fixture that declares only one of them is half a fixture.
	writeFileSync(
		join(manifestDir, 'node-profiles.json'),
		JSON.stringify({ version: 1, profiles: { 'fixture-desktop': PROFILE } }, null, 2)
	);
	return {
		root,
		manifestPath: join(manifestDir, 'fleet-runner-manifest.json'),
		profilesPath: join(manifestDir, 'node-profiles.json'),
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: manifestDir,
			HADOKU_STATE_DIR: stateDir,
			HADOKU_SITE_ROOT: root,
		},
	};
}

/**
 * Run a script. Returns `{code, out}` — never throws on a non-zero exit, and
 * `out` is STDOUT ONLY.
 *
 * Keeping stderr out of it is the point: `--json` is a contract and the cron
 * parses stdout, so a test that concatenated the two would pass on a script
 * whose payload is unparseable in production. ssh's own
 * "could not resolve hostname" goes to stderr and would have done exactly that.
 */
function run(script, args, env) {
	try {
		return {
			code: 0,
			out: execFileSync(process.execPath, [join(SCRIPTS, script), ...args], {
				encoding: 'utf8',
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 60_000,
			}),
		};
	} catch (err) {
		return { code: err.status ?? 1, out: String(err.stdout ?? '') };
	}
}

const CLAW = { cores: 8, labels: [], maxConcurrent: 2, minFreeMb: 1024, role: 'claw' };

/**
 * The identity capabilities `validateCapabilities` requires SOMEBODY to offer.
 *
 * Declared on the backstop because that is where they live on the real fleet —
 * hokon is the pm2-host — and because a fixture that breached the floor would
 * fail every assertion below for a reason that has nothing to do with roles.
 */
const BACKSTOP = {
	cores: 12,
	labels: ['pm2-host', 'taskauto', 'av1-nvenc'],
	maxConcurrent: 2,
	minFreeMb: 8192,
	role: 'backstop',
	// The backstop's labels are earned like a claw's, so it carries the record.
	$capabilities: { at: new Date().toISOString(), earned: ['pm2-host', 'av1-nvenc'] },
};

/** Role findings only — the floor rules are a different question. */
const roleRules = (findings) => findings.filter((f) => f.rule.endsWith('-role'));

// ── check-capability-schema ────────────────────────────────────────────────

test('capability-schema: a manifest whose every node declares a role passes', () => {
	const f = fixture({ 'claw-1': CLAW, hokon: BACKSTOP });
	try {
		const r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		const report = JSON.parse(r.out);
		assert.deepEqual(report.findings, [], `expected no findings, got ${r.out}`);
		assert.equal(r.code, 0);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('capability-schema: a node with NO role is a finding that names the node', () => {
	const f = fixture({ 'claw-1': CLAW, 'claw-2': { ...CLAW, role: undefined }, hokon: BACKSTOP });
	try {
		const r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		// STDOUT STAYS PARSEABLE ON A FINDING. `--json` is a contract and the cron
		// treats a non-zero exit as a finding, not a crash — a guard that died with
		// bare prose would turn every real finding into "the checker broke".
		const report = JSON.parse(r.out);
		assert.deepEqual(
			roleRules(report.findings).map((x) => [x.rule, x.machine]),
			[['missing-role', 'claw-2']]
		);
		assert.equal(r.code, 1, 'and it must fail the gate');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('capability-schema: a TYPOED role is its own rule, not the missing one', () => {
	// Different jobs: a missing role is a node nobody classified, and `gest` is a
	// node somebody classified and misspelled — which reads as `claw` at runtime
	// and counts the production host as capacity.
	const f = fixture({ 'claw-1': CLAW, hokon: { ...BACKSTOP, role: 'backstp' } });
	try {
		const r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		const report = JSON.parse(r.out);
		const roles = roleRules(report.findings);
		assert.deepEqual(
			roles.map((x) => [x.rule, x.machine]),
			[['unknown-role', 'hokon']]
		);
		assert.match(roles[0].message, /claw, backstop/, 'it must name the valid roles');
		assert.equal(r.code, 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('capability-schema: the legacy role "guest" is classified, not typoed', () => {
	// The backstop's name until 2026-10-31; the live manifest still carries it.
	const f = fixture({ 'claw-1': CLAW, hokon: { ...BACKSTOP, role: 'guest' } });
	try {
		const r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		assert.deepEqual(roleRules(JSON.parse(r.out).findings), []);
		assert.equal(r.code, 0);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ── the on-demand backstop's keys (#120) ───────────────────────────────────

const mintRules = (findings) =>
	findings.filter((f) => /mint|standing-repos/.test(f.rule)).map((x) => [x.rule, x.machine]);
const ON_DEMAND = { ...BACKSTOP, mint: 'on-demand', standingRepos: ['WolffM/hadoku_site'] };

test('capability-schema: an on-demand backstop with its standing repos passes', () => {
	const f = fixture({ 'claw-1': CLAW, hokon: ON_DEMAND });
	try {
		const r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		assert.deepEqual(mintRules(JSON.parse(r.out).findings), []);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('capability-schema: a TYPOED mint fails — it would read as a standing backstop with nothing standing', () => {
	const f = fixture({ 'claw-1': CLAW, hokon: { ...ON_DEMAND, mint: 'on-demnd' } });
	try {
		const r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		const rules = mintRules(JSON.parse(r.out).findings);
		assert.deepEqual(rules, [
			['unknown-mint', 'hokon'],
			['standing-repos-off-mint', 'hokon'],
		]);
		assert.equal(r.code, 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('capability-schema: mint on a claw, mint beside ephemeral, and a malformed list are each named', () => {
	const f = fixture({
		'claw-1': { ...CLAW, mint: 'on-demand' },
		hokon: { ...ON_DEMAND, ephemeral: true, standingRepos: ['hadoku_site'] },
	});
	try {
		const r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		assert.deepEqual(mintRules(JSON.parse(r.out).findings), [
			['mint-off-backstop', 'claw-1'],
			['mint-and-ephemeral', 'hokon'],
			['standing-repos-shape', 'hokon'],
		]);
		assert.equal(r.code, 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ── #6: services: "pm2" agrees with hadoku_site's pm2-hosts.json ───────────

const servicesRules = (findings) =>
	findings
		.filter((f) => /services|pm2-host-unprovisioned|state-root/.test(f.rule))
		.map((x) => [x.rule, x.machine]);

function withHosts(f, hosts) {
	mkdirSync(join(f.root, 'scripts'), { recursive: true });
	writeFileSync(join(f.root, 'scripts', 'pm2-hosts.json'), JSON.stringify({ hub: 'hokon', hosts }));
}

test('capability-schema #6: a services host declared in both places passes', () => {
	const f = fixture({ 'claw-4': { ...CLAW, services: 'pm2' }, hokon: BACKSTOP });
	try {
		withHosts(f, { hokon: {}, 'claw-4': { deployRoot: '/x', stateRoot: '/home/hadoku/srv-data' } });
		const r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		assert.deepEqual(servicesRules(JSON.parse(r.out).findings), []);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('capability-schema #6: a host whose stateRoot the floor does not provision is named', () => {
	// The toolchain floor creates ~/srv-data and nothing else; a host placed
	// anywhere else would have a wrapper refusing to start over an absent root.
	const f = fixture({ 'claw-4': { ...CLAW, services: 'pm2' }, hokon: BACKSTOP });
	try {
		withHosts(f, { hokon: {}, 'claw-4': { deployRoot: '/x', stateRoot: '/srv/data' } });
		const r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		assert.deepEqual(servicesRules(JSON.parse(r.out).findings), [
			['state-root-elsewhere', 'claw-4'],
		]);
		assert.equal(r.code, 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('capability-schema #6: a pm2-hosts host the manifest does not provision is named — claw-4 before this rule', () => {
	// MUTATION: drop the hosts -> declared loop and this passes clean.
	const f = fixture({ 'claw-4': CLAW, hokon: BACKSTOP });
	try {
		withHosts(f, { hokon: {}, 'claw-4': { deployRoot: '/x', stateRoot: '/home/hadoku/srv-data' } });
		const r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		assert.deepEqual(servicesRules(JSON.parse(r.out).findings), [
			['pm2-host-unprovisioned', 'claw-4'],
		]);
		assert.equal(r.code, 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('capability-schema #6: a typo, a non-host and an unreadable pm2-hosts.json are each named', () => {
	// The backstop is the hub, and the hub hosts services: declaring them there
	// is not a finding.
	const f = fixture({
		'claw-1': { ...CLAW, services: 'pm3' },
		'claw-2': { ...CLAW, services: 'pm2' },
		hokon: { ...BACKSTOP, services: 'pm2' },
	});
	try {
		withHosts(f, { hokon: {} });
		let r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		assert.deepEqual(servicesRules(JSON.parse(r.out).findings), [
			['services-shape', 'claw-1'],
			['services-not-a-host', 'claw-2'],
		]);
		rmSync(join(f.root, 'scripts', 'pm2-hosts.json'));
		r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		assert.deepEqual(
			servicesRules(JSON.parse(r.out).findings).filter(
				([rule]) => rule === 'services-unverifiable'
			),
			[['services-unverifiable', null]],
			'declared, and nothing to confirm it against, is not agreement'
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('the fixture profile is honest to the STRICT loader, not just the lenient reader', () => {
	// A lenient reader takes `profiles.<id>.toolchain.packages` and looks at
	// nothing else. So a two-key stub would make every test above pass while declaring a node with
	// no power policy, no sudo model and no trusted CIDR — precisely the "empty
	// profile is not a permissive profile" failure `node-profiles.mjs` throws to
	// prevent. This spawns that loader's own CLI against the fixture, so the
	// shape is PROVEN rather than believed, and drift in the validator shows up
	// here instead of in whatever first reaches for the strict door.
	const f = fixture({ hokon: BACKSTOP });
	try {
		const r = run('node-profiles.mjs', ['list', '--file', f.profilesPath], f.env);
		assert.equal(r.code, 0, `the strict loader rejected the fixture profile: ${r.out}`);
		assert.match(r.out, /^fixture-desktop\trunner\tdebian\/trixie\tdesktop$/m);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('the built dist the gates import is present', async () => {
	// The gate imports `../dist/lib/node-role.js`. A source checkout that has
	// not been built fails LOUDLY on that import rather than skipping the rule,
	// and this names the cause when it does.
	//
	// MUST be `async` + `awaited`: `assert.doesNotReject` returns a promise, and
	// a sync test callback that never awaits it reports PASS before the import
	// even settles — the rejection becomes an unhandled rejection attributed to
	// nothing, not a failure of this test (2026-11-01 test audit).
	await assert.doesNotReject(() => import(join(ROOT, 'dist', 'lib', 'node-role.js')));
});
