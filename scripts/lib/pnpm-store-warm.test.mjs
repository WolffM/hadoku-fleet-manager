/**
 * THE PNPM STORE IS WARMED BY THE BOOTSTRAP, AS THE FLEET USER, UNDER $HOME.
 *
 * `corepack enable` gives a node a working pnpm and no store. The content store
 * is created lazily by the first package fetch, so a freshly bootstrapped node
 * answers `pnpm --version` happily while `~/.local/share/pnpm/store/v11` does
 * not exist — and `fleet toolchain` reads that directory. claw-7 and claw-8 both
 * came off CONVERT drifted on 2026-09-09, on boxes whose pnpm was healthy.
 *
 * Three things have to hold, and each was wrong in a draft of the fix:
 *
 *   1. SOMETHING ACTUALLY FETCHES A PACKAGE. `pnpm store prune` against a
 *      missing store is a no-op — verified on claw-7, which reported the store
 *      still MISSING afterwards. Only a real fetch creates it.
 *
 *   2. IT RUNS AS THE FLEET USER. node-bootstrap.sh runs as root. A warm-up
 *      that inherits root writes /root/.local/share/pnpm — a store on a path no
 *      gate reads — and leaves root-owned scratch in the fleet user's home. The
 *      rest of the script reaches for `runuser -u "$FLEET_USER"` and so must
 *      this.
 *
 *   3. IT RUNS UNDER $HOME, NOT /tmp. pnpm puts the store on the SAME
 *      FILESYSTEM as the node_modules it links into, because the mechanism is
 *      hardlinks and those cannot cross a mount. On these nodes /tmp is tmpfs
 *      and $HOME is ext4 (measured on both new claws), so warming from a /tmp
 *      scratch directory builds a store in RAM, exits 0, and leaves the real
 *      path exactly as empty as it found it. That is what the first attempt did.
 *
 * COMMENTS ARE BLANKED FIRST. This repo has read a COMMENT as evidence three
 * separate times, and the block under test is preceded by a long paragraph that
 * names every token these greps look for.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const blankShellComments = (src) =>
	src
		.split('\n')
		.map((line) => (/^\s*#/.test(line) ? '' : line))
		.join('\n');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const code = blankShellComments(
	readFileSync(resolve(ROOT, 'scripts', 'node-bootstrap.sh'), 'utf8')
);

/**
 * The warm-up block, bounded so the assertions cannot be satisfied from
 * elsewhere in the file.
 *
 * THE OBVIOUS VERSION OF THIS IS VACUOUS. Slicing back to
 * `lastIndexOf('runuser', start)` looks like it isolates the block, but when the
 * `runuser` under test is DELETED that search simply walks further back and
 * finds the unrelated one in the ssh-key section ~350 lines earlier — so the
 * slice still contains `runuser -u "$FLEET_USER"` and the "runs as the fleet
 * user" test passes against code that runs the warm-up as root. Verified by
 * mutation: removing the runuser left all five tests green.
 *
 * So the window is bounded by DISTANCE. The governing `runuser` has to be within
 * `NEAR` characters of the fetch it governs, which no far-away call can satisfy.
 */
const NEAR = 400;

const fetchStart = () => {
	const start = code.indexOf('pnpm add is-number');
	assert.notEqual(
		start,
		-1,
		'node-bootstrap.sh no longer fetches a package to warm the pnpm store'
	);
	return start;
};

/**
 * Only what PRECEDES the fetch. The privilege question is "what is this fetch
 * running under", and the answer can only be to its left.
 *
 * The second vacuous version of this test sliced through the read-back line as
 * well, and `runuser -u "$FLEET_USER" -- bash -lc 'pnpm store path'` satisfied
 * the "runs as the fleet user" assertion all by itself — so deleting the
 * runuser that governs the FETCH still left the suite green. Two different
 * runusers, one of which is irrelevant to the property.
 */
const beforeFetch = () => code.slice(Math.max(0, fetchStart() - NEAR), fetchStart());

const warmBlock = () => {
	const start = fetchStart();
	const to = code.indexOf('pnpm store path', start);
	assert.notEqual(to, -1, 'the warm-up no longer reads the store path back');
	return code.slice(Math.max(0, start - NEAR), to + 200);
};

test('the bootstrap warms the pnpm store with a real fetch', () => {
	const b = warmBlock();
	assert.match(
		b,
		/pnpm add \S+/,
		'a real package fetch is what creates the store; prune is a no-op'
	);
});

test('the store warm-up runs as the fleet user, never as root', () => {
	const b = beforeFetch();
	assert.match(
		b,
		/runuser -u "\$FLEET_USER"/,
		'node-bootstrap.sh runs as root — an un-dropped warm-up fills /root/.local/share/pnpm, which no gate reads'
	);
	assert.doesNotMatch(
		b,
		/\bsu - /,
		'use runuser, the idiom the rest of this script uses; `su -` was the first draft'
	);
});

test('the store warm-up happens under $HOME, not /tmp', () => {
	const b = beforeFetch();
	assert.match(
		b,
		/mktemp -d -p "\$HOME"/,
		'/tmp is tmpfs on these nodes and $HOME is ext4; pnpm keeps the store on the filesystem it hardlinks into, so a /tmp warm-up builds a store in RAM and reports success'
	);
	assert.doesNotMatch(
		b,
		/mktemp -d\s*$/m,
		'a bare mktemp -d lands in /tmp — that is the bug this guards'
	);
});

test('the store is verified by reading the filesystem, not by asking pnpm alone', () => {
	const b = warmBlock();
	assert.match(
		b,
		/\[ -d "\$_store" \]/,
		'the fetch is the writer; `pnpm store path` reports where it INTENDS to be. The gate reads the directory, so this must too'
	);
});

test('a store that was not created is a WARNING, not silence', () => {
	const b = warmBlock();
	assert.match(
		b,
		/warn "pnpm store was not created/,
		'"I could not look" must never render as "nothing is wrong" — a silent failure here surfaces later as toolchain DRIFT with no trail'
	);
});
