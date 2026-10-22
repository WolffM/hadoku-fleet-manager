/**
 * THE DEPLOYED MANIFEST, THE COMMIT IT WAS DEPLOYED FROM, AND `origin/main` —
 * the three documents whose disagreement is the whole of this gate.
 *
 * `manifest-target.mjs` is the half that stops a write from landing somewhere
 * it will be erased. This is the half that OBSERVES, because a guard on the
 * writers cannot see a write made by anything else: a hand edit, an older
 * deployed fleet-manager that predates the guard, a script somebody ran from
 * `~/srv` because that is where the CLI was. CLAUDE.md: "the reader for a facet
 * may not read what the writer wrote" — so the reader here is not the writer's
 * read-back, it is git.
 *
 * TWO COMPARISONS, TWO DIFFERENT FAILURES, AND THEY MUST NOT COLLAPSE
 * ------------------------------------------------------------------
 *   working vs HEAD     the deployed checkout's file differs from the commit it
 *                       is checked out at. Somebody wrote the deploy tree. That
 *                       write is ALREADY doomed — the next publish anywhere in
 *                       the ecosystem runs `git reset --hard origin/main` here
 *                       — and it is the case this whole lane exists for.
 *                       `unlanded-write`.
 *
 *   HEAD vs origin/main the deploy is running an older manifest than main
 *                       holds. Nothing is lost, but every reader on this box —
 *                       the dispatcher, the fast loop, the JIT reap — is acting
 *                       on stale capacity, capability and health records.
 *                       `undeployed`.
 *
 * The first is recoverable only by whoever still has the numbers; the second
 * clears itself the moment a redeploy runs. Reporting them as one "drift" would
 * hand an operator a finding with two opposite fixes.
 *
 * WHY A GRACE BAND ON THE SECOND ONE, AND WHY NONE ON THE FIRST
 * ------------------------------------------------------------
 * A commit that touches `scripts/admin/fleet-runner-manifest.json` triggers
 * `redeploy-mgmt-api.yml` by path, so `undeployed` is the NORMAL state for the
 * ~2 minutes between the push and the redeploy. A gate that fired there would
 * page on every correct landing, which is how a gate gets turned off.
 *
 * So a `HEAD vs origin/main` difference whose main-side commit is younger than
 * the grace is DEFERRED, not dropped — it is reported in `deferred` with its
 * age, so a reader can see it. CLAUDE.md's rule is that no gate may get EASIER
 * to pass the worse the failure gets, and this band satisfies it in the right
 * direction: a redeploy that never happens does not leave the band, it crosses
 * it and becomes a finding. The band shrinks as the failure grows.
 *
 * `unlanded-write` gets no band at all. It is not in flight and it is not
 * converging on anything; it is already lost and only the age of the loss is
 * still in question.
 *
 * EVERY `$`-FACET, INCLUDING ONES THAT DO NOT EXIST YET — EXCEPT THE TWO THAT LEFT
 * -------------------------------------------------------------------------------
 * The supply facets that live in the manifest are `$capabilities` and
 * `$measured`, and naming them here would go stale the first time another
 * landed — quietly, in the direction of reporting clean. `$` is the convention
 * the manifest already uses for a provenanced `{at, by, ...}` block, so the
 * scan is over the PREFIX and a new facet is covered on the day it is written.
 * The `$why-*` prose and the root `$`-keys (`$schema`, `$comment`, …) ride the
 * same prefix and are compared too.
 *
 * `$benchmark` and `$health` are EXCLUDED, by name, and that list is not a
 * second copy of anything: it is `MANIFEST_KEY` from `src/lib/measured.ts`,
 * the one declaration of which facets moved to the state dir (Wave 3h). The
 * manifest is no longer their record, so a difference in them between the
 * three trees is not a lost write — the write went to `<stateDir>/<facet>.json`,
 * which no publish resets, and the `unlanded-write` failure this gate exists
 * for cannot happen to them at all. Comparing them anyway would page on the
 * by-hand manifest edit that strips them (S §4 step 5) for as long as the deploy
 * lagged main, which is a finding about a field nothing reads.
 */
import { MANIFEST_KEY } from '../../dist/lib/measured.js';

/**
 * The manifest keys this gate does NOT compare, because the state dir — not the
 * manifest — is where those facets are recorded now.
 */
export const MOVED_FACETS = new Set(Object.values(MANIFEST_KEY));

/**
 * A stable serialisation: object keys sorted, recursively.
 *
 * Two writers can produce the same facet with the same values in a different
 * key order — `enroll --update` assigns three named fields onto an existing
 * entry while a fresh enroll builds the object literal — and a plain
 * `JSON.stringify` comparison would score that as drift. A gate that cries wolf
 * on a correct landing is one an operator learns to skip.
 */
export function stable(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

/**
 * Every `$`-prefixed facet in a manifest document, as `dotted path -> value`.
 *
 * Both levels the manifest actually uses: document root (`$schema` and anything
 * later added beside it) and `machines[<node>]`, where the supply facets that
 * stayed live. {@link MOVED_FACETS} are skipped at the node level.
 */
export function facets(doc) {
	const out = new Map();
	if (!doc || typeof doc !== 'object') return out;
	for (const [k, v] of Object.entries(doc)) {
		if (k.startsWith('$')) out.set(k, v);
	}
	const machines = doc.machines;
	if (machines && typeof machines === 'object') {
		for (const node of Object.keys(machines).sort()) {
			const m = machines[node];
			if (!m || typeof m !== 'object') continue;
			for (const [k, v] of Object.entries(m)) {
				if (k.startsWith('$') && !MOVED_FACETS.has(k)) out.set(`machines.${node}.${k}`, v);
			}
		}
	}
	return out;
}

/**
 * Facet-level difference between two manifest documents, `left` first.
 *
 * @returns {{ facet: string, state: 'only-left'|'only-right'|'differs',
 *             leftAt: string|null, rightAt: string|null }[]}
 */
export function facetDiff(left, right) {
	const a = facets(left);
	const b = facets(right);
	const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
	const diffs = [];
	for (const facet of keys) {
		const hasA = a.has(facet);
		const hasB = b.has(facet);
		if (hasA && hasB && stable(a.get(facet)) === stable(b.get(facet))) continue;
		diffs.push({
			facet,
			state: !hasA ? 'only-right' : !hasB ? 'only-left' : 'differs',
			leftAt: at(a.get(facet)),
			rightAt: at(b.get(facet)),
		});
	}
	return diffs;
}

/** A facet's own `at` stamp, when it carries one. Every `{at, by, ...}` block does. */
function at(value) {
	return value && typeof value === 'object' && typeof value.at === 'string' ? value.at : null;
}

const SIDE = {
	'only-left': 'present on the left and absent on the right',
	'only-right': 'absent on the left and present on the right',
	differs: 'differs',
};

/**
 * The verdict.
 *
 * @param {{ working: unknown, head: unknown, origin: unknown,
 *           mainAgeSeconds: number|null, graceSeconds: number }} input
 *   `mainAgeSeconds` is how old origin/main's newest commit touching the
 *   manifest is; `null` means it could not be read, which DENIES the grace
 *   rather than granting it — an unknown age must never buy a deferral.
 */
export function srvDriftVerdict({ working, head, origin, mainAgeSeconds, graceSeconds }) {
	const findings = [];
	const deferred = [];

	for (const d of facetDiff(working, head)) {
		findings.push({
			kind: 'unlanded-write',
			facet: d.facet,
			why:
				`${d.facet} on the DEPLOYED checkout ${SIDE[d.state]} the commit it is checked out ` +
				`at${d.leftAt ? ` (written ${d.leftAt})` : ''}. Something wrote the deploy tree: the ` +
				'next publish anywhere in the ecosystem runs `git reset --hard origin/main` here and ' +
				'this record is gone with nothing said. Re-run the writer against a development ' +
				'checkout so it commits, or commit this file by hand from a checkout that can push.',
		});
	}

	const inFlight = mainAgeSeconds !== null && mainAgeSeconds < graceSeconds;
	for (const d of facetDiff(head, origin)) {
		const entry = {
			kind: inFlight ? 'deploy-pending' : 'undeployed',
			facet: d.facet,
			ageSeconds: mainAgeSeconds,
			why:
				`${d.facet} on the commit the deploy is running ${SIDE[d.state]} origin/main` +
				`${d.rightAt ? ` (main's copy written ${d.rightAt})` : ''}. ` +
				(inFlight
					? `main's newest manifest commit is ${Math.round(mainAgeSeconds)}s old and a manifest ` +
						'commit triggers redeploy-mgmt-api.yml by path, so this is a deploy in flight. ' +
						'It becomes a finding if it is still here after the grace.'
					: 'Every reader on this box — the dispatcher, the fast loop, the JIT reap — is ' +
						'acting on a stale record. A manifest commit is supposed to trigger ' +
						'redeploy-mgmt-api.yml by path; check that workflow rather than this file.'),
		};
		(inFlight ? deferred : findings).push(entry);
	}

	return { ok: findings.length === 0, findings, deferred };
}
