#!/usr/bin/env node
/**
 * check-tool-inventory — a workflow may not invoke a tool the nodes it can
 * land on do not have, unless it provides that tool itself.
 *
 * Workstream C4. The plan's premise was that the fleet's real tool inventory is
 * invisible because `command -v` guards barely exist — three across every
 * workflow in every repo. That count is right and the conclusion drawn from it
 * was too strong: measured 2026-08-27, the workflows that genuinely need a tool
 * the claws lack SELF-INSTALL it (hadoku-watchparty/deploy.yml installs rustup,
 * which brings cargo, and trunk), and the rest either run hosted or target the
 * one node that has the tool. The fleet is currently clean.
 *
 * So this gate is not cleaning up a mess; it is stopping the NEXT one. The
 * failure it prevents is silent and node-dependent: a job that passes on
 * whichever runner happens to have the binary and dies on the others, which
 * reads as flakiness rather than as a missing dependency (P4).
 *
 * WHAT COUNTS AS PROVIDING A TOOL
 *   - present on every node the workflow's `runs-on` can select, or
 *   - a `command -v` / `which` guard anywhere in the same workflow, or
 *   - an install of it in the same workflow (rustup brings cargo, etc.), or
 *   - the workflow runs hosted, where the image supplies it.
 *
 * P2.2 — THE DEMAND LEDGER (`--write [path]`)
 * ---------------------------------------------
 * Alongside the missing-tool gate above, this scan already walks every job in
 * every covered repo's workflows — `bootcamp-earned-labels-2026-09-02.md` §4
 * needs exactly that same scrape to derive what a repo REQUIRES, and today
 * nothing records it. `--write` emits one JSONL record per (repo, job) —
 * capabilities asked for (derived, never declared, from the same signals
 * bootcamp's design names: a setup-python step implies `python-toolcache`, a
 * playwright step implies `playwright`), the labels the job's `runs-on`
 * resolves to, and the `uses:` actions it invokes. THE UNIT IS THE JOB, not
 * the workflow step or the whole file — two jobs in one workflow can ask for
 * different things (`deploy-workers.yml`'s `detect-changes` runs hosted, its
 * `deploy` runs on the fleet), and the demand ledger has to tell them apart.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadManifest, runOn, selectNodes } from './lib/fleet-exec.mjs';
import { manifest as manifestFile, siteRoot, stateDir } from './lib/paths.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import {
	splitJobs,
	deriveCapabilities,
	deriveSetupActions,
	deriveLabels,
	deriveJobName,
	mergeDemandLedger,
	capabilityRetirements,
} from './lib/demand-derive.mjs';
import { CI_DEMAND_CLASS, provenCapabilities } from '../dist/capabilities.js';

const ROOT = siteRoot();
const COVERAGE = manifestFile('fleet-runner-coverage.json');

/**
 * Tools worth checking. Deliberately a list rather than "every first token":
 * a naive scan of `run:` blocks returns `echo`, `if`, `exit`, `const` and `let`
 * — shell keywords and JavaScript — and drowns the signal completely.
 */
const TOOLS = [
	'pnpm',
	'node',
	'corepack',
	'git',
	'curl',
	'gh',
	'python3',
	'jq',
	'bash',
	'cargo',
	'ffmpeg',
	'docker',
	'unzip',
	'trunk',
	'rustup',
	'pm2',
	'rsync',
	'tar',
	'sqlite3',
	'uv',
	// P3.4/P1.6: hadoku-pygmalion's CI installs via `python -m pip install`, and
	// nothing anywhere probed for it — both node profiles in
	// manifests/node-profiles.json already DECLARE `python3-pip`, but bootstrap
	// only ever runs at enrollment, so claw-1 and claw-2 drifted from that
	// declaration and had no pip on PATH regardless. `capabilities.ts`'s
	// `python-pip` probe (§P) is the thing that will catch this drifting back;
	// this entry is what makes the drift visible in the meantime.
	'pip',
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does this job's text RUN `t` as a command? Word-delimited on both sides.
 *
 * A quoted `echo`/`printf` argument is PROSE printed to the log, not a command:
 * hadoku-watchparty's deploy job prints "Recovery: pm2 reset watchparty" for
 * the operator, and once the scan went per job (#98) that line was read as a
 * `pm2` invocation on a claw. The quoted argument is dropped; anything after
 * it on the line (`echo "x" && pm2 ...`) is still scanned.
 */
function invokes(jobText, t) {
	const text = jobText.replace(/\b(echo|printf)\s+(["'])(?:(?!\2)[^\n])*\2/g, '$1');
	return new RegExp(`(^|[\\s;&|("'\`])${escapeRe(t)}[\\s]`, 'm').test(text);
}

/**
 * Does this job provide `t` itself — a guard, its own install, or a release
 * download OF THAT TOOL? Read off ONE job's text (#98).
 *
 * Each pattern names the tool as a WHOLE WORD. `install .*${t}` used to match
 * `install -g pnpm` for `pnpm`, but also `install` anywhere before `gh` inside
 * `highlight`, and an unescaped `${t}.rs` read `.` as any character. A
 * `releases/download` URL counts only when the URL names the tool: a job that
 * downloads `trunk` has not thereby provided `jq`.
 */
function providesTool(jobText, t) {
	const w = `\\b${escapeRe(t)}\\b`;
	if (new RegExp(`(command -v|which)\\s+${w}`).test(jobText)) return true;
	if (new RegExp(`\\binstall\\b[^\\n]*${w}`).test(jobText)) return true;
	if (new RegExp(`${w}(\\.rs|-rs)\\b`).test(jobText)) return true;
	for (const url of jobText.match(/\S*releases\/download\S*/g) ?? []) {
		if (new RegExp(w).test(url)) return true;
	}
	// rustup installs cargo.
	return t === 'cargo' && /command -v rustup|rustup\.rs/.test(jobText);
}

const WRITE_LEDGER = process.argv.includes('--write');
function writeFlagValue() {
	const i = process.argv.indexOf('--write');
	const next = i >= 0 ? process.argv[i + 1] : undefined;
	return next && !next.startsWith('--') ? next : join(stateDir(), 'demand-ledger.jsonl');
}

function reposDir() {
	if (process.env.REPOS_DIR) return process.env.REPOS_DIR;
	try {
		const common = execFileSync(
			'git',
			['rev-parse', '--path-format=absolute', '--git-common-dir'],
			{
				cwd: ROOT,
				encoding: 'utf8',
			}
		).trim();
		return dirname(dirname(common));
	} catch {
		return resolve(ROOT, '..');
	}
}

async function probe(node, tools) {
	const script = tools
		.map(
			(t) =>
				`printf '%s\\t%s\\n' "${t}" "$(command -v ${t} >/dev/null 2>&1 && echo yes || echo no)"`
		)
		.join('\n');
	const r = await runOn(node, script, { timeoutMs: 60_000 });
	if (!r.ok && !r.stdout) return null;
	const have = new Set();
	for (const l of r.stdout.split('\n')) {
		const [t, ok] = l.trim().split('\t');
		if (ok === 'yes') have.add(t);
	}
	return have;
}

/**
 * A GUEST IS NOT PROBED, AND THE SKIP IS PRINTED.
 *
 * The question is which tools a CI JOB will find when it lands — and a guest is
 * never a landing site for general CI work, so `command -v` on it answers a
 * question nobody asked. It also lends the fleet a registration and nothing else
 * (operator, 2026-09-14), which makes even a read-only `command -v` sweep the
 * fleet chain reaching onto a box it was told to leave alone. `selectNodes` is
 * the role-aware door and returns what it refused, so the refusal is reportable.
 */
const manifest = loadManifest();
const { nodes: selectedNodes, skippedByRole } = selectNodes(manifest);
const nodes = selectedNodes.map(([name]) => name);
const present = {};
const unreachable = [];
await Promise.all(
	nodes.map(async (m) => {
		const have = await probe(m, TOOLS);
		if (have === null) unreachable.push(m);
		else present[m] = have;
	})
);

// A node a human powered off is EXPECTED down. It is still PRINTED, and its
// tools are still unread — the deferral suppresses the failure, never the
// evidence, and expires after DEFER_DAYS. See lib/expected-down.mjs.
const _drains = readDrains();
const expectedDown = unreachable.filter((n) => deferralFor(n, _drains).deferred);
const trulyUnreachable = unreachable.filter((n) => !deferralFor(n, _drains).deferred);

// Claws are what a `hadoku-builder` job can land on; anything else is targeted.
//
// This was `nodes` minus anything carrying the `pm2-host` LABEL, which was exact
// only while one machine carried that label and stopped being exact the day
// Wave 3d made `pm2-host` an EARNED capability a claw can probe into — a claw
// that earned it would have dropped out of the CI set for a reason that has
// nothing to do with CI. The exclusion it was standing in for is the ROLE, and
// `selectNodes` above has already applied it, so this is now the same list.
const clawSet = nodes;

/**
 * §B (wave 3y, corrected 2026-10-05): "proven by the general pool" means
 * EARNED BY A NODE, never DEMANDED BY A JOB. `requiredIdentitySet` answers a
 * different question — what jobs on the general pool ASK for — and reading
 * it as "what the pool proves" would let the floor's own demand stand in as
 * its own evidence: the verifier-reads-its-own-writer trap CLAUDE.md names,
 * just moved from a cgroup reader to a capability one. `provenCapabilities`
 * reads each node's bootcamp facet from the MANIFEST instead — no probe, no
 * ssh, no job text.
 *
 * `selectedNodes` is already the guest-excluded general pool (`selectNodes`
 * above applied the role gate), so no second guest filter is needed here.
 *
 * A node bootcamp has never reached (`provenCapabilities` returns `null`)
 * proves NOTHING — it is counted in `poolUnprobedCount` and reported as a
 * caveat below, never silently read as proof it has everything.
 */
const poolProvenBy = new Map();
let poolUnprobedCount = 0;
for (const [name, node] of selectedNodes) {
	const proven = provenCapabilities(node);
	if (proven === null) {
		poolUnprobedCount++;
		continue;
	}
	for (const c of proven) {
		if (!poolProvenBy.has(c)) poolProvenBy.set(c, new Set());
		poolProvenBy.get(c).add(name);
	}
}

/**
 * Only nodes we actually READ inform this answer.
 *
 * `clawSet.every((m) => present[m]?.has(t))` treated an unreachable node as
 * one MISSING EVERY TOOL: `present[m]` is undefined, `?.has()` is undefined, and
 * `every` goes false. With claw-1 down on 2026-08-29 that produced **340
 * findings**, every one false, and they buried the single real one.
 *
 * "I could not look" is not "it is not there" — the same trap check-identity-model
 * names for missing checkouts. The unreachable node is still reported, and
 * still fails the run, on its own terms below.
 */
const readable = clawSet.filter((m) => present[m]);
const onAllClaws = (t) => readable.length > 0 && readable.every((m) => present[m].has(t));

const REPOS_DIR = reposDir();
const coverage = JSON.parse(readFileSync(COVERAGE, 'utf8'));
/** dir -> "WolffM/repo", for the demand ledger's `repo` field. Built before the
 * dedupe below so ROOT — which `siteRoot()` always resolves to hadoku_site's
 * own checkout, never this package's — gets the right name if it is not also
 * covered.repos' own hadoku_site entry (it is, today; see the dedupe note). */
const repoNameByDir = new Map([[ROOT, 'WolffM/hadoku_site']]);
for (const r of coverage.repos ?? []) repoNameByDir.set(join(REPOS_DIR, r.split('/').pop()), r);
// DEDUPED BY REPO NAME, NOT BY PATH (wave 3y, 2026-10-05 — the path-keyed `Set`
// below this comment used to live here, and it only deduped hadoku_site when
// `ROOT` and `join(REPOS_DIR, 'hadoku_site')` happened to be the SAME STRING).
// `ROOT` (`siteRoot()`) and `REPOS_DIR/hadoku_site` are the same REPO but need
// not be the same PATH — in production, run the way mgmt-api's audit-gates
// runs it (`cwd=~/srv/hadoku_site`, `REPOS_DIR=~/repos`), `siteRoot()`
// resolves to the DEPLOYED checkout `~/srv/hadoku_site` while
// `REPOS_DIR/hadoku_site` is the sibling DEVELOPMENT checkout
// `~/repos/hadoku_site` — two real, different directories holding the same
// repo. A path-keyed `Set` cannot see that they name the same thing, so every
// hadoku_site workflow was scanned TWICE in production: `examined` inflated,
// and a production `--write` carried a duplicate ledger row per hadoku_site
// job (found 2026-10-05: the pinned-demand report printed
// `WolffM/hadoku_site / run` twice).
//
// ROOT WINS for hadoku_site. Every other manifest-derived input this gate
// reads (`COVERAGE` via `manifestFile()`, and `FLEET_MANIFEST_DIR`'s own
// default) already resolves off `siteRoot()`, so keeping ROOT as hadoku_site's
// one canonical checkout keeps the whole gate reading ONE tree for it — the
// DEPLOYED tree in production, never a sibling development checkout that may
// be ahead of or behind it. `ROOT` is listed FIRST below, so its name is the
// one `seenRepoNames` records and `REPOS_DIR/hadoku_site` loses the race.
//
// This also generalises past the one known collision: ANY two coverage
// entries that resolved to the same repo NAME (not just hadoku_site) would
// have hit the identical bug, and a name-keyed dedupe fixes all of them, not
// just this one.
const seenRepoNames = new Set();
const dirs = [];
for (const dir of [
	ROOT,
	...(coverage.repos ?? []).map((r) => join(REPOS_DIR, r.split('/').pop())),
]) {
	const name = repoNameByDir.get(dir) ?? relative(REPOS_DIR, dir);
	if (seenRepoNames.has(name)) continue;
	seenRepoNames.add(name);
	dirs.push(dir);
}
/** Workflows this gate actually INSPECTED. A pass with a low count is a pass
 * over nothing — the shape that hid `gh` for three days. */
let examined = 0;
/** Jobs inside those workflows that target a self-hosted node. */
let examinedJobs = 0;
const findings = [];
// AN EMPTY ROSTER SCANS ONLY THE SITE (#98), and a site with one self-hosted
// workflow is enough to clear the zero-inspected check below. The coverage
// file is generated; a roster of zero is a failed generation, not a fleet.
if (!(coverage.repos ?? []).length) {
	findings.push(
		`${COVERAGE} lists no covered repos — only the site checkout was scanned. Regenerate it ` +
			'with `fleet reconcile --write-coverage`.'
	);
}
/** P2.2: one (repo, job) demand record, collected only when --write is passed. */
const demandLedger = [];
let demandFiles = 0;
/** How many covered repos this run could not even look at (P3.4 item 3). Read
 * further down, where it gates whether the capability-retirement comparison
 * runs at all. */
let noCheckoutCount = 0;
/** capability -> the repos this run found actually asking for it, on the
 * claw fleet (never a pm2-host — see the `fleetDemand` gate below). Built
 * unconditionally, not just under `--write`, because P3.4's retirement check
 * needs it on every run of the gate, not only when the demand ledger is
 * being written. */
const capabilityRepos = new Map();
/** §B: jobs pinned to one machine (`selfHosted && !fleetForm`) or hosted —
 * demand `requiredIdentitySet` correctly excludes from the floor, but that
 * is real demand recorded nowhere anyone reads until now. One entry per job
 * that invokes at least one tracked capability. */
const pinnedDemand = [];

for (const dir of dirs) {
	// A covered repo with no local checkout could not be inspected AT ALL —
	// that is "I could not look", never "nothing to invoke here". The test is
	// the repo's own `.git`, not the `.github/workflows` dir it may
	// legitimately lack: a real checkout with no workflows genuinely needs no
	// tools, but a repo never cloned here tells us nothing either way. This
	// used to be `if (!existsSync(wf)) continue` — one line that could not
	// tell those two states apart, so a covered repo missing its checkout
	// silently read as a clean pass (docs/planning/tier-assignment-2026-09-03.md
	// §8, wave1-2026-09-08.md §T item 3).
	if (!existsSync(join(dir, '.git'))) {
		noCheckoutCount++;
		findings.push(
			`${repoNameByDir.get(dir) ?? dir}: no local checkout at ${dir} — its workflows could not ` +
				`be inspected for tool or capability use here. Unreadable is not clean.`
		);
		continue;
	}
	const wf = join(dir, '.github', 'workflows');
	if (!existsSync(wf)) continue;
	for (const file of readdirSync(wf)) {
		if (!/\.ya?ml$/.test(file)) continue;
		const raw = readFileSync(join(wf, file), 'utf8');
		// STRIP COMMENTS BEFORE MATCHING. A tool name in prose is not an
		// invocation, and this fleet's workflows are heavily commented: the first
		// run of this gate reported six pm2 "invocations" that were all sentences
		// like "the pm2 redeploy happens only after..." and "tenhands is two pm2
		// services". §10 of the plan already records this exact trap from a
		// `which [a-z]+` scan that matched "which is the...".
		const text = raw
			.split('\n')
			// Comments are prose, and so are step names. Both mention tools
			// constantly in this fleet and neither is ever executed. Dropping only
			// comments still left `- name: Trigger hadoku_site to redeploy both pm2
			// services` reading as a pm2 invocation.
			.filter((l) => !/^\s*#/.test(l) && !/^\s*-?\s*(name|description):/.test(l))
			.join('\n');
		const rel = relative(REPOS_DIR, join(wf, file));

		// P2.2's job split, and the capability-retirement tracker built on top of
		// it (P3.4), now run on EVERY file — not just under `--write`. The
		// demand-ledger RECORD is still only appended under `--write` (below); the
		// per-job split itself is cheap, and retirement needs the same per-JOB
		// view the ledger does (deriveCapabilities on a whole file over-counts a
		// hosted-and-self-hosted mix as one bag).
		const jobs = splitJobs(text);
		// A SECOND SPLIT, off text that still has its `name:` lines.
		// `text` above drops every `name:` on purpose — a step called "Trigger
		// hadoku_site to redeploy both pm2 services" is not a pm2 invocation — and
		// the job's DISPLAYED name is the demand ledger's join key (settled
		// 2026-09-10). So the tool scan keeps the stripped text and the key is read
		// off a text that only lost its comments.
		const namedJobs = new Map(
			splitJobs(
				raw
					.split('\n')
					.filter((l) => !/^\s*#/.test(l))
					.join('\n')
			).map((j) => [j.id, j.text])
		);
		if (WRITE_LEDGER) {
			demandFiles++;
			if (!jobs.length) {
				// Every real workflow has a `jobs:` key with at least one job. Zero
				// back is the SAME "examined 10 of 111" failure mode this file is
				// named for elsewhere — a parsing assumption silently not holding —
				// so it is a finding, not a skip.
				findings.push(
					`${rel}: the demand ledger found ZERO jobs in it — the 2-space job-` +
						`indent assumption (P2.2) does not hold for this file, so it is ` +
						`invisible to the demand ledger rather than reporting nothing to ask for.`
				);
			}
		}
		const repoName = repoNameByDir.get(dir) ?? relative(REPOS_DIR, dir);
		for (const j of jobs) {
			const { runsOn: jobRunsOn, fleetForm, selfHosted, hosted, explicit } = deriveLabels(j.text);
			const capabilities = deriveCapabilities(j.text);
			// Retirement means something only for demand ON THE CLAW FLEET — a hosted
			// job's ffmpeg use says nothing about whether a claw still needs to prove
			// it, and a pm2-host job runs on production, never a claw bootcamp would
			// probe.
			if ((fleetForm || selfHosted) && !explicit.includes('pm2-host')) {
				for (const c of capabilities) {
					if (!capabilityRepos.has(c)) capabilityRepos.set(c, new Set());
					capabilityRepos.get(c).add(repoName);
				}
			}
			// `job` stays the job ID for compatibility — `floor-probe.mjs`'s
			// `demandFor(repo, job)` keys on it — and `jobName` is the join key
			// job history actually carries. Both, never one: the ID is what the
			// workflow author edits and the NAME is what GitHub reports, and the
			// ledger is the only place the two are written down together.
			//
			// Computed UNCONDITIONALLY (not just under --write): the pinned-demand
			// report below wants the same join key the ledger does, on every run.
			const { jobName, jobNameSource, unjoinable } = deriveJobName(
				j.id,
				namedJobs.get(j.id) ?? j.text
			);
			// §B: a job pinned to one machine, or hosted entirely, is excluded from
			// `requiredIdentitySet` on purpose — raising the fleet-wide floor with a
			// job no claw will ever receive is wrong. But its demand is real, and
			// today nothing records it. Collected unconditionally — same reasoning
			// `capabilityRepos` above already follows for the retirement check —
			// and printed below, EVERY capability marked against what the pool has
			// actually EARNED (`poolProvenBy`), never filtered out of the report.
			if ((hosted || (selfHosted && !fleetForm)) && capabilities.length) {
				pinnedDemand.push({
					repo: repoName,
					job: jobName ?? j.id,
					kind: hosted ? 'hosted' : 'pinned',
					labels: explicit,
					capabilities,
				});
			}
			if (!WRITE_LEDGER) continue;
			demandLedger.push({
				class: CI_DEMAND_CLASS,
				repo: repoName,
				job: j.id,
				jobId: j.id,
				jobName,
				jobNameSource,
				...(unjoinable ? { unjoinable } : {}),
				workflow: rel,
				runsOn: jobRunsOn,
				fleetForm,
				selfHosted,
				hosted,
				labels: explicit,
				capabilities,
				setupActions: deriveSetupActions(j.text),
			});
		}

		// PER JOB, NOT PER FILE (#98). This decided once for the whole workflow:
		// ONE `pm2-host` job anywhere exempted every claw job beside it, a guard
		// or install in one job covered every other job (each job is a fresh
		// runner — a tool installed in `deploy` is not on the box `test` lands
		// on), and a `releases/download` URL for ANY tool exempted EVERY tool.
		//
		// THE FLEET FORM IS NOT THE LITERAL STRING. `runs-on` on a covered repo is
		// bare `${{ fromJSON(vars.CI_RUNNER) }}`, which RESOLVES to
		// ["self-hosted","hadoku-builder"] at run time and contains the word
		// "self-hosted" nowhere in the file. Matching the literal therefore skipped
		// every workflow this gate exists for: measured 2026-09-07, 10 of 111
		// self-hosted workflows were examined and 101 were invisible, so it printed
		// a clean bill over 9% of the fleet. That is not hypothetical either: `gh`
		// was absent from claw-4/5/6 from their 2026-09-02 enrolment until
		// 2026-09-05, and four repos failed a fan-out on `gh: command not found`.
		// `deriveLabels` holds that rule now, fork-PR guard form included — it
		// names both, and lands on a claw for nearly every push.
		let fileInspected = false;
		for (const j of jobs) {
			const { runsOn, selfHosted, hosted } = deriveLabels(j.text);
			// Hosted images carry the toolchain; only self-hosted targets are at risk.
			if (hosted || !selfHosted) continue;
			fileInspected = true;
			examinedJobs++;
			// A job pinned to pm2-host lands on the production host only.
			if (/pm2-host/.test(runsOn)) continue;
			for (const t of TOOLS) {
				if (onAllClaws(t)) continue;
				if (!invokes(j.text, t)) continue;
				if (providesTool(j.text, t)) continue;
				findings.push(
					`${rel}:${j.id}: invokes "${t}", which is missing on ${clawSet.filter((m) => !present[m]?.has(t)).join(', ')} — ` +
						`and the job neither guards nor installs it. The job will pass on whichever runner ` +
						`happens to have it and die on the others, which reads as flakiness (P4).`
				);
			}
		}
		if (fileInspected) examined++;
	}
}

for (const u of trulyUnreachable)
	console.error(
		`  ! unreachable, tools unread: ${u} — reported ONCE, not as a node missing every tool`
	);
for (const u of expectedDown)
	console.log(`  · ${deferralNote(u, deferralFor(u, _drains))} — tools unread`);
// ZERO INSPECTED IS A FAILURE, NOT A PASS. This gate reported clean for months
// while matching a literal `self-hosted` that the fleet form never contains; the
// count is what makes the verdict readable as evidence rather than as silence.
if (!examined) {
	findings.push(
		'no self-hosted workflow was inspected at all — the roster, the checkouts or the ' +
			'`runs-on` match is broken. A gate that looked at nothing cannot report nothing wrong.'
	);
}
if (findings.length) {
	console.error(`✗ tool inventory (${findings.length}):`);
	for (const f of findings) console.error(`  ${f}`);
}
for (const s of skippedByRole) {
	console.log(`  · ${s.node} [skipped: guest] — ${s.why}`);
}
if (!findings.length && !trulyUnreachable.length) {
	console.log(
		`✓ ${examined} self-hosted workflow(s) (${examinedJobs} job(s)) inspected across ${clawSet.length} node(s): ` +
			`every tool invoked is present, guarded, or installed by the workflow` +
			(skippedByRole.length ? ` (${skippedByRole.length} guest(s) skipped by role)` : '') +
			(expectedDown.length ? ` (${expectedDown.length} expected down)` : '')
	);
}

if (WRITE_LEDGER) {
	const path = writeFlagValue();
	// PRESERVE, never truncate. Resident demand (`fleet service-inventory
	// --write`) lives in this same file under `class: "resident"` so the claw
	// floor reads ONE ledger; a blind rewrite of this script's own rows deleted
	// measurements taken from another box's kernel. See `mergeDemandLedger`.
	let existing = '';
	try {
		existing = readFileSync(path, 'utf8');
	} catch (err) {
		// ENOENT is the first run; anything else is a file we cannot read, and
		// rewriting one of those would discard rows we never saw.
		if (err.code !== 'ENOENT') throw err;
	}
	const merged = mergeDemandLedger(existing, demandLedger);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, merged.text);
	console.log(
		`\nP2.2 demand ledger: ${merged.written} class:${CI_DEMAND_CLASS} (repo, job) record(s) across ` +
			`${demandFiles} workflow file(s) -> ${path}` +
			`\n  ${merged.preserved} row(s) of another class preserved unchanged` +
			`\n  joinable on jobName: ${demandLedger.filter((r) => r.jobName).length} of ` +
			`${demandLedger.length}; ${demandLedger.filter((r) => r.unjoinable).length} unjoinable ` +
			`(job name is an expression)`
	);
}

// --- capability retirement (P3.4 item 3) ------------------------------------
// A retirement finding says a capability's LAST repo dropped it. It never
// fails the gate — no consumer acts on it automatically — it is a heads-up
// for §P's capability registry to consider dropping the probe. It is computed
// and persisted ONLY on a run that could check out every covered repo: a repo
// this run could not look at must never read as "no longer needs it" — the
// exact "I could not look" ≠ "nothing is wrong" trap the no-checkout finding
// above exists to catch, just applied to a capability's demand instead of a
// node's health. An incomplete run leaves the persisted snapshot untouched so
// the next COMPLETE run still has something real to compare against.
const CAPABILITY_STATE_PATH = join(stateDir(), 'tool-inventory-capabilities.json');
const checkoutsComplete = noCheckoutCount === 0;
let previousCapabilities = {};
/** Set when a state file EXISTS and could not be read — never on a first run. */
let previousStateError = null;
try {
	previousCapabilities = JSON.parse(readFileSync(CAPABILITY_STATE_PATH, 'utf8'));
	if (!previousCapabilities || typeof previousCapabilities !== 'object') {
		throw new Error('not a JSON object');
	}
} catch (err) {
	// ENOENT is a first run and has no history to compare. Anything else is a
	// file that exists and could not be read — and comparing against `{}` would
	// report "no retirements" having compared against nothing.
	previousCapabilities = {};
	if (err.code !== 'ENOENT') previousStateError = String(err.message ?? err);
}
if (previousStateError) {
	console.error(
		`\n  ! could not read previous capability state at ${CAPABILITY_STATE_PATH} ` +
			`(${previousStateError}) — retirement is NOT compared this run; this run's snapshot ` +
			`replaces it as a new baseline.`
	);
}
if (checkoutsComplete) {
	const retirements = capabilityRetirements(previousCapabilities, capabilityRepos);
	if (previousStateError) {
		console.log(
			'\nretirement: not compared — the previous capability state was unreadable (above).'
		);
	} else if (retirements.length) {
		console.log(`\nretirement (${retirements.length}):`);
		for (const r of retirements) console.log(`  ${r}`);
	} else {
		console.log(
			'\nretirement: none this run — every capability last on record still has a repo asking for it.'
		);
	}
	const snapshot = Object.fromEntries(
		[...capabilityRepos].map(([cap, repos]) => [cap, [...repos].sort()])
	);
	try {
		mkdirSync(dirname(CAPABILITY_STATE_PATH), { recursive: true });
		writeFileSync(CAPABILITY_STATE_PATH, JSON.stringify(snapshot, null, 2) + '\n');
	} catch (e) {
		console.error(
			`  ! could not persist capability state to ${CAPABILITY_STATE_PATH}: ${e.message}`
		);
	}
} else {
	console.log(
		`\nretirement: skipped — ${noCheckoutCount} covered repo(s) had no local checkout this run, ` +
			`so their capability use could not be reconfirmed. Retiring off an incomplete view would be ` +
			`the same "I could not look" ≠ "nothing needs it" mistake, just about a capability instead ` +
			`of a node.`
	);
}

// --- pinned/hosted demand (§B, wave 3y) -------------------------------------
//
// A job pinned to one machine (`selfHosted && !fleetForm`) or hosted entirely
// is correctly excluded from `requiredIdentitySet` — raising the fleet-wide
// floor with a job no claw will ever receive is wrong. But that demand is
// real, and until now it was recorded nowhere anyone reads: the live ledger
// holds pinned or hosted demand for docker, playwright, ffmpeg and
// python-toolcache that no report shows, and cardtable's forge jobs ask for a
// `jdk21` nothing anywhere named (they never call `java` themselves — the
// server they start spawns it from `CARDTABLE_FORGE_JAR`, a `.jar` path).
//
// EVERY capability a pinned/hosted job uses is printed, marked against
// `poolProvenBy` — NEVER filtered down to an "unproven" subset. Filtering
// first is what hid the actual finding: a capability only reads as "already
// covered" once a real node has EARNED it, and this section exists
// specifically to show the gap when none has (cardtable's `jdk21`, today).
//
// OPERATOR-ONLY, ADVISORY: this never adds to `findings` and never affects
// the exit code.
//
// ADDITIVE if `--json` is ever added to this subcommand: `tool-inventory` has
// no `--json` mode today (absent from `scripts/lib/json-contract.mjs`'s
// JSON_CONTRACT — no cron parses this subcommand's stdout), so this is prose
// only. A future `--json` must carry this as a NEW key, never replace one.
const pinnedLines = [];
for (const p of pinnedDemand) {
	const marked = p.capabilities.map((c) => {
		const earners = [...(poolProvenBy.get(c) ?? [])].sort();
		return earners.length ? `${c} (${earners.join(', ')})` : `${c} (earned by no pool node)`;
	});
	pinnedLines.push(
		`  ${p.repo} / ${p.job} [${p.kind}${p.labels.length ? ': ' + p.labels.join(', ') : ''}]: ` +
			marked.join(', ')
	);
}
if (pinnedLines.length) {
	console.log(`\npinned jobs and what moving them would need (${pinnedLines.length}):`);
	for (const l of pinnedLines) console.log(l);
} else {
	console.log(
		'\npinned jobs and what moving them would need: none — no pinned or hosted job invokes ' +
			'a capability this scan tracks.'
	);
}
// A node bootcamp has never reached proves NOTHING — said explicitly, so the
// earners named above never read as the WHOLE pool having been checked.
if (poolUnprobedCount) {
	console.log(
		`  ! ${poolUnprobedCount} general-pool node(s) have no bootcamp record at all — counted ` +
			`as having proven nothing, never as proof they have it.`
	);
}

process.exit(findings.length || trulyUnreachable.length ? 1 : 0);
