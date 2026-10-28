/**
 * ONE QUESTION, ONE ANSWER: "is the fleet chain allowed to act on this box?"
 *
 * Three gates asked it independently and each got it wrong the same way —
 * `converge-toolchain` tried to apt-install on the production host,
 * `fleet-preflight` paged on its staged kernel, and `runner-health` (#24) read
 * its backstop registration as a claw's. Each fix would have been its own
 * `if (node === 'hokon')`, and three copies of a policy can disagree. So the
 * policy is a manifest key and this file is its only reader — the same shape
 * `node-identity.ts` next door already holds for "is this node the box I am
 * running on", and for the same reason.
 *
 * IT LIVES IN `src/lib/` RATHER THAN IN `capabilities.ts`, which is where the
 * rest of the manifest vocabulary sits, for one reason: a role is not a
 * capability. A capability is what a node can DO and is proven by executing it;
 * a role is what the fleet may do TO the node, and is the operator's decision.
 * Nothing here probes, and nothing here may grow a probe.
 *
 * PURE, and typed structurally rather than against `capabilities.ManifestNode`,
 * so the `.mjs` gates, the tier ladder and anything else can all ask through
 * this one function without importing a registry they do not otherwise need.
 */

/**
 * What the fleet chain is allowed to DO to a machine.
 *
 *   claw    general CI capacity. In scope for everything: `converge-toolchain`,
 *           bootcamp's required set, node-health BLOCKING findings, resident
 *           placement, and any repair that needs sudo.
 *   guest   a machine that LENDS the fleet something and is otherwise none of
 *           the fleet's business. In scope for exactly one question — is its
 *           registration online with its labels — asked of the GitHub API by
 *           `check-label-floor`.
 *
 * hokon is the only guest (operator, 2026-09-14): "I do NOT want hokon being
 * impacted by the fleet chain. hokon is a guest fleet member; they are here when
 * they are needed."
 */
export type NodeRole = 'claw' | 'guest';

/** Every role the manifest may declare. The schema gate rejects anything else. */
export const NODE_ROLES: readonly NodeRole[] = ['claw', 'guest'];

/** The one manifest field this module reads. */
export interface RoleBearingNode {
	role?: unknown;
}

/** A manifest, as far as roles are concerned. */
export interface RoleBearingManifest {
	machines?: Record<string, RoleBearingNode>;
}

/**
 * This node's role.
 *
 * ABSENCE READS AS `claw`, deliberately, and that is the STRICT direction: a
 * machine nobody has classified gets the whole chain rather than a silent pass.
 * The lenient default would be a box that quietly opts out of convergence,
 * health findings and the required set because someone forgot a line of JSON —
 * "I could not look" rendering as "nothing is wrong", one manifest edit away.
 * `check-capability-schema` REQUIRES the key, so absence cannot persist; this
 * default only decides what happens in the window before that gate runs.
 *
 * An UNRECOGNISED value also reads as `claw`, for the same reason: a typo must
 * not be able to exempt a node. The schema gate names it as its own rule.
 */
export function nodeRole(node: RoleBearingNode | null | undefined): NodeRole {
	return node?.role === 'guest' ? 'guest' : 'claw';
}

/** {@link nodeRole} as the predicate every gate actually wants. */
export function isGuestNode(node: RoleBearingNode | null | undefined): boolean {
	return nodeRole(node) === 'guest';
}

/**
 * The one value `mint` may take, and only on a guest.
 *
 * Operator, 2026-10-19 (#120): "the runners get brought online the same way the
 * JIT process does. not having standing runners squatting on ram." A guest that
 * says this is minted for exactly like a claw, but ONLY for work it is the right
 * home for — a label no claw offers, or `hadoku-builder` while the backstop holds
 * it — and it keeps no standing registration except its `standingRepos`.
 *
 * NOT `ephemeral: true`. That key means "general CI capacity that mints", and
 * thirty readers act on it: the census counts its slots as claw capacity (so an
 * all-claws outage would read as healthy while the production host had room),
 * the warm cache parks a listener on it, the throttle and env-drift gates
 * converge it, the canary label is derived from it. None of that is true of a
 * guest, so the guest says so in its own word and only the readers that must
 * mint for it, register for it, or floor its labels learn the word.
 */
export const GUEST_MINT_MODE = 'on-demand';

/** The manifest fields {@link mintsOnDemand} and {@link standingRepos} read. */
export interface MintBearingNode extends RoleBearingNode {
	mint?: unknown;
	standingRepos?: unknown;
}

/**
 * Is this a guest the dispatcher mints for, per job, instead of keeping
 * standing runners on it? A claw carrying `mint` is a schema finding, never a
 * mode: the key means nothing off a guest, and reading it there would let one
 * stray line turn a claw's JIT path into a gated one.
 */
export function mintsOnDemand(node: MintBearingNode | null | undefined): boolean {
	return isGuestNode(node) && node?.mint === GUEST_MINT_MODE;
}

/**
 * Does the dispatcher mint JIT runners on this node at all — an ephemeral claw,
 * or an on-demand guest?
 *
 * For the readers that care about the MINT PATH ITSELF and nothing else: is the
 * provisioner shipped there, is the slot env deployed, which slice do its units
 * land in. Every reader that asks "is this general CI capacity" keeps asking
 * `ephemeral === true` and never sees a guest — see {@link GUEST_MINT_MODE}.
 */
export function mintsJitRunners(
	node: (MintBearingNode & { ephemeral?: unknown }) | null | undefined
): boolean {
	return node?.ephemeral === true || mintsOnDemand(node);
}

/**
 * Repos an on-demand guest still keeps a STANDING registration for.
 *
 * Exists for one repo and one reason: hadoku_site's deploy runner. The minter
 * runs inside mgmt-api, and hadoku_site is what deploys mgmt-api, so a deploy
 * that breaks the minter would leave no runner to deploy the fix. Distinct from
 * a claw's `residentRepos`, which is the fleet's `hadoku-builder` backstop and
 * is floored as such (two online holders carrying the label) — a deploy runner
 * carries `pm2-host`, never `hadoku-builder`, and would fail that floor by
 * design.
 *
 * Empty for anything that is not an on-demand guest: a standing guest keeps a
 * registration for every repo it may run, and this list does not narrow it.
 */
export function standingRepos(node: MintBearingNode | null | undefined): string[] {
	if (!mintsOnDemand(node)) return [];
	const v = node?.standingRepos;
	return Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string') : [];
}

/**
 * The one `services` value: this node HOSTS pm2 services (#6).
 *
 * Distinct from the `pm2-host` capability, which is a ROUTING label meaning
 * "the hub" — mgmt-api runs here — and is earned by probe. claw-4 hosts
 * pygmalion under pm2 and is deliberately NOT `pm2-host`, or hub deploy jobs
 * would route to it. This key says what provisioning must make true on the box:
 * pm2, its boot unit, cloudflared (`REPAIRS` in scripts/lib/toolchain-floor.mjs).
 *
 * hadoku_site's `scripts/pm2-hosts.json` decides WHICH boxes host services;
 * this key is the fleet-side copy of that answer, and `fleet capability-schema`
 * fails when the two disagree.
 */
export const PM2_SERVICES = 'pm2';

/** Does provisioning owe this node a pm2 services host? Never a guest: the fleet does not provision one. */
export function hostsPm2Services(
	node: (RoleBearingNode & { services?: unknown }) | null | undefined
): boolean {
	return !isGuestNode(node) && node?.services === PM2_SERVICES;
}

/**
 * The guest machines in a manifest, by name.
 *
 * Returns a Set so a caller can hand it straight to a finding classifier. An
 * absent `machines` map yields an EMPTY set, which means "no node is exempt" —
 * the strict direction again, matching {@link nodeRole}.
 */
export function guestNodeNames(manifest: RoleBearingManifest | null | undefined): Set<string> {
	const out = new Set<string>();
	for (const [name, m] of Object.entries(manifest?.machines ?? {})) {
		if (isGuestNode(m)) out.add(name);
	}
	return out;
}

/**
 * The one `containers` value: this node's CI user runs a ROOTLESS docker
 * daemon of its own (operator, 2026-10-27: claw-8 and claw-5).
 *
 * Before a node is cut over to its own ci user (src/lib/node-users.ts) CI runs
 * as admin, which is in the `docker` group, and every claw builds images that
 * way. After it, the ci user has no group and no sudo, so docker is something
 * the node must be GIVEN: a rootless daemon in the ci user's manager. This key
 * says which cut-over nodes get one. The `docker` LABEL is still earned by
 * building an image, never by this key.
 */
export const CONTAINERS_DOCKER = 'docker';

/** Does provisioning owe this node's ci user a rootless docker? */
export function hostsCiDocker(
	node: (RoleBearingNode & { containers?: unknown }) | null | undefined
): boolean {
	return !isGuestNode(node) && node?.containers === CONTAINERS_DOCKER;
}
