/**
 * `fleet bootcamp --prove`'s workload canary — split out of
 * scripts/bootcamp.mjs (wave 5p lane D) so the CLI stays under the 800-line
 * ceiling. Takes the CLI's flags and run-scoped state through `ctx`; never
 * imports the CLI.
 */
import process from 'node:process';
import { canaryPlan, OWN_DRAIN_REASON_PREFIX } from './proof-drain.mjs';
import { busyCount, waitUntilDrained } from './drain-wait.mjs';
import { createLiveDeps } from './refresh-cycle-live.mjs';
import { spawnJsonToFile } from './spawn-json.mjs';
import { capability } from '../../dist/lib/capability-registry.js';
import { workloadGatedCapabilities } from '../../dist/lib/workload-gate.js';
import { readProof } from '../../dist/lib/measured-proof.js';
import { stateDir } from '../../dist/lib/fleet-paths.js';
import { qualifiesForCanary } from './toolchain-floor.mjs';

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
async function runCanary(ctx, name, id) {
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
		return { node: name, capability: id, status: 'deferred', reason: `drain failed: ${e.message}` };
	}
	if (drained?.ok === false) {
		return {
			node: name,
			capability: id,
			status: 'deferred',
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
				status: 'deferred',
				reason: `never went quiet: ${wait.reason ?? 'timed out'}`,
			};
		}
		// STDOUT TO A FILE, NEVER A PIPE (F6, #33): `fleet prove-job`'s `evidence`
		// and `findings` arrays are long enough that the old `execFileSync` pipe
		// capture here measurably lost data on a large doc (reproduced: a plain
		// 1,000,000-byte child write landed as 146,176 through a pipe, intact
		// through a file). `spawnJsonToFile` also drops the throw/catch dance:
		// `prove-job.mjs` exits non-zero for everything but a pass and ALWAYS
		// prints its one JSON document first, and parseable stdout wins over the
		// exit code regardless of how the child ended.
		const run = await spawnJsonToFile(
			process.execPath,
			[ctx.PROVE_JOB_SCRIPT, '--node', name, '--capability', id, '--json', '--under-own-drain'],
			{ timeoutMs: 45 * 60_000 }
		);
		const doc = run.doc;
		if (doc === null) {
			return {
				node: name,
				capability: id,
				status: 'error',
				reason: `fleet prove-job did not produce JSON: ${run.why}`,
			};
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
export async function proveWorkloads(ctx) {
	if (!ctx.PROVE) return [];
	const { nodes, report, DUE_DAYS } = ctx;
	const outcomes = [];
	for (const [name, m] of nodes) {
		const r = report[name];
		if (!r) continue; // this run could not reach it at all
		for (const id of workloadGatedCapabilities()) {
			if (!r.earned.includes(id)) continue; // tool not earned here, this run
			// A node that declines the canary's own repo (`excludeRepos`) would
			// never be routed the workload, so a proof there means nothing, and the
			// canary would drain it for nothing. claw-1/3/5 decline cardtable.
			const canaryRepo = capability(id)?.jobProof?.repo;
			if (canaryRepo && canaryRepo in (m.excludeRepos ?? {})) {
				outcomes.push({
					node: name,
					capability: id,
					status: 'skipped',
					reason: `${canaryRepo} is excluded on this node`,
				});
				continue;
			}
			if (!qualifiesForCanary(id, m)) {
				outcomes.push({
					node: name,
					capability: id,
					status: 'skipped',
					reason: `CPU floor not met for the canary (cores=${m.cores ?? 'unmeasured'})`,
				});
				continue;
			}
			// A VERDICT ABOUT THE NODE waits out `--due`: a pass is re-proved and a
			// FAIL retried on the same cadence, so a scheduled `--prove` does not
			// drain a failing node every night. Anything else (error, lost-race,
			// timeout, refused, teardown-failed) says nothing about the node and is
			// retried at once: claw-9's canary was skipped by the workflow on
			// 2026-11-07, recorded `error`, and must not then wait 25 days.
			const existing = readProof(name, id, { dir: stateDir() });
			if (existing && (existing.verdict === 'pass' || existing.verdict === 'fail')) {
				const ageDays = (Date.now() - Date.parse(existing.at)) / 86_400_000;
				if (Number.isFinite(ageDays) && ageDays <= DUE_DAYS) {
					outcomes.push({
						node: name,
						capability: id,
						status: 'not-due',
						reason: `last ${existing.verdict} ${existing.at} (${ageDays.toFixed(1)}/${DUE_DAYS}d)`,
					});
					continue;
				}
			}
			outcomes.push(await runCanary(ctx, name, id));
		}
	}
	return outcomes;
}

/** Prints `--prove`'s outcomes and counts a finding for each non-passing one. */
export function printProveResults(ctx, proveResults) {
	const { log } = ctx;
	if (!proveResults.length) return;
	log('\n── workload canaries (--prove) ──');
	for (const p of proveResults) {
		if (p.status === 'pass') log(`   PASS: ${p.capability}@${p.node} — ${p.why ?? ''}`);
		else if (p.status === 'fail') {
			ctx.findings++;
			log(`   FAIL: ${p.capability}@${p.node} — ${p.why ?? 'no reason given'}`);
		} else if (p.status === 'error') {
			ctx.findings++;
			log(`   ERROR: ${p.capability}@${p.node} — ${p.reason}`);
		} else if (p.status === 'deferred') {
			// DUE and not run: the node could not be drained or never went quiet.
			// A finding, because the label expires 30 days after its last pass
			// whether or not anyone got round to re-proving it.
			ctx.findings++;
			log(
				`   DEFERRED: ${p.capability}@${p.node} — ${p.reason}; the proof is due and was not re-run`
			);
		} else if (p.status === 'inconclusive') {
			// Nothing recorded, and nothing proven: a finding, never a quiet pass.
			ctx.findings++;
			log(`   INCONCLUSIVE: ${p.capability}@${p.node} — ${p.reason} (no $proof written)`);
		} else log(`   ${p.status}: ${p.capability}@${p.node} — ${p.reason ?? p.why ?? ''}`);
	}
}
