/**
 * spawner — run `execFile` from a small helper process instead of this one
 * (fleet-manager#86).
 *
 * WHY. libuv `fork()`s to spawn, and fork copies the parent's page tables, so
 * the synchronous part of every spawn grows with this process's memory.
 * Measured on hokon (`execFile('/bin/true')`, main-thread time): 1.9 ms p50
 * at 48 MB RSS, 12.5 ms at 263 MB, 17.8 ms at 510 MB, 42 ms at 1 GB. mgmt-api
 * runs the fleet loops in-process at ~550 MB and spawns ~2 a second (ssh to
 * the nodes), which was most of what still blocked its event loop after
 * 0.34.415: `spawn` 2.6 s plus `normalizeSpawnArguments` 1.7 s in a 180 s
 * profile. The environment it copies is NOT the cost: 583 variables against
 * 5 add ~0.3 ms.
 *
 * From a forked helper the same request costs this process 0.01 ms p50 (one
 * IPC message), and ~1.2 ms end to end, measured from a 515 MB parent.
 *
 * WHEN. Only once this process is big enough for a direct spawn to hurt
 * ({@link SPAWNER_MIN_RSS_MB}). Below it a direct spawn is a few ms, and a
 * short-lived CLI run should not pay a helper's start-up for one ssh.
 * `FLEET_SPAWNER=off` forces the direct path, `=on` forces the helper.
 *
 * FAILURE IS A FAILED CALL, NEVER A HANG. If the helper exits, every call it
 * held resolves `ok: false` with the reason, and the next call forks a new
 * one. Each call also carries its own deadline here, past the helper's own
 * timeout, so a helper that stops answering costs one timeout, not a stuck
 * dispatch pass. A command the dead helper had started is left to its own
 * timeouts (ssh's ConnectTimeout and ServerAlive), as it would be after an
 * mgmt-api crash.
 *
 * NEVER KEEPS A PROCESS ALIVE. The helper and its channel are ref'd only
 * while a call is pending, so a CLI that has finished exits normally.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { hostInstalled, logger } from '../host.js';
import { execFileWithInput, type ExecResult } from './spawner-exec.js';

export type { ExecResult } from './spawner-exec.js';

export interface SpawnRequest {
	id: number;
	file: string;
	args: string[];
	timeout: number;
	maxBuffer: number;
	/** Written to the command's stdin, which is then closed. */
	input?: string;
}

export interface SpawnReply {
	id: number;
	ok: boolean;
	/** The exit code; null when it never exited normally (timeout, signal, no such file). */
	code: number | null;
	stdout: string;
	stderr: string;
	/** Why it failed: a non-zero exit, a timeout, or the helper itself. */
	error?: string;
}

export interface ExecOptions {
	timeout: number;
	maxBuffer?: number;
	/** Written to the command's stdin, which is then closed. Without it stdin is closed empty. */
	input?: string;
}

/** A direct spawn below this costs under ~10 ms, not worth a second process. */
export const SPAWNER_MIN_RSS_MB = 150;

/**
 * The package exports {@link execFileOffLoop}, so a process that never called
 * `createFleetManager` may run it, and `logger` throws without a host. The
 * helper-exit warning fires from an event handler, where that throw would take
 * the caller's process down.
 */
function warn(message: string): void {
	if (hostInstalled()) logger.warn(message);
	else process.stderr.write(`${message}\n`);
}

/** Past the helper's own timeout, so the helper's answer always wins a race. */
const DEADLINE_GRACE_MS = 5_000;

const DEFAULT_MAX_BUFFER = 1024 * 1024;

let helper: ChildProcess | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (r: ExecResult) => void; timer: NodeJS.Timeout }>();
let forcedForTesting: boolean | null = null;

function settle(id: number, r: ExecResult): void {
	const p = pending.get(id);
	if (!p) return;
	pending.delete(id);
	clearTimeout(p.timer);
	p.resolve(r);
	if (!pending.size) setRef(false);
}

function setRef(on: boolean): void {
	if (!helper) return;
	const channel = helper.channel as { ref?: () => void; unref?: () => void } | undefined;
	if (on) {
		helper.ref();
		channel?.ref?.();
	} else {
		helper.unref();
		channel?.unref?.();
	}
}

function failAll(reason: string): void {
	for (const id of [...pending.keys()])
		settle(id, { ok: false, code: null, stdout: '', stderr: '', error: reason });
}

function startHelper(): ChildProcess {
	const child = fork(fileURLToPath(new URL('./spawner-child.js', import.meta.url)), [], {
		stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
		// Not the parent's flags: an inspector or a heap limit meant for mgmt-api
		// has no business in a process whose only job is execFile.
		execArgv: [],
	});
	child.on('message', (m: SpawnReply) =>
		settle(m.id, {
			ok: m.ok,
			code: m.code,
			stdout: m.stdout,
			stderr: m.stderr,
			...(m.error ? { error: m.error } : {}),
		})
	);
	const gone = (why: string) => {
		if (helper !== child) return;
		helper = null;
		if (pending.size) warn(`[spawner] helper ${why}; failing ${pending.size} call(s) it held`);
		failAll(`spawner helper ${why}`);
	};
	child.on('exit', (code, signal) => gone(`exited (${signal ?? code})`));
	child.on('error', (err) => gone(`failed: ${err.message}`));
	return child;
}

function useHelper(): boolean {
	if (forcedForTesting !== null) return forcedForTesting;
	const mode = process.env.FLEET_SPAWNER;
	if (mode === 'off') return false;
	if (mode === 'on') return true;
	return process.memoryUsage.rss() >= SPAWNER_MIN_RSS_MB * 1024 * 1024;
}

function direct(file: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> {
	return new Promise((res) =>
		execFileWithInput(
			file,
			args,
			{ timeout: opts.timeout, maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER, input: opts.input },
			res
		)
	);
}

/**
 * `execFile`, run from the helper process when this one is large. Resolves,
 * never rejects: `ok: false` with `error` for a non-zero exit, a timeout, or a
 * helper that died, the same cases a callback's `err` covered.
 */
export function execFileOffLoop(
	file: string,
	args: readonly string[],
	opts: ExecOptions
): Promise<ExecResult> {
	if (!useHelper()) return direct(file, args, opts);
	if (!helper) {
		try {
			helper = startHelper();
		} catch (err) {
			warn(
				`[spawner] could not start the helper (${err instanceof Error ? err.message : String(err)}); spawning directly`
			);
			return direct(file, args, opts);
		}
	}
	const id = ++nextId;
	const req: SpawnRequest = {
		id,
		file,
		args: [...args],
		timeout: opts.timeout,
		maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
		...(opts.input !== undefined ? { input: opts.input } : {}),
	};
	return new Promise((resolve) => {
		const timer = setTimeout(
			() =>
				settle(id, {
					ok: false,
					code: null,
					stdout: '',
					stderr: '',
					error: `spawner helper did not answer within ${opts.timeout + DEADLINE_GRACE_MS} ms`,
				}),
			opts.timeout + DEADLINE_GRACE_MS
		);
		timer.unref();
		pending.set(id, { resolve, timer });
		setRef(true);
		try {
			helper!.send(req);
		} catch (err) {
			settle(id, {
				ok: false,
				code: null,
				stdout: '',
				stderr: '',
				error: `spawner send failed: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	});
}

/** The helper's pid, or null when none is running. */
export function spawnerPid(): number | null {
	return helper?.pid ?? null;
}

export function __setSpawnerForTesting(on: boolean | null): void {
	forcedForTesting = on;
}

export function __stopSpawnerForTesting(): void {
	helper?.kill();
	helper = null;
	failAll('spawner stopped');
}
