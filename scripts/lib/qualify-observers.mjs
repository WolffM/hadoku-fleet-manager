/**
 * `busy-counters` — does every reader in this package that counts a node's
 * live CI jobs actually see one? (wave bootcamp2 Q5)
 *
 * THE BUG IT GUARDS. claw-1, claw-2 and claw-3 mount /proc
 * `hidepid=invisible`: a user sees only its OWN processes there. Jobs run as
 * the `ci` role, so a reader that runs as `admin` without `sudo` counts 0 with
 * jobs live. A claw-2 reboot passed its idle check with two jobs running
 * (dd7edde, 6832d28, found 11-07). Each reader was fixed by reading its code;
 * this test reads them by EXECUTING them.
 *
 * HOW. The test acts as `admin` (passwordless sudo on every claw). It starts a
 * DECOY owned by the ci user that looks to every reader like a job: a copy of
 * bash named `Runner.Worker` (so `pgrep -x` matches its comm) whose argv
 * carries `.../bin/Runner.Worker ... spawnclient 0 0` (so the `-f` readers
 * and the fast loop's ` spawnclient ` filter match too). It blocks on a fifo
 * of its own with `read -t`, a builtin, so it has no child to leak and ends by
 * itself after DECOY_LIFETIME_SEC whatever happens to the controller. Each
 * reader's REAL command then runs once before the decoy and once beside it,
 * in the role that reader uses in production, and must count one more.
 *
 *   - a reader that counts no more            → fail, naming it and its role
 *   - a reader that could not count at all    → could-not-look, naming it
 *   - the decoy could not be started          → could-not-look
 *
 * THE DECOY IS KILLED BY ITS PID, on every path, and only after its own
 * cmdline is checked to be the binary in the directory this test made: never
 * a pattern kill, so a real job can never be the one killed. The node is
 * drained for a qualification, so a decoy is never offered work, and it must
 * never outlive the test (`minutes` covers its lifetime).
 *
 * WHERE EACH COMMAND COMES FROM. Imported where it is exported. Taken from the
 * real generated script or shell file where it is a line of one (sampler,
 * doctor, cutover, capability-probe.sh, benchmark-node.sh); a reader that
 * moved makes that extraction THROW, which is a could-not-look naming it.
 * COPIED only where it lives inside a CLI (importing a CLI runs it) or in
 * another domain (hosting-ci-rank is tenancy); qualify-observers.test.mjs
 * reads each copy's source file and fails the build if it drifts.
 *
 * Readers that are NOT run, and why, are listed in NOT_RUN; the test file
 * holds every `pgrep ... Runner.Worker` in src/ and scripts/ to one list or
 * the other, so a new reader cannot appear without a decision.
 */
import { readFileSync } from 'node:fs';

import { parseProbe, PROBE_CMD } from '../../dist/lib/node-probe.js';
import { nodeHome, nodeUser } from '../../dist/lib/node-users.js';
import { CI_WORKERS_FN } from '../../dist/perf-probe.js';
import { BUSY_CHECK_SCRIPT } from './capability-seeds.mjs';
import { doctorProbe } from './doctor-probe.mjs';
import { inventoryScript } from './node-users-cutover.mjs';
import { QUALIFY_TTL_DAYS } from './qualify-registry.mjs';
import { startSamplerScript } from './qualify-sampler.mjs';

/** Seconds the decoy lives if nothing kills it; inside `minutes` below. */
export const DECOY_LIFETIME_SEC = 270;
/** The ceiling on one reader, so one hung reader cannot eat the window. */
export const READER_TIMEOUT_SEC = 60;

/**
 * COPIED from drain-wait.mjs `busyCount`, drain-node.mjs and retire-node.mjs
 * (`PROBE`), and traffic-status.mjs: the same text in four places, none of
 * them exported. The test file holds each to this string.
 */
export const PLAIN_PGREP = 'pgrep -c -f "[R]unner\\.Worker" || true';

/**
 * COPIED from hosting-ci-rank.mjs `CI_OBSERVE_SCRIPT` (tenancy; lifecycle may
 * not import it): the `SEE` line and the `ciWorkers` line, without the rank
 * loop, which counts listeners too and decides nothing about "busy".
 */
export const HOSTING_CI_WORKERS = `SEE='sudo -n'
if $SEE true 2>/dev/null; then
echo "ciWorkers=$($SEE pgrep -cx 'Runner\\.Worker' || true)"
fi`;

const SCRIPTS = new URL('../', import.meta.url);

const firstInt = (out) => {
	const n = parseInt(String(out).trim().split('\n')[0], 10);
	return Number.isFinite(n) ? n : null;
};
/** A bare count, or null for anything that is not one (`U`, `unknown`, empty). */
const bareCount = (out) => {
	const s = String(out).trim();
	return /^\d+$/.test(s) ? Number(s) : null;
};

/** The one line of `text` that starts with `prefix`; THROWS unless there is exactly one. */
export function lineStarting(text, prefix, where) {
	const hits = String(text)
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.startsWith(prefix));
	if (hits.length !== 1)
		throw new Error(
			`${where}: expected one line starting ${JSON.stringify(prefix)}, found ${hits.length}`
		);
	return hits[0];
}

/** A shell function `name() {` ... `}` at column 0 of `text`; THROWS if absent. */
export function shellFunction(text, name, where) {
	const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(String(text));
	if (!m) throw new Error(`${where}: no ${name}() function`);
	return m[0];
}

const readScript = (name) => readFileSync(new URL(name, SCRIPTS), 'utf8');

/**
 * Every reader this test runs. `role` is what it acts as in production:
 * `ci`, `admin`, or `root` (admin through `sudo -n`, for a script production
 * runs under sudo). `script(users)` builds its real command; `parse` turns its
 * stdout into a count, or null for "could not count". `max: 1` marks a reader
 * that answers busy/idle rather than a number.
 */
export const COUNTERS = Object.freeze([
	{
		id: 'busy-count',
		file: 'scripts/lib/drain-wait.mjs',
		use: 'busyCount: the idle wait of refresh-cycle, reboot-claws, bootcamp, benchmark and qualify',
		role: 'ci',
		script: () => PLAIN_PGREP,
		parse: firstInt,
	},
	{
		id: 'drain-status',
		file: 'scripts/drain-node.mjs',
		use: '`fleet drain --status`: whether a drained node has gone quiet',
		role: 'admin',
		script: () => PLAIN_PGREP,
		parse: firstInt,
	},
	{
		id: 'retire-busy',
		file: 'scripts/retire-node.mjs',
		use: '`fleet retire`: running jobs before a node is retired',
		role: 'admin',
		script: () => PLAIN_PGREP,
		parse: firstInt,
	},
	{
		id: 'traffic-status',
		file: 'scripts/traffic-status.mjs',
		use: '`fleet traffic`: jobs running per node',
		role: 'admin',
		script: () => PLAIN_PGREP,
		parse: firstInt,
	},
	{
		id: 'fast-loop-probe',
		file: 'src/lib/node-probe.ts',
		use: "probeNode: the dispatcher's free slots",
		role: 'ci',
		script: () => PROBE_CMD,
		parse: (out) => parseProbe(out)?.workers ?? null,
	},
	{
		id: 'perf-workers',
		file: 'src/perf-probe.ts',
		use: 'the 5-minute perf sample and perf-active (`ciw`)',
		role: 'admin',
		script: () => `${CI_WORKERS_FN}\nciw`,
		parse: bareCount,
	},
	{
		id: 'qualify-sampler',
		file: 'scripts/lib/qualify-sampler.mjs',
		// Runs as the role of the test that samples; concurrency-ramp (Q1) is ci.
		use: "ctx.sample's `workers` column",
		role: 'ci',
		script: () =>
			`${lineStarting(startSamplerScript(), 'workers() {', 'qualify-sampler.mjs')}\nworkers`,
		parse: bareCount,
	},
	{
		id: 'bootcamp-live-workers',
		file: 'scripts/capability-probe.sh',
		use: "bootcamp's `live_workers`, which voids an idle-only measurement",
		role: 'ci',
		script: () =>
			`${shellFunction(readScript('capability-probe.sh'), 'live_workers', 'capability-probe.sh')}\nlive_workers`,
		parse: bareCount,
	},
	{
		id: 'seed-busy',
		file: 'scripts/lib/capability-seeds.mjs',
		use: 'BUSY_CHECK_SCRIPT: a seed is skipped while a job is live',
		role: 'ci',
		script: () => BUSY_CHECK_SCRIPT,
		parse: (out) => ({ BUSY: 1, IDLE: 0 })[String(out).trim()] ?? null,
		max: 1,
	},
	{
		id: 'doctor-busy',
		file: 'scripts/lib/doctor-probe.mjs',
		use: "doctor's `runners.busy`, which gates the 60 s all-core load",
		role: 'admin',
		script: () => {
			const busy = doctorProbe({ loadSeconds: 0 })
				.split('\n')
				.filter((l) => l.startsWith('BUSY='));
			if (!busy.length) throw new Error('doctor-probe.mjs: no BUSY= line in doctorProbe()');
			return `${busy.join('\n')}\necho "$BUSY"`;
		},
		parse: bareCount,
	},
	{
		id: 'hosting-ci-workers',
		file: 'scripts/lib/hosting-ci-rank.mjs',
		use: "hosting's `ciWorkers` on a whole-box hosting node",
		role: 'admin',
		script: () => HOSTING_CI_WORKERS,
		parse: (out) => {
			const m = /^ciWorkers=(\d+)$/m.exec(String(out));
			return m ? Number(m[1]) : null;
		},
	},
	{
		id: 'cutover-busy',
		file: 'scripts/lib/node-users-cutover.mjs',
		use: "the node-users cutover's preflight `busy`",
		role: 'admin',
		script: (users) =>
			`${lineStarting(inventoryScript(users), 'busy=', 'node-users-cutover.mjs')}\necho "\${busy:-U}"`,
		parse: bareCount,
	},
	{
		id: 'benchmark-busy',
		file: 'scripts/benchmark-node.sh',
		use: '`fleet benchmark` refuses a node that is building',
		// benchmark-measure.mjs feeds it to `sudo sh -s` over the admin login.
		role: 'root',
		shell: 'sh',
		script: () => {
			const sh = readScript('benchmark-node.sh');
			return [
				lineStarting(sh, 'count0() {', 'benchmark-node.sh'),
				lineStarting(sh, 'BUSY=$(count0', 'benchmark-node.sh'),
				'echo "$BUSY"',
			].join('\n');
		},
		parse: bareCount,
	},
]);

/**
 * Readers that count jobs and are NOT run here, each with why. The test file
 * holds the source tree's `pgrep ... Runner.Worker` sites to COUNTERS + this.
 */
export const NOT_RUN = Object.freeze({
	'scripts/ci-throttle.sh': 'runs inside a job, as ci, and counts the OTHER jobs beside its own',
	'scripts/job-metrics.sh':
		'runs inside a job, as ci, and attributes the OTHER jobs beside its own',
	'scripts/clean-runner-debris.sh':
		'a cleaner (it deletes), so it cannot be run to read; its count is inline and runs as ci',
	'scripts/ci-throttle-install.sh': 'an installer; asks per runner directory before restarting it',
	'scripts/runners-slice-install.sh': 'an installer; asks per runner directory before moving it',
	'deploy/systemd/install-ci-runner-slice.sh':
		'an installer; asks per runner directory before moving it',
	'src/runners/ephemeral-exec.ts': 'asks about one warm slot path, not the node',
	'scripts/lib/toolchain-backstop.mjs': 'asks about each runner directory, not the node',
	'scripts/stress-node.sh': 'run by hand ON the node, as whoever runs it',
});

const DELIM = 'Q5_OBSERVER_SCRIPT_END';

/**
 * Wrap `script` to run as `role` from an admin login, under `shell` (bash, or
 * sh for a script production feeds to `sh -s`). A ci played by the admin user
 * (a node not yet cut over) runs as-is.
 */
export function asRole(role, script, { adminUser, ciUser }, { shell = 'bash' } = {}) {
	if (shell !== 'bash' && shell !== 'sh') throw new Error(`unknown shell ${shell}`);
	if (String(script).split('\n').includes(DELIM))
		throw new Error(`the script contains the heredoc delimiter ${DELIM}`);
	let run;
	if (role === 'admin' || (role === 'ci' && ciUser === adminUser)) run = `${shell} -s`;
	else if (role === 'ci') run = `sudo -n -H -u '${ciUser}' ${shell} -s`;
	else if (role === 'root') run = `sudo -n ${shell} -s`;
	else throw new Error(`unknown role ${role}`);
	const body = role === 'ci' && ciUser !== adminUser ? `cd ~ 2>/dev/null\n${script}` : script;
	return `timeout ${READER_TIMEOUT_SEC} ${run} <<'${DELIM}'\n${body}\n${DELIM}`;
}

/**
 * One script that runs every built reader in its role and prints each one's
 * stdout between `Q5-BEGIN <id>` and `Q5-END <id> <rc>`. The END starts on a
 * fresh line: PROBE_CMD ends in a bare `printf`, and an END glued to its last
 * field read the fast loop's probe as silent (claw-2, 2026-11-11).
 */
export function readersScript(built, users) {
	return built
		.map((c) =>
			[
				`echo "Q5-BEGIN ${c.id}"`,
				asRole(c.role, c.text, users, { shell: c.shell }),
				`rc=$?; printf '\\nQ5-END %s %s\\n' '${c.id}' "$rc"`,
			].join('\n')
		)
		.join('\n');
}

/** PURE. `id → { out, rc }` from readersScript's output; an id with no END is absent. */
export function parseReaders(stdout) {
	const res = {};
	let cur = null;
	let lines = [];
	for (const l of String(stdout).split('\n')) {
		const b = /^Q5-BEGIN (\S+)$/.exec(l);
		const e = /^Q5-END (\S+) (\d+)$/.exec(l);
		if (b) {
			cur = b[1];
			lines = [];
		} else if (e && e[1] === cur) {
			res[cur] = { out: lines.join('\n'), rc: Number(e[2]) };
			cur = null;
		} else if (cur) lines.push(l);
	}
	return res;
}

/**
 * The script that starts the decoy as ci. Prints `DECOY <pid> <dir>`, or
 * `DECOY-FAILED <why>`. `spawnclient: false` drops the job-shaped argv tail:
 * the suite's own real-shell test uses it, so a test run on a claw is never a
 * phantom job to the fast loop (node-probe.ts, claw-6 2026-10-25).
 */
export function decoyStartScript(
	users,
	{ lifetimeSec = DECOY_LIFETIME_SEC, spawnclient = true } = {}
) {
	if (!Number.isInteger(lifetimeSec) || lifetimeSec < 1)
		throw new Error(`bad lifetime ${lifetimeSec}`);
	const tail = spawnclient ? ' spawnclient 0 0' : '';
	return asRole(
		'ci',
		[
			'set -u',
			'd=$(mktemp -d "${TMPDIR:-/tmp}/qualify-decoy.XXXXXX") || { echo "DECOY-FAILED mktemp refused"; exit 0; }',
			'if ! { mkdir "$d/bin" && cp "$(command -v bash)" "$d/bin/Runner.Worker" && mkfifo "$d/hold"; }; then',
			'  rm -rf "$d"; echo "DECOY-FAILED could not build it in $d"; exit 0',
			'fi',
			// `read -t` on a fifo it holds open read-write: blocks, no child, ends itself.
			`setsid "$d/bin/Runner.Worker" -c 'read -t "$1" <> "$0"' "$d/hold" ${lifetimeSec}${tail} </dev/null >/dev/null 2>&1 &`,
			'p=$!',
			'i=0; while [ "$(cat "/proc/$p/comm" 2>/dev/null)" != Runner.Worker ] && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done',
			'if [ "$(cat "/proc/$p/comm" 2>/dev/null)" = Runner.Worker ]; then echo "DECOY $p $d"',
			'else kill "$p" 2>/dev/null; rm -rf "$d"; echo "DECOY-FAILED pid $p never showed as Runner.Worker"; fi',
		].join('\n'),
		users
	);
}

const SAFE_DECOY_DIR = /^\/[A-Za-z0-9._/-]*\/qualify-decoy\.[A-Za-z0-9]+$/;

/** PURE. `{ pid, dir }` from the start script's output, or `{ why }`. */
export function parseDecoy(stdout) {
	const m = /^DECOY (\d+) (\S+)$/m.exec(String(stdout));
	if (m && SAFE_DECOY_DIR.test(m[2])) return { pid: Number(m[1]), dir: m[2] };
	const f = /^DECOY-FAILED (.*)$/m.exec(String(stdout));
	return { why: f ? f[1] : `the decoy start printed no pid: ${String(stdout).trim().slice(-200)}` };
}

/**
 * The script that kills exactly `pid`, and only while its argv[0] is the
 * binary in `dir`. Prints `DECOY-GONE <pid>` or `DECOY-ALIVE <pid>`.
 */
export function decoyStopScript(users, { pid, dir }) {
	if (!Number.isInteger(pid) || pid < 2) throw new Error(`refusing pid ${pid}`);
	if (!SAFE_DECOY_DIR.test(dir)) throw new Error(`refusing decoy dir ${JSON.stringify(dir)}`);
	return asRole(
		'ci',
		[
			`p=${pid}; d='${dir}'`,
			`mine() { [ "$(tr '\\0' '\\n' 2>/dev/null < "/proc/$p/cmdline" | head -n 1)" = "$d/bin/Runner.Worker" ]; }`,
			'if mine; then kill "$p" 2>/dev/null; i=0; while mine && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; mine && kill -9 "$p" 2>/dev/null; sleep 0.2; fi',
			'rm -rf "$d"',
			'if mine; then echo "DECOY-ALIVE $p"; else echo "DECOY-GONE $p"; fi',
		].join('\n'),
		users
	);
}

const roleLabel = (c) => (c.role === 'root' ? 'root (admin via sudo -n)' : c.role);

/**
 * PURE. The verdict over every reader's two readings.
 *
 * @param {{ id: string, role: string, baseline: number|null, withDecoy: number|null, why?: string, max?: number }[]} rows
 */
export function judgeCounters(rows) {
	const missed = [];
	const blind = [];
	for (const r of rows) {
		const who = `${r.id} (as ${roleLabel(r)})`;
		if (r.why) blind.push(`${who}: ${r.why}`);
		else if (r.baseline === null || r.withDecoy === null)
			blind.push(
				`${who}: could not count (baseline ${r.baseline ?? 'unreadable'}, with the decoy ${r.withDecoy ?? 'unreadable'})`
			);
		else if (r.max !== undefined && r.baseline >= r.max)
			blind.push(`${who}: already read busy without the decoy, so it cannot show it saw one`);
		else if (r.withDecoy < r.baseline + 1)
			missed.push(`${who} counted ${r.withDecoy} with a ci job live and ${r.baseline} without it`);
	}
	if (!rows.length) return { status: 'could-not-look', reason: 'no reader was run' };
	if (missed.length)
		return {
			status: 'fail',
			reason:
				`${missed.length} of ${rows.length} job counter(s) do not see a ci job: ${missed.join('; ')}` +
				(blind.length ? `. Also could not look: ${blind.join('; ')}` : ''),
		};
	if (blind.length)
		return {
			status: 'could-not-look',
			reason: `${blind.length} of ${rows.length} job counter(s) could not be read: ${blind.join('; ')}`,
		};
	return {
		status: 'pass',
		reason: `all ${rows.length} job counters saw the ci decoy, each in its production role`,
	};
}

const tail = (r) =>
	String(r?.stderr || r?.stdout || r?.error || '')
		.trim()
		.slice(-200);

/** The test. `counters` is injectable for tests; production runs COUNTERS. */
export function makeObserversTest({ counters = COUNTERS } = {}) {
	return {
		id: 'busy-counters',
		track: 'qualify',
		needsDrain: true,
		runsAs: 'admin',
		ttlDays: QUALIFY_TTL_DAYS,
		minutes: 6,
		async run(ctx) {
			let users;
			try {
				users = { adminUser: nodeUser(ctx.machine, 'admin'), ciUser: nodeUser(ctx.machine, 'ci') };
			} catch (e) {
				return { status: 'could-not-look', reason: `the node's users: ${e.message}`, metrics: {} };
			}
			const cutoverUsers = {
				admin: users.adminUser,
				ci: users.ciUser,
				adminHome: nodeHome(ctx.machine, 'admin'),
				ciHome: nodeHome(ctx.machine, 'ci'),
			};
			const built = [];
			const unbuilt = [];
			for (const c of counters) {
				try {
					built.push({ ...c, text: c.script(cutoverUsers) });
				} catch (e) {
					unbuilt.push({
						id: c.id,
						role: c.role,
						baseline: null,
						withDecoy: null,
						why: `its command could not be built: ${e.message}`,
					});
				}
			}
			const script = readersScript(built, users);
			const read = async () => {
				const r = await ctx.exec(script, { timeoutMs: 120_000 });
				return { r, by: parseReaders(r.stdout ?? '') };
			};

			const base = await read();
			const started = await ctx.exec(decoyStartScript(users), { timeoutMs: 30_000 });
			const decoy = parseDecoy(started.stdout ?? '');
			if (!decoy.pid)
				return {
					status: 'could-not-look',
					reason:
						`the ci decoy did not start: ${decoy.why}` +
						(started.ok
							? ''
							: ` (${tail(started)}; if it started unseen, it ends by itself within ${DECOY_LIFETIME_SEC} s)`),
					metrics: {},
				};
			let withDecoy;
			let stop;
			try {
				withDecoy = await read();
			} finally {
				stop = await ctx
					.exec(decoyStopScript(users, decoy), { timeoutMs: 30_000 })
					.catch((e) => ({ ok: false, stdout: '', error: e.message }));
			}
			const gone = new RegExp(`^DECOY-GONE ${decoy.pid}$`, 'm').test(stop.stdout ?? '');

			const rows = [
				...built.map((c) => {
					const b = base.by[c.id];
					const w = withDecoy.by[c.id];
					return {
						id: c.id,
						role: c.role,
						file: c.file,
						baseline: b ? c.parse(b.out) : null,
						withDecoy: w ? c.parse(w.out) : null,
						...(c.max !== undefined ? { max: c.max } : {}),
						...(!b || !w
							? {
									why: `did not finish ${b ? 'beside' : 'before'} the decoy (${String(
										(b ? withDecoy.r : base.r)?.stderr || 'no stderr'
									)
										.trim()
										.slice(-200)})`,
								}
							: {}),
					};
				}),
				...unbuilt,
			];
			const verdict = judgeCounters(rows);
			const metrics = {
				decoyPid: decoy.pid,
				decoyGone: gone,
				counters: Object.fromEntries(
					rows.map((r) => [r.id, { role: r.role, baseline: r.baseline, withDecoy: r.withDecoy }])
				),
			};
			if (gone) return { ...verdict, metrics };
			const leak = `the decoy pid ${decoy.pid} was not confirmed gone (${tail(stop) || 'no answer'}); it ends by itself within ${DECOY_LIFETIME_SEC} s`;
			return verdict.status === 'pass'
				? { status: 'could-not-look', reason: `${verdict.reason}, but ${leak}`, metrics }
				: { ...verdict, reason: `${verdict.reason}. ${leak}`, metrics };
		},
	};
}

export const test = makeObserversTest();
