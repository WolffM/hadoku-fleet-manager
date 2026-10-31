import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
	CAPABILITIES,
	capability,
	judgeMeasurement,
	measuredIdleOnly,
	meetsBar,
	type Capability,
} from '../lib/capability-registry.js';
import { eligibilityLabels } from '../lib/capability-labels.js';
import { parseProbeCapabilities } from '../lib/capability-validate.js';
import { BUILDER_LABEL, PM2_HOST_LABEL, BACKSTOP_LABEL } from '../runners/census.js';
import { ROOT } from './capability-fixtures.js';

// ---------------------------------------------------------------------------
// jdk21 — cardtable#5, added 2026-10-05. forge-e2e/forge-jvm move off the
// production host onto claws with room for the JVM; the capability is EARNED
// (like cargo-bevy, av1-nvenc), never declared, and must never widen the
// general pool's REQUIRED SET (the label floor watches it like any demanded label).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// wave 4e (#102) — bootcamp earns the workload, not just the tool
// ---------------------------------------------------------------------------

/**
 * THE PROBE MEASURES; THE REGISTRY JUDGES.
 *
 * These cover `meetsBar`, the single comparator every MEASURED capability goes
 * through. The point of it is that the next payload capability — a bigger JVM
 * build, a GPU transcode, whatever earns a label next — is a registry entry and
 * a probe block that prints a number, not another branch in bootcamp. If this
 * comparator is right once, it is right for all of them.
 */

/**
 * A probe that printed prose where a number was declared has not shown the node
 * can do anything. Reading that as a pass is the same silence this registry
 * refuses everywhere else — and it is the likeliest failure when someone adds
 * the next measured capability and forgets to print the figure.
 */

/** Every declared bar must carry its derivation — a number with no why is a guess. */

// ---------------------------------------------------------------------------
// cargo-bevy — the first measured capability, pinned to the data it came from
// ---------------------------------------------------------------------------

/**
 * THE SEVEN MEASUREMENTS THE BAR WAS DERIVED FROM
 * (`docs/planning/payload-routing-2026-09-14.md` §6, taken 2026-09-14).
 *
 * `proxy` is what `capability-probe.sh`'s cargo-bevy block printed on that node;
 * `buildMinutes` is the cold `cargo build --workspace --locked` of
 * brave-quartet's 12-crate Bevy 0.18 workspace on real disk; `earns` is the
 * routing decision §6 argued for.
 *
 * Kept here rather than only in prose because a bar with no data beside it is
 * re-tunable by anyone who finds it inconvenient. Move the number and this test
 * names which node changed sides.
 */
const CARGO_BEVY_MEASURED = [
	{ node: 'claw-7', proxy: 3528, buildMinutes: 6.9, earns: true },
	{ node: 'claw-4', proxy: 2281, buildMinutes: 10.9, earns: true },
	{ node: 'claw-6', proxy: 1529, buildMinutes: 17.0, earns: true },
	{ node: 'claw-2', proxy: 1521, buildMinutes: 24.0, earns: true },
	{ node: 'claw-1', proxy: 1495, buildMinutes: 18.7, earns: true },
	{ node: 'claw-3', proxy: 923, buildMinutes: 47.0, earns: false },
	{ node: 'claw-5', proxy: 734, buildMinutes: 33.4, earns: false },
] as const;

// ---------------------------------------------------------------------------
// IDLE-ONLY measurements (2026-10-10). claw-4 2281 idle / 1169 beside CI,
// claw-6 1529 / 1024: a throughput figure taken beside a job measures the job.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// pm2-host — IS this box the host (proved since #6, NARROWED in wave 3o), and
// role-honoured on a backstop. "Could it be" is `pm2-capable`, further down.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// pm2-capable — CAN this box host the role, asked apart from whether it IS the
// host (wave 3o, lane C)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------

test('every capability id is unique', () => {
	const ids = CAPABILITIES.map((c) => c.id);
	assert.equal(new Set(ids).size, ids.length);
});

test('exactly one capability is ELIGIBILITY, and it is hadoku-builder', () => {
	// Not style. Every derivation below assumes eligibility is the fast loop's
	// exclusive property; a second one would need fleet-loop.ts to learn about
	// it in the same change, and this is the assertion that says so.
	assert.deepEqual(eligibilityLabels(), ['hadoku-builder']);
	assert.equal(capability('hadoku-builder')?.kind, 'eligibility');
});

test('census re-exports resolve to the registry ids', () => {
	assert.equal(BUILDER_LABEL, 'hadoku-builder');
	assert.equal(PM2_HOST_LABEL, 'pm2-host');
	assert.equal(BACKSTOP_LABEL, 'hokon-backstop');
	for (const id of [BUILDER_LABEL, PM2_HOST_LABEL, BACKSTOP_LABEL]) {
		assert.ok(capability(id), `${id} must be a registry entry`);
	}
});

test('no capability carries a floor flag — what the floor watches is DEMAND (label-floor.ts)', () => {
	// The per-capability `floor` boolean is how `jdk21` and `cargo-bevy` came to
	// be watched by nothing: a standing-only floor could not express a label
	// claws serve by minting, so they were flagged out of it. One rule for every
	// label replaced the flag; a flag reappearing is a second policy beside it.
	for (const c of CAPABILITIES) {
		assert.ok(!Object.hasOwn(c, 'floor'), `${c.id} carries a floor flag again`);
	}
});

test('jdk21 is registered as a differentiator between claws, earned by probe', () => {
	const cap = capability('jdk21');
	assert.ok(cap, 'jdk21 must be registered');
	assert.equal(cap.surface, 'label', 'routable by runs-on, like cargo-bevy/av1-nvenc');
	assert.equal(cap.kind, 'identity');
	assert.equal(cap.verify, 'probe', 'a declaration is a claim; only execution proves it');
	assert.equal(cap.rung, undefined, 'not on the priority ladder');
	assert.equal(cap.mintOnly, undefined, 'not a mint-only label like jit-canary');
});

test('jdk21 declares a WORKLOAD jobProof — inputs, budget, and a regex that compiles', () => {
	const cap = capability('jdk21')!;
	assert.ok(cap.jobProof, 'jdk21 must declare a jobProof');
	assert.equal(cap.jobProof!.repo, 'WolffM/hadoku-cardtable');
	assert.equal(cap.jobProof!.workflow, 'forge.yml');
	assert.equal(cap.jobProof!.job, 'forge-e2e');
	assert.deepEqual(cap.jobProof!.inputs, { only: 'e2e', specs: 'play.spec.ts arrow.spec.ts' });
	assert.deepEqual(cap.jobProof!.budget, { factor: 1.5, minProven: 2 });
	assert.doesNotThrow(() => new RegExp(cap.jobProof!.evidence, 'i'));
	// taskauto keeps its OLD shape exactly — a plain jobProof, no budget, no inputs.
	const taskauto = capability('taskauto')!;
	assert.equal(taskauto.jobProof?.budget, undefined);
	assert.equal(taskauto.jobProof?.inputs, undefined);
});

test('meetsBar: a binary capability still passes on ok alone', () => {
	const cap = capability('gh');
	assert.equal(cap?.measure, undefined, 'gh is binary and must stay that way');
	assert.equal(meetsBar(cap, true, 'gh version 2.46.0').proven, true);
	assert.equal(meetsBar(cap, false, 'absent').proven, false);
});

test('meetsBar: an unknown capability is never proven', () => {
	assert.equal(meetsBar(undefined, true, '999').proven, false);
});

test('meetsBar: a measured capability is judged by the NUMBER, not by ok', () => {
	const cap = {
		id: 'x',
		kind: 'eligibility',
		surface: 'label',
		verify: 'probe',
		label: 'test',
		description: 'test',
		measure: { metric: 'throughput', unit: '/min', atLeast: 100, why: 'test' },
	} as const;
	// `ok` from the probe means "I measured it", not "it passed".
	assert.equal(meetsBar(cap, true, '150').proven, true);
	assert.equal(meetsBar(cap, true, '99').proven, false);
	assert.match(meetsBar(cap, true, '99').reason, /99\/min < 100\/min required/);
});

test('meetsBar: atMost bounds the other direction', () => {
	const cap = {
		id: 'x',
		kind: 'eligibility',
		surface: 'label',
		verify: 'probe',
		label: 'test',
		description: 'test',
		measure: { metric: 'build time', unit: 's', atMost: 600, why: 'test' },
	} as const;
	assert.equal(meetsBar(cap, true, '420').proven, true);
	assert.equal(meetsBar(cap, true, '900').proven, false);
	assert.match(meetsBar(cap, true, '900').reason, /900s > 600s allowed/);
});

test('meetsBar: an unparseable measurement FAILS and says so', () => {
	const cap = {
		id: 'x',
		kind: 'eligibility',
		surface: 'label',
		verify: 'probe',
		description: 'test',
		label: 'test',
		measure: { metric: 'throughput', unit: '/min', atLeast: 10, why: 'test' },
	} as const;
	const v = meetsBar(cap, true, 'looked fine');
	assert.equal(v.proven, false);
	assert.match(v.reason, /not a number/);
});

test('meetsBar: the first number wins, so a probe may print units after it', () => {
	const cap = {
		id: 'x',
		kind: 'eligibility',
		surface: 'label',
		label: 'test',
		description: 'test',
		verify: 'probe',
		measure: { metric: 'throughput', unit: ' crates/min', atLeast: 10, why: 'test' },
	} as const;
	assert.equal(meetsBar(cap, true, '42 crates/min (430 in 612s)').proven, true);
});

test('every measured capability states WHY its bar is that number', () => {
	for (const c of CAPABILITIES) {
		if (!c.measure) continue;
		assert.ok(c.measure.why && c.measure.why.length > 30, `${c.id}'s bar needs a real why`);
		assert.ok(
			typeof c.measure.atLeast === 'number' || typeof c.measure.atMost === 'number',
			`${c.id} declares a measure with no bound`
		);
	}
});

test('cargo-bevy is a LABEL identity capability', () => {
	const cap = capability('cargo-bevy');
	assert.ok(cap, 'cargo-bevy must be registered');
	// Each of these is load-bearing somewhere else:
	//   surface 'label'   — routable by brave-quartet's runs-on at all
	//   kind 'identity'   — `nodeOffer` promotes only identity labels out of the
	//                       bootcamp record; an 'eligibility' one is the tier
	//                       ladder's to write and bootcamp NEVER_WRITTEN would
	//                       skip it entirely
	//   verify 'probe'    — a declaration is a claim, and the whole point here is
	//                       that the box demonstrates the speed
	// (The label floor watches it like every demanded label — label-floor.ts.)
	assert.equal(cap.surface, 'label');
	assert.equal(cap.kind, 'identity');
	assert.equal(cap.verify, 'probe');
	assert.equal(cap.measure?.atLeast, 1200, 'the bar §6 derived');
	assert.equal(cap.measure?.atMost, undefined, 'faster is never worse');
});

test('the bar admits exactly the five nodes the payload measurement says it should', () => {
	const cap = capability('cargo-bevy');
	for (const m of CARGO_BEVY_MEASURED) {
		const v = meetsBar(cap, true, String(m.proxy));
		assert.equal(
			v.proven,
			m.earns,
			`${m.node} measured ${m.proxy} (${m.buildMinutes} min build) and the bar says ` +
				`${v.proven ? 'earns' : 'does not earn'}: ${v.reason}`
		);
	}
	assert.equal(CARGO_BEVY_MEASURED.filter((m) => m.earns).length, 5);
});

test('the bar sits in the empty band, so the proxy inversion cannot flip anybody', () => {
	// §6's two inversions vs the real build: claw-2 (24.0 min) proxies 2% above
	// claw-1 (18.7 min), and claw-5 (33.4 min) proxies below claw-3 (47.0 min).
	// Both are harmless ONLY because the bar has clear air on either side — the
	// nearest earner is 1495 and the nearest refusal 923. A re-tune that lands
	// inside that band is a coin flip deciding where a 40-minute compile goes.
	const bar = capability('cargo-bevy')?.measure?.atLeast ?? 0;
	const lowestEarner = Math.min(...CARGO_BEVY_MEASURED.filter((m) => m.earns).map((m) => m.proxy));
	const highestRefusal = Math.max(
		...CARGO_BEVY_MEASURED.filter((m) => !m.earns).map((m) => m.proxy)
	);
	assert.ok(
		highestRefusal < bar && bar < lowestEarner,
		`${highestRefusal} < ${bar} < ${lowestEarner}`
	);
	// The gap must stay WIDER than the inversion it has to absorb.
	const inversion = 1521 - 1495;
	assert.ok(
		bar - highestRefusal > inversion && lowestEarner - bar > inversion,
		'the bar has less clear air than the proxy has noise'
	);
});

test('an absent rustc reports why, and is never read as a slow node', () => {
	// The probe prints `no no-rustc` / `no compile-failed` rather than `0`. A
	// zero would clear `Number.isFinite` and be judged as a measurement that
	// failed the bar — "this box is slow" — when the truth is that the question
	// was never asked. Different finding, different remedy.
	const cap = capability('cargo-bevy');
	const v = meetsBar(cap, false, 'no-rustc');
	assert.equal(v.proven, false);
	assert.equal(v.reason, 'no-rustc');
	assert.match(meetsBar(cap, true, 'measured-it').reason, /not a number/);
});

test('cargo-bevy is IDLE-ONLY; pm2-capable (installed memory) declares why load cannot move it', () => {
	assert.equal(measuredIdleOnly(capability('cargo-bevy')), true);
	assert.equal(measuredIdleOnly(capability('pm2-capable')), false);
	assert.equal(
		measuredIdleOnly(capability('ffmpeg')),
		false,
		'a binary capability is not measured'
	);
	// THE DEFAULT IS IDLE-ONLY. A new measured capability that says nothing
	// about load must not be judged beside a job by omission.
	const bare: Capability = {
		...(capability('cargo-bevy') as Capability),
		measure: { metric: 'm', unit: 'u', atLeast: 1, why: 'w' },
	};
	assert.equal(measuredIdleOnly(bare), true);
});

test('judgeMeasurement: only a counted ZERO lets an idle-only measurement be judged', () => {
	const cap = capability('cargo-bevy');
	// Idle and below the bar IS a verdict — the node is slow.
	const slowIdle = judgeMeasurement(cap, true, '1024', 0);
	assert.deepEqual(
		{ proven: slowIdle.proven, judged: slowIdle.judged },
		{ proven: false, judged: true }
	);
	assert.match(slowIdle.reason, /1024.* < 1200/);
	assert.equal(judgeMeasurement(cap, true, '2281', 0).proven, true);
	// Busy, or uncounted: neither earned nor failed. Both directions — a busy
	// node can read low (claw-6, 1024) and must not be stripped; a high reading
	// beside a job is not evidence either.
	for (const workers of [1, 3, null, undefined]) {
		for (const [ok, detail] of [
			[true, '1024'],
			[true, '2281'],
			[false, 'compile-failed'],
		] as const) {
			const v = judgeMeasurement(cap, ok, detail, workers);
			assert.equal(v.judged, false, `judged under load (${workers}) for ${detail}`);
			assert.equal(v.proven, false);
			assert.match(v.reason, /measured under load .* not judged/);
		}
	}
	assert.match(judgeMeasurement(cap, true, '1024', 2).reason, /2 live Runner\.Worker/);
	assert.match(judgeMeasurement(cap, true, '1024', null).reason, /count unknown/);
});

test('judgeMeasurement: a load-invariant or binary capability is judged whatever the load', () => {
	const pm2 = judgeMeasurement(capability('pm2-capable'), true, '7849', 4);
	assert.equal(pm2.judged, true);
	assert.equal(pm2.proven, false, 'installed memory below the bar is a verdict even on a busy box');
	const ff = judgeMeasurement(capability('ffmpeg'), true, '7.1.5', null);
	assert.deepEqual({ proven: ff.proven, judged: ff.judged }, { proven: true, judged: true });
});

test('the probe measures EXACTLY the registry’s idle-only set between its markers, each with a LOAD line', () => {
	// The registry says WHICH capabilities are idle-only; the probe says which
	// block bootcamp re-runs on a drained node. A measured capability added to
	// the registry but measured OUTSIDE the markers would be taken beside CI by
	// every bootcamp — and one inside them with no LOAD line would never be
	// judged at all, since an uncounted measurement is unjudged.
	const text = readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8');
	const start = text.indexOf('# >>> IDLE-ONLY MEASUREMENTS');
	const end = text.indexOf('# <<< IDLE-ONLY MEASUREMENTS');
	assert.ok(start > 0 && end > start, 'both markers must exist, in order');
	const section = text.slice(start, end);
	const said = parseProbeCapabilities(section) ?? new Set<string>();
	const idleOnly = new Set(CAPABILITIES.filter(measuredIdleOnly).map((c) => c.id));
	assert.deepEqual([...said].sort(), [...idleOnly].sort());
	for (const id of idleOnly) {
		assert.match(section, new RegExp(`printf 'LOAD ${id} `), `${id} must print its LOAD line`);
	}
	// And the measured phase ENDS at the marker: nothing after it runs on a
	// drained node.
	const after = text.slice(end);
	assert.match(after.slice(0, 200), /CAP_PROBE_PHASE" = measured[\s\S]*exit 0/);
});

test('pm2-host is PROVEN BY EXECUTION, not by somebody typing it', () => {
	// The DECLARED path is retired for every node: `nodeOffer` REPLACES a
	// declared probe-verified label with the proof record, so nothing can type
	// its way into the six workflows that route on this.
	//
	// REVERT `verify` TO 'role' AND THIS FAILS, which is the point: every other
	// assertion in this file is derived from the registry and would quietly
	// follow the entry back.
	const cap = capability('pm2-host');
	assert.ok(cap, 'pm2-host must be registered');
	assert.equal(cap.verify, 'probe');
	assert.equal(cap.surface, 'label');
	assert.equal(cap.kind, 'identity');
	assert.equal(cap.rung, 1, 'and it is still the top rung of the ladder');
	assert.equal(cap.measure, undefined, 'binary: pm2 supervises a process or it does not');
});

test('the probe script really emits pm2-host — a registry claim is not evidence', () => {
	// The drift rule is what turns a `verify: "probe"` nothing executes into a
	// finding, and it reads the script. This reads it too, by name, so the entry
	// above cannot be flipped without the shell block that answers it.
	const emits = parseProbeCapabilities(
		readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8')
	);
	assert.ok(emits?.has('pm2-host'));
});

test('pm2-capable is probed, measured, and NOT a routing label', () => {
	const cap = capability('pm2-capable');
	assert.ok(cap, 'pm2-capable must be registered');
	assert.equal(cap.verify, 'probe', 'a capability is proved by execution or it is a claim');
	assert.equal(cap.kind, 'identity');
	// THE LOAD-BEARING ONE. See the routing test below for what a `label` here
	// would do; this is the same property asserted at the registry, so a flip is
	// caught by the entry as well as by the behaviour.
	assert.equal(cap.surface, 'implicit');
	assert.equal(cap.rung, undefined, 'it is not a rung of the priority ladder — pm2-host is');
	assert.equal(cap.measure?.atLeast, 9784, 'resident-placement §1.6, the ROLE steady figure');
	assert.equal(cap.measure?.unit, 'MiB');
});

test('the bar admits the six claws that can hold the role and refuses the two that cannot', () => {
	// Installed memory, measured on every claw 2026-09-26 (`/proc/meminfo`
	// MemTotal). The bar is `resident-placement-2026-09-10.md` §1.6's steady
	// figure for the ROLE — 9,784 MiB — not its first tenant's footprint.
	const MEASURED = [
		{ node: 'claw-1', memTotalMib: 11885, earns: true },
		{ node: 'claw-2', memTotalMib: 7872, earns: false },
		{ node: 'claw-3', memTotalMib: 15918, earns: true },
		{ node: 'claw-4', memTotalMib: 15936, earns: true },
		{ node: 'claw-5', memTotalMib: 15877, earns: true },
		{ node: 'claw-6', memTotalMib: 7849, earns: false },
		{ node: 'claw-8', memTotalMib: 15915, earns: true },
		{ node: 'claw-9', memTotalMib: 32003, earns: true },
	] as const;
	const cap = capability('pm2-capable');
	for (const m of MEASURED) {
		const v = meetsBar(cap, true, String(m.memTotalMib));
		assert.equal(v.proven, m.earns, `${m.node} measured ${m.memTotalMib} MiB: ${v.reason}`);
	}
	assert.equal(MEASURED.filter((m) => m.earns).length, 6);
	// AND THE REFUSAL SAYS THE NUMBER. "did not earn it" and "has 7,872 MiB
	// against a 9,784 MiB role" are different findings with different remedies —
	// the second one names the RAM stick that would fix it.
	assert.match(meetsBar(cap, true, '7849').reason, /7849MiB < 9784MiB required/);
});

test('a pm2-capable probe that could not run reports WHY, and is never read as a small box', () => {
	// The probe prints a named token — `supervisor-install-failed`,
	// `did-not-survive-supervisor-restart` — rather than `0`. A zero clears
	// `Number.isFinite` and would be judged as a box that is too small, when the
	// truth is that the question was never answered. Same rule the `cargo-bevy`
	// block above states; asserted here because this probe has SIX failure modes
	// and a firewall, a dead dump file and 8 GB of RAM are three different jobs.
	const cap = capability('pm2-capable');
	for (const token of [
		'no-node-runtime-on-stock-path',
		'no-workdir-under-home',
		'supervisor-install-failed',
		'could-not-save-process-list',
		'did-not-survive-supervisor-restart',
		'resurrect-reattached-rather-than-restarted',
	]) {
		const v = meetsBar(cap, false, token);
		assert.equal(v.proven, false);
		assert.equal(v.reason, token, 'the probe’s reason must survive to the report verbatim');
	}
	assert.match(meetsBar(cap, true, 'it-worked').reason, /not a number/);
});

test('the probe script really emits pm2-capable — a registry claim is not evidence', () => {
	const emits = parseProbeCapabilities(
		readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8')
	);
	assert.ok(emits?.has('pm2-capable'));
});

test('the pm2-capable probe provisions under $HOME and leaves no cache behind', () => {
	// READ OFF THE SHIPPED SCRIPT, not off a comment. Two properties, both
	// measured failures elsewhere in this fleet:
	//
	//   1. NOT /tmp. `/tmp` is TMPFS at ~50% of installed on every claw, so a
	//      41 MB npm tree there is 41 MB of RAM taken out of the very headroom
	//      this capability is about — on the node least able to spare it. A probe
	//      that wrote to tmpfs has already faked one capability failure here.
	//   2. THE NPM CACHE IS REDIRECTED. Without `--cache` npm populates `~/.npm`,
	//      which SURVIVES the probe. An install that leaves a cache behind has
	//      persisted, whatever it did with node_modules — and "prove without
	//      persisting" is the whole shape of this capability.
	const text = readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8');
	const block = text.slice(text.indexOf('pm2cap_try() {'));
	assert.ok(block.length > 0, 'the pm2-capable probe function must exist');
	assert.match(block, /mktemp -d "\$HOME\//, 'the work directory must be under $HOME, not /tmp');
	assert.ok(!/mktemp -d\s*\)/.test(block), 'a bare mktemp lands in /tmp');
	assert.match(block, /--cache "\$pc_d/, 'the npm cache must be redirected into the throwaway dir');
	// AND PM2_HOME IS EXPORTED BEFORE ANY pm2 RUNS. `pm2 kill` against the
	// DEFAULT home stops mgmt-api, the tunnel and the other production services on whatever box ran
	// it; the override is the only thing between this probe and that.
	const firstPm2 = block.indexOf('node "$pc_pm2"');
	const exported = block.indexOf('export PM2_HOME=');
	assert.ok(exported > 0 && exported < firstPm2, 'PM2_HOME must be exported before pm2 runs');
});

test('the pm2-host probe never LAUNCHES a daemon to find out whether one is running', () => {
	// `pm2 jlist` starts the God daemon when none is up, so asking the question
	// naively CREATES the footprint the answer is about — and on the production
	// host it would be a second daemon beside the real one. The liveness check is
	// therefore the pid file and the socket, and pm2 is only run after both.
	const text = readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8');
	const block = text.slice(text.indexOf('pm2_host_try() {'), text.indexOf('pm2cap_try() {'));
	const guard = block.indexOf('kill -0 "$ph_pid"');
	const firstRun = block.indexOf('pm2 jlist');
	assert.ok(guard > 0, 'the daemon must be confirmed alive from its own pid file');
	assert.ok(firstRun > guard, 'nothing may run pm2 before that guard');
	assert.match(block, /-S "\$ph_home\/rpc\.sock"/, 'and the socket must exist');
});

test('the pm2-capable probe proves SURVIVAL, not merely that a process started', () => {
	// THE GAP A MUTATION FOUND. Every other assertion in this file survived
	// deleting the `resurrect` step from the probe — so "it survives the
	// supervisor restarting, not merely starting" was a sentence in a comment
	// with nothing behind it, which is the fifth thing CLAUDE.md says gets read
	// as evidence in this codebase.
	//
	// The property matters because a pm2 that cannot write its dump starts
	// everything perfectly and loses the lot the first time the daemon restarts —
	// invisible to a start-only probe, and the exact failure a resident service
	// meets. And the PID MUST CHANGE: `resurrect` returning 0 against a process
	// the kill never reached proves nothing at all.
	const text = readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8');
	const block = text.slice(text.indexOf('pm2cap_try() {'));
	const at = (s: string) => {
		const i = block.indexOf(s);
		assert.ok(i > 0, `the probe must ${s}`);
		return i;
	};
	// IN ORDER. Saving after the kill, or resurrecting before it, would each pass
	// a bare "these four strings are present" check and prove nothing.
	const save = at('node "$pc_pm2" save');
	const kill = at('node "$pc_pm2" kill');
	const resurrect = at('node "$pc_pm2" resurrect');
	assert.ok(save < kill && kill < resurrect, 'save, then kill, then resurrect');
	assert.ok(
		block.indexOf('"$pc_second" != "$pc_first"') > resurrect,
		'the resurrected pid must be compared against the original, after the resurrect'
	);
});
