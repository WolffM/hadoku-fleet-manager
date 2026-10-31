/**
 * The guards that keep onboarding ONE command.
 *
 * The record that spec'd this: claw-9, 2026-09-20/21, took fifteen commands,
 * four hand edits and two alarms after bootstrap finished (#50, #52; the
 * operator's 09-21 ask). Every hand step below is now a step of `fleet
 * provision --machine <node> --confirm`, and these tests pin the wiring —
 * ORDER and the specific mechanisms the manual record proved were missing —
 * so the chain cannot quietly regress into needing a human again.
 *
 * The chain's pure DECISIONS (which seed, when ephemeral may flip, what the
 * health step owes) are held in `scripts/provision-fleet.test.mjs` against the
 * real functions; this file reads the sources the way it always did, because
 * what it guards is TOPOLOGY, not arithmetic.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './test-tmpdir.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(resolve(ROOT, ...p), 'utf8');

test('the chain runs ENROLL FIRST, and only through provision — no sixth door', () => {
	const src = read('scripts/lib/provision-plan.mjs') + read('scripts/lib/provision-phases.mjs');
	// enroll is a step of the chain, not a command the operator still owes.
	assert.ok(src.includes("resolve(HERE, 'enroll-node.mjs')"), 'provision must spawn enroll');
	// And the chain's order is the manual record's order, as data:
	// declare → converge → bootcamp → placement → register/throttle/slice →
	// realize → benchmark → health. The table is what main() walks, so the
	// order asserted here is the order that runs.
	const order = [
		["id: 'declare'"],
		["id: 'converge'"],
		["id: 'bootcamp'"],
		["id: 'placement'"],
		["id: 'register'"],
		["id: 'throttle'"],
		["id: 'slice'"],
		["id: 'realize'"],
		["id: 'benchmark'"],
		["id: 'health'"],
	].map(([s]) => src.indexOf(s));
	for (let i = 1; i < order.length; i++)
		assert.ok(
			order[i - 1] !== -1 && order[i] > order[i - 1],
			`step ${i} must follow step ${i - 1} in the chain table`
		);
	// No new CLI door: cli.ts still maps provision to provision-fleet.mjs.
	const cli = read('src', 'cli.ts');
	assert.match(cli, /provision: \{\s*script: 'provision-fleet\.mjs'/);
	assert.equal(
		(cli.match(/script: 'provision-fleet\.mjs'/g) ?? []).length,
		1,
		'provision-fleet.mjs must stay the single runner behind one subcommand'
	);
});

test('the chain fixes what bootcamp reports and RE-RUNS bootcamp (the 3-6 loop)', () => {
	// The manual record: bootcamp FAILED on python-toolcache and playwright;
	// the operator read the failure, typed two seeds, bootcamp PASSED. The
	// chain must PROBE first, seed from the earned set, and let a second
	// bootcamp judge — never seed blindly, never stop at a failure whose
	// remedy it knows.
	const src = read('scripts', 'lib', 'provision-phases.mjs');
	// The ORDER is asserted INSIDE bootcampPhase's own body — the file's header
	// and docstrings mention the same words, and topology is a property of the
	// executing function, not of the prose around it.
	const phase = src.slice(
		src.indexOf('function bootcampPhase'),
		src.indexOf('function benchmarkPhase')
	);
	const probeAt = phase.indexOf('bootcampProbeArgs(');
	// EVERY bootcamp run in the phase goes through bootcampProbeArgs, which adds
	// --check-only unless --confirm: a dry run must not install (2026-10-25: the
	// probe AND the judge both ran bootcamp's installing default).
	const runs = phase.split("'bootcamp.mjs')").length - 1;
	assert.ok(runs >= 2, `expected the probe and the judge, found ${runs} bootcamp run(s)`);
	assert.equal(
		phase.split('bootcampProbeArgs(').length - 1,
		runs,
		'a bootcamp run bypasses bootcampProbeArgs'
	);
	const seedAt = phase.indexOf('r.argsFor(node)');
	const judgeAt = phase.indexOf('judgeReport.earned');
	assert.ok(
		probeAt >= 0 && seedAt > probeAt && judgeAt > seedAt,
		'probe → seed → judge, in that order inside the phase'
	);
	// The judge re-runs bootcamp and demands the seeded capabilities be EARNED.
	assert.match(
		src,
		/plan\.filter\(\(r\) => !\(judgeReport\.earned/,
		'the post-seed run must verify EARNING, not exit codes'
	);
	// And `$capabilities` is written only by a PASSING run — the record step
	// and the seed step are different bootcamp invocations.
	assert.match(src, /\.\.\.\(confirm \? \['--write'\] : \[\]\)/);
});

test('seed-cache remains wired to its own safety rules (unchanged by the chain)', () => {
	const src = read('scripts', 'seed-node-cache.mjs');
	// The source must pass the probe — seeding from a broken node propagates
	// the breakage.
	assert.match(src, /probes\[n\]\[spec\.probe\] === true/);
	// The target must be re-probed after the copy, never trusted from rsync.
	assert.match(src, /const after = await probeOf\(node\)/);
	// Unreachable is a finding, never an empty capability set.
	assert.match(src, /return Object\.keys\(caps\)\.length \? caps : null/);
	// The writability check precedes the copy — claw-7's 5.5GB "Permission
	// denied" taught this, and the chain calling the script does not retire it.
	// F5: the copy itself now goes through fleet-exec.mjs's `runRsync` rather
	// than a literal `execFileSync('rsync', ...)` call, so the invariant is
	// pinned on the new call shape instead.
	assert.ok(src.indexOf('[ -w "$d" ]') < src.indexOf('runRsync('));
	// The RICHEST source, not the first that passes: claw-8 was seeded with
	// 631MB of a 5.2GB cache by exactly that shortcut.
	assert.match(src, /du -sk/);
	assert.match(src, /sized\.sort\(\(a, b\) => b\.kb - a\.kb\)/);
	assert.ok(!/const source = all\.find\(/.test(src));
});

test('payload BEFORE ephemeral — the flip demands BOTH halves', async () => {
	// claw-8's gate caught the flag without the provisioner ("every mint would
	// fail"); its PROBE can pass without the payload (a standing install
	// satisfies jitconfig). The chain therefore requires the earned flag AND
	// the binary, and the payload check runs over the node, not the manifest.
	const src = read('scripts/provision-fleet.mjs') + read('scripts/lib/provision-plan.mjs');
	assert.match(src, /PAYLOAD_PROBE/, 'the chain probes the payload binary itself');
	assert.match(src, /jit\/payload\/bin\/Runner\.Listener/);
	assert.match(src, /flipDecision\(\{ entry, earned, payloadPresent \}\)/);
	// enroll NEVER proposes ephemeral, and neither does the backfill:
	// provision is the flag's only writer on this path.
	const enrollSrc = read('scripts', 'enroll-node.mjs');
	assert.match(enrollSrc, /ephemeral is DELIBERATELY ABSENT/);
	const { placementBackfill } = await import('./enrollment-record.mjs');
	assert.equal(
		'ephemeral' in placementBackfill({}),
		false,
		'the backfill never reaches for ephemeral'
	);
});

test('realize-the-slice is a step of the chain, between slice and benchmark', () => {
	// The manual record's step 11: `fleet slice --confirm`, then
	// `systemctl --user start runners.slice` BY HAND — "io never reached a
	// slice that had never been realized". The start is idempotent (an active
	// slice is a no-op), which is what makes it safe to run on a re-run.
	const src = read('scripts/provision-fleet.mjs') + read('scripts/lib/provision-plan.mjs');
	const sliceAt = src.indexOf("id: 'slice'");
	const realizeAt = src.indexOf("id: 'realize'");
	const benchAt = src.indexOf("id: 'benchmark'");
	assert.ok(sliceAt < realizeAt && realizeAt < benchAt, 'realize sits between slice and benchmark');
	assert.match(src, /systemctl --user start runners\.slice/);
	// The DRY run does not start anything — it checks.
	assert.match(src, /REALIZE_CHECK/);
	assert.match(src, /is-active --quiet/);
	// And silence is not success: the marker must come back.
	assert.match(src, /neither marker/);
});

test('benchmark runs on the ci:fleet-benchmark window, so the first night is not a page', () => {
	// claw-8/claw-9 both paged @here at 12:00 UTC on 2026-09-21 because no
	// benchmark record existed. The chain measures with --due so an
	// idempotent re-run on a measured node changes nothing, and the window is
	// the cron's own so the two cannot disagree.
	const src = read('scripts/lib/provision-plan.mjs') + read('scripts/lib/provision-phases.mjs');
	assert.match(src, /'--due',\s*\n?\s*String\(BENCHMARK_DUE_DAYS\)/);
	assert.match(src, /export const BENCHMARK_DUE_DAYS = 30/);
	// IT ASKS BEFORE IT MEASURES, and asks the cron's own question. Until
	// 2026-09-23 the step ran `benchmark <node> --due 30 --write` and assumed
	// `--due` gated it; it does not — a node named POSITIONALLY is measured
	// unconditionally, so an idempotent re-run loaded claw-9 while `--due 30
	// --report --json` said `due: []`, and the unprivileged re-measure then
	// failed the chain against the stored rooted record.
	assert.match(src, /benchmarkStep\(safeJson\(rep\.text\), node\)/, 'the step consults the report');
	const phase = src.slice(
		src.indexOf('function benchmarkPhase'),
		src.indexOf('function healthPhase')
	);
	assert.ok(
		phase.indexOf("'--report'") < phase.indexOf('benchmarkStep('),
		'the report is read BEFORE the decision'
	);
	assert.ok(
		phase.indexOf('benchmarkStep(') < phase.indexOf("'--write'"),
		'nothing is measured before the decision'
	);
});

test('the chain ends on doctor, gated on the STORED record', () => {
	// Enroll's own advice used to name `fleet doctor --machine <node> --write`
	// in a list nobody ran (the manual record's step 15: "nobody ran it").
	// Now the chain runs it — but only when the record is missing, stale or
	// silent: a fresh blocking-free record means the re-run changes nothing.
	const src = read('scripts', 'lib', 'provision-phases.mjs');
	assert.match(src, /lib', 'doctor-run\.mjs'[\s\S]{0,80}'--machine'[\s\S]{0,20}'--write'/);
	assert.match(
		src,
		/measuredFacets\('health'/,
		'the gate reads the state dir through the one reader'
	);
	assert.match(src, /healthStep\(stored/, 'the verdict is the exported decision, not inline prose');
});

test('every manifest write is preceded by a FAST-FORWARD onto origin/main', () => {
	// The manual record's step 1 failed on exactly this: "enroll refused to
	// push: checkout behind origin". The chain brings the checkout level
	// FIRST — and fast-forward only, which cannot lose local work.
	const src = read('scripts/provision-fleet.mjs') + read('scripts/lib/provision-phases.mjs');
	assert.match(src, /\['merge', '--ff-only', 'FETCH_HEAD'\]/);
	// Both in-chain write phases call it before writing.
	const ffCalls = src.match(/fastForwardManifest\(MANIFEST\)/g) ?? [];
	assert.ok(ffCalls.length >= 2, 'declare and placement both fast-forward first');
});

test('the WHOLE-FLEET path keeps its own shape — the chain did not eat it', () => {
	// `fleet provision --confirm` with no --machine stays the fleet-wide
	// converge: register → throttle → slice → seed-python → seed-cache. Seeds
	// stay LAST there (repair after deploys, gigabytes from a healthy peer);
	// on the ONBOARDING path they run EARLIER because the payload must exist
	// before `ephemeral` and `ephemeral` before throttle's provisioner.
	const src = read('scripts/lib/provision-plan.mjs') + read('scripts/provision-fleet.mjs');
	const fleet = src.slice(src.indexOf('FLEET_APPLY'), src.indexOf('const VERIFY'));
	for (const step of [
		'reconcile-fleet-runners.mjs',
		'deploy-ci-throttle.mjs',
		'deploy-runners-slice.mjs',
		'seed-runner-python.mjs',
		'seed-node-cache.mjs',
	])
		assert.ok(fleet.includes(step), `the fleet-wide path still runs ${step}`);
	const idx = (s) => fleet.indexOf(s);
	assert.ok(
		idx('deploy-runners-slice.mjs') < idx('seed-node-cache.mjs'),
		'fleet-wide: seeding still belongs after the deploys'
	);
	assert.ok(
		src.indexOf("id: 'bootcamp'") < src.indexOf("id: 'throttle'"),
		'onboarding: seeding (inside bootcamp) precedes the deploys'
	);
	// The old no-nodes refusal survives for the fleet-wide path.
	assert.match(src, /no nodes declared/);
});

test('enroll declares DERIVED placement — the four hand edits have no author left', () => {
	// claw-9 needed hand edits for labels/role/maxRegistrations/slice/minFreeGb
	// (#50, #52); every one is now derived at declaration. The owed-list that
	// once omitted minFreeGb is GONE, and the next-step line is the chain.
	const src = read('scripts', 'enroll-node.mjs');
	assert.match(src, /import \{[\s\S]*?derivedPlacement,/);
	assert.match(src, /\.\.\.derivedPlacement\(\),/);
	assert.ok(!/a human still owes\s*:\s*\$\{owed/.test(src), 'the owed-list is gone');
	assert.match(src, /fleet provision --machine \$\{name\} --confirm/, 'the next step is the chain');
	// minFreeGb specifically: its absence is what reddened the site repo's main.
	assert.match(read('scripts', 'lib', 'enrollment-record.mjs'), /FLEET_MIN_FREE_GB = 25/);
});

test('the ssh config writer never rewrites what the operator wrote', () => {
	const src = read('scripts', 'enroll-node.mjs');
	assert.match(src, /state: 'already'/, 'an existing entry must win');
	assert.match(src, /# >>> fleet enroll: \$\{node\} >>>/, 'the block must be delimited and named');
	assert.match(src, /copyFileSync\(cfg, `\$\{cfg\}\.bak-fleet-enroll`\)/, 'back it up first');
	// APPEND only. Rewriting the fleet's existing `Host claw1 claw-2 ...` line
	// to add a name would edit a line the operator wrote, in the one file that
	// locks you out of the fleet when it is wrong.
	assert.match(src, /writeFileSync\(cfg, existing \+ block/, 'append, never rewrite');
});

/**
 * `fleet onboard` writes the netinst partition's preseed cpio (#81).
 *
 * `scripts/onboarding.sh` renders a preseed (step 9/9) but, before this,
 * never wrote `install/preseed-initrd.cpio.gz` — the second `initrd` the F6
 * netinst-partition menu entry loads (wave 3u lane D, `0aa61c0`;
 * `render_netinst_grub_cfg` in `lib/make-preseed.sh`). `verify-stick.sh`
 * catches the gap on-device; this proves the fix without one.
 *
 * Unlike every test above, this one does not read source as data — it RUNS
 * shipped shell, the same move `make-preseed.test.mjs`'s target-guard and
 * netinst suites make: the block onboarding.sh actually executes is sliced
 * out between its own `: ONBOARD-NETINST-CPIO-BEGIN`/`-END` sentinels (inert
 * `:` no-ops at runtime, so they cost nothing in production) and run against
 * a PLAIN DIRECTORY standing in for a mounted CLAWKIT — never a block
 * device, file-backed or real, and never the CLAWKIT stick itself. The
 * directory is reached through `FLEET_ONBOARD_CLAWKIT_MNT`, the same
 * override shape `lib/make-preseed.sh`'s early_command already uses for
 * `FLEET_TG_TARGET`/`FLEET_TG_MOUNTS`.
 */
const ONBOARD_SRC = read('scripts', 'onboarding.sh');
const MAKE_PRESEED_LIB = resolve(ROOT, 'scripts', 'lib', 'make-preseed.sh');

/** The exact span onboarding.sh ships between its ONBOARD-NETINST-CPIO sentinels. */
function netinstCpioBlock() {
	const start = ONBOARD_SRC.indexOf(': ONBOARD-NETINST-CPIO-BEGIN');
	const end = ONBOARD_SRC.indexOf(': ONBOARD-NETINST-CPIO-END', start);
	assert.ok(
		start > -1 && end > -1,
		'onboarding.sh carries no ONBOARD-NETINST-CPIO-BEGIN/END sentinels — #81 is unfixed, or the block was renamed out from under this test'
	);
	return ONBOARD_SRC.slice(start, end);
}

/** A preseed file, rendered the same way `fleet onboard` renders one. */
function renderedPreseed() {
	const dir = tempDir('onboard-cpio-preseed-');
	const key = join(dir, 'k.pub');
	writeFileSync(key, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAfleetonboardtest fleet@test\n');
	const out = execFileSync(
		'bash',
		['-c', `. "${MAKE_PRESEED_LIB}"; render_preseed hadoku '$6$x$y' '' '' '${key}' 'Etc/UTC'`],
		{ encoding: 'utf8' }
	);
	const file = join(dir, 'preseed.cfg');
	writeFileSync(file, out);
	return file;
}

/**
 * Run the SLICED block, exactly as onboarding.sh ships it, against `kitMnt`
 * (a plain directory) and `renderedFile` (the preseed onboarding.sh already
 * rendered for Ventoy's copy, per `RENDERED` in the shipped script). `die`,
 * `ok` and `warn` are onboarding.sh's own helpers, defined earlier in that
 * file and out of scope for a bare slice — stood in for here exactly the way
 * `make-preseed.test.mjs`'s target-guard harness stands in for `logger`.
 */
function runNetinstCpioBlock(kitMnt, renderedFile) {
	const script = [
		'die() { printf "DIE: %s\\n" "$*" >&2; exit 7; }',
		'ok() { printf "OK: %s\\n" "$*"; }',
		'warn() { printf "WARN: %s\\n" "$*" >&2; }',
		`. "${MAKE_PRESEED_LIB}"`,
		netinstCpioBlock(),
	].join('\n');
	return execFileSync('bash', ['-c', script], {
		encoding: 'utf8',
		env: { ...process.env, FLEET_ONBOARD_CLAWKIT_MNT: kitMnt, RENDERED: renderedFile },
	});
}

test('onboard writes the netinst partition cpio through the SAME writer refresh-preseed.sh uses, never a second implementation', () => {
	// The shared function, called by name — not a second cpio/gzip pipeline
	// built inline, which would be the "two build paths disagree" bug again.
	assert.match(
		netinstCpioBlock(),
		/preseed_build_initrd_cpio "\$RENDERED"/,
		"onboarding.sh must call lib/make-preseed.sh's preseed_build_initrd_cpio, the exact function refresh-preseed.sh calls"
	);
	assert.ok(
		!/cpio -o -H newc/.test(netinstCpioBlock()),
		'a second, inlined cpio/gzip pipeline has reappeared in onboarding.sh instead of reusing the shared writer'
	);
});

test('a stick that HAS the netinst partition gets install/preseed-initrd.cpio.gz, byte-identical to what was rendered', () => {
	const kit = tempDir('onboard-cpio-has-netinst-');
	mkdirSync(join(kit, 'install'), { recursive: true });
	// Only NETINST.meta's PRESENCE matters to this block — its content is the
	// writer's own record and is not re-derived here (make-preseed.sh's own
	// netinst_meta_* round-trip is covered in make-preseed.test.mjs).
	writeFileSync(join(kit, 'install', 'NETINST.meta'), 'name=debian-13.6.0-amd64-netinst.iso\n');
	const preseed = renderedPreseed();
	const preseedContent = readFileSync(preseed, 'utf8');

	runNetinstCpioBlock(kit, preseed);

	const cpio = join(kit, 'install', 'preseed-initrd.cpio.gz');
	assert.ok(
		existsSync(cpio),
		'install/preseed-initrd.cpio.gz was not written on a stick that carries the netinst partition — the F6 menu entry has nothing to boot into'
	);
	const embedded = execFileSync(
		'bash',
		['-c', `. "${MAKE_PRESEED_LIB}"; preseed_initrd_cpio_read '${cpio}'`],
		{ encoding: 'utf8' }
	);
	assert.equal(
		embedded,
		preseedContent,
		'the embedded preseed must be byte-identical to the one fleet onboard rendered for Ventoy — one render, one writer, two destinations'
	);
});

test('a stick WITHOUT the netinst partition is untouched — behaves exactly as every stick fleet onboard builds today', () => {
	// Deliberately no install/ directory at all: `fleet onboard`'s own call to
	// node-usb-prep.sh never passes --netinst-iso, so this is the shape of
	// every stick it builds right now, and this block must be a no-op for it.
	const kit = tempDir('onboard-cpio-no-netinst-');
	const preseed = renderedPreseed();

	const out = runNetinstCpioBlock(kit, preseed);

	assert.ok(
		!existsSync(join(kit, 'install')),
		'a plain stick (no NETINST.meta) must get no install/ directory at all — the netinst-only artifact leaked onto a stick that never asked for one'
	);
	assert.doesNotMatch(
		out,
		/OK: netinst partition preseed cpio written/,
		'nothing should report writing a cpio on the plain path'
	);
});

test('the netinst cpio block only ever consults NETINST_META_REL / NETINST_CPIO_REL from lib/make-preseed.sh, never a second literal path', () => {
	// The two constants this whole mechanism is keyed on live in exactly one
	// place (lib/make-preseed.sh) — a literal "install/preseed-initrd.cpio.gz"
	// re-typed here would drift from a future rename there silently.
	const block = netinstCpioBlock();
	assert.match(block, /\$NETINST_META_REL/);
	assert.match(block, /\$NETINST_CPIO_REL/);
	assert.ok(
		!/install\/preseed-initrd\.cpio\.gz/.test(block),
		'the cpio path must come from $NETINST_CPIO_REL, not a re-typed literal'
	);
	assert.ok(
		!/install\/NETINST\.meta/.test(block),
		'the meta path must come from $NETINST_META_REL, not a re-typed literal'
	);
});

/**
 * `clawkit_part_on_dev` must resolve CLAWKIT scoped to the device onboarding
 * just built, never off a whole-system label lookup.
 *
 * With two sticks plugged in — the fleet's real installer (which already
 * carries a netinst partition) beside the one this run just finished
 * building — a global `blkid -L CLAWKIT` can resolve to EITHER one, and
 * resolving to the wrong one means writing this run's preseed cpio onto a
 * stick nobody asked to touch, which is exactly what "never touch the real
 * CLAWKIT stick" forbids. `lsblk <dev>` cannot cross onto a different
 * device no matter how many CLAWKIT-labelled sticks are attached, so that
 * is the only lookup the shipped function is allowed to make.
 *
 * NO BLOCK DEVICE, FIXTURE OR REAL, IS EVER TOUCHED HERE. `lsblk` and
 * `blkid` are both shimmed via PATH to print canned, lsblk/blkid-SHAPED text
 * — never read from the host's actual /dev — the same move this suite's
 * other harnesses make for `logger`/`mount`/`umount`.
 */
function clawkitPartOnDevBody() {
	const start = ONBOARD_SRC.indexOf(': CLAWKIT-PART-ON-DEV-BEGIN');
	const end = ONBOARD_SRC.indexOf(': CLAWKIT-PART-ON-DEV-END', start);
	assert.ok(
		start > -1 && end > -1,
		'onboarding.sh carries no CLAWKIT-PART-ON-DEV-BEGIN/END sentinels — the scoped resolver was renamed or removed out from under this test'
	);
	return ONBOARD_SRC.slice(start, end);
}

/**
 * Run `clawkit_part_on_dev dev` with `lsblk` and `blkid` both shimmed on
 * PATH.
 *
 * `lsblkRows`: the exact lines a real `lsblk -lnpo NAME,LABEL "$dev"` would
 * print for THAT device — i.e. only ever the rows a correct, dev-scoped
 * call is entitled to see. `blkidTarget`: what a GLOBAL `blkid -L CLAWKIT`
 * would answer on this machine (typically a DIFFERENT device's CLAWKIT
 * partition) — present only so a regression back to that whole-system
 * lookup has something wrong to find; the real `clawkit_part_on_dev` never
 * calls `blkid` at all, and the "crosses onto a different stick" test below
 * is exactly what catches it if it ever does again.
 */
function runClawkitPartOnDev(dev, { lsblkRows = [], blkidTarget = '' } = {}) {
	const sandbox = tempDir('clawkit-part-on-dev-');
	const bin = join(sandbox, 'bin');
	mkdirSync(bin, { recursive: true });

	writeFileSync(
		join(bin, 'lsblk'),
		'#!/bin/sh\n' + `printf '%s\\n' ${lsblkRows.map((r) => `'${r}'`).join(' ')}\n`
	);
	chmodSync(join(bin, 'lsblk'), 0o755);

	writeFileSync(join(bin, 'blkid'), `#!/bin/sh\nprintf '%s\\n' '${blkidTarget}'\n`);
	chmodSync(join(bin, 'blkid'), 0o755);

	return execFileSync('bash', ['-c', `${clawkitPartOnDevBody()}\nclawkit_part_on_dev '${dev}'`], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
	}).trim();
}

test('CLAWKIT-PART-ON-DEV sentinels are present — the slice this suite runs is the shipped resolver', () => {
	assert.match(clawkitPartOnDevBody(), /clawkit_part_on_dev\(\)/);
});

test('clawkit_part_on_dev finds CLAWKIT scoped to the device it was asked about', () => {
	const out = runClawkitPartOnDev('/dev/sdx', {
		lsblkRows: ['/dev/sdx Ventoy', '/dev/sdx2 VTOYEFI', '/dev/sdx3 CLAWKIT'],
	});
	assert.equal(out, '/dev/sdx3');
});

test('clawkit_part_on_dev returns nothing when the device carries no CLAWKIT at all', () => {
	const out = runClawkitPartOnDev('/dev/sdx', {
		lsblkRows: ['/dev/sdx Ventoy', '/dev/sdx2 VTOYEFI'],
	});
	assert.equal(out, '');
});

test("clawkit_part_on_dev NEVER crosses onto a different stick's CLAWKIT, even when a global lookup would find one", () => {
	// The exact scenario the manager's correctness fix is for: two sticks
	// plugged in. /dev/sdx (the one onboarding just built) carries no
	// CLAWKIT of its own — lsblk, correctly scoped to sdx, says so. A global
	// `blkid -L CLAWKIT` would instead answer with the OTHER stick's
	// partition, /dev/sdy1 — the fleet's real installer, sitting in another
	// USB port. The shipped resolver must never reach for that answer.
	const out = runClawkitPartOnDev('/dev/sdx', {
		lsblkRows: ['/dev/sdx Ventoy', '/dev/sdx2 VTOYEFI'],
		blkidTarget: '/dev/sdy1',
	});
	assert.equal(out, '', 'resolution must be empty, not fall through to a global label lookup');
	assert.notEqual(out, '/dev/sdy1', "must never return the OTHER stick's CLAWKIT partition");
});

test('the resolver is built on lsblk scoped to $DEV — never a global blkid -L CLAWKIT', () => {
	assert.match(clawkitPartOnDevBody(), /lsblk -lnpo NAME,LABEL "\$dev"/);
	assert.ok(
		!/blkid -L CLAWKIT/.test(clawkitPartOnDevBody()),
		'the scoped resolver must not fall back to a whole-system label lookup'
	);
	assert.ok(
		!/blkid -L CLAWKIT/.test(netinstCpioBlock()),
		'the netinst-cpio block itself must resolve KIT_PART through clawkit_part_on_dev "$DEV", never a bare blkid -L CLAWKIT'
	);
	assert.match(netinstCpioBlock(), /clawkit_part_on_dev "\$DEV"/);
});
