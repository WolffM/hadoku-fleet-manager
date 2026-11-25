/**
 * Is this module the process's entry point? (fleet-manager#160)
 *
 * The raw form, `import.meta.url === pathToFileURL(process.argv[1]).href`,
 * is FALSE whenever the script is reached through a symlink: Node resolves
 * `import.meta.url` to the real path, while `argv[1]` keeps the path typed.
 * pnpm installs every package behind one (`node_modules/@wolffm/fleet-manager`
 * → `.pnpm/@wolffm+fleet-manager@…`), so from a consumer the script imported
 * fine, skipped `main()`, and exited 0 having printed nothing — a false
 * green, and it ate the #158 io.cost A/B. Both sides are realpath'd here.
 * `scripts/lib/is-main-guard.test.mjs` refuses the raw comparison anywhere.
 */
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} metaUrl the caller's `import.meta.url`
 * @param {string | undefined} [entry] defaults to `process.argv[1]`
 * @returns {boolean}
 */
export function isMain(metaUrl, entry = process.argv[1]) {
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(metaUrl));
	} catch (err) {
		// ENOENT (argv[1] is `-e`/`-` or a deleted path) means "not this file";
		// any other error is real and must not read as "not main".
		if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false;
		throw err;
	}
}
