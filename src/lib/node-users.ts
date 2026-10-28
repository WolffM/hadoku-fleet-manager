/**
 * "Which user does this act as on that node?" — asked in ONE place.
 *
 * A node has users by ROLE (operator, 2026-10-27: "a first-party concept and
 * must be respected"). Every piece of code that does something on a node names
 * the ROLE it acts as; only this module turns a role into a name.
 *
 *   admin     the management identity: the controller's ssh, NOPASSWD sudo,
 *             the journal, provisioning, system units, pm2. Never runs a job.
 *   ci        runs every CI job and owns what jobs touch: runner slots, the
 *             runner payload, toolchains, caches, its own systemd manager with
 *             `runners.slice`. No sudo, no docker group, no adm.
 *
 * Tenant agents (cardtable's `cardtable-agent`) are the third kind. They never
 * log in, so nothing ssh's as them, and their names live in the hosting
 * TENANTS table (`scripts/lib/hosting.mjs`).
 *
 * WHY BY ROLE, AND WHY THE SSH LOGIN CARRIES IT. Every CI path on a node works
 * through `$HOME`, `id -u` and `systemctl --user` of whoever logged in. So the
 * login IS the identity, and choosing the login by role makes all of those
 * right at once. Until 2026-10-27 everything logged in as the one user. That
 * made every CI job root on its claw through that user's sudo (cardtable §10,
 * R1). See `docs/planning/node-users-2026-10-27.md`.
 *
 * PER NODE, SO A CUTOVER IS ONE CLAW AT A TIME. `machines.<node>.users.ci`
 * names that node's CI user. Absent means the node has not been migrated, and
 * its CI runs as admin, which is what is true there.
 *
 * `scripts/lib/node-users-guard.test.mjs` fails the build if a user name, a
 * uid-1000 path, or an `id -un` role inference appears anywhere else.
 */
import { userInfo } from 'node:os';

import { isLocalNode } from './node-identity.js';

/** Every role a node's user can play. */
export const NODE_ROLES = ['admin', 'ci'] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

/**
 * The admin user on a node that names none. The one literal name in the
 * package: the claws were all built with it (node-profiles `users.fleetUser`).
 */
export const DEFAULT_ADMIN_USER = 'hadoku';

/** A manifest entry, as far as users are concerned. */
export interface UserBearingNode {
	users?: { admin?: unknown; ci?: unknown };
}

const named = (v: unknown): string | null =>
	typeof v === 'string' && /^[a-z_][a-z0-9_-]*$/.test(v) ? v : null;

/**
 * The name of the user that plays `role` on this node.
 *
 * A malformed name THROWS. A typo that fell back to admin would run every job
 * as the user this concept exists to keep jobs away from.
 */
export function nodeUser(node: UserBearingNode | null | undefined, role: NodeRole): string {
	const users = node?.users;
	for (const r of ['admin', 'ci'] as const) {
		if (users?.[r] !== undefined && !named(users[r]))
			throw new Error(`users.${r} is not a user name: ${JSON.stringify(users[r])}`);
	}
	const admin = named(users?.admin) ?? DEFAULT_ADMIN_USER;
	return role === 'ci' ? (named(users?.ci) ?? admin) : admin;
}

/**
 * The home of the user that plays `role`. Every fleet user is made with
 * useradd's default home, `/home/<name>`, and the node-users facet reads it
 * back. So this is a convention the fleet checks, not a guess.
 */
export function nodeHome(node: UserBearingNode | null | undefined, role: NodeRole): string {
	return `/home/${nodeUser(node, role)}`;
}

/**
 * The ci user a cutover CREATES on a node: admin's name plus `-ci`. Only the
 * cutover asks this; everything after it reads `users.ci` from the manifest.
 */
export function cutoverCiUser(node: UserBearingNode | null | undefined): string {
	return `${nodeUser(node, 'admin')}-ci`;
}

/** Has this node's CI moved off the admin user? */
export function ciIsSeparate(node: UserBearingNode | null | undefined): boolean {
	return nodeUser(node, 'ci') !== nodeUser(node, 'admin');
}

/** ssh options every fleet call uses: never prompt, fail fast. */
export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'] as const;

/**
 * The command that runs `command` on `node` as `role`.
 *
 * Remote: `ssh <user>@<node> <command>`. Local: `bash -c`, because hokon
 * refuses ssh to itself. The process on the controller acts as admin, so a
 * role played by admin runs as-is. A role with its OWN user runs locally only
 * if this process already is that user: switching would need sudo, so a
 * mismatch THROWS rather than run as the wrong user.
 */
export function nodeCommand(
	node: string,
	role: NodeRole,
	command: string,
	machine: UserBearingNode | null | undefined,
	opts: { self?: string; localUser?: string; sshOpts?: readonly string[] } = {}
): [string, string[]] {
	const user = nodeUser(machine, role);
	if (isLocalNode(node, opts.self)) {
		const me = opts.localUser ?? userInfo().username;
		if (user !== nodeUser(machine, 'admin') && me !== user)
			throw new Error(`${node} is this box, which runs as ${me}; acting as ${role} needs ${user}`);
		return ['bash', ['-c', command]];
	}
	return ['ssh', [...(opts.sshOpts ?? SSH_OPTS), `${user}@${node}`, command]];
}
