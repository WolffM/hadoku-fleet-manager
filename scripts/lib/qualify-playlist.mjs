/**
 * `fleet qualify`'s PLAYLIST: every qualification test, in the order a window
 * runs them (wave bootcamp2). Its own module because each test imports the
 * bars from qualify-registry.mjs; the registry importing the tests back would
 * be a cycle that reads QUALIFY_BARS before it is initialised.
 *
 * ORDER MATTERS, idle facts first, load last:
 *   1. busy-counters: who can see a job, on the quiet node the drain made.
 *   2. network-soak: passive, before anything loads the box.
 *   3. tmpfs-headroom, then disk-sync-writes: memory, then the disk, before
 *      the ramp fills the page cache and heats the package.
 *   4. concurrency-ramp: the long one.
 * The budgets are ceilings, not durations. The runner starts a test only if
 * the time actually used plus that test's budget fits the window, so a long
 * ramp leaves a later test reported as could-not-look, with the reason.
 */
import { test as busyCounters } from './qualify-observers.mjs';
import { test as networkSoak } from './qualify-network.mjs';
import { test as tmpfsHeadroom } from './qualify-memory.mjs';
import { test as diskSyncWrites } from './qualify-io.mjs';
import { test as concurrencyRamp } from './qualify-concurrency.mjs';

export const QUALIFY_TESTS = Object.freeze([
	busyCounters,
	networkSoak,
	tmpfsHeadroom,
	diskSyncWrites,
	concurrencyRamp,
]);
