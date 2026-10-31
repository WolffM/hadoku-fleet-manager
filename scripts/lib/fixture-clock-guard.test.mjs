/**
 * A test fixture may not carry an expiry date.
 *
 * THE CLASS. Several readers in this repo filter by AGE against a rolling
 * window read from the real clock: `jobRecords()`/`loadHistory`/`compactHistory`
 * drop anything older than `RETENTION_DAYS = 14`, and `compactHistory` runs at
 * the end of every `ingestRuns`. A fixture pinned to an absolute ISO date
 * therefore does not describe "a job"; it describes "a job until the cutoff
 * reaches it". Nothing in the diff changes on the day it does. The commit that
 * planted the bomb is weeks old, CI was green yesterday, and the only thing that
 * moved is the calendar.
 *
 * It has now happened twice, unprompted, on files nobody had touched:
 *
 *   2026-09-08  nineteen tests in `job-history.test.ts`, fixtures pinned to
 *               2026-08-25T03:00:00Z. Fixed by 473dfdb.
 *   2026-09-15  thirteen tests in `warm-cache.test.ts`, fixtures pinned to
 *               2026-09-01T00:00:00Z — issue #27. The pre-push hook runs the
 *               whole suite, so from that morning NO push from ANY host could
 *               land, including a docs-only one.
 *
 * Both were loud. The dangerous version is quiet: 473dfdb found a case asserting
 * `undefined`, which is also exactly what an aged-out record returns, so that
 * one would have gone VACUOUS rather than red. Counting green tests cannot tell
 * those apart, which is why the guard below moves the clock instead.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * Two halves, because the two halves of `pnpm test` can be guarded with very
 * different strength and it is worth being explicit about which is which.
 *
 * `src/tests/**` gets the STRONG form: the compiled suite is re-run in a child
 * process whose `Date` is shifted forward, and it must still pass. That is
 * evidence rather than syntax — it catches an absolute date in any shape
 * (`'...'`, `Date.parse(...)`, `new Date(...)`, a value derived from one), and
 * it cannot be satisfied by writing a comment about it. It is also the thing a
 * human would otherwise have to remember to run by hand, which is precisely the
 * kind of check that stops being run.
 *
 * That half spawns a child and READS ITS OUTPUT, so everything about that
 * output has to be pinned rather than inherited. It was not, once: `node --test`
 * defaults to TAP on a pipe under Node 22 and to `spec` under Node 24, this box
 * and the reviewer's both run 24, and ci.yml then pinned `node-version: '22'`
 * (24 since 2026-10-30). The
 * guard went green twice locally and red on main. Whatever is added here, ask
 * the child for it explicitly and check it on BOTH majors — a guard that reads
 * a subprocess is only as portable as the flags it names.
 *
 * `scripts/**` gets the WEAK form: a declared list. This file IS the scripts
 * half, so it structurally cannot re-run the scripts half around itself, and a
 * guard that recursed would either hang or lie. So instead every `.test.mjs`
 * holding an absolute ISO date is named below with the reason it is inert, and
 * the list is checked in both directions — an undeclared file fails, and so
 * does a declared file that no longer has one. Its limit, stated plainly: a NEW
 * absolute date added to a file already on the list slips through. The entries
 * are on the list because their module under test takes `now` as an injected
 * parameter, so a new date in one of them is inert for the same structural
 * reason the existing ones are; that is an argument, not a proof.
 *
 * COMMENTS ARE BLANKED FIRST — including this one, which quotes four of the
 * dates it forbids. A rule about source must never be satisfiable, or
 * violatable, by prose about it.
 *
 * @guards src/tests/**
 * @guards scripts/**\/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { blankComments } from './blank-comments.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** scripts/lib -> scripts -> repo root */
const ROOT = dirname(dirname(HERE));

// --- the strong half: run src/tests on a clock that has moved ----------------

/**
 * Shifts `Date` forward by `FIXTURE_CLOCK_SHIFT_DAYS` and nothing else.
 *
 * Only `Date` — the monotonic sources (`hrtime`, `performance.now`) are left
 * alone, so a test that measures a duration still measures a duration. A real
 * `libfaketime` would be equivalent and is NOT used deliberately: it is a system
 * package, this must run on every claw and in CI, and a guard that silently
 * skips where its dependency is missing is the "I could not look" failure
 * rendered as "nothing is wrong".
 */
const SHIM = `
const days = Number(process.env.FIXTURE_CLOCK_SHIFT_DAYS);
if (!Number.isFinite(days)) throw new Error('FIXTURE_CLOCK_SHIFT_DAYS is not a number');
const shift = days * 24 * 3600 * 1000;
const Real = Date;
class Shifted extends Real {
	constructor(...args) {
		if (args.length === 0) super(Real.now() + shift);
		else super(...args);
	}
	static now() {
		return Real.now() + shift;
	}
}
Object.defineProperty(Shifted, 'name', { value: 'Date' });
globalThis.Date = Shifted;
`;
const SHIM_URL = `data:text/javascript,${encodeURIComponent(SHIM)}`;

/**
 * +30 is the bar issue #27 asked for and the one that matters: a fixture is
 * written at roughly "today", so the cutoff is at most `RETENTION_DAYS` out and
 * thirty days clears it with room. +400 is here because +30 alone would miss a
 * fixture dated into the FUTURE, which ages into the window rather than out of
 * it — a shape nothing has hit yet, and one a guard only gets to notice if it
 * looks. Both together cost about two seconds.
 */
const SHIFTS = [30, 400];

/**
 * The child's environment, with this runner's own bookkeeping removed.
 *
 * `NODE_TEST_CONTEXT` and `NODE_TEST_WORKER_ID` are set by the runner that is
 * executing THIS file. Inherited, they tell the child it is already being
 * managed and it runs nothing at all — see the assertion below.
 */
function childEnv(days) {
	const env = { ...process.env, FIXTURE_CLOCK_SHIFT_DAYS: String(days) };
	delete env.NODE_TEST_CONTEXT;
	delete env.NODE_TEST_WORKER_ID;
	return env;
}

/** The compiled suite, which `pnpm test` rebuilds with `tsc` before this runs. */
const COMPILED = join(ROOT, 'dist', 'tests');

for (const days of SHIFTS) {
	test(`src/tests passes with the clock ${days} days ahead`, () => {
		// A missing build is "I could not look", and that fails. `pnpm test` runs
		// `tsc` before either half, so in every gated path — the pre-push hook and
		// ci.yml both run `pnpm run check` — this directory exists. Skipping here
		// would hand a green tick to the one situation the guard exists to report.
		assert.ok(
			existsSync(COMPILED),
			`${relative(ROOT, COMPILED)} does not exist, so the shifted-clock run never ` +
				`happened. Build it with \`pnpm test\`, which is what CI runs; this guard ` +
				`cannot report a pass it did not observe.`
		);

		const r = spawnSync(
			process.execPath,
			[
				'--disable-warning=ExperimentalWarning',
				// ASK FOR THE REPORTER. Do not inherit it.
				//
				// `node --test` picks its default from the environment, and the default
				// CHANGED between majors: Node 22 emits TAP when stdout is not a TTY,
				// Node 24 emits `spec` regardless. This guard is always spawned onto a
				// pipe, so it read `spec` on the two Node 24 workstations it was written
				// and reviewed on, and TAP in CI, which then pinned `node-version: '22'`. The
				// `ℹ pass N` line it looks for below does not exist in TAP — that is
				// `# pass N` — so the non-vacuity assertion fired on a child that had
				// run the whole suite perfectly, and reddened main for the entire wave.
				//
				// Verified on both: with this flag, v22.23.1 and v24.18.0 emit the same
				// `ℹ pass N` summary and the same `✖ <name>` failure lines.
				//
				// `spec` rather than `tap` because the failure message below is only as
				// good as the names it can extract, and TAP collapses a failing FILE to
				// one `not ok <path>` with the case names dropped. The destination is
				// spelled out for the same reason as the reporter: today it defaults to
				// stdout, and "today's default" is precisely what broke this.
				'--test-reporter=spec',
				'--test-reporter-destination=stdout',
				'--import',
				SHIM_URL,
				'--import',
				'./dist/tests/install-test-host.js',
				'--test',
				'dist/tests/**/*.test.js',
			],
			{ cwd: ROOT, encoding: 'utf8', env: childEnv(days) }
		);

		// EXIT 0 IS NOT ENOUGH, and this is not a hypothetical. The first draft
		// passed `process.env` straight through, which carries the OUTER runner's
		// `NODE_TEST_CONTEXT=child-v8`. A `node --test` that inherits it reports
		// itself as an already-managed child: no output, no tests run, exit 0. Both
		// shifts went green in 26ms — a whole suite takes about a second — so the
		// guard was reporting a pass for a run that never happened, which is the
		// exact shape of failure it exists to catch. Read the count, not the code.
		const out = `${r.stdout ?? ''}`;
		const passed = /^ℹ pass (\d+)$/m.exec(out);

		// "The child ran nothing" and "the child answered in a format this cannot
		// read" are two different jobs, and saying so is the difference between a
		// fix and an afternoon. Conflating them is what made the CI failure look
		// like a vacuous run when the TAP body on screen showed 835 passing tests.
		const tapSummary = /^# pass (\d+)$/m.exec(out);
		assert.ok(
			passed || !tapSummary,
			`The child emitted TAP although it was asked for \`--test-reporter=spec\`, ` +
				`so this could not read its summary. It ran fine — ${tapSummary?.[1]} tests ` +
				`passed at +${days} days. The reporter pin is what needs fixing, not a ` +
				`fixture. Running ${process.version}.`
		);

		assert.ok(
			passed && Number(passed[1]) > 0,
			`The shifted run reported no passing tests, so nothing was actually ` +
				`exercised at +${days} days. Exit ${r.status} means nothing on its own ` +
				`here. Running ${process.version}.\nstdout: ${out.slice(0, 1000)}\nstderr: ${`${r.stderr ?? ''}`.slice(0, 1000)}`
		);

		if (r.status !== 0) {
			// Name the tests. A bare exit code here reproduces the thing that made
			// #27 expensive: a gate that says something is wrong without saying what,
			// so the finding has to be re-derived by hand. This reads the `spec`
			// reporter the child was pinned to above; when a file fails to LOAD no
			// reporter can name the cases inside it, so the stderr tail below is
			// appended rather than assumed redundant.
			const failed = [
				...new Set(
					out
						.split('\n')
						.filter((l) => l.includes('✖'))
						.map((l) =>
							l
								.replace('✖', '')
								.replace(/\s*\([0-9.]+ms\)\s*$/, '')
								.trim()
						)
						.filter((l) => l && l !== 'failing tests:')
				),
			];
			assert.fail(
				`The suite passes today and fails with the clock ${days} days ahead, which ` +
					`means a fixture is pinned to an absolute date that the retention cutoff ` +
					`will reach on its own. Anchor it to \`Date.now()\` the way 473dfdb did ` +
					`(see the header of src/tests/warm-cache.test.ts).\n` +
					(failed.length
						? failed.join('\n')
						: `exit ${r.status}, and the reporter named nothing.`) +
					// A file that fails to LOAD prints its reason here and nowhere the
					// reporter can see it. Dropping stderr would turn a syntax error into
					// "a fixture has an expiry date", which is a wrong diagnosis rather
					// than a missing one.
					(r.stderr ? `\n--- child stderr ---\n${`${r.stderr}`.slice(-2000)}` : '')
			);
		}
	});
}

// --- the weak half: the declared list for scripts/**/*.test.mjs --------------

/**
 * Every `scripts/**\/*.test.mjs` holding an absolute ISO date, and why it is
 * inert. Each reason was checked against the MODULE UNDER TEST, not against the
 * test's own prose: in every case below the reader takes its clock as a
 * parameter (`now`/`nowMs`, defaulted to `Date.now()`) and the test passes one,
 * so the real calendar never reaches the comparison.
 *
 * Verified 2026-09-15 by running this half at +30, +90, +365 and +4000 days:
 * identical pass counts at every shift, so nothing here is merely passing
 * because it went vacuous.
 */
const DECLARED = new Map([
	[
		'scripts/lib/doctor-write.test.mjs',
		'`$capabilities.at` is carried into the written record and asserted verbatim. ' +
			'Nothing anywhere ages a capability stamp — there is no staleness window on it.',
	],
	[
		'scripts/lib/doctor.test.mjs',
		'`doctorFindings(health, { nowMs })` takes its clock; the test pins NOW and the ' +
			'`at` stamps are read against that, never against the real one.',
	],
	[
		'scripts/lib/drain-enforcement.test.mjs',
		'`drainViolations` has no clock at all. It compares a job `startedAt` string to a ' +
			'drain `since` string, so both sides move together or neither does.',
	],
	[
		'scripts/lib/egress-slices-guard.test.mjs',
		'`pm_uptime` is mapped straight to `uptimeMs` and reported. Nothing subtracts it ' +
			'from now, so it is a value being carried, not an age.',
	],
	[
		'scripts/lib/enroll-node.test.mjs',
		'`recordedAt` is carried through the enrollment record and asserted verbatim.',
	],
	[
		'scripts/lib/enrollment-record.test.mjs',
		'`recordedAt` is a REQUIRED_FIELD, checked for PRESENCE and shape. No code reads ' +
			'its value as an age — an enrollment record is never expired, only replaced.',
	],
	[
		'scripts/lib/expected-down.test.mjs',
		'`deferralFor(node, drains, now)` takes its clock; the test pins NOW.',
	],
	[
		'scripts/lib/label-floor.test.mjs',
		'The `at` stamps are compared to EACH OTHER — a transition cause is asserted to be ' +
			'the stamp that produced it. No clock is involved on either side.',
	],
	[
		'scripts/lib/orphan-removal.test.mjs',
		'The `started=` line inside the `.removing` marker is never parsed. ' +
			'clean-runner-debris.sh sweeps on the PRESENCE of that file next to a missing ' +
			'`.runner`, and its one age rule (`-mtime +$DIAG_KEEP_DAYS`) reads filesystem ' +
			'mtime on logs the test creates fresh, not this string.',
	],
	[
		'scripts/lib/queue-health.test.mjs',
		'`nowMs` is a parameter and every case passes one. The ceiling, ZOMBIE_SECONDS and ' +
			'the skew band are all measured against it.',
	],
	[
		'scripts/lib/roster-eligibility.test.mjs',
		'`autoIncludeDrop(repo, ai, probe, now)` takes its clock and the test pins NOW. The ' +
			'January `pushedAt` values are deliberately ancient — being stale IS the case ' +
			'under test, the same exception 473dfdb kept for its 2020 record.',
	],
	[
		'scripts/lib/service-inventory.test.mjs',
		'`at` is echoed through the inventory it builds and asserted verbatim.',
	],
	[
		'scripts/lib/zero-scan-guard.test.mjs',
		'The `pushedAt` sits on an ARCHIVED repo, which reconcile drops before any age ' +
			'check runs, and the assertion is that NOTHING is covered — an outcome the age ' +
			'rule cannot change in either direction.',
	],
]);

/** An ISO date with at least hours and minutes, which is what a fixture carries. */
const ABSOLUTE_ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Every `*.test.mjs` under `scripts/`, relative to the repo root. */
function testFiles(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...testFiles(full));
		else if (entry.name.endsWith('.test.mjs')) out.push(relative(ROOT, full));
	}
	return out;
}

/** The absolute ISO dates in `file`'s CODE, comments blanked. */
function absoluteDatesIn(file) {
	const code = blankComments(readFileSync(join(ROOT, file), 'utf8'));
	return code.split('\n').flatMap((line, i) => {
		const m = ABSOLUTE_ISO.exec(line);
		return m ? [`${file}:${i + 1}: ${m[0]}`] : [];
	});
}

test('every absolute date in the scripts half is declared inert, with a reason', () => {
	const files = testFiles(join(ROOT, 'scripts')).filter(
		(f) => f !== relative(ROOT, fileURLToPath(import.meta.url))
	);
	assert.ok(files.length > 0, 'no scripts/**/*.test.mjs were scanned at all — that is a failure');

	const withDates = files.filter((f) => absoluteDatesIn(f).length > 0);

	const undeclared = withDates.filter((f) => !DECLARED.has(f));
	assert.deepEqual(
		undeclared,
		[],
		`These files gained an absolute ISO date in a fixture. Either anchor it to ` +
			`\`Date.now()\`, or add it to DECLARED above with the reason the reader it ` +
			`feeds cannot age it out — checked against that reader, not against the ` +
			`fixture.\n${undeclared.flatMap(absoluteDatesIn).join('\n')}`
	);

	const stale = [...DECLARED.keys()].filter((f) => !withDates.includes(f));
	assert.deepEqual(
		stale,
		[],
		'These files are declared as carrying an absolute date and no longer do. Drop the ' +
			'entry: a list that keeps names nothing matches stops being read, and the next ' +
			'person cannot tell a live exemption from a dead one.'
	);
});
