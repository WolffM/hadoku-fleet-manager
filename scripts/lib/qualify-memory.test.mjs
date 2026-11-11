import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
	HEAVY_JOB_MB,
	TMP_FILL_PCT,
	fillTargetMb,
	judgeHeadroom,
	makeTmpfsTest,
	parseFacts,
	parseFill,
	tmpfsCleanupScript,
	tmpfsFactsScript,
	tmpfsFillScript,
	test as tmpfsTest,
} from './qualify-memory.mjs';
import { validateTest } from './qualify-registry.mjs';

/** /dev/shm is tmpfs on every Linux box this suite runs on; a few MiB there is harmless. */
const SHM = '/dev/shm';
const bash = (script) => spawnSync('bash', ['-s'], { input: script, encoding: 'utf8' });

function localExec(calls = []) {
	return async (script, o = {}) => {
		calls.push({ script, o });
		const r = spawnSync('bash', ['-s'], {
			input: script,
			encoding: 'utf8',
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
const ctxFor = (exec, machine = { minFreeMb: 2048 }) => ({
	node: 'claw-fixture',
	machine,
	exec,
	log: () => {},
	nowMs: 0,
});
const ownDirs = () => readdirSync(SHM).filter((n) => n.startsWith('qualify-tmpfs.'));

// ── contract ───────────────────────────────────────────────────────────────

void test('tmpfs-headroom meets the test contract and runs as ci', () => {
	assert.deepEqual(validateTest(tmpfsTest), []);
	assert.equal(tmpfsTest.id, 'tmpfs-headroom');
	assert.equal(tmpfsTest.runsAs, 'ci');
	assert.equal(tmpfsTest.needsDrain, true);
});

// ── the fill target ────────────────────────────────────────────────────────

void test(`the fill brings /tmp to ${TMP_FILL_PCT}% of its size, counting what is already there`, () => {
	assert.equal(
		fillTargetMb({ sizeMb: 3937, usedMb: 1 }),
		Math.floor((3937 * TMP_FILL_PCT) / 100) - 1
	);
	assert.equal(fillTargetMb({ sizeMb: 1000, usedMb: 950 }), 0);
});

// ── the node-side scripts, run for real here in /dev/shm at a tiny size ───

void test('the facts script reads the fs, its size and use, and memory, and makes its own directory', () => {
	const r = bash(tmpfsFactsScript(SHM));
	const f = parseFacts(r.stdout);
	try {
		assert.equal(f.fstype, 'tmpfs', r.stdout);
		assert.ok(f.sizeMb > 0 && f.usedMb >= 0 && f.availMb > 0 && f.memTotalMb > 0, r.stdout);
		assert.ok(f.dir?.startsWith(`${SHM}/qualify-tmpfs.`), r.stdout);
		assert.ok(existsSync(f.dir));
	} finally {
		if (f.dir) rmSync(f.dir, { recursive: true, force: true });
	}
});

void test('the fill script writes its target, reads memory while full, and deletes what it wrote', () => {
	const dir = mkdtempSync(join(SHM, 'qualify-tmpfs.'));
	try {
		const r = bash(
			tmpfsFillScript({ dir, root: SHM, targetMb: 8, chunkMb: 4, stopMb: 1, settleSec: 0 })
		);
		const f = parseFill(r.stdout);
		assert.equal(f.filledMb, 8, r.stdout + r.stderr);
		assert.ok(f.fullAvailMb > 0);
		assert.ok(f.fullTmpUsedMb >= 0);
		assert.equal(f.stopped, null);
		assert.equal(f.ddFail, null);
		assert.equal(f.clean, true);
		assert.equal(f.complete, true);
		assert.deepEqual(readdirSync(dir), [], 'the fill left files behind');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

void test('the fill stops before writing when memory is already at the stop floor, and says so', () => {
	const dir = mkdtempSync(join(SHM, 'qualify-tmpfs.'));
	try {
		const r = bash(
			tmpfsFillScript({ dir, root: SHM, targetMb: 8, chunkMb: 4, stopMb: 10_000_000, settleSec: 0 })
		);
		const f = parseFill(r.stdout);
		assert.equal(f.filledMb, 0, r.stdout);
		assert.match(f.stopped ?? '', /MemAvailable \d+ < 10000000/);
		assert.deepEqual(readdirSync(dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

void test('the cleanup script refuses a path that is not one of its own directories', () => {
	assert.throws(() => tmpfsCleanupScript('/tmp'), /not a qualify-tmpfs directory/);
	assert.throws(
		() =>
			tmpfsFillScript({
				dir: '/home/x',
				root: '/tmp',
				targetMb: 1,
				chunkMb: 1,
				stopMb: 1,
				settleSec: 0,
			}),
		/not a qualify-tmpfs directory/
	);
});

void test('the whole test, end to end against this box in /dev/shm at a tiny share, measures and leaves nothing', async () => {
	const calls = [];
	const before = ownDirs();
	// A machine whose floor is 1 MiB: this box will clear it, and the point here
	// is that the run happened and cleaned up, not this box's verdict.
	const r = await makeTmpfsTest({ root: SHM, maxFillMb: 8, chunkMb: 4, settleSec: 0 }).run(
		ctxFor(localExec(calls), { minFreeMb: 1 })
	);
	assert.equal(r.status, 'pass', JSON.stringify(r));
	assert.equal(r.metrics.filledMb, 8);
	assert.deepEqual(ownDirs(), before, 'a qualify-tmpfs directory was left behind');
	assert.ok(calls.every((c) => c.o.timeoutMs > 0));
});

// ── run(), against a scripted node ─────────────────────────────────────────

const facts = ({ fstype = 'tmpfs', size = 3937, used = 1, avail = 5758, total = 7872 } = {}) => ({
	ok: true,
	stdout: `FSTYPE ${fstype}\nTMP_SIZE_MB ${size}\nTMP_USED_MB ${used}\nMEM_AVAIL_MB ${avail}\nMEM_TOTAL_MB ${total}\nDIR /tmp/qualify-tmpfs.Ab12Cd\n`,
	stderr: '',
});
function fakeExec({ factsR = facts(), fillR }) {
	const calls = [];
	const exec = async (script, o) => {
		calls.push({ script, o });
		if (script.includes('QUALIFY_TMPFS_FACTS')) return factsR;
		if (script.includes('QUALIFY_TMPFS_CLEANUP'))
			return { ok: true, stdout: 'CLEAN\n', stderr: '' };
		return fillR;
	};
	return { exec, calls };
}
const fillOut = (avail, filled = 3542) => ({
	ok: true,
	stdout: `FILLED_MB ${filled}\nFULL_AVAIL_MB ${avail}\nFULL_TMP_USED_MB ${filled + 1}\nPSI_SOME_AVG10 0.00\nCLEAN\nAFTER_AVAIL_MB 5700\nFILL_END\n`,
	stderr: '',
});

void test('an 8 GB claw whose full /tmp leaves too little for one heavy job above its floor fails, with the numbers (the #129 shape)', async () => {
	const { exec, calls } = fakeExec({ fillR: fillOut(2216) });
	const r = await makeTmpfsTest().run(ctxFor(exec, { minFreeMb: 1536 }));
	assert.equal(r.status, 'fail');
	const need = 1536 + HEAVY_JOB_MB;
	assert.match(r.reason, new RegExp(`MemAvailable 2216 MiB < ${need} MiB`));
	assert.match(r.reason, /minFreeMb 1536/);
	assert.match(r.reason, new RegExp(`${HEAVY_JOB_MB} MiB`));
	// The fill was asked to stop at the node's own floor, never below it.
	const fill = calls.find((c) => c.script.includes('QUALIFY_TMPFS_FILL'));
	assert.match(fill.script, /stop=1536\b/);
	assert.equal(calls.filter((c) => c.script.includes('QUALIFY_TMPFS_CLEANUP')).length, 1);
});

void test('a node with room to mint one heavy job above its floor while /tmp is full passes', async () => {
	const { exec } = fakeExec({
		factsR: facts({ size: 7969, avail: 14000, total: 15937 }),
		fillR: fillOut(7000, 7171),
	});
	const r = await makeTmpfsTest().run(ctxFor(exec, { minFreeMb: 2048 }));
	assert.equal(r.status, 'pass', r.reason);
	assert.match(r.reason, /MemAvailable 7000 MiB ≥ 6144 MiB/);
});

void test('a /tmp that is not tmpfs costs no memory to fill: pass, and nothing is written', async () => {
	const { exec, calls } = fakeExec({ factsR: facts({ fstype: 'ext2/ext3' }) });
	const r = await makeTmpfsTest().run(ctxFor(exec));
	assert.equal(r.status, 'pass');
	assert.match(r.reason, /not tmpfs/);
	assert.equal(calls.filter((c) => c.script.includes('QUALIFY_TMPFS_FILL')).length, 0);
	assert.equal(calls.filter((c) => c.script.includes('QUALIFY_TMPFS_CLEANUP')).length, 1);
});

void test('no minFreeMb, unreadable facts, or a fill with no reading are could-not-look', async () => {
	const a = await makeTmpfsTest().run(ctxFor(fakeExec({}).exec, {}));
	assert.equal(a.status, 'could-not-look');
	assert.match(a.reason, /minFreeMb/);

	const b = await makeTmpfsTest().run(
		ctxFor(fakeExec({ factsR: { ok: false, stdout: '', stderr: 'Permission denied' } }).exec)
	);
	assert.equal(b.status, 'could-not-look');
	assert.match(b.reason, /Permission denied/);

	const { exec, calls } = fakeExec({
		fillR: {
			ok: false,
			stdout: 'FILLED_MB 512\n',
			stderr: '',
			error: 'no answer within 400s (killed by SIGTERM)',
		},
	});
	const c = await makeTmpfsTest().run(ctxFor(exec));
	assert.equal(c.status, 'could-not-look');
	assert.match(c.reason, /killed by SIGTERM/);
	assert.equal(calls.filter((x) => x.script.includes('QUALIFY_TMPFS_CLEANUP')).length, 1);
});

// ── judging ────────────────────────────────────────────────────────────────

const base = { minFreeMb: 1536, targetMb: 3542, tmpSizeMb: 3937 };

void test('the bar is minFreeMb plus one heavy job, read while /tmp is full', () => {
	const need = 1536 + HEAVY_JOB_MB;
	assert.equal(
		judgeHeadroom({
			...base,
			fill: { filledMb: 3542, fullAvailMb: need, complete: true, clean: true },
		}).status,
		'pass'
	);
	const v = judgeHeadroom({
		...base,
		fill: { filledMb: 3542, fullAvailMb: need - 1, complete: true, clean: true },
	});
	assert.equal(v.status, 'fail');
	assert.equal(v.metrics.needMb, need);
});

void test('a fill stopped at the floor is a fail: the node reached its floor before /tmp was full', () => {
	const v = judgeHeadroom({
		...base,
		fill: {
			filledMb: 2048,
			fullAvailMb: 1500,
			stopped: 'MemAvailable 1500 < 1536',
			complete: true,
			clean: true,
		},
	});
	assert.equal(v.status, 'fail');
	assert.match(v.reason, /stopped at 2048 of 3542 MiB/);
});

void test('a fill cut short by a write error with memory above the bar is could-not-look', () => {
	const v = judgeHeadroom({
		...base,
		fill: { filledMb: 100, fullAvailMb: 9000, ddFail: '1', complete: true, clean: true },
	});
	assert.equal(v.status, 'could-not-look');
	assert.match(v.reason, /100 of 3542 MiB/);
});

void test('files the fill could not delete are said, whatever the verdict', () => {
	const v = judgeHeadroom({
		...base,
		fill: {
			filledMb: 3542,
			fullAvailMb: 9000,
			complete: true,
			clean: false,
			left: '/tmp/qualify-tmpfs.Ab12Cd',
		},
	});
	assert.match(v.reason, /left \/tmp\/qualify-tmpfs\.Ab12Cd/);
});
