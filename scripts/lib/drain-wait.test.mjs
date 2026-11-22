/**
 * drain-wait's active-work count: CI jobs plus live sessions (operator,
 * 2026-11-19), with a session's hold capped at 24 h (operator, 2026-11-21).
 * Nothing here reaches a node: the readers are injected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
	SESSION_CAP_SEC,
	SESSION_SCRIPT,
	busyCount,
	parseSessions,
	sessionCount,
} from './drain-wait.mjs';

test('the cap is 24 h', () => {
	assert.equal(SESSION_CAP_SEC, 86_400);
});

test('SESSION_SCRIPT counts claude processes under the cap as live and older ones as past it', () => {
	// The awk half, EXECUTED against a ps listing: comm, then elapsed seconds.
	const awk = SESSION_SCRIPT.slice(SESSION_SCRIPT.indexOf('| ') + 2).trim();
	const ps = [
		'systemd 9000',
		'claude 120',
		'claude 86399',
		'claude 86400',
		'claude-helper 10',
		'bash 50',
		'',
	].join('\n');
	const out = execFileSync('sh', ['-c', awk], { input: ps, encoding: 'utf8' });
	assert.deepEqual(parseSessions(out), { live: 2, pastCap: 1 });
	const none = execFileSync('sh', ['-c', awk], { input: 'bash 5\n', encoding: 'utf8' });
	assert.deepEqual(parseSessions(none), { live: 0, pastCap: 0 });
});

test('parseSessions: a missing line is could-not-look', () => {
	assert.equal(parseSessions(''), null);
	assert.equal(parseSessions('ps: not found\n'), null);
});

test('sessionCount: no users.dev reads nothing; a failed or cut-off read is null; it reads AS DEV', () => {
	let asked = 0;
	const run = () => {
		asked++;
		return { ok: true, out: 'SESSIONS 1 0\n' };
	};
	assert.deepEqual(sessionCount('claw-x', { hosts: () => false, run }), { live: 0, pastCap: 0 });
	assert.equal(asked, 0, 'read a node that hosts no sessions');

	let role;
	const seen = sessionCount('claw-x', {
		hosts: () => true,
		run: (_n, _s, o) => {
			role = o.as;
			return { ok: true, out: 'SESSIONS 1 0\n' };
		},
	});
	assert.deepEqual(seen, { live: 1, pastCap: 0 });
	assert.equal(role, 'dev');
	assert.equal(
		sessionCount('claw-x', { hosts: () => true, run: () => ({ ok: false, out: '' }) }),
		null
	);
	assert.equal(
		sessionCount('claw-x', { hosts: () => true, run: () => ({ ok: true, out: '' }) }),
		null
	);
});

test('busyCount is jobs plus live sessions; either unreadable is busy (null); past-cap is not counted', () => {
	const jobs = (n) => () => n;
	const sessions = (s) => () => s;
	assert.equal(busyCount('n', { jobs: jobs(3), sessions: sessions({ live: 1, pastCap: 0 }) }), 4);
	assert.equal(busyCount('n', { jobs: jobs(0), sessions: sessions({ live: 0, pastCap: 5 }) }), 0);
	assert.equal(
		busyCount('n', { jobs: jobs(null), sessions: sessions({ live: 0, pastCap: 0 }) }),
		null
	);
	assert.equal(busyCount('n', { jobs: jobs(0), sessions: sessions(null) }), null);
});
