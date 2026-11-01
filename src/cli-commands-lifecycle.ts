import type { Command } from './cli-types.js';

export const commandsLifecycle: Record<string, Command> = {
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
		// A converger, not a mutator (plan §3.2 rule 6, verbatim: "cleanup
		// --confirm ... moves to the registry as" one): it reclaims toward a
		// declared shape (no stranded runner self-update debris) rather than
		// performing a one-off operator action. Corrected 2026-10-31 (wave 5e
		// lane D) — job-registry.ts's `ci:claw-cleanup` entry used to carry a
		// `kindDrift` recording this exact disagreement; now there is none.
		kind: 'converger',
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
	// UNDER THE --json CONTRACT since wave 5e lane D: `ci:schedule` parses this
	// stdout daily in repo-sync, LAST, after every other registered job in
	// src/lib/job-registry.ts — it is a fact about all of THEM, so it has to
	// run once the night's schedule has settled.
	'check-schedule': {
		script: 'check-schedule.mjs',
		kind: 'gate',
		summary: 'does the live cron schedule still match job-registry.ts, and can it meet its budgets',
	},
};
