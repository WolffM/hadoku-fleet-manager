import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	GarageAdminError,
	garageState,
	nodeAdmin,
	nodeAdminScript,
	readPool,
} from './garage-admin.mjs';
import { CLAW9 } from './storage-fixtures.mjs';
import { ROOT_DF, detectState, probeZone, secretsScript } from './garage-apply.mjs';

/**
 * Captured from a real 3-zone v2.5.0 cluster on 2026-11-23 (dataplatform's
 * harness; one 300,000-byte object), cut to the fields garageState reads.
 */
const ID = { a: '5cf2d496', b: '9d89b711', c: 'b4bf30ad' };
const CAPTURED = {
	status: {
		layoutVersion: 1,
		nodes: [
			{
				id: ID.a,
				isUp: true,
				role: { zone: 'claw-a', tags: ['claw-a'], capacity: 1e9 },
				draining: false,
			},
			{
				id: ID.b,
				isUp: true,
				role: { zone: 'claw-b', tags: ['claw-b'], capacity: 1e9 },
				draining: false,
			},
			{
				id: ID.c,
				isUp: true,
				role: { zone: 'claw-c', tags: ['claw-c'], capacity: 1e9 },
				resyncQueueLen: 0,
			},
		],
	},
	health: {
		status: 'healthy',
		storageNodes: 3,
		storageNodesUp: 3,
		partitions: 256,
		partitionsQuorum: 256,
		partitionsAllOk: 256,
	},
	layout: {
		version: 1,
		roles: Object.entries(ID).map(([n, id]) => ({
			id,
			zone: `claw-${n}`,
			tags: [`claw-${n}`],
			capacity: 1e9,
			storedPartitions: 256,
			usableCapacity: 1e9,
		})),
	},
	statistics: { bucketCount: 1, totalObjectCount: 1, totalObjectBytes: 300000 },
	nodeStats: {
		success: Object.fromEntries(
			Object.values(ID).map((id) => [
				id,
				{ blockManagerStats: { rcEntries: 2, resyncQueueLen: 0, resyncErrors: 0 } },
			])
		),
		error: {},
	},
};

describe('garageState: a cluster as the doctor reads it', () => {
	it('three zones, three copies, every node holding the whole of the bytes', () => {
		const s = garageState(CAPTURED, 'T');
		assert.deepEqual(s, {
			replicationFactor: 3,
			nodes: ['a', 'b', 'c'].map((n) => ({
				node: `claw-${n}`,
				zone: `claw-${n}`,
				up: true,
				capacityBytes: 1e9,
				usedBytes: 300000,
			})),
			underReplicatedBlocks: 0,
			at: 'T',
		});
	});
	it('a node that did not answer its statistics makes the copy count unread, not zero', () => {
		const c = structuredClone(CAPTURED);
		c.nodeStats.error = { [ID.b]: 'timeout' };
		delete c.nodeStats.success[ID.b];
		assert.equal(garageState(c).underReplicatedBlocks, null);
		const d = structuredClone(CAPTURED);
		d.nodeStats = null;
		assert.equal(garageState(d).underReplicatedBlocks, null);
	});
	it('queued and errored blocks count; a down node is down', () => {
		const c = structuredClone(CAPTURED);
		c.nodeStats.success[ID.a].blockManagerStats = { resyncQueueLen: 4, resyncErrors: 1 };
		c.status.nodes[1].isUp = false;
		const s = garageState(c);
		assert.equal(s.underReplicatedBlocks, 5);
		assert.deepEqual(
			s.nodes.map((n) => n.up),
			[true, false, true]
		);
	});
	it('no statistics: used bytes are null, never 0', () => {
		const c = structuredClone(CAPTURED);
		c.statistics = null;
		assert.ok(garageState(c).nodes.every((n) => n.usedBytes === null));
	});
});

describe('nodeAdmin: curl on the node, the token never in an argv', () => {
	it('reads the token as root and hands it to curl on a pipe', () => {
		const s = nodeAdminScript('POST', 'CreateBucket', { globalAlias: 'dp-x' });
		assert.match(s, /tok="\$\(sudo -n cat \/etc\/garage\/secrets\/GARAGE_ADMIN_TOKEN\)"/);
		assert.match(s, /printf 'Authorization: Bearer %s\\n' "\$tok" \| curl .* -H @- /);
		assert.match(s, /'http:\/\/127\.0\.0\.1:3903\/v2\/CreateBucket'/);
		assert.match(s, /\{"globalAlias":"dp-x"\}/);
		// The token goes in through the builtin, and nowhere else.
		assert.equal(s.match(/\$tok/g).length, 1);
	});
	it('parses the body and the status; a Garage error keeps its code', async () => {
		const ok = nodeAdmin('claw-x', async () => ({
			ok: true,
			stdout: '{"status":"healthy"}\n200\n',
		}));
		assert.deepEqual(await ok.call('GET', 'GetClusterHealth'), { status: 'healthy' });
		const missing = nodeAdmin('claw-x', async () => ({
			ok: true,
			stdout: '{"code":"NoSuchBucket","message":"Bucket not found: dp-x"}\n404\n',
		}));
		await assert.rejects(missing.call('GET', 'GetBucketInfo?globalAlias=dp-x'), (e) => {
			assert.ok(e instanceof GarageAdminError);
			assert.equal(e.status, 404);
			assert.equal(e.code, 'NoSuchBucket');
			return true;
		});
	});
	it('a call that never ran says why', async () => {
		const dead = nodeAdmin('claw-x', async () => ({
			ok: false,
			stdout: '',
			error: 'ssh: connect timed out',
		}));
		await assert.rejects(
			dead.call('GET', 'GetClusterHealth'),
			/did not run: ssh: connect timed out/
		);
		const noCurl = nodeAdmin('claw-x', async () => ({ ok: true, stdout: '000\n' }));
		await assert.rejects(noCurl.call('GET', 'GetClusterHealth'), /did not run/);
	});
});

describe('readPool: the doctor’s pool input', () => {
	it('no member: unread with a reason', async () => {
		assert.deepEqual(await readPool([], () => async () => ({})), {
			garage: null,
			why: 'no member to read',
			via: null,
		});
	});
	it('every member refused: the reason names each', async () => {
		const r = await readPool(['claw-a', 'claw-b'], (node) => async () => ({
			ok: false,
			stdout: '',
			error: `${node} down`,
		}));
		assert.equal(r.garage, null);
		assert.match(r.why, /claw-a: .*claw-a down.*; claw-b: .*claw-b down/);
	});
});

describe('the zone probe', () => {
	it('reads GARAGE_DETECT: OK, nothing, missing secrets, stopped', () => {
		assert.equal(detectState('OK\n').probe, 'ok');
		assert.deepEqual(detectState(''), { probe: 'absent', why: 'Garage is not installed' });
		assert.equal(
			detectState(
				'WHY garage is installed but not running: vault item(s) GARAGE_RPC_SECRET absent from /etc/garage/secrets'
			).probe,
			'no-secrets'
		);
		assert.deepEqual(detectState('WHY garage.service is not active'), {
			probe: 'stopped',
			why: 'garage.service is not active',
		});
	});
	it("a real node's disks by serial, and its root filesystem", async () => {
		const exec = async (node, script) => {
			if (script.includes('QUALIFY_DISK_PROBE')) return { ok: true, stdout: CLAW9 };
			if (script === ROOT_DF) return { ok: true, stdout: ' 240000000000 61000000000\n' };
			return { ok: true, stdout: '' }; // GARAGE_DETECT: not installed
		};
		const z = await probeZone(
			{ exec, admin: () => assert.fail('no admin call when Garage is absent') },
			'claw-9'
		);
		assert.equal(z.probe, 'absent');
		assert.deepEqual(z.disks, [
			{ serial: 'SERIAL-claw-9-sda', sizeBytes: 240057409536 },
			{ serial: 'SERIAL-claw-9-sdb', sizeBytes: 1000204886016 },
		]);
		assert.deepEqual(z.root, { sizeBytes: 240e9, usedBytes: 61e9 });
	});
	it('an unreachable node is unreachable, with the reason', async () => {
		const z = await probeZone(
			{ exec: async () => ({ ok: false, error: 'ssh: no route' }) },
			'claw-9'
		);
		assert.equal(z.probe, 'unreachable');
		assert.match(z.why, /no route/);
	});
});

describe('the secrets bring-up', () => {
	it('writes both items root-only from heredocs, and refuses without them', () => {
		const s = secretsScript({
			GARAGE_RPC_SECRET: 'r'.repeat(64),
			GARAGE_ADMIN_TOKEN: 't'.repeat(32),
		});
		assert.match(s, /install -d -m 0711 \/etc\/garage\/secrets/);
		assert.match(s, /umask 077; cat > \/etc\/garage\/secrets\/GARAGE_RPC_SECRET\.new/);
		assert.match(s, /<<'GARAGE_ADMIN_TOKEN_EOF'\nt{32}\nGARAGE_ADMIN_TOKEN_EOF/);
		assert.throws(
			() => secretsScript({ GARAGE_RPC_SECRET: 'x' }),
			/GARAGE_ADMIN_TOKEN is not in this process's environment/
		);
	});
});
