import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	emptyRequiredSetReason,
	parseDemandLedger,
	sameCapabilityRecord,
	unprovenRequired,
	loadDemandLedger,
} from './bootcamp-required.mjs';

// ── parseDemandLedger ───────────────────────────────────────────────────

test('parseDemandLedger: one record per line, blank lines skipped', () => {
	const text = [
		'{"repo":"a","capabilities":["ffmpeg"]}',
		'',
		'{"repo":"b","capabilities":[]}',
		'',
	].join('\n');
	assert.deepEqual(parseDemandLedger(text), [
		{ repo: 'a', capabilities: ['ffmpeg'] },
		{ repo: 'b', capabilities: [] },
	]);
});

test('parseDemandLedger: a malformed line THROWS rather than being skipped', () => {
	// "I could not look" must never render as "nothing is wrong" — a ledger
	// this cannot fully read must not silently under-count demand.
	//
	// THE PATTERN IS THE GUARD, not the bare `throws`. This assertion was
	// pattern-less until 2026-09-14 and a regression to the old implementation
	// stayed green under it: the old one mapped `JSON.parse` over each line, so
	// it threw all right, and said nothing about WHICH line of WHICH file.
	//
	// A PREDICATE, NOT A RegExp. `assert.throws` runs a RegExp against
	// `String(err)` — which is prefixed `Error: ` — so an anchored pattern
	// fails against a message that is in fact correct, and un-anchoring it
	// would stop the assertion proving the path comes FIRST.
	assert.throws(
		() => parseDemandLedger('{"repo":"a"}\nnot json\n'),
		(err) => err.message.startsWith('demand-ledger.jsonl line 2 is not JSON ')
	);
});

test('parseDemandLedger: the reported line is the FILE’s, not the parser’s', () => {
	// The exact regression, with the exact input shape that hid it. `{bad}` is
	// near-JSON, so `JSON.parse` produces a POSITION — and parsing one line at a
	// time makes that position relative to the line, so a row two lines into the
	// file reported "(line 1 column 2)". Measured on the live 222-line ledger
	// with row 137 broken; an operator handed that goes looking at the top of the
	// file for a row that is not there. CLAUDE.md: a reason that is wrong is as
	// unactionable as a reason that was discarded.
	assert.throws(
		() => parseDemandLedger('{"repo":"a"}\n{bad}\n', '/var/state/demand-ledger.jsonl'),
		(err) => {
			assert.match(err.message, /^\/var\/state\/demand-ledger\.jsonl line 2 is not JSON /);
			// The parser's own position is CARRIED, not discarded — it is what
			// points at the column inside the line — so the message holds both
			// numbers and has to say which is which.
			assert.match(err.message, /line 1 column 2/);
			assert.match(err.message, /relative to that LINE, not to the file/);
			return true;
		}
	);
});

test('parseDemandLedger: empty text is zero records, not an error', () => {
	assert.deepEqual(parseDemandLedger(''), []);
});

// ── unprovenRequired ─────────────────────────────────────────────────────

const KNOWN = new Set(['python-toolcache', 'playwright', 'ffmpeg']);

test('unprovenRequired: a required id some node proves is not a gap', () => {
	const machines = {
		'claw-1': { $capabilities: { prereqs: [{ id: 'python-toolcache', detail: 'ok' }] } },
	};
	assert.deepEqual(unprovenRequired(new Set(['python-toolcache']), machines, KNOWN), []);
});

test('unprovenRequired: a required id NO node proves is a gap', () => {
	const machines = {
		'claw-1': { $capabilities: { prereqs: [{ id: 'ffmpeg' }] } },
	};
	assert.deepEqual(unprovenRequired(new Set(['python-toolcache']), machines, KNOWN), [
		'python-toolcache',
	]);
});

test('unprovenRequired: an id the registry does not know is ALWAYS a gap', () => {
	// docker is demand-derivable and, at zero demand today, unregistered — it
	// can never appear in any node's prereqs, so it is a gap by construction.
	const machines = {
		'claw-1': { $capabilities: { prereqs: [{ id: 'python-toolcache' }, { id: 'docker' }] } },
	};
	assert.deepEqual(unprovenRequired(new Set(['docker']), machines, KNOWN), ['docker']);
});

test('unprovenRequired: a node with no bootcamp finding proves nothing, silently', () => {
	const machines = { hokon: {}, 'claw-1': { $capabilities: {} } };
	assert.deepEqual(unprovenRequired(new Set(['ffmpeg']), machines, KNOWN), ['ffmpeg']);
});

test('unprovenRequired: an empty required set has no gaps regardless of machines', () => {
	assert.deepEqual(unprovenRequired(new Set(), {}, KNOWN), []);
});

test('unprovenRequired: a missing machines object does not throw', () => {
	assert.deepEqual(unprovenRequired(new Set(['ffmpeg']), undefined, KNOWN), ['ffmpeg']);
});

// ── jdk21 (cardtable#5, added 2026-10-05): an OPTIONAL capability, judged with no special case ──
//
// `jdk21` only earns the general pool's required set if the demand ledger
// ever actually asks for it there — it does not today (`requiredIdentitySet`
// in src/capabilities.ts; no covered repo's general-pool job demands it). This
// file has no business knowing that: it is pure I/O over whatever `required`
// it is handed, exactly like `av1-nvenc`, `cargo-bevy` or any other
// differentiator capability — the point this test pins.
test('jdk21 is judged by unprovenRequired exactly like any other optional capability — no special case', () => {
	const KNOWN_WITH_JDK = new Set(['python-toolcache', 'playwright', 'ffmpeg', 'jdk21']);
	// Not in `required` (today's shape: no general-pool row asks for it), so it
	// is never even checked — the SAME reason av1-nvenc never appears here.
	assert.deepEqual(unprovenRequired(new Set(['python-toolcache']), {}, KNOWN_WITH_JDK), [
		'python-toolcache',
	]);
	// If the required set ever did ask for it, a claw whose bootcamp record
	// proves it closes the gap exactly like any other id would.
	const machines = { 'claw-4': { $capabilities: { prereqs: [{ id: 'jdk21' }] } } };
	assert.deepEqual(unprovenRequired(new Set(['jdk21']), machines, KNOWN_WITH_JDK), []);
	// And a claw that has not proven it is a gap, same as any other id.
	const unproven = { 'claw-4': { $capabilities: { prereqs: [{ id: 'ffmpeg' }] } } };
	assert.deepEqual(unprovenRequired(new Set(['jdk21']), unproven, KNOWN_WITH_JDK), ['jdk21']);
});

// ── loadDemandLedger ───────────────────────────────────────────────────────

test('loadDemandLedger: a missing file is null, not a throw', () => {
	assert.equal(loadDemandLedger('/nonexistent/path/demand-ledger.jsonl'), null);
});

test('loadDemandLedger: reads and parses a real file', () => {
	const dir = mkdtempSync(join(tmpdir(), 'demand-ledger-'));
	const file = join(dir, 'demand-ledger.jsonl');
	writeFileSync(file, '{"repo":"a","capabilities":["ffmpeg"]}\n');
	try {
		assert.deepEqual(loadDemandLedger(file), [{ repo: 'a', capabilities: ['ffmpeg'] }]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('loadDemandLedger: a file that exists but will not parse THROWS', () => {
	const dir = mkdtempSync(join(tmpdir(), 'demand-ledger-'));
	const file = join(dir, 'demand-ledger.jsonl');
	writeFileSync(file, 'not json\n');
	try {
		assert.throws(() => loadDemandLedger(file));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('loadDemandLedger: the finding names the RESOLVED path it actually read', () => {
	// The other half of the fix, and its own regression: `parseDemandLedger`
	// defaults the path to the bare filename, so a `loadDemandLedger` that
	// forgot to pass the path it opened would still name a file — the wrong
	// one, with no directory. `check-label-floor`'s `ledger-unreadable` branch
	// prints this message verbatim, and `stateDir()` is injected, so the
	// directory is the part that says WHICH ledger the gate was looking at.
	const dir = mkdtempSync(join(tmpdir(), 'demand-ledger-'));
	const file = join(dir, 'demand-ledger.jsonl');
	writeFileSync(file, '{"repo":"a"}\n{"repo":"b"}\n{bad}\n');
	try {
		// A predicate, not a RegExp: the path is generated and must not be
		// re-parsed as a pattern.
		assert.throws(
			() => loadDemandLedger(file),
			(err) => err.message.startsWith(`${file} line 3 is not JSON `)
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── the guest skip ──────────────────────────────────────────────────────────

test('unprovenRequired: a GUEST proves nothing for the fleet', () => {
	// hokon is out of scope for bootcamp's required set (operator, 2026-09-14),
	// and counting it would let the one machine that never takes general CI be
	// the sole proof of a capability every claw is supposed to carry.
	const machines = {
		'claw-1': { role: 'claw', $capabilities: { prereqs: [{ id: 'ffmpeg' }] } },
		hokon: {
			role: 'guest',
			$capabilities: { prereqs: [{ id: 'ffmpeg' }, { id: 'python-toolcache' }] },
		},
	};
	const ids = new Set(['ffmpeg', 'python-toolcache']);
	assert.deepEqual(unprovenRequired(new Set(['ffmpeg', 'python-toolcache']), machines, ids), [
		'python-toolcache',
	]);
});

test('unprovenRequired: MUTATION — the SAME node as a claw closes the gap', () => {
	// The control. Without it the test above could pass because the fixture is
	// simply short of a proof, rather than because the role was read.
	const machines = {
		'claw-1': { role: 'claw', $capabilities: { prereqs: [{ id: 'ffmpeg' }] } },
		hokon: {
			role: 'claw',
			$capabilities: { prereqs: [{ id: 'ffmpeg' }, { id: 'python-toolcache' }] },
		},
	};
	const ids = new Set(['ffmpeg', 'python-toolcache']);
	assert.deepEqual(unprovenRequired(new Set(['ffmpeg', 'python-toolcache']), machines, ids), []);
});

test('unprovenRequired: a node with NO role is still counted — absence is not exemption', () => {
	const machines = { 'claw-1': { $capabilities: { prereqs: [{ id: 'ffmpeg' }] } } };
	assert.deepEqual(unprovenRequired(new Set(['ffmpeg']), machines, new Set(['ffmpeg'])), []);
});

// ── emptyRequiredSetReason ──────────────────────────────────────────────────

test('emptyRequiredSetReason: a set with content is no finding', () => {
	assert.equal(emptyRequiredSetReason(new Set(['ffmpeg'])), null);
});

test('emptyRequiredSetReason: an empty set is a finding, and says what it read', () => {
	const records = [
		{ class: 'resident', app: 'mgmt-api' },
		{ class: 'resident', app: 'tunnel' },
	];
	const why = emptyRequiredSetReason(new Set(), { path: '/tmp/demand-ledger.jsonl', records });
	assert.match(why, /EMPTY/);
	assert.match(why, /\/tmp\/demand-ledger\.jsonl/, 'it must name the file');
	assert.match(why, /2 row\(s\), 0 of them CI demand/, 'a truncated ledger and an all-resident');
	assert.match(why, /tool-inventory --write/, 'and it must say how to fix it');
});

test('emptyRequiredSetReason: a missing/undefined set is also a finding', () => {
	// `null` and `undefined` reach this the same way an empty Set does, and both
	// mean the caller has no bar to enforce. Neither may read as a pass.
	assert.ok(emptyRequiredSetReason(undefined));
	assert.ok(emptyRequiredSetReason(null));
});

// ── sameCapabilityRecord (issue #59) ────────────────────────────────────────
//
// `bootcamp --write` lands its record as a COMMIT on hadoku_site, and
// hadoku_site redeploys mgmt-api on a change to that file. A record whose only
// moving part is its own timestamp therefore restarted the production API once
// per run. Observed on claw-9 on 2026-09-23: two commits eleven minutes apart,
// one changed line each, and the line was `at`.

// ANCHORED TO `Date.now()`, never a literal date. `sameCapabilityRecord` never
// parses `at` — it removes it — so a literal could not rot behind a
// retention window here. `fixture-clock-guard` bans them anyway, and it is
// right to: the way an absolute fixture date reddens main months later is
// that a LATER reader learns to parse the field nobody was parsing.
const LAST_TIME = new Date(Date.now() - 12 * 60_000).toISOString();
const THIS_TIME = new Date(Date.now() - 60_000).toISOString();
const LATER = new Date(Date.now()).toISOString();

const RECORD = Object.freeze({
	at: LAST_TIME,
	by: 'fleet bootcamp',
	declared: [],
	earned: ['ffmpeg', 'gh', 'rust'],
	unclaimed: ['cargo-bevy'],
	unearned: [],
	blocked: [],
	prereqs: [{ id: 'ffmpeg', detail: '7.1.5-0+deb13u1' }],
	unprobed: [],
});

test('a re-probe that found the same thing is the SAME record, whatever the clock says', () => {
	assert.equal(sameCapabilityRecord(RECORD, { ...RECORD, at: THIS_TIME }), true);
});

test('`at` still advances when the finding really changes', () => {
	// Each of these is a different statement about the node, and each is worth a
	// commit — which is the half a naive "never rewrite the record" fix loses.
	const changes = [
		{ earned: ['ffmpeg', 'gh'] },
		{ unclaimed: [] },
		{ unearned: [{ id: 'pm2-host', detail: 'no pm2 on PATH' }] },
		{ blocked: [{ id: 'gh', detail: 'missing' }] },
		{ unprobed: ['playwright'] },
		{ declared: ['taskauto'] },
		{ prereqs: [{ id: 'ffmpeg', detail: '7.2.0-1' }] },
		// PROVENANCE IS SUBSTANTIVE. `by` is constant today, which is exactly why
		// comparing it costs nothing; a record that changed hands is a change to
		// what the manifest asserts.
		{ by: 'fleet capabilities' },
	];
	for (const change of changes) {
		assert.equal(
			sameCapabilityRecord(RECORD, { ...RECORD, ...change, at: LATER }),
			false,
			`a change to ${Object.keys(change)[0]} must not read as unchanged`
		);
	}
});

test('key order is not a change — a manifest reformat must not manufacture a commit', () => {
	const shuffled = Object.fromEntries(Object.entries(RECORD).reverse());
	assert.equal(sameCapabilityRecord(shuffled, RECORD), true);
	// ...but ARRAY order is. `earned` is sorted and the rest follow the
	// registry's declaration order, so a reordering means something upstream
	// moved, and that is a fact worth recording rather than noise to smooth over.
	assert.equal(
		sameCapabilityRecord(RECORD, { ...RECORD, earned: ['rust', 'gh', 'ffmpeg'] }),
		false
	);
});

test('a node with no record yet is never "the same" — its first one must be written', () => {
	for (const prev of [undefined, null, {}, [], 'x', 0]) {
		assert.equal(sameCapabilityRecord(prev, RECORD), false, `${JSON.stringify(prev)} matched`);
	}
});
