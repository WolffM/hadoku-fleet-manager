/**
 * Every in-process loop that registers with liveness must NOTE a tick when a
 * pass completes. `scheduleRepeating(…, loopName)` registers the loop before
 * its first pass, so a pass that never reaches `finishTick` reads `stale`
 * from ~5 minutes after every boot. fleet:ppe-sweep and
 * fleet:capacity-samples did exactly that from the day they shipped, and on
 * 2026-11-02 GET /mgmt/api/status reported both as a critical outage.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';
import { getFleetLiveness, __resetLivenessForTesting } from '../lib/liveness.js';
import { ppeSweepPass } from '../ppe-sweep.js';
import { capacitySamplePass } from '../capacity-sample.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

const jobs: { job: string; state: string }[] = [];

beforeEach(() => {
	jobs.length = 0;
	__resetLivenessForTesting();
	__setHostForTesting({
		...testHost,
		githubToken: () => undefined,
		logger: { info() {}, warn() {}, error() {} },
		jobs: {
			recordJobResult: async (job: string, state: string) => {
				jobs.push({ job, state });
			},
		},
	});
});
afterEach(() => {
	__setHostForTesting(testHost);
	__resetLivenessForTesting();
});

function tickOf(name: string) {
	return getFleetLiveness().loops.find((l) => l.name === name);
}

void test('a ppe-sweep pass that could not look still notes its tick, and records it (held, as its first in a row)', async () => {
	await ppeSweepPass();
	const loop = tickOf('fleet:ppe-sweep');
	assert.ok(loop?.lastTickAt, 'ppe-sweep noted no tick');
	assert.equal(loop.status, 'ok');
	assert.deepEqual(jobs, [{ job: 'fleet:ppe-sweep', state: 'skipped' }]);
});

void test('a capacity-samples pass notes its tick even when sampling faults', async () => {
	// No fleet state in this process: the real buildFleetReport() join is what runs.
	await capacitySamplePass();
	const loop = tickOf('fleet:capacity-samples');
	assert.ok(loop?.lastTickAt, 'capacity-samples noted no tick');
	assert.equal(loop.status, 'ok');
	assert.equal(jobs.length, 1);
	assert.equal(jobs[0].job, 'fleet:capacity-samples');
});

void test('every src file that schedules a NAMED loop finishes its passes through finishTick or noteTick', () => {
	const offenders: string[] = [];
	const walk = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name !== 'tests') walk(p);
				continue;
			}
			if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts')) continue;
			if (p.endsWith(join('lib', 'job-runner.ts'))) continue;
			const text = readFileSync(p, 'utf8');
			const named = [...text.matchAll(/scheduleRepeating\(([^;]*?)\);/gs)].some(
				(m) => m[1].split(',').length >= 4
			);
			if (named && !/\b(finishTick|noteTick)\(/.test(text)) offenders.push(p.slice(SRC.length + 1));
		}
	};
	walk(SRC);
	assert.deepEqual(offenders, [], `named loops that never note a tick: ${offenders.join(', ')}`);
});
