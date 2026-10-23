import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
	runDispatchPass,
	byPriority,
	getDispatchAffinitySnapshot,
	heavyMarkedRecently,
	HEAVY_MARK_MS,
	__resetHeavyMarksForTesting,
	__resetAffinityCountersForTesting,
	__resetReapClockForTesting,
	type DispatchPassInput,
} from '../runners/dispatch-pass.js';
import { buildFleetReport } from '../routes/fleet.js';
import { getCapacityLedger } from '../runners/capacity-ledger.js';
import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';
import {
	REAP_INTERVAL_MS,
	REAP_IDLE_INTERVAL_MS,
	JIT_REAP_GRACE_MS,
} from '../runners/ephemeral-exec.js';
import type { NodeState } from '../runners/placement.js';
import type { HeavyModel } from '../runners/traffic.js';
import type { PendingRun } from '../runners/dispatcher.js';
import { fakeGh, fakeShell } from './helpers/fleet-fakes.js';

// The reap clock is module state shared by every pass in this process. Without
// this, the first test's sweep gates the rest and they assert against a sweep
// that never ran.
beforeEach(() => {
	__resetReapClockForTesting();
	__resetHeavyMarksForTesting();
	__resetAffinityCountersForTesting();
});
// A test below swaps in a recording logger; put the silent one back.
afterEach(() => __setHostForTesting(testHost));

const node = (name: string, over: Partial<NodeState> = {}): NodeState => ({
	name,
	healthy: true,
	eligible: true,
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 2,
	freeMb: 9000,
	requiredMb: 900,
	minFreeMb: 1536,
	...over,
});
const run = (id: number) => ({
	id,
	repo: 'WolffM/hadoku-meet',
	repository: { full_name: 'WolffM/hadoku-meet' },
	head_repository: { full_name: 'WolffM/hadoku-meet', fork: false },
	event: 'push',
	jobId: id * 100,
});
const base = (over: Partial<DispatchPassInput> = {}): DispatchPassInput => ({
	order: ['claw-2'],
	nodes: [node('claw-2')],
	pending: [run(1)],
	labelsFor: () => ['hadoku-builder'],
	homeDir: '/home/hadoku',
	memoryMaxMbFor: () => 3000,
	ttlSeconds: 900,
	...over,
});

function harness(existingUnits: string[] = []) {
	const gh = fakeGh();
	const sh = fakeShell({ units: existingUnits });
	// `minted` was a second list of the same writes the fake already records.
	return {
		get minted() {
			return gh.writes.filter((w) => w.includes('generate-jitconfig'));
		},
		sh,
		gh,
	};
}

test('a fleet with no ephemeral nodes does nothing at all', async () => {
	// The inert case, which is every fleet today. Must cost nothing and touch
	// neither GitHub nor a node.
	const h = harness();
	const r = await runDispatchPass(base({ order: [] }), 'tok', h.gh, h.sh);
	assert.deepEqual(r, { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 });
	assert.equal(h.minted.length, 0);
});

test('nothing queued means nothing minted', async () => {
	const h = harness();
	const r = await runDispatchPass(base({ pending: [] }), 'tok', h.gh, h.sh);
	assert.equal(r.minted, 0);
	assert.equal(h.minted.length, 0);
});

test('a queued run gets a runner', async () => {
	const h = harness();
	const r = await runDispatchPass(base(), 'tok', h.gh, h.sh);
	assert.equal(r.minted, 1);
	assert.equal(h.minted.length, 1);
});

test('units already on the node count against the cap', async () => {
	// B9's real shape: after an mgmt-api restart the only truth about what is in
	// flight lives on the nodes. Without this the first tick back would mint a
	// second runner for work already being served.
	const h = harness(['jit-claw-2-hadoku-meet-1787797000', 'jit-claw-2-hadoku-meet-1787797001']);
	const r = await runDispatchPass(base({ pending: [run(1), run(2)] }), 'tok', h.gh, h.sh);
	assert.equal(r.inFlight, 2, 'both pre-existing units are seen');
	assert.equal(r.minted, 0, 'maxConcurrent 2 is already consumed by them');
	assert.equal(h.minted.length, 0, 'no registration may be created');
});

test('capacity still binds across the pass', async () => {
	const h = harness();
	const r = await runDispatchPass(
		base({ pending: [run(1), run(2), run(3)], nodes: [node('claw-2')] }),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 2, 'maxConcurrent 2');
	assert.equal(r.skipped, 1);
});

test('one failing node does not stop the pass', async () => {
	// Fail toward promotion: a failed mint is a promotion that did not happen,
	// and the tier above absorbs it.
	//
	// claw-2 and claw-1 start EQUALLY busy, so job 1 plans onto claw-2 (first in
	// `order`) — but `planTick` raises claw-2's busy count for that placement
	// BEFORE job 2 is planned (#102.2: same-tick re-rank), so job 2 spreads to
	// the still-idle claw-1 rather than piling onto the same node claw-2's own
	// failure has nothing to do with. That is the fix, not a side effect: a
	// failing node must not be tried twice in the same tick just because it
	// came first, any more than a busy-but-healthy one should.
	const h = harness();
	const sh = async (node: string, cmd: string) => {
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		if (cmd.includes('list-units')) return '';
		if (node === 'claw-2' && cmd.includes('jit-provision')) return 'SLOT-FAIL broken';
		if (cmd.includes('jit-provision')) return 'SLOT-READY /home/hadoku/.hadoku/jit/slot0 2.336.0';
		return 'Running as unit: x.service';
	};
	const r = await runDispatchPass(
		base({
			order: ['claw-2', 'claw-1'],
			nodes: [node('claw-2'), node('claw-1')],
			pending: [run(1), run(2)],
		}),
		'tok',
		h.gh,
		sh
	);
	assert.equal(r.failed, 1, 'only job 1 ever reaches the broken claw-2');
	assert.equal(r.minted, 1, 'job 2 spreads to claw-1 instead of retrying the same node');
});

/**
 * The two defects that made this file's own documented guarantees vacuous. Both
 * were live until 2026-08-29 and neither had a test — which is how a section
 * written to prevent §12.16 came to reproduce it.
 */
test('a run already served by a LIVE unit is not minted for again', async () => {
	const h = harness(['jit-claw-2-hadoku-meet-r1-1787797008']);
	// maxConcurrent is deliberately generous. At the default of 2 this test
	// PASSED with inFlightRunIds empty, because the live unit consumed capacity
	// and the second mint was refused for being at the cap — the right counts for
	// the wrong reason, which is a test that cannot fail. Caught by mutation.
	const r = await runDispatchPass(
		base({
			pending: [run(1), run(2)],
			nodes: [node('claw-2', { maxConcurrent: 5 })],
		}),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.inFlight, 1, 'the live unit is seen');
	assert.equal(r.skipped, 1, 'run 1 is already in flight and must be skipped');
	assert.equal(r.minted, 1, 'only run 2 is minted');
});

test('a mint never reuses a slot that is serving a job — RESET=1 would wipe it', async () => {
	const slotsUsed: number[] = [];
	const sh = async (_h: string, cmd: string) => {
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		// A live listener occupying slot 0, read from the process tree.
		if (cmd.includes('pgrep'))
			return '4242 /home/hadoku/.hadoku/jit/slot0/bin/Runner.Listener run --jitconfig x\n';
		if (cmd.includes('list-units')) return '';
		const m = /SLOT=(\d+)/.exec(cmd);
		if (m) {
			slotsUsed.push(Number(m[1]));
			return 'SLOT-READY /home/hadoku/.hadoku/jit/slot' + m[1] + ' 2.336.0';
		}
		return 'Running as unit: x.service';
	};
	const h = harness();
	await runDispatchPass(base({ pending: [run(1)] }), 'tok', h.gh, sh);
	assert.ok(slotsUsed.length > 0, 'the mint must have provisioned a slot');
	assert.ok(!slotsUsed.includes(0), `slot 0 is busy; mint used ${JSON.stringify(slotsUsed)}`);
});

test('two mints in one pass take different slots', async () => {
	const slotsUsed: number[] = [];
	const sh = async (_h: string, cmd: string) => {
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		if (cmd.includes('pgrep')) return '';
		if (cmd.includes('list-units')) return '';
		const m = /SLOT=(\d+)/.exec(cmd);
		if (m) {
			slotsUsed.push(Number(m[1]));
			return 'SLOT-READY /home/hadoku/.hadoku/jit/slot' + m[1] + ' 2.336.0';
		}
		return 'Running as unit: x.service';
	};
	const h = harness();
	await runDispatchPass(base({ pending: [run(1), run(2)] }), 'tok', h.gh, sh);
	assert.equal(
		new Set(slotsUsed).size,
		slotsUsed.length,
		`slots collided: ${JSON.stringify(slotsUsed)}`
	);
});

test('a quiet fleet still sweeps — orphans accumulate precisely when nothing is queued', async () => {
	const swept: string[] = [];
	const sh = async (_m: string, cmd: string) => {
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		if (cmd.includes('echo REACHABLE')) return 'REACHABLE';
		if (cmd.includes('list-units')) return '';
		return '';
	};
	const gh = {
		get: async () => ({ runners: [{ id: 5, name: 'jit-claw-2-hadoku-meet-r9-1000000000' }] }),
		write: async (_m: 'POST' | 'DELETE', p: string) => {
			swept.push(p);
			return { ok: true, status: 204 };
		},
	};
	const r = await runDispatchPass(
		base({ pending: [], repos: ['WolffM/hadoku-meet'] }),
		'tok',
		gh,
		sh
	);
	assert.equal(r.minted, 0, 'nothing to dispatch');
	assert.equal(r.reaped, 1, 'but the orphan is still cleared');
	assert.deepEqual(swept, ['/actions/runners/5']);
});

/**
 * THE REAP CADENCE.
 *
 * The sweep costs one runner listing per repo — conditional since 2026-10-16,
 * but charged whenever the listing changed, so the ceiling is the bound. It rode the
 * ladder's 60s tick (1,620 calls/hr across 27 repos, fine) until the dispatcher
 * moved to its own 15s timer, which quadrupled it to 6,480/hr against a
 * 5,000/hr budget without anything in the change touching the sweep.
 *
 * Measured 2026-09-06: `remaining: 0` at ~:13 past every hour, no polling or
 * minting until the reset at ~:33. These pin the sweep to its own clock so the
 * dispatcher can be made faster again without dragging it along.
 */
const RUNNER_LIST = '/actions/runners?per_page=100';
const REPOS = ['WolffM/a', 'WolffM/b', 'WolffM/c'];

test('the reap sweeps on the first pass, then not again on the next tick', async () => {
	const h = harness();
	const t0 = 1_787_797_008_000;

	await runDispatchPass(base({ repos: REPOS, pending: [], nowMs: t0 }), 'tok', h.gh, h.sh);
	const first = h.gh.reads.filter((r) => r === RUNNER_LIST).length;
	assert.equal(first, REPOS.length, 'one listing per repo');

	// The dispatcher ticks every 15s. The reap must not.
	await runDispatchPass(base({ repos: REPOS, pending: [], nowMs: t0 + 15_000 }), 'tok', h.gh, h.sh);
	assert.equal(
		h.gh.reads.filter((r) => r === RUNNER_LIST).length,
		first,
		'a second sweep 15s later is what exhausted the budget'
	);
});

test('the reap resumes once its own interval has passed — for a repo holding JIT', async () => {
	// The active half of #116: a repo whose listing shows a `jit-*` name is
	// re-listed every sweep, exactly as before, because that is where orphans are.
	const t0 = 1_787_797_008_000;
	const gh = fakeGh({ runners: [{ id: 9, name: `jit-claw-2-a-r1-${t0 / 1000}` }] });
	const sh = fakeShell({ units: [`jit-claw-2-a-r1-${t0 / 1000}`] });
	await runDispatchPass(base({ repos: REPOS, pending: [], nowMs: t0 }), 'tok', gh, sh);
	await runDispatchPass(
		base({ repos: REPOS, pending: [], nowMs: t0 + REAP_INTERVAL_MS }),
		'tok',
		gh,
		sh
	);
	assert.equal(
		gh.reads.filter((r) => r === RUNNER_LIST).length,
		REPOS.length * 2,
		'gating must not become never sweeping — orphans hang jobs'
	);
});

/**
 * #116. The sweep's per-pass cost grew with the ROSTER: 30 repos x 60/hr =
 * 1,800 calls an hour, ~1,350 of the 2026-10-16 18:30-19:15Z window that ended
 * in the fourth blackout in six days — almost all of them listing repos that
 * had nothing a sweep could find.
 */
function rosterGh(roster: string[]) {
	/** repo -> its registrations, mutable so a test can mint and reap. */
	const regs = new Map<string, { id: number; name: string; busy?: boolean }[]>(
		roster.map((r) => [r, []])
	);
	const listedBy = new Map<string, number>();
	const unreadable = new Set<string>();
	const gh = {
		reads: [] as string[],
		writes: [] as string[],
		get: async (path: string, _t?: string, repo = '') => {
			gh.reads.push(path);
			if (path === RUNNER_LIST) {
				listedBy.set(repo, (listedBy.get(repo) ?? 0) + 1);
				if (unreadable.has(repo)) return null;
				return { runners: (regs.get(repo) ?? []).map((r) => ({ ...r, status: 'online' })) };
			}
			return { workflow_runs: [], jobs: [] };
		},
		write: async (
			method: 'POST' | 'DELETE',
			path: string,
			_t?: string,
			_b?: unknown,
			repo = ''
		) => {
			gh.writes.push(path);
			const id = /\/actions\/runners\/(\d+)$/.exec(path);
			if (method === 'DELETE' && id)
				regs.set(
					repo,
					(regs.get(repo) ?? []).filter((r) => r.id !== Number(id[1]))
				);
			return { ok: true, status: 204 };
		},
	};
	return { gh, regs, listedBy, unreadable };
}

const ROSTER = Array.from({ length: 30 }, (_, i) => `WolffM/repo-${i}`); // coveredRepos(), 2026-10-16
const HOUR_MS = 3_600_000;
const DISPATCH_TICK_MS = 15_000;

async function driveHour(
	h: ReturnType<typeof rosterGh>,
	t0: number,
	each?: (nowMs: number) => void
): Promise<void> {
	const sh = fakeShell();
	for (let t = t0; t < t0 + HOUR_MS; t += DISPATCH_TICK_MS) {
		each?.(t);
		await runDispatchPass(base({ repos: ROSTER, pending: [], nowMs: t }), 'tok', h.gh, sh);
	}
}

test('an idle repo is NOT listed every sweep — the reap scales with mints, not the roster', async () => {
	const h = rosterGh(ROSTER);
	const t0 = 1_787_797_008_000;
	await driveHour(h, t0);
	const listings = h.gh.reads.filter((r) => r === RUNNER_LIST).length;
	const perRepo = HOUR_MS / REAP_IDLE_INTERVAL_MS; // 12
	assert.equal(
		listings,
		ROSTER.length * perRepo,
		`an idle hour must cost ${ROSTER.length} x ${perRepo} listings, not one per repo per minute (${listings})`
	);
	assert.ok(listings < 5000 * 0.1, 'an idle fleet spends under 10% of the budget on the reap');
});

test('a busy repo is walked every sweep while it holds JIT, and only it', async () => {
	const h = rosterGh(ROSTER);
	const t0 = 1_787_797_008_000;
	const busy = ROSTER[7];
	// A registration that is live the whole hour (its unit answers), so it is
	// kept every sweep and the repo stays active.
	h.regs.set(busy, [{ id: 1, name: `jit-claw-2-repo-7-r1-${t0 / 1000}`, busy: true }]);
	await driveHour(h, t0);
	assert.equal(h.listedBy.get(busy), HOUR_MS / REAP_INTERVAL_MS, 'every minute, as before #116');
	assert.equal(h.listedBy.get(ROSTER[0]), HOUR_MS / REAP_IDLE_INTERVAL_MS);
	const total = h.gh.reads.filter((r) => r === RUNNER_LIST).length;
	assert.equal(total, 29 * 12 + 60);
});

test('a mint to an idle repo puts it in the very next sweep', async () => {
	const h = rosterGh(ROSTER);
	const t0 = 1_787_797_008_000;
	const sh = fakeShell();
	await runDispatchPass(base({ repos: ROSTER, pending: [], nowMs: t0 }), 'tok', h.gh, sh);
	// One mint to repo-3 at t0+20s; the next sweep is t0+60s.
	await runDispatchPass(
		base({
			repos: ROSTER,
			pending: [{ ...run(1), repo: ROSTER[3] }],
			nowMs: t0 + 20_000,
		}),
		'tok',
		h.gh as never,
		sh
	);
	const before = h.listedBy.get(ROSTER[3]);
	await runDispatchPass(
		base({ repos: ROSTER, pending: [], nowMs: t0 + REAP_INTERVAL_MS }),
		'tok',
		h.gh,
		sh
	);
	assert.equal(h.listedBy.get(ROSTER[3]), (before ?? 0) + 1, 'minted-to repo listed');
	assert.equal(h.listedBy.get(ROSTER[4]), 1, 'an untouched idle repo still waits');
});

test('a listing that could not be read keeps the repo due — "could not look" never cleans it', async () => {
	const h = rosterGh(ROSTER);
	const t0 = 1_787_797_008_000;
	const sh = fakeShell();
	h.unreadable.add(ROSTER[5]);
	await runDispatchPass(base({ repos: ROSTER, pending: [], nowMs: t0 }), 'tok', h.gh, sh);
	await runDispatchPass(
		base({ repos: ROSTER, pending: [], nowMs: t0 + REAP_INTERVAL_MS }),
		'tok',
		h.gh,
		sh
	);
	assert.equal(h.listedBy.get(ROSTER[5]), 2, 'retried on the next sweep');
	assert.equal(h.listedBy.get(ROSTER[6]), 1, 'a READ idle repo waits');
});

test('an orphan minted OUTSIDE this process is still reaped at grace + one sweep', async () => {
	// The reason REAP_IDLE_INTERVAL_MS is bounded by the grace: `fleet prove-job`
	// mints from the CLI and this process never hears of it. `fleet identity`'s
	// UNREAPED_AFTER_MS (grace + two sweeps) fails the gate past that.
	assert.ok(
		REAP_IDLE_INTERVAL_MS + REAP_INTERVAL_MS <= JIT_REAP_GRACE_MS,
		'an idle repo must be listed before an outside mint there leaves its grace'
	);
	const h = rosterGh(ROSTER);
	const t0 = 1_787_797_008_000;
	const target = ROSTER[11];
	let mintedAt = 0;
	let reapedAt = 0;
	await driveHour(h, t0, (now) => {
		// Just after repo-11's first listing, so the idle wait is at its longest.
		if (!mintedAt && now >= t0 + 15_000) {
			mintedAt = now;
			h.regs.set(target, [{ id: 77, name: `jit-claw-9-repo-11-r5-${Math.floor(now / 1000)}` }]);
		}
		if (mintedAt && !reapedAt && !(h.regs.get(target) ?? []).length) reapedAt = now;
	});
	assert.ok(reapedAt, 'reaped');
	assert.ok(
		reapedAt - mintedAt <= JIT_REAP_GRACE_MS + 2 * REAP_INTERVAL_MS,
		`reaped ${(reapedAt - mintedAt) / 60_000} min after the mint`
	);
});

test('a pass that did not sweep reports null, NOT zero orphans', async () => {
	// "I could not look" must never render as "nothing is wrong". `reaped=0` on
	// every tick is exactly how a sweep that stopped running goes unnoticed.
	const h = harness();
	const t0 = 1_787_797_008_000;
	const swept = await runDispatchPass(
		base({ repos: REPOS, pending: [], nowMs: t0 }),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(swept.reaped, 0, 'it did look, and found nothing');
	const skipped = await runDispatchPass(
		base({ repos: REPOS, pending: [], nowMs: t0 + 15_000 }),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(skipped.reaped, null, 'it did not look');
});

// --- the viaAffinity counter (W §5e) -------------------------------------

/** The line W's re-cut greps. Kept byte-identical to the §5e command's regex. */
const RECUT_LINE =
	/\[dispatch\] minted=(\d+) failed=\d+ in-flight=\d+ via-affinity=(\d+) affinity-moved=(\d+) /;

function recordInfos(): string[] {
	const infos: string[] = [];
	__setHostForTesting({
		...testHost,
		logger: {
			info: (m: string) => void infos.push(m),
			warn: () => undefined,
			error: () => undefined,
		},
	});
	return infos;
}

/** claw-2 is first in the order and cold; claw-1 holds the warm listener. */
const warmSecond = (): Partial<DispatchPassInput> => ({
	order: ['claw-2', 'claw-1'],
	nodes: [node('claw-2'), node('claw-1', { warmRepo: 'WolffM/hadoku-meet' })],
	pending: [run(1), run(2), run(3)],
});

test('the pass counts mints the affinity term moved, logs them per pass, and serves them on GET /fleet', async () => {
	const infos = recordInfos();
	const h = harness();
	// Two land on warm claw-1 (maxConcurrent 2) that plain ordering would have
	// sent to claw-2; the third overflows to claw-2, which is neither.
	const r = await runDispatchPass(base(warmSecond()), 'tok', h.gh, h.sh);
	assert.equal(r.minted, 3);

	const line = infos.find((i) => RECUT_LINE.test(i));
	assert.ok(line, `no re-cut line among:\n  ${infos.join('\n  ')}`);
	assert.deepEqual(RECUT_LINE.exec(line)!.slice(1), ['3', '2', '2']);
	assert.match(
		line,
		/ total-minted=3 total-via-affinity=2 total-affinity-moved=2 heavy=0 heavy-on-busy=0 placed=/
	);

	// A second pass: the per-pass fields restart, the totals accumulate.
	infos.length = 0;
	await runDispatchPass(
		base({ ...warmSecond(), pending: [run(4)] }),
		'tok',
		harness().gh,
		harness().sh
	);
	assert.deepEqual(RECUT_LINE.exec(infos.find((i) => RECUT_LINE.test(i))!)!.slice(1), [
		'1',
		'1',
		'1',
	]);

	const want = { minted: 4, mintedViaAffinity: 3, mintedAffinityMoved: 3 };
	assert.deepEqual(getDispatchAffinitySnapshot().totals, want);
	assert.deepEqual(
		{ ...getDispatchAffinitySnapshot().lastPass, at: undefined },
		{ at: undefined, minted: 1, mintedViaAffinity: 1, mintedAffinityMoved: 1 }
	);
	const report = buildFleetReport(
		null,
		null,
		{},
		{
			since: null,
			total: 0,
			byMachine: [],
			byRepo: [],
			daily: [],
			backstopJobs: 0,
			backstopShare: 0,
			recent: [],
			recentSince: '2026-09-18T00:00:00.000Z',
			recentWindowSec: 3600,
		}
	);
	assert.deepEqual(report.dispatch.affinity.totals, want);
});

// --- #102.4: "say what the rule did" — the dispatch log's own report -------

test('#102.4: a heavy job that must place on a busy node (no idle one exists) logs heavy-on-busy=1', async () => {
	const infos = recordInfos();
	const h = harness();
	const heavyModel: HeavyModel = {
		isHeavy: (repo, jobName) => repo === 'WolffM/hadoku-cardtable' && jobName === 'forge-e2e',
		isHeavyRepo: (repo) => repo === 'WolffM/hadoku-cardtable',
	};
	// The ONLY candidate, and it is already running one job — no idle node
	// exists, so the heavy job still places (never queues forever, #102.4),
	// and the log must say so.
	const busyNode = node('claw-1', { liveUnits: 1, maxConcurrent: 3, heavyModel });
	const heavyRun: PendingRun = {
		id: 1,
		jobId: 100,
		repo: 'WolffM/hadoku-cardtable',
		jobName: 'forge-e2e',
		repository: { full_name: 'WolffM/hadoku-cardtable' },
		head_repository: { full_name: 'WolffM/hadoku-cardtable', fork: false },
		event: 'push',
	};
	const r = await runDispatchPass(
		base({ order: ['claw-1'], nodes: [busyNode], pending: [heavyRun] }),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 1, 'a heavy job still places even with no idle node');
	const line = infos.find((i) => i.startsWith('[dispatch] minted='));
	assert.ok(line, `no dispatch line among:\n  ${infos.join('\n  ')}`);
	assert.match(line!, /heavy=1 heavy-on-busy=1 placed=claw-1@1$/);
});

test("#102 REPLAY 2026-10-08 22:08:09Z: a warm listener's running shard counts as busy AND heavy, so claw-4 takes nothing more", async () => {
	const infos = recordInfos();
	const h = harness();
	const CT = 'WolffM/hadoku-cardtable';
	const heavyModel: HeavyModel = {
		isHeavy: (repo, jobName) => repo === CT && /^forge-(jvm|e2e)/.test(jobName ?? ''),
		isHeavyRepo: (repo) => repo === CT,
	};
	const nowMs = Date.parse('2026-10-08T22:08:09Z');
	const job = (jobId: number, jobName: string): PendingRun => ({
		id: 37851403985,
		jobId,
		repo: CT,
		jobName,
		jobCreatedAt: '2026-10-08T22:07:57Z',
		repository: { full_name: CT },
		head_repository: { full_name: CT, fork: false },
		event: 'push',
	});
	// The probe's view: claw-4 idle (stale — its warm listener took forge-e2e (3)
	// at 22:07:58), claw-8 running cardtable `check` (light), claw-9 idle.
	const nodes = [
		node('claw-4', { maxConcurrent: 4, warmRepo: CT, heavyModel }),
		node('claw-8', {
			maxConcurrent: 4,
			standingBusy: 1,
			runningHeavy: true,
			warmRepo: CT,
			heavyModel,
		}),
		node('claw-9', { maxConcurrent: 4, heavyModel }),
	];
	const r = await runDispatchPass(
		base({
			order: ['claw-4', 'claw-8', 'claw-9'],
			nodes,
			pending: [job(1, 'forge-e2e (2)'), job(2, 'forge-jvm'), job(3, 'forge-e2e (1)')],
			runningJobs: [{ repo: CT, runner: 'warm-claw-4-hadoku-cardtable', jobName: 'forge-e2e (3)' }],
			nowMs,
		}),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 2, 'two shards place; the third holds for a node with no Forge job');
	const line = infos.find((i) => i.startsWith('[dispatch] minted='));
	assert.ok(line, `no dispatch line among:\n  ${infos.join('\n  ')}`);
	assert.doesNotMatch(line!, /claw-4@/, 'nothing lands beside the running shard');
	assert.match(line!, /placed=claw-9@0,claw-8@1$/);
	// REVERTED (no runningJobs): placed=claw-4@0,claw-4@1,claw-9@... — the incident.
});

test('#102: a JIT sibling is in liveUnits already, so it raises heavyJobs but not standingBusy', async () => {
	const infos = recordInfos();
	const h = harness(['jit-claw-4-hadoku-cardtabl-j7-r9-1791497283']);
	const CT = 'WolffM/hadoku-cardtable';
	const heavyModel: HeavyModel = {
		isHeavy: (repo, jobName) => repo === CT && jobName === 'forge-e2e (3)',
		isHeavyRepo: (repo) => repo === CT,
	};
	const r = await runDispatchPass(
		base({
			order: ['claw-4'],
			nodes: [node('claw-4', { maxConcurrent: 4, heavyModel })],
			pending: [run(1)],
			runningJobs: [
				{
					repo: CT,
					runner: 'jit-claw-4-hadoku-cardtabl-j7-r9-1791497283',
					jobName: 'forge-e2e (3)',
				},
			],
		}),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 1);
	const line = infos.find((i) => i.startsWith('[dispatch] minted='));
	assert.match(line!, /placed=claw-4@1$/, 'busy 1 (the unit), not 2');
});

test("2026-10-21: a running JIT job is ONE job — its unit, not its unit plus the probe's worker", async () => {
	// claw-1 as the probe and the unit listing saw it: one JIT job running, so
	// one live unit AND one Runner.Worker (`standingBusy: 1` is `p.workers`).
	// Budget 2 (maxConcurrent 3 less the held listener). Before the fix this
	// read `at capacity: 2/2 in flight` and minted nothing all afternoon.
	const infos = recordInfos();
	const h = harness(['jit-claw-1-hadoku-meet-j5-r9-1792560000']);
	const r = await runDispatchPass(
		base({
			order: ['claw-1'],
			nodes: [node('claw-1', { maxConcurrent: 2, standingBusy: 1, warmHeld: 1 })],
			pending: [run(1), run(2)],
		}),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.inFlight, 1, 'the unit is seen once');
	assert.equal(r.minted, 1, 'one slot of the budget is genuinely free');
	const line = infos.find((i) => i.startsWith('[dispatch] minted='));
	assert.match(line!, /placed=claw-1@1$/, 'busy 1: the one job, counted once');
	// THE LEDGER says the same, in numbers the panel and runner-health read.
	const entry = getCapacityLedger()?.nodes.find((n) => n.node === 'claw-1');
	assert.deepEqual(
		entry,
		{
			node: 'claw-1',
			liveUnits: 1,
			probeWorkers: 1,
			standingBusy: 0,
			warmHeld: 1,
			budget: 2,
			inFlight: 1,
			ok: true,
			why: null,
		},
		'in flight 1/2, invariant intact'
	);
	assert.ok(!infos.some((i) => i.includes('CAPACITY INVARIANT')), 'nothing to warn about');
});

test('2026-10-21: the ledger holds through the 2026-10-08 replay — a stale probe plus a warm sibling is observed, not double counted', async () => {
	// claw-4: probe says idle (workers 0), the job listing says its warm
	// listener (no slot held in this fixture) took a shard. Charged 1 as a
	// standing job; observed running is 1 from the listing. 1 <= max(0, 1).
	const h = harness();
	const CT = 'WolffM/hadoku-cardtable';
	await runDispatchPass(
		base({
			order: ['claw-4'],
			nodes: [node('claw-4', { maxConcurrent: 1 })],
			pending: [run(1)],
			runningJobs: [{ repo: CT, runner: 'warm-claw-4-hadoku-cardtable', jobName: 'forge-e2e (3)' }],
		}),
		'tok',
		h.gh,
		h.sh
	);
	const entry = getCapacityLedger()?.nodes.find((n) => n.node === 'claw-4');
	assert.equal(entry?.inFlight, 1);
	assert.equal(entry?.probeWorkers, 1, 'the listing is an observation too');
	assert.equal(entry?.ok, true, entry?.why ?? '');
});

test('2026-10-21: a held warm listener that is BUSY is not charged again — its slot left the budget already', async () => {
	// claw-3 as seen at 05:40Z: one JIT job, the hadoku_site listener busy.
	// `p.workers` = 2. Budget 2 (3 less the held listener). It read
	// `at capacity: 3/2 in flight`; the box was running two of its three.
	const infos = recordInfos();
	const h = harness(['jit-claw-3-hadoku-meet-j5-r9-1792560000']);
	const r = await runDispatchPass(
		base({
			order: ['claw-3'],
			nodes: [node('claw-3', { maxConcurrent: 2, standingBusy: 2, warmHeld: 1 })],
			pending: [run(1)],
			runningJobs: [
				{ repo: 'WolffM/hadoku_site', runner: 'warm-claw-3-hadoku_site', jobName: 'build' },
			],
		}),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 1, 'the third slot is the one free one');
	const line = infos.find((i) => i.startsWith('[dispatch] minted='));
	// The RANK still sees the listener's job as load: unit 1 + warm 1.
	assert.match(line!, /placed=claw-3@2$/, 'busy 2 for ranking, 1 for admission');
});

test('2026-10-21: a STANDING sibling on a node with no held listener still counts in full', async () => {
	// hokon's shape: a standing deploy runner busy, no JIT units, nothing held.
	// `p.workers` = 1 and the sibling listing names it; neither is subtracted.
	const h = harness();
	const r = await runDispatchPass(
		base({
			order: ['hokon'],
			nodes: [node('hokon', { maxConcurrent: 1, standingBusy: 1 })],
			pending: [run(1)],
			runningJobs: [
				{ repo: 'WolffM/hadoku_site', runner: 'hokon-hadoku_site', jobName: 'redeploy' },
			],
		}),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 0, 'the one slot is taken by the standing job');
});

test('#102: the dispatch log reports the real per-mint busy across a same-tick burst — placed=', async () => {
	// The exact #102 incident, made visible: claw-9 holds cardtable's warm
	// listener; claw-3/4/8 are idle. Three queued cardtable jobs must spread,
	// not stack on claw-9 — and the log must show the busy each one actually
	// chose at.
	const infos = recordInfos();
	const h = harness();
	const REPO = 'WolffM/hadoku-cardtable';
	const warmClaw9 = node('claw-9', { warmRepo: REPO, maxConcurrent: 3 });
	const idle3 = node('claw-3', { maxConcurrent: 3 });
	const idle4 = node('claw-4', { maxConcurrent: 3 });
	const idle8 = node('claw-8', { maxConcurrent: 3 });
	const mkRun = (id: number): PendingRun => ({
		id,
		jobId: id * 100,
		repo: REPO,
		repository: { full_name: REPO },
		head_repository: { full_name: REPO, fork: false },
		event: 'push',
	});
	const r = await runDispatchPass(
		base({
			order: ['claw-9', 'claw-3', 'claw-4', 'claw-8'],
			nodes: [warmClaw9, idle3, idle4, idle8],
			pending: [mkRun(1), mkRun(2), mkRun(3)],
		}),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 3);
	const line = infos.find((i) => i.startsWith('[dispatch] minted='));
	assert.ok(line, `no dispatch line among:\n  ${infos.join('\n  ')}`);
	// claw-9 wins the first job on the affinity tie (every node idle, busy 0);
	// the next two spread to the still-idle claws instead of stacking back
	// onto claw-9 — this is the busy picture, printed.
	assert.match(line!, /placed=claw-9@0,claw-3@0,claw-4@0$/);
});

test('a FAILED mint on the warm node credits the term with nothing', async () => {
	// The tier above served that job, not the warm listener.
	const infos = recordInfos();
	const h = harness();
	const sh = async (n: string, cmd: string) => {
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		if (cmd.includes('list-units')) return '';
		if (n === 'claw-1' && cmd.includes('jit-provision')) return 'SLOT-FAIL broken';
		if (cmd.includes('jit-provision')) return 'SLOT-READY /home/hadoku/.hadoku/jit/slot0 2.336.0';
		return 'Running as unit: x.service';
	};
	const r = await runDispatchPass(base(warmSecond()), 'tok', h.gh, sh);
	assert.equal(r.failed, 2);
	assert.equal(r.minted, 1);
	assert.deepEqual(RECUT_LINE.exec(infos.find((i) => RECUT_LINE.test(i))!)!.slice(1), [
		'1',
		'0',
		'0',
	]);
	assert.deepEqual(getDispatchAffinitySnapshot().totals, {
		minted: 1,
		mintedViaAffinity: 0,
		mintedAffinityMoved: 0,
	});
});

test('a pass that minted nothing leaves the affinity counters untouched', async () => {
	const h = harness();
	await runDispatchPass(base({ pending: [] }), 'tok', h.gh, h.sh);
	assert.equal(getDispatchAffinitySnapshot().lastPass, null);
	assert.deepEqual(getDispatchAffinitySnapshot().totals, {
		minted: 0,
		mintedViaAffinity: 0,
		mintedAffinityMoved: 0,
	});
});

// --- #102: the warm half of the heavy hold ----------------------------------

const CT = 'WolffM/hadoku-cardtable';
const FORGE: HeavyModel = {
	isHeavy: (repo, jobName) => repo === CT && /^forge-(jvm|e2e)/.test(jobName ?? ''),
	isHeavyRepo: (repo) => repo === CT,
};
const forgeJob = (jobId: number, jobName: string): PendingRun => ({
	id: 37857873226,
	jobId,
	repo: CT,
	jobName,
	repository: { full_name: CT },
	head_repository: { full_name: CT, fork: false },
	event: 'push',
});
function recordingShell(): { sh: ReturnType<typeof fakeShell>; cmds: string[] } {
	const inner = fakeShell();
	const cmds: string[] = [];
	return {
		cmds,
		sh: async (node, cmd) => {
			cmds.push(`${node}: ${cmd}`);
			return inner(node, cmd);
		},
	};
}

test("#102 REPLAY 23:10Z: a heavy mint evicts the node's IDLE warm listener for a heavy repo, and marks the node", async () => {
	const gh = fakeGh({ runners: [{ id: 77, name: 'warm-claw-4-hadoku-cardtable', busy: false }] });
	const { sh, cmds } = recordingShell();
	const r = await runDispatchPass(
		base({
			order: ['claw-4'],
			nodes: [node('claw-4', { maxConcurrent: 4, warmRepo: CT, heavyModel: FORGE })],
			pending: [forgeJob(1, 'forge-e2e (1)')],
			nowMs: 1_000_000,
		}),
		'tok',
		gh,
		sh
	);
	assert.equal(r.minted, 1);
	assert.ok(
		cmds.some(
			(c) =>
				c.startsWith('claw-4:') && c.includes('stop') && c.includes('warm-claw-4-hadoku-cardtable')
		),
		`the warm unit was not stopped:\n  ${cmds.join('\n  ')}`
	);
	assert.ok(
		gh.writes.some((w) => w.includes('/actions/runners/77')),
		'the registration was not deleted'
	);
	assert.equal(heavyMarkedRecently('claw-4', 1_000_000 + 60_000), true);
	assert.equal(heavyMarkedRecently('claw-4', 1_000_000 + HEAVY_MARK_MS), false, 'the mark lapses');
});

test('#102: a BUSY warm listener beside a heavy job is left running — stopping it would kill its job', async () => {
	const gh = fakeGh({ runners: [{ id: 77, name: 'warm-claw-4-hadoku-cardtable', busy: true }] });
	const { sh, cmds } = recordingShell();
	await runDispatchPass(
		base({
			order: ['claw-4'],
			nodes: [node('claw-4', { maxConcurrent: 4, warmRepo: CT, heavyModel: FORGE })],
			pending: [forgeJob(1, 'forge-e2e (1)')],
		}),
		'tok',
		gh,
		sh
	);
	assert.equal(
		cmds.some((c) => c.includes('stop') && c.includes('warm-claw-4')),
		false
	);
	assert.equal(
		gh.writes.some((w) => w.includes('/actions/runners/77')),
		false
	);
});

test('#102: a LIGHT mint never touches the warm listener', async () => {
	const gh = fakeGh({ runners: [{ id: 77, name: 'warm-claw-4-hadoku-cardtable', busy: false }] });
	const { sh, cmds } = recordingShell();
	await runDispatchPass(
		base({
			order: ['claw-4'],
			nodes: [node('claw-4', { maxConcurrent: 4, warmRepo: CT, heavyModel: FORGE })],
			pending: [forgeJob(1, 'check')],
		}),
		'tok',
		gh,
		sh
	);
	assert.equal(
		cmds.some((c) => c.includes('stop') && c.includes('warm-claw-4')),
		false
	);
	assert.equal(heavyMarkedRecently('claw-4', Date.now()), false);
});

test('#102: a heavy SIBLING already running marks the node and evicts once — a long shard is one runner listing, not one per pass', async () => {
	const gh = fakeGh({ runners: [{ id: 77, name: 'warm-claw-4-hadoku-cardtable', busy: true }] });
	const { sh } = recordingShell();
	const input = (nowMs: number) =>
		base({
			order: ['claw-4'],
			nodes: [node('claw-4', { maxConcurrent: 4, warmRepo: CT, heavyModel: FORGE })],
			pending: [forgeJob(2, 'check')],
			runningJobs: [
				{
					repo: CT,
					runner: 'jit-claw-4-hadoku-cardtabl-j1-r9-1791497283',
					jobName: 'forge-e2e (1)',
				},
			],
			nowMs,
		});
	await runDispatchPass(input(1_000_000), 'tok', gh, sh);
	await runDispatchPass(input(1_015_000), 'tok', gh, sh);
	await runDispatchPass(input(1_030_000), 'tok', gh, sh);
	assert.equal(gh.reads.filter((r) => r.startsWith('/actions/runners?')).length, 1);
	assert.equal(
		heavyMarkedRecently('claw-4', 1_030_000 + 60_000),
		true,
		'refreshed every pass it is seen'
	);
});

// --- a runner GitHub gave to a different job --------------------------------

const MINTED_FOR_100 = 'jit-claw-2-hadoku-meet-j100-r1-1791000000';

test('2026-10-09 18:46Z: a runner minted for a still-queued job but BUSY elsewhere does not hold that job "in flight"', async () => {
	const infos = recordInfos();
	const h = harness([MINTED_FOR_100]);
	const r = await runDispatchPass(
		base({
			order: ['claw-2'],
			nodes: [node('claw-2', { maxConcurrent: 3 })],
			pending: [run(1)],
			runningJobs: [
				{ repo: 'WolffM/hadoku-meet', runner: MINTED_FOR_100, jobName: 'other-run-shard' },
			],
		}),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 1, 'job 100 is placed again — its own runner is serving another job');
	assert.ok(infos.some((i) => i.includes('serving another job')));
	const line = infos.find((i) => i.startsWith('[dispatch] minted='));
	assert.match(line!, /placed=claw-2@1$/, 'the busy unit still counts toward the node');
});

test('a runner minted for a queued job that is NOT busy yet is still in flight — the normal mint window', async () => {
	const h = harness([MINTED_FOR_100]);
	const r = await runDispatchPass(
		base({ order: ['claw-2'], nodes: [node('claw-2', { maxConcurrent: 3 })], pending: [run(1)] }),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 0, 'no second runner while the first is still coming up');
});

// --- a runner whose labels can never take its own job -----------------------

/** A shell whose one live unit is MINTED_FOR_100, described as `description`. */
function strandedShell(description: string, seen: string[]) {
	const base = fakeShell();
	return async (n: string, cmd: string) => {
		seen.push(cmd);
		if (cmd.includes('list-units'))
			return `${MINTED_FOR_100}.service loaded active running ${description}`;
		return base(n, cmd);
	};
}
const BUILDER_JOB = { ...run(1), labels: ['self-hosted', 'hadoku-builder'] };
const builderNode = () => node('claw-2', { maxConcurrent: 3, labels: ['hadoku-builder'] });

test('2026-10-23: a runner minted WITHOUT its job’s label is retired, and the job is placed again', async () => {
	const seen: string[] = [];
	const gh = fakeGh({ runners: [{ id: 218, name: MINTED_FOR_100 }] });
	const r = await runDispatchPass(
		base({ nodes: [builderNode()], pending: [BUILDER_JOB] }),
		'tok',
		gh,
		strandedShell('jit labels=self-hosted,Linux,X64,pm2-host,taskauto', seen)
	);
	assert.equal(r.minted, 1, 'job 100 is not held in flight by a runner that cannot take it');
	assert.ok(gh.writes.includes('/actions/runners/218'), 'its registration is deleted');
	assert.ok(
		seen.some((c) => c.includes('systemctl --user stop') && c.includes(MINTED_FOR_100)),
		'and its unit stopped, so it stops holding a slot'
	);
});

test('a runner whose stamp DOES fit its job is still in flight — no second mint, nothing retired', async () => {
	const seen: string[] = [];
	const gh = fakeGh({ runners: [{ id: 218, name: MINTED_FOR_100 }] });
	const r = await runDispatchPass(
		base({ nodes: [builderNode()], pending: [BUILDER_JOB] }),
		'tok',
		gh,
		strandedShell('jit labels=self-hosted,Linux,X64,hadoku-builder', seen)
	);
	assert.equal(r.minted, 0);
	assert.equal(gh.writes.includes('/actions/runners/218'), false);
});

test('a BUSY mismatched runner is serving another job — it is never deleted out from under it', async () => {
	const seen: string[] = [];
	const gh = fakeGh({ runners: [{ id: 218, name: MINTED_FOR_100, busy: true }] });
	const r = await runDispatchPass(
		base({
			nodes: [builderNode()],
			pending: [BUILDER_JOB],
			runningJobs: [{ repo: 'WolffM/hadoku-meet', runner: MINTED_FOR_100, jobName: 'deploy' }],
		}),
		'tok',
		gh,
		strandedShell('jit labels=self-hosted,Linux,X64,pm2-host', seen)
	);
	assert.equal(r.minted, 1, 'job 100 is placed again, as for any reassigned runner');
	assert.equal(gh.writes.includes('/actions/runners/218'), false, 'the busy runner is left alone');
});

// --- order: a push before a manual dispatch ---------------------------------

test('2026-10-09 20:27Z: a PUSH run’s job places before verify-branch dispatches queued after… and before', async () => {
	const at = (m: number) => new Date(Date.parse('2026-10-09T20:00:00Z') + m * 60_000).toISOString();
	const job = (id: number, event: string, minute: number): PendingRun => ({
		...run(id),
		event,
		jobCreatedAt: at(minute),
	});
	const ordered = byPriority([
		job(1, 'workflow_dispatch', 1),
		job(2, 'workflow_dispatch', 20),
		job(3, 'push', 5),
		job(4, 'schedule', 2),
		job(5, 'push', 3),
	]);
	assert.deepEqual(
		ordered.map((r) => r.id),
		[5, 3, 4, 1, 2]
	);
});

test('the push wins the one free node in a real pass', async () => {
	const infos = recordInfos();
	const h = harness();
	const r = await runDispatchPass(
		base({
			order: ['claw-2'],
			nodes: [node('claw-2', { maxConcurrent: 1 })],
			pending: [
				{ ...run(1), event: 'workflow_dispatch', jobCreatedAt: '2026-10-09T20:01:00Z' },
				{ ...run(2), event: 'push', jobCreatedAt: '2026-10-09T20:05:00Z' },
			],
		}),
		'tok',
		h.gh,
		h.sh
	);
	assert.equal(r.minted, 1);
	assert.ok(h.minted[0], 'one mint');
	assert.ok(
		infos.some((i) => i.includes('skipped run 1 ')),
		`the dispatch is the one that waits:\n  ${infos.join('\n  ')}`
	);
});
