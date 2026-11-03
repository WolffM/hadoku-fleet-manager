/**
 * `FleetHost.controller` (host.ts) — the switch that makes a host PASSIVE.
 *
 * hadoku_site is designing active/passive pm2 hosting (#79 Lane 2/3,
 * `docs/control-plane.md`): a passive mgmt-api replica must not run the
 * fleet's in-process loops — two controllers ticking them is double-dispatch
 * and double label writes against ONE 5,000/hr GitHub budget. `start()`
 * (index.ts) gates on `host.controller === false` at the call site; neither
 * fleet-loop.ts nor runner-health.ts know the concept exists.
 *
 * PROVEN BY LOG LINE, not by waiting on a timer. Both modules log
 * synchronously, before any interval fires: `startFastLoop` logs
 * `[fleet-loop] fast loop every …` on the turn it is called, and
 * `startRunnerHealthMonitor` logs under `[runner-health]` on the turn it is
 * called (here: "no GitHub token from host yet … waiting", because the
 * test host supplies none — deliberately, so no real interval survives this
 * test: `runner-health.ts`'s own `setInterval` is NOT `.unref()`'d, and a live
 * token would otherwise hold this test file's process open). Each module's own
 * `started` guard (already in the codebase, already a CLAUDE.md-mandated
 * singleton) makes a SECOND call in the same process a silent no-op — so the
 * absence or presence of these log lines after `start()` is a direct read of
 * whether the call site actually reached them, not an inference from timing.
 *
 * `createFleetManager` is itself a singleton (throws on a second call).
 * `__resetFleetManagerForTesting()` clears that guard AND stops every loop
 * `start()` started, clearing each module's own `started` flag, so this file
 * can exercise the switch more than once in one process without one case's
 * real activation making the next case's assertion vacuous. The last test
 * below holds that the reset's stop list keeps up with `start()`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFleetManager, __resetFleetManagerForTesting } from '../index.js';
import { getRunnerHealthSnapshot } from '../runner-health-snapshot.js';
import { __setHostForTesting, type FleetHost } from '../host.js';
import { testHost } from './install-test-host.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
/** dist/tests/ -> dist/ -> <repo root>/manifests */
const REAL_MANIFESTS = resolve(HERE, '..', '..', 'manifests');

/**
 * A host built on the real `testHost` (real manifests, a throwaway state dir),
 * overridden to capture every log line and to supply NO GitHub token. No token
 * is load-bearing, not incidental: both `startFastLoop` and
 * `startRunnerHealthMonitor` tick immediately and unconditionally when
 * actually called, and a real token would hand `runner-health` a live,
 * non-unref'd `setInterval` this test would then have to tear down by hand on
 * every exit path, including a failed assertion.
 *
 * `createFleetManager` -> `installHost` runs the REAL `requirePaths` check —
 * unlike `testHost` itself, which the preload installs via
 * `__setHostForTesting` and so never exercises it. `testHost.cronProfilesPath`
 * points at a fixture (`scripts/cron-profiles.test.json`) that does not exist
 * on disk anywhere in this checkout — a pre-existing gap outside this lane's
 * files. `host.test.ts` already works around exactly this by pointing
 * `storeDoctorPath`/`cronProfilesPath` at some real, existing file instead of
 * the one `testHost` names; this does the same rather than creating the
 * missing fixture.
 */
function hostWith(lines: string[], controller: boolean | undefined): FleetHost {
	return {
		...testHost,
		controller,
		githubToken: () => undefined,
		storeDoctorPath: resolve(REAL_MANIFESTS, 'fleet-runner-manifest.json'),
		cronProfilesPath: resolve(REAL_MANIFESTS, 'fleet-runner-manifest.json'),
		logger: {
			info: (m) => lines.push(m),
			warn: (m) => lines.push(m),
			error: (m) => lines.push(m),
		},
	};
}

test('controller: false — start() starts neither loop, logs one line, router/snapshot still work', () => {
	const lines: string[] = [];
	const mgr = createFleetManager(hostWith(lines, false));
	try {
		mgr.start();

		assert.ok(
			lines.some((l) => l.includes('controller=false')),
			`expected one log line naming controller=false, got: ${JSON.stringify(lines)}`
		);
		assert.ok(
			!lines.some((l) => l.includes('[fleet-loop]')),
			`the fast loop must not have started: ${JSON.stringify(lines)}`
		);
		assert.ok(
			!lines.some((l) => l.includes('[runner-health]')),
			`runner-health must not have started: ${JSON.stringify(lines)}`
		);
		assert.ok(
			!lines.some((l) => l.includes('[provisioning]')),
			`the provisioning converger must not have started: ${JSON.stringify(lines)}`
		);

		// The router is still the real one — not gated on controller at all.
		assert.ok(mgr.router, 'router must still be served on a passive host');

		// No tick has ever run, so there is nothing to report. See the doc comment
		// on FleetManager.snapshot in index.ts for why this is `null` rather than
		// "the last known state": there IS no prior state on a host that never ticks.
		assert.equal(mgr.snapshot(), null, 'a passive host must report snapshot() as null');
		assert.equal(getRunnerHealthSnapshot(), null);
	} finally {
		__resetFleetManagerForTesting();
		__setHostForTesting(testHost);
	}
});

test('controller omitted — defaults to true, start() starts both loops', () => {
	const lines: string[] = [];
	const mgr = createFleetManager(hostWith(lines, undefined));
	try {
		mgr.start();

		assert.ok(
			lines.some((l) => l.includes('[fleet-loop] fast loop every')),
			`the fast loop must have started when controller is omitted: ${JSON.stringify(lines)}`
		);
		assert.ok(
			lines.some((l) => l.includes('[runner-health]')),
			`runner-health must have started when controller is omitted: ${JSON.stringify(lines)}`
		);
		assert.ok(
			!lines.some((l) => l.includes('controller=false')),
			'must not log the passive-host line when controller is omitted'
		);
	} finally {
		__resetFleetManagerForTesting();
		__setHostForTesting(testHost);
	}
});

test('controller: true — explicit true behaves exactly like omitted', () => {
	const lines: string[] = [];
	const mgr = createFleetManager(hostWith(lines, true));
	try {
		mgr.start();

		assert.ok(
			lines.some((l) => l.includes('[fleet-loop] fast loop every')),
			`the fast loop must have started with controller: true: ${JSON.stringify(lines)}`
		);
		assert.ok(
			lines.some((l) => l.includes('[runner-health]')),
			`runner-health must have started with controller: true: ${JSON.stringify(lines)}`
		);
		assert.ok(
			lines.some((l) => l.includes('[provisioning] converger every 30 min')),
			`the provisioning converger must have started with controller: true: ${JSON.stringify(lines)}`
		);
	} finally {
		__resetFleetManagerForTesting();
		__setHostForTesting(testHost);
	}
});

/**
 * The reset's stop list keeps up with `start()`. A teardown kept by hand in this
 * file once stopped seven of the nine loops `start()` starts, and the capacity
 * sampler and the ppe sweep kept their timers for the rest of the process: the
 * timers are unref'd, so nothing hung and nothing failed. Read off the source,
 * every module index.ts imports a `start*` from must also give it a
 * `__stop*ForTesting`/`__reset*ForTesting`, and `__resetFleetManagerForTesting`
 * must call it.
 */
test('__resetFleetManagerForTesting stops every loop start() starts', () => {
	const src = readFileSync(resolve(HERE, '..', '..', 'src', 'index.ts'), 'utf8');
	const reset = src.slice(src.indexOf('export function __resetFleetManagerForTesting'));
	const resetBody = reset.slice(0, reset.indexOf('\n}\n'));
	const starters = [
		...src.matchAll(/import\s*\{([^}]*\bstart[A-Z]\w*[^}]*)\}\s*from\s*'([^']+)'/g),
	];
	assert.ok(starters.length >= 9, `expected the nine loop imports, found ${starters.length}`);
	for (const [, names, from] of starters) {
		const stop = names.match(/__(?:stop|reset)\w*ForTesting/)?.[0];
		assert.ok(stop, `${from}: index.ts imports a start*() from it but no stop seam`);
		assert.ok(resetBody.includes(`${stop}();`), `${from}: the reset never calls ${stop}()`);
	}
});
