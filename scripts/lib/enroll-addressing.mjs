/**
 * `fleet enroll`'s addressing facts — split out of scripts/enroll-node.mjs
 * (wave 5p lane D) so the CLI stays under the 800-line ceiling. Takes the
 * CLI's flags and helpers (`log`/`warn`) through `ctx`; never imports the
 * CLI.
 */
import { execFileSync } from 'node:child_process';
import { sshCapture } from './enroll-ssh.mjs';
import {
	INTERFACE_PROBE,
	parseInterfaces,
	preferredAddress,
	proposeLanRecord,
} from './node-interfaces.mjs';

/** One renderer, used by both the proposal and the post-write summary. */
export function printAddressing(ctx, ad, node) {
	const { log, warn } = ctx;
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
export function probeAddressing(node) {
	const result = {};
	try {
		const out = sshCapture(node, INTERFACE_PROBE);
		const ifaces = parseInterfaces(out);
		// `ssh -G` rather than parsing the config: it is the same resolver ssh
		// itself uses, so it accounts for wildcards, Match blocks and Include.
		let resolved = null;
		try {
			resolved = execFileSync('ssh', ['-G', node], { encoding: 'utf8' })
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
				`${node} has a wireless interface (${radio.name}) with NO address, so it is ` +
				`reachable ONLY while its cable is in. ssh resolves it to ${resolved ?? '<unresolved>'}, ` +
				'which is its wired lease.';
			result.addressing.reservation = { mac: radio.mac, ip: null, iface: radio.name };
		} else if (radio && resolved && radio.ipv4 && resolved !== radio.ipv4) {
			// The one finding worth making loud. A node addressed on a link that
			// disappears is a node every gate loses at once.
			result.addressing.finding =
				`ssh resolves ${node} to ${resolved}, which is not its wireless address ` +
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
	return result.addressing;
}
