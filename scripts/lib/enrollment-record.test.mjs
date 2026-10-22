/**
 * The enrollment record is the ONLY measurement of a new node that anything
 * gets, and it arrives buried in several hundred lines of apt output.
 *
 * So the two failures worth testing are not "it parsed the happy case". They
 * are:
 *
 *   - a TRUNCATED record read as a complete one. A bootstrap that died halfway
 *     through must not hand `fleet enroll` a half-measured box, because a
 *     half-measured box that parses is exactly "I could not look" rendering as
 *     "nothing is wrong".
 *   - a MISSING measurement read as zero. `null` means nobody looked and `0`
 *     means somebody looked and found none; `?? 0` collapsing them is the rule
 *     docs/VOCABULARY.md calls three-valued, and it is why `cores` refuses to
 *     coerce.
 *
 * Every fixture below is a mutation of a record that PARSES, so removing the
 * guard under test makes the case succeed and the assertion fail.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const {
	parseEnrollmentRecord,
	formatEnrollmentRecord,
	proposedManifestEntry,
	REQUIRED_FIELDS,
	RECORD_VERSION,
	derivedCapacity,
	placementBackfill,
	FLEET_MIN_FREE_GB,
} = await import('./enrollment-record.mjs');

/** A complete, valid record — the base every mutation below starts from. */
const GOOD = `ENROLL-BEGIN v1
ENROLL recordedAt 2026-08-30T18:04:11Z
ENROLL hostname claw-4
ENROLL profile desktop-debian-trixie
ENROLL role runner
ENROLL chassis desktop
ENROLL cores 16
ENROLL memTotalKb 32690104
ENROLL memAvailableKb 30112880
ENROLL diskModel Samsung SSD 990 PRO 2TB
ENROLL rootDisk nvme0n1
ENROLL diskFreeGb 1704
ENROLL osId debian
ENROLL osCodename trixie
ENROLL kernel 6.12.43+deb13-amd64
ENROLL dmiVendor Micro-Star International Co., Ltd.
ENROLL fleetUser hadoku
ENROLL sshPort 22
ENROLL authMode publickey
ENROLL sudoNoPasswd ok sudo -n succeeded
ENROLL sshKeyAuthLoopback ok throwaway-key-accepted
ENROLL sshFromControl unknown console-session; no inbound connection to observe
ENROLL ready ok converged
CAP ffmpeg ok 7.1.1
CAP av1-nvenc no not-built-in
CAP python-venv ok 3.13.5
CAP jitconfig no no-runner-binary
ENROLL-END claw-4
`;

/** Drop one line from the good record, by its `ENROLL <key>` prefix. */
function without(key) {
	return GOOD.split('\n')
		.filter((l) => !l.startsWith(`ENROLL ${key} `))
		.join('\n');
}

/** Replace one field's value in the good record. */
function withField(key, value) {
	return GOOD.split('\n')
		.map((l) => (l.startsWith(`ENROLL ${key} `) ? `ENROLL ${key} ${value}` : l))
		.join('\n');
}

// ── the happy case, so every mutation below is reachable ────────────────────

test('a complete record parses, and numbers come back as numbers', () => {
	const r = parseEnrollmentRecord(GOOD);
	assert.equal(r.version, RECORD_VERSION);
	assert.equal(r.fields.hostname, 'claw-4');
	assert.equal(r.fields.cores, 16);
	assert.equal(r.fields.memTotalKb, 32690104);
	assert.equal(r.fields.diskModel, 'Samsung SSD 990 PRO 2TB', 'a value may contain spaces');
	assert.equal(r.fields.sudoNoPasswd, 'ok');
	assert.equal(r.details.sudoNoPasswd, 'sudo -n succeeded');
	assert.equal(r.capabilities.length, 4);
});

test('it is found inside real output — apt noise, banners and ANSI colour', () => {
	const noisy =
		'Setting up ffmpeg (7:7.1.1-1) ...\n' +
		'\u001b[0;32m[node-bootstrap]\u001b[0m node claw-4 converged\n' +
		GOOD +
		'\nSome trailing garbage nobody asked for\n';
	const r = parseEnrollmentRecord(noisy);
	assert.equal(r.fields.hostname, 'claw-4');
	assert.ok(r.raw.startsWith('ENROLL-BEGIN'), 'raw is the envelope, not the whole log');
	assert.ok(r.raw.endsWith('ENROLL-END claw-4'));
});

// ── truncation ──────────────────────────────────────────────────────────────

test('a record with no END line is TRUNCATED and is refused', () => {
	// The failure mode: bootstrap died, or ssh dropped, or the buffer was cut.
	// Everything up to the cut is present and valid, so a parser that did not
	// require the envelope would happily return a node "measured" without its
	// capability probe.
	const cut = GOOD.split('\n').slice(0, 20).join('\n');
	assert.throws(() => parseEnrollmentRecord(cut), /TRUNCATED/);
});

test('no BEGIN line at all is a failure, not an empty result', () => {
	assert.throws(
		() => parseEnrollmentRecord('apt-get: everything went fine\n'),
		/no ENROLL-BEGIN line/
	);
});

test('an END naming a different node means two captures were spliced', () => {
	const spliced = GOOD.replace('ENROLL-END claw-4', 'ENROLL-END claw-5');
	assert.throws(() => parseEnrollmentRecord(spliced), /names "claw-5" but the record is about/);
});

test('two concatenated records are refused rather than last-wins', () => {
	// Last-wins would silently take the second node's core count and the
	// first node's name.
	const doubled = GOOD.replace('ENROLL cores 16', 'ENROLL cores 16\nENROLL cores 8');
	assert.throws(() => parseEnrollmentRecord(doubled), /duplicate field "cores"/);
});

test('a version this parser does not know is refused', () => {
	assert.throws(() => parseEnrollmentRecord(GOOD.replace('v1', 'v2')), /claims version "v2"/);
});

// ── three-valued, and never `?? 0` ──────────────────────────────────────────

test('an unmeasurable count is null with a reason, never zero', () => {
	const r = parseEnrollmentRecord(withField('memTotalKb', 'unknown /proc/meminfo unreadable'));
	assert.equal(r.fields.memTotalKb, null, 'null means nobody looked');
	assert.equal(r.details.memTotalKb, '/proc/meminfo unreadable');
	assert.notEqual(r.fields.memTotalKb, 0, 'a box nobody measured is not a box with no memory');
});

test('a count that is neither an integer nor `unknown` is refused, not coerced', () => {
	// `Number("16 cores")` is NaN and `parseInt` is 16; both are guesses. The
	// refusal is what stops a mis-emitted field becoming a manifest number.
	assert.throws(() => parseEnrollmentRecord(withField('cores', '16 cores')), /neither an integer/);
	assert.throws(() => parseEnrollmentRecord(withField('cores', '')), /neither an integer/);
});

test('sshFromControl stays three-valued: unknown is not `no`', () => {
	// The node cannot make the control host ssh to it. At a console there is no
	// evidence either way, and claiming `no` would report a working box as broken
	// exactly as loudly as claiming `ok` would report a broken box as working.
	assert.equal(parseEnrollmentRecord(GOOD).fields.sshFromControl, null);
	assert.equal(
		parseEnrollmentRecord(withField('sshFromControl', 'ok from 192.0.2.10')).fields.sshFromControl,
		'ok'
	);
	assert.equal(
		parseEnrollmentRecord(withField('sshFromControl', 'no refused')).fields.sshFromControl,
		'no'
	);
});

test('a capability the probe could not run is `unknown`, not `no`', () => {
	const r = parseEnrollmentRecord(
		GOOD.replace('CAP ffmpeg ok 7.1.1', 'CAP ffmpeg unknown probe-did-not-run')
	);
	const ffmpeg = r.capabilities.find((c) => c.id === 'ffmpeg');
	assert.equal(ffmpeg.ok, null, 'nobody looked');
	assert.notEqual(ffmpeg.ok, false, 'which is NOT "this node cannot"');
});

// ── completeness ────────────────────────────────────────────────────────────

test('every required field is required, individually', () => {
	// One case per field rather than one representative: a guard that checks the
	// list is only as good as the list, and this is what notices when a field is
	// added to the emitter and not to REQUIRED_FIELDS.
	for (const field of REQUIRED_FIELDS) {
		assert.throws(
			() => parseEnrollmentRecord(without(field)),
			new RegExp(`required field\\(s\\) missing: .*${field}`),
			`dropping ${field} must be refused`
		);
	}
});

test('a record with no CAP lines means the probe did not run', () => {
	const noCaps = GOOD.split('\n')
		.filter((l) => !l.startsWith('CAP '))
		.join('\n');
	// capability-probe.sh never exits non-zero and always emits a line per
	// capability, so zero lines is a probe that was not taken.
	assert.throws(() => parseEnrollmentRecord(noCaps), /no CAP lines/);
});

test('a stray line inside the envelope is refused, not skipped', () => {
	const stray = GOOD.replace('CAP ffmpeg ok 7.1.1', 'Setting up ffmpeg...\nCAP ffmpeg ok 7.1.1');
	assert.throws(() => parseEnrollmentRecord(stray), /neither ENROLL nor CAP/);
});

// ── round trip ──────────────────────────────────────────────────────────────

test('format then parse round-trips every field and capability', () => {
	const parsed = parseEnrollmentRecord(GOOD);
	const again = parseEnrollmentRecord(
		formatEnrollmentRecord({
			fields: parsed.fields,
			details: parsed.details,
			capabilities: parsed.capabilities,
		})
	);
	assert.deepEqual(again.fields, parsed.fields);
	assert.deepEqual(again.capabilities, parsed.capabilities);
});

test('rendering `unknown` without a reason is refused', () => {
	const parsed = parseEnrollmentRecord(GOOD);
	const fields = { ...parsed.fields, cores: null };
	assert.throws(
		() => formatEnrollmentRecord({ fields, details: {}, capabilities: parsed.capabilities }),
		/unknown with no reason/,
		'"unknown" alone tells the operator nothing about whether to go and look'
	);
});

// ── the proposed entry ──────────────────────────────────────────────────────

test('the proposed manifest entry keeps the MEASURED MiB beside the rounded GB', () => {
	// claw-1 measures 11885MiB and its manifest says `ramGb: 11`. The slice
	// ceiling needs the first; a human reading the roster wants the second.
	// Deriving only the rounded one is how the manifest number stopped being
	// trustworthy in the first place.
	const entry = proposedManifestEntry(parseEnrollmentRecord(GOOD));
	assert.equal(entry.memTotalMb, 31923);
	assert.equal(entry.ramGb, 31);
	assert.equal(entry.cores, 16);
});

test('the proposed entry carries the all-JIT placement — and never `ephemeral`', () => {
	// Until 2026-09-22 the entry proposed NO placement at all, and claw-9's
	// onboarding took four HAND EDITS to add it (labels, role,
	// maxRegistrations, slice, minFreeGb), each discovered by a later command
	// refusing (#50, #52). `labels: []` is the all-JIT shape, not eligibility:
	// standing eligibility is the fast loop's to grant once the node is safe,
	// and a JIT node's labels ride the mint call. `ephemeral` is the one flag
	// with an ordering dependency — it waits for bootcamp to EARN jitconfig on
	// a seeded payload, and `fleet provision` flips it.
	const entry = proposedManifestEntry(parseEnrollmentRecord(GOOD));
	assert.deepEqual(entry.labels, []);
	assert.equal(entry.role, 'claw');
	assert.equal(entry.maxRegistrations, 32);
	assert.equal(entry.minFreeGb, 25);
	assert.deepEqual(entry.slice, { swapMb: 4096, unitMaxMb: 4096 });
	assert.equal(entry.ephemeral, undefined, 'ephemeral is provision’s to flip, after jitconfig');
	assert.deepEqual(entry.capabilities, ['ffmpeg', 'python-venv'], 'only what PROBED ok');
	assert.deepEqual(entry.unproven, ['av1-nvenc', 'jitconfig'], 'and the rest, named');
});

test('minFreeGb sits ABOVE the 16 GB registration refusal', () => {
	// The site repo's claw-cleanup.test.ts fails the repo on any machine whose
	// minFreeGb is not > 16 — register-fleet-runner.sh REFUSES below
	// MIN_FREE_GB_AFTER 15 + INSTALL_GB 1 = 16 GB free. #52 was exactly this:
	// enroll wrote no minFreeGb, claw-8 and claw-9 landed, main went red.
	assert.ok(FLEET_MIN_FREE_GB > 16, `${FLEET_MIN_FREE_GB} must stay above the 16 GB refusal`);
});

test('placementBackfill fills only what is MISSING, never a human choice', () => {
	// The claw-8 shape: declared before placement was derived, fields added by
	// hand afterwards. claw-3 is the stronger case — it carries a human
	// `labels: ['jit-canary']` and `maxRegistrations: 16`, and a backfill that
	// "corrected" either would be an automation overwriting a decision.
	const backfilled = placementBackfill({ cores: 4 });
	assert.deepEqual(
		[...Object.keys(backfilled)].sort(),
		['labels', 'maxRegistrations', 'minFreeGb', 'role', 'slice'],
		'a placement-free entry gets the full derived shape'
	);
	const claw3 = placementBackfill({
		role: 'claw',
		labels: ['jit-canary'],
		maxRegistrations: 16,
		minFreeGb: 25,
		slice: { swapMb: 4096, unitMaxMb: 4096 },
	});
	assert.deepEqual(claw3, {}, 'a complete entry — including a human one — gets NOTHING');
	// A non-array labels (the reconcile refusal) is the one present-but-wrong
	// value the backfill replaces: [] is the only value this can derive.
	assert.deepEqual(placementBackfill({ labels: 'not-an-array' }).labels, []);
	// The backfill never reaches for ephemeral — that decision is bootcamp's.
	assert.equal('ephemeral' in placementBackfill({}), false);
});

test('an unmeasured memory yields a null proposal, not a zero one', () => {
	const entry = proposedManifestEntry(
		parseEnrollmentRecord(withField('memTotalKb', 'unknown /proc/meminfo unreadable'))
	);
	assert.equal(entry.ramGb, null);
	assert.equal(entry.memTotalMb, null);
});

/**
 * Capacity is DERIVED. The operator's rule, 2026-09-08: "I don't like manual
 * assignment of the claws. I prefer it to be based on the capabilities. 4
 * runners at 4gb floor should be the cap."
 */
test('derivedCapacity reproduces the numbers an operator set by hand', () => {
	// The four the fleet already agreed on, so the rule is validated against
	// decisions rather than against itself.
	assert.deepEqual(derivedCapacity(15360), { minFreeMb: 2048, maxConcurrent: 3 }, 'claw-3');
	assert.deepEqual(derivedCapacity(15936), { minFreeMb: 2048, maxConcurrent: 3 }, 'claw-4');
	assert.deepEqual(derivedCapacity(15877), { minFreeMb: 2048, maxConcurrent: 3 }, 'claw-5');
	assert.deepEqual(derivedCapacity(32002), { minFreeMb: 4096, maxConcurrent: 4 }, 'claw-7');
});

test('the cap holds however large the box is', () => {
	// "4 runners ... should be the cap" — a 1 TB node still gets 4.
	assert.equal(derivedCapacity(1_000_000).maxConcurrent, 4);
	assert.equal(derivedCapacity(62464).maxConcurrent, 4, 'hokon is not special-cased');
});

test('an 8GB node keeps a usable floor and at least one runner', () => {
	// THE REASON THE FLOOR IS NOT A FLAT 4096. Checked before adopting the rule:
	// minFreeMb 4096 everywhere gives claw-2 and claw-6 a maxConcurrent of ZERO.
	// The 4 GB is what a RUNNER gets; the floor is what the OS keeps.
	for (const mt of [7168, 7849]) {
		const d = derivedCapacity(mt);
		assert.equal(d.minFreeMb, 1536, `${mt}MB must not reserve more than it can spare`);
		assert.ok(d.maxConcurrent >= 1, `${mt}MB must still be able to take a job`);
	}
});

test('unmeasured memory yields NO capacity, never a guessed one', () => {
	// null is "nobody looked". A node whose memory could not be read must not be
	// handed numbers — undefined renders as MAX_CONCURRENT=99 in ci-throttle.sh.
	for (const bad of [null, undefined, 0, -1]) {
		assert.deepEqual(derivedCapacity(bad), { minFreeMb: null, maxConcurrent: null });
	}
});
