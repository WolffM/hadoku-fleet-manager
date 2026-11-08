/**
 * capabilities.mjs (wave gates2 lane F1a). Two callers, two shapes — see its
 * own header. With NO `--machine` (mgmt-api's `ci:audit-gates` row) it is a
 * thin, deliberate no-op: this pins that it stays a GateDoc-valid,
 * always-passing document, never a disguised real check that could start
 * silently failing or silently hiding a finding.
 *
 * WITH `--machine <node>` (`reboot-claws.mjs`'s re-prove step,
 * `lib/reboot-cycle.mjs`'s `judgeReprove`) it is NOT a no-op: deleting
 * `check-capabilities.mjs` outright would have made `judgeReprove` read
 * EVERY reboot as a broken node forever (`doc.results` would never carry
 * one), holding every rebooted claw drained. So this spawns
 * `fleet bootcamp --check-only --machine <node> --json` for real and
 * reshapes its document — stood in here by `FLEET_BOOTCAMP_SCRIPT_FOR_TEST`,
 * a canned script, so this proves the RESHAPING without ssh or a fleet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'capabilities.mjs');
const NODE = 'fixture-claw';

test('human mode: exits 0 and names what this merged into', () => {
	const out = execFileSync('node', [SCRIPT], { encoding: 'utf8' });
	assert.match(out, /capabilit/i);
	assert.match(out, /bootcamp/);
	assert.match(out, /boundary-contracts/);
});

test('--json: a GateDoc-shaped, always-clean document — ok, findings, unreadable', () => {
	const out = execFileSync('node', [SCRIPT, '--json'], { encoding: 'utf8' });
	const doc = JSON.parse(out);
	assert.equal(doc.ok, true);
	assert.deepEqual(doc.findings, []);
	assert.deepEqual(doc.unreadable, []);
	assert.match(doc.note, /retired/);
});

/** A stand-in `bootcamp.mjs`: ignores its real argv, emits exactly `doc`, exits `code`. */
function fakeBootcamp(dir, doc, code = 0) {
	const p = join(dir, 'fake-bootcamp.mjs');
	writeFileSync(
		p,
		`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(doc))});\nprocess.exit(${code});\n`
	);
	chmodSync(p, 0o755);
	return p;
}

function withFakeBootcamp(doc, code, fn) {
	const dir = mkdtempSync(join(tmpdir(), 'capabilities-reprove-'));
	try {
		const fake = fakeBootcamp(dir, doc, code);
		fn(fake);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function runMachine(fake, args = []) {
	try {
		const out = execFileSync('node', [SCRIPT, '--machine', NODE, '--json', ...args], {
			encoding: 'utf8',
			env: { ...process.env, FLEET_BOOTCAMP_SCRIPT_FOR_TEST: fake },
		});
		return { code: 0, doc: JSON.parse(out) };
	} catch (e) {
		return { code: e.status ?? -1, doc: JSON.parse(e.stdout ?? '{}') };
	}
}

test('--machine: a clean bootcamp --check-only re-probe reshapes to {ok:true, results, findings:[]}', () => {
	withFakeBootcamp(
		{ ok: true, report: { [NODE]: { earned: ['ffmpeg'] } }, unreachable: [] },
		0,
		(fake) => {
			const { code, doc } = runMachine(fake);
			assert.equal(code, 0, JSON.stringify(doc));
			assert.equal(doc.ok, true);
			assert.deepEqual(doc.findings, []);
			assert.ok(NODE in doc.results, 'judgeReprove requires the node IN doc.results');
		}
	);
});

test('MUTATION: bootcamp reporting drift (ok:false) reshapes to a real finding, not a pass', () => {
	withFakeBootcamp(
		{ ok: false, report: { [NODE]: { notEarned: [{ id: 'ffmpeg' }] } } },
		1,
		(fake) => {
			const { code, doc } = runMachine(fake);
			assert.equal(code, 1);
			assert.equal(doc.ok, false);
			assert.ok(doc.findings.length > 0, 'drift on re-probe must be a real finding');
		}
	);
});

test('a bootcamp that cannot even be read (no JSON) is "I could not look", never a pass', () => {
	const dir = mkdtempSync(join(tmpdir(), 'capabilities-reprove-'));
	try {
		const fake = join(dir, 'broken.mjs');
		writeFileSync(fake, `#!/usr/bin/env node\nprocess.stderr.write('boom');\nprocess.exit(1);\n`);
		chmodSync(fake, 0o755);
		const { code, doc } = runMachine(fake);
		assert.equal(code, 1);
		assert.equal(doc.ok, false);
		assert.ok(doc.unreadable.length > 0 || doc.findings.length > 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
