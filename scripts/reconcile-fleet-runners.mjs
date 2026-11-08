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
 *   An offline registration on any node, the backstop included, fails the run.
 *   It is an incident and this tool exists to make it loud — see the `offline`
 *   note at the exit call. UNMANAGED runners never fail the run either — they are reported and left
 *   alone.
 *
 *   Until 2026-09-26 this block claimed that no offline runner ever failed the
 *   run, while the predicate below failed on every one of them. Read as
 *   evidence, that sentence cost a diagnosis; it is the fourth time in this
 *   repo. If you change the predicate below, change this — and
 *   reconcile-fleet-runners.test.mjs holds the two together.
 */

import { readFileSync } from 'node:fs';
import { loadManifest as readManifest, manifestPath, runOn } from './lib/fleet-exec.mjs';
import { manifest as manifestFile } from '../dist/lib/fleet-paths.js';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { BUILDER_LABEL } from '../dist/lib/capability-registry-ids.js';
import { FAST_LOOP_SECONDS, RECONCILE_EVERY_TICKS } from '../dist/lib/fast-loop-cadence.js';
import { createEmitter } from './lib/emit.mjs';
import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { parseStrict } from './lib/argv.mjs';
import { checkGhReserve } from './lib/gh-reserve.mjs';
import { useAppPool } from './lib/gh-app.mjs';
import { listRunners, ciRunnerVarCheck } from './lib/reconcile-apply.mjs';
import { resolveDesired } from './lib/reconcile-resolve.mjs';
import {
	buildCoverageDoc,
	checkCoverageVerdict,
	writeCoverageOrRefuse,
} from './lib/reconcile-coverage.mjs';
import { printReport } from './lib/reconcile-report.mjs';
import { applyRegistrations, applyRemovals } from './lib/reconcile-exec.mjs';
import { readJobReserves } from './lib/reconcile-job-reserves.mjs';
import { computeDrift, computeCapacityGate } from './lib/reconcile-drift.mjs';

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
//   - the backstop decision owns hokon's `hadoku-builder`, so it carries none
//     label in steady state and GitHub cannot schedule onto it until the
//     backstop promotes it.
//   - Its `minFreeMb: 8192` floor protects mgmt-api, the tunnel and the other production services
//     from the CI it now hosts.
//   - Orphan removal only ever targets repos being RETIRED, so nothing here can
//     remove a live runner.

const args = process.argv.slice(2);
// F8 (plan §4.1): strict, from the one spec argv-specs.mjs declares.
const cli = parseStrict(ARGV_SPECS['reconcile-fleet-runners.mjs'], args);
const hasFlag = cli.has;

const CONFIRM = hasFlag('--confirm');
const REMOVE_ORPHANS = hasFlag('--remove-orphans');
// Distinct from --remove-orphans on purpose. An ORPHAN is a whole repo that
// retired, so every one of its runners should go. An EXCLUDED pair is a repo
// that is still live and still wanted elsewhere — only this one node should
// stop carrying it. Folding them together would make `excludeRepos` able to
// take a repo's CI away entirely, which is the opposite of what it means.
const REMOVE_EXCLUDED = hasFlag('--remove-excluded');
const JSON_OUT = hasFlag('--json');
const ONLY_REPO = cli.value('--repo');
const WRITE_COVERAGE = hasFlag('--write-coverage');
const CHECK_COVERAGE = hasFlag('--check-coverage');
// #84 part 2: a deliberate shrink (a repo archived or dropped from the
// manifest) is real; refusing it forever would make the generator unable to
// ever record a genuine retirement.
const ALLOW_SHRINK = hasFlag('--allow-shrink');

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
// Desired state
// ---------------------------------------------------------------------------

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
 * Run a script on a node. LOCAL when it is this host — `ssh hokon` from hokon
 * is refused (no sshd on 22), and hokon is now a managed node, so a
 * blind ssh would make every hokon registration fail with a connection error
 * that reads like the box is down.
 *
 * `as` is REQUIRED, no default. A runner belongs to the node's `ci` user; the
 * register script installs under `$HOME`, so run as admin it put
 * WolffM/hadoku-fleet-manager under the admin user on claw-10 (2026-11-04),
 * outside the CI user's manager, the slice and the throttle.
 */
async function ssh(claw, script, role) {
	if (role !== 'admin' && role !== 'ci') throw new Error(`reconcile ssh needs a role, got ${role}`);
	const r = await runOn(claw, script, {
		as: role,
		timeoutMs: 15 * 60_000,
		maxBuffer: 8 * 1024 * 1024,
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
	const { desired, retired, ignored, departed, allRepos } = resolveDesired(
		manifest,
		committedRoster,
		{
			fail: failEarly,
		}
	);

	// --- coverage file -----------------------------------------------------
	// Derived purely from desired state, so it is correct on a dry run too — but
	// only WRITTEN when asked, because `--dry-run means zero side effects` is a
	// contract worth more than the convenience. Facets cost one tree call per
	// repo plus a package.json read, so `buildCoverageDoc` derives them only
	// when WRITE_COVERAGE/CHECK_COVERAGE actually need them.
	const repoList = [...desired.keys()].sort();
	const coverage = buildCoverageDoc({
		manifest,
		repoList,
		onDiskCoverage,
		log,
		fail: failEarly,
		readJobReserves,
		WRITE_COVERAGE,
		CHECK_COVERAGE,
	});
	if (CHECK_COVERAGE) {
		// `--json`'s emit-and-exit stays here, literally, so
		// `scripts/lib/json-contract.mjs` keeps scanning real code in this file
		// rather than in `lib/reconcile-coverage.mjs` — see that module's header.
		const verdict = checkCoverageVerdict({ onDiskCoverage, coverage, log });
		if (JSON_OUT) emitter.emit(verdict.jsonBody);
		process.exit(verdict.ok ? 0 : 1);
	}
	if (WRITE_COVERAGE) {
		writeCoverageOrRefuse({ committedRoster, coverage, ALLOW_SHRINK, fail: failEarly, log });
	}

	// --- runnerVar ----------------------------------------------------------
	// `ci:runner-var`'s unique catch, merged into this `--json` (wave gates2
	// lane F1b): a repo, covered or not, whose shipped workflows read the bare
	// `fromJSON(vars.CI_RUNNER)` form while the variable is unset or
	// unreadable. The population is the union of the committed roster and
	// every repo `resolveDesired` already listed under the owner — the SAME
	// `gh repo list` call check-runner-var.mjs makes for itself, reused here
	// rather than spent twice. Computed unconditionally (not gated on
	// `JSON_OUT`/`CONFIRM`): the contract names an exact shape callers can
	// depend on, and `ci:runner-var` already runs appended right after
	// `ci:fleet-coverage` today, so this adds no new `gh` spend to the cadence
	// — it folds two already-adjacent processes into one.
	const runnerVarPopulation = [...allRepos].filter(([, r]) => !r.isFork).map(([name]) => name);
	for (const name of committedRoster) {
		if (!runnerVarPopulation.includes(name)) runnerVarPopulation.push(name);
	}
	const runnerVar = ciRunnerVarCheck(runnerVarPopulation);

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

	// EVERY AND-OF-THE-ACTUAL-STATE diff — capability drift, offline/missing/
	// excluded pairs, orphans on a retired repo. Moved to
	// `lib/reconcile-drift.mjs` (wave shrink-1 lane D, pure move); see that
	// file for the asymmetry (registering restores, removing takes away) and
	// why an offline registration is never read as missing.
	const { missing, capDrift, offline, unmanaged, orphans, excluded, unreadable } = computeDrift({
		repos,
		retiredScoped,
		desired,
		actual,
		manifest,
		drains,
	});

	// EXPECTED-DOWN NOTES, one per claw with a deferred offline row. Computed
	// here, with a literal `deferralNote(` call, rather than inside
	// `lib/reconcile-report.mjs`: `expected-down-guard.test.mjs` pins this CLI
	// file as one of #71/#74's seven gates that must call `deferralFor`,
	// `deferralNote` AND `readDrains` itself, not merely through a lib.
	const expectedDownNotes = new Map();
	for (const o of offline) {
		if (o.expectedDown && !expectedDownNotes.has(o.claw)) {
			expectedDownNotes.set(o.claw, deferralNote(o.claw, deferralFor(o.claw, drains)));
		}
	}

	// ---- report ----------------------------------------------------------
	// --- capacity gate -----------------------------------------------------
	// Moved to `lib/reconcile-drift.mjs` (wave shrink-1 lane D, pure move); see
	// that file for why this bounds REGISTRATIONS rather than being a thermal
	// control.
	const { perNode, overCapacity } = computeCapacityGate({ repos, desired, manifest });

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
		runnerVar,
	};

	if (!JSON_OUT) {
		printReport({
			summary,
			overCapacity,
			capDrift,
			missing,
			offline,
			orphans,
			excluded,
			unmanaged,
			unreadable,
			departed,
			ignored,
			runnerVar,
			expectedDownNotes,
			CONFIRM,
			REMOVE_ORPHANS,
			REMOVE_EXCLUDED,
			log,
		});
	}

	// ---- apply -----------------------------------------------------------
	const results = { registered: [], removed: [], failed: [], advisories: [] };
	await applyRegistrations({
		CONFIRM,
		overCapacity,
		missing,
		capDrift,
		manifest,
		log,
		ssh,
		results,
	});

	await applyRemovals({
		CONFIRM,
		REMOVE_ORPHANS,
		REMOVE_EXCLUDED,
		orphans,
		excluded,
		manifest,
		log,
		ssh,
		results,
	});

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
	// The offline rows that fail this run. `summary.offline` — the --json field
	// mgmt-api reads by name — still carries every row.
	//
	// `expectedDown` is excluded: a node drained for
	// maintenance, dated and fresh, cannot also be serving, so its offline rows
	// are reported above and left out of the count below. The deferral
	// EXPIRES (DEFER_DAYS) and does not apply to a `training` drain or an
	// undrained node that simply went dark — both still fail. See
	// lib/expected-down.mjs.
	const offlineClaws = offline.filter((o) => !o.expectedDown);
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
