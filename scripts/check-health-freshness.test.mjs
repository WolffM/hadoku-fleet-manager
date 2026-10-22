/**
 * The `$health` freshness gate: the property it exists to hold is that it never
 * gets EASIER to pass the older or more broken the record gets.
 *
 * Two halves, the same split `doctor.test.mjs` / `doctor-write.test.mjs` uses.
 * The judging half is pure and takes `nowMs`, so every fixture below is dated
 * RELATIVE to the clock rather than at an absolute instant — `fixture-clock-
 * guard.test.mjs` re-runs the suite on a clock shifted 30 and 400 days and a
 * hard-coded `2026-09-10` would age out of the window and flip a verdict with
 * no commit behind it (this repo has reddened main that way twice). The I/O
 * half is spawned against a scratch manifest dir and a scratch state dir, never
 * the live ones.
 *
 * WHAT THE MONOTONICITY TESTS ARE FOR. The natural spelling of a freshness
 * check — `if (record && ageDays > N) fail` — is GREEN for a node with no
 * record, green for a file that cannot be parsed, and green forever for a
 * record dated into the future. All three are worse failures than a stale
 * record and all three would pass. So the ordering is asserted against
 * `FRESHNESS_SEVERITY` as a table, and each hole is exercised by a fixture that
 * reaches it, because a table nothing reads is a comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './lib/blank-comments.mjs';
import {
	FRESHNESS_SEVERITY,
	FUTURE_SKEW_MS,
	HEALTH_STALE_DAYS,
	WRITER_STALE_DAYS,
	freshnessFindings,
	freshnessVerdict,
	freshnessVerdicts,
	writerVerdict,
} from './check-health-freshness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'check-health-freshness.mjs');
const DAY_MS = 86_400_000;

/**
 * The instant every fixture below is expressed against — read ONCE from the
 * clock rather than written down.
 *
 * An absolute date here would be a fixture whose age changes with the calendar
 * while the threshold it is measured against does not, so a "13.5 days old"
 * record becomes a stale one on a date nobody chose and main reddens with no
 * commit behind it. `fixture-clock-guard.test.mjs` refuses it for exactly that
 * reason and re-runs this suite on a clock shifted +30 and +400 days; anchored
 * here, every fixture moves with it and every verdict is unchanged.
 */
const NOW = Date.now();
const agoDays = (d) => new Date(NOW - d * DAY_MS).toISOString();

/** A served record, as `measured.ts` hands one over. */
const served = (at, from = 'state') => ({ value: { at }, from, stateFile: null });

// ── the ordering, as a property of the table rather than of a branch ─────────

test('absent and unreadable are at least as loud as stale, and fresh is the quietest', () => {
	const s = FRESHNESS_SEVERITY;
	assert.ok(s.fresh < s.stale, 'fresh must be quieter than stale');
	for (const worse of ['dated-in-the-future', 'absent', 'unreadable']) {
		assert.ok(
			s[worse] >= s.stale,
			`${worse} is a worse answer than a stale record and must not be a quieter one — ` +
				'CLAUDE.md: no gate may get EASIER to pass the worse the failure gets'
		);
	}
});

test('every status except fresh blocks on a non-guest node', () => {
	// Driven off the table, so a status added later without a class is caught
	// here rather than by discovering the gate is green on it.
	const cases = {
		stale: served(agoDays(HEALTH_STALE_DAYS + 1)),
		'dated-in-the-future': served(new Date(NOW + 10 * DAY_MS).toISOString()),
		absent: { unavailable: 'no-record-for-node', why: 'no block for this node' },
		unreadable: { unavailable: 'malformed', why: 'health.json is not JSON' },
	};
	assert.deepEqual(
		Object.keys(cases).sort(),
		Object.keys(FRESHNESS_SEVERITY)
			.filter((k) => k !== 'fresh')
			.sort(),
		'every non-fresh status in the severity table needs a fixture that reaches it'
	);
	for (const [status, result] of Object.entries(cases)) {
		const v = freshnessVerdict('claw-1', result, { nowMs: NOW });
		assert.equal(v.status, status, `fixture for ${status} reached ${v.status}`);
		assert.equal(v.class, 'blocking', `${status} must fail the run for a claw`);
		assert.equal(v.severity, FRESHNESS_SEVERITY[status]);
		assert.match(v.why, /claw-1/, 'a finding that does not name the node is undiagnosable');
	}
});

// ── the threshold itself ─────────────────────────────────────────────────────

test('the stale line is where it says it is, on both sides', () => {
	const inside = freshnessVerdict('claw-1', served(agoDays(HEALTH_STALE_DAYS - 0.5)), {
		nowMs: NOW,
	});
	assert.equal(inside.status, 'fresh');
	assert.equal(inside.class, 'advisory');

	const outside = freshnessVerdict('claw-1', served(agoDays(HEALTH_STALE_DAYS + 0.5)), {
		nowMs: NOW,
	});
	assert.equal(outside.status, 'stale');
	assert.match(outside.why, new RegExp(`past ${HEALTH_STALE_DAYS}d`));
});

test('the six records this gate exists for would have failed it', () => {
	// The measured case, 2026-09-26: six nodes on one 2026-09-10 run, 15.7d old,
	// while claw-4/8/9 were inside the line. Expressed as ages rather than dates
	// for the reason the header gives.
	const rotted = 15.7;
	const verdicts = freshnessVerdicts(
		{
			'claw-1': served(agoDays(rotted)),
			'claw-2': served(agoDays(rotted)),
			'claw-3': served(agoDays(rotted)),
			'claw-4': served(agoDays(7.2)),
			'claw-5': served(agoDays(rotted)),
			'claw-6': served(agoDays(rotted)),
			'claw-8': served(agoDays(5.4)),
			'claw-9': served(agoDays(2.5)),
			hokon: served(agoDays(rotted)),
		},
		{ nowMs: NOW }
	);
	const stale = freshnessFindings(verdicts).map((v) => v.node);
	assert.deepEqual(stale, ['claw-1', 'claw-2', 'claw-3', 'claw-5', 'claw-6', 'hokon']);
});

// ── the three holes ──────────────────────────────────────────────────────────

test('a record dated into the future is a failure, not a very fresh record', () => {
	// The hole that never closes on its own: a node whose clock runs a year fast
	// would read as fresh forever, and the worse the skew the safer it looks.
	const v = freshnessVerdict('claw-5', served(new Date(NOW + 365 * DAY_MS).toISOString()), {
		nowMs: NOW,
	});
	assert.equal(v.status, 'dated-in-the-future');
	assert.equal(v.class, 'blocking');

	// A second of ordinary skew is not a broken clock.
	const skewed = freshnessVerdict(
		'claw-5',
		served(new Date(NOW + FUTURE_SKEW_MS / 2).toISOString()),
		{
			nowMs: NOW,
		}
	);
	assert.equal(skewed.status, 'fresh');
});

test('a node with no record is louder than a node with an old one', () => {
	const absent = freshnessVerdict(
		'claw-9',
		{ unavailable: 'no-record-for-node', why: 'health.json has no block for claw-9' },
		{ nowMs: NOW }
	);
	const stale = freshnessVerdict('claw-9', served(agoDays(90)), { nowMs: NOW });
	assert.ok(
		absent.severity > stale.severity,
		'a node nothing has ever measured is less known than one measured 90 days ago'
	);
	assert.equal(absent.reason, 'no-record-for-node', 'the reason must survive onto the finding');
	assert.match(absent.why, /fleet doctor --machine claw-9 --write/, 'and say what to run');
});

test('an unreadable state file is the worst answer, and says which kind', () => {
	for (const reason of ['unreadable', 'malformed']) {
		const v = freshnessVerdict(
			'claw-2',
			{ unavailable: reason, why: `health.json ${reason}` },
			{ nowMs: NOW }
		);
		assert.equal(v.status, 'unreadable');
		assert.ok(v.severity > FRESHNESS_SEVERITY.absent);
		assert.match(v.why, new RegExp(reason), 'the five reasons are five different jobs');
	}
});

test('a record with no usable `at` never falls through to fresh', () => {
	// `measured.ts` rejects this upstream today. The branch exists because if it
	// did not, a null age would meet `null > 14 === false` and the node would
	// read as current — the gate passing hardest on what it understands least.
	for (const at of [undefined, null, 'not-a-date']) {
		const v = freshnessVerdict('claw-6', { value: { at }, from: 'state' }, { nowMs: NOW });
		assert.equal(v.status, 'unreadable', `at=${String(at)} must not read as fresh`);
	}
});

// ── a drain explains an age and does not excuse it ───────────────────────────

test('a drain changes the why and not the verdict', () => {
	const old = served(agoDays(HEALTH_STALE_DAYS + 20));
	const plain = freshnessVerdict('claw-8', old, { nowMs: NOW });
	const drained = freshnessVerdict('claw-8', old, {
		nowMs: NOW,
		drainWhy:
			'This node is drained (drained for maintenance 20d ago: the cooler does not transfer heat).',
	});
	assert.equal(drained.status, plain.status, 'a drain must not soften the verdict');
	assert.equal(drained.class, plain.class);
	assert.match(drained.why, /cooler does not transfer heat/, 'and must carry the reason');
	assert.ok(
		drained.why.length > plain.why.length,
		'the drain is named, so the finding is actionable rather than merely loud'
	);
});

// ── the reader is not the writer ─────────────────────────────────────────────

test('the gate cannot probe a node and cannot write the facet it reads', () => {
	// Structural, and the point of the lane: `doctor --write` is the writer, so a
	// freshness check living inside its write path could not fail. Comments
	// blanked — this file and that one both discuss `writeFacet` in prose, and
	// this repo has read a COMMENT as evidence four times.
	const src = blankComments(readFileSync(GATE, 'utf8'));
	for (const forbidden of ['writeFacet', 'doctorProbe', 'runOn(', 'writeFileSync']) {
		assert.ok(
			!src.includes(forbidden),
			`${forbidden} in the freshness gate: a reader that probes or writes is the ` +
				'verifier-reads-its-own-writer loop CLAUDE.md forbids'
		);
	}
	assert.ok(src.includes('measuredFacets'), 'it must actually read the recorded facet');
});

// ── the I/O half, against scratch directories ────────────────────────────────

const made = [];
process.on('exit', () => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A scratch manifest dir + state dir. Never the live ones. */
function scratch(machines, healthNodes) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-health-freshness-'));
	made.push(dir);
	const mdir = join(dir, 'manifests');
	const state = join(dir, 'state');
	mkdirSync(mdir, { recursive: true });
	mkdirSync(state, { recursive: true });
	writeFileSync(
		join(mdir, 'fleet-runner-manifest.json'),
		`${JSON.stringify({ toolchain: { capabilities: [] }, machines }, null, 2)}\n`
	);
	if (healthNodes !== null) {
		writeFileSync(
			join(state, 'health.json'),
			`${JSON.stringify({ nodes: healthNodes }, null, 2)}\n`
		);
	}
	return { mdir, state };
}

/** Run the gate as a real consumer does: a PIPE, stdout captured, exit code read. */
function run({ mdir, state }, args = []) {
	const env = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (k.startsWith('GIT_')) continue;
		env[k] = v;
	}
	env.FLEET_MANIFEST_DIR = mdir;
	env.HADOKU_STATE_DIR = state;
	try {
		const stdout = execFileSync(process.execPath, [GATE, ...args], {
			env,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status, stdout: err.stdout ?? '' };
	}
}

const CLAW = { labels: ['self-hosted'], maxConcurrent: 1, role: 'claw' };
const GUEST = { labels: ['self-hosted'], maxConcurrent: 1, role: 'guest' };

test('a fresh fleet exits 0; one stale claw exits 1 and names it', () => {
	const fresh = scratch(
		{ 'claw-1': CLAW, 'claw-2': CLAW },
		{ 'claw-1': { at: new Date().toISOString() }, 'claw-2': { at: new Date().toISOString() } }
	);
	assert.equal(run(fresh, ['--json']).code, 0);

	const rotted = scratch(
		{ 'claw-1': CLAW, 'claw-2': CLAW },
		{
			'claw-1': { at: new Date(Date.now() - (HEALTH_STALE_DAYS + 3) * DAY_MS).toISOString() },
			'claw-2': { at: new Date().toISOString() },
		}
	);
	const r = run(rotted, ['--json']);
	assert.equal(r.code, 1, 'a stale record must fail the gate');
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, false);
	assert.equal(doc.blocking, 1);
	assert.deepEqual(
		doc.findings.map((f) => `${f.node}/${f.status}`),
		['claw-1/stale']
	);
});

test('an absent facet file fails at least as hard as a stale one', () => {
	const nothing = scratch({ 'claw-1': CLAW, 'claw-2': CLAW }, null);
	const r = run(nothing, ['--json']);
	assert.equal(r.code, 1, 'no health.json at all is a failure, not a clean fleet');
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.blocking, 2, 'every node, not just one');
	for (const f of doc.findings) {
		assert.equal(f.status, 'absent');
		assert.ok(f.severity >= FRESHNESS_SEVERITY.stale);
	}
});

test("a guest's stale record is reported and does not fail the run", () => {
	const s = scratch(
		{ 'claw-1': CLAW, hokon: GUEST },
		{
			'claw-1': { at: new Date().toISOString() },
			hokon: { at: new Date(Date.now() - 90 * DAY_MS).toISOString() },
		}
	);
	const r = run(s, ['--json']);
	assert.equal(r.code, 0, 'the fleet chain does not page on a guest');
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.advisory, 1);
	assert.equal(doc.findings.length, 1, 'advisory means "does not fail the run", not "dropped"');
	assert.equal(doc.findings[0].node, 'hokon');
	assert.equal(doc.findings[0].role, 'guest');
	assert.equal(doc.findings[0].wasBlocking, true);
});

// ── the writer, judged by its newest record ──────────────────────────────────

test('the writer line sits well inside the per-node line', () => {
	assert.ok(
		WRITER_STALE_DAYS < HEALTH_STALE_DAYS / 2,
		'a stopped writer must page long before 14d'
	);
});

test('the writer verdict reads the NEWEST record, never a guest, and stays quiet with no dates', () => {
	const v = (node, ageDays) => ({ node, ageDays, at: agoDays(ageDays ?? 0) });
	const none = new Set();
	assert.equal(
		writerVerdict([v('claw-1', 20), v('claw-2', 0.5)], none),
		null,
		'one fresh record vouches for the writer'
	);
	const stopped = writerVerdict(
		[v('claw-1', WRITER_STALE_DAYS + 1), v('claw-2', WRITER_STALE_DAYS + 2)],
		none
	);
	assert.equal(stopped.status, 'writer-stopped');
	assert.equal(stopped.class, 'blocking');
	assert.match(stopped.why, /claw-1/, 'it names the newest record');
	assert.notEqual(
		writerVerdict([v('claw-1', WRITER_STALE_DAYS + 1), v('hokon', 0)], new Set(['hokon'])),
		null,
		'a fresh guest record does not vouch for the writer'
	);
	assert.equal(
		writerVerdict([v('claw-1', null)], none),
		null,
		'absent nodes already block on their own'
	);
});

test('nine records from one run four days ago page as a stopped writer, not at day 14', () => {
	const at = new Date(Date.now() - (WRITER_STALE_DAYS + 1) * DAY_MS).toISOString();
	const s = scratch(
		{ 'claw-1': CLAW, 'claw-2': CLAW, hokon: GUEST },
		{ 'claw-1': { at }, 'claw-2': { at }, hokon: { at } }
	);
	const r = run(s, ['--json']);
	assert.equal(r.code, 1, 'a stopped writer fails the gate');
	const doc = JSON.parse(r.stdout);
	assert.deepEqual(
		doc.findings.map((f) => `${f.node}/${f.category}/${f.status}`),
		['(fleet)/health-writer/writer-stopped']
	);
	assert.equal(doc.blocking, 1);
	assert.equal(doc.writerStaleDays, WRITER_STALE_DAYS);
	const one = run(s, ['--json', '--machine', 'claw-1']);
	assert.equal(one.code, 0, 'one node is not the roster, so --machine cannot judge the writer');
});

test('zero nodes selected is a failure, not a clean fleet', () => {
	const s = scratch({ 'claw-1': CLAW }, { 'claw-1': { at: new Date().toISOString() } });
	const r = run(s, ['--machine', 'claw-404', '--json']);
	assert.equal(r.code, 1, 'a typo must not read as a fleet whose records are all current');
	assert.equal(JSON.parse(r.stdout).reason, 'no-nodes-selected');
});

test('the --json document survives a pipe whole', () => {
	// Issue #33: print-then-exit loses everything past 8 KB through a pipe, and
	// every consumer of every gate here is a pipe. Nine nodes of findings is
	// comfortably past the cliff.
	const nodes = {};
	const health = {};
	for (let i = 1; i <= 9; i++) {
		nodes[`claw-${i}`] = CLAW;
		health[`claw-${i}`] = { at: new Date(Date.now() - 60 * DAY_MS).toISOString() };
	}
	const r = run(scratch(nodes, health), ['--json']);
	assert.equal(r.code, 1);
	assert.ok(r.stdout.length > 8192, `payload is ${r.stdout.length}B — too small to prove anything`);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.blocking, 10, 'nine stale nodes, and the writer that let them all go');
});
