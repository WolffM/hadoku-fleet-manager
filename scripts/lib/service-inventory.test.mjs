/**
 * THE WRITER MUST NOT DESTROY THE LEDGER IT SHARES.
 *
 * `fleet service-inventory --write` appends a second CLASS to a file four other
 * gates already read. The failure mode that matters is not a wrong number — it
 * is a rewrite that silently drops CI demand, which is exactly what
 * `fleet tool-inventory --write` does to resident rows today (measured; see
 * `docs/planning/service-ledger-2026-09-10.md` §3). So the merge is tested for
 * both halves: resident rows are replaced rather than duplicated, and every
 * other line survives byte-for-byte.
 *
 * The second thing asserted here is that an unmeasured column cannot be faked.
 * `{unmeasured:""}`, `null`, a bare string and a negative number are each
 * refused, because a reader that coerces any of them to 0 has converted
 * "I could not look" into "nothing is wrong" — the rule CLAUDE.md opens with.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	RESIDENT_CLASS,
	descendantPids,
	durationStats,
	egressClassFor,
	flattenCronProfiles,
	isMeasured,
	mergeResidentRows,
	millicores,
	parseCpuStatUsec,
	parseCronRuns,
	parseSsSockets,
	rowKey,
	sumColumn,
	unmeasured,
	validateResidentRow,
} from './service-inventory.mjs';

const prov = {
	at: '2026-09-10T00:00:00.000Z',
	by: 'fleet service-inventory',
	host: 'hokon',
	sources: ['pm2 jlist'],
	scope: 'per-service',
};

const row = (over = {}) => ({
	class: RESIDENT_CLASS,
	kind: 'pm2',
	name: 'mgmt-api',
	host: 'hokon',
	ram: 1000,
	cpu: 5,
	disk: 2000,
	net: 10,
	gpu: 0,
	provenance: prov,
	...over,
});

// --- shape -----------------------------------------------------------------

void test('a fully measured row validates, and 0 is a measurement', () => {
	const r = validateResidentRow(row({ gpu: 0 }));
	assert.equal(r.gpu, 0);
	assert.ok(isMeasured(r.gpu), '0 must read as measured, not as absent');
});

void test('an explicit unmeasured column validates and carries its reason', () => {
	const r = validateResidentRow(row({ net: unmeasured('ss -tinp could not be read') }));
	assert.equal(r.net.unmeasured, 'ss -tinp could not be read');
	assert.equal(isMeasured(r.net), false);
});

void test('unmeasured() refuses an empty reason — a shrug is not a finding', () => {
	assert.throws(() => unmeasured(''), /non-empty reason/);
	assert.throws(() => unmeasured('   '), /non-empty reason/);
	assert.throws(() => unmeasured(undefined), /non-empty reason/);
});

void test('every shape that could be coerced to zero is refused', () => {
	for (const bad of [
		null,
		undefined,
		'unknown',
		{},
		{ unmeasured: '' },
		{ unmeasured: 7 },
		NaN,
		-1,
	]) {
		assert.throws(
			() => validateResidentRow(row({ ram: bad })),
			/ram/,
			`ram=${JSON.stringify(bad)} must be refused`
		);
	}
});

void test('class, kind, name, host and provenance are each required', () => {
	assert.throws(() => validateResidentRow(row({ class: 'ci' })), /class must be "resident"/);
	assert.throws(() => validateResidentRow(row({ kind: 'service' })), /kind must be one of/);
	assert.throws(() => validateResidentRow(row({ name: '' })), /name is required/);
	assert.throws(() => validateResidentRow(row({ host: '  ' })), /host is required/);
	assert.throws(
		() => validateResidentRow(row({ provenance: undefined })),
		/provenance is required/
	);
	assert.throws(
		() => validateResidentRow(row({ provenance: { ...prov, sources: [] } })),
		/at least one kernel\/supervisor source/
	);
	assert.throws(
		() => validateResidentRow(row({ provenance: { ...prov, scope: 'whole-box' } })),
		/scope must be/
	);
});

void test('sumColumn refuses a partial total and names the rows that blocked it', () => {
	const rows = [row({ name: 'a', ram: 10 }), row({ name: 'b', ram: 20 })];
	assert.equal(sumColumn(rows, 'ram'), 30);
	rows.push(row({ name: 'c', ram: unmeasured('in-process') }));
	const partial = sumColumn(rows, 'ram');
	assert.equal(isMeasured(partial), false);
	assert.match(partial.unmeasured, /pm2\/c/);
	assert.match(partial.unmeasured, /1 of 3/);
});

// --- merge -----------------------------------------------------------------

const ciLine = (job) =>
	JSON.stringify({
		class: 'ci',
		repo: 'WolffM/hadoku_site',
		job,
		fleetForm: true,
		selfHosted: true,
	});
const legacyLine = JSON.stringify({ repo: 'WolffM/old', job: 'build', capabilities: ['gh'] });

void test('every non-resident line survives a merge byte-for-byte, in order', () => {
	const existing = `${ciLine('deploy')}\n${legacyLine}\n${ciLine('check')}\n`;
	const { text, kept, replaced } = mergeResidentRows(existing, [row()], 'hokon');
	const lines = text.trim().split('\n');
	assert.equal(kept, 3);
	assert.equal(replaced, 0);
	assert.deepEqual(lines.slice(0, 3), [ciLine('deploy'), legacyLine, ciLine('check')]);
	assert.equal(JSON.parse(lines[3]).name, 'mgmt-api');
});

void test('a re-run REPLACES its own resident rows — never a duplicate', () => {
	const existing = ciLine('deploy');
	const first = mergeResidentRows(existing, [row(), row({ name: 'tunnel' })], 'hokon');
	assert.equal(first.text.trim().split('\n').length, 3);

	const second = mergeResidentRows(first.text, [row(), row({ name: 'tunnel' })], 'hokon');
	assert.equal(second.replaced, 2, 'both prior resident rows must be replaced');
	assert.equal(second.text, first.text, 'a re-run with identical input is byte-identical');

	const third = mergeResidentRows(second.text, [row()], 'hokon');
	assert.equal(third.text.trim().split('\n').length, 2, 'a row that went away must not linger');
	assert.equal(third.kept, 1);
});

void test("another node's resident rows are left alone", () => {
	const other = JSON.stringify({ ...row({ host: 'claw-3' }) });
	const { text, kept, replaced } = mergeResidentRows(`${other}\n`, [row()], 'hokon');
	assert.equal(kept, 1, "claw-3's row is not hokon's to replace");
	assert.equal(replaced, 0);
	assert.ok(text.includes('"host":"claw-3"'));
});

void test('an unparseable existing line THROWS rather than being dropped', () => {
	assert.throws(
		() => mergeResidentRows(`${ciLine('deploy')}\nnot json\n`, [row()], 'hokon'),
		/line 2 is not JSON/
	);
});

void test('a duplicate key in one batch throws — the key is (class, kind, name, host)', () => {
	assert.throws(() => mergeResidentRows('', [row(), row()], 'hokon'), /duplicate resident row/);
	assert.equal(rowKey(row()), rowKey(row({ ram: 99 })));
	assert.notEqual(rowKey(row()), rowKey(row({ kind: 'cron' })));
});

void test('a row for a different host than the merge target throws', () => {
	assert.throws(
		() => mergeResidentRows('', [row({ host: 'claw-3' })], 'hokon'),
		/is for host claw-3/
	);
});

// --- egress classification --------------------------------------------------

const spec = {
	ecosystemRoot: 'srv/hadoku_site',
	hokonLocal: [
		{ app: 'jd-clipboard-watch', class: 'hokon-local' },
		{ app: 'pm2-logrotate', class: 'platform' },
	],
};

void test('pm_cwd is a PREFIX — a nested service is ecosystem, not unknown', () => {
	assert.equal(
		egressClassFor('mgmt-api', '/home/hadoku/srv/hadoku_site/services/mgmt-api', spec),
		'ecosystem'
	);
	assert.equal(egressClassFor('tunnel', '/home/hadoku/srv/hadoku_site', spec), 'ecosystem');
});

void test('a declared hokon-local app keeps its declared class, and an unlisted one is unclassified', () => {
	assert.equal(egressClassFor('jd-clipboard-watch', '/home/hadoku', spec), 'hokon-local');
	assert.equal(egressClassFor('pm2-logrotate', '/home/hadoku/.pm2/modules', spec), 'platform');
	assert.equal(egressClassFor('brand-new-app', '/home/hadoku/whatever', spec), 'unclassified');
	assert.equal(egressClassFor('no-cwd', null, spec), 'unclassified');
});

// --- process tree -----------------------------------------------------------

void test('a subtree includes every descendant, because the wrapper is not the work', () => {
	// pm2 forks `tunnel` (10), which spawns cloudflared (11), which spawns a helper (12).
	const ppids = new Map([
		[1, 0],
		[10, 1],
		[11, 10],
		[12, 11],
		[20, 1],
	]);
	assert.deepEqual(
		descendantPids(10, ppids).sort((a, b) => a - b),
		[10, 11, 12]
	);
	assert.deepEqual(descendantPids(20, ppids), [20]);
});

// --- kernel parsers ---------------------------------------------------------

void test("ss output is summed per pid across that pid's sockets", () => {
	const text = [
		'State Recv-Q Send-Q Local Peer Process',
		'ESTAB 0 0 127.0.0.1:1 127.0.0.1:2 users:(("node",pid=7,fd=20))',
		'\t cubic bytes_sent:100 bytes_acked:100 bytes_received:50 segs_out:3',
		'ESTAB 0 0 127.0.0.1:3 127.0.0.1:4 users:(("node",pid=7,fd=21))',
		'\t cubic bytes_sent:1 bytes_received:2',
		'ESTAB 0 0 127.0.0.1:5 127.0.0.1:6',
		'\t cubic bytes_sent:999 bytes_received:999',
	].join('\n');
	const byPid = parseSsSockets(text);
	assert.deepEqual(byPid.get(7), { bytes: 153, sockets: 2 });
	assert.equal(
		byPid.size,
		1,
		'a socket with no owning pid is attributed to nobody, not to the last pid seen'
	);
});

void test('cpu.stat without usage_usec throws — a cgroup read that says nothing is not a zero', () => {
	assert.equal(parseCpuStatUsec('nr_periods 0\nusage_usec 1234\nuser_usec 1'), 1234);
	assert.throws(() => parseCpuStatUsec('nr_periods 0\n'), /no usage_usec/);
});

void test('millicores: 1000 is one core saturated, and a zero window throws', () => {
	assert.equal(millicores(1_000_000, 1000), 1000);
	assert.equal(millicores(500_000, 1000), 500);
	assert.equal(millicores(0, 1000), 0);
	assert.throws(() => millicores(1000, 0), /positive window/);
});

// --- cron -------------------------------------------------------------------

const cronLog = [
	"2026-09-10 09:30:00,000 INFO temporalio.activity execute_job ci:queue-health (http) ({'attempt': 1})",
	'2026-09-10 09:30:08,500 INFO httpx HTTP Request: POST http://127.0.0.1:4000/api/cron/run/ci:queue-health "HTTP/1.1 200 OK"',
	"2026-09-10 09:40:00,000 INFO temporalio.activity execute_job ci:queue-health (http) ({'attempt': 1})",
	'2026-09-10 09:40:02,000 INFO httpx HTTP Request: POST http://127.0.0.1:4000/api/cron/run/ci:queue-health "HTTP/1.1 500 Internal Server Error"',
	"2026-09-10 09:50:00,000 INFO temporalio.activity execute_job ci:drain-enforced (http) ({'attempt': 1})",
].join('\n');

void test("a cron job's duration is MEASURED from the worker log, not declared", () => {
	const { runs } = parseCronRuns(cronLog);
	const stats = durationStats(runs.get('ci:queue-health'));
	assert.equal(stats.runs, 2);
	assert.equal(stats.maxSec, 8.5);
	assert.equal(stats.p50Sec, 2);
	assert.equal(stats.nonOkRuns, 1, 'a 500 is a run that happened, counted and flagged');
});

void test('a dispatch with no completion is an OPEN run, never a zero-duration success', () => {
	const { runs, openDispatches } = parseCronRuns(cronLog);
	assert.equal(runs.has('ci:drain-enforced'), false);
	assert.equal(openDispatches.get('ci:drain-enforced'), 1);
	assert.equal(durationStats(runs.get('ci:drain-enforced')), null);
});

const START = (t, name) =>
	`${t} INFO temporalio.activity execute_job ${name} (http) ({'attempt': 1})`;
const END = (t, name, code = '200 OK') =>
	`${t} INFO httpx HTTP Request: POST http://127.0.0.1:4000/api/cron/run/${name} "HTTP/1.1 ${code}"`;

void test('ONE unlogged dispatch costs one run, not every run after it', () => {
	// THE MEASURED BUG. Two `ci:drain-enforced` dispatches (09-07, 09-08) never
	// logged a completion. A FIFO queue then handed every later completion a
	// start two ten-minute cycles too old, and the job reported p50 1,199 s
	// against a 60 s timeout across 497 runs. Every one of them was wrong, and it
	// read as a plausible overrun.
	const log = [
		START('2026-09-10 10:00:00,000', 'ci:drain-enforced'), // never completes
		START('2026-09-10 10:10:00,000', 'ci:drain-enforced'),
		END('2026-09-10 10:10:00,100', 'ci:drain-enforced'),
		START('2026-09-10 10:20:00,000', 'ci:drain-enforced'),
		END('2026-09-10 10:20:00,090', 'ci:drain-enforced'),
	].join('\n');

	const { runs, abandonedDispatches, openDispatches } = parseCronRuns(log);
	const stats = durationStats(runs.get('ci:drain-enforced'));
	assert.equal(stats.runs, 2);
	assert.equal(
		stats.maxSec,
		0.1,
		'a completion belongs to the MOST RECENT dispatch, not the oldest'
	);
	assert.equal(
		abandonedDispatches.get('ci:drain-enforced'),
		1,
		'the unlogged dispatch is reported, not recycled'
	);
	assert.equal(openDispatches.get('ci:drain-enforced'), undefined);
});

void test('a run split across a log ROTATION survives files read out of chronological order', () => {
	// `readdirSync` hands the live `cron-worker-error.log` before the seven dated
	// ones (measured 2026-09-10), so a run whose dispatch is at the tail of an
	// older file and whose completion is at the head of the live one arrives
	// completion-first.
	const olderTail = [
		START('2026-09-10 10:00:00,000', 'ci:queue-health'),
		END('2026-09-10 10:00:00,100', 'ci:queue-health'),
		START('2026-09-10 10:10:00,000', 'ci:queue-health'), // rotation cuts here
	].join('\n');
	const liveHead = [
		END('2026-09-10 10:10:00,100', 'ci:queue-health'),
		START('2026-09-10 10:20:00,000', 'ci:queue-health'),
		END('2026-09-10 10:20:00,100', 'ci:queue-health'),
	].join('\n');

	const scrambled = parseCronRuns(`${liveHead}\n${olderTail}\n`);
	assert.equal(
		durationStats(scrambled.runs.get('ci:queue-health')).runs,
		3,
		'all three runs must be found'
	);
	assert.equal(scrambled.orphanCompletions.size, 0, 'no completion may be orphaned by read order');
	assert.equal(scrambled.openDispatches.size, 0, 'no dispatch may be left open by read order');
	assert.deepEqual(
		durationStats(scrambled.runs.get('ci:queue-health')),
		durationStats(parseCronRuns(`${olderTail}\n${liveHead}\n`).runs.get('ci:queue-health'))
	);
});

void test('a completion whose dispatch predates the retained logs is an orphan, not a run', () => {
	const { runs, orphanCompletions } = parseCronRuns(
		END('2026-09-10 10:00:00,100', 'ci:queue-health')
	);
	assert.equal(runs.size, 0, 'an unpaired completion is not a measured run');
	assert.equal(orphanCompletions.get('ci:queue-health'), 1);
});

void test('a privileged job whose ROUTE segment differs from its name still reports runs', () => {
	// `execute_job datastore:backup` then POST /privileged/run/datastore-backup.
	const log = [
		"2026-09-10 08:00:00,000 INFO temporalio.activity execute_job datastore:backup (http) ({'attempt': 1})",
		'2026-09-10 08:00:03,000 INFO httpx HTTP Request: POST http://127.0.0.1:4000/api/cron/privileged/run/datastore-backup "HTTP/1.1 200 OK"',
	].join('\n');

	const unmapped = parseCronRuns(log);
	assert.equal(
		unmapped.runs.has('datastore:backup'),
		false,
		'without the mapping the run is invisible'
	);
	assert.equal(
		unmapped.openDispatches.get('datastore:backup'),
		1,
		'and it shows as an open dispatch'
	);

	const mapped = parseCronRuns(log, new Map([['datastore-backup', 'datastore:backup']]));
	assert.equal(durationStats(mapped.runs.get('datastore:backup')).maxSec, 3);
	assert.equal(mapped.openDispatches.size, 0);
});

void test('cron profiles flatten to one entry per JOB, carrying cadence, timeout and route', () => {
	const jobs = flattenCronProfiles({
		profiles: [
			{
				name: 'fleet-pulse',
				schedule: { cron: '*/10 * * * *', timezone: 'Etc/UTC', overlap: 'skip' },
				jobs: [
					{
						name: 'ci:queue-health',
						executor: 'http',
						timeout_s: 120,
						http: { url: 'http://127.0.0.1:4000/api/cron/run/ci:queue-health', method: 'POST' },
					},
				],
			},
		],
	});
	assert.equal(jobs.length, 1);
	assert.deepEqual(
		{
			profile: jobs[0].profile,
			cron: jobs[0].cron,
			timeoutSec: jobs[0].timeoutSec,
			method: jobs[0].method,
		},
		{ profile: 'fleet-pulse', cron: '*/10 * * * *', timeoutSec: 120, method: 'POST' }
	);
	assert.equal(jobs[0].route, 'http://127.0.0.1:4000/api/cron/run/ci:queue-health');
});

void test('a job name in two profiles throws — the ledger key would silently overwrite one', () => {
	assert.throws(
		() =>
			flattenCronProfiles({
				profiles: [
					{ name: 'a', jobs: [{ name: 'dup' }] },
					{ name: 'b', jobs: [{ name: 'dup' }] },
				],
			}),
		/appears in both "a" and "b"/
	);
});

void test('zero cron jobs is a FAILURE, not a clean box', () => {
	assert.throws(() => flattenCronProfiles({ profiles: [] }), /ZERO cron jobs/);
	assert.throws(() => flattenCronProfiles({}), /ZERO cron jobs/);
});
