import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger, stateDir } from '../host.js';
import { coveredRepos } from '../ci-runner-fallback.js';
import { BUILDER_LABEL } from './census.js';
import { provesRequiredSet, requiredIdentitySet, type DemandRecord } from '../capabilities.js';
import { isGuestNode } from '../lib/node-role.js';
import { readFleetManifest, type FleetManifest } from '../lib/manifest.js';
import { nodeIsSick } from '../lib/sick-node.js';

/**
 * Repos an ephemeral node keeps a STANDING registration for — the same
 * manifest field `reconcile-fleet-runners.mjs` reads to create the pair.
 *
 * Read fresh each call, same as `loadEphemeralNodes`: emptying an entry (or
 * moving it to a different node) takes effect on the next tick. An unreadable
 * manifest returns no residents rather than throwing, matching every other
 * loader in this file — `setTierEligibility` already fails toward promotion,
 * and a resident set that silently vanished for a tick costs one missed label
 * write, not a wrong one.
 */
export function loadResidentRepos(node: string): string[] {
	const raw = readFleetManifest();
	return raw?.machines?.[node]?.residentRepos ?? [];
}

/**
 * The demand-derived REQUIRED SET, or `null` when it could not be read.
 *
 * `requiredIdentitySet` over the `class: "ci"` rows of
 * `~/.hadoku-mgmt/demand-ledger.jsonl` — the same derivation `check-label-floor`
 * uses, through the same registry function, so the gate that REPORTS the
 * contract and the ladder that ENFORCES it cannot drift.
 *
 * `null` means "I could not look", and it is DISTINCT from an empty set: a
 * missing file, an unreadable one and a malformed line are all `null`, while a
 * file that parsed and asked for nothing is `new Set()`. Both refuse to move a
 * label ({@link nodeFailsBootcamp}), but only one of them is a bug in the
 * writer, and the log line says which.
 *
 * A MALFORMED LINE IS `null`, NOT A SHORTER SET. Skipping the bad row would
 * silently under-count demand, which lowers the bar every node has to clear —
 * exactly the shape `parseDemandLedger` refuses on the gate side.
 */
export function loadRequiredSet(): Set<string> | null {
	const path = resolve(stateDir(), 'demand-ledger.jsonl');
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (err) {
		logger.warn(
			`[fleet-loop] cannot read the demand ledger at ${path} ` +
				`(${err instanceof Error ? err.message : String(err)}) — no label will move this tick`
		);
		return null;
	}
	const records: DemandRecord[] = [];
	const lines = text.split('\n');
	for (let n = 0; n < lines.length; n++) {
		if (!lines[n].trim()) continue;
		try {
			records.push(JSON.parse(lines[n]) as DemandRecord);
		} catch (err) {
			logger.warn(
				`[fleet-loop] ${path} line ${n + 1} is not JSON ` +
					`(${err instanceof Error ? err.message : String(err)}) — the position in that ` +
					'message is relative to the LINE, not the file. No label will move this tick.'
			);
			return null;
		}
	}
	return requiredIdentitySet(records);
}

/**
 * Whether NODE's last `fleet bootcamp` finding disqualifies it from carrying
 * `hadoku-builder` — P1.2/P1.3, `bootcamp-earned-labels-2026-09-02.md` §4.
 * `hadoku-builder` used to be a hand-applied label nothing verified; this is
 * its producer.
 *
 * IT NOW ASKS `provesRequiredSet`, the predicate `check-label-floor` has been
 * REPORTING against since 2026-09-07 while this function fell back on "no
 * blocked, no unprobed" (wave 3a/3b §D1). One rule, one implementation: the gate
 * and the ladder can no longer disagree about what `hadoku-builder` means.
 *
 * THREE STATES REFUSE TO MOVE A LABEL, and each is a different fact:
 *
 *   GUEST            the node is not the ladder's to judge at all. A guest
 *                    lends the fleet a registration and is out of scope for
 *                    bootcamp's required set (operator, 2026-09-14). It never
 *                    reaches a write anyway — `planTierWrites` drops it — and
 *                    this is the second half of the same statement, so a
 *                    resident-registration caller cannot route around it.
 *   UNREADABLE SET   `required === null`. The ledger is missing, unreadable or
 *                    malformed, so the bar is unknown. Demoting here would take
 *                    the ENTIRE FLEET down at once on one bad file, at 3am,
 *                    which is why `provesRequiredSet`'s own header said this
 *                    flip "is only safe once the required set can be read
 *                    reliably". `check-label-floor` is what goes RED on it.
 *   EMPTY SET        `required.size === 0`. The ledger parsed and asked for
 *                    nothing. Every node clears a bar of zero, so enforcing it
 *                    would be a green fleet proving nothing — 3a settled that
 *                    an empty required set is a failure, not a pass. Same
 *                    refusal, different reason, and the reason is logged.
 *
 * FAIL-OPEN ON AN ABSENT RECORD STAYS, and is deliberately NOT delegated to
 * `provesRequiredSet` (which calls a node with no record `ok: false`).
 * `bootcamp.mjs`'s own header: "'I could not probe' is not 'the node cannot do
 * it'". A node `fleet bootcamp --write` has never reached has NO evidence
 * against it, and treating that as disqualifying would demote a freshly enrolled
 * claw before anyone had run bootcamp on it — the "capacity stranded on a fleet
 * that did nothing wrong" outcome this file's header names as the one failure
 * mode worse than a slow runner. `check-label-floor` prints those nodes as
 * `unverifiedNodes`, so the quiet fallback is never also a silent one.
 *
 * A RECORDED finding is a different thing: bootcamp executed the required set
 * and named what did not pass, and that disqualifies exactly as thermal/sick
 * demotion already does — per node, never fleet-wide.
 */
export function nodeFailsBootcamp(
	node: string,
	raw: FleetManifest | null = readFleetManifest(),
	required: ReadonlySet<string> | null = loadRequiredSet()
): boolean {
	const entry = raw?.machines?.[node];
	if (isGuestNode(entry)) return false; // not the ladder's to judge
	const rec = entry?.$capabilities;
	if (!rec) return false; // never probed — not the same as proven bad
	if (!required) return false; // could not read the bar — no label moves
	if (required.size === 0) {
		logger.warn(
			'[fleet-loop] the demand ledger yielded an EMPTY required set — every node clears a ' +
				'bar of zero, so no label moves this tick. Regenerate it with `fleet tool-inventory ' +
				'--write`.'
		);
		return false;
	}
	const verdict = provesRequiredSet(entry, required);
	if (!verdict.ok) {
		logger.warn(
			`[fleet-loop] ${node} does not prove the required set: ${verdict.reason} ` +
				`(missing ${verdict.missing.join(', ') || '(none)'})`
		);
	}
	return !verdict.ok;
}

/**
 * Every runner registration for a node across the fleet, with its current labels.
 *
 * `repos` defaults to every covered repo; a resident ephemeral node passes its
 * OWN (small) resident set instead, so processing it costs one API call per
 * resident repo rather than the full fleet walk — see the ephemeral branch in
 * `setTierEligibility`.
 */
async function registrationsFor(
	node: string,
	token: string,
	ghGet: (path: string, token: string, repo?: string) => Promise<unknown>,
	repos: readonly string[] = coveredRepos()
): Promise<{ repo: string; id: number; hasBuilder: boolean }[]> {
	const out: { repo: string; id: number; hasBuilder: boolean }[] = [];
	for (const repo of repos) {
		const resp = (await ghGet('/actions/runners?per_page=100', token, repo)) as {
			runners?: { id: number; name: string; labels?: { name: string }[] }[];
		} | null;
		if (!resp?.runners) continue;
		for (const r of resp.runners) {
			// A node owns the runner named for it plus any `<node>-*` instance.
			// The -b/-c/-d pools were retired on 2026-08-24 (one runner per node
			// now), but the prefix match stays: it costs nothing and is what makes
			// re-introducing an instance a config change rather than a code change.
			if (r.name !== node && !r.name.startsWith(`${node}-`)) continue;
			out.push({
				repo,
				id: r.id,
				hasBuilder: (r.labels ?? []).some((l) => l.name === BUILDER_LABEL),
			});
		}
	}
	return out;
}

export interface LabelAction {
	node: string;
	direction: 'promote' | 'demote';
	changed: number;
	failed: number;
}

/**
 * Converge one node's STANDING registrations onto `hadoku-builder` = safe.
 *
 * SAFE means: not quarantined, not drained, and not disqualified by its last
 * bootcamp finding (`nodeFailsBootcamp`). That is the whole rule. There is no
 * "is more throughput needed" input any more — the tier ladder that supplied it
 * was retired on 2026-09-21, having decided nothing under `carousel`.
 *
 * WHICH REGISTRATIONS. An ephemeral node serves its jobs through JIT mints and
 * carries no standing registrations, EXCEPT its `residentRepos` — standing
 * registrations the reconciler creates outside the mint path, born unlabelled
 * and waiting for this. Only that set is walked for an ephemeral node, which
 * keeps the O(repos x nodes) label traffic off the fleet. A non-ephemeral node
 * is walked across every covered repo.
 *
 * NOT GUESTS. A guest (hokon) lends the fleet a reserve registration, and its
 * builder label is the BACKSTOP's in runner-health, which applies the same
 * safety rule. One writer per label; the caller skips guests.
 */
export async function setNodeEligibility(
	node: string,
	token: string,
	gh: {
		get: (path: string, token: string, repo?: string) => Promise<unknown>;
		write: (
			method: 'POST' | 'DELETE',
			path: string,
			token: string,
			body?: unknown,
			repo?: string
		) => Promise<{ ok: boolean; status: number }>;
	},
	/** Whether the node should carry the label — see `nodeIsSafe`. */
	want: boolean,
	/** Resident repos for an ephemeral node; `undefined` means every covered repo. */
	repos?: readonly string[]
): Promise<LabelAction> {
	let changed = 0;
	let failed = 0;
	for (const reg of await registrationsFor(node, token, gh.get, repos)) {
		if (reg.hasBuilder === want) continue; // already in the desired state
		const res = want
			? await gh.write(
					'POST',
					`/actions/runners/${reg.id}/labels`,
					token,
					{ labels: [BUILDER_LABEL] },
					reg.repo
				)
			: await gh.write(
					'DELETE',
					`/actions/runners/${reg.id}/labels/${BUILDER_LABEL}`,
					token,
					undefined,
					reg.repo
				);
		if (res.ok) changed++;
		else if (!want && res.status === 404) {
			// Already gone: converged by someone else's hand. Not a failure.
		} else {
			failed++;
			logger.warn(
				`[fleet-loop] ${want ? 'promote' : 'demote'} ${node}@${reg.repo} → HTTP ${res.status}`
			);
		}
	}
	return { node, direction: want ? 'promote' : 'demote', changed, failed };
}

/**
 * The one safety predicate for a node carrying `hadoku-builder`: not
 * quarantined, not drained, not disqualified by bootcamp.
 */
export function nodeIsSafe(
	node: string,
	drainedNodes: ReadonlySet<string>,
	fleetManifest: FleetManifest | null,
	requiredSet: ReadonlySet<string> | null
): boolean {
	return (
		!nodeIsSick(node) &&
		!drainedNodes.has(node) &&
		!nodeFailsBootcamp(node, fleetManifest, requiredSet)
	);
}
