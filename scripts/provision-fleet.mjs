#!/usr/bin/env node
/**
 * provision-fleet — one command from a bootstrapped box to a serving node.
 *
 * WHY THIS EXISTS
 * ---------------
 * Onboarding claw-9 by hand (2026-09-20/21) took FIFTEEN commands, four hand
 * edits and two alarms, after `node-bootstrap.sh` had already finished on the
 * box. The operator, 2026-09-21: "can we chain together provisioning,
 * onboarding, enrolling, benchmarking, bootcamping? all of these things are
 * kind of the same thing and should be run in sequence." Every one of those
 * steps was mechanical, in that order, and two were discovered by pages and
 * one by red main (#50, #52). This file is that sequence.
 *
 * `--machine <node>` runs the ONBOARDING CHAIN:
 *
 *   1. declare      `enroll` — measured, never typed; placement DERIVED
 *                   (labels [], role, maxRegistrations, slice, minFreeGb).
 *   2. converge     `converge-toolchain --write` — the package floor, then a
 *                   re-probe; bootcamp earns from what the box can DO.
 *   3. bootcamp     PROBE first. What it reports and this chain knows the
 *                   remedy for — python-toolcache, playwright, the JIT
 *                   payload — gets SEEDED and bootcamp re-runs, rather than
 *                   stopping at a failure whose remedy it knows (the manual
 *                   record's steps 3-6). Only a PASSING bootcamp writes
 *                   `$capabilities`.
 *   4. placement    The manifest fields a serving claw needs, all DERIVED:
 *                   the seed backfill for an older entry, and `ephemeral`
 *                   flipped ONLY once bootcamp has EARNED `jitconfig` AND the
 *                   payload binary exists on the node — payload before
 *                   ephemeral, both halves (claw-8's gate caught the flag
 *                   without the provisioner; its probe can pass without the
 *                   payload).
 *   5. register     `reconcile --confirm` — validates the manifest and creates
 *                   whatever standing registrations the node keeps (none for
 *                   an all-JIT claw; its `residentRepos` only).
 *   6. throttle     writes each runner's `.env` and — only once `ephemeral`
 *                   is set — the JIT provisioner every mint execs.
 *   7. slice        cgroup containment + supervision, ceiling derived from the
 *                   node's own MemTotal.
 *   8. realize      `systemctl --user start runners.slice`. The ONE hand step
 *                   the manual record needed after `slice --confirm`: io
 *                   never reached a slice that had never been realized. A
 *                   slice unit file is inert until the manager starts it, and
 *                   `--check`'s io_ctrl reads a cgroup that does not exist
 *                   until then.
 *   9. benchmark    `--due 30 --write` — the same freshness window
 *                   `ci:fleet-benchmark` enforces nightly, so the first
 *                   night's cron sees a measured node instead of paging
 *                   (claw-8/claw-9 both paged @here on 09-21 for exactly
 *                   this).
 *  10. health       `doctor --write`, gated on the STORED record: a fresh
 *                   record with no blocking findings skips the 60s load. A
 *                   node is not done being enrolled while a nightly checker
 *                   is still waiting to discover what it lacks — the chain
 *                   ends on the one record that says whether the box is safe.
 *
 * ORDER IS NOT COSMETIC. Seeding precedes the deploys in the onboarding chain
 * — the reverse of the whole-fleet path — because the payload must exist
 * before `ephemeral`, and `ephemeral` before throttle ships the provisioner
 * (claw-8: "the first throttle ran before the ephemeral flip, so it reported
 * jit=0"). Bootcamp sits between: it is what EARNS the jitconfig the flip
 * waits for.
 *
 * EVERY STEP RE-DERIVES ITS STATE FROM OBSERVED STATE, so a run stopped at
 * step N resumes at N: declare skips a node already in the manifest, seeds
 * only what bootcamp has not earned, the flip skips an already-ephemeral node,
 * reconcile/throttle/slice are drift-based, `start` on an active slice is a
 * no-op, benchmark is `--due`-gated and doctor is record-gated. An apply step
 * that fails STOPS the chain and prints that step's remedy — never a later
 * step's confusing error.
 *
 * THE HADOKU_SITE WRITE IS PART OF THE CHAIN. Steps 1, 3 (--write) and 4 are
 * manifest commits; before the first one the chain fast-forwards the manifest
 * checkout onto `origin/main` (`merge --ff-only`, which cannot lose local
 * work), because the manual record's step 1 failed on exactly that: enroll
 * refused to push a checkout that was behind origin. `--no-push` stops every
 * writer at its commit, the same door each writer offers individually.
 *
 * WHAT IT IS NOT
 * --------------
 * Not OS preparation. A brand-new box still needs the install stick
 * (`fleet onboard`) and `node-bootstrap.sh` at the console — the two PHYSICAL
 * steps stay physical. It picks up from "the box is bootstrapped, reachable
 * over ssh, and named with --machine".
 *
 * Without `--machine` it stays the WHOLE-FLEET converge it always was:
 * reconcile → throttle → slice → seed-python → seed-cache, then verify. A
 * GUEST is refused on the onboarding path — the chain does not converge,
 * bootcamp or measure one (operator, 2026-09-14).
 *
 * VERIFY IS A SEPARATE PASS, DELIBERATELY. Each deployer's own `--check` reads
 * OBSERVED state — the kernel's memory.max, the process tree, the live `.env`,
 * and bootcamp EXECUTES the capability — so re-running them after the apply
 * proves the node converged rather than proving the apply returned 0.
 *
 * USAGE
 *   fleet provision --machine <node> --confirm   # the onboarding chain
 *   fleet provision --machine <node>             # dry run of the same chain
 *   fleet provision --confirm                    # whole fleet (no chain phases)
 *   fleet provision --verify-only
 *
 * @guards scripts/**
 */

import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	loadManifest,
	machineArg,
	manifestPath,
	runOnSync,
	selectMachines,
} from './lib/fleet-exec.mjs';
import { landingLine, runGit } from './lib/manifest-target.mjs';
import { manifestEdit } from './lib/manifest-edit.mjs';
import { placementBackfill } from './lib/enrollment-record.mjs';
import { blockingFindings, bootcampPointer, doctorFindings } from './lib/doctor.mjs';
import { measuredFacets } from '../dist/lib/measured.js';
import { isGuestNode } from '../dist/lib/node-role.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── the pure decisions, exported so the tests can hold them ─────────────────

/**
 * Days a benchmark stamp stays fresh. The SAME window `ci:fleet-benchmark`
 * enforces nightly (`--due 30`), so the chain and the cron cannot disagree
 * about whether a node is measured — a node the chain marks fresh that the
 * cron still finds due is the 09-21 @here page wearing a different hat.
 */
export const BENCHMARK_DUE_DAYS = 30;

/**
 * Days a `$health` record is fresh enough to skip re-loading the box for 60s.
 * Matches the fleet's two existing freshness conventions (`benchmark --due 30`,
 * `BOOTCAMP_STALE_DAYS` 30) rather than inventing a third.
 */
export const HEALTH_FRESH_DAYS = 30;

/**
 * The three capabilities a fresh node cannot produce for itself, and the seed
 * command each one is the remedy for. The manual record's steps 3-5: bootcamp
 * failed on exactly these, the operator READ the failure and typed the seed.
 *
 * jitconfig IS HERE even though no bootcamp FINDING names it: `ephemeral`
 * waits for it, and a node that has never held a payload has not earned it.
 */
export const SEED_REMEDIES = [
	{
		capability: 'python-toolcache',
		script: 'seed-runner-python.mjs',
		argsFor: (node) => ['--machine', node],
		why: 'actions/setup-python resolves interpreters from /opt/hostedtoolcache; trixie has no published build',
	},
	{
		capability: 'playwright',
		script: 'seed-node-cache.mjs',
		argsFor: (node) => ['--machine', node, '--what', 'playwright'],
		why: 'a 5.2 GB browser cache a fresh box cannot build for itself; e2e-canary carries no install step',
	},
	{
		capability: 'jitconfig',
		script: 'seed-node-cache.mjs',
		argsFor: (node) => ['--machine', node, '--what', 'payload'],
		why: 'the JIT payload every mint hardlinks — ephemeral may not be flipped before it exists',
	},
];

/**
 * Which seeds this node still owes, derived from what bootcamp EARNED — never
 * from parsing a failure message. Earning is the proof; anything not earned
 * gets its remedy run, and the post-seed bootcamp is the judge.
 *
 * @param {string[]|null} earned the node's `earned` set from a bootcamp report
 * @returns {typeof SEED_REMEDIES} the subset whose capability is not earned
 */
export function seedPlan(earned) {
	const have = new Set(earned ?? []);
	return SEED_REMEDIES.filter((r) => !have.has(r.capability));
}

/**
 * THE PAYLOAD ITSELF, not a capability verdict.
 *
 * `jitconfig` passes when ANY Runner.Listener accepts the flag, and
 * capability-probe.sh searches standing installs too — so a node can EARN
 * jitconfig while holding no payload at all (claw-8 did exactly that). The
 * ephemeral flip removes the standing install, leaving nothing to mint from.
 * The flip therefore requires BOTH the earned flag AND the binary.
 */
export const PAYLOAD_PROBE =
	'[ -x "$HOME/.hadoku/jit/payload/bin/Runner.Listener" ] && echo PAYLOAD yes || echo PAYLOAD no';

/**
 * REALIZE THE SLICE — the manual record's step 11, the one hand command
 * `fleet slice --confirm` did not cover. A slice unit file is inert until the
 * manager starts it; the io controller reaches the slice's cgroup only once it
 * exists, and `slice --check`'s io_ctrl reads `cgroup.controllers` off that
 * cgroup. Starting an active slice is a no-op, so this is idempotent.
 */
export const REALIZE_SCRIPT = [
	'export XDG_RUNTIME_DIR="/run/user/$(id -u)"',
	'if systemctl --user is-active --quiet runners.slice 2>/dev/null; then',
	'  echo REALIZE-ALREADY-ACTIVE',
	'else',
	'  systemctl --user start runners.slice && echo REALIZE-STARTED',
	'fi',
	'cg=$(systemctl --user show runners.slice -p ControlGroup --value 2>/dev/null)',
	'echo "REALIZE-CGROUP ${cg:-none}"',
].join('\n');

/** The read-only half, for a dry run. */
export const REALIZE_CHECK =
	'export XDG_RUNTIME_DIR="/run/user/$(id -u)"; ' +
	'systemctl --user is-active --quiet runners.slice 2>/dev/null && echo REALIZE-ALREADY-ACTIVE || echo REALIZE-INACTIVE; ' +
	'cg=$(systemctl --user show runners.slice -p ControlGroup --value 2>/dev/null); ' +
	'echo "REALIZE-CGROUP ${cg:-none}"';

/**
 * May this node's `ephemeral` flag be set? Three answers, each a different
 * job: already on (nothing to do), the flag's precondition missing (a remedy
 * this chain knows), or flip.
 *
 * `entry.ephemeral === true` is checked with strict equality: `ephemeral:
 * false` is not "already on", it is a decision someone made, and the chain's
 * job is to bring it to true only when the preconditions hold.
 */
export function flipDecision({ entry, earned, payloadPresent }) {
	if (entry?.ephemeral === true) return { flip: false, state: 'already' };
	if (!Array.isArray(earned) || !earned.includes('jitconfig'))
		return {
			flip: false,
			state: 'not-earned',
			remedy:
				'bootcamp has not EARNED jitconfig on this node, and the JIT dispatcher cannot mint ' +
				'where it has not. Remedy: `fleet seed-cache --machine <node> --confirm --what payload`, ' +
				'read the seed run above for why the copy failed, then re-run provision — it resumes here.',
		};
	if (!payloadPresent)
		return {
			flip: false,
			state: 'no-payload',
			remedy:
				'jitconfig is earned but the JIT payload binary is absent — the ' +
				'capability probe also accepts a STANDING install, which the ephemeral flip itself ' +
				'removes (claw-8’s trap). Remedy: `fleet seed-cache --machine <node> --confirm ' +
				'--what payload`, then re-run provision.',
		};
	return { flip: true, state: 'flip' };
}

/**
 * What the health step owes, judged from the STORED record — a reader, not a
 * writer: `doctorFindings` re-derives the verdict from the record the way
 * `--from-record` renders it, so this cannot pass by trusting a probe that
 * never ran.
 *
 *   none   fresh record, no blocking findings — the step is DONE; re-running
 *          the chain changes nothing here.
 *   probe  no usable record, a stale one, or one that says unreachable — run
 *          `doctor --write` (60s of load) and let its exit code decide.
 *   fail   a FRESH record carrying BLOCKING findings. Re-probing cannot fix a
 *          finding the record and a probe would agree on; the node needs an
 *          operator, and the findings are the remedy text.
 */
export function healthStep(stored, { capabilities = null, nowMs = Date.now() } = {}) {
	if (!stored || stored.unavailable)
		return {
			action: 'probe',
			why: `no usable $health record (${stored?.unavailable ?? 'nothing stored'}) — nothing has proven this box safe`,
		};
	const rec = stored.value;
	if (!rec || rec.reachable === false)
		return {
			action: 'probe',
			why: 'the stored record says unreachable — stale information, not a verdict',
		};
	const ageDays = (nowMs - Date.parse(rec.at ?? '')) / 86_400_000;
	if (!Number.isFinite(ageDays) || ageDays > HEALTH_FRESH_DAYS)
		return {
			action: 'probe',
			why: Number.isFinite(ageDays)
				? `the record is ${Math.round(ageDays)}d old, past ${HEALTH_FRESH_DAYS}d`
				: 'the record’s timestamp does not parse',
		};
	const blocking = blockingFindings(
		doctorFindings({ ...rec, bootcamp: bootcampPointer(capabilities) })
	);
	if (blocking.length)
		return {
			action: 'fail',
			why: blocking.map((b) => `${b.category}/${b.status}: ${b.why}`).join(' | '),
			blocking,
		};
	return {
		action: 'none',
		why: `record is fresh (${Math.round(ageDays)}d) with no blocking findings`,
	};
}

/**
 * What the benchmark step owes, judged from the SAME report `ci:fleet-benchmark`
 * reads — a reader, not a writer.
 *
 * WHY THIS EXISTS, measured 2026-09-23. The step used to run
 * `benchmark <node> --due 30 --write` and assume `--due` gated it. It does not:
 * `--due` gates the REPORT and the fleet-wide sweep, and a node named
 * POSITIONALLY is measured unconditionally. So an idempotent re-run loaded a
 * node that was not due — claw-9's record was 2.4 days old against a 30-day
 * window, and `--due 30 --report --json` said `due: []` at that very moment.
 *
 * It did not merely waste minutes. The re-measure ran unprivileged, lost
 * `stability.aerCorrectable` against the stored ROOTED record, and
 * `benchmark-fleet`'s degradation guard correctly refused to overwrite a richer
 * record with a poorer one — exit 1, and the chain stopped at step 9 on a
 * healthy, actively-serving node. The guard is right; measuring when nothing
 * was due is the bug.
 *
 *   none     the node is not due — the step is DONE, and a re-run does nothing
 *   measure  the node is due, never measured, or its record is unreadable
 *   fail     the report could not be READ. "I could not look" is never
 *            "nothing is wrong": a step that skipped on an unparseable report
 *            would silently stop measuring the fleet and report green.
 *
 * A NEVER-MEASURED NODE IS DUE by `benchmark`'s own definition ("A node with NO
 * record — no state file, nothing in the manifest — is due"), and an UNREADABLE
 * record lands in `coverage.never`. Both are read here, so neither can be
 * skipped. PARSEABLE STDOUT WINS OVER THE EXIT CODE: the report exits non-zero
 * precisely when a node is never-measured, which is a state this must ACT on,
 * not treat as a broken command.
 *
 * @param {unknown} report parsed `benchmark --due N --report --json`
 * @param {string} node
 */
export function benchmarkStep(report, node) {
	if (!report || typeof report !== 'object')
		return {
			action: 'fail',
			why:
				'the benchmark report did not parse, so whether this node is due is UNKNOWN — ' +
				'skipping on that would stop measuring the fleet and still report green',
		};
	if (!Array.isArray(report.due))
		return {
			action: 'fail',
			why:
				'the benchmark report carries no `due` list (got ' +
				`${JSON.stringify(report.due)}) — that is a report this step could not read, not an ` +
				'empty one',
		};
	const name = (d) => (d && typeof d === 'object' ? d.node : d);
	const due = report.due.map(name);
	const never = (report.coverage?.never ?? []).map(name);
	const stale = (report.coverage?.stale ?? []).map(name);
	if (due.includes(node)) return { action: 'measure', why: 'the node is DUE' };
	if (never.includes(node))
		return {
			action: 'measure',
			why: 'the node has no usable benchmark record (never / unreadable)',
		};
	if (stale.includes(node)) return { action: 'measure', why: 'the stored record is STALE' };
	return {
		action: 'none',
		why: `not due (record within ${BENCHMARK_DUE_DAYS}d, and not never/stale)`,
	};
}

/**
 * Bring the manifest checkout level with `origin/main` BEFORE a write — the
 * manual record's step 1 failed on exactly this ("enroll refused to push:
 * checkout behind origin"). FAST-FORWARD ONLY: it cannot lose local work and
 * cannot conflict. A checkout with local commits main does not hold (a failed
 * push leaves one) is the operator's to fix, and the refusal says so.
 *
 * A fetch that fails is a WARNING, not a stop: if this run's writes change no
 * bytes there is nothing to land, and if they do, `landWrite`'s own ancestor
 * test refuses to push blind. "Could not look" is carried, never swallowed.
 */
export function fastForwardManifest(manifestFile, { git = runGit } = {}) {
	const top = git(['rev-parse', '--show-toplevel'], dirname(manifestFile));
	if (top.status !== 0 || !top.stdout.trim())
		return {
			ok: false,
			why: `${dirname(manifestFile)} is not inside a git working tree, so a manifest write can never become a commit: ${top.stderr.trim() || 'no toplevel'}`,
		};
	const repo = resolve(top.stdout.trim());
	if (git(['remote', 'get-url', 'origin'], repo).status !== 0)
		return { ok: true, note: 'no origin remote — nothing to fast-forward from' };
	const fetch = git(['fetch', 'origin', 'main'], repo);
	if (fetch.status !== 0)
		return {
			ok: true,
			note: `could not fetch origin/main (${fetch.stderr.trim().slice(0, 140)}) — continuing; a write that changes bytes will refuse to push rather than push blind`,
		};
	const ff = git(['merge', '--ff-only', 'FETCH_HEAD'], repo);
	if (ff.status !== 0)
		return {
			ok: false,
			why:
				`${repo} cannot be fast-forwarded onto origin/main (${ff.stderr.trim().split('\n')[0]}). ` +
				'The checkout holds local commits main does not, or a dirty tree blocks the merge — ' +
				'push or rebase it by hand, then re-run provision. Every step re-derives its state, ' +
				'so the run resumes where it stopped.',
		};
	return {
		ok: true,
		note: /Already up to date/i.test(ff.stdout)
			? 'already level with origin/main'
			: 'fast-forwarded onto origin/main',
	};
}

/**
 * Write the derived placement fields (and, when earned, `ephemeral`) onto a
 * DECLARED entry and land the commit — the manual record's steps 8, 9 and the
 * `ephemeral` flip as one idempotent write.
 *
 * Exported because it is the WRITE PATH this chain owns, and the fixture test
 * proves it against a scratch checkout: `writeTarget` first (the deploy-tree /
 * not-a-checkout / dirty refusals), surgical assignment (never a replacement —
 * the entry's `$measured`, `$capabilities`, `$health` and every human override
 * survive), `renderJson` (the owning repo's prettier), read it back, `landWrite`.
 *
 * @returns {{ok: boolean, why?: string, note?: string}} plus `note` carrying
 *   the landing line for the caller to print
 */
export async function applyPlacementWrite({
	manifestPath: mp,
	node,
	backfill,
	ephemeral,
	noPush = false,
}) {
	const wrote = [];
	const result = await manifestEdit(
		(doc) => {
			const entry = doc.machines?.[node];
			if (!entry)
				throw new Error(
					`${node} is not in ${mp} — placement writes an EXISTING entry; the declare step creates it`
				);
			for (const [k, v] of Object.entries(backfill ?? {})) {
				entry[k] = v;
				wrote.push(k);
			}
			if (ephemeral) {
				entry.ephemeral = true;
				wrote.push('ephemeral');
			}
			return wrote.length > 0;
		},
		{
			target: mp,
			writer: 'provision',
			reason: () => `placement for ${node}${ephemeral ? ' (ephemeral on)' : ''}`,
			push: !noPush,
		}
	);
	if ('ok' in result && result.ok === false) return { ok: false, why: result.why };
	if (!result.changed)
		return { ok: true, note: 'nothing to write — placement already complete', landed: null };
	const landed = result.landed;
	return {
		ok: landed.ok,
		why: landed.ok ? undefined : landed.why,
		note: `${landingLine(landed, { writer: 'provision' })}${result.formatter ? '' : '\n  ! written UNFORMATTED — no prettier resolved; run the owning repo’s format before pushing'}`,
		fields: wrote,
		landed,
	};
}

// ── the chain, as data — one order, printed and tested ───────────────────────

/**
 * The onboarding chain, in dependency order. `fleetWide` steps cannot be
 * scoped to one node and still run for the whole manifest — reconcile
 * validates every entry and the coverage check reads the fleet.
 */
export const ONBOARDING_STEPS = [
	{
		id: 'declare',
		kind: 'builtin',
		why: 'measured declaration with DERIVED placement — the four hand edits, automated',
	},
	{
		id: 'converge',
		kind: 'spawn',
		script: 'converge-toolchain.mjs',
		why: 'the package floor; bootcamp earns from what the box can DO',
	},
	{
		id: 'bootcamp',
		kind: 'builtin',
		why: 'probe → seed what it reports → re-probe → record $capabilities on a PASS',
	},
	{
		id: 'placement',
		kind: 'builtin',
		why: 'derived fields + ephemeral, only after jitconfig is EARNED on a seeded payload',
	},
	{
		id: 'register',
		kind: 'spawn',
		script: 'reconcile-fleet-runners.mjs',
		fleetWide: true,
		why: 'validates the manifest; standing registrations are the resident set only',
	},
	{
		id: 'throttle',
		kind: 'spawn',
		script: 'deploy-ci-throttle.mjs',
		why: 'runner .env + the JIT provisioner, which only an ephemeral node receives',
	},
	{
		id: 'slice',
		kind: 'spawn',
		script: 'deploy-runners-slice.mjs',
		why: 'cgroup containment, ceiling from the node’s own MemTotal',
	},
	{
		id: 'realize',
		kind: 'builtin',
		why: 'start runners.slice — io never reaches a slice that was never realized',
	},
	{
		id: 'benchmark',
		kind: 'spawn',
		script: 'benchmark-fleet.mjs',
		why: 'the ci:fleet-benchmark freshness window, so the first night is not a page',
	},
	{
		id: 'health',
		kind: 'builtin',
		why: 'doctor --write, gated on the stored record — the chain ends on the box being safe',
	},
];

/** Steps in dependency order for the whole-fleet converge. `fleetWide` ones cannot be scoped. */
const FLEET_APPLY = [
	{
		name: 'register runners',
		script: 'reconcile-fleet-runners.mjs',
		args: ['--confirm'],
		fleetWide: true,
		why: 'creates the runner directories and units everything below acts on',
	},
	{
		name: 'runner env (throttle hook + tool cache)',
		script: 'deploy-ci-throttle.mjs',
		args: ['--confirm'],
		why: 'writes .env, which needs the directories to exist',
	},
	{
		name: 'cgroup containment + supervision',
		script: 'deploy-runners-slice.mjs',
		args: ['--confirm'],
		why: 'walks units, which registration creates',
	},
	// ── THE SEED PHASE, LAST ──────────────────────────────────────────────────
	//
	// Added 2026-09-08 after claw-7 was converged, gated, green — and BLOCKED.
	// Three capabilities in the toolchain floor need bytes a fresh box cannot
	// produce for itself, and only one of them had a producer:
	//
	//   python-toolcache   fleet seed-python      existed
	//   playwright         (nothing)              a 5.2GB manual rsync
	//   the JIT payload    (nothing)              a 684MB manual rsync
	//
	// So `fleet provision --confirm` would report a converged node that bootcamp
	// then refused, and the remedy lived in an operator's memory. A node is not
	// provisioned until it can do the work.
	//
	// LAST on the WHOLE-FLEET path, because seeding is the only step here that
	// moves gigabytes and needs a healthy PEER, and a failure leaves a node
	// that is wired and bounded but unseeded — recoverable by re-running. On the
	// ONBOARDING path the same seeds run EARLIER (the bootcamp phase), because
	// there the payload must exist before `ephemeral` and `ephemeral` before
	// throttle's provisioner — claw-8's ordering trap.
	{
		name: 'python toolcache',
		script: 'seed-runner-python.mjs',
		args: ['--confirm'],
		why: 'actions/setup-python resolves interpreters from /opt/hostedtoolcache; trixie has no published build',
	},
	{
		name: 'browser + runner caches',
		script: 'seed-node-cache.mjs',
		args: ['--confirm'],
		why: 'playwright must launch a browser and every JIT mint hardlinks the runner payload',
	},
];

export const VERIFY = [
	{ name: 'coverage', script: 'reconcile-fleet-runners.mjs', args: ['--check-coverage'] },
	{ name: 'runner identity', script: 'reconcile-runner-identity.mjs', args: [] },
	{ name: 'throttle + tool cache', script: 'deploy-ci-throttle.mjs', args: ['--check'] },
	{ name: 'slice + supervision', script: 'deploy-runners-slice.mjs', args: ['--check'] },
	// VERIFIED BY EXECUTING THE CAPABILITY, not by checking the copy landed.
	// bootcamp launches a browser and runs an interpreter; a seed step that
	// verified its own rsync would be a writer reading its own artefact.
	// `--check-only` unless --confirm: a dry run must not install (2026-10-25 audit:
	// this row ran a full bootcamp, which installs and seeds, inside the DRY RUN).
	{ name: 'capabilities (bootcamp)', script: 'bootcamp.mjs', args: [], dryArgs: ['--check-only'] },
];

/** A verify step's arguments: its dry-run form unless --confirm (a dry run installs nothing). */
export function verifyStepArgs(step, { confirm }) {
	return confirm ? step.args : (step.dryArgs ?? step.args);
}

/** The onboarding chain's bootcamp probe: `--check-only` unless --confirm, for the same reason. */
export function bootcampProbeArgs(node, { confirm }) {
	return ['--machine', node, '--json', ...(confirm ? [] : ['--check-only'])];
}

// ── execution helpers ────────────────────────────────────────────────────────

function run(argv0, argv, { captureJson = false } = {}) {
	let dir = null;
	let fd = null;
	const opts = { stdio: ['inherit', 'inherit', 'inherit'] };
	if (captureJson) {
		// STDOUT INTO A FILE, never a pipe: a script that prints and then exits
		// loses everything past 8 KB through a pipe on this host (#33), and the
		// whole point of capturing is to parse it.
		dir = mkdtempSync(join(tmpdir(), 'fleet-provision-'));
		fd = openSync(join(dir, 'out.json'), 'w');
		opts.stdio = ['inherit', fd, 'inherit'];
	}
	const r = spawnSync(argv0, argv, opts);
	if (fd !== null) closeSync(fd);
	let text = null;
	if (captureJson) {
		text = readFileSync(join(dir, 'out.json'), 'utf8');
		rmSync(dir, { recursive: true, force: true });
		process.stdout.write(text);
	}
	return { status: r.status ?? 1, text };
}

/**
 * `JSON.parse`, or `null` with the reason SAID rather than dropped (F6, plan
 * §4.1 — this `catch {}` used to be empty, exactly the shape AGENTS.md's "no
 * lazy shortcuts" warns against).
 *
 * Still returns a bare `null` on failure, not `{ok:false, why}`: its three
 * call sites (`bootcampPhase`'s probe and judge reports, `benchmarkPhase`'s
 * `benchmarkStep(safeJson(rep.text), node)`) are pinned by
 * `onboarding-automation.test.mjs`'s literal-source guard and by
 * `benchmarkStep`'s own `!report` check, neither of which this file owns —
 * changing the return SHAPE here would silently change what both read. The
 * reason is carried to stderr instead, where every one of this file's
 * `run()` calls already prints the child's raw stdout right above it
 * (`captureJson`'s `process.stdout.write(text)`), so an operator reading a
 * failed chain sees both the document AND why it did not parse, never
 * neither.
 */
export function safeJson(text) {
	try {
		return JSON.parse((text ?? '').trim());
	} catch (err) {
		console.error(
			`safeJson: stdout did not parse as JSON (${err instanceof Error ? err.message : String(err)})`
		);
		return null;
	}
}

const P = (m) => console.log(m);

// ── the onboarding chain, phase by phase ─────────────────────────────────────

function declarePhase(node, { confirm, noPush, address }) {
	const MANIFEST = manifestPath();
	let doc = null;
	try {
		doc = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	} catch {
		// loadManifest below is the loud version of this read; here a missing
		// manifest reads as "not declared", which is the honest answer for it.
	}
	if (doc?.machines?.[node]) {
		P(`   · already declared in the manifest — nothing to do`);
		return { status: 0 };
	}
	if (!confirm) {
		P(`   · not declared. The proposal (nothing written):`);
		// enroll's exit 1 on a clean proposal is its own design; here it is the
		// preview, not a chain failure.
		run(process.execPath, [
			resolve(HERE, 'enroll-node.mjs'),
			node,
			...(address ? ['--address', address] : []),
		]);
		return {
			status: 1,
			remedy:
				`dry run stops at the first step: ${node} is not declared, and every later step reads ` +
				`the manifest. \`fleet provision --machine ${node} --confirm\` declares it from the ` +
				`bootstrap record (measurement + derived placement) and runs the whole chain.`,
		};
	}
	const ff = fastForwardManifest(MANIFEST);
	if (!ff.ok) return { status: 1, remedy: ff.why };
	P(`   · ${ff.note}`);
	const s = run(process.execPath, [
		resolve(HERE, 'enroll-node.mjs'),
		node,
		'--write',
		...(noPush ? ['--no-push'] : []),
		...(address ? ['--address', address] : []),
	]);
	if (s.status !== 0)
		return {
			status: 1,
			remedy:
				'enroll refused — its output above names which fatal check failed. A record/box ' +
				'disagreement on cores, hostname or memory means the capture is not this box; a ' +
				'landing refusal names the checkout state to fix.',
		};
	// THE READER IS NOT THE WRITER: re-read the manifest rather than trusting
	// the child's exit code.
	let after = null;
	try {
		after = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	} catch {
		/* handled below */
	}
	if (!after?.machines?.[node])
		return {
			status: 1,
			remedy:
				'enroll exited 0 but the node is not in the manifest afterwards — read its landing line above.',
		};
	return { status: 0 };
}

function convergePhase(node, { confirm }) {
	const s = run(process.execPath, [
		resolve(HERE, 'converge-toolchain.mjs'),
		'--machine',
		node,
		...(confirm ? ['--write'] : []),
	]);
	if (s.status !== 0)
		return {
			status: 1,
			remedy:
				'the toolchain did not converge — its output above names the package or the node. ' +
				'apt failures and an unreachable box are different jobs, and it says which.',
		};
	return { status: 0 };
}

/**
 * THE BOOTCAMP PHASE: probe, seed what the report says is missing, judge again.
 *
 * The manual record's steps 3-6: bootcamp FAILED on python-toolcache and
 * playwright, the operator READ the failure, typed two seed commands, and
 * bootcamp PASSED. The chain derives the same remedies from the EARNED set —
 * never by parsing the failure prose — and only a passing bootcamp records
 * `$capabilities`.
 */
function bootcampPhase(node, { confirm, noPush }) {
	const probe = run(
		process.execPath,
		[resolve(HERE, 'bootcamp.mjs'), ...bootcampProbeArgs(node, { confirm })],
		{ captureJson: true }
	);
	const probeReport = safeJson(probe.text)?.report?.[node] ?? null;
	if (!probeReport)
		return {
			status: 1,
			remedy:
				'bootcamp produced no report for this node — an unreachable node is a failure, not ' +
				'a pass, and its output above says why.',
		};
	const plan = seedPlan(probeReport.earned);
	if (plan.length) {
		for (const r of plan) {
			P(`   · not earned: ${r.capability} — seeding (${r.why})`);
			const s = run(process.execPath, [
				resolve(HERE, r.script),
				...r.argsFor(node),
				...(confirm ? ['--confirm'] : []),
			]);
			if (s.status !== 0)
				return {
					status: 1,
					remedy:
						`the seed for ${r.capability} failed — its output above names the cause. A dead ` +
						'peer, an unwritable destination and a full disk are three different jobs.',
				};
		}
	} else {
		P(`   · python-toolcache, playwright and jitconfig all earned — no seeding owed`);
	}
	// THE JUDGE IS THE SECOND RUN: probe (and, when applying, record) again.
	const judge = run(
		process.execPath,
		[
			resolve(HERE, 'bootcamp.mjs'),
			...bootcampProbeArgs(node, { confirm }),
			...(confirm ? ['--write'] : []),
			...(noPush ? ['--no-push'] : []),
		],
		{ captureJson: true }
	);
	const judgeReport = safeJson(judge.text)?.report?.[node] ?? null;
	if (!judgeReport)
		return {
			status: 1,
			remedy: 'the post-seed bootcamp run produced no report — its output above says why.',
		};
	const missing = plan.filter((r) => !(judgeReport.earned ?? []).includes(r.capability));
	if (missing.length && confirm)
		return {
			status: 1,
			remedy:
				`seeded ${missing.map((m) => m.capability).join(', ')} and bootcamp STILL does not earn ` +
				'it — the seed’s own output above says why the copy did not take.',
		};
	if (missing.length && !confirm)
		P(
			`   · dry run: would seed ${missing.map((m) => m.capability).join(', ')} and re-verify (seeding did not run)`
		);
	if (judge.status !== 0 && confirm)
		return {
			status: 1,
			remedy:
				'bootcamp still reports findings seeding cannot fix — read them above. A BLOCKED ' +
				'toolchain prerequisite or an UNEARNED declared label names the exact gap; that is a ' +
				'node problem, not a chain problem.',
		};
	if (judge.status !== 0 && !confirm)
		P(`   · dry run: bootcamp reports findings (above) that --confirm would have to clear`);
	return { status: 0, earned: judgeReport.earned ?? [] };
}

async function placementPhase(node, earned, { confirm, noPush }) {
	const MANIFEST = manifestPath();
	const doc = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	const entry = doc.machines?.[node] ?? {};
	const backfill = placementBackfill(entry);
	const pr = runOnSync(node, PAYLOAD_PROBE, { as: 'ci', argv: ['--machine', node], manifest: doc });
	const payloadPresent = /PAYLOAD yes/.test(pr.out ?? '');
	const decision = flipDecision({ entry, earned, payloadPresent });
	if (!decision.flip && decision.state !== 'already') return { status: 1, remedy: decision.remedy };
	if (decision.state === 'already' && !Object.keys(backfill).length) {
		P(`   · already ephemeral and carrying the derived placement fields — nothing to do`);
		return { status: 0 };
	}
	const fields = [...Object.keys(backfill), ...(decision.flip ? ['ephemeral'] : [])];
	if (!confirm) {
		P(`   · dry run: would write ${fields.join(', ')} on ${node}`);
		return { status: 0 };
	}
	const ff = fastForwardManifest(MANIFEST);
	if (!ff.ok) return { status: 1, remedy: ff.why };
	P(`   · ${ff.note}`);
	const w = await applyPlacementWrite({
		manifestPath: MANIFEST,
		node,
		backfill,
		ephemeral: decision.flip,
		noPush,
	});
	if (w.note) P(`   · ${w.note}`);
	if (!w.ok) return { status: 1, remedy: w.why ?? 'the placement write failed — see above.' };
	return { status: 0 };
}

function realizePhase(node, { confirm }) {
	const r = runOnSync(node, confirm ? REALIZE_SCRIPT : REALIZE_CHECK, {
		as: 'ci',
		argv: ['--machine', node],
		manifest: loadManifest(),
	});
	const out = `${r.out ?? ''}${r.stderr ?? ''}`;
	if (!r.ok)
		return {
			status: 1,
			remedy:
				`could not realize runners.slice on ${node}: ${out.trim().slice(0, 200)}. By hand: ` +
				`ssh ${node} 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user start runners.slice'`,
		};
	const marker = /REALIZE-(ALREADY-ACTIVE|STARTED|INACTIVE)/.exec(out)?.[1];
	const cg = /REALIZE-CGROUP (\S+)/.exec(out)?.[1] ?? null;
	if (!marker || (confirm && marker === 'INACTIVE'))
		return {
			status: 1,
			remedy: `the realize probe answered with neither marker — silence is not a pass: ${out.trim().slice(0, 200)}`,
		};
	if (!confirm && marker === 'INACTIVE') {
		P(`   · dry run: runners.slice is not realized; --confirm would start it`);
		return { status: 0 };
	}
	P(
		`   · ${marker === 'ALREADY-ACTIVE' ? 'already active' : 'started'} — cgroup ${cg ?? '(none reported)'}`
	);
	return { status: 0 };
}

function benchmarkPhase(node, { confirm }) {
	// ASK FIRST, and ask the question the nightly cron asks. `--report` reads
	// the stored stamps and touches nothing: no ssh, no load, no write.
	const rep = run(
		process.execPath,
		[
			resolve(HERE, 'benchmark-fleet.mjs'),
			'--due',
			String(BENCHMARK_DUE_DAYS),
			'--report',
			'--json',
		],
		{ captureJson: true }
	);
	const verdict = benchmarkStep(safeJson(rep.text), node);
	if (verdict.action === 'fail') return { status: 1, remedy: verdict.why };
	if (verdict.action === 'none') {
		P(`   · ${verdict.why} — nothing to do`);
		return { status: 0 };
	}
	if (!confirm) {
		P(`   · dry run: would measure (${verdict.why})`);
		return { status: 0 };
	}
	P(`   · ${verdict.why} — measuring`);
	const s = run(process.execPath, [
		resolve(HERE, 'benchmark-fleet.mjs'),
		node,
		'--due',
		String(BENCHMARK_DUE_DAYS),
		'--write',
	]);
	if (s.status !== 0)
		return {
			status: 1,
			remedy:
				'benchmark failed or left this node never-measured — its findings above name which. ' +
				'A node the guard refused to overwrite (a degraded record) needs a rooted capture by ' +
				'hand: on the node, `sudo sh scripts/benchmark-node.sh > F`, then ' +
				'`fleet benchmark <node> --from F --write`.',
		};
	return { status: 0 };
}

function healthPhase(node, { confirm }) {
	const manifest = loadManifest();
	const stored = measuredFacets('health', manifest.machines ?? {}).nodes[node];
	const verdict = healthStep(stored, {
		capabilities: manifest.machines?.[node]?.$capabilities ?? null,
	});
	if (verdict.action === 'none') {
		P(`   · ${verdict.why} — nothing to do`);
		return { status: 0 };
	}
	if (verdict.action === 'fail')
		return {
			status: 1,
			remedy:
				`the stored $health record carries BLOCKING findings: ${verdict.why}. Fix the NODE, ` +
				'not the record, then re-run — this step re-probes and records.',
		};
	if (!confirm) {
		P(`   · dry run: would probe and record (${verdict.why})`);
		return { status: 0 };
	}
	const s = run(process.execPath, [
		resolve(HERE, 'lib', 'doctor-run.mjs'),
		'--machine',
		node,
		'--write',
	]);
	if (s.status !== 0)
		return {
			status: 1,
			remedy:
				'doctor recorded BLOCKING findings — the chain ends here: a node is not serving-healthy ' +
				'while $health carries one. The findings above name them; the record is already written.',
		};
	return { status: 0 };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function onboardingRun(node, { confirm, verifyOnly, noPush, address }) {
	const manifest = loadManifest();
	const entry = manifest.machines?.[node];
	if (isGuestNode(entry)) {
		console.error(
			`provision-fleet: ${node} is a GUEST — the onboarding chain does not run against it.\n` +
				'  A guest lends the fleet a registration and is otherwise none of its business ' +
				'(operator, 2026-09-14); this chain converges, seeds, bootcamps and measures.\n' +
				'  Its registration is check-label-floor’s question, not provision’s.'
		);
		return 1;
	}

	P(
		`provision-fleet: onboarding chain for ${node} — ${ONBOARDING_STEPS.length} steps\n` +
			`Mode: ${verifyOnly ? 'VERIFY ONLY' : confirm ? 'APPLY then VERIFY' : 'DRY RUN (every step checks before acting)'}`
	);

	const failures = [];
	if (!verifyOnly) {
		let earned = null;
		for (const step of ONBOARDING_STEPS) {
			P(`\n\x1b[1m── ${step.id}\x1b[0m  ${step.why}`);
			if (step.fleetWide) P(`   (fleet-wide; --machine does not scope it)`);
			let r;
			switch (step.id) {
				case 'declare':
					r = declarePhase(node, { confirm, noPush, address });
					break;
				case 'converge':
					r = convergePhase(node, { confirm });
					break;
				case 'bootcamp':
					r = bootcampPhase(node, { confirm, noPush });
					if (r.status === 0) earned = r.earned;
					break;
				case 'placement':
					r = await placementPhase(node, earned, { confirm, noPush });
					break;
				case 'realize':
					r = realizePhase(node, { confirm });
					break;
				case 'benchmark':
					r = benchmarkPhase(node, { confirm });
					break;
				case 'health':
					r = healthPhase(node, { confirm });
					break;
				default: {
					// spawn steps: register, throttle, slice
					const machineFlag = step.fleetWide ? [] : ['--machine', node];
					r = run(process.execPath, [
						resolve(HERE, step.script),
						...machineFlag,
						...(confirm ? ['--confirm'] : []),
					]);
					if (r.status !== 0)
						r = { status: 1, remedy: `${step.script} failed — its output above is the remedy.` };
					break;
				}
			}
			// STOP AT THE FIRST FAILURE, and print THAT step's remedy — never a
			// later step's confusing error.
			if (r.status !== 0) {
				failures.push(step.id);
				console.error(`\n✗ ${step.id} failed — stopping before the steps that depend on it.`);
				if (r.remedy) console.error(`  Remedy: ${r.remedy}`);
				break;
			}
		}
	}

	if (!failures.length) await verifyPass(node, { confirm });
	return report(failures, { confirm, verifyOnly });
}

async function fleetRun({ confirm, verifyOnly }) {
	const manifest = loadManifest();
	const nodes = selectMachines(manifest, {});
	if (!nodes.length) {
		console.error(
			'provision-fleet: no nodes declared. A node is provisioned BECAUSE it is declared — ' +
				'add it with `fleet provision --machine <node> --confirm` (the chain declares it), or ' +
				'edit the fleet manifest by hand. A box missing from it is a box nothing will ever converge.'
		);
		return 1;
	}
	const machineFlag = [];
	P(
		`provision-fleet: ${nodes.length} node(s) — ${nodes.map(([n]) => n).join(', ')}\n` +
			`Mode: ${verifyOnly ? 'VERIFY ONLY' : confirm ? 'APPLY then VERIFY' : 'DRY RUN (apply steps run without --confirm)'}`
	);
	const failures = [];
	if (!verifyOnly) {
		for (const step of FLEET_APPLY) {
			const stepArgs = confirm ? step.args : step.args.filter((a) => a !== '--confirm');
			const s = run(process.execPath, [resolve(HERE, step.script), ...stepArgs, ...machineFlag]);
			// An apply step that fails STOPS the sequence: continuing would run the
			// next step against a node the previous one could not prepare.
			if (s.status !== 0) {
				failures.push(step.name);
				console.error(
					`\n✗ ${step.name} failed (exit ${s.status}) — stopping before the steps that depend on it.`
				);
				break;
			}
		}
	}
	if (!failures.length) await verifyPass(null, { confirm });
	return report(failures, { confirm, verifyOnly });
}

async function verifyPass(only, { confirm }) {
	const machineFlag = only ? ['--machine', only] : [];
	P(`\n\x1b[1m═══ verify (each step re-reads OBSERVED state) ═══\x1b[0m`);
	for (const step of VERIFY) {
		P(`\n\x1b[1m── verify: ${step.name}\x1b[0m`);
		if (
			run(process.execPath, [
				resolve(HERE, step.script),
				...verifyStepArgs(step, { confirm }),
				...machineFlag,
			]).status !== 0
		)
			verifyFailed.push(step.name);
	}
}

const verifyFailed = [];

function report(failures, { confirm, verifyOnly }) {
	P('');
	const all = [...failures, ...verifyFailed];
	if (all.length) {
		console.error(`✗ provision-fleet: ${all.length} step(s) did not converge:`);
		for (const f of all) console.error(`   ${f}`);
		console.error(
			`\n  Each step prints its own remedy above. Re-run the same command to resume: every\n` +
				`  step re-derives its state from what it observes, so a run stopped at step N\n` +
				`  resumes at N.`
		);
		return 1;
	}
	P(
		confirm || verifyOnly
			? '✓ every declared node matches the manifest, verified against observed state.'
			: '✓ dry run clean. Re-run with --confirm to apply.'
	);
	return 0;
}

async function main() {
	const args = process.argv.slice(2);
	const confirm = args.includes('--confirm');
	const verifyOnly = args.includes('--verify-only');
	const noPush = args.includes('--no-push');
	const addressIdx = args.indexOf('--address');
	const address = addressIdx !== -1 ? (args[addressIdx + 1] ?? null) : null;
	const only = machineArg(args, { valueFlags: ['--address'] });
	return only
		? onboardingRun(only, { confirm, verifyOnly, noPush, address })
		: fleetRun({ confirm, verifyOnly });
}

// Exported pure decisions above; the run itself happens only when invoked as a
// script, so the test file can import the decisions without side effects.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().then(
		(code) => process.exit(code),
		(err) => {
			console.error(`provision-fleet: ${err?.stack ?? err}`);
			process.exit(1);
		}
	);
}
