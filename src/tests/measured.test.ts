/**
 * `src/lib/measured.ts` — where `$benchmark` and `$health` live since Wave 3h.
 *
 * Every test points the state dir at its OWN temp directory, passed explicitly
 * as `dir`. None relies on the `stateDir()` default: on hokon that resolves to
 * `~/.hadoku-mgmt`, the live state dir, and a test that wrote there would be
 * writing the fleet's record.
 *
 * The rule under test, in one line: a missing or unreadable file is "could not
 * look" (a gate) or "due" (a writer), NEVER "healthy" — and the reason is
 * carried, because five different absences are five different jobs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { missingMeasuredFiles } from '../host.js';
import {
	MANIFEST_KEY,
	MEASURED_FACETS,
	facetLogPath,
	facetPath,
	markProofStale,
	measuredFacet,
	measuredFacets,
	mergeFacet,
	readFacetFile,
	readProof,
	readProofsForCapability,
	writeFacet,
	writeProof,
	type FacetFileRead,
	type FacetRecord,
	type MeasuredResult,
	type ProofRecord,
} from '../lib/measured.js';

const made: string[] = [];
process.on('exit', () => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A fresh, EXISTING, empty state dir. */
function stateFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-measured-'));
	made.push(dir);
	return dir;
}

const rec = (at: string, extra: Record<string, unknown> = {}): FacetRecord => ({
	at,
	by: 'fleet test',
	...extra,
});

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

function valueOf(r: MeasuredResult): { value: FacetRecord; from: string } {
	assert.ok('value' in r, `expected a value, got ${JSON.stringify(r)}`);
	return r;
}

function reasonOf(r: MeasuredResult): string {
	assert.ok('unavailable' in r, `expected unavailable, got ${JSON.stringify(r)}`);
	return r.unavailable;
}

// ── the declaration ──────────────────────────────────────────────────────────

test('three facets live in the state dir; each names its manifest key, even $proof which never had one', () => {
	assert.deepEqual([...MEASURED_FACETS], ['benchmark', 'health', 'proof']);
	assert.deepEqual(MANIFEST_KEY, { benchmark: '$benchmark', health: '$health', proof: '$proof' });
});

test('the files are <dir>/<facet>.json and <dir>/<facet>.log — no `$` in the name', () => {
	assert.equal(facetPath('benchmark', '/s'), '/s/benchmark.json');
	assert.equal(facetPath('health', '/s'), '/s/health.json');
	assert.equal(facetLogPath('health', '/s'), '/s/health.log');
});

test('a facet that STAYED in the manifest is refused, not silently given a file', () => {
	assert.throws(
		() => facetPath('capabilities' as never, '/s'),
		/\$capabilities and \$measured stay in the manifest/
	);
});

// ── reading: every "could not look" carries its reason ───────────────────────

test('no state dir -> no-state-dir', () => {
	const r = readFacetFile('benchmark', { dir: join(stateFixture(), 'absent') });
	assert.equal(r.ok, false);
	assert.equal(!r.ok && r.reason, 'no-state-dir');
});

test('state dir, no file -> no-file', () => {
	const r = readFacetFile('benchmark', { dir: stateFixture() });
	assert.equal(!r.ok && r.reason, 'no-file');
});

test('a file that is not JSON -> malformed, with the parser error', () => {
	const dir = stateFixture();
	writeFileSync(join(dir, 'health.json'), '{ nope');
	const r = readFacetFile('health', { dir });
	assert.equal(!r.ok && r.reason, 'malformed');
	assert.match(!r.ok ? r.why : '', /not JSON/);
});

test('JSON without a `nodes` object -> malformed', () => {
	const dir = stateFixture();
	writeFileSync(join(dir, 'health.json'), JSON.stringify({ machines: {} }));
	assert.equal(readFacetFile('health', { dir }).ok, false);
});

test('ONE bad node block makes the whole file malformed — never a partial read', () => {
	// A partially trusted file would let the bad node read as never-measured,
	// which is a different job from unreadable.
	const dir = stateFixture();
	writeFileSync(
		join(dir, 'benchmark.json'),
		JSON.stringify({ nodes: { good: rec(ago(1)), bad: { by: 'x' } } })
	);
	const r = readFacetFile('benchmark', { dir });
	assert.equal(!r.ok && r.reason, 'malformed');
	assert.match(!r.ok ? r.why : '', /the block for bad carries no `at`/);
});

test('an unparseable `at` is malformed too — every staleness rule reads it', () => {
	const dir = stateFixture();
	writeFileSync(join(dir, 'benchmark.json'), JSON.stringify({ nodes: { n: rec('yesterday') } }));
	assert.equal(readFacetFile('benchmark', { dir }).ok, false);
});

test('a directory where the file should be -> unreadable, not malformed', () => {
	const dir = stateFixture();
	mkdirSync(join(dir, 'health.json'));
	const r = readFacetFile('health', { dir });
	assert.equal(!r.ok && r.reason, 'unreadable');
});

// ── the merge (S §2.3 rule 3) ────────────────────────────────────────────────

const ok = (nodes: Record<string, FacetRecord>): FacetFileRead => ({
	ok: true,
	path: '/s/benchmark.json',
	nodes,
});
const absent: FacetFileRead = {
	ok: false,
	path: '/s/benchmark.json',
	reason: 'no-file',
	why: 'absent',
};

test('state only -> state; manifest only -> manifest, and it SAYS the state file was absent', () => {
	const s = valueOf(mergeFacet('n', 'benchmark', {}, ok({ n: rec(ago(3)) })));
	assert.equal(s.from, 'state');
	const m = mergeFacet('n', 'benchmark', { $benchmark: rec(ago(3)) }, absent);
	assert.equal(valueOf(m).from, 'manifest');
	assert.equal('stateFile' in m && m.stateFile, 'no-file');
});

test('both -> the STATE copy wins only when STRICTLY newer by `at`', () => {
	const newer = mergeFacet(
		'n',
		'benchmark',
		{ $benchmark: rec(ago(5), { v: 'manifest' }) },
		ok({ n: rec(ago(1), { v: 'state' }) })
	);
	assert.equal(valueOf(newer).value.v, 'state');

	const older = mergeFacet(
		'n',
		'benchmark',
		{ $benchmark: rec(ago(1), { v: 'manifest' }) },
		ok({ n: rec(ago(5), { v: 'state' }) })
	);
	assert.equal(valueOf(older).value.v, 'manifest');

	const at = ago(2);
	const tie = mergeFacet(
		'n',
		'benchmark',
		{ $benchmark: rec(at, { v: 'manifest' }) },
		ok({ n: rec(at, { v: 'state' }) })
	);
	assert.equal(valueOf(tie).value.v, 'manifest', 'a tie is not strictly newer');
});

test('the merge reads the facet by ITS manifest key — $health is not $benchmark', () => {
	const r = mergeFacet('n', 'health', { $benchmark: rec(ago(1)) }, absent);
	assert.equal(reasonOf(r), 'no-file');
});

test('an UNREADABLE or MALFORMED state file is unavailable even when the manifest has a copy', () => {
	// It may hold a NEWER record than the manifest. Serving the manifest's would
	// present a possibly stale reading as the current one.
	for (const reason of ['unreadable', 'malformed'] as const) {
		const r = mergeFacet(
			'n',
			'benchmark',
			{ $benchmark: rec(ago(1)) },
			{ ok: false, path: '/s/benchmark.json', reason, why: 'broken' }
		);
		assert.equal(reasonOf(r), reason);
	}
});

test('nothing anywhere -> the FILE reason when the file is absent, no-record-for-node when it is fine', () => {
	assert.equal(reasonOf(mergeFacet('n', 'benchmark', {}, absent)), 'no-file');
	assert.equal(reasonOf(mergeFacet('n', 'benchmark', undefined, absent)), 'no-file');
	assert.equal(
		reasonOf(mergeFacet('n', 'benchmark', {}, ok({ other: rec(ago(1)) }))),
		'no-record-for-node'
	);
});

test('a manifest block with no usable `at` is malformed, not never-measured', () => {
	const r = mergeFacet('n', 'benchmark', { $benchmark: { by: 'x' } }, absent);
	assert.equal(reasonOf(r), 'malformed');
});

test('measuredFacets reads the file once and answers for every node in the roster', () => {
	const dir = stateFixture();
	writeFileSync(join(dir, 'health.json'), JSON.stringify({ nodes: { a: rec(ago(1)) } }));
	const { file, nodes } = measuredFacets(
		'health',
		{ a: {}, b: { $health: rec(ago(2)) }, c: {} },
		{ dir }
	);
	assert.equal(file.ok, true);
	assert.equal(valueOf(nodes.a).from, 'state');
	assert.equal(valueOf(nodes.b).from, 'manifest');
	assert.equal(reasonOf(nodes.c), 'no-record-for-node');
	assert.equal(valueOf(measuredFacet('a', 'health', { dir })).from, 'state');
});

// ── writing ──────────────────────────────────────────────────────────────────

test('a writer creates a MISSING state dir and file — absence is "due", not an error', () => {
	const dir = join(stateFixture(), 'not-yet');
	const w = writeFacet('benchmark', { n: rec(ago(0), { cpu: 1 }) }, { dir });
	assert.equal(w.ok, true);
	const back = readFacetFile('benchmark', { dir });
	assert.equal(back.ok && back.nodes.n.cpu, 1);
});

test('a write MERGES — a node not named keeps its block (the unreachable-node rule)', () => {
	const dir = stateFixture();
	writeFacet('health', { kept: rec(ago(9), { v: 'old' }), replaced: rec(ago(9)) }, { dir });
	writeFacet('health', { replaced: rec(ago(0), { v: 'new' }) }, { dir });
	const back = readFacetFile('health', { dir });
	assert.ok(back.ok);
	assert.equal(back.nodes.kept.v, 'old');
	assert.equal(back.nodes.replaced.v, 'new');
});

test('a MALFORMED file is REFUSED, never overwritten', () => {
	const dir = stateFixture();
	writeFileSync(join(dir, 'health.json'), '{ half a doc');
	const w = writeFacet('health', { n: rec(ago(0)) }, { dir });
	assert.equal(w.ok, false);
	assert.equal(!w.ok && w.reason, 'malformed');
	assert.equal(readFileSync(join(dir, 'health.json'), 'utf8'), '{ half a doc');
	assert.equal(
		existsSync(join(dir, 'health.log')),
		false,
		'no log line for a write that did not happen'
	);
});

test('a record with no `at` is refused before anything is touched', () => {
	const dir = stateFixture();
	const w = writeFacet('health', { n: { by: 'x' } as unknown as FacetRecord }, { dir });
	assert.equal(!w.ok && w.reason, 'invalid-record');
	assert.equal(existsSync(join(dir, 'health.json')), false);
});

test('every write appends one dated, digested line per node to <facet>.log — never rewrites it', () => {
	const dir = stateFixture();
	writeFacet('benchmark', { a: rec(ago(1)), b: rec(ago(1)) }, { dir, extra: { a: { raw: 'x' } } });
	writeFacet('benchmark', { a: rec(ago(0)) }, { dir });
	const lines = readFileSync(join(dir, 'benchmark.log'), 'utf8')
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	assert.deepEqual(
		lines.map((l) => l.node),
		['a', 'b', 'a']
	);
	for (const l of lines) {
		assert.equal(l.facet, 'benchmark');
		assert.match(String(l.digest), /^[0-9a-f]{16}$/);
		assert.equal(typeof l.loggedAt, 'string');
		assert.ok(l.record, 'the log keeps the whole record — it is the history now');
	}
	assert.equal(lines[0].raw, 'x');
	assert.equal(lines[1].raw, undefined);
});

// ── the host's boot check (S §2.3 rule 2, declared optional until §4 step 7) ─

test('the host names each facet file that is absent — declared, not yet required', () => {
	const dir = stateFixture();
	assert.deepEqual(
		missingMeasuredFiles({ stateDir: dir }).map((m) => m.split(' ')[0]),
		['benchmark', 'health', 'proof']
	);
	writeFileSync(join(dir, 'health.json'), JSON.stringify({ nodes: {} }));
	assert.deepEqual(
		missingMeasuredFiles({ stateDir: dir }).map((m) => m.split(' ')[0]),
		['benchmark', 'proof']
	);
});

// ── $proof (wave 4e, #102) ───────────────────────────────────────────────────

const proofRec = (over: Partial<ProofRecord> = {}): ProofRecord => ({
	node: 'claw-4',
	capability: 'jdk21',
	runId: 1,
	runner: 'jit-claw-4-proof-x-j0-r0-1',
	conclusion: 'success',
	durationSec: 300,
	evidenceMatched: true,
	budgetSec: null,
	verdict: 'pass',
	why: 'pass (budget unbootstrapped: 0/2 proven node(s))',
	at: ago(1),
	...over,
});

test('readProof is null for every "could not look" reason, never a crash', () => {
	const dir = stateFixture();
	assert.equal(readProof('claw-4', 'jdk21', { dir: join(dir, 'absent') }), null, 'no state dir');
	assert.equal(readProof('claw-4', 'jdk21', { dir }), null, 'no file');
	writeFileSync(join(dir, 'proof.json'), '{ nope');
	assert.equal(readProof('claw-4', 'jdk21', { dir }), null, 'malformed');
});

test('writeProof then readProof round-trips, keyed by (node, capability) — not by node alone', () => {
	const dir = stateFixture();
	const rec = proofRec();
	const w = writeProof(rec, { dir });
	assert.equal(w.ok, true);
	assert.deepEqual(readProof('claw-4', 'jdk21', { dir }), rec);
	assert.equal(
		readProof('claw-4', 'maven', { dir }),
		null,
		'a different capability is a different record'
	);
	assert.equal(
		readProof('claw-8', 'jdk21', { dir }),
		null,
		'a different node is a different record'
	);
});

test('writeProof MERGES — a second node/capability does not erase the first', () => {
	const dir = stateFixture();
	writeProof(proofRec({ node: 'claw-4' }), { dir });
	writeProof(proofRec({ node: 'claw-8', runId: 2 }), { dir });
	assert.equal(readProof('claw-4', 'jdk21', { dir })?.runId, 1);
	assert.equal(readProof('claw-8', 'jdk21', { dir })?.runId, 2);
});

test('readProofsForCapability is the fleet-wide view, filtered to the one capability, empty when unreadable', () => {
	const dir = stateFixture();
	assert.deepEqual(readProofsForCapability('jdk21', { dir }), []);
	writeProof(proofRec({ node: 'claw-4' }), { dir });
	writeProof(proofRec({ node: 'claw-8', runId: 2 }), { dir });
	writeProof(proofRec({ node: 'claw-9', capability: 'other', runId: 3 }), { dir });
	assert.deepEqual(
		readProofsForCapability('jdk21', { dir })
			.map((r) => r.node)
			.sort(),
		['claw-4', 'claw-8']
	);
	writeFileSync(join(dir, 'proof.json'), '{ nope');
	assert.deepEqual(
		readProofsForCapability('jdk21', { dir }),
		[],
		'unreadable is empty, not a throw'
	);
});

test('markProofStale keeps every other field and restamps `at` to NOW, not the original proof time', () => {
	const dir = stateFixture();
	const original = proofRec({ at: ago(10) });
	writeProof(original, { dir });
	const now = new Date();
	const w = markProofStale('claw-4', 'jdk21', 'diverged from claw-8 on the same commit', {
		dir,
		now,
	});
	assert.equal(w.ok, true);
	const after = readProof('claw-4', 'jdk21', { dir });
	assert.equal(after?.verdict, 'stale');
	assert.equal(after?.why, 'diverged from claw-8 on the same commit');
	assert.equal(after?.at, now.toISOString());
	assert.equal(after?.runId, original.runId, 'the rest of the record survives the mark');
	assert.equal(after?.runner, original.runner);
});

test('markProofStale on a node with no proof is a `no-proof` failure, never a throw', () => {
	const dir = stateFixture();
	const w = markProofStale('claw-4', 'jdk21', 'no record exists', { dir });
	assert.equal(w.ok, false);
	assert.equal(!w.ok && w.reason, 'no-proof');
	assert.match(!w.ok ? w.why : '', /nothing has looked/);
});
