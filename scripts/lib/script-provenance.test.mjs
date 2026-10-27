/**
 * THE PAYLOAD AND THE PROVENANCE CHECK MUST NOT DRIFT APART.
 *
 * `fleet throttle --check` can only be as complete as its list of files, and the
 * failure mode of an incomplete list is the worst one available: it still prints
 * "every node-side script matches fleet-manager <v>" while covering less than it
 * did before. That is a verifier reading its own writer's artifact wearing a
 * different hat — the gate gets EASIER to pass as the payload grows.
 *
 * So the declaration in `script-provenance.mjs` is held against the two files
 * that actually implement it: the driver, which builds the payload, and the node
 * half, which decodes it and reports the hashes back. A fourth file added to the
 * payload fails the build until it is either hashed or written down as
 * deliberately unhashable.
 *
 * Lives in the scripts half for the same reason as `json-contract.test.mjs`: it
 * reads the SOURCE tree, so a copy compiled into `dist/tests/` would be looking
 * at the wrong files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	NODE_SIDE_FILES,
	RENDERED_NOT_SHIPPED,
	provenanceDrift,
	sha256File,
	shippedHashes,
} from './script-provenance.mjs';

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
const DRIVER = join(SCRIPTS, 'deploy-ci-throttle.mjs');
const NODE_HALF = join(SCRIPTS, 'ci-throttle-install.sh');

/**
 * Shell comments, blanked line-wise.
 *
 * `blankComments` is a JS/TS scanner and this is bash, so it cannot be reused.
 * WHOLE-LINE ONLY, deliberately: every `*_B64` mention in the node half's prose
 * is a full-line comment (the input contract at the top of the file), and a
 * trailing-comment stripper would have to understand shell quoting to avoid
 * eating a `#` inside a string. Under-blanking is the safe direction here — a
 * surviving comment can only make this gate demand MORE, never less.
 */
const blankShellComments = (src) =>
	src
		.split('\n')
		.map((l) => (/^\s*#/.test(l) ? '' : l))
		.join('\n');

const nodeHalf = blankShellComments(readFileSync(NODE_HALF, 'utf8'));
const driver = readFileSync(DRIVER, 'utf8');

/** Every `X_B64` the node half actually reads. */
const consumed = new Set([...nodeHalf.matchAll(/\b([A-Z][A-Z0-9_]*_B64)\b/g)].map((m) => m[1]));

void test('the node half reads at least one payload input — a parse of nothing is not a pass', () => {
	assert.ok(
		consumed.size >= 3,
		`found ${consumed.size} *_B64 input(s) in ci-throttle-install.sh. The naming changed, ` +
			'so every assertion below is checking an empty set and proving nothing.'
	);
});

void test('every file the payload writes is either hashed or declared unhashable', () => {
	const hashed = new Set(NODE_SIDE_FILES.map((f) => f.b64));
	const excused = new Map(RENDERED_NOT_SHIPPED.map((f) => [f.b64, f.why]));
	for (const b64 of consumed) {
		assert.ok(
			hashed.has(b64) || excused.has(b64),
			`ci-throttle-install.sh writes ${b64} to a node, and script-provenance.mjs says ` +
				`nothing about it. \`fleet throttle --check\` would keep printing "every node-side ` +
				`script matches" while never looking at that file. Add it to NODE_SIDE_FILES, or ` +
				`to RENDERED_NOT_SHIPPED with the reason a hash is the wrong question for it.`
		);
	}
});

void test('every declared input is one the node half actually consumes', () => {
	// The other direction. A stale entry means the check hashes a file nobody
	// deploys any more, which reads as coverage that is not there.
	for (const { b64, file } of [...NODE_SIDE_FILES, ...RENDERED_NOT_SHIPPED]) {
		assert.ok(
			consumed.has(b64),
			`script-provenance.mjs declares ${b64} (${file}), but ci-throttle-install.sh never ` +
				`reads it — the payload stopped shipping that file, or it was renamed.`
		);
	}
});

void test('every hashed file exists in the package and the driver reports its key', () => {
	for (const { file, summaryKey } of NODE_SIDE_FILES) {
		assert.ok(
			existsSync(join(SCRIPTS, file)),
			`NODE_SIDE_FILES names scripts/${file}, which does not exist — the deploy would ` +
				`throw and --check could never run.`
		);
		assert.ok(
			nodeHalf.includes(`${summaryKey}=`),
			`the node half does not report \`${summaryKey}=\` on its SUMMARY line, so the driver ` +
				`reads undefined for ${file}.`
		);
	}
});

void test('the driver ships exactly the files it hashes', () => {
	// `remotePayload` reads HOOK_SRC / METRICS_SRC / HARVEST_SRC and `shippedHashes`
	// re-derives the same paths from the names below. Two spellings of one fact,
	// so pin them together: a rename on one side alone would leave --check
	// hashing a file the payload no longer sends, and saying nothing about the
	// one it does.
	for (const { file } of NODE_SIDE_FILES) {
		assert.ok(
			driver.includes(`resolve(__dirname, '${file}')`),
			`deploy-ci-throttle.mjs no longer resolves scripts/${file} for the payload, but ` +
				`NODE_SIDE_FILES still hashes it. The check and the deploy are looking at ` +
				`different files.`
		);
	}
});

void test('the driver reads the declaration rather than a second copy of it', () => {
	// The whole point of the list is that it is load-bearing. A driver that
	// hardcoded the same three filenames would leave this gate passing over a
	// declaration nothing consults.
	assert.match(
		driver,
		/NODE_SIDE_FILES/,
		'deploy-ci-throttle.mjs no longer iterates NODE_SIDE_FILES, so the gate above is ' +
			'checking a list the command does not use.'
	);
});

void test('shippedHashes hashes the real files', () => {
	const hashes = shippedHashes(SCRIPTS);
	for (const { file } of NODE_SIDE_FILES) {
		assert.equal(hashes[file], sha256File(join(SCRIPTS, file)));
		assert.match(hashes[file], /^[0-9a-f]{64}$/);
	}
});

void test('a missing hash is a finding, not a match', () => {
	// The case that would otherwise be silent: an older node half reports no
	// key at all, and `undefined === undefined` reads as agreement.
	const d = provenanceDrift('claw-9', 'job-metrics.sh', undefined, 'a'.repeat(64), '9.9.9');
	assert.match(d ?? '', /reported no hash/);
});

void test('absent, unreadable and stale are three different findings', () => {
	const want = 'a'.repeat(64);
	assert.match(provenanceDrift('claw-9', 'x.sh', 'absent', want, '9.9.9') ?? '', /not deployed/);
	assert.match(
		provenanceDrift('claw-9', 'x.sh', 'unreadable', want, '9.9.9') ?? '',
		/could not hash/
	);
	const stale = provenanceDrift('claw-9', 'x.sh', 'b'.repeat(64), want, '9.9.9') ?? '';
	assert.match(stale, /NOT the copy fleet-manager 9\.9\.9 ships/);
	// Both halves of the comparison, so an operator can tell which deploy the
	// node is on without another round trip.
	assert.ok(stale.includes('bbbbbbbbbbbb') && stale.includes('aaaaaaaaaaaa'));
});

void test('a match is silence', () => {
	const want = 'a'.repeat(64);
	assert.equal(provenanceDrift('claw-9', 'x.sh', want, want, '9.9.9'), null);
});
