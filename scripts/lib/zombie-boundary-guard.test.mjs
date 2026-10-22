import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ZOMBIE_SECONDS } from './queue-health.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * TWO LAYERS, ONE BOUNDARY.
 *
 * The dispatcher decides what to MINT for (`ZOMBIE_MS` in
 * `src/runners/queue-discovery.ts`); this gate decides what to REPORT as
 * stranded rather than as a permanent zombie (`ZOMBIE_SECONDS`, beside this
 * file). Both were written on 2026-09-07, independently, and agreed at 24 h by
 * luck rather than by construction.
 *
 * If they drift, the gate names a run stranded — recoverable, worth acting on —
 * that the dispatcher has already written off as a zombie and will never mint
 * for. That is a finding pointing at work nothing will ever do, which is worse
 * than silence: it is a standing instruction to go and look at something that
 * cannot be fixed.
 *
 * Read from the SOURCE rather than imported, because one side is TypeScript and
 * the other is a plain .mjs the build never touches — the same reason the
 * node-identity guard reads the tree instead of linking against it.
 */
test('the mint ceiling and the report ceiling are the same instant', () => {
	const src = readFileSync(resolve(ROOT, 'src', 'runners', 'queue-discovery.ts'), 'utf8');
	const m = /export const ZOMBIE_MS = ([0-9_]+);/.exec(src);
	assert.ok(m, 'ZOMBIE_MS must stay a literal in queue-discovery.ts for this guard to read');
	const zombieMs = Number(m[1].replace(/_/g, ''));
	assert.equal(
		zombieMs,
		ZOMBIE_SECONDS * 1000,
		`dispatcher ZOMBIE_MS=${zombieMs} vs gate ZOMBIE_SECONDS=${ZOMBIE_SECONDS}s — ` +
			'one of these was changed without the other'
	);
});
