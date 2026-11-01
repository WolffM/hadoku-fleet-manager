import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	QUIET_MS,
	WINDOW_MS,
	checkState,
	commitVerdict,
	decide,
	revertMessage,
	sessions,
	trailer,
} from './decide.mjs';

const NOW = Date.now();
const MIN = 60_000;

let n = 0;
/** A chain entry. `verdict` is what commitVerdict would have said. */
const c = (verdict, extra = {}) => {
	n++;
	return {
		sha: `${String(n).padStart(2, '0')}${'a'.repeat(38)}`,
		parents: ['p'],
		message: `commit ${n}\n\nSession: s${n}\n`,
		verdict,
		...extra,
	};
};

/** Facts with the cadence satisfied unless overridden. Chain is NEWEST first. */
const facts = (chain, over = {}) => ({
	chain,
	mainAhead: 0,
	force: false,
	nowMs: NOW,
	lastMainPushMs: NOW - 31 * MIN,
	lastPpePushMs: NOW - 1 * MIN,
	...over,
});

test('checkState: check runs and commit statuses', () => {
	assert.equal(checkState({ status: 'completed', conclusion: 'success' }), 'success');
	assert.equal(checkState({ status: 'completed', conclusion: 'skipped' }), 'success');
	assert.equal(checkState({ status: 'completed', conclusion: 'failure' }), 'failure');
	assert.equal(checkState({ status: 'completed', conclusion: 'timed_out' }), 'failure');
	assert.equal(checkState({ status: 'in_progress', conclusion: null }), 'pending');
	assert.equal(checkState({ status: 'queued', conclusion: null }), 'pending');
	// Superseded is not a verdict on the code.
	assert.equal(checkState({ status: 'completed', conclusion: 'cancelled' }), 'missing');
	assert.equal(checkState({ state: 'success' }), 'success');
	assert.equal(checkState({ state: 'error' }), 'failure');
	assert.equal(checkState({ state: 'pending' }), 'pending');
	assert.equal(checkState(undefined), 'missing');
});

test('commitVerdict: every required context must pass', () => {
	const req = ['check', 'e2e'];
	assert.equal(commitVerdict({ check: 'success', e2e: 'success' }, req), 'green');
	assert.equal(commitVerdict({ check: 'success', e2e: 'failure' }, req), 'red');
	assert.equal(commitVerdict({ check: 'success' }, req), 'pending');
	assert.equal(commitVerdict({ check: 'pending', e2e: 'success' }, req), 'pending');
	assert.equal(commitVerdict({}, req), 'untested');
	// A non-required check never counts, either way.
	assert.equal(commitVerdict({ check: 'success', e2e: 'success', lint: 'failure' }, req), 'green');
});

test('trailer: the last matching line wins, and absence is null', () => {
	assert.equal(trailer('x\n\nSession: a\nSession: b\n', 'Session'), 'b');
	assert.equal(trailer('x\n\nsession:  lane-3 \n', 'Session'), 'lane-3');
	assert.equal(trailer('no trailer here', 'Session'), null);
});

test('promotes the NEWEST green, not the tip, when the tip is still pending', () => {
	const g = c('green');
	const d = decide(facts([c('pending'), c('untested'), g]));
	assert.equal(d.promote.sha, g.sha);
	assert.equal(d.revert, null);
});

test('nothing green above main: no promotion', () => {
	const d = decide(facts([c('pending'), c('untested')]));
	assert.equal(d.promote, null);
	assert.match(d.notes.join(), /no green/);
});

test('cadence: the 30-minute window, the 10-minute quiet, and force', () => {
	const chain = () => [c('green')];
	// main moved 5 min ago, ppe pushed 2 min ago: wait.
	const wait = decide(
		facts(chain(), { lastMainPushMs: NOW - 5 * MIN, lastPpePushMs: NOW - 2 * MIN })
	);
	assert.equal(wait.promote, null);
	assert.match(wait.notes.join(), /not yet quiet/);
	// The window elapsed.
	assert.ok(
		decide(facts(chain(), { lastMainPushMs: NOW - WINDOW_MS, lastPpePushMs: NOW })).promote
	);
	// ppe went quiet first.
	const quiet = decide(
		facts(chain(), { lastMainPushMs: NOW - 5 * MIN, lastPpePushMs: NOW - QUIET_MS })
	);
	assert.match(quiet.promote.reason, /quiet/);
	// Forced, inside both.
	const forced = decide(facts(chain(), { force: true, lastMainPushMs: NOW, lastPpePushMs: NOW }));
	assert.equal(forced.promote.reason, 'forced');
	// main untouched inside the activity window: long ago.
	assert.ok(decide(facts(chain(), { lastMainPushMs: null, lastPpePushMs: NOW })).promote);
});

test('main ahead of ppe (an unsynced bot push): no fast-forward is possible, so none is tried', () => {
	const d = decide(facts([c('green')], { mainAhead: 2 }));
	assert.equal(d.promote, null);
	assert.match(d.notes.join(), /sync-main-to-ppe/);
});

test('a red push is reverted whole: its tip back to the previous tested commit', () => {
	// oldest -> newest: G, u1, u2, R(red), u3, T(pending)   (chain is newest first)
	const g = c('green');
	const u1 = c('untested');
	const u2 = c('untested');
	const r = c('red', { failing: ['check'] });
	const u3 = c('untested');
	const t = c('pending');
	const d = decide(facts([t, u3, r, u2, u1, g]));
	assert.equal(d.revert.culprit, r.sha);
	assert.deepEqual(
		d.revert.commits.map((e) => e.sha),
		[r.sha, u2.sha, u1.sha]
	);
	// The green below the red still promotes.
	assert.equal(d.promote.sha, g.sha);
});

test('the range stops at a pending push below the red one: that is another push', () => {
	const g = c('green');
	const p = c('pending');
	const u = c('untested');
	const r = c('red');
	const d = decide(facts([r, u, p, g]));
	assert.deepEqual(
		d.revert.commits.map((e) => e.sha),
		[r.sha, u.sha]
	);
});

test('the FIRST red since the last green is the culprit; later reds are not judged yet', () => {
	const g = c('green');
	const r1 = c('red');
	const r2 = c('red');
	const d = decide(facts([r2, r1, g]));
	assert.equal(d.revert.culprit, r1.sha);
	assert.deepEqual(
		d.revert.commits.map((e) => e.sha),
		[r1.sha]
	);
});

test('a red below the newest green was fixed forward: nothing is reverted', () => {
	// The walk stops at the newest green, so an older red only reaches decide()
	// when a caller hands it the whole chain. It must be ignored either way.
	const g = c('green');
	const d = decide(facts([c('pending'), g, c('red'), c('green')]));
	assert.equal(d.revert, null);
	assert.equal(d.promote.sha, g.sha);
});

test('no green at all: the range runs down to main', () => {
	const u = c('untested');
	const r = c('red');
	const d = decide(facts([c('pending'), r, u]));
	assert.deepEqual(
		d.revert.commits.map((e) => e.sha),
		[r.sha, u.sha]
	);
	assert.equal(d.promote, null);
});

test('a red already reverted is not reverted twice; the scan resumes at the revert', () => {
	const g = c('green');
	const r = c('red');
	const inherited = c('red');
	const v = c('pending', {
		message: `Revert ppe push\n\nReverts-Push: ${r.sha}\nSession: ppe-promoter\n`,
	});
	const d = decide(facts([v, inherited, r, g]));
	assert.equal(d.revert, null);
	assert.equal(d.human, null);
});

test('a NEW red after a handled revert is the next culprit', () => {
	const g = c('green');
	const r = c('red');
	const v = c('pending', { message: `Revert\n\nReverts-Push: ${r.sha}\n` });
	const r2 = c('red');
	const d = decide(facts([r2, v, r, g]));
	assert.equal(d.revert.culprit, r2.sha);
	assert.deepEqual(
		d.revert.commits.map((e) => e.sha),
		[r2.sha]
	);
});

test("the promoter's own red revert goes to a human, never reverted", () => {
	const g = c('green');
	const r = c('red');
	const v = c('red', { message: `Revert\n\nReverts-Push: ${r.sha}\n` });
	const d = decide(facts([v, r, g]));
	assert.equal(d.revert, null);
	assert.equal(d.human.sha, v.sha);
});

test('a red push holding a merge (a main->ppe sync) goes to a human', () => {
	const g = c('green');
	const m = c('untested', { parents: ['a', 'b'], message: 'Merge main into ppe\n' });
	const r = c('red');
	const d = decide(facts([r, m, g]));
	assert.equal(d.revert, null);
	assert.match(d.human.reason, /merge/);
});

test('revertMessage names every commit and its session, and carries the trailer', () => {
	const r = c('red', { failing: ['check'] });
	const u = c('untested', { message: 'no trailer\n' });
	const msg = revertMessage({ culprit: r.sha, commits: [r, u], failing: ['check'] });
	assert.match(msg, /^Revert ppe push \w{7}: check red\n/);
	assert.match(msg, new RegExp(`Session: s${n - 1}\\)`));
	assert.match(msg, /\(Session: none\)/);
	assert.equal(trailer(msg, 'Reverts-Push'), r.sha);
	assert.equal(trailer(msg, 'Session'), 'ppe-promoter');
	assert.deepEqual(sessions({ commits: [r, u] }), [`s${n - 1}`]);
});
