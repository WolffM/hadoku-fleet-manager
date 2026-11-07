/**
 * consumer-imports — what a consumer takes from @wolffm/fleet-manager, read from
 * its SOURCE TEXT (fleet-manager#67). A PUBLISHED SUBPATH EXPORT
 * (`@wolffm/fleet-manager/consumer-imports`): mgmt-api builds the list it
 * serves at `GET /api/repo/consumer-imports` with this same code, and
 * scripts/check-consumer-imports.mjs type-checks that list against a candidate
 * build before publish. One extractor, so the list mgmt-api serves and the one a
 * local run reads cannot disagree about what counts as an import.
 *
 * Pure: text in, bindings out. No fs, no git, no network.
 *
 * A binding is `{ spec, name, kind }`: `spec` the specifier
 * (`@wolffm/fleet-manager` or a subpath), `name` the exported name or null when
 * only the subpath must resolve, `kind` value | type | default | namespace |
 * module. `collectUses` adds `usedBy`, the files that import it.
 */
import { blankComments } from './blank-comments.mjs';

export const PKG = '@wolffm/fleet-manager';

/** Source files a consumer may import the package from, and trees that are never its source. */
export const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
export const SKIP = /(?:^|\/)(?:node_modules|dist|build|coverage|\.wrangler)\//;

const SPEC = `['"](${PKG.replace('/', '\\/')}(?:\\/[\\w./-]+)?)['"]`;

/**
 * Every binding a file takes from the package, comments blanked first so
 * prose about an import is never read as one.
 *
 * @returns {{ spec: string, name: string | null, kind: 'value' | 'type' | 'namespace' | 'default' | 'module' }[]}
 *   `name` null for a namespace/side-effect/dynamic import, which needs only
 *   the subpath to resolve.
 */
export function extractImports(source, { js = false } = {}) {
	// Strings blanked too, keeping only a quoted package specifier: a fixture
	// import inside a test's template literal is text, not an import.
	const src = blankComments(source, {
		strings: true,
		keepString: (c) => c === PKG || c.startsWith(`${PKG}/`),
	});
	const out = [];
	const named = (list, spec, typeOnly) => {
		for (const raw of list.split(',')) {
			const part = raw.trim();
			if (!part) continue;
			const isType = typeOnly || /^type\s/.test(part);
			const name = part
				.replace(/^type\s+/, '')
				.split(/\s+as\s+/)[0]
				.trim();
			if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
			out.push({ spec, name, kind: isType && !js ? 'type' : 'value' });
		}
	};
	// import [type] Default, { a, type b as c } from 'spec'
	// import [type] { ... } from 'spec' / import * as ns from 'spec' / import D from 'spec'
	const importRe = new RegExp(
		`\\bimport\\s+(type\\s+)?([\\w$]+\\s*,\\s*)?(\\{[^}]*\\}|\\*\\s+as\\s+[\\w$]+|[\\w$]+)\\s+from\\s+${SPEC}`,
		'g'
	);
	for (const m of src.matchAll(importRe)) {
		const [, typeOnly, defaultPart, clause, spec] = m;
		if (defaultPart) out.push({ spec, name: 'default', kind: 'default' });
		if (clause.startsWith('{')) named(clause.slice(1, -1), spec, Boolean(typeOnly));
		else if (clause.startsWith('*')) out.push({ spec, name: null, kind: 'namespace' });
		else out.push({ spec, name: 'default', kind: 'default' });
	}
	// export [type] { a, b as c } from 'spec' / export * from 'spec'
	const exportRe = new RegExp(
		`\\bexport\\s+(type\\s+)?(\\{[^}]*\\}|\\*(?:\\s+as\\s+[\\w$]+)?)\\s+from\\s+${SPEC}`,
		'g'
	);
	for (const m of src.matchAll(exportRe)) {
		const [, typeOnly, clause, spec] = m;
		if (clause.startsWith('{')) named(clause.slice(1, -1), spec, Boolean(typeOnly));
		else out.push({ spec, name: null, kind: 'namespace' });
	}
	// const { a, b: c } = await import('spec')   — the names destructured, then the bare form
	const dynDestructure = new RegExp(
		`\\{([^}]*)\\}\\s*=\\s*await\\s+import\\(\\s*${SPEC}\\s*\\)`,
		'g'
	);
	for (const m of src.matchAll(dynDestructure)) {
		named(
			m[1]
				.split(',')
				.map((p) => p.split(':')[0])
				.join(','),
			m[2],
			false
		);
	}
	for (const m of src.matchAll(new RegExp(`\\bimport\\(\\s*${SPEC}\\s*\\)`, 'g')))
		out.push({ spec: m[1], name: null, kind: 'module' });
	// import 'spec' (side effect)
	for (const m of src.matchAll(new RegExp(`\\bimport\\s+${SPEC}`, 'g')))
		out.push({ spec: m[1], name: null, kind: 'module' });
	return out;
}

/** Every distinct binding across a consumer's files, with the files that use it. */
export function collectUses(files) {
	const uses = new Map();
	for (const [path, text] of files) {
		if (text === null || !text.includes(PKG)) continue;
		for (const u of extractImports(text, { js: /\.[cm]?js$/.test(path) })) {
			const key = `${u.spec}\0${u.name}\0${u.kind}`;
			const entry = uses.get(key) ?? { ...u, usedBy: [] };
			if (!entry.usedBy.includes(path)) entry.usedBy.push(path);
			uses.set(key, entry);
		}
	}
	return uses;
}
