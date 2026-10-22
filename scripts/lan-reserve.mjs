#!/usr/bin/env node
/**
 * lan-reserve — record that a node's LAN address is pinned by a gateway
 * reservation.
 *
 *   fleet lan-reserve --machine claw-10            # propose (exit 1 — nothing written)
 *   fleet lan-reserve --machine claw-10 --write    # record it in the manifest and land it
 *   fleet lan-reserve --machine claw-10 --json
 *
 * WHY THIS EXISTS (#65). hokon reaches every node by a LAN IP in
 * `~/.ssh/config`, and that IP is a DHCP lease. The gateway's "auto
 * reservation" did not hold one still: claw-1 moved .68 -> .122 with it on. On
 * 2026-10-11 every claw got a MANUAL reservation (Advanced -> DHCP Reservation
 * on the ISP gateway), and the operator's condition was that a new node can never
 * skip that step. `fleet preflight` now fails nightly on any node with no
 * `machines[node].lan` record; this command is how the record gets written.
 *
 * RUNNING `--write` IS THE DECLARATION. The reservation table sits behind the
 * gateway's admin login and nothing in the fleet holds that credential, so no
 * code can confirm the row exists. The operator makes the reservation, then
 * runs this; the record says WHAT was reserved (read off the box, never typed)
 * and WHEN. Preflight then checks every night that the box still matches it,
 * which is the half a program can do.
 *
 * WHAT IT PROPOSES: the interface holding the address ssh already reaches the
 * node on (`proposeLanRecord`). The reservation exists to keep THAT address
 * still; proposing any other would pin a lease nothing uses.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

import { machineArg, runOn } from './lib/fleet-exec.mjs';
import { manifest } from './lib/paths.mjs';
import { renderJson } from './lib/prettier-json.mjs';
import { landWrite, landingLine, refusalLine, writeTarget } from './lib/manifest-target.mjs';
import { INTERFACE_PROBE, parseInterfaces, proposeLanRecord } from './lib/node-interfaces.mjs';
import { createEmitter } from './lib/emit.mjs';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const WRITE = argv.includes('--write');
const NO_PUSH = argv.includes('--no-push');
const NODE = machineArg(argv);
const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;

function finish(result, code) {
	if (JSON_OUT) emitter.emit(result);
	process.exit(code);
}

function die(message, extra = {}) {
	if (!JSON_OUT) console.error(`lan-reserve: ${message}`);
	finish({ ok: false, node: NODE ?? null, error: message, ...extra }, 1);
}

if (!NODE) die('usage: fleet lan-reserve --machine <node> [--write] [--no-push] [--json]');

const MANIFEST = manifest('fleet-runner-manifest.json');
const doc = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (!doc.machines?.[NODE]) {
	die(`${NODE} is not in ${MANIFEST}. Enrol it first (\`fleet enroll ${NODE} --write\`).`);
}

// A GUEST IS REACHED, DELIBERATELY. The operator named the node, the probe only
// reads interface addresses, and recording hokon's reservation is the operator's
// own request (#65) — it changes nothing on the box.
const res = await runOn(NODE, INTERFACE_PROBE, {
	timeoutMs: 20_000,
	connectTimeout: 8,
	includeGuests: true,
});
if (!res.ok) die(`could not read ${NODE}'s interfaces: ${res.error ?? res.stderr.trim()}`);
const ifaces = parseInterfaces(res.stdout);

let sshResolvesTo = null;
try {
	sshResolvesTo =
		execFileSync('ssh', ['-G', NODE], { encoding: 'utf8', timeout: 5_000 })
			.split('\n')
			.find((l) => l.startsWith('hostname '))
			?.slice('hostname '.length)
			.trim() ?? null;
} catch (err) {
	die(`\`ssh -G ${NODE}\` failed, so the address the fleet uses is unknown: ${err.message}`);
}

const proposal = proposeLanRecord(ifaces, sshResolvesTo);
if (!proposal) die(`no interface on ${NODE} holds an IPv4 address — nothing to reserve.`);

const current = doc.machines[NODE].lan ?? null;
const same =
	current?.mac?.toLowerCase() === proposal.mac &&
	current?.ip === proposal.ip &&
	current?.reservedOn;

log(`${NODE}: ssh resolves to ${sshResolvesTo ?? '<unresolved>'}`);
log(`  reserve on the gateway:  ${proposal.mac}  ->  ${proposal.ip}   (${proposal.iface})`);
log(
	`  on record:               ${current ? `${current.mac}  ->  ${current.ip}  (reserved ${current.reservedOn ?? '?'})` : 'nothing'}`
);

if (same) {
	log('✓ already recorded — nothing to write');
	finish({ ok: true, node: NODE, written: false, record: current }, 0);
}

if (!WRITE) {
	log('');
	log('Make the reservation on the gateway first: Advanced -> DHCP Reservation, delete any');
	log('Auto row for that MAC, select the MAC, pick the address, Add DHCP Reservation.');
	log(`Then: fleet lan-reserve --machine ${NODE} --write`);
	finish({ ok: false, node: NODE, written: false, proposal, record: current }, 1);
}

const target = writeTarget(MANIFEST);
if (!target.ok) die(refusalLine(target, { writer: 'lan-reserve', file: MANIFEST }));

const record = {
	mac: proposal.mac,
	ip: proposal.ip,
	iface: proposal.iface,
	// The OPERATOR'S calendar day — the day the gateway row was made. toISOString
	// is UTC and recorded an evening reservation as tomorrow on its first run.
	reservedOn: new Date().toLocaleDateString('en-CA'),
};
copyFileSync(MANIFEST, `${MANIFEST}.bak`);
doc.machines[NODE].lan = record;
const rendered = await renderJson(doc, MANIFEST);
writeFileSync(MANIFEST, rendered.text);
if (!rendered.formatter) {
	log(`! written UNFORMATTED — no prettier resolved from ${MANIFEST}'s tree`);
}

let verify;
try {
	verify = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch (err) {
	copyFileSync(`${MANIFEST}.bak`, MANIFEST);
	die(`the manifest did not parse after writing (${err.message}) — restored from .bak`);
}
if (verify.machines?.[NODE]?.lan?.mac !== record.mac) {
	copyFileSync(`${MANIFEST}.bak`, MANIFEST);
	die(`${NODE}'s lan record is not in the manifest after writing — restored from .bak`);
}

const landed = landWrite(MANIFEST, {
	writer: 'lan-reserve',
	summary: `${NODE} reserved at ${record.ip}`,
	push: !NO_PUSH,
});
if (landed.ok) log(landingLine(landed, { writer: 'lan-reserve' }));
else log(`! the record for ${NODE} is NOT on main — ${landed.why}`);
finish({ ok: landed.ok, node: NODE, written: true, record, landed }, landed.ok ? 0 : 1);
