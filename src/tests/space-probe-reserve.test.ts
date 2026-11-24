/**
 * The `_work` line of the space probe reserves a root-disk storage zone's quota
 * (fleet-manager#141), run as the real shell against real `df`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseSpaceProbe, spaceProbeCmd } from '../runners/ephemeral-shared.js';

/** Run the probe with HOME and the zone dir under one temp dir (one filesystem), or the zone on /dev/shm. */
function probe(reserve: string | null, zoneElsewhere = false): number | null {
	const home = mkdtempSync(join(tmpdir(), 'space-probe-'));
	// /dev/shm is its own mount: a reserve there is on another filesystem.
	const zone = zoneElsewhere
		? mkdtempSync(join('/dev/shm', 'space-probe-zone-'))
		: join(home, 'storage-root');
	try {
		if (!zoneElsewhere) mkdirSync(zone);
		if (reserve !== null) writeFileSync(join(zone, 'garage.reserve-mb'), reserve);
		const out = execFileSync('bash', ['-c', `echo 1000; ${spaceProbeCmd(zone)}`], {
			encoding: 'utf8',
			env: { ...process.env, HOME: home },
		});
		return parseSpaceProbe(out).workFreeMb;
	} finally {
		rmSync(home, { recursive: true, force: true });
		if (zoneElsewhere) rmSync(zone, { recursive: true, force: true });
	}
}

const plainFree = (): number => {
	const home = mkdtempSync(join(tmpdir(), 'space-probe-'));
	try {
		return Number(
			execFileSync('bash', ['-c', `df -Pm ${home} | awk 'NR==2{print $4}'`], { encoding: 'utf8' })
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
};

// Free space moves while the rest of the suite writes to the same disk, so
// each figure is compared within TOL, and the reserve is large beside it.
const TOL = 256;
const near = (got: number | null, want: number): [boolean, string] => [
	got !== null && Math.abs(got - want) <= TOL,
	`${got} vs ${want} (±${TOL} MB)`,
];

test('no reserve file: the plain free figure', () => {
	assert.ok(...near(probe(null), plainFree()));
});

test('a reserve on the same filesystem is subtracted, floored at 0', () => {
	const free = plainFree();
	const reserve = Math.floor(free / 2);
	assert.ok(reserve > 4 * TOL, `the test disk has too little free space to tell (${free} MB)`);
	assert.ok(...near(probe(`${reserve}\n`), free - reserve));
	assert.equal(probe(String(free * 10)), 0);
});

test('a reserve that is not digits, or a zone on another filesystem, subtracts nothing', () => {
	const free = plainFree();
	assert.ok(...near(probe('lots'), free));
	assert.ok(...near(probe('100', true), free));
});
