import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeOffer, registrationLabels, type ManifestNode } from '../capabilities.js';
import {
	REVOCATIONS_FILE,
	applyVerdicts,
	parseRevocations,
	readRevocations,
	revokedSets,
	writeRevocations,
} from '../capability-revocations.js';
import { __setHostForTesting } from '../host.js';
import { loadWorkloadGateContext } from '../runners/ephemeral-shared.js';

const PREREQS = [
	{ id: 'ffmpeg', detail: '7.1' },
	{ id: 'python-venv', detail: 'ok' },
	{ id: 'python-toolcache', detail: '3.11, 3.12' },
	{ id: 'playwright', detail: 'chromium' },
	{ id: 'gh', detail: '2.103.2' },
];

/** claw-1 as the manifest had it on 2026-10-25: nvenc-h264 earned on 10-24. */
const claw1 = (): ManifestNode =>
	({
		labels: [],
		ephemeral: true,
		maxConcurrent: 3,
		minFreeMb: 2048,
		$capabilities: {
			at: '2026-10-24T12:09:10Z',
			earned: [
				'ffmpeg',
				'gh',
				'jitconfig',
				'nvenc-h264',
				'playwright',
				'python-toolcache',
				'python-venv',
			],
			prereqs: PREREQS,
		},
	}) as ManifestNode;

test('the 2026-10-25 shape: a revoked nvenc-h264 is not offered, and nothing else moves', () => {
	const before = nodeOffer(claw1(), { eligible: true });
	assert.ok(before.includes('nvenc-h264'));
	const after = nodeOffer(claw1(), { eligible: true, revoked: new Set(['nvenc-h264']) });
	assert.deepEqual(
		after,
		before.filter((l) => l !== 'nvenc-h264')
	);
	assert.ok(after.includes('hadoku-builder'), 'general CI keeps flowing');
});

test('an unreadable record withholds every probe-verified label — but never eligibility or a mint label', () => {
	const offered = nodeOffer(claw1(), { eligible: true, revoked: 'all' });
	assert.ok(!offered.includes('nvenc-h264'));
	assert.ok(offered.includes('hadoku-builder'), 'eligibility is never a probe’s to revoke');
	assert.ok(offered.includes('jit-canary'), 'a mint-verified label has no probe to fail');
});

test('a standing registration loses the revoked label too', () => {
	const standing = { ...claw1(), ephemeral: false } as ManifestNode;
	assert.ok(registrationLabels(standing).includes('nvenc-h264'));
	assert.ok(
		!registrationLabels(standing, { revoked: new Set(['nvenc-h264']) }).includes('nvenc-h264')
	);
});

test('a failed execution revokes; a pass clears; a second failure keeps the FIRST time', () => {
	const fail = { node: 'claw-1', capability: 'nvenc-h264', passed: false, reason: 'encode failed' };
	const first = applyVerdicts({}, [fail], 'capabilities', '2026-10-25T15:00:00Z');
	assert.deepEqual(first.revoked, [fail]);
	assert.equal(first.nodes['claw-1']['nvenc-h264'].at, '2026-10-25T15:00:00Z');

	const again = applyVerdicts(first.nodes, [fail], 'capabilities', '2026-10-26T15:00:00Z');
	assert.deepEqual(again.revoked, []);
	assert.equal(again.nodes['claw-1']['nvenc-h264'].at, '2026-10-25T15:00:00Z');

	const pass = { ...fail, passed: true, reason: 'ok' };
	const cleared = applyVerdicts(again.nodes, [pass], 'bootcamp');
	assert.deepEqual(cleared.cleared, [pass]);
	assert.deepEqual(cleared.nodes['claw-1'], {});
	// A pass on something never revoked changes nothing and reports nothing.
	assert.deepEqual(applyVerdicts({}, [pass], 'bootcamp').cleared, []);
});

test('applyVerdicts never mutates the record it was handed', () => {
	const current = { 'claw-1': { 'nvenc-h264': { at: 'a', reason: 'r', by: 'capabilities' } } };
	const snapshot = JSON.stringify(current);
	applyVerdicts(
		current,
		[{ node: 'claw-1', capability: 'nvenc-h264', passed: true, reason: 'ok' }],
		'x'
	);
	assert.equal(JSON.stringify(current), snapshot);
});

test('parsing: empty is none, malformed is corrupt — never an empty record', () => {
	assert.deepEqual(parseRevocations(''), { corrupt: false, nodes: {} });
	assert.deepEqual(parseRevocations('{}'), { corrupt: false, nodes: {} });
	assert.equal(parseRevocations('{nope').corrupt, true);
	assert.equal(parseRevocations('{"nodes":[]}').corrupt, true);
	assert.equal(revokedSets({ corrupt: true, why: 'x' }), 'all');
});

function withStateDir(fn: (dir: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), 'revocations-'));
	const manifestDir = join(root, 'manifest');
	const stateDir = join(root, 'state');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	__setHostForTesting({
		logger: { info() {}, warn() {}, error() {} },
		alerts: { post: async () => ({ posted: false, sinkRecorded: false }), recordQuietly() {} },
		jobs: { recordJobResult: async () => {} },
		githubToken: () => 'tok',
		manifestDir,
		stateDir,
		storeDoctorPath: '/tmp',
		cronProfilesPath: '/tmp',
	} as never);
	try {
		fn(stateDir);
	} finally {
		__setHostForTesting(null as never);
		rmSync(root, { recursive: true, force: true });
	}
}

test('a written record round-trips, and empty nodes are pruned', () => {
	withStateDir((dir) => {
		writeRevocations(dir, {
			'claw-1': { 'nvenc-h264': { at: 'a', reason: 'r', by: 'capabilities' } },
			'claw-2': {},
		});
		const read = readRevocations(dir);
		assert.equal(read.corrupt, false);
		assert.deepEqual(Object.keys(read.corrupt ? {} : read.nodes), ['claw-1']);
		assert.match(readFileSync(join(dir, REVOCATIONS_FILE), 'utf8'), /\$comment/);
	});
});

test('THE TICK reads it: the dispatcher’s gate context carries the revocation', () => {
	withStateDir((dir) => {
		writeRevocations(dir, {
			'claw-1': { 'nvenc-h264': { at: 'a', reason: 'r', by: 'capabilities' } },
		});
		const gate = loadWorkloadGateContext(['claw-1', 'claw-2']);
		assert.notEqual(gate.revoked, 'all');
		assert.ok(gate.revoked !== 'all' && gate.revoked?.['claw-1']?.has('nvenc-h264'));
	});
});

test('THE TICK fails closed on a corrupt record', () => {
	withStateDir((dir) => {
		writeFileSync(join(dir, REVOCATIONS_FILE), '{ not json');
		assert.equal(loadWorkloadGateContext(['claw-1']).revoked, 'all');
	});
});
