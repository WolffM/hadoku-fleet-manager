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
 * @guards scripts/lib/enrollment-record.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import {
	EnrollmentRecordError,
	parseEnrollmentRecord,
	proposedManifestEntry,
	derivedPlacement,
} from './lib/enrollment-record.mjs';
import { loadManifest, manifestPath } from './lib/fleet-exec.mjs';
import { landingLine } from './lib/manifest-target.mjs';
import { manifestEdit } from './lib/manifest-edit.mjs';
// The BUILT copy, for the same reason fleet-exec.mjs imports isLocalNode that
// way: one question, one answer, and no second implementation to drift from.
import { isGuestNode } from '../dist/lib/node-role.js';
import { DEFAULT_ADMIN_USER } from '../dist/lib/node-users.js';
import {
	INTERFACE_PROBE,
	chooseSshHostName,
	parseInterfaces,
	preferredAddress,
	proposeLanRecord,
	sshNameCandidates,
} from './lib/node-interfaces.mjs';
import { keepStdoutWhole } from './lib/emit.mjs';
import { readStdinWhole } from './lib/stdin.mjs';

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
			'',
			'  A GUEST is refused: the fleet chain does not ssh one to re-measure it.',
			'  --include-guests overrides that for an operator who means it.',
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
/** Changes accepted this run: `{ field, from, to, reason, at }`. */
const hardwareChanges = [];

/**
 * A GUEST IS NOT RE-MEASURED, AND THE REFUSAL IS LOUD.
 *
 * Enrolment ssh's the named box, reads its bootstrap log and re-measures it —
 * `nproc`, `free`, `lsblk`, the interface probe. That is the fleet chain on a
 * machine the operator took it off (2026-09-14): a guest lends the fleet a
 * registration and is otherwise none of its business. The name is a POSITIONAL
 * here rather than `--machine`, so `guestGate`'s "the operator named it" door
 * cannot see it; `--include-guests` is the door that works, and it is the same
 * spelling every other command in this package honours.
 *
 * REFUSED rather than skipped, following `bootcamp`: pointed at exactly one
 * node, a silent skip would print a clean run over nothing at all.
 *
 * A NODE THAT IS NOT IN THE MANIFEST YET IS THE NORMAL CASE and reads as a claw
 * — that is `nodeRole`'s strict default, and it is what makes a first enrolment
 * work. An unreadable manifest reads the same way, deliberately: a missing file
 * must not be able to exempt a node from a check, and it cannot make one appear
 * to be a guest either.
 */
const INCLUDE_GUESTS = has('--include-guests');
if (NODE && !INCLUDE_GUESTS) {
	let declared = null;
	try {
		declared = loadManifest()?.machines?.[NODE];
	} catch (err) {
		// Named, not swallowed: the manifest is unreadable, so the role could not be
		// looked up. The run continues under the strict default (claw) and says so,
		// because refusing every enrolment on a missing manifest would break the one
		// case enrolment exists for — a box that is not in it yet.
		warn(`could not read the manifest to check ${NODE}'s role: ${err.message}`);
	}
	if (isGuestNode(declared)) {
		die(
			`${NODE} is a GUEST and the fleet chain does not probe one.\n` +
				`  A guest lends the fleet a registration and is otherwise none of its\n` +
				`  business (operator, 2026-09-14) — enrolment ssh's the box and re-measures\n` +
				`  it, which is exactly that.\n` +
				`  If you really mean to refresh its measured fields, re-run with --include-guests.`,
			{ node: NODE, role: 'guest' }
		);
	}
}

// ── 1. obtain the record ────────────────────────────────────────────────────
function sshCapture(target, remote) {
	return execFileSync(
		'ssh',
		['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, remote],
		{ encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 }
	);
}

let recordText = '';
let probed = null;

if (STDIN) {
	recordText = readStdinWhole();
	log(`[enroll] record from stdin${NODE ? '' : ' (no re-probe possible)'}`);
} else if (FILE) {
	if (!existsSync(FILE)) die(`no such capture: ${FILE}`);
	recordText = readFileSync(FILE, 'utf8');
	log(`[enroll] record from ${FILE}${NODE ? '' : ' (no re-probe possible)'}`);
} else {
	// The record lives in the bootstrap log because node-bootstrap.sh tees its
	// whole run there. Newest wins: a re-bootstrapped box has several.
	try {
		// ALWAYS EXIT 0 REMOTELY, and decide from the OUTPUT. `cat ""` fails when
		// the glob matches nothing, and execFileSync cannot tell that apart from
		// a refused connection — so the first cut of this reported a perfectly
		// reachable claw-1 as "cannot reach over ssh". That is a message naming a
		// symptom four layers from the cause, which is the specific failure this
		// repo keeps re-learning. Reachability and emptiness are now two answers.
		// NODE, not `name` — `name` is derived from the RECORD, which this ssh call
		// is about to fetch, so it is still in its temporal dead zone here. Using it
		// threw "Cannot access 'name' before initialization" and enrolment reported
		// it as "cannot reach claw-8 over ssh", which is the wrong diagnosis for a
		// bug on the control host.
		if (ADDRESS) {
			const seeded = writeSshConfig(NODE, ADDRESS);
			if (seeded.state === 'written')
				log(`  ssh config: seeded ${NODE} -> ${seeded.hostName} so this run can reach it`);
			else if (seeded.state === 'already')
				log(`  ssh config: ${NODE} already resolves — --address ignored`);
		}
		recordText = sshCapture(
			NODE,
			'f="$(ls -t /var/log/node-bootstrap-*.log 2>/dev/null | head -1)"; ' +
				'[ -n "$f" ] && cat "$f" 2>/dev/null; exit 0'
		);
	} catch (err) {
		die(
			`cannot reach ${NODE} over ssh: ${err.message.split('\n')[0]}\n` +
				`  This is not "the node has nothing to report" — it is the control host ` +
				`failing the half of enrollment only it can do.`
		);
	}
	if (!recordText.trim()) {
		die(
			`${NODE} is reachable but has no /var/log/node-bootstrap-*.log.\n` +
				`  Run node-bootstrap.sh on it first — enroll declares a CONVERTED box, ` +
				`it does not convert one.`
		);
	}
	log(`[enroll] record read from ${NODE}:/var/log/node-bootstrap-*.log`);
}

let parsed;
try {
	parsed = parseEnrollmentRecord(recordText);
} catch (err) {
	if (err instanceof EnrollmentRecordError) die(err.message);
	throw err;
}
const declared = parsed.fields;

// ── 2. the control host's own measurement ───────────────────────────────────
if (NODE) {
	try {
		const raw = sshCapture(
			NODE,
			[
				'echo "cores=$(nproc 2>/dev/null)"',
				'echo "memTotalKb=$(awk \'/^MemTotal/{print $2}\' /proc/meminfo 2>/dev/null)"',
				'echo "diskFreeGb=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc 0-9)"',
				'echo "hostname=$(hostname 2>/dev/null)"',
				'echo "kernel=$(uname -r 2>/dev/null)"',
			].join('; ')
		);
		probed = Object.fromEntries(
			raw
				.split('\n')
				.filter((l) => l.includes('='))
				.map((l) => {
					const i = l.indexOf('=');
					return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
				})
		);
	} catch (err) {
		die(`re-probe of ${NODE} failed: ${err.message.split('\n')[0]}`);
	}
}

// ── 3. declared against observed ────────────────────────────────────────────
const FATAL = ['cores', 'hostname'];
/**
 * memTotalKb is fixed hardware, but NOT a fixed NUMBER.
 *
 * Measured on claw-6, 2026-09-02: the record said 8038384 and the re-probe said
 * 8038388 — four kilobytes, one page. The kernel reserves slightly different
 * amounts from boot to boot depending on what is loaded, so an exact comparison
 * refuses a perfectly good node and tells its operator the capture came from a
 * different machine. That is a false accusation, and the kind that trains people
 * to pass --force.
 *
 * A tolerance still catches what this check is for. The failure it exists to
 * prevent is a spliced capture or the wrong ssh target, and those differ by
 * gigabytes: 8GB against 16GB is 100% out, not 0.00005%.
 */
const MEM_TOLERANCE = 0.01;
const ADVISORY = ['kernel'];
const conflicts = [];
const notes = [];

if (probed) {
	log('[enroll] re-probing over ssh (declared vs observed)');
	for (const key of [...FATAL, 'memTotalKb', ...ADVISORY, 'diskFreeGb']) {
		const d = declared[key];
		const o = probed[key] === '' || probed[key] === undefined ? null : probed[key];
		let same = d === null || o === null ? null : String(d) === String(o);
		if (same === false && key === 'memTotalKb') {
			const drift = Math.abs(Number(d) - Number(o)) / Math.max(Number(d), Number(o));
			if (Number.isFinite(drift) && drift <= MEM_TOLERANCE) same = true;
		}
		const verdict =
			o === null ? 'not probed' : same === null ? 'unmeasured' : same ? 'ok' : 'DIFFERS';
		log(
			`  ${key.padEnd(14)} ${String(d ?? '—').padEnd(12)} ${String(o ?? '—').padEnd(12)} ${verdict}`
		);
		if (same === false && HARDWARE_CHANGED.includes(key)) {
			// The box as it is NOW is the measurement: every derived field
			// (memTotalMb, ramGb) is built from `declared`, so it takes the probe.
			const now = Number.isFinite(Number(o)) ? Number(o) : o;
			declared[key] = now;
			hardwareChanges.push({
				field: key,
				from: d,
				to: now,
				reason: HARDWARE_REASON,
				at: new Date().toISOString(),
			});
			warn(
				`${key} changed: ${d} -> ${o}, accepted as a known hardware change (${HARDWARE_REASON})`
			);
		} else if (same === false) {
			if (FATAL.includes(key) || key === 'memTotalKb')
				conflicts.push({ key, declared: d, observed: o });
			// diskFreeGb is EXPECTED to differ — it is silently refreshed below.
			// Warning on it every single run is how a warning stops being read,
			// which would cost the kernel advisory beside it its only reader.
			else if (ADVISORY.includes(key)) notes.push({ key, declared: d, observed: o });
		}
	}
	if (conflicts.length) {
		die(
			`the record and this host disagree on ${conflicts.map((c) => c.key).join(', ')}.\n` +
				conflicts
					.map((c) => `    ${c.key}: record says ${c.declared}, ${NODE} reports ${c.observed}`)
					.join('\n') +
				`\n  These cannot change between bootstrap and enroll. Either the capture came ` +
				`from a different machine, or ${NODE} is not the box that was bootstrapped. ` +
				`Enrolling would declare the wrong hardware under this name.`,
			{ conflicts }
		);
	}
	for (const n of notes) {
		warn(`${n.key} changed since bootstrap: ${n.declared} -> ${n.observed} (advisory)`);
	}
}

/**
 * Add a node to ~/.ssh/config, in a block this tool owns.
 *
 * WHY ENROLMENT DOES THIS. Nothing in the fleet can reach a node it cannot
 * name: `fleet provision --machine claw-8` resolves through ssh like everything
 * else, so the entry is a PREREQUISITE for every step after enrolment and was
 * the one hand-edit with no command behind it.
 *
 * WHY IT IS SO CAUTIOUS. ~/.ssh/config is the operator's file, shared with every
 * other tool on this host, and it is the file that — edited wrongly — locks you
 * out of the fleet. So: it never rewrites, only appends; it writes a DELIMITED
 * block naming this node so removal is unambiguous; it backs the file up first;
 * and it does nothing at all if ssh can already resolve the name, because an
 * existing entry is an operator's decision and not drift to correct.
 *
 * THE ENTRY IS SELF-CONTAINED. The fleet's existing block lists node names
 * explicitly (`Host claw1 claw-1 claw2 ...`), and appending a name to that line
 * means REWRITING a line the operator wrote. Carrying User/IdentityFile in the
 * new block instead costs four lines and touches nothing that already works.
 * The values are read from `ssh -G` against an existing claw rather than
 * invented — the same derivation refresh-preseed.sh uses for the fleet key.
 *
 * IT PREFERS A NAME, AND IT PROVES THE NAME FIRST (issue #8). Every `HostName`
 * in this file is a LAN IP, which is a DHCP lease: the 2026-09-07 SSID rename
 * moved claw-3's and the fleet read a live node as permanently unreachable from
 * six scripts at once. `sshTarget` already refuses to hand an IP to `ssh`; this
 * is the only code in the repo that WRITES one, so the rule had no reach until
 * here. The candidates and the decision live in `node-interfaces.mjs`; this
 * function supplies the one thing a pure function cannot, which is whether the
 * name actually opens a session.
 *
 * A NAME THAT MERELY RESOLVES IS NOT GOOD ENOUGH, and that is not caution for
 * its own sake: on this fleet today the tailnet name resolves for all eight
 * claws and then HANGS, because `tailscale up --ssh` (run by this very script,
 * below) puts tailscaled in front of port 22 and the tailnet's ACL answers
 * `check` with a browser login. Writing that name would strand the node.
 */
function probeSshName(name, user, identity) {
	try {
		execFileSync(
			'ssh',
			[
				'-o',
				'BatchMode=yes',
				'-o',
				'ConnectTimeout=5',
				'-o',
				'StrictHostKeyChecking=accept-new',
				'-o',
				'IdentitiesOnly=yes',
				'-i',
				identity,
				'-l',
				user,
				name,
				'true',
			],
			// A HARD TIMEOUT ON TOP OF ConnectTimeout, because the failure this
			// probe exists to catch is not a refused connection — it is a session
			// that opens, prints a login URL and then sits there. ConnectTimeout
			// covers the TCP handshake only and would never fire on it.
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }
		);
		return { name, reachable: true, reason: 'answered ssh' };
	} catch (err) {
		const why =
			err?.signal === 'SIGTERM'
				? 'the session opened but never returned within 15s — an interception (Tailscale SSH check-mode looks exactly like this), not a refusal'
				: (String(err?.stderr || err?.message || '')
						.split('\n')
						.map((l) => l.trim())
						.find((l) => l && !l.startsWith('Warning: Permanently added')) ??
					'ssh failed with no message');
		return { name, reachable: false, reason: why.slice(0, 160) };
	}
}

function writeSshConfig(node, address) {
	const cfg = `${process.env.HOME}/.ssh/config`;
	if (!address) return { state: 'no-address' };
	// ALREADY RESOLVABLE IS NOT DRIFT. If the operator has an entry, it wins.
	try {
		const g = execFileSync('ssh', ['-G', node], { encoding: 'utf8' });
		const host = /^hostname (.+)$/m.exec(g)?.[1]?.trim();
		if (host && host !== node) return { state: 'already', hostname: host };
	} catch {
		/* no config at all is fine — fall through and write one */
	}
	let existing = '';
	try {
		existing = readFileSync(cfg, 'utf8');
	} catch {
		/* creating it is fine */
	}
	if (existing.includes(`# >>> fleet enroll: ${node}`)) return { state: 'already' };

	// Derived from a node that already works, never invented.
	let user = DEFAULT_ADMIN_USER;
	let identity = '~/.ssh/id_ed25519_hokon';
	try {
		const g = execFileSync('ssh', ['-G', 'claw-1'], { encoding: 'utf8' });
		user = /^user (.+)$/m.exec(g)?.[1]?.trim() || user;
		identity = /^identityfile (.+)$/m.exec(g)?.[1]?.trim() || identity;
	} catch {
		/* keep the defaults */
	}

	// NAME FIRST, AND ONLY ON PROOF. Each candidate costs at most 15s and only on
	// the one run per box that enrols it.
	const probes = sshNameCandidates(node).map((c) => probeSshName(c.name, user, identity));
	const choice = chooseSshHostName({ node, address, probes });

	const short = node.replace('-', '');
	const settings = [
		`    User ${user}`,
		`    IdentityFile ${identity}`,
		'    IdentitiesOnly yes',
		'    StrictHostKeyChecking accept-new',
	];
	const block = [
		'',
		`# >>> fleet enroll: ${node} >>>`,
		`# Written by \`fleet enroll ${node} --write\`. Remove this whole block to undo.`,
		`# HostName: ${choice.why}`,
		`Host ${short} ${node}`,
		`    HostName ${choice.hostName}`,
		...settings,
		// THE ADDRESS IS KEPT EITHER WAY, and when the primary is a name it is kept
		// as a REACHABLE alias rather than as a comment. A name that stops resolving
		// should cost `ssh claw-N-lan` and not a garage trip, and an address that is
		// only written down in prose is an address nobody can use at 3am.
		...(choice.kind === 'name'
			? [
					`# The lease ${node} answered on at enrolment, kept so a name that stops`,
					'# resolving is a second try rather than a lost node.',
					`Host ${short}-lan ${node}-lan`,
					`    HostName ${address}`,
					...settings,
				]
			: []),
		`# <<< fleet enroll: ${node} <<<`,
		'',
	].join('\n');

	if (existing) copyFileSync(cfg, `${cfg}.bak-fleet-enroll`);
	writeFileSync(cfg, existing + block, { mode: 0o600 });
	return {
		state: 'written',
		address,
		hostName: choice.hostName,
		kind: choice.kind,
		pinnedToLease: choice.pinnedToLease,
		why: choice.why,
		rejected: choice.rejected,
		backup: existing ? `${cfg}.bak-fleet-enroll` : null,
	};
}

/** One renderer, used by both the proposal and the post-write summary. */
function printAddressing(ad, node) {
	if (!ad) return;
	if (ad.state === 'error') {
		warn(`could not read ${node}'s interfaces: ${ad.error}`);
		return;
	}
	const r = ad.reservation;
	log('');
	log(`  addressing: ssh resolves ${node} to ${ad.sshResolvesTo ?? '<unresolved>'}`);
	if (r) {
		log(`  wireless:   ${r.iface}  ${r.mac}  ${r.ip ?? '<no address>'}`);
		if (ad.finding) {
			warn(ad.finding);
			log(`  Reserve ${r.mac} on the gateway and point ssh at it, or this node is`);
			log(`  reachable only while its cable is in.`);
		} else {
			log(`  the fleet addresses this node on the link that survives a cable pull.`);
		}
	}
	// THE RESERVATION IS A REQUIRED STEP, NOT ADVICE (#65). Printed for every
	// node, wired-only included — the branch above says nothing about a box with
	// no radio, and that silence is how a step gets skipped. `fleet preflight`
	// fails nightly on a node with no `lan` record, so skipping it pages.
	const lan = proposeLanRecord(ad.interfaces ?? [], ad.sshResolvesTo);
	if (lan) {
		log('');
		log(`  NEXT (required): reserve ${lan.mac} -> ${lan.ip} on the gateway`);
		log(`  (Advanced -> DHCP Reservation; delete any Auto row for that MAC first), then`);
		log(`    fleet lan-reserve --machine ${node} --write`);
		log(`  \`fleet preflight\` fails every night until it is recorded.`);
	}
}

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

// ── 4. the proposal ─────────────────────────────────────────────────────────
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
	/**
	 * THE ADDRESSING FACTS, READ OFF THE NODE — so nobody has to transcribe a MAC.
	 *
	 * hokon reaches every claw by a hardcoded LAN IP in ~/.ssh/config. Ethernet and
	 * wireless are different MACs drawing different DHCP leases, so a dual-homed
	 * node that is addressed on its WIRED lease goes dark the moment its cable comes
	 * out — and this codebase reports an unreachable node as a FAILURE, correctly,
	 * across every gate at once.
	 *
	 * claw-3 is the worked example of the answer: its stable .203 lives on the
	 * WIRELESS interface with its USB ethernet secondary, so the address is
	 * identical whether or not a cable is in. Nothing fails over because nothing
	 * moves.
	 *
	 * This step used to be a line in a runbook telling the operator to copy
	 * `wirelessMac` out of the enrolment record and go type it into a router. That
	 * is a lookup a program can do, and a lookup a human does once per box is a
	 * lookup that eventually gets skipped. So enrolment reads it.
	 *
	 * IT REPORTS, IT DOES NOT REWRITE ~/.ssh/config. That file is the operator's,
	 * shared with every other tool on this host, and enrolment is already the one
	 * place in this system where a node speaks — widening it into "and it edits your
	 * ssh config" is a second inversion for no gain. What it does is make the
	 * mismatch impossible to miss.
	 *
	 * Nothing here fails the enrolment: the manifest is written and verified above.
	 */
	if (NODE) {
		try {
			const out = sshCapture(NODE, INTERFACE_PROBE);
			const ifaces = parseInterfaces(out);
			// `ssh -G` rather than parsing the config: it is the same resolver ssh
			// itself uses, so it accounts for wildcards, Match blocks and Include.
			let resolved = null;
			try {
				resolved = execFileSync('ssh', ['-G', NODE], { encoding: 'utf8' })
					.split('\n')
					.find((l) => l.startsWith('hostname '))
					?.slice('hostname '.length)
					.trim();
			} catch {
				resolved = null;
			}
			const radio = preferredAddress(ifaces);
			result.addressing = {
				interfaces: ifaces,
				sshResolvesTo: resolved ?? null,
				lan: proposeLanRecord(ifaces, resolved ?? null),
			};

			// A RADIO WITH NO ADDRESS IS NOT "FINE". The first version only raised a
			// finding when the wireless IP DIFFERED from the resolved one, so a radio
			// with a null IP fell through to the reassuring branch — and claw-7's
			// enrolment duly printed "the fleet addresses this node on the link that
			// survives a cable pull" about a node whose radio could not associate at
			// all and whose .91 is its WIRED lease. "Could not look" rendering as
			// "nothing is wrong", inside the step written to prevent it.
			if (radio && !radio.ipv4) {
				result.addressing.finding =
					`${NODE} has a wireless interface (${radio.name}) with NO address, so it is ` +
					`reachable ONLY while its cable is in. ssh resolves it to ${resolved ?? '<unresolved>'}, ` +
					'which is its wired lease.';
				result.addressing.reservation = { mac: radio.mac, ip: null, iface: radio.name };
			} else if (radio && resolved && radio.ipv4 && resolved !== radio.ipv4) {
				// The one finding worth making loud. A node addressed on a link that
				// disappears is a node every gate loses at once.
				result.addressing.finding =
					`ssh resolves ${NODE} to ${resolved}, which is not its wireless address ` +
					`${radio.ipv4}. If this box is ever unplugged, the fleet loses it.`;
				result.addressing.reservation = { mac: radio.mac, ip: radio.ipv4, iface: radio.name };
			} else if (radio) {
				result.addressing.reservation = { mac: radio.mac, ip: radio.ipv4, iface: radio.name };
			}
		} catch (err) {
			// "Could not look" is not "nothing is wrong" — it is recorded as its own
			// state rather than left absent, which would read as a node with no
			// interfaces.
			result.addressing = { state: 'error', error: err.message.slice(0, 200) };
		}
	}

	// Printed HERE, where it is computed. Three paths leave this script -- already
	// declared, nothing written, and a successful write -- and calling the printer
	// at each is three places to forget one, which is how it came to be printed on
	// only the last of them.
	printAddressing(result.addressing, name);

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

// ── 5. commit, only when told ───────────────────────────────────────────────
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

// `manifestEdit` (scripts/lib/manifest-edit.mjs, wave 5c F4) owns asking
// `writeTarget` BEFORE anything is written — the refusal this most needs to
// make is the deploy tree, where the write SUCCEEDS, reads back true, and is
// erased at the next publish — plus the fresh read, the atomic write, the
// read-back comparison and `landWrite`. This closure only decides what the
// entry should become.
const editResult = await manifestEdit(
	(freshDoc) => {
		freshDoc.machines ??= {};
		// A FRESH TRUTH, not the copy read at the top of this script's preview:
		// `manifestEdit` always re-reads right before mutating, closing the
		// window between this script printing its proposal (which may have
		// walked the node over ssh) and actually writing it.
		const exists = Object.prototype.hasOwnProperty.call(freshDoc.machines, name);
		// A hardware change is history: every accepted one is kept, newest last,
		// and rides in $measured so the surgical assignment below stays one line.
		const priorChanges = freshDoc.machines[name]?.$measured?.hardwareChanges ?? [];
		if (priorChanges.length || hardwareChanges.length)
			measured.$measured.hardwareChanges = [...priorChanges, ...hardwareChanges];
		if (exists) {
			// SURGICAL, AND THAT NOW COVERS THE OTHER SUPPLY FACETS TOO.
			//
			// `machines[node]` carries four independently provenanced `{at, by, ...}`
			// siblings — `$measured` (here), `$benchmark` (`fleet benchmark --write`),
			// `$capabilities` (`fleet bootcamp --write`) and `$health` (`fleet doctor
			// --write`, added 2026-09-10). This branch assigns THREE NAMED FIELDS rather
			// than replacing the entry, so each of the other three facets survives a
			// re-enroll untouched: a `--update` run re-measures cores and RAM and has
			// nothing to say about whether the box is hot, what it has proved, or how
			// fast it is. Replacing the entry here would silently delete a thermal and
			// SMART record nothing else can reconstruct — `fleet doctor` would have to
			// load the box for another minute to get it back, and until it did the
			// inventory page would show a node with no health at all, which reads as
			// "nothing is wrong" for the exact reason CLAUDE.md forbids.
			//
			// Pinned by `doctor-write.test.mjs`'s source guard, so a later rewrite of
			// this branch into a spread cannot quietly drop a facet.
			const current = freshDoc.machines[name];
			current.cores = measured.cores;
			current.ramGb = measured.ramGb;
			current.$measured = measured.$measured;
		} else {
			freshDoc.machines[name] = measured;
		}
		// `--write`/`--update` always has something to record: the measurement
		// itself, even when every value is unchanged from last time.
		return true;
	},
	{
		target: MANIFEST,
		writer: 'enroll',
		reason: `${exists ? 'refresh' : 'declare'} ${name}`,
		push: !NO_PUSH,
	}
);

if ('ok' in editResult && editResult.ok === false) {
	die(editResult.why, { refusal: editResult.reason });
}
if (editResult.formatter === null) {
	warn(
		`the manifest was written UNFORMATTED: no prettier could be resolved from ` +
			`${MANIFEST}'s own tree, so this is plain JSON.stringify output. The entry is ` +
			`correct and saved; the owning repo's format:check will very likely reject the ` +
			`file until it is run through prettier there.`
	);
}

// AND NOW MAKE IT SURVIVE. A declaration that is not on main is a declaration
// the deployed fleet cannot see, and every step this command tells the operator
// to run next resolves the node through that file.
const landed = editResult.landed;
result.landed = landed;
if (!landed.ok) {
	warn(`the manifest entry for ${name} is NOT on main — ${landed.why}`);
} else {
	log(landingLine(landed, { writer: 'enroll' }));
}

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

/**
 * Put the node on the tailnet, TAGGED, and hand the operator the login URL.
 *
 * node-bootstrap.sh installs tailscale and then says "NOT authenticated. Run:
 * sudo tailscale up --ssh", leaving a manual step in the middle of an otherwise
 * automated onboarding. There is no reason it has to be manual: everything up
 * to the click is mechanical, and the click is the only part a machine cannot
 * do.
 *
 * THREE THINGS HERE ARE LOAD-BEARING.
 *
 * 1. `--advertise-tags=tag:claw` is the POINT, not a nicety. A tagged device is
 *    owned by the tailnet rather than by a person, which DISABLES node key
 *    expiry — it reads `expiry=NEVER` instead of the 180-day default. All four
 *    nodes were enrolled user-owned and therefore expired together: claw-1
 *    lapsed silently on 2026-08-31 and claw-2 was two days behind it. Without
 *    the tag this step just schedules the same outage for six months out.
 *
 * 2. IT MUST RUN OVER LAN, never over the tailnet. `tailscale up` tears the
 *    session down BEFORE auth completes, so running it through the tailnet
 *    kills the connection carrying it. This runs over whatever `ssh <node>`
 *    resolves to, which is the LAN address for every claw — see
 *    docs/planning/ for why LAN is the fleet's real control path.
 *
 * 3. `tailscaled` may not be running at all. claw-4 reported "failed to connect
 *    to local tailscaled" rather than "logged out" on 2026-09-02, because
 *    bootstrap installs the package without enabling the unit. Enabling first
 *    costs nothing when it is already up.
 *
 * Detached with nohup so the daemon keeps waiting for the click after this
 * process exits. Nothing here fails the enrolment: the manifest is already
 * written and verified above, and a node that is not yet on the tailnet is a
 * node the operator can still reach over LAN.
 */
if (NODE) {
	try {
		const out = sshCapture(
			NODE,
			'if ! command -v tailscale >/dev/null 2>&1; then echo "TS_ABSENT"; exit 0; fi; ' +
				'sudo -n systemctl enable --now tailscaled >/dev/null 2>&1; ' +
				'st=$(tailscale status --json 2>/dev/null | ' +
				`python3 -c 'import json,sys;print(json.load(sys.stdin).get("BackendState","?"))' ` +
				'2>/dev/null || echo Unknown); ' +
				'if [ "$st" = "Running" ]; then echo "TS_UP"; exit 0; fi; ' +
				`nohup sudo -n tailscale up --ssh --advertise-tags=tag:claw --hostname=${name} ` +
				'>/tmp/fleet-enroll-tsup.log 2>&1 & sleep 8; cat /tmp/fleet-enroll-tsup.log'
		);
		const url = /https:\/\/login\.tailscale\.com\/[^\s]+/.exec(out)?.[0] ?? null;
		if (/TS_ABSENT/.test(out)) result.tailscale = { state: 'not-installed' };
		else if (/TS_UP/.test(out)) result.tailscale = { state: 'already-on-tailnet' };
		else if (url) result.tailscale = { state: 'awaiting-login', url };
		else result.tailscale = { state: 'unknown', output: out.trim().slice(0, 400) };
	} catch (err) {
		// Never fatal. See the header: the manifest write already succeeded.
		result.tailscale = { state: 'error', error: err.message.slice(0, 200) };
	}
}
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
