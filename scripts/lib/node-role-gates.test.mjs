/**
 * THE GATES THAT READ `machines[<node>].role`, RUN FOR REAL.
 *
 * `src/tests/node-role.test.ts` proves the predicate. Proving the predicate is
 * worth nothing on its own — what regresses is the WIRING: that
 * `capability-schema` actually refuses a manifest with no role, that it still
 * emits parseable JSON when it does (the cron reads stdout BEFORE the exit
 * code), and that `converge-toolchain` skips a guest VISIBLY instead of
 * silently. Only spawning them shows all of that, which is the same argument
 * `zero-scan-guard.test.mjs` makes for `reconcile`.
 *
 * Both scripts are driven against a TEMP manifest, never the operator's, and
 * neither reaches a node: `capability-schema` is pure, and `converge-toolchain`
 * returns before its first `ssh` on the case under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
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
		watchdog: { modules: ['softdog'], maxLoadPerCore: 8 },
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
 * Declared on the guest because that is where they live on the real fleet —
 * hokon is the pm2-host — and because a fixture that breached the floor would
 * fail every assertion below for a reason that has nothing to do with roles.
 */
const GUEST = {
	cores: 12,
	labels: ['pm2-host', 'taskauto', 'av1-nvenc'],
	maxConcurrent: 2,
	minFreeMb: 8192,
	role: 'guest',
};

/** Role findings only — the floor rules are a different question. */
const roleRules = (findings) => findings.filter((f) => f.rule.endsWith('-role'));

// ── check-capability-schema ────────────────────────────────────────────────

test('capability-schema: a manifest whose every node declares a role passes', () => {
	const f = fixture({ 'claw-1': CLAW, hokon: GUEST });
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
	const f = fixture({ 'claw-1': CLAW, 'claw-2': { ...CLAW, role: undefined }, hokon: GUEST });
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
	// and puts the guest back into the fleet chain.
	const f = fixture({ 'claw-1': CLAW, hokon: { ...GUEST, role: 'gest' } });
	try {
		const r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		const report = JSON.parse(r.out);
		const roles = roleRules(report.findings);
		assert.deepEqual(
			roles.map((x) => [x.rule, x.machine]),
			[['unknown-role', 'hokon']]
		);
		assert.match(roles[0].message, /claw, guest/, 'it must name the valid roles');
		assert.equal(r.code, 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ── the on-demand guest's keys (#120) ──────────────────────────────────────

const mintRules = (findings) =>
	findings.filter((f) => /mint|standing-repos/.test(f.rule)).map((x) => [x.rule, x.machine]);
const ON_DEMAND = { ...GUEST, mint: 'on-demand', standingRepos: ['WolffM/hadoku_site'] };

test('capability-schema: an on-demand guest with its standing repos passes', () => {
	const f = fixture({ 'claw-1': CLAW, hokon: ON_DEMAND });
	try {
		const r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		assert.deepEqual(mintRules(JSON.parse(r.out).findings), []);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('capability-schema: a TYPOED mint fails — it would read as a standing guest with nothing standing', () => {
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
			['mint-off-guest', 'claw-1'],
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
	const f = fixture({ 'claw-4': { ...CLAW, services: 'pm2' }, hokon: GUEST });
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
	const f = fixture({ 'claw-4': { ...CLAW, services: 'pm2' }, hokon: GUEST });
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
	const f = fixture({ 'claw-4': CLAW, hokon: GUEST });
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

test('capability-schema #6: a typo, a guest, a non-host and an unreadable pm2-hosts.json are each named', () => {
	const f = fixture({
		'claw-1': { ...CLAW, services: 'pm3' },
		'claw-2': { ...CLAW, services: 'pm2' },
		hokon: { ...GUEST, services: 'pm2' },
	});
	try {
		withHosts(f, { hokon: {} });
		let r = run('check-capability-schema.mjs', ['--manifest', f.manifestPath, '--json'], f.env);
		assert.deepEqual(servicesRules(JSON.parse(r.out).findings), [
			['services-shape', 'claw-1'],
			['services-shape', 'hokon'],
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

test('#120: fleet throttle asks the MINT predicate, never `ephemeral` — or an on-demand guest gets no slot env', () => {
	// Shipped 0.34.0 with one call site still reading `m.ephemeral === true`:
	// the dry run reported "hokon has no jit-provision.sh", --confirm wrote
	// nothing, and every mint on the guest would have failed at step one. The
	// slot env and the payload check are questions about the MINT PATH, which
	// an on-demand guest is on and `ephemeral` does not see. (The provisioner
	// itself has travelled with each mint since 2026-10-27.)
	const src = blankComments(readFileSync(join(SCRIPTS, 'deploy-ci-throttle.mjs'), 'utf8'));
	assert.deepEqual(src.match(/\.ephemeral\s*[!=]==/g) ?? [], []);
	assert.equal(
		(src.match(/mintsJitRunners\(m\)/g) ?? []).length,
		2,
		'the slot env (MINTS) and the payload check'
	);
});

// ── converge-toolchain ─────────────────────────────────────────────────────

test('converge-toolchain: a guest is SKIPPED, and the skip is printed and reported', () => {
	const f = fixture({ hokon: GUEST });
	try {
		const r = run('converge-toolchain.mjs', ['--machine', 'hokon', '--json'], f.env);
		const report = JSON.parse(r.out);
		assert.deepEqual(
			report.nodes.map((n) => [n.node, n.status]),
			[['hokon', 'guest']],
			'the guest must still appear in the report — a silent skip is how a node stops being checked'
		);
		assert.equal(report.guestsSkipped, 1);
		// ZERO NODES ACTUALLY LOOKED AT IS NOT A PASS, even when every skip was
		// deliberate: `--machine hokon` converges nothing, and exit 0 there is
		// "I could not look" wearing "I chose not to look" as a costume.
		assert.equal(report.ok, false);
		assert.equal(r.code, 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('converge-toolchain: MUTATION — the same node as a CLAW is not skipped', () => {
	// The control. Without it the test above passes on a script that skips every
	// node, or on a fixture that simply has nothing to converge. A claw is
	// probed, which here means an ssh to a name that does not resolve — so the
	// node is UNREADABLE, which is itself a failure and not a skip.
	const f = fixture({ 'node-role-test-absent.invalid': { ...CLAW, role: 'claw' } });
	try {
		const r = run(
			'converge-toolchain.mjs',
			['--machine', 'node-role-test-absent.invalid', '--json'],
			f.env
		);
		const report = JSON.parse(r.out);
		assert.deepEqual(
			report.nodes.map((n) => n.status),
			['unreadable'],
			'a claw is looked at, and failing to look at it is a finding'
		);
		assert.equal(report.guestsSkipped, 0);
		assert.equal(r.code, 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('converge-toolchain: --include-guests is the door, and it has to be typed', () => {
	// The override must reach the OBSERVE path, not merely change the counter.
	// `.invalid` is RFC 6761 reserved, so the resolver answers NXDOMAIN without
	// asking anything and the ssh fails immediately rather than walking the
	// operator's search list — the flake `doctor-write.test.mjs` documents.
	const f = fixture({ 'node-role-test-absent.invalid': { ...CLAW, role: 'guest' } });
	try {
		const r = run(
			'converge-toolchain.mjs',
			['--machine', 'node-role-test-absent.invalid', '--include-guests', '--json'],
			f.env
		);
		const report = JSON.parse(r.out);
		assert.deepEqual(
			report.nodes.map((n) => n.status),
			['unreadable']
		);
		assert.equal(report.guestsSkipped, 0);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('the fixture profile is honest to the STRICT loader, not just the lenient reader', () => {
	// `converge-toolchain` reads profiles through `declaredPackages`, which takes
	// `profiles.<id>.toolchain.packages` and looks at nothing else. So a
	// two-key stub would make every test above pass while declaring a node with
	// no power policy, no sudo model and no trusted CIDR — precisely the "empty
	// profile is not a permissive profile" failure `node-profiles.mjs` throws to
	// prevent. This spawns that loader's own CLI against the fixture, so the
	// shape is PROVEN rather than believed, and drift in the validator shows up
	// here instead of in whatever first reaches for the strict door.
	const f = fixture({ hokon: GUEST });
	try {
		const r = run('lib/node-profiles.mjs', ['list', '--file', f.profilesPath], f.env);
		assert.equal(r.code, 0, `the strict loader rejected the fixture profile: ${r.out}`);
		assert.match(r.out, /^fixture-desktop\trunner\tdebian\/trixie\tdesktop$/m);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('the built dist the gates import is present', () => {
	// Both scripts import `../dist/lib/node-role.js`. A source checkout that has
	// not been built fails LOUDLY on that import rather than skipping the rule,
	// and this names the cause when it does.
	assert.doesNotReject(() => import(join(ROOT, 'dist', 'lib', 'node-role.js')));
});
