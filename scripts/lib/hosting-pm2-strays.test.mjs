/**
 * A pm2 tenant's app under another user's pm2 (fleet-manager#43). The
 * observations are STRAY_OBSERVE_SCRIPT's output as claw-4 and claw-6 printed
 * it on 2026-11-01, before and after the operator removed the strays.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeStrays, parseStrayObservation, tenantPm2Names } from './hosting-pm2-strays.mjs';

const spec = (app) => ({ app, user: `${app}-svc`, home: `/var/lib/${app}-svc` });
const SPECS = [spec('archivebot'), spec('pygmalion'), spec('watchparty')];

const lines = (...l) => [...l, 'STRAYS-END', ''].join('\n');

/** claw-4 on 2026-11-01 before the cleanup: the admin's pm2 still ran and saved pygmalion. */
const CLAW4_BEFORE = lines(
	'DAEMON\tarchivebot-svc\t/var/lib/archivebot-svc/.pm2',
	'RUN\t/var/lib/archivebot-svc/.pm2\tarchive-bot',
	'DAEMON\tpygmalion-svc\t/var/lib/pygmalion-svc/.pm2',
	'RUN\t/var/lib/pygmalion-svc/.pm2\tpygmalion',
	'DAEMON\thadoku\t/home/hadoku/.pm2',
	'RUN\t/home/hadoku/.pm2\tpygmalion',
	'DAEMON\thadoku-ci\t/home/hadoku-ci/.pm2',
	'SAVED\t/home/hadoku/.pm2\tpygmalion',
	'SAVED\t/var/lib/archivebot-svc/.pm2\tarchive-bot',
	'SAVED\t/var/lib/pygmalion-svc/.pm2\tpygmalion'
);
/** claw-6 before: it held no pygmalion slice, so no per-slice check ever ran there. */
const CLAW6_BEFORE = lines(
	'DAEMON\twatchparty-svc\t/var/lib/watchparty-svc/.pm2',
	'RUN\t/var/lib/watchparty-svc/.pm2\twatchparty',
	'DAEMON\thadoku\t/home/hadoku/.pm2',
	'RUN\t/home/hadoku/.pm2\tpygmalion',
	'SAVED\t/home/hadoku/.pm2\tpygmalion',
	'SAVED\t/var/lib/watchparty-svc/.pm2\twatchparty'
);
const CLAW4_AFTER = lines(
	'DAEMON\tarchivebot-svc\t/var/lib/archivebot-svc/.pm2',
	'RUN\t/var/lib/archivebot-svc/.pm2\tarchive-bot',
	'DAEMON\tpygmalion-svc\t/var/lib/pygmalion-svc/.pm2',
	'RUN\t/var/lib/pygmalion-svc/.pm2\tpygmalion',
	'DAEMON\thadoku\t/home/hadoku/.pm2',
	'SAVED\t/var/lib/archivebot-svc/.pm2\tarchive-bot',
	'SAVED\t/var/lib/pygmalion-svc/.pm2\tpygmalion'
);

void test('the 11-01 incident: pygmalion under the admin pm2 is a stray on claw-4 AND on claw-6', () => {
	const { strays, unreadable } = judgeStrays(SPECS, {
		'claw-4': parseStrayObservation(CLAW4_BEFORE),
		'claw-6': parseStrayObservation(CLAW6_BEFORE),
	});
	assert.deepEqual(unreadable, []);
	assert.deepEqual(
		strays.map((s) => [s.node, s.tenant, s.name, s.owner, s.where]),
		[
			['claw-4', 'pygmalion', 'pygmalion', 'hadoku', 'running and saved'],
			['claw-6', 'pygmalion', 'pygmalion', 'hadoku', 'running and saved'],
		]
	);
	assert.match(strays[0].why, /pm2 delete pygmalion && pm2 save --force/);
});

void test("the tenant's own daemon is never a stray, and the cleaned-up node reads clean", () => {
	const { strays, unreadable } = judgeStrays(SPECS, {
		'claw-4': parseStrayObservation(CLAW4_AFTER),
	});
	assert.deepEqual(strays, []);
	assert.deepEqual(unreadable, []);
});

void test("a tenant's pm2 name is learned from its own dump: archivebot runs as archive-bot", () => {
	const names = tenantPm2Names(SPECS, { 'claw-4': parseStrayObservation(CLAW4_AFTER) });
	assert.deepEqual([...names.get('archivebot')].sort(), ['archive-bot', 'archivebot']);
	const { strays } = judgeStrays(SPECS, {
		'claw-4': parseStrayObservation(CLAW4_AFTER),
		'claw-1': parseStrayObservation(lines('SAVED\t/home/hadoku/.pm2\tarchive-bot')),
	});
	assert.deepEqual(
		strays.map((s) => [s.node, s.tenant, s.name, s.where]),
		[['claw-1', 'archivebot', 'archive-bot', 'saved']]
	);
	assert.match(strays[0].why, /a reboot brings it back/);
});

void test('a saved-only stray is still a stray: the reboot is what resurrected the 11-01 pair', () => {
	const { strays } = judgeStrays(SPECS, {
		'claw-6': parseStrayObservation(lines('SAVED\t/home/hadoku/.pm2\tpygmalion')),
	});
	assert.deepEqual(
		strays.map((s) => [s.node, s.where, s.owner]),
		[['claw-6', 'saved', null]]
	);
});

void test('a node that did not answer, or a listing cut short, is unreadable, never clean', () => {
	assert.equal(parseStrayObservation('DAEMON\thadoku\t/home/hadoku/.pm2\n'), null);
	const { strays, unreadable } = judgeStrays(SPECS, { 'claw-2': null });
	assert.deepEqual(strays, []);
	assert.deepEqual(unreadable, [{ node: 'claw-2', why: 'the pm2 sweep did not run to its end' }]);
});

void test("without sudo, another user's daemon is named unread, while admin's own is still judged", () => {
	const obs = parseStrayObservation(
		lines(
			'DAEMON\thadoku\t/home/hadoku/.pm2',
			'RUN\t/home/hadoku/.pm2\tpygmalion',
			'DAEMON-UNREAD\thadoku-ci\t/home/hadoku-ci/.pm2'
		)
	);
	assert.match(obs.unreadable, /no sudo -n, so hadoku-ci's \(\/home\/hadoku-ci\/\.pm2\) pm2/);
	const { strays, unreadable } = judgeStrays(SPECS, { hokon: obs });
	assert.deepEqual(
		strays.map((s) => [s.node, s.tenant, s.where]),
		[['hokon', 'pygmalion', 'running']]
	);
	assert.equal(unreadable.length, 1);
});

void test('an unparseable dump is unreadable beside whatever else the node showed', () => {
	const obs = parseStrayObservation(
		lines('DAEMON\thadoku\t/home/hadoku/.pm2', 'SAVED-UNREADABLE\t/var/lib/pygmalion-svc/.pm2')
	);
	assert.match(
		obs.unreadable,
		/could not parse the saved dump under \/var\/lib\/pygmalion-svc\/\.pm2/
	);
});
