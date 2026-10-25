/**
 * CAPABILITY REVOCATIONS — a label a node failed to EXECUTE is not offered.
 *
 * On 2026-10-25 claw-1 rebooted onto a kernel its NVIDIA driver had not been
 * built for, and went on advertising `nvenc-h264` for hours: `earned` is
 * rewritten only by `fleet bootcamp --write` (weekly recheck), and the daily
 * `check:capabilities` that DID execute the encode and see it fail could only
 * page. The operator's ruling: a node must not advertise a label it has not
 * proven. This is the fleet-side half of that — the reboot cycle re-proves a
 * node before undraining it, and this covers drift found at any other time.
 *
 * THE RULE. Any probe that EXECUTES an offered routing label and judges it
 * failed records a revocation here; `nodeOffer` withholds a revoked label on the
 * next tick, everywhere a label is handed out (the mint, warm listeners,
 * placement, the label floor, standing registrations). A probe that executes it
 * and judges it PASSED clears it. Nothing else clears one — not a drain being
 * lifted, not a restart, not a reboot (the reboot cycle relies on that).
 *
 * "I COULD NOT LOOK" CHANGES NOTHING. An unreachable node, a measurement taken
 * beside a live job (not judged), a probe that printed no result for a label —
 * none of them revoke or clear. Only a judged execution moves the record.
 *
 * A CORRUPT FILE FAILS CLOSED, the way a corrupt `$proof` does: which labels were
 * revoked is unknown, so every probe-verified routing label is withheld
 * fleet-wide until it is readable. `hadoku-builder` is an eligibility label and is
 * never withheld here, so general CI keeps flowing.
 *
 * WHY THE STATE DIR AND NOT `earned`. `earned` lives in a committed manifest and a
 * write there redeploys mgmt-api (#59). A revocation must take effect on the
 * next tick and be cleared just as fast, without a commit, by whichever probe
 * looked last — it is an observation, like `$proof`, not configuration.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REVOCATIONS_FILE = 'capability-revocations.json';

export interface Revocation {
	/** When the failed execution was judged. */
	at: string;
	/** The probe's own reason, verbatim. */
	reason: string;
	/** Which probe judged it: `capabilities`, `bootcamp`. */
	by: string;
}

/** node -> capability id -> revocation. */
export type Revocations = Record<string, Record<string, Revocation>>;

/** What a reader gets: the record, or `corrupt` (withhold everything probe-verified). */
export type RevocationRead =
	{ corrupt: false; nodes: Revocations } | { corrupt: true; why: string };

/** Parse the file's text. Empty is no revocations; malformed is `corrupt`, never empty. */
export function parseRevocations(raw: string): RevocationRead {
	if (!raw.trim()) return { corrupt: false, nodes: {} };
	try {
		const doc = JSON.parse(raw) as { nodes?: unknown };
		const nodes = doc?.nodes;
		if (nodes === undefined) return { corrupt: false, nodes: {} };
		if (typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) {
			return { corrupt: true, why: '`nodes` is not an object' };
		}
		return { corrupt: false, nodes: nodes as Revocations };
	} catch (err) {
		return { corrupt: true, why: err instanceof Error ? err.message : String(err) };
	}
}

/** Read from `dir` (the state dir). A missing file is no revocations. */
export function readRevocations(dir: string): RevocationRead {
	const path = join(dir, REVOCATIONS_FILE);
	if (!existsSync(path)) return { corrupt: false, nodes: {} };
	try {
		return parseRevocations(readFileSync(path, 'utf8'));
	} catch (err) {
		return { corrupt: true, why: err instanceof Error ? err.message : String(err) };
	}
}

/** Write atomically: a reader on the 15 s tick must never see half a file. */
export function writeRevocations(dir: string, nodes: Revocations): void {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, REVOCATIONS_FILE);
	const tmp = `${path}.tmp-${process.pid}`;
	const pruned = Object.fromEntries(
		Object.entries(nodes).filter(([, caps]) => Object.keys(caps).length)
	);
	writeFileSync(
		tmp,
		`${JSON.stringify({ $comment: 'Labels a probe executed and judged FAILED; withheld from routing until a passing probe clears them. See src/capability-revocations.ts.', nodes: pruned }, null, 2)}\n`
	);
	renameSync(tmp, path);
}

/** One judged execution of an offered label. */
export interface ProbeVerdict {
	node: string;
	capability: string;
	passed: boolean;
	reason: string;
}

/**
 * Fold judged verdicts into the record. Pure. Returns the new record and what
 * changed, so the caller can SAY it ("revoked", "cleared") rather than do it
 * silently.
 */
export function applyVerdicts(
	current: Revocations,
	verdicts: readonly ProbeVerdict[],
	by: string,
	at: string = new Date().toISOString()
): { nodes: Revocations; revoked: ProbeVerdict[]; cleared: ProbeVerdict[] } {
	const nodes: Revocations = Object.fromEntries(
		Object.entries(current).map(([n, caps]) => [n, { ...caps }])
	);
	const revoked: ProbeVerdict[] = [];
	const cleared: ProbeVerdict[] = [];
	for (const v of verdicts) {
		const held = nodes[v.node]?.[v.capability];
		if (v.passed) {
			if (held) {
				delete nodes[v.node][v.capability];
				cleared.push(v);
			}
		} else if (!held) {
			(nodes[v.node] ??= {})[v.capability] = { at, reason: v.reason, by };
			revoked.push(v);
		}
	}
	return { nodes, revoked, cleared };
}

/**
 * The per-node set `nodeOffer` subtracts, from one read. `'all'` when the file
 * is corrupt: every probe-verified label is withheld.
 */
export function revokedSets(read: RevocationRead): Record<string, ReadonlySet<string>> | 'all' {
	if (read.corrupt) return 'all';
	return Object.fromEntries(
		Object.entries(read.nodes).map(([n, caps]) => [n, new Set(Object.keys(caps))])
	);
}
