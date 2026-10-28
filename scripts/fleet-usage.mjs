#!/usr/bin/env node
/**
 * `fleet usage` — which doors does anybody open, and which does nobody.
 *
 * Reads the invocation log the CLI door and the fleet router write
 * (`src/lib/usage-log.ts`, stored by `src/lib/usage-store.ts`) and reports, per
 * subcommand: how many runs in the window, the last one, who called (cron via
 * PM2, an agent, a terminal, ssh), the exit-code mix and the flag names used.
 * Then every COMMANDS entry with ZERO runs in the window, and the same for the
 * routes. It reads one directory on this box and nothing else: no ssh, no
 * GitHub, no manifest.
 *
 * WHAT ZERO MEANS, AND WHAT IT DOES NOT
 * ------------------------------------
 * A zero is a DELETION CANDIDATE, not a verdict. It means nobody came through
 * THIS host's door in the window. It cannot see:
 *   - another box's `fleet` (each host logs to its own state dir);
 *   - a script run directly rather than through the door — `node-bootstrap`,
 *     `convert`, `stress` and the stick tools run ON a node, where the CLI is
 *     not installed, so their zero is structural;
 *   - anything before the log existed (`logStarts` says when that was).
 * So the report is evidence for the §4.2 caller grep, never a replacement.
 *
 * The door passes its own table as FLEET_DOOR_COMMANDS; run outside the door
 * this script cannot know what the door serves, and says so rather than
 * reporting an empty "unused" list.
 *
 *   fleet usage                 # last 120 days, human
 *   fleet usage --since 30d     # or 12h
 *   fleet usage --json
 *
 * Exit 0 with a report; 1 when there is nothing to read (no log on this host,
 * logging off, or no door table) — "I could not look" is never "nobody ran
 * anything"; 2 on a bad argument.
 */
import process from 'node:process';

import { createEmitter } from './lib/emit.mjs';
import { stateDir } from '../dist/lib/fleet-paths.js';
import { FLEET_ROUTES, summariseUsage, usageDir } from '../dist/lib/usage-log.js';
import { readUsage } from '../dist/lib/usage-store.js';

const HELP = `fleet usage [--since <N>d|<N>h] [--json]

  Per subcommand and route: runs in the window, last run, callers, exit codes.
  Then every subcommand and route with ZERO runs — deletion candidates, not
  verdicts: this host only, through the door only.

  --since   window, e.g. 120d (default) or 12h
  --json    one JSON document on stdout

  The log: <state dir>/fleet-usage/usage-YYYY-MM.jsonl (FLEET_USAGE_DIR overrides;
  FLEET_USAGE_DIR=off stops writing it).`;

const DEFAULT_SINCE = '120d';

/** `120d` / `12h` -> milliseconds, or null. */
export function parseSince(v) {
	const m = /^(\d+)([dh])$/.exec(v ?? '');
	if (!m) return null;
	return Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000);
}

function parseArgs(argv) {
	const out = { since: DEFAULT_SINCE, json: false, help: false, bad: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--help' || a === '-h') out.help = true;
		else if (a === '--json') out.json = true;
		else if (a === '--since') out.since = argv[++i];
		else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
		else out.bad = `unknown argument ${a}`;
	}
	if (!out.bad && parseSince(out.since) === null)
		out.bad = `--since takes <N>d or <N>h, got ${JSON.stringify(out.since)}`;
	return out;
}

/** Names packed into lines of about 96 columns. */
function wrap(names) {
	const lines = [];
	let cur = '';
	for (const n of names) {
		if (cur && cur.length + n.length + 2 > 96) {
			lines.push(cur);
			cur = '';
		}
		cur = cur ? `${cur}  ${n}` : n;
	}
	if (cur) lines.push(cur);
	return lines;
}

const mix = (o) =>
	Object.entries(o)
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => `${k}:${n}`)
		.join(' ');

function main(argv = process.argv.slice(2), nowMs = Date.now()) {
	const args = parseArgs(argv);
	const out = createEmitter({ json: args.json && !args.help });
	if (args.help) {
		out.log(HELP);
		return 0;
	}
	const fail = (code, why, extra = {}) => {
		if (out.json) out.emit({ ok: false, why, ...extra });
		else process.stderr.write(`fleet usage: ${why}\n`);
		return code;
	};
	if (args.bad) return fail(2, args.bad);

	const door = process.env.FLEET_DOOR_COMMANDS;
	if (!door)
		return fail(
			1,
			'FLEET_DOOR_COMMANDS is unset — run this as `fleet usage`, so the door can say which ' +
				'subcommands it serves. Without that list an empty "unused" would be a guess.'
		);
	const commands = door.split(',').filter(Boolean);

	const dir = usageDir(stateDir);
	if (!dir) return fail(1, 'the invocation log is switched off here (FLEET_USAGE_DIR=off)');

	const sinceMs = nowMs - parseSince(args.since);
	const read = readUsage(dir, sinceMs);
	if (!read.files.length)
		return fail(1, `no invocation log in ${dir} for the window — nothing to read on this host`, {
			dir,
		});

	const summary = summariseUsage(read.records, { sinceMs, commands, routes: FLEET_ROUTES });
	// The log may be younger than the window. Its first month is all we know.
	const logStarts = read.oldestMonth ? `${read.oldestMonth}-01T00:00:00.000Z` : null;
	const partial = logStarts !== null && Date.parse(logStarts) > sinceMs;

	if (out.json) {
		out.emit({
			ok: true,
			dir,
			window: args.since,
			logStarts,
			partial,
			malformed: read.malformed,
			...summary,
		});
		return 0;
	}

	out.log(`invocation log ${dir}, window ${args.since} (since ${summary.since})`);
	if (partial)
		out.log(`  the log only starts in ${read.oldestMonth}: a zero means zero SINCE THEN`);
	if (read.malformed) out.log(`  ${read.malformed} line(s) did not parse and were skipped`);
	out.log('');
	const w = Math.max(10, ...commands.map((c) => c.length));
	for (const u of summary.commands) {
		out.log(
			`  ${u.sub.padEnd(w)}  ${String(u.count).padStart(6)}  last ${u.lastAt}  ` +
				`callers ${mix(u.callers)}  exit ${mix(u.exits)}`
		);
	}
	if (summary.unknownCommands.length) {
		out.log('\nnames typed at the door that it does not serve:');
		for (const u of summary.unknownCommands)
			out.log(`  ${u.sub.padEnd(w)}  ${String(u.count).padStart(6)}  last ${u.lastAt}`);
	}
	out.log(`\n${summary.unusedCommands.length} subcommand(s) with ZERO runs in the window:`);
	for (const line of wrap(summary.unusedCommands)) out.log(`  ${line}`);
	out.log('\nroutes:');
	for (const r of summary.routes)
		out.log(`  ${r.route.padEnd(36)}  ${String(r.count).padStart(6)}  last ${r.lastAt}`);
	out.log(`${summary.unusedRoutes.length} route(s) with ZERO hits:`);
	for (const r of summary.unusedRoutes) out.log(`  ${r}`);
	out.log(
		'\nZero is a candidate, not a verdict: this host only, through the door only. ' +
			'Grep the callers in all three repos before deleting anything.'
	);
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
