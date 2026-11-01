/**
 * The GitHub-budget SECTION of the `GET /fleet` contract (wave 5r lane A
 * pure move out of `fleet-report-types.ts`): one token's hourly budget as
 * GitHub last reported it, with who in this process spent it (#119). See
 * that file's own header for why this is a type-only barrel's section
 * rather than a runtime module — `fleet-report-types.ts` re-exports every
 * name below for every existing importer.
 *
 * `GhCaller`/`FleetGithubBudget` moved to `gh-budget.ts` (wave clean-1 lane
 * C, cut (iii)): that access-layer module is their real owner
 * (`withGhCaller`'s scope sets one, `getGhBudgetSnapshot` builds the other
 * from its own state), and this file importing them from there, rather than
 * the other way round, is the legal direction. Re-exported here under their
 * original path for every existing importer.
 */
export type { GhCaller, FleetGithubBudget } from './gh-budget.js';
