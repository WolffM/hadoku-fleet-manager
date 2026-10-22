/**
 * Every declared `exports` target and `bin` entry must exist after a build.
 *
 * A package can declare an export whose file was never written, and nothing
 * notices until a consumer's import throws at runtime — by which point it has
 * been published. This repo is especially exposed to that: the exports map is
 * written NOW, at scaffold stage, describing files that arrive across three
 * later migration phases (`./tier-detectors` and the `fleet` bin land with the
 * CLI move). A map that runs ahead of the tree is the normal state here, so it
 * needs a gate rather than care.
 *
 * Runs against the BUILD OUTPUT, not the source — the thing consumers actually
 * resolve. Reading the source tree would be a verifier reading its own writer.
 *
 * @guards package.json
 * @guards src/**
 */
import process from 'node:process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

/**
 * The manifest is NARROWED, not asserted.
 *
 * `JSON.parse` yields `any`, and casting it with a JSDoc `@type` only moves the
 * unsafety somewhere the linter stops looking. Walking it with real `typeof`
 * checks costs a few lines and buys the thing a cast cannot: a malformed
 * package.json becomes a clear failure here instead of a `TypeError` three
 * frames away, or — worse — an empty target list that reports success.
 *
 * @param {unknown} value
 * @returns {[string, string][]} declared `[name, path]` pairs
 */
function declaredTargets(value) {
	if (typeof value !== 'object' || value === null) {
		throw new TypeError('package.json did not parse to an object');
	}
	const pkg = /** @type {Record<string, unknown>} */ (value);
	/** @type {[string, string][]} */
	const out = [];

	const exports = pkg.exports;
	if (typeof exports === 'object' && exports !== null) {
		const byEntry = /** @type {Record<string, unknown>} */ (exports);
		for (const [entry, cond] of Object.entries(byEntry)) {
			if (typeof cond === 'string') {
				out.push([`exports["${entry}"]`, cond]);
			} else if (typeof cond === 'object' && cond !== null) {
				const byCondition = /** @type {Record<string, unknown>} */ (cond);
				for (const [key, target] of Object.entries(byCondition)) {
					if (typeof target === 'string') out.push([`exports["${entry}"].${key}`, target]);
				}
			}
		}
	}

	const bin = pkg.bin;
	if (typeof bin === 'string') {
		out.push(['bin', bin]);
	} else if (typeof bin === 'object' && bin !== null) {
		const byName = /** @type {Record<string, unknown>} */ (bin);
		for (const [name, target] of Object.entries(byName)) {
			if (typeof target === 'string') out.push([`bin.${name}`, target]);
		}
	}

	return out;
}

const targets = declaredTargets(JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8')));

if (targets.length === 0) {
	console.error(
		'check-exports: package.json declares no exports and no bin. A package that ' +
			'exposes nothing is a bug, not a pass.'
	);
	process.exit(1);
}

const missing = new Set();
for (const [name, target] of targets) {
	const ok = existsSync(new URL(target, ROOT));
	if (!ok) missing.add(name);
	console.log(`${ok ? 'ok     ' : 'MISSING'}  ${name} -> ${target}`);
}
console.log(`check-exports: ${targets.length} declared target(s), ${missing.size} missing.`);

if (missing.size > 0) {
	console.error(
		`\ncheck-exports: ${missing.size} declared target(s) do not exist. Either build ` +
			`first (\`pnpm run build\`), or remove the declaration until the file migrates — ` +
			`a published package with an unresolvable exports entry throws on import.`
	);
	process.exit(1);
}
