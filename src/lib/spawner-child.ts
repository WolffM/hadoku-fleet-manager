/**
 * The spawner's child half: a small Node process that runs `execFile` for the
 * process that forked it, and sends the result back over IPC. See
 * `spawner.ts` for why this exists.
 *
 * It holds no state beyond the requests in flight and imports nothing but
 * `node:child_process`, so its heap stays small and every `fork()` it makes
 * copies little.
 */
import { execFile } from 'node:child_process';

import type { SpawnRequest, SpawnReply } from './spawner.js';

process.on('message', (req: SpawnRequest) => {
	execFile(
		req.file,
		req.args,
		{ timeout: req.timeout, maxBuffer: req.maxBuffer, encoding: 'utf8' },
		(err, stdout, stderr) => {
			const reply: SpawnReply = {
				id: req.id,
				ok: !err,
				stdout: String(stdout ?? ''),
				stderr: String(stderr ?? ''),
				...(err ? { error: err.message } : {}),
			};
			process.send?.(reply);
		}
	);
});

// The parent going away closes the channel. Nothing here is worth finishing
// without it: the replies would have nowhere to go.
process.on('disconnect', () => process.exit(0));
