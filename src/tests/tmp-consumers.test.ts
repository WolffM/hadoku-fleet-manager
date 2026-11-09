/**
 * `runners/tmp-consumers.ts`: the /tmp consumer probe, run for real through
 * `bash -c` against a fixture directory standing in for /tmp — the same
 * script production sends to a node, so `find`/`du`/`sort` are what is under
 * test, not a model of them.
 *
 * The 2026-11-08 shape: a Claude session scratchpad holding fresh multi-GB
 * copies, beside an old leftover the previous hint (`-mmin +60`) would have
 * named instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	formatTmpConsumers,
	parseTmpConsumers,
	runTmpConsumerProbe,
	tmpConsumersCmd,
	TMP_CONSUMER_ALERT_LINES,
} from '../runners/tmp-consumers.js';
import { tempDir } from './tmpdir.js';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** A file of `bytes` apparent size, sparse — `find -size` reads st_size. */
function sparse(path: string, bytes: number): void {
	writeFileSync(path, '');
	truncateSync(path, bytes);
}

/**
 * Backdate `path` by `ageS` from its OWN mtime. `find -mmin` and the probe's
 * `date +%s` read the real clock, and fixture-clock-guard runs this suite with
 * `Date` shifted forward — so a mtime derived from `Date.now()` would land
 * days in the future of the clock the script actually reads.
 */
function backdate(path: string, ageS: number): void {
	const t = statSync(path).mtimeMs / 1000 - ageS;
	utimesSync(path, t, t);
}

/** A file of `bytes` REAL blocks — `du` reads allocation. */
function real(path: string, bytes: number): void {
	writeFileSync(path, Buffer.alloc(bytes, 1));
}

function fixture(): { root: string; scratch: string } {
	const root = tempDir('tmp-consumers-');
	const scratch = join(root, 'claude-4242', '-home-op-repos', 'sess-a', 'scratchpad');
	mkdirSync(scratch, { recursive: true });
	return { root, scratch };
}

test('probe: names large RECENT files, largest first, and skips old and small ones', async () => {
	const { root, scratch } = fixture();
	sparse(join(scratch, 'copy-1.sqlite'), Math.round(2.4 * GB));
	sparse(join(root, 'tmpab12cd.db'), Math.round(1.1 * GB));
	sparse(join(root, 'old-leftover.bin'), 3 * GB);
	backdate(join(root, 'old-leftover.bin'), 6 * 3600);
	sparse(join(root, 'small.log'), 10 * MB);

	const r = await runTmpConsumerProbe('bash', ['-c', tmpConsumersCmd(root)]);
	assert.ok(r.ok, r.ok ? '' : r.why);
	assert.deepEqual(
		r.consumers.files.map((f) => f.path),
		[join(scratch, 'copy-1.sqlite'), join(root, 'tmpab12cd.db')],
		'the 6h-old 3GB file is not "filling it now", and 10MB is noise'
	);
	assert.equal(r.consumers.files[0]!.bytes, Math.round(2.4 * GB));
	assert.ok(r.consumers.files[0]!.ageS < 120, `just written: ${r.consumers.files[0]!.ageS}s`);
});

test('probe: ranks Claude session dirs by real size, with the newest write inside each', async () => {
	const { root, scratch } = fixture();
	const other = join(root, 'claude-4242', '-home-op-repos', 'sess-b');
	mkdirSync(other, { recursive: true });
	real(join(scratch, 'big.sqlite'), 3 * MB);
	real(join(other, 'notes.txt'), 1 * MB);
	backdate(join(other, 'notes.txt'), 3 * 3600);

	const r = await runTmpConsumerProbe('bash', ['-c', tmpConsumersCmd(root)]);
	assert.ok(r.ok, r.ok ? '' : r.why);
	const sessions = r.consumers.sessions;
	assert.deepEqual(
		sessions.map((s) => s.path),
		[join(root, 'claude-4242', '-home-op-repos', 'sess-a'), other]
	);
	assert.ok(sessions[0]!.bytes >= 3 * MB, `du counts the session: ${sessions[0]!.bytes}`);
	assert.ok(sessions[0]!.ageS < 120, 'sess-a was written just now');
	assert.ok(
		sessions[1]!.ageS >= 3 * 3600 - 5,
		`sess-b's newest file is 3h old: ${sessions[1]!.ageS}`
	);
});

test('probe: an empty /tmp is an empty answer, not a failure', async () => {
	const root = tempDir('tmp-consumers-empty-');
	const r = await runTmpConsumerProbe('bash', ['-c', tmpConsumersCmd(root)]);
	assert.ok(r.ok, r.ok ? '' : r.why);
	assert.deepEqual(r.consumers, { files: [], sessions: [] });
	assert.deepEqual(formatTmpConsumers(r.consumers), []);
});

test('probe: a command that does not run the script is a failure that says why', async () => {
	const failed = await runTmpConsumerProbe('bash', ['-c', 'echo nope >&2; exit 3']);
	assert.equal(failed.ok, false);
	assert.match(failed.ok ? '' : failed.why, /nope/);

	const silent = await runTmpConsumerProbe('bash', ['-c', 'true']);
	assert.equal(silent.ok, false, 'no N line: the script never ran — not "nothing found"');
	assert.match(silent.ok ? '' : silent.why, /nothing parseable/);
});

test('parse: tolerates a session with no readable file (unknown age), and tabs in paths', () => {
	const c = parseTmpConsumers(
		'N\t1000\nF\t2147483648\t900.5\t/tmp/a\tb\nS\t204800\t\t/tmp/claude-1/p/s\ngarbage\n'
	);
	assert.deepEqual(c, {
		files: [{ path: '/tmp/a\tb', bytes: 2 * GB, ageS: 100 }],
		sessions: [{ path: '/tmp/claude-1/p/s', bytes: 200 * MB, ageS: -1 }],
	});
	assert.equal(parseTmpConsumers(''), null);
});

test('format: sessions and files ranked together, files inside a listed session folded in, bounded', () => {
	const s = '/tmp/claude-1/p/sess';
	const lines = formatTmpConsumers({
		sessions: [
			{ path: s, bytes: 9.6 * GB, ageS: 1800 },
			{ path: '/tmp/claude-1/p/tiny', bytes: 4 * MB, ageS: 60 },
		],
		files: [
			{ path: `${s}/scratchpad/copy-1.sqlite`, bytes: 2.4 * GB, ageS: 1800 },
			{ path: '/tmp/tmpab12/copy.db', bytes: 2.4 * GB, ageS: 7200 },
			...[1, 2, 3, 4, 5].map((i) => ({ path: `/tmp/f${i}`, bytes: i * 600 * MB, ageS: 300 })),
		],
	});
	assert.equal(lines.length, TMP_CONSUMER_ALERT_LINES);
	assert.equal(lines[0], `• \`${s}\` 9.6GB, last written 30m ago (claude session)`);
	assert.ok(!lines.some((l) => l.includes('copy-1.sqlite')), 'already counted in its session');
	assert.ok(!lines.some((l) => l.includes('tiny')), 'a 4MB session is not a consumer');
	assert.ok(lines.some((l) => l === '• `/tmp/tmpab12/copy.db` 2.4GB, last written 2h ago (file)'));
});
