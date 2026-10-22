/**
 * The commands we PRINT must be commands that RUN.
 *
 * `fleet onboard`'s closing banner told the operator to run
 *
 *     node-bootstrap.sh --profile desktop-debian-trixie
 *
 * which fails three ways: `--profile` takes a FILE and not an id, and
 * `--pubkey` and `--hostname` are both required and both absent. That command
 * is typed at a physical console, on a machine with no fleet tooling, after a
 * drive to the garage — the most expensive place in this whole system to
 * discover a typo in a docstring.
 *
 * Nothing caught it because these are strings in a heredoc, and no gate reads
 * them. This one does.
 *
 * SINCE 2026-08-30 THERE ARE NO REQUIRED FLAGS. node-bootstrap.sh infers all
 * three — the key and the profile from the stick it is running off, the
 * hostname from the box the installer just named — so the printed command is
 * `sudo bash /mnt/kit/bootstrap/node-bootstrap.sh` and nothing else. That
 * deleted this file's original claim: "every printed invocation supplies every
 * flag node-bootstrap requires" is trivially true of an empty set, and a gate
 * that cannot fail is not a gate. What replaces it is the two halves of the
 * claim the inference actually makes:
 *
 *   1. THE SHORT FORM RESOLVES. Given a stick laid out the way `fleet usb-prep`
 *      lays one out, the flagless command finds the key and finds the profile.
 *   2. AN AMBIGUOUS STICK STILL REFUSES. Two profiles and it names both and
 *      stops, rather than imaging a node into a shape nobody chose.
 *
 * Both are proved by RUNNING node-bootstrap.sh's own guards against a fixture,
 * for the reason usb-device-guard.test.mjs runs the real file rather than a
 * reimplementation: a test that restates the logic in JavaScript passes forever
 * while the shell drifts. `observed_hostname` is the one thing left untested —
 * it reads this box, which is the half that cannot be fixtured, and it is
 * exactly why the deciding half takes a VALUE.
 *
 * COMMENTS ARE BLANKED FIRST for everything that is still a grep.
 * node-bootstrap.sh documents its own flags in prose — at length, including the
 * words "is required" about flags that no longer are — and this repo has been
 * bitten repeatedly by a grep reading a COMMENT as evidence.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel) => readFileSync(path(rel), 'utf8');
const decomment = (src) =>
	src
		.split('\n')
		.map((l) => (l.trimStart().startsWith('#') ? '' : l))
		.join('\n');

const SCRIPT = path('../node-bootstrap.sh');
const BOOTSTRAP = decomment(read('../node-bootstrap.sh'));
const ONBOARD = read('../onboarding.sh');
const USBPREP = read('../node-usb-prep.sh');

// ── what the script says about itself ───────────────────────────────────────

/** Flags node-bootstrap.sh refuses to run without, read from the script itself. */
function requiredFlags() {
	const out = [];
	for (const m of BOOTSTRAP.matchAll(/\|\|\s*die\s+"(--[a-z-]+) is required/g)) out.push(m[1]);
	return [...new Set(out)].sort();
}

/** Flags it works out for itself instead, read from the guards that do it. */
function inferredFlags() {
	const out = [];
	for (const m of BOOTSTRAP.matchAll(/^infer_([a-z]+)\(\)\s*\{/gm)) out.push(`--${m[1]}`);
	return [...new Set(out)].sort();
}

/** Flags its argument loop actually parses — the `--x)` case arms. */
function acceptedFlags() {
	const loop = BOOTSTRAP.slice(BOOTSTRAP.indexOf('while [ $# -gt 0 ]'));
	const out = [];
	for (const m of loop.slice(0, loop.indexOf('\ndone')).matchAll(/(--[a-z-]+)\)/g)) out.push(m[1]);
	return [...new Set(out)].sort();
}

/**
 * Every printed `node-bootstrap.sh …` command, with its continuation lines.
 *
 * Cut at the first line that is not continued. An earlier version took a fixed
 * six lines, which swept in the sentence UNDER the command — prose that
 * happened to contain `--profile`, so a gate about invocations was reading
 * documentation about invocations. These live in shell heredocs, so the
 * continuation on the operator's screen is a `\` written `\\` in the source.
 */
function invocations(src) {
	const code = decomment(src);
	const out = [];
	for (let from = 0; ;) {
		const at = code.indexOf('node-bootstrap.sh', from);
		if (at === -1) return out;
		from = at + 1;
		const block = [];
		for (const line of code.slice(at).split('\n')) {
			block.push(line);
			if (!/\\\\?\s*$/.test(line)) break;
		}
		out.push(block.join('\n'));
	}
}

const DOCS = [
	['fleet onboard closing banner', ONBOARD],
	['the README written onto the stick', USBPREP],
];

test('node-bootstrap requires no flag it can infer', () => {
	// The `>= 3` sanity check this file used to carry cannot survive the change:
	// an empty result is now the PASS, so a die-message reword and a correct
	// script look identical here. The non-vacuous half moved to inferredFlags() —
	// that one is a list of guards, and it goes empty if they are deleted.
	assert.deepEqual(inferredFlags(), ['--hostname', '--profile', '--pubkey']);
	assert.deepEqual(
		requiredFlags(),
		[],
		`node-bootstrap.sh still refuses to run without ${requiredFlags().join(', ')}. ` +
			`Each of those is inferable from the stick or from the box; a flag that is ` +
			`required is a flag somebody retypes at a console off a photograph.`
	);
});

test('every inferred flag is still accepted as an override', () => {
	for (const flag of inferredFlags()) {
		assert.ok(
			acceptedFlags().includes(flag),
			`${flag} is inferred but the argument loop does not parse it. Inference the ` +
				`operator cannot overrule is a guess with no appeal — and the refusal ` +
				`messages all end by telling them to pass exactly this flag.`
		);
	}
});

test('the preflight calls each guard — defining one and not wiring it is not inference', () => {
	for (const guard of inferredFlags().map((f) => `infer_${f.slice(2)}`)) {
		const called = BOOTSTRAP.split('\n').filter(
			(l) => l.includes(guard) && !l.includes(`${guard}()`)
		);
		assert.ok(called.length > 0, `${guard} is defined and never called`);
	}
});

for (const [name, src] of DOCS) {
	test(`${name} passes node-bootstrap only flags it parses`, () => {
		for (const block of invocations(src)) {
			for (const m of block.matchAll(/(?<![\w-])(--[a-z-]+)/g)) {
				assert.ok(
					acceptedFlags().includes(m[1]),
					`${name} invokes node-bootstrap.sh with "${m[1]}", which its argument ` +
						`loop does not parse — it dies with "unknown option", at a console, ` +
						`in the garage. It accepts: ${acceptedFlags().join(' ')}`
				);
			}
		}
	});
}

test('every printed node-bootstrap invocation passes --profile a FILE', () => {
	// Scoped to the INVOCATION, not to every occurrence of the string. The first
	// version of this test matched its own explanatory prose ("--profile takes
	// the FILE, not the id") and failed on a sentence — a gate that fires on
	// documentation about itself is noise, and noise gets deleted.
	for (const [name, src] of DOCS) {
		for (const block of invocations(src)) {
			const m = block.match(/--profile\s+(\S+)/);
			if (!m) continue;
			assert.match(
				m[1],
				/\.json/,
				`${name} invokes node-bootstrap.sh with "--profile ${m[1]}". It takes the ` +
					`FILE on the stick (profiles/<id>.json), not a profile id — the id form ` +
					`dies with "profile not found", at a console, in the garage.`
			);
		}
	}
});

// ── the guards, run ─────────────────────────────────────────────────────────

const VALID_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyForTests operator@hokon\n';
const sticks = [];
after(() => sticks.forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * A directory shaped like the stick `fleet usb-prep` writes: bootstrap/ holding
 * this script and the key, profiles/ beside it. The script is COPIED rather
 * than symlinked, because it locates the stick from its own `$0`.
 */
function stick({ profiles = ['desktop-debian-trixie'], key = VALID_KEY } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-stick-'));
	sticks.push(root);
	mkdirSync(join(root, 'bootstrap'));
	mkdirSync(join(root, 'profiles'));
	copyFileSync(SCRIPT, join(root, 'bootstrap', 'node-bootstrap.sh'));
	for (const id of profiles)
		writeFileSync(join(root, 'profiles', `${id}.json`), `{"id":"${id}"}\n`);
	if (key !== null) writeFileSync(join(root, 'bootstrap', 'authorized_key.pub'), key);
	return join(root, 'bootstrap', 'node-bootstrap.sh');
}

/**
 * Source a stick's node-bootstrap.sh and call into it.
 *
 * NODE_BOOTSTRAP_SOURCE_ONLY makes it stop after the guard definitions; without
 * that it would run the preflight and then convert this machine. The script is
 * passed as `$0` so its own `HERE="$(dirname "$0")"` resolves to the fixture's
 * bootstrap/ — the same way it will resolve to /mnt/kit/bootstrap on the stick.
 */
function guard(script, snippet) {
	const r = spawnSync('bash', ['-c', `set -u; . "$0"; ${snippet}`, script], {
		encoding: 'utf8',
		env: { ...process.env, NODE_BOOTSTRAP_SOURCE_ONLY: '1' },
	});
	if (r.error) throw r.error;
	return { ok: r.status === 0, out: r.stdout, why: `${r.stderr}${r.stdout}` };
}

test('the flagless short form resolves against a stick fleet usb-prep just wrote', () => {
	const script = stick();
	const kit = dirname(dirname(script));

	const key = guard(script, 'infer_pubkey "$HERE"');
	assert.ok(key.ok, key.why);
	assert.equal(key.out, join(kit, 'bootstrap', 'authorized_key.pub'));

	const profile = guard(script, 'infer_profile "$(kit_profiles_dir "$HERE")"');
	assert.ok(profile.ok, profile.why);
	assert.equal(profile.out, join(kit, 'profiles', 'desktop-debian-trixie.json'));

	const hostname = guard(script, 'infer_hostname claw-4');
	assert.ok(hostname.ok, hostname.why);
	assert.equal(hostname.out, 'claw-4');
});

test('TWO profiles refuses, names both, and asks for --profile', () => {
	const script = stick({ profiles: ['desktop-debian-trixie', 'laptop-debian-trixie'] });
	const r = guard(script, 'infer_profile "$(kit_profiles_dir "$HERE")"');
	assert.equal(r.ok, false, 'a stick built for two shapes of box is not a stick that chose one');
	assert.match(r.why, /desktop-debian-trixie\.json/);
	assert.match(r.why, /laptop-debian-trixie\.json/, 'list them, or the operator cannot pick');
	assert.match(r.why, /--profile/, 'a refusal has to say what to type instead');
	// Aimed where the guard looks (handoff §4): a refusal that still printed a
	// path would be read by `PROFILE_FILE="$(infer_profile …)"` on any call site
	// that forgot to check the status, which is the shape `preq` already has.
	assert.equal(r.out, '', `refusing printed a profile anyway: ${JSON.stringify(r.out)}`);
});

test('NO profile refuses — an empty profiles/ is not a default profile', () => {
	const script = stick({ profiles: [] });
	const r = guard(script, 'infer_profile "$(kit_profiles_dir "$HERE")"');
	assert.equal(r.ok, false);
	assert.match(r.why, /DECLARED shape or not at all/);
	assert.equal(r.out, '');
});

test('no key on the stick refuses — a node with no key is a node with no way in', () => {
	const script = stick({ key: null });
	const r = guard(script, 'infer_pubkey "$HERE"');
	assert.equal(r.ok, false);
	assert.match(r.why, /no way in/);
	assert.equal(r.out, '');
	// ABSENT AND INVALID MUST NOT READ THE SAME. Deleting infer_pubkey's own
	// existence branch does not change the verdict — `validate_pubkey` starts
	// with its own `[ -f ]` and refuses too — so a test that only checked the
	// exit code passed with that branch gone (measured: the mutation ran green
	// on the first pass of this suite). What it DOES change is the message: the
	// operator is told the key they were handed is malformed, and goes looking
	// at a file that is not there. So assert the distinction, not the refusal.
	assert.match(r.why, /there is none at/);
	assert.match(r.why, /usb-prep/, 'say how to get one, not just that there is not one');
	assert.doesNotMatch(
		r.why,
		/not a usable public key/,
		'an ABSENT key reported as an invalid one sends the operator to inspect a file ' +
			'that does not exist'
	);
});

test('a PRIVATE key on the stick refuses — inference validates, it does not just find', () => {
	// The file exists and sits exactly where inference looks. Only the content
	// says no, so this fails if the guard checks presence and stops there.
	const script = stick({ key: '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-public-key\n' });
	const r = guard(script, 'infer_pubkey "$HERE"');
	assert.equal(r.ok, false);
	assert.match(r.why, /PRIVATE key/);
	assert.equal(r.out, '');
});

for (const placeholder of ['', 'debian', 'localhost', 'localhost.localdomain']) {
	test(`hostname ${JSON.stringify(placeholder)} refuses — it means nobody named this box`, () => {
		const r = guard(stick(), `infer_hostname ${JSON.stringify(placeholder)}`);
		assert.equal(r.ok, false, `'${placeholder}' was accepted as a node name`);
		assert.match(r.why, /--hostname/, 'a refusal has to say what to type instead');
		assert.match(r.why, /hostnamectl set-hostname/, 'or how to fix it at the source');
		assert.equal(r.out, '');
	});
}

/**
 * The up-front key check must cover every key `preq` reads.
 *
 * `preq`'s own die cannot stop the script — every call site is
 * `X="$(preq .a.b)"`, so exit 1 leaves the command substitution's subshell, the
 * assignment lands empty and execution continues. Measured 2026-08-30: a stub
 * profile holding only `.id` printed thirteen refusals, kept going, and exited
 * ZERO. So the real check is a single up-front pass in the main shell, and this
 * asserts the two lists cannot drift — a key added to a `preq` call and not to
 * REQUIRED_PROFILE_KEYS is a key that silently becomes "".
 */
test('REQUIRED_PROFILE_KEYS covers every key preq reads', () => {
	const src = decomment(read('../node-bootstrap.sh'));
	const declared = new Set(
		(src.match(/REQUIRED_PROFILE_KEYS="\n([\s\S]*?)"\n/)?.[1] ?? '').split(/\s+/).filter(Boolean)
	);
	assert.ok(declared.size > 20, `expected a populated key list, got ${declared.size}`);

	const used = new Set([...src.matchAll(/\$\(preq\s+(\.[A-Za-z0-9_.]+)\s*\)/g)].map((m) => m[1]));
	assert.ok(used.size > 20, `expected to find preq call sites, got ${used.size}`);

	const uncovered = [...used].filter((k) => !declared.has(k)).sort();
	assert.deepEqual(
		uncovered,
		[],
		`these keys are read by preq but not proven up front, so a profile missing ` +
			`them substitutes "" into a box mid-hardening:\n  ${uncovered.join('\n  ')}`
	);
});

/**
 * An unnamed box is asked about, not refused — but only where there is somebody
 * to ask.
 *
 * claw-5's bootstrap stopped on `localhost` and told the operator to run
 * `hostnamectl set-hostname claw-5` by hand and re-run. They did, and `sudo`
 * then printed "unable to resolve host claw-5" on every later command, because
 * a hand-run hostnamectl leaves /etc/hosts stale and only step 3 repairs it.
 * The script was asking a person to do, worse, the thing it already does.
 */
test('with no console, an unnamed box refuses AND SAYS WHY', () => {
	// spawnSync gives the child no controlling terminal, which is the whole
	// point: this is the ssh -T / cron / pipe path.
	const r = guard(stick(), 'ask_hostname localhost');
	assert.equal(r.ok, false, 'localhost was accepted as a node name');
	assert.equal(r.out, '', 'the prompt must never reach stdout — stdout IS the answer');
	// THE REGRESSION THIS EXISTS FOR. The first cut tested `[ -r /dev/tty ]`,
	// which is TRUE with no controlling terminal — /dev/tty is a character
	// device with rw permissions whether or not it can be opened. Every printf
	// then failed with ENXIO and the function exited 1 having printed NOTHING.
	// A bootstrap that stops and says nothing is the exact failure this repo
	// calls "I could not look rendering as nothing is wrong".
	assert.ok(r.why.trim().length > 0, 'refused in total silence');
	assert.match(r.why, /--hostname/, 'a refusal has to say what to type instead');
});

/**
 * The inventory runs before any guard can say no, and never fails the script.
 *
 * Six installs asked "why does the network not come up" and the answer was one
 * line — this box has no wireless device. Nothing on the bootstrap path had
 * ever written down what the machine IS.
 */
test('collect_inventory states the wireless count rather than implying it', () => {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-inv-'));
	sticks.push(dir);
	const r = guard(stick(), `collect_inventory ${JSON.stringify(dir)}`);
	assert.ok(r.ok, r.why);
	const summary = readFileSync(join(dir, 'summary.txt'), 'utf8');
	// Counts as STATEMENTS. Both were derivable from the per-interface lines for
	// six installs running and nobody read them that way.
	assert.match(summary, /^wireless_interfaces=\d+$/m);
	assert.match(summary, /^wired_interfaces=\d+$/m);
	assert.match(summary, /^cpu_model=.+$/m);
	assert.match(summary, /^mem_total_kb=\d+$/m);
	// The buses, which is where "no wireless device on any bus" is provable.
	for (const f of ['pci.txt', 'usb.txt', 'net.txt'])
		assert.ok(readFileSync(join(dir, f), 'utf8').length > 0, `${f} is empty`);
});

test('collect_inventory cannot fail a bootstrap, even into an unwritable path', () => {
	// A diagnostic that can abort the thing it is diagnosing is worse than none.
	//
	// ASSERTING ONLY `r.ok` HERE IS A GATE THAT CANNOT FAIL, and the first cut of
	// this test did exactly that: collect_inventory ends in `return 0`, so its
	// status is 0 whether or not the mkdir was guarded. Deleting the guard left
	// the test green — measured. What actually changes is the NOISE: unguarded,
	// the mkdir and then every redirection into the missing directory complain on
	// stderr, in the middle of a bootstrap, about a diagnostic nobody asked about.
	const r = guard(stick(), 'collect_inventory /proc/definitely/not/writable');
	assert.ok(r.ok, `inventory failed the script: ${r.why}`);
	assert.equal(r.why.trim(), '', 'an unwritable inventory path must be silent, not noisy');
});

/**
 * A netless box must be told it is netless, in the words of the actual fault.
 *
 * This used to surface four layers away, at the jq install, as "jq is not
 * installed and could not be installed. Check networking." That sentence sent
 * an operator to look at package management for a machine with no wifi card.
 */
test('a box with no route is told so, with the interface counts', () => {
	// Shadowing the probes: `command -v ip` finds the FUNCTION, so check_network
	// takes its normal path and gets an empty route back.
	const r = guard(
		stick(),
		'ip() { :; }; getent() { return 2; }; INVENTORY_DIR=/mnt/kit/inventory; check_network'
	);
	assert.equal(r.ok, false, 'a box with no default route passed the network check');
	assert.match(r.why, /no usable network/);
	assert.match(r.why, /wired/, 'the counts are the diagnosis — say them');
	assert.match(r.why, /wireless/);
	assert.match(r.why, /Nothing has been changed/, 'say the box is untouched');
	assert.match(r.why, /\/mnt\/kit\/inventory/, 'point at the inventory just written');
});

/**
 * The hostname must be READ BACK, not assumed.
 *
 * Measured on claw-4, 2026-09-02: the system bus was not running, `hostnamectl
 * set-hostname` printed "Failed to connect to system scope bus", and this
 * script carried on through nine more steps and declared the node CONVERGED. It
 * left /etc/hosts saying claw-4 and /etc/hostname saying localhost — named in
 * one file, unnamed in the other, and enrolled under a name it did not answer
 * to. `run` does not check exit status, and nothing else looked.
 */
test('setting the hostname is verified against the kernel, not assumed', () => {
	const src = readFileSync(SCRIPT, 'utf8');
	const at = src.indexOf('run hostnamectl set-hostname');
	assert.notEqual(at, -1, 'the hostname is no longer set here');
	// Everything between setting it and the next step banner.
	const after = src.slice(at, at + 2000);
	assert.match(
		after,
		/\/proc\/sys\/kernel\/hostname/,
		'nothing reads the live kernel hostname back after setting it'
	);
	assert.match(after, /\/etc\/hostname/, 'nothing reads /etc/hostname back');
	assert.match(
		after,
		/\bdie\b/,
		'a hostname that did not take must STOP the run — every later step names the node'
	);
});
