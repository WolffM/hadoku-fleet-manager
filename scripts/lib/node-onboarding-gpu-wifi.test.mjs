/**
 * The three things WS-N added to CONVERT, guarded where they can actually fail.
 *
 * All three are properties of ORDER or of DATA, not of behaviour that a fixture
 * can execute: node-bootstrap.sh's GPU and wireless sections need a PCI bus, a
 * radio and root, none of which a test runner has. So what is asserted here is
 * the half that is checkable and that has already been wrong once each:
 *
 *   1. A THIRD-PARTY APT SOURCE IS WIRED BEFORE THE PACKAGES THAT NEED IT.
 *      `toolchain.thirdPartySources` was declared in node-profiles.json on
 *      2026-09-07 and read by nothing until 2026-09-08 — section 5 ran
 *      `apt-get install $(toolchain.packages)` against whatever repos the
 *      installer left behind. This is a pure ordering property and ordering is
 *      exactly what a re-edit silently breaks.
 *
 *   2. `$`-PREFIXED KEYS ARE PROSE, NOT DATA. Every manifest here carries
 *      `$why`/`$comment` beside its real keys. The first version of the
 *      thirdPartySources loop walked `keys[]` and read `$why` as a source name,
 *      then died with "thirdPartySources.$why is missing aptKeyUrl". That was
 *      found by dry-running the script in a container, which is not something
 *      CI does — so it is pinned here instead.
 *
 *   3. THE WIRELESS BLOCK DOES NOT LEAK INTO THE LAPTOP PROFILE. node-bootstrap
 *      CONVERTS a node's network manager when it sees `network.wireless`, and
 *      the laptop profile describes claw-1/2/3 as they ALREADY ARE. Declaring it
 *      there would turn the next re-run on any of those boxes into an unrequested
 *      ifupdown-to-NetworkManager migration on a working node. A profile
 *      describes a target; it must not smuggle in a migration.
 *
 * COMMENTS ARE BLANKED FIRST for every grep, because this repo has read a
 * COMMENT as evidence three separate times and node-bootstrap.sh discusses both
 * of these sections at length in prose that would satisfy a naive match.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Blank WHOLE-LINE shell comments, and only those.
 *
 * NOT `blankComments` from ./blank-comments.mjs — that one parses JAVASCRIPT,
 * and jq's alternative operator is spelled `//`. Running it over this file turns
 * `jq -r '.toolchain.thirdPartySources // {} | keys[]?'` into a comment and
 * deletes the very line under test, along with the pre-existing
 * `parr .toolchain.packages`. Both assertions below then failed against code
 * that was perfectly correct.
 *
 * A line whose first non-space character is `#` is unambiguously a comment in
 * bash — no quoting context can change that — so this is safe in a way that
 * blanking a TRAILING `#` is not, and it is sufficient here because every piece
 * of prose that could satisfy one of these greps is a full-line comment.
 * node-bootstrap.sh discusses `toolchain.thirdPartySources` at length directly
 * above the code that reads it, so without this the ordering test could be
 * satisfied by the paragraph explaining the ordering rather than by the ordering.
 */
const blankShellComments = (src) =>
	src
		.split('\n')
		.map((line) => (/^\s*#/.test(line) ? '' : line))
		.join('\n');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOTSTRAP = resolve(ROOT, 'scripts', 'node-bootstrap.sh');
const PROFILES = resolve(ROOT, 'manifests', 'node-profiles.json');

const code = blankShellComments(readFileSync(BOOTSTRAP, 'utf8'));
const profiles = JSON.parse(readFileSync(PROFILES, 'utf8')).profiles;

/** Real keys only — `$why` and friends are prose. */
const dataKeys = (o) => Object.keys(o ?? {}).filter((k) => !k.startsWith('$'));

test('the third-party apt sources are wired BEFORE toolchain.packages is installed', () => {
	const wire = code.indexOf('.toolchain.thirdPartySources');
	const install = code.indexOf('.toolchain.packages');
	assert.ok(wire > 0, 'node-bootstrap.sh must read .toolchain.thirdPartySources at all');
	assert.ok(install > 0, 'node-bootstrap.sh must install .toolchain.packages');
	assert.ok(
		wire < install,
		'the third-party source must be added before the package install that depends on it — ' +
			'otherwise a package that only exists in that repo resolves from the base archive ' +
			'(silently older) or not at all'
	);
});

test('the thirdPartySources loop skips $-prefixed prose keys', () => {
	// The literal jq filter, because this is the whole defect: `keys[]?` alone
	// read `$why` as a source and refused to bootstrap the box.
	const line = code
		.split('\n')
		.find((l) => l.includes('.toolchain.thirdPartySources') && l.includes('keys[]'));
	assert.ok(line, 'no line walks the keys of .toolchain.thirdPartySources');
	assert.ok(
		line.includes('startswith("$")'),
		'the key walk must filter `$`-prefixed keys, or `$why` is read as a source name ' +
			`— got: ${line.trim()}`
	);
});

test('every declared third-party source carries all three fields it is read for', () => {
	let checked = 0;
	for (const [id, p] of Object.entries(profiles)) {
		const sources = p.toolchain?.thirdPartySources ?? {};
		for (const name of dataKeys(sources)) {
			const s = sources[name];
			for (const field of ['aptKeyUrl', 'aptKeyPath', 'aptList']) {
				assert.ok(
					typeof s[field] === 'string' && s[field].length > 0,
					`${id}.toolchain.thirdPartySources.${name} is missing ${field}; ` +
						'node-bootstrap.sh dies on a partial source rather than installing the ' +
						'base-archive version behind your back'
				);
			}
			// A source signed by a key apt cannot find is a source apt refuses.
			assert.ok(
				s.aptList.includes(s.aptKeyPath),
				`${id}.toolchain.thirdPartySources.${name}: aptList must reference aptKeyPath ` +
					'via signed-by, or apt rejects the repo it was just handed'
			);
			checked++;
		}
	}
	assert.ok(checked > 0, 'no third-party source was checked — this test would pass vacuously');
});

test('a package that needs a third-party source is actually in the package list', () => {
	// The failure this pair exists to prevent is a source added for a package
	// nobody installs, or a package installed from a repo nobody added. `gh` is
	// the live case: it IS in trixie/main, so the source is a currency fix and
	// the package must be present for either half to matter.
	const desktop = profiles['desktop-debian-trixie'];
	assert.ok(
		dataKeys(desktop.toolchain.thirdPartySources).includes('github-cli'),
		'the desktop profile must declare the github-cli source'
	);
	assert.ok(
		desktop.toolchain.packages.includes('gh'),
		'`gh` must be in toolchain.packages, or the github-cli source is added for nothing'
	);
});

test('the wireless policy is declared ONLY where a conversion is intended', () => {
	assert.ok(
		profiles['desktop-debian-trixie'].network.wireless,
		'the desktop profile is what images claw-7, which must survive its cable being pulled'
	);
	assert.equal(
		profiles['laptop-debian-trixie'].network.wireless,
		undefined,
		'laptop-debian-trixie describes claw-1/2/3 as they already are. node-bootstrap CONVERTS ' +
			'the network manager when it sees this block, so declaring it here makes the next ' +
			're-run migrate three working nodes off ifupdown unasked.'
	);
});

test('the wireless policy declares two bands, each with its own credential env vars', () => {
	const w = profiles['desktop-debian-trixie'].network.wireless;
	assert.equal(w.manager, 'networkmanager');
	assert.equal(
		w.networks.length,
		2,
		'the 2026-09-07 outage was an SSID RENAME: a node holding one SSID is one gateway ' +
			'rename from stranded, which cost a garage trip'
	);
	const envs = new Set();
	for (const n of w.networks) {
		for (const key of ['ssidEnv', 'pskEnv']) {
			assert.match(
				n[key],
				/^FLEET_[A-Z0-9_]+$/,
				`networks[${n.id}].${key} must name an environment variable — the SSID and PSK ` +
					'are site properties and manifests/ is PUBLISHED'
			);
			envs.add(n[key]);
		}
	}
	assert.equal(
		envs.size,
		4,
		'each band needs its own SSID and PSK variable, or one shadows the other'
	);
	// Higher wins for autoconnect-priority, so the fast band must outrank the slow
	// one. 2.4 GHz measured 33-38 Mbit/s against 5 GHz's 146-218 on this LAN.
	const five = w.networks.find((n) => n.band === '5');
	const twoFour = w.networks.find((n) => n.band === '2.4');
	assert.ok(five && twoFour, 'both a 5 GHz and a 2.4 GHz network must be declared');
	assert.ok(
		five.priority > twoFour.priority,
		'5 GHz must outrank 2.4 GHz: autoconnect-priority is higher-wins, and 2.4 GHz is a ' +
			'fallback rather than a balancing lever'
	);
});

test('wired beats wireless on route metric, which is lower-wins and thus the inverse', () => {
	const w = profiles['desktop-debian-trixie'].network.wireless;
	assert.equal(w.preferWired, true);
	assert.ok(
		w.wiredRouteMetric < w.wirelessRouteMetric,
		'route metric is LOWER-wins (the inverse of autoconnect-priority). Getting this ' +
			'backwards sends every byte over a 105 Mbit/s radio while a gigabit cable sits idle.'
	);
});

test('the GPU block is keyed by PCI vendor id, not by card model', () => {
	const gpu = profiles['desktop-debian-trixie'].gpu;
	const vendors = dataKeys(gpu.vendors);
	assert.ok(vendors.length > 0, 'no GPU vendor declared — this test would pass vacuously');
	for (const v of vendors) {
		assert.match(
			v,
			/^0x[0-9a-f]{4}$/,
			`gpu.vendors key ${v} must be a PCI vendor id as sysfs spells it (lowercase 0xNNNN) — ` +
				'node-bootstrap reads /sys/bus/pci/devices/*/vendor and matches on it directly, so a ' +
				'model name or a prettified id silently matches nothing and installs no driver'
		);
		const spec = gpu.vendors[v];
		assert.ok(spec.packages?.length, `gpu.vendors.${v} declares no packages`);
		assert.ok(spec.probeCapabilities?.length, `gpu.vendors.${v} declares nothing to probe`);
	}
});

test('every capability the GPU block asks to probe is one the probe script emits', () => {
	// The pair that must not drift: declaring a probe target the prober cannot
	// answer would report a card as incapable of something nothing ever tried.
	const probe = readFileSync(resolve(ROOT, 'scripts', 'capability-probe.sh'), 'utf8');
	const emitted = new Set([...probe.matchAll(/^\s*say\s+([A-Za-z0-9_-]+)\s/gm)].map((m) => m[1]));
	assert.ok(emitted.size > 0, 'parsed no capabilities out of the probe script');
	const gpu = profiles['desktop-debian-trixie'].gpu;
	for (const v of dataKeys(gpu.vendors)) {
		for (const cap of gpu.vendors[v].probeCapabilities) {
			assert.ok(
				emitted.has(cap),
				`gpu.vendors.${v} asks to probe '${cap}', which capability-probe.sh never emits ` +
					'as a literal `say` line'
			);
		}
	}
});

test('the enrollment record carries the wireless MAC, which is the field an operator must act on', () => {
	// hokon reaches every claw by a hardcoded LAN IP in ~/.ssh/config. A node that
	// draws a new DHCP lease when its cable is pulled goes dark to every gate, and
	// the reservation is made against this address — so it has to be IN the record
	// rather than dug out of the box afterwards.
	for (const field of ['wirelessMac', 'wirelessIf', 'gpuPci', 'gpuDriver']) {
		assert.ok(code.includes(`ENROLL ${field} `), `the enrollment record must emit ${field}`);
	}
});

test('a declared wireless fallback that did not converge makes the node UNREADY', () => {
	// The value of the fallback is that somebody ACTS on it: the cable comes out
	// because the box is believed to survive it. Reporting `converged` on a node
	// whose radio never came up hands over that belief with nothing behind it.
	assert.match(
		code,
		/case "\$\{WIFI_STATE:-\}" in[\s\S]{0,400}unready/,
		'WIFI_STATE must be able to make the node unready'
	);
	// And the two `none ...` states must NOT: no policy, and no radio, are both
	// statements about the box. A wired-only node is a perfectly good node.
	assert.ok(
		/no\\ \*\)/.test(code),
		'only the `no ...` states may fail readiness — `none ...` must pass'
	);
});

/**
 * site.env — THE REASON THE CONSOLE COMMAND IS `sudo sh convert.sh` AND NOTHING
 * ELSE.
 *
 * The first version of this work made the operator type FLEET_LAN_CIDR,
 * FLEET_WIFI_SSID and FLEET_WIFI_PSK at the console, per box. That is the
 * `--surface` flag mistake node-profiles.json exists to end — a site fact living
 * in a shell history, retyped at the most expensive keyboard in the system — and
 * it is silently lossy besides, because `VAR=... sudo sh convert.sh` drops the
 * variable and still runs.
 *
 * So the control host resolves them once and the stick carries the answer.
 * These assert the contract between the two halves, because they live in
 * different scripts and nothing else connects them.
 */
const usbPrep = blankShellComments(
	readFileSync(resolve(ROOT, 'scripts', 'node-usb-prep.sh'), 'utf8')
);
const convert = blankShellComments(readFileSync(resolve(ROOT, 'scripts', 'convert.sh'), 'utf8'));

test('usb-prep writes site.env, and convert.sh reads it', () => {
	assert.match(usbPrep, /site\.env/, 'node-usb-prep.sh must write bootstrap/site.env');
	assert.match(
		usbPrep,
		/^write_site_env$/m,
		'and must actually CALL it — defining it is not enough'
	);
	assert.match(convert, /site\.env/, 'convert.sh must read it');
});

test('site.env is mode 600 — it carries the wifi PSK', () => {
	assert.match(
		usbPrep,
		/chmod 600 "\$dest"/,
		'the file holds a live PSK; the stick is unencrypted and this is the one ' +
			'protection available on it'
	);
});

test('the environment WINS over site.env', () => {
	// An operator overriding one value for one box must not have to rebuild a
	// stick, and a plain `. site.env` would silently overwrite the override.
	assert.match(
		convert,
		/_lan=\$\{FLEET_LAN_CIDR:-\}/,
		'convert.sh must capture the pre-set environment before sourcing'
	);
	assert.match(
		convert,
		/\[ -n "\$_lan" \] && FLEET_LAN_CIDR=\$_lan/,
		'and restore it afterwards, or the file beats the operator'
	);
});

test('the PSK is never echoed at the console', () => {
	// The banner reports whether a credential ARRIVED, never what it is. A
	// console is photographed, and these transcripts get pasted into handoffs.
	assert.match(
		convert,
		/\*PSK\*\)[\s\S]{0,80}val='<set>'/,
		"convert.sh's banner must mask any variable whose name contains PSK"
	);
});

test('usb-prep REFUSES rather than shipping a stick with no LAN range', () => {
	// A stick without it produces a box that stops at the console asking for a
	// variable — the exact burden this mechanism removes, relocated from a desk
	// to the garage.
	assert.match(
		usbPrep,
		/if \[ -z "\$SITE_LAN" \]; then\n\t\tdie /,
		'a stick that cannot supply FLEET_LAN_CIDR must not be built'
	);
});

test('every lookup in resolve_site_facts tolerates finding nothing', () => {
	// node-usb-prep.sh runs under `set -euo pipefail`, and this function runs
	// AFTER the partition has been written. A command substitution that exits
	// non-zero -- an unreachable claw-1, an ssh config with no claw-1 -- would
	// abort the build mid-stick rather than falling through to the refusal.
	//
	// SCANNED BY STATEMENT, not by one regex. The first attempt matched
	// `\w+="\$\((?![^"]*\|\| true)` and reported all nine assignments as
	// unguarded when every one of them was fine: the substitutions contain their
	// own double quotes (`sudo -u "$owner"`), so `[^"]*` stopped at the first one
	// and never reached the `|| true` several lines later. A guard that cannot
	// see past a quote is not reading the code it claims to check.
	const fn = usbPrep.slice(
		usbPrep.indexOf('resolve_site_facts() {'),
		usbPrep.indexOf('\nwrite_site_env() {')
	);
	const lines = fn.split('\n');
	const unguarded = [];
	for (let i = 0; i < lines.length; i++) {
		if (!/^\s*\w+="\$\(/.test(lines[i])) continue;
		// Walk to the end of the assignment, which is the line closing `)"`.
		let text = lines[i];
		let j = i;
		while (!/\)"\s*$/.test(lines[j]) && j < lines.length - 1) text += '\n' + lines[++j];
		if (!text.includes('|| true')) unguarded.push(lines[i].trim());
	}
	assert.deepEqual(
		unguarded,
		[],
		'every command substitution here must end in `|| true`; under set -e a ' +
			'failed lookup kills a build that has already erased a partition'
	);

	// And the scanner must be finding statements at all, or it passes vacuously.
	const total = lines.filter((l) => /^\s*\w+="\$\(/.test(l)).length;
	assert.ok(total >= 5, `expected several lookups in resolve_site_facts, found ${total}`);
});

/**
 * THREE GUARDS FOR THREE BUGS THE FIRST REAL STICK BUILD FOUND.
 *
 * All three were written once already and did not land: the patch that added
 * them used a string replace whose anchor no longer matched after the file had
 * been reformatted, and it failed SILENTLY. The commit message said "guards for
 * both" and there were none. Hence the explicit vacuity checks below — a guard
 * that cannot be shown to fail is not a guard, and one that was never inserted
 * is worse than that.
 */
test('the site facts are RESOLVED before anything on the stick is destroyed', () => {
	// resolve_site_facts can REFUSE — it reaches over the network to another
	// host. The first version ran it at payload-assembly time, which is after
	// `rm -rf bootstrap fixes` and after mkfs, so the first real run refused
	// having already cleared the stick and left a CLAWKIT partition with no
	// payload on it. The refusal was right; its position was not.
	const call = usbPrep.search(/^resolve_site_facts$/m);
	const mkfs = usbPrep.search(/^\s*mkfs\.ext4 /m);
	const clear = usbPrep.search(/rm -rf "\$MNT\/bootstrap"/);
	assert.ok(call > 0, 'resolve_site_facts must be CALLED');
	assert.ok(mkfs > 0, 'expected an mkfs.ext4 step to order against');
	assert.ok(clear > 0, 'expected the payload-clearing step to order against');
	assert.ok(
		call < mkfs && call < clear,
		'resolve_site_facts must run BEFORE mkfs and before the payload is cleared'
	);
});

test('netaddr uses no gawk-only builtins', () => {
	// mawk is what Debian ships and what hokon runs. and()/or()/lshift()/rshift()
	// are GAWK EXTENSIONS: the first version used all four, mawk answered
	// "function and never defined" five times, the LAN came out empty and the
	// build died. Written against gawk semantics, never run on the machine that
	// builds sticks.
	const from = usbPrep.indexOf('netaddr() {');
	assert.ok(from >= 0, 'netaddr must exist — this test would pass vacuously');
	const fn = usbPrep.slice(from, usbPrep.indexOf('\n}', from));
	assert.ok(fn.length > 50, 'netaddr body looks empty; the slice is wrong');
	for (const gawkOnly of ['lshift(', 'rshift(', 'and(', 'or(', 'xor(']) {
		assert.ok(
			!fn.includes(gawkOnly),
			`netaddr uses ${gawkOnly}, which mawk does not define — and mawk builds the sticks`
		);
	}
});

test('every shell function is DEFINED before it is called', () => {
	// `bash -n` CANNOT catch this: calling a function defined later in the file
	// is valid syntax and a runtime "command not found". It happened — the call
	// to resolve_site_facts was moved up into the preflight (correctly, so the
	// refusal precedes any destruction) while its definition stayed down beside
	// the payload write, and the next build died at the safety checks with
	// `resolve_site_facts: command not found`.
	//
	// The ordering test above did not catch it either: it compares the CALL site
	// against mkfs, and a definition reads `name() {`, which `^name$` never
	// matches. Checking one half of an ordering is not checking the ordering.
	const defs = [...usbPrep.matchAll(/^([a-z_][a-z0-9_]*)\(\) \{/gm)].map((m) => ({
		name: m[1],
		at: m.index,
	}));
	assert.ok(defs.length > 3, `expected several function definitions, found ${defs.length}`);
	const bad = [];
	for (const { name, at } of defs) {
		const call = usbPrep.search(new RegExp(`^\\t*${name}(\\s|$)`, 'm'));
		if (call !== -1 && call < at) bad.push(name);
	}
	assert.deepEqual(
		bad,
		[],
		`called before defined: ${bad.join(', ')} — valid syntax, and "command not found" ` +
			'the moment that line runs'
	);
});

/**
 * THE PCIe ERROR STORM IS HANDLED BY THE INSTALL, NOT BY THE OPERATOR.
 *
 * The operator declined to inspect each box for a Realtek RTL8723BE before
 * imaging it, and was right to: "check the hardware first" is not a mitigation,
 * it is a rehearsal of the incident. So the toolchain disarms it.
 *
 * Two halves, because the fault spans two phases. The storm killed claw-4
 * during pkgsel, so the mitigation has to be in early_command, which runs
 * before it. And it has to SURVIVE the install, so the installed system gets it
 * too — but only where a storm was actually observed.
 */
// BLANKED, like every other grep in this file. The first version of the
// blacklist assertion below read the raw text and failed on the COMMENT that
// explains why there is no blacklist — prose scoring as the thing it forbids,
// which is the trap CLAUDE.md records this repo falling into three times.
const preseedSrc = blankShellComments(
	readFileSync(resolve(ROOT, 'scripts', 'lib', 'make-preseed.sh'), 'utf8')
);

test('the installer disables ASPM before it can lose its media', () => {
	assert.match(
		preseedSrc,
		/pcie_aspm\/parameters\/policy/,
		'early_command must turn ASPM off — it is the documented trigger for the ' +
			'correctable-error storm that killed claw-4 mid-pkgsel'
	);
	// It must be in early_command, which runs BEFORE netcfg and pkgsel. Anywhere
	// later is after the window the fault actually kills.
	const aspm = preseedSrc.indexOf('ASPM_FIX');
	const late = preseedSrc.indexOf('WIFI_LATE=');
	assert.ok(aspm > 0 && aspm < late, 'the mitigation must precede the late_command work');
});

test('the installer mitigation does NOT blacklist the radio', () => {
	// claw-4 was fixed by blacklisting rtl8723be, which was right for a node that
	// runs on ethernet. claw-7 is imaged WITH a radio it is expected to use as its
	// fallback link, so blacklisting would trade a broken install for a node that
	// cannot come back when its cable is pulled. ASPM is link power management:
	// the card stays present, bound and usable.
	assert.ok(
		!/blacklist/i.test(preseedSrc),
		'the preseed must not blacklist a driver — it removes the fallback link'
	);
});

test('a storm observed on the box persists the mitigation into the installed system', () => {
	assert.match(
		code,
		/grub\.d\/90-fleet-pcie\.cfg/,
		'node-bootstrap must write a grub drop-in when it observes a storm'
	);
	assert.match(code, /pcie_aspm=off pci=noaer/, 'both parameters: the trigger and the log flood');
	// A DROP-IN, not an edit of /etc/default/grub: one file to delete to undo,
	// and it cannot fight anything else writing that file.
	assert.ok(
		!/sed -i .*\/etc\/default\/grub['"\s]/.test(code),
		'must not edit /etc/default/grub in place'
	);
});

test('the storm is DETECTED in preflight but ACTED ON only after it starts writing', () => {
	// The preflight's refusals promise "Nothing has been changed on this box".
	// Writing a grub drop-in from there would make that a lie.
	const detect = code.indexOf('_AER_LIMIT="$(jq');
	const act = code.indexOf('grub.d/90-fleet-pcie.cfg');
	const firstWrite = code.indexOf('step "1/12');
	assert.ok(detect > 0 && act > 0 && firstWrite > 0, 'expected all three landmarks');
	assert.ok(detect < firstWrite, 'detection belongs in the preflight, before anything is written');
	assert.ok(act > firstWrite, 'the grub write must not happen during the preflight');
});

test('_AER_STORM is initialised outside the threshold guard', () => {
	// node-bootstrap runs under `set -u`. Section 5e reads this variable, so a
	// profile declaring no threshold would not skip the mitigation — it would
	// kill the script nine steps after the guard.
	const init = code.indexOf('_AER_STORM=""');
	const guard = code.indexOf('if [ -n "$_AER_LIMIT" ]');
	assert.ok(init > 0 && guard > 0, 'expected both');
	assert.ok(init < guard, '_AER_STORM must be initialised before the guard that may skip it');
});

/**
 * THE COMMANDS WE PRINT MUST BE COMMANDS THAT RUN, AND THAT NOBODY HAS TO
 * REPAIR AT A CONSOLE.
 *
 * claw-7, 2026-09-08: `sudo mount LABEL=CLAWKIT /mnt/kit` failed with "mount
 * point does not exist", because the mkdir that used to precede it had been
 * dropped from the instruction. Section 6.5 of
 * claw-4-install-postmortem-2026-09-01.md is the same failure a year earlier,
 * from the other direction: the two-line form WRAPPED in the runbook, the
 * mountpoint ended up on its own line, and the mount lost its argument.
 *
 * `/mnt` always exists on a Debian install, so mounting there removes the mkdir
 * entirely — one command instead of two, and no second line to lose. The
 * operator is standing at a physical console reading off a screen; every line
 * removed is a line that cannot go wrong there.
 */
test('no console instruction needs a directory created first', () => {
	// EVERY script that ships to the stick, not just the two that started this.
	// The bug that prompted it was in node-bootstrap's PRINTED guidance, which
	// neither of those two files covers: it told the operator to
	// `tee /mnt/kit/enrollment-<node>.txt`, and with the stick mounted at /mnt
	// that redirect fails and takes the enrollment record with it.
	const shipped = [
		['node-usb-prep.sh', usbPrep],
		['convert.sh', convert],
		['node-bootstrap.sh', code],
		[
			'fixes/claw-fix.sh',
			blankShellComments(readFileSync(resolve(ROOT, 'scripts', 'fixes', 'claw-fix.sh'), 'utf8')),
		],
	];
	for (const [label, src] of shipped) {
		assert.ok(
			!/mkdir -p \/mnt/.test(src),
			`${label} tells the operator to mkdir a mountpoint. /mnt already exists — ` +
				'use it, and the instruction is one line that cannot wrap'
		);
		assert.ok(
			!/\/mnt\/kit/.test(src),
			`${label} still references /mnt/kit, which does not exist on a fresh install`
		);
	}
});

test('every printed mount is a single self-contained line', () => {
	// The claw-4 postmortem's §6.5: the wrapped form lost its mountpoint when
	// copied as displayed, and cost time twice.
	const mounts = [...usbPrep.matchAll(/^\s*sudo mount LABEL=\S+.*$/gm)].map((m) => m[0].trim());
	assert.ok(mounts.length > 0, 'expected printed mount commands — this would pass vacuously');
	for (const m of mounts) {
		assert.match(
			m,
			/^sudo mount LABEL=\S+ \/\S+$/,
			`printed mount is not a complete single line: ${m}`
		);
	}
});

/**
 * THE ENROLLMENT RECORD IS A PARSED CONTRACT, SO NO FIELD MAY CARRY PROSE.
 *
 * claw-7, 2026-09-08, from a box whose only fault was not having rebooted yet:
 *
 *   ENROLL gpuModel NVIDIA-SMI has failed because it couldn't communicate ...
 *
 * `nvidia-smi` writes its failure to STDOUT, so `2>/dev/null` does not suppress
 * it, and a command substitution takes the exit status of the LAST command in a
 * pipeline — where `head -1` succeeds on anything. The error text became the
 * field VALUE, in a record scripts/lib/enrollment-record.mjs parses line by
 * line.
 *
 * capability-probe.sh already carries this exact lesson for `gh`, written after
 * the same mistake produced `CAP gh ok` on a box with no gh at all. Two files,
 * one bug, so it is worth a gate rather than a third comment.
 */
test('no ENROLL field is filled from an unchecked pipeline', () => {
	// The shape that causes it: `$(cmd ... | head)` inside the emit, where the
	// pipeline's status is head's and cmd's failure output becomes the value.
	const emits = code.split('\n').filter((l) => /^echo "ENROLL /.test(l.trim()));
	assert.ok(emits.length > 10, `expected the ENROLL block, found ${emits.length} lines`);
	const piped = emits.filter((l) => /\$\([^)]*\|\s*head/.test(l));
	assert.deepEqual(
		piped,
		[],
		"an ENROLL value is taken from a pipeline whose exit status is `head`'s. Capture " +
			'the command into a variable gated on its STATUS first, then trim:\n  ' +
			piped.join('\n  ')
	);
});

test('the GPU fields are gated on nvidia-smi succeeding', () => {
	assert.match(
		code,
		/if _o="\$\(nvidia-smi --query-gpu=name[^)]*\)" && \[ -n "\$_o" \]/,
		'gpuModel must come from a status-checked capture'
	);
	// VRAM is a COUNT and must parse as one — NUMERIC_FIELDS in
	// enrollment-record.mjs rejects anything else, and "unknown" is the only
	// non-numeric value it accepts.
	assert.match(code, /_GPU_VRAM="\$\(printf[^)]*\)"|tr -dc '0-9'/, 'gpuVramMb must be digits only');
});

test('the wired port is chosen by CARRIER, not alphabetically', () => {
	// claw-7 has two NICs: eno1 (onboard, empty) and enp8s0 (carrying the link).
	// Taking the first /sys/class/net/e* picked the DEAD one, so NetworkManager
	// got a connection for a port with no cable while the live one stayed on the
	// installer's dhclient — "connected (externally)", default route at metric
	// 1002 instead of the 100 the profile asks for. Both links looked configured
	// and neither was under one manager: the exact split 11b exists to prevent.
	//
	// The preseed's WIRED_LATE already chooses this way, in this repo, and this
	// did not follow it.
	const loop = code.slice(code.indexOf('WIRED_IF=""'), code.indexOf('if [ -z "$WIRELESS_SPEC" ]'));
	assert.ok(loop.length > 50, 'could not find the wired-interface selection');
	assert.match(
		loop,
		/carrier/,
		'the wired interface must be selected by carrier — a box with two NICs and one ' +
			'cable otherwise configures the wrong one'
	);
	// And it must still answer when NOTHING has a carrier, so a box converted
	// with every cable out still gets a connection written for its next boot.
	assert.match(loop, /\[ -n "\$WIRED_IF" \] \|\| WIRED_IF=/, 'needs a no-carrier fallback');
});

test('the CAP reader keeps the whole detail, not its first word', () => {
	// `check-capabilities` destructured a full split(/\s+/), which keeps the
	// fourth field and drops the rest — so every multi-word detail the probe
	// emits was truncated to one word. The fleet table showed `nvdec=cuda` and
	// `cuda=no` on five claws from details reading "cuda hwaccel decode failed"
	// and "no CUDA device". The probe was right; the reader threw the answer away.
	const src = readFileSync(resolve(ROOT, 'scripts', 'check-capabilities.mjs'), 'utf8');
	assert.ok(
		!/\[tag, cap, ok, detail\] = .*split\(/.test(src),
		'destructuring a full split drops everything after the fourth field'
	);
	// And prove the replacement actually keeps it.
	const re = /^CAP\s+(\S+)\s+(\S+)\s*(.*)$/;
	const m = re.exec('CAP nvdec no cuda hwaccel decode failed');
	assert.equal(m[1], 'nvdec');
	assert.equal(m[2], 'no');
	assert.equal(m[3], 'cuda hwaccel decode failed', 'the detail must survive intact');
});

test('nothing in bootstrap can stop and wait for a keypress', () => {
	// corepack prompts before downloading pnpm, so `pnpm --version` — a line
	// written to REPORT a version — blocked two installs waiting for Enter. It
	// never appeared in the log: the prompt goes to the terminal, and the log
	// only sees what the command printed afterwards, so it looked like the
	// script had simply stopped.
	assert.match(
		code,
		/export COREPACK_ENABLE_DOWNLOAD_PROMPT=0/,
		'corepack must not ask before a download this script already decided to make'
	);
	assert.ok(
		code.indexOf('COREPACK_ENABLE_DOWNLOAD_PROMPT') < code.indexOf('corepack enable'),
		'it must be exported BEFORE corepack is first invoked'
	);
	// The apt half of the same problem.
	assert.match(code, /export DEBIAN_FRONTEND=noninteractive/);
});

test('the apt component edit is verified, not asserted', () => {
	// It printed "apt component 'non-free' enabled" straight after a sed that
	// never matched, so claw-8 came up with an RTX 2060 SUPER and no driver:
	// `\|` alternation silently does not match in GNU sed 4.9 here.
	assert.match(code, /^add_apt_component\(\) \{/m, 'one implementation, not two inline copies');
	const fn = code.slice(
		code.indexOf('add_apt_component() {'),
		code.indexOf('\n}', code.indexOf('add_apt_component() {'))
	);
	// SED ONLY. grep's `\|` and sed's behave DIFFERENTLY in the same GNU
	// toolchain — measured 2026-09-08: `grep -q '\(a\|x\)'` matches and
	// `sed 's|\(a\|x\)bc|M|'` does not. So the "already enabled" grep, which
	// relies on it (and correctly does NOT false-match `non-free-firmware`), is
	// fine; it was only the sed that silently did nothing.
	const seds = fn.split('\n').filter((l) => l.includes('sed -i'));
	assert.ok(seds.length > 0, 'expected the component edit to use sed');
	for (const line of seds) {
		assert.ok(
			!line.includes('\\|'),
			`sed alternation does not match in this toolchain: ${line.trim()}`
		);
	}
	assert.ok(
		fn.lastIndexOf('grep -rqs') > fn.indexOf('sed -i'),
		'the component must be read back AFTER the edit, by a different reader'
	);
});

test("a box with no radio loses the preseed's networkd config — and ONLY the preseed's", () => {
	// claw-5 and claw-6 were imaged before c4a5589 (2026-09-07), when WIFI_LATE
	// wrote 25-wireless.network and enabled systemd-networkd on any stick with
	// wifi credentials. Neither has a radio, so systemd-networkd-wait-online
	// failed every boot and held network-online.target for two minutes. The
	// cleanup recognises the file by its exact content; if that ever stops
	// matching what the preseed writes, the cleanup goes quietly inert.
	const printfArgs = (src, label) => {
		const m = /printf '%s\\{1,2}n' ('\[Match\]' 'Name=wl\*' [^>]*?)\s*(?:>|\)")/.exec(src);
		assert.ok(m, `could not find the 25-wireless.network content in ${label}`);
		return m[1].trim();
	};
	const preseed = readFileSync(resolve(ROOT, 'scripts', 'lib', 'make-preseed.sh'), 'utf8');
	const branch = code.slice(
		code.indexOf('WIFI_STATE="none no-wireless-hardware"'),
		code.indexOf('WIFI_DRIVER="$(basename')
	);
	assert.ok(branch.length > 50, 'could not find the no-wireless-hardware branch');
	assert.equal(
		printfArgs(branch, 'the no-radio branch'),
		printfArgs(preseed, 'make-preseed.sh'),
		'the cleanup must recognise exactly the file the preseed writes'
	);
	assert.match(branch, /systemctl disable --now systemd-networkd-wait-online/);
	assert.match(
		branch,
		/= 25-wireless\.network \]/,
		'only when that file is alone in the directory'
	);
});

test('the enrollment record carries the failed units the install left behind', () => {
	assert.match(code, /^echo "ENROLL failedUnits \$\(u "\$FAILED_UNITS" /m);
	assert.match(code, /FAILED_UNITS=none/, 'a counted zero is "none", never an empty field');
});
