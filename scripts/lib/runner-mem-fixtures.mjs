/**
 * The shared rig for the memory pipeline's own regressions — #46 and #47, the
 * two halves lane M of wave 3l owns — split out (wave 5q lane D) so
 * `runner-mem.test.mjs` could be split by concern without copying its
 * fixture helpers into both halves. The precedent is `runner-health-rig.ts`
 * (wave 5q lane B): one rig, several test files, each installing only the
 * helpers it calls.
 *
 *   #47  the harvester matched zero runner cgroups under all-JIT naming while
 *        staying `active` on three claws, and was absent from five more. The
 *        tests pin the unit-name STEMS to the jit-/warm- shapes, and pin the
 *        `--check` gate to the OUTPUT files: a node whose newest completed
 *        job postdates its newest window is a FINDING even though the unit is
 *        green — today's claw-1 shape, by construction.
 *   #46  `fleet mem-report` resolved its manifest through the package's own
 *        library instead of reading the 4-machine fixture packaged with the
 *        repo. The tests pin both halves: it READS the tree the library
 *        resolved, and it REFUSES (never falls back) when the library refuses.
 *
 * Everything here builds FIXTURES: a scratch site checkout, a scratch HOME.
 * The one live thing the --check tests touch is this box's own
 * `bash`/`stat`/`date` — the same commands the probe uses on a node — and
 * `.invalid` ssh targets, which cannot resolve by design.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
export const HARVEST = join(SCRIPTS, 'runner-mem-harvest.py');
export const REPORT = join(SCRIPTS, 'runner-mem-report.py');
/** The manifest name this box answers to — spelled the raw `os.hostname()` way
 * so the library's normalising compare is exercised, not bypassed. */
export const ME = hostname();

export const run = (cmd, args, opts = {}) =>
	spawnSync(cmd, args, { encoding: 'utf8', timeout: 180_000, ...opts });

/** Import a python module and print one expression — the driven-test seam
 * `slice-placement-guard.test.mjs` established for these two scripts. */
export function pyExpr(module, expr, env = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'mem-py-'));
	try {
		const driver = join(dir, 'drive.py');
		writeFileSync(
			driver,
			[
				'import importlib.util, json, os, sys',
				`spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(module)})`,
				'm = importlib.util.module_from_spec(spec)',
				'spec.loader.exec_module(m)',
				`print(json.dumps(${expr}))`,
			].join('\n')
		);
		const r = run('python3', [driver], { env: { ...process.env, ...env } });
		assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
		return JSON.parse(r.stdout);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A scratch site checkout whose scripts/admin holds a manifest. */
export function siteFixture(machines) {
	const dir = mkdtempSync(join(tmpdir(), 'mem-site-'));
	const admin = join(dir, 'site', 'scripts', 'admin');
	mkdirSync(admin, { recursive: true });
	writeFileSync(join(admin, 'fleet-runner-manifest.json'), JSON.stringify({ machines }, null, 2));
	return { dir, admin };
}

/** A scratch HOME carrying whatever harvester/job outputs the caller seeds. */
export function homeFixture({ samples, inflight, jobs }) {
	const home = mkdtempSync(join(tmpdir(), 'mem-home-'));
	const state = join(home, '.local/state/hadoku/runner-mem');
	mkdirSync(state, { recursive: true });
	mkdirSync(join(home, '.hadoku'), { recursive: true });
	if (samples != null) writeFileSync(join(state, 'samples.jsonl'), samples);
	if (inflight != null) writeFileSync(join(state, 'inflight.json'), inflight);
	if (jobs != null) writeFileSync(join(home, '.hadoku/job-metrics.jsonl'), jobs);
	return home;
}

export const iso = (epoch) => new Date(epoch * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
export const sampleRow = (end) =>
	JSON.stringify({
		host: ME,
		unit: 'jit-claw-1-fx-j1-r2-3.service',
		start: end - 60,
		end,
		dur_s: 60,
		clipped: false,
		peak_unreclaimable_mb: 900,
		peak_current_mb: 1800,
	});
export const jobRow = (ts) =>
	JSON.stringify({
		ts: iso(ts),
		node: ME,
		kind: 'jit',
		repo: 'WolffM/fx',
		peakBytes: 1,
		peakBasis: 'job',
	});

/** A job-metrics.jsonl row for a JIT job, carrying the `jobId` the
 * CONTROLLER's job-history is keyed on. `_parse_job_record` no longer reads a
 * duration from this row's `runner` name — a runner's name says who it was
 * MINTED for, not necessarily who it ended up serving (GitHub can reassign),
 * and even a matching name's mint-to-completion span includes the wait for
 * assignment, which is not sample-able time either. The actual duration this
 * fixture's test expects comes from a SEPARATE job-history fixture, keyed on
 * `jobId` — see `jobHistoryFixture`. */
export const jitJobRow = (completedAt, jobId, { runId = 2 } = {}) =>
	JSON.stringify({
		ts: iso(completedAt),
		node: ME,
		kind: 'jit',
		repo: 'WolffM/fx',
		runId,
		jobId,
		job: 'ci',
		runner: `jit-${ME}-fx-j${jobId}-r${runId}-${Math.round(completedAt)}`,
		status: '',
		peakBytes: 1,
		peakBasis: 'job',
	});

/** A job-metrics.jsonl row for a STANDING/`warm-*` job — `jobId` is always
 * `null` on this shape (the hook has no per-job id for a long-lived unit), so
 * its duration is structurally unknowable from job-history no matter what
 * that file holds. */
export const warmJobRow = (completedAt) =>
	JSON.stringify({
		ts: iso(completedAt),
		node: ME,
		kind: 'standing',
		repo: 'WolffM/fx',
		runId: 99,
		jobId: null,
		job: 'ci',
		runner: `warm-${ME}-fx`,
		status: '',
		peakBytes: 1,
		peakBasis: 'job',
	});

/** A scratch `job-history.jsonl` — the CONTROLLER's ground truth for how long
 * a job actually ran, keyed on `jobId`. Read locally, from `HADOKU_STATE_DIR`
 * (mirroring `stateDir()`, `src/lib/fleet-paths.ts:228`), never over ssh. */
export function jobHistoryFixture(entries) {
	const dir = mkdtempSync(join(tmpdir(), 'mem-history-'));
	const rows = entries.map(({ jobId, durationSec }) =>
		JSON.stringify({
			repo: 'WolffM/fx',
			runId: 1,
			jobId,
			name: 'ci',
			runner: ME,
			labels: ['self-hosted'],
			startedAt: iso(Date.now() / 1000 - durationSec),
			durationSec,
		})
	);
	writeFileSync(join(dir, 'job-history.jsonl'), rows.join('\n') + (rows.length ? '\n' : ''));
	return dir;
}

/** Runs `--check` with BOTH the harvest-output fixture AND a job-history
 * fixture in scope, the shape the real check runs in: harvest output over
 * ssh (here, read locally since this box is "local"), job-history read
 * locally from `HADOKU_STATE_DIR` — never ssh for either, in production. */
export function runCheckWithHistory(fx, historyDir, args = [], extraEnv = {}) {
	return run('python3', [REPORT, '--check', ...args], {
		cwd: fx.dir,
		env: {
			...process.env,
			HOME: fx.home,
			PATH: fixturePath(fx),
			FLEET_MANIFEST_DIR: fx.admin,
			FLEET_NO_BANNER: '1',
			HADOKU_STATE_DIR: historyDir,
			...extraEnv,
		},
	});
}

/**
 * The probe also asks `systemctl --user` when the sampler started, and a
 * fixture HOME does not stop that reaching the box the test runs on. On
 * 2026-10-25 CI ran on claw-6 three minutes after its reboot: the REAL
 * harvester's start excused this file's "long job five minutes ago" and the
 * mixed-history test went red. So every check fixture answers for the sampler
 * itself — up for days, the steady state these tests describe — and the
 * runners below put that stub first on PATH.
 */
export function checkFixture({ samples, inflight, jobs, machines }) {
	const home = homeFixture({ samples, inflight, jobs });
	const { dir, admin } = siteFixture(machines ?? { [ME]: { ramGb: 16, maxConcurrent: 2 } });
	const fx = { home, dir, admin };
	withSamplerStart(fx, Date.now() / 1000 - 10 * 86400);
	return fx;
}

export const fixturePath = (fx) => `${join(fx.home, 'bin')}:${process.env.PATH}`;

export function runCheck(fx, args = []) {
	return run('python3', [REPORT, '--check', ...args], {
		cwd: fx.dir,
		env: {
			...process.env,
			HOME: fx.home,
			PATH: fixturePath(fx),
			FLEET_MANIFEST_DIR: fx.admin,
			FLEET_NO_BANNER: '1',
		},
	});
}

export function runReport(fx, args = []) {
	return run('python3', [REPORT, ...args], {
		cwd: fx.dir,
		env: {
			...process.env,
			HOME: fx.home,
			PATH: fixturePath(fx),
			FLEET_MANIFEST_DIR: fx.admin,
			FLEET_NO_BANNER: '1',
		},
	});
}

/** A pre-#44-schema record: no `clipped` key at all. */
export const unmarkedRow = (end, mb, unit = 'actions-runner-brave-quartet.service') =>
	JSON.stringify({
		host: ME,
		unit,
		start: end - 180,
		end,
		dur_s: 180,
		peak_unreclaimable_mb: mb,
		peak_current_mb: mb + 500,
	});

/** A confirmed-clipped record: the cap and the kill both present. */
export const clippedRow = (
	end,
	{ unit = 'actions-runner-fx.service', capMb = 4096, oomKills = 2, mb = 4096 } = {}
) =>
	JSON.stringify({
		host: ME,
		unit,
		start: end - 60,
		end,
		dur_s: 60,
		clipped: true,
		oom_kills: oomKills,
		cgroup_reset: false,
		cap_mb: capMb,
		peak_unreclaimable_mb: mb,
		peak_current_mb: mb + 200,
	});

/** A confirmed-CLEAN record (post-#44-schema, `clipped: false`). */
export const cleanRow = (end, mb, unit = 'actions-runner-fx.service') =>
	JSON.stringify({
		host: ME,
		unit,
		start: end - 60,
		end,
		dur_s: 60,
		clipped: false,
		peak_unreclaimable_mb: mb,
		peak_current_mb: mb + 200,
	});

/** Force the probe's sampler-start answer without touching a real unit. */
export function withSamplerStart(fx, epochOrNull) {
	const bin = join(fx.home, 'bin');
	mkdirSync(bin, { recursive: true });
	// `systemctl` is what the probe asks; a stub on PATH answers for it. The
	// probe pipes the answer through `date -d`, so the stub emits a timestamp
	// in the format systemd itself prints.
	writeFileSync(
		join(bin, 'systemctl'),
		epochOrNull === null
			? '#!/bin/sh\nexit 1\n'
			: `#!/bin/sh\ndate -u -d @${Math.floor(epochOrNull)} "+%a %Y-%m-%d %H:%M:%S UTC"\n`,
		{ mode: 0o755 }
	);
	return bin;
}
