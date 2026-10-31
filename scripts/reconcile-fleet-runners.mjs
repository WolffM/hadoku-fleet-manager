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

import { readFileSync, writeFileSync } from 'node:fs';
import { autoIncludeDrop, vanishedFromUniverse } from './lib/roster-eligibility.mjs';
import {
	loadManifest as readManifest,
	manifestPath,
	runOn,
	runOnSync,
	selectNodes,
} from './lib/fleet-exec.mjs';
import { manifest as manifestFile } from './lib/paths.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import {
	RESERVE_DRIFT_PCT,
	deriveJobReserves,
	reserveDrift,
	shrinkRefusal,
} from './lib/demand-derive.mjs';
import { metricsReadScript, metricsSince, perJobCosts, readOutcome } from './lib/job-metrics.mjs';
import { BUILDER_LABEL } from '../dist/capabilities.js';
import { fleetOwner } from '../dist/lib/fleet-config.js';
import { isGuestNode } from '../dist/lib/node-role.js';
import { RETENTION_DAYS } from '../dist/job-history.js';
import { FAST_LOOP_SECONDS, RECONCILE_EVERY_TICKS } from '../dist/fleet-loop.js';
import { createEmitter } from './lib/emit.mjs';
import { checkGhReserve } from './lib/gh-reserve.mjs';
import { useAppPool } from './lib/gh-app.mjs';
import {
	placementFor,
	describeCoverageDrift,
	withoutReserves,
	reservesOf,
} from './lib/reconcile-plan.mjs';
import { repoSuffix, registerScript, startScript, removeScript } from './lib/reconcile-scripts.mjs';
import {
	offeredLabels,
	ghWrite,
	listRunners,
	ghRepoListWithRetry,
	loadMountedApps,
	deriveFacets,
	lookupRepo,
	currentRunnerVersion,
	provisionBeforeStart,
	mintToken,
	countWorkflows,
	targetsSelfHostedFleet,
} from './lib/reconcile-apply.mjs';

const MANIFEST = manifestPath();

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	// The heaviest GitHub reader in the fleet (~440 calls with --check-coverage):
	// under the shared reserve it is not run, and on the App's pool it never
	// touches the user's (#9).
	const { pool: ghPool } = await useAppPool('reconcile');
	const reserve = checkGhReserve('reconcile', { pool: ghPool });
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
