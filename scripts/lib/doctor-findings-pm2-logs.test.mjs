/**
 * Dead PM2 log streams on every daemon a node runs (hadoku-fleet-manager#143).
 *
 * CLAW4 is `pm2_logs`' output captured on claw-4 on 2026-11-24, two tenant
 * daemons and admin's idle one, every stream open. The dead cases drop the fd
 * a real ENOSPC closes, the shape hadoku_site#640 measured on hokon: God held
 * the err fd and not the out fd.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
	PM2_LOGS_SH,
	deadStreams,
	judgeReload,
	pm2LogFindings,
	pm2LogsFacet,
	pm2LogsLine,
	reloadLogsScript,
} from './doctor-findings-pm2-logs.mjs';
import { parseDoctor } from './doctor-parse.mjs';
import { doctorProbe } from './doctor-probe.mjs';
import { doctorFindings } from './doctor-findings.mjs';
import { ADVISORY } from './preflight.mjs';
import { CLAW1, facetOf } from './doctor-fixtures.mjs';

const PYG = '/var/lib/pygmalion-svc/.pm2';
const ARC = '/var/lib/archivebot-svc/.pm2';
const CLAW4 = [
	`god\t1117\tpygmalion-svc\t${PYG}`,
	`fd\t1117\t${PYG}/pm2.log`,
	`fd\t1117\t${PYG}/logs/pygmalion-out.log`,
	`fd\t1117\t${PYG}/logs/pygmalion-error.log`,
	'fd\t1117\t/proc/1163/stat',
	`app\t1117\tpygmalion\tfork_mode\t${PYG}/logs/pygmalion-out.log\t${PYG}/logs/pygmalion-error.log`,
	`god\t1118\tarchivebot-svc\t${ARC}`,
	`fd\t1118\t${ARC}/pm2.log`,
	`fd\t1118\t${ARC}/logs/archive-bot-out.log`,
	`fd\t1118\t${ARC}/logs/archive-bot-error.log`,
	`app\t1118\tarchive-bot\tfork_mode\t${ARC}/logs/archive-bot-out.log\t${ARC}/logs/archive-bot-error.log`,
	'god\t1119\thadoku\t/home/hadoku/.pm2',
	'fd\t1119\t/home/hadoku/.pm2/pm2.log',
	'end',
];
const node = 'claw-fixture';
const without = (target) => CLAW4.filter((l) => l !== target);

void test('every daemon on the node is read, and a healthy one draws nothing', () => {
	const p = pm2LogsFacet(CLAW4);
	assert.equal(p.read, true);
	assert.deepEqual(
		p.daemons.map((d) => [d.user, d.home, d.apps.length, d.missing.length]),
		[
			['pygmalion-svc', PYG, 1, 0],
			['archivebot-svc', ARC, 1, 0],
			['hadoku', '/home/hadoku/.pm2', 0, 0],
		]
	);
	assert.deepEqual(pm2LogFindings({ node, pm2Logs: p }), []);
	assert.equal(
		pm2LogsLine(p),
		`${PYG} 1 app, streams open; ${ARC} 1 app, streams open; /home/hadoku/.pm2 0 apps`
	);
});

void test('an out log God no longer holds is a dead stream: advisory, shadow, with the repair', () => {
	const p = pm2LogsFacet(without(`fd\t1117\t${PYG}/logs/pygmalion-out.log`));
	const fs = pm2LogFindings({ node, pm2Logs: p });
	assert.equal(fs.length, 1);
	const [fd] = fs;
	assert.equal(fd.category, 'pm2-log-stream');
	assert.equal(fd.status, 'dead-stream');
	assert.equal(fd.class, ADVISORY);
	assert.equal(fd.shadow, true);
	assert.equal(fd.home, PYG);
	assert.deepEqual(fd.missing, [{ app: 'pygmalion', file: `${PYG}/logs/pygmalion-out.log` }]);
	assert.match(fd.why, /--machine claw-fixture --reload-logs/);
	assert.match(pm2LogsLine(p), /pygmalion-svc\/\.pm2 1 app, 1 DEAD/);
});

void test('a log file deleted under its stream reads as dead: the fd target is "(deleted)"', () => {
	const out = `${ARC}/logs/archive-bot-out.log`;
	const lines = CLAW4.map((l) => (l === `fd\t1118\t${out}` ? `fd\t1118\t${out} (deleted)` : l));
	const [d] = pm2LogsFacet(lines).daemons.filter((x) => x.home === ARC);
	assert.deepEqual(d.missing, [{ app: 'archive-bot', file: out }]);
});

void test('discarded output and cluster workers are not God’s to hold', () => {
	const fds = new Set();
	assert.deepEqual(
		deadStreams(
			[
				{ name: 'quiet', mode: 'fork_mode', out: '/dev/null', err: '-' },
				{ name: 'workers', mode: 'cluster_mode', out: '/x/out.log', err: '/x/err.log' },
				{ name: 'merged', mode: 'fork_mode', out: '/x/all.log', err: '/x/all.log' },
			],
			fds
		),
		[{ app: 'merged', file: '/x/all.log' }]
	);
});

void test('could not look is never clean: cut-off, unread daemon, blind, not recorded', () => {
	const cut = pm2LogsFacet(CLAW4.slice(0, -1));
	assert.equal(cut.read, false);
	assert.equal(pm2LogFindings({ node, pm2Logs: cut })[0].status, 'unreadable');

	const unread = pm2LogsFacet([
		'unread\t900\twatchparty-svc\t/var/lib/watchparty-svc/.pm2\tno sudo',
		'blind\t/proc is hidepid',
		'end',
	]);
	assert.deepEqual(
		pm2LogFindings({ node, pm2Logs: unread }).map((x) => x.status),
		['blind', 'daemon-unread']
	);
	assert.match(pm2LogsLine(unread), /watchparty-svc\/\.pm2 UNREAD/);

	const old = pm2LogFindings({ node });
	assert.equal(old[0].status, 'not-recorded');
	assert.equal(old[0].class, ADVISORY);
});

void test('the probe carries the stanza, parse keeps its lines, and doctorFindings judges them', () => {
	const probe = doctorProbe({ loadSeconds: 0 });
	assert.ok(probe.includes(PM2_LOGS_SH));
	assert.match(probe, /^pm2_logs$/m);
	const parsed = parseDoctor(
		['DOCTOR-BEGIN v1', ...CLAW4.map((l) => `P ${l}`), 'DOCTOR-END claw-fixture'].join('\n')
	);
	assert.deepEqual(parsed.pm2Logs, CLAW4);

	const health = {
		...facetOf(CLAW1),
		pm2Logs: pm2LogsFacet(without(`fd\t1118\t${ARC}/logs/archive-bot-error.log`)),
	};
	const fs = doctorFindings(health).filter((x) => x.category === 'pm2-log-stream');
	assert.deepEqual(
		fs.map((x) => [x.status, x.home]),
		[['dead-stream', ARC]]
	);
});

void test('the stanza runs to its end on this box, whatever daemons it has', () => {
	const sh = ['set -u', 'SUDO="sudo -n"', 'ROOTOK=no', PM2_LOGS_SH, 'pm2_logs'].join('\n');
	const out = execFileSync('bash', ['-c', sh], { encoding: 'utf8' });
	const p = pm2LogsFacet(
		out
			.split('\n')
			.filter((l) => l.startsWith('P '))
			.map((l) => l.slice(2))
	);
	assert.equal(p.read, true);
});

void test('the repair refuses a name it would have to quote, and names the daemon it checks', () => {
	assert.throws(() => reloadLogsScript({ pid: 1, user: 'a;b', home: '/x' }), /unsafe/);
	assert.throws(() => reloadLogsScript({ pid: 1, user: 'a', home: '/x y' }), /unsafe/);
	assert.throws(() => reloadLogsScript({ pid: 0, user: 'a', home: '/x' }), /unsafe/);
	const s = reloadLogsScript({ pid: 1117, user: 'pygmalion-svc', home: PYG });
	assert.match(s, /God Daemon \(\/var\/lib\/pygmalion-svc\/\.pm2\)/);
	assert.match(s, /sudo -n -u pygmalion-svc/);
	assert.match(s, /PM2_HOME=\/var\/lib\/pygmalion-svc\/\.pm2 .*pm2 reloadLogs/);
});

void test('a reload is judged from the node read back, not from pm2’s word', () => {
	const d = { pid: 1117 };
	const after = (lines) => lines.map((l) => `after P ${l}`).join('\n');
	const said = 'RELOAD Reloading all logs...\nRELOAD All logs reloaded\n';
	assert.deepEqual(judgeReload(said + after(CLAW4), d), { ok: true, missingAfter: [] });

	const stillDead = judgeReload(
		said + after(without(`fd\t1117\t${PYG}/logs/pygmalion-out.log`)),
		d
	);
	assert.equal(stillDead.ok, false);
	assert.match(stillDead.why, /still dead/);

	const refused = judgeReload('RELOAD-REFUSED pid 1117 is no longer the pm2 daemon of x\n', d);
	assert.equal(refused.ok, false);
	assert.match(refused.why, /no longer/);

	assert.equal(judgeReload(after(CLAW4), d).ok, false, 'no "All logs reloaded", no pass');
	assert.equal(judgeReload(said, d).ok, false, 'nothing read back, no pass');
});
