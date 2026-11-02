#!/usr/bin/env node
/**
 * retire — take a node permanently out of the fleet.
 *
 * Composes what already exists (refactor plan §5.3 scenario R3,
 * `docs/runbooks/retire-node.md`) rather than re-implementing any of it:
 *
 *   1. drain       — the SAME drain record `fleet drain` writes
 *                     (`scripts/lib/expected-down.mjs`), and the SAME verdict
 *                     (`drainStatus`/`effectiveDrains`, `src/runners/drain.ts`)
 *                     `fleet drain --status` reads.
 *   2. deregister  — the SAME GitHub calls the reconciler's removal path uses
 *                     (`removeScript`, `mintToken`, `ghWrite`,
 *                     `scripts/lib/reconcile-{scripts,apply}.mjs`), scoped to
 *                     every registration THIS node holds (standing, warm or
 *                     JIT), not only a repo-level orphan.
 *   3. manifest    — `scripts/lib/manifest-edit.mjs`'s `manifestEdit`, the
 *                     one transactional writer, removing `machines[node]` and
 *                     adding the name to the RETIRED-NAME LEDGER in the SAME
 *                     atomic write (see the ledger note below).
 *   4. facets      — the node's `$benchmark`/`$health`/`$proof` state-dir
 *                     records are copied into one archive file, THEN removed
 *                     from the live files — archive first, so a failure
 *                     between the two steps never loses the record, only
 *                     leaves a harmless duplicate.
 *
 * Everything else R3 names (coverage regeneration, tailnet removal, the
 * hardware inventory) is PRINTED as a remaining step, never run: coverage is
 * this package's own `fleet reconcile --write-coverage` and does not need
 * composing into a second command, and tailnet/inventory are operator-only by
 * design (this repo holds neither credential).
 *
 * THE RETIRED-NAME LEDGER lives in the manifest itself, as a top-level
 * `retired: string[]` array, rather than a second file beside it. A
 * retirement already has to touch the manifest (deleting `machines[node]`),
 * and recording the name in the SAME `manifestEdit` transaction is one
 * atomic write instead of two — a crash or a refused land between a manifest
 * edit and a separate ledger write would otherwise leave a node un-declared
 * but NOT on the ledger, which is exactly the gap `fleet enroll` must close
 * (docs/runbooks/replace-claw.md's Gap: "nothing checks a proposed name
 * against every claw that has EVER existed"). `fleet enroll` refuses a name
 * on `retired` before it probes anything.
 *
 * A node must be QUIET before anything mutates: no job running, and no live
 * WARM/JIT registration GitHub could still assign to directly (the same
 * check `fleet drain --status` makes, #90). If it is not yet quiet, `--confirm`
 * drains it — but ONLY if nothing has — and then REFUSES to go further this
 * run: a drain is a soft close, and running work finishes in its own time, not
 * this command's.
 *
 * USAGE
 *   fleet retire claw-9                    # DRY RUN: the plan, nothing done
 *   fleet retire claw-9 --confirm           # do it
 *   fleet retire claw-9 --confirm --reason "psu failure"
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { parseStrict } from './lib/argv.mjs';
import { createEmitter } from './lib/emit.mjs';
import { loadManifest, manifestPath, remoteCommand, runOn } from './lib/fleet-exec.mjs';
import { manifestEdit } from './lib/manifest-edit.mjs';
import { landingLine } from './lib/manifest-target.mjs';
import { deferralFor, deferralNote, readDrainDoc, writeDrainDoc } from './lib/expected-down.mjs';
import { mintToken, listRunners, ghWrite } from './lib/reconcile-apply.mjs';
import { removeScript } from './lib/reconcile-scripts.mjs';
import { maySudo } from './lib/operator-sudo.mjs';
import { stateDir } from '../dist/lib/fleet-paths.js';
// The BUILT copies, for the same reason every other script in this door reads
// a decision from `dist/` rather than keeping a second implementation that
// can drift from it (docs/VOCABULARY.md: "one question, one answer").
import { nodeOf } from '../dist/runners/census.js';
import { drainStatus, effectiveDrains } from '../dist/runners/drain.js';
import { writeFileAtomic } from '../dist/lib/atomic-json.js';
import { readFacetFile } from '../dist/lib/measured.js';
import { MEASURED_FACETS } from '../dist/lib/measured-paths.js';

const parsed = parseStrict(ARGV_SPECS['retire-node.mjs'], process.argv.slice(2));
const emitter = createEmitter({ json: parsed.json });
const log = emitter.log;

function finish(result, code) {
	if (parsed.json) emitter.emit(result);
	process.exit(code);
}
function die(message, extra = {}) {
	if (!parsed.json) console.error(`retire: ${message}`);
	finish({ ok: false, error: message, ...extra }, 1);
}

const NODE = parsed.positionals[0] ?? null;
if (!NODE) die('name a node. See --help.');
const CONFIRM = parsed.has('--confirm');
const NO_PUSH = parsed.has('--no-push');
const DEFAULT_REASON = 'retiring — see docs/runbooks/retire-node.md';
const REASON = parsed.value('--reason') ?? DEFAULT_REASON;

const MANIFEST = manifestPath();
let doc;
try {
	doc = loadManifest(MANIFEST);
} catch (err) {
	die(`cannot read ${MANIFEST}: ${err.message}. Refusing — retiring blind is worse than waiting.`);
}

const alreadyRetired = (doc.retired ?? []).includes(NODE);
const machine = doc.machines?.[NODE];

if (!machine) {
	if (alreadyRetired) {
		log(`${NODE} is already retired (on the ledger, no manifest entry). Nothing to do.`);
		finish({ ok: true, node: NODE, alreadyRetired: true }, 0);
	}
	die(
		`${NODE} is not declared in ${MANIFEST} and is not on the retired-name ledger either — nothing to retire.`
	);
}
if (alreadyRetired) {
	// Inconsistent state (declared AND on the ledger) — say so rather than
	// silently picking one; this should never happen if `manifestEdit`'s own
	// atomic write is the only writer of both.
	die(
		`${NODE} is BOTH declared in ${MANIFEST} AND on the retired-name ledger. ` +
			`This should be impossible — fix the manifest by hand before retiring it again.`
	);
}

// A HOSTING NODE CARRIES A PROMISE TO A TENANT. Retiring it without ending
// that first would pull CI *and* the tenant's slice out from under it with
// no notice — `fleet hosting <node> --end` is the door that owes the notice.
const drainDoc = readDrainDoc();
const now = Date.now();
const drainState = effectiveDrains(drainDoc, now);
if (drainState[NODE]?.kind === 'hosting') {
	die(`${NODE} is a hosting node. End it first: fleet hosting ${NODE} --end --in 30m.`, {
		node: NODE,
		hosting: true,
	});
}

const WARM_PREFIX = 'warm-';
const JIT_PREFIX = 'jit-';

/**
 * Every registration this node holds, in ANY covered repo — standing, warm
 * or JIT alike. Broader than `fleet drain --status`'s own scan (which looks
 * only at WARM_PREFIX/JIT_PREFIX names, because that is the one question a
 * drain's own enforcement needs answered): retiring removes a standing
 * registration too, so the scan that feeds the deregister step must not be
 * narrowed to the drain-readiness question alone.
 *
 * `{ok:true, regs}` or `{ok:false, reason}` — "could not look" never renders
 * as "nothing is registered".
 *
 * `fleet-roster.mjs` IS IMPORTED DYNAMICALLY, inside this function, never at
 * module scope: its `allRepos` resolves the coverage file's path at IMPORT
 * TIME, which throws when `FLEET_MANIFEST_DIR` is unset or absent — exactly
 * the trap `fleet-exec.mjs`'s own header names ("merely IMPORTING the
 * transport layer demanded operator config"). A static import here would
 * make `fleet retire --help` throw before `parseStrict` ever got to answer
 * it, in a sandbox with no manifest dir at all (`cli-help.test.mjs`).
 */
async function scanNodeRunners(node) {
	let repos;
	try {
		const { allRepos } = await import('./lib/fleet-roster.mjs');
		repos = allRepos({ includeHost: true });
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
	const fleetNodeNames = Object.keys(doc.machines ?? {});
	const regs = [];
	for (const repo of repos) {
		const r = await listRunners(repo);
		if (!r.ok) return { ok: false, reason: `${repo}: ${r.error}` };
		for (const runner of r.runners ?? []) {
			if (!runner?.name) continue;
			if (nodeOf(runner.name, fleetNodeNames) === node) {
				regs.push({ repo, id: runner.id, name: runner.name });
			}
		}
	}
	return { ok: true, regs };
}

/** Running jobs, OBSERVED on the node — same probe `fleet drain --status` uses. */
function busyOn(node) {
	const PROBE = 'pgrep -c -f "[R]unner\\.Worker" || true';
	try {
		const [cmd, cmdArgv] = remoteCommand(node, 'admin', PROBE, { connectTimeout: 6 });
		const out = execFileSync(cmd, cmdArgv, { encoding: 'utf8', timeout: 20000 });
		const n = parseInt(String(out).trim().split('\n')[0], 10);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

const scan = await scanNodeRunners(NODE);
const hasLiveWarmOrJit = scan.ok
	? scan.regs.some((r) => r.name.startsWith(WARM_PREFIX) || r.name.startsWith(JIT_PREFIX))
	: null;
const busyRaw = hasLiveWarmOrJit === false ? busyOn(NODE) : null;

/**
 * AN UNREACHABLE NODE IS NOT NECESSARILY A BUSY ONE — this is the primary
 * case `fleet retire` exists for (dead hardware, per this file's header and
 * the runbook). `drainStatus` fails closed on a bare `null` (never silently
 * "drained" — #90), which is correct for a node merely rebooting but would
 * leave a genuinely dead box stuck at `unknown` forever: ssh can never
 * succeed against it. `deferralFor` is the SAME question `check-runner-units`
 * and five siblings already ask about an unreachable node (issue #71): is
 * this expected, or has it been too long to still call it that.
 *
 * The direction matters. A FRESH or ACTIVE maintenance/reboot deferral
 * (`deferred: true`, still inside its window) must NEVER read as quiet —
 * that is exactly the box that comes back on its own, and tearing down its
 * registrations because it happened to be unreachable mid-reboot would be
 * the #71 bug's mirror image. Only an EXPIRED maintenance deferral
 * (`deferred: false`, past `DEFER_DAYS`, "is it coming back?") corroborates
 * what the operator already confirmed by hand before running `--confirm`
 * (the runbook's own precondition: `journalctl --list-boots` first) — a
 * node that has been unreachable for well over a week is treated as
 * genuinely gone, not merely quiet.
 */
let busy = busyRaw;
let deferralLine = null;
if (busyRaw === null) {
	const defer = deferralFor(NODE, drainState, now);
	if (!defer.deferred && defer.kind === 'maintenance' && typeof defer.ageDays === 'number') {
		busy = 0;
		deferralLine = `unreachable, but ${defer.why} — treated as genuinely gone, not merely quiet`;
	} else if (defer.deferred) {
		deferralLine = deferralNote(NODE, defer);
	}
}
const verdict = drainStatus(NODE, busy, drainState, hasLiveWarmOrJit);
if (verdict === 'drained' && deferralLine) log(deferralLine);

const remainingSteps = [
	{
		step: 'regenerate-coverage',
		operatorOnly: false,
		command: 'fleet reconcile --write-coverage',
		why: 'resolved coverage/capacity facets are derived from the manifest roster',
	},
	{
		step: 'tailnet-removal',
		operatorOnly: true,
		where: 'the Tailscale admin console',
		why: 'this repo holds no tailnet admin credential (see AGENTS.md)',
	},
	{
		step: 'inventory',
		operatorOnly: true,
		where: "wherever the `inventory` skill's backing data lives (private repo)",
		why: 'record the node’s parts as returned to the shelf or scrapped',
	},
];

if (verdict !== 'drained') {
	const why = !scan.ok
		? `could not read GitHub's registration listing: ${scan.reason}`
		: hasLiveWarmOrJit
			? `still holds a live warm/JIT registration GitHub can assign to directly`
			: busy === null
				? `could not reach ${NODE} to confirm it has gone quiet${deferralLine ? ` (${deferralLine})` : ''}`
				: busy
					? `${busy} job(s) still running`
					: 'not yet drained';
	if (!CONFIRM) {
		log(`${NODE} is not quiet yet (${why}).`);
		log(
			drainState[NODE]
				? '  It is already draining — wait for it to go quiet, or re-run with --confirm.'
				: `  --confirm would drain it first (reason: "${REASON}"), then refuse to go ` +
						'further this run — a drain is a soft close and finishing work takes its own time.'
		);
		finish(
			{
				ok: false,
				node: NODE,
				confirmed: false,
				step: 'drain',
				verdict,
				why,
				remaining: remainingSteps,
			},
			1
		);
	}
	let drainedNow = false;
	if (!drainState[NODE]) {
		writeDrainDoc(
			{
				nodes: {
					...drainDoc.nodes,
					[NODE]: {
						since: new Date(now).toISOString(),
						kind: 'maintenance',
						reason: REASON,
						by: process.env.SUDO_USER || process.env.USER || 'unknown',
					},
				},
				planned: drainDoc.planned,
			},
			drainDoc
		);
		drainedNow = true;
		log(`${NODE} is now draining (reason: "${REASON}").`);
	}
	log(
		`Not yet quiet (${why}) — re-run \`fleet retire ${NODE} --confirm\` once \`fleet drain --status\` shows it drained.`
	);
	finish(
		{
			ok: false,
			node: NODE,
			confirmed: true,
			step: 'drain',
			verdict,
			why,
			drainedNow,
			remaining: remainingSteps,
		},
		1
	);
}

// ── deregister every registration this node holds ──────────────────────────

async function deregisterAll(node, regs) {
	const sudo = maySudo(machine);
	const removed = [];
	const failed = [];
	for (const { repo, id, name } of regs) {
		const runnerId = Number.isInteger(id) ? id : null;
		try {
			const token = mintToken(repo, 'remove');
			let res = await runOn(node, removeScript({ repo, token, sudo, runnerId }), {
				as: 'admin',
				timeoutMs: 15 * 60_000,
				maxBuffer: 8 * 1024 * 1024,
			});
			let byId = false;
			if (!res.ok && /DEREGISTER_FAILED/.test(res.stderr) && runnerId !== null) {
				const del = ghWrite('DELETE', `/repos/${repo}/actions/runners/${runnerId}`, {});
				if (del.ok) {
					byId = true;
					res = await runOn(
						node,
						removeScript({ repo, token, sudo, runnerId, deregistered: true }),
						{
							as: 'admin',
							timeoutMs: 15 * 60_000,
							maxBuffer: 8 * 1024 * 1024,
						}
					);
				} else {
					failed.push({
						repo,
						name,
						error: `config.sh remove failed and so did DELETE by id: ${del.error}`,
					});
					continue;
				}
			}
			if (res.ok) removed.push({ repo, name, byId });
			else
				failed.push({
					repo,
					name,
					error: (res.stderr || res.error || 'unknown failure').toString().trim().slice(0, 400),
				});
		} catch (err) {
			failed.push({ repo, name, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return { removed, failed };
}

if (!CONFIRM) {
	log(`${NODE} is quiet — safe to retire.`);
	if (scan.regs.length) {
		log(`Would deregister ${scan.regs.length} runner(s):`);
		for (const r of scan.regs) log(`  ${r.repo}  ${r.name}`);
	} else {
		log('No registrations to deregister.');
	}
	log(`Would remove ${NODE} from ${MANIFEST} and add it to the retired-name ledger.`);
	log('Would archive its measured facets (benchmark/health/proof), then remaining steps:');
	for (const s of remainingSteps)
		log(`  ${s.operatorOnly ? '[operator]' : '[fleet]'} ${s.step}: ${s.command ?? s.where}`);
	finish(
		{
			ok: false,
			node: NODE,
			confirmed: false,
			step: 'plan',
			verdict,
			registrations: scan.regs,
			remaining: remainingSteps,
		},
		1
	);
}

const dereg = await deregisterAll(NODE, scan.regs);
if (dereg.failed.length) {
	log(
		`${dereg.removed.length} deregistered, ${dereg.failed.length} FAILED — stopping before the manifest edit.`
	);
	for (const f of dereg.failed) log(`  ✗ ${f.repo}  ${f.name}  ${f.error}`);
	finish(
		{
			ok: false,
			node: NODE,
			confirmed: true,
			step: 'deregister',
			removed: dereg.removed,
			failed: dereg.failed,
			remaining: remainingSteps,
		},
		1
	);
}
if (dereg.removed.length) log(`Deregistered ${dereg.removed.length} runner(s).`);

// ── manifest + the retired-name ledger, ONE atomic write ───────────────────

const manifestResult = await manifestEdit(
	(d) => {
		if (!d.machines?.[NODE]) throw new Error(`${NODE} is not in ${MANIFEST} any more`);
		delete d.machines[NODE];
		d.retired = [...new Set([...(d.retired ?? []), NODE])].sort();
		return true;
	},
	{ target: MANIFEST, writer: 'retire-node', reason: `retire ${NODE}`, push: !NO_PUSH }
);
if ('ok' in manifestResult && manifestResult.ok === false) {
	die(manifestResult.why, {
		node: NODE,
		confirmed: true,
		step: 'manifest',
		removed: dereg.removed,
		remaining: remainingSteps,
	});
}
if (manifestResult.formatter === null) {
	log(`! written UNFORMATTED — no prettier resolved from ${MANIFEST}'s tree`);
}
const landed = manifestResult.landed;
log(landed ? landingLine(landed, { writer: 'retire-node' }) : '  nothing to land');

// ── archive the node's measured facets: copy first, THEN remove ───────────

/**
 * Copy `node`'s block out of every `$benchmark`/`$health`/`$proof` state-dir
 * file into one archive, then remove it from the live file — in that order,
 * so a failure between the two steps leaves a harmless duplicate rather than
 * losing the record. Best-effort: a facet file this cannot safely read
 * (unreadable/malformed) is left untouched and reported as a WARNING, never
 * a reason to fail the whole retirement — this step is informational
 * (docs/runbooks/retire-node.md step 6, "Verify: n/a").
 */
function archiveFacets(node) {
	const dir = stateDir();
	const toArchive = {};
	const liveFiles = {};
	const warnings = [];
	for (const facet of MEASURED_FACETS) {
		let file;
		try {
			file = readFacetFile(facet, { dir });
		} catch (err) {
			warnings.push(`${facet}: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		if (!file.ok) {
			if (file.reason !== 'no-state-dir' && file.reason !== 'no-file') {
				warnings.push(`${facet}: could not read (${file.why}) — left untouched`);
			}
			continue;
		}
		// `proof.json` keys its blocks `${node}\u0000${capability}`; the other two
		// facets key directly by node name (src/lib/measured.ts).
		const keys = Object.keys(file.nodes).filter((k) => k === node || k.startsWith(`${node}\u0000`));
		if (!keys.length) continue;
		const moved = {};
		for (const k of keys) moved[k] = file.nodes[k];
		toArchive[facet] = moved;
		liveFiles[facet] = { path: file.path, keys, nodes: file.nodes };
	}
	if (!Object.keys(toArchive).length) return { archived: [], warnings };

	const archivePath = join(dir, 'retired-facets.json');
	let archiveDoc = { nodes: {} };
	try {
		archiveDoc = JSON.parse(readFileSync(archivePath, 'utf8'));
	} catch {
		// Absent or unreadable: this is a file ONLY this script writes, so there
		// is nothing else it could be holding that is worth preserving by hand.
	}
	archiveDoc.nodes = archiveDoc.nodes ?? {};
	archiveDoc.nodes[node] = { retiredAt: new Date().toISOString(), facets: toArchive };
	try {
		writeFileAtomic(archivePath, `${JSON.stringify(archiveDoc, null, 2)}\n`);
	} catch (err) {
		return {
			archived: [],
			warnings: [
				...warnings,
				`could not write ${archivePath}: ${err instanceof Error ? err.message : String(err)} — nothing removed from the live facet files`,
			],
		};
	}

	const archived = [];
	for (const [facet, info] of Object.entries(liveFiles)) {
		const remaining = { ...info.nodes };
		for (const k of info.keys) delete remaining[k];
		try {
			writeFileAtomic(info.path, `${JSON.stringify({ nodes: remaining }, null, 2)}\n`);
			archived.push(facet);
		} catch (err) {
			warnings.push(
				`${facet}: archived to ${archivePath}, but could not remove it from ${info.path} ` +
					`(${err instanceof Error ? err.message : String(err)}) — it is now duplicated there, harmlessly`
			);
		}
	}
	return { archived, warnings };
}

const facets = archiveFacets(NODE);
if (facets.archived.length)
	log(`Archived ${facets.archived.join(', ')} to ${join(stateDir(), 'retired-facets.json')}.`);
for (const w of facets.warnings) log(`  ! ${w}`);

log('');
log(`${NODE} is retired. Remaining steps:`);
for (const s of remainingSteps)
	log(
		`  ${s.operatorOnly ? '[operator]' : '[fleet]'} ${s.step}: ${s.command ?? s.where} — ${s.why}`
	);

finish(
	{
		ok: landed ? landed.ok : true,
		node: NODE,
		confirmed: true,
		step: 'done',
		removed: dereg.removed,
		manifest: { landed },
		facets,
		remaining: remainingSteps,
	},
	landed && !landed.ok ? 1 : 0
);
