import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	__resetTarballCacheForTesting,
	liveJitSlots,
	liveJitState,
	liveJitUnitRecords,
	liveJitUnits,
	mintEphemeralRunner,
	retireStrandedJit,
	runnerTarballUrl,
} from '../runners/ephemeral-exec-jit.js';
import { jitUnitDescription, labelsFromUnitDescription } from '../runners/ephemeral-mint.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GOOD_JITCONFIG, fakeGh, jitConfig } from './helpers/fleet-fakes.js';

const REQ = {
	node: 'hokon',
	repo: 'WolffM/hadoku-rally',
	runnerName: 'jit-hokon-hadoku-rally-1787797008',
	labels: ['pm2-host'],
	slotIndex: 0,
	homeDir: '/home/hadoku',
	memoryMaxMb: 3000,
	ttlSeconds: 900,
};

/** Records the order of operations, which is what these tests are about. */
function harness(
	over: { prov?: string | null; spawn?: string | null; mintOk?: boolean; cfg?: string } = {}
) {
	const calls: string[] = [];
	const sh = async (_h: string, cmd: string) => {
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		if (cmd.includes('jit-provision')) {
			calls.push('provision');
			return over.prov === undefined
				? 'SLOT-READY /home/hadoku/.hadoku/jit/slot0 2.336.0'
				: over.prov;
		}
		calls.push('spawn');
		return over.spawn === undefined ? 'Running as unit: x.service' : over.spawn;
	};
	const gh = {
		write: async (m: 'POST' | 'DELETE', p: string) => {
			if (p.includes('generate-jitconfig')) {
				calls.push('mint');
				return over.mintOk === false
					? { ok: false, status: 422 }
					: { ok: true, status: 201, body: { encoded_jit_config: over.cfg ?? GOOD_JITCONFIG } };
			}
			if (m === 'DELETE') calls.push('delete');
			return { ok: true, status: 204 };
		},
		get: async () => ({ runners: [{ id: 99, name: REQ.runnerName }] }),
	};
	return { calls, sh, gh };
}

test('the slot is prepared BEFORE the registration is created', () => {
	// A jitconfig is a live registration the moment GitHub issues it, and one
	// whose listener never starts does NOT deregister itself (§12.8) — it sits
	// there reporting online while GitHub assigns it work nothing answers. So
	// anything discoverable without minting must be discovered first.
	return (
		harness().sh &&
		(async () => {
			const h = harness();
			await mintEphemeralRunner(REQ, 'tok', h.gh, h.sh);
			assert.deepEqual(h.calls, ['provision', 'mint', 'spawn']);
		})()
	);
});

test('a slot that will not provision never reaches GitHub', async () => {
	const h = harness({ prov: 'SLOT-FAIL no payload' });
	const r = await mintEphemeralRunner(REQ, 'tok', h.gh, h.sh);
	assert.equal(r.ok, false);
	assert.deepEqual(h.calls, ['provision'], 'no registration may be created');
});

test('an unreachable node never reaches GitHub either', async () => {
	const h = harness({ prov: null });
	const r = await mintEphemeralRunner(REQ, 'tok', h.gh, h.sh);
	assert.equal(r.ok, false);
	assert.deepEqual(h.calls, ['provision']);
});

test('a failed spawn DELETES the registration rather than leaking it', async () => {
	// Otherwise this is exactly §12.8's black hole: registration online, nothing
	// listening, GitHub assigning work into it.
	const h = harness({ spawn: null });
	const r = await mintEphemeralRunner(REQ, 'tok', h.gh, h.sh);
	assert.equal(r.ok, false);
	assert.deepEqual(h.calls, ['provision', 'mint', 'spawn', 'delete']);
	assert.match(r.reason ?? '', /registration removed/);
});

test('an unsafe jitconfig is refused AND cleaned up, never spawned', async () => {
	// A runner that self-updated in place would rewrite the payload hardlinked
	// into every other slot on the node (§12.16).
	const h = harness({ cfg: jitConfig({ DisableUpdate: 'False', Ephemeral: 'True' }) });
	const r = await mintEphemeralRunner(REQ, 'tok', h.gh, h.sh);
	assert.equal(r.ok, false);
	assert.deepEqual(h.calls, ['provision', 'mint', 'delete'], 'spawn must not happen');
	assert.match(r.reason ?? '', /DisableUpdate/);
});

test('a mint that GitHub refuses does not try to spawn', async () => {
	const h = harness({ mintOk: false });
	const r = await mintEphemeralRunner(REQ, 'tok', h.gh, h.sh);
	assert.equal(r.ok, false);
	assert.deepEqual(h.calls, ['provision', 'mint']);
});

test('the happy path reports the unit it started', async () => {
	const h = harness();
	const r = await mintEphemeralRunner(REQ, 'tok', h.gh, h.sh);
	assert.equal(r.ok, true);
	assert.equal(r.unit, REQ.runnerName);
});

test("#120: the node's declared slice reaches the unit — a backstop's jobs land in ITS slice", async () => {
	const spawned: string[] = [];
	const h = harness();
	const sh = async (n: string, cmd: string) => {
		if (cmd.startsWith('systemd-run ')) spawned.push(cmd);
		return h.sh(n, cmd);
	};
	await mintEphemeralRunner({ ...REQ, sliceName: 'ci-runner.slice' }, 'tok', h.gh, sh);
	assert.equal(spawned.length, 1);
	assert.match(spawned[0]!, / --property=Slice=ci-runner\.slice /);

	spawned.length = 0;
	await mintEphemeralRunner(REQ, 'tok', h.gh, sh);
	assert.match(spawned[0]!, / --property=Slice=runners\.slice /, 'absent is the default slice');
});

test('liveJitUnits reads the node, which is how state survives a restart', async () => {
	// B9: the unit list IS the record. mgmt-api's memory is not.
	const sh = async () =>
		'jit-hokon-meet-1787797008.service loaded active running x\njit-claw2-site-1787797100.service loaded active running y';
	assert.deepEqual(await liveJitUnits('hokon', sh), [
		'jit-hokon-meet-1787797008',
		'jit-claw2-site-1787797100',
	]);
});

test('liveJitUnits asks for --plain and excludes a FAILED unit by its ACTIVE column, not by accident', async () => {
	// Emulates real systemctl: without `--plain`, a failed unit's line starts
	// with `●` and a healthy one with two spaces, so the first token stops being
	// the unit name. With it, the columns are reliable and a failed unit (its
	// listener gone) is excluded because it is failed: both callers would
	// otherwise count it as a job in flight and keep its registration (#98).
	let asked = '';
	const sh = async (_node: string, cmd: string) => {
		asked = cmd;
		const plain = cmd.includes('--plain');
		return [
			`${plain ? '' : '  '}jit-claw2-site-r1-1787797100.service loaded active running y`,
			`${plain ? '' : '  '}jit-claw2-site-r3-1787797300.service loaded activating start w`,
			`${plain ? '' : '● '}jit-claw2-site-r2-1787797200.service loaded failed failed z`,
		].join('\n');
	};
	assert.deepEqual(await liveJitUnits('claw-2', sh), [
		'jit-claw2-site-r1-1787797100',
		'jit-claw2-site-r3-1787797300',
	]);
	assert.match(asked, /--plain/);
});

test('a mint stamps its COMPLETE label set on the unit, and list-units gives it back', async () => {
	const spawned: string[] = [];
	const h = harness();
	const sh = async (n: string, cmd: string) => {
		if (cmd.startsWith('systemd-run ')) spawned.push(cmd);
		return h.sh(n, cmd);
	};
	await mintEphemeralRunner(REQ, 'tok', h.gh, sh);
	const stamp = /'--description=([^']*)'/.exec(spawned[0]!)?.[1];
	assert.equal(stamp, 'jit labels=self-hosted,Linux,X64,pm2-host', 'the implicit labels too');

	// What `systemctl --user list-units --plain` prints for it, beside a unit
	// minted before the stamp existed (systemd-run's own description).
	const listing = [
		`${REQ.runnerName}.service loaded active running ${stamp}`,
		`jit-hokon-old-1787797000.service loaded active running [systemd-run] /bin/sh -c "C=$(cat x)"`,
	].join('\n');
	assert.deepEqual(await liveJitUnitRecords('hokon', async () => listing), [
		{ name: REQ.runnerName, labels: ['self-hosted', 'Linux', 'X64', 'pm2-host'] },
		{ name: 'jit-hokon-old-1787797000', labels: null },
	]);
});

test('a label that would not survive the round trip leaves the unit UNSTAMPED, never half-stamped', () => {
	assert.equal(jitUnitDescription(['self-hosted', 'has space']), null);
	assert.equal(jitUnitDescription([]), null);
	assert.equal(labelsFromUnitDescription('jit labels='), null);
	assert.equal(labelsFromUnitDescription('jit labels=a,,b'), null);
	assert.deepEqual(labelsFromUnitDescription(jitUnitDescription(['a', 'b.c', 'd_e-f'])!), [
		'a',
		'b.c',
		'd_e-f',
	]);
});

test('an unreachable node reports no units rather than throwing', async () => {
	assert.deepEqual(await liveJitUnits('hokon', async () => null), []);
});

/**
 * fleet-manager#86: the dispatch pass reads units and slots in ONE ssh. Run
 * that command through a REAL bash, with `systemctl` and `pgrep` stubbed on
 * PATH, and require the same answers the two separate calls give — including
 * when `systemctl` fails, which the joined command must not let swallow the
 * slots.
 */
function realShellWith(systemctl: string, pgrep: string) {
	const bin = mkdtempSync(join(tmpdir(), 'jit-state-'));
	writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\n${systemctl}\n`, { mode: 0o755 });
	writeFileSync(join(bin, 'pgrep'), `#!/bin/sh\n${pgrep}\n`, { mode: 0o755 });
	return async (_node: string, cmd: string): Promise<string | null> => {
		const r = spawnSync('bash', ['-c', cmd], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
		});
		return r.status === 0 ? r.stdout : null;
	};
}

test('liveJitState: one command, the same units and slots the two calls read', async () => {
	const sh = realShellWith(
		"printf 'jit-a.service loaded active running jit labels=self-hosted,x\\njit-b.service loaded failed failed y\\n'",
		"echo '4242 /home/ci/.hadoku/jit/slot3/bin/Runner.Listener run'"
	);
	let calls = 0;
	const counted = async (n: string, c: string) => {
		calls++;
		return sh(n, c);
	};
	const state = await liveJitState('claw-1', counted);
	assert.equal(calls, 1, 'one ssh, not two');
	assert.deepEqual(state.units, await liveJitUnitRecords('claw-1', sh));
	assert.deepEqual(state.units, [{ name: 'jit-a', labels: ['self-hosted', 'x'] }]);
	assert.deepEqual([...state.slots], [...(await liveJitSlots('claw-1', sh))]);
	assert.deepEqual([...state.slots], [3]);
});

test('liveJitState: a failed systemctl still reads the slots; an unreachable node reads nothing', async () => {
	const sh = realShellWith(
		'echo boom >&2; exit 1',
		"echo '7 /home/ci/.hadoku/jit/slot0/bin/Runner.Listener run'"
	);
	const state = await liveJitState('claw-1', sh);
	assert.deepEqual(state.units, []);
	assert.deepEqual([...state.slots], [0], 'a broken unit listing must not hide a busy slot');
	const none = await liveJitState('claw-1', async () => null);
	assert.deepEqual(none.units, []);
	assert.equal(none.slots.size, 0);
});

test('a 2xx with no usable config is cleaned up, not left registered', async () => {
	// The live failure: ghWrite discarded the response body, so generate-jitconfig
	// answered 201 with the config inside it and the mint saw nothing. GitHub had
	// created a real registration either way — a runner it will schedule onto with
	// nothing listening (§12.8), and two of them survived on the fleet.
	const deleted: string[] = [];
	const gh = {
		write: async (method: 'POST' | 'DELETE', p: string) => {
			if (p.includes('generate-jitconfig')) return { ok: true, status: 201 }; // no body
			if (method === 'DELETE') deleted.push(p);
			return { ok: true, status: 204 };
		},
		get: async () => ({ runners: [{ id: 77, name: 'jit-claw-3-x-r1-1787797008' }] }),
	};
	const sh = async () => 'SLOT-READY /home/hadoku/.hadoku/jit/slot0 2.336.0';
	const res = await mintEphemeralRunner(
		{
			node: 'claw-3',
			repo: 'WolffM/x',
			runnerName: 'jit-claw-3-x-r1-1787797008',
			labels: ['hadoku-builder'],
			slotIndex: 0,
			homeDir: '/home/hadoku',
			memoryMaxMb: 4096,
			ttlSeconds: 900,
		},
		'tok',
		gh,
		sh
	);
	assert.equal(res.ok, false);
	assert.deepEqual(deleted, ['/actions/runners/77'], 'the accepted registration must be removed');
});

test('a mint carries self-hosted — generate-jitconfig adds no default labels', async () => {
	// config.sh gives a runner self-hosted/Linux/X64 automatically; the JIT
	// endpoint does not, and the labels array is the complete set. Without this
	// the runner comes up online and idle carrying only the node's declared
	// labels, and no fleet workflow — all of which ask for self-hosted — can ever
	// match it. Cost the pilot's first canary a full hour of a healthy-looking
	// runner that could not be given work.
	let sentLabels: string[] = [];
	const gh = {
		write: async (_m: 'POST' | 'DELETE', p: string, _t: string, body?: unknown) => {
			if (p.includes('generate-jitconfig')) {
				sentLabels = (body as { labels: string[] }).labels;
				return { ok: true, status: 201, body: { encoded_jit_config: GOOD_JITCONFIG } };
			}
			return { ok: true, status: 204 };
		},
		get: async () => ({ runners: [] }),
	};
	const sh = async (_h: string, cmd: string) =>
		cmd.includes('CFG-OK') ? 'CFG-OK' : 'SLOT-READY /home/hadoku/.hadoku/jit/slot0 2.336.0';
	await mintEphemeralRunner(
		{
			node: 'claw-3',
			repo: 'WolffM/x',
			runnerName: 'jit-claw-3-x-r1-1787797008',
			labels: ['hadoku-builder', 'jit-canary'],
			slotIndex: 0,
			homeDir: '/home/hadoku',
			memoryMaxMb: 4096,
			ttlSeconds: 900,
		},
		'tok',
		gh,
		sh
	);
	assert.ok(
		sentLabels.includes('self-hosted'),
		`missing self-hosted: ${JSON.stringify(sentLabels)}`
	);
	assert.ok(sentLabels.includes('jit-canary'), 'and still carries what the node declared');
});

// ---- the bootstrap deadlock ----------------------------------------------

test('the provision command carries a tarball URL only when one is offered', async () => {
	// A node that already has a payload never reads it, so the old command
	// shape must be exactly preserved — this is the hot path for every mint.
	const seen: string[] = [];
	const sh = async (_h: string, cmd: string) => {
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		if (cmd.includes('jit-provision')) seen.push(cmd);
		return cmd.includes('jit-provision') ? 'SLOT-READY /x 2.336.0' : 'Running as unit: x.service';
	};
	const h = harness();
	await mintEphemeralRunner(REQ, 'tok', h.gh, sh);
	assert.doesNotMatch(seen[0], /RUNNER_TARBALL_URL/);

	await mintEphemeralRunner({ ...REQ, tarballUrl: 'https://example/r.tar.gz' }, 'tok', h.gh, sh);
	assert.match(seen[1], /RUNNER_TARBALL_URL='https:\/\/example\/r\.tar\.gz'/);
	assert.match(
		seen[1],
		/^SLOT=0 RESET=1 .* bash -c "\$\(printf %s '[A-Za-z0-9+/=]+' \| base64 -d\)" jit-provision\.sh$/
	);
});

test('the provision command carries the minter AND the payload library, not a path on the node', async () => {
	// The node keeps no copy of jit-provision.sh: a copy is a second source,
	// and hokon's was a release behind on 2026-10-27. What runs is decoded
	// from the command itself.
	const seen: string[] = [];
	const sh = async (_h: string, cmd: string) => {
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		if (cmd.includes('jit-provision')) seen.push(cmd);
		return cmd.includes('jit-provision') ? 'SLOT-READY /x 2.336.0' : 'Running as unit: x.service';
	};
	await mintEphemeralRunner(REQ, 'tok', harness().gh, sh);
	assert.doesNotMatch(seen[0], /~\/\.hadoku\/jit-provision\.sh/);
	const b64 = /printf %s '([^']+)'/.exec(seen[0])?.[1] ?? '';
	const text = Buffer.from(b64, 'base64').toString('utf8');
	assert.match(text, /^#!\/usr\/bin\/env bash\n# runner-payload/);
	assert.match(text, /^payload_ensure\(\) \{/m);
	assert.match(text, /^# jit-provision — /m);
	assert.ok(
		text.indexOf('payload_ensure() {') < text.indexOf('payload_ensure || exit 0'),
		'the library is defined before the minter calls it'
	);
});

test('a URL with a quote in it cannot break out of the shell word', async () => {
	// The value comes from a GitHub API response and is interpolated into a
	// command that runs on a box with runner-admin reach. Single-quoting is only
	// safe if the quote itself is escaped.
	const seen: string[] = [];
	const sh = async (_h: string, cmd: string) => {
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		if (cmd.includes('jit-provision')) {
			seen.push(cmd);
			return 'SLOT-READY /x 2.336.0';
		}
		return 'Running as unit: x.service';
	};
	const h = harness();
	await mintEphemeralRunner(
		{ ...REQ, tarballUrl: `https://e/x'; rm -rf ~; echo '` },
		'tok',
		h.gh,
		sh
	);
	// Everything after SLOT=/RESET= and before `bash` is one single-quoted word.
	const word = /RUNNER_TARBALL_URL=('(?:[^']|'\\'')*') bash /.exec(seen[0]);
	assert.ok(word, `not a single quoted word: ${seen[0]}`);
	assert.doesNotMatch(seen[0], /; rm -rf ~; echo '' bash/);
});

test('runnerTarballUrl picks linux/x64, not whatever came first', async () => {
	// The first entry GitHub returns is not guaranteed to be this fleet's
	// platform, and an osx-arm64 tarball unpacks perfectly and then fails at
	// `Runner.Listener --version` — a bootstrap failure that reads as a corrupt
	// payload.
	__resetTarballCacheForTesting();
	const body = [
		{ os: 'osx', architecture: 'arm64', download_url: 'https://x/osx.tar.gz' },
		{ os: 'linux', architecture: 'x64', download_url: 'https://x/linux.tar.gz' },
	];
	const url = await runnerTarballUrl(async () => body, 'tok', 'WolffM/hadoku_site');
	assert.equal(url, 'https://x/linux.tar.gz');
});

test('runnerTarballUrl memoises for a day and re-resolves after', async () => {
	__resetTarballCacheForTesting();
	let calls = 0;
	const get = async () => {
		calls++;
		return [{ os: 'linux', architecture: 'x64', download_url: `https://x/${calls}.tar.gz` }];
	};
	const t0 = 1_000_000;
	assert.equal(await runnerTarballUrl(get, 'tok', 'r', t0), 'https://x/1.tar.gz');
	assert.equal(await runnerTarballUrl(get, 'tok', 'r', t0 + 60_000), 'https://x/1.tar.gz');
	assert.equal(calls, 1, 'one call per day, not one per mint');
	assert.equal(
		await runnerTarballUrl(get, 'tok', 'r', t0 + 25 * 60 * 60 * 1000),
		'https://x/2.tar.gz'
	);
});

test('runnerTarballUrl fails SOFT — a mint that needs no payload must not break', async () => {
	// Every node that already has a payload mints without ever reading this.
	// An outage resolving it degrades to the pre-fix behaviour, it does not stop
	// the fleet.
	__resetTarballCacheForTesting();
	assert.equal(
		await runnerTarballUrl(
			async () => {
				throw new Error('502');
			},
			'tok',
			'r'
		),
		null
	);
	__resetTarballCacheForTesting();
	assert.equal(await runnerTarballUrl(async () => ({ message: 'Not Found' }), 'tok', 'r'), null);
	__resetTarballCacheForTesting();
	assert.equal(
		await runnerTarballUrl(async () => [{ os: 'win', architecture: 'x64' }], 'tok', 'r'),
		null
	);
});

/**
 * Characterization for the mechanics `retireStrandedJit` and
 * `evictWarmListener` (ephemeral-exec.ts) share before extraction: delete the
 * registration by name, and stop its unit ONLY once that delete succeeded.
 * Written first on the base, same style as `evictWarmListener`'s own pair in
 * warm-cache-mint-exec.test.ts, so both callers are pinned before the shared
 * mechanics move to one place.
 */
test('retireStrandedJit deletes the registration BEFORE stopping the unit', async () => {
	const order: string[] = [];
	const sh = async (_n: string, cmd: string) => {
		if (cmd.includes('systemctl --user stop')) order.push('stop');
		return '';
	};
	const gh = fakeGh({ runners: [{ id: 7, name: REQ.runnerName }] });
	const origWrite = gh.write;
	gh.write = async (m, p, t, b, r) => {
		if (m === 'DELETE') order.push('delete');
		return origWrite(m, p, t, b, r);
	};
	const ok = await retireStrandedJit('hokon', REQ.repo, REQ.runnerName, 'tok', gh, sh);
	assert.equal(ok, true);
	assert.deepEqual(order, ['delete', 'stop']);
});

test("retireStrandedJit stops NOTHING when GitHub refuses the delete — a runner GitHub won't delete is one still running a job", async () => {
	const cmds: string[] = [];
	const sh = async (_n: string, cmd: string) => {
		cmds.push(cmd);
		return '';
	};
	const gh = fakeGh({ runners: [{ id: 7, name: REQ.runnerName }] });
	gh.write = async () => ({ ok: false, status: 422 });
	const ok = await retireStrandedJit('hokon', REQ.repo, REQ.runnerName, 'tok', gh, sh);
	assert.equal(ok, false);
	assert.deepEqual(cmds, []);
});
