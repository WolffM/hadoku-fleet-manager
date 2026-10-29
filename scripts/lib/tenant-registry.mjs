/**
 * THE TENANT REGISTRY: which hosting requests the fleet has accepted, and the
 * one rule that turns a request into the names on a node.
 *
 * A request lives in the app's repo (`hosting.json`, `lib/hosting-request.mjs`).
 * `fleet hosting-request <repo> --register` validates it and writes the
 * NORMALIZED request here, in the state dir, with where it came from. Every
 * runtime reader (`fleet hosting`, `--check`, node-status) reads this file, so
 * none of them needs the network, and what is deployed is what was registered.
 * Re-registering after the app changes its file is how a change reaches the
 * fleet.
 *
 * NAMES ARE DERIVED, NEVER TYPED ({@link tenantSpecFrom}). This replaced the
 * hand-written `TENANTS` table on 2026-10-27; cardtable's derived names are
 * exactly the ones that table held, so nothing deployed changed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { hostingSliceName } from '../../dist/runners/hosting-record.js';
import { validateHostingRequest } from './hosting-request.mjs';
import { RUNTIMES, runtimeOf } from './hosting-runtimes.mjs';

const FILE = 'hosting-tenants.json';

/**
 * The names and facts a node carries for one tenant, from its normalized
 * request. The user, unit names and executable are its runtime's
 * (lib/hosting-runtimes.mjs): an `agent` runs as `<app>-agent`, a pm2
 * `service` as `<app>-svc`. The home follows the user.
 */
export function tenantSpecFrom(request) {
	const { app, kind } = request;
	const runtime = runtimeOf(request);
	const names = RUNTIMES[runtime].names(app);
	return {
		app,
		kind,
		runtime,
		slice: hostingSliceName(app),
		/** The unit that runs the tenant: the agent itself, or the manager daemon of a service. */
		service: names.service,
		/** An agent waits for its executable; a service is started by its app layer's deploy. */
		pathUnit: names.pathUnit,
		portUnit: `hosting-${app}-port.service`,
		user: names.user,
		home: `/var/lib/${names.user}`,
		/** Root-owned, written only by `--install`. A service has none: its app layer deploys it. */
		exec: names.exec,
		port: request.network.ports[0] ?? null,
		ingress: request.network.ingress,
		workersOutliveRestart: request.runtime.workersOutliveRestart === true,
		noticeMin: request.availability.noticeMin,
	};
}

const path = (dir) => join(dir, FILE);

/**
 * `{ tenants: { app: { request, source, registeredAt, by } } }`. A missing file
 * is no tenants. A malformed one, or an entry that no longer validates, THROWS:
 * a reader that cannot tell what a tenant was promised must not answer "nothing".
 */
export function readTenantRegistry(dir) {
	if (!existsSync(path(dir))) return { tenants: {} };
	const doc = JSON.parse(readFileSync(path(dir), 'utf8'));
	for (const [app, entry] of Object.entries(doc.tenants ?? {})) {
		const { ok, problems } = validateHostingRequest(entry?.request);
		if (!ok || entry.request.app !== app)
			throw new Error(
				`${FILE}: the entry for ${app} is not a valid request (${problems.map((p) => p.path).join(', ') || 'app name mismatch'})`
			);
	}
	return { tenants: doc.tenants ?? {} };
}

/**
 * The suffixes a tenant's user carries (`<app>-agent`, `<app>-svc`), read off
 * the runtimes that create them, so a new runtime is listed without an edit
 * anywhere that matches tenant users on a node.
 */
export const TENANT_USER_SUFFIXES = Object.values(RUNTIMES).map((r) =>
	r.names('APP').user.replace(/^APP/, '')
);

/** Every registered tenant's app and the user it runs as on a node. */
export function registeredTenantUsers(registry) {
	return Object.values(registry.tenants).map((e) => {
		const spec = tenantSpecFrom(e.request);
		return { app: spec.app, user: spec.user };
	});
}

/** The spec for a registered tenant, or null when it is not registered. */
export function tenantSpec(registry, app) {
	const entry = registry.tenants[app];
	return entry ? tenantSpecFrom(entry.request) : null;
}

/** Write one normalized request into the registry, atomically. */
export function registerTenant(dir, request, { source, by }) {
	const doc = readTenantRegistry(dir);
	doc.tenants[request.app] = { request, source, registeredAt: new Date().toISOString(), by };
	mkdirSync(dirname(path(dir)), { recursive: true });
	const tmp = `${path(dir)}.${process.pid}.tmp`;
	writeFileSync(
		tmp,
		`${JSON.stringify({ $comment: 'Registered hosting requests: `fleet hosting-request <repo> --register` writes this. See scripts/lib/tenant-registry.mjs.', ...doc }, null, 2)}\n`
	);
	renameSync(tmp, path(dir));
	return doc;
}
