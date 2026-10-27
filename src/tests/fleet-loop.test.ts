/**
 * The fast loop: probe, quarantine and repair, converge standing labels, hand
 * the dispatcher its input.
 *
 * The tier ladder this file used to test was retired on 2026-09-21. Under
 * `carousel` every claw tier was forced on, guests were skipped and the
 * saturation signal was a constant, so it decided nothing; its tests went with
 * it. What is tested here is what the loop still decides.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, hostname } from 'node:os';

import {
	dispatchBetweenTicks,
	__resetDispatchInputForTesting,
	__setDispatchInputForTesting,
	tickFleet,
	RECONCILE_EVERY_TICKS,
	__resetFleetLoopForTesting,
	recordDispatch,
	getDispatchSnapshot,
	probeNode,
	probeFleet,
	markNodeSick,
	nodeIsSick,
	sickNodeNames,
	repairSickNode,
	doctorCommand,
	runDoctor,
	__resetSickForTesting,
	__parseProbeForTesting,
	__PROBE_CMD_FOR_TESTING,
	loadClawNodes,
	loadResidentRepos,
	nodeFailsBootcamp,
	startFastLoop,
	__setFastLoopTokenRetryForTesting,
} from '../fleet-loop.js';
import { __resetReservationForTesting } from '../node-reservation.js';
import type { DispatchPassResult } from '../runners/dispatch-pass.js';
import type { EphemeralTickInput } from '../runners/ephemeral-tick.js';
import { setBackstopHold } from '../runners/backstop-hold.js';
import { writeDrain } from '../runners/drain.js';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmpdir.js';
import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';

// ── rig ─────────────────────────────────────────────────────────────────────

/**
 * Run `fn` against a throwaway fleet: its own manifest dir and state dir, so no
 * test here depends on the shared fixture or on the operator's real files.
 */
async function withFleet(
	machines: Record<string, Record<string, unknown>>,
	fn: () => Promise<void> | void
): Promise<void> {
	const root = tempDir('fleet-loop-');
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'fleet-runner-manifest.json'), JSON.stringify({ machines }));
	__setHostForTesting({
		...testHost,
		logger: { info() {}, warn() {}, error() {} },
		manifestDir: root,
		stateDir: root,
	} as never);
	__resetFleetLoopForTesting();
	__resetSickForTesting();
	__resetReservationForTesting();
	setBackstopHold([]);
	try {
		await fn();
	} finally {
		// Restore the AMBIENT test host, not null: every other test relies on
		// `install-test-host.ts`'s preload staying installed.
		__setHostForTesting(testHost);
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * A STATEFUL GitHub stub. Every covered repo lists one runner per node in
 * `nodes`, with ids that DIFFER PER REPO — runner ids are repo-scoped, and a
 * stub that reused one id everywhere could never catch a write aimed at the
 * wrong repo. Writes change what the next listing reports, so change detection
 * and drift are tested against a GitHub that remembers; `strip` is a change
 * made OUTSIDE the loop.
 */
function ghStub(nodes: string[], withBuilder: string[] = []) {
	const reads: string[] = [];
	const writes: { method: string; repo: string; id: number }[] = [];
	const idFor = (repo: string, node: string) => repo.length * 1000 + nodes.indexOf(node) + 1;
	/** `${repo}#${node}` for every registration carrying the builder label. */
	const labelled = new Set<string>();
	const seeded = new Set<string>();
	const seed = (repo: string) => {
		if (seeded.has(repo)) return;
		seeded.add(repo);
		for (const n of withBuilder) labelled.add(`${repo}#${n}`);
	};
	return {
		reads,
		writes,
		idFor,
		/** Remove the label from `node` everywhere, as a human or another tool would. */
		strip: (node: string) => {
			for (const k of [...labelled]) if (k.endsWith(`#${node}`)) labelled.delete(k);
		},
		gh: {
			get: async (path: string, _token: string, repo?: string) => {
				reads.push(`${repo ?? ''}${path}`);
				if (!path.includes('/actions/runners')) return null;
				seed(repo ?? '');
				return {
					runners: nodes.map((n) => ({
						id: idFor(repo ?? '', n),
						name: n,
						labels: labelled.has(`${repo ?? ''}#${n}`) ? [{ name: 'hadoku-builder' }] : [],
					})),
				};
			},
			write: async (
				method: 'POST' | 'DELETE',
				path: string,
				_t: string,
				_b?: unknown,
				repo?: string
			) => {
				const id = Number(/runners\/(\d+)\/labels/.exec(path)?.[1]);
				writes.push({ method, repo: repo ?? '', id });
				const node = nodes.find((n) => idFor(repo ?? '', n) === id);
				if (node) {
					if (method === 'POST') labelled.add(`${repo ?? ''}#${node}`);
					else labelled.delete(`${repo ?? ''}#${node}`);
				}
				return { ok: true, status: 200 };
			},
		},
	};
}

const noDispatch = async (): Promise<DispatchPassResult> => ({
	minted: 0,
	failed: 0,
	skipped: 0,
	inFlight: 0,
	reaped: 0,
});
/** A repair that always fails, so a test can never release a node by ssh-ing production. */
const noRepair = async () => false;
const idle = async () => ({ workers: 0, cores: 8 });
function sickProbe(sick: string[] = [], unreachable: string[] = []) {
	return async (node: string) =>
		unreachable.includes(node) ? null : { workers: 0, cores: 8, sick: sick.includes(node) };
}
const notReserved = () => ({ reserved: false, reason: null, detail: null });

/** One tick with every side-effecting seam stubbed; `opts` overrides the ones a test cares about. */
function tick(
	gh: ReturnType<typeof ghStub>['gh'],
	opts: {
		probe?: Parameters<typeof tickFleet>[2];
		dispatch?: Parameters<typeof tickFleet>[6];
		ephemeral?: ReadonlySet<string>;
		guests?: ReadonlySet<string>;
	} = {}
) {
	return tickFleet(
		'tok',
		gh,
		opts.probe ?? idle,
		false,
		notReserved,
		noRepair,
		opts.dispatch ?? noDispatch,
		opts.ephemeral ?? new Set(),
		opts.guests ?? new Set()
	);
}

/** Captures the dispatch input the tick built, so a test can read it. */
function capturingDispatch() {
	const seen: EphemeralTickInput[] = [];
	const dispatch = (async (input: EphemeralTickInput) => {
		seen.push(input);
		return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
	}) as Parameters<typeof tickFleet>[6];
	return { seen, dispatch };
}

// ── the label rule: builder = safe, nothing else ────────────────────────────

test('labels: a SAFE standing node is promoted — there is no throughput input any more', async () => {
	await withFleet({ 'claw-1': { role: 'claw' } }, async () => {
		const s = ghStub(['claw-1']);
		await tick(s.gh);
		assert.ok(s.writes.length > 0, 'an unlabelled safe node must be labelled');
		assert.ok(s.writes.every((w) => w.method === 'POST'));
	});
});

test('labels: a GUEST is never written by the fast loop — the backstop owns its label', async () => {
	// One writer per label. The ladder and the backstop fighting over hokon is
	// what put general CI on the production host on 2026-09-01.
	await withFleet({ hokon: { role: 'guest' } }, async () => {
		const s = ghStub(['hokon'], ['hokon']);
		await tick(s.gh, { guests: new Set(['hokon']) });
		assert.deepEqual(s.writes, [], 'not promoted, and not stripped either');
		assert.deepEqual(s.reads, [], 'not even listed');
	});
});

test('labels: a QUARANTINED node is stripped, even one that would otherwise be promoted', async () => {
	await withFleet({ 'claw-2': { role: 'claw' } }, async () => {
		const s = ghStub(['claw-2'], ['claw-2']);
		await tick(s.gh, { probe: sickProbe(['claw-2']) });
		assert.ok(nodeIsSick('claw-2'), 'the probe verdict quarantines the node');
		assert.ok(s.writes.length > 0 && s.writes.every((w) => w.method === 'DELETE'));
	});
});

test('labels: a DRAINED node is stripped', async () => {
	await withFleet({ 'claw-2': { role: 'claw' } }, async () => {
		writeDrain({ 'claw-2': { since: 's', reason: 'DRAM', by: 'hadoku' } });
		const s = ghStub(['claw-2'], ['claw-2']);
		await tick(s.gh);
		assert.ok(s.writes.length > 0 && s.writes.every((w) => w.method === 'DELETE'));
	});
});

test('labels: an ephemeral node with NO residents writes nothing and lists nothing', async () => {
	await withFleet({ 'claw-3': { ephemeral: true } }, async () => {
		const s = ghStub(['claw-3']);
		await tick(s.gh, { ephemeral: new Set(['claw-3']) });
		assert.deepEqual(s.writes, []);
		assert.deepEqual(s.reads, [], 'the O(repos x nodes) walk is exactly what the skip avoids');
	});
});

test("labels: an ephemeral node's RESIDENT registration is promoted, and ONLY its repo is walked", async () => {
	await withFleet(
		{ 'claw-1': { ephemeral: true, residentRepos: ['WolffM/hadoku-fleet-manager'] } },
		async () => {
			const s = ghStub(['claw-1']);
			await tick(s.gh, { ephemeral: new Set(['claw-1']) });
			assert.deepEqual([...new Set(s.writes.map((w) => w.repo))], ['WolffM/hadoku-fleet-manager']);
			assert.ok(s.writes.every((w) => w.method === 'POST'));
		}
	);
});

test('labels: a demote that finds the label ALREADY GONE is converged, not a failed write', async () => {
	await withFleet({ 'claw-2': { role: 'claw' } }, async () => {
		const s = ghStub(['claw-2'], ['claw-2']);
		s.gh.write = async () => ({ ok: false, status: 404 });
		const r = await tick(s.gh, { probe: sickProbe(['claw-2']) });
		assert.deepEqual(r.actions, [], 'a 404 on DELETE is the state being converged to');
	});
});

test('labels: a PROMOTE that 404s is still a failed write', async () => {
	await withFleet({ 'claw-1': { role: 'claw' } }, async () => {
		const s = ghStub(['claw-1']);
		s.gh.write = async () => ({ ok: false, status: 404 });
		const r = await tick(s.gh);
		assert.ok(r.actions.some((a) => a.failed > 0));
	});
});

test('labels: every write lands on the repo whose listing produced its runner id', async () => {
	// Runner ids are REPO-SCOPED: writing repo A's id against repo B is a 404 at
	// best and someone else's runner at worst.
	await withFleet({ 'claw-1': { role: 'claw' }, 'claw-2': { role: 'claw' } }, async () => {
		const s = ghStub(['claw-1', 'claw-2']);
		await tick(s.gh);
		assert.ok(s.writes.length > 0);
		for (const w of s.writes) {
			assert.ok(
				['claw-1', 'claw-2'].some((n) => s.idFor(w.repo, n) === w.id),
				`write to ${w.repo} used id ${w.id}, which belongs to a different repo`
			);
		}
	});
});

// ── change detection and the periodic reconcile ─────────────────────────────

test('reconcile: a quiet second tick lists nothing and writes nothing', async () => {
	await withFleet({ 'claw-1': { role: 'claw' } }, async () => {
		const s = ghStub(['claw-1']);
		await tick(s.gh); // tick 0: the full reconcile
		s.reads.length = 0;
		s.writes.length = 0;
		await tick(s.gh);
		assert.deepEqual(s.reads, [], 'nothing changed, so no listing is paid for');
		assert.deepEqual(s.writes, []);
	});
});

test('reconcile: a node that TURNS unsafe is written on the very next tick', async () => {
	await withFleet({ 'claw-1': { role: 'claw' } }, async () => {
		const s = ghStub(['claw-1']);
		await tick(s.gh);
		s.writes.length = 0;
		markNodeSick('claw-1');
		await tick(s.gh);
		assert.ok(
			s.writes.some((w) => w.method === 'DELETE'),
			'a change is not deferred to the reconcile'
		);
	});
});

test('reconcile: drift from OUTSIDE the loop is healed on the reconcile tick', async () => {
	await withFleet({ 'claw-1': { role: 'claw' } }, async () => {
		const s = ghStub(['claw-1']);
		await tick(s.gh); // tick 0 labels claw-1, and believes it
		s.strip('claw-1'); // someone strips it by hand; the belief is now wrong
		s.writes.length = 0;
		for (let i = 1; i < RECONCILE_EVERY_TICKS; i++) await tick(s.gh);
		assert.equal(
			s.writes.length,
			0,
			'between reconciles the loop trusts its belief — the cost saving'
		);
		await tick(s.gh); // tick RECONCILE_EVERY_TICKS: full reconcile
		assert.ok(
			s.writes.some((w) => w.method === 'POST'),
			'the reconcile re-asserts the label'
		);
	});
});

test('reconcile: a FAILED write is not believed, so the next tick retries it', async () => {
	await withFleet({ 'claw-1': { role: 'claw' } }, async () => {
		const s = ghStub(['claw-1']);
		const ok = s.gh.write;
		s.gh.write = async () => ({ ok: false, status: 500 });
		await tick(s.gh);
		s.gh.write = ok;
		await tick(s.gh);
		assert.ok(
			s.writes.some((w) => w.method === 'POST'),
			'the retry happened without waiting for a reconcile'
		);
	});
});

// ── quarantine, through the tick ────────────────────────────────────────────

test('sick: quarantine survives a clean probe — only a repair lifts it', async () => {
	await withFleet({ 'claw-2': { role: 'claw' } }, async () => {
		markNodeSick('claw-2');
		const s = ghStub(['claw-2']);
		await tick(s.gh, { probe: sickProbe([]) });
		assert.ok(nodeIsSick('claw-2'), 'still retired until a repair says otherwise');
		assert.ok(!s.writes.some((w) => w.method === 'POST'), 'a retired node is never re-promoted');
	});
});

test('sick: UNREACHABLE is not SICK — silence must not retire a node', async () => {
	await withFleet({ 'claw-1': { role: 'claw' } }, async () => {
		await tick(ghStub(['claw-1']).gh, { probe: sickProbe([], ['claw-1']) });
		assert.equal(nodeIsSick('claw-1'), false, 'a box we cannot see makes no claim');
	});
});

test('sick: no floor — every damaged node is retired', async () => {
	await withFleet(
		{ 'claw-1': {}, 'claw-2': {}, 'claw-3': {}, hokon: { role: 'guest' } },
		async () => {
			await tick(ghStub(['claw-1', 'claw-2', 'claw-3', 'hokon']).gh, {
				probe: sickProbe(['claw-1', 'claw-2', 'claw-3']),
				guests: new Set(['hokon']),
			});
			assert.deepEqual(
				sickNodeNames(),
				['claw-1', 'claw-2', 'claw-3'],
				'keeping a known-bad node eligible to preserve a number is the wrong trade — ' +
					'CI_RUNNER already covers zero self-hosted capacity'
			);
		}
	);
});

test('capacity: the probe reports free slots against maxConcurrent, the one declared budget', async () => {
	await withFleet({ 'claw-1': { maxConcurrent: 3 } }, async () => {
		const { seen, dispatch } = capturingDispatch();
		await tick(ghStub(['claw-1']).gh, {
			probe: async () => ({ workers: 1, cores: 16 }),
			dispatch,
		});
		const p = seen[0]!.fleetProbe.get('claw-1') as unknown as { capacity: number; free: number };
		assert.equal(p.capacity, 3);
		assert.equal(p.free, 2);
	});
});

// ── the dispatcher hand-off ─────────────────────────────────────────────────

test('dispatch: called once per tick', async () => {
	await withFleet({ 'claw-1': {} }, async () => {
		const { seen, dispatch } = capturingDispatch();
		await tick(ghStub(['claw-1']).gh, { dispatch });
		assert.equal(seen.length, 1);
	});
});

test('dispatch: an all-JIT fleet hands over an EMPTY standing set, which removes the age gate', async () => {
	await withFleet({ 'claw-1': { ephemeral: true }, hokon: { role: 'guest' } }, async () => {
		const { seen, dispatch } = capturingDispatch();
		await tick(ghStub(['claw-1', 'hokon']).gh, {
			dispatch,
			ephemeral: new Set(['claw-1']),
			guests: new Set(['hokon']),
		});
		assert.deepEqual([...(seen[0]!.standingEligible ?? [])], []);
	});
});

test('dispatch: a guest counts as standing ONLY while the backstop has promoted it', async () => {
	// Derived from the backstop's own record, not from a belief about it — the
	// retired ladder's `activeTiers` said "tier4 is up" whether or not the
	// backstop had actually labelled hokon.
	await withFleet({ hokon: { role: 'guest' } }, async () => {
		const { seen, dispatch } = capturingDispatch();
		const gh = ghStub(['hokon']).gh;
		await tick(gh, { dispatch, guests: new Set(['hokon']) });
		assert.deepEqual([...(seen[0]!.standingEligible ?? [])], [], 'not promoted yet');
		setBackstopHold(['hokon']);
		await tick(gh, { dispatch, guests: new Set(['hokon']) });
		assert.deepEqual([...(seen[1]!.standingEligible ?? [])], ['hokon']);
	});
});

test('dispatch: a QUARANTINED guest is not standing, even while backstop-held', async () => {
	await withFleet({ hokon: { role: 'guest' } }, async () => {
		setBackstopHold(['hokon']);
		markNodeSick('hokon');
		const { seen, dispatch } = capturingDispatch();
		await tick(ghStub(['hokon']).gh, { dispatch, guests: new Set(['hokon']) });
		assert.deepEqual([...(seen[0]!.standingEligible ?? [])], []);
	});
});

// The dispatcher's result must REACH the panel (2026-09-01). `recordDispatch`
// was always correct and always fed null: every tick was scored as a resultless
// pass, and the Fleet panel showed a failing dispatcher that was minting ~55
// jobs a day.

test('dispatch: a pass that MINTED is reported as minting, not as failing', async () => {
	await withFleet({ 'claw-1': {} }, async () => {
		await tick(ghStub(['claw-1']).gh, {
			dispatch: async () => ({ minted: 2, failed: 0, skipped: 1, inFlight: 3, reaped: 1 }),
		});
		const d = getDispatchSnapshot();
		assert.equal(d.minted, 2);
		assert.equal(d.error, null);
		assert.equal(d.failingSince, null, 'a successful mint is not a failing dispatcher');
		assert.equal(d.totals.minted, 2);
	});
});

test('dispatch: a pass that could not look says so, with a reason', async () => {
	await withFleet({ 'claw-1': {} }, async () => {
		await tick(ghStub(['claw-1']).gh, { dispatch: async () => null });
		const d = getDispatchSnapshot();
		assert.equal(d.minted, null, 'counts stay null — nothing was observed');
		assert.ok(d.failingSince);
		assert.ok(d.error, 'could-not-look must carry a reason rather than a bare null');
	});
});

test('dispatch: a dispatcher that THROWS does not stop label toggling', async () => {
	await withFleet({ 'claw-1': { role: 'claw' } }, async () => {
		const s = ghStub(['claw-1']);
		const r = await tick(s.gh, {
			dispatch: async () => {
				throw new Error('mint exploded');
			},
		});
		assert.ok(r, 'the tick still returns a result rather than rejecting');
		assert.ok(
			s.writes.some((w) => w.method === 'POST'),
			'labels must still be written'
		);
	});
});

// ── loaders, probing, repair (unchanged behaviour) ──────────────────────────

test('loadResidentRepos reads the manifest field it was born to read', async () => {
	await withFleet({ 'claw-1': { ephemeral: true, residentRepos: ['WolffM/x'] } }, () => {
		assert.deepEqual(loadResidentRepos('claw-1'), ['WolffM/x']);
		assert.deepEqual(loadResidentRepos('claw-9'), [], 'an undeclared node has no residents');
	});
});

test('probe parsing: an idle node reports 0 workers, not an unreadable box', () => {
	// This test used to declare its own `parse` and assert against that copy, so
	// it passed no matter what parseProbe did — deleting the real parser outright
	// would not have failed it, while its name claimed to pin the regression
	// below. It drives the real one now.
	const idle = __parseProbeForTesting('0 8 0 ');
	assert.equal(idle?.workers, 0, 'idle box must read as 0 workers');
	assert.equal(idle?.cores, 8, 'of 8 cores');
	const busy = __parseProbeForTesting('3 8 0 ');
	assert.equal(busy?.workers, 3);
	assert.equal(busy?.cores, 8);
	// The old buggy output — must still be rejected rather than silently misread.
	assert.equal(__parseProbeForTesting('0\n0 8'), null, 'the double-zero form is garbage');
	assert.equal(__parseProbeForTesting(''), null);
});

// ── probing THIS node ────────────────────────────────────────────────────

test('probeNode: the local host is probed WITHOUT ssh', async () => {
	// Regression for a silent, months-long capacity loss. mgmt-api runs on hokon,
	// and hokon refuses ssh to itself (sshd is not on loopback), so probeNode
	// returned null for its own host on every tick, and an unreachable node
	// contributes nothing: hokon's slots never counted once.
	//
	// Asserting a real result here rather than mocking execFile is the point —
	// the bug was that the ssh path cannot work for the local host, and only
	// actually running it proves the local path does.
	const me = await probeNode(hostname());
	assert.notEqual(me, null, 'probing our own hostname must not fail');
	assert.ok((me?.cores ?? 0) > 0, `cores should be positive, got ${me?.cores}`);
	assert.ok((me?.workers ?? -1) >= 0, 'worker count must be a non-negative number');
});

test('probe parses the tagged OS field and still finds the repo list after it', () => {
	const p = __parseProbeForTesting('2 8 0 g=1 o=13.6,6.12.94+deb13-amd64 WolffM/a,WolffM/b,');
	assert.deepEqual(p?.os, { release: '13.6', kernel: '6.12.94+deb13-amd64' });
	assert.equal(p?.githubDns, true);
	assert.deepEqual(
		[...(p?.busyRepos ?? [])],
		[
			['WolffM/a', 1],
			['WolffM/b', 1],
		]
	);
	assert.deepEqual(__parseProbeForTesting('0 8 0 g=1 o=-,6.12.94')?.os, {
		release: null,
		kernel: '6.12.94',
	});
	assert.equal(__parseProbeForTesting('0 8 0 g=1 ')?.os, undefined, 'absent claims nothing');
});

test('probe runs here and reports this host’s real OS', async () => {
	const me = await probeNode(hostname());
	assert.match(me?.os?.release ?? '', /^\d+(\.\d+)*$|^[a-z]+\/sid$/, `got ${me?.os?.release}`);
	assert.ok(me?.os?.kernel, 'uname -r is always readable');
});

test('dispatch snapshot: a quiet pass keeps the last mint and the trailing hour', () => {
	// 2026-10-25: the panel read `Minted 0` beside eight jobs in flight, because
	// it showed the one 15s pass that happened to mint nothing.
	__resetFleetLoopForTesting();
	const t0 = Date.now();
	const at = (ms: number) => new Date(t0 + ms).toISOString();
	const pass = (minted: number) => ({ minted, failed: 0, skipped: 0, inFlight: 8, reaped: null });
	recordDispatch(pass(3), null, at(0));
	recordDispatch(pass(0), null, at(15_000));
	const snap = getDispatchSnapshot(t0 + 15_000);
	assert.equal(snap.minted, 0, 'the last pass is still reported as itself');
	assert.equal(snap.lastMintAt, at(0));
	assert.equal(snap.recent.minted, 3);
	assert.equal(
		getDispatchSnapshot(t0 + 61 * 60_000 + 15_000).recent.minted,
		0,
		'an hour later it ages out'
	);
});

test('probe counts SPAWNED workers only, never a process merely named Runner.Worker', () => {
	// 2026-10-25: claw-6 read `busy 7 / 2` holding two real jobs. The extra five
	// were ci-throttle.test.mjs fixtures — bash copied to `Runner.Worker` — from
	// this repo's own suite running on the node, and the dispatcher charged them
	// as standing work and refused the node as at capacity. A stub `pgrep` makes
	// the census deterministic: one real job, one fixture.
	const bin = tempDir('probe-pgrep-');
	writeFileSync(
		join(bin, 'pgrep'),
		'#!/bin/sh\n' +
			'echo "101 /home/u/.hadoku/jit/slot0/bin.2.338.0/Runner.Worker spawnclient 149 152"\n' +
			'echo "102 /tmp/ci-throttle-1-node-x/Runner.Worker -c sleep 60"\n'
	);
	chmodSync(join(bin, 'pgrep'), 0o755);
	const out = execFileSync('bash', ['-c', __PROBE_CMD_FOR_TESTING], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		encoding: 'utf8',
	});
	assert.equal(__parseProbeForTesting(out)?.workers, 1);
});

test('probeFleet: the local host reports reachable, not down', async () => {
	// The dashboard consequence of the same bug: hokon rendered red "unreachable"
	// on a node that was up and serving CI.
	const out = await probeFleet([hostname()], {});
	assert.equal(out.get(hostname())?.reachable, true);
});

test('sick: a successful repair releases the node', async () => {
	__resetSickForTesting();
	markNodeSick('claw-1');
	const calls: string[][] = [];
	const ok = await repairSickNode('claw-1', async (node, args) => {
		calls.push([node, ...args]);
		return true;
	});
	assert.equal(ok, true);
	assert.equal(nodeIsSick('claw-1'), false, 'a repaired node returns to service');
	const stores = calls.filter((c) => c.includes('--store')).map((c) => c[2]);
	assert.ok(
		stores.some((v) => v.includes('.local/share/pnpm/store')) &&
			stores.some((v) => v.includes('/opt/hostedtoolcache/pnpm-store')),
		`both stores must be repaired — workflows do not all use the same one, got ${JSON.stringify(stores)}`
	);
	assert.ok(
		calls.every((c) => c.includes('--fix') || c.includes('--clear-marker')),
		'repair must actually fix, not merely report'
	);
	assert.ok(
		calls.at(-1)?.includes('--clear-marker'),
		'the marker is cleared LAST, after the doctor succeeded'
	);
});

test('sick: a FAILED repair keeps the node retired', async () => {
	__resetSickForTesting();
	markNodeSick('claw-1');
	const ok = await repairSickNode('claw-1', async () => false);
	assert.equal(ok, false);
	assert.ok(nodeIsSick('claw-1'), 'a node we could not fix must not come back');
	assert.deepEqual(sickNodeNames(), ['claw-1']);
});

test('sick: a repair that fixes the store but cannot clear the marker stays retired', async () => {
	// The bug this pins: doing the repair and the marker-clear in ONE command made
	// release depend on whether `rm` worked rather than on whether the store was
	// fixed. Inverted here — the doctor succeeds, the clear fails — because a
	// node whose marker survives will just be re-reported sick next tick, and
	// releasing it produces a flap instead of a fix.
	__resetSickForTesting();
	markNodeSick('claw-1');
	const ok = await repairSickNode('claw-1', async (_h, args) => !args.includes('--clear-marker'));
	assert.equal(ok, false);
	assert.ok(nodeIsSick('claw-1'), 'no release without a cleared marker');
});

// --- probe field ORDER ------------------------------------------------------
//
// The repo field is VARIABLE LENGTH and empty on an idle node, so anything
// printed after it lands in its position. It must stay last. This mattered
// when a fifth field existed (the runners.slice OOM counters, removed
// 2026-08-29 as unconsumed) and it will matter again for the next one.

test('probe: an IDLE node invents no repo from a trailing field', () => {
	const p = __parseProbeForTesting('0 8 0 ');
	assert.equal(p?.workers, 0);
	assert.equal(p?.busyRepos?.size, 0, 'no repo may be invented from an empty tail');
});

test('probe: a busy node reports its repos', () => {
	const p = __parseProbeForTesting('2 8 0 WolffM/hadoku_site,WolffM/hadoku-rally');
	assert.equal(p?.busyRepos?.get('WolffM/hadoku_site'), 1);
	assert.equal(p?.busyRepos?.get('WolffM/hadoku-rally'), 1);
});

// --- the GitHub-DNS field (2026-10-16) ------------------------------------
//
// claw-9 answered ssh for two hours while MagicDNS SERVFAILed every public
// name, read `mintable` throughout, and took a mint whose listener never
// connected. The field is TAGGED so it cannot be confused with the repo list.

test('probe: g=1 resolves, g=0 does not, and the repo list after it still parses', () => {
	const ok = __parseProbeForTesting('2 8 0 g=1 WolffM/hadoku_site,');
	assert.equal(ok?.githubDns, true);
	assert.equal(ok?.busyRepos?.get('WolffM/hadoku_site'), 1);
	const blind = __parseProbeForTesting('0 8 0 g=0 ');
	assert.equal(blind?.githubDns, false);
	assert.equal(blind?.busyRepos?.size, 0, 'the tag is not a repo');
});

test('probe: an untagged probe claims nothing about DNS and keeps its repo field', () => {
	const p = __parseProbeForTesting('1 8 0 WolffM/hadoku_site');
	assert.equal(p?.githubDns, undefined);
	assert.equal(p?.busyRepos?.get('WolffM/hadoku_site'), 1);
});

test('probeFleet: a node that answers ssh but cannot resolve GitHub is UNREACHABLE, with the reason', async () => {
	const out = await probeFleet(['claw-9', 'claw-8'], { 'claw-9': 4, 'claw-8': 4 }, async (n) =>
		n === 'claw-9'
			? { workers: 1, cores: 8, sick: false, githubDns: false, busyRepos: new Map() }
			: { workers: 1, cores: 8, sick: false, githubDns: true, busyRepos: new Map() }
	);
	const blind = out.get('claw-9');
	assert.equal(blind?.reachable, false, 'every reader of `reachable` must stop counting it');
	assert.equal(blind?.free, 0);
	assert.match(
		blind?.unreachableWhy ?? '',
		/cannot resolve broker\.actions\.githubusercontent\.com/
	);
	assert.equal(out.get('claw-8')?.reachable, true);
	assert.equal(out.get('claw-8')?.free, 3);
	assert.equal(out.get('claw-8')?.unreachableWhy, undefined);
});

// --- hadoku-builder gets a PRODUCER (P1.2/P1.3, 2026-09-07) ---------------
//
// `hadoku-builder` used to be hand-applied and nothing verified it. Now the
// fast loop gates promotion on the node's last `fleet bootcamp --write`
// finding (`machines[node].$capabilities`), FAIL-OPEN on absence — bootcamp
// has never run against every node yet, and "never probed" must not read as
// "proven bad".

// --- nodeFailsBootcamp: the required set, and the three states that refuse ---
//
// The label rule adopted `provesRequiredSet` in wave 3c §G. `REQUIRED` is the bar
// every case below is judged against; it is passed EXPLICITLY so no test here
// depends on whether the operator's real demand ledger happens to exist.

/** The demand-derived bar. Two ids is enough for "prove all of them". */
const REQUIRED = new Set(['python-toolcache', 'gh']);

/** A node bootcamp probed cleanly, proving the whole required set. */
const provenNode = () => ({
	$capabilities: {
		blocked: [],
		unprobed: [],
		// `earned` is load-bearing, not decoration: `provenCapabilities` returns
		// `null` when it is not an array, which `provesRequiredSet` reads as
		// "nothing has looked".
		earned: [],
		prereqs: [{ id: 'python-toolcache' }, { id: 'gh' }],
	},
});

test('nodeFailsBootcamp: no recorded finding fails OPEN — never probed is not proven bad', () => {
	assert.equal(nodeFailsBootcamp('claw-1', { machines: { 'claw-1': {} } }, REQUIRED), false);
	assert.equal(nodeFailsBootcamp('claw-9', { machines: {} }, REQUIRED), false);
	assert.equal(nodeFailsBootcamp('claw-1', null, REQUIRED), false);
});

test('nodeFailsBootcamp: a clean finding proving the required set passes', () => {
	assert.equal(
		nodeFailsBootcamp('claw-1', { machines: { 'claw-1': provenNode() } }, REQUIRED),
		false
	);
});

test('nodeFailsBootcamp: MUTATION — removing one capability from the proof fails it', () => {
	// The fixture starts clean, then loses exactly one proof — python-toolcache
	// stops passing — which is the mutation item 4 of the handoff names.
	const clean = { machines: { 'claw-1': provenNode() } };
	assert.equal(nodeFailsBootcamp('claw-1', clean, REQUIRED), false);
	const mutated = {
		machines: {
			'claw-1': {
				$capabilities: {
					blocked: [{ id: 'python-toolcache', detail: 'not found' }],
					unprobed: [],
					earned: [],
					prereqs: [{ id: 'gh' }],
				},
			},
		},
	};
	assert.equal(nodeFailsBootcamp('claw-1', mutated, REQUIRED), true);
});

test('nodeFailsBootcamp: MUTATION — one node missing a capability moves ONLY that node', () => {
	// The third state of §G item 3, and the one that separates a per-node verdict
	// from a fleet-wide one. claw-2 is untouched by claw-1's gap.
	const fleet = {
		machines: {
			'claw-1': {
				$capabilities: { blocked: [], unprobed: [], earned: [], prereqs: [{ id: 'gh' }] },
			},
			'claw-2': provenNode(),
		},
	};
	assert.equal(nodeFailsBootcamp('claw-1', fleet, REQUIRED), true, 'the gap is claw-1s');
	assert.equal(nodeFailsBootcamp('claw-2', fleet, REQUIRED), false, 'and nobody elses');
});

test('nodeFailsBootcamp: an UNPROBED required capability also disqualifies', () => {
	// The manifest and capability-probe.sh disagree about what exists — not a
	// pass, and must not read as one.
	assert.equal(
		nodeFailsBootcamp(
			'claw-1',
			{
				machines: {
					'claw-1': {
						$capabilities: {
							blocked: [],
							unprobed: ['gh'],
							earned: [],
							prereqs: [{ id: 'python-toolcache' }],
						},
					},
				},
			},
			REQUIRED
		),
		true
	);
});

test('nodeFailsBootcamp: an UNREADABLE required set moves NO label, fleet-wide', () => {
	// `null` is "I could not read the bar". Demoting here takes the whole fleet
	// down at once on one bad file — `provesRequiredSet`'s own header is explicit
	// that the flip is only safe once the set can be read reliably.
	// MUTATION: the node below is missing BOTH required capabilities and still
	// must not move, so a `null` silently coerced to an empty Set would fail this.
	const starved = {
		machines: {
			'claw-1': { $capabilities: { blocked: [], unprobed: [], earned: [], prereqs: [] } },
		},
	};
	assert.equal(nodeFailsBootcamp('claw-1', starved, null), false);
	assert.equal(nodeFailsBootcamp('claw-1', starved, REQUIRED), true, 'and the bar DOES bite');
});

test('nodeFailsBootcamp: an EMPTY required set moves NO label either', () => {
	// A ledger that parsed and asked for nothing. Every node clears a bar of
	// zero, so enforcing it would be a green fleet proving nothing (3a).
	//
	// THE FIXTURE CARRIES A BLOCKED CAPABILITY, and that is what makes this test
	// bite. `provesRequiredSet` reports `blocked`/`unprobed` as a failure
	// WHATEVER the bar is, so a node with an empty record would return the same
	// `false` with or without the guard and the mutation would survive —
	// measured: deleting the empty-set branch failed 0 of 119 tests against the
	// empty-record fixture this used to carry.
	const blocked = {
		machines: {
			'claw-1': {
				$capabilities: {
					blocked: [{ id: 'gh', detail: 'not found' }],
					unprobed: [],
					earned: [],
					prereqs: [],
				},
			},
		},
	};
	assert.equal(nodeFailsBootcamp('claw-1', blocked, new Set()), false);
	// MUTATION: the same node against a REAL bar is demoted, so the refusal is
	// the empty set's doing and not the fixture being harmless.
	assert.equal(nodeFailsBootcamp('claw-1', blocked, REQUIRED), true);
});

test('nodeFailsBootcamp: a GUEST is never judged by the fast loop, however bad its record', () => {
	// A guest lends the fleet a registration and is out of scope for bootcamp's
	// required set (operator, 2026-09-14). `planTierWrites` already drops it;
	// this is the second half of the same statement, so a resident-registration
	// caller cannot route around it.
	const guest = {
		machines: {
			hokon: {
				role: 'guest',
				$capabilities: { blocked: [{ id: 'gh' }], unprobed: ['python-toolcache'] },
			},
		},
	};
	assert.equal(nodeFailsBootcamp('hokon', guest, REQUIRED), false);
	// MUTATION: the same record on a CLAW fails, so this is the role and not the
	// fixture being harmless.
	const asClaw = { machines: { hokon: { ...guest.machines.hokon, role: 'claw' } } };
	assert.equal(nodeFailsBootcamp('hokon', asClaw, REQUIRED), true);
});

function withCapabilitiesManifest(
	capabilities:
		| {
				blocked?: { id: string }[];
				unprobed?: string[];
				earned?: string[];
				prereqs?: { id: string }[];
		  }
		| undefined,
	fn: () => Promise<void> | void
) {
	const root = tempDir('capabilities-manifest-');
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				'claw-1': {
					labels: [],
					role: 'claw',
					...(capabilities ? { $capabilities: capabilities } : {}),
				},
			},
		})
	);
	// A REAL DEMAND LEDGER, in the same temp `stateDir`, because `requiredSet` is
	// now an INPUT to the promote decision and `loadRequiredSet()` is what reads
	// it. Without one the fixture would exercise the "could not read the bar"
	// branch on every case — and that branch moves no label, so every mutation
	// below would have passed while measuring nothing.
	writeFileSync(
		join(root, 'demand-ledger.jsonl'),
		[
			{
				class: 'ci',
				fleetForm: true,
				selfHosted: true,
				hosted: false,
				capabilities: ['python-toolcache', 'gh'],
			},
		]
			.map((r) => JSON.stringify(r))
			.join('\n') + '\n'
	);
	__setHostForTesting({
		logger: { info() {}, warn() {}, error() {} },
		alerts: { post: async () => ({ posted: false, sinkRecorded: false }), recordQuietly() {} },
		jobs: { recordJobResult: async () => {} },
		githubToken: () => 'tok',
		manifestDir: root,
		stateDir: root,
		storeDoctorPath: '/tmp',
		cronProfilesPath: '/tmp',
	} as never);
	return Promise.resolve(fn()).finally(() => {
		__setHostForTesting(testHost);
		rmSync(root, { recursive: true, force: true });
	});
}

/**
 * A bootcamp record that PROVES the ledger fixture's required set.
 *
 * `earned`/`prereqs` are load-bearing, not decoration: `provenCapabilities`
 * returns `null` when `earned` is not an array, so a facet carrying only
 * `blocked: []` and `unprobed: []` records that bootcamp looked and proved
 * NOTHING. Under the old rule that read as clean; under
 * `provesRequiredSet` it is a node that clears no bar at all.
 */
const PROVEN_FACET = {
	blocked: [],
	unprobed: [],
	earned: [],
	prereqs: [{ id: 'python-toolcache' }, { id: 'gh' }],
};

test('loadClawNodes: the claws, and never the pm2-host', () => {
	// Moved from runner-health.test.ts, which does not own this loader. It reads
	// the real fleet manifest on purpose — the question is whether the DECLARED
	// fleet still separates builders from the production host.
	const claws = loadClawNodes();
	assert.ok(claws.has('claw-1'));
	assert.ok(claws.has('claw-2'));
	assert.ok(claws.has('claw-3'));
	assert.ok(!claws.has('hokon'), 'hokon declares pm2-host, so it is capacity of a different kind');
});

// --- dispatch snapshot ------------------------------------------------------
// The field exists because mint failures reached nothing. Every assertion here
// is about the distinction that absence destroyed: "I looked and saw none"
// versus "I could not look".

test('a pass that threw reports NULL counts and an error, never zero', () => {
	__resetFleetLoopForTesting();
	recordDispatch(null, 'ssh: connect to host claw-3 port 22: Connection refused', 'T1');
	const d = getDispatchSnapshot();
	assert.equal(d.minted, null, 'zero here would read as a healthy quiet fleet');
	assert.equal(d.failed, null);
	assert.match(d.error ?? '', /Connection refused/);
	assert.equal(d.at, 'T1');
});

test('a quiet pass reports ZERO, which is not the same as null', () => {
	__resetFleetLoopForTesting();
	recordDispatch({ minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 }, null, 'T1');
	const d = getDispatchSnapshot();
	assert.equal(d.minted, 0);
	assert.equal(d.error, null);
	assert.equal(d.failingSince, null, 'nothing attempted is not failing');
});

test('failingSince holds its ORIGIN across consecutive all-failed passes', () => {
	// The question worth alerting on is "has this node stopped being able to
	// mint", which no single pass can answer. ~7% of mints failed for the
	// pilot's whole life without anything noticing.
	__resetFleetLoopForTesting();
	recordDispatch({ minted: 0, failed: 2, skipped: 0, inFlight: 0, reaped: 0 }, null, 'T1');
	assert.equal(getDispatchSnapshot().failingSince, 'T1');
	recordDispatch({ minted: 0, failed: 3, skipped: 0, inFlight: 0, reaped: 0 }, null, 'T2');
	assert.equal(getDispatchSnapshot().failingSince, 'T1', 'the streak keeps its start');
	recordDispatch({ minted: 0, failed: 1, skipped: 0, inFlight: 0, reaped: 0 }, null, 'T3');
	assert.equal(getDispatchSnapshot().failingSince, 'T1');
});

test('one successful mint clears the streak', () => {
	__resetFleetLoopForTesting();
	recordDispatch({ minted: 0, failed: 2, skipped: 0, inFlight: 0, reaped: 0 }, null, 'T1');
	recordDispatch({ minted: 1, failed: 1, skipped: 0, inFlight: 0, reaped: 0 }, null, 'T2');
	assert.equal(getDispatchSnapshot().failingSince, null, 'partial success is not a dead node');
});

test('a throw counts as failing, so an unreachable node does not look idle', () => {
	__resetFleetLoopForTesting();
	recordDispatch(null, 'boom', 'T1');
	recordDispatch(null, 'boom', 'T2');
	assert.equal(getDispatchSnapshot().failingSince, 'T1');
});

test('totals accumulate across passes so the panel can show a rate', () => {
	__resetFleetLoopForTesting();
	recordDispatch({ minted: 3, failed: 1, skipped: 0, inFlight: 0, reaped: 0 }, null, 'T1');
	recordDispatch({ minted: 2, failed: 0, skipped: 0, inFlight: 0, reaped: 0 }, null, 'T2');
	// A throw contributes nothing to either total — it observed neither.
	recordDispatch(null, 'boom', 'T3');
	assert.deepEqual(getDispatchSnapshot().totals, { minted: 5, failed: 1 });
});

// 2026-09-05: the dispatcher was called at the end of the fast loop's tick, so
// its cadence was the loop's. Two loops doing unrelated work at unrelated
// frequencies — and it made a LABEL bug read as a queue bug when the tick
// stretched to a 119s median and dispatch inherited every second. Measured on the same fleet:
// JIT queue p50 45s against standing 2s, with the mint itself 3s.
test('dispatch between ticks does nothing before the loop has run once', async () => {
	__resetDispatchInputForTesting();
	let called = 0;
	const r = await dispatchBetweenTicks(
		'tok',
		{} as never,
		(async () => {
			called++;
			return null;
		}) as never
	);
	assert.equal(r, 'no-input', 'no loop pass yet, so no facts to dispatch on');
	assert.equal(called, 0);
});

test('two dispatch passes never overlap', async () => {
	// dispatch-pass reconstructs in-flight work from LIVE units, so a pass that
	// has not spawned yet is invisible to the one beside it — two at once could
	// both mint for the same run.
	__resetDispatchInputForTesting();
	__setDispatchInputForTesting({ repos: [] } as never);
	let release: () => void = () => {};
	const gate = new Promise<void>((res) => {
		release = res;
	});
	let concurrent = 0;
	let maxConcurrent = 0;
	const slow = (async () => {
		concurrent++;
		maxConcurrent = Math.max(maxConcurrent, concurrent);
		await gate;
		concurrent--;
		return null;
	}) as never;
	const first = dispatchBetweenTicks('tok', {} as never, slow);
	const second = await dispatchBetweenTicks('tok', {} as never, slow);
	assert.equal(second, 'busy', 'the second pass stood down');
	release();
	assert.equal(await first, 'ok');
	assert.equal(maxConcurrent, 1);
});

// ── the repair must reach the node mgmt-api runs on ─────────────────────────
// `ssh hokon` from hokon is refused, so an ssh-only repair left a quarantined
// hokon retired for two days on 2026-09-19..21 with both stores clean.

test('repair: the LOCAL node runs through a local shell, never ssh-to-self', () => {
	const [cmd, args] = doctorCommand('hokon', 'bash -s -- --fix', 'hokon');
	assert.equal(cmd, 'bash');
	assert.deepEqual(args, ['-c', 'bash -s -- --fix']);
});

test('repair: a REMOTE node still goes over ssh, with the same command string', () => {
	const [cmd, args] = doctorCommand('claw-2', 'bash -s -- --fix', 'hokon');
	assert.equal(cmd, 'ssh');
	assert.equal(args.at(-2), 'claw-2');
	assert.equal(args.at(-1), 'bash -s -- --fix');
});

test('repair: the local path EXPANDS $HOME in the store path, as the remote shell does', async () => {
	// A bare spawn('bash', ['-s', ...]) would hand the doctor a literal "$HOME"
	// and fail exactly as silently as the ssh-to-self did.
	const out = join(tempDir('doctor-'), 'seen');
	const ok = await runDoctor('hokon', ['--store', '$HOME/.local/share/pnpm/store'], {
		self: 'hokon',
		script: `printf %s "$2" > ${JSON.stringify(out)}`,
	});
	assert.equal(ok, true);
	assert.equal(readFileSync(out, 'utf8'), `${homedir()}/.local/share/pnpm/store`);
});

test('repair: a failing doctor reports FAILURE, not a released node', async () => {
	assert.equal(await runDoctor('hokon', ['--fix'], { self: 'hokon', script: 'exit 3' }), false);
});

// ── bootcamp decides the label, through the tick ────────────────────────────
//
// `hadoku-builder` is granted iff the node is SAFE, and bootcamp's verdict is
// one of the three inputs (`nodeIsSafe`). Driven through the real tick against a
// real demand ledger (`withCapabilitiesManifest`), so the required set is
// actually read — without one, every case below would exercise the "could not
// read the bar" branch, which moves no label, and pass while measuring nothing.

function bootcampTick() {
	__resetFleetLoopForTesting();
	__resetSickForTesting();
	const s = ghStub(['claw-1']);
	return { s, run: () => tick(s.gh) };
}

test('bootcamp: a node with NO recorded finding is promoted — never probed is not proven bad', async () => {
	await withCapabilitiesManifest(undefined, async () => {
		const { s, run } = bootcampTick();
		await run();
		assert.ok(s.writes.length > 0 && s.writes.every((w) => w.method === 'POST'));
	});
});

test('bootcamp: a node with a clean finding proving the required set is promoted', async () => {
	await withCapabilitiesManifest(PROVEN_FACET, async () => {
		const { s, run } = bootcampTick();
		await run();
		assert.ok(s.writes.length > 0 && s.writes.every((w) => w.method === 'POST'));
	});
});

test('bootcamp: MUTATION — a finding missing one proof STRIPS the label, never grants it', async () => {
	await withCapabilitiesManifest(
		{ blocked: [{ id: 'python-toolcache' }], unprobed: [], earned: [], prereqs: [{ id: 'gh' }] },
		async () => {
			__resetFleetLoopForTesting();
			__resetSickForTesting();
			const s = ghStub(['claw-1'], ['claw-1']);
			await tick(s.gh);
			assert.ok(s.writes.length > 0 && s.writes.every((w) => w.method === 'DELETE'));
		}
	);
});

test('bootcamp: sickness still strips a node whose finding is clean', async () => {
	await withCapabilitiesManifest(PROVEN_FACET, async () => {
		__resetFleetLoopForTesting();
		__resetSickForTesting();
		markNodeSick('claw-1');
		const s = ghStub(['claw-1'], ['claw-1']);
		await tick(s.gh);
		assert.ok(s.writes.length > 0 && s.writes.every((w) => w.method === 'DELETE'));
	});
});

// --- A sealed vault at boot (#133) ---
//
// mgmt-api boots with no token whenever Vaultwarden restarts beside it. The
// first pass returned silently and the probe waited a full FAST_LOOP_SECONDS,
// so a vault that unsealed 5s after boot still left the panel unprobed for a
// minute (02:32 on 2026-10-22: first probe at +121s).

test('start: no token at boot — the first pass runs as soon as the token arrives, not an interval later', async () => {
	__resetFleetLoopForTesting();
	__setFastLoopTokenRetryForTesting(10);
	let token: string | undefined;
	// The loop's intervals are not stoppable from a test; `done` makes every
	// later timer a no-op, so nothing fires after this case.
	let done = false;
	const passes: string[] = [];
	try {
		startFastLoop(
			() => (done ? undefined : token),
			ghStub([], []).gh,
			(t) => {
				passes.push(t);
				return Promise.resolve({ actions: [] });
			}
		);
		await new Promise((r) => setTimeout(r, 40));
		assert.deepEqual(passes, [], 'no pass may run without a token');
		token = 'tok';
		await new Promise((r) => setTimeout(r, 40));
		assert.deepEqual(passes, ['tok'], 'exactly one pass, on the retry after the unseal');
	} finally {
		done = true;
		__setFastLoopTokenRetryForTesting(null);
		__resetFleetLoopForTesting();
	}
});

test('start: a token present at boot ticks immediately and schedules no retry', async () => {
	__resetFleetLoopForTesting();
	__setFastLoopTokenRetryForTesting(10);
	let done = false;
	const passes: string[] = [];
	try {
		startFastLoop(
			() => (done ? undefined : 'tok'),
			ghStub([], []).gh,
			(t) => {
				passes.push(t);
				return Promise.resolve({ actions: [] });
			}
		);
		assert.deepEqual(passes, ['tok'], 'the first pass goes out on the turn start is called');
		await new Promise((r) => setTimeout(r, 40));
		assert.deepEqual(passes, ['tok'], 'and nothing re-runs before the interval');
	} finally {
		done = true;
		__setFastLoopTokenRetryForTesting(null);
		__resetFleetLoopForTesting();
	}
});
