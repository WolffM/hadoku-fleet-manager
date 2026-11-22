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
 *   dev       runs the operator's interactive agent sessions (a Claude
 *             session under herdr) on a node that hosts them (operator,
 *             2026-11-19). No sudo, never a CI job. Its whole user slice is
 *             the sessions' cgroup, weighted below CI's. Only this role holds
 *             an operator credential on a claw, and only in a process
 *             environment. `fleet node-users --dev <node>` creates it;
 *             `docs/planning/claw-sessions-2026-11-19.md` is the record.
 *
 * Tenant agents (cardtable's `cardtable-agent`) are the fourth kind. They never
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
 * its CI runs as admin, which is what is true there. `users.dev` is per node
 * the same way, but its absence means something else: the node hosts NO
 * sessions, and asking for its dev user THROWS. There is no admin fallback,
 * because that would start a session with NOPASSWD sudo.
 *
 * `scripts/lib/node-users-guard.test.mjs` fails the build if a user name, a
 * uid-1000 path, or an `id -un` role inference appears anywhere else.
 */
import { userInfo } from 'node:os';

import { isLocalNode } from './node-identity.js';

/** Every role a node's user can play. */
export const NODE_ROLES = ['admin', 'ci', 'dev'] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

/**
 * The admin user on a node that names none. The one literal name in the
 * package: the claws were all built with it (node-profiles `users.fleetUser`).
 */
export const DEFAULT_ADMIN_USER = 'hadoku';

/** A manifest entry, as far as users are concerned. */
export interface UserBearingNode {
	users?: { admin?: unknown; ci?: unknown; dev?: unknown };
}

const named = (v: unknown): string | null =>
	typeof v === 'string' && /^[a-z_][a-z0-9_-]*$/.test(v) ? v : null;

/**
 * The name of the user that plays `role` on this node.
 *
 * A malformed name THROWS. A typo that fell back to admin would run every job
 * as the user this concept exists to keep jobs away from. So does `dev` on a
 * node that names none, or names admin's or ci's user: a session never shares
 * a user with sudo or with job code.
 */
export function nodeUser(node: UserBearingNode | null | undefined, role: NodeRole): string {
	const users = node?.users;
	for (const r of NODE_ROLES) {
		if (users?.[r] !== undefined && !named(users[r]))
			throw new Error(`users.${r} is not a user name: ${JSON.stringify(users[r])}`);
	}
	const admin = named(users?.admin) ?? DEFAULT_ADMIN_USER;
	const ci = named(users?.ci) ?? admin;
	if (role !== 'dev') return role === 'ci' ? ci : admin;
	const dev = named(users?.dev);
	if (!dev) throw new Error('this node hosts no sessions: its manifest entry names no users.dev');
	if (dev === admin || dev === ci)
		throw new Error(
			`users.dev is ${dev}, which is also this node's ${dev === admin ? 'admin' : 'ci'} user`
		);
	return dev;
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

/**
 * The dev user `fleet node-users --dev` CREATES on a node: admin's name plus
 * `-dev`. Only that command asks this; everything after reads `users.dev`.
 */
export function setupDevUser(node: UserBearingNode | null | undefined): string {
	return `${nodeUser(node, 'admin')}-dev`;
}

/**
 * CPU and IO weight of the dev user's slice. A user slice defaults to 100,
 * which is what ci's has: sessions take an idle machine, CI wins a contended one.
 */
export const SESSION_WEIGHT = 25;

/**
 * Where `claude` lives under the dev user's home. The setup copies the
 * CONTROLLER's own binary there, so a node runs the version the operator's
 * panes run and fetches nothing itself.
 */
export const DEV_CLAUDE_BIN = '.local/bin/claude';

/**
 * Where crossposter's `claude-lease` lives under the dev user's home, copied
 * from the controller like `claude`. A session starts as
 * `claude-lease exec -- claude`: the lease, and the 429/401 outcome that
 * benches an account, both go as the node's own identity
 * (docs/planning/claw-sessions-2026-11-19.md, step 4).
 */
export const DEV_LEASE_BIN = '.local/bin/claude-lease';

/** The dev user's edge key file (mode 0600), which `claude-lease` reads as `CLAUDE_LEASE_KEY_FILE`. */
export const DEV_LEASE_KEY = '.config/claude-lease/key.json';

/**
 * The edge identity a node's sessions lease as: one per node, so the
 * operator grants or revokes a claw on its own in crossposter's pool table.
 * No repo owns it (hadoku_site key-sync-allowlist `noRepoService`).
 */
export function leaseIdentity(node: string): string {
	return `${node}-sessions`;
}

/** The vault item holding {@link leaseIdentity}'s key: `key-generate` upper-snakes the name. */
export function leaseKeyItem(node: string): string {
	return `KEY_SERVICE_${leaseIdentity(node)
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '_')}`;
}

/** Does this node host interactive sessions, under a dev user of its own? */
export function hostsSessions(node: UserBearingNode | null | undefined): boolean {
	return node?.users?.dev !== undefined;
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
