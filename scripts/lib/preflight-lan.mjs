/**
 * preflight's LAN-RESERVATION signal — split out of `preflight.mjs` (wave 5s
 * lane D, 800-line ceiling). See that file's header for the full "FOUR
 * SIGNALS" context; this is the fifth, added later. Every function here is
 * pure, same contract as the rest of preflight: the I/O (reading interfaces,
 * `ssh -G`, the manifest's `lan` record) lives in `check-fleet-preflight.mjs`.
 *
 * Re-exported from `preflight.mjs`, so nothing outside this pair of files
 * needs to know the split happened.
 */
import { BLOCKING } from './preflight.mjs';
import { isIpv4 } from './node-interfaces.mjs';

/**
 * A node whose LAN address is not pinned by a gateway reservation, or `null`.
 *
 * WHY THIS IS A PREFLIGHT SIGNAL. hokon reaches every claw by a LAN IP in
 * `~/.ssh/config`, and that IP is a DHCP lease. The gateway's own "auto
 * reservation" is not durable: claw-1 moved .68 -> .122 between 2026-09-07 and
 * 2026-10-11 with it switched on (#65). A moved lease reads as a dead node in
 * every gate at once, and a node hosting a service is stranded until someone
 * re-enrols it. Manual reservations were set for every claw on 2026-10-11; the
 * failure left is a NEW node nobody reserved, which is why a missing record is
 * blocking rather than advisory — the operator's words were "we cannot forget".
 *
 * WHAT IT CAN AND CANNOT SEE. The reservation table is behind the gateway's
 * admin login, which nothing here holds. So the record (`machines[node].lan`,
 * written by `fleet lan-reserve --write`) is the operator's DECLARATION that the
 * reservation exists, and this reads the BOX to check the declaration still
 * describes it: the recorded MAC is present, holds the recorded IP, and ssh
 * reaches the node there. A reservation that was never made shows up as
 * `drifted` the first time the lease moves — late, but never silent.
 *
 * @param probe          `{node, ok, error?, ifaces?}` — `parseInterfaces` output.
 * @param record         `machines[node].lan`, or undefined.
 * @param sshResolvesTo  `ssh -G <node>`'s hostname, or null.
 * @param suggestion     `proposeLanRecord` over the same probe, for the fix line.
 */
export function lanReservationFinding(probe, record, sshResolvesTo, suggestion = null) {
	const node = probe.node;
	const base = { category: 'lan-reservation', node, class: BLOCKING };
	if (!probe.ok) {
		return {
			...base,
			status: 'unreachable',
			why: `${node}'s interfaces could not be read to check its LAN reservation: ${probe.error}.`,
		};
	}
	const reserveHint = suggestion
		? ` Reserve ${suggestion.mac} -> ${suggestion.ip} on the gateway (Advanced -> DHCP ` +
			`Reservation; delete any Auto row for that MAC first), then run ` +
			`\`fleet lan-reserve --machine ${node} --write\`.`
		: ' No interface on it holds an IPv4 address, so there is nothing to reserve yet.';
	if (!record?.mac || !record?.ip) {
		return {
			...base,
			status: 'unrecorded',
			why: `${node} has no gateway reservation on record (machines.${node}.lan), so its LAN address is a DHCP lease that can move.${reserveHint}`,
		};
	}
	const mac = String(record.mac).toLowerCase();
	const iface = (probe.ifaces ?? []).find((i) => i.mac?.toLowerCase() === mac);
	if (!iface) {
		return {
			...base,
			status: 'nic-missing',
			why: `${node}'s reservation names ${mac}, and no interface on the box has that MAC — the NIC was replaced or the record is wrong.${reserveHint}`,
		};
	}
	if (!iface.ipv4) {
		return {
			...base,
			status: 'no-address',
			why: `${node}'s reserved interface ${iface.name} (${mac}) holds no IPv4 address — cable out or radio down — so the node is not on its address of record ${record.ip}.`,
		};
	}
	if (iface.ipv4 !== record.ip) {
		return {
			...base,
			status: 'drifted',
			why: `${node}'s ${iface.name} (${mac}) holds ${iface.ipv4}, not its reserved ${record.ip}: the gateway reservation is missing or names another address. Fix the row on the gateway, or re-record with \`fleet lan-reserve --machine ${node} --write\` if the new address is intended.`,
		};
	}
	if (isIpv4(sshResolvesTo) && sshResolvesTo !== record.ip) {
		return {
			...base,
			status: 'ssh-mismatch',
			why: `ssh resolves ${node} to ${sshResolvesTo}, but its reserved address is ${record.ip} — the fleet is reaching it on an address nothing pins. Point its ~/.ssh/config HostName at ${record.ip}.`,
		};
	}
	return null;
}

/** {@link lanReservationFinding} over every probed node, findings only. */
export function lanReservationFindings(probes, records, resolved, suggestions = {}) {
	return probes
		.map((p) =>
			lanReservationFinding(
				p,
				records[p.node],
				resolved[p.node] ?? null,
				suggestions[p.node] ?? null
			)
		)
		.filter(Boolean);
}
