import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tempDir } from './test-tmpdir.mjs';
import { fileURLToPath } from 'node:url';

import {
	REPAIRS,
	declaredPackages,
	parseObservation,
	toolAppliesTo,
	applicableRepairs,
	installScript,
	linkScript,
	minAgeOf,
	isVersionManaged,
	resolveInstallTarget,
	JDK21_MIN_INSTALLED_MB,
	JDK21_CANARY_MIN_THREADS,
	installedMb,
	qualifiesForCanary,
} from './toolchain-floor.mjs';
import {
	DEFAULT_MIN_AGE_MINUTES,
	parseInstalledVersion,
	createReleaseLookup,
} from './tool-release.mjs';

const tmp = () => tempDir('toolchain-floor-');
// Anything that puts a directory a login shell would add in front of a detector.
const WIDENING = /\.cargo\/bin|\.local\/bin|PATH=|bash -l|bash --login|-lc\b|\. ~?\/?\.profile/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function profilesFile(profiles) {
	const dir = tmp();
	const p = join(dir, 'node-profiles.json');
	writeFileSync(p, JSON.stringify({ version: 1, profiles }));
	return p;
}

/**
 * A missing declaration must THROW, never resolve to an empty floor.
 *
 * Same rule the manifest resolver follows and for the same reason: a floor of
 * zero packages reports every node in the fleet perfectly converged, which is
 * the "exit 0 with no evidence" shape this repo refuses everywhere else.
 */
test('a missing profiles file THROWS rather than yielding an empty floor', () => {
	assert.throws(() => declaredPackages('/nonexistent/node-profiles.json'), /not found/);
	assert.throws(() => declaredPackages(undefined), /not found/);
});

test('a file that declares no profiles throws too', () => {
	assert.throws(() => declaredPackages(profilesFile({})), /declares no profiles/);
});

/**
 * The floor is the INTERSECTION, not the union.
 *
 * A package only one chassis declares is that chassis's business — converging a
 * desktop toward a laptop's set installs things for hardware it does not have,
 * and the failure would look like the profile being wrong rather than the
 * convergence being wrong.
 */
test('the floor is what every profile agrees on; the rest is reported, not installed', () => {
	const p = profilesFile({
		'desktop-debian-trixie': { toolchain: { packages: ['git', 'cmake', 'nvidia-driver'] } },
		'laptop-debian-trixie': { toolchain: { packages: ['git', 'cmake', 'libwacom-surface'] } },
	});
	const { common, divergent, profileIds } = declaredPackages(p);
	assert.deepEqual(common, ['git', 'cmake']);
	assert.deepEqual(divergent, ['libwacom-surface', 'nvidia-driver']);
	assert.equal(profileIds.length, 2);
});

test('$comment keys are not profiles', () => {
	const p = profilesFile({
		$why: 'prose',
		only: { toolchain: { packages: ['git'] } },
	});
	assert.deepEqual(declaredPackages(p).common, ['git']);
});

/**
 * THE PATH LESSON, held as an invariant.
 *
 * On 2026-09-10 every claw was given rustup and a hand-check over ssh passed on
 * all seven, because the check exported ~/.cargo/bin first the way a login
 * shell does. A workflow `run:` step gets the stock PATH and sources no
 * profile, so brave-quartet's first fleet run died on `rustup: command not
 * found` against seven boxes that all "had" rustup. A detector that reaches
 * into ~/.cargo/bin asks a question no CI step ever asks, and would go green on
 * exactly the state that was broken.
 */
test('no detector widens PATH — that is the bug this table exists to prevent', () => {
	for (const [id, r] of Object.entries(REPAIRS)) {
		assert.ok(r.detect, `${id} has no detector`);
		assert.doesNotMatch(
			r.detect,
			WIDENING,
			`${id}'s detector widens PATH — it would pass on a node whose CI cannot see the binary`
		);
		if (r.version) {
			assert.doesNotMatch(r.version, WIDENING, `${id}'s version reader widens PATH`);
		}
	}
});

// INVARIANT 1, for the tool that is the whole finding. Claw-8 answered a login
// shell with a path and a stock one with NOT-ON-PATH; any of these tokens in a
// detector reproduces that green.
test('the claude detector and version reader use the stock PATH', () => {
	for (const field of ['detect', 'version']) {
		assert.ok(REPAIRS.claude[field], `claude has no ${field}`);
		assert.doesNotMatch(REPAIRS.claude[field], WIDENING);
	}
	assert.match(REPAIRS.claude.detect, /claude --version/, 'must EXECUTE it, not only find it');
});

test('every repair states WHY, because a finding without one is not actionable', () => {
	for (const [id, r] of Object.entries(REPAIRS)) {
		assert.ok(r.why && r.why.length > 30, `${id} needs a real why`);
		assert.ok(r.repair && r.repair.length > 0, `${id} needs a repair`);
	}
});

/**
 * The rust repair must ALWAYS re-link, not only when rustup is absent.
 *
 * The broken state that shipped was rustup PRESENT and the proxies unreachable.
 * A repair that installs-then-links only on the install path leaves that exact
 * node broken forever, because its `if` never fires.
 */
test('the rust repair re-links even when rustup is already installed', () => {
	const lines = REPAIRS.rust.repair.split('\n');
	const fi = lines.findIndex((l) => l.trim() === 'fi');
	const link = lines.findIndex((l) => l.includes('/usr/local/bin/$b'));
	assert.ok(fi >= 0 && link > fi, 'the symlink loop must sit OUTSIDE the install guard');
});

test('docker is detected by the DAEMON, not the CLI', () => {
	// A present CLI with no daemon is a build that fails at the first step.
	assert.match(REPAIRS.docker.detect, /docker info/);
	assert.doesNotMatch(REPAIRS.docker.detect, /command -v docker\b.*&& echo OK/);
});

test('parseObservation reads missing packages and broken capabilities', () => {
	const out = [
		'PKG-MISSING libasound2',
		'PKG-MISSING libcups2',
		'REPAIR rust OK',
		'REPAIR docker MISSING',
		'REPAIR rust-wasm32 OK',
	].join('\n');
	const o = parseObservation(out);
	assert.deepEqual(o.missingPackages, ['libasound2', 'libcups2']);
	assert.deepEqual(o.brokenCapabilities, ['docker']);
});

test('a clean node parses as clean, and empty output is not a crash', () => {
	assert.deepEqual(parseObservation('REPAIR rust OK'), {
		missingPackages: [],
		brokenCapabilities: [],
	});
	assert.deepEqual(parseObservation(''), { missingPackages: [], brokenCapabilities: [] });
});

// ── WHERE THE FLOOR IS READ FROM (issue #58) ────────────────────────────────
//
// `declaredPackages` was always right about a path it was HANDED. The bug was
// the hand: `converge-toolchain.mjs` defaulted to
// `join(__dirname, '..', 'manifests', 'node-profiles.json')`, which resolves
// inside a source checkout and NOWHERE ELSE — `manifests/` is deliberately not
// in package.json `files`, because it is operator config rather than package
// content. From the CLI as it is actually installed
// (`node_modules/@wolffm/fleet-manager/`) that directory does not exist, so
// `fleet provision`'s converge step died before contacting a single node.
// Measured against the published 0.24.14 on 2026-09-24.
//
// THESE TESTS RUN THE SCRIPT, not the library, because the defect was never
// visible from the library — every one of the unit tests above passed
// throughout. The observable is which FILE the run reports reading.
//
// Nothing is contacted: the fixture's one machine is a GUEST, which
// converge-toolchain skips by role and then refuses to call a pass. So the
// exit code is 1 in every case here and cannot tell the outcomes apart — the
// floor line on stdout and the refusal on stderr are what distinguish them,
// and that is the whole claim under test.

function fleetFixture({ profiles = null } = {}) {
	const root = tmp();
	const manifestDir = join(root, 'admin');
	const stateDir = join(root, 'state');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(
		join(manifestDir, 'fleet-runner-manifest.json'),
		JSON.stringify({
			toolchain: { capabilities: [] },
			machines: { 'fixture-guest.invalid': { role: 'guest', labels: [] } },
		})
	);
	if (profiles) {
		writeFileSync(
			join(manifestDir, 'node-profiles.json'),
			JSON.stringify({ version: 1, profiles })
		);
	}
	return { root, manifestDir, stateDir };
}

function converge(f, extraEnv = {}) {
	const env = { ...process.env, FLEET_MANIFEST_DIR: f.manifestDir, HADOKU_STATE_DIR: f.stateDir };
	delete env.FLEET_NODE_PROFILES;
	try {
		const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'converge-toolchain.mjs')], {
			encoding: 'utf8',
			env: { ...env, ...extraEnv },
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 60_000,
		});
		return { code: 0, out, err: '' };
	} catch (e) {
		return { code: e.status ?? 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
	}
}

test('the toolchain floor is read through FLEET_MANIFEST_DIR, not from beside the script', () => {
	const f = fleetFixture({
		profiles: { 'fixture-desktop': { toolchain: { packages: ['git', 'fixture-only-package'] } } },
	});
	try {
		const r = converge(f);
		// The fixture's profile id, which the package's own manifests/ copy does
		// not declare. Pre-fix this line read `(desktop-debian-trixie,
		// laptop-debian-trixie)` — the repo's file, in a run that had been told
		// where the operator's manifests live.
		assert.match(r.out, /\(fixture-desktop\)/, `floor line came from elsewhere:\n${r.out}`);
		assert.match(r.out, /2 packages common to 1 profile\(s\)/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a manifest directory with no node-profiles.json FAILS, and says which door to use', () => {
	// THE MUTATION SIGNAL. `manifests/node-profiles.json` EXISTS in a source
	// checkout, so the old `__dirname` default made this case succeed quietly by
	// reading the package's own copy — the same silent fallback that reads as a
	// converged fleet from an install where the file is absent altogether.
	assert.ok(
		existsSync(join(ROOT, 'manifests', 'node-profiles.json')),
		'the source checkout must carry manifests/node-profiles.json for this test to mean ' +
			'anything — it is the file the old default silently fell back to'
	);
	const f = fleetFixture({ profiles: null });
	try {
		const r = converge(f);
		assert.equal(r.code, 1);
		assert.match(r.err, /node-profiles\.json not found/);
		assert.match(
			r.err,
			/FLEET_MANIFEST_DIR/,
			'the advice must name the resolver, not only the override'
		);
		// Resolved THROUGH the environment, and not out of the package.
		assert.match(r.err, new RegExp(f.manifestDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
		assert.doesNotMatch(
			r.err,
			/manifests\/node-profiles\.json/,
			'it fell back to the package-relative path — the exact #58 defect'
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('FLEET_NODE_PROFILES still overrides, for a stick copy or a fixture set', () => {
	const f = fleetFixture({
		profiles: { 'fixture-desktop': { toolchain: { packages: ['git'] } } },
	});
	const override = profilesFile({ 'stick-copy': { toolchain: { packages: ['git', 'jq'] } } });
	try {
		const r = converge(f, { FLEET_NODE_PROFILES: override });
		assert.match(r.out, /\(stick-copy\)/, `the override was ignored:\n${r.out}`);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ── ONE DECLARATION, THREE CONSUMERS (issue #69) ────────────────────────────

const claw = (labels, extra = {}) => ({ role: 'claw', labels, ...extra });

test('claude is scoped to taskauto, and rust stays on every managed node', () => {
	assert.equal(REPAIRS.claude.when, 'taskauto');
	assert.equal(REPAIRS.rust.when, undefined);
	assert.equal(REPAIRS['rust-wasm32'].when, undefined);
});

/**
 * docker since the node-users cutover: every node whose CI is still admin (the
 * docker group serves it), and a cut-over node only when it declares
 * `containers: "docker"`. A cut-over node without it is owed nothing: its ci
 * user has no group, and the `docker` label routes the job elsewhere.
 */
test('docker: every node before its cutover; after it, only containers: "docker"', () => {
	const cutOver = { users: { ci: 'hadoku-ci' } };
	assert.equal(toolAppliesTo('docker', claw([])), true, 'CI is admin: the group path');
	assert.equal(toolAppliesTo('docker', claw([], cutOver)), false, 'no rootless daemon declared');
	assert.equal(toolAppliesTo('docker', claw([], { ...cutOver, containers: 'docker' })), true);
	assert.equal(toolAppliesTo('docker', { role: 'guest', containers: 'docker' }), false);
	assert.equal(String(REPAIRS.docker.when), 'CI as admin, or containers: "docker"');
});

test('docker repair: the group path for admin CI, a rootless daemon in the ci manager after', () => {
	const plain = installScript('docker');
	assert.equal(plain, REPAIRS.docker.repair, 'no ci user: nothing prepended');
	const cut = installScript('docker', undefined, { ciUser: 'hadoku-ci' });
	assert.match(cut, /^CI_USER='hadoku-ci'\nexport CI_USER\n/);
	assert.match(REPAIRS.docker.repair, /if \[ "\$CI" = "\$USER" \]/);
	assert.match(REPAIRS.docker.repair, /dockerd-rootless-setuptool\.sh install/);
	assert.match(REPAIRS.docker.repair, /docker context use rootless/);
	// The rootless branch never touches the group: that is the escalation it replaces.
	const rootless = REPAIRS.docker.repair.split('# ROOTLESS')[1];
	assert.doesNotMatch(rootless, /usermod -aG docker/);
	for (const bad of ["x'; id; '", 'Root', '$(id)', ''])
		assert.throws(() => installScript('docker', undefined, { ciUser: bad }), /refusing ci user/);
});

/**
 * INVARIANT 2. The scoped tool is answered by nodeOffer — the derivation the
 * mint uses. `taskauto` is ASSIGNED (kind identity, verify role), so a node
 * with no bootcamp record at all still carries it by declaration. Reading
 * `$capabilities.earned` alone would have said nobody does.
 */
test('a node that offers taskauto carries claude; one that does not neither gets it nor is judged for it', () => {
	assert.equal(toolAppliesTo('claude', claw(['taskauto'])), true);
	assert.equal(toolAppliesTo('claude', claw(['ffmpeg'])), false);
	assert.equal(toolAppliesTo('claude', claw([])), false);
	assert.equal(toolAppliesTo('claude', {}), false);
	const ids = applicableRepairs(claw(['ffmpeg'])).map(([id]) => id);
	assert.ok(!ids.includes('claude'));
	assert.ok(ids.includes('rust') && ids.includes('docker'), 'unscoped tools still apply');
	assert.ok(
		applicableRepairs(claw(['taskauto']))
			.map(([id]) => id)
			.includes('claude')
	);
});

test('an unscoped tool applies to every managed node, and nothing applies to a guest BY DEFAULT', () => {
	assert.equal(toolAppliesTo('rust', claw([])), true);
	assert.equal(toolAppliesTo('rust', { labels: [] }), true, 'absent role reads as claw');
	const guest = { role: 'guest', labels: ['taskauto'] };
	for (const id of Object.keys(REPAIRS)) assert.equal(toolAppliesTo(id, guest), false, id);
	assert.deepEqual(applicableRepairs(guest), []);
	// The omitted third argument is the same as `{ includeGuests: false }` —
	// every mutating caller (bootcamp, converge-toolchain, the refresh cycle)
	// calls it this way and MUST keep seeing an empty guest.
	for (const id of Object.keys(REPAIRS)) {
		assert.equal(toolAppliesTo(id, guest, { includeGuests: false }), false, id);
	}
	assert.deepEqual(applicableRepairs(guest, { includeGuests: false }), []);
});

/**
 * `includeGuests: true` is the ONE door that lifts the guest exclusion
 * (issue #75: `fleet toolchain --machine hokon --include-guests` reported
 * `drift=false` with `tools: []`, because this exclusion was unconditional).
 * MUTATION: drop the `&& !includeGuests` in `toolAppliesTo` and the "still
 * nothing applies without the flag" half of this test fails — the door would
 * always be open, which is a guest getting REPAIRED, not just read.
 */
test('includeGuests lifts the guest exclusion for VERIFICATION, and only when asked', () => {
	const guest = { role: 'guest', labels: ['taskauto'] };
	assert.equal(toolAppliesTo('rust', guest, { includeGuests: true }), true, 'unscoped applies');
	assert.equal(toolAppliesTo('docker', guest, { includeGuests: true }), true, 'unscoped applies');
	assert.equal(
		toolAppliesTo('claude', guest, { includeGuests: true }),
		true,
		'taskauto is declared, so the scoped tool applies too'
	);
	const guestNoTaskauto = { role: 'guest', labels: [] };
	assert.equal(
		toolAppliesTo('claude', guestNoTaskauto, { includeGuests: true }),
		false,
		'the `when` scoping still applies — includeGuests only lifts the ROLE check'
	);
	const ids = applicableRepairs(guest, { includeGuests: true }).map(([id]) => id);
	assert.deepEqual(ids.sort(), [
		'claude',
		'docker',
		'ffmpeg',
		'gh',
		'jdk21',
		'rust',
		'rust-wasm32',
	]);
	// Still nothing without the flag, same guest object.
	assert.deepEqual(applicableRepairs(guest), []);
});

test('an unknown tool id throws rather than answering false', () => {
	assert.throws(() => toolAppliesTo('nope', claw([])), /unknown tool/);
});

test('minAge defaults to the pnpm number, in minutes, and is overridable per tool', () => {
	assert.equal(DEFAULT_MIN_AGE_MINUTES, 10080);
	assert.equal(minAgeOf(REPAIRS.claude), 10080);
	assert.equal(minAgeOf({ minAge: 60 }), 60);
	assert.equal(minAgeOf({ minAge: 'soon' }), 10080);
});

test('claude declares version and latest; rust and docker are presence-only', () => {
	assert.equal(isVersionManaged(REPAIRS.claude), true);
	assert.equal(REPAIRS.claude.latest.source.package, '@anthropic-ai/claude-code');
	assert.equal(isVersionManaged(REPAIRS.rust), false);
	assert.equal(isVersionManaged(REPAIRS.docker), false);
});

/** The three things claw-8 lacked, each asserted on the install text. */
test('the claude install yields the binary, the ~/.local/bin link AND a stock-PATH link', () => {
	const t = REPAIRS.claude.repair;
	assert.match(t, /claude\.ai\/install\.sh/, 'the binary');
	assert.match(
		t,
		/ln -sfn .*\.local\/share\/claude\/versions.*\.local\/bin\/claude/,
		'the symlink'
	);
	assert.match(
		t,
		/ln -sfn "\$HOME\/\.local\/bin\/claude" \/usr\/local\/bin\/claude/,
		'non-login PATH'
	);
	const lines = t.split('\n');
	const fi = lines.findIndex((l) => l.trim() === 'fi');
	const path = lines.findIndex((l) => l.includes('/usr/local/bin/claude'));
	assert.ok(
		path > fi,
		'the links must sit OUTSIDE the install guard, or a node with the binary stays broken'
	);
});

test('installScript pins a version, and refuses anything that is not strict x.y.z', () => {
	assert.match(installScript('claude', '2.1.285'), /^TARGET_VERSION='2\.1\.285'\n/);
	// rust/docker are presence-only: no version to bypass, bare is correct.
	assert.equal(installScript('rust'), REPAIRS.rust.repair);
	assert.equal(installScript('docker'), REPAIRS.docker.repair);
	for (const bad of ["1.2.3'; rm -rf ~; '", '2.1', '2.1.285-beta', '$(id)']) {
		assert.throws(() => installScript('claude', bad), /non x\.y\.z/);
	}
});

/**
 * THE MUTATION SIGNAL FOR #70. `bootcamp.mjs:277` called `installScript(id)`
 * with no version, which for a version-managed tool used to return the raw
 * `repair` text — the vendor's install script with no `$TARGET_VERSION`, i.e.
 * whatever it had published an hour ago. That bypassed the 7-day debounce on
 * exactly the path that puts a tool on a FRESH node. A version-managed tool
 * now has NO reachable bare call: the debounced release must come from
 * {@link resolveInstallTarget} first, for every caller, forever.
 */
test('installScript refuses a version-managed tool with no version — that was the vendor-latest bypass (#70)', () => {
	assert.throws(() => installScript('claude'), /needs a resolved version/);
	assert.throws(() => installScript('claude', undefined), /needs a resolved version/);
	assert.throws(() => installScript('claude', null), /needs a resolved version/);
});

test('resolveInstallTarget: presence-only tools have nothing to resolve', async () => {
	assert.deepEqual(await resolveInstallTarget(REPAIRS.rust), { status: 'presence-only' });
	assert.deepEqual(await resolveInstallTarget(REPAIRS.docker), { status: 'presence-only' });
});

test('resolveInstallTarget: a version-managed tool resolves through the injected lookup, debounce minAge included', async () => {
	// Anchored to Date.now(), not a literal ISO string: a fixture dated in the
	// past is read by the retention cutoff on its own clock, independent of
	// whether anything in THIS test ages it (fixture-clock-guard.test.mjs).
	const publishedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
	let seenSource, seenOpts;
	const lookup = async (source, opts) => (
		(seenSource = source),
		(seenOpts = opts),
		{ status: 'known', version: '2.1.283', publishedAt }
	);
	const r = await resolveInstallTarget(REPAIRS.claude, { lookup });
	assert.deepEqual(r, { status: 'known', version: '2.1.283', publishedAt });
	assert.equal(seenSource, REPAIRS.claude.latest.source);
	assert.equal(seenOpts.minAge, minAgeOf(REPAIRS.claude));
});

/**
 * "COULD NOT LOOK" REFUSES, IT NEVER FALLS BACK (#70's other half). An
 * unreachable or malformed registry answer must come back `unknown` with the
 * reason carried — never a version, and never silently treated as "nothing to
 * pin" so the caller falls through to a bare install.
 */
test('resolveInstallTarget: an unresolved lookup is unknown with the reason, never a version', async () => {
	const lookup = async () => ({ status: 'unknown', reason: 'rate limited (HTTP 429)' });
	const r = await resolveInstallTarget(REPAIRS.claude, { lookup });
	assert.equal(r.status, 'unknown');
	assert.match(r.reason, /429/);
	assert.equal(r.version, undefined);
});

// ---------------------------------------------------------------------------
// The claude install/link TEXT, EXECUTED under bash with stub curl/sudo and a
// fake HOME — the scripts decide whether a binary is moved, so they are run, not
// grepped. Nothing here touches a real node or the real /usr/local/bin.
// ---------------------------------------------------------------------------

/** A fake HOME. `bin` = what ~/.local/bin/claude reports; `versions` = versions/ entries. */
function fakeNode({ bin, versions = [] }) {
	const root = tmp();
	const home = join(root, 'home');
	const stubs = join(root, 'stubs');
	mkdirSync(join(home, '.local', 'bin'), { recursive: true });
	mkdirSync(stubs);
	const log = join(root, 'log');
	writeFileSync(log, '');
	if (bin !== undefined) {
		const f = join(home, '.local', 'bin', 'claude');
		writeFileSync(f, `#!/bin/sh\n[ -n "${bin}" ] && echo "${bin} (Claude Code)"\n`);
		chmodSync(f, 0o755);
	}
	for (const v of versions) {
		mkdirSync(join(home, '.local', 'share', 'claude', 'versions'), { recursive: true });
		const f = join(home, '.local', 'share', 'claude', 'versions', v);
		writeFileSync(f, '#!/bin/sh\n');
		chmodSync(f, 0o755);
	}
	writeFileSync(join(stubs, 'curl'), `#!/bin/sh\necho 'echo INSTALLER-RAN >> "${log}"'\n`);
	writeFileSync(
		join(stubs, 'sudo'),
		`#!/bin/sh\necho "sudo $*" >> "${log}"\n[ -z "$SUDO_FAIL" ]\n`
	);
	chmodSync(join(stubs, 'curl'), 0o755);
	chmodSync(join(stubs, 'sudo'), 0o755);
	const run = (script, env = {}) => {
		const r = spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
			encoding: 'utf8',
			env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: home, TMPDIR: tempDir('tf-tmp-'), ...env },
		});
		return { status: r.status, stderr: r.stderr, log: readFileSync(log, 'utf8') };
	};
	return { run };
}

test('the install script NEVER downgrades: installed 2.1.284 with a 2.1.281 pin runs no installer', () => {
	const r = fakeNode({ bin: '2.1.284' }).run(installScript('claude', '2.1.281'));
	assert.equal(r.status, 0, r.stderr);
	assert.doesNotMatch(r.log, /INSTALLER-RAN/);
	assert.match(
		r.log,
		/sudo -n ln -sfn .*\.local\/bin\/claude \/usr\/local\/bin\/claude/,
		'still links'
	);
});

test('the install script upgrades when the pin is strictly newer, installs when nothing is there, and skips an equal version', () => {
	assert.match(
		fakeNode({ bin: '2.1.280' }).run(installScript('claude', '2.1.281')).log,
		/INSTALLER-RAN/
	);
	assert.match(fakeNode({}).run(installScript('claude', '2.1.281')).log, /INSTALLER-RAN/);
	assert.doesNotMatch(
		fakeNode({ bin: '2.1.281' }).run(installScript('claude', '2.1.281')).log,
		/INSTALLER-RAN/
	);
	// 2.1.9 vs 2.1.10 — a string compare would say 2.1.9 is newer.
	assert.match(
		fakeNode({ bin: '2.1.9' }).run(installScript('claude', '2.1.10')).log,
		/INSTALLER-RAN/
	);
});

test('a present binary whose version is UNREADABLE is never reinstalled over, pinned low or run with no pin at all', () => {
	// Pinned, but not an upgrade over the versions/ fallback (2.1.284): skipped.
	const pinned = fakeNode({ bin: '', versions: ['2.1.284'] }).run(
		installScript('claude', '2.1.281')
	);
	assert.equal(pinned.status, 0, pinned.stderr);
	assert.doesNotMatch(pinned.log, /INSTALLER-RAN/);
	// The RAW repair text, run with no $TARGET_VERSION at all — the shape
	// `installScript(id, version)` builds when a caller DOES have a resolved
	// version; `REPAIRS.claude.repair` is exercised directly here because
	// `installScript('claude')` with no version now throws (#70) rather than
	// handing out this text. The shell script's own fallback must still never
	// reinstall over a binary it cannot read a version from.
	const bare = fakeNode({ bin: '', versions: ['2.1.284'] }).run(REPAIRS.claude.repair);
	assert.equal(bare.status, 0, bare.stderr);
	assert.doesNotMatch(bare.log, /INSTALLER-RAN/);
});

test('link: creates the stock-PATH link, never runs the installer, and fails with a reason when there is no binary', () => {
	assert.equal(linkScript('claude'), REPAIRS.claude.link);
	assert.equal(linkScript('rust'), null);
	const ok = fakeNode({ bin: '2.1.284' }).run(linkScript('claude'));
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.log, /sudo -n ln -sfn .*\.local\/bin\/claude \/usr\/local\/bin\/claude/);
	assert.doesNotMatch(ok.log, /INSTALLER-RAN/);
	const none = fakeNode({}).run(linkScript('claude'));
	assert.notEqual(none.status, 0);
	assert.match(none.stderr, /a link cannot fix that/);
	const nosudo = fakeNode({ bin: '2.1.284' }).run(linkScript('claude'), { SUDO_FAIL: '1' });
	assert.notEqual(nosudo.status, 0, 'a failed sudo must fail the link');
});

test('the install repair ends with the SAME link text, so the two cannot drift', () => {
	const tail = REPAIRS.claude.link.split('\n').slice(1).join('\n');
	assert.ok(REPAIRS.claude.repair.endsWith(tail));
});

// ── jdk21 / maven (cardtable#5, added 2026-10-05) ───────────────────────────
//
// forge-e2e/forge-jvm move off the production host onto claws with room for
// the JVM footprint. Two things are new here that nothing above exercises: a `when`
// that is a MEMORY PREDICATE rather than a capability id, and a `repair` that
// downloads a tarball and must refuse one whose checksum does not match
// BEFORE extracting it.

const claw15gb = { role: 'claw', labels: [], ramGb: 15, $measured: { memTotalMb: 15936 } };
const claw7gb = { role: 'claw', labels: [], ramGb: 7, $measured: { memTotalMb: 7849 } };
const claw11gbDeclaredOnly = { role: 'claw', labels: [], ramGb: 11 }; // no $measured — claw-1/2/3's own shape
const guest15gb = { role: 'guest', labels: [], ramGb: 61, $measured: { memTotalMb: 62000 } };

test('installedMb prefers $measured.memTotalMb, falls back to declared ramGb, and is null for neither', () => {
	assert.equal(installedMb(claw15gb), 15936);
	assert.equal(installedMb(claw11gbDeclaredOnly), 11 * 1024);
	assert.equal(installedMb({ role: 'claw', labels: [] }), null);
	assert.equal(installedMb({}), null);
	// A zero or negative figure is not a measurement either.
	assert.equal(installedMb({ ramGb: 0 }), null);
	assert.equal(installedMb({ $measured: { memTotalMb: -1 } }), null);
});

test('JDK21_MIN_INSTALLED_MB sits strictly between the 11 GB and 15 GB buckets', () => {
	assert.ok(JDK21_MIN_INSTALLED_MB > 11 * 1024);
	assert.ok(JDK21_MIN_INSTALLED_MB < 15 * 1024);
});

/**
 * `tool.when` IS A FUNCTION, AND `bootcamp.mjs:338` PRINTS IT. On a successful
 * install it logs `installed for ${tool.when}` — a template literal, which
 * coerces via `toString()`. A bare arrow function's default `toString()` is
 * its own SOURCE TEXT, and that line would then land in the operator-facing
 * report (and, through `$capabilities`, in the manifest bootcamp commits) —
 * a few lines of this module read back at whoever runs `fleet bootcamp`.
 * `bootcamp.mjs` is not this repair's to edit for this; the predicate itself
 * must coerce to a sentence instead. MUTATION: remove the `.toString`
 * override and this fails (the coerced string contains `node =>` instead).
 */
test('a predicate `when` stringifies to a sentence, never its own source', () => {
	assert.equal(`${REPAIRS.maven.when}`, 'installed RAM >= 12288 MiB');
	assert.equal(String(REPAIRS.maven.when), `installed RAM >= ${JDK21_MIN_INSTALLED_MB} MiB`);
	assert.equal(`${REPAIRS.jdk21.when}`, 'every claw');
	for (const id of ['jdk21', 'maven']) assert.doesNotMatch(`${REPAIRS[id].when}`, /=>|function/);
});

/**
 * THE DONE-WHEN FOR `when`. MUTATION: hard-code `installedRamAtLeast` to
 * return `true` (or drop the `$measured`/`ramGb` floor to 0) and every
 * assertion in this test that expects `false` flips to `true` and fails.
 */
test('the JDK goes to every claw; Maven — and with it the jdk21 LABEL — only above the RAM floor', () => {
	// Since 2026-10-24 the JDK is the `java21` hosting capability every claw may
	// need (cardtable's hosting request §2). An idle JDK costs disk, not RAM.
	assert.equal(toolAppliesTo('jdk21', claw15gb), true);
	assert.equal(toolAppliesTo('jdk21', claw7gb), true);
	assert.equal(toolAppliesTo('jdk21', claw11gbDeclaredOnly), true);
	assert.equal(toolAppliesTo('jdk21', { role: 'claw', labels: [] }), true);
	// The forge-e2e floor did not move: it is Maven's, and the jdk21 label
	// needs Maven, so the 10 GB CI job still lands only where it fits.
	assert.equal(toolAppliesTo('maven', claw15gb), true);
	assert.equal(toolAppliesTo('maven', claw7gb), false);
	assert.equal(toolAppliesTo('maven', claw11gbDeclaredOnly), false, '11 GB is below the floor');
	// A node nothing has ever measured does not qualify by omission.
	assert.equal(toolAppliesTo('maven', { role: 'claw', labels: [] }), false);
	// Never hokon, even at 61 GB measured — the guest check runs BEFORE `when`.
	for (const id of ['jdk21', 'maven']) {
		assert.equal(toolAppliesTo(id, guest15gb), false);
		assert.equal(toolAppliesTo(id, guest15gb, { includeGuests: true }), true);
	}
});

test('Maven is scoped like the existing optional capabilities — present in applicableRepairs only above the floor', () => {
	const ids15 = applicableRepairs(claw15gb).map(([id]) => id);
	const ids7 = applicableRepairs(claw7gb).map(([id]) => id);
	assert.ok(ids15.includes('jdk21') && ids15.includes('maven'));
	assert.ok(ids7.includes('jdk21') && !ids7.includes('maven'));
	// The unscoped tools are unaffected either way.
	assert.ok(ids7.includes('rust') && ids7.includes('docker'));
});

test('jdk21/maven declare version+latest and are version-managed through a non-npm source', () => {
	assert.equal(isVersionManaged(REPAIRS.jdk21), true);
	assert.equal(isVersionManaged(REPAIRS.maven), true);
	assert.equal(REPAIRS.jdk21.latest.source.kind, 'adoptium');
	assert.equal(REPAIRS.maven.latest.source.kind, 'maven-metadata');
});

test('installScript accepts the strict x.y.z pins jdk21/maven actually produce', () => {
	assert.match(installScript('jdk21', '21.0.12'), /^TARGET_VERSION='21\.0\.12'\n/);
	assert.match(installScript('maven', '3.9.16'), /^TARGET_VERSION='3\.9\.16'\n/);
	for (const bad of ["1.2.3'; rm -rf ~; '", '21.0', '3.9.9-beta', '$(id)']) {
		assert.throws(() => installScript('jdk21', bad), /non x\.y\.z/);
	}
});

test('a version-managed tool with no version still refuses (#70 bypass, now covering jdk21/maven too)', () => {
	assert.throws(() => installScript('jdk21'), /needs a resolved version/);
	assert.throws(() => installScript('maven'), /needs a resolved version/);
});

// ── lookupAdoptiumLatest / lookupMavenLatest — injectable fetch, fixtures only ──

/**
 * THE PRODUCTION PATH, END TO END. Every real caller — `refresh-cycle.mjs`
 * (the nightly cadence), `bootcamp.mjs`, `check-fleet-toolchain.mjs` (the
 * doctor) — gets its `lookup` from `createReleaseLookup()`, never from a
 * fixture it injects by hand. A test that only ever hands `resolveInstallTarget`
 * a custom `lookup` function proves the PLUMBING accepts one; it proves
 * nothing about what production actually calls. These two tests go through
 * `createReleaseLookup` itself, the same object every real caller holds.
 *
 * MUTATION: this is exactly the bug that shipped once already — `createReleaseLookup`
 * asked npm's `lookupLatest` unconditionally, which answers jdk21's and
 * maven's non-npm sources with `unknown: tool declares no upstream package`,
 * so in production jdk21/maven would never have installed at all. Revert
 * `createReleaseLookup`'s dispatch (or its cache key) and these fail.
 */
test('createReleaseLookup answers jdk21 and maven with their own distinct versions in the same run', async () => {
	const feed = [
		{
			version_data: { major: 21, minor: 0, security: 12 },
			timestamp: new Date(Date.now() - 20 * 86_400_000).toISOString(),
		},
	];
	const metadataXml =
		'<metadata><versioning><versions><version>3.9.16</version></versions></versioning></metadata>';
	const pomLastModified = new Date(Date.now() - 20 * 86_400_000).toUTCString();
	const fetchStub = async (url, opts) => {
		if (String(url).includes('feature_releases')) return { ok: true, json: async () => feed };
		if (String(url).endsWith('maven-metadata.xml'))
			return { ok: true, text: async () => metadataXml };
		if (opts?.method === 'HEAD') {
			return { ok: true, headers: { get: () => pomLastModified } };
		}
		throw new Error(`unexpected fetch in this fixture: ${url}`);
	};
	const lookup = createReleaseLookup({ fetch: fetchStub });
	const [jdk, mvn] = await Promise.all([
		lookup(REPAIRS.jdk21.latest.source, { minAge: minAgeOf(REPAIRS.jdk21) }),
		lookup(REPAIRS.maven.latest.source, { minAge: minAgeOf(REPAIRS.maven) }),
	]);
	assert.equal(jdk.status, 'known');
	assert.equal(jdk.version, '21.0.12');
	assert.equal(mvn.status, 'known');
	assert.equal(mvn.version, '3.9.16');
	// THE CACHE-COLLISION HALF OF THE SAME BUG: both sources have no `package`
	// field at all, so a key built from `registry`+`package` alone is
	// identical for both — jdk21's cached answer would have been served back
	// as maven's.
	assert.notEqual(jdk.version, mvn.version);
});

test('resolveInstallTarget(REPAIRS.jdk21, { lookup: createReleaseLookup(...) }) resolves — the refresh-cycle/bootcamp path', async () => {
	const feed = [
		{
			version_data: { major: 21, minor: 0, security: 12 },
			timestamp: new Date(Date.now() - 20 * 86_400_000).toISOString(),
		},
	];
	const fetchStub = async (url) => {
		if (String(url).includes('feature_releases')) return { ok: true, json: async () => feed };
		throw new Error(`unexpected fetch in this fixture: ${url}`);
	};
	const lookup = createReleaseLookup({ fetch: fetchStub });
	const r = await resolveInstallTarget(REPAIRS.jdk21, { lookup });
	assert.equal(r.status, 'known');
	assert.equal(r.version, '21.0.12');
});

/**
 * THE DOCTOR PATH. `check-fleet-toolchain.mjs`'s `runDoctor` calls
 * `lookup(t.latest.source, { minAge })` DIRECTLY — it never goes through
 * `resolveInstallTarget` at all — so the dispatch has to live in
 * `createReleaseLookup` itself, not merely in `resolveInstallTarget`'s
 * default. A 15 GB fixture node with no `java` on its PATH must be judged
 * `absent` (jdk21 applies, and is missing) while the SAME lookup instance
 * resolves a KNOWN latest — never `unknown`, which is what every real node
 * got before this fix, however much RAM it had.
 *
 * `runDoctor` is imported read-only from `check-fleet-toolchain.mjs`; nothing
 * here edits that file or its own test file.
 */
test('check-fleet-toolchain doctor path: jdk21 resolves to a KNOWN latest, on a 15 GB node missing java', async () => {
	const { runDoctor } = await import('../check-fleet-toolchain.mjs');
	const home = tmp();
	const blockDir = tmp();
	// Hides this dev box's own real java/javac/mvn — the same technique the
	// repair-script tests above use, and for the same reason: `/usr/bin` is
	// still on PATH for every OTHER tool this probe reads.
	for (const bin of ['java', 'javac', 'mvn']) {
		writeFileSync(join(blockDir, bin), '#!/bin/sh\nexit 127\n');
		chmodSync(join(blockDir, bin), 0o755);
	}
	const run = (_node, script) => {
		const r = spawnSync('bash', ['--noprofile', '--norc', '-s'], {
			input: script,
			encoding: 'utf8',
			env: { PATH: `${blockDir}:/usr/bin:/bin`, HOME: home, TMPDIR: tempDir('tf-tmp-') },
		});
		return r.error
			? { ok: false, out: '', error: String(r.error.message) }
			: { ok: true, out: r.stdout ?? '', error: null };
	};
	const feed = [
		{
			version_data: { major: 21, minor: 0, security: 12 },
			timestamp: new Date(Date.now() - 20 * 86_400_000).toISOString(),
		},
	];
	const fetchStub = async (url) => {
		if (String(url).includes('feature_releases')) return { ok: true, json: async () => feed };
		throw new Error(`unexpected fetch in this fixture: ${url}`);
	};
	const lookup = createReleaseLookup({ fetch: fetchStub });
	const manifest = {
		toolchain: { toolCache: {} },
		machines: {
			'fixture-claw.invalid': {
				role: 'claw',
				labels: ['hadoku-builder'],
				ramGb: 15,
				$measured: { memTotalMb: 15360 },
			},
		},
	};
	const { report } = await runDoctor({ manifest, run, lookup, drains: {} });
	const node = report.find((m) => m.machine === 'fixture-claw.invalid');
	assert.ok(node, 'the 15 GB fixture claw must be in the report');
	const jdk = node.tools?.find((t) => t.id === 'jdk21');
	assert.ok(jdk, 'jdk21 must be among the tools judged for this node');
	assert.equal(jdk.status, 'absent', 'missing java is a finding, not current');
	assert.equal(jdk.finding, true);
	assert.equal(node.drift, true);
	// The dispatch itself, separately — through the SAME lookup instance
	// runDoctor used, so this is not a second, disconnected assertion.
	const latest = await lookup(REPAIRS.jdk21.latest.source, { minAge: 0 });
	assert.equal(latest.status, 'known');
	assert.equal(latest.version, '21.0.12');
});

// ── the repair script itself, EXECUTED under bash with a stubbed curl/sudo ──
//
// Same philosophy as the claude repair's tests below: the script decides
// whether bytes land on disk, so it is RUN, not grepped.

/** A minimal, valid .tar.gz containing `<topDir>/bin/<bins...>`, each a tiny executable. */
function makeTarball(topDir, bins) {
	const root = tempDir('jdk21-tarball-src-');
	const binDir = join(root, topDir, 'bin');
	mkdirSync(binDir, { recursive: true });
	for (const [name, body] of Object.entries(bins)) {
		const f = join(binDir, name);
		writeFileSync(f, body);
		chmodSync(f, 0o755);
	}
	const out = join(tempDir('jdk21-tarball-out-'), 'out.tar.gz');
	execFileSync('tar', ['czf', out, '-C', root, topDir]);
	rmSync(root, { recursive: true, force: true });
	return out;
}

function sha256Of(path) {
	return execFileSync('sha256sum', [path], { encoding: 'utf8' }).split(/\s+/)[0];
}

function sha512Of(path) {
	return execFileSync('sha512sum', [path], { encoding: 'utf8' }).split(/\s+/)[0];
}

/**
 * A fake HOME plus a stub `curl` that answers by URL SHAPE, env-configured —
 * real network calls never leave this process. `sudo`/log follow the same
 * pattern `fakeNode` above uses.
 */
function fakeToolchainHome() {
	const root = tmp();
	const home = join(root, 'home');
	const stubs = join(root, 'stubs');
	mkdirSync(home, { recursive: true });
	mkdirSync(stubs, { recursive: true });
	const log = join(root, 'log');
	writeFileSync(log, '');
	writeFileSync(
		join(stubs, 'sudo'),
		`#!/bin/sh\necho "sudo $*" >> "${log}"\n[ -z "$SUDO_FAIL" ]\n`
	);
	chmodSync(join(stubs, 'sudo'), 0o755);
	// HIDE A REAL SYSTEM java/javac/mvn. `stubs` sits first on PATH, so a file
	// here shadows one under /usr/bin — this test's own dev box carries a real
	// JDK and Maven (so the detect/version tests above can exercise them for
	// real), and without this the repair's OWN "already current or newer,
	// never move backward" check would see that real toolchain and skip the
	// download path entirely, which is not what these tests are about.
	for (const bin of ['java', 'javac', 'mvn']) {
		writeFileSync(join(stubs, bin), '#!/bin/sh\nexit 127\n');
		chmodSync(join(stubs, bin), 0o755);
	}
	// Routes by URL shape, not by call order — every call this file's repair
	// scripts make is distinguishable by the URL alone.
	writeFileSync(
		join(stubs, 'curl'),
		[
			'#!/bin/sh',
			'url=""; out=""; flags=""; prev=""',
			'for a in "$@"; do',
			'  case "$a" in http*) url="$a" ;; -*) flags="$flags $a" ;; esac',
			'  [ "$prev" = "-o" ] && out="$a"',
			'  prev="$a"',
			'done',
			'is_head=0',
			'case "$flags" in *I*) is_head=1 ;; esac',
			'emit() { if [ -n "$out" ]; then cat > "$out"; else cat; fi; }',
			'case "$url" in',
			'  *feature_releases*) cat "$CURL_FEED_FILE" ;;',
			'  *binary/version/*) [ "$is_head" = 1 ] && printf "HTTP/2 307\\r\\nlocation: %s\\r\\n\\r\\n" "$CURL_LOCATION" ;;',
			'  *.sha256.txt) printf "%s  asset.tar.gz\\n" "$CURL_CHECKSUM" | emit ;;',
			'  *.sha512) printf "%s\\n" "$CURL_MAVEN_SHA512" | emit ;;',
			'  "$CURL_LOCATION") cat "$CURL_TARBALL_FILE" | emit ;;',
			'  *archive.apache.org*) cat "$CURL_TARBALL_FILE" | emit ;;',
			'  *) echo "stub curl: unhandled url: $url" >&2; exit 7 ;;',
			'esac',
		].join('\n')
	);
	chmodSync(join(stubs, 'curl'), 0o755);
	const run = (script, env = {}) => {
		const r = spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
			encoding: 'utf8',
			env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: home, TMPDIR: tempDir('tf-tmp-'), ...env },
		});
		return { status: r.status, stderr: r.stderr, stdout: r.stdout, log: readFileSync(log, 'utf8') };
	};
	return { home, run };
}

test('jdk21 repair: a tarball whose sha256 does NOT match is refused BEFORE extraction', () => {
	const fx = fakeToolchainHome();
	const tarball = makeTarball('jdk-21.0.12+9', {
		java: '#!/bin/sh\necho stub',
		javac: '#!/bin/sh\necho stub',
	});
	const r = fx.run(installScript('jdk21', '21.0.12'), {
		TARGET_VERSION: '21.0.12',
		CURL_FEED_FILE: (() => {
			const f = join(tempDir('jdk21-feed-'), 'feed.json');
			writeFileSync(
				f,
				JSON.stringify([
					{ release_name: 'jdk-21.0.12+9', version_data: { major: 21, minor: 0, security: 12 } },
				])
			);
			return f;
		})(),
		CURL_LOCATION: 'https://github.com/example/jdk-21.0.12+9/OpenJDK.tar.gz',
		CURL_TARBALL_FILE: tarball,
		CURL_CHECKSUM: 'deadbeef00000000000000000000000000000000000000000000000000beef', // WRONG, deliberately
	});
	assert.notEqual(r.status, 0, 'a checksum mismatch must fail the repair');
	assert.match(r.stderr, /sha256 mismatch/);
	assert.doesNotMatch(r.log, /ln -sfn/, 'no symlink may be created when verification fails');
	assert.ok(
		!existsSync(join(fx.home, '.local', 'opt', 'jdk-21.0.12+9')),
		'the tarball must never be extracted when its checksum is wrong'
	);
});

test('jdk21 repair: a MATCHING sha256 extracts and links java/javac onto the stock PATH', () => {
	const fx = fakeToolchainHome();
	const tarball = makeTarball('jdk-21.0.12+9', {
		java: '#!/bin/sh\necho "installed-java"',
		javac: '#!/bin/sh\necho "installed-javac"',
	});
	const f = join(tempDir('jdk21-feed-'), 'feed.json');
	writeFileSync(
		f,
		JSON.stringify([
			{ release_name: 'jdk-21.0.12+9', version_data: { major: 21, minor: 0, security: 12 } },
		])
	);
	const r = fx.run(installScript('jdk21', '21.0.12'), {
		TARGET_VERSION: '21.0.12',
		CURL_FEED_FILE: f,
		CURL_LOCATION: 'https://github.com/example/jdk-21.0.12+9/OpenJDK.tar.gz',
		CURL_TARBALL_FILE: tarball,
		CURL_CHECKSUM: sha256Of(tarball),
	});
	assert.equal(r.status, 0, r.stderr);
	assert.ok(existsSync(join(fx.home, '.local', 'opt', 'jdk-21.0.12+9', 'bin', 'java')));
	assert.match(r.log, /ln -sfn .*jdk-21\.0\.12\+9\/bin\/java \/usr\/local\/bin\/java/);
	assert.match(r.log, /ln -sfn .*jdk-21\.0\.12\+9\/bin\/javac \/usr\/local\/bin\/javac/);
});

test('jdk21 repair: an already-current-or-newer java NEVER downgrades or re-downloads', () => {
	const fx = fakeToolchainHome();
	mkdirSync(join(fx.home, '.local', 'opt', 'jdk-21.0.13+1', 'bin'), { recursive: true });
	const javaPath = join(fx.home, '.local', 'opt', 'jdk-21.0.13+1', 'bin', 'java');
	writeFileSync(javaPath, '#!/bin/sh\nprintf \'openjdk version "21.0.13" 2026-01-01\\n\' >&2\n');
	chmodSync(javaPath, 0o755);
	// The REPAIR text itself calls bare `java -version`, so the stub must be on
	// PATH for the pin check to see it as "already ahead".
	const binDir = join(fx.home, 'wrapperbin');
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, 'java'), `#!/bin/sh\nexec "${javaPath}" "$@"\n`);
	chmodSync(join(binDir, 'java'), 0o755);
	const r = spawnSync('bash', ['--noprofile', '--norc', '-c', installScript('jdk21', '21.0.12')], {
		encoding: 'utf8',
		env: {
			PATH: `${binDir}:${join(fx.home, '..', 'stubs')}:/usr/bin:/bin`,
			HOME: fx.home,
			TMPDIR: tempDir('tf-tmp-'),
			TARGET_VERSION: '21.0.12',
			// No CURL_* vars set: if the script tried to download anyway, the
			// stub curl would exit 7 on the first call and fail this test.
		},
	});
	assert.equal(r.status, 0, r.stderr);
	assert.doesNotMatch(
		r.stderr,
		/unhandled url/,
		'the pin check must short-circuit before any curl call'
	);
});

test('maven repair: a sha512 mismatch is refused BEFORE extraction', () => {
	const fx = fakeToolchainHome();
	const tarball = makeTarball('apache-maven-3.9.16', { mvn: '#!/bin/sh\necho stub' });
	const r = fx.run(installScript('maven', '3.9.16'), {
		TARGET_VERSION: '3.9.16',
		CURL_MAVEN_TARBALL_FILE: tarball,
		CURL_TARBALL_FILE: tarball,
		CURL_MAVEN_SHA512: '00'.repeat(64), // WRONG, deliberately
	});
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /sha512 mismatch/);
	assert.doesNotMatch(r.log, /ln -sfn/);
	assert.ok(!existsSync(join(fx.home, '.local', 'opt', 'apache-maven-3.9.16')));
});

test('maven repair: a MATCHING sha512 extracts and links mvn onto the stock PATH', () => {
	const fx = fakeToolchainHome();
	const tarball = makeTarball('apache-maven-3.9.16', { mvn: '#!/bin/sh\necho "installed-mvn"' });
	const r = fx.run(installScript('maven', '3.9.16'), {
		TARGET_VERSION: '3.9.16',
		CURL_TARBALL_FILE: tarball,
		CURL_MAVEN_SHA512: sha512Of(tarball),
	});
	assert.equal(r.status, 0, r.stderr);
	assert.ok(existsSync(join(fx.home, '.local', 'opt', 'apache-maven-3.9.16', 'bin', 'mvn')));
	assert.match(r.log, /ln -sfn .*apache-maven-3\.9\.16\/bin\/mvn \/usr\/local\/bin\/mvn/);
});

// ── detect: EXECUTES, so a stub that merely exists and exits 1 is not enough ──

/** A stub bin dir with the given executables (name -> script body), on its own PATH entry. */
function stubBin(programs) {
	const dir = tmp();
	for (const [name, body] of Object.entries(programs)) {
		const f = join(dir, name);
		writeFileSync(f, body);
		chmodSync(f, 0o755);
	}
	return dir;
}

function runDetect(id, programs, scratch = tempDir('tf-tmp-')) {
	const dir = stubBin(programs);
	const r = spawnSync('bash', ['--noprofile', '--norc', '-c', REPAIRS[id].detect], {
		encoding: 'utf8',
		env: { PATH: `${dir}:/usr/bin:/bin`, TMPDIR: scratch },
	});
	return (r.stdout ?? '').trim();
}

/**
 * A FAILING DETECT LEAVES NOTHING BEHIND. It used to remove its scratch dir
 * only on the passing path, so every failure stranded a `tmp.XXXXXX/Probe.java`
 * on the node's tmpfs — 455 on claw-4 and 513 on claw-6 by 2026-10-24.
 * MUTATION: put the `rm -rf` back behind the `&&` chain and this fails.
 */
test('jdk21 detect: the scratch dir is removed when the probe FAILS, not only when it passes', () => {
	for (const programs of [
		{ javac: '#!/bin/sh\nexit 1\n', java: '#!/bin/sh\nexit 1\n' },
		{ javac: '#!/bin/sh\nexit 0\n', java: '#!/bin/sh\nexit 1\n' },
		{ javac: '#!/bin/sh\nexit 0\n', java: '#!/bin/sh\necho JDK21-PROBE-OK\n' },
	]) {
		const scratch = tempDir('tf-scratch-');
		runDetect('jdk21', programs, scratch);
		assert.deepEqual(readdirSync(scratch), [], JSON.stringify(programs));
	}
});

/**
 * THE DONE-WHEN, LITERALLY: "a fake java that exits 1 is not the capability".
 * `javac` here pretends to succeed (as a `command -v`-only check would read
 * it) while producing nothing a real compiler would; `java` then fails
 * outright. MUTATION: change the detect to `command -v java` and this passes
 * when it must fail.
 */
test('jdk21 detect: a java that exits 1 reports MISSING, not OK — command -v is not proof', () => {
	const out = runDetect('jdk21', {
		javac: '#!/bin/sh\nexit 0\n', // "present", compiles nothing
		java: '#!/bin/sh\nexit 1\n',
	});
	assert.equal(out, '');
});

test('jdk21 detect: javac that cannot compile anything also reports MISSING', () => {
	const out = runDetect('jdk21', {
		javac: '#!/bin/sh\nexit 1\n',
		java: '#!/bin/sh\necho JDK21-PROBE-OK\n',
	});
	assert.equal(out, '');
});

test('jdk21 detect: a javac/java pair that actually runs the class reports OK', () => {
	const out = runDetect('jdk21', {
		// Fakes a working toolchain without needing a real JDK on the test host:
		// `javac -d "$d" ...` drops a marker file in "$d", `java -cp "$d" Probe`
		// reads it back. ($1=-d/-cp, $2=the dir, after `shift`.)
		javac: '#!/bin/sh\nshift\ntouch "$1/compiled"\n',
		java: '#!/bin/sh\nshift\nd="$1"\n[ -f "$d/compiled" ] && echo JDK21-PROBE-OK\n',
	});
	assert.equal(out, 'OK');
});

test('maven detect: an mvn that exits 1 reports MISSING', () => {
	assert.equal(runDetect('maven', { mvn: '#!/bin/sh\nexit 1\n' }), '');
});

test('maven detect: an mvn that is present but prints no version banner reports MISSING', () => {
	// The `command -v`-only shape: exists, runs, exits 0, proves nothing.
	assert.equal(runDetect('maven', { mvn: '#!/bin/sh\nexit 0\n' }), '');
});

/**
 * THE BUG THIS GUARDS AGAINST (found while confirming `check-fleet-toolchain.mjs`
 * still works with the new entry). Temurin's
 * own banner carries a FOURTH component (`"21.0.12.1"` — the currently
 * shipping GA build, measured live on 2026-10-05), and the shared
 * `parseInstalledVersion` in tool-release.mjs looks for the first x.y.z not
 * immediately followed by another `.`/digit — against the raw banner it
 * backtracks past "21.0.12" and matches "0.12.1" instead. `REPAIRS.jdk21.version`
 * must therefore pre-extract major.minor.security itself, so the shared parser
 * (every other tool's `version` already satisfies its assumption) sees a bare
 * x.y.z and needs no change of its own.
 */
test('jdk21 version: extracts major.minor.security from a 4-component Temurin banner, never the raw banner', () => {
	const dir = stubBin({
		java: '#!/bin/sh\nprintf \'openjdk version "21.0.12.1" 2026-08-18\\n\' >&2\n',
	});
	const r = spawnSync('bash', ['--noprofile', '--norc', '-c', REPAIRS.jdk21.version], {
		encoding: 'utf8',
		env: { PATH: `${dir}:/usr/bin:/bin`, TMPDIR: tempDir('tf-tmp-') },
	});
	assert.equal(r.stdout.trim(), '21.0.12');
	// And the shared parser, fed exactly this output, must read it unchanged —
	// the whole point of extracting it here instead of downstream.
	assert.equal(parseInstalledVersion(r.stdout), '21.0.12');
	// THE REGRESSION, PINNED DIRECTLY: the raw banner alone defeats the shared
	// parser. If `REPAIRS.jdk21.version` ever goes back to printing it bare,
	// this assertion is what catches it.
	assert.notEqual(parseInstalledVersion('openjdk version "21.0.12.1" 2026-08-18'), '21.0.12');
});

test('maven detect: a real-shaped mvn -v banner reports OK', () => {
	assert.equal(runDetect('maven', { mvn: '#!/bin/sh\necho "Apache Maven 3.9.16 (abc)"\n' }), 'OK');
});

// ── a real, non-stubbed JDK/Maven, if this host happens to have one ────────
//
// Bonus coverage, not load-bearing: the stubbed tests above are what CI can
// rely on regardless of what is installed on the box running it.

// ONE GUARD PER TOOL. This was one test gated on the JDK alone that then
// asserted Maven too, so a host with a JDK and no Maven failed it rather than
// skipping. claw-6 is that host (/usr/local/bin/javac 21, no mvn), and it
// reddened main twice on 2026-10-25 depending only on where CI landed.
const detects = (repair) => {
	const r = spawnSync('bash', ['--noprofile', '--norc', '-c', REPAIRS[repair].detect], {
		encoding: 'utf8',
	});
	return (r.stdout ?? '').trim() === 'OK';
};
const hasRealJdk = detects('jdk21');
const hasRealMaven = detects('maven');

test(
	'jdk21 detect: a real stock-PATH JDK, when this host happens to carry one',
	{ skip: !hasRealJdk },
	() => assert.equal(detects('jdk21'), true)
);

test(
	'maven detect: a real stock-PATH Maven, when this host happens to carry one',
	{ skip: !hasRealMaven },
	() => assert.equal(detects('maven'), true)
);

// ---------------------------------------------------------------------------
// qualifiesForCanary — wave 4e (#102): a CPU pre-filter on the WORKLOAD
// canary, never on the tool itself. claw-3 (i7-6600U, 2c/4t) is the case it
// must filter; claw-4 (i7-6700, 8t), claw-8 (i7-9700F, 8t) and claw-9
// (i7-5930K, 12t) must all pass.
// ---------------------------------------------------------------------------

test('qualifiesForCanary: the measured fleet shape — claw-3 filtered, claw-4/8/9 pass', () => {
	assert.equal(JDK21_CANARY_MIN_THREADS, 6, 'in the gap between the measured 4 and 8');
	assert.equal(qualifiesForCanary('jdk21', { cores: 4 }), false, 'claw-3: i7-6600U, 2c/4t');
	assert.equal(qualifiesForCanary('jdk21', { cores: 8 }), true, 'claw-4: i7-6700, 8t');
	assert.equal(qualifiesForCanary('jdk21', { cores: 8 }), true, 'claw-8: i7-9700F, 8t');
	assert.equal(qualifiesForCanary('jdk21', { cores: 12 }), true, 'claw-9: i7-5930K, 12t');
});

test('qualifiesForCanary: a capability with no declared floor always qualifies', () => {
	assert.equal(qualifiesForCanary('maven', { cores: 1 }), true);
	assert.equal(qualifiesForCanary('taskauto', {}), true);
});

test('qualifiesForCanary: an UNMEASURED node ("could not look") does not qualify — not the same as small enough to skip', () => {
	assert.equal(qualifiesForCanary('jdk21', {}), false, 'cores entirely absent');
	assert.equal(qualifiesForCanary('jdk21', { cores: null }), false);
	assert.equal(qualifiesForCanary('jdk21', { cores: 'lots' }), false, 'non-numeric is not a pass');
});

test('qualifiesForCanary: the boundary itself passes (>=, not >)', () => {
	assert.equal(qualifiesForCanary('jdk21', { cores: JDK21_CANARY_MIN_THREADS }), true);
	assert.equal(qualifiesForCanary('jdk21', { cores: JDK21_CANARY_MIN_THREADS - 1 }), false);
});

test('qualifiesForCanary never grants the label — it is a pure predicate over `cores`, nothing it returns reaches `earned`', () => {
	// Structural pin: the function's own module never imports anything that
	// writes `$capabilities` or a manifest. toolAppliesTo/applicableRepairs
	// (the TOOL gate) are untouched by it — importing them above and this
	// function staying a one-line predicate over `node.cores` is the proof
	// that the two decisions remain independent.
	const node = { cores: 4, ramGb: 16 };
	// claw-3-shaped: fails the CANARY floor but would still pass the RAM-only
	// TOOL floor `REPAIRS.jdk21.when` uses — the tool and the canary ask
	// different questions on purpose.
	assert.equal(qualifiesForCanary('jdk21', node), false);
	assert.equal(toolAppliesTo('jdk21', node), true, 'the TOOL gate does not consult cores at all');
});

/**
 * #6: a pm2 services host is provisioned by the same table the cadence, the
 * doctor and bootcamp read — and nothing else is. claw-4's pm2 setup was a
 * hand-run script on 2026-10-12 that nothing would rebuild.
 */
test('#6: pm2, its boot unit and cloudflared apply to a services host only — never a guest, never a plain claw', () => {
	const ids = (node) => applicableRepairs(node).map(([id]) => id);
	const host = ids({ role: 'claw', services: 'pm2' });
	for (const id of ['pm2', 'pm2-boot', 'cloudflared']) assert.ok(host.includes(id), id);
	assert.ok(
		host.indexOf('pm2') < host.indexOf('pm2-boot'),
		'the boot unit runs pm2, so pm2 comes first'
	);
	for (const node of [{ role: 'claw' }, { role: 'guest', services: 'pm2' }])
		for (const id of ['pm2', 'pm2-boot', 'cloudflared'])
			assert.ok(!ids(node).includes(id), `${id} on ${JSON.stringify(node)}`);
});

/** Runs the pm2-boot repair against stub `pm2`, `sudo` and `systemctl`; returns what each was asked. */
function runPm2Boot({ supervised }) {
	const dir = tempDir('pm2-boot-');
	const log = join(dir, 'calls');
	const stub = (name, body) =>
		writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, {
			mode: 0o755,
		});
	stub(
		'pm2',
		`[ "$1" = jlist ] && printf '%s' '${supervised ? '[{"name":"pygmalion"}]' : '[]'}'; exit 0`
	);
	stub('systemctl', '[ "$1" = is-active ] && exit 3; exit 0');
	stub('sudo', '[ "$1" = -n ] && shift; "$@"');
	const r = spawnSync('bash', ['-c', REPAIRS['pm2-boot'].repair], {
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
		encoding: 'utf8',
	});
	return { code: r.status, err: r.stderr, calls: readFileSync(log, 'utf8').trim().split('\n') };
}

test('pm2-boot: a stray daemon supervising nothing is killed so the UNIT owns pm2 (claw-6, 2026-10-25)', () => {
	// The unit's `pm2 resurrect` attaches to a daemon it did not fork, never
	// writes pm2.pid, and systemd fails it on 'protocol'. MUTATION: drop the
	// kill and the enable below starts a unit that fails.
	const r = runPm2Boot({ supervised: false });
	assert.equal(r.code, 0, r.err);
	const kill = r.calls.indexOf('pm2 kill');
	assert.ok(kill >= 0, r.calls.join('\n'));
	assert.ok(kill < r.calls.findIndex((c) => c.startsWith('systemctl enable --now')));
});

test('pm2-boot: a stray daemon WITH services under it is refused, never killed', () => {
	const r = runPm2Boot({ supervised: true });
	assert.notEqual(r.code, 0);
	assert.match(r.err, /supervises processes/);
	assert.equal(r.calls.includes('pm2 kill'), false);
});

test('#6: neither pm2 nor cloudflared is version-managed — an upgrade restarts production', () => {
	// MUTATION: give either a `latest` and the daily refresh would restart every
	// service on the box (pm2 update) or the tunnel (cloudflared postinst).
	for (const id of ['pm2', 'cloudflared']) {
		assert.equal(REPAIRS[id].latest, undefined, id);
		assert.equal(REPAIRS[id].apt, undefined, id);
	}
	assert.match(REPAIRS['pm2-boot'].detect, /is-enabled[\s\S]*is-active/);
});

test('docker rootless: the setup tool gets one BIN holding all four, and the context is made when missing', () => {
	// claw-5, 2026-10-28: BIN was contrib/, which holds no `docker`, so the tool
	// died on its self-check after dockerd had started; the re-run then skipped
	// it (daemon active) and `context use rootless` named a context nobody made.
	const rootless = REPAIRS.docker.repair.split('# ROOTLESS')[1];
	for (const t of [
		'/usr/share/docker.io/contrib/dockerd-rootless.sh',
		'/usr/share/docker.io/contrib/dockerd-rootless-setuptool.sh',
		'/usr/bin/docker',
		'/usr/bin/rootlesskit',
	])
		assert.ok(rootless.includes(t), `${t} is linked into BIN`);
	assert.match(rootless, /PATH="\$bin:/, 'the setup tool finds dockerd-rootless.sh in BIN first');
	const create = rootless.indexOf('docker context create rootless');
	assert.ok(create > -1 && create < rootless.indexOf('docker context use rootless'));
	assert.match(rootless, /docker context inspect rootless[^\n]*\|\|/, 'created only when missing');
});
