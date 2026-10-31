import { statSync } from 'node:fs';

import { historyFile, jobRecords } from '../job-history-store.js';
import { logger } from '../host.js';
import { buildSpeedModel, type SpeedModel } from './speed-tier.js';
import { buildHeavyModel, type HeavyModel } from './traffic.js';

/**
 * How often the speed model (#83, `speed-tier.ts`) rebuilds from job history.
 *
 * NOT every 15s dispatch tick — `buildSpeedModel` is pure and cheap, but the
 * tier it computes changes on the scale of days of job history, not seconds,
 * and rebuilding on every tick would mean every log line below fires 240
 * times an hour for a number that essentially never moves between them.
 * 10 minutes matches `runner-health`'s own `TICK_INTERVAL_MS` — there is no
 * sharper requirement than "once in a while", so this reuses the cadence the
 * fleet already has one of rather than inventing a second.
 */
export const SPEED_MODEL_REBUILD_INTERVAL_MS = 10 * 60 * 1000;

let cachedSpeedModel: SpeedModel | null = null;
let speedModelBuiltMs = -1;

/** Test seam. Not part of the supported API. */
export function __resetSpeedModelForTesting(): void {
	cachedSpeedModel = null;
	speedModelBuiltMs = -1;
}

/**
 * The fleet's speed model, rebuilt from the SAME job history `jobRecords()`
 * already loads for this file's other reader (`idleSecondsByNode` above) —
 * no second parser of `~/.hadoku-mgmt/job-history.jsonl`, per the manager's
 * note on this lane.
 *
 * A MISSING OR EMPTY HISTORY MUST NEVER DISABLE SPILL AND MUST NEVER MAKE
 * EVERYTHING SLOW (§A.5). `buildSpeedModel([])` already answers both: with no
 * records, `tierOf` returns `'unknown'` for every node (never `'slow'` by
 * construction — see `speed-tier.ts`'s own tier rule), and `'unknown'` places
 * exactly like `'normal'` in `placement.ts`'s spill gate. So the EMPTY case
 * this function falls back to on an unreadable or not-yet-written history is
 * automatically the safe one; what this function adds on top is SAYING SO,
 * because a silently empty model and a silently thin-but-real one look
 * identical to a caller with no log line to tell them apart.
 *
 * `nodeNames` is the DECLARED node list — every manifest machine, not only
 * `input.ephemeral` — passed to `buildSpeedModel` as `opts.nodes` so it can
 * attribute a runner name to a node from the fleet's own roster rather than a
 * hardcoded naming convention. Without it the model attributes nothing and
 * every node reads 'unknown' — safe (spill never engages) but silently inert
 * — which is why an empty list here is its own warning below, not just a
 * quiet no-op.
 */
export function getSpeedModel(nowMs: number, nodeNames: readonly string[]): SpeedModel {
	if (cachedSpeedModel && nowMs - speedModelBuiltMs < SPEED_MODEL_REBUILD_INTERVAL_MS) {
		return cachedSpeedModel;
	}
	speedModelBuiltMs = nowMs;
	const records = jobRecords();
	if (records.length === 0) {
		// `jobRecords()` never throws and never reports WHY it is empty — that is
		// `job-history.ts`'s own concern and this file does not re-read its
		// JSONL to second-guess it (the manager's "no second reader" note). A
		// `statSync` of the path is not a second READER of the DATA — nothing
		// here parses a line of it — it only tells the log whether the file is
		// missing (a fleet with no jobs recorded yet, or a fresh process before
		// `loadHistory` ever ran) or present-but-yielding-nothing (every line
		// failed to parse, or aged out of the window), which are different
		// findings an operator would act on differently.
		let why: string;
		try {
			statSync(historyFile());
			why = 'the file exists but yielded zero usable records';
		} catch (err) {
			why =
				(err as NodeJS.ErrnoException)?.code === 'ENOENT'
					? 'no job history file yet (no jobs recorded this process)'
					: `could not stat it: ${err instanceof Error ? err.message : String(err)}`;
		}
		logger.warn(
			`[speed-tier] job history unreadable or empty — ${why}; the model holds nothing ` +
				`(every node reads 'unknown', which places exactly like 'normal' — spill stays off, ` +
				`nothing is held back)`
		);
	}
	// THE DECLARED NODE LIST MUST BE NON-EMPTY, or `buildSpeedModel` has no
	// roster to attribute a runner name against and silently returns a model
	// that is 'unknown' everywhere — safe (spill never engages) but inert, and
	// indistinguishable from a genuinely thin history unless this says so. An
	// empty list here means the caller passed `Object.keys(input.nodes)` on a
	// tick with no manifest machines at all, which `withoutGuests`/the reaching
	// code above should already have ruled out — this is the "say why, don't
	// let it render as nothing wrong" assertion for that assumption.
	if (nodeNames.length === 0) {
		logger.warn(
			'[speed-tier] rebuilding with an EMPTY declared node list — the model will attribute ' +
				"nothing and every node reads 'unknown' (spill stays off; this is a caller bug, not a " +
				'history problem)'
		);
	}
	const model = buildSpeedModel(records, { nowMs, nodes: nodeNames });
	// ONE LINE PER REBUILD naming every slow-tier node and its p25 (§A.5), AND
	// (wave 3z, #83's continuous sibling) every node's placement speed factor —
	// not per node per tick, which at a 10-minute cadence is already infrequent
	// enough that per-node lines would not flood anything, but one line keeps
	// this grep-able the same way `[dispatch]`'s summary line already is.
	const slow: string[] = [];
	const factors: string[] = [];
	for (const name of nodeNames) {
		const d = model.describe(name);
		if (d.tier === 'slow') slow.push(`${name} (p25 ${d.p25 ?? 'null'}, ${d.kinds} kind(s))`);
		// Rounded to 2 decimals — LOGGING ONLY, never the number `orderCandidates`
		// actually sorts on (that reads `speedFactor` straight off the model,
		// full precision, in `trafficNodes` below). Full float noise (e.g.
		// 0.5981372549019608) makes the live rebuild line hard to read for no
		// placement benefit.
		const f = model.factorOf?.(name);
		factors.push(`${name}=${f === null || f === undefined ? 'null' : f.toFixed(2)}`);
	}
	logger.info(
		(slow.length
			? `[speed-tier] rebuilt from ${records.length} record(s) across ${nodeNames.length} node(s): slow tier = ${slow.join(', ')}`
			: `[speed-tier] rebuilt from ${records.length} record(s) across ${nodeNames.length} node(s): no node is in the slow tier`) +
			`; factors: ${factors.join(', ')}`
	);
	cachedSpeedModel = model;
	return model;
}

let cachedHeavyModel: HeavyModel | null = null;
let heavyModelBuiltMs = -1;

/** Test seam. Not part of the supported API. */
export function __resetHeavyModelForTesting(): void {
	cachedHeavyModel = null;
	heavyModelBuiltMs = -1;
}

/**
 * The fleet's heavy-kind model (#102), rebuilt from the SAME job history
 * `jobRecords()` already loads for `getSpeedModel`'s reader just above — no
 * second parser of `~/.hadoku-mgmt/job-history.jsonl`.
 *
 * CACHED ON THE SAME CADENCE AS THE SPEED MODEL (`SPEED_MODEL_REBUILD_INTERVAL_MS`):
 * which (repo, job) kinds run long changes on the scale of days of job
 * history, not seconds, and rebuilding every 15s dispatch tick would cost a
 * fresh pass over the whole window for a number that essentially never moves
 * between them.
 *
 * A MISSING OR EMPTY HISTORY MUST NEVER MAKE A JOB READ AS HEAVY. `buildHeavyModel([])`
 * already answers that: with no records, `isHeavy`/`isHeavyRepo` return `false`
 * for everything, which is the safe default documented on `HeavyModel` itself.
 */
export function getHeavyModel(nowMs: number): HeavyModel {
	if (cachedHeavyModel && nowMs - heavyModelBuiltMs < SPEED_MODEL_REBUILD_INTERVAL_MS) {
		return cachedHeavyModel;
	}
	heavyModelBuiltMs = nowMs;
	const records = jobRecords();
	const model = buildHeavyModel(records);
	cachedHeavyModel = model;
	return model;
}
