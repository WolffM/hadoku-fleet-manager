/**
 * Where a PACKAGE import's source lives, for `no-app-header` (fleet-manager#118).
 *
 * hadoku-bomberman and hadoku-cardtable mount the platform header as
 * `<GameHeader>` from the game shell kit (`@hadoku/game-ui`, aliased
 * `@wolffm/game-ui` in bomberman), and GameHeader renders `<AppHeader>`. The
 * #97 wrapper rule followed relative imports only, so a header mounted through
 * a package read as "an app root that renders no <AppHeader>" from the day the
 * shells moved into a package (11-18).
 *
 * The source is looked for where the fleet keeps it: a workspace package in the
 * importing repo (cardtable's `packages/game-ui`), then a workspace package in
 * another audited repo (bomberman's copy is published FROM cardtable). That
 * reads the package's source on its repo's shipped branch, not the version the
 * importer pins; the claim checked is "this component mounts the header", which
 * moves with the package rather than with a pin. Not found is not "no header":
 * the caller still reports `no-app-header`, and says which import it could not
 * follow.
 */
import { posix } from 'node:path';

import { readFile } from './header-source.mjs';

/** The extensions an extensionless specifier may resolve to, as the #97 rule tries them. */
export const SOURCE_EXTS = ['', '.tsx', '.jsx', '.ts', '.js', '/index.tsx', '/index.jsx'];

/** `@a/b/c/d` -> `{ pkg: '@a/b', sub: './c/d' }`; `x` -> `{ pkg: 'x', sub: '.' }`. */
export function splitSpecifier(spec) {
	const parts = spec.split('/');
	const n = spec.startsWith('@') ? 2 : 1;
	if (parts.length < n || parts.slice(0, n).some((p) => !p)) return null;
	const rest = parts.slice(n).join('/');
	return { pkg: parts.slice(0, n).join('/'), sub: rest ? `./${rest}` : '.' };
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** The `package.json` nearest `file`, walking up, among `files`; null at the root without one. */
export function nearestManifest(files, file) {
	for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
		const m = dir === '.' ? 'package.json' : `${dir}/package.json`;
		if (files.includes(m)) return m;
		if (dir === '.' || dir === '/') return null;
	}
}

/**
 * The name `pkg` is really published under, from the importer's own manifest:
 * `"@wolffm/game-ui": "npm:@hadoku/game-ui@0.1.70"` imports `@hadoku/game-ui`.
 */
export function realPackageName(source, files, importer, pkg) {
	const m = nearestManifest(files, importer);
	const manifest = m ? parseJson(readFile(source, m) ?? '') : null;
	const range = { ...manifest?.devDependencies, ...manifest?.dependencies }[pkg];
	const alias = /^npm:((?:@[^/@]+\/)?[^@]+)@/.exec(String(range ?? ''));
	return alias ? alias[1] : pkg;
}

/** One `exports` value as a path: a string, or the source-ish condition of an object. */
function exportPath(v) {
	if (typeof v === 'string') return v;
	if (v && typeof v === 'object') return exportPath(v.source ?? v.import ?? v.default);
	return null;
}

/** The package-relative file `sub` names through `manifest.exports`; `sub` itself without a map. */
export function exportTarget(manifest, sub) {
	const map = manifest?.exports;
	if (map === undefined) return sub;
	if (typeof map === 'string' || !Object.keys(map).some((k) => k.startsWith('.'))) {
		return sub === '.' ? exportPath(map) : null;
	}
	if (sub in map) return exportPath(map[sub]);
	for (const [key, value] of Object.entries(map)) {
		const star = key.indexOf('*');
		if (star < 0) continue;
		const head = key.slice(0, star);
		const tail = key.slice(star + 1);
		if (sub.length < head.length + tail.length) continue;
		if (!sub.startsWith(head) || !sub.endsWith(tail)) continue;
		const target = exportPath(value);
		if (target) return target.replace('*', sub.slice(head.length, sub.length - tail.length));
	}
	return null;
}

/** `{ name -> dir }` for every `package.json` in one repo that names itself. */
function manifestsByName(source, files) {
	const out = new Map();
	for (const m of files.filter((f) => /(^|\/)package\.json$/.test(f))) {
		const name = parseJson(readFile(source, m) ?? '')?.name;
		if (typeof name === 'string' && !out.has(name)) out.set(name, { manifest: m });
	}
	return out;
}

/**
 * A locator over the audited fleet: `locate(source, files, importer, spec)`
 * answers `{ source, file }` (the repo and the file a package import resolves
 * to) or `{ why }`. Other repos are opened lazily, once each.
 */
export function packageLocator(fleet, { openRepo, useWorktree, noFetch }) {
	const repos = new Map();
	function repoIndex(name, source, files) {
		if (!repos.has(name)) {
			let entry;
			try {
				const s = source ?? openRepo(name, { useWorktree, noFetch });
				if (s.unreadable) entry = { error: s.unreadable };
				else {
					const fs = files ?? s.files();
					entry = { source: s, files: fs, names: manifestsByName(s, fs) };
				}
			} catch (err) {
				entry = { error: String(err?.message ?? err) };
			}
			repos.set(name, entry);
		}
		return repos.get(name);
	}

	return function locate(source, files, importer, spec) {
		const split = splitSpecifier(spec);
		if (!split) return { why: `${spec} is not a package specifier` };
		const pkg = realPackageName(source, files, importer, split.pkg);
		const named = pkg === split.pkg ? pkg : `${split.pkg} (${pkg})`;
		const unread = [];
		for (const name of [source.name, ...fleet.filter((r) => r !== source.name)]) {
			const idx = name === source.name ? repoIndex(name, source, files) : repoIndex(name);
			if (idx.error) {
				unread.push(`${name}: ${idx.error}`);
				continue;
			}
			const hit = idx.names.get(pkg);
			if (!hit) continue;
			const manifest = parseJson(readFile(idx.source, hit.manifest) ?? '');
			const target = exportTarget(manifest, split.sub);
			if (!target) return { why: `${named} exports no ${split.sub} (${name}:${hit.manifest})` };
			const base = posix.normalize(posix.join(posix.dirname(hit.manifest), target));
			const file = SOURCE_EXTS.map((e) => base + e).find((f) => idx.files.includes(f));
			if (!file)
				return { why: `${named}${split.sub.slice(1)} names ${name}:${base}, which is not there` };
			return { source: idx.source, file };
		}
		return {
			why:
				`no audited repo holds the source of ${named}` +
				(unread.length ? ` (could not read ${unread.join('; ')})` : ''),
		};
	};
}
