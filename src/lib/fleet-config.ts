/**
 * WHO THIS FLEET BELONGS TO — the one place that answers it.
 *
 * This package is published and is meant to become installable by somebody who
 * is not this operator (P7, the public offering). Everything else about a fleet
 * is already configuration: the machines come from a manifest, the state root
 * from `HADOKU_STATE_DIR`, the manifest directory from `FLEET_MANIFEST_DIR`. The
 * IDENTITY of the ecosystem — which GitHub account owns the repos, which repo is
 * the hub, what this package is called — was not. It was spelled inline at every
 * site that needed it, so a second operator installing this package gets a
 * control plane that reconciles somebody else's repos.
 *
 * The rule here is the same one `node-identity.ts` enforces for "is this the box
 * I am running on": ONE question, ONE answer. Five implementations of that
 * question survived until only one of them survived an FQDN. An owner spelled in
 * four files has the same shape of failure, with a quieter symptom — a
 * reconcile that lists the wrong account's repos reports a fleet of zero and
 * every downstream count is legitimately, uselessly, zero.
 *
 * ENV WITH THE CURRENT VALUES AS DEFAULTS, and the defaults are deliberate: this
 * fleet runs unconfigured today and must keep running unconfigured after this
 * file exists. The migration is a refactor, not a cutover.
 *
 * NOTHING HERE IS CACHED, AND THAT IS THE POINT.
 * ---------------------------------------------
 * The moving code already holds ~16 module-level mutable singletons and
 * `createFleetManager` throws on a second call to keep them honest. A resolved-
 * once `const` here would be the seventeenth — and worse than the others,
 * because it would be resolved at IMPORT time, which in a test process is before
 * any test has set its environment. One suite's env would then decide every
 * later suite's answer in the same process. Every accessor below reads
 * `process.env` on the call, exactly as `fleet-paths.ts` does, and
 * `fleet-config.test.ts` resolves twice under two different environments to
 * prove it.
 *
 * THE FOURTH FACT LIVES NEXT DOOR. `stateDir` is already resolved from the
 * environment by `fleet-paths.ts`, so it is RE-EXPORTED rather than reimplemented
 * — a second spelling of the default would be a second source of truth, which is
 * the thing this file exists to remove. Callers get one door for all four facts
 * via `fleetIdentity()`.
 */
import process from 'node:process';

import { stateDir } from './fleet-paths.js';

export { stateDir };

/** The GitHub account that owns the fleet's repos. */
export const FLEET_OWNER_ENV = 'FLEET_OWNER';
/** The hub repo's BARE name — no owner. `hubRepoFull()` qualifies it. */
export const FLEET_HUB_REPO_ENV = 'FLEET_HUB_REPO';
/** This package's npm name. P7 settled that the name STAYS; it is read from
 *  here so that decision is one line to revisit rather than a grep. */
export const FLEET_PACKAGE_NAME_ENV = 'FLEET_PACKAGE_NAME';

const DEFAULT_OWNER = 'WolffM';
const DEFAULT_HUB_REPO = 'hadoku_site';
const DEFAULT_PACKAGE_NAME = '@wolffm/fleet-manager';

/**
 * An env value, or the default when it is unset OR blank.
 *
 * Blank is treated as unset on purpose. An empty `FLEET_OWNER` — a shell
 * expanding an unset variable into an exported one, which is how systemd units
 * and `docker run -e` both behave — would otherwise resolve `qualifyRepo('x')`
 * to `/x`, and every GitHub path built from it 404s with nothing naming the
 * cause. `FLEET_MANIFEST_DIR` is read the same way in `fleet-paths.ts`.
 */
function fromEnv(name: string, fallback: string): string {
	const raw = process.env[name]?.trim();
	return raw ? raw : fallback;
}

/** The GitHub account that owns the fleet's repos. */
export function fleetOwner(): string {
	return fromEnv(FLEET_OWNER_ENV, DEFAULT_OWNER);
}

/** The hub repo, BARE. This is the repo the fleet's operator config lives in. */
export function hubRepo(): string {
	return fromEnv(FLEET_HUB_REPO_ENV, DEFAULT_HUB_REPO);
}

/** The hub repo as GitHub names it: `owner/repo`. */
export function hubRepoFull(): string {
	return qualifyRepo(hubRepo());
}

/**
 * `owner/repo` for a name that may already carry an owner.
 *
 * A repo name arrives bare from operator config that only ever describes this
 * one account (`child-apps.json`'s `repoName`, a `--repo` flag typed by hand)
 * and qualified from anything that talks to GitHub. Qualifying an
 * already-qualified name would produce `owner/owner/repo`, which is a 404 rather
 * than an error — so the test is on the name, not on the caller.
 */
export function qualifyRepo(name: string): string {
	return name.includes('/') ? name : `${fleetOwner()}/${name}`;
}

/** This package's npm name. */
export function packageName(): string {
	return fromEnv(FLEET_PACKAGE_NAME_ENV, DEFAULT_PACKAGE_NAME);
}

/**
 * A `User-Agent` naming this package and the component making the call.
 *
 * GitHub asks every API client to send one, and the one it was sent named the
 * SERVICE that happens to embed this package rather than the package itself —
 * which stops being true the moment anybody else installs it.
 *
 * The scope is stripped because a UA product token is an HTTP `token`
 * (RFC 9110 §5.6.2) and neither `@` nor `/` is a token character, so
 * `@wolffm/fleet-manager` cannot be one. `fleet-manager/<component>` can.
 */
export function userAgent(component: string): string {
	return `${packageName().replace(/^@[^/]+\//, '')}/${component}`;
}

/** Every ecosystem-identity fact, resolved together. */
export interface FleetIdentity {
	owner: string;
	/** BARE — see `hubRepo()`. */
	hubRepo: string;
	packageName: string;
	stateDir: string;
}

/**
 * All four facts at once, for a caller that wants to print or log the identity
 * it resolved. Each field is the accessor above, so this cannot drift from them.
 */
export function fleetIdentity(): FleetIdentity {
	return {
		owner: fleetOwner(),
		hubRepo: hubRepo(),
		packageName: packageName(),
		stateDir: stateDir(),
	};
}
