/**
 * Read all of stdin, synchronously, whatever kind of descriptor it is.
 *
 * `readFileSync(0)` throws EAGAIN when fd 0 is NON-BLOCKING and the writer has
 * not written yet. A parent decides that, not this process: spawnSync's `input`
 * is a non-blocking socketpair, and `enroll-node.test.mjs` failed on it
 * intermittently (2026-10-28). Reopening `/dev/stdin` is not the fix either: a
 * socket cannot be opened by path (ENXIO). So this loops on `readSync`, waits
 * out EAGAIN, and throws anything else: the stdin twin of `keepStdoutWhole`.
 */
import { readSync } from 'node:fs';

const WAIT = new Int32Array(new SharedArrayBuffer(4));

export function readStdinWhole() {
	const chunks = [];
	const buf = Buffer.alloc(64 * 1024);
	for (;;) {
		let n;
		try {
			n = readSync(0, buf, 0, buf.length, null);
		} catch (err) {
			if (err.code !== 'EAGAIN') throw err;
			Atomics.wait(WAIT, 0, 0, 10);
			continue;
		}
		if (n === 0) break;
		chunks.push(Buffer.from(buf.subarray(0, n)));
	}
	return Buffer.concat(chunks).toString('utf8');
}
