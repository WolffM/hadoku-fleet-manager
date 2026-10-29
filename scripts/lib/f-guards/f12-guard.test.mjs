/**
 * F12 (plan §4.1): one paging ledger does not exist yet, so five callers each
 * debounce their own pages against their own persisted state. Two
 * mechanically distinct signals, both already debt:
 *
 *   1. F12-repage-ms: a module-level "how long before we page the SAME
 *      condition again" constant. The plan names it `REPAGE_MS` ×3, but two
 *      more sites carry the identical 24h-ms (or, for runner-health, 1h-ms)
 *      value under a DIFFERENT name — `REPAGE_INTERVAL_MS` (ci-alerts.ts) and
 *      `RE_ALERT_MS` (runner-health.ts) — which is itself evidence of the
 *      duplication, not a reason to leave them out.
 *   2. F12-page-ledger: a file that both WRITES its state to disk and
 *      DEBOUNCES a repeat by comparing `now - <lastPagedAt> < <intervalConst>`
 *      — the actual ledger-plus-debounce shape, as opposed to a file that
 *      merely has a `writeFileSync` for unrelated reasons.
 *
 * `dispatch-tick.ts`'s `warnedStuck` book is one of the plan's five
 * page-ledger sites by citation, but it does not match signal 2: it has no
 * repage INTERVAL at all — a key is announced once, ever, until the 500-entry
 * cap evicts it. That is a genuinely different mechanism (permanent dedup,
 * not timed debounce), so it is named in the closing note rather than forced
 * into this list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tsAndMjsSources, assertDebt, loadDebt } from './lib.mjs';

// No `g` flag: every use here is a one-shot `.test()`, and a global regex's
// `lastIndex` would carry over between files and silently skip matches.
const REPAGE_CONST = /\bconst\s+(?:REPAGE(?:_INTERVAL)?_MS|RE_ALERT_MS)\s*=/;
const WRITE = /\bwriteFileSync\(/;
const DEBOUNCE = /\bnow\s*-\s*\w+\s*<\s*[\w.]*(?:MS|Ms)\b/;

function findRepageMs() {
	const out = [];
	for (const { rel, code } of tsAndMjsSources()) {
		if (REPAGE_CONST.test(code)) out.push(`${rel}:repage-constant#1`);
	}
	return out;
}

function findPageLedger() {
	const out = [];
	for (const { rel, code } of tsAndMjsSources()) {
		if (WRITE.test(code) && DEBOUNCE.test(code)) out.push(`${rel}:page-ledger#1`);
	}
	return out;
}

void test('F12: a repage/re-alert debounce constant is defined only where debt.json says so', () => {
	assertDebt(
		assert,
		loadDebt(),
		'F12-repage-ms',
		findRepageMs(),
		'Use the shared paging ledger (F12) instead of a local REPAGE_MS/REPAGE_INTERVAL_MS/' +
			'RE_ALERT_MS constant — five pagers each debouncing on their own clock is one more ' +
			'single point of failure on the alarm path than the fleet needs.'
	);
});

void test('F12: a file both persists state and debounces a repeat page only where debt.json says so', () => {
	assertDebt(
		assert,
		loadDebt(),
		'F12-page-ledger',
		findPageLedger(),
		'Migrate this pager onto the shared paging ledger (F12), one caller at a time, behind the ' +
			'off-box heartbeat decision (plan §6.2).'
	);
});

void test('F12: the guard sees the shapes it forbids', () => {
	assert.ok(REPAGE_CONST.test('const REPAGE_MS = 24 * 60 * 60_000;'));
	assert.ok(REPAGE_CONST.test('const RE_ALERT_MS = 60 * 60 * 1000;'));
	assert.ok(DEBOUNCE.test('if (now - last < cfg.repageMs) return;'));
});
