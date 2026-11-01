import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JIT_PREFIX } from '../runners/ephemeral.js';
import { LOWER_BOUND_HEADROOM } from '../runners/ephemeral.js';
import { MAX_RUNNER_NAME } from '../runners/ephemeral.js';
import { TMP_FREE_FLOOR_MB } from '../runners/ephemeral.js';
import { WORK_FREE_FLOOR_MB } from '../runners/ephemeral.js';
import { admitMint } from '../runners/ephemeral.js';
import { assertSafeJitConfig } from '../runners/ephemeral.js';
import { jitRunnerName } from '../runners/ephemeral.js';
import { parseJitName } from '../runners/ephemeral.js';
import { slotDir } from '../runners/ephemeral.js';
import { choosePlacement, type NodeState } from '../runners/placement.js';
import { nodeOf } from '../runners/census.js';
import { BASE } from './helpers/ephemeral-rig.js';

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
