/**
 * node-usb-prep.sh's ssh-key listing (set -u regression, 2026-10-02) and the
 * CLAWKIT/netinst partition sizing (the --netinst-iso "all free space"
 * regression, 2026-10-02). Split out of `make-preseed.test.mjs` (wave 5s
 * lane D, 1,000-line test ceiling). See `make-preseed-content.test.mjs` for
 * the rest of this file's original header.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './test-tmpdir.mjs';
import { NODE_USB_PREP, sbinEnv } from './make-preseed-fixtures.mjs';

function pubkeyChoicesSnippet() {
	const src = readFileSync(NODE_USB_PREP, 'utf8');
	const start = src.indexOf(': PUBKEY-CHOICES-BEGIN');
	const end = src.indexOf(': PUBKEY-CHOICES-END');
	assert.ok(
		start > -1 && end > -1,
		'the PUBKEY-CHOICES sentinels are missing from node-usb-prep.sh'
	);
	return src.slice(start, end);
}

// Regression: on 2026-10-02 the operator's first interactive run died with
// "no .pub files in /home/hadoku/.ssh" while three keys sat in it. The span
// read $SEEN before assigning it, and `set -u` killed the subshell on its
// first key. Run the REAL span under the script's own shell options.
test('node-usb-prep.sh lists every ssh public key under set -u, the fleet key first and once', () => {
	const home = tempDir('pubkey-choices-');
	mkdirSync(join(home, '.ssh'));
	for (const name of ['id_ed25519.pub', 'id_ed25519_hokon.pub', 'phone_landing.pub']) {
		writeFileSync(join(home, '.ssh', name), `ssh-ed25519 AAAA ${name}-comment\n`);
	}
	const fleetKey = join(home, '.ssh', 'id_ed25519_hokon');
	const script = [
		'set -euo pipefail',
		`oper_home() { printf '%s' ${JSON.stringify(home)}; }`,
		`FLEET_KEY=${JSON.stringify(fleetKey)}`,
		pubkeyChoicesSnippet(),
		'printf "COUNT:%s\\n" "${#KEY_CHOICES[@]}"',
		'printf "ROW:%s\\n" "${KEY_CHOICES[@]}"',
	].join('\n');
	const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
	assert.match(out, /^COUNT:3$/m, `expected all three keys, deduplicated; got:\n${out}`);
	const rows = out.split('\n').filter((l) => l.startsWith('ROW:'));
	assert.match(
		rows[0],
		/id_ed25519_hokon\.pub.*the key every claw already authorises/,
		'the fleet key must be listed first and marked'
	);
	assert.equal(
		rows.filter((r) => r.includes('id_ed25519_hokon.pub')).length,
		1,
		'the fleet key must not be listed twice'
	);
});

function kitSpecSnippet() {
	const src = readFileSync(NODE_USB_PREP, 'utf8');
	const start = src.indexOf(': KIT-SPEC-BEGIN');
	const end = src.indexOf(': KIT-SPEC-END');
	assert.ok(start > -1 && end > -1, 'the KIT-SPEC sentinels are missing from node-usb-prep.sh');
	return src.slice(start, end);
}

// Regression: the first real full rebuild with --netinst-iso (2026-10-02)
// created CLAWKIT with `,,83` (all free space). That swallowed the whole
// 1,787 MB reserve, so the netinst append failed with "Invalid argument". The
// earlier image test pre-built all four partitions and never ran the step
// where CLAWKIT is carved out of the combined reserve. This one starts where
// Ventoy leaves the disk: two partitions, then a free tail exactly the size
// of CLAWKIT + netinst.
function runKitThenNetinst({ netinst }) {
	const KIT_MB = 16;
	const NETINST_MB = 40;
	const dir = tempDir('kit-spec-');
	const img = join(dir, 'disk.img');
	execFileSync('truncate', ['-s', `${1 + 16 + 8 + KIT_MB + NETINST_MB}MiB`, img]);
	execFileSync('sfdisk', [img], { input: 'label: dos\n', env: sbinEnv() });
	execFileSync('sfdisk', ['--append', img], { input: 'size=16MiB\n', env: sbinEnv() }); // Ventoy
	execFileSync('sfdisk', ['--append', img], { input: 'size=8MiB\n', env: sbinEnv() }); // VTOYEFI
	const script = [
		'set -euo pipefail',
		`KIT_MB=${KIT_MB}`,
		netinst ? `NETINST_ISO_MB=${NETINST_MB}` : 'NETINST_ISO_MB=""',
		kitSpecSnippet(),
		`echo "$KIT_SPEC" | sfdisk --append ${JSON.stringify(img)} >/dev/null`,
		netinst
			? `printf 'size=%sMiB\\n' "$NETINST_ISO_MB" | sfdisk --append ${JSON.stringify(img)} >/dev/null`
			: 'true',
	].join('\n');
	execFileSync('bash', ['-c', script], { env: sbinEnv(), stdio: 'pipe' });
	const dump = execFileSync('sfdisk', ['-d', img], { encoding: 'utf8', env: sbinEnv() });
	return dump.split('\n').filter((l) => /^\S+ : start=/.test(l));
}

test('with --netinst-iso, CLAWKIT is sized to its own share and partition 4 fits in the rest of the reserve', () => {
	const src = readFileSync(NODE_USB_PREP, 'utf8');
	assert.ok(
		src.includes(`printf 'size=%sMiB\\n' "$NETINST_ISO_MB"`),
		'the netinst append in node-usb-prep.sh changed; update this test to match it'
	);
	const parts = runKitThenNetinst({ netinst: true });
	assert.equal(
		parts.length,
		4,
		`expected Ventoy, VTOYEFI, CLAWKIT and netinst; got:\n${parts.join('\n')}`
	);
	assert.match(
		parts[2],
		/size=\s*32768\b/,
		`CLAWKIT should be exactly 16 MiB (32768 sectors); got ${parts[2]}`
	);
	assert.match(
		parts[3],
		/size=\s*81920\b/,
		`netinst should be exactly 40 MiB (81920 sectors); got ${parts[3]}`
	);
});

test('without --netinst-iso, CLAWKIT still takes all of the free reserve', () => {
	const parts = runKitThenNetinst({ netinst: false });
	assert.equal(parts.length, 3);
	assert.match(
		parts[2],
		/size=\s*114688\b/,
		`CLAWKIT should fill the 56 MiB tail; got ${parts[2]}`
	);
});
