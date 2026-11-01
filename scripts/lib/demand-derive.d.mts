/**
 * Minimal TYPE companion for `demand-derive.mjs` (F13), so `src/label-floor.ts`
 * — a `.ts` file under `tsconfig.json`'s `include: ["src/**\/*.ts"]`, which sets
 * no `allowJs` — can import this plain `.mjs` without either an `any` leak or a
 * `rootDir` violation. A sibling `.d.mts` is Node/TS's own supported way to type
 * an otherwise-untyped ESM module; `tsc` resolves it for the TYPE CHECK only and
 * never adds `demand-derive.mjs` itself to the compiled program, so it stays
 * outside `rootDir` with no error. The real import specifier is preserved
 * verbatim in `dist/label-floor.js`, and Node resolves it at runtime exactly as
 * written — the same `../scripts/lib/...` relative path, one directory up from
 * `dist/` (which mirrors `src/` 1:1) to the repo root.
 *
 * ONLY the two exports `label-floor.ts` reads are declared. Not exhaustive —
 * add the rest here if another `.ts` file ever imports more.
 */
export const HOSTED_RE: RegExp;
export const HOSTED_PREFIX_RE: RegExp;
