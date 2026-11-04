/**
 * THE HOSTING SLICE NAME — `<tenant>` → `hosting-<tenant>.slice` — and whether
 * a slice record is ENDING. Both zero-import and declarative.
 *
 * MOVED OUT of `src/runners/hosting-record.ts` (wave layers-3 lane H, cut
 * (iii) layer debt): zero-import and declarative, so it belongs at config,
 * the floor of the stack, rather than at state where `hosting-record.ts`
 * sits (one declared writer of `fleet-hosting.json`, read back by everything
 * else — rule 3 of plan §3.2). `scripts/lib/tenant-registry.mjs` (config)
 * needed the name without reaching UP into state to get it.
 * `hosting-record.ts` re-exports it unchanged, so every existing importer
 * (`hostingSliceCgroup`, `sliceUsageProbe`, `scripts/lib/hosting.mjs`) keeps
 * compiling and behaving byte-identically.
 */

/** The system slice a tenant's resources are served from: `hosting.slice/hosting-<tenant>.slice`. */
export const hostingSliceName = (tenant: string): string => `hosting-${tenant}.slice`;

/**
 * Is this slice ENDING: does it carry an end that releases it? A SHRINK
 * (`shrinkTo` beside `until`) is not an end, because the slice serves at full
 * size until then and is re-declared smaller, never removed. Ending is not
 * LAPSED: a slice that ends in an hour still serves now, but takes no new
 * work that could outlive it. `lapsed` (hosting-record.ts) asks whether that
 * end has passed; tenant-usable asks this. One answer for both, here, at
 * config, where the package-root export can reach it without state.
 */
export const endingSlice = (rec: { until?: string | null; shrinkTo?: unknown }): boolean =>
	Boolean(rec.until) && !rec.shrinkTo;
