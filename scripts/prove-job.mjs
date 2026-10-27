#!/usr/bin/env node
/**
 * fleet prove-job — run ONE real workflow job on a named node, and read back
 * from GitHub whether it actually ran there.
 *
 *   fleet prove-job --node claw-8 --capability taskauto --json --out proof.json
 *   fleet prove-job --node claw-8 --repo WolffM/hadoku-tenhands \
 *       --workflow test.yml --job "backend pytest" --evidence 'claude resolved|passed'
 *
 * WHY: `taskauto` is ASSIGNED, so no probe settles it, and the job that uses it
 * needs an Actions secret that only a workflow run holds. See
 * `src/runners/prove-job.ts` — the orchestration, the reuse of the JIT mint, how
 * the proof runner is named so the reap sweep protects it, and why the race with
 * hokon is handled by reading `runner_name` rather than by trying to win it.
 * THIS FILE IS ONLY THE WIRING: real `gh`, real ssh, the real clock, the state
 * directory, and the exit code.
 *
 * THE JOB COMES FROM THE CAPABILITY when `--capability` is given: its `jobProof`
 * declaration in `src/capabilities.ts` (repo, workflow, job, evidence). Any of
 * `--repo --workflow --job --ref --evidence` overrides one field of it.
 *
 * FLAGS
 *   --node <name>            required. A guest is refused unless --include-guests.
 *   --include-guests         OPERATOR ONLY, and only with --node <a guest>: prove the
 *                            guest's STANDING registration in the canary repo (named
 *                            like the node, must be online). GitHub API only — no
 *                            mint, no ssh, no drain: a `proof-<nonce>` label is added
 *                            to it for the aimed canary and removed on every path.
 *                            The capability must declare an aimed canary (runs-on input)
 *   --capability <id>        take the job from the registry; the node must carry it
 *   --repo --workflow --job  name a job by hand (all three, without --capability)
 *   --ref <ref>              default main
 *   --evidence <regex>       log lines that show the capability ran (case-insensitive)
 *   --input k=v              one workflow_dispatch input; repeatable. Overrides the
 *                            capability's declared `inputs`, per key, when given
 *   --labels-override a,b    labels for THIS proof runner instead of the workflow's runs-on
 *   --attempts <n>           dispatch tries before `lost-race` (default 3, hard cap 6)
 *   --reap-stale             tear down a proof runner a killed run left LIVE
 *   --timeout-min <n>        whole-run bound (default 40)
 *   --json                   one JSON document on stdout, whatever the exit code
 *   --out <file>             also write the JSON there (the 8 KB pipe cliff does not apply)
 *   --no-record              do not update the proof ledger (state dir, job-proofs.json)
 *                            or the workload `$proof` facet
 *
 * EXIT: 0 only for a pass. Everything else — refused, lost-race, a failing job,
 * a job green without evidence, an API that could not be read, a teardown that
 * could not verify — is non-zero with the reason in `findings`. SIGTERM/SIGINT
 * abort the wait and STILL tear down before exiting 143.
 *
 * `$proof` (wave 4e, #102): for a capability whose `jobProof` declares a
 * `budget` — a WORKLOAD proof, not just a tool one — a PASSING run through
 * this command also records `$proof` (state dir, `src/lib/measured.ts`),
 * judged against the budget derived from every OTHER node's own fresh pass
 * (`buildProofRecord`). `nodeOffer`'s gate reads that record, not this
 * command's exit code. `--no-record` skips this the same as the job-proof
 * ledger.
 *
 * NOT UNDER THE --json CONTRACT: no cron parses it (it spends Actions minutes and
 * races a guest, so it is an operator act). If one is ever wired, add it to
 * `scripts/lib/json-contract.mjs` in the same change.
 *
 * @guards src/runners/prove-job.ts
 */
import { proofDrainState } from './lib/proof-drain.mjs';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

import { loadManifest, runOn, unconsumedArgs } from './lib/fleet-exec.mjs';
import { manifestDir, stateDir } from './lib/paths.mjs';
import { readDrains } from './lib/expected-down.mjs';
import { createEmitter } from './lib/emit.mjs';
import { recordProof } from './lib/job-proof-record.mjs';
import { guestPostCheck, proofShell } from './lib/prove-job-guest.mjs';
import { installCliHost } from '../dist/host.js';
import { nodeHome } from '../dist/lib/node-users.js';
import { isGuestNode } from '../dist/lib/node-role.js';
import { capability, workloadGatedCapabilities } from '../dist/capabilities.js';
import { buildProofRecord, proveJob, specFromCapability } from '../dist/runners/prove-job.js';
import { readProofsForCapability, writeProof } from '../dist/lib/measured.js';

/**
 * The mint logs through the in-process host (`src/host.ts`), which only
 * `createFleetManager` installs inside mgmt-api. A script has none, so the first
 * `logger.info` after a SUCCESSFUL mint threw "host not installed" (the first
 * real run, 0.25.15) — green in `src/tests`, which preload a test host. A CLI
 * host: stderr logging only, so `--json` stdout stays one document; anything else
 * the host offers (alerts, job sink) throws rather than no-ops. See `installCliHost`.
 */
const argv = process.argv.slice(2);
const out = createEmitter({ argv: process.argv });

const VALUE_FLAGS = [
	'--node',
	'--capability',
	'--repo',
	'--workflow',
	'--job',
	'--ref',
	'--evidence',
	'--input',
	'--labels-override',
	'--attempts',
	'--timeout-min',
	'--out',
];
const flag = (name) => {
	const eq = argv.find((a) => a.startsWith(`${name}=`));
	if (eq !== undefined) return eq.slice(name.length + 1);
	const i = argv.indexOf(name);
	const v = argv[i + 1];
	return i === -1 || v === undefined || v.startsWith('--') ? undefined : v;
};

/** Every occurrence of `--flag <value>` / `--flag=value`, in order — `flag()` only ever returns the first. */
const allFlags = (name) => {
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
		else if (a === name && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
			out.push(argv[i + 1]);
			i++;
		}
	}
	return out;
};

if (argv.includes('--help') || argv.includes('-h')) {
	out.log(
		'fleet prove-job --node <node> (--capability <id> | --repo R --workflow W --job J) [flags]'
	);
	out.log('');
	out.log("  Mints ONE ephemeral proof runner on the node carrying the job's runs-on labels,");
	out.log('  (or, for a guest with --include-guests, labels its standing runner for the canary),');
	out.log('  dispatches the workflow, reads which runner took the job FROM GITHUB, extracts');
	out.log('  the evidence lines from its log, and tears the runner down on every path.');
	out.log('  Exit 0 only for a pass. See the header of scripts/prove-job.mjs for the flags.');
	process.exit(0);
}

// AFTER --help, not before: installing the host resolves the manifest dir, which
// THROWS when it is missing, so usage text was unreachable without a fleet.
installCliHost({
	logger: {
		info: (m) => process.stderr.write(`${m}\n`),
		warn: (m) => process.stderr.write(`${m}\n`),
		error: (m) => process.stderr.write(`${m}\n`),
	},
	manifestDir: manifestDir(),
	stateDir: stateDir(),
});

/** A usage error: one JSON document under --json, exit 2. Nothing was touched. */
function usage(message) {
	if (out.json)
		out.emit({
			ok: false,
			verdict: 'refused',
			error: message,
			findings: [{ rule: 'usage', message }],
		});
	else console.error(`fleet prove-job: ${message}`);
	process.exit(2);
}

const stray = unconsumedArgs(argv, { valueFlags: VALUE_FLAGS });
if (stray.length)
	usage(`unrecognised argument(s): ${stray.join(' ')} (nodes are spelled --node <name>)`);
const nodeName = flag('--node');
if (!nodeName) usage('--node is required');

const over = {
	repo: flag('--repo'),
	workflow: flag('--workflow'),
	job: flag('--job'),
	ref: flag('--ref'),
	evidence: flag('--evidence'),
};
for (const k of Object.keys(over)) if (over[k] === undefined) delete over[k];
const capabilityId = flag('--capability');
let spec;
if (capabilityId) {
	const s = specFromCapability(capabilityId, { node: nodeName, ...over });
	if (!s.ok) usage(s.reason);
	spec = s.spec;
} else {
	if (!over.repo || !over.workflow || !over.job)
		usage('name the job: --capability <id>, or all of --repo --workflow --job');
	spec = { node: nodeName, ref: 'main', ...over };
}
spec.node = nodeName;
const inputPairs = allFlags('--input');
if (inputPairs.length) {
	const inputs = { ...(spec.inputs ?? {}) };
	for (const pair of inputPairs) {
		const eq = pair.indexOf('=');
		if (eq < 1) usage(`--input must be key=value, got "${pair}"`);
		inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	spec.inputs = inputs;
}
const override = flag('--labels-override');
if (override)
	spec.labelsOverride = override
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
const attempts = flag('--attempts');
if (attempts !== undefined) {
	if (!/^\d+$/.test(attempts) || Number(attempts) < 1)
		usage(`--attempts must be a positive integer, got "${attempts}"`);
	spec.maxAttempts = Number(attempts);
}
const timeoutMin = flag('--timeout-min');
if (timeoutMin !== undefined) {
	if (!/^\d+$/.test(timeoutMin) || Number(timeoutMin) < 1)
		usage(`--timeout-min must be a positive integer, got "${timeoutMin}"`);
	spec.timeoutMs = Number(timeoutMin) * 60_000;
}
spec.reapStale = argv.includes('--reap-stale');
const includeGuests = argv.includes('--include-guests');
if (includeGuests) spec.includeGuests = true;

// --- the real ports ----------------------------------------------------------

/** `gh api`, never throwing: `{ok, status, stdout, stderr}`. The operator's own `gh` auth. */
function gh(args, { input } = {}) {
	return new Promise((res) => {
		const child = execFile(
			'gh',
			['api', ...args],
			{ encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
			(err, stdout, stderr) => {
				const status = /HTTP (\d{3})/.exec(String(stderr))?.[1];
				res({
					ok: !err,
					status: err ? Number(status ?? 0) : 200,
					stdout: String(stdout ?? ''),
					stderr: String(stderr ?? ''),
					error: err
						? String(stderr || err.message)
								.trim()
								.split('\n')[0]
						: null,
				});
			}
		);
		if (input !== undefined) child.stdin.end(input);
		else child.stdin.end();
	});
}

const repoPath = (repo, path) => `repos/${repo}${path}`;

const ports = {
	get: async (path, _token, repo) => {
		const r = await gh([repoPath(repo, path)]);
		if (!r.ok) throw new Error(r.error);
		return r.stdout.trim() ? JSON.parse(r.stdout) : null;
	},
	text: async (path, _token, repo, accept) => {
		const r = await gh([...(accept ? ['-H', `Accept: ${accept}`] : []), repoPath(repo, path)]);
		if (!r.ok) throw new Error(r.error);
		return r.stdout;
	},
	write: async (method, path, _token, body, repo) => {
		const r = await gh(
			['-X', method, repoPath(repo, path), ...(body === undefined ? [] : ['--input', '-'])],
			{ input: body === undefined ? undefined : JSON.stringify(body) }
		);
		let parsed;
		try {
			parsed = r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
		} catch {
			parsed = undefined;
		}
		return { ok: r.ok, status: r.status, body: parsed };
	},
};

const manifest = loadManifest();
const nodeEntry = manifest.machines?.[nodeName];
if (!nodeEntry)
	usage(
		`"${nodeName}" is not a declared node (declared: ${Object.keys(manifest.machines ?? {}).join(', ')})`
	);
const nodeIsGuest = isGuestNode(nodeEntry);
if (includeGuests && !nodeIsGuest)
	usage(`--include-guests proves a GUEST's standing runner; ${nodeName} is not a guest`);
if (includeGuests) {
	process.stderr.write(
		`\n!!! PROVING A GUEST: ${nodeName} — operator opt-in (--include-guests).\n` +
			`!!! Its STANDING runner in ${spec.repo} gets a temporary proof-<nonce> label for ONE\n` +
			'!!! aimed canary; GitHub API only (no mint, no ssh, no drain), label removed on every path.\n\n'
	);
}

/** This node's drain row, from the same two locations `fleet drain` writes. */
function drainRow() {
	return readDrains()[nodeName];
}

// `--under-own-drain`: bootcamp --prove drained this node for the canary, so
// its own drain must not refuse the mint. See lib/proof-drain.mjs.
const drainState = proofDrainState(drainRow(), process.argv.includes('--under-own-drain'));
if ('error' in drainState) usage(drainState.error);

const controller = new AbortController();
let signalled = null;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
	process.on(sig, () => {
		// ONCE. A second signal while teardown runs must not cut the teardown short.
		if (signalled) return;
		signalled = sig;
		controller.abort();
	});
}

// The transport never reaches a guest, opt-in or not: standing mode needs no ssh.
// See lib/prove-job-guest.mjs for why `--include-guests` would otherwise open it.
// The call stays spelled out HERE, where the ssh-ing-script guards read for it.
const shell = proofShell({
	runOn: (node, cmd, opts) => runOn(node, cmd, { ...opts, as: 'ci' }),
	isGuest: (n) => isGuestNode(manifest.machines?.[n]),
});
const result = await proveJob(spec, {
	gh: ports,
	sh: shell.sh,
	// The node's ci user's home, where its slots live; never this box's own.
	homeDir: nodeHome(manifest.machines?.[spec.node], 'ci'),
	node: nodeEntry,
	drained: drainState.drained,
	now: () => Date.now(),
	sleep: (ms, signal) =>
		new Promise((resolve, reject) => {
			const t = setTimeout(resolve, ms);
			signal?.addEventListener(
				'abort',
				() => {
					clearTimeout(t);
					reject(new Error('aborted'));
				},
				{ once: true }
			);
		}),
	signal: controller.signal,
	pollMs: 5_000,
});
const guestBugs = guestPostCheck(result, {
	isGuest: nodeIsGuest,
	includeGuests,
	guestReached: shell.guestReached,
});
if (guestBugs.length) {
	result.findings.push(...guestBugs);
	result.ok = false;
}

let recordError = null;
if (!argv.includes('--no-record')) {
	const rec = recordProof(stateDir(), nodeName, result);
	if (!rec.ok) recordError = rec.reason;
}
// $proof (wave 4e, #102): ONLY for a capability whose jobProof declares a
// BUDGET — the workload half, never `taskauto`'s plain conclusion-decides
// shape. `refused` means nothing was attempted (the same rule
// `job-proof-record.mjs`'s own ledger already follows just above) and writes
// nothing. A run that never ran on the node (lost-race, a read failure, an
// abort) is INCONCLUSIVE and also writes nothing — `proofConclusive` says
// which; on 2026-10-08 a lost race filed FAIL and withheld jdk21 from two
// healthy claws. Only a job that ran on the node is evidence it has (or has
// not) EARNED the label, and `judgeWorkloadProof` says which and why.
let proofRecordError = null;
// Separate from `result.ok`: `proveJob` only ever judged the raw job
// (conclusion + evidence), and a workload-gated capability can still miss its
// BUDGET on a job that otherwise passed cleanly — the one `judgeWorkloadProof`
// reason `proveJob` has no finding for already.
let overBudget = false;
if (!argv.includes('--no-record') && result.capability && result.verdict !== 'refused') {
	const cap = capability(result.capability);
	if (cap && workloadGatedCapabilities().includes(cap.id)) {
		const otherNodesProofs = readProofsForCapability(cap.id, { dir: stateDir() }).filter(
			(r) => r.node !== nodeName
		);
		const built = buildProofRecord(cap, result, otherNodesProofs);
		if ('inconclusive' in built) {
			result.proofInconclusive = built.inconclusive;
			result.findings.push({ rule: 'proof-inconclusive', message: built.inconclusive });
		} else {
			const proofRecord = built.record;
			const w = writeProof(proofRecord, { dir: stateDir() });
			if (!w.ok) proofRecordError = `could not write $proof for ${nodeName}/${cap.id}: ${w.why}`;
			result.proofRecord = proofRecord;
			if (result.ok && proofRecord.verdict === 'fail') {
				overBudget = true;
				result.findings.push({ rule: 'workload-over-budget', message: proofRecord.why });
			}
		}
	}
}
if (recordError) result.findings.push({ rule: 'record-failed', message: recordError });
if (proofRecordError)
	result.findings.push({ rule: 'proof-record-failed', message: proofRecordError });
const okFinal = result.ok && !recordError && !proofRecordError && !overBudget;
result.ok = okFinal;

const outFile = flag('--out');
if (outFile) {
	try {
		writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
	} catch (err) {
		result.findings.push({
			rule: 'out-failed',
			message: `could not write --out ${outFile}: ${err.message}`,
		});
		result.ok = false;
	}
}

if (out.json) out.emit(result);
else {
	const v = result.verdict.toUpperCase();
	out.log(`${result.ok ? '✓' : '✗'} prove-job ${result.node}: ${v}`);
	out.log(`  job:    ${result.repo} ${result.workflow} / ${result.job} @ ${result.ref}`);
	out.log(`  labels: ${result.labels.join(', ') || '(none)'} [${result.labelSource ?? 'n/a'}]`);
	out.log(
		`  run:    ${result.runId ?? '-'}  job: ${result.jobId ?? '-'}  conclusion: ${result.jobConclusion ?? '-'}`
	);
	out.log(`  ranOnTarget: ${result.ranOnTarget}  runner: ${result.runnerName ?? '-'}`);
	for (const a of result.attempts) {
		out.log(
			`    attempt ${a.attempt}: run ${a.runId} -> ${a.runnerName ?? 'no runner'} (${a.jobConclusion ?? '?'}) ${a.note ?? ''}`
		);
	}
	for (const e of result.evidence) out.log(`  evidence: ${e}`);
	out.log(`  teardown: ${result.teardown.ok ? 'clean, verified' : 'FAILED'}`);
	for (const f of result.findings) console.error(`  ! ${f.rule}: ${f.message}`);
}
process.exit(signalled ? 143 : result.ok ? 0 : 1);
