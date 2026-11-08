/**
 * known-down.mjs — the SAFE DIRECTION is the one thing every test here
 * pins: a missing, unreadable, or malformed ledger must always come back as
 * an EMPTY set, never as "everything is down" or a thrown error. And a node
 * must have an actual `lastPage` — the loud page having fired at least
 * once — to count as known-down; a `since` alone (seen offline, but not yet
 * paged) must NOT skip a gate (wave gates1 §A item 4). `lastPage` is ALSO
 * judged for age: past `KNOWN_DOWN_MAX_AGE_MS` it no longer counts either,
 * because the writer may have gone quiet rather than the node having stayed
 * down and watched (manager review, wave gates1 lane A2 fix #3).
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { knownDownNodes, knownDownNote, PAGED_BY, KNOWN_DOWN_MAX_AGE_MS } from './known-down.mjs';

// Anchored to `Date.now()`, never a literal date — see lib/fixture-clock-guard.test.mjs:
// an absolute ISO date in a fixture eventually crosses a retention window
// somewhere and turns green weeks later with nobody touching the file. Most
// of these timestamps are well inside KNOWN_DOWN_MAX_AGE_MS and so are never
// judged stale by `knownDownNodes`; the staleness tests below use their own,
// explicit offsets instead of these shared constants, so any fixed offset
// here is fine.
const SINCE = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
const LAST_PAGE = new Date(Date.now() - 60_000).toISOString();
const SINCE_B = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
const LAST_PAGE_B = new Date(Date.now() - 2 * 60_000).toISOString();

function withLedger(contents, fn) {
	const dir = mkdtempSync(join(tmpdir(), 'known-down-test-'));
	const path = join(dir, 'runner-down-page.json');
	try {
		if (contents !== undefined) writeFileSync(path, contents);
		fn(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('a missing ledger file is an EMPTY set, not a throw', () => {
	withLedger(undefined, (path) => {
		const down = knownDownNodes({ path });
		assert.equal(down.size, 0);
	});
});

test('an unparseable ledger is an EMPTY set', () => {
	withLedger('{ not json', (path) => {
		const down = knownDownNodes({ path });
		assert.equal(down.size, 0);
	});
});

test('a ledger that parses to a non-object (array, primitive) is an EMPTY set', () => {
	withLedger('[1,2,3]', (path) => {
		assert.equal(knownDownNodes({ path }).size, 0);
	});
	withLedger('"just a string"', (path) => {
		assert.equal(knownDownNodes({ path }).size, 0);
	});
	withLedger('null', (path) => {
		assert.equal(knownDownNodes({ path }).size, 0);
	});
});

test('a node record with `since` and `lastPage` is a known-down node, `since` is first-offline', () => {
	withLedger(JSON.stringify({ 'claw-9': { since: SINCE, lastPage: LAST_PAGE } }), (path) => {
		const down = knownDownNodes({ path });
		assert.equal(down.size, 1);
		const entry = down.get('claw-9');
		assert.ok(entry, 'claw-9 must be present');
		assert.equal(entry.node, 'claw-9');
		assert.equal(entry.since, SINCE, 'since is the FIRST-offline time, not the last page');
		assert.equal(entry.pagedBy, PAGED_BY);
	});
});

test('a node record with `since` but NO `lastPage` (not yet paged) is NOT known-down', () => {
	withLedger(JSON.stringify({ 'claw-9': { since: SINCE } }), (path) => {
		assert.equal(knownDownNodes({ path }).size, 0);
	});
});

test('a node record whose `lastPage` is not a string is NOT known-down', () => {
	withLedger(JSON.stringify({ 'claw-9': { since: SINCE, lastPage: 12345 } }), (path) => {
		assert.equal(knownDownNodes({ path }).size, 0);
	});
});

test('a record that is not an object (array, primitive, null) is ignored', () => {
	withLedger(JSON.stringify({ 'claw-9': 'offline', 'claw-5': null, 'claw-2': [1] }), (path) => {
		assert.equal(knownDownNodes({ path }).size, 0);
	});
});

test('an unparseable `since` is ignored even when `lastPage` is present', () => {
	withLedger(JSON.stringify({ 'claw-9': { since: 'not a date', lastPage: LAST_PAGE } }), (path) => {
		assert.equal(knownDownNodes({ path }).size, 0);
	});
});

test('a missing `since` falls back to `lastPage` rather than dropping the node', () => {
	withLedger(JSON.stringify({ 'claw-9': { lastPage: LAST_PAGE } }), (path) => {
		const down = knownDownNodes({ path });
		assert.equal(down.get('claw-9')?.since, LAST_PAGE);
	});
});

test('two down nodes are both reported, independently', () => {
	withLedger(
		JSON.stringify({
			'claw-9': { since: SINCE, lastPage: LAST_PAGE },
			'claw-5': { since: SINCE_B, lastPage: LAST_PAGE_B },
		}),
		(path) => {
			const down = knownDownNodes({ path });
			assert.equal(down.size, 2);
			assert.ok(down.has('claw-9'));
			assert.ok(down.has('claw-5'));
		}
	);
});

test('a mix of paged and not-yet-paged nodes reports only the paged one', () => {
	withLedger(
		JSON.stringify({
			'claw-9': { since: SINCE, lastPage: LAST_PAGE },
			'claw-5': { since: SINCE_B }, // seen offline, not yet 2h / still drained — no page
		}),
		(path) => {
			const down = knownDownNodes({ path });
			assert.equal(down.size, 1);
			assert.ok(down.has('claw-9'));
			assert.ok(!down.has('claw-5'));
		}
	);
});

// ── manager fix #3: a stale `lastPage` stops counting ──────────────────────

test('a 26h-old lastPage is NOT known-down — the writer may have stopped', () => {
	const now = Date.now();
	const staleSince = new Date(now - 30 * 60 * 60_000).toISOString();
	const staleLastPage = new Date(now - 26 * 60 * 60_000).toISOString();
	withLedger(
		JSON.stringify({ 'claw-9': { since: staleSince, lastPage: staleLastPage } }),
		(path) => {
			assert.equal(knownDownNodes({ path, now }).size, 0);
		}
	);
});

test('a 1h-old lastPage IS known-down — well inside the 24h re-page cadence', () => {
	const now = Date.now();
	const freshSince = new Date(now - 3 * 60 * 60_000).toISOString();
	const freshLastPage = new Date(now - 60 * 60_000).toISOString();
	withLedger(
		JSON.stringify({ 'claw-9': { since: freshSince, lastPage: freshLastPage } }),
		(path) => {
			const down = knownDownNodes({ path, now });
			assert.equal(down.size, 1);
			assert.ok(down.has('claw-9'));
		}
	);
});

test('KNOWN_DOWN_MAX_AGE_MS is the 24h re-page cadence plus one hour of slack', () => {
	assert.equal(KNOWN_DOWN_MAX_AGE_MS, 25 * 60 * 60_000);
});

test('a lastPage exactly at the bound counts; one past it does not', () => {
	const now = Date.now();
	const since = new Date(now - 30 * 60 * 60_000).toISOString();
	withLedger(
		JSON.stringify({
			'at-bound': { since, lastPage: new Date(now - KNOWN_DOWN_MAX_AGE_MS).toISOString() },
			'past-bound': {
				since,
				lastPage: new Date(now - KNOWN_DOWN_MAX_AGE_MS - 1000).toISOString(),
			},
		}),
		(path) => {
			const down = knownDownNodes({ path, now });
			assert.ok(down.has('at-bound'), 'exactly at the bound still counts');
			assert.ok(!down.has('past-bound'), 'one second past the bound does not');
		}
	);
});

/**
 * MUTATION (manager fix #3): dropping the staleness bound must fail this
 * file's own staleness tests — proven directly against the real module
 * rather than asserted only in prose, matching the style of the sanity test
 * below. (The actual revert/restore against the SOURCE is done by hand
 * during review, same as every other mutation check in this wave; this test
 * only pins the OBSERVABLE behaviour the bound must produce.)
 */
test('sanity: staleness is judged, not merely documented — a 26h-old page is excluded while a 1h-old one is not', () => {
	const now = Date.now();
	const since = new Date(now - 30 * 60 * 60_000).toISOString();
	withLedger(
		JSON.stringify({
			stale: { since, lastPage: new Date(now - 26 * 60 * 60_000).toISOString() },
			fresh: { since, lastPage: new Date(now - 60 * 60_000).toISOString() },
		}),
		(path) => {
			const down = knownDownNodes({ path, now });
			assert.equal(down.size, 1);
			assert.ok(down.has('fresh'));
			assert.ok(!down.has('stale'));
		}
	);
});

test('knownDownNote names the node, since, and the pager', () => {
	const line = knownDownNote({ node: 'claw-9', since: SINCE, pagedBy: PAGED_BY });
	assert.match(line, /claw-9/);
	assert.ok(line.includes(SINCE));
	assert.match(line, /runner-health/);
});

/**
 * MUTATION CHECK (§A item 4, read at the module level): a helper that
 * ALWAYS returns empty must be distinguishable from one that reads the
 * ledger. This is the gate every one of the "a down node is known-down"
 * tests above already is — if `knownDownNodes` were stubbed to return
 * `new Map()` unconditionally, the paged/two-node tests above would all
 * fail (0 !== 1, `.get(...)` undefined), and the "missing/malformed ledger"
 * and "not yet paged" tests would still pass (they expect `size === 0`
 * already). That asymmetry is the point: the safe direction costs nothing to
 * prove at the empty end and is the ONLY thing that can go wrong at the
 * non-empty end.
 */
test('sanity: a ledger with a real paged entry is never confused with an absent one', () => {
	withLedger(JSON.stringify({ 'claw-9': { since: SINCE, lastPage: LAST_PAGE } }), (path) => {
		assert.notEqual(knownDownNodes({ path }).size, 0);
	});
});
