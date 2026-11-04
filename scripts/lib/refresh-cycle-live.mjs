/**
 * refresh-cycle's LIVE DEPENDENCIES — everything that touches a real node,
 * `ssh`, or this package's own CLIs. Split out of `refresh-cycle.mjs` (wave
 * 5s lane D, 800-line ceiling): that file keeps the pure orchestration and
 * is exercised by fixtures; this one is exercised only by
 * `fleet converge-toolchain --refresh` (`createLiveDeps()`), `reboot-claws.mjs`
 * and `bootcamp.mjs`'s idle/canary checks. `benchmark-fleet.mjs`'s cadence
 * mode now imports `busyCount`/`drain`/`undrain`/`isDrained`/`waitUntilDrained`
 * straight from `drain-wait.mjs` rather than through this file (wave clean-2
 * lane C: this file is lifecycle, `benchmark-fleet.mjs` is observation, and
 * cut (iii) forbids that edge) — `createLiveDeps()` below uses the exact same
 * functions, so behaviour is unchanged.
 *
 * Every name defined IN THIS FILE is re-exported from `refresh-cycle.mjs`, so
 * nothing outside this pair of files needs to know the split happened.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic } from '../../dist/lib/atomic-json.js';
import { stateDir } from '../../dist/lib/fleet-paths.js';
import { parseToolProbe, toolProbeScript } from '../check-fleet-toolchain.mjs';
import { deferralFor, readDrains } from './expected-down.mjs';
import { repairContext, runOnSync } from './fleet-exec.mjs';
import { byRole } from './toolchain-floor.mjs';
import { createReleaseLookup, resolveInstallTarget } from './tool-release.mjs';
import { SITE_WRITER_ENV, siteWriterDir } from './manifest-target.mjs';
import { errText } from './term.mjs';
import { PRESSURE_OLDEST_SECONDS, runWorkItem } from './refresh-cycle.mjs';
// busyCount/drainCli/isDrained/drain/undrain/waitUntilDrained moved to
// drain-wait.mjs (wave clean-2 lane C, cut (iii) layer debt): classified
// observation/run, the stratum both this (lifecycle) file and
// benchmark-fleet.mjs (observation) may import. `createLiveDeps()` below
// delegates to the shared `isDrained`/`drain`/`undrain` rather than
// reimplementing them, so its own behaviour stays byte-identical.
import { busyCount, drain, isDrained, undrain, waitUntilDrained } from './drain-wait.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');

/** Queue pressure from `check-queue-health --json` (its zombie band applies). */
export function judgePressure(doc) {
	if (!doc || typeof doc !== 'object' || typeof doc.queued !== 'number') {
		return { pressured: true, unknown: true, reason: doc?.error ?? 'queue health gave no summary' };
	}
	if (doc.unreadable > 0) {
		return {
			pressured: true,
			unknown: true,
			reason: `${doc.unreadable} repo queue(s) unreadable`,
		};
	}
	if (doc.stranded > 0) {
		return {
			pressured: true,
			reason: `${doc.stranded} stranded run(s) — the fleet is not serving`,
		};
	}
	if (doc.queued > 0 && doc.oldest >= PRESSURE_OLDEST_SECONDS) {
		return {
			pressured: true,
			reason: `${doc.queued} run(s) waiting, oldest ${doc.oldest}s (>= ${PRESSURE_OLDEST_SECONDS}s)`,
		};
	}
	return { pressured: false };
}

/** {@link judgePressure} over a live `check-queue-health --json`. Shared with the reboot cycle. */
export function liveQueuePressure() {
	const r = spawnSync(process.execPath, [join(SCRIPTS, 'check-queue-health.mjs'), '--json'], {
		encoding: 'utf8',
		timeout: 300_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	// Parseable stdout wins over the exit code: a non-zero exit is a finding.
	const out = String(r.stdout ?? '').trim();
	if (!out.startsWith('{')) {
		return {
			pressured: true,
			unknown: true,
			reason: `queue-health produced no JSON (${r.error?.message ?? `exit ${r.status}`})`,
		};
	}
	try {
		return judgePressure(JSON.parse(out));
	} catch (e) {
		return {
			pressured: true,
			unknown: true,
			reason: `queue-health JSON unparseable: ${e.message}`,
		};
	}
}

export function createLiveDeps() {
	const lookup = createReleaseLookup();
	// One read per role (`byRole`): a tool is read as the user whose state it is.
	const probe = (node, tools) => {
		const seen = {};
		for (const [role, group] of byRole(tools)) {
			const res = runOnSync(node, toolProbeScript(group), {
				as: role,
				timeoutMs: 60_000,
				connectTimeout: 8,
			});
			const part = parseToolProbe(res.out ?? '');
			if (!res.ok && !Object.keys(part).length) {
				return {
					ok: false,
					reason: `as ${role}: ${(res.error || 'unreadable').trim().slice(0, 200)}`,
				};
			}
			Object.assign(seen, part);
		}
		return { ok: true, seen };
	};
	const clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
	return {
		// THE ONE RESOLVER (issue #70): the same function bootcamp calls, so the
		// two cannot compute "what to install" differently. minAge only — the
		// cadence moves to the newest release that has cleared the debounce; the
		// doctor adds a tolerance on top of that, and we do not.
		latest: (_id, tool) => resolveInstallTarget(tool, { lookup }),
		detect: (node, tools) => {
			const p = probe(node, tools);
			if (p.ok) return p;
			const defer = deferralFor(node, readDrains());
			return { ...p, expectedDown: defer.deferred };
		},
		reprobe: (node, tools) => probe(node, tools),
		isDrained,
		drain,
		undrain,
		waitDrained: (node) => waitUntilDrained({ node, busy: busyCount, clock }),
		update: (node, work) =>
			work.map((w) =>
				runWorkItem(
					w,
					(script) =>
						runOnSync(node, script, { as: 'admin', timeoutMs: 600_000, connectTimeout: 8 }),
					repairContext(node)
				)
			),
		queuePressure: liveQueuePressure,
		lastChecked: (node) => readRecheckLog()[node] ?? 0,
		markChecked: (node) => {
			const log = readRecheckLog();
			log[node] = Date.now();
			writeFileAtomic(recheckLogPath(), `${JSON.stringify(log, null, 2)}\n`);
		},
		// Re-record the node while the cycle holds it drained, through the cycle's
		// OWN worktree reset to origin/main first (`siteWriterDir`, lib/manifest-target.mjs). A refusal
		// comes back as a finding, never a hold.
		rebootcamp: (node) => {
			let dir;
			try {
				dir = siteWriterDir();
			} catch (e) {
				return { ok: false, reason: `could not prepare the writer tree: ${errText(e)}` };
			}
			const r = spawnSync(
				process.execPath,
				[join(SCRIPTS, 'bootcamp.mjs'), '--machine', node, '--write', '--json'],
				{
					encoding: 'utf8',
					timeout: REBOOTCAMP_TIMEOUT_MS,
					// The fleet's writer tree and its env (lib/manifest-target.mjs says why).
					env: { ...process.env, FLEET_MANIFEST_DIR: dir, ...SITE_WRITER_ENV },
				}
			);
			if (r.error) return { ok: false, reason: errText(r.error) };
			// No document is a failed run, not proof the node is down.
			let doc = null;
			try {
				doc = JSON.parse(r.stdout);
			} catch {
				doc = null;
			}
			const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ');
			if (r.status !== 0) {
				const reason =
					doc === null
						? `exit ${r.status} with no document: ${tail}`
						: (doc.error ?? doc.written?.reason ?? `exit ${r.status}: ${tail}`);
				return { ok: false, reason: String(reason).slice(0, 300) };
			}
			return { ok: true };
		},
	};
}

/** Bootcamp probes every capability, cargo-bevy's build included. */
const REBOOTCAMP_TIMEOUT_MS = 30 * 60_000;
/** node -> epoch ms the cycle last re-bootcamped it, in the state dir (never a checkout). */
function recheckLogPath() {
	return join(stateDir(), 'recheck-log.json');
}
function readRecheckLog() {
	try {
		return JSON.parse(readFileSync(recheckLogPath(), 'utf8'));
	} catch {
		// Absent or unreadable: every node reads as never rechecked, which only
		// makes the cycle MORE eager to recheck — the safe direction.
		return {};
	}
}
