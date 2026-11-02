/**
 * The warm cache of one — the construction path (I/O): `mintWarmListener`,
 * `evictWarmListener`, `currentWarmSlot`/`readWarmMarker`, and `isRunnerBusy`,
 * tested through injected `gh`/`sh` exactly like `mintEphemeralRunner`. Split
 * out of warm-cache.test.ts (wave 5p lane C) — see `helpers/warm-cache-rig.ts`
 * for the file-wide `beforeEach`/`afterEach` every split file installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	currentWarmSlot,
	evictWarmListener,
	readWarmMarker,
	isRunnerBusy,
	mintWarmListener,
} from '../runners/ephemeral-exec.js';
import { warmRunnerName } from '../lib/jit-naming.js';
import { ephemeralOnlyLabels } from '../lib/capability-labels.js';
import { fakeGh } from './helpers/fleet-fakes.js';
import { installWarmCacheRig } from './helpers/warm-cache-rig.js';

installWarmCacheRig();

// --- the construction path (I/O) --------------------------------------------

function warmHarness(over: { prov?: string | null; spawn?: string | null; regOk?: boolean } = {}) {
	const calls: string[] = [];
	const sh = async (_node: string, cmd: string): Promise<string | null> => {
		if (cmd.includes('warm-provision.sh')) {
			calls.push('provision');
			return over.prov === undefined
				? 'WARM-READY /home/hadoku/.hadoku/warm/listener 2.336.0'
				: over.prov;
		}
		if (cmd.includes('systemctl --user stop')) {
			calls.push('stop');
			return '';
		}
		calls.push('spawn');
		return over.spawn === undefined ? 'Running as unit: x.service' : over.spawn;
	};
	const gh = fakeGh({
		registrationTokenOk: over.regOk,
		runners: [{ id: 42, name: warmRunnerName('claw-1', 'WolffM/hadoku_site') }],
	});
	return { calls, sh, gh };
}

const WARM_REQ = {
	node: 'claw-1',
	repo: 'WolffM/hadoku_site',
	runnerName: warmRunnerName('claw-1', 'WolffM/hadoku_site'),
	labels: ['hadoku-builder'],
	homeDir: '/home/hadoku',
	memoryMaxMb: 4096,
};

test('mintWarmListener: registration token first, provision second, spawn third', async () => {
	const { calls, sh, gh } = warmHarness();
	const res = await mintWarmListener(WARM_REQ, 'tok', gh, sh);
	assert.equal(res.ok, true);
	assert.ok(gh.writes.some((p) => p.includes('registration-token')));
	assert.deepEqual(calls, ['provision', 'spawn']);
});

test('mintWarmListener: a failed registration-token call mints nothing', async () => {
	const { sh, gh } = warmHarness({ regOk: false });
	const res = await mintWarmListener(WARM_REQ, 'tok', gh, sh);
	assert.equal(res.ok, false);
	assert.match(res.reason ?? '', /registration-token/);
});

test('mintWarmListener: a failed provisioning step never reaches spawn', async () => {
	const { calls, sh, gh } = warmHarness({ prov: 'WARM-FAIL disk full' });
	const res = await mintWarmListener(WARM_REQ, 'tok', gh, sh);
	assert.equal(res.ok, false);
	assert.match(res.reason ?? '', /disk full/);
	assert.deepEqual(calls, ['provision']);
});

test('mintWarmListener: a node with no standing.env FAILS the fill rather than minting an unthrottled listener', async () => {
	// §A's fail-closed half, from the dispatcher's side. warm-provision.sh
	// refuses when `fleet throttle --confirm` has never rendered
	// ~/.hadoku/standing.env there, because a warm listener built without it is
	// a STANDING runner with no job-started hook — the node's declared cap,
	// bypassed, on the one runner shape this package mints for itself. The
	// dispatcher must see that as a failed fill (which the per-node backoff then
	// slows) and must carry the reason, not a bare "warm slot failed": a missing
	// deploy and a full disk are two different jobs.
	const { calls, sh, gh } = warmHarness({
		prov:
			'WARM-FAIL no /home/hadoku/.hadoku/standing.env — a standing listener would run with ' +
			'no throttle hook and no RUNNER_TOOL_CACHE. Run: fleet throttle --confirm --machine claw-1',
	});
	const res = await mintWarmListener(WARM_REQ, 'tok', gh, sh);
	assert.equal(res.ok, false);
	assert.match(res.reason ?? '', /standing\.env/);
	assert.match(res.reason ?? '', /fleet throttle --confirm/);
	assert.deepEqual(calls, ['provision'], 'nothing may be spawned against an unwired slot');
});

test('mintWarmListener: labels are self-hosted plus what the node EARNED — never a mint-only label', async () => {
	// A warm listener is STANDING, so it must not carry a label meaning "only a
	// fresh mint can serve this". `jit-canary` is exactly that, and the warm
	// cache carried it for two days: five consecutive site:jit-canary failures
	// on 2026-09-08/09, every one served by warm-claw-3-hadoku_site, failing the
	// step named "prove this ran on a minted runner".
	//
	// The forbidden set is DERIVED from the capability registry rather than
	// spelled here, so a mint-only capability added tomorrow is covered without
	// this test being edited — and a registry that went empty would make the
	// assertion vacuous, which is why it is asserted non-empty first.
	const forbidden = ephemeralOnlyLabels();
	assert.ok(forbidden.length > 0, 'no ephemeral-only labels exist, so this test proves nothing');

	const { sh, gh } = warmHarness();
	const seen: string[] = [];
	const spy = async (n: string, cmd: string) => {
		seen.push(cmd);
		return sh(n, cmd);
	};
	// The node's raw manifest labels, mint-only ones included — the exact input
	// that produced the canary failures.
	await mintWarmListener({ ...WARM_REQ, labels: ['hadoku-builder', ...forbidden] }, 'tok', gh, spy);
	const labels =
		/LABELS='([^']*)'/.exec(seen.find((c) => c.includes('warm-provision.sh')) ?? '')?.[1] ?? '';
	const sent = labels.split(',');
	assert.ok(sent.includes('self-hosted'), `self-hosted is missing: ${labels}`);
	assert.ok(sent.includes('hadoku-builder'), `the earned consumer label is missing: ${labels}`);
	for (const f of forbidden) {
		assert.ok(!sent.includes(f), `a standing listener must not carry ${f}: ${labels}`);
	}
});

test('mintWarmListener: a failed spawn cleans up the registration it just created', async () => {
	const { sh, gh } = warmHarness({ spawn: null });
	const res = await mintWarmListener(WARM_REQ, 'tok', gh, sh);
	assert.equal(res.ok, false);
	assert.ok(
		gh.writes.some((p) => p.includes('/actions/runners/42')),
		'DELETE by id after lookup'
	);
});

test('mintWarmListener never puts the registration token or repo url unescaped where a shell metacharacter could break out', async () => {
	const { sh, gh } = warmHarness();
	const seenCmds: string[] = [];
	const spy = async (n: string, cmd: string) => {
		seenCmds.push(cmd);
		return sh(n, cmd);
	};
	await mintWarmListener({ ...WARM_REQ, repo: "WolffM/it's-fine" }, 'tok', gh, spy);
	// shellSingleQuote turns `'` into `'\''` — assert the raw apostrophe never
	// sits inside an open single-quoted span unescaped, on the ONE command
	// (provisioning) that ever embeds the repo name.
	assert.ok(seenCmds.some((c) => c.includes(`'\\''`)));
});

test('evictWarmListener deletes the registration BEFORE stopping the unit', async () => {
	const order: string[] = [];
	const sh = async (_n: string, cmd: string) => {
		if (cmd.includes('systemctl --user stop')) order.push('stop');
		return '';
	};
	const gh = fakeGh({ runners: [{ id: 7, name: WARM_REQ.runnerName }] });
	const origWrite = gh.write;
	gh.write = async (m, p, t, b, r) => {
		if (m === 'DELETE') order.push('delete');
		return origWrite(m, p, t, b, r);
	};
	const ok = await evictWarmListener('claw-1', WARM_REQ.repo, WARM_REQ.runnerName, 'tok', gh, sh);
	assert.equal(ok, true);
	assert.deepEqual(order, ['delete', 'stop']);
});

test('evictWarmListener stops NOTHING when GitHub refuses the delete — the listener won the race to a job (CI run 37859515259)', async () => {
	const cmds: string[] = [];
	const sh = async (_n: string, cmd: string) => {
		cmds.push(cmd);
		return '';
	};
	const gh = fakeGh({ runners: [{ id: 7, name: WARM_REQ.runnerName }] });
	gh.write = async () => ({ ok: false, status: 422 });
	const ok = await evictWarmListener('claw-1', WARM_REQ.repo, WARM_REQ.runnerName, 'tok', gh, sh);
	assert.equal(ok, false);
	assert.deepEqual(cmds, [], 'neither the unit nor the marker was touched');
});

test('currentWarmSlot: no marker means no slot', async () => {
	const sh = async () => '';
	assert.equal(await currentWarmSlot('claw-1', sh), null);
});

test('currentWarmSlot: a marker with no live unit behind it is STALE, not a slot for the wrong repo', async () => {
	const sh = async (_n: string, cmd: string) => {
		if (cmd.includes('is-active')) return 'inactive';
		return 'WolffM/hadoku_site 1000';
	};
	assert.equal(await currentWarmSlot('claw-1', sh), null);
});

test('currentWarmSlot: a live marker resolves the repo and the unit name', async () => {
	const sh = async (_n: string, cmd: string) => {
		if (cmd.includes('is-active')) return 'active';
		return 'WolffM/hadoku_site 1000';
	};
	const slot = await currentWarmSlot('claw-1', sh);
	assert.deepEqual(slot, {
		repo: 'WolffM/hadoku_site',
		unit: warmRunnerName('claw-1', 'WolffM/hadoku_site'),
		markerAtMs: 1_000_000,
	});
});

test('readWarmMarker: dead is FALSE, unreadable is NULL — and currentWarmSlot collapses both', async () => {
	// The distinction #61 turns on. `currentWarmSlot` is allowed to answer "no
	// slot" for both, because the fill/rotate decision is the same either way.
	// A DELETE decision is not: it may act on the first and never on the second.
	const shDead = async (_n: string, cmd: string) =>
		cmd.includes('is-active') ? 'inactive' : 'WolffM/hadoku-tenhands 1000';
	const dead = await readWarmMarker('claw-1', shDead);
	assert.equal(dead?.active, false);
	assert.equal(dead?.repo, 'WolffM/hadoku-tenhands');
	assert.equal(dead?.unit, warmRunnerName('claw-1', 'WolffM/hadoku-tenhands'));
	assert.equal(await currentWarmSlot('claw-1', shDead), null);

	// The ssh failed. `|| true` means the node itself always exits 0, so a
	// `null` here can only be the transport — never systemd's answer.
	const shUnreadable = async (_n: string, cmd: string) =>
		cmd.includes('is-active') ? null : 'WolffM/hadoku-tenhands 1000';
	assert.equal((await readWarmMarker('claw-1', shUnreadable))?.active, null);
	assert.equal(await currentWarmSlot('claw-1', shUnreadable), null);

	// An EMPTY answer is equally unreadable — is-active prints a word when it
	// ran at all, so nothing at all is not "not active".
	const shEmpty = async (_n: string, cmd: string) =>
		cmd.includes('is-active') ? '' : 'WolffM/hadoku-tenhands 1000';
	assert.equal((await readWarmMarker('claw-1', shEmpty))?.active, null);

	// No marker: nothing to say, and no second ssh spent asking.
	assert.equal(await readWarmMarker('claw-1', async () => ''), null);
});

test('isRunnerBusy: null when the listing does not include it — cannot vouch for it', async () => {
	const gh = fakeGh({ runners: [] });
	assert.equal(
		await isRunnerBusy('WolffM/hadoku_site', 'warm-claw-1-hadoku-site', 'tok', gh),
		null
	);
});

test('isRunnerBusy: reads the busy field when the registration is found', async () => {
	const gh = fakeGh({ runners: [{ id: 1, name: 'warm-claw-1-hadoku-site', busy: true }] });
	assert.equal(
		await isRunnerBusy('WolffM/hadoku_site', 'warm-claw-1-hadoku-site', 'tok', gh),
		true
	);
});
