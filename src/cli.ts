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

import { provenanceLine } from './lib/provenance.js';

/** dist/ -> package root -> scripts/ */
const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

interface Command {
	script: string;
	summary: string;
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
}

/**
 * Subcommand -> script. The names are the operator-facing vocabulary; the
 * filenames are an implementation detail and several are historical.
 */
const COMMANDS: Record<string, Command> = {
	reconcile: {
		script: 'reconcile-fleet-runners.mjs',
		summary: 'converge runner coverage (--confirm to apply)',
	},
	slice: {
		script: 'deploy-runners-slice.mjs',
		summary: 'cgroup slice + memory ceilings (--check)',
	},
	throttle: {
		script: 'deploy-ci-throttle.mjs',
		summary: 'per-node CI concurrency hook (--check)',
	},
	'converge-provisioning': {
		script: 'converge-provisioning.mjs',
		summary:
			'repair drifted throttle env + slice placement on idle runners and claw security upgrades, then re-check',
	},
	'apt-security': {
		script: 'apt-security.mjs',
		summary:
			'will each claw install Debian security updates — RUNS the dry run (--confirm repairs)',
	},
	'reboot-claws': {
		script: 'reboot-claws.mjs',
		help: true,
		summary:
			'reboot ONE claw that needs it: drain, wait idle, reboot, verify kernel + runners, undrain',
	},
	identity: { script: 'reconcile-runner-identity.mjs', summary: 'runner identity/ownership drift' },
	traffic: {
		script: 'traffic-status.mjs',
		help: true,
		summary: 'where the next job would go, and why every other node did not get it',
	},
	drain: {
		script: 'drain-node.mjs',
		help: true,
		summary: 'soft-close a node: no new jobs, current work finishes',
	},
	backstop: {
		script: 'backstop-switch.mjs',
		help: true,
		summary: 'the green light: --force <node> holds it eligible for CI; --status says why not',
	},
	'converge-toolchain': {
		script: 'converge-toolchain.mjs',
		summary: 'check — and with --write, REFRESH — the build toolchain on every node',
	},
	toolpack: {
		script: 'toolpack.mjs',
		help: true,
		summary: 'the instruments a node needs before its measurements are trustworthy',
	},
	scan: {
		script: 'benchmark-fleet.mjs',
		help: true,
		args: ['--scan'],
		summary: 'measure any reachable box, in the fleet or not — nothing is written',
	},
	benchmark: {
		script: 'benchmark-fleet.mjs',
		help: true,
		summary: 'measure every node and put the numbers side by side',
	},
	'benchmark-join': {
		script: 'join-workload-benchmark.mjs',
		help: true,
		summary: 'hardware x job-metrics x job-history — is peak memory the workload or the node',
	},
	stress: {
		script: 'stress-node.sh',
		summary: 'semi-annual wear check: RAM, CPU/thermal, SMART (runs ON the node)',
	},
	capabilities: {
		script: 'check-capabilities.mjs',
		summary: 'probe each node BY EXECUTING the capability',
	},
	'job-metrics': {
		script: 'collect-job-metrics.mjs',
		help: true,
		summary: 'peak memory per job, joined to job history',
	},
	'service-inventory': {
		script: 'service-inventory.mjs',
		summary: 'every RESIDENT workload on this node, measured (--write merges the demand ledger)',
	},
	hosting: {
		script: 'hosting.mjs',
		help: true,
		summary: 'lend a node to a tenant: CI off, declared resources served, agent supervised',
	},
	'node-status': {
		script: 'node-status.mjs',
		help: true,
		summary: 'per node: reachable, health, drains and their notice, hosting — for a tenant to read',
	},
	'drain-check': {
		script: 'check-drain-enforced.mjs',
		help: true,
		summary: 'is every drain actually being enforced',
	},
	'contract-consumers': {
		script: 'check-contract-consumers.mjs',
		help: true,
		summary: 'every --json contract entry names a consumer that exists',
	},
	'runner-units': {
		script: 'check-runner-units.mjs',
		help: true,
		summary: 'standing runner units that name a renamed, archived or off-roster repo',
	},
	'check-runner-var': {
		script: 'check-runner-var.mjs',
		summary: 'every repo asking for vars.CI_RUNNER actually has it',
	},
	'check-site-token': {
		script: 'check-site-token.mjs',
		summary: 'HADOKU_SITE_TOKEN is held only by the repos that need it',
	},
	'egress-slices': {
		script: 'check-egress-slices.mjs',
		summary: 'the cgroup taxonomy the split tunnel routes on — every PM2 app classified',
	},
	bootcamp: {
		script: 'bootcamp.mjs',
		summary: 'a node EARNS its labels — probe, then compare against what it declares',
	},
	'capability-schema': {
		script: 'check-capability-schema.mjs',
		summary: 'the manifest may only claim registered capabilities (offline)',
	},
	toolchain: {
		script: 'check-fleet-toolchain.mjs',
		summary: 'can each node build what its neighbours can',
	},
	// Not under the --json contract: no cron parses it (it spends Actions minutes
	// and races a guest, so it is an operator act). See scripts/prove-job.mjs.
	'prove-job': {
		script: 'prove-job.mjs',
		help: true,
		summary: 'run ONE real workflow job on a named node and read back where it ran',
	},
	'tool-inventory': {
		script: 'check-tool-inventory.mjs',
		summary: 'tools a workflow invokes but a node lacks',
	},
	'floor-probe': {
		script: 'floor-probe.mjs',
		summary: 'the per-node floor for one (repo, job) — and the probes that manufacture it',
	},
	'queue-health': {
		script: 'check-queue-health.mjs',
		summary: 'is the fleet actually SERVING work — queue age, nothing else',
	},
	'label-floor': {
		script: 'check-label-floor.mjs',
		summary: 'every required label has a live runner',
	},
	'warm-canary': {
		script: 'check-warm-canary.mjs',
		help: true,
		summary: 'at least one warm listener is actually held, on an eligible node',
	},
	'fleet-kills': {
		script: 'check-fleet-kills.mjs',
		help: true,
		summary: 'jobs the FLEET stopped at a unit TTL, not jobs that failed',
	},
	'history-coverage': {
		script: 'check-history-coverage.mjs',
		summary: 'is job-history actually recording the runs the fleet served',
	},
	'boundary-contracts': {
		script: 'check-boundary-contracts.mjs',
		summary: 'the REAL shape of every boundary our tests mock (network + ssh)',
	},
	'header-audit': {
		script: 'check-header-fleet.mjs',
		summary: 'the @wolffm consumer contract across every repo',
	},
	source: {
		script: 'fleet-source.mjs',
		summary: "another repo's SHIPPED files: list <owner/repo> [prefix] | read <owner/repo> <path>",
	},
	'identity-model': {
		script: 'check-identity-model.mjs',
		summary: 'per-user storage contract (--fleet for siblings)',
	},
	'tier-fleet': {
		script: 'check-tier-fleet.mjs',
		summary: 'tier vocabulary drift across the fleet',
	},
	'mf-externals': {
		script: 'check-mf-externals.mjs',
		summary: 'module-federation externals alignment',
	},
	'reap-trend': {
		script: 'check-reap-timeout-trend.mjs',
		summary: "is the reap's GET-runners timeout rate CLIMBING (not just what it is today)",
	},
	preflight: {
		script: 'check-fleet-preflight.mjs',
		summary:
			'nightly: node-key expiry, HADOKU_SITE_TOKEN expiry, runner version drift, reboots, LAN reservations',
	},
	'srv-drift': {
		script: 'check-srv-drift.mjs',
		help: true,
		summary: 'the DEPLOYED manifest against the commit it came from, and against main',
	},
	'ci-watch': {
		script: 'ci-watch.mjs',
		summary: 'derive the CI alert watch list from the roster (--write|--check)',
	},
	inventory: {
		script: 'fleet-inventory.mjs',
		summary: "derive the hub's workflow -> runner blast-radius table (--write|--check)",
	},
	enroll: {
		script: 'enroll-node.mjs',
		help: true,
		summary: 'declare a bootstrapped box in the manifest (measured, not typed)',
	},
	'lan-reserve': {
		script: 'lan-reserve.mjs',
		summary: "record a node's gateway DHCP reservation, read off the box (--machine <n> --write)",
	},
	provision: {
		script: 'provision-fleet.mjs',
		summary: 'bring a node up from bare (ordered steps)',
	},
	cleanup: {
		script: 'clean-runner-debris.mjs',
		summary: 'reclaim what runner self-update strands',
	},
	'seed-python': {
		script: 'seed-runner-python.mjs',
		summary: 'seed a usable python onto a runner',
	},
	'seed-cache': {
		script: 'seed-node-cache.mjs',
		help: true,
		summary: 'copy the big caches a fresh node cannot build for itself',
	},
	'mem-report': { script: 'runner-mem-report.py', summary: 'per-runner memory report' },
	'mem-harvest': {
		script: 'runner-mem-harvest.py',
		summary: 'sample runner anon memory (systemd unit)',
	},
	doctor: { script: 'lib/doctor-run.mjs', summary: 'one-shot health triage on a claw' },
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
		summary: 'guided: build the install stick for a new node (start here)',
	},
	'usb-prep': {
		script: 'node-usb-prep.sh',
		summary: 'build the Ventoy + CLAWKIT stick for a new node (interactive)',
	},
	'add-dvd': {
		script: 'add-dvd.sh',
		summary: 'put a full Debian DVD on the stick for a node with no network during install',
	},
	'verify-stick': {
		script: 'verify-stick.sh',
		summary: 'read a built stick back and check it before you carry it anywhere',
	},
	refresh: {
		script: 'refresh-preseed.sh',
		summary:
			'bring a built stick up to date — payload and preseed, no erase (--reset re-asks wifi)',
	},
	telemetry: {
		script: 'read-telemetry.sh',
		summary: 'read what a failed install recorded onto the stick',
	},
	'net-survey': {
		script: 'net-survey.sh',
		summary: 'read the site network: devices, fleet reachability, per-node wifi',
	},
	convert: {
		script: 'convert.sh',
		summary: 'repair then bootstrap, in one step (runs ON the node)',
	},
	'node-bootstrap': {
		script: 'node-bootstrap.sh',
		summary: 'convert an installed OS into a fleet node (runs ON the node)',
	},
	'admin-fix': {
		script: 'fixes/claw-admin-fix.sh',
		summary: 'recover admin access (runs from a USB stick)',
	},
	register: {
		script: 'register-fleet-runner.sh',
		summary: 'register one runner by hand (legacy system unit)',
	},
};

function usage(): void {
	const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
	console.log('fleet <subcommand> [...args]\n');
	for (const [name, c] of Object.entries(COMMANDS)) {
		console.log(`  ${name.padEnd(width)}  ${c.summary}`);
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

if (!name || name === '--help' || name === '-h') {
	usage();
	process.exit(name ? 0 : 1);
}

const cmd = COMMANDS[name];
if (!cmd) {
	console.error(`fleet: unknown subcommand "${name}"\n`);
	usage();
	process.exit(1);
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
	process.exit(0);
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
	process.exit(1);
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
});
child.on('error', (err) => {
	console.error(`fleet: could not run ${cmd.script}: ${err.message}`);
	process.exit(1);
});
// Propagate the child's fate exactly. A gate that exits 1 ON FINDINGS must keep
// exiting 1 through this wrapper, and a signal death must not read as success.
child.on('exit', (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 1);
});
