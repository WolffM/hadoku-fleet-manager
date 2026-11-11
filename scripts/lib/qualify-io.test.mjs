import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	FREE_SPACE_FACTOR,
	RAND_SYNC_P99_MS,
	SEQ_HOLD_RATIO,
	ioCleanupScript,
	ioPrepScript,
	ioRunScript,
	judgeDisk,
	makeIoTest,
	parsePrep,
	parseRun,
	test as diskTest,
} from './qualify-io.mjs';
import { validateTest } from './qualify-registry.mjs';

/**
 * A scratch HOME-ish cache root on a real disk. Never the system tmpdir when it
 * is tmpfs: the module refuses a RAM-backed cache, and the test should exercise
 * the path production takes.
 */
function cacheRoot() {
	const base = process.env.HOME ? join(process.env.HOME, '.cache') : tmpdir();
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, 'q2-io-test.'));
}

/** Run a node-side script here, for real, as `bash -s`, with XDG_CACHE_HOME pointed at `cache`. */
function localExec(cache, calls = []) {
	return async (script, o = {}) => {
		calls.push({ script, o });
		const r = spawnSync('bash', ['-s'], {
			input: script,
			encoding: 'utf8',
			env: { ...process.env, XDG_CACHE_HOME: cache },
			timeout: o.timeoutMs ?? 120_000,
		});
		return {
			ok: r.status === 0,
			stdout: r.stdout ?? '',
			stderr: r.stderr ?? '',
			error: r.status === 0 ? null : `exit ${r.status}`,
		};
	};
}

const TINY = { segments: 3, segmentMb: 4, randSec: 1, randFileMb: 2 };

const ctxFor = (exec, machine = { maxConcurrent: 2 }) => ({
	node: 'claw-fixture',
	machine,
	exec,
	log: () => {},
	nowMs: 0,
});

// ── contract ───────────────────────────────────────────────────────────────

void test('disk-sync-writes meets the test contract and runs as ci', () => {
	assert.deepEqual(validateTest(diskTest), []);
	assert.equal(diskTest.id, 'disk-sync-writes');
	assert.equal(diskTest.runsAs, 'ci');
	assert.equal(diskTest.needsDrain, true);
});

// ── the node-side scripts, run for real here at a tiny size ────────────────

void test('the prep script makes its own directory under the disk cache and reports space, fs and fio', () => {
	const cache = cacheRoot();
	try {
		const r = spawnSync('bash', ['-s'], {
			input: ioPrepScript(),
			encoding: 'utf8',
			env: { ...process.env, XDG_CACHE_HOME: cache },
		});
		const p = parsePrep(r.stdout);
		assert.ok(p.dir?.startsWith(join(cache, 'qualify-io.')), r.stdout);
		assert.ok(existsSync(p.dir));
		assert.ok(p.availMb > 0, r.stdout);
		assert.ok(p.fstype && p.fstype !== 'tmpfs', r.stdout);
		assert.match(p.fio ?? '', /\/fio$/, r.stdout);
	} finally {
		rmSync(cache, { recursive: true, force: true });
	}
});

void test('the run script writes every segment and the random phase, then leaves its directory empty', () => {
	const cache = cacheRoot();
	try {
		const dir = mkdtempSync(join(cache, 'qualify-io.'));
		const r = spawnSync('bash', ['-s'], {
			input: ioRunScript({ dir, k: 2, ...TINY, segmentDeadlineSec: 60 }),
			encoding: 'utf8',
		});
		const run = parseRun(r.stdout);
		assert.equal(run.complete, true, r.stdout + r.stderr);
		assert.equal(run.segments.length, 3);
		assert.ok(
			run.segments.every((s) => s.rc === 0 && s.ms > 0),
			JSON.stringify(run.segments)
		);
		assert.equal(run.rand.rc, 0);
		assert.ok(run.rand.p99Ms > 0, JSON.stringify(run.rand));
		assert.ok(run.rand.p50Ms > 0);
		assert.deepEqual(readdirSync(dir), [], 'the run left files behind');
		const c = spawnSync('bash', ['-s'], { input: ioCleanupScript(dir), encoding: 'utf8' });
		assert.match(c.stdout, /^CLEAN$/m);
		assert.equal(existsSync(dir), false);
	} finally {
		rmSync(cache, { recursive: true, force: true });
	}
});

void test('the cleanup script refuses a path that is not one of its own directories', () => {
	assert.throws(() => ioCleanupScript('/home/someone'), /not a qualify-io directory/);
	assert.throws(() => ioCleanupScript('/x/qualify-io.ab/../..'), /not a qualify-io directory/);
});

void test('the whole test, run end to end against this box at a tiny size, measures and cleans up', async () => {
	const cache = cacheRoot();
	try {
		const calls = [];
		const r = await makeIoTest(TINY).run(ctxFor(localExec(cache, calls)));
		assert.ok(['pass', 'fail'].includes(r.status), JSON.stringify(r));
		assert.ok(r.reason.trim());
		assert.equal(r.metrics.k, 2);
		assert.equal(r.metrics.segments.length, 3);
		assert.ok(r.metrics.rand.p99Ms > 0);
		assert.deepEqual(readdirSync(cache), [], 'a qualify-io directory was left behind');
		// Every exec is bounded, and above the script's own internal bound, so the
		// node always ends the run itself and its trap gets to clean up.
		assert.ok(calls.every((c) => c.o.timeoutMs > 0));
	} finally {
		rmSync(cache, { recursive: true, force: true });
	}
});

// ── refusals: could-not-look, never pass ───────────────────────────────────

/** A scripted exec: prep answers with `prep`, run with `run`, cleanup CLEAN. */
function fakeExec({ prep, run = { ok: true, stdout: '' } }) {
	const calls = [];
	const exec = async (script, o) => {
		calls.push({ script, o });
		if (script.includes('QUALIFY_IO_PREP')) return prep;
		if (script.includes('QUALIFY_IO_CLEANUP')) return { ok: true, stdout: 'CLEAN\n', stderr: '' };
		return run;
	};
	return { exec, calls };
}
const prepOut = ({ avail = 500_000, fstype = 'ext2/ext3', fio = '/usr/bin/fio' } = {}) => ({
	ok: true,
	stdout: `DIR /home/ci/.cache/qualify-io.Ab12Cd\nAVAIL_MB ${avail}\nFSTYPE ${fstype}\nFIO ${fio}\n`,
	stderr: '',
});

void test('free space under twice the test size is could-not-look, nothing is written, and the directory is removed', async () => {
	const { exec, calls } = fakeExec({ prep: prepOut({ avail: 1000 }) });
	const r = await makeIoTest().run(ctxFor(exec, { maxConcurrent: 3 }));
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /1000 MiB free/);
	assert.match(r.reason, new RegExp(`${FREE_SPACE_FACTOR}x`));
	assert.equal(calls.filter((c) => c.script.includes('QUALIFY_IO_RUN')).length, 0);
	assert.equal(calls.filter((c) => c.script.includes('QUALIFY_IO_CLEANUP')).length, 1);
});

void test('a node with no maxConcurrent is could-not-look before anything runs on it', async () => {
	const { exec, calls } = fakeExec({ prep: prepOut() });
	const r = await makeIoTest().run(ctxFor(exec, {}));
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /maxConcurrent/);
	assert.equal(calls.length, 0);
});

void test('no fio, or a cache that is RAM, is could-not-look', async () => {
	for (const [prep, re] of [
		[prepOut({ fio: 'none' }), /fio is not installed/],
		[prepOut({ fstype: 'tmpfs' }), /tmpfs/],
	]) {
		const { exec, calls } = fakeExec({ prep });
		const r = await makeIoTest().run(ctxFor(exec));
		assert.equal(r.status, 'could-not-look', r.reason);
		assert.match(r.reason, re);
		assert.equal(calls.filter((c) => c.script.includes('QUALIFY_IO_RUN')).length, 0);
		assert.equal(calls.filter((c) => c.script.includes('QUALIFY_IO_CLEANUP')).length, 1);
	}
});

void test('a prep that does not answer is could-not-look and says why', async () => {
	const { exec } = fakeExec({
		prep: { ok: false, stdout: '', stderr: 'ssh: connect to host claw-fixture port 22: timed out' },
	});
	const r = await makeIoTest().run(ctxFor(exec));
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /timed out/);
});

void test('a run the transport killed at its deadline still gets its directory removed', async () => {
	const { exec, calls } = fakeExec({
		prep: prepOut(),
		run: {
			ok: false,
			stdout: 'RAND_RC 0\n',
			stderr: '',
			error: 'no answer within 900s (killed by SIGTERM)',
		},
	});
	const r = await makeIoTest().run(ctxFor(exec));
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /killed by SIGTERM/);
	const cleanup = calls.filter((c) => c.script.includes('QUALIFY_IO_CLEANUP'));
	assert.equal(cleanup.length, 1);
	assert.match(cleanup[0].script, /qualify-io\.Ab12Cd/);
});

void test('a cleanup that fails is said in the reason, whatever the verdict', async () => {
	const calls = [];
	const exec = async (script) => {
		calls.push(script);
		if (script.includes('QUALIFY_IO_PREP')) return prepOut({ avail: 10 });
		return { ok: false, stdout: 'LEFT /home/ci/.cache/qualify-io.Ab12Cd\n', stderr: 'rm: busy' };
	};
	const r = await makeIoTest().run(ctxFor(exec));
	assert.match(r.reason, /left .*qualify-io\.Ab12Cd behind/);
});

// ── judging ────────────────────────────────────────────────────────────────

const seg = (ms, rc = 0) => ({ rc, ms });
const healthy = () => ({
	k: 3,
	segmentMb: 1024,
	segmentDeadlineSec: 120,
	rand: { rc: 0, p50Ms: 1.2, p99Ms: 6, iops: 900 },
	segments: [seg(2500), seg(2500), seg(2600), seg(2600), seg(2700), seg(2700)],
	complete: true,
});

void test('a disk that holds its write rate and keeps p99 under the bar passes, with the numbers', () => {
	const v = judgeDisk(healthy());
	assert.equal(v.status, 'pass', v.reason);
	assert.match(v.reason, /p99 6 ms/);
	assert.equal(v.metrics.firstMbps, 410);
	assert.equal(v.metrics.lastMbps, 379);
});

void test('a p99 over the bar fails, naming the bar and the number (the claw-1 shape)', () => {
	const v = judgeDisk({ ...healthy(), rand: { rc: 0, p50Ms: 33, p99Ms: 112, iops: 40 } });
	assert.equal(v.status, 'fail');
	assert.match(v.reason, new RegExp(`p99 112 ms > ${RAND_SYNC_P99_MS} ms`));
	assert.match(v.reason, /k=3/);
});

void test('a write rate that collapses across the run fails, naming first and last GB (the claw-6 shape)', () => {
	const run = healthy();
	run.segments = [seg(2560), seg(2560), seg(3000), seg(7000), seg(8000), seg(9300)];
	const v = judgeDisk(run);
	assert.equal(v.status, 'fail');
	assert.match(v.reason, /last GB 110 MB\/s/);
	assert.match(v.reason, /first GB 400 MB\/s/);
	assert.match(v.reason, new RegExp(`< ${SEQ_HOLD_RATIO}`));
});

void test('a segment that missed its deadline is a fail, not a missing reading', () => {
	const run = healthy();
	run.segments = [seg(2500), seg(2500), seg(120_010, 124)];
	run.complete = true;
	const v = judgeDisk(run);
	assert.equal(v.status, 'fail');
	assert.match(v.reason, /segment 3 .*120 s/);
});

void test('fio failing, or output cut short, is could-not-look', () => {
	const noRand = { ...healthy(), rand: { rc: 1, p50Ms: null, p99Ms: null, iops: null } };
	assert.equal(judgeDisk(noRand).status, 'could-not-look');
	assert.match(judgeDisk(noRand).reason, /random-write phase/);
	const short = { ...healthy(), segments: healthy().segments.slice(0, 2), complete: false };
	assert.equal(judgeDisk(short).status, 'could-not-look');
	assert.match(judgeDisk(short).reason, /2\/6 segments/);
	const failedSeg = { ...healthy(), segments: [seg(2500), seg(40, 1)] };
	assert.equal(judgeDisk(failedSeg).status, 'could-not-look');
	assert.match(judgeDisk(failedSeg).reason, /exited 1/);
});

void test('a crossed bar is a fail even when another reading was lost', () => {
	const run = { ...healthy(), rand: { rc: 0, p50Ms: 30, p99Ms: 90, iops: 50 }, complete: false };
	run.segments = run.segments.slice(0, 2);
	const v = judgeDisk(run);
	assert.equal(v.status, 'fail');
	assert.match(v.reason, /p99 90 ms/);
	assert.match(v.reason, /2\/6 segments/);
});

void test('parseRun reads the fio JSON even with a warning line before it', () => {
	const fio = JSON.stringify({
		jobs: [
			{
				error: 0,
				write: {
					iops: 512.4,
					clat_ns: { percentile: { '50.000000': 1_500_000, '99.000000': 7_372_800 } },
				},
			},
		],
	});
	const out = [
		'RAND_RC 0',
		'RAND_JSON_BEGIN',
		'fio: note: both iodepth >= 1 and synchronous I/O engine are selected',
		fio,
		'RAND_JSON_END',
		'SEG 1 0 2500',
		'RUN_END',
	].join('\n');
	const r = parseRun(out);
	assert.deepEqual(r.rand, { rc: 0, p50Ms: 1.5, p99Ms: 7.37, iops: 512 });
	assert.deepEqual(r.segments, [{ rc: 0, ms: 2500 }]);
	assert.equal(r.complete, true);
});
