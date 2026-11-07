#!/usr/bin/env node
/**
 * fleet gates — this CLI's command table as data (fleet-manager#67).
 *
 * hadoku_site's `check-gate-coverage` resolves each `fleet <subcommand>` to the
 * script behind it so it can read that script's `@guards`. It did so by
 * regex over dist/cli.js, and when the table moved into cli-commands-*.js
 * (0.34.296) every fleet gate resolved to nothing for ~6.4h behind a
 * misleading "STALE CHECKOUT". This prints the table instead; a consumer
 * reads `fleet gates --json` and never parses this package's build output.
 *
 * The door (`src/cli.ts`) passes its own table as FLEET_DOOR_TABLE, so this
 * file declares nothing: the list is COMMANDS, whatever COMMANDS holds. Run
 * outside the door it refuses rather than guess.
 *
 * `--json` shape (schema 1; a field is only ever ADDED under this number):
 *   { ok: true, schema: 1, package: "@wolffm/fleet-manager", version,
 *     commands: [{ name, script, kind, summary, jsonContract }] }
 * `script` is relative to the package root (`scripts/<file>`). `kind` is
 * gate | converger | recorder | mutator | operator | onboarding | node-side.
 * `jsonContract` is true for a subcommand an mgmt-api cron parses (`--json`).
 *
 *   fleet gates            the gates, one per line
 *   fleet gates --all      every subcommand
 *   fleet gates --json     the whole table as one document
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createEmitter } from './lib/emit.mjs';
import { JSON_CONTRACT } from './lib/json-contract.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HELP = `fleet gates [--all] [--json]

This CLI's own command table: every subcommand, the script behind it (relative
to the package root) and its kind. --json prints all of it as one
document (schema 1), for a consumer that must not parse dist/cli.js.`;

function main(argv = process.argv.slice(2)) {
	const json = argv.includes('--json');
	const out = createEmitter({ json });
	if (argv.includes('--help') || argv.includes('-h')) {
		out.log(HELP);
		return 0;
	}
	const unknown = argv.filter((a) => !['--json', '--all'].includes(a));
	const fail = (code, why) => {
		if (out.json) out.emit({ ok: false, why });
		else process.stderr.write(`fleet gates: ${why}\n`);
		return code;
	};
	if (unknown.length) return fail(2, `unknown argument(s) ${unknown.join(' ')}`);

	let table;
	try {
		table = JSON.parse(process.env.FLEET_DOOR_TABLE ?? '');
	} catch {
		return fail(
			1,
			'FLEET_DOOR_TABLE is unset or unreadable — run this as `fleet gates`, so the door hands over its own table'
		);
	}
	if (!Array.isArray(table) || !table.length)
		return fail(1, 'the door handed over an empty command table');

	const contracted = new Set(JSON_CONTRACT.map((c) => c.sub));
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
	const commands = table
		.map((c) => ({ ...c, script: `scripts/${c.script}`, jsonContract: contracted.has(c.name) }))
		.sort((a, b) => a.name.localeCompare(b.name));

	if (out.json) {
		out.emit({ ok: true, schema: 1, package: pkg.name, version: pkg.version, commands });
		return 0;
	}
	const shown = argv.includes('--all') ? commands : commands.filter((c) => c.kind === 'gate');
	const width = Math.max(...shown.map((c) => c.name.length));
	for (const c of shown) out.log(`${c.name.padEnd(width)}  ${c.script}`);
	return 0;
}

process.exitCode = main();
