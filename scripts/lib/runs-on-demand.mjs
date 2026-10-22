/**
 * What a workflow ASKS FOR, per job — the static half of `check-label-floor`'s
 * demand (#98).
 *
 * WHY THIS IS NOT A REGEX OVER THE FILE
 * -------------------------------------
 * The gate it replaces matched three `runs-on` shapes across the whole file:
 * a bracket list, the retired `vars.CI_RUNNER || '[...]'` default, and a bare
 * `fromJSON(vars.CI_RUNNER)`. Everything else contributed NOTHING and the gate
 * said nothing about it. Measured live on 2026-10-10, two routing labels were
 * invisible to the label floor that exists to watch them:
 *
 *   - hadoku-cardtable's `forge.yml` routes on
 *     `inputs.runs_on != '' && fromJSON(inputs.runs_on) ||
 *      fromJSON('["self-hosted","hadoku-builder","jdk21"]')` — `jdk21` gone.
 *   - brave-quartet's `fromJSON(format('["{0}","cargo-bevy"]', join(...)))`
 *     — `cargo-bevy` gone.
 *
 * and a comment that MENTIONED a bracket list was counted as demand, while
 * `ubuntu-24.04` was counted as a capability a node could lose.
 *
 * THE RULE INSTEAD: every JSON array literal a `runs-on` expression contains IS
 * a label set it can resolve to — it is the only thing `fromJSON` can turn into
 * a label list — after `vars.CI_RUNNER` is replaced by the value
 * `ci-runner-fallback` writes. A YAML list, a scalar, a flow sequence, a
 * `{group, labels}` mapping and a `matrix.<key>` reference are read for what
 * they are. And a `runs-on` that resolves to NO label at all is a FINDING,
 * never "this job asks for nothing": a gate whose scope silently shrinks on a
 * shape it cannot read is the dead-rule pattern #98 is about.
 *
 * Pure — no fs. `check-label-floor.mjs` does the reading.
 */
import { splitJobs, HOSTED_RE } from './demand-derive.mjs';
import { stripYamlComments } from './yaml-comments.mjs';

/** What a GitHub runner label can look like. Anything else is syntax, not a label. */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A HOSTED image is not a capability any node can earn or lose. `ubuntu-24.04`
 * was counted as one, because the old filter knew `ubuntu-latest` only.
 */
export function isHostedLabel(label) {
	return HOSTED_RE.test(label) || /^(ubuntu|macos|windows)(-|$)/.test(label);
}

function unquote(s) {
	return s
		.trim()
		.replace(/^(['"])([\s\S]*)\1$/, '$2')
		.trim();
}

/** `[a, "b", 'c']` -> labels. Nested brackets are flattened; a non-label token is dropped. */
function flowSequence(text) {
	return text
		.replace(/[[\]]/g, ',')
		.split(',')
		.map(unquote)
		.filter((t) => LABEL_RE.test(t));
}

/**
 * The value of the job's own `runs-on:` key, or null when the job has none.
 *
 * Job keys sit at FOUR spaces (job ids at two — see `splitJobs`). A block form
 * — `runs-on:` alone, then a deeper-indented YAML list, a `group`/`labels`
 * mapping, or a `>-` folded expression — keeps its lines, newline-joined, so
 * the resolver can tell a list from a mapping.
 */
export function jobRunsOn(jobText) {
	const lines = jobText.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const m = /^ {4}runs-on:[ \t]*(.*?)\s*$/.exec(lines[i]);
		if (!m) continue;
		const inline = m[1];
		if (inline && !/^[|>][+-]?$/.test(inline)) return inline;
		const block = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (!lines[j].trim()) continue;
			if (/^\s*/.exec(lines[j])[0].length <= 4) break;
			block.push(lines[j].trim());
		}
		// A folded/literal scalar is ONE value however it was wrapped.
		return inline ? block.join(' ') : block.join('\n');
	}
	return null;
}

/**
 * Every value a `matrix.<key>` can take, read off the job's own `strategy:`.
 *
 * Inline (`os: [a, b]`), block (`os:` then `- a`) and `include:` entries
 * (`- os: c`) are all read. A matrix built at run time (`fromJSON(needs...)`)
 * has no static values and yields none — which the caller turns into a
 * finding, not into "asks for nothing".
 */
function matrixValues(jobText, key) {
	const out = [];
	const lines = jobText.split('\n');
	const keyRe = new RegExp(
		`^(\\s*)(?:-\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[ \\t]*(.*?)\\s*$`
	);
	for (let i = 0; i < lines.length; i++) {
		const m = keyRe.exec(lines[i]);
		if (!m) continue;
		const [, indent, value] = m;
		if (value) {
			if (/\$\{\{/.test(value)) continue;
			out.push(...(value.startsWith('[') ? flowSequence(value) : [unquote(value)]));
			continue;
		}
		for (let j = i + 1; j < lines.length; j++) {
			if (!lines[j].trim()) continue;
			if (/^\s*/.exec(lines[j])[0].length <= indent.length) break;
			const item = /^\s*-\s*(.*)$/.exec(lines[j]);
			if (!item) break;
			out.push(...(item[1].startsWith('[') ? flowSequence(item[1]) : [unquote(item[1])]));
		}
	}
	return out.filter((t) => LABEL_RE.test(t));
}

/**
 * Resolve one `runs-on` value to the labels it can request.
 *
 * @param {string} raw the value from {@link jobRunsOn}
 * @param {{fleetValue: string, jobText?: string}} ctx `fleetValue` is
 *        `FLEET_VALUE` — the one copy of the label set `vars.CI_RUNNER` holds.
 * @returns {{labels: string[], unresolved: string|null}} `unresolved` names why
 *          nothing could be read; `labels` may include hosted images, which
 *          the caller filters — a hosted-only job resolved fine.
 */
export function resolveRunsOn(raw, { fleetValue, jobText = '' }) {
	const value = String(raw ?? '').trim();
	if (!value) return { labels: [], unresolved: '`runs-on:` has no value' };
	const labels = [];

	if (/\$\{\{/.test(value)) {
		// AN ARRAY TESTED BY `contains()` IS A LOOKUP, NOT A LABEL SET. The
		// untrusted-PR guard carries `contains(fromJSON('["OWNER","MEMBER",
		// "COLLABORATOR"]'), github.event.pull_request.author_association)`, and
		// those are author associations. Removed before arrays are collected.
		let expr = value.replace(
			/contains\(\s*(?:fromJSON\(\s*)?(['"])\[[^\]]*\]\1\s*\)?\s*,/g,
			'contains(,'
		);
		if (/vars\.CI_RUNNER/.test(expr)) labels.push(...JSON.parse(fleetValue));
		// Every JSON array literal, in either quote — including a `format()`
		// template, whose `{0}` placeholders are dropped by LABEL_RE.
		for (const re of [/'(\[[^']*?\])'/g, /"(\[[^"]*?\])"/g]) {
			for (const arr of expr.matchAll(re)) labels.push(...flowSequence(arr[1]));
			expr = expr.replace(re, '');
		}
		// A quoted HOSTED scalar is the fork guard's escape hatch
		// (`|| 'ubuntu-latest'`). Read so a hosted-only expression resolves;
		// other quoted scalars are comparison operands (`'pull_request'`).
		for (const q of expr.matchAll(/'([^']*)'|"([^"]*)"/g)) {
			const t = q[1] ?? q[2];
			if (LABEL_RE.test(t) && isHostedLabel(t)) labels.push(t);
		}
		for (const mk of expr.matchAll(/matrix\.([A-Za-z0-9_-]+)/g)) {
			labels.push(...matrixValues(jobText, mk[1]));
		}
	} else if (value.includes('\n') || /^-\s/.test(value)) {
		// A block: a YAML list of labels, or a `group`/`labels` mapping.
		const rows = value.split('\n');
		const labelsAt = rows.findIndex((r) => /^labels:/.test(r));
		if (labelsAt !== -1) {
			const inline = rows[labelsAt].replace(/^labels:\s*/, '');
			if (inline) labels.push(...flowSequence(inline.startsWith('[') ? inline : `[${inline}]`));
			for (const r of rows.slice(labelsAt + 1)) {
				const item = /^-\s*(.*)$/.exec(r);
				if (!item) break;
				labels.push(unquote(item[1]));
			}
		} else {
			for (const r of rows) {
				const item = /^-\s*(.*)$/.exec(r);
				if (item) labels.push(unquote(item[1]));
			}
		}
	} else if (value.startsWith('[')) {
		labels.push(...flowSequence(value));
	} else if (value.startsWith('{')) {
		const l = /labels:\s*(\[[^\]]*\]|[^,}]+)/.exec(value);
		if (l) labels.push(...flowSequence(l[1].startsWith('[') ? l[1] : `[${l[1]}]`));
	} else {
		labels.push(unquote(value));
	}

	const clean = [...new Set(labels.filter((l) => LABEL_RE.test(l)))];
	return clean.length
		? { labels: clean, unresolved: null }
		: { labels: [], unresolved: `\`runs-on: ${value.replace(/\n/g, ' ')}\` resolves to no label` };
}

/**
 * Every job's requested labels in one workflow, comments stripped first —
 * prose about a `runs-on` is not a `runs-on`.
 *
 * A job with `uses:` and no `runs-on` is a reusable-workflow CALL: its demand
 * lives in the called workflow, which is scanned in its own right. A job with
 * neither, and a file whose jobs cannot be split at all, is a finding.
 *
 * @returns {{jobs: {id: string, labels: string[]}[], unresolved: string[]}}
 */
export function workflowDemand(body, { fleetValue }) {
	const text = stripYamlComments(String(body));
	const jobs = [];
	const unresolved = [];
	const split = splitJobs(text);
	if (!split.length) {
		unresolved.push('no jobs could be read (no top-level `jobs:` with 2-space job ids)');
		return { jobs, unresolved };
	}
	for (const j of split) {
		const raw = jobRunsOn(j.text);
		if (raw === null) {
			if (!/^ {4}uses:/m.test(j.text)) unresolved.push(`${j.id}: no \`runs-on\` and no \`uses\``);
			continue;
		}
		const r = resolveRunsOn(raw, { fleetValue, jobText: j.text });
		if (r.unresolved) unresolved.push(`${j.id}: ${r.unresolved}`);
		else jobs.push({ id: j.id, labels: r.labels });
	}
	return { jobs, unresolved };
}

/**
 * The OBSERVED half: the labels GitHub actually requested, from job history.
 *
 * Static parsing answers what a workflow CAN ask for; this answers what jobs
 * DID ask for, including a `runs-on` resolved from an input or a variable no
 * file carries. Neither alone is the demand — the union is.
 *
 * A PROOF RUN IS NOT DEMAND. `fleet prove` dispatches a job onto a throwaway
 * `proof-<ts>` label so the canary lands on one node only; the workflow did
 * not ask for that label, the prover did. Those rows are recognised by their
 * runner (`isProof`), never by the label's spelling.
 *
 * @param {string} text the raw jsonl
 * @param {{sinceIso: string, isProof: (runner: string) => boolean}} opts
 * @returns {{labels: Map<string, number>, rows: number, malformed: number}}
 */
export function observedDemand(text, { sinceIso, isProof }) {
	const labels = new Map();
	let rows = 0;
	let malformed = 0;
	for (const line of String(text).split('\n')) {
		if (!line.trim()) continue;
		let r;
		try {
			r = JSON.parse(line);
		} catch {
			// Counted and reported by the caller, never dropped silently: an
			// append-only file killed mid-write leaves one partial line.
			malformed++;
			continue;
		}
		if (typeof r?.startedAt !== 'string' || r.startedAt < sinceIso) continue;
		if (!Array.isArray(r.labels) || !r.labels.length) continue;
		if (typeof r.runner === 'string' && isProof(r.runner)) continue;
		rows++;
		for (const l of r.labels) labels.set(l, (labels.get(l) ?? 0) + 1);
	}
	return { labels, rows, malformed };
}
