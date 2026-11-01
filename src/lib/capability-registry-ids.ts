/**
 * The capability registry's shared label ids and entry-building helpers —
 * wave 5r lane D split of `capability-registry.ts` (pure move).
 *
 * A LEAF MODULE, DELIBERATELY. `capability-registry-label.ts` needs
 * `BUILDER_LABEL`/`PM2_HOST_LABEL`/`BACKSTOP_LABEL` (as the `id` of three
 * entries) and `MUST_BE_EPHEMERAL`/`THROTTLE_FIELDS` (as `requires` data),
 * and `capability-registry.ts` assembles `CAPABILITIES` from
 * `capability-registry-label.ts`. If these five lived in
 * `capability-registry.ts` instead, that import would close a cycle
 * (`capability-registry.ts` → `capability-registry-label.ts` →
 * `capability-registry.ts`) and the VALUE read across it would hit the
 * exact TDZ throw the comment below already warns about — so they sit here,
 * where nothing imports this module except by its own name, and
 * `capability-registry.ts` re-exports the three label ids for the many
 * external importers that read them from there.
 */

import type { RequiredFact, RequiredField } from './capability-registry.js';

export const MUST_BE_EPHEMERAL: RequiredFact = {
	id: 'ephemeral',
	why:
		'the canary is a job NO standing runner can serve, which is the only thing that proves ' +
		'minting works. A standing runner carrying this label would answer the canary without ' +
		'minting anything, so it would stay green through a total dispatcher outage. It also ' +
		'lies to the label floor, which counts a standing online runner carrying a label as ' +
		'SERVING it: the floor would read the canary label as served by a registration that ' +
		'proves nothing about minting.',
	holds: (m) => m.ephemeral === true,
};

export const THROTTLE_FIELDS: RequiredField[] = [
	{
		field: 'maxConcurrent',
		why:
			'`fleet throttle` writes MAX_CONCURRENT straight from this field. Undefined renders ' +
			'as the literal string `undefined`, ci-throttle.sh rejects the non-numeric value and ' +
			'falls through to MAX_CONCURRENT=99 — no limit, silently, on a node general CI ' +
			'lands on.',
	},
	{
		field: 'minFreeMb',
		why:
			'same path: undefined becomes MIN_FREE_MB=0, so the node will start a job with ' +
			'no memory left. That is the state that OOM-killed two jobs on claw-2 on 2026-08-24.',
	},
];

// Identity/eligibility label ids, as literals, so importers keep the narrow type
// they had when these were declared inline in census.ts.
//
// DECLARED ABOVE THE REGISTRY, and that position is load-bearing: the registry
// entries below NAME these rather than spelling the the same three strings a second
// time, and a `const` referenced before its declaration in the same module is a
// TDZ throw at import, not a lint warning. Two spellings of one label is how
// `hokon-backstop` came to exist in census.ts and in neither set in
// check-capabilities.mjs — the exact split this file was written to close.
export const BUILDER_LABEL = 'hadoku-builder';
export const PM2_HOST_LABEL = 'pm2-host';
export const BACKSTOP_LABEL = 'hokon-backstop';
