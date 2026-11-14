/**
 * The spawner's child half: a small Node process that runs `execFile` for the
 * process that forked it, and sends the result back over IPC. See
 * `spawner.ts` for why this exists.
 *
 * It holds no state beyond the requests in flight. Its one runtime import is
 * the leaf `spawner-exec.ts` (a type-only import of `spawner.ts` is erased),
 * so its heap stays small and every `fork()` it makes copies little.
 */
import { execFileWithInput } from './spawner-exec.js';
import type { SpawnRequest } from './spawner.js';

process.on('message', (req: SpawnRequest) =>
	execFileWithInput(req.file, req.args, req, (r) => process.send?.({ id: req.id, ...r }))
);

// The parent going away closes the channel. Nothing here is worth finishing
// without it: the replies would have nowhere to go.
process.on('disconnect', () => process.exit(0));
