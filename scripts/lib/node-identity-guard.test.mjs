/**
 * Nothing may re-implement the local rule.
 *
 * Behaviour tests cannot catch a SIXTH implementation appearing beside the
 * canonical one — that is exactly how five accumulated (measured 2026-08-30:
 * runner-supervision, runner-tiers (now fleet-loop), fleet-exec, check-fleet-toolchain, and
 * ephemeral-tick which had none at all). Only a structural check keeps the
 * count at one.
 *
 * It lives here, in the scripts half, for two reasons a TS test could not
 * satisfy: it must import `blankComments` (which `tsconfig.json` cannot, with
 * no `allowJs`), and it must read the SOURCE tree — a test compiled into
 * `dist/tests/` is looking at the wrong files.
 *
 * COMMENTS ARE BLANKED FIRST. Every file involved in this rule quotes the
 * broken form in its own prose, including the one you are reading. This repo
 * has been bitten three separate times by a grep that read a COMMENT as
 * evidence, so a rule about source must never be satisfiable by writing about
 * it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The one file allowed to ask `os.hostname()` what this box is called. */
const CANONICAL = 'src/lib/node-identity.ts';

/**
 * `fleet-exec.mjs` still EXPORTS the raw hostname as `LOCAL` for reporting, so
 * the declaration is permitted there — comparing against it is not, and the
 * pattern below only matches comparisons.
 */
const ALLOWED = new Set([CANONICAL]);

function sources(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry === 'dist') continue;
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) {
			sources(p, out);
			continue;
		}
		if (/\.(ts|mjs)$/.test(entry)) out.push(p);
	}
	return out;
}

void test('the local rule has exactly one implementation', () => {
	// `x === hostname()`, `hostname() === x`, or a comparison against LOCAL.
	const RAW_COMPARE = /(?:===|!==)\s*hostname\(\)|hostname\(\)\s*(?:===|!==)|(?:===|!==)\s*LOCAL\b/;

	const offenders = [];
	for (const root of ['src', 'scripts']) {
		for (const abs of sources(join(ROOT, root))) {
			const rel = relative(ROOT, abs);
			if (ALLOWED.has(rel)) continue;
			if (RAW_COMPARE.test(blankComments(readFileSync(abs, 'utf8')))) offenders.push(rel);
		}
	}

	assert.deepEqual(
		offenders,
		[],
		`these compare a node name to a hostname directly instead of calling isLocalNode():\n  ` +
			`${offenders.join('\n  ')}\n\n` +
			'That comparison is neither FQDN-safe nor case-safe, and the false-NEGATIVE ' +
			'direction reads a node as permanently unreachable while the false-POSITIVE ' +
			`direction runs another node's script locally. Import isLocalNode from ` +
			`${CANONICAL}, or in scripts/ from lib/fleet-exec.mjs which re-exports it.`
	);
});

void test('the canonical implementation still exists where the guard says it is', () => {
	// A rename that moved node-identity.ts would otherwise leave the allowlist
	// pointing at nothing and the guard passing over a repo with no rule at all.
	const src = readFileSync(join(ROOT, CANONICAL), 'utf8');
	assert.match(src, /export function isLocalNode\(/, `${CANONICAL} no longer exports isLocalNode`);
	assert.match(src, /hostname\(\)/, `${CANONICAL} no longer reads os.hostname()`);
});
