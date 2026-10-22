/**
 * check-boundary-contracts, exercised as a CLI over shimmed `gh` and `ssh`.
 *
 * #80 — the last one-shot `gh api` reads retry before could-not-look.
 * `check-boundary-contracts.mjs` makes three kinds of `gh api` call (the runs
 * listing, the jobs listing, the runners listing) and WRITES NOTHING — see its
 * own "WHAT IT DOES NOT DO" header. Before #80 each was a single unbounded
 * `execFileSync` with no timeout at all, so a true hang could burn this gate's
 * whole `check:boundary-contracts` wrapper budget (300s in audit-gates.ts)
 * with no report written. Each is now retried per `READ_ATTEMPTS` with a
 * bounded per-attempt timeout, exactly as `check-fleet-preflight.mjs` and
 * `reconcile-runner-identity.mjs` already do for their own `gh` reads.
 *
 * #98 — the gate's blind spots, each pinned by a mutation that must exit 1:
 * empty listings, elements past `[0]`, every standing runner, a malformed label
 * that used to CRASH the gate, the `●` systemctl marks a failed unit with, and
 * a manifest that selects zero nodes.
 *
 * Both binaries are shims on PATH that log every call. The manifest names one
 * node, `fixture-node`, which is never this host, so `runOn` takes the ssh path
 * and reaches the shim — nothing here leaves the fixture directory.
 *
 * NOTHING HERE SPAWNS git. See lib/hook-safe-tests.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { READ_ATTEMPTS } from './lib/queue-health.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'check-boundary-contracts.mjs');
const REPO = 'WolffM/fixture-boundary';
const NODE = 'fixture-node';

/**
 * ANCHORED TO NOW, never a literal date — see lib/fixture-clock-guard.test.mjs:
 * an absolute ISO date in a fixture eventually crosses a retention window
 * somewhere and turns green weeks later with nobody touching the file. The
 * gate under test only checks this field is a present string (`field(..., 'created_at', 'string')`
 * in check-boundary-contracts.mjs), never its age, so the offset is arbitrary.
 */
const RUN_CREATED_AT = new Date(Date.now() - 5 * 60_000).toISOString();

const RUNS_JSON = JSON.stringify({
	workflow_runs: [
		{ id: 1, status: 'queued', created_at: RUN_CREATED_AT },
		{ id: 2, status: 'completed', created_at: RUN_CREATED_AT },
	],
});
const JOBS_JSON = JSON.stringify({ jobs: [{ status: 'queued', labels: ['self-hosted'] }] });
const runner = (over = {}) => ({
	id: 1,
	name: 'standing',
	status: 'online',
	busy: false,
	labels: [{ name: 'self-hosted' }],
	...over,
});
const RUNNERS_JSON = JSON.stringify({ runners: [runner()] });

/**
 * A `gh` that logs every call, answers all three reads from env (each with a
 * clean default), and can be told to fail one of them (`runs`, `jobs` or
 * `runners`) a fixed number of times before it recovers — a counter FILE
 * rather than an in-memory one, because each invocation is a fresh process.
 * `GH_NOJOBS_IDS` names runs whose jobs listing is empty.
 */
const GH_SHIM = `#!/usr/bin/env bash
argv="$*"
printf '%s\\n' "$argv" >> "$GH_LOG"

match=""
case "$argv" in
	*"/actions/runs?per_page="*) match="runs" ;;
	*"/jobs"*) match="jobs" ;;
	*"/actions/runners"*) match="runners" ;;
esac

if [ -n "$match" ] && [ "$match" = "\${GH_FAIL_WHAT:-}" ]; then
	count_file="$GH_COUNT_DIR/$match"
	n=0
	[ -f "$count_file" ] && n=$(cat "$count_file")
	n=$((n + 1))
	echo "$n" > "$count_file"
	if [ "$n" -le "\${GH_FAIL_TIMES:-999}" ]; then
		echo "gh: ETIMEDOUT waiting for api.github.com" >&2
		exit 1
	fi
fi

case "$match" in
	runs)
		# Honour per_page the way the API does, so a gate that asks for one run
		# gets one run.
		per=$(printf '%s' "$argv" | sed -E 's#.*per_page=([0-9]+).*#\\1#')
		node -e 'const o = JSON.parse(process.argv[1]); if (Array.isArray(o.workflow_runs)) o.workflow_runs = o.workflow_runs.slice(0, Number(process.argv[2])); const doc = JSON.stringify(o); process.stdout.write(doc);' "$GH_RUNS_JSON" "$per" ;;
	jobs)
		id=$(printf '%s' "$argv" | sed -E 's#.*/runs/([0-9]+)/jobs.*#\\1#')
		case " \${GH_NOJOBS_IDS:-} " in
			*" $id "*) echo '{"jobs":[]}' ;;
			*) printf '%s\\n' "$GH_JOBS_JSON" ;;
		esac ;;
	runners) printf '%s\\n' "$GH_RUNNERS_JSON" ;;
	*) echo '{}' ;;
esac
`;

/**
 * An `ssh` that answers the two node probes and nothing else.
 *
 * The list-units answer EMULATES systemctl rather than echoing a fixture:
 * without `--plain`, a line whose unit is failed starts with `●` and every other
 * line with two spaces — measured on this workstation with `--no-legend` into a
 * pipe, 2026-10-10. That is the shape that hid failed units from the parser.
 */
const SSH_SHIM = `#!/usr/bin/env bash
script=$(cat)
printf '%s\\n' "$*" >> "$SSH_LOG"
case "$script" in
	*"free -m"*) echo "\${SSH_FREE_MB:-4096}" ;;
	*"list-units"*)
		[ -f "$SSH_UNITS_FILE" ] || exit 0
		while IFS= read -r line; do
			[ -z "$line" ] && continue
			case "$script" in
				*"--plain"*) printf '%s\\n' "$line" ;;
				*)
					case "$line" in
						*" failed "*) printf '● %s\\n' "$line" ;;
						*) printf '  %s\\n' "$line" ;;
					esac ;;
			esac
		done < "$SSH_UNITS_FILE" ;;
	*) exit 1 ;;
esac
`;

function fixture({ machines = { [NODE]: { role: 'claw' } } } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'boundary-contracts-'));
	writeFileSync(join(root, 'fleet-runner-manifest.json'), JSON.stringify({ machines }));
	const bin = join(root, 'bin');
	const counts = join(root, 'counts');
	mkdirSync(bin, { recursive: true });
	mkdirSync(counts, { recursive: true });
	for (const [name, body] of [
		['gh', GH_SHIM],
		['ssh', SSH_SHIM],
	]) {
		const p = join(bin, name);
		writeFileSync(p, body);
		chmodSync(p, 0o755);
	}
	return {
		root,
		bin,
		counts,
		ghLog: join(root, 'gh.log'),
		sshLog: join(root, 'ssh.log'),
		unitsFile: join(root, 'units.txt'),
	};
}

function cleanup(fx) {
	rmSync(fx.root, { recursive: true, force: true });
}

/** One gate run. Returns the exit code and stdout+stderr combined — never throws. */
function run(
	fx,
	{
		failWhat = '',
		failTimes = '',
		runs = RUNS_JSON,
		jobs = JOBS_JSON,
		runners = RUNNERS_JSON,
		noJobsIds = '',
		units = null,
	} = {}
) {
	if (units !== null) writeFileSync(fx.unitsFile, units);
	const env = {
		...process.env,
		PATH: `${fx.bin}:${process.env.PATH}`,
		FLEET_MANIFEST_DIR: fx.root,
		// The drain file is read from the state dir; point it at the fixture so the
		// operator's real drains never decide a test.
		HADOKU_STATE_DIR: fx.root,
		BOUNDARY_PROBE_REPO: REPO,
		GH_LOG: fx.ghLog,
		GH_COUNT_DIR: fx.counts,
		GH_FAIL_WHAT: failWhat,
		GH_FAIL_TIMES: String(failTimes),
		GH_RUNS_JSON: runs,
		GH_JOBS_JSON: jobs,
		GH_RUNNERS_JSON: runners,
		GH_NOJOBS_IDS: noJobsIds,
		SSH_LOG: fx.sshLog,
		SSH_UNITS_FILE: fx.unitsFile,
	};
	try {
		const out = execFileSync('node', [GATE], {
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
	}
}

/** Run one fixture, always cleaning up. */
function withFixture(opts, fn) {
	const fx = fixture(opts);
	try {
		fn(fx);
	} finally {
		cleanup(fx);
	}
}

/** How many logged calls matched this substring. */
function attempts(logPath, substr) {
	if (!existsSync(logPath)) return 0;
	return readFileSync(logPath, 'utf8')
		.split('\n')
		.filter((l) => l.includes(substr)).length;
}

const RUNS_CALL = '/actions/runs?per_page=';
const JOBS_CALL = '/jobs';
const RUNNERS_CALL = '/actions/runners';

/**
 * Why a run is NOT a clean finding matching `pattern`, or null when it is: it
 * failed, named the broken contract, and did not crash. Returned rather than
 * asserted so each test's own `assert` is visible to the vacuity guard.
 */
function missedFinding(r, pattern) {
	if (r.code !== 1) return `expected the gate to fail, got ${r.code}:\n${r.out}`;
	if (!/boundary contract\(s\) broken/.test(r.out)) return `no broken-contract report:\n${r.out}`;
	if (!pattern.test(r.out)) return `no finding matching ${pattern}:\n${r.out}`;
	if (/TypeError|at file:\/\//.test(r.out)) return `a crash, not a finding:\n${r.out}`;
	return null;
}

// ── the floor: a clean fixture must pass, costing one attempt per read ──────

test('a clean fixture exits 0, and nothing is retried on the success path', () => {
	withFixture({}, (fx) => {
		const r = run(fx);
		assert.equal(r.code, 0, `expected a clean run to pass, got ${r.code}:\n${r.out}`);
		assert.equal(
			attempts(fx.ghLog, RUNS_CALL),
			1,
			'the retry must cost nothing when nothing fails'
		);
		assert.equal(attempts(fx.ghLog, JOBS_CALL), 1);
		assert.equal(attempts(fx.ghLog, RUNNERS_CALL), 1);
		assert.match(r.out, /1 machine\(s\)/);
	});
});

// ── (a) a one-shot failure that recovers must not fail the gate ────────────

for (const [label, failWhat, call] of [
	['runs', 'runs', RUNS_CALL],
	['jobs', 'jobs', JOBS_CALL],
	['runners', 'runners', RUNNERS_CALL],
]) {
	test(`the ${label} read times out once and recovers: no finding, exit 0`, () => {
		withFixture({}, (fx) => {
			const r = run(fx, { failWhat, failTimes: 1 });
			assert.equal(r.code, 0, `a transient blip that recovered must not fail the gate:\n${r.out}`);
			assert.equal(attempts(fx.ghLog, call), 2, 'must have been retried exactly once');
			assert.doesNotMatch(r.out, /boundary contract\(s\) broken/);
		});
	});
}

// ── (b) retrying is NOT tolerating: every attempt failing still fails ──────

for (const [label, failWhat, call] of [
	['runs', 'runs', RUNS_CALL],
	['jobs', 'jobs', JOBS_CALL],
	['runners', 'runners', RUNNERS_CALL],
]) {
	test(`a ${label} read that never recovers fails the gate after READ_ATTEMPTS, naming why`, () => {
		withFixture({}, (fx) => {
			const r = run(fx, { failWhat, failTimes: 999 });
			assert.equal(r.code, 1, `a read that never recovers must fail the gate:\n${r.out}`);
			assert.equal(
				attempts(fx.ghLog, call),
				READ_ATTEMPTS,
				`must be tried exactly ${READ_ATTEMPTS} times before it is called broken`
			);
			assert.match(r.out, /boundary contract\(s\) broken/);
			assert.match(r.out, /ETIMEDOUT/, 'the finding must carry WHY the read failed');
			assert.match(r.out, /attempt 2\/2/, 'the finding must say the failure survived the retry');
		});
	});
}

// ── (c) #98: an empty listing proves no shape ─────────────────────────────────

test('an EMPTY runs listing fails — nothing was checked', () => {
	withFixture({}, (fx) => {
		assert.equal(
			missedFinding(
				run(fx, { runs: '{"workflow_runs":[]}' }),
				/\/actions\/runs: the listing is EMPTY/
			),
			null
		);
	});
});

test('an EMPTY runners listing fails — nothing was checked', () => {
	withFixture({}, (fx) => {
		assert.equal(
			missedFinding(run(fx, { runners: '{"runners":[]}' }), /\/runners: the listing is EMPTY/),
			null
		);
	});
});

test('every run is type-checked, not only [0]', () => {
	const runs = JSON.stringify({
		workflow_runs: [
			{ id: 1, status: 'queued', created_at: RUN_CREATED_AT },
			{ id: 2, status: 'queued', created_at: 12345 },
		],
	});
	withFixture({}, (fx) => {
		assert.equal(
			missedFinding(run(fx, { runs }), /\/actions\/runs\[1\]: `created_at` is number/),
			null
		);
	});
});

test('a run with no jobs is passed over for one that has them', () => {
	withFixture({}, (fx) => {
		const r = run(fx, { noJobsIds: '1' });
		assert.equal(r.code, 0, r.out);
		assert.equal(attempts(fx.ghLog, JOBS_CALL), 2, 'run 1 had no jobs, so run 2 is read');
	});
});

test('when NO listed run has jobs, the jobs shape went unchecked — a finding', () => {
	withFixture({}, (fx) => {
		assert.equal(
			missedFinding(run(fx, { noJobsIds: '1 2' }), /none of the 2 run\(s\) listed had any jobs/),
			null
		);
	});
});

test('every job is type-checked, and its labels must be STRINGS', () => {
	const jobs = JSON.stringify({
		jobs: [
			{ status: 'queued', labels: ['self-hosted'] },
			{ status: 'queued', labels: [{ name: 'self-hosted' }] },
		],
	});
	withFixture({}, (fx) => {
		assert.equal(
			missedFinding(run(fx, { jobs }), /\/jobs\[1\]\.labels\[\]: entries are not strings/),
			null
		);
	});
});

test('EVERY standing runner must carry self-hosted, not just the first', () => {
	const runners = JSON.stringify({
		runners: [runner(), runner({ id: 2, name: 'second', labels: [{ name: 'linux' }] })],
	});
	withFixture({}, (fx) => {
		assert.equal(missedFinding(run(fx, { runners }), /second lacks self-hosted/), null);
	});
});

test('a listing with NO standing runner is a finding — the assumption went unchecked', () => {
	const runners = JSON.stringify({ runners: [runner({ name: 'jit-claw-2-x-r1-1' })] });
	withFixture({}, (fx) => {
		assert.equal(
			missedFinding(run(fx, { runners }), /no readable standing \(non-jit\) runner/),
			null
		);
	});
});

test('a malformed label is REPORTED, not a crash that loses the finding', () => {
	// `l.name.toLowerCase()` ran after the shape check had already failed, and
	// threw — so the run died with a stack trace instead of naming the runner.
	const runners = JSON.stringify({
		runners: [runner(), runner({ id: 2, name: 'odd', labels: [{ id: 7 }] })],
	});
	withFixture({}, (fx) => {
		assert.equal(
			missedFinding(
				run(fx, { runners }),
				/\/runners\[1\]\.labels\[\]: entries have no string `name`/
			),
			null
		);
	});
});

// ── (d) #98: the systemctl listing the dispatcher reconstructs from ──────────

test('a FAILED jit unit is parsed, because the listing is asked for --plain', () => {
	// The shim marks a failed unit with `●` unless the command carries --plain,
	// exactly as systemctl does. Without the flag the parser dropped that line.
	withFixture({}, (fx) => {
		const r = run(fx, {
			units:
				'jit-claw-2-hadoku_site-r1-1787797100.service loaded active running a\n' +
				'jit-claw-2-hadoku_site-r2-1787797200.service loaded failed failed b\n',
		});
		assert.equal(r.code, 0, r.out);
		assert.equal(attempts(fx.sshLog, NODE), 2, 'free -m and list-units both reached the node');
	});
});

test('a line naming a jit unit the parser would DROP is a finding', () => {
	withFixture({}, (fx) => {
		assert.equal(
			missedFinding(
				run(fx, {
					units:
						'jit-claw-2-x-r1-1787797100.service loaded active running a\n' +
						'?? jit-claw-2-x-r2-1787797200.service loaded failed failed b\n',
				}),
				/line\(s\) naming a jit unit the parser would drop/
			),
			null
		);
	});
});

test('non-empty listing output that parses to ZERO units is a finding', () => {
	withFixture({}, (fx) => {
		assert.equal(
			missedFinding(
				run(fx, { units: 'Failed to connect to bus: No medium found\n' }),
				/parsed to ZERO units/
			),
			null
		);
	});
});

// ── (e) #98: zero nodes probed is not a pass ──────────────────────────────────

test('a manifest that selects ZERO nodes fails, rather than reporting "0 machine(s)"', () => {
	withFixture({ machines: {} }, (fx) => {
		assert.equal(missedFinding(run(fx), /selected ZERO nodes to probe/), null);
	});
});

test('zero nodes probed is fine when every node was skipped as a guest — and it is said', () => {
	withFixture({ machines: { [NODE]: { role: 'guest' } } }, (fx) => {
		const r = run(fx);
		assert.equal(r.code, 0, r.out);
		assert.match(r.out, /fixture-node \[skipped: guest\]/);
		assert.equal(attempts(fx.sshLog, NODE), 0, 'a guest is never reached');
	});
});
