import type { Command } from './cli-types.js';

export const commandsGates: Record<string, Command> = {
	bootcamp: {
		script: 'bootcamp.mjs',
		kind: 'converger',
		flags: [
			'--json',
			'--write',
			'--site-writer',
			'--no-push',
			'--prove',
			'--check-only',
			'--operator-sudo',
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
	// and mints a runner beside production work, so it is an operator act). See
	// scripts/prove-job.mjs.
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
	failures: {
		script: 'failures.mjs',
		kind: 'operator',
		help: true,
		summary:
			"per-node CI failure rate standardized against the fleet's own rate for the same repo+kind (T3, read-only)",
	},
	stats: {
		script: 'stats.mjs',
		kind: 'operator',
		help: true,
		summary:
			'daily jobs/queue/conclusions, per-repo totals, automation health, capacity share and GitHub budget (T6, read-only)',
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
};
