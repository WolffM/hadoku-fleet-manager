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
import {
	loadManifest as readManifest,
	manifestPath,
	runOn,
	runOnSync,
	selectMachines,
} from './lib/fleet-exec.mjs';
import { manifest as manifestFile } from './lib/paths.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { deriveJobReserves } from './lib/demand-derive.mjs';
import { metricsReadScript, metricsSince, perJobCosts, readOutcome } from './lib/job-metrics.mjs';
import { BUILDER_LABEL } from '../dist/lib/capability-registry.js';
import { RETENTION_DAYS } from '../dist/job-history-store.js';
import { FAST_LOOP_SECONDS, RECONCILE_EVERY_TICKS } from '../dist/fleet-loop.js';
import { createEmitter } from './lib/emit.mjs';
import { checkGhReserve } from './lib/gh-reserve.mjs';
import { useAppPool } from './lib/gh-app.mjs';
import { offeredLabels, listRunners } from './lib/reconcile-apply.mjs';
import { resolveDesired } from './lib/reconcile-resolve.mjs';
import {
	buildCoverageDoc,
	checkCoverageVerdict,
	writeCoverageOrRefuse,
} from './lib/reconcile-coverage.mjs';
import { printReport } from './lib/reconcile-report.mjs';
import { applyRegistrations, applyRemovals } from './lib/reconcile-exec.mjs';

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
 * Every node is read, the backstop included: its jobs run in minted units,
 * whose rows are per-job costs like a claw's.
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
	const nodes = selectMachines(manifest);
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
	return { ...derived, nodesRead: nodes.length - unreadable.length, unreadable };
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
 */
async function ssh(claw, script) {
	const r = await runOn(claw, script, {
		as: 'admin',
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
	const { desired, retired, ignored, departed } = resolveDesired(manifest, committedRoster, {
		fail: failEarly,
	});

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
			// `hadoku-builder` is owned by the fast loop (and, on the backstop, by
			// the backstop decision), which flip it as nodes become safe or unsafe; treating it
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
			// unsafe (and by the backstop decision on the backstop); a runner without one is
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
				// mgmt-api types this array as `{repo, claw, runner}[]` and ignores
				// extra fields. `expectedDown` is carried ON THE ROW, so
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
