/**
 * "Is this node the box I am running on?" — asked in ONE place.
 *
 * WHY THIS IS NOT AN OPTIMISATION
 * -------------------------------
 * hokon refuses ssh to itself. Every fleet loop that reaches a node has to
 * branch on this, and a loop that ssh'd unconditionally read hokon as
 * permanently unreachable — which is how the fast loop treated it as saturated
 * for weeks. `fleet-exec.mjs` says so in its own header: "the local rule is
 * load-bearing, not an optimisation."
 *
 * It was nonetheless answered FOUR different ways (measured 2026-08-30):
 *
 *   runner-supervision.ts   short(a) === short(b), lowercased   ← correct
 *   fleet-loop.ts         host === hostname()                 ← raw
 *   fleet-exec.mjs          node === hostname()              ← raw
 *   ephemeral-tick.ts       no local branch at all, always ssh  ← absent
 *
 * Only the first survives an FQDN. `os.hostname()` returns `hokon` on the
 * production host today, so three of those are latent rather than broken — but
 * the manifest spells a node `hokon` while a freshly imaged box may introduce
 * itself as `hokon.lan` or `HOKON`, and a node nobody has onboarded yet is
 * exactly where a latent bug stops being latent.
 *
 * The absent one is the sharpest. `shellOnNode` returns `null` for
 * unreachable and the reaper "refuses to touch a node it cannot see", so an
 * ephemeral node that happened to be local would never be reaped at all.
 *
 * NOT EXPORTED FROM THE PACKAGE ROOT. It is shared between the library and the
 * `scripts/` half (which imports the BUILT copy), not part of the consumer
 * contract.
 */
import { hostname } from 'node:os';

/**
 * The comparable form of a node name: first DNS label, lowercased.
 *
 * The manifest is the naming authority and spells nodes short and lowercase
 * (`claw-1`, `hokon`). Anything a node says about itself — `os.hostname()`,
 * an ssh config alias, a DHCP-assigned FQDN — is normalised to that before it
 * is compared, never the other way around.
 */
export function shortNodeName(name: string): string {
	return name.split('.')[0].toLowerCase();
}

/**
 * Is `node` the box this process is running on?
 *
 * Callers use it to choose `bash -s` over `ssh <node> bash -s`. Getting it
 * wrong in the false direction costs a node that reads as permanently
 * unreachable; getting it wrong in the true direction runs another node's
 * script here, which is worse. Hence a normalising compare rather than a
 * loose one.
 */
export function isLocalNode(node: string, self: string = hostname()): boolean {
	return shortNodeName(node) === shortNodeName(self);
}
