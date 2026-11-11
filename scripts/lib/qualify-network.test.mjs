import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
	cleanupScript,
	HTTPS_PER_SAMPLE,
	judgeSoak,
	makeNetworkSoakTest,
	NETWORK_BARS,
	parseSoak,
	readScript,
	soakLoopScript,
	SOAK_SAMPLES,
	startScript,
	test as networkSoak,
	wiredOfRecord,
} from './qualify-network.mjs';
import { validateTest } from './qualify-registry.mjs';

const run = promisify(execFile);
const HOSTS = ['github.com', 'api.github.com', 'data.example'];
const T0 = 1_762_000_000;

/**
 * One sample in the loop's own output format. Interfaces are
 * `{ name, wireless, ip, lft }`; `lft` null renders `forever`.
 */
function sample(i, { ifaces, routes, dnsFail = [], https = [] }) {
	const lines = [`SAMPLE ${i} ${T0 + (i - 1) * 60}`];
	ifaces.forEach((f, k) => {
		if (f.ip)
			lines.push(
				`ADDR ${k + 2}: ${f.name}    inet ${f.ip}/24 brd 192.0.2.255 scope global dynamic noprefixroute ${f.name}\\       valid_lft ${f.lft === null ? 'forever' : `${f.lft ?? 7200}sec`} preferred_lft 5400sec`
			);
	});
	for (const f of ifaces)
		lines.push(`IF ${f.name} ${f.wireless ? 'yes' : 'no'} 02:00:00:00:00:0${f.name.length % 10}`);
	for (const [dev, metric] of routes)
		lines.push(
			`ROUTE default via 192.0.2.254 dev ${dev} proto dhcp src 192.0.2.10 metric ${metric} `
		);
	for (const h of HOSTS)
		lines.push(dnsFail.includes(h) ? `DNS ${h} 2 5003 -` : `DNS ${h} 0 14 198.51.100.7`);
	for (let j = 0; j < HTTPS_PER_SAMPLE; j++) {
		const r = https[j] ?? { rc: 0, code: 200, sec: 0.15 };
		lines.push(`HTTPS ${r.rc} ${r.code} ${r.sec} ${r.err ?? ''}`.trimEnd());
	}
	lines.push(`SAMPLE_END ${i}`);
	return lines.join('\n');
}

const WIRED = { name: 'enp5s0', wireless: false, ip: '192.0.2.64' };
const RADIO = { name: 'wlp9s0', wireless: true, ip: '192.0.2.98' };
const RADIO_DOWN = { name: 'wlp9s0', wireless: true, ip: null };

/** A whole soak; `at(i)` overrides sample i's shape. */
function soakText({ n = SOAK_SAMPLES, done = true, base, at = () => ({}) }) {
	const body = Array.from({ length: n }, (_, k) => sample(k + 1, { ...base, ...at(k + 1) }));
	return [`NETSOAK_BEGIN ${T0}`, ...body, ...(done ? [`NETSOAK_DONE ${T0 + 600}`] : [])].join('\n');
}

const judge = (text, lan) => judgeSoak({ soak: parseSoak(text), hosts: HOSTS, lan });

const singleWired = { ifaces: [WIRED, RADIO_DOWN], routes: [['enp5s0', 1002]] };
const wifiOnly = {
	ifaces: [{ name: 'enp4s0', wireless: false, ip: null }, RADIO],
	routes: [['wlp9s0', 600]],
};
const dual = {
	ifaces: [WIRED, RADIO],
	routes: [
		['enp5s0', 100],
		['wlp9s0', 600],
	],
};

// ── the contract ───────────────────────────────────────────────────────────

void test('network-soak meets the qualify contract and runs as ci', () => {
	assert.deepEqual(validateTest(networkSoak), []);
	assert.equal(networkSoak.id, 'network-soak');
	assert.equal(networkSoak.runsAs, 'ci');
	assert.ok(networkSoak.minutes >= 11 && networkSoak.minutes <= 15);
});

// ── PASSIVE: no script it sends can change the node's network ──────────────

void test('nothing the soak sends to a node can down, flap or reconfigure an interface, route, resolver or service', () => {
	const scripts = [
		soakLoopScript({ hosts: HOSTS }),
		startScript(soakLoopScript({ hosts: HOSTS }), 900),
		readScript('/tmp/qualify-net.AbC123xy'),
		cleanupScript('/tmp/qualify-net.AbC123xy'),
	].join('\n');
	const forbidden = [
		/\bip\s+(-\S+\s+)*(link|addr|address|route|rule|neigh)\s+(set|add|del|delete|flush|change|replace)\b/,
		/\bnmcli\b.*\b(down|up|modify|connect|disconnect|reload|delete|add)\b/,
		// A command word followed by an argument; `tailscale*)` in the interface
		// probe's skip list is a glob, not a call.
		/\b(ifup|ifdown|ifconfig|dhclient|dhcpcd|resolvectl|resolvconf|systemctl|service|tailscale|iw|rfkill|sysctl|sudo|ethtool|networkctl)\s+[-a-z]/,
		/>\s*\/etc\//,
		/\/etc\/resolv\.conf/,
	];
	for (const re of forbidden) assert.doesNotMatch(scripts, re);
	// The only removal is its own mktemp directory, and the only kill its own process group.
	assert.deepEqual(
		[...scripts.matchAll(/\brm -rf "?([^"\s]+)/g)].map((m) => m[1]),
		['$d']
	);
	assert.match(scripts, /d='\/tmp\/qualify-net\.AbC123xy'/);
});

void test('scripts refuse a host, url or directory that could carry shell', () => {
	assert.throws(() => soakLoopScript({ hosts: ['github.com; reboot'] }), /bad host/);
	assert.throws(() => soakLoopScript({ hosts: HOSTS, url: "https://x'$(id)" }), /bad url/);
	assert.throws(() => readScript('/etc'), /not a soak directory/);
	assert.throws(() => cleanupScript('/tmp/qualify-net.x; rm -rf ~'), /not a soak directory/);
	assert.throws(() => cleanupScript('/home/ci'), /not a soak directory/);
});

// ── judging ────────────────────────────────────────────────────────────────

void test('a clean soak on a wired single-homed node passes, says it was judged on DNS and HTTPS only, and does not invent a renewal', () => {
	const r = judge(soakText({ base: singleWired }));
	assert.equal(r.status, 'pass', r.reason);
	assert.match(r.reason, /single-homed on enp5s0: judged on DNS and HTTPS only/);
	assert.match(r.reason, /no renewal fell inside the window, so renewal is not judged/);
	assert.equal(r.metrics.lease.renewed, false);
	assert.equal(r.metrics.https.fetches, SOAK_SAMPLES * HTTPS_PER_SAMPLE);
});

void test('a wifi-only node is single-homed, not dual-homed, though it has an unplugged wired port', () => {
	const r = judge(soakText({ base: wifiOnly }));
	assert.equal(r.status, 'pass', r.reason);
	assert.equal(r.metrics.dualHomed, false);
	assert.match(r.reason, /single-homed on wlp9s0/);
});

void test('ONE failed name resolution fails the soak, naming the host and the bar', () => {
	const r = judge(
		soakText({ base: singleWired, at: (i) => (i === 7 ? { dnsFail: ['github.com'] } : {}) })
	);
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /DNS: github\.com failed in 1\/11 samples \(bar: 0 failures\)/);
});

void test('the data endpoint is resolved every sample like the public names', () => {
	const r = judge(
		soakText({ base: singleWired, at: (i) => (i === 2 ? { dnsFail: ['data.example'] } : {}) })
	);
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /data\.example failed in 1\/11/);
});

void test('one failed fetch is a blip; two fail the soak', () => {
	const bad = { rc: 28, code: '000', sec: 10, err: 'curl: (28) Connection timed out' };
	const one = judge(soakText({ base: singleWired, at: (i) => (i === 3 ? { https: [bad] } : {}) }));
	assert.equal(one.status, 'pass', one.reason);
	const two = judge(
		soakText({ base: singleWired, at: (i) => (i === 3 || i === 9 ? { https: [bad] } : {}) })
	);
	assert.equal(two.status, 'fail');
	assert.match(
		two.reason,
		/HTTPS: 2\/33 fetches of https:\/\/github\.com failed \(bar: 1\); first: curl: \(28\)/
	);
});

void test('an HTTP error status is a failed fetch even when curl exits 0', () => {
	const e = { rc: 0, code: 503, sec: 0.2 };
	const r = judge(soakText({ base: singleWired, at: (i) => (i <= 2 ? { https: [e] } : {}) }));
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /2\/33 fetches/);
});

void test('p95 over the bar fails and names the number; the single worst fetch alone does not', () => {
	const slow = { rc: 0, code: 200, sec: 3.4 };
	const worstOnly = judge(
		soakText({ base: singleWired, at: (i) => (i === 5 ? { https: [slow] } : {}) })
	);
	assert.equal(worstOnly.status, 'pass', worstOnly.reason);
	const r = judge(
		soakText({ base: singleWired, at: (i) => (i === 5 || i === 6 ? { https: [slow] } : {}) })
	);
	assert.equal(r.status, 'fail');
	assert.match(r.reason, new RegExp(`HTTPS: p95 3\\.4 s > ${NETWORK_BARS.httpsP95Sec} s`));
});

void test('a dual-homed node that keeps its wired address and route passes, and says it was judged on them', () => {
	const r = judge(soakText({ base: dual }));
	assert.equal(r.status, 'pass', r.reason);
	assert.equal(r.metrics.dualHomed, true);
	assert.match(r.reason, /dual-homed \(wired enp5s0 judged on address and route\)/);
});

void test('claw-8 10-31: the wired lease goes mid-soak and the radio carries on — fail, though DNS and HTTPS are fine', () => {
	const lost = { ifaces: [{ ...WIRED, ip: null }, RADIO], routes: [['wlp9s0', 600]] };
	const r = judge(soakText({ base: dual, at: (i) => (i >= 6 ? lost : {}) }));
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /wired enp5s0 did not hold 192\.0\.2\.64 in 6\/11 samples/);
	assert.match(r.reason, /default route was not on wired enp5s0 in 6\/11 samples/);
});

void test('the default route moving to the radio fails even while the wired address is held', () => {
	const flipped = {
		...dual,
		routes: [
			['enp5s0', 700],
			['wlp9s0', 600],
		],
	};
	const r = judge(soakText({ base: dual, at: (i) => (i === 4 ? flipped : {}) }));
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /default route was not on wired enp5s0 in 1\/11/);
	assert.doesNotMatch(r.reason, /did not hold/);
});

void test('a node that STARTS in the incident state is dual-homed by its reservation, not read as wifi-only', () => {
	const lost = { ifaces: [{ ...WIRED, ip: null }, RADIO], routes: [['wlp9s0', 600]] };
	const lan = { iface: 'enp5s0', ip: '192.0.2.64' };
	assert.equal(wiredOfRecord(parseSoak(soakText({ base: lost })).samples, lan).dualHomed, true);
	const r = judge(soakText({ base: lost }), lan);
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /did not hold 192\.0\.2\.64 in 11\/11/);
	// Without the reservation there is nothing to say it was ever wired.
	assert.equal(judge(soakText({ base: lost })).metrics.dualHomed, false);
});

void test('a wired address other than the reserved one is not "held"', () => {
	const r = judge(soakText({ base: dual }), { iface: 'enp5s0', ip: '192.0.2.93' });
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /did not hold 192\.0\.2\.93 in 11\/11/);
});

void test('a renewal inside the window is reported; an unleased address says so', () => {
	const renewed = judge(
		soakText({
			base: singleWired,
			at: (i) => ({ ifaces: [{ ...WIRED, lft: i < 5 ? 300 - i * 60 : 7200 }, RADIO_DOWN] }),
		})
	);
	assert.equal(renewed.status, 'pass', renewed.reason);
	assert.equal(renewed.metrics.lease.renewed, true);
	assert.match(renewed.reason, /lease on enp5s0 renewed inside the window/);
	const fixed = judge(soakText({ base: { ...singleWired, ifaces: [{ ...WIRED, lft: null }] } }));
	assert.match(fixed.reason, /not leased \(valid_lft forever\)/);
});

void test('a soak cut short is could-not-look, never a pass — unless what it did record crossed a bar', () => {
	const short = judge(soakText({ base: singleWired, n: 4, done: false }));
	assert.equal(short.status, 'could-not-look');
	assert.match(short.reason, /did not finish: 4\/11 complete samples, no end sentinel/);
	const shortBad = judge(
		soakText({
			base: singleWired,
			n: 4,
			done: false,
			at: (i) => (i === 2 ? { dnsFail: ['api.github.com'] } : {}),
		})
	);
	assert.equal(shortBad.status, 'fail');
	assert.match(shortBad.reason, /api\.github\.com failed.*did not finish/);
	const nothing = judge('');
	assert.equal(nothing.status, 'could-not-look');
	assert.match(nothing.reason, /never started/);
});

void test('a sample missing a host or a fetch is unreadable, not clean', () => {
	const text = soakText({ base: singleWired }).replace(/^DNS api\.github\.com .*\n/m, '');
	const r = judge(text);
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /sample 1 has no resolution line for api\.github\.com/);
});

// ── run(), with a fake node ────────────────────────────────────────────────

function fakeCtx(replies) {
	const sent = [];
	return {
		sent,
		ctx: {
			node: 'claw-fixture',
			machine: {},
			log: () => {},
			nowMs: 0,
			async exec(script, o) {
				sent.push({ script, o });
				const next = replies.find((r) => r.match.test(script));
				return next ? next.reply(script) : { ok: false, stdout: '', stderr: 'unexpected script' };
			},
		},
	};
}

const noSleep = async () => {};
const DATA = () => ({ url: 'http://data.example:9002' });

void test('run(): an unnamed data endpoint is could-not-look and nothing is started', async () => {
	const { ctx, sent } = fakeCtx([]);
	const r = await makeNetworkSoakTest({
		dataEndpoint: () => ({ url: null, why: 'pm2-hosts unreadable' }),
		sleep: noSleep,
	}).run(ctx);
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /data endpoint's host could not be named \(pm2-hosts unreadable\)/);
	assert.equal(sent.length, 0);
});

void test('run(): a soak that never answers a poll is could-not-look, says why, and is still cleaned up', async () => {
	const { ctx, sent } = fakeCtx([
		{ match: /setsid/, reply: () => ({ ok: true, stdout: 'NETSOAK_DIR /tmp/qualify-net.Zz9\n' }) },
		{
			match: /^cat /,
			reply: () => ({
				ok: false,
				stdout: '',
				stderr: 'ssh: connect to host claw-fixture port 22: No route to host',
			}),
		},
		{ match: /rm -rf/, reply: () => ({ ok: true, stdout: 'NETSOAK_CLEAN\n' }) },
	]);
	const r = await makeNetworkSoakTest({ dataEndpoint: DATA, sleep: noSleep }).run(ctx);
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /never started.*poll\(s\) could not reach the node \(first: ssh: connect/);
	assert.match(sent.at(-1).script, /rm -rf/);
	assert.ok(sent.filter((s) => /^cat /.test(s.script)).length > 1, 'it kept polling');
});

void test('run(): it resolves the data endpoint host and judges what the node wrote', async () => {
	const { ctx, sent } = fakeCtx([
		{ match: /setsid/, reply: () => ({ ok: true, stdout: 'NETSOAK_DIR /tmp/qualify-net.Zz9\n' }) },
		{ match: /^cat /, reply: () => ({ ok: true, stdout: soakText({ base: singleWired }) }) },
		{ match: /rm -rf/, reply: () => ({ ok: true, stdout: 'NETSOAK_CLEAN\n' }) },
	]);
	const r = await makeNetworkSoakTest({ dataEndpoint: DATA, sleep: noSleep }).run(ctx);
	assert.equal(r.status, 'pass', r.reason);
	assert.match(sent[0].script, /for qh in github\.com api\.github\.com data\.example; do/);
	assert.equal(sent.filter((s) => /^cat /.test(s.script)).length, 1, 'done on the first poll');
	assert.equal(r.metrics.dataHost, 'data.example');
});

// ── the real loop, on this machine, at a tiny size ─────────────────────────

void test('the real loop runs detached, samples on schedule, is read back, and leaves nothing behind', async () => {
	const server = createServer((_, res) => res.end('ok'));
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${server.address().port}/`;
	const tmp = mkdtempSync(join(tmpdir(), 'netsoak-test-'));
	const bash = async (script) => {
		const { stdout } = await run('bash', ['-c', script], { env: { ...process.env, TMPDIR: tmp } });
		return { ok: true, stdout, stderr: '' };
	};
	try {
		const t = makeNetworkSoakTest({
			dataEndpoint: () => ({ url: 'http://localhost:9002' }),
			sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1500))),
			samples: 2,
			everySec: 1,
			url,
			hosts: ['localhost'],
		});
		const r = await t.run({ node: 'local', machine: {}, log: () => {}, nowMs: 0, exec: bash });
		assert.notEqual(r.status, 'could-not-look', r.reason);
		assert.equal(r.metrics.samples, 2, r.reason);
		assert.deepEqual(r.metrics.dnsFailures, {});
		assert.equal(r.metrics.https.fetches, 2 * HTTPS_PER_SAMPLE);
		assert.equal(r.metrics.https.failed, 0, r.reason);
		assert.deepEqual(readdirSync(tmp), [], 'the mktemp directory was removed');
		assert.equal(
			spawnSync('pgrep', ['-f', `${tmp}/qualify-net`], { encoding: 'utf8' }).stdout.trim(),
			''
		);
	} finally {
		server.close();
		rmSync(tmp, { recursive: true, force: true });
	}
});

void test('cleanup stops a loop that is still running, by its process group', async () => {
	const tmp = mkdtempSync(join(tmpdir(), 'netsoak-test-'));
	const env = { ...process.env, TMPDIR: tmp };
	try {
		const loop = soakLoopScript({
			hosts: ['localhost'],
			url: 'http://127.0.0.1:9/',
			samples: 50,
			everySec: 30,
		});
		const { stdout } = await run('bash', ['-c', startScript(loop, 600)], { env });
		const dir = stdout.match(/^NETSOAK_DIR (\S+)$/m)[1];
		await new Promise((r) => setTimeout(r, 300));
		assert.match(spawnSync('pgrep', ['-f', `${dir}/loop.sh`], { encoding: 'utf8' }).stdout, /\d/);
		const c = await run('bash', ['-c', cleanupScript(dir)], { env });
		assert.match(c.stdout, /NETSOAK_KILLED \d+\nNETSOAK_CLEAN/);
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(
			spawnSync('pgrep', ['-f', `${dir}/loop.sh`], { encoding: 'utf8' }).stdout.trim(),
			''
		);
		assert.deepEqual(readdirSync(tmp), []);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
