/**
 * GARAGE'S BACKGROUND LOAD PER ZONE, as admission measured it
 * (hadoku-fleet-manager#159, from #156's node-impact soak).
 *
 * `disk-node-impact` loads a zone with Garage's background work (resync and
 * scrub) at its default share, then half, then a quarter, and records the
 * highest level the node's own work tolerates. Below the default the result
 * carries `tuning`: the resync and scrub tranquility that hold Garage at that
 * level (qualify-disk-impact-judge.mjs `tuningFor`). This module turns that
 * into what each node's Garage should run with, against what it runs with:
 *
 *   wanted    an admitted zone: its tuning, or Garage's defaults when it took
 *             the default load. A zone that is not admitted (no result yet, an
 *             expired one, a failure): what the declaration last recorded, else
 *             nothing is wanted and nothing is changed.
 *   observed  the node's own worker variables (`GetWorkerVariable`, node=self),
 *             read every plan. Never the declaration: a reader may not read
 *             what the writer wrote.
 *
 * Every difference is a `tune` op. `fleet garage-layout --apply` sets it
 * (`SetWorkerVariable`, which Garage persists in its metadata), records it in
 * the zone's declaration (garage-layout-state.mjs `recordTuning`) and re-reads.
 * A node whose variables could not be read is a problem the plan names, never
 * "already tuned".
 */

/** Garage's own defaults (v2: resync 2, scrub 4), the level-1 load of the soak. */
export const GARAGE_DEFAULT_TUNING = Object.freeze({ resyncTranquility: 2, scrubTranquility: 4 });
export const TUNING_VARIABLES = Object.freeze({
	resyncTranquility: 'resync-tranquility',
	scrubTranquility: 'scrub-tranquility',
});

/**
 * PURE. What each active zone's Garage should run with.
 * @param {{ declared: object, checks: object[] }} a  checks: the plan's `admitted` checks
 * @returns {Map<string, { tuning: object, why: string, admitted: boolean }>}
 */
export function wantedTuning({ declared, checks }) {
	const out = new Map();
	for (const [node, z] of Object.entries(declared?.zones ?? {}).sort()) {
		if (z.state !== 'active') continue;
		const mine = checks.filter(
			(c) =>
				c.rule === 'admitted' &&
				(c.subject === `${node} root` || String(c.subject).startsWith(`${node} `))
		);
		const admitted = mine.length > 0 && mine.every((c) => c.status === 'ok');
		if (admitted) {
			// Several disks in one zone: the quietest any of them needs.
			const tuned = mine.map((c) => c.tuning).filter(Boolean);
			const tuning = tuned.length
				? {
						resyncTranquility: Math.max(...tuned.map((t) => t.resyncTranquility)),
						scrubTranquility: Math.max(...tuned.map((t) => t.scrubTranquility)),
					}
				: { ...GARAGE_DEFAULT_TUNING };
			out.set(node, {
				tuning,
				admitted: true,
				why: tuned.length
					? 'its node-impact soak held only below the default load'
					: 'its node-impact soak held at the default load',
			});
		} else if (z.tuning) {
			out.set(node, {
				tuning: {
					resyncTranquility: z.tuning.resyncTranquility,
					scrubTranquility: z.tuning.scrubTranquility,
				},
				admitted: false,
				why: `not admitted now; keeping the tuning recorded ${z.tuning.at ?? ''}`.trim(),
			});
		}
	}
	return out;
}

/**
 * PURE. The `tune` ops: every wanted variable the node does not run with.
 * @param {{ wanted: ReturnType<typeof wantedTuning>, observed: Map<string, { vars?: object, error?: string }> }} a
 */
export function planTuning({ wanted, observed }) {
	const ops = [];
	const problems = [];
	for (const [node, w] of wanted) {
		const seen = observed.get(node);
		if (!seen || seen.error) {
			problems.push({ node, why: `worker variables unread: ${seen?.error ?? 'not read'}` });
			continue;
		}
		for (const [key, variable] of Object.entries(TUNING_VARIABLES)) {
			const from = seen.vars?.[variable];
			const to = w.tuning[key];
			if (from === undefined || Number(from) !== to)
				ops.push({ node, variable, from: from ?? null, to, why: w.why, tuning: w.tuning });
		}
	}
	return { ops, problems };
}

/** PURE. A node's own variables out of a `GetWorkerVariable` (node=self) response. */
export function parseWorkerVariables(response) {
	const nodes = Object.values(response?.success ?? {});
	const errors = Object.values(response?.error ?? {});
	if (nodes.length !== 1)
		throw new Error(
			`GetWorkerVariable answered for ${nodes.length} node(s)${errors.length ? `: ${errors.join('; ')}` : ''}`
		);
	return nodes[0];
}

/**
 * Each wanted node's worker variables, read on that node.
 * @param {(node: string) => { call: Function }} adminFor
 */
export async function observeTuning(adminFor, nodes) {
	const out = new Map();
	await Promise.all(
		nodes.map(async (node) => {
			try {
				const r = await adminFor(node).call('POST', 'GetWorkerVariable?node=self', {
					variable: null,
				});
				out.set(node, { vars: parseWorkerVariables(r) });
			} catch (e) {
				out.set(node, { error: e instanceof Error ? e.message : String(e) });
			}
		})
	);
	return out;
}

/** Set each op's variable on its node. Throws on the first refusal, naming it. */
export async function applyTuning(adminFor, ops, log = () => {}) {
	for (const o of ops) {
		const r = await adminFor(o.node).call('POST', 'SetWorkerVariable?node=self', {
			variable: o.variable,
			value: String(o.to),
		});
		const errors = Object.values(r?.error ?? {});
		if (errors.length) throw new Error(`${o.node} ${o.variable}=${o.to}: ${errors.join('; ')}`);
		log(`     ${o.node} ${o.variable} ${o.from ?? 'unset'} → ${o.to}`);
	}
}
