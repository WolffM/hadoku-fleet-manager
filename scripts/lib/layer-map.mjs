/**
 * THE LAYER MAP — every non-test source file's place in the target shape
 * (refactor plan 2026-10-28 §3.1–§3.5), as DATA.
 *
 * THIS FILE IS THE MATCHER, NOT THE DATA (wave 5p lane A) — it decides
 * nothing by itself, same as before the split. The DATA — one
 * ordered `{ glob, layer, domain?, part?, why?, section? }` entry per
 * file/pattern, FIRST MATCH WINS — lives in `scripts/lib/layer-map.json`,
 * loaded once below with `readFileSync` + `JSON.parse` (relative to
 * `import.meta.url`, so it resolves regardless of CWD) and VALIDATED before
 * anything is exported. The data moved to JSON because this file sat at the
 * repo's 800-line file-size ceiling (`scripts/lib/file-size-guard.mjs`) with
 * nothing redundant left to cut, and most of its bulk was per-entry
 * rationale comments — which this package's other registries
 * (`layer-debt.json`, `f-guards/f3-one-writer.json`, `file-size-debt.json`)
 * already hold as JSON rather than as source. Each entry's `why` (a single
 * entry's own rationale) or `section` (a comment that introduced a GROUP of
 * entries, or a divider that carried real prose rather than just a layer
 * name) carries forward the comment that used to sit above or beside it in
 * this file — read `layer-map.json` for file-specific placement rationale.
 * A handful of divider comments that were PURELY VISUAL (a run of dashes
 * plus a bare layer/domain name, e.g. `// ---- domain: lifecycle`, with no
 * prose beyond the name itself) were dropped rather than carried into a
 * `section` field: the name they stated is already present, structurally,
 * on every entry's own `layer`/`domain` field, so nothing is lost by
 * dropping the banner text itself.
 *
 * `measure-layers.mjs` reads `matchLayer` (exported below) to walk the real
 * import graph and count violations for four candidate cuts;
 * `layer-guard.test.mjs` reads it (through `measure-layers.mjs`) to fail a
 * NEW violation; and `--table` regenerates plan §3.5 from it, so the doc
 * cannot drift from what the guard enforces — the same derive-don't-copy rule
 * `json-contract.mjs` already follows for cron jobs.
 *
 * SCOPE: `.ts` and `.mjs` files under `src/`, `scripts/`, and `scripts/lib/`
 * only, excluding tests (`*.test.ts`, `*.test.mjs`, everything under
 * `src/tests/`). `.sh`, `.py` and `.json` files have no ES import graph for
 * `measure-layers.mjs` to walk, so they are out of scope for this
 * measurement; "the map is total" is a claim about the file set
 * `measure-layers.mjs` actually enumerates (see `listSourceFiles()` there),
 * not about every file in these three directories. A `.sh`/`.py` onboarding
 * script is still real lifecycle-domain content — it is just not MEASURED
 * here, because there is no import statement to read.
 *
 * SEVEN LAYERS. Only the `domain` layer carries `domain` (lifecycle |
 * ci-scheduling | tenancy | observation) and `part` (core | run — core is a
 * pure decision, run is the I/O around it). The other six layers
 * (composition, surfaces, automation, state, access, config) are FLAT: the
 * plan's diagram (§3.1) draws them as single bands, with no per-domain
 * subdivision, so a state ledger or an access reader carries no domain tag
 * even when its CONTENT is domain-specific (job-history's rolling window is
 * ci-scheduling's data, but the state layer is where every domain's runtime
 * records live — rule 3 of §3.2).
 *
 * HOW A FILE WAS PLACED, IN ORDER OF AUTHORITY:
 *   1. Plan §3.5's own "today" column, where it names the file explicitly.
 *      `src/runners/census.ts` is listed under OBSERVATION there even though
 *      `src/runners/*` is also named under CI-SCHEDULING — the specific
 *      listing wins over the directory-level one, which is exactly why this
 *      map uses ORDERED entries rather than one glob per directory.
 *   2. Plan §3.2's placement rule, applied by hand where §3.5 is silent:
 *      declarative input → config; another system's data → access; this
 *      package's own runtime record (one declared writer, something else
 *      reads it back) → state, REGARDLESS of which domain the record is
 *      about; a decision → a domain's core; the I/O around that decision →
 *      the same domain's run; a converger's repair logic stays in its domain,
 *      the generic scheduling/paging machinery it plugs into is automation.
 *   3. Where neither says anything (a handful of generic, domain-blind
 *      utilities — `concurrency.ts`, `stdin.mjs`, `blank-comments.mjs`,
 *      `emit.mjs`, `yaml-comments.mjs`, the two usage-log halves, the two
 *      test-identity helpers, `f-guards/lib.mjs`) they are filed under
 *      `automation` as the least-wrong flat layer, since automation's own
 *      definition ("job runner, scheduler, pager ledger, report shapes") is
 *      already the plan's bucket for generic cross-cutting mechanics. This is
 *      a judgment call, named here rather than hidden: a later wave may want
 *      a dedicated layer for domain-blind utilities instead of folding them
 *      into automation.
 *
 * A FEW DELIBERATE DEPARTURES FROM A LITERAL READING OF SRC/RUNNERS/* AS
 * "CI-SCHEDULING": `drain.ts`, `hosting-record.ts`, `backstop-force.ts`,
 * `backstop-hold.ts`, `capacity-ledger.ts`, `dispatch-daily.ts`,
 * `schedulable.ts` and `decision-log.ts` are each "the one state file with a
 * declared writer, read back by something else" shape — the STATE pattern
 * rule 3 describes — so they are classified `state`, not `ci-scheduling`,
 * even though §3.5's blanket "ci-scheduling: src/runners/*" line would put
 * them there. `prove-job.ts` is `lifecycle` per §3.5's own misplacement note
 * ("sits in runners/ but is an operator library"). `host-lease.ts` is kept
 * under `tenancy` because §3.5 names it there explicitly ("host-lease
 * (actually pm2-host reservation)") even though its shape also resembles a
 * state record — the explicit listing is followed rather than second-guessed.
 * (Each of these is ALSO recorded as a `why` on its own entry in
 * `layer-map.json`; this paragraph is the one-place summary.)
 *
 * `node-reservation.ts` (ci-scheduling) importing `host-lease.ts` (tenancy)
 * directly, rather than through a state record, is exactly the rule-5
 * violation §3.2 describes ("a domain reads another domain's facts through a
 * state record") — left in place on purpose, as a real finding for the
 * measurement to surface, not fixed here (this wave MEASURES, it does not
 * move code). Tracked as a debt pair in `scripts/lib/layer-debt.json`, not
 * here: this file's data does not carry import-edge debt, only placement.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @typedef {'composition'|'surfaces'|'domain'|'automation'|'state'|'access'|'config'} Layer */
/** @typedef {'lifecycle'|'ci-scheduling'|'tenancy'|'observation'} Domain */
/** @typedef {'core'|'run'} Part */

export const LAYERS = Object.freeze([
	'composition',
	'surfaces',
	'domain',
	'automation',
	'state',
	'access',
	'config',
]);

export const DOMAINS = Object.freeze(['lifecycle', 'ci-scheduling', 'tenancy', 'observation']);

export const PARTS = Object.freeze(['core', 'run']);

const DATA_PATH = fileURLToPath(new URL('./layer-map.json', import.meta.url));

/** Keys an entry may carry. Anything else is a typo/malformed entry. */
const ALLOWED_KEYS = new Set(['glob', 'layer', 'domain', 'part', 'why', 'section']);

/**
 * VALIDATE an already-parsed `layer-map.json` payload into the same shape
 * the old hand-written `LAYER_MAP` array had (`{glob, layer, domain?,
 * part?}`, plus the now-external `why`/`section` rationale). A malformed
 * entry THROWS, naming its index, rather than being silently skipped or
 * coerced — per CLAUDE.md, a map that quietly classifies nothing is a worse
 * failure than one that refuses to load at all. Exported separately from
 * {@link loadLayerMap} (its only caller outside tests) so
 * `layer-map.test.mjs` can exercise it against fixture payloads without
 * touching the real `layer-map.json` on disk.
 *
 * @param {unknown} raw
 * @returns {Array<{glob: string, layer: Layer, domain?: Domain, part?: Part, why?: string, section?: string}>}
 */
export function validateLayerMap(raw) {
	if (!Array.isArray(raw)) {
		throw new Error(`layer-map.json: expected an array, got ${typeof raw}`);
	}
	for (const [i, entry] of raw.entries()) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new Error(`layer-map.json[${i}]: expected an object, got ${JSON.stringify(entry)}`);
		}
		for (const key of Object.keys(entry)) {
			if (!ALLOWED_KEYS.has(key)) {
				throw new Error(`layer-map.json[${i}]: unknown key "${key}"`);
			}
		}
		if (typeof entry.glob !== 'string' || entry.glob.length === 0) {
			throw new Error(`layer-map.json[${i}]: "glob" must be a non-empty string`);
		}
		if (!LAYERS.includes(entry.layer)) {
			throw new Error(
				`layer-map.json[${i}] (${entry.glob}): "layer" must be one of ${LAYERS.join(', ')}, got ${JSON.stringify(entry.layer)}`
			);
		}
		if (entry.layer === 'domain') {
			if (!DOMAINS.includes(entry.domain)) {
				throw new Error(
					`layer-map.json[${i}] (${entry.glob}): layer "domain" requires "domain" to be one of ${DOMAINS.join(', ')}, got ${JSON.stringify(entry.domain)}`
				);
			}
			if (!PARTS.includes(entry.part)) {
				throw new Error(
					`layer-map.json[${i}] (${entry.glob}): layer "domain" requires "part" to be one of ${PARTS.join(', ')}, got ${JSON.stringify(entry.part)}`
				);
			}
		} else {
			if (entry.domain !== undefined) {
				throw new Error(
					`layer-map.json[${i}] (${entry.glob}): "domain" is only valid when layer is "domain", got layer ${JSON.stringify(entry.layer)}`
				);
			}
			if (entry.part !== undefined) {
				throw new Error(
					`layer-map.json[${i}] (${entry.glob}): "part" is only valid when layer is "domain", got layer ${JSON.stringify(entry.layer)}`
				);
			}
		}
		if (entry.why !== undefined && typeof entry.why !== 'string') {
			throw new Error(`layer-map.json[${i}] (${entry.glob}): "why" must be a string`);
		}
		if (entry.section !== undefined && typeof entry.section !== 'string') {
			throw new Error(`layer-map.json[${i}] (${entry.glob}): "section" must be a string`);
		}
	}
	return raw;
}

/** Read `layer-map.json` off disk and validate it. */
function loadLayerMap() {
	return validateLayerMap(JSON.parse(readFileSync(DATA_PATH, 'utf8')));
}

/**
 * One entry per glob. FIRST MATCH WINS, which is why the specific files named
 * in plan §3.5 (census.ts, drain.ts, hosting-record.ts, prove-job.ts, …) are
 * listed ahead of any directory-level glob that would otherwise catch them.
 * A glob is either an exact relative path, or may use `*` (any run of
 * characters except `/`) and `**` (any run of characters including `/`).
 *
 * @type {Array<{glob: string, layer: Layer, domain?: Domain, part?: Part, why?: string, section?: string}>}
 */
export const LAYER_MAP = Object.freeze(loadLayerMap());

/** Escape every regex metacharacter except the glob's own `*`. */
function globToRegExp(glob) {
	let out = '';
	for (let i = 0; i < glob.length;) {
		if (glob.slice(i, i + 2) === '**') {
			out += '.*';
			i += 2;
			continue;
		}
		const c = glob[i];
		if (c === '*') {
			out += '[^/]*';
		} else {
			out += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
		}
		i += 1;
	}
	return new RegExp(`^${out}$`);
}

const compiled = LAYER_MAP.map((entry) => ({
	entry,
	exact: !entry.glob.includes('*'),
	re: entry.glob.includes('*') ? globToRegExp(entry.glob) : undefined,
}));

/**
 * The FIRST entry whose glob matches `relPath` (posix-separated, relative to
 * the repo root, e.g. `src/runners/census.ts`), or `undefined` if nothing
 * matches — the caller (`measure-layers.mjs`) turns that into a test failure,
 * because the map is meant to be total over the files it enumerates.
 *
 * ONE ORDERED PASS, exactly as declared in `layer-map.json` above — "first
 * match wins" over the single list, with no special-casing of exact entries
 * over wildcards. That is why every per-file override in that data is
 * written ahead of the directory-level catch-alls (`src/runners/*.ts`,
 * `scripts/check-*.mjs`) at the end of the array: a single ordered pass would
 * otherwise let a catch-all shadow a more specific entry declared after it.
 */
export function matchLayer(relPath) {
	for (const { entry, exact, re } of compiled) {
		if (exact ? entry.glob === relPath : re.test(relPath)) return entry;
	}
	return undefined;
}
