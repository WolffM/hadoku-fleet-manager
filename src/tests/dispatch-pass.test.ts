import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDispatchPass } from '../runners/dispatch-pass.js';
import { REAP_IDLE_INTERVAL_MS } from '../runners/ephemeral-exec-reap.js';
import { REAP_INTERVAL_MS, JIT_REAP_GRACE_MS } from '../lib/jit-reap-cadence.js';
import { answeringJitState, fakeGh, fakeShell } from './helpers/fleet-fakes.js';
import { node, run, base, harness, installDispatchPassRig } from './helpers/dispatch-pass-rig.js';

installDispatchPassRig();

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
	const h = harness(['jit-claw-2-hadoku-rally-1787797000', 'jit-claw-2-hadoku-rally-1787797001']);
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
	const sh = answeringJitState(async (node: string, cmd: string) => {
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		if (cmd.includes('list-units')) return '';
		if (node === 'claw-2' && cmd.includes('jit-provision')) return 'SLOT-FAIL broken';
		if (cmd.includes('jit-provision')) return 'SLOT-READY /home/hadoku/.hadoku/jit/slot0 2.336.0';
		return 'Running as unit: x.service';
	});
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
	const h = harness(['jit-claw-2-hadoku-rally-r1-1787797008']);
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
	const sh = answeringJitState(async (_h: string, cmd: string) => {
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
	});
	const h = harness();
	await runDispatchPass(base({ pending: [run(1)] }), 'tok', h.gh, sh);
	assert.ok(slotsUsed.length > 0, 'the mint must have provisioned a slot');
	assert.ok(!slotsUsed.includes(0), `slot 0 is busy; mint used ${JSON.stringify(slotsUsed)}`);
});

test('two mints in one pass take different slots', async () => {
	const slotsUsed: number[] = [];
	const sh = answeringJitState(async (_h: string, cmd: string) => {
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		if (cmd.includes('pgrep')) return '';
		if (cmd.includes('list-units')) return '';
		const m = /SLOT=(\d+)/.exec(cmd);
		if (m) {
			slotsUsed.push(Number(m[1]));
			return 'SLOT-READY /home/hadoku/.hadoku/jit/slot' + m[1] + ' 2.336.0';
		}
		return 'Running as unit: x.service';
	});
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
	const sh = answeringJitState(async (_m: string, cmd: string) => {
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		if (cmd.includes('echo REACHABLE')) return 'REACHABLE';
		if (cmd.includes('list-units')) return '';
		return '';
	});
	const gh = {
		get: async () => ({ runners: [{ id: 5, name: 'jit-claw-2-hadoku-rally-r9-1000000000' }] }),
		write: async (_m: 'POST' | 'DELETE', p: string) => {
			swept.push(p);
			return { ok: true, status: 204 };
		},
	};
	const r = await runDispatchPass(
		base({ pending: [], repos: ['WolffM/hadoku-rally'] }),
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
