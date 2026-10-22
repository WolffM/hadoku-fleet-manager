/**
 * THE TABLE MUST DESCRIBE ONE DISK PER COLUMN.
 *
 * `fleet benchmark` prints a `root disk` row resolved from `mountpoints` — the
 * device `/` is actually on — and printed `disk hours` / `disk realloc` from
 * the FIRST `disk.*` key in enumeration order, which is `/sys/block/*` in
 * alphabetical order and so `sda` on every box. On any machine whose root is
 * not the first disk, those three rows described two different drives in one
 * column with nothing saying so.
 *
 * claw-9 is the live case and the fixture below is its real layout, measured
 * 2026-09-24: root is `sdb`, a 240G WD Green SSD, 29888 hours, 7 reallocated
 * sectors; `sda` is a 1TB WD Blue spinner, 31450 hours, 0 reallocated. The
 * pre-fix table printed the SSD's model beside the spinner's 31450 and 0 — so
 * the root disk's 7 reallocs were invisible and its age was overstated by
 * 1562 hours. A wave brief read that column as one drive and called a failing
 * disk on the strength of it.
 *
 * WHY THIS DRIVES THE REAL CLI RATHER THAN IMPORTING THE ROW FUNCTIONS.
 * `benchmark-fleet.mjs`'s CLI body is wrapped in `main()`, run only when the
 * file is the process entry point (wave 3x, so `--cadence`'s pure orchestrator
 * could be imported — see below) — but the table, `--from` and `--write`
 * behaviour are cheapest to prove end-to-end, driving the real CLI with
 * `--from <capture>`: it ingests a hand-taken capture through the same
 * `parse()` and `inventoryEntry()` a measured node goes through, so a fixture
 * is indistinguishable from a real node and the thing under test is the
 * rendered table an operator reads, not a function lifted out of it.
 *
 * `--cadence` is different: proving it needs to fake a drain/undrain/busy
 * cycle, and nothing safely fakes ssh from outside the process. So its tests
 * import `runCadence`/`cadenceBands` directly and inject fixtures — the same
 * division `refresh-cycle.test.mjs` draws for `runRefreshCycle`.
 *
 * Nothing here touches the real fleet, the real manifest or the real state
 * dir: `FLEET_MANIFEST_DIR` and `HADOKU_STATE_DIR` are pointed at temp trees
 * for every run, and no node is ever contacted.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
	cadenceBands,
	CADENCE_MEASURE_TIMEOUT_MS,
	cadenceSignalHandler,
	CADENCE_WAIT_TIMEOUT_MS,
	CADENCE_WORST_CASE_MS,
	degradedFinding,
	dueNodes,
	runCadence,
} from './benchmark-fleet.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLI = join(HERE, 'benchmark-fleet.mjs');

/**
 * claw-9 as measured: root on `sdb`, which is NOT the first disk enumerated.
 *
 * `overrides` replaces or adds single keys so a test can state the one fact it
 * is about. A key set to `null` is dropped, which is how "this drive reports
 * no duplex at all" is expressed.
 */
function claw9Capture(overrides = {}) {
	const base = {
		hostname: 'claw-9',
		uptimeSec: '864000',
		'cpu.model': 'AMD Ryzen 5 1600',
		'cpu.cores': '6',
		'cpu.threads': '12',
		'mem.totalKb': '16318664',
		// sda FIRST, and it is not the root disk. This ordering is the whole
		// point of the fixture — reverse it and the bug cannot be seen.
		'disk.sda.sizeBytes': '1000204886016',
		'disk.sda.rotational': '1',
		'disk.sda.model': 'WDC WD10EZEX-08WN4A0',
		'disk.sda.scheduler': 'mq-deadline',
		'disk.sda.mountpoints': 'none',
		'disk.sda.kind': 'ata',
		'disk.sda.smartHealth': 'PASSED',
		'disk.sda.powerOnHours': '31450',
		'disk.sda.reallocated': '0',
		'disk.sda.pendingSectors': '0',
		'disk.sda.tempC': '34',
		'disk.sdb.sizeBytes': '240057409536',
		'disk.sdb.rotational': '0',
		'disk.sdb.model': 'WDC WDS240G2G0A-00JH30',
		'disk.sdb.scheduler': 'mq-deadline',
		'disk.sdb.mountpoints': '/,[SWAP]',
		'disk.sdb.kind': 'ata',
		'disk.sdb.smartHealth': 'PASSED',
		'disk.sdb.powerOnHours': '29888',
		'disk.sdb.reallocated': '7',
		'disk.sdb.pendingSectors': '0',
		'disk.sdb.tempC': '27',
		// The wired port is down and the box runs on wifi — claw-1's shape, and
		// the reason `linkSpeed` stopped being a first-match read.
		'net.enp3s0.carrier': '0',
		'net.enp3s0.linkSpeed': '100',
		'net.enp3s0.duplex': 'half',
		'net.wlp2s0.carrier': '1',
		'net.wlp2s0.linkSpeed': '1000Mb/s',
		'net.wlp2s0.duplex': 'full',
	};
	const merged = { ...base, ...overrides };
	const lines = Object.entries(merged)
		.filter(([, v]) => v !== null)
		.map(([k, v]) => `${k} ${v}`);
	return ['BENCH-BEGIN v1', ...lines, 'BENCH-END'].join('\n') + '\n';
}

/**
 * Run the CLI with stdout and stderr going to FILES, never a pipe.
 *
 * A pipe on this host delivers 8 KB from a script that prints and then calls
 * `process.exit`, and a `--json` payload carrying raw records crosses that
 * easily — a parse error "at position 8192" is the cliff, not the script. The
 * byte count comes back with the output so a test can say which it measured.
 */
function runCli(args, { env = {}, scratch }) {
	const outPath = join(scratch, `out-${process.hrtime.bigint()}.txt`);
	const errPath = `${outPath}.err`;
	const out = openSync(outPath, 'w');
	const err = openSync(errPath, 'w');
	let status = 0;
	try {
		execFileSync(process.execPath, [CLI, ...args], {
			cwd: ROOT,
			env: { ...process.env, ...env },
			stdio: ['ignore', out, err],
			timeout: 60000,
		});
	} catch (e) {
		// A numeric status means the CLI RAN and chose to exit non-zero, which is
		// a normal outcome here (`--json` findings exit 1 by contract). Anything
		// else means it never started, and that is not a result to assert on.
		if (typeof e.status !== 'number') throw e;
		status = e.status;
	} finally {
		closeSync(out);
		closeSync(err);
	}
	return {
		status,
		stdout: readFileSync(outPath, 'utf8'),
		stderr: readFileSync(errPath, 'utf8'),
		bytes: statSync(outPath).size,
	};
}

/** A temp manifest + state dir, so no run can read or write the real ones. */
function sandbox(t) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-benchmark-test-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const manifests = join(dir, 'manifests');
	const state = join(dir, 'state');
	mkdirSync(manifests, { recursive: true });
	mkdirSync(state, { recursive: true });
	writeFileSync(
		join(manifests, 'fleet-runner-manifest.json'),
		JSON.stringify(
			{ machines: { 'claw-9': { role: 'claw', cores: 6, labels: [], maxRegistrations: 8 } } },
			null,
			2
		)
	);
	const capture = join(dir, 'claw-9.capture');
	return {
		dir,
		capture,
		state,
		env: { FLEET_MANIFEST_DIR: manifests, HADOKU_STATE_DIR: state },
		write: (text) => writeFileSync(capture, text),
	};
}

/** One row out of the rendered table, by its label. */
function row(stdout, label) {
	const m = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s{2,}(.*)$`, 'm').exec(
		stdout
	);
	assert.ok(m, `no '${label}' row in the table:\n${stdout}`);
	return m[1].trim();
}

test("the table's SMART rows read the disk / is on, not the first one enumerated", (t) => {
	const s = sandbox(t);
	s.write(claw9Capture());
	const r = runCli(['claw-9', '--from', s.capture], { env: s.env, scratch: s.dir });
	assert.equal(r.status, 0, `benchmark exited ${r.status}\n${r.stderr}`);

	// The model row already resolved the root device. These two now agree with
	// it — sdb's figures, not sda's.
	assert.match(row(r.stdout, 'root disk'), /^WDC WDS240G2G0/, 'the model row lost the root disk');
	assert.equal(row(r.stdout, 'disk hours'), '29888', "that is sda's age, not the root disk's");
	assert.equal(
		row(r.stdout, 'disk realloc'),
		'7',
		"that is sda's reallocated count, not the root disk's — the root SSD's 7 sectors are " +
			'exactly what this row exists to show'
	);
	// Said negatively as well, because "29888" could in principle be reached by
	// a reader that still enumerates and happens to sort differently.
	assert.doesNotMatch(r.stdout, /31450/, "the spinner's hours reached the table");
});

test("a root-disk field the drive does not report is —, never another disk's value", (t) => {
	const s = sandbox(t);
	// NVMe drives report wear as percentageUsed and have no reallocated-sector
	// concept at all, so benchmark-node.sh emits `unknown <reason>` for it. The
	// old reader answered that with sda's 0, which reads as a clean drive.
	s.write(
		claw9Capture({
			'disk.sdb.reallocated': 'unknown NVMe reports wear as percentageUsed and availableSparePct',
		})
	);
	const r = runCli(['claw-9', '--from', s.capture], { env: s.env, scratch: s.dir });
	assert.equal(r.status, 0, `benchmark exited ${r.status}\n${r.stderr}`);
	assert.equal(
		row(r.stdout, 'disk realloc'),
		'—',
		"the root disk reports no reallocated count; sda's 0 is not an answer to that question"
	);
	assert.equal(row(r.stdout, 'disk hours'), '29888', 'the hours still come from the root disk');
});

test('the recorded inventory names one device and reports that device throughout', (t) => {
	const s = sandbox(t);
	s.write(claw9Capture());
	const r = runCli(['claw-9', '--from', s.capture, '--write'], { env: s.env, scratch: s.dir });
	assert.equal(r.status, 0, `benchmark exited ${r.status}\n${r.stderr}`);

	const doc = JSON.parse(readFileSync(join(s.state, 'benchmark.json'), 'utf8'));
	const rec = doc.nodes['claw-9'];
	assert.ok(rec, `claw-9 was not recorded:\n${r.stdout}\n${r.stderr}`);

	// `inventoryEntry`'s rootDisk block has keyed off the same `rootDisk(r)`
	// resolver since it was written — this asserts it, so the table's defect
	// cannot be re-introduced here by someone "making the two consistent" in
	// the wrong direction.
	assert.equal(rec.rootDisk.device, 'sdb');
	assert.equal(rec.rootDisk.model, 'WDC WDS240G2G0A-00JH30');
	assert.equal(rec.rootDisk.rotational, false);
	assert.equal(rec.rootDisk.powerOnHours, 29888);
	assert.equal(rec.rootDisk.reallocatedSectors, 7);
	assert.equal(rec.rootDisk.tempC, 27);

	// EVERY drive is still kept beside it, with its own figures — the spinner
	// is not lost, it is merely no longer mistaken for root.
	const sda = rec.disks.find((d) => d.device === 'sda');
	assert.equal(sda.powerOnHours, 31450);
	assert.equal(sda.model, 'WDC WD10EZEX-08WN4A0');
});

test('every per-interface figure comes off the interface that is up', (t) => {
	const s = sandbox(t);
	s.write(claw9Capture());
	const r = runCli(['claw-9', '--from', s.capture, '--write'], { env: s.env, scratch: s.dir });
	assert.equal(r.status, 0, `benchmark exited ${r.status}\n${r.stderr}`);
	const net = JSON.parse(readFileSync(join(s.state, 'benchmark.json'), 'utf8')).nodes['claw-9']
		.network;
	assert.equal(net.linkSpeed, '1000Mb/s');
	assert.equal(net.duplex, 'full', "that is the unplugged port's duplex, not the live link's");

	// A wireless link has no duplex. `—` is the answer; the dead socket's
	// `half` is not.
	const s2 = sandbox(t);
	s2.write(claw9Capture({ 'net.wlp2s0.duplex': null }));
	const r2 = runCli(['claw-9', '--from', s2.capture, '--write'], { env: s2.env, scratch: s2.dir });
	assert.equal(r2.status, 0, `benchmark exited ${r2.status}\n${r2.stderr}`);
	const net2 = JSON.parse(readFileSync(join(s2.state, 'benchmark.json'), 'utf8')).nodes['claw-9']
		.network;
	assert.equal(net2.duplex, '—');
});

/**
 * NO FIGURE FROM THE NON-ROOT DISK MAY REACH THE TABLE AT ALL.
 *
 * The tests above name the four fields that were wrong. This one is about the
 * SHAPE, so the next `disk.*` row someone adds cannot quietly reintroduce it,
 * and it is behavioural rather than a source grep on purpose: the property is
 * "does a column describe one drive", not "does the source contain a regex".
 * A grep for the banned expression flags `rootDisk`'s own resolver and the
 * all-drives enumerator, both of which are correct — the shape it would ban
 * is the shape the fix is built out of.
 *
 * So the second disk is given values nothing else on the box could produce,
 * and the whole rendered table is searched for them. `sda`'s real reallocated
 * count on claw-9 is 0, which is indistinguishable from a healthy answer —
 * that is exactly why the live bug was invisible, and why the sentinel run
 * exists beside the realistic one.
 */
test('no figure from a non-root disk reaches the table', (t) => {
	const s = sandbox(t);
	const sentinels = {
		'disk.sda.powerOnHours': '987654',
		'disk.sda.reallocated': '424242',
		'disk.sda.model': 'SENTINEL-NOT-ROOT',
		'disk.sda.smartHealth': 'SENTINEL-FAILED',
	};
	s.write(claw9Capture(sentinels));
	const r = runCli(['claw-9', '--from', s.capture], { env: s.env, scratch: s.dir });
	assert.equal(r.status, 0, `benchmark exited ${r.status}\n${r.stderr}`);
	const leaked = Object.entries(sentinels).filter(([, v]) => r.stdout.includes(v));
	assert.deepEqual(
		leaked.map(([k]) => k),
		[],
		'a table row answered a question about this node with a value belonging to a disk ' +
			`the root filesystem is not on:\n${r.stdout}`
	);
	// and the root disk's own figures are all still there
	assert.equal(row(r.stdout, 'disk hours'), '29888');
	assert.equal(row(r.stdout, 'disk realloc'), '7');
});

/**
 * `benchmark` is under the `--json` contract (`scripts/lib/json-contract.mjs`);
 * mgmt-api's `ci:fleet-benchmark` parses this stdout and treats a non-zero exit
 * as a FINDING, not a crash. The row fix touches the table and the recorded
 * inventory, neither of which is in this payload — this asserts that.
 */
test('--report --json still emits the documented shape, into a file, exit code aside', (t) => {
	const s = sandbox(t);
	const r = runCli(['--due', '30', '--report', '--json'], { env: s.env, scratch: s.dir });
	// claw-9 has never been measured in this sandbox, so the run exits 1 with a
	// finding. Parseable stdout wins over the exit code — that IS the contract.
	assert.equal(r.status, 1, `expected the never-measured finding\n${r.stderr}`);
	const doc = JSON.parse(r.stdout);
	assert.deepEqual(
		Object.keys(doc).sort(),
		[
			'at',
			'byHand',
			'coverage',
			'degraded',
			'due',
			'failures',
			'findings',
			'mode',
			'ok',
			'results',
			'skippedByRole',
		].sort()
	);
	assert.equal(doc.mode, 'report');
	assert.equal(doc.ok, false);
	assert.ok(doc.findings.length > 0, 'a never-measured node is a finding');
	assert.ok(r.bytes > 0 && r.bytes < 8192, `measured ${r.bytes} bytes of stdout, read from a file`);
});

/**
 * THE BY-HAND COMMAND NEVER CARRIES A NODE LIST (#87 §2), even when several
 * nodes are due. Two nodes measured long enough ago to be `due` against
 * `--due 1`, written directly into the sandboxed state dir rather than
 * measured, so this is purely about the TEXT the report prints.
 */
test('the by-hand command is one invocation with no node names, even with several due', (t) => {
	const s = sandbox(t);
	const old = new Date(Date.now() - 40 * 86400000).toISOString();
	writeFileSync(
		join(s.state, 'benchmark.json'),
		JSON.stringify({ nodes: { 'claw-9': { at: old, by: 'fleet benchmark' } } })
	);
	const r = runCli(['--due', '1', '--report', '--json'], { env: s.env, scratch: s.dir });
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.due.length, 1, 'claw-9 should be due');
	assert.equal(doc.byHand, 'fleet benchmark --due 1 --write');
	assert.doesNotMatch(doc.byHand, /claw-9/, 'the command must not transcribe the due node');
});

/**
 * FAILED-UNIT NAMES LAND IN THE RECORD (#87 §4), not only the count. claw-3
 * and claw-6 both read `failed units: 1` on 2026-10-04 with no way to tell a
 * dead runner unit from something benign without ssh-ing in — this is the
 * fixture for that gap, fed through the ordinary `--from`/`--write` path
 * (benchmark-node.sh emits `stability.failedUnitNames` comma-joined).
 */
test('failed-unit NAMES are recorded and tabled, not only the count', (t) => {
	const s = sandbox(t);
	s.write(
		claw9Capture({
			'stability.failedUnits': '2',
			'stability.failedUnitNames': 'actions.runner.service,some-other.timer',
		})
	);
	const r = runCli(['claw-9', '--from', s.capture, '--write'], { env: s.env, scratch: s.dir });
	assert.equal(r.status, 0, `benchmark exited ${r.status}\n${r.stderr}`);
	// The table's column is sized to the node name and genuinely truncates a
	// long value — that is the table doing its job, not a bug — so this only
	// asserts the names were ATTEMPTED (the bare count alone is "2", never "2 (").
	assert.match(
		row(r.stdout, 'failed units'),
		/^2 \(/,
		'the table must show the names behind the count, not only the count'
	);
	const rec = JSON.parse(readFileSync(join(s.state, 'benchmark.json'), 'utf8')).nodes['claw-9'];
	assert.deepEqual(rec.stability.failedUnitNames, ['actions.runner.service', 'some-other.timer']);
});

test('zero failed units records an empty name list, not null', (t) => {
	const s = sandbox(t);
	s.write(claw9Capture({ 'stability.failedUnits': '0', 'stability.failedUnitNames': '' }));
	const r = runCli(['claw-9', '--from', s.capture, '--write'], { env: s.env, scratch: s.dir });
	assert.equal(r.status, 0, `benchmark exited ${r.status}\n${r.stderr}`);
	const rec = JSON.parse(readFileSync(join(s.state, 'benchmark.json'), 'utf8')).nodes['claw-9'];
	assert.deepEqual(rec.stability.failedUnitNames, []);
});

/**
 * `--cadence` VALIDATES BEFORE IT EVER TOUCHES A NODE. Every one of these
 * refuses before `createLiveDeps()` is even constructed, so they are safe to
 * run against the real CLI with no fleet, no ssh and no state dir reachable.
 */
test('--cadence refuses every flag combination that would defeat it', (t) => {
	const s = sandbox(t);
	const cases = [
		[['--cadence', '--due', '30', '--report'], /mutually exclusive/],
		[['--cadence', '--due', '30', '--scan', 'claw-9'], /--scan/],
		[['--cadence', '--due', '30', '--from', 'x'], /--from/],
		[['--cadence', '--due', '30', 'claw-9'], /picks its own node/],
		[['--cadence', '--due', '30', '--max', '2'], /--max/],
		[['--cadence', '--due', '30', '--write'], /implicit/],
		[['--cadence'], /needs --due/],
	];
	for (const [args, pattern] of cases) {
		const r = runCli(args, { env: s.env, scratch: s.dir });
		assert.equal(r.status, 2, `${args.join(' ')} -> exit ${r.status}\n${r.stderr}`);
		assert.match(r.stderr, pattern, `${args.join(' ')}: ${r.stderr}`);
	}
});

/**
 * THE CADENCE MAY NEVER MEASURE A GUEST (#87 §1, done-when #6). The cadence
 * picks its candidate list from `dueNodes(leadDays, null).due`, exactly like
 * `--report` does — one role split, reused rather than re-asked. This proves
 * that split still holds a guest out of `due` even when it is by far the most
 * overdue thing in the fleet, feeding `runCadence` candidates directly so the
 * property is checked at the seam the cadence actually depends on.
 *
 * `process.env` is set and restored around the call: `dueNodes` is called
 * IN-PROCESS (not through the CLI subprocess) so a plain fixture dir is enough
 * — no node is reached either way.
 */
test('dueNodes never puts a guest in the candidate list, however overdue it is', (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-benchmark-guest-test-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const manifests = join(dir, 'manifests');
	const state = join(dir, 'state');
	mkdirSync(manifests, { recursive: true });
	mkdirSync(state, { recursive: true });
	writeFileSync(
		join(manifests, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				'claw-x': { role: 'claw', cores: 4, labels: [], maxRegistrations: 4 },
				hokon: { role: 'guest', cores: 8, labels: [], maxRegistrations: 1 },
			},
		})
	);
	// Neither node has ever been measured, so both are maximally overdue —
	// the shape that would have picked the guest first if the split failed.
	const prevManifestDir = process.env.FLEET_MANIFEST_DIR;
	const prevStateDir = process.env.HADOKU_STATE_DIR;
	process.env.FLEET_MANIFEST_DIR = manifests;
	process.env.HADOKU_STATE_DIR = state;
	try {
		const { due, skippedByRole } = dueNodes(25, null);
		assert.deepEqual(
			due.map((d) => d.node),
			['claw-x']
		);
		assert.deepEqual(
			skippedByRole.map((d) => d.node),
			['hokon']
		);
		assert.equal(skippedByRole[0].role, 'guest');
	} finally {
		if (prevManifestDir === undefined) delete process.env.FLEET_MANIFEST_DIR;
		else process.env.FLEET_MANIFEST_DIR = prevManifestDir;
		if (prevStateDir === undefined) delete process.env.HADOKU_STATE_DIR;
		else process.env.HADOKU_STATE_DIR = prevStateDir;
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// `cadenceBands` — pure, no fleet, no fake ssh, no subprocess (#87 §2).
// ─────────────────────────────────────────────────────────────────────────────

test('a node at 26 days (--due 30) is an advisory; at 38 days it is a finding', () => {
	const { advisories, findings } = cadenceBands({
		due: [
			{ node: 'claw-26', ageDays: 26 },
			{ node: 'claw-38', ageDays: 38 },
		],
		measuredNode: null,
		dueDays: 30,
		graceDays: 37,
	});
	assert.deepEqual(advisories, ['benchmark due in 4d: claw-26']);
	assert.equal(findings.length, 1);
	assert.match(findings[0], /claw-38/);
	assert.doesNotMatch(advisories.join(' '), /claw-38/);
	assert.doesNotMatch(findings.join(' '), /claw-26/);
});

test('a node with NO record at all is a finding, never an advisory, inside the lead window', () => {
	const { advisories, findings } = cadenceBands({
		due: [{ node: 'claw-never', ageDays: null }],
		measuredNode: null,
		dueDays: 30,
		graceDays: 37,
	});
	assert.deepEqual(advisories, []);
	assert.match(findings[0], /claw-never/);
	assert.match(findings[0], /NEVER measured/);
});

test('the node this run just measured is left out of both the advisory and the finding list', () => {
	const { advisories, findings } = cadenceBands({
		due: [
			{ node: 'claw-just-measured', ageDays: 50 },
			{ node: 'claw-other', ageDays: 26 },
		],
		measuredNode: 'claw-just-measured',
		dueDays: 30,
		graceDays: 37,
	});
	assert.doesNotMatch([...advisories, ...findings].join(' '), /claw-just-measured/);
	assert.deepEqual(advisories, ['benchmark due in 4d: claw-other']);
});

// ─────────────────────────────────────────────────────────────────────────────
// `runCadence` — one node, drained around the measurement, always put back
// (#87 §1). Fakes track every call in `events`; no ssh, no fleet, no subprocess.
// ─────────────────────────────────────────────────────────────────────────────

/** @param {{busy?: Record<string,number>, alreadyDrained?: string[]}} [over] */
function cadenceDeps(over = {}) {
	const events = [];
	const drained = new Set(over.alreadyDrained ?? []);
	const busyByNode = over.busy ?? {};
	const deps = {
		isDrained: async (node) => {
			events.push(`isDrained ${node}`);
			if (over.isDrainedThrows) throw new Error('could not read drain state');
			return drained.has(node);
		},
		busy: async (node) => {
			events.push(`busy ${node}`);
			if (over.busyThrows?.has?.(node)) throw new Error('ssh died');
			return busyByNode[node] ?? 0;
		},
		drain: async (node, opts) => {
			events.push(`drain ${node} ${opts.kind}`);
			if (over.drainThrows) throw new Error('drain-node.mjs exploded');
			if (over.drainRefused) return { ok: false, reason: 'would leave no node able to take a job' };
			drained.add(node);
			return { ok: true };
		},
		waitDrained: async (node) => {
			events.push(`waitDrained ${node}`);
			if (over.waitThrows) throw new Error('poll died');
			if (over.neverDrains) return { drained: false, reason: 'still 1 job(s) running' };
			return { drained: true };
		},
		undrain: async (node) => {
			events.push(`undrain ${node}`);
			drained.delete(node);
			if (over.undrainFails) return { ok: false, reason: 'drain-node.mjs refused the undo' };
			return { ok: true };
		},
	};
	return { events, drained, deps };
}

const OLDEST_FIRST = [
	{ node: 'claw-oldest', ageDays: 50 },
	{ node: 'claw-older', ageDays: 40 },
	{ node: 'claw-newest', ageDays: 26 },
];

test('measures exactly the single most-overdue node, drain -> wait -> measure -> undrain, in order', async () => {
	const { events, deps } = cadenceDeps();
	const measured = [];
	const out = await runCadence({
		candidates: OLDEST_FIRST,
		deps,
		measure: async (node) => {
			measured.push(node);
			return { hostname: node };
		},
	});
	assert.equal(out.node, 'claw-oldest');
	assert.deepEqual(out.record, { hostname: 'claw-oldest' });
	assert.deepEqual(measured, ['claw-oldest'], 'exactly one node was measured');
	assert.deepEqual(
		events.filter((e) => /^(drain|waitDrained|undrain) /.test(e)),
		['drain claw-oldest training', 'waitDrained claw-oldest', 'undrain claw-oldest']
	);
	assert.ok(out.undrained, 'the measured node must be undrained');
});

test('a busy node is never picked: the next-oldest idle node is measured instead', async () => {
	const { events, deps } = cadenceDeps({ busy: { 'claw-oldest': 1 } });
	const out = await runCadence({
		candidates: OLDEST_FIRST,
		deps,
		measure: async (node) => ({ hostname: node }),
	});
	assert.equal(out.node, 'claw-older', 'the busy, more-overdue node must be skipped');
	assert.ok(
		!events.some((e) => e.startsWith('drain claw-oldest')),
		'a busy node must never be drained'
	);
	assert.ok(out.skipped.some((s) => s.node === 'claw-oldest' && /busy/.test(s.reason)));
});

test('a node already drained by someone else is skipped, not lifted, and not measured', async () => {
	const { events, deps } = cadenceDeps({ alreadyDrained: ['claw-oldest'] });
	const out = await runCadence({
		candidates: OLDEST_FIRST,
		deps,
		measure: async (node) => ({ hostname: node }),
	});
	assert.equal(out.node, 'claw-older');
	assert.ok(
		!events.some((e) => e.startsWith('drain claw-oldest') || e.startsWith('undrain claw-oldest')),
		'an operator-held node must never be touched'
	);
	assert.ok(out.skipped.some((s) => s.node === 'claw-oldest' && /not ours to lift/.test(s.reason)));
});

test('every candidate busy or already drained: nothing is measured, and nothing is drained or undrained', async () => {
	const { events, deps } = cadenceDeps({
		busy: { 'claw-oldest': 1 },
		alreadyDrained: ['claw-older', 'claw-newest'],
	});
	const out = await runCadence({
		candidates: OLDEST_FIRST,
		deps,
		measure: async () => {
			throw new Error('must never be called');
		},
	});
	assert.equal(out.node, null);
	assert.ok(!events.some((e) => /^(drain|undrain) /.test(e)));
	assert.equal(out.skipped.length, 3);
});

test('UNDRAIN IN A finally: a measurement that throws still puts the node back', async () => {
	const { events, deps } = cadenceDeps();
	const out = await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async () => {
			throw new Error('boom: the probe died mid-run');
		},
	});
	assert.equal(out.node, 'claw-oldest');
	assert.equal(out.record, null);
	assert.match(out.error, /boom: the probe died mid-run/);
	assert.ok(
		events.includes('undrain claw-oldest'),
		'a throwing measurement must still be undrained'
	);
	assert.ok(out.undrained, 'undrain must have succeeded');
});

test('a node that never settles is not measured, but is still undrained', async () => {
	const { events, deps } = cadenceDeps({ neverDrains: true });
	let measureCalled = false;
	const out = await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async () => {
			measureCalled = true;
			return {};
		},
	});
	assert.equal(
		measureCalled,
		false,
		'measuring a node that never went quiet would skew the numbers'
	);
	assert.match(out.error, /not drained in time/);
	assert.ok(events.includes('undrain claw-oldest'));
	assert.ok(out.undrained);
});

test('a failed undrain is reported, not swallowed', async () => {
	const { deps } = cadenceDeps({ undrainFails: true });
	const out = await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async () => ({ hostname: 'claw-oldest' }),
	});
	assert.equal(out.undrained, false);
	assert.match(out.undrainReason, /refused the undo/);
});

test('a drain that throws mid-flight is recovered: isDrained is checked and the node is not left stranded', async () => {
	const { events, deps } = cadenceDeps({ drainThrows: true });
	const out = await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async () => {
			throw new Error('must never be called — the drain itself failed');
		},
	});
	assert.equal(out.node, null);
	assert.ok(out.skipped.some((s) => /drain failed/.test(s.reason)));
	// `isDrained` is consulted to decide whether the failed drain landed anyway.
	assert.ok(events.includes('isDrained claw-oldest'));
});

test('a node this run cannot reach (busy check fails) is skipped, not drained', async () => {
	const { events, deps } = cadenceDeps({ busyThrows: new Set(['claw-oldest']) });
	const out = await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async () => {
			throw new Error('must never be called');
		},
	});
	assert.equal(out.node, null);
	assert.ok(!events.some((e) => e.startsWith('drain ')));
	assert.ok(out.skipped.some((s) => /could not reach it/.test(s.reason)));
});

// ─────────────────────────────────────────────────────────────────────────────
// SAFETY: a process KILL abandons `runCadence`'s own `finally`. Two layers —
// a bounded budget (so mgmt-api's own timeout is never what fires) and a
// signal handler backstop (`state.held` + `cadenceSignalHandler`) for when
// something outside this file's control kills it anyway.
// ─────────────────────────────────────────────────────────────────────────────

test('state.held names the node while it is drained, and is cleared once the undrain attempt starts', async () => {
	const { deps } = cadenceDeps();
	const state = { held: undefined };
	const seenDuringMeasure = [];
	await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async (node) => {
			seenDuringMeasure.push(state.held);
			return { hostname: node };
		},
		state,
	});
	assert.deepEqual(seenDuringMeasure, ['claw-oldest'], 'held during the measurement window');
	assert.equal(state.held, null, 'cleared once the normal undrain path is reached');
});

test('state.held is cleared even when the measurement throws — a killed process would have had the chance to see it held first', async () => {
	const { deps } = cadenceDeps();
	const state = {};
	let heldWhileThrowing;
	await runCadence({
		candidates: [OLDEST_FIRST[0]],
		deps,
		measure: async () => {
			heldWhileThrowing = state.held;
			throw new Error('boom');
		},
		state,
	});
	assert.equal(heldWhileThrowing, 'claw-oldest');
	assert.equal(state.held, null);
});

test('state.held never names a node that was only a SKIPPED candidate (busy/drained), only the one actually drained', async () => {
	const { deps } = cadenceDeps({ busy: { 'claw-oldest': 1 } });
	const state = {};
	await runCadence({
		candidates: OLDEST_FIRST,
		deps,
		measure: async (node) => ({ hostname: node }),
		state,
	});
	// claw-oldest (busy) must never have been recorded as held; claw-older
	// (the one actually drained and measured) ends cleared, same as above.
	assert.equal(state.held, null);
});

/**
 * `cadenceSignalHandler` — the backstop for a process kill between drain and
 * undrain. `undrainSync`/`exit`/`log` are injected so this proves the LOGIC
 * without sending the test process a real signal.
 */
test('cadenceSignalHandler: a held node is undrained synchronously and the process exits non-zero naming the signal', () => {
	const calls = [];
	cadenceSignalHandler({ held: 'claw-5' }, 'SIGTERM', {
		undrainSync: (node) => calls.push(['undrain', node]),
		log: (line) => calls.push(['log', line]),
		exit: (code) => calls.push(['exit', code]),
	});
	assert.deepEqual(calls[0], ['undrain', 'claw-5']);
	assert.match(calls[1][1], /SIGTERM/);
	assert.match(calls[1][1], /claw-5/);
	assert.deepEqual(calls[2], ['exit', 1]);
});

test('cadenceSignalHandler: nothing held means no undrain call, but the process still exits', () => {
	const calls = [];
	cadenceSignalHandler({ held: null }, 'SIGINT', {
		undrainSync: (node) => calls.push(['undrain', node]),
		log: (line) => calls.push(['log', line]),
		exit: (code) => calls.push(['exit', code]),
	});
	assert.ok(!calls.some((c) => c[0] === 'undrain'), 'nothing was held; nothing to undrain');
	assert.deepEqual(calls.at(-1), ['exit', 1]);
});

test('cadenceSignalHandler: an undrain that itself fails is reported, not swallowed, and still exits', () => {
	const calls = [];
	cadenceSignalHandler({ held: 'claw-5' }, 'SIGTERM', {
		undrainSync: () => {
			throw new Error('drain-node.mjs: could not write fleet-drain.json');
		},
		log: (line) => calls.push(['log', line]),
		exit: (code) => calls.push(['exit', code]),
	});
	assert.ok(calls.some((c) => c[0] === 'log' && /FAILED to undrain/.test(c[1])));
	assert.ok(calls.some((c) => c[0] === 'log' && /fleet drain claw-5 --undo/.test(c[1])));
	assert.deepEqual(calls.at(-1), ['exit', 1]);
});

/**
 * THE ARITHMETIC (the manager's ask #1): drain-wait + measure (two attempts,
 * worst case) + the fixed busy/drain/undrain costs + margin must still fit
 * comfortably under BOTH mgmt-api's child-process timeout and the cron's own
 * `timeout_s`. The two outside figures are STATED, not imported — the manager
 * asked this file not to import a number across repos — and must be kept in
 * sync by hand with `fleet-benchmark-check.ts`'s `TIMEOUT_MS` comment and
 * `services/cron-worker/profiles.json`'s `timeout_s: 1500` in hadoku_site.
 */
test("the cadence budget fits under mgmt-api's timeout, which fits under the cron's", () => {
	const MGMT_API_TIMEOUT_MS = 20 * 60_000; // fleet-benchmark-check.ts's TIMEOUT_MS
	const CRON_TIMEOUT_MS = 1500 * 1000; // services/cron-worker/profiles.json, hadoku_site
	assert.ok(
		CADENCE_WORST_CASE_MS < MGMT_API_TIMEOUT_MS,
		`worst case ${CADENCE_WORST_CASE_MS}ms must leave margin under mgmt-api's ${MGMT_API_TIMEOUT_MS}ms`
	);
	assert.ok(
		MGMT_API_TIMEOUT_MS < CRON_TIMEOUT_MS,
		`mgmt-api's ${MGMT_API_TIMEOUT_MS}ms must itself fire before the cron's ${CRON_TIMEOUT_MS}ms`
	);
	// Sanity on the two constants this sum is built from, so a future edit to
	// either cannot silently drift from the figures named in the comment above
	// `CADENCE_WAIT_TIMEOUT_MS`.
	assert.equal(CADENCE_WAIT_TIMEOUT_MS, 5 * 60_000);
	assert.equal(CADENCE_MEASURE_TIMEOUT_MS, 4 * 60_000);
});

/**
 * SOURCE-SHAPE GUARDS: the two wiring changes that cannot be proven by
 * injecting fakes into `runCadence` alone, because they are about WHICH
 * function `runCadenceCli` calls and WITH WHAT ARGUMENT — not observable
 * behaviour of `runCadence` itself, which only sees whatever `deps` it is
 * handed. Same shape as this repo's other guard tests (e.g.
 * `node-identity-guard.test.mjs`): read the source, not a comment, because a
 * comment describing a bound that the code does not enforce is exactly the
 * failure this lane exists to prevent (AGENTS.md).
 */
test('runCadenceCli never calls the UNBOUNDED liveDeps.waitDrained — only the bounded waitUntilDrained', () => {
	const src = readFileSync(CLI, 'utf8');
	const body = src.slice(src.indexOf('async function runCadenceCli'));
	assert.doesNotMatch(
		body,
		/liveDeps\.waitDrained/,
		'runCadenceCli must not call the 45-minute default — see CADENCE_WAIT_TIMEOUT_MS'
	);
	assert.match(body, /waitUntilDrained\(\{[^}]*timeoutMs:\s*CADENCE_WAIT_TIMEOUT_MS/s);
});

test('runCadenceCli measures with the bounded CADENCE_MEASURE_TIMEOUT_MS, not the 420s multi-node default', () => {
	const src = readFileSync(CLI, 'utf8');
	const body = src.slice(src.indexOf('async function runCadenceCli'));
	assert.match(body, /measureOneNode\(n,\s*\{[^}]*timeoutMs:\s*CADENCE_MEASURE_TIMEOUT_MS/s);
});

test('runCadenceCli installs AND removes a SIGTERM/SIGINT backstop around the drained window', () => {
	const src = readFileSync(CLI, 'utf8');
	const body = src.slice(src.indexOf('async function runCadenceCli'));
	assert.match(body, /process\.on\(['"]SIGTERM['"],\s*onSignal\)/);
	assert.match(body, /process\.on\(['"]SIGINT['"],\s*onSignal\)/);
	// Removed too — a listener left behind would accumulate across repeated
	// runs in the same process and shadow the default SIGTERM behaviour.
	assert.match(body, /process\.off\(['"]SIGTERM['"],\s*onSignal\)/);
	assert.match(body, /process\.off\(['"]SIGINT['"],\s*onSignal\)/);
});

/**
 * #121, claw-9 on 2026-10-18/19: the stored AER count was 34, the box rebooted,
 * and the counter read 0. `num()` stored 0 as null, lostFacets read that as a
 * field the run could not measure, and the nightly refused the write — telling
 * the operator to get a rooted capture the run already had.
 * MUTATION: put `|| null` back in num() and the first test fails.
 */
test('a counter that goes from a value to a measured 0 is written, and stored as 0', (t) => {
	const s = sandbox(t);
	s.write(claw9Capture({ 'capture.root': 'yes', 'stability.aerCorrectable': '34' }));
	let r = runCli(['claw-9', '--from', s.capture, '--write'], { env: s.env, scratch: s.dir });
	assert.equal(r.status, 0, `first write exited ${r.status}\n${r.stderr}`);
	s.write(
		claw9Capture({
			'capture.root': 'yes',
			'stability.aerCorrectable': '0',
			'stability.oomKills': '0',
			'stability.failedUnits': '0',
			'stability.failedUnitNames': '',
		})
	);
	r = runCli(['claw-9', '--from', s.capture, '--write'], { env: s.env, scratch: s.dir });
	assert.equal(r.status, 0, `the 34 -> 0 write was refused\n${r.stdout}\n${r.stderr}`);
	const rec = JSON.parse(readFileSync(join(s.state, 'benchmark.json'), 'utf8')).nodes['claw-9'];
	assert.equal(rec.stability.aerCorrectable, 0);
	assert.equal(rec.stability.oomKills, 0);
	assert.equal(rec.stability.failedUnits, 0, 'a zero count beside an empty name list, not null');
	// Zeros elsewhere in the record, too: a drive with no pending sectors.
	assert.equal(rec.rootDisk.pendingSectors, 0);
});

test('a value that becomes UNKNOWN is still refused, and the finding names the field', (t) => {
	const s = sandbox(t);
	s.write(claw9Capture({ 'capture.root': 'yes', 'stability.aerCorrectable': '0' }));
	let r = runCli(['claw-9', '--from', s.capture, '--write'], { env: s.env, scratch: s.dir });
	assert.equal(r.status, 0, r.stderr);
	s.write(
		claw9Capture({
			'capture.root': 'yes',
			'stability.aerCorrectable': 'unknown no readable PCIe AER counters',
		})
	);
	r = runCli(['claw-9', '--from', s.capture, '--write', '--json'], {
		env: s.env,
		scratch: s.dir,
	});
	const out = JSON.parse(r.stdout);
	const finding = out.findings.find((f) => f.startsWith('claw-9:'));
	assert.ok(finding, `no claw-9 finding in ${r.stdout}`);
	assert.match(finding, /stability\.aerCorrectable/, 'the finding names the lost field');
	// The capture ran as root, so root is not the advice.
	assert.doesNotMatch(finding, /rooted capture/);
	const rec = JSON.parse(readFileSync(join(s.state, 'benchmark.json'), 'utf8')).nodes['claw-9'];
	assert.equal(rec.stability.aerCorrectable, 0, 'the stored measured zero is kept');
});

test('an UNPRIVILEGED capture that loses a field is told to re-run with root', () => {
	assert.match(
		degradedFinding({ node: 'hokon', lost: ['disk.smartHealth'], rooted: 'no' }),
		/^hokon: needs a rooted capture — .*disk\.smartHealth/
	);
	// A capture from before capture.root existed makes no claim either way.
	assert.doesNotMatch(
		degradedFinding({ node: 'claw-9', lost: ['x'], rooted: null }),
		/rooted capture/
	);
});

/**
 * The node script's own zeros must be real ones once a zero is stored (#121):
 * a dmesg it could not read, or a box with no AER counters, is `unknown`.
 * Read from the script, because executing it here would read THIS host.
 */
test('benchmark-node.sh reports an unreadable dmesg and absent AER as unknown, not 0', () => {
	const sh = readFileSync(join(HERE, 'benchmark-node.sh'), 'utf8');
	assert.match(sh, /unk stability\.oomKills /);
	assert.match(sh, /unk stability\.aerCorrectable /);
	assert.doesNotMatch(sh, /\$\{OOM:-0\}/, 'the grep -c-of-nothing zero is gone');
	assert.match(sh, /^emit capture\.root /m);
});
