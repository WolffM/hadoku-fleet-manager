#!/usr/bin/env node
/**
 * deploy-ci-throttle — install the job-start throttle on every fleet node.
 *
 * WHAT IT INSTALLS
 * ----------------
 *   ~/.hadoku/ci-throttle.sh      the hook (scripts/admin/ci-throttle.sh verbatim)
 *   ~/.hadoku/ci-throttle.conf    that node's limits, RENDERED FROM THE MANIFEST
 *   <each runner>/.env            ACTIONS_RUNNER_HOOK_JOB_STARTED=...
 *   ~/.hadoku/standing.env        THE SAME THREE LINES, as a file
 *
 * The last one exists because this walker can only wire a runner it can SEE, and
 * Runner.Listener reads `.env` once at start. A warm listener is minted by this
 * package between deploys, so it must be able to build its own `.env` — and it
 * must build it from what this command derived, not from a second copy of the
 * rule. `scripts/lib/standing-runner-env.sh` publishes the walker's own
 * `$LINE`/`$TCLINE`/`$MLINE`, and `warm-provision.sh` copies the result. One
 * derivation, two destinations; see that file's header for why it is not
 * `runner.env` (that is the JIT slot's env, and a JIT slot is deliberately not
 * hook-throttled).
 *
 * The conf is derived from `machines[].maxConcurrent` / `.minFreeMb` in
 * fleet-runner-manifest.json and is never hand-written on a box. That is the
 * whole point of the 2026-08-23 node model: a node's limits live in one
 * place, and this is the step that projects them onto the node.
 *
 * WHY A RESTART IS NEEDED, AND WHY IT IS PARTIAL
 * ----------------------------------------------
 * `.env` is read by `runsvc.sh` at listener start, so a runner keeps its old
 * environment until restarted. But restarting a runner mid-job KILLS that job.
 * So this restarts only IDLE runners and reports the busy ones, which makes the
 * whole command idempotent and re-runnable: run it again later and the
 * stragglers get picked up. Never "restart everything and hope the fleet is
 * quiet" — that is a self-inflicted outage on a busy afternoon.
 *
 * Busy is detected from the PROCESS TREE, not from the GitHub API: a runner's
 * `busy` flag there is per-registration and lags, while a live `Runner.Worker`
 * whose parent is this directory's `Runner.Listener` is ground truth.
 *
 * WHAT `--check` PROVES ABOUT PROVENANCE
 * --------------------------------------
 * That the node-side scripts on the box ARE the ones this package ships, by
 * sha256 of the bytes. Nothing verified that until 2026-09-07, and it is the
 * gap docs/planning/deployed-not-published-2026-09-05.md leaves open by name:
 * `~/.hadoku/runner.env` was missing on 6/6 claws two days after the version
 * that writes it shipped, and this command reported every runner wired the
 * whole time — because it audited the `.env` CONTENTS and never asked whether
 * the scripts beside it were current. A published version is a claim about a
 * registry; a hash match is evidence about a machine.
 *
 * Every file in `NODE_SIDE_FILES`, copied VERBATIM out of this package to every
 * node: the two runner hooks and the memory harvester. The runner runs the hooks
 * itself, so they have to be on the box. The minters are not: they travel with
 * each mint (src/runners/node-script.ts), and this deploy deletes the
 * `jit-provision.sh` it used to leave behind.
 * `ci-throttle.conf` is deliberately NOT among them — it is RENDERED per node
 * from the manifest, so a difference there means the manifest moved, which is a
 * different question with a different fix, and folding it in would make one
 * finding mean two things. It is asked SEPARATELY (#98): the node half reports
 * the limits the hook would enforce and the conf's sha256, and
 * `throttleSummaryDrift` compares them to the manifest and to the conf this run
 * renders, as a "manifest moved, node not re-deployed" finding of its own.
 *
 * BY HASH, NOT BY A VERSION MARKER IN THE FILE. A marker is a declaration: it
 * says what the last editor believed. It also needs one owner per file, and
 * `job-metrics.sh` has two right now — a marker line would be a merge conflict
 * every release. sha256 needs no cooperation from any editor and cannot go
 * stale.
 *
 * USAGE
 *   fleet throttle                     # dry run
 *   fleet throttle --confirm
 *   fleet throttle --machine claw-2 --confirm
 *   fleet throttle --no-restart --confirm
 *   fleet throttle --check             # audit, exit 1 on drift (ssh)
 *   fleet throttle --check --json      # a GateDoc instead of prose
 *
 * MIGRATED (wave 5i lane B), `--check` ONLY: `ci:audit-gates` now runs
 * `fleet throttle --check` with `--json` and judges it by the `GateDoc`
 * below rather than a regex over stdout+stderr — see
 * `src/lib/job-registry.ts`'s `coversSubs` entry (`contract: 'json'`) and
 * `scripts/lib/json-contract.mjs`'s derivation of `JSON_CONTRACT` from it.
 * The `--confirm` (deploy) half of this document is UNCHANGED: a mutating
 * gate is refused by `validateRegistry` (`checkMutatingGate`), and this
 * contract is only ever reached through `--check`, so the GateDoc fields
 * below are added only when `CHECK` is true. "I could not look" (a node
 * `runOn` could not reach, a SUMMARY line a read never reached, a hash a
 * read could not take) goes in `unreadable`; every mismatch this command
 * actually observed is a finding.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	isLocalNode,
	loadManifest,
	manifestPath,
	machineArg,
	parseSummary,
	runOn,
	selectMachines,
} from './lib/fleet-exec.mjs';
import { manifest as manifestFile } from './lib/paths.mjs';
import {
	NODE_SIDE_FILES,
	OBSOLETE_NODE_FILES,
	provenanceDrift,
	shippedHashes,
} from './lib/script-provenance.mjs';
import {
	runnerEnvDrift,
	staleRemainingFindings,
	throttleSummaryDrift,
} from './lib/runner-env-drift.mjs';
import { packageVersion } from '../dist/lib/provenance.js';
import { mintsJitRunners } from '../dist/lib/node-role.js';
import { maySudo, rootAdvisory } from './lib/operator-sudo.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { createEmitter, keepStdoutWhole } from './lib/emit.mjs';
import { buildGateDoc } from './lib/gate-doc.mjs';
import { classifyDrift } from './lib/throttle-drift-doc.mjs';

// STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
// and on a pipe `process.exit` throws away whatever the stream still had
// queued — measured on this host, 149,133 bytes in and 146,176 out, which
// `JSON.parse` then rejects mid-string. `keepStdoutWhole` puts fd 1 in
// blocking mode so there is nothing left to lose. Issue #33; the shared
// emitter calls the same function for the scripts that use it.
keepStdoutWhole();

const __dirname = dirname(fileURLToPath(import.meta.url));
// The package this run's bytes and version come from. `packageVersion()` reads
// the package.json beside the RUNNING module (dist/lib/provenance.js), which
// resolves to this same root — so printing it beside the version answers "which
// of the four trees answered" without the reader already suspecting the
// question. See docs/planning/deployed-not-published-2026-09-05.md.
const PKG_ROOT = resolve(__dirname, '..');
const HOOK_SRC = resolve(__dirname, 'ci-throttle.sh');
const INSTALL_SRC = resolve(__dirname, 'ci-throttle-install.sh');
const TOOLCACHE_RULE = resolve(__dirname, 'lib', 'runner-toolcache.sh');
// Appended AFTER the node half, in the same shell, so it can publish the very
// `$LINE`/`$TCLINE`/`$MLINE` the walker writes into a standing runner's .env.
// One derivation, two destinations — see the file's own header.
const STANDING_ENV_RULE = resolve(__dirname, 'lib', 'standing-runner-env.sh');
const METRICS_SRC = resolve(__dirname, 'job-metrics.sh');
// THE MEMORY HARVESTER (#47): sampler + its user unit, installed and STARTED by
// this same payload on EVERY bounded node. Until 2026-09-22 these were copied
// onto three claws by hand (2026-08-26/27) and onto no others — claw-4/5/6/8/9
// never had a harvester — and the hand-installed copies matched zero runner
// cgroups under all-JIT naming, so the "active" units harvested nothing fleet-
// wide. `fleet mem-report --check` reads the OUTPUT files and is the gate that
// can see that; this deploy is what makes the output exist.
const HARVEST_SRC = resolve(__dirname, 'runner-mem-harvest.py');
const HARVEST_UNIT_SRC = resolve(__dirname, 'units/runner-mem-harvest.service');

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
// --check is a dry run that FAILS on drift, so the deployed state can be audited
// rather than assumed. It needs ssh, so it belongs in `check:live`, never in the
// offline `check` aggregate.
const DRAINS = readDrains();
const CHECK = args.includes('--check');
const NO_RESTART = args.includes('--no-restart');
const ONLY = machineArg(args);
const JSON_OUT = args.includes('--json');

// A verifier that reads its own writer's artifact cannot fail. `--confirm`
// installs all three node-side scripts and then `--check` would hash what this
// same run just wrote, so every node would report a perfect match whatever it
// held a second earlier. That is the exact shape CLAUDE.md names — it is how
// `check:slice` stayed green while 11 of 97 units carried the wrong ceiling.
if (CHECK && CONFIRM) {
	console.error(
		'deploy-ci-throttle: --check and --confirm are mutually exclusive.\n' +
			'  --confirm writes the very files --check hashes, so together they would report\n' +
			'  a clean fleet no matter what was deployed. Run --confirm, then --check.'
	);
	process.exit(2);
}

// THE SHARED EMITTER (wave 5i lane B — stdout under `--json` is now a
// contract, `scripts/lib/emit.mjs`'s own "ONE STDOUT DISCIPLINE FOR EVERY
// SUBCOMMAND"). `log` keeps its exact prior behaviour — a human line in
// non-JSON mode, suppressed from stdout in `--json` mode — through the
// shared helper rather than a hand-rolled copy of it. `JSON_OUT`, derived
// above from the real argv, stays the one flag every other conditional in
// this file already reads; the emitter is constructed with no `argv`
// override, so its own `json` reads the same real `--json`.
const emitter = createEmitter();
const log = emitter.log;

// 27 runners x a sequential `systemctl restart` overran 120s on claw-1, which
// killed the ssh MID-TRANSACTION: 21 .env files pointed at a hook the run had not
// written yet. See the install-order comment below for why that was dangerous.
const SSH_TIMEOUT_MS = 600_000;

/**
 * #76's hokon half. `reserveFile` is this (the deploying) box's resolved path
 * to `fleet-runner-coverage.json`, or `null` — see {@link resolveReserveFile}
 * for why it is only ever non-null for the LOCAL node. The hook treats an
 * absent line the same as every other gap it fails open on: no RESERVE_FILE
 * line, no known-need check, same as today.
 */
function renderConf(name, m, reserveFile) {
	return [
		`# GENERATED by \`fleet throttle\` from fleet-runner-manifest.json.`,
		`# Do not hand-edit — the node model is the source of truth, and the next`,
		`# deploy overwrites this file. Change machines['${name}'] in the manifest.`,
		`# ${name}: ${m.cores ?? '?'} cores, ${m.ramGb ?? '?'}G RAM`,
		`MAX_CONCURRENT=${m.maxConcurrent}`,
		`MIN_FREE_MB=${m.minFreeMb}`,
		`MAX_WAIT_S=${m.maxWaitS ?? 90}`,
		...(reserveFile
			? [
					`# #76: the known-need-vs-cap ledger. Resolved on the deploying box,`,
					`# for the deploying box only — see resolveReserveFile() in`,
					`# deploy-ci-throttle.mjs.`,
					`RESERVE_FILE=${reserveFile}`,
				]
			: []),
		'',
	].join('\n');
}

/**
 * This (the deploying) box's `fleet-runner-coverage.json`, or `null` if this
 * box cannot resolve one — never a node this script is ABOUT to ssh to.
 *
 * THE ONE PLACE THIS PATH IS RESOLVED, through `manifestFile()` — the same
 * function every other manifest path in this package resolves through
 * (CLAUDE.md: manifests are operator config, resolved through
 * `FLEET_MANIFEST_DIR`, never a `__dirname` walk or a hardcoded tree). Before
 * this, `ci-throttle.sh` hardcoded `$HOME/srv/hadoku_site/...` as its own
 * fallback — a second, inferior copy of exactly the resolution this function
 * already does, AND an ecosystem literal baked into a node hook
 * (`ecosystem-literals.test.mjs`). The hook now carries no opinion about
 * where that file lives; it only reads whatever path (if any) ends up in its
 * conf.
 *
 * NEVER WRITTEN FOR A REMOTE NODE. The path this resolves is THIS box's
 * filesystem location — `manifestDir()` reads `FLEET_MANIFEST_DIR`/`siteRoot()`
 * for the box this process is running on, which says nothing about what
 * exists at that path on a node reached over ssh. Writing it into a remote
 * node's conf would point that node's hook at a path that is, at best,
 * coincidentally correct and, at worst, a file under someone else's checkout.
 * `isLocalNode(target)` is the one answer to "is this node the box resolving
 * this path" (CLAUDE.md), so the per-node call site below gates on it before
 * ever using this value — see where `renderConf` is called.
 */
function resolveReserveFile() {
	try {
		const path = manifestFile('fleet-runner-coverage.json');
		// Readable, not merely resolvable: manifestDir() can name a directory
		// that holds no coverage file yet (a fresh FLEET_MANIFEST_DIR, or a
		// reconcile that has never run --write-coverage there). An unreadable
		// path is the same "nothing to point at" as a manifestDir() that threw,
		// and the hook already fails open on a path it cannot read — this just
		// avoids shipping one that is confirmed missing on sight.
		return existsSync(path) ? path : null;
	} catch {
		// manifestDir()/siteRoot() could not resolve on this box at all. No
		// RESERVE_FILE line goes out to anyone; the hook's own fail-open default
		// (no known-need check) applies everywhere, same as an unreachable node.
		return null;
	}
}

/**
 * The remote half. Written as one script so the whole node-side transaction
 * is in a single readable place rather than smeared across N ssh round-trips.
 */
/**
 * Ship the node-side script with its inputs.
 *
 * The remote half lives in ci-throttle-install.sh — a REAL file, not a template
 * literal. Embedding it in one cost three separate parse failures (an octal
 * escape, a JS interpolation, and a backtick in a comment that ended the string)
 * and none of them were shell bugs; they broke the .mjs itself. Inputs are
 * prepended as plain variable assignments so nothing has to be substituted into
 * the script text at all.
 */
function remotePayload({ hook, conf, apply, restart, ephemeral }) {
	const b64 = (v) => Buffer.from(v, 'utf8').toString('base64');
	const preamble = [
		`APPLY=${apply ? 1 : 0}`,
		`RESTART=${restart ? 1 : 0}`,
		`HOOK_B64=${b64(hook)}`,
		`CONF_B64=${b64(conf)}`,
		// A node that mints gets runner.env for its slots. The minters themselves
		// are not shipped: they travel with each mint (src/runners/node-script.ts).
		`MINTS=${ephemeral ? 1 : 0}`,
		// Shipped to EVERY node. A standing runner and a
		// JIT slot both complete jobs, and the memory question is asked of the
		// whole fleet — a hook present on only half of it would produce a
		// comparison between measured and unmeasured boxes, which is the shape
		// of every bad conclusion in this repo's history.
		`METRICS_B64=${b64(readFileSync(METRICS_SRC, 'utf8'))}`,
		// The sampler behind that hook, plus the user unit that runs it. Same
		// every-node rule and for the same reason: a memory distribution sized
		// from half the fleet is not a distribution, and the 2026-09-22 finding
		// was that five of nine nodes had no sampler at all while every cap on
		// them was being set from data that no longer existed.
		`HARVEST_B64=${b64(readFileSync(HARVEST_SRC, 'utf8'))}`,
		`HARVEST_UNIT_B64=${b64(readFileSync(HARVEST_UNIT_SRC, 'utf8'))}`,
		'',
	].join('\n');
	// The tool-cache rule is PREPENDED as shell, not passed as a value: the
	// answer depends on `id -un` ON THE NODE, and this driver does not know
	// which user a given runner runs as. Deciding it here would reintroduce
	// exactly the hardcoding that made fix-runner-tool-cache.sh dangerous.
	return (
		preamble +
		readFileSync(TOOLCACHE_RULE, 'utf8') +
		readFileSync(INSTALL_SRC, 'utf8') +
		// APPENDED, not prepended: it publishes `$LINE`/`$TCLINE`/`$MLINE`, which
		// the node half derives, so it has to run after them. It emits its own
		// STANDING-ENV line rather than joining the SUMMARY, because SUMMARY is
		// already printed by the time it runs.
		readFileSync(STANDING_ENV_RULE, 'utf8')
	);
}

// ---------------------------------------------------------------------------

/**
 * What this package ships, as the node will see it.
 *
 * Hashed from the SAME bytes the payload carries — `remotePayload` base64s the
 * utf8 of these files and the node writes the decode verbatim, so a match here
 * means the node holds this package's copy and a mismatch means it does not.
 * No third artifact, no marker to keep in step.
 */
const SHIPPED = shippedHashes(__dirname);
const VERSION = packageVersion();

/**
 * One deployed file's verdict — issue #13.
 *
 * TWO HASHES DIFFERING SAYS NOTHING ABOUT WHICH ONE IS OLD. The message this
 * replaced ended `— that node is running an older deploy, so anything fixed in
 * that file since is inert there`, which is a CONCLUSION from evidence that
 * cannot support it: a sha256 mismatch is equally consistent with the node being
 * behind, with the node being AHEAD (a newer deploy from another checkout), and
 * with this process having resolved the wrong package entirely — the four-trees
 * problem, which is the single most expensive mistake in this repo's history
 * (docs/planning/deployed-not-published-2026-09-05.md, six correct-and-inert
 * fixes). An operator who read "that node is stale" went and re-deployed from
 * the tree that was itself the stale one.
 *
 * So: say the two hashes DIFFER, name both, and name the package this run
 * resolved — version AND path — so the reader can settle which side is old from
 * facts rather than from this tool's assumption. The three cases that genuinely
 * ARE one-sided (no hash reported, absent, unreadable) still come from
 * `provenanceDrift`, because for those the evidence does support the verdict.
 */
function fileDrift(node, file, deployed, want, dest = `~/.hadoku/${file}`) {
	if (deployed !== undefined && deployed !== 'absent' && deployed !== 'unreadable') {
		if (deployed === want) return null;
		return (
			`${node}: ${dest} does not match this package's copy ` +
			`(node ${deployed}, package ${want}). ` +
			`This run resolved fleet-manager ${VERSION} at ${PKG_ROOT}. ` +
			`Which side is stale is NOT known from a hash difference — check that path is ` +
			`the tree you meant before deploying over the node`
		);
	}
	return provenanceDrift(node, file, deployed, want, VERSION, dest);
}

const hook = readFileSync(HOOK_SRC, 'utf8');

// THE FILTER IS RIGHT. ITS SILENCE WAS NOT.
//
// Excluding a node that declares no maxConcurrent/minFreeMb is deliberate and
// load-bearing: `renderConf` interpolates those straight into the node's config,
// and ci-throttle.sh rejects a non-numeric value and falls through to
// MAX_CONCURRENT=99, MIN_FREE_MB=0 — no limit, silently, on a node general CI
// lands on. That is the state that OOM-killed two jobs on claw-2 on 2026-08-24.
//
// But until 2026-09-08 the exclusion produced NO output unless it excluded
// EVERYTHING. claw-7 was enrolled, declared in the manifest, and skipped by
// every deploy; `fleet throttle --check` printed seven nodes out of eight
// declared and reported drift about other machines without ever naming it. A
// node can be in the fleet's own manifest and invisible to the tool that bounds
// it, which is the "zero repos scanned reports clean coverage" shape one level
// down.
//
// So the excluded set is computed and REPORTED. It is a finding under --check
// rather than a note, because an unbounded node is not a tidy-up: it is a node
// nothing is stopping from taking every job on the fleet the moment something
// labels it.
const allNodes = selectMachines(loadManifest(), { only: ONLY });

const bounded = (m) => typeof m.maxConcurrent === 'number' && typeof m.minFreeMb === 'number';
const nodes = allNodes.filter(([, m]) => bounded(m));
const unbounded = allNodes.filter(([, m]) => !bounded(m)).map(([name]) => name);

// #76's hokon half. Resolved ONCE, on this box — see resolveReserveFile().
// Per-node use below still gates on isLocalNode(name): this value is only
// ever written into the LOCAL node's conf, never a remote one's.
const RESERVE_FILE = resolveReserveFile();

log(`Manifest: ${manifestPath()}`);
log(`Mode: ${CONFIRM ? 'APPLY' : 'DRY RUN (no side effects)'}\n`);

if (!nodes.length) {
	// Zero nodes deployed to is a FAILURE, never a clean pass.
	console.error(
		`deploy-ci-throttle: no nodes to deploy to` +
			(ONLY ? ` (--machine ${ONLY} not found, or it declares no maxConcurrent/minFreeMb)` : '')
	);
	process.exit(1);
}

const results = [];
const drift = [];
for (const [name, m] of nodes) {
	// Only the LOCAL node ever gets a RESERVE_FILE line — see
	// resolveReserveFile() and renderConf()'s own doc comment for why a path
	// resolved on THIS box must never be written into a REMOTE node's conf.
	const reserveFile = isLocalNode(name) ? RESERVE_FILE : null;
	const conf = renderConf(name, m, reserveFile);
	log(
		`── ${name}  (${m.cores ?? '?'} cores, ${m.ramGb ?? '?'}G)  max ${m.maxConcurrent} concurrent, ${m.minFreeMb}MB floor`
	);
	const r = await runOn(
		name,
		remotePayload({
			hook,
			conf,
			apply: CONFIRM,
			restart: !NO_RESTART,
			ephemeral: mintsJitRunners(m),
		}),
		{ as: 'ci', timeoutMs: SSH_TIMEOUT_MS }
	);
	const out = (r.stdout + r.stderr).trim();
	const summary = out.split('\n').find((l) => l.startsWith('SUMMARY')) ?? '(no summary)';
	const notes = out
		.split('\n')
		.filter((l) =>
			/^(STALE-UNREADABLE|STALE|NO-LIVE-LISTENER|BUSY|NO-UNIT|NO-LISTENER|NEEDS-OPERATOR|RESTART-FAILED|HOOK-INSTALL-FAILED|DUPLICATE-LISTENERS|JOBTMP-BAD|JOBTMP-UNREADABLE) /.test(
				l
			)
		);

	if (!r.ok) {
		const why = (r.stderr || r.stdout).trim().slice(0, 200);
		// A node a human powered off is EXPECTED down. It is still PRINTED, and
		// still not audited — the deferral suppresses the failure, never the
		// evidence, and expires after DEFER_DAYS.
		const defer = deferralFor(name, DRAINS);
		if (defer.deferred) {
			log(`   · ${deferralNote(name, defer)} — not audited`);
			results.push({ machine: name, ok: true, expectedDown: true, skipped: 'expected down' });
			continue;
		}
		log(`   ✗ unreachable or failed: ${why}`);
		// "I could not look" must never render as "nothing is wrong". The exit
		// code below was already 1 for this, but the audit still printed
		// "✓ every runner on every node is wired" first — a green sentence above
		// a red exit, which is how a reader concludes the wrong thing.
		if (CHECK) drift.push(`${name}: could not be reached, so NOTHING on it was checked — ${why}`);
		results.push({ machine: name, ok: false, error: (r.stderr || r.stdout).trim().slice(0, 300) });
		continue;
	}
	log(`   ${summary}${r.local ? '  (local)' : ''}`);
	// The node half's own report, parsed once. Every per-node rule reads it
	// through throttleSummaryDrift(), which REQUIRES each good value rather
	// than testing for the bad one — see that function for the #98 history.
	const kv = parseSummary(out);
	if (CHECK) {
		drift.push(
			...throttleSummaryDrift({
				name,
				m,
				kv,
				wantConfSha: createHash('sha256').update(conf, 'utf8').digest('hex'),
			})
		);
	}
	// THE JIT SLOT ENV (#100/#101): `~/.hadoku/runner.env` was missing on 6/6
	// claws two days after the fix that writes it shipped, and nothing here
	// looked for it — the gap this closes. Presence alone follows the same
	// "reported, never judged" rule as jit/payload above: a non-ephemeral node
	// legitimately has none. Missing a KEY is judged unconditionally, because a
	// runner.env that exists with a key absent is wrong regardless of role —
	// that is "I read it and it is wrong", not "I could not look".
	if (CHECK) {
		const envFinding = runnerEnvDrift({ name, ephemeral: mintsJitRunners(m), summary });
		if (envFinding) drift.push(envFinding);
	}
	// THE STANDING-RUNNER ENV, published for the runners this walker cannot reach
	// in time.
	//
	// `warm-provision.sh` builds a warm listener's `.env` from `standing.env`. A
	// warm listener is a STANDING registration — nothing else bounds how many jobs
	// land on it — and until 2026-09-09 it was built from `~/.hadoku/runner.env`,
	// which is the JIT SLOT's env and deliberately carries no
	// ACTIONS_RUNNER_HOOK_JOB_STARTED. So the warm path ran UNTHROTTLED: the cap
	// every other standing runner obeys was bypassed on the one runner shape this
	// package mints for itself. warm-provision.sh now REFUSES to register when
	// this file is missing, rather than minting an uncapped standing runner, so an
	// undeployed node is a failed fill instead of a silent hole in the cap.
	//
	// No line at all is its own finding: the node half exited before reaching the
	// appended rule, so nothing about this node's standing env was looked at. "I
	// could not look" must not render as "nothing is wrong".
	const standingEnv = /^STANDING-ENV (\S+)/m.exec(out)?.[1];
	if (standingEnv && standingEnv !== 'ok') log(`     STANDING-ENV ${standingEnv}`);
	if (CHECK && standingEnv !== 'ok') {
		const why =
			standingEnv === 'absent'
				? '~/.hadoku/standing.env is not deployed'
				: standingEnv === 'stale'
					? '~/.hadoku/standing.env does not match what this package would write'
					: 'the node half never reached the standing-env rule, so nothing about it was checked';
		drift.push(
			`${name}: ${why} — every warm-cache fill on this node REFUSES rather than minting ` +
				`an unthrottled standing listener (fix: fleet throttle --confirm)`
		);
	}
	// PROVENANCE. The round trip is already made; this is the part of it that
	// answers "is the code on that box the code we think we shipped".
	// A missing SUMMARY is already throttleSummaryDrift()'s finding above.
	// The drifted file names are carried on the result too, so the provisioning
	// converger can redeploy a node whose scripts lag this package (#1)
	// without parsing prose.
	const scriptDrift = [];
	if (CHECK && kv) {
		for (const { file, summaryKey, dest } of NODE_SIDE_FILES) {
			const d = fileDrift(name, file, kv[summaryKey], SHIPPED[file], dest);
			if (d) {
				drift.push(d);
				scriptDrift.push(file);
			}
		}
		// A dead file still on the node is drift too, so the converger's
		// redeploy deletes it. Unreadable is drift as well: could not look.
		for (const { file, summaryKey } of OBSOLETE_NODE_FILES) {
			const v = kv[summaryKey];
			if (v === '0') continue;
			drift.push(
				v === '1'
					? `${name}: ~/.hadoku/${file} is obsolete and still on the node — nothing runs ` +
							`it any more (fix: fleet throttle --confirm deletes it)`
					: `${name}: could not read whether the obsolete ~/.hadoku/${file} is still there ` +
							`(SUMMARY carried ${summaryKey}=${v ?? '(absent)'})`
			);
			scriptDrift.push(file);
		}
	}
	// #102: a stale listener this run did NOT clear — busy, a failed restart
	// attempt, or nothing attempted at all (a dry run, or --no-restart). `stale`
	// above is a point-in-time DETECTION; this is whether it is STILL true once
	// the node half finished acting on it, and --confirm's own gate (below)
	// reads this, not `stale`.
	const staleRemaining = Number(/stale_remaining=(\d+)/.exec(summary)?.[1] ?? 0);
	for (const n of notes.slice(0, 6)) log(`     ${n}`);
	if (notes.length > 6) log(`     … ${notes.length - 6} more`);
	results.push({
		machine: name,
		ok: true,
		summary,
		notes,
		staleRemaining,
		scriptDrift,
		standingEnv: standingEnv ?? null,
	});
}

// #102: --confirm's own gate. A node this run never reached (expectedDown,
// or ok:false) was not acted on at all, so it has nothing to say about
// whether a stale listener survived THIS run — that is `failed`'s and the
// deferral note's territory, not this one's.
//
// The hook and the scripts under ~/.hadoku are the node user's own, so the
// backstop gets them like any claw. Restarting a SYSTEM unit's listener is
// root, which the fleet does not have there (`fleetHasSudo`): its
// NEEDS-OPERATOR line is an ADVISORY naming the hand-run, never this gate's
// failure (lib/operator-sudo.mjs).
const sudoAdvisories = [];
const confirmRemaining = CONFIRM
	? results.flatMap((r) => {
			if (!r.ok || r.expectedDown) return [];
			const found = staleRemainingFindings({
				name: r.machine,
				staleRemaining: r.staleRemaining ?? 0,
				notes: r.notes ?? [],
			});
			if (maySudo(Object.fromEntries(allNodes)[r.machine])) return found;
			const root = found.filter((f) => / NEEDS-OPERATOR /.test(f));
			for (const f of root)
				sudoAdvisories.push(
					rootAdvisory(
						r.machine,
						`restarting a system unit's stale listener (${f})`,
						`fleet throttle --machine ${r.machine} --confirm`
					)
				);
			return found.filter((f) => !root.includes(f));
		})
	: [];
for (const a of sudoAdvisories) log(`⚠ advisory: ${a.message}\n    ${a.fix}`);

if (JSON_OUT) {
	const payload = {
		confirm: CONFIRM,
		results,
		confirmRemaining,
		sudoAdvisories,
	};
	// GateDoc (wave 5i lane B), `--check` ONLY — the `--confirm` (deploy) half
	// of this document is untouched by this block, exactly as it was before
	// this migration. Built from `drift` as it stands here (every per-node
	// push in the loop above already ran) PLUS `unbounded` — reported here
	// INDEPENDENTLY of `drift`'s own combined-string push for it at the foot
	// of this file, so that later push (and the human-prose order around it)
	// is never touched or reordered by this.
	if (CHECK) {
		const { findings, unreadable } = classifyDrift(drift);
		for (const name of unbounded) {
			findings.push({
				node: name,
				kind: 'unbounded-node',
				reason: `${name} declares no maxConcurrent/minFreeMb, so it was NOT deployed to`,
			});
		}
		Object.assign(payload, buildGateDoc({ findings, unreadable }));
	}
	emitter.emit(payload);
} else {
	log('');
	const failed = results.filter((r) => !r.ok);
	const busy = results.flatMap((r) => r.notes ?? []).filter((n) => n.startsWith('BUSY'));
	if (!CONFIRM) log('Dry run only. Re-run with --confirm to apply.');
	if (busy.length)
		log(
			`${busy.length} runner(s) were mid-job and were not restarted — their env is written but not yet live.\n` +
				`Re-run this command later to pick them up; it is idempotent.`
		);
	if (failed.length)
		log(`✗ ${failed.length} node(s) failed: ${failed.map((f) => f.machine).join(', ')}`);
}

if (unbounded.length) {
	// Printed on EVERY run, not only under --check: a `--confirm` that quietly
	// skipped a node is exactly as misleading as an audit that did.
	const detail = unbounded
		.map((n) => `${n} declares no maxConcurrent/minFreeMb, so it was NOT deployed to`)
		.join('; ');
	console.error(
		`\n✗ ${unbounded.length} declared node(s) SKIPPED: ${unbounded.join(', ')}\n` +
			'  They are in the manifest and nothing bounds them. ci-throttle.sh would fall\n' +
			'  through to MAX_CONCURRENT=99, MIN_FREE_MB=0 on a node with no numbers, so the\n' +
			'  deployer refuses rather than writing that — but a node in this state is one\n' +
			'  label away from taking work with no limit at all.\n' +
			'  Fix: set maxConcurrent and minFreeMb on each, then re-run.'
	);
	if (CHECK) drift.push(detail);
}

if (CONFIRM) {
	// A stale (written but NOT LOADED) listener surviving this run is not a
	// clean pass just because every ssh round-trip succeeded — the exit code
	// before this existed was `results.some((r) => !r.ok)` alone, which is
	// true ONLY of unreachable nodes, so a fleet full of busy or
	// restart-failed stale listeners reported success every time.
	if (confirmRemaining.length) {
		console.error(
			`\n✗ throttle --confirm: ${confirmRemaining.length} stale listener(s) (written but ` +
				`NOT LOADED) remain after this run:`
		);
		for (const f of confirmRemaining) console.error(`  ${f}`);
		console.error(
			'\n  A busy one is left alone on purpose — re-run this command once the job ends.\n' +
				'  Anything else (restart-failed, no-unit, needs-operator) needs attention before\n' +
				'  the next job lands on it with no concurrency limit.'
		);
		process.exit(1);
	}
	log('\n✓ no stale (written but not loaded) listener remains.');
}

if (CHECK) {
	if (drift.length) {
		// `drift` counts FINDINGS, not nodes — one node can be both partly
		// wrong on disk and partly stale, and calling that "2 nodes" when there
		// is one would be the same count-instead-of-content mistake this tool's
		// messages were just fixed for.
		console.error(`\n✗ throttle drift (${drift.length} finding(s)):`);
		for (const d of drift) console.error(`  ${d}`);
		if (drift.some((d) => d.includes('wrong env on disk'))) {
			console.error(
				'\n  Fix (wrong on disk): fleet throttle --confirm\n' +
					'  A runner whose env is wrong has NO concurrency limit and cannot see the\n' +
					'  seeded tool cache — the manifest values are inert until this has run there.'
			);
		}
		if (
			drift.some(
				(d) =>
					d.includes("does not match this package's copy") || d.includes('is not deployed at all')
			)
		) {
			console.error(
				`\n  Fix (mismatched or missing node-side script): fleet throttle --confirm, run from\n` +
					`  the tree you mean. This run resolved fleet-manager ${VERSION} at\n` +
					`  ${PKG_ROOT}. A node keeps whatever was last deployed to it and publishing a\n` +
					'  fix does not move it — but a hash difference does not say which side is old,\n' +
					'  and a --confirm from the wrong checkout deploys the wrong bytes over the right\n' +
					'  ones. See docs/planning/deployed-not-published-2026-09-05.md.'
			);
		}
		if (drift.some((d) => d.includes('NOT LOADED'))) {
			console.error(
				'\n  Fix (written but not loaded): fleet throttle --confirm. For a claw this is a\n' +
					'  systemctl --user unit and needs no sudo — --confirm stops it if idle (the warm\n' +
					'  pass or the unit itself then refills it) and leaves a busy one alone, reported.\n' +
					'  A node without passwordless sudo needs an operator to restart a stale\n' +
					'  listener by hand.'
			);
		}
		process.exit(1);
	}
	// The PATH, not just the version. A green line naming only a version is the
	// same claim from either of the four trees; naming the one that answered is
	// what makes it checkable.
	log(
		`✓ every runner on every node is wired to the throttle, every node has the ` +
			`standing-runner env, and every node-side script matches fleet-manager ` +
			`${VERSION} at ${PKG_ROOT}.`
	);
}

process.exit(results.some((r) => !r.ok) ? 1 : 0);
