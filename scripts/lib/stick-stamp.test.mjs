/**
 * The stick has to be able to say whether its payload is current.
 *
 * `MANIFEST.sha256` cannot: it checks the writer's files against the writer's
 * own record, so it passes on a payload three commits old. Measured 2026-08-31
 * — the stick in hand carried a node-bootstrap.sh with neither the hardware
 * inventory nor the network preflight, it passed every check verify-stick had,
 * and finding out took a `cmp` against a checkout that happened to be on the
 * same machine.
 *
 * So `stamp_compare` re-hashes the stick against the repo and NEVER reads the
 * version it recorded. The tests below pin both halves of that: drift is
 * caught, and the recorded version cannot influence the answer.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const LIB = join(HERE, 'stick-stamp.sh');
const BOOTSTRAP_FILES = (
	readFileSync(LIB, 'utf8').match(/^STAMP_BOOTSTRAP_FILES="([^"]*)"/m)?.[1] ?? ''
)
	.split(/\s+/)
	.filter(Boolean);
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A stick directory carrying the repo's current payload. */
function stick({ payload = true } = {}) {
	const d = mkdtempSync(join(tmpdir(), 'fleet-stamp-'));
	made.push(d);
	mkdirSync(join(d, 'bootstrap'));
	mkdirSync(join(d, 'fixes'));
	if (payload) {
		// DERIVED from the script, not restated here. A hardcoded list drifts the
		// moment a file joins the payload — adding convert.sh broke three tests
		// that were only describing the old shape.
		for (const f of BOOTSTRAP_FILES)
			copyFileSync(join(ROOT, 'scripts', f), join(d, 'bootstrap', f));
		// fixes/ is payload too. Leaving it out of the comparison is what let a
		// stick carrying the OLD fix script report itself current.
		for (const f of readdirSync(join(ROOT, 'scripts', 'fixes'))) {
			if (f.endsWith('.test.mjs')) continue;
			copyFileSync(join(ROOT, 'scripts', 'fixes', f), join(d, 'fixes', f));
		}
	}
	return d;
}

function sh(snippet) {
	const r = spawnSync('bash', ['-c', `set -u; . "${LIB}"; ${snippet}`], { encoding: 'utf8' });
	if (r.error) throw r.error;
	return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const write = (d) => sh(`stamp_write "${d}" "${ROOT}" test-profile`);
const compare = (d) => sh(`stamp_compare "${d}" "${ROOT}"; echo $?`).out.split('\n').pop();

test('stamp_write records provenance AND a hash of every payload file', () => {
	const d = stick();
	assert.equal(write(d).status, 0);
	const s = readFileSync(join(d, 'STAMP'), 'utf8');
	assert.match(s, /^version=\d+\.\d+\.\d+$/m);
	assert.match(s, /^commit=/m);
	assert.match(s, /^built=\d{4}-\d{2}-\d{2}T/m);
	assert.match(s, /^profile=test-profile$/m);
	// The part that decides. Without these the stamp is a claim, not a record.
	// One line per payload file, NAME included — a rename has to be visible.
	assert.match(s, /^sha node-bootstrap\.sh [0-9a-f]{64}$/m);
	assert.match(s, /^sha capability-probe\.sh [0-9a-f]{64}$/m);
	assert.match(s, /^sha fixes\/claw-fix\.sh [0-9a-f]{64}$/m, 'fixes/ is payload too');
});

test('a payload matching the checkout reads CURRENT', () => {
	const d = stick();
	write(d);
	assert.equal(compare(d), '0');
});

test('a payload that has drifted reads STALE', () => {
	const d = stick();
	write(d);
	writeFileSync(join(d, 'bootstrap', 'node-bootstrap.sh'), '# drifted\n', { flag: 'a' });
	assert.equal(compare(d), '1', 'a drifted payload passed as current');
});

test('THE VERSION STRING CANNOT DECIDE — only the hashes can', () => {
	// The whole design. If compare consulted `version=`, a stale stick could be
	// made to read current by editing one line, which is precisely the failure
	// MANIFEST.sha256 already has.
	const d = stick();
	write(d);
	const s = readFileSync(join(d, 'STAMP'), 'utf8').replace(/^version=.*$/m, 'version=99.99.99');
	writeFileSync(join(d, 'STAMP'), s);
	assert.equal(compare(d), '0', 'an absurd version changed the verdict on an unchanged payload');

	writeFileSync(join(d, 'bootstrap', 'capability-probe.sh'), '# drifted\n', { flag: 'a' });
	assert.equal(compare(d), '1', 'the version string masked a real drift');
});

test('no STAMP is CANNOT TELL, never a pass', () => {
	assert.equal(compare(stick()), '2');
});

test('a STAMP with nothing to compare is CANNOT TELL, never a pass', () => {
	// The could-not-look trap. A stick whose payload files are absent must not
	// report "current" just because zero comparisons found zero differences.
	const d = stick({ payload: false });
	sh(`stamp_write "${d}" "${ROOT}" p`);
	assert.equal(compare(d), '2', 'an empty payload reported as current');
});

test('stamp_read states the absence rather than printing nothing', () => {
	const r = sh(`stamp_read "${stick({ payload: false })}"`);
	assert.notEqual(r.status, 0);
	assert.match(r.out, /no STAMP/);
});

/**
 * THE FALSE PASS THIS FILE EXISTS TO PREVENT, measured 2026-09-02.
 *
 * The first version hashed two fixed paths under bootstrap/. Everything in
 * fixes/ was invisible, so when claw-net-fix.sh was renamed and rewritten as
 * claw-fix.sh, a stick carrying the OLD script reported CURRENT. A stamp that
 * says current when it is not is worse than no stamp: it is the thing telling
 * you not to refresh.
 */
test('a stick whose fix scripts differ reads STALE', () => {
	const d = stick();
	write(d);
	const fixes = readdirSync(join(d, 'fixes')).filter((f) => f.endsWith('.sh'));
	assert.ok(fixes.length > 0, 'the fixture shipped no fix scripts, so this asserts nothing');
	writeFileSync(join(d, 'fixes', fixes[0]), '# drifted\n', { flag: 'a' });
	assert.equal(compare(d), '1', 'a changed fix script passed as current');
});

test('a RENAMED fix script reads STALE — names are payload too', () => {
	// The exact shape of the real miss. Content-only hashing of a fixed path
	// list cannot see this, which is why the digest includes filenames.
	const d = stick();
	write(d);
	const fixes = readdirSync(join(d, 'fixes')).filter((f) => f.endsWith('.sh'));
	renameSync(join(d, 'fixes', fixes[0]), join(d, 'fixes', 'old-name.sh'));
	assert.equal(compare(d), '1', 'a renamed fix script passed as current');
});

test('a stick missing a fix script entirely reads STALE', () => {
	const d = stick();
	write(d);
	const fixes = readdirSync(join(d, 'fixes')).filter((f) => f.endsWith('.sh'));
	rmSync(join(d, 'fixes', fixes[0]));
	assert.equal(compare(d), '1', 'a missing fix script passed as current');
});

test('*.test.mjs beside the fix scripts cannot change the verdict', () => {
	// They have no business on a stick, and whether usb-prep happens to copy
	// them must not decide whether the payload reads current.
	const d = stick();
	write(d);
	writeFileSync(join(d, 'fixes', 'stray.test.mjs'), '// not payload\n');
	assert.equal(compare(d), '0', 'a stray test file flipped the verdict');
});

test('the payload list is non-empty — an empty one would compare nothing', () => {
	assert.ok(BOOTSTRAP_FILES.length >= 2, `parsed only ${BOOTSTRAP_FILES.length} bootstrap files`);
	assert.ok(BOOTSTRAP_FILES.includes('convert.sh'), 'convert.sh is payload and must be stamped');
});
