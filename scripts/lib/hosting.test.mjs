import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	coresFromCpuMax,
	fitProblems,
	judgeHosting,
	mibFromMemoryMax,
	parseCores,
	parseMemoryMb,
	parseObserved,
	TENANTS,
} from './hosting.mjs';

const DECLARED = { tenant: 'cardtable', memoryMb: 8192, cores: 4, port: 7621 };
const SLICE_CG = `/hosting.slice/${TENANTS.cardtable.slice}`;
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
			listenerCgroup: `${SLICE_CG}/${TENANTS.cardtable.service}`,
			listenerUid: 996,
			listenerOom: -500,
			ciProcs: 0,
			ciOutsideRunners: 0,
			ciBelowOom: 0,
			ciMinOom: '',
			ufwPort: 1,
			ufwReadable: 'yes',
			...over,
		}).map(([k, v]) => `${k}=${v}`),
		'OBSERVE-END',
	].join('\n');

const judge = (over, mode = 'whole') => judgeHosting(DECLARED, parseObserved(answer(over)), mode);
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

test('an unreadable firewall is not an open port', () => {
	assert.deepEqual(categories(judge({ ufwReadable: 'no', ufwPort: 0 })), ['hosting-port']);
	assert.deepEqual(categories(judge({ ufwPort: 0 })), ['hosting-port']);
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
	assert.deepEqual(categories(judgeHosting(DECLARED, null)), ['hosting-unobserved']);
});

test('an unknown tenant is refused rather than judged against nothing', () => {
	assert.deepEqual(
		categories(judgeHosting({ ...DECLARED, tenant: 'nobody' }, parseObserved(answer()))),
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
