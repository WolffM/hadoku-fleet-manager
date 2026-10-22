/**
 * prettier-json — render a JSON document the way the repo that OWNS it would.
 *
 * WHY THIS EXISTS (#12)
 * ---------------------
 * `fleet benchmark --write` writes two files that live in ANOTHER repo:
 * hadoku_site's `scripts/admin/fleet-runner-manifest.json` and
 * `fleet-benchmarks.json`. It wrote them with `JSON.stringify(doc, null, 2)`,
 * which expands EVERY array one element per line. hadoku_site's prettier keeps a
 * short array inline (`printWidth: 100`), so every run rewrote lines it had not
 * changed and left that checkout failing its own `format:check`. The 2026-09-08
 * claw-5 run produced a 123-line diff of which about 20 lines were measurements.
 *
 * A formatter of our own would be a SECOND implementation of somebody else's
 * formatting rules — the `isLocalNode` failure over again, and it would drift
 * the first time hadoku_site changed `printWidth`. So this asks the real thing:
 * prettier, resolved from the TARGET file's own tree, configured by the
 * `.prettierrc` that tree already carries. There is nothing to keep in sync
 * because there is no second copy of the answer.
 *
 * IT MUST NOT BECOME A HARD DEPENDENCY. prettier is a devDependency here and
 * this package is consumed in-process by mgmt-api from a production install
 * that has no devDependencies. So resolution is attempted, never assumed, and
 * {@link renderJson} reports which formatter answered — `null` when none did.
 * The CALLER decides what an unformatted write is worth; silently pretending it
 * was formatted is the one thing this file will not do.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * prettier as the given file's own tree would resolve it, or `null`.
 *
 * `createRequire(filePath)` walks `node_modules` up from that file's directory,
 * which is exactly the resolution the owning repo's own `prettier` binary gets.
 * The fallback is this package's devDependency, which is the same version in
 * practice and is what makes the test runnable from a bare checkout.
 */
export async function loadPrettier(filePath) {
	for (const from of [filePath, import.meta.url]) {
		let resolved;
		try {
			resolved = createRequire(from).resolve('prettier');
		} catch {
			continue; // not installed in that tree — try the next
		}
		try {
			const mod = await import(pathToFileURL(resolved).href);
			const api = typeof mod?.format === 'function' ? mod : mod?.default;
			if (typeof api?.format === 'function') return { api, path: resolved };
		} catch {
			continue; // present but unloadable (a broken install) — same answer
		}
	}
	return null;
}

/**
 * `doc` rendered as JSON text, formatted for `filePath`'s repo.
 *
 * @returns `{ text, formatter }` — `formatter` is the resolved prettier path,
 *          or `null` when none could be loaded, in which case `text` is plain
 *          `JSON.stringify` output that the owning repo's `format:check` will
 *          very likely reject. Never throws: a formatting problem must not lose
 *          a measurement that cost a loaded box twenty minutes to obtain.
 */
export async function renderJson(doc, filePath) {
	const plain = `${JSON.stringify(doc, null, 2)}\n`;
	const loaded = await loadPrettier(filePath);
	if (!loaded) return { text: plain, formatter: null };
	try {
		const config = (await loaded.api.resolveConfig(filePath)) ?? {};
		// PLUGINS ARE DROPPED ON PURPOSE. hadoku_site's .prettierrc declares
		// `prettier-plugin-astro`, which is not installed in THIS package and
		// cannot be, and prettier loads declared plugins before it looks at the
		// parser. The json parser is built in and takes no plugin, so dropping
		// them changes nothing about the output and is the difference between
		// this working from either tree and failing from one of them.
		delete config.plugins;
		const text = await loaded.api.format(plain, { ...config, filepath: filePath, parser: 'json' });
		return { text, formatter: loaded.path };
	} catch {
		return { text: plain, formatter: null };
	}
}
