/**
 * runner-identity-gatedoc — turns `reconcile-runner-identity.mjs`'s sweep
 * result arrays into the GateDoc `findings`/`unreadable` lists and the one
 * `FAILS` boolean the exit code and `--json` share.
 *
 * Moved out of `reconcile-runner-identity.mjs` (wave shrink-1 lane D), body
 * unchanged.
 *
 * GateDoc (wave 5j lane B). Built once, from the arrays the sweep already
 * produced — every one of them is the FULL result of a decision the sweep
 * already made, so there is no second pass of logic to keep in sync, in
 * contrast to a gate that exits on the first bad thing it sees
 * (`label-floor`, `boundary-contracts`) and has no single point where every
 * array is final.
 *
 * `unreadable` IS "I could not look": a repo listing or a node probe that
 * never came back, a drain record this run could not parse, and — within
 * `warmOrphans` — the one case where the SECOND look itself failed rather
 * than resolving (`warmOrphanUnreadable`, `lib/warm-orphan-doc.mjs`). `young`,
 * `jitOrphans` (the ones not yet past `UNREAPED_AFTER_MS`), `warmRechecked`,
 * `expectedDown` and `expectedDark` are deliberately in NEITHER array — each
 * is this gate choosing NOT to judge something yet (too young, routine
 * leakage, resolved on a second look, or drained on purpose), the same shape
 * warm-canary's own `drained`/`skippedByRole` and label-floor's
 * `noWorkflows` precedent (that one, unlike this, counts as unreadable — see
 * that file) stay out of its GateDoc too. Everything else is a conclusion
 * reached from data this run actually read.
 */

import { warmOrphanUnreadable } from './warm-orphan-doc.mjs';

/**
 * @param {{ghosts: object[], unreaped: object[], warmOrphans: object[],
 *   noInstall: object[], unconfigured: object[], clobbered: object[],
 *   drainUnreadable: string|null, unexpectedlyDark: object[],
 *   unreadableRepos: object[], runnerUnitsFindings?: object[],
 *   runnerUnitsUnreachable?: object[], runnerUnitsLookupFailed?: object[],
 *   runnerUnitsRosterUnresolved?: object[]}} args
 *
 * The `runnerUnits*` arrays are ADDITIVE (wave gates2 lane F1a, item 4: MERGE
 * ci:runner-units -> check:runner-identity) — the SAME registration-vs-box
 * audit `scripts/runner-units.mjs` runs standalone, folded in here so `fleet
 * identity` reports it too. Every one of them defaults to `[]`, so a caller
 * (a future test, or this file's own fixtures) that has not been updated to
 * pass them keeps behaving exactly as before.
 */
export function buildIdentityGateDoc({
	ghosts,
	unreaped,
	warmOrphans,
	noInstall,
	unconfigured,
	clobbered,
	drainUnreadable,
	unexpectedlyDark,
	unreadableRepos,
	runnerUnitsFindings = [],
	runnerUnitsUnreachable = [],
	runnerUnitsLookupFailed = [],
	runnerUnitsRosterUnresolved = [],
}) {
	const gateFindings = [
		...ghosts.map((g) => ({
			node: null,
			kind: 'black-hole',
			reason: `${g.repo} ${g.name}${g.busy ? ' — BUSY, a job is stuck on it' : ''}: GitHub says online, no listener anywhere`,
		})),
		...unreaped.map((u) => ({
			node: null,
			kind: 'unreaped-black-hole',
			reason:
				`${u.repo} ${u.name}: ONLINE JIT orphan past the dispatcher's reap grace, age ` +
				`${u.ageMs === Infinity ? 'unknown (no epoch in name)' : `${Math.round(u.ageMs / 1000)}s`}`,
		})),
		...warmOrphans
			.filter((w) => !warmOrphanUnreadable(w.why))
			.map((w) => ({
				node: w.node ?? null,
				kind: 'warm-orphan',
				reason: `${w.repo} ${w.name} status=${w.status ?? 'unknown'}: ${w.why}`,
			})),
		...noInstall.map((d) => ({
			node: null,
			kind: 'registered-no-install',
			reason:
				`${d.repo} runner "${d.name}" status=${d.status}` +
				(d.carriers.length ? ` (that name lives on: ${d.carriers.join(', ')})` : ''),
		})),
		...unconfigured.map((u) => ({
			node: u.machine,
			kind: 'unconfigured-listener',
			reason: `${u.machine} ${u.dir}: running with no readable .runner`,
		})),
		...clobbered.map((c) => ({
			node: c.machine,
			kind: 'stolen-identity',
			reason: `${c.machine} ${c.dir} now claims "${c.name}" (${c.repo})`,
		})),
		// runner-units: an install or unit naming a renamed, archived, or
		// off-roster repo, or a stray/sick unit — `f.kind` is already one of
		// RENAMED/GONE/ARCHIVED/OFF-ROSTER/STRAY/SICK (runner-unit-audit.mjs).
		...runnerUnitsFindings.map((f) => ({
			node: f.node,
			kind: `runner-units-${f.kind.toLowerCase()}`,
			reason: `${f.dir ?? f.unit}: ${f.why}`,
		})),
	];
	const gateUnreadable = [
		...(drainUnreadable
			? [{ node: null, why: `drain record unreadable: ${drainUnreadable}` }]
			: []),
		...warmOrphans
			.filter((w) => warmOrphanUnreadable(w.why))
			.map((w) => ({ node: w.node ?? null, why: `${w.repo} ${w.name}: ${w.why}` })),
		...unexpectedlyDark.map((u) => ({ node: u.machine, why: u.error })),
		...unreadableRepos.map((r) => ({ node: null, why: `${r.repo}: ${r.reason}`, repo: r.repo })),
		// runner-units' own "I could not look" paths: a node this sweep could
		// not probe (and that was not already counted as expected-down or
		// known-down above), a repo lookup that failed every attempt, and a
		// roster entry GitHub could not resolve.
		...runnerUnitsUnreachable.map((u) => ({ node: u.node, why: u.why })),
		...runnerUnitsLookupFailed.map((l) => ({
			node: l.node,
			why: `${l.dir} (${l.repo}): ${l.why}`,
		})),
		...runnerUnitsRosterUnresolved.map((r) => ({ node: null, why: `${r.repo}: ${r.why}` })),
	];
	// The SAME booleans the exit code also keys on — computed once, so the
	// GateDoc's `ok` and the real exit code can never read differently from
	// each other, which `buildGateDoc`'s own array-emptiness default would not
	// guarantee if a future term were added to one list and not the other.
	const FAILS = Boolean(
		ghosts.length ||
		unreaped.length ||
		warmOrphans.length ||
		noInstall.length ||
		unconfigured.length ||
		clobbered.length ||
		drainUnreadable ||
		unexpectedlyDark.length ||
		unreadableRepos.length ||
		runnerUnitsFindings.length ||
		runnerUnitsUnreachable.length ||
		runnerUnitsLookupFailed.length ||
		runnerUnitsRosterUnresolved.length
	);
	return { gateFindings, gateUnreadable, FAILS };
}
