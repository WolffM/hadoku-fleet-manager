/**
 * Tests for `runners/hosted-fallback.ts`: the CI_RUNNER variable write that
 * flips the fleet onto GitHub-hosted runners as the last resort, and the
 * write-failure debounce/alert/digest path when GitHub refuses that write.
 * Split out of runner-health.test.ts (wave 5j lane A) — see
 * `src/tests/helpers/runner-health-rig.ts` for the shared fetch-stub fixture
 * every file that ticks the monitor installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tick } from '../runner-health.js';
import { __setFleetProbeForTesting } from '../fleet-probe-store.js';
import {
	installRunnerHealthRig,
	installFetch,
	discordPosts,
	jobSinkPosts,
	variableOps,
	originalFetch,
} from './helpers/runner-health-rig.js';
import { clawLabels, hokonLabels } from './helpers/runner-health-fixtures.js';

installRunnerHealthRig();

// ── CI_RUNNER write failures are a FINDING, not a log line ──────────────────
//
// `fb.failed` reached nothing but `logger.warn`, so a repo whose variable could
// not be written retried every 10 minutes forever and said so only into a log
// nobody tails. With the bare `runs-on: ${{ fromJSON(vars.CI_RUNNER) }}` form,
// a repo that never got its value has runs-on resolve to NOTHING and every
// workflow in it fails to start.

/** All claws healthy — the fleet branch, which writes CI_RUNNER too. */
function healthyFleet() {
	return {
		runners: {
			runners: [
				{ id: 1, name: 'claw-1', status: 'online', busy: false, labels: clawLabels() },
				{ id: 2, name: 'claw-2', status: 'online', busy: false, labels: clawLabels() },
			],
		},
	};
}

test('a CI_RUNNER write failure does NOT page on the first tick', async () => {
	// Same debounce as the label floor, for the same reason: a 502 from GitHub's
	// control plane is not worth waking anyone, a revoked token scope is.
	installFetch({ ...healthyFleet(), variableStatus: 500 });
	await tick('tok');
	assert.ok(
		!discordPosts.some((p) => /CI_RUNNER/.test(p) && /could not be written/.test(p)),
		`one failed tick must debounce, got: ${JSON.stringify(discordPosts)}`
	);
});

test('a SUSTAINED CI_RUNNER write failure pages, naming the repo and the consequence', async () => {
	installFetch({ ...healthyFleet(), variableStatus: 500 });
	await tick('tok');
	await tick('tok');
	const alert = discordPosts.find((p) => /could not be written/.test(p));
	assert.ok(alert, `two failed ticks must page, got: ${JSON.stringify(discordPosts)}`);
	// Names the affected repo(s) and how many. ONE message, not one per repo:
	// a revoked token covers the whole roster, and 26 pages for one cause is the
	// noise this file refuses to send elsewhere.
	assert.match(alert, /WolffM\//, 'names at least one affected repo');
	assert.match(alert, /could not be written on \d+ repo\(s\)/, 'reports the count');
	const alerts = discordPosts.filter((p) => /could not be written/.test(p));
	assert.equal(alerts.length, 1, `one summary alert, got ${alerts.length}`);
	// The consequence is the whole point: "a variable did not write" is not
	// actionable, "that repo's workflows will not start" is.
	assert.match(alert, /FAIL TO START/);
	assert.match(alert, /actions:write/, 'names the usual cause');
});

test('a write that SUCCEEDS never pages, however many ticks run', async () => {
	// The guard must be silent on the ordinary path, or it is noise that gets
	// muted — and a muted alert is worse than none.
	installFetch(healthyFleet());
	await tick('tok');
	await tick('tok');
	await tick('tok');
	assert.ok(
		!discordPosts.some((p) => /could not be written/.test(p)),
		`a healthy write must stay silent, got: ${JSON.stringify(discordPosts)}`
	);
});

test('recovery clears the count, so a later failure debounces again', async () => {
	// Proves the clear path is real. Without it the count only ever grows, and
	// the NEXT single blip — months later — pages instantly off a stale tally.
	installFetch({ ...healthyFleet(), variableStatus: 500 });
	await tick('tok');
	globalThis.fetch = originalFetch;
	installFetch(healthyFleet()); // recovered
	await tick('tok');
	globalThis.fetch = originalFetch;
	installFetch({ ...healthyFleet(), variableStatus: 500 }); // fails again, once
	await tick('tok');
	assert.ok(
		!discordPosts.some((p) => /could not be written/.test(p)),
		`the recovery must reset the debounce, got: ${JSON.stringify(discordPosts)}`
	);
});

test('the failure count reaches the digest, not just the channel', async () => {
	// The daily ci-digest reads the job sink. A finding only the Discord channel
	// ever saw is one nobody can review after the fact.
	installFetch({ ...healthyFleet(), variableStatus: 500 });
	await tick('tok');
	const reported = jobSinkPosts.some((p) => {
		const d = (p.data ?? {}) as Record<string, unknown>;
		return typeof d.ci_runner_write_failed === 'number' && d.ci_runner_write_failed > 0;
	});
	assert.ok(reported, `the count must reach the sink, got: ${JSON.stringify(jobSinkPosts)}`);
});

/**
 * THE UNMEASURED FIRST TICK — the call site, not the module.
 *
 * ci-runner-fallback's own suite proves the writer holds on `null`. Nothing
 * proved this tick PASSES null, and that gap was real: removing the
 * `ephemeralUnknown` check at the call site compiled and left all 959 tests
 * green, because `clawsOnline + backstopOnline` is a `number` and satisfies a
 * `number | null` parameter perfectly well. The type cannot catch it. This does.
 *
 * The condition is a restart. Under all-JIT every claw's capacity comes from the
 * fast loop's probe, which is null until its first pass ~60s after boot, so this
 * tick reads zero claws on a healthy fleet. Observed 2026-09-07 over three
 * consecutive deploys: 1, then 10, then 0, then 3, against a steady 6 in
 * between, while `runners_checked=true` claimed the read had succeeded.
 *
 * `desired` has no debounce, so one such tick would pin every covered repo to
 * `ubuntu-latest` — billed minutes on 12 private repos, and a hosted runner
 * cannot reach the vault.
 */
test('an UNMEASURED probe must not pin CI_RUNNER — a restart is not an outage', async () => {
	// Exactly the shape that DOES flip when measured: claws down, hokon down.
	// The only difference from the total-outage test above is that we never
	// looked, and that difference alone must change the decision.
	__setFleetProbeForTesting(null);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'offline', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
	});

	await tick('tok');

	const writes = variableOps.filter((o) => o.startsWith('PATCH') || o.startsWith('POST'));
	assert.equal(
		writes.length,
		0,
		`an unmeasured tick must write no CI_RUNNER at all, got: ${JSON.stringify(writes)}`
	);
});

test('once the probe exists, the same dark fleet DOES flip — holding is one tick, not forever', async () => {
	// The negative half. A hold that never releases is just an outage the fleet
	// cannot escape, so the very next tick with a snapshot must decide normally.
	__setFleetProbeForTesting(null);
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'offline', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'offline', busy: false, labels: clawLabels() },
			],
		},
	});
	await tick('tok');
	assert.equal(variableOps.filter((o) => /PATCH|POST/.test(o)).length, 0, 'held');

	// The fast loop has now run: we LOOKED, and the claws really are down.
	variableOps.length = 0;
	__setFleetProbeForTesting({
		at: new Date().toISOString(),
		nodes: { 'claw-1': { reachable: false, free: 0, sick: false } },
	} as never);
	await tick('tok');

	const writes = variableOps.filter((o) => o.startsWith('PATCH') || o.startsWith('POST'));
	assert.ok(writes.length > 0, 'a MEASURED total outage must still reach hosted');
	for (const w of writes) assert.match(w, /CI_RUNNER/);
});
