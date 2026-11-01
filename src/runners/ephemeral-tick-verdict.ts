/**
 * The ephemeral tick's generic admission verdict — wave 5r lane D split of
 * `ephemeral-tick.ts` (pure move), so that file falls under the 800-line
 * source ceiling.
 *
 * `onDemandBackstops` (which nodes the dispatcher mints backstops for),
 * `AdmissionClause`/`AdmissionVerdict` (how one node's GENERIC admission
 * check this tick is classified and reported) and `admissionVerdictFor`
 * (the function that reaches that verdict from a `NodeState`) are stateless
 * — the MAP that remembers the last published verdict per node, and the
 * `__reset*`/`__set*`/`*ForReport` accessors that own it, stay in
 * `ephemeral-tick.ts` beside `dispatchEphemeral`, which is the only thing
 * that WRITES it (lane rule: module state moves with the functions that
 * own it). `recentJobsPerDay` travels here too — same shape (stateless,
 * self-contained, called once per tick) even though it answers a different
 * question.
 *
 * Every name here is re-exported from `ephemeral-tick.ts` so its existing
 * importers compile unchanged.
 */

import { mintsOnDemand } from '../lib/node-role.js';
import { jobRecords } from '../job-history-store.js';
import { admitMint, spaceRefusal, TMP_FREE_FLOOR_MB } from './ephemeral.js';
import { type EphemeralTickInput, type ReserveSource } from './ephemeral-shared.js';
import { type NodeState } from './placement.js';

/**
 * The backstops the dispatcher mints for on demand (#120), in manifest order.
 *
 * Operator, 2026-10-19: "the runners get brought online the same way the JIT
 * process does. not having standing runners squatting on ram." Until then the
 * backstop kept ~30 standing listeners alive around the clock (~2.8 GB RSS+swap on
 * the production host) and the backstop's promotion was a label flip on them.
 * Now promotion is a mint, and demotion leaves nothing listening.
 *
 * A DRAINED backstop is still returned: the drain reaches placement as
 * `NodeState.drained` like every other node's, which is what keeps it from
 * taking anything — the drain is the backstop's red light, and it has to read the
 * same way here as it does on a claw.
 */
export function onDemandBackstops(input: EphemeralTickInput): string[] {
	return Object.keys(input.nodes).filter((n) => mintsOnDemand(input.nodes[n]));
}

/**
 * Which `admitMint` clause refused a node's GENERIC admission check this tick
 * — see {@link AdmissionVerdict}. `admitMint` has returned exactly three
 * refusal shapes since it was written (`ephemeral.ts`): drained, at-capacity,
 * and memory (the plain clause and the #76 lower-bound PLACEMENT clause,
 * folded together here as 'memory' — both are refused for want of room, and
 * the generic check below never sets `requiredIsLowerBound`, so the
 * placement wording can never actually reach this classifier; it is handled
 * anyway so a future caller that DOES set it is not silently misread).
 *
 * `'other'` is defensive. A reason this file does not recognise must not
 * silently satisfy `clause === 'memory'` and feed the starvation finding
 * (`runner-health.ts`) something `admitMint` was never asked to mean.
 *
 * `'space'` (#101): refused for want of `/tmp` or `~/.hadoku/jit` free space,
 * never folded into `'memory'` — a dataplatform pytest run plus a site build
 * can fill a tmpfs while plenty of RAM remains free, and the finding needs to
 * say which resource actually ran out.
 */
export type AdmissionClause = 'drained' | 'concurrency' | 'memory' | 'space' | 'other';

function classifyAdmissionClause(reason: string): AdmissionClause {
	if (reason.startsWith('drained:')) return 'drained';
	if (reason.startsWith('at capacity:')) return 'concurrency';
	if (reason.startsWith('memory:') || reason.startsWith('placement:')) return 'memory';
	if (reason.startsWith('space:')) return 'space';
	return 'other';
}

/**
 * The verdict `admitMint` reaches for one EPHEMERAL node's GENERIC admission
 * check this tick — DISPLAY, never a second decision (wave 4a §A.1, #100).
 *
 * `placement.ts`'s `refusalFor` calls `admitMint` again, per queued run, with
 * the run's own repo's reserve substituted in when #76's lower bound applies
 * — THAT call is the one which actually gates a mint. This verdict is
 * computed from the SAME `NodeState` `dispatchEphemeral` already builds for
 * placement, before any run is known, so it answers "could this node take A
 * job right now" rather than "could it take THIS one" — close enough to
 * drive a finding and a panel field, wrong to feed back into scheduling.
 * Nothing here changes what `admitMint` admits, the reserves, or the order.
 *
 * WHY THIS EXISTS: claw-6 and claw-2 were refused by the memory clause on
 * every tick for days (2026-09-30 / 2026-10-04) and nothing recorded it —
 * `admitMint`'s own refusal reached nowhere past a per-run log line, and
 * `admissionFree` (fleet-report-types.ts) counts SLOTS and never applies this
 * clause. This is that answer, held where a reader can reach it without
 * re-deriving `admitMint`'s own logic.
 */
export type AdmissionVerdict =
	| { ok: true }
	| {
			ok: false;
			clause: AdmissionClause;
			/** This node's free memory, measured this tick (`NodeState.freeMb`) —
			 *  or, when `clause === 'space'`, the free MB on the filesystem named
			 *  by {@link filesystem} instead. */
			availableMb: number;
			/** What this generic check reserved against it (`NodeState.requiredMb`)
			 *  — or, when `clause === 'space'`, the floor that filesystem failed to
			 *  clear ({@link TMP_FREE_FLOOR_MB} or {@link WORK_FREE_FLOOR_MB}). */
			needMb: number;
			/** Only set when `clause === 'space'`: which filesystem refused —
			 *  `'tmp'` for `/tmp`, `'work'` for the filesystem holding
			 *  `~/.hadoku/jit`. Absent for every other clause. */
			filesystem?: 'tmp' | 'work';
			/** Only set (`true`) when `clause === 'space'` AND the free space on
			 *  {@link filesystem} could not be read (`spaceRefusal`'s `freeMb:
			 *  null`) — `availableMb` is then `0` and is NOT a measurement, only a
			 *  placeholder so the field stays a `number`. A reader that prints
			 *  "…MB free" must check this first. Absent for every other case,
			 *  including a measured below-floor space refusal. */
			unreadable?: true;
			/** Which of `jobReserve`'s three answers produced `needMb`. Meaningless
			 *  for `clause === 'space'` (carried anyway — it is cheap and callers
			 *  already read it unconditionally). */
			reserveBasis: ReserveSource;
			/** `admitMint`'s own reason string, verbatim — the detail a clause alone
			 *  cannot carry (e.g. the exact capacity count, or the exact MB gap). */
			reason: string;
	  };

/** `admitMint(ns)`, folded into the shape callers actually want to read. */
export function admissionVerdictFor(ns: NodeState, reserveBasis: ReserveSource): AdmissionVerdict {
	const admit = admitMint(ns);
	if (admit.ok) return { ok: true };
	const reason = admit.reason ?? 'refused';
	const clause = classifyAdmissionClause(reason);
	if (clause === 'space') {
		// Single source of truth with `admitMint` itself — ask `spaceRefusal`
		// the SAME question rather than re-deriving `filesystem` from a string
		// match on `reason`.
		const space = spaceRefusal(ns);
		return {
			ok: false,
			clause,
			availableMb: space?.freeMb ?? 0,
			needMb: space?.floorMb ?? TMP_FREE_FLOOR_MB,
			filesystem: space?.filesystem ?? 'tmp',
			...(space?.freeMb === null ? { unreadable: true as const } : {}),
			reserveBasis,
			reason,
		};
	}
	return {
		ok: false,
		clause,
		availableMb: ns.freeMb,
		needMb: ns.requiredMb,
		reserveBasis,
		reason,
	};
}

/**
 * Jobs per day per repo, from the persisted history.
 *
 * Feeds the hot/cold poll split. This was a literal empty map for the pilot's
 * whole first day, which made EVERY repo cold: a 10-minute poll interval instead
 * of 60 s, so a starved job waited up to eleven minutes for a runner that could
 * have been minted in two. `deriveHotRepos` exists precisely to stop a
 * hand-maintained list going stale, and it was wired to nothing.
 */
export function recentJobsPerDay(): Map<string, number> {
	const out = new Map<string, number>();
	try {
		const records = jobRecords();
		if (!records.length) return out;
		let oldest = Infinity;
		for (const r of records) {
			const t = Date.parse(r.startedAt);
			if (Number.isFinite(t)) oldest = Math.min(oldest, t);
		}
		const days = Math.max(1, (Date.now() - oldest) / 86_400_000);
		const counts = new Map<string, number>();
		for (const r of records) counts.set(r.repo, (counts.get(r.repo) ?? 0) + 1);
		for (const [repo, n] of counts) out.set(repo, n / days);
	} catch {
		// A missing or unreadable history means every repo polls cold — slower,
		// never wrong. It must not take the dispatch pass down with it.
	}
	return out;
}
