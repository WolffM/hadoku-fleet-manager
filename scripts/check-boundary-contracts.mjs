#!/usr/bin/env node
/**
 * check-boundary-contracts — assert the REAL shape of every boundary our tests mock.
 *
 * WHY THIS EXISTS
 * ---------------
 * The JIT dispatcher was built entirely behind test doubles. 85 unit tests
 * across eight modules passed the whole time, and the first time it ran against
 * reality it produced four bugs in an afternoon. Every one had the same shape:
 * THE MOCK WAS MORE CORRECT THAN THE REAL THING.
 *
 *   the mock said                        reality said
 *   ----------------------------------   ------------------------------------
 *   {ok, status, body}                   ghWrite returned {ok, status} — the
 *                                        body was dropped, so a 201 that carried
 *                                        the runner config read as a failure
 *   labels are exactly what you pass      generate-jitconfig adds NO defaults, so
 *                                        every mint lacked `self-hosted` and
 *                                        nothing could ever be scheduled onto it
 *   a queued run is a job needing a       a run can be held by a concurrency
 *   runner                                group, a needs:, or an approval
 *   freeMb is megabytes                   it was handed free SLOTS
 *
 * No number of additional unit tests finds any of those, because the unit tests
 * are written against the same wrong belief as the code. What finds them is
 * asking the real system what shape it actually has — which is this file.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It never WRITES. Creating a runner to check the mint response would leave a
 * registration GitHub schedules onto, which is §12.8's black hole. The write
 * path is covered end to end by `.github/workflows/jit-canary.yml`, a job that
 * no standing runner in the fleet can serve — so it can only ever go green if a
 * mint worked. Read contracts here, write contracts there.
 *
 * Needs network + ssh, so it belongs in `check:live`, never the offline
 * aggregate.
 *
 * EVERY `gh api` CALL HERE IS A READ, RETRIED ONCE (#80). This file reads
 * three endpoints and writes nothing — see "WHAT IT DOES NOT DO" above — so
 * every one of them is safe to retry before it is called could-not-look, the
 * same shape `check-fleet-preflight.mjs` and `reconcile-runner-identity.mjs`
 * already carry for their own `gh` reads. `READ_ATTEMPTS` and
 * `describeReadFailure` are imported from `lib/queue-health.mjs` rather than
 * re-derived — that gate measured the transient rate (0.13% of `gh api`
 * calls, 2026-09-07) and one number is the point. Before this, none of the
 * three had a timeout at all, so a true hang could consume this gate's whole
 * 300s wrapper budget (`check:boundary-contracts` in audit-gates.ts) with
 * nothing written out; now each attempt is bounded to 20s and the worst case
 * — all three calls failing every attempt — is ~123s, comfortably inside it.
 *
 * @guards scripts/**
 */

import { execFileSync } from 'node:child_process';
import { loadManifest, runOn, selectNodes } from './lib/fleet-exec.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { READ_ATTEMPTS, describeReadFailure } from './lib/queue-health.mjs';

// The repo whose Actions API is READ to learn the real shapes. Any repo would
// do for the schema; this one is chosen because it is the busiest in the fleet,
// so its recent runs reliably contain the queued/held/completed variety the
// checks below need — a quiet repo returns three green runs and proves nothing.
// Overridable for a fleet that is not this one.
const SELF = process.env.BOUNDARY_PROBE_REPO || 'WolffM/hadoku_site';
const failures = [];
const checked = [];

const ok = (what) => checked.push(what);
const bad = (what, detail) => failures.push(`${what}: ${detail}`);

/** A read that never finishes is a read that never reports (#80). */
const READ_TIMEOUT_MS = 20_000;
/** Long enough for a blip to pass, short enough to be invisible at the measured 0.13% rate. */
const RETRY_DELAY_MS = 1_000;

/** Synchronous sleep — this probe runs end to end serially; nothing here is async. */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * ONE READ, retried per `READ_ATTEMPTS` before it is reported as `__error`
 * (#80). Every call through this function is a `gh api` GET — see the file
 * header — so retrying costs nothing a write would risk.
 */
function gh(path) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		try {
			return JSON.parse(
				execFileSync('gh', ['api', path], {
					encoding: 'utf8',
					maxBuffer: 32 << 20,
					timeout: READ_TIMEOUT_MS,
				})
			);
		} catch (err) {
			reason = `${describeReadFailure(err, READ_TIMEOUT_MS)} (attempt ${attempt}/${READ_ATTEMPTS})`;
			if (attempt < READ_ATTEMPTS) sleepSync(RETRY_DELAY_MS);
		}
	}
	return { __error: reason };
}

/** Assert a field exists and has the type the code assumes. */
function field(where, obj, name, type) {
	const v = obj?.[name];
	if (v === undefined || v === null)
		return bad(where, `\`${name}\` is absent — code destructures it`);
	if (type === 'array' ? !Array.isArray(v) : typeof v !== type) {
		return bad(
			where,
			`\`${name}\` is ${Array.isArray(v) ? 'array' : typeof v}, code assumes ${type}`
		);
	}
	ok(`${where}.${name}`);
}

/**
 * Check EVERY element of a listing, and FAIL an empty one.
 *
 * An empty listing is not a pass. The fields below are exactly what the
 * dispatcher destructures, and "there was nothing to look at" is the
 * could-not-look case — `SELF` is the busiest repo in the fleet precisely so
 * its listings are never legitimately empty. Mutation-tested 2026-10-10 (#98):
 * `{"workflow_runs":[]}` and `{"runners":[]}` both exited 0, and only `[0]` of
 * a non-empty listing was ever type-checked.
 */
function eachElement(where, list, check) {
	if (!Array.isArray(list)) return; // `field` already reported the wrong type
	if (!list.length) {
		bad(where, 'the listing is EMPTY — nothing was there to check, which proves no shape');
		return;
	}
	list.forEach((item, i) => check(`${where}[${i}]`, item));
}

// --- 1. the runs listing the dispatcher polls -------------------------------
/**
 * Ten runs, not one. With `per_page=1` a single run stood for the whole
 * listing, and when that run had no jobs (skipped, or not yet expanded) the
 * jobs half below checked nothing and passed.
 */
const RUNS_PER_PAGE = 10;
const runs = gh(`/repos/${SELF}/actions/runs?per_page=${RUNS_PER_PAGE}`);
if (runs.__error) bad('/actions/runs', runs.__error);
else {
	field('/actions/runs', runs, 'workflow_runs', 'array');
	eachElement('/actions/runs', runs.workflow_runs, (where, r) => {
		field(where, r, 'id', 'number');
		field(where, r, 'status', 'string');
		// The field the age gate is built on. Without it NOTHING is mintable, and
		// the dispatcher would silently decline every job forever.
		field(where, r, 'created_at', 'string');
	});

	// --- 2. the jobs listing, which is what actually says "waiting for a runner"
	// The first run that HAS jobs: a run with none says nothing about the jobs
	// shape, so it is passed over rather than counted. A READ failure stops the
	// search — it is reported, and trying the next run would only multiply the
	// timeout budget against a 300s wrapper.
	const candidates = (Array.isArray(runs.workflow_runs) ? runs.workflow_runs : []).filter(
		(r) => typeof r?.id === 'number'
	);
	let jobsSettled = false;
	for (const r of candidates) {
		const jobs = gh(`/repos/${SELF}/actions/runs/${r.id}/jobs`);
		if (jobs.__error) {
			bad('/actions/runs/:id/jobs', jobs.__error);
			jobsSettled = true;
			break;
		}
		field('/actions/runs/:id/jobs', jobs, 'jobs', 'array');
		if (!Array.isArray(jobs.jobs)) {
			jobsSettled = true;
			break;
		}
		if (!jobs.jobs.length) continue;
		eachElement('/jobs', jobs.jobs, (where, j) => {
			field(where, j, 'status', 'string');
			// Placement refuses a machine that cannot satisfy these. If the field
			// ever disappears, every job becomes placeable anywhere.
			field(where, j, 'labels', 'array');
			// Placement compares these as STRINGS. An array of objects passes the
			// array check above and matches no label at all.
			if (Array.isArray(j?.labels) && j.labels.some((l) => typeof l !== 'string')) {
				bad(`${where}.labels[]`, 'entries are not strings — every placement match breaks');
			}
		});
		jobsSettled = true;
		break;
	}
	if (!jobsSettled && candidates.length) {
		bad(
			'/actions/runs/:id/jobs',
			`none of the ${candidates.length} run(s) listed had any jobs — the jobs shape went unchecked`
		);
	}
}

// --- 3. the runners listing the reaper and the label floor read --------------
const runners = gh(`/repos/${SELF}/actions/runners`);
if (runners.__error) bad('/actions/runners', runners.__error);
else {
	field('/actions/runners', runners, 'runners', 'array');
	/** Runners whose name and labels are well-formed, so the label floor can read them. */
	const readable = [];
	eachElement('/runners', runners.runners, (where, x) => {
		field(where, x, 'id', 'number');
		field(where, x, 'name', 'string');
		field(where, x, 'status', 'string');
		field(where, x, 'busy', 'boolean');
		field(where, x, 'labels', 'array');
		if (!Array.isArray(x?.labels)) return;
		if (x.labels.some((l) => typeof l?.name !== 'string')) {
			bad(`${where}.labels[]`, 'entries have no string `name` — every label read breaks');
			return;
		}
		ok(`${where}.labels[].name`);
		if (typeof x.name === 'string') readable.push(x);
	});

	// THE BUG THAT COST THE PILOT A DAY. A runner registered by config.sh
	// carries self-hosted implicitly; generate-jitconfig grants NOTHING it is
	// not given. If this stops holding, either GitHub changed the defaults or
	// something is registering runners wrong — both change what a mint must
	// send.
	//
	// EVERY standing runner, not the first: one correct registration at the head
	// of the list hid any number of wrong ones behind it. A listing with NO
	// standing runner is a finding — the assumption went unchecked, which is not
	// the same as holding. A runner that failed the shape check above is already
	// reported and is not re-read here: reading `.name` off a malformed label
	// crashed the gate and took the finding down with it.
	const standing = readable.filter((rr) => !rr.name.startsWith('jit-'));
	if (Array.isArray(runners.runners) && runners.runners.length && !standing.length) {
		bad(
			'standing runner labels',
			'no readable standing (non-jit) runner is registered — the implicit-label assumption behind mintLabels() went unchecked'
		);
	}
	const unlabelled = standing.filter(
		(s) => !s.labels.some((l) => l.name.toLowerCase() === 'self-hosted')
	);
	for (const s of unlabelled) {
		bad(
			'standing runner labels',
			`${s.name} lacks self-hosted — the implicit-label assumption behind mintLabels() no longer holds`
		);
	}
	if (standing.length && !unlabelled.length) {
		ok(`standing runners carry self-hosted implicitly (${standing.length})`);
	}
}

// --- 4. the shell output our parsers consume --------------------------------
/**
 * A GUEST IS NOT PROBED HERE, and the skip is printed.
 *
 * The shapes below are the FLEET's own boundaries — what `free -m` returns to
 * the admission check, and whether the JIT units the dispatcher mints parse.
 * Neither is a question about a machine that lends the fleet a registration and
 * mints nothing: a guest is never a mint target, so it has no jit-* units to
 * parse, and its free memory feeds no admission decision. Reaching onto it to
 * ask anyway is the fleet chain on a box the operator put out of its reach
 * (2026-09-14). `selectNodes` is the role-aware door and hands back the refusal
 * so it can be said out loud.
 */
const { nodes: machines, skippedByRole } = selectNodes(loadManifest(), {
	where: (m) => m.placement !== 'excluded',
});
// A node a human powered off is EXPECTED down. It is still PRINTED, and still
// not probed — the deferral suppresses the failure, never the evidence, and
// expires after DEFER_DAYS. See lib/expected-down.mjs.
const DRAINS = readDrains();
const expectedDown = [];
for (const [name] of machines) {
	// `free -m` feeds MachineState.freeMb. It was once handed FREE SLOTS instead,
	// and admission computed `3 - 4096` and refused every mint on every machine,
	// permanently, while logging something that reads like a full fleet.
	const mem = await runOn(name, "free -m | awk '/^Mem:/{print $7}'", {
		as: 'admin',
		timeoutMs: 20_000,
	});
	if (!mem.ok) {
		const defer = deferralFor(name, DRAINS);
		if (defer.deferred) {
			expectedDown.push(name);
			continue;
		}
		bad(`${name} free -m`, 'unreachable');
		continue;
	}
	const mb = Number(mem.stdout.trim());
	if (!Number.isFinite(mb) || mb < 256) {
		bad(
			`${name} free -m`,
			`returned ${JSON.stringify(mem.stdout.trim())} — not a plausible MB figure`
		);
	} else ok(`${name} free -m → ${mb} MB`);

	// The JIT unit listing. An empty fleet returns empty; what must NOT happen is
	// output our parser silently reads as a unit name — OR silently drops.
	//
	// `--plain` is load-bearing, and must match `liveJitUnits` in
	// src/runners/ephemeral-exec.ts. Without it systemctl prefixes a FAILED unit
	// with `●`, the first token becomes the dot, and both this parser and the
	// dispatcher's filtered the line out — so a failed jit-* unit vanished from
	// B9's reconstruction and this gate reported the remainder as parsing fine.
	const units = await runOn(
		name,
		"XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user list-units 'jit-*' --no-legend --plain",
		{ as: 'ci', timeoutMs: 20_000 }
	);
	if (!units.ok) bad(`${name} list-units`, 'command failed');
	else {
		const lines = units.stdout.split('\n').filter((l) => l.trim());
		const parsed = lines
			.map((l) => l.trim().split(/\s+/)[0])
			.filter((u) => u && u.startsWith('jit-'));
		// A line that MENTIONS a jit unit but does not START with one is a unit the
		// parser above dropped. That is the `●` shape, and whatever replaces it next.
		const dropped = lines.filter((l) => l.includes('jit-') && !l.trim().startsWith('jit-'));
		if (dropped.length) {
			bad(
				`${name} list-units`,
				`line(s) naming a jit unit the parser would drop: ${dropped.map((l) => JSON.stringify(l.trim())).join(', ')}`
			);
		}
		if (lines.length && !parsed.length) {
			bad(
				`${name} list-units`,
				`${lines.length} line(s) of output parsed to ZERO units: ${JSON.stringify(lines[0].trim())}`
			);
		}
		// The slug charset must match the MINTER's, not a guess at it.
		// `jitRunnerName` lowercases the repo and narrows it with
		// `replace(/[^a-z0-9._-]/g, '-')`, so `_` and `.` are deliberately legal
		// — its own comment says systemd admits `[A-Za-z0-9:_.\-]`. This pattern
		// omitted both, so `hadoku_site` — the busiest repo in the fleet, and the
		// only one with an underscore — minted units this gate called junk.
		//
		// It failed only while such a unit happened to be ALIVE during the check,
		// which is why it read as a flake and why it survived: the gate lived in
		// `check:live`, a list run by nobody, until it moved into the nightly
		// audit. Observed 2026-09-03 on claw-2, first run after the move.
		const junk = parsed.filter((u) => !/^jit-[a-z0-9._-]+-r\d+-\d+\.service$/.test(u));
		if (junk.length) bad(`${name} list-units`, `unparseable unit name(s): ${junk.join(', ')}`);
		else if (!dropped.length) ok(`${name} jit units parse (${parsed.length})`);
	}
}

// ZERO NODES PROBED IS NOT A PASS. A manifest that selects nothing printed
// "0 machine(s)" and exited 0 — the shell half of every contract above went
// unchecked. Only a stated reason excuses it: every node skipped as a guest or
// deferred as expected-down, both of which are printed below.
if (!machines.length && !skippedByRole.length) {
	bad(
		'machines',
		'the manifest selected ZERO nodes to probe and none was skipped or deferred — the shell contracts went unchecked'
	);
}

// SAID OUT LOUD, never folded into the pass. A node that stops being checked
// without anyone noticing is the failure the skip exists to prevent.
for (const s of skippedByRole) {
	console.log(`  · ${s.node} [skipped: guest] — ${s.why}`);
}
for (const name of expectedDown) {
	console.log(`  · ${deferralNote(name, deferralFor(name, DRAINS))} — not probed`);
}

if (failures.length) {
	console.error(`\n✗ ${failures.length} boundary contract(s) broken:\n`);
	for (const f of failures) console.error(`  ${f}`);
	console.error(
		`\n  A boundary that changed shape breaks code no unit test can catch, because\n` +
			`  the tests are written against the same belief as the code. Fix the caller,\n` +
			`  then fix the mock that said otherwise.\n`
	);
	process.exit(1);
}
console.log(
	`✓ ${checked.length} boundary contract(s) hold against the real GitHub API and ` +
		`${machines.length} machine(s)` +
		(skippedByRole.length ? ` (${skippedByRole.length} guest(s) skipped by role)` : '') +
		(expectedDown.length ? ` (${expectedDown.length} expected down)` : '')
);
