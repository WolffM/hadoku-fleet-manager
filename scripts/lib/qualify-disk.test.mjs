/**
 * The storage bootcamp's disk qualification (F2, #137): SMR, SMART and
 * burn-in, judged on F1's real-node fixtures (storage-fixtures.mjs) and, for
 * the burn-in loop, against a fake node that answers its scripts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseStorage } from './storage-inventory.mjs';
import { CLAW10, CLAW2, CLAW4, CLAW9, CLAW9_NOROOT, CLAW9_NOTOOL } from './storage-fixtures.mjs';
import { candidates, nodeStatus } from './qualify-disk-inventory.mjs';
import { judgeSmr, recordingOf, test as smrTest } from './qualify-disk-smr.mjs';
import { judgeSmart, REALLOCATED_MAX, test as smartTest } from './qualify-disk-smart.mjs';
import {
	assertSerial,
	chunkScript,
	initialState,
	makeBurninTest,
	parseChunk,
	smartWorse,
	STATE_DIR,
} from './qualify-disk-burnin.mjs';
import { validateTest } from './qualify-registry.mjs';
import { QUALIFY_DISK_TESTS, QUALIFY_TESTS } from './qualify-playlist.mjs';
import { judgeWindow } from './qualify-baseline.mjs';

const disk = (fixture, dev) => parseStorage(fixture).disks.find((d) => d.device === dev);

void test('every disk test meets the qualify contract, and none is in the nightly playlist', () => {
	const burnin = makeBurninTest({ serial: 'WD-ABC123' });
	for (const t of [smrTest, smartTest, burnin]) assert.deepEqual(validateTest(t), [], t.id);
	assert.deepEqual(
		QUALIFY_DISK_TESTS.map((t) => t.id),
		['disk-smr', 'disk-smart']
	);
	assert.ok(
		!QUALIFY_TESTS.some((t) => t.id.startsWith('disk-smr') || t.id.startsWith('disk-smart'))
	);
	assert.ok(!QUALIFY_DISK_TESTS.some((t) => t.needsDrain), 'the read-only checks drain nothing');
	assert.equal(burnin.needsDrain, true);
});

void test('candidates: never the root disk, never an empty card-reader slot', () => {
	assert.deepEqual(
		candidates(parseStorage(CLAW4)).map((d) => d.device),
		['sdb']
	);
	assert.deepEqual(candidates(parseStorage(CLAW2)), []);
	assert.deepEqual(
		candidates(parseStorage(CLAW10)).map((d) => d.device),
		['sdb', 'sdc']
	);
});

void test('SMR: the fleet CMR disks pass by their identified model', () => {
	for (const [fx, dev] of [
		[CLAW9, 'sdb'],
		[CLAW10, 'sdc'],
		[CLAW4, 'sdb'],
	]) {
		const v = judgeSmr(disk(fx, dev));
		assert.equal(v.verdict, 'pass', `${dev}: ${v.reason}`);
		assert.match(v.reason, /^CMR: /);
	}
});

void test('SMR: an unidentified rotational model is BLOCKED, never assumed CMR', () => {
	const d = { ...disk(CLAW9, 'sdb'), model: 'WDC WD99NEWX-00ABC0' };
	const v = judgeSmr(d);
	assert.equal(v.verdict, 'blocked');
	assert.match(v.reason, /not identified.*never assumed CMR/);
	assert.equal(judgeSmr({ ...d, rotational: null }).verdict, 'blocked');
	assert.equal(judgeSmr({ ...d, model: null }).verdict, 'blocked');
});

void test('SMR: a disclosed SMR model, a zoned drive and a rotational TRIM are refused', () => {
	const base = disk(CLAW9, 'sdb');
	assert.equal(judgeSmr({ ...base, model: 'WDC WD40EFAX-68JH4N1' }).verdict, 'fail');
	assert.equal(judgeSmr({ ...base, model: 'ST2000DM008-2FR102' }).verdict, 'fail');
	// The zoned line as the probe now prints it, parsed end to end.
	const zoned = parseStorage(
		CLAW9.replace('disk.sdb.kind ata', 'disk.sdb.kind ata\ndisk.sdb.zoned host-aware')
	);
	const z = judgeSmr(zoned.disks.find((d) => d.device === 'sdb'));
	assert.equal(z.verdict, 'fail');
	assert.match(z.reason, /zoned \(host-aware\)/);
	// A CMR table entry does not outvote the drive advertising TRIM.
	const t = judgeSmr({ ...base, trim: true });
	assert.equal(t.verdict, 'fail');
	assert.match(t.reason, /TRIM/);
	assert.equal(judgeSmr({ ...base, zoned: 'none' }).verdict, 'pass', 'none is not a refusal');
});

void test('SMR: solid state passes; a disk with no serial is blocked', () => {
	assert.equal(judgeSmr(disk(CLAW2, 'nvme0n1')).verdict, 'pass');
	assert.equal(judgeSmr({ ...disk(CLAW9, 'sdb'), serial: null }).verdict, 'blocked');
	assert.equal(recordingOf('WDC WD10EZEX-08WN4A0').recording, 'CMR');
	assert.equal(recordingOf(''), null);
});

void test('SMART: a healthy answered drive passes, with its power-on hours', () => {
	const v = judgeSmart(disk(CLAW9, 'sdb'));
	assert.equal(v.verdict, 'pass', v.reason);
	assert.equal(v.pendingSectors, 0);
	assert.equal(v.offlineUncorrectable, 0);
	assert.ok(v.powerOnHours > 30_000);
});

void test('SMART: every absence of a reading is BLOCKED with its reason', () => {
	const cases = [
		[disk(CLAW9_NOTOOL, 'sdb'), /no-tool/],
		[disk(CLAW9_NOROOT, 'sdb'), /not-root/],
		[disk(CLAW10, 'sdb'), /disabled/],
	];
	for (const [d, re] of cases) {
		const v = judgeSmart(d);
		assert.equal(v.verdict, 'blocked', v.reason);
		assert.match(v.reason, re);
	}
	// claw-4's card reader, had it held a card: the USB bridge refuses SMART.
	const usb = { ...disk(CLAW4, 'sdc'), mediaPresent: true, sizeBytes: 32e9 };
	assert.match(judgeSmart(usb).reason, /unsupported/);
	// A spinning disk silent on 197/198 is not zero.
	const silent = disk(CLAW9, 'sdb');
	const s = judgeSmart({ ...silent, smart: { ...silent.smart, pendingSectors: null } });
	assert.equal(s.verdict, 'blocked');
	assert.match(s.reason, /silence is not zero/);
});

void test('SMART: pending, offline-uncorrectable, reallocation and wear are refused', () => {
	const d = disk(CLAW9, 'sdb');
	const bad = (smart) => judgeSmart({ ...d, smart: { ...d.smart, ...smart } });
	assert.equal(bad({ pendingSectors: 1 }).verdict, 'fail');
	assert.equal(bad({ offlineUncorrectable: 2 }).verdict, 'fail');
	assert.equal(bad({ reallocated: REALLOCATED_MAX }).verdict, 'pass');
	assert.equal(bad({ reallocated: REALLOCATED_MAX + 1 }).verdict, 'fail');
	assert.equal(bad({ lifetimeRemainingPct: 5 }).verdict, 'fail');
	assert.equal(bad({ status: 'failing', why: 'SMART health is FAILED!' }).verdict, 'fail');
});

void test('node status: a passing disk passes the node; only blocked disks are could-not-look', () => {
	const p = { serial: 'A', device: 'sdb', verdict: 'pass', reason: 'ok' };
	const b = { serial: 'B', device: 'sdc', verdict: 'blocked', reason: 'usb' };
	const f = { serial: 'C', device: 'sdd', verdict: 'fail', reason: 'SMR' };
	assert.equal(nodeStatus('x', [p, b, f]).status, 'pass');
	assert.equal(nodeStatus('x', [b, f]).status, 'could-not-look');
	assert.equal(nodeStatus('x', [f]).status, 'fail');
	assert.equal(nodeStatus('x', []).status, 'fail');
	assert.match(nodeStatus('x', [p, f]).reason, /refused: C: SMR/);
});

void test('the SMR test runs the probe as admin and judges the parsed node', async () => {
	const scripts = [];
	const ctx = {
		node: 'claw-9',
		exec: async (s) => (scripts.push(s), { ok: true, stdout: CLAW9, stderr: '' }),
	};
	const r = await smrTest.run(ctx);
	assert.equal(r.status, 'pass', r.reason);
	assert.match(scripts[0], /^# QUALIFY_DISK_PROBE\nsudo -n sh -s <<'QUALIFY_DISK_PROBE_EOF'/);
	assert.match(scripts[0], /\nstorage_probe\nQUALIFY_DISK_PROBE_EOF$/);
	const noRoot = await smartTest.run({
		...ctx,
		exec: async () => ({ ok: true, stdout: CLAW9_NOROOT }),
	});
	assert.equal(noRoot.status, 'could-not-look');
	assert.match(noRoot.reason, /not run as root/);
	const none = await smartTest.run({
		...ctx,
		exec: async () => ({ ok: false, stdout: '', error: 'ssh: timeout' }),
	});
	assert.equal(none.status, 'could-not-look');
	assert.match(none.reason, /ssh: timeout/);
});

void test('baselines: a refused disk is a weak point, never a finding; hours are learned per serial', () => {
	const smart = {
		id: 'disk-smart',
		status: 'fail',
		reason: 'no disk passes the SMART check: refused: X: 3 pending sector(s)',
		metrics: { disks: [{ serial: 'X', verdict: 'fail', powerOnHours: 1200 }] },
	};
	const smr = { id: 'disk-smr', status: 'fail', reason: 'SMR', metrics: { disks: [] } };
	const burn = { id: 'disk-burnin', status: 'fail', reason: 'read error', metrics: {} };
	const w = judgeWindow({ node: 'claw-9', results: [smart, smr, burn], quantities: {} });
	assert.deepEqual(w.findings, []);
	assert.deepEqual(
		w.weak.map((x) => x.test),
		['disk-smart', 'disk-smr', 'disk-burnin']
	);
	assert.deepEqual(
		w.readings.map((r) => [r.quantity, r.value]),
		[['disk.X.powerOnHours', 1200]]
	);
	// A counter that went backwards is drift.
	const back = judgeWindow({
		node: 'claw-9',
		results: [
			{
				...smart,
				status: 'pass',
				metrics: { disks: [{ serial: 'X', verdict: 'pass', powerOnHours: 10 }] },
			},
		],
		quantities: { 'disk.X.powerOnHours': { mean: 30_000, sd: 0, n: 3 } },
	});
	assert.equal(back.findings[0]?.kind, 'drift');
});

// ── burn-in ────────────────────────────────────────────────────────────────

void test('burn-in names a disk by a serial that is safe in a path and a shell', () => {
	assert.equal(assertSerial('WD-WCC6Y0ABC123'), 'WD-WCC6Y0ABC123');
	for (const bad of ['', '../x', 'a b', "a'b", 'a;rm', null])
		assert.throws(() => assertSerial(bad));
	assert.throws(() => makeBurninTest({ serial: '$(reboot)' }));
});

void test('the chunk script: read phase is --readonly; write phase refuses mounts, partitions, signatures', () => {
	const r = chunkScript({
		serial: 'S1',
		phase: 'read',
		offsetBytes: 0,
		lengthBytes: 1024,
		deadlineSec: 60,
	});
	assert.match(r, /--rw=read --readonly/);
	assert.doesNotMatch(r, /blkid/);
	assert.match(r, /holds \//, 'the root disk is refused in either phase');
	const w = chunkScript({
		serial: 'S1',
		phase: 'write',
		offsetBytes: 1024,
		lengthBytes: 1024,
		deadlineSec: 60,
	});
	assert.match(w, /--verify=crc32c --do_verify=1 --verify_fatal=1/);
	assert.match(w, /is mounted/);
	assert.match(w, /has partitions/);
	assert.match(w, /blkid -p "\$dev"/);
	assert.match(w, /--offset=1024 --size=1024/);
	assert.throws(() =>
		chunkScript({ serial: 'S1', phase: 'trim', offsetBytes: 0, lengthBytes: 1, deadlineSec: 1 })
	);
});

void test('parseChunk reads a refusal, fio JSON, rc and time', () => {
	assert.equal(
		parseChunk('BURNIN_REFUSE /dev/sdb is mounted\n', 'write').refused,
		'/dev/sdb is mounted'
	);
	const out = [
		'BURNIN_DEV /dev/sdb',
		'BURNIN_JSON_BEGIN',
		'fio: some warning',
		JSON.stringify({ jobs: [{ error: 0, read: { io_bytes: 2048 }, write: { io_bytes: 0 } }] }),
		'BURNIN_JSON_END',
		'BURNIN_RC 0',
		'BURNIN_MS 1500',
	].join('\n');
	assert.deepEqual(parseChunk(out, 'read'), {
		refused: null,
		dev: '/dev/sdb',
		rc: 0,
		ms: 1500,
		error: 0,
		bytes: 2048,
	});
});

void test('the mode is fixed at the start from `blank`; not-blank and not-looked-at never write', () => {
	const blank = disk(CLAW9, 'sdb');
	assert.equal(blank.blank, true);
	assert.deepEqual(initialState(blank, 'T').phases, ['read', 'write']);
	assert.deepEqual(initialState(disk(CLAW10, 'sdc'), 'T').phases, ['read']);
	assert.deepEqual(initialState({ ...blank, blank: null }, 'T').phases, ['read']);
});

void test('smartWorse: any new reallocated, pending or uncorrectable sector', () => {
	const b = { status: 'ok', reallocated: 0, pendingSectors: 0, offlineUncorrectable: 0 };
	assert.equal(smartWorse(b, b), null);
	assert.match(smartWorse(b, { ...b, reallocated: 3 }), /reallocated 0 → 3/);
	assert.match(smartWorse(b, { ...b, status: 'failing' }), /failing/);
});

/**
 * A fake claw-9 with one blank 4-MiB disk. `chunk` decides each chunk's answer;
 * the state file lives in `files`, as the node would keep it.
 */
function fakeNode({ serial, sizeBytes = 4 * 1024 * 1024, chunk, probe = CLAW9 } = {}) {
	const files = new Map();
	const calls = [];
	const inv = probe
		.replace(/SERIAL="SERIAL-claw-9-sdb"/, `SERIAL="${serial}"`)
		.replace(/disk\.sdb\.sizeBytes \d+/, `disk.sdb.sizeBytes ${sizeBytes}`);
	const exec = async (script) => {
		const kind = script.split('\n')[0];
		calls.push(kind);
		if (kind === '# QUALIFY_DISK_PROBE') return { ok: true, stdout: inv };
		const path = script.match(/f='([^']+)'/)?.[1];
		if (script.includes('BURNIN_STATE_EOF'))
			return files.has(path)
				? { ok: true, stdout: `STATE_BEGIN\n${files.get(path)}\nSTATE_END\n` }
				: { ok: true, stdout: 'NO_STATE\n' };
		if (script.includes('BURNIN_SAVE_EOF')) {
			const b64 = script.match(/printf '%s' '([^']+)'/)[1];
			files.set(path, Buffer.from(b64, 'base64').toString());
			return { ok: true, stdout: 'STATE_SAVED\n' };
		}
		if (script.includes('BURNIN_CHUNK_EOF')) {
			const phase = /--rw=read/.test(script) ? 'read' : 'write';
			const len = Number(script.match(/--size=(\d+)/)[1]);
			const off = Number(script.match(/--offset=(\d+)/)[1]);
			return chunk({ phase, off, len });
		}
		throw new Error(`unexpected script: ${kind}`);
	};
	return { files, calls, ctx: { node: 'claw-9', nowMs: 0, exec, log: () => {} } };
}
const okChunk = ({ phase, len }) => ({
	ok: true,
	stdout: [
		'BURNIN_DEV /dev/sdb',
		'BURNIN_JSON_BEGIN',
		JSON.stringify({ jobs: [{ error: 0, [phase]: { io_bytes: len } }] }),
		'BURNIN_JSON_END',
		'BURNIN_RC 0',
		'BURNIN_MS 100',
	].join('\n'),
});

void test('burn-in of a blank disk: read then write+verify, every chunk saved, then a pass', async () => {
	const serial = 'WD-BLANK1';
	const seen = [];
	const n = fakeNode({ serial, chunk: (c) => (seen.push(`${c.phase}@${c.off}`), okChunk(c)) });
	const t = makeBurninTest({ serial, chunkMb: 1, budgetMinutes: 60 });
	const r = await t.run(n.ctx);
	assert.equal(r.status, 'pass', r.reason);
	assert.match(r.reason, /read, written and verified over 8 chunk/);
	assert.deepEqual(seen, [
		'read@0',
		'read@1048576',
		'read@2097152',
		'read@3145728',
		'write@0',
		'write@1048576',
		'write@2097152',
		'write@3145728',
	]);
	const state = JSON.parse(n.files.get(`${STATE_DIR}/${serial}.json`));
	assert.equal(state.result.status, 'pass');
	assert.equal(state.phase, 'done');
	// A second run reports the recorded result and touches no sector.
	const again = await t.run(n.ctx);
	assert.equal(again.status, 'pass');
	assert.match(again.reason, /remove .*WD-BLANK1\.json to run it again/);
	assert.equal(seen.length, 8);
});

void test('burn-in resumes where the budget stopped it, and an unfinished one is never a pass', async () => {
	const serial = 'WD-RESUME';
	let clock = 0;
	const seen = [];
	const n = fakeNode({
		serial,
		chunk: (c) => {
			seen.push(`${c.phase}@${c.off}`);
			clock += 25 * 60_000; // each chunk "takes" 25 min
			return okChunk(c);
		},
	});
	const t = makeBurninTest({ serial, chunkMb: 1, budgetMinutes: 60, now: () => clock });
	const first = await t.run(n.ctx);
	assert.equal(first.status, 'could-not-look');
	// A chunk starts while its deadline fits what is left: 0, 25 and 50 min.
	assert.match(first.reason, /37% done .*resumes where it stopped/);
	assert.deepEqual(seen, ['read@0', 'read@1048576', 'read@2097152']);
	clock = 1e9;
	const second = await makeBurninTest({
		serial,
		chunkMb: 1,
		budgetMinutes: 60,
		now: () => clock,
	}).run(n.ctx);
	assert.equal(second.status, 'could-not-look');
	assert.deepEqual(seen.slice(3), ['read@3145728', 'write@0', 'write@1048576']);
	assert.match(second.reason, /75% done \(write mode, phase write\)/);
});

void test('burn-in: a refused write chunk stops with nothing written; a read error fails the disk', async () => {
	const serial = 'WD-REFUSE';
	const n = fakeNode({
		serial,
		chunk: (c) =>
			c.phase === 'write'
				? { ok: false, stdout: 'BURNIN_REFUSE /dev/sdb carries a signature (blkid -p exit 0)\n' }
				: okChunk(c),
	});
	const r = await makeBurninTest({ serial, chunkMb: 2, budgetMinutes: 60 }).run(n.ctx);
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /refused on the node: .*signature.*nothing was written/);
	assert.equal(
		JSON.parse(n.files.get(`${STATE_DIR}/${serial}.json`)).result,
		null,
		'not a verdict'
	);

	const bad = 'WD-EIO';
	const e = fakeNode({
		serial: bad,
		chunk: ({ phase }) => ({
			ok: false,
			stdout: `BURNIN_JSON_BEGIN\n${JSON.stringify({ jobs: [{ error: 5, [phase]: { io_bytes: 0 } }] })}\nBURNIN_JSON_END\nBURNIN_RC 1\nBURNIN_MS 9\n`,
		}),
	});
	const f = await makeBurninTest({ serial: bad, chunkMb: 2, budgetMinutes: 60 }).run(e.ctx);
	assert.equal(f.status, 'fail');
	assert.match(f.reason, /fio exit 1, error 5 \(a read error\)/);
	assert.equal(JSON.parse(e.files.get(`${STATE_DIR}/${bad}.json`)).result.status, 'fail');

	const slow = 'WD-SLOW';
	const s = fakeNode({
		serial: slow,
		chunk: () => ({
			ok: false,
			stdout: 'BURNIN_JSON_BEGIN\nBURNIN_JSON_END\nBURNIN_RC 124\nBURNIN_MS 9\n',
		}),
	});
	const sr = await makeBurninTest({ serial: slow, chunkMb: 2, budgetMinutes: 60 }).run(s.ctx);
	assert.equal(sr.status, 'fail');
	assert.match(sr.reason, /under 10 MB\/s/);
});

void test('burn-in: a not-blank disk is read only; an unknown serial or the root disk is refused', async () => {
	const serial = 'WD-NTFS';
	const seen = [];
	const ntfs = CLAW10.replace(/SERIAL="SERIAL-claw-10-sdc"/, `SERIAL="${serial}"`).replace(
		/disk\.sdc\.sizeBytes \d+/,
		`disk.sdc.sizeBytes ${2 * 1024 * 1024}`
	);
	const n = fakeNode({ serial, chunk: (c) => (seen.push(c.phase), okChunk(c)) });
	// fakeNode rewrites claw-9 names; feed the claw-10 capture as is.
	n.ctx.exec = ((exec) => async (s) =>
		s.startsWith('# QUALIFY_DISK_PROBE') ? { ok: true, stdout: ntfs } : exec(s))(n.ctx.exec);
	const t = makeBurninTest({ serial, chunkMb: 1, budgetMinutes: 170 });
	const r = await t.run(n.ctx);
	assert.equal(r.status, 'pass', r.reason);
	assert.match(r.reason, /read-only: the disk was not blank/);
	assert.deepEqual(seen, ['read', 'read']);

	const miss = await makeBurninTest({ serial: 'NOPE' }).run(
		fakeNode({ serial: 'X', chunk: okChunk }).ctx
	);
	assert.equal(miss.status, 'could-not-look');
	assert.match(miss.reason, /0 disks on claw-9 answer to serial NOPE; candidates: X \(sdb\)/);

	const rootSerial = parseStorage(CLAW9).disks.find((d) => d.isRoot).serial;
	const root = await makeBurninTest({ serial: rootSerial }).run(
		fakeNode({ serial: 'X', chunk: okChunk }).ctx
	);
	assert.match(root.reason, /holds \/; the root disk is never burned in/);
});
