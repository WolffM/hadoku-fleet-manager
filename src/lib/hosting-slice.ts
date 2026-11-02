/**
 * THE HOSTING SLICE NAME — `<tenant>` → `hosting-<tenant>.slice`, nothing else.
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
