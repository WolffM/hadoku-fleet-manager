/**
 * The one `execFile` both halves of the spawner run (`spawner.ts` directly,
 * `spawner-child.ts` in the helper). A leaf: it imports only
 * `node:child_process`, so the helper that loads it stays small, and every
 * `fork()` the helper makes copies little.
 */
import { execFile } from 'node:child_process';

export interface ExecResult {
	ok: boolean;
	/** The exit code; null when it never exited normally (timeout, signal, no such file). */
	code: number | null;
	stdout: string;
	stderr: string;
	error?: string;
}

/** The exit code `execFile`'s callback reports: a number for an exit, else not one. */
export function exitCodeOf(err: (Error & { code?: unknown }) | null): number | null {
	if (!err) return 0;
	return typeof err.code === 'number' ? err.code : null;
}

/** `execFile` with `input` on stdin, settled as an {@link ExecResult}. Shared by both sides. */
export function execFileWithInput(
	file: string,
	args: readonly string[],
	opts: { timeout: number; maxBuffer: number; input?: string },
	done: (r: ExecResult) => void
): void {
	const child = execFile(
		file,
		[...args],
		{ timeout: opts.timeout, maxBuffer: opts.maxBuffer, encoding: 'utf8' },
		(err, stdout, stderr) =>
			done({
				ok: !err,
				code: exitCodeOf(err),
				stdout: String(stdout ?? ''),
				stderr: String(stderr ?? ''),
				// `killed` is execFile's own timeout firing: say so, not "Command failed".
				...(err
					? {
							error: (err as { killed?: boolean }).killed
								? `timed out after ${opts.timeout / 1000} s`
								: err.message,
						}
					: {}),
			})
	);
	// A command that exits without reading stdin closes the pipe under us.
	child.stdin?.on('error', () => undefined);
	child.stdin?.end(opts.input ?? '');
}
