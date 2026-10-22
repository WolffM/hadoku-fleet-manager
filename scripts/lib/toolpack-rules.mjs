/**
 * toolpack-rules — the pure half of toolpack.mjs: which packs a node's
 * observed shape (plus its manifest role) requires.
 *
 * Split out for the same reason demand-derive.mjs split off
 * check-tool-inventory.mjs's ssh/manifest orchestration: this is text/data in,
 * a decision out, so it can be asserted without a fleet or a real toolpacks.json
 * behind it.
 */

/**
 * `when` against observed facts. A new HARDWARE condition is one line here.
 *
 * `ciClaw` is the one exception: it is not read off the node at all (see
 * toolpack.mjs's header for why `python-pip` is a named exception to "not the
 * CI toolchain"). It is whatever the CALLER decided from the node's manifest
 * role — every machine that is not a `pm2-host`, the same population
 * `check-tool-inventory.mjs` calls `clawSet`.
 */
export function packsRequired(packs, shape, ciClaw) {
	const test = {
		always: () => true,
		wireless: () => Number(shape.wireless) > 0,
		nvme: () => Number(shape.nvme) > 0,
		ciClaw: () => ciClaw,
	};
	return Object.entries(packs).filter(([, p]) => (test[p.when] ?? (() => false))());
}
