import { blockingFindings, bootcampPointer, doctorFindings } from './doctor.mjs';

// ── the pure decisions, exported so the tests can hold them ─────────────────

/**
 * Days a benchmark stamp stays fresh. The SAME window `ci:fleet-benchmark`
 * enforces nightly (`--due 30`), so the chain and the cron cannot disagree
 * about whether a node is measured — a node the chain marks fresh that the
 * cron still finds due is the 09-21 @here page wearing a different hat.
 */
export const BENCHMARK_DUE_DAYS = 30;

/**
 * Days a `$health` record is fresh enough to skip re-loading the box for 60s.
 * Matches the fleet's two existing freshness conventions (`benchmark --due 30`,
 * `BOOTCAMP_STALE_DAYS` 30) rather than inventing a third.
 */
export const HEALTH_FRESH_DAYS = 30;

/**
 * The three capabilities a fresh node cannot produce for itself, and the seed
 * command each one is the remedy for. The manual record's steps 3-5: bootcamp
 * failed on exactly these, the operator READ the failure and typed the seed.
 *
 * jitconfig IS HERE even though no bootcamp FINDING names it: `ephemeral`
 * waits for it, and a node that has never held a payload has not earned it.
 */
export const SEED_REMEDIES = [
	{
		capability: 'python-toolcache',
		script: 'seed-runner-python.mjs',
		argsFor: (node) => ['--machine', node],
		why: 'actions/setup-python resolves interpreters from /opt/hostedtoolcache; trixie has no published build',
	},
	{
		capability: 'playwright',
		script: 'seed-node-cache.mjs',
		argsFor: (node) => ['--machine', node, '--what', 'playwright'],
		why: 'a 5.2 GB browser cache a fresh box cannot build for itself; e2e-canary carries no install step',
	},
	{
		capability: 'jitconfig',
		script: 'seed-node-cache.mjs',
		argsFor: (node) => ['--machine', node, '--what', 'payload'],
		why: 'the JIT payload every mint hardlinks — ephemeral may not be flipped before it exists',
	},
];

/**
 * Which seeds this node still owes, derived from what bootcamp EARNED — never
 * from parsing a failure message. Earning is the proof; anything not earned
 * gets its remedy run, and the post-seed bootcamp is the judge.
 *
 * @param {string[]|null} earned the node's `earned` set from a bootcamp report
 * @returns {typeof SEED_REMEDIES} the subset whose capability is not earned
 */
export function seedPlan(earned) {
	const have = new Set(earned ?? []);
	return SEED_REMEDIES.filter((r) => !have.has(r.capability));
}

/**
 * THE PAYLOAD ITSELF, not a capability verdict.
 *
 * `jitconfig` passes when ANY Runner.Listener accepts the flag, and
 * capability-probe.sh searches standing installs too — so a node can EARN
 * jitconfig while holding no payload at all (claw-8 did exactly that). The
 * ephemeral flip removes the standing install, leaving nothing to mint from.
 * The flip therefore requires BOTH the earned flag AND the binary.
 */
export const PAYLOAD_PROBE =
	'[ -x "$HOME/.hadoku/jit/payload/bin/Runner.Listener" ] && echo PAYLOAD yes || echo PAYLOAD no';

/**
 * REALIZE THE SLICE — the manual record's step 11, the one hand command
 * `fleet slice --confirm` did not cover. A slice unit file is inert until the
 * manager starts it; the io controller reaches the slice's cgroup only once it
 * exists, and `slice --check`'s io_ctrl reads `cgroup.controllers` off that
 * cgroup. Starting an active slice is a no-op, so this is idempotent.
 */
export const REALIZE_SCRIPT = [
	'export XDG_RUNTIME_DIR="/run/user/$(id -u)"',
	'if systemctl --user is-active --quiet runners.slice 2>/dev/null; then',
	'  echo REALIZE-ALREADY-ACTIVE',
	'else',
	'  systemctl --user start runners.slice && echo REALIZE-STARTED',
	'fi',
	'cg=$(systemctl --user show runners.slice -p ControlGroup --value 2>/dev/null)',
	'echo "REALIZE-CGROUP ${cg:-none}"',
].join('\n');

/** The read-only half, for a dry run. */
export const REALIZE_CHECK =
	'export XDG_RUNTIME_DIR="/run/user/$(id -u)"; ' +
	'systemctl --user is-active --quiet runners.slice 2>/dev/null && echo REALIZE-ALREADY-ACTIVE || echo REALIZE-INACTIVE; ' +
	'cg=$(systemctl --user show runners.slice -p ControlGroup --value 2>/dev/null); ' +
	'echo "REALIZE-CGROUP ${cg:-none}"';

/**
 * May this node's `ephemeral` flag be set? Three answers, each a different
 * job: already on (nothing to do), the flag's precondition missing (a remedy
 * this chain knows), or flip.
 *
 * `entry.ephemeral === true` is checked with strict equality: `ephemeral:
 * false` is not "already on", it is a decision someone made, and the chain's
 * job is to bring it to true only when the preconditions hold.
 */
export function flipDecision({ entry, earned, payloadPresent }) {
	if (entry?.ephemeral === true) return { flip: false, state: 'already' };
	if (!Array.isArray(earned) || !earned.includes('jitconfig'))
		return {
			flip: false,
			state: 'not-earned',
			remedy:
				'bootcamp has not EARNED jitconfig on this node, and the JIT dispatcher cannot mint ' +
				'where it has not. Remedy: `fleet seed-cache --machine <node> --confirm --what payload`, ' +
				'read the seed run above for why the copy failed, then re-run provision — it resumes here.',
		};
	if (!payloadPresent)
		return {
			flip: false,
			state: 'no-payload',
			remedy:
				'jitconfig is earned but the JIT payload binary is absent — the ' +
				'capability probe also accepts a STANDING install, which the ephemeral flip itself ' +
				'removes (claw-8’s trap). Remedy: `fleet seed-cache --machine <node> --confirm ' +
				'--what payload`, then re-run provision.',
		};
	return { flip: true, state: 'flip' };
}

/**
 * What the health step owes, judged from the STORED record — a reader, not a
 * writer: `doctorFindings` re-derives the verdict from the record the way
 * `--from-record` renders it, so this cannot pass by trusting a probe that
 * never ran.
 *
 *   none   fresh record, no blocking findings — the step is DONE; re-running
 *          the chain changes nothing here.
 *   probe  no usable record, a stale one, or one that says unreachable — run
 *          `doctor --write` (60s of load) and let its exit code decide.
 *   fail   a FRESH record carrying BLOCKING findings. Re-probing cannot fix a
 *          finding the record and a probe would agree on; the node needs an
 *          operator, and the findings are the remedy text.
 */
export function healthStep(stored, { capabilities = null, nowMs = Date.now() } = {}) {
	if (!stored || stored.unavailable)
		return {
			action: 'probe',
			why: `no usable $health record (${stored?.unavailable ?? 'nothing stored'}) — nothing has proven this box safe`,
		};
	const rec = stored.value;
	if (!rec || rec.reachable === false)
		return {
			action: 'probe',
			why: 'the stored record says unreachable — stale information, not a verdict',
		};
	const ageDays = (nowMs - Date.parse(rec.at ?? '')) / 86_400_000;
	if (!Number.isFinite(ageDays) || ageDays > HEALTH_FRESH_DAYS)
		return {
			action: 'probe',
			why: Number.isFinite(ageDays)
				? `the record is ${Math.round(ageDays)}d old, past ${HEALTH_FRESH_DAYS}d`
				: 'the record’s timestamp does not parse',
		};
	const blocking = blockingFindings(
		doctorFindings({ ...rec, bootcamp: bootcampPointer(capabilities) })
	);
	if (blocking.length)
		return {
			action: 'fail',
			why: blocking.map((b) => `${b.category}/${b.status}: ${b.why}`).join(' | '),
			blocking,
		};
	return {
		action: 'none',
		why: `record is fresh (${Math.round(ageDays)}d) with no blocking findings`,
	};
}

/**
 * What the benchmark step owes, judged from the SAME report `ci:fleet-benchmark`
 * reads — a reader, not a writer.
 *
 * WHY THIS EXISTS, measured 2026-09-23. The step used to run
 * `benchmark <node> --due 30 --write` and assume `--due` gated it. It does not:
 * `--due` gates the REPORT and the fleet-wide sweep, and a node named
 * POSITIONALLY is measured unconditionally. So an idempotent re-run loaded a
 * node that was not due — claw-9's record was 2.4 days old against a 30-day
 * window, and `--due 30 --report --json` said `due: []` at that very moment.
 *
 * It did not merely waste minutes. The re-measure ran unprivileged, lost
 * `stability.aerCorrectable` against the stored ROOTED record, and
 * `benchmark-fleet`'s degradation guard correctly refused to overwrite a richer
 * record with a poorer one — exit 1, and the chain stopped at step 9 on a
 * healthy, actively-serving node. The guard is right; measuring when nothing
 * was due is the bug.
 *
 *   none     the node is not due — the step is DONE, and a re-run does nothing
 *   measure  the node is due, never measured, or its record is unreadable
 *   fail     the report could not be READ. "I could not look" is never
 *            "nothing is wrong": a step that skipped on an unparseable report
 *            would silently stop measuring the fleet and report green.
 *
 * A NEVER-MEASURED NODE IS DUE by `benchmark`'s own definition ("A node with NO
 * record — no state file, nothing in the manifest — is due"), and an UNREADABLE
 * record lands in `coverage.never`. Both are read here, so neither can be
 * skipped. PARSEABLE STDOUT WINS OVER THE EXIT CODE: the report exits non-zero
 * precisely when a node is never-measured, which is a state this must ACT on,
 * not treat as a broken command.
 *
 * @param {unknown} report parsed `benchmark --due N --report --json`
 * @param {string} node
 */
export function benchmarkStep(report, node) {
	if (!report || typeof report !== 'object')
		return {
			action: 'fail',
			why:
				'the benchmark report did not parse, so whether this node is due is UNKNOWN — ' +
				'skipping on that would stop measuring the fleet and still report green',
		};
	if (!Array.isArray(report.due))
		return {
			action: 'fail',
			why:
				'the benchmark report carries no `due` list (got ' +
				`${JSON.stringify(report.due)}) — that is a report this step could not read, not an ` +
				'empty one',
		};
	const name = (d) => (d && typeof d === 'object' ? d.node : d);
	const due = report.due.map(name);
	const never = (report.coverage?.never ?? []).map(name);
	const stale = (report.coverage?.stale ?? []).map(name);
	if (due.includes(node)) return { action: 'measure', why: 'the node is DUE' };
	if (never.includes(node))
		return {
			action: 'measure',
			why: 'the node has no usable benchmark record (never / unreadable)',
		};
	if (stale.includes(node)) return { action: 'measure', why: 'the stored record is STALE' };
	return {
		action: 'none',
		why: `not due (record within ${BENCHMARK_DUE_DAYS}d, and not never/stale)`,
	};
}

// ── the chain, as data — one order, printed and tested ───────────────────────

/**
 * The onboarding chain, in dependency order. `fleetWide` steps cannot be
 * scoped to one node and still run for the whole manifest — reconcile
 * validates every entry and the coverage check reads the fleet.
 */
export const ONBOARDING_STEPS = [
	{
		id: 'declare',
		kind: 'builtin',
		why: 'measured declaration with DERIVED placement — the four hand edits, automated',
	},
	{
		id: 'converge',
		kind: 'spawn',
		script: 'converge-toolchain.mjs',
		why: 'the package floor; bootcamp earns from what the box can DO',
	},
	{
		id: 'bootcamp',
		kind: 'builtin',
		why: 'probe → seed what it reports → re-probe → record $capabilities on a PASS',
	},
	{
		id: 'placement',
		kind: 'builtin',
		why: 'derived fields + ephemeral, only after jitconfig is EARNED on a seeded payload',
	},
	{
		id: 'register',
		kind: 'spawn',
		script: 'reconcile-fleet-runners.mjs',
		fleetWide: true,
		why: 'validates the manifest; standing registrations are the resident set only',
	},
	{
		id: 'throttle',
		kind: 'spawn',
		script: 'deploy-ci-throttle.mjs',
		why: 'runner .env + the JIT provisioner, which only an ephemeral node receives',
	},
	{
		id: 'slice',
		kind: 'spawn',
		script: 'deploy-runners-slice.mjs',
		why: 'cgroup containment, ceiling from the node’s own MemTotal',
	},
	{
		id: 'realize',
		kind: 'builtin',
		why: 'start runners.slice — io never reaches a slice that was never realized',
	},
	{
		id: 'benchmark',
		kind: 'spawn',
		script: 'benchmark-fleet.mjs',
		why: 'the ci:fleet-benchmark freshness window, so the first night is not a page',
	},
	{
		id: 'health',
		kind: 'builtin',
		why: 'doctor --write, gated on the stored record — the chain ends on the box being safe',
	},
];

/** Steps in dependency order for the whole-fleet converge. `fleetWide` ones cannot be scoped. */
const FLEET_APPLY = [
	{
		name: 'register runners',
		script: 'reconcile-fleet-runners.mjs',
		args: ['--confirm'],
		fleetWide: true,
		why: 'creates the runner directories and units everything below acts on',
	},
	{
		name: 'runner env (throttle hook + tool cache)',
		script: 'deploy-ci-throttle.mjs',
		args: ['--confirm'],
		why: 'writes .env, which needs the directories to exist',
	},
	{
		name: 'cgroup containment + supervision',
		script: 'deploy-runners-slice.mjs',
		args: ['--confirm'],
		why: 'walks units, which registration creates',
	},
	// ── THE SEED PHASE, LAST ──────────────────────────────────────────────────
	//
	// Added 2026-09-08 after claw-7 was converged, gated, green — and BLOCKED.
	// Three capabilities in the toolchain floor need bytes a fresh box cannot
	// produce for itself, and only one of them had a producer:
	//
	//   python-toolcache   fleet seed-python      existed
	//   playwright         (nothing)              a 5.2GB manual rsync
	//   the JIT payload    (nothing)              a 684MB manual rsync
	//
	// So `fleet provision --confirm` would report a converged node that bootcamp
	// then refused, and the remedy lived in an operator's memory. A node is not
	// provisioned until it can do the work.
	//
	// LAST on the WHOLE-FLEET path, because seeding is the only step here that
	// moves gigabytes and needs a healthy PEER, and a failure leaves a node
	// that is wired and bounded but unseeded — recoverable by re-running. On the
	// ONBOARDING path the same seeds run EARLIER (the bootcamp phase), because
	// there the payload must exist before `ephemeral` and `ephemeral` before
	// throttle's provisioner — claw-8's ordering trap.
	{
		name: 'python toolcache',
		script: 'seed-runner-python.mjs',
		args: ['--confirm'],
		why: 'actions/setup-python resolves interpreters from /opt/hostedtoolcache; trixie has no published build',
	},
	{
		name: 'browser + runner caches',
		script: 'seed-node-cache.mjs',
		args: ['--confirm'],
		why: 'playwright must launch a browser and every JIT mint hardlinks the runner payload',
	},
];

export const VERIFY = [
	{ name: 'coverage', script: 'reconcile-fleet-runners.mjs', args: ['--check-coverage'] },
	{ name: 'runner identity', script: 'reconcile-runner-identity.mjs', args: [] },
	{ name: 'throttle + tool cache', script: 'deploy-ci-throttle.mjs', args: ['--check'] },
	{ name: 'slice + supervision', script: 'deploy-runners-slice.mjs', args: ['--check'] },
	// VERIFIED BY EXECUTING THE CAPABILITY, not by checking the copy landed.
	// bootcamp launches a browser and runs an interpreter; a seed step that
	// verified its own rsync would be a writer reading its own artefact.
	// `--check-only` unless --confirm: a dry run must not install (2026-10-25 audit:
	// this row ran a full bootcamp, which installs and seeds, inside the DRY RUN).
	{ name: 'capabilities (bootcamp)', script: 'bootcamp.mjs', args: [], dryArgs: ['--check-only'] },
];

/** A verify step's arguments: its dry-run form unless --confirm (a dry run installs nothing). */
export function verifyStepArgs(step, { confirm }) {
	return confirm ? step.args : (step.dryArgs ?? step.args);
}

/** The onboarding chain's bootcamp probe: `--check-only` unless --confirm, for the same reason. */
export function bootcampProbeArgs(node, { confirm }) {
	return ['--machine', node, '--json', ...(confirm ? [] : ['--check-only'])];
}

/**
 * `JSON.parse`, or `null` with the reason SAID rather than dropped (F6, plan
 * §4.1 — this `catch {}` used to be empty, exactly the shape AGENTS.md's "no
 * lazy shortcuts" warns against).
 *
 * Still returns a bare `null` on failure, not `{ok:false, why}`: its three
 * call sites (`bootcampPhase`'s probe and judge reports, `benchmarkPhase`'s
 * `benchmarkStep(safeJson(rep.text), node)`) are pinned by
 * `onboarding-automation.test.mjs`'s literal-source guard and by
 * `benchmarkStep`'s own `!report` check, neither of which this file owns —
 * changing the return SHAPE here would silently change what both read. The
 * reason is carried to stderr instead, where every one of this file's
 * `run()` calls already prints the child's raw stdout right above it
 * (`captureJson`'s `process.stdout.write(text)`), so an operator reading a
 * failed chain sees both the document AND why it did not parse, never
 * neither.
 */
export function safeJson(text) {
	try {
		return JSON.parse((text ?? '').trim());
	} catch (err) {
		console.error(
			`safeJson: stdout did not parse as JSON (${err instanceof Error ? err.message : String(err)})`
		);
		return null;
	}
}

export { FLEET_APPLY };
