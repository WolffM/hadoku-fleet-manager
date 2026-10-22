/**
 * ONE STDOUT DISCIPLINE FOR EVERY SUBCOMMAND.
 *
 * `--json` is a contract (CLAUDE.md, and `json-contract.mjs` names the seven
 * cron jobs that hold the other end). Every one of those consumers does the
 * same thing: `execFile`, then `if (out.trim().startsWith('{'))` BEFORE it looks
 * at the exit code. So a single stray human line on stdout in `--json` mode
 * turns a real fleet finding into "the checker broke" — silently, in a cron
 * nobody watches until something else is already wrong.
 *
 * `json-contract.mjs` lists three ways to break the contract and states plainly
 * that its gate proves two of them and CANNOT prove the third, "print before
 * the JSON", because proving it would mean running each subcommand for real
 * against tokens, ssh and 25 sibling checkouts. That is true of a gate that
 * inspects behaviour. It is not true of one that inspects STRUCTURE: if the
 * only code that can write stdout is `emit`, and `emit` writes JSON and refuses
 * to write twice, then printing before the JSON stops being a thing a script
 * can do. `emit.test.mjs` is that gate.
 *
 * WHAT THIS REPLACES
 * ------------------
 * Four hand-rolled versions of the same idea, none of them wrong and none of
 * them the same:
 *
 *   bootcamp.mjs                 `(m) => JSON_OUT ? out.push(m) : console.log(m)`
 *   enroll-node.mjs              the same, plus a `warn` with its own ANSI
 *   check-queue-health.mjs       `(...m) => { if (!JSON_OUT) console.log(...m) }`
 *   reconcile-fleet-runners.mjs  the same again
 *
 * plus fifteen scripts with no helper at all, two of which — `check-header-fleet`
 * and `check-identity-model` — are under the contract and rely on nothing but
 * SOURCE ORDER for their correctness: every `console.log` in them happens to sit
 * below a `process.exit` in the JSON branch. That is a true property today and
 * an invariant nobody stated, which is the definition of a trap for the next
 * person to add a debug line.
 *
 * BUFFERED, NOT DROPPED, NOT MIRRORED
 * -----------------------------------
 * In `--json` mode human lines are HELD, and a script may put them in its
 * payload (`held()`) or discard them. They are deliberately NOT written to
 * stderr: two of these consumers capture and log stderr, and quietly doubling
 * the volume of every cron's logs is not a change to make as a side effect of a
 * refactor. If we want that, it is its own decision — see the note in the
 * handoff.
 *
 * AND IT MUST ARRIVE WHOLE (issue #33)
 * -----------------------------------
 * Every consumer reads this CLI through `execFile`, which is a PIPE, and on a
 * pipe `process.stdout` is a libuv stream whose writes are QUEUED. Every caller
 * here writes the document and then calls `process.exit(code)` on the very next
 * line — and `process.exit` does not drain that queue, it abandons it. Measured
 * on this host under Node 22.23.1 and 24.18.0:
 *
 *   node -e 'process.stdout.write("x".repeat(200000)); process.exit(0)' | wc -c
 *     -> 8192          into a file, and without the exit, -> 200000
 *
 * So a gate whose answer grew past a few kilobytes started handing mgmt-api a
 * document cut off mid-string. `JSON.parse` fails "at position 8192", the
 * consumer's `out.trim().startsWith('{')` test still PASSES — it starts with a
 * brace, it just never ends — and the cron reports "the checker broke" in place
 * of the fleet's answer. That is the exact failure the `--json` contract exists
 * to prevent, arriving by a route nothing was watching: not a stray line before
 * the JSON, but the JSON itself going missing from the back.
 *
 * AND IT IS A RACE, WHICH IS WHY IT HID FOR SO LONG. How much survives depends
 * on whether the reader happens to be draining at the instant of the write, so
 * the same document loses a different amount every way you look at it. Measured
 * 2026-09-16, `fleet benchmark --due 0 --report --json` over a 1,200-machine
 * fixture, 149,133 bytes long: 8,192 through `| wc -c`, 146,176 through a
 * `spawn` whose `data` handler was already attached, 149,133 into a file. A
 * consumer that reproduces it once and not twice will conclude it is fixed.
 *
 * THE FIX IS fd 1, NOT THE CALLERS. `keepStdoutWhole()` below puts stdout in
 * BLOCKING mode, so `write` returns only once the kernel has taken every byte
 * and there is nothing left for `process.exit` to discard. A bare
 * `process.exit(n)` after `emit()` is then harmless, which is the property that
 * matters: twenty-odd scripts write that line and none of them should have to
 * know why.
 *
 * WHY NOT DEFER THE EXIT INSTEAD. The obvious shape — take over `process.exit`,
 * remember the code, perform it from the write callback — makes the caller's
 * `process.exit(n)` RETURN. Nine of these scripts spend their exits inside a
 * `fail()` helper (`check-srv-drift`, `check-reap-timeout-trend`,
 * `check-queue-health`, …), whose callers are written as `if (bad) fail(...)`
 * with the rest of the script below. An exit that returns runs that rest, which
 * reaches a second `emit()` and throws "emit() called twice" — trading a
 * truncated document for a crash. Setting `process.exitCode` and letting the
 * loop end has the same defect and also loses the exit code the caller asked
 * for. Blocking the fd changes no control flow at all.
 */

import { writeSync } from 'node:fs';

/** ANSI yellow, matching what enroll-node.mjs already printed for warnings. */
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/** `keepStdoutWhole()` is idempotent and every caller calls it blind. */
let stdoutIsWhole = false;

/**
 * MAKE fd 1 DELIVER EVERYTHING BEFORE `process.exit` CAN THROW IT AWAY.
 *
 * Call it before writing anything a machine will parse. Idempotent, cheap, and
 * safe to call in human mode too — a person's terminal is already synchronous.
 *
 * Node hands a process exactly two shapes of stdout, and this answers for both:
 *
 *   - a libuv stream (a PIPE, a socket, or a TTY): `net.Socket` / `tty.WriteStream`,
 *     writes queued, `_handle.setBlocking(true)` makes them synchronous. This is
 *     the case that was losing documents.
 *   - a FILE (`fleet ... --json > out.json`): `fs.SyncWriteStream`, which has no
 *     libuv handle because it already writes with `fs.writeSync`. Nothing to do,
 *     and measuring it is how we know the cliff is the pipe and not the script.
 *
 * `_handle` is private, so this returns FALSE rather than throwing if a future
 * Node moves it — the caller then writes the document itself with `writeSync`,
 * which is public and cannot short-change us. "I could not look" is not
 * "nothing is wrong", and neither is "I could not flush".
 *
 * @returns {boolean} true when a subsequent `console.log` reaches the kernel
 *   before it returns, so `process.exit` on the next line loses nothing.
 */
export function keepStdoutWhole() {
	if (stdoutIsWhole) return true;
	const stdout = process.stdout;
	const handle = stdout._handle;
	if (handle && typeof handle.setBlocking === 'function') {
		handle.setBlocking(true);
		stdoutIsWhole = true;
	} else if (stdout._type === 'fs') {
		stdoutIsWhole = true;
	}
	return stdoutIsWhole;
}

/**
 * The fallback for a stdout `keepStdoutWhole()` could not vouch for.
 *
 * `fs.writeSync` on a NON-BLOCKING pipe short-writes and raises EAGAIN when the
 * reader is behind, so the loop is the whole point: a partial write that nobody
 * retried is the same lost document by another route. EAGAIN is the only error
 * that means "try again"; anything else is real and is thrown.
 *
 * @param {string} text
 */
function writeAllSync(text) {
	const buf = Buffer.from(text, 'utf8');
	let written = 0;
	while (written < buf.length) {
		try {
			written += writeSync(1, buf, written, buf.length - written);
		} catch (err) {
			if (err.code !== 'EAGAIN') throw err;
		}
	}
}

/**
 * @param {{ json?: boolean, argv?: string[] }} [opts]
 *   `json` wins if given; otherwise `--json` is read from `argv`, which
 *   defaults to the real one. Injectable so the gate can exercise both modes
 *   without spawning a process.
 */
export function createEmitter(opts = {}) {
	// Before a single character is written, and NOT just before `emit()`: the
	// `--help` blocks several of these scripts print through `log()` are
	// kilobytes of prose followed by `process.exit(0)`, and they lose their tail
	// through a pipe for exactly the same reason the JSON did.
	keepStdoutWhole();
	const argv = opts.argv ?? process.argv;
	// `--help` WINS OVER `--json`. Usage text is for a person, and a person who
	// asked for it wants to read it; no consumer in `json-contract.mjs` ever
	// passes `--help`, so nothing machine-readable is at stake. Without this a
	// script whose help block sits above its flag parsing — `benchmark-fleet`
	// does — has a stdout write the emitter cannot route.
	const help = argv.includes('--help') || argv.includes('-h');
	const json = opts.json ?? (argv.includes('--json') && !help);
	/** @type {string[]} */
	const held = [];
	let emitted = false;

	const record = (prefix, parts) => {
		held.push(prefix + parts.map((p) => (typeof p === 'string' ? p : String(p))).join(' '));
	};

	return {
		/** True when stdout belongs to a machine. */
		json,

		/** A human line. Suppressed from stdout in `--json` mode, never lost. */
		log: (...parts) => {
			if (json) record('', parts);
			else console.log(...parts);
		},

		/** A human warning. Same discipline; stderr in human mode, where it belongs. */
		warn: (...parts) => {
			if (json) record('WARN ', parts);
			else console.warn(`${YELLOW}${parts.join(' ')}${RESET}`);
		},

		/**
		 * Everything `log`/`warn` held back, oldest first.
		 *
		 * For the scripts that carry their human output INSIDE the payload —
		 * `bootcamp` and `enroll-node` both do, and it is the right call for a
		 * command whose prose is the actual result.
		 */
		held: () => held.slice(),

		/**
		 * THE ONLY WRITE TO STDOUT IN THIS PACKAGE'S SCRIPTS.
		 *
		 * Refuses a second call rather than appending. Two JSON objects
		 * concatenated on one stream fail `JSON.parse` exactly as badly as a
		 * human line does, and that failure reads to the cron as a broken checker
		 * rather than as a fleet finding — the same lie, one layer down.
		 *
		 * WRITES IT WHOLE, so the `process.exit(code)` the caller puts on the next
		 * line cannot cut it off. See `keepStdoutWhole()` and issue #33.
		 */
		emit: (payload) => {
			if (emitted) {
				throw new Error(
					'emit() called twice: stdout is a single JSON document and a second one ' +
						'makes the first unparseable'
				);
			}
			emitted = true;
			const document = JSON.stringify(payload, null, 2);
			// `keepStdoutWhole()` already ran at construction; this re-asks because
			// its ANSWER is what decides how to write, and a false one must route
			// around the stream rather than be ignored.
			if (keepStdoutWhole()) console.log(document);
			else writeAllSync(`${document}\n`);
		},
	};
}
