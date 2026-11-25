import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	OTHER,
	PROPOSED,
	repoOfCiUnit,
	repoOfPath,
	summarizeDevUsage,
	usageRow,
} from './dev-usage.mjs';

const ctx = {
	home: '/home/u',
	repos: ['tsunami', 'tsunami-surfer', 'hadoku_site', 'hadoku-fleet-manager'],
};

test('repoOfPath: a repo checkout, a worktree inside it, and ~/srv name the repo', () => {
	assert.equal(repoOfPath('/home/u/repos/tsunami-surfer', ctx), 'tsunami-surfer');
	assert.equal(
		repoOfPath('/home/u/repos/tsunami-surfer/.claude/worktrees/w9/e2e (deleted)', ctx),
		'tsunami-surfer'
	);
	assert.equal(repoOfPath('/home/u/srv/hadoku_site/services', ctx), 'hadoku_site');
});

test('repoOfPath: a scratchpad picks the LONGEST known repo its encoded path starts with', () => {
	const pad = '/tmp/claude-1000/-home-u-repos-tsunami-surfer--claude-worktrees-w13/abc/scratchpad';
	assert.equal(repoOfPath(pad, ctx), 'tsunami-surfer');
	assert.equal(repoOfPath('/tmp/claude-1000/-home-u-repos-tsunami/abc', ctx), 'tsunami');
	assert.equal(
		repoOfPath('/tmp/claude-1000/-home-u-repos-hadoku-site-x/abc', ctx),
		OTHER,
		'no repo is spelled hadoku-site'
	);
});

test('repoOfPath: anywhere else, or no cwd at all, is (other)', () => {
	assert.equal(repoOfPath('/home/u', ctx), OTHER);
	assert.equal(repoOfPath(null, ctx), OTHER);
	assert.equal(repoOfPath('/home/u/repos/', ctx), OTHER);
});

test('repoOfCiUnit: a JIT mint and a standing runner name their repo; anything else is null', () => {
	assert.equal(
		repoOfCiUnit('jit-claw-fixture-hadoku-cardtable-j13882264-1.service', 'claw-fixture'),
		'hadoku-cardtable'
	);
	assert.equal(repoOfCiUnit('jit-claw-10-hadoku_site-j99.scope', 'claw-10'), 'hadoku_site');
	assert.equal(repoOfCiUnit('actions-runner-hadoku-site.service', 'claw-fixture'), 'hadoku-site');
	assert.equal(
		repoOfCiUnit('jit-claw-9-x-j1.service', 'claw-fixture'),
		null,
		"another node's mint is not ours"
	);
	assert.equal(repoOfCiUnit('cgroup.procs', 'claw-fixture'), null);
});

const g = (id, repo, usageUsec, extra = {}) => ({
	id,
	kind: 'dev',
	repo,
	usageUsec,
	ioBytes: 0,
	memBytes: 1024 * 1024 * 100,
	swapBytes: 0,
	...extra,
});

test('usageRow: CPU is the counter delta over the interval, summed per repo', () => {
	const prev = { t: 0, groups: [g('a', 'r1', 0), g('b', 'r1', 0), g('c', 'r2', 0)] };
	const cur = {
		t: 60_000,
		groups: [g('a', 'r1', 60e6, { claude: true }), g('b', 'r1', 120e6), g('c', 'r2', 30e6)],
	};
	const row = usageRow(prev, cur);
	assert.equal(row.intervalS, 60);
	assert.equal(row.dev.r1.cores, 3);
	assert.equal(row.dev.r1.groups, 2);
	assert.equal(row.dev.r1.claudes, 1);
	assert.equal(row.dev.r1.memMb, 200);
	assert.equal(row.dev.r2.cores, 0.5);
});

test('usageRow: a cgroup born in the interval, or whose counter went back, bills no CPU', () => {
	const prev = { t: 0, groups: [g('old', 'r', 500e6)] };
	const cur = { t: 60_000, groups: [g('new', 'r', 9_000e6), g('old', 'r', 100e6)] };
	const row = usageRow(prev, cur);
	assert.equal(row.dev.r.cores, 0, 'a lifetime counter is not one minute of work');
	assert.equal(row.dev.r.groups, 2, 'both still count as present, and their memory counts');
	assert.equal(row.dev.r.memMb, 200);
});

test('usageRow: dev and CI with the same id and repo stay apart', () => {
	const prev = { t: 0, groups: [g('x', 'r', 0), { ...g('x', 'r', 0), kind: 'ci' }] };
	const cur = { t: 10_000, groups: [g('x', 'r', 10e6), { ...g('x', 'r', 20e6), kind: 'ci' }] };
	const row = usageRow(prev, cur);
	assert.equal(row.dev.r.cores, 1);
	assert.equal(row.ci.r.cores, 2);
});

test('usageRow: no positive interval is no row', () => {
	assert.equal(usageRow({ t: 5, groups: [] }, { t: 5, groups: [] }), null);
	assert.equal(usageRow({ t: 9, groups: [] }, { t: 5, groups: [] }), null);
});

const row = (t, dev, ci = {}) => ({
	t: new Date(t * 60_000).toISOString(),
	intervalS: 60,
	dev: Object.fromEntries(
		Object.entries(dev).map(([r, [cores, memMb = 0]]) => [
			r,
			{ cores, memMb, swapMb: 0, ioMBps: 0, groups: 1, claudes: 1 },
		])
	),
	ci: Object.fromEntries(
		Object.entries(ci).map(([r, cores]) => [
			r,
			{ cores, memMb: 0, swapMb: 0, ioMBps: 0, groups: 1, claudes: 0 },
		])
	),
});

test('summarizeDevUsage: minutes over the CPU ceiling, and the excess split by who was running', () => {
	const s = summarizeDevUsage([
		row(0, { big: [2], small: [1] }),
		row(1, { big: [9], small: [3] }), // 12 cores: 4 over for a minute, 3/4 of it big's
		row(2, { big: [4] }, { site: 2 }),
	]);
	assert.equal(s.samples, 3);
	assert.equal(s.dev.cpuOverMinutes, 1);
	assert.equal(s.dev.clippedCoreHours, Math.round(((4 * 60) / 3600) * 100) / 100);
	assert.deepEqual(
		s.dev.clippedBy.map((c) => c.repo),
		['big', 'small']
	);
	assert.ok(s.dev.clippedBy[0].coreHours > s.dev.clippedBy[1].coreHours);
	assert.equal(s.dev.coresMax, 12);
	assert.equal(s.dev.repos[0].repo, 'big');
	assert.equal(s.dev.repos[0].coresMax, 9);
	assert.equal(s.ci.repos[0].repo, 'site');
	assert.equal(s.ci.repos[0].share, 1);
});

test('summarizeDevUsage: memory above MemoryHigh is counted in minutes; at the ceiling is not over', () => {
	const at = PROPOSED.devMemoryHighMb;
	const s = summarizeDevUsage([
		row(0, { r: [0, at] }),
		row(1, { r: [0, at + 1] }),
		row(2, { r: [0, 10] }),
	]);
	assert.equal(s.dev.memOverMinutes, 1);
	assert.equal(s.dev.cpuOverMinutes, 0);
	assert.deepEqual(s.dev.clippedBy, []);
});

test('summarizeDevUsage: no rows is zero samples, never a clean bill', () => {
	const s = summarizeDevUsage([]);
	assert.equal(s.samples, 0);
	assert.equal(s.from, null);
	assert.deepEqual(s.dev.repos, []);
});
