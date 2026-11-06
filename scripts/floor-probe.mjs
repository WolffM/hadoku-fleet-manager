#!/usr/bin/env node
/**
 * floor-probe — P3.2, the forced-placement harness.
 *
 * WHAT THIS IS FOR, IN ONE SENTENCE: the fleet has served the same
 * `(repo, runId, jobName)` on two distinct nodes **0 times in 7,033 jobs**, so
 * "would this have failed somewhere else?" cannot be answered from history that
 * already exists — it has to be MANUFACTURED, and this is the thing that
 * manufactures it.
 *
 * Built to `docs/planning/claw-floor-design-2026-09-07.md` (lane F). Section
 * references below are that document's; the rules themselves live in
 * `lib/floor-probe.mjs` with tests beside them, because a rule that only exists
 * inside a script that talks to GitHub and ssh's to six boxes cannot be
 * exercised.
 *
 * SIX MODES
 * ---------
 *   report      the per-node zone table over the WHOLE retention window, every
 *               node and every repo (or one, with `--repo`). READ-ONLY BY
 *               CONSTRUCTION: it reads job-history and the manifest and makes
 *               no GitHub call, no ssh, no dispatch, no mint and no write. This
 *               is the mode that answers "whose failures are the fleet's", and
 *               it exists because `table` is scoped to one `(repo, job)` — a
 *               question about a NODE cannot be asked one unit at a time when
 *               the busiest node/unit pair has 31 samples in fourteen days.
 *   table       (default) the per-node table for one `(repo, job)`, from
 *               job-history plus this harness's own settled probes. Reads
 *               nothing but disk. This is what a later reader — the panel, a
 *               gate, lane I's `orderCandidates()` — consumes.
 *   candidates  §2's ordered candidate list for that unit: weakest-first, with
 *               margins, exclusions and `floorConfidence`.
 *   window      §7's quiet-window predicate, on its own, so an operator can ask
 *               "may I probe right now" without dispatching anything.
 *   probe       §6's SHADOW path. Mints on ONE named node, dispatches a
 *               workflow, waits, and records what actually served it. Needs
 *               `--confirm`; without it this plans and prints and touches
 *               nothing.
 *   rerun       §5/§6's FORCED RE-RUN path (Control A). Re-dispatches a job that
 *               already failed in the runner or seam zone, with the failing node
 *               EXCLUDED (`--onto`), and records the attempt against it.
 *
 * THE SAFETY PROPERTY THE WHOLE THING EXISTS TO PROTECT (§6): a probe is never
 * a consumer's only attempt. A fleet-origin failure must never be what somebody
 * sees as "my code is broken". Three things enforce it, and none of them is a
 * comment:
 *
 *   1. `shadowSafety()` refuses any workflow that dispatches, redeploys or
 *      publishes — the first workflow anyone would reach for
 *      (hadoku-pygmalion's `redeploy.yml`, which holds the `test` job issue #3
 *      is actually about) ends in a job that takes prod pygmalion down and back
 *      up.
 *   2. `--confirm` is required to make any write at all.
 *   3. Every call goes through the blackout-aware `ghGet`/`ghWrite` in
 *      `runner-health.ts`. A fourth uncoordinated caller is how the fleet spent
 *      19 minutes of every hour unable to poll or mint on 2026-09-05.
 *
 * HOW "FORCED" IS ACTUALLY FORCED, AND HOW IT IS VERIFIED
 * ------------------------------------------------------
 * Under all-JIT nothing can be pinned to a node by asking GitHub. What CAN be
 * done is to have a runner on the chosen node ALREADY LISTENING when the job is
 * created: GitHub hands a queued job to an idle matching runner in about two
 * seconds, well inside the dispatcher's 15s tick, so the probe's runner is
 * usually the only one that ever exists for that job. `modeProbe`'s docblock
 * carries the measurement that forced this ordering — the first version minted
 * AFTER dispatching and collided with mgmt-api on claw-2 inside one second.
 *
 * It is still a RACE and it is not pretended otherwise: hokon holds standing
 * `hadoku-builder` registrations, and the dispatcher may still see the job
 * queued on one tick. So the probe does not trust its own intention — it reads
 * `runner_name` BACK from GitHub and records intended-vs-observed. A probe that
 * landed elsewhere reports MISSED, is not counted as evidence about the intended
 * node, and is still recorded as a real sample of the node that DID serve it,
 * because a probe that silently retargets itself is worse than one that admits
 * it.
 *
 * NOT WIRED TO A CRON, DELIBERATELY. Adding an entry to
 * `scripts/lib/json-contract.mjs` before the mgmt-api file that names it exists
 * opens a red `contract-consumers` window: land the repo that CREATES a consumer
 * before the repo that NAMES it. `--json` costs nothing and is implemented on
 * the same footing as every other `check-*.mjs`; the contract DECLARATION waits
 * for its consumer.
 *
 * SPLIT ACROSS FILES (wave 5q lane A, ctx restructure): every mode's own
 * logic — `report`, `table`, `candidates`, the two that mint (`probe`,
 * `rerun`) — lives in `lib/floor-probe-mode-*.mjs`, taking this file's flags
 * and run-scoped state through one `ctx` object built once, below. So do the
 * quiet-window I/O (`lib/floor-probe-window-check.mjs`), the workload-gated
 * mint labels (`lib/floor-probe-mint-labels.mjs`), `job-history.jsonl`
 * (`lib/floor-probe-history.mjs`) and the probe-intent declaration
 * (`lib/floor-probe-state.mjs`, beside the ledger it already owned). What
 * stays here: `sh` and `probeSlotIsFree` are this file's only `runOn` call
 * sites (`expected-down-guard.test.mjs` scans only top-level `scripts/*.mjs`
 * files for that pairing), `fail`/`flag`/the manifest load build the ctx
 * every mode reads, and the final mode dispatch ties it together. No lib
 * imports this file.
 */
import { join } from 'node:path';
import process from 'node:process';

import { manifestDir, stateDir, siteRoot } from '../dist/lib/fleet-paths.js';
import { createEmitter } from './lib/emit.mjs';
import { loadManifest, runOn } from './lib/fleet-exec.mjs';
import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { parseStrict } from './lib/argv.mjs';
// The BUILT copy, for the same reason fleet-exec.mjs imports isLocalNode that
// way: one question, one answer, and no second implementation to drift from.
import { isBackstopNode } from '../dist/lib/node-role.js';
import { parseMode, foreignFlags } from './lib/floor-probe.mjs';
import { loadHistory } from './lib/floor-probe-history.mjs';
import { checkQuietWindow } from './lib/floor-probe-window-check.mjs';
import { buildWorkloadGate, mintLabelsFor } from './lib/floor-probe-mint-labels.mjs';
import { modeReport } from './lib/floor-probe-mode-report.mjs';
import { modeTable } from './lib/floor-probe-mode-table.mjs';
import { modeCandidates } from './lib/floor-probe-mode-candidates.mjs';
import { modeProbe } from './lib/floor-probe-mode-probe.mjs';
import { modeRerun } from './lib/floor-probe-mode-rerun.mjs';
import { installHost } from '../dist/host.js';
import { liveJitSlots } from '../dist/runners/ephemeral-exec-jit.js';

/**
 * The library half needs a HOST before any of it runs — `logger`, `stateDir` and
 * the manifest paths are injected, not compiled in, and `ghWrite`/
 * `mintEphemeralRunner` both log. `installHost` rather than
 * `createFleetManager`: the manager is a singleton that also builds the monitors,
 * and a CLI has no business constructing the thing that ticks. Installed at
 * module scope because several library modules resolve paths at import time —
 * the same reason `install-test-host.ts` is a `--import` preload.
 *
 * The four paths are the same four mgmt-api passes (`services/mgmt-api/src/fleet.ts`),
 * resolved through `lib/paths.mjs` so this command and the service name ONE
 * location each rather than two that agree until one moves. `requirePaths` throws
 * on any of them missing, which is the correct failure: every loader behind them
 * turns an absent file into an empty result, and an empty result reads as a
 * healthy fleet of nothing.
 */
installHost({
	logger: {
		// stderr, never stdout. `--json` means this command's stdout is exactly one
		// JSON document, and a library warning printed mid-run would corrupt it for
		// the same parser the rest of the fleet's gates feed.
		info: (m) => process.stderr.write(`${m}\n`),
		warn: (m) => process.stderr.write(`${m}\n`),
		error: (m) => process.stderr.write(`${m}\n`),
	},
	// A CLI does not page anybody. The probe's finding is its exit code and its
	// stdout; posting to Discord from an operator-invoked command would put an
	// alert in front of the only person who already knows it ran.
	alerts: {
		post: () => Promise.resolve({ posted: false, sinkRecorded: false }),
		recordQuietly: () => undefined,
	},
	jobs: { recordJobResult: () => Promise.resolve() },
	githubToken: () => process.env.HADOKU_SITE_TOKEN?.trim() || undefined,
	manifestDir: manifestDir(),
	stateDir: stateDir(),
	storeDoctorPath: join(siteRoot(), 'scripts', 'ci', 'pnpm-store-doctor.sh'),
});

const argv = process.argv.slice(2);
// F8 (plan §4.1): strict, from the one spec argv-specs.mjs declares — this is
// the UNION of every mode's flags (`MODE_FLAGS` in lib/floor-probe.mjs is the
// per-mode authority; `foreignFlags` below still refuses a flag given to the
// wrong mode, by name). This layer only catches a flag no mode knows at all.
const parsed = parseStrict(ARGV_SPECS['floor-probe.mjs'], argv);
const JSON_OUT = argv.includes('--json');
const CONFIRM = argv.includes('--confirm');
const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;

/**
 * `ctx.flag` (unchanged name/signature — every `lib/floor-probe-mode-*.mjs`
 * reads it off `ctx` by this name): `name` without its leading `--`, reading
 * through the shared parser's `value()` rather than re-walking `argv` here.
 * The guard against swallowing the NEXT FLAG as a value — `report --days
 * --repo x` must read `--days` as ABSENT, not as the literal string
 * `--repo` — has no equivalent in `parsed.value`, so it stays local.
 */
const readFlag = (name, fallback = null) => {
	const v = parsed.value(`--${name}`);
	return v !== null && !v.startsWith('--') ? v : fallback;
};

/**
 * Every exit that is not a clean pass goes through here — reason included.
 *
 * `detail` is a list of lines printed under the message on the human path and
 * carried in `extra` on the JSON one. A finding that names a thing and nothing
 * else is undiagnosable after the fact: `check-queue-health` named a repo and
 * only a repo until 2026-09-07, and its five findings that day could not be
 * told apart afterwards.
 */
function fail(msg, extra = {}) {
	if (JSON_OUT) emitter.emit({ ok: false, error: msg, ...extra });
	else {
		console.error(`✗ ${msg}`);
		for (const line of extra.detail ?? []) console.error(`    ${line}`);
	}
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Inputs. Every one of these FAILS rather than degrading to empty — "I could
// not look" must never render as "nothing is wrong".
// ---------------------------------------------------------------------------

let manifest;
try {
	manifest = loadManifest();
} catch (err) {
	fail(`cannot read the fleet manifest: ${err.message}`);
}
const machines = manifest.machines ?? {};
const NODES = Object.keys(machines);
if (!NODES.length)
	fail('the manifest declares no machines — a healthy fleet of zero is not a pass');

/**
 * The nodes a probe may place on. EPHEMERAL, AND NOT THE BACKSTOP.
 *
 * Both halves are enforced, and the second one is not redundant. A probe mints a
 * real runner and pushes a real job onto the node it names, so this list is the
 * blast radius of `--node` and of `--onto` — and `--onto` exists precisely to
 * FORCE a re-run somewhere the job did not choose to go. A probe measures the
 * routing speed rank, and the backstop is placed after every claw rather than
 * ranked: it is the emergency backstop, not capacity, and the production host.
 *
 * The backstop declares no `ephemeral` key today, but that is one manifest edit
 * from being false. The rule is the ROLE; `ephemeral` is a capacity fact that
 * happens to agree.
 */
const CLAWS = NODES.filter((n) => machines[n]?.ephemeral === true && !isBackstopNode(machines[n]));

/** Named separately so a refusal can say WHICH rule refused — see `notAProbeTarget`. */
const BACKSTOPS = NODES.filter((n) => isBackstopNode(machines[n]));

/**
 * Why a node cannot be probed, in the words that fit it.
 *
 * "not an ephemeral node in the manifest" is true of the backstop and sends the
 * reader to the wrong fix — they would add `ephemeral: true` to it. A refusal
 * that names the wrong cause is unactionable, which is the point of saying WHY.
 */
const notAProbeTarget = (node) =>
	BACKSTOPS.includes(node)
		? `${node} is the BACKSTOP — it is not ranked for routing, so a probe may never be ` +
			`forced onto it. Name a claw: ${CLAWS.join(', ') || '(none)'}`
		: `${node} is not an ephemeral node in the manifest`;

// ---------------------------------------------------------------------------
// GitHub, metered and blackout-aware
// ---------------------------------------------------------------------------

/**
 * Refuse to mint into PROBE_SLOT if something is already listening there.
 *
 * The collision this slot reservation exists to prevent has two sources, and
 * reserving a high slot only fixes ONE of them: the dispatcher cannot reach slot
 * 9, but a SECOND copy of this command can, and would provision it with
 * `RESET=1` straight over the first probe's config. Two operators, or one
 * operator and a loop, is not an exotic case — it is how the sweep that measured
 * §2.1 was run.
 *
 * Read from the node's own process tree — the same source `dispatch-pass` uses —
 * rather than from anything this process remembers, because the other probe is
 * in another process and there is nothing here to remember.
 */
async function probeSlotIsFree(node) {
	const slots = await liveJitSlots(node, sh);
	return !slots.has(PROBE_SLOT);
}

/**
 * The slot a probe's runner takes on the node, reserved and deliberately high.
 *
 * `dispatch-pass` takes the LOWEST free slot from the node's own process tree,
 * and `jit-provision.sh` runs `RESET=1` — so two minters that both start
 * counting at zero rewrite each other's config. That is §12.16, and it happened
 * on claw-2 at 18:04 on 2026-09-08 between this harness and mgmt-api. Nine is
 * unreachable by the dispatcher's walk while the largest `maxConcurrent` in the
 * manifest is 3, which makes the collision impossible rather than unlikely.
 */
const PROBE_SLOT = 9;

/**
 * How long a probe's runner may sit listening.
 *
 * Much shorter than the dispatcher's 3600s, because these two hold the slot for
 * opposite reasons: the dispatcher mints for a job that already exists, this
 * mints BEFORE one does. A probe whose dispatch fails silently would otherwise
 * hold a listener on a claw for an hour waiting for work nobody sent. Fifteen
 * minutes comfortably covers a 10-minute `timeout-minutes` job plus its queue.
 */
const PROBE_TTL_SECONDS = 900;

/**
 * Run a command on a node. `null` on failure, which is `ShellLike`'s contract —
 * `mintEphemeralRunner` reads a null as "unreachable" and refuses to mint, and
 * returning an empty string instead would make an unreachable box look like one
 * that answered with nothing.
 */
const sh = async (node, command) => {
	const r = await runOn(node, command, { as: 'ci', timeoutMs: 120_000 });
	return r.ok ? r.stdout : null;
};

/**
 * This run's workload gate (wave 4e follow-up, #102), and the mint label set
 * it feeds into — both now `lib/floor-probe-mint-labels.mjs`'s, built once
 * here and bound to this run's `NODES`/`machines` so `modeProbe`/`modeRerun`
 * can call `ctx.mintLabelsFor(node)` without reaching back into this file.
 */
const workloadGate = buildWorkloadGate(NODES);
const mintLabelsForNode = (node) => mintLabelsFor(node, machines, workloadGate);

// ONE CONTEXT OBJECT, handed into every lib function EXPLICITLY — never a
// reverse import (see the header's SPLIT ACROSS FILES note, and the
// bootcamp.mjs/check-label-floor.mjs precedent this follows).
const ctx = {
	flag: readFlag,
	argv,
	fail,
	CONFIRM,
	JSON_OUT,
	emitter,
	log,
	machines,
	NODES,
	CLAWS,
	notAProbeTarget,
	sh,
	probeSlotIsFree,
	PROBE_SLOT,
	PROBE_TTL_SECONDS,
	mintLabelsFor: mintLabelsForNode,
	checkQuietWindow: () => checkQuietWindow(fail),
};

// ---------------------------------------------------------------------------

// THE MODE IS THE FIRST ARGUMENT — see `parseMode`, which carries the two
// measured ways the previous `argv.find(...)` misread this command's own argv.
const mode = parseMode(argv);
// A FLAG THAT BELONGS TO ANOTHER MODE IS A REFUSAL, not a default. See
// `foreignFlags`: without this, `--onto claw-6 --repo … --run …` with no mode
// prints a table of an unrelated unit and exits 0.
{
	const foreign = foreignFlags(mode, argv);
	if (foreign.length) {
		fail(`mode "${mode}" does not take ${foreign.map((f) => f.flag).join(', ')}`, {
			mode,
			foreign,
			detail: foreign.map(
				(f) =>
					`${f.flag} belongs to ${f.owners.length ? f.owners.join(' / ') : 'no mode'} — ` +
					`did you mean \`fleet floor-probe ${f.owners[0] ?? '<mode>'} ${f.flag} …\`?`
			),
		});
	}
}
// HISTORY IS LOADED ONLY BY THE MODES THAT READ IT. `loadHistory` fails loudly
// on a missing file, which is right for a table and wrong for `window`: a box
// that has never recorded a job can still answer "may I probe now", and failing
// there would report a scheduling question as a missing-data error.
const needsHistory =
	mode === 'table' || mode === 'candidates' || mode === 'rerun' || mode === 'report';
const { rows } = needsHistory ? loadHistory(fail) : { rows: [] };

let code = 0;
if (mode === 'report') code = modeReport(ctx, rows);
else if (mode === 'table') code = modeTable(ctx, rows);
else if (mode === 'candidates') code = modeCandidates(ctx, rows);
else if (mode === 'window') {
	// A PREDICATE, so the exit code is the answer: 0 for "yes, probe now", 1 for
	// "no", which makes `if fleet floor-probe window; then …` mean what it reads
	// like. "Not quiet" is not a fault, and the JSON says which of the three
	// reasons it is — `reserved`, `cron` or `could-not-tell`, and the third is the
	// one an operator has to act on.
	const w = checkQuietWindow(fail);
	if (JSON_OUT) emitter.emit({ ok: w.quiet, mode: 'window', ...w });
	else {
		log(`quiet window: ${w.quiet ? 'YES' : `NO — ${w.why}: ${w.detail}`}`);
		log(`  daily cron schedules read: ${w.schedulesSeen}`);
		log(`  reservation: ${w.reservationSource}`);
		for (const u of w.unreadable) log(`  could not read: ${u}`);
	}
	code = w.quiet ? 0 : 1;
} else if (mode === 'probe') code = await modeProbe(ctx);
else if (mode === 'rerun') code = await modeRerun(ctx, loadHistory(fail).rows);
else fail(`unknown mode "${mode}" — one of: report, table, candidates, window, probe, rerun`);

process.exit(code);
