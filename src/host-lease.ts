/**
 * host-lease — "the host is busy with X until T", said by whoever is using it.
 *
 * The production host runs the operator's own scheduled work, which GitHub
 * cannot see, and CI must yield to it. Something has to tell the fleet when
 * that work is running. It used to be two things fleet-manager worked out for
 * itself from the host's internals: an in-process counter mgmt-api bumped, and a
 * 90-minute window computed from the host's cron `profiles.json`. The first only
 * works in-process; the second is this package reading another system's
 * schedule and guessing how long it runs.
 *
 * A lease inverts that. The host's scheduler takes one when it starts work and
 * releases it when it is done — per job, and per chain so the gaps between jobs
 * are covered too — and the fleet decides what a held host means for routing.
 * The fleet knows nothing about the schedule; the scheduler knows nothing about
 * runners.
 *
 * EVERY LEASE EXPIRES. A holder that crashes mid-job never releases, and a lease
 * without a deadline would keep the host off CI forever. The ttl is the holder's
 * own statement of how long it could possibly need, capped at MAX_LEASE_SECONDS;
 * an expired lease is dropped on the next read.
 *
 * In-memory on purpose: a restarted fleet-manager holds no leases, which fails
 * OPEN — at worst CI shares the host with a job until that job's scheduler takes
 * its next lease.
 *
 * THE LEDGER ITSELF LIVES IN `host-lease-record.ts` (wave layers-3 lane S, cut
 * (iii)): this file stays the `tenancy`-domain surface plan §3.5 names
 * explicitly, and re-exports every name below unchanged so `server.ts`'s
 * `/api/host-lease` routes compile exactly as before.
 */

export {
	type HostLease,
	MAX_LEASE_SECONDS,
	takeLease,
	releaseLease,
	activeLeases,
	__resetLeasesForTesting,
} from './host-lease-record.js';
