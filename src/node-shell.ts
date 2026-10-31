/**
 * The library's door onto a node: a command for (node, ROLE), read against the
 * host's manifest. The registry itself is `src/lib/node-users.ts`, which knows
 * nothing about hosts, so the `scripts/` half can use it too.
 *
 * An unreadable manifest THROWS. Falling back to the default user would run a
 * migrated node's CI as admin, the exact thing roles exist to prevent. Every
 * caller already turns a throw into "could not reach the node".
 */
import { readManifestState } from './lib/manifest.js';
import { nodeCommand, type NodeRole, type UserBearingNode } from './lib/node-users.js';

/** This node's manifest entry, as far as users are concerned. */
export function manifestUsers(node: string): UserBearingNode | null {
	const result = readManifestState();
	if (!result.ok) {
		// Preserves the module header's contract: an unreadable manifest THROWS
		// rather than falling back to the default user. Every caller already
		// turns a throw into "could not reach the node".
		throw new Error(`fleet: cannot read the fleet manifest (${result.why})`);
	}
	const machines = result.doc.machines as Record<string, UserBearingNode> | undefined;
	return machines?.[node] ?? null;
}

/** `[bin, argv]` that runs `command` on `node` as `role`: `bash -c` locally, `ssh user@node` otherwise. */
export function nodeShell(
	node: string,
	role: NodeRole,
	command: string,
	self?: string
): [string, string[]] {
	return nodeCommand(node, role, command, manifestUsers(node), { self });
}
