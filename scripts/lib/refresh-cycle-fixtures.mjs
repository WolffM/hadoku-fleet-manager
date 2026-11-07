/**
 * The refresh cycle's test rig: fixture nodes, a probe world, and a harness of
 * injected dependencies that records every side effect in order. Shared by
 * refresh-cycle.test.mjs and refresh-cycle-sweep.test.mjs; no node, no ssh.
 */
import assert from 'node:assert/strict';

import { runRefreshCycle } from './refresh-cycle.mjs';
import { REPAIRS, applicableRepairs } from './toolchain-floor.mjs';

export const CLAW = { labels: [] };
export const TASKAUTO = { labels: ['taskauto'] };
export const BACKSTOP = { role: 'backstop', labels: ['taskauto'] };

export const KNOWN = {
	status: 'known',
	version: '2.1.285',
	publishedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
};

/** A healthy probe for everything the node carries, claude at `claude`. */
export function seenFor(entry, { claude = '2.1.285', rust = true, apt = {} } = {}) {
	const seen = {};
	for (const [id, t] of applicableRepairs(entry)) {
		const ok = id === 'rust' || id === 'rust-wasm32' ? rust : true;
		seen[id] = {
			detect: ok ? 'OK' : '',
			login: ok ? 'OK' : '',
			// Reachable under every runner PATH the probe read (#127).
			runner: '',
			// `claude` is the version under test; any OTHER version-managed tool
			// (the JDK, on every claw since 2026-10-24) reads as current.
			...(t.version ? { version: id === 'claude' ? claude : KNOWN.version } : {}),
			// An apt-tracked tool reports `installed|candidate|state`; current by default.
			...(t.apt ? { apt: apt[id] ?? '1.0.0|1.0.0|current' } : {}),
		};
	}
	return seen;
}

/**
 * A fleet of fixture nodes. `world[node]` is what a probe returns RIGHT NOW;
 * `update` mutates it the way a real install would, unless told to fail.
 */
export function harness(machines, world, over = {}) {
	const events = [];
	const drained = new Set(over.alreadyDrained ?? []);
	const calls = { latest: 0 };
	let inFlight = 0;
	let maxInFlight = 0;
	const deps = {
		latest: async () => {
			calls.latest++;
			return over.latest ?? KNOWN;
		},
		detect: async (node, tools) => {
			events.push(`detect ${node}`);
			if (over.detectFails?.has(node)) return { ok: false, reason: 'ssh: no route' };
			assert.ok(
				tools.every(([id]) => REPAIRS[id]),
				'detect got a tool that is not declared'
			);
			(over.toolsSeen ??= {})[node] = tools.map(([id]) => id);
			return { ok: true, seen: structuredClone(world[node]) };
		},
		reprobe: async (node) => {
			events.push(`reprobe ${node}`);
			if (over.reprobeThrows) throw new Error('ssh died');
			if (over.reprobeUnreadable) return { ok: false, reason: 'unreadable after update' };
			return { ok: true, seen: structuredClone(world[node]) };
		},
		isDrained: async (node) => drained.has(node),
		drain: async (node, { kind }) => {
			events.push(`drain ${node} ${kind}`);
			if (over.drainFails) throw new Error('refused: would leave no node');
			if (kind === 'training') {
				assert.equal(drained.size, 0, 'a second node was drained while another was held');
			}
			drained.add(node);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
		},
		undrain: async (node) => {
			events.push(`undrain ${node}`);
			drained.delete(node);
			inFlight--;
			return { ok: !over.undrainFails, reason: 'write failed' };
		},
		waitDrained: async (node) => {
			events.push(`wait ${node}`);
			return over.waitResult ?? { drained: true };
		},
		update: async (node, work) => {
			events.push(`update ${node}`);
			assert.ok(drained.has(node), 'UPDATE RAN ON A NODE THAT IS NOT DRAINED');
			assert.equal(over.state.held, node, 'state.held does not name the node we hold');
			await new Promise((r) => setImmediate(r));
			if (over.updateThrows) throw new Error('curl: connection reset');
			return work.map((w) => {
				if (over.updateFails) return { id: w.id, ok: false, reason: 'install exited 1' };
				if (w.action === 'link') {
					if (over.linkFails)
						return { id: w.id, ok: false, reason: 'sudo: a password is required' };
					if (!over.updateNoEffect) {
						// The link makes the login-shell view the stock-PATH view.
						// The link lands in /usr/local/bin, which every runner PATH carries.
						const t = world[node][w.id];
						t.detect = 'OK';
						t.runner = '';
						t.version = t.loginversion ?? '';
					}
					return { id: w.id, ok: true };
				}
				if (over.breakOnUpdate) {
					for (const k of Object.keys(world[node])) world[node][k].detect = '';
				} else if (!over.updateNoEffect) {
					if (w.id === 'claude') world[node].claude.version = w.target;
					else if (world[node][w.id].apt) {
						const [, cand] = world[node][w.id].apt.split('|');
						world[node][w.id].apt = `${cand}|${cand}|current`;
					} else Object.assign(world[node][w.id], { detect: 'OK', runner: '' });
				}
				return { id: w.id, ok: true };
			});
		},
		queuePressure: async () => over.pressure ?? { pressured: false },
	};
	over.state = { held: null };
	const run = (opts = {}) => runRefreshCycle({ machines, deps, state: over.state, ...opts });
	return {
		run,
		deps,
		state: over.state,
		events,
		drained,
		calls,
		get maxInFlight() {
			return maxInFlight;
		},
		toolsSeen: () => over.toolsSeen,
	};
}

export const two = () => [
	['claw-a', TASKAUTO],
	['claw-b', TASKAUTO],
];

export const DAY = 86_400_000;
export const NOW = Date.now();
export const recordAt = (daysAgo) => ({
	$capabilities: { at: new Date(NOW - daysAgo * DAY).toISOString() },
});

export function withRebootcamp(h, { fail = false } = {}) {
	const calls = [];
	return {
		calls,
		rebootcamp: async (node) => {
			h.events.push(`rebootcamp ${node}`);
			calls.push(node);
			return fail ? { ok: false, reason: 'dirty tree' } : { ok: true };
		},
	};
}
