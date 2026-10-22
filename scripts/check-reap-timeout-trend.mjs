#!/usr/bin/env node
/**
 * check-reap-timeout-trend — is `reapJitRunners`'s timeout rate CLIMBING?
 *
 * See `lib/reap-trend.mjs` for why a trend rather than a fixed ceiling. This
 * file is the I/O half: find mgmt-api's own PM2 log (the box this runs on IS
 * the box mgmt-api runs on, by construction — a cron job spawns this CLI as
 * mgmt-api's own child process, same as every other entry in
 * `lib/json-contract.mjs`), read back far enough to compare two windows, and
 * hand the parsed lines to the pure verdict.
 *
 * READS THE LOG, NOT A COUNTER, ON PURPOSE. `src/runners/ephemeral*.ts` is D2's
 * file for Wave 1 and the reap's actual removal counters live there; this gate
 * reads the same mgmt-api log line the outage was diagnosed from instead
 * (`[runner-health] GET ${path} failed: ...`, which for this endpoint contains
 * the literal substring the outage doc's own re-verification recipe grepped
 * for), so it needs no change to a file this lane may not touch.
 *
 * ROTATION-AWARE. pm2-logrotate turns this over daily (or at 10MB) and keeps
 * the last several. `MIN_COVERAGE_MS` needs ~4h of history, and the active
 * file alone is not always that old — read backward through rotated siblings,
 * oldest-first is irrelevant since every line carries its own timestamp, until
 * enough history is in hand or `MAX_LOG_FILES` is hit.
 *
 * `--json` for the cron; stdout stays parseable and the exit code carries the
 * finding, per scripts/lib/json-contract.mjs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { parseLogLines, reapTrendVerdict, MIN_COVERAGE_MS } from './lib/reap-trend.mjs';
import { createEmitter } from './lib/emit.mjs';

const JSON_OUT = process.argv.includes('--json');
const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;

/** The PM2 app whose log carries the reap's `ghGet` calls. */
const APP_NAME = process.env.REAP_TREND_APP ?? 'mgmt-api';
/** Read at most this many rotated files backward — bounds one slow night. */
const MAX_LOG_FILES = 6;

/** Every live PM2 app, or `null` if PM2 itself could not be reached. */
function pm2Apps() {
	try {
		const raw = execFileSync('pm2', ['jlist'], {
			encoding: 'utf8',
			maxBuffer: 32 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Read `outLogPath` plus as many of its pm2-logrotate siblings as it takes to
 * cover `minCoverageMs` of history, most-recently-modified first.
 *
 * `mgmt-api-out.log` (active) sits beside `mgmt-api-out__<timestamp>.log`
 * (rotated) in the same directory — pm2-logrotate's own naming, observed live
 * on this fleet. Concatenation order does not matter to the caller: every line
 * is re-sorted by its own embedded timestamp, not by file order.
 */
function readRecentLogText(outLogPath, minCoverageMs, maxFiles) {
	const dir = dirname(outLogPath);
	const base = outLogPath.slice(dir.length + 1).replace(/\.log$/, '');
	let entries;
	try {
		entries = readdirSync(dir);
	} catch (err) {
		return { text: null, error: `cannot list ${dir}: ${err.message}` };
	}
	const isSibling = (f) => f === `${base}.log` || (f.startsWith(`${base}__`) && f.endsWith('.log'));
	const candidates = entries
		.filter(isSibling)
		.map((f) => {
			const full = join(dir, f);
			try {
				return { full, mtimeMs: statSync(full).mtimeMs };
			} catch {
				return null;
			}
		})
		.filter(Boolean)
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	if (!candidates.length) {
		return { text: null, error: `no log files matching ${base}*.log under ${dir}` };
	}

	let text = '';
	let oldestMs = Date.now();
	let filesRead = 0;
	for (const { full } of candidates) {
		if (filesRead >= maxFiles) break;
		let chunk;
		try {
			chunk = readFileSync(full, 'utf8');
		} catch {
			continue;
		}
		text += chunk + '\n';
		filesRead++;
		const parsed = parseLogLines(chunk);
		if (parsed.length) oldestMs = Math.min(oldestMs, ...parsed.map((e) => e.ms));
		if (Date.now() - oldestMs >= minCoverageMs) break;
	}
	return { text, filesRead };
}

function main() {
	const apps = pm2Apps();
	if (apps === null) {
		const msg = 'check-reap-timeout-trend: could not read `pm2 jlist`. That is a broken scan.';
		if (JSON_OUT) emitter.emit({ ok: false, error: msg });
		else console.error(msg);
		process.exit(1);
	}
	const app = apps.find((a) => a.name === APP_NAME);
	const outLogPath = app?.pm2_env?.pm_out_log_path;
	if (!outLogPath) {
		const msg =
			`check-reap-timeout-trend: PM2 has no app named "${APP_NAME}" with a stdout log path — ` +
			'this must run on the box mgmt-api runs on.';
		if (JSON_OUT) emitter.emit({ ok: false, error: msg });
		else console.error(msg);
		process.exit(1);
	}

	const { text, error, filesRead } = readRecentLogText(outLogPath, MIN_COVERAGE_MS, MAX_LOG_FILES);
	if (text === null) {
		const msg = `check-reap-timeout-trend: ${error}`;
		if (JSON_OUT) emitter.emit({ ok: false, error: msg });
		else console.error(msg);
		process.exit(1);
	}

	const entries = parseLogLines(text);
	const verdict = reapTrendVerdict(entries, { nowMs: Date.now() });

	if (!verdict.ok && verdict.findings === undefined) {
		// {@link reapTrendVerdict}'s "could not look" shape — no findings array.
		if (JSON_OUT) emitter.emit({ ok: false, error: verdict.error, filesRead });
		else console.error(`✗ ${verdict.error}`);
		process.exit(1);
	}

	log(
		`Reap timeout trend from ${filesRead} log file(s): ` +
			`${verdict.recentPerHour.toFixed(0)}/hr recent vs ${verdict.baselinePerHour.toFixed(1)}/hr ` +
			`baseline (${verdict.coverageHours.toFixed(1)}h of log read)`
	);
	for (const f of verdict.findings) log(`  ✗ ${f}`);
	if (verdict.ok) log('✓ no rising trend in reap timeouts');

	if (JSON_OUT) {
		emitter.emit({
			ok: verdict.ok,
			findings: verdict.findings,
			recentPerHour: verdict.recentPerHour,
			baselinePerHour: verdict.baselinePerHour,
			coverageHours: verdict.coverageHours,
			filesRead,
		});
	} else if (verdict.findings.length) {
		console.error('');
		for (const f of verdict.findings) console.error(`✗ ${f}`);
	}

	process.exit(verdict.ok ? 0 : 1);
}

main();
