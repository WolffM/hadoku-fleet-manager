/**
 * The job-completed hook may never fail a job.
 *
 * actions/runner ADR 1751: a non-zero hook exit FAILS THE JOB. `job-metrics.sh`
 * is pure instrumentation — there is no memory reading worth failing someone's
 * build for, and the failure would present as a red build with no explanation in
 * the workflow at all.
 *
 * These drive the REAL script rather than grepping it, because the property that
 * matters is behavioural: what does it exit with when the thing it wants to
 * measure is not there. The static checks below are a second line only, for the
 * two edits most likely to break it silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	existsSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(dirname(fileURLToPath(import.meta.url))), 'job-metrics.sh');

/** Run the hook, returning {code, out, err}. Never throws on a non-zero exit. */
function run(env = {}, argv = []) {
	const dir = mkdtempSync(join(tmpdir(), 'job-metrics-'));
	try {
		let code = 0;
		let out = '';
		let err = '';
		try {
			out = execFileSync('bash', [HOOK, ...argv], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, HOME: dir, JOB_METRICS_OUT: join(dir, 'm.jsonl'), ...env },
			});
		} catch (e) {
			code = e.status ?? 1;
			out = String(e.stdout ?? '');
			err = String(e.stderr ?? '');
		}
		const file = join(dir, 'm.jsonl');
		const rows = existsSync(file)
			? readFileSync(file, 'utf8')
					.split('\n')
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
		return { code, out, err, rows, dir };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('exits 0 in the ordinary case', () => {
	const r = run({ GITHUB_REPOSITORY: 'WolffM/x', GITHUB_RUN_ID: '1', RUNNER_NAME: 'n' });
	assert.equal(r.code, 0);
});

test('exits 0 when the cgroup files are unreadable — the case that would fail builds', () => {
	// A cgroup path that cannot exist. The hook must record nothing and still
	// succeed; the alternative is every job on that node going red.
	const r = run({ JOB_METRICS_OUT: '/proc/definitely/not/writable/m.jsonl' });
	assert.equal(r.code, 0);
});

test('exits 0 when the output path is not writable', () => {
	const r = run({ JOB_METRICS_OUT: '/m.jsonl' });
	assert.equal(r.code, 0, 'an unwritable destination must not fail the job');
});

test('writes ONE valid JSON line per invocation', () => {
	// JOB_METRICS_UNIT pins the unit NAME so the env fallback is reachable. Without
	// it this passes on a dev box and fails in CI, where the process runs inside a
	// JIT unit whose leaf carries a real run id that wins over GITHUB_RUN_ID.
	const r = run({
		GITHUB_REPOSITORY: 'WolffM/x',
		GITHUB_RUN_ID: '42',
		RUNNER_NAME: 'claw-9',
		JOB_METRICS_UNIT: 'standing-runner.service',
	});
	assert.equal(r.rows.length, 1);
	const row = r.rows[0];
	assert.equal(row.repo, 'WolffM/x');
	assert.equal(row.runId, 42);
	assert.equal(row.runner, 'claw-9');
	assert.equal(typeof row.node, 'string');
	assert.ok(['jit', 'standing'].includes(row.kind));
});

test('a peak it could not read is never written as a number', () => {
	// The record must not claim a job used null bytes. Either a real reading or
	// no row at all — "I could not look" is not a measurement.
	const r = run({ GITHUB_REPOSITORY: 'WolffM/x' });
	for (const row of r.rows) {
		assert.notEqual(row.peakBytes, null, 'a row exists, so it must carry a real peak');
		assert.equal(typeof row.peakBytes, 'number');
	}
});

test('quotes in the environment cannot break the JSON', () => {
	const r = run({ GITHUB_REPOSITORY: 'WolffM/a"b\\c', GITHUB_RUN_ID: '7', RUNNER_NAME: 'n' });
	assert.equal(r.code, 0);
	// Parsing already happened in run(); reaching here means the line survived.
	assert.equal(r.rows.length, 1);
	assert.equal(r.rows[0].repo, 'WolffM/a"b\\c');
});

test('a non-numeric run id becomes null, never a broken literal', () => {
	const r = run({
		GITHUB_REPOSITORY: 'WolffM/x',
		GITHUB_RUN_ID: 'not-a-number',
		JOB_METRICS_UNIT: 'standing-runner.service',
	});
	assert.equal(r.code, 0);
	assert.equal(r.rows[0].runId, null);
});

// ── #37: rotation at the retention boundary, keeping ONE `.1` ────────────────

/** Run the hook against an OUT the caller seeded; returns every row on disk, by file. */
function runSeeded(seed, env = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'job-metrics-rot-'));
	const out = join(dir, 'm.jsonl');
	if (seed.live != null) writeFileSync(out, seed.live);
	if (seed.one != null) writeFileSync(`${out}.1`, seed.one);
	const code = runHook(out, dir, env);
	const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : null);
	const res = { code, live: read(out), one: read(`${out}.1`), files: readdirSync(dir).sort() };
	rmSync(dir, { recursive: true, force: true });
	return res;
}

function runHook(out, home, env = {}) {
	try {
		execFileSync('bash', [HOOK], {
			stdio: 'ignore',
			env: {
				...process.env,
				HOME: home,
				JOB_METRICS_OUT: out,
				GITHUB_REPOSITORY: 'WolffM/rotated',
				JOB_METRICS_UNIT: 'standing-runner.service',
				...env,
			},
		});
		return 0;
	} catch (e) {
		return e.status ?? 1;
	}
}

const daysAgo = (d) =>
	new Date(Date.now() - d * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const seedRows = (ts, n) =>
	Array.from({ length: n }, (_, i) => `{"ts":"${ts}","seed":${i}}`).join('\n') + '\n';

test('a file whose oldest row is past the window is ROTATED to .1, row just taken included', () => {
	const r = runSeeded({ live: seedRows(daysAgo(15), 5) });
	assert.equal(r.code, 0);
	assert.ok(r.one, 'a .1 now exists');
	assert.equal(r.one.filter((l) => l.includes('"seed"')).length, 5, 'every old row kept in .1');
	const all = [...(r.live ?? []), ...r.one];
	assert.equal(
		all.filter((l) => l.includes('"repo":"WolffM/rotated"')).length,
		1,
		'the row this run wrote survives the rotation — in .1 or the live file, exactly once'
	);
});

test('a file inside the window is NOT rotated — the row is appended and nothing moves', () => {
	const r = runSeeded({ live: seedRows(daysAgo(13), 5) });
	assert.equal(r.code, 0);
	assert.equal(r.one, null, 'no .1 inside the window');
	assert.equal(r.live.length, 6);
	assert.ok(r.live[5].includes('"repo":"WolffM/rotated"'));
});

test('ONE generation is kept: a rotation replaces the old .1 rather than stacking', () => {
	// The old `.1` holds the window BEFORE the one being rotated out, so every
	// row in it is already past retention by the time it is replaced.
	const r = runSeeded({
		live: seedRows(daysAgo(15), 3),
		one: `{"ts":"${daysAgo(200)}","ancient":true}\n`,
	});
	assert.equal(r.code, 0);
	assert.ok(!r.one.some((l) => l.includes('ancient')), 'the previous .1 is gone');
	assert.equal(r.one.filter((l) => l.includes('"seed"')).length, 3);
	assert.deepEqual(r.files, ['m.jsonl.1', 'm.jsonl.lock'], 'one generation, nothing else');
});

test('the byte backstop rotates a file that outgrows it inside one window', () => {
	const r = runSeeded({ live: seedRows(daysAgo(1), 50) }, { JOB_METRICS_MAX_BYTES: '1000' });
	assert.equal(r.code, 0);
	assert.ok(r.one, 'rotated on size');
	assert.equal(r.one.filter((l) => l.includes('"seed"')).length, 50, 'rotated, never truncated');
});

test('a garbage first row or a garbage knob never fails the job and never rotates on age', () => {
	const junk = runSeeded({ live: 'not json at all\n' });
	assert.equal(junk.code, 0);
	assert.equal(junk.one, null);
	const knob = runSeeded(
		{ live: seedRows(daysAgo(30), 2) },
		{ JOB_METRICS_RETENTION_DAYS: 'fourteen' }
	);
	assert.equal(knob.code, 0, 'a non-numeric knob disables rotation, it does not fail the job');
	assert.equal(knob.one, null);
	assert.equal(knob.live.length, 3);
});

test('hooks finishing TOGETHER on a due file lose no row and never clobber .1', async () => {
	// Up to four runners share a node, so completions overlap. Two rotators
	// racing without the re-check under `flock` can rename a FRESH file over the
	// `.1` that holds the whole previous window.
	const { spawn } = await import('node:child_process');
	const dir = mkdtempSync(join(tmpdir(), 'job-metrics-race-'));
	try {
		const out = join(dir, 'm.jsonl');
		const SEED = 40;
		const HOOKS = 12;
		writeFileSync(out, seedRows(daysAgo(20), SEED));
		await Promise.all(
			Array.from(
				{ length: HOOKS },
				(_, i) =>
					new Promise((res, rej) => {
						const c = spawn('bash', [HOOK], {
							stdio: 'ignore',
							env: {
								...process.env,
								HOME: dir,
								JOB_METRICS_OUT: out,
								GITHUB_REPOSITORY: `WolffM/race-${i}`,
								JOB_METRICS_UNIT: 'standing-runner.service',
							},
						});
						c.on('error', rej);
						c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`hook exited ${code}`))));
					})
			)
		);
		const lines = [out, `${out}.1`].flatMap((p) =>
			existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []
		);
		assert.equal(lines.filter((l) => l.includes('"seed"')).length, SEED, 'the old window survived');
		for (let i = 0; i < HOOKS; i++) {
			assert.equal(
				lines.filter((l) => l.includes(`"repo":"WolffM/race-${i}"`)).length,
				1,
				`hook ${i}'s row is on disk exactly once`
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the rotation is a RENAME — nothing in the hook rewrites the file in place', () => {
	// A copy-and-replace (`tail > tmp && mv tmp OUT`, the trim that was here
	// until #37) discards any row appended between the copy and the replace.
	// Only `>>` may write to the file itself.
	const code = readFileSync(HOOK, 'utf8')
		.split('\n')
		.filter((l) => !l.trim().startsWith('#'))
		.join('\n');
	assert.ok(!/(^|[^>])>\s*"?\$OUT(?!\.lock)/m.test(code), 'no truncating redirect onto $OUT');
	assert.ok(!/mv[^\n]*"\$OUT\.tmp"/.test(code), 'no temp-file replace of $OUT');
	assert.match(code, /mv -f "\$OUT" "\$OUT\.1"/, 'the rotation is the rename');
	assert.match(code, /flock -n 9/, 'and it is decided under the lock');
});

test("the hook's window is job-history's RETENTION_DAYS — one number, two spellings, pinned", async () => {
	const { RETENTION_DAYS } = await import('../../dist/job-history.js');
	const m = /JOB_METRICS_RETENTION_DAYS:-(\d+)/.exec(readFileSync(HOOK, 'utf8'));
	assert.ok(m, 'the hook declares its default window');
	assert.equal(
		Number(m[1]),
		RETENTION_DAYS,
		'the rotation boundary and the join window must agree'
	);
});

test('the source carries no `set -e` — one edit away from failing every job', () => {
	const src = readFileSync(HOOK, 'utf8');
	const stripped = src
		.split('\n')
		.filter((l) => !l.trim().startsWith('#'))
		.join('\n');
	assert.ok(!/set\s+-[a-z]*e/.test(stripped), 'set -e in a job-completed hook fails builds');
	assert.ok(!/set\s+-o\s+errexit/.test(stripped));
	assert.ok(/\nexit 0\n?$/.test(src), 'the script must end at an explicit exit 0');
});

// The production path, which had no direct test — and whose absence is why the
// env-fallback tests could silently become unreachable on the fleet. A JIT unit
// name carries the ids, and it must WIN over the environment: the env there
// belongs to the workflow, while the cgroup is the unit the kernel actually
// billed.
test('a JIT unit name supplies the ids, overriding the environment', () => {
	const r = run({
		GITHUB_REPOSITORY: 'WolffM/x',
		GITHUB_RUN_ID: '42',
		JOB_METRICS_UNIT: 'jit-claw-1-hadoku_site-j100737935236-r33782079633-1788454896.service',
	});
	assert.equal(r.rows.length, 1);
	assert.equal(r.rows[0].runId, 33782079633, 'from the unit, not GITHUB_RUN_ID');
	assert.equal(r.rows[0].jobId, 100737935236);
	assert.equal(r.rows[0].kind, 'jit');
});

test('cpu-time fields are read from cpu.stat and never a bare empty string (P2.3)', () => {
	// cpu.stat is readable for any process on Linux, so — unlike io.stat, whose
	// controller may not be delegated to this leaf — this exercises the real
	// read path end to end rather than just the null contract.
	const r = run({ GITHUB_REPOSITORY: 'WolffM/x', GITHUB_RUN_ID: '1', RUNNER_NAME: 'n' });
	assert.equal(r.rows.length, 1);
	const row = r.rows[0];
	for (const key of ['cpuUsageUsec', 'cpuUserUsec', 'cpuSystemUsec']) {
		assert.ok(key in row, `${key} missing from the row`);
		assert.equal(
			typeof row[key],
			'number',
			`${key} must be a real number, not null, on any Linux box`
		);
		assert.ok(row[key] >= 0, `${key} must not be negative`);
	}
	// usage_usec is DOCUMENTED as user_usec+system_usec but not always exactly
	// that in practice: the kernel derives user/system via cputime_adjust's
	// proportional split of tick accounting, which can round to within ~1usec of
	// the total (observed live on this box). Kept independent rather than
	// derived, so a REAL disagreement (not rounding) would still show up.
	assert.ok(
		Math.abs(row.cpuUsageUsec - (row.cpuUserUsec + row.cpuSystemUsec)) <= 5,
		'usage_usec should track user+system to within kernel rounding, not diverge'
	);
});

test('io read/write bytes are always a number or null, never a bare empty string (P2.3)', () => {
	// io.stat's controller delegation is per-box and this test runs wherever the
	// suite runs, so it asserts the type contract rather than a specific value.
	// `runners-slice-install.sh` installs the delegation on a claw from
	// 2026-09-16, and `fleet slice --check` is what asserts it landed; a dev box
	// or a node that pass has not reached still has no io.stat, and absent must
	// stay null rather than become a job that did no io. Pinning a number here
	// would make this red everywhere except a converged claw.
	const r = run({ GITHUB_REPOSITORY: 'WolffM/x', GITHUB_RUN_ID: '1', RUNNER_NAME: 'n' });
	const row = r.rows[0];
	for (const key of ['ioReadBytes', 'ioWriteBytes']) {
		assert.ok(key in row, `${key} missing from the row`);
		assert.ok(row[key] === null || typeof row[key] === 'number', `${key} must be a number or null`);
	}
});

test('io.stat summing: per-device rbytes/wbytes are summed, not just the first device read', () => {
	// `base` is deliberately not overridable (see the script's own comment), so
	// this exercises the summing ALGORITHM directly rather than through the hook
	// — the same algorithm embedded in job-metrics.sh's `io_sum()`.
	const dir = mkdtempSync(join(tmpdir(), 'io-stat-'));
	try {
		const statFile = join(dir, 'io.stat');
		writeFileSync(
			statFile,
			[
				'8:0 rbytes=1226059776 wbytes=524288 rios=1234 wios=56 dbytes=0 dios=0',
				'253:0 rbytes=1000 wbytes=2000 rios=1 wios=1 dbytes=0 dios=0',
			].join('\n') + '\n'
		);
		const awkProg = `
			{ for (i=2;i<=NF;i++) { split($i,a,"="); if (a[1]==k) { sum+=a[2]; seen=1 } } }
			END { if (seen) printf "%d", sum; else print "" }
		`;
		const r = execFileSync('awk', ['-v', 'k=rbytes', awkProg, statFile], { encoding: 'utf8' });
		const w = execFileSync('awk', ['-v', 'k=wbytes', awkProg, statFile], { encoding: 'utf8' });
		assert.equal(r, '1226060776', "both devices' rbytes must be summed");
		assert.equal(w, '526288', "both devices' wbytes must be summed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('io.stat summing: an empty file (controller not delegated) yields null, not zero', () => {
	const dir = mkdtempSync(join(tmpdir(), 'io-stat-empty-'));
	try {
		const statFile = join(dir, 'io.stat');
		writeFileSync(statFile, '');
		const awkProg = `
			{ for (i=2;i<=NF;i++) { split($i,a,"="); if (a[1]==k) { sum+=a[2]; seen=1 } } }
			END { if (seen) printf "%d", sum; else print "" }
		`;
		// awk's `print ""` (the not-seen branch) still emits the record separator —
		// a trailing newline, same as the "seen" branch's `printf` would carry none.
		// The real script never sees the difference: `io_sum=$(...)` in job-metrics.sh
		// strips it, same as bash strips it here.
		const r = execFileSync('awk', ['-v', 'k=rbytes', awkProg, statFile], { encoding: 'utf8' });
		assert.equal(r.trim(), '', 'no device lines means no measurement, not a real zero');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// #28 — tmpfs is memory. The REAL cgroup half: memory.stat is served by the same
// controller as memory.peak, so a row existing at all proves memory was
// delegated to this leaf, which proves memory.stat was readable too. There is no
// box where a row can be written and these are null, so this asserts numbers
// rather than the weaker number-or-null contract io.stat gets.
test('shmem/file/anon are read from memory.stat on a real cgroup (#28)', () => {
	const r = run({ GITHUB_REPOSITORY: 'WolffM/x', GITHUB_RUN_ID: '1', RUNNER_NAME: 'n' });
	assert.equal(r.rows.length, 1);
	const row = r.rows[0];
	for (const key of ['shmemBytes', 'fileBytes', 'anonBytes']) {
		assert.ok(key in row, `${key} missing from the row`);
		assert.equal(
			typeof row[key],
			'number',
			`${key} must be a real number wherever memory.peak was readable`
		);
		assert.ok(row[key] >= 0, `${key} must not be negative`);
	}
});

// The arithmetic the header's measurement established, asserted as an invariant
// so a future edit cannot quietly turn the decomposition into an addition.
// Measured 2026-09-15: 200 MiB into /tmp moved memory.peak by 210,415,616 and
// memory.stat shmem by 209,715,200 — the peak ALREADY contains the tmpfs.
//
// WHY THIS HOLDS ON EITHER UNIT KIND, and what it is therefore worth (2026-09-16).
// `peak` is the high-water of `current`, and `current` at any instant contains
// `file`, which contains `shmem` — so `shmem <= file <= peak` is true whether
// the peak covers this job alone (jit) or the unit's whole life (standing).
// That also means it is WEAK evidence on a standing unit, where the peak is
// cumulative and may just be `limitBytes`: the inequality is satisfied
// trivially by a number that is not a measurement at all. It is kept because it
// still catches the thing it was written for — a decomposition turned into a
// sum — and the `peakBasis` tests below carry the part that says which reading
// a row holds. The decomposition fields themselves are instantaneous on every
// unit kind, so they are never in doubt.
test('memory.peak CONTAINS shmem — the fields decompose it, never add to it (#28)', () => {
	const r = run({ GITHUB_REPOSITORY: 'WolffM/x', GITHUB_RUN_ID: '1', RUNNER_NAME: 'n' });
	const row = r.rows[0];
	assert.ok(
		row.shmemBytes <= row.fileBytes,
		`shmem is a subset of file: ${row.shmemBytes} > ${row.fileBytes}`
	);
	assert.ok(
		row.fileBytes <= row.peakBytes,
		`file is charged to the same counter memory.peak high-waters: ${row.fileBytes} > ${row.peakBytes}`
	);
	// If a `residentPeakBytes` ever appears it must not be peak+shmem, which
	// would double-count the tmpfs. Today the sum IS peakBytes, so the field is
	// deliberately absent; see the script header.
	assert.ok(
		!('residentPeakBytes' in row),
		'residentPeakBytes would double-count: memory.peak already includes shmem'
	);
});

// The SYNTHETIC half. `base` is deliberately not overridable (see the script's
// own comment), so — exactly as the io.stat tests do — this drives the parsing
// algorithm embedded in job-metrics.sh's `field_str()` against a handwritten
// memory.stat, including the keys whose PREFIX collides with the ones we want.
test('memory.stat parsing: exact key match, and file >= shmem on a synthetic cgroup (#28)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'memory-stat-'));
	try {
		const statFile = join(dir, 'memory.stat');
		writeFileSync(
			statFile,
			[
				'anon 483328',
				'file 273068032',
				'kernel 8192000',
				'kernel_stack 131072',
				'slab 4194304',
				'sock 0',
				'shmem 268439552',
				'file_mapped 12288',
				'file_dirty 0',
				'anon_thp 0',
				'shmem_thp 0',
			].join('\n') + '\n'
		);
		const awkProg = '$1==k{print $2; found=1} END{if(!found)print ""}';
		const read = (k) =>
			execFileSync('awk', ['-v', `k=${k}`, awkProg, statFile], { encoding: 'utf8' }).trim();
		// `file_mapped` and `shmem_thp` must not be mistaken for `file`/`shmem`.
		assert.equal(read('shmem'), '268439552');
		assert.equal(read('file'), '273068032');
		assert.equal(read('anon'), '483328');
		assert.ok(Number(read('file')) >= Number(read('shmem')), 'file is the superset of shmem');
		// A kernel that does not report the key at all is "I could not look",
		// not a job that used zero tmpfs.
		assert.equal(read('swapcached'), '', 'an absent key yields null, never a real zero');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a unit name with no ids falls back to the environment and reads as standing', () => {
	const r = run({
		GITHUB_REPOSITORY: 'WolffM/x',
		GITHUB_RUN_ID: '7',
		JOB_METRICS_UNIT: 'actions-runner-hadoku_site.service',
	});
	assert.equal(r.rows[0].runId, 7);
	assert.equal(r.rows[0].jobId, null, 'a standing unit carries no job id');
	assert.equal(r.rows[0].kind, 'standing');
});

// ── peakBasis: the row says what its peak IS ───────────────────────────────
//
// A standing unit's `memory.peak` is a high-water since the unit last started,
// and the reset that was supposed to make it per-job never once took effect —
// writing `memory.peak` resets it only for the writing fd, and this hook's fd
// dies with the process (measured on claw-7 6.12.107 and hokon 6.12.101; see
// the script header). `warm-claw-7-hadoku_site.service` published 4,097 MB, its
// 4 GiB ceiling, on all 217 of its rows. These pin the label so a ceiling can
// never again be handed over looking like a measurement.

test('a JIT row declares peakBasis "job" — a fresh cgroup per mint', () => {
	const r = run({
		GITHUB_REPOSITORY: 'WolffM/x',
		JOB_METRICS_UNIT: 'jit-claw-1-hadoku_site-j100737935236-r33782079633-1788454896.service',
	});
	assert.equal(r.rows.length, 1);
	assert.equal(r.rows[0].kind, 'jit');
	assert.equal(r.rows[0].peakBasis, 'job');
});

test('a STANDING row declares peakBasis "unit-cumulative" — never this job alone', () => {
	// The bug this exists for: without the label a consumer reads peakBytes off a
	// warm unit as a per-job figure, percentiles it beside JIT rows, and reports
	// the cgroup ceiling as the workload's memory.
	const r = run({
		GITHUB_REPOSITORY: 'WolffM/x',
		JOB_METRICS_UNIT: 'warm-claw-7-hadoku_site.service',
	});
	assert.equal(r.rows.length, 1);
	assert.equal(r.rows[0].kind, 'standing');
	assert.equal(
		r.rows[0].peakBasis,
		'unit-cumulative',
		'a long-lived unit accumulates; the row must say so at the source'
	);
});

test('peakBasis never disagrees with kind, on any unit name', () => {
	// Derived from the same `kind` the cgroup leaf decided, so the two cannot
	// drift apart — a label that contradicted its own row would be worse than
	// none. `actions-runner-*` is the other standing shape on the fleet.
	for (const unit of [
		'jit-claw-3-hadoku-scraper-j1-r2-3.service',
		'actions-runner-hadoku_site.service',
		'warm-claw-1-hadoku-watchparty.service',
		'standing-runner.service',
	]) {
		const r = run({ GITHUB_REPOSITORY: 'WolffM/x', JOB_METRICS_UNIT: unit });
		const row = r.rows[0];
		assert.equal(
			row.peakBasis,
			row.kind === 'jit' ? 'job' : 'unit-cumulative',
			`${unit}: peakBasis ${row.peakBasis} contradicts kind ${row.kind}`
		);
	}
});

test('the no-op memory.peak reset is GONE and must not come back', () => {
	// Static, and deliberately so: the failure mode is a WRITE that succeeds and
	// changes nothing, which no behavioural test on this box can distinguish from
	// a write that worked — that is exactly how it survived from 2026-09-04 to
	// 2026-09-16. Reintroducing it would restore a guard that cannot fail, so the
	// source is the only place to catch it.
	const src = readFileSync(HOOK, 'utf8');
	const code = src
		.split('\n')
		.filter((l) => !l.trim().startsWith('#'))
		.join('\n');
	assert.doesNotMatch(
		code,
		/>\s*"?\$base\/memory\.peak/,
		'writing memory.peak resets it for the writing fd only — a hook cannot make it stick'
	);
	assert.doesNotMatch(code, /-w\s+"\$base\/memory\.peak"/, 'the always-true writability guard');
});

// ── wave 4c #102 lane C: the same host-load snapshot, recorded at job END ──
//
// job-metrics.sh (this hook) carries the four facts ci-throttle.sh prints at
// job START — see that script's header for why (wave4c-2026-10-07.md): slow
// reds are unattributable without knowing what else was on the box.
//
// `JOB_METRICS_PROC_ROOT` is the fixture seam for a co-tenant's `/proc/<pid>/cwd`
// — a fixture pid is a directory of symlinks, never a live process, the same
// pattern ci-throttle.test.mjs uses. The `pgrep` on PATH is a fixture binary
// that echoes `$HOST_LOAD_SELF_PID`, the hook's own exported self-pid, rather
// than a predicted kernel one — the hook exports it for exactly this.

/** A fixture `/proc` entry whose `cwd` resolves under `_work/<repo>/<repo>`. */
function procCotenant(root, pid, repo) {
	const target = join(root, 'fake-cwd', repo, '_work', repo, repo);
	mkdirSync(target, { recursive: true });
	mkdirSync(join(root, String(pid)), { recursive: true });
	symlinkSync(target, join(root, String(pid), 'cwd'));
}

/** A fake `pgrep` on its own PATH entry, echoing exactly the given pids (plus
 * `$HOST_LOAD_SELF_PID` unless told not to) — never the real process table. */
function stubPgrep(scratchDir, pids, { includeSelf = true } = {}) {
	const bin = mkdtempSync(join(scratchDir, 'pgrep-stub-'));
	const echoes = [...(includeSelf ? ['"$HOST_LOAD_SELF_PID"'] : []), ...pids.map((p) => `"${p}"`)];
	writeFileSync(join(bin, 'pgrep'), `#!/bin/sh\n${echoes.map((e) => `echo ${e}`).join('\n')}\n`, {
		mode: 0o755,
	});
	return bin;
}

test('host load: the metrics record carries all four values against a fixture /proc', () => {
	const dir = mkdtempSync(join(tmpdir(), 'job-metrics-hostload-'));
	try {
		const loadavg = join(dir, 'loadavg');
		writeFileSync(loadavg, '2.50 1.30 0.80 3/120 12345\n');
		const pressure = join(dir, 'pressure-cpu');
		writeFileSync(
			pressure,
			'some avg10=4.20 avg60=3.10 avg300=1.00 total=123456\n' +
				'full avg10=0.50 avg60=0.20 avg300=0.10 total=9999\n'
		);
		const procRoot = join(dir, 'proc');
		mkdirSync(procRoot, { recursive: true });
		procCotenant(procRoot, 9501, 'cardtable');
		procCotenant(procRoot, 9502, 'hadoku_site');
		const pgrepBin = stubPgrep(dir, [9501, 9502]);

		const r = run({
			GITHUB_REPOSITORY: 'WolffM/x',
			GITHUB_RUN_ID: '1',
			RUNNER_NAME: 'n',
			JOB_METRICS_LOADAVG: loadavg,
			JOB_METRICS_PRESSURE_CPU: pressure,
			JOB_METRICS_PROC_ROOT: procRoot,
			PATH: `${pgrepBin}:${process.env.PATH}`,
		});
		assert.equal(r.code, 0);
		assert.equal(r.rows.length, 1);
		const row = r.rows[0];
		assert.equal(row.hostLoad1m, 2.5);
		assert.equal(row.hostCpuPressureAvg10, 4.2);
		assert.equal(row.hostCoTenants, 2);
		assert.deepEqual([...row.hostCoTenantRepos].sort(), ['cardtable', 'hadoku_site']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('host load: an unreadable /proc/pressure/cpu becomes the STRING "unreadable", never null, and the hook still exits 0', () => {
	const r = run({
		GITHUB_REPOSITORY: 'WolffM/x',
		GITHUB_RUN_ID: '1',
		RUNNER_NAME: 'n',
		JOB_METRICS_PRESSURE_CPU: '/does/not/exist/pressure-cpu',
	});
	assert.equal(r.code, 0, 'an unreadable PSI file must never fail the job (ADR 1751)');
	assert.equal(r.rows[0].hostCpuPressureAvg10, 'unreadable');
});

test('host load: an unreadable /proc/loadavg becomes "unreadable", not a guessed 0', () => {
	const r = run({
		GITHUB_REPOSITORY: 'WolffM/x',
		GITHUB_RUN_ID: '1',
		RUNNER_NAME: 'n',
		JOB_METRICS_LOADAVG: '/does/not/exist/loadavg',
	});
	assert.equal(r.code, 0);
	assert.equal(r.rows[0].hostLoad1m, 'unreadable');
});

test('host load: co-tenants are counted EXCLUDING the job itself', () => {
	const dir = mkdtempSync(join(tmpdir(), 'job-metrics-hostload-self-'));
	try {
		const procRoot = join(dir, 'proc');
		mkdirSync(procRoot, { recursive: true });
		procCotenant(procRoot, 9601, 'cardtable');
		procCotenant(procRoot, 9602, 'cardtable');
		// Echoes $HOST_LOAD_SELF_PID (the real value this run computed) alongside
		// the two fixture co-tenants. If self-exclusion regressed, the count
		// would read 3.
		const pgrepBin = stubPgrep(dir, [9601, 9602]);

		const r = run({
			GITHUB_REPOSITORY: 'WolffM/x',
			GITHUB_RUN_ID: '1',
			RUNNER_NAME: 'n',
			JOB_METRICS_PROC_ROOT: procRoot,
			PATH: `${pgrepBin}:${process.env.PATH}`,
		});
		assert.equal(r.code, 0);
		assert.equal(r.rows[0].hostCoTenants, 2, 'self must not be counted as a co-tenant');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('host load: zero co-tenants is hostCoTenantRepos: [], never guessed, never "unreadable"', () => {
	const dir = mkdtempSync(join(tmpdir(), 'job-metrics-hostload-zero-'));
	try {
		const pgrepBin = stubPgrep(dir, [], { includeSelf: false });
		const r = run({
			GITHUB_REPOSITORY: 'WolffM/x',
			GITHUB_RUN_ID: '1',
			RUNNER_NAME: 'n',
			PATH: `${pgrepBin}:${process.env.PATH}`,
		});
		assert.equal(r.code, 0);
		assert.equal(r.rows[0].hostCoTenants, 0);
		assert.deepEqual(r.rows[0].hostCoTenantRepos, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('host load: no pgrep on PATH at all reads "unreadable", not zero', () => {
	const dir = mkdtempSync(join(tmpdir(), 'job-metrics-hostload-nopgrep-'));
	try {
		// A PATH with nothing named pgrep on it — standard coreutils only. A
		// genuinely missing pgrep must read as "could not look", never as a
		// confident zero co-tenants.
		const bin = mkdtempSync(join(dir, 'minimal-bin-'));
		for (const tool of [
			'bash',
			'sh',
			'awk',
			'sed',
			'cat',
			'cut',
			'head',
			'date',
			'hostname',
			'mkdir',
			'tr',
			'id',
			'basename',
		]) {
			const real = join('/usr/bin', tool);
			if (existsSync(real)) symlinkSync(real, join(bin, tool));
		}
		const r = run({
			GITHUB_REPOSITORY: 'WolffM/x',
			GITHUB_RUN_ID: '1',
			RUNNER_NAME: 'n',
			PATH: bin,
		});
		assert.equal(r.code, 0);
		assert.equal(r.rows[0].hostCoTenants, 'unreadable');
		assert.equal(r.rows[0].hostCoTenantRepos, 'unreadable');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
