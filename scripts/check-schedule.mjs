#!/usr/bin/env node
/**
 * check-schedule — the cron schedule this package declares cannot drift from
 * what hadoku_site actually runs, or stop being checked at all, without this
 * gate noticing (wave 5e lane D, plan §6.2/§6.3).
 *
 * `src/lib/job-registry.ts`'s `JOB_REGISTRY` is the one place a fleet job's
 * cadence and detection budget are declared. `services/cron-worker/profiles.json`
 * (hadoku_site) is GATED here, not generated: it mixes fleet jobs with
 * non-fleet ones (`repos:main-sync`, `ci:vault-audit`, `keys:devvault-grants`…)
 * and generating it from this registry would mean this package writing jobs it
 * does not own (wave 5e manager decision 2). Instead this gate reads
 * `profiles.json` through `lib/fleet-source.mjs` — the shipped default branch,
 * never a sibling checkout (fleet-manager#7) — and fails on three things:
 *
 *   (a) MISSING-FROM-SCHEDULE   a `{ cron }`-clock registry entry that no
 *       profile names a job for. An in-process entry (`{ clockMs }`) runs on
 *       this package's OWN clock inside mgmt-api, not Temporal's, so it is
 *       never checked against profiles.json at all.
 *   (b) CRON-CANNOT-MEET-BUDGET   the PROFILE'S OWN cron, read back from
 *       profiles.json, has a period (`cadencePeriodMs`, this registry's own
 *       arithmetic — never re-implemented here) that exceeds the job's
 *       `detectionBudget` (`parseDurationMs`, same source). Checked for the
 *       umbrella itself AND, against the SAME umbrella cron, for every
 *       `coversSubs` entry — which is how `ci:audit-gates`'s own
 *       `warm-canary`/`label-floor` rows (1h budget, daily umbrella cron)
 *       surface here exactly as `job-registry.ts` already pins them, not as
 *       new noise invented by this gate.
 *   (c) UNREGISTERED-FLEET-JOB   a job scheduled in profiles.json whose
 *       mgmt-api route actually spawns the `fleet` CLI, with no row in
 *       `JOB_REGISTRY` naming it.
 *
 * TELLING A FLEET JOB FROM A NON-FLEET `ci:*` JOB (needed for (c)).
 * profiles.json's job entries carry no reference to which mgmt-api route
 * handles them — only a name and a dispatch URL — so "does this one run the
 * fleet CLI" cannot be read from profiles.json alone. The answer lives in
 * `services/mgmt-api/src/routes/jobs/*.ts`: every wrapper that actually spawns
 * `@wolffm/fleet-manager`'s CLI IMPORTS `fleetCli` from `./lib/site-paths.ts`
 * (confirmed 2026-10-31: exactly the 22 `JSON_CONTRACT` files plus
 * `audit-gates.ts`, the one `PROSE_CONTRACT` file — 23 files, 23 registry
 * rows, before this gate's own consumer makes it 24). The IMPORT, not a bare
 * substring match on `fleetCli(` — `lib/site-paths.ts` DEFINES the function
 * (`export function fleetCli(): string { … }`) and that line contains the
 * same substring, which this gate initially mis-read as an unnamed consumer
 * on the first run against the real repo (2026-10-31). So this gate reads
 * every `routes/jobs/*.ts` file (comments blanked — a header mentioning
 * another job's name in prose must not count, and this repo has read a
 * comment as evidence before) and, for a file that IMPORTS `fleetCli`,
 * extracts the job name from its `JOB_NAME`/`jobName` constant assignment.
 * `ci:*` is this fleet's own naming convention for a scheduled
 * job (every JOB_REGISTRY entry with an `mgmtApiFile` is named that way), but
 * the match against `JOB_REGISTRY` is by the file's declared name, not by the
 * `ci:` prefix — so a future fleet job named outside that convention would
 * still be caught.
 *
 * NO CHECKOUT, NO FILE, NO JOBS, OR NOTHING PARSEABLE ARE EACH A FINDING, not
 * a silent clean report — "I could not look" must never render as "nothing is
 * wrong" (CLAUDE.md). `--json` is one document; findings explain WHY.
 */
import process from 'node:process';

import { createEmitter } from './lib/emit.mjs';
import { tryShipped } from './lib/fleet-source.mjs';
import { blankComments } from './lib/blank-comments.mjs';
import { hubRepoFull } from '../dist/lib/fleet-config.js';
import { JOB_REGISTRY, cadencePeriodMs, parseDurationMs } from '../dist/lib/job-registry.js';

// NO --help BLOCK: this subcommand carries no `help: true` in src/cli.ts's
// COMMANDS table, so `--help` never reaches this script at all (the door
// answers from the table and runs nothing — see cli.ts's own comment on why).
// A dead `console.log` branch here would still be live SOURCE TEXT, and
// emit.test.mjs's "writes stdout ONLY through emit()" scans every
// JSON_CONTRACT script's source for `console.log`/`process.stdout.write`
// regardless of reachability — the same reasoning node-users.mjs and every
// other contract script with no custom --help already follows.
const out = createEmitter();

const PROFILES_PATH = 'services/cron-worker/profiles.json';
const JOBS_DIR = 'services/mgmt-api/src/routes/jobs';
/**
 * A CONSUMER imports `fleetCli` to call it. `lib/site-paths.ts` DEFINES it —
 * `export function fleetCli(): string { … }` — which also contains the
 * substring `fleetCli(`, so a bare substring test false-positived on the
 * definer itself (measured against the real hadoku_site 2026-10-31: it
 * showed up as UNNAMED-FLEET-WRAPPER, naming no job because it has none).
 * Matching the IMPORT line instead is unambiguous: nothing imports `fleetCli`
 * from itself, and every real consumer's import is exactly this shape.
 */
const FLEET_CLI_IMPORT = /\bimport\s*\{[^}]*\bfleetCli\b[^}]*\}\s*from\b/;
/** `const JOB_NAME = 'ci:x'` (22 of 23 files) or `const jobName = 'ci:x'` (claw-cleanup.ts). */
const NAME_ASSIGNMENT = /\b(?:JOB_NAME|jobName)\s*=\s*'(ci:[a-zA-Z0-9:-]+)'/g;

const findings = [];
const ok = [];

const repo = hubRepoFull();
const source = tryShipped(repo);

if ('unreadable' in source) {
	findings.push({
		kind: 'NO-CHECKOUT',
		why: `cannot read ${repo}'s shipped files: ${source.unreadable}`,
	});
}

let profilesRaw;
let jobFiles = [];
if (!('unreadable' in source)) {
	try {
		profilesRaw = source.read(PROFILES_PATH);
	} catch (err) {
		findings.push({
			kind: 'NO-CHECKOUT',
			why: `reading ${PROFILES_PATH} from ${repo} failed: ${err instanceof Error ? err.message : String(err)}`,
		});
	}
	try {
		jobFiles = source
			.list(JOBS_DIR)
			.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts'));
	} catch (err) {
		findings.push({
			kind: 'NO-CHECKOUT',
			why: `listing ${JOBS_DIR} from ${repo} failed: ${err instanceof Error ? err.message : String(err)}`,
		});
	}
}

let profiles = null;
if (profilesRaw === undefined) {
	if (!findings.some((f) => f.kind === 'NO-CHECKOUT')) {
		findings.push({ kind: 'MISSING-FILE', why: `${repo} has no ${PROFILES_PATH}` });
	}
} else if (profilesRaw === null) {
	findings.push({ kind: 'MISSING-FILE', why: `${repo} has no ${PROFILES_PATH}` });
} else {
	try {
		profiles = JSON.parse(profilesRaw);
	} catch (err) {
		findings.push({
			kind: 'UNPARSEABLE',
			why: `${PROFILES_PATH} did not parse as JSON: ${err instanceof Error ? err.message : String(err)}`,
		});
	}
}

/** job name -> { profile, cron }, first declaration wins — a name scheduled
 *  twice is its own drift, not this gate's to adjudicate. */
const scheduled = new Map();
if (profiles) {
	for (const profile of Array.isArray(profiles.profiles) ? profiles.profiles : []) {
		const cron = profile?.schedule?.cron;
		if (typeof cron !== 'string') continue;
		for (const job of Array.isArray(profile?.jobs) ? profile.jobs : []) {
			if (typeof job?.name === 'string' && !scheduled.has(job.name)) {
				scheduled.set(job.name, { profile: profile.name, cron });
			}
		}
	}
	if (scheduled.size === 0) {
		findings.push({
			kind: 'EMPTY-SCHEDULE',
			why: `${PROFILES_PATH} parsed but named zero jobs across its profiles — the fleet does not run on nothing`,
		});
	}
}

/** job name -> route file, for every routes/jobs/*.ts file that spawns the fleet CLI. */
const fleetBacked = new Map();
if (jobFiles.length) {
	const texts = source.readMany(jobFiles);
	for (const file of jobFiles) {
		const raw = texts.get(file);
		if (typeof raw !== 'string' || !raw.includes('fleetCli')) continue;
		const body = blankComments(raw);
		if (!FLEET_CLI_IMPORT.test(body)) continue; // defines fleetCli, mentions it only in a comment, or doesn't use it at all
		const names = new Set([...body.matchAll(NAME_ASSIGNMENT)].map((m) => m[1]));
		if (names.size === 0) {
			findings.push({
				kind: 'UNNAMED-FLEET-WRAPPER',
				consumer: file,
				why: `${file} imports fleetCli() but names no JOB_NAME/jobName constant this gate can read, so it cannot be matched against JOB_REGISTRY`,
			});
			continue;
		}
		for (const name of names) fleetBacked.set(name, file);
	}
} else if (!findings.some((f) => f.kind === 'NO-CHECKOUT')) {
	findings.push({
		kind: 'NO-ROUTE-FILES',
		why: `${JOBS_DIR} has no .ts files in ${repo} — "runs the fleet CLI" cannot be checked`,
	});
}

/** Pushes a CRON-CANNOT-MEET-BUDGET finding when `periodMs` cannot meet
 *  `budget`; returns true when clean. Shared between an umbrella's own
 *  budget and each of its `coversSubs`, against the SAME real cron. */
function checkBudget(label, profile, cron, periodMs, budget) {
	let budgetMs;
	try {
		budgetMs = parseDurationMs(budget);
	} catch (err) {
		findings.push({
			kind: 'MALFORMED-BUDGET',
			job: label,
			why: `${label}.detectionBudget "${budget}" does not parse: ${err instanceof Error ? err.message : String(err)}`,
		});
		return false;
	}
	if (periodMs > budgetMs) {
		findings.push({
			kind: 'CRON-CANNOT-MEET-BUDGET',
			job: label,
			profile,
			cron,
			detectionBudget: budget,
			why:
				`${label} runs every ${periodMs}ms in profile "${profile}" (cron "${cron}"), which ` +
				`cannot meet its own detectionBudget of ${budget} (${budgetMs}ms)`,
		});
		return false;
	}
	return true;
}

const registryByName = new Map(JOB_REGISTRY.map((e) => [e.name, e]));

// (a) + (b): every { cron }-clock registry entry, plus its coversSubs.
for (const entry of JOB_REGISTRY) {
	if (!('cron' in entry.cadence)) continue; // in-process convergers run on THIS package's clock, not profiles.json's
	const found = scheduled.get(entry.name);
	if (!found) {
		findings.push({
			kind: 'MISSING-FROM-SCHEDULE',
			job: entry.name,
			why: `${entry.name} is registered with a cron clock but no profiles.json profile schedules a job named "${entry.name}"`,
		});
		continue;
	}
	let periodMs;
	try {
		periodMs = cadencePeriodMs({ cron: found.cron });
	} catch (err) {
		findings.push({
			kind: 'UNPARSEABLE-CRON',
			job: entry.name,
			profile: found.profile,
			why: `${entry.name} in profile "${found.profile}" has cron "${found.cron}", which cadencePeriodMs cannot parse: ${err instanceof Error ? err.message : String(err)}`,
		});
		continue;
	}
	const entryOk = checkBudget(
		entry.name,
		found.profile,
		found.cron,
		periodMs,
		entry.detectionBudget
	);
	let subsOk = true;
	for (const sub of entry.coversSubs ?? []) {
		const label = `${entry.name}:${sub.sub}`;
		subsOk = checkBudget(label, found.profile, found.cron, periodMs, sub.detectionBudget) && subsOk;
	}
	if (entryOk && subsOk) ok.push({ job: entry.name, profile: found.profile, cron: found.cron });
}

// (c): a fleet-backed job in profiles.json with no JOB_REGISTRY row.
for (const [name, file] of fleetBacked) {
	if (!scheduled.has(name)) continue; // not actually scheduled anywhere — nothing to reconcile
	if (registryByName.has(name)) continue;
	findings.push({
		kind: 'UNREGISTERED-FLEET-JOB',
		job: name,
		consumer: file,
		why: `${file} spawns the fleet CLI as "${name}" and profiles.json schedules it, but JOB_REGISTRY has no row for it`,
	});
}

out.log(
	`Schedule check: ${registryByName.size} registry job(s), ${scheduled.size} scheduled job(s), ` +
		`${fleetBacked.size} fleet-backed route file(s)   findings: ${findings.length}`
);
for (const f of findings) {
	out.warn(`${f.kind.padEnd(24)} ${f.job ?? f.consumer ?? ''}`);
	out.warn(`  ${f.why}`);
}
for (const o of ok) out.log(`  ✓ ${o.job.padEnd(22)} profile=${o.profile} cron="${o.cron}"`);
if (!findings.length) {
	out.log(
		'✓ every cron-clock registry job is scheduled, on budget, and every fleet-backed job is registered'
	);
}

if (out.json) {
	out.emit({
		registryJobs: registryByName.size,
		scheduledJobs: scheduled.size,
		fleetBackedFiles: fleetBacked.size,
		findings,
		ok,
		lines: out.held(),
	});
}

process.exit(findings.length ? 1 : 0);
