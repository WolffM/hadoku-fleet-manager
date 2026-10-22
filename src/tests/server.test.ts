import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Router } from 'express';

import { createFleetServer } from '../server.js';
import { __resetLeasesForTesting } from '../host-lease.js';
import type { FleetManager } from '../index.js';

const router = Router();
router.get('/fleet', (_req, res) => res.json({ success: true, stub: 'fleet' }));
const manager = {
	router,
	start: () => {},
	snapshot: () => ({ stub: 'snapshot' }),
} as unknown as FleetManager;

const server = createFleetServer(manager, { version: '9.9.9' }).listen(0, '127.0.0.1');
before(
	() => new Promise<void>((res) => (server.listening ? res() : server.once('listening', res)))
);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());
beforeEach(() => __resetLeasesForTesting());

const post = (path: string, body: unknown) =>
	fetch(`${base()}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

test('/health names the service and its version', async () => {
	const j = (await (await fetch(`${base()}/health`)).json()) as Record<string, unknown>;
	assert.equal(j.ok, true);
	assert.equal(j.version, '9.9.9');
});

test('the fleet report and the runner-health snapshot are served', async () => {
	assert.equal(
		((await (await fetch(`${base()}/api/fleet`)).json()) as { stub: string }).stub,
		'fleet'
	);
	const snap = (await (await fetch(`${base()}/api/runner-health`)).json()) as {
		snapshot: { stub: string };
	};
	assert.equal(snap.snapshot.stub, 'snapshot');
});

test('a lease is taken, listed and released over HTTP', async () => {
	const r = await post('/api/host-lease', { holder: 'local-daily', ttlSeconds: 600 });
	assert.equal(r.status, 201);
	const { lease } = (await r.json()) as { lease: { id: string; holder: string } };
	const listed = (await (await fetch(`${base()}/api/host-lease`)).json()) as {
		leases: { id: string }[];
	};
	assert.deepEqual(
		listed.leases.map((l) => l.id),
		[lease.id]
	);
	const del = (await (
		await fetch(`${base()}/api/host-lease/${lease.id}`, { method: 'DELETE' })
	).json()) as { released: boolean };
	assert.equal(del.released, true);
});

test('a lease without a holder or a positive ttl is refused, not guessed', async () => {
	assert.equal((await post('/api/host-lease', { ttlSeconds: 60 })).status, 400);
	assert.equal((await post('/api/host-lease', { holder: 'x' })).status, 400);
	assert.equal((await post('/api/host-lease', { holder: 'x', ttlSeconds: 0 })).status, 400);
});
