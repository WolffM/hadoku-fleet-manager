/**
 * The minters a node runs, sent WITH the command that runs them.
 *
 * jit-provision.sh used to be copied onto each minting node by `fleet throttle`
 * and run from there, while warm-provision.sh already travelled with its call.
 * A node copy is a second source: on 2026-10-27 hokon's was a release behind,
 * because the deploy that writes it skips hokon by role. Nothing is kept on the
 * node now. The text is read from THIS package, so a node always runs the
 * minter the controller was built with.
 *
 * Both minters build their slots from one payload, and runner-payload.sh holds
 * the functions that do it. It is sent ahead of the minter in the same script.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type NodeScript = 'jit-provision.sh' | 'warm-provision.sh';

// dist/runners/node-script.js -> dist -> package root -> scripts/.
const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

/** The whole program a node runs for `name`: the payload library, then the minter. */
export function nodeScriptText(name: NodeScript): string {
	return (
		readFileSync(resolve(SCRIPTS, 'runner-payload.sh'), 'utf8') +
		readFileSync(resolve(SCRIPTS, name), 'utf8')
	);
}

/**
 * One shell command that runs `name` with `assignments` (already shell-safe
 * leading `K='v'` words) as its environment. Base64 keeps the script's own
 * quoting out of the command line, and `bash -c` needs no temp file, so two
 * mints on one node cannot overwrite each other's copy. `name` is `$0`, which
 * is also what the fake shells in the tests match on.
 */
export function nodeScriptCommand(name: NodeScript, assignments: string): string {
	const b64 = Buffer.from(nodeScriptText(name), 'utf8').toString('base64');
	return `${assignments} bash -c "$(printf %s '${b64}' | base64 -d)" ${name}`;
}
