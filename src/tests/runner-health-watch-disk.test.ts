/**
 * Tests for `runner-health-watch.ts`'s disk-watch finding (wave 4c §F, the
 * operator's disk ask 2026-10-07) and its node-regression finding (wave 4e
 * §B, #102): a claw crossing the advisory/page lines on `/tmp` or `_work`,
 * and claw-3-shaped divergences that mark a workload proof stale. Split out
 * of runner-health.test.ts (wave 5p lane B) — see
 * `src/tests/helpers/runner-health-rig.ts` for the shared fetch-stub fixture
 * every file that ticks the monitor installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appendFileSync, mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { historyFile } from '../job-history-store.js';

import { tick, __resetRunnerHealthAlertsForTesting } from '../runner-health.js';
import { getRunnerHealthSnapshot } from '../runner-health-snapshot.js';
import { HOUR_MS as RE_ALERT_MS } from '../lib/job-runner.js';
import { __setBackstopMachinesForTesting } from '../runners/backstop-machines.js';
import { __setTmpConsumerProbeForTesting } from '../runner-health-watch.js';
import { runTmpConsumerProbe, tmpConsumersCmd } from '../runners/tmp-consumers.js';
import { tempDir } from './tmpdir.js';
import { __reloadAlertLedgerForTesting } from '../lib/alert-ledger.js';
import {
	__resetDiskReadingsForTesting,
	__setDiskReadingsForTesting,
} from '../runners/disk-watch.js';
import {
	__setGatedKindsForTesting,
	__setMarkStaleForTesting,
	__setReadProofForTesting,
	type GatedKind,
} from '../runners/node-regression.js';
import type { ProofRecord } from '../lib/workload-gate.js';
import { installRunnerHealthRig, installFetch, discordPosts } from './helpers/runner-health-rig.js';
import { LIVE_LISTING } from './helpers/runner-health-fixtures.js';

installRunnerHealthRig();

// ── disk-watch finding (wave 4c §F, the operator's disk ask 2026-10-07) ─────
//
// An early warning on the `_work` filesystem, read from `disk-watch.ts`'s own
// registry (injected here through its test seam — the real `ephemeral-tick.ts`
// hunk that fills it in production lands after lane A and is not under test
// here, same split `checkStarvation` already draws against
// `__setAdmissionVerdictsForTesting`).

const diskPings = (level: 'advisory' | 'page' | 'unreadable') =>
	discordPosts.filter(
		(m) => m.includes('claw-6') && m.includes('**disk**') && pingMatches(m, level)
	);

function pingMatches(m: string, level: 'advisory' | 'page' | 'unreadable'): boolean {
	// Matched on the leading emoji, not a phrase — the advisory message itself
	// names the page line it has not yet crossed ("before it crosses the 10GB
	// page line"), so a text match on "page line" alone would also catch an
	// advisory post.
	if (level === 'unreadable') return m.startsWith('🥀 **disk**');
	if (level === 'page') return m.startsWith('🔥 **disk**');
	return m.startsWith('⚠️ **disk**');
}

/** hokon as an on-demand backstop: minted, not standing, carrying only the deploy runner. */
const ON_DEMAND = {
	hokon: { role: 'backstop', mint: 'on-demand', standingRepos: ['WolffM/hadoku_site'] },
};

test('disk-watch: a node under the advisory line is advisory, and pages once', async () => {
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 20 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'advisory');
	assert.equal(diskPings('advisory').length, 1);
	assert.match(diskPings('advisory')[0]!, /20GB free/);
	assert.match(diskPings('advisory')[0]!, /25GB advisory line/);

	await tick('tok');
	assert.equal(diskPings('advisory').length, 1, 'not every tick — RE_ALERT_MS dedupes');
});

test('disk-watch 2026-10-21: /tmp under the mint floor pages even with _work wide open, and names the floor', async () => {
	// hokon's shape that night: 370 GB free on the disk, 1.7 GB on the tmpfs.
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 1718, workFreeMb: 370 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'page', 'the worse of the two');
	const page = diskPings('page');
	assert.equal(page.length, 1);
	assert.match(page[0]!, /\/tmp has 1\.7GB free/);
	assert.match(page[0]!, /2048MB mint floor/);
	assert.doesNotMatch(page[0]!, /pm2-host deploys/, 'a claw loses CI, not deploys');

	await tick('tok');
	assert.equal(diskPings('page').length, 1, 'once');
});

test('disk-watch #132: a small, nearly empty /tmp is not a repeating advisory — the size is said once, filling still pages', async () => {
	// claw-6's shape: a 3994MB tmpfs with ~100MB used.
	__setDiskReadingsForTesting(
		new Map([['claw-6', { tmpFreeMb: 3900, tmpSizeMb: 3994, workFreeMb: 189 * 1024 }]])
	);
	installFetch({ runners: LIVE_LISTING });
	const capacity = () =>
		discordPosts.filter((m) => m.startsWith('ℹ️ **disk**') && m.includes('`claw-6`'));

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'ok');
	assert.equal(diskPings('advisory').length, 0, 'no leak warning for space that was never there');
	assert.equal(capacity().length, 1);
	assert.match(capacity()[0]!, /3\.9GB filesystem/);
	assert.equal(getRunnerHealthSnapshot()?.tmpSmall?.['claw-6'], 3994);

	// A restart: the persisted snapshot, not the hour-long alert ledger, is
	// what remembers the capacity fact was already said.
	__resetRunnerHealthAlertsForTesting();
	__reloadAlertLedgerForTesting();
	await tick('tok');
	await tick('tok');
	assert.equal(capacity().length, 1, 'once, not hourly');
	assert.equal(diskPings('advisory').length, 0);

	__setDiskReadingsForTesting(
		new Map([['claw-6', { tmpFreeMb: 2300, tmpSizeMb: 3994, workFreeMb: 189 * 1024 }]])
	);
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'page');
	assert.equal(diskPings('page').length, 1);
	assert.match(diskPings('page')[0]!, /\/tmp has 2\.2GB free/);
	assert.equal(capacity().length, 1);
});

// ── /tmp consumers named in the alert (2026-11-08) ───────────────────────────
//
// hokon's /tmp went advisory on four fresh 2.4GB sqlite copies in a live
// Claude session's scratchpad; the hint said "something that ignores TMPDIR"
// and pointed at `-mmin +60` leftovers. The probe here is the real script,
// run by bash against a fixture directory standing in for the node's /tmp.

function claudeScratchFixture(): string {
	const root = tempDir('rh-tmp-consumers-');
	const scratch = join(root, 'claude-4242', '-home-op-repos', 'sess-a', 'scratchpad');
	mkdirSync(scratch, { recursive: true });
	const copy = join(scratch, 'copy-1.sqlite');
	writeFileSync(copy, '');
	truncateSync(copy, Math.round(2.4 * 1024 ** 3));
	return root;
}

test('disk-watch 2026-11-08: a /tmp advisory names the largest recent consumers the node reports', async () => {
	const root = claudeScratchFixture();
	const probed: string[] = [];
	__setTmpConsumerProbeForTesting((node) => {
		probed.push(node);
		return runTmpConsumerProbe('bash', ['-c', tmpConsumersCmd(root)]);
	});
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 3800, workFreeMb: 189 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });
	try {
		await tick('tok');
		const adv = diskPings('advisory');
		assert.equal(adv.length, 1);
		assert.match(adv[0]!, /\/tmp has 3\.7GB free/);
		assert.ok(
			adv[0]!.includes(
				`\`${join(root, 'claude-4242', '-home-op-repos', 'sess-a', 'scratchpad', 'copy-1.sqlite')}\` 2.4GB, last written`
			),
			adv[0]
		);
		assert.match(adv[0]!, /\/tmp\/claude-<uid>\//, 'names Claude scratchpads as a known consumer');
		assert.match(adv[0]!, /-mmin -180/, 'a command for what is filling it NOW');
		assert.doesNotMatch(adv[0]!, /so this is something that ignores TMPDIR/, 'no asserted cause');
		assert.deepEqual(probed, ['claw-6']);

		await tick('tok');
		assert.equal(diskPings('advisory').length, 1);
		assert.deepEqual(probed, ['claw-6'], 'a suppressed tick does not run the probe');
	} finally {
		__setTmpConsumerProbeForTesting(null);
	}
});

test('disk-watch 2026-11-08: a probe that fails or throws never suppresses the alert, and says why', async () => {
	__setTmpConsumerProbeForTesting(() =>
		runTmpConsumerProbe('bash', [
			'-c',
			'echo "ssh: connect to host claw-6: timed out" >&2; exit 255',
		])
	);
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 1718, workFreeMb: 370 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });
	try {
		await tick('tok');
		const page = diskPings('page');
		assert.equal(page.length, 1);
		assert.match(page[0]!, /2048MB mint floor/);
		assert.match(page[0]!, /consumer probe on `claw-6` failed \(.*timed out\)/);
		assert.match(page[0]!, /du -xsh \/tmp\/claude-\*/, 'still says where to look by hand');

		__setTmpConsumerProbeForTesting(() => Promise.reject(new Error('manifest unreadable')));
		__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 3800, workFreeMb: 370 * 1024 }]]));
		await tick('tok');
		const adv = diskPings('advisory');
		assert.equal(adv.length, 1);
		assert.match(adv[0]!, /consumer probe on `claw-6` failed \(manifest unreadable\)/);
	} finally {
		__setTmpConsumerProbeForTesting(null);
	}
});

test('disk-watch 2026-10-21: an on-demand backstop is watched too, and its page says deploys stop', async () => {
	__setBackstopMachinesForTesting(() => ON_DEMAND);
	__setDiskReadingsForTesting(new Map([['hokon', { tmpFreeMb: 1718, workFreeMb: 370 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });
	try {
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['hokon'], 'page');
		// `diskPings` is pinned to claw-6; look for hokon's own page directly.
		const page = discordPosts.find(
			(p) => p.startsWith('🔥 **disk**') && p.includes('`hokon`') && p.includes('/tmp')
		);
		assert.ok(page, `hokon is judged: ${discordPosts.join(' | ')}`);
		assert.match(page!, /pm2-host deploys nothing else can run/);
	} finally {
		__setBackstopMachinesForTesting(() => ({}));
	}
});

test('disk-watch: a node under the page line pages once, not every tick', async () => {
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 5 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'page');
	assert.equal(diskPings('page').length, 1);
	assert.match(diskPings('page')[0]!, /5GB free/);
	assert.match(diskPings('page')[0]!, /10GB page line/);

	await tick('tok');
	assert.equal(diskPings('page').length, 1, 'not every tick — RE_ALERT_MS dedupes');
});

/**
 * Characterization test (F12, plan §4.1 — written against this file BEFORE
 * `alertOnce` was ported onto `createPager`, and still green after). Every
 * other `RE_ALERT_MS dedupes` test above only advances time by seconds or
 * minutes — none crosses the window itself, so none would have caught a
 * migration that silently changed the actual boundary (e.g. collapsing the
 * import to the wrong shared duration, `DAY_MS` instead of `HOUR_MS`). This
 * one does: one millisecond short of RE_ALERT_MS is still silence, and the
 * window itself is a fresh page.
 */
test('disk-watch: RE_ALERT_MS is the actual boundary, not just "some window" — one ms short is silence, the window itself re-pages', async () => {
	// A hard-coded expectation, not a derived one: this is read from the
	// export only for the boundary math below, which must still be checked
	// against the real-world number a migration could silently repoint —
	// `job-runner.ts`'s DAY_MS instead of its HOUR_MS, say.
	assert.equal(RE_ALERT_MS, 60 * 60_000, 're-pings a sustained condition at most HOURLY');
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 5 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });
	const base = Date.now();
	const real = Date.now;
	try {
		Date.now = () => base;
		await tick('tok');
		assert.equal(diskPings('page').length, 1);

		Date.now = () => base + RE_ALERT_MS - 1;
		await tick('tok');
		assert.equal(diskPings('page').length, 1, 'one ms short of the window: still suppressed');

		Date.now = () => base + RE_ALERT_MS;
		await tick('tok');
		assert.equal(diskPings('page').length, 2, 'the window itself is due');
	} finally {
		Date.now = real;
	}
});

test('disk-watch: a node back under the lines clears — the next crossing re-fires immediately', async () => {
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 5 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(diskPings('page').length, 1);

	// Recovered well past both lines.
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 100 * 1024 }]]));
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'ok');

	// Crosses the page line again — fires immediately, not suppressed by the
	// earlier page's RE_ALERT_MS window.
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 5 * 1024 }]]));
	await tick('tok');
	assert.equal(diskPings('page').length, 2, 'cleared, so the re-crossing is a fresh finding');
});

test('disk-watch: an unreadable work-free reading is its own finding, never silently "ok"', async () => {
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: null }]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'unreadable');
	assert.equal(diskPings('unreadable').length, 1);

	await tick('tok');
	assert.equal(diskPings('unreadable').length, 1, 'not every tick — RE_ALERT_MS dedupes');
});

test('disk-watch: a node this tick has NO reading for carries the previous reading forward, and never touches the ledger', async () => {
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 5 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.diskWatch?.['claw-6'], 'page');
	assert.equal(diskPings('page').length, 1);

	// The registry goes empty — e.g. the producing tick has not run since a
	// restart. "Could not look" must not read as "fine".
	__resetDiskReadingsForTesting();
	await tick('tok');
	assert.equal(
		getRunnerHealthSnapshot()?.diskWatch?.['claw-6'],
		'page',
		'the PREVIOUS reading carries forward, not a reset to ok'
	);
	assert.equal(
		diskPings('page').length,
		1,
		'a tick that learned nothing must not touch the ledger'
	);
});

test('disk-watch: hokon never appears, even if a reading is injected for it', async () => {
	__setDiskReadingsForTesting(new Map([['hokon', { tmpFreeMb: 100, workFreeMb: 100 }]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(
		getRunnerHealthSnapshot()?.diskWatch?.hokon,
		undefined,
		'hokon is a backstop and is never judged, however the registry reads'
	);
	assert.equal(
		discordPosts.some((m) => m.includes('hokon') && m.includes('**disk**')),
		false
	);
});

test('disk-watch: every claw is judged, not just the one under test', async () => {
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 50_000, workFreeMb: 100 * 1024 }]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	const snap = getRunnerHealthSnapshot()?.diskWatch ?? {};
	for (const node of [
		'claw-1',
		'claw-2',
		'claw-3',
		'claw-4',
		'claw-5',
		'claw-6',
		'claw-8',
		'claw-9',
	]) {
		assert.equal(
			node in snap,
			true,
			`${node} is in the ephemeral set and must be judged every tick`
		);
	}
});

// ── node regression finding (wave 4e §B, #102) ───────────────────────────────
//
// claw-3 earned `jdk21` on a RAM floor and a tool probe, then failed five
// full cardtable `forge-e2e` jobs while every one passed on another claw
// within the hour. `node-regression.ts` holds the detection, the "real
// product red" exclusion and the injected stale-mark; these tests drive it
// through the real `tick()` call site, same split the starvation/disk-watch
// blocks above use against their own modules.

const JDK21_KIND: GatedKind = {
	capability: 'jdk21',
	repo: 'WolffM/hadoku-cardtable',
	job: 'forge-e2e',
};

/** Same shape as the starved file's own helper — appends one job-history record. */
function writeJobRecord(r: Partial<Record<string, unknown>>) {
	appendFileSync(
		historyFile(),
		JSON.stringify({
			repo: 'WolffM/hadoku_site',
			runId: 1,
			jobId: Math.floor(Math.random() * 1e9),
			name: 'check',
			runner: 'claw-1',
			labels: ['self-hosted', 'hadoku-builder'],
			startedAt: new Date().toISOString(),
			durationSec: 60,
			conclusion: 'success',
			...r,
		}) + '\n'
	);
}

/**
 * A fresh PASS, filed under whichever (node, capability) it is asked for.
 * Every regression test below injects one via `__setReadProofForTesting` so
 * none of them ever reach the real `measured.ts#readProof` — which would
 * read this suite's throwaway test-host state dir rather than a fixture the
 * test controls, the same "never a real state dir" rule the suite already
 * follows for history and snapshots.
 */
function passProofAt(atIso: string): (node: string, capability: string) => ProofRecord {
	return (node, capability) => ({
		node,
		capability,
		runId: null,
		runner: null,
		conclusion: null,
		durationSec: null,
		evidenceMatched: true,
		budgetSec: null,
		verdict: 'pass',
		why: 'fixture',
		at: atIso,
	});
}

/** Safely before every divergence timestamp `writeDivergences` ever writes. */
const FAR_PAST = new Date(0).toISOString();

/** `count` claw-3-shaped pairs: claw-3 FAILED, claw-8 PASSED, same commit, minutes apart. */
function writeDivergences(opts: { count?: number; failNode?: string; alsoFailOn?: string } = {}) {
	const failNode = opts.failNode ?? 'claw-3';
	const count = opts.count ?? 5;
	for (let i = 0; i < count; i++) {
		const sha = `${i}`.repeat(40).slice(0, 40);
		const base = Date.now() - (count - i) * 3600_000; // spread across the retained window
		writeJobRecord({
			repo: JDK21_KIND.repo,
			name: JDK21_KIND.job,
			runId: 10_000 + i,
			runner: failNode,
			conclusion: 'failure',
			headSha: sha,
			startedAt: new Date(base).toISOString(),
		});
		if (opts.alsoFailOn) {
			writeJobRecord({
				repo: JDK21_KIND.repo,
				name: JDK21_KIND.job,
				runId: 20_000 + i,
				runner: opts.alsoFailOn,
				conclusion: 'failure',
				headSha: sha,
				startedAt: new Date(base + 2 * 60_000).toISOString(),
			});
		}
		writeJobRecord({
			repo: JDK21_KIND.repo,
			name: JDK21_KIND.job,
			runId: 30_000 + i,
			runner: 'claw-8',
			conclusion: 'success',
			headSha: sha,
			startedAt: new Date(base + 10 * 60_000).toISOString(),
		});
	}
}

const regressionPings = () => discordPosts.filter((m) => m.includes('**regression**'));

test('regression: five claw-3-shaped divergences mark the proof stale and page once', async () => {
	writeDivergences();
	const marked: { node: string; capability: string }[] = [];
	__setGatedKindsForTesting([JDK21_KIND]);
	__setReadProofForTesting(passProofAt(FAR_PAST));
	__setMarkStaleForTesting((node, capability) => {
		marked.push({ node, capability });
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [node] };
	});
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(marked.length, 1, 'the proof is marked stale exactly once this tick');
	assert.equal(marked[0]?.node, 'claw-3');
	assert.equal(marked[0]?.capability, 'jdk21');
	assert.equal(regressionPings().length, 1);
	assert.match(regressionPings()[0]!, /claw-3/);
	assert.match(regressionPings()[0]!, /STALE/);

	await tick('tok');
	assert.equal(regressionPings().length, 1, 'not every tick — same dedupe as starved/disk-watch');
});

test('regression: one divergence below N does not act', async () => {
	writeDivergences({ count: 4 }); // REGRESSION_THRESHOLD - 1
	__setGatedKindsForTesting([JDK21_KIND]);
	__setReadProofForTesting(passProofAt(FAR_PAST));
	let calls = 0;
	__setMarkStaleForTesting(() => {
		calls++;
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
	});
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(calls, 0, 'four divergences is one short of the threshold');
	assert.equal(regressionPings().length, 0);
});

test('regression: a failure that ALSO failed elsewhere (a real product red) does not count', async () => {
	writeDivergences({ alsoFailOn: 'claw-9' });
	__setGatedKindsForTesting([JDK21_KIND]);
	__setReadProofForTesting(passProofAt(FAR_PAST));
	let calls = 0;
	__setMarkStaleForTesting(() => {
		calls++;
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
	});
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(
		calls,
		0,
		'two distinct nodes failing the same commit is a product red, not claw-3 regressing'
	);
	assert.equal(regressionPings().length, 0);
});

test('regression: hokon never acts, even with five divergences of its own', async () => {
	writeDivergences({ failNode: 'hokon' });
	__setGatedKindsForTesting([JDK21_KIND]);
	__setReadProofForTesting(passProofAt(FAR_PAST));
	let calls = 0;
	__setMarkStaleForTesting(() => {
		calls++;
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
	});
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(calls, 0, 'hokon is a backstop — never proven, never canaried, never marked stale');
	assert.equal(regressionPings().length, 0);
});

test('regression: a job without a head sha never counts', async () => {
	for (let i = 0; i < 5; i++) {
		const base = Date.now() - (5 - i) * 3600_000;
		writeJobRecord({
			repo: JDK21_KIND.repo,
			name: JDK21_KIND.job,
			runId: 40_000 + i,
			runner: 'claw-3',
			conclusion: 'failure',
			startedAt: new Date(base).toISOString(),
			// no headSha
		});
		writeJobRecord({
			repo: JDK21_KIND.repo,
			name: JDK21_KIND.job,
			runId: 50_000 + i,
			runner: 'claw-8',
			conclusion: 'success',
			startedAt: new Date(base + 10 * 60_000).toISOString(),
			// no headSha
		});
	}
	__setGatedKindsForTesting([JDK21_KIND]);
	__setReadProofForTesting(passProofAt(FAR_PAST));
	let calls = 0;
	__setMarkStaleForTesting(() => {
		calls++;
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
	});
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(calls, 0, 'no head sha, no same-commit comparison, no divergence');
	assert.equal(regressionPings().length, 0);
});

// ── manager send-back: a divergence only counts against the node's CURRENT proof ──
//
// checkNodeRegressions never consulted the node's $proof at all, so a
// re-proved node could never regain the label for the rest of the 14-day
// retention window, and a stale mark (plus its facet log line) was rewritten
// every ~10-minute tick forever. `node-regression.ts`'s `readProof`
// (injected, same pattern as `markStale`) now gates both halves.

test('regression (1): five PRE-proof divergences + a fresh pass written after them do not re-trigger', async () => {
	writeDivergences();
	// Every divergence `writeDivergences()` writes is dated in the past
	// relative to `Date.now()` (its own `base` is `Date.now() - Nh`); "now" is
	// therefore safely AFTER all of them — the tracker re-proving the node
	// AFTER the incident.
	__setGatedKindsForTesting([JDK21_KIND]);
	__setReadProofForTesting(passProofAt(new Date().toISOString()));
	let calls = 0;
	__setMarkStaleForTesting(() => {
		calls++;
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
	});
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.equal(calls, 0, 'a fresh proof written after the divergences retires every one of them');
	assert.equal(regressionPings().length, 0);
});

test('regression (3): the transition tick marks once; a FOLLOWING tick on the same divergences does not re-mark', async () => {
	writeDivergences();
	__setGatedKindsForTesting([JDK21_KIND]);
	// Starts PASS (FAR_PAST, i.e. before every divergence): the transition
	// tick must mark it stale. `markStale` flips the fixture's own verdict,
	// exactly as the real `markProofStale` flips the record it writes, so the
	// SECOND tick reads the state a following real tick actually would.
	let verdict: 'pass' | 'stale' = 'pass';
	__setReadProofForTesting((node, capability) => ({
		...passProofAt(FAR_PAST)(node, capability),
		verdict,
	}));
	let calls = 0;
	__setMarkStaleForTesting(() => {
		calls++;
		verdict = 'stale';
		return { ok: true, path: '/fake', logPath: '/fake.log', written: [] };
	});
	installFetch({ runners: LIVE_LISTING });

	await tick('tok'); // transition tick
	assert.equal(calls, 1, 'the transition tick marks it stale exactly once');
	assert.equal(regressionPings().length, 1);

	await tick('tok'); // following tick, same divergences still in the 14-day window
	assert.equal(
		calls,
		1,
		'a following tick over the SAME divergence set must not re-mark — already stale'
	);
});
