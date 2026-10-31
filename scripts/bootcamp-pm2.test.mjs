import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { CLAW, run, writableFixture } from './lib/bootcamp-fixtures.mjs';

// ── `pm2-capable` is EARNED, and `pm2-host` is not earned by being able to ──
//
// Wave 3o, lane C. The two questions were one id until 2026-09-26 and merging
// them routes a production deploy onto the wrong box: six workflows carry
// `runs-on: [self-hosted, pm2-host]`, and `nodeOffer` puts every earned identity
// LABEL onto a node's registrations and JIT mints. These run the real
// `bootcamp.mjs` against a canned probe answer, so what is asserted is what the
// writer actually records.

/** A probe answer carrying both pm2 verdicts, as a real claw returns them. */
const PM2_ANSWER = (hostVerdict, capableVerdict) =>
	[
		'CAP ffmpeg ok 7.1.5-0+deb13u1',
		`CAP pm2-host ${hostVerdict}`,
		`CAP pm2-capable ${capableVerdict}`,
		'PROBE-END',
		'',
	].join('\n');

test('a claw that proves pm2-capable earns it, and does NOT earn pm2-host', () => {
	// claw-9's real answer, 2026-09-26: the supervisor installed, supervised,
	// survived a daemon kill/resurrect and was removed; no pm2 daemon runs there,
	// so `pm2-host` is `no absent`.
	const f = writableFixture(PM2_ANSWER('no absent', 'ok 32003'));
	try {
		assert.equal(run(['--machine', CLAW, '--write', '--no-push'], f.env).code, 0);
		const rec = f.record();
		assert.ok(rec.earned.includes('pm2-capable'), `pm2-capable not earned: ${rec.earned}`);
		// THE ONE THAT MATTERS. Being ABLE to host must never make a claw the
		// host — `$capabilities.earned` is what `nodeOffer` derives a node's
		// GitHub label set from.
		assert.ok(
			!rec.earned.includes('pm2-host'),
			`a claw that can host must not be routed the six infra workflows: ${rec.earned}`
		);
		assert.deepEqual(rec.unclaimed, [], 'pm2-capable is implicit — it is not a label to claim');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('below the declared bar, pm2-capable is NOT earned and the run says the number', () => {
	// claw-6's real answer, 2026-09-26: 7,849 MiB installed against a role
	// measured at 9,784 MiB steady. The supervisor worked perfectly — `ok` means
	// "I measured it", and the registry's bar is what refuses it.
	const f = writableFixture(PM2_ANSWER('no absent', 'ok 7849'));
	try {
		const r = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.ok(!f.record().earned.includes('pm2-capable'));
		// AND THE REASON IS IN THE REPORT. An absence with no reason behind it is
		// the "I could not look renders as nothing is wrong" shape, one level
		// down: a firewall, a dead dump file and 8 GB of RAM are three different
		// jobs and this is the only line that tells them apart.
		assert.match(r.out, /not earned: pm2-capable — installed memory 7849MiB < 9784MiB required/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a pm2-capable probe that could not run reports its reason, not a small box', () => {
	const f = writableFixture(PM2_ANSWER('no absent', 'no supervisor-install-failed'));
	try {
		const r = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.ok(!f.record().earned.includes('pm2-capable'));
		assert.match(r.out, /not earned: pm2-capable — supervisor-install-failed/);
		assert.ok(!/not earned: pm2-capable — installed memory/.test(r.out));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a second --write on an unchanged pm2-capable node still commits nothing (#59)', () => {
	// The property #59 bought, asserted against the capability this lane added —
	// because the reason a re-probe stays silent is that nothing PER-RUN reaches
	// the record, and a MEASURED capability is exactly the kind of thing that
	// would break it. `pm2-capable`'s measurement is installed memory, which does
	// not move; its `meetsBar` reason, which does not move either, stays on
	// stdout and out of the record on purpose.
	const f = writableFixture(PM2_ANSWER('no absent', 'ok 32003'));
	try {
		const base = f.commits();
		assert.equal(run(['--machine', CLAW, '--write', '--no-push'], f.env).code, 0);
		assert.equal(f.commits(), base + 1);
		const first = f.record();

		const second = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.equal(second.code, 0, `${second.out}\n${second.err}`);
		assert.equal(
			f.commits(),
			base + 1,
			'an idempotent re-probe committed, which redeploys mgmt-api'
		);
		assert.equal(f.record().at, first.at);
		assert.match(second.out, /re-probed and UNCHANGED/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
