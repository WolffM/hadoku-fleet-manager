import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	convergePeerPorts,
	judgePair,
	parseObserve,
	peerPorts,
	renderUnit,
	rules,
	unitName,
} from './service-peers.mjs';

const hostsDoc = {
	hub: 'hokon',
	hosts: {
		hokon: { tailnetIp: '192.0.2.1' },
		'claw-4': { tailnetIp: '192.0.2.4' },
		'claw-6': { tailnetIp: '192.0.2.6' },
	},
};
const childApps = (env) => ({
	apps: [
		{ id: 'pygmalion', host: 'claw-4', standby: 'claw-6', tunnel: { port: '9002', env } },
		{ id: 'solo', host: 'claw-4', tunnel: { port: '9100', env: { SOLO_PEER_PORT: '9101' } } },
	],
});
const PYG = childApps({ PYGMALION_PEER_PORT: '9022' });

test('each host of a pair closes the peer port to everyone but the other; no pair, nothing', () => {
	const { byNode, problems } = peerPorts(PYG, hostsDoc);
	assert.deepEqual(problems, []);
	assert.deepEqual(byNode.get('claw-4'), [
		{ app: 'pygmalion', port: 9022, mate: 'claw-6', mateIp: '192.0.2.6' },
	]);
	assert.deepEqual(byNode.get('claw-6'), [
		{ app: 'pygmalion', port: 9022, mate: 'claw-4', mateIp: '192.0.2.4' },
	]);
	assert.equal(peerPorts(childApps({}), hostsDoc).byNode.size, 0, 'no peer port declared');
	assert.match(
		peerPorts(childApps({ PYGMALION_PEER_PORT: 'x' }), hostsDoc).problems[0].why,
		/not a port/
	);
	const noIp = { ...hostsDoc, hosts: { ...hostsDoc.hosts, 'claw-6': {} } };
	assert.match(peerPorts(PYG, noIp).problems[0].why, /claw-6 has no tailnetIp/);
});

test("the rules are judged from the kernel's own printed form, the unit only for boot", () => {
	const p = { app: 'pygmalion', port: 9022, mate: 'claw-6', mateIp: '192.0.2.6' };
	assert.equal(
		rules(p).v4,
		'-A PREROUTING ! -s 192.0.2.6/32 -i tailscale0 -p tcp -m tcp --dport 9022 -j DROP'
	);
	const good = {
		units: { pygmalion: renderUnit(p) },
		enabled: { pygmalion: 'enabled' },
		raw4: [rules(p).v4],
		raw6: [rules(p).v6],
	};
	assert.equal(judgePair(p, good), null);
	// An enabled unit whose rule was flushed is still an open port.
	assert.deepEqual(judgePair(p, { ...good, raw4: [] }), ['the IPv4 drop']);
	// The rule for another mate is not this pair's rule.
	assert.deepEqual(judgePair({ ...p, mateIp: '192.0.2.4' }, good).slice(0, 1), ['the IPv4 drop']);
	assert.match(renderUnit(p), /ExecStartPre=-\/usr\/sbin\/iptables -t raw -D PREROUTING/);
	assert.equal(unitName('pygmalion'), 'fleet-peer-pygmalion.service');
});

test('parseObserve needs its end marker: a cut-off answer is not an empty table', () => {
	assert.equal(parseObserve('RAW4 -P PREROUTING ACCEPT\n').complete, false);
	const o = parseObserve(
		`UNIT pygmalion ${Buffer.from('x').toString('base64')}\nENABLED pygmalion enabled\nRAW4 -P PREROUTING ACCEPT\nOBSERVED\n`
	);
	assert.equal(o.units.pygmalion, 'x');
	assert.equal(o.enabled.pygmalion, 'enabled');
	assert.equal(o.complete, true);
});

/** A fake host: holds a unit file and a raw table; the repair script "runs" by installing both. */
function fakeHosts(initial = {}) {
	const state = {};
	const calls = [];
	for (const n of ['claw-4', 'claw-6'])
		state[n] = { unit: null, enabled: null, raw4: [], raw6: [], ...initial[n] };
	const onNode = async (node, script) => {
		const h = state[node];
		if (script.includes('OBSERVED')) {
			const b = h.unit === null ? '-' : Buffer.from(h.unit).toString('base64');
			return {
				ok: true,
				out:
					`UNIT pygmalion ${b}\nENABLED pygmalion ${h.enabled ?? ''}\n` +
					['-P PREROUTING ACCEPT', ...h.raw4].map((l) => `RAW4 ${l}`).join('\n') +
					'\n' +
					['-P PREROUTING ACCEPT', ...h.raw6].map((l) => `RAW6 ${l}`).join('\n') +
					'\nOBSERVED\n',
			};
		}
		calls.push(node);
		const p = peerPorts(PYG, hostsDoc).byNode.get(node)[0];
		h.unit = renderUnit(p);
		h.enabled = 'enabled';
		h.raw4 = [rules(p).v4];
		h.raw6 = [rules(p).v6];
		return { ok: true, out: '' };
	};
	return { onNode, state, calls };
}

test('converge: an open pair is closed on both hosts and read back from the kernel; a closed one is left alone', async () => {
	const f = fakeHosts();
	const { peers, findings } = await convergePeerPorts({
		childApps: PYG,
		hostsDoc,
		nodes: ['claw-4', 'claw-6'],
		write: true,
		deps: { onNode: f.onNode },
	});
	assert.deepEqual(findings, []);
	assert.deepEqual(f.calls, ['claw-4', 'claw-6']);
	assert.deepEqual(
		peers.map((p) => [p.node, p.status]),
		[
			['claw-4', 'repaired'],
			['claw-6', 'repaired'],
		]
	);
	const again = await convergePeerPorts({
		childApps: PYG,
		hostsDoc,
		nodes: ['claw-4', 'claw-6'],
		write: true,
		deps: { onNode: f.onNode },
	});
	assert.deepEqual(f.calls, ['claw-4', 'claw-6'], 'nothing rewritten');
	assert.ok(again.peers.every((p) => p.status === 'ok'));
});

test('plan mode reports drift and writes nothing; an unreadable host is a finding, never "closed"', async () => {
	const f = fakeHosts();
	const plan = await convergePeerPorts({
		childApps: PYG,
		hostsDoc,
		nodes: ['claw-4'],
		write: false,
		deps: { onNode: f.onNode },
	});
	assert.deepEqual(f.calls, []);
	assert.equal(plan.findings[0].kind, 'peer-port-drift');
	const dark = await convergePeerPorts({
		childApps: PYG,
		hostsDoc,
		nodes: ['claw-4'],
		write: true,
		deps: { onNode: async () => ({ ok: false, error: 'ssh timeout' }) },
	});
	assert.equal(dark.findings[0].kind, 'peer-port-unreadable');
	assert.match(dark.findings[0].reason, /ssh timeout/);
});

test('a repair that leaves the rule missing is an open port, said so', async () => {
	const f = fakeHosts();
	const broken = async (node, script) =>
		script.includes('OBSERVED') ? f.onNode(node, script) : { ok: true, out: '' };
	const { findings } = await convergePeerPorts({
		childApps: PYG,
		hostsDoc,
		nodes: ['claw-4'],
		write: true,
		deps: { onNode: broken },
	});
	assert.equal(findings[0].kind, 'peer-port-open');
});
