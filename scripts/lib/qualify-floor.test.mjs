import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	PACKAGE_COMMANDS,
	SMARTD_MIN_DEVICES,
	ciToolsScript,
	judgeApt,
	judgeSmartd,
	makeFloorTests,
	originMatches,
	parseReleases,
	tests as floorTests,
} from './qualify-floor.mjs';
import { validateTest } from './qualify-registry.mjs';
import { declaredPackages } from './toolchain-floor.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PROFILES = join(ROOT, 'manifests', 'node-profiles.json');

// claw-4's own answers, 2026-11-11.
const SECURITY_RELEASES = [
	'release v=13.7,o=Debian,a=stable,n=trixie,l=Debian,c=main,b=amd64',
	'release v=13,o=Debian,a=stable-security,n=trixie-security,l=Debian-Security,c=main,b=amd64',
	'release o=gh,n=stable,l=gh,c=main,b=amd64',
];
const GOOD_ORIGINS = 'origin=Debian,codename=trixie-security,label=Debian-Security';
// The 10-25 shape: ${distro_id}:${distro_codename}-security expanded to an
// ARCHIVE of trixie-security, which Debian's security archive is not.
const BAD_ORIGINS = 'o=Debian,a=trixie-security,l=Debian-Security';

function aptOut({
	origins = GOOD_ORIGINS,
	releases = SECURITY_RELEASES,
	exit = 0,
	candidates = 0,
	selected = '',
} = {}) {
	return [
		'BEGIN apt-security',
		`DRYRUN-EXIT ${exit}`,
		...(exit === 0 ? [] : ['DRYRUN-TAIL E:Could not get lock /var/lib/dpkg/lock-frontend']),
		`ORIGINS ${origins}`,
		...(selected ? [`SELECTED ${selected}`] : []),
		`CANDIDATES ${candidates}`,
		'PERIODIC 1 1',
		'TIMER apt-daily.timer enabled',
		'TIMER apt-daily-upgrade.timer enabled',
		'END apt-security',
		...releases.map((r) => `QF-RELEASE ${r}`),
		'QF-POLICY-END',
	].join('\n');
}

function smartdOut({
	state = 'active',
	result = 'success',
	load = 'loaded',
	mon = 'Monitoring 1 ATA/SATA, 0 SCSI/SAS and 1 NVMe devices',
	end = true,
} = {}) {
	return [
		`QF-SMARTD-LOAD ${load}`,
		`QF-SMARTD-STATE ${state}`,
		`QF-SMARTD-RESULT ${result}`,
		mon
			? `QF-SMARTD-MON ${mon}`
			: "QF-SMARTD-MON-ERR smartd's journal for this run carries no Monitoring line",
		...(end ? ['QF-SMARTD-END'] : []),
	].join('\n');
}

// ── contract ────────────────────────────────────────────────────────────────

void test('floor-admin runs as admin and floor-ci as ci; both meet the contract', () => {
	assert.deepEqual(
		floorTests.map((t) => [t.id, t.runsAs]),
		[
			['floor-admin', 'admin'],
			['floor-ci', 'ci'],
		]
	);
	for (const t of floorTests) assert.deepEqual(validateTest(t), [], t.id);
});

void test('every package this lane executes is one the profiles actually declare', () => {
	const { common } = declaredPackages(PROFILES);
	const stray = Object.keys(PACKAGE_COMMANDS).filter((p) => !common.includes(p));
	assert.deepEqual(stray, []);
	// The incident that motivates executing the floor (claw-9, 10-30).
	assert.ok(PACKAGE_COMMANDS.unzip);
});

// ── unattended-upgrades, executed ───────────────────────────────────────────

void test('origin patterns match the way unattended-upgrades does: every key, aliases, globs', () => {
	const [stable, security] = parseReleases(aptOut()).slice(0, 2);
	assert.equal(originMatches(GOOD_ORIGINS, security), true);
	assert.equal(originMatches(GOOD_ORIGINS, stable), false);
	assert.equal(originMatches(BAD_ORIGINS, security), false);
	assert.equal(originMatches('o=Debian,a=stable-*', security), true);
	assert.equal(originMatches('o=Debian,suite=stable-security', security), true);
	// A key releases do not carry cannot be shown to match.
	assert.equal(originMatches('site=deb.debian.org', security), false);
});

void test('the live claw shape passes: the configured origin matches the security archive', () => {
	const j = judgeApt(aptOut());
	assert.deepEqual(j.fails, []);
	assert.deepEqual(j.unknown, []);
	assert.equal(j.metrics.securitySources, 1);
});

void test('a pattern that matches NOTHING fails, though the file names the right label (10-25, ~7 weeks)', () => {
	const j = judgeApt(aptOut({ origins: BAD_ORIGINS }));
	assert.match(j.fails.join(' '), /match none of the node's 3 apt release\(s\)/);
});

void test('a pattern that matches some source but not the security archive fails', () => {
	const j = judgeApt(aptOut({ origins: `o=Debian,a=stable, ${BAD_ORIGINS}` }));
	assert.match(j.fails.join(' '), /no Debian-Security/);
});

void test('security updates pending and none selected fails (apt-security judgeProbe, reused)', () => {
	const j = judgeApt(aptOut({ candidates: 12 }));
	assert.match(j.fails.join(' '), /12 security update\(s\) are pending/);
});

void test('a dry run that could not take the apt lock is could-not-look, never clean', () => {
	const j = judgeApt(aptOut({ exit: 1 }));
	assert.deepEqual(j.fails, []);
	assert.match(j.unknown.join(' '), /lock/);
});

void test('an apt-cache policy with no releases is could-not-look', () => {
	const j = judgeApt(aptOut({ releases: [] }));
	assert.match(j.unknown.join(' '), /no release/);
});

// ── smartd ──────────────────────────────────────────────────────────────────

void test('smartd active and monitoring a disk passes', () => {
	const j = judgeSmartd(smartdOut());
	assert.deepEqual([j.fails, j.unknown], [[], []]);
	assert.equal(j.metrics.devices, 2);
});

void test('smartd failed is a fail naming its state (claw-10 since 11-09)', () => {
	const j = judgeSmartd(smartdOut({ state: 'failed', result: 'timeout' }));
	assert.match(j.fails.join(' '), /smartmontools\.service is failed \(timeout\)/);
});

void test('smartd active but monitoring no disk fails against the bar', () => {
	const j = judgeSmartd(smartdOut({ mon: 'Monitoring 0 ATA/SATA, 0 SCSI/SAS and 0 NVMe devices' }));
	assert.match(j.fails.join(' '), new RegExp(`monitors 0 device.*at least ${SMARTD_MIN_DEVICES}`));
});

void test('smartd not installed is a fail; an unreadable journal is could-not-look', () => {
	assert.match(
		judgeSmartd(smartdOut({ load: 'not-found', state: 'inactive' })).fails.join(' '),
		/not installed/
	);
	const j = judgeSmartd(smartdOut({ mon: null }));
	assert.deepEqual(j.fails, []);
	assert.match(j.unknown.join(' '), /no Monitoring line/);
	assert.match(judgeSmartd(smartdOut({ end: false })).unknown.join(' '), /end marker/);
});

// ── the tests, against a fake node ──────────────────────────────────────────

const MACHINE = { users: { ci: 'fixture-ci' }, labels: [], $capabilities: { earned: [] } };

function fakeCtx(answers, machine = MACHINE) {
	const sent = [];
	return {
		sent,
		ctx: {
			node: 'claw-fixture',
			machine,
			manifest: { machines: { 'claw-fixture': machine } },
			nowMs: Date.now(),
			log: () => {},
			async exec(script, o = {}) {
				sent.push({ script, timeoutMs: o.timeoutMs });
				for (const [needle, out] of answers)
					if (script.includes(needle)) {
						const o = typeof out === 'function' ? out(script) : out;
						return typeof o === 'string' ? { ok: true, stdout: o, stderr: '' } : o;
					}
				throw new Error(`unexpected script: ${script.slice(0, 80)}`);
			},
		},
	};
}

/** The node's answer to a tools script: one REPAIR line per detect the script carries. */
const toolsOut =
	({
		path = '/usr/local/bin:/usr/bin',
		broken = {},
		missingPkgs = [],
		end = true,
		silent = false,
	} = {}) =>
	(script) =>
		[
			path ? `QF-PATH ${path}` : "QF-PATH-ERR the ci user's systemd manager gave no PATH",
			...(path && !silent
				? [...script.matchAll(/printf 'REPAIR %s %s\\n' '([^']+)'/g)].map(
						(m) => `REPAIR ${m[1]} ${broken[m[1]] ?? 'OK'}`
					)
				: []),
			...missingPkgs.map((p) => `PKG-MISSING ${p}`),
			...(end ? ['QF-TOOLS-END'] : []),
		].join('\n');

const [floorAdminOf, floorCiOf] = [0, 1].map(
	(i) =>
		(o = {}) =>
			makeFloorTests({ readPackages: () => ['unzip', 'git', 'libnss3'], ...o })[i]
);

void test('floor-admin passes on a clean node, and its reason says what it executed', async () => {
	const { ctx } = fakeCtx([
		['END apt-security', aptOut()],
		['QF-SMARTD-END', smartdOut()],
	]);
	const r = await floorAdminOf().run(ctx);
	assert.equal(r.status, 'pass', r.reason);
	assert.match(r.reason, /unattended-upgrade/);
	assert.match(r.reason, /smartd/);
});

void test('floor-admin fails when smartd watches nothing, even with apt clean', async () => {
	const { ctx } = fakeCtx([
		['END apt-security', aptOut()],
		['QF-SMARTD-END', smartdOut({ state: 'failed', result: 'timeout' })],
	]);
	const r = await floorAdminOf().run(ctx);
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /smartmontools/);
});

void test('floor-admin with an unreachable node is could-not-look with the ssh reason', async () => {
	const down = { ok: false, stdout: '', stderr: '', error: 'ssh: Connection timed out' };
	const { ctx } = fakeCtx([
		['END apt-security', down],
		['QF-SMARTD-END', down],
	]);
	const r = await floorAdminOf().run(ctx);
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /Connection timed out/);
});

void test('floor-ci executes the declared packages it knows a command for, under the runner PATH', async () => {
	const { ctx, sent } = fakeCtx([['QF-TOOLS-END', toolsOut()]]);
	const r = await floorCiOf().run(ctx);
	assert.equal(r.status, 'pass', r.reason);
	const s = sent[0].script;
	assert.match(s, /systemctl --user show-environment/);
	assert.match(s, /unzip -v/);
	assert.match(s, /git --version/);
	// Only what the profiles declare: curl has a command but is not in this floor.
	assert.doesNotMatch(s, /curl --version/);
	assert.match(r.reason, /2 package\(s\)/);
});

void test('floor-ci fails naming a package that does not run (claw-9 unzip, 10-30)', async () => {
	const { ctx } = fakeCtx([['QF-TOOLS-END', toolsOut({ missingPkgs: ['unzip'] })]]);
	const r = await floorCiOf().run(ctx);
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /unzip/);
});

void test('floor-ci fails naming a floor tool whose detect does not say OK', async () => {
	const { ctx } = fakeCtx([['QF-TOOLS-END', toolsOut({ broken: { gh: 'MISSING' } })]]);
	const r = await floorCiOf().run(ctx);
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /gh \(MISSING\)/);
});

void test('floor-ci with no runner PATH, a cut-off read, or no declared floor is could-not-look', async () => {
	for (const out of [
		toolsOut({ path: null }),
		toolsOut({ end: false }),
		toolsOut({ silent: true }),
	]) {
		const { ctx } = fakeCtx([['QF-TOOLS-END', out]]);
		const r = await floorCiOf().run(ctx);
		assert.equal(r.status, 'could-not-look', r.reason);
	}
	const { ctx } = fakeCtx([['QF-TOOLS-END', toolsOut()]]);
	const r = await floorCiOf({
		readPackages: () => {
			throw new Error('node-profiles.json not found at /nowhere');
		},
	}).run(ctx);
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /node-profiles\.json not found/);
});

void test('the ci script reads PATH from the ci manager and runs each package in a subshell', () => {
	const s = ciToolsScript([], ['unzip']);
	assert.match(s, /export PATH="\$JP"/);
	assert.match(s, /\( unzip -v \) >\/dev\/null 2>&1 \|\| printf 'PKG-MISSING %s\\n' 'unzip'/);
});
