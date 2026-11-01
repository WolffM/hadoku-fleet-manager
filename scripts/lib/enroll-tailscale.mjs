/**
 * `fleet enroll`'s tailscale onboarding — split out of scripts/enroll-node.mjs
 * (wave 5p lane D) so the CLI stays under the 800-line ceiling. Takes the
 * CLI's helpers through `ctx`; never imports the CLI.
 */
import { maySudo } from './operator-sudo.mjs';
import { sshCapture } from './enroll-ssh.mjs';

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
 *
 * NOT ON A NODE THE FLEET HAS NO SUDO ON (the backstop). Its tailnet login is
 * the operator's, and it is deliberately not `tag:claw`.
 */
export function bringUpTailscale(ctx, result, { name, doc }) {
	const { NODE } = ctx;
	if (NODE && !maySudo(doc.machines?.[name])) {
		result.tailscale = { state: 'operator', why: 'the fleet has no sudo on this node' };
	} else if (NODE) {
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
}
