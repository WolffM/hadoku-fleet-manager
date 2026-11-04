#!/usr/bin/env node
/**
 * bootcamp — a node EARNS its labels by passing the probe, rather than being
 * asserted into them by a human and verified afterwards.
 *
 * THE GAP THIS FILLS
 * ------------------
 * A claw is schedulable because someone wrote `labels: ["hadoku-builder"]` into
 * the manifest. `fleet capabilities` then checks that claim — AFTER work is
 * already landing on it. Measured 2026-09-02: claw-5 and claw-6 were registered,
 * online and carrying hadoku-builder with no Python tool cache at all, and nine
 * of the twenty-six covered repos use `actions/setup-python` on a distro for
 * which actions/python-versions publishes no build. Both boxes would have failed
 * a third of the roster while every gate called them healthy.
 *
 * So this runs the same probe `fleet capabilities` runs and reports the four
 * states that matter, which that command collapses into two:
 *
 *   EARNED     proven by EXECUTION          — the node's proof set (see below)
 *   UNEARNED   declared but NOT proven      — work routes here and fails
 *   UNCLAIMED  proven but not declared      — routed from `earned` since 2026-09-10
 *   BLOCKED    a toolchain prerequisite failed
 *
 * EARNED IS THE PROOF SET, NOT `proven ∩ declared` (settled 2026-09-10). It is
 * every capability this probe EXECUTED successfully, and it is what
 * `src/lib/capability-offer.ts`'s `nodeOffer` derives a node's GitHub label set from —
 * so this command is the producer the claw floor's eligibility input
 * (`claw-floor-design-2026-09-07.md` §1.1) never had. `--write` records the
 * facet and NOTHING ELSE: it no longer touches `machines[].labels`.
 *
 * UNEARNED is the one this exists for. UNCLAIMED is the second-order win: a node
 * that can do something nobody routes to it.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It never writes `hadoku-builder`. That is the one ELIGIBILITY capability, and
 * the fast loop is its writer — it adds and removes
 * it as nodes become safe or unsafe, so a label bootcamp wrote would be undone
 * within the tick and the two would fight. What bootcamp CAN say
 * about it is whether the node deserves it, which is the BLOCKED state: a box
 * failing a toolchain prerequisite should not be carrying general CI at all.
 *
 * "I COULD NOT PROBE" IS NOT "THE NODE CANNOT DO IT"
 * -------------------------------------------------
 * An unreachable node leaves its labels ALONE and is reported as unreachable.
 * The alternative — treating a transient ssh timeout as a failed capability —
 * silently strips labels off a healthy fleet, which is the exact shape of the
 * 2026-09-01 outage where two independent mechanisms each removed a label for
 * defensible local reasons and left nothing carrying it.
 *
 * `--write` IS IDEMPOTENT, AND THAT IS A PRODUCTION CONSTRAINT (issue #59)
 * -----------------------------------------------------------------------
 * A write here becomes a COMMIT on hadoku_site — it has to, or the next
 * redeploy erases it (`lib/manifest-target.mjs`). hadoku_site's
 * `redeploy-mgmt-api.yml` has a path filter on the manifest, so a commit
 * restarts the production API. `$capabilities.at` was restamped on every pass,
 * which made every no-op run a commit and every commit a restart. `at` now
 * answers "when did this finding last CHANGE"; a run that re-probed and found
 * the same thing writes nothing and says so.
 *
 * INSTALL ON ASSIGNMENT, BEFORE THE PROBE (#69, wave 3q lane D)
 * ---------------------------------------------------------------
 * A node assigned a capability must be able to RUN the tools that capability
 * needs — `taskauto` runs `claude` from a workflow step — and until this lane
 * nothing installed them; bootcamp was probe-only and `converge-toolchain` a
 * separate manual command. Installing is part of earning the label.
 *
 * NO SECOND LIST. The tools come from `applicableRepairs(node)` (REPAIRS in
 * `lib/toolchain-floor.mjs`), whose `when` is resolved by `nodeOffer` — the one
 * derivation the mint uses. Only tools that DECLARE a `when` are installed here:
 * the fleet-wide set is `converge-toolchain`'s.
 *
 * DETECT FIRST, ON THE STOCK PATH (the tool's own `detect`, never `bash -lc`).
 * An install runs only when detect ANSWERS and says the tool is absent; a node
 * that could not be reached gets no install (the probe reports it unreachable),
 * and an already-correct node gets neither an install nor a write. An install
 * is verified by detecting AGAIN — a script that exits 0 and leaves the tool
 * off the stock PATH is how claw-8 stayed wrong — and a failure is a FINDING
 * carrying its reason, never "earned".
 *
 * JOB PROOFS ARE REPORTED, NEVER WRITTEN OR REQUIRED (wave 3q lane E)
 * ------------------------------------------------------------------
 * A `verify: 'role'` capability such as `taskauto` cannot be proven by a probe,
 * so its registry entry may declare a `jobProof` — the real job that proves it
 * on a node, run by `fleet prove-job`. For every such capability a node carries
 * (the SAME `nodeOffer` derivation as everywhere), this prints the last proof
 * and its age, read from the state directory's `job-proofs.json`.
 *
 * It is deliberately NOT a finding and NOT in `$capabilities`: a missing proof
 * is information, and a proof is a fact about a run that changes every time
 * someone makes one — recording it in the manifest would make every proof a
 * commit and every commit an mgmt-api restart, which is #59 again through a new
 * field. The `--write` record is built from named fields and cannot pick this
 * up; `bootcamp.test.mjs` holds that.
 *
 * A MEASUREMENT THAT MOVES WITH LOAD IS TAKEN IDLE, OR NOT AT ALL (2026-10-10)
 * -------------------------------------------------------------------------
 * `cargo-bevy` is an all-core compile benchmark. claw-4 scored 2281 on
 * 2026-09-14 and 1169 when re-probed beside CI jobs on 2026-10-10; claw-6 1529
 * and 1024. Both fell under the 1200 bar for a reason that was not the box, and
 * the reverse — a node earning on a lucky quiet minute while its neighbour was
 * judged mid-build — is the same unfairness the other way.
 *
 * So for every IDLE-ONLY capability (`measuredIdleOnly`: a `measure` with no
 * `loadInvariant`) the probe also reports `LOAD` — the most live
 * `Runner.Worker`s it saw while measuring — and `judgeMeasurement` judges the
 * number only when that is a counted zero. `--write` re-takes a busy
 * measurement on a node it has DRAINED and waited out, one node at a time
 * (lib/bootcamp-idle.mjs's `runIdlePass2`, `underIdleHold` in
 * lib/proof-drain.mjs). Anything still not measured idle is INCONCLUSIVE: the
 * record on disk stands for that capability, nothing new is written for it,
 * and the run says so — a finding under `--write`, a note without it.
 *
 * USAGE
 *   fleet bootcamp                 # every managed node: probes and reports.
 *                                  # NOT a dry run for REVOCATIONS — a label this
 *                                  # run saw FAIL is withheld from routing at once,
 *                                  # with or without --write (see lib/bootcamp-revoke.mjs's
 *                                  # `computeRevocationChanges`). --write is what gates
 *                                  # the `$capabilities` facet alone.
 *   fleet bootcamp --machine claw-5   # one node (a bare positional is refused)
 *   fleet bootcamp --write         # ALSO record `$capabilities` on every node
 *                                  # reached (drains, one at a time, any node
 *                                  # whose idle-only measurement ran beside a job)
 *   fleet bootcamp --write --idle-wait 20   # give up on quiet after 20 min, not 45
 *   fleet bootcamp --json
 *   fleet bootcamp --prove                # also canary every workload-gated
 *                                          # capability a node just earned the
 *                                          # tool for (wave 4e, #102); records
 *                                          # `$proof` through `fleet prove-job`
 *   fleet bootcamp --prove --due 30       # re-canary only past this many days
 *                                          # (default: `WORKLOAD_PROOF_DUE_DAYS`,
 *                                          # the same 30-day cadence the GATE
 *                                          # itself uses)
 *
 * SPLIT ACROSS FILES (wave 5p lane D, parameterizing restructure): PASS 1's
 * `probe`/`ensureTools` stay here — they are the two places this file calls
 * `runOn`, and `scripts/lib/expected-down-guard.test.mjs` scans only top-level
 * `scripts/*.mjs` files for that pairing with `deferralFor`, which also stays
 * here. Everything else — PASS 1's orchestration, PASS 2's idle re-measure,
 * PASS 3's judging, the revocation write, the workload canary and the
 * `--write` manifest write — lives in `scripts/lib/bootcamp-*.mjs`, taking
 * this file's flags and run-scoped state through one `ctx` object built once,
 * below. No lib imports this file.
 *
 * @guards scripts/capability-probe.sh
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
	loadManifest,
	machineArg,
	repairContext,
	runOn,
	selectMachines,
} from './lib/fleet-exec.mjs';
import { capability, measuredIdleOnly } from '../dist/lib/capability-registry.js';
import { probeableIds } from '../dist/lib/capability-labels.js';
import { WORKLOAD_PROOF_DUE_DAYS } from '../dist/lib/workload-gate.js';
import { stateDir } from '../dist/lib/fleet-paths.js';
import { readProofs } from './lib/job-proof-record.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { dataEndpointUrl, probeScript, serviceStateRoot, unprobed } from './lib/probe-script.mjs';
import { createEmitter, keepStdoutWhole } from './lib/emit.mjs';
import {
	applicableRepairs,
	installScript,
	isVersionManaged,
	probeRole,
	repairNeedsRoot,
} from './lib/toolchain-floor.mjs';
import { resolveInstallTarget } from './lib/tool-release.mjs';
import { maySudo, rootAdvisory } from './lib/operator-sudo.mjs';
import { reasonOf, releaseLookup } from './lib/bootcamp-tool-support.mjs';
import { defaultSeedDeps } from './lib/capability-seeds-live.mjs';
import { DRAIN_TIMEOUT_MS, POLL_MS, SETTLE_MS } from './lib/drain-wait.mjs';
import { parseLoad } from './lib/probe-readers.mjs';

import { runPass1 } from './lib/bootcamp-probe.mjs';
import { runIdlePass2 } from './lib/bootcamp-idle.mjs';
import { runPass3 } from './lib/bootcamp-judge.mjs';
import { computeRevocationChanges } from './lib/bootcamp-revoke.mjs';
import { proveWorkloads, printProveResults } from './lib/bootcamp-canary.mjs';
import { printReport } from './lib/bootcamp-report-print.mjs';
import { writeManifestFacet } from './lib/bootcamp-write.mjs';
import { SITE_WRITER_ENV, siteWriterDir } from './lib/manifest-target.mjs';

// --site-writer: record through the fleet's own writer tree (a fresh
// origin/main worktree it owns, lib/manifest-target.mjs `siteWriterDir`), the
// way the toolchain cycle's re-bootcamp does. For the scheduled `ci:bootcamp`:
// run from ~/srv, a plain --write resolves the deploy tree and is refused there,
// and the record placement reads would never be refreshed (2026-11-04: claw-8
// probed service-host=ok for hours while its record still lacked it).
if (process.argv.includes('--site-writer')) {
	process.env.FLEET_MANIFEST_DIR = siteWriterDir();
	Object.assign(process.env, SITE_WRITER_ENV);
}

// STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
// and on a pipe `process.exit` throws away whatever the stream still had
// queued — measured on this host, 149,133 bytes in and 146,176 out, which
// `JSON.parse` then rejects mid-string. `keepStdoutWhole` puts fd 1 in
// blocking mode so there is nothing left to lose. Issue #33; the shared
// emitter calls the same function for the scripts that use it.
keepStdoutWhole();

const DATA = dataEndpointUrl();
const UNPROBED = unprobed(DATA);

const lookup = releaseLookup();

/**
 * Earned capabilities come with their artifacts (#102, wave 4c lane E). The
 * real {ssh, gh} pair every real invocation uses; nothing here has a test seam
 * of its own — `bootcamp.test.mjs` shims `ssh` and `gh` on PATH the same way
 * it already shims `ssh` for the probe and the claude installer.
 */
const seedDeps = defaultSeedDeps();

const JSON_OUT = process.argv.includes('--json');
const WRITE = process.argv.includes('--write');
// STOP AT THE COMMIT. `manifest-target.mjs` explains the push and its
// fast-forward guard; this flag is for an operator reviewing a capability
// record before it reaches main, and for every test in this repo — a test of a
// writer that pushes is a test that mutates a real repository.
const NO_PUSH = process.argv.includes('--no-push');
// `--machine`, THE ONE SPELLING — not the first bare positional.
//
// This read `argv.find(a => !a.startsWith('--'))`, which made
// `bootcamp --machine claw-7` work BY ACCIDENT: `--machine` was skipped as a
// flag and its VALUE happened to be the first positional. The same parser reads
// `--machine=claw-7` as no scope at all, and this command takes `--write` — so
// one equals sign turned "record what claw-7 proved" into "record for every
// node in the fleet", silently.
//
// `fleet provision` REFUSES a bare positional with a paragraph explaining that
// a positional is ignored and silently widens the blast radius. Two subcommands
// of one CLI cannot disagree about that.
// `--due <n>` (wave 4e, `--prove`'s own freshness window) is the one OTHER
// value-taking flag this command has ever had — `machineArg`'s stray-argument
// guard does not know about it unless told, or `--due 30` reads as a bare
// positional node name and is refused.
const ONLY = machineArg(process.argv.slice(2), { valueFlags: ['--due', '--idle-wait'] });

/**
 * `--prove` (wave 4e, #102): after the tool probe above, run the REAL
 * workload canary for every capability a node just earned the tool for and
 * record `$proof`. Never implied by `--write` or any other flag: a canary
 * spends Actions minutes and a runner slot and — until it finishes — holds a
 * node out of normal placement, so it is an explicit, deliberate act the same
 * way `fleet prove-job` itself is. `--due <days>` is this run's OWN freshness
 * threshold for deciding whether an EXISTING pass is worth re-proving, in the
 * `fleet benchmark --due <n>` shape; it does not change `nodeOffer`'s 30-day
 * gate cadence (`WORKLOAD_PROOF_DUE_DAYS`), which is a property of the
 * REGISTRY, not of one run's patience.
 */
const PROVE = process.argv.includes('--prove');
/**
 * `--check-only`: probe and judge every node, INSTALL AND SEED NOTHING. The
 * default installs missing tools and seeds artifacts, which made `fleet
 * provision`'s "DRY RUN" install packages through its verify step (2026-10-25
 * audit). Capabilities are still EXECUTED here: verifying by execution is the
 * point of a verify pass.
 */
const CHECK_ONLY = process.argv.includes('--check-only');
const dueFlagAt = process.argv.indexOf('--due');
const DUE_DAYS =
	dueFlagAt > -1 && Number.isFinite(Number(process.argv[dueFlagAt + 1]))
		? Number(process.argv[dueFlagAt + 1])
		: WORKLOAD_PROOF_DUE_DAYS;
const PROVE_JOB_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'prove-job.mjs');

/**
 * How long `--write` waits for a node to go quiet before an idle-only
 * measurement is called INCONCLUSIVE — `--idle-wait <minutes>`, default the
 * same 45 minutes the refresh cycle and `--prove` give a drain.
 *
 * TEST SEAM. `FLEET_TEST_IDLE_TIMING` is unset in every real invocation. The
 * fixtures in `bootcamp.test.mjs` cannot wait out `SETTLE_MS` (90 s, a fast-loop
 * tick and a half) per test, so they hand in `{"pollMs","settleMs","timeoutMs"}`
 * as JSON — the same canned-file shape `FLEET_TEST_RELEASE_LOOKUP` uses.
 */
const idleWaitAt = process.argv.indexOf('--idle-wait');
const IDLE_TIMING = {
	pollMs: POLL_MS,
	settleMs: SETTLE_MS,
	timeoutMs:
		idleWaitAt > -1 && Number.isFinite(Number(process.argv[idleWaitAt + 1]))
			? Number(process.argv[idleWaitAt + 1]) * 60_000
			: DRAIN_TIMEOUT_MS,
	...(process.env.FLEET_TEST_IDLE_TIMING ? JSON.parse(process.env.FLEET_TEST_IDLE_TIMING) : {}),
};

// ONE stdout writer (lib/emit.mjs), because ci:bootcamp parses `--json`: human
// lines go to stderr in that mode, with the provenance banner naming the tree
// and install that answered, and the document is the only thing on stdout.
const emitter = createEmitter({ argv: process.argv });
const log = (m) => emitter.log(m);

/**
 * ELIGIBILITY is the fast loop's to write, never bootcamp's. See the header.
 */
const NEVER_WRITTEN = new Set(
	[...probeableIds(), 'hadoku-builder'].filter((id) => capability(id)?.kind === 'eligibility')
);

/**
 * A probe that printed PROBE-END ran to completion; anything else is silence.
 *
 * `phase` is `capability-probe.sh`'s `CAP_PROBE_PHASE`: `all` (the default,
 * and what every other caller runs), `presence` (everything but the idle-only
 * measurements) or `measured` (only those). Returns the CAP verdicts and the
 * LOAD the probe observed while measuring.
 *
 * STAYS HERE, not in a lib: this is one of the two places bootcamp calls
 * `runOn` (see the header's SPLIT ACROSS FILES note), and is handed to
 * `lib/bootcamp-probe.mjs` and `lib/bootcamp-idle.mjs` through `ctx.probe`.
 */
async function probe(node, phase = 'all') {
	const r = await runOn(
		node,
		probeScript(phase, DATA, { stateRoot: serviceStateRoot(manifest.machines[node]) }),
		{
			as: 'ci',
			timeoutMs: 180_000,
		}
	);
	if (!r.ok && !r.stdout.includes('PROBE-END')) return null;
	const caps = {};
	for (const line of r.stdout.split('\n')) {
		const [tag, cap, ok, ...rest] = line.trim().split(/\s+/);
		if (tag === 'CAP') caps[cap] = { ok: ok === 'ok', detail: rest.join(' ') };
	}
	return { caps, load: parseLoad(r.stdout) };
}

const manifest = loadManifest();

/** The backstop is bootcamped like any claw: installed, probed, drained to measure. */
const nodes = selectMachines(manifest, { only: ONLY });
if (!nodes.length) {
	console.error(`[bootcamp] no managed node matches ${ONLY ?? '(any)'}`);
	process.exit(1);
}
/** Prerequisites every managed node must hold, declared once in the manifest. */
const REQUIRED = manifest.toolchain?.capabilities ?? [];

const report = {};
/** Judged executions of routing labels, applied once after every node answers. */
const revocationVerdicts = [];
const unreachable = [];
/** node -> [{id, action: 'present' | 'installed' | 'failed', detail}] */
const toolResults = {};
/** node -> [{id, status, ...}] — see `capability-seeds.mjs`'s `seedNode`. */
const seedResultsByNode = {};

/**
 * Install every capability-scoped tool this node is assigned and does not yet
 * carry. See the header. Never throws: a failure is a result.
 *
 * A VERSION-MANAGED TOOL (`claude`) IS NEVER INSTALLED WITHOUT A RESOLVED
 * VERSION (issue #70). This used to call `installScript(id)` bare, which for
 * `claude` meant whatever the vendor had published an hour ago — bootcamp is
 * the one path that puts a tool on a FRESH node, so that was the install the
 * 7-day debounce exists to prevent. The target now comes from
 * `resolveInstallTarget`, the SAME resolver the refresh cycle uses. A lookup
 * that could not say what to install is a FAILURE, carrying the reason —
 * never a silent fall-through to `installScript(id)`'s bare form, which
 * `installScript` itself now refuses for a version-managed tool anyway.
 *
 * STAYS HERE, not in a lib — see `probe`'s own note above.
 */
async function ensureTools(name, m) {
	const results = [];
	for (const [id, tool] of applicableRepairs(m)) {
		if (!tool.when) continue;
		// `true` makes an ABSENT tool exit 0, so a non-ok result means the node did
		// not answer — which is the probe's to report, not a reason to install.
		const role = probeRole(tool);
		const detect = () => runOn(name, `${tool.detect}\ntrue`, { as: role, timeoutMs: 60_000 });
		const has = (r) => r.ok && /^OK$/m.test(r.stdout);
		const before = await detect();
		if (!before.ok) continue;
		if (has(before)) {
			results.push({ id, action: 'present', detail: `detected on the stock PATH` });
			continue;
		}
		// Root work where the fleet has no sudo (the backstop) is the operator's.
		if (!maySudo(m) && repairNeedsRoot(id, 'install', m)) {
			const a = rootAdvisory(name, `installing ${id}`, `fleet bootcamp --machine ${name}`);
			results.push({ id, action: 'advisory', detail: a.message, fix: a.fix });
			continue;
		}
		let version;
		if (isVersionManaged(tool)) {
			const resolved = await resolveInstallTarget(tool, { lookup });
			if (resolved.status !== 'known') {
				results.push({
					id,
					action: 'failed',
					detail: `could not determine the debounced release to install: ${resolved.reason}`,
				});
				continue;
			}
			version = resolved.version;
		}
		const ran = await runOn(name, installScript(id, version, repairContext(name, manifest)), {
			as: 'admin',
			timeoutMs: 600_000,
		});
		if (!ran.ok) {
			results.push({ id, action: 'failed', detail: `install failed: ${reasonOf(ran)}` });
			continue;
		}
		const after = await detect();
		results.push(
			has(after)
				? { id, action: 'installed', detail: `installed for ${tool.when}` }
				: {
						id,
						action: 'failed',
						detail:
							'install ran but the tool is still not detectable on the stock PATH' +
							(after.ok ? '' : `: ${reasonOf(after)}`),
					}
		);
	}
	return results;
}

/** The proof ledger, read once. An unreadable one is SAID, never read as "no proofs". */
const proofLedger = readProofs(stateDir());

/**
 * IDLE-ONLY capabilities (2026-10-10): measured, and the measurement moves with
 * load — `cargo-bevy`'s all-core compile benchmark. The registry's answer
 * (`measuredIdleOnly`), never a list here.
 */
const IDLE_ONLY = [...probeableIds()].filter((id) => measuredIdleOnly(capability(id)));

/** node -> { caps, load } — what the probe answered, merged across both passes. */
const probed = {};
/** node -> the idle hold's outcome, for every node `--write` tried to hold. */
const idleHolds = {};

// ONE CONTEXT OBJECT, handed into every lib function EXPLICITLY — never a
// reverse import (see the header's SPLIT ACROSS FILES note, and the
// check-label-floor.mjs precedent this follows).
const ctx = {
	JSON_OUT,
	WRITE,
	NO_PUSH,
	PROVE,
	CHECK_ONLY,
	DUE_DAYS,
	IDLE_TIMING,
	PROVE_JOB_SCRIPT,
	log,
	UNPROBED,
	manifest,
	nodes,
	REQUIRED,
	NEVER_WRITTEN,
	IDLE_ONLY,
	report,
	revocationVerdicts,
	unreachable,
	toolResults,
	seedResultsByNode,
	probed,
	idleHolds,
	proofLedger,
	seedDeps,
	probe,
	ensureTools,
	findings: 0,
};

// PASS 1 — every node at once: install, then probe.
await runPass1(ctx);

// PASS 2 — `--write` re-takes every idle-only measurement beside a live job.
await runIdlePass2(ctx);

// PASS 3 — judge, and seed what was earned.
await runPass3(ctx);

const revocationChanges = computeRevocationChanges(ctx);

const proveResults = await proveWorkloads(ctx);

printReport(ctx);

// UNREACHABLE IS A FINDING, NEVER A PASS, AND NEVER A DEMOTION.
//
// The one exception is a node a human deliberately powered off: `fleet drain
// --kind maintenance` is a dated, written, human decision, and it expires. Those
// are printed but not counted. Everything else here is unchanged — in
// particular a deferred node's labels are left ALONE exactly as an unreachable
// one's are, because "held out of service" is still not "it cannot do it".
//
// STAYS HERE, not in a lib: this is the other half of the pairing
// `expected-down-guard.test.mjs` scans top-level `scripts/*.mjs` files for —
// `probe`/`ensureTools` above call `runOn`, and this is where that same file
// asks `deferralFor`.
if (!proofLedger.ok) {
	// Uncounted: the node is not at fault. But "no proof line" would read as "nothing to say".
	log(`\n· job-proof ledger unreadable — proofs not reported: ${proofLedger.reason}`);
}

const _drains = readDrains();
const _deferred = unreachable.filter((n) => deferralFor(n, _drains).deferred);
const _reallyUnreachable = unreachable.filter((n) => !deferralFor(n, _drains).deferred);
if (_deferred.length) {
	for (const n of _deferred) log(`\n· ${deferralNote(n, deferralFor(n, _drains))} — not probed`);
}
if (_reallyUnreachable.length) {
	ctx.findings += _reallyUnreachable.length;
	log(`\n✗ could not probe: ${_reallyUnreachable.join(', ')}`);
	for (const n of _reallyUnreachable) {
		for (const t of (toolResults[n] ?? []).filter((x) => x.action !== 'present')) {
			if (t.action === 'failed') ctx.findings++;
			log(`  ${n}: ${t.action} ${t.id} — ${t.detail}`);
		}
	}
	log(`  Their labels were left ALONE. "I could not look" is not "it cannot do it";`);
	log(`  treating a timeout as a failed capability strips labels off a healthy fleet.`);
}

const written = await writeManifestFacet(ctx);

printProveResults(ctx, proveResults);

if (emitter.json)
	emitter.emit({
		ok: ctx.findings === 0,
		report,
		unreachable,
		tools: toolResults,
		seeds: seedResultsByNode,
		revocations: revocationChanges,
		written,
		...(proofLedger.ok ? {} : { jobProofLedgerError: proofLedger.reason }),
		...(PROVE ? { prove: proveResults } : {}),
	});
else if (!ctx.findings) log(`\n✓ every declared label is backed by a passing probe`);

process.exit(ctx.findings ? 1 : 0);
