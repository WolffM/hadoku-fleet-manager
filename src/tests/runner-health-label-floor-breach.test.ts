/**
 * Tests for `runner-health-label-floor.ts`'s label-floor breach: the per-label
 * demand/debounce/streak rules, the jdk21 workload-proof gate, listing
 * paging/flap/truncation, and the basic queued/hung/fail-soft baselines that
 * share its fixtures. Split out of runner-health.test.ts (wave 5p lane B) —
 * see `src/tests/helpers/runner-health-rig.ts` for the shared fetch-stub
 * fixture every file that ticks the monitor installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { historyFile } from '../job-history-store.js';
import { testStateDir } from './install-test-host.js';

import {
	tick,
	__resetRunnerHealthAlertsForTesting,
	getRunnerHealthSnapshot,
	__setFloorDemandForTesting,
} from '../runner-health.js';
import { __reloadAlertLedgerForTesting } from '../lib/alert-ledger.js';
import { __setFleetProbeForTesting } from '../fleet-loop.js';
import { writeDrain } from '../runners/drain.js';
import { __setWorkloadGateContextForTesting } from '../runners/ephemeral-tick.js';
import { workloadGateContext } from '../lib/workload-gate.js';
import type { ProofRecord } from '../lib/measured.js';
import {
	installRunnerHealthRig,
	installFetch,
	clawLabels,
	hokonLabels,
	hokonPromotedLabels,
	discordPosts,
	jobSinkPosts,
	labelOps,
	runnerListingUrls,
	minutesAgo,
	LIVE_LISTING,
} from './helpers/runner-health-rig.js';

installRunnerHealthRig();

test('runner-health: pm2-host with 0 online runners pages; hadoku-builder (1 online) does not', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
	});
	// Two ticks: the floor debounces so a transient disconnect cannot page.
	await tick('tok');
	await tick('tok');
	// One alert PER breached capability. This fixture is claws only, so every
	// label hokon offers is at zero — pm2-host, taskauto and av1-nvenc alike.
	// Asserting a total of 1 would pin the size of REQUIRED_LABELS rather than
	// the behaviour, and adding a genuine routing dependency would then "fail"
	// a test about something else.
	const floor = discordPosts.filter((p) => /will queue/.test(p));
	assert.equal(floor.length, 3, 'pm2-host, taskauto and av1-nvenc are all at zero here');
	assert.ok(
		floor.some((p) => /pm2-host/.test(p)),
		'the pm2-host breach must be among them'
	);
	assert.ok(
		!discordPosts.some((p) => /hadoku-builder/.test(p)),
		'hadoku-builder has one online runner and must NOT page'
	);
});

// RETIRED 2026-09-08 (decision C0b, `claw-floor-design-2026-09-07.md` §10).
// Under all-JIT the standing hadoku-builder count is zero BY DESIGN and stays
// zero forever, so this alert used to fire every 20 minutes while the
// dispatcher minted 9 of 9 queued jobs — the real 2026-09-02 outage was
// indistinguishable from the routine noise. It used to be exempted by a
// mint-aware branch (suppress unless NO ephemeral node could mint one
// either); that branch is gone along with the alert, so the regression this
// pins is stronger than "suppressed while a claw can mint" — it is NEVER
// alerted, in either direction, because `check-queue-health` owns this page
// now. `label floor: a mintable fleet does not excuse pm2-host` right below
// is the control: an IDENTITY label (no mint can substitute for it) still
// pages exactly as before.
test('label floor: hadoku-builder never pages, even when nothing can mint either', async () => {
	// hokon OFFLINE and both claws unreachable/sick: the worst case the retired
	// alert used to catch. If retiring it regressed into "the floor silently
	// covers for a genuinely dead fleet", this is where it would show.
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: {
			'claw-1': { reachable: false, free: 0, sick: false },
			'claw-3': { reachable: true, free: 0, sick: true },
		},
	} as never);
	installFetch({
		runners: {
			runners: [{ name: 'hokon', status: 'offline', busy: false, labels: hokonLabels() }],
		},
	});
	await tick('tok');
	await tick('tok');
	assert.ok(
		!discordPosts.some((p) => /hadoku-builder/.test(p)),
		'hadoku-builder must never page — check-queue-health owns this now'
	);
	// Still MEASURED, just never alerted on — the snapshot/panel keep the count.
	assert.equal(getRunnerHealthSnapshot()?.labelOnline?.['hadoku-builder'], 0);
});

test('label floor: a mintable fleet does not excuse pm2-host, which no mint can carry', async () => {
	// Minting serves only what a minting node OFFERS, and no claw offers
	// pm2-host — it is a fact about the production host. A reachable claw must
	// not be read as covering it.
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: { 'claw-1': { reachable: true, free: 4, sick: false } },
	} as never);
	installFetch({
		runners: { runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }] },
	});
	await tick('tok');
	await tick('tok');
	assert.ok(
		discordPosts.some((p) => /pm2-host/.test(p) && /will queue/.test(p)),
		'pm2-host still pages'
	);
});

// ---------------------------------------------------------------------------
// ONE FLOOR MODEL FOR EVERY LABEL (2026-10-10). A label is served by a
// standing online runner OR by an eligible minting node that offers it —
// `jdk21` and `cargo-bevy` "function the same as other runners". Driven
// against the fixture manifest: claw-3/4/5/8/9 are ephemeral and EARNED jdk21,
// hokon is the standing backstop whose listing below does NOT carry it.
// ---------------------------------------------------------------------------

/** Every ephemeral fixture claw whose bootcamp record earned jdk21. */
const JDK21_CLAWS = ['claw-3', 'claw-4', 'claw-5', 'claw-8', 'claw-9'];
const FIXTURE_NODES = [
	'claw-1',
	'claw-2',
	'claw-3',
	'claw-4',
	'claw-5',
	'claw-6',
	'claw-8',
	'claw-9',
	'hokon',
];

const jdkProof = (node: string, over: Partial<ProofRecord> = {}): ProofRecord => ({
	node,
	capability: 'jdk21',
	runId: 1,
	runner: `jit-${node}-proof-hadoku-cardtable-j0-r0-1`,
	conclusion: 'success',
	durationSec: 300,
	evidenceMatched: true,
	budgetSec: null,
	verdict: 'pass',
	why: 'pass',
	at: new Date().toISOString(),
	...over,
});

/** The probe the fast loop would publish with exactly `up` reachable. */
function probeWith(up: string[]): void {
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: Object.fromEntries(
			FIXTURE_NODES.map((n) => [
				n,
				{ reachable: up.includes(n), free: up.includes(n) ? 2 : 0, sick: false },
			])
		),
	} as never);
}

/** hokon online, carrying everything it declares — and NOT jdk21. */
const hokonOnlyListing = () => ({
	runners: [{ name: 'hokon', status: 'online', busy: false, labels: hokonLabels() }],
});

const jdkPages = () => discordPosts.filter((p) => /`jdk21`/.test(p) && /will queue/.test(p));

test('label floor: a label served ONLY by minting nodes does not page', async () => {
	__setFloorDemandForTesting(['jdk21']);
	__setWorkloadGateContextForTesting(workloadGateContext(FIXTURE_NODES, {}));
	probeWith(['claw-4']);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	await tick('tok');
	await tick('tok');
	assert.deepEqual(jdkPages(), [], 'no standing runner carries jdk21, and claw-4 can mint it');
	assert.equal(getRunnerHealthSnapshot()?.labelOnline?.['jdk21'], 0, 'the standing half is zero');
	assert.equal(getRunnerHealthSnapshot()?.labelFloor?.['jdk21'], 'minting');
});

test('label floor: every minting offerer DRAINED and no standing runner pages', async () => {
	__setFloorDemandForTesting(['jdk21']);
	__setWorkloadGateContextForTesting(workloadGateContext(FIXTURE_NODES, {}));
	probeWith(JDK21_CLAWS);
	writeDrain(
		Object.fromEntries(
			JDK21_CLAWS.map((n) => [n, { since: 's', reason: 'operator', by: 'hadoku' }])
		)
	);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	assert.deepEqual(jdkPages(), [], 'one tick is debounced like every other floor zero');
	await tick('tok');
	const pages = jdkPages();
	assert.equal(pages.length, 1, 'reachable but drained is not mintable');
	assert.match(pages[0], /drained/, 'the page names WHY nothing can mint it');
	assert.equal(getRunnerHealthSnapshot()?.labelFloor?.['jdk21'], 'unserved');
});

test('label floor: an UNMEASURED probe holds — never pages, never counts as served', async () => {
	__setFloorDemandForTesting(['jdk21']);
	__setWorkloadGateContextForTesting(workloadGateContext(FIXTURE_NODES, {}));
	installFetch({ runners: hokonOnlyListing() });
	const drainAll = () =>
		writeDrain(
			Object.fromEntries(
				JDK21_CLAWS.filter((n) => n !== 'claw-4').map((n) => [
					n,
					{ since: 's', reason: 'operator', by: 'hadoku' },
				])
			)
		);

	// 1. Measured, and the only undrained offerer (claw-4) is unreachable: a
	//    real zero. Streak 1.
	drainAll();
	probeWith([]);
	await tick('tok');
	// 2. mgmt-api restarted: the fast loop has not probed yet. claw-4 is not
	//    drained, so minting MIGHT serve it — nobody has looked.
	__setFleetProbeForTesting(null);
	await tick('tok');
	await tick('tok');
	assert.deepEqual(jdkPages(), [], 'unmeasured must not advance the streak into a page');
	assert.equal(getRunnerHealthSnapshot()?.labelFloor?.['jdk21'], 'unmeasured');
	// 3. Measured again, still nothing can serve it. The streak HELD through the
	//    unmeasured ticks rather than resetting, so this second real zero pages.
	probeWith([]);
	await tick('tok');
	assert.equal(jdkPages().length, 1, 'unmeasured must not have cleared the streak either');
});

test('label floor: a claw whose jdk21 workload proof is STALE is not counted as an offerer', async () => {
	__setFloorDemandForTesting(['jdk21']);
	// The gate is ACTIVE (two fresh passes elsewhere) and claw-4 — the only
	// reachable claw — holds a STALE mark: the dispatcher would not mint jdk21
	// there, so the floor must not count it.
	__setWorkloadGateContextForTesting(
		workloadGateContext(FIXTURE_NODES, {
			jdk21: [
				jdkProof('claw-8'),
				jdkProof('claw-9'),
				jdkProof('claw-4', { verdict: 'stale', why: 'marked stale by node-regression' }),
			],
		})
	);
	probeWith(['claw-4']);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	await tick('tok');
	assert.equal(jdkPages().length, 1, 'a stale proof withdraws the offer, so nothing serves jdk21');
	assert.match(jdkPages()[0], /unreachable or sick/, 'claw-8/claw-9 still offer it but are down');
});

test('label floor: the same claw with a FRESH passing proof serves jdk21 (control)', async () => {
	__setFloorDemandForTesting(['jdk21']);
	__setWorkloadGateContextForTesting(
		workloadGateContext(FIXTURE_NODES, {
			jdk21: [jdkProof('claw-8'), jdkProof('claw-9'), jdkProof('claw-4')],
		})
	);
	probeWith(['claw-4']);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	await tick('tok');
	assert.deepEqual(jdkPages(), []);
	assert.equal(getRunnerHealthSnapshot()?.labelFloor?.['jdk21'], 'minting');
});

test('label floor: a label that LEAVES the demand takes its armed alert with it', async () => {
	__setFloorDemandForTesting(['jdk21']);
	__setWorkloadGateContextForTesting(workloadGateContext(FIXTURE_NODES, {}));
	probeWith([]);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	await tick('tok');
	assert.equal(jdkPages().length, 1, 'precondition: jdk21 is paging');
	assert.equal(getRunnerHealthSnapshot()?.floorBreach, true);
	__setFloorDemandForTesting(['pm2-host']);
	await tick('tok');
	assert.equal(getRunnerHealthSnapshot()?.labelFloor?.['jdk21'], undefined, 'no longer watched');
	assert.equal(getRunnerHealthSnapshot()?.floorBreach, false);
});

test('label floor: a label that comes BACK into demand starts a fresh streak and pages again', async () => {
	// Leaving the demand must clear the streak AND re-arm the alert. Kept, the
	// streak would carry over and the hour-long re-alert window would swallow
	// the page when the label returns still unserved.
	__setFloorDemandForTesting(['jdk21']);
	__setWorkloadGateContextForTesting(workloadGateContext(FIXTURE_NODES, {}));
	probeWith([]);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	await tick('tok');
	assert.equal(jdkPages().length, 1, 'precondition: jdk21 paged');
	__setFloorDemandForTesting(['pm2-host']);
	await tick('tok');
	__setFloorDemandForTesting(['jdk21']);
	await tick('tok');
	assert.equal(jdkPages().length, 1, 'one tick back is debounced afresh');
	await tick('tok');
	assert.equal(jdkPages().length, 2, 'and the second pages, because the alert was re-armed');
});

test('label floor: the watched set is job history UNIONED with the persisted static demand', async () => {
	// No override: the real read. taskauto comes only from a job record,
	// cargo-bevy only from the file `fleet label-floor` writes — the label no
	// job in the window asked for, which observed demand alone would miss.
	__setFloorDemandForTesting(null);
	appendFileSync(
		historyFile(),
		JSON.stringify({
			repo: 'WolffM/hadoku-tenhands',
			runId: 1,
			jobId: 1,
			name: 'sweep',
			runner: 'hokon',
			labels: ['self-hosted', 'taskauto'],
			startedAt: minutesAgo(5),
			durationSec: 10,
		}) + '\n'
	);
	const demandFile = join(testStateDir, 'label-floor-demand.json');
	writeFileSync(demandFile, JSON.stringify({ at: minutesAgo(60), labels: ['cargo-bevy'] }));
	try {
		installFetch({ runners: hokonOnlyListing() });
		await tick('tok');
		const watched = Object.keys(getRunnerHealthSnapshot()?.labelFloor ?? {}).sort();
		assert.deepEqual(watched, ['cargo-bevy', 'taskauto']);
	} finally {
		rmSync(demandFile, { force: true });
	}
});

test('label floor: an EMPTY demand pages on its own key rather than watching nothing', async () => {
	__setFloorDemandForTesting([]);
	installFetch({ runners: hokonOnlyListing() });
	await tick('tok');
	assert.ok(
		discordPosts.some((p) => /NOTHING to watch/.test(p)),
		'a floor over an empty set passes every outage'
	);
});

test('runner-health: a ONE-tick label-floor blip does not page', async () => {
	// The 2026-08-20 false alarm: all four hokon runners dropped their broker
	// long-poll for ~10s, so one tick saw zero pm2-host runners while nothing
	// was actually wrong. A single observation must never page.
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
	});
	await tick('tok');
	assert.equal(discordPosts.length, 0, 'a single zero-tick must stay silent');
});

/** The same listing with hokon's `status` flipped — the 2026-09-13 06:13:49Z read. */
const LIVE_LISTING_HOKON_OFFLINE = () => {
	const body = LIVE_LISTING();
	const hokon = body.runners.find((r) => r.name === 'hokon');
	if (!hokon) throw new Error('fixture lost hokon');
	hokon.status = 'offline';
	return body;
};

/** Answer the Nth runner listing of a tick from a different body. */
function listingSequence(...bodies: (() => Record<string, unknown>)[]) {
	let n = 0;
	return () => (bodies[Math.min(n++, bodies.length - 1)] as () => Record<string, unknown>)();
}

test('label floor: the live listing from #24 reports ZERO missing labels', async () => {
	// The regression fixture. hokon online carrying pm2-host, taskauto and
	// av1-nvenc is what `gh api` returns, and the floor must read it as covered
	// — no alert, and a census of 1 for each.
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	await tick('tok');
	assert.deepEqual(discordPosts, [], 'a healthy listing pages nothing');
	const census = getRunnerHealthSnapshot()?.labelOnline;
	assert.equal(census?.['pm2-host'], 1);
	assert.equal(census?.['taskauto'], 1);
	assert.equal(census?.['av1-nvenc'], 1);
});

test('label floor: the listing is read a PAGE AT A TIME big enough to be a census', async () => {
	// GitHub's default page is 30. Every other runner listing in this package
	// asks for 100; this one asked for the default, and a page-one eviction is
	// indistinguishable from a capability that went offline.
	installFetch({ runners: LIVE_LISTING });
	await tick('tok');
	assert.ok(runnerListingUrls.length > 0, 'the floor read the listing at all');
	assert.ok(
		runnerListingUrls.every((u) => u.includes('per_page=100')),
		`every runner listing asks for a full page; got ${runnerListingUrls.join(' | ')}`
	);
});

test('label floor: a status FLAP is not an outage — the confirming read wins (#24)', async () => {
	// 2026-09-12/13. GitHub's broker answered hokon's message long-poll with
	// InternalServerError for hours, and `/actions/runners` reported hokon
	// `offline` on some reads and `online` on others ten minutes apart. It was
	// running jobs throughout: a `redeploy` job completed ON hokon at
	// 06:12:50Z and the 06:13:49Z tick then read `pm2-host=0 hokon:offline`.
	//
	// Eighteen 🚨 went out over eleven hours on that reading. A zero that a
	// second read seconds later contradicts is two answers, not an outage.
	installFetch({ runners: listingSequence(LIVE_LISTING_HOKON_OFFLINE, LIVE_LISTING) });
	await tick('tok');
	installFetch({ runners: listingSequence(LIVE_LISTING_HOKON_OFFLINE, LIVE_LISTING) });
	await tick('tok');
	assert.deepEqual(
		discordPosts.filter((p) => /will queue/.test(p)),
		[],
		'a flapping status field must not page as a capability outage'
	);
});

test('label floor: a zero BOTH reads agree on still pages — retrying is not tolerating', async () => {
	// The control for the test above. hokon is gone in the first read and in the
	// confirming one, so the floor pages exactly as it always has — and the
	// message carries the EVIDENCE it was judged on, because a finding whose
	// reason is missing is a finding nobody can act on.
	installFetch({ runners: LIVE_LISTING_HOKON_OFFLINE });
	await tick('tok');
	await tick('tok');
	const floor = discordPosts.filter((p) => /will queue/.test(p));
	assert.equal(floor.length, 3, 'pm2-host, taskauto and av1-nvenc are all at zero here');
	const pm2 = floor.find((p) => /pm2-host/.test(p));
	assert.ok(pm2, 'the pm2-host breach must be among them');
	assert.match(pm2, /Two reads/, 'the alert says it looked twice');
	assert.match(pm2, /7 registration\(s\)/, 'and how many registrations it saw');
});

test('label floor: a TRUNCATED listing pages as truncated, not as an outage', async () => {
	// `total_count` above what came back means the census is PART of the fleet.
	// A label missing from part of a listing is not a label missing from the
	// fleet — but it is not a clean bill of health either, so it pages on its
	// own key and the per-label streaks are held.
	const partial = () => {
		const body = LIVE_LISTING();
		return { total_count: 41, runners: body.runners.filter((r) => r.name !== 'hokon') };
	};
	installFetch({ runners: partial });
	await tick('tok');
	await tick('tok');
	assert.deepEqual(
		discordPosts.filter((p) => /will queue/.test(p)),
		[],
		'a partial census cannot say a capability is gone'
	);
	const truncated = discordPosts.filter((p) => /PARTIAL/.test(p));
	assert.equal(truncated.length, 1, `exactly one truncation page; got ${discordPosts.join(' | ')}`);
	assert.match(truncated[0] as string, /6 of 41/, 'it names what it saw and what it missed');
});

test('runner-health: label floor recovering before the debounce re-arms it', async () => {
	// Blip, recover, blip again: the counter must RESET on recovery, or two
	// unrelated single-tick blips would add up to a page that never described a
	// real outage.
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
	});
	await tick('tok');
	installFetch({
		runners: {
			runners: [
				{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
				{ name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
			],
		},
	});
	await tick('tok');
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
	});
	await tick('tok');
	assert.equal(discordPosts.length, 0, 'two separate one-tick blips must not sum into an alert');
});

test('runner-health: both labels online + no stuck runs → silent', async () => {
	// hokon is pm2-host only (dynamic model — it carries hadoku-builder only
	// during a full claw outage); claw-1 covers hadoku-builder.
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{
					id: 2,
					name: 'claw-1',
					status: 'online',
					// IDLE, deliberately. This test asserts a healthy fleet is silent, and
					// since 2026-08-23 a fully BUSY claw set is a promote trigger of its
					// own (saturation) — so `busy: true` here would have been asserting
					// the opposite of what the test name claims.
					busy: false,
					labels: clawLabels(),
				},
			],
		},
		runs: {
			workflow_runs: [
				{ display_title: 'fine', created_at: minutesAgo(2), status: 'in_progress', html_url: 'u' },
			],
		},
	});
	await tick('tok');
	assert.equal(discordPosts.length, 0, 'healthy fleet must not alert');
	assert.equal(labelOps.length, 0, 'no label churn when a claw is online');
});

test('runner-health: a run queued past threshold alerts (⏱)', async () => {
	installFetch({
		runners: {
			runners: [
				{
					name: 'hokon',
					status: 'online',
					busy: false,
					labels: hokonPromotedLabels(),
				},
			],
		},
		runs: {
			workflow_runs: [
				{
					display_title: 'Update Packages',
					created_at: minutesAgo(20),
					status: 'queued',
					html_url: 'https://gh/run/1',
				},
			],
		},
	});
	await tick('tok');
	// Count the queued alert specifically: the stub's hokon carries pm2-host
	// without the heavy label, so the backstop also posts a promote note.
	const queuedAlerts = discordPosts.filter((m) => m.includes('⏱'));
	assert.equal(queuedAlerts.length, 1);
	assert.match(queuedAlerts[0]!, /QUEUED/);
	assert.match(queuedAlerts[0]!, /Update Packages/);
});

test('runner-health: a run in-progress past threshold alerts as hung (🚨)', async () => {
	installFetch({
		runners: {
			runners: [
				{
					name: 'hokon',
					status: 'online',
					busy: true,
					labels: hokonPromotedLabels(),
				},
			],
		},
		runs: {
			workflow_runs: [
				{
					display_title: 'Redeploy PM2 Service',
					created_at: minutesAgo(45),
					status: 'in_progress',
					html_url: 'https://gh/run/2',
				},
			],
		},
	});
	await tick('tok');
	// Count the hung alert specifically: the stub's hokon carries pm2-host
	// without the heavy label, so the backstop also posts a promote note.
	const hungAlerts = discordPosts.filter((m) => m.includes('IN-PROGRESS'));
	assert.equal(hungAlerts.length, 1);
	assert.match(hungAlerts[0]!, /IN-PROGRESS/);
	assert.match(hungAlerts[0]!, /hung/);
});

test('runner-health: runner-listing 403 alone does NOT page (no false 0-online alert)', async () => {
	// Only /actions/runners forbidden; /actions/runs readable but empty.
	installFetch({ runnersStatus: 403 });
	await tick('tok');
	assert.equal(
		discordPosts.length,
		0,
		'an unreadable runners API must never become a runner-down page'
	);
});

test('runner-health: graceful degradation — runner-listing forbidden but a queued run still alerts', async () => {
	// Simulates a fine-grained token with Actions:read but no Administration:read.
	// The label-floor check is skipped, but the queued-job safety net still fires.
	installFetch({
		runnersStatus: 403,
		runs: {
			workflow_runs: [
				{
					display_title: 'Update Packages',
					created_at: minutesAgo(20),
					status: 'queued',
					html_url: 'https://gh/run/9',
				},
			],
		},
	});
	await tick('tok');
	assert.equal(discordPosts.length, 1);
	assert.match(discordPosts[0]!, /QUEUED/);
});

test('runner-health: both endpoints unreadable → silent (true fail-soft)', async () => {
	installFetch({ runnersStatus: 403, runsStatus: 500 });
	await tick('tok');
	assert.equal(discordPosts.length, 0, 'a dead API records a failed job but never pages');
	// Asserting only the SILENCE would pass if tick() were a no-op. The tick must
	// still REPORT that it failed, to the surface the daily digest reads.
	const failed = jobSinkPosts.filter((p) => p.status === 'failed');
	assert.equal(
		failed.length,
		1,
		`a dead API must record a FAILED job, got ${JSON.stringify(jobSinkPosts)}`
	);
	assert.equal(failed[0]?.job_name, 'ci:runner-health');
});

/**
 * Suppression must survive a RESTART.
 *
 * `lastAlertAt` was in-memory only, so every mgmt-api restart re-armed every
 * condition and the next tick re-paged all of them. On 2026-08-29 a
 * deploy-heavy session restarted the process six times and one failed unit
 * plus one queued run paged 10 minutes apart repeatedly — each alert correct,
 * the channel unreadable. That is how an alert gets trained away.
 *
 * `__resetRunnerHealthAlertsForTesting` clears the in-memory map the way a
 * restart does, WITHOUT clearing the persisted ledger — which is exactly the
 * situation the fix exists for.
 */
void test('runner-health: a restart does not re-page a condition already alerted', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
	});
	await tick('tok');
	await tick('tok'); // breach confirmed — alerts here
	const afterAlert = discordPosts.length;
	assert.ok(afterAlert > 0, 'the breach must alert once confirmed');

	// Simulate the restart: in-memory suppression gone, ledger on disk intact.
	__resetRunnerHealthAlertsForTesting();
	__reloadAlertLedgerForTesting();
	discordPosts.length = 0;

	await tick('tok');
	await tick('tok');
	assert.equal(
		discordPosts.length,
		0,
		'the same unchanged condition must stay suppressed across a restart'
	);
});

test('runner-health: same condition does not re-alert within the suppression window', async () => {
	installFetch({
		runners: {
			runners: [{ name: 'claw-1', status: 'online', busy: false, labels: clawLabels() }],
		},
	});
	// The floor DEBOUNCES: nothing pages until a breach has been seen on two
	// consecutive ticks, so the alerts land on the second one. Capturing the
	// count after the first tick reads 0 and measures the debounce rather than
	// the suppression window.
	await tick('tok');
	await tick('tok'); // breach confirmed — this is where it alerts
	const afterAlert = discordPosts.length;
	assert.ok(afterAlert > 0, 'the breach must alert once confirmed');
	await tick('tok'); // same breach again
	// Suppression is per CONDITION, and this claws-only fixture breaches every
	// capability hokon offers — so the assertion is that the count does not GROW,
	// not that it equals one. Pinning the total would pin the size of
	// REQUIRED_LABELS into a test about the suppression window.
	assert.equal(discordPosts.length, afterAlert, 'a repeated breach must not re-alert');
	assert.ok(
		discordPosts.some((p) => /pm2-host/.test(p)),
		'the pm2-host breach is among them'
	);
});
