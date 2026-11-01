/**
 * The `fleet benchmark` subcommand's live behaviour, proved against the
 * real, built CLI: `--report`'s no-machine proof, the backstop role, the
 * `$benchmark`/state-file merge (Wave 3h §6), a whole document surviving a
 * real pipe (issue #33), and the `--cadence` entry's declared argv reaching
 * no machine with nothing due.
 *
 * Split out of `json-contract.test.mjs` (wave 5s lane B) to bring that file
 * under the 1,000-line test ceiling — a whole-block move, every test body
 * below unchanged from where it lived there (including the doc comment
 * right before `TODAYS_JSON_CONTRACT` in `json-contract-declaration.test.mjs`,
 * which described this file's own cadence test and is reunited with it
 * here). `json-contract-declaration.test.mjs` holds everything checked by
 * reading source text alone; `json-contract-provenance.test.mjs` holds the
 * banner proof run against every OTHER contract entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { JSON_CONTRACT } from './json-contract.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BUILT_CLI = join(ROOT, 'dist', 'cli.js');

/**
 * `ci:fleet-benchmark`'s argv, RUN — and proved to reach no machine.
 *
 * The other entries here are checked structurally because behaviour is out of
 * reach: `toolchain` needs ssh, `reconcile` needs a token. This one is the
 * opposite claim — that `--report` reaches NOTHING — and the whole point of the
 * 2026-09-15 change is that it can therefore be exercised for real, offline,
 * against a fixture history file.
 *
 * "No ssh" is not asserted from reading the code. `ssh`, `sudo` and `scp` are
 * shadowed on PATH by scripts that record having been called; if the report
 * path reached a box, the marker file would exist. The fixture manifest is a
 * temp directory, so nothing in `manifests/` or in hadoku_site is read, let
 * alone written, and every machine here is a row in a JSON file rather than a
 * host.
 *
 * FOUR MACHINES, AND THE LAST TWO ARE THE ROLE RULE:
 *
 *   fx-claw-old    claw,  40d  -> due at --due 30
 *   fx-claw-fresh  claw,   1d  -> due only at --due 0
 *   fx-backstop    backstop, 99d -> NEVER due, and never a finding, at any
 *                                 threshold. The backstop is not ranked for
 *                                 routing, so a finding telling someone to go
 *                                 and measure it is noise. It must still be
 *                                 VISIBLE, in
 *                                 `skippedByRole` — "I did not need to look" is
 *                                 not "nothing is wrong".
 *   fx-unclassified  no role, 99d -> due. Absence reads as `claw`, the strict
 *                                 direction, so a backstop that lost its role
 *                                 turns up loudly instead of vanishing.
 *
 * Names are deliberately fixture-shaped: this file must not teach anyone that
 * the rule is about one hostname. It is about the manifest's `role` key.
 */
function benchmarkFixture() {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-benchmark-report-'));
	const day = 86400000;
	writeFileSync(
		join(dir, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				'fx-claw-old': { role: 'claw' },
				'fx-claw-fresh': { role: 'claw' },
				'fx-backstop': { role: 'backstop' },
				'fx-unclassified': {},
			},
		})
	);
	// THE STATE FILE, not the manifest and not `fleet-benchmarks.json`: since
	// Wave 3h `$benchmark` is recorded in `<stateDir>/benchmark.json`
	// (`src/lib/measured.ts`), and that is where `--due` reads its `at` stamps.
	const stamp = (days) => ({
		at: new Date(Date.now() - days * day).toISOString(),
		by: 'fleet benchmark',
	});
	const state = join(dir, 'state');
	mkdirSync(state);
	writeFileSync(
		join(state, 'benchmark.json'),
		JSON.stringify({
			nodes: {
				'fx-backstop': stamp(99),
				'fx-unclassified': stamp(99),
				'fx-claw-old': stamp(40),
				'fx-claw-fresh': stamp(1),
			},
		})
	);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const marker = join(dir, 'REACHED-A-MACHINE');
	for (const tool of ['ssh', 'sudo', 'scp']) {
		const p = join(bin, tool);
		writeFileSync(p, `#!/bin/sh\necho "${tool} $*" >> ${marker}\nexit 1\n`, { mode: 0o755 });
	}
	return { dir, bin, marker, state };
}

const runBenchmark = (fx, argv) =>
	spawnSync(process.execPath, [BUILT_CLI, 'benchmark', ...argv], {
		env: {
			...process.env,
			PATH: `${fx.bin}:${process.env.PATH ?? ''}`,
			FLEET_MANIFEST_DIR: fx.dir,
			// NEVER the operator's `~/.hadoku-mgmt`: on hokon that is the live state
			// dir, and `$benchmark` is read from it since Wave 3h.
			HADOKU_STATE_DIR: fx.state,
			// Blinded the way a CI runner is: no sibling checkouts on disk.
			HADOKU_SITE_ROOT: '/nonexistent-fleet-site',
			REPOS_DIR: '/nonexistent-fleet-repos',
		},
		encoding: 'utf8',
		timeout: 30_000,
	});

// `--report` is still a supported read-only mode for people, so it keeps its
// no-machine proof. It is no longer the cron's argv (#93): the contract entry
// declares `--cadence`, tested below.
const REPORT_ARGV = ['--due', '30', '--report', '--json'];

void test('--report answers from the state file and reaches no machine', () => {
	assert.ok(existsSync(BUILT_CLI), 'dist/cli.js is missing — run `pnpm run build` first');
	const fx = benchmarkFixture();
	try {
		const r = runBenchmark(fx, REPORT_ARGV);
		assert.equal(
			existsSync(fx.marker),
			false,
			`\`fleet benchmark ${REPORT_ARGV.join(' ')}\` invoked ssh/sudo/scp: ` +
				`${existsSync(fx.marker) ? readFileSync(fx.marker, 'utf8') : ''}`
		);
		assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
		const out = JSON.parse(r.stdout);
		assert.equal(out.mode, 'report');
		// Oldest first. fx-unclassified (99d, no role -> claw) then fx-claw-old
		// (40d); fx-claw-fresh is 1d and fx-backstop is exempt.
		assert.deepEqual(
			out.due.map((d) => d.node),
			['fx-unclassified', 'fx-claw-old']
		);
		assert.ok(out.due[0].measuredAt, 'a due node must carry the date its numbers were taken');
		assert.ok(
			out.due[1].ageDays >= 39 && out.due[1].ageDays <= 41,
			`ageDays ${out.due[1].ageDays}`
		);
		assert.deepEqual(out.results, {}, 'a report must measure nothing');
		assert.deepEqual(out.coverage.never, []);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('the BACKSTOP is never due and is never a finding — but it is never dropped either', () => {
	// The backstop is not ranked for routing, so its benchmark is never due. Its
	// $benchmark stamp ages exactly like a claw's, so without the role exclusion
	// the nightly report would tell a human to go and measure it.
	const fx = benchmarkFixture();
	try {
		const r = runBenchmark(fx, ['--due', '30', '--report', '--json']);
		assert.equal(existsSync(fx.marker), false, 'the report path invoked ssh/sudo/scp');
		assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
		const out = JSON.parse(r.stdout);

		// 99 days old and NOT due.
		assert.ok(
			!out.due.some((d) => d.node === 'fx-backstop'),
			`the backstop reached the due list: ${JSON.stringify(out.due)}`
		);
		// Nor named anywhere a cron would turn into an alert. `findings` is what
		// the consumer pages on, so excluding it from `due` and then listing it
		// here would route the same page down the other pipe.
		assert.deepEqual(out.findings, [], 'the backstop must not reach findings');
		assert.ok(
			!out.byHand.includes('fx-backstop'),
			`the by-hand command told an operator to measure the backstop: ${out.byHand}`
		);

		// VISIBLE, though. "I did not need to look" is not "nothing is wrong", and
		// a CLAW that wrongly gained role: backstop would otherwise stop being
		// measured in total silence.
		assert.deepEqual(
			out.skippedByRole.map((d) => d.node),
			['fx-backstop']
		);
		assert.equal(out.skippedByRole[0].role, 'backstop');
		assert.ok(
			out.skippedByRole[0].measuredAt,
			'an exempt node still carries the date its numbers were taken'
		);
		assert.ok(out.skippedByRole[0].ageDays > 90, `ageDays ${out.skippedByRole[0].ageDays}`);

		// And the strict default holds: a machine with NO role reads as a claw, so
		// a backstop that somehow lost its role turns up loudly rather than vanishing.
		assert.ok(
			out.due.some((d) => d.node === 'fx-unclassified'),
			'an unclassified machine must be treated as a claw, not silently exempted'
		);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('--due 0 --report accounts for every machine across due + skippedByRole', () => {
	const fx = benchmarkFixture();
	try {
		const r = runBenchmark(fx, ['--due', '0', '--report', '--json']);
		assert.equal(existsSync(fx.marker), false, 'the report path invoked ssh/sudo/scp');
		assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
		const out = JSON.parse(r.stdout);
		assert.deepEqual(out.due.map((d) => d.node).sort(), [
			'fx-claw-fresh',
			'fx-claw-old',
			'fx-unclassified',
		]);
		assert.deepEqual(
			out.skippedByRole.map((d) => d.node),
			['fx-backstop']
		);
		// NO MACHINE MAY DISAPPEAR. At --due 0 every machine in the manifest has
		// aged out, so the two lists together must be the whole roster — an
		// exclusion that quietly shortened the total is the failure this asserts
		// against, not the exclusion itself.
		const machines = Object.keys(
			JSON.parse(readFileSync(join(fx.dir, 'fleet-runner-manifest.json'), 'utf8')).machines
		);
		assert.deepEqual(
			[...out.due.map((d) => d.node), ...out.skippedByRole.map((d) => d.node)].sort(),
			machines.sort()
		);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('--report refuses --write and --max rather than quietly picking one', () => {
	const fx = benchmarkFixture();
	try {
		// A run that both measures and refuses to measure has no honest answer,
		// and silently letting one win is how a cron writes a manifest by
		// accident — the exact thing the operator ruled out.
		const w = runBenchmark(fx, ['--due', '30', '--report', '--write', '--json']);
		assert.equal(w.status, 2, `--report --write exited ${w.status}`);
		assert.match(w.stderr, /mutually exclusive/);
		// --max bounds how many boxes a run may LOAD. Honouring it on a report
		// that loads none would truncate the due list, so the further behind the
		// fleet fell the quieter this would get.
		const m = runBenchmark(fx, ['--due', '30', '--report', '--max', '1', '--json']);
		assert.equal(m.status, 2, `--report --max exited ${m.status}`);
		assert.match(m.stderr, /--max/);
		assert.equal(existsSync(fx.marker), false, 'a refused run still reached a machine');
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

/**
 * WHERE `$benchmark` IS READ FROM, AND WHAT ITS ABSENCE MEANS — Wave 3h.
 *
 * `measured-facets-home-2026-09-16.md` §6 made one behaviour a hard requirement
 * before the facet could leave the manifest: with the facet ABSENT, `--due 30
 * --report` must read every claw as DUE, never as fresh. Executed against the
 * pre-3h code over the live manifest with every `$benchmark` stripped, it FAILED:
 * `due: [], ok: true`, because `--due` read the run ledger
 * (`fleet-benchmarks.json`) and the ledger was still fresh. These pin the fix.
 *
 * Every machine here is a row in a temp file; `HADOKU_STATE_DIR` points into the
 * temp dir (never `~/.hadoku-mgmt`), and ssh/sudo/scp are shadowed as above.
 */
function stateFixture({ machines, state, ledgerFresh = false }) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-benchmark-state-'));
	writeFileSync(join(dir, 'fleet-runner-manifest.json'), JSON.stringify({ machines }));
	if (ledgerFresh) {
		// The trap S §6 existed for: a run ledger that still reads fresh.
		const at = new Date().toISOString();
		writeFileSync(
			join(dir, 'fleet-benchmarks.json'),
			JSON.stringify({
				runs: [{ at, results: Object.fromEntries(Object.keys(machines).map((n) => [n, {}])) }],
			})
		);
	}
	const stateDir = join(dir, 'state');
	if (state !== undefined) {
		mkdirSync(stateDir);
		if (state !== null) {
			writeFileSync(
				join(stateDir, 'benchmark.json'),
				typeof state === 'string' ? state : JSON.stringify({ nodes: state })
			);
		}
	}
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const marker = join(dir, 'REACHED-A-MACHINE');
	for (const tool of ['ssh', 'sudo', 'scp']) {
		writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> ${marker}\nexit 1\n`, {
			mode: 0o755,
		});
	}
	return { dir, bin, marker, state: stateDir };
}

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

for (const [label, state] of [
	['the state dir does not exist', undefined],
	['the state dir exists and benchmark.json does not', null],
]) {
	void test(`S §6: NO benchmark record anywhere reads every claw as DUE, never fresh — ${label}`, () => {
		const fx = stateFixture({
			machines: { 'fx-a': { role: 'claw' }, 'fx-b': {}, 'fx-backstop': { role: 'backstop' } },
			state,
			ledgerFresh: true,
		});
		try {
			const r = runBenchmark(fx, ['--due', '30', '--report', '--json']);
			assert.equal(existsSync(fx.marker), false, 'the report path invoked ssh/sudo/scp');
			const out = JSON.parse(r.stdout);
			assert.deepEqual(
				out.due.map((d) => d.node).sort(),
				['fx-a', 'fx-b'],
				'a missing record must make every claw DUE — a fresh run ledger beside the ' +
					'manifest is not a record of anything a reader is served'
			);
			for (const d of out.due) assert.equal(d.measuredAt, null, `${d.node} got a date`);
			assert.equal(out.ok, false, '"I could not look" must never render as ok');
			// `coverage` is the raw fact and names the backstop too; `findings` — what
			// the cron pages on — does not.
			assert.deepEqual(out.coverage.never.sort(), ['fx-a', 'fx-b', 'fx-backstop']);
			assert.equal(out.findings.length, 2, JSON.stringify(out.findings));
			for (const f of out.findings) assert.match(f, /NEVER measured — no benchmark record/);
			// The backstop is exempt from the page and still visible.
			assert.deepEqual(
				out.skippedByRole.map((d) => d.node),
				['fx-backstop']
			);
			assert.equal(r.status, 1, 'a claw with no record exits 1');
		} finally {
			rmSync(fx.dir, { recursive: true, force: true });
		}
	});
}

void test('a MALFORMED state file is could-not-look — a fresh manifest copy does not paper over it', () => {
	const fx = stateFixture({
		machines: { 'fx-a': { role: 'claw', $benchmark: { at: daysAgo(1), by: 'fleet benchmark' } } },
		state: '{ this is not json',
	});
	try {
		const r = runBenchmark(fx, ['--due', '30', '--report', '--json']);
		const out = JSON.parse(r.stdout);
		assert.deepEqual(
			out.due.map((d) => d.node),
			['fx-a'],
			'an unreadable state file may hold a NEWER record than the manifest, so the ' +
				"manifest's copy must not answer"
		);
		assert.match(out.findings[0], /UNREADABLE \(malformed\)/);
		assert.equal(r.status, 1);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('the MERGE: the state copy wins only when strictly newer; the manifest copy serves meanwhile', () => {
	// Each node is a different branch of `mergeFacet`, and the dates are chosen so
	// that reverting the merge to EITHER tree alone moves a node across --due 30:
	//
	//   fx-both-manifest-newer  manifest 2d, state 40d  -> manifest answers, fresh
	//   fx-both-state-newer     manifest 50d, state 1d  -> state answers, fresh
	//   fx-manifest-only        manifest 40d            -> manifest answers, due
	//   fx-state-only           state 45d               -> state answers, due
	const fx = stateFixture({
		machines: {
			'fx-both-manifest-newer': { $benchmark: { at: daysAgo(2), by: 'fleet benchmark' } },
			'fx-both-state-newer': { $benchmark: { at: daysAgo(50), by: 'fleet benchmark' } },
			'fx-manifest-only': { $benchmark: { at: daysAgo(40), by: 'fleet benchmark' } },
			'fx-state-only': {},
		},
		state: {
			'fx-both-manifest-newer': { at: daysAgo(40), by: 'fleet benchmark' },
			'fx-both-state-newer': { at: daysAgo(1), by: 'fleet benchmark' },
			'fx-state-only': { at: daysAgo(45), by: 'fleet benchmark' },
		},
	});
	try {
		const r = runBenchmark(fx, ['--due', '30', '--report', '--json']);
		assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
		const out = JSON.parse(r.stdout);
		assert.deepEqual(
			out.due.map((d) => [d.node, Math.round(d.ageDays)]),
			[
				['fx-state-only', 45],
				['fx-manifest-only', 40],
			]
		);
		assert.deepEqual(out.findings, []);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

/**
 * A REAL CONTRACT SUBCOMMAND, A REAL PIPE, AND A DOCUMENT TOO BIG TO SLIP
 * THROUGH.
 *
 * Every other run in this file is deliberately TINY. The poisoned-environment
 * tests fail in under 100ms with a few hundred bytes, and the benchmark fixture
 * above holds four machines. That is what made them fast, offline and
 * trustworthy about what they check — and completely blind to issue #33: on a
 * pipe, `process.exit` discards whatever `process.stdout` still had queued, so
 * a gate whose answer grew past a few kilobytes started handing mgmt-api a
 * document cut off mid-string. `JSON.parse` fails, `startsWith('{')` still
 * passes, and the cron reports "the checker broke" in place of the fleet's
 * answer.
 *
 * TWO PROPERTIES HAVE TO HOLD AT ONCE, and dropping either one is how this
 * survived:
 *
 *   - the consumer reads through a PIPE. `spawn` with `stdio: 'pipe'` is what
 *     `execFile` is. A shell redirect makes fd 1 a FILE, Node writes files with
 *     `fs.writeSync`, nothing is queued, and the test passes against the broken
 *     emitter. The file half is measured here too — as the reference length,
 *     which is the only reason we can say the pipe lost something.
 *   - the document is BIG. 1,200 fixture machines put it past 140 KB. How much
 *     a broken emitter loses depends on how fast the reader drains — measured
 *     2026-09-16, 146,176 of 149,133 bytes with a reader attached and 8,192
 *     with none — so this asserts the whole length rather than a threshold.
 *
 * Still offline and still reaches no machine: same shadowed `ssh`/`sudo`/`scp`
 * as the fixture above, same temp manifest dir, and the marker file is asserted
 * absent.
 */
const BIG_FIXTURE_MACHINES = 1200;

function bigBenchmarkFixture() {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-benchmark-big-'));
	const day = 86400000;
	const machines = {};
	const nodes = {};
	const at = new Date(Date.now() - 40 * day).toISOString();
	for (let i = 0; i < BIG_FIXTURE_MACHINES; i++) {
		const node = `fx-claw-${String(i).padStart(4, '0')}`;
		machines[node] = { role: 'claw' };
		nodes[node] = { at, by: 'fleet benchmark' };
	}
	writeFileSync(join(dir, 'fleet-runner-manifest.json'), JSON.stringify({ machines }));
	const state = join(dir, 'state');
	mkdirSync(state);
	writeFileSync(join(state, 'benchmark.json'), JSON.stringify({ nodes }));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const marker = join(dir, 'REACHED-A-MACHINE');
	for (const tool of ['ssh', 'sudo', 'scp']) {
		writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> ${marker}\nexit 1\n`, {
			mode: 0o755,
		});
	}
	return { dir, bin, marker, state };
}

void test('a contract subcommand delivers its WHOLE document through a real pipe', async () => {
	assert.ok(existsSync(BUILT_CLI), 'dist/cli.js is missing — run `pnpm run build` first');
	const fx = bigBenchmarkFixture();
	const env = {
		...process.env,
		PATH: `${fx.bin}:${process.env.PATH ?? ''}`,
		FLEET_MANIFEST_DIR: fx.dir,
		HADOKU_STATE_DIR: fx.state,
		HADOKU_SITE_ROOT: '/nonexistent-fleet-site',
		REPOS_DIR: '/nonexistent-fleet-repos',
	};
	const argv = [BUILT_CLI, 'benchmark', '--due', '0', '--report', '--json'];
	try {
		// The reference length: fd 1 as a FILE, which never truncated.
		const outFile = join(fx.dir, 'report.json');
		const fd = openSync(outFile, 'w');
		const viaFile = spawnSync(process.execPath, argv, {
			env,
			stdio: ['ignore', fd, 'pipe'],
			timeout: 120_000,
		});
		closeSync(fd);
		assert.equal(viaFile.status, 0, `into a file, exited ${viaFile.status}: ${viaFile.stderr}`);
		const fileBytes = statSync(outFile).size;
		assert.ok(
			fileBytes > 64 * 1024,
			`the fixture produced ${fileBytes} bytes; under 64 KB this test proves nothing. ` +
				'Raise BIG_FIXTURE_MACHINES.'
		);

		// The consumer's read: spawn, stdio 'pipe'. This is execFile.
		const chunks = [];
		const child = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout.on('data', (c) => chunks.push(c));
		const code = await new Promise((resolve, reject) => {
			child.on('error', reject);
			child.on('exit', resolve);
		});
		const piped = Buffer.concat(chunks);

		assert.equal(existsSync(fx.marker), false, 'the report path invoked ssh/sudo/scp');
		assert.equal(code, 0, `through a pipe, exited ${code}`);
		assert.equal(
			piped.length,
			fileBytes,
			`the pipe received ${piped.length} bytes of a ${fileBytes}-byte document. ` +
				'`process.exit` abandoned what stdout still had queued — see keepStdoutWhole() ' +
				'in lib/emit.mjs, issue #33.'
		);
		// The assertion every consumer in JSON_CONTRACT actually makes.
		const out = JSON.parse(piped.toString('utf8'));
		assert.equal(out.mode, 'report');
		assert.equal(out.due.length, BIG_FIXTURE_MACHINES);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

/**
 * #93: the DECLARED argv is the cadence, and it is a valid, bounded invocation.
 *
 * The cadence reaches a machine by design (it drains and measures one claw), so
 * it cannot share `--report`'s "reaches no machine" proof as-is. What the LIST
 * must guarantee is narrower: the argv mgmt-api runs is accepted, and with
 * nothing due it measures nothing and touches no box. The cadence's behaviour
 * with a node due (at most one, never the backstop, busy or someone else's drain,
 * always undrained, including when the measurement throws) is proved against
 * injected fixtures in `scripts/lib/benchmark-cadence.test.mjs`.
 */
void test('the benchmark entry declares the cadence, and with nothing due it reaches no machine', () => {
	assert.ok(existsSync(BUILT_CLI), 'dist/cli.js is missing — run `pnpm run build` first');
	const entry = JSON_CONTRACT.find((e) => e.sub === 'benchmark');
	assert.ok(entry, 'the benchmark entry is gone from JSON_CONTRACT');
	assert.ok(
		entry.argv.includes('--cadence') && !entry.argv.includes('--report'),
		'ci:fleet-benchmark runs --cadence since 2026-10-04 (#87, #93); the list must declare what mgmt-api runs'
	);
	const fx = benchmarkFixture();
	try {
		// Every claw freshly measured: nothing inside any lead window.
		const fresh = { at: new Date().toISOString(), by: 'fleet benchmark' };
		writeFileSync(
			join(fx.state, 'benchmark.json'),
			JSON.stringify({
				nodes: {
					'fx-claw-old': fresh,
					'fx-claw-fresh': fresh,
					'fx-backstop': fresh,
					'fx-unclassified': fresh,
				},
			})
		);
		const r = runBenchmark(fx, entry.argv);
		assert.equal(
			existsSync(fx.marker),
			false,
			`with nothing due the cadence invoked ssh/sudo/scp: ${existsSync(fx.marker) ? readFileSync(fx.marker, 'utf8') : ''}`
		);
		assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
		const out = JSON.parse(r.stdout);
		assert.deepEqual(out.results ?? {}, {}, 'nothing due must measure nothing');
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});
