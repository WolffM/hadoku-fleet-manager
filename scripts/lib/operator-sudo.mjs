/**
 * Root on a node the fleet has no sudo on — the backstop.
 *
 * Operator, 2026-10-31: "hokon is the exception, so i guess i need to do that
 * one manual to upgrade. NOPASSWD sudo is okay on the claws." The fleet drains
 * the backstop, probes it and installs on it as its own user; the part of a
 * repair that needs root is NOT attempted there. It is reported as an ADVISORY
 * naming the command the operator runs by hand, never as drift the fleet will
 * repair, and it never fails a run by itself.
 *
 * `--operator-sudo` is that hand-run: the operator, on the box, with a sudo
 * ticket from `sudo -v`, tells the command its `sudo -n` calls will succeed.
 * It is the only way past {@link maySudo}, and it is typed every time.
 */
import process from 'node:process';

import { fleetHasSudo } from '../../dist/lib/node-role.js';

export const OPERATOR_SUDO = '--operator-sudo';

/** May this run use sudo on this node? The fleet's own answer, or the operator's flag. */
export function maySudo(node, argv = process.argv.slice(2)) {
	return fleetHasSudo(node) || argv.includes(OPERATOR_SUDO);
}

/**
 * The advisory for root work withheld on `name`. `command` is the fleet
 * command that does the work, WITHOUT the sudo flag: the fix line adds the
 * `sudo -v` and the flag, so every advisory names the same hand-run.
 *
 * @returns {{node: string, kind: 'needs-root', blocking: false, message: string, fix: string}}
 */
export function rootAdvisory(name, what, command) {
	return {
		node: name,
		kind: 'needs-root',
		blocking: false,
		message: `${what} needs root on ${name}, and the fleet has no sudo there`,
		fix: `on ${name}, as the operator: sudo -v && ${command} ${OPERATOR_SUDO}`,
	};
}
