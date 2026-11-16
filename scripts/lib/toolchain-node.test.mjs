/**
 * The system-Node entries (toolchain-node.mjs), tested apart from
 * toolchain-floor.test.mjs, which is at its size ceiling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPAIRS, applicableRepairs, isAdvisory, parseObservation } from './toolchain-floor.mjs';
import { NODE_APT_BINS, NODE_MAJOR } from './toolchain-node.mjs';
import { judgeTool, quietAdvisory } from './toolchain-doctor.mjs';
import { planNode } from './refresh-cycle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('every profile declares the one Node major', () => {
	const { profiles } = JSON.parse(
		readFileSync(join(ROOT, 'manifests', 'node-profiles.json'), 'utf8')
	);
	const declared = Object.entries(profiles)
		.filter(([id]) => !id.startsWith('$'))
		.map(([id, p]) => [id, p.toolchain?.node]);
	assert.ok(declared.length > 0, 'no profile was read');
	for (const [id, major] of declared) assert.equal(major, String(NODE_MAJOR), id);
});

test('node24 and node-apt-path apply to every node, the backstop included', () => {
	for (const node of [{ role: 'claw' }, { role: 'claw', services: 'pm2' }, { role: 'backstop' }]) {
		const ids = applicableRepairs(node).map(([id]) => id);
		assert.ok(ids.includes('node24'), `node24 on ${JSON.stringify(node)}`);
		assert.ok(ids.includes('node-apt-path'), `node-apt-path on ${JSON.stringify(node)}`);
	}
});

test('the node24 repair adds the nodesource source when a node has none', () => {
	const { repair } = REPAIRS.node24;
	assert.match(repair, new RegExp(`setup_${NODE_MAJOR}\\.x \\| sudo -n bash -`));
	assert.ok(
		repair.indexOf('setup_') < repair.indexOf('apt-get install -y nodejs'),
		'the source is added before the install'
	);
});

/** Run the node-apt-path detect under a PATH of `<dir>/first:<dir>/usr/bin`. */
function detectWith(layout) {
	const dir = mkdtempSync(join(tmpdir(), 'node-apt-path-'));
	try {
		for (const [rel, names] of Object.entries(layout)) {
			mkdirSync(join(dir, rel), { recursive: true });
			for (const n of names) {
				writeFileSync(join(dir, rel, n), '#!/bin/sh\n');
				chmodSync(join(dir, rel, n), 0o755);
			}
		}
		// The detect names /usr/bin; the fixture's stand-in is <dir>/usr/bin.
		const detect = REPAIRS['node-apt-path'].detect.replaceAll('/usr/bin/', `${dir}/usr/bin/`);
		const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', detect], {
			env: { PATH: `${dir}/first:${dir}/usr/bin` },
			encoding: 'utf8',
		});
		return r.stdout.trim().replace(dir, '');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('node-apt-path: OK when every name resolves in /usr/bin', () => {
	assert.equal(detectWith({ 'usr/bin': NODE_APT_BINS, first: ['pm2'] }), 'OK');
});

test('node-apt-path: names the copy that comes first, for each of the four', () => {
	for (const bin of NODE_APT_BINS) {
		assert.equal(detectWith({ 'usr/bin': NODE_APT_BINS, first: [bin] }), `SHADOWED /first/${bin}`);
	}
});

test('node-apt-path: a name not installed at all is not its finding', () => {
	assert.equal(detectWith({ 'usr/bin': ['node'], first: [] }), 'OK');
});

test('a shadow on a quiet check is an advisory: no finding, no work, and it names the file', () => {
	const tool = REPAIRS['node-apt-path'];
	assert.ok(isAdvisory(tool));
	const seen = { detect: 'SHADOWED /usr/local/bin/npm', login: '', runner: '' };
	const j = judgeTool('node-apt-path', tool, seen, undefined);
	assert.equal(j.finding, false);
	assert.equal(j.advisory, true);
	assert.match(j.reason, /^\/usr\/local\/bin\/npm comes before \/usr\/bin\/npm /);

	const plan = planNode([['node-apt-path', tool]], { 'node-apt-path': seen }, {});
	assert.deepEqual(plan, { work: [], findings: [] });

	const a = quietAdvisory('hokon', j);
	assert.equal(a.blocking, false);
	assert.equal(a.fix, 'on hokon: sudo rm /usr/local/bin/npm');
	// A version manager's shim is not the fleet's to delete: the fix is the PATH.
	const shim = quietAdvisory('hokon', {
		id: 'node-apt-path',
		shadowed: '/run/user/1000/fnm/bin/node',
	});
	assert.match(shim.fix, /without \/run\/user\/1000\/fnm\/bin ahead of \/usr\/bin/);
});

test('a quiet check that passes says nothing', () => {
	const seen = { detect: 'OK', login: 'OK', runner: '' };
	const j = judgeTool('node-apt-path', REPAIRS['node-apt-path'], seen, undefined);
	assert.deepEqual(j, { id: 'node-apt-path', status: 'ok', finding: false });
});

test('the wrong major is LOUD: node24 is absent and a finding, not an advisory', () => {
	const seen = { detect: '', login: '', runner: '', apt: '22.22.1|22.23.5|behind' };
	const j = judgeTool('node24', REPAIRS.node24, seen, undefined);
	assert.equal(j.status, 'absent');
	assert.equal(j.finding, true);
	assert.equal(j.advisory, undefined);
});

test('converge reads a quiet shadow out of the observation with its path', () => {
	const { brokenCapabilities, shadowed } = parseObservation(
		'REPAIR node24 OK\nREPAIR node-apt-path SHADOWED /usr/local/bin/corepack\n'
	);
	assert.deepEqual(brokenCapabilities, ['node-apt-path']);
	assert.deepEqual(shadowed, { 'node-apt-path': '/usr/local/bin/corepack' });
});
