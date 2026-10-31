import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLAW, PROBE_ANSWER, run, writableFixture } from './lib/bootcamp-fixtures.mjs';

// THE REBOOT CYCLE'S RE-PROVE (2026-10-25): a bootcamp that EXECUTES a revoked
// label and passes gives it back — the only way, besides `fleet capabilities`,
// a revocation is ever cleared (src/capability-revocations.ts).
test('a bootcamp that proves a revoked label CLEARS the revocation', () => {
	const f = writableFixture(
		['CAP ffmpeg ok 7.1.5-0+deb13u1', 'CAP nvenc-h264 ok h264_nvenc', 'PROBE-END', ''].join('\n')
	);
	try {
		const file = join(f.stateDir, 'capability-revocations.json');
		writeFileSync(
			file,
			JSON.stringify({
				nodes: { [CLAW]: { 'nvenc-h264': { at: 'a', reason: 'driver', by: 'capabilities' } } },
			})
		);
		const r = run(['--machine', CLAW, '--json'], f.env);
		const doc = JSON.parse(r.out);
		assert.deepEqual(
			doc.revocations.cleared.map((v) => v.capability),
			['nvenc-h264'],
			r.err
		);
		assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).nodes, {});
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// fleet-manager#15: the revocation write is DELIBERATE in every mode — a label
// a probe just watched FAIL must stop routing immediately, `--write` or not
// (see the doc comment above `revocationChanges` in bootcamp.mjs). Before this
// fix the dry run's own output never said that write happened; a human reading
// `fleet bootcamp` with no `--write` had every reason to believe nothing on
// disk had changed.
test('#15: a dry run that CLEARS a revocation says plainly that revocations write without --write', () => {
	const f = writableFixture(
		['CAP ffmpeg ok 7.1.5-0+deb13u1', 'CAP nvenc-h264 ok h264_nvenc', 'PROBE-END', ''].join('\n')
	);
	try {
		const file = join(f.stateDir, 'capability-revocations.json');
		const seed = JSON.stringify({
			nodes: { [CLAW]: { 'nvenc-h264': { at: 'a', reason: 'driver', by: 'capabilities' } } },
		});
		writeFileSync(file, seed);
		const human = run(['--machine', CLAW], f.env);
		assert.match(human.out, /cleared nvenc-h264 — proven again, routable/);
		assert.match(
			human.out,
			/revocations are written in every mode, with or without --write/,
			`the dry run must say it changed the revocation record on disk:\n${human.out}`
		);

		// RESEED: the run above already cleared the revocation on disk, and
		// `applyVerdicts` reports nothing changed the second time a pass clears
		// something already clear — the SAME behaviour `--json` below must be
		// checked against, not a no-op.
		writeFileSync(file, seed);
		const r = run(['--machine', CLAW, '--json'], f.env);
		const doc = JSON.parse(r.out);
		assert.deepEqual(
			doc.revocations.cleared.map((v) => v.capability),
			['nvenc-h264']
		);
		assert.equal(
			doc.revocations.writesEvenWithoutWrite,
			true,
			'--json carries the policy additively'
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('#15: a dry run that REVOKES a label says which one, and why, without --write', () => {
	const f = writableFixture(
		['CAP ffmpeg ok 7.1.5-0+deb13u1', 'CAP nvenc-h264 fail no nvenc device', 'PROBE-END', ''].join(
			'\n'
		)
	);
	try {
		const doc = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
		// Already offering nvenc-h264 (earned on a prior pass) is what makes a
		// FAILING probe a revocation rather than a quiet non-finding — see
		// `nodeOffer`'s `offeredBefore` check in bootcamp.mjs.
		doc.machines[CLAW].$capabilities = { at: 'a', earned: ['nvenc-h264', 'ffmpeg'] };
		writeFileSync(f.manifestPath, JSON.stringify(doc, null, 2));

		const human = run(['--machine', CLAW], f.env);
		assert.match(human.out, /REVOKED nvenc-h264 — withheld from routing until a probe passes/);
		assert.match(
			human.out,
			/revocations are written in every mode, with or without --write/,
			`the dry run must say it just wrote a revocation:\n${human.out}`
		);

		const stateFile = join(f.stateDir, 'capability-revocations.json');
		assert.deepEqual(
			Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).nodes[CLAW]),
			['nvenc-h264'],
			'the revocation landed on disk with no --write anywhere on the command line'
		);

		// RESEED to "nothing revoked yet": the run above already wrote the
		// revocation, and `applyVerdicts` reports nothing changed on a capability
		// already held revoked — removing the file restores the state this
		// node started in, so the --json run below observes the same transition.
		rmSync(stateFile, { force: true });
		const r = run(['--machine', CLAW, '--json'], f.env);
		const j = JSON.parse(r.out);
		assert.deepEqual(
			j.revocations.revoked.map((v) => v.capability),
			['nvenc-h264']
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('#15: under --write the revocation explanation is not printed — it only disambiguates a dry run', () => {
	const f = writableFixture(
		['CAP ffmpeg ok 7.1.5-0+deb13u1', 'CAP nvenc-h264 ok h264_nvenc', 'PROBE-END', ''].join('\n')
	);
	try {
		const file = join(f.stateDir, 'capability-revocations.json');
		writeFileSync(
			file,
			JSON.stringify({
				nodes: { [CLAW]: { 'nvenc-h264': { at: 'a', reason: 'driver', by: 'capabilities' } } },
			})
		);
		const r = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.match(r.out, /cleared nvenc-h264 — proven again, routable/);
		assert.ok(
			!/revocations are written in every mode/.test(r.out),
			`--write already implies a write; the dry-run caveat is noise here:\n${r.out}`
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// fleet-manager#16: a controller that cannot name the data endpoint did not
// probe `data-peer` at all. That is INCONCLUSIVE, said and failing the run, and
// it must not strip the label from a node that earned it.
test('an unnamed data endpoint leaves an earned data-peer standing, and says so', () => {
	const f = writableFixture(PROBE_ANSWER('7.1.5-0+deb13u1'));
	try {
		const doc = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
		doc.machines[CLAW].$capabilities = { at: 'a', earned: ['data-peer', 'ffmpeg'] };
		writeFileSync(f.manifestPath, JSON.stringify(doc, null, 2));
		const { FLEET_DATA_URL: _, ...env } = f.env;
		const r = run(['--machine', CLAW, '--write', '--no-push'], env);
		assert.notEqual(r.code, 0, 'could not look must not pass');
		assert.match(r.out + r.err, /INCONCLUSIVE: data-peer — the data endpoint could not be named/);
		assert.deepEqual(f.record().earned, ['data-peer', 'ffmpeg']);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('two consecutive --write runs on an unchanged node produce ONE commit, not two', () => {
	const f = writableFixture(PROBE_ANSWER('7.1.5-0+deb13u1'));
	try {
		const base = f.commits();

		const first = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.equal(first.code, 0, `first run failed:\n${first.out}\n${first.err}`);
		assert.equal(f.commits(), base + 1, 'the first run must record the finding');
		const recorded = f.record();
		assert.ok(recorded, 'no $capabilities written');
		assert.deepEqual(recorded.earned, ['ffmpeg']);

		// THE WHOLE ISSUE. Same node, same answer, nothing to say.
		const second = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.equal(second.code, 0, `second run failed:\n${second.out}\n${second.err}`);
		assert.equal(
			f.commits(),
			base + 1,
			'a re-probe that found nothing new committed anyway — every such commit ' +
				"redeploys mgmt-api through hadoku_site's path filter (#59)"
		);
		assert.equal(f.record().at, recorded.at, '`at` moved with no change behind it');
		assert.match(second.out, /re-probed and UNCHANGED/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('#17: --json says what --write did to the record, landed or unchanged', () => {
	// The refresh cycle spends a recheck turn only on a run that landed, so
	// this field is read, not decoration.
	const f = writableFixture(PROBE_ANSWER('7.1.5-0+deb13u1'));
	try {
		const first = JSON.parse(run(['--machine', CLAW, '--write', '--no-push', '--json'], f.env).out);
		assert.equal(first.written.ok, true);
		assert.notEqual(first.written.reason, 'unchanged');
		const second = JSON.parse(
			run(['--machine', CLAW, '--write', '--no-push', '--json'], f.env).out
		);
		assert.deepEqual(second.written, { ok: true, reason: 'unchanged' });
		const dry = JSON.parse(run(['--machine', CLAW, '--json'], f.env).out);
		assert.equal(dry.written, null, 'no --write, nothing written');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('`at` still advances, and a commit is still made, when the finding really changes', () => {
	// The other half, and the one a naive "stop rewriting the record" fix loses.
	const f = writableFixture(PROBE_ANSWER('7.1.5-0+deb13u1'));
	try {
		const base = f.commits();
		assert.equal(run(['--machine', CLAW, '--write', '--no-push'], f.env).code, 0);
		const before = f.record();

		f.answer(PROBE_ANSWER('7.2.0-1'));
		const r = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.equal(f.commits(), base + 2, 'a changed finding must land');
		const after = f.record();
		assert.deepEqual(after.prereqs, [{ id: 'ffmpeg', detail: '7.2.0-1' }]);
		assert.ok(
			Date.parse(after.at) > Date.parse(before.at),
			`at did not advance on a real change: ${before.at} -> ${after.at}`
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
