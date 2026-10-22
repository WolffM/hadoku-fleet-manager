/**
 * The `$health` WRITE path, executed against a scratch state dir.
 *
 * `doctor.test.mjs` covers the judging half, which is pure. This covers the
 * properties that only exist once something writes a file, and each of them is a
 * rule this repo bought with an incident:
 *
 *   1. A NODE THIS RUN COULD NOT REACH KEEPS WHATEVER `$health` IT ALREADY HAD.
 *      Verbatim the rule `bootcamp.mjs`'s `$capabilities` write states in its own
 *      comment: "I could not look" must not render as "nothing is here", and
 *      replacing a real reading with silence destroys the last known good record
 *      of a box that is merely off for the evening. Asserted by running the real
 *      writer against a node name nothing can resolve.
 *   2. MANIFEST RESOLUTION THROWS ON A MISSING DIRECTORY. CLAUDE.md: "a manifest
 *      that resolves to nothing reports a healthy fleet of zero machines." There
 *      is no fallback and this test is here so nobody adds one.
 *   3. SINCE WAVE 3h THE RECORD IS `<stateDir>/health.json`, not the manifest
 *      (`src/lib/measured.ts`). `--write` writes NOT ONE manifest byte and needs
 *      no commit — so the manifest dir here is deliberately NOT a git checkout
 *      and IS a declared deploy root, the two conditions under which the old
 *      writer refused. A missing or malformed state file is never "healthy".
 *
 * NOTHING HERE TOUCHES THE LIVE MANIFEST OR THE LIVE STATE DIR. Every run gets
 * its own temp directory; `FLEET_MANIFEST_DIR` and `HADOKU_STATE_DIR` point into
 * it (never `~/.hadoku-mgmt`, which on hokon is the real one), and the node names
 * cannot resolve to a real box. The child is spawned with a clean env — every
 * `GIT_*` stripped — so a hook's `GIT_DIR` cannot follow it in. No fixture here
 * runs `git` at all any more.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'doctor-run.mjs');

/**
 * A node name nothing can resolve.
 *
 * `.invalid` IS LOAD-BEARING (2026-09-14). RFC 6761 reserves it, so a resolver
 * answers NXDOMAIN without asking anything — and because the name contains a
 * dot, glibc tries it verbatim instead of walking the search list. A bare name
 * DID walk it, and on hokon `search home` is served by a Pi-hole that does not
 * answer NXDOMAIN for unknown names: measured, 20.00s to fail against 0.00s.
 * Every test below also shadows `ssh`, so the name never reaches a resolver at
 * all — the `.invalid` is the second line of defence, not the first.
 */
const NODE = 'doctor-test-absent-node.invalid';

/** The env a child gets: no GIT_*, no inherited fleet paths. */
function cleanEnv(extra) {
	const env = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (k.startsWith('GIT_')) continue;
		if (k === 'FLEET_MANIFEST_DIR' || k === 'HADOKU_STATE_DIR') continue;
		env[k] = v;
	}
	return { ...env, ...extra };
}

const made = [];
process.on('exit', () => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

/**
 * A scratch manifest dir holding `machines`, an EMPTY state dir (plus the drain
 * file the runner reads), and a `bin/ssh` that stands in for the transport.
 *
 * `probe`, when given, is what the fake ssh prints — a captured DOCTOR-BEGIN …
 * DOCTOR-END run — so the node reads as REACHABLE without any machine existing.
 * Without it the fake ssh consumes the script and fails: an unreachable node.
 */
function scratch(machines, { probe = null, health = undefined } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-doctor-'));
	made.push(dir);
	const mdir = join(dir, 'manifests');
	const state = join(dir, 'state');
	const bin = join(dir, 'bin');
	for (const d of [mdir, state, bin]) mkdirSync(d, { recursive: true });
	writeFileSync(
		join(mdir, 'fleet-runner-manifest.json'),
		`${JSON.stringify({ toolchain: { capabilities: [] }, machines }, null, 2)}\n`
	);
	writeFileSync(join(state, 'fleet-drain.json'), `${JSON.stringify({ nodes: {} })}\n`);
	if (health !== undefined) {
		writeFileSync(
			join(state, 'health.json'),
			typeof health === 'string' ? health : `${JSON.stringify({ nodes: health }, null, 2)}\n`
		);
	}
	let ssh = '#!/bin/sh\ncat >/dev/null\nexit 255\n';
	if (probe) {
		const capture = join(dir, 'probe.txt');
		writeFileSync(capture, `${probe}\n`);
		ssh = `#!/bin/sh\ncat >/dev/null\ncat '${capture}'\n`;
	}
	writeFileSync(join(bin, 'ssh'), ssh, { mode: 0o755 });
	const manifestBytes = () => readFileSync(join(mdir, 'fleet-runner-manifest.json'), 'utf8');
	return { dir, mdir, state, bin, manifestBytes };
}

function run(fx, args, { mdir = fx.mdir } = {}) {
	try {
		const stdout = execFileSync(process.execPath, [RUNNER, ...args], {
			encoding: 'utf8',
			env: cleanEnv({
				PATH: `${fx.bin}:${process.env.PATH ?? ''}`,
				FLEET_MANIFEST_DIR: mdir,
				HADOKU_STATE_DIR: fx.state,
				// The manifest dir IS a deploy root. The old writer refused this
				// outright; the state-dir writer must not care.
				FLEET_DEPLOY_ROOTS: mdir,
				FLEET_NO_BANNER: '1',
			}),
			timeout: 120_000,
		});
		return { code: 0, stdout, stderr: '' };
	} catch (err) {
		return {
			code: err.status ?? null,
			stdout: String(err.stdout ?? ''),
			stderr: String(err.stderr ?? ''),
		};
	}
}

const readHealth = (fx) => JSON.parse(readFileSync(join(fx.state, 'health.json'), 'utf8'));

// An existing record, dated, with real numbers in it — the thing that must
// survive a run that could not reach the box.
const EXISTING = {
	at: '2026-09-01T00:00:00.000Z',
	by: 'fleet doctor',
	node: NODE,
	reachable: true,
	thermal: { sensor: 'hwmon.0.coretemp.Package_id_0', idleC: 40, loadC: 70, riseC: 30 },
	smart: { device: 'sda', health: 'PASSED', powerOnHours: 1234 },
	disk: { device: 'sda', freePct: 70 },
};

/** A complete probe run: enough for `parseDoctor` to call it finished. */
const PROBE = [
	'DOCTOR-BEGIN v1',
	`D hostname ${NODE}`,
	'D product Test Box',
	'D kernel 6.12.0-test',
	'D idle.hwmon.3.coretemp.Package_id_0 45000',
	'D disk.root.fs ext4',
	'D disk.root.totalKb 1000000',
	'D disk.root.availKb 800000',
	'D disk.root.device sda',
	'D smart.device sda',
	'S SMART overall-health self-assessment test result: PASSED',
	'S   9 Power_On_Hours          0x0012   055   055   000    Old_age   Always       -       4321',
	'D reboot.required no',
	`DOCTOR-END ${NODE}`,
].join('\n');

void test('an unreachable node KEEPS the $health it already had', () => {
	const fx = scratch({ [NODE]: { cores: 4 } }, { health: { [NODE]: EXISTING } });
	const before = fx.manifestBytes();
	const r = run(fx, ['--write', '--no-load']);
	assert.deepEqual(
		readHealth(fx).nodes[NODE],
		EXISTING,
		'a run that could not look must not overwrite a real reading with silence'
	);
	assert.equal(fx.manifestBytes(), before, 'not one manifest byte');
	assert.match(r.stdout, /nothing written — no node was reachable/);
	assert.equal(r.code, 1, 'an unreachable node is a finding, so the run fails');
});

void test('an unreachable node with no record gains none — and still fails', () => {
	const fx = scratch({ [NODE]: { cores: 4 } });
	const r = run(fx, ['--write', '--no-load']);
	assert.equal(existsSync(join(fx.state, 'health.json')), false);
	assert.equal(r.code, 1);
	assert.match(r.stdout, /UNREACHABLE/);
});

void test('a REACHABLE node is recorded in <stateDir>/health.json — no manifest byte, no commit, deploy root or not', () => {
	// The manifest dir is not a git checkout and IS a declared deploy root: the
	// two refusals the pre-3h writer would have made. Neither applies any more.
	const fx = scratch(
		{
			[NODE]: {
				cores: 4,
				$capabilities: { at: '2026-09-02T00:00:00.000Z', by: 'fleet bootcamp' },
			},
		},
		{ probe: PROBE }
	);
	const before = fx.manifestBytes();
	const r = run(fx, ['--write', '--no-load', '--json']);
	assert.equal(fx.manifestBytes(), before, 'not one manifest byte');
	const rec = readHealth(fx).nodes[NODE];
	assert.ok(rec, `no health.json record: ${r.stdout}${r.stderr}`);
	assert.equal(rec.by, 'fleet doctor');
	assert.equal(rec.reachable, true);
	assert.equal(rec.smart.powerOnHours, 4321);
	// The bootcamp POINTER is re-derived on read, never stored: a stored copy
	// would be a cross-tree read frozen at write time.
	assert.equal('bootcamp' in rec, false, 'the $capabilities pointer must not be stored');
	const log = readFileSync(join(fx.state, 'health.log'), 'utf8').trim().split('\n');
	assert.equal(log.length, 1);
	const line = JSON.parse(log[0]);
	assert.equal(line.node, NODE);
	assert.equal(line.facet, 'health');
	assert.equal(line.at, rec.at);
	assert.match(line.digest, /^[0-9a-f]{16}$/);
});

void test('a MALFORMED health.json is refused, never overwritten — other nodes live in it', () => {
	const fx = scratch({ [NODE]: { cores: 4 } }, { probe: PROBE, health: '{ "nodes": [' });
	const r = run(fx, ['--write', '--no-load']);
	assert.equal(r.code, 1);
	assert.match(r.stderr, /\$health NOT recorded — malformed/);
	assert.equal(readFileSync(join(fx.state, 'health.json'), 'utf8'), '{ "nodes": [');
});

void test('--from-record renders the STATE record and needs no node at all', () => {
	// §H's third done-when, executed: every column the readout draws comes out of
	// the record, with the probe switched off entirely.
	const fx = scratch({ [NODE]: { cores: 4 } }, { health: { [NODE]: EXISTING } });
	const r = run(fx, ['--from-record']);
	assert.match(r.stdout, /40°C idle → 70°C/);
	assert.match(r.stdout, /1,234h/);
	assert.match(r.stdout, /70% free/);
});

void test('--from-manifest (the old spelling) still serves the manifest copy while the migration is in flight', () => {
	const fx = scratch({ [NODE]: { cores: 4, $health: EXISTING } });
	const r = run(fx, ['--from-manifest', '--json']);
	const out = JSON.parse(r.stdout);
	assert.equal(out.health[NODE].from, 'manifest', 'which tree answered must be said');
	assert.equal(out.health[NODE].thermal.loadC, 70);
});

void test('--from-record: the STATE copy wins only when strictly newer, and bootcamp comes from the CURRENT manifest', () => {
	const older = { ...EXISTING, at: '2026-08-01T00:00:00.000Z', disk: { freePct: 11 } };
	const fx = scratch(
		{
			[NODE]: {
				cores: 4,
				$health: {
					...older,
					bootcamp: { from: '$capabilities', verdict: 'STALE-STORED' },
				},
				$capabilities: { at: '2026-09-05T00:00:00.000Z', by: 'fleet bootcamp', earned: ['gh'] },
			},
		},
		{ health: { [NODE]: EXISTING } }
	);
	const out = JSON.parse(run(fx, ['--from-record', '--json']).stdout);
	assert.equal(out.health[NODE].from, 'state');
	assert.equal(out.health[NODE].disk.freePct, 70);
	assert.equal(out.health[NODE].bootcamp.verdict, 'PASSES');
	assert.equal(out.health[NODE].bootcamp.at, '2026-09-05T00:00:00.000Z');
});

void test('--from-record says so when a node carries no record, rather than drawing a blank row', () => {
	const fx = scratch({ [NODE]: { cores: 4 } });
	const r = run(fx, ['--from-record']);
	assert.match(r.stdout, /carries no \$health record \(no-file\)/);
	assert.equal(r.code, 1);
});

void test('--write with --from-record is refused — a record read back is not a measurement', () => {
	const fx = scratch({ [NODE]: { cores: 4, $health: EXISTING } });
	const r = run(fx, ['--from-record', '--write']);
	assert.equal(r.code, 2);
	assert.match(r.stderr, /--write records a PROBE/);
	assert.equal(existsSync(join(fx.state, 'health.json')), false);
});

void test('a missing manifest directory THROWS — it never resolves to nothing', () => {
	const fx = scratch({});
	const r = run(fx, ['--no-load'], { mdir: join(fx.dir, 'no-such-directory') });
	assert.notEqual(r.code, 0);
	assert.match(
		`${r.stdout}${r.stderr}`,
		/FLEET_MANIFEST_DIR/,
		'the refusal must name the variable an operator has to set'
	);
});

void test('`fleet enroll --update` cannot clobber a manifest facet — it assigns named fields', () => {
	// THE OTHER WRITER ON THE SAME OBJECT. `$capabilities` (and, until the
	// by-hand strip lands, the manifest's older `$health` / `$benchmark`) are
	// siblings of `$measured` on `machines[node]`, and `enroll-node.mjs` is the
	// only other thing that writes that object for a node that already exists.
	// Its `exists` branch assigns three named fields; rewritten as
	// `doc.machines[name] = measured` or a spread it would silently delete them.
	//
	// Reads the SOURCE with comments blanked, the same way `cli-commands.test.mjs`
	// does, so the prose above this branch cannot satisfy the rule.
	const src = readFileSync(join(HERE, '..', 'enroll-node.mjs'), 'utf8');
	const blanked = blankComments(src);
	const branch = /if \(exists\) \{([\s\S]*?)\n\} else \{([\s\S]*?)\n\}/.exec(blanked);
	assert.ok(branch, 'the exists/else write branch must still be recognisable');
	const updatePath = branch[1];
	assert.match(updatePath, /current\.\$measured = measured\.\$measured;/);
	assert.doesNotMatch(
		updatePath,
		/doc\.machines\[name\]\s*=/,
		'the update path must never replace the whole entry — that drops $health, $benchmark and $capabilities'
	);
	assert.doesNotMatch(
		updatePath,
		/\.\.\.measured/,
		'a spread of the freshly measured entry would overwrite the other facets with absence'
	);
	for (const facet of ['$health', '$benchmark', '$capabilities']) {
		assert.doesNotMatch(
			updatePath,
			new RegExp(`current\\.\\${facet}\\s*=`),
			`enroll must not write ${facet}; its producer is the only writer`
		);
	}
	// And enroll must still TELL the operator those facets are owed by a run.
	assert.match(blanked, /a run still owes/);
	// The backtick in the source is escaped (`\``) because the line is itself a
	// template literal, so the assertion allows for the backslash rather than
	// pretending it is not there.
	assert.match(blanked, /\$health \(\\?`fleet doctor --machine/);
});

void test('a bare positional is REFUSED, never read as an implied --machine', () => {
	// `fleet doctor claw-1` is what an operator types and what the old shell
	// version accepted. This parser IGNORES a positional, which silently widens
	// the run to the whole fleet — the exact refusal `fleet provision` and
	// `fleet bootcamp` already give.
	const fx = scratch({ [NODE]: { cores: 4 } });
	const r = run(fx, [NODE, '--no-load']);
	assert.equal(r.code, 1);
	assert.match(`${r.stdout}${r.stderr}`, /Node scoping is spelled --machine/);
});

// ── --cadence, the scheduled run (ci:health-refresh) ─────────────────────────

/** The same complete run, taken while CI was building: no load phase. */
const BUSY_PROBE = PROBE.replace(
	`DOCTOR-END ${NODE}`,
	[
		'D runners.busy 1',
		'U load CI was building here (1 worker(s)) — loading the box would slow a consumer job',
		`DOCTOR-END ${NODE}`,
	].join('\n')
);

void test('--cadence DEFERS a busy node: its record is kept and its missing load reading does not block', () => {
	const fx = scratch({ [NODE]: { cores: 4 } }, { probe: BUSY_PROBE, health: { [NODE]: EXISTING } });
	const r = run(fx, ['--cadence', '--write', '--json']);
	const doc = JSON.parse(r.stdout);
	assert.deepEqual(doc.deferred, [NODE]);
	assert.equal(doc.cadence, true);
	assert.deepEqual(
		readHealth(fx).nodes[NODE],
		EXISTING,
		'a record with no under-load reading must not replace one that has it'
	);
	const thermal = doc.findings.find((f) => f.status === 'no-load-reading');
	assert.ok(thermal, 'the missing reading is still SAID');
	assert.equal(thermal.class, 'advisory');
	assert.match(thermal.why, /DEFERRED by --cadence/);
	assert.ok(
		!doc.findings.some((f) => f.class === 'blocking' && f.category === 'cpu-thermal'),
		'a claw that is merely busy at 12:00 UTC must not page'
	);
});

void test('without --cadence the same busy node is BLOCKING and IS written, as before', () => {
	const fx = scratch({ [NODE]: { cores: 4 } }, { probe: BUSY_PROBE, health: { [NODE]: EXISTING } });
	const r = run(fx, ['--write', '--json']);
	const doc = JSON.parse(r.stdout);
	assert.deepEqual(doc.deferred, []);
	assert.equal(r.code, 1);
	assert.ok(doc.findings.some((f) => f.class === 'blocking' && f.status === 'no-load-reading'));
	assert.notDeepEqual(readHealth(fx).nodes[NODE], EXISTING);
});

void test('--cadence refuses the flags that would make it a different measurement', () => {
	const fx = scratch({ [NODE]: { cores: 4 } }, { probe: PROBE });
	for (const extra of ['--no-load', '--force', '--from-record']) {
		const r = run(fx, ['--cadence', extra]);
		assert.equal(r.code, 2, `--cadence ${extra} must be refused`);
	}
});

void test('a probe that never finishes is tried TWICE before the node is called unreachable', () => {
	const fx = scratch({ [NODE]: { cores: 4 } }, { health: { [NODE]: EXISTING } });
	const count = join(fx.dir, 'ssh-calls');
	writeFileSync(
		join(fx.bin, 'ssh'),
		`#!/bin/sh\ncat >/dev/null\necho x >> '${count}'\nexit 255\n`,
		{
			mode: 0o755,
		}
	);
	const r = run(fx, ['--cadence', '--write', '--json']);
	assert.equal(readFileSync(count, 'utf8').trim().split('\n').length, 2);
	const doc = JSON.parse(r.stdout);
	assert.deepEqual(doc.unreachable, [NODE]);
	assert.deepEqual(doc.written, [], 'and still nothing is written over the record it had');
	assert.match(doc.health[NODE].why, /in 2 attempts/);
	assert.equal(r.code, 1, 'two failures are still a finding');
});
