/**
 * EARLY WARNING: the production host is about to stall.
 *
 * Every 2 s, the host's PSI and the PSI of the cgroup this process runs in
 * (mgmt-api's: the PM2 unit on the production host, which also holds prod cardtable and
 * cloudflared). When a line is crossed on two samples in a row, one Discord
 * post (no @here: a new check warns before it pages) and a state file for
 * other readers, such as cardtable's own host-stall tripwire.
 *
 * WHY THESE LINES. Measured on hokon (2026-11-28, cardtable's four all-claw
 * heartbeat losses and this session's write storms):
 *   - 2026-11-27 04:09Z: prod cgroup io some 39-53%, host io full 54-62%.
 *   - 2026-11-27 05:32Z / 06:39Z: host io full 51-87% for minutes.
 *   - 2026-11-28 09:33Z: prod cgroup memory some 84-98%, host memory 44-98%.
 *   - an app.slice write storm under its io.max cap (harmless to prod): prod
 *     io some at most 22.9%, host io full at most 44.5%, memory under 3%.
 *   - quiet: host io some 2-6%, everything else ~0.
 * So each line sits above the worst harmless storm and below the start of
 * every real event. avg10 lags onset by ~10 s; every event above built over
 * minutes, so the post lands ahead of the claws fencing.
 *
 * "I COULD NOT LOOK" IS NOT CALM: an unreadable PSI file is reported in the
 * state file as `unreadable`, never as level `ok`.
 *
 * The state file lives on tmpfs (XDG_RUNTIME_DIR), never the root disk: the
 * one write this loop makes must not block on the disk it is warning about.
 * Every write is async, for the same reason.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logger, postDiscord } from './host.js';
import { every, type EveryHandle } from './lib/every.js';

export const PRESSURE_SAMPLE_MS = 2_000;
/** Consecutive samples over a line before it warns. */
export const PRESSURE_ENTER_SAMPLES = 2;
/** Consecutive calm samples before it clears (30 s). */
export const PRESSURE_CLEAR_SAMPLES = 15;
/** At most one post per this long while it stays (or re-enters) warn. */
export const PRESSURE_REPOST_MS = 10 * 60_000;

/** avg10 percentages. See the module header for where each comes from. */
export const PRESSURE_LINES = {
	prodIoSome: 30,
	prodMemSome: 10,
	hostIoFull: 50,
	hostMemSome: 20,
} as const;

export interface Psi {
	some10: number;
	full10: number;
}

export interface PressureSample {
	host: { io: Psi | null; mem: Psi | null };
	/** This process's own cgroup; null when it could not be read. */
	prod: { cgroup: string | null; io: Psi | null; mem: Psi | null };
}

export interface PressureState {
	level: 'ok' | 'warn';
	over: number;
	calm: number;
	since: string | null;
	lastPostMs: number;
}

export const initialPressureState = (): PressureState => ({
	level: 'ok',
	over: 0,
	calm: 0,
	since: null,
	lastPostMs: 0,
});

/** `some avg10=1.76 avg60=… total=…\nfull avg10=…` → avg10 of each line. */
export function parsePsi(text: string): Psi | null {
	const avg = (kind: string): number | null => {
		const m = new RegExp(`^${kind} avg10=([0-9.]+)`, 'm').exec(text);
		return m ? Number(m[1]) : null;
	};
	const some10 = avg('some');
	const full10 = avg('full');
	if (some10 === null) return null;
	return { some10, full10: full10 ?? 0 };
}

/** Which lines this sample crosses, as phrases; [] when calm. */
export function pressureReasons(s: PressureSample): string[] {
	const out: string[] = [];
	const L = PRESSURE_LINES;
	if (s.prod.io && s.prod.io.some10 >= L.prodIoSome)
		out.push(`prod io some ${s.prod.io.some10}% (line ${L.prodIoSome})`);
	if (s.prod.mem && s.prod.mem.some10 >= L.prodMemSome)
		out.push(`prod memory some ${s.prod.mem.some10}% (line ${L.prodMemSome})`);
	if (s.host.io && s.host.io.full10 >= L.hostIoFull)
		out.push(`host io full ${s.host.io.full10}% (line ${L.hostIoFull})`);
	if (s.host.mem && s.host.mem.some10 >= L.hostMemSome)
		out.push(`host memory some ${s.host.mem.some10}% (line ${L.hostMemSome})`);
	return out;
}

/** The parts of the sample that could not be read. */
export function unreadableParts(s: PressureSample): string[] {
	const out: string[] = [];
	if (!s.host.io) out.push('host io');
	if (!s.host.mem) out.push('host memory');
	if (!s.prod.io) out.push('prod io');
	if (!s.prod.mem) out.push('prod memory');
	return out;
}

export interface PressureStep {
	next: PressureState;
	reasons: string[];
	/** 'enter' and 'clear' are transitions; 'post' means send `enter`'s message now. */
	event: 'enter' | 'clear' | null;
	post: boolean;
}

/** PURE: one sample through the enter/clear hysteresis. */
export function stepPressure(
	s: PressureState,
	sample: PressureSample,
	nowMs: number
): PressureStep {
	const reasons = pressureReasons(sample);
	const over = reasons.length > 0 ? s.over + 1 : 0;
	const calm = reasons.length > 0 ? 0 : s.calm + 1;
	if (s.level === 'ok' && over >= PRESSURE_ENTER_SAMPLES) {
		const post = nowMs - s.lastPostMs >= PRESSURE_REPOST_MS;
		return {
			next: {
				level: 'warn',
				over,
				calm,
				since: new Date(nowMs).toISOString(),
				lastPostMs: post ? nowMs : s.lastPostMs,
			},
			reasons,
			event: 'enter',
			post,
		};
	}
	if (s.level === 'warn' && calm >= PRESSURE_CLEAR_SAMPLES) {
		return {
			next: { level: 'ok', over, calm, since: null, lastPostMs: s.lastPostMs },
			reasons,
			event: 'clear',
			post: false,
		};
	}
	return { next: { ...s, over, calm }, reasons, event: null, post: false };
}

async function readPsiFile(path: string): Promise<Psi | null> {
	try {
		return parsePsi(await readFile(path, 'utf8'));
	} catch {
		return null;
	}
}

/** `0::/system.slice/pm2-x.service` → that path; null when not cgroup v2. */
export function ownCgroup(procSelfCgroup: string): string | null {
	const line = procSelfCgroup.split('\n').find((l) => l.startsWith('0::'));
	return line ? line.slice(3).trim() || null : null;
}

export async function readPressureSample(): Promise<PressureSample> {
	let cgroup: string | null = null;
	try {
		cgroup = ownCgroup(await readFile('/proc/self/cgroup', 'utf8'));
	} catch {
		cgroup = null;
	}
	const base = cgroup ? join('/sys/fs/cgroup', cgroup) : null;
	const [hio, hmem, pio, pmem] = await Promise.all([
		readPsiFile('/proc/pressure/io'),
		readPsiFile('/proc/pressure/memory'),
		base ? readPsiFile(join(base, 'io.pressure')) : Promise.resolve(null),
		base ? readPsiFile(join(base, 'memory.pressure')) : Promise.resolve(null),
	]);
	return { host: { io: hio, mem: hmem }, prod: { cgroup, io: pio, mem: pmem } };
}

/** Where the state file goes: tmpfs, so writing it never waits on the root disk. */
export function pressureStatePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_RUNTIME_DIR || tmpdir(), 'fleet', 'host-pressure.json');
}

let state = initialPressureState();
let handle: EveryHandle | null = null;
let lastWriteMs = 0;

async function writeState(sample: PressureSample, reasons: string[], nowMs: number): Promise<void> {
	const path = pressureStatePath();
	const doc = {
		$comment:
			'fleet-manager src/host-pressure.ts: the production host early warning. ' +
			'level warn = a pressure line crossed on 2 samples; unreadable lists what could not be read.',
		at: new Date(nowMs).toISOString(),
		level: state.level,
		since: state.since,
		reasons,
		unreadable: unreadableParts(sample),
		lines: PRESSURE_LINES,
		sample,
	};
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(`${path}.tmp`, JSON.stringify(doc, null, 1));
	await rename(`${path}.tmp`, path);
}

export async function hostPressureTick(nowMs: number = Date.now()): Promise<PressureStep> {
	const sample = await readPressureSample();
	const step = stepPressure(state, sample, nowMs);
	state = step.next;
	if (step.event === 'enter') {
		const msg =
			`⚠️ **production host pressure** (early warning, not a page): ${step.reasons.join('; ')}. ` +
			'Claws fence after 10 s without the coordinator; look for a build, test or swap storm on this host now.';
		logger.warn(`[host-pressure] WARN ${step.reasons.join('; ')}`);
		if (step.post) await postDiscord(msg, 'host-pressure');
	} else if (step.event === 'clear') {
		logger.info(
			`[host-pressure] cleared after ${PRESSURE_CLEAR_SAMPLES} calm samples (since ${step.next.since ?? '?'})`
		);
	}
	// On every transition, and every 30 s otherwise: enough for a reader, few writes.
	if (step.event || nowMs - lastWriteMs >= 30_000) {
		lastWriteMs = nowMs;
		try {
			await writeState(sample, step.reasons, nowMs);
		} catch (err) {
			logger.warn(
				`[host-pressure] state file not written (${pressureStatePath()}): ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}
	return step;
}

/** Start the 2 s sampler. Controller-only: `createFleetManager().start()` gates it. */
export function startHostPressure(): void {
	if (handle) return;
	handle = every('host-pressure', PRESSURE_SAMPLE_MS, async () => {
		await hostPressureTick();
	});
}

/** Test seam. */
export function __stopHostPressureForTesting(): void {
	handle?.stop();
	handle = null;
	state = initialPressureState();
	lastWriteMs = 0;
}
