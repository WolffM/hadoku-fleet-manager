/**
 * Where this package's CLI finds things that are NOT part of the package.
 *
 * THE ANSWERS MOVED TO `src/lib/fleet-paths.ts`; this file is the scripts-half
 * door onto them. `src/cli.ts` has to name which tree answered (issue #4) and
 * `tsconfig.json` sets no `allowJs`, so the CLI cannot import this file — the
 * only alternative to moving it was a SECOND implementation of `siteRoot()`,
 * which is the isLocalNode failure over again. Same pattern `fleet-exec.mjs`
 * already uses for `isLocalNode`: import the BUILT copy, so the library and the
 * scripts cannot drift apart because there is only one implementation to drift
 * from. A source checkout that has not been built fails LOUDLY on this import.
 *
 * `PKG_SCRIPTS` stays here and cannot move: it is `__dirname` arithmetic over
 * THIS file's location, and the same expression evaluated in `dist/lib/` would
 * point at `dist/`.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export { reposDir, siteRoot, manifestDir, manifest, stateDir } from '../../dist/lib/fleet-paths.js';

/** This package's own `scripts/` directory — a sibling asset, not operator config. */
export const PKG_SCRIPTS = dirname(fileURLToPath(new URL('.', import.meta.url)));
