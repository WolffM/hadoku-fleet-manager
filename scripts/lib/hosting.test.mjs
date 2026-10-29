import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	CI_RANK_SCRIPT,
	coresFromCpuMax,
	deployScript,
	fitProblems,
	judgeHosting,
	leftoversScript,
	mibFromMemoryMax,
	parseLeftovers,
	observeScript,
	parseCores,
	parseMemoryMb,
	parseObserved,
	parsePortProbe,
	peerCandidates,
	portProbeScript,
	probeReach,
	removeScript,
} from './hosting.mjs';

import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { validateHostingRequest } from './hosting-request.mjs';
import { runtimeFor } from './hosting-runtimes.mjs';
import { tenantSpecFrom } from './tenant-registry.mjs';

/** cardtable's spec, derived from its real request: the names the old TENANTS row held. */
const CARDTABLE = tenantSpecFrom(
	validateHostingRequest(
		JSON.parse(readFileSync(new URL('./fixtures/hosting-cardtable.json', import.meta.url), 'utf8'))
	).request
);

const DECLARED = { tenant: 'cardtable', memoryMb: 8192, cores: 4, port: 7621 };
const SLICE_CG = `/hosting.slice/${CARDTABLE.slice}`;
const MIB = 1048576;

/**
 * A whole-box node serving exactly DECLARED: the shape of claw-8's 2026-10-24
 * answer, carried to the system-unit design (§9). `ciGroups` is the CI user's
 * groups as claw-8 reported them; the agent's own group shares none.
 */
const answer = (over = {}) =>
	[
		'noise before the marker',
		'OBSERVE-BEGIN',
		...Object.entries({
			memTotalMb: 15900,
			nproc: 8,
			uptimeSec: 4000,
			bootId: 'boot-a',
			ciWorkers: 0,
			ciListeners: 0,
			sliceCgroup: SLICE_CG,
			memoryMax: String(8192 * MIB),
			memoryMin: String(8192 * MIB),
			swapMax: '0',
			cpuMax: '400000 100000',
			memoryCurrent: String(300 * MIB),
			oomKills: 0,
			throttledUsec: 0,
			parentWeight: 10000,
			parentMemoryMin: String(8192 * MIB),
			agentUid: 996,
			agentShell: '/usr/sbin/nologin',
			agentGroups: '993',
			ciGroups: '1000 4 24 27 104 999',
			agentSudo: 0,
			homeStat: 'cardtable-agent:cardtable-agent:700',
			execDirStat: 'root:root:755',
			execStat: 'root:root:755',
			agentInstalled: 'yes',
			listenerPid: 4242,
			listenerCgroup: `${SLICE_CG}/${CARDTABLE.service}`,
			listenerUid: 996,
			listenerOom: -500,
			ciProcs: 0,
			ciOutsideRunners: 0,
			ciBelowOom: 0,
			ciMinOom: '',
			tailnet4: '198.51.100.9',
			tailnet6: '2001:db8::9',
			ciSliceMax: String(27904 * MIB),
			ciSliceHigh: String((27904 - 8192) * MIB),
			...over,
		}).map(([k, v]) => `${k}=${v}`),
		'OBSERVE-END',
	].join('\n');

/** The port as it should be: the controller gets in on every address, another node on none. */
const REACH = {
	addrs: { lan: '192.0.2.9', tailnet4: '198.51.100.9', tailnet6: '2001:db8::9' },
	controller: { lan: 'open', tailnet4: 'open', tailnet6: 'open' },
	peer: { node: 'claw-8', lan: 'filtered', tailnet4: 'filtered', tailnet6: 'filtered' },
};
const judge = (over, mode = 'whole', reach = REACH) =>
	judgeHosting(DECLARED, parseObserved(answer(over)), mode, reach, CARDTABLE);
const categories = (r) => r.findings.filter((f) => f.class === 'blocking').map((f) => f.category);

test('a node serving exactly what was declared has no findings', () => {
	const r = judge();
	assert.deepEqual(r.findings, []);
	assert.equal(r.observed.memoryMb, 8192);
	assert.equal(r.observed.memoryMinMb, 8192);
	assert.equal(r.observed.cores, 4);
	assert.equal(r.observed.agent, 'listening');
	assert.deepEqual(r.observed.agentProcess, { uid: 996, oomScoreAdj: -500 });
});

test('the kernel disagreeing with the declaration is BLOCKING, per resource', () => {
	assert.deepEqual(categories(judge({ memoryMax: String(4096 * MIB) })), ['hosting-memory']);
	assert.deepEqual(categories(judge({ memoryMax: 'max' })), ['hosting-memory']);
	assert.deepEqual(categories(judge({ memoryMin: '0' })), ['hosting-memory-min']);
	assert.deepEqual(categories(judge({ cpuMax: 'max 100000' })), ['hosting-cores']);
	assert.deepEqual(categories(judge({ swapMax: 'max' })), ['hosting-swap']);
});

test("a parent at memory.min 0 caps the slice's protection at 0, and equal weight is no priority", () => {
	assert.deepEqual(categories(judge({ parentMemoryMin: '0' })), ['hosting-memory-min']);
	assert.deepEqual(categories(judge({ parentMemoryMin: '' })), ['hosting-memory-min']);
	assert.deepEqual(categories(judge({ parentWeight: 100 })), ['hosting-cpu-weight']);
});

test("the agent's own user: no login shell, no sudo, no group shared with CI", () => {
	assert.deepEqual(categories(judge({ agentUid: '' })), ['hosting-user', 'hosting-agent']);
	assert.deepEqual(categories(judge({ agentShell: '/bin/bash' })), ['hosting-user']);
	assert.deepEqual(categories(judge({ agentGroups: '993 104' })), ['hosting-user']);
	assert.deepEqual(categories(judge({ agentGroups: '' })), ['hosting-user']);
	assert.deepEqual(categories(judge({ agentSudo: 1 })), ['hosting-user']);
	assert.deepEqual(categories(judge({ agentSudo: '' })), ['hosting-user']);
});

test('only root may write what the agent runs; only the agent may enter its home', () => {
	assert.deepEqual(categories(judge({ execStat: 'hadoku:hadoku:755' })), ['hosting-files']);
	assert.deepEqual(categories(judge({ execStat: 'root:root:775' })), ['hosting-files']);
	assert.deepEqual(categories(judge({ execDirStat: 'root:root:777' })), ['hosting-files']);
	assert.deepEqual(categories(judge({ homeStat: 'cardtable-agent:cardtable-agent:755' })), [
		'hosting-files',
	]);
	assert.deepEqual(categories(judge({ homeStat: '' })), ['hosting-files']);
	// Not installed yet is the tenant's next step, not a file fault.
	const absent = judge({ execStat: '', agentInstalled: 'no', listenerPid: '', listenerCgroup: '' });
	assert.deepEqual(categories(absent), []);
});

test('the agent runs as its user, at its OOM rank', () => {
	assert.deepEqual(categories(judge({ listenerUid: 1000 })), ['hosting-agent']);
	assert.deepEqual(categories(judge({ listenerOom: 0 })), ['hosting-oom']);
	assert.deepEqual(categories(judge({ listenerOom: '' })), ['hosting-oom']);
});

test('shared: CI may run, but every CI process ranks below the slice', () => {
	const busy = { ciWorkers: 2, ciListeners: 3, ciProcs: 5, ciMinOom: 500 };
	assert.deepEqual(categories(judge(busy, 'shared')), []);
	assert.deepEqual(categories(judge(busy, 'whole')), ['hosting-ci']);
	assert.deepEqual(categories(judge({ ...busy, ciOutsideRunners: 1 }, 'shared')), ['hosting-ci']);
	const low = judge({ ...busy, ciBelowOom: 1, ciMinOom: 100 }, 'shared');
	assert.deepEqual(categories(low), ['hosting-oom']);
	assert.match(low.findings[0].why, /lowest 100/);
	assert.deepEqual(categories(judge({ ciProcs: '' }, 'shared')), ['hosting-ci']);
});

test("the slice hitting its own ceiling is the tenant's information, not a fault", () => {
	const r = judge({ oomKills: 3 });
	assert.deepEqual(categories(r), []);
	assert.equal(r.findings[0].category, 'hosting-slice-oom');
});

test('no slice cgroup at all means nothing is served', () => {
	assert.deepEqual(
		categories(judge({ sliceCgroup: '', memoryMax: '', memoryMin: '', cpuMax: '', swapMax: '' })),
		['hosting-slice']
	);
});

test('CI on a hosting node is BLOCKING, and so is not being able to count it', () => {
	assert.deepEqual(categories(judge({ ciWorkers: 1 })), ['hosting-ci']);
	assert.deepEqual(categories(judge({ ciListeners: 2 })), ['hosting-ci']);
	assert.deepEqual(categories(judge({ ciWorkers: '' })), ['hosting-ci']);
});

test('the port is judged by connecting: the controller gets in, and nothing else does', () => {
	assert.equal(judge().observed.portOpenToController, true);
	// Not probed at all is not "closed".
	assert.deepEqual(categories(judge({}, 'whole', null)), ['hosting-port']);
	assert.deepEqual(categories(judge({}, 'whole', { ...REACH, controller: null })), [
		'hosting-port',
	]);
	const ctl = (over) => ({ ...REACH, controller: { ...REACH.controller, ...over } });
	assert.deepEqual(categories(judge({}, 'whole', ctl({ lan: 'filtered' }))), ['hosting-port']);
	// The tailnet path missing while the LAN works is worth saying, not blocking.
	const tsOnly = judge({}, 'whole', ctl({ tailnet4: 'filtered' }));
	assert.deepEqual(categories(tsOnly), []);
	assert.equal(tsOnly.findings[0].category, 'hosting-port');
});

test('another node reaching the port is EXPOSED, and so is nobody being able to look', () => {
	const peer = (over) => ({ ...REACH, peer: { ...REACH.peer, ...over } });
	// cardtable 2026-10-27: claw-8 reached claw-9's agent through the mesh allow.
	const mesh = judge({}, 'shared', peer({ tailnet4: 'open' }));
	assert.deepEqual(categories(mesh), ['hosting-port-exposed']);
	assert.match(mesh.findings[0].why, /claw-8 reaches 7621\/tcp on the tailnet4 address/);
	assert.deepEqual(categories(judge({}, 'shared', peer({ tailnet6: 'open' }))), [
		'hosting-port-exposed',
	]);
	assert.deepEqual(categories(judge({}, 'shared', peer({ lan: 'unknown' }))), [
		'hosting-port-exposed',
	]);
	assert.deepEqual(categories(judge({}, 'shared', { ...REACH, peer: null })), [
		'hosting-port-exposed',
	]);
	const noTailnet = { ...REACH, addrs: { ...REACH.addrs, tailnet4: null } };
	assert.deepEqual(categories(judge({}, 'shared', noTailnet)), ['hosting-port-exposed']);
});

test('a probe line says what the connection did; only a finished probe is an answer', () => {
	const out = [
		'PROBE lan connected',
		'PROBE tailnet4 refused',
		'PROBE tailnet6 timeout',
		'PROBE x noroute',
		'PROBE y error',
		'PROBE-END',
	].join('\n');
	assert.deepEqual(parsePortProbe(out), {
		lan: 'open',
		tailnet4: 'open',
		tailnet6: 'filtered',
		x: 'filtered',
		y: 'unknown',
	});
	assert.equal(parsePortProbe('PROBE lan timeout\n'), null);
	const script = portProbeScript({ lan: '192.0.2.9', tailnet6: '2001:db8::9' }, 7621);
	assert.match(script, /probe 'lan' '192\.0\.2\.9'/);
	assert.match(script, /probe 'tailnet6' '2001:db8::9'/);
});

test('probeReach asks the controller, then other nodes until one finishes', async () => {
	const asked = [];
	const run = async (node) => {
		asked.push(node);
		if (node === 'claw-2') return { stdout: '' };
		return { stdout: 'PROBE lan timeout\nPROBE tailnet4 timeout\nPROBE-END\n' };
	};
	const r = await probeReach({
		port: 7621,
		addrs: { lan: '192.0.2.9', tailnet4: '198.51.100.9', tailnet6: null },
		peers: ['claw-2', 'claw-3', 'claw-4'],
		run,
	});
	assert.deepEqual(asked, ['hokon', 'claw-2', 'claw-3']);
	assert.equal(r.peer.node, 'claw-3');
	assert.equal(r.controller.lan, 'filtered');
});

test('the peers are other non-guest nodes, never the node itself or the controller', () => {
	const manifest = {
		machines: { hokon: {}, 'claw-9': {}, 'claw-8': {}, guesty: { role: 'guest' } },
	};
	assert.deepEqual(peerCandidates(manifest, 'claw-9'), ['claw-8']);
});

test('the deploy closes the port to the tailnet BEFORE tailscale accepts it, controller excepted', () => {
	const s = deployScript(
		CARDTABLE,
		{ memoryMb: 4096, cores: 4 },
		{ lan: '192.0.2.10', tailnet4: '198.51.100.1', tailnet6: '2001:db8::1' }
	);
	// tailscaled's ts-input ACCEPTs all of tailscale0 ahead of ufw, so the drop is in raw.
	assert.match(s, /ExecStart=\/usr\/sbin\/iptables -t raw -I PREROUTING 1 \$R4/);
	assert.match(s, /R4="-i tailscale0 -p tcp --dport \$PORT ! -s \$CTL_TS4 -j DROP"/);
	assert.match(s, /CTL_TS4='198\.51\.100\.1'/);
	assert.doesNotMatch(s, /ufw (allow|prepend|insert) .*tailscale0/);
	// The never-reached ufw rules from 0.34.91 are dropped, not kept.
	assert.match(s, /ufw --force delete/);
});

test('a re-deploy that changes no unit does not restart the agent', () => {
	const s = deployScript(
		CARDTABLE,
		{ memoryMb: 4096, cores: 4 },
		{ lan: '192.0.2.10', tailnet4: '198.51.100.1', tailnet6: null }
	);
	assert.match(s, /\*" \$SLICE "\*\|\*" \$SERVICE "\*\) \$S systemctl restart "\$SERVICE"/);
	assert.doesNotMatch(s, /then \$S systemctl restart "\$SERVICE"; fi/);
});

test('an agent outside the slice escapes the limits — BLOCKING; one not yet installed is the tenant’s step', () => {
	assert.deepEqual(categories(judge({ listenerCgroup: '/system.slice/elsewhere.service' })), [
		'hosting-agent',
	]);
	const absent = judge({ listenerPid: '', listenerCgroup: '', agentInstalled: 'no' });
	assert.deepEqual(categories(absent), []);
	assert.equal(absent.observed.agent, 'not-installed');
	assert.equal(absent.findings[0].class, 'advisory');
});

test('an answer cut off before its end marker is unobserved, never a pass', () => {
	assert.equal(parseObserved(answer().replace('OBSERVE-END', '')), null);
	assert.deepEqual(categories(judgeHosting(DECLARED, null, 'whole', null, CARDTABLE)), [
		'hosting-unobserved',
	]);
});

test('an unknown tenant is refused rather than judged against nothing', () => {
	assert.deepEqual(
		categories(
			judgeHosting(
				{ ...DECLARED, tenant: 'nobody' },
				parseObserved(answer()),
				'whole',
				null,
				CARDTABLE
			)
		),
		['hosting-tenant']
	);
});

test('cgroup value parsing', () => {
	assert.equal(coresFromCpuMax('600000 100000'), 6);
	assert.equal(coresFromCpuMax('max 100000'), null);
	assert.equal(coresFromCpuMax(''), null);
	assert.equal(mibFromMemoryMax('12884901888'), 12288);
	assert.equal(mibFromMemoryMax('max'), null);
});

test('declarations parse strictly', () => {
	assert.equal(parseMemoryMb('12G'), 12288);
	assert.equal(parseMemoryMb('12288M'), 12288);
	assert.equal(parseMemoryMb('12288'), 12288);
	assert.throws(() => parseMemoryMb('lots'));
	assert.throws(() => parseMemoryMb('100M'), /at least 256/);
	assert.equal(parseCores('6'), 6);
	assert.throws(() => parseCores('1.5'));
	assert.throws(() => parseCores('0'));
});

test('a declaration must fit the node as measured, with its own floor kept', () => {
	assert.deepEqual(fitProblems({ memoryMb: 8192, cores: 4 }, { memTotalMb: 15900, nproc: 8 }), []);
	assert.equal(
		fitProblems({ memoryMb: 15500, cores: 4 }, { memTotalMb: 15900, nproc: 8 }).length,
		1
	);
	assert.equal(
		fitProblems({ memoryMb: 8192, cores: 12 }, { memTotalMb: 15900, nproc: 8 }).length,
		1
	);
	assert.equal(
		fitProblems({ memoryMb: 8192, cores: 4 }, { memTotalMb: null, nproc: null }).length,
		2
	);
});

test("the tenant's workers outlive an agent restart, and not a teardown", () => {
	const s = deployScript(
		CARDTABLE,
		{ memoryMb: 4096, cores: 4 },
		{ lan: '192.0.2.10', tailnet4: '198.51.100.1', tailnet6: null }
	);
	assert.match(s, /^Delegate=yes$/m);
	assert.match(s, /^KillMode=process$/m);
	const r = removeScript(CARDTABLE, '192.0.2.10');
	assert.ok(
		r.indexOf('--kill-whom=all --signal=SIGKILL') < r.indexOf('disable --now'),
		'the workers are killed before the unit goes'
	);
});

test('shared: CI is throttled below its ceiling by the slice, so it cannot push the box into reclaim', () => {
	assert.deepEqual(categories(judge({}, 'shared')), []);
	assert.deepEqual(categories(judge({ ciSliceHigh: 'max' }, 'shared')), ['hosting-ci-headroom']);
	assert.deepEqual(categories(judge({ ciSliceHigh: String(27904 * MIB) }, 'shared')), [
		'hosting-ci-headroom',
	]);
	// Lower than needed is fine: the deploy took the slice from a smaller ceiling.
	assert.deepEqual(categories(judge({ ciSliceHigh: String(10000 * MIB) }, 'shared')), []);
	// A ceiling we cannot read is a headroom we cannot check.
	assert.deepEqual(categories(judge({ ciSliceMax: 'max' }, 'shared')), ['hosting-ci-headroom']);
	assert.deepEqual(categories(judge({ ciSliceMax: '' }, 'shared')), ['hosting-ci-headroom']);
	// Whole-box: CI is not on the node, so its slice is not judged.
	assert.deepEqual(categories(judge({ ciSliceHigh: 'max' }, 'whole')), []);
});

test('only a shared deploy takes the slice out of CI; whole and remove put it back', () => {
	const ctl = { lan: '192.0.2.10', tailnet4: '198.51.100.1', tailnet6: null };
	const res = { memoryMb: 4096, cores: 4 };
	assert.match(
		deployScript(CARDTABLE, res, ctl, { shared: true }),
		/set-property runners\.slice "MemoryHigh=\$\(\( ci_max \/ 1048576 - MEMORY_MB \)\)M"/
	);
	assert.match(
		deployScript(CARDTABLE, res, ctl),
		/set-property runners\.slice MemoryHigh=infinity/
	);
	assert.match(removeScript(CARDTABLE, '192.0.2.10'), /MemoryHigh=infinity/);
});

test('CI is counted by PROCESS NAME: a probe whose command line says Runner.Worker is not CI', () => {
	// claw-9, 2026-10-27 06:57Z: mgmt-api's own probe, running as
	// `bash -c '... pgrep -ax Runner.Worker ...'` in the ssh session at oom 0,
	// was counted as an unranked CI process outside runners.slice.
	const s = observeScript(CARDTABLE, 'hadoku');
	assert.doesNotMatch(s, /pgrep -[a-z]*f/);
	assert.match(s, /pgrep -x 'Runner\\.\(Listener\|Worker\)'/);
	assert.match(s, /^CI_USER='hadoku'$/m);
});

test('A11: a teardown is read back, and a cut-off answer is not "nothing left"', () => {
	assert.deepEqual(parseLeftovers('LEFTOVERS-END\n'), { complete: true, left: [] });
	assert.deepEqual(
		parseLeftovers(
			'LEFT cgroup /sys/fs/cgroup/hosting.slice\nLEFT-UNKNOWN sudo is not available\nLEFTOVERS-END'
		),
		{ complete: true, left: ['cgroup /sys/fs/cgroup/hosting.slice', 'sudo is not available'] }
	);
	assert.equal(parseLeftovers('LEFT unit file x\n').complete, false);
	const s = leftoversScript(CARDTABLE);
	for (const what of [
		'unit file',
		'cgroup',
		'executable',
		'running as',
		'ufw rule',
		'raw rule',
		'memory.high',
	])
		assert.ok(s.includes(what), `the read-back looks for: ${what}`);
});

test("after a cutover, CI's headroom is set in the ci user's manager, found by uid", () => {
	const ctl = { lan: '192.0.2.10', tailnet4: '198.51.100.1', tailnet6: null };
	const s = deployScript(CARDTABLE, { memoryMb: 4096, cores: 4 }, ctl, {
		shared: true,
		ciUser: 'hadoku-ci',
	});
	assert.match(s, /^CI_USER='hadoku-ci'$/m);
	// Through root's -M <user>@ when the ci user is not the ssh user.
	assert.match(s, /sudo -n systemctl --user -M "\$CI_USER@" "\$@"/);
	assert.match(s, /ci_systemctl set-property runners\.slice "MemoryHigh=/);
	// By uid, never the first runners.slice find returns: admin's manager may keep a leftover.
	assert.match(s, /user-\$ci_uid\.slice\/user@\$ci_uid\.service\/runners\.slice/);
	assert.doesNotMatch(
		s,
		/find \/sys\/fs\/cgroup\/user\.slice -maxdepth 4 -type d -name runners\.slice/
	);
	assert.match(
		removeScript(CARDTABLE, '192.0.2.10', { ciUser: 'hadoku-ci' }),
		/^CI_USER='hadoku-ci'$/m
	);
});

/** archivebot's spec: a pm2 `service` tenant, the runtime that declares home files. */
const ARCHIVEBOT = tenantSpecFrom(
	validateHostingRequest(
		JSON.parse(readFileSync(new URL('./fixtures/hosting-archivebot.json', import.meta.url), 'utf8'))
	).request
);
const NPMRC_SHA = createHash('sha256')
	.update(
		'//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n@wolffm:registry=https://npm.pkg.github.com\n'
	)
	.digest('hex');

test("a pm2 tenant's home gets the tokenless .npmrc its deploy's install needs; an agent's does not", () => {
	const ctl = { lan: '192.0.2.10', tailnet4: '198.51.100.1', tailnet6: null };
	const s = deployScript(ARCHIVEBOT, { memoryMb: 1024, cores: 1 }, ctl, { shared: true });
	assert.match(s, new RegExp(`!= "${NPMRC_SHA}" \\]; then`));
	assert.match(
		s,
		/install -m 0600 -o "\$AGENT_USER" -g "\$AGENT_USER" \/dev\/stdin '\/var\/lib\/archivebot-svc\/\.npmrc'/
	);
	assert.doesNotMatch(s, /NODE_AUTH_TOKEN/, 'the text travels base64, never as shell');
	assert.doesNotMatch(deployScript(CARDTABLE, { memoryMb: 4096, cores: 4 }, ctl), /\.npmrc/);
	assert.match(observeScript(ARCHIVEBOT, 'ci'), /homeFiles=\.npmrc:/);
});

test('a pm2 tenant whose .npmrc is missing or changed is not guaranteed; the one the fleet wrote is', () => {
	const declared = { tenant: 'archivebot', memoryMb: 1024, cores: 1, port: ARCHIVEBOT.port };
	const files = (homeFiles) =>
		judgeHosting(
			declared,
			parseObserved(answer({ homeStat: 'archivebot-svc:archivebot-svc:700', homeFiles })),
			'shared',
			REACH,
			ARCHIVEBOT
		).findings.filter((f) => f.category === 'hosting-files' && /\.npmrc/.test(f.why));
	assert.match(
		files('.npmrc:')
			.map((f) => f.why)
			.join(),
		/\.npmrc is missing/
	);
	assert.match(
		files('.npmrc:0000')
			.map((f) => f.why)
			.join(),
		/not what the fleet wrote/
	);
	assert.deepEqual(files(`.npmrc:${NPMRC_SHA}`), []);
});

const LOGROTATE = '/etc/logrotate.d/hosting-archivebot';
const logrotateText = (t) => runtimeFor(t).systemFiles(t)[LOGROTATE.replace('archivebot', t.app)];

test("a pm2 tenant's logrotate entry is written root-owned, read back, and removed with the tenant", () => {
	const ctl = { lan: '192.0.2.10', tailnet4: '198.51.100.1', tailnet6: null };
	const sha = createHash('sha256').update(logrotateText(ARCHIVEBOT)).digest('hex');
	const s = deployScript(ARCHIVEBOT, { memoryMb: 1024, cores: 1 }, ctl, { shared: true });
	assert.match(s, new RegExp(`!= "${sha}" \\]; then`));
	assert.match(
		s,
		/install -m 0644 -o root -g root \/dev\/stdin '\/etc\/logrotate\.d\/hosting-archivebot'/
	);
	assert.doesNotMatch(deployScript(CARDTABLE, { memoryMb: 4096, cores: 4 }, ctl), /logrotate/);
	assert.match(
		observeScript(ARCHIVEBOT, 'ci'),
		/systemFiles=\/etc\/logrotate\.d\/hosting-archivebot:/
	);
	assert.match(
		removeScript(ARCHIVEBOT, '192.0.2.10'),
		/rm -f "\$EXEC" "\$EXEC\.new" '\/etc\/logrotate\.d\/hosting-archivebot'/
	);
	assert.match(
		leftoversScript(ARCHIVEBOT),
		/\[ -e '\/etc\/logrotate\.d\/hosting-archivebot' \] && echo 'LEFT file/
	);

	const declared = { tenant: 'archivebot', memoryMb: 1024, cores: 1, port: ARCHIVEBOT.port };
	const files = (systemFiles) =>
		judgeHosting(
			declared,
			parseObserved(
				answer({
					homeStat: 'archivebot-svc:archivebot-svc:700',
					homeFiles: `.npmrc:${NPMRC_SHA}`,
					systemFiles,
				})
			),
			'shared',
			REACH,
			ARCHIVEBOT
		).findings.filter((f) => f.category === 'hosting-files');
	assert.match(
		files(`${LOGROTATE}:`)
			.map((f) => f.why)
			.join(),
		/hosting-archivebot is missing/
	);
	assert.match(
		files(`${LOGROTATE}:0000`)
			.map((f) => f.why)
			.join(),
		/not what the fleet wrote/
	);
	assert.deepEqual(files(`${LOGROTATE}:${sha}`), []);
});

test('the logrotate entry, run by the real logrotate, rotates the pm2 logs in place', () => {
	const home = mkdtempSync(join(tmpdir(), 'tenant-home-'));
	mkdirSync(join(home, '.pm2', 'logs'), { recursive: true });
	writeFileSync(join(home, '.pm2', 'pm2.log'), 'daemon\n');
	writeFileSync(join(home, '.pm2', 'logs', 'archive-bot-out.log'), 'served\n');
	const me = userInfo().username;
	const conf = join(home, 'conf');
	writeFileSync(conf, logrotateText({ ...ARCHIVEBOT, home, user: me }));
	execFileSync('/usr/sbin/logrotate', ['-f', '-s', join(home, 'state'), conf]);
	for (const log of ['.pm2/pm2.log', '.pm2/logs/archive-bot-out.log']) {
		assert.equal(readFileSync(join(home, log), 'utf8'), '', `${log} truncated in place, not moved`);
		assert.ok(existsSync(join(home, `${log}.1.gz`)), `${log} kept, compressed`);
	}
});

/** Run the CI ranking loop for real over a fixture /proc, `pgrep` answering `pids`. */
function rankOver(pids, procs) {
	const root = mkdtempSync(join(tmpdir(), 'ci-rank-'));
	const bin = join(root, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'pgrep'), `#!/bin/sh\nprintf '%s\\n' ${pids.join(' ')}\n`);
	chmodSync(join(bin, 'pgrep'), 0o755);
	for (const [pid, { cgroup, oom }] of Object.entries(procs)) {
		mkdirSync(join(root, 'proc', pid), { recursive: true });
		writeFileSync(join(root, 'proc', pid, 'cgroup'), `0::${cgroup}\n`);
		writeFileSync(join(root, 'proc', pid, 'oom_score_adj'), `${oom}\n`);
	}
	const out = execFileSync('bash', ['-c', `PROC=${join(root, 'proc')}\n${CI_RANK_SCRIPT}`], {
		env: { PATH: `${bin}:/usr/bin:/bin` },
	}).toString();
	return Object.fromEntries(
		out
			.trim()
			.split('\n')
			.map((l) => l.split('='))
	);
}

test('a CI process that exits mid-read is gone, not an unranked one at oom 0', () => {
	const ranked = {
		cgroup: '/user.slice/user-1000.slice/user@1000.service/runners.slice/r.service',
		oom: 500,
	};
	// 103 is in pgrep's answer and has no /proc entry: it exited in between
	// (claw-6, 2026-10-29: a warm listener restarting during the declare).
	assert.deepEqual(rankOver([101, 103], { 101: ranked }), {
		ciProcs: '1',
		ciOutsideRunners: '0',
		ciBelowOom: '0',
		ciMinOom: '500',
		ciGone: '1',
	});
	// A live process outside the slice at oom 0 is still found, beside a gone one.
	assert.deepEqual(
		rankOver([101, 102, 103], {
			101: ranked,
			102: { cgroup: '/user.slice/session-7.scope', oom: 0 },
		}),
		{
			ciProcs: '2',
			ciOutsideRunners: '1',
			ciBelowOom: '1',
			ciMinOom: '0',
			ciGone: '1',
		}
	);
	assert.match(observeScript(CARDTABLE, 'hadoku'), /^PROC=\/proc$/m);
});
