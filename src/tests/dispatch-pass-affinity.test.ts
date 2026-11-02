import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDispatchPass } from '../runners/dispatch-pass.js';
import { getDispatchAffinitySnapshot } from '../runners/dispatch-pass-state.js';
import { type DispatchPassInput } from '../runners/dispatch-pass-types.js';
import { buildFleetReport } from '../routes/fleet-report.js';
import { getCapacityLedger } from '../runners/capacity-ledger.js';
import type { HeavyModel } from '../runners/traffic.js';
import type { PendingRun } from '../runners/dispatcher.js';
import { fakeGh, fakeShell } from './helpers/fleet-fakes.js';
import {
	node,
	run,
	base,
	harness,
	recordInfos,
	installDispatchPassRig,
} from './helpers/dispatch-pass-rig.js';

installDispatchPassRig();

// --- the viaAffinity counter (W §5e) -------------------------------------

/** The line W's re-cut greps. Kept byte-identical to the §5e command's regex. */
const RECUT_LINE =
	/\[dispatch\] minted=(\d+) failed=\d+ in-flight=\d+ via-affinity=(\d+) affinity-moved=(\d+) /;

/** claw-2 is first in the order and cold; claw-1 holds the warm listener. */
const warmSecond = (): Partial<DispatchPassInput> => ({
	order: ['claw-2', 'claw-1'],
	nodes: [node('claw-2'), node('claw-1', { warmRepo: 'WolffM/hadoku-rally' })],
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

test('#102 REPLAY 2026-10-30 20:40:52Z: a heavy mint no listing shows yet still holds the next heavy job off its node', async () => {
	// claw-8's unit was minted 12 s earlier for forge-jvm (1), still queued, and
	// was already running forge-e2e (1) — but no job listing said so yet. The
	// tick read claw-8 `heavyJobs: 0` and doubled forge-e2e (4) onto it; the
	// node then sat at load 52 on 8 cores until the watchdog rebooted it.
	const infos = recordInfos();
	const CT = 'WolffM/hadoku-cardtable';
	const UNIT = 'jit-claw-8-hadoku-cardtabl-j124293716878-r41122643757-1793392837';
	const heavyModel: HeavyModel = {
		isHeavy: (repo, jobName) => repo === CT && /^forge-(jvm|e2e)/.test(jobName ?? ''),
		isHeavyRepo: (repo) => repo === CT,
	};
	const base0 = fakeShell();
	const sh = async (n: string, cmd: string) =>
		cmd.includes('list-units')
			? n === 'claw-8'
				? `${UNIT}.service loaded active running x`
				: ''
			: base0(n, cmd);
	const gh = fakeGh();
	const job = (jobId: number, jobName: string): PendingRun => ({
		id: 41122643757,
		jobId,
		repo: CT,
		jobName,
		jobCreatedAt: '2026-10-30T20:24:14Z',
		repository: { full_name: CT },
		head_repository: { full_name: CT, fork: false },
		event: 'push',
	});
	const r = await runDispatchPass(
		base({
			order: ['claw-8', 'claw-9'],
			nodes: [
				node('claw-8', { maxConcurrent: 2, heavyModel }),
				node('claw-9', { maxConcurrent: 3, heavyModel }),
			],
			pending: [job(124293716878, 'forge-jvm (1)'), job(124293716912, 'forge-e2e (4)')],
			// claw-9 is visibly running a shard of its own, as it was.
			runningJobs: [
				{
					repo: CT,
					runner: 'jit-claw-9-hadoku-cardtabl-j1-r41122643757-1',
					jobName: 'forge-jvm (3)',
				},
			],
			nowMs: Date.parse('2026-10-30T20:40:52Z'),
		}),
		'tok',
		gh,
		sh
	);
	assert.equal(r.minted, 0, 'both nodes run a heavy job, and the hold has 3600 s to run');
	assert.equal(
		infos.find((i) => i.startsWith('[dispatch] minted=')),
		undefined
	);
	// REVERTED (no unseen-unit count): minted=1 ... placed=claw-8@1 — the incident.
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
	const h = harness(['jit-claw-1-hadoku-rally-j5-r9-1792560000']);
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
	const h = harness(['jit-claw-3-hadoku-rally-j5-r9-1792560000']);
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
