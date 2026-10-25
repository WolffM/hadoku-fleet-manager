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
const SLICE_CG = `/user.slice/user-1000.slice/user@1000.service/hosting.slice/${TENANTS.cardtable.slice}`;

/** What claw-8 answered on 2026-10-24 with a 2-core/2 GiB declaration, scaled to DECLARED. */
const answer = (over = {}) =>
	[
		'noise before the marker',
		'OBSERVE-BEGIN',
		...Object.entries({
			memTotalMb: 15900,
			nproc: 8,
			uptimeSec: 4000,
			ciWorkers: 0,
			ciListeners: 0,
			sliceCgroup: SLICE_CG,
			memoryMax: String(8192 * 1048576),
			swapMax: '0',
			cpuMax: '400000 100000',
			memoryCurrent: String(300 * 1048576),
			agentInstalled: 'yes',
			listenerPid: 4242,
			listenerCgroup: `${SLICE_CG}/${TENANTS.cardtable.service}`,
			ufwPort: 1,
			ufwReadable: 'yes',
			...over,
		}).map(([k, v]) => `${k}=${v}`),
		'OBSERVE-END',
	].join('\n');

const judge = (over) => judgeHosting(DECLARED, parseObserved(answer(over)));
const categories = (r) => r.findings.filter((f) => f.class === 'blocking').map((f) => f.category);

test('a node serving exactly what was declared has no findings', () => {
	const r = judge();
	assert.deepEqual(r.findings, []);
	assert.equal(r.observed.memoryMb, 8192);
	assert.equal(r.observed.cores, 4);
	assert.equal(r.observed.agent, 'listening');
});

test('the kernel disagreeing with the declaration is BLOCKING, per resource', () => {
	assert.deepEqual(categories(judge({ memoryMax: String(4096 * 1048576) })), ['hosting-memory']);
	assert.deepEqual(categories(judge({ memoryMax: 'max' })), ['hosting-memory']);
	assert.deepEqual(categories(judge({ cpuMax: 'max 100000' })), ['hosting-cores']);
	assert.deepEqual(categories(judge({ swapMax: 'max' })), ['hosting-swap']);
});

test('no slice cgroup at all means nothing is served', () => {
	assert.deepEqual(categories(judge({ sliceCgroup: '', memoryMax: '', cpuMax: '' })), [
		'hosting-slice',
	]);
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
	assert.deepEqual(categories(judge({ listenerCgroup: '/user.slice/elsewhere.service' })), [
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
