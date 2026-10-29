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
 * `src/capabilities.ts`'s `nodeOffer` derives a node's GitHub label set from —
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
 * the fast loop is its writer (the backstop, on a guest) — it adds and removes
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
 * the fleet-wide set is `converge-toolchain`'s, and a guest is never touched
 * (`applicableRepairs` is empty for one, and the role filter below runs first).
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
 * (PASS 2 below, `underIdleHold` in lib/proof-drain.mjs). Anything still not
 * measured idle is INCONCLUSIVE: the record on disk stands for that capability,
 * nothing new is written for it, and the run says so — a finding under
 * `--write`, a note without it. A guest is never drained, and keeps its record.
 *
 * USAGE
 *   fleet bootcamp                 # every managed node, report only
 *   fleet bootcamp --machine claw-5   # one node (a bare positional is refused)
 *   fleet bootcamp --write         # record `$capabilities` on every node reached
 *                                  # (drains, one at a time, any node whose
 *                                  # idle-only measurement ran beside a job)
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
 * @guards scripts/capability-probe.sh
 */
import { canaryPlan, OWN_DRAIN_REASON_PREFIX, underIdleHold } from './lib/proof-drain.mjs';
import { carryMeasurements, measuredValue, parseLoad } from './lib/idle-measure.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
	loadManifest,
	machineArg,
	runOn,
	selectMachines,
	separateCiUser,
} from './lib/fleet-exec.mjs';
import {
	capability,
	judgeMeasurement,
	measuredIdleOnly,
	nodeOffer,
	probeableIds,
	workloadGatedCapabilities,
	WORKLOAD_PROOF_DUE_DAYS,
} from '../dist/capabilities.js';
import { isGuestNode } from '../dist/lib/node-role.js';
import { readProof } from '../dist/lib/measured.js';
import { manifest as manifestPath, stateDir } from './lib/paths.mjs';
import {
	applyVerdicts,
	readRevocations,
	writeRevocations,
} from '../dist/capability-revocations.js';
import { describeProof, proofKey, readProofs } from './lib/job-proof-record.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { dataEndpointUrl, probeScript, unprobed } from './lib/probe-script.mjs';
import { renderJson } from './lib/prettier-json.mjs';
import { landWrite, landingLine, refusalLine, writeTarget } from './lib/manifest-target.mjs';
import { sameCapabilityRecord } from './lib/bootcamp-required.mjs';
import { keepStdoutWhole } from './lib/emit.mjs';
import {
	applicableRepairs,
	installScript,
	isVersionManaged,
	probeRole,
	qualifiesForCanary,
	resolveInstallTarget,
} from './lib/toolchain-floor.mjs';
import { createReleaseLookup } from './lib/tool-release.mjs';
import { defaultSeedDeps, isSeedFinding, seedNode } from './lib/capability-seeds.mjs';
import {
	busyCount,
	createLiveDeps,
	DRAIN_TIMEOUT_MS,
	POLL_MS,
	SETTLE_MS,
	waitUntilDrained,
} from './lib/refresh-cycle.mjs';

// STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
// and on a pipe `process.exit` throws away whatever the stream still had
// queued — measured on this host, 149,133 bytes in and 146,176 out, which
// `JSON.parse` then rejects mid-string. `keepStdoutWhole` puts fd 1 in
// blocking mode so there is nothing left to lose. Issue #33; the shared
// emitter calls the same function for the scripts that use it.
keepStdoutWhole();

const DATA = dataEndpointUrl();
const UNPROBED = unprobed(DATA);

/**
 * ONE release lookup for the whole run, shared by every node's `ensureTools`
 * call so a fleet-wide bootcamp asks npm once per tool rather than once per
 * node (the same per-run sharing `createReleaseLookup` gives the refresh
 * cycle).
 *
 * TEST SEAM. In every real invocation this is `createReleaseLookup()` — the
 * npm registry, for real; `FLEET_TEST_RELEASE_LOOKUP` is unset. The fixtures
 * in `bootcamp.test.mjs` run offline and must not depend on reaching the
 * registry to stay deterministic, so they point this at a JSON file holding
 * one canned `resolveInstallTarget`-shaped answer
 * (`{"status":"known","version":"...","publishedAt":"..."}` or
 * `{"status":"unknown","reason":"..."}`), the same shape `lookupLatest`
 * returns.
 */
function releaseLookup() {
	const fixture = process.env.FLEET_TEST_RELEASE_LOOKUP;
	if (!fixture) return createReleaseLookup();
	const canned = JSON.parse(readFileSync(fixture, 'utf8'));
	return async () => canned;
}
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
 * audit). Capabilities are still EXECUTED here, unlike a guest's presence-only
 * check: verifying by execution is the point of a verify pass.
 */
const CHECK_ONLY = process.argv.includes('--check-only');
const installsOn = (name) => !CHECK_ONLY && !checkOnly.has(name);
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

const out = [];
const log = (m) => (JSON_OUT ? out.push(m) : console.log(m));

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
 */
async function probe(node, phase = 'all') {
	const r = await runOn(node, probeScript(phase, DATA), {
		as: 'ci',
		timeoutMs: 180_000,
		includeGuests: checkOnly.has(node),
	});
	if (!r.ok && !r.stdout.includes('PROBE-END')) return null;
	const caps = {};
	for (const line of r.stdout.split('\n')) {
		const [tag, cap, ok, ...rest] = line.trim().split(/\s+/);
		if (tag === 'CAP') caps[cap] = { ok: ok === 'ok', detail: rest.join(' ') };
	}
	return { caps, load: parseLoad(r.stdout) };
}

const manifest = loadManifest();

/**
 * A GUEST IS NEVER BOOTCAMPED. Skipped by ROLE, never by name.
 *
 * "I do NOT want hokon being impacted by the fleet chain" (operator,
 * 2026-09-14). Bootcamp is the fleet chain at full stretch: it runs the same
 * probe `fleet capabilities` runs — compiling on every core, launching a
 * browser, encoding with ffmpeg — and then, under `--write`, records a verdict
 * about the box on the fleet's manifest.
 *
 * AND SINCE 2026-09-26 THE LOAD HALF IS THE SHARP ONE. `pm2-capable` proves the
 * supervisor by PROVISIONING one: it npm-installs pm2 into a throwaway prefix,
 * starts a process, kills the daemon, resurrects it and removes the lot. On a
 * claw that is 41 MB and five seconds. On the PRODUCTION HOST it would install a
 * second pm2 beside the one supervising mgmt-api, the tunnel and the other production services —
 * sandboxed by `PM2_HOME` and still the single act this fleet has least business
 * performing on a guest. The role filter below is what keeps it off that box,
 * and it is a guard rather than a sentence: `bootcamp.test.mjs` fails if it goes.
 *
 * THE "THE VERDICT WOULD BE WRONG" HALF HAS EXPIRED, and saying so is the point
 * — a justification nobody re-reads is how a comment becomes evidence. Between
 * 2026-09-15 and 2026-09-26 this paragraph read: a guest's labels stay DECLARED,
 * the loop below reports a declared LABEL capability the probe did not prove as
 * `UNEARNED`, and #6 had just made `pm2-host` probe-verified — so probing the
 * guest manufactured that finding against the one label the five infra workflows
 * route on, on the machine that genuinely is the pm2 host. Wave 3o narrowed that
 * probe to "is a pm2 daemon alive here, supervising something", which hokon
 * passes (`ok 24-online`, measured 2026-09-26), and `av1-nvenc` its GPU has
 * always passed. Those are the only two declared-and-probeable labels a guest
 * carries, so the false finding is gone. THE RULE IS UNCHANGED ANYWAY: the
 * reason not to probe a guest is that the fleet is not entitled to, not that the
 * answer would come out wrong. A verdict that happens to come out right is not a
 * reason to go and take it.
 *
 * THIS WAS A COMMENT UNTIL 2026-09-15. The paragraph in the `unclaimed` loop
 * below said bootcamp "must not be pointed at a guest in the first place" and
 * nothing enforced it. CLAUDE.md records four separate times a COMMENT has been
 * read as evidence in this codebase; a comment stating a safety rule with no
 * guard behind it is the fifth. `check-capabilities.mjs` carries the same guard
 * for the same reason, in the same commit's lane.
 */
const selected = selectMachines(manifest, { only: ONLY });
const guests = selected.filter(([, m]) => isGuestNode(m));
/**
 * HOKON IS BOOTCAMPED WHEN NAMED, CHECK-ONLY (operator, 2026-10-09): "totally
 * fine to bootcamp hokon. but i would say dont do all the regular automation. i
 * want to hand approve when new capabilities are install on hokon." So a node
 * with the guest role is probed and recorded only when `--machine` names it —
 * never in a fleet-wide run, which is what the automation does — and nothing is
 * INSTALLED there: `ensureTools` and the capability seeds are skipped for it,
 * and the run says so. An install on hokon is the operator's to approve, by hand.
 */
const checkOnly = new Set(ONLY ? guests.map(([n]) => n) : []);
const nodes = selected.filter(([n, m]) => !isGuestNode(m) || checkOnly.has(n));

/**
 * POINTED AT A GUEST: REFUSE, rather than skip and report a clean run.
 *
 * Someone will type `fleet bootcamp hokon`, and the two wrong answers are a
 * silent no-op (reads as "the guest passed") and a probe (the thing the role
 * forbids). A refusal that names the role is the only one that teaches anything.
 * Separate from the empty-selection message below because they are different
 * jobs: this is a node that exists and is out of scope, that is a name that
 * matches nothing.
 */
if (ONLY && guests.length && !nodes.length && !checkOnly.size) {
	console.error(
		`[bootcamp] ${guests.map(([n]) => n).join(', ')} is a GUEST and is never bootcamped.\n` +
			`  A guest lends the fleet a registration and is otherwise none of the fleet's\n` +
			`  business (operator, 2026-09-14). Its labels are DECLARED — no probe of ours\n` +
			`  settles them — so a bootcamp verdict here would be a finding about evidence\n` +
			`  this fleet is not entitled to gather. Nothing was probed and nothing written.`
	);
	process.exit(1);
}
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

/** The tail of a failed command's output — the reason, not the whole log. */
const reasonOf = (r) =>
	(r.stderr || r.stdout || r.error || 'no output')
		.trim()
		.split('\n')
		.slice(-3)
		.join(' | ')
		.slice(-300);

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
		const ran = await runOn(
			name,
			installScript(id, version, { ciUser: separateCiUser(name, manifest) }),
			{
				as: 'admin',
				timeoutMs: 600_000,
			}
		);
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

/** Last job-proof per job-proofed capability this node carries. Read-only. */
function jobProofsFor(name, m) {
	if (!proofLedger.ok) return [];
	const rows = [];
	for (const id of nodeOffer(m, { eligible: false })) {
		const cap = capability(id);
		if (!cap?.jobProof) continue;
		const entry = proofLedger.proofs[proofKey(name, { capability: id })];
		rows.push({
			id,
			...describeProof(entry, id, name, Date.now()),
			last: entry?.last ?? null,
			lastPass: entry?.lastPass ?? null,
		});
	}
	return rows;
}

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

// PASS 1 — every node at once, exactly as before: install, then probe. A GUEST
// runs the probe's `presence` half: the idle-only measurement is never taken
// there (see PASS 2), so it is not run there either — an all-core compile on
// the production host for a number nobody will use.
await Promise.all(
	nodes.map(async ([name, m]) => {
		// BEFORE THE PROBE, so what the probe executes is what the node now has —
		// except on a check-only node, where nothing is installed.
		if (!installsOn(name)) {
			toolResults[name] = [];
			log(
				CHECK_ONLY
					? `── ${name}  --check-only: nothing will be installed or seeded`
					: `── ${name}  check-only: nothing will be installed here; installs are approved by hand`
			);
		} else {
			toolResults[name] = await ensureTools(name, m);
		}
		const got = await probe(name, checkOnly.has(name) ? 'presence' : 'all');
		if (got === null) {
			unreachable.push(name);
			return;
		}
		probed[name] = got;
	})
);

/**
 * PASS 2 — `--write` RE-TAKES every idle-only measurement PASS 1 took beside a
 * live job, on a node it has DRAINED and waited out. ONE NODE AT A TIME, in
 * manifest order: draining every claw at once to measure them in parallel would
 * stop the fleet's CI for the length of the slowest wait.
 *
 * WHY ONLY THE BUSY ONES. The probe counts live `Runner.Worker`s once a second
 * for the whole measurement (`LOAD`), and a node that read zero throughout WAS
 * idle — the drain is how bootcamp tries to get that zero, not the evidence for
 * it. Draining a node that is already quiet buys nothing and costs a settle.
 *
 * WHY ONLY UNDER `--write`. A drain takes a node out of service; a read-only run
 * that did that would be a surprise to anyone who typed `fleet bootcamp` to
 * look. Without `--write` a busy measurement is reported as unjudged, carried,
 * and not counted — nothing is being recorded on it.
 *
 * A GUEST IS NEVER HELD. `drain-node` refuses a guest without
 * `--include-guests` ("the fleet does not decide its availability for it"),
 * and the hold would not make it idle anyway: a drain gates `hadoku-builder`
 * and placement, but hokon's pm2-host deploys and its ~28 per-repo backstop
 * runners take work the drain does not stop, and a game launch loads every core
 * with no `Runner.Worker` to count. So a guest keeps its previous idle-only
 * verdict, and the run says so.
 */
const hold = { held: null };
if (WRITE) {
	const live = createLiveDeps();
	// A process killed mid-wait must not leave the node out of service. The drain
	// is dated and `fleet drain --status` would show it, but nothing would lift it.
	for (const sig of ['SIGINT', 'SIGTERM']) {
		process.once(sig, () => {
			if (hold.held) live.undrain(hold.held);
			process.exit(sig === 'SIGINT' ? 130 : 143);
		});
	}
	for (const [name] of nodes) {
		const got = probed[name];
		if (!got || checkOnly.has(name)) continue;
		const busyIds = IDLE_ONLY.filter((id) => got.caps[id] && got.load[id] !== 0);
		if (!busyIds.length) continue;
		log(
			`── ${name}  ${busyIds.join(', ')} measured beside a live job — draining to re-measure idle ` +
				`(waits up to ${Math.round(IDLE_TIMING.timeoutMs / 60_000)} min)`
		);
		let outcome;
		try {
			outcome = await underIdleHold(
				name,
				busyIds,
				{
					isDrained: live.isDrained,
					drain: live.drain,
					undrain: live.undrain,
					waitQuiet: (node) =>
						waitUntilDrained({
							node,
							busy: busyCount,
							clock: { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
							...IDLE_TIMING,
						}),
				},
				() => probe(name, 'measured'),
				hold
			);
		} catch (e) {
			outcome = { status: 'inconclusive', reason: `the idle hold failed: ${e.message}` };
		}
		if (outcome.status === 'measured' && outcome.result === null) {
			outcome = {
				...outcome,
				status: 'inconclusive',
				reason: 'unreachable during the idle re-measurement',
			};
		}
		if (outcome.status === 'measured') {
			for (const id of busyIds) {
				const again = outcome.result.caps[id];
				if (!again) continue;
				got.caps[id] = again;
				got.load[id] = id in outcome.result.load ? outcome.result.load[id] : null;
			}
		}
		const { status, reason, heldBy, undrainFailed } = outcome;
		idleHolds[name] = { status, reason, heldBy, undrainFailed, capabilities: busyIds };
	}
}

// PASS 3 — judge, and seed what was earned.
await Promise.all(
	nodes.map(async ([name, m]) => {
		const got = probed[name];
		if (!got) return;
		const { caps, load } = got;
		const declared = new Set(m.labels ?? []);
		// The record ON DISK before this run — observed state, not this process's
		// belief — is what an unjudged measurement keeps.
		const prevEarned = new Set(m.$capabilities?.earned ?? []);
		// ONE judging rule, in the registry, for every capability — see
		// `meetsBar`, and `judgeMeasurement` above it. A binary capability passes
		// on `ok` exactly as before; a MEASURED one (`measure` declared) passes
		// only if the number the probe printed clears the declared bar — and an
		// IDLE-ONLY one is judged at all only if the probe counted zero live jobs
		// while it measured. Bootcamp deliberately does no comparing of its own:
		// the bar has one home, and the next payload capability is a registry
		// entry rather than a branch here.
		const barReason = {};
		const proven = new Set();
		// INCONCLUSIVE: an idle-only capability this run did not judge. It is
		// neither earned nor stripped — whatever the record on disk said stands —
		// and it is SAID. "I could not measure it quietly" is not "it is slow".
		const inconclusive = [];
		/** idle-only ids judged on a quiet node this run, for the record. */
		const judgedIdle = {};
		const heldOut = idleHolds[name]?.status === 'inconclusive' ? idleHolds[name].reason : null;
		for (const [id, v] of Object.entries(caps)) {
			const verdict = judgeMeasurement(capability(id), v.ok, v.detail ?? '', load[id]);
			barReason[id] = verdict.reason;
			if (!verdict.judged) {
				inconclusive.push({
					id,
					reason: heldOut ? `${verdict.reason}; idle re-measure: ${heldOut}` : verdict.reason,
					kept: prevEarned.has(id) ? 'earned' : 'not earned',
				});
				if (prevEarned.has(id)) proven.add(id);
				continue;
			}
			if (measuredIdleOnly(capability(id))) {
				judgedIdle[id] = { value: measuredValue(v.detail), earned: verdict.proven };
			}
			if (verdict.proven) proven.add(id);
		}
		// A GUEST'S idle-only capabilities were never measured (PASS 1 ran the
		// `presence` half there), so they are not in `caps` at all — and must not
		// fall out of `earned` for that.
		if (checkOnly.has(name)) {
			for (const id of IDLE_ONLY) {
				if (caps[id]) continue;
				inconclusive.push({
					id,
					guest: true,
					reason:
						'GUEST: not re-measured — the fleet does not drain a guest, and a drain would not ' +
						'make it idle (its pm2-host deploys and backstop runners take work a drain does not stop); ' +
						'the previous record stands',
					kept: prevEarned.has(id) ? 'earned' : 'not earned',
				});
				if (prevEarned.has(id)) proven.add(id);
			}
		}
		// A capability this controller could not enable was never probed: the
		// record on disk stands, and it is said.
		for (const [id, reason] of Object.entries(UNPROBED)) {
			if (caps[id]) continue;
			inconclusive.push({ id, reason, kept: prevEarned.has(id) ? 'earned' : 'not earned' });
			if (prevEarned.has(id)) proven.add(id);
		}

		// EARNED IS EVERYTHING THE PROBE EXECUTED SUCCESSFULLY (settled
		// 2026-09-10), not `proven ∩ declared` among label capabilities.
		//
		// WHY IT CHANGED. The claw floor's eligibility input is
		// `$capabilities.earned` (`claw-floor-design-2026-09-07.md` §1.1), and
		// under the old rule `av1-nvenc` was the fleet's ONLY earnable label — so
		// `earned` was `[]` on all seven claws while each of them had proved five
		// capabilities, and the field the floor reads said the fleet could do
		// nothing. `earned` is now the node's PROOF SET: one producer, one
		// question, "what has this box demonstrated".
		//
		// REGISTERED IDS ONLY. A `CAP` line with no registry entry is drift
		// `capability-schema`'s probe-drift rule owns; recording it here as earned
		// would make a typo in the probe script read as a capability.
		const earned = [...proven].filter((id) => capability(id)).sort();
		const unjudged = new Set(inconclusive.map((i) => i.id));

		const unearned = [];
		const unclaimed = [];
		const blocked = [];

		// UNCLAIMED/UNEARNED STAY LABEL-SCOPED. They are statements about ROUTING —
		// "capacity the fleet cannot route to", "work routes here and fails" — and
		// a toolchain capability is routable by nothing, so widening them with
		// `earned` would turn every proven tool into a routing finding. Only LABEL
		// capabilities a probe can answer are in scope: a `role` label — today
		// `taskauto`, and `hadoku-builder`, which NEVER_WRITTEN excludes for a
		// second reason — is a decision about what the box is FOR, and no probe
		// can settle it. `pm2-host` LEFT that set on 2026-09-15 (#6): it is
		// probed and therefore earnable here, so a claw that proves it appears as
		// `unclaimed` rather than being invisible. Its guest half is not this
		// loop's to keep — `probeableIds()` is node-blind, so this loop would
		// report a guest's declared `pm2-host` as UNEARNED. What keeps that from
		// happening is the ROLE FILTER at the top of this file, which is a guard
		// and not a sentence: `bootcamp.test.mjs` fails if it is removed.
		for (const id of probeableIds()) {
			const cap = capability(id);
			if (!cap || cap.surface !== 'label' || NEVER_WRITTEN.has(id)) continue;
			const isProven = proven.has(id);
			const isDeclared = declared.has(id);
			// An UNJUDGED measurement says nothing either way, so it cannot make a
			// declared label UNEARNED; the INCONCLUSIVE line carries it instead.
			if (!isProven && isDeclared && !unjudged.has(id)) {
				unearned.push({ id, detail: barReason[id] ?? caps[id]?.detail ?? 'not probed' });
			} else if (isProven && !isDeclared) unclaimed.push(id);
		}
		// PREREQUISITES PROVEN, not just the ones that failed. A PASSES line that
		// lists nothing is a pass with no evidence behind it — the state
		// CLAUDE.md's "exit 0 with no evidence is a failure" rule is about — and
		// on a homogeneous fleet that is most lines: `av1-nvenc` is the only
		// earnable LABEL capability any node holds, so without this the report
		// says almost nothing about the five nodes that are fine.
		const prereqs = [];
		const unprobed = [];
		for (const id of REQUIRED) {
			if (!caps[id]) {
				// Declared required, and the probe never answered. Not a pass and not
				// a failure — the probe and the manifest disagree about what exists,
				// which `capability-schema`'s probe-drift rule exists to catch.
				unprobed.push(id);
				continue;
			}
			if (caps[id].ok) prereqs.push({ id, detail: caps[id].detail });
			else blocked.push({ id, detail: caps[id].detail });
		}
		// EVERY `no` GETS A REASON, INCLUDING THE ONES NOTHING ELSE PRINTS.
		//
		// `unearned` covers a declared LABEL and `blocked` covers a required
		// TOOLCHAIN capability. Between them they leave every `implicit`
		// capability's failure completely silent: `cargo-bevy` below the bar,
		// `cuda` on a box whose DKMS module is not in the running kernel,
		// `pm2-capable` on a node that could not fetch a supervisor — each of them
		// simply ABSENT from `earned`, which is CLAUDE.md's "I could not look must
		// never render as nothing is wrong" one level down. A reader could see
		// THAT a node did not earn something and never WHY, and a firewall, a
		// kernel that has not rebooted and a card that cannot do AV1 are three
		// different jobs.
		//
		// NOT A FINDING. A claw with no GPU is not broken, and an 8 GB box that
		// cannot hold a 9,784 MiB role is not broken either — this is the evidence
		// behind an absence, not a fault.
		//
		// AND DELIBERATELY NOT IN THE `$capabilities` RECORD. `meetsBar`'s reason
		// for a MEASURED capability carries the measurement, and that moves on
		// every pass — `cargo-bevy` prints a fresh throughput figure every run — so
		// recording it would make every re-probe a changed file, every changed file
		// a commit, and every commit an mgmt-api redeploy. That is issue #59
		// exactly, re-entering through a different field. A per-run measurement
		// belongs in the run's own output; the record keeps only what CHANGED.
		// (`measurements`, below, records an idle-only figure WITHOUT reopening
		// this: its entry moves only when that capability's verdict does.)
		const notEarned = [];
		const explained = new Set([
			...unearned.map((u) => u.id),
			...blocked.map((b) => b.id),
			...unjudged,
		]);
		for (const id of probeableIds()) {
			if (proven.has(id) || explained.has(id) || !caps[id] || !capability(id)) continue;
			notEarned.push({ id, detail: barReason[id] ?? caps[id].detail ?? 'no reason given' });
		}
		// REVOCATION VERDICTS (src/capability-revocations.ts): this run EXECUTED
		// these routing labels. A pass clears a revocation — the reboot cycle's
		// re-prove lands here — and a failure revokes one the node was offering.
		// An unjudged measurement moves nothing.
		const offeredBefore = new Set(nodeOffer(m, { eligible: true }));
		for (const id of probeableIds()) {
			const cap = capability(id);
			if (!cap || cap.surface !== 'label' || cap.kind !== 'identity') continue;
			if (!caps[id] || unjudged.has(id)) continue;
			const passed = proven.has(id);
			if (!passed && !offeredBefore.has(id)) continue;
			revocationVerdicts.push({
				node: name,
				capability: id,
				passed,
				reason: passed ? caps[id].detail : (barReason[id] ?? caps[id].detail ?? 'failed'),
			});
		}

		report[name] = {
			earned,
			unearned,
			unclaimed,
			blocked,
			prereqs,
			unprobed,
			notEarned,
			inconclusive,
			measuredIdle: judgedIdle,
			...(idleHolds[name] ? { idleHold: idleHolds[name] } : {}),
			declared: [...declared],
			jobProofs: jobProofsFor(name, m),
		};

		// EARNED CAPABILITIES COME WITH THEIR ARTIFACTS (#102, wave 4c lane E), run
		// unconditionally — like `ensureTools` above, NOT gated behind `--write`.
		// `earned` here is THIS RUN's fresh proof, not the manifest's possibly
		// stale `$capabilities` facet, so the synthetic node below carries it
		// directly rather than asking `seedNode` to re-derive it from `m`.
		seedResultsByNode[name] = !installsOn(name)
			? []
			: await seedNode(name, { ...m, $capabilities: { earned, prereqs } }, manifest, seedDeps);
	})
);

/**
 * Revoke what this run saw fail and clear what it saw pass — one write, after
 * every node answered. An unreadable record is left alone and said: rewriting
 * it from this run's partial view would re-grant whatever it held for nodes
 * this run did not probe.
 */
const revocationChanges = (() => {
	const read = readRevocations(stateDir());
	if (read.corrupt) {
		log(`── revocations: the record is unreadable (${read.why}) — nothing revoked or cleared.`);
		return { revoked: [], cleared: [], unreadable: read.why };
	}
	const applied = applyVerdicts(read.nodes, revocationVerdicts, 'bootcamp');
	if (applied.revoked.length || applied.cleared.length) writeRevocations(stateDir(), applied.nodes);
	for (const v of applied.revoked) {
		log(
			`── ${v.node}  REVOKED ${v.capability} — withheld from routing until a probe passes (${v.reason})`
		);
	}
	for (const v of applied.cleared)
		log(`── ${v.node}  cleared ${v.capability} — proven again, routable`);
	return { revoked: applied.revoked, cleared: applied.cleared };
})();

/**
 * `fleet bootcamp --prove`'s one node/capability attempt: drain, wait for
 * quiet, run the REAL canary through `fleet prove-job` (which records
 * `$proof` itself — see that script's own header), undrain on every path.
 *
 * SHELLS OUT rather than calling `proveJob` in-process, the same way
 * `refresh-cycle.mjs`'s `drainCli` and `benchmark-fleet.mjs`'s cadence already
 * shell out to `drain-node.mjs`: `scripts/prove-job.mjs` already owns the
 * mint/dispatch/teardown orchestration, the in-process host install it needs,
 * and the `$proof` write — reimplementing that here would be a second,
 * untested copy of all three.
 */
async function runCanary(name, id) {
	const live = createLiveDeps();
	let alreadyDrained;
	try {
		alreadyDrained = await live.isDrained(name);
	} catch {
		alreadyDrained = null;
	}
	let busy;
	try {
		busy = busyCount(name);
	} catch {
		busy = null;
	}
	// Busy is a reason to drain and wait, never to skip — see lib/proof-drain.mjs.
	const plan = canaryPlan({ alreadyDrained, busy });
	if (plan.action === 'skip') {
		return { node: name, capability: id, status: 'skipped', reason: plan.reason };
	}
	let drained;
	try {
		drained = live.drain(name, {
			kind: 'training',
			reason: `${OWN_DRAIN_REASON_PREFIX} ${id} workload canary`,
		});
	} catch (e) {
		return { node: name, capability: id, status: 'skipped', reason: `drain failed: ${e.message}` };
	}
	if (drained?.ok === false) {
		return {
			node: name,
			capability: id,
			status: 'skipped',
			reason: `drain refused: ${drained.reason}`,
		};
	}
	try {
		const wait = await waitUntilDrained({
			node: name,
			busy: busyCount,
			clock: { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
		});
		if (!wait.drained) {
			return {
				node: name,
				capability: id,
				status: 'skipped',
				reason: `never went quiet: ${wait.reason ?? 'timed out'}`,
			};
		}
		let doc = null;
		try {
			const stdout = execFileSync(
				process.execPath,
				[PROVE_JOB_SCRIPT, '--node', name, '--capability', id, '--json', '--under-own-drain'],
				{ encoding: 'utf8', timeout: 45 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] }
			);
			doc = JSON.parse(stdout);
		} catch (e) {
			// `prove-job.mjs` exits non-zero for everything but a pass, and ALWAYS
			// prints its one JSON document first — see its own header. `e.stdout`
			// still carries it; only a truly unparseable run has none.
			try {
				doc = JSON.parse(String(e.stdout ?? ''));
			} catch {
				return {
					node: name,
					capability: id,
					status: 'error',
					reason: `fleet prove-job did not produce JSON: ${e.message}`,
				};
			}
		}
		// An inconclusive canary (it never ran on the node) recorded nothing and
		// is NOT a fail — see `proofConclusive` in src/runners/prove-job.ts.
		if (doc.proofInconclusive) {
			return {
				node: name,
				capability: id,
				status: 'inconclusive',
				runId: doc.runId ?? null,
				reason: doc.proofInconclusive,
			};
		}
		const verdict = doc.proofRecord?.verdict ?? (doc.ok ? 'pass' : 'fail');
		return {
			node: name,
			capability: id,
			status: verdict,
			runId: doc.runId ?? null,
			why: doc.proofRecord?.why ?? doc.findings?.map((f) => f.message).join('; ') ?? null,
		};
	} finally {
		try {
			live.undrain(name);
		} catch {
			// Best effort; a drain this process could not lift expires on its own
			// (`fleet drain` is dated), and the outcome above still names what
			// happened — an undrain failure is not a reason to hide the result.
		}
	}
}

/**
 * Every (node, capability) this run's fresh `earned` set makes a CANDIDATE
 * for a workload canary, skipping anything the CPU pre-filter or an
 * already-fresh pass rules out. Returns one outcome per candidate; empty,
 * always, when `--prove` was not given.
 */
async function proveWorkloads() {
	if (!PROVE) return [];
	const outcomes = [];
	for (const [name, m] of nodes) {
		const r = report[name];
		if (!r) continue; // this run could not reach it at all
		for (const id of workloadGatedCapabilities()) {
			if (!r.earned.includes(id)) continue; // tool not earned here, this run
			if (!qualifiesForCanary(id, m)) {
				outcomes.push({
					node: name,
					capability: id,
					status: 'skipped',
					reason: `CPU floor not met for the canary (cores=${m.cores ?? 'unmeasured'})`,
				});
				continue;
			}
			const existing = readProof(name, id, { dir: stateDir() });
			if (existing?.verdict === 'pass') {
				const ageDays = (Date.now() - Date.parse(existing.at)) / 86_400_000;
				if (Number.isFinite(ageDays) && ageDays <= DUE_DAYS) {
					outcomes.push({
						node: name,
						capability: id,
						status: 'not-due',
						reason: `last pass ${existing.at} (${ageDays.toFixed(1)}/${DUE_DAYS}d)`,
					});
					continue;
				}
			}
			outcomes.push(await runCanary(name, id));
		}
	}
	return outcomes;
}

const proveResults = await proveWorkloads();

let findings = 0;
for (const [name, r] of Object.entries(report).sort()) {
	const failedTools = (toolResults[name] ?? []).filter((t) => t.action === 'failed');
	const seedFindings = (seedResultsByNode[name] ?? []).filter((s) => isSeedFinding(s.status));
	// Under `--write` an unjudged measurement is a run that was asked to record
	// and could not look; without it, nothing was going to be recorded anyway.
	const heldOut = WRITE ? r.inconclusive.filter((i) => !i.guest) : [];
	const verdict =
		r.unearned.length ||
		r.blocked.length ||
		failedTools.length ||
		seedFindings.length ||
		heldOut.length ||
		r.idleHold?.undrainFailed
			? 'FAILS'
			: 'PASSES';
	log(`\n── ${name}  ${verdict}`);
	for (const t of toolResults[name] ?? []) {
		if (t.action === 'failed') {
			findings++;
			log(`   TOOL FAILED: ${t.id} — ${t.detail}`);
		} else if (t.action === 'installed') log(`   installed: ${t.id} — ${t.detail}`);
	}
	for (const s of seedResultsByNode[name] ?? []) {
		if (s.status === 'seeded') {
			log(`   seeded:    ${s.id} — ${s.proof} (pin ${s.pin}, ${s.freeMb} MiB free)`);
		} else if (isSeedFinding(s.status)) {
			findings++;
			log(`   SEED FAILED: ${s.id} — ${s.reason}`);
		} else if (s.status === 'busy') {
			log(`   seed skipped: ${s.id} — a Runner.Worker is live`);
		}
	}
	if (r.prereqs.length) {
		log(`   proven:    ${r.prereqs.map((p) => `${p.id} (${p.detail})`).join(', ')}`);
	}
	if (r.earned.length) log(`   earned:    ${r.earned.join(', ')}`);
	for (const p of r.jobProofs) log(`   ${p.line}`);
	for (const u of r.unearned) {
		findings++;
		log(`   UNEARNED:  ${u.id} — declared here but the probe says: ${u.detail}`);
		log(`              work routes here on that label and fails on arrival.`);
	}
	for (const b of r.blocked) {
		findings++;
		log(`   BLOCKED:   ${b.id} — a toolchain prerequisite this node fails: ${b.detail}`);
		log(`              it should not be carrying general CI until this passes.`);
	}
	for (const n of r.notEarned) {
		// Deliberately lower-case and uncounted: the UPPER-CASE lines above are
		// faults, this is the reason behind an absence.
		log(`   not earned: ${n.id} — ${n.detail}`);
	}
	if (r.idleHold?.status === 'measured') {
		log(
			`   idle re-measure: ${r.idleHold.capabilities.join(', ')} — ` +
				(r.idleHold.heldBy === 'bootcamp'
					? 'drained, waited out, re-measured, undrained'
					: "waited out under someone else's drain (left in place), re-measured")
		);
	}
	if (r.idleHold?.undrainFailed) {
		findings++;
		log(
			`   STILL DRAINED: bootcamp could not lift its own idle-measurement drain: ${r.idleHold.undrainFailed}`
		);
		log(`              the node is out of service until \`fleet drain ${name} --undo\`.`);
	}
	for (const i of r.inconclusive) {
		// LOUD, and never a verdict: the record on disk stands for this capability.
		const kept = `previous record kept (${i.kept})`;
		if (i.guest) log(`   kept (guest): ${i.id} — ${i.reason}; ${kept}`);
		else if (WRITE) {
			findings++;
			log(`   INCONCLUSIVE: ${i.id} — ${i.reason}; ${kept}`);
			log(
				`              nothing new was written for it: a busy measurement neither earns nor strips.`
			);
		} else {
			log(`   not judged: ${i.id} — ${i.reason}; ${kept}`);
			log(
				`              read-only run, nothing recorded; \`--write\` drains the node to re-measure idle.`
			);
		}
	}
	for (const u of r.unclaimed) {
		// NO LONGER "capacity the fleet cannot route to". Since the mint and the
		// reconciler derive a node's label offer from `$capabilities.earned`
		// (`nodeOffer`, issue #19), a proven label IS routed to without anybody
		// declaring it. This line records which ones arrived that way.
		log(`   unclaimed: ${u} — proven here, declared nowhere; routed from \`earned\`, not a label.`);
	}
	for (const id of r.unprobed) {
		findings++;
		log(`   UNPROBED:  ${id} — required of every node, and the probe never answered.`);
		log(`              The manifest and capability-probe.sh disagree about what exists.`);
	}
	if (!r.prereqs.length && !r.earned.length && !r.unearned.length && !r.blocked.length) {
		// Nothing proven AND nothing failed means the probe told us nothing at all.
		findings++;
		log(`   NO EVIDENCE: the probe returned no verdict for any declared capability.`);
	}
}

// UNREACHABLE IS A FINDING, NEVER A PASS, AND NEVER A DEMOTION.
//
// The one exception is a node a human deliberately powered off: `fleet drain
// --kind maintenance` is a dated, written, human decision, and it expires. Those
// are printed but not counted. Everything else here is unchanged — in
// particular a deferred node's labels are left ALONE exactly as an unreachable
// one's are, because "held out of service" is still not "it cannot do it".
// A SKIPPED GUEST IS SAID OUT LOUD, and is not folded into the pass.
//
// Three different answers, and the report must keep them apart: "I looked",
// "I could not look" (unreachable, below — a finding), and "I was not entitled
// to look". The last one is not a finding — nothing is wrong — but a machine
// that vanishes from the report is one nobody can tell was considered, which is
// how the guest role went unenforced here in the first place.
if (!proofLedger.ok) {
	// Uncounted: the node is not at fault. But "no proof line" would read as "nothing to say".
	log(`\n· job-proof ledger unreadable — proofs not reported: ${proofLedger.reason}`);
}
const roleDeclared = Object.fromEntries(
	guests.filter(([name]) => !checkOnly.has(name)).map(([name, m]) => [name, m.labels ?? []])
);
for (const [name, labels] of Object.entries(roleDeclared)) {
	log(
		`\n· ${name}: GUEST — not probed, not written. Its labels are DECLARED: ` +
			`${labels.join(', ') || '(none)'}`
	);
}

const _drains = readDrains();
const _deferred = unreachable.filter((n) => deferralFor(n, _drains).deferred);
const _reallyUnreachable = unreachable.filter((n) => !deferralFor(n, _drains).deferred);
if (_deferred.length) {
	for (const n of _deferred) log(`\n· ${deferralNote(n, deferralFor(n, _drains))} — not probed`);
}
if (_reallyUnreachable.length) {
	findings += _reallyUnreachable.length;
	log(`\n✗ could not probe: ${_reallyUnreachable.join(', ')}`);
	for (const n of _reallyUnreachable) {
		for (const t of (toolResults[n] ?? []).filter((x) => x.action !== 'present')) {
			if (t.action === 'failed') findings++;
			log(`  ${n}: ${t.action} ${t.id} — ${t.detail}`);
		}
	}
	log(`  Their labels were left ALONE. "I could not look" is not "it cannot do it";`);
	log(`  treating a timeout as a failed capability strips labels off a healthy fleet.`);
}

if (WRITE) {
	// THIS NO LONGER WRITES `machines[].labels` AT ALL.
	//
	// It used to append every `unclaimed` capability to the node's `labels`
	// array, which was the right move while a declaration was how a label
	// reached a registration. It is not any more: `nodeOffer` (src/capabilities.ts,
	// issue #19) derives a node's label offer from `$capabilities.earned`, and
	// every mint, warm listener, placement check and reconciled registration
	// reads that one answer. So the facet below is the whole write.
	//
	// It is also now the only SAFE write. Under the 2026-09-10 `earned`
	// semantics a proven capability is any capability the probe executed, and
	// appending those to `labels` would have declared `ffmpeg`, `gh`,
	// `python-venv`, `python-toolcache`, `playwright` and `jitconfig` as GitHub
	// runner labels on all eight machines — which `validateCapabilities`
	// rejects as `surface-mismatch` (a toolchain capability applies to every
	// node, so routing on it says nothing) and which re-introduces exactly the
	// hand-declared labels the 2026-09-07 "derived, never declared" decision
	// removes.
	const mp = manifestPath('fleet-runner-manifest.json');
	// ASKED BEFORE ANYTHING IS WRITTEN, because the refusal this most needs to
	// make — the deploy tree — is one where the write SUCCEEDS and is erased
	// later. See `lib/manifest-target.mjs`: a read-back cannot catch that, only
	// refusing the target can.
	const target = writeTarget(mp);
	if (!target.ok) {
		log(refusalLine(target, { writer: 'bootcamp', file: mp }));
		findings++;
	} else {
		const raw = JSON.parse(readFileSync(mp, 'utf8'));
		let recorded = 0;
		// CHANGED, not merely re-probed. See the `sameCapabilityRecord` block below.
		let changed = 0;
		const at = new Date().toISOString();
		for (const [name, r] of Object.entries(report)) {
			const node = raw.machines?.[name];
			if (!node) continue;
			// THE SUPPLY LEDGER'S CAPABILITY FACET — P1.1. `$benchmark` (fleet
			// benchmark) and `$measured` (fleet enroll) already write a
			// `{at, by, ...}` block straight onto this same machine entry; nothing
			// did that for what bootcamp proves, so the earned/blocked/unprobed
			// verdict lived only in a run's stdout and the manifest kept the
			// labels a human had asserted, with no record of when — or whether —
			// they were last checked. This is written for EVERY node this run
			// could reach, not only the ones with something new to report, because
			// it is a snapshot of what the probe found, not a diff. A node this
			// run could not reach keeps whatever `$capabilities` it already had
			// rather than being overwritten with silence — "I could not look" must
			// not read as "nothing is here". See
			// docs/planning/supply-ledger-2026-09-07.md.
			const prev = node.$capabilities;
			// THE IDLE MEASUREMENT BEHIND EACH IDLE-ONLY VERDICT (2026-10-10):
			// `{ value, idle: true, earned, at }`, so a reader can tell an earn
			// taken on a quiet node from one that predates the rule (no entry). It
			// moves only when the verdict does — `carryMeasurements` says why
			// (#59) — and an unjudged run leaves it exactly as it was.
			const measurements = carryMeasurements(prev, r.measuredIdle, at);
			const record = {
				at,
				by: 'fleet bootcamp',
				declared: r.declared,
				earned: r.earned,
				unclaimed: r.unclaimed,
				unearned: r.unearned,
				blocked: r.blocked,
				prereqs: r.prereqs,
				unprobed: r.unprobed,
				...(Object.keys(measurements).length ? { measurements } : {}),
			};
			// `at` MEANS "WHEN THIS FINDING LAST CHANGED", NOT "WHEN WE LAST LOOKED".
			//
			// Issue #59. The stamp above is fresh on every pass, so a node whose
			// probe returned exactly what it returned last time still produced a
			// changed file — and this writer LANDS ITS WRITES AS COMMITS on
			// hadoku_site (`manifest-target.mjs`, and it has to: a write there that
			// is not a commit is erased by the next redeploy). hadoku_site's
			// `redeploy-mgmt-api.yml` filters on this exact path, so every
			// no-op bootcamp restarted the production API. Observed on claw-9,
			// 2026-09-23: `538c9d00` and `3faeb8fe`, eleven minutes apart, one
			// changed line each, and the line was `at`.
			//
			// Carrying the PREVIOUS `at` forward when nothing else moved is what
			// makes the write byte-identical, which is what makes `landWrite`
			// report `unchanged` and commit nothing. "When did we last look" is
			// still answered — on stdout, below, where a run's own bookkeeping
			// belongs.
			//
			// AND THE GATE READS OBSERVED STATE, not this writer's intent
			// (CLAUDE.md): the comparison is against what is ON DISK in the
			// manifest, not against a record this process wrote earlier.
			if (sameCapabilityRecord(prev, record)) record.at = prev.at;
			else changed++;
			node.$capabilities = record;
			recorded++;
		}
		if (recorded && !changed) {
			// RE-PROBED AND IDENTICAL. Not "nothing to write" — every node this run
			// reached was read, and the record already in the manifest is the record
			// this run would have written. Saying so is the point: a run that goes
			// quiet here is indistinguishable from one that probed nobody, which is
			// the "exit 0 with no evidence" shape this repo refuses everywhere else.
			log(
				`\n✓ ${recorded} capability record(s) re-probed and UNCHANGED — nothing written, ` +
					`nothing committed.\n` +
					`  \`$capabilities.at\` still reads when each finding last CHANGED, not when it ` +
					`was last checked;\n` +
					`  restamping it on every pass is what made an idempotent run redeploy mgmt-api (#59).`
			);
		} else if (recorded) {
			// FORMATTED THE WAY THE OWNING REPO WOULD (#12), which is not optional for
			// a file that lives in hadoku_site's checkout rather than this one.
			//
			// This wrote `JSON.stringify(raw, null, 2)` until 2026-09-14 — the same
			// bypass #12 removed from `fleet benchmark --write` and `fleet doctor
			// --write`, left in place here because each writer was individually
			// correct about the facet it records. hadoku_site's prettier keeps a
			// short array inline (`printWidth: 100`) and `JSON.stringify` expands
			// every one of them, so a run that added eight `$capabilities` blocks
			// rewrote hundreds of lines it had not touched, buried the record an
			// operator is trying to review, and left that checkout failing its own
			// `format:check`.
			//
			// `renderJson` never throws and never pretends: with no prettier
			// resolvable from the target's tree it returns `formatter: null` and
			// plain output, and the caller owes the operator that fact — losing a
			// probe that cost seven boxes three minutes over a formatting problem
			// would be the wrong trade, and so would claiming the write was clean.
			const rendered = await renderJson(raw, mp);
			copyFileSync(mp, `${mp}.bak`);
			writeFileSync(mp, rendered.text);
			// Read it back — a manifest the loader cannot parse takes the fleet
			// down at the next tick, and checking costs nothing here. Same guard
			// benchmark-fleet.mjs runs after its own write.
			JSON.parse(readFileSync(mp, 'utf8'));
			log(
				`\n✓ wrote ${changed} changed capability record(s) of ${recorded} re-probed — ` +
					'`$capabilities` only, never `labels`; backup alongside the manifest'
			);
			if (rendered.formatter) log(`  formatted by ${rendered.formatter}`);
			else
				log(
					`  ! UNFORMATTED: no prettier could be resolved from ${mp}'s own tree, so this is plain\n` +
						`    JSON.stringify output. The records are correct and saved; the owning repo's\n` +
						`    format:check will very likely reject the file until it is run through prettier there.`
				);
			// AND NOW MAKE IT SURVIVE. Everything above — renderJson, the .bak, the
			// parse-back — was already true of the write that was erased 40 seconds
			// later on 2026-09-14. The commit is the only part of this that a
			// redeploy cannot undo.
			const landed = landWrite(mp, {
				writer: 'bootcamp',
				// THE SUBJECT COUNTS WHAT MOVED. `${recorded}` here read "for 1 node(s)"
				// on a commit whose only changed line was a timestamp (#59).
				summary: `$capabilities for ${changed} node(s)`,
				push: !NO_PUSH,
			});
			log(landingLine(landed, { writer: 'bootcamp' }));
			if (!landed.ok) findings++;
		} else {
			log(`\n  nothing to write — no node reachable`);
		}
	}
}

if (proveResults.length) {
	log('\n── workload canaries (--prove) ──');
	for (const p of proveResults) {
		if (p.status === 'pass') log(`   PASS: ${p.capability}@${p.node} — ${p.why ?? ''}`);
		else if (p.status === 'fail') {
			findings++;
			log(`   FAIL: ${p.capability}@${p.node} — ${p.why ?? 'no reason given'}`);
		} else if (p.status === 'error') {
			findings++;
			log(`   ERROR: ${p.capability}@${p.node} — ${p.reason}`);
		} else if (p.status === 'inconclusive') {
			// Nothing recorded, and nothing proven: a finding, never a quiet pass.
			findings++;
			log(`   INCONCLUSIVE: ${p.capability}@${p.node} — ${p.reason} (no $proof written)`);
		} else log(`   ${p.status}: ${p.capability}@${p.node} — ${p.reason ?? p.why ?? ''}`);
	}
}

if (JSON_OUT)
	console.log(
		JSON.stringify(
			{
				ok: findings === 0,
				report,
				unreachable,
				roleDeclared,
				tools: toolResults,
				seeds: seedResultsByNode,
				revocations: revocationChanges,
				...(proofLedger.ok ? {} : { jobProofLedgerError: proofLedger.reason }),
				...(PROVE ? { prove: proveResults } : {}),
			},
			null,
			2
		)
	);
else if (!findings) console.log(`\n✓ every declared label is backed by a passing probe`);

process.exit(findings ? 1 : 0);
