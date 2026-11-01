#!/usr/bin/env node
/**
 * enroll-node — turn a bootstrapped box into a DECLARED fleet node.
 *
 * THE GAP THIS FILLS
 * ------------------
 *   IMAGE  ->  CONVERT  ->  [ ENROLL ]  ->  PROVISION  ->  VERIFY
 *   usb-prep   bootstrap      here         reconcile      --check
 *
 * `provision-fleet.mjs` refuses a node that is not in the manifest — "a node is
 * provisioned BECAUSE it is declared". Until this existed, crossing that line
 * meant retyping measured numbers by hand, later, from memory. That is exactly
 * how `ramGb: 11` came to sit beside a box that measures 11885MiB, and why the
 * slice ceiling has to be derived from the kernel instead of from the manifest.
 *
 * ENROLL IS THE ONLY INVERSION IN THE SYSTEM (docs/VOCABULARY.md). Everywhere
 * else the manifest describes a node and a probe observes it. Here there is no
 * manifest entry yet, so the box describes ITSELF — and a self-description is
 * the one input this repo has no other way to check.
 *
 * SO IT CHECKS IT. This command runs on the CONTROL host, which means it can
 * independently measure the same box over its own ssh connection and compare.
 * enrollment-record.mjs says so in as many words: `sshFromControl` is
 * "the control host's half of enrollment" and is `unknown` in every record
 * emitted at a console. This is that half.
 *
 * NOT EVERY FIELD COMPARES THE SAME WAY, and treating them alike would be worse
 * than not comparing at all:
 *
 *   IDENTITY + FIXED HARDWARE (cores, memTotalKb, hostname) — FATAL on
 *     mismatch. These cannot change between bootstrap and enroll. A record
 *     claiming 8 cores against a box that probes 4 is a spliced capture, a
 *     pasted scrollback from the wrong machine, or the wrong ssh target. Every
 *     one of those enrolls the wrong box under the right name.
 *
 *   LEGITIMATELY MOVING (diskFreeGb) — REFRESHED, never fatal. Disk free space
 *     changes between the two measurements by definition; apt alone moves it.
 *     Failing on it would train an operator to pass --force, and a --force
 *     habit is how the fatal checks above stop being read.
 *
 *   MAY LEGITIMATELY CHANGE (kernel, osCodename) — ADVISORY. A reboot into a
 *     new kernel between bootstrap and enroll is normal and worth SAYING, not
 *     worth refusing.
 *
 * WHAT IT WILL NOT DECIDE
 * -----------------------
 * No `ephemeral`. It is the one flag with an ordering dependency: it may only
 * be set once the node has EARNED `jitconfig`, which requires the JIT payload
 * to have been seeded first (claw-8's throttle gate caught the reverse order).
 * `fleet provision` flips it, after bootcamp. `labels` is written as `[]` —
 * that IS the all-JIT shape, not eligibility: standing eligibility is granted
 * by the fast loop once a node is judged safe, and a JIT node's labels ride the
 * mint call. Everything else placement needs (role, maxRegistrations, slice,
 * minFreeGb) is a fleet constant, derived, never asked — claw-9's onboarding
 * took four HAND EDITS for exactly those fields (#50, #52).
 *
 * A thermal `maxConcurrent` override, `excludeRepos` and `residentRepos` stay
 * human decisions. The DERIVED capacity (`derivedCapacity`) is what measured
 * MemTotal supports, not what somebody chose after watching the box cook; a
 * human override afterwards wins, because `--update` never touches it.
 *
 * Measurement is automated. DECLARATION STAYS A HUMAN ACT: without --write this
 * prints the proposal and exits 1.
 *
 * USAGE
 *   fleet enroll claw-5                 # propose (exit 1 — nothing written)
 *   fleet enroll claw-5 --write         # commit it to the manifest
 *   fleet enroll claw-5 --update        # refresh MEASURED fields on an existing node
 *   fleet enroll --file capture.txt     # from a console capture, no re-probe
 *   fleet enroll --stdin --json
 *
 * SPLIT ACROSS FILES (wave 5p lane D, parameterizing restructure): argv
 * parsing, the retired-name check, the `--help`/`--write` gates and the final
 * summary print stay here; record/probe acquisition, the hardware comparison,
 * the addressing facts, the manifest commit and the tailscale onboarding live
 * in `scripts/lib/enroll-*.mjs`, taking this file's flags and helpers
 * (`log`/`warn`/`die`) through one `ctx` object built once, below. No lib
 * imports this file. `sshCapture`/`probeSshName`/`writeSshConfig` already
 * lived in `scripts/lib/enroll-ssh.mjs` (wave 5o lane D).
 *
 * @guards scripts/lib/enrollment-record.mjs
 */
import process from 'node:process';

import {
	EnrollmentRecordError,
	parseEnrollmentRecord,
	proposedManifestEntry,
	derivedPlacement,
} from './lib/enrollment-record.mjs';
import { loadManifest, manifestPath } from './lib/fleet-exec.mjs';
import { writeSshConfig } from './lib/enroll-ssh.mjs';
import { keepStdoutWhole } from './lib/emit.mjs';
import { obtainRecordText, probeNode } from './lib/enroll-record-source.mjs';
import { compareHardware } from './lib/enroll-hardware-compare.mjs';
import { printAddressing, probeAddressing } from './lib/enroll-addressing.mjs';
import { commitManifestEntry } from './lib/enroll-write.mjs';
import { bringUpTailscale } from './lib/enroll-tailscale.mjs';

// STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
// and on a pipe `process.exit` throws away whatever the stream still had
// queued — measured on this host, 149,133 bytes in and 146,176 out, which
// `JSON.parse` then rejects mid-string. `keepStdoutWhole` puts fd 1 in
// blocking mode so there is nothing left to lose. Issue #33; the shared
// emitter calls the same function for the scripts that use it.
keepStdoutWhole();

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
	const i = args.indexOf(f);
	return i === -1 ? null : (args[i + 1] ?? null);
};

if (has('--help') || has('-h')) {
	console.log(
		[
			'fleet enroll <node> [--write|--update] [--json]',
			'fleet enroll --file <capture> [--json]',
			'fleet enroll --stdin [--json]',
			'',
			'  <node>      ssh target. Reads the record from its newest bootstrap log and',
			'              RE-MEASURES the box over the same connection.',
			'  --write     commit a NEW node to the manifest. Without it, nothing is written',
			'              and the exit status is 1 — declaration is a human act.',
			'  --update    refresh only the MEASURED fields of a node already declared.',
			'              Never touches labels, capacity, excludeRepos or any $why.',
			'  --hardware-changed memTotalKb|cores --reason "<why>"',
			'              with --update: accept a KNOWN hardware change in that field',
			'              (a RAM upgrade) instead of refusing it; recorded in $measured.',
			'  --file      a saved capture. No re-probe is possible, and it says so.',
			'  --stdin     read the capture from stdin.',
			'  --json      machine-readable result.',
		].join('\n')
	);
	process.exit(0);
}

const JSON_OUT = has('--json');
const WRITE = has('--write');
// STOP AT THE COMMIT — see `lib/manifest-target.mjs`. A test of a writer that
// pushes is a test that mutates a real repository.
const NO_PUSH = has('--no-push');
// `--address` EXISTS BECAUSE THE SSH WRITER CANNOT BOOTSTRAP ITSELF.
//
// Enrolment reads the node's record over ssh BY NAME, so `ssh claw-8` has to
// resolve before anything here runs — which means the entry this script writes
// is one it needed before it started. Writing it afterwards helps only the
// SECOND enrolment, which is not the one that hurts.
//
// So the first enrolment may be handed the address once, and everything after
// resolves by name. It is still not a value anyone has to remember: it is on
// the screen at the console, and `fleet enroll` is the first thing run after
// convert.
const ADDRESS = process.argv.includes('--address')
	? process.argv[process.argv.indexOf('--address') + 1]
	: null;
const UPDATE = has('--update');
/**
 * A KNOWN HARDWARE CHANGE, acknowledged by name. MemTotal is fixed hardware
 * between bootstrap and enroll, and a mismatch is fatal because the failure it
 * catches (a spliced capture, the wrong ssh target) differs by gigabytes. A RAM
 * upgrade differs by gigabytes too, and is legitimate: claw-6 went 8 -> 16 GB
 * on 2026-10-27 and `--update` refused it as "not the box that was
 * bootstrapped". `--hardware-changed memTotalKb --reason "<why>"` accepts the
 * named field ONLY, with --update ONLY, and records from/to/why in
 * `$measured.hardwareChanges`. hostname never qualifies: a new name is a new
 * node (node names are immutable). Not a --force: it names what changed.
 */
const HARDWARE_CHANGED = (valueOf('--hardware-changed') ?? '')
	.split(',')
	.map((x) => x.trim())
	.filter(Boolean);
const HARDWARE_REASON = valueOf('--reason');
const HARDWARE_FIELDS = ['memTotalKb', 'cores'];
const FILE = valueOf('--file');
const STDIN = has('--stdin');
// THE NODE NAME IS A POSITIONAL HERE, and that is enrolment's one deliberate
// exception: the node is not in the manifest yet, so `--machine` — which every
// other subcommand uses and which machineArg validates against the manifest —
// has nothing to check against.
//
// But a bare `find(!startsWith('--'))` also swallows the VALUE of any flag that
// takes one: `fleet enroll --address 1.2.3.4 claw-8` would enrol a node called
// "1.2.3.4". The values of known value-flags are skipped, which is what
// `unconsumedArgs` does for every other command.
const VALUE_FLAGS = new Set(['--address', '--file', '--hardware-changed', '--reason']);
const NODE =
	args.find((a, i) => {
		if (a.startsWith('--') || a === FILE) return false;
		const prev = args[i - 1];
		return !(prev && VALUE_FLAGS.has(prev));
	}) ?? null;

const out = [];
const log = (m) => (JSON_OUT ? out.push(m) : console.log(m));
const warn = (m) => (JSON_OUT ? out.push(`WARN ${m}`) : console.warn(`\x1b[33m${m}\x1b[0m`));

function die(message, extra = {}) {
	if (JSON_OUT) {
		console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
	} else {
		console.error(`\x1b[31m[enroll] ${message}\x1b[0m`);
	}
	process.exit(1);
}

if (!NODE && !FILE && !STDIN) {
	die('name a node, or pass --file <capture> / --stdin. See --help.');
}
if (HARDWARE_CHANGED.length) {
	if (!UPDATE) die('--hardware-changed only refreshes a node already declared: pass --update.');
	const bad = HARDWARE_CHANGED.filter((f) => !HARDWARE_FIELDS.includes(f));
	if (bad.length)
		die(`--hardware-changed accepts ${HARDWARE_FIELDS.join(', ')}; not ${bad.join(', ')}.`);
	if (!HARDWARE_REASON) die('--hardware-changed needs --reason "<what was changed, and when>".');
}

// ONE CONTEXT OBJECT, handed into every lib function EXPLICITLY — never a
// reverse import (see the header's SPLIT ACROSS FILES note).
const ctx = {
	JSON_OUT,
	WRITE,
	NO_PUSH,
	NODE,
	ADDRESS,
	FILE,
	STDIN,
	HARDWARE_CHANGED,
	HARDWARE_REASON,
	log,
	warn,
	die,
};

/**
 * A RETIRED NAME IS REFUSED. `fleet retire` adds a node's name to the
 * manifest's `retired` array in the SAME `manifestEdit` transaction that
 * deletes its `machines` entry (closing `docs/runbooks/replace-claw.md`'s Gap:
 * "nothing checks a proposed name against every claw that has EVER existed").
 * Node names are immutable (docs/VOCABULARY.md) — the only legitimate way past
 * this refusal is to pick a different name, never to override it.
 *
 * A NODE THAT IS NOT IN THE MANIFEST YET IS THE NORMAL CASE, and an unreadable
 * manifest reads as "not retired", deliberately: refusing every enrolment on a
 * missing manifest would break the one case enrolment exists for.
 */
if (NODE) {
	let manifestDoc = null;
	try {
		manifestDoc = loadManifest();
	} catch (err) {
		// Named, not swallowed: the manifest is unreadable, so the retired-name
		// ledger could not be looked up, and the run says so.
		warn(`could not read the manifest to check ${NODE} against the retired ledger: ${err.message}`);
	}
	if (manifestDoc?.retired?.includes(NODE)) {
		die(
			`${NODE} is a RETIRED node name and may never be re-declared.\n` +
				`  Node names are immutable (docs/VOCABULARY.md) — a replacement, if any, is\n` +
				`  the next integer, never this name again. See \`fleet retire\`'s ledger\n` +
				`  (the manifest's \`retired\` array) and docs/runbooks/replace-claw.md.`,
			{ node: NODE, retired: true }
		);
	}
}

// ── 1. obtain the record, and the control host's own measurement ──────────
const recordText = obtainRecordText(ctx);

let parsed;
try {
	parsed = parseEnrollmentRecord(recordText);
} catch (err) {
	if (err instanceof EnrollmentRecordError) die(err.message);
	throw err;
}
const declared = parsed.fields;

const probed = probeNode(ctx);

// ── 2. declared against observed ────────────────────────────────────────────
const { notes, hardwareChanges } = compareHardware(ctx, declared, probed);

const entry = proposedManifestEntry(parsed);

// diskFreeGb is REFRESHED from the probe rather than compared: it moves by
// definition, and a check that fails on normal drift teaches people to skip it.
if (probed?.diskFreeGb) entry.diskFreeGb = Number(probed.diskFreeGb);

// The node cannot answer this; we just did, by getting here at all.
const sshFromControl = probed ? 'ok' : (declared.sshFromControl ?? null);

// WHETHER ANYBODY CHECKED. A capture is a legitimate input — the whole record
// format is a line protocol so a serial-console scrollback can be pasted — but
// an unverified capture and an ssh-verified one must never be indistinguishable
// once they are in the manifest. This rides along in $measured, and the write
// path says it out loud.
const verified = Boolean(probed);

// ── 3. the proposal ─────────────────────────────────────────────────────────
const MANIFEST = manifestPath();
const doc = loadManifest(MANIFEST);
doc.machines ??= {};
const name = entry.name;
const exists = Object.prototype.hasOwnProperty.call(doc.machines, name);

// ONLY WHAT WAS MEASURED. `$`-prefixed keys are this manifest's own convention
// for documentation that readers ignore, so provenance rides along without
// pretending to be configuration.
const measured = {
	cores: entry.cores,
	ramGb: entry.ramGb,
	// DERIVED, and written. These were left absent for a human to type, which is
	// how a node could sit declared and bounded by nothing — and the "a human
	// still owes" line that was supposed to catch that omitted minFreeMb, the
	// field whose absence becomes MIN_FREE_MB=0. `derivedCapacity` computes both
	// from MEASURED MemTotal and returns null/null when memory could not be read,
	// so an unmeasured box gets no numbers rather than guessed ones.
	...(entry.maxConcurrent === null || entry.maxConcurrent === undefined
		? {}
		: { maxConcurrent: entry.maxConcurrent, minFreeMb: entry.minFreeMb }),
	// PLACEMENT, DERIVED under all-JIT (2026-09-22). claw-9's onboarding needed
	// four HAND EDITS after this command — labels:[], role, maxRegistrations,
	// slice, minFreeGb — each discovered by a later command refusing, and #52's
	// missing minFreeGb reddened the site repo's main. None is a decision: labels []
	// IS the all-JIT shape (the fast loop grants standing eligibility once the
	// node is safe; a JIT node's labels ride the mint call), and the rest are
	// fleet constants. `ephemeral` stays ABSENT — it is set by `fleet provision`
	// only after bootcamp has EARNED jitconfig on a seeded payload.
	...derivedPlacement(),
	$measured: {
		at: new Date().toISOString(),
		by: 'fleet enroll',
		source: NODE ? `${NODE}:/var/log/node-bootstrap-*.log + ssh re-probe` : (FILE ?? 'stdin'),
		recordedAt: declared.recordedAt,
		memTotalMb: entry.memTotalMb,
		diskFreeGb: entry.diskFreeGb,
		diskModel: declared.diskModel,
		osId: declared.osId,
		osCodename: declared.osCodename,
		kernel: probed?.kernel ?? declared.kernel,
		profile: declared.profile,
		role: declared.role,
		fleetUser: declared.fleetUser,
		sshPort: declared.sshPort,
		sudoNoPasswd: declared.sudoNoPasswd,
		sshKeyAuthLoopback: declared.sshKeyAuthLoopback,
		sshFromControl,
		verified,
		capabilities: entry.capabilities,
		unproven: entry.unproven,
	},
	$why: `Enrolled by \`fleet enroll\` from a node-bootstrap v1 record MEASURED on the box, not typed. cores and ramGb come from that measurement; ramGb is floor(MemTotal) and $measured.memTotalMb carries the unrounded figure, because the slice ceiling needs the second (claw-1 measures 11885MiB, not 11*1024). maxConcurrent and minFreeMb are DERIVED from measured MemTotal (derivedCapacity: floor = MemTotal/8 clamped [1536,8192], concurrency = min(4, floor((MemTotal-floor)/4096))) rather than left for a human, because leaving them absent meant a node could sit declared and bounded by NOTHING -- ci-throttle.sh renders a missing value as MAX_CONCURRENT=99, MIN_FREE_MB=0, and claw-7 sat in exactly that state, invisible to the deployer. Placement is derived too (2026-09-22, after the tier ladder was retired): labels is EMPTY and that is the all-JIT shape -- a JIT node mints a runner per job with its labels on the mint call, and standing eligibility is written by the fast loop once the node is safe; reconcile refuses a node with no labels array at all, which is the refusal that forced the first claw-9 hand edit. role/maxRegistrations/minFreeGb/slice are fleet constants (see derivedPlacement); minFreeGb must sit above the 16GB registration refusal or the site repo's claw-cleanup gate reddens main (#52). ephemeral is DELIBERATELY ABSENT: it is flipped by \`fleet provision\` only after bootcamp has EARNED jitconfig against a seeded payload -- setting it earlier mints runners the node cannot start. A box whose memory could not be read still gets no capacity fields: null is not zero.`,
};

const result = {
	ok: true,
	node: name,
	exists,
	written: false,
	entry: measured,
	capabilities: entry.capabilities,
	unproven: entry.unproven,
	advisories: notes,
};

if (!JSON_OUT) {
	log('');
	if (NODE) result.addressing = probeAddressing(name);

	// Printed HERE, where it is computed. Three paths leave this script -- already
	// declared, nothing written, and a successful write -- and calling the printer
	// at each is three places to forget one, which is how it came to be printed on
	// only the last of them.
	printAddressing(ctx, result.addressing, name);

	log(`\x1b[1m── proposed manifest entry for ${name}\x1b[0m`);
	log(JSON.stringify({ [name]: measured }, null, 2));
	log('');
	log(`  capabilities proven : ${entry.capabilities.join(', ') || '(none)'}`);
	if (entry.unproven.length) log(`  NOT proven          : ${entry.unproven.join(', ')}`);
	// NOTHING LEFT FOR A HUMAN TO TYPE. Until 2026-09-22 this block listed what
	// "a human still owes" (labels, maxRegistrations, and — read off the
	// eligibility capability's requires.fields — every capacity field), then the
	// three supply facets each with its own command, then a toolchain command to
	// "run FIRST". A hand-written owes-list also once OMITTED minFreeMb — one of
	// exactly two fields with a silent permissive default (ci-throttle.sh renders
	// a missing value as MIN_FREE_MB=0, the state that OOM-killed two jobs on
	// claw-2 on 2026-08-24) — which is the standing lesson that a list of what a
	// human owes, maintained by hand, drifts from what the code requires.
	//
	// claw-9's onboarding walked the whole list by hand on 2026-09-20/21:
	// fifteen commands, four hand edits, two alarms (#50, #52), every one a step
	// a machine could have taken. Everything the list named is now either
	// derived here (placement, capacity) or is one phase of `fleet provision`,
	// which chains them in the order the manual record discovered by failing:
	// converge → seed → bootcamp → placement → register/throttle/slice →
	// benchmark → health. What genuinely stays a HUMAN decision is still named,
	// so it is not lost in the automation: excludeRepos, residentRepos, and a
	// thermal maxConcurrent override after watching the box run.
	log(`  a human still owes  : nothing on this path. excludeRepos, residentRepos and a`);
	log(`                        thermal maxConcurrent override are decisions; everything`);
	log(`                        else above is derived from the measurement.`);
	log(`  a run still owes    : $capabilities, $benchmark and $health (\`fleet doctor --machine`);
	log(`                        ${name} --write\`) — and every one of them is a step of:`);
	log(`  next                : \`fleet provision --machine ${name} --confirm\` —`);
	log(`                        converge, seed, bootcamp, placement (ephemeral only AFTER`);
	log(`                        jitconfig is earned), register/throttle/slice, benchmark,`);
	log(`                        health. Idempotent: re-running on a serving node changes`);
	log(`                        nothing and reports green.`);
}

// ── 4. commit, only when told ───────────────────────────────────────────────
if (exists && !UPDATE) {
	die(
		`${name} is ALREADY in the manifest. Re-enrolling would overwrite capacity ` +
			`numbers and $why prose that a human wrote after watching the box run.\n` +
			`  Use --update to refresh ONLY the measured fields (cores, ramGb, $measured), ` +
			`leaving labels, capacity, excludeRepos and every $why untouched.`,
		result
	);
}

if (!WRITE && !UPDATE) {
	if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
	else {
		log('');
		log(`Nothing written. Re-run with --write to declare ${name}.`);
	}
	// EXIT 1 ON A CLEAN PROPOSAL, deliberately. A proposal is not a completed
	// enrollment, and a cron or a script that treated "printed something" as
	// success would silently never declare anything.
	process.exit(1);
}

if (!verified) {
	warn(
		`no re-probe: this came from a capture, not from ${'`'}ssh${'`'}. cores and memTotalKb are ` +
			`the record's own word and nothing has checked them against the box. ` +
			`Recorded as $measured.verified=false.`
	);
}

await commitManifestEntry(ctx, result, { measured, name, exists, hardwareChanges });

result.written = true;
// THE NODE IS DECLARED; NOW MAKE IT REACHABLE BY NAME. Every step after this —
// provision, throttle, slice, bootcamp — resolves the node through ssh, so an
// entry is a prerequisite rather than a convenience. Uses the address that
// SURVIVES a cable pull when the node has one, which is the wireless lease on a
// dual-homed box; falls back to whatever the node is answering on today.
{
	const ifs = result.addressing?.interfaces ?? [];
	const pref = ifs.find((i) => i.wireless && i.ipv4) ?? ifs.find((i) => i.ipv4);
	const r = writeSshConfig(name, pref?.ipv4 ?? null);
	result.sshConfig = r;
	if (r.state === 'written') {
		log(
			`  ssh config: added \`Host ${name}\` -> ${r.hostName}${r.backup ? ` (backup: ${r.backup})` : ''}`
		);
		if (r.pinnedToLease) {
			// NOT a log line. A node pinned to a lease is the 2026-09-07 outage set up
			// to happen again, and the REASON each name failed is the whole difference
			// between "fix the Tailscale ACL" and "nothing publishes mDNS".
			warn(`ssh config: ${name} is pinned to a DHCP lease — ${r.why}`);
		} else {
			log(`  ssh config: also \`Host ${name}-lan\` -> ${r.address} as the fallback`);
		}
		if (pref && !pref.wireless) {
			warn(`that is a WIRED address; if this node is ever unplugged the fleet loses it.`);
		}
	} else if (r.state === 'already') {
		log(
			`  ssh config: ${name} already resolves${r.hostname ? ` to ${r.hostname}` : ''} — left alone`
		);
	} else if (r.state === 'no-address') {
		warn(`ssh config: ${name} reported no IPv4 address; nothing written`);
	}
}
result.mode = exists ? 'updated measured fields' : 'declared';

bringUpTailscale(ctx, result, { name, doc });

if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
else {
	log('');
	log(`\x1b[32m✓ ${name} ${result.mode} in ${MANIFEST}\x1b[0m`);
	log(`  backup: ${MANIFEST}.bak`);
	const ts = result.tailscale;
	if (ts?.state === 'awaiting-login') {
		log('');
		log(`\x1b[33m  TAILSCALE: ${name} is waiting to join, tagged \`tag:claw\`.\x1b[0m`);
		log(`  Click to authenticate:  ${ts.url}`);
		log(`  The tag is what makes its key never expire — do not authenticate it untagged.`);
	} else if (ts?.state === 'already-on-tailnet') log(`  tailscale: already on the tailnet`);
	else if (ts?.state === 'not-installed') warn(`tailscale is not installed on ${name}`);
	else if (ts?.state === 'error') warn(`tailscale step failed: ${ts.error}`);
	// The addressing facts were printed where they were computed, on every exit
	// path. Printing them again here is the duplicate that made a two-line
	// summary appear twice in one run.
	log(`  next:   \`fleet provision --machine ${name} --confirm\` — capacity is derived, and the`);
	log(`          chain takes the node the rest of the way to serving.`);
}
