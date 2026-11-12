/**
 * HEAVY UNITS ON DISK — which JIT units the dispatcher minted for a heavy job
 * (#102), so the heavy hold can count them for as long as they run.
 *
 * The pass counts a node's heavy jobs from two places: the job listings of
 * runs that still have something queued, and a live unit whose own job is
 * still queued. A shard whose run has nothing left queued is in neither, so
 * once a Forge set was fully placed its shards stopped counting. Measured over
 * dispatch decisions 11-05..11-12 against job history: of 413 heavy placements
 * on claw-9, 273 saw fewer heavy jobs than were running, 117 of them read 0
 * while 2 or 3 ran; of the 281 shards hidden behind a placement that read 0,
 * 269 belonged to a run with nothing queued. claw-9 then ran 3 and 4 Forge
 * shards at once on a hold that says 1 or 2.
 *
 * The unit name is the record that survives an mgmt-api restart (it carries
 * the job id), but the job's NAME, which decides heavy, is gone from every
 * listing once the run is fully placed. So the pass writes it here when it
 * mints, and reads it for a live unit nothing else explains. A runner GitHub
 * gave to a lighter job is counted heavy until a listing shows its real job:
 * the hold errs towards holding.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { logger, stateDir } from '../host.js';
import { writeJsonAtomic } from '../lib/atomic-json.js';

export const HEAVY_UNITS_FILE = 'heavy-units.json';

/**
 * An entry older than this is dropped at the next write. Only a LIVE unit is
 * ever looked up, so this bounds the file, not the count: 6 h is past the
 * longest Forge shard in job history (~5,400 s) and the JIT unit's own TTL.
 */
export const HEAVY_UNIT_TTL_MS = 6 * 3600_000;

/** runner name -> epoch ms it was minted. Loaded once from disk per process. */
let units: Map<string, number> | null = null;

function load(dir: string): Map<string, number> {
	if (units) return units;
	units = new Map();
	const path = join(dir, HEAVY_UNITS_FILE);
	if (!existsSync(path)) return units;
	try {
		const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
		if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not an object');
		for (const [name, at] of Object.entries(doc))
			if (Number.isFinite(at)) units.set(name, at as number);
	} catch (e) {
		logger.warn(
			`[heavy-units] ${path} unreadable (${(e as Error).message}): heavy units minted before ` +
				'this start are not counted by the heavy hold until they end'
		);
	}
	return units;
}

/** Record units just minted for heavy jobs, dropping entries past the TTL. */
export function recordHeavyUnits(names: readonly string[], nowMs: number, dir = stateDir()): void {
	if (!names.length) return;
	const m = load(dir);
	for (const [name, at] of m) if (nowMs - at > HEAVY_UNIT_TTL_MS) m.delete(name);
	for (const name of names) m.set(name, nowMs);
	writeJsonAtomic(join(dir, HEAVY_UNITS_FILE), Object.fromEntries(m), { fsync: false });
}

/** Was this unit minted for a heavy job? */
export function isHeavyUnit(name: string, dir = stateDir()): boolean {
	return load(dir).has(name);
}

/** `keepFile` simulates a restart: the in-process copy is gone, the file is not. */
export function __resetHeavyUnitsForTesting(dir = stateDir(), keepFile = false): void {
	units = null;
	if (!keepFile) rmSync(join(dir, HEAVY_UNITS_FILE), { force: true });
}
