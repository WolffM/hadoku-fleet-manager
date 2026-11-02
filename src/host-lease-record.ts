/**
 * host-lease-record — the in-memory lease ledger itself, split out of
 * `host-lease.ts` (wave layers-3 lane S, cut (iii)).
 *
 * `host-lease.ts` is kept `tenancy` on purpose (plan §3.5 names it there
 * explicitly, despite its state-record shape — see `layer-map.json`'s `why`
 * on that entry). But `node-reservation.ts` (`ci-scheduling`) needs to READ
 * the live lease list, and a domain reading another domain's facts through
 * the OTHER domain's own module, rather than through a state record, is
 * exactly the rule-5 violation plan §3.2 describes. So the ledger — "one
 * declared writer (the host's scheduler, via `takeLease`/`releaseLease`),
 * read back by something else" — moves to its own `state`-layer module,
 * and `host-lease.ts` re-exports every name here under its original path so
 * its own callers (`server.ts`'s `/api/host-lease` routes) are untouched.
 * `node-reservation.ts` imports `activeLeases` from here directly.
 *
 * A pure move: every name, every body, byte-identical to what `host-lease.ts`
 * held before this split.
 */

import { randomUUID } from 'node:crypto';

export interface HostLease {
	id: string;
	/** Who holds it, for the Fleet panel and the log: a job or chain name. */
	holder: string;
	/** Epoch ms. */
	until: number;
}

/** The longest any single lease may run. Longer work renews. */
export const MAX_LEASE_SECONDS = 6 * 3600;

const leases = new Map<string, HostLease>();

export function takeLease(holder: string, ttlSeconds: number, now = Date.now()): HostLease {
	const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), MAX_LEASE_SECONDS);
	const lease = { id: randomUUID(), holder, until: now + ttl * 1000 };
	leases.set(lease.id, lease);
	return lease;
}

/** Release by id. `false` means it was already gone (released or expired). */
export function releaseLease(id: string): boolean {
	return leases.delete(id);
}

/** Live leases, oldest deadline first. Expired ones are dropped as a side effect. */
export function activeLeases(now = Date.now()): HostLease[] {
	for (const [id, l] of leases) if (l.until <= now) leases.delete(id);
	return [...leases.values()].sort((a, b) => a.until - b.until);
}

export function __resetLeasesForTesting(): void {
	leases.clear();
}
