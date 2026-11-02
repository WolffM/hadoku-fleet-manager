/**
 * Shared CLI plumbing for the three commands that read the T2 rollup store
 * directly off argv: `job-rollups.mjs`, `failures.mjs` and `stats.mjs`. All
 * three carried byte-identical copies of `rawFlag`, the `--days` validation,
 * the "name every gap, never skip it" missing-day loop, and (for
 * failures.mjs/stats.mjs) the store-open-and-check-empty sequence.
 *
 * Each caller reports a failure its own way — `job-rollups.mjs`/
 * `failures.mjs` call their own process-exiting `fail(msg)`, `stats.mjs`
 * returns `{ok:false, why}` per section and keeps going — so nothing here
 * reports anything itself; each function returns a result and leaves
 * rendering it to the caller.
 */
import { ROLLUP_FILE, jsonlRollupStore } from '../../dist/job-rollup-store.js';
import { SETTLE_HOURS, utcDay } from '../../dist/job-rollups.js';

export { ROLLUP_FILE };

export const DAY_MS = 86_400_000;

/**
 * `null` when the flag was never given; `''` when given with nothing after
 * it (e.g. `fleet job-rollups --days`, trailing). `parsed.value` reads both
 * of those as `null` — right for a flag that treats "absent" and "given
 * blank" the same, wrong here: a flag with no value must fail loudly rather
 * than quietly default.
 * @param {string[]} argv
 * @param {{value(name: string): string | null}} parsed
 * @param {string} name
 */
export function rawFlag(argv, parsed, name) {
	const present = argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`));
	if (!present) return null;
	return parsed.value(name) ?? '';
}

/**
 * Parses and validates the `--days` flag all three commands share.
 * @param {string | null} daysRaw
 * @param {number} [fallback]
 * @returns {{days: number, error: null} | {days: null, error: string}}
 */
export function parseDaysArg(daysRaw, fallback = 14) {
	const days = daysRaw === null ? fallback : Number(daysRaw);
	if (!Number.isInteger(days) || days < 1) {
		return { days: null, error: `--days must be a positive integer, got "${daysRaw}"` };
	}
	return { days, error: null };
}

/**
 * Every UTC day from `fromDay` up to the newest day that COULD be closed by
 * `now`, that `inRangeDays` does not already hold — named so a gap in the
 * rollup store never reads as a quiet day (AGENTS.md: "'I could not look'
 * must never render as 'nothing is wrong'").
 * @param {{day: string}[]} inRangeDays
 * @param {{fromDay: string, now: number}} window
 * @returns {string[]}
 */
export function missingDaysSince(inRangeDays, { fromDay, now }) {
	const lastClosable = utcDay(now - SETTLE_HOURS * 3600_000 - DAY_MS);
	const held = new Set(inRangeDays.map((d) => d.day));
	const missingDays = [];
	for (let ms = Date.parse(`${fromDay}T00:00:00Z`); utcDay(ms) <= lastClosable; ms += DAY_MS) {
		if (!held.has(utcDay(ms))) missingDays.push(utcDay(ms));
	}
	return missingDays;
}

/**
 * The process-exiting `fail(msg)` both `job-rollups.mjs` and `failures.mjs`
 * build from their own emitter — identical in both: `--json` emits
 * `{ok:false, error:msg}`, human mode prints `✗ msg`, either way exit 1.
 * `stats.mjs` does NOT use this: its sections return `{ok:false, why}`
 * instead of exiting, because one section failing must not take the other
 * four down with it (see its own header).
 * @param {{json: boolean, emit(doc: unknown): void}} out
 */
export function makeFail(out) {
	return function fail(msg) {
		if (out.json) out.emit({ ok: false, error: msg });
		else console.error(`✗ ${msg}`);
		process.exit(1);
	};
}

/**
 * `fromDay` and the rollup days actually inside the `--days` window — the
 * same two values job-rollups.mjs, failures.mjs and stats.mjs each derive
 * from a successful {@link readRollupStore} read, against a `now` the
 * caller already holds (passed in, never re-read here, so a caller with
 * other uses for `now` — stats.mjs's `generatedAt` — gets exactly one clock
 * read for the whole run).
 * @param {{days: {day: string}[]}} read
 * @param {{days: number, now: number}} opts
 */
export function rollupWindow(read, { days, now }) {
	const fromDay = utcDay(now - days * DAY_MS);
	const inRange = read.days.filter((d) => d.day >= fromDay);
	return { fromDay, inRange };
}

/**
 * Wraps any store's `.read()` call: `{ok:true, read}` on success, or
 * `{ok:false, why}` on a thrown read error. `stats.mjs` renders "could not
 * read `<file>`: ..." the same way for every one of its five independent
 * sections, whatever store each reads (T2 rollups, T4 capacity, T5 budget) —
 * only the read itself is generic here; whether the result then counts as
 * EMPTY is each section's own check, since the shape of "nothing yet" is
 * different per store.
 * @param {() => unknown} read
 * @param {string} file
 */
export function tryReadStore(read, file) {
	try {
		return { ok: true, read: read() };
	} catch (err) {
		return {
			ok: false,
			why: `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * Opens the T2 rollup store at `file`. Returns the read result on success, or
 * an error string for the caller to render its own way — "could not read"
 * (read threw) or "no rollups" (the store is absent, or — when `requireDays`
 * is set — present but holding zero days).
 *
 * `requireDays: false` is job-rollups.mjs's own case: an existing-but-empty
 * store is not a failure there, because the command still has a `fromDay` to
 * report "no rollups since" against. `failures.mjs` and `stats.mjs` both set
 * it true — neither has anything to compute over zero days.
 * @param {string} file
 * @param {{requireDays: boolean, contrastPhrase: string}} opts
 */
export function readRollupStore(file, { requireDays, contrastPhrase }) {
	let read;
	try {
		read = jsonlRollupStore(file).read();
	} catch (err) {
		return {
			read: null,
			error: `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const empty = !read.exists || (requireDays && !read.days.length);
	if (empty) {
		return {
			read: null,
			error:
				`no rollups at ${file} — the writer (mgmt-api's runner-health tick) has never ` +
				`written one into this state dir. That is "could not look", not ${contrastPhrase}.`,
		};
	}
	return { read, error: null };
}
