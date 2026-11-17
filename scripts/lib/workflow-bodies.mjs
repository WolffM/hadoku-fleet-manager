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

/**
 * Read every repo's workflow files. Never throws: a batch that fails every
 * attempt marks each of its repos `{ ok: false, reason }`.
 *
 * `runGh(args)` returns gh's stdout and throws gh's error; injected for tests.
 */
export function readWorkflowBodies(
	repos,
	{
		runGh = (args) =>
			execFileSync('gh', args, {
				encoding: 'utf8',
				maxBuffer: 64 * 1024 * 1024,
				timeout: TIMEOUT_MS,
				stdio: ['ignore', 'pipe', 'pipe'],
			}),
		attempts = READ_ATTEMPTS,
		// The same one-second pause reconcile's other retried reads take.
		sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000),
	} = {}
) {
	const out = new Map();
	for (let at = 0; at < repos.length; at += BATCH) {
		const batch = repos.slice(at, at + BATCH);
		const args = ['api', 'graphql', '-f', `query=${workflowQuery(batch)}`];
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
		if (doc) for (const [repo, r] of parseWorkflowBatch(doc, batch)) out.set(repo, r);
		else for (const repo of batch) out.set(repo, { ok: false, reason });
	}
	return out;
}
