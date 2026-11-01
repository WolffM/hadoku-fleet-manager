/**
 * Shared fixtures for the `ephemeral.ts`/`ephemeral-tick.ts` test split —
 * wave 5r lane D (`src/tests/ephemeral.test.ts` under the 1,000-line test
 * ceiling, pure move over a rig).
 *
 * `BASE` is the one fixture BOTH halves need: `src/tests/ephemeral.test.ts`
 * (naming, admission, space, jitconfig safety) and
 * `src/tests/ephemeral-tick.test.ts` (dispatch, per-repo reserves, backstop
 * minting) share one test — "ADMISSION reads the repo figure" — that
 * exercises `admitMint` together with a per-repo `jobReserve` figure, so it
 * needs the admission base alongside that file's own `CAP`/`PYGMALION`.
 */

export const BASE = {
	liveUnits: 0,
	standingBusy: 0,
	maxConcurrent: 3,
	freeMb: 6000,
	requiredMb: 900,
	minFreeMb: 1536,
};
