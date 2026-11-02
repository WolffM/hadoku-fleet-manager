/**
 * TENANT RUNTIME NAMES — which runtime a request runs under, and the user,
 * unit and executable names on the node, for each runtime kind. Nothing
 * else: no unit text, no hardening, no home/system files.
 *
 * MOVED OUT of `hosting-runtimes.mjs` (wave layers-3 lane H, cut (iii) layer
 * debt): both functions are zero-import and pure, declarative over `app`
 * alone, where the rest of `hosting-runtimes.mjs` (the `unit()` renderers)
 * reaches into state (`AGENT_OOM_SCORE_ADJ`) and so cannot itself sit below
 * domain. `scripts/lib/tenant-registry.mjs` (config) needed only this half —
 * the names, not the renderers — without reaching UP into hosting-runtimes'
 * tenancy-domain table to get it. `hosting-runtimes.mjs` re-exports
 * `runtimeOf` and assembles `RUNTIMES[*].names` from `TENANT_RUNTIME_NAMES`
 * unchanged, so every existing importer keeps compiling and behaving
 * byte-identically.
 */

/** Which runtime a NORMALIZED request runs under. */
export const runtimeOf = (request) =>
	request.kind === 'agent' ? 'agent' : request.runtime.manager;

/**
 * The user, unit names and executable for an app, per runtime, derived,
 * never typed. cardtable's are the names claw-9 has run since 10-24.
 */
export const TENANT_RUNTIME_NAMES = {
	agent: (app) => ({
		user: `${app}-agent`,
		service: `${app}-agent.service`,
		pathUnit: `${app}-agent.path`,
		/** Root-owned, written only by `--install`. */
		exec: `/opt/hosting/${app}/run`,
	}),
	pm2: (app) => ({
		user: `${app}-svc`,
		service: `pm2-${app}-svc.service`,
		pathUnit: null,
		exec: null,
	}),
};
