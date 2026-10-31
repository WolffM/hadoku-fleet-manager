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

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	loadManifest,
	machineArg,
	manifestPath,
	runOnSync,
	selectMachines,
} from './lib/fleet-exec.mjs';
import { placementBackfill } from './lib/enrollment-record.mjs';
import { isGuestNode } from '../dist/lib/node-role.js';
import {
	PAYLOAD_PROBE,
	flipDecision,
	REALIZE_SCRIPT,
	REALIZE_CHECK,
	ONBOARDING_STEPS,
	FLEET_APPLY,
	VERIFY,
	verifyStepArgs,
} from './lib/provision-plan.mjs';
import {
	run,
	P,
	declarePhase,
	convergePhase,
	bootcampPhase,
	benchmarkPhase,
	healthPhase,
	fastForwardManifest,
	applyPlacementWrite,
} from './lib/provision-phases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().then(
		(code) => process.exit(code),
		(err) => {
			console.error(`provision-fleet: ${err?.stack ?? err}`);
			process.exit(1);
		}
	);
}
