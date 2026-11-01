/**
 * Tests for `runner-health-watch.ts`'s host-side supervision check and its
 * starvation finding (wave 4a, #100/#101): a listener that escaped its
 * systemd unit, and a claw refused on memory/space for hours while demand
 * exists elsewhere. Split out of runner-health.test.ts (wave 5p lane B) —
 * see `src/tests/helpers/runner-health-rig.ts` for the shared fetch-stub
 * fixture every file that ticks the monitor installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appendFileSync } from 'node:fs';
import { __resetJobHistoryForTesting, historyFile } from '../job-history-store.js';

import {
	tick,
	STARVED_NO_JOB_MS,
	__resetRunnerHealthAlertsForTesting,
	__setSupervisionCheckerForTesting,
	getRunnerHealthSnapshot,
} from '../runner-health.js';
import {
	__resetAdmissionVerdictsForTesting,
	__setAdmissionVerdictsForTesting,
	type AdmissionVerdict,
} from '../runners/ephemeral-tick.js';
import {
	installRunnerHealthRig,
	installFetch,
	hokonPromotedLabels,
	discordPosts,
	LIVE_LISTING,
} from './helpers/runner-health-rig.js';

installRunnerHealthRig();

/**
 * Host-side supervision — the class the GitHub API structurally cannot report.
 *
 * A listener that has escaped its systemd unit still answers GitHub, so the
 * runner reads ONLINE while nothing will ever restart it. Nine runners sat that
 * way across three claws for three days in August 2026 with every existing
 * alert (label floor, queued, hung) green, because all of them ask GitHub.
 */
test('runner-health: supervision problems alert, one per broken runner', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: hokonPromotedLabels() }],
		},
	});
	__setSupervisionCheckerForTesting(async () => ({
		nodes: ['claw-2'],
		unreachable: [],
		listenersSeen: 25,
		problems: [
			{
				node: 'claw-2',
				dir: 'actions-runner-hadoku-study',
				kind: 'orphan' as const,
				listeners: 1,
				scope: 'system' as const,
				unit: 'actions.runner.WolffM-hadoku-study.claw-2.service',
				unitState: 'inactive',
			},
			{
				node: 'claw-2',
				dir: 'actions-runner-hadoku-rally',
				kind: 'duplicate' as const,
				listeners: 2,
				scope: 'system' as const,
				unit: 'actions.runner.WolffM-hadoku-rally.claw-2.service',
				unitState: 'active',
			},
		],
	}));

	await tick('tok');

	const sup = discordPosts.filter((p) => /runner supervision/.test(p));
	// One alert PER broken runner, not one collapsed summary: a whole claw
	// going wrong must not look like a single runner going wrong.
	assert.equal(sup.length, 2);
	assert.ok(sup.some((p) => /hadoku-study/.test(p) && /ONLINE/.test(p)));
	assert.ok(sup.some((p) => /hadoku-rally/.test(p) && /2 listeners/.test(p)));
});

test('runner-health: a clean supervision report says nothing', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: hokonPromotedLabels() }],
		},
	});
	__setSupervisionCheckerForTesting(async () => ({
		nodes: ['claw-1', 'claw-2', 'claw-3'],
		unreachable: [],
		listenersSeen: 66,
		problems: [],
	}));

	await tick('tok');
	assert.equal(discordPosts.filter((p) => /runner supervision/.test(p)).length, 0);
});

test('runner-health: a failing supervision probe never breaks the tick', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: hokonPromotedLabels() }],
		},
	});
	__setSupervisionCheckerForTesting(() => Promise.reject(new Error('ssh exploded')));

	// The probe is an ADDITION to a monitor that already had jobs to do; it must
	// never turn "could not reach a claw over ssh" into a dead runner-health tick.
	await assert.doesNotReject(() => tick('tok'));
});

// ── starvation finding (wave 4a, #100) ───────────────────────────────────────
//
// claw-6 and claw-2 were refused by the memory clause on every tick for days,
// and nothing recorded it. `checkStarvation` reads `ephemeral-tick.ts`'s own
// generic admission verdict (injected here through its test seam — driving
// the real `dispatchEphemeral` end to end is `warm-cache.test.ts`'s job) and
// job history already written by the suite's normal fixtures.

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

/** claw-6's real numbers from the wave 4a writeup (docs/planning/wave4a-2026-10-06.md). */
const CLAW6_MEMORY_REFUSAL: AdmissionVerdict = {
	ok: false,
	clause: 'memory',
	availableMb: 4813,
	needMb: 5632,
	reserveBasis: 'node',
	reason:
		'memory: 4813MB free, this repo peaks at 5632MB, would leave -819MB against a 1536MB floor',
};

/** Comfortably past STARVED_NO_JOB_MS, whatever its current value. */
const WELL_PAST_STARVED_MS = STARVED_NO_JOB_MS + 60 * 60_000;

const starvedPings = () => discordPosts.filter((m) => m.includes('claw-6') && m.includes('MEMORY'));

test('starved: a claw refused on MEMORY for hours while another claw worked is a finding, and pages once', async () => {
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
	assert.equal(starvedPings().length, 1);
	assert.match(starvedPings()[0]!, /4813MB/);
	assert.match(starvedPings()[0]!, /5632MB/);
	assert.match(starvedPings()[0]!, /basis: node/);

	await tick('tok');
	assert.equal(starvedPings().length, 1, 'not every tick — RE_ALERT_MS dedupes');
});

/** #101: refused for want of `/tmp` space, not memory. */
const CLAW6_SPACE_REFUSAL: AdmissionVerdict = {
	ok: false,
	clause: 'space',
	availableMb: 300,
	needMb: 2048,
	filesystem: 'tmp',
	reserveBasis: 'node',
	reason: 'space: /tmp has 300MB free, under the 2048MB floor',
};

test('starved: a claw refused on SPACE for hours is a finding too, named as SPACE and never "on hokon"', async () => {
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_SPACE_REFUSAL]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
	const pings = discordPosts.filter((m) => m.includes('claw-6') && m.includes('SPACE'));
	assert.equal(pings.length, 1);
	assert.match(pings[0]!, /300MB free on \/tmp/);
	assert.match(pings[0]!, /2048MB floor/);
	// THE WORDING FIX (#101 send-back): the reporter is named, never read as
	// the refused node's location — "starved on hokon: claw-6" would say
	// claw-6 lives on hokon, which is false.
	assert.doesNotMatch(pings[0]!, /starved[^(]*on `?hokon/i);
	assert.match(pings[0]!, /reported by/i);
});

/** #101: the free space on `/tmp` could not be read at all — `availableMb`
 *  is a placeholder `0`, not a measurement. */
const CLAW6_SPACE_UNREADABLE: AdmissionVerdict = {
	ok: false,
	clause: 'space',
	availableMb: 0,
	needMb: 2048,
	filesystem: 'tmp',
	unreadable: true,
	reserveBasis: 'node',
	reason: 'space: could not read /tmp free space',
};

test('starved (d): an UNREADABLE space verdict says it could not read free space, and never prints an "…MB free" figure', async () => {
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_SPACE_UNREADABLE]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
	const pings = discordPosts.filter((m) => m.includes('claw-6') && m.includes('SPACE'));
	assert.equal(pings.length, 1);
	assert.match(pings[0]!, /could not read/i);
	assert.doesNotMatch(pings[0]!, /\d+MB free/);
});

test('starved: the same claw with an IDLE FLEET is not a finding', async () => {
	// No other claw has run anything, and the queue is empty (installFetch
	// defaults `runs` to an empty listing) — no evidence of demand.
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], false);
	assert.equal(starvedPings().length, 0);
});

test('starved: a DRAINED node’s clause is never read as starved, even with demand and an old job', async () => {
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(
		new Map([
			[
				'claw-6',
				{
					ok: false,
					clause: 'drained',
					availableMb: 0,
					needMb: 0,
					reserveBasis: 'default',
					reason: 'drained: held out of service for maintenance',
				},
			],
		])
	);
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], false);
	assert.equal(discordPosts.filter((m) => m.includes('claw-6')).length, 0);
});

test('starved: a node at its CONCURRENCY cap (not memory) is never read as starved', async () => {
	// Same shape as the drained case — a non-memory clause must never satisfy
	// (a), however long it has been idle or however busy the rest of the fleet
	// is. Also covers a slow-tier node held by the #83 spill gate: that hold is
	// a PLACEMENT refusal `admitMint` never sees, so a spill-held node reads
	// `ok: true` here, which this same assertion shape (clause !== 'memory')
	// already proves is never starved.
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(
		new Map([
			[
				'claw-6',
				{
					ok: false,
					clause: 'concurrency',
					availableMb: 0,
					needMb: 0,
					reserveBasis: 'default',
					reason: 'at capacity: 2/2 in flight',
				},
			],
		])
	);
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], false);
});

test('starved: an admitted verdict does NOT re-arm the page — only a job actually starting clears it', async () => {
	// claw-6 measured 2026-10-06 04:00Z: it sits AT the admission line and
	// flips between `ok` and memory-refused from one tick to the next with no
	// job ever landing. Clearing on every `ok` tick would re-page every
	// ~10 minutes instead of at most once an hour (RE_ALERT_MS) — the exact
	// regression this test pins.
	const base = Date.now();
	const real = Date.now;
	try {
		Date.now = () => base;
		writeJobRecord({ runner: 'claw-1', startedAt: new Date(base - 5 * 60_000).toISOString() });
		writeJobRecord({
			runner: 'claw-6',
			startedAt: new Date(base - WELL_PAST_STARVED_MS).toISOString(),
		});
		__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
		installFetch({ runners: LIVE_LISTING });

		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
		assert.equal(starvedPings().length, 1);

		// Admission flips to admitted for one tick. No job ran.
		Date.now = () => base + 60_000;
		__setAdmissionVerdictsForTesting(new Map([['claw-6', { ok: true }]]));
		await tick('tok');
		assert.equal(
			getRunnerHealthSnapshot()?.starved?.['claw-6'],
			false,
			'the PANEL stops showing it'
		);
		assert.equal(starvedPings().length, 1, 'but the LEDGER must not be touched — no job ran');

		// Flips back to memory-refused. Still well inside RE_ALERT_MS (1h), and
		// the ledger was never cleared, so this must NOT re-page.
		Date.now = () => base + 120_000;
		__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
		assert.equal(
			starvedPings().length,
			1,
			'the same finding — a bare admission flip never re-arms the page'
		);

		// A job ACTUALLY starts on claw-6. The starvation genuinely ended.
		// `jobRecords()` loads the file exactly ONCE per process (`loadHistory`'s
		// own `if (loaded) return`) — the first `tick()` above already took that
		// snapshot, so a record appended straight to disk needs a forced reload
		// or this write is invisible for the rest of the test, same trap
		// `__setHistoryPathForTesting`'s own doc comment warns about.
		Date.now = () => base + 180_000;
		writeJobRecord({ runner: 'claw-6', startedAt: new Date(base + 180_000).toISOString() });
		__resetJobHistoryForTesting();
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], false);

		// Starved again, well past the threshold measured from that real job.
		// Demand evidence has to move WITH the window: claw-6's own idle window
		// now starts at its real job (base+180s), so claw-1's job from the very
		// top of the test (base-5min) is before that window and no longer
		// counts — a fresh claw-1 job inside the new window is what an idle
		// fleet actually looks like here.
		Date.now = () => base + 180_000 + WELL_PAST_STARVED_MS;
		writeJobRecord({
			runner: 'claw-1',
			startedAt: new Date(base + 180_000 + 5 * 60_000).toISOString(),
		});
		__resetJobHistoryForTesting();
		__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
		assert.equal(
			starvedPings().length,
			2,
			'the REAL job cleared the ledger, so this re-pages immediately rather than waiting RE_ALERT_MS'
		);
	} finally {
		Date.now = real;
	}
});

test('starved: the idle-fleet branch does not clear the alert either — only a real job does', async () => {
	// Demand here rides the QUEUE rather than another claw, deliberately: once
	// a FIXED job record falls inside claw-6's idle window, it never ages back
	// out (the window's start is claw-6's own last job, which does not move
	// forward on its own), so a job-record-only fixture cannot toggle `othersActive`
	// from true to false across ticks. The queue can.
	const base = Date.now();
	const real = Date.now;
	const queuedRun = (id: number, atMs: number) => ({
		workflow_runs: [
			{
				id,
				status: 'queued',
				conclusion: null,
				created_at: new Date(atMs).toISOString(),
				html_url: `https://gh/run/${id}`,
				display_title: 'queued thing',
			},
		],
	});
	try {
		Date.now = () => base;
		writeJobRecord({
			runner: 'claw-6',
			startedAt: new Date(base - WELL_PAST_STARVED_MS).toISOString(),
		});
		__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
		installFetch({ runners: LIVE_LISTING, runs: queuedRun(1, base) });

		await tick('tok');
		assert.equal(
			getRunnerHealthSnapshot()?.starved?.['claw-6'],
			true,
			'a non-empty queue is demand too'
		);
		assert.equal(starvedPings().length, 1);

		// The queue drains. No demand at all now — an idle fleet.
		Date.now = () => base + 60_000;
		installFetch({ runners: LIVE_LISTING });
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], false);
		assert.equal(
			starvedPings().length,
			1,
			'idle fleet — not a finding, but no job ran on claw-6 either'
		);

		// Demand returns, well inside RE_ALERT_MS. If the idle-fleet tick above
		// had cleared the ledger, this would re-page immediately; it must not,
		// because the claw-6 starvation itself never actually ended.
		Date.now = () => base + 120_000;
		installFetch({ runners: LIVE_LISTING, runs: queuedRun(2, base + 120_000) });
		await tick('tok');
		assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
		assert.equal(
			starvedPings().length,
			1,
			'the idle-fleet tick must not have cleared the ledger — still the same finding'
		);
	} finally {
		Date.now = real;
	}
});

test('starved: an ABSENT verdict carries the previous reading forward and never clears or re-fires the alert', async () => {
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.starved?.['claw-6'], true);
	assert.equal(starvedPings().length, 1);

	// Simulate the restart's blind window: `ephemeral-tick.ts` has not ticked
	// yet this process, so there is no verdict for claw-6 at all — "could not
	// look", never "admitted".
	__resetAdmissionVerdictsForTesting();
	await tick('tok');
	assert.equal(
		getRunnerHealthSnapshot()?.starved?.['claw-6'],
		true,
		'could not look this tick — the previous finding carries forward'
	);
	assert.equal(
		starvedPings().length,
		1,
		'no new post — a tick that learned nothing must not touch the alert ledger'
	);

	// Restore the SAME refusal. The ledger was never cleared while absent, so
	// this must stay inside RE_ALERT_MS rather than re-firing.
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
	await tick('tok');
	assert.equal(
		starvedPings().length,
		1,
		'the ledger was untouched while the verdict was absent — this is still the same finding'
	);
});

test('starved: a restart (fresh alert ledger, no verdict yet) finds it from job history alone the moment a verdict lands', async () => {
	writeJobRecord({ runner: 'claw-1', startedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
	writeJobRecord({
		runner: 'claw-6',
		startedAt: new Date(Date.now() - WELL_PAST_STARVED_MS).toISOString(),
	});
	// A restart: the alert ledger AND the verdict snapshot both start empty —
	// no accumulated module state to wait out.
	__resetRunnerHealthAlertsForTesting();
	__resetAdmissionVerdictsForTesting();
	// The first post-restart `ephemeral-tick` pass has now landed.
	__setAdmissionVerdictsForTesting(new Map([['claw-6', CLAW6_MEMORY_REFUSAL]]));
	installFetch({ runners: LIVE_LISTING });

	await tick('tok');
	assert.equal(
		getRunnerHealthSnapshot()?.starved?.['claw-6'],
		true,
		'found on the FIRST tick — from persisted job history, not accumulated module state'
	);
	assert.equal(starvedPings().length, 1);
});
