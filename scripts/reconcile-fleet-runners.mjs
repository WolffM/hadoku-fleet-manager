#!/usr/bin/env node
/**
 * reconcile-fleet-runners.mjs — converge self-hosted runner coverage on the
 * claw fleet toward `fleet-runner-manifest.json`.
 *
 * WHY THIS EXISTS
 * ---------------
 * WolffM is a personal GitHub account, so self-hosted runners are REPO-SCOPED:
 * a runner instance serves exactly one repo. Covering N repos on M claws means
 * N×M registrations, and until now each one was a hand-run
 * `register-fleet-runner.sh <claw> <name> <repo>`. Nothing detected a repo that
 * SHOULD have runners and didn't — a workflow with
 * `runs-on: [self-hosted, hadoku-builder]` on an uncovered repo simply queues
 * forever, and one written `runs-on: ubuntu-latest` silently burns billed
 * minutes instead. Coverage accumulated by hand and was visible nowhere.
 *
 * This script makes coverage DECLARATIVE: the manifest is intent, the fleet is
 * reality, and reconciling is a diff. Read-only by default.
 *
 * THE ACCESS CONSTRAINT THAT SHAPES EVERYTHING BELOW
 * --------------------------------------------------
 * `register-fleet-runner.sh` registers as user `hadoku` and calls
 * `sudo ./svc.sh install hadoku`. From hokon that is NOT reachable unattended,
 * verified 2026-08-08:
 *   - `ssh claw-N` lands as `openclaw`; `sudo` there demands a password.
 *   - `ssh hadoku@<LAN IP>` is pubkey-denied.
 *   - `ssh hadoku@<tailscale IP>` hits Tailscale SSH check mode — the session
 *     hangs waiting on an operator-clicked approval URL (75s, no banner, on all
 *     three claws). The `claw*-admin` aliases those docs reference exist in no
 *     ssh config and no DNS.
 * So a `hadoku`-user reconciler could never run on a cron. It would need the
 * operator present for every registration, which defeats the entire point.
 *
 * The way through is the model the `-b` pool already proved in production on
 * 2026-07-25: register as **openclaw** with a hand-written **user** systemd
 * unit. `loginctl show-user openclaw -p Linger` is `yes` on all three claws, so
 * user units survive logout and start at boot. No root, no sudo, no operator.
 *
 * That swap is also a reliability UPGRADE, not a compromise. GitHub's stock
 * `svc.sh`-generated unit has no `Restart=`, which is precisely why all three
 * hadoku-jobplatform runners stayed silently dead on 2026-08-06: GitHub
 * deprecated the runner version they were pinned to, the listener exited "no
 * retry needed", and nothing brought it back. The hand-written unit this script
 * installs carries `Restart=always`.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 *   - Touch hokon. hokon runs `github-runner.service` /
 *     `github-runner-tenhands.service` in `ci-runner.slice` for PM2/host
 *     control and deliberately carries no `hadoku-builder` in steady state.
 *     CI belongs on the claws; a runner named anything but a managed claw is
 *     reported as `unmanaged` and never modified.
 *   - Reinstall an offline runner. That is an incident (see the v2.336.0
 *     deprecation above), not drift — reinstalling would paper over it. Offline
 *     runners are reported.
 *   - Remove coverage because a repo aged out of `pushedWithinDays`. Only
 *     archived / deleted / `skip: true` repos yield removable orphans. A repo
 *     that merely fell out of the auto-include window is reported as
 *     `stale-coverage` and left alone — the window is a rule for GRANTING
 *     coverage, and letting it revoke coverage would make a quiet month delete
 *     a live repo's CI.
 *   - Remove a `hadoku`-owned registration. It cannot: no sudo. Those are
 *     reported as needing the operator, with the exact commands.
 *   - Keep nagging about leftovers nobody intends to clean up. A manifest entry
 *     can say `"ignore": true`, which is the THIRD answer alongside desired and
 *     skipped: `skip` means "should have no runners" and therefore manufactures
 *     orphans, while `ignore` means "whatever it has, leave it and stop telling
 *     me". A report that is permanently non-empty is a report nobody reads, so
 *     an ignored repo collapses to a single line.
 *
 * USAGE
 *   pnpm run fleet:reconcile                     # dry run — plan only, no side effects
 *   pnpm run fleet:reconcile -- --confirm        # register what is missing
 *   fleet reconcile --confirm --remove-orphans
 *   fleet reconcile --repo WolffM/vibecheck
 *   fleet reconcile --json
 *   fleet reconcile --write-coverage             # regenerate fleet-runner-coverage.json
 *   fleet reconcile --check-coverage [--json]    # is it still current (structural only; see below)
 *   fleet reconcile --write-coverage --allow-shrink  # a DELIBERATE drop below half the roster
 *
 * EXIT STATUS
 *   0  fleet matches the manifest (or a --confirm run converged it)
 *   1  drift remains: missing coverage, an apply step failed, a plan exceeded a
 *      machine's maxRegistrations, a departed repo, or a CLAW with an offline
 *      registration.
 *
 *   `--check-coverage` is its OWN exit rule (#86): only STRUCTURAL drift (a
 *   repo joined/left the roster, or a content facet changed) fails it.
 *   `jobP95Mb`-only drift on a repo WITH its own measurement is reported as an
 *   ADVISORY (`stale-but-self-healing`) and never fails the run — the daily
 *   `--write-coverage` cron repairs it on its own. A repo under the min-runs
 *   floor is skipped from that comparison entirely (#88: "I could not look"
 *   must never read as drift). `--json` carries `{ok, structuralDrift,
 *   advisories}`.
 *
 *   `--write-coverage` and `--allow-shrink`: a write whose repo count falls
 *   below half of what is already committed is REFUSED, file untouched,
 *   unless `--allow-shrink` is passed (#84 part 2) — "wrote a degraded file,
 *   then failed" must be unreachable.
 *
 *   An offline registration on a CLAW fails the run. It is an incident and this
 *   tool exists to make it loud — see the `offline` note at the exit call.
 *   An offline registration on a GUEST is reported and does NOT fail the run:
 *   hokon is a guest and a reserve, its stale rows are nobody's to repair from
 *   here (see MEMORY: "hokon is a guest"), and failing on them made every
 *   `fleet provision` of a DIFFERENT node exit 1 on someone else's drift (#60).
 *   UNMANAGED runners never fail the run either — they are reported and left
 *   alone.
 *
 *   Until 2026-09-26 this block claimed that no offline runner ever failed the
 *   run, while the predicate below failed on every one of them. Read as
 *   evidence, that sentence cost a diagnosis; it is the fourth time in this
 *   repo. If you change the predicate below, change this — and
 *   reconcile-fleet-runners.test.mjs holds the two together.
 */

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripYamlComments } from './lib/yaml-comments.mjs';
import { checkGhReserve } from './lib/gh-reserve.mjs';
import { runnerVarForm } from './lib/runner-var.mjs';
import { autoIncludeDrop, vanishedFromUniverse } from './lib/roster-eligibility.mjs';
import { mayRunRepo } from './lib/placement-rules.mjs';
import {
	loadManifest as readManifest,
	manifestPath,
	runOn,
	runOnSync,
	selectNodes,
} from './lib/fleet-exec.mjs';
import { manifest as manifestFile, siteRoot, stateDir } from './lib/paths.mjs';
import { readRevocations, revokedSets } from '../dist/capability-revocations.js';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import {
	RESERVE_DRIFT_PCT,
	deriveJobReserves,
	reserveDrift,
	shrinkRefusal,
} from './lib/demand-derive.mjs';
import { metricsReadScript, metricsSince, perJobCosts, readOutcome } from './lib/job-metrics.mjs';
import {
	BUILDER_LABEL,
	registrationLabels,
	revokedFor,
	workloadGateContext,
	workloadGatedCapabilities,
} from '../dist/capabilities.js';
import { proofFileStatus, readProofsForCapability } from '../dist/lib/measured.js';
import { fleetOwner, qualifyRepo } from '../dist/lib/fleet-config.js';
import { isGuestNode, mintsOnDemand, standingRepos } from '../dist/lib/node-role.js';
import { RETENTION_DAYS } from '../dist/job-history.js';
import { FAST_LOOP_SECONDS, RECONCILE_EVERY_TICKS } from '../dist/fleet-loop.js';
import { createEmitter } from './lib/emit.mjs';
import { runFleetScript } from './lib/run-fleet-script.mjs';
// The queue-health precedent, imported rather than re-derived — that gate
// measured the transient rate (0.13% of `gh api` calls, 2026-09-07) and one
// number is the point, exactly as `check-fleet-preflight.mjs` and
// `reconcile-runner-identity.mjs` already use it (#80).
import { READ_ATTEMPTS, describeReadFailure } from './lib/queue-health.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = manifestPath();
const TOOLCACHE_RULE = resolve(__dirname, 'lib', 'runner-toolcache.sh');
const SLICE_SCRIPT = resolve(__dirname, 'deploy-runners-slice.mjs');
const THROTTLE_SCRIPT = resolve(__dirname, 'deploy-ci-throttle.mjs');

/**
 * Resolved coverage, written for OTHER tools to read — chiefly mgmt-api's
 * runner-health monitor, which flips each covered repo's `CI_RUNNER` variable
 * during a full claw outage and needs to know which repos those are.
 *
 * It is derived output, but it is committed on purpose: the monitor runs from a
 * checkout and must not need a GitHub round-trip per repo (nor repo-admin on 66
 * repos) just to answer "who is on the fleet". Regenerate with
 * `--write-coverage`; `check:fleet-coverage` fails if it has drifted.
 */
const COVERAGE = manifestFile('fleet-runner-coverage.json');

/** Claws this script is allowed to touch. Anything else is `unmanaged`. */
// hokon joined on 2026-08-24. The docstring above used to say "Touch hokon.
// Never." — that rule existed because CI belonged on the claws and hokon is the
// production host. It is superseded, not ignored: hokon is now the BACKSTOP, and
// a backstop with runners for 2 of 26 repos cannot back anything up. On
// 2026-08-24 two jobs were OOM-killed on claw-2 and the retry had nowhere to go
// but the box that had just killed them.
//
// What made the old rule safe is preserved explicitly rather than by omission:
//   - hokon is a guest: the backstop owns its `hadoku-builder`, so it carries none
//     label in steady state and GitHub cannot schedule onto it until the
//     backstop promotes it.
//   - Its `minFreeMb: 8192` floor protects mgmt-api, the tunnel and the other production services
//     from the CI it now hosts.
//   - Orphan removal only ever targets repos being RETIRED, so nothing here can
//     remove a live runner.

/**
 * Declared nodes, read once at load so `clawOfRunner` can derive ownership
 * instead of matching hand-written name patterns.
 */
const NODE_NAMES = (() => {
	try {
		return readManifest().machines ?? {};
	} catch {
		return {};
	}
})();

/**
 * The nodes this reconciler manages — DERIVED, never enumerated.
 *
 * This was a hardcoded four-name array, and `loadManifest` THREW on any manifest
 * node not in it. So onboarding a claw meant editing the manifest AND this
 * list, and getting only the first produced a hard failure of `fleet:reconcile`
 * with a message telling you to mark the new node `placement: excluded` —
 * exactly the opposite of what you wanted. With three claws arriving that is
 * three chances to hit it.
 *
 * The manifest already IS the declaration of what is managed, and it already has
 * the opt-out the guard was reaching for: `placement: "excluded"`. So the guard
 * was asking a question the file next to it had already answered.
 */
/**
 * Which node owns a runner. What matters to a queued job is that SOME
 * labelled runner on that node can take it, not which unix user supervises
 * it, so every instance on a box satisfies coverage for that box.
 *
 * Returns null for a name it does not recognise, and BOTH call sites fail safe
 * on that: the present-registration scan reports it as `unmanaged` and leaves it
 * alone, and the orphan sweep skips it entirely. That is what keeps a live JIT
 * runner — named `jit-<node>-…`, which this deliberately does not fold —
 * from being deregistered mid-job by a sweep that did not recognise it.
 */
/**
 * The labels a standing registration on `node` carries: `registrationLabels`
 * with the workload gate applied, read from the same `$proof` records the JIT
 * mint's gate reads — so a label a canary has not earned (jdk21 on a node with
 * no passing proof) is withheld here exactly as it is at the mint. Built once.
 */
let gateCtx = null;
function offeredLabels(manifest, node) {
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

const clawOfRunner = (name) => {
	// DERIVED from the declared nodes, never an enumerated suffix list. The
	// previous version hardcoded two incompatible patterns —
	// /^(claw-[123])(-b)?$/ and /^hokon(-b|-c|-d|-tenhands)?$/ — so every new
	// instance or hand-made runner name needed a code change, and the two forms
	// had already drifted apart.
	//
	// A runner belongs to the node whose name it exactly matches, or to the
	// LONGEST declared node name it is prefixed by. Longest wins so that a
	// future `claw-1x` cannot be captured by `claw-1`.
	const names = Object.keys(NODE_NAMES);
	if (names.includes(name)) return name;
	const owner = names
		.filter((m) => name.startsWith(`${m}-`))
		.sort((a, b) => b.length - a.length)[0];
	return owner ?? null;
};

/**
 * Free disk a claw must keep AFTER a registration, in GB. A runner install is
 * ~835 MB before `_work` checkouts start growing, and claw-2 is the binding
 * constraint at 110 GB total. Registering past this trades a CI gap for a full
 * disk, which is strictly worse.
 */
const MIN_FREE_GB_AFTER = 15;
const INSTALL_GB = 1;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
	const i = args.indexOf(f);
	return i === -1 ? null : args[i + 1];
};

const CONFIRM = has('--confirm');
const REMOVE_ORPHANS = has('--remove-orphans');
// Distinct from --remove-orphans on purpose. An ORPHAN is a whole repo that
// retired, so every one of its runners should go. An EXCLUDED pair is a repo
// that is still live and still wanted elsewhere — only this one node should
// stop carrying it. Folding them together would make `excludeRepos` able to
// take a repo's CI away entirely, which is the opposite of what it means.
const REMOVE_EXCLUDED = has('--remove-excluded');
const JSON_OUT = has('--json');
const ONLY_REPO = valueOf('--repo');
const WRITE_COVERAGE = has('--write-coverage');
const CHECK_COVERAGE = has('--check-coverage');
// #84 part 2: a deliberate shrink (a repo archived or dropped from the
// manifest) is real; refusing it forever would make the generator unable to
// ever record a genuine retirement.
const ALLOW_SHRINK = has('--allow-shrink');

// One stdout discipline, shared — see lib/emit.mjs. `emit` is the ONLY write
// to stdout below, which is what makes "print before the JSON" unreachable
// rather than merely absent.
const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;

/**
 * Die, and stay inside the `--json` contract while doing it.
 *
 * `ci:fleet-coverage` parses stdout BEFORE it reads the exit code, so a bare
 * `console.error` + `exit 1` reads to the cron as "the checker broke" rather
 * than as the finding it is. The `--repo` guard below did exactly that; it was
 * unreachable from the cron, which is the only reason it never cost anything.
 */
function failEarly(message) {
	if (JSON_OUT) emitter.emit({ ok: false, error: message });
	else console.error(`\u2717 ${message}`);
	process.exit(1);
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

function ghJson(ghArgs, opts) {
	return JSON.parse(gh(ghArgs, opts));
}

/**
 * POST a JSON body through `gh api`, returning ok/error rather than throwing.
 *
 * Label writes are per runner and a single failure must not abandon the rest of
 * the fleet — one repo whose token lacks admin should cost one line in the
 * report, not the other twenty-five runners' capabilities.
 */
function ghWrite(method, path, body) {
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
const READ_TIMEOUT_MS = 20_000;
/** Long enough for a blip to pass, short enough to be invisible at the measured 0.13% rate. */
const RETRY_DELAY_MS = 1_000;

/** Synchronous sleep, for the one retry that runs outside the async pool below. */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One `gh api repos/<repo>/actions/runners` read, ASYNC — `execFile`,
 * deliberately, not `execFileSync`. `listRunners` below runs inside
 * `pool(probeList, 8, ...)` (one call per covered repo, up to 28 today), and a
 * synchronous child process blocks the WHOLE event loop for as long as it
 * runs — measured in `check-fleet-preflight.mjs`: three `Promise.all`-wrapped
 * `execFileSync` calls of 1s each still took 3s wall-clock. Retried
 * SEQUENTIALLY at up to `READ_ATTEMPTS` x 20s per repo, 28 repos could reach
 * ~20 minutes against this gate's wrapper budgets (240s for `ci:fleet-coverage`,
 * 300s for `check:fleet-coverage --check-coverage`) — exactly the "a cadence
 * safe for one call is fatal for a fanned-out one" trap. `execFile`'s callback
 * does not block, so the pool's 8-wide concurrency is now real: worst case is
 * ceil(repos/8) batches, not one per repo.
 */
function ghRunnersReadOnce(repo, timeoutMs) {
	return new Promise((resolve) => {
		execFile(
			'gh',
			['api', `repos/${repo}/actions/runners`, '--paginate'],
			{ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs },
			(err, stdout, stderr) => {
				if (err) {
					resolve({
						ok: false,
						reason: describeReadFailure(
							{
								killed: err.killed,
								signal: err.signal,
								status: err.code,
								// BOTH STREAMS, joined — not stderr alone. The sync `listRunners`
								// this replaced learned this the hard way: "the earlier fix here
								// recovered stderr ('Command failed' was all that survived), but
								// for `gh api` the body that names the rejected field is on
								// STDOUT, so the reason was still half-missing." A 404/422 from
								// `gh api` prints its JSON body (e.g. `{"message":"Resource not
								// accessible by integration"}`) to STDOUT; stderr often carries
								// only a generic "gh: ..." line. Passing stderr alone into
								// `describeReadFailure` here would silently reopen that exact gap
								// for this one retried call.
								stderr: [stderr, stdout]
									.map((v) => String(v ?? '').trim())
									.filter(Boolean)
									.join(' '),
								message: err.message,
							},
							timeoutMs
						),
					});
					return;
				}
				resolve({ ok: true, out: stdout });
			}
		);
	});
}

/**
 * `gh api` exits non-zero on 404. For runner listings a 404 means "no admin on
 * that repo", which is a real finding — distinguish it from an empty list.
 *
 * Retried per `READ_ATTEMPTS` before it is reported `unreadable` (#80) — the
 * same shape `check-fleet-preflight.mjs` and `reconcile-runner-identity.mjs`
 * already carry for their own `gh` reads. Failing every attempt is still
 * unreadable; `ci:fleet-coverage` fails hard on `unreadable.length` either way
 * (`fleet-coverage-check.ts:160`) — what changes is the reason now says WHY
 * and carries `attempt N/M` instead of a bare error string.
 */
async function listRunners(repo) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		const r = await ghRunnersReadOnce(repo, READ_TIMEOUT_MS);
		if (r.ok) {
			try {
				// --paginate concatenates objects; the fleet is far under one page, but
				// parse defensively so a future 100+ runner repo does not silently break.
				const runners = r.out
					.split('\n')
					.filter(Boolean)
					.flatMap((chunk) => JSON.parse(chunk).runners ?? []);
				return { ok: true, runners };
			} catch (e) {
				return { ok: false, error: `gh returned unparseable JSON: ${e.message}`.slice(0, 200) };
			}
		}
		reason = `${r.reason} (attempt ${attempt}/${READ_ATTEMPTS})`;
		if (attempt < READ_ATTEMPTS) await sleep(RETRY_DELAY_MS);
	}
	return { ok: false, error: reason.slice(0, 200) };
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
function ghRepoListWithRetry(repoListArgs) {
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
function ghApiJsonWithRetry(ghArgs) {
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

function listWorkflowFiles(repo) {
	try {
		const entries = JSON.parse(
			gh(['api', `repos/${repo}/contents/.github/workflows`], { quiet: true })
		);
		return entries.filter((e) => /\.ya?ml$/.test(e.name)).map((e) => e.name);
	} catch {
		return []; // 404 = no workflows directory, or an empty repo
	}
}

function countWorkflows(repo) {
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
function targetsSelfHostedFleet(repo) {
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
const WOLFFM_SCOPE = '@wolffm/';
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
const MAX_PKG_READS = 64;

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
function loadMountedApps() {
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
function repoTree(repo) {
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
function readJsonFile(repo, path) {
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
function deriveFacets(repo, mountedApps) {
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
 * Turn two coverage snapshots into the specific lines that differ.
 *
 * Ordering is reported separately from membership: a list with the same members
 * in a different order is a formatting fix, while a gained or lost repo is a
 * scope change, and collapsing both into "DIFFERS" hides which one happened.
 */
function describeCoverageDrift(disk, live) {
	const out = [];
	const dRepos = disk?.repos ?? [];
	const lRepos = live.repos ?? [];
	const only = (a, b) => a.filter((x) => !b.includes(x));
	for (const r of only(lRepos, dRepos)) out.push(`  + repo ${r} (live, not on disk)`);
	for (const r of only(dRepos, lRepos)) out.push(`  - repo ${r} (on disk, not live)`);
	if (!out.length && JSON.stringify(dRepos) !== JSON.stringify(lRepos)) {
		out.push(`  ~ repo list has the same ${lRepos.length} members in a different order`);
	}

	const dF = disk?.facets ?? {};
	const lF = live.facets ?? {};
	for (const k of only(Object.keys(lF), Object.keys(dF))) out.push(`  + facets for ${k}`);
	for (const k of only(Object.keys(dF), Object.keys(lF))) out.push(`  - facets for ${k}`);
	for (const k of Object.keys(lF)) {
		if (!(k in dF)) continue;
		const a = dF[k];
		const b = lF[k];
		if (JSON.stringify(a) === JSON.stringify(b)) continue;
		const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
		for (const f of keys) {
			if (JSON.stringify(a[f]) === JSON.stringify(b[f])) continue;
			out.push(`  ~ ${k}.${f}: ${JSON.stringify(a[f])} -> ${JSON.stringify(b[f])}`);
		}
	}
	return out.join('\n');
}

/**
 * `jobP95Mb` per covered repo, read off the nodes' job-metrics files.
 *
 * WAVE 3g J2. Admission reserved one hand-set number per NODE; the axis is the
 * REPO (see `deriveJobReserves`), so the figure lives beside the other per-repo
 * facets and `ephemeral-tick.ts` reads it for the queued run's repo.
 *
 * GUESTS ARE SKIPPED, through `selectNodes`. A guest's rows are its standing
 * backstop's, whose `memory.peak` is a unit high-water mark `perJobCosts` nulls
 * anyway — so reading it would cost an ssh to the production host for zero
 * usable rows. The skip is returned, not hidden.
 *
 * "I COULD NOT LOOK" FAILS. A claw whose file cannot be read would leave its
 * jobs out of every repo's p95 — a partial fleet written as the whole one — so
 * any unreadable node returns `unreadable` with its class and reason, and the
 * caller refuses. A node with NO file is a node that has run no hooked job —
 * `readOutcome` calls that `ok` with zero rows, an empty contribution.
 *
 * `previousByRepo` is the COMMITTED roster's own `jobP95Mb` map, read by the
 * caller before this derivation runs — it is what lets a repo under the
 * min-runs floor keep its last measured reserve instead of the fleet p95
 * (#88). See `deriveJobReserves` for the carry-forward rule.
 */
function readJobReserves(manifest, repos, previousByRepo = {}) {
	const { nodes, skippedByRole } = selectNodes(manifest);
	const nowMs = Date.now();
	// The SAME read `fleet job-metrics` makes: the window filtered node-side,
	// the rotated `.1` included, and a read that did not finish classed as a
	// read-error rather than returned as a short file. A second spelling of the
	// read here would miss the next rotation change the first one gets.
	const readScript = metricsReadScript(metricsSince(nowMs, RETENTION_DAYS));
	const rows = [];
	const unreadable = [];
	for (const [node] of nodes) {
		const read = readOutcome(node, runOnSync(node, readScript, { as: 'ci', timeoutMs: 60_000 }));
		if (read.read !== 'ok') {
			unreadable.push({
				node,
				why: `${read.read}${read.errno ? ` ${read.errno}` : ''}: ${read.why}`,
			});
			continue;
		}
		// The loop's node, not the row's own hostname — same rule as
		// `collect-job-metrics.mjs`: a row cannot be attributed to a box it did
		// not come from.
		for (const r of read.rows) rows.push({ ...r, node });
	}
	const derived = deriveJobReserves(perJobCosts(rows).rows, {
		repos,
		nowMs,
		windowDays: RETENTION_DAYS,
		previousByRepo,
	});
	return { ...derived, nodesRead: nodes.length - unreadable.length, unreadable, skippedByRole };
}

/** `facets` with the one CALENDAR-driven key taken out; see `RESERVE_DRIFT_PCT`. */
function withoutReserves(facets) {
	const out = {};
	for (const [repo, f] of Object.entries(facets ?? {})) {
		const rest = Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'jobP95Mb'));
		if (Object.keys(rest).length) out[repo] = rest;
	}
	return out;
}

/** The `jobP95Mb` half of `facets`, as `{ [repo]: {mb, basis, runs} }`. */
function reservesOf(facets) {
	const out = {};
	for (const [repo, f] of Object.entries(facets ?? {})) if (f?.jobP95Mb) out[repo] = f.jobP95Mb;
	return out;
}

// ---------------------------------------------------------------------------
// Desired state
// ---------------------------------------------------------------------------

function loadManifest() {
	const raw = readManifest();
	if (!raw.machines || !Object.keys(raw.machines).length) {
		throw new Error(`${MANIFEST}: machines is required`);
	}
	for (const [name, m] of Object.entries(raw.machines)) {
		if (m.placement === 'excluded') continue;
		// A node is managed BECAUSE the manifest declares it and does not
		// exclude it. What still has to hold is that it is reachable and declares
		// the fields the deployers need — checked below and by fleet:provision —
		// rather than that someone remembered a second list.
		if (!m.labels || !Array.isArray(m.labels)) {
			throw new Error(
				`${MANIFEST}: ${name} declares no \`labels\` array. A node with no labels ` +
					`can be registered but no workflow can ever route to it.`
			);
		}
		if (m.maxRegistrations !== undefined && !Number.isInteger(m.maxRegistrations)) {
			throw new Error(`${MANIFEST}: ${name}.maxRegistrations must be an integer`);
		}
	}
	return raw;
}

/**
 * The nodes a repo should be placed on — DERIVED, never listed per repo.
 *
 * Three rules, in order. Each is a property of the NODE, which is the whole
 * point of the 2026-08-23 restructure: a node's constraints used to be
 * copied into every repo entry it applied to, so nothing could enforce them.
 *
 *   placement:excluded  the reconciler must not register here at all (hokon)
 *   excludeRepos        this node declines this repo, with a stated reason
 *   needs / labels      the repo requires a capability the node must carry
 */
function placementFor(repo, manifest) {
	const allowed = new Set(mayRunRepo(repo, manifest));
	return (
		Object.entries(manifest.machines)
			.filter(([name]) => allowed.has(name))
			// An EPHEMERAL node mints a runner per job, so the only standing
			// registrations it keeps are its resident set — usually empty. This is the
			// single place placement is decided, which is why the rule belongs here
			// rather than as a special case in the apply step: everything downstream,
			// including the orphan sweep that will REMOVE the pairs this drops, reads
			// its answer from this function.
			//
			// The consequence is deliberate and is the whole point of workstream B: a
			// standing registration is a job GitHub can assign WITHOUT ASKING THE
			// DISPATCHER, so leaving them in place while also minting would double the
			// node's real concurrency rather than bound it.
			.filter(([, m]) => m.ephemeral !== true || (m.residentRepos ?? []).includes(repo))
			// An ON-DEMAND GUEST is the same rule for the same reason (#120): it is
			// minted for per job, so a standing registration there is a listener
			// squatting on the production host's memory — the thing the operator
			// retired on 2026-10-19. It keeps only its `standingRepos`, which is
			// hadoku_site's deploy runner. The rest become `excluded` pairs and go
			// under `--confirm --remove-excluded`, idle ones only.
			.filter(([, m]) => !mintsOnDemand(m) || standingRepos(m).includes(repo))
			.map(([name]) => name)
	);
}

/**
 * Resolve the manifest against GitHub into the set of (repo, claw) pairs that
 * SHOULD exist, plus the repos whose coverage should be torn down.
 */
function resolveDesired(manifest, committedRoster = []) {
	const explicit = Object.entries(manifest.repos ?? {});
	const ai = manifest.autoInclude ?? {};

	// THE ROSTER SHRINKING IS ITSELF AN EVENT.
	//
	// autoInclude is a DERIVED set: a repo enters when it starts matching and
	// leaves when it stops. Leaving used to be three bare `continue`s — no record,
	// no report, nothing. That is how a coverage gap closes without being fixed:
	//
	//   08-30  29 repos / 87 pairs  missing=9   <- paged, nothing installed
	//   08-31  26 repos / 78 pairs  missing=0   <- "recovered"
	//
	// Nobody installed a runner. Three repos stopped matching autoInclude and took
	// their own gap out of scope with them, and the gate reported a clean fleet.
	// That is precisely "'I could not look' must never render as 'nothing is
	// wrong'" — one level up from the reads it was written about, because here the
	// tool did not even know there was something it had stopped looking at.
	//
	// A repo in the COMMITTED roster that no longer matches is therefore recorded
	// as a DEPARTURE with the rule that dropped it. The operator's answer is an
	// explicit manifest entry — the same shape hadoku-registry already carries for
	// exactly this reason ("Live infra with only one workflow, so autoInclude's
	// minWorkflows would drop it") — or a deliberate `--write-coverage`.
	const covered = new Set(committedRoster);
	const departed = [];
	const leaves = (name, why) => {
		if (covered.has(name)) departed.push({ repo: name, why });
	};

	const all = ghRepoListWithRetry([
		'repo',
		'list',
		// The manifest's `autoInclude.owner` wins; otherwise the ecosystem's own
		// owner, resolved in ONE place (fleet-config) rather than spelled here.
		ai.owner ?? fleetOwner(),
		'--limit',
		'500',
		'--json',
		'nameWithOwner,isFork,isArchived,pushedAt',
	]);

	// AN EMPTY UNIVERSE IS A FAILURE, NOT AN EMPTY FLEET.
	//
	// `gh` exits non-zero on a real error and execFileSync throws, so a BROKEN
	// call already dies loudly. This is the other shape: a call that SUCCEEDS and
	// returns nothing — a token scoped to no repositories, an owner typo in
	// `autoInclude.owner`, a `gh` that authenticated as somebody else. Every
	// count downstream is then legitimately zero, the summary is all zeros, and
	// `ci:fleet-coverage` reads "every covered repo has a runner" off a fleet
	// nobody looked at.
	//
	// This is CLAUDE.md's rule — "zero repos scanned FAILS; exit 0 with no
	// evidence is a failure, not a pass" — and the guard `check-queue-health` and
	// `check-capability-schema` both already carry. The coverage gate, which is
	// the one that would act on the answer, did not.
	if (!all.length) {
		failEarly(
			`gh repo list returned NO repositories for owner "${ai.owner ?? fleetOwner()}". ` +
				'That is a fleet nobody could look at, not a fleet with nothing to do.'
		);
	}

	const byName = new Map(all.map((r) => [r.nameWithOwner, r]));
	const now = Date.now();

	const desired = new Map(); // repo -> { claws, reason }
	const retired = []; // repos whose coverage may be removed
	const ignored = []; // repos deliberately outside the reconciler's scope

	for (const repo of all) {
		const name = repo.nameWithOwner;
		const entry = manifest.repos?.[name];

		// `ignore` is the third answer, and it has to come first. `skip` means
		// "should have no runners" and therefore MAKES orphans; `ignore` means
		// "whatever it has, leave it and stop telling me". Without this, a dead
		// repo whose leftovers nobody intends to remove reports as an action item
		// forever — and a permanently non-empty report is one nobody reads.
		if (entry?.ignore) {
			ignored.push({ repo: name, why: entry.$why ?? 'ignore: true in the manifest' });
			continue;
		}

		if (entry?.skip) {
			retired.push({ repo: name, why: 'skip: true in the manifest' });
			continue;
		}
		if (repo.isArchived) {
			retired.push({ repo: name, why: 'archived on GitHub' });
			continue;
		}

		// An explicit entry is intent stated by a human and always wins — but it
		// says WHETHER the repo is covered, never WHERE. Where is derived.
		if (entry) {
			desired.set(name, { claws: placementFor(name, manifest), reason: 'manifest' });
			continue;
		}

		// ONE rule, in scripts/lib/roster-eligibility.mjs, returning the REASON.
		// `probe` passes the two expensive answers as functions so the ordering is
		// unchanged: countWorkflows is one API call and targetsSelfHostedFleet is
		// one per workflow file, and only a repo the cheap proxy would drop pays.
		const why = autoIncludeDrop(repo, ai, { countWorkflows, targetsSelfHostedFleet }, now);
		if (why) {
			leaves(name, why);
			continue;
		}

		desired.set(name, { claws: placementFor(name, manifest), reason: 'autoInclude' });
	}

	// A manifest entry naming a repo that no longer exists is a typo or a
	// deletion; either way say so rather than silently dropping it.
	for (const [name] of explicit) {
		if (!byName.has(name)) {
			retired.push({ repo: name, why: 'named in the manifest but not found under the owner' });
		}
	}

	// A covered repo the loop above never visited, because it is no longer in the
	// list at all. See `vanishedFromUniverse` (#135).
	departed.push(
		...vanishedFromUniverse(committedRoster, byName, lookupRepo, new Set(explicit.map(([n]) => n)))
	);

	return { desired, retired, ignored, departed, allRepos: byName };
}

/**
 * One repo by name. GitHub follows a rename, so `nameWithOwner` is the CURRENT
 * name. A 404 is an answer and is not retried; anything else is.
 */
function lookupRepo(name) {
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

// ---------------------------------------------------------------------------
// Actual state
// ---------------------------------------------------------------------------

async function pool(items, size, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i], i);
			}
		})
	);
	return out;
}

// ---------------------------------------------------------------------------
// The claw side
// ---------------------------------------------------------------------------

/**
 * A GUEST IS DELIBERATELY IN SCOPE HERE — `includeGuests` below, on purpose.
 *
 * A guest lends the fleet a registration and is otherwise none of the fleet
 * chain's business (operator, 2026-09-14). THIS FILE IS WHERE THAT REGISTRATION
 * COMES FROM, so it is the one command the exemption is written for: the guest
 * is the fleet's BACKSTOP, the only declared machine that is neither
 * `ephemeral: true` nor `placement: excluded`, and since the claws went all-JIT
 * it holds the standing registration for every covered repo.
 *
 * AN ON-DEMAND GUEST (#120) is narrowed by `placementFor` to its
 * `standingRepos`, which is a deliberate retirement, not this hazard: the
 * dispatcher mints for it, and the narrowing reads the same manifest key that
 * turns the minting on.
 *
 * SKIPPING IT WOULD NOT BE CONSERVATIVE, IT WOULD BE DESTRUCTIVE. `placementFor`
 * is the single place placement is decided, and the orphan sweep REMOVES every
 * (repo, node) pair placement drops. Filtering the guest out here would mark all
 * ~28 of its registrations orphaned, and the next `--confirm` — which runs from
 * `ci:fleet-coverage` — would deregister the fleet's entire backstop and report
 * a successful reconcile. That is the exact shape of failure the guest rule
 * exists to prevent, arrived at from the other direction.
 */
const INCLUDE_GUESTS = true;

/**
 * Run a script on a node. LOCAL when it is this host — `ssh hokon` from hokon
 * is refused (no sshd on 22), and hokon is now a managed node, so a
 * blind ssh would make every hokon registration fail with a connection error
 * that reads like the box is down.
 */
async function ssh(claw, script) {
	const r = await runOn(claw, script, {
		as: 'admin',
		timeoutMs: 15 * 60_000,
		maxBuffer: 8 * 1024 * 1024,
		includeGuests: INCLUDE_GUESTS,
	});
	return { ok: r.ok, stdout: r.stdout, stderr: r.stderr || (r.error ?? '') };
}

/** Same slug rule as register-fleet-runner.sh, so layouts stay comparable. */
const repoSuffix = (repo) =>
	repo
		.split('/')
		.pop()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-');

function currentRunnerVersion() {
	const tag = gh(['api', 'repos/actions/runner/releases/latest', '-q', '.tag_name']).trim();
	if (!tag) throw new Error('could not resolve the latest actions/runner release');
	return tag.replace(/^v/, '');
}

/**
 * Registration, as `openclaw`, with a user systemd unit.
 *
 * The runner version is resolved fresh per run and the tarball cache is keyed
 * by it — both lessons from `register-fleet-runner.sh`, where a pinned v2.319.1
 * meant every new registration extracted whatever the claw was provisioned with
 * and failed its first job until self-update caught up. GitHub hard-deprecates
 * old runners, so a stale-enough cache eventually cannot connect at all.
 */
function registerScript({ repo, claw, version, token, labels, start }) {
	const suffix = repoSuffix(repo);
	// ENABLED, NOT STARTED, on a claw (#1). A unit's first start decides its
	// cgroup, so starting it here put it in app.slice — no group ceiling — and a
	// runner started before its .env carries the throttle hook has no
	// concurrency limit and no shared tool cache. The caller writes both through
	// the drivers and only then starts it; see provisionBeforeStart. A guest
	// (start=true) is out of both drivers' scope and starts here, as it always did.
	const startBlock = start
		? 'systemctl --user enable --now "$UNIT"\nsleep 3\nsystemctl --user is-active "$UNIT"'
		: 'systemctl --user enable "$UNIT"';
	return `
set -euo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

mkdir -p "$HOME/runners"
DIR="$HOME/runners/actions-runner-${suffix}"
CACHE_DIR="$HOME/.cache/gh-runner"
CACHE="$CACHE_DIR/runner-${version}.tar.gz"
UNIT="actions-runner-${suffix}.service"
UNIT_PATH="$HOME/.config/systemd/user/$UNIT"

free_gb=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc '0-9')
if [ "$free_gb" -lt $((${MIN_FREE_GB_AFTER} + ${INSTALL_GB})) ]; then
  echo "REFUSED: only \${free_gb}G free on $(hostname); need $((${MIN_FREE_GB_AFTER} + ${INSTALL_GB}))G" >&2
  exit 3
fi

mkdir -p "$CACHE_DIR"
# Download to a TEMP file, verify it is actually a gzip, and only then publish it
# into the cache. \`curl -sSL -o\` happily writes an HTTP error body to disk and
# exits 0, so a transient GitHub hiccup cached a 54 KB HTML page as
# "runner-2.336.0.tar.gz" on 2026-08-24. Because the cache check is
# \`[ ! -f "$CACHE" ]\`, that one bad download then poisoned every subsequent
# registration on the box: all 24 failed with "gzip: stdin: not in gzip format"
# and 0 were installed. Same shape as a CF challenge page being fed to jq.
if [ ! -s "$CACHE" ] || ! gzip -t "$CACHE" 2>/dev/null; then
  rm -f "$CACHE_DIR"/runner-*.tar.gz
  echo "[cache] downloading runner v${version}"
  TMP="$CACHE.part.$$"
  # -f: fail on 4xx/5xx instead of saving the error page. --retry: the failure
  # that started this was transient.
  if ! curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors -o "$TMP" \\
    "https://github.com/actions/runner/releases/download/v${version}/actions-runner-linux-x64-${version}.tar.gz"; then
    rm -f "$TMP"
    echo "REFUSED: could not download runner v${version}" >&2
    exit 4
  fi
  if ! gzip -t "$TMP" 2>/dev/null; then
    head -c 120 "$TMP" | tr -d '\\0' >&2 || true
    rm -f "$TMP"
    echo "" >&2
    echo "REFUSED: downloaded runner v${version} is not a gzip (see the first bytes above)" >&2
    exit 4
  fi
  mv "$TMP" "$CACHE"
else
  echo "[cache] reusing $CACHE"
fi

# Test for the BINARY, not the directory. \`mkdir -p\` succeeds and \`tar\` then
# fails, so a failed install leaves an EMPTY directory behind — and a
# \`[ ! -d "$DIR" ]\` guard reads that as "already installed", skips extraction,
# and dies on \`./config.sh: No such file or directory\`. That is what every one
# of the 24 hokon registrations hit on the retry after the poisoned-cache
# failure: the first run created the dirs, the second refused to fill them.
# Checking for the thing you are about to RUN makes the retry self-healing.
if [ ! -x "$DIR/config.sh" ]; then
  mkdir -p "$DIR"
  tar xzf "$CACHE" -C "$DIR"
fi
if [ ! -x "$DIR/config.sh" ]; then
  echo "REFUSED: $DIR has no config.sh after extraction" >&2
  exit 5
fi
cd "$DIR"

./config.sh \\
  --url "https://github.com/${repo}" \\
  --token "${token}" \\
  --labels ${labels} \\
  --name "${claw}" \\
  --unattended --replace

${readFileSync(TOOLCACHE_RULE, 'utf8')}
# MERGE, never truncate. This file has THREE writers — config.sh seeds LANG,
# deploy-ci-throttle appends ACTIONS_RUNNER_HOOK_JOB_STARTED, and this sets
# RUNNER_TOOL_CACHE — and it used to be written with \`>\`, so registering or
# re-registering a runner silently deleted the throttle hook from a live
# node. Nothing failed at the time: Runner.Listener reads .env once at start,
# so the runner kept working unthrottled-on-paper until its next restart, and
# check:throttle would have blamed a node nobody had touched.
ENV_FILE="$DIR/.env"
if [ -f "$ENV_FILE" ]; then
  grep -v '^RUNNER_TOOL_CACHE=' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || : > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
fi
echo "RUNNER_TOOL_CACHE=$TOOLCACHE" >> "$ENV_FILE"
echo "[toolcache] $(id -un) -> $TOOLCACHE"
echo "/usr/local/bin:/usr/bin:/bin:/usr/games" > "$DIR/.path"

# REFUSE to become a second supervisor for this runner directory.
#
# register-fleet-runner.sh installs a SYSTEM unit (svc.sh -> runsvc.sh); this
# script installs a USER unit (run.sh). Both drive the same directory and the
# same GitHub registration, and neither used to look for the other. On
# 2026-08-18 both ran within an hour for study, filetransfer and privatebin, on
# all three claws — nine double-supervised runners.
#
# Two listeners race for one session: one wins, the other burns 240s on
# SessionConflictException and exits 5 ("stop the service, no retry needed").
# Any job landing in the overlap shares _diag and _work/_temp with a second
# process, which is what corrupted a hadoku-study run on 2026-08-20
# ("_diag/pages/... already exists", "Missing file at path: ...save_state_*").
# The survivor then runs unsupervised while GitHub still reports it ONLINE, so
# the offline alert is structurally blind to it.
#
# Skipping is the safe direction: a system unit already covers this repo, so
# refusing costs nothing, while installing costs a corrupted job.
if systemctl list-units 'actions.runner.*' --all --no-pager --no-legend 2>/dev/null \
   | awk '{print $1}' \
   | while read -r u; do systemctl show "$u" -p ExecStart --value 2>/dev/null | grep -q "$DIR/" && echo hit; done \
   | grep -q hit; then
  echo "SKIP: $DIR already has a system-level unit — refusing to add a second supervisor" >&2
  exit 0
fi

mkdir -p "$HOME/.config/systemd/user"
cat > "$UNIT_PATH" <<UNIT_EOF
[Unit]
Description=GitHub Actions runner (${repo})
After=network-online.target

[Service]
ExecStart=%h/runners/actions-runner-${suffix}/run.sh
WorkingDirectory=%h/runners/actions-runner-${suffix}
Restart=always
RestartSec=5
# NOT the stock KillMode=process, which signals only run.sh and never reaps its
# children: a stop that outruns TimeoutStopSec then leaves a Runner.Listener
# alive holding the GitHub session, while the restarted unit loops on
# SessionConflictException and GitHub reports the runner ONLINE throughout.
# mixed keeps the graceful path identical and SIGKILLs any survivor.
KillMode=mixed
# Exit 5 IS that session conflict — the runner's deliberate "another listener
# owns this registration, do not retry". Restarting into it loops forever.
RestartPreventExitStatus=5
KillSignal=SIGTERM
TimeoutStopSec=5min

[Install]
WantedBy=default.target
UNIT_EOF
echo "UNIT-WRITTEN $UNIT"

systemctl --user daemon-reload
${startBlock}
`;
}

/**
 * Start a unit whose slice drop-in and throttle env are already on disk, and
 * prove where it landed.
 *
 * THE KERNEL, NOT THE CONFIG. `Slice=` reads right the moment the drop-in
 * exists; only `ControlGroup` says where the processes went. A unit that
 * comes up outside the slice FAILS the registration here, rather than waiting
 * for check:slice to find it the next night.
 *
 * THE ONE-SECOND SLEEP is for check:throttle's staleness rule, which calls a
 * listener stale when its `.env` mtime is NEWER than the listener's start,
 * both in whole seconds. The throttle step wrote that `.env` moments ago, and
 * a start inside the same second can read as one second EARLIER than the
 * write. Then a correctly provisioned runner reports "written but not loaded".
 */
function startScript({ repo, sliceName }) {
	const unit = 'actions-runner-' + repoSuffix(repo) + '.service';
	return `
set -euo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
UNIT="${unit}"
sleep 1
systemctl --user daemon-reload
systemctl --user start "$UNIT"
sleep 3
systemctl --user is-active "$UNIT"
cg=$(systemctl --user show "$UNIT" -p ControlGroup --value)
parent=\${cg%/*}
parent=\${parent##*/}
if [ "$parent" != "${sliceName}" ]; then
  echo "BORN-OUTSIDE-SLICE $UNIT effective=\${parent:-none} want=${sliceName}" >&2
  exit 6
fi
echo "STARTED $UNIT in ${sliceName}"
`;
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
async function provisionBeforeStart(claw) {
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

/**
 * Tear one (repo, node) registration down, whichever systemd manager owns it.
 *
 * TWO MANAGERS, AND THIS KNEW ABOUT ONE. Until 2026-09-01 the only unit this
 * touched was the USER unit `actions-runner-<suffix>.service`. But a runner
 * installed with `sudo ./svc.sh install` is a SYSTEM unit named
 * `actions.runner.<owner>-<repo>.<runner>.service` — GitHub's own naming, which
 * keeps the repo's original case where the directory is lowercased. claw-1
 * carried 24 of those.
 *
 * The consequence, measured that day on claw-1: `systemctl --user disable`
 * matched nothing and said so into `|| true`, the service kept running,
 * `config.sh remove` refused because the runner was still installed as a
 * service, and the old code then deleted the directory ANYWAY on its way out.
 * 3 removed, 21 failed, and 18 services left running with their
 * WorkingDirectory deleted underneath them — 7 of them still `online`, so
 * GitHub could hand them a job that had nowhere to run.
 *
 * TWO RULES COME OUT OF THAT, and both are load-bearing:
 *
 *   1. Ask which manager owns it. A system unit is stopped through `svc.sh`,
 *      which is the only thing that knows how to uninstall what it installed.
 *   2. **NEVER delete the directory when deregistration fails.** That single
 *      `rm -rf` is what turned a retryable failure into an unrecoverable one:
 *      with the directory intact the next run simply tries again, and without
 *      it the only remedy left is the REST API and an operator.
 */
function removeScript({ repo, token, guest = false, runnerId = null, deregistered = false }) {
	const suffix = repoSuffix(repo);
	// THE INSTALL IS FOUND BY THE REGISTRATION IT HOLDS (#123), not only by the
	// repo's CURRENT name. A rename leaves the install under the OLD name:
	// WolffM/hadoku-printTool became hadoku-craft, and hokon's install stayed at
	// actions-runner-hadoku-printtool with a .runner naming the old URL, while
	// GitHub listed the registration under hadoku-craft. Deriving the dir from
	// the current name found nothing and reported NOT_OURS. agentId in .runner
	// is the registration id and survives a rename, so it is the key.
	const id = Number.isInteger(runnerId) ? String(runnerId) : '';
	// deregistered: the controller already deleted the registration through
	// the REST API (the fallback for a config.sh remove that a rename turns into
	// a 404 — the runner API does not follow the redirect). Only the local
	// install is left to remove, so config.sh remove is skipped.
	const deregister = deregistered
		? 'echo "registration already deleted by id through the API; removing the install only"'
		: [
				'# NOT || true. Deregistering is the half that matters: a registration left',
				'# behind is a runner GitHub will SCHEDULE ONTO with nothing listening. On',
				'# 2026-08-29 this swallowed ten consecutive failures on claw-3 and reported',
				'# every one as removed, so the next reconciler run was the only thing that',
				'# noticed.',
				'if ! ./config.sh remove --token "' + token + '"; then',
				'  # THE DIRECTORY STAYS. See the removeScript header: deleting it here is what',
				'  # made the claw-1 failures unrecoverable. Intact, the next run retries; deleted,',
				'  # only the REST API can finish the job.',
				'  echo "DEREGISTER_FAILED: the GitHub registration remains; $DIR was left intact so a retry can work" >&2',
				'  exit 6',
				'fi',
			].join('\n');
	// A GUEST IS NEVER ASKED FOR SUDO (operator, 2026-09-14) — not even the
	// non-prompting kind. INCLUDE_GUESTS keeps the guest's backstop registrations
	// in scope, so a retired repo's registration there IS a removal target, and a
	// system-installed one would have reached for passwordless root on the
	// production host. On a guest the system path stops at NEEDS_ROOT and hands
	// the operator the command, which is what it already does on a claw with no
	// passwordless sudo; the user-unit path needs no root and is unchanged.
	const rootStep = guest
		? '  echo "NEEDS_ROOT: $SYS_UNIT is a system service on a GUEST; the fleet never asks a guest for sudo (DIR=$DIR)" >&2\n' +
			'  exit 5'
		: '  if ! sudo -n true 2>/dev/null; then\n' +
			'    echo "NEEDS_ROOT: $SYS_UNIT is a system service and passwordless sudo is unavailable (DIR=$DIR)" >&2\n' +
			'    exit 5\n' +
			'  fi\n' +
			'  ( cd "$DIR" && sudo -n ./svc.sh stop && sudo -n ./svc.sh uninstall ) >/dev/null 2>&1 || {\n' +
			'    echo "NEEDS_ROOT: svc.sh could not stop/uninstall $SYS_UNIT (DIR=$DIR)" >&2\n' +
			'    exit 5\n' +
			'  }';
	// owner-repo, original case: WolffM/hadoku-printTool installs as
	// actions.runner.WolffM-hadoku-printTool.claw-1.service. The runner name is
	// the trailing field, so it is globbed rather than guessed — a node whose
	// runner name is not its hostname is still found.
	//
	// Concatenation, NOT a template literal, and NO BACKTICKS ANYWHERE IN THIS
	// FUNCTION outside the returned script. The backtick guard below reads
	// everything between the first and last backtick of this function body, so a
	// second literal — or a backtick in a comment like this one used to have —
	// puts unescaped backticks inside the region it scans and blinds it. That
	// guard has caught a truncated script in this file twice. Keeping it sharp is
	// worth the plainer prose.
	const sysGlob = 'actions.runner.' + repo.replace('/', '-') + '.*.service';
	return `
set -uo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
# ~/runners/ since 2026-10-09; a runner not yet moved is still found where it was.
DIR="$HOME/runners/actions-runner-${suffix}"
[ -d "$DIR" ] || DIR="$HOME/actions-runner-${suffix}"
# Not under the current name: look for the install holding this registration.
RUNNER_ID="${id}"
if [ ! -d "$DIR" ] && [ -n "$RUNNER_ID" ]; then
  for f in "$HOME"/runners/*/.runner "$HOME"/actions-runner-*/.runner; do
    [ -f "$f" ] || continue
    if tr -d ' \t\r\n' < "$f" | grep -q '"agentId":'"$RUNNER_ID"'[,}]'; then
      DIR=$(dirname "$f")
      echo "found registration $RUNNER_ID at $DIR (not under the repo's current name)"
      break
    fi
  done
fi
# The unit is named after the directory it runs, so a renamed install's unit
# carries the old name too.
USER_UNIT="$(basename "$DIR").service"

if [ ! -d "$DIR" ]; then
  echo "NOT_OURS: no install of this registration in $HOME (no actions-runner-${suffix}, no .runner with agentId \${RUNNER_ID:-?})" >&2
  exit 4
fi

# Which manager actually holds it. --all so a loaded-but-inactive unit still
# counts: it is installed either way, and svc.sh is what removes the install.
SYS_UNIT=$(systemctl list-units --all --no-legend "${sysGlob}" 2>/dev/null | awk '{print $1}' | head -1)
OWNER="none"

if [ -n "$SYS_UNIT" ]; then
  if [ ! -x "$DIR/svc.sh" ]; then
    echo "NEEDS_ROOT: $SYS_UNIT is a system service but $DIR/svc.sh is missing (DIR=$DIR)" >&2
    exit 5
  fi
  # -n: never prompt. An interactive sudo would hang this ssh forever, and the
  # reconciler runs unattended on a cron. On a guest there is no sudo at all.
${rootStep}
  OWNER="system:$SYS_UNIT"
elif systemctl --user cat "$USER_UNIT" >/dev/null 2>&1; then
  systemctl --user disable --now "$USER_UNIT" >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/$USER_UNIT"
  systemctl --user daemon-reload || true
  OWNER="user:$USER_UNIT"
fi

cd "$DIR"
# THE BREADCRUMB, written BEFORE the deregistration that deletes .runner.
#
# Removal is not atomic and cannot be made so: it deregisters over the network,
# then deletes the tree. Interrupted between those two - a dropped ssh, a
# timeout on the slowest call in the script - it leaves a directory with the
# 678MB package intact, no .runner, no unit and no GitHub registration.
#
# That state was UNATTRIBUTABLE and therefore permanent. Every tool that could
# have found it keys on the record the deregistration just deleted: the
# reconciler sees no registration to remove, nothing can tell which repo the
# directory belonged to, and clean-runner-debris only sweeps _update/_diag/stale
# version dirs - it reported "stale 0.00 GB" on claw-1 while 3.1 GB of these sat
# beside it (printtool, oss-issue-aggregator, vibedispatch, all three long gone
# from the roster).
#
# This file is what survives that window and names the repo, so the sweep can
# finish the job. It is deliberately NOT removed on the failure path: a failed
# deregister leaves .runner in place too, and .removing beside a live .runner
# means "a retry is owed", which is exactly what the next run does.
printf 'repo=%s\nstarted=%s\n' "${repo}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/.removing" 2>/dev/null || true
${deregister}
cd "$HOME"
rm -rf "$DIR"
# The unit's drop-in dir goes with it (#126). runners-slice-install.sh writes
# 10-runners-slice.conf there (hokon's also held a supervision.conf), and
# removing only the unit file left 28 orphan dirs on hokon on 2026-10-19
# for the toolchain check to hand to an operator. Unconditional on OWNER: a
# unit removed by an earlier, interrupted run leaves its drop-ins just the same.
rm -rf "$HOME/.config/systemd/user/$USER_UNIT.d"
echo "removed $DIR ($OWNER)"
`;
}

function mintToken(repo, kind) {
	const path =
		kind === 'remove'
			? `repos/${repo}/actions/runners/remove-token`
			: `repos/${repo}/actions/runners/registration-token`;
	// Minted per (repo × claw) at the moment of use: these are single-use and
	// expire in an hour, so batch-minting them up front would hand out tokens
	// that are dead before the run reaches them.
	return gh(['api', '-X', 'POST', path, '-q', '.token']).trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	// The heaviest GitHub reader in the fleet (~440 calls with --check-coverage):
	// under the shared reserve it is not run (#9).
	const reserve = checkGhReserve('reconcile');
	if (!reserve.ok) failEarly(reserve.reason);
	const manifest = loadManifest();
	log(`Manifest: ${MANIFEST}`);
	log(`Mode: ${CONFIRM ? 'APPLY' : 'DRY RUN (no side effects)'}\n`);

	// A node a human powered off is EXPECTED down. Its registrations go OFFLINE
	// along with it — same question `reconcile-runner-identity.mjs` already asks
	// of a registration, answered here too so draining a node for maintenance
	// does not page this reconciler as well. See lib/expected-down.mjs.
	const drains = readDrains();

	// The COMMITTED roster, read ONCE, before anything derives a live one. It is
	// the only record of what the fleet believed it covered last time, so it is
	// the only thing a departure can be measured against, the source of #88's
	// last-measured `jobP95Mb` carry-forward, and (for CHECK_COVERAGE) the other
	// half of the staleness comparison — reading it three separate times risked
	// a concurrent `--write-coverage` making those three reads disagree.
	// Unreadable is treated as "no baseline" rather than "nothing departed":
	// with no baseline every comparison reports nothing, which is honest — it
	// must not manufacture departures (or drift) out of a missing file, nor
	// claim a clean roster it never read.
	let onDiskCoverage = null;
	try {
		onDiskCoverage = JSON.parse(readFileSync(COVERAGE, 'utf8'));
	} catch {
		/* no committed baseline yet — reported as none, never as clean */
	}
	const committedRoster = onDiskCoverage?.repos ?? [];
	const { desired, retired, ignored, departed } = resolveDesired(manifest, committedRoster);

	// --- coverage file -----------------------------------------------------
	// Derived purely from desired state, so it is correct on a dry run too — but
	// only WRITTEN when asked, because `--dry-run means zero side effects` is a
	// contract worth more than the convenience.
	const repoList = [...desired.keys()].sort();

	// Facets cost one tree call per repo plus a package.json read, so they are
	// derived only when the file is actually being written or checked — a plain
	// reconcile run must not pay for them.
	let facets;
	if (WRITE_COVERAGE || CHECK_COVERAGE) {
		const { mounted, reason: mountedReason } = loadMountedApps();
		// A failed registry read is not "zero apps mounted" — it is "I could not
		// look", and it taints EVERY repo's `microFrontend` facet at once (send-back,
		// 2026-10-04), so it is collected into the same refusal `deriveFacets`'s own
		// per-repo failures feed below, rather than silently defaulting to an empty
		// Set.
		const unreadableFacets = mountedReason
			? [`scripts/child-apps.json unreadable — ${mountedReason}`]
			: [];
		// The COMMITTED reserve map, read once above — the evidence #88 needs to
		// tell "never measured" (fall to the fleet p95) from "measured before,
		// quiet now" (keep the last figure).
		const previousReserves = reservesOf(onDiskCoverage?.facets);
		// Read BEFORE the tree calls: an unreadable node refuses the whole write
		// or check, and there is no point spending a GitHub call per repo first.
		const reserves = readJobReserves(manifest, repoList, previousReserves);
		for (const s of reserves.skippedByRole) log(`jobP95Mb: skipped ${s.node} (${s.why})`);
		if (reserves.unreadable.length) {
			failEarly(
				`fleet-runner-coverage.json: cannot derive jobP95Mb — ${reserves.unreadable.length} ` +
					`node(s) unreadable, and a p95 without their jobs is not the fleet's: ` +
					reserves.unreadable.map((u) => `${u.node}: ${u.why}`).join('; ')
			);
		}
		if (!reserves.byRepo) failEarly(`fleet-runner-coverage.json: ${reserves.reason}`);
		const reserveEntries = Object.entries(reserves.byRepo);
		const measured = reserveEntries.filter(([, r]) => r.basis === 'measured');
		const kept = reserveEntries.filter(([, r]) => r.basis === 'kept-last-measured');
		// NEVER MEASURED, not merely quiet — #88's whole point is that these two
		// are different repos. A repo with its OWN evidence (a true percentile, or
		// a capped floor) never lands here even on a 0-run night; see `kept` below.
		const neverMeasured = reserveEntries
			.filter(([, r]) => r.basis === 'fleet-p95')
			.map(([repo, r]) => `${repo} (${r.runs} run${r.runs === 1 ? '' : 's'})`);
		log(
			`jobP95Mb: ${measured.length} repo(s) measured, ${kept.length} kept from last ` +
				`measurement, fleet p95 ${reserves.fleetP95Mb}MB over ${reserves.fleetRuns} ` +
				`per-job peaks from ${reserves.nodesRead} node(s), last ${reserves.windowDays} ` +
				`days, min ${reserves.minRuns} runs` +
				(reserves.undated ? `, ${reserves.undated} undated row(s) excluded` : '')
		);
		// SAID PER REPO, as the brief asks: a fallback figure is the fleet's, not
		// the repo's, and a reader of the roster must be able to tell which.
		if (neverMeasured.length) {
			log(`jobP95Mb: on the fleet p95, never measured: ${neverMeasured.join(', ')}`);
		}
		// #88's exact report line: a repo under the min-runs floor that HAS a
		// measurement of its own keeps it rather than falling to the fleet figure.
		for (const [repo, r] of kept) {
			log(
				`jobP95Mb: ${repo}: kept last measured ${r.measuredMb}MB` +
					(r.measuredAt ? ` from ${r.measuredAt}` : ' (measured-at date not on record)') +
					`; ${r.runs} run${r.runs === 1 ? '' : 's'} in ${reserves.windowDays}d`
			);
		}
		// A RESERVATION BUILT FROM CAPPED RUNS IS A LOWER BOUND (#76). Named here
		// for the same reason the fallback list is: `deriveJobReserves` already
		// raised `mb` to the highest cap the repo's own runs hit and set
		// `lowerBound: true`, but that number still LOOKS like an ordinary measured
		// figure in the roster unless a reader is told it is a floor, not a
		// ceiling — which is exactly how brave-quartet's 3,091 MB read as exact
		// before this.
		const lowered = reserveEntries
			.filter(([, r]) => r.lowerBound === true)
			.map(([repo, r]) => `${repo} (${r.mb}MB)`);
		if (lowered.length) log(`jobP95Mb: lower bound only (a run hit a cap): ${lowered.join(', ')}`);
		facets = {};
		for (const repo of repoList) {
			const { facets: repoFacets, unreadable } = deriveFacets(repo, mounted);
			if (unreadable) unreadableFacets.push(unreadable);
			facets[repo] = { ...repoFacets, jobP95Mb: reserves.byRepo[repo] };
		}
		// REFUSE BEFORE EITHER BRANCH READS `facets`, not just before the write:
		// `--check-coverage` against a degraded live derivation would report a
		// MISSING content facet as structural drift — a false finding caused by
		// this run's own read failure, not by anything that actually changed
		// (send-back, 2026-10-04). "Compute fully, check completeness, THEN act"
		// applies to a check exactly as much as to a write.
		if (unreadableFacets.length) {
			failEarly(
				`fleet-runner-coverage.json: cannot derive facets — ${unreadableFacets.length} ` +
					`read(s) failed, and a roster missing their content facets is not the fleet's: ` +
					unreadableFacets.join('; ')
			);
		}
	}

	const coverage = {
		$comment:
			'GENERATED by reconcile-fleet-runners.mjs --write-coverage. Do not hand-edit. ' +
			'`repos` is consumed by mgmt-api runner-health (CI_RUNNER hosted fallback) and the ' +
			'repo-policy reconciler. `facets` is what each repo IS, so fleet checkers ' +
			'(check-header-fleet, check-tier-fleet, check-mf-externals) filter this ONE roster ' +
			'instead of keeping their own membership arrays — which had already drifted apart. ' +
			"`facets[repo].jobP95Mb` is the p95 of that repo's per-job peak memory over the " +
			"job-metrics window, read by JIT admission. `basis` is `measured` (this repo's own " +
			'percentile this run), `kept-last-measured` (under the min runs THIS run, but ' +
			'measured before — #88 — with `measuredMb`/`measuredAt` carrying the original figure ' +
			"and `mb` never lower than today's fleet p95), or `fleet-p95` (never measured; `mb` " +
			'is the fleet figure). `lowerBound: true` (additive; absent means false) means at ' +
			'least one contributing run was itself capped — OOM-killed, or pinned at a node ' +
			'ceiling — so `mb` is a FLOOR raised to the highest cap seen, never an exact ' +
			'measurement; admission must not treat it as a number the job will stay under (#76).',
		repos: repoList,
		...(facets ? { facets } : {}),
	};
	if (CHECK_COVERAGE) {
		// Read once, above, as `onDiskCoverage` — reused here rather than read a
		// second time, so a concurrent `--write-coverage` cannot make this
		// comparison disagree with the one the reserve derivation already saw.
		const onDisk = onDiskCoverage;
		// FACETS are compared too, not just the repo list. Three fleet checkers
		// now derive their membership from them, so a stale facet map silently
		// drops a repo out of scope — which is the exact failure this whole
		// roster replaced. Checking only `repos` would have left that hole open
		// one layer down.

		const sameRepos = JSON.stringify(onDisk?.repos ?? null) === JSON.stringify(coverage.repos);
		// Two comparisons, because the facets are two kinds of fact. The ones
		// derived from a repo's CONTENTS change with a commit and compare exactly;
		// `jobP95Mb` changes with the calendar — see `RESERVE_DRIFT_PCT` — and is
		// handled entirely separately, below, as an ADVISORY (#86).
		const diskFacets = onDisk?.facets ? withoutReserves(onDisk.facets) : null;
		const sameFacets =
			JSON.stringify(diskFacets) === JSON.stringify(withoutReserves(coverage.facets));

		// STRUCTURAL drift (#86 ask 1): a repo joined or left the roster, or a
		// content facet (`wolffmConsumer`, `uiApp`, `microFrontend`) changed. A
		// daily `--write-coverage` cannot be assumed to be pending for this —
		// it is real, and still fails the gate.
		const structuralLines = [];
		if (!sameRepos || !sameFacets) {
			// Name WHAT differs, never just how many. This message used to print
			// `repos on disk: 26  live: 26  <-- DIFFERS`, which is a count telling
			// you the counts match while the sets do not — the reader is left with
			// nothing to act on and no way to judge whether the drift is expected.
			// Both real cases here (two repos picking up @wolffm/cdn-client, and a
			// mis-sorted repo list) are invisible at that resolution.
			const described = describeCoverageDrift(onDisk && { ...onDisk, facets: diskFacets ?? {} }, {
				...coverage,
				facets: withoutReserves(coverage.facets),
			});
			if (described) structuralLines.push(described);
		}

		// MEASURED drift (#86 ask 2/3): `jobP95Mb` only. `reserveDrift` already
		// skips any repo under the min-runs floor on either side — "I could not
		// look" never reads as drift — so what is left here is a REAL measured
		// repo whose figure moved, which a daily `--write-coverage` repairs on its
		// own. Always advisory, never a reason to fail this gate.
		const advisories = reserveDrift(reservesOf(onDisk?.facets), reservesOf(coverage.facets)).map(
			(l) => l.trim()
		);

		if (structuralLines.length) {
			console.error(`fleet-runner-coverage.json is stale.\n${structuralLines.join('\n')}`);
			console.error(`  fix: fleet reconcile --write-coverage`);
			for (const a of advisories) console.error(`  (advisory, stale-but-self-healing) ${a}`);
			if (JSON_OUT) emitter.emit({ ok: false, structuralDrift: structuralLines, advisories });
			process.exit(1);
		}
		for (const a of advisories) {
			log(`fleet-runner-coverage.json: stale-but-self-healing (advisory): ${a}`);
		}
		log(
			`fleet-runner-coverage.json is current (${coverage.repos.length} repos, ` +
				`${Object.keys(withoutReserves(coverage.facets)).length} with content facets` +
				(advisories.length
					? `, ${advisories.length} measured advisory(ies) — ${RESERVE_DRIFT_PCT}% band)`
					: `, jobP95Mb within ${RESERVE_DRIFT_PCT}% for all ${Object.keys(reservesOf(coverage.facets)).length})`)
		);
		if (JSON_OUT) emitter.emit({ ok: true, structuralDrift: [], advisories });
		process.exit(0);
	}
	if (WRITE_COVERAGE) {
		// THE SHRINK FLOOR (#84 part 3). Computed and checked BEFORE the write,
		// same discipline as the unreadable-node and no-data refusals above —
		// "wrote a degraded file, then failed" must stay unreachable here too.
		const shrink = shrinkRefusal(committedRoster.length, coverage.repos.length, {
			allowShrink: ALLOW_SHRINK,
		});
		if (shrink) failEarly(`fleet-runner-coverage.json: ${shrink}`);
		// Two spaces, not a tab: .prettierrc overrides *.json to `useTabs: false`,
		// so tab-indented output is valid but non-conforming — auto-format.yml
		// rewrites it on main as hadoku-format-bot, and every regeneration then
		// shows up as a whole-file diff. Matching prettier here keeps the only
		// real diff the one that matters: which repos are covered.
		writeFileSync(COVERAGE, `${JSON.stringify(coverage, null, 2)}\n`);
		log(`wrote ${COVERAGE} (${coverage.repos.length} repos)`);
	}

	const repos = [...desired.keys()].filter((r) => !ONLY_REPO || r === ONLY_REPO);
	const retiredScoped = retired.filter((r) => !ONLY_REPO || r.repo === ONLY_REPO);

	if (ONLY_REPO && !repos.length && !retiredScoped.length) {
		failEarly(`--repo ${ONLY_REPO}: not in the desired or retired set`);
	}
	// Unscoped and covering nothing. Reachable without an empty universe — every
	// repo skipped, ignored or archived — and just as unsafe to report as clean:
	// the reconciler would enumerate no runners and pronounce the coverage it
	// never examined correct.
	if (!ONLY_REPO && !repos.length) {
		// Counted from what IS in scope here. `all` belongs to the function that
		// built `desired` and referencing it from this one threw `all is not
		// defined` — caught by lint, which is the entire argument for treating a
		// warning as an error: the guard would have crashed the coverage cron in
		// exactly the situation it exists to report.
		failEarly(
			`${desired.size} covered / ${retired.length} retired / ${ignored.length} ignored: ` +
				'NOTHING is covered. A reconciler with nothing to reconcile has not verified anything.'
		);
	}

	log(`Enumerating runners on ${repos.length + retiredScoped.length} repos...`);
	const probeList = [...repos, ...retiredScoped.map((r) => r.repo)];
	const probes = await pool(probeList, 8, (repo) => listRunners(repo));
	const actual = new Map(probeList.map((r, i) => [r, probes[i]]));

	const missing = []; // (repo, claw) to register
	const capDrift = []; // runners lacking a capability their node declares
	const offline = [];
	const unmanaged = [];
	const orphans = []; // removable: retired repo that still has claw runners
	// Registrations on a node the manifest no longer wants for this repo.
	//
	// Until 2026-08-26 this category did not exist and the diff ran in ONE
	// direction only (`want -> seen`), so a registration outside `want` was not
	// missing, not an orphan, not unmanaged — it was invisible. That is why
	// adding a repo to a node's `excludeRepos` appeared to offload it and in
	// fact removed nothing, uninstalled nothing, and reported nothing.
	const excluded = [];
	const unreadable = [];

	for (const repo of repos) {
		const state = actual.get(repo);
		if (!state.ok) {
			unreadable.push({ repo, error: state.error });
			continue;
		}
		const want = desired.get(repo).claws;
		const seen = new Map();
		// EVERY managed registration, recorded before any of the short-circuits
		// below. `seen` deliberately skips demoted and offline runners, so it
		// cannot answer "does this pair exist at all" — which is exactly the
		// question the reverse diff needs.
		const present = new Map();
		for (const r of state.runners) {
			const claw = clawOfRunner(r.name);
			if (!claw) {
				unmanaged.push({ repo, runner: r.name, status: r.status });
				continue;
			}
			present.set(claw, r);

			// --- capability drift ---------------------------------------------
			// A node's declared `labels` are its CAPABILITIES, and until now the
			// only thing that ever applied them was registration. So a capability
			// added to the manifest reached new runners and no existing ones, and
			// 27 hokon runners carried none of hokon's own `pm2-host`.
			//
			// ADDITIVE ONLY. Undeclared labels are reported, never stripped: this
			// file does not know about `hokon-backstop`, which runner-health writes
			// and nothing declares, and a reconcile that removed what it had not
			// been told about would silently unroute live jobs. Same asymmetry the
			// rest of this script uses — registering restores, removing takes away.
			//
			// ELIGIBILITY capabilities are excluded on both sides, and `identityLabels`
			// is what knows which those are. It used to be a literal
			// `.filter(l => l !== BUILDER_LABEL)` — correct, and only ever correct
			// about the one eligibility label whoever wrote it remembered to name.
			// `hadoku-builder` is owned by the fast loop (and, on a guest, by the
			// backstop), which flip it as nodes become safe or unsafe; treating it
			// as a capability here would make the tools fight over the same label.
			// WHAT THE NODE OFFERS — declared AND earned, workload-gated — not the
			// declared array alone. Against `identityLabels` a standing runner never
			// gained a label its node EARNED: hokon earned jdk21 and cargo-bevy on
			// 2026-10-09 and its 28 runners kept the three it declared, so a promoted
			// hokon could never take a Forge job. Additive: nothing is stripped.
			const offered = offeredLabels(manifest, claw);
			const have = new Set(r.labels.map((l) => l.name));
			const missingCaps = offered.filter((l) => !have.has(l));
			if (missingCaps.length) {
				capDrift.push({ repo, claw, runner: r.name, id: r.id, add: missingCaps });
			}

			// A REGISTRATION THAT EXISTS IS COVERAGE, whatever its labels. Labels
			// are eligibility, written by the fast loop as a node becomes safe or
			// unsafe (and by the backstop on a guest); a runner without one is
			// present and simply not eligible right now. Reading it as MISSING made
			// --confirm re-register over it with `config.sh --replace`, stealing a
			// healthy registration. Until 2026-09-21 only surge-tier nodes were
			// spared that reading — so a resident registration on claw-2 or claw-4,
			// born unlabelled, was one reconcile away from being stolen.
			// An OFFLINE runner is a registration that EXISTS, so it is NOT missing
			// coverage. Counting it as both made this tool contradict its own
			// contract ("Reinstall an offline runner. That is an incident" — see the
			// header): `missing` is exactly what --confirm registers, and registering
			// a name that is already taken runs `config.sh --replace`, which STEALS
			// the registration from the live runner and orphans its listener.
			//
			// The trigger is not rare. GitHub reports a runner offline during any
			// blip in its own control plane; on 2026-08-25 a burst of 503s on
			// /acquirejob flipped hadoku_site's claw-3 to `offline busy=true` for
			// under two minutes WHILE IT WAS RUNNING A JOB, and a reconcile in that
			// window listed it as missing. The daily ci:fleet-coverage job auto-
			// applies up to 6 pairs, so a blip was one scheduling coincidence away
			// from killing a healthy mid-job runner.
			//
			// Same rule as the unlabelled case above: the runner is present, so
			// report the anomaly, never re-register over it.
			seen.set(claw, true);
			if (r.status !== 'online') {
				// `guest` is carried ON THE ROW, not derived at the exit, so the
				// --json consumer and the exit code read the same fact from the same
				// place. mgmt-api types this array as `{repo, claw, runner}[]` and
				// ignores extra fields, so the contract field `offline` keeps both
				// its name and every row it has always had — a guest's stale
				// registration is still REPORTED, it just is not a claw's incident.
				// `expectedDown` is carried the same way `guest` is — ON THE ROW, so
				// the --json consumer and the exit code read the same fact from the
				// same place. Only a node drained for maintenance, dated and fresh,
				// qualifies (`deferralFor`); a registration that is merely offline on
				// an undrained node is exactly the incident this array exists to
				// report, and still fails. See lib/expected-down.mjs.
				//
				// `|| undefined` so `--json` stays additive in the strict sense, not
				// just the loose one: a row for a node nothing has drained is
				// byte-identical to the shape this array has always had —
				// `JSON.stringify` drops an `undefined` property — matching
				// `check-fleet-toolchain.mjs`'s own `drainNote: defer.deferred ? ... :
				// undefined` for the same reason.
				offline.push({
					repo,
					runner: r.name,
					claw,
					guest: isGuestNode(manifest.machines?.[claw]),
					expectedDown: deferralFor(claw, drains).deferred || undefined,
				});
			}
		}
		for (const claw of want) if (!seen.has(claw)) missing.push({ repo, claw });
		// The other direction. Reported always; removed only under
		// --remove-excluded, matching this file's standing asymmetry that
		// registering restores coverage while removing takes it away.
		for (const [claw, r] of present) {
			if (want.includes(claw)) continue;
			excluded.push({
				repo,
				claw,
				runner: r.name,
				id: r.id,
				status: r.status,
				busy: r.busy === true,
			});
		}
	}

	for (const { repo, why } of retiredScoped) {
		const state = actual.get(repo);
		if (!state?.ok) continue;
		for (const r of state.runners) {
			const claw = clawOfRunner(r.name);
			if (claw) orphans.push({ repo, claw, runner: r.name, id: r.id, why });
		}
	}

	// ---- report ----------------------------------------------------------
	// --- capacity gate -----------------------------------------------------
	// A node's limit is enforced here rather than trusted to prose. Until
	// 2026-08-23 the "~2.8 runners per core" rule lived only inside ten repo
	// entries' $why strings, so nothing noticed claw-3 reaching 19 registrations
	// (4.8/core) before the watchdog rebooted it at 92C on 2026-08-17.
	//
	// This bounds REGISTRATIONS, which is a proxy for disk and install footprint
	// — NOT a thermal control. Registrations sit idle at no cost; concurrent
	// builds are what cook a box, and nothing caps those yet.
	const perNode = new Map();
	for (const r of repos)
		for (const c of desired.get(r).claws) perNode.set(c, (perNode.get(c) ?? 0) + 1);
	const overCapacity = [];
	for (const [node, cfg] of Object.entries(manifest.machines)) {
		const cap = cfg.maxRegistrations;
		if (cap === undefined) continue;
		const want = perNode.get(node) ?? 0;
		// `node` is a --json KEY: this subcommand is in JSON_CONTRACT and
		// ci:fleet-coverage parses its stdout. See docs/VOCABULARY.md.
		if (want > cap) overCapacity.push({ machine: node, want, cap, cores: cfg.cores });
	}

	const summary = {
		capabilityDrift: capDrift.length,
		desiredRepos: repos.length,
		desiredPairs: repos.reduce((n, r) => n + desired.get(r).claws.length, 0),
		capacity: Object.fromEntries(
			Object.entries(manifest.machines)
				.filter(([, c]) => c.maxRegistrations !== undefined)
				.map(([m, c]) => [m, { used: perNode.get(m) ?? 0, max: c.maxRegistrations }])
		),
		overCapacity,
		missing,
		offline,
		orphans,
		excluded,
		unmanaged,
		unreadable,
		ignored,
		departed,
	};

	if (!JSON_OUT) {
		log(`Desired: ${summary.desiredRepos} repos × claws = ${summary.desiredPairs} pairs`);
		log(
			`Capacity: ${Object.entries(summary.capacity)
				.map(([m, c]) => `${m} ${c.used}/${c.max}`)
				.join('  ')}\n`
		);

		if (overCapacity.length) {
			log(`OVER CAPACITY (${overCapacity.length}) — refusing to plan:`);
			for (const o of overCapacity) {
				log(
					`  ${o.machine}: ${o.want} placements against maxRegistrations ${o.cap} (${o.cores} cores)`
				);
			}
			log("  Raise the node's maxRegistrations, or add an excludeRepos entry, in the manifest.\n");
		}

		if (capDrift.length) {
			const byCap = new Map();
			for (const c of capDrift) {
				const k = `${c.claw}: +${c.add.join(',')}`;
				byCap.set(k, (byCap.get(k) ?? 0) + 1);
			}
			log(`CAPABILITY DRIFT (${capDrift.length} runner(s)):`);
			for (const [k, n] of byCap) log(`  ${k}  on ${n} runner(s)`);
			log(CONFIRM ? '' : '  (--confirm applies these)\n');
		}

		if (missing.length) {
			log(`MISSING COVERAGE (${missing.length}):`);
			const byRepo = new Map();
			for (const m of missing) byRepo.set(m.repo, [...(byRepo.get(m.repo) ?? []), m.claw]);
			for (const [repo, claws] of byRepo) log(`  ${repo}  →  ${claws.join(', ')}`);
			log('');
		} else {
			log('MISSING COVERAGE: none — every desired pair has a registered runner.\n');
		}

		if (offline.length) {
			const clawsOffline = offline.filter((o) => !o.guest && !o.expectedDown);
			const expectedDownOffline = offline.filter((o) => !o.guest && o.expectedDown);
			const guestsOffline = offline.filter((o) => o.guest);
			if (clawsOffline.length) {
				log(
					`OFFLINE (${clawsOffline.length}) — reported, never auto-reinstalled; this is an incident:`
				);
				for (const o of clawsOffline) log(`  ${o.repo}  ${o.runner}`);
				log('');
			}
			if (expectedDownOffline.length) {
				// A node a human powered off is EXPECTED down. Its registrations are
				// still REPORTED — deferral removes the page, not the evidence — and
				// never count toward the exit code below. See lib/expected-down.mjs.
				const byClaw = new Map();
				for (const o of expectedDownOffline) byClaw.set(o.claw, true);
				log(`OFFLINE, EXPECTED DOWN (${expectedDownOffline.length}):`);
				for (const [claw] of byClaw) log(`  · ${deferralNote(claw, deferralFor(claw, drains))}`);
				for (const o of expectedDownOffline) log(`  ${o.repo}  ${o.runner}  (${o.claw})`);
				log('');
			}
			if (guestsOffline.length) {
				// Said out loud, and said DIFFERENTLY. A guest's stale rows are real
				// drift and worth seeing, but they are not a claw's incident and they
				// do not fail this run — printing them under the same heading is what
				// made #60 read as "the fleet is broken" when it was one borrowed box
				// holding registrations nobody here may repair.
				log(
					`OFFLINE ON A GUEST (${guestsOffline.length}) — reported only; a guest's ` +
						`registrations are not this fleet's to reinstall, and do not fail the run:`
				);
				for (const o of guestsOffline) log(`  ${o.repo}  ${o.runner}  (${o.claw})`);
				log('');
			}
		}
		if (orphans.length) {
			log(`ORPHANS (${orphans.length}) — retired repos still holding runners:`);
			for (const o of orphans) log(`  ${o.repo}  ${o.runner}  (${o.why})`);
			log(REMOVE_ORPHANS ? '' : '  (pass --remove-orphans to tear these down)\n');
		}
		if (excluded.length) {
			log(
				`EXCLUDED (${excluded.length}) — the manifest no longer wants this pair, ` +
					`but the runner is still registered and still taking jobs:`
			);
			for (const e of excluded) log(`  ${e.repo}  ${e.runner}  (${e.claw}, ${e.status})`);
			log(REMOVE_EXCLUDED ? '' : '  (pass --remove-excluded to deregister these)\n');
		}
		if (unmanaged.length) {
			log(`UNMANAGED (${unmanaged.length}) — not on a managed claw, left untouched:`);
			for (const u of unmanaged) log(`  ${u.repo}  ${u.runner}  ${u.status}`);
			log('');
		}
		if (unreadable.length) {
			log(`UNREADABLE (${unreadable.length}) — could not list runners:`);
			for (const u of unreadable) log(`  ${u.repo}  ${u.error}`);
			log('');
		}
		if (departed.length) {
			// Loud, and phrased as a question the operator has to answer. A
			// departure is not drift to be applied — `--confirm` cannot fix it,
			// because there is nothing to register. It is the roster deciding on
			// its own that something is no longer the fleet's problem.
			log(
				`LEFT THE ROSTER (${departed.length}) — in fleet-runner-coverage.json, no longer eligible:`
			);
			for (const d of departed) log(`  ${d.repo}  ${d.why}`);
			log('');
			log('  A repo does not stop needing CI by aging out of a heuristic. Decide, do not');
			log('  regenerate on reflex — `--write-coverage` makes this disappear WITHOUT');
			log('  closing it, which is how a missing-coverage page self-resolves overnight.');
			log('    keep it   -> add an entry under `repos` in fleet-runner-manifest.json');
			log('    drop it   -> `skip: true` (should have no runners) or `ignore: true`');
			log('                 (has runners nobody intends to remove), with a $why');
			log('    then      -> fleet reconcile --write-coverage');
			log('');
		}
		// One line, not a section: an ignored repo is a decision already made, so
		// it should be visible without ever reading as something to act on.
		if (ignored.length) {
			log(`Ignored by manifest: ${ignored.map((i) => i.repo).join(', ')}\n`);
		}
	}

	// ---- apply -----------------------------------------------------------
	const results = { registered: [], removed: [], failed: [] };

	// A capacity breach REFUSES the apply, it does not merely colour the report.
	// A gate that reports and then proceeds anyway is the "dead guard" shape:
	// it reads as protection while protecting nothing.
	if (CONFIRM && overCapacity.length) {
		log("REFUSING to apply: the plan exceeds a node's maxRegistrations (see above).");
		log('Nothing was registered. Resolve the capacity breach in the manifest first.\n');
	}

	if (CONFIRM && !overCapacity.length && missing.length) {
		const version = currentRunnerVersion();
		log(`Registering ${missing.length} runner(s) at release v${version}...\n`);

		// Serialize per claw — config.sh and the shared tarball cache race on
		// one host — and run the claws concurrently, which is the real win.
		const byClaw = new Map();
		for (const m of missing) byClaw.set(m.claw, [...(byClaw.get(m.claw) ?? []), m]);

		await Promise.all(
			[...byClaw.entries()].map(async ([claw, pairs]) => {
				// A guest lends the fleet a registration and nothing else: the slice
				// and throttle drivers refuse it by role (operator, 2026-09-14), so
				// its unit starts at registration exactly as before. A claw's waits.
				const guest = isGuestNode(manifest.machines?.[claw]);
				const unstarted = [];
				for (const { repo } of pairs) {
					const token = mintToken(repo, 'register');
					// A runner's labels are the NODE's declared capabilities, projected
					// onto it. Until now `machines[].labels` was read in exactly one
					// place — the `needs` matcher, which decides PLACEMENT — and never
					// applied to anything. So the manifest could say hokon has
					// `pm2-host` while no hokon runner carried it, and the capability
					// half of the model was only ever half wired.
					//
					// DERIVED from the capability registry rather than assembled here,
					// and NEVER eligible: the fast loop grants `hadoku-builder` once the
					// node is judged safe. See `registrationLabels`.
					const labels = offeredLabels(manifest, claw);
					// config.sh needs a non-empty --labels; `self-hosted` is implicit
					// anyway, so it is the harmless identity value.
					const labelArg = labels.length ? labels.join(',') : 'self-hosted';
					const res = await ssh(
						claw,
						registerScript({ repo, claw, version, token, labels: labelArg, start: guest })
					);
					// A claw's script ends in exactly one of two ways when it exits 0:
					// UNIT-WRITTEN (enabled, waiting to be provisioned) or SKIP (a
					// system unit already supervises this directory). Anything else is
					// a script that succeeded without saying what it did.
					const wrote = /^UNIT-WRITTEN /m.test(res.stdout);
					const skipped = /^SKIP: /m.test(res.stderr);
					if (res.ok && !guest && wrote) {
						unstarted.push(repo);
					} else if (res.ok && (guest || skipped)) {
						results.registered.push({ repo, claw });
						log(`  ✓ ${claw}  ${repo}`);
					} else if (res.ok) {
						const error = 'registration exited 0 but wrote no unit and gave no SKIP reason';
						results.failed.push({ repo, claw, error });
						log(`  ✗ ${claw}  ${repo}\n      ${error}`);
					} else {
						results.failed.push({ repo, claw, error: res.stderr.trim().slice(0, 400) });
						log(
							`  ✗ ${claw}  ${repo}\n      ${res.stderr.trim().split('\n').slice(-3).join('\n      ')}`
						);
					}
				}
				if (!unstarted.length) return;

				// BORN PROVISIONED (#1). Each unit is registered and enabled but has
				// never run; its slice drop-in and throttle env go on disk now, so its
				// first start is in the slice with the hook loaded and nothing ever
				// needs `--restart`. A unit whose provisioning failed is NOT started:
				// an offline runner fails the next reconcile loudly, an unthrottled
				// one outside the slice ran unnoticed for two nights.
				const prov = await provisionBeforeStart(claw);
				for (const repo of unstarted) {
					const unit = `actions-runner-${repoSuffix(repo)}.service`;
					if (!prov.ok) {
						results.failed.push({ repo, claw, error: `registered, NOT started: ${prov.why}` });
						log(
							`  ✗ ${claw}  ${repo} — registered and enabled, NOT started: ${prov.why}\n` +
								`      fix: fleet slice --machine ${claw} --confirm && ` +
								`fleet throttle --machine ${claw} --confirm --no-restart, ` +
								`then: ssh ${claw} systemctl --user start ${unit}`
						);
						continue;
					}
					const started = await ssh(claw, startScript({ repo, sliceName: prov.sliceName }));
					if (started.ok) {
						results.registered.push({ repo, claw });
						log(`  ✓ ${claw}  ${repo}  (started in ${prov.sliceName}, throttle env loaded)`);
					} else {
						results.failed.push({ repo, claw, error: started.stderr.trim().slice(0, 400) });
						log(
							`  ✗ ${claw}  ${repo} — provisioned, but its first start failed:\n      ` +
								started.stderr.trim().split('\n').slice(-2).join('\n      ')
						);
					}
				}
			})
		);
		log('');
	}

	// Applied even when nothing needs registering: a capability the manifest
	// declares is not optional just because coverage happens to be complete.
	if (CONFIRM && capDrift.length) {
		log(`Applying ${capDrift.length} capability label(s)...\n`);
		for (const c of capDrift) {
			const res = ghWrite('POST', `/repos/${c.repo}/actions/runners/${c.id}/labels`, {
				labels: c.add,
			});
			if (res.ok) {
				results.labelled = (results.labelled ?? 0) + 1;
			} else {
				results.failed.push({ repo: c.repo, claw: c.claw, error: `label: ${res.error}` });
				log(`  ✗ ${c.claw}  ${c.repo}  +${c.add.join(',')}  ${res.error}`);
			}
		}
		log(`  ✓ ${results.labelled ?? 0} runner(s) relabelled\n`);
	}

	/**
	 * Remove one (repo, node) registration and report how it went. One function
	 * for the orphan and excluded paths, which carried two copies of this.
	 *
	 * The BY-ID FALLBACK (#123): when config.sh remove fails on an install that
	 * WAS found, the controller deletes the registration through the REST API by
	 * its id and then has the node remove the install with deregistration
	 * skipped. A renamed repo is the case: the install's .runner names the old
	 * URL, the runner API does not follow the rename, and config.sh remove 404s
	 * (hadoku-printTool -> hadoku-craft, hokon, 2026-10-19), while
	 * DELETE repos/<current>/actions/runners/<id> works. The install is still
	 * removed only after the registration is gone — the ordering removeScript's
	 * header exists for.
	 */
	const removeRegistration = async ({ repo, claw, id }) => {
		const guest = isGuestNode(manifest.machines?.[claw]);
		const runnerId = Number.isInteger(id) ? id : null;
		const token = mintToken(repo, 'remove');
		let res = await ssh(claw, removeScript({ repo, token, guest, runnerId }));
		let byId = false;
		if (!res.ok && /DEREGISTER_FAILED/.test(res.stderr) && runnerId !== null) {
			const del = ghWrite('DELETE', `/repos/${repo}/actions/runners/${runnerId}`, {});
			if (del.ok) {
				byId = true;
				res = await ssh(claw, removeScript({ repo, token, guest, runnerId, deregistered: true }));
			} else {
				log(`  ! ${claw}  ${repo} — config.sh remove failed and so did DELETE by id: ${del.error}`);
			}
		}
		const dir =
			/DIR=(\S+?)\)/.exec(res.stderr)?.[1] ?? `~/runners/actions-runner-${repoSuffix(repo)}`;
		if (res.ok) {
			results.removed.push({ repo, claw });
			log(
				`  ✓ ${claw}  ${repo}` +
					(byId
						? ` (deregistered by id ${runnerId}: config.sh remove refused — a renamed repo?)`
						: '')
			);
		} else if (/NOT_OURS/.test(res.stderr)) {
			// No install of this registration on the node, looked for under the
			// current name AND by agentId. Never a root command: there is no
			// directory to run svc.sh in, which is what this hint used to send
			// the operator after.
			log(
				`  ! ${claw}  ${repo} — no install of this registration on ${claw}. NOTHING was changed.\n` +
					(runnerId !== null
						? `      If no other user on ${claw} runs it, the registration is stale:\n` +
							`      gh api -X DELETE repos/${repo}/actions/runners/${runnerId}`
						: `      (no runner id was known, so only the current name was searched)`)
			);
			results.failed.push({ repo, claw, error: 'no install found for this registration' });
		} else if (/NEEDS_ROOT/.test(res.stderr)) {
			// The runner is a SYSTEM install and this node would not give it up
			// unattended. Nothing was changed — say so, because the whole reason
			// this branch exists is that a silent failure here used to end with a
			// deleted directory.
			log(
				`  ! ${claw}  ${repo} — system service, root required. NOTHING was changed:\n` +
					`      ssh ${claw} 'cd ${dir} && sudo ./svc.sh stop && sudo ./svc.sh uninstall'`
			);
			results.failed.push({ repo, claw, error: 'system service; root required' });
		} else if (/DEREGISTER_FAILED/.test(res.stderr)) {
			// Distinct from every other failure because the remedy is distinct: the
			// directory was deliberately LEFT, so re-running is the fix. It used to
			// be deleted here, which is what made claw-1's 21 failures on
			// 2026-09-01 unrecoverable without the REST API.
			log(
				`  ! ${claw}  ${repo} — still registered; the local install was left intact. Re-run to retry.`
			);
			results.failed.push({ repo, claw, error: 'deregister failed; install left intact' });
		} else {
			results.failed.push({ repo, claw, error: res.stderr.trim().slice(0, 400) });
			// The reason, not just the mark. A bare ✗ is how 21 identical failures
			// on claw-1 read as 21 unrelated ones.
			log(
				`  ✗ ${claw}  ${repo}\n      ${res.stderr.trim().split('\n').slice(-2).join('\n      ')}`
			);
		}
	};

	if (CONFIRM && REMOVE_ORPHANS && orphans.length) {
		log(`Removing ${orphans.length} orphaned runner(s)...\n`);
		const byClaw = new Map();
		for (const o of orphans) byClaw.set(o.claw, [...(byClaw.get(o.claw) ?? []), o]);

		await Promise.all(
			[...byClaw.entries()].map(async ([claw, items]) => {
				for (const { repo, id } of items) await removeRegistration({ repo, claw, id });
			})
		);
		log('');
	}

	// Excluded pairs are removed one (repo, node) at a time, and NEVER while
	// the runner is busy. An orphan belongs to a repo that has retired, so losing
	// its in-flight job costs nothing; an excluded pair belongs to a repo that is
	// very much alive and simply should not run HERE, so tearing down mid-job
	// would fail a real build to save an idle listener. The API's `busy` flag
	// lags reality, which is why this only ever SKIPS on it — a stale `false`
	// still leaves removeScript's own checks in front of the uninstall, while a
	// stale `true` costs one deferred removal.
	if (CONFIRM && REMOVE_EXCLUDED && excluded.length) {
		const removable = excluded.filter((e) => !e.busy);
		const busyCount = excluded.length - removable.length;
		log(`Deregistering ${removable.length} excluded pair(s)...\n`);
		if (busyCount) log(`  (${busyCount} busy, deferred to the next run)`);
		for (const { repo, claw, id } of removable) await removeRegistration({ repo, claw, id });
		log('');
	}

	if (JSON_OUT) {
		emitter.emit({ ...summary, applied: CONFIRM ? results : null });
	} else if (CONFIRM) {
		log(
			`Done: ${results.registered.length} registered, ${results.removed.length} removed, ${results.failed.length} failed.`
		);
		if (!results.failed.length && !missing.length) log('Fleet matches the manifest.');
		// A new registration has no `hadoku-builder`, so it takes no job until the
		// fast loop's full reconcile grants it. That gap read as a bug on
		// 2026-10-22 and the label was written by hand, which is the one writer
		// this label must not have. Say how long, from the loop's own constants.
		if (results.registered.length) {
			const mins = Math.ceil((FAST_LOOP_SECONDS * RECONCILE_EVERY_TICKS) / 60);
			log(
				`New runners take jobs once mgmt-api's fast loop grants ${BUILDER_LABEL}: ` +
					`within ~${mins} minutes. Do not add it by hand.`
			);
		}
	} else if (missing.length || orphans.length) {
		log('Dry run only. Re-run with --confirm to apply.');
	}

	const stillMissing = CONFIRM ? missing.length - results.registered.length : missing.length;
	// A CLAW's offline rows, which are the only ones that fail this run. The
	// guest half is filtered out HERE and nowhere upstream, so `summary.offline`
	// — the --json field mgmt-api reads by name — still carries every row.
	//
	// #60: every one of the 7 offline rows that failed a dry run was hokon's.
	// hokon is a GUEST and a RESERVE; its stale registrations are not this
	// fleet's to reinstall, and a `fleet provision` of claw-7 has no business
	// exiting 1 because a borrowed box is holding rows from last month. This is
	// NOT a widening: a claw's offline row still fails, and that is the case the
	// paragraph below is about.
	// `expectedDown` is excluded the same way `guest` is: a node drained for
	// maintenance, dated and fresh, cannot also be serving, so its offline rows
	// are reported above and left out of the count below. The deferral
	// EXPIRES (DEFER_DAYS) and does not apply to a `training` drain or an
	// undrained node that simply went dark — both still fail. See
	// lib/expected-down.mjs.
	const offlineClaws = offline.filter((o) => !o.guest && !o.expectedDown);
	// `offline` is counted here EXPLICITLY. It used to reach the exit code only by
	// accident, via being double-counted into `missing` — so removing that
	// double-count would otherwise have made a genuinely dead runner (box down,
	// disk full, unit masked) report its incident and still exit 0, which is the
	// one state this tool exists to make loud. Offline is loud but never
	// self-healing: it fails the run and is never added to the register list.
	// `departed` fails the run. It is the one condition here that --confirm
	// cannot resolve and that regenerating coverage would ERASE rather than fix,
	// so a silent exit 0 would let the roster quietly redefine the fleet as
	// whatever it still happens to match. mgmt-api's fleet-coverage-check.ts
	// reads the field by name — see scripts/lib/json-contract.mjs; this exit code
	// is the operator's signal, that field is the cron's.
	process.exit(
		stillMissing > 0 ||
			offlineClaws.length > 0 ||
			results.failed.length > 0 ||
			overCapacity.length > 0 ||
			departed.length > 0
			? 1
			: 0
	);
}

main().catch((err) => {
	console.error(`reconcile-fleet-runners: ${err.message}`);
	process.exit(1);
});
