/**
 * Temp directories that cannot outlive the test process.
 *
 * On 2026-09-27 `/tmp` on hokon held 421,879 entries, 399,868 of them abandoned
 * `mkdtempSync` directories from this suite — 147,879 `rh-snapshot-*` and
 * 147,875 `rh-history-*` alone, accumulated since 2026-09-07. Each one is only
 * 40-60 bytes, so this never showed up as disk usage; what it cost was 400,000
 * dentries in one directory, which is enough that `du -sm /tmp/*` dies with
 * E2BIG and a recursive `find /tmp` does not finish in two minutes.
 *
 * The leak was not that anyone forgot to clean up. `runner-health.test.ts` DID
 * reset the seams it set — it nulled the path pointers in `afterEach` — but the
 * directories those paths pointed into were never removed. Cleanup that depends
 * on each suite remembering an `rmSync` is the arrangement that produced the
 * 400,000; this module exists so the remembering is not required.
 *
 * `tempDir()` registers every directory it hands out and `process.on('exit')`
 * removes whatever is still registered. That backstop is the load-bearing part:
 * it holds when a suite never calls `cleanupTempDirs()`, when an assertion
 * throws past the cleanup, and when a test aborts mid-run. Suites that churn a
 * directory per test should still call `cleanupTempDirs()` from their own
 * `afterEach` so a long file does not carry thousands of live directories to
 * the end of the run — but forgetting that is now a tidiness bug, not a leak.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const registered = new Set<string>();

/** `mkdtempSync` under the OS temp dir, registered for removal. */
export function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	registered.add(dir);
	return dir;
}

/**
 * Remove every directory handed out since the last call.
 *
 * Safe to call from an `afterEach` that may itself throw, and safe to call when
 * nothing is registered. Removal failures are swallowed deliberately: a temp
 * directory that cannot be deleted is not worth failing a green test over, and
 * the exit handler gets a second attempt at it anyway.
 */
export function cleanupTempDirs(): void {
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
