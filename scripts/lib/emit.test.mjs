/**
 * THE THIRD WAY TO BREAK THE `--json` CONTRACT, FINALLY GATED.
 *
 * `json-contract.mjs` names three, proves two, and says of the third:
 *
 *   "It CANNOT prove (3) [print before the JSON], and does not pretend to:
 *    proving that would mean running each subcommand for real, and of these
 *    five, `reconcile` needs a GitHub token, `toolchain` and `cleanup` need ssh
 *    to four nodes, and `header-audit` and `identity-model` need 25 sibling
 *    checkouts on disk."
 *
 * All true — of a gate that observes BEHAVIOUR. This one observes STRUCTURE
 * instead, and the property it checks is stronger than a single run would give:
 * a contract script contains no code that can write stdout except `emit`, so
 * there is no ordering, no branch and no future debug line that can put a human
 * character in front of the JSON. It holds for every input, including the ones
 * a test could never reach.
 *
 * WHY THIS IS NOT A STYLE RULE. Before the shared emitter, two of the seven
 * contract scripts were correct only by SOURCE ORDER — every `console.log` in
 * them happened to sit below a `process.exit` in the JSON branch. Nothing said
 * so, nothing checked it, and the cost of getting it wrong is not a broken
 * script: the cron parses stdout BEFORE it reads the exit code, deliberately,
 * so a prefixed line converts every genuine fleet finding into "the checker
 * broke" — CLAUDE.md's "'I could not look' must never render as 'nothing is
 * wrong'", one layer down and pointed the other way.
 *
 * `console.error` IS ALLOWED AND USED. stderr is not the contract; several of
 * these print their human findings there on purpose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSON_CONTRACT } from './json-contract.mjs';
import { blankComments } from './blank-comments.mjs';
import { createEmitter, keepStdoutWhole } from './emit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');

/**
 * subcommand -> script, read from the CLI's own table rather than repeated.
 *
 * The table is TypeScript, so this reads the source: a second hand-maintained
 * mapping is the exact failure this repo keeps having, and `json-contract`'s
 * own gate already resolves subcommands the same way.
 */
function scriptFor(sub) {
	const cli = readFileSync(join(SCRIPTS, '..', 'src', 'cli.ts'), 'utf8');
	const key = /^[a-z]+$/.test(sub) ? sub : `'${sub}'`;
	const at = cli.indexOf(`\n\t${key}: {`);
	assert.notEqual(at, -1, `cli.ts declares no subcommand ${sub}`);
	const m = /script: '([^']+)'/.exec(cli.slice(at, at + 400));
	assert.ok(m, `cli.ts entry for ${sub} names no script`);
	return m[1];
}

/** Every way a Node script can put a character on stdout. */
const STDOUT_WRITES = [/\bconsole\.log\s*\(/g, /\bprocess\.stdout\.write\s*\(/g];

for (const { sub, job } of JSON_CONTRACT) {
	test(`${sub} (${job}) writes stdout ONLY through emit()`, () => {
		const file = scriptFor(sub);
		// Comments blanked, or this gate's own prose about `console.log` — and the
		// migration notes now sitting in three of these scripts — score as
		// violations. That has happened twice in this repo already.
		const src = blankComments(readFileSync(join(SCRIPTS, file), 'utf8'));
		const hits = [];
		for (const re of STDOUT_WRITES) {
			for (const m of src.matchAll(re)) {
				hits.push(`${file}:${src.slice(0, m.index).split('\n').length} ${m[0].trim()}`);
			}
		}
		assert.deepEqual(
			hits,
			[],
			`${sub} is parsed as JSON by ${job}. Route these through the shared emitter ` +
				`(lib/emit.mjs): human lines to \`log\`, the payload to \`emit\`.\n  ` +
				hits.join('\n  ')
		);
	});

	test(`${sub} (${job}) actually imports the shared emitter`, () => {
		// Without this the test above passes for a script that prints nothing at
		// all, which is a different bug wearing the same green tick.
		const src = blankComments(readFileSync(join(SCRIPTS, scriptFor(sub)), 'utf8'));
		assert.match(src, /createEmitter/, `${sub} has no emitter — what writes its JSON?`);
	});
}

// ── the emitter's own guarantees ────────────────────────────────────────────

test('in --json mode a human line never reaches stdout', () => {
	const e = createEmitter({ json: true });
	const seen = [];
	const real = console.log;
	console.log = (...a) => seen.push(a.join(' '));
	try {
		e.log('a human sentence');
		e.warn('a human warning');
	} finally {
		console.log = real;
	}
	assert.deepEqual(seen, [], 'the whole point: stdout stays empty until emit()');
	assert.deepEqual(e.held(), ['a human sentence', 'WARN a human warning']);
});

test('a second emit is refused, not appended', () => {
	// Two JSON documents on one stream fail JSON.parse exactly as badly as a
	// human line does, and the cron reads that as its own failure.
	const e = createEmitter({ json: true });
	const real = console.log;
	console.log = () => {};
	try {
		e.emit({ ok: true });
		assert.throws(() => e.emit({ ok: false }), /twice/);
	} finally {
		console.log = real;
	}
});

test('without --json the human lines are printed, not swallowed', () => {
	const e = createEmitter({ json: false });
	const seen = [];
	const real = console.log;
	console.log = (...a) => seen.push(a.join(' '));
	try {
		e.log('visible');
	} finally {
		console.log = real;
	}
	assert.deepEqual(seen, ['visible']);
	assert.deepEqual(e.held(), [], 'nothing is held when nothing is suppressed');
});

// ── the document must ARRIVE, not merely be written (issue #33) ──────────────

/**
 * THE GATE THAT WOULD HAVE CAUGHT THE PIPE CLIFF.
 *
 * Everything above this line reads SOURCE, and `json-contract.test.mjs` runs
 * the real subcommands under a poisoned environment so each fails in under
 * 100ms. Both were right about what they check and both were blind to the same
 * thing: a gate that never produces a large document, and never lets a consumer
 * read it through a PIPE, cannot see stdout being abandoned by `process.exit`.
 *
 * So this one produces one. The fixture is the caller pattern verbatim — build
 * a payload, hand it to the real `emit()`, call `process.exit(0)` on the very
 * next line — and it is read through `spawn` with `stdio: 'pipe'`, which is
 * what `execFile` is and what every mgmt-api consumer uses.
 *
 * NOT A SHELL REDIRECT. `node script > file` makes fd 1 a FILE, and a file was
 * never the problem: Node writes it with `fs.writeSync` and nothing is queued.
 * Redirecting to a file here would have made this test pass against the broken
 * emitter, which is the whole reason the bug survived a gate that ran the CLI
 * for real.
 *
 * 64 KB IS THE FLOOR, NOT THE CLIFF. The measured loss depends on how fast the
 * reader drains: against the pre-fix emitter this same document lost 2,957
 * bytes off the end with a reader attached, and a bare `| wc -c` with no reader
 * keeps only 8,192. That variability is why the payload here is far past any of
 * them — a threshold test would be flaky in the direction of green.
 */
const PAD_BYTES = 256 * 1024;

/** The caller pattern, written to a temp file: emit, then exit on the next line. */
function emitterFixture(dir) {
	const script = join(dir, 'emit-then-exit.mjs');
	writeFileSync(
		script,
		[
			`import { createEmitter } from ${JSON.stringify(join(HERE, 'emit.mjs'))};`,
			'const out = createEmitter({ json: true });',
			`const rows = Array.from({ length: ${PAD_BYTES} / 64 }, (_, i) => ({`,
			'\tnode: `fx-claw-${String(i).padStart(6, "0")}`,',
			'\tdetail: "padding so the document is far past any pipe buffer",',
			'}));',
			'out.emit({ ok: true, rows });',
			'process.exit(0);',
		].join('\n')
	);
	return script;
}

/** Run it and capture stdout through a REAL pipe. Returns the raw bytes. */
function throughAPipe(script, extraEnv = {}) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const child = spawn(process.execPath, [script], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, ...extraEnv },
		});
		child.stdout.on('data', (c) => chunks.push(c));
		child.on('error', reject);
		child.on('exit', (code) => resolve({ code, bytes: Buffer.concat(chunks) }));
	});
}

test('a large payload survives emit() + process.exit() through a REAL pipe', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-emit-pipe-'));
	try {
		const { code, bytes } = await throughAPipe(emitterFixture(dir));
		assert.equal(code, 0, 'the fixture did not exit cleanly');
		assert.ok(
			bytes.length > PAD_BYTES,
			`the padding did not reach 64 KB — this test would prove nothing: ${bytes.length} bytes`
		);
		// The assertion the consumer makes. Against the pre-fix emitter this
		// throws "Unterminated string in JSON at position <n>" — a document that
		// still `startsWith('{')`, so the cron's own check passes and it reports
		// "the checker broke" in place of the fleet's answer.
		const parsed = JSON.parse(bytes.toString('utf8'));
		assert.equal(parsed.ok, true);
		assert.equal(parsed.rows.length, PAD_BYTES / 64);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a pipe and a file receive the SAME bytes — the cliff is the pipe, not the script', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-emit-both-'));
	try {
		const script = emitterFixture(dir);
		const piped = (await throughAPipe(script)).bytes;

		// Into a file, via fd redirection rather than a shell — the same write
		// path `fleet ... --json > out.json` takes.
		const outFile = join(dir, 'out.json');
		const { openSync, closeSync } = await import('node:fs');
		const fd = openSync(outFile, 'w');
		await new Promise((resolve, reject) => {
			const c = spawn(process.execPath, [script], { stdio: ['ignore', fd, 'inherit'] });
			c.on('error', reject);
			c.on('exit', resolve);
		});
		closeSync(fd);

		assert.equal(
			piped.length,
			statSync(outFile).size,
			'the pipe and the file disagree about how long the document is, which means ' +
				'one of them was cut short. The file is the honest length.'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('keepStdoutWhole() vouches for every stdout Node hands a process', () => {
	// Node builds stdout in exactly two shapes: a libuv stream (pipe, socket or
	// TTY — `_handle.setBlocking`) and a file (`fs.SyncWriteStream`, already
	// synchronous). This process's own stdout is one of them, whichever the
	// runner gave it, so a false here means the private field moved and the
	// emitter has silently fallen back to writing fd 1 itself.
	assert.equal(keepStdoutWhole(), true, 'stdout could not be made whole in this process');
	assert.equal(keepStdoutWhole(), true, 'it must be idempotent — every caller calls it blind');
});

/**
 * THE CLASS, not the seven contract scripts.
 *
 * `emit.test.mjs` above holds the JSON_CONTRACT scripts to the emitter, which
 * is a stronger rule than this one and covers them completely. Everything else
 * in `scripts/` that prints a JSON document is outside that contract — `fleet
 * capabilities`, `fleet inventory`, `fleet toolpack`, `fleet traffic` and a
 * dozen more — and every one of them was losing the tail of a large answer the
 * same way, to an operator's `| jq` rather than to a cron. They do not need the
 * emitter's stdout discipline; they DO need fd 1 to be whole before they exit.
 *
 * A grep for the write, then a requirement that the file answers for it. This
 * is the shape `node-identity-guard.test.mjs` uses, for the same reason: the
 * next person to add `console.log(JSON.stringify(...))` gets told, rather than
 * shipping a subcommand that truncates at a size nobody tests at.
 */
/**
 * Files that print a JSON document and do NOT yet answer for fd 1.
 *
 * EMPTY, and the machinery stays. Its one entry was `deploy-runners-slice.mjs`,
 * held open across Wave 3e so lane P's commit was green before lane G converted
 * the file; G landed in the same wave (2c4dc28) and the entry went with it. An
 * exception here is a LANE BOUNDARY rather than a judgement — the next wave that
 * splits one of these files across two lanes needs the same escape hatch, and
 * needs it to be deliberately un-self-expiring, so that the two commits can land
 * in either order.
 *
 * An entry costs nothing to add and hides a real truncation for as long as it
 * survives, so it carries the lane that owns it and comes out with that lane.
 */
const NOT_YET = [];

test('every script that prints a JSON document answers for fd 1', () => {
	const offenders = [];
	for (const file of readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'))) {
		const raw = readFileSync(join(SCRIPTS, file), 'utf8');
		// Comments blanked first. Half of these scripts document their own
		// `--json` output in prose, and this repo has read a COMMENT as evidence
		// three times.
		const src = blankComments(raw);
		const writesJson = src
			.split('\n')
			.some((line, i, all) =>
				/console\.log\(JSON\.stringify|process\.stdout\.write\(\s*JSON\.stringify/.test(line)
					? true
					: /console\.log\($/.test(line.trim()) && /^\s*JSON\.stringify\($/.test(all[i + 1] ?? '')
			);
		if (!writesJson) continue;
		if (/createEmitter|keepStdoutWhole/.test(src)) continue;
		offenders.push(file);
	}

	const excused = new Set(NOT_YET.map((e) => e.file));
	for (const entry of NOT_YET) {
		// The one thing an exception may not do is name a file that is not there:
		// a rename would then excuse nothing and look like it excused something.
		assert.ok(
			existsSync(join(SCRIPTS, entry.file)),
			`NOT_YET names scripts/${entry.file} ("${entry.why}"), which does not exist. ` +
				`An exception for a file nobody can find excuses nothing and hides that it does.`
		);
	}

	assert.deepEqual(
		offenders.filter((f) => !excused.has(f)),
		[],
		`these print a JSON document straight to stdout and then exit, which loses the tail ` +
			`through a pipe (issue #33). Either take the shared emitter (lib/emit.mjs), or call ` +
			`\`keepStdoutWhole()\` from it before the first write:\n  ` +
			offenders.filter((f) => !excused.has(f)).join('\n  ')
	);
});
