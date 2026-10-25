import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	nodeKeyFinding,
	nodeKeyFindings,
	tokenExpiryFinding,
	runnerVersionFinding,
	runnerVersionFindings,
	jitPayloadFinding,
	jitPayloadFindings,
	parseJitPayloadProbe,
	JIT_PAYLOAD_PROBE,
	rebootFinding,
	rebootFindings,
	blockingFindings,
	advisoryFindings,
	guestAdvisory,
	lanReservationFinding,
	lanReservationFindings,
	GUEST_BLOCKING_CATEGORIES,
	BLOCKING,
	ADVISORY,
	REBOOT_ESCALATE_DAYS,
} from './preflight.mjs';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER = resolve(SCRIPTS, 'check-fleet-preflight.mjs');

const DAY = 86_400_000;

// --- node-key expiry -------------------------------------------------------

test('nodeKeyFinding: absent KeyExpiry (tagged claw, or hokon self) is healthy', () => {
	const status = { Self: { HostName: 'hokon' }, Peer: { a: { HostName: 'claw-3' } } };
	assert.equal(nodeKeyFinding(status, 'hokon'), null);
	assert.equal(nodeKeyFinding(status, 'claw-3'), null);
});

test('nodeKeyFinding: a fleet node missing from the tailnet entirely is a finding', () => {
	const status = { Self: { HostName: 'hokon' }, Peer: {} };
	const f = nodeKeyFinding(status, 'claw-9');
	assert.equal(f.status, 'not-on-tailnet');
});

test('nodeKeyFinding: a real future expiry on a fleet node is drift, not a pass', () => {
	const now = Date.now();
	const status = {
		Self: { HostName: 'hokon' },
		Peer: { a: { HostName: 'claw-2', KeyExpiry: new Date(now + 90 * DAY).toISOString() } },
	};
	const f = nodeKeyFinding(status, 'claw-2', now);
	assert.equal(f.status, 'expiring');
	assert.match(f.why, /tag or toggle/);
});

test('nodeKeyFinding: a past expiry reports expired', () => {
	const now = Date.now();
	const status = {
		Self: { HostName: 'hokon' },
		Peer: {
			a: { HostName: 'claw-2', Expired: true, KeyExpiry: new Date(now - DAY).toISOString() },
		},
	};
	const f = nodeKeyFinding(status, 'claw-2', now);
	assert.equal(f.status, 'expired');
});

test('nodeKeyFindings: only findings for the fleet nodes named, personal devices ignored', () => {
	const now = Date.now();
	const status = {
		Self: { HostName: 'hokon' },
		Peer: {
			a: { HostName: 'claw-3' },
			b: { HostName: 'phone', KeyExpiry: new Date(now + 30 * DAY).toISOString() },
		},
	};
	const findings = nodeKeyFindings(status, ['hokon', 'claw-3'], now);
	assert.deepEqual(findings, []);
});

// --- HADOKU_SITE_TOKEN expiry -----------------------------------------------

test('tokenExpiryFinding: no header at all is healthy (classic PAT / OAuth app token)', () => {
	assert.equal(tokenExpiryFinding(undefined), null);
});

test('tokenExpiryFinding: far-future expiry is healthy', () => {
	const now = Date.now();
	const header = new Date(now + 60 * DAY).toISOString();
	assert.equal(tokenExpiryFinding(header, { nowMs: now }), null);
});

test('tokenExpiryFinding: inside the warn window is a finding', () => {
	const now = Date.now();
	const header = new Date(now + 5 * DAY).toISOString();
	const f = tokenExpiryFinding(header, { nowMs: now, warnDays: 14 });
	assert.equal(f.status, 'expiring');
});

test('tokenExpiryFinding: already past is "expired", not merely "expiring"', () => {
	const now = Date.now();
	const header = new Date(now - DAY).toISOString();
	const f = tokenExpiryFinding(header, { nowMs: now });
	assert.equal(f.status, 'expired');
});

test('tokenExpiryFinding: an unparseable header is its own finding, not a silent pass', () => {
	const f = tokenExpiryFinding('not-a-date');
	assert.equal(f.status, 'unparseable');
});

// --- runner version drift ---------------------------------------------------

test('runnerVersionFinding: matching the latest release is healthy', () => {
	const r = { repo: 'WolffM/x', name: 'claw-4', version: '2.337.0' };
	assert.equal(runnerVersionFinding(r, '2.337.0'), null);
});

test('runnerVersionFinding: one minor behind is within tolerance', () => {
	const r = { repo: 'WolffM/x', name: 'claw-4', version: '2.336.0' };
	assert.equal(runnerVersionFinding(r, '2.337.0', { minMinorsBehind: 2 }), null);
});

test('runnerVersionFinding: two minors behind is a finding', () => {
	const r = { repo: 'WolffM/x', name: 'claw-4', version: '2.335.0' };
	const f = runnerVersionFinding(r, '2.337.0', { minMinorsBehind: 2 });
	assert.equal(f.status, 'behind');
});

test('runnerVersionFinding: a lower major version is behind regardless of minor tolerance', () => {
	const r = { repo: 'WolffM/x', name: 'claw-4', version: '1.999.0' };
	const f = runnerVersionFinding(r, '2.0.0', { minMinorsBehind: 2 });
	assert.equal(f.status, 'behind');
});

test('runnerVersionFinding: an unparseable reported version is its own finding', () => {
	const r = { repo: 'WolffM/x', name: 'claw-4', version: '' };
	const f = runnerVersionFinding(r, '2.337.0');
	assert.equal(f.status, 'unknown');
});

test('runnerVersionFinding: an unresolvable "latest" defers rather than false-flagging every runner', () => {
	const r = { repo: 'WolffM/x', name: 'claw-4', version: '2.337.0' };
	assert.equal(runnerVersionFinding(r, undefined), null);
});

test('runnerVersionFindings: filters to only the drifted runners', () => {
	const runners = [
		{ repo: 'WolffM/x', name: 'claw-4', version: '2.337.0' },
		{ repo: 'WolffM/x', name: 'claw-6', version: '2.300.0' },
	];
	const findings = runnerVersionFindings(runners, '2.337.0');
	assert.equal(findings.length, 1);
	assert.equal(findings[0].runner, 'claw-6');
});

// --- minted runners and the JIT payload (fleet-manager#1) -------------------

// The runner ci:fleet-preflight paged on at 2026-10-23 13:20 UTC, verbatim.
const JIT_1023 = 'jit-claw-3-hadoku-fleet-ma-j120292936639-r39917109208-1792740045';

test('runnerVersionFindings: a jit-* or warm-* runner is never judged as a STANDING registration', () => {
	const runners = [
		{ repo: 'WolffM/hadoku-fleet-manager', name: JIT_1023, version: '2.336.0' },
		{ repo: 'WolffM/hadoku-fleet-manager', name: 'warm-claw-8-hadoku_site', version: '2.300.0' },
		{ repo: 'WolffM/hadoku-fleet-manager', name: 'claw-4', version: '2.336.0' },
	];
	const findings = runnerVersionFindings(runners, '2.338.1');
	assert.deepEqual(
		findings.map((f) => f.runner),
		['claw-4'],
		'only the standing registration is judged by the standing-runner rule'
	);
	assert.ok(!findings.some((f) => /jit-|warm-/.test(f.why)));
});

test('jitPayloadFinding: a payload two minors behind is its own finding, naming the node, not a registration', () => {
	const f = jitPayloadFinding(
		{ node: 'claw-3', ok: true, present: true, version: '2.336.0' },
		'2.338.1'
	);
	assert.equal(f.category, 'jit-payload');
	assert.equal(f.node, 'claw-3');
	assert.equal(f.status, 'behind');
	assert.equal(f.class, BLOCKING);
	assert.match(f.why, /~\/\.hadoku\/jit\/payload/);
	assert.match(f.why, /never rebuilds/);
	assert.doesNotMatch(f.why, /STANDING|never re-minted/);
});

test('jitPayloadFinding: within tolerance, and an absent payload, are not findings', () => {
	assert.equal(
		jitPayloadFinding({ node: 'claw-4', ok: true, present: true, version: '2.337.0' }, '2.338.1'),
		null
	);
	assert.equal(
		jitPayloadFinding({ node: 'claw-7', ok: true, present: false, version: null }, '2.338.1'),
		null
	);
});

test('jitPayloadFinding: a payload that will not run, and a node that could not be read, are findings', () => {
	const dead = jitPayloadFinding(
		{ node: 'claw-2', ok: true, present: true, version: null },
		'2.338.1'
	);
	assert.equal(dead.status, 'unrunnable');
	assert.equal(dead.class, BLOCKING);
	const dark = jitPayloadFinding({ node: 'claw-5', ok: false, error: 'ssh timed out' }, '2.338.1');
	assert.equal(dark.status, 'unreachable');
	assert.equal(dark.class, BLOCKING);
});

test('jitPayloadFindings: a guest payload is advisory through guestAdvisory, like every node finding', () => {
	const found = jitPayloadFindings(
		[{ node: 'hokon', ok: true, present: true, version: '2.300.0' }],
		'2.338.1'
	);
	assert.equal(guestAdvisory(found, ['hokon'])[0].class, ADVISORY);
});

test('JIT_PAYLOAD_PROBE, run for real: version, absent, and a binary that will not run', () => {
	const home = mkdtempSync(join(tmpdir(), 'payload-probe-'));
	try {
		const probe = () =>
			parseJitPayloadProbe(
				execFileSync('bash', ['-c', JIT_PAYLOAD_PROBE], {
					encoding: 'utf8',
					env: { PATH: process.env.PATH, HOME: home },
				})
			);
		assert.deepEqual(probe(), { present: false, version: null });
		const bin = join(home, '.hadoku', 'jit', 'payload', 'bin');
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, 'Runner.Listener'), '#!/usr/bin/env bash\necho 2.336.0\n', {
			mode: 0o755,
		});
		assert.deepEqual(probe(), { present: true, version: '2.336.0' });
		writeFileSync(join(bin, 'Runner.Listener'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
		assert.deepEqual(probe(), { present: true, version: null });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// --- pending reboots ---------------------------------------------------------

test('rebootFinding: an unreachable node is a finding, never a silent clean read', () => {
	const f = rebootFinding({ node: 'claw-5', ok: false, error: 'ssh timed out' });
	assert.equal(f.status, 'unreachable');
});

test('rebootFinding: a clean, reachable read is null', () => {
	assert.equal(rebootFinding({ node: 'claw-5', ok: true, rebootRequired: false }), null);
});

test('rebootFinding: reboot-required carries the package list', () => {
	const f = rebootFinding({
		node: 'claw-5',
		ok: true,
		rebootRequired: true,
		packages: ['linux-image-amd64'],
	});
	assert.equal(f.status, 'reboot-required');
	assert.deepEqual(f.packages, ['linux-image-amd64']);
});

test('rebootFindings: only the nodes with something to report', () => {
	const findings = rebootFindings([
		{ node: 'claw-1', ok: true, rebootRequired: false },
		{ node: 'claw-2', ok: true, rebootRequired: true, packages: [] },
	]);
	assert.equal(findings.length, 1);
	assert.equal(findings[0].node, 'claw-2');
});

// --- finding CLASS: which findings may fail the job (#14) --------------------
//
// THIS BLOCK IS THE SAFETY GUARD FOR THE ADVISORY CHANGE. Making findings
// advisory is exactly the shape of edit that silently disarms a gate, so each
// test below pins one half of the line and each one fails on a single-token
// mutation of the subject. Named in the lane report as the mutation targets.

test('blockingFindings: a finding with no class at all is BLOCKING', () => {
	// Mutate `f?.class !== ADVISORY` to `f?.class === BLOCKING` in preflight.mjs
	// and this fails — which is the point: an unclassified finding must not slip
	// through silence by omission.
	assert.equal(blockingFindings([{ category: 'x', why: 'y' }]).length, 1);
});

test('blockingFindings: an UNRECOGNISED class is BLOCKING, not silently ignored', () => {
	assert.equal(blockingFindings([{ category: 'x', class: 'informational' }]).length, 1);
	assert.equal(blockingFindings([{ category: 'x', class: 'Advisory' }]).length, 1);
});

test('blockingFindings: only an exactly-advisory finding is filtered out', () => {
	const findings = [
		{ category: 'node-key', class: BLOCKING },
		{ category: 'pending-reboot', class: ADVISORY },
	];
	assert.deepEqual(
		blockingFindings(findings).map((f) => f.category),
		['node-key']
	);
	assert.deepEqual(
		advisoryFindings(findings).map((f) => f.category),
		['pending-reboot']
	);
});

test('blockingFindings: a BLOCKING finding drives a non-zero exit decision', () => {
	// The exit code IS `blockingFindings(live).length ? 1 : 0` — the source guard
	// below pins that wiring. Replace this function's body with `return []` and
	// this test fails; that mutation is the one that would disarm the gate.
	const exitCode = (live) => (blockingFindings(live).length ? 1 : 0);
	assert.equal(exitCode([{ category: 'could-not-look', class: BLOCKING }]), 1);
	assert.equal(exitCode([{ category: 'node-key', status: 'not-on-tailnet', class: BLOCKING }]), 1);
	assert.equal(exitCode([{ category: 'pending-reboot', class: ADVISORY }]), 0);
	// AND THE ONE THAT MATTERS MOST: a real blocking finding is NOT rescued by
	// an advisory sitting beside it.
	assert.equal(
		exitCode([
			{ category: 'pending-reboot', class: ADVISORY },
			{ category: 'token-expiry', class: BLOCKING },
		]),
		1
	);
});

test('every non-reboot finding this module can produce is BLOCKING', () => {
	const now = Date.now();
	const produced = [
		nodeKeyFinding({ Self: { HostName: 'hokon' }, Peer: {} }, 'claw-9', now),
		nodeKeyFinding(
			{
				Self: { HostName: 'hokon' },
				Peer: { a: { HostName: 'claw-2', KeyExpiry: new Date(now + 90 * DAY).toISOString() } },
			},
			'claw-2',
			now
		),
		tokenExpiryFinding(new Date(now + DAY).toISOString(), { nowMs: now }),
		tokenExpiryFinding('not-a-date'),
		runnerVersionFinding({ repo: 'WolffM/x', name: 'claw-4', version: '2.300.0' }, '2.337.0'),
		runnerVersionFinding({ repo: 'WolffM/x', name: 'claw-4', version: '' }, '2.337.0'),
	];
	for (const f of produced) {
		assert.ok(f, 'fixture stopped producing a finding — the assertion below would be vacuous');
		assert.equal(f.class, BLOCKING, `${f.category}/${f.status} must not be advisory`);
	}
});

// --- pending-reboot: the ONE advisory, and its three blocking escapes --------

test('rebootFinding: an UNREACHABLE node stays BLOCKING even though reboots are advisory', () => {
	// Change `class: BLOCKING` to `ADVISORY` in rebootFinding's `!probe.ok`
	// branch and this fails. That mutation would mute a node that did not
	// answer, which is the inversion issue #14 explicitly warns about.
	const f = rebootFinding({ node: 'claw-5', ok: false, error: 'ssh timed out' });
	assert.equal(f.status, 'unreachable');
	assert.equal(f.class, BLOCKING);
	assert.equal(blockingFindings([f]).length, 1);
});

test('rebootFinding: a freshly staged reboot on a REACHABLE node is advisory', () => {
	const now = Date.now();
	const f = rebootFinding(
		{
			node: 'hokon',
			ok: true,
			rebootRequired: true,
			packages: ['linux-image-amd64'],
			stagedAtMs: now - 10 * DAY,
		},
		{ nowMs: now }
	);
	assert.equal(f.class, ADVISORY);
	assert.equal(f.ageDays, 10);
	assert.equal(blockingFindings([f]).length, 0);
	// STILL REPORTED. Advisory suppresses the exit code, never the evidence.
	assert.match(f.why, /reboot-required/);
	assert.deepEqual(f.packages, ['linux-image-amd64']);
});

test('rebootFinding: past REBOOT_ESCALATE_DAYS it is BLOCKING again, and says how long', () => {
	// Time makes the gate STRICTER. Change `ageDays > escalateDays` to `false`
	// and this fails.
	const now = Date.now();
	const f = rebootFinding(
		{ node: 'hokon', ok: true, rebootRequired: true, stagedAtMs: now - 45 * DAY },
		{ nowMs: now }
	);
	assert.equal(f.class, BLOCKING);
	assert.match(f.why, /45 days/);
	assert.match(f.why, new RegExp(String(REBOOT_ESCALATE_DAYS)));
});

test('rebootFinding: an UNDATED flag is BLOCKING — an advisory that cannot age out is a mute', () => {
	for (const stagedAtMs of [null, undefined, NaN, 'UNKNOWN']) {
		const f = rebootFinding({ node: 'claw-3', ok: true, rebootRequired: true, stagedAtMs });
		assert.equal(f.class, BLOCKING, `stagedAtMs=${String(stagedAtMs)} must not be advisory`);
		assert.equal(f.ageDays, null);
		assert.match(f.why, /could not be DATED/);
	}
});

test('rebootFinding: the escalation window is 30 days, and it is a DECISION, not a default', () => {
	// Pinned so that widening the window is a visible edit to two places rather
	// than a quiet one to a constant. It is deliberately longer than hokon's
	// current 10-day-old flag; the reasoning is in preflight.mjs's docblock.
	assert.equal(REBOOT_ESCALATE_DAYS, 30);
});

test('rebootFindings: the per-node options reach every probe', () => {
	const now = Date.now();
	const findings = rebootFindings(
		[
			{ node: 'claw-1', ok: true, rebootRequired: true, stagedAtMs: now - 3 * DAY },
			{ node: 'claw-2', ok: true, rebootRequired: true, stagedAtMs: now - 3 * DAY },
		],
		{ nowMs: now, escalateDays: 1 }
	);
	assert.equal(findings.length, 2);
	for (const f of findings) assert.equal(f.class, BLOCKING);
});

// --- the wiring: the classifier must be what the script actually exits on ----
//
// Same reasoning as expected-down.test.mjs's wiring block: a classifier nothing
// calls is worse than none, because the gate then looks classified and is not.

test('check-fleet-preflight.mjs decides its exit code with blockingFindings()', () => {
	const src = readFileSync(DRIVER, 'utf8');
	// `live` goes through `guestAdvisory` first and `blockingFindings` reads the
	// RESULT. A driver that classified and then exited on `live` would look
	// role-aware and page on a guest anyway — the wiring is the whole check.
	assert.match(
		src,
		/const classified = guestAdvisory\(live, guestNodeNames\(manifest\)\)/,
		'the driver no longer applies the guest role to its findings'
	);
	assert.match(
		src,
		/const blocking = blockingFindings\(classified\)/,
		'the driver no longer derives its blocking set from the classifier'
	);
	assert.match(
		src,
		/const advisory = advisoryFindings\(classified\)/,
		'a guest finding classified out of `blocking` must still land in `advisory`'
	);
	assert.match(
		src,
		/process\.exit\(blocking\.length \? 1 : 0\)/,
		'the exit code is no longer driven by the blocking findings'
	);
	// AND the advisory findings must leave `findings`, or the cron keeps paging:
	// fleet-preflight-check.ts throws on findings.length and never reads the
	// exit code at all.
	assert.match(src, /findings: blocking,/, 'advisory findings would still be paged on');
	assert.match(src, /\n\t\t\tadvisory,/, 'advisory findings must still ride in the JSON');
});

test('the could-not-look finding the driver synthesises is explicitly BLOCKING', () => {
	const src = readFileSync(DRIVER, 'utf8');
	assert.match(
		src,
		/category: 'could-not-look', class: BLOCKING/,
		'"I could not look" must never be downgradable to advisory'
	);
});

// ── guestAdvisory — the role, and the two places it must NOT reach ───────────

const guests = new Set(['hokon']);

test("guestAdvisory: a guest's blocking finding becomes advisory and keeps its why", () => {
	const f = {
		node: 'hokon',
		category: 'pending-reboot',
		class: BLOCKING,
		status: 'reboot-required',
		why: 'hokon has `/var/run/reboot-required` set — an update is staged.',
	};
	const [out] = guestAdvisory([f], guests);
	assert.equal(out.class, ADVISORY);
	assert.equal(out.role, 'guest');
	assert.equal(out.wasBlocking, true);
	assert.match(out.why, /an update is staged/, 'the original diagnosis must survive');
	assert.match(out.why, /GUEST/, 'and it must say why it stopped blocking');
	assert.equal(blockingFindings(guestAdvisory([f], guests)).length, 0);
	assert.equal(advisoryFindings(guestAdvisory([f], guests)).length, 1);
});

test('guestAdvisory: it is not a drop — the finding still rides in the report', () => {
	const f = { node: 'hokon', category: 'disk', class: BLOCKING, why: '/ is 4% free.' };
	assert.equal(guestAdvisory([f], guests).length, 1, 'advisory is not the same as removed');
});

test('guestAdvisory: a CLAW is untouched — the role exempts one box, not the fleet', () => {
	const f = { node: 'claw-3', category: 'pending-reboot', class: BLOCKING, why: 'staged.' };
	const [out] = guestAdvisory([f], guests);
	assert.equal(out, f, 'a claw finding must be passed through by identity');
	assert.equal(blockingFindings([out]).length, 1);
});

test('guestAdvisory: "could not look" stays BLOCKING even on a guest', () => {
	// The one question a guest IS in scope for — is its registration online with
	// its labels — cannot be answered about a box nothing can reach. Muting this
	// would invert preflight property (2) via a config key.
	const f = { node: 'hokon', category: 'unreachable', class: BLOCKING, why: 'ssh refused.' };
	const [out] = guestAdvisory([f], guests);
	assert.equal(out.class, BLOCKING);
	assert.equal(blockingFindings([out]).length, 1);
	assert.ok(GUEST_BLOCKING_CATEGORIES.has('unreachable'));
});

test('guestAdvisory: a finding with no node is never re-classed — a role cannot speak for it', () => {
	// token-expiry is about the CREDENTIAL, and runner-version is keyed by repo.
	const tok = { category: 'token-expiry', class: BLOCKING, why: 'expires in 3d.' };
	const ver = { category: 'runner-version', class: BLOCKING, repo: 'WolffM/x', why: 'behind.' };
	assert.deepEqual(guestAdvisory([tok, ver], guests), [tok, ver]);
	assert.equal(blockingFindings(guestAdvisory([tok, ver], guests)).length, 2);
});

test('guestAdvisory: an EMPTY guest set changes nothing, by identity', () => {
	const f = { node: 'hokon', category: 'disk', class: BLOCKING, why: '/ is 4% free.' };
	assert.equal(guestAdvisory([f], new Set())[0], f);
	assert.equal(guestAdvisory([f])[0], f, 'and the default is "no node is exempt"');
});

test('guestAdvisory: MUTATION — dropping the node check would mute the whole fleet', () => {
	const fleet = [
		{ node: 'hokon', category: 'disk', class: BLOCKING, why: 'a.' },
		{ node: 'claw-1', category: 'disk', class: BLOCKING, why: 'b.' },
		{ node: 'claw-2', category: 'thermal', class: BLOCKING, why: 'c.' },
	];
	const blocking = blockingFindings(guestAdvisory(fleet, guests));
	assert.deepEqual(
		blocking.map((f) => f.node),
		['claw-1', 'claw-2'],
		'exactly the two claws, and never the guest'
	);
});

// --- LAN reservations -------------------------------------------------------

const CLAW4_IFACES = [
	{ name: 'enp0s31f6', wireless: false, mac: '02:00:00:00:de:05', ipv4: '192.0.2.158' },
];
const CLAW4_LAN = { mac: '02:00:00:00:DE:05', ip: '192.0.2.158', reservedOn: '2026-10-11' };
const CLAW4_OK = { node: 'claw-4', ok: true, ifaces: CLAW4_IFACES };
const SUGGEST = { iface: 'enp0s31f6', mac: '02:00:00:00:de:05', ip: '192.0.2.158' };

test('lanReservationFinding: recorded, held and reached on the reserved address is clean', () => {
	assert.equal(lanReservationFinding(CLAW4_OK, CLAW4_LAN, '192.0.2.158'), null);
});

test('lanReservationFinding: a node with no record is BLOCKING and names what to reserve', () => {
	const f = lanReservationFinding(CLAW4_OK, undefined, '192.0.2.158', SUGGEST);
	assert.equal(f.status, 'unrecorded');
	assert.equal(f.class, BLOCKING);
	assert.match(f.why, /02:00:00:00:de:05 -> 192\.0\.2\.158/);
	assert.match(f.why, /fleet lan-reserve --machine claw-4 --write/);
});

test('lanReservationFinding: a moved lease is drift, whatever ssh says', () => {
	const moved = { ...CLAW4_OK, ifaces: [{ ...CLAW4_IFACES[0], ipv4: '192.0.2.122' }] };
	assert.equal(lanReservationFinding(moved, CLAW4_LAN, '192.0.2.122').status, 'drifted');
});

test('lanReservationFinding: a replaced NIC is not mistaken for a clean box', () => {
	const swapped = { ...CLAW4_OK, ifaces: [{ ...CLAW4_IFACES[0], mac: '02:00:00:00:00:55' }] };
	assert.equal(lanReservationFinding(swapped, CLAW4_LAN, '192.0.2.158').status, 'nic-missing');
});

test('lanReservationFinding: a reserved interface with no address is a finding', () => {
	const down = { ...CLAW4_OK, ifaces: [{ ...CLAW4_IFACES[0], ipv4: null }] };
	assert.equal(lanReservationFinding(down, CLAW4_LAN, '192.0.2.158').status, 'no-address');
});

test('lanReservationFinding: ssh pointed somewhere other than the reservation', () => {
	assert.equal(lanReservationFinding(CLAW4_OK, CLAW4_LAN, '192.0.2.99').status, 'ssh-mismatch');
});

test('lanReservationFinding: ssh resolving to a NAME skips only the ssh comparison', () => {
	assert.equal(lanReservationFinding(CLAW4_OK, CLAW4_LAN, 'claw-4.example.ts.net'), null);
});

test('lanReservationFinding: could not look stays BLOCKING, and a guest keeps it', () => {
	const f = lanReservationFinding({ node: 'hokon', ok: false, error: 'timeout' }, undefined, null);
	assert.equal(f.status, 'unreachable');
	assert.equal(f.class, BLOCKING);
	// A guest's lan findings are advisory like the rest of its node health.
	const unrecorded = lanReservationFinding(
		{ node: 'hokon', ok: true, ifaces: CLAW4_IFACES },
		undefined,
		null,
		SUGGEST
	);
	assert.equal(guestAdvisory([unrecorded], new Set(['hokon']))[0].class, ADVISORY);
});

test('lanReservationFindings: findings only, keyed by node', () => {
	const out = lanReservationFindings(
		[CLAW4_OK, { node: 'claw-10', ok: true, ifaces: CLAW4_IFACES }],
		{ 'claw-4': CLAW4_LAN },
		{ 'claw-4': '192.0.2.158' },
		{ 'claw-10': SUGGEST }
	);
	assert.deepEqual(
		out.map((f) => [f.node, f.status]),
		[['claw-10', 'unrecorded']]
	);
});
