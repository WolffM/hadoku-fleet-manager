/**
 * THE PLACEMENT RECORD, READ: what `fleet hosting-placement <app> --json`
 * publishes (fleet-manager#16). The contract was reviewed by cardtable,
 * hadoku_site and watchparty in the private planning doc
 * `hosting-placement-reader-2026-10-31.md` (§3, §5a, §5b).
 *
 * PURE. The script (scripts/hosting-placement.mjs) reads the files and probes
 * the nodes; everything that decides what the document says is here, so every
 * path is testable without a node.
 *
 * WHERE THE RECORD IS. The capability-placement design (§3.1) settled that the
 * hosting ledger IS the placement record, with no second placements file:
 *   - which nodes: the slices themselves, `fleet-hosting.json` (shared) and
 *     drain records of `kind: hosting` (whole), each primary carrying the
 *     `epoch` it was declared with;
 *   - what outlives a slice: `fleet-hosting.json` `apps.<app>`, holding the
 *     epoch counter, a singleton's open `move`, and the slices removed in the
 *     last day (`ended`).
 * Its one writer is the `fleet hosting` door, which the converger and the
 * mover both act through.
 *
 *   state     unplaced  no primary slice in force
 *             moving    a singleton's move is open: `nodes` is still the node
 *                       it leaves, `target` the node it goes to, and `epoch`
 *                       is already the new one (it goes up when a move OPENS,
 *                       so the mover can hand it to the new node's first start)
 *             placed    otherwise
 *   nodes     a singleton: its one serving primary. Otherwise every primary
 *             in force that is not ending, in the tenant's release order and
 *             then oldest first; the ending ones only when nothing else is left
 *   epoch     the app's counter, and never lower than any record's own
 *
 * "I COULD NOT LOOK" IS `ok: false`, WITH WHY. A file that cannot be read, a
 * slice's node that did not answer, a record this reader cannot make sense of
 * (a singleton held twice with no move open). An unreadable record never
 * renders as `unplaced`: `placement` is then null and `error` names why.
 * `unplaced` is only ever said about a record that was read and is empty.
 */

import { ENDED_KEEP_MS } from '../../dist/runners/hosting-record.js';

/** The document's version, pinned by its readers. Additive changes only. */
export const HOSTING_PLACEMENT_CONTRACT = 1;

const lapsed = (until, nowMs) => {
	if (!until) return false;
	const t = Date.parse(until);
	// Unparseable is NOT lapsed, as everywhere the record is read.
	return Number.isFinite(t) && t <= nowMs;
};

/**
 * Every record `app` holds, lapsed ones included, whichever file it lives in.
 * One row per node: `{ node, mode, role, epoch, since, until, declared, lapsed }`.
 */
export function appRecords(app, drainDoc, hostingDoc, nowMs) {
	const rows = [];
	const row = (node, mode, rec, until, since) => ({
		node,
		mode,
		role: rec.role === 'standby' ? 'standby' : 'primary',
		epoch: Number.isInteger(rec.epoch) ? rec.epoch : null,
		since: since ?? null,
		until: until ?? null,
		declared: { memoryMb: rec.memoryMb, cores: rec.cores, port: rec.port },
		lapsed: lapsed(until, nowMs),
	});
	for (const [node, rec] of Object.entries(drainDoc.nodes ?? {}))
		if (rec.kind === 'hosting' && rec.hosting?.tenant === app)
			rows.push(row(node, 'whole', rec.hosting, rec.until, rec.since));
	for (const [node, recs] of Object.entries(hostingDoc.nodes ?? {}))
		for (const rec of recs)
			if (rec.tenant === app) rows.push(row(node, 'shared', rec, rec.until, rec.since));
	return rows.sort((a, b) => Date.parse(a.since ?? '') - Date.parse(b.since ?? ''));
}

/**
 * `{ placement }`, or `{ error }` when the record cannot be read as one
 * placement. `records` from {@link appRecords}; `appRec` is
 * `fleet-hosting.json` `apps[app]` or undefined.
 */
export function placementOf({ singleton, records, appRec, releaseOrder = [] }) {
	const inForce = records.filter((r) => r.role === 'primary' && !r.lapsed);
	const epoch = Math.max(appRec?.epoch ?? 0, ...records.map((r) => r.epoch ?? 0));
	const move = appRec?.move ?? null;

	if (move) {
		if (!singleton)
			return {
				error: `the record holds an open move (${move.from} → ${move.to}) for a tenant that is not a singleton`,
			};
		const missing = [move.from, move.to].filter((n) => !inForce.some((r) => r.node === n));
		if (missing.length)
			return {
				error:
					`the open move ${move.from} → ${move.to} (epoch ${move.epoch}) names ${missing.join(' and ')}, ` +
					'which holds no slice of it in force',
			};
		return { placement: { state: 'moving', epoch, nodes: [move.from], target: move.to } };
	}
	if (!inForce.length) return { placement: { state: 'unplaced', epoch, nodes: [], target: null } };

	const serving = inForce.filter((r) => !r.until);
	if (singleton) {
		const one = serving.length ? serving : inForce;
		if (one.length > 1)
			return {
				error:
					`a singleton holds ${one.map((r) => r.node).join(', ')} with no move open; ` +
					'the record cannot say which one serves',
			};
		return { placement: { state: 'placed', epoch, nodes: [one[0].node], target: null } };
	}
	const pick = serving.length ? serving : inForce;
	const at = (n) => {
		const i = releaseOrder.indexOf(n);
		return i === -1 ? Infinity : i;
	};
	const nodes = [...pick]
		.sort(
			(a, b) => at(a.node) - at(b.node) || Date.parse(a.since ?? '') - Date.parse(b.since ?? '')
		)
		.map((r) => r.node);
	return { placement: { state: 'placed', epoch, nodes, target: null } };
}

/**
 * One slice row. `probe` is `{ answered, row, observedAt }` from
 * lib/hosting-check.mjs, or undefined for a slice past its end, which is not
 * probed and reads `ended` until `--remove` drops its record. `ci` is the
 * node's pressure from lib/hosting-ci-pressure.mjs, null when unmeasured.
 */
export function sliceRow(rec, probe, { notices = [], registeredPort = null, ci = null } = {}) {
	const base = {
		node: rec.node,
		mode: rec.mode,
		role: rec.role,
		epoch: rec.epoch,
		since: rec.since,
		until: rec.until,
		declared: rec.declared,
		notices,
		ci: rec.lapsed ? null : ci,
	};
	if (rec.lapsed)
		return {
			...base,
			observedAt: null,
			reachable: null,
			state: 'ended',
			why: null,
			observed: null,
			findings: [],
		};
	const findings = [...(probe?.row.findings ?? [])];
	// The port is the tenant's, mirrored from its registration and never assigned
	// here: a record that disagrees is said, for hadoku_site's row check to see.
	if (registeredPort !== null && rec.declared.port !== registeredPort)
		findings.push({
			class: 'advisory',
			category: 'hosting-port-drift',
			why: `the slice serves port ${rec.declared.port}; the registered hosting.json says ${registeredPort}`,
		});
	const answered = probe?.answered === true;
	const state = answered ? probe.row.state : 'unknown';
	const blocking = findings.filter((f) => f.class === 'blocking').map((f) => f.why);
	return {
		...base,
		observedAt: probe?.observedAt ?? null,
		reachable: answered,
		state,
		why:
			state === 'guaranteed'
				? null
				: blocking.join('; ') || (probe ? 'the node did not answer' : 'the node was not probed'),
		observed: answered ? (probe.row.observed ?? null) : null,
		findings,
	};
}

/** The converger's last pass, for this app, in the published shape; null when it never ran. */
export function convergerView(last, app) {
	const t = last?.tenants?.[app];
	if (!t) return null;
	return {
		at: last.at,
		dryRun: last.dryRun === true,
		live: t.live === true,
		desired: t.desired,
		serving: t.serving ?? [],
		actions: (t.actions ?? []).map(({ op, node, role, why }) => ({
			op,
			node,
			...(role ? { role } : {}),
			why,
		})),
		blocked: (t.blocked ?? []).map(({ node, why, soft }) => ({ node, why, soft: soft === true })),
		unplaceable: (t.unplaceable ?? []).map(({ node, why }) => ({ node, why })),
	};
}

/** The tenant's registration, as published. */
export function tenantView(request) {
	return {
		kind: request.kind,
		auto: request.placement?.auto === true,
		singleton: request.availability?.singleton === true,
		fence: request.availability?.fence ?? null,
		slices: { min: request.slices.min, max: request.slices.max },
		noticeMin: request.availability?.noticeMin ?? null,
		port: request.network?.ports?.[0] ?? null,
	};
}

/**
 * The whole per-app document. `problems` are what could not be read before
 * this was called (each a sentence naming the file); any of them, any slice
 * whose node did not answer, or a record that cannot be read as a placement
 * makes `ok` false, and `error` says every reason.
 *
 * @param {object} i
 * @param {string} i.app
 * @param {object} i.request     the registered, normalized hosting request
 * @param {object[]|null} i.records  appRecords(), or null when the ledger was unreadable
 * @param {object|undefined} i.appRec  fleet-hosting.json apps[app]
 * @param {Map<string, object>} i.probes  node → { answered, row, observedAt }
 * @param {object[]} i.notices   drainNotices + hostingNotices, every node
 * @param {Map<string, object|null>} [i.ci]  node → CI pressure (lib/hosting-ci-pressure.mjs)
 * @param {object|null} i.demand this app's demand record
 * @param {object|null} i.last   hosting-converge-last.json, or null when absent or unreadable
 * @param {string[]} i.problems
 * @param {number} i.now
 */
export function placementDocument({
	app,
	request,
	records,
	appRec,
	probes,
	notices,
	ci = new Map(),
	demand,
	last,
	problems,
	now,
}) {
	const why = [...problems];
	let placement = null;
	let slices = [];
	if (records) {
		const r = placementOf({
			singleton: request.availability?.singleton === true,
			records,
			appRec,
			releaseOrder: demand?.releaseOrder ?? [],
		});
		if (r.error) why.push(r.error);
		else placement = r.placement;
		const registeredPort = request.network?.ports?.[0] ?? null;
		slices = records.map((rec) =>
			sliceRow(rec, probes.get(rec.node), {
				notices: notices.filter((n) => n.node === rec.node).map(({ node: _node, ...n }) => n),
				registeredPort,
				ci: ci.get(rec.node) ?? null,
			})
		);
		for (const s of slices)
			if (s.state === 'unknown') why.push(`${s.node} did not answer for ${app}'s slice: ${s.why}`);
	}
	const t = last?.tenants?.[app];
	return {
		contract: HOSTING_PLACEMENT_CONTRACT,
		generatedAt: new Date(now).toISOString(),
		cached: false,
		ok: why.length === 0,
		...(why.length ? { error: why.join('; ') } : {}),
		app,
		tenant: tenantView(request),
		placement,
		slices,
		ended: (appRec?.ended ?? [])
			.filter((e) => !(now - Date.parse(e.removedAt) > ENDED_KEEP_MS))
			.map(({ node, until, removedAt, role, epoch }) => ({
				node,
				until: until ?? null,
				removedAt,
				role: role === 'standby' ? 'standby' : 'primary',
				epoch: Number.isInteger(epoch) ? epoch : null,
			})),
		lastMove: appRec?.lastMove ?? null,
		demand: demand ?? null,
		converger: convergerView(last, app),
		offers: t?.offers
			? {
					at: last.at,
					...t.offers,
					ranked: (t.offers.ranked ?? []).map((o) => ({ ...o, ci: ci.get(o.node) ?? null })),
				}
			: null,
	};
}
