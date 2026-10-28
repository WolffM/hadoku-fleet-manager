/**
 * THE ECOSYSTEM LITERALS MAY NOT GROW.
 *
 * This package is published as `@wolffm/fleet-manager` and consumed in-process
 * by mgmt-api, but its source is still full of the one fleet it was extracted
 * from: `hokon` by name, `/home/hadoku`, `WolffM/…`, `192.168.…`, the
 * `.hadoku-mgmt` state directory. Every one of those is a fact about THIS
 * garage baked into a library, and each one is a place a second operator — or
 * this one, after a move — finds the package resolving to something that is not
 * there.
 *
 * This gate does NOT ask anyone to reduce the count. Removing them is real work
 * with a real risk of breaking a path resolution that currently works, and a
 * gate that demanded it on day one would just be turned off. It stops the count
 * GROWING, which is the property that makes the removal finite: today's number
 * is a ceiling, so the debt can only be paid down.
 *
 * COMMENTS ARE BLANKED FIRST, and that is not a nicety here. Several files in
 * this tree carry prose that spells the very literal it warns against — the
 * CI_RUNNER audit found repos whose comment reads "do NOT restore the
 * `vars.CI_RUNNER || …` fallback here", and a raw grep scores that as usage of
 * the thing the comment forbids. A comment has been read as evidence in this
 * codebase FOUR times. Blanking preserves offsets, so a count is a count of
 * code.
 *
 * WHY THE BASELINE IS A PER-TERM MAP AND NOT ONE TOTAL
 * ---------------------------------------------------
 * A single sum lets one term fall while another rises and reports nothing —
 * exactly the shape CLAUDE.md's "the LIST is the declaration" rule was written
 * for after this repo carried a bare count and was wrong twice. Per term, a
 * rise is a rise.
 *
 * The terms OVERLAP on purpose: `/home/hadoku`, `hadoku_site` and
 * `.hadoku-mgmt` all contain `hadoku`, so one new `/home/hadoku` moves two
 * counters. That is not double-counting to be fixed — the specific terms say
 * WHICH kind of literal grew, and the general one catches the spellings the
 * specific ones do not enumerate.
 *
 * IF THIS TEST FAILS ON A COUNT THAT ROSE, THAT IS A FINDING, NOT A FLAKE.
 * Wave 3a landed six lanes into one worktree and the baseline below was
 * measured from lane L's tree, so a later lane's commit can legitimately push a
 * term up. The response is to look at what that lane added, decide whether the
 * literal belongs there, and re-baseline DELIBERATELY with the new number in
 * the commit message — never to widen the number because the build is red.
 *
 * SCOPE: `src/` and `scripts/`, non-test files only.
 * Tests are excluded because a fixture must be free to spell a real hostname —
 * `doctor-write.test.mjs` needs an unreachable node and `paths.test.ts` needs a
 * real-looking state directory. Including them would make the gate fight the
 * tests that prove the path handling works.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * The literals, most specific first.
 *
 * Order is only for the report — every term is counted independently over the
 * whole corpus, so a shorter term that is a substring of a longer one is
 * counted in both. See the header on why that is deliberate.
 */
const TERMS = [
	'hadoku_site',
	'/home/hadoku',
	'.hadoku-mgmt',
	'192.168.',
	'WolffM',
	'hokon',
	'hadoku',
];

/**
 * Measured 2026-09-16 on the Wave 3f branch, with comments blanked.
 *
 * NOT a guess and not a round number. Re-measure by reading the failure
 * message: it prints the count it found next to the count it expected, per
 * term, with the files carrying the most occurrences.
 *
 * WAVE 3F LANE B TOOK FIVE OF THE SEVEN DOWN, and this is the first time the
 * ceiling has moved by more than a rounding. `src/lib/fleet-config.ts` already
 * answered "who does this fleet belong to" after Wave 3c; this wave routed the
 * ten heaviest non-test files through it. Nothing here is a reworded comment or
 * a literal relocated into a fresh `const` — every line below either calls an
 * accessor, reads the manifest, or names a constant that ALREADY existed.
 *
 * The arithmetic, per file, so a later reader can check it rather than trust it:
 *
 *   hadoku_site  29 -> 13
 *     -5  scripts/check-contract-consumers.mjs: `join(reposDir(), 'hadoku_site')`
 *         and the four finding/help strings that named the checkout — `hubRepo()`
 *     -4  scripts/check-header-fleet.mjs: the catalogue root, the "skip the
 *         parent" test, and two advice strings
 *     -3  src/lib/fleet-paths.ts: `siteRoot()`'s join and its two `must()` hints
 *     -3  scripts/service-inventory.mjs: the SITE root, the double-count
 *         explanation and the cron-worker profiles path
 *     -1  src/runner-health.ts: `SELF_REPO`, now `hubRepoFull()`
 *
 *   .hadoku-mgmt  6 -> 4
 *     -1  scripts/service-inventory.mjs: a SECOND `stateDir()` whose own comment
 *         said a .mjs cannot import the TS source. It can — `lib/paths.mjs`
 *         re-exports the built one, and did while that comment sat beside it.
 *     -1  scripts/check-label-floor.mjs: the ledger path spelled into an error
 *         message three lines from the `join(stateDir(), …)` that opens it. With
 *         HADOKU_STATE_DIR set, the message named a file the gate had not read.
 *
 *   WolffM  10 -> 7
 *     -2  src/runner-health.ts: `SELF_REPO`, and the `/^WolffM\//` that shortened
 *         a repo name for an alert — now a `fleetOwner()` prefix test
 *     -1  scripts/runner-mem-report.py: `actions.runner.WolffM-`, now matched as
 *         GitHub's unit-name SHAPE rather than as this account's name
 *
 *   hokon  48 -> 45
 *     -1  src/capabilities.ts: `id: 'hokon-backstop'` was a second spelling of
 *         `BACKSTOP_LABEL` in the same file — the exact two-lists-one-meaning
 *         split that file was written to close
 *     -1  scripts/runner-mem-report.py: the node-suffix list, now the manifest's
 *     -1  NOT THIS LANE. Three lanes landed in one worktree this wave and the
 *         count was taken last, over all three. Lane B's own tree measures 46.
 *         If that lane's work is reworked, re-baseline to 46 DELIBERATELY — the
 *         term did not rise, a sibling's removal was undone.
 *
 *   hadoku  145 -> 109
 *     -11 scripts/ci-throttle-install.sh: `$HOME/.hadoku` twelve times, now
 *         `NODE_DIR`, once. This one is a consolidation, not a resolution, and
 *         the file says why: `~/.hadoku` is also spelled in jit-provision.sh,
 *         job-metrics.sh, warm-provision.sh, ephemeral.ts and
 *         deploy-ci-throttle.mjs, none of which read anything from that script.
 *         An env knob there would move one script's paths and leave five — a
 *         split brain worse than the hard-coded path. One spelling per file is
 *         the step that was available; the fleet-wide accessor is the step after.
 *     -5  src/runner-health.ts: `SELF_REPO`, and four `User-Agent` headers that
 *         named `hadoku-mgmt-api` — the service that embeds this package rather
 *         than the package. `userAgent()`, as `ci-runner-fallback.ts` already did.
 *     -5  scripts/check-contract-consumers.mjs   -4  scripts/check-header-fleet.mjs
 *     -4  scripts/service-inventory.mjs          -3  src/lib/fleet-paths.ts
 *     -1  src/capabilities.ts                    -1  scripts/check-label-floor.mjs
 *         (all the `hadoku_site` and `.hadoku-mgmt` moves above; the terms
 *         OVERLAP on purpose — see the header)
 *
 *   `hadoku` ALSO LOSES TWO COUNTS OF SLACK. It was baselined at 145 and measured
 *   143 on an untouched HEAD at the start of this wave, so the ceiling had two
 *   counts of room nobody had spent. Wave 3c left it deliberately loose while
 *   four lanes converted in parallel and said to tighten it in the wave that paid
 *   it down. This is that wave, so it is now EXACT.
 *
 * WHAT DELIBERATELY STAYED, so the next reader does not re-litigate it:
 *   - Doc strings and `description:` fields naming the fleet (`hokon has an RTX
 *     4090`, `854 minutes hadoku-games-host sat`, `404s on hadoku.me`). They
 *     resolve to nothing, so there is no second operator they can misdirect.
 *     Interpolating a still-hard-coded constant into a sentence lowers this
 *     number without making anything configurable, which is the one move this
 *     gate must not reward.
 *   - `hokonPool` in runner-health.ts (x3): it is a FIELD of the census type in
 *     `src/runners/census.ts`, so the rename is cross-file and belongs with that
 *     file, not with its caller.
 *   - (Resolved in Wave 3g, below.) Four `hokon` in runner-health.ts comments
 *     around line 2007 were counted as CODE, because `blankComments` did not
 *     track `${}` inside a template literal. Rewording real comments to dodge a
 *     miscount would have been reading a comment as evidence for the fifth time;
 *     the scanner was fixed instead, and the prose is untouched.
 *
 * WAVE 3G LANE Y: hokon 45 -> 38, and NOT ONE LINE OF SOURCE MOVED. The scanner
 * learned `${}` (and shell globs), so seven comments that had been scored as
 * code stopped being scored. Measured over the same tree with the old and new
 * blanker, every other term unchanged:
 *     -4  src/runner-health.ts: the comments at ~2007-2020, beneath the nested
 *         template at ~1998 — the four this header named, found exactly
 *     -3  scripts/reconcile-fleet-runners.mjs: comments at ~1591-1600, beneath
 *         the nested template in the `Capacity:` log at ~1474, which this
 *         header had not noticed
 * A ceiling that only ever included miscounted prose was never measuring code,
 * so it drops by the whole seven rather than keeping them as slack.
 *   - `DEFAULT_OWNER` / `DEFAULT_HUB_REPO` in fleet-config.ts, and the
 *     `.hadoku-mgmt` default in fleet-paths.ts: one spelling each, and they are
 *     the source of truth every line above now reads.

 * WAVE 3P LANE C: hokon 38 -> 39, ONE literal, and it is a CLASS NAME rather
 * than a hostname. `check-egress-slices.mjs` gained
 * `const DORMANT_EXEMPT_CLASS = 'hokon-local';` — the taxonomy class that
 * `manifests/egress-slices.json` writes in its `class` field, pinned once so a
 * stopped hokon-local app is `dormant` instead of a daily page (#68). It is
 * deliberately NOT resolved from the environment: the exemption keys on this
 * exact string, so a variable that could be set wrong would silently widen it,
 * and the mutation test that proves the exemption (`the exemption keys on the
 * `class` field, never on membership of the register`) is the thing that string
 * holds up. Measured per commit over the wave: B +0, C +1, A +0, E +0, D +0.
 *
 * WAVE 4B LANE C: hadoku 110 -> 111, ONE literal. `scripts/clean-runner-debris.sh`
 * gained `NODE_DIR="$HOME/.hadoku"` — the node-side fleet directory, which a
 * script running ON a node must name once and cannot resolve from the
 * controller's environment, because there is no controller environment to
 * read it from at the point this script runs. Lane C first wrote
 * `$HOME/.hadoku` twice (once each for JIT_ROOT's and RUNNER_ENV_FILE's
 * defaults) and was cut to one by deriving both from NODE_DIR instead — the
 * same name and the same reason as ci-throttle-install.sh's own NODE_DIR, one
 * spelling per file rather than two. Lanes A and B of the same wave each
 * added a literal of their own and were both brought back to +0 before this
 * baseline moved: A derived its probe path from the existing `slotDir`
 * spelling via `jitRoot()` instead of writing a second one; B named
 * `runner.env` without its directory in its messages, so no new directory
 * literal was needed at all.
 *
 * WAVE 4C LANE F: hadoku 111 -> 112, ONE literal. `scripts/lib/doctor.mjs`
 * gained a `_work`-filesystem probe and a "where the space went" consumer-size
 * probe (the `$HOME/.hadoku/jit` and `$HOME/.hadoku/warm` directories doctor's
 * remote shell script now sizes), and FIRST wrote `$HOME/.hadoku` four times
 * across those two additions (`WORKDIR`'s own value, its first fallback, and
 * the two `sizeKb` calls). Cut to one by the same move as `ci-throttle-
 * install.sh` and `clean-runner-debris.sh`: `NODE_DIR="$HOME/.hadoku"` named
 * once in the probe, with `WORKDIR`/`sizeKb` reading `$NODE_DIR/jit` and
 * `$NODE_DIR/warm` — a node-side script still cannot resolve its own fleet
 * directory from a controller environment that does not exist at the point
 * the probe runs, so one spelling (not zero) is the floor here, same as both
 * precedents this entry follows.
 *
 * WAVE 4E: WolffM 8 -> 9, hadoku 112 -> 113, ONE literal each. jdk21's own
 * `jobProof` (`src/capabilities.ts`, #102) names `WolffM/hadoku-cardtable` —
 * the repo whose `forge-e2e` job is jdk21's WORKLOAD proof, exactly the same
 * pattern `taskauto`'s `jobProof` already set the precedent for at the +8/+112
 * baseline above: a declaration of which job proves the capability is the
 * point of the field, not drift to resolve from the environment.
 */
const BASELINE = {
	hadoku_site: 13,
	'/home/hadoku': 6,
	'.hadoku-mgmt': 4,
	'192.168.': 2,
	// 9: `taskauto`'s jobProof names WolffM/hadoku-tenhands (+8, see above);
	// jdk21's own jobProof (wave 4e, #102) names WolffM/hadoku-cardtable — the
	// same pattern, one more declared repo.
	WolffM: 9,
	hokon: 39,
	// 114: preflight's JIT_PAYLOAD_DIR, `.hadoku/jit/payload` (fleet-manager#1,
	// 2026-10-24). It is where jit-provision.sh builds the payload on the node,
	// read over ssh in the node's own $HOME; there is no controller-side
	// environment that could name it. Spelled once, and the probe uses it.
	hadoku: 114,
};

/**
 * A floor on the corpus, not the count. Measured at 149 non-test source files
 * on 2026-09-14; the number moves as lanes add scripts, so this sits below it
 * with room. A walker that stopped descending would scan a handful, count
 * almost nothing, and report a tree that had shed its literals overnight. Zero
 * scanned is a FAILURE, not a pass.
 */
const MIN_FILES = 120;

/** Extensions this can read honestly. `.json`, `.service` and `.pyc` carry no comments to blank. */
const CODE = new Set(['.ts', '.mjs', '.sh', '.py']);

const SKIP_DIRS = new Set(['tests', 'node_modules', '__pycache__', 'dist']);

/**
 * Shell/python comments, blanked WHOLE-LINE only.
 *
 * `blankComments` is a JS/TS scanner — same reason `script-provenance.test.mjs`
 * carries its own. A trailing-comment stripper would have to understand shell
 * quoting to avoid eating a `#` inside a string, so only full-line comments go.
 * UNDER-blanking is the safe direction for this gate: a surviving comment can
 * only inflate a count, which can only make the rule stricter or raise a false
 * finding a human reads — never hide a literal that was added to code.
 */
const blankHashComments = (src) =>
	src
		.split('\n')
		.map((l) => (/^\s*#/.test(l) ? '' : l))
		.join('\n');

/** Every non-test source file under `src/` and `scripts/`, as repo-relative paths. */
function corpus() {
	const out = [];
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
				continue;
			}
			if (!e.isFile()) continue;
			if (/\.test\.(mjs|ts)$/.test(e.name)) continue;
			if (!CODE.has(extname(e.name))) continue;
			out.push(relative(ROOT, join(dir, e.name)));
		}
	};
	walk(join(ROOT, 'src'));
	walk(join(ROOT, 'scripts'));
	return out.sort();
}

const FILES = corpus();

/** Occurrences of `term` in `text`, non-overlapping. */
const occurrences = (text, term) => text.split(term).length - 1;

/** `path -> blanked source`, read once. */
const BLANKED = new Map(
	FILES.map((f) => {
		const src = readFileSync(join(ROOT, f), 'utf8');
		const ext = extname(f);
		return [f, ext === '.ts' || ext === '.mjs' ? blankComments(src) : blankHashComments(src)];
	})
);

/** `term -> { total, byFile }` over the whole corpus. */
function census() {
	const out = new Map();
	for (const term of TERMS) {
		let total = 0;
		const byFile = [];
		for (const [f, src] of BLANKED) {
			const n = occurrences(src, term);
			if (n) byFile.push([f, n]);
			total += n;
		}
		byFile.sort((a, b) => b[1] - a[1]);
		out.set(term, { total, byFile });
	}
	return out;
}

const CENSUS = census();

void test('the corpus is real — a scan of nothing is not a pass', () => {
	assert.ok(
		FILES.length >= MIN_FILES,
		`walked ${FILES.length} non-test source file(s) under src/ and scripts/, expected at ` +
			`least ${MIN_FILES}. The walker stopped descending or the layout moved, so every ` +
			`count below is a count of almost nothing and this gate proves nothing.`
	);
});

void test('the baseline names every term, and only the terms', () => {
	// The declaration and the blocklist are two lists in one file and they drift.
	// A term with no baseline entry would be counted and never compared.
	assert.deepEqual(
		Object.keys(BASELINE).sort(),
		[...TERMS].sort(),
		'BASELINE and TERMS have drifted apart — a term with no baseline is never checked.'
	);
});

void test('no ecosystem literal is more common than it was at the baseline', () => {
	const risen = [];
	for (const term of TERMS) {
		const { total, byFile } = CENSUS.get(term);
		if (total <= BASELINE[term]) continue;
		const top = byFile
			.slice(0, 5)
			.map(([f, n]) => `      ${n.toString().padStart(4)}  ${f}`)
			.join('\n');
		risen.push(
			`  ${term}: ${total} now, baseline ${BASELINE[term]} (+${total - BASELINE[term]})\n` +
				`    most occurrences:\n${top}`
		);
	}
	assert.deepEqual(
		risen,
		[],
		`${risen.length} ecosystem literal(s) became MORE common in src/ or scripts/:\n\n` +
			`${risen.join('\n\n')}\n\n` +
			`This package is published and consumed by another repo; a hostname, a home ` +
			`directory or a LAN address in it is a fact about one garage baked into a library. ` +
			`Resolve it from the environment (FLEET_MANIFEST_DIR, HADOKU_STATE_DIR, the ` +
			`manifest) instead. If the literal genuinely belongs — a doc string naming the ` +
			`fleet, a default that has nowhere else to live — re-baseline this map ` +
			`DELIBERATELY and say which literal moved and why in the commit message.`
	);
});

void test('a literal in a COMMENT is not a literal in the code', () => {
	// The negative control, and the reason this file blanks at all. Without it
	// the rule is a grep, and a grep scored a comment as evidence three times in
	// this repo before this test existed — a workflow comment saying a repo was
	// NOT on the fleet planned nine runner registrations onto it.
	const prose = [
		'/**',
		' * Never hard-code hokon or /home/hadoku here — read HADOKU_STATE_DIR.',
		' */',
		"export const HOST = process.env.FLEET_NODE ?? 'unset';",
		'// 192.0.2.1 is the router; WolffM is the owner.',
	].join('\n');
	const blanked = blankComments(prose);
	for (const term of TERMS) {
		assert.equal(
			occurrences(blanked, term),
			0,
			`a comment mentioning "${term}" was counted as code`
		);
	}

	// And the positive half: real code must still be seen, or the rule counts
	// nothing at all and passes forever.
	const real = "const STATE = '/home/hadoku/.hadoku-mgmt';";
	assert.equal(occurrences(blankComments(real), '/home/hadoku'), 1);
	assert.equal(occurrences(blankComments(real), '.hadoku-mgmt'), 1);

	// A `#` comment in the shell half, held to the same standard.
	assert.equal(
		occurrences(blankHashComments('  # ssh hokon uptime\nssh "$NODE" uptime'), 'hokon'),
		0
	);
	assert.equal(occurrences(blankHashComments('NODE=hokon'), 'hokon'), 1);
});
