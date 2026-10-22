/**
 * bootcamp-required — the ledger-derived required set, and which of it no
 * node proves. Split from `check-label-floor.mjs` so both halves can be
 * asserted without a fleet, an ssh connection, or a real ledger file — the
 * same reason `demand-derive.mjs` split from `check-tool-inventory.mjs`.
 *
 * `requiredIdentitySet` itself (which ledger records count) lives in
 * `src/capabilities.ts` — it is pure derivation over the registry's own
 * vocabulary, and this file is I/O plus the registry-vs-proof join around it.
 */
import { readFileSync } from 'node:fs';

import { isCiDemandRecord } from '../../dist/capabilities.js';
import { isGuestNode } from '../../dist/lib/node-role.js';

/**
 * The CI-demand rows of a parsed ledger.
 *
 * The ledger carries two classes since 2026-09-10 — `ci` (one row per
 * `(repo, job)`) and `resident` (one row per PM2 app, cron profile, checkout or
 * mirror) — and `service-ledger-2026-09-10.md` §3 is explicit that no reader in
 * this repo may iterate it without filtering. A resident row happens to lack
 * `fleetForm`, so today's CI predicates drop it by accident; the next reader to
 * iterate rows and read a resource column will not be so lucky. `isCiDemandRecord`
 * is the one definition, in the registry beside the rest of the vocabulary.
 */
export function ciRecords(records) {
	return (records ?? []).filter((r) => isCiDemandRecord(r));
}

/**
 * Parse a `demand-ledger.jsonl` file's text into records.
 *
 * A malformed line THROWS rather than being skipped — CLAUDE.md's "I could not
 * look must never render as nothing is wrong": a ledger this cannot fully read
 * must not silently under-count demand and pass a gate that exists to catch
 * exactly that.
 *
 * AND IT SAYS WHICH LINE OF WHICH FILE. CLAUDE.md's other half — "say WHY, and
 * a reason that is discarded makes the finding unactionable" — applies to a
 * reason that is merely WRONG just as hard. Every line is parsed on its own, so
 * `JSON.parse`'s own position is relative to THAT line and always reads
 * `line 1`: a broken row two lines into the file surfaced as
 * `Expected property name or '}' in JSON at position 1 (line 1 column 2)`,
 * measured on the live ledger's shape (node 24.18.0). An operator handed that
 * goes looking at the top of a 222-line file for a row that is not there. The
 * file-and-line wrapper is the same one `demand-derive.mjs`'s
 * `mergeDemandLedger` already carries for the WRITE path; this is the read
 * half of it, and neither may be loosened to a skip.
 *
 * @param text  the file's contents.
 * @param path  where it came from, for the message. Defaults to the bare
 *              filename so a caller that parses a string still names the shape.
 */
export function parseDemandLedger(text, path = 'demand-ledger.jsonl') {
	const out = [];
	const lines = (text ?? '').split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch (err) {
			throw new Error(
				`${path} line ${i + 1} is not JSON (${err.message}) — the position above is ` +
					`relative to that LINE, not to the file`
			);
		}
	}
	return out;
}

/**
 * Every capability id in `required` that NO managed node's bootcamp finding
 * proves — the gap `check-label-floor` fails the fleet on.
 *
 * An id proves iff it is a REGISTERED capability (`capabilityIds`) AND at
 * least one node's `$capabilities.prereqs` (written by `fleet bootcamp
 * --write`, `docs/planning/supply-ledger-2026-09-07.md`) lists it — i.e.
 * bootcamp actually executed the probe and it passed. An id the demand ledger
 * asks for but the registry does not even know (`docker`, at zero demand as
 * of 2026-09-07) can never be proven by construction and is always reported —
 * that is the drift `capability-schema`'s `unknown-capability` rule catches
 * for a DECLARED label, mirrored here for a DEMANDED one.
 */
export function unprovenRequired(required, machines, capabilityIds) {
	const proven = new Set();
	for (const m of Object.values(machines ?? {})) {
		// A GUEST PROVES NOTHING HERE, and that is not a slight on the box.
		// `required` is what the fleet's CI demand asks of general CAPACITY, and a
		// guest is not general capacity — hokon lends a backstop registration and
		// is out of scope for bootcamp's required set (operator, 2026-09-14).
		// Counting it would let the production host be the ONLY proof of a
		// capability the claws are supposed to carry: every claw could lose
		// `python-toolcache` and this would stay green because hokon still had it,
		// while every job needing it landed on a claw that did not. The fleet would
		// read as covered by the one machine that never takes the work.
		if (isGuestNode(m)) continue;
		for (const p of m.$capabilities?.prereqs ?? []) proven.add(p.id);
	}
	return [...required].filter((id) => !capabilityIds.has(id) || !proven.has(id)).sort();
}

/**
 * Why an EMPTY required set is a failure, or `null` when the set has content.
 *
 * A ledger that parses fine and yields zero required capabilities looks exactly
 * like a fleet with nothing to prove, and `unprovenRequired` returns `[]` for
 * it — a clean report about a bar of zero. Every node clears a bar of zero.
 *
 * It is never the real answer here: the required set is derived from live
 * workflows, and the covered repos demand `ffmpeg`, `python-venv`,
 * `python-toolcache`, `playwright` and `gh` between them. Zero means the ledger
 * was written against nothing — a truncated scan, a run with no repos in reach,
 * a writer that emitted its resident rows and died before the CI ones. CLAUDE.md:
 * "zero repos scanned — each of these FAILS. Exit 0 with no evidence is a
 * failure, not a pass."
 *
 * Returns a REASON rather than a boolean, so the gate that prints it can say
 * which file was empty and how many rows it did hold — a truncated ledger and an
 * all-resident one are two different jobs.
 */
export function emptyRequiredSetReason(required, { path, records } = {}) {
	if (required && required.size) return null;
	const rows = Array.isArray(records) ? records.length : null;
	const ci = Array.isArray(records) ? ciRecords(records).length : null;
	return (
		`the demand ledger${path ? ` at ${path}` : ''} parsed cleanly and yielded an EMPTY ` +
		`required set${rows === null ? '' : ` (${rows} row(s), ${ci} of them CI demand)`}. ` +
		'That is not "nothing to prove": the covered repos demand ffmpeg, python-venv, ' +
		'python-toolcache, playwright and gh between them, so an empty set means the ledger was ' +
		'written against nothing. Every node clears a bar of zero, which is why this fails ' +
		'instead of passing. Regenerate it with `fleet tool-inventory --write`.'
	);
}

/**
 * Load and parse the demand ledger at `path`. Returns `null` when the file
 * does not exist yet (nobody has run `fleet tool-inventory --write`) — a
 * DIFFERENT case from a file that exists and fails to parse, which throws.
 * The caller treats `null` as "could not look", never as "nothing is wrong".
 */
export function loadDemandLedger(path) {
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch (err) {
		if (err && err.code === 'ENOENT') return null;
		throw err;
	}
	return parseDemandLedger(text, path);
}

/**
 * Is this `$capabilities` record the same FINDING as the one already recorded?
 *
 * WHY A COMPARISON EXISTS AT ALL (issue #59). `bootcamp --write` stamps
 * `$capabilities.at` with `new Date().toISOString()` and writes the record for
 * every node it reached — "a snapshot of what the probe found, not a diff", and
 * that is still the right shape for the RECORD. It was the wrong shape for the
 * WRITE: the stamp changes on every pass, so the file changed on every pass,
 * so every run manufactured a commit on hadoku_site, and `redeploy-mgmt-api.yml`
 * has a path filter on that file. One idempotent bootcamp run therefore
 * restarted the production API. Observed on claw-9, 2026-09-23: two commits
 * eleven minutes apart (`538c9d00`, `3faeb8fe`), one line each, and the line was
 * `at`.
 *
 * SO `at` IS EXCLUDED, AND IT IS THE ONLY THING EXCLUDED. It answers "when did
 * this finding last CHANGE", which is the question a reader of a recorded
 * measurement actually has; "when did we last look" is the run's own business
 * and belongs in its output, not in a commit.
 *
 * `by` IS COMPARED, deliberately, even though it is a constant today. It is
 * provenance — which writer produced this record — and a record that changed
 * hands is a substantive change to what the manifest is asserting. It being
 * constant is exactly why comparing it costs nothing.
 *
 * ARRAYS ARE ORDER-SENSITIVE ON PURPOSE. `earned` is already sorted and
 * `prereqs`/`unearned`/`blocked` follow the registry's declaration order, so a
 * reordering here means the registry or the probe changed — which is a fact
 * worth a commit, not noise to smooth over. Sorting them would hide it.
 *
 * A MISSING record is never "the same": a node that has never been bootcamped
 * must get its first one.
 */
export function sameCapabilityRecord(prev, next) {
	if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return false;
	return canonical(prev) === canonical(next);
}

/**
 * Stable JSON for a `$capabilities` record, minus `at`.
 *
 * Object keys are SORTED, because key order is a property of how the record was
 * serialised and not of what it says — a record read back from a manifest a
 * human or a prettier pass reordered must still compare equal to the same
 * finding produced fresh.
 */
function canonical(record) {
	return JSON.stringify(record, (key, value) => {
		if (key === 'at') return undefined;
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
		}
		return value;
	});
}
