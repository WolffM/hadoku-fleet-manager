import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	DEFAULT_RUNNER_SLICE,
	GITHUB_JOB_CEILING_SEC,
	JIT_PREFIX,
	JIT_UNIT_MAX_SEC,
	JOB_RESERVE_DEFAULT_MB,
	LOWER_BOUND_HEADROOM,
	MAX_RUNNER_NAME,
	TMP_FREE_FLOOR_MB,
	WARM_ASSIGN_WINDOW_MS,
	WARM_HALF_LIFE_MS,
	WARM_HISTORY_WINDOW_MS,
	WORK_FREE_FLOOR_MB,
	type WarmServedJob,
	admitMint,
	assertSafeJitConfig,
	buildSpawnPlan,
	buildWarmSpawnPlan,
	guestUnitMemoryMaxMb,
	jitRunnerName,
	parseJitName,
	planWarmCache,
	slotDir,
	unitMemoryMaxMb,
	warmRepoScores,
	warmTargetRepo,
} from '../runners/ephemeral.js';
import { choosePlacement, type NodeState } from '../runners/placement.js';
import { nodeOf } from '../runners/census.js';
import {
	dispatchEphemeral,
	jobReserve,
	loadRepoReserves,
	withoutGuests,
} from '../runners/ephemeral-tick.js';
import { setBackstopHold } from '../runners/backstop-hold.js';
import { SATURATED_QUEUED_MS } from '../runners/queue-discovery.js';
import {
	__resetJobHistoryForTesting,
	__setHistoryPathForTesting,
	ingestRuns,
	jobRecords,
} from '../job-history.js';

/** Build a jitconfig the way GitHub does: base64(JSON{'.runner': base64(JSON)}). */
function jitConfig(runner: Record<string, unknown>): string {
	const inner = Buffer.from(JSON.stringify(runner), 'utf8').toString('base64');
	return Buffer.from(JSON.stringify({ '.runner': inner }), 'utf8').toString('base64');
}
const GOOD = { DisableUpdate: 'True', Ephemeral: 'True', AgentName: 'jit-x' };

// --- naming -----------------------------------------------------------------

test('a JIT name carries its mint time, because the API will not give it back', () => {
	const n = jitRunnerName('hokon', 'WolffM/hadoku-rally', 1_787_797_008_000, 4242, 77);
	assert.equal(n, 'jit-hokon-hadoku-rally-j77-r4242-1787797008');
	// The sweep parses this trailing epoch to apply its grace. Without it a mint
	// is ageless and therefore immediately reapable.
	assert.match(n, /-(\d{10,})$/);
});

test('a JIT name is a legal systemd unit name', () => {
	const n = jitRunnerName('claw-2', 'WolffM/OSS-Issue-Aggregator', 1_787_797_008_000, 7, 9);
	assert.match(n, /^[A-Za-z0-9:_.-]+$/, 'systemd admits only this charset');
	assert.ok(n.startsWith(JIT_PREFIX), 'the sweep keys its reaping on this prefix');
	assert.ok(!n.includes('/'), 'the owner must not survive into a unit name');
});

test('slots sit under a single root so they share a filesystem with the payload', () => {
	// cp -al across filesystems silently becomes a 674 MB real copy (§12.16).
	assert.equal(slotDir('/home/hadoku', 3), '/home/hadoku/.hadoku/jit/slot3');
});

// --- admission --------------------------------------------------------------

const BASE = {
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 3,
	freeMb: 6000,
	requiredMb: 900,
	minFreeMb: 1536,
};

test('an idle node admits', () => {
	assert.equal(admitMint(BASE).ok, true);
});

test('a drained node is refused, and the refusal names WHICH drain', () => {
	// Every drain read "held out of service for maintenance" until 2026-10-25,
	// so a claw mid-reboot and a claw lent to a tenant looked identical in the
	// panel, in GET /fleet and in `fleet traffic`.
	const r = admitMint({
		...BASE,
		drained: true,
		drainedAs: { kind: 'reboot', reason: 'automated reboot: running 6.12.94, newest 6.12.113' },
	});
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'drained: reboot: automated reboot: running 6.12.94, newest 6.12.113');
	// The prefix is the clause; the generic wording survives a caller with no record.
	assert.equal(
		admitMint({ ...BASE, drained: true }).reason,
		'drained: held out of service for maintenance'
	);
});

test('standing registrations count against the cap — GitHub does not ask us first', () => {
	// This is the whole of B2. A dispatcher that counted only its own mints would
	// let GitHub fill the node behind its back, which is how eleven concurrent
	// builds landed on a 7.7 GB box on 2026-08-24.
	const r = admitMint({ ...BASE, liveUnits: 1, standingBusy: 2 });
	assert.equal(r.ok, false);
	assert.match(r.reason ?? '', /3\/3 in flight/);
});

test('memory refuses a mint the count cap would allow', () => {
	// claw-2 measured: 3 x p95 = 8.2 GB against 7.7 GB of RAM. Inside the count
	// cap, over the memory budget (§12.6).
	const r = admitMint({ ...BASE, liveUnits: 1, freeMb: 2200, requiredMb: 2900 });
	assert.equal(r.ok, false);
	assert.match(r.reason ?? '', /memory/);
});

test('a cheap job still fits where an expensive one does not', () => {
	const tight = { ...BASE, liveUnits: 1, freeMb: 2600 };
	assert.equal(admitMint({ ...tight, requiredMb: 700 }).ok, true);
	assert.equal(admitMint({ ...tight, requiredMb: 2900 }).ok, false);
});

// --- space (#101) -----------------------------------------------------------
//
// claw-4's tmpfs filled 2026-10-06 03:22-04:14Z and failed 4 jobs while
// memory admission still passed — memory has nothing to say about a full
// tmpfs. `undefined` (the BASE fixture's default, same as every test above)
// means "this caller never looked" and must never fire the clause.

test('undefined space fields never fire the clause — the default caller shape', () => {
	assert.equal(admitMint({ ...BASE, tmpFreeMb: undefined, workFreeMb: undefined }).ok, true);
});

test('300 MB free on /tmp refuses; 3 GB free on the same node admits', () => {
	const refused = admitMint({ ...BASE, tmpFreeMb: 300, workFreeMb: 8000 });
	assert.equal(refused.ok, false);
	assert.match(refused.reason ?? '', /^space: \/tmp/);
	assert.equal(admitMint({ ...BASE, tmpFreeMb: 3000, workFreeMb: 8000 }).ok, true);
});

test('300 MB free on ~/.hadoku/jit refuses the same way, naming _work', () => {
	const refused = admitMint({ ...BASE, tmpFreeMb: 8000, workFreeMb: 300 });
	assert.equal(refused.ok, false);
	assert.match(refused.reason ?? '', /^space: _work/);
});

test('an unreadable df (null) refuses, never admits on a guess', () => {
	const tmpUnreadable = admitMint({ ...BASE, tmpFreeMb: null, workFreeMb: 8000 });
	assert.equal(tmpUnreadable.ok, false);
	assert.match(tmpUnreadable.reason ?? '', /could not read \/tmp/);
	const workUnreadable = admitMint({ ...BASE, tmpFreeMb: 8000, workFreeMb: null });
	assert.equal(workUnreadable.ok, false);
	assert.match(workUnreadable.reason ?? '', /could not read _work/);
});

// --- space (#101), through the real placement walk --------------------------
//
// The unit tests above call `admitMint` directly. These go through
// `choosePlacement` (same path `dispatchEphemeral` uses) to prove the space
// clause actually reaches a node via `NodeState` (which extends
// `AdmissionInput`) with no placement-side wiring — `refusalFor` passes the
// whole `NodeState` straight to `admitMint`.

const SPACE_ORDER = ['claw-a', 'claw-b'];
const spaceNode = (name: string, over: Partial<NodeState> = {}): NodeState => ({
	name,
	healthy: true,
	eligible: true,
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 3,
	freeMb: 8000,
	requiredMb: 900,
	minFreeMb: 1536,
	...over,
});

test('(a1) placement: a node with 300MB free on /tmp is passed over for the other candidate', () => {
	const tight = spaceNode('claw-a', { tmpFreeMb: 300 });
	const roomy = spaceNode('claw-b');
	const p = choosePlacement(SPACE_ORDER, [tight, roomy]);
	assert.equal(p.node, 'claw-b');
	assert.equal(p.passed.length, 1);
	assert.equal(p.passed[0].node, 'claw-a');
	assert.match(p.passed[0].reason, /^space: \/tmp/);
	assert.match(p.passed[0].reason, /300/);
	assert.match(p.passed[0].reason, new RegExp(String(TMP_FREE_FLOOR_MB)));
});

test('(a1b) placement: the same node at 3000MB free on /tmp is admitted', () => {
	const roomy = spaceNode('claw-a', { tmpFreeMb: 3000 });
	const p = choosePlacement(SPACE_ORDER, [roomy]);
	assert.equal(p.node, 'claw-a');
	assert.deepEqual(p.passed, []);
});

test('(a2) placement: a node with 300MB free on ~/.hadoku/jit is passed over for the other candidate', () => {
	const tight = spaceNode('claw-a', { workFreeMb: 300 });
	const roomy = spaceNode('claw-b');
	const p = choosePlacement(SPACE_ORDER, [tight, roomy]);
	assert.equal(p.node, 'claw-b');
	assert.equal(p.passed.length, 1);
	assert.equal(p.passed[0].node, 'claw-a');
	assert.match(p.passed[0].reason, /^space: _work/);
});

test('(a3) placement: an unreadable /tmp (null) refuses the only candidate, no placement', () => {
	const unreadable = spaceNode('claw-a', { tmpFreeMb: null });
	const p = choosePlacement(['claw-a'], [unreadable]);
	assert.equal(p.node, undefined);
	assert.equal(p.passed.length, 1);
	assert.equal(p.passed[0].reason, 'space: could not read /tmp free space');
});

test('(a4) ORDER/MASKING: a node at capacity AND short on /tmp reports the capacity reason', () => {
	// Documents that the verdict's single `clause` can mask a second, also-true
	// refusal reason — `admitMint`/`refusalFor` check capacity before space, so
	// a reader cannot infer "this node has plenty of /tmp" from a `concurrency`
	// refusal. The warm path (which never calls `choosePlacement`) therefore
	// has to measure space itself rather than trusting a capacity verdict's
	// silence on it.
	const atCapacityAndTight = spaceNode('claw-a', { liveUnits: 3, tmpFreeMb: 300 });
	const p = choosePlacement(['claw-a'], [atCapacityAndTight]);
	assert.equal(p.node, undefined);
	assert.equal(p.passed.length, 1);
	assert.match(p.passed[0].reason, /at capacity/);
	assert.doesNotMatch(p.passed[0].reason, /^space:/);
});

test('(a5) boundary: exactly the floor admits, one MB under refuses', () => {
	const atFloor = spaceNode('claw-a', { tmpFreeMb: TMP_FREE_FLOOR_MB });
	assert.equal(choosePlacement(['claw-a'], [atFloor]).node, 'claw-a');
	const underFloor = spaceNode('claw-a', { tmpFreeMb: TMP_FREE_FLOOR_MB - 1 });
	const p = choosePlacement(['claw-a'], [underFloor]);
	assert.equal(p.node, undefined);
	assert.match(p.passed[0].reason, /^space: \/tmp/);

	const workAtFloor = spaceNode('claw-a', { workFreeMb: WORK_FREE_FLOOR_MB });
	assert.equal(choosePlacement(['claw-a'], [workAtFloor]).node, 'claw-a');
	const workUnderFloor = spaceNode('claw-a', { workFreeMb: WORK_FREE_FLOOR_MB - 1 });
	const pw = choosePlacement(['claw-a'], [workUnderFloor]);
	assert.equal(pw.node, undefined);
	assert.match(pw.passed[0].reason, /^space: _work/);
});

// --- a lower-bound reservation is placement, not contention (#76, #67) -----
//
// brave-quartet (#76): three capped runs — one OOM-killed at hokon's 4,096 MB,
// two pinned at claw-2/claw-4's 6,313 MB slice ceiling — reserve at 6,313 MB,
// lowerBound: true. Admissible only where the slice clears that floor:
// claw-9 (27.9 GB), claw-8 (13.9 GB), claw-1 (9.8 GB); not claw-2/4/5/6 (6.3 GB).

const BRAVE_QUARTET_MB = 6313;

test('#76: a lower-bound floor refuses a node whose own slice does not clear it, EVEN IDLE', () => {
	// claw-2/claw-4 themselves: an idle node, free memory comfortably above the
	// floor on its face — the ordinary freeMb check alone would admit this.
	const r = admitMint({
		...BASE,
		freeMb: 7849, // sliceCeilingMb (6313) + minFreeMb (1536): a fully idle node
		requiredMb: BRAVE_QUARTET_MB,
		requiredIsLowerBound: true,
		sliceCeilingMb: 6313,
	});
	assert.equal(r.ok, false);
	assert.match(r.reason ?? '', /placement:/);
	assert.match(r.reason ?? '', /6313MB/);
});

test('#76: the SAME floor, NOT flagged as a lower bound, is an ordinary memory refusal only if it does not fit', () => {
	// Without the flag, nothing new fires — this is today's behaviour, and an
	// idle node with room admits exactly as it always has.
	const r = admitMint({
		...BASE,
		freeMb: 7849,
		requiredMb: BRAVE_QUARTET_MB,
		sliceCeilingMb: 6313,
	});
	assert.equal(r.ok, true, 'an unflagged estimate is trusted at face value, same as before #76');
});

test('#76: a slice that clears the floor admits — claw-1 (9.8 GB), claw-8 (13.9 GB), claw-9 (27.9 GB)', () => {
	for (const { node, sliceCeilingMb } of [
		{ node: 'claw-1', sliceCeilingMb: 9800 },
		{ node: 'claw-8', sliceCeilingMb: 13_900 },
		{ node: 'claw-9', sliceCeilingMb: 27_900 },
	]) {
		const r = admitMint({
			...BASE,
			freeMb: sliceCeilingMb + 1536,
			requiredMb: BRAVE_QUARTET_MB,
			requiredIsLowerBound: true,
			sliceCeilingMb,
		});
		assert.equal(r.ok, true, `${node} (${sliceCeilingMb}MB slice) should admit the floor`);
	}
});

test('#76: a slice EXACTLY at the floor still refuses — zero margin for the part the cap never let through', () => {
	const r = admitMint({
		...BASE,
		freeMb: BRAVE_QUARTET_MB + 1536,
		requiredMb: BRAVE_QUARTET_MB,
		requiredIsLowerBound: true,
		sliceCeilingMb: BRAVE_QUARTET_MB,
	});
	assert.equal(r.ok, false);
});

test('#76: the headroom boundary — one MB under refuses, exactly at it admits', () => {
	// claw-2 measured 6,336 MB against brave-quartet's 6,313 MB floor: a 23 MB
	// margin that admitted before this correction. That floor is the CAP the
	// job was killed at, so its true need is strictly above it — a few
	// megabytes of slack is still the "start and kill" shape (#26), not a
	// cleared floor. Manager correction, 2026-10-02.
	const floorWithHeadroom = Math.ceil(BRAVE_QUARTET_MB * (1 + LOWER_BOUND_HEADROOM));
	assert.equal(floorWithHeadroom, 6945, '10% over a 6,313 MB floor, rounded up');
	const admitsAt = (sliceCeilingMb: number) =>
		admitMint({
			...BASE,
			freeMb: sliceCeilingMb + 1536,
			requiredMb: BRAVE_QUARTET_MB,
			requiredIsLowerBound: true,
			sliceCeilingMb,
		}).ok;
	assert.equal(admitsAt(floorWithHeadroom - 1), false, 'one MB under the headroom still refuses');
	assert.equal(admitsAt(floorWithHeadroom), true, 'exactly at the headroom admits');
	// claw-2 itself, the case that found this: 6,336 MB no longer clears it.
	assert.equal(admitsAt(6336), false, "claw-2's 23 MB margin over the floor is not enough");
});

test('#76: a lower-bound job that IS currently contended (freeMb short, slice fine) still reads as ordinary memory contention', () => {
	// claw-9 clears the floor structurally, but is busy right now — this is the
	// CONTENTION case (#67), distinct from PLACEMENT, and must fall through to
	// the plain memory message rather than the new placement one.
	const r = admitMint({
		...BASE,
		freeMb: 3000,
		requiredMb: BRAVE_QUARTET_MB,
		requiredIsLowerBound: true,
		sliceCeilingMb: 27_900,
	});
	assert.equal(r.ok, false);
	assert.match(r.reason ?? '', /memory:/);
	assert.doesNotMatch(r.reason ?? '', /placement:/);
});

test('#76: no sliceCeilingMb measured (older caller, or an unreadable node) never fires the new clause', () => {
	const r = admitMint({
		...BASE,
		freeMb: 20_000,
		requiredMb: BRAVE_QUARTET_MB,
		requiredIsLowerBound: true,
		// sliceCeilingMb absent
	});
	assert.equal(r.ok, true, 'falls back to the plain freeMb check, exactly as before this existed');
});

// --- jitconfig safety -------------------------------------------------------

test('a well-formed ephemeral jitconfig is accepted', () => {
	assert.equal(assertSafeJitConfig(jitConfig(GOOD)).ok, true);
});

test('DisableUpdate is mandatory — a self-update would rewrite every slot at once', () => {
	// On ext4 a hardlink is a second name for one inode, so an in-place update
	// through one slot corrupts the payload shared by all of them. Same mechanism
	// this repo already documents for the pnpm store.
	const r = assertSafeJitConfig(jitConfig({ ...GOOD, DisableUpdate: 'False' }));
	assert.equal(r.ok, false);
	assert.match(r.reason ?? '', /DisableUpdate/);
});

test('a non-ephemeral config is refused — it would outlive its job', () => {
	const r = assertSafeJitConfig(jitConfig({ ...GOOD, Ephemeral: 'False' }));
	assert.equal(r.ok, false);
	assert.match(r.reason ?? '', /Ephemeral/);
});

test('garbage is refused rather than throwing into the dispatch loop', () => {
	for (const bad of ['', 'not-base64!!', Buffer.from('{}').toString('base64')]) {
		const r = assertSafeJitConfig(bad);
		assert.equal(r.ok, false, `should refuse: ${bad.slice(0, 20)}`);
		assert.ok(r.reason);
	}
});

// --- spawn plan -------------------------------------------------------------

test('the spawn plan is a transient unit with a backstop and its own memory cap', () => {
	const p = buildSpawnPlan({
		unit: 'jit-hokon-meet-1787797008',
		slot: '/home/hadoku/.hadoku/jit/slot0',
		jitConfig: 'CFG',
		memoryMaxMb: 3000,
		ttlSeconds: JIT_UNIT_MAX_SEC,
	});
	assert.deepEqual(p.argv.slice(0, 4), [
		'systemd-run',
		'--user',
		'--unit=jit-hokon-meet-1787797008',
		'--collect',
	]);
	// --user: no sudo, and hokon has none. --collect: a finished unit reaps
	// itself. RuntimeMaxSec: a backstop against a WEDGED unit, above GitHub's own
	// job ceiling. MemorySwapMax=0: swap is `infinity` on every runner unit today.
	assert.ok(p.argv.includes(`--property=RuntimeMaxSec=${JIT_UNIT_MAX_SEC}`));
	assert.ok(p.argv.includes('--property=MemoryMax=3000M'));
	assert.ok(p.argv.includes('--property=MemorySwapMax=0'));
	// THE SECRET IS NOT IN THE COMMAND LINE. A jitconfig carries a real OAuth
	// token; as an argv token it lands in /proc/<pid>/cmdline — world-readable,
	// and `openclaw` has a login on these boxes — and in the systemd journal,
	// which keeps it long after the runner is gone. The unit reads it from a
	// 0600 file at exec time instead.
	assert.ok(
		!p.argv.some((a) => a.includes('CFG')),
		`the jitconfig must not appear in argv: ${JSON.stringify(p.argv)}`
	);
	assert.equal(p.configContent, 'CFG', 'it is carried out-of-band for the caller to stage');
	assert.equal(p.configPath, '/home/hadoku/.hadoku/jit/slot0/.jitconfig');
	assert.match(p.argv.at(-1) ?? '', /Runner\.Listener run --jitconfig "\$C"/);
	assert.match(
		p.argv.at(-1) ?? '',
		/rm -f .*\.jitconfig; exec /,
		'the staged credential is removed before the listener starts, not left for the job'
	);
	assert.match(p.argv.at(-1) ?? '', /slot0\/bin/);
});

/**
 * ISSUE #22 — the fleet killed every job at one hour.
 *
 * `ttlSeconds: 3600` was minted onto every JIT unit as `RuntimeMaxSec`, and the
 * comment beside it called it an ORPHAN timeout. systemd cannot tell an orphan
 * from a build at minute 59: brave-quartet's `check` (run 34543150470) died at
 * 3,601 s in `Post Run Swatinem/rust-cache@v2` with every substantive step
 * green.
 *
 * The property being pinned is not "the call site passes a bigger number" —
 * that is one path, and the call site is where the bug lived. It is that NO
 * input to this function can produce a `RuntimeMaxSec` below GitHub's own job
 * ceiling. The old value is in the table because it is the literal regression,
 * and the tiny ones because an orphan timeout is exactly the shape of number a
 * future reader would reach for.
 */
test('no ttlSeconds can put RuntimeMaxSec below GitHub’s own job ceiling', () => {
	assert.ok(
		JIT_UNIT_MAX_SEC > GITHUB_JOB_CEILING_SEC,
		'the backstop must sit ABOVE the ceiling GitHub enforces, or it fires first'
	);
	for (const ttlSeconds of [0, 1, 300, 900, 3600, GITHUB_JOB_CEILING_SEC - 1]) {
		const p = buildSpawnPlan({
			unit: 'jit-claw-3-brave-quartet-1787797008',
			slot: '/home/hadoku/.hadoku/jit/slot0',
			jitConfig: 'CFG',
			memoryMaxMb: 3000,
			ttlSeconds,
		});
		const prop = p.argv.find((a) => a.startsWith('--property=RuntimeMaxSec='));
		assert.ok(prop, `no RuntimeMaxSec emitted for ttlSeconds=${ttlSeconds}`);
		const emitted = Number(prop.split('=').at(-1));
		assert.ok(
			emitted >= GITHUB_JOB_CEILING_SEC,
			`ttlSeconds=${ttlSeconds} produced RuntimeMaxSec=${emitted}, which kills a running job ` +
				`before GitHub's own ${GITHUB_JOB_CEILING_SEC}s timeout can cancel it cleanly`
		);
	}
});

/**
 * THE CONTAINMENT, not the per-unit cap.
 *
 * `MemoryMax` bounds ONE runner; the slice bounds their SUM, and only the sum is
 * what the 2026-08-04 outage was about (~51 GB anon-RSS, OOM took
 * pm2-hadoku.service and 23 services with it, host unreachable ~11 minutes).
 * All-JIT handed that back without anyone deciding to: a `systemd-run --user`
 * unit with no `Slice=` lands in `app.slice`, which is `MemoryMax=infinity`.
 *
 * Measured, not inferred. On claw-3 2026-09-14 20:20Z every live unit — two
 * `jit-*` and one `warm-*` — read `Slice=app.slice`, while `runners.slice` was
 * loaded at 14,543,749,120 bytes and held nothing. The kernel side is #26: the
 * `wasm-size` job of brave-quartet run 34543150470 was OOM-killed on claw-2 with
 * `oom_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/jit-claw-2-…`
 * — the unit's own cgroup, one level below `app.slice`, never `runners.slice`.
 *
 * The property pinned is NOT "the call site passes a slice". It is that no input
 * to these builders can produce a unit with no `Slice=` at all, which is exactly
 * the failure that shipped: nobody passed one because there was nothing to pass.
 */
test('no input can mint a unit without a Slice= — JIT and warm alike', () => {
	const bases = {
		jit: (sliceName?: string | null) =>
			buildSpawnPlan({
				unit: 'jit-claw-3-brave-quartet-1787797008',
				slot: '/home/hadoku/.hadoku/jit/slot0',
				jitConfig: 'CFG',
				memoryMaxMb: 3000,
				ttlSeconds: JIT_UNIT_MAX_SEC,
				sliceName,
			}),
		warm: (sliceName?: string | null) =>
			buildWarmSpawnPlan({
				unit: 'warm-claw-3-hadoku_site',
				slot: '/home/hadoku/.hadoku/warm/listener',
				memoryMaxMb: 3000,
				sliceName,
			}),
	};
	// undefined is the live call today: neither `mintEphemeralRunner` nor
	// `mintWarmListener` carries a slice name, so the default is the whole
	// mechanism rather than a fallback nothing reaches.
	for (const [kind, build] of Object.entries(bases)) {
		for (const bad of [undefined, null, '', '   ', 'app.slice-but-not', 'runners', '../evil']) {
			const p = build(bad);
			const prop = p.argv.find((a) => a.startsWith('--property=Slice='));
			assert.ok(prop, `${kind}: no Slice= emitted for sliceName=${JSON.stringify(bad)}`);
			assert.equal(
				prop,
				`--property=Slice=${DEFAULT_RUNNER_SLICE}`,
				`${kind}: sliceName=${JSON.stringify(bad)} must fall back to the fleet slice, ` +
					'never to app.slice by omission and never to a name systemd would refuse'
			);
		}
		// A real override is honoured — hokon's `ci-runner.slice` is the one in the
		// manifest, and the whole point of resolving rather than hardcoding is that
		// threading it later needs no second mechanism.
		const over = build('ci-runner.slice');
		assert.ok(over.argv.includes('--property=Slice=ci-runner.slice'), `${kind}: override ignored`);
	}
});

test('Slice= is emitted BEFORE the payload, so it is a systemd-run property and not a job argument', () => {
	// `systemd-run` parses its own flags up to the command; a --property after the
	// binary is an argument TO the runner and silently does nothing — which would
	// reproduce the exact uncontained state this change fixes, while the argv read
	// as correct to anyone grepping for the string.
	const p = buildSpawnPlan({
		unit: 'jit-claw-3-x-1787797008',
		slot: '/s',
		jitConfig: 'CFG',
		memoryMaxMb: 3000,
		ttlSeconds: JIT_UNIT_MAX_SEC,
	});
	const slice = p.argv.findIndex((a) => a.startsWith('--property=Slice='));
	assert.ok(slice > 0);
	assert.ok(
		slice < p.argv.indexOf('/bin/sh'),
		`Slice= must precede the command: ${JSON.stringify(p.argv)}`
	);
	const w = buildWarmSpawnPlan({ unit: 'warm-claw-3-x', slot: '/s', memoryMaxMb: 3000 });
	const wSlice = w.argv.findIndex((a) => a.startsWith('--property=Slice='));
	assert.ok(wSlice > 0 && wSlice < w.argv.length - 2, `Slice= must precede the binary: ${w.argv}`);
});

test('a ttlSeconds ABOVE the floor is honoured — the floor widens, it does not pin', () => {
	// Clamping in both directions would make the argument a lie and silently cap
	// a repo that legitimately raised its own `timeout-minutes`.
	const wide = JIT_UNIT_MAX_SEC * 2;
	const p = buildSpawnPlan({
		unit: 'jit-claw-3-brave-quartet-1787797008',
		slot: '/home/hadoku/.hadoku/jit/slot0',
		jitConfig: 'CFG',
		memoryMaxMb: 3000,
		ttlSeconds: wide,
	});
	assert.ok(p.argv.includes(`--property=RuntimeMaxSec=${wide}`));
});

test('freeMb is MEGABYTES, and a slot count in that field refuses everything', () => {
	// Documented as a test because the mistake has already been made: the tier
	// probe's `free` is FREE SLOTS (`cap - workers`), and wiring it into this
	// field made admission compute `3 - 4096` and decline every mint forever.
	// Both are plain numbers with plausible names, so nothing else caught it —
	// the dispatcher looked correctly wired and minted nothing.
	const real = {
		liveUnits: 0,
		standingBusy: 0,
		maxConcurrent: 3,
		requiredMb: 4096,
		minFreeMb: 2048,
	};
	assert.equal(admitMint({ ...real, freeMb: 14_000 }).ok, true, 'megabytes admit');
	assert.equal(admitMint({ ...real, freeMb: 3 }).ok, false, 'a slot count can only ever refuse');
});

test('the job id makes two jobs of ONE run two distinct names', () => {
	// The 409 in one assertion: same node, same repo, same run, same tick clock.
	const a = jitRunnerName('claw-3', 'WolffM/hadoku_site', 1_787_797_008_000, 42, 900_001);
	const b = jitRunnerName('claw-3', 'WolffM/hadoku_site', 1_787_797_008_000, 42, 900_002);
	assert.notEqual(a, b);
});

test('a job-scoped name still parses back to its run and mint time', () => {
	// The reaper keys on these. §12.8 treats an unparseable name as ageless and
	// therefore IMMEDIATELY reapable, so a format change that broke this would
	// kill running jobs at the next sweep.
	const n = jitRunnerName('claw-3', 'WolffM/hadoku_site', 1_787_797_008_000, 42, 901);
	const parsed = parseJitName(`${n}.service`);
	assert.equal(parsed?.runId, 42);
	assert.equal(parsed?.jobId, 901);
	assert.equal(parsed?.mintedAtMs, 1_787_797_008_000);
});

// The 2026-09-02 outage. `generate-jitconfig` answers 422 above 64 characters,
// so a long REPO name — not a long node name — is what breaks minting, and it
// breaks only for that repo. `hadoku_site` minted all day while this repo could
// not mint at all.
test('a JIT name never exceeds the 64 characters GitHub accepts', () => {
	// The exact case that produced the 422: 69 characters before the fix.
	const n = jitRunnerName(
		'claw-1',
		'WolffM/hadoku-fleet-manager',
		1_788_345_956_000,
		33_620_820_871,
		100_217_182_487
	);
	assert.ok(
		n.length <= MAX_RUNNER_NAME,
		`minted name is ${n.length} chars, GitHub rejects above ${MAX_RUNNER_NAME}: ${n}`
	);
	// Shortening must not cost the two things the name exists to carry.
	assert.equal(nodeOf(n, ['claw-1', 'claw-2', 'hokon']), 'claw-1');
	const parsed = parseJitName(n);
	assert.equal(parsed?.runId, 33_620_820_871);
	assert.equal(parsed?.jobId, 100_217_182_487);
	assert.equal(parsed?.mintedAtMs, 1_788_345_956_000);
});

test('every fleet node crossed with the longest repo name stays inside the ceiling', () => {
	// Ids grow. Pad them well past today's width so this keeps failing early
	// rather than at the next mint that happens to be one digit longer.
	const runId = 999_999_999_999;
	const jobId = 999_999_999_999;
	for (const node of ['claw-1', 'claw-2', 'claw-3', 'claw-4', 'claw-5', 'claw-6', 'hokon']) {
		for (const repo of [
			'WolffM/hadoku-fleet-manager',
			'WolffM/hadoku_site',
			'WolffM/oss-issue-aggregator',
		]) {
			const n = jitRunnerName(node, repo, 1_788_345_956_000, runId, jobId);
			assert.ok(n.length <= MAX_RUNNER_NAME, `${node} x ${repo} -> ${n.length}: ${n}`);
			assert.equal(
				nodeOf(n, ['claw-1', 'claw-2', 'claw-3', 'claw-4', 'claw-5', 'claw-6', 'hokon']),
				node
			);
			assert.equal(parseJitName(n)?.runId, runId);
		}
	}
});

test('a name with no room left for a slug is still parseable, not truncated mid-tail', () => {
	// Pathological, but the reaper treats an unparseable name as immediately
	// reapable — it would kill a running job. Losing the slug is the safe give.
	const n = jitRunnerName(
		'a-very-long-operator-chosen-node-name',
		'WolffM/hadoku-fleet-manager',
		1_788_345_956_000,
		999_999_999_999,
		999_999_999_999
	);
	const parsed = parseJitName(n);
	assert.equal(parsed?.runId, 999_999_999_999);
	assert.equal(parsed?.mintedAtMs, 1_788_345_956_000);
});

test('a name minted BEFORE the job-scoped format still parses, with a null job', () => {
	// Live units at rollover carry the old shape. They must stay parseable.
	const parsed = parseJitName('jit-claw-3-hadoku_site-r33538607904-1788284247.service');
	assert.equal(parsed?.runId, 33_538_607_904);
	assert.equal(parsed?.jobId, null);
	assert.equal(parsed?.mintedAtMs, 1_788_284_247_000);
});

// --- the dispatcher's return contract (2026-09-01) --------------------------
//
// This function returned `void`. Its caller does `recordDispatch(res, ...)`, and
// a missing result is scored there as attempted-and-all-failed — so a fleet with
// nothing to dispatch, and a fleet minting perfectly, and a fleet that could not
// be reached at all, were reported identically as a dispatcher that had been
// failing since the last restart.

test('nothing declared ephemeral is a ZEROED pass, never a missing one', async () => {
	const res = await dispatchEphemeral(
		{
			fleetProbe: new Map(),
			ephemeral: new Set(),
			nodes: {},
			isSick: () => false,
			repos: [],
		},
		'tok',
		{ get: async () => null, write: async () => ({ ok: true, status: 200 }) } as never
	);
	assert.deepEqual(
		res,
		{ minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 },
		'"looked, nothing to do" must be distinguishable from "could not look"'
	);
});

// --- the ladder -> dispatcher seam (2026-09-01) ----------------------------
//
// Asserted through the real function, not around it. The dispatch RESULT was
// dropped on this exact hand-off for three days with green unit tests on both
// sides, so the gate this function chooses is verified where it is CHOSEN.

function tickRig() {
	const seen: { minQueuedMs?: number }[] = [];
	const input = {
		fleetProbe: new Map([['claw-3', { reachable: true, busyRepos: new Map() }]]),
		ephemeral: new Set(['claw-3']),
		nodes: { 'claw-3': { labels: ['hadoku-builder'], maxConcurrent: 3, minFreeMb: 1536 } },
		isSick: () => false,
		repos: ['WolffM/hadoku_site'],
	};
	// `$7 $2`: available AND installed, off one `free -m` line. The tick refuses to
	// mint on a node whose total it cannot read, because the per-unit cap is now
	// derived from it (MemTotal - minFreeMb) and a silent fallback would be the
	// tight 4 GiB cap of #26 coming back through the "I could not look" door.
	const sh = async (_n: string, cmd: string) => (cmd.includes('$7, $2') ? '9000 16000' : '9000');
	const run = async (i: { minQueuedMs?: number }) => {
		seen.push({ minQueuedMs: i.minQueuedMs });
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	};
	return { input, sh, run, seen };
}

test('seam: with a standing runner eligible, the dispatcher gate is SATURATED_QUEUED_MS', async () => {
	// Every claw is ephemeral, so every standing slot (a promoted reserve) sits
	// below them: "the standing fleet above is full" held on every tick the
	// retired ladder ever computed it, and 30s was always the live gate.
	const r = tickRig();
	await dispatchEphemeral(
		{ ...r.input, standingEligible: new Set(['hokon']) } as never,
		'tok',
		{} as never,
		r.sh as never,
		r.run as never
	);
	assert.equal(r.seen.length, 1, 'the tick must actually run');
	assert.equal(r.seen[0].minQueuedMs, SATURATED_QUEUED_MS);
});

test('seam: with NOTHING standing, the gate is removed — there is no runner to wait for', async () => {
	const r = tickRig();
	await dispatchEphemeral(
		{ ...r.input, standingEligible: new Set() } as never,
		'tok',
		{} as never,
		r.sh as never,
		r.run as never
	);
	assert.equal(r.seen[0].minQueuedMs, 0);
});

test('seam: an unreadable free-memory figure still declines to mint', async () => {
	// The pre-existing guard, re-asserted through the new seam: a node that
	// cannot report its memory is skipped, and with no node left the pass is
	// COULD NOT LOOK rather than a quiet zero.
	const r = tickRig();
	const res = await dispatchEphemeral(
		r.input as never,
		'tok',
		{} as never,
		(async () => null) as never,
		r.run as never
	);
	assert.equal(res, null, 'no probeable node is "could not look"');
	assert.equal(r.seen.length, 0, 'and nothing is dispatched');
});

/**
 * ISSUE #26 — the flat 4 GiB per-unit cap killed real work.
 *
 * brave-quartet's `wasm-size` job of run 34543150470 was OOM-killed on claw-2:
 * `oom-kill:constraint=CONSTRAINT_MEMCG` against the unit's own 4 GiB, eight
 * parallel `rustc` processes resident, the largest ~830 MB RSS. GitHub recorded
 * the step as CANCELLED rather than failed — the shape you get when the runner
 * is killed out from under the job — so nothing in CI said "out of memory"
 * either. The node had 13.8 GB of CI budget unspent at the time.
 *
 * The operator's rule, 2026-09-12: no hard per-job memory cap; a floor keeps the
 * claw alive. The floor is `minFreeMb` and it is already expressed — the slice
 * ceiling IS `MemTotal − minFreeMb` — so a unit allowed to reach the ceiling can
 * take everything CI is permitted and nothing the box needs to stay reachable.
 *
 * SAFE ONLY BECAUSE `Slice=` SHIPPED FIRST. The slice bounds the SUM; this
 * bounds ONE. Relaxing the per-unit cap on units sitting in `app.slice` would
 * have been the 2026-08-04 outage with extra steps.
 */
test('no per-unit cap below the slice ceiling — a declared value may only WIDEN', () => {
	// claw-3 measured: 15,919 MB installed, 2,048 MB floor, 13,870 MB ceiling —
	// the exact number in its own runners.slice unit file.
	const ceiling = 13_870;
	assert.equal(
		unitMemoryMaxMb({ requestedMb: 4096, sliceCeilingMb: ceiling }),
		ceiling,
		"the manifest's 4096 is #26 exactly; it must not be able to narrow the cap"
	);
	for (const requestedMb of [undefined, null, 0, -1, 1, 3072, 4096, ceiling - 1]) {
		assert.equal(
			unitMemoryMaxMb({ requestedMb, sliceCeilingMb: ceiling }),
			ceiling,
			`requestedMb=${JSON.stringify(requestedMb)} must not produce a cap below the ceiling`
		);
	}
	// It is a FLOOR, not a pin — same contract as JIT_UNIT_MAX_SEC. An operator
	// raising the number above the ceiling is asking for something the slice will
	// refuse anyway, and clamping would make the field a lie.
	assert.equal(unitMemoryMaxMb({ requestedMb: ceiling + 5000, sliceCeilingMb: ceiling }), 18_870);
});

test('an unusable ceiling falls back to the request rather than to zero', () => {
	// TOTAL over its inputs. This runs after the registration exists, so a throw
	// or a `MemoryMax=0M` would leak a black-hole runner. The caller refuses to
	// mint on a node whose memory it could not read, so production never reaches
	// these — but the function must still be safe for every one of them.
	for (const sliceCeilingMb of [undefined, null, 0, -1, NaN, Infinity]) {
		assert.equal(unitMemoryMaxMb({ requestedMb: 4096, sliceCeilingMb }), 4096);
		assert.equal(
			unitMemoryMaxMb({ sliceCeilingMb }),
			JOB_RESERVE_DEFAULT_MB,
			'and with no request either, the documented default — never 0'
		);
	}
});

// --- admission's ESTIMATE vs the unit's HARD CAP (2026-09-01) ----------------
//
// `requiredMb` is what admission RESERVES against observed free memory;
// `MemoryMax` is what the unit is actually capped at. Both read `unitMaxMb`
// until this date, so every mint reserved the worst case: claw-1 admitted ONE
// concurrent job at 10GB free, and 13 jobs sat queued while dispatch logged
// "no node can take this job right now". Measured from systemd's own per-unit
// accounting that evening: p95 2970MB against a 4096MB cap (claw-1 n=41,
// claw-3 n=227).

function nodeRig(node: Record<string, unknown>, repos: string[] = ['WolffM/hadoku_site']) {
	const seen: {
		nodes?: { requiredMb: number; requiredMbByRepo?: ReadonlyMap<string, unknown> }[];
		cap?: number;
	}[] = [];
	const input = {
		fleetProbe: new Map([['claw-3', { reachable: true, busyRepos: new Map() }]]),
		ephemeral: new Set(['claw-3']),
		nodes: { 'claw-3': node },
		isSick: () => false,
		repos,
	};
	// `$7 $2`: available AND installed, off one `free -m` line. The tick refuses to
	// mint on a node whose total it cannot read, because the per-unit cap is now
	// derived from it (MemTotal - minFreeMb) and a silent fallback would be the
	// tight 4 GiB cap of #26 coming back through the "I could not look" door.
	const sh = async (_n: string, cmd: string) => (cmd.includes('$7, $2') ? '9000 16000' : '9000');
	const run = async (i: {
		nodes: { requiredMb: number; requiredMbByRepo?: ReadonlyMap<string, unknown> }[];
		memoryMaxMbFor: (r: string) => number;
	}) => {
		seen.push({ nodes: i.nodes, cap: i.memoryMaxMbFor(repos[0]) });
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	};
	return { input, sh, run, seen };
}

const GH = { get: async () => null, write: async () => ({ ok: true, status: 200 }) } as never;

test('admission reserves the MEASURED p95, not the per-unit cap', async () => {
	const r = nodeRig({
		labels: ['hadoku-builder'],
		maxConcurrent: 3,
		minFreeMb: 2048,
		slice: { unitMaxMb: 4096 },
		jobP95Mb: 2970,
	});
	await dispatchEphemeral(r.input as never, 'tok', GH, r.sh as never, r.run as never);
	assert.equal(r.seen[0].nodes?.[0].requiredMb, 2970, 'the estimate is what admission reserves');
	// THE HARD CAP IS THE SLICE CEILING NOW (issue #26), not `unitMaxMb`. The rig's
	// node measures 16,000 MB installed with a 2,048 MB floor, so CI may have
	// 13,952 MB of it and one unit may reach all of that — the slice still bounds
	// the SUM. It read 4096 until 2026-09-14, and brave-quartet's `wasm-size` was
	// OOM-killed against exactly that on claw-2 with 13.8 GB of budget unspent.
	assert.equal(r.seen[0].cap, 16_000 - 2048, 'the HARD CAP is MemTotal − minFreeMb');
});

test('an unmeasured job reserves the default, NOT the slice ceiling', async () => {
	// The fallback and the cap were one number — `jobP95Mb ?? unitMaxMb` — and
	// that read as harmless only while the cap was 4096. Reserving the ceiling
	// for an unmeasured job would admit ONE mint per node and queue the rest:
	// the 2026-09-01 shape, 13 jobs queued while dispatch logged "no node can
	// take this job right now". Raising the cap must not raise the reservation.
	const r = nodeRig({
		labels: ['hadoku-builder'],
		maxConcurrent: 3,
		minFreeMb: 2048,
		slice: { unitMaxMb: 4096 },
	});
	await dispatchEphemeral(r.input as never, 'tok', GH, r.sh as never, r.run as never);
	assert.equal(
		r.seen[0].nodes?.[0].requiredMb,
		JOB_RESERVE_DEFAULT_MB,
		'over-conservative beats over-admitting, but the ceiling is not an estimate'
	);
	assert.ok(
		(r.seen[0].nodes?.[0].requiredMb ?? 0) < (r.seen[0].cap ?? 0),
		'the reservation must stay well under the cap, or admission refuses everything'
	);
});

test('a node whose INSTALLED memory cannot be read is skipped, not capped tight', async () => {
	// The cap is derived from MemTotal, so an unreadable total must decline the
	// node — exactly as an unreadable FREE figure already does. Falling back to
	// the old flat 4096 would be #26 arriving silently through the "I could not
	// look" door, which CLAUDE.md forbids by name.
	const r = nodeRig({
		labels: ['hadoku-builder'],
		maxConcurrent: 3,
		minFreeMb: 2048,
		slice: { unitMaxMb: 4096 },
	});
	const res = await dispatchEphemeral(
		r.input as never,
		'tok',
		GH,
		(async () => '9000') as never, // free only; no total column
		r.run as never
	);
	assert.equal(res, null, 'no usable node is "could not look", never a quiet zero');
	assert.equal(r.seen.length, 0, 'and nothing is dispatched at a guessed ceiling');
});

test('the estimate can never silently exceed the cap it is reserving against', async () => {
	// A p95 above MemoryMax would admit jobs the unit will then OOM-kill. The
	// manifest is operator-edited, so this is a real way to be wrong.
	const r = nodeRig({
		labels: ['hadoku-builder'],
		maxConcurrent: 3,
		minFreeMb: 2048,
		slice: { unitMaxMb: 4096 },
		jobP95Mb: 9000,
	});
	await dispatchEphemeral(r.input as never, 'tok', GH, r.sh as never, r.run as never);
	const req = r.seen[0].nodes?.[0].requiredMb ?? 0;
	assert.ok(req <= (r.seen[0].cap ?? 0), `estimate ${req} must not exceed cap ${r.seen[0].cap}`);
});

// --- the reserve is per REPO (Wave 3g J2) -----------------------------------
//
// The memory axis is the repo: 3d J measured a 35 % cross-node spread against
// 423 % across repos on one node. The node's hand-set `jobP95Mb` was 3,400 on
// claw-1/2/3 for every job, while the measured per-repo p95 ran from 423 MB
// (hadoku-registry) to 6,313 MB (brave-quartet) on 2026-09-18.

const CAP = 13_952;
const PYGMALION = { mb: 975, basis: 'measured', runs: 156 } as const;

test("the queued run's REPO figure answers first, and says so", () => {
	assert.deepEqual(jobReserve({ repoReserve: PYGMALION, nodeJobP95Mb: 3400, capMb: CAP }), {
		mb: 975,
		from: 'repo',
		lowerBound: false,
	});
});

test('a repo on the fleet p95 is still the repo answer — the node value does not override it', () => {
	const r = jobReserve({
		repoReserve: { mb: 3145, basis: 'fleet-p95', runs: 2 },
		nodeJobP95Mb: 3400,
		capMb: CAP,
	});
	assert.deepEqual(r, { mb: 3145, from: 'repo', lowerBound: false });
});

test("no repo figure: the node's hand-set value, then the default", () => {
	assert.deepEqual(jobReserve({ nodeJobP95Mb: 3400, capMb: CAP }), {
		mb: 3400,
		from: 'node',
		lowerBound: false,
	});
	assert.deepEqual(jobReserve({ repoReserve: null, capMb: CAP }), {
		mb: JOB_RESERVE_DEFAULT_MB,
		from: 'default',
		lowerBound: false,
	});
	// A figure that is not a positive number is not an answer. A zero reserve
	// would admit without limit on a node the count cap alone does not protect.
	assert.deepEqual(jobReserve({ repoReserve: { mb: 0, basis: 'measured', runs: 9 }, capMb: CAP }), {
		mb: JOB_RESERVE_DEFAULT_MB,
		from: 'default',
		lowerBound: false,
	});
});

test('the clamp holds whichever answer won, and does not rewrite `from`', () => {
	const r = jobReserve({
		repoReserve: { mb: 6313, basis: 'measured', runs: 8 },
		nodeJobP95Mb: 3400,
		capMb: 6000,
	});
	assert.deepEqual(r, { mb: 6000, from: 'repo', lowerBound: false });
});

// --- #76: a lower-bound reserve is passed through UNCLAMPED ----------------

test('#76: a lower-bound repo reserve is NOT clamped to the cap — the whole point is to see it exceed one', () => {
	const r = jobReserve({
		repoReserve: { mb: 6313, basis: 'fleet-p95', runs: 3, lowerBound: true },
		nodeJobP95Mb: 3400,
		capMb: 4096, // a smaller node's cap — clamping would hide the mismatch
	});
	assert.deepEqual(r, { mb: 6313, from: 'repo', lowerBound: true });
});

test('#76: an ordinary (non-lower-bound) reserve is still clamped exactly as before', () => {
	const r = jobReserve({
		repoReserve: { mb: 6313, basis: 'measured', runs: 40 },
		nodeJobP95Mb: 3400,
		capMb: 4096,
	});
	assert.deepEqual(r, { mb: 4096, from: 'repo', lowerBound: false });
});

test('ADMISSION reads the repo figure: a light repo fits where the node value refuses', () => {
	// The PRIMITIVES, not the wiring: `jobReserve`'s answer, handed to `admitMint`
	// directly. 4,000 MB free against a 1,536 MB floor: the node's 3,400 leaves
	// 600 and is refused, pygmalion's measured 975 leaves 3,025 and is admitted.
	// Drop the repo branch from `jobReserve` and the first assertion fails —
	// that is this lane's mutation.
	const node = { ...BASE, freeMb: 4000, minFreeMb: 1536 };
	const light = jobReserve({ repoReserve: PYGMALION, nodeJobP95Mb: 3400, capMb: CAP });
	assert.equal(admitMint({ ...node, requiredMb: light.mb }).ok, true, 'the repo figure admits');
	const byNode = jobReserve({ nodeJobP95Mb: 3400, capMb: CAP });
	assert.equal(admitMint({ ...node, requiredMb: byNode.mb }).ok, false, 'the node value refuses');
	// And the other direction: a HEAVY repo reserves more than the node's value,
	// so a node with room for 3,400 no longer takes it — IF production actually
	// hands admission that heavier number. (It does, in `dispatchEphemeral`'s
	// wiring, ONLY when the repo's reserve is `lowerBound: true` — see the
	// `requiredMbByRepo` tests below and in placement.test.ts. An ORDINARY
	// measured repo, however heavy, does not reach this path — this is still the
	// admitMint PRIMITIVE's behaviour given a number, not a claim about which
	// repos get one in production.)
	const heavy = jobReserve({
		repoReserve: { mb: 6313, basis: 'measured', runs: 8 },
		nodeJobP95Mb: 3400,
		capMb: CAP,
	});
	assert.equal(admitMint({ ...BASE, freeMb: 7000, requiredMb: byNode.mb }).ok, true);
	assert.equal(admitMint({ ...BASE, freeMb: 7000, requiredMb: heavy.mb }).ok, false);
});

// --- requiredMbByRepo is built ONLY from PROVEN lower bounds (#76, scoped) --

test('dispatchEphemeral: an ORDINARY repo reserve never enters requiredMbByRepo at all', async () => {
	const r = nodeRig(
		{ labels: ['hadoku-builder'], maxConcurrent: 3, minFreeMb: 2048, jobP95Mb: 2970 },
		['WolffM/measured-heavy', 'WolffM/measured-light']
	);
	await dispatchEphemeral(
		r.input as never,
		'tok',
		GH,
		r.sh as never,
		r.run as never,
		new Map([
			['WolffM/measured-heavy', { mb: 9000, basis: 'measured', runs: 40, lowerBound: false }],
			['WolffM/measured-light', { mb: 100, basis: 'measured', runs: 40, lowerBound: false }],
		])
	);
	const byRepo = r.seen[0].nodes?.[0].requiredMbByRepo;
	assert.equal(
		byRepo?.has('WolffM/measured-heavy'),
		false,
		'above the node figure, still no entry'
	);
	assert.equal(
		byRepo?.has('WolffM/measured-light'),
		false,
		'below the node figure, still no entry'
	);
});

test('dispatchEphemeral: a LOWER-BOUND repo reserve DOES enter requiredMbByRepo, as the raw floor', async () => {
	const r = nodeRig(
		{ labels: ['hadoku-builder'], maxConcurrent: 3, minFreeMb: 2048, jobP95Mb: 2970 },
		['WolffM/brave-quartet']
	);
	await dispatchEphemeral(
		r.input as never,
		'tok',
		GH,
		r.sh as never,
		r.run as never,
		new Map([['WolffM/brave-quartet', { mb: 6313, basis: 'fleet-p95', runs: 3, lowerBound: true }]])
	);
	const entry = r.seen[0].nodes?.[0].requiredMbByRepo?.get('WolffM/brave-quartet');
	assert.deepEqual(entry, { mb: 6313, lowerBound: true });
});

test('loadRepoReserves reads facets[repo].jobP95Mb and nothing else', () => {
	const dir = mkdtempSync(join(tmpdir(), 'reserves-'));
	try {
		const path = join(dir, 'fleet-runner-coverage.json');
		writeFileSync(
			path,
			JSON.stringify({
				repos: ['WolffM/a', 'WolffM/b', 'WolffM/c'],
				facets: {
					'WolffM/a': { uiApp: true, jobP95Mb: { mb: 975, basis: 'measured', runs: 156 } },
					'WolffM/b': { jobP95Mb: { mb: 3145, basis: 'fleet-p95', runs: 2 } },
					'WolffM/c': { uiApp: true },
				},
			})
		);
		const m = loadRepoReserves(path);
		assert.deepEqual(m.get('WolffM/a'), {
			mb: 975,
			basis: 'measured',
			runs: 156,
			lowerBound: false,
		});
		assert.deepEqual(m.get('WolffM/b'), {
			mb: 3145,
			basis: 'fleet-p95',
			runs: 2,
			lowerBound: false,
		});
		assert.equal(m.has('WolffM/c'), false, 'no figure is no entry — the node answers for it');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('an unreadable roster is an EMPTY map — every job falls to the node, none to zero', () => {
	const m = loadRepoReserves(join(tmpdir(), 'no-such-dir-j2', 'fleet-runner-coverage.json'));
	assert.equal(m.size, 0);
});

test('#76: loadRepoReserves reads lowerBound, and false is explicit rather than merely absent', () => {
	const dir = mkdtempSync(join(tmpdir(), 'reserves-lb-'));
	try {
		const path = join(dir, 'fleet-runner-coverage.json');
		writeFileSync(
			path,
			JSON.stringify({
				repos: ['WolffM/brave-quartet', 'WolffM/plain'],
				facets: {
					'WolffM/brave-quartet': {
						jobP95Mb: { mb: 6313, basis: 'fleet-p95', runs: 3, lowerBound: true },
					},
					'WolffM/plain': { jobP95Mb: { mb: 1000, basis: 'measured', runs: 40 } },
				},
			})
		);
		const m = loadRepoReserves(path);
		assert.equal(m.get('WolffM/brave-quartet')?.lowerBound, true);
		assert.equal(
			m.get('WolffM/plain')?.lowerBound,
			false,
			'absent in the file reads as false, not undefined'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- a mint never targets a guest (Wave 3g J2) --------------------------------

test('withoutGuests drops a guest the manifest marked ephemeral, and nothing else', () => {
	const input = {
		fleetProbe: new Map(),
		ephemeral: new Set(['claw-3', 'hokon']),
		nodes: { 'claw-3': { role: 'claw' }, hokon: { role: 'guest' } },
		isSick: () => false,
		repos: [],
	};
	assert.deepEqual([...withoutGuests(input).ephemeral], ['claw-3']);
	const clean = { ...input, ephemeral: new Set(['claw-3']) };
	assert.equal(withoutGuests(clean), clean, 'no guest, no copy');
});

test('a guest marked ephemeral is never probed or minted on', async () => {
	// The whole tick, not the helper: a guest in the ephemeral set must not see
	// even the `free -m` ssh. hokon is not `ephemeral: true` today — this is the
	// manifest edit that would otherwise have minted on the production host.
	const r = nodeRig({ labels: ['hadoku-builder'], maxConcurrent: 3, minFreeMb: 2048 });
	const input = {
		...r.input,
		fleetProbe: new Map([
			['claw-3', { reachable: true, busyRepos: new Map() }],
			['hokon', { reachable: true, busyRepos: new Map() }],
		]),
		ephemeral: new Set(['claw-3', 'hokon']),
		nodes: { ...r.input.nodes, hokon: { role: 'guest', labels: ['hadoku-builder'] } },
	};
	const touched: string[] = [];
	const sh = async (n: string, cmd: string) => {
		touched.push(n);
		return r.sh(n, cmd);
	};
	await dispatchEphemeral(input as never, 'tok', GH, sh as never, r.run as never);
	assert.equal(touched.includes('hokon'), false, 'no ssh reaches the guest');
	assert.deepEqual(
		r.seen[0].nodes?.map((n) => (n as unknown as { name: string }).name),
		['claw-3'],
		'and it is not a placement candidate'
	);
});

// --- an ON-DEMAND guest is minted for, last and gated (#120) -----------------
//
// Operator, 2026-10-19: "the runners get brought online the same way the JIT
// process does. not having standing runners squatting on ram." The guest is
// still never general capacity — it stays out of `ephemeral`, out of the warm
// cache, and out of the census — but it is a mint TARGET: for the work only its
// labels fit, and for `hadoku-builder` while the backstop holds it.

const HOKON_ON_DEMAND = {
	role: 'guest',
	mint: 'on-demand',
	labels: ['pm2-host', 'taskauto'],
	maxConcurrent: 4,
	minFreeMb: 8192,
	slice: { name: 'ci-runner.slice', maxMb: 16384, unitMaxMb: 8192 },
};

function guestRig() {
	const r = nodeRig({ labels: ['hadoku-builder'], maxConcurrent: 3, minFreeMb: 2048 });
	const input = {
		...r.input,
		fleetProbe: new Map([
			['claw-3', { reachable: true, busyRepos: new Map() }],
			['hokon', { reachable: true, busyRepos: new Map() }],
		]),
		nodes: { ...r.input.nodes, hokon: HOKON_ON_DEMAND },
	};
	const calls: {
		order: string[];
		labelsFor: (n: string) => string[];
		cap: number;
		slice: unknown;
	}[] = [];
	const run = async (i: {
		order: string[];
		labelsFor: (n: string) => string[];
		memoryMaxMbFor: (r: string, n: string) => number;
		sliceNameFor?: (n: string) => string | null | undefined;
	}) => {
		calls.push({
			order: i.order,
			labelsFor: i.labelsFor,
			cap: i.memoryMaxMbFor('WolffM/hadoku_site', 'hokon'),
			slice: i.sliceNameFor?.('hokon'),
		});
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	};
	// hokon: 40 GB available of 61 GB installed — far more than its allowance.
	const sh = async (n: string, cmd: string) =>
		n === 'hokon' ? (cmd.includes('$7, $2') ? '40000 61000' : '40000') : r.sh(n, cmd);
	return { input, run, sh, calls, claw: r };
}

test('#120: an on-demand guest is a mint target, placed AFTER every claw — even a BUSY one', async () => {
	const g = guestRig();
	// claw-3 running two jobs, hokon idle: a load-ranked order puts hokon FIRST,
	// which is the inverse of a backstop. The guest must still come last.
	g.input.fleetProbe = new Map([
		['claw-3', { reachable: true, busyRepos: new Map([['WolffM/hadoku_site', 2]]), workers: 2 }],
		['hokon', { reachable: true, busyRepos: new Map() }],
	]);
	setBackstopHold([]);
	await dispatchEphemeral(g.input as never, 'tok', GH, g.sh as never, g.run as never);
	assert.deepEqual(
		g.calls[0]?.order,
		['claw-3', 'hokon'],
		'the production host is the last resort'
	);
});

test('#120: the guest offers hadoku-builder ONLY while the backstop holds it', async () => {
	const g = guestRig();
	try {
		setBackstopHold([]);
		await dispatchEphemeral(g.input as never, 'tok', GH, g.sh as never, g.run as never);
		const unheld = g.calls[0]!.labelsFor('hokon');
		assert.ok(unheld.includes('taskauto'), 'its own work is always minted for');
		assert.equal(unheld.includes('hadoku-builder'), false, "general CI is the backstop's to grant");
		assert.ok(g.calls[0]!.labelsFor('claw-3').includes('hadoku-builder'), 'a claw is unaffected');

		setBackstopHold(['hokon']);
		await dispatchEphemeral(g.input as never, 'tok', GH, g.sh as never, g.run as never);
		assert.ok(g.calls[1]!.labelsFor('hokon').includes('hadoku-builder'), 'promoted = offered');
	} finally {
		setBackstopHold([]);
	}
});

test('a backstop demotion MID-TICK cannot strip a label from a mint placement already chose (2026-10-23)', async () => {
	const g = guestRig();
	let placed: string[] = [];
	let minted: string[] = [];
	const run = async (i: {
		nodes: { name: string; labels?: string[] }[];
		labelsFor: (n: string) => string[];
	}) => {
		placed = i.nodes.find((n) => n.name === 'hokon')?.labels ?? [];
		// runner-health's demote lands between placement and the mint.
		setBackstopHold([]);
		minted = i.labelsFor('hokon');
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	};
	try {
		setBackstopHold(['hokon']);
		await dispatchEphemeral(g.input as never, 'tok', GH, g.sh as never, run as never);
		assert.ok(placed.includes('hadoku-builder'), 'placement saw the promoted offer');
		assert.deepEqual(minted, placed, 'the mint registers exactly what placement matched on');
	} finally {
		setBackstopHold([]);
	}
});

test('#120: a guest unit is capped at its OWN unitMaxMb inside its allowance, in its OWN slice', async () => {
	const g = guestRig();
	await dispatchEphemeral(g.input as never, 'tok', GH, g.sh as never, g.run as never);
	// The claw rule (MemTotal − minFreeMb) would read 61000 − 8192 here and hand
	// one job ~52 GB of the production host.
	assert.equal(g.calls[0]?.cap, 8192);
	assert.equal(g.calls[0]?.slice, 'ci-runner.slice');
});

test('guestUnitMemoryMaxMb: the declared cap, clamped to the allowance, never zero', () => {
	assert.equal(guestUnitMemoryMaxMb({ requestedMb: 8192, sliceMaxMb: 16384 }), 8192);
	assert.equal(guestUnitMemoryMaxMb({ requestedMb: 32768, sliceMaxMb: 16384 }), 16384);
	assert.equal(guestUnitMemoryMaxMb({ sliceMaxMb: 16384 }), JOB_RESERVE_DEFAULT_MB);
	assert.equal(guestUnitMemoryMaxMb({ requestedMb: 0, sliceMaxMb: null }), JOB_RESERVE_DEFAULT_MB);
});

test('#120: a guest WITHOUT mint: on-demand is still never minted on', async () => {
	const g = guestRig();
	g.input.nodes = { ...g.input.nodes, hokon: { ...HOKON_ON_DEMAND, mint: 'always' } };
	const touched: string[] = [];
	const sh = async (n: string, cmd: string) => {
		touched.push(n);
		return g.sh(n, cmd);
	};
	await dispatchEphemeral(g.input as never, 'tok', GH, sh as never, g.run as never);
	assert.equal(touched.includes('hokon'), false, 'only the exact value opts a guest in');
	assert.deepEqual(g.calls[0]?.order, ['claw-3']);
});

// --- warm-cache selection (issue #16) ----------------------------------------
//
// `planWarmCache` used to fill by last-served MRU, and MRU chases the repo that
// just went quiet: on 2026-09-08 claw-1 rotated seven times in fifty minutes
// through repos that then produced nothing, and 8 of 15 settled fills served
// zero jobs. The signal is now decayed recent frequency over the node's own
// history. The locks did not change and the tests below check that they did
// not: neither a busy listener nor one inside the assign window may be rotated,
// whatever the score says.

/** `n` jobs of `repo`, all at `atMs`. */
const served = (repo: string, atMs: number, n = 1): WarmServedJob[] =>
	Array.from({ length: n }, () => ({ repo, startedAtMs: atMs }));

const NOW = 1_800_000_000_000;
const SITE = 'WolffM/hadoku_site';
const MEET = 'WolffM/hadoku-rally';

test('the window/half-life ratio is what makes "one never outvotes fifty" true', () => {
	// Issue #16's requirement is absolute ("never"), so it has to hold for the
	// worst placement, not the average one: the single job as recent as possible
	// and the fifty as old as the window allows. A job at the far edge weighs
	// 2^-(window/halfLife) of a fresh one, so one fresh job can outrank at most
	// 2^(window/halfLife) old ones. Anything below 50 satisfies the issue; the
	// shipped constants give 16.
	const ratio = 2 ** (WARM_HISTORY_WINDOW_MS / WARM_HALF_LIFE_MS);
	assert.ok(ratio < 50, `one fresh job may outrank at most ${ratio} old ones; issue #16 needs <50`);
	assert.equal(ratio, 16, 'the shipped 6h/90min pair — change both together or this bound moves');
});

test('warmTargetRepo: fifty jobs at the edge of the window outvote one at its start', () => {
	const jobs = [
		...served(SITE, NOW - WARM_HISTORY_WINDOW_MS, 50),
		...served(MEET, NOW, 1), // the freshest job in the window, and still loses
	];
	assert.equal(warmTargetRepo(jobs, NOW), SITE);
});

test('warmRepoScores: a job older than the window carries no weight at all', () => {
	const jobs = [
		...served(SITE, NOW - WARM_HISTORY_WINDOW_MS - 1000, 40),
		...served(MEET, NOW - 60_000, 1),
	];
	const scores = warmRepoScores(jobs, NOW);
	assert.equal(scores.has(SITE), false, 'out of the window is out of the vote, not down-weighted');
	assert.equal(warmTargetRepo(jobs, NOW), MEET);
});

test('warmTargetRepo: nothing in the window is null, never a guess', () => {
	assert.equal(warmTargetRepo([], NOW), null);
	assert.equal(warmTargetRepo(served(SITE, NOW - 48 * 3600_000, 500), NOW), null);
});

test('warmTargetRepo: a tie goes to the repo already in the slot', () => {
	// A tie is not a reason to pay a DELETE, a registration-token POST and a
	// provisioning ssh.
	const jobs = [...served(SITE, NOW - 1000), ...served(MEET, NOW - 1000)];
	assert.equal(warmTargetRepo(jobs, NOW, { preferRepo: MEET }), MEET);
	assert.equal(warmTargetRepo(jobs, NOW, { preferRepo: SITE }), SITE);
});

test('planWarmCache: one job from a quiet repo does not evict the busy one (issue #16)', () => {
	// The exact shape of claw-1's 2026-09-08 rotation storm: hadoku_site had been
	// firing all hour, one hadoku-rally job landed, and MRU rotated the slot onto
	// a repo that then served nothing for the next fifty minutes.
	const jobs = [
		...Array.from({ length: 40 }, (_, k) => ({
			repo: SITE,
			startedAtMs: NOW - (k + 1) * 90_000, // one a minute and a half, for an hour
		})),
		{ repo: MEET, startedAtMs: NOW - 5_000 }, // the most recent job, by a mile
	];
	const d = planWarmCache({
		current: { repo: SITE, busy: false, mintedOrRefreshedAtMs: NOW - 3600_000 },
		served: jobs,
		nowMs: NOW,
	});
	assert.deepEqual(d, { action: 'keep' }, 'frequency wins; the slot stays where the work is');
});

test('SAFETY: mutating the half-life to zero brings MRU — and the bug — straight back', () => {
	// This test is the guard on the decay itself. `halfLifeMs: 0` is the limit of
	// the formula, not a special case: with no decay time only the single most
	// recent job carries weight, so the argmax is the last-served repo, which is
	// exactly what `planWarmCache` did before issue #16. If a future change makes
	// zero mean something else — "no decay", say, so every job weighs 1 and the
	// rule silently becomes unweighted counting over the window — this test is
	// what notices.
	const jobs = [...served(SITE, NOW - 600_000, 40), { repo: MEET, startedAtMs: NOW - 5_000 }];
	const current = { repo: SITE, busy: false, mintedOrRefreshedAtMs: NOW - 3600_000 };

	// Shipped half-life: frequency wins.
	assert.deepEqual(planWarmCache({ current, served: jobs, nowMs: NOW }), { action: 'keep' });

	// Half-life zero: MRU returns, and with it the rotation onto a repo with one
	// job to its name.
	assert.deepEqual(planWarmCache({ current, served: jobs, nowMs: NOW, halfLifeMs: 0 }), {
		action: 'rotate',
		from: SITE,
		to: MEET,
	});

	// And it is genuinely MRU, not just "the newest repo sometimes wins": swap
	// which repo is most recent and the answer follows it, 40 jobs or not.
	assert.equal(
		warmTargetRepo([...served(MEET, NOW - 600_000, 40), { repo: SITE, startedAtMs: NOW }], NOW, {
			halfLifeMs: 0,
		}),
		SITE
	);
});

test('planWarmCache: the busy lock still beats the score', () => {
	const jobs = [...served(MEET, NOW - 1000, 50), ...served(SITE, NOW - 2000, 1)];
	const d = planWarmCache({
		current: { repo: SITE, busy: true, mintedOrRefreshedAtMs: NOW - 3600_000 },
		served: jobs,
		nowMs: NOW,
	});
	assert.deepEqual(d, { action: 'locked' }, 'a listener holding a job is never evicted');
});

test('planWarmCache: the assign window still beats the score', () => {
	const jobs = [...served(MEET, NOW - 1000, 50), ...served(SITE, NOW - 2000, 1)];
	const d = planWarmCache({
		current: {
			repo: SITE,
			busy: false,
			mintedOrRefreshedAtMs: NOW - (WARM_ASSIGN_WINDOW_MS - 1000),
		},
		served: jobs,
		nowMs: NOW,
	});
	assert.deepEqual(
		d,
		{ action: 'locked' },
		'idle-but-assigned is the gap the second clause covers'
	);
});

test('planWarmCache: an empty window keeps the slot rather than evicting it', () => {
	const d = planWarmCache({
		current: { repo: SITE, busy: false, mintedOrRefreshedAtMs: NOW - 3600_000 },
		served: served(MEET, NOW - 48 * 3600_000, 10),
		nowMs: NOW,
	});
	assert.deepEqual(d, { action: 'idle' }, 'no signal is not a reason to throw away a warm slot');
});

test('planWarmCache: no slot yet fills with the scored target, not the last-served one', () => {
	const jobs = [...served(SITE, NOW - 3600_000, 30), { repo: MEET, startedAtMs: NOW - 1_000 }];
	assert.deepEqual(planWarmCache({ current: null, served: jobs, nowMs: NOW }), {
		action: 'fill',
		repo: SITE,
	});
});

// --- warm-served jobs carry assignSec (issue #15) ----------------------------

test('ingestRuns: a warm-served job carries assignSec, and the halves sum', async () => {
	// P4's number — how long GitHub takes to hand a job to a listener that is
	// ALREADY long-polling — was unmeasurable because the dispatch/assign split
	// was gated on a `jit-` name's mint epoch, and a warm name carries none.
	// 298 warm records existed on 2026-09-09 and not one had an assignSec.
	const tmp = mkdtempSync(join(tmpdir(), 'warm-assign-'));
	try {
		__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
		__resetJobHistoryForTesting();
		__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
		const t = Date.now() - 2 * 3600_000;
		const iso = (sec: number) => new Date(t + sec * 1000).toISOString();
		await ingestRuns('WolffM/hadoku_site', [{ id: 91, status: 'completed' }], () =>
			Promise.resolve({
				jobs: [
					{
						id: 9101,
						name: 'check',
						runner_name: 'warm-claw-3-hadoku_site',
						labels: ['self-hosted', 'hadoku-builder'],
						created_at: iso(0),
						started_at: iso(4),
						completed_at: iso(40),
						conclusion: 'success',
					},
				],
			})
		);
		const r = jobRecords().find((x) => x.jobId === 9101);
		assert.equal(r?.queueSec, 4);
		assert.equal(r?.dispatchSec, 0, 'a standing listener predates the job — nothing was minted');
		assert.equal(r?.assignSec, 4, 'so the whole wait is GitHub assigning');
		assert.equal((r?.dispatchSec ?? -1) + (r?.assignSec ?? -1), r?.queueSec, 'the halves sum');
	} finally {
		__setHistoryPathForTesting(null);
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('ingestRuns: a plain standing runner still gets NEITHER half', async () => {
	// The warm branch keys on the `warm-` prefix, not on "has no mint epoch". A
	// resident runner has no mint either, and reporting 0 for it would claim the
	// dispatcher acted instantly on a job it never touched.
	const tmp = mkdtempSync(join(tmpdir(), 'warm-assign-'));
	try {
		__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
		__resetJobHistoryForTesting();
		__setHistoryPathForTesting(join(tmp, 'job-history.jsonl'));
		const t = Date.now() - 2 * 3600_000;
		const iso = (sec: number) => new Date(t + sec * 1000).toISOString();
		await ingestRuns('WolffM/hadoku_site', [{ id: 92, status: 'completed' }], () =>
			Promise.resolve({
				jobs: [
					{
						id: 9201,
						name: 'check',
						runner_name: 'claw-3',
						labels: ['self-hosted', 'hadoku-builder'],
						created_at: iso(0),
						started_at: iso(4),
						completed_at: iso(40),
						conclusion: 'success',
					},
				],
			})
		);
		const r = jobRecords().find((x) => x.jobId === 9201);
		assert.equal(r?.dispatchSec, undefined);
		assert.equal(r?.assignSec, undefined);
	} finally {
		__setHistoryPathForTesting(null);
		rmSync(tmp, { recursive: true, force: true });
	}
});
