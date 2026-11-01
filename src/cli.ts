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
import type { Kind, Command } from './cli-types.js';
import { commandsFleetOps } from './cli-commands-fleet-ops.js';
import { commandsHosting } from './cli-commands-hosting.js';
import { commandsGates } from './cli-commands-gates.js';
import { commandsLifecycle } from './cli-commands-lifecycle.js';
import { commandsOnboarding } from './cli-commands-onboarding.js';

/** dist/ -> package root -> scripts/ */
const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

/**
 * Subcommand -> script. The names are the operator-facing vocabulary; the
 * filenames are an implementation detail and several are historical.
 *
 * Split by domain into `cli-commands-*.ts` (wave 5s lane C, TypeScript long
 * tail): this table ASSEMBLES them, in the same order they held before the
 * split, plus the one entry (`usage`) that reads this file's own `COMMANDS`
 * and stays here rather than in a domain module.
 */
const COMMANDS: Record<string, Command> = {
	...commandsFleetOps,
	...commandsHosting,
	...commandsGates,
	...commandsLifecycle,
	...commandsOnboarding,
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
