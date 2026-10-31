/**
 * check-schedule, run whole against fixture REMOTES through fleet-source
 * (lib/fleet-source-fixture.mjs) — never the real hadoku_site or GitHub.
 *
 * THE BASELINE FIXTURE is built FROM the real `JOB_REGISTRY`, not a hand-typed
 * copy: every `{ cron }`-clock entry gets a profiles.json job at exactly its
 * own declared cron, and every entry carrying an `mgmtApiFile` gets a route
 * file that calls `fleetCli(` and names itself via a `JOB_NAME` constant.
 * That is deliberate — it is how the two KNOWN findings (`ci:audit-gates`'s
 * `warm-canary`/`label-floor` covered subs, 1h budget under a daily umbrella
 * cron) are proven to surface from this gate exactly as job-registry.ts
 * already pins them, with no hand-picked fixture able to hide that this gate
 * reproduces real, already-documented drift rather than inventing new noise.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { fixtureRemotes } from './lib/fleet-source-fixture.mjs';
import { JOB_REGISTRY } from '../dist/lib/job-registry.js';

const GATE = new URL('./check-schedule.mjs', import.meta.url).pathname;
const HUB = 'WolffM/hadoku_site';
const PROFILES_PATH = 'services/cron-worker/profiles.json';
const JOBS_DIR = 'services/mgmt-api/src/routes/jobs';

/** A route file this gate reads as "spawns the fleet CLI, named <jobName>". */
function routeFile(jobName) {
	return (
		`import { fleetCli } from './lib/site-paths.js';\n` +
		`const JOB_NAME = '${jobName}';\n` +
		`const SCRIPT = fleetCli();\n` +
		`export async function dispatch() { return { SCRIPT, JOB_NAME }; }\n`
	);
}

/** A route file that does NOT spawn the fleet CLI — a non-fleet `ci:*` job. */
function nonFleetRouteFile(jobName) {
	return `const JOB_NAME = '${jobName}';\nexport async function dispatch() { return JOB_NAME; }\n`;
}

/**
 * The baseline fixture: one profile per distinct cron string among
 * `JOB_REGISTRY`'s `{ cron }`-clock entries, each job placed in the profile
 * matching ITS OWN declared cron — and a route file per `mgmtApiFile` entry.
 *
 * @param {{ skip?: string[], cronOverride?: Record<string,string>, extraJobs?: {name: string, cron: string}[], extraRouteFiles?: Record<string,string> }} [opts]
 */
function baselineFiles(opts = {}) {
	const skip = new Set(opts.skip ?? []);
	const cronOverride = opts.cronOverride ?? {};
	const byCron = new Map();
	const files = {};

	for (const entry of JOB_REGISTRY) {
		if (!('cron' in entry.cadence) || skip.has(entry.name)) continue;
		const cron = cronOverride[entry.name] ?? entry.cadence.cron;
		if (!byCron.has(cron)) byCron.set(cron, []);
		byCron.get(cron).push({ name: entry.name });
		if (entry.mgmtApiFile) {
			files[entry.mgmtApiFile] = routeFile(entry.name);
		}
	}
	for (const extra of opts.extraJobs ?? []) {
		if (!byCron.has(extra.cron)) byCron.set(extra.cron, []);
		byCron.get(extra.cron).push({ name: extra.name });
	}

	const profiles = [...byCron.entries()].map(([cron, jobs], i) => ({
		name: `profile-${i}`,
		schedule: { cron, timezone: 'Etc/UTC' },
		jobs,
	}));
	files[PROFILES_PATH] = JSON.stringify({ profiles });
	for (const [path, text] of Object.entries(opts.extraRouteFiles ?? {})) files[path] = text;
	return files;
}

function fleet(files) {
	const remotes = fixtureRemotes('check-schedule-');
	remotes.push(HUB, files);
	return { remotes, env: { ...process.env, ...remotes.env }, cleanup: remotes.cleanup };
}

function run(env) {
	const r = spawnSync(process.execPath, [GATE, '--json'], { encoding: 'utf8', env });
	return { ...r, out: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null };
}

const PINNED = ['ci:audit-gates:warm-canary', 'ci:audit-gates:label-floor'];

test('the baseline fixture (built from the real registry) surfaces exactly the two already-pinned findings', () => {
	const fx = fleet(baselineFiles());
	try {
		const r = run(fx.env);
		assert.ok(r.out, r.stdout + r.stderr);
		assert.equal(r.status, 1, JSON.stringify(r.out.findings));
		assert.deepEqual(
			r.out.findings.map((f) => f.job).sort(),
			PINNED.slice().sort(),
			JSON.stringify(r.out.findings)
		);
		for (const f of r.out.findings) assert.equal(f.kind, 'CRON-CANNOT-MEET-BUDGET');
		// Every OTHER registered cron job reports clean — proves this is signal,
		// not a gate too noisy to read. ci:audit-gates itself is withheld from
		// `ok` because one of its OWN covered subs is the pinned finding above.
		assert.ok(!r.out.ok.some((o) => o.job === 'ci:audit-gates'));
		assert.ok(r.out.ok.length >= 19, JSON.stringify(r.out.ok));
	} finally {
		fx.cleanup();
	}
});

test('MISSING-FROM-SCHEDULE: a registered cron job absent from every profile', () => {
	const fx = fleet(baselineFiles({ skip: ['ci:queue-health'] }));
	try {
		const r = run(fx.env);
		assert.equal(r.status, 1);
		assert.ok(
			r.out.findings.some((f) => f.kind === 'MISSING-FROM-SCHEDULE' && f.job === 'ci:queue-health'),
			JSON.stringify(r.out.findings)
		);
	} finally {
		fx.cleanup();
	}
});

test('CRON-CANNOT-MEET-BUDGET: a real job moved onto a cron slower than its own budget', () => {
	// ci:drain-enforced: 20m budget, declared */10 * * * *. Slow it to daily.
	const fx = fleet(baselineFiles({ cronOverride: { 'ci:drain-enforced': '0 13 * * *' } }));
	try {
		const r = run(fx.env);
		assert.equal(r.status, 1);
		const f = r.out.findings.find((x) => x.job === 'ci:drain-enforced');
		assert.ok(f, JSON.stringify(r.out.findings));
		assert.equal(f.kind, 'CRON-CANNOT-MEET-BUDGET');
		assert.equal(f.cron, '0 13 * * *');
	} finally {
		fx.cleanup();
	}
});

test('UNREGISTERED-FLEET-JOB: a scheduled job whose route spawns the fleet CLI but has no registry row', () => {
	const fx = fleet(
		baselineFiles({
			extraJobs: [{ name: 'ci:fx-new-fleet-job', cron: '0 13 * * *' }],
			extraRouteFiles: { [`${JOBS_DIR}/fx-new-job.ts`]: routeFile('ci:fx-new-fleet-job') },
		})
	);
	try {
		const r = run(fx.env);
		assert.equal(r.status, 1);
		assert.ok(
			r.out.findings.some(
				(f) => f.kind === 'UNREGISTERED-FLEET-JOB' && f.job === 'ci:fx-new-fleet-job'
			),
			JSON.stringify(r.out.findings)
		);
	} finally {
		fx.cleanup();
	}
});

test('a non-fleet ci:* job (no fleetCli() call) scheduled with no registry row is NOT a finding', () => {
	const fx = fleet(
		baselineFiles({
			extraJobs: [{ name: 'ci:vault-audit', cron: '0 13 * * *' }],
			extraRouteFiles: { [`${JOBS_DIR}/vault-audit.ts`]: nonFleetRouteFile('ci:vault-audit') },
		})
	);
	try {
		const r = run(fx.env);
		assert.ok(
			!r.out.findings.some((f) => f.job === 'ci:vault-audit'),
			JSON.stringify(r.out.findings)
		);
	} finally {
		fx.cleanup();
	}
});

test('UNNAMED-FLEET-WRAPPER: a route file calls fleetCli() but declares no readable job name', () => {
	const fx = fleet(
		baselineFiles({
			extraRouteFiles: {
				[`${JOBS_DIR}/fx-unnamed.ts`]:
					"import { fleetCli } from './lib/site-paths.js';\nconst SCRIPT = fleetCli();\n",
			},
		})
	);
	try {
		const r = run(fx.env);
		assert.equal(r.status, 1);
		assert.ok(
			r.out.findings.some(
				(f) => f.kind === 'UNNAMED-FLEET-WRAPPER' && f.consumer === `${JOBS_DIR}/fx-unnamed.ts`
			),
			JSON.stringify(r.out.findings)
		);
	} finally {
		fx.cleanup();
	}
});

test('REGRESSION (2026-10-31, against the real repo): the DEFINER of fleetCli() is not itself a consumer', () => {
	// lib/site-paths.ts's `export function fleetCli(): string { … }` contains
	// the substring `fleetCli(` too — a bare substring match on that falsely
	// read it as an unnamed fleet wrapper on the first run against real
	// hadoku_site. Only an IMPORT of fleetCli marks a consumer.
	const fx = fleet(
		baselineFiles({
			extraRouteFiles: {
				[`${JOBS_DIR}/lib/site-paths.ts`]:
					"export function fleetCli(): string {\n\treturn '/fake/cli.js';\n}\n",
			},
		})
	);
	try {
		const r = run(fx.env);
		assert.ok(
			!r.out.findings.some((f) => f.consumer === `${JOBS_DIR}/lib/site-paths.ts`),
			JSON.stringify(r.out.findings)
		);
	} finally {
		fx.cleanup();
	}
});

test('a job name assignment mentioned only inside a comment does not count as a declaration', () => {
	// This repo has read a comment as evidence three times (AGENTS.md); this
	// gate must not be the fourth. The commented-out line is the EXACT shape
	// this gate's NAME_ASSIGNMENT regex matches — `const JOB_NAME = '...'` —
	// so only blanking comments FIRST tells it apart from a live declaration.
	const fx = fleet(
		baselineFiles({
			extraRouteFiles: {
				[`${JOBS_DIR}/fx-comment-only.ts`]:
					"/**\n * old code: const JOB_NAME = 'ci:fx-comment-only-job';\n */\n" +
					"import { fleetCli } from './lib/site-paths.js';\nconst SCRIPT = fleetCli();\n",
			},
			extraJobs: [{ name: 'ci:fx-comment-only-job', cron: '0 13 * * *' }],
		})
	);
	try {
		const r = run(fx.env);
		// The file is read as UNNAMED (no live JOB_NAME/jobName assignment), and
		// the scheduled job it was never matched to is left unregistered-noise
		// free: no UNREGISTERED-FLEET-JOB finding is raised for a name this gate
		// never actually matched to a fleetCli() file.
		assert.ok(
			r.out.findings.some(
				(f) => f.kind === 'UNNAMED-FLEET-WRAPPER' && f.consumer === `${JOBS_DIR}/fx-comment-only.ts`
			)
		);
		assert.ok(!r.out.findings.some((f) => f.job === 'ci:fx-comment-only-job'));
	} finally {
		fx.cleanup();
	}
});

test('EMPTY-SCHEDULE: profiles.json parses but names zero jobs', () => {
	const fx = fleet({ [PROFILES_PATH]: JSON.stringify({ profiles: [] }) });
	try {
		const r = run(fx.env);
		assert.equal(r.status, 1);
		assert.ok(r.out.findings.some((f) => f.kind === 'EMPTY-SCHEDULE'));
	} finally {
		fx.cleanup();
	}
});

test('MISSING-FILE: hadoku_site exists but has no profiles.json', () => {
	const fx = fleet({ 'README.md': '# fixture\n' });
	try {
		const r = run(fx.env);
		assert.equal(r.status, 1);
		assert.ok(
			r.out.findings.some((f) => f.kind === 'MISSING-FILE'),
			JSON.stringify(r.out.findings)
		);
	} finally {
		fx.cleanup();
	}
});

test('UNPARSEABLE: profiles.json is not valid JSON', () => {
	const fx = fleet({ [PROFILES_PATH]: '{ not json' });
	try {
		const r = run(fx.env);
		assert.equal(r.status, 1);
		assert.ok(r.out.findings.some((f) => f.kind === 'UNPARSEABLE'));
	} finally {
		fx.cleanup();
	}
});

test('NO-CHECKOUT: the remote was never pushed at all — "I could not look" is a finding, not a clean report', () => {
	const remotes = fixtureRemotes('check-schedule-nocheckout-');
	const env = { ...process.env, ...remotes.env };
	try {
		const r = run(env);
		assert.equal(r.status, 1);
		assert.ok(
			r.out.findings.some((f) => f.kind === 'NO-CHECKOUT'),
			JSON.stringify(r.out?.findings)
		);
	} finally {
		remotes.cleanup();
	}
});

test('UNPARSEABLE-CRON: a scheduled job sits on a cron shape this registry does not understand', () => {
	const files = baselineFiles({ skip: ['ci:drain-enforced'] });
	const parsed = JSON.parse(files[PROFILES_PATH]);
	parsed.profiles.push({
		name: 'weird',
		schedule: { cron: '0 0 * * SUN', timezone: 'Etc/UTC' },
		jobs: [{ name: 'ci:drain-enforced' }],
	});
	files[PROFILES_PATH] = JSON.stringify(parsed);
	const fx = fleet(files);
	try {
		const r = run(fx.env);
		assert.equal(r.status, 1);
		assert.ok(
			r.out.findings.some((f) => f.kind === 'UNPARSEABLE-CRON' && f.job === 'ci:drain-enforced'),
			JSON.stringify(r.out.findings)
		);
	} finally {
		fx.cleanup();
	}
});
