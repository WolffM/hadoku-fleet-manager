/**
 * Derive the CI-alerting watch list from the fleet roster.
 *
 * `CRITICAL_WORKFLOWS` lived hand-written inside monitoring-api. Nothing tied
 * it to the roster, so a repo joining the fleet was watched only if somebody
 * remembered — and hadoku-fleet-manager, the package that decides where every
 * repo's CI runs, sat unwatched from the day it was extracted. Same shape as
 * the gate lists before check:gate-coverage: a list that cannot be wrong
 * because nothing compares it to anything.
 *
 * MEMBERSHIP IS DERIVED, SELECTION IS DECLARED.
 *
 * The roster answers "which repos". It cannot answer "which workflows matter",
 * because that is a judgement — so the convention below is explicit and the
 * exceptions live in a policy file rather than in a maintainer's head:
 *
 *   watched   the GATE (ci/test/typecheck) and the SHIP PATH (publish/deploy/
 *             redeploy). A red one means either broken code merged or good
 *             code not shipping.
 *   ignored   the bots — update-wolffm, vibecheck, vibecompact. These fail for
 *             their own reasons, self-heal, and paging on them is how an alert
 *             channel gets muted.
 *
 * monitoring-api is a Cloudflare Worker and cannot read the roster at runtime,
 * so this EMITS a JSON the worker bundles at build time. `--check` fails on
 * drift, which is what makes a newly-joined repo show up as a red gate rather
 * than as silence.
 *
 * @guards scripts/admin/fleet-runner-coverage.json
 * @guards scripts/admin/ci-watch-policy.json
 */
import process from 'node:process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allRepos } from './lib/fleet-roster.mjs';
import { reposDir } from './lib/sibling-repos.mjs';
import { jobNamesIn } from './lib/ci-watch-jobnames.mjs';
import { manifest as manifestFile, siteRoot } from './lib/paths.mjs';
import { keepStdoutWhole } from './lib/emit.mjs';

// STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
// and on a pipe `process.exit` throws away whatever the stream still had
// queued — measured on this host, 149,133 bytes in and 146,176 out, which
// `JSON.parse` then rejects mid-string. `keepStdoutWhole` puts fd 1 in
// blocking mode so there is nothing left to lose. Issue #33; the shared
// emitter calls the same function for the scripts that use it.
keepStdoutWhole();

const WRITE = process.argv.includes('--write');
const CHECK = process.argv.includes('--check');
const JSON_OUT = process.argv.includes('--json');
// #84 part 3: the floor under the shrink guard below. A repo being archived
// removes a handful of targets; crossing this ratio is the 67 -> 0 shape, not
// that one.
const ALLOW_SHRINK = process.argv.includes('--allow-shrink');

/** Gate + ship path. Anything else is not an incident when it goes red. */
const WATCH = [
	/^ci\.ya?ml$/,
	/^tests?\.ya?ml$/,
	/^typecheck\.ya?ml$/,
	/^publish.*\.ya?ml$/,
	/^deploy.*\.ya?ml$/,
	/^redeploy.*\.ya?ml$/,
];
/** Bots. They fail on their own schedule and self-heal. */
const IGNORE = [/^update-wolffm\.ya?ml$/, /^vibecheck\.ya?ml$/, /^vibecompact\.ya?ml$/];

const policy = JSON.parse(readFileSync(manifestFile('ci-watch-policy.json'), 'utf8'));
const OUT = join(siteRoot(), 'workers', 'monitoring-api', 'src', 'ci-watch.generated.json');
// Second copy, in the manifest dir, because the CONSUMER moved. `ci-alerts.ts`
// in this package now owns "did a GitHub Action work" and reads its targets at
// run time from `manifestDir`, which is a path the fleet host already provides
// — no new host port, and a roster change is picked up without a republish.
//
// Two copies is a TRANSITIONAL state, not a design. monitoring-api's ci-check
// still bundles the first one at build time; when that alerter is deleted, drop
// OUT and leave OUT_MANIFEST. Both are written and both are checked, so they
// cannot drift apart while both exist.
const OUT_MANIFEST = manifestFile('ci-watch.generated.json');

const dirFor = (repo) => join(reposDir(), repo.split('/').pop());

/**
 * Job names for one watched workflow. The parsing rules live in
 * scripts/lib/ci-watch-jobnames.mjs so they are testable without a checkout —
 * every name here is one monitoring-api will go silent about.
 */
function jobNamesOf(repo, workflow) {
	const file = join(dirFor(repo), '.github', 'workflows', workflow);
	if (!existsSync(file)) return [];
	return jobNamesIn(readFileSync(file, 'utf8'));
}

function workflowsOf(repo) {
	const wf = join(dirFor(repo), '.github', 'workflows');
	if (!existsSync(wf)) return null; // checkout missing — NOT "no workflows"
	return readdirSync(wf)
		.filter((f) => /\.ya?ml$/.test(f))
		.sort();
}

const targets = [];
// Execution-log job names belonging to the workflows below — the exact set
// monitoring-api's job-alerts must stay quiet about. See jobNamesOf().
const coveredJobNames = new Set();
const missingCheckouts = [];
const unwatched = [];

/**
 * POLICY DRIFT. Every entry in the policy file is an exception to the
 * convention, and nothing checked that an exception still excepted anything:
 * an `alsoWatch` naming a deleted workflow silently watched nothing, a
 * `neverWatch` naming a file the convention never picks silently dropped
 * nothing, and an `exempt` with no `why` — which the policy file itself calls
 * "a bug, not a decision" — was honoured exactly like one with a reason. Each
 * is the allowlist-without-a-stale-check shape #98 names: entries outlive what
 * they were for, and the reader trusts them anyway.
 */
const policyDrift = [];
/** A policy section's real entries — `$comment` keys are prose. */
const entriesOf = (section) =>
	Object.entries(policy[section] ?? {}).filter(([k]) => !k.startsWith('$'));
const roster = new Set(allRepos({ includeHost: true }));
for (const section of ['exempt', 'alsoWatch', 'neverWatch']) {
	for (const [repo] of entriesOf(section)) {
		if (!roster.has(repo)) {
			policyDrift.push(`policy ${section}["${repo}"] names a repo not on the roster — remove it`);
		}
	}
}
for (const [repo, entry] of entriesOf('exempt')) {
	const why = typeof entry === 'string' ? entry : entry?.why;
	if (typeof why !== 'string' || !why.trim()) {
		policyDrift.push(`policy exempt["${repo}"] has no \`why\` — an exemption needs a reason`);
	}
}
/** The convention alone: what would be watched with no policy at all. */
const conventionPicks = (f) => WATCH.some((re) => re.test(f)) && !IGNORE.some((re) => re.test(f));

for (const repo of allRepos({ includeHost: true })) {
	if (policy.exempt?.[repo]) continue;
	const files = workflowsOf(repo);
	if (files === null) {
		missingCheckouts.push(repo);
		continue;
	}
	const picked = new Set(files.filter(conventionPicks));
	for (const extra of policy.alsoWatch?.[repo] ?? []) {
		if (files.includes(extra)) picked.add(extra);
		else
			policyDrift.push(
				`policy alsoWatch["${repo}"] names ${extra}, which ${repo} does not have — ` +
					'it watches nothing'
			);
	}
	for (const drop of policy.neverWatch?.[repo] ?? []) {
		if (!files.includes(drop) || !conventionPicks(drop)) {
			policyDrift.push(
				`policy neverWatch["${repo}"] names ${drop}, which the convention would never pick ` +
					`${files.includes(drop) ? '' : '(and the repo does not have) '}— it drops nothing`
			);
		}
		picked.delete(drop);
	}

	if (!picked.size) {
		unwatched.push(repo);
		continue;
	}
	const [owner, name] = repo.split('/');
	for (const workflow of [...picked].sort()) {
		targets.push({
			owner,
			repo: name,
			workflow,
			label: `${name} / ${workflow.replace(/\.ya?ml$/, '')}`,
		});
		for (const jn of jobNamesOf(repo, workflow)) coveredJobNames.add(jn);
	}
}

// A repo the roster names but whose checkout is absent is NOT "nothing to
// watch" — it is a question we could not ask. Same rule the fleet auditors use.
const problems = [];
if (missingCheckouts.length)
	problems.push(
		`${missingCheckouts.length} roster repo(s) have no checkout: ${missingCheckouts.join(', ')}`
	);
if (unwatched.length)
	problems.push(
		`${unwatched.length} roster repo(s) yield NO watched workflow: ${unwatched.join(', ')}. ` +
			'Add one to `alsoWatch`, or an `exempt` entry with a reason.'
	);
problems.push(...policyDrift);

/**
 * #84 part 3: the shrink floor. Compared against `OUT_MANIFEST` because both
 * copies are written together and never drift apart while both exist (see
 * the note above it) — either is a representative baseline. A repo being
 * archived removes a handful of targets; crossing 50% is the 67 -> 0 shape
 * `missingCheckouts` produces, not a legitimate roster change. An unreadable
 * or missing existing file means there is no baseline to compare against, so
 * the floor does not apply — that is the FIRST write, not a shrink.
 */
let shrinkMessage = null;
if (!ALLOW_SHRINK) {
	let previousCount = null;
	try {
		if (existsSync(OUT_MANIFEST)) {
			const prev = JSON.parse(readFileSync(OUT_MANIFEST, 'utf8'));
			if (Array.isArray(prev.targets)) previousCount = prev.targets.length;
		}
	} catch (err) {
		// No baseline to compare against — same as a first write — but an
		// unreadable EXISTING file is not nothing: say so, or this is "could
		// not look" rendering as "nothing wrong" the moment someone wonders why
		// the shrink floor never caught a real regression.
		console.error(
			`  ⚠ ${OUT_MANIFEST} exists but could not be read as JSON (${err.message}) — shrink floor skipped`
		);
		previousCount = null;
	}
	if (previousCount && targets.length < previousCount * 0.5) {
		shrinkMessage =
			`targets would shrink from ${previousCount} to ${targets.length} (below 50%) — ` +
			'refusing to write. Pass --allow-shrink if a repo was legitimately archived or dropped.';
	}
}
if (shrinkMessage) problems.push(shrinkMessage);

// A write that would replace a GOOD file with a DEGRADED one must never
// happen (#84 part 1): a missing checkout means we could not look, which is
// never a reason to write anyway, and there is no override for it. The
// shrink floor above is the only guard `--allow-shrink` can lift.
const REFUSE_WRITE = missingCheckouts.length > 0 || Boolean(shrinkMessage);

const generated = {
	$comment:
		'GENERATED by `fleet ci-watch --write`. Do not hand-edit — see scripts/admin/ci-watch-policy.json.',
	targets,
	// The handoff contract with monitoring-api's job-alerts: these job names are
	// covered by fleet-manager's ci-alerts, so job-alerts must NOT page for them.
	// Anything not listed here stays job-alerts' responsibility — which is what
	// keeps the bots (update-wolffm), the canaries and the site's own gates
	// alerting after the 2026-09-08 handoff. See jobNamesOf().
	coveredJobNames: [...coveredJobNames].sort(),
};
const serialised = JSON.stringify(generated, null, 2) + '\n';

if (JSON_OUT) {
	console.log(
		JSON.stringify(
			{
				targets: targets.length,
				repos: new Set(targets.map((t) => t.repo)).size,
				coveredJobNames: generated.coveredJobNames.length,
				problems,
			},
			null,
			2
		)
	);
} else {
	console.log(
		`ci-watch: ${targets.length} target(s) across ${new Set(targets.map((t) => t.repo)).size} repo(s)`
	);
	for (const p of problems) console.error(`  ✗ ${p}`);
}

if (WRITE) {
	if (REFUSE_WRITE) {
		if (!JSON_OUT)
			console.error(
				'  refusing to write: see the problem(s) above — neither output file was touched'
			);
	} else {
		for (const dest of [OUT, OUT_MANIFEST]) {
			writeFileSync(dest, serialised);
			if (!JSON_OUT) console.log(`  wrote ${dest}`);
		}
	}
}

if (CHECK) {
	// BOTH copies. Checking only one would let the other rot silently, and the
	// unchecked one is the alerter's input — the failure would be a fleet that
	// looks watched and is not.
	for (const dest of [OUT, OUT_MANIFEST]) {
		const disk = existsSync(dest) ? readFileSync(dest, 'utf8') : '';
		if (disk !== serialised) {
			console.error(`\n✗ ${dest} is stale — a repo joined or left the fleet.`);
			console.error('  fix: fleet ci-watch --write');
			process.exit(1);
		}
	}
	if (!problems.length)
		console.log('✓ every roster repo has a watched workflow, and the generated list matches');
}

process.exit(problems.length ? 1 : 0);
