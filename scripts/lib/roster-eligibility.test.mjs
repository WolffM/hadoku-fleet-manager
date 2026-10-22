/**
 * The roster shrinking must be an EVENT, not an absence.
 *
 * The measured shape this exists to make impossible (mgmt-api nightly log):
 *
 *   08-30  29 repos / 87 pairs  missing=9   <- paged, nothing installed
 *   08-31  26 repos / 78 pairs  missing=0   <- "recovered"
 *
 * Nobody installed a runner. Three repos stopped matching autoInclude and took
 * their own coverage gap out of scope, and the gate reported a clean fleet.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { autoIncludeDrop } from './roster-eligibility.mjs';
import { blankComments } from './blank-comments.mjs';

const AI = { excludeForks: true, pushedWithinDays: 180, minWorkflows: 2 };
const NOW = Date.parse('2026-08-31T00:00:00Z');

/** A repo that passes every rule unless a field is overridden. */
const repo = (over = {}) => ({
	nameWithOwner: 'WolffM/example',
	isFork: false,
	pushedAt: '2026-08-30T12:00:00Z',
	...over,
});

/** Probes that answer for every name, counting how often each was asked. */
function probes({ workflows = 5, fleet = false } = {}) {
	const calls = { countWorkflows: 0, targetsSelfHostedFleet: 0 };
	return {
		calls,
		probe: {
			countWorkflows: () => (calls.countWorkflows++, workflows),
			targetsSelfHostedFleet: () => (calls.targetsSelfHostedFleet++, fleet),
		},
	};
}

// ── a covered repo is eligible ──────────────────────────────────────────────

test('an eligible repo yields null — no reason, because it did not leave', () => {
	const { probe } = probes();
	assert.equal(autoIncludeDrop(repo(), AI, probe, NOW), null);
});

// ── each rule names ITSELF, not "not eligible" ──────────────────────────────

test('a fork says it is a fork', () => {
	const { probe } = probes();
	const why = autoIncludeDrop(repo({ isFork: true }), AI, probe, NOW);
	assert.match(why, /fork/);
});

test('an aged-out repo names the date AND the window it fell outside', () => {
	// The operator has to be able to tell "this is intended" from "this moved".
	// A bare "not eligible" cannot answer that; 26 repos of it is unreadable.
	const { probe } = probes();
	const why = autoIncludeDrop(repo({ pushedAt: '2026-01-05T00:00:00Z' }), AI, probe, NOW);
	assert.match(why, /last pushed 2026-01-05/);
	assert.match(why, /180-day window/);
});

test('a thin repo names the workflow floor', () => {
	const { probe } = probes({ workflows: 1 });
	const why = autoIncludeDrop(repo(), AI, probe, NOW);
	assert.match(why, /fewer than autoInclude's 2 workflows/);
});

test('one workflow that targets the fleet is direct evidence and overrides the proxy', () => {
	// hadoku-games-host sat exactly here for eleven consecutive nightly runs
	// (2026-08-13..23) — one workflow, targeting self-hosted, so it queued
	// forever and reported as a benign cancellation.
	const { probe } = probes({ workflows: 1, fleet: true });
	assert.equal(autoIncludeDrop(repo(), AI, probe, NOW), null);
});

// ── an unreadable date is not a recent one ──────────────────────────────────

test('a MISSING pushedAt is dropped, not read as "pushed recently"', () => {
	// `Date.parse(undefined)` is NaN and `NaN < cutoff` is false, so the original
	// comparison said "inside the window" for a field nobody could read — a repo
	// staying eligible on the strength of a failed read, in the rule that decides
	// which machines get an 835 MB runner install.
	const { probe } = probes();
	const why = autoIncludeDrop(repo({ pushedAt: undefined }), AI, probe, NOW);
	assert.match(why, /no readable pushedAt/);
	assert.match(why, /Unknown is not recent/);
});

test('a GARBAGE pushedAt is dropped too, and quotes what it saw', () => {
	const { probe } = probes();
	const why = autoIncludeDrop(repo({ pushedAt: 'soon' }), AI, probe, NOW);
	assert.match(why, /no readable pushedAt/);
	assert.match(why, /"soon"/, 'the operator needs to see the value that failed to parse');
});

test('the unreadable branch is checked BEFORE the workflow probe', () => {
	// Otherwise the cheap-then-expensive ordering is broken: a repo with an
	// unreadable date would pay for a workflow listing to reach a verdict the
	// date alone already settles.
	const { calls, probe } = probes();
	autoIncludeDrop(repo({ pushedAt: null }), AI, probe, NOW);
	assert.equal(calls.countWorkflows, 0);
});

test('a real date still parses — the guard is not swallowing valid input', () => {
	// Pinned so the fix cannot degrade into "drop everything", which would pass
	// the three tests above while emptying the roster.
	const { probe } = probes();
	assert.equal(autoIncludeDrop(repo(), AI, probe, NOW), null);
	assert.match(
		autoIncludeDrop(repo({ pushedAt: '2026-01-05T00:00:00Z' }), AI, probe, NOW),
		/last pushed 2026-01-05/
	);
});

// ── the ordering is load-bearing, not incidental ────────────────────────────

test('a fork never pays for a workflow API call', () => {
	const { calls, probe } = probes();
	autoIncludeDrop(repo({ isFork: true }), AI, probe, NOW);
	assert.equal(calls.countWorkflows, 0, 'the cheap rules must short-circuit the API calls');
	assert.equal(calls.targetsSelfHostedFleet, 0);
});

test('a repo above the workflow floor never pays for the per-file deep check', () => {
	// && short-circuits, so only a repo the proxy would DROP reads its workflows.
	const { calls, probe } = probes({ workflows: 5 });
	autoIncludeDrop(repo(), AI, probe, NOW);
	assert.equal(calls.countWorkflows, 1);
	assert.equal(calls.targetsSelfHostedFleet, 0, 'one API call per workflow file — not free');
});

// ── the window boundary ─────────────────────────────────────────────────────

test('the recency window is a real boundary, not a rounding', () => {
	const { probe } = probes();
	const justInside = new Date(NOW - 179 * 86400_000).toISOString();
	const justOutside = new Date(NOW - 181 * 86400_000).toISOString();
	assert.equal(autoIncludeDrop(repo({ pushedAt: justInside }), AI, probe, NOW), null);
	assert.match(autoIncludeDrop(repo({ pushedAt: justOutside }), AI, probe, NOW), /outside/);
});

test('`now` is injected, so the window does not drift with the wall clock', () => {
	// Pinned: a test that read Date.now() would pass today and rot silently.
	const { probe } = probes();
	const at = '2026-03-01T00:00:00Z';
	assert.equal(autoIncludeDrop(repo({ pushedAt: at }), AI, probe, Date.parse(at)), null);
	assert.match(
		autoIncludeDrop(repo({ pushedAt: at }), AI, probe, Date.parse('2027-03-01T00:00:00Z')),
		/outside/
	);
});

// ── the reconciler must actually USE it ─────────────────────────────────────

test('the reconciler routes eligibility through this one rule, and reports departures', () => {
	// Comments are not evidence — this repo has been bitten three times by a grep
	// crediting prose (handoff §2). Blank them before looking.
	const src = blankComments(
		readFileSync(new URL('../reconcile-fleet-runners.mjs', import.meta.url), 'utf8')
	);
	assert.match(src, /autoIncludeDrop\(/, 'the reconciler must call the shared rule');
	assert.doesNotMatch(
		src,
		/if \(Date\.parse\(repo\.pushedAt\) < cutoff\) continue;/,
		'the old silent `continue` is back — a departure would go unrecorded again'
	);
	// The departure must reach BOTH audiences: the exit code is the operator's
	// signal, the `departed` field is the cron's.
	assert.match(src, /departed\.length > 0/, 'departures must fail the run');
	assert.match(src, /\bdeparted,/, 'departures must be in the --json summary');
});
