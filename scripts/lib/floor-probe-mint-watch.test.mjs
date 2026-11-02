/**
 * `mintProbeRunner` / `watchProbeJobToSettle` — wave shrink-1 lane A dedup.
 * Pulled byte-for-byte out of `floor-probe-mode-probe.mjs`'s shadow path and
 * `floor-probe-mode-rerun.mjs`'s forced re-run, which carried the identical
 * mint-and-cleanup and watch-until-settled mechanics inline. Nothing tested
 * either directly before this move: `floor-probe.test.mjs` only reaches the
 * CLI's REFUSAL paths (safety, window, missing workflow), always before a
 * mint or a GitHub poll — see its own header. These are the first tests of
 * the mechanics themselves, with fake `gh`/`sh`, never a node or a network
 * call.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { mintProbeRunner, watchProbeJobToSettle } from './floor-probe-mint-watch.mjs';
import { __setHostForTesting } from '../../dist/host.js';

// `mintEphemeralRunner` (ephemeral-exec-jit.ts) logs through the injected
// host on a successful mint. `__setHostForTesting` bypasses the real host's
// path-existence checks (`installHost`'s `requirePaths`) entirely — nothing
// here reads a manifest or a state dir, only the logger.
before(() => {
	__setHostForTesting({
		logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		alerts: {
			post: async () => ({ posted: false, sinkRecorded: false }),
			recordQuietly: () => undefined,
		},
		jobs: { recordJobResult: async () => undefined },
		githubToken: () => undefined,
		manifestDir: '/nonexistent',
		stateDir: '/nonexistent',
		storeDoctorPath: '/nonexistent',
	});
});
after(() => {
	__setHostForTesting(null);
});

/** A jitconfig `assertSafeJitConfig` accepts — same shape as the TS fleet-fakes helper. */
function jitConfig(runner) {
	return Buffer.from(
		JSON.stringify({ '.runner': Buffer.from(JSON.stringify(runner)).toString('base64') })
	).toString('base64');
}
const GOOD_JITCONFIG = jitConfig({ DisableUpdate: 'True', Ephemeral: 'True' });

const REQ = {
	node: 'claw-5',
	repo: 'WolffM/hadoku-rally',
	runnerName: 'jit-claw-5-hadoku-rally-1787797008-0-0',
	machines: { 'claw-5': { slice: { unitMaxMb: 4096 } } },
	mintLabelsFor: () => ['hadoku-builder'],
	PROBE_SLOT: 9,
	PROBE_TTL_SECONDS: 900,
};

/** Records the order of operations. */
function harness(over = {}) {
	const calls = [];
	const sh = async (_node, cmd) => {
		if (cmd.includes('CFG-OK')) return 'CFG-OK';
		if (cmd.includes('jit-provision')) {
			calls.push('provision');
			return over.prov === undefined
				? 'SLOT-READY /home/hadoku/.hadoku/jit/slot9 2.336.0'
				: over.prov;
		}
		if (cmd.includes('systemctl --user stop')) {
			calls.push('stop');
			return '';
		}
		calls.push('spawn');
		return over.spawn === undefined ? 'Running as unit: x.service' : over.spawn;
	};
	const gh = {
		get: async (path) => {
			calls.push(`get ${path}`);
			if (path.includes('/jobs')) return { ok: true, body: { jobs: over.jobs ?? [] } };
			return { ok: true, body: { runners: over.runners ?? [{ id: 7, name: REQ.runnerName }] } };
		},
		write: async (m, p) => {
			calls.push(`${m} ${p}`);
			if (p.includes('generate-jitconfig')) {
				return over.mintOk === false
					? { ok: false, status: 422 }
					: { ok: true, status: 201, body: { encoded_jit_config: over.cfg ?? GOOD_JITCONFIG } };
			}
			return { ok: true, status: 204 };
		},
		spent: () => over.spent ?? 3,
	};
	return { calls, sh, gh };
}

test('mintProbeRunner: a successful mint returns a cleanUp and never calls fail', async () => {
	const { calls, sh, gh } = harness();
	const releases = [];
	const fail = () => assert.fail('must not fail on a successful mint');
	const cleanUp = await mintProbeRunner({
		...REQ,
		token: 'tok',
		gh,
		sh,
		releaseIntent: () => releases.push('release'),
		fail,
	});
	assert.equal(typeof cleanUp, 'function');
	assert.deepEqual(calls, ['provision', `POST /actions/runners/generate-jitconfig`, 'spawn']);
	assert.deepEqual(releases, [], 'releaseIntent is only for the failure path and for settling');
});

test("mintProbeRunner: a failed mint releases the intent BEFORE calling fail, and the shadow path's detail reads gh.spent() at that point", async () => {
	const { sh, gh } = harness({ mintOk: false, spent: 11 });
	const order = [];
	let failArgs = null;
	const fail = (msg, extra) => {
		order.push('fail');
		failArgs = [msg, extra];
	};
	await mintProbeRunner({
		...REQ,
		token: 'tok',
		gh,
		sh,
		releaseIntent: () => order.push('release'),
		fail,
		mintFailDetail: () => ({ node: REQ.node, spent: gh.spent() }),
	});
	assert.deepEqual(order, ['release', 'fail']);
	assert.match(failArgs[0], /could not mint on claw-5/);
	assert.deepEqual(failArgs[1], { node: 'claw-5', spent: 11 });
});

test('mintProbeRunner: the forced-rerun caller omits mintFailDetail, and fail is called with no second argument — same as its original inline `fail(msg)`', async () => {
	const { sh, gh } = harness({ mintOk: false });
	let failArgsLength = null;
	const fail = (...args) => {
		failArgsLength = args.length;
	};
	await mintProbeRunner({
		...REQ,
		token: 'tok',
		gh,
		sh,
		releaseIntent: () => {},
		fail,
	});
	// `extra` is passed as `undefined` (mintFailDetail's default), which the
	// CLI's own `fail(msg, extra = {})` already treats identically to omitting
	// the argument — see floor-probe.mjs's `fail`.
	assert.equal(failArgsLength, 2);
});

test('mintProbeRunner-returned cleanUp deletes the registration BEFORE stopping the unit', async () => {
	const { calls, sh, gh } = harness();
	const cleanUp = await mintProbeRunner({
		...REQ,
		token: 'tok',
		gh,
		sh,
		releaseIntent: () => {},
		fail: () => assert.fail('no mint failure in this test'),
	});
	calls.length = 0;
	await cleanUp();
	assert.deepEqual(calls, [
		'get /actions/runners?per_page=100',
		'DELETE /actions/runners/7',
		'stop',
	]);
});

const WATCH_BASE = {
	gh: null,
	runId: 42,
	repo: 'WolffM/hadoku-rally',
	jobName: 'check',
	NODES: ['claw-5', 'claw-6'],
	runnerName: 'jit-claw-5-hadoku-rally-1787797008-0-0',
};

/** A fixed moment relative to `Date.now()` — never an absolute calendar date. */
const ts = (secOffset) => new Date(Date.now() + secOffset * 1000).toISOString();

test('watchProbeJobToSettle: a job served by OUR runner settles without calling cleanUp, and always releases the intent', async () => {
	const polls = [];
	const gh = {
		get: async (path) => {
			polls.push(path);
			return {
				ok: true,
				body: {
					jobs: [
						{
							name: 'check',
							runner_name: WATCH_BASE.runnerName,
							status: 'completed',
							conclusion: 'success',
							started_at: ts(0),
							completed_at: ts(30),
							steps: [],
						},
					],
				},
			};
		},
	};
	let cleanedUp = false;
	let released = false;
	const result = await watchProbeJobToSettle({
		...WATCH_BASE,
		gh,
		cleanUp: async () => {
			cleanedUp = true;
		},
		releaseIntent: () => {
			released = true;
		},
	});
	assert.equal(polls.length, 1, 'settles on the first poll — no sleep ever reached');
	assert.equal(result.observed, 'claw-5');
	assert.equal(result.conclusion, 'success');
	assert.equal(result.durationSec, 30);
	assert.equal(result.servedBy, WATCH_BASE.runnerName);
	assert.equal(cleanedUp, false, 'OUR runner served it — nothing to clean up');
	assert.equal(released, true, 'the declaration is released whether consumed or not');
});

test('watchProbeJobToSettle: MISSED — a different runner served it, so cleanUp runs and the probe is not forced', async () => {
	const gh = {
		get: async () => ({
			ok: true,
			body: {
				jobs: [
					{
						name: 'check',
						runner_name: 'jit-claw-6-hadoku-rally-999-0-0',
						status: 'completed',
						conclusion: 'success',
						started_at: ts(0),
						completed_at: ts(10),
						steps: [],
					},
				],
			},
		}),
	};
	let cleanedUp = false;
	const result = await watchProbeJobToSettle({
		...WATCH_BASE,
		gh,
		cleanUp: async () => {
			cleanedUp = true;
		},
		releaseIntent: () => {},
	});
	assert.equal(result.observed, 'claw-6');
	assert.equal(cleanedUp, true, 'our runner was never consumed — it must be torn down');
});

test('watchProbeJobToSettle: a failed job carries its failing step, and the run never appearing in a poll is handled without throwing', async () => {
	const gh = {
		get: async () => ({
			ok: true,
			body: {
				jobs: [
					{
						name: 'check',
						runner_name: WATCH_BASE.runnerName,
						status: 'completed',
						conclusion: 'failure',
						started_at: ts(0),
						completed_at: ts(60),
						steps: [{ name: 'pnpm test', conclusion: 'failure' }],
					},
				],
			},
		}),
	};
	const result = await watchProbeJobToSettle({
		...WATCH_BASE,
		gh,
		cleanUp: async () => {},
		releaseIntent: () => {},
	});
	assert.equal(result.conclusion, 'failure');
	assert.equal(result.failedStep, 'pnpm test');
	assert.equal(result.durationSec, 60);
});

test('watchProbeJobToSettle: a GitHub read that fails, or that never names our job, is RETRIED on the next poll rather than treated as settled', async () => {
	// `wait` is injected (defaulting to the real 20s `sleep` in production, for
	// both callers unchanged) so this drives several iterations without a real
	// delay.
	const waits = [];
	let poll = 0;
	const gh = {
		get: async () => {
			poll++;
			if (poll === 1) return { ok: false, why: 'GitHub did not answer', body: null };
			if (poll === 2) return { ok: true, body: { jobs: [] } }; // job not visible yet
			return {
				ok: true,
				body: {
					jobs: [
						{
							name: 'check',
							runner_name: WATCH_BASE.runnerName,
							status: 'completed',
							conclusion: 'success',
							started_at: ts(0),
							completed_at: ts(5),
							steps: [],
						},
					],
				},
			};
		},
	};
	const result = await watchProbeJobToSettle({
		...WATCH_BASE,
		gh,
		cleanUp: async () => {},
		releaseIntent: () => {},
		wait: async (ms) => {
			waits.push(ms);
		},
	});
	assert.equal(poll, 3, 'two non-terminal polls, then the one that settled');
	assert.deepEqual(waits, [20_000, 20_000]);
	assert.equal(result.conclusion, 'success');
});
