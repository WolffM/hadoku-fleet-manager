/**
 * THE BEHAVIOURAL `--json` CONTRACT TEST (plan `refactor-plan-2026-10-28.md`
 * §6.3, wave 5a §B).
 *
 * `json-contract.test.mjs` proves the DECLARATION — every entry of
 * `JSON_CONTRACT` names a real subcommand that binds `--json` and has a branch
 * that emits one. That is a STRUCTURAL check, and it passed for months while
 * `check-fleet-toolchain.mjs`'s own catch around a thrown probe printed to
 * stderr and exited with EMPTY stdout (fixed in 066905a): the structure was
 * there, the BEHAVIOUR on that one failure path was not.
 *
 * This file runs the REAL thing: every `JSON_CONTRACT` entry, through the real
 * built door (`dist/cli.js`, the way mgmt-api invokes it), in three hermetic
 * environments chosen to be the shapes a cron can actually hand a subcommand
 * by accident —
 *
 *   (a) an extra, unrecognised flag appended to the consumer's own argv (a
 *       typo, or drift between this list and a renamed flag)
 *   (b) a manifest directory that EXISTS but declares nothing — `{"machines":
 *       {}}` — the "I could not look" shape CLAUDE.md names: a directory that
 *       resolves to an empty manifest must not read as a healthy fleet of zero
 *       machines, and it must not CRASH either
 *   (c) a manifest whose only node is unreachable (`node-a.invalid`, which
 *       ssh fails on in milliseconds via `Could not resolve hostname` — no
 *       real network wait, no real box)
 *
 * and asserts the one property every `JSON_CONTRACT` consumer actually relies
 * on: stdout is EXACTLY one JSON document, and when the run fails, that
 * document says why. A caller doing `execFile` + `out.trim().startsWith('{')`
 * cannot tell "the fleet has a real problem" from "the checker crashed" any
 * other way.
 *
 * WHAT "SAYS WHY" MEANS HERE. Every contracted subcommand has a DIFFERENT
 * JSON shape by design (`ok`, `error`, `why`, `reason`, a `results[].error`,
 * a `findings[]`) — `json-contract.mjs` is explicit that there is no single
 * promised top-level schema across the ten-odd consumers. So
 * {@link explainsFailure} walks the WHOLE document rather than only its top
 * level: it is satisfied by a top-level `ok: false`, or by an `error` / `why`
 * / `reason` STRING anywhere in the tree (`cleanup`'s per-machine
 * `results[].error` included). What it refuses is silence — an empty
 * document, a crash, or a result with no explanatory field anywhere.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. Sixteen of the entry/case
 * combinations below fail this proof today — real bugs, each filed as a
 * public fleet-manager issue and recorded in {@link KNOWN_BROKEN} — and this
 * file does NOT fix any of them; §B's brief is explicit that fixing them is
 * out of scope. What it buys is the thing `json-contract.test.mjs` could not:
 * `--json` holding under BEHAVIOUR, not merely under grep, and a build that
 * cannot silently regress past ANY of these sixteen already-known gaps
 * without this file noticing, nor silently grow a seventeenth without a human
 * triaging it into `KNOWN_BROKEN` first.
 *
 * STILL HERMETIC. No real node, no GitHub credential, no mutation: `HOME` and
 * `HADOKU_STATE_DIR` are fresh temp directories per run, `HADOKU_SITE_ROOT`
 * and `REPOS_DIR` point at `/nonexistent` (both resolvers throw loudly on a
 * missing directory — see `src/lib/fleet-paths.ts` — which is itself part of
 * what this file is proving holds under `--json`), `GH_TOKEN`/`GITHUB_TOKEN`
 * are cleared, and the environment is built from an explicit allow-list
 * rather than `{...process.env}`, so nothing token-shaped (an npm read token,
 * an ssh-agent socket) crosses into a child by accident. `node-a.invalid` is
 * a reserved TLD (RFC 2606): ssh fails on hostname resolution alone, in
 * milliseconds, never reaching a socket.
 *
 * STDOUT IS CAPTURED TO A FILE, never a pipe — `json-contract.test.mjs`'s own
 * note on issue #33: `process.exit` abandons whatever a PIPE still had queued
 * past 8KB, and a file never loses a byte. This file's documents are all
 * small, but reading through a pipe here would silently reintroduce the exact
 * class of false failure #33 exists to rule out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { JSON_CONTRACT } from './json-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));
const BUILT_CLI = join(ROOT, 'dist', 'cli.js');
const FIXTURES = join(HERE, 'fixtures', 'contract');

/** A floor, not the count — see json-contract.test.mjs's identical note. */
const MIN_ENTRIES = 15;

const REACHABLE_MANIFEST = JSON.parse(
	readFileSync(join(FIXTURES, 'manifest-one-unreachable-node.json'), 'utf8')
);
const EMPTY_MANIFEST = JSON.parse(readFileSync(join(FIXTURES, 'manifest-empty.json'), 'utf8'));

const UNKNOWN_FLAG = '--zz-unknown-flag-for-contract-test';
const PER_RUN_TIMEOUT_MS = 60_000;

/** A fresh directory holding exactly one `fleet-runner-manifest.json`. */
function manifestDirFor(manifestObj) {
	const dir = mkdtempSync(join(tmpdir(), 'contract-fx-'));
	writeFileSync(join(dir, 'fleet-runner-manifest.json'), JSON.stringify(manifestObj));
	return dir;
}

/**
 * The three hermetic cases §B asks for, built fresh per call so concurrent
 * runs of the SAME entry never share a manifest directory or state dir.
 */
function casesFor(entry) {
	return [
		{
			name: 'a-unknown-flag',
			argv: [entry.sub, ...entry.argv, UNKNOWN_FLAG],
			manifestDir: manifestDirFor(REACHABLE_MANIFEST),
		},
		{
			name: 'b-empty-manifest',
			argv: [entry.sub, ...entry.argv],
			manifestDir: manifestDirFor(EMPTY_MANIFEST),
		},
		{
			name: 'c-unreachable-node',
			argv: [entry.sub, ...entry.argv],
			manifestDir: manifestDirFor(REACHABLE_MANIFEST),
		},
	];
}

/**
 * Built from an explicit allow-list, NOT `{...process.env}` — see the file
 * header. `PATH` is real (the subcommand may shell out to a real `ssh`/`gh`
 * binary; only the credentials and the destination are poisoned).
 */
function hermeticEnv(manifestDir) {
	const env = {
		PATH: process.env.PATH ?? '',
		HOME: mkdtempSync(join(tmpdir(), 'contract-home-')),
		HADOKU_STATE_DIR: mkdtempSync(join(tmpdir(), 'contract-state-')),
		HADOKU_SITE_ROOT: '/nonexistent',
		REPOS_DIR: '/nonexistent',
		FLEET_MANIFEST_DIR: manifestDir,
		FLEET_NO_BANNER: '1',
		GH_TOKEN: '',
		GITHUB_TOKEN: '',
	};
	// Locale only, never credentials — a child with no LANG at all still runs,
	// this just keeps output encoding predictable across hosts.
	if (process.env.LANG) env.LANG = process.env.LANG;
	return env;
}

/**
 * Runs one subcommand through the real built door. stdout goes to a FILE
 * (see the file header on issue #33); stderr is collected only for the
 * occasional debugging read, never asserted on here — the contract is about
 * stdout.
 */
function runDoor(argv, env) {
	return new Promise((resolve) => {
		const outDir = mkdtempSync(join(tmpdir(), 'contract-out-'));
		const outPath = join(outDir, 'stdout.json');
		const fd = openSync(outPath, 'w');
		let child;
		try {
			child = spawn(process.execPath, [BUILT_CLI, ...argv], { env, stdio: ['ignore', fd, 'pipe'] });
		} catch (err) {
			closeSync(fd);
			rmSync(outDir, { recursive: true, force: true });
			resolve({ code: null, signal: null, stdout: '', stderr: `spawn error: ${err.message}` });
			return;
		}
		let stderr = '';
		child.stderr.on('data', (c) => {
			stderr += c;
		});
		const timer = setTimeout(() => child.kill('SIGKILL'), PER_RUN_TIMEOUT_MS);
		const finish = (code, signal) => {
			clearTimeout(timer);
			try {
				closeSync(fd);
			} catch {
				/* already closed by the child's own exit */
			}
			let stdout = '';
			try {
				stdout = readFileSync(outPath, 'utf8');
			} catch {
				/* the file was never written */
			}
			rmSync(outDir, { recursive: true, force: true });
			resolve({ code, signal, stdout, stderr });
		};
		child.on('exit', (code, signal) => finish(code, signal));
		child.on('error', (err) => finish(null, null, `${err.message}`));
	});
}

/**
 * Does this JSON value explain a failure ANYWHERE in its tree? See the file
 * header for why this walks rather than checking only the top level.
 */
function explainsFailure(value, depth = 0) {
	if (depth > 6 || value === null || typeof value !== 'object') return false;
	if (Array.isArray(value)) return value.some((v) => explainsFailure(v, depth + 1));
	for (const [key, v] of Object.entries(value)) {
		if (key === 'ok' && v === false) return true;
		if ((key === 'error' || key === 'why' || key === 'reason') && typeof v === 'string' && v.trim())
			return true;
		if (v && typeof v === 'object' && explainsFailure(v, depth + 1)) return true;
	}
	return false;
}

/**
 * The contract this file actually checks, for one run:
 *
 *   - stdout must be EXACTLY one JSON document. `JSON.parse` on the whole
 *     string already enforces this — it refuses trailing non-whitespace
 *     content, which is what two documents concatenated (`emit()` called
 *     twice, or a human line before the JSON) would leave behind.
 *   - a run that exited 0 needs nothing more: there was no failure to explain.
 *   - a run that exited non-zero (or was killed) must carry an explanation
 *     somewhere in the document (see {@link explainsFailure}). A document
 *     that parses but says nothing is the same failure as no document at all.
 */
function satisfiesContract(result) {
	let doc;
	try {
		doc = JSON.parse(result.stdout);
	} catch {
		return false;
	}
	if (result.code === 0) return true;
	return explainsFailure(doc);
}

/**
 * KNOWN, FILED, NOT FIXED HERE. §B is explicit: this file catalogues gaps, it
 * does not close them. Each row is one (entry, case) that fails
 * {@link satisfiesContract} today; `issue` is the public
 * `WolffM/hadoku-fleet-manager` issue filed for it. A row disappearing because
 * the run now PASSES is treated as a test failure below, on purpose — a
 * silent regression-of-the-regression is exactly the thing nobody would
 * notice otherwise, and the fix is to close the issue and delete the row,
 * not to let the gate go quiet about it.
 */
export const KNOWN_BROKEN = [
	// header-audit / identity-model / inventory: `siteRoot()` (or an unawaited
	// `main()`) throws before any emitter exists, identically across all three
	// cases, because none of the three even consults argv or the manifest
	// before crashing.
	{
		entry: 'header-audit',
		case: 'a-unknown-flag',
		issue: 20,
		observed: 'uncaught: check-header-fleet.mjs:140 `siteRoot()` at module scope',
	},
	{
		entry: 'header-audit',
		case: 'b-empty-manifest',
		issue: 20,
		observed: 'uncaught: check-header-fleet.mjs:140 `siteRoot()` at module scope',
	},
	{
		entry: 'header-audit',
		case: 'c-unreachable-node',
		issue: 20,
		observed: 'uncaught: check-header-fleet.mjs:140 `siteRoot()` at module scope',
	},
	{
		entry: 'identity-model',
		case: 'a-unknown-flag',
		issue: 21,
		observed: 'uncaught: check-identity-model.mjs:130 `siteRoot()` at module scope',
	},
	{
		entry: 'identity-model',
		case: 'b-empty-manifest',
		issue: 21,
		observed: 'uncaught: check-identity-model.mjs:130 `siteRoot()` at module scope',
	},
	{
		entry: 'identity-model',
		case: 'c-unreachable-node',
		issue: 21,
		observed: 'uncaught: check-identity-model.mjs:130 `siteRoot()` at module scope',
	},
	{
		entry: 'inventory',
		case: 'a-unknown-flag',
		issue: 22,
		observed: 'unhandled rejection: fleet-inventory.mjs:342 bare `await main();`, no `.catch()`',
	},
	{
		entry: 'inventory',
		case: 'b-empty-manifest',
		issue: 22,
		observed: 'unhandled rejection: fleet-inventory.mjs:342 bare `await main();`, no `.catch()`',
	},
	{
		entry: 'inventory',
		case: 'c-unreachable-node',
		issue: 22,
		observed: 'unhandled rejection: fleet-inventory.mjs:342 bare `await main();`, no `.catch()`',
	},
	// reconcile: manifest VALIDATION throws (e.g. "machines is required") reach
	// only the generic top-level `main().catch(...)`, which `console.error`s and
	// exits WITHOUT consulting JSON_OUT — even though the file's own `fail()`
	// helper does the right thing on every path that reaches it.
	{
		entry: 'reconcile',
		case: 'a-unknown-flag',
		issue: 23,
		observed:
			'reconcile-fleet-runners.mjs:2577 top-level catch: console.error + exit, no JSON_OUT check',
	},
	{
		entry: 'reconcile',
		case: 'b-empty-manifest',
		issue: 23,
		observed:
			'reconcile-fleet-runners.mjs:2577 top-level catch: console.error + exit, no JSON_OUT check',
	},
	{
		entry: 'reconcile',
		case: 'c-unreachable-node',
		issue: 23,
		observed:
			'reconcile-fleet-runners.mjs:2577 top-level catch: console.error + exit, no JSON_OUT check',
	},
	// cleanup: the "no nodes" early exit prints to stderr and exits before the
	// emitter is ever consulted.
	{
		entry: 'cleanup',
		case: 'b-empty-manifest',
		issue: 24,
		observed: 'clean-runner-debris.mjs:111-118 console.error + exit(1), empty stdout',
	},
	// doctor: the "no managed node matches" early exit does the same.
	{
		entry: 'doctor',
		case: 'b-empty-manifest',
		issue: 25,
		observed: 'lib/doctor-run.mjs:151-152 console.error + exit(1), empty stdout',
	},
	// converge-toolchain: two DIFFERENT bugs, two different issues.
	//   (b) `refresh()`'s "no machines selected" calls the shared emitter's
	//       `log()` (which only HOLDS a line under --json) and then
	//       `process.exit(1)` on the next line, so the held line is never
	//       emitted — stdout AND stderr are both empty.
	{
		entry: 'converge-toolchain',
		case: 'b-empty-manifest',
		issue: 26,
		observed: 'converge-toolchain.mjs:241-243 log()-then-exit never calls emitter.emit(); silent',
	},
	//   (a) `converge-toolchain` is the one JSON_CONTRACT entry whose door
	//       table entry (src/cli.ts) declares an allowed-flags list, so an
	//       unrecognised flag is refused by the DOOR, before the script (and
	//       its emitter) ever runs — stderr prose, exit 2, empty stdout.
	{
		entry: 'converge-toolchain',
		case: 'a-unknown-flag',
		issue: 27,
		observed: "src/cli.ts's unknown-flag door refusal (cmd.flags), exit 2, empty stdout",
	},
];

const knownBrokenKey = (entry, caseName) => `${entry}\u0000${caseName}`;
const KNOWN_BROKEN_SET = new Set(KNOWN_BROKEN.map((r) => knownBrokenKey(r.entry, r.case)));

void test('the contract is readable at all — a parse of nothing is not a pass', () => {
	assert.ok(
		JSON_CONTRACT.length >= MIN_ENTRIES,
		`parsed ${JSON_CONTRACT.length} JSON_CONTRACT entries, expected at least ${MIN_ENTRIES}. ` +
			'If this moved, every behavioural check below just ran over nothing.'
	);
});

void test('KNOWN_BROKEN names only entries that are actually under contract', () => {
	const subs = new Set(JSON_CONTRACT.map((e) => e.sub));
	for (const row of KNOWN_BROKEN) {
		assert.ok(
			subs.has(row.entry),
			`KNOWN_BROKEN names "${row.entry}", which is not in JSON_CONTRACT`
		);
		assert.ok(
			Number.isInteger(row.issue) && row.issue > 0,
			`${row.entry}/${row.case} has no issue number`
		);
		assert.ok(row.observed && row.observed.trim(), `${row.entry}/${row.case} has no observed note`);
	}
});

void test(
	'every JSON_CONTRACT entry, under three hermetic failure shapes, emits exactly one JSON ' +
		'document that says why when it fails — new breaks and healed KNOWN_BROKEN rows both fail this',
	{ timeout: 170_000 },
	async () => {
		assert.ok(
			existsSync(BUILT_CLI),
			'dist/cli.js is missing — run `pnpm run build` first. This test runs the real CLI; ' +
				'skipping it because the build is absent would be "I could not look" rendering as ' +
				'"nothing is wrong".'
		);

		const tasks = [];
		for (const entry of JSON_CONTRACT) {
			for (const c of casesFor(entry)) {
				tasks.push(
					(async () => {
						const env = hermeticEnv(c.manifestDir);
						const result = await runDoor(c.argv, env);
						return { sub: entry.sub, case: c.name, result };
					})()
				);
			}
		}

		const t0 = Date.now();
		const outcomes = await Promise.all(tasks);
		const wallClockMs = Date.now() - t0;

		const newFailures = [];
		const newlyPassing = [];
		for (const { sub, case: caseName, result } of outcomes) {
			const ok = satisfiesContract(result);
			const known = KNOWN_BROKEN_SET.has(knownBrokenKey(sub, caseName));
			if (known && ok) {
				newlyPassing.push(
					`${sub}/${caseName} now satisfies the contract — the KNOWN_BROKEN row (and its ` +
						`fleet-manager issue) should be closed, not left catalogued as broken`
				);
			} else if (!known && !ok) {
				newFailures.push(
					`${sub}/${caseName}: exit ${result.code}${result.signal ? ` (signal ${result.signal})` : ''}, ` +
						`stdout ${JSON.stringify(result.stdout.slice(0, 300))}, ` +
						`stderr tail ${JSON.stringify(result.stderr.slice(-300))}`
				);
			}
		}

		assert.deepEqual(
			{ newFailures, newlyPassing },
			{ newFailures: [], newlyPassing: [] },
			'the behavioural --json contract changed shape — see the lists above for exactly which ' +
				'(entry, case) pairs are new breaks (fix or catalogue in KNOWN_BROKEN with a filed ' +
				'issue) or healed KNOWN_BROKEN rows (close the issue and delete the row)'
		);

		// Not an assertion — a printed fact, same spirit as json-contract.test.mjs
		// reporting its own wall-clock. §B's budget is 3 minutes for the whole
		// file; this is the part that actually spawns processes.
		console.log(
			`[json-contract-behaviour] ${outcomes.length} runs (${JSON_CONTRACT.length} entries × 3 ` +
				`cases) in ${wallClockMs}ms`
		);
	}
);
