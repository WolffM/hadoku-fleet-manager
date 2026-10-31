#!/usr/bin/env node
/**
 * `fleet <subcommand> [...args]` — one door for the whole operator half.
 *
 * 26 scripts do NOT become 26 bin entries. hadoku_site's CLAUDE.md is emphatic
 * about this for `administration.py` and the reasoning carries: one door means
 * one resolvable path, one place to discover what exists, and one thing for
 * `check-gate-coverage` to reason about.
 *
 * Each subcommand SPAWNS its script rather than importing it. That is
 * deliberate:
 *
 *   - Every script parses its own `process.argv`. Spawning hands it exactly the
 *     argv it already expects, so not one of them needed an arg-parsing change.
 *   - EXIT CODES ARE A CONTRACT. mgmt-api cron jobs parse stdout as JSON and
 *     treat a non-zero exit as a FINDING, not a crash. WHICH subcommands owe
 *     that contract, and to which consumer, is declared in
 *     `scripts/lib/json-contract.mjs` and gated by the test beside it — read the
 *     declaration rather than a count in a comment. This comment said "four"
 *     until 2026-08-30 and named none of them; it is FIVE, and `ci:claw-cleanup`
 *     was the one nobody had counted. An in-process import would have to
 *     reconstruct all of that, and `process.exit` inside an imported module
 *     takes the whole CLI with it.
 *   - stdio is inherited, so the `SUMMARY` lines the deployers print — which
 *     their own `--check` parsers read back — pass through untouched.
 *
 * THE PROVENANCE BANNER GOES TO STDERR, ALWAYS, NOT ONLY UNDER `--json`.
 * ---------------------------------------------------------------------
 * Issue #4 asks every subcommand to name which tree and which version answered.
 * "Suppress it under --json" and "always stderr" both satisfy the contract in
 * `scripts/lib/json-contract.mjs`; only the second one CANNOT REGRESS. A flag
 * test is a thing a future subcommand can forget to consult — `--json` is not
 * even spelled the same way everywhere (`benchmark` takes `--due 30 --max 2
 * --write --json`), and a wrapper that decided per-invocation would have to be
 * right about ten different argv shapes forever. Writing to fd 2 unconditionally
 * means this CLI's stdout is EXACTLY the child's stdout for every subcommand,
 * every flag and every input, which is the property the crons actually need:
 * they read stdout and check it starts with `{` BEFORE they look at the exit
 * code. Three of them also glue stderr onto stdout, but only on the failure
 * path and only to grep for `unknown subcommand`, so a `site=` line there is
 * inert.
 *
 * Set `FLEET_NO_BANNER=1` to silence it — for a caller that captures fd 2 and
 * compares it byte for byte, which is the one legitimate reason to care.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { stateDir } from './lib/fleet-paths.js';
import { packageVersion, provenanceLine } from './lib/provenance.js';
import { cliRecorder } from './lib/usage-log.js';

/** dist/ -> package root -> scripts/ */
const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

/**
 * WHAT A SUBCOMMAND *IS* (plan §3.4), orthogonal to which domain it is in:
 *
 *   gate       read-only pass/fail check (observation); most are under the
 *              `--json` contract or `ci:audit-gates`.
 *   converger  brings declared state into alignment; defaults to reporting
 *              only, one flag (`--confirm`/`--write`/`--refresh`) applies it —
 *              the shape plan §3.2 rule 6 names for `reconcile --confirm`,
 *              `toolchain --refresh`. `reboot-claws` is here too even though
 *              its OWN default already acts: the controller runs it on its
 *              own timer as a scheduled repair (`src/claw-reboot.ts`), the
 *              same `scheduled-converger.ts` shape as `hosting-converge` and
 *              `converge-provisioning`.
 *   recorder   writes ONE declared record as its whole job (plan §3.2 rule 6:
 *              "`doctor --write` records a measurement").
 *   mutator    a direct, operator-initiated action that changes real state
 *              by default — reboot ONE claw by hand, drain a node, provision
 *              one from bare. Not a repair loop toward a declared shape.
 *   operator   a read-only report or diagnostic a human runs and reads; no
 *              cron or contract on the other end (unlike a gate).
 *   onboarding builds or verifies install media before a node exists in the
 *              fleet roster at all.
 *   node-side  runs ON the node itself, not from the controller.
 *
 * A JUDGMENT CALL, not a verified classification: several of the 79 entries
 * below could sit in more than one bucket (`toolpack` installs by default
 * under `--confirm` the way a mutator does, but its job is bringing a node's
 * instruments into alignment with what the box IS, so it is filed as a
 * converger). Said here rather than hidden — see the wave 5b closing note for
 * which ones were closest calls.
 */
type Kind = 'gate' | 'converger' | 'recorder' | 'mutator' | 'operator' | 'onboarding' | 'node-side';

interface Command {
	script: string;
	summary: string;
	/** What this subcommand IS — see {@link Kind}. Every entry carries one. */
	kind: Kind;
	/**
	 * Arguments this subcommand always passes, before the operator's own.
	 *
	 * Exists so two subcommands can share one script when they are genuinely the
	 * same work aimed differently — `scan` is `benchmark` pointed at a box that
	 * is not in the roster. The alternative was a second orchestrator with its
	 * own copy of the parser, the renderer and the ssh handling, and this repo
	 * has already paid for a duplicated reader once: isLocalNode had five.
	 */
	args?: string[];
	/**
	 * The script answers `--help` itself, and `cli-help.test.mjs` PROVES it: run
	 * with `--help` in a sandbox where ssh, gh, sudo, apt, npm and systemctl all
	 * fail and record the attempt, it must exit 0, print usage, and call none of
	 * them. Absent, `--help` never reaches the script — see the door below.
	 */
	help?: true;
	/**
	 * Every flag the script reads from its OWN argv; a trailing `=` marks one
	 * that takes a value (`--machine=` accepts `--machine claw-3`). Declared on
	 * each subcommand whose NO-FLAG default changes something, because those
	 * scripts ignore a flag they do not know and fall through to the default:
	 * `fleet bootcamp --dryrun` installs. The door refuses anything else with
	 * exit 2 before running. Flags a script only PASSES to its children are not
	 * listed: converge-provisioning calls its children with `--check`, and
	 * accepting it here would keep its most natural typo live.
	 */
	flags?: string[];
	/**
	 * The door hands this script its own table, as `FLEET_DOOR_COMMANDS` (the
	 * subcommand names, comma-separated). Only the door knows what it serves;
	 * `fleet usage` needs the list to say which doors nobody opened.
	 */
	doorTable?: true;
}

/**
 * Subcommand -> script. The names are the operator-facing vocabulary; the
 * filenames are an implementation detail and several are historical.
 */
const COMMANDS: Record<string, Command> = {
	reconcile: {
		script: 'reconcile-fleet-runners.mjs',
		kind: 'converger',
		summary: 'converge runner coverage (--confirm to apply)',
	},
	slice: {
		script: 'deploy-runners-slice.mjs',
		kind: 'mutator',
		summary: 'cgroup slice + memory ceilings (--check)',
	},
	throttle: {
		script: 'deploy-ci-throttle.mjs',
		kind: 'mutator',
		summary: 'per-node CI concurrency hook (--check)',
	},
	'converge-provisioning': {
		script: 'converge-provisioning.mjs',
		kind: 'converger',
		flags: ['--dry-run', '--json'],
		summary:
			'REPAIRS by default: drifted throttle env + slice placement on idle runners and claw security upgrades, then re-check (--dry-run: report only)',
	},
	'apt-security': {
		script: 'apt-security.mjs',
		kind: 'converger',
		summary:
			'will each claw install Debian security updates — RUNS the dry run (--confirm repairs)',
	},
	'reboot-claws': {
		script: 'reboot-claws.mjs',
		kind: 'converger',
		help: true,
		summary:
			'reboot ONE claw that needs it: drain, wait idle, reboot, verify kernel + runners, undrain',
	},
	identity: {
		script: 'reconcile-runner-identity.mjs',
		kind: 'gate',
		summary: 'runner identity/ownership drift',
	},
	traffic: {
		script: 'traffic-status.mjs',
		kind: 'operator',
		help: true,
		summary: 'where the next job would go, and why every other node did not get it',
	},
	decisions: {
		script: 'fleet-decisions.mjs',
		kind: 'operator',
		help: true,
		summary: 'where past jobs went and why the other nodes refused them (--job|--run|--node)',
	},
	drain: {
		script: 'drain-node.mjs',
		kind: 'mutator',
		help: true,
		summary: 'soft-close a node: no new jobs, current work finishes',
	},
	backstop: {
		script: 'backstop-switch.mjs',
		kind: 'mutator',
		help: true,
		summary: 'the green light: --force <node> holds it eligible for CI; --status says why not',
	},
	'converge-toolchain': {
		script: 'converge-toolchain.mjs',
		kind: 'converger',
		// `--refresh` drains and updates nodes, and `--plan` is what makes it a
		// dry run: a typo of the one must never fall through to the other.
		flags: [
			'--json',
			'--write',
			'--refresh',
			'--plan',
			'--include-guests',
			'--machine=',
			'--budget-min=',
			'--out=',
		],
		summary: 'check — and with --write, REFRESH — the build toolchain on every node',
	},
	toolpack: {
		script: 'toolpack.mjs',
		kind: 'converger',
		help: true,
		summary: 'the instruments a node needs before its measurements are trustworthy',
	},
	scan: {
		script: 'benchmark-fleet.mjs',
		kind: 'operator',
		help: true,
		args: ['--scan'],
		summary: 'measure any reachable box, in the fleet or not — nothing is written',
	},
	benchmark: {
		script: 'benchmark-fleet.mjs',
		kind: 'operator',
		help: true,
		summary: 'measure every node and put the numbers side by side',
	},
	'benchmark-join': {
		script: 'join-workload-benchmark.mjs',
		kind: 'operator',
		help: true,
		summary: 'hardware x job-metrics x job-history — is peak memory the workload or the node',
	},
	stress: {
		script: 'stress-node.sh',
		kind: 'node-side',
		flags: ['--minutes=', '--quick', '--force'],
		summary: 'semi-annual wear check: RAM, CPU/thermal, SMART (runs ON the node)',
	},
	capabilities: {
		script: 'check-capabilities.mjs',
		kind: 'gate',
		summary: 'probe each node BY EXECUTING the capability',
	},
	'job-metrics': {
		script: 'collect-job-metrics.mjs',
		kind: 'operator',
		help: true,
		summary: 'peak memory per job, joined to job history',
	},
	'service-inventory': {
		script: 'service-inventory.mjs',
		kind: 'operator',
		summary:
			'every RESIDENT workload on this node, measured; --slices: every declared hosting slice (--write merges the demand ledger)',
	},
	hosting: {
		script: 'hosting.mjs',
		kind: 'mutator',
		help: true,
		summary: 'lend a node to a tenant: CI off, declared resources served, agent supervised',
	},
	'hosting-offers': {
		script: 'hosting-offers.mjs',
		kind: 'operator',
		summary:
			'what each claw can lend to hosting, measured: memory, cores, disk, link, CI cost, neighbours',
	},
	'hosting-plan': {
		script: 'hosting-plan.mjs',
		kind: 'operator',
		summary:
			"where could a tenant's next slice go: its hosting.json against every claw's offer, ranked with reasons",
	},
	'hosting-demand': {
		script: 'hosting-demand.mjs',
		kind: 'recorder',
		flags: ['--slices', '--release-order', '--json'],
		summary:
			"a tenant's slice count, restated every poll (same N is a no-op); returns the converger's view of it",
	},
	'hosting-converge': {
		script: 'hosting-converge.mjs',
		kind: 'converger',
		flags: ['--dry-run', '--tenant', '--json'],
		summary:
			'ACTS for placement.auto tenants: declares and ends slices through `fleet hosting` to meet demand; plans for the rest (--dry-run: decide only)',
	},
	'hosting-request': {
		script: 'hosting-request.mjs',
		kind: 'gate',
		summary:
			"read an app's hosting.json the way the fleet will: normalized, or every problem with its reason",
	},
	'node-users': {
		script: 'node-users.mjs',
		kind: 'operator',
		summary:
			'per node: who runs CI (the ci role), read from the node — sudo, groups, keys, every runner uid',
	},
	'node-status': {
		script: 'node-status.mjs',
		kind: 'operator',
		help: true,
		summary: 'per node: reachable, health, drains and their notice, hosting — for a tenant to read',
	},
	'drain-check': {
		script: 'check-drain-enforced.mjs',
		kind: 'gate',
		help: true,
		summary: 'is every drain actually being enforced',
	},
	'contract-consumers': {
		script: 'check-contract-consumers.mjs',
		kind: 'gate',
		help: true,
		summary: 'every --json contract entry names a consumer that exists',
	},
	'runner-units': {
		script: 'check-runner-units.mjs',
		kind: 'gate',
		help: true,
		summary: 'standing runner units that name a renamed, archived or off-roster repo',
	},
	'check-runner-var': {
		script: 'check-runner-var.mjs',
		kind: 'gate',
		summary: 'every repo asking for vars.CI_RUNNER actually has it',
	},
	'check-site-token': {
		script: 'check-site-token.mjs',
		kind: 'gate',
		summary: 'HADOKU_SITE_TOKEN is held only by the repos that need it',
	},
	'egress-slices': {
		script: 'check-egress-slices.mjs',
		kind: 'gate',
		summary: 'the cgroup taxonomy the split tunnel routes on — every PM2 app classified',
	},
	bootcamp: {
		script: 'bootcamp.mjs',
		kind: 'converger',
		flags: [
			'--json',
			'--write',
			'--no-push',
			'--prove',
			'--check-only',
			'--machine=',
			'--due=',
			'--idle-wait=',
		],
		summary:
			'a node EARNS its labels — INSTALLS missing tools and seeds artifacts, then probes (--check-only: install nothing)',
	},
	'capability-schema': {
		script: 'check-capability-schema.mjs',
		kind: 'gate',
		summary: 'the manifest may only claim registered capabilities (offline)',
	},
	toolchain: {
		script: 'check-fleet-toolchain.mjs',
		kind: 'gate',
		summary: 'can each node build what its neighbours can',
	},
	// Not under the --json contract: no cron parses it (it spends Actions minutes
	// and races a guest, so it is an operator act). See scripts/prove-job.mjs.
	'prove-job': {
		script: 'prove-job.mjs',
		kind: 'operator',
		help: true,
		summary: 'run ONE real workflow job on a named node and read back where it ran',
	},
	'tool-inventory': {
		script: 'check-tool-inventory.mjs',
		kind: 'gate',
		summary: 'tools a workflow invokes but a node lacks',
	},
	'floor-probe': {
		script: 'floor-probe.mjs',
		kind: 'operator',
		summary: 'the per-node floor for one (repo, job) — and the probes that manufacture it',
	},
	'queue-health': {
		script: 'check-queue-health.mjs',
		kind: 'gate',
		summary: 'is the fleet actually SERVING work — queue age, nothing else',
	},
	'label-floor': {
		script: 'check-label-floor.mjs',
		kind: 'gate',
		summary: 'every required label has a live runner',
	},
	'warm-canary': {
		script: 'check-warm-canary.mjs',
		kind: 'gate',
		help: true,
		summary: 'at least one warm listener is actually held, on an eligible node',
	},
	'fleet-kills': {
		script: 'check-fleet-kills.mjs',
		kind: 'gate',
		help: true,
		summary: 'jobs the FLEET stopped at a unit TTL, not jobs that failed',
	},
	'history-coverage': {
		script: 'check-history-coverage.mjs',
		kind: 'gate',
		summary: 'is job-history actually recording the runs the fleet served',
	},
	'job-rollups': {
		script: 'job-rollups.mjs',
		kind: 'operator',
		help: true,
		summary: 'daily CI rollups per node/repo/job kind, kept a year (read-only)',
	},
	'boundary-contracts': {
		script: 'check-boundary-contracts.mjs',
		kind: 'gate',
		summary: 'the REAL shape of every boundary our tests mock (network + ssh)',
	},
	'header-audit': {
		script: 'check-header-fleet.mjs',
		kind: 'gate',
		summary: 'the @wolffm consumer contract across every repo',
	},
	source: {
		script: 'fleet-source.mjs',
		kind: 'operator',
		summary: "another repo's SHIPPED files: list <owner/repo> [prefix] | read <owner/repo> <path>",
	},
	'identity-model': {
		script: 'check-identity-model.mjs',
		kind: 'gate',
		summary: 'per-user storage contract (--fleet for siblings)',
	},
	'tier-fleet': {
		script: 'check-tier-fleet.mjs',
		kind: 'gate',
		summary: 'tier vocabulary drift across the fleet',
	},
	'mf-externals': {
		script: 'check-mf-externals.mjs',
		kind: 'gate',
		summary: 'module-federation externals alignment',
	},
	'reap-trend': {
		script: 'check-reap-timeout-trend.mjs',
		kind: 'gate',
		summary: "is the reap's GET-runners timeout rate CLIMBING (not just what it is today)",
	},
	preflight: {
		script: 'check-fleet-preflight.mjs',
		kind: 'gate',
		summary:
			'nightly: node-key expiry, HADOKU_SITE_TOKEN expiry, runner version drift, reboots, LAN reservations',
	},
	'srv-drift': {
		script: 'check-srv-drift.mjs',
		kind: 'gate',
		help: true,
		summary: 'the DEPLOYED manifest against the commit it came from, and against main',
	},
	'ci-watch': {
		script: 'ci-watch.mjs',
		kind: 'gate',
		summary: 'derive the CI alert watch list from the roster (--write|--check)',
	},
	inventory: {
		script: 'fleet-inventory.mjs',
		kind: 'gate',
		summary: "derive the hub's workflow -> runner blast-radius table (--write|--check)",
	},
	enroll: {
		script: 'enroll-node.mjs',
		kind: 'mutator',
		help: true,
		summary: 'declare a bootstrapped box in the manifest (measured, not typed)',
	},
	'lan-reserve': {
		script: 'lan-reserve.mjs',
		kind: 'mutator',
		summary: "record a node's gateway DHCP reservation, read off the box (--machine <n> --write)",
	},
	provision: {
		script: 'provision-fleet.mjs',
		kind: 'mutator',
		flags: ['--confirm', '--verify-only', '--no-push', '--address=', '--machine='],
		// Disambiguated 2026-10-29 (wave 5b §D step 4): the old wording — "a dry
		// run unless --confirm, and installs nothing" — read as if --confirm ALSO
		// installed nothing. It does not: --confirm runs `bootcamp --write` plus
		// the seed remedies bootcamp's report calls for (provision-fleet.mjs
		// `bootcampPhase`, ~line 788), which installs. With no --confirm, every
		// step (including bootcamp's own probe) runs dry and nothing is written.
		summary:
			'bring a node up from bare (ordered steps; NO --confirm: dry run, nothing installed; ' +
			'--confirm: RUNS bootcamp --write + seeds missing capabilities, which installs)',
	},
	cleanup: {
		script: 'clean-runner-debris.mjs',
		kind: 'mutator',
		summary: 'reclaim what runner self-update strands',
	},
	'seed-python': {
		script: 'seed-runner-python.mjs',
		kind: 'mutator',
		summary: 'seed a usable python onto a runner',
	},
	'seed-cache': {
		script: 'seed-node-cache.mjs',
		kind: 'mutator',
		help: true,
		summary: 'copy the big caches a fresh node cannot build for itself',
	},
	'mem-report': {
		script: 'runner-mem-report.py',
		kind: 'operator',
		summary: 'per-runner memory report',
	},
	'mem-harvest': {
		script: 'runner-mem-harvest.py',
		kind: 'node-side',
		flags: [],
		summary: 'sample runner anon memory (systemd unit)',
	},
	doctor: {
		script: 'lib/doctor-run.mjs',
		kind: 'recorder',
		summary: 'one-shot health triage on a claw',
	},
	// The READER for the facet `doctor --write` writes, and deliberately not a
	// step inside it: a facet whose only reader is its own writer has no age, so
	// six nodes carried a 15.7-day-old $health record through a fleet that
	// replaced two of its machines and rewrote its thermal rule, with nothing
	// anywhere failing. Probes nothing, writes nothing, asks one question.
	//
	// UNDER THE --json CONTRACT since wave 3p: `ci:health-freshness` parses this
	// stdout daily in repo-sync. Renaming it is therefore a cross-repo change —
	// scripts/lib/json-contract.mjs names the mgmt-api file to fix in the same
	// pass, and the gate beside it fails the build if this key moves.
	'health-freshness': {
		script: 'check-health-freshness.mjs',
		kind: 'gate',
		help: true,
		summary: 'how old is the $health record every placement rule reads',
	},
	// IMAGE and CONVERT, the two onboarding phases before `provision` can pick a
	// node up. See the table in docs/VOCABULARY.md.
	//
	// `onboard` is the front door and the only one an operator should need to
	// remember: it asks for the device, the profile and the key, fetches and
	// checksums the installer, and hands the destructive part to `usb-prep`.
	// The two below it stay reachable because a half-finished stick is refreshed
	// with `usb-prep --skip-ventoy`, and because `node-bootstrap` runs ON the
	// node, where this CLI is not installed.
	onboard: {
		script: 'onboarding.sh',
		kind: 'onboarding',
		summary: 'guided: build the install stick for a new node (start here)',
	},
	'usb-prep': {
		script: 'node-usb-prep.sh',
		kind: 'onboarding',
		summary: 'build the Ventoy + CLAWKIT stick for a new node (interactive)',
	},
	'add-dvd': {
		script: 'add-dvd.sh',
		kind: 'onboarding',
		flags: [],
		summary: 'put a full Debian DVD on the stick for a node with no network during install',
	},
	'verify-stick': {
		script: 'verify-stick.sh',
		kind: 'onboarding',
		summary: 'read a built stick back and check it before you carry it anywhere',
	},
	refresh: {
		script: 'refresh-preseed.sh',
		kind: 'onboarding',
		flags: ['--reset'],
		summary:
			'bring a built stick up to date — payload and preseed, no erase (--reset re-asks wifi)',
	},
	telemetry: {
		script: 'read-telemetry.sh',
		kind: 'onboarding',
		summary: 'read what a failed install recorded onto the stick',
	},
	'net-survey': {
		script: 'net-survey.sh',
		kind: 'onboarding',
		summary: 'read the site network: devices, fleet reachability, per-node wifi',
	},
	convert: {
		script: 'convert.sh',
		kind: 'node-side',
		summary: 'repair then bootstrap, in one step (runs ON the node)',
	},
	'node-bootstrap': {
		script: 'node-bootstrap.sh',
		kind: 'node-side',
		summary: 'convert an installed OS into a fleet node (runs ON the node)',
	},
	'admin-fix': {
		script: 'fixes/claw-admin-fix.sh',
		kind: 'node-side',
		summary: 'recover admin access (runs from a USB stick)',
	},
	register: {
		script: 'register-fleet-runner.sh',
		kind: 'node-side',
		flags: [],
		summary: 'register one runner by hand (legacy system unit)',
	},
	// Reads the invocation log every door below writes (src/lib/usage-log.ts).
	usage: {
		script: 'fleet-usage.mjs',
		kind: 'operator',
		help: true,
		doorTable: true,
		summary:
			'who ran which subcommand and route, from the invocation log — and which nobody did (--since 120d)',
	},
};

// DOMAIN + FLAGS, BOTH READ RATHER THAN RE-DECLARED (plan §3.4, F8 step 2).
// `tsconfig.json` sets no `allowJs` and `include`s only `src/**/*.ts`
// (`rootDir: src`), so this file cannot STATICALLY import a `.mjs` sibling —
// the same restriction `scripts/lib/paths.mjs`'s own header names for why it,
// not the reverse, is the door onto `fleet-paths.ts`. A dynamic `import()`
// whose specifier is a run-time EXPRESSION (not a string literal) is not
// resolved by `tsc` at all, proven with a throwaway `tsconfig` before relying
// on it here: a STATIC `import … from '../scripts/lib/x.mjs'` fails `tsc`
// with TS2307, the dynamic form with a computed path does not. The result is
// cast immediately below rather than left as the implicit `any` that would
// trip the type-aware lint pass's `no-unsafe-*` rules on every use.
interface LayerMapModule {
	matchLayer: (relPath: string) => { layer: string; domain?: string } | undefined;
}
interface ArgvSpec {
	usage: string;
	booleans?: string[];
	valued?: string[];
	positionals?: boolean;
}
interface ArgvSpecsModule {
	ARGV_SPECS: Record<string, ArgvSpec>;
}
interface ArgvLibModule {
	doorFlags: (spec: ArgvSpec) => string[];
	unknownFlags: (flags: string[], argv: string[]) => string[];
}
const { matchLayer } = (await import(join(SCRIPTS, 'lib', 'layer-map.mjs'))) as LayerMapModule;
const { ARGV_SPECS } = (await import(join(SCRIPTS, 'lib', 'argv-specs.mjs'))) as ArgvSpecsModule;
const { doorFlags, unknownFlags } = (await import(
	join(SCRIPTS, 'lib', 'argv.mjs')
)) as ArgvLibModule;

/**
 * `.sh`/`.py` scripts sit outside `layer-map.mjs`'s own stated SCOPE ("`.ts`
 * and `.mjs` files under `src/`, `scripts/`... `.sh`, `.py`... have no ES
 * import graph... to walk"). This is NOT a second copy of that map's
 * judgment — it fills the one gap the map's own header names as deliberately
 * left open: "A `.sh`/`.py` onboarding script is still real lifecycle-domain
 * content — it is just not MEASURED here, because there is no import
 * statement to read." `runner-mem-report.py`/`runner-mem-harvest.py` are not
 * onboarding; filed as `observation` by the same reasoning as their sibling
 * `.ts` telemetry (`job-history`, `job-rollups`) — a judgment call, named
 * here rather than hidden (see the wave 5b closing note).
 */
const UNMEASURED_DOMAIN: Record<string, string> = {
	'onboarding.sh': 'lifecycle',
	'node-usb-prep.sh': 'lifecycle',
	'add-dvd.sh': 'lifecycle',
	'verify-stick.sh': 'lifecycle',
	'refresh-preseed.sh': 'lifecycle',
	'read-telemetry.sh': 'lifecycle',
	'net-survey.sh': 'lifecycle',
	'convert.sh': 'lifecycle',
	'node-bootstrap.sh': 'lifecycle',
	'fixes/claw-admin-fix.sh': 'lifecycle',
	'register-fleet-runner.sh': 'lifecycle',
	'stress-node.sh': 'lifecycle',
	'runner-mem-report.py': 'observation',
	'runner-mem-harvest.py': 'observation',
};

/**
 * `domain` is a `Layer` name (`state`, `access`, `config`, `automation`,
 * `composition`, `surfaces`) for a script outside the `domain` layer, or the
 * domain itself (`lifecycle` | `ci-scheduling` | `tenancy` | `observation`)
 * for one inside it — exactly what `layer-map.mjs` records, read rather than
 * re-decided. THROWS on a script neither the map nor {@link UNMEASURED_DOMAIN}
 * names.
 *
 * Resolved LAZILY — called only from `usage()`, when `fleet --help` actually
 * renders a domain heading, never at startup. Until 2026-10-30 this ran
 * eagerly over every `COMMANDS` entry at import time and threw there, so one
 * new or renamed script missing a layer-map entry broke EVERY subcommand —
 * mgmt-api's crons included, none of which ever render `--help`. That is
 * exactly the shape AGENTS.md warns against: "I could not look" (here, about
 * ONE script's domain) rendering as "nothing works" (every script). The
 * invariant — every command resolves without throwing — still holds; it is
 * enforced by `cli-help.test.mjs` in CI now, not by every production
 * invocation paying for a check only `--help` needs.
 */
function domainFor(script: string): string {
	const entry = matchLayer(`scripts/${script}`);
	if (entry) return entry.domain ?? entry.layer;
	const fallback = UNMEASURED_DOMAIN[script];
	if (fallback) return fallback;
	throw new Error(
		`fleet: no domain for scripts/${script} — neither layer-map.mjs nor the ` +
			`UNMEASURED_DOMAIN fallback in src/cli.ts names one. Add it to one of them.`
	);
}

for (const cmd of Object.values(COMMANDS)) {
	// ONE DECLARATION PER SCRIPT (F8 step 2): a migrated script's spec IS its
	// door flags, read from the same `argv-specs.mjs` the script parses its
	// own argv with — never a hand-kept second copy. A script not yet
	// migrated keeps whatever `flags:` this table already hand-wrote for it
	// (debt in the F8 guard, "not yet strict").
	const spec = ARGV_SPECS[cmd.script];
	if (spec) cmd.flags = doorFlags(spec);
}

/** Fixed display order within a domain — the vocabulary order {@link Kind} documents it in. */
const KIND_ORDER: Kind[] = [
	'gate',
	'converger',
	'recorder',
	'mutator',
	'operator',
	'onboarding',
	'node-side',
];

/**
 * `domainFor` throws on a script no registry names; `--help` must still
 * render every OTHER command's heading, so a lookup miss groups under
 * `(unmapped)` here rather than crashing the whole listing. The missing
 * entry is still a real gap — `cli-help.test.mjs` fails on it in CI — this
 * is only about what runtime does with it once CI already let it through.
 */
function domainOf(c: Command): string {
	try {
		return domainFor(c.script);
	} catch {
		return '(unmapped)';
	}
}

function usage(): void {
	const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
	console.log('fleet <subcommand> [...args]\n');
	// Grouped by domain (plan §3.4), then by kind within it — every command
	// appears under EXACTLY ONE (domain, kind) pair. Domain is resolved HERE,
	// lazily, the only place in production that ever calls domainFor.
	const domains = [...new Set(Object.values(COMMANDS).map(domainOf))].sort();
	for (const domain of domains) {
		console.log(domain);
		const inDomain = Object.entries(COMMANDS).filter(([, c]) => domainOf(c) === domain);
		for (const kind of KIND_ORDER) {
			const rows = inDomain
				.filter(([, c]) => c.kind === kind)
				.sort(([a], [b]) => a.localeCompare(b));
			if (!rows.length) continue;
			console.log(`  ${kind}`);
			for (const [name, c] of rows) {
				console.log(`    ${name.padEnd(width)}  ${c.summary}`);
			}
		}
		console.log('');
	}
	console.log(
		'\nPaths come from the environment, never from arithmetic:\n' +
			'  FLEET_MANIFEST_DIR   manifests + allowlists (default <site>/scripts/admin)\n' +
			'  HADOKU_SITE_ROOT     the hadoku_site checkout (default via REPOS_DIR/git)\n' +
			'  REPOS_DIR            directory holding the sibling checkouts\n' +
			'\nEvery subcommand names which of those actually answered, on STDERR:\n' +
			'  site=<...> manifests=<...> fleet-manager=<version>\n' +
			'  FLEET_NO_BANNER=1    silence it\n'
	);
}

const [name, ...rest] = process.argv.slice(2);

// EVERY EXIT BELOW GOES THROUGH `finish`, which appends one line to the
// invocation log first. It writes nothing to stdout, never throws, and cannot
// change the code it is handed — see src/lib/usage-log.ts.
const record = cliRecorder({
	version: packageVersion,
	stateDir,
	argv: process.argv.slice(2),
	known: (sub) => Object.hasOwn(COMMANDS, sub),
});
type Outcome = Parameters<typeof record>[0]['outcome'];
function finish(outcome: Outcome, code: number): never {
	record({ outcome, exit: code });
	process.exit(code);
}

if (!name || name === '--help' || name === '-h') {
	usage();
	finish('usage', name ? 0 : 1);
}

const cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
if (!cmd) {
	console.error(`fleet: unknown subcommand "${name}"\n`);
	usage();
	finish('unknown-subcommand', 1);
}

// --help NEVER REACHES A SCRIPT THAT HAS NOT PROVEN IT HANDLES IT. Every script
// parses its own argv and most ignore a flag they do not know, so `--help`
// fell through to the default action: on 2026-10-25 `fleet bootcamp --help` ran
// a real bootcamp fleet-wide and installed the JDK on three claws, and `fleet
// reboot-claws --help` rebooted claw-4. The door answers instead, from the
// table, and runs nothing. A script with real usage text opts in with
// `help: true`, which a test holds to the sandbox rule above.
if (!cmd.help && rest.some((a) => a === '--help' || a === '-h')) {
	console.log(`fleet ${name} — ${cmd.summary}`);
	console.log(`\n(no detailed --help for this subcommand; nothing was run)`);
	finish('door-help', 0);
}

// A SUBCOMMAND THAT CHANGES THINGS BY DEFAULT GETS NO UNKNOWN FLAG. See
// `Command.flags`. Checked after --help and before anything runs. The
// algorithm is `unknownFlags` (`scripts/lib/argv.mjs`) — the SAME one a
// migrated script runs against its own argv, read rather than re-written
// here a second time (F8 step 2).
if (cmd.flags) {
	const unknown = unknownFlags(cmd.flags, rest);
	if (unknown.length) {
		const error = `fleet ${name}: unknown flag(s) ${unknown.join(' ')} — nothing was run.`;
		// fleet-manager#27: the door's own refusal must satisfy the `--json`
		// contract exactly like every other finding this CLI prints — ONE
		// document on stdout, never bare stderr prose, so a cron reading stdout
		// for `--json` cannot mistake a refused typo for a crashed checker.
		if (rest.includes('--json')) {
			console.log(JSON.stringify({ ok: false, error }));
		} else {
			console.error(
				`${error}\n` +
					`  This subcommand changes things when run with no flags, so it accepts only: ` +
					`${cmd.flags.length ? cmd.flags.map((f) => (f.endsWith('=') ? `${f.slice(0, -1)} <v>` : f)).join(' ') : '(no flags)'}`
			);
		}
		finish('refused-flags', 2);
	}
}

// WHICH TREE, AND WHICH VERSION. Before the packaging check below, so a
// `fleet` that cannot find its own script still says which install said so —
// "this package is broken" and "you are running the wrong copy of this package"
// look identical without it, and the second is far more common here.
if (process.env.FLEET_NO_BANNER !== '1') process.stderr.write(`${provenanceLine()}\n`);

const target = join(SCRIPTS, cmd.script);
if (!existsSync(target)) {
	// A packaging mistake, not a user error — say so, because "command not
	// found" would read as the operator's fault.
	console.error(
		`fleet: ${cmd.script} is missing from the package at ${target}. ` +
			'This is a packaging bug — check the `files` field.'
	);
	finish('missing-script', 1);
}

const runner = target.endsWith('.py')
	? { cmd: 'python3', argv: [target] }
	: target.endsWith('.sh')
		? { cmd: 'bash', argv: [target] }
		: { cmd: process.execPath, argv: [target] };

// A subcommand may pin arguments of its own — `scan` is `benchmark` in a
// different mode, and pinning the flag here is what lets the two share one
// script instead of one script growing a near-copy of the other.
const child = spawn(runner.cmd, [...runner.argv, ...(cmd.args ?? []), ...rest], {
	stdio: 'inherit',
	...(cmd.doorTable
		? { env: { ...process.env, FLEET_DOOR_COMMANDS: Object.keys(COMMANDS).join(',') } }
		: {}),
});
child.on('error', (err) => {
	console.error(`fleet: could not run ${cmd.script}: ${err.message}`);
	finish('spawn-error', 1);
});
// Propagate the child's fate exactly. A gate that exits 1 ON FINDINGS must keep
// exiting 1 through this wrapper, and a signal death must not read as success.
child.on('exit', (code, signal) => {
	if (signal) {
		record({ outcome: 'ran', exit: null, signal });
		process.kill(process.pid, signal);
	} else finish('ran', code ?? 1);
});
