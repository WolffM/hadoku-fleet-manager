import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
	OBSERVE,
	UNIT,
	connectorLive,
	convergeTunnels,
	credentialsFromRunToken,
	parseObserve,
	appLayerHost,
	placementsFor,
	renderConfig,
	repairScript,
	tunnelHosts,
} from './service-tunnels.mjs';

const ID = '11111111-2222-3333-4444-555555555555';
const ACCT = 'acct0';
const ZONE_ID = 'zone0';
const sha = (s) => createHash('sha256').update(s).digest('hex');

const manifest = {
	machines: {
		hokon: { role: 'guest' },
		'claw-4': { services: 'pm2' },
		'claw-6': { services: 'pm2' },
		'claw-5': {},
	},
};
const hostsDoc = {
	hub: 'hokon',
	hosts: {
		hokon: { tunnel: 'hadoku-site' },
		'claw-4': { tunnel: 'claw-4' },
		'claw-6': { tunnel: null },
	},
};
const childApps = {
	apps: [
		{ id: 'pygmalion', host: 'claw-4', tunnel: { port: '9002' } },
		{ id: 'hub-app', tunnel: { port: '9100' } },
		{
			id: 'archive-bot',
			host: 'claw-6',
			handWired: { port: '3004', hostname: 'archivebot.hadoku.me' },
		},
	],
};

test("the unit is claw-4's, byte for byte", () => {
	assert.equal(sha(UNIT), '5c47829fd10055c14c449f2e74fca6d1c0fed9e5f9b1b04d497b6aed79a7d690');
});

test("the config renders claw-4's hand-made file for the same inputs", () => {
	assert.equal(
		renderConfig(ID, placementsFor('claw-4', childApps)),
		`tunnel: ${ID}\ncredentials-file: /etc/cloudflared/${ID}.json\ningress:\n` +
			'  - hostname: pygmalion.hadoku.me\n    service: http://127.0.0.1:9002\n' +
			'  - service: http_status:404\n'
	);
	assert.equal(
		renderConfig(ID, []),
		`tunnel: ${ID}\ncredentials-file: /etc/cloudflared/${ID}.json\ningress:\n  - service: http_status:404\n`
	);
});

test('the hub and a node without services "pm2" are not owned', () => {
	assert.deepEqual(tunnelHosts(manifest, hostsDoc), [
		{ node: 'claw-4', declared: 'claw-4' },
		{ node: 'claw-6', declared: null },
	]);
});

test('placements: host and standby route; a hand-wired app keeps its own hostname', () => {
	const apps = {
		apps: [
			...childApps.apps,
			{ id: 'pyg2', host: 'claw-4', standby: 'claw-6', tunnel: { port: 9 } },
		],
	};
	assert.deepEqual(placementsFor('claw-6', apps), [
		{ id: 'archive-bot', role: 'primary', port: '3004', hostname: 'archivebot.hadoku.me' },
		{ id: 'pyg2', role: 'standby', port: '9', hostname: 'pyg2.hadoku.me' },
	]);
});

test('a run token becomes the credentials file cloudflared reads', () => {
	const rt = Buffer.from(JSON.stringify({ a: ACCT, t: ID, s: 'c2VjcmV0' })).toString('base64');
	assert.deepEqual(JSON.parse(credentialsFromRunToken(rt)), {
		AccountTag: ACCT,
		TunnelSecret: 'c2VjcmV0',
		TunnelID: ID,
	});
	assert.throws(
		() => credentialsFromRunToken(Buffer.from('{"a":"x"}').toString('base64')),
		/missing/
	);
});

test('the observe script prints no credentials, and its output parses', () => {
	assert.doesNotMatch(OBSERVE, /cat .*\.json|base64 .*\.json/);
	const out =
		`CONFIG ${Buffer.from('cfg').toString('base64')}\nCREDS ${ID}.json \n` +
		`UNIT ${Buffer.from(UNIT).toString('base64')}\nSTATE enabled active\n` +
		'READY {"status":200,"readyConnections":4,"connectorId":"c1"}\n';
	assert.deepEqual(parseObserve(out), {
		config: 'cfg',
		creds: [`${ID}.json`],
		unit: UNIT,
		enabled: 'enabled',
		active: 'active',
		ready: { status: 200, readyConnections: 4, connectorId: 'c1' },
	});
	assert.deepEqual(parseObserve('CONFIG -\nCREDS \nUNIT -\nSTATE - -\n'), {
		config: null,
		creds: [],
		unit: null,
		enabled: '-',
		active: '-',
		ready: null,
	});
});

test('the repair script writes the secret root-only and never echoes it', () => {
	const s = repairScript({
		tunnelId: ID,
		config: 'c',
		creds: 'SECRET',
		writeUnit: true,
		restart: true,
	});
	assert.match(
		s,
		new RegExp(`install -m 0600 -o root -g root /dev/stdin /etc/cloudflared/${ID}.json`)
	);
	assert.doesNotMatch(s, /SECRET|set -x|echo /);
	assert.match(s, /daemon-reload/);
	assert.match(s, /systemctl restart cloudflared$/);
	assert.match(
		repairScript({ tunnelId: ID, config: null, creds: null, writeUnit: false, restart: false }),
		/systemctl start cloudflared$/
	);
});

test('connector: the host and Cloudflare must name the same live connector', () => {
	const ready = { readyConnections: 4, connectorId: 'c1' };
	assert.equal(connectorLive(ready, [{ id: 'c1', conns: [{}, {}] }]).ok, true);
	assert.match(connectorLive(ready, [{ id: 'c2', conns: [{}] }]).why, /no connector c1/);
	assert.match(connectorLive(ready, [{ id: 'c1', conns: [] }]).why, /no live connections/);
	assert.match(connectorLive(null, []).why, /reports no connector/);
	assert.match(connectorLive({ readyConnections: 0, connectorId: 'c1' }, []).why, /0 ready/);
});

/** A fake fleet: one Cloudflare account, hosts whose /etc/cloudflared we hold. */
function world({ tunnels = {}, hosts = {}, cname = {}, health = 200, fail = {} } = {}) {
	const calls = [];
	const cf = {
		zone: async () =>
			fail.zone
				? { ok: false, why: fail.zone }
				: { ok: true, result: [{ id: ZONE_ID, account: { id: ACCT } }] },
		tunnels: async (_a, name) => ({
			ok: true,
			result: tunnels[name] ? [{ id: tunnels[name], name }] : [],
		}),
		create: async (_a, name) => {
			calls.push(`create ${name}`);
			if (fail.create) return { ok: false, why: fail.create };
			tunnels[name] = ID;
			return { ok: true, result: { id: ID, name } };
		},
		runToken: async () => ({
			ok: true,
			result: Buffer.from(JSON.stringify({ a: ACCT, t: ID, s: 'S' })).toString('base64'),
		}),
		connections: async () => ({
			ok: true,
			result: Object.values(hosts)
				.filter((h) => h.active === 'active')
				.map((h) => ({ id: h.connector, conns: [{}, {}] })),
		}),
		cname: async (_z, name) => ({
			ok: true,
			result: cname[name] ? [{ content: cname[name] }] : [],
		}),
	};
	const onNode = (node, script) => {
		const h = hosts[node];
		if (script === OBSERVE) {
			const b = (v) => (v == null ? '-' : Buffer.from(v).toString('base64'));
			return {
				ok: true,
				out:
					`CONFIG ${b(h.config)}\nCREDS ${h.creds.join(' ')}\nUNIT ${b(h.unit)}\nSTATE ${h.enabled} ${h.active}\n` +
					(h.active === 'active'
						? `READY {"readyConnections":4,"connectorId":"${h.connector}"}\n`
						: ''),
			};
		}
		calls.push(`repair ${node}`);
		h.script = script;
		if (script.includes(`${ID}.json`)) h.creds = [`${ID}.json`];
		h.config = renderConfig(ID, placementsFor(node, childApps));
		h.unit = UNIT;
		h.enabled = 'enabled';
		h.active = 'active';
		return { ok: true, out: '' };
	};
	const deps = { cf, onNode, health: async () => ({ status: health }), wait: async () => {} };
	return { deps, calls, hosts };
}

const claw4Live = () => ({
	config: renderConfig(ID, placementsFor('claw-4', childApps)),
	creds: [`${ID}.json`],
	unit: UNIT,
	enabled: 'enabled',
	active: 'active',
	connector: 'c4',
});
const bare = () => ({
	config: null,
	creds: [],
	unit: null,
	enabled: '-',
	active: '-',
	connector: 'c6',
});
const run = (w, opts = {}) =>
	convergeTunnels({
		manifest,
		hostsDoc,
		childApps,
		token: 't',
		write: true,
		deps: w.deps,
		log: () => {},
		...opts,
	});

test('claw-4 as it stands: verified, and NOTHING is written or restarted', async () => {
	const w = world({
		tunnels: { 'claw-4': ID },
		hosts: { 'claw-4': claw4Live(), 'claw-6': claw4Live() },
		cname: { 'pygmalion.hadoku.me': `${ID}.cfargotunnel.com` },
	});
	const { tunnels, findings } = await run(w, {
		hostsDoc: { ...hostsDoc, hosts: { 'claw-4': { tunnel: 'claw-4' } } },
	});
	assert.deepEqual(findings, []);
	assert.deepEqual(w.calls, []);
	assert.equal(tunnels[0].status, 'ok');
	assert.equal(tunnels[0].connector, 'c4');
});

test('a bare host: tunnel created, creds+config+unit written, connector proven, then asks for the declaration', async () => {
	const w = world({
		hosts: { 'claw-6': bare() },
		cname: { 'archivebot.hadoku.me': `${ID}.cfargotunnel.com` },
	});
	const { tunnels, findings } = await run(w, {
		hostsDoc: { ...hostsDoc, hosts: { 'claw-6': { tunnel: null } } },
	});
	assert.deepEqual(w.calls, ['create claw-6', 'repair claw-6']);
	assert.deepEqual(tunnels[0].repaired, ['creds', 'config', 'unit', 'down']);
	assert.equal(tunnels[0].status, 'live');
	assert.deepEqual(
		findings.map((f) => f.kind),
		['tunnel-undeclared']
	);
	assert.doesNotMatch(JSON.stringify({ tunnels, findings }), /"S"|TunnelSecret/);
});

test('check-only (--plan): drift is a finding and nothing is created or written', async () => {
	const w = world({ hosts: { 'claw-6': bare() } });
	const { findings } = await run(w, {
		write: false,
		hostsDoc: { ...hostsDoc, hosts: { 'claw-6': { tunnel: null } } },
	});
	assert.deepEqual(w.calls, []);
	assert.deepEqual(
		findings.map((f) => f.kind),
		['tunnel-missing']
	);
});

test('no token: every owned host is a finding, never a pass', async () => {
	const w = world();
	const { findings } = await run(w, { token: undefined });
	assert.deepEqual(
		findings.map((f) => `${f.node} ${f.kind}`),
		['claw-4 tunnel-unverified', 'claw-6 tunnel-unverified']
	);
});

test('a 403 from Cloudflare names the call that was refused', async () => {
	const w = world({
		hosts: { 'claw-6': bare() },
		fail: { create: 'POST /accounts/acct0/cfd_tunnel: HTTP 403 (10000 Authentication error)' },
	});
	const { findings } = await run(w, {
		hostsDoc: { ...hostsDoc, hosts: { 'claw-6': { tunnel: null } } },
	});
	assert.equal(findings[0].kind, 'tunnel-create-failed');
	assert.match(findings[0].reason, /403/);
});

test('a declared tunnel named for another node is never acted on', async () => {
	const w = world({ hosts: { 'claw-6': bare() } });
	const { findings } = await run(w, {
		hostsDoc: { ...hostsDoc, hosts: { 'claw-6': { tunnel: 'claw-4' } } },
	});
	assert.deepEqual(w.calls, []);
	assert.equal(findings[0].kind, 'tunnel-name');
});

test('a primary placement whose CNAME points elsewhere is reported, not rerouted', async () => {
	const w = world({
		tunnels: { 'claw-4': ID },
		hosts: { 'claw-4': claw4Live() },
		cname: { 'pygmalion.hadoku.me': 'other.cfargotunnel.com' },
	});
	const { findings } = await run(w, {
		hostsDoc: { ...hostsDoc, hosts: { 'claw-4': { tunnel: 'claw-4' } } },
	});
	assert.deepEqual(w.calls, []);
	assert.equal(findings[0].kind, 'tunnel-dns');
});

test('a hostname that answers 5xx through the tunnel is a finding', async () => {
	const w = world({
		tunnels: { 'claw-4': ID },
		hosts: { 'claw-4': claw4Live() },
		cname: { 'pygmalion.hadoku.me': `${ID}.cfargotunnel.com` },
		health: 530,
	});
	const { findings } = await run(w, {
		hostsDoc: { ...hostsDoc, hosts: { 'claw-4': { tunnel: 'claw-4' } } },
	});
	assert.equal(findings[0].kind, 'tunnel-route');
});

test('appLayerHost: the row named by tenant or id, its host or the hub; null when it is no service', () => {
	const hostsDoc = { hub: 'hokon', hosts: {} };
	const childApps = {
		apps: [
			{ id: 'watchparty', handWired: { port: '8079' } },
			{ id: 'archive-bot', tenant: 'archivebot', host: 'claw-4', tunnel: { port: 3004 } },
			{ id: 'contact' },
		],
	};
	assert.equal(appLayerHost('watchparty', { hostsDoc, childApps }), 'hokon');
	assert.equal(appLayerHost('archivebot', { hostsDoc, childApps }), 'claw-4');
	assert.equal(
		appLayerHost('contact', { hostsDoc, childApps }),
		null,
		'a UI package is not a service'
	);
	assert.equal(appLayerHost('nobody', { hostsDoc, childApps }), null);
});

test('a primary with a hot standby: a CNAME on the standby tunnel is routed, a third one is not', async () => {
	const SB = '22222222-2222-2222-2222-222222222222';
	const paired = {
		...childApps,
		apps: childApps.apps.map((a) => (a.id === 'pygmalion' ? { ...a, standby: 'claw-6' } : a)),
	};
	const opts = {
		childApps: paired,
		hostsDoc: { ...hostsDoc, hosts: { 'claw-4': { tunnel: 'claw-4' } } },
	};
	const failover = world({
		tunnels: { 'claw-4': ID, 'claw-6': SB },
		hosts: { 'claw-4': claw4Live() },
		cname: { 'pygmalion.hadoku.me': `${SB}.cfargotunnel.com` },
	});
	failover.hosts['claw-4'].config = renderConfig(ID, placementsFor('claw-4', paired));
	assert.deepEqual((await run(failover, opts)).findings, []);

	const stray = world({
		tunnels: { 'claw-4': ID, 'claw-6': SB },
		hosts: { 'claw-4': claw4Live() },
		cname: { 'pygmalion.hadoku.me': 'other.cfargotunnel.com' },
	});
	stray.hosts['claw-4'].config = renderConfig(ID, placementsFor('claw-4', paired));
	const { findings } = await run(stray, opts);
	assert.equal(findings[0].kind, 'tunnel-dns');
	assert.match(findings[0].reason, /or its standby claw-6's 2222/);
});
