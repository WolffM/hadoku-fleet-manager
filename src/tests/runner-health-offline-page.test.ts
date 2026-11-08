/**
 * Tests for `runner-health-label-floor-nodes.ts`'s LOUD per-node offline
 * page (wave gates1 lane A2) — a second, independent mechanism beside the
 * quiet ladder `runner-health-outage.test.ts` already covers. See that
 * module's own header for why this exists: `scripts/lib/known-down.mjs`
 * needs a genuine page to skip a gate on, and the quiet ledger row is not
 * one.
 *
 * These call `runOfflineNodeAlerts` DIRECTLY rather than through `tick()` —
 * the function's own inputs (a runner listing, the fleet's node names, the
 * ephemeral set, claw state, `floorAlreadyBreached`, the online-names string)
 * are exactly what a hand-rolled fixture needs, and going through `tick()`
 * would mean faking a whole GitHub Actions runner listing to exercise one
 * node. The webhook/fetch plumbing still comes from the shared rig, since
 * the loud page is a REAL post through the host's `alerts.post`.
 *
 * `lastPage` IS WRITTEN ONLY AFTER THE POST CONFIRMS (manager review fix
 * #1) — `postDiscord` is fire-and-forget from `runOfflineNodeAlerts`'s own
 * synchronous call, so every test here awaits `call()`'s own flush (a
 * macrotask, draining every pending microtask) before reading `discordPosts`
 * or the on-disk record for anything the `.then` callback writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../host.js';
import { writeDrain } from '../runners/drain.js';
import {
	runOfflineNodeAlerts,
	OFFLINE_PAGE_MS,
	OFFLINE_REPAGE_MS,
	__reloadDownPageForTesting,
} from '../runner-health-label-floor-nodes.js';
import { installRunnerHealthRig, installFetch, discordPosts } from './helpers/runner-health-rig.js';
import type { GhRunner } from '../lib/github-client.js';

installRunnerHealthRig();

const NODE = 'claw-down-page';
const FLEET_NODES = [NODE];
const NO_EPHEMERAL = new Set<string>();

const DOWN_PAGE_PATH = (): string => join(stateDir(), 'runner-down-page.json');

/** `claw-down-page`, offline (one runner instance, one registration). */
const offlineListing: readonly GhRunner[] = [{ id: 1, name: NODE, status: 'offline', busy: false }];
/** Same node, back online. */
const onlineListing: readonly GhRunner[] = [{ id: 1, name: NODE, status: 'online', busy: false }];

/** Seed `runner-down-page.json` directly, then force the module to reload it
 *  — simulating a fresh process reading what a PREVIOUS one persisted. */
function seedSince(sinceAgoMs: number, lastPageAgoMs?: number): void {
	const rec: { since: string; lastPage?: string } = {
		since: new Date(Date.now() - sinceAgoMs).toISOString(),
	};
	if (lastPageAgoMs !== undefined)
		rec.lastPage = new Date(Date.now() - lastPageAgoMs).toISOString();
	writeFileSync(DOWN_PAGE_PATH(), JSON.stringify({ [NODE]: rec }));
	__reloadDownPageForTesting();
}

function onDiskRecord(): { since: string; lastPage?: string } | undefined {
	try {
		const raw = JSON.parse(readFileSync(DOWN_PAGE_PATH(), 'utf8')) as Record<
			string,
			{ since: string; lastPage?: string }
		>;
		return raw[NODE];
	} catch {
		return undefined;
	}
}

const loudPages = (): string[] => discordPosts.filter((m) => m.includes('@here'));
/** The OBSERVED-ONLINE recovery message — must never fire for a node that merely vanished. */
const onlineRecoveries = (): string[] => discordPosts.filter((m) => m.startsWith('✅'));
/** The VANISHED-from-tracking neutral message — must never claim "back online". */
const vanishedClears = (): string[] =>
	discordPosts.filter((m) => m.includes('cleared, not resolved'));

/** Drains every pending microtask (and any macrotask queued ahead of it), so
 *  the `.then` callback that writes `lastPage` on a confirmed post has had
 *  the chance to run before the test reads anything it writes. */
async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function call(runners: readonly GhRunner[], floorAlreadyBreached = false): Promise<void> {
	installFetch({});
	runOfflineNodeAlerts(runners, FLEET_NODES, NO_EPHEMERAL, {}, floorAlreadyBreached, 'other-node');
	await flush();
}

test('the loud page does NOT fire a moment before OFFLINE_PAGE_MS', async () => {
	seedSince(OFFLINE_PAGE_MS - 1000);
	await call(offlineListing);
	assert.deepEqual(loudPages(), []);
	// Still tracked, still unpaged: `since` kept, no `lastPage` written.
	assert.equal(onDiskRecord()?.lastPage, undefined);
});

test('the loud page fires once a node has been offline OFFLINE_PAGE_MS straight, with @here', async () => {
	seedSince(OFFLINE_PAGE_MS + 1000);
	await call(offlineListing);
	const pages = loudPages();
	assert.equal(pages.length, 1, pages.join(' | '));
	assert.match(pages[0]!, /@here/);
	assert.match(pages[0]!, new RegExp('`' + NODE + '`'));
	assert.match(pages[0]!, /OFFLINE for 2h/);
	// The page is now recorded on disk — this is what known-down.mjs reads.
	assert.ok(onDiskRecord()?.lastPage, 'lastPage must be written once the CONFIRMED post lands');
});

test('`since` survives a restart: a record seeded on disk (not accumulated by this process) still pages', async () => {
	// This process never saw the node go down — the record was entirely
	// written by seedSince()/writeFileSync and only RELOADED, exactly what
	// `__reloadDownPageForTesting` exists to simulate (a fresh mgmt-api
	// process reading what the last one persisted).
	seedSince(3 * 60 * 60 * 1000);
	await call(offlineListing);
	assert.equal(loudPages().length, 1, 'a restart must not reset the 2h clock to zero');
});

test('`since` is NOT overwritten on a later tick — it stays the FIRST offline moment', async () => {
	seedSince(OFFLINE_PAGE_MS + 1000);
	const before = onDiskRecord()?.since;
	await call(offlineListing);
	await call(offlineListing);
	const after = onDiskRecord()?.since;
	assert.equal(after, before, '`since` must be the first-offline tick, not the most recent one');
});

test('the loud page does not re-fire inside OFFLINE_REPAGE_MS, but does once it has passed', async () => {
	seedSince(3 * 60 * 60 * 1000, OFFLINE_REPAGE_MS - 1000);
	await call(offlineListing);
	assert.deepEqual(loudPages(), [], 'still inside the 24h repage window');

	seedSince(3 * 60 * 60 * 1000, OFFLINE_REPAGE_MS + 1000);
	await call(offlineListing);
	assert.equal(loudPages().length, 1, 'past the repage window, it fires again');
});

test('a DRAINED node (maintenance) past 2h does not page', async () => {
	writeDrain({
		[NODE]: { since: new Date().toISOString(), reason: 'test maintenance', by: 'test' },
	});
	seedSince(OFFLINE_PAGE_MS + 1000);
	await call(offlineListing);
	assert.deepEqual(loudPages(), [], 'a drained node already has hands on it');
});

test('a node mid-REBOOT WINDOW (drain kind "reboot") past 2h does not page', async () => {
	writeDrain({
		[NODE]: {
			since: new Date().toISOString(),
			reason: 'reboot cycle',
			by: 'fleet:reboot-claws',
			kind: 'reboot',
			until: new Date(Date.now() + 60 * 60_000).toISOString(),
		},
	});
	seedSince(OFFLINE_PAGE_MS + 1000);
	await call(offlineListing);
	assert.deepEqual(loudPages(), [], 'an in-progress reboot already has hands on it');
});

test('an UNREADABLE drain record pages rather than staying silent', async () => {
	// AGENTS.md: "I could not look" must never render as "nothing is wrong".
	// Corrupting the drain file simulates the one way readDrain() throws.
	writeFileSync(join(stateDir(), 'fleet-drain.json'), '{ not valid json');
	seedSince(OFFLINE_PAGE_MS + 1000);
	await call(offlineListing);
	assert.equal(loudPages().length, 1, 'an unreadable drain record must not suppress the page');
});

test('floorAlreadyBreached does NOT suppress the loud page', async () => {
	seedSince(OFFLINE_PAGE_MS + 1000);
	await call(offlineListing, /* floorAlreadyBreached */ true);
	assert.equal(
		loudPages().length,
		1,
		'the capacity-breach suppression must not silence which node is down'
	);
});

test('a recovery, OBSERVED ONLINE, after the loud page fired, posts ONE "back online" message and clears the record', async () => {
	seedSince(OFFLINE_PAGE_MS + 1000);
	await call(offlineListing);
	assert.equal(loudPages().length, 1);

	await call(onlineListing);
	const r = onlineRecoveries();
	assert.equal(r.length, 1, r.join(' | '));
	assert.match(r[0]!, new RegExp('`' + NODE + '`'));
	assert.match(r[0]!, /back online/);
	assert.deepEqual(vanishedClears(), [], 'an OBSERVED recovery is never the vanished message');
	assert.equal(onDiskRecord(), undefined, 'the record is cleared once the node is back');
});

test('a node that recovers BEFORE it was ever paged recovers silently', async () => {
	seedSince(OFFLINE_PAGE_MS - 1000); // not yet 2h, never paged
	await call(offlineListing);
	assert.deepEqual(loudPages(), []);

	await call(onlineListing);
	assert.deepEqual(onlineRecoveries(), [], 'nothing was ever paged, so nothing needs to recover');
	assert.equal(onDiskRecord(), undefined);
});

// ── manager fix #2: vanished tracking is NOT an observed recovery ──────────

test('a node that VANISHES from the listing after the loud page fired gets the NEUTRAL clear line, never "back online"', async () => {
	seedSince(OFFLINE_PAGE_MS + 1000);
	await call(offlineListing);
	assert.equal(loudPages().length, 1);

	// Gone from the listing altogether — not "online", just absent.
	installFetch({});
	runOfflineNodeAlerts([], [], NO_EPHEMERAL, {}, false, 'other-node');
	await flush();

	assert.equal(vanishedClears().length, 1, 'the vanished path must say "cleared, not resolved"');
	assert.deepEqual(onlineRecoveries(), [], 'absence was never observed as "back online"');
	assert.equal(onDiskRecord(), undefined);
});

test('a node that vanishes BEFORE it was ever paged clears with no message at all', async () => {
	seedSince(OFFLINE_PAGE_MS - 1000); // not yet 2h, never paged
	await call(offlineListing);
	assert.deepEqual(loudPages(), []);

	installFetch({});
	runOfflineNodeAlerts([], [], NO_EPHEMERAL, {}, false, 'other-node');
	await flush();

	assert.deepEqual(vanishedClears(), [], 'nothing was ever paged, so nothing needs announcing');
	assert.deepEqual(onlineRecoveries(), []);
	assert.equal(onDiskRecord(), undefined);
});

// ── manager fix #1: a FAILED post must not count as paged ──────────────────

test('a post that resolves {posted:false} (no webhook configured) leaves no lastPage', async () => {
	seedSince(OFFLINE_PAGE_MS + 1000);
	delete process.env.DISCORD_EMERGENCY_NOTIFICATIONS_WEBHOOK;
	await call(offlineListing);
	assert.equal(
		onDiskRecord()?.lastPage,
		undefined,
		'an undelivered post must not be recorded as paged'
	);
	assert.deepEqual(loudPages(), [], 'nothing was actually sent to Discord');
});

test('a post that REJECTS leaves no lastPage', async () => {
	seedSince(OFFLINE_PAGE_MS + 1000);
	installFetch({});
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new Error('network down');
	}) as typeof fetch;
	try {
		runOfflineNodeAlerts(offlineListing, FLEET_NODES, NO_EPHEMERAL, {}, false, 'other-node');
		await flush();
	} finally {
		globalThis.fetch = realFetch;
	}
	assert.equal(
		onDiskRecord()?.lastPage,
		undefined,
		'a rejected post must not be recorded as paged'
	);
});

test('a post that CONFIRMS (posted: true) is the only case that records lastPage', async () => {
	seedSince(OFFLINE_PAGE_MS + 1000);
	await call(offlineListing);
	assert.equal(loudPages().length, 1);
	assert.ok(onDiskRecord()?.lastPage, 'a confirmed delivery is recorded');
});

test('a post still in flight stops the SAME node from sending a second one before it settles', async () => {
	seedSince(OFFLINE_PAGE_MS + 1000);
	installFetch({});
	const realFetch = globalThis.fetch;
	let resolveFetch: (() => void) | undefined;
	globalThis.fetch = ((input: string | URL, init?: RequestInit) =>
		new Promise((resolve) => {
			resolveFetch = () => resolve(realFetch(input, init));
		})) as typeof fetch;
	try {
		// Two ticks, synchronously, before the first post has resolved at all.
		runOfflineNodeAlerts(offlineListing, FLEET_NODES, NO_EPHEMERAL, {}, false, 'other-node');
		runOfflineNodeAlerts(offlineListing, FLEET_NODES, NO_EPHEMERAL, {}, false, 'other-node');
		assert.ok(resolveFetch, 'the first post must have reached fetch');
		resolveFetch!();
		await flush();
	} finally {
		globalThis.fetch = realFetch;
	}
	assert.equal(loudPages().length, 1, 'only one post was ever sent while the first was pending');
	assert.ok(onDiskRecord()?.lastPage, 'the confirmed post is still recorded once it resolves');
});
