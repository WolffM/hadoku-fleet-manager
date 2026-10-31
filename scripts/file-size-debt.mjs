#!/usr/bin/env node
/**
 * Regenerate `scripts/lib/file-size-debt.json` from the tree as it is.
 *
 * Default (`--write`, no flags): ratchets every existing entry DOWN to its
 * file's current size, drops any entry whose file shrank to its ceiling or
 * was deleted, and leaves alone (does not add, does not raise) anything that
 * would make the list bigger. That is the one-command case this exists for —
 * lane 5m-D shrinks `check-header-fleet.mjs` and `check-label-floor.mjs`
 * before this lane lands, and rebasing past that split needs exactly this:
 * a regen that can only make the list shorter.
 *
 * `--allow-growth <path>` (repeatable) permits raising ONE existing entry to
 * its current size, or adding a brand-new entry for a path that just crossed
 * its ceiling for the first time, and prints a warning each time it does.
 * Without `--write`, nothing is written: the command reports what it WOULD
 * do (and still exits non-zero if the result disagrees with what is on disk,
 * so it doubles as a dry-run check).
 *
 * Usage:
 *   node scripts/file-size-debt.mjs --write
 *   node scripts/file-size-debt.mjs --write --allow-growth src/runner-health.ts
 *   node scripts/file-size-debt.mjs            # dry run; prints the diff, exits 1 if one exists
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { writeFileAtomic } from '../dist/lib/atomic-json.js';
import { collectSizes, regenerate } from './lib/file-size-guard.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEBT_PATH = join(ROOT, 'scripts/lib/file-size-debt.json');

function parseArgs(argv) {
	let write = false;
	const allowGrowth = new Set();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--write') {
			write = true;
		} else if (arg === '--allow-growth') {
			const path = argv[++i];
			if (!path) {
				console.error('--allow-growth needs a path argument (or "all")');
				process.exit(2);
			}
			allowGrowth.add(path);
		} else if (arg === '-h' || arg === '--help') {
			console.log('Usage: node scripts/file-size-debt.mjs [--write] [--allow-growth <path>]...');
			process.exit(0);
		} else {
			console.error(`unrecognised argument: ${arg}`);
			process.exit(2);
		}
	}
	return { write, allowGrowth: allowGrowth.has('all') ? 'all' : allowGrowth };
}

function main() {
	const { write, allowGrowth } = parseArgs(process.argv.slice(2));

	const existingDebt = JSON.parse(readFileSync(DEBT_PATH, 'utf8'));
	const sizes = collectSizes(ROOT);
	const { debt, warnings } = regenerate(sizes, existingDebt, allowGrowth);

	for (const w of warnings) console.warn(`[file-size-debt] ${w}`);

	const nextText = JSON.stringify(debt, null, 2) + '\n';
	const currentText = JSON.stringify(existingDebt, null, 2) + '\n';
	const changed = nextText !== currentText;

	if (!write) {
		if (changed) {
			console.log('scripts/lib/file-size-debt.json is stale. Re-run with --write to update it.');
			process.exit(1);
		}
		console.log('scripts/lib/file-size-debt.json already matches the tree.');
		return;
	}

	if (!changed) {
		console.log('scripts/lib/file-size-debt.json already matches the tree. Nothing to write.');
		return;
	}
	// Write-then-rename, fsync'd (F3, `lib/atomic-json.ts`).
	writeFileAtomic(DEBT_PATH, nextText);
	console.log(`scripts/lib/file-size-debt.json rewritten: ${Object.keys(debt).length} entries.`);
}

main();
