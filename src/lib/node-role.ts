/**
 * ONE QUESTION, ONE ANSWER: "is this machine general CI capacity, or the
 * backstop?"
 *
 * Three gates once asked it independently and each got it wrong the same way:
 * `runner-health` (#24) read the backstop's registration as a claw's, and the
 * census would have counted the production host's slots as claw capacity. Each
 * fix would have been its own `if (node === 'hokon')`, and copies of a policy
 * can disagree. So the policy is a manifest key and this file is its only
 * reader — the same shape `node-identity.ts` next door already holds for "is
 * this node the box I am running on", and for the same reason.
 *
 * IT LIVES IN `src/lib/` RATHER THAN IN `capabilities.ts`, which is where the
 * rest of the manifest vocabulary sits, for one reason: a role is not a
 * capability. A capability is what a node can DO and is proven by executing it;
 * a role is what the node is FOR, and is the operator's decision.
 * Nothing here probes, and nothing here may grow a probe.
 *
 * PURE, and typed structurally rather than against `capabilities.ManifestNode`,
 * so the `.mjs` gates, the tier ladder and anything else can all ask through
 * this one function without importing a registry they do not otherwise need.
 */

/**
 * What a machine is FOR, as far as the fleet's capacity is concerned.
 *
 *   claw      general CI capacity: counted in the census, ranked for routing,
 *             warm-cached, lent to hosting, and placed for like every other claw.
 *   backstop  the fleet's emergency backstop (hokon). Minted for only when it is
 *             the right home — a label no claw offers, or `hadoku-builder` while
 *             the backstop holds it — and otherwise NOT capacity: never in the
 *             census, never benchmarked for rank, never lent to a hosting tenant,
 *             never in the required set, never rebooted by the fleet (it is the
 *             production host).
 *
 * Everything else is the same as a claw. The fleet drains it, probes it,
 * bootcamps it, installs on it and converges it (operator, 2026-10-31: "we can
 * do drains and installs. hokon is our emergency backstop when things go
 * wrong") — a backstop nobody keeps current cannot save the fleet.
 *
 * `"guest"` is the value's old name (2026-09-14 to 2026-10-31), when the box was
 * out of the fleet chain altogether. It still reads as `backstop` until the live
 * manifest is rewritten; the schema gate names it.
 */
export type NodeRole = 'claw' | 'backstop';

/** Every role the manifest may declare. The schema gate rejects anything else. */
export const NODE_ROLES: readonly NodeRole[] = ['claw', 'backstop'];

/** The retired spelling of `backstop`, read as it until the live manifest drops it. */
export const LEGACY_BACKSTOP_ROLE = 'guest';

/**
 * May the fleet run `sudo` on this node?
 *
 * Not on the backstop (operator, 2026-10-31: "hokon is the exception, so i guess
 * i need to do that one manual to upgrade. NOPASSWD sudo is okay on the claws").
 * The fleet drains it and installs on it as its own user, but anything that
 * needs root there — apt, a system slice, a sudoers or apt conf — is the
 * operator's, by hand. A caller reports that work as an ADVISORY naming the
 * command, never attempts it (it would hang on a password prompt or fail) and
 * never reports it as drift it will repair.
 */
export function fleetHasSudo(node: RoleBearingNode | null | undefined): boolean {
	return !isBackstopNode(node);
}

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
 * The lenient default would be a box that quietly leaves the census, the
 * required set and routing because someone forgot a line of JSON —
 * "I could not look" rendering as "nothing is wrong", one manifest edit away.
 * `check-capability-schema` REQUIRES the key, so absence cannot persist; this
 * default only decides what happens in the window before that gate runs.
 *
 * An UNRECOGNISED value also reads as `claw`, for the same reason: a typo must
 * not be able to take a node out of capacity. The schema gate names it as its own rule.
 */
export function nodeRole(node: RoleBearingNode | null | undefined): NodeRole {
	return node?.role === 'backstop' || node?.role === LEGACY_BACKSTOP_ROLE ? 'backstop' : 'claw';
}

/** {@link nodeRole} as the predicate every gate actually wants. */
export function isBackstopNode(node: RoleBearingNode | null | undefined): boolean {
	return nodeRole(node) === 'backstop';
}

/**
 * The one value `mint` may take, and only on a backstop.
 *
 * Operator, 2026-10-19 (#120): "the runners get brought online the same way the
 * JIT process does. not having standing runners squatting on ram." A backstop
 * that says this is minted for exactly like a claw, but ONLY for work it is the right
 * home for — a label no claw offers, or `hadoku-builder` while the backstop holds
 * it — and it keeps no standing registration except its `standingRepos`.
 *
 * NOT `ephemeral: true`. That key means "general CI capacity that mints", and
 * thirty readers act on it: the census counts its slots as claw capacity (so an
 * all-claws outage would read as healthy while the production host had room),
 * the warm cache parks a listener on it, the throttle and env-drift gates
 * converge it, the canary label is derived from it. None of that is true of the
 * backstop, so it says so in its own word and only the readers that must
 * mint for it, register for it, or floor its labels learn the word.
 */
export const BACKSTOP_MINT_MODE = 'on-demand';

/** The manifest fields {@link mintsOnDemand} and {@link standingRepos} read. */
export interface MintBearingNode extends RoleBearingNode {
	mint?: unknown;
	standingRepos?: unknown;
}

/**
 * Is this a backstop the dispatcher mints for, per job, instead of keeping
 * standing runners on it? A claw carrying `mint` is a schema finding, never a
 * mode: the key means nothing off a backstop, and reading it there would let one
 * stray line turn a claw's JIT path into a gated one.
 */
export function mintsOnDemand(node: MintBearingNode | null | undefined): boolean {
	return isBackstopNode(node) && node?.mint === BACKSTOP_MINT_MODE;
}

/**
 * Does the dispatcher mint JIT runners on this node at all — an ephemeral claw,
 * or an on-demand backstop?
 *
 * For the readers that care about the MINT PATH ITSELF and nothing else: is the
 * provisioner shipped there, is the slot env deployed, which slice do its units
 * land in. Every reader that asks "is this general CI capacity" keeps asking
 * `ephemeral === true` and never sees the backstop — see {@link BACKSTOP_MINT_MODE}.
 */
export function mintsJitRunners(
	node: (MintBearingNode & { ephemeral?: unknown }) | null | undefined
): boolean {
	return node?.ephemeral === true || mintsOnDemand(node);
}

/**
 * Repos an on-demand backstop still keeps a STANDING registration for.
 *
 * Exists for one repo and one reason: hadoku_site's deploy runner. The minter
 * runs inside mgmt-api, and hadoku_site is what deploys mgmt-api, so a deploy
 * that breaks the minter would leave no runner to deploy the fix. Distinct from
 * a claw's `residentRepos`, which is the fleet's `hadoku-builder` backstop and
 * is floored as such (two online holders carrying the label) — a deploy runner
 * carries `pm2-host`, never `hadoku-builder`, and would fail that floor by
 * design.
 *
 * Empty for anything that is not an on-demand backstop: a standing backstop keeps
 * a registration for every repo it may run, and this list does not narrow it.
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

/** Does provisioning owe this node a pm2 services host? */
export function hostsPm2Services(node: { services?: unknown } | null | undefined): boolean {
	return node?.services === PM2_SERVICES;
}

/**
 * The backstop machines in a manifest, by name.
 *
 * Returns a Set so a caller can hand it straight to a finding classifier. An
 * absent `machines` map yields an EMPTY set, which means "every node is capacity" —
 * the strict direction again, matching {@link nodeRole}.
 */
export function backstopNodeNames(manifest: RoleBearingManifest | null | undefined): Set<string> {
	const out = new Set<string>();
	for (const [name, m] of Object.entries(manifest?.machines ?? {})) {
		if (isBackstopNode(m)) out.add(name);
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
export function hostsCiDocker(node: { containers?: unknown } | null | undefined): boolean {
	return node?.containers === CONTAINERS_DOCKER;
}
