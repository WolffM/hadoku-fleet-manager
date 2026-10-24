/**
 * The inventory is derived, the notes are not, and neither half may quietly
 * lose the other (#38).
 *
 * TWO HALVES, AND THEY GUARD DIFFERENT THINGS.
 *
 * The PURE half pins the parsing and the merge. It needs no checkout, no site
 * root and no token, so it runs everywhere — including on a claw, whose
 * `_work/` holds this repo and nothing else. That matters here more than
 * usual: the subject reads every sibling repo's workflows, and a test that
 * reached for one would pass on a workstation and redden main. Nothing below
 * resolves a real path at module scope.
 *
 * The END-TO-END half runs the real subcommand against a FIXTURE tree — its
 * own repos dir, its own manifest dir, its own doc — because three of the
 * properties that matter are wiring rather than logic: that a repo we could not
 * open FAILS, that a run with findings REFUSES to write, and that `--check`
 * goes non-zero when a workflow appears. Reading the source proves none of
 * those.
 *
 * NO absolute dates anywhere here (see fixture-clock-guard.test.mjs). Every
 * path the subject resolves is handed to it in the environment. Git appears in
 * ONE section (#103 item 3), on repos inside the fixture root only, through
 * `cleanGitEnv` — see that section's header.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	BEGIN_MARKER,
	YOUNG_DRIFT_SECONDS,
	classifyDrift,
	END_MARKER,
	countTableRows,
	generatedRegion,
	renderRegion,
	renderTable,
	rottedNotes,
	routingOf,
	runsOnValues,
	spliceRegion,
	workflowLabel,
} from './fleet-inventory.mjs';
import { fixtureRemotes, poisonedClone } from './fleet-source-fixture.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// ── the fleet's real `runs-on` shapes, as text ───────────────────────────────
//
// Every one of these was measured from the checkouts on 2026-09-19 by counting
// distinct `runs-on` values across 113 workflow files in the 28 roster repos:
// 106 bare fleet, 16 guarded one-liners, 6 folded blocks, 5 `pm2-host`, 3
// hosted, 2 `taskauto`, 1 `av1-nvenc`, 1 `jit-canary`. They are quoted rather
// than read from disk so this file works with no siblings present.

const BARE = 'jobs:\n  a:\n    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}\n';

const GUARDED_ONELINE =
	"jobs:\n  a:\n    runs-on: ${{ fromJSON((github.event_name == 'pull_request' && " +
	'!contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'), ' +
	'github.event.pull_request.author_association) && \'["ubuntu-latest"]\') || ' +
	'vars.CI_RUNNER) }}\n';

/** brave-quartet's folded form, which ANDs an extra label onto the variable. */
const FOLDED_WITH_EXTRA = [
	'jobs:',
	'  a:',
	'    runs-on: >-',
	"      ${{ (github.event_name != 'pull_request' ||",
	'           contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'),',
	'                    github.event.pull_request.author_association))',
	'          && fromJSON(format(\'["{0}","cargo-bevy"]\',',
	'                             join(fromJSON(vars.CI_RUNNER), \'","\')))',
	"          || 'ubuntu-latest' }}",
	'    steps:',
	'      - run: echo hi',
	'',
].join('\n');

const LITERAL_LIST = 'jobs:\n  a:\n    runs-on: [self-hosted, pm2-host]\n';
const HOSTED = 'jobs:\n  a:\n    runs-on: ubuntu-latest\n';

// ── the pure half ────────────────────────────────────────────────────────────

void test('a folded `runs-on: >-` block is read as its expression, never as the label `>-`', () => {
	const values = runsOnValues(FOLDED_WITH_EXTRA);
	assert.equal(values.length, 1);
	assert.ok(
		!values[0].startsWith('>'),
		`a block scalar leaked its indicator into the value: ${values[0]}`
	);
	assert.match(values[0], /vars\.CI_RUNNER/);
	assert.match(values[0], /cargo-bevy/);
});

void test('a block scalar stops at the next key, and does not swallow the steps below it', () => {
	assert.ok(!runsOnValues(FOLDED_WITH_EXTRA)[0].includes('echo hi'));
});

void test("the guard's quoted `'pull_request'` is not a runner label", () => {
	const r = routingOf(runsOnValues(GUARDED_ONELINE)[0]);
	assert.equal(r.fleet, true);
	assert.deepEqual(r.extras, [], 'only a JSON array may contribute a label');
	assert.equal(r.hostedFallback, 'ubuntu-latest');
	assert.equal(r.untrustedGuard, true);
	assert.ok(!r.label.includes('pull_request'), `invented a runner: ${r.label}`);
});

void test('the association list is not a label set either', () => {
	const r = routingOf(runsOnValues(GUARDED_ONELINE)[0]);
	for (const role of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
		assert.ok(!r.label.includes(role), `${role} is an author_association, not a runner`);
	}
});

void test('a label ANDed on inside a quoted JSON array IS routing and is reported', () => {
	const r = routingOf(runsOnValues(FOLDED_WITH_EXTRA)[0]);
	assert.equal(r.fleet, true);
	assert.deepEqual(r.extras, ['cargo-bevy']);
	assert.equal(r.hostedFallback, 'ubuntu-latest');
	assert.equal(r.label, '`vars.CI_RUNNER` + `cargo-bevy`, else `ubuntu-latest` (untrusted PR)');
});

void test('a literal label list reports every label, self-hosted included', () => {
	const r = routingOf(runsOnValues(LITERAL_LIST)[0]);
	assert.equal(r.fleet, false);
	assert.deepEqual(r.literal, ['self-hosted', 'pm2-host']);
	assert.equal(r.label, '`self-hosted` + `pm2-host`');
});

void test('a hosted image reports itself and is not confused with the fleet', () => {
	const r = routingOf(runsOnValues(HOSTED)[0]);
	assert.equal(r.fleet, false);
	assert.equal(r.label, '`ubuntu-latest`');
});

void test('an expression this cannot resolve says so rather than printing a template', () => {
	const r = routingOf('${{ matrix.os }}');
	assert.equal(r.fleet, false);
	assert.match(r.label, /^unresolved:/);
});

void test('a COMMENTED-OUT runs-on is not evidence', () => {
	const commented =
		'jobs:\n  a:\n    # runs-on: [self-hosted, pm2-host]\n    runs-on: ubuntu-latest\n';
	assert.deepEqual(runsOnValues(commented), ['ubuntu-latest']);
});

void test('a workflow with no runs-on is reported as a caller, not as an empty label', () => {
	const label = workflowLabel('jobs:\n  a:\n    uses: ./.github/workflows/_deploy-worker.yml\n');
	assert.match(label, /calls another workflow/);
	assert.ok(label.trim().length > 0, 'an empty Label cell would read as "nothing runs this"');
});

void test('a workflow with two different runs-on reports both', () => {
	const label = workflowLabel(`${BARE}  b:\n    runs-on: [self-hosted, pm2-host]\n`);
	assert.ok(label.includes('vars.CI_RUNNER'), label);
	assert.ok(label.includes('pm2-host'), label);
});

// ── THE MERGE. This is the property the whole subcommand exists to protect ───

const ROWS = [
	{ repo: 'WolffM/hadoku_site', workflow: 'deploy.yml', label: '`vars.CI_RUNNER`' },
	{ repo: 'WolffM/hadoku_site', workflow: 'lint.yml', label: '`vars.CI_RUNNER`' },
];
const NOTES = {
	'WolffM/hadoku_site': {
		'deploy.yml': 'Stays GH-hosted: `actions/deploy-pages@v5` requires it',
	},
};

void test('the hand-written note is MERGED into its row, byte for byte', () => {
	const table = renderTable(ROWS, NOTES);
	const row = table.split('\n').find((l) => l.includes('deploy.yml'));
	assert.ok(row, 'the derived row vanished');
	assert.ok(
		row.includes(NOTES['WolffM/hadoku_site']['deploy.yml']),
		'THE regression this file exists for: the generator rendered the row and dropped the ' +
			"operator's note. The Notes column is decisions and incident history — losing it " +
			`makes the derived table worse than the stale one it replaced.\n  got: ${row}`
	);
});

void test('a row with NO note is normal — an empty cell, never a finding', () => {
	const table = renderTable(ROWS, NOTES);
	const row = table.split('\n').find((l) => l.includes('lint.yml'));
	assert.ok(row.endsWith('|  |'), `expected an empty Notes cell, got: ${row}`);
	assert.deepEqual(rottedNotes(NOTES, ROWS), []);
});

void test('a note naming a workflow no row carries IS a finding, and says why', () => {
	const stale = {
		'WolffM/hadoku_site': { ...NOTES['WolffM/hadoku_site'], 'oss-scraper.yml': 'removed' },
	};
	const found = rottedNotes(stale, ROWS);
	assert.equal(found.length, 1);
	assert.match(found[0], /oss-scraper\.yml/);
	assert.match(found[0], /no longer exists/);
});

void test('a note for a repo that left the roster entirely is a finding too', () => {
	const found = rottedNotes({ 'WolffM/hadoku-trader': { 'publish.yml': 'archived' } }, ROWS);
	assert.equal(found.length, 1);
	assert.match(found[0], /hadoku-trader/);
});

void test('a pipe inside a note cannot break the table out of its column', () => {
	const table = renderTable(ROWS, {
		'WolffM/hadoku_site': { 'lint.yml': 'a | b' },
	});
	const row = table.split('\n').find((l) => l.includes('lint.yml'));
	assert.ok(row.includes('a \\| b'), row);
	assert.equal(row.split(/(?<!\\)\|/).length - 1, 5, 'a markdown row has exactly five bars');
});

// ── the fenced region ────────────────────────────────────────────────────────

void test('the region round-trips: splice it in, read the same bytes back out', () => {
	const doc = `# doc\n\nbefore\n\n${BEGIN_MARKER}\n${END_MARKER}\n\nafter\n`;
	const region = renderRegion(renderTable(ROWS, NOTES), { repos: 1, workflows: 2 });
	const next = spliceRegion(doc, region);
	assert.equal(generatedRegion(next), region);
	assert.ok(next.includes('before'), 'the prose above the region must survive');
	assert.ok(next.includes('after'), 'and so must the prose below it');
});

void test('splicing is idempotent — a second write replaces, never appends', () => {
	const doc = `# doc\n\n${BEGIN_MARKER}\n${END_MARKER}\n`;
	const region = renderRegion(renderTable(ROWS, NOTES), { repos: 1, workflows: 2 });
	const once = spliceRegion(doc, region);
	assert.equal(spliceRegion(once, region), once);
	assert.equal(once.split(BEGIN_MARKER).length - 1, 1, 'exactly one generated region');
});

void test('a doc with no fences THROWS rather than appending beside the stale table', () => {
	assert.throws(() => spliceRegion('# doc\n\nno fences here\n', 'x'), /no generated region/);
	assert.equal(generatedRegion('# doc\n'), null);
});

// ── countTableRows (#84 part 2 — sizes the shrink floor) ────────────────────

void test('countTableRows: counts data rows, not the header or separator', () => {
	const region = renderRegion(renderTable(ROWS, NOTES), { repos: 1, workflows: 2 });
	assert.equal(countTableRows(region), 2);
});

void test('countTableRows: null or a fenceless doc is 0, never a crash', () => {
	assert.equal(countTableRows(null), 0);
	assert.equal(countTableRows(''), 0);
	assert.equal(countTableRows('# doc\n\nno table here\n'), 0);
});

// ── the end-to-end half, against a fixture tree ──────────────────────────────

/**
 * Fixture REMOTES (read through fleet-source, as the subcommand reads GitHub),
 * a manifest dir and a site root, all under one temp directory. REPOS_DIR is an
 * EMPTY directory: nothing there may matter. The remotes' git children run with
 * every GIT_* stripped, so nothing can reach the repository a hook was invoked
 * for. `ageSec` dates each repo's first commit.
 */
function fixture({ notes, repos, ageSec } = {}) {
	const remotes = fixtureRemotes('fleet-inventory-');
	const dir = remotes.root;
	const reposDir = join(dir, 'repos');
	const manifests = join(dir, 'manifests');
	const site = join(dir, 'site');
	const docDir = join(site, 'docs', 'operations');
	for (const d of [reposDir, manifests, docDir]) mkdirSync(d, { recursive: true });

	for (const [name, workflows] of Object.entries(repos ?? {})) {
		const files = {};
		for (const [file, body] of Object.entries(workflows)) files[`.github/workflows/${file}`] = body;
		remotes.push(`WolffM/${name}`, files, 'fixture', { ageSec });
	}
	writeFileSync(
		join(manifests, 'fleet-runner-coverage.json'),
		`${JSON.stringify({ repos: Object.keys(repos ?? {}).map((n) => `WolffM/${n}`), facets: {} }, null, 2)}\n`
	);
	writeFileSync(
		join(manifests, 'runner-inventory-notes.json'),
		`${JSON.stringify({ notes: notes ?? {} }, null, 2)}\n`
	);
	const doc = join(docDir, 'SELF_HOSTED_RUNNERS.md');
	writeFileSync(doc, `# runners\n\nprose above\n\n${BEGIN_MARKER}\n${END_MARKER}\n\nprose below\n`);

	const env = { ...process.env };
	for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
	Object.assign(env, {
		...remotes.env,
		REPOS_DIR: reposDir,
		FLEET_MANIFEST_DIR: manifests,
		HADOKU_SITE_ROOT: site,
		FLEET_NO_BANNER: '1',
	});
	return { dir, remotes, reposDir, manifests, site, doc, env };
}

const run = (fx, argv) =>
	spawnSync(process.execPath, [join(ROOT, 'scripts', 'fleet-inventory.mjs'), ...argv], {
		env: fx.env,
		encoding: 'utf8',
		timeout: 120_000,
	});

/** `scripts/lib/paths.mjs` re-exports the BUILT resolver, so dist must exist. */
const DIST = join(ROOT, 'dist', 'lib', 'fleet-paths.js');

const TWO_REPOS = {
	'fixture-alpha': { 'ci.yml': BARE, 'deploy.yml': LITERAL_LIST },
	'fixture-beta': { 'ci.yml': GUARDED_ONELINE },
};

void test('--write fills the region, and the operator note survives it verbatim', (t) => {
	if (!existsSync(DIST)) return t.skip('dist/lib/fleet-paths.js is not built');
	const note =
		'PM2 control on the Linux host (hokon). Timeout 20m (added 2026-06-04 — was missing; 3.5h hang).';
	const fx = fixture({
		repos: TWO_REPOS,
		notes: { 'WolffM/fixture-alpha': { 'deploy.yml': note } },
	});
	try {
		const r = run(fx, ['--write']);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const doc = readFileSync(fx.doc, 'utf8');
		assert.ok(doc.includes('prose above') && doc.includes('prose below'));
		const region = generatedRegion(doc);
		assert.ok(region.includes('`fixture-alpha`'), region);
		assert.ok(region.includes('`vars.CI_RUNNER`'), region);
		assert.ok(region.includes('`self-hosted` + `pm2-host`'), region);
		assert.ok(region.includes(note), `the note did not survive the write:\n${region}`);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('--check is 0 right after a write, and non-zero once a workflow appears', (t) => {
	if (!existsSync(DIST)) return t.skip('dist/lib/fleet-paths.js is not built');
	const fx = fixture({ repos: TWO_REPOS });
	try {
		assert.equal(run(fx, ['--write']).status, 0);
		assert.equal(run(fx, ['--check']).status, 0, 'a fresh write must be current');

		// Dated OUTSIDE the regeneration window: a fresh commit is young drift,
		// advisory by design (#103), and is covered below.
		fx.remotes.push('WolffM/fixture-beta', { '.github/workflows/publish.yml': BARE }, 'add', {
			ageSec: 40 * 3600,
		});
		const after = run(fx, ['--check']);
		assert.equal(after.status, 1, 'a workflow pushed after the write must redden the gate');
		assert.match(after.stderr, /STALE/);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('a repo we could not open FAILS, names why, and blocks the write', (t) => {
	if (!existsSync(DIST)) return t.skip('dist/lib/fleet-paths.js is not built');
	const fx = fixture({ repos: TWO_REPOS });
	try {
		assert.equal(run(fx, ['--write']).status, 0);
		const before = readFileSync(fx.doc, 'utf8');
		renameSync(fx.remotes.remote('WolffM/fixture-beta'), `${fx.dir}/beta-moved.git`);

		const r = run(fx, ['--write']);
		assert.equal(r.status, 1, 'unknown is not healthy');
		assert.match(r.stderr, /shipped workflows unreadable \(fetch from .* failed/);
		assert.match(r.stderr, /fixture-beta/);
		assert.equal(
			readFileSync(fx.doc, 'utf8'),
			before,
			'a table silently missing the repo we could not read is worse than the stale one'
		);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('a rotted note fails the gate and blocks the write', (t) => {
	if (!existsSync(DIST)) return t.skip('dist/lib/fleet-paths.js is not built');
	const fx = fixture({
		repos: TWO_REPOS,
		notes: { 'WolffM/fixture-alpha': { 'gone-away.yml': 'a workflow that was deleted' } },
	});
	try {
		const r = run(fx, ['--write']);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /gone-away\.yml/);
		assert.equal(generatedRegion(readFileSync(fx.doc, 'utf8')), `${BEGIN_MARKER}\n${END_MARKER}`);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('scanning NO repo is a failure, not a clean fleet', (t) => {
	if (!existsSync(DIST)) return t.skip('dist/lib/fleet-paths.js is not built');
	const fx = fixture({ repos: {} });
	try {
		const r = run(fx, ['--check']);
		assert.equal(r.status, 1);
		assert.match(r.stdout + r.stderr, /ZERO workflow rows/);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('--json stays a single parseable document, and carries the findings', (t) => {
	if (!existsSync(DIST)) return t.skip('dist/lib/fleet-paths.js is not built');
	const fx = fixture({ repos: TWO_REPOS });
	try {
		run(fx, ['--write']);
		const r = run(fx, ['--json', '--check']);
		const payload = JSON.parse(r.stdout);
		assert.equal(payload.ok, true);
		assert.equal(payload.workflows, 3);
		assert.equal(payload.repos, 2);
		assert.deepEqual(payload.problems, []);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

// ── #103 item 3: drift the regeneration has not reached yet ──────────────────
//
// The subject dates the newest commit to a drifted workflow off the SHIPPED
// branch's history in the reader's mirror, so each fixture push carries a date
// RELATIVE to now (fleet-source-fixture's `ageSec`).

const regionOf = (rows, notes = {}) =>
	renderRegion(renderTable(rows, notes), { repos: 1, workflows: rows.length });
const ROW = (workflow, label = '`vars.CI_RUNNER`') => ({ repo: 'WolffM/r', workflow, label });

test('#103 classifyDrift: added and relabelled rows are the only ones a commit can explain', () => {
	const disk = regionOf([ROW('a.yml'), ROW('b.yml')]);
	const next = regionOf([ROW('a.yml', '`self-hosted` + `pm2-host`'), ROW('b.yml'), ROW('c.yml')]);
	assert.deepEqual(classifyDrift(disk, next), {
		added: ['r c.yml'],
		relabelled: ['r a.yml'],
		removed: [],
		notesChanged: [],
		proseChanged: false,
	});
});

test('#103 classifyDrift: a removal, a Notes change and a prose edit are each named', () => {
	const disk = regionOf([ROW('a.yml'), ROW('b.yml')]);
	const next = regionOf([ROW('a.yml')], { 'WolffM/r': { 'a.yml': 'a new note' } });
	const d = classifyDrift(disk.replace('GENERATED by', 'HAND EDITED by'), next);
	assert.deepEqual(d.removed, ['r b.yml']);
	assert.deepEqual(d.notesChanged, ['r a.yml']);
	assert.equal(d.proseChanged, true);
});

test('#103 the window is one regeneration period plus the sync offset plus schedule lag', () => {
	assert.equal(YOUNG_DRIFT_SECONDS, 29 * 3600);
});

/** A written, current table, then one workflow added to fixture-beta `ageSec` ago. */
function driftedFixture(ageSec) {
	const fx = fixture({ repos: TWO_REPOS, ageSec: 10 * 86_400 });
	assert.equal(run(fx, ['--write']).status, 0);
	fx.remotes.push('WolffM/fixture-beta', { '.github/workflows/forge.yml': BARE }, 'forge', {
		ageSec,
	});
	return fx;
}

void test('#103: a workflow committed inside the window is ADVISORY — exit 0, never a problem', (t) => {
	if (!existsSync(DIST)) return t.skip('dist/lib/fleet-paths.js is not built');
	const fx = driftedFixture(3 * 3600);
	try {
		const r = run(fx, ['--check', '--json']);
		const payload = JSON.parse(r.stdout);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(payload.problems, []);
		assert.equal(payload.stale, true);
		assert.equal(payload.advisory.length, 1);
		assert.match(payload.advisory[0], /WolffM\/fixture-beta forge\.yml: added 3\.0h ago/);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('#103: the same drift committed BEFORE the window still fails, and says how old', (t) => {
	if (!existsSync(DIST)) return t.skip('dist/lib/fleet-paths.js is not built');
	const fx = driftedFixture(40 * 3600);
	try {
		const r = run(fx, ['--check']);
		assert.equal(r.status, 1);
		assert.match(
			r.stderr,
			/forge\.yml: changed 40\.0h ago, older than the 29h regeneration window/
		);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('#103: young drift beside a REMOVAL still fails — a removal is never the schedule', (t) => {
	if (!existsSync(DIST)) return t.skip('dist/lib/fleet-paths.js is not built');
	const fx = driftedFixture(3 * 3600);
	try {
		fx.remotes.push('WolffM/fixture-alpha', { '.github/workflows/deploy.yml': null });
		const r = run(fx, ['--check']);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /removed: fixture-alpha deploy\.yml/);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

// ── the shrink floor (#84 part 2) ───────────────────────────────────────────
//
// Distinct from "a repo we could not open FAILS" above: THAT guard trips on an
// unreadable repo. This one trips when the ROSTER ITSELF shrinks drastically
// with every remaining repo still perfectly readable — a `--write-coverage`
// gone wrong upstream.

void test('--write refuses a drastic roster shrink, and the doc is left byte-identical', (t) => {
	if (!existsSync(DIST)) return t.skip('dist/lib/fleet-paths.js is not built');
	const fx = fixture({ repos: TWO_REPOS });
	try {
		assert.equal(run(fx, ['--write']).status, 0);
		const before = readFileSync(fx.doc, 'utf8');

		// The roster shrinks from 2 repos (3 workflow rows) to 1 (1 row) — well
		// below half — while fixture-beta is untouched and perfectly readable. No
		// "unreadable" finding fires; only the shrink floor should.
		writeFileSync(
			join(fx.manifests, 'fleet-runner-coverage.json'),
			`${JSON.stringify({ repos: ['WolffM/fixture-beta'], facets: {} }, null, 2)}\n`
		);

		const r = run(fx, ['--write']);
		assert.equal(r.status, 1, 'a 3 -> 1 row shrink must refuse the write');
		assert.match(r.stderr, /refusing to write/);
		assert.match(r.stderr, /1 of 3 previous entries/);
		assert.equal(
			readFileSync(fx.doc, 'utf8'),
			before,
			'a refused write must leave the doc byte-identical, not degraded'
		);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('--write --allow-shrink lands the same drastic shrink on purpose', (t) => {
	if (!existsSync(DIST)) return t.skip('dist/lib/fleet-paths.js is not built');
	const fx = fixture({ repos: TWO_REPOS });
	try {
		assert.equal(run(fx, ['--write']).status, 0);
		writeFileSync(
			join(fx.manifests, 'fleet-runner-coverage.json'),
			`${JSON.stringify({ repos: ['WolffM/fixture-beta'], facets: {} }, null, 2)}\n`
		);
		const r = run(fx, ['--write', '--allow-shrink']);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const region = generatedRegion(readFileSync(fx.doc, 'utf8'));
		assert.ok(!region.includes('fixture-alpha'), region);
		assert.ok(region.includes('fixture-beta'), region);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

/**
 * fleet-manager#7: A LOCAL CLONE CANNOT CHANGE THE TABLE. The baseline has
 * clones under REPOS_DIR that MATCH the shipped branches, so a subcommand that
 * read them would write the same table. Then they go CRLF, keep a workflow the
 * remote never had, and carry an uncommitted relabel — and `--check` must stay
 * current. Revert the subcommand to reading REPOS_DIR and it reports STALE.
 */
void test('#7: a CRLF, stale, dirty clone under REPOS_DIR does not change the table', (t) => {
	if (!existsSync(DIST)) return t.skip('dist/lib/fleet-paths.js is not built');
	const fx = fixture({ repos: TWO_REPOS });
	const filesOf = (name) =>
		Object.fromEntries(
			Object.entries(TWO_REPOS[name]).map(([f, b]) => [`.github/workflows/${f}`, b])
		);
	try {
		for (const name of Object.keys(TWO_REPOS)) {
			poisonedClone(fx.reposDir, `WolffM/${name}`, filesOf(name));
		}
		assert.equal(run(fx, ['--write']).status, 0);
		const written = readFileSync(fx.doc, 'utf8');
		assert.equal(run(fx, ['--check']).status, 0, 'a fresh write must be current');

		for (const name of Object.keys(TWO_REPOS)) {
			rmSync(join(fx.reposDir, name), { recursive: true, force: true });
		}
		poisonedClone(
			fx.reposDir,
			'WolffM/fixture-alpha',
			{ ...filesOf('fixture-alpha'), '.github/workflows/stale.yml': BARE },
			{ crlf: true }
		);
		poisonedClone(fx.reposDir, 'WolffM/fixture-beta', filesOf('fixture-beta'), {
			edit: { '.github/workflows/ci.yml': LITERAL_LIST },
		});
		const after = run(fx, ['--check']);
		assert.equal(after.status, 0, after.stdout + after.stderr);
		assert.equal(run(fx, ['--write']).status, 0);
		assert.equal(readFileSync(fx.doc, 'utf8'), written, 'the table moved');
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});
