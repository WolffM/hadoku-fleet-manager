/**
 * HOSTING PLACEMENT RULES: what a tenant may require of a node, said once.
 *
 * Each rule is one entry: its meaning AND how a node's offer answers it. The
 * request validator reads the names, the planner reads `holds`, so a rule
 * cannot be accepted by one and unknown to the other. Adding a placement
 * capability is adding an entry here.
 *
 * `holds(offer)` answers true, false, or null ("could not tell"). A null is a
 * reason the planner refuses, never a pass.
 *
 * `label:<id>` is the general form: any routing label the node OFFERS right
 * now, as `nodeOffer` decides it (proven by bootcamp, past its workload gate,
 * not revoked). A capability the fleet already proves needs no rule of its own.
 * Not to be confused with lib/placement-rules.mjs, which places CI jobs.
 */
import { labelCapabilities } from '../../dist/capabilities.js';

/** Rules with no argument. */
const FIXED = {
	wired: {
		why: 'the node reaches the network over a cable, not Wi-Fi',
		holds: (o) => (o.link === null ? null : o.link === 'wired'),
	},
	'not-beside-unbounded': {
		why: 'nothing else on the node may hold memory without a ceiling (an unbounded pm2, for one)',
		holds: (o) => o.pm2.unbounded.length === 0,
	},
	'pm2-peer': {
		why: 'the node is a declared pm2 host of the app layer (its data endpoint and secrets listener answer it)',
		holds: (o) => o.pm2Peer,
	},
	'low-reboot-churn': {
		why: 'prefer nodes the reboot cycle touches rarely',
		// A preference with no data behind it yet; never refuses.
		holds: () => true,
	},
};

/** Rules written `<name>:<arg>`. `known(arg)` refuses an argument that could never match. */
const PARAM = {
	label: {
		why: 'the node offers this routing label now: proven, and not revoked',
		known: (arg) => labelIds().has(arg),
		holds: (o, arg) => (o.labels === null ? null : o.labels.includes(arg)),
	},
	gpu: {
		why: 'the node offers this GPU label now (a label: rule kept for its name)',
		known: (arg) => labelIds().has(arg),
		holds: (o, arg) => (o.labels === null ? null : o.gpu.includes(arg)),
	},
	'not-with': {
		why: 'the node holds no slice of the named tenant',
		known: (arg) => /^[a-z][a-z0-9-]{1,30}$/.test(arg),
		holds: (o, arg) => !o.tenants.some((t) => t.tenant === arg),
	},
};

let ids = null;
const labelIds = () => (ids ??= new Set(labelCapabilities().map((c) => c.id)));

/** Every rule as `{ rule, why }`, for help text and refusals. */
export function placementRules() {
	return [
		...Object.entries(FIXED).map(([rule, r]) => ({ rule, why: r.why })),
		...Object.entries(PARAM).map(([name, r]) => ({ rule: `${name}:<arg>`, why: r.why })),
	];
}

/** `{ ok: true }`, or `{ ok: false, why }` naming what is wrong with the rule. */
export function checkRule(rule) {
	if (typeof rule !== 'string') return { ok: false, why: 'a rule is a string' };
	if (Object.hasOwn(FIXED, rule)) return { ok: true };
	const i = rule.indexOf(':');
	const p = i > 0 ? PARAM[rule.slice(0, i)] : undefined;
	if (!p) {
		const known = placementRules()
			.map((r) => r.rule)
			.join(', ');
		return { ok: false, why: `unknown rule "${rule}"; known: ${known}` };
	}
	const arg = rule.slice(i + 1);
	if (!p.known(arg)) return { ok: false, why: `"${rule}": "${arg}" could never match a node` };
	return { ok: true };
}

/** Does `offer` satisfy `rule`? true / false / null (could not tell, or not a rule). */
export function ruleHolds(rule, offer) {
	if (Object.hasOwn(FIXED, rule)) return FIXED[rule].holds(offer);
	const i = rule.indexOf(':');
	const p = i > 0 ? PARAM[rule.slice(0, i)] : undefined;
	return p ? p.holds(offer, rule.slice(i + 1)) : null;
}
