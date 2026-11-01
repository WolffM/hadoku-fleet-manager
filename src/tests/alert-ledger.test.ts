/**
 * `src/lib/alert-ledger.ts` — the alert-suppression ledger's own persistence
 * (F3, wave clean-1 lane A). No test covered `saveAlertLedger`'s write before
 * this: every suite that exercises `alertOnce` fakes a disk-touching finding
 * through `runner-health.ts` instead, which proves the DEBOUNCE, not the
 * write-then-rename this file now goes through (`writeJsonAtomic`).
 *
 * Runs against the global test host's own `stateDir` (install-test-host.ts) —
 * a throwaway temp directory, never the operator's real `~/.hadoku-mgmt`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../host.js';
import { alertOnce, clearAlert, __resetAlertLedgerForTesting } from '../lib/alert-ledger.js';

const LEDGER_PATH = () => join(stateDir(), 'runner-health-alerts.json');

test('alertOnce persists the ledger through the shared atomic writer, byte-for-byte as before (JSON.stringify, no spacing)', async () => {
	__resetAlertLedgerForTesting();
	try {
		rmSync(LEDGER_PATH(), { force: true });
		await alertOnce('clean-a-test-key', 'test content');
		const raw = readFileSync(LEDGER_PATH(), 'utf8');
		// No indentation — matches the old `JSON.stringify(out)` with no `space` arg.
		assert.doesNotMatch(raw, /\n/, 'single-line JSON, same as the old writeFileSync call');
		const doc = JSON.parse(raw) as Record<string, string>;
		assert.equal(typeof doc['clean-a-test-key'], 'string');
		assert.ok(!Number.isNaN(Date.parse(doc['clean-a-test-key'])));
	} finally {
		rmSync(LEDGER_PATH(), { force: true });
		__resetAlertLedgerForTesting();
	}
});

test('clearAlert re-persists the ledger with the key removed', async () => {
	__resetAlertLedgerForTesting();
	try {
		rmSync(LEDGER_PATH(), { force: true });
		await alertOnce('clean-a-test-key-2', 'test content');
		assert.ok(JSON.parse(readFileSync(LEDGER_PATH(), 'utf8'))['clean-a-test-key-2']);
		clearAlert('clean-a-test-key-2');
		const doc = JSON.parse(readFileSync(LEDGER_PATH(), 'utf8')) as Record<string, string>;
		assert.equal(doc['clean-a-test-key-2'], undefined);
	} finally {
		rmSync(LEDGER_PATH(), { force: true });
		__resetAlertLedgerForTesting();
	}
});

test('a write failure is logged and ignored, never thrown — fail-soft in both directions (AGENTS.md)', async () => {
	__resetAlertLedgerForTesting();
	// Force the rename-over-target step to fail: a DIRECTORY sits where the
	// ledger file should land, so `writeFileAtomic`'s rename onto it throws
	// (ENOTDIR/EISDIR), exactly the kind of real write failure `saveAlertLedger`
	// must swallow.
	rmSync(LEDGER_PATH(), { recursive: true, force: true });
	mkdirSync(LEDGER_PATH(), { recursive: true });
	try {
		await assert.doesNotReject(() => alertOnce('clean-a-test-key-3', 'test content'));
	} finally {
		rmSync(LEDGER_PATH(), { recursive: true, force: true });
		__resetAlertLedgerForTesting();
	}
});
