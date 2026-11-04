/**
 * effmax against fixture cgroup trees shaped like a real node's. claw-8,
 * 2026-11-04: `hosting.slice/hosting-watchparty.slice` at 1610612736 with
 * `pm2-watchparty-svc.service` under it at `max`. Read alone, the unit made
 * claw-8 refuse cardtable as "not-beside-unbounded".
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EFFECTIVE_MEMORY_MAX_SH } from './cgroup-ceiling.mjs';

const roots = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** A cgroup tree from { '/a/b': 'max', ... }, and `effmax <path> U` run against it. */
function tree(levels) {
	const root = mkdtempSync(join(tmpdir(), 'cgroup-ceiling-'));
	roots.push(root);
	for (const [p, max] of Object.entries(levels)) {
		mkdirSync(join(root, p), { recursive: true });
		if (max !== null) writeFileSync(join(root, p, 'memory.max'), `${max}\n`);
	}
	return (path) => {
		const r = spawnSync('sh', ['-c', `${EFFECTIVE_MEMORY_MAX_SH}\neffmax "$1" U`, 'sh', path], {
			env: { ...process.env, CGROUP_ROOT: root },
			encoding: 'utf8',
		});
		assert.equal(r.status, 0, r.stderr);
		return r.stdout.trim();
	};
}

const UNIT = '/hosting.slice/hosting-watchparty.slice/pm2-watchparty-svc.service';

test('a unit at max inside a bounded slice is bounded by the slice', () => {
	const effmax = tree({
		'/hosting.slice': 'max',
		'/hosting.slice/hosting-watchparty.slice': '1610612736',
		[UNIT]: 'max',
	});
	assert.equal(effmax(UNIT), '1610612736');
});

test('the tightest level wins, wherever it sits', () => {
	const effmax = tree({
		'/hosting.slice': '1073741824',
		'/hosting.slice/hosting-watchparty.slice': '1610612736',
		[UNIT]: '2147483648',
	});
	assert.equal(effmax(UNIT), '1073741824');
});

test('no finite level anywhere is max: genuinely unbounded', () => {
	const effmax = tree({
		'/system.slice': 'max',
		'/system.slice/pm2-hadoku.service': 'max',
	});
	assert.equal(effmax('/system.slice/pm2-hadoku.service'), 'max');
});

test('an unreadable level, an empty path or junk is the unreadable token, never a number', () => {
	const effmax = tree({
		'/hosting.slice': null,
		'/hosting.slice/hosting-x.slice': '1610612736',
		'/hosting.slice/hosting-x.slice/pm2-x.service': 'max',
		'/junk.slice': 'banana',
	});
	assert.equal(effmax('/hosting.slice/hosting-x.slice/pm2-x.service'), 'U');
	assert.equal(effmax(''), 'U');
	assert.equal(effmax('/junk.slice'), 'U');
});

test('both probes that judge a pm2 manager use the effective ceiling, not the unit file alone', async () => {
	const { offerProbe } = await import('./hosting-offers.mjs');
	const { readFileSync } = await import('node:fs');
	assert.match(offerProbe(), /effmax "\$cg" \?/);
	const doctor = readFileSync(new URL('./doctor-probe.mjs', import.meta.url), 'utf8');
	assert.match(doctor, /effmax "\$cg" U/);
	assert.doesNotMatch(doctor, /pm2Unit\.\$u" "\$\(cat "\/sys\/fs\/cgroup\$cg\/memory\.max"/);
});
