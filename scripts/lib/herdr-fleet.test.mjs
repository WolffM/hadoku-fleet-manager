import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideCiAlert, STALE_STATE_MS } from '../../dist/ci-alerts.js';
import { tempDir } from './test-tmpdir.mjs';
import { BUDGET_ALERT_FRACTION } from '../../dist/gh-budget.js';
import { CLAW_STATES } from '../../dist/telemetry-vocabulary.js';
import {
	classify,
	classifyCi,
	classifyFleet,
	classifyNode,
	classifyPm2Host,
	fetchSnapshot,
	PM2_CAPABLE,
	isRedConclusion,
	loadSnapshot,
	PROBE_STALE_MS,
	READ_ATTEMPTS,
	SNAPSHOT_REFRESH_MS,
	snapshotVerdict,
	STATES,
} from './herdr-fleet.mjs';

// The real clock, not a pinned date: every fixture below is relative to NOW and
// every classifier takes it as a parameter (fixture-clock-guard).
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function machine(over = {}) {
	return {
		name: 'claw-1',
		state: 'mintable',
		reachable: true,
		workers: 0,
		admissionFree: 3,
		admissionCapacity: 3,
		admissionRefusal: null,
		starved: false,
		...over,
	};
}

/** A snapshot in the shape GET /fleet and /fleet/ci-state answer, using the SHIPPED vocabulary. */
function snap({ machines = [machine()], fleet = {}, workflows, budget, ...over } = {}) {
	return {
		fetchedAt: iso(1_000),
		error: null,
		fleet: {
			success: true,
			probedAt: iso(30_000),
			healthAt: iso(60_000),
			machines,
			vocabulary: { states: CLAW_STATES },
			githubBudget: budget ?? [
				{
					token: 'T',
					resource: 'core',
					limit: 5000,
					remaining: 4000,
					fractionLeft: 0.8,
					expired: false,
				},
			],
			fleet: { queuedNow: 0, runningNow: 0, oldestQueuedMin: 0, hung: 0 },
			...fleet,
		},
		ciState: {
			success: true,
			workflows: workflows ?? [{ label: 'a / ci', conclusion: 'success', lastSeen: iso(60_000) }],
		},
		...over,
	};
}

test('herdr-fleet: reports blocked and idle only — unknown is quiet, working toasts on every job', () => {
	assert.deepEqual([...STATES].sort(), ['blocked', 'idle']);
});

test('herdr-fleet: every state the server ships maps to a herdr state, by its kind', () => {
	for (const [state, term] of Object.entries(CLAW_STATES)) {
		const v = classifyNode(snap({ machines: [machine({ state })] }), 'claw-1', NOW);
		const quiet = term.kind === 'ok' || term.kind === 'reserve';
		assert.equal(v.state, quiet ? 'idle' : 'blocked', `${state} (${term.kind})`);
	}
});

test('herdr-fleet: the TelemetryKind union is the five kinds this file decides on', () => {
	// A sixth kind is a decision — page or not — and must not arrive silently.
	// It would read blocked (anything not ok/reserve pages), but whoever adds
	// it should say which it is.
	const src = readFileSync(new URL('../../src/fleet-report-types.ts', import.meta.url), 'utf8');
	const union = src.match(/export type TelemetryKind = ([^;]+);/)[1];
	const kinds = [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
	assert.deepEqual(kinds, ['degraded', 'fault', 'ok', 'reserve', 'unknown']);
});

test('herdr-fleet: a busy node is idle with its jobs in the message', () => {
	const busy = classifyNode(snap({ machines: [machine({ workers: 2 })] }), 'claw-1', NOW);
	assert.deepEqual([busy.state, busy.message], ['idle', 'mintable, 2 jobs running']);
	assert.equal(classifyNode(snap(), 'claw-1', NOW).state, 'idle');
	assert.equal(
		classifyNode(snap({ machines: [machine({ state: 'demoted' })] }), 'claw-1', NOW).state,
		'idle'
	);
});

test('herdr-fleet: every way of not knowing a node is blocked, with the reason', () => {
	const cases = [
		[snap({ machines: [machine({ state: 'unreachable' })] }), /unreachable/],
		[
			snap({ machines: [machine({ state: 'retired-yesterday' })] }),
			/not in the server's vocabulary/,
		],
		[snap({ machines: [machine({ starved: true })] }), /starved/],
		[snap({ machines: [] }), /not in the \/fleet roster/],
		[snap({ fleet: { probedAt: null } }), /has not probed yet/],
		[snap({ fleet: { probedAt: iso(PROBE_STALE_MS + 60_000) } }), /probe is \d+m old/],
	];
	for (const [s, why] of cases) {
		const v = classifyNode(s, 'claw-1', NOW);
		assert.equal(v.state, 'blocked');
		assert.match(v.message, why);
	}
});

test('herdr-fleet: an unreadable snapshot turns EVERY pane blocked, not last hour’s idle', () => {
	const bad = [
		[null, /first fetch/],
		[{ ...snap(), error: 'ECONNREFUSED' }, /could not read mgmt-api: ECONNREFUSED/],
		[{ ...snap(), fetchedAt: iso(PROBE_STALE_MS + 1) }, /nothing is refreshing/],
		[{ ...snap(), fetchedAt: 'garbage' }, /nothing is refreshing/],
		[{ ...snap(), fleet: { success: false } }, /without success/],
	];
	for (const [s, why] of bad) {
		assert.match(snapshotVerdict(s, NOW).message, why);
		for (const target of ['node:claw-1', 'ci', 'fleet']) {
			assert.equal(classify(target, s, NOW, ['claw-1']).state, 'blocked', `${target} on ${why}`);
		}
	}
});

test('herdr-fleet: a STORED conclusion is red exactly when decideCiAlert reads it as broken', () => {
	// The rows are stored state, not runs, so parity is with how the alerter
	// reads a stored row (its `wasFailure`): is a following green run a
	// recovery? Run-level parity would be wrong — the alerter ignores a
	// cancelled RUN and never stores it, but a stored `cancelled` (two legacy
	// targets had one) is read as broken.
	const stored = [
		'success',
		'failure',
		'cancelled',
		'skipped',
		'timed_out',
		'action_required',
		'neutral',
		'stale',
		'startup_failure',
	];
	const greenRun = { id: 2, conclusion: 'success', updated_at: new Date(NOW).toISOString() };
	for (const lastConclusion of stored) {
		const prev = { lastConclusion, lastRunId: 1, lastSeen: new Date(NOW).toISOString() };
		const recovered = decideCiAlert(prev, greenRun, NOW).action === 'recovered';
		assert.equal(isRedConclusion(lastConclusion), recovered, lastConclusion);
	}
});

test('herdr-fleet: ci is idle only when every row is green and recently polled', () => {
	assert.equal(classifyCi(snap(), NOW).state, 'idle');
	const cases = [
		[
			[{ label: 'p / redeploy', conclusion: 'timed_out', lastSeen: iso(1) }],
			/1 red: p \/ redeploy/,
		],
		[[{ label: 'n / ci', conclusion: null, lastSeen: null }], /1 unread/],
		[[{ label: 'f / ci', conclusion: null, lastSeen: iso(1) }], /1 unread/],
		[[{ label: 's / ci', conclusion: 'success', lastSeen: iso(STALE_STATE_MS + 1) }], /1 unread/],
		[[], /zero watched workflows/],
	];
	for (const [workflows, why] of cases) {
		const v = classifyCi(snap({ workflows }), NOW);
		assert.equal(v.state, 'blocked');
		assert.match(v.message, why);
	}
	assert.match(classifyCi({ ...snap(), ciState: null }, NOW).message, /did not answer/);
});

test('herdr-fleet: fleet pane pages on the budget line gh-budget pages on, and on roster drift', () => {
	assert.equal(classifyFleet(snap(), NOW, ['claw-1']).state, 'idle');
	const under = BUDGET_ALERT_FRACTION - 0.01;
	const cases = [
		[
			snap({
				budget: [{ token: 'T', limit: 5000, remaining: 900, fractionLeft: under, expired: false }],
			}),
			/% left/,
		],
		[
			snap({ budget: [{ token: 'T', limit: 5000, remaining: 0, fractionLeft: 0, expired: true }] }),
			/expired/,
		],
		[snap({ budget: [] }), /no GitHub budget reading/],
		[snap({ fleet: { healthAt: null } }), /runner-health never ran/],
		[snap({ fleet: { healthAt: iso(3 * 60 * 60_000) } }), /runner-health \d+m stale/],
		[snap({ machines: [machine(), machine({ name: 'claw-10' })] }), /no pane for claw-10/],
	];
	for (const [s, why] of cases) {
		const v = classifyFleet(s, NOW, ['claw-1']);
		assert.equal(v.state, 'blocked');
		assert.match(v.message, why);
	}
});

/** The pm2 reader a snapshot test passes: no host is asked. */
const NO_PM2 = async () => ({ error: null, hub: null, hosts: {}, services: [] });

function fakeFetch(responses) {
	const calls = [];
	const impl = async (url) => {
		calls.push(url);
		const r = responses(url, calls.length);
		if (r instanceof Error) throw r;
		return { ok: r.status === 200, status: r.status, json: async () => r.body };
	};
	return { impl, calls };
}

const ok = (url) => ({
	status: 200,
	body: url.endsWith('ci-state') ? { success: true, workflows: [] } : { success: true },
});

test('herdr-fleet: panes share one fetch while the snapshot is fresh', async () => {
	const dir = tempDir('herdr-fleet-');
	let clock = NOW;
	const f = fakeFetch(ok);
	const deps = { fetchImpl: f.impl, sleep: async () => {}, now: () => clock, pm2Reader: NO_PM2 };
	await loadSnapshot(dir, 'http://api', deps);
	await loadSnapshot(dir, 'http://api', deps);
	assert.equal(f.calls.length, 2, 'one /fleet + one /ci-state, once');
	clock += SNAPSHOT_REFRESH_MS;
	await loadSnapshot(dir, 'http://api', deps);
	assert.equal(f.calls.length, 4, 'refetched once a tick old');
});

test('herdr-fleet: a held lock means read what is there; a dead holder’s lock is cleared', async () => {
	const dir = tempDir('herdr-fleet-');
	const f = fakeFetch(ok);
	const deps = {
		fetchImpl: f.impl,
		sleep: async () => {},
		now: () => Date.now(),
		pm2Reader: NO_PM2,
	};
	const lock = join(dir, 'snapshot.lock');
	writeFileSync(lock, '');
	assert.equal(await loadSnapshot(dir, 'http://api', deps), null);
	assert.equal(f.calls.length, 0);
	const old = (Date.now() - 60_000) / 1000;
	utimesSync(lock, old, old);
	await loadSnapshot(dir, 'http://api', deps);
	const snapAfter = await loadSnapshot(dir, 'http://api', deps);
	assert.equal(snapAfter.error, null);
	assert.equal(f.calls.length, 2);
});

test('herdr-fleet: a failed fetch is a snapshot carrying the reason, after READ_ATTEMPTS', async () => {
	const dir = tempDir('herdr-fleet-');
	const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
	const f = fakeFetch((url) => (url.endsWith('/fleet') ? refused : ok(url)));
	const s = await loadSnapshot(dir, 'http://api', {
		fetchImpl: f.impl,
		sleep: async () => {},
		pm2Reader: NO_PM2,
	});
	assert.match(s.error, /http:\/\/api\/fleet: ECONNREFUSED fetch failed/);
	assert.equal(f.calls.filter((u) => u.endsWith('/fleet')).length, READ_ATTEMPTS);
	assert.equal(classifyNode(s, 'claw-1', Date.now()).state, 'blocked');
	// A transient failure is retried, not reported.
	const g = fakeFetch((url, n) => (url.endsWith('/fleet') && n === 1 ? { status: 503 } : ok(url)));
	rmSync(join(dir, 'snapshot.json'));
	assert.equal(
		(
			await loadSnapshot(dir, 'http://api', {
				fetchImpl: g.impl,
				sleep: async () => {},
				pm2Reader: NO_PM2,
			})
		).error,
		null
	);
});

test('herdr-fleet: a watcher that dies is reported blocked by its supervisor, not dropped', async (t) => {
	const dir = tempDir('herdr-fleet-');
	const log = join(dir, 'calls');
	const fakeHerdr = join(dir, 'herdr');
	writeFileSync(fakeHerdr, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
	chmodSync(fakeHerdr, 0o755);
	const supervise = new URL('../../herdr/hadoku-fleet/supervise.sh', import.meta.url).pathname;
	// No FLEET_HERDR_STATE, so watch.mjs refuses with exit 2: a real death.
	const child = spawn('sh', [supervise, 'node:claw-1'], {
		env: { PATH: process.env.PATH, HERDR_BIN_PATH: fakeHerdr, HERDR_PANE_ID: 'w1:p1' },
		stdio: 'ignore',
	});
	t.after(() => child.kill('SIGKILL'));
	const deadline = Date.now() + 10_000;
	let calls = '';
	while (Date.now() < deadline && !calls) {
		await new Promise((r) => setTimeout(r, 100));
		try {
			calls = readFileSync(log, 'utf8');
		} catch (err) {
			if (err.code !== 'ENOENT') throw err;
		}
	}
	assert.match(
		calls,
		// --seq in epoch ms, or herdr drops the report as older than the watcher's.
		/pane report-agent w1:p1 --source hadoku\.fleet --agent claw-1 --state blocked --message watcher exited 2; restarting in 10s --seq \d{13}\n/
	);
});

test('herdr-fleet: the plugin manifest declares no startup daemon', () => {
	const toml = readFileSync(
		new URL('../../herdr/hadoku-fleet/herdr-plugin.toml', import.meta.url),
		'utf8'
	);
	assert.doesNotMatch(toml, /^\[\[startup\]\]/m);
	assert.match(toml, /^id = "hadoku\.fleet"$/m);
	execFileSync('sh', [
		'-n',
		new URL('../../herdr/hadoku-fleet/supervise.sh', import.meta.url).pathname,
	]);
});

test('herdr-fleet: every verdict on every path is a state this plugin reports', () => {
	const snaps = [
		null,
		snap(),
		snap({ machines: [machine({ workers: 3 })] }),
		snap({ machines: [machine({ state: 'sick' })] }),
		snap({ workflows: [] }),
		{ ...snap(), error: 'x' },
	];
	for (const s of snaps) {
		for (const target of ['node:claw-1', 'node:gone', 'ci', 'fleet', 'bogus']) {
			assert.ok(STATES.includes(classify(target, s, NOW, ['claw-1']).state), target);
		}
	}
});

test('herdr-fleet: every GET /fleet field the plugin reads is still in the declared contract', () => {
	// The fixtures above are hand-built, so a rename in fleet-report-types.ts
	// would leave them green while the live pane read `undefined` — a
	// `starved` renamed away would never page again. This reads the contract.
	const src = readFileSync(new URL('../../src/fleet-report-types.ts', import.meta.url), 'utf8');
	const fields = [
		'probedAt',
		'healthAt',
		'machines',
		'vocabulary',
		'githubBudget',
		'state',
		'workers',
		'starved',
		'admissionRefusal',
		'admissionFree',
		'admissionCapacity',
		'fractionLeft',
		'expired',
		'remaining',
		'limit',
		'queuedNow',
		'runningNow',
		'oldestQueuedMin',
		'hung',
	];
	for (const f of fields) assert.match(src, new RegExp(`^\\s+${f}\\??:`, 'm'), f);
});

/** A pm2 snapshot: hokon is the hub, claw-4 a remote host, both pm2-capable. */
function pm2Snap({ hosts, services, machines, ...over } = {}) {
	const capable = { capabilities: { earned: [PM2_CAPABLE] } };
	return snap({
		machines: machines ?? [
			machine({ name: 'hokon', ...capable }),
			machine({ name: 'claw-4', ...capable }),
		],
		pm2: {
			error: null,
			hub: 'hokon',
			hosts: hosts ?? {
				hokon: {
					hub: true,
					error: null,
					procs: [
						{ name: 'tenhands', status: 'online', restarts: 0, since: NOW - 7_200_000 },
						{ name: 'valheim', status: 'stopped' },
						{ name: 'mgmt-api', status: 'online' },
					],
				},
				'claw-4': {
					hub: false,
					error: null,
					procs: [{ name: 'pygmalion', status: 'online', restarts: 10, since: NOW - 600_000 }],
				},
			},
			services: services ?? [
				{ name: 'tenhands', pm2: 'tenhands', host: 'hokon', enabled: true },
				{ name: 'pygmalion', pm2: 'pygmalion', host: 'claw-4', enabled: true },
				{ name: 'mgmt-api', pm2: 'mgmt-api', host: 'hokon', enabled: false },
			],
			...over,
		},
	});
}

test('herdr-fleet: a pm2 host is idle when everything placed on it runs there, and only there', () => {
	const hub = classifyPm2Host(pm2Snap(), 'hokon', NOW);
	assert.deepEqual([hub.state, hub.message], ['idle', '1 placed services online, 1 unmanaged']);
	assert.ok(
		hub.detail.some((l) => /stopped\s+valheim/.test(l)),
		'an unplaced process is shown'
	);
	assert.ok(
		hub.detail.some((l) => /mgmt-api \(disabled in deploy-config\)/.test(l)),
		'a disabled one is shown'
	);
	assert.equal(classifyPm2Host(pm2Snap(), 'claw-4', NOW).state, 'idle');
});

test('herdr-fleet: every way a pm2 host can be wrong is blocked, with the reason', () => {
	const base = pm2Snap().pm2;
	const capable = { capabilities: { earned: [PM2_CAPABLE] } };
	const cases = [
		[
			'hokon',
			pm2Snap({ hosts: { ...base.hosts, hokon: { ...base.hosts.hokon, procs: [] } } }),
			/tenhands is not running here/,
		],
		[
			'hokon',
			pm2Snap({
				hosts: {
					...base.hosts,
					hokon: { ...base.hosts.hokon, procs: [{ name: 'tenhands', status: 'errored' }] },
				},
			}),
			/tenhands is errored/,
		],
		[
			'hokon',
			pm2Snap({
				hosts: {
					...base.hosts,
					hokon: {
						...base.hosts.hokon,
						procs: [...base.hosts.hokon.procs, { name: 'pygmalion', status: 'online' }],
					},
				},
			}),
			/pygmalion is online here AND placed on claw-4: a double run/,
		],
		[
			'claw-4',
			pm2Snap({
				machines: [
					machine({ name: 'hokon', ...capable }),
					machine({ name: 'claw-4', capabilities: { earned: [] } }),
				],
			}),
			/has not earned pm2-capable/,
		],
		[
			'claw-4',
			pm2Snap({ machines: [machine({ name: 'hokon', ...capable })] }),
			/not in the \/fleet roster/,
		],
		[
			'claw-4',
			pm2Snap({
				hosts: {
					...base.hosts,
					'claw-4': { hub: false, error: 'could not reach claw-4: timeout', procs: null },
				},
			}),
			/could not read pm2 on claw-4: could not reach claw-4: timeout/,
		],
		['claw-9', pm2Snap(), /not in pm2-hosts.json/],
		['hokon', pm2Snap({ error: 'placement unreadable: ENOENT' }), /placement unreadable/],
		['hokon', { ...pm2Snap(), pm2: undefined }, /pm2 state was not read/],
	];
	for (const [host, s, why] of cases) {
		const v = classifyPm2Host(s, host, NOW);
		assert.equal(v.state, 'blocked', String(why));
		assert.match(v.message, why);
	}
});

test('herdr-fleet: a stopped process nothing places is shown, never judged', () => {
	const base = pm2Snap().pm2;
	const procs = [...base.hosts.hokon.procs, { name: 'obs-game-sort', status: 'errored' }];
	const v = classifyPm2Host(
		pm2Snap({ hosts: { ...base.hosts, hokon: { ...base.hosts.hokon, procs } } }),
		'hokon',
		NOW
	);
	assert.equal(v.state, 'idle');
});

test('herdr-fleet: the fleet pane carries a pm2 read failure and an unpaned pm2 host', () => {
	assert.match(
		classifyFleet(pm2Snap({ error: 'placement unreadable: x' }), NOW, ['hokon', 'claw-4'], [])
			.message,
		/pm2: placement unreadable/
	);
	assert.match(
		classifyFleet(pm2Snap(), NOW, ['hokon', 'claw-4'], ['hokon']).message,
		/no pm2 pane for claw-4/
	);
	assert.equal(
		classifyFleet(pm2Snap(), NOW, ['hokon', 'claw-4'], ['hokon', 'claw-4']).state,
		'idle'
	);
	assert.equal(
		classifyFleet(pm2Snap(), NOW, ['hokon', 'claw-4'], null).state,
		'idle',
		'a workspace from before pm2 panes is not flagged'
	);
});

test('herdr-fleet: a pm2 failure blocks the pm2 panes only, not the whole snapshot', async () => {
	const f = fakeFetch(ok);
	const s = await fetchSnapshot('http://api', {
		fetchImpl: f.impl,
		sleep: async () => {},
		pm2Reader: async () => ({ error: 'placement unreadable: x', hosts: {}, services: [] }),
	});
	assert.equal(s.error, null);
	assert.equal(s.pm2.error, 'placement unreadable: x');
});

test('herdr-fleet: a snapshot without an injected pm2 reader refuses before asking any host', async () => {
	const f = fakeFetch(ok);
	await assert.rejects(
		fetchSnapshot('http://api', { fetchImpl: f.impl, sleep: async () => {} }),
		/needs a pm2Reader/
	);
});
