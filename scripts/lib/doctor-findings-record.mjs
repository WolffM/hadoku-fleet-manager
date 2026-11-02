/**
 * doctor-findings-record — the one finding shape every judge in
 * `doctor-findings-*.mjs` builds its output with.
 *
 * Pulled out of `doctor-findings.mjs` (wave shrink-1 lane D) so each judge
 * module can build a finding without importing the orchestrator — importing
 * `doctor-findings.mjs` FROM a module it assembles would be a cycle. `f` is
 * pure and takes `health` explicitly rather than closing over it, exactly as
 * it did inline, so this is a straight move.
 */

/** @param {{node: string|null}} health */
export const f = (health, category, cls, status, why, extra = {}) => ({
	node: health.node,
	category,
	class: cls,
	status,
	why,
	...extra,
});
