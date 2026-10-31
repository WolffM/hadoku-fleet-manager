import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { logger, storeDoctorPath } from '../host.js';
import { nodeShell } from '../node-shell.js';
import { sickNodes } from '../lib/sick-node.js';

/**
 * Where pnpm-guarded-install.sh records that it found this node's store
 * damaged. The guard is the only thing that knows, and it knows at the moment
 * the evidence exists — see scripts/ci/pnpm-guarded-install.sh.
 *
 * Read here rather than from GitHub because the damage is NODE-scoped (one
 * store, ~28 runner instances), this probe is already ssh-ing every node
 * each tick so it costs nothing, and the guard usually REPAIRS — so the job
 * passes and there is no failed run for anything to inspect. A node that
 * damaged its own store is worth retiring even when the job it damaged went
 * green.
 */
const SICK_MARKER = '$HOME/.hadoku/sick-runner';

/**
 * Repair a quarantined node and release it.
 *
 * Without this the quarantine is a capacity TRAP: a demoted node receives no
 * jobs, so the guard never runs there, so the store is never repaired and the
 * box never returns. Repair therefore cannot wait for CI to do it.
 *
 * Runs the same doctor CI runs, over the ssh transport this module already uses
 * for probing, against BOTH stores — the default one and the pinned
 * tool_cache one, since different workflows use different stores and only one of
 * them may be damaged. Clears the marker only if the doctor succeeded, so a
 * node that cannot be fixed stays retired rather than flapping.
 */
export async function repairSickNode(
	node: string,
	run: (node: string, args: string[]) => Promise<boolean> = runDoctor
): Promise<boolean> {
	const state = sickNodes.get(node);
	if (!state) return true;
	state.repairAttempts++;

	// BOTH stores. update-packages.yml uses the default one and every gate
	// workflow pins the tool_cache one, so only one of them may be damaged and
	// repairing the wrong one silently achieves nothing.
	let ok = true;
	for (const store of REPAIR_STORES) {
		if (!(await run(node, ['--store', store, '--fix', '--drop-index']))) ok = false;
	}

	if (!ok) {
		logger.warn(
			`[fleet-loop] repair FAILED on ${node} (attempt ${state.repairAttempts}) — it stays retired`
		);
		return false;
	}
	// Clear the marker ONLY after the doctor actually succeeded. Doing it in the
	// same command as the repair is how a release gets decided by whether `rm`
	// worked rather than by whether the store was fixed — a node would return
	// to service still broken. A test caught exactly that.
	if (!(await run(node, ['--clear-marker']))) {
		logger.warn(`[fleet-loop] ${node}: repaired but could not clear its marker — stays retired`);
		return false;
	}
	sickNodes.delete(node);
	logger.info(
		`[fleet-loop] RELEASED ${node} — store repaired after ${state.repairAttempts} attempt(s)`
	);
	return true;
}

const REPAIR_STORES = ['$HOME/.local/share/pnpm/store', '/opt/hostedtoolcache/pnpm-store'];

/** Injected: the store doctor is a CONTRACT WITH CI, not internal detail. */
const DOCTOR_PATH = () => storeDoctorPath();

/**
 * How to run a shell COMMAND on NODE: over ssh, or in a local shell when NODE
 * is the box this process runs on.
 *
 * mgmt-api runs on hokon and `ssh hokon` from hokon is REFUSED. Until
 * 2026-09-21 the repair always took the ssh path, so a quarantined hokon could
 * never be repaired: a marker left by an install killed mid-write on
 * 2026-09-19 kept it retired for two days while both of its stores were clean,
 * failing ~1,400 repairs with no reason logged. The probe and
 * runner-supervision already special-cased the local node; this was the one
 * path that did not.
 *
 * LOCAL GOES THROUGH `bash -c`, not a bare `spawn('bash', args)`. The command
 * carries `$HOME/...` store paths that the REMOTE shell expands on the ssh path;
 * a bare spawn would hand the doctor a literal `$HOME` and fail the same silent
 * way. One command string, expanded by a shell on either side.
 */
export function doctorCommand(node: string, command: string, self?: string): [string, string[]] {
	// The stores it repairs are CI's: they live under the ci user's home.
	return nodeShell(node, 'ci', command, self);
}

/**
 * Run the doctor on NODE by PIPING THE SCRIPT OVER STDIN.
 *
 * Not by invoking a path on the far side: the claws have no canonical checkout
 * (the repo lives under a per-runner `_work` tree that may not exist), and a
 * missing path made `bash …/doctor.sh` fail while the command as a whole still
 * exited 0 — so a still-sick node was released. Piping it also means the
 * remote runs the SAME doctor CI runs, with no second copy to drift.
 *
 * A failure is LOGGED WITH ITS REASON — exit code and the tail of stderr. The
 * hokon outage above was invisible for two days because this said only
 * "repair FAILED", and the reason ("Connection refused") was discarded.
 */
export function runDoctor(
	node: string,
	args: string[],
	opts: { self?: string; script?: string } = {}
): Promise<boolean> {
	let script = '';
	if (args[0] !== '--clear-marker') {
		try {
			script = opts.script ?? readFileSync(DOCTOR_PATH(), 'utf8');
		} catch {
			logger.warn(`[fleet-loop] cannot read ${DOCTOR_PATH()} — repair unavailable`);
			return Promise.resolve(false);
		}
	}
	const command =
		args[0] === '--clear-marker' ? `rm -f "${SICK_MARKER}"` : ['bash -s --', ...args].join(' ');
	const [cmd, cmdArgs] = doctorCommand(node, command, opts.self);
	return new Promise((res) => {
		const child = spawn(cmd, cmdArgs, {
			timeout: REPAIR_TIMEOUT_MS,
			stdio: ['pipe', 'ignore', 'pipe'],
		});
		let stderr = '';
		child.stderr.on('data', (d: Buffer) => {
			stderr = (stderr + d.toString()).slice(-400);
		});
		child.on('error', (err) => {
			logger.warn(`[fleet-loop] ${node}: repair could not start (${cmd}): ${err.message}`);
			res(false);
		});
		child.on('close', (code) => {
			if (code !== 0) {
				logger.warn(
					`[fleet-loop] ${node}: \`${args.join(' ')}\` exited ${code} via ${cmd}` +
						(stderr.trim() ? ` — ${stderr.trim().split('\n').pop()}` : '')
				);
			}
			res(code === 0);
		});
		/*
		 * The child's 'error' handler above does NOT cover this stream.
		 *
		 * EPIPE from writing the repair script arrives on the stdin socket, not
		 * on the ChildProcess, so it is a separate unhandled 'error' event —
		 * and this function runs IN-PROCESS inside mgmt-api, where an uncaught
		 * exception is not a failed repair but a dead API. The window is real:
		 * ssh exits the instant it cannot open the connection, which is exactly
		 * the case this repair path exists to handle.
		 */
		child.stdin.on('error', (err) => {
			logger.warn(`[fleet-loop] ${node}: repair script not delivered: ${err.message}`);
		});
		child.stdin.end(script);
	});
}

const REPAIR_TIMEOUT_MS = 120_000;
