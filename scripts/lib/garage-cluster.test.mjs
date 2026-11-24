/**
 * The layout manager and bucket provisioning against a REAL Garage v2.5.0
 * cluster (hadoku-fleet-manager#141). Same approach as hadoku-dataplatform's
 * server/tests/garage harness: the pinned release binary (toolchain-garage.mjs's
 * GARAGE_RELEASE, held to its sha256), one process per zone on loopback ports,
 * every process killed at the end. Nothing here is a stand-in for the admin
 * API: the plan is computed from what the cluster reports, applied through
 * garage-apply.mjs, and read back.
 *
 * The binary is downloaded once into $XDG_CACHE_HOME/fleet-manager/garage/
 * and refused if its hash differs; FLEET_GARAGE_BIN points at a local copy,
 * held to the same hash.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
	chmodSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { GARAGE_RELEASE } from './toolchain-garage.mjs';
import { garageState, httpAdmin, readCluster } from './garage-admin.mjs';
import { applyBuckets, applyLayout, observeBuckets, observeCluster } from './garage-apply.mjs';
import { planBuckets, planLayout } from './garage-layout.mjs';

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

async function garageBinary() {
	const override = process.env.FLEET_GARAGE_BIN;
	if (override) {
		assert.equal(
			sha256(override),
			GARAGE_RELEASE.sha256,
			`FLEET_GARAGE_BIN=${override} is not the pinned v${GARAGE_RELEASE.version}`
		);
		return override;
	}
	const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
	const path = join(cache, 'fleet-manager', 'garage', GARAGE_RELEASE.version, 'garage');
	if (existsSync(path) && sha256(path) === GARAGE_RELEASE.sha256) return path;
	mkdirSync(dirname(path), { recursive: true });
	const part = `${path}.part-${process.pid}`;
	const res = await fetch(GARAGE_RELEASE.url, { signal: AbortSignal.timeout(300_000) });
	assert.ok(res.ok, `${GARAGE_RELEASE.url}: HTTP ${res.status}`);
	await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
	const got = sha256(part);
	if (got !== GARAGE_RELEASE.sha256) {
		rmSync(part, { force: true });
		assert.fail(`${GARAGE_RELEASE.url} has sha256 ${got}, not the pinned ${GARAGE_RELEASE.sha256}`);
	}
	chmodSync(part, 0o755);
	renameSync(part, path);
	return path;
}

const freePort = () =>
	new Promise((res, rej) => {
		const s = createServer();
		s.unref();
		s.on('error', rej);
		s.listen(0, '127.0.0.1', () => {
			const { port } = s.address();
			s.close(() => res(port));
		});
	});

/** A local cluster of `n` zones named claw-a, claw-b, ...; none in a layout yet. */
class Cluster {
	constructor(bin, root) {
		this.bin = bin;
		this.root = root;
		this.token = randomBytes(16).toString('hex');
		this.secret = randomBytes(32).toString('hex');
		this.nodes = new Map();
	}

	async add(name) {
		const dir = join(this.root, name);
		mkdirSync(dir, { recursive: true });
		const n = {
			name,
			dir,
			rpc: await freePort(),
			s3: await freePort(),
			adminPort: await freePort(),
		};
		writeFileSync(
			join(dir, 'garage.toml'),
			[
				`metadata_dir = "${join(dir, 'meta')}"`,
				`data_dir = "${join(dir, 'data')}"`,
				'db_engine = "sqlite"',
				'replication_factor = 3',
				`rpc_bind_addr = "127.0.0.1:${n.rpc}"`,
				`rpc_public_addr = "127.0.0.1:${n.rpc}"`,
				`rpc_secret = "${this.secret}"`,
				'[s3_api]',
				's3_region = "garage"',
				`api_bind_addr = "127.0.0.1:${n.s3}"`,
				'[admin]',
				`api_bind_addr = "127.0.0.1:${n.adminPort}"`,
				`admin_token = "${this.token}"`,
				'',
			].join('\n')
		);
		n.proc = spawn(this.bin, ['-c', join(dir, 'garage.toml'), 'server'], {
			stdio: ['ignore', 'ignore', 'pipe'],
			env: { ...process.env, RUST_LOG: 'garage=warn', NO_COLOR: '1' },
		});
		n.stderr = '';
		n.proc.stderr.on('data', (b) => (n.stderr = (n.stderr + b).slice(-4000)));
		this.nodes.set(name, n);
		const deadline = Date.now() + 30_000;
		for (;;) {
			try {
				await this.admin(name).call('GET', 'GetClusterHealth');
				break;
			} catch (e) {
				if (n.proc.exitCode !== null) assert.fail(`${name} exited: ${n.stderr}`);
				if (Date.now() > deadline) assert.fail(`${name}'s admin API never answered: ${e.message}`);
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		const info = await this.admin(name).call('GET', 'GetNodeInfo?node=self');
		n.id = Object.values(info.success)[0].nodeId;
		return n;
	}

	admin(name) {
		return httpAdmin({
			url: `http://127.0.0.1:${this.nodes.get(name).adminPort}`,
			token: this.token,
		});
	}

	/** What garage-apply needs, pointed at this cluster. */
	ctx() {
		return {
			admin: (name) => this.admin(name),
			rpcAddr: async (name) => `127.0.0.1:${this.nodes.get(name).rpc}`,
			log: () => {},
		};
	}

	/** probeZone's answer for each node: running, its id, one 1 TB disk. */
	zones(names) {
		return Object.fromEntries(
			names.map((name) => [
				name,
				{
					probe: 'ok',
					why: null,
					nodeId: this.nodes.get(name).id,
					disks: [{ serial: `SER-${name}`, sizeBytes: 1e12 }],
					root: null,
				},
			])
		);
	}

	kill() {
		for (const n of this.nodes.values()) if (n.proc.exitCode === null) n.proc.kill('SIGKILL');
	}
}

const zone = (name, capacityBytes = 500e9) => ({
	state: 'active',
	disks: [{ serial: `SER-${name}`, capacityBytes }],
});

describe('garage layout + buckets against a real v2.5.0 cluster', { timeout: 600_000 }, () => {
	let c;
	const declared = { version: 1, zones: {}, buckets: {}, overrides: [] };
	const plan = async (names) => {
		const zones = c.zones(names);
		const seen = await observeCluster(c.ctx(), zones);
		return {
			seen,
			zones,
			plan: planLayout({ declared, cluster: seen.cluster, state: seen.state, zones }),
		};
	};

	before(async () => {
		c = new Cluster(await garageBinary(), mkdtempSync(join(tmpdir(), 'fleet-garage-')));
		for (const n of ['claw-a', 'claw-b', 'claw-c', 'claw-d']) await c.add(n);
	});
	after(() => {
		c?.kill();
		if (c) rmSync(c.root, { recursive: true, force: true });
	});

	it('two declared zones are refused by the floor before anything is applied', async () => {
		declared.zones = { 'claw-a': zone('claw-a'), 'claw-b': zone('claw-b') };
		const { seen, plan: p } = await plan(['claw-a', 'claw-b']);
		// Nodes not yet in a layout: the admin API answers, with no roles.
		assert.equal(seen.cluster.layout.version, 0);
		assert.equal(p.checks.find((x) => x.rule === 'floor').status, 'refused');
		assert.equal(p.refused, true);
		assert.equal(p.layout, null);
	});

	it('three zones bootstrap the cluster: connected, layout v1, healthy; N+1 is a known state', async () => {
		declared.zones = {
			'claw-a': zone('claw-a'),
			'claw-b': zone('claw-b'),
			'claw-c': zone('claw-c'),
		};
		const { seen, zones, plan: p } = await plan(['claw-a', 'claw-b', 'claw-c']);
		assert.equal(p.refused, false, JSON.stringify(p.checks));
		assert.equal(p.checks.find((x) => x.rule === 'n-plus-1').status, 'known');
		assert.deepEqual(
			p.changes.map((x) => x.kind),
			['add', 'add', 'add']
		);
		assert.equal(p.layout.version, 1);
		const health = await applyLayout(c.ctx(), seen.via, p.layout, zones);
		assert.deepEqual(Object.keys(health).sort(), ['claw-a', 'claw-b', 'claw-c']);

		const state = garageState(await readCluster(c.admin('claw-b')));
		assert.equal(state.replicationFactor, 3);
		assert.deepEqual(state.nodes.map((n) => [n.node, n.zone, n.up, n.capacityBytes]).sort(), [
			['claw-a', 'claw-a', true, 500e9],
			['claw-b', 'claw-b', true, 500e9],
			['claw-c', 'claw-c', true, 500e9],
		]);
		// Re-planned from what the cluster now says: nothing left to do.
		const again = await plan(['claw-a', 'claw-b', 'claw-c']);
		assert.deepEqual(again.plan.changes, []);
		assert.equal(again.plan.layout, null);
	});

	it('a bucket gets its GLOBAL alias dp-<ns> and the tenant key read/write, once', async () => {
		declared.buckets = { photos: { key: 'dp-photos' } };
		const admin = c.admin('claw-a');
		const b1 = planBuckets({ declared, observed: await observeBuckets(admin, declared) });
		assert.deepEqual(
			b1.ops.map((o) => o.op),
			['create-bucket', 'create-key', 'grant']
		);
		await applyBuckets(c.ctx(), admin, b1.ops);

		// Read back through ANOTHER zone: the alias is global, not key-local.
		const info = await c.admin('claw-c').call('GET', 'GetBucketInfo?globalAlias=dp-photos');
		assert.deepEqual(info.globalAliases, ['dp-photos']);
		assert.equal(info.keys.length, 1);
		assert.equal(info.keys[0].name, 'dp-photos');
		assert.deepEqual(info.keys[0].permissions, { read: true, write: true, owner: false });

		const b2 = planBuckets({ declared, observed: await observeBuckets(admin, declared) });
		assert.deepEqual(b2.ops, []);
	});

	it('a fourth zone joins, and N+1 is then judged rather than known', async () => {
		declared.zones['claw-d'] = zone('claw-d');
		const names = ['claw-a', 'claw-b', 'claw-c', 'claw-d'];
		const { seen, zones, plan: p } = await plan(names);
		assert.deepEqual(p.changes, [{ node: 'claw-d', kind: 'add', from: null, to: 500e9 }]);
		assert.equal(p.checks.find((x) => x.rule === 'n-plus-1').status, 'ok');
		assert.equal(p.layout.version, 2);
		await applyLayout(c.ctx(), seen.via, p.layout, zones);
		const st = await c.admin('claw-a').call('GET', 'GetClusterLayout');
		assert.equal(st.version, 2);
		assert.equal(st.roles.length, 4);
	});

	it('a change while an older layout version still drains waits; then drain takes the role out', async () => {
		declared.zones['claw-d'] = { ...declared.zones['claw-d'], state: 'drain' };
		const names = ['claw-a', 'claw-b', 'claw-c', 'claw-d'];
		// v1 drains until every zone has synced v2; until then the plan waits, one change at a time.
		let next = await plan(names);
		const until = Date.now() + 120_000;
		while (next.plan.waiting.length) {
			assert.equal(next.plan.layout, null);
			assert.ok(Date.now() < until, `still draining: ${JSON.stringify(next.plan.waiting)}`);
			await new Promise((r) => setTimeout(r, 500));
			next = await plan(names);
		}
		const { seen, zones, plan: p } = next;
		assert.deepEqual(p.changes, [{ node: 'claw-d', kind: 'remove', from: 500e9, to: null }]);
		assert.equal(p.refused, false, JSON.stringify({ checks: p.checks, waiting: p.waiting }));
		assert.equal(p.checks.find((x) => x.rule === 'floor').status, 'ok');
		await applyLayout(c.ctx(), seen.via, p.layout, zones);
		const layout = await c.admin('claw-a').call('GET', 'GetClusterLayout');
		assert.deepEqual(layout.roles.map((r) => r.zone).sort(), ['claw-a', 'claw-b', 'claw-c']);

		declared.zones['claw-c'] = { ...declared.zones['claw-c'], state: 'drain' };
		const after2 = await plan(names);
		const floor = after2.plan.checks.find((x) => x.rule === 'floor');
		assert.equal(floor.status, 'refused', floor.why);
		assert.equal(after2.plan.refused, true);
		assert.equal(after2.plan.layout, null);
	});
});
