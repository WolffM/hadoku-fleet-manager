#!/usr/bin/env node
/**
 * toolpack — the INSTRUMENTS a node needs before a measurement of it is honest.
 *
 * NOT the CI toolchain. What a box can BUILD is capabilities.ts and `fleet
 * toolchain`; this is the narrower question of what must be installed before
 * `fleet benchmark` can see the machine at all. Keeping them apart is what
 * stops a second copy of the capability system growing here.
 *
 * WHICH PACK A NODE NEEDS IS DERIVED, NEVER DECLARED. Every `when` is evaluated
 * against facts read off the node itself, so a box with a radio needs `iw`
 * whether or not anyone remembered to say so, and an ethernet-only desktop does
 * not get it to satisfy a list. The fleet has been bitten by declared state
 * often enough -- labels a node had not earned, registrations no runner backed
 * -- that the observed shape has to be the input.
 *
 * PRESENCE IS PROVEN BY LOCATING THE BINARY, not by asking the package manager.
 * dpkg says what was installed; it does not say what is runnable now, and the
 * readers call these by absolute path anyway. A verifier that consults its own
 * installer's record cannot fail.
 *
 * THE `python-pip` PACK IS A NAMED EXCEPTION TO "NOT THE CI TOOLCHAIN" (P3.4).
 * `pip3` is not a benchmark instrument; it closed a real gap this file already
 * had the machinery for and a purpose-built installer would have duplicated:
 * both node profiles in manifests/node-profiles.json declare `python3-pip`, but
 * node-bootstrap only ever runs it at enrollment, so claw-1 and claw-2 drifted
 * from that declaration with no reconciler behind it. `capabilities.ts`'s
 * `python-pip` probe (§P) is the permanent guard against it drifting back; this
 * pack is what installs the binary that probe checks for, gated to `ciClaw` —
 * a `pm2-host` never runs a job that needs it.
 *
 * @guards scripts/toolpacks.json
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { PKG_SCRIPTS } from './lib/paths.mjs';
import { loadManifest, remoteCommand } from './lib/fleet-exec.mjs';
// The BUILT copy, for the same reason fleet-exec.mjs imports isLocalNode that
// way: one question, one answer, and no second implementation to drift from.
import { isGuestNode } from '../dist/lib/node-role.js';
import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { parseStrict } from './lib/argv.mjs';
import { packsRequired } from './lib/toolpack-rules.mjs';
import { keepStdoutWhole } from './lib/emit.mjs';
import { GREEN, RED, RESET, YELLOW } from './lib/term.mjs';

// STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
// and on a pipe `process.exit` throws away whatever the stream still had
// queued — measured on this host, 149,133 bytes in and 146,176 out, which
// `JSON.parse` then rejects mid-string. `keepStdoutWhole` puts fd 1 in
// blocking mode so there is nothing left to lose. Issue #33; the shared
// emitter calls the same function for the scripts that use it.
keepStdoutWhole();

const args = process.argv.slice(2);
// F8 (plan §4.1): strict, from the one spec `argv-specs.mjs` declares and the
// door reads too. `--help`/`-h` and an unknown flag are both handled before
// anything below reads the manifest or ssh's to a node.
const parsed = parseStrict(ARGV_SPECS['toolpack.mjs'], args);
const JSON_OUT = parsed.has('--json');
const CONFIRM = parsed.has('--confirm');
// F10: the raw escapes live once in scripts/lib/term.mjs; this file keeps its
// own short names (YEL/GRN/OFF) rather than renaming every `${YEL}` below.
// RED already matched the shared name, so it is imported directly above.
const YEL = YELLOW;
const GRN = GREEN;
const OFF = RESET;

// CATEGORY 1: this file SHIPS WITH THE PACKAGE, beside the script it guards.
// It is not operator config -- the list is fixed by what benchmark-node.sh
// calls, so a reader that starts shelling out to a new tool makes this stale in
// the same commit. Resolving it through FLEET_MANIFEST_DIR would let a
// deployment carry a pack list its own readers disagree with.
const PACKS = JSON.parse(readFileSync(join(PKG_SCRIPTS, 'toolpacks.json'), 'utf8')).packs;
const named = parsed.positionals;
const MANIFEST = loadManifest();
/**
 * A GUEST IS NOT SWEPT, AND THE SKIP IS PRINTED.
 *
 * With `--confirm` this runs `sudo -n apt-get install` on every node it holds. A
 * guest lends the fleet a registration and is otherwise none of the fleet
 * chain's business (operator, 2026-09-14) — installing packages on it is the
 * furthest end of that, and `converge-toolchain` was fixed for the same reason
 * in Wave 3d.
 *
 * NAMING IT REACHES IT. The node list here is POSITIONAL rather than
 * `--machine`, but the principle `guestGate` encodes is the same: an operator
 * who typed the box's name is not going to be surprised by reaching it, and
 * refusing there would leave no way to service a guest's instruments at all.
 * Only the unnamed fleet-wide sweep skips.
 */
const everyNode = named.length ? named : Object.keys(MANIFEST.machines);
const skippedByRole = named.length
	? []
	: everyNode.filter((n) => isGuestNode(MANIFEST.machines[n]));
const nodes = everyNode.filter((n) => !skippedByRole.includes(n));

/**
 * Run on the node. F5: one node-exec helper — `remoteCommand` carries the
 * local-vs-ssh branch itself (the local host cannot be reached by ssh — see
 * node-identity) instead of this file rolling its own `['ssh', [...]]` tuple.
 */
function on(node, script) {
	const [cmd, argv] = remoteCommand(node, 'admin', script, { connectTimeout: 8 });
	return execFileSync(cmd, argv, { encoding: 'utf8', timeout: 60_000 });
}

/**
 * The observed shape of a node, in one round trip.
 *
 * Deliberately the same facts benchmark-node.sh reads, gathered the same way —
 * a wireless interface is a directory in sysfs, not a guess from a hostname.
 */
function shapeOf(node) {
	const out = on(
		node,
		[
			'echo "wireless=$(ls -d /sys/class/net/*/wireless 2>/dev/null | wc -l)"',
			'echo "nvme=$(ls -d /sys/block/nvme* 2>/dev/null | wc -l)"',
			'for b in lscpu lspci curl openssl smartctl dmidecode iw ethtool pip3; do',
			'  p=""; for d in /usr/bin /bin /usr/sbin /sbin; do [ -x "$d/$b" ] && p="$d/$b" && break; done',
			'  echo "bin.$b=${p:-MISSING}"; done',
		].join('\n')
	);
	const kv = {};
	for (const line of out.split('\n')) {
		const i = line.indexOf('=');
		if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return kv;
}

const report = [];
for (const node of nodes) {
	let shape;
	try {
		shape = shapeOf(node);
	} catch (err) {
		// UNREACHABLE IS NOT COMPLIANT. A node we could not look at must never
		// read as a node with nothing missing.
		report.push({ node, error: String(err.message).split('\n')[0].slice(0, 120) });
		continue;
	}
	// `ciClaw` is a manifest fact, not a hardware one — see toolpack-rules.mjs.
	//
	// Read from the ROLE. It used to be "does not carry the `pm2-host` label",
	// which was exact only while one machine carried that label and stopped being
	// exact the day Wave 3d made `pm2-host` an EARNED capability a claw can probe
	// into: a claw that earned it would have lost the `python-pip` pack — and the
	// gap that pack exists to close — for a reason that has nothing to do with CI.
	// What the filter was standing in for is "this box is not general CI capacity",
	// and that is the role.
	const ciClaw = !isGuestNode(MANIFEST.machines[node]);
	const packs = packsRequired(PACKS, shape, ciClaw);
	const missing = [];
	for (const [name, p] of packs)
		for (const b of p.bins)
			if (shape[`bin.${b}`] === 'MISSING') missing.push({ pack: name, bin: b });
	const apt = [
		...new Set(packs.filter(([n]) => missing.some((m) => m.pack === n)).flatMap(([, p]) => p.apt)),
	];
	report.push({ node, packs: packs.map(([n]) => n), missing, apt });
}

if (CONFIRM) {
	for (const r of report) {
		if (r.error || !r.apt?.length) continue;
		if (!JSON_OUT) process.stderr.write(`  ${r.node}: installing ${r.apt.join(' ')} ... `);
		try {
			on(r.node, `sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y ${r.apt.join(' ')}`);
			// RE-READ RATHER THAN ASSUME. apt exiting 0 is not the same fact as the
			// binary being on the box, and the whole point of this file is that the
			// second one is what the readers need.
			const after = shapeOf(r.node);
			r.installed = r.missing.filter((m) => after[`bin.${m.bin}`] !== 'MISSING').map((m) => m.bin);
			r.missing = r.missing.filter((m) => after[`bin.${m.bin}`] === 'MISSING');
			if (!JSON_OUT)
				process.stderr.write(r.missing.length ? `${RED}incomplete${OFF}\n` : `${GRN}ok${OFF}\n`);
		} catch (err) {
			r.installError = String(err.message).split('\n')[0].slice(0, 160);
			if (!JSON_OUT) process.stderr.write(`${RED}failed${OFF}\n`);
		}
	}
}

const findings = report.flatMap((r) =>
	r.error
		? [`${r.node}: could not look — ${r.error}`]
		: [
				...(r.installError ? [`${r.node}: install failed — ${r.installError}`] : []),
				...r.missing.map((m) => `${r.node}: missing ${m.bin} (pack ${m.pack})`),
			]
);

if (JSON_OUT) {
	// Alongside `report` rather than inside it: `report` means "nodes this run
	// looked at", and a guest is precisely one it did not.
	console.log(
		JSON.stringify(
			{ at: new Date().toISOString(), report, findings, skippedByRole, ok: !findings.length },
			null,
			2
		)
	);
} else {
	for (const n of skippedByRole) {
		console.log(`${n.padEnd(9)} ${YEL}skipped: guest — name it explicitly to reach it${OFF}`);
	}
	for (const r of report) {
		if (r.error) {
			console.log(`${RED}${r.node.padEnd(9)} could not look — ${r.error}${OFF}`);
			continue;
		}
		const state = r.missing.length
			? `${YEL}missing ${r.missing.map((m) => m.bin).join(', ')}${OFF}`
			: `${GRN}complete${OFF}`;
		console.log(`${r.node.padEnd(9)} packs: ${r.packs.join('+').padEnd(12)} ${state}`);
	}
	if (findings.length && !CONFIRM)
		console.log(`\n${YEL}${findings.length} gap(s). Install with: fleet toolpack --confirm${OFF}`);
}

process.exit(findings.length ? 1 : 0);
