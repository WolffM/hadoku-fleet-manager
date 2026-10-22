import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	__resetTarballCacheForTesting,
	liveJitUnits,
	mintEphemeralRunner,
	runnerTarballUrl,
} from '../runners/ephemeral-exec.js';
import { GOOD_JITCONFIG, jitConfig } from './helpers/fleet-fakes.js';

const REQ = {
	node: 'hokon',
	repo: 'WolffM/hadoku-meet',
	runnerName: 'jit-hokon-hadoku-meet-1787797008',
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

test("#120: the node's declared slice reaches the unit — a guest's jobs land in ITS slice", async () => {
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

test('an unreachable node reports no units rather than throwing', async () => {
	assert.deepEqual(await liveJitUnits('hokon', async () => null), []);
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
	assert.match(seen[1], /^SLOT=0 RESET=1 .*bash ~\/\.hadoku\/jit-provision\.sh$/);
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
