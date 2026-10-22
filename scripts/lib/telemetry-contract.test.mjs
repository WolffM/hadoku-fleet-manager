/**
 * EVERY CLOSED ENUM ON THE WIRE MUST ARRIVE DESCRIBED — enforced, not remembered.
 *
 * `telemetry-vocabulary.ts` ships `{ kind, description }` for the report's
 * enums so a consumer never has to hold an opinion about what a state MEANS.
 * That scheme has one weakness and it is not in any of the code it replaced: it
 * depends entirely on the next person remembering to add a registry when they
 * add an enum. `Record<Union, TelemetryTerm>` makes an UNDESCRIBED MEMBER fail
 * to compile; nothing whatever makes an UNDESCRIBED UNION fail.
 *
 * That is the same shape as every other silent-drift bug this repo has fixed.
 * A new enum ships, the panel meets a value it has never seen, `term()` returns
 * neutral with no description, and the column renders as a blank that looks
 * like a styling bug rather than a missing contract. Nothing is red. The
 * command station is a different repo and cannot notice.
 *
 * So this reads the contract's SOURCE and requires each string-literal union to
 * be either registry-backed in `FleetVocabulary` or exempted below with a
 * reason. A stale exemption is itself a failure, for the reason
 * check-header-fleet gives about its own allowlist: an exemption nobody can
 * justify is one nobody dares delete.
 *
 * WHAT THIS CANNOT PROVE. That a description is any GOOD. `telemetry-vocabulary
 * .test.ts` checks they are non-empty and load-bearing; a sentence that is
 * accurate today and wrong next month is a code review's job, not a gate's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACT = join(ROOT, 'src', 'fleet-report-types.ts');
const REGISTRY = join(ROOT, 'src', 'telemetry-vocabulary.ts');

/**
 * Unions that legitimately carry no `TelemetryTerm` registry.
 *
 * Keep this SHORT and keep every entry justified. An exemption is a decision
 * that a reader of the payload does not need this enum explained, and that is
 * rarely true — the two below are the only cases found when the rule was first
 * enforced, out of seven unions.
 */
const EXEMPT = {
	TelemetryKind:
		'It IS the severity axis every TelemetryTerm is made of. Describing it ' +
		'with a TelemetryTerm would be circular — the registry would have to ' +
		'explain the vocabulary it is written in. A consumer maps it onto its own ' +
		'palette exhaustively, so a sixth severity fails that build instead.',
	CapabilityKind:
		'Reaches the wire only as `vocabulary.labels[].kind`, beside that label’s ' +
		'own `description` — which is what a reader renders. It groups labels ' +
		'(identity vs eligibility) rather than describing one, so the per-label ' +
		'line already carries the meaning a panel shows. NOTE the field is named ' +
		'`kind` and is NOT a TelemetryKind, which is the one genuinely confusing ' +
		'thing in this payload; if it ever gains a consumer, describe it or ' +
		'rename it rather than leaving both true.',
};

const contract = blankComments(readFileSync(CONTRACT, 'utf8'));

/** Every exported string-literal union in the contract. */
function stringUnions(src) {
	return [...src.matchAll(/export type (\w+)\s*=\s*((?:[^;]|\n)*?);/g)]
		.filter((m) => m[2].includes("'"))
		.map((m) => m[1]);
}

/** Unions `FleetVocabulary` ships a description table for. */
function registryBacked(src) {
	const at = src.indexOf('export interface FleetVocabulary');
	assert.notEqual(at, -1, 'FleetVocabulary has been renamed — this gate reads it by name');
	return [...src.slice(at).matchAll(/Record<(\w+), \w*Term>/g)].map((m) => m[1]);
}

test('every enum on the wire is described, or exempted with a reason', () => {
	const backed = new Set(registryBacked(contract));
	const undescribed = stringUnions(contract).filter((u) => !backed.has(u) && !(u in EXEMPT));
	assert.deepEqual(
		undescribed,
		[],
		`These unions travel in the payload with nothing describing them:\n  ` +
			`${undescribed.join(', ')}\n` +
			`Add a registry in src/telemetry-vocabulary.ts and a ` +
			`\`Record<${undescribed[0] ?? 'X'}, TelemetryTerm>\` field to FleetVocabulary, ` +
			`or add an EXEMPT entry here saying why a reader does not need it explained.`
	);
});

test('an exemption that no longer names a real union is a failure', () => {
	// The allowlist rule from check-header-fleet: an entry that has stopped
	// matching anything is not harmless, it is a claim nobody has checked since
	// the thing it described was deleted.
	const unions = new Set(stringUnions(contract));
	const stale = Object.keys(EXEMPT).filter((u) => !unions.has(u));
	assert.deepEqual(stale, [], `EXEMPT names unions the contract no longer declares: ${stale}`);
});

test('an exemption that has since GAINED a registry is a failure', () => {
	// Belt and braces the other way: leaving a stale exemption beside a real
	// registry makes the list read as "these are undescribed" when they are not.
	const backed = new Set(registryBacked(contract));
	const redundant = Object.keys(EXEMPT).filter((u) => backed.has(u));
	assert.deepEqual(redundant, [], `EXEMPT lists unions that ARE described: ${redundant}`);
});

test('every exemption carries a real justification, not a placeholder', () => {
	for (const [union, why] of Object.entries(EXEMPT)) {
		assert.ok(
			why.trim().length > 40,
			`EXEMPT.${union} has no usable reason — "because" is not a decision`
		);
	}
});

test('every registry FleetVocabulary promises is actually declared', () => {
	// The half the type system misses in the other direction: `FleetVocabulary`
	// declaring `Record<X, TelemetryTerm>` (or a `…Term` extending it) is a promise about the WIRE, and the
	// const that fills it lives in another file. A field added here and never
	// populated there is caught by tsc at the route — but only if the route is
	// the thing that fills it, and a future default or spread would hide that.
	const registry = blankComments(readFileSync(REGISTRY, 'utf8'));
	const missing = registryBacked(contract).filter(
		(u) => !new RegExp(`Record<${u}, \\w*Term>`).test(registry)
	);
	assert.deepEqual(
		missing,
		[],
		`FleetVocabulary promises a table for these, and telemetry-vocabulary.ts declares none: ${missing}`
	);
});
