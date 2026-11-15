/**
 * One clock reader, and one copy of it.
 *
 * `CPU_CLOCK_SH` (doctor-probe.mjs) is the fleet's only reader of a CPU's
 * clock ceiling and running clock. It exists because a second reader was
 * blind where it mattered: `fleet benchmark` read cpufreq only, printed "no
 * cpufreq driver" for claw-5, and claw-5 was the node whose clock sat at a
 * third of its ceiling for two months (2026-11-14).
 *
 * `benchmark-node.sh` is shipped to a node as a file, so it cannot import the
 * string; it carries a copy between `# >>> CPU_CLOCK_SH` markers instead, and
 * the first test holds that copy byte-identical. The second fails any other
 * file under src/, scripts/, herdr/ or deploy/ that reads the clock's sources
 * itself. Comments are blanked first, so writing ABOUT a source is allowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';
import { CPU_CLOCK_SH } from './doctor-probe.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BENCHMARK = 'scripts/benchmark-node.sh';
const CANONICAL = 'scripts/lib/doctor-probe.mjs';
const BEGIN = '# >>> CPU_CLOCK_SH\n';
const END = '\n# <<< CPU_CLOCK_SH';

/** Where a CPU's clock is read from. Each one in a file means that file reads it. */
const SOURCES = /scaling_cur_freq|cpuinfo_max_freq|cpu MHz|\/dev\/cpu\//g;

const count = (text) => (text.match(SOURCES) ?? []).length;

function benchmarkBlock() {
	const text = readFileSync(join(ROOT, BENCHMARK), 'utf8');
	const i = text.indexOf(BEGIN);
	const j = text.indexOf(END);
	assert.ok(i >= 0 && j > i, `${BENCHMARK} must carry the CPU_CLOCK_SH markers`);
	return { text, block: text.slice(i + BEGIN.length, j) };
}

/** A shell file with its comment lines blanked; a JS/TS file through blankComments. */
function code(abs) {
	const text = readFileSync(abs, 'utf8');
	if (abs.endsWith('.sh')) return text.replace(/^[ \t]*#.*$/gm, '');
	return blankComments(text);
}

function files(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry === 'dist') continue;
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) files(p, out);
		else if (/\.(ts|mjs|js|sh)$/.test(entry) && !/\.test\.(ts|mjs)$/.test(entry)) out.push(p);
	}
	return out;
}

void test("benchmark-node.sh's clock reader is CPU_CLOCK_SH, byte for byte", () => {
	assert.equal(
		benchmarkBlock().block,
		CPU_CLOCK_SH,
		`the block between the CPU_CLOCK_SH markers in ${BENCHMARK} differs from ` +
			`CPU_CLOCK_SH in ${CANONICAL}. Change the export, then paste it between the markers.`
	);
});

void test('no file reads a CPU clock source outside CPU_CLOCK_SH', () => {
	const allowed = {
		[CANONICAL]: count(CPU_CLOCK_SH),
		[BENCHMARK]: count(benchmarkBlock().block),
	};
	assert.ok(allowed[CANONICAL] > 0, 'the pattern no longer matches CPU_CLOCK_SH itself');
	const offenders = [];
	for (const root of ['src', 'scripts', 'herdr', 'deploy']) {
		let all;
		try {
			all = files(join(ROOT, root));
		} catch (e) {
			if (e.code === 'ENOENT') continue;
			throw e;
		}
		for (const abs of all) {
			const rel = relative(ROOT, abs);
			const n = count(code(abs));
			if (n > (allowed[rel] ?? 0))
				offenders.push(`${rel}: ${n} read(s), ${allowed[rel] ?? 0} allowed`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		'read the clock through CPU_CLOCK_SH (scripts/lib/doctor-probe.mjs), not a reader of your own'
	);
});
