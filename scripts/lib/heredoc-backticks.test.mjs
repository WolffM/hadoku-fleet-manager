/**
 * No backticks in any unquoted heredoc that writes a generated artifact.
 *
 * These heredocs interpolate variables, so they cannot be quoted, which makes
 * every backtick command substitution — executed as root, since these run under
 * sudo. Twice today that turned prose into an executed command:
 *
 *   make-preseed.sh   12 backticks in comments, silently eaten from the output
 *   node-usb-prep.sh  `logger -t fleet` in the README, which reads stdin with
 *                     no message argument and hung an install indefinitely,
 *                     with no output and no disk activity to show why
 *
 * The first got a test and the second did not, so the rule lived in one file
 * and the mistake moved to the other. This covers every file that writes one.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILES = ['../node-usb-prep.sh', '../onboarding.sh', './make-preseed.sh', '../net-survey.sh'];

/** Body of every `<<DELIM` heredoc whose delimiter is NOT quoted. */
function unquotedHeredocs(src) {
	const out = [];
	const lines = src.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/<<-?([A-Za-z_][A-Za-z0-9_]*)\s*$/);
		if (!m) continue; // a quoted delimiter (<<'EOF') does not match: no $ or ` expansion
		const delim = m[1];
		const body = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].trim() === delim) break;
			body.push(lines[j]);
		}
		out.push({ line: i + 1, delim, body: body.join('\n') });
	}
	return out;
}

for (const rel of FILES) {
	test(`${rel} has no backtick in an unquoted heredoc`, () => {
		const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
		const bad = unquotedHeredocs(src)
			.filter((h) => h.body.includes('`'))
			.map((h) => `line ${h.line} (<<${h.delim})`);
		assert.deepEqual(
			bad,
			[],
			`backticks inside an unquoted heredoc are command substitution, run as root:\n  ` +
				`${bad.join('\n  ')}\nUse single quotes in prose.`
		);
	});
}
