#!/usr/bin/env node
/**
 * fleet inventory — derive the workflow -> runner table into hadoku_site (#38).
 *
 * `docs/operations/SELF_HOSTED_RUNNERS.md` is the blast-radius doc: when a claw
 * goes down it is what says which workflows degrade. It said "Update when
 * adding/flipping a workflow", which is the shape of instruction that is
 * followed until it is not. Measured from the file on 2026-09-19: 32 data rows,
 * FIFTEEN of them reading "`runs-on:` flip pending" for a migration that had
 * finished, one naming a label retired 2026-08-19 and one naming an archived
 * repo.
 *
 * `scripts/ci-watch.mjs` is the precedent and this is the same shape: resolve
 * `siteRoot()`, derive the content from the roster plus the checkouts, write a
 * fenced GENERATED region into that repo, and make `--check` the staleness
 * gate. The difference is the Notes column, which is merged from a hand-written
 * map and never generated — see `lib/fleet-inventory.mjs` for why.
 *
 * "I COULD NOT LOOK" IS NOT "NOTHING IS WRONG", AND IT NEVER BECOMES A ROW. A
 * roster repo with no checkout, a checkout with no `.github/workflows`, a
 * workflow that will not read — each is a FINDING carrying its own reason,
 * because a missing checkout, a permissions error and a deleted directory are
 * three different jobs. And a run that found problems REFUSES TO WRITE: a table
 * silently missing the repo we could not open is worse than the stale one,
 * since the stale one at least still names it.
 *
 * NOT UNDER THE `--json` CONTRACT. No mgmt-api cron consumes this yet, so
 * `scripts/lib/json-contract.mjs` deliberately gets no entry — adding one would
 * declare a consumer that does not exist. `--json` is implemented anyway
 * because wiring it later must not need a change here.
 *
 * @guards docs/operations/SELF_HOSTED_RUNNERS.md (in hadoku_site)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { allRepos } from './lib/fleet-roster.mjs';
import { reposDir, siteRoot, manifest as manifestFile } from './lib/paths.mjs';
import { createEmitter } from './lib/emit.mjs';
import { loadPrettier } from './lib/prettier-json.mjs';
import { shrinkRefusal } from './lib/demand-derive.mjs';
import {
	YOUNG_DRIFT_SECONDS,
	classifyDrift,
	countTableRows,
	generatedRegion,
	renderRegion,
	renderTable,
	rottedNotes,
	spliceRegion,
	workflowLabel,
} from './lib/fleet-inventory.mjs';

const WRITE = process.argv.includes('--write');
const CHECK = process.argv.includes('--check');
const ALLOW_SHRINK = process.argv.includes('--allow-shrink');
const emitter = createEmitter();
const log = emitter.log;

/** The doc that carries the generated region, inside the hadoku_site checkout. */
const DOC_PATH = ['docs', 'operations', 'SELF_HOSTED_RUNNERS.md'];
/** The hand-written notes map, beside the other operator config. */
const NOTES_FILE = 'runner-inventory-notes.json';

/**
 * The region text as the target repo's own prettier would write it.
 *
 * Same bet, and the same reasoning, as `renderJson` (#12): hadoku_site formats
 * its markdown at `printWidth: 80` with spaces, this package formats at 100
 * with tabs, and a generated block written to our rules leaves that checkout
 * failing its own `format:check` on a file nobody edited. Ask the real
 * formatter, resolved from the TARGET file's tree, rather than keep a second
 * copy of somebody else's rules.
 *
 * Reports which formatter answered, and never throws — an unformattable region
 * is still the right content, and the caller says so in its output rather than
 * pretending it was formatted.
 */
async function formatMarkdown(text, filePath) {
	const loaded = await loadPrettier(filePath);
	if (!loaded) return { text, formatter: null };
	try {
		const config = (await loaded.api.resolveConfig(filePath)) ?? {};
		// Plugins dropped for the same reason renderJson drops them: hadoku_site's
		// .prettierrc declares `prettier-plugin-astro`, which cannot be installed
		// here, and prettier loads declared plugins before it looks at the parser.
		// The markdown parser is built in and takes no plugin.
		delete config.plugins;
		const out = await loaded.api.format(text, {
			...config,
			filepath: filePath,
			parser: 'markdown',
		});
		return { text: out.replace(/\n+$/, ''), formatter: loaded.path };
	} catch {
		return { text, formatter: null };
	}
}

/**
 * Unix seconds of the newest commit touching `rel` in the checkout at `dir`,
 * or an Error saying why it could not be read.
 *
 * Every `GIT_*` variable is stripped: run from a hook, `GIT_DIR` would point
 * this read at the hook's repository instead of the checkout it names.
 */
function newestCommitSec(dir, rel) {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
	);
	try {
		const out = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%ct', '--', rel], {
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 15_000,
		}).trim();
		if (!/^\d+$/.test(out)) return new Error(`no commit touches ${rel}`);
		return Number(out);
	} catch (err) {
		return new Error(
			String(err.stderr || err.message)
				.trim()
				.split('\n')[0]
		);
	}
}

/**
 * IS THIS DRIFT ONLY THE REGENERATION NOT HAVING RUN YET? (#103 item 3)
 *
 * Advisory only when EVERY difference is an added or relabelled row AND the
 * newest commit to each such workflow is younger than {@link
 * YOUNG_DRIFT_SECONDS}. A removal, a Notes change, a hand edit of the fenced
 * prose, an old commit, or a commit that could not be dated keeps the run
 * failing, and the reason says which — "could not date it" is not "it is new".
 */
function youngDrift(onDisk, rendered, rows, reposRoot) {
	const d = classifyDrift(onDisk, rendered);
	const real = [];
	if (d.removed.length) real.push(`removed: ${d.removed.join(', ')}`);
	if (d.notesChanged.length) real.push(`Notes changed: ${d.notesChanged.join(', ')}`);
	if (d.proseChanged) real.push('the region outside the table was hand-edited');
	const now = Math.floor(Date.now() / 1000);
	const lines = [];
	for (const key of [...d.added, ...d.relabelled]) {
		const row = rows.find((r) => `${r.repo.split('/').slice(1).join('/')} ${r.workflow}` === key);
		if (!row) {
			real.push(`${key}: differs and no derived row names it`);
			continue;
		}
		const sec = newestCommitSec(
			join(reposRoot, row.repo.split('/').pop()),
			join('.github', 'workflows', row.workflow)
		);
		if (sec instanceof Error) {
			real.push(`${row.repo} ${row.workflow}: could not date its newest commit (${sec.message})`);
			continue;
		}
		const ageH = ((now - sec) / 3600).toFixed(1);
		if (now - sec >= YOUNG_DRIFT_SECONDS) {
			real.push(
				`${row.repo} ${row.workflow}: changed ${ageH}h ago, older than the ` +
					`${YOUNG_DRIFT_SECONDS / 3600}h regeneration window`
			);
			continue;
		}
		lines.push(
			`${row.repo} ${row.workflow}: ${d.added.includes(key) ? 'added' : 'repointed'} ${ageH}h ago — ` +
				`inside the ${YOUNG_DRIFT_SECONDS / 3600}h regeneration window, so the next ` +
				'`fleet inventory --write` (reconcile-fleet-coverage.yml, 14:00 UTC) repairs it.'
		);
	}
	if (!d.added.length && !d.relabelled.length && !real.length) {
		real.push('the table differs in a way no row-level comparison explains');
	}
	return real.length ? { ok: false, why: real.join('; ') } : { ok: true, lines };
}

/** Every `.yml`/`.yaml` under a checkout's workflows dir, sorted. */
function workflowFiles(dir) {
	return readdirSync(dir)
		.filter((f) => /\.ya?ml$/.test(f))
		.sort();
}

async function main() {
	const REPOS = reposDir();
	const SITE = siteRoot();
	const doc = join(SITE, ...DOC_PATH);
	const notesPath = manifestFile(NOTES_FILE);

	/** Findings. Each one carries WHY, because the reason decides the next job. */
	const problems = [];

	// The notes map is operator config and a missing one must not degrade into
	// "no notes": that renders an empty Notes column, which is the exact content
	// loss this subcommand exists to prevent.
	let notes = null;
	if (!existsSync(notesPath)) {
		problems.push(
			`the notes map ${notesPath} does not exist. Without it the Notes column would ` +
				'render empty, which silently deletes the decisions and incident history this ' +
				'table exists to carry. Create it as {"<owner/repo>": {"<workflow.yml>": "note"}}.'
		);
	} else {
		try {
			notes = JSON.parse(readFileSync(notesPath, 'utf8')).notes ?? {};
		} catch (err) {
			problems.push(`the notes map ${notesPath} would not parse: ${err.message}`);
		}
	}

	const rows = [];
	const reposSeen = new Set();
	for (const repo of allRepos({ includeHost: true })) {
		const dir = join(REPOS, repo.split('/').pop());
		if (!existsSync(dir)) {
			problems.push(
				`${repo}: no checkout at ${dir}, so its workflows could not be read. ` +
					'A repo we could not look at is never an empty row.'
			);
			continue;
		}
		const wf = join(dir, '.github', 'workflows');
		if (!existsSync(wf)) {
			problems.push(
				`${repo}: the checkout at ${dir} has no .github/workflows directory. ` +
					'Either the checkout is shallow/stale or the repo left CI — say which.'
			);
			continue;
		}
		let files;
		try {
			files = workflowFiles(wf);
		} catch (err) {
			problems.push(`${repo}: ${wf} would not list: ${err.message}`);
			continue;
		}
		if (!files.length) {
			problems.push(
				`${repo}: ${wf} holds no workflow file, but the roster says this repo has CI. ` +
					'A covered repo with nothing to run is a coverage finding, not an empty row.'
			);
			continue;
		}
		for (const workflow of files) {
			let body;
			try {
				body = readFileSync(join(wf, workflow), 'utf8');
			} catch (err) {
				problems.push(`${repo} ${workflow}: would not read: ${err.message}`);
				continue;
			}
			reposSeen.add(repo);
			rows.push({ repo, workflow, label: workflowLabel(body) });
		}
	}

	// SCANNING NOTHING IS A FAILURE. An empty inventory reads exactly like a
	// fleet with no workflows, and the causes — a wrong REPOS_DIR, an empty
	// roster — are all fixable and none of them is healthy.
	if (!rows.length) {
		const why =
			`fleet inventory: derived ZERO workflow rows under ${REPOS}. That is a broken ` +
			'scan, not a fleet with no CI — set REPOS_DIR to the directory holding the ' +
			'sibling checkouts.';
		if (emitter.json) emitter.emit({ ok: false, error: why, problems });
		else console.error(why);
		process.exit(1);
	}

	problems.push(...rottedNotes(notes ?? {}, rows));

	const counts = { repos: reposSeen.size, workflows: rows.length };
	const region = renderRegion(renderTable(rows, notes ?? {}), counts);
	const { text: rendered, formatter } = await formatMarkdown(region, doc);

	let disk = null;
	let current = null;
	if (existsSync(doc)) {
		disk = readFileSync(doc, 'utf8');
		current = generatedRegion(disk);
		if (current === null) {
			problems.push(
				`${doc} carries no generated region. Add the fences around the ` +
					'workflow -> runner inventory table (see lib/fleet-inventory.mjs) — ' +
					'appending would leave the stale table in place beside the derived one.'
			);
		}
	} else {
		problems.push(`${doc} does not exist — the generated region has nowhere to go.`);
	}

	let wrote = false;
	let stale = false;
	/** Young drift the scheduled regeneration will repair — reported, never failed. */
	const advisory = [];

	if (WRITE) {
		// THE SHRINK FLOOR (#84 part 2). A roster repo being archived drops a few
		// rows; a wrong REPOS_DIR or an empty sibling-checkout tree drops nearly
		// all of them — the 67 -> 0 shape the issue was filed over. Computed and
		// checked BEFORE the write, same as every other finding above, so "wrote a
		// degraded file, then failed" stays unreachable here too.
		const shrink = shrinkRefusal(countTableRows(current), rows.length, {
			allowShrink: ALLOW_SHRINK,
		});
		if (shrink) problems.push(`fleet inventory: ${shrink}`);
		if (problems.length) {
			log(`REFUSING to write ${doc}: ${problems.length} finding(s) below.`);
		} else {
			writeFileSync(doc, spliceRegion(disk, rendered));
			wrote = true;
			log(`wrote ${doc}`);
		}
	}

	if (CHECK && current !== null) {
		// Compare AFTER a --write in the same run, so `--write --check` is
		// meaningful rather than a comparison against the bytes we just replaced.
		const onDisk = wrote ? generatedRegion(readFileSync(doc, 'utf8')) : current;
		if (onDisk !== rendered) {
			stale = true;
			const young = youngDrift(onDisk, rendered, rows, REPOS);
			if (young.ok) {
				advisory.push(...young.lines);
			} else {
				problems.push(
					`${doc}: the generated region is STALE — ${young.why}. fix: fleet inventory --write` +
						(formatter
							? ''
							: ' (note: no prettier could be resolved for that tree, so part of this ' +
								'difference may be formatting only)')
				);
			}
		}
	}

	if (emitter.json) {
		emitter.emit({
			ok: problems.length === 0,
			doc,
			notes: notesPath,
			formatter,
			wrote,
			stale,
			// ADDITIVE (#103): drift inside the regeneration window. Never a problem.
			advisory,
			...counts,
			rows,
			problems,
		});
	} else {
		log(`fleet inventory: ${counts.workflows} workflow(s) across ${counts.repos} repo(s)`);
		if (!formatter) log('  (no prettier resolved for the target tree — region is unformatted)');
		for (const p of problems) console.error(`  ✗ ${p}`);
		for (const a of advisory) log(`  · advisory: ${a}`);
		// The clean line NAMES WHAT WAS PROVED. Without --check nothing compared
		// the doc to anything, and saying "the table matches" there would be the
		// same lie this subcommand replaces — a reassurance nobody measured.
		if (!problems.length)
			log(
				CHECK
					? advisory.length
						? `✓ every roster repo was read; the region trails the checkouts only by the ` +
							`${advisory.length} young change(s) above`
						: '✓ every roster repo was read, and the generated region matches the checkouts'
					: '✓ every roster repo was read' +
							(wrote ? '' : ' (nothing compared or written — pass --check or --write)')
			);
	}

	process.exit(problems.length ? 1 : 0);
}

await main();
