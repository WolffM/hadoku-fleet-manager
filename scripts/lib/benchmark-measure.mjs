import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { isLocalNode, scriptExecCommand } from './fleet-exec.mjs';
import { parse } from './benchmark-inventory.mjs';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(HERE, 'benchmark-node.sh');

/**
 * MEASURE ONE NODE, RETURNING A RESULT RATHER THAN EXITING OR MUTATING AN
 * OUTER ARRAY — the one piece of this file with a real transport (ssh, local
 * sudo, a capture file), extracted so BOTH the multi-node `--due`/`--write`
 * loop and the single-node `--cadence` path call the exact same ssh/sudo
 * fallback chain rather than keeping two copies to drift.
 *
 * `{ ok: true, record }` on success. On failure, `{ ok: false, reason }`, with
 * `aborted: true` when the node declined on purpose (busy, builder busy) —
 * the caller treats that differently from a real failure — and `fatal: true`
 * only for `--from`, where a wrong-host or aborted capture has no "next node"
 * to fall through to and the ORIGINAL behaviour was to exit(2) immediately.
 *
 * `timeoutMs` (default 420_000, the original hard-coded figure) bounds EACH
 * ssh/sudo attempt below — up to two may run (a privileged try, then an
 * unprivileged retry), so the worst case is roughly double this. `--cadence`
 * passes `CADENCE_MEASURE_TIMEOUT_MS`, well under the default, because it
 * runs inside a bounded cron rather than a by-hand `--write`.
 *
 * @returns {{ok:true, record:object} | {ok:false, reason:string, aborted?:boolean, fatal?:boolean}}
 */
export function measureOneNode(
	node,
	{ from = null, jsonOut = false, passthru = [], timeoutMs = 420_000 } = {}
) {
	if (from) {
		// A CAPTURE MUST PROVE IT IS THE BOX IT IS BEING FILED UNDER. The record
		// carries its own hostname; without checking it, a stale file or a
		// copy-paste from another node writes one machine's numbers into
		// another's row, and every comparison built on this file is then wrong
		// in a way nothing can see.
		const r = parse(readFileSync(from, 'utf8'));
		if (r.hostname && !isLocalNode(node, r.hostname) && r.hostname !== node) {
			return {
				ok: false,
				fatal: true,
				reason: `${from} was captured on '${r.hostname}', not '${node}'`,
			};
		}
		if (r.aborted) {
			return { ok: false, fatal: true, reason: `that capture aborted — ${r.aborted}` };
		}
		if (!jsonOut) process.stderr.write(`  ${node} ... ingested from ${from}\n`);
		return { ok: true, record: r };
	}
	if (!jsonOut) process.stderr.write(`  benchmarking ${node} ... `);
	try {
		// THE LOCAL HOST CANNOT BE REACHED BY SSH, AND THAT IS WHY hokon HAD NO
		// ROW. mgmt-api runs on hokon and hokon refuses ssh to itself, so this
		// loop's one transport failed for it on every run since the script was
		// written — `ssh hokon` is "Connection refused", which lands in the
		// generic catch below and prints as a FAILED node. The result was not a
		// visible gap but an invisible one: the production host, the box every
		// other node is compared against, was structurally unmeasurable while
		// the table it is missing from renders perfectly.
		//
		// This is the same trap as the fast loop reading hokon as permanently
		// saturated. `isLocalNode` is the one place that question is asked —
		// see src/lib/node-identity.ts and the guard test beside it.
		//
		// LOCALLY, sudo MUST BE `-n`. The ssh path can afford bare `sudo` because
		// the claws are provisioned NOPASSWD; hokon is not, and an interactive
		// sudo under BatchMode does not prompt — it hangs or dies. `-n` fails
		// fast instead, and benchmark-node.sh already degrades correctly without
		// root: every field that needs it (dmidecode's memory type and speed,
		// smartctl's health) is emitted as `unk` WITH THE REASON, which is the
		// difference between a measured gap and a silent one.
		const local = isLocalNode(node);
		// Only the LOCAL branch below still builds its own argv — it is appended
		// after 'sudo'/'sudo -n', which scriptExecCommand has no shape for (F5
		// does not touch the local privilege chain, which never spawned a raw
		// ssh/rsync and so was never debt). The REMOTE branch builds its ssh
		// tuple inline below, through scriptExecCommand.
		const argv = local ? ['sh', '-s', '--', ...passthru] : null;
		const spawn = (cmd, a) =>
			execFileSync(cmd, a, {
				input: readFileSync(SCRIPT),
				encoding: 'utf8',
				timeout: timeoutMs,
				maxBuffer: 8 << 20,
			});
		let out;
		if (local) {
			try {
				out = spawn('sudo', ['-n', ...argv]);
			} catch {
				// -n failed, so this host is not NOPASSWD. An OPERATOR at a
				// terminal can simply type the password, and on hokon they must:
				// / /home /var and /srv are one LVM device, none of them
				// user-writable, so the dd test has no unprivileged path at all
				// and the disk row is blank without root.
				//
				// sudo reads the password from /dev/tty, not stdin, so the script
				// on stdin does not conflict with the prompt — but the prompt
				// itself must reach the terminal, hence stderr: 'inherit'.
				let prompted = false;
				if (!jsonOut && process.stderr.isTTY) {
					try {
						process.stderr.write('\n    (needs root for the disk test) ');
						out = execFileSync('sudo', argv, {
							input: readFileSync(SCRIPT),
							encoding: 'utf8',
							timeout: timeoutMs,
							maxBuffer: 8 << 20,
							stdio: ['pipe', 'pipe', 'inherit'],
						});
						prompted = true;
					} catch {
						// Declined or wrong password — fall through, do not fail.
					}
				}
				if (!prompted) {
					// Unattended, or the operator declined. Measure what does not
					// need root rather than leaving the production host blank.
					if (!jsonOut) process.stderr.write('(unprivileged) ');
					out = spawn('bash', ['-s', '--', ...passthru]);
				}
			}
		} else {
			// F5: one node-exec helper, not a hand-rolled ['ssh', [...]] tuple —
			// see scripts/lib/fleet-exec.mjs's scriptExecCommand, built for this
			// exact caller (sudo + a non-bash interpreter + passthru args).
			try {
				const [sshCmd, sshArgv] = scriptExecCommand(node, 'admin', {
					connectTimeout: 8,
					interpreter: 'sh',
					sudo: true,
					passthru,
				});
				out = spawn(sshCmd, sshArgv);
			} catch (err) {
				// A BOX THAT IS NOT IN THE FLEET YET HAS NO NOPASSWD SUDO. The
				// claws are provisioned with it; a candidate machine is not, so
				// `ssh host sudo sh -s` fails outright and the whole scan reads
				// as an unreachable node. Retry unprivileged rather than report
				// nothing: benchmark-node.sh already marks every root-only field
				// as unk WITH its reason, which is the honest degraded answer.
				const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString?.();
				if (stdout && stdout.includes('BENCH-BEGIN')) throw err;
				if (!jsonOut) process.stderr.write('(unprivileged) ');
				const [sshCmd, sshArgv] = scriptExecCommand(node, 'admin', {
					connectTimeout: 8,
					interpreter: 'sh',
					sudo: false,
					passthru,
				});
				out = spawn(sshCmd, sshArgv);
			}
		}
		const r = parse(out);
		if (r.aborted) {
			// NOT marked `aborted: true` — benchmark-node.sh always exits 2 on an
			// abort, so execFileSync always THROWS for this case and the catch
			// block below is where a real abort is actually detected. This branch
			// is defensive only; kept to match the pre-extraction behaviour
			// exactly rather than claim a certainty about every future shell.
			if (!jsonOut) process.stderr.write(`skipped (${r.aborted})\n`);
			return { ok: false, reason: r.aborted };
		}
		if (!jsonOut) process.stderr.write('ok\n');
		return { ok: true, record: r };
	} catch (err) {
		// A DELIBERATE REFUSAL IS NOT A FAILURE. benchmark-node.sh exits 2 when
		// the node is building, and execFileSync throws on any non-zero status —
		// so the `aborted` check above never ran and claw-2, which had correctly
		// declined to be loaded while running two jobs, was reported as
		// "FAILED — Command failed: ssh ...". That reads as an unreachable node
		// and sends someone to debug ssh.
		//
		// The script's own output is on the error object; parse it before
		// deciding what happened.
		const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString?.();
		if (stdout) {
			try {
				const r = parse(stdout);
				if (r.aborted) {
					if (!jsonOut) process.stderr.write(`skipped — ${r.aborted}\n`);
					return { ok: false, reason: r.aborted, aborted: true };
				}
			} catch {
				// Not a record at all; fall through to the generic failure below.
			}
		}
		const why = String(err.message).split('\n')[0];
		if (!jsonOut) process.stderr.write(`FAILED — ${why}\n`);
		return { ok: false, reason: why };
	}
}
