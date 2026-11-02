/**
 * SERVICE ELIGIBILITY: per node, which tenants' repos that node may run
 * (fleet-manager#42). hadoku_site issues each machine its own 7-day credential
 * for every service identity it may run (its service-grants-2026-10-31.md),
 * and a credential must be in place BEFORE the service starts there.
 *
 * PURE. The converger computes {@link eligibilityFor} against the offers it
 * already collected (one ssh per node, every tenant's tools executed) and
 * keeps it in its last pass; `fleet hosting-eligibility` reads that pass and
 * the ledger, and {@link eligibilityDocument} decides what the document says.
 *
 * WHAT "ELIGIBLE" MEANS. Where the fleet may place the tenant without anything
 * the tenant declared, or anything about the node itself, changing:
 *
 *   placed     the node holds a slice of the tenant in force now (the ledger:
 *              primary or standby, ending ones included, a move's target
 *              included). A standby takes over on its own, so it needs the
 *              credential as much as the primary does.
 *   candidate  the node passes every rule of the tenant that is a fact about
 *              the NODE: each `placement.require` rule, `runtime` (node in
 *              range, every tool executed on the service PATH), the unit fits
 *              the node with NO slice on it (installed memory less its floor,
 *              CI's reserve and any unbounded neighbour; cores less CI's one;
 *              free disk for `stateGb`), and the `ciMayRead` filter once it
 *              is one. What changes from one pass to the next is ignored: a
 *              drain or lease, other tenants' slices, the tenant being at
 *              `slices.max`, the node already holding it. Those decide WHEN
 *              the converger moves the tenant there, not WHETHER it may, and a
 *              credential that flapped with them would be minted and retired
 *              every time a lease began or another tenant moved.
 *   eligible   `placement.auto` tenants: placed ∪ candidates, because the
 *              converger moves them by itself, onto any candidate.
 *              Every other tenant: placed only. Nothing moves a hand-placed
 *              tenant but a person going through the `fleet hosting` door,
 *              which writes the new slice to the ledger before the service is
 *              started there, so it is `placed` on the next read; a
 *              credential on every node that merely fits would widen what a
 *              leak exposes and buy nothing.
 *
 * The backstop (hokon) is never a candidate: it is not lent to a hosting
 * tenant (lib/collect-offers.mjs). It is listed under `notLent`, not dropped.
 *
 * "I COULD NOT LOOK" IS `ok: false` WITH WHY, never an empty `nodes` map: an
 * unreadable registry, manifest, ledger or converger pass, a converger pass
 * that is stale or predates eligibility, a tenant the pass did not cover, a
 * tenant whose repo the registry does not record, or a slice of a tenant that
 * is not registered. A node the converger could not reach this pass is listed
 * per node under `unknown`, with why: its rules could not be read, so it is
 * neither eligible nor ruled out, and a reader should leave what it already
 * granted there alone rather than read the absence as "revoke".
 */
import { isBackstopNode } from '../../dist/lib/node-role.js';
import { ruleHolds } from './hosting-placement.mjs';
import { appRecords } from './hosting-placement-view.mjs';
import { runtimeReasons } from './hosting-plan.mjs';

/** The document's version, pinned by its readers. Additive changes only. */
export const HOSTING_ELIGIBILITY_CONTRACT = 1;

/** The converger runs every 5 minutes; a pass older than this is not current. */
export const STALE_PASS_MS = 30 * 60_000;

/**
 * Which nodes in `offers` (collectOffers') pass the tenant's node rules,
 * ignoring everything a later pass may change (see the header). `plan` is
 * planFor's, for its `ciMayReadPolicy`. Every offer lands in exactly one of
 * the three lists.
 */
export function eligibilityFor(request, offers, plan) {
	const eligible = [];
	const ruledOut = [];
	const unknown = [];
	const unit = request.slices.unit;
	for (const o of offers) {
		if (!o.reachable) {
			unknown.push({
				node: o.node,
				why: o.expectedDown
					? 'expected down'
					: `did not answer (${(o.unknown ?? []).join('; ') || 'no answer'})`,
			});
			continue;
		}
		const no = [];
		const cannot = [];
		for (const rule of request.placement.require) {
			const holds = ruleHolds(rule, o);
			if (holds === false) no.push(`fails "${rule}"`);
			else if (holds === null) cannot.push(`cannot tell whether "${rule}" holds`);
		}
		const rt = runtimeReasons(request, o);
		no.push(...rt.fails);
		cannot.push(...rt.cannot);
		// The unit against the node with no slice on it: what the node is, not who is on it now.
		const mem = o.measured?.memTotalMb ?? null;
		const ciMb = o.ci?.jobMb ?? null;
		if (mem === null || ciMb === null) cannot.push('installed memory or CI job cost unknown');
		else {
			const roomMb =
				mem -
				o.minFreeMb -
				ciMb * o.ci.keepJobs -
				(o.pm2?.unboundedMb ?? 0) -
				(o.pm2?.boundedMb ?? 0);
			if (roomMb < unit.memoryMb)
				no.push(`empty, it would offer ${roomMb} MiB; the unit needs ${unit.memoryMb}`);
		}
		const nproc = o.measured?.nproc ?? null;
		if (nproc === null) cannot.push('core count unknown');
		else if (nproc - 1 < unit.cores)
			no.push(`empty, it would offer ${nproc - 1} cores; the unit needs ${unit.cores}`);
		const disk = o.hostable?.diskFreeGb ?? null;
		if (disk === null) cannot.push('free disk unknown');
		else if (disk < request.disk.stateGb)
			no.push(`${disk} GB free, state needs ${request.disk.stateGb}`);
		if (plan?.ciMayReadPolicy === 'filter' && !o.ci?.cutOver)
			no.push(`CI here is not cut over to its own user, and ${request.app} may not be read by CI`);

		if (no.length) ruledOut.push({ node: o.node, reasons: no });
		else if (cannot.length) unknown.push({ node: o.node, why: cannot.join('; ') });
		else eligible.push(o.node);
	}
	return { eligible, ruledOut, unknown };
}

/**
 * `owner/name` from a registry entry's `source` (`WolffM/hadoku-cardtable:hosting.json`,
 * as `fleet hosting-request <repo> --register` writes it), or null when the
 * request was registered from a local file and its repo was never recorded.
 */
export function repoOf(entry) {
	const m = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+):hosting\.json$/.exec(entry?.source ?? '');
	return m ? m[1] : null;
}

const uniqSorted = (xs) => [...new Set(xs)].sort();

/**
 * The whole document.
 *
 * @param {object} i
 * @param {object|null} i.registry   readTenantRegistry(), or null when unreadable
 * @param {object|null} i.manifest   the fleet manifest, or null when unreadable
 * @param {object|null} i.drainDoc   fleet-drain.json, or null when unreadable
 * @param {object|null} i.hostingDoc fleet-hosting.json, or null when unreadable
 * @param {object|null} i.last       hosting-converge-last.json, or null when absent or unreadable
 *                                   (the caller says which in `problems`)
 * @param {string[]} i.problems      what could not be read, each a sentence naming the file
 * @param {number} i.now
 */
export function eligibilityDocument({
	registry,
	manifest,
	drainDoc,
	hostingDoc,
	last,
	problems,
	now,
}) {
	const why = [...problems];
	const base = {
		contract: HOSTING_ELIGIBILITY_CONTRACT,
		generatedAt: new Date(now).toISOString(),
	};
	// `nodes` is never said when something could not be read: a grant syncer reads only that map.
	const refuse = (tenants = null) => ({
		...base,
		ok: false,
		error: why.join('; '),
		at: last?.at ?? null,
		nodes: null,
		tenants,
	});
	if (!registry || !manifest || !drainDoc || !hostingDoc) return refuse();
	if (!last) {
		if (!why.length) why.push('the converger has kept no pass, so no candidate is known');
		return refuse();
	}

	const apps = Object.keys(registry.tenants).sort();
	if (!apps.length) why.push('no tenant is registered, so no node is eligible for anything');

	const passAt = Date.parse(last.at ?? '');
	if (!Number.isFinite(passAt)) why.push("the converger's last pass carries no readable `at`");
	else if (now - passAt > STALE_PASS_MS)
		why.push(
			`the converger's last pass is from ${last.at}, more than ${STALE_PASS_MS / 60_000} minutes ago`
		);

	const machines = manifest.machines ?? {};
	const notLent = Object.entries(machines)
		.filter(([, m]) => isBackstopNode(m))
		.map(([node]) => ({
			node,
			role: 'backstop',
			why: 'the emergency backstop and the production host: not lent to a hosting tenant',
		}));
	const nodes = {};
	const nodeRow = (n) => (nodes[n] ??= { placed: [], eligible: [], unknown: [] });
	for (const [n, m] of Object.entries(machines)) if (!isBackstopNode(m)) nodeRow(n);

	// A slice in the ledger whose tenant is not registered: its repo cannot be said.
	const registered = new Set(apps);
	const held = [
		...Object.entries(drainDoc.nodes ?? {})
			.filter(([, r]) => r.kind === 'hosting' && r.hosting?.tenant)
			.map(([n, r]) => [n, r.hosting.tenant]),
		...Object.entries(hostingDoc.nodes ?? {}).flatMap(([n, recs]) =>
			recs.map((r) => [n, r.tenant])
		),
	];
	for (const [n, t] of held)
		if (!registered.has(t))
			why.push(
				`${n} holds a slice of ${t}, which is not a registered tenant, so its repo is unknown`
			);

	const tenants = [];
	for (const app of apps) {
		const entry = registry.tenants[app];
		const { request } = entry;
		const repo = repoOf(entry);
		if (!repo)
			why.push(
				`${app} was registered from ${entry.source ?? 'nowhere recorded'}, so its repo is unknown: ` +
					`re-register it with \`fleet hosting-request <owner/name> --register\``
			);
		const auto = request.placement?.auto === true;
		const placed = appRecords(app, drainDoc, hostingDoc, now)
			.filter((r) => !r.lapsed)
			.map((r) => ({ node: r.node, role: r.role, mode: r.mode, until: r.until }));

		const pass = last.tenants?.[app];
		let el = null;
		if (!pass) why.push(`the converger's last pass (${last.at}) did not cover ${app}`);
		else if (!pass.eligibility)
			why.push(
				`the converger's last pass (${last.at}) carries no eligibility for ${app}: it predates eligibility, and the next pass carries it`
			);
		else el = pass.eligibility;

		const placedNodes = uniqSorted(placed.map((p) => p.node));
		const candidates = el ? [...el.eligible].sort() : null;
		const eligible = auto ? uniqSorted([...placedNodes, ...(candidates ?? [])]) : placedNodes;
		const unknown = el ? el.unknown.filter((u) => !placedNodes.includes(u.node)) : [];
		tenants.push({
			app,
			repo,
			kind: request.kind,
			auto,
			singleton: request.availability?.singleton === true,
			placed,
			eligible,
			candidates,
			unknown,
			ruledOut: el?.ruledOut ?? null,
		});
		if (!repo) continue;
		for (const n of placedNodes) nodeRow(n).placed.push(repo);
		for (const n of eligible) nodeRow(n).eligible.push(repo);
		if (auto) for (const u of unknown) nodeRow(u.node).unknown.push({ repo, app, why: u.why });
	}
	for (const row of Object.values(nodes)) {
		row.placed = uniqSorted(row.placed);
		row.eligible = uniqSorted(row.eligible);
		row.unknown.sort((a, b) => a.repo.localeCompare(b.repo));
	}

	if (why.length) return refuse(tenants);
	return {
		...base,
		ok: true,
		at: last.at,
		nodes: Object.fromEntries(Object.entries(nodes).sort(([a], [b]) => a.localeCompare(b))),
		notLent,
		tenants,
	};
}
