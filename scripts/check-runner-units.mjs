#!/usr/bin/env node
/**
 * check-runner-units — every standing runner installed on a node must name a
 * repo that still exists, is not archived, and is on the roster.
 *
 * WHY THIS READS THE NODE AND NOT GITHUB
 * -------------------------------------
 * `reconcile` enumerates repos and asks GitHub which runners each one has. That
 * is the right question for "is coverage complete" and the wrong one for "what
 * is this box paying for", because a runner whose registration is gone appears
 * in NO repo's runner list. On 2026-09-03 claw-1 and claw-2 each carried three
 * such installs. `fleet reconcile` exited 0 with a clean report while they had
 * accumulated 11,126 and 8,422 restarts respectively and claw-2 held 3.2 GB of
 * their trees. Nothing was broken in the reconciler; it was looking at the wrong
 * population.
 *
 * So this gate starts from what is actually on the box and resolves each install
 * BACK to a repo. Same rule as everywhere else in this package: the reader for a
 * facet may not read what the writer wrote.
 *
 * IDENTITY COMES FROM `.runner`, NOT FROM A UNIT NAME
 * --------------------------------------------------
 * Every install holds `.runner`, whose `gitHubUrl` is the repo the runner was
 * REGISTERED AGAINST. That is the authoritative identity and the only one that
 * survives the two ways a name lies here:
 *
 *   1. There are TWO supervision schemes on the fleet, with different names.
 *      System units are `actions.runner.<owner>-<repo>.<node>.service`; user
 *      units are `actions-runner-<repo>.service` under
 *      `user@1000.service/runners.slice`. On claw-1, hadoku-trader is the first
 *      and hadoku-fleet-manager and hadoku-games-host are the second. A gate
 *      that reads only `systemctl list-units 'actions.runner.*'` sees one of the
 *      three and calls the box clean.
 *   2. A repo rename silently redirects. `gh api repos/WolffM/vibedispatch`
 *      returns `WolffM/hadoku-tenhands` with a 200 — a live, healthy, on-roster
 *      repo — so a name-based check reports a dead install as fine.
 *
 * The numeric `id` is stable across renames and is the only identity that
 * survives one. `full_name !== requested` is the whole detection:
 *
 *     WolffM/hadoku-printTool      -> WolffM/hadoku-craft       id 1124924177
 *     WolffM/OSS-Issue-Aggregator  -> WolffM/hadoku-aggregator  id 1116902949
 *     WolffM/vibedispatch          -> WolffM/hadoku-tenhands    id 1129970414
 *
 * WHAT IS A FINDING
 * -----------------
 *   RENAMED    the install names a repo that redirects elsewhere. Its
 *              registration died at the rename; it can never come back.
 *   GONE       the repo 404s. Same conclusion, louder.
 *   ARCHIVED   an archived repo must hold no runners. This is the RULE that
 *              replaces naming a specific repo, so it cannot drift onto the next
 *              repo that gets archived.
 *   OFF-ROSTER the repo resolves and is live, but its id is not in
 *              fleet-runner-coverage.json. The fleet is paying listener rent for
 *              something no gate manages.
 *   STRAY      a supervising unit with no install directory behind it. This is
 *              what six months of crash-looping looked like: a previous cleanup
 *              reclaimed the trees and left the units, which then respawned
 *              against nothing.
 *   SICK       a unit that is not active/running. A serving runner is
 *              `active (running)`; anything else is respawning against something
 *              that is not there.
 *
 * `ignore: true` IN THE MANIFEST DOES NOT SILENCE THIS
 * ---------------------------------------------------
 * `ignore` is reconcile's third answer — "whatever it has, leave it and stop
 * telling me" — and it is the right answer for a REPORT about coverage. It was
 * set on WolffM/hadoku-trader with the note "nobody wants them gone", a decision
 * taken believing the leftovers were inert. They are not: two online
 * registrations carrying `hadoku-builder`, ~240 MB of resident listener across
 * the two boxes with the least headroom in the fleet, and GitHub able to assign
 * work to them without consulting the dispatcher at all.
 *
 * So `ignore` downgrades OFF-ROSTER to a note here, and never suppresses
 * ARCHIVED, RENAMED, GONE, STRAY or SICK. A decision to keep something is not a
 * decision to stop measuring what it costs.
 *
 * UNREACHABLE IS A FAILURE, UNLESS IT IS EXPECTED
 * ------------------------------------------------
 * A node that cannot be probed is reported and fails the run. "I could not look"
 * must never render as "nothing is wrong" — and this gate found that failure in
 * ITSELF on its first run: it called `runOn`, which returns a PROMISE, so every
 * node yielded the string "[object Promise]", which parsed to zero installs and
 * reported the whole fleet clean. Hence every probe result is AWAITED before
 * it is read, and a probe that fails loudly rather than returning nothing.
 * The nodes are probed CONCURRENTLY since it went on a cron (2026-10-28): one
 * by one, a fleet with every node down took 9 x 90 s to say so, which is most
 * of the nightly window it now has to share.
 *
 * ZERO NODES IS NOT A PASS EITHER. `--machine <typo>` used to select nothing,
 * probe nothing and print the clean line with exit 0; a manifest that could not
 * be read threw before `--json` could answer. Both now fail with `error` in the
 * document, because a cron reads the document, not the exit code.
 *
 * Unless a human took the node out on purpose: `deferralFor` (#71) narrows that
 * failure to a node drained with `kind: maintenance`, dated, and inside
 * `DEFER_DAYS` — the install audit is still unread, and is still PRINTED via
 * `deferralNote`, it just does not page. Everything else still fails exactly as
 * before. See lib/expected-down.mjs.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { loadManifest, runOn, selectMachines, machineArg } from './lib/fleet-exec.mjs';
import { manifest as manifestFile } from './lib/paths.mjs';
import { createEmitter } from './lib/emit.mjs';
import {
	repoFromUrl,
	classifyInstall,
	classifyUnit,
	lookupOutcome,
} from './lib/runner-unit-audit.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';

const out = createEmitter();

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	out.log(
		`fleet runner-units — audit the standing runner installs on every node\n\n` +
			`  --json          machine-readable findings\n` +
			`  --machine <n>   probe one node only\n\n` +
			`Reports an install whose repo was RENAMED, deleted or archived, is off\n` +
			`the roster, or whose unit is stray or not running. Identity comes from\n` +
			`.runner's gitHubUrl and is compared by numeric repo id, never by name:\n` +
			`GitHub redirects a renamed repo silently, with a 200.`
	);
	process.exit(0);
}

/**
 * Enumerate what is ACTUALLY on the box, in one round trip.
 *
 * Two record kinds, because the two failure shapes are different: an INSTALL
 * exists and may name the wrong repo, while a UNIT may exist with nothing behind
 * it at all. Reading only one of them misses half the ways this drifts.
 */
const PROBE = String.raw`set -u
H="$HOME"
# INSTALLS — identity from .runner's gitHubUrl, which is what registration wrote.
for d in "$H"/runners/actions-runner-*/ "$H"/actions-runner-*/; do
  [ -d "$d" ] || continue
  n=$(basename "$d")
  url=""
  if [ -f "$d/.runner" ]; then
    url=$(tr -d '\000\357\273\277' < "$d/.runner" | grep -o '"gitHubUrl"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  fi
  sz=$(du -sm "$d" 2>/dev/null | cut -f1)
  [ -n "$sz" ] || sz=0
  printf 'INSTALL\t%s\t%s\t%s\n' "$n" "$url" "$sz"
done
# UNITS — both schemes. A unit with no install behind it is the stray case.
systemctl list-units 'actions.runner.*' --all --no-legend --plain 2>/dev/null | awk '{print $1}' | while read -r u; do
  [ -n "$u" ] || continue
  a=$(systemctl show -p ActiveState --value "$u" 2>/dev/null)
  s=$(systemctl show -p SubState --value "$u" 2>/dev/null)
  r=$(systemctl show -p NRestarts --value "$u" 2>/dev/null)
  w=$(systemctl show -p WorkingDirectory --value "$u" 2>/dev/null)
  [ -n "$r" ] || r=0
  printf 'UNIT\tsystem\t%s\t%s\t%s\t%s\t%s\n' "$u" "$a" "$s" "$r" "$w"
done
systemctl --user list-units 'actions-runner-*' --all --no-legend --plain 2>/dev/null | awk '{print $1}' | while read -r u; do
  [ -n "$u" ] || continue
  a=$(systemctl --user show -p ActiveState --value "$u" 2>/dev/null)
  s=$(systemctl --user show -p SubState --value "$u" 2>/dev/null)
  r=$(systemctl --user show -p NRestarts --value "$u" 2>/dev/null)
  w=$(systemctl --user show -p WorkingDirectory --value "$u" 2>/dev/null)
  [ -n "$r" ] || r=0
  printf 'UNIT\tuser\t%s\t%s\t%s\t%s\t%s\n' "$u" "$a" "$s" "$r" "$w"
done`;

/**
 * Two attempts per repo, the same `READ_ATTEMPTS` queue-health uses against its
 * measured 0.13% transient rate. Retrying is not tolerating: a repo that fails
 * both is still unread and still fails the run, with its reason.
 */
const LOOKUP_ATTEMPTS = 2;

/** One `gh api` lookup per repo, memoised — the roster alone is 26 of them. */
const repoCache = new Map();
function lookupRepo(path) {
	if (repoCache.has(path)) return repoCache.get(path);
	let outcome = null;
	for (let attempt = 1; attempt <= LOOKUP_ATTEMPTS; attempt++) {
		const r = spawnSync('gh', ['api', `repos/${path}`], {
			encoding: 'utf8',
			maxBuffer: 8 << 20,
			timeout: 30_000,
		});
		outcome = lookupOutcome({
			ok: r.status === 0 && !r.error,
			stdout: r.stdout ?? '',
			stderr: r.error ? String(r.error.message) : (r.stderr ?? ''),
		});
		if (outcome.status !== 'error') break;
	}
	repoCache.set(path, outcome);
	return outcome;
}

/**
 * Anything that stops the audit before a node is probed. The document still
 * arrives — with `error`, and with every count at zero — because a cron that
 * gets no JSON reports its checker broken, not the fleet.
 */
function refuse(error) {
	out.warn(error);
	if (out.json)
		out.emit({
			error,
			nodes: 0,
			probed: 0,
			installs: 0,
			units: 0,
			findings: [],
			notes: [],
			unreachable: [],
			expectedDown: [],
			rosterUnresolved: [],
			lookupFailed: [],
			lines: out.held(),
		});
	process.exit(1);
}

const only = machineArg();
let manifest;
let coverage;
try {
	manifest = loadManifest();
	coverage = JSON.parse(readFileSync(manifestFile('fleet-runner-coverage.json'), 'utf8'));
} catch (err) {
	refuse(`could not read the fleet manifest: ${err instanceof Error ? err.message : String(err)}`);
}
const machines = selectMachines(manifest, { only });
if (!machines.length) {
	refuse(
		only
			? `--machine ${only} selected no node`
			: 'the manifest declares no node; zero nodes probed is not a pass'
	);
}

/**
 * A GUEST IS DELIBERATELY IN SCOPE HERE — `includeGuests` below, on purpose.
 *
 * The rule is that a guest lends the fleet a registration and is otherwise none
 * of its business (operator, 2026-09-14). STANDING REGISTRATIONS ARE EXACTLY
 * WHAT IT LENDS, and they are exactly what this file audits: a unit naming a
 * renamed, archived or off-roster repo. Since the claws went all-JIT the guest
 * is the only node in the fleet carrying standing installs across the roster —
 * measured from the manifest, it is the one machine that is neither
 * `ephemeral: true` nor `placement: excluded`, with `maxRegistrations: 32`
 * against 28 covered repos. Skipping it would leave this gate auditing a handful
 * of resident installs and reporting the fleet clean, which is the "a gate that
 * looks at nothing passes" shape, not a courtesy.
 *
 * It stays read-only. The probe lists units and install directories; it removes
 * nothing, installs nothing and asks for no sudo. Reclaiming what it finds is
 * `fleet cleanup`, which DOES skip a guest — see that file.
 */
const INCLUDE_GUESTS = true;

/** The roster, resolved to IDS. A name here is as unreliable as a name there. */
const rosterIds = new Set();
const rosterUnresolved = [];
for (const name of coverage.repos ?? []) {
	const r = lookupRepo(name);
	if (r.status === 'found') rosterIds.add(r.repo.id);
	else
		rosterUnresolved.push({
			repo: name,
			why: r.status === 'gone' ? 'GitHub answers 404' : r.why,
		});
}

const findings = [];
const notes = [];
const unreachable = [];
const lookupFailed = [];
// A node a human powered off is EXPECTED down. It is still PRINTED, and its
// installs are still unread — the deferral suppresses the failure, never the
// evidence, and expires after DEFER_DAYS. See lib/expected-down.mjs.
const drains = readDrains();
const expectedDown = [];
let installCount = 0;
let unitCount = 0;

// Every node at once, and every result AWAITED before it is read: `runOn`
// returns a promise, and reading one unawaited is how this gate once parsed
// "[object Promise]" into zero installs and a clean fleet.
const probes = await Promise.all(
	machines.map(([node]) =>
		runOn(node, PROBE, { as: 'ci', timeoutMs: 90_000, includeGuests: INCLUDE_GUESTS })
	)
);

for (const [i, [node]] of machines.entries()) {
	const res = probes[i];
	if (!res.ok) {
		if (deferralFor(node, drains).deferred) {
			expectedDown.push(node);
			continue;
		}
		unreachable.push({ node, why: res.error ? String(res.error) : 'probe failed' });
		continue;
	}
	const installs = [];
	const units = [];
	for (const line of String(res.out).split('\n')) {
		const f = line.split('\t');
		if (f[0] === 'INSTALL') installs.push({ dir: f[1], url: f[2], sizeMb: Number(f[3]) || 0 });
		else if (f[0] === 'UNIT')
			units.push({
				scope: f[1],
				unit: f[2],
				active: f[3],
				sub: f[4],
				restarts: Number(f[5]) || 0,
				wd: f[6] ?? '',
			});
	}
	installCount += installs.length;
	unitCount += units.length;

	// Which install directories have a unit that is actually up. Read from the
	// same probe, so no extra round trip and no second source of truth.
	const runningDirs = new Set(
		units
			.filter((u) => u.active === 'active' && u.sub === 'running' && u.wd)
			.map((u) => u.wd.replace(/\/+$/, '').split('/').pop())
	);

	for (const inst of installs) {
		const requested = repoFromUrl(inst.url);
		const lookup = requested ? lookupRepo(requested) : null;
		// A lookup that FAILED is not a verdict about the repo. Judging it would
		// call every install GONE the night GitHub rate-limits this token.
		if (lookup?.status === 'error') {
			lookupFailed.push({ node, dir: inst.dir, repo: requested, why: lookup.why });
			continue;
		}
		const resolved = lookup?.status === 'found' ? lookup.repo : null;
		const entry = manifest.repos?.[resolved?.fullName ?? requested ?? ''];
		const verdict = classifyInstall({
			requested,
			resolved,
			rosterIds,
			ignored: Boolean(entry?.ignore),
			running: runningDirs.has(inst.dir),
		});
		if (!verdict) continue;
		const rec = {
			node,
			dir: inst.dir,
			sizeMb: inst.sizeMb,
			url: inst.url,
			repo: requested,
			resolved: resolved?.fullName ?? null,
			id: resolved?.id ?? null,
			kind: verdict.kind,
			why: verdict.kind === 'ARCHIVED' ? `${verdict.why} (${inst.sizeMb} MB on disk)` : verdict.why,
		};
		// Only say "ignore: true" when the manifest actually says it. A note that
		// invents its own justification is the same failure as a comment read as
		// evidence, one layer out.
		if (verdict.note)
			notes.push({ ...rec, why: entry?.ignore ? `${rec.why} — ignore: true` : rec.why });
		else findings.push(rec);
	}

	// A unit whose WorkingDirectory is gone has nothing behind it. That is the
	// shape the six crash-loops had: the trees were reclaimed, the units were not.
	const installDirs = new Set(installs.map((i) => i.dir));
	for (const u of units) {
		const verdict = classifyUnit({
			unit: u.unit,
			active: u.active,
			sub: u.sub,
			restarts: u.restarts,
			workingDir: u.wd,
			installDirs,
		});
		if (verdict)
			findings.push({ node, unit: u.unit, scope: u.scope, restarts: u.restarts, ...verdict });
	}
}

out.log(`Probed ${machines.length - unreachable.length}/${machines.length} nodes.`);
out.log(`Runner installs: ${installCount}   supervising units: ${unitCount}`);

if (rosterUnresolved.length) {
	out.warn(
		`ROSTER UNRESOLVED (${rosterUnresolved.length}) — cannot judge off-roster without it: ` +
			rosterUnresolved.map((r) => `${r.repo} (${r.why})`).join(', ')
	);
}
if (lookupFailed.length) {
	out.warn(
		`INSTALLS UNJUDGED (${lookupFailed.length}) — GitHub could not be asked about their repo:`
	);
	for (const l of lookupFailed) out.warn(`  ${l.node} ${l.dir} ${l.repo}: ${l.why}`);
}
if (unreachable.length) {
	out.warn(`UNREACHABLE (${unreachable.length}) — "I could not look" is not "nothing is wrong":`);
	for (const u of unreachable) out.warn(`  ${u.node}: ${u.why}`);
}
for (const n of expectedDown)
	out.log(`  · ${deferralNote(n, deferralFor(n, drains))} — installs unread`);
for (const f of findings) {
	out.warn(`${f.kind.padEnd(10)} ${f.node.padEnd(8)} ${f.dir ?? f.unit}`);
	out.warn(`           ${f.why}`);
}
for (const n of notes) out.log(`note: ${n.kind} ${n.node} ${n.dir} — ${n.why}`);

const failed =
	findings.length > 0 ||
	unreachable.length > 0 ||
	rosterUnresolved.length > 0 ||
	lookupFailed.length > 0;
if (!failed) {
	out.log(
		'✓ every runner install names a live, on-roster, unarchived repo' +
			(expectedDown.length ? ` (${expectedDown.length} expected down)` : '')
	);
}

if (out.json) {
	out.emit({
		nodes: machines.length,
		probed: machines.length - unreachable.length - expectedDown.length,
		installs: installCount,
		units: unitCount,
		findings,
		notes,
		unreachable,
		expectedDown,
		rosterUnresolved,
		lookupFailed,
		lines: out.held(),
	});
}

process.exit(failed ? 1 : 0);
