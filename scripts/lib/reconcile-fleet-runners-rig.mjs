/**
 * Shared rig for reconcile-fleet-runners.mjs's test split (wave 5q lane B,
 * whole-block split by concern over this shared rig, following the pattern
 * runner-health's own test split used): the CLI's path and the ambient
 * environment with every `GIT_*` variable stripped (`lib/hook-safe-tests.test.mjs`
 * explains why that matters). Both halves — the "core" reconcile tests
 * (offline/retry/mint/header, their own `gh`/`ssh` shims) and the
 * "--write-coverage"/"--check-coverage" tests (a separate shim and fixture
 * shape) — spawn the SAME CLI, so only this much is actually shared.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `scripts/`, one level up from this file in `scripts/lib/`. */
export const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
export const SCRIPT = join(HERE, 'reconcile-fleet-runners.mjs');

/** The ambient environment with every GIT_* variable removed. */
export const NO_GIT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);
