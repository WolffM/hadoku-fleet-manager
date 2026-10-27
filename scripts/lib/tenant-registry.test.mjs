import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateHostingRequest } from './hosting-request.mjs';
import {
	NO_TENANT,
	deployScript,
	judgeHosting,
	parseObserved,
	pathUnit,
	tenantUnit,
} from './hosting.mjs';
import {
	readTenantRegistry,
	registerTenant,
	tenantSpec,
	tenantSpecFrom,
} from './tenant-registry.mjs';

const request = (name) =>
	validateHostingRequest(
		JSON.parse(readFileSync(new URL(`./fixtures/hosting-${name}.json`, import.meta.url), 'utf8'))
	).request;
const CARDTABLE = tenantSpecFrom(request('cardtable'));
const ARCHIVEBOT = tenantSpecFrom(request('archivebot'));
const CTL = { lan: '192.0.2.10', tailnet4: '198.51.100.1', tailnet6: null };

test("cardtable's derived names are exactly the ones the hand-written table held (nothing deployed changes)", () => {
	assert.deepEqual(
		{ ...CARDTABLE },
		{
			app: 'cardtable',
			kind: 'agent',
			runtime: 'agent',
			slice: 'hosting-cardtable.slice',
			service: 'cardtable-agent.service',
			pathUnit: 'cardtable-agent.path',
			portUnit: 'hosting-cardtable-port.service',
			user: 'cardtable-agent',
			home: '/var/lib/cardtable-agent',
			exec: '/opt/hosting/cardtable/run',
			port: 7621,
			ingress: 'controller',
			workersOutliveRestart: true,
			noticeMin: 15,
		}
	);
	const unit = tenantUnit(CARDTABLE);
	assert.match(
		unit,
		/^Environment=CARDTABLE_AGENT_PORT=7621$/m,
		'the env name the live agent reads'
	);
	assert.match(unit, /^Delegate=yes$/m);
	assert.match(unit, /^KillMode=process$/m);
});

/**
 * The bytes on the node. A re-declare rewrites a unit whose text changed and
 * restarts the tenant, so a render that drifts by one byte restarts
 * cardtable's agent (and every JVM it supervises). The cardtable hashes are
 * of `/etc/systemd/system/cardtable-agent.{service,path}` as read from claw-9
 * on 2026-10-27; the pm2 one is the unit hadoku_site#490 deploys against.
 */
test('the rendered units are byte-identical to what is deployed', () => {
	const sha = (s) => createHash('sha256').update(s).digest('hex');
	assert.equal(
		sha(tenantUnit(CARDTABLE)),
		'cf9213891c8475e1a52f7a14395932841c5e80af4add3d1e9236c5d1579842c4'
	);
	assert.equal(
		sha(pathUnit(CARDTABLE)),
		'e579b912fd9417d43b760b536e1af6763527accdfe10b3962d2c093e3f208ddc'
	);
	assert.equal(
		sha(tenantUnit(ARCHIVEBOT)),
		'ed603ed637ffe1aac0c853c36191325885d46707266c141cc4a9507968c57c96'
	);
});

test('without workersOutliveRestart an agent is killed whole on restart', () => {
	const unit = tenantUnit({ ...CARDTABLE, workersOutliveRestart: false });
	assert.doesNotMatch(unit, /Delegate=|KillMode=/);
});

test('a service is a pm2 daemon as its own user, with no executable and no firewall opening', () => {
	assert.equal(ARCHIVEBOT.user, 'archivebot-svc');
	assert.equal(ARCHIVEBOT.service, 'pm2-archivebot-svc.service');
	assert.equal(ARCHIVEBOT.exec, null);
	assert.equal(ARCHIVEBOT.pathUnit, null);
	const unit = tenantUnit(ARCHIVEBOT);
	assert.match(unit, /^User=archivebot-svc$/m);
	assert.match(unit, /^Slice=hosting-archivebot\.slice$/m);
	assert.match(unit, /^Environment=PM2_HOME=\/var\/lib\/archivebot-svc\/\.pm2$/m);
	assert.match(unit, /^OOMScoreAdjust=-500$/m);
	const d = deployScript(ARCHIVEBOT, { memoryMb: 1024, cores: 1 }, CTL, { shared: true });
	assert.doesNotMatch(d, /ufw allow|iptables -t raw -I/, 'a tunnel tenant opens nothing');
	assert.doesNotMatch(
		d,
		/PATH_UNIT" >\/dev\/null|install -d -o root -g root -m 0755 "\$\(dirname "\$EXEC"\)"/
	);
	assert.match(d, /# No firewall rule: this tenant binds loopback only\./);
	const agent = deployScript(CARDTABLE, { memoryMb: 4096, cores: 4 }, CTL, { shared: true });
	assert.match(agent, /ufw allow from "\$CONTROLLER_IP"/);
	assert.match(agent, /iptables -t raw -I PREROUTING/);
});

test('a tunnel tenant must bind loopback only, read from the socket', () => {
	const declared = { tenant: 'archivebot', memoryMb: 1024, cores: 1, port: 3004 };
	const obs = (addrs) =>
		parseObserved(
			`OBSERVE-BEGIN\nlistenerAddrs=${addrs}\nciWorkers=0\nciListeners=0\nciProcs=0\nOBSERVE-END`
		);
	const port = (r) =>
		r.findings.filter((f) => f.category === 'hosting-port-exposed').map((f) => f.why);
	assert.deepEqual(
		port(judgeHosting(declared, obs('127.0.0.1:3004 [::1]:3004'), 'shared', null, ARCHIVEBOT)),
		[]
	);
	assert.match(
		port(judgeHosting(declared, obs('0.0.0.0:3004'), 'shared', null, ARCHIVEBOT))[0],
		/bound on 0\.0\.0\.0:3004/
	);
	// No reach probe is demanded of a loopback tenant.
	const r = judgeHosting(declared, obs('127.0.0.1:3004'), 'shared', null, ARCHIVEBOT);
	assert.ok(!r.findings.some((f) => f.category === 'hosting-port'));
});

test('an unregistered tenant is refused, never judged against another one', () => {
	const r = judgeHosting(
		{ tenant: 'nobody', memoryMb: 1, cores: 1, port: 1 },
		parseObserved('OBSERVE-BEGIN\nOBSERVE-END'),
		'shared',
		null,
		null
	);
	assert.match(r.findings[0].why, /not registered/);
	assert.equal(NO_TENANT.app, 'none');
});

test('the registry round-trips, and a corrupt entry THROWS rather than reading as no tenants', () => {
	const dir = mkdtempSync(join(tmpdir(), 'tenant-registry-'));
	try {
		assert.deepEqual(readTenantRegistry(dir), { tenants: {} });
		registerTenant(dir, request('cardtable'), {
			source: 'WolffM/hadoku-cardtable:hosting.json',
			by: 'test',
		});
		const reg = readTenantRegistry(dir);
		assert.deepEqual(tenantSpec(reg, 'cardtable'), CARDTABLE);
		assert.equal(tenantSpec(reg, 'nobody'), null);
		assert.equal(reg.tenants.cardtable.source, 'WolffM/hadoku-cardtable:hosting.json');
		const file = join(dir, 'hosting-tenants.json');
		const doc = JSON.parse(readFileSync(file, 'utf8'));
		doc.tenants.cardtable.request.slices.unit.memoryMb = -1;
		writeFileSync(file, JSON.stringify(doc));
		assert.throws(() => readTenantRegistry(dir), /cardtable is not a valid request/);
		writeFileSync(file, '{ not json');
		assert.throws(() => readTenantRegistry(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
