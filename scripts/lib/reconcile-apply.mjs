import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripYamlComments } from './yaml-comments.mjs';
import { runnerVarForm } from './runner-var.mjs';
import { runFleetScript } from './run-fleet-script.mjs';
import { siteRoot, stateDir } from './paths.mjs';
import { readRevocations, revokedSets } from '../../dist/capability-revocations.js';
import {
	registrationLabels,
	revokedFor,
	workloadGateContext,
	workloadGatedCapabilities,
} from '../../dist/capabilities.js';
import { proofFileStatus, readProofsForCapability } from '../../dist/lib/measured.js';
import { qualifyRepo } from '../../dist/lib/fleet-config.js';
// The queue-health precedent, imported rather than re-derived — that gate
// measured the transient rate (0.13% of `gh api` calls, 2026-09-07) and one
// number is the point, exactly as `check-fleet-preflight.mjs` and
// `reconcile-runner-identity.mjs` already use it (#80).
import { READ_ATTEMPTS, describeReadFailure } from './queue-health.mjs';
import { listRunners as ghListRunners } from './gh-runners.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SLICE_SCRIPT = resolve(HERE, '..', 'deploy-runners-slice.mjs');
const THROTTLE_SCRIPT = resolve(HERE, '..', 'deploy-ci-throttle.mjs');

/**
 * The labels a standing registration on `node` carries: `registrationLabels`
 * with the workload gate applied, read from the same `$proof` records the JIT
 * mint's gate reads — so a label a canary has not earned (jdk21 on a node with
 * no passing proof) is withheld here exactly as it is at the mint. Built once.
 */
let gateCtx = null;
export function offeredLabels(manifest, node) {
	if (!gateCtx) {
		const status = proofFileStatus();
		const proofs = Object.fromEntries(
			workloadGatedCapabilities().map((id) => [
				id,
				status.corrupt ? [] : readProofsForCapability(id),
			])
		);
		gateCtx = workloadGateContext(Object.keys(manifest.machines ?? {}), proofs, {
			corrupt: status.corrupt,
			// A label a probe executed and judged failed is not projected onto a
			// standing registration either (src/capability-revocations.ts).
			revoked: revokedSets(readRevocations(stateDir())),
		});
	}
	return registrationLabels(manifest.machines?.[node] ?? {}, {
		workloadProofs: gateCtx.byNode[node] ?? {},
		provenCounts: gateCtx.provenCounts,
		revoked: revokedFor(gateCtx, node),
	});
}

// ---------------------------------------------------------------------------
// gh helpers
// ---------------------------------------------------------------------------

function gh(ghArgs, { quiet = false, input = undefined, timeout = undefined } = {}) {
	return execFileSync('gh', ghArgs, {
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
		...(input === undefined ? {} : { input }),
		// Opt-in, and only ever passed by a READ that retries itself (#80) — every
		// other caller keeps the old unbounded behaviour, including every write,
		// which must never be retried and so never needs a per-attempt timeout.
		...(timeout === undefined ? {} : { timeout }),
		// A 404 is an expected, meaningful answer for some probes (no workflows
		// directory, empty repo). Let those callers swallow gh's stderr rather
		// than spraying "Not Found" over an otherwise clean report.
		// stdin MUST be a pipe when `input` is supplied. execFileSync's stdio array
		// wins over the `input` option, so the quiet form's 'ignore' silently closed
		// stdin and every `--input -` write failed with a bare "Command failed" —
		// the error text was discarded by the same 'ignore' on stderr.
		stdio:
			input !== undefined
				? ['pipe', 'pipe', 'pipe']
				: quiet
					? ['ignore', 'pipe', 'ignore']
					: ['ignore', 'pipe', 'pipe'],
	});
}

export function ghJson(ghArgs, opts) {
	return JSON.parse(gh(ghArgs, opts));
}

/**
 * POST a JSON body through `gh api`, returning ok/error rather than throwing.
 *
 * Label writes are per runner and a single failure must not abandon the rest of
 * the fleet — one repo whose token lacks admin should cost one line in the
 * report, not the other twenty-five runners' capabilities.
 */
export function ghWrite(method, path, body) {
	try {
		// NOT quiet: a write that fails must surface WHY. The first version used
		// quiet:true, which discards stderr, so a broken call reported only
		// "Command failed: gh api …" and the actual reason was unrecoverable.
		gh(['api', '-X', method, path, '--input', '-'], { input: JSON.stringify(body) });
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			// stdout too: the earlier fix here recovered stderr ("Command failed"
			// was all that survived), but for `gh api` the body that names the
			// rejected field is on STDOUT, so the reason was still half-missing.
			error: String(
				[err.stderr, err.stdout]
					.map((v) => String(v ?? '').trim())
					.filter(Boolean)
					.join(' ') || err.message
			)
				.trim()
				.slice(0, 160),
		};
	}
}

/** A read that never finishes is a read that never reports (#80). */
export const READ_TIMEOUT_MS = 20_000;
/** Long enough for a blip to pass, short enough to be invisible at the measured 0.13% rate. */
export const RETRY_DELAY_MS = 1_000;

/** Synchronous sleep, for the retries below that run outside the async pool. */
export function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The runner listing's own retry loop moved to `./lib/gh-runners.mjs` (plan
 * §4.1 F2b): it was a byte-for-byte duplicate of `check-label-floor.mjs`'s own
 * copy except for the sync/async axis — see that module's own divergence
 * table. `listRunners` below runs inside `pool(probeList, 8, ...)` (one call
 * per covered repo, up to 28 today), which is exactly why the async
 * transport — the shared module's only transport now — was kept: a
 * synchronous child blocks the WHOLE event loop for as long as it runs,
 * measured in `check-fleet-preflight.mjs` at three `Promise.all`-wrapped
 * `execFileSync` calls of 1s each still taking 3s wall-clock.
 */

/**
 * `gh api` exits non-zero on 404. For runner listings a 404 means "no admin on
 * that repo", which is a real finding — distinguish it from an empty list.
 *
 * Retried per `READ_ATTEMPTS` before it is reported `unreadable` (#80).
 * `ci:fleet-coverage` fails hard on `unreadable.length` either way
 * (`fleet-coverage-check.ts:160`) — the reason says WHY and carries
 * `attempt N/M` instead of a bare error string.
 */
export function listRunners(repo) {
	// `attempts`/`describeFailure` are passed IN rather than imported by the
	// shared module itself — an access-layer module importing `queue-health.mjs`
	// (domain/observation) would be an upward layer violation
	// `layer-guard.test.mjs` refuses; see `gh-runners.mjs`'s own doc.
	return ghListRunners(repo, {
		attempts: READ_ATTEMPTS,
		describeFailure: describeReadFailure,
		timeoutMs: READ_TIMEOUT_MS,
		retryDelayMs: RETRY_DELAY_MS,
	});
}

/**
 * The repo roster (`gh repo list`), retried per `READ_ATTEMPTS` before the
 * "zero repos" failure below is reported (#80). Before this it was a single
 * unretried `ghJson` call, and failing it threw out of `resolveDesired`
 * uncaught — crashing the whole reconciler with no JSON at all, a WORSE shape
 * than the could-not-look findings this file already names elsewhere. It is a
 * single call, not fanned out per repo, so retrying it costs at most ~41s —
 * negligible against any of this script's wrapper budgets.
 */
export function ghRepoListWithRetry(repoListArgs) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		try {
			return ghJson(repoListArgs, { timeout: READ_TIMEOUT_MS });
		} catch (err) {
			reason = `${describeReadFailure(err, READ_TIMEOUT_MS)} (attempt ${attempt}/${READ_ATTEMPTS})`;
			if (attempt < READ_ATTEMPTS) sleepSync(RETRY_DELAY_MS);
		}
	}
	throw new Error(reason);
}

/**
 * One `gh api` read, parsed as JSON, retried per `READ_ATTEMPTS` — the same
 * shape `ghRepoListWithRetry` and `listRunners` already carry for their own
 * reads (#80). NEVER THROWS: `deriveFacets` makes several of these per repo
 * across up to 28 repos, so a thrown error on the first bad one would abandon
 * every repo after it instead of collecting what actually failed and WHY
 * (send-back, 2026-10-04 — "I could not look" must never collapse into "{}").
 * Not `quiet`, deliberately: the caller needs the reason, and `gh()`'s quiet
 * mode discards stderr, which is exactly the diagnostic this exists to keep.
 */
export function ghApiJsonWithRetry(ghArgs) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		try {
			return { ok: true, data: JSON.parse(gh(ghArgs, { timeout: READ_TIMEOUT_MS })) };
		} catch (err) {
			reason = `${describeReadFailure(err, READ_TIMEOUT_MS)} (attempt ${attempt}/${READ_ATTEMPTS})`;
			if (attempt < READ_ATTEMPTS) sleepSync(RETRY_DELAY_MS);
		}
	}
	return { ok: false, reason };
}

export function listWorkflowFiles(repo) {
	try {
		const entries = JSON.parse(
			gh(['api', `repos/${repo}/contents/.github/workflows`], { quiet: true })
		);
		return entries.filter((e) => /\.ya?ml$/.test(e.name)).map((e) => e.name);
	} catch {
		return []; // 404 = no workflows directory, or an empty repo
	}
}

export function countWorkflows(repo) {
	return listWorkflowFiles(repo).length;
}

/**
 * Does any workflow in `repo` actually ask for the claw fleet?
 *
 * `minWorkflows` is a PROXY for "maintained enough to deserve three 835 MB
 * runner installs" — it reads file COUNT and never opens a file. A workflow
 * that says `self-hosted` is DIRECT EVIDENCE of need, and direct evidence has
 * to beat the proxy, because the one repo shape the proxy gets wrong is
 * precisely the shape this whole script exists to catch: a single workflow
 * targeting a fleet that has no runner for it queues forever and reports as a
 * benign cancellation 24h later.
 *
 * That is not hypothetical. hadoku-games-host has exactly one workflow
 * (`vibecompact.yml`, nightly), so `1 < 2` dropped it from autoInclude and
 * nobody wrote it an explicit entry. Its audit ran ZERO times between
 * 2026-08-13 and 2026-08-23 — eleven consecutive queue-until-expiry
 * cancellations that no alert ever surfaced.
 *
 * TWO FORMS COUNT AS EVIDENCE, and missing the second is how games-host stayed
 * off the roster for a further ten days after that was written.
 *
 * This used to test `/self-hosted/` against the file and nothing else. That was
 * correct while games-host said `runs-on: [self-hosted, hadoku-builder]` — and
 * the 2026-08-30 org-wide sweep rewrote every covered repo to the bare
 * `${{ fromJSON(vars.CI_RUNNER) }}` form, which is the form CLAUDE.md now
 * MANDATES. The literal moved out of the file and into the variable's value, so
 * the direct-evidence override silently stopped matching anything and every
 * single-workflow repo on the fleet form fell back to the proxy that gets it
 * wrong. Same shape as the comment-reading bug: a detector left behind by a
 * deliberate move of the thing it detects.
 *
 * A workflow referencing `vars.CI_RUNNER` IS asking for this fleet — that
 * variable is written by this package, to covered repos, and nothing else reads
 * it. `runnerVarForm` is the one place that question is answered, and it strips
 * comments for the same reason this function does.
 *
 * Only called when the cheap count would EXCLUDE the repo, so a repo already
 * inside autoInclude costs no extra API calls at all.
 */
export function targetsSelfHostedFleet(repo) {
	for (const file of listWorkflowFiles(repo)) {
		let body;
		try {
			const blob = JSON.parse(
				gh(['api', `repos/${repo}/contents/.github/workflows/${file}`], { quiet: true })
			);
			body = Buffer.from(blob.content ?? '', 'base64').toString('utf8');
		} catch (err) {
			// An unreadable workflow must not quietly vote "needs no runner" — that
			// is the silent-exclusion failure this function was added to end. Say so
			// and keep checking the rest.
			// stderr, not `say()` — this must stay visible under --json too.
			console.error(
				`reconcile-fleet-runners: ${repo}: could not read .github/workflows/${file}, ` +
					`so its runner target is unknown: ${String(err.stderr || err.message)
						.trim()
						.slice(0, 120)}`
			);
			continue;
		}
		// COMMENT-STRIPPED. A comment saying why a repo is NOT on the fleet is not
		// evidence that it is — see scripts/lib/yaml-comments.mjs for the
		// 2026-08-30 page this caused. Both helpers strip; neither can be skipped.
		if (/self-hosted/.test(stripYamlComments(body))) return true;
		if (runnerVarForm(body) !== null) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Facets — what each covered repo IS, so fleet checkers stop keeping their own
// membership lists.
// ---------------------------------------------------------------------------

/**
 * Before this existed, `check-header-fleet.mjs`, `check-tier-fleet.mjs` and
 * `check-mf-externals.mjs` each carried a hand-written `const FLEET = [...]`.
 * They had already drifted from each other and from reality: on 2026-08-23 the
 * header list held 14 repos, tier 15, mf-externals 9, against 24 with live CI
 * coverage. header and tier disagreed on SEVEN repos in both directions, and
 * nine covered repos — vibecheck, hadoku-task-mobile, hadoku-registry,
 * hadoku-privatebin, hadoku-filetransfer, brave-quartet among them — were
 * inspected by neither. A new child app was not hypothetically left behind; it
 * already had been, several times.
 *
 * The lists are not interchangeable, which is why one flat roster would be
 * wrong: brave-quartet is a Rust/Bevy crate and checking it for a React
 * `AppHeader` is permanent noise. So membership is derived per FACET and each
 * checker filters on the facet it cares about — a new repo is in scope
 * everywhere by default, and exclusions become explicit entries in that
 * checker's allowlist rather than an absence nobody notices.
 *
 * Derived from evidence, never declared, for the same reason `getCronIdentities`
 * is derived: a list that must be edited in lockstep with reality is a list that
 * will be wrong.
 */
export const WOLFFM_SCOPE = '@wolffm/';
/** Where a workspace's app package.json can live across this fleet. */
/**
 * Cap on package.json reads per repo — a monorepo must not cost 100 API calls.
 *
 * A CEILING THAT REFUSES, not one that truncates. This was 12 and the loop
 * took `.slice(0, 12)`: hadoku_site holds 41 manifests, so 29 were never read
 * and any facet declared only in them was silently absent — the "I could not
 * look" collapse into "{}" this file refuses everywhere else. Every manifest
 * up to the cap is read now (one call each, retried); a repo over it is
 * UNREADABLE and refuses the write, naming the count, so raising this is a
 * decision someone makes rather than a truncation nobody sees.
 */
export const MAX_PKG_READS = 64;

/**
 * Every tracked path in a repo, in ONE API call. `null` if unreadable.
 *
 * Addressed as `HEAD` rather than a branch name so nothing here has to know or
 * cache a default branch — `main` is not universal across this fleet and a
 * wrong guess would silently yield an empty tree, i.e. "no facets" on a repo
 * that has them.
 */
/**
 * Repos the parent page MOUNTS, from `scripts/child-apps.json` — the
 * authoritative declaration of what hadoku.me embeds. Read rather than
 * re-derived: which apps are mounted is a product decision, not something
 * recoverable from a repo's own contents.
 */
/**
 * `{mounted, reason}` — a missing or unparseable `child-apps.json` is "could
 * not look", never "no apps mounted" (send-back, 2026-10-04): every repo's
 * `microFrontend` facet depends on this file, so an unreadable registry must
 * refuse the whole write/check rather than silently reporting zero apps
 * mounted — the same failure shape repoTree/readJsonFile below carry.
 */
export function loadMountedApps() {
	try {
		const reg = JSON.parse(readFileSync(join(siteRoot(), 'scripts', 'child-apps.json'), 'utf8'));
		return {
			// MOUNTED means "in the MF registry", and `includeInRegistry: false`
			// is the line hadoku_site's generate-registry.mjs draws — the same
			// test, so the two cannot disagree. Every `repoName` used to count,
			// which gave the self-serving tunnel apps (conjure, pygmalion,
			// cardtable, bomberman, filetransfer) a `microFrontend` facet; the
			// externals audit then hid that only by skipping any config without
			// a `lib:` build, which also skipped a REAL mounted app that lost one.
			mounted: new Set(
				(reg.apps ?? [])
					.filter((a) => a.includeInRegistry !== false)
					.map((a) => a.repoName)
					.filter(Boolean)
					.map((n) => qualifyRepo(n))
			),
			reason: null,
		};
	} catch (err) {
		return { mounted: new Set(), reason: err.message };
	}
}

/**
 * `{paths, reason}` — `paths` is `null` only when the read itself failed
 * (after `READ_ATTEMPTS`), never for a genuinely empty tree, which is `[]`.
 * `reason` carries WHY, so a caller refusing a write can name it rather than
 * silently writing `{}` for a repo this read a 429 or a transient 5xx on
 * (send-back, 2026-10-04).
 */
export function repoTree(repo) {
	const r = ghApiJsonWithRetry(['api', `repos/${repo}/git/trees/HEAD?recursive=1`]);
	if (!r.ok) return { paths: null, reason: r.reason };
	const t = r.data;
	// GitHub caps a recursive tree (100,000 entries / 7 MB) and says so with
	// `truncated: true` rather than an error. A truncated tree is a PARTIAL
	// listing, and every facet below reads absence as "not here" — so it is
	// unreadable, exactly like a failed read.
	if (t.truncated === true) {
		return { paths: null, reason: 'GitHub returned a truncated tree (truncated: true)' };
	}
	return {
		paths: Array.isArray(t.tree) ? t.tree.filter((n) => n.type === 'blob').map((n) => n.path) : [],
		reason: null,
	};
}

/** `{data, reason}`, same discipline as {@link repoTree}. */
export function readJsonFile(repo, path) {
	const r = ghApiJsonWithRetry(['api', `repos/${repo}/contents/${path}`]);
	if (!r.ok) return { data: null, reason: r.reason };
	try {
		return {
			data: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')),
			reason: null,
		};
	} catch (err) {
		return { data: null, reason: `unparseable JSON: ${err.message}` };
	}
}

/**
 * Facets for one repo, plus `unreadable` — WHY, if any read behind it failed.
 *
 * "I COULD NOT LOOK" MUST NEVER READ AS "NOTHING HERE" (send-back, 2026-10-04).
 * This used to let an unreadable tree or package.json collapse silently into
 * `{}` — a rate-limited or transient read then WROTE a coverage file where
 * that repo had lost every content facet (`wolffmConsumer`, `uiApp`,
 * `microFrontend`), dropping it out of `check-header-fleet` / `check-tier-fleet`
 * / `check-mf-externals` with nothing said anywhere. The caller refuses the
 * whole write/check when `unreadable` is non-null for ANY repo, rather than
 * committing the degradation (#84 part 2's "nothing reads zero", one level
 * down from the checkout case the issue names).
 */
export function deriveFacets(repo, mountedApps) {
	const tree = repoTree(repo);
	if (tree.paths === null) {
		return { facets: {}, unreadable: `${repo}: tree unreadable — ${tree.reason}` };
	}
	const paths = tree.paths;
	const facets = {};
	let unreadable = null;

	// EVERY package.json in the tree, not a guessed list of directories. The app
	// package sits at the root in most repos, but `frontend/` in tenhands,
	// `apps/ui/` in watchparty and `packages/ui/` in conjure — a hardcoded list
	// missed the last two on the first run, reporting them as non-UI when their
	// dependency on task-ui-components is what defines them. Same lesson as
	// resolving a systemd unit from its cgroup: enumerate, never guess a layout.
	const pkgPaths = paths.filter((p) => /(^|\/)package\.json$/.test(p));
	if (pkgPaths.length > MAX_PKG_READS) {
		return {
			facets: {},
			unreadable:
				`${repo}: ${pkgPaths.length} package.json files, over the ${MAX_PKG_READS}-read cap — ` +
				'refusing to derive facets from a subset (raise MAX_PKG_READS deliberately)',
		};
	}
	const deps = {};
	for (const p of pkgPaths) {
		const { data: pkg, reason } = readJsonFile(repo, p);
		if (reason) {
			// FIRST failure named and kept; the loop still runs to completion
			// (the tree read already succeeded, so the remaining calls are not
			// chasing a dead repo) but the repo is refused regardless of what the
			// rest of the merge produces.
			unreadable = unreadable ?? `${repo}: ${p} unreadable — ${reason}`;
			continue;
		}
		Object.assign(deps, pkg?.dependencies ?? {}, pkg?.devDependencies ?? {});
	}
	const wolffm = Object.keys(deps).filter((d) => d.startsWith(WOLFFM_SCOPE));
	if (wolffm.length) facets.wolffmConsumer = wolffm.sort();
	// The unified header ships in task-ui-components; consuming it is exactly
	// what makes a repo subject to the header + always-latest policy. Declaring
	// it ANYWHERE in the workspace counts — hadoku-merchant declares only
	// worker-utils and is correctly not a UI app, though the hand-kept list this
	// replaces had it.
	if (deps[`${WOLFFM_SCOPE}task-ui-components`]) facets.uiApp = true;

	// A micro-frontend is one the parent page MOUNTS. Apps that serve their own
	// HTML have no parent import map and must inline everything, so they are out
	// of scope for the externals rule; `scripts/child-apps.json` is the
	// authoritative declaration of what is mounted. The build paths are read off
	// the tree so nobody hand-maintains them — prefer a vite config that has a
	// sibling `src/`, which is the one that builds the mounted bundle.
	if (mountedApps.has(repo)) {
		const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
		// SHALLOWEST wins. A repo can hold several vite configs — hadoku-task
		// vendors `task-ui-components/vite.config.ts` for the library alongside the
		// app's own at the root — and "has a sibling src/" is true of both, so
		// depth is what distinguishes the app from a package it happens to build.
		// Picking the wrong one points the externals rule at a library that is
		// SUPPOSED to bundle its deps, which would report a false violation.
		const vite = paths
			.filter((p) => /(^|\/)vite\.config\.[tj]s$/.test(p))
			.filter((p) => paths.some((q) => q.startsWith(`${dirOf(p)}src/`)))
			.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
		if (vite) facets.microFrontend = { vite, src: `${dirOf(vite)}src` };
	}
	return { facets, unreadable };
}

/**
 * One repo by name. GitHub follows a rename, so `nameWithOwner` is the CURRENT
 * name. A 404 is an answer and is not retried; anything else is.
 */
export function lookupRepo(name) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		try {
			const repo = JSON.parse(gh(['api', `repos/${name}`], { timeout: READ_TIMEOUT_MS }));
			if (typeof repo.full_name !== 'string') {
				return { ok: false, notFound: false, reason: 'the lookup answered with no full_name' };
			}
			return { ok: true, nameWithOwner: repo.full_name };
		} catch (err) {
			if (/HTTP 404/.test(String(err.stderr ?? ''))) {
				return { ok: false, notFound: true, reason: 'HTTP 404' };
			}
			reason = `${describeReadFailure(err, READ_TIMEOUT_MS)} (attempt ${attempt}/${READ_ATTEMPTS})`;
			if (attempt < READ_ATTEMPTS) sleepSync(RETRY_DELAY_MS);
		}
	}
	return { ok: false, notFound: false, reason };
}

export function currentRunnerVersion() {
	const tag = gh(['api', 'repos/actions/runner/releases/latest', '-q', '.tag_name']).trim();
	if (!tag) throw new Error('could not resolve the latest actions/runner release');
	return tag.replace(/^v/, '');
}

/**
 * Write a claw's slice drop-in and throttle env for units that are enabled
 * but not yet started (#1), by running the SAME drivers the operator runs.
 *
 * The drivers are the only statement of what those files hold — the per-unit
 * cap is computed from the node's measured MemTotal, the `.env` carries five
 * keys and the hook must land before the line naming it — so registration
 * calls them rather than writing a third copy. Slice first, without
 * `--restart`: `place()` sees an inactive unit's declared `Slice=`, writes the
 * drop-in and daemon-reloads, and there is nothing running to restart. Throttle
 * with `--no-restart`: there is no listener yet, and every OTHER runner on the
 * node is left exactly as it was.
 *
 * JUDGED PER MACHINE, NOT BY EXIT CODE. Either driver exits 1 for drift
 * elsewhere on the node (a stale listener on another runner, say), which says
 * nothing about whether THIS unit's files were written. What has to hold is
 * that the node answered and the write steps did not report failure. The
 * start step then reads the kernel.
 */
export async function provisionBeforeStart(claw) {
	const slice = await runFleetScript(SLICE_SCRIPT, ['--machine', claw, '--confirm', '--json']);
	const s = slice.json?.results?.find((r) => r.machine === claw);
	if (!s?.ok || !s.summary)
		return {
			ok: false,
			why: `slice --confirm did not converge ${claw}: ${s?.error ?? (slice.why || 'no result for this node')}`,
		};
	const sliceFailed = (s.notes ?? []).filter((n) =>
		/^(PLACE-FAILED|NEEDS-OPERATOR|SLICE-FAIL) /.test(n)
	);
	if (sliceFailed.length || Number(s.summary.failed) > 0)
		return {
			ok: false,
			why: `slice --confirm on ${claw}: ${sliceFailed.join('; ') || `failed=${s.summary.failed}`}`,
		};

	const thr = await runFleetScript(THROTTLE_SCRIPT, [
		'--machine',
		claw,
		'--confirm',
		'--no-restart',
		'--json',
	]);
	const t = thr.json?.results?.find((r) => r.machine === claw);
	if (!t?.ok || !t.summary || t.expectedDown)
		return {
			ok: false,
			why: `throttle --confirm did not converge ${claw}: ${t?.error ?? t?.skipped ?? (thr.why || 'no result for this node')}`,
		};
	const hookFailed = (t.notes ?? []).filter((n) => n.startsWith('HOOK-INSTALL-FAILED'));
	if (hookFailed.length)
		return { ok: false, why: `throttle --confirm on ${claw}: ${hookFailed.join('; ')}` };

	return { ok: true, sliceName: s.sliceName };
}

export function mintToken(repo, kind) {
	const path =
		kind === 'remove'
			? `repos/${repo}/actions/runners/remove-token`
			: `repos/${repo}/actions/runners/registration-token`;
	// Minted per (repo × claw) at the moment of use: these are single-use and
	// expire in an hour, so batch-minting them up front would hand out tokens
	// that are dead before the run reaches them.
	return gh(['api', '-X', 'POST', path, '-q', '.token']).trim();
}
