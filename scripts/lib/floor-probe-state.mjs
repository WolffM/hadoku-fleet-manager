import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PROBE_LEDGER_FILE } from '../../dist/job-history-probe-ledger.js';
import { stateDir } from '../../dist/lib/fleet-paths.js';

/** The harness's own ledger. Append-only; job-history reads it and never writes it. */
export function loadLedger() {
	const ledgerPath = join(stateDir(), PROBE_LEDGER_FILE);
	if (!existsSync(ledgerPath)) return [];
	const out = [];
	for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// one bad line, not a bad file
		}
	}
	return out;
}

export function appendLedger(entry) {
	const ledgerPath = join(stateDir(), PROBE_LEDGER_FILE);
	mkdirSync(dirname(ledgerPath), { recursive: true });
	appendFileSync(ledgerPath, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
}
