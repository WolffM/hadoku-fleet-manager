#!/usr/bin/env node
/**
 * traffic — where would the next job go, and why.
 *
 * You cannot control routing you cannot see. Everything the fleet uses to place
 * a job is already written down somewhere — the fleet manifest, the drain set,
 * the labels a node carries, each node's observed load, each node's measured
 * speed, each node's live memory admission — but nobody holds all of it at
 * once. This prints the decision, through the same `orderCandidates` the
 * dispatcher uses, fed the same speed model `ephemeral-tick.ts` rebuilds.
 *
 * IT SIMULATES, IT NEVER PLACES. Nothing here writes, dispatches or labels. It
 * answers "if a job wanting these labels arrived right now, where would it land,
 * and what happened to every node that did not get it".
 *
 * WHY THE REJECTIONS ARE THE POINT
 * --------------------------------
 * `choosePlacement` already records a reason per skipped node and nothing ever
 * showed them. When five jobs queued on 2026-09-02 behind a single working
 * claw, the answer was in that list — claw-4 was reporting free slots with all
 * 26 registrations offline — and reading it required attaching a debugger to a
 * cron job. A router that cannot explain a refusal is one you tune by guessing.
 *
 * ORDER IS NOT WHAT IT WAS (wave 4a / 3z's manager found this stale)
 * -------------------------------------------------------------------
 * This used to print "fewest busy first, then idle longest" and order by
 * those two alone — the PRE-3z rule. Since wave 3z the dispatcher's own
 * `orderCandidates` (runners/traffic.ts) inserts a speed tie-break between
 * them: fewest busy, then the fastest MEASURED node, then idle longest, then
 * name. A diagnostic describing a rule the system no longer runs is worse
 * than no diagnostic — see this file's own point about rejections above,
 * applied to itself. The factor shown per node is the SAME
 * `SpeedModel.factorOf` the dispatcher ties on, built the same way
 * (`ephemeral-tick.ts`'s own rebuild): `null` reads as exactly 1.0, never as
 * fast or slow.
 *
 * ADMISSION IS A SEPARATE AXIS FROM ORDER (wave 4a, #100)
 * ---------------------------------------------------------
 * Memory admission (`admitMint`'s clause) is NOT applied by `orderCandidates`
 * — it decides whether GitHub can even reach a node, not which eligible node
 * goes first. A node can rank first in the order and still be refused the
 * next job on memory, which is exactly how claw-6 and claw-2 ran zero jobs
 * for days while `fleet traffic`'s old output and `admissionFree` both said
 * nothing was wrong. The admission column reads the live controller's own
 * verdict (`GET /api/fleet`'s per-node admission field, wave 4a) rather than
 * recomputing it here — recomputing would need the same live memory probe the
 * fast loop holds in-process, which this standalone script does not have, and
 * a second implementation is the same trap the order fix above is correcting.
 * "Could not look" (mgmt-api unreachable, or an older deploy with no such
 * field) reads as `unknown`, NEVER as `admitted` — AGENTS.md's first rule.
 *
 * USAGE
 *   fleet traffic                          the fleet's current routing state
 *   fleet traffic --labels self-hosted,hadoku-builder,python-toolcache
 *   fleet traffic --live                   ssh each node for its real busy count
 *   fleet traffic --json
 *
 *   MGMT_API_URL   where the live controller's GET /api/fleet is read from
 *                  (default http://127.0.0.1:4000 — loopback only, like
 *                  src/server.ts). Unreachable or missing the
 *                  admission field both read as "unknown", read-only either way.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { orderCandidates } from '../dist/runners/traffic.js';
import { idleSecondsFromRecords } from '../dist/job-history.js';
import { buildSpeedModel } from '../dist/runners/speed-tier.js';
import { runOnSync } from './lib/fleet-exec.mjs';
import { manifest, stateDir } from './lib/paths.mjs';
import { readDrains } from './lib/expected-down.mjs';
import { keepStdoutWhole } from './lib/emit.mjs';

// STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
// and on a pipe `process.exit` throws away whatever the stream still had
// queued — measured on this host, 149,133 bytes in and 146,176 out, which
// `JSON.parse` then rejects mid-string. `keepStdoutWhole` puts fd 1 in
// blocking mode so there is nothing left to lose. Issue #33; the shared
// emitter calls the same function for the scripts that use it.
keepStdoutWhole();

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
	const i = args.indexOf(f);
	return i === -1 ? null : (args[i + 1] ?? null);
};
const B = '\x1b[1m',
	G = '\x1b[32m',
	Y = '\x1b[33m',
	R = '\x1b[31m',
	D = '\x1b[2m',
	N = '\x1b[0m';

if (has('--help') || has('-h')) {
	console.log(
		[
			'fleet traffic [--labels a,b] [--live] [--json]',
			'',
			'  (no args)   current routing state: order, speed factor, admission, every node',
			'  --labels    simulate a job asking for these labels',
			'  --live      ssh each node for its actual running-job count',
			'',
			'Order: fewest busy, then fastest measured, then idle longest, then name.',
			'Admission is read live from MGMT_API_URL (default http://127.0.0.1:4000),',
			"and reads 'unknown' rather than 'admitted' when that cannot be reached.",
			'Simulates only. Nothing here places, labels or writes.',
		].join('\n')
	);
	process.exit(0);
}

const JSON_OUT = has('--json');
const LIVE = has('--live');
const wantLabels = (valueOf('--labels') ?? '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

function readJson(name, fallback) {
	const p = manifest(name);
	if (!existsSync(p)) return fallback;
	try {
		return JSON.parse(readFileSync(p, 'utf8'));
	} catch (err) {
		// A file we cannot read is NOT an empty file. Reporting "nothing is
		// drained" or "no nodes" because of a syntax error would describe a fleet
		// that does not exist.
		console.error(`traffic: ${name} is unreadable (${err.message}). Refusing to guess.`);
		process.exit(1);
	}
}

/**
 * The drain, from the state dir, falling back to the legacy manifest-dir copy.
 *
 * Same resolution order as src/runners/drain.ts on purpose: a report that names
 * a different file from the one gating placement would describe a fleet that
 * does not exist, which is the mistake the whole move is correcting.
 */
function readDrainState() {
	try {
		return readDrains();
	} catch (err) {
		console.error(`traffic: the drain file is unreadable (${err.message}). Refusing to guess.`);
		process.exit(1);
	}
}

const fleet = readJson('fleet-runner-manifest.json', { machines: {} });
const drain = readDrainState();
/** Every declared node, in name order — no file's key order may decide anything. */
const nodeNames = Object.keys(fleet.machines ?? {}).sort();

/**
 * A GUEST IS DELIBERATELY IN SCOPE HERE — `includeGuests` below, on purpose.
 *
 * A guest lends the fleet a registration and is otherwise none of the fleet
 * chain's business (operator, 2026-09-14). WHERE THAT REGISTRATION SITS IN THE
 * ROUTING ORDER IS THE ONE THING THIS FILE IS FOR: the guest is the fleet's
 * BACKSTOP, so a routing report that left it out would
 * describe a fleet that does not exist — and the reason the backstop exists at
 * all is the one place a reader most needs to see.
 *
 * NOTHING IS DONE TO IT. This command simulates and never places, labels or
 * writes; `--live` runs one `pgrep -c`, which is the same read `fleet drain`
 * makes and the lightest thing that can be asked of a box. Leaving the guest
 * unmeasured is not neutral either: `orderCandidates` sorts an unmeasured node
 * LAST, which is exactly the bug the note below records — the backstop ranked
 * last in live mode however idle it actually was.
 */
const INCLUDE_GUESTS = true;

function busyOf(node) {
	if (!LIVE) return null;
	// THROUGH runOnSync, never a bare `ssh`. hokon refuses ssh to ITSELF, and this
	// tool normally runs ON hokon, so the bare form returned "Connection refused"
	// for the one node that matters most: `--live` reported hokon as unmeasured
	// forever, and `orderCandidates` sorts an unmeasured node LAST. The backstop —
	// the node whose whole job is to catch the queue when the claws cannot — was
	// therefore ranked last in live mode regardless of how idle it actually was.
	// `runOnSync` asks `isLocalNode()`, which is the ONE place that question is
	// answered (see CLAUDE.md), and runs `bash -s` locally instead.
	//
	// The `[R]unner` bracket is not a typo: it stops the pattern matching the
	// pgrep process's own command line, which reported 1 busy on an idle node.
	const res = runOnSync(node, 'pgrep -c -f "[R]unner\\.Worker" || true', {
		timeoutMs: 15_000,
		connectTimeout: 6,
		includeGuests: INCLUDE_GUESTS,
	});
	// UNREACHABLE IS NOT IDLE. Returning 0 here would make a dead box look like
	// the emptiest node in the fleet and win every placement.
	if (!res.ok) return null;
	const n = parseInt(
		String(res.stdout ?? '')
			.trim()
			.split('\n')[0],
		10
	);
	return Number.isFinite(n) ? n : null;
}

const rows = nodeNames.map((name) => {
	const m = fleet.machines?.[name] ?? {};
	const labels = m.labels ?? [];
	const missing = wantLabels.filter((l) => l !== 'self-hosted' && !labels.includes(l));
	const drained = Object.prototype.hasOwnProperty.call(drain, name);
	const busy = busyOf(name);
	let verdict = 'eligible';
	let why = '';
	if (drained) {
		verdict = 'drained';
		why = `${drain[name].kind ? `${drain[name].kind}: ` : ''}${drain[name].reason}`;
	} else if (wantLabels.length && missing.length) {
		verdict = 'no-label';
		why = `lacks ${missing.join(', ')}`;
	} else if (m.ephemeral) {
		why = 'ephemeral — placed by the dispatcher, carries no labels';
	}
	return {
		name,
		labels,
		ephemeral: Boolean(m.ephemeral),
		maxConcurrent: m.maxConcurrent ?? null,
		drained,
		busy,
		verdict,
		why,
	};
});

/**
 * Every usable job-history record, read directly rather than through
 * job-history's own loader — that resolves `historyFile()` from the INJECTED
 * HOST, and this script has no host. Shared by idle time AND the speed model
 * below, so there is exactly one place that parses the file and one notion
 * of what a torn line means, rather than two readers drifting apart.
 *
 * A missing or unreadable file reads as EMPTY, never as "everything is
 * idle" or "no node has ever run anything": an unmeasured node must sort
 * last among equals (idle) and read as neutral (speed), never first or fast.
 */
function loadJobHistoryRecords() {
	const path = join(stateDir(), 'job-history.jsonl');
	if (!existsSync(path)) return [];
	try {
		const records = [];
		for (const line of readFileSync(path, 'utf8').split('\n')) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line));
			} catch {
				// A torn last line is normal — the writer appends and may be mid-write.
			}
		}
		return records;
	} catch {
		return [];
	}
}
const historyRecords = loadJobHistoryRecords();

function idleByNode(nodeNames) {
	try {
		return idleSecondsFromRecords(historyRecords, nodeNames, Date.now());
	} catch {
		return new Map();
	}
}
const idle = idleByNode(rows.map((r) => r.name));

/**
 * Each node's measured speed factor — wave 3z, #83's continuous sibling, the
 * step this file used to leave out entirely. Built exactly the way
 * `ephemeral-tick.ts`'s own rebuild does (`buildSpeedModel(records, {
 * nowMs, nodes })`), never a re-derivation: two independent speed models is
 * how a report and the thing it reports on drift. `factorOf` is `null`
 * ('unknown' tier, thin history) for a node `orderCandidates` then treats as
 * exactly 1.0 — shown here as `null`/`—`, not coerced to 1.0, so the table
 * can still say "unmeasured" rather than claim a number nobody has.
 */
const speedModel = buildSpeedModel(historyRecords, { nowMs: Date.now(), nodes: nodeNames });
const factorOf = (name) => speedModel.factorOf?.(name) ?? null;

/** `—` for an unmeasured node, never a fabricated 1.0 — see `factorOf` above. */
function fmtFactor(f) {
	if (f === null || f === undefined) return '—';
	return f.toFixed(2);
}

/** Seconds since this node's last job ended. `—` means no history, not idle. */
function fmtIdle(sec) {
	if (sec === undefined || sec === null) return '—';
	if (sec < 60) return `${sec}s`;
	if (sec < 3600) return `${Math.round(sec / 60)}m`;
	return `${Math.round(sec / 3600)}h`;
}

const candidates = rows.filter((r) => r.verdict === 'eligible');
// THE DISPATCHER'S OWN FUNCTION, not a copy of it.
//
// This used to re-sort here under a comment claiming it "mirrors
// runners/traffic.ts exactly", conceding in the same breath that idle was
// "unknown here, so ladder order breaks the tie". Once carousel was switched on
// that made the preview WRONG in the one way that matters: it printed the
// ladder — claw-2 first, every time — while the fleet was rotating by idle
// time. An operator checking why work kept landing on one node would have been
// shown the answer they already suspected, by a tool that was not measuring it.
const ordered = orderCandidates(
	nodeNames,
	rows.map((r) => ({
		name: r.name,
		busy: r.busy ?? 0,
		idleSeconds: idle.get(r.name) ?? null,
		// The tie-break `orderCandidates` inserts AFTER `busy`, BEFORE idle (wave
		// 3z). `factorOf` already reads `null` for an unmeasured node; passing it
		// straight through lets `orderCandidates` apply its OWN `?? 1.0` default
		// rather than this file guessing at neutral early.
		speedFactor: factorOf(r.name),
		// `orderCandidates` ranks unschedulable last but never drops it. Here the
		// equivalent is the verdict this file already computed: anything not
		// `eligible` is out of the running, and drained/no-label rows are shown
		// with their reason rather than silently ordered.
		schedulable: r.verdict === 'eligible',
	}))
)
	// Back to rows: orderCandidates speaks in NAMES, the renderer below wants the
	// row it already built. Filtering to candidates keeps drained/no-label nodes
	// out of the running order while leaving them in the table with their reason.
	.map((n) => candidates.find((c) => c.name === n))
	.filter(Boolean);

/**
 * MGMT_API_URL — see this file's header comment for the why. LOOPBACK ONLY,
 * read-only, and read through the global `fetch` (Node 22, CI's pin).
 */
const MGMT_API_URL = (process.env.MGMT_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const ADMISSION_FETCH_TIMEOUT_MS = 3000;

/**
 * Every node's live admission verdict, from the controller's own
 * `GET /api/fleet` (wave 4a's additive `admissionRefusal` field on
 * `FleetMachine`). THIS NEVER RECOMPUTES ADMISSION — see the header comment.
 *
 * Three ways to end up `unknown`, all reported as the SAME verdict because
 * they are the same finding ("nobody looked"), never as `admitted`:
 *   - mgmt-api unreachable (down, wrong port, no network from this host)
 *   - a response that is not the shape expected (not JSON, no `machines`)
 *   - a deploy that predates wave 4a and carries no `admissionRefusal` key
 *     at all (`in` check, not a falsy check — the field is `| null` on a
 *     deploy that DOES carry it, and `null` there means "admitted", not
 *     "absent").
 */
async function fetchAdmission(names) {
	const unknown = (why) => new Map(names.map((n) => [n, { verdict: 'unknown', why }]));
	let res;
	try {
		res = await fetch(`${MGMT_API_URL}/api/fleet`, {
			signal: AbortSignal.timeout(ADMISSION_FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		return unknown(`mgmt-api unreachable at ${MGMT_API_URL} (${err.message})`);
	}
	if (!res.ok) return unknown(`mgmt-api returned HTTP ${res.status} from ${MGMT_API_URL}`);
	let body;
	try {
		body = await res.json();
	} catch (err) {
		return unknown(`mgmt-api response at ${MGMT_API_URL} was not JSON (${err.message})`);
	}
	const machines = Array.isArray(body?.machines) ? body.machines : [];
	const byName = new Map(machines.map((m) => [m?.name, m]));
	const out = new Map();
	for (const name of names) {
		const m = byName.get(name);
		if (!m) {
			out.set(name, { verdict: 'unknown', why: `${name} is not in the /api/fleet response` });
			continue;
		}
		if (!Object.prototype.hasOwnProperty.call(m, 'admissionRefusal')) {
			out.set(name, {
				verdict: 'unknown',
				why: 'this mgmt-api deploy does not report admission refusal yet',
			});
			continue;
		}
		const refusal = m.admissionRefusal;
		if (refusal === null) {
			out.set(name, { verdict: 'admitted', why: '' });
		} else if (refusal && typeof refusal === 'object') {
			const { clause, availableMb, needMb, reserveBasis, reason } = refusal;
			out.set(name, {
				verdict: 'refused',
				clause: clause ?? null,
				availableMb: availableMb ?? null,
				needMb: needMb ?? null,
				reserveBasis: reserveBasis ?? null,
				// `admitMint`'s own sentence, verbatim. This used to compose
				// "<available>MB available < <need>MB needed" for EVERY clause, which
				// is false for most of them: a node at its concurrency cap read
				// "9788MB available < 3400MB needed" (2026-10-25), and even a memory
				// refusal is a floor calculation, not that inequality. The numbers
				// stay in the JSON fields above; only the controller says why.
				why:
					typeof reason === 'string' && reason.trim()
						? reason
						: `${clause ?? 'refused'}: the controller gave no reason`,
			});
		} else {
			out.set(name, { verdict: 'unknown', why: 'admissionRefusal had an unexpected shape' });
		}
	}
	return out;
}

const admission = await fetchAdmission(rows.map((r) => r.name));
/** Rows plus the live admission verdict — display only; never fed to `orderCandidates`. */
const displayRows = rows.map((r) => ({
	...r,
	speedFactor: factorOf(r.name),
	admission: admission.get(r.name) ?? { verdict: 'unknown', why: 'not asked' },
}));

if (JSON_OUT) {
	console.log(
		JSON.stringify({ wantLabels, nodes: displayRows, order: ordered.map((r) => r.name) }, null, 2)
	);
	process.exit(0);
}

console.log(
	`\n${B}order${N}  fewest busy first, then fastest measured, then idle longest, then name ${D}(runners/traffic.ts)${N}`
);
if (wantLabels.length) console.log(`${B}job wants${N}  ${wantLabels.join(', ')}`);
if (!LIVE) console.log(`${D}busy counts not measured — pass --live to ssh each node${N}`);
console.log(`${D}admission read from ${MGMT_API_URL}/api/fleet — read-only, loopback only${N}`);

console.log(
	`\n${B}${'node'.padEnd(10)}${'busy'.padEnd(6)}${'factor'.padEnd(8)}${'idle'.padEnd(8)}${'verdict'.padEnd(11)}${'admission'.padEnd(11)}why${N}`
);
console.log('-'.repeat(100));
for (const r of displayRows) {
	const col = r.verdict === 'eligible' ? G : r.verdict === 'drained' ? Y : R;
	const admCol = r.admission.verdict === 'admitted' ? G : r.admission.verdict === 'refused' ? R : D;
	// The eligibility reason and the admission reason are two different axes
	// (see header comment) — both shown, never one silently dropping the other.
	const why = [r.why, r.admission.verdict === 'refused' ? r.admission.why : '']
		.filter(Boolean)
		.join(r.why ? ' — ' : '');
	console.log(
		`${r.name.padEnd(10)}${String(r.busy ?? '—').padEnd(6)}${fmtFactor(r.speedFactor).padEnd(8)}` +
			// Idle is what breaks a tie, so it is shown rather than left for the
			// reader to infer from an order they cannot check.
			`${fmtIdle(idle.get(r.name)).padEnd(8)}${col}${r.verdict.padEnd(11)}${N}` +
			`${admCol}${r.admission.verdict.padEnd(11)}${N}${why}`
	);
}

console.log(`\n${B}placement order${N}`);
if (!ordered.length) {
	console.log(`  ${R}NOTHING is eligible.${N} A job wanting these labels would queue.`);
} else {
	ordered.forEach((r, i) => {
		const first = i === 0 ? `${G}  <- next job lands here${N}` : '';
		console.log(`  ${i + 1}. ${r.name}${first}`);
	});
}
