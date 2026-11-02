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
 *   ignored   the audit bots — vibecheck, vibecompact. A red scan means a
 *             report did not get written, not that anything stopped shipping,
 *             and paging on them is how an alert channel gets muted.
 *
 * EVERY WORKFLOW IS CLASSIFIED, OR THE GATE IS RED (fleet-manager#37). The
 * convention used to be the whole of selection, and the only completeness check
 * asked whether a repo had ANY watched workflow. A workflow the regexes missed
 * in an otherwise-watched repo was silent, and `alsoWatch` grew one entry per
 * silent failure — six of them, then three more from one sweep (hadoku-actions
 * Self-test, hadoku-aggregator Auto-update, hadoku-tenhands Pages). So now each
 * shipped workflow of each roster repo must land in exactly one bucket: watched
 * by the convention, `alsoWatch`, ignored by the bot convention, or
 * `neverWatch` with a `why`. Anything else is UNCLASSIFIED, a problem, and
 * fails `--check`: a new workflow arrives as a red gate that asks for a
 * decision, not as a gap somebody finds after it failed.
 *
 * update-wolffm is WATCHED, not ignored. It used to be on the bot list on the
 * theory that its own `report-job` step pages through monitoring-api. That
 * holds only while the job's credential works, and the failures that freeze the
 * update pipeline are credential-shaped: on 2026-10-31 aggregator's run failed
 * on a vault 404 after a key bulk-swap, and its report-job got a 403 with the
 * same swapped key and logged a WARNING — green step, no page. Polling uses
 * this package's token, which the failing job cannot take down with it, and
 * `coveredJobNames` hands the job's name over so job-alerts stands down rather
 * than double-paging.
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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../dist/lib/atomic-json.js';
import { allRepos } from './lib/fleet-roster.mjs';
import { tryShipped } from './lib/fleet-source.mjs';
import { jobNamesIn } from './lib/ci-watch-jobnames.mjs';
import { manifest as manifestFile, siteRoot } from '../dist/lib/fleet-paths.js';
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
	// The dependency ship path — see the header for why it is not a bot.
	/^update-wolffm\.ya?ml$/,
];
/** Audit bots. A red scan stops nothing shipping. */
const IGNORE = [/^vibecheck\.ya?ml$/, /^vibecompact\.ya?ml$/];

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

/**
 * Each roster repo's SHIPPED workflows, through fleet-source: the default
 * branch, fetched by the reader itself, never a sibling working tree
 * (fleet-manager#7). What gets watched is what GitHub runs, so it is what this
 * reads.
 */
const sources = new Map();
const sourceOf = (repo) => {
	if (!sources.has(repo)) sources.set(repo, tryShipped(repo));
	return sources.get(repo);
};

/**
 * Job names for one watched workflow. The parsing rules live in
 * scripts/lib/ci-watch-jobnames.mjs so they are testable without a checkout —
 * every name here is one monitoring-api will go silent about.
 */
function jobNamesOf(repo, workflow) {
	const text = sourceOf(repo).read?.(`.github/workflows/${workflow}`);
	return text ? jobNamesIn(text) : [];
}

/** Workflow file names, sorted, or null when the repo could not be read —
 *  unreadable is NOT "no workflows". */
function workflowsOf(repo) {
	const source = sourceOf(repo);
	if ('unreadable' in source) return null;
	return source.workflows().map((w) => w.file);
}

const targets = [];
// Execution-log job names belonging to the workflows below — the exact set
// monitoring-api's job-alerts must stay quiet about. See jobNamesOf().
const coveredJobNames = new Set();
const missingCheckouts = [];
const unwatched = [];
/** `owner/repo/file` for every shipped workflow no bucket claims. */
const unclassified = [];

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
const roster = allRepos({ includeHost: true });
/**
 * THE WATCH UNIVERSE IS THE ROSTER PLUS EVERY `alsoWatch` REPO. The roster is
 * the repos whose CI runs on the claws, and that is not the same question as
 * "whose failure matters": hadoku-actions runs nothing on the fleet — it is
 * public and its Self-test runs PR code, so it must stay on hosted runners —
 * yet a red Self-test means the action every fleet repo calls is broken
 * (fleet-manager#37). Naming such a repo in `alsoWatch` brings it in, and from
 * then on every one of its workflows must be classified like a roster repo's.
 * A stale entry cannot hide: a deleted repo is unreadable, which fails.
 */
const offRoster = entriesOf('alsoWatch')
	.map(([repo]) => repo)
	.filter((repo) => !roster.includes(repo))
	.sort();
const universe = new Set([...roster, ...offRoster]);
for (const section of ['exempt', 'neverWatch']) {
	for (const [repo] of entriesOf(section)) {
		if (!universe.has(repo)) {
			policyDrift.push(
				`policy ${section}["${repo}"] names a repo that is neither on the roster nor in alsoWatch — remove it`
			);
		}
	}
}
const hasWhy = (why) => typeof why === 'string' && why.trim() !== '';
for (const [repo, entry] of entriesOf('exempt')) {
	if (!hasWhy(typeof entry === 'string' ? entry : entry?.why)) {
		policyDrift.push(`policy exempt["${repo}"] has no \`why\` — an exemption needs a reason`);
	}
}
/**
 * `neverWatch` is `{ repo: { file: why } }`. A drop is a place the fleet can go
 * quietly red, so — like an exemption — one without a reason is a bug, and the
 * old bare-list form is refused outright rather than read as a list of drops
 * nobody explained.
 */
const neverWatchOf = (repo) => {
	const entry = policy.neverWatch?.[repo];
	if (entry === undefined) return new Map();
	if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
		policyDrift.push(
			`policy neverWatch["${repo}"] must map each workflow to its \`why\` ` +
				'({ "file.yml": "reason" }) — a drop needs a reason'
		);
		return new Map();
	}
	const drops = new Map();
	for (const [file, why] of Object.entries(entry)) {
		if (file.startsWith('$')) continue;
		if (!hasWhy(why))
			policyDrift.push(
				`policy neverWatch["${repo}"]["${file}"] has no \`why\` — a drop needs a reason`
			);
		drops.set(file, why);
	}
	return drops;
};
/** The convention alone: what would be watched with no policy at all. */
const conventionPicks = (f) => WATCH.some((re) => re.test(f)) && !IGNORE.some((re) => re.test(f));
const botIgnored = (f) => IGNORE.some((re) => re.test(f));

for (const repo of universe) {
	if (policy.exempt?.[repo]) continue;
	const files = workflowsOf(repo);
	if (files === null) {
		missingCheckouts.push(`${repo} (${sourceOf(repo).unreadable})`);
		continue;
	}
	const picked = new Set(files.filter(conventionPicks));
	const alsoWatch = policy.alsoWatch?.[repo] ?? [];
	for (const extra of alsoWatch) {
		if (!files.includes(extra))
			policyDrift.push(
				`policy alsoWatch["${repo}"] names ${extra}, which ${repo} does not have — ` +
					'it watches nothing'
			);
		else if (picked.has(extra))
			policyDrift.push(
				`policy alsoWatch["${repo}"] names ${extra}, which the convention already watches — remove it`
			);
		else picked.add(extra);
	}
	const drops = neverWatchOf(repo);
	for (const drop of drops.keys()) {
		if (!files.includes(drop))
			policyDrift.push(
				`policy neverWatch["${repo}"] names ${drop}, which ${repo} does not have — it drops nothing`
			);
		else if (alsoWatch.includes(drop))
			policyDrift.push(`policy names ${repo} ${drop} in both alsoWatch and neverWatch — pick one`);
		else if (botIgnored(drop))
			policyDrift.push(
				`policy neverWatch["${repo}"] names ${drop}, which the bot convention already ignores — remove it`
			);
		picked.delete(drop);
	}
	for (const file of files) {
		if (!picked.has(file) && !drops.has(file) && !botIgnored(file))
			unclassified.push(`${repo}/${file}`);
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

// A repo the roster names but whose workflows could not be read is NOT "nothing
// to watch" — it is a question we could not ask. Same rule the fleet auditors use.
const problems = [];
if (missingCheckouts.length)
	problems.push(
		`${missingCheckouts.length} roster repo(s) could not be read: ${missingCheckouts.join(', ')}`
	);
if (unwatched.length)
	problems.push(
		`${unwatched.length} roster repo(s) yield NO watched workflow: ${unwatched.join(', ')}. ` +
			'Add one to `alsoWatch`, or an `exempt` entry with a reason.'
	);
const unclassifiedProblem = unclassified.length
	? `${unclassified.length} shipped workflow(s) are UNCLASSIFIED — neither watched nor ` +
		`deliberately dropped: ${unclassified.join(', ')}. Add each to \`alsoWatch\`, or to ` +
		'`neverWatch` with a `why`.'
	: null;
if (unclassifiedProblem) problems.push(unclassifiedProblem);
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
// happen (#84 part 1): an unreadable repo means we could not look, which is
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
				// What was found among the repos that COULD be read. Empty means
				// "nothing unclassified" only when `unreadable` is empty too — an
				// unreadable repo is a question not asked, and it is in `problems`.
				unclassified,
				unreadable: missingCheckouts,
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
			writeFileAtomic(dest, serialised);
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
		console.log(
			'✓ every shipped workflow is classified, every roster repo has a watched one, and the generated list matches'
		);
}

/**
 * A WRITE IS NOT A GATE. hadoku_site's nightly `reconcile-fleet-coverage` runs
 * `--write` under `set -e`, in the same job that admits new repos to the roster
 * (and so to `CI_RUNNER`). If an unclassified workflow failed the write, one new
 * workflow anywhere in the fleet would hold every new repo out of CI until a
 * human classified it. The targets that ARE classified are correct and are
 * written, so a `--write` whose only problem is unclassified workflows exits 0
 * and says so loudly; `--check` — the audit gate — still fails on them, which
 * is where the red belongs. Unreadable repos, drift, an unwatched repo and the
 * shrink floor are not lifted by this: those still exit 1.
 */
const blocking = problems.filter((p) => p !== unclassifiedProblem);
const writeTolerated = WRITE && !CHECK && !blocking.length && Boolean(unclassifiedProblem);
if (writeTolerated)
	console.error(
		`  ⚠ wrote the classified targets, but ${unclassified.length} workflow(s) are NOT watched ` +
			'until classified — `fleet ci-watch --check` stays red on them'
	);
process.exit(problems.length && !writeTolerated ? 1 : 0);
