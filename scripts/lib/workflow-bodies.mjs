/**
 * EVERY REPO'S WORKFLOW FILES, READ IN A HANDFUL OF GRAPHQL CALLS
 * (fleet-manager#111).
 *
 * `fleet reconcile` asks two questions of workflow bodies: does a repo below
 * autoInclude's count target the fleet (`targetsSelfHostedFleet`), and does
 * any repo the owner has read `vars.CI_RUNNER` (`ciRunnerVarCheck`). Both used
 * to read one REST contents call per FILE, each a synchronous `gh` spawn: by
 * 2026-11-17 that was ~300 serial calls over 86 repos and 174 files, and one
 * `reconcile --json` took 223 s of `ci:fleet-coverage`'s 300 s budget (20 s on
 * 11-05). Here every body arrives with its directory listing, `BATCH` repos
 * per query.
 *
 * EXPLICIT `repository(owner, name)` ALIASES, never `viewer.repositories`.
 * Reconcile runs on the fleet-gates App's installation token, whose viewer is
 * the bot, not the owner; the alias form reads exactly the population the
 * caller already listed, with any token, and an unreadable repo comes back as
 * its own null with its own error.
 *
 * UNREADABLE IS NEVER "NO WORKFLOWS". A repo GraphQL could not resolve, a
 * batch that failed every attempt, or a file whose blob carried no text
 * (binary, or truncated) is reported with its reason; each caller decides
 * what that means for it, exactly as each did with the REST reads.
 *
 * `readActionFiles` reads the action files those workflows call, the same
 * way, for `lib/cargo-bin-cache.mjs`.
 */
import { execFileSync } from 'node:child_process';

import { READ_ATTEMPTS, describeReadFailure } from './read-retry-policy.mjs';

/** Repos per query: 20 workflow trees with bodies is well inside one response. */
export const BATCH = 20;
const TIMEOUT_MS = 60_000;

/** The query for one batch, aliased `r0..rN` in `repos` order. */
export function workflowQuery(repos) {
	const fields = repos.map((full, i) => {
		const [owner, name] = full.split('/');
		return (
			`r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {` +
			' object(expression: "HEAD:.github/workflows") { ... on Tree {' +
			' entries { name type object { ... on Blob { text isTruncated } } } } } }'
		);
	});
	return `query { ${fields.join(' ')} }`;
}

/**
 * One batch's response into `repo -> result`. `doc` is the parsed GraphQL
 * document (`data` plus any per-alias `errors`).
 *
 *   { ok: true, files: [{ name, text }] }   text null + `reason` when unreadable
 *   { ok: false, reason }
 *
 * A repository whose `object` is null has no `.github/workflows` (or no
 * commits): `files: []`, the same answer the REST 404 gave.
 */
export function parseWorkflowBatch(doc, repos) {
	const errs = new Map();
	for (const e of doc?.errors ?? []) {
		const alias = e?.path?.[0];
		if (typeof alias === 'string') errs.set(alias, `${e.type ?? 'error'}: ${e.message ?? ''}`);
	}
	const out = new Map();
	repos.forEach((repo, i) => {
		const alias = `r${i}`;
		const node = doc?.data?.[alias];
		if (!node) {
			out.set(repo, {
				ok: false,
				reason: `GraphQL returned no repository: ${errs.get(alias) ?? 'no error given'}`,
			});
			return;
		}
		const files = [];
		for (const e of node.object?.entries ?? []) {
			if (e.type !== 'blob' || !/\.ya?ml$/.test(e.name)) continue;
			const blob = e.object;
			if (typeof blob?.text !== 'string' || blob.isTruncated) {
				files.push({
					name: e.name,
					text: null,
					reason: blob?.isTruncated ? 'its body was truncated' : 'its body carried no text',
				});
			} else files.push({ name: e.name, text: blob.text });
		}
		out.set(repo, { ok: true, files });
	});
	return out;
}

/** gh's stdout from a run that exited non-zero, if it is still a GraphQL document. */
function documentFrom(err) {
	try {
		const doc = JSON.parse(String(err?.stdout ?? ''));
		return doc && typeof doc === 'object' && 'data' in doc ? doc : null;
	} catch {
		return null;
	}
}

/** gh's default transport and retry pause, shared by both readers below. */
const DEFAULTS = {
	runGh: (args) =>
		execFileSync('gh', args, {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			timeout: TIMEOUT_MS,
			stdio: ['ignore', 'pipe', 'pipe'],
		}),
	attempts: READ_ATTEMPTS,
	// The same one-second pause reconcile's other retried reads take.
	sleep: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000),
};

/**
 * `items` in batches of `BATCH`, one GraphQL query each. `onBatch(batch, doc)`
 * gets the parsed document, or `onFailed(batch, reason)` when every attempt
 * failed. Never throws.
 */
function readBatched(items, queryOf, onBatch, onFailed, { runGh, attempts, sleep }) {
	for (let at = 0; at < items.length; at += BATCH) {
		const batch = items.slice(at, at + BATCH);
		const args = ['api', 'graphql', '-f', `query=${queryOf(batch)}`];
		let reason = 'no attempt was made';
		let doc = null;
		for (let attempt = 1; attempt <= attempts && !doc; attempt++) {
			try {
				doc = JSON.parse(runGh(args));
			} catch (err) {
				// gh exits non-zero on ANY GraphQL error, including one alias's
				// NOT_FOUND; the rest of the batch is still in stdout.
				doc = documentFrom(err);
				if (doc) break;
				reason = `${describeReadFailure(err, TIMEOUT_MS)} (attempt ${attempt}/${attempts})`;
				if (attempt < attempts) sleep();
			}
		}
		if (doc) onBatch(batch, doc);
		else onFailed(batch, reason);
	}
}

/**
 * Read every repo's workflow files. Never throws: a batch that fails every
 * attempt marks each of its repos `{ ok: false, reason }`.
 *
 * `runGh(args)` returns gh's stdout and throws gh's error; injected for tests.
 */
export function readWorkflowBodies(repos, opts = {}) {
	const out = new Map();
	readBatched(
		repos,
		workflowQuery,
		(batch, doc) => {
			for (const [repo, r] of parseWorkflowBatch(doc, batch)) out.set(repo, r);
		},
		(batch, reason) => {
			for (const repo of batch) out.set(repo, { ok: false, reason });
		},
		{ ...DEFAULTS, ...opts }
	);
	return out;
}

// ---------------------------------------------------------------------------
// Action files: what a workflow CALLS (lib/cargo-bin-cache.mjs).
// ---------------------------------------------------------------------------

/** The files `ref` may be: a reusable workflow as named, an action as either spelling. */
function actionCandidates({ path }) {
	if (/\.ya?ml$/.test(path)) return [path];
	const dir = path ? `${path}/` : '';
	return [`${dir}action.yml`, `${dir}action.yaml`];
}

/** The query for one batch of `{ repo, ref, path }`, aliased `a0..aN`. */
export function actionQuery(refs) {
	const fields = refs.map((r, i) => {
		const [owner, name] = r.repo.split('/');
		const files = actionCandidates(r).map(
			(f, j) =>
				`f${j}: object(expression: ${JSON.stringify(`${r.ref}:${f}`)})` +
				' { ... on Blob { text isTruncated } }'
		);
		return (
			`a${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)})` +
			` { ${files.join(' ')} }`
		);
	});
	return `query { ${fields.join(' ')} }`;
}

/**
 * Read owned action and reusable-workflow files at the ref a workflow pins.
 * Returns `Map<"repo@ref:path", { ok: true, text } | { ok: false, reason }>`.
 * A ref with no action file is `ok: false`: the caller asked for something
 * that is not there, which is not the same as an action with no steps.
 */
export function readActionFiles(refs, opts = {}) {
	const out = new Map();
	const key = (r) => `${r.repo}@${r.ref}:${r.path}`;
	readBatched(
		refs,
		actionQuery,
		(batch, doc) => {
			const errs = new Map();
			for (const e of doc?.errors ?? []) {
				if (typeof e?.path?.[0] === 'string') errs.set(e.path[0], e.message ?? '');
			}
			batch.forEach((r, i) => {
				const node = doc?.data?.[`a${i}`];
				if (!node) {
					const why = errs.get(`a${i}`) ?? 'no error given';
					out.set(key(r), { ok: false, reason: `GraphQL returned no repository: ${why}` });
					return;
				}
				const blobs = actionCandidates(r).map((_, j) => node[`f${j}`]);
				const blob = blobs.find((b) => b && typeof b.text === 'string' && !b.isTruncated);
				if (blob) out.set(key(r), { ok: true, text: blob.text });
				else if (blobs.some((b) => b && Object.keys(b).length)) {
					out.set(key(r), { ok: false, reason: 'its body was truncated or carried no text' });
				} else {
					out.set(key(r), {
						ok: false,
						reason: `no ${actionCandidates(r).join(' or ')} at ${r.ref}`,
					});
				}
			});
		},
		(batch, reason) => {
			for (const r of batch) out.set(key(r), { ok: false, reason });
		},
		{ ...DEFAULTS, ...opts }
	);
	return out;
}
