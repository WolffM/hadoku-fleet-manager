/**
 * Inline gate waivers: an exemption that lives NEXT TO the code it exempts, in
 * the repo that code ships in (fleet-manager#82).
 *
 * WHY. The fleet gates (`fleet identity-model --fleet`, `fleet tier-fleet`)
 * read their exemptions from one central allowlist in the site repo, but most of
 * what it exempts is code in OTHER repos. A child that fixed, moved or deleted
 * the code left the central entry pointing at nothing, and the gate went red on
 * a stale entry. A fix turned the board red. A template's exempted code copied
 * into a new child landed at a path no entry named. `ci:identity-model` was red
 * on 21 of 63 nightly runs (09-10 to 11-11), and 17 of those were child
 * violations or stale entries.
 *
 * A waiver in a comment moves, disappears and gets copied WITH the code, so
 * none of that can happen. The shape is the site's `check-icons-disable-
 * next-line`:
 *
 *     <gate>-disable-next-line <rule>: <why>
 *
 * in ANY comment syntax (`//`, `#`, `--`, `/* *\/`), because the gates read
 * TypeScript, Python and SQL alike. It covers every finding of `<rule>` on the
 * next CODE line: blank lines and comment-only lines between are skipped, so a
 * reason can run over several comment lines.
 *
 * WHAT FAILS, in the scanned repo's own scan:
 *   - a waiver with no reason: a bare waiver is how a gate quietly stops gating;
 *   - a waiver that absorbed nothing: the code was fixed, or moved off the line;
 *   - a waiver on a NON-WAIVABLE rule: the site's central list names the
 *     rules no repo may exempt itself from.
 * None of the three suppresses anything, so the finding it aimed at still
 * reports too.
 *
 * A token after the marker that is not one of the gate's rules is not a waiver
 * at all. That fails closed: a typo'd rule leaves its finding live. It also
 * keeps prose that DESCRIBES the syntax (`<rule>`, as above) from being read as
 * a waiver that absorbed nothing.
 *
 * Pure text, no imports: both gates and their tests share it.
 */

/** A line that is only a comment, in any syntax the gates read. */
const COMMENT_ONLY = /^\s*(\/\/|#|--|\/\*|\*|<!--)/;

/**
 * Every waiver for `gate` in `text`.
 *
 * @param {string} text the file's RAW text (comments intact: that is where waivers are)
 * @param {string} gate e.g. `identity-model`
 * @param {ReadonlySet<string>} rules the gate's rule ids
 * @returns {{ rule: string, why: string, markerLine: number, target: number | null }[]}
 *   lines are 1-based; `target` is null when no code line follows
 */
export function parseWaivers(text, gate, rules) {
	if (!text.includes(`${gate}-disable-next-line`)) return [];
	const marker = new RegExp(
		`${gate}-disable-next-line\\s+([A-Za-z0-9-]+)(?:[ \\t]*:[ \\t]*(.*?))?[ \\t]*(?:\\*\\/|-->)?[ \\t]*$`
	);
	const lines = text.split('\n');
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const m = marker.exec(lines[i]);
		if (!m || !rules.has(m[1])) continue;
		let target = null;
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].trim() === '' || COMMENT_ONLY.test(lines[j])) continue;
			target = j + 1;
			break;
		}
		out.push({ rule: m[1], why: (m[2] ?? '').trim(), markerLine: i + 1, target });
	}
	return out;
}

/**
 * The waivers of one scan: register each file's text, ask whether a finding is
 * waived, then collect what is wrong with the waivers themselves.
 *
 * @param {{ gate: string, rules: Iterable<string>, nonWaivable?: Iterable<string> }} opts
 */
export function createWaiverLedger({ gate, rules, nonWaivable = [] }) {
	const known = new Set(rules);
	const locked = new Set(nonWaivable);
	/** file -> its waivers, each with `used` */
	const byFile = new Map();
	let absorbed = 0;
	const valid = (w) => w.why && !locked.has(w.rule) && w.target !== null;
	return {
		/** Register `file`'s waivers. Call once per scanned file, before its findings. */
		addFile(file, text) {
			const found = parseWaivers(text, gate, known);
			if (found.length)
				byFile.set(
					file,
					found.map((w) => ({ ...w, used: false }))
				);
		},
		/** True, and the waiver marked used, when a valid waiver covers this finding. */
		absorbs(file, rule, line) {
			const w = byFile.get(file)?.find((x) => x.rule === rule && x.target === line && valid(x));
			if (!w) return false;
			w.used = true;
			absorbed++;
			return true;
		},
		/** How many findings a waiver absorbed. */
		get absorbed() {
			return absorbed;
		},
		/**
		 * What is wrong with the waivers, as findings at the MARKER's line. Call
		 * after every finding of the scan has been offered to `absorbs`.
		 *
		 * @returns {{ file: string, line: number, rule: string, problem: string, message: string }[]}
		 */
		problems() {
			const out = [];
			for (const [file, ws] of byFile) {
				for (const w of ws) {
					const at = { file, line: w.markerLine, rule: w.rule };
					if (!w.why) {
						out.push({
							...at,
							problem: 'no reason',
							message: `waiver for ${w.rule} gives no reason; write \`${gate}-disable-next-line ${w.rule}: <why>\``,
						});
					} else if (locked.has(w.rule)) {
						out.push({
							...at,
							problem: 'non-waivable',
							message: `${w.rule} is non-waivable (the central list): fix the code; only that list can exempt it`,
						});
					} else if (w.target === null) {
						out.push({
							...at,
							problem: 'no target',
							message: `waiver for ${w.rule} has no code line after it`,
						});
					} else if (!w.used) {
						out.push({
							...at,
							problem: 'unused',
							message: `waiver for ${w.rule} covers line ${w.target}, which has no ${w.rule} finding: remove it`,
						});
					}
				}
			}
			return out;
		},
	};
}

/** The comment opener for `file`'s language, for a printed waiver. */
export function commentFor(file) {
	if (/\.(py|sh|toml|ya?ml)$/.test(file)) return '#';
	if (file.endsWith('.sql')) return '--';
	return '//';
}

/**
 * The waiver to insert above a finding, the migration's output: the marker line,
 * then the rest of `why` as comment lines wrapped at `width`. Only the marker
 * line's reason is parsed; the continuation is for the reader, and the target
 * skips comment lines, so the waiver still covers the code below it.
 *
 * @param {string} gate @param {string} rule @param {string} why @param {string} file
 * @param {number} [width]
 * @returns {string[]}
 */
export function waiverText(gate, rule, why, file, width = 100) {
	const c = commentFor(file);
	const words = why.replace(/\s+/g, ' ').trim().split(' ');
	const lines = [];
	let cur = `${c} ${gate}-disable-next-line ${rule}:`;
	for (const w of words) {
		// The marker line keeps at least one word of reason, however long it gets.
		const markerBare = lines.length === 0 && cur.endsWith(':');
		if (cur.length + 1 + w.length > width && !markerBare) {
			lines.push(cur);
			cur = `${c} ${w}`;
		} else cur += ` ${w}`;
	}
	lines.push(cur);
	return lines;
}
