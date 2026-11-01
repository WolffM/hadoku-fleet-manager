/**
 * RESOLVER BINDING for the identity-model gate's G7 (split of
 * scripts/lib/identity-rules.mjs, wave 5q lane C, pure move): which local
 * names a file holds bound to `@wolffm/worker-utils/identity`'s two resolver
 * families (KV vs the edge-router service binding), followed through a
 * local re-export a few hops deep, and the wrangler.toml check that a worker
 * calling a resolver is actually WIRED to resolve one. `collectResolver` is
 * G7's input collector, run once per file during `scanRepo`'s walk
 * (identity-rules.mjs); `checkG7` is the check itself, run once per repo.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { blankComments } from './blank-comments.mjs';
import {
	isTestFile,
	IDENT,
	specifiers,
	resolveLocal,
	stripTomlComments,
	topLevelBindings,
} from './identity-source-parse.mjs';

// ── G7 ───────────────────────────────────────────────────────────────────────
/**
 * The functions that READ THE REGISTRY. Importing the module is not enough to
 * need a binding — `isIdentityError`, `NO_USER_ID` and `NO_REGISTRY` are pure —
 * so the check keys on the calls. But only calls of a name BOUND to the module:
 * matching the bare name flagged hadoku-watchparty's own `resolveRegistryName`,
 * a whoami wrapper in a PM2 service that shares the word and nothing else
 * (#113). See {@link resolverPatterns}.
 *
 * `resolveGranteeVia` is deliberately ABSENT: it is the service-binding form
 * and needs no registry at all. That asymmetry is the whole point of the gate —
 * it distinguishes the two ways of asking rather than counting imports.
 */
const REGISTRY_READER_NAMES = [
	'resolveGrantee',
	'readLiveRows',
	'registryNameMap',
	'liveRowsByName',
	'searchRegistryNames',
	'resolveRegistryName',
	'isRegistryNameTaken',
];

/** The service-binding form. Needs `[[services]] → edge-router`, not KV. */
const EDGE_RESOLVER_NAMES = ['resolveGranteeVia'];

/**
 * The one module the readers come from. worker-utils exports it as a SUBPATH
 * only, so every real import site spells exactly this.
 */
const IDENTITY_MODULE = '@wolffm/worker-utils/identity';

/** Which resolver family a canonical export name belongs to, or null. */
const familyOf = (name) =>
	REGISTRY_READER_NAMES.includes(name) ? 'kv' : EDGE_RESOLVER_NAMES.includes(name) ? 'edge' : null;

/**
 * A LOCAL module's resolver exports: exported name → `'kv' | 'edge'`.
 *
 * hadoku-task's `share-registry.ts` re-exports the readers so its call sites
 * keep one import path, and a call through it IS a registry read — dropping
 * that would trade #113's false positive for a false negative on a worker that
 * genuinely needs the binding. Followed a few hops, cycle-safe; a module that
 * defines its own function of the same name exports nothing here.
 */
const exportCache = new Map();

function resolverExports(abs, depth = 0) {
	if (exportCache.has(abs)) return exportCache.get(abs);
	const out = new Map();
	exportCache.set(abs, out); // a cycle reads as "nothing yet", never a loop
	if (depth > 4) return out;
	let src;
	try {
		src = blankComments(readFileSync(abs, 'utf8'));
	} catch {
		return out; // unreadable: it re-exports nothing this gate can see
	}
	const bound = importedResolvers(src, abs, depth + 1);
	const fromSpec = (spec) =>
		spec === IDENTITY_MODULE
			? 'identity'
			: (() => {
					const f = resolveLocal(abs, spec);
					return f ? resolverExports(f, depth + 1) : null;
				})();
	for (const m of src.matchAll(/\bexport\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
		const origin = fromSpec(m[2]);
		if (!origin) continue;
		for (const [orig, as] of specifiers(m[1])) {
			const fam = origin === 'identity' ? familyOf(orig) : (origin.get(orig) ?? null);
			if (fam) out.set(as, fam);
		}
	}
	for (const m of src.matchAll(/\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
		const origin = fromSpec(m[1]);
		if (origin === 'identity')
			for (const n of [...REGISTRY_READER_NAMES, ...EDGE_RESOLVER_NAMES]) out.set(n, familyOf(n));
		else if (origin) for (const [n, fam] of origin) out.set(n, fam);
	}
	// `import { x } from <identity>; export { x }` — re-export of a binding.
	for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g)) {
		for (const [local, as] of specifiers(m[1])) {
			const fam = bound.names.get(local);
			if (fam) out.set(as, fam);
		}
	}
	return out;
}

/**
 * The local names THIS FILE holds bound to a resolver: `names` (local → family)
 * and `namespaces` (an `import * as ns` of the module itself).
 *
 * An alias counts — `import { resolveGrantee as rg }` then `rg(...)` called the
 * registry with no name this gate knew (mutation-tested 2026-10-10, #98). A
 * name with no binding does not, whatever it is spelled (#113).
 */
function importedResolvers(src, abs, depth = 0) {
	const names = new Map();
	const namespaces = [];
	const re = new RegExp(
		`\\bimport\\s+(?!type\\b)(?:${IDENT}\\s*,\\s*)?(?:\\{([^}]*)\\}|\\*\\s*as\\s+(${IDENT}))\\s*from\\s*['"]([^'"]+)['"]`,
		'g'
	);
	for (const m of src.matchAll(re)) {
		const [, list, ns, spec] = m;
		if (spec === IDENTITY_MODULE) {
			if (ns) namespaces.push(ns);
			for (const [orig, local] of specifiers(list ?? '')) {
				const fam = familyOf(orig);
				if (fam) names.set(local, fam);
			}
			continue;
		}
		const file = list ? resolveLocal(abs, spec) : null;
		if (!file) continue;
		const exported = resolverExports(file, depth);
		for (const [orig, local] of specifiers(list)) {
			const fam = exported.get(orig);
			if (fam) names.set(local, fam);
		}
	}
	return { names, namespaces };
}

/** A call to any of `locals`, bare or through a namespace, or null for none. */
function callOf(locals, namespaces, canon) {
	const alts = [
		...locals.map((n) => `(?<![\\w$.])${n.replace(/\$/g, '\\$')}`),
		...namespaces.map(
			(ns) => `(?<![\\w$.])${ns.replace(/\$/g, '\\$')}\\s*\\.\\s*(?:${canon.join('|')})`
		),
	];
	return alts.length ? new RegExp(`(?:${alts.join('|')})\\s*\\(`) : null;
}

/** The resolver calls THIS FILE can make, as `{ kv, edge }` regexes (null = none). */
function resolverPatterns(src, abs) {
	const { names, namespaces } = importedResolvers(src, abs);
	const of = (fam) => [...names].filter(([, f]) => f === fam).map(([n]) => n);
	return {
		kv: callOf(of('kv'), namespaces, REGISTRY_READER_NAMES),
		edge: callOf(of('edge'), namespaces, EDGE_RESOLVER_NAMES),
	};
}

/**
 * Which hadoku_site worker a SIBLING repo's code is bundled into.
 *
 * Not derivable, and the mismatch is the reason: hadoku-study's resolver lives
 * in `hadoku-study/worker/src/routes/sets.ts` while the wrangler.toml that must
 * bind for it is `hadoku_site/workers/study-api/wrangler.toml` — a different
 * file in a different repo. A child repo cannot check this about itself, which
 * is exactly why it went unchecked until jobplatform hit it.
 *
 * A resolver with NO entry is a hard failure, the same way G6 treats a header
 * reader with no EDGE_MOUNTS entry. That is what keeps the table from rotting:
 * teaching a child app to resolve an owner forces you to say where it deploys.
 */
const SIBLING_WORKERS = {
	'hadoku-study': 'study-api',
	'hadoku-task': 'task-api',
	'hadoku-jobplatform': 'jobplatform-api',
};

/** `[[kv_namespaces]]` … `binding = "SESSIONS_KV"`, at the top level. */
const bindsRegistry = (toml) =>
	topLevelBindings(toml).kv_namespaces.some((e) => /\bbinding\s*=\s*["']SESSIONS_KV["']/.test(e));

/** `[[services]]` … `service = "edge-router"`, at the top level. */
const bindsEdge = (toml) =>
	topLevelBindings(toml).services.some((e) => /\bservice\s*=\s*["']edge-router["']/.test(e));

/**
 * G7 — a worker that resolves an identity must be WIRED to resolve one.
 *
 * `resolveGrantee` degrades rather than throws when `SESSIONS_KV` is absent, on
 * purpose: an annotation failure must not cost a caller the list it was
 * annotating. The cost of that kindness is that a missing binding is invisible
 * until a user tries to hand a row to someone — it typechecks, it deploys, it
 * passes every test, and then it answers a person by name with an outage.
 * jobplatform reached production that way.
 *
 * Statically decidable, so it is checked rather than remembered: the resolver
 * call is in the source, the binding is in the wrangler.toml, and one implies
 * the other.
 *
 * EITHER binding satisfies it. They are not equivalent and the gate does not
 * pretend they are — `SESSIONS_KV` is keyed `key:{rawKey}`, so it grants the
 * worker `list()` over every live credential, while the edge binding answers
 * one name. But both genuinely resolve, and a gate that demanded the broader
 * grant would push every new consumer toward the larger blast radius.
 */
export function checkG7(resolvers, label, siteRoot, add) {
	for (const [worker, use] of resolvers) {
		const tomlRel = `workers/${worker}/wrangler.toml`;
		const tomlPath = resolve(siteRoot, tomlRel);
		if (!existsSync(tomlPath)) {
			add('G7', use.rel, use.line, `${worker} resolves an identity but ${tomlRel} does not exist`);
			continue;
		}
		const toml = stripTomlComments(readFileSync(tomlPath, 'utf8'));
		if (use.viaEdge && !use.viaKv) {
			if (!bindsEdge(toml)) {
				add(
					'G7',
					tomlRel,
					1,
					`${label ?? 'this repo'} calls resolveGranteeVia but ${worker} has no [[services]] binding to edge-router`
				);
			}
			continue;
		}
		if (!bindsRegistry(toml) && !bindsEdge(toml)) {
			add(
				'G7',
				use.rel,
				use.line,
				`resolves an identity, but ${worker} binds neither SESSIONS_KV nor edge-router — every resolve will report an outage`
			);
		}
	}
}

/**
 * G7's input, taken from the walk `scanRepo` is already doing.
 *
 * In hadoku_site the worker is the directory (`workers/<w>/src/**`). In a
 * sibling repo it comes from SIBLING_WORKERS, and a repo that resolves with no
 * entry there is reported rather than skipped — "I could not tell which worker"
 * must never render as "nothing is wrong".
 *
 * edge-router IS the registry and `shared` is the module itself, so neither is
 * a consumer. Tests are excluded: a stub registry is how the module gets
 * exercised, not a claim about a deployment.
 */
export function collectResolver(rel, abs, src, label, resolvers, add) {
	if (isTestFile(rel) || /(^|\/)tests?\//.test(rel)) return;
	const calls = resolverPatterns(src, abs);
	const hit = (text) => Boolean(calls.kv?.test(text) || calls.edge?.test(text));
	const viaKv = Boolean(calls.kv?.test(src));
	const viaEdge = Boolean(calls.edge?.test(src));
	if (!viaKv && !viaEdge) return;
	const firstCall = () => Math.max(src.split('\n').findIndex(hit) + 1, 1);

	let worker;
	if (!label) {
		const m = /^workers\/([^/]+)\/src\//.exec(rel);
		if (!m) return;
		worker = m[1];
		if (worker === 'edge-router' || worker === 'shared') return;
	} else {
		worker = SIBLING_WORKERS[label];
		if (!worker) {
			add('G7', rel, firstCall(), `${label} resolves an identity but has no SIBLING_WORKERS entry`);
			return;
		}
	}

	const prev = resolvers.get(worker);
	resolvers.set(worker, {
		rel: prev?.rel ?? rel,
		line: prev?.line ?? firstCall(),
		viaKv: (prev?.viaKv ?? false) || viaKv,
		viaEdge: (prev?.viaEdge ?? false) || viaEdge,
	});
}
