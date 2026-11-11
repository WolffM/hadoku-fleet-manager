/**
 * `fleet qualify`'s PLAYLIST — every qualification test, and the bars they
 * judge against (wave bootcamp2, operator-approved 2026-11-11).
 *
 * WHY THIS EXISTS. Bootcamp proves a tool is present and runs once, on an idle
 * node. It never ran two jobs at once, never held load past a minute, never
 * read a temperature, a disk latency or a DNS answer under load, and
 * `maxConcurrent` was a formula set at enrollment and then edited by hand five
 * times in ten days (claw-1 twice, claw-10, claw-4, claw-3). A 37-incident
 * retrospective (10-11..11-11) found 20 that a harsher pre-test would have
 * caught. Qualification is that pre-test: a drained window on ONE node,
 * harder than a normal day, whose results decide placement and the node's
 * ceiling. Plan: private `docs/planning/wave-bootcamp2-2026-11-11.md`.
 *
 * THE CONTRACT every test module meets (`validateTest` enforces it):
 *
 *   {
 *     id: 'concurrency-ramp',    // stable; the results ledger key is `node::id`
 *     track: 'qualify',          // 'presence' | 'qualify'
 *     needsDrain: true,
 *     runsAs: 'ci',              // 'ci' | 'admin' — the role every ctx.exec uses
 *     ttlDays: 21,
 *     minutes: 45,               // budget; the runner will not START a test that
 *                                // cannot finish inside the window
 *     async run(ctx) → { status: 'pass'|'fail'|'could-not-look', reason, metrics }
 *   }
 *
 * `could-not-look` is never a pass and never a fail (AGENTS.md: "I could not
 * look" must never render as "nothing is wrong"). Every result carries a
 * non-empty `reason`; the runner turns a result without one into
 * could-not-look rather than invent one.
 *
 * The playlist itself is `qualify-playlist.mjs`, not this file: every test
 * module imports the bars from here, so a registry that imported the tests
 * would be an import cycle that reads the bars before they exist.
 */

export { QUALIFY_BARS, QUALIFY_TTL_DAYS } from './qualify-bars.mjs';

/**
 * The longest a node may be held out of service for one qualification. The
 * runner refuses to start a test whose `minutes` would overrun it, and says so;
 * a window that ends early is a could-not-look for every test it did not reach.
 */
export const QUALIFY_WINDOW_MINUTES = 150;

const TRACKS = new Set(['presence', 'qualify']);
const ROLES = new Set(['ci', 'admin']);
export const STATUSES = new Set(['pass', 'fail', 'could-not-look']);

/**
 * The reasons a test module does not meet the contract; empty when it does.
 *
 * @param {unknown} t
 * @returns {string[]}
 */
export function validateTest(t) {
	if (!t || typeof t !== 'object') return ['not an object'];
	const o = /** @type {Record<string, unknown>} */ (t);
	const bad = [];
	if (typeof o.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(o.id))
		bad.push('id must be a kebab-case string');
	if (!TRACKS.has(/** @type {string} */ (o.track))) bad.push(`track must be one of ${[...TRACKS]}`);
	if (typeof o.needsDrain !== 'boolean') bad.push('needsDrain must be a boolean');
	if (!ROLES.has(/** @type {string} */ (o.runsAs))) bad.push(`runsAs must be one of ${[...ROLES]}`);
	for (const k of ['ttlDays', 'minutes'])
		if (!Number.isFinite(o[k]) || /** @type {number} */ (o[k]) <= 0)
			bad.push(`${k} must be a positive number`);
	if (typeof o.run !== 'function') bad.push('run must be a function');
	return bad;
}

/**
 * A test's result, or a could-not-look naming what was wrong with it. A result
 * is never repaired: a status outside the set or a missing reason is the
 * TEST's fault, and passing it through would let a broken test read as a pass.
 *
 * @param {unknown} r
 * @returns {{ status: string, reason: string, metrics: object }}
 */
export function normalizeResult(r) {
	const o = r && typeof r === 'object' ? /** @type {Record<string, unknown>} */ (r) : null;
	if (!o)
		return { status: 'could-not-look', reason: 'the test returned no result object', metrics: {} };
	if (!STATUSES.has(/** @type {string} */ (o.status)))
		return {
			status: 'could-not-look',
			reason: `the test returned status ${JSON.stringify(o.status)}, not one of ${[...STATUSES]}`,
			metrics: {},
		};
	if (typeof o.reason !== 'string' || !o.reason.trim())
		return {
			status: 'could-not-look',
			reason: `the test returned ${o.status} with no reason`,
			metrics: {},
		};
	return {
		status: /** @type {string} */ (o.status),
		reason: o.reason,
		metrics: o.metrics && typeof o.metrics === 'object' ? o.metrics : {},
	};
}
