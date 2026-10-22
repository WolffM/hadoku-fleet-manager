/**
 * The workflow -> runner inventory, as a function of the checkouts (#38).
 *
 * `docs/operations/SELF_HOSTED_RUNNERS.md` in hadoku_site carries the
 * blast-radius table: when a claw goes down, it says which workflows degrade.
 * It was hand-maintained, so it rotted — measured 2026-09-19 from the file
 * itself, 32 data rows of which FIFTEEN read "`runs-on:` flip pending" for a
 * migration that finished, plus two rows naming things that no longer exist
 * (`hadoku-builder-heavy`, retired 2026-08-19, and `hadoku-trader`, archived).
 *
 * Everything in the first three columns is already readable from the
 * checkouts, so this derives them. The fourth is not, and that distinction is
 * the whole design:
 *
 *   Repo, Workflow, Label   DERIVED. Regenerated on every `--write`.
 *   Notes                   MERGED from a hand-written map. Never generated.
 *
 * The notes are decisions and incident history — "stays GH-hosted:
 * `actions/deploy-pages@v5` requires it", "Timeout 20m (added 2026-06-04 — was
 * missing; 3.5h hang)". A generator that overwrote them would make the table
 * worse than the stale version it replaces.
 *
 * A ROTTED NOTE IS A FINDING, IN ONE DIRECTION ONLY. A note naming a
 * repo+workflow pair that no longer exists is stale operator config pointing at
 * a workflow nobody can find, so it fails the gate. A row with no note is
 * normal and always will be — most workflows have nothing to say.
 *
 * WHY THE LABEL IS READ FROM THE WORKFLOW AND NOT FROM THE LIVE VARIABLE
 * ---------------------------------------------------------------------
 * `runs-on: ${{ fromJSON(vars.CI_RUNNER) }}` resolves through a GitHub
 * variable, and `fleet check-runner-var` deliberately reads that variable from
 * the API — "the reader for a facet may not read what the writer wrote". This
 * table must NOT. `src/ci-runner-fallback.ts` moves `CI_RUNNER` to
 * `"ubuntu-latest"` on every covered repo while every claw is offline, so a
 * LABEL column resolved from the live variable would rewrite itself during an
 * outage and `--check` would then go red for the outage rather than for drift —
 * a gate that gets harder to pass the worse the fleet is doing, and one whose
 * output changes with nothing committed. So the label here is what the
 * WORKFLOW ASKS FOR, which is a function of a commit; what the variable
 * currently HOLDS stays `check-runner-var`'s question.
 *
 * The readers are borrowed rather than rewritten: `stripYamlComments` (a
 * comment may not be evidence), `deriveLabels` and `HOSTED_RE` from
 * `demand-derive.mjs`. "Which labels does this `runs-on` resolve to" already
 * had an answer and does not get a second one.
 *
 * Pure — no fs, no network, no clock. `scripts/fleet-inventory.mjs` does the
 * reading and the writing.
 */
import { stripYamlComments } from './yaml-comments.mjs';
import { deriveLabels, HOSTED_RE } from './demand-derive.mjs';

/** The fences around the generated region in the markdown doc. */
export const BEGIN_MARKER = '<!-- BEGIN GENERATED: fleet inventory -->';
export const END_MARKER = '<!-- END GENERATED: fleet inventory -->';

/**
 * Every `runs-on:` value in a workflow, in file order, comments stripped.
 *
 * BLOCK SCALARS ARE FOLDED, and they are not an edge case: five fleet repos
 * write the untrusted-PR guard as `runs-on: >-` with the expression on the next
 * six lines. A line regex reads that as the literal label `>-`, which is how a
 * derived table invents a runner nothing carries.
 *
 * @param {string} body raw workflow YAML
 * @returns {string[]}
 */
export function runsOnValues(body) {
	const lines = stripYamlComments(String(body)).split('\n');
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^(\s*)runs-on:\s*(.*?)\s*$/.exec(lines[i]);
		if (!m) continue;
		const [, indent, value] = m;
		if (!/^[|>][+-]?$/.test(value)) {
			if (value) out.push(value);
			continue;
		}
		// A folded/literal block: every following line indented deeper than the
		// key belongs to it. Joined with single spaces — the expression is one
		// value however it was wrapped.
		const parts = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (!lines[j].trim()) continue;
			const lead = /^\s*/.exec(lines[j])[0];
			if (lead.length <= indent.length) break;
			parts.push(lines[j].trim());
		}
		if (parts.length) out.push(parts.join(' '));
	}
	return out;
}

/**
 * Labels named inside a QUOTED JSON ARRAY in the expression.
 *
 * brave-quartet's `format('["{0}","cargo-bevy"]', join(fromJSON(vars.CI_RUNNER),
 * '","'))` is the case this exists for: `cargo-bevy` is real routing, it is
 * ANDed onto whatever the variable holds, and it is invisible to
 * `deriveLabels`, which reads bare bracket lists only.
 *
 * THE ARRAY IS THE FILTER, and it has to be. A guarded `runs-on` also quotes
 * `'pull_request'` — `github.event_name == 'pull_request'` — and reading every
 * quoted lowercase token as a label put a runner called `pull_request` in
 * sixteen rows of the first generated table. Only a JSON array reaches
 * `fromJSON`/`format`, so only a JSON array can contribute a label.
 * `["OWNER","MEMBER","COLLABORATOR"]` is excluded by the lowercase rule, which
 * is what tells the association list apart from a label set.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function arrayLabels(raw) {
	const found = [];
	// One pass per delimiter. A single backreferenced pattern would have to
	// exclude BOTH quote characters from the array body, and the array that
	// matters most — `'["{0}","cargo-bevy"]'` — is single-quoted with
	// double-quoted members, so it would never match. It did not, and
	// `cargo-bevy` vanished from brave-quartet's row.
	for (const re of [/'(\[[^']*?\])'/g, /"(\[[^"]*?\])"/g]) {
		for (const arr of raw.matchAll(re)) {
			for (const m of arr[1].matchAll(/["']([a-z][a-z0-9._-]*)["']/g)) found.push(m[1]);
		}
	}
	return found;
}

/**
 * Every quoted hosted image in the expression, array or not.
 *
 * The escape hatch is written both ways in this fleet — `&& '["ubuntu-latest"]'`
 * inside the guard, and a bare `|| 'ubuntu-latest'` at the end of the folded
 * form — so this one deliberately does NOT require an array.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function quotedHosted(raw) {
	const found = [];
	for (const m of raw.matchAll(/["']([a-z][a-z0-9._-]*)["']/g)) {
		if (HOSTED_RE.test(m[1])) found.push(m[1]);
	}
	return found;
}

/**
 * How one `runs-on` value routes.
 *
 * @param {string} raw
 * @returns {{fleet: boolean, extras: string[], hostedFallback: string|null,
 *            untrustedGuard: boolean, literal: string[], label: string}}
 */
export function routingOf(raw) {
	const value = String(raw).trim();
	const derived = deriveLabels(`runs-on: ${value}`);
	const fleet = derived.fleetForm;
	const untrustedGuard = /author_association/.test(value);

	let extras = [];
	let hostedFallback = null;
	let literal = [];

	if (fleet) {
		// Inside a fleet expression, a quoted hosted image is the escape hatch and
		// an array label is one ANDed onto whatever the variable holds.
		hostedFallback = quotedHosted(value)[0] ?? null;
		for (const token of arrayLabels(value)) {
			if (HOSTED_RE.test(token) || extras.includes(token)) continue;
			extras.push(token);
		}
	} else {
		literal = derived.explicit.length
			? derived.explicit
			: [value.replace(/^["']|["']$/g, '')].filter(Boolean);
	}

	let label;
	if (fleet) {
		label = ['`vars.CI_RUNNER`', ...extras.map((e) => `\`${e}\``)].join(' + ');
		if (hostedFallback) {
			label += `, else \`${hostedFallback}\``;
			if (untrustedGuard) label += ' (untrusted PR)';
		}
	} else if (literal.length) {
		label = literal.map((l) => `\`${l}\``).join(' + ');
	} else {
		// An expression with no `vars.CI_RUNNER`, no bracket list and no literal —
		// `${{ matrix.os }}` and friends. Say so rather than print a template as
		// though it were a runner label.
		label = `unresolved: \`${value}\``;
	}
	if (!fleet && /\$\{\{/.test(value)) label = `unresolved: \`${value}\``;

	return { fleet, extras, hostedFallback, untrustedGuard, literal, label };
}

/**
 * The Label cell for one workflow: every distinct routing it uses.
 *
 * A workflow with NO `runs-on` at all is a reusable caller — hadoku_site's
 * `deploy-workers.yml` shape — and says so. It is not a finding: the workflow
 * is readable, it simply delegates.
 *
 * @param {string} body raw workflow YAML
 * @returns {string}
 */
export function workflowLabel(body) {
	const values = runsOnValues(body);
	if (!values.length) return '(no `runs-on` — calls another workflow)';
	const labels = [];
	for (const v of values) {
		const { label } = routingOf(v);
		if (!labels.includes(label)) labels.push(label);
	}
	return labels.join(' / ');
}

/** `owner/repo` + workflow filename, the key the notes map is written against. */
export function noteKey(repo, workflow) {
	return `${repo} ${workflow}`;
}

/** Roster order: byte order on `owner/repo`, then on the workflow filename. */
export function compareRows(a, b) {
	if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
	return a.workflow < b.workflow ? -1 : a.workflow > b.workflow ? 1 : 0;
}

/** A markdown table cell: pipes escaped, newlines flattened. */
function cell(text) {
	return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Notes that name a `repo + workflow` pair no row carries.
 *
 * @param {Record<string, Record<string, string>>} notes
 * @param {{repo: string, workflow: string}[]} rows
 * @returns {string[]} one finding per rotted key, with the reason in it
 */
export function rottedNotes(notes, rows) {
	const present = new Set(rows.map((r) => noteKey(r.repo, r.workflow)));
	const out = [];
	for (const [repo, byWorkflow] of Object.entries(notes ?? {})) {
		for (const workflow of Object.keys(byWorkflow ?? {})) {
			if (present.has(noteKey(repo, workflow))) continue;
			out.push(
				`${repo} ${workflow}: a hand-written note names a workflow that no longer exists ` +
					'in that checkout — the workflow was renamed or deleted and the note was not. ' +
					'Move it to the new filename, or delete it.'
			);
		}
	}
	return out.sort();
}

/**
 * The generated table body, notes merged in.
 *
 * @param {{repo: string, workflow: string, label: string}[]} rows
 * @param {Record<string, Record<string, string>>} notes
 * @returns {string} markdown, no trailing newline
 */
export function renderTable(rows, notes) {
	const header = ['| Repo | Workflow | Label | Notes |', '| ---- | -------- | ----- | ----- |'];
	const body = [...rows].sort(compareRows).map((r) => {
		const note = notes?.[r.repo]?.[r.workflow] ?? '';
		const name = r.repo.includes('/') ? r.repo.split('/').slice(1).join('/') : r.repo;
		return `| \`${cell(name)}\` | \`${cell(r.workflow)}\` | ${cell(r.label)} | ${cell(note)} |`;
	});
	return [...header, ...body].join('\n');
}

/**
 * The whole generated region, fences included.
 *
 * @param {string} table
 * @param {{repos: number, workflows: number}} counts
 * @returns {string}
 */
export function renderRegion(table, counts) {
	return [
		BEGIN_MARKER,
		'',
		'<!-- GENERATED by `fleet inventory --write` from the sibling checkouts.',
		'     The Repo/Workflow/Label columns are DERIVED — hand edits are reverted on the',
		'     next write and fail `fleet inventory --check`. The Notes column is MERGED from',
		'     scripts/admin/runner-inventory-notes.json, which IS hand-written: put decisions',
		'     and incident history there, keyed by repo then workflow filename. -->',
		'',
		`_${counts.workflows} workflow(s) across ${counts.repos} repo(s). \`vars.CI_RUNNER\` is the` +
			' fleet: `fleet check-runner-var` is what says whether it is actually set._',
		'',
		table,
		'',
		END_MARKER,
	].join('\n');
}

/**
 * How many data rows a rendered generated region carries — used ONLY to size
 * the shrink floor (#84 part 2), never to read the table's content back out.
 *
 * Every data row starts with `` | ` `` — the Repo cell is always
 * backtick-quoted (`renderTable`) and neither the header row (`| Repo | ...`)
 * nor the separator (`| ---- | ...`) is, so counting that prefix skips both
 * without having to find them by position.
 *
 * @param {string|null} region a full generated region, fences included, or null
 * @returns {number}
 */
export function countTableRows(region) {
	if (!region) return 0;
	return String(region)
		.split('\n')
		.filter((l) => /^\|\s*`/.test(l)).length;
}

/**
 * The generated region of `doc`, fences included, or `null` if it has none.
 *
 * @param {string} doc
 * @returns {string|null}
 */
export function generatedRegion(doc) {
	const start = String(doc).indexOf(BEGIN_MARKER);
	const end = String(doc).indexOf(END_MARKER);
	if (start === -1 || end === -1 || end < start) return null;
	return String(doc).slice(start, end + END_MARKER.length);
}

/**
 * `doc` with its generated region replaced by `region`.
 *
 * THROWS when the fences are absent or out of order. Appending instead would
 * put a second table in the doc and leave the stale one in place, which is the
 * failure this whole subcommand exists to end.
 *
 * @param {string} doc
 * @param {string} region a full region, fences included
 * @returns {string}
 */
export function spliceRegion(doc, region) {
	const text = String(doc);
	const start = text.indexOf(BEGIN_MARKER);
	const end = text.indexOf(END_MARKER);
	if (start === -1 || end === -1 || end < start) {
		throw new Error(
			`fleet inventory: the target doc carries no generated region. Add the fences\n` +
				`  ${BEGIN_MARKER}\n  ${END_MARKER}\n` +
				'around the workflow -> runner inventory table and run --write again. ' +
				'Appending would leave the stale table in place beside the derived one.'
		);
	}
	return text.slice(0, start) + region + text.slice(end + END_MARKER.length);
}

/**
 * HOW LONG A WORKFLOW CHANGE MAY BE MISSING FROM THE TABLE BEFORE IT IS DRIFT
 * (#103 item 3) — the regeneration's own worst-case latency, in seconds.
 *
 * The chain that repairs the table, read from hadoku_site's
 * `reconcile-fleet-coverage.yml` on 2026-10-10: a sibling commit reaches the
 * host's checkouts at the daily 13:00 UTC `repos:main-sync`, and the 14:00
 * UTC run of that workflow regenerates the table from them. So a commit made
 * just after a sync waits:
 *
 *   24h   one regeneration period (the sync and the run are both daily)
 *    1h   the sync -> regeneration offset (13:00 -> 14:00)
 *    4h   GitHub's schedule lag — measured 1-4h late (2026-10-03: 16:34 and
 *         17:42 against a 12:30 slot)
 *
 * `ci:fleet-inventory` paged @here on 2026-10-07 for cardtable's `forge.yml`,
 * committed the evening before — inside this window, with nothing wrong but a
 * schedule that had not fired yet.
 */
export const YOUNG_DRIFT_SECONDS = (24 + 1 + 4) * 3600;

/** Cells of one markdown table row, `\|` honoured, outer pipes dropped, trimmed. */
function tableCells(line) {
	const cells = [];
	let cur = '';
	for (let i = 1; i < line.length; i++) {
		if (line[i] === '\\' && line[i + 1] === '|') {
			cur += '\\|';
			i++;
		} else if (line[i] === '|') {
			cells.push(cur.trim());
			cur = '';
		} else cur += line[i];
	}
	return cells;
}

/**
 * The data rows of a generated region, keyed `<repo cell> <workflow cell>`.
 *
 * Read back ONLY to classify a difference the caller has already found, never
 * as a source of truth: the checkouts are that. Padding is irrelevant — the
 * target repo's prettier aligns the columns — so cells are trimmed.
 *
 * @param {string|null} region
 * @returns {Map<string, {repo: string, workflow: string, label: string, notes: string}>}
 */
export function tableRows(region) {
	const out = new Map();
	for (const line of String(region ?? '').split('\n')) {
		if (!/^\|\s*`/.test(line)) continue;
		const [repo, workflow, label = '', notes = ''] = tableCells(line);
		const strip = (c) => c.replace(/^`|`$/g, '');
		out.set(`${strip(repo)} ${strip(workflow)}`, {
			repo: strip(repo),
			workflow: strip(workflow),
			label,
			notes,
		});
	}
	return out;
}

/** Everything in a region that is not a table line, with the count normalised. */
function regionProse(region) {
	return String(region ?? '')
		.split('\n')
		.filter((l) => !/^\s*\|/.test(l))
		.join('\n')
		.replace(/_\d+ workflow\(s\) across \d+ repo\(s\)/, '_N workflow(s) across N repo(s)')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * WHAT KIND of difference lies between the committed region and the derived
 * one — the question `--check` used to collapse into "stale".
 *
 * Only an ADDED row, or a row whose LABEL changed, can be a workflow commit
 * the regeneration has not reached yet. A REMOVED row, a changed Notes cell (the
 * notes map is hand-written in the site repo), or any change outside the rows
 * (a hand edit of the fenced prose) is never that, and the caller keeps them
 * failing.
 *
 * @returns {{added: string[], relabelled: string[], removed: string[],
 *            notesChanged: string[], proseChanged: boolean}} row keys
 */
export function classifyDrift(diskRegion, renderedRegion) {
	const disk = tableRows(diskRegion);
	const next = tableRows(renderedRegion);
	const added = [];
	const relabelled = [];
	const notesChanged = [];
	for (const [key, row] of next) {
		const was = disk.get(key);
		if (!was) added.push(key);
		else {
			if (was.label !== row.label) relabelled.push(key);
			if (was.notes !== row.notes) notesChanged.push(key);
		}
	}
	const removed = [...disk.keys()].filter((k) => !next.has(k));
	return {
		added,
		relabelled,
		removed,
		notesChanged,
		proseChanged: regionProse(diskRegion) !== regionProse(renderedRegion),
	};
}
