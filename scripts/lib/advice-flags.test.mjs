/**
 * A command this fleet PRINTS as advice must be a command that runs.
 *
 * `fleet enroll` closed with "run this FIRST: fleet converge-toolchain --only
 * <node> --write". There is no `--only`; the flag is `--machine`. The advice
 * was wrong from the day it was written, and it was read and typed at the one
 * moment its reader is least able to second-guess it — the first command after
 * a box is declared, when everything is unfamiliar and a refusal reads as the
 * new node being wrong rather than the instruction. It cost a rejected command
 * on claw-8 and again on claw-9 before it was fixed (#49).
 *
 * These strings are the fleet's user interface and nothing was checking them,
 * because they are prose to every tool that looks at this repo. So: find every
 * `fleet <subcommand> --<flag>` this repo prints, resolve the subcommand to the
 * script that implements it, and require that the script mentions the flag. It
 * is a weak check by design — presence, not semantics — but it is exactly
 * strong enough for the failure it exists to catch, which is a flag that does
 * not exist AT ALL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(SCRIPTS);
const CLI = readFileSync(join(ROOT, 'src/cli.ts'), 'utf8');

/** subcommand -> the .mjs the CLI table points it at. */
function implementationOf(sub) {
	// COMMANDS entries look like:  <name>: { script: 'foo.mjs', ... }
	const entry = new RegExp(
		`\\b${sub.replace(/-/g, '-')}\\s*:\\s*\\{[^}]*?script:\\s*'([^']+)'`,
		's'
	);
	return entry.exec(CLI)?.[1] ?? null;
}

function sourceFiles() {
	const out = [];
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name !== 'node_modules') walk(p);
			} else if (/\.(mjs|ts)$/.test(e.name) && !/\.test\./.test(e.name)) {
				out.push(p);
			}
		}
	};
	walk(SCRIPTS);
	walk(join(ROOT, 'src'));
	return out;
}

/**
 * The mapped script — and for a SHELL subcommand, its wrapper too.
 *
 * A subcommand's flags are normally parsed in the file the CLI names. `doctor`
 * is the exception: the CLI maps it to a shell script, and the flags are read
 * by the .mjs that spawns it. Resolving only the named file reports three of
 * doctor's flags as missing that are handled perfectly well one hop away, and
 * a guard whose findings are mostly false teaches its reader to skip it.
 *
 * The hop is limited to that case DELIBERATELY. Following imports from every
 * subcommand made this test pass while `fleet benchmark --machine` — a real
 * defect, the same one as #49 — was still in the tree, because benchmark
 * imports lib/fleet-exec.mjs and THAT mentions `--machine` for the guest gate.
 * A wider search is not a stricter test; here it was the difference between
 * catching the bug and reporting nothing at all.
 */
function implementationText(impl) {
	let head;
	try {
		head = readFileSync(join(SCRIPTS, impl), 'utf8');
	} catch {
		return null;
	}
	if (!impl.endsWith('.sh')) return head;
	let all = head;
	for (const f of readdirSync(join(SCRIPTS, 'lib'))) {
		if (/\.mjs$/.test(f) && !/\.test\./.test(f)) {
			all += readFileSync(join(SCRIPTS, 'lib', f), 'utf8');
		}
	}
	return all;
}

/** Comment lines are prose ABOUT commands, including ones that no longer exist. */
function stripComments(src) {
	return src
		.split('\n')
		.map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
		.join('\n');
}

test('every `fleet <sub> --flag` this repo prints names a flag that subcommand has', () => {
	const bad = [];
	// `fleet foo --bar`, with the flag directly after the subcommand or after
	// one interpolated argument, which is how these strings are written.
	const advice = /fleet ([a-z][a-z-]+)((?:\s+(?:--[a-z][a-z-]*|\$\{[^}]+\}|<[^>]+>))+)/g;
	for (const file of sourceFiles()) {
		const src = stripComments(readFileSync(file, 'utf8'));
		for (const m of src.matchAll(advice)) {
			const [, sub, tail] = m;
			const impl = implementationOf(sub);
			if (!impl) continue; // not a real subcommand, or the CLI shape changed
			const target = implementationText(impl);
			if (target === null) continue;
			for (const flag of tail.match(/--[a-z][a-z-]*/g) ?? []) {
				if (!target.includes(flag)) {
					bad.push(
						`${file.slice(ROOT.length + 1)}: \`fleet ${sub} ${flag}\` — ${impl} has no ${flag}`
					);
				}
			}
		}
	}
	assert.deepEqual(bad, [], `advice naming a flag that does not exist:\n  ${bad.join('\n  ')}`);
});
