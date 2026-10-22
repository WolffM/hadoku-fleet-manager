/**
 * Installs a test host before any test module loads.
 *
 * Preloaded with `node --import`, so it runs ahead of every import in every
 * suite. That ordering matters: several modules resolve manifest paths at module
 * scope, and a host installed inside a `beforeEach` would already be too late.
 *
 * `stateDir` points at a throwaway temp directory, and that is load-bearing.
 * Inside mgmt-api this path came from a compile-time constant, so
 * `runner-health.test.ts` had to call `__setHistoryPathForTesting` in
 * `beforeEach` or the suite would load — and `compactHistory()` would REWRITE —
 * the operator's real `~/.hadoku-mgmt/job-history.jsonl`. That was a documented
 * trap guarded only by discipline. Injection makes it structural: the tests can
 * no longer reach the operator's file even if someone drops the beforeEach.
 * Keep the beforeEach anyway; belt and braces on a file that cannot be restored.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __setHostForTesting, type FleetHost } from '../host.js';
import {
	__setBackstopMachinesForTesting,
	__setHostLoadReaderForTesting,
} from '../runner-health.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
/** dist/tests/ -> dist/ -> <repo root>/manifests */
const MANIFESTS = resolve(HERE, '..', '..', 'manifests');

export const testStateDir = mkdtempSync(join(tmpdir(), 'fleet-manager-test-'));

// Deliberately NOT `tempDir()` from ./tmpdir.js. That registry is cleared per
// test by suites like runner-health, and this directory has to outlive every
// one of them — it is the state dir the whole process writes through, created
// once at preload. Registering it there would have `cleanupTempDirs()` delete
// the live state dir between tests.
//
// It leaked 58,165 directories into /tmp by 2026-09-27 (one per test process,
// every CI run since 2026-09-07) purely because nothing ever removed it. One
// exit handler is the entire fix; the lifetime was always right.
process.on('exit', () => {
	try {
		rmSync(testStateDir, { recursive: true, force: true });
	} catch {
		// best effort — a temp dir that will not delete is not worth a red run
	}
});

/**
 * Discord and job-sink doubles that are BEHAVIOURALLY faithful, not stubs.
 *
 * The moved suites observe alerting through a `fetch` stub — `discordPosts` is
 * filled by matching the webhook URL, `jobSinkPosts` by matching
 * `/health/api/jobs`. A no-op host makes every one of those assertions vacuously
 * pass while asserting nothing, which is precisely the failure mode this
 * codebase keeps paying for. So these doubles perform the same observable I/O
 * the real ports do.
 *
 * They are not re-implementations of the real ports and must not grow into them:
 * `discord-sink` and `job-sink` stay in mgmt-api and keep their own tests there
 * (chunking, the MGMT_CRON_KEY dedupe, the @wolffm/logger reporter). What is
 * reproduced here is only the contract these suites actually watch.
 */
const DISCORD_CONTENT_LIMIT = 2000;

function chunk(content: string, limit = DISCORD_CONTENT_LIMIT): string[] {
	if (content.length <= limit) return [content];
	const parts: string[] = [];
	for (let i = 0; i < content.length; i += limit) parts.push(content.slice(i, i + limit));
	return parts;
}

export const testHost: FleetHost = {
	logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
	alerts: {
		async post(content) {
			const url = (process.env.DISCORD_EMERGENCY_NOTIFICATIONS_WEBHOOK ?? '').trim();
			if (!url) return { posted: false, sinkRecorded: false, lastError: 'webhook unset' };
			for (const part of chunk(content)) {
				const resp = await fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ content: part }),
				});
				if (!resp.ok) {
					return { posted: false, sinkRecorded: false, lastError: `HTTP ${resp.status}` };
				}
			}
			return { posted: true, sinkRecorded: true };
		},
		recordQuietly: () => undefined,
	},
	jobs: {
		async recordJobResult(jobName, jobState, durationMs, opts) {
			// URL shape matters: the harness matches on `/health/api/jobs`, and that
			// literal ordering is load-bearing — it must be checked before the
			// generic `/jobs` matcher or its capture array silently empties.
			await fetch('https://hadoku.me/health/api/jobs', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-User-Key': process.env.MGMT_CRON_KEY ?? '',
				},
				body: JSON.stringify({
					job_name: jobName,
					status: jobState,
					duration_ms: durationMs,
					error: opts?.error,
					cron: opts?.cron,
					data: opts?.data,
				}),
			});
		},
	},
	githubToken: () => undefined,
	manifestDir: MANIFESTS,
	stateDir: testStateDir,
	storeDoctorPath: resolve(MANIFESTS, '..', 'scripts', 'pnpm-store-doctor.sh'),
	cronProfilesPath: resolve(MANIFESTS, '..', 'scripts', 'cron-profiles.test.json'),
};

// Bypasses requirePaths deliberately: the doctor script and cron profiles are
// host-supplied in production and irrelevant to these suites, while the
// manifests are real and must be.
__setHostForTesting(testHost);
// The backstop's idle check would otherwise read THIS machine's /proc — and the
// fixtures' backstop node is named `hokon`, which is this machine. Every test
// sees an idle host unless it says otherwise.
__setHostLoadReaderForTesting(() => ({ load1: 0, cores: 12, memAvailableMb: 32_768 }));
// No `backstop` key anywhere: every node may be promoted on saturation unless a test says otherwise.
__setBackstopMachinesForTesting(() => ({}));
