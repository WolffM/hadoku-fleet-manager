/**
 * The slice check must assert EFFECTIVE placement, not the declared property.
 *
 * `fleet slice --check` reported green on hokon for as long as it existed while
 * 24 of 27 runners ran outside `ci-runner.slice`. It read the per-unit
 * `MemoryMax` from the kernel — correctly, that is the rule CLAUDE.md states —
 * and read slice membership not at all, then printed "every runner on every node
 * is in its declared slice".
 *
 * The two are different facts with different lifetimes. A drop-in setting
 * `Slice=` is true the moment it is written; systemd only MOVES a unit on its
 * next start. So a unit reports the right slice and runs in the wrong cgroup for
 * as long as it stays up, and the gap is invisible to anything reading `Slice=`.
 *
 * What is lost is the aggregate ceiling, which is the only reason the slice
 * exists: the per-unit cap bounds one runner, the slice bounds their sum, and
 * the 2026-08-04 outage — 51 GB anon-RSS, OOM, 23 PM2 services down, host
 * unreachable ~11 minutes — was about the sum.
 *
 * These are source-level guards for the same reason `node-identity-guard` is:
 * the behaviour needs systemd and a live fleet, so what CAN be pinned here is
 * that the reader still reads the effective cgroup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { blankComments } from './blank-comments.mjs';
// A SPAWNED CHILD THAT PRINTS NOTHING MUST SAY WHY (#45). Every parse below
// used to be a bare `JSON.parse(r.out)` over a helper that captured the
// child's stderr and threw it away, so a child killed by the concurrent
// `rm -rf dist` at the top of `pnpm run build` surfaced as
// `SyntaxError: Unexpected end of JSON input` — pointing at the parse, the one
// place the bug was not. Observed here at line 590 during wave 3j.
import { parseJsonStdout, spawnCapture } from './spawn-json.mjs';
import { sliceSummaryProblems } from './slice-summary.mjs';

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
const sh = () => readFileSync(join(SCRIPTS, 'runners-slice-install.sh'), 'utf8');
const mjs = () => readFileSync(join(SCRIPTS, 'deploy-runners-slice.mjs'), 'utf8');
// Where the driver's ceiling/changed/mint-cap rules live since #98 moved them
// into a pure function the tests below can drive.
const summaryLib = () => readFileSync(join(SCRIPTS, 'lib', 'slice-summary.mjs'), 'utf8');
/** A converged node's SUMMARY for a 1000 MB / 4096 MB slice, as parsed. */
const SUMMARY_OK = {
	changed: '0',
	live_max: String(1000 * 1024 * 1024),
	live_swap: String(4096 * 1024 * 1024),
	cfg_max: String(1000 * 1024 * 1024),
	cfg_swap: String(4096 * 1024 * 1024),
	user_load: 'loaded',
	user_max: String(1000 * 1024 * 1024),
	user_swap: String(4096 * 1024 * 1024),
	user_cfg_max: String(1000 * 1024 * 1024),
	user_cfg_swap: String(4096 * 1024 * 1024),
};

/**
 * Comments are blanked FIRST, every time.
 *
 * This file's own subject is `Slice=` versus `ControlGroup`, and both scripts
 * now carry paragraphs explaining the difference. A raw grep scores that prose
 * as the behaviour it describes — the trap CLAUDE.md names three times.
 */
const code = (src) => blankComments(src);

/**
 * THE SHELL HALF NEEDS A SHELL SCANNER.
 *
 * `blankComments` is a JS/TS scanner — its own header says so — and it was being
 * pointed at a shell script. A `#` comment is invisible to it, which is the
 * benign half; the sharp half is that shell and JS disagree about a slash
 * followed by a star. A directory glob — `for d in "$dir"` then slash-star — is
 * an ordinary shell expansion and an OPEN BLOCK COMMENT to the scanner, so
 * everything from that line to the next star-slash in the file was blanked
 * before any rule saw it. That silently removed SEVEN of the
 * assertions below, in one edit, and they went on reporting green — the exact
 * shape of failure this file exists to catch in someone else.
 *
 * MEASURED, not guessed: neutralising that one glob restores every one of them,
 * and replacing every apostrophe in every comment changes nothing. The installer
 * no longer contains the construct either, so this is the belt to that braces —
 * the next person to write a glob in it must not be able to blind these guards
 * by accident.
 *
 * So: `#`-to-end-of-line, outside quotes, with shell quoting rules — `'…'` is
 * literal to the next `'`, `"…"` honours `\`, and a `#` only opens a comment at
 * the start of a word. Offsets are preserved, the same contract `blankComments`
 * keeps, so a match still points at a real line.
 */
function shCode(src) {
	let out = '';
	let mode = 'code';
	let prev = '';
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (mode === 'comment') {
			if (ch === '\n') mode = 'code';
			out += ch === '\n' ? ch : ' ';
			prev = ch;
			continue;
		}
		if (mode === 'single') {
			if (ch === "'") mode = 'code';
			out += ch;
			prev = ch;
			continue;
		}
		if (mode === 'double') {
			if (ch === '\\') {
				out += src.slice(i, i + 2);
				i += 1;
				prev = '';
				continue;
			}
			if (ch === '"') mode = 'code';
			out += ch;
			prev = ch;
			continue;
		}
		if (ch === '\\') {
			out += src.slice(i, i + 2);
			i += 1;
			prev = '';
			continue;
		}
		// A `#` only opens a comment at the start of a word — `${x#y}` and
		// `jit-*#1` are not comments.
		if (ch === '#' && (prev === '' || /[\s;&|(]/.test(prev))) {
			mode = 'comment';
			out += ' ';
			prev = ch;
			continue;
		}
		if (ch === "'") mode = 'single';
		else if (ch === '"') mode = 'double';
		out += ch;
		prev = ch;
	}
	return out;
}

test('the probe reads ControlGroup to decide slice membership', () => {
	const src = shCode(sh());
	assert.match(src, /ucg=\$\(effslice "\$u"\)/, 'membership must come from the EFFECTIVE cgroup');
	assert.match(
		src,
		/effslice\(\) \{[\s\S]*?ecg=\$\(unitprop "\$1" ControlGroup\)/,
		'and effslice must derive it from ControlGroup, not from Slice='
	);
	assert.match(src, /in_slice=\$\(\(in_slice \+ 1\)\)/, 'and it must be counted');
});

test('membership is never decided by the declared Slice= property', () => {
	const src = shCode(sh());
	// `Slice=` may still be READ — the drift line reports it so an operator can
	// see declared and effective side by side — but it must not be what a unit is
	// counted as in-slice for.
	const decidesOnDeclared =
		/case\s+"\$\(unitprop "\$u" Slice\)"|\[\s*"\$\(unitprop "\$u" Slice\)"\s*=/;
	assert.doesNotMatch(
		src,
		decidesOnDeclared,
		'a unit that DECLARES the slice may still be running outside it'
	);
});

test('the membership count is reported in the summary line', () => {
	// The summary is the wire format between the shell and the auditor. A count
	// the auditor cannot read is a count nobody acts on.
	assert.match(shCode(sh()), /in_slice=\$in_slice/);
	assert.match(code(mjs()), /kv\.in_slice/);
});

test('placement drift is a PROBLEM, not a note', () => {
	const src = code(mjs());
	assert.match(
		src,
		/SLICE-PLACEMENT-DRIFT/,
		'the auditor must collect the drift lines the probe emits'
	);
	// Collected AND acted on: notes that never reach `problems` leave the node
	// reported ok, which is the exact failure being fixed.
	const collected = /notes\.filter\(\(n\) => n\.startsWith\('SLICE-PLACEMENT-DRIFT'\)\)/;
	assert.match(src, collected);
	assert.match(
		src,
		/if \(placeDrift\)\s*\n?\s*problems\.push\(/,
		'placement drift must push a problem so the check exits non-zero'
	);
});

test('the drift line survives the auditor filter', () => {
	// The probe emits these; the auditor keeps only lines matching a fixed
	// prefix list. A prefix added to one side and not the other is silent.
	const filter = code(mjs()).match(/\/\^\(([A-Z|-]+)\) \//);
	assert.ok(filter, 'the note filter must still be a prefix alternation');
	assert.ok(
		filter[1].split('|').includes('SLICE-PLACEMENT-DRIFT'),
		`SLICE-PLACEMENT-DRIFT must be in the filter, got: ${filter[1]}`
	);
});

test('the success line does not claim placement it has not tested', () => {
	const src = code(mjs());
	assert.doesNotMatch(
		src,
		/✓ every runner on every node is in its declared slice/,
		'the old wording asserted membership the check never read'
	);
	assert.match(src, /RUNS IN its declared slice/);
});

test('the fix hint names --restart, because --confirm alone cannot move a running unit', () => {
	// RESTART defaults to 0. Telling an operator to re-run `--confirm` on
	// placement drift sends them round the same loop forever — the failure mode
	// the needs_operator hint already exists to avoid.
	const src = code(mjs());
	assert.match(src, /--confirm\$\{placement \? ' --restart' : ''\}/);
});

test('the idempotency gate reads the EFFECTIVE slice, not the declared one', () => {
	// The repair's own gate had the same blind spot as the check, which is the
	// failure CLAUDE.md names outright: "the idempotency check must read observed
	// state too, or a gate and a repair share a blind spot and fail together."
	//
	// It read `cur_mem` from the kernel (correct, and commented as such) and `cur`
	// from `Slice=`. All 24 misplaced hokon units therefore compared equal and
	// returned before the restart that would have moved them: an APPLY with
	// --restart reported changed=0 restarted=0 and fixed nothing.
	const src = shCode(sh());
	assert.doesNotMatch(
		src,
		/cur=\$\(sysshow "\$unit" Slice\)/,
		'the system-scope gate must not key on the declared property'
	);
	assert.doesNotMatch(
		src,
		/cur=\$\(systemctl --user show "\$unit" -p Slice --value/,
		'nor the user-scope gate'
	);
	const gates = src.match(/cur=\$\(effslice "\$unit"\)/g) ?? [];
	assert.equal(gates.length, 2, `both scopes must gate on effslice, found ${gates.length}`);
});

test('a stopped unit is not counted as drift, and is never started by the repair', () => {
	// A unit with no processes has no cgroup and cannot be misplaced. Treating an
	// empty ControlGroup as drift would make the repair stop-and-start units that
	// were deliberately stopped.
	assert.match(
		shCode(sh()),
		/if \[ -n "\$ecg" \]; then[\s\S]*?else\s*\n\s*unitprop "\$1" Slice/,
		'effslice must fall back to the declared value when the unit is not running'
	);
});

test('the post-restart verification also reads the effective slice', () => {
	// Otherwise a restart that failed to relocate still counts as restarted, and
	// the repair reports success for the thing it did not do.
	const src = shCode(sh());
	assert.doesNotMatch(src, /new=\$\(sysshow "\$unit" Slice\)/);
	assert.equal((src.match(/new=\$\(effslice "\$unit"\)/g) ?? []).length, 2);
});

/**
 * THE MINTED UNITS — the set this gate could not see at all until 2026-09-14.
 *
 * The installer places three globs, all STANDING units. All-JIT left the claws
 * with none, so the walk covered an empty set and the auditor printed "every
 * runner on every node RUNS IN its declared slice" — a clean sheet for nothing,
 * while every actual runner ran in `app.slice` at `MemoryMax=infinity`. That is
 * the same class as the hokon case above, one layer further out: not "the check
 * read the wrong property" but "the check read the wrong units".
 */
test('the probe enumerates jit-* and warm-*, in the user manager', () => {
	const src = shCode(sh());
	assert.match(
		src,
		/mintlist\(\) \{ usrlist 'jit-\*' 'warm-\*'; \}/,
		'the minted prefixes must be enumerated, and from the USER manager — systemd-run --user ' +
			'is the only thing that creates them'
	);
	assert.match(src, /for u in \$\(mintlist\); do/, 'and the enumeration must be walked');
	assert.match(src, /mint_in_slice=\$\(\(mint_in_slice \+ 1\)\)/, 'and membership counted');
});

test('minted units are AUDITED, never placed, capped or restarted', () => {
	const src = shCode(sh());
	// `place()` writes a drop-in and restarts to relocate. A transient unit has no
	// unit file for a drop-in to extend, its name is single-use, and restarting
	// one kills the job it is running and orphans its registration.
	assert.doesNotMatch(
		src,
		/place "\$u" (system|user)[\s\S]{0,40}mintlist|mintlist[\s\S]{0,200}place "/,
		'the repair loop must never reach a minted unit'
	);
	// Placement is read through the same effective-cgroup reader as everything
	// else — the whole subject of this file.
	assert.match(src, /mcg=\$\(effslice "\$u"\)/, 'membership from ControlGroup, not Slice=');
	// Supervision would be permanent drift: a transient unit is Restart=no by
	// design. A gate that is always red is a gate nobody reads.
	assert.doesNotMatch(
		src,
		/for u in \$\(mintlist\); do[\s\S]*?KillMode/,
		'supervision must not be asserted on a transient unit'
	);
});

test('the minted counts reach the auditor, and drift is a problem', () => {
	assert.match(shCode(sh()), /mint_total=\$mint_total mint_in_slice=\$mint_in_slice/);
	const src = code(mjs());
	assert.match(src, /kv\.mint_in_slice/, 'the auditor must read the count');
	assert.match(
		src,
		/notes\.filter\(\(n\) => n\.startsWith\('MINT-PLACEMENT-DRIFT'\)\)/,
		'and collect the drift lines'
	);
	assert.match(src, /if \(mintDrift\)\s*\n?\s*problems\.push\(/, 'and exit non-zero on them');
	const filter = src.match(/\/\^\(([A-Z|-]+)\) \//);
	assert.ok(filter, 'the note filter must still be a prefix alternation');
	assert.ok(
		filter[1].split('|').includes('MINT-PLACEMENT-DRIFT'),
		`MINT-PLACEMENT-DRIFT must be in the filter, got: ${filter[1]}`
	);
});

test('the minted fix hint does NOT say --restart', () => {
	// --restart relocates a standing unit that already carries the right drop-in.
	// For a minted unit it kills a running job and fixes nothing: placement comes
	// from `--property=Slice=` at systemd-run time, so the next mint is the fix.
	const src = code(mjs());
	assert.match(src, /Minted units \(jit-\*\/warm-\*\) are NOT fixed by --confirm or --restart/);
	assert.match(src, /Never restart a live JIT unit/);
});

/**
 * THE CEILING THAT ACTUALLY BOUNDS A MINTED RUNNER.
 *
 * `live_max` is the SYSTEM manager's copy of the slice. Every `jit-*`/`warm-*`
 * unit is `systemd-run --user`, so on an all-JIT claw the value this gate has
 * always asserted governs nothing at all, and the value that governs everything
 * was printed as a note.
 */
test('the USER manager’s slice ceiling is asserted, not noted', () => {
	assert.match(shCode(sh()), /user_swap=\$live_user_swap/, 'the probe must report it');
	assert.match(
		code(mjs()),
		/problems\.push\(\.\.\.sliceSummaryProblems\(/,
		'the driver must turn the summary rules into problems, not log lines'
	);
	const p = sliceSummaryProblems({
		kv: { ...SUMMARY_OK, user_max: '1', user_swap: '2' },
		notes: [],
		sliceName: 'runners.slice',
		wantMax: 1000 * 1024 * 1024,
		wantSwap: 4096 * 1024 * 1024,
	});
	assert.ok(
		p.some((x) => /^user-manager runners\.slice MemoryMax is 1, want/.test(x)),
		p.join('\n')
	);
	assert.ok(
		p.some((x) => /^user-manager runners\.slice MemorySwapMax is 2, want/.test(x)),
		p.join('\n')
	);
});

test('an INACTIVE slice is not read as a missing one', () => {
	// A slice holding nothing is inactive and therefore absent from
	// `systemctl --user list-units --type=slice` — measured 2026-09-14 on all
	// seven claws, where runners.slice is loaded with the node's derived ceiling
	// and invisible there because all-JIT left it empty. Failing on that reading
	// would paint a correctly-configured fleet red; it is the same omission the
	// bad_slices probe already documents for a never-activated slice.
	assert.match(shCode(sh()), /live_user_load=.*-p LoadState/, 'the probe must read LoadState');
	const src = code(summaryLib());
	assert.match(src, /kv\.user_load !== 'loaded'/);
	assert.doesNotMatch(src, /kv\.user_load !== 'active'/, 'inactive is not missing');
	// And the kernel has no cgroup for an inactive slice, so `inactive` with the
	// right CONFIG is a pass — it is what systemd applies when the slice next
	// holds a unit — while `inactive` with the wrong config is still drift.
	const judge = (kv) =>
		sliceSummaryProblems({
			kv: { ...SUMMARY_OK, ...kv },
			notes: [],
			sliceName: 'runners.slice',
			wantMax: 1000 * 1024 * 1024,
			wantSwap: 4096 * 1024 * 1024,
		});
	assert.deepEqual(judge({ user_max: 'inactive', user_swap: 'inactive' }), []);
	assert.match(
		judge({ user_max: 'inactive', user_cfg_max: 'infinity' }).join('\n'),
		/has no cgroup .* would apply infinity/
	);
});

/**
 * ONE NAME IN TWO LANGUAGES.
 *
 * The minter is TypeScript and this gate is `.mjs`, so the literal is written
 * twice — the `json-contract.mjs` shape. Importing the built copy instead would
 * be a verifier reading its own build rather than the source, which is the
 * failure CLAUDE.md names for `check:slice` itself.
 */
test('the gate’s mint slice is the minter’s mint slice', () => {
	const REPO = dirname(SCRIPTS);
	const ts = readFileSync(join(REPO, 'src', 'runners', 'ephemeral.ts'), 'utf8');
	const minter = ts.match(/export const DEFAULT_RUNNER_SLICE = '([^']+)'/);
	assert.ok(minter, 'DEFAULT_RUNNER_SLICE must still be a literal in src/runners/ephemeral.ts');
	const gate = code(mjs()).match(/const MINT_SLICE = '([^']+)'/);
	assert.ok(gate, 'MINT_SLICE must still be a literal in deploy-runners-slice.mjs');
	assert.equal(
		gate[1],
		minter[1],
		'the slice the gate audits against and the slice the minter emits have drifted apart'
	);
	// And the shell half's default, which is what installs the slice the minter
	// places into. Three copies, one name.
	assert.match(shCode(sh()), new RegExp(`SLICE_NAME:-${minter[1].replace('.', '\\.')}`));
});

/**
 * THE ASSUMPTION THE SINGLE NAME RESTS ON.
 *
 * `buildWarmSpawnPlan` emits one name because the node's name cannot reach it.
 * `buildSpawnPlan` CAN since #120 — a JIT mint's slice travels MintRequest →
 * dispatch-pass → mintEphemeralRunner, which is how an on-demand guest's units
 * land in its own slice — but a warm listener's does not, and any `ephemeral`
 * node may hold one. So every such node must agree with the default. The gate
 * must be the thing that says so, because a comment is not evidence.
 */
test('a mint-capable node with a different declared slice FAILS the gate', () => {
	const src = code(mjs());
	assert.match(src, /m\?\.ephemeral === true/, 'mint-capable is `ephemeral: true`');
	assert.match(src, /\(m\.slice\?\.name \?\? MINT_SLICE\) !== MINT_SLICE/);
	assert.match(
		src,
		/if \(mintSliceConflicts\.length\)\s*\n?\s*drift\.push\(/,
		'the conflict must reach the check’s drift list'
	);
	// The exit EXPRESSION, not one exact spelling of it: the guest rule added a
	// third clause to this ternary in Wave 3e, and an assertion pinned to the
	// old text would have failed for a reason that has nothing to do with mint
	// slices. What must hold is that a conflict still reaches the exit code.
	assert.match(
		src,
		/process\.exit\(\s*[^;]*mintSliceConflicts\.length[^;]*\?\s*1\s*:\s*0\s*\)/,
		'and the process must exit non-zero on it outside --check too'
	);
	// Read from the WHOLE manifest: `--machine claw-2` must not be able to make a
	// fleet-wide invariant report clean by narrowing the question.
	assert.match(src, /Object\.entries\(manifest\.machines \?\? \{\}\)\s*\n?\s*\.filter/);
});

// ── the guest rule ──────────────────────────────────────────────────────────

test('the sweep selects through the role-aware door, not the bare one', () => {
	// hokon declares a `slice` block and a `minFreeMb`, so this file's own
	// eligibility filter matched it and the gate walked the production host's 27
	// runner units like any claw. `selectMachines` cannot know that; `selectNodes`
	// is the one that does.
	const src = code(mjs());
	assert.match(src, /selectNodes\(manifest, \{/, 'the node sweep must come from selectNodes');
	assert.doesNotMatch(
		src,
		/selectMachines\(/,
		'the bare selection door has no role filter — that is how hokon got in'
	);
	assert.match(src, /skippedByRole/, 'and the guests it refused must reach the report');
});

test('the sudo hint can never name a guest', () => {
	// THE LINE THAT MADE THIS A LANE. `ci:audit-gates` was red on 2026-09-16
	// printing "On hokon, as the operator: sudo -v && fleet slice --machine hokon
	// --confirm" — the fleet asking a guest for sudo on the box every other gate
	// reports through, which the 2026-09-14 decision rules out.
	//
	// `needsSudo` is the only source of that sentence, so the guard is that
	// nothing can be added to it without the role being consulted first.
	const src = code(mjs());
	const at = src.indexOf('needsSudo.add(');
	assert.notEqual(at, -1, 'the sudo hint set must still exist — it is what is being constrained');
	const guard = src.slice(Math.max(0, at - 400), at);
	assert.match(
		guard,
		/!guest\s*&&/,
		'the guard adding a node to needsSudo must exclude a guest FIRST'
	);
});

test('a guest is never converged, even when the operator names it', () => {
	// Naming it buys a LOOK, never a write. `--machine hokon --confirm` is the
	// command this gate's own fix hint told operators to type, so it is the one
	// spelling that has to be refused rather than merely unreachable.
	const src = code(mjs());
	assert.match(
		src,
		/if \(selectedGuests\.length && CONFIRM && !CHECK\)/,
		'--confirm on a named guest must be refused outright'
	);
	assert.match(
		src,
		/const apply = CONFIRM && !CHECK && !guest;/,
		'and even past the refusal, nothing may be applied to a guest'
	);
});

test("a guest's findings are ADVISORY — they never fail the gate", () => {
	// `drift` is what exits 1. A guest's slice placement is not this gate's
	// question at all (whether its backstop registration is online is
	// check-label-floor's), so its findings are printed and not counted.
	const src = code(mjs());
	assert.match(
		src,
		/if \(r\.advisory\) roleAdvisories\.push\(/,
		"a guest's problems must go to roleAdvisories"
	);
	assert.match(src, /else drift\.push\(`\$\{r\.machine\}/, 'and only a non-guest may reach drift');
	assert.match(
		src,
		/results\.some\(\(r\) => !r\.ok && !r\.advisory\)/,
		'nor may an unreachable guest fail the exit code'
	);
});

test('every node that was skipped by role is still PRINTED', () => {
	// A silent skip is how a node stops being checked and nobody notices — the
	// reason converge-toolchain prints its own, and the reason this one must.
	const src = code(mjs());
	assert.match(src, /\[skipped: guest\]/, 'the skip must be visible in human output');
});

test('a run whose every match was a guest is NOT a pass', () => {
	// Zero nodes looked at is not a pass even when every skip was deliberate:
	// exit 0 there is "I could not look" wearing "I chose not to look" as a
	// costume. `converge-toolchain` draws the same line.
	const src = code(mjs());
	const at = src.indexOf('if (!nodes.length)');
	assert.notEqual(at, -1);
	const block = src.slice(at, at + 700);
	assert.match(block, /skippedByRole\.length/, 'the refusal must name the role skip');
	assert.match(block, /process\.exit\(1\)/, 'and it must fail');
});

// ── the guest rule, RUN FOR REAL ────────────────────────────────────────────

/**
 * The tests above read source. These SPAWN the deployer, because what regresses
 * is the wiring — that the skip actually fires on the path the script takes, not
 * that the words are present. Same argument `node-role-gates.test.mjs` makes for
 * the two gates it drives.
 *
 * AGAINST A TEMP MANIFEST, NEVER THE OPERATOR'S, AND NEVER hokon. Node names are
 * `.invalid` (RFC 6761 reserved), so the resolver answers NXDOMAIN without
 * consulting anything and the ssh fails immediately rather than walking the
 * operator's search list — the flake `doctor-write.test.mjs` documents. Nothing
 * here can reach a real box, which is the point: the guest rule must be provable
 * without exercising it on the guest.
 */
function sliceFixture(machines) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-slice-role-'));
	const manifestDir = join(root, 'manifests');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(join(root, 'state'), { recursive: true });
	writeFileSync(
		join(manifestDir, 'fleet-runner-manifest.json'),
		JSON.stringify({ toolchain: { capabilities: [] }, machines }, null, 2)
	);
	return {
		root,
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: manifestDir,
			HADOKU_STATE_DIR: join(root, 'state'),
			HADOKU_SITE_ROOT: root,
		},
	};
}

/**
 * `{code, out, err, json()}`, STDOUT ONLY — `--json` is a contract and the cron
 * reads stdout.
 *
 * `code` is kept and asserted on: a non-zero exit WITH a parseable report is
 * this deployer's normal shape, not a failure, so the status is read alongside
 * the payload rather than instead of it. `json()` is separate from the capture
 * for the same reason — the refusal tests assert an EMPTY stdout, which is a
 * fact about the run and not a parse that went wrong.
 */
function runSlice(args, env) {
	const r = spawnCapture(process.execPath, [join(SCRIPTS, 'deploy-runners-slice.mjs'), ...args], {
		env,
		timeout: 120_000,
		label: `fleet slice ${args.join(' ')}`,
	});
	return { code: r.code, out: r.out, err: r.err, json: () => parseJsonStdout(r) };
}

const FX_CLAW = {
	role: 'claw',
	cores: 8,
	labels: [],
	maxConcurrent: 2,
	minFreeMb: 1024,
	slice: { swapMb: 4096, unitMaxMb: 4096 },
};
/** Identical but for the role, so only the role can be what decides. */
const FX_GUEST = { ...FX_CLAW, role: 'guest' };

test('run for real: a DRAINED unreachable node is deferred, and --check still reports', () => {
	// The deferred result once carried no notes/problems, and the mint-placement
	// judge read both: one drained, unreachable node crashed the whole check
	// with a TypeError and empty stdout (claw-6, 2026-10-27).
	const f = sliceFixture({ 'fx-drained.invalid': FX_CLAW, 'fx-claw.invalid': FX_CLAW });
	try {
		writeFileSync(
			join(f.root, 'state', 'fleet-drain.json'),
			JSON.stringify({
				nodes: {
					'fx-drained.invalid': { since: new Date().toISOString(), kind: 'maintenance' },
				},
			})
		);
		const r = runSlice(['--check', '--json'], f.env);
		assert.doesNotMatch(r.err, /TypeError/, r.err);
		const report = r.json();
		const drained = report.results.find((x) => x.machine === 'fx-drained.invalid');
		assert.equal(drained?.expectedDown, true, JSON.stringify(report.results));
		// The control: the undrained, unreachable claw is still a failure.
		assert.equal(report.results.find((x) => x.machine === 'fx-claw.invalid')?.ok, false);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('run for real: a guest is skipped and REPORTED, and the claw is still audited', () => {
	const f = sliceFixture({ 'fx-claw.invalid': FX_CLAW, 'fx-guest.invalid': FX_GUEST });
	try {
		const r = runSlice(['--check', '--json'], f.env);
		const report = r.json();
		assert.deepEqual(
			report.skippedByRole.map((s) => [s.node, s.role]),
			[['fx-guest.invalid', 'guest']],
			'the guest must appear in the report — a silent skip is how a node stops being checked'
		);
		assert.deepEqual(
			report.results.map((x) => x.machine),
			['fx-claw.invalid'],
			'and it must NOT appear as a node this run acted on'
		);
		// THE CONTROL. The claw is unresolvable, so it is UNREADABLE — which is a
		// failure and not a skip. Without this the test passes on a deployer that
		// skipped every node.
		assert.equal(report.results[0].ok, false);
		assert.equal(r.code, 1, 'a claw nobody could look at fails the gate');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('run for real: --machine <guest> reaches it, and everything it finds is ADVISORY', () => {
	const f = sliceFixture({ 'fx-claw.invalid': FX_CLAW, 'fx-guest.invalid': FX_GUEST });
	try {
		const r = runSlice(['--machine', 'fx-guest.invalid', '--check', '--json'], f.env);
		const report = r.json();
		assert.deepEqual(report.skippedByRole, [], 'naming it outright is the operator asking');
		assert.deepEqual(
			report.results.map((x) => [x.machine, x.role, x.advisory]),
			[['fx-guest.invalid', 'guest', true]]
		);
		// ZERO CLAWS LOOKED AT IS NOT A PASS. Auditing one guest fails on nothing,
		// and exiting 0 there would be "I could not look" in a costume.
		assert.equal(r.code, 1);
		assert.match(r.err, /every node this run looked at is a guest/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('run for real: --machine <guest> --confirm is REFUSED before anything runs', () => {
	// The exact command this gate's own fix hint printed until 2026-09-16.
	const f = sliceFixture({ 'fx-guest.invalid': FX_GUEST });
	try {
		const r = runSlice(['--machine', 'fx-guest.invalid', '--confirm'], f.env);
		assert.equal(r.code, 1);
		assert.match(r.err, /is a GUEST — refusing to converge it/);
		assert.equal(r.out, '', 'nothing on stdout — the refusal is not a report');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('run for real: a fleet of nothing but guests is a REFUSAL, not a clean pass', () => {
	// A manifest whose every match is skipped by role selects zero nodes, and a
	// deployer that matched nothing must never report a clean pass over nothing.
	const f = sliceFixture({ 'fx-guest.invalid': FX_GUEST });
	try {
		const r = runSlice(['--check'], f.env);
		assert.equal(r.code, 1);
		assert.match(r.err, /Every match is a guest/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ── the io controller reaches the slice ─────────────────────────────────────

/**
 * A JOB ROW CARRIES `ioReadBytes: null` BECAUSE THE CONTROLLER NEVER ARRIVES.
 *
 * Measured 2026-09-16: the kernel's root cgroup exposes io on all seven claws
 * and it accounts for real (`system.slice/ssh.service/io.stat` reads
 * `8:16 rbytes=405504 wbytes=262144 …`), but `user@<uid>.service` is delegated
 * `cpu memory pids` and `runners.slice` offers its children `memory pids`. The
 * installer's header carries the whole argument; these pin the two halves of the
 * fix and the one distinction that keeps the gate honest.
 *
 * DRIVEN, NOT GREPPED. The tests below RUN the installer against a scratch root
 * with `sudo`, `systemctl` and `pgrep` shimmed, so what is asserted is the file
 * it actually writes and the command it actually issues. Mutation-testing it
 * against the live target is the failure the guards exist to stop, and the
 * scratch root is the cheaper half of that bargain.
 */

/** `sudo` that drops its `-n` and runs the thing, so a scratch root is writable. */
const SUDO_SHIM = `#!/bin/sh
[ "$1" = "-n" ] && shift
[ "$1" = "true" ] && exit 0
exec "$@"
`;

/**
 * `systemctl` that answers from a canned table and RECORDS every call.
 *
 * The recording is the point for the re-exec assertions: what must never appear
 * is a restart of the user manager, and an absence is only provable against a
 * transcript.
 */
const SYSTEMCTL_SHIM = `#!/bin/sh
echo "systemctl $*" >>"$SHIM_REC"
# ONE STANDING RUNNER in the user manager, only when a test asks for it.
if [ -n "\${SHIM_STANDING:-}" ]; then
	case " $* " in
	*" --user "*"list-units"*"actions-runner-"*) echo "$SHIM_STANDING loaded active running x"; exit 0 ;;
	*"--user"*" show $SHIM_STANDING "*)
		case " $* " in
		*" -p ControlGroup "*) echo "/fake/user-manager/runners.slice/$SHIM_STANDING" ;;
		*" -p KillMode "*) echo mixed ;;
		*" -p Restart "*) echo always ;;
		*" -p Slice "*) echo runners.slice ;;
		*" -p MemoryMax "*) echo 4294967296 ;;
		*) echo "" ;;
		esac
		exit 0 ;;
	esac
fi
case " $* " in
*" show "*)
	case " $* " in
	*" -p LoadState "*) echo "not-found"; exit 0 ;;
	*" -p ControlGroup "*)
		case " $* " in *"user@"*) echo "/fake/user-manager" ;; *) echo "" ;; esac
		exit 0 ;;
	*" -p DefaultIOAccounting "*) echo "\${SHIM_IOACCT:-no}"; exit 0 ;;
	esac
	echo ""; exit 0 ;;
esac
exit 0
`;

/**
 * `pgrep -x Runner.Worker`: a node with a job in flight, or one without.
 *
 * The pid must name a process that is ALIVE and OWNED BY THIS USER, because the
 * installer does not take `pgrep`'s word for it — it answers "busy" by reading
 * `/proc/<pid>/cgroup`, and a pid it cannot stat reads as nobody busy. The
 * shim's own pid is no good: it runs inside a command substitution that has
 * already exited by the time the loop reads /proc.
 *
 * THIS TEST PROCESS's pid satisfies both, and PID 1 satisfies only the first.
 * PID 1 was used here until 2026-09-21 and it made this file pass on a
 * workstation and FAIL on every claw — which is where CI runs. The claws mount
 * /proc with `hidepid=invisible` and hokon does not, so root's PID 1 is simply
 * absent for the `hadoku` user on a claw: `/proc/1/cgroup` is ENOENT, the
 * installer's loop `continue`s, and the summary reports `busy=0` against a
 * fixture that asked for a busy node. Two deferral tests failed on main that
 * way, on a docs-only commit, with nothing in the diff to point at.
 *
 * Production was never affected and that is the whole reason the difference is
 * invisible: `Runner.Worker` runs as `hadoku`, the same user, so a real busy
 * worker's `/proc/<pid>/cgroup` is readable under hidepid exactly as it is
 * without it. Only a fixture that reached for ROOT's pid could tell the two
 * environments apart.
 */
const pgrepShim = (busy) => (busy ? `#!/bin/sh\necho ${process.pid}\n` : '#!/bin/sh\nexit 1\n');

const STANDING = 'actions-runner-fixture.service';

/**
 * Run the installer against a scratch /etc and a scratch cgroup tree.
 *
 * `installer` defaults to the real script; the mutation test passes a COPY with
 * one line removed, so nothing in this worktree is ever edited to prove a guard
 * bites — three other lanes are writing this tree.
 */
function runIoInstaller({
	installer = join(SCRIPTS, 'runners-slice-install.sh'),
	// The per-unit ceiling the caller computed. `null` stands in for a caller
	// that supplied none, which the installer must REFUSE rather than default.
	unitMb = '4096',
	controllers = 'cpu memory pids',
	subtree = 'memory pids',
	children = ['warm-fixture.service'],
	ioAcct = 'no',
	busy = false,
	root = null,
	// `false` stands in for a node where the slice is not where we looked — the
	// reads must answer "I could not look", never "no".
	cgroup = true,
	// The USER MANAGER's own cgroup.controllers — what its parent hands it. The
	// re-exec waits on this, so the default is the converged state; the pending
	// test passes a set without io.
	mgrControllers = 'cpu io memory pids',
	// A standing runner whose one process holds this oom_score_adj, or none.
	standingOom = null,
	apply = '1',
} = {}) {
	const dir = root ?? mkdtempSync(join(tmpdir(), 'fleet-slice-io-'));
	const bin = join(dir, 'bin');
	const slice = join(dir, 'cg', 'fake', 'user-manager', 'runners.slice');
	mkdirSync(bin, { recursive: true });
	if (cgroup) mkdirSync(slice, { recursive: true });
	for (const [name, body] of [
		['sudo', SUDO_SHIM],
		['systemctl', SYSTEMCTL_SHIM],
		['pgrep', pgrepShim(busy)],
	]) {
		writeFileSync(join(bin, name), body);
		chmodSync(join(bin, name), 0o755);
	}
	if (cgroup) {
		writeFileSync(join(dirname(slice), 'cgroup.controllers'), `${mgrControllers}\n`);
		writeFileSync(join(slice, 'cgroup.controllers'), `${controllers}\n`);
		writeFileSync(join(slice, 'cgroup.subtree_control'), subtree ? `${subtree}\n` : '');
		for (const c of children) mkdirSync(join(slice, c), { recursive: true });
	}
	if (standingOom !== null) {
		const unit = join(slice, STANDING);
		mkdirSync(unit, { recursive: true });
		writeFileSync(join(unit, 'memory.max'), `${4096 * 1024 * 1024}\n`);
		writeFileSync(join(unit, 'cgroup.procs'), '4242\n');
		mkdirSync(join(dir, 'proc', '4242'), { recursive: true });
		writeFileSync(join(dir, 'proc', '4242', 'oom_score_adj'), `${standingOom}\n`);
	}
	const rec = join(dir, 'calls.txt');
	writeFileSync(rec, '');
	// Through the same capture as everything else: this child's whole output is
	// the evidence, so a run killed at the timeout must say so rather than read
	// as an installer that printed no SUMMARY.
	const r = spawnCapture('bash', [installer], {
		timeout: 120_000,
		label: 'runners-slice-install.sh',
		env: {
			PATH: `${bin}:${process.env.PATH}`,
			HOME: join(dir, 'home'),
			SYS_DIR: join(dir, 'etc', 'systemd', 'system'),
			USER_CONF_DIR: join(dir, 'etc', 'systemd', 'user.conf.d'),
			CGROUP_ROOT: join(dir, 'cg'),
			PROC_ROOT: join(dir, 'proc'),
			...(standingOom === null ? {} : { SHIM_STANDING: STANDING }),
			SHIM_REC: rec,
			SHIM_IOACCT: ioAcct,
			// One second, not ten: the fixture answers immediately or not at all.
			IO_WAIT_SECS: '1',
			APPLY: apply,
			MAX_MB: '1000',
			SWAP_MB: '4096',
			...(unitMb === null ? {} : { UNIT_MB: unitMb }),
			CI_OOM: '500',
			SLICE_NAME: 'runners.slice',
		},
	});
	const out = `${r.out}${r.err}`;
	const summary = Object.fromEntries(
		(out.split('\n').find((l) => l.startsWith('SUMMARY ')) ?? '')
			.slice('SUMMARY '.length)
			.split(/\s+/)
			.filter((t) => t.includes('='))
			.map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)])
	);
	const read = (p) => {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			return null;
		}
	};
	// The uid is whatever runs the tests, so the drop-in dir is found rather than
	// spelled — the installer derives it from `id -u` and must be free to.
	const dropinRoot = join(dir, 'etc', 'systemd', 'system');
	let delegate = null;
	try {
		for (const e of readdirSync(dropinRoot)) {
			if (e.startsWith('user@') && e.endsWith('.service.d'))
				delegate = read(join(dropinRoot, e, '10-runners-io.conf'));
		}
	} catch {
		delegate = null;
	}
	return {
		dir,
		out,
		summary,
		delegate,
		accounting: read(join(dir, 'etc', 'systemd', 'user.conf.d', '10-runners-io.conf')),
		calls: read(rec) ?? '',
	};
}

/**
 * THE ASSERTIONS THE MUTATION MUST BREAK.
 *
 * Factored out so the mutation test can drive them against a mutated copy of the
 * installer instead of against an edited working tree.
 */
function assertIoInstall(r) {
	assert.ok(r.delegate, 'no Delegate= drop-in was written for the user manager');
	// `Delegate=` is the UNIT-FILE key. `DelegateControllers=` is the read-only
	// D-Bus property `systemctl show` prints, and systemd IGNORES it in a unit
	// file — "Unknown key 'DelegateControllers' in section [Service]" on systemd
	// 257, checked with systemd-analyze. A drop-in spelled that way installs
	// cleanly, reloads cleanly and delegates nothing.
	assert.match(r.delegate, /^Delegate=.*\bio\b/m, 'the drop-in must delegate io');
	assert.doesNotMatch(
		r.delegate,
		/DelegateControllers\s*=/,
		'DelegateControllers= is not a unit-file key — systemd ignores it'
	);
	// The stock user@.service delegates `pids memory cpu`; dropping one of those
	// to add io would take memory accounting away from every runner.
	for (const c of ['pids', 'memory', 'cpu'])
		assert.match(r.delegate, new RegExp(`^Delegate=.*\\b${c}\\b`, 'm'), `${c} must survive`);
	// HALF TWO. Delegation alone stops at the slice: a controller is listed in a
	// cgroup's subtree_control because a MEMBER asks for it, and a minted unit
	// asks for memory and nothing else.
	assert.ok(r.accounting, 'no DefaultIOAccounting drop-in was written for the user manager');
	assert.match(r.accounting, /^\[Manager\]$/m);
	assert.match(r.accounting, /^DefaultIOAccounting=yes$/m);
}

test('the installer delegates io AND turns on IO accounting for the user manager', () => {
	const r = runIoInstaller();
	try {
		assertIoInstall(r);
		// Both halves are counted as work done, so a converge pass reports it and
		// the operator can see the node change rather than guessing it did.
		assert.equal(r.summary.changed, '2', 'both drop-ins are one change each');
		assert.equal(r.summary.needs_operator, '0', 'sudo was available in this fixture');
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('the user manager is RE-EXEC’d, never restarted', () => {
	// A manager computes the controllers it may use once, at startup, so one that
	// was already running when the delegation landed cannot use io until it
	// re-executes. `daemon-reexec` serializes its state and restores it; every
	// running unit survives. Restarting user@<uid>.service would kill every live
	// job on the node, which is the same rule `place()` follows for a BUSY unit.
	const r = runIoInstaller();
	try {
		assert.match(r.calls, /^systemctl --user daemon-reexec$/m, 'the user manager must re-exec');
		assert.doesNotMatch(
			r.calls,
			/systemctl (restart|stop|start|kill).*user@/,
			'nothing here may restart the user manager'
		);
		// And the SYSTEM manager has to re-realize the cgroup before the re-exec
		// can find anything new to use.
		assert.match(r.calls, /^systemctl daemon-reload$/m);
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('a runner mid-job DEFERS the re-exec instead of taking it', () => {
	const r = runIoInstaller({ busy: true });
	try {
		assert.match(r.out, /IO-REEXEC-DEFERRED/);
		assert.doesNotMatch(r.calls, /daemon-reexec/, 'never while a job is in flight');
		// The drop-ins are still written — they are inert until the re-exec, and
		// leaving them unwritten would mean the node never converges.
		assertIoInstall(r);
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('the io facts come from the KERNEL and the live manager, and reach the summary', () => {
	const on = runIoInstaller({
		controllers: 'cpu memory pids io',
		subtree: 'memory pids io',
		ioAcct: 'yes',
	});
	const off = runIoInstaller();
	try {
		assert.equal(on.summary.io_ctrl, 'yes');
		assert.equal(on.summary.io_subtree, 'yes');
		assert.equal(on.summary.io_acct, 'yes');
		// The drop-ins were just written in BOTH runs. `off` still reports no,
		// which is the point: a verifier that read its own writer's artifact
		// could not fail here.
		assert.equal(off.summary.io_ctrl, 'no');
		assert.equal(off.summary.io_subtree, 'no');
		assert.equal(off.summary.io_acct, 'no');
	} finally {
		for (const r of [on, off]) rmSync(r.dir, { recursive: true, force: true });
	}
});

test('an EMPTY slice is `empty`, not `no` — and an unreadable one is neither', () => {
	// A cgroup with no members lists nothing in subtree_control for ANY
	// controller. claw-2 measured 0 children and a blank subtree_control on
	// 2026-09-16, against `memory pids` on the six claws that held something, and
	// under all-JIT an idle claw is routinely in that state. Reading it as drift
	// would redden a correct fleet every time the fleet went quiet.
	const empty = runIoInstaller({
		controllers: 'cpu memory pids io',
		subtree: '',
		children: [],
		ioAcct: 'yes',
	});
	// And a slice that HOLDS something while offering it no io is real drift, so
	// the two must not collapse into one value.
	const held = runIoInstaller({ controllers: 'cpu memory pids io', ioAcct: 'yes' });
	try {
		assert.equal(empty.summary.io_subtree, 'empty');
		assert.equal(held.summary.io_subtree, 'no');
		// "I could not look" is its own answer and never `no` — there is no cgroup
		// here at all, which on a real node means the slice is not where we looked.
		const blind = runIoInstaller({ cgroup: false });
		rmSync(blind.dir, { recursive: true, force: true });
		assert.equal(blind.summary.io_ctrl, '-');
		assert.equal(blind.summary.io_subtree, '-');
	} finally {
		for (const r of [empty, held]) rmSync(r.dir, { recursive: true, force: true });
	}
});

test('the io writes are idempotent — a converged node re-execs nothing', () => {
	// `$(cat file)` strips trailing newlines and the body variable does not, so a
	// naive comparison never matches and every pass rewrites, reports `changed`
	// and re-execs the user manager. That is a manager re-exec on every 10-minute
	// tick forever, for no change at all.
	const first = runIoInstaller();
	try {
		assert.match(first.calls, /daemon-reexec/);
		// Same root, and this time the slice HAS io — the node is converged, so the
		// second pass must write nothing and re-exec nothing.
		const second = runIoInstaller({
			root: first.dir,
			controllers: 'cpu memory pids io',
			ioAcct: 'yes',
		});
		assert.equal(second.summary.changed, '0', 'the drop-ins were already correct');
		assert.doesNotMatch(second.calls, /daemon-reexec/, 'and a converged node re-execs nothing');
	} finally {
		rmSync(first.dir, { recursive: true, force: true });
	}
});

test('the auditor FAILS on a slice with no io, and does not fail on an empty one', () => {
	const src = code(mjs());
	assert.match(src, /kv\.io_ctrl !== 'yes'/, 'a slice without the controller is drift');
	assert.match(src, /kv\.io_acct !== 'yes'/, 'delegation without an asker reaches the slice only');
	assert.match(
		src,
		/kv\.io_subtree === 'no'/,
		'a slice that holds members and offers no io is drift'
	);
	assert.match(
		src,
		/kv\.io_subtree !== 'yes' && kv\.io_subtree !== 'empty'/,
		'`empty` must be accepted and anything unrecognised must still fail'
	);
	// MISSING IS NOT FINE. A SUMMARY without the facts means this run did not
	// look, and "I could not look" is never "nothing is wrong".
	assert.match(src, /kv\.io_ctrl === undefined/);
	// And it must reach `problems`, which is the only thing --check turns into a
	// non-zero exit. A note nobody fails on is a note nobody reads.
	assert.match(
		src,
		/problems\.push\(\s*\n?\s*`io is delegated to the user manager but has not reached/
	);
});

/**
 * THE MUTATION. Remove the io line from a COPY of the installer — never from the
 * working tree, which three other lanes are writing — and the guard must go red.
 * A guard that passes against a broken installer is the whole failure mode.
 */
test('MUTATION: an installer that does not delegate io fails the guard', () => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-slice-io-mut-'));
	try {
		const original = readFileSync(join(SCRIPTS, 'runners-slice-install.sh'), 'utf8');
		for (const [what, mutated] of [
			[
				'the delegate line',
				original.replace('Delegate=pids memory cpu io', 'Delegate=pids memory cpu'),
			],
			[
				'the accounting line',
				original.replace('[Manager]\nDefaultIOAccounting=yes', '[Manager]\nDefaultIOAccounting=no'),
			],
		]) {
			assert.notEqual(mutated, original, `the mutation of ${what} matched nothing`);
			const copy = join(dir, 'mutated.sh');
			writeFileSync(copy, mutated);
			const r = runIoInstaller({ installer: copy, root: join(dir, `run-${what.length}`) });
			assert.throws(
				() => assertIoInstall(r),
				assert.AssertionError,
				`removing ${what} must fail the guard`
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * WHAT THE FIRST FLEET-WIDE CONVERGE ACTUALLY DID (2026-09-16).
 *
 * `--confirm` reported EXIT=0, `changed=2` on 7/7, no notes. `--check` then
 * reported `io_ctrl=no` on 7/7. Both drop-ins were on disk and correct
 * everywhere, and `user@1000.service` carried io in its own `cgroup.controllers`
 * on all seven — the delegation half landed. What had not happened was the
 * user-manager re-exec, on FIVE of the seven, and the journal says why:
 *
 *   claw-2 18:05:24 Reexecuting.   (no job in flight)
 *   claw-4 18:05:35 Reexecuting.   (between two jobs)
 *   claw-1 / -3 / -5 / -6 / -7     no re-execution logged at all
 *
 * and each of those five was mid-job at the instant the pass reached it
 * (claw-1 `lint`, claw-3 `site-tests`, claw-5 `auto-format`, claw-6 `build`,
 * claw-7 an `update` that was later cancelled). The BUSY deferral did exactly
 * what it was written to do. `IO-REEXEC-DEFERRED` was printed five times and the
 * auditor's note filter dropped every one, so the converge looked complete.
 *
 * That is the failure `the drift line survives the auditor filter` already
 * guards for SLICE-PLACEMENT-DRIFT, one prefix at a time. These generalise it:
 * every prefix the installer emits must be one the auditor keeps.
 */
test('every note prefix the installer emits survives the auditor filter', () => {
	const src = shCode(sh());
	const emitted = new Set(
		[...src.matchAll(/^\s*echo "([A-Z][A-Z-]+) /gm)].map((m) => m[1]).filter((p) => p.includes('-'))
	);
	assert.ok(emitted.size >= 5, `expected a handful of note prefixes, found ${[...emitted]}`);
	const filter = code(mjs()).match(/\/\^\(([A-Z|-]+)\) \//);
	assert.ok(filter, 'the note filter must still be a prefix alternation');
	const kept = new Set(filter[1].split('|'));
	// Prefixes that are deliberately NOT collected, each with the reason. This
	// list is the decision point: a prefix added to the installer lands in
	// neither set and fails here until somebody classifies it, which is the whole
	// mechanism IO-REEXEC-DEFERRED went around.
	const informational = new Map([
		['SLICE-UNMANAGED', 'states a configured policy (manageUnit:false), not a finding'],
		[
			'SLICE-USER-CREATED',
			'reports a write the run just made, and the ceilings are audited anyway',
		],
	]);
	const unclassified = [...emitted].filter((p) => !kept.has(p) && !informational.has(p));
	assert.deepEqual(
		unclassified,
		[],
		`the installer emits these and the auditor neither collects nor excuses them: ${unclassified.join(', ')}`
	);
	for (const p of informational.keys())
		assert.ok(emitted.has(p), `${p} is excused but no longer emitted — drop it from the list`);
});

test('the deferral and the failure reason are both notes, and both say WHY', () => {
	const src = shCode(sh());
	// A deferral that does not name the fix is a dead end: the node never
	// converges and nothing says what would make it.
	assert.match(src, /IO-REEXEC-DEFERRED[^"]*re-run --confirm when this node is idle/);
	// `2>/dev/null` on the re-exec turned "could not reach the bus" and "the
	// manager refused" into the same silence. CLAUDE.md's rule: carry the reason.
	assert.match(src, /IO-REEXEC-FAILED \$\(printf/, 'the re-exec failure must carry its stderr');
	assert.doesNotMatch(
		src,
		/systemctl --user daemon-reexec 2>\/dev\/null/,
		'the re-exec must not discard its reason'
	);
});

test('the re-exec waits for the KERNEL to show io, and never re-execs into a stale set', () => {
	// `systemctl daemon-reload` answers when the reload is ACCEPTED; the cgroup
	// realize queue drains afterwards. A manager that re-execs in that window
	// samples a controller set without io and keeps it until something re-execs
	// it again — a race whose loser reports success.
	const src = shCode(sh());
	assert.match(src, /io_ready=no/, 'the wait must have an explicit not-yet state');
	assert.match(
		src,
		/cat "\$CGROOT\$io_deleg_cg\/cgroup\.controllers"/,
		'it must poll the kernel file the user manager is about to read'
	);
	assert.match(src, /IO-DELEGATE-PENDING/, 'and say so when it never arrives');
	// The wait must GATE the re-exec, not merely precede it.
	assert.match(
		src,
		/if \[ "\$io_ready" != yes \]; then[\s\S]{0,600}?IO-DELEGATE-PENDING[\s\S]{0,600}?elif[\s\S]{0,200}?daemon-reexec/,
		'the re-exec must sit behind the readiness check, not beside it'
	);
});

test('the user-manager reload comes AFTER the re-exec, never before', () => {
	// A re-exec restores the units it was already running, so nothing it restores
	// is re-realized. Measured on claw-2 and claw-4: the manager came back with
	// DefaultIOAccounting=yes and every unit reporting IOAccounting=yes, and the
	// subtree_control chain was untouched. The reload is what re-reads the unit
	// files against the new manager defaults and queues the realization. Ordered
	// the other way round it reloads against the OLD controller set.
	const src = shCode(sh());
	const reexec = src.indexOf('systemctl --user daemon-reexec');
	assert.ok(reexec > 0, 'the re-exec must still be there');
	const reloadAfter = src.indexOf('systemctl --user daemon-reload', reexec);
	assert.ok(
		reloadAfter > reexec,
		'a --user daemon-reload must follow the re-exec in the same branch'
	);
	// And it must be INSIDE the success branch: reloading after a re-exec that
	// failed would realize against the controller set that is still wrong.
	assert.match(
		src,
		/daemon-reexec 2>&1\); then[\s\S]{0,900}?systemctl --user daemon-reload/,
		'the reload belongs to the re-exec success branch'
	);
});

test('io_deleg separates "the drop-in landed" from "the manager is using it"', () => {
	// One value covering both made the first converge unreadable: 7/7 reported
	// io_ctrl=no when the Delegate= drop-in had landed on 7/7 and the re-exec had
	// been deferred on 5. Those are two different jobs for an operator.
	assert.match(shCode(sh()), /io_deleg=\$\(has_io "\$CGROOT\$mgr_cg\/cgroup\.controllers"\)/);
	assert.match(shCode(sh()), /SUMMARY io_deleg=\$io_deleg/, 'and it must reach the auditor');
	const src = code(mjs());
	assert.match(src, /kv\.io_deleg !== 'yes'/, 'a missing delegation is its own problem');
	assert.match(
		src,
		/else if \(kv\.io_ctrl !== 'yes'\)/,
		'and io_ctrl is only reported once the delegation is known to be there'
	);
	assert.match(src, /kv\.io_deleg === undefined/, 'a summary without it did not look');
});

test('MUTATION: an auditor that drops a note prefix, or loses the reload, fails the guard', () => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-slice-io-mut2-'));
	try {
		const shSrc = readFileSync(join(SCRIPTS, 'runners-slice-install.sh'), 'utf8');
		// The regression that actually shipped: the prefix exists on the emitting
		// side and not on the reading side.
		const mjsSrc = readFileSync(join(SCRIPTS, 'deploy-runners-slice.mjs'), 'utf8');
		const dropped = mjsSrc.replace('|IO-REEXEC-DEFERRED', '');
		assert.notEqual(dropped, mjsSrc, 'the prefix must be in the filter to begin with');
		const filter = blankComments(dropped).match(/\/\^\(([A-Z|-]+)\) \//);
		const kept = new Set(filter[1].split('|'));
		assert.ok(!kept.has('IO-REEXEC-DEFERRED'), 'mutation applied');
		const emitted = new Set(
			[...shCode(shSrc).matchAll(/^\s*echo "([A-Z][A-Z-]+) /gm)]
				.map((m) => m[1])
				.filter((p) => p.includes('-'))
		);
		assert.ok(
			[...emitted].some((p) => !kept.has(p)),
			'the guard must see the dropped prefix'
		);
		// And the ordering: a reload moved back before the re-exec must fail.
		const reordered = shSrc.replace(
			/(elif ! io_err=\$\(XDG_RUNTIME_DIR="\/run\/user\/\$\(id -u\)" systemctl --user daemon-reexec)/,
			'XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user daemon-reload 2>/dev/null\n\t\t\t$1'
		);
		assert.notEqual(reordered, shSrc, 'the reorder mutation matched nothing');
		const r = shCode(reordered);
		const rx = r.indexOf('systemctl --user daemon-reexec');
		assert.ok(
			r.lastIndexOf('systemctl --user daemon-reload', rx) > 0,
			'a reload now precedes the re-exec, which is the bug this guards'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('io not yet handed down: the run says PENDING and does not re-exec', () => {
	// The race this closes: `systemctl daemon-reload` answers when the reload is
	// accepted, and the realize queue drains after. A user manager that re-execs
	// inside that window samples a controller set without io and keeps it — the
	// re-exec is spent, everything reports success, and nothing is delegated.
	const r = runIoInstaller({ mgrControllers: 'cpu memory pids' });
	try {
		assert.match(r.out, /IO-DELEGATE-PENDING/);
		assert.doesNotMatch(
			r.calls,
			/daemon-reexec/,
			'never into a controller set we can see is stale'
		);
		assert.equal(r.summary.io_deleg, 'no', 'and the summary says which half is missing');
		// The drop-ins are still written: they are what the next pass converges on.
		assertIoInstall(r);
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('io_deleg and io_ctrl are read from DIFFERENT cgroups', () => {
	// The bug this prevents is reading one fact twice. On 2026-09-16 the fleet
	// sat at io_deleg=yes / io_ctrl=no on 7/7 — if these collapsed to one read,
	// that state would be unreportable and the operator would be told the
	// delegation had failed when it had not.
	const r = runIoInstaller({
		mgrControllers: 'cpu io memory pids',
		controllers: 'cpu memory pids',
	});
	try {
		assert.equal(r.summary.io_deleg, 'yes', 'the user manager HAS io');
		assert.equal(r.summary.io_ctrl, 'no', 'and the slice has not been given it yet');
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('a second --confirm still re-execs a node whose re-exec was deferred', () => {
	// THE DEAD END THIS CLOSES. The first converge wrote both drop-ins and
	// deferred the re-exec on five claws for being mid-job. On the next pass the
	// files are already correct, so nothing is written — and a re-exec keyed on
	// "did we just write something" would skip those five forever while every run
	// reported changed=0 and exited clean. The repair has to read the same
	// observed state the gate does, or the two share a blind spot and fail
	// together.
	const first = runIoInstaller({ busy: true });
	try {
		assert.match(first.out, /IO-REEXEC-DEFERRED/, 'busy, so deferred');
		assert.doesNotMatch(first.calls, /daemon-reexec/);
		// Same root: the drop-ins are on disk and correct, so io_wrote is 0.
		const second = runIoInstaller({ root: first.dir, busy: false });
		assert.equal(second.summary.changed, '0', 'nothing left to write');
		assert.match(second.calls, /daemon-reexec/, 'and it must STILL re-exec');
	} finally {
		rmSync(first.dir, { recursive: true, force: true });
	}
});

test('driving on observed state does not re-exec a converged node every tick', () => {
	// The other side of the same coin. `--confirm` runs repeatedly; once the slice
	// actually has io there is nothing left to do, and re-execing the user manager
	// on every pass would be a needless disturbance forever.
	const converged = { controllers: 'cpu memory pids io', ioAcct: 'yes' };
	const first = runIoInstaller(converged);
	try {
		// The very first pass still writes the drop-ins, so it re-execs once.
		assert.equal(first.summary.changed, '2');
		for (let i = 0; i < 2; i++) {
			const again = runIoInstaller({ root: first.dir, ...converged });
			assert.equal(again.summary.io_ctrl, 'yes', 'the slice already has io');
			assert.equal(again.summary.changed, '0', 'nothing to write');
			assert.doesNotMatch(again.calls, /daemon-reexec/, `pass ${i + 2} must do nothing`);
		}
	} finally {
		rmSync(first.dir, { recursive: true, force: true });
	}
});

// ── one cap rule, and a clipped window says so (#44) ────────────────────────

/**
 * TWO PROVISIONING PATHS MUST NOT CARRY TWO RULES.
 *
 * Measured on claw-4, 2026-09-19: the standing
 * `actions-runner-hadoku-fleet-manager.service` read `MemoryMax=4294967296`
 * while `warm-claw-4-hadoku-fleet-manager.service` — minted by this package,
 * onto the same box, into the same slice — read `14562623488`. One box, one
 * slice, two per-unit ceilings differing by 3.4x.
 *
 * The deployer passed the DECLARED `slice.unitMaxMb` flat; the minter computes
 * it with `unitMemoryMaxMb()` from the node's measured ceiling and may only
 * widen. Issue #26 had already ruled the flat one wrong — brave-quartet's
 * `wasm-size` job OOM-killed against its own 4 GiB, recorded by GitHub as
 * CANCELLED so nothing in CI said "out of memory" — and the ruling reached only
 * the path that asked.
 *
 * These are source guards for the reason the file's header gives: the behaviour
 * needs systemd and a live fleet. What CAN be pinned is that the deployer still
 * ASKS, and that the installer still has nowhere to guess from.
 */
test('the deployer computes the per-unit cap with the MINTER’s rule', () => {
	const src = code(mjs());
	assert.match(
		src,
		/import \{ unitMemoryMaxMb \} from '\.\.\/dist\/runners\/ephemeral\.js'/,
		'the cap rule is unitMemoryMaxMb in src/runners/ephemeral.ts, imported BUILT so there is ' +
			'only one implementation to drift from — the isLocalNode rule, applied here'
	);
	assert.match(
		src,
		/unitMemoryMaxMb\(\{[\s\S]{0,200}?requestedMb:\s*cfg\.unitMaxMb/,
		'the declared unitMaxMb is an INPUT to the rule, never the answer'
	);
});

test('UNIT_MB is the computed cap, never the declared number', () => {
	const src = code(mjs());
	assert.doesNotMatch(
		src,
		/UNIT_MB=\$\{[^}]*unitMaxMb/,
		'passing slice.unitMaxMb straight through is the flat cap #26 ruled wrong'
	);
	assert.doesNotMatch(
		src,
		/UNIT_MB=\$\{[^}]*\?\?\s*\d+/,
		'a `?? <number>` in the payload is a second rule for a question unitMemoryMaxMb answers'
	);
	assert.match(src, /`UNIT_MB=\$\{unitMb\}`/, 'the payload carries the computed number');
});

test('a node whose MemTotal could not be read gets NO cap, not a guessed one', () => {
	const src = code(mjs());
	// The ceiling is `measured MemTotal - minFreeMb`, so a node that will not say
	// how much memory it has cannot be sized for. "I could not look" must never
	// render as a flat 4096 written to a box nobody measured.
	assert.match(
		src,
		/probedMemTotalMb === null\)\s*\{[\s\S]{0,600}?recordUnreadable\(/,
		'an unreadable MemTotal must fail the node the way an unreadable SUMMARY does'
	);
	assert.match(src, /MEMTOTAL-END/, 'the probe needs a sentinel, or a dead ssh reads as 0 MB');
});

test('the installer has no default per-unit cap at all', () => {
	const src = shCode(sh());
	assert.doesNotMatch(
		src,
		/UNIT_MB:-\s*\d/,
		'a default here is what let the deployer and the minter diverge silently'
	);
	assert.match(
		src,
		/SLICE-FAIL UNIT_MB is required/,
		'a caller that supplies no UNIT_MB gets a refusal, and the refusal says why'
	);
});

test('run for real: the installer REFUSES a caller that supplies no UNIT_MB', () => {
	const r = runIoInstaller({ unitMb: null });
	try {
		assert.match(r.out, /SLICE-FAIL UNIT_MB is required/);
		// NO SUMMARY. `deploy-runners-slice.mjs` reads the SUMMARY line and treats
		// its absence as a failed node, so the refusal has to stop before one is
		// printed — a SLICE-FAIL followed by a SUMMARY would be reported as a
		// successful pass carrying a note.
		assert.equal(r.summary.unit_mb, undefined, 'a refused run prints no SUMMARY');
		assert.equal(r.delegate, null, 'and writes nothing');
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('run for real: an explicit UNIT_MB is applied, so the refusal is about ABSENCE', () => {
	// THE CONTROL. Without it the test above passes on an installer that refuses
	// every run, which would be a fleet-wide outage wearing a guard's clothes.
	const r = runIoInstaller({ unitMb: '13888' });
	try {
		assert.equal(r.summary.unit_mb, '13888');
		assert.ok(r.delegate, 'a run with a cap still does the work');
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('MUTATION: a deployer that passes the declared number flat fails the guard', () => {
	// The exact line this change deleted, restored in a COPY — nothing in this
	// worktree is edited to prove a guard bites; three other lanes write here.
	const mutated = code(mjs()).replace(
		'`UNIT_MB=${unitMb}`',
		'`UNIT_MB=${sliceCfg.unitMaxMb ?? 4096}`'
	);
	assert.notEqual(mutated, code(mjs()), 'the mutation must actually change something');
	let failures = 0;
	for (const [why, re] of [
		['flat declared value', /UNIT_MB=\$\{[^}]*unitMaxMb/],
		['a defaulted number', /UNIT_MB=\$\{[^}]*\?\?\s*\d+/],
	]) {
		if (re.test(mutated)) failures++;
		else assert.fail(`the reverted deployer slipped past the ${why} guard`);
	}
	assert.equal(failures, 2, 'both halves of the guard must bite on the revert');
	assert.doesNotMatch(mutated, /`UNIT_MB=\$\{unitMb\}`/);
});

test('MUTATION: an installer that defaults UNIT_MB fails the guard, and stops refusing', () => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-slice-unitmb-'));
	try {
		const mutant = join(dir, 'mutant.sh');
		const src = sh().replace('UNIT_MB="${UNIT_MB-}"', 'UNIT_MB="${UNIT_MB:-4096}"');
		assert.notEqual(src, sh(), 'the mutation must actually change something');
		writeFileSync(mutant, src);
		// The source guard bites...
		assert.match(shCode(src), /UNIT_MB:-\s*\d/, 'the reverted default slipped past the scan');
		// ...and so does the behaviour: the mutant SILENTLY installs 4096.
		const r = runIoInstaller({ installer: mutant, unitMb: null, root: join(dir, 'run') });
		assert.equal(r.summary.unit_mb, '4096', 'the revert is exactly the silent flat cap');
		assert.doesNotMatch(r.out, /SLICE-FAIL UNIT_MB is required/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── the sizing input must not be bounded by the limit it sets ───────────────

/**
 * A CGROUP KILL TRUNCATES THE WINDOW THAT MEASURES IT.
 *
 * `runner-mem-harvest.py` records the observed anon high-water per job. When
 * the job is OOM-killed at the unit's `memory.max`, the peak can never exceed
 * the cap that killed it — so the number is a FLOOR, and a percentile over
 * floors sizes the next cap from the last cap.
 *
 * brave-quartet is the case: its only two windows are its two killed runs
 * (2026-09-19 10:55 and 11:26, `CONSTRAINT_MEMCG`, anon-rss 3830164kB) and it
 * reported 3,739 MiB — one hair under the 4 GiB that stopped it.
 *
 * DRIVEN, not grepped. Both scripts are RUN against a scratch cgroup tree and a
 * scratch JSONL, so what is asserted is what they actually emit.
 */
const PY = 'python3';

/** Build a fake cgroup tree holding one runner unit, and return its dir. */
function memFixture({ oomKills = 0, anonBytes = 3_900_000_000, capBytes = 4_294_967_296 }) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-mem-'));
	const unit = join(dir, 'cg', 'system.slice', 'actions-runner-fixture.service');
	mkdirSync(unit, { recursive: true });
	writeFileSync(join(unit, 'memory.stat'), `anon ${anonBytes}\nfile 100000\nshmem 0\nslab 0\n`);
	writeFileSync(join(unit, 'memory.swap.current'), '0\n');
	writeFileSync(join(unit, 'memory.current'), String(anonBytes + 100000) + '\n');
	writeFileSync(join(unit, 'memory.max'), `${capBytes}\n`);
	writeFileSync(join(unit, 'memory.events'), `low 0\nhigh 0\nmax 3\noom 1\noom_kill ${oomKills}\n`);
	// `cgroup.procs` holds this test process, whose comm is not Runner.Worker —
	// the harvest decides "a job is running" by comm, so the fixture drives it
	// through a shim on /proc rather than by faking a process.
	writeFileSync(join(unit, 'cgroup.procs'), '');
	return { dir, unit };
}

/**
 * Run the harvest for exactly two sweeps over a fixture, with the worker
 * present on the first and gone on the second, and return the record it wrote.
 *
 * The harvest loops forever by design, so it is driven through a tiny wrapper
 * that imports it, patches the two facts a scratch tree cannot provide
 * (`has_worker`, and the cgroup root) and calls one iteration's worth of the
 * body. Patching the module is the seam; the LOGIC under test — the oom_kill
 * delta, the reset detection and the `clipped` flag — is the real code.
 */
function runHarvest({ kills = [0, 0], capBytes = 4_294_967_296, anonBytes = 3_900_000_000 }) {
	const f = memFixture({ oomKills: kills[0], anonBytes, capBytes });
	const out = join(f.dir, 'samples.jsonl');
	const driver = join(f.dir, 'drive.py');
	writeFileSync(
		driver,
		[
			'import importlib.util, pathlib',
			`spec = importlib.util.spec_from_file_location("h", ${JSON.stringify(join(SCRIPTS, 'runner-mem-harvest.py'))})`,
			'h = importlib.util.module_from_spec(spec)',
			'spec.loader.exec_module(h)',
			`h.CG = pathlib.Path(${JSON.stringify(join(f.dir, 'cg'))})`,
			`h.OUT = pathlib.Path(${JSON.stringify(out)})`,
			`h.INFLIGHT = pathlib.Path(${JSON.stringify(join(f.dir, 'inflight.json'))})`,
			// The two facts a scratch tree cannot provide: whether a Runner.Worker
			// is in the cgroup (a real pid's comm) and the passage of time. Every
			// line UNDER TEST — the oom_kill delta, the reset detection, the
			// `clipped` flag — is the real module's.
			'state = {"running": True}',
			'h.has_worker = lambda d: state["running"]',
			`kills = ${JSON.stringify(kills)}`,
			'ev = h.CG / "system.slice" / "actions-runner-fixture.service" / "memory.events"',
			'n = {"i": 0}',
			'def fake_sleep(_):',
			'    n["i"] += 1',
			'    if n["i"] < len(kills):',
			'        ev.write_text("oom_kill %d\\n" % kills[n["i"]])',
			'    elif n["i"] == len(kills):',
			'        state["running"] = False',
			'    else:',
			'        raise KeyboardInterrupt',
			'h.time.sleep = fake_sleep',
			'try:',
			'    h.main()',
			'except KeyboardInterrupt:',
			'    pass',
		].join('\n')
	);
	const r = spawnCapture(PY, [driver], {
		timeout: 60_000,
		label: 'runner-mem-harvest.py (driven)',
	});
	const lines = (() => {
		try {
			return readFileSync(out, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		} catch {
			return [];
		}
	})();
	return { dir: f.dir, rec: lines[0] ?? null, stderr: r.err ?? '', code: r.code };
}

test('the harvest marks a window whose cgroup recorded an OOM kill', () => {
	// The counter steps 0 -> 1 while the job runs: a kill inside this window.
	const r = runHarvest({ kills: [0, 1] });
	try {
		assert.ok(r.rec, `no record was written: ${r.stderr.slice(0, 400)}`);
		assert.equal(r.rec.clipped, true);
		assert.equal(r.rec.oom_kills, 1);
		// The cap is carried so the floor can be read against the thing that set it.
		assert.equal(r.rec.cap_mb, 4096);
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('a window with no kill is NOT marked — the flag is written either way', () => {
	// THE CONTROL, and the second half of the contract: a key that appears only
	// on failure cannot be told apart from a harvest too old to have the key.
	const r = runHarvest({ kills: [0, 0] });
	try {
		assert.ok(r.rec, `no record was written: ${r.stderr.slice(0, 400)}`);
		assert.equal(r.rec.clipped, false);
		assert.equal(r.rec.oom_kills, 0);
		assert.equal(r.rec.cgroup_reset, false);
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('a cgroup recreated mid-window is clipped too, not counted as -1 kills', () => {
	// A standing runner is Restart=always, so a cgroup kill is followed by
	// systemd recreating the cgroup with the counter back at zero. End-minus-
	// start would read that as a NEGATIVE delta and score the window clean —
	// the one window that most needs marking.
	const r = runHarvest({ kills: [7, 0] });
	try {
		assert.ok(r.rec, `no record was written: ${r.stderr.slice(0, 400)}`);
		assert.equal(r.rec.cgroup_reset, true);
		assert.equal(r.rec.clipped, true);
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

/** Run the report over a scratch JSONL and a scratch manifest. */
function runReport(
	rows,
	{ machines = { 'fx-claw.invalid': { ramGb: 16, maxConcurrent: 2 } } } = {}
) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-memreport-'));
	const manifests = join(dir, 'manifests');
	mkdirSync(manifests, { recursive: true });
	writeFileSync(
		join(manifests, 'fleet-runner-manifest.json'),
		JSON.stringify({ machines }, null, 2)
	);
	const samples = join(dir, 'samples.jsonl');
	writeFileSync(samples, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
	// `collect()` shells out per node; the fixture node is unresolvable, so the
	// rows are injected through a driver the same way the harvest one is.
	const driver = join(dir, 'drive.py');
	writeFileSync(
		driver,
		[
			'import importlib.util, json, pathlib, sys',
			`spec = importlib.util.spec_from_file_location("rp", ${JSON.stringify(join(SCRIPTS, 'runner-mem-report.py'))})`,
			'rp = importlib.util.module_from_spec(spec)',
			'spec.loader.exec_module(rp)',
			`rows = [json.loads(l) for l in pathlib.Path(${JSON.stringify(samples)}).read_text().splitlines() if l]`,
			'rp.collect = lambda nodes: (rows, [])',
			`sys.argv = ["runner-mem-report.py"] + sys.argv[1:]`,
			'sys.exit(rp.main())',
		].join('\n')
	);
	const run = (args) =>
		spawnCapture(PY, [driver, ...args], {
			timeout: 60_000,
			env: { ...process.env, FLEET_MANIFEST_DIR: manifests },
			label: `runner-mem-report.py ${args.join(' ')}`,
		});
	return { dir, run };
}

const WINDOW = {
	host: 'fx-claw.invalid',
	unit: 'actions-runner-fixture-repo.service',
	dur_s: 120,
	peak_current_mb: 4200,
};
const clippedWindow = (mb) => ({
	...WINDOW,
	peak_unreclaimable_mb: mb,
	clipped: true,
	oom_kills: 1,
	cap_mb: 4096,
});
const cleanWindow = (mb) => ({
	...WINDOW,
	peak_unreclaimable_mb: mb,
	clipped: false,
	oom_kills: 0,
	cap_mb: 4096,
});

test('a repo whose every window was clipped reports NO NUMBER', () => {
	const f = runReport([clippedWindow(3739), clippedWindow(3712)]);
	try {
		const r = f.run(['--json']);
		assert.equal(r.code, 0, r.err);
		const out = parseJsonStdout(r);
		const repo = out.repos['fixture-repo'];
		assert.ok(repo, `no such repo in ${Object.keys(out.repos).join(', ')}`);
		assert.equal(repo.p95, null, 'a percentile over floors sizes the next cap from the last cap');
		assert.equal(repo.max, null);
		assert.equal(repo.suggestedMemoryMaxMb, null);
		assert.equal(repo.clipped, 2);
		assert.equal(repo.usable, 0);
		// The floor is KEPT. "No usable measurement" must not lose the one true
		// thing the data says: the job wanted at least this much.
		assert.equal(repo.floorMb, 3739);
		assert.match(repo.why, /no usable measurement/);
		assert.equal(out.clipped, 2);
		assert.equal(out.usable, 0);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test('clipped windows are excluded from the percentiles of a repo that has both', () => {
	// THE CONTROL that makes the test above mean something: with one clean
	// window the repo reports a number, and the number is the CLEAN one — the
	// 3,739 MB floor must not reach max/p95 despite being the largest value.
	const f = runReport([clippedWindow(3739), cleanWindow(800)]);
	try {
		const r = f.run(['--json']);
		assert.equal(r.code, 0, r.err);
		const repo = parseJsonStdout(r).repos['fixture-repo'];
		assert.equal(repo.max, 800, 'a killed run is not a measurement');
		assert.equal(repo.p95, 800);
		assert.equal(repo.usable, 1);
		assert.equal(repo.clipped, 1);
		assert.equal(repo.floorMb, 3739, 'and the contradiction is carried, not averaged away');
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test('a node with nothing but clipped windows gets no `fits` verdict', () => {
	// `fits: true` computed from a p95 that the cap itself produced is a gate
	// getting EASIER to pass the worse the memory pressure got.
	const f = runReport([clippedWindow(3739), clippedWindow(3700)]);
	try {
		const r = f.run(['--json']);
		assert.equal(r.code, 0, r.err);
		const node = parseJsonStdout(r).machines['fx-claw.invalid'];
		assert.equal(node.fits, null);
		assert.equal(node.p95Mb, null);
		assert.equal(node.clipped, 2);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test('a record from a harvest too old to say is UNMARKED, not assumed clean', () => {
	const old = { ...WINDOW, peak_unreclaimable_mb: 900 };
	const f = runReport([old, cleanWindow(800)]);
	try {
		const r = f.run(['--json']);
		assert.equal(r.code, 0, r.err);
		const out = parseJsonStdout(r);
		assert.equal(out.unmarked, 1, 'the count is reported, so a partial guarantee reads as one');
		// It still SIZES: throwing away the 674-window baseline every existing
		// number rests on would be the opposite error.
		assert.equal(out.repos['fixture-repo'].max, 900);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test('MUTATION: a report that sizes from clipped windows fails these guards', () => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-memreport-mut-'));
	try {
		const mutant = join(dir, 'mutant.py');
		const src = readFileSync(join(SCRIPTS, 'runner-mem-report.py'), 'utf8')
			.replace('    clipped = [r for r in rows if r.get("clipped") is True]', '    clipped = []')
			.replace(
				'    usable = [r for r in rows if r.get("clipped") is not True]',
				'    usable = list(rows)'
			);
		assert.notEqual(src, readFileSync(join(SCRIPTS, 'runner-mem-report.py'), 'utf8'));
		writeFileSync(mutant, src);
		const manifests = join(dir, 'manifests');
		mkdirSync(manifests, { recursive: true });
		writeFileSync(
			join(manifests, 'fleet-runner-manifest.json'),
			JSON.stringify({ machines: { 'fx-claw.invalid': { ramGb: 16, maxConcurrent: 2 } } })
		);
		const driver = join(dir, 'drive.py');
		const rows = [clippedWindow(3739), clippedWindow(3712)];
		writeFileSync(
			driver,
			[
				'import importlib.util, json, sys',
				`spec = importlib.util.spec_from_file_location("rp", ${JSON.stringify(mutant)})`,
				'rp = importlib.util.module_from_spec(spec)',
				'spec.loader.exec_module(rp)',
				`rows = json.loads(${JSON.stringify(JSON.stringify(rows))})`,
				'rp.collect = lambda nodes: (rows, [])',
				'sys.argv = ["x", "--json"]',
				'sys.exit(rp.main())',
			].join('\n')
		);
		const r = spawnCapture(PY, [driver], {
			timeout: 60_000,
			env: { ...process.env, FLEET_MANIFEST_DIR: manifests },
			label: 'runner-mem-report.py (mutant)',
		});
		assert.equal(r.code, 0, r.err);
		const out = parseJsonStdout(r);
		// The reverted report hands back exactly the number that is bounded by the
		// cap that produced it — the bug, reproduced.
		assert.equal(out.repos['fixture-repo'].max, 3739);
		assert.equal(out.machines['fx-claw.invalid'].fits, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the report NAMES the manifest it answered from, on stderr and in --json', () => {
	// `fleet mem-report` currently resolves the manifest PACKAGED with this repo
	// rather than the operator's, because src/cli.ts spawns it without
	// FLEET_MANIFEST_DIR — measured 2026-09-20 as four machines against a live
	// fleet of eight, with `unreachable: []`. Naming the tree that answered is
	// issue #4's rule and the only thing that makes that visible rather than
	// plausible. The fix itself is in src/cli.ts and is not this file's.
	const f = runReport([cleanWindow(800)]);
	try {
		const r = f.run(['--json']);
		assert.equal(r.code, 0, r.err);
		const out = parseJsonStdout(r);
		assert.match(out.manifest, /fleet-runner-manifest\.json$/);
		assert.equal(out.machinesDeclared, 1, 'the fixture declares exactly one machine');
		// STDERR, never stdout: `--json` is a contract and the cron parses stdout.
		assert.match(r.err, /manifest: .*fleet-runner-manifest\.json \(1 machine\(s\)\)/);
		assert.doesNotMatch(r.out, /^manifest:/m);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

// ── #98: the KERNEL is read for slices and minted units, and a missing ──────
// ── token is never a pass ────────────────────────────────────────────────────

/**
 * `systemctl` that answers `show` and `list-units` from a FILE TREE and records
 * every call. `$SHIM_DB/<system|user>/<unit>/<Prop>` holds one property's
 * value; `$SHIM_DB/<scope>/list` the units `list-units` knows, one per line,
 * filtered by the patterns it was given. Anything else — every write verb —
 * does nothing and exits 0, and a --check run must not issue one anyway.
 */
const TABLE_SYSTEMCTL_SHIM = `#!/bin/sh
set -f
echo "systemctl $*" >>"$SHIM_REC"
scope=system
[ "$1" = "--user" ] && { scope=user; shift; }
verb="$1"
shift
case "$verb" in
show)
	unit=""
	prop=""
	while [ $# -gt 0 ]; do
		case "$1" in
		-p) prop="$2"; shift 2 ;;
		-*) shift ;;
		*) unit="$1"; shift ;;
		esac
	done
	f="$SHIM_DB/$scope/$unit/$prop"
	[ -f "$f" ] && cat "$f"
	exit 0 ;;
list-units)
	f="$SHIM_DB/$scope/list"
	[ -f "$f" ] || exit 0
	pats=""
	for a in "$@"; do case "$a" in -*) ;; *) pats="$pats $a" ;; esac; done
	while read -r u; do
		for p in $pats; do
			case "$u" in $p) echo "$u loaded active running fixture"; break ;; esac
		done
	done <"$f"
	exit 0 ;;
esac
exit 0
`;

/** A stub that finds nothing and does nothing — the real binary is never reached. */
const REFUSE_SHIM = '#!/bin/sh\nexit 1\n';

/**
 * Run the installer in CHECK mode (APPLY=0) against a fixture: a stub bin dir
 * FIRST on PATH, a fixture $HOME, and every root the script reads overridden
 * into the fixture. REFUSES — throws before spawning — if any of those would
 * land outside the fixture, which is the shape of the two incidents this repo
 * has already had (a test that rewrote hokon's 29 runner .env files, and one
 * that swept its real /tmp).
 *
 * `db` maps `<scope>/<unit>/<Prop>` (or `<scope>/list`) to a value; `cg` maps a
 * path under the fixture cgroup root to a file body.
 */
function runCheckInstaller({ db = {}, cg = {}, unitMb = '4096', maxMb = '1000' } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-slice-check-'));
	const bin = join(dir, 'bin');
	mkdirSync(bin, { recursive: true });
	for (const [name, body] of [
		['systemctl', TABLE_SYSTEMCTL_SHIM],
		['sudo', REFUSE_SHIM],
		['pgrep', REFUSE_SHIM],
		['loginctl', REFUSE_SHIM],
		['systemd-run', REFUSE_SHIM],
		['lsof', REFUSE_SHIM],
		['df', REFUSE_SHIM],
	]) {
		writeFileSync(join(bin, name), body);
		chmodSync(join(bin, name), 0o755);
	}
	const shimDb = join(dir, 'db');
	for (const [key, value] of Object.entries(db)) {
		mkdirSync(dirname(join(shimDb, key)), { recursive: true });
		writeFileSync(join(shimDb, key), `${value}\n`);
	}
	const cgRoot = join(dir, 'cg');
	mkdirSync(cgRoot, { recursive: true });
	for (const [path, body] of Object.entries(cg)) {
		mkdirSync(dirname(join(cgRoot, path)), { recursive: true });
		if (body !== null) writeFileSync(join(cgRoot, path), `${body}\n`);
	}
	const rec = join(dir, 'calls.txt');
	writeFileSync(rec, '');
	const env = {
		PATH: `${bin}:${process.env.PATH}`,
		HOME: join(dir, 'home'),
		SYS_DIR: join(dir, 'etc', 'systemd', 'system'),
		USER_CONF_DIR: join(dir, 'etc', 'systemd', 'user.conf.d'),
		CGROUP_ROOT: cgRoot,
		SHIM_DB: shimDb,
		SHIM_REC: rec,
		IO_WAIT_SECS: '1',
		APPLY: '0',
		RESTART: '0',
		MAX_MB: maxMb,
		SWAP_MB: '4096',
		UNIT_MB: unitMb,
		CI_OOM: '500',
		SLICE_NAME: 'runners.slice',
	};
	for (const k of ['HOME', 'SYS_DIR', 'USER_CONF_DIR', 'CGROUP_ROOT', 'SHIM_DB', 'SHIM_REC']) {
		if (!dir.startsWith(tmpdir()) || !env[k].startsWith(`${dir}/`))
			throw new Error(`runCheckInstaller refuses: ${k}=${env[k]} is outside the fixture ${dir}`);
	}
	if (!env.PATH.startsWith(`${bin}:`))
		throw new Error('runCheckInstaller refuses: the stub dir must be FIRST on PATH');
	const r = spawnCapture('bash', [join(SCRIPTS, 'runners-slice-install.sh')], {
		timeout: 60_000,
		label: 'runners-slice-install.sh (check)',
		env,
	});
	const out = `${r.out}${r.err}`;
	const summary = Object.fromEntries(
		(out.split('\n').find((l) => l.startsWith('SUMMARY ')) ?? '')
			.slice('SUMMARY '.length)
			.split(/\s+/)
			.filter((t) => t.includes('='))
			.map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)])
	);
	const calls = readFileSync(rec, 'utf8');
	rmSync(dir, { recursive: true, force: true });
	// The tripwire: the shim, not the real binary, answered — and a check run
	// issued no write verb.
	assert.match(calls, /^systemctl /m, 'the systemctl shim was never invoked');
	assert.doesNotMatch(
		calls,
		/systemctl (--user )?(start|stop|restart|kill|set-property|daemon-re)/
	);
	return { out, summary };
}

const MIB_ = 1024 * 1024;
const USER_MGR = '/user.slice/user-1000.slice/user@1000.service';

test('#98: a minted unit with no kernel cap, or one above UNIT_MB, is MINT-CAP-DRIFT', () => {
	const names = {
		'jit-at-cap.service': String(4096 * MIB_),
		'jit-below.service': String(2048 * MIB_),
		'jit-uncapped.service': 'max',
		'warm-above.service': String(4097 * MIB_),
		'jit-unreadable.service': null,
	};
	const db = { 'user/list': Object.keys(names).join('\n') };
	const cg = {};
	for (const [name, max] of Object.entries(names)) {
		db[`user/${name}/ControlGroup`] = `${USER_MGR}/runners.slice/${name}`;
		cg[`${USER_MGR}/runners.slice/${name}/memory.max`] = max;
	}
	const r = runCheckInstaller({ db, cg });
	assert.equal(r.summary.mint_total, '5', r.out);
	const drift = r.out.split('\n').filter((l) => l.startsWith('MINT-CAP-DRIFT '));
	const flagged = drift.map((l) => l.split(/\s+/)[1]).sort();
	assert.deepEqual(
		flagged,
		['jit-uncapped.service', 'jit-unreadable.service', 'warm-above.service'],
		r.out
	);
	assert.match(r.out, /MINT-CAP-DRIFT jit-uncapped\.service kernel=max /);
	assert.match(r.out, /MINT-CAP-DRIFT jit-unreadable\.service kernel=unreadable /);
});

test('#98: a minted unit with no cgroup (it has exited) is not cap drift', () => {
	const r = runCheckInstaller({ db: { 'user/list': 'jit-gone.service' } });
	assert.equal(r.summary.mint_total, '1', r.out);
	assert.doesNotMatch(r.out, /MINT-CAP-DRIFT/);
});

test('#98: the auditor turns MINT-CAP-DRIFT into a problem', () => {
	const p = sliceSummaryProblems({
		kv: SUMMARY_OK,
		notes: ['MINT-CAP-DRIFT jit-x.service kernel=max want<=1'],
		sliceName: 'runners.slice',
		wantMax: 1000 * MIB_,
		wantSwap: 4096 * MIB_,
	});
	assert.equal(p.length, 1, p.join('\n'));
	assert.match(p[0], /1 minted unit\(s\) .* above the per-unit ceiling, or none at all/);
});

test('#98: the slice ceiling is the KERNEL value, with config only as cfg_max', () => {
	// Config says the right number; the kernel enforces none. The old read
	// (`systemctl show -p MemoryMax`) reported the config and passed.
	const r = runCheckInstaller({
		db: {
			'system/runners.slice/ControlGroup': '/runners.slice',
			'system/runners.slice/MemoryMax': String(1000 * MIB_),
			'system/runners.slice/MemorySwapMax': String(4096 * MIB_),
			'user/runners.slice/ControlGroup': `${USER_MGR}/runners.slice`,
			'user/runners.slice/MemoryMax': String(1000 * MIB_),
			'user/runners.slice/MemorySwapMax': String(4096 * MIB_),
			'user/runners.slice/LoadState': 'loaded',
		},
		cg: {
			'/runners.slice/memory.max': 'max',
			'/runners.slice/memory.swap.max': String(4096 * MIB_),
			[`${USER_MGR}/runners.slice/memory.max`]: String(512 * MIB_),
			[`${USER_MGR}/runners.slice/memory.swap.max`]: null,
		},
	});
	assert.equal(r.summary.live_max, 'max', r.out);
	assert.equal(r.summary.cfg_max, String(1000 * MIB_), r.out);
	assert.equal(r.summary.live_swap, String(4096 * MIB_), r.out);
	assert.equal(r.summary.user_max, String(512 * MIB_), r.out);
	assert.equal(r.summary.user_cfg_max, String(1000 * MIB_), r.out);
	// A cgroup whose file could not be read is `unreadable`, never the config.
	assert.equal(r.summary.user_swap, 'unreadable', r.out);
});

test('#98: a slice with no cgroup is `inactive`, judged on its config, never a kernel guess', () => {
	const r = runCheckInstaller({
		db: {
			'user/runners.slice/LoadState': 'loaded',
			'user/runners.slice/MemoryMax': String(1000 * MIB_),
		},
	});
	assert.equal(r.summary.user_max, 'inactive', r.out);
	assert.equal(r.summary.user_cfg_max, String(1000 * MIB_), r.out);
	assert.equal(r.summary.live_max, 'inactive', r.out);
	assert.equal(r.summary.cfg_max, '-', r.out);
});

test('#98: a RUNNING standing unit whose memory.max is unreadable is cap drift, not its config', () => {
	// The config fallback is for a unit with NO cgroup. Before #98 an unreadable
	// memory.max on a running unit fell through to `systemctl show MemoryMax` and
	// counted as capped.
	const unit = 'actions-runner-fixture.service';
	const r = runCheckInstaller({
		db: {
			'user/list': unit,
			[`user/${unit}/ControlGroup`]: `${USER_MGR}/runners.slice/${unit}`,
			[`user/${unit}/MemoryMax`]: String(4096 * MIB_),
			[`user/${unit}/KillMode`]: 'mixed',
			[`user/${unit}/Restart`]: 'always',
		},
		cg: { [`${USER_MGR}/runners.slice/${unit}/memory.max`]: null },
	});
	assert.equal(r.summary.capped_live, '0', r.out);
	assert.match(r.out, new RegExp(`UNIT-CAP-DRIFT ${unit} kernel=unreadable`));
});

test('#98: a STOPPED standing unit (no cgroup) still falls back to its config', () => {
	const unit = 'actions-runner-stopped.service';
	const r = runCheckInstaller({
		db: {
			'user/list': unit,
			[`user/${unit}/MemoryMax`]: String(4096 * MIB_),
			[`user/${unit}/Slice`]: 'runners.slice',
			[`user/${unit}/KillMode`]: 'mixed',
			[`user/${unit}/Restart`]: 'always',
		},
	});
	assert.equal(r.summary.capped_live, '1', r.out);
	assert.doesNotMatch(r.out, /UNIT-CAP-DRIFT/);
});

test('#98: the auditor judges the KERNEL ceiling, and reads config only for an inactive slice', () => {
	const judge = (kv) =>
		sliceSummaryProblems({
			kv: { ...SUMMARY_OK, ...kv },
			notes: [],
			sliceName: 'runners.slice',
			wantMax: 1000 * MIB_,
			wantSwap: 4096 * MIB_,
		});
	assert.deepEqual(judge({}), [], 'the converged fixture is clean');
	assert.match(
		judge({ live_max: 'max' }).join('\n'),
		/^slice MemoryMax is max, want .*config says/m
	);
	assert.match(judge({ live_max: 'unreadable' }).join('\n'), /could not read the slice MemoryMax/);
	assert.deepEqual(judge({ live_max: 'inactive' }), [], 'inactive with the right config holds');
	assert.match(
		judge({ live_max: 'inactive', cfg_max: 'infinity' }).join('\n'),
		/slice MemoryMax has no cgroup/
	);
});

test('#98: a missing or placeholder token is "could not read", never a pass', () => {
	const judge = (kv) =>
		sliceSummaryProblems({
			kv: { ...SUMMARY_OK, ...kv },
			notes: [],
			sliceName: 'runners.slice',
			wantMax: 1000 * MIB_,
			wantSwap: 4096 * MIB_,
		});
	// `Number(undefined) > 0` is false: a SUMMARY with no `changed` passed.
	assert.match(judge({ changed: undefined }).join('\n'), /could not read how many units/);
	assert.match(judge({ changed: 'x' }).join('\n'), /could not read how many units/);
	// `user_max=-` beside `user_load=loaded` skipped the check outright.
	assert.match(judge({ user_max: '-' }).join('\n'), /could not read the user-manager/);
	assert.match(judge({ user_max: undefined }).join('\n'), /could not read the user-manager/);
	assert.match(judge({ user_swap: undefined }).join('\n'), /could not read the user-manager/);
	// No `user_load` at all skipped both.
	assert.match(
		judge({ user_load: undefined }).join('\n'),
		/could not read whether the USER manager/
	);
	assert.match(judge({ live_max: undefined }).join('\n'), /could not read the slice MemoryMax/);
});

test('run for real: a non-guest node with no slice block is REPORTED as skipped, and fails --check', () => {
	const noSlice = { ...FX_CLAW };
	delete noSlice.slice;
	const f = sliceFixture({ 'fx-claw.invalid': FX_CLAW, 'fx-noslice.invalid': noSlice });
	try {
		const r = runSlice(['--check', '--json'], f.env);
		assert.equal(r.code, 1);
		assert.match(r.err, /1 declared node\(s\) SKIPPED: fx-noslice\.invalid/);
		assert.match(r.err, /fx-noslice\.invalid: declares no slice\/minFreeMb, so it was SKIPPED/);
		// Still printed without --check: a --confirm that skipped it silently is
		// as misleading as an audit that did. A dry run reaches no node.
		const dry = runSlice([], f.env);
		assert.match(dry.err, /SKIPPED: fx-noslice\.invalid/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('run for real: a GUEST with no slice block is not reported as unbounded', () => {
	const noSlice = { ...FX_GUEST };
	delete noSlice.slice;
	const f = sliceFixture({ 'fx-claw.invalid': FX_CLAW, 'fx-guest.invalid': noSlice });
	try {
		const r = runSlice(['--check', '--json'], f.env);
		assert.doesNotMatch(r.err, /SKIPPED: fx-guest/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// The OOM rank is asserted like the cap (2026-10-27)
// ---------------------------------------------------------------------------
//
// claw-4 and claw-6 held a standing runner at oom_score_adj 200 for 29 hours
// after CI_OOM became 500. The installer counted it in `changed` and printed no
// note, and the converger repairs only what a DRIFT note names.

test('a standing runner below the CI OOM rank is named OOM-RANK-DRIFT, from the kernel', () => {
	const r = runIoInstaller({ standingOom: '200', apply: '0' });
	try {
		assert.match(r.out, new RegExp(`^OOM-RANK-DRIFT ${STANDING} kernel=200 want>=500$`, 'm'));
		assert.equal(r.summary.changed, '1', 'and still counted as a change to make');
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('a standing runner AT the rank is not drift', () => {
	const r = runIoInstaller({ standingOom: '500', apply: '0' });
	try {
		assert.doesNotMatch(r.out, /OOM-RANK-DRIFT/);
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('--confirm raises the live rank in place, and the same run asserts it fixed', () => {
	const r = runIoInstaller({ standingOom: '200' });
	try {
		assert.equal(readFileSync(join(r.dir, 'proc', '4242', 'oom_score_adj'), 'utf8').trim(), '500');
		assert.doesNotMatch(r.out, /OOM-RANK-DRIFT/, 'the outcome loop reads after the repair');
	} finally {
		rmSync(r.dir, { recursive: true, force: true });
	}
});

test('the driver keeps OOM-RANK-DRIFT and names the unit in its problems', () => {
	assert.match(mjs(), /\|OOM-RANK-DRIFT\|/, 'the note filter must pass the prefix');
	assert.match(mjs(), /below the CI OOM rank/);
});
