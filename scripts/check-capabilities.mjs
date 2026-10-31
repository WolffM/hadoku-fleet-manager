#!/usr/bin/env node
/**
 * check-capabilities — a node must be able to DO what its labels claim.
 *
 * Workstream C3. The manifest projects a node's `labels` onto every runner it
 * hosts, and GitHub routes on those labels — so a label is a promise. Nothing
 * checked the promise, and the failure mode is silent: the job lands on a
 * node that advertised the capability and dies there, which reads as a flaky
 * test rather than as fleet drift.
 *
 * The probe EXECUTES rather than lists, and that distinction is the whole point.
 * Debian's ffmpeg reports `av1_nvenc` in `-encoders` regardless of hardware, so
 * every claw "has" it by that measure; only a real 256x256 encode separates
 * hokon's RTX 4090 from claw-1's GTX 860M. Measured 2026-08-27: hokon
 * `encoded-256x256`, all three claws `listed-but-encode-failed`.
 *
 * Also probes `--jitconfig`, which appears in NO `Runner.Listener --help` output
 * on 2.336.0 and which the entire ephemeral dispatcher depends on. A runner
 * self-update could remove it, and the fleet should learn that from a probe
 * rather than from a dispatcher that has quietly stopped working.
 *
 * MIGRATED (wave 5h lane B): `ci:audit-gates` runs this one with `--json` and
 * judges it by the `GateDoc` below rather than a regex over stdout+stderr —
 * see `src/lib/job-registry.ts`'s `coversSubs` entry (`contract: 'json'`) and
 * `scripts/lib/json-contract.mjs`'s derivation of `JSON_CONTRACT` from it.
 * The pre-existing `legacyFindings` (a flat string per drift, the shape this
 * script has always emitted) travels unchanged, under its migration-era
 * name — `findings` itself now means `GateDoc`'s structured array, same
 * rename `check-contract-consumers.mjs` made in wave 5f lane B.
 */
import { loadManifest, machineArg, runOn, selectMachines } from './lib/fleet-exec.mjs';
import { stateDir } from './lib/paths.mjs';
import {
	applyVerdicts,
	readRevocations,
	writeRevocations,
} from '../dist/capability-revocations.js';
import {
	capability,
	judgeMeasurement,
	measuredIdleOnly,
	nodeOffer,
	probeableIds,
	workloadGateContext,
	workloadGatedCapabilities,
	workloadGateStatus,
} from '../dist/capabilities.js';
import { isGuestNode } from '../dist/lib/node-role.js';
import { proofFileStatus, readProofsForCapability } from '../dist/lib/measured.js';
import { createEmitter } from './lib/emit.mjs';
import { buildGateDoc } from './lib/gate-doc.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { parseLoad } from './lib/idle-measure.mjs';
import { dataEndpointUrl, probeScript, serviceStateRoot, unprobed } from './lib/probe-script.mjs';

const DATA = dataEndpointUrl();
const UNPROBED = unprobed(DATA);
const JSON_OUT = process.argv.includes('--json');
/**
 * Every stdout write in this file goes through here.
 *
 * Measured 2026-09-16: this report is 9,462 bytes on the live fleet, and
 * `console.log` followed by `process.exit` delivered 8,192 of them through a
 * pipe — which is how every consumer reads it. The emitter puts fd 1 in
 * blocking mode, so the exit at the bottom of this file cannot cut the document
 * short. See `lib/emit.mjs` and issue #33.
 */
const out = createEmitter({ json: JSON_OUT });

/**
 * Which capabilities a probe can answer, DERIVED from the registry's `verify`
 * field rather than kept as two literal sets here.
 *
 * The sets they replace were `PROBEABLE` and `ROLE_LABELS`, and between them
 * they covered seven of the fleet's eight label capabilities. `hokon-backstop`
 * was in NEITHER — so a node that declared it would have been reported as
 * "declares hokon-backstop and nothing can verify it", a false finding about a
 * label census.ts has always known the meaning of. A vocabulary split across two
 * hand-kept sets in one file and three constants in another is exactly what the
 * registry exists to end.
 *
 * The behaviour is unchanged for every label any node declares today: the
 * registry's `verify: 'probe'` set is `{av1-nvenc, ffmpeg, python-venv,
 * jitconfig}` and everything else is `role` or `mint`, which is what these two
 * literals said.
 */
const PROBEABLE = probeableIds();

/**
 * A probe that errored but still printed PROBE-END ran to completion — the exit
 * code carries a FAILED capability, not a failed connection. Only a run with no
 * end marker is genuinely unreachable.
 */
async function run(node, phase = 'all') {
	const r = await runOn(
		node,
		probeScript(phase, DATA, { stateRoot: serviceStateRoot(manifest.machines[node]) }),
		{ as: 'ci', timeoutMs: 180_000 }
	);
	return !r.ok && !r.stdout.includes('PROBE-END') ? null : r.stdout;
}

/**
 * AN IDLE READING BELOW THE BAR IS MEASURED TWICE BEFORE IT IS DRIFT (#122).
 *
 * "Idle" is a counted zero of live Runner.Workers, and a job that ENDED three
 * minutes ago leaves none — while leaving a heat-soaked, clocked-down package
 * behind. claw-1 (an i7-4710HQ laptop that throttles under any sustained load)
 * read 773 against a 1200 bar at 13:15 on 2026-10-19, 3-7 minutes after two
 * builds, with a recorded idle 1728; a manual rerun was green, and the page
 * said jobs "will fail ON A NODE THAT ADVERTISED IT".
 *
 * So a failing idle reading waits CAP_REMEASURE_SETTLE_MS and re-runs ONLY the
 * idle-only measurements (`CAP_PROBE_PHASE=measured`, ~20 s). Drift is reported
 * only if the second idle reading also fails; a second reading under load is
 * "not judged", and a pass is recorded in `remeasured`, never silently dropped.
 * Real drift — a box that genuinely got slower — fails both, so this costs the
 * gate nothing but a minute on the rare node that trips it. Budget: the whole
 * fleet probes in ~71 s in parallel; +60 s settle +~30 s re-measure stays well
 * inside audit-gates' 300 s for this gate.
 */
const SETTLE_MS = Number(process.env.CAP_REMEASURE_SETTLE_MS ?? 60_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const driftFinding = (node, label, reason) =>
	`${node}: offers "${label}" (declared or earned) but cannot execute it (${reason}) — ` +
	`jobs routed here by that label will fail ON A NODE THAT ADVERTISED IT`;

const manifest = loadManifest();

/**
 * `--machine`, THE ONE SPELLING — and until 2026-09-15 this command ignored it.
 *
 * `selectMachines(manifest)` was called with no `only`, and `machineArg` was
 * never imported, so `fleet capabilities --machine claw-1` probed all eight
 * machines and said nothing. Measured, not deduced: seven consecutive
 * `--machine claw-N` runs each returned a `results` object keyed by every node
 * in the fleet. A flag that silently does nothing is worse than an absent one —
 * the operator believes the blast radius is one box. Same reasoning
 * `fleet provision` already carries for a bare positional; two subcommands of
 * one CLI cannot disagree about it.
 */
const ONLY = machineArg(process.argv.slice(2));

/**
 * A GUEST IS NOT PROBED. Skipped by ROLE, never by name.
 *
 * "I do NOT want hokon being impacted by the fleet chain" (operator,
 * 2026-09-14). A capability probe is the fleet chain reaching onto a box and
 * executing things there: it compiles on every core, launches a browser, runs
 * ffmpeg encodes, and since #6 starts and kills a pm2 daemon. None of that is
 * the fleet's business on a machine that only lends it a registration.
 *
 * IT IS ALSO A CORRECTNESS FIX, not only a courtesy. A guest's labels stay
 * DECLARED — one of the two places a declaration is the right evidence — so the
 * loop below, which reports "declares X but cannot execute it" for anything the
 * registry marks `verify: 'probe'`, is asking the wrong question of a guest
 * entirely. Before #6 it happened not to bite, because every label a guest
 * declared was `role`-verified. `pm2-host` is no longer one, and the gate's
 * verdict on it would otherwise depend on probing the machine the rule exists to
 * leave alone.
 *
 * The guest is REPORTED, not dropped: see `roleDeclared` below. "I did not need
 * to look" is a third answer, distinct from "I looked" and from "I could not".
 */
const selected = selectMachines(manifest, { only: ONLY });
const guests = selected.filter(([, m]) => isGuestNode(m));
const nodes = selected.filter(([, m]) => !isGuestNode(m));

/**
 * `--include-guests` — same spelling `converge-toolchain` and
 * `deploy-ci-throttle` use. It does NOT lift the probe skip above: a guest is
 * still never probed, because the probe is this command's most invasive path
 * (compiles on every core, launches a browser, runs ffmpeg encodes, starts and
 * kills a pm2 daemon) and none of that becomes safe just because an operator
 * typed a flag. What it lifts is the REFUSAL below, for a guest EXPLICITLY
 * named by `--machine` — issue #75: `fleet capabilities --machine hokon`
 * refused outright, even though "declared, not probed" (`roleDeclared`) was a
 * perfectly good, honest answer this file already knew how to give as part of
 * a wider sweep. Requiring BOTH flags (not just naming the guest) keeps a
 * plain `--machine hokon` refusing exactly as the existing test demands —
 * nobody is surprised into a guest-shaped answer by a typo'd name alone.
 */
const INCLUDE_GUESTS = process.argv.includes('--include-guests');

/**
 * ZERO NODES IS A FAILURE, NOT A CLEAN FLEET — UNLESS THE ONLY MATCH IS A
 * GUEST THE OPERATOR NAMED ON PURPOSE.
 *
 * With `--machine` honoured, a typo now selects nothing — and nothing probed
 * yields no findings, which is byte-identical to a healthy fleet. The same shape
 * `check-capability-schema` already refuses for a manifest declaring no
 * machines. That refusal stands whenever NOTHING matched (a typo), and whenever
 * something did match but the operator did not ask for the guest answer with
 * `--include-guests`.
 *
 * `--machine hokon --include-guests` falls through instead: `nodes` stays
 * empty (a guest is still never probed — see above), but `guests` is not, and
 * the `roleDeclared` reporting below already knows how to answer that
 * honestly. Exit 0, because nothing is WRONG — the fleet correctly left a
 * guest alone, and said so.
 */
if (!nodes.length && !(guests.length && ONLY && INCLUDE_GUESTS)) {
	console.error(
		`✗ no probeable node selected${ONLY ? ` for --machine ${ONLY}` : ''}. ` +
			`A probe of zero machines produces zero findings, which is indistinguishable\n` +
			`  from a healthy fleet. ` +
			(guests.length
				? `The only match is a GUEST (${guests.map(([n]) => n).join(', ')}), whose labels are ` +
					`declared and never probed. Re-run with --include-guests to get that answer.`
				: `Check the name against the manifest.`)
	);
	process.exit(1);
}

/**
 * Capabilities every managed node must have, declared once in the manifest.
 *
 * AN EMPTY LIST IS REFUSED (#98). `?? []` read a missing
 * `toolchain.capabilities` as "nothing is required" and the loop below then
 * checked nothing on every node, exiting 0 — the same bar-of-zero
 * `check-label-floor` refuses for an empty required set.
 */
const REQUIRED_CAPS = manifest.toolchain?.capabilities ?? [];
if (!Array.isArray(REQUIRED_CAPS) || !REQUIRED_CAPS.length) {
	console.error(
		`✗ the manifest's toolchain.capabilities is ${Array.isArray(REQUIRED_CAPS) ? 'empty' : 'not a list'}.\n` +
			`  It is what every managed node must prove; probing against an empty list checks nothing\n` +
			`  on every node and reads as a healthy fleet.`
	);
	process.exit(1);
}
const findings = [];
/**
 * Wave 5h lane B. One structured `{node, kind, reason}` record per
 * `findings` string, same call site, same message — `buildGateDoc`'s shape,
 * carried ALONGSIDE the prose rather than reconstructed from it by regex
 * later. `node: null` for a fleet-wide record (the `$proof` or revocation
 * ledger itself, never a single machine).
 */
const gateFindings = [];
/** One call updates both: the prose array the human report and the
 *  pre-existing `legacyFindings` JSON field already read, and the structured
 *  one `--json`'s `GateDoc` half reports through `buildGateDoc`. */
function pushFinding(node, kind, message) {
	findings.push(message);
	gateFindings.push({ node, kind, reason: message });
}
/**
 * Offered IDLE-ONLY labels whose measurement this run took beside a live job —
 * `{ node, capability, reason }`. NOT findings (2026-10-10): this gate does not
 * drain, so on a working fleet it measures `cargo-bevy` beside CI most of the
 * time, and 1169 beside a job says nothing about a box that scored 2281 idle.
 * Reported, so the absence of a verdict is visible; an IDLE reading below the
 * bar is still a finding, below.
 */
const notJudged = [];
const unreachable = [];
const results = {};
/** node -> { capabilityId -> WorkloadGateStatus } — wave 4e follow-up (#102). */
const workloadGateResults = {};

/**
 * This run's `WorkloadGateContext` — one state-dir read, built once and
 * reused for every node below, same pattern as `ephemeral-tick.ts`'s
 * `loadWorkloadGateContext` and `scripts/floor-probe.mjs`'s `workloadGate`.
 *
 * `proofFileStatus` is checked FIRST: an UNREADABLE or MALFORMED `$proof`
 * file must never be read as "no records at all" (which would silently
 * RE-GRANT a label a FAIL/STALE mark had just withdrawn), so `corrupt: true`
 * forces every workload-gated reason to read as withheld, fleet-wide — and
 * is ALSO a finding, since a read-only reporter's job is to say "I could not
 * look", not merely to withhold the one thing that depends on it.
 */
const WORKLOAD_GATED = workloadGatedCapabilities();
const proofStatus = proofFileStatus({ dir: stateDir() });
if (proofStatus.corrupt) {
	pushFinding(
		null,
		'proof-corrupt',
		`$proof is ${proofStatus.reason} (${proofStatus.why}) — every workload-gated reason below ` +
			`reads as withheld until this is fixed`
	);
}
const workloadGate = proofStatus.corrupt
	? workloadGateContext(
			nodes.map(([n]) => n),
			{},
			{ corrupt: true }
		)
	: workloadGateContext(
			nodes.map(([n]) => n),
			Object.fromEntries(
				WORKLOAD_GATED.map((id) => [id, readProofsForCapability(id, { dir: stateDir() })])
			)
		);

/** `CAP <id> <state> <detail...>` lines -> `{ id: { ok, detail } }`. */
function parseCaps(out) {
	const caps = {};
	for (const line of out.split('\n')) {
		// `CAP <id> <state> <detail...>` — DETAIL IS THE REST OF THE LINE.
		//
		// This destructured a full `split(/\s+/)`, which keeps only the fourth
		// field and DISCARDS everything after it. Every multi-word detail the
		// probe emits was therefore truncated to its first word, and the fleet
		// table rendered `nvdec=cuda` and `cuda=no` across five claws: the first
		// meaningless, the second indistinguishable from a real `no`. The probe
		// was right; the reader was throwing the answer away.
		const m = /^CAP\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line.trim());
		if (m) caps[m[1]] = { ok: m[2] === 'ok', detail: m[3].trim() || m[2] };
	}
	return caps;
}

/** Offered idle-only labels whose re-measure (#122) passed — reported, not findings. */
const remeasured = [];
/**
 * Every JUDGED execution of an offered routing label: what revokes it or clears
 * its revocation (src/capability-revocations.ts). A label not judged (measured
 * under load), not probeable, or on an unreachable node adds nothing — "could
 * not look" moves no record.
 */
const verdicts = [];
const routable = (cap) => Boolean(cap && cap.surface === 'label' && cap.kind === 'identity');

await Promise.all(
	nodes.map(async ([name, m]) => {
		const out = await run(name);
		if (out === null) {
			unreachable.push(name);
			return;
		}
		const caps = parseCaps(out);
		results[name] = caps;
		// How busy the node was while each idle-only capability was measured —
		// counted by the probe itself, not inferred (see lib/idle-measure.mjs).
		const load = parseLoad(out);

		// THE WORKLOAD GATE'S OWN REASON, per workload-gated capability THIS
		// PROBE says the node's tool actually works — "the reason is visible...
		// never a silent absence" (wave4e Settled). A tool the probe could not
		// confirm has nothing to say about its workload half either; that
		// absence is already `caps[id]` reporting unreachable/not-ok above.
		for (const id of WORKLOAD_GATED) {
			if (!caps[id]?.ok) continue;
			const gate = workloadGateStatus(
				capability(id),
				workloadGate.byNode[name]?.[id] ?? null,
				workloadGate.provenCounts[id] ?? 0
			);
			(workloadGateResults[name] ??= {})[id] = gate;
		}

		// Fleet-wide requirements, not per-node labels.
		//
		// These replaced `toolchain.packages`, which asked dpkg whether a Debian
		// package was installed. That is a distro's ANSWER to a capability question
		// rather than the question, and it is the weaker one either way: a package
		// can be present and broken. The probe CREATES a venv and RUNS ffmpeg.
		//
		// The fleet is uniformly Debian Trixie as of 2026-08-30 and this is
		// deliberately not written to depend on that — but note the earlier version
		// of this comment asserted "the new claws run Omarchy", which was never a
		// plan. Distro belongs to a node's onboarding profile, not to a checker.
		for (const cap of REQUIRED_CAPS) {
			if (!caps[cap]?.ok) {
				pushFinding(
					name,
					'required-capability-broken',
					`${name}: ${cap} is required of every managed node but does not work here ` +
						`(${caps[cap]?.detail ?? 'no result'})`
				);
			}
		}

		// EVERY LABEL THE NODE OFFERS, not only the ones it declares (#98). Claws
		// declare nothing since 2026-09-09; `cargo-bevy` and `jdk21` reach their
		// registrations and mints through `nodeOffer` from `earned`, so a loop
		// over `m.labels` re-checked none of them — a claw whose JDK broke after
		// bootcamp kept routing Forge jobs to itself with this gate green.
		const offered = new Set([...(m.labels ?? []), ...nodeOffer(m, { eligible: true })]);
		const idleMisses = [];
		for (const label of offered) {
			const cap = capability(label);
			// A capability whose truth is declarative (`role`) or proven by a mint
			// succeeding (`mint`) has nothing to execute here. `jit-canary` is the
			// second kind: no standing runner carries it, so there is no binary to
			// probe against — what proves it is the canary workflow itself, a job
			// unservable by every standing runner in the fleet.
			if (cap && cap.verify !== 'probe') continue;
			if (!PROBEABLE.has(label)) {
				pushFinding(
					name,
					'unverifiable-label',
					`${name}: declares "${label}" and nothing can verify it`
				);
				continue;
			}
			// MEASURED capabilities print `ok <number>` meaning "I measured it",
			// not "it passed" — `meetsBar` is the one judge, same as bootcamp's,
			// and `judgeMeasurement` declines to judge an idle-only one that was
			// measured beside a live job.
			const verdict = UNPROBED[label]
				? { proven: false, judged: false, reason: UNPROBED[label] }
				: caps[label]
					? judgeMeasurement(cap, caps[label].ok, caps[label].detail, load[label])
					: { proven: false, judged: true, reason: 'no result' };
			if (!verdict.judged) {
				notJudged.push({ node: name, capability: label, reason: verdict.reason });
				continue;
			}
			const idleMiss = !verdict.proven && measuredIdleOnly(cap) && caps[label]?.ok;
			if (routable(cap) && !idleMiss) {
				verdicts.push({
					node: name,
					capability: label,
					passed: verdict.proven,
					reason: verdict.reason,
				});
			}
			if (!verdict.proven) {
				// An idle MEASUREMENT that missed its bar is asked again below; a
				// tool that failed to run is not a reading heat could explain.
				if (measuredIdleOnly(cap) && caps[label]?.ok) {
					idleMisses.push({ label, cap, first: verdict.reason });
					continue;
				}
				pushFinding(name, 'capability-drift', driftFinding(name, label, verdict.reason));
			}
		}
		if (idleMisses.length) {
			await sleep(SETTLE_MS);
			const again = await run(name, 'measured');
			const caps2 = again === null ? {} : parseCaps(again);
			const load2 = again === null ? {} : parseLoad(again);
			for (const { label, cap, first } of idleMisses) {
				const second = caps2[label]
					? judgeMeasurement(cap, caps2[label].ok, caps2[label].detail, load2[label])
					: { proven: false, judged: false, reason: 'the re-measure returned no result' };
				const both = `${first}; re-measured after ${SETTLE_MS / 1000}s: ${second.reason}`;
				if (!second.judged) notJudged.push({ node: name, capability: label, reason: both });
				else if (second.proven)
					remeasured.push({ node: name, capability: label, first, second: second.reason });
				else pushFinding(name, 'capability-drift', driftFinding(name, label, both));
				if (second.judged && routable(cap)) {
					verdicts.push({ node: name, capability: label, passed: second.proven, reason: both });
				}
			}
		}
		// The dispatcher's own dependency, on every node that could ever mint.
		if (caps.jitconfig && !caps.jitconfig.ok) {
			pushFinding(
				name,
				'jitconfig-unsupported',
				`${name}: Runner.Listener does not accept --jitconfig (${caps.jitconfig.detail}) — ` +
					`the ephemeral dispatcher cannot mint here. It is an UNDOCUMENTED flag, so a ` +
					`runner self-update is the expected way to lose it.`
			);
		}
	})
);

// Probes finish in whatever order the network hands them back, so anything keyed
// on completion order makes two identical runs produce two different reports.
// Emit in MANIFEST order: an audit whose output cannot be diffed against its own
// previous run cannot be used to spot drift, which is the only thing it is for.
// THE REVOCATION STEP. A failed execution of an offered routing label withholds
// it from every routing path on the next tick; a passing one gives it back.
// Written once, after every node answered, so concurrent probes never race on
// the file. A record that cannot be read is NOT overwritten from this run's
// partial view — that would re-grant whatever an unreached node had revoked.
const revocationRead = readRevocations(stateDir());
const revocations = { revoked: [], cleared: [], held: [] };
if (revocationRead.corrupt) {
	pushFinding(
		null,
		'revocation-corrupt',
		`the capability revocation record is unreadable (${revocationRead.why}) — nothing revoked or ` +
			'cleared this run, and every probe-verified label stays withheld fleet-wide until it is repaired'
	);
} else {
	const applied = applyVerdicts(revocationRead.nodes, verdicts, 'capabilities');
	if (applied.revoked.length || applied.cleared.length) writeRevocations(stateDir(), applied.nodes);
	revocations.revoked = applied.revoked;
	revocations.cleared = applied.cleared;
	revocations.held = Object.entries(applied.nodes).flatMap(([node, caps]) =>
		Object.entries(caps).map(([capability, r]) => ({ node, capability, ...r }))
	);
}

findings.sort();
gateFindings.sort((a, b) => (a.reason < b.reason ? -1 : 1));
notJudged.sort((a, b) => (a.node + a.capability < b.node + b.capability ? -1 : 1));
remeasured.sort((a, b) => (a.node + a.capability < b.node + b.capability ? -1 : 1));
unreachable.sort();

// A node a human deliberately powered off is EXPECTED down. Split it out here,
// once, so both the JSON contract and the human output agree — and so the exit
// code below counts only the nodes whose silence is a surprise. The deferral is
// dated, written, and expires; see lib/expected-down.mjs.
const _drains = readDrains();
const expectedDown = unreachable.filter((n) => deferralFor(n, _drains).deferred);
const trulyUnreachable = unreachable.filter((n) => !deferralFor(n, _drains).deferred);
const ordered = nodes.map(([name]) => [name, results[name]]).filter(([, caps]) => caps);

/**
 * The guests, and the labels they DECLARE — reported rather than dropped.
 *
 * A machine that vanishes from a report is a machine nobody can tell was
 * considered. These were not probed and never will be, so the honest line is not
 * "unreachable" (we did not try) and not silence (reads as "not in the fleet"),
 * but the declaration itself, which is the only evidence a guest's label has.
 */
const roleDeclared = Object.fromEntries(guests.map(([name, m]) => [name, m.labels ?? []]));

if (JSON_OUT) {
	out.emit({
		results: Object.fromEntries(ordered),
		// RENAMED (wave 5h lane B), unchanged in SHAPE: a flat string per
		// drift, exactly what this key has always carried. `findings` itself
		// now means `GateDoc`'s structured `{node, kind, reason}[]` below —
		// same rename `check-contract-consumers.mjs` made in wave 5f lane B,
		// for the same reason: `buildGateDoc`'s spread owns that key now.
		legacyFindings: findings,
		unreachable: trulyUnreachable,
		expectedDown,
		roleDeclared,
		// ADDITIVE (wave 4e follow-up, #102): not in scripts/lib/json-contract.mjs,
		// so no cron parses this today, but a new key breaks nothing that does
		// read the ones above it.
		workloadGates: workloadGateResults,
		// ADDITIVE (2026-10-10), same footing as `workloadGates`.
		notJudged,
		// ADDITIVE (#122), same footing.
		remeasured,
		// ADDITIVE (2026-10-25), same footing: what this run revoked or cleared,
		// and every revocation still held after it.
		revocations,
		// GateDoc (wave 5h lane B). A node that could not be reached is "I
		// could not look" — never folded into `findings` — same reasoning
		// `check-warm-canary.mjs` already applies to its own unreachable
		// candidates. `ok` is left to its default: `gateFindings`/this array
		// are 1:1 with `findings.length`/`trulyUnreachable.length`, the exact
		// pair the exit code below already keys on.
		...buildGateDoc({
			findings: gateFindings,
			unreadable: trulyUnreachable.map((node) => ({
				node,
				why: 'could not reach this node to probe its capabilities',
			})),
		}),
	});
} else {
	for (const [name, caps] of ordered) {
		const line = Object.entries(caps)
			.map(([k, v]) => `${k}=${v.ok ? 'ok' : v.detail}`)
			.join('  ');
		out.log(`  ${name.padEnd(8)} ${line}`);
		for (const [id, gate] of Object.entries(workloadGateResults[name] ?? {})) {
			out.log(`    ${id}: ${gate.reason}`);
		}
	}
	for (const n of notJudged) {
		out.log(`  · ${n.node.padEnd(8)} ${n.capability}: ${n.reason}`);
	}
	for (const n of remeasured) {
		out.log(
			`  · ${n.node.padEnd(8)} ${n.capability}: ${n.first}; passed on re-measure: ${n.second}`
		);
	}
	for (const v of revocations.revoked) {
		console.error(
			`  ✗ REVOKED ${v.node} ${v.capability} — withheld from routing until a probe passes (${v.reason})`
		);
	}
	for (const v of revocations.cleared) {
		out.log(`  ✓ cleared ${v.node} ${v.capability} — executed and passed; routable again`);
	}
	for (const h of revocations.held.filter(
		(h) => !revocations.revoked.some((v) => v.node === h.node && v.capability === h.capability)
	)) {
		out.log(`  · still revoked: ${h.node} ${h.capability} since ${h.at} (${h.reason})`);
	}
	for (const u of trulyUnreachable) console.error(`  ! unreachable: ${u}`);
	for (const u of expectedDown)
		out.log(`  · ${deferralNote(u, deferralFor(u, _drains))} — not probed`);
	for (const [name, labels] of Object.entries(roleDeclared)) {
		out.log(
			`  · ${name.padEnd(8)} GUEST — not probed; labels are DECLARED: ` +
				`${labels.join(', ') || '(none)'}`
		);
	}
	if (findings.length) {
		console.error(`\n✗ capability drift (${findings.length}):`);
		for (const f of findings) console.error(`  ${f}`);
	} else if (nodes.length) {
		out.log('\n✓ every declared capability was executed successfully on the node claiming it');
	} else {
		// `--machine <guest> --include-guests` with no other match: nothing was
		// probed, on purpose. Saying the line above here would be exactly the
		// "I did not need to look" rendering as "I looked and it passed" shape —
		// true that nothing is wrong, false that anything was executed.
		out.log('\n✓ no probeable node matched — the guest above is declared, never probed');
	}
}
// Unreachable is NOT a pass. A node we could not probe is a node whose
// promises were not checked. The single exception is one held out of service by
// a dated human decision — it made no promises to check.
process.exit(findings.length || trulyUnreachable.length ? 1 : 0);
