/**
 * NOTHING NEW MAY REACH A NODE WITHOUT DECIDING WHAT IT DOES ABOUT A GUEST.
 *
 * Wave 3d fixed the guest rule FIVE times, once per script, because each one
 * rediscovered it on its own: `converge-toolchain` would have apt-installed on
 * the production host, `deploy-ci-throttle` cleared every filter it had,
 * `check-capabilities` probed labels a guest only ever declares, `bootcamp`
 * would have enrolled it, `benchmark-fleet` would have billed it. `fleet slice
 * --check` was the SIXTH, found red in `ci:audit-gates` on 2026-09-16 printing
 * "On hokon, as the operator: sudo -v && fleet slice --machine hokon --confirm"
 * — the fleet asking a guest for sudo on the box every other gate reports
 * through.
 *
 * Five identical fixes and a sixth in the wild is not five bugs. It is a CLASS,
 * and a behavioural test cannot catch the next member of it: the next member
 * does not exist yet. Only a structural check over the source tree can, which
 * is the same argument `node-identity-guard.test.mjs` makes next door for the
 * local rule, and it lives here for the same two reasons — it must import
 * `blankComments` (which `tsconfig.json` cannot, with no `allowJs`) and it must
 * read the SOURCE tree, not a copy compiled into `dist/tests/`.
 *
 * WHAT IT PROVES, AND WHAT IT CANNOT
 * ----------------------------------
 * It proves that every file which can reach a node MENTIONS the question. It
 * does NOT prove the answer is right — that a guest is actually skipped on the
 * path the script takes at runtime. `node-role-gates.test.mjs` does that, by
 * spawning two of them for real against a temp manifest. Structure keeps the
 * count from growing; behaviour proves the ones that exist. Neither substitutes
 * for the other, and saying so is the point: this file's green tick means
 * "somebody considered it", never "it is safe".
 *
 * COMMENTS ARE BLANKED FIRST, every time. This repo has been bitten FOUR times
 * by a grep that scored prose as evidence — most recently issue #17, where a
 * planning doc describing a design stood in for the code that had since
 * changed. Every file this rule touches now carries a paragraph about guests,
 * including the one you are reading, so a rule about source must never be
 * satisfiable by writing about it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The file that owns the role rule; it is the reader, not a caller. */
const CANONICAL = 'src/lib/node-role.ts';

/** The transport that implements the gate; it may not ask itself for permission. */
const CHOKE_POINT = 'scripts/lib/fleet-exec.mjs';

/**
 * CAN THIS FILE PUT A COMMAND ON ANOTHER BOX?
 *
 * Two ways, and both are counted because the first wave's premise — "every
 * script that reaches a node goes through fleet-exec" — was measured FALSE on
 * 2026-09-16: seven files spawn `ssh` themselves. A guard that trusted the
 * premise would have watched one door of two.
 */
const REACHES = [
	// `execFile('ssh', …)` / `spawn('ssh', [ … ])` — the literal followed by its
	// argv. `ssh -G` (enroll-node's config resolver) matches too, deliberately:
	// it is still this host talking about that box.
	/(['"`])ssh\1\s*,/,
	// The shared transport, both halves.
	/\brunOn(?:Sync)?\s*\(/,
];

/**
 * DOES IT DECIDE ANYTHING ABOUT A GUEST?
 *
 * Deliberately generous. Any of these is a human having thought about it:
 * routing through the role-aware selection door, arming the transport gate, or
 * asking the predicate directly the way the five Wave-3d scripts do, or — in
 * library code under `src/` — taking the guest set from `fleet-loop`'
 * `loadGuestNodes`, which is `isGuestNode` over the live fleet manifest. A guard
 * that insisted on ONE spelling would fail eleven correct files to enforce a
 * style, and the thing being enforced is a decision, not an idiom.
 */
const DECIDES =
	/\bselectNodes\s*\(|\bincludeGuests\b|\bisGuestNode\b|\bguestNodeNames\b|\bloadGuestNodes\b|\bguestGate\s*\(/;

/**
 * Files that reach a node and say nothing about roles.
 *
 * A DEBT LIST, NOT AN ALLOWLIST, and the difference is enforced below: an entry
 * that gains a role decision must be DELETED from here, so the list can only
 * shrink. That is what makes this a ratchet rather than a parking lot — the
 * failure mode CLAUDE.md names for the mint advisory ("no gate may get EASIER
 * to pass the worse the failure gets") applies to exemptions too.
 *
 * IT IS EMPTY, DOWN FROM SEVENTEEN. Wave 3f took the fifteen scripts one at a
 * time, which is what the entry below them said the work was: each needed its
 * own answer to "does a guest belong in THIS question", and the answers are not
 * the same. Twelve SKIP — the sweeps that converge, seed, clean, probe, drain,
 * enroll, place a probe job or apt-get, every one of them now reporting the skip
 * rather than performing it silently. Three INCLUDE, with `includeGuests` and a
 * reason in the source: `reconcile-fleet-runners` and `reconcile-runner-identity`
 * because the guest's STANDING BACKSTOP REGISTRATION is the thing they maintain
 * and audit — skipping it there would have marked all ~28 of its registrations
 * orphaned and deregistered the backstop — `check-runner-units` because that is
 * the node-side reading of the same registrations, and `traffic-status` because
 * the backstop's place in the routing order is precisely what it reports.
 *
 * `runner-supervision.ts` LEFT IN WAVE 3g, as a SKIP: it probes runner units
 * over ssh, and a guest's units are the identity gate's question only — the
 * include `check-runner-units` makes above. It takes the guest set from
 * `loadGuestNodes` and names what it skipped in `skippedByRole`.
 *
 * `ephemeral-tick.ts` LEFT IN THE SAME WAVE, as a SKIP: a JIT mint is exactly
 * the business a guest is excluded from, and `withoutGuests` removes every
 * guest from the mint's target set with `isGuestNode`, logging a guest marked
 * ephemeral as the manifest contradiction it is rather than dropping it.
 *
 * KEEP THE SET, EMPTY. It is where a new reacher that genuinely cannot decide
 * yet goes, visibly and with its own tests above holding it to shrink again.
 *
 * THE CHOKE POINT'S DEFAULT HAS NOT FLIPPED YET. `guestSkip` in fleet-exec still
 * treats an OMITTED `includeGuests` as "reach, unenforced". This list being
 * empty was the stated precondition for flipping it; the flip itself is a
 * change to fleet-exec, not to this guard.
 */
const UNGATED = new Set([]);

/**
 * The classifier, PURE and over supplied text.
 *
 * Taking `[{rel, src}]` rather than reading the disk itself is what makes the
 * mutation test below possible without editing a real script: removing a guest
 * skip from a file on disk to watch the guard fail is a mutation against the
 * LIVE tree, and two other lanes are editing this worktree right now. A fixture
 * proves the same property and cannot lose somebody else's work.
 */
export function classifyFleetReach(files) {
	const reaching = [];
	const gapped = [];
	for (const { rel, src } of files) {
		const code = blankComments(src);
		if (!REACHES.some((re) => re.test(code))) continue;
		reaching.push(rel);
		if (!DECIDES.test(code)) gapped.push(rel);
	}
	return { reaching, gapped };
}

/**
 * Every `.ts`/`.mjs` under `src/` and `scripts/` that is not itself a test.
 *
 * Memoized: four tests below ask the same question of the same tree, and
 * blanking comments across ~200 files is the expensive part of this gate.
 */
let cachedSources;
function sourceFiles() {
	if (cachedSources) return cachedSources;
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir)) {
			if (entry === 'node_modules' || entry === 'dist') continue;
			const p = join(dir, entry);
			if (statSync(p).isDirectory()) {
				walk(p);
				continue;
			}
			// Tests are excluded: `reconcile-runner-identity.test.mjs` installs an
			// `ssh` SHIM on PATH, which is the opposite of reaching a node, and
			// `json-contract.test.mjs` asserts that `ssh` is NOT invoked. Counting
			// either as a fleet-reaching file would make the guard demand a role
			// decision from code whose whole subject is not having one.
			if (!/\.(ts|mjs)$/.test(entry) || /\.test\.(ts|mjs)$/.test(entry)) continue;
			out.push(p);
		}
	};
	for (const root of ['src', 'scripts']) walk(join(ROOT, root));
	cachedSources = out
		.map((abs) => ({ rel: relative(ROOT, abs), src: readFileSync(abs, 'utf8') }))
		.filter(({ rel }) => rel !== CHOKE_POINT);
	return cachedSources;
}

test('every file that reaches a node decides what it does about a guest', () => {
	const { gapped } = classifyFleetReach(sourceFiles());
	const offenders = gapped.filter((rel) => !UNGATED.has(rel));
	assert.deepEqual(
		offenders,
		[],
		`these can run a command on another box and say nothing about roles:\n  ` +
			`${offenders.join('\n  ')}\n\n` +
			'hokon is a GUEST (operator, 2026-09-14): it lends the fleet a backstop ' +
			"registration and is otherwise none of the fleet chain's business — never " +
			'converged, never bootcamped, never asked for sudo. Decide explicitly:\n' +
			'  - select through selectNodes() from lib/fleet-exec.mjs, which skips guests ' +
			'and hands back skippedByRole for the report; or\n' +
			'  - pass includeGuests to runOn/runOnSync to arm the same gate per call; or\n' +
			'  - ask isGuestNode() from dist/lib/node-role.js directly, with a comment ' +
			"saying why this question is the guest's business.\n" +
			'A silent skip is not an option either: a node that stops being checked ' +
			'without anyone noticing is the failure the skip is supposed to prevent.'
	);
});

test('the debt list only ever SHRINKS — an entry that gained a decision must go', () => {
	// Without this the exemption set is a parking lot: a file could be fixed and
	// stay listed forever, and the list would stop describing anything. It is
	// also the half that makes the ratchet real — the only way to leave the list
	// is to be deleted from it.
	const { gapped } = classifyFleetReach(sourceFiles());
	const stillGapped = new Set(gapped);
	const graduated = [...UNGATED].filter((rel) => !stillGapped.has(rel));
	assert.deepEqual(
		graduated,
		[],
		`these now decide about guests and must be REMOVED from UNGATED in this file:\n  ` +
			`${graduated.join('\n  ')}`
	);
});

test('every debt entry still exists — a rotted list exempts nothing and hides that', () => {
	// A renamed or deleted script would leave a name here matching nothing, and a
	// set of names matching nothing silently shrinks the rule to whatever is
	// left. "I could not look" must not render as "nothing is wrong."
	const missing = [...UNGATED].filter((rel) => !existsSync(join(ROOT, rel)));
	assert.deepEqual(
		missing,
		[],
		`UNGATED names files that no longer exist:\n  ${missing.join('\n  ')}`
	);
});

test('MUTATION — a script that loses its guest skip is NAMED', () => {
	// Against a FIXTURE, never the tree. Two other lanes are editing this
	// worktree; a guard proved by deleting a line from a real script and putting
	// it back races with them for a property a string can demonstrate exactly as
	// well.
	//
	// The fixture is `check-capabilities.mjs`'s shape, reduced to the two lines
	// that matter: the import of the predicate and the filter that uses it.
	const WITH_SKIP = [
		"import { loadManifest, runOn, selectMachines } from './lib/fleet-exec.mjs';",
		"import { isGuestNode } from '../dist/lib/node-role.js';",
		'const selected = selectMachines(loadManifest(), { only: ONLY });',
		'const nodes = selected.filter(([, m]) => !isGuestNode(m));',
		"for (const [n] of nodes) await runOn(n, 'true');",
	].join('\n');
	// The SAME file with the role decision removed, and nothing else changed.
	const WITHOUT_SKIP = WITH_SKIP.split('\n')
		.filter((l) => !l.includes('isGuestNode'))
		.join('\n');

	const before = classifyFleetReach([{ rel: 'scripts/fixture.mjs', src: WITH_SKIP }]);
	assert.deepEqual(before.reaching, ['scripts/fixture.mjs'], 'the fixture must reach a node');
	assert.deepEqual(before.gapped, [], 'with its skip, the fixture is clean');

	const after = classifyFleetReach([{ rel: 'scripts/fixture.mjs', src: WITHOUT_SKIP }]);
	assert.deepEqual(after.gapped, ['scripts/fixture.mjs'], 'without it, the guard must NAME it');
});

test('MUTATION — a guest decision written only in a COMMENT does not count', () => {
	// The fourth time prose was read as evidence in this repo is one time too
	// many. A file that says "isGuestNode is deliberately not called here" must
	// score as a gap, or the rule is satisfiable by writing about it.
	const PROSE_ONLY = [
		'// hokon is a guest, so isGuestNode() is not needed here — selectNodes()',
		'// would be wrong and includeGuests is irrelevant.',
		"import { runOn } from './lib/fleet-exec.mjs';",
		"await runOn('hokon', 'true');",
	].join('\n');
	const { gapped } = classifyFleetReach([{ rel: 'scripts/prose.mjs', src: PROSE_ONLY }]);
	assert.deepEqual(gapped, ['scripts/prose.mjs'], 'comments are not evidence');
});

test('MUTATION — a raw `ssh` spawn is caught even with fleet-exec nowhere in sight', () => {
	// The premise this wave was handed — "every script that reaches a node goes
	// through fleet-exec" — is FALSE, measured: seven files spawn ssh themselves.
	// A guard that only watched the transport would have missed every one.
	const RAW = [
		"import { execFileSync } from 'node:child_process';",
		"execFileSync('ssh', [node, 'true']);",
	].join('\n');
	const { reaching, gapped } = classifyFleetReach([{ rel: 'scripts/raw.mjs', src: RAW }]);
	assert.deepEqual(reaching, ['scripts/raw.mjs']);
	assert.deepEqual(gapped, ['scripts/raw.mjs']);
});

test('the canonical role reader still exists where this guard says it is', () => {
	// A rename that moved node-role.ts would leave every regex above matching
	// nothing and the guard passing over a repo with no rule at all — the same
	// trap `node-identity-guard` closes for isLocalNode.
	const src = readFileSync(join(ROOT, CANONICAL), 'utf8');
	assert.match(src, /export function isGuestNode\(/, `${CANONICAL} no longer exports isGuestNode`);
	assert.match(src, /'guest'/, `${CANONICAL} no longer knows the guest role`);
});

test('the choke point offers the role-aware door this guard points at', () => {
	// The error message above tells an author to use `selectNodes` and
	// `includeGuests`. If either were renamed, the guard would keep failing files
	// while naming a remedy that does not exist.
	const src = blankComments(readFileSync(join(ROOT, CHOKE_POINT), 'utf8'));
	assert.match(src, /export function selectNodes\(/, 'fleet-exec must export selectNodes');
	assert.match(src, /export function guestGate\(/, 'fleet-exec must export guestGate');
	assert.match(src, /includeGuests/, 'fleet-exec must honour includeGuests');
});
