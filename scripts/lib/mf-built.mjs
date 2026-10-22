/**
 * The BUILT half of `fleet mf-externals` (#111): judge what the page actually
 * loads, not what the source suggests it will.
 *
 * The source half infers `react/jsx-runtime` from the presence of a `.tsx`:
 * the automatic runtime imports it on the compiler's behalf, so no file names
 * it. That proves the runtime is IMPORTED and says nothing about whether the
 * lib build EXTERNALIZED it — watchparty shipped it bundled while the source
 * check was green (2026-10-11).
 *
 * WHAT THE BUILT OUTPUT SAYS, measured on all 13 live bundles 2026-10-20:
 *
 *   - an externalized specifier survives as a BARE import —
 *     `from "react/jsx-runtime"` — in every one of them;
 *   - React's element factory carries its `$$typeof` key,
 *     `Symbol.for("react.transitional.element")` (React 19;
 *     `"react.element"` before it), and none of the 13 contained it.
 *
 * A bundle with the key and WITHOUT the bare import has React's element
 * factory inside it: jsx-runtime, or React itself, was inlined. BOTH halves
 * are required on purpose: `react-is` carries the same key and is a stateless
 * symbol check that recharts pulls in, so the key alone would flag an app
 * whose React is correctly external.
 *
 * WHERE THE OUTPUT COMES FROM: the deployed site. hadoku_site builds the
 * bundles into a gitignored `public/mf/<app>/` at deploy time, so the deploy
 * clone this gate runs from has none (only `vendor/`, which audit-gates
 * fetches for the same reason). What browsers load is the copy to judge.
 * The origin is read from hadoku_site's own `astro.config.mjs` (`site:`), the
 * one declaration of it, rather than spelled here.
 *
 * A bundle that cannot be fetched, or an app with no registry entry, is a
 * FINDING: "I could not look" is not a pass.
 */
import { READ_ATTEMPTS, describeReadFailure } from './queue-health.mjs';

/** React's element `$$typeof` key, either generation. */
export const ELEMENT_KEY = /Symbol\.for\(\s*["']react\.(?:transitional\.)?element["']\s*\)/;

/** A bare `react/jsx-runtime` import in built ESM, in every import form. */
const JSX_RUNTIME_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']react\/jsx-runtime["']/;

/** Relative module specifiers a built file imports (its own chunks). */
export function relativeImports(text) {
	const out = new Set();
	for (const m of String(text).matchAll(
		/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.\.?\/[^"']+)["']/g
	)) {
		out.add(m[1]);
	}
	return [...out];
}

/** The `site:` origin from hadoku_site's astro.config, or null. */
export function siteOrigin(astroConfig) {
	const m = /\bsite\s*:\s*["']([^"']+)["']/.exec(String(astroConfig ?? ''));
	return m ? m[1].replace(/\/+$/, '') : null;
}

/**
 * The verdict on one app's built files (`{ url: text }`): `null` when clean,
 * otherwise the finding's message.
 */
export function judgeBuilt(files) {
	const texts = Object.values(files);
	const keyed = Object.entries(files)
		.filter(([, t]) => ELEMENT_KEY.test(t))
		.map(([u]) => u);
	if (!keyed.length) return null;
	if (texts.some((t) => JSX_RUNTIME_IMPORT.test(t))) return null;
	return (
		`the DEPLOYED bundle inlines React's element runtime (Symbol.for react element key in ` +
		`${keyed.map((u) => u.replace(/\?.*$/, '')).join(', ')}, and no file imports ` +
		`react/jsx-runtime) — a second React the page's import map does not own`
	);
}

/** Bounded so a chunk graph that loops or explodes cannot hang the gate. */
export const MAX_FILES = 64;

/**
 * GET with the same retry and diagnosis every fleet read uses. Resolves
 * `{ ok: true, text }` or `{ ok: false, reason }`.
 */
export async function fetchText(
	url,
	fetchImpl,
	{ attempts = READ_ATTEMPTS, timeoutMs = 15_000 } = {}
) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
			if (res.ok) return { ok: true, text: await res.text() };
			reason = `HTTP ${res.status} (attempt ${attempt}/${attempts})`;
			// A 404 is an answer, not a blip.
			if (res.status === 404) break;
		} catch (err) {
			reason = `${describeReadFailure(err, timeoutMs)} (attempt ${attempt}/${attempts})`;
		}
	}
	return { ok: false, reason };
}

/**
 * Every file one app's entry reaches through RELATIVE imports, inside its own
 * `/mf/<app>/` directory. `{ files }` or `{ reason }` — a chunk that cannot be
 * read means the bundle was not fully looked at, which is not clean.
 */
export async function crawlBundle(entryUrl, fetchImpl) {
	const files = {};
	const queue = [entryUrl];
	while (queue.length) {
		const url = queue.shift();
		if (url in files) continue;
		if (Object.keys(files).length >= MAX_FILES)
			return { reason: `more than ${MAX_FILES} files reachable from ${entryUrl}` };
		const r = await fetchText(url, fetchImpl);
		if (!r.ok) return { reason: `could not fetch ${url}: ${r.reason}` };
		files[url] = r.text;
		for (const spec of relativeImports(r.text)) queue.push(new URL(spec, url).href);
	}
	return { files };
}
