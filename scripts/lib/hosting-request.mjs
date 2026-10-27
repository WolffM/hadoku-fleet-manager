/**
 * THE HOSTING REQUEST: what an app needs, in its own repo as `hosting.json`.
 * Schema v1, settled with cardtable on 2026-10-27, which the operator ruled may
 * shape the hosting architecture (it is the biggest customer by far).
 * Design: docs/planning/hosting-layer-2026-10-27.md §9.
 *
 * {@link validateHostingRequest} reads the parsed file and returns
 * `{ ok, request, problems }`. `request` is the NORMALIZED request (defaults
 * filled in), and it is what the planner and the runtime read. Every vague or
 * contradictory ask is a problem with its reason. A request is never repaired
 * by guessing: one that names no memory is refused, not given one.
 *
 * TWO KINDS, one layer:
 *   agent    a binary the fleet supervises as a system unit as the app's own
 *            user (cardtable).
 *   service  an app hadoku_site deploys (pm2). The fleet gives it the same
 *            user, slice and guarantees; hadoku_site keeps the app layer.
 *
 * Placement rules live in lib/hosting-placement.mjs: one entry per rule, read
 * by this validator and by the planner alike.
 */
import { checkRule } from './hosting-placement.mjs';

/** The fleet will not promise less notice than this, whatever a request says. */
export const NOTICE_FLOOR_MIN = 15;

export const KINDS = ['agent', 'service'];

/**
 * `isolation.advisoryUntil`: how many fitting claws must be cut over to their
 * own CI user before `ciMayRead: false` stops being a preference and becomes a
 * filter. The TENANT's number. 3 is cardtable's ruling (a filter while no
 * claw is cut over would take away its base claw), kept as the default so a
 * request written before the field existed plans as it did. A tenant whose
 * data must never sit beside root CI says 0.
 */
export const ADVISORY_UNTIL_DEFAULT = 3;

/** How traffic reaches the tenant. A closed set: each one is a firewall shape the fleet knows. */
export const INGRESS = {
	/** The coordinator on the controller calls it: LAN + the controller's tailnet; everyone else dropped. */
	controller: 'reached only from the controller',
	/** A public hostname through the node's own cloudflared; the port stays on loopback. */
	tunnel: "reached through the node's cloudflared tunnel; the port binds loopback only",
	none: 'takes no inbound connections',
};

/**
 * What `runtime.workersOutliveRestart` MEANS, said once (cardtable asked for it
 * to be explicit): the agent's unit carries `Delegate=yes` and
 * `KillMode=process`, and the memory and cpu controllers are available to its
 * subtree. A restart signals only the agent; its workers keep running.
 */
export const WORKERS_OUTLIVE_RESTART = {
	unit: ['Delegate=yes', 'KillMode=process'],
	subtreeControllers: ['memory', 'cpu'],
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isName = (v) => typeof v === 'string' && /^[a-z][a-z0-9-]{1,30}$/.test(v);

/** Validate and normalize one parsed `hosting.json`. */
export function validateHostingRequest(raw) {
	const problems = [];
	const bad = (path, why) => problems.push({ path, why });
	if (!isObj(raw))
		return { ok: false, request: null, problems: [{ path: '', why: 'not a JSON object' }] };

	if (!isName(raw.app))
		bad('app', 'a lowercase name, 2-31 chars: it becomes the tenant user and unit names');
	if (!KINDS.includes(raw.kind)) bad('kind', `one of ${KINDS.join(', ')}`);

	// slices: one unit size, and how many the tenant may hold.
	const s = raw.slices;
	let slices = null;
	if (!isObj(s) || !isObj(s.unit)) bad('slices.unit', 'required: the size of ONE slice');
	else {
		const { memoryMb, cores, steadyMb } = s.unit;
		if (!(isPosInt(memoryMb) && memoryMb >= 256))
			bad('slices.unit.memoryMb', 'whole MiB, at least 256: the ceiling AND the protected amount');
		if (!isPosInt(cores))
			bad('slices.unit.cores', 'whole cores, at least 1 (a quota: threads, not pinned cores)');
		if (steadyMb !== undefined && !(isPosInt(steadyMb) && steadyMb <= memoryMb))
			bad('slices.unit.steadyMb', 'whole MiB, no more than memoryMb');
		const min = s.min ?? 1;
		const max = s.max ?? 1;
		if (!Number.isInteger(min) || min < 0) bad('slices.min', 'a whole number, 0 or more');
		if (!isPosInt(max) || max < min)
			bad('slices.max', 'a whole number, at least 1 and at least min');
		slices = { unit: { memoryMb, cores, ...(steadyMb ? { steadyMb } : {}) }, min, max };
	}

	const rt = isObj(raw.runtime) ? raw.runtime : {};
	if (raw.kind === 'service' && slices && slices.max !== 1)
		bad('slices.max', 'a service is one deployed app: max must be 1');
	if (raw.kind === 'agent' && rt.manager !== undefined)
		bad(
			'runtime.manager',
			'an agent is supervised by the fleet; a process manager is a service field'
		);
	if (raw.kind === 'service' && rt.manager !== 'pm2')
		bad('runtime.manager', 'a service names its manager: "pm2"');
	if (rt.workersOutliveRestart !== undefined && typeof rt.workersOutliveRestart !== 'boolean')
		bad('runtime.workersOutliveRestart', 'true or false');

	const net = isObj(raw.network) ? raw.network : {};
	const ingress = net.ingress ?? 'none';
	if (!(ingress in INGRESS)) bad('network.ingress', `one of ${Object.keys(INGRESS).join(', ')}`);
	const ports = net.ports ?? [];
	if (!Array.isArray(ports) || !ports.every((p) => Number.isInteger(p) && p >= 1024 && p <= 65535))
		bad('network.ports', 'unprivileged port numbers (1024-65535)');
	if (ingress !== 'none' && !ports.length)
		bad('network.ports', `ingress "${ingress}" needs the port it is reached on`);
	if (ingress === 'tunnel' && typeof net.hostname !== 'string')
		bad('network.hostname', 'a tunnel ingress names its public hostname');
	if (ingress === 'tunnel' && raw.kind === 'agent')
		bad('network.ingress', "the tunnel is the app layer's; an agent is reached by its controller");
	const egress = net.egress ?? [];
	if (!Array.isArray(egress) || !egress.every((e) => typeof e === 'string'))
		bad('network.egress', 'a list of hostnames (documented now; enforced later)');

	const disk = isObj(raw.disk) ? raw.disk : {};
	if (!(typeof disk.stateGb === 'number' && disk.stateGb > 0))
		bad('disk.stateGb', 'how much the tenant keeps on the node, in GB, more than 0');

	const av = isObj(raw.availability) ? raw.availability : {};
	const noticeMin = av.noticeMin ?? NOTICE_FLOOR_MIN;
	if (!(Number.isInteger(noticeMin) && noticeMin >= NOTICE_FLOOR_MIN))
		bad(
			'availability.noticeMin',
			`whole minutes, at least the fleet's floor of ${NOTICE_FLOOR_MIN}`
		);
	for (const k of ['stateful', 'singleton'])
		if (av[k] !== undefined && typeof av[k] !== 'boolean')
			bad(`availability.${k}`, 'true or false');
	if (av.singleton && slices && slices.max !== 1)
		bad('availability.singleton', 'a singleton holds at most one slice: max must be 1');

	const pl = isObj(raw.placement) ? raw.placement : {};
	const require = pl.require ?? [];
	const prefer = pl.prefer ?? [];
	for (const [k, list] of [
		['require', require],
		['prefer', prefer],
	]) {
		if (!Array.isArray(list)) {
			bad(`placement.${k}`, 'a list of rules');
			continue;
		}
		for (const r of list) {
			const c = checkRule(r);
			if (!c.ok) bad(`placement.${k}`, c.why);
		}
	}

	const iso = isObj(raw.isolation) ? raw.isolation : {};
	if (iso.ciMayRead !== undefined && typeof iso.ciMayRead !== 'boolean')
		bad('isolation.ciMayRead', 'true or false');
	const advisoryUntil = iso.advisoryUntil ?? ADVISORY_UNTIL_DEFAULT;
	if (!(Number.isInteger(advisoryUntil) && advisoryUntil >= 0))
		bad('isolation.advisoryUntil', 'a whole number of cut-over claws, 0 or more (0: a filter now)');
	if (iso.ciMayRead === true && iso.advisoryUntil !== undefined)
		bad('isolation.advisoryUntil', 'only means something when ciMayRead is false');

	if (problems.length) return { ok: false, request: null, problems };
	return {
		ok: true,
		problems: [],
		request: {
			app: raw.app,
			kind: raw.kind,
			slices,
			runtime: { ...rt, workersOutliveRestart: rt.workersOutliveRestart === true },
			network: { ingress, ports, egress, ...(net.hostname ? { hostname: net.hostname } : {}) },
			disk: {
				stateGb: disk.stateGb,
				...(disk.growthGbPerMonth ? { growthGbPerMonth: disk.growthGbPerMonth } : {}),
			},
			availability: {
				noticeMin,
				stateful: av.stateful === true,
				singleton: av.singleton === true,
				...(av.coldStartS ? { coldStartS: av.coldStartS } : {}),
			},
			placement: { require, prefer },
			// Defaults to false: a tenant has to SAY CI may read it.
			isolation: iso.ciMayRead === true ? { ciMayRead: true } : { ciMayRead: false, advisoryUntil },
			...(raw.contact ? { contact: raw.contact } : {}),
		},
	};
}
