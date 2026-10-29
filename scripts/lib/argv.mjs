/**
 * F8 (plan `refactor-plan-2026-10-28.md` §4.1): ONE strict argv parser,
 * shared by every migrated script AND by the door (`src/cli.ts`), which reads
 * the SAME spec (`scripts/lib/argv-specs.mjs`) rather than keeping a
 * hand-copied `flags:` list per script. Extracted from `drain-node.mjs`'s
 * parser — the most demanding of the six first-wave scripts, the only one
 * with both a variadic-feeling single positional AND six valued flags.
 *
 * STRICT means three things, every one of them a memory lesson this repo
 * already paid for:
 *
 *   - An unknown flag is an ERROR (exit 2), not a silent no-op. Before this,
 *     `fleet drain claw-3 --raeson "typo"` ran with no reason at all, because
 *     each script's own `has`/`valueOf` simply never matched the misspelling.
 *   - `--help`/`-h` are answered BEFORE the script does anything else —
 *     `fleet reboot-claws --help` rebooted claw-4 and `fleet bootcamp --help`
 *     installed the JDK on three claws (memory `help-flag-can-execute`)
 *     because each script's own flag check fell through to its default
 *     action on a flag it did not recognize. `--help`/`-h` are therefore
 *     ALWAYS accepted — a script never has to declare them, and a typo in
 *     its own spec can never make them stop working.
 *   - Under `--json`, an argv error is still exactly ONE JSON document on
 *     STDOUT (`{ok:false, error}`), never bare stderr prose — the same
 *     contract every other finding this CLI prints already owes
 *     (CLAUDE.md: "`--json` is a contract").
 */
import process from 'node:process';

/**
 * @typedef {{
 *   usage: string,
 *   booleans?: string[],
 *   valued?: string[],
 *   positionals?: boolean,
 *   nothingDoneText?: string,
 * }} ArgvSpec
 */

/** Accepted for every spec without being declared — see the file header. */
const ALWAYS_BARE = ['--help', '-h'];

/**
 * The door's own `Command.flags` shape (`src/cli.ts`): bare flag names, and a
 * valued flag's name with a trailing `=`. ONE conversion, read by both the
 * door (which never runs {@link parseStrict} itself — it only needs the list
 * to refuse an unknown flag before spawning) and this module.
 *
 * @param {ArgvSpec} spec
 * @returns {string[]}
 */
export function doorFlags(spec) {
	return [...ALWAYS_BARE, ...(spec.booleans ?? []), ...(spec.valued ?? []).map((f) => `${f}=`)];
}

/**
 * Every `-`-prefixed token in `argv` that `flags` (the {@link doorFlags}
 * shape) does not declare. Stops at a literal `--` (everything after is a
 * positional, verbatim); skips the token right after a known VALUED flag
 * given as `--x value` rather than `--x=value`, so the value is never
 * mistaken for a flag of its own.
 *
 * This is the exact algorithm `src/cli.ts` ran inline for `Command.flags`
 * before F8 — extracted here so the door and every migrated script share one
 * copy rather than two that can drift.
 *
 * @param {string[]} flags
 * @param {string[]} argv
 * @returns {string[]}
 */
export function unknownFlags(flags, argv) {
	const bare = new Set(flags.filter((f) => !f.endsWith('=')));
	const valued = new Set(flags.filter((f) => f.endsWith('=')).map((f) => f.slice(0, -1)));
	const unknown = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--') break;
		if (!a.startsWith('-')) continue;
		const nameOnly = a.split('=')[0];
		if (valued.has(nameOnly)) {
			if (!a.includes('=')) i++;
		} else if (!bare.has(a)) unknown.push(a);
	}
	return unknown;
}

/**
 * Parse `argv` against `spec`, STRICT. Never returns on `--help`/`-h` or an
 * unknown flag — both call `process.exit` directly, which is the shape every
 * one of the six scripts already had ("check flags, then act") before this
 * existed; none of them expected a return from that check either.
 *
 * `--json` is read from `spec.booleans` AND `argv` together: a script that
 * never declares `--json` (today, `drain-node.mjs`) must never answer an
 * unrelated error as if it understood the flag — passing `--json` to it is
 * itself an unknown flag, reported the same way as any other typo.
 *
 * @param {ArgvSpec} spec
 * @param {string[]} argv
 * @returns {{
 *   has: (f: string) => boolean,
 *   value: (f: string) => string | null,
 *   positionals: string[],
 *   json: boolean,
 * }}
 */
export function parseStrict(spec, argv) {
	// BEFORE ANYTHING ELSE. See the file header — this is the one check that
	// makes `--help` safe regardless of every other flag or state on disk.
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(spec.usage);
		process.exit(0);
	}

	const flags = doorFlags(spec);
	const unknown = unknownFlags(flags, argv);
	const json = (spec.booleans ?? []).includes('--json') && argv.includes('--json');
	if (unknown.length) {
		// `nothingDoneText` lets a script keep its own pre-existing, more
		// specific phrasing (`reboot-claws.mjs`'s "nothing was touched" predates
		// this module and `scripts/reboot-claws.test.mjs` — not on this F8
		// migration's file list — already asserts on it). Every other script
		// gets the generic default.
		const error = `unknown flag(s) ${unknown.join(' ')} — ${spec.nothingDoneText ?? 'nothing was run'}.`;
		if (json) {
			// One document, on stdout, exit 2 — fleet-manager#27. No local
			// `console.error` prose here: a caller reading stdout for `--json`
			// must see a document whether the run succeeded or was refused at
			// the gate.
			console.log(JSON.stringify({ ok: false, error }));
		} else {
			console.error(`${error}\n${spec.usage}`);
		}
		process.exit(2);
	}

	const valued = new Set(spec.valued ?? []);
	// NAMED AWAY FROM THE SHAPE THE F8 GUARD FORBIDS (`const has = (f) =>
	// args.includes(f)`), on purpose: this function IS the canonical argv
	// reader every migrated script is meant to call INSTEAD of its own copy of
	// that exact shape, so the regex-based guard (which cannot tell "the
	// shared implementation" from "a new duplicate") would otherwise flag its
	// own canonical definition as a violation of itself. Exposed to callers
	// as `has` on the returned object below — only the local identifier
	// changes.
	const flagGiven = (f) => argv.includes(f);
	/** Both spellings: `--x value` and `--x=value`. */
	const value = (f) => {
		const i = argv.indexOf(f);
		if (i !== -1) return argv[i + 1] ?? null;
		const eq = argv.find((a) => a.startsWith(`${f}=`));
		return eq ? eq.slice(f.length + 1) : null;
	};

	const positionals = [];
	if (spec.positionals) {
		for (let i = 0; i < argv.length; i++) {
			const a = argv[i];
			if (a === '--') {
				positionals.push(...argv.slice(i + 1));
				break;
			}
			if (a.startsWith('-')) continue;
			// A valued flag's own value, given as `--x value` rather than
			// `--x=value`, is not a positional — it already belongs to the flag
			// right before it.
			if (i > 0 && valued.has(argv[i - 1])) continue;
			positionals.push(a);
		}
	}

	return { has: flagGiven, value, positionals, json };
}
