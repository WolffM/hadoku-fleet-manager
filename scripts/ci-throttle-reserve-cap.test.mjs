/**
 * ci-throttle's #76 reserve-vs-cap cases: the hokon half of placement,
 * static rather than behavioural — `reserve_mb()` reads a repo's known need
 * off the SAME admission ledger `admitMint` reads, `unit_cap_mb()` reads
 * this job's own cgroup `memory.max`, and a need over the cap refuses
 * IMMEDIATELY, before any wait. Split out of ci-throttle.test.mjs (wave 5p
 * lane C) — see `lib/ci-throttle-fixtures.mjs` for the shared `run()` this
 * file drives the real `ci-throttle.sh` through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	FIXTURE_PREFIX,
	installCiThrottleRig,
	installLeakGate,
	run,
} from './lib/ci-throttle-fixtures.mjs';
import { tempDir } from './lib/test-tmpdir.mjs';

installCiThrottleRig();

// ── #76's hokon half: KNOWN NEED VS THIS UNIT'S CAP, A STATIC FINDING ──────
//
// In an outage the backstop promotes hokon onto `hadoku-builder` and GitHub
// assigns jobs to it directly, bypassing `admitMint` entirely — this hook is
// the only gate those jobs pass through. `reserve_mb()` reads the SAME
// admission ledger `admitMint` reads (`facets[<repo>].jobP95Mb.mb`), and
// `unit_cap_mb()` reads this job's own cgroup `memory.max` the same way
// job-metrics.sh already does. Both are fixtured here rather than driven
// against the real ledger/cgroup, for the same reason MEMINFO is: a fixture
// is the only way to pin them for an assertion.

/** A temp `fleet-runner-coverage.json` holding exactly the facets given. */
function reserveFixture(facets) {
	const dir = tempDir(`${FIXTURE_PREFIX}reserve-`);
	const file = join(dir, 'fleet-runner-coverage.json');
	writeFileSync(file, JSON.stringify({ facets }));
	return file;
}

/** A temp file standing in for this job's cgroup `memory.max`. */
function capFixture(bytesOrMax) {
	const dir = tempDir(`${FIXTURE_PREFIX}cap-`);
	const file = join(dir, 'memory.max');
	writeFileSync(file, `${bytesOrMax}\n`);
	return file;
}

test("#76: a known need over this unit's cap refuses IMMEDIATELY, as PLACEMENT, no wait", () => {
	const reserveFile = reserveFixture({
		'WolffM/brave-quartet': { jobP95Mb: { mb: 6313, basis: 'fleet-p95', runs: 3 } },
	});
	const capFile = capFixture(4294967296); // 4096 MiB, hokon's measured per-unit cap
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 90 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/brave-quartet',
			CI_THROTTLE_RESERVE_FILE: reserveFile,
			CI_THROTTLE_CGROUP_MEMORY_MAX: capFile,
		},
	});
	assert.notEqual(r.code, 0, `a confirmed cap breach must refuse: ${r.out}${r.err}`);
	assert.match(r.out + r.err, /::error::/, 'ADR 1751 annotation must be on the refusal');
	assert.match(r.out + r.err, /cannot host this job/, r.out + r.err);
	assert.match(r.out + r.err, /placement problem, not a throttling one/, r.out + r.err);
	assert.match(r.out + r.err, /6313MB/, r.out + r.err);
	assert.match(r.out + r.err, /4096MB/, r.out + r.err);
	// STATIC — nothing a wait could learn changes either number, so this must
	// not pay any part of MAX_WAIT_S=90 to say so.
	assert.ok(
		r.elapsedMs < 3000,
		`a static cap breach must refuse before waiting, took ${r.elapsedMs}ms`
	);
});

test('#76: a known need AT OR UNDER the cap is not touched by this check', () => {
	const reserveFile = reserveFixture({
		'WolffM/hadoku-aggregator': { jobP95Mb: { mb: 1878, basis: 'measured', runs: 43 } },
	});
	const capFile = capFixture(4294967296);
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/hadoku-aggregator',
			CI_THROTTLE_RESERVE_FILE: reserveFile,
			CI_THROTTLE_CGROUP_MEMORY_MAX: capFile,
		},
	});
	assert.equal(r.code, 0, `well under the cap must admit normally: ${r.out}${r.err}`);
});

test('#76: no ledger on disk is uncertainty, not a breach — admits', () => {
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/brave-quartet',
			CI_THROTTLE_RESERVE_FILE: '/does/not/exist/fleet-runner-coverage.json',
			CI_THROTTLE_CGROUP_MEMORY_MAX: capFixture(4294967296),
		},
	});
	assert.equal(r.code, 0, `an absent ledger must fail open, not refuse: ${r.out}${r.err}`);
	assert.doesNotMatch(r.out + r.err, /cannot host this job|placement problem/);
});

test('#76: a repo the ledger has no entry for is uncertainty, not a breach — admits', () => {
	const reserveFile = reserveFixture({
		'WolffM/some-other-repo': { jobP95Mb: { mb: 9999, basis: 'measured', runs: 10 } },
	});
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/brave-quartet',
			CI_THROTTLE_RESERVE_FILE: reserveFile,
			CI_THROTTLE_CGROUP_MEMORY_MAX: capFixture(4294967296),
		},
	});
	assert.equal(r.code, 0, `an unlisted repo must fail open, not refuse: ${r.out}${r.err}`);
	assert.doesNotMatch(r.out + r.err, /cannot host this job|placement problem/);
});

test('#76: an UNCAPPED unit ("max") cannot be in breach of a cap it does not have', () => {
	const reserveFile = reserveFixture({
		'WolffM/brave-quartet': { jobP95Mb: { mb: 99999, basis: 'measured', runs: 10 } },
	});
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/brave-quartet',
			CI_THROTTLE_RESERVE_FILE: reserveFile,
			CI_THROTTLE_CGROUP_MEMORY_MAX: capFixture('max'),
		},
	});
	assert.equal(
		r.code,
		0,
		`an uncapped unit must admit regardless of the reserve: ${r.out}${r.err}`
	);
	assert.doesNotMatch(r.out + r.err, /cannot host this job|placement problem/);
});

test('#76: an unreadable cap file is uncertainty, not a breach — admits', () => {
	const reserveFile = reserveFixture({
		'WolffM/brave-quartet': { jobP95Mb: { mb: 99999, basis: 'measured', runs: 10 } },
	});
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/brave-quartet',
			CI_THROTTLE_RESERVE_FILE: reserveFile,
			CI_THROTTLE_CGROUP_MEMORY_MAX: '/does/not/exist/memory.max',
		},
	});
	assert.equal(r.code, 0, `an unreadable cap must fail open, not refuse: ${r.out}${r.err}`);
	assert.doesNotMatch(r.out + r.err, /cannot host this job|placement problem/);
});

test('#76: the lower-bound shape (jobP95Mb.mb raised off a capped run) is still used as a need', () => {
	// Exactly brave-quartet's real shape (wave 3t Lane C): three runs, two
	// capped at a 6.3GB slice. The hook does not need to know `lowerBound`
	// exists — `.mb` already carries "at least this much" whether or not that
	// field is present, which is why reserve_mb() reads nothing but `.mb`.
	const reserveFile = reserveFixture({
		'WolffM/brave-quartet': {
			jobP95Mb: { mb: 6313, basis: 'fleet-p95', runs: 3, lowerBound: true },
		},
	});
	const r = run({
		conf: { MAX_CONCURRENT: 99, MIN_FREE_MB: 0, MAX_WAIT_S: 5 },
		others: 0,
		env: {
			GITHUB_REPOSITORY: 'WolffM/brave-quartet',
			CI_THROTTLE_RESERVE_FILE: reserveFile,
			CI_THROTTLE_CGROUP_MEMORY_MAX: capFixture(4294967296),
		},
	});
	assert.notEqual(r.code, 0, `a lower-bound need over the cap must still refuse: ${r.out}${r.err}`);
	assert.match(r.out + r.err, /cannot host this job/, r.out + r.err);
});

installLeakGate();
