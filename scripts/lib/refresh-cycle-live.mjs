/**
 * refresh-cycle's LIVE DEPENDENCIES — everything that touches a real node,
 * `ssh`, or this package's own CLIs. Split out of `refresh-cycle.mjs` (wave
 * 5s lane D, 800-line ceiling): that file keeps the pure orchestration and
 * is exercised by fixtures; this one is exercised only by
 * `fleet converge-toolchain --refresh` (`createLiveDeps()`), `reboot-claws.mjs`
 * and `benchmark-fleet.mjs`'s cadence mode (`busyCount`/`waitUntilDrained`
 * directly), and `bootcamp.mjs`'s idle/canary checks.
 *
 * Every name here is re-exported from `refresh-cycle.mjs`, so nothing outside
 * this pair of files needs to know the split happened.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic } from '../../dist/lib/atomic-json.js';
import { hubRepo } from '../../dist/lib/fleet-config.js';
import { reposDir, stateDir } from './paths.mjs';
import { parseToolProbe, toolProbeScript } from '../check-fleet-toolchain.mjs';
import { deferralFor, readDrains } from './expected-down.mjs';
import { runOnSync, separateCiUser } from './fleet-exec.mjs';
import { byRole, resolveInstallTarget } from './toolchain-floor.mjs';
import { createReleaseLookup } from './tool-release.mjs';
import { errText } from './term.mjs';
import { PRESSURE_OLDEST_SECONDS, runWorkItem, waitUntilDrained } from './refresh-cycle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');

/**
 * Job count on a node, or null for "could not look" (treated as busy).
 *
 * EXPORTED (wave 3x, #87) so `benchmark-fleet.mjs`'s cadence mode can ask the
 * same question before committing to a drain, rather than growing a second
 * "is this node busy" prober. No behaviour change — this is the function
 * `createLiveDeps()` already wired into `waitUntilDrained` below.
 */
export function busyCount(node) {
	const res = runOnSync(node, 'pgrep -c -f "[R]unner\\.Worker" || true', {
		as: 'admin',
		timeoutMs: 20_000,
		connectTimeout: 6,
	});
	if (!res.ok) return null;
	const n = parseInt(String(res.out).trim().split('\n')[0], 10);
	return Number.isFinite(n) ? n : null;
}

/** `fleet drain <args>`, as `{ ok, reason? }`. Also the reboot cycle's (lib/reboot-cycle.mjs) one way to drain. */
export function drainCli(args) {
	try {
		execFileSync(process.execPath, [join(SCRIPTS, 'drain-node.mjs'), ...args], {
			encoding: 'utf8',
			timeout: 60_000,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			reason: String(e.stderr || e.message)
				.trim()
				.slice(0, 300),
		};
	}
}

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
		isDrained: (node) => Boolean(readDrains()[node]),
		drain: (node, { kind, reason }) => {
			const r = drainCli([node, '--reason', reason, '--kind', kind]);
			if (!r.ok) throw new Error(r.reason);
			return r;
		},
		undrain: (node) => drainCli([node, '--undo']),
		waitDrained: (node) => waitUntilDrained({ node, busy: busyCount, clock }),
		update: (node, work) =>
			work.map((w) =>
				runWorkItem(
					w,
					(script) =>
						runOnSync(node, script, { as: 'admin', timeoutMs: 600_000, connectTimeout: 8 }),
					{ ciUser: separateCiUser(node) }
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
		// OWN worktree reset to origin/main first (`writerManifestDir`). A refusal
		// comes back as a finding, never a hold.
		rebootcamp: (node) => {
			let dir;
			try {
				dir = writerManifestDir();
			} catch (e) {
				return { ok: false, reason: `could not prepare the writer tree: ${errText(e)}` };
			}
			const r = spawnSync(
				process.execPath,
				[join(SCRIPTS, 'bootcamp.mjs'), '--machine', node, '--write', '--json'],
				{
					encoding: 'utf8',
					timeout: REBOOTCAMP_TIMEOUT_MS,
					// SKIP_GATES: hadoku_site's pre-push hook runs its whole code-gate
					// set (predev, lint, gate-coverage…) and the writer tree has no
					// dev environment, so every automated record was committed and
					// NOT pushed (claw-2, 2026-10-09). The commit is a data record;
					// hadoku_site's CI runs every gate on main after it lands.
					env: { ...process.env, FLEET_MANIFEST_DIR: dir, SKIP_GATES: '1' },
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

/**
 * The manifest dir bootcamp writes through: a detached worktree of the dev
 * repo, owned by this cycle and RESET to a fresh origin/main before every write.
 *
 * Not the dev checkout itself. The writer commits on whatever HEAD it finds and
 * pushes only a fast-forward, and the shared checkout drifts: on 2026-10-09 it
 * sat 18 commits behind, so claw-1's re-recorded `$capabilities` was committed
 * there and NOT pushed — the record the cycle exists to refresh would never
 * have reached main. Not ~/srv either: the writer refuses it (every deploy
 * resets it). A tree of its own, reset each time, always fast-forwards.
 */
function writerManifestDir() {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
	);
	const git = (args) => execFileSync('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
	const repo = join(reposDir(), hubRepo());
	const tree = join(stateDir(), 'site-writer');
	git(['-C', repo, 'fetch', '-q', 'origin', 'main']);
	if (!existsSync(join(tree, '.git'))) {
		git(['-C', repo, 'worktree', 'add', '-q', '--detach', '-f', tree, 'origin/main']);
	} else {
		git(['-C', tree, 'checkout', '-q', '--detach', '-f', 'origin/main']);
		git(['-C', tree, 'clean', '-fdq', '--', 'scripts/admin']);
	}
	return join(tree, 'scripts', 'admin');
}
