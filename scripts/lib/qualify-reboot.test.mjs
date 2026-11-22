import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import {
	BOOT_ID_SCRIPT,
	TENANT_SCRIPT,
	afterBootScript,
	judgeAfterBoot,
	makeRebootTest,
	parseAfterBoot,
	parseStartup,
	parseTenants,
	test as rebootTest,
} from './qualify-reboot.mjs';
import { BOOT_TIMEOUT_MS, SERVICES_TIMEOUT_MS, parseRebootProbe } from './reboot-cycle.mjs';
import { validateTest } from './qualify-registry.mjs';

const OLD = '11111111-1111-1111-1111-111111111111';
const NEW = '22222222-2222-2222-2222-222222222222';
const MACHINE = { users: { ci: 'fixture-ci' }, $capabilities: { earned: ['gh', 'docker'] } };

/** REBOOT_PROBE's answer (lib/reboot-cycle.mjs), the shape a claw prints. */
function probeOut({
	bootId = OLD,
	running = '6.12.116+deb13-amd64',
	newest = running,
	dkmsLoaded = '',
	dkmsReady = '',
	pm2 = 'NONE',
} = {}) {
	return [
		`BOOTID ${bootId}`,
		`RUNNING ${running}`,
		`NEWEST ${newest}`,
		'DKMS-RUNNING ',
		'DKMS-NEWEST ',
		`DKMS-LOADED ${dkmsLoaded}`,
		`DKMS-READY ${dkmsReady}`,
		'FLAG CLEAN',
		'PKGS ',
		'UNITS-ENABLED ',
		'UNITS-ACTIVE ',
		`PM2 ${pm2}`,
		'END reboot-probe',
	].join('\n');
}

// claw-8's own line, 2026-11-11 (firmware and loader are POST, not the OS).
const FAST =
	'Startup finished in 11.943s (firmware) + 8.079s (loader) + 1.714s (kernel) + 13.821s (userspace) = 35.558s';
// claw-5's own line, 2026-11-11: network.target waited ~79 s past networking.service.
const SLOW =
	'Startup finished in 16.111s (firmware) + 10.889s (loader) + 5.287s (kernel) + 2min 3.520s (userspace) = 2min 35.808s';

/** The after-boot read, as a node prints it. */
function afterOut({
	state = 'running',
	startup = FAST,
	failed = [],
	gpu = 0,
	nvDkms = 0,
	nvLoaded = 'no',
	mgr = 'active',
	path = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin',
	tools = { gh: 'OK', node: 'OK', pnpm: 'OK', python3: 'OK' },
	end = true,
	extra = [],
} = {}) {
	const l = [`QR-STATE ${state}`];
	l.push(startup ? `QR-STARTUP ${startup}` : 'QR-STARTUP-ERR Bootup is not yet finished');
	l.push('QR-BLAME 6.689s NetworkManager-wait-online.service');
	l.push(`QR-FAILED-COUNT ${failed.length}`, ...failed.map((u) => `QR-FAILED ${u}`));
	l.push(gpu === null ? 'QR-GPU-ERR lspci could not list PCI devices' : `QR-GPU ${gpu}`);
	l.push(`QR-NV-DKMS ${nvDkms}`, `QR-NV-LOADED ${nvLoaded}`);
	l.push(`QR-CI-MGR ${mgr}`);
	l.push(path ? `QR-CI-PATH ${path}` : "QR-CI-PATH-ERR the ci user's systemd manager gave no PATH");
	for (const [t, v] of Object.entries(tools)) l.push(`QR-CI-TOOL ${t} ${v}`);
	l.push(...extra);
	if (end) l.push('QR-END');
	return l.join('\n');
}

/**
 * A fake node. `boots` is what each boot-id poll answers, in order (a string
 * is a boot id, null an ssh failure); the last entry repeats. `afters` is the
 * after-boot reads, in order, last repeating.
 */
function fakeNode({
	before = probeOut(),
	scheduled = 'SCHEDULED',
	boots = [NEW],
	afters = [{ qr: afterOut(), rp: probeOut({ bootId: NEW }) }],
	machine = MACHINE,
	tenants = 'QR-TENANTS-END',
	uptimeSec = 2 * 86_400,
} = {}) {
	const startedAt = Date.now();
	let clock = startedAt;
	const sent = [];
	let bootI = 0;
	let afterI = 0;
	const ctx = {
		node: 'claw-fixture',
		machine,
		manifest: { machines: { 'claw-fixture': machine } },
		nowMs: clock,
		log: () => {},
		async exec(script, o = {}) {
			sent.push({ script, timeoutMs: o.timeoutMs });
			if (script === TENANT_SCRIPT)
				return tenants === null
					? { ok: false, stdout: '', stderr: '', error: 'ssh: Connection timed out' }
					: { ok: true, stdout: `${tenants}\n`, stderr: '' };
			if (script === BOOT_ID_SCRIPT) {
				const b = boots[Math.min(bootI++, boots.length - 1)];
				return b === null
					? {
							ok: false,
							stdout: '',
							stderr: '',
							error: 'ssh: connect to host claw-fixture port 22: No route to host',
						}
					: { ok: true, stdout: `${b}\n`, stderr: '' };
			}
			if (script.includes('systemctl reboot'))
				return { ok: scheduled === 'SCHEDULED', stdout: `${scheduled}\n`, stderr: '' };
			if (script.includes('QR-END')) {
				const a = afters[Math.min(afterI++, afters.length - 1)];
				const up = script.includes('QR-UPTIME-SEC') ? `QR-UPTIME-SEC ${uptimeSec}\n` : '';
				return { ok: true, stdout: `${up}${a.qr}\n${a.rp}\n`, stderr: '' };
			}
			if (script.includes('END reboot-probe'))
				return before === null
					? { ok: false, stdout: '', stderr: '', error: 'ssh: Connection timed out' }
					: { ok: true, stdout: before, stderr: '' };
			throw new Error(`unexpected script: ${script.slice(0, 80)}`);
		},
	};
	const deps = {
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
		},
	};
	return { ctx, deps, sent, clockAt: () => clock, startedAt };
}

const run = async (o) => {
	const f = fakeNode(o);
	const r = await makeRebootTest(f.deps).run(f.ctx);
	return { ...f, r };
};

// ── contract ────────────────────────────────────────────────────────────────

void test('reboot-requalify meets the test contract, runs as admin and needs the drain', () => {
	assert.deepEqual(validateTest(rebootTest), []);
	assert.equal(rebootTest.id, 'reboot-requalify');
	assert.equal(rebootTest.runsAs, 'admin');
	assert.equal(rebootTest.needsDrain, true);
	// The test's budget covers the whole wait it may do, or the runner cuts it short.
	assert.ok(rebootTest.minutes * 60_000 > BOOT_TIMEOUT_MS + SERVICES_TIMEOUT_MS);
});

// ── pure pieces ─────────────────────────────────────────────────────────────

void test('boot time is kernel + initrd + userspace; firmware and loader are POST, not the OS', () => {
	assert.deepEqual(parseStartup(FAST), {
		seconds: 15.535,
		parts: { firmware: 11.943, loader: 8.079, kernel: 1.714, userspace: 13.821 },
	});
	assert.equal(parseStartup(SLOW).seconds, 128.807);
	assert.equal(
		parseStartup(
			'Startup finished in 1.2s (kernel) + 3.4s (initrd) + 1h 2min 945ms (userspace) = 1h 2min 5.545s'
		).seconds,
		3725.545
	);
	assert.equal(parseStartup('Bootup is not yet finished'), null);
	assert.equal(parseStartup(''), null);
});

void test('the after-boot read names the ci user from the manifest, through sudo only when ci is separate', () => {
	const sep = afterBootScript({ machine: { users: { ci: 'fixture-ci' } } });
	assert.match(sep, /id -u fixture-ci/);
	assert.match(sep, /sudo -n -u fixture-ci /);
	assert.match(sep, /HOME=\/home\/fixture-ci /);
	// Under sudo -u the ci user inherits admin's unreadable cwd, and pnpm then
	// fails on it: claw-1/2/3 read pnpm MISSING on 2026-11-11 until this line.
	assert.ok(sep.startsWith('cd /\n'));
	const same = afterBootScript({ machine: { users: { admin: 'fixture-admin' } } });
	assert.doesNotMatch(same, /sudo -n -u/);
	assert.match(same, /id -u fixture-admin/);
	// A malformed name throws (node-users.ts) rather than run as the wrong user.
	assert.throws(() => afterBootScript({ machine: { users: { ci: 'x; reboot' } } }));
});

void test('an after-boot read cut off before its end marker is could-not-look, not clean', () => {
	const qr = parseAfterBoot(afterOut({ end: false }));
	const j = judgeAfterBoot({
		qr,
		rp: parseRebootProbe(probeOut({ bootId: NEW })),
		before: parseRebootProbe(probeOut()),
		machine: MACHINE,
	});
	assert.deepEqual(j.fails, []);
	assert.match(j.unknown.join(' '), /end marker/);
});

// ── the whole test against a fake node ──────────────────────────────────────

void test('a node that reboots and comes back whole passes, and the reboot is sent exactly once', async () => {
	const { r, sent } = await run({ boots: [null, null, OLD, NEW] });
	assert.equal(r.status, 'pass', r.reason);
	assert.match(r.reason, /15\.5 s/);
	const reboots = sent.filter((s) => s.script.includes('systemctl reboot'));
	assert.equal(reboots.length, 1);
	assert.match(reboots[0].script, /sudo -n systemctl reboot/);
	// Short per-call timeouts while it is down: one poll never eats the window.
	for (const s of sent.filter((x) => x.script === BOOT_ID_SCRIPT)) assert.ok(s.timeoutMs <= 30_000);
	assert.equal(r.metrics.bootSeconds, 15.535);
	assert.equal(r.metrics.failedUnits, 0);
});

void test('a node that never answers again is could-not-look, bounded, and says LOUDLY it may be down', async () => {
	const { r, clockAt, sent, startedAt } = await run({ boots: [null] });
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /MAY BE DOWN/);
	assert.match(r.reason, /No route to host/);
	const polls = sent.filter((s) => s.script === BOOT_ID_SCRIPT).length;
	assert.ok(polls > 5 && polls < 100, `${polls} polls`);
	assert.ok(clockAt() - startedAt <= BOOT_TIMEOUT_MS + 60_000);
});

void test('a node that keeps its boot id never rebooted: could-not-look, and says so', async () => {
	const { r } = await run({ boots: [OLD] });
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /never rebooted/);
});

void test('an unreadable node is not rebooted at all', async () => {
	const { r, sent } = await run({ before: null });
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /before rebooting/);
	assert.equal(sent.filter((s) => s.script.includes('systemctl reboot')).length, 0);
});

void test('a refused sudo reboots nothing and polls nothing', async () => {
	const { r, sent } = await run({ scheduled: 'SUDO-REFUSED' });
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /sudo/);
	assert.equal(sent.filter((s) => s.script === BOOT_ID_SCRIPT).length, 0);
});

void test('a failed system unit after the reboot fails, naming the unit and the bar (claw-10 smartd, 11-09)', async () => {
	const { r } = await run({
		afters: [
			{ qr: afterOut({ failed: ['smartmontools.service'] }), rp: probeOut({ bootId: NEW }) },
		],
	});
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /1 failed system unit\(s\).*smartmontools\.service.*bar 0/);
});

void test('a slow boot passes and is recorded, not judged (claw-5 129 s, operator 11-11)', async () => {
	const { r } = await run({
		afters: [{ qr: afterOut({ startup: SLOW }), rp: probeOut({ bootId: NEW }) }],
	});
	assert.equal(r.status, 'pass');
	assert.match(r.reason, /booted in 128\.8 s/);
	assert.equal(r.metrics.bootSeconds, 128.807);
	assert.ok(r.metrics.slowest.some((u) => /NetworkManager-wait-online/.test(u)));
});

void test('a boot that never finished is a fail (a hang), not an unknown', async () => {
	const { r } = await run({
		afters: [{ qr: afterOut({ state: 'starting', startup: null }), rp: probeOut({ bootId: NEW }) }],
	});
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /not finished/);
});

void test('an NVIDIA GPU with its driver installed and no module for the running kernel fails (claw-1, 10-25)', async () => {
	const { r } = await run({
		afters: [
			{
				qr: afterOut({ gpu: 1, nvDkms: 1 }),
				rp: probeOut({ bootId: NEW, running: '6.12.113+deb13-amd64' }),
			},
		],
		before: probeOut({ newest: '6.12.113+deb13-amd64' }),
	});
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /nvidia.*6\.12\.113/);
});

void test('a node that EARNS an nvenc label without a driver installed fails too', async () => {
	const { r } = await run({
		machine: { ...MACHINE, $capabilities: { earned: ['nvenc-h264'] } },
		afters: [{ qr: afterOut({ gpu: 1, nvDkms: 0 }), rp: probeOut({ bootId: NEW }) }],
	});
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /nvenc-h264/);
});

void test('the nvidia module counts when loaded, or when DKMS has it ready for the running kernel', async () => {
	for (const a of [
		{ qr: afterOut({ gpu: 1, nvDkms: 1, nvLoaded: 'yes' }), rp: probeOut({ bootId: NEW }) },
		{
			qr: afterOut({ gpu: 1, nvDkms: 1 }),
			rp: probeOut({ bootId: NEW, dkmsReady: 'nvidia nvidia_uvm' }),
		},
	]) {
		const { r } = await run({ afters: [a] });
		assert.equal(r.status, 'pass', r.reason);
	}
});

void test('a GPU with no driver and no NVIDIA capability has nothing to load (claw-4, claw-5)', async () => {
	const { r } = await run({
		afters: [{ qr: afterOut({ gpu: 1 }), rp: probeOut({ bootId: NEW }) }],
	});
	assert.equal(r.status, 'pass', r.reason);
	assert.match(r.reason, /no NVIDIA driver/);
});

void test('lspci unreadable is could-not-look, never a pass', async () => {
	const { r } = await run({
		afters: [{ qr: afterOut({ gpu: null }), rp: probeOut({ bootId: NEW }) }],
	});
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /lspci/);
});

void test("a tool missing from the ci manager's PATH fails, naming it (hokon gh, 10-13..10-15)", async () => {
	const { r } = await run({
		afters: [
			{
				qr: afterOut({ tools: { gh: 'MISSING', node: 'OK', pnpm: 'OK', python3: 'OK' } }),
				rp: probeOut({ bootId: NEW }),
			},
		],
	});
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /runner PATH.*gh/);
});

void test("the ci user's manager not running after boot fails", async () => {
	const { r } = await run({
		afters: [
			{ qr: afterOut({ mgr: 'inactive', path: null, tools: {} }), rp: probeOut({ bootId: NEW }) },
		],
	});
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /systemd --user manager is inactive/);
});

void test('a pm2 app slow to come back is waited for; one that never does fails', async () => {
	const before = probeOut({ pm2: 'svc-a svc-b' });
	const late = await run({
		before,
		afters: [
			{ qr: afterOut(), rp: probeOut({ bootId: NEW, pm2: 'svc-a' }) },
			{ qr: afterOut(), rp: probeOut({ bootId: NEW, pm2: 'svc-a svc-b' }) },
		],
	});
	assert.equal(late.r.status, 'pass', late.r.reason);
	const never = await run({
		before,
		afters: [{ qr: afterOut(), rp: probeOut({ bootId: NEW, pm2: 'svc-a' }) }],
	});
	assert.equal(never.r.status, 'fail');
	assert.match(never.r.reason, /svc-b/);
});

// ── tenant hosts belong to the reboot cycle ─────────────────────────────────

const TENANTS =
	'QR-TENANT cardtable-agent.service\nQR-TENANT pm2-archivebot-svc.service\nQR-TENANTS-END';
const rebootsSent = (sent) => sent.filter((s) => s.script.includes('systemctl reboot')).length;

// fleet-manager#107: claw-4 on 11-16 passed every other check and failed the
// night on this one, which by design never reboots a tenant host. Its current
// boot (the reboot cycle's, 11-14) is what gets judged.
void test('a tenant host is never rebooted; a recent current boot that is whole passes, naming the units', async () => {
	const { r, sent } = await run({ tenants: TENANTS });
	assert.equal(rebootsSent(sent), 0);
	assert.equal(r.status, 'pass', r.reason);
	assert.match(r.reason, /cardtable-agent\.service, pm2-archivebot-svc\.service/);
	assert.match(r.reason, /reboot-claws/);
	assert.match(r.reason, /judged its current boot instead, up 2 days/);
	assert.equal(r.metrics.currentBoot, true);
	assert.equal(sent.filter((s) => s.script === BOOT_ID_SCRIPT).length, 0, 'nothing polled');
});

void test("a tenant host's current boot is held to the after-boot bars: a failed unit fails", async () => {
	const { r, sent } = await run({
		tenants: TENANTS,
		afters: [{ qr: afterOut({ failed: ['smartmontools.service'] }), rp: probeOut() }],
	});
	assert.equal(rebootsSent(sent), 0);
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /1 failed system unit\(s\).*smartmontools\.service/);
});

void test("a tenant host's enabled runner unit that is not running fails", async () => {
	const rp = probeOut()
		.replace('UNITS-ENABLED ', 'UNITS-ENABLED actions-runner-a.service')
		.replace('UNITS-ACTIVE ', 'UNITS-ACTIVE ');
	const { r } = await run({ tenants: TENANTS, afters: [{ qr: afterOut(), rp }] });
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /runner unit\(s\) not active: actions-runner-a\.service/);
});

void test('a tenant host whose boot is older than the ttl is could-not-look: no recent boot to judge', async () => {
	const { r, sent } = await run({ tenants: TENANTS, uptimeSec: 30 * 86_400 });
	assert.equal(rebootsSent(sent), 0);
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /30 days old, older than the 21-day ttl/);
});

void test('a tenant host whose uptime cannot be read is could-not-look, never a pass', async () => {
	const { r } = await run({ tenants: TENANTS, uptimeSec: 'x' });
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /uptime could not be read/);
});

void test('an unreadable unit listing is could-not-look, never "no tenants", and reboots nothing', async () => {
	for (const tenants of [
		null,
		'QR-TENANTS-ERR systemctl could not list units',
		'QR-TENANT pm2-x-svc.service',
	]) {
		const { r, sent } = await run({ tenants });
		assert.equal(r.status, 'could-not-look', String(tenants));
		assert.equal(sent.filter((s) => s.script.includes('systemctl reboot')).length, 0);
	}
});

/** TENANT_SCRIPT run by a real shell against a fake `systemctl` serving `units` ({ name: slice }). */
function listTenants(units, { listFails = false, showFails = '' } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'qr-tenants-'));
	try {
		const table = Object.entries(units)
			.map(([u, sl]) => `${u}) echo ${sl} ;;`)
			.join('\n    ');
		writeFileSync(
			join(dir, 'systemctl'),
			`#!/bin/sh
case "$1" in
  list-units) ${
		listFails
			? 'exit 1'
			: `printf '%s\\n' ${Object.keys(units)
					.map((u) => `'${u} loaded active running x'`)
					.join(' ')}`
	} ;;
  show)
    [ "$5" = "${showFails}" ] && exit 1
    case "$5" in
    ${table}
    esac ;;
esac
`,
			{ mode: 0o755 }
		);
		return execFileSync('sh', ['-c', TENANT_SCRIPT], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

void test('the tenant listing is every active service in a hosting slice, agent or pm2, and nothing else', () => {
	const out = listTenants({
		'cardtable-agent.service': 'hosting-cardtable.slice',
		'pm2-archivebot-svc.service': 'hosting-archivebot.slice',
		'pm2-hadoku.service': 'system.slice',
		'ssh.service': 'system.slice',
		'runner.service': 'runners.slice',
	});
	assert.deepEqual(parseTenants(out), ['cardtable-agent.service', 'pm2-archivebot-svc.service']);
	assert.deepEqual(parseTenants(listTenants({ 'ssh.service': 'system.slice' })), []);
});

void test('a listing or a slice read that fails ends with no marker, so it is never "no tenants"', () => {
	assert.equal(
		parseTenants(listTenants({ 'ssh.service': 'system.slice' }, { listFails: true })),
		null
	);
	assert.equal(
		parseTenants(
			listTenants(
				{ 'ssh.service': 'system.slice', 'cardtable-agent.service': 'hosting-cardtable.slice' },
				{ showFails: 'cardtable-agent.service' }
			)
		),
		null
	);
});

// ── sessions ────────────────────────────────────────────────────────────────

void test('a node that hosts sessions is not rebooted while one is live, or while they cannot be counted', async () => {
	for (const [sessions, re] of [
		[{ live: 1, pastCap: 0 }, /1 live session\(s\) on claw-fixture/],
		[null, /could not count claw-fixture's live sessions/],
	]) {
		const f = fakeNode({
			machine: { ...MACHINE, users: { ...MACHINE.users, dev: 'fixture-dev' } },
		});
		const r = await makeRebootTest({ ...f.deps, sessions: async () => sessions }).run(f.ctx);
		assert.equal(r.status, 'could-not-look');
		assert.match(r.reason, re);
		assert.ok(!f.sent.some((x) => x.script.includes('systemctl reboot')), 'rebooted anyway');
	}
});
