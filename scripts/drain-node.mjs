#!/usr/bin/env node
/**
 * drain — take a node out of service without killing what it is doing.
 *
 * A soft close: no NEW work is assigned, whatever is running finishes, and this
 * tells you when the node has actually gone quiet. That last part is the point.
 * `draining` and `drained` are different states and only the second one is safe
 * to open a case on.
 *
 * THREE ENFORCEMENT POINTS, because the fleet assigns work three ways:
 *   - ephemeral nodes (claw-1, claw-3) are gated at placement, immediately;
 *   - standing registrations (claw-2, claw-4, claw-5, claw-6, hokon) are gated
 *     by stripping `hadoku-builder`, because GitHub assigns straight to those
 *     runners and the dispatcher never sees the job;
 *   - a WARM LISTENER (`warm-<node>-<repo>`) is NEITHER of the above — it is a
 *     standing registration GitHub assigns straight to, exactly like the
 *     second point, but `planWarmFleet`'s own per-node eligibility never
 *     consulted the drain state, so a drained node kept whatever listener it
 *     already held. claw-5 was drained 2026-10-03 20:05Z and still served 23
 *     jobs through `warm-claw-5-hadoku_site` before the listener was evicted
 *     at 18:30:24Z the next day, one minute after the undo (#90). The warm
 *     tick (`ephemeral-tick.ts`'s `dispatchWarmCache`) now reads the SAME
 *     drain state and folds a drained node into the slow tier's own
 *     exclude-and-evict branch — never filled, and evicted on the next pass
 *     if it already holds one.
 * The label strip lands on the fast loop's next tick, so a standing node
 * keeps its current work and stops taking more within `pollSeconds`. The warm
 * eviction lands on the next `WARM_CACHE_INTERVAL_MS` tick (60s), same as any
 * other warm-cache eviction.
 *
 * `--status` reflects all three: it reads `drained` only once NO live warm or
 * JIT registration remains for the node (GitHub's own runner listing, not
 * this script's own belief) AND the local busy probe reads zero. A registration
 * that is merely idle is still assignable — that gap is exactly how claw-5 read
 * "drained" while GitHub could still hand it work.
 *
 * A REASON IS REQUIRED. A drain with no explanation is one nobody can safely
 * undo — the next person cannot tell a stress test from a dead disk, and the
 * safe reading of an unexplained drain is "leave it", which is how a node stays
 * out of the fleet for a month.
 *
 * A DRAIN CAN BE BOUNDED AND SCHEDULED. `--for 48h` / `--until <iso>` makes it
 * lapse by itself — a lease that needs somebody to remember to end it runs a
 * week over. `--in 30m` / `--at <iso>` schedules it instead of starting it, so
 * whoever is using the node can see it coming (`fleet node-status --json`).
 * A HOSTING node (`fleet hosting`) has a tenant on it, and anything that takes
 * it away is scheduled at least HOSTING_NOTICE_MS ahead unless `--force`.
 *
 * USAGE
 *   fleet drain claw-3 --reason "semi-annual stress test"
 *   fleet drain claw-8 --kind lease --for 48h --reason "cardtable stress lease"
 *   fleet drain claw-8 --at 2026-10-30T18:00Z --for 2h --reason "reseat RAM"
 *   fleet drain --status
 *   fleet drain claw-3 --undo
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { parseStrict } from './lib/argv.mjs';
import { manifest, stateDir } from './lib/paths.mjs';
import { isLocalNode, loadManifest, sshDestination } from './lib/fleet-exec.mjs';
// The BUILT copy, for the same reason fleet-exec.mjs imports isLocalNode that
// way: one question, one answer, and no second implementation to drift from.
import { guestNodeNames, isGuestNode } from '../dist/lib/node-role.js';
// `nodeOf` attributes a runner NAME (`warm-claw-5-hadoku_site`,
// `jit-claw-3-...`) back to the node it belongs to — the same resolver
// `speed-tier.ts` and `census.ts` itself use, so a drain status check and the
// fleet's own accounting can never disagree about whose registration this is.
import { nodeOf } from '../dist/runners/census.js';
// THE ONE VERDICT, not a second copy of its branches. `drainStatus` is pure
// and unit-tested in `src/tests/drain.test.ts`; this CLI's only job is to
// gather the two observations (`busy`, `hasLiveRegistration`) it asks for.
import {
	drainNotices,
	drainStatus,
	effectiveDrains,
	noticeRefusal,
	parseWhen,
} from '../dist/runners/drain.js';
import { readHostingDoc } from '../dist/runners/hosting-record.js';
import { readDrainDoc, writeDrainDoc } from './lib/expected-down.mjs';
// Retried per READ_ATTEMPTS before a `gh api` read is called could-not-look —
// the same shape `check-label-floor.mjs`, `check-fleet-preflight.mjs` and
// `reconcile-runner-identity.mjs` already carry for their own `gh` reads
// (#80). Imported, not duplicated: a third copy of this retry is a third
// place for "retrying is not tolerating" to drift.
import { READ_ATTEMPTS, describeReadFailure } from './lib/queue-health.mjs';

// The STATE dir, not the manifest dir — see src/runners/drain.ts for why.
// Short version: manifestDir is inside a git checkout and there are two of
// them, so this CLI wrote to the operator's checkout while the dispatcher read
// mgmt-api's. `writeDrainDoc` writes to the state dir and nowhere else.
const args = process.argv.slice(2);
// F8 (plan §4.1): strict, from the one spec `argv-specs.mjs` declares and the
// door reads too. `--help`/`-h` and an unknown flag are both handled before
// anything below reads the drain doc or touches a node.
const parsed = parseStrict(ARGV_SPECS['drain-node.mjs'], args);
const R = '\x1b[31m',
	G = '\x1b[32m',
	Y = '\x1b[33m',
	B = '\x1b[1m',
	N = '\x1b[0m';

// The whole file, through the one reader and writer every script shares. A
// parse failure THROWS rather than defaulting to {}: reporting "nothing is
// drained" because the file is corrupt would put work back onto a node
// somebody is holding a screwdriver over.
const write = writeDrainDoc;

/**
 * The fleet manifest, for ROLES only. Unreadable is `null`, never `{}`.
 *
 * A `{}` default would read as "no node is a guest", which is the lenient
 * direction and the wrong one — it would put the fleet chain back onto a box the
 * operator took it off. Every caller below treats null as "could not look".
 */
let fleetDocCache;
/** WHY `fleetDoc()` read null, for a caller that needs to SAY so rather than
 *  just fail closed — see `liveWarmOrJitRegistrations`. */
let fleetDocErrorReason = null;
function fleetDoc() {
	if (fleetDocCache !== undefined) return fleetDocCache;
	try {
		fleetDocCache = loadManifest();
	} catch (err) {
		fleetDocCache = null;
		fleetDocErrorReason = err instanceof Error ? err.message : String(err);
	}
	return fleetDocCache;
}

/**
 * A GUEST IS NOT DRAINED, AND NOT SILENTLY PROBED EITHER.
 *
 * "I do NOT want hokon being impacted by the fleet chain" (operator,
 * 2026-09-14) — never converged, never cleaned, never probed, never DRAINED. A
 * drain is the fleet deciding a machine's availability, which is exactly the
 * decision a guest keeps for itself: it is here when it is needed, and it stops
 * being here by not being here.
 *
 * `--include-guests` is the one door, the spelling `converge-toolchain`
 * established and `guestGate` honours, for the operator who genuinely means it.
 * A guest whose role cannot be read (manifest unreadable) is treated as a claw,
 * matching `nodeRole`'s own strict default: a typo or a missing file must not be
 * able to exempt a node, and the capacity refusal below still guards the fleet.
 */
const INCLUDE_GUESTS = parsed.has('--include-guests');
const isGuest = (node) => isGuestNode(fleetDoc()?.machines?.[node]);

/** Running jobs, OBSERVED on the node, not inferred from anything we wrote. */
function busyOn(node) {
	// THE LOCAL HOST CANNOT BE COUNTED OVER SSH. hokon refuses ssh to itself, so
	// this returned null for it every time — and null is deliberately read as
	// "could not look, treat as busy". The production host could therefore never
	// reach `drained`, which is the one state it is safe to open a case on: an
	// operator draining hokon for maintenance waits for a signal that cannot
	// arrive. Same trap as the fast loop and benchmark-fleet; `isLocalNode` is
	// the one place the question is asked.
	const PROBE = 'pgrep -c -f "[R]unner\\.Worker" || true';
	try {
		const out = isLocalNode(node)
			? execFileSync('bash', ['-c', PROBE], { encoding: 'utf8', timeout: 20000 })
			: execFileSync(
					'ssh',
					[
						'-n',
						'-o',
						'BatchMode=yes',
						'-o',
						'ConnectTimeout=6',
						sshDestination(node, 'admin'),
						PROBE,
					],
					{
						encoding: 'utf8',
						timeout: 20000,
					}
				);
		const n = parseInt(String(out).trim().split('\n')[0], 10);
		return Number.isFinite(n) ? n : null;
	} catch {
		// Unreachable is NOT idle. Saying "drained" here is how somebody opens a
		// case on a node that is mid-build behind a dropped ssh.
		return null;
	}
}

/**
 * The coverage roster — every repo a WARM or JIT registration could live
 * under. Not the manifest's per-node eligibility: a registration that
 * outlived an exclusion or a drain (exactly #90's bug) must still be found,
 * so the scan cannot be narrowed to the repos a node is CURRENTLY declared
 * for.
 *
 * Returns `{ repos }` or `{ reason }` — never a bare `null` — so a caller can
 * say WHY rather than just that it could not look (AGENTS.md: a rate limit, a
 * timeout and a deleted repo are three different jobs, and so is a missing or
 * malformed coverage file).
 */
function coverageRepos() {
	// `manifest()` itself throws when the manifest directory cannot be resolved
	// at all (no sibling checkout, `FLEET_MANIFEST_DIR` unset) — caught by the
	// same block as a missing or malformed file, since the caller only needs
	// ONE reason string either way.
	try {
		const path = manifest('fleet-runner-coverage.json');
		const doc = JSON.parse(readFileSync(path, 'utf8'));
		return Array.isArray(doc.repos)
			? { repos: doc.repos }
			: { reason: `${path} has no "repos" array` };
	} catch (err) {
		return { reason: err instanceof Error ? err.message : String(err) };
	}
}

/** Long enough for a blip to pass; short enough that a `--status` call with
 *  several unreachable repos does not hang the terminal for minutes. */
const REGISTRATION_READ_TIMEOUT_MS = 15_000;
const REGISTRATION_RETRY_DELAY_MS = 1_000;

/** Synchronous sleep — this scan is a single serial sweep, same as
 *  check-label-floor.mjs's resident-floor read. */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `gh api repos/<repo>/actions/runners --paginate`, retried per READ_ATTEMPTS.
 * Throws (with every attempt's reason) rather than defaulting to "no
 * runners" — an unreadable repo is not an unregistered one.
 */
function listRunnersOnRepo(repo) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		try {
			const out = execFileSync('gh', ['api', `repos/${repo}/actions/runners`, '--paginate'], {
				encoding: 'utf8',
				maxBuffer: 32 * 1024 * 1024,
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: REGISTRATION_READ_TIMEOUT_MS,
			});
			return out
				.split('\n')
				.filter(Boolean)
				.flatMap((chunk) => JSON.parse(chunk).runners ?? []);
		} catch (err) {
			reason = `${describeReadFailure(err, REGISTRATION_READ_TIMEOUT_MS)} (attempt ${attempt}/${READ_ATTEMPTS})`;
			if (attempt < READ_ATTEMPTS) sleepSync(REGISTRATION_RETRY_DELAY_MS);
		}
	}
	throw new Error(reason);
}

const WARM_PREFIX = 'warm-';
const JIT_PREFIX = 'jit-';

/**
 * Does a candidate node still hold a live WARM or JIT registration anywhere
 * in the covered roster — GitHub's own runner listing, the same source
 * `warm-affinity` (`warmRegistration` in ephemeral-tick.ts) reads, never this
 * script's own ssh probe.
 *
 * EXISTENCE IS THE QUESTION, NOT `busy`. A warm listener sitting idle is
 * exactly as assignable as a busy one — GitHub hands it work directly,
 * without asking the dispatcher — so an idle one is not evidence of
 * anything safe. That gap is #90: claw-5 read `drained` from a busy-process
 * probe while `warm-claw-5-hadoku_site` sat there, idle and still live,
 * eligible for the next job GitHub happened to assign it.
 *
 * ONE SWEEP FOR EVERY CANDIDATE AT ONCE, not one sweep per node — `--status`
 * usually names more than one drained node, and re-scanning the whole roster
 * per node would multiply exactly the `gh api` cost AGENTS.md's cadence
 * arithmetic warns a careless repeat can turn fatal.
 *
 * Returns `{ ok: true, map }` — a `Map` from node name to the first
 * registration found for it (repo + runner name; a node with none simply has
 * no entry) — or `{ ok: false, reason }` when the roster, the fleet manifest,
 * or ANY repo's listing could not be read. "I could not look" must never
 * render as "nothing is there", AND it must never render as "nothing is
 * there, for no stated reason" either (AGENTS.md: a rate limit, a timeout and
 * a deleted repo are three different jobs) — `reason` names which one.
 */
function liveWarmOrJitRegistrations(candidateNodes) {
	if (!candidateNodes.size) return { ok: true, map: new Map() };
	const coverage = coverageRepos();
	if ('reason' in coverage) {
		return { ok: false, reason: `coverage roster unreadable (${coverage.reason})` };
	}
	const doc = fleetDoc();
	const fleetNodeNames = Object.keys(doc?.machines ?? {});
	// Without the fleet's own node list, `nodeOf` cannot attribute a runner
	// name to a node at all — the manifest being unreadable (or carrying no
	// machines) is exactly as disqualifying here as the coverage file being
	// unreadable.
	if (!fleetNodeNames.length) {
		return {
			ok: false,
			reason: doc
				? 'fleet manifest has no machines — cannot attribute a runner name to a node'
				: `fleet manifest unreadable (${fleetDocErrorReason ?? 'unknown reason'})`,
		};
	}
	const map = new Map();
	for (const repo of coverage.repos) {
		let runners;
		try {
			runners = listRunnersOnRepo(repo);
		} catch (err) {
			return { ok: false, reason: `${repo} (${err instanceof Error ? err.message : String(err)})` };
		}
		for (const r of runners) {
			if (!r?.name || (!r.name.startsWith(WARM_PREFIX) && !r.name.startsWith(JIT_PREFIX))) continue;
			const owner = nodeOf(r.name, fleetNodeNames);
			if (candidateNodes.has(owner) && !map.has(owner)) {
				map.set(owner, { repo, name: r.name });
			}
		}
	}
	return { ok: true, map };
}

const NOW = Date.now();
const doc = readDrainDoc();
/** What is held NOW — the view the dispatcher enforces. */
const state = effectiveDrains(doc, NOW);
// F8: the ONE positional this script takes, found by `parseStrict` against
// the same spec that already knows which flags take a value (so a value like
// `fleet drain --reason training` never gets mistaken for the node name).
const node = parsed.positionals[0] ?? null;
const iso = (ms) => new Date(ms).toISOString();
/** `--for`/`--until`/`--in`/`--at`, read once; a typo exits rather than guessing. */
function when(flag, baseMs = NOW) {
	const v = parsed.value(flag);
	if (v === null) return null;
	try {
		return parseWhen(v, baseMs);
	} catch (err) {
		console.error(`drain: ${flag} ${err.message}`);
		process.exit(1);
	}
}

if (parsed.has('--status') || (!node && !parsed.has('--undo'))) {
	const names = Object.keys(state);
	const notices = drainNotices(doc, NOW);
	if (!names.length) {
		console.log('nothing is drained — every node is taking work.');
		for (const n of notices) {
			console.log(`  planned: ${n.node} ${n.kind} ${n.event} ${n.at.slice(0, 16)}Z — ${n.reason}`);
		}
		process.exit(0);
	}
	// #90: a node whose status is read below must never surface as `drained`
	// while GitHub still lists a live warm or JIT registration for it — see
	// `liveWarmOrJitRegistrations`. Swept ONCE, over every candidate at once,
	// before the per-node loop, not inside it.
	const candidateNodes = new Set(names.filter((n) => !(isGuest(n) && !INCLUDE_GUESTS)));
	const registrationCheck = liveWarmOrJitRegistrations(candidateNodes);
	console.log(`\n${B}node        state      kind         since                 reason${N}`);
	for (const n of names) {
		// A guest is not probed unless the operator asked for it. The row still
		// appears — a machine that vanishes from a report is a machine nobody can
		// tell was considered — and it says WHY it carries no count.
		const skipGuest = isGuest(n) && !INCLUDE_GUESTS;
		let st, col;
		if (skipGuest) {
			st = 'guest';
			col = Y;
		} else {
			// `null` (could not read GitHub's listing — `registrationCheck.reason`
			// says why, printed once below rather than per row) and `true`/`false`
			// (did read it) are passed straight through to `drainStatus` — the pure
			// function owns the "never drained while live, UNKNOWN if unreadable"
			// rule (#90), tested on its own in `src/tests/drain.test.ts`.
			const hasLiveRegistration = registrationCheck.ok ? registrationCheck.map.has(n) : null;
			// The ssh busy-probe is skipped once the registration answer alone
			// already settles the verdict — `drainStatus` never reads `busy` when
			// `hasLiveRegistration` is truthy or null.
			const busy = hasLiveRegistration === false ? busyOn(n) : null;
			const verdict = drainStatus(n, busy, state, hasLiveRegistration);
			st =
				verdict === 'unknown'
					? 'UNKNOWN'
					: verdict === 'draining'
						? hasLiveRegistration
							? `draining(${registrationCheck.map.get(n).name})`
							: `draining(${busy})`
						: 'drained';
			col = verdict === 'drained' ? G : Y;
		}
		const ends = state[n].until ? `  (ends ${state[n].until.slice(0, 16)}Z)` : '';
		console.log(
			`${n.padEnd(11)} ${col}${st.padEnd(10)}${N} ${(state[n].kind ?? 'maintenance').padEnd(12)}` +
				`${state[n].since.slice(0, 19)}  ${state[n].reason}${ends}`
		);
	}
	const ahead = notices.filter((x) => x.event === 'starts');
	if (ahead.length) {
		console.log(`\n${B}planned${N}`);
		for (const x of ahead) {
			console.log(
				`  ${x.node.padEnd(11)} ${x.kind.padEnd(12)} starts ${x.at.slice(0, 16)}Z  ${x.reason}`
			);
		}
	}
	console.log(
		`\n${G}drained${N} = nothing running AND no live warm/JIT registration, safe for ` +
			`maintenance.  ${Y}draining${N} = still finishing, or still holding a registration ` +
			`GitHub can assign to.  ${Y}UNKNOWN${N} = could not look, treat as busy.`
	);
	// #90 send-back: "I could not look" must say WHY, not just THAT — a rate
	// limit, a timeout and a deleted repo are three different jobs (AGENTS.md).
	// Printed ONCE for the whole sweep rather than per row: every UNKNOWN row
	// above shares the SAME cause, because the sweep covers every candidate in
	// one pass and fails closed for all of them together on the first repo (or
	// the roster, or the manifest) it could not read.
	if (!registrationCheck.ok) {
		console.log(
			`${Y}UNKNOWN rows above: could not read GitHub's registration listing — ${registrationCheck.reason}${N}`
		);
	}
	if (names.some((n) => isGuest(n)) && !INCLUDE_GUESTS) {
		console.log(
			`${Y}guest${N} = not probed: the fleet chain does not reach a guest. ` +
				'Count its jobs with --include-guests.'
		);
	}
	process.exit(0);
}

if (!node) {
	console.error('drain: name a node, or use --status.');
	process.exit(1);
}

if (parsed.has('--undo')) {
	const plannedHere = doc.planned.filter((p) => p.node === node);
	const current = doc.nodes[node];
	if (current?.kind === 'hosting') {
		// A hosting record carries a promise to a tenant and units on the node;
		// lifting it here would put CI back beside a live tenant with no notice.
		if (!plannedHere.length) {
			console.error(
				`drain: ${node} is a hosting node. End it with \`fleet hosting ${node} --end --in 30m\`.`
			);
			process.exit(1);
		}
		write({ nodes: doc.nodes, planned: doc.planned.filter((p) => p.node !== node) });
		console.log(
			`${G}✓ cancelled ${plannedHere.length} planned drain(s) on ${node}; it stays hosting.${N}`
		);
		process.exit(0);
	}
	if (!current && !plannedHere.length) {
		console.log(`${node} is not drained.`);
		process.exit(0);
	}
	const nodes = { ...doc.nodes };
	delete nodes[node];
	write({ nodes, planned: doc.planned.filter((p) => p.node !== node) });
	if (plannedHere.length)
		console.log(`  cancelled ${plannedHere.length} planned drain(s) on ${node}.`);
	console.log(`${G}✓ ${node} is back in service.${N}`);
	console.log('  The fast loop restores its label on the next tick.');
	process.exit(0);
}

/**
 * WOULD THIS DRAIN LEAVE THE FLEET ABLE TO SERVE?
 *
 * Soft-close is per-node and nothing counts. Draining nodes one at a time for
 * three different good reasons is how a fleet reaches zero eligible runners
 * without anyone deciding to stop CI — each step looked safe on its own, and
 * the failure only exists in the sum.
 *
 * This is a REFUSAL at zero and a warning at one, not a policy: --force still
 * takes the node out. What it removes is the possibility of doing it by
 * accident.
 */
function capacityAfter(candidate) {
	let fleetDoc;
	try {
		fleetDoc = loadManifest();
	} catch {
		// Cannot read the roster: say so rather than assert the fleet is fine.
		return null;
	}
	const all = Object.keys(fleetDoc.machines ?? {});
	const held = new Set([...Object.keys(state), candidate]);
	// A GUEST IS A LAST RESORT, NOT STANDING CAPACITY, and it is excluded BY ROLE
	// rather than by name. The name was hard-coded here, which made this correct
	// only for as long as the fleet had exactly one guest and that guest kept its
	// hostname — the same class of mistake as excluding it by its `pm2-host`
	// label. Counting a guest would let the fleet drain down to "the backstop
	// only" and call that healthy.
	const guests = guestNodeNames(fleetDoc);
	return all.filter((n) => !held.has(n) && !guests.has(n));
}

// REFUSED BEFORE ANYTHING IS WRITTEN. A silent skip would report a clean drain
// of a node that is still taking work, which is worse than the refusal.
if (isGuest(node) && !INCLUDE_GUESTS) {
	console.error(
		`${R}drain: ${node} is a GUEST and the fleet chain does not drain one.${N}\n` +
			`  A guest lends the fleet a registration and is otherwise none of its\n` +
			`  business (operator, 2026-09-14) — it is here when it is needed, and the\n` +
			`  fleet does not decide its availability for it.\n` +
			`  If you really mean to hold it, re-run with --include-guests.`
	);
	process.exit(1);
}

const reason = parsed.value('--reason');
if (!reason) {
	console.error(
		`drain: --reason is required.\n` +
			`  An unexplained drain is one nobody can safely undo — the next person\n` +
			`  cannot tell a stress test from a dead disk, and the safe reading of an\n` +
			`  unexplained drain is "leave it".`
	);
	process.exit(1);
}

// TRAINING AND MAINTENANCE HAVE DIFFERENT LIFECYCLES, so they are different
// words. A `training` hold ends when the node passes its probes and something
// automated puts it back; a `maintenance` hold ends when a person decides it
// does. Collapsing them means an operator cannot tell "bootcamp is working on
// it" from "somebody has the lid off", and the safe reading of the ambiguity is
// always the second one — which is how a node that finished training stays out
// of the fleet for a week.
//
// A LEASE ends by the clock: the node is lent for a window and comes back when
// it closes, whether or not anybody remembers. `hosting` is not settable here —
// it carries resources and units on the node, and `fleet hosting` writes both.
// `reboot` is written by the reboot cycle (reboot-claws); it is settable here
// so a hand-run cycle step and the automated one write the same record.
const KINDS = ['training', 'maintenance', 'lease', 'reboot'];
const kind = parsed.value('--kind') ?? 'maintenance';
if (kind === 'hosting') {
	console.error(
		`drain: a hosting node is declared with \`fleet hosting\`, which also serves its resources.`
	);
	process.exit(1);
}
if (!KINDS.includes(kind)) {
	console.error(`drain: --kind must be one of ${KINDS.join(', ')} (got "${kind}")`);
	process.exit(1);
}
const startMs = when('--at') ?? when('--in') ?? NOW;
const endMs = when('--until') ?? when('--for', startMs);
if ((kind === 'lease' || kind === 'reboot') && endMs === null) {
	console.error(`drain: a ${kind} needs an end — --for 2h or --until <iso>.`);
	process.exit(1);
}
if (endMs !== null && endMs <= startMs) {
	console.error(`drain: it would end (${iso(endMs)}) before it starts (${iso(startMs)}).`);
	process.exit(1);
}
// A shared hosting slice is owed notice of a reboot, not of CI coming off.
const refusal = noticeRefusal(node, startMs, doc, NOW, {
	hostingDoc: readHostingDoc(stateDir()),
	kind,
});
if (refusal && !parsed.has('--force')) {
	console.error(
		`${R}drain: ${refusal}${N}\n  Schedule it with --in 15m (or later), or --force if the box is failing.`
	);
	process.exit(1);
}

const remaining = capacityAfter(node);
if (remaining === null) {
	console.error(
		`drain: cannot read the fleet manifest, so cannot tell what this would leave.\n` +
			`  Refusing. Draining blind is how a maintenance window becomes an outage.`
	);
	process.exit(1);
} else if (remaining.length === 0 && !parsed.has('--force')) {
	console.error(
		`${R}drain: this would leave NO node able to take a job.${N}\n` +
			`  Already held: ${Object.keys(state).join(', ') || '(none)'}\n` +
			`  Draining ${node} empties the fleet, and CI would queue indefinitely.\n` +
			`  If that is genuinely what you want, re-run with --force.`
	);
	process.exit(1);
} else if (remaining.length === 1 && !parsed.has('--force')) {
	console.log(
		`${Y}warning: this leaves ONE node serving the whole fleet (${remaining[0]}).${N}\n` +
			`  Proceeding — but a single carrier is a single point of failure, which is\n` +
			`  the 2026-09-01 outage in one sentence.`
	);
}

const record = {
	since: iso(NOW),
	kind,
	reason,
	by: process.env.SUDO_USER || process.env.USER || 'unknown',
	...(endMs !== null ? { until: iso(endMs) } : {}),
};
// SCHEDULED, or laid OVER a hosting record: both go to `planned`, so a
// maintenance window on a hosting node never erases the tenant's promise.
if (startMs > NOW || doc.nodes[node]?.kind === 'hosting') {
	write({ nodes: doc.nodes, planned: [...doc.planned, { node, from: iso(startMs), ...record }] });
	console.log(`${G}✓ ${node} drain planned for ${iso(startMs)}.${N}`);
	console.log(`  kind:   ${kind}${endMs !== null ? ` (ends ${iso(endMs)})` : ''}`);
	console.log(`  reason: ${reason}`);
	console.log('  It is visible in `fleet node-status --json` until it starts.');
	process.exit(0);
}
write({ nodes: { ...doc.nodes, [node]: record }, planned: doc.planned });
console.log(`${G}✓ ${node} is draining.${N}`);
if (endMs !== null) console.log(`  ends:   ${iso(endMs)} — it lapses by itself; no undo needed.`);
console.log(
	`  kind:   ${kind}${{ training: ' (returns when it passes its probes)', lease: ' (returns when the lease ends)' }[kind] ?? ' (a human puts it back)'}`
);
console.log(`  reason: ${reason}`);
console.log(`  Running jobs finish. New assignment stops within one fast-loop tick (~60s).`);
console.log(`  Watch it go quiet with:  fleet drain --status`);
const busy = isGuest(node) && !INCLUDE_GUESTS ? null : busyOn(node);
if (busy === null) console.log(`  ${Y}note: could not reach ${node} to count running jobs.${N}`);
else if (busy > 0) console.log(`  ${busy} job(s) still running right now.`);
else console.log(`  ${G}already idle — safe for maintenance now.${N}`);
