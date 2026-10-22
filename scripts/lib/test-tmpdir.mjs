/**
 * Temp directories that cannot outlive the test process — the `scripts/` half.
 *
 * Same contract and the same reasoning as `src/tests/tmpdir.ts`; see that file
 * for the 400,000-directory incident this pair exists to prevent. Two copies
 * because the two suites run in different worlds: the TypeScript tests execute
 * from `dist/tests/` after a build, these `.mjs` tests execute from the source
 * tree, and reaching into `dist/` from `scripts/` would make the script suite
 * depend on a build having happened first.
 *
 * Importing this module is what installs the exit handler, so a suite opts in by
 * calling `tempDir()` instead of `mkdtempSync` and needs nothing else.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const registered = new Set();

/** `mkdtempSync` under the OS temp dir, registered for removal. */
export function tempDir(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	registered.add(dir);
	return dir;
}

/**
 * Remove every directory handed out since the last call.
 *
 * Safe to call from cleanup that may itself throw, and safe when nothing is
 * registered. Removal failures are swallowed deliberately: a temp directory
 * that cannot be deleted is not worth failing a green test over, and the exit
 * handler gets a second attempt at it anyway.
 */
export function cleanupTempDirs() {
	for (const dir of registered) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best effort; see above
		}
	}
	registered.clear();
}

process.on('exit', cleanupTempDirs);
