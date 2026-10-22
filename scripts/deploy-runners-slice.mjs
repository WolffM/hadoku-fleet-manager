#!/usr/bin/env node
/**
 * deploy-runners-slice — put every CI runner on every node into ONE capped
 * cgroup, and give each unit a per-unit ceiling.
 *
 * The sibling of `deploy-ci-throttle.mjs`, for the layer that had neither a
 * deployer nor an audit. The throttle bounds how many jobs START; this bounds
 * how much memory they may HOLD. Both are rendered from the node model in
 * `fleet-runner-manifest.json` and never hand-written on a box — but until now
 * only one of them could say whether the nodes actually agreed with it.
 *
 * WHY IT NEEDED ITS OWN COMMAND
 * -----------------------------
 * `runners-slice-install.sh` was invoked by hand over ssh, with the ceiling
 * typed on the command line. Three things followed from that, all observed:
 *   - Values drifted from the manifest with nothing watching (the claws sat at a
 *     hand-passed 4608 MB per unit while the repo said 4096).
 *   - A whole fleet-wide run could report `changed=27` and change nothing live,
 *     because a drop-in is inert until a daemon-reload.
 *   - hokon's 24 user-manager runner units were uncontained — `app.slice`,
 *     `MemoryMax=infinity` — while the 16 GiB cap on its 2 system units made the
 *     node look covered.
 *
 * WHAT IS DERIVED, AND WHAT IS DECLARED
 * -------------------------------------
 * `machines[].slice.maxMb` is normally ABSENT and derived on the node as
 * (measured MemTotal - minFreeMb). The manifest's `ramGb` is rounded — claw-1
 * says 11G and measures 11885 MiB — so a ceiling computed from it reserves the
 * wrong amount. hokon declares `maxMb` explicitly because there CI is a guest on
 * the production host and must not have most of the box.
 *
 * `machines[].slice.name` defaults to `runners.slice`. hokon overrides it to
 * `ci-runner.slice`, which already contains its system units: defaulting there
 * would MIGRATE them out of a capped slice, a containment change wearing a
 * cap's clothes.
 *
 * RESTARTS
 * --------
 * Off by default, and that is safe for the part that matters. `MemoryMax`
 * applies to a RUNNING unit on daemon-reload; only `Slice=` placement waits for
 * the next start. So the ceiling lands immediately and placement converges as
 * runners cycle. `--restart` forces it, and even then only IDLE runners are
 * touched — restarting one mid-job kills that job.
 *
 * USAGE
 *   fleet slice                    # dry run
 *   fleet slice --confirm
 *   fleet slice --machine claw-2 --confirm
 *   fleet slice --confirm --restart
 *   fleet slice --check            # audit, exit 1 on drift
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { packageVersion } from '../dist/lib/provenance.js';
import { isGuestNode } from '../dist/lib/node-role.js';
// ONE RULE FOR THE PER-UNIT CEILING, and this is the same built copy the minter
// runs. `unitMemoryMaxMb` is `src/runners/ephemeral.ts` — the fleet's answer to
// "how much memory may ONE runner unit hold" — and until 2026-09-19 this
// deployer did not ask it: it passed the DECLARED `slice.unitMaxMb` flat, so a
// node's standing runners sat at 4 GiB while the runners the same node minted
// sat at its measured ceiling. Measured on claw-4 that morning:
// `actions-runner-hadoku-fleet-manager.service` at MemoryMax=4294967296 beside
// `warm-claw-4-hadoku-fleet-manager.service` at 14562623488, on one box. #26
// already ruled the flat one wrong, and two provisioning paths with two rules
// is how only one of them got the ruling.
import { unitMemoryMaxMb } from '../dist/runners/ephemeral.js';

const DRAINS = readDrains();
import {
	loadManifest,
	manifestPath,
	machineArg,
	parseSummary,
	runOn,
	selectNodes,
} from './lib/fleet-exec.mjs';
import { createEmitter } from './lib/emit.mjs';
import { sliceSummaryProblems } from './lib/slice-summary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_SRC = resolve(__dirname, 'runners-slice-install.sh');

/**
 * The slice the MINTER can place a transient runner in.
 *
 * A literal copy of `DEFAULT_RUNNER_SLICE` in `src/runners/ephemeral.ts`, kept
 * in step by the guard test beside this script — the same shape as
 * `json-contract.mjs`, and for the same reason: this is a `.mjs` gate and the
 * minter is TypeScript, so importing it would mean reading `dist/`, which is a
 * verifier reading its own build rather than the source of truth.
 *
 * WHY A GATE AND NOT A COMMENT. `buildSpawnPlan`/`buildWarmSpawnPlan` emit this
 * name unconditionally: a per-node name would have to travel through
 * `MintRequest` → `dispatch-pass` → `mintEphemeralRunner`, and it does not. That
 * is correct only while every node that can receive a mint agrees with the
 * default — true today, because hokon is the sole override (`ci-runner.slice`,
 * hand-authored, `MemoryHigh=12G`/`CPUWeight=50`/`IOWeight=50`) and hokon is not
 * `ephemeral`, so neither minter can target it. The day that changes, this fails
 * rather than placing runners somewhere nobody declared.
 */
const MINT_SLICE = 'runners.slice';

/**
 * The version in which `buildSpawnPlan`/`buildWarmSpawnPlan` began emitting
 * `--property=Slice=`.
 *
 * Before it, NO input could produce a placed unit: there was nothing to pass.
 * After it, no input can produce an unplaced one — the name is defaulted inside
 * the builder and `resolveSliceName` never throws, which the guard test beside
 * this file pins. So this number is the whole of "could the package that minted
 * this unit have placed it", and it is the only thing separating a breach from
 * a leftover.
 *
 * It is the version the BEHAVIOUR landed in, not the first one observed
 * deployed (0.22.117). The stricter of the two is the right one: any unit
 * minted by 0.22.114 or later that is outside the slice is a real regression
 * and must block, and choosing the later number would have excused it.
 */
const SLICE_PLACEMENT_SINCE = '0.22.114';

/**
 * Is the package ASKING the question one that would have placed the unit?
 *
 * Returns null when the version cannot be read at all — `packageVersion()`
 * answers `<unresolved: …>` rather than throwing, and an unreadable version is
 * "I could not look", which below costs the advisory rather than granting it.
 */
function atLeastVersion(have, want) {
	const parts = (v) => String(v).split('.').map(Number);
	const a = parts(have);
	const b = parts(want);
	if (a.length !== b.length || a.some((n) => !Number.isFinite(n))) return null;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return a[i] > b[i];
	}
	return true;
}

const RUNNING_VERSION = packageVersion();
const RUNNING_PLACES = atLeastVersion(RUNNING_VERSION, SLICE_PLACEMENT_SINCE);

/**
 * AGE AND KERNEL CEILING FOR EVERY MINTED UNIT — the two facts the installer
 * does not answer.
 *
 * NOT a second copy of `mintlist`/`effslice`. Placement still comes from the
 * installer's own `MINT-PLACEMENT-DRIFT` lines, which read the effective
 * cgroup; this asks how OLD a minted unit is and what the kernel caps it at,
 * which nothing asked before because nothing needed to tell a leftover from a
 * breach.
 *
 * MONOTONIC, never wall-clock. `InactiveExitTimestampMonotonic` and
 * `/proc/uptime` are the same clock, so the age survives an NTP step and needs
 * no agreement between this host's clock and the node's — and it is an age,
 * not a date, so no fixture of it can rot (`fixture-clock-guard`).
 *
 * THE KERNEL, never `systemctl show`: CLAUDE.md's rule, and the same one
 * `kernelmax()` follows in the installer.
 *
 * `MINT-FACT-END` is the sentinel that separates "no minted units on this node"
 * from "the probe never ran". Without it an ssh that died before printing
 * anything reads as an empty, healthy fleet.
 */
const MINT_FACT_PROBE = [
	'XDG_RUNTIME_DIR="/run/user/$(id -u)"; export XDG_RUNTIME_DIR',
	'up=$(cut -d" " -f1 /proc/uptime)',
	'for u in $(systemctl --user list-units --type=service --all --plain --no-legend "jit-*" "warm-*" 2>/dev/null | awk \'{print $1}\'); do',
	'  case "$u" in *.service) ;; *) continue ;; esac',
	'  t=$(systemctl --user show "$u" -p InactiveExitTimestampMonotonic --value 2>/dev/null)',
	'  cg=$(systemctl --user show "$u" -p ControlGroup --value 2>/dev/null)',
	'  mx=$(cat "/sys/fs/cgroup${cg}/memory.max" 2>/dev/null)',
	'  age=$(awk -v a="$up" -v b="$t" \'BEGIN{ if (b+0 <= 0) print "unknown"; else printf "%d", a - (b/1000000) }\')',
	'  echo "MINT-FACT $u age_sec=$age kernel_max=${mx:-unknown}"',
	'done',
	'echo MINT-FACT-END',
].join('\n');

/** `MINT-FACT <unit> age_sec=<n|unknown> kernel_max=<bytes|unknown|max>` -> a map. */
function parseMintFacts(out) {
	if (!out.split('\n').some((l) => l.trim() === 'MINT-FACT-END')) return null;
	const facts = new Map();
	for (const line of out.split('\n')) {
		if (!line.startsWith('MINT-FACT ')) continue;
		const [, unit, ...rest] = line.trim().split(/\s+/);
		if (!unit) continue;
		const kv = Object.fromEntries(
			rest.map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)])
		);
		const age = Number(kv.age_sec);
		const max = Number(kv.kernel_max);
		facts.set(unit, {
			ageSec: Number.isFinite(age) && age >= 0 ? age : null,
			kernelMax: Number.isFinite(max) && max > 0 ? max : null,
		});
	}
	return facts;
}

/**
 * THE NODE'S OWN MemTotal — the one input `unitMemoryMaxMb` cannot be given
 * from the manifest.
 *
 * The slice ceiling is `measured MemTotal - minFreeMb`, and the installer
 * derives it ON THE NODE for a reason its own header states: `ramGb` is
 * ROUNDED (claw-1 says 11G and measures 11885 MiB), so a ceiling computed from
 * the manifest reserves the wrong amount. But the per-unit cap has to be in the
 * payload BEFORE the payload runs, so this asks the node the same question one
 * ssh earlier and lets the JS rule — the minter's rule, the only one — do the
 * arithmetic.
 *
 * A NODE THAT DOES NOT ANSWER IS NOT A NODE TO GUESS FOR. There is no fallback
 * number here: an unreadable MemTotal fails the node exactly as an unreadable
 * SUMMARY does. Writing a flat cap to a box whose size we could not read is the
 * failure this whole change is about.
 *
 * `MEMTOTAL-END` is the sentinel, for the same reason `MINT-FACT-END` is: an
 * ssh that died before printing must not read as a node with no memory.
 */
const MEMTOTAL_PROBE = [
	`awk '/^MemTotal:/{printf "MEMTOTAL-MB %d\\n", $2/1024}' /proc/meminfo`,
	'echo MEMTOTAL-END',
].join('\n');

/** `MEMTOTAL-MB <n>` -> MiB, or null when the probe could not look. */
function parseMemTotalMb(out) {
	if (!out.split('\n').some((l) => l.trim() === 'MEMTOTAL-END')) return null;
	const line = out.split('\n').find((l) => l.startsWith('MEMTOTAL-MB '));
	const n = Number((line ?? '').slice('MEMTOTAL-MB '.length).trim());
	return Number.isFinite(n) && n > 0 ? n : null;
}

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const CHECK = args.includes('--check');
const RESTART = args.includes('--restart');
const ONLY = machineArg(args);

// The shared emitter, not a private `if (!JSON_OUT) console.log`. This script
// prints kilobytes under `--check` — 8,758 bytes measured on 2026-09-16, which
// is past the 8 KB a pipe delivers to a process that exits without draining
// (#33) — and `emit.mjs` is the one place that is answered for every subcommand
// at once.
const emitter = createEmitter({ argv: process.argv });
const JSON_OUT = emitter.json;
const log = (...a) => emitter.log(...a);

// Matches deploy-ci-throttle: a sequential pass over ~27 units per node can
// outrun a short ssh timeout, and a connection dropped MID-TRANSACTION is the
// dangerous case.
const SSH_TIMEOUT_MS = 600_000;
const MIB = 1024 * 1024;

/**
 * Inputs are prepended as plain assignments, exactly as deploy-ci-throttle does
 * — nothing is substituted into the script text, so the shell half stays a real
 * file that can be run and tested on its own.
 */
function payload(sliceCfg, minFreeMb, apply, unitMb) {
	const pre = [
		`APPLY=${apply ? 1 : 0}`,
		`RESTART=${RESTART ? 1 : 0}`,
		`SLICE_NAME=${sliceCfg.name ?? 'runners.slice'}`,
		`SWAP_MB=${sliceCfg.swapMb ?? 4096}`,
		// COMPUTED BY THE CALLER, never defaulted by the installer — see
		// `perUnitCapMb` and the import of `unitMemoryMaxMb` at the top. The
		// installer refuses a run that supplies no UNIT_MB rather than falling
		// back to the flat 4096 it used to.
		`UNIT_MB=${unitMb}`,
		// Default 1. `manageUnit: false` means the slice unit is hand-authored and
		// carries properties this tool does not model — hokon's has MemoryHigh,
		// CPUWeight and IOWeight — so it is placed into and audited, never written.
		`MANAGE_UNIT=${sliceCfg.manageUnit === false ? 0 : 1}`,
		// Exactly one of these: an explicit ceiling, or the floor to derive it from.
		sliceCfg.maxMb ? `MAX_MB=${sliceCfg.maxMb}` : `MIN_FREE_MB=${minFreeMb}`,
		'',
	].join('\n');
	return pre + readFileSync(INSTALL_SRC, 'utf8');
}

const manifest = loadManifest();

/**
 * Mint-capable nodes whose declared slice the minter cannot honour.
 *
 * The WARM minter, specifically. Since #120 a JIT mint carries its node's
 * declared slice (`MintRequest.sliceName`), which is how hokon's units reach
 * `ci-runner.slice`; a warm listener is still built with the default name
 * alone. Every `ephemeral: true` node can be handed a warm listener, so every
 * one must agree with the default. An on-demand guest is not `ephemeral` and
 * never holds a listener, so its override is honoured rather than a conflict.
 *
 * Read from the WHOLE manifest, never the `--machine`-filtered selection: an
 * operator auditing one node must not be able to make a fleet-wide invariant
 * report clean by narrowing the question. A node with no `slice` block at all is
 * fine — the minter's default and the installer's default are the same name.
 */
const mintSliceConflicts = Object.entries(manifest.machines ?? {})
	.filter(([, m]) => m?.ephemeral === true)
	.filter(([, m]) => (m.slice?.name ?? MINT_SLICE) !== MINT_SLICE)
	.map(([name, m]) => `${name} declares slice.name=${m.slice.name}`);

/**
 * THE ROLE-AWARE DOOR — a guest is not converged and is never asked for sudo.
 *
 * hokon declares a `slice` block and a `minFreeMb`, so the filter above matched
 * it and this gate walked the production host's 27 runner units like any claw.
 * On 2026-09-16 that is what `ci:audit-gates` was red on: `sudo_ok=no`,
 * `changed=1`, `actions-runner-hadoku-cardtable.service effective=app.slice`,
 * and a fix hint reading "On hokon, as the operator: sudo -v && fleet slice
 * --machine hokon --confirm". Asking the operator for sudo on the production
 * host to move a guest's unit is exactly what the 2026-09-14 decision rules out:
 * "hokon is a guest fleet member; they are here when they are needed."
 *
 * Whether hokon's BACKSTOP REGISTRATION is online with its labels is still the
 * fleet's business — it is just a different gate's question, asked of the GitHub
 * API by `check-label-floor`, and answered without touching the box.
 */
const { nodes, skippedByRole } = selectNodes(manifest, {
	only: ONLY,
	where: (m) => m.slice && typeof m.minFreeMb === 'number',
	argv: args,
});

/**
 * THE FILTER IS RIGHT. ITS SILENCE WAS NOT (#98) — `deploy-ci-throttle`'s
 * lesson, which this file had not learned.
 *
 * `where` above drops any node that declares no `slice` block or no numeric
 * `minFreeMb`, and must: the installer has no ceiling to write for it. But it
 * dropped it SILENTLY, so a claw enrolled without a slice was absent from every
 * `fleet slice --check` while the run reported every node it did look at as
 * contained — and a node nothing contains is the 2026-08-04 shape, one label
 * away from taking work. Computed from the same `--machine` scope, guests
 * excluded (a guest is out of scope by role, which is a different fact), and
 * REPORTED on every run; under --check it is drift. Read straight off the
 * manifest, not through a selection door: this list is printed, never contacted.
 */
const unsliced = Object.entries(manifest.machines ?? {})
	.filter(([name]) => !ONLY || name === ONLY)
	.filter(([, m]) => !isGuestNode(m) && !(m.slice && typeof m.minFreeMb === 'number'))
	.map(([name]) => name);

/** Selected guests — only ever reachable because the operator named one. */
const selectedGuests = nodes
	.filter(([name]) => isGuestNode(manifest.machines?.[name]))
	.map(([name]) => name);

// AN EXPLICIT `--machine <guest> --confirm` IS REFUSED, and says why. Someone
// will type it, because until today this script's own fix hint told them to.
// `deploy-ci-throttle` refuses the same request the same way.
if (selectedGuests.length && CONFIRM && !CHECK) {
	console.error(
		`deploy-runners-slice: ${selectedGuests.join(', ')} is a GUEST — refusing to converge it.\n\n` +
			'  A guest lends the fleet a registration and nothing else. Writing drop-ins,\n' +
			'  reloading its systemd and restarting its runners are all out of scope there,\n' +
			"  and the SYSTEM half of that needs the operator's sudo on the production host\n" +
			'  (operator, 2026-09-14). --check audits it; nothing here applies to it.'
	);
	process.exit(1);
}

if (unsliced.length) {
	// Printed on EVERY run, not only under --check, and BEFORE the zero-node
	// refusal below so it is said even when nothing is left to look at: a
	// `--confirm` that quietly skipped a node is as misleading as an audit that did.
	console.error(
		`\n✗ ${unsliced.length} declared node(s) SKIPPED: ${unsliced.join(', ')}\n` +
			'  They are in the manifest and declare no slice block (or no minFreeMb), so no cgroup\n' +
			'  ceiling was written or audited there — every runner on them is unbounded by any\n' +
			'  slice, one label away from taking work with nothing containing it.\n' +
			'  Fix: declare slice and minFreeMb on each, then re-run.'
	);
}

if (!nodes.length) {
	// A run that matched nothing must not report a clean pass over zero nodes —
	// and a run whose every match was skipped BY ROLE is the same shape wearing
	// "I chose not to look" as a costume. `converge-toolchain` draws the same
	// line for the same reason.
	console.error(
		'deploy-runners-slice: no nodes to deploy to' +
			(skippedByRole.length
				? `. Every match is a guest (${skippedByRole.map((s) => s.node).join(', ')}), which is ` +
					'not a pass — name a claw, or --include-guests if you really mean it.'
				: ONLY
					? ` (--machine ${ONLY} not found, or it declares no slice/minFreeMb)`
					: '')
	);
	process.exit(1);
}

log(`Manifest: ${manifestPath()}`);
log(`Mode: ${CHECK ? 'CHECK (audit)' : CONFIRM ? 'APPLY' : 'DRY RUN (no side effects)'}\n`);

// PRINTED, and carried in `--json`. A silent skip is how a node stops being
// checked and nobody notices.
for (const s of skippedByRole) {
	log(`── ${s.node}  [skipped: guest]`);
	log(`   ${s.why}.`);
}
if (skippedByRole.length) log('');

const results = [];
const drift = [];
const needsSudo = new Set();
/** node -> Map<unit, {ageSec, kernelMax}>, or absent when the probe could not look. */
const mintFacts = new Map();

/**
 * Record a node this run could not read — the ONE place that decides what
 * "could not look" costs.
 *
 * Extracted when the MemTotal probe gave this file a second way to fail a node:
 * two copies of "unreachable => drift, unless it is a guest, unless it is
 * deliberately down" is two chances for one of them to quietly become exit 0.
 *
 * `deferrable` is false for a node that ANSWERED but answered wrongly. A drain
 * excuses a box being off; it does not excuse a box that is on and cannot say
 * how much memory it has.
 */
function recordUnreadable(name, guest, why, out, deferrable) {
	const defer = deferrable ? deferralFor(name, DRAINS) : { deferred: false };
	if (defer.deferred) {
		log(`   · ${deferralNote(name, defer)} — not audited`);
		results.push({ machine: name, ok: true, expectedDown: true, skipped: 'expected down' });
		return;
	}
	log(`   ✗ ${why}: ${out.slice(0, 200)}`);
	results.push({
		machine: name,
		ok: false,
		role: guest ? 'guest' : 'claw',
		advisory: guest,
		error: `${why}: ${out.slice(0, 300)}`,
	});
	// An unreadable node is never a node whose state is right — unless it is a
	// guest, whose state was never this gate's to be right about. It is still
	// PRINTED and still in the report; it just does not fail the fleet.
	if (!guest) drift.push(`${name}: could not be audited (${why})`);
}

for (const [name, m] of nodes) {
	const cfg = m.slice;
	const sliceName = cfg.name ?? 'runners.slice';
	// A guest is only ever in `nodes` because the operator named it, and naming
	// it buys a LOOK, never a write: `apply` is forced off and every finding it
	// produces is advisory below.
	const guest = selectedGuests.includes(name);
	const apply = CONFIRM && !CHECK && !guest;
	log(
		`── ${name}  slice ${sliceName}  ` +
			`${cfg.maxMb ? `${cfg.maxMb}MB (declared)` : `MemTotal-${m.minFreeMb}MB (derived)`}` +
			`  swap ${cfg.swapMb ?? 4096}MB`
	);

	// THE PER-UNIT CEILING, by the minter's rule and nobody else's.
	//
	// The ceiling a unit may reach is the SLICE's ceiling. On a claw that is
	// derived from measured MemTotal, so the number has to come off the box —
	// hence the probe. On a node that DECLARES `maxMb` the manifest already
	// holds it and no probe is spent.
	//
	// A GUEST IS DELIBERATELY NOT WIDENED, and this is the one asymmetry in the
	// change. On a claw the slice ceiling IS "everything CI may have", so a unit
	// reaching it takes nothing from anyone (CLAUDE.md's floor is `minFreeMb`,
	// and the ceiling already carries it). On hokon the slice ceiling is a
	// deliberate 16 GiB guest allowance next to mgmt-api, the tunnel and
	// the other production services — the manifest's own `$why` says CI "must not be allowed to
	// grow into the space production needs" — so there the per-unit cap is the
	// thing that keeps ONE runaway from spending the whole guest allowance, and
	// it stays at the declared number. Withholding the ceiling is how that is
	// said: the rule is still the only rule, it is simply not given a ceiling to
	// widen to. hokon's 28 standing units keep 4 GiB, by decision, 2026-09-19.
	let ceilingMb = cfg.maxMb ?? null;
	let probedMemTotalMb = null;
	if (ceilingMb === null && !guest) {
		const probe = await runOn(name, MEMTOTAL_PROBE, {
			timeoutMs: 60_000,
			includeGuests: false,
			argv: args,
			manifest,
		});
		probedMemTotalMb = probe.ok ? parseMemTotalMb(probe.out) : null;
		if (probedMemTotalMb === null) {
			// NO FALLBACK NUMBER. A node whose size we could not read is a node we
			// cannot size a cap for, and writing one anyway is exactly the flat cap
			// this change exists to delete.
			recordUnreadable(
				name,
				guest,
				'could not read MemTotal, so the per-unit ceiling cannot be computed',
				`${probe.out ?? ''}${probe.stderr ?? ''}`.trim(),
				!probe.ok
			);
			continue;
		}
		ceilingMb = probedMemTotalMb - m.minFreeMb;
	}
	const unitMb = unitMemoryMaxMb({
		requestedMb: cfg.unitMaxMb,
		sliceCeilingMb: guest ? null : ceilingMb,
	});
	log(
		`   per-unit ${unitMb}MB ` +
			(guest
				? '(declared; a guest is not widened to its slice ceiling)'
				: `(unitMemoryMaxMb: declared ${cfg.unitMaxMb ?? 'none'}, ceiling ${ceilingMb}MB` +
					`${probedMemTotalMb === null ? '' : ` from measured MemTotal ${probedMemTotalMb}MB`})`)
	);

	// `includeGuests: false` ARMS THE TRANSPORT GATE as well as the selection one.
	// The two are not the same guarantee: selection decides who is in the sweep,
	// this decides that no code path in this file can reach a guest the operator
	// did not name, including one added later by someone who never read the
	// selection block.
	const r = await runOn(name, payload(cfg, m.minFreeMb, apply, unitMb), {
		timeoutMs: SSH_TIMEOUT_MS,
		includeGuests: false,
		argv: args,
		manifest,
	});
	const out = (r.stdout + r.stderr).trim();
	const kv = parseSummary(out);

	if (!r.ok || !kv) {
		// Deliberately powered off => expected, printed, not counted. Only when
		// it was UNREACHABLE: a node that answered but gave no SUMMARY is a
		// different fault and still drifts.
		recordUnreadable(name, guest, !r.ok ? 'unreachable or failed' : 'no SUMMARY line', out, !r.ok);
		continue;
	}

	// Only under --check, and only after the node has proven it answers: the
	// verdict is the only consumer, and a second ssh to a box that just failed
	// buys nothing. A probe that does not come back leaves no entry here, which
	// `judgeMintPlacement` reads as "could not look" and refuses to excuse.
	if (CHECK) {
		const probe = await runOn(name, MINT_FACT_PROBE, {
			timeoutMs: 60_000,
			includeGuests: false,
			argv: args,
			manifest,
		});
		const facts = probe.ok ? parseMintFacts(probe.out) : null;
		if (facts) mintFacts.set(name, facts);
	}

	const notes = out.split('\n').filter((l) =>
		// A PREFIX ADDED TO ONE SIDE AND NOT THE OTHER IS SILENT — which is what
		// happened to IO-REEXEC-DEFERRED on its first fleet-wide run. The
		// installer printed it on five of seven claws, correctly, and this
		// filter dropped every one: the converge reported changed=2, EXIT=0 and
		// no note at all, while the half of the fix that needs the user manager
		// to re-exec had been skipped on five nodes because they were mid-job.
		// The guard beside this file asserts each of these prefixes on BOTH
		// sides for exactly this reason.
		/^(BUSY|NEEDS-OPERATOR|UNIT-CAP-DRIFT|SLICE-PLACEMENT-DRIFT|MINT-PLACEMENT-DRIFT|MINT-CAP-DRIFT|SUPERVISION-DRIFT|PLACE-FAILED|SLICE-WARN|SLICE-FAIL|IO-REEXEC-DEFERRED|IO-REEXEC-FAILED|IO-DELEGATE-PENDING) /.test(
			l
		)
	);

	const wantMax = (cfg.maxMb ?? Number(kv.max_mb)) * MIB;
	const wantSwap = (cfg.swapMb ?? 4096) * MIB;
	const problems = [];
	// TWO DERIVATIONS OF ONE NUMBER, compared rather than trusted. The installer
	// derives MAX_MB from /proc/meminfo on the node; the probe above read the
	// same file one ssh earlier to size the per-unit cap. MemTotal does not move
	// while a kernel is up, so a disagreement means one of the two reads did not
	// see what it thought it saw — and the per-unit cap this run just WROTE was
	// computed from the probe's half.
	if (probedMemTotalMb !== null && Number.isFinite(Number(kv.max_mb))) {
		const derived = probedMemTotalMb - m.minFreeMb;
		if (Number(kv.max_mb) !== derived)
			problems.push(
				`the node derived a slice ceiling of ${kv.max_mb}MB while the MemTotal probe derived ` +
					`${derived}MB (${probedMemTotalMb} - ${m.minFreeMb}) — the per-unit cap applied here ` +
					`was ${unitMb}MB, computed from the probe's figure`
			);
	}
	// `changed`, both slice ceilings in both managers, and the minted units'
	// kernel caps — every one REQUIRING its good value (#98). See
	// lib/slice-summary.mjs; the user-manager half is explained there too.
	problems.push(...sliceSummaryProblems({ kv, notes, sliceName, wantMax, wantSwap }));
	// Carried so the fix hint can name the RIGHT command. Telling an operator to
	// re-run --confirm on a node that just failed for lack of sudo sends them
	// round the same loop.
	if (Number(kv.needs_operator) > 0) {
		problems.push(`${kv.needs_operator} unit(s) need an operator (no passwordless sudo)`);
	}
	const capDrift = notes.filter((n) => n.startsWith('UNIT-CAP-DRIFT')).length;
	if (capDrift) problems.push(`${capDrift} unit(s) below the per-unit ceiling`);
	// EFFECTIVE placement, which nothing asserted until 2026-09-01.
	//
	// `capped_live` reads the per-unit ceiling from the kernel and was always
	// honest. Membership was never read at all, so a unit could declare
	// `Slice=ci-runner.slice` and run in app.slice — systemd relocates on the next
	// unit START, never on a reload — and this check printed "every runner on
	// every node is in its declared slice" without having looked. On hokon that
	// was 24 of 27 units, outside a 16 GiB group ceiling, on the box that runs
	// mgmt-api and the PM2 fleet.
	//
	// This is the per-unit cap's blind spot exactly: the cap bounds ONE runner,
	// the slice bounds their SUM, and only the sum is what the 2026-08-04 outage
	// was about. A pass here must mean both.
	const placeDrift = notes.filter((n) => n.startsWith('SLICE-PLACEMENT-DRIFT')).length;
	if (placeDrift)
		problems.push(
			`${placeDrift} unit(s) declare the slice but RUN outside it — the per-unit cap holds, ` +
				'the GROUP ceiling does not; fixed only by restarting those units'
		);
	// THE MINTED HALF, which this gate could not see at all until 2026-09-14.
	//
	// The three globs the installer places are all STANDING units, and all-JIT
	// left the claws with none — so the check walked an empty set and printed
	// "every runner on every node RUNS IN its declared slice" while every actual
	// runner on the fleet ran in app.slice at MemoryMax=infinity. A gate blind to
	// the only units that exist is worse than no gate: it is the 2026-08-04
	// containment reported as present.
	//
	// The fix is the MINTER, never --restart: a transient unit is placed by
	// `--property=Slice=` at systemd-run time, its name is single-use, and
	// restarting one kills the job it is running.
	//
	// THE VERDICT IS NOT TAKEN HERE. Telling a leftover from a breach needs the
	// oldest correctly-placed mint ON THE WHOLE FLEET, which is not known until
	// every node has answered — see `judgeMintPlacement` below.
	// THE io CONTROLLER — the reason every job row carries `ioReadBytes: null`.
	//
	// `job-metrics.sh` reads `io.stat` out of the job's own cgroup and that file
	// does not exist there, because the user manager is not delegated io and
	// nothing under the slice asks for it. The installer's header has the
	// measurement; these are the three OBSERVED facts it reports back, none of
	// them read from a file this tool wrote:
	//
	//   io_ctrl    — io in the slice cgroup's `cgroup.controllers`: can this
	//                slice offer io to its children AT ALL. False until the
	//                delegation drop-in has landed AND the managers have picked
	//                it up, which is the whole first half.
	//   io_acct    — the live user manager's `DefaultIOAccounting`. A controller
	//                only appears in a cgroup's subtree_control because a MEMBER
	//                needs it, and a minted unit asks for memory and nothing
	//                else, so without this the delegation reaches the slice and
	//                stops there.
	//   io_subtree — io in the slice's own `cgroup.subtree_control`, which is the
	//                fact a job cgroup's io.stat actually depends on.
	//
	// `empty` IS NOT `no`. A cgroup with no members lists nothing in
	// subtree_control for any controller, and an idle all-JIT claw is routinely
	// in that state — claw-2 measured 0 children and a blank subtree_control on
	// 2026-09-16. Failing on it would redden a correct fleet every time it went
	// quiet, which is a gate nobody reads. The other two facts are what hold the
	// line there, and they are true whether or not the slice holds anything.
	if (
		kv.io_deleg === undefined ||
		kv.io_ctrl === undefined ||
		kv.io_acct === undefined ||
		kv.io_subtree === undefined
	) {
		// An installer too old to report them, or a SUMMARY that did not survive
		// the wire. Either way this run did not look, and "I could not look" is
		// never "nothing is wrong".
		problems.push(
			'the node reported no io-controller facts (io_ctrl/io_acct/io_subtree missing from ' +
				'SUMMARY) — this run did not look, which is not a pass'
		);
	} else {
		// THE TWO HALVES, NAMED SEPARATELY. `io_deleg` is the system manager's
		// half: it is true as soon as the Delegate= drop-in lands and a reload
		// realizes it, and it depends on nothing else. `io_ctrl` is the user
		// manager's half. Reporting only the second made the first fleet-wide
		// converge unreadable — 7/7 said `io_ctrl=no` when the drop-in had in fact
		// landed on 7/7 and the re-exec had been deferred on 5 for being mid-job.
		if (kv.io_deleg !== 'yes')
			problems.push(
				`the system manager has not delegated io to the user manager (io_deleg=${kv.io_deleg}) — ` +
					'the Delegate= drop-in is missing or has not been realized; --confirm writes it'
			);
		else if (kv.io_ctrl !== 'yes')
			problems.push(
				`io is delegated to the user manager but has not reached ${sliceName} ` +
					`(io_deleg=yes, io_ctrl=${kv.io_ctrl}) — the user manager has not re-exec'd into the ` +
					'new controller set, or has not re-realized since; every job row here still carries ' +
					'ioReadBytes: null'
			);
		if (kv.io_acct !== 'yes')
			problems.push(
				`the user manager's DefaultIOAccounting is ${kv.io_acct}, so no unit under ${sliceName} ` +
					'asks for io and the controller never reaches a job cgroup, delegated or not'
			);
		if (kv.io_subtree === 'no')
			problems.push(
				`${sliceName} holds members but offers them no io (cgroup.subtree_control has no io) — ` +
					'io.stat is absent in every job cgroup below it'
			);
		else if (kv.io_subtree !== 'yes' && kv.io_subtree !== 'empty')
			problems.push(
				`could not read ${sliceName}'s cgroup.subtree_control (io_subtree=${kv.io_subtree})`
			);
	}
	// Supervision rides this walk because the walk is the expensive part. Before
	// 2026-08-28 nothing checked these two properties at all: they were written by
	// hand with fix-runner-supervision.sh, and the only monitor watched for the
	// SYMPTOM (an orphaned or duplicated listener), which appears long after the
	// unit that will produce it has drifted.
	const supDrift = notes.filter((n) => n.startsWith('SUPERVISION-DRIFT')).length;
	if (supDrift)
		problems.push(
			`${supDrift} unit(s) will orphan their listener (want KillMode=mixed, Restart=always)`
		);
	// In --check nothing is written, so needs_operator is always 0; the honest
	// signal is "there is system-side drift AND this box has no passwordless sudo".
	//
	// Must come AFTER capDrift is declared. It used to sit above, and stayed
	// invisible for exactly as long as hokon had `changed > 0`: `||` short-circuits
	// on a truthy left operand, so capDrift was never read. The moment the operator
	// capped hokon's last two units, changed went to 0, the right operand ran, and
	// the audit died on a temporal-dead-zone ReferenceError — a latent crash that
	// only fires once the thing it reports on is FIXED.
	// A slice stuck in load-error blocks every NEW unit placed into it while
	// everything already running keeps running — so the node looks healthy
	// right up until you need it to accept something. hokon was in that state
	// for 2.5 weeks (see runners-slice-install.sh). Always a problem, never a
	// note: there is no benign reason for a slice not to load.
	const badSlices = Number(kv.bad_slices);
	if (Number.isFinite(badSlices) && badSlices > 0) {
		problems.push(
			`${badSlices} user slice(s) in LOAD-ERROR (${kv.bad_slice_names}) — ` +
				'no new unit can start in them; running units are unaffected, which is why this hides'
		);
	}

	// NEVER A GUEST. This set is the only thing that prints "On <node>, as the
	// operator: sudo -v && fleet slice --machine <node> --confirm", and on the
	// production host that sentence is the fleet asking a guest for sudo — the
	// one thing the 2026-09-14 decision rules out.
	if (!guest && kv.sudo_ok === 'no' && (Number(kv.changed) > 0 || capDrift > 0 || supDrift > 0))
		needsSudo.add(name);

	log(
		`   slice ${kv.live_max}/${kv.live_swap} (user ${kv.user_max}/${kv.user_swap})` +
			`  changed=${kv.changed} capped_live=${kv.capped_live}` +
			` in_slice=${kv.in_slice}/${kv.sup_total}` +
			// The minted count is printed even at 0/0, because 0/0 is the reading
			// that matters: it says this node has no live runner at all, which on an
			// all-JIT claw means the pass looked and found nothing rather than that
			// the pass had nothing to look at.
			` io=${kv.io_deleg}/${kv.io_ctrl}/${kv.io_subtree}/${kv.io_acct}` +
			` minted=${kv.mint_in_slice}/${kv.mint_total}` +
			` restarted=${kv.restarted} busy=${kv.busy}` +
			` supervised=${kv.supervised}/${kv.sup_total}${r.local ? '  (local)' : ''}`
	);

	// The declared ceiling is applied in BOTH managers, and they do not share a
	// budget: user units live under user@UID.service, outside the system slice.
	// So `maxMb` is a PER-MANAGER ceiling and the node total is up to twice it.
	// Surfaced on every run rather than failed on, because it is a property of the
	// design as declared, not drift from it — and a gate that is permanently red
	// is a gate nobody reads. Tracked as an open decision in the plan.
	const userMax = Number(kv.user_max);
	const userUnits = Number(kv.user_units);
	if (
		Number.isFinite(userMax) &&
		userMax > 0 &&
		Number.isFinite(Number(kv.live_max)) &&
		userUnits > 0
	) {
		const totalMb = Math.round((userMax + Number(kv.live_max)) / MIB);
		log(
			`     note: ceiling is enforced in BOTH managers (${userUnits} user unit(s)); the two do not` +
				` share a budget, so this node's CI total is bounded at ${totalMb}MB, not ${kv.max_mb}MB`
		);
	}
	for (const n of notes.slice(0, 6)) log(`     ${n}`);
	if (notes.length > 6) log(`     … ${notes.length - 6} more`);

	results.push({
		machine: name,
		ok: true,
		role: guest ? 'guest' : 'claw',
		// ADVISORY AT MOST. A guest's units are reported in full — the operator
		// asked for them by name — and none of it reaches `drift`, so none of it
		// fails `check:slice`.
		advisory: guest,
		summary: kv,
		notes,
		problems,
		sliceName,
		sliceCeiling: wantMax,
		// The number this run actually applied, and where it came from. Carried
		// because the whole point of the change is that it is no longer the
		// declared one, and a report that only echoes the manifest cannot show
		// that.
		unitCapMb: unitMb,
		sliceCeilingMb: ceilingMb,
		memTotalMb: probedMemTotalMb,
	});
}

/**
 * LEFTOVER OR BREACH — the two things `MINT-PLACEMENT-DRIFT` used to be.
 *
 * A minted unit outside the slice was minted without `--property=Slice=`, and
 * since {@link SLICE_PLACEMENT_SINCE} no input to `buildSpawnPlan` /
 * `buildWarmSpawnPlan` can produce one. So the line means one of two completely
 * different things — "a unit from before the fix that has not cycled yet", or
 * "the minter that is running right now is not placing" — and the second is the
 * 2026-08-04 containment missing, live.
 *
 * WHAT WOULD MAKE THIS GATE EASIER TO PASS THE WORSE THE FAILURE GETS. An
 * advisory keyed on "old" alone: every stray eventually becomes old, which is
 * `queue-health`'s one-hour ceiling over again — the casualties crossed the
 * exclusion line and left the percentile. So ADVISORY is a conjunction of four
 * clauses, and every one of them TIGHTENS as the failure grows:
 *
 *  1. THE FIX IS IN THE PACKAGE ASKING. A package older than
 *     SLICE_PLACEMENT_SINCE — or one whose version cannot be read — grants no
 *     advisory at all. "I could not look" must not buy an exemption, and an
 *     un-deployed fix is not a reason to stop reporting the breach it fixes.
 *  2. THERE IS A WITNESS. At least one minted unit somewhere in this audit is
 *     correctly placed, which is the only evidence that the DEPLOYED minter
 *     places — this package's own source cannot testify to what is running on
 *     hokon. A fleet where nothing is correctly placed has proven nothing, and
 *     every stray on it blocks.
 *  3. THE STRAY PREDATES THE WITNESS. Older than the OLDEST correctly-placed
 *     mint on the fleet: a stray younger than that was minted while a placing
 *     minter was demonstrably live, so it is a breach and not a leftover. This
 *     is the clause that closes forging and drift. The window only ever
 *     SHRINKS — mints are short-lived, so the oldest correctly-placed one moves
 *     forward continuously — and nothing can enter the advisory band by ageing
 *     into it, because ageing moves a unit away from the witness, not toward it.
 *  4. THE MISSING CEILING STILL BOUNDS NOTHING NEW. The slice bounds the SUM;
 *     if every stray carries a finite kernel `memory.max` and those sum to no
 *     more than the slice's own ceiling, the memory they can hold is already
 *     bounded by the number the slice would have enforced. A second stray, or
 *     one the kernel does not cap, breaks the arithmetic and blocks — so the
 *     advisory cannot become a parking lot: it is void the moment the leak is
 *     more than the one unit it was measured on.
 *
 * Clause 4 is what makes this a MEASUREMENT rather than a grace period, which
 * matters because the units that need it do not self-expire. A `jit-*` unit is
 * single-use and dies on its own; a `warm-*` listener is STANDING and
 * `planWarmCache` returns `keep` while its repo stays the node's target, so
 * "converges as it cycles" is true of the first and merely hopeful of the
 * second. The gate reports; it never restarts one.
 */
function judgeMintPlacement() {
	// The witness set: minted units this audit saw that the installer did NOT
	// name as misplaced. Placement stays the installer's answer, read from the
	// effective cgroup; this only joins ages onto it by unit name.
	let witnessAgeSec = null;
	let witnessCount = 0;
	for (const r of results) {
		const facts = mintFacts.get(r.machine);
		if (!r.ok || !facts) continue;
		const strays = new Set(strayUnits(r.notes));
		for (const [unit, f] of facts) {
			if (strays.has(unit) || f.ageSec === null) continue;
			witnessCount++;
			witnessAgeSec = witnessAgeSec === null ? f.ageSec : Math.max(witnessAgeSec, f.ageSec);
		}
	}

	const advisories = [];
	for (const r of results) {
		if (!r.ok) continue;
		const notes = r.notes;
		const problems = r.problems;
		const strays = notes.filter((n) => n.startsWith('MINT-PLACEMENT-DRIFT'));
		if (!strays.length) continue;
		const facts = mintFacts.get(r.machine);
		const units = strayUnits(notes);
		const seen = units.map((u) => ({
			unit: u,
			...(facts?.get(u) ?? { ageSec: null, kernelMax: null }),
		}));

		const why = [];
		if (RUNNING_PLACES !== true) {
			why.push(
				`the package running this check is ${RUNNING_VERSION}, which is not ` +
					`${SLICE_PLACEMENT_SINCE} or later — the minter it ships cannot place a unit at all`
			);
		}
		if (!facts) {
			why.push(`${r.machine} did not answer the mint-age probe, so nothing here can be dated`);
		}
		if (witnessAgeSec === null) {
			why.push(
				'no minted unit ANYWHERE in this audit is correctly placed, so nothing shows the ' +
					'deployed minter placing at all'
			);
		}
		for (const s of seen) {
			if (s.ageSec === null) why.push(`${s.unit} has no readable start time`);
			else if (witnessAgeSec !== null && s.ageSec <= witnessAgeSec)
				why.push(
					`${s.unit} is ${hms(s.ageSec)} old and the oldest correctly-placed mint on the fleet ` +
						`is ${hms(witnessAgeSec)} old — it was minted while a placing minter was live`
				);
			if (s.kernelMax === null) why.push(`${s.unit} carries no finite kernel memory.max`);
		}
		const capSum = seen.reduce((n, s) => n + (s.kernelMax ?? 0), 0);
		if (seen.every((s) => s.kernelMax !== null) && capSum > r.sliceCeiling) {
			why.push(
				`the stray units' kernel ceilings sum to ${capSum} bytes, above ${r.sliceName}'s own ` +
					`${r.sliceCeiling} — the SUM is genuinely unbounded here`
			);
		}

		const mintDrift = why.length ? strays.length : 0;
		if (mintDrift)
			problems.push(
				`${mintDrift} minted unit(s) (jit-*/warm-*) run OUTSIDE ${r.sliceName} and this is NOT ` +
					`a leftover: ${why.join('; ')}`
			);
		else {
			r.mintAdvisories = seen.map((s) => ({
				unit: s.unit,
				ageSec: s.ageSec,
				kernelMax: s.kernelMax,
				mintedBefore: SLICE_PLACEMENT_SINCE,
				runningVersion: RUNNING_VERSION,
			}));
			advisories.push(
				`${r.machine}: ${seen
					.map((s) => `${s.unit} minted ${hms(s.ageSec)} ago, kernel cap ${s.kernelMax} bytes`)
					.join('; ')} — older than every correctly-placed mint on the fleet ` +
					`(oldest ${hms(witnessAgeSec)}, ${witnessCount} placed), so it predates ` +
					`${SLICE_PLACEMENT_SINCE}; ${RUNNING_VERSION} is running and places. ` +
					`Its kernel ceiling already bounds what the slice would have. ADVISORY: it clears ` +
					`when the cache rotates or the node reboots. Never restart a live minted unit.`
			);
		}
	}
	return advisories;
}

/** The unit names the installer named as misplaced. */
function strayUnits(notes) {
	return notes
		.filter((n) => n.startsWith('MINT-PLACEMENT-DRIFT'))
		.map((n) => n.split(/\s+/)[1])
		.filter(Boolean);
}

/** An age, never a date — see MINT_FACT_PROBE. */
function hms(sec) {
	if (sec === null || !Number.isFinite(sec)) return 'unknown';
	if (sec < 3600) return `${Math.round(sec / 60)}m`;
	if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
	return `${(sec / 86400).toFixed(1)}d`;
}

const mintAdvisories = CHECK ? judgeMintPlacement() : [];
/** A guest's findings, reported and never failed on. */
const roleAdvisories = [];
for (const r of results) {
	if (!CHECK || !r.ok || !r.problems.length) continue;
	if (r.advisory) roleAdvisories.push(`${r.machine} (guest): ${r.problems.join('; ')}`);
	else drift.push(`${r.machine}: ${r.problems.join('; ')}`);
}
if (roleAdvisories.length) {
	log('');
	log(`⚠ ${roleAdvisories.length} guest(s) you named carry slice findings — ADVISORY, not drift:`);
	for (const a of roleAdvisories) log(`  ${a}`);
	log(
		'  A guest is not converged from here and is never asked for sudo. Whether its backstop' +
			" registration is online with its labels is check-label-floor's question, not this one's."
	);
}
if (mintAdvisories.length) {
	log('');
	log(
		`⚠ ${mintAdvisories.length} node(s) carry a minted unit from before ${SLICE_PLACEMENT_SINCE}:`
	);
	for (const a of mintAdvisories) log(`  ${a}`);
}

if (JSON_OUT) {
	emitter.emit({
		mode: CHECK ? 'check' : CONFIRM ? 'apply' : 'dry-run',
		version: RUNNING_VERSION,
		mintAdvisories,
		// The guests this run refused to act on. Alongside `results` rather than
		// inside it, the way `deploy-ci-throttle` carries its own: `results` means
		// "the nodes this run acted on", and a guest is exactly a node it did not.
		skippedByRole,
		roleAdvisories,
		results,
	});
} else {
	log('');
	const busy = results.flatMap((r) => r.notes ?? []).filter((n) => n.startsWith('BUSY'));
	if (!CONFIRM && !CHECK) log('Dry run only. Re-run with --confirm to apply.');
	if (busy.length)
		log(
			`${busy.length} runner(s) were mid-job and were not restarted. The per-unit ceiling still\n` +
				`applied (MemoryMax takes effect on reload); only Slice= placement waits. Re-run later.`
		);
	const failed = results.filter((r) => !r.ok);
	if (failed.length)
		log(`✗ ${failed.length} node(s) failed: ${failed.map((f) => f.machine).join(', ')}`);
}

// A CONFIG contradiction, not node drift — so it is reported on every run, not
// only under --check. An APPLY that installs `ci-runner.slice` on a node the
// minter will place into `runners.slice` succeeds at both halves and contains
// nothing, which is the shape of failure this whole file exists to refuse.
if (mintSliceConflicts.length) {
	console.error(
		`\n✗ ${mintSliceConflicts.length} mint-capable node(s) declare a slice the minter cannot use:`
	);
	for (const c of mintSliceConflicts)
		console.error(`  ${c}, but jit-*/warm-* are minted into ${MINT_SLICE}`);
	console.error(
		`\n  buildSpawnPlan/buildWarmSpawnPlan emit ${MINT_SLICE} unconditionally; the node's name\n` +
			'  is not threaded through MintRequest → dispatch-pass → mintEphemeralRunner. Either\n' +
			'  thread it, or drop the override from the manifest. Until then those nodes would be\n' +
			'  capped in a slice nobody declared.'
	);
}

if (CHECK) {
	if (mintSliceConflicts.length)
		drift.push(...mintSliceConflicts.map((c) => `${c} (minter uses ${MINT_SLICE})`));
	for (const n of unsliced)
		drift.push(`${n}: declares no slice/minFreeMb, so it was SKIPPED — unbounded by any slice`);
	if (drift.length) {
		console.error(`\n✗ slice drift on ${drift.length} node(s):`);
		for (const d of drift) console.error(`  ${d}`);
		// NAME THE COMMAND THAT ACTUALLY FIXES THE DRIFT WE FOUND.
		//
		// `--confirm` writes drop-ins and reloads, and that is enough for a
		// MemoryMax. It is not enough for placement: systemd moves a unit into its
		// slice on the unit's next START, so a running unit stays where it is and
		// re-running --confirm reports the same drift forever. RESTART defaults to
		// 0 precisely because bouncing a runner mid-job is not something a check
		// should do on its own — so the operator has to ask for it by name.
		const placement = drift.some((d) => d.includes('RUN outside it'));
		// THE io HALF NEEDS ROOT AND A MANAGER RE-EXEC, not a unit restart — so it
		// gets its own sentence rather than riding the --restart hint. Both writes
		// land in /etc, and a systemd manager only notices a newly-delegated
		// controller when it re-executes; --confirm does all of it. A node without
		// passwordless sudo falls through to the needsSudo block below.
		if (
			drift.some(
				(d) =>
					d.includes('io_deleg=') || d.includes('io_ctrl=') || d.includes('DefaultIOAccounting')
			)
		) {
			console.error(
				'\n  The io controller is a SYSTEM-side fix: a Delegate= drop-in on user@<uid>.service and\n' +
					'  DefaultIOAccounting=yes for the user manager, then a daemon-reload and a\n' +
					'  `systemctl --user daemon-reexec`. --confirm writes and runs all of it. It is NOT a unit\n' +
					'  restart — a manager re-exec preserves every running job, where restarting\n' +
					'  user@<uid>.service would kill all of them. Until it has run, every job row this node\n' +
					'  produces carries ioReadBytes: null.\n\n' +
					'  A node reporting io_deleg=yes with io_ctrl=no needs no new write: the drop-ins are\n' +
					'  already on disk and correct, and what was skipped is the user-manager re-exec, which is\n' +
					'  DEFERRED on a node that is mid-job (IO-REEXEC-DEFERRED above). Re-run the same --confirm\n' +
					'  when the node is idle; it is idempotent and will write nothing.'
			);
		}
		// DELIBERATELY A DIFFERENT HINT. `--restart` is the fix for a standing unit
		// that carries the right drop-in and has not restarted since. A minted unit
		// has no drop-in to carry and restarting it kills a running job — the only
		// thing that fixes it is the next mint, from a package whose
		// buildSpawnPlan emits Slice=.
		if (drift.some((d) => d.includes('minted unit(s)'))) {
			console.error(
				'\n  Minted units (jit-*/warm-*) are NOT fixed by --confirm or --restart. They are placed\n' +
					'  by `--property=Slice=` at systemd-run time, so they converge as jobs cycle once the\n' +
					'  package that mints them is deployed. Never restart a live JIT unit: it kills the job\n' +
					'  and orphans the registration. Check the deployed version first.'
			);
		}
		console.error(
			`\n  Fix: fleet slice --confirm${placement ? ' --restart' : ''}\n` +
				(placement
					? '  --restart is REQUIRED here: these units already carry the right drop-in and\n' +
						'  systemd only relocates a unit when it next starts, so --confirm alone will\n' +
						'  report this same drift again. Runners mid-job are skipped and reported BUSY;\n' +
						'  re-run until in_slice matches the unit count.\n'
					: '') +
				'  A node whose runners are not in the slice has NO memory ceiling at all —\n' +
				'  the manifest values are inert until this has run there.'
		);
		for (const m of needsSudo) {
			console.error(
				`\n  ${m} needs an operator — its SYSTEM units cannot be written without sudo.\n` +
					`  Re-running --confirm will fail the same way. On ${m}, as the operator:\n` +
					`    sudo -v && fleet slice --machine ${m} --confirm\n` +
					`  (sudo -v caches credentials first, so the script's own \`sudo -n\` succeeds.)\n` +
					`  The user-manager half needs no sudo and is applied already.`
			);
		}
		process.exit(1);
	}
	// Says "runs in", not "declares". The old wording claimed placement and the
	// check only ever tested ceilings.
	//
	// AND IT DOES NOT CLAIM IT OF A UNIT IT JUST EXCUSED. A pass with advisories
	// says what is true — no LIVE breach — rather than repeating a sentence the
	// advisory block on screen contradicts.
	if (mintAdvisories.length) {
		log(
			`✓ no live containment breach: ${mintAdvisories.length} minted unit(s) predate ` +
				`${SLICE_PLACEMENT_SINCE} and their own kernel ceilings bound what the slice would ` +
				'have. Every other runner RUNS IN its declared slice, at its declared ceilings.'
		);
	} else {
		log('✓ every runner on every node RUNS IN its declared slice, at its declared ceilings.');
	}
}

// ZERO CLAWS LOOKED AT IS NOT A PASS, even when every skip was deliberate.
//
// `fleet slice --machine hokon --check` audits one guest, fails on nothing, and
// would otherwise exit 0 — "I could not look" wearing "I chose not to look" as a
// costume, which is the shape `converge-toolchain` refuses for the same reason.
// A run that acted on nothing but guests has proven nothing about the fleet.
const onlyGuests = results.length > 0 && results.every((r) => r.advisory);
if (onlyGuests) {
	console.error(
		`\n✗ every node this run looked at is a guest (${results.map((r) => r.machine).join(', ')}),\n` +
			'  so nothing about the fleet was checked. That is not a pass. Name a claw, or run\n' +
			"  fleet-wide. A guest's findings above are advisory and fix nothing here."
	);
}

// A GUEST NEVER FAILS THIS GATE on its own findings. `r.advisory` is set only for
// a node the operator named by hand, and a guest that did not answer is a guest
// that was never this gate's to audit — reported, printed, and not counted.
process.exit(
	results.some((r) => !r.ok && !r.advisory) || mintSliceConflicts.length || onlyGuests ? 1 : 0
);
