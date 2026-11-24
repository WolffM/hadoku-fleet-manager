/**
 * `fleet qualify`'s PLAYLIST: every qualification test, in the order a window
 * runs them (wave bootcamp2). Its own module because each test imports the
 * bars from qualify-registry.mjs; the registry importing the tests back would
 * be a cycle that reads QUALIFY_BARS before it is initialised.
 *
 * ORDER MATTERS, idle facts first, load last:
 *   1. busy-counters: who can see a job, on the quiet node the drain made;
 *      then floor-ci and floor-admin, the provisioning floor EXECUTED.
 *   2. network-soak: passive, before anything loads the box.
 *   3. tmpfs-headroom, then disk-sync-writes: memory, then the disk, before
 *      the ramp fills the page cache and heats the package.
 *   4. concurrency-ramp: the long one.
 *   5. reboot-requalify: LAST, because it reboots. It refuses a node that
 *      hosts pm2 service tenants (the reboot cycle owns those).
 * The budgets are ceilings, not durations. The runner starts a test only if
 * the time actually used plus that test's budget fits the window, so a long
 * ramp leaves a later test reported as could-not-look, with the reason.
 */
import { test as busyCounters } from './qualify-observers.mjs';
import { tests as floorTests } from './qualify-floor.mjs';
import { test as networkSoak } from './qualify-network.mjs';
import { test as tmpfsHeadroom } from './qualify-memory.mjs';
import { test as diskSyncWrites } from './qualify-io.mjs';
import { test as concurrencyRamp } from './qualify-concurrency.mjs';
import { test as rebootRequalify } from './qualify-reboot.mjs';
import { test as diskSmr } from './qualify-disk-smr.mjs';
import { test as diskSmart } from './qualify-disk-smart.mjs';
import { makeLinkTest } from './qualify-disk-link.mjs';

export const QUALIFY_TESTS = Object.freeze([
	busyCounters,
	...floorTests,
	networkSoak,
	tmpfsHeadroom,
	diskSyncWrites,
	concurrencyRamp,
	rebootRequalify,
]);

/**
 * `fleet qualify --disks`: the read-only disk checks of the storage bootcamp
 * (F2, #137), SMR, SMART, then the kernel log's link check (#156) LAST, so it
 * sees any reset the SMART read itself caused. `rejected` is the persisted
 * rejection record (lib/disk-rejections.mjs). NOT in QUALIFY_TESTS:
 * a node with no spare disk would fail them forever and `--next` would read
 * it as due every night. They drain nothing (needsDrain false). The burn-in
 * writes to a disk and runs only by serial: `--burn-in <serial> --confirm`
 * (qualify-disk-burnin.mjs).
 */
export const diskTests = ({ rejected = {} } = {}) => [
	diskSmr,
	diskSmart,
	makeLinkTest({ rejected }),
];
