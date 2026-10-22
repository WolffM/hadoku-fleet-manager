/**
 * sibling-repos — where the other repos are.
 *
 * A PUBLISHED SUBPATH EXPORT (`@wolffm/fleet-manager/sibling-repos`);
 * hadoku_site's `scripts/admin/check-key-sync.mjs` imports `reposDir` by that
 * name, so this module specifier is a contract even though the implementation
 * moved.
 *
 * The implementation is `src/lib/fleet-paths.ts` — `siteRoot()` falls back to
 * `reposDir()`, and `src/cli.ts` needs `siteRoot()` for the provenance banner,
 * so the whole chain had to be reachable from TypeScript. The reasoning that
 * kept `reposDir` from being a one-liner is in that file, with the four
 * disagreeing copies it replaced.
 */
export { reposDir } from '../../dist/lib/fleet-paths.js';
