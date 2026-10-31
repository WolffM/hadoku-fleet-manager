/**
 * The reminder's rule (fleet-manager#34): stale is a release date 30 days
 * behind the newest, never "behind at all", so yt-dlp's weekly releases do not
 * post weekly. Real tags and versions as hokon reported them on 2026-10-31.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STALE_DAYS, judgeTool } from './backstop-tools.mjs';

const YTDLP = {
	'2026.10.26': '2026-10-26T20:00:00Z',
	'2026.10.09': '2026-10-09T20:00:00Z',
	'2026.09.14': '2026-09-14T20:00:00Z',
	'2026.08.19': '2026-08-19T20:00:00Z',
};

test('hokon on 2026-10-31: yt-dlp 2026.08.19 is 68 days behind and stale, with the command', () => {
	const v = judgeTool('yt-dlp', { node: 'backstop-1', installed: '2026.08.19', releases: YTDLP });
	assert.equal(v.state, 'stale');
	assert.equal(v.behindDays, 68);
	assert.equal(v.latest, '2026.10.26');
	assert.match(v.why, /pip install --user --break-system-packages -U 'yt-dlp\[default\]'/);
});

test('a copy within STALE_DAYS of the newest release is current: weekly releases never post weekly', () => {
	assert.equal(
		judgeTool('yt-dlp', { node: 'backstop-1', installed: '2026.10.09', releases: YTDLP }).state,
		'current'
	);
	assert.equal(
		judgeTool('yt-dlp', { node: 'backstop-1', installed: '2026.10.26', releases: YTDLP }).state,
		'current'
	);
	assert.equal(STALE_DAYS, 30);
});

test("pip's normalized version still matches its tag", () => {
	assert.equal(
		judgeTool('yt-dlp', { node: 'backstop-1', installed: '2026.8.19', releases: YTDLP }).behindDays,
		68
	);
});

test('deno: a v-prefixed tag list, read without the prefix', () => {
	const releases = { '2.9.8': '2026-10-28T00:00:00Z', '2.9.7': '2026-10-21T00:00:00Z' };
	assert.equal(
		judgeTool('deno', { node: 'backstop-1', installed: '2.9.7', releases }).state,
		'current'
	);
});

test('older than every listed release is stale, and says so', () => {
	const v = judgeTool('yt-dlp', { node: 'backstop-1', installed: '2025.01.01', releases: YTDLP });
	assert.equal(v.state, 'stale');
	assert.equal(v.behindDays, null);
	assert.match(v.why, /older than every release in the list \(the oldest listed is 2026\.08\.19\)/);
});

test('not on the PATH is missing; unreadable releases are unknown, never current', () => {
	assert.equal(
		judgeTool('deno', { node: 'backstop-1', installed: null, releases: YTDLP }).state,
		'missing'
	);
	const u = judgeTool('deno', {
		installed: '2.9.7',
		releases: null,
		why: 'rate limited (HTTP 403)',
	});
	assert.equal(u.state, 'unknown');
	assert.match(u.why, /rate limited/);
});
