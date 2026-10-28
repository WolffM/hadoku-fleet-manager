/**
 * HOSTING CLAIMS: every pm2 manager on a node, matched to the one record that
 * says it should be there.
 *
 * A pm2 daemon nobody claims is memory nobody budgets: `hostableMb` charges an
 * unbounded one at what it holds now, and `not-beside-unbounded` keeps every
 * tenant that asks for it off the node. claw-6's empty `pm2-hadoku` kept it out
 * of cardtable's pool for exactly that reason (2026-10-27). Two records can
 * claim a manager:
 *
 *   - the TENANT REGISTRY, for `pm2-<app>-svc.service`: a service tenant's own
 *     manager, which belongs only where the tenant is declared;
 *   - the APP LAYER (hadoku_site's `pm2-hosts.json`), for the admin user's
 *     `pm2-<admin>.service` on a node it declares a pm2 host.
 *
 * Anything else is unclaimed. A declared app-layer host running NO apps with no
 * memory ceiling is claimed but idle: hadoku_site's call whether to undeclare
 * or bound it, so it is advisory here, never failing.
 *
 * Pure: the caller measures the units and reads the records. `appLayer.host`
 * and `apps` may be null ("could not look"), and that is never read as claimed
 * or idle. `unreadable` names a record the caller could not read (the registry,
 * the declarations): then every unit is `unknown`, never unclaimed or claimed.
 */

/** Severity of each claim: `fail` reddens `hosting --check`, `advisory` is reported only. */
export const CLAIMS = {
	tenant: 'ok',
	'app-layer': 'ok',
	'app-layer-idle': 'advisory',
	'tenant-undeclared': 'fail',
	'app-layer-undeclared': 'fail',
	unclaimed: 'fail',
	unknown: 'fail',
};

/**
 * Claim each measured pm2 unit on one node.
 *
 * @param {object} o
 * @param {{ unit: string, bounded: boolean, apps?: number | null }[]} o.units
 *   the node's `pm2-*.service` units, as hosting-offers' probe measures them;
 *   `apps` is how many apps the manager runs (null or absent: not measured)
 * @param {{ app: string, runtime: string, service: string }[]} o.tenants
 *   every registered tenant's spec (`tenantSpecFrom`)
 * @param {string[]} o.declaredHere apps with a declaration on this node
 * @param {{ unit: string, host: boolean | null }} o.appLayer the admin user's
 *   pm2 unit, and whether the app layer declares this node a pm2 host
 * @param {string | null} [o.unreadable] why the tenant records could not be read
 * @returns {{ unit: string, claim: keyof CLAIMS, severity: string, by: string | null, why: string }[]}
 */
export function claimPm2Units({ units, tenants, declaredHere, appLayer, unreadable = null }) {
	if (unreadable) {
		return units.map((u) => ({
			unit: u.unit,
			claim: 'unknown',
			severity: CLAIMS.unknown,
			by: null,
			why: unreadable,
		}));
	}
	const byUnit = new Map(tenants.filter((t) => t.runtime === 'pm2').map((t) => [t.service, t]));
	const declared = new Set(declaredHere);
	return units.map((u) => {
		const row = (claim, by, why) => ({ unit: u.unit, claim, severity: CLAIMS[claim], by, why });
		const t = byUnit.get(u.unit);
		if (t) {
			return declared.has(t.app)
				? row('tenant', t.app, `tenant ${t.app}'s manager, declared here`)
				: row(
						'tenant-undeclared',
						t.app,
						`tenant ${t.app}'s manager runs here with no declaration: outside any slice the node budgets`
					);
		}
		if (u.unit !== appLayer.unit) {
			return row(
				'unclaimed',
				null,
				'neither a registered tenant nor the app layer runs this manager'
			);
		}
		if (appLayer.host === null) {
			return row('unknown', 'app-layer', "the app layer's pm2 host list was unreadable");
		}
		if (!appLayer.host) {
			return row(
				'app-layer-undeclared',
				'app-layer',
				'the app layer does not declare this node a pm2 host, yet its manager runs'
			);
		}
		if (u.apps === 0 && !u.bounded) {
			return row(
				'app-layer-idle',
				'app-layer',
				"a declared pm2 host running no apps, with no memory ceiling: the app layer's to undeclare or bound"
			);
		}
		return row('app-layer', 'app-layer', 'a declared pm2 host of the app layer');
	});
}
