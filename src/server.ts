/**
 * fleet-manager's own HTTP surface, for running as a standalone service.
 *
 * LOOPBACK ONLY, and that is the auth model. `serve.ts` binds 127.0.0.1, so the
 * only callers are processes on the host: mgmt-api (which proxies `GET /api/fleet`
 * for the command station and reads the snapshot for its sitrep) and the host's
 * scheduler (which takes host leases). Nothing here is reachable from the edge,
 * so no route re-implements an auth check that the socket already makes.
 */
import express, { type Express, type Request, type Response } from 'express';

import type { FleetManager } from './index.js';
import { MAX_LEASE_SECONDS, activeLeases, releaseLease, takeLease } from './host-lease.js';

export function createFleetServer(manager: FleetManager, meta: { version: string }): Express {
	const app = express();
	app.use(express.json());
	const startedAt = new Date().toISOString();

	app.get('/health', (_req: Request, res: Response) => {
		res.json({ ok: true, service: 'fleet-manager', version: meta.version, startedAt });
	});

	// GET /api/fleet, /api/fleet/ci-state, POST /api/fleet/job-history/backfill.
	app.use('/api', manager.router);

	app.get('/api/runner-health', (_req: Request, res: Response) => {
		res.json({ success: true, snapshot: manager.snapshot() });
	});

	app.get('/api/host-lease', (_req: Request, res: Response) => {
		res.json({ success: true, leases: activeLeases() });
	});

	app.post('/api/host-lease', (req: Request, res: Response) => {
		const { holder, ttlSeconds } = (req.body ?? {}) as { holder?: unknown; ttlSeconds?: unknown };
		if (typeof holder !== 'string' || !holder.trim()) {
			res.status(400).json({ success: false, error: 'holder (a job or chain name) is required' });
			return;
		}
		if (typeof ttlSeconds !== 'number' || !(ttlSeconds > 0)) {
			res.status(400).json({
				success: false,
				error: `ttlSeconds must be a positive number (capped at ${MAX_LEASE_SECONDS})`,
			});
			return;
		}
		const lease = takeLease(holder.trim(), ttlSeconds);
		res.status(201).json({ success: true, lease });
	});

	app.delete('/api/host-lease/:id', (req: Request, res: Response) => {
		// `released: false` is not an error: the lease expired first, which is the
		// state being asked for.
		res.json({ success: true, released: releaseLease(String(req.params.id)) });
	});

	return app;
}
