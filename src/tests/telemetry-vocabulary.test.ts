/**
 * THE REPORT'S ENUMS MUST ARRIVE DESCRIBED.
 *
 * `Record<Union, TelemetryTerm>` already makes an undescribed state fail tsc, so
 * these tests do not re-check completeness of the literal — they check the two
 * things a type cannot:
 *
 *   1. that the descriptions are real, so "shipped" is not satisfied by an
 *      empty string that renders as a blank tooltip and reads as no drift;
 *   2. that the registries survive the JOIN into the payload, which is where a
 *      filter or a spread can drop rows without any type complaining.
 *
 * The consumer-side half of this contract cannot be tested from here — the
 * command station is another repo — so the property that matters is that
 * everything a reader could need is on the wire. If it is, a panel holding its
 * own copy is a choice rather than a necessity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFleetReport } from '../routes/fleet.js';
import { mintBudget } from '../runners/ephemeral.js';
import {
	ADMISSION_BASES,
	ADMISSION_CAVEATS,
	BACKSTOP_REASONS,
	CLAW_STATES,
} from '../telemetry-vocabulary.js';
import type { JobHistorySummary } from '../job-history.js';
import type { TelemetryKind, TelemetryTerm } from '../fleet-report-types.js';

const NO_JOBS: JobHistorySummary = {
	since: null,
	total: 0,
	byMachine: [],
	byRepo: [],
	daily: [],
	backstopJobs: 0,
	backstopShare: 0,
	recent: [],
	recentSince: '2026-09-09T00:00:00.000Z',
	recentWindowSec: 3600,
};

const KINDS: TelemetryKind[] = ['ok', 'reserve', 'degraded', 'fault', 'unknown'];

const REGISTRIES: Record<string, Record<string, TelemetryTerm>> = {
	states: CLAW_STATES,
	backstopReasons: BACKSTOP_REASONS,
	admissionBases: ADMISSION_BASES,
	admissionCaveats: ADMISSION_CAVEATS,
};

test('every term carries a real description and a known kind', () => {
	for (const [registry, terms] of Object.entries(REGISTRIES)) {
		for (const [id, term] of Object.entries(terms)) {
			assert.ok(
				term.description.trim().length > 10,
				`${registry}.${id} has no usable description — a blank tooltip is drift that looks clean`
			);
			assert.ok(KINDS.includes(term.kind), `${registry}.${id} has kind "${term.kind}"`);
		}
	}
});

test('no term ships a TONE — presentation stays in the consumer', () => {
	// A `kind` is severity; `warning`/`danger`/`success` are a palette. Shipping
	// the second would make this package responsible for how a browser looks,
	// and would re-create the coupling the registry exists to remove.
	const PALETTE = ['success', 'warning', 'danger', 'neutral', 'info'];
	for (const terms of Object.values(REGISTRIES)) {
		for (const term of Object.values(terms)) {
			assert.ok(!PALETTE.includes(term.kind as string), `"${term.kind}" is a tone, not a kind`);
		}
	}
});

test('the registries survive the join into the payload', () => {
	// The route could filter, spread or shadow these and nothing above would
	// complain — this is the assertion that a reader can actually READ them.
	const r = buildFleetReport(null, null, {}, NO_JOBS);
	const v = r.vocabulary;
	assert.deepEqual(Object.keys(v.states).sort(), Object.keys(CLAW_STATES).sort());
	assert.deepEqual(Object.keys(v.backstopReasons).sort(), Object.keys(BACKSTOP_REASONS).sort());
	assert.deepEqual(Object.keys(v.admissionBases).sort(), Object.keys(ADMISSION_BASES).sort());
	assert.deepEqual(Object.keys(v.admissionCaveats).sort(), Object.keys(ADMISSION_CAVEATS).sort());
	assert.equal(v.states.unreachable.kind, 'unknown', 'unreachable is not a zero');
	assert.equal(v.states.demoted.kind, 'reserve', 'a demoted node is held back, not broken');
	assert.equal(v.backstopReasons.none.kind, 'ok', 'an idle backstop is the system working');
});

// ── one budget, two readers ─────────────────────────────────────────────────
//
// `ephemeral-tick` mints against this and `routes/fleet` reports it. They were
// two expressions of one rule and they disagreed on the fallback, which is why
// the panel could print nothing for a node the dispatcher was minting on.

test('a declared cap is used verbatim, and says so', () => {
	assert.deepEqual(mintBudget({ maxConcurrent: 3 }), {
		slots: 3,
		basis: 'declared',
	});
});

test('a node bounded by nothing still mints one at a time, never zero', () => {
	// Refusing to mint would make an under-declared node indistinguishable from a
	// broken one; the tick has always ended `?? 1`.
	assert.deepEqual(mintBudget({}), { slots: 1, basis: 'default' });
});

// ── the capacity breakdown ──────────────────────────────────────────────────
//
// The reshape's whole claim is that a fourth way of becoming available is a ROW
// and not a cross-repo rename. These pin the properties that claim rests on.

test('every capacity row the builder emits is described', () => {
	// A row with numbers and no words is half data: the figure travels and the
	// meaning stays behind, which is exactly what made the scalars a rename.
	const r = buildFleetReport(null, null, {}, NO_JOBS);
	for (const row of r.fleet.capacity.byKind) {
		const t = r.vocabulary.capacityKinds[row.kind];
		assert.ok(t, `capacity row "${row.kind}" has no term — a reader cannot label it`);
		assert.ok(t.description.trim().length > 10, `capacity row "${row.kind}" has no description`);
	}
});

test('an unmeasured row makes the TOTAL unmeasured, not a partial sum', () => {
	// A partial sum presented as a total is the same lie `?? 0` was one level
	// down: it reads as a measurement and is a floor.
	const r = buildFleetReport(null, null, { 'claw-9': { ephemeral: true } } as never, NO_JOBS);
	assert.equal(r.fleet.capacity.unmeasured, true, 'no probe means no reading');
	assert.equal(r.fleet.capacity.free, null, 'and no reading means no total');
});

test('a row is never silently dropped when its figure is null', () => {
	// The failure this shape replaces: a scalar that is null looks like a scalar
	// that is absent. A row must still be PRESENT and say null.
	const r = buildFleetReport(null, null, {}, NO_JOBS);
	const kinds = r.fleet.capacity.byKind.map((k) => k.kind).sort();
	assert.deepEqual(kinds, ['immediate', 'mintable']);
});

test('no capacity row is emitted that the registry does not declare', () => {
	// The reverse of the first test, and the one that catches a row added to the
	// builder without a term — which would render as a blank, unlabelled column.
	const r = buildFleetReport(null, null, {}, NO_JOBS);
	const declared = new Set(Object.keys(r.vocabulary.capacityKinds));
	for (const row of r.fleet.capacity.byKind) {
		assert.ok(declared.has(row.kind), `"${row.kind}" is emitted but not declared`);
	}
});
