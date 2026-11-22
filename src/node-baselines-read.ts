/**
 * The ONE reader of `node-baselines.json` (hadoku-fleet-manager#129): each
 * node's learned range per measured quantity, and its weak points. Here, in
 * the state layer of `src/`, so placement (in-process) and the scripts
 * (`scripts/lib/node-baselines.mjs`, the file's sole WRITER, which re-exports
 * this) parse the file one way.
 *
 * A missing file is an empty store; an unreadable one is `{ok:false, reason}`,
 * never an empty store, because "nothing learned" and "could not look" are
 * different answers.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const NODE_BASELINES_FILE = 'node-baselines.json';

export interface BaselineEntry {
	mean: number;
	sd: number;
	n: number;
	unit?: string;
	worse?: 'higher' | 'lower';
	lastValue?: number;
	updatedAt?: string;
	lastDrift?: { at: string; from: number; to: number };
}

export interface WeakPoint {
	reason: string;
	since: string;
	lastSeen: string;
}

export interface NodeBaselineStore {
	/** `node::quantity` → estimate. */
	quantities: Record<string, BaselineEntry>;
	/** node → test id → weak point. */
	weakPoints: Record<string, Record<string, WeakPoint>>;
}

export type NodeBaselineRead =
	{ ok: true; store: NodeBaselineStore } | { ok: false; reason: string };

export function readNodeBaselines(dir: string): NodeBaselineRead {
	const path = join(dir, NODE_BASELINES_FILE);
	if (!existsSync(path)) return { ok: true, store: { quantities: {}, weakPoints: {} } };
	try {
		const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
		if (!doc || typeof doc !== 'object' || Array.isArray(doc))
			return { ok: false, reason: `${path} is not a JSON object` };
		const o = doc as Partial<NodeBaselineStore>;
		return { ok: true, store: { quantities: o.quantities ?? {}, weakPoints: o.weakPoints ?? {} } };
	} catch (err) {
		return { ok: false, reason: `${path}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/** One node's estimates, quantity → entry. */
export function nodeQuantities(
	store: NodeBaselineStore,
	node: string
): Record<string, BaselineEntry> {
	const prefix = `${node}::`;
	return Object.fromEntries(
		Object.entries(store.quantities ?? {})
			.filter(([k]) => k.startsWith(prefix))
			.map(([k, v]) => [k.slice(prefix.length), v])
	);
}
