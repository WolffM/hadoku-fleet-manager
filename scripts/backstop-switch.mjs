#!/usr/bin/env node
/**
 * backstop — the GREEN light. `fleet drain` is the red one.
 *
 *   fleet backstop --force hokon [--for 60m] [--reason "queue backed up"]
 *   fleet backstop --off hokon
 *   fleet backstop --status [--json]
 *
 * WHAT --force DOES. Writes a time-boxed record to the state dir that
 * runner-health reads on every tick (~5 min) and the dispatcher acts on
 * through the backstop hold: the node is held ELIGIBLE for `hadoku-builder`
 * work whether or not the saturation decision wants it and whether or not the
 * box reads idle. It does NOT beat a drain or a quarantine, does NOT beat the
 * pm2-host rung (a deploy on the box finishes first), and does NOT beat the
 * dispatcher's own admission — memory, the /tmp floor, maxConcurrent. Those
 * are physical; this is policy. `src/runners/backstop-force.ts` is the
 * mechanism and says why it exists.
 *
 * WHAT --status DOES. Reads the switch file, then the live gates the backstop
 * applies to this box — load per core, memory available, /tmp free — against
 * the thresholds it uses, then the controller's last verdict from
 * `GET /api/fleet`. The first thing an operator types in an incident should
 * answer "why not", and the second thing should fix it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { statfsSync } from 'node:fs';
import { cpus, userInfo } from 'node:os';
import process from 'node:process';

import {
	FORCE_MAX_MINUTES,
	activeForces,
	describeForce,
	forceRecord,
	parseForceMinutes,
	pruneForce,
	readForce,
	writeForce,
} from '../dist/runners/backstop-force.js';
import {
	BACKSTOP_IDLE_MAX_LOAD_PER_CORE,
	BACKSTOP_IDLE_MIN_AVAILABLE_MB,
	SATURATION_QUEUE_SECONDS,
	BACKLOG_QUEUE_SECONDS,
	isHostIdle,
} from '../dist/runners/backstop.js';
import { TMP_FREE_FLOOR_MB } from '../dist/runners/ephemeral.js';
import { readDrains } from './lib/expected-down.mjs';
import { keepStdoutWhole } from './lib/emit.mjs';

// `--status --json` prints one document and exits; through a pipe that loses
// the tail past 8 KB (#33) unless fd 1 is made whole first. Idempotent.
keepStdoutWhole();

/**
 * The drain set, read through `lib/expected-down.mjs`: no host is installed in
 * a CLI process, so `dist/runners/drain.js`'s `readDrain` cannot be used here,
 * but the lapse rule it applies is the same function. A parse failure THROWS —
 * "nothing is drained" is not an answer a corrupt file may give when the
 * question is whether to route work onto a box.
 */
const readDrain = () => readDrains();

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
	const i = args.indexOf(f);
	return i === -1 ? null : (args[i + 1] ?? null);
};
const R = '\x1b[31m',
	G = '\x1b[32m',
	Y = '\x1b[33m',
	B = '\x1b[1m',
	N = '\x1b[0m';

if (has('--help') || has('-h') || args.length === 0) {
	console.log(
		[
			'fleet backstop --force <node> [--for 60m] [--reason "why"]',
			'                                hold the node ELIGIBLE for builder work, time-boxed',
			`                                (default 60m, ceiling ${FORCE_MAX_MINUTES / 60}h; set again if the queue outlives it)`,
			'fleet backstop --off <node>     end a force early',
			'fleet backstop --status [--json]',
			'                                the switch, the live gates on this box, and the',
			"                                controller's last verdict",
			'',
			'A force beats the saturation decision and the idle gate. It does NOT beat a',
			'drain, a quarantine, the pm2-host rung, or the dispatcher’s admission',
			'(memory, /tmp floor, maxConcurrent). Runner-health reads it on its next tick.',
		].join('\n')
	);
	process.exit(0);
}

const now = Date.now();

function readSwitch() {
	try {
		return { state: readForce(), error: null };
	} catch (err) {
		return { state: null, error: err instanceof Error ? err.message : String(err) };
	}
}

if (has('--force')) {
	const node = valueOf('--force');
	if (!node || node.startsWith('--')) {
		console.error(`${R}--force needs a node name${N}`);
		process.exit(2);
	}
	let minutes;
	try {
		minutes = parseForceMinutes(valueOf('--for'));
	} catch (err) {
		console.error(`${R}${err.message}${N}`);
		process.exit(2);
	}
	const reason = valueOf('--reason') ?? 'operator: queue backed up';
	const drain = readDrain();
	if (Object.prototype.hasOwnProperty.call(drain, node)) {
		console.error(
			`${R}${node} is DRAINED (${drain[node].reason}, since ${drain[node].since}) — the red light beats the green one.${N}\n` +
				`Undo the drain first: fleet drain ${node} --undo`
		);
		process.exit(1);
	}
	const { state, error } = readSwitch();
	if (error) {
		console.error(
			`${R}the switch file is unreadable (${error}) — fix or delete it before writing${N}`
		);
		process.exit(1);
	}
	const next = pruneForce(state, now);
	next[node] = forceRecord(minutes, reason, userInfo().username, now);
	writeForce(next);
	console.log(`${G}✓${N} ${describeForce(node, next[node], now)}`);
	console.log(
		`  runner-health reads it on its next tick; the dispatcher then mints on ${node} for queued work.\n` +
			`  watch: pm2 logs mgmt-api | grep -E 'BACKSTOP FORCED|minted .* on ${node}'`
	);
	process.exit(0);
}

if (has('--off')) {
	const node = valueOf('--off');
	if (!node || node.startsWith('--')) {
		console.error(`${R}--off needs a node name${N}`);
		process.exit(2);
	}
	const { state, error } = readSwitch();
	if (error) {
		console.error(`${R}the switch file is unreadable (${error}) — delete it by hand${N}`);
		process.exit(1);
	}
	const next = pruneForce(state, now);
	const had = Object.prototype.hasOwnProperty.call(next, node);
	delete next[node];
	writeForce(next);
	console.log(
		had ? `${G}✓${N} ${node}: force cleared` : `${Y}${node} was not forced${N} (nothing to clear)`
	);
	process.exit(0);
}

if (has('--status')) {
	const { state, error } = readSwitch();
	const forces = state ? activeForces(state, now) : null;
	const local = localGates();
	const verdict = await controllerVerdict();
	if (has('--json')) {
		console.log(
			JSON.stringify(
				{
					ok: error === null,
					switch: error
						? { error }
						: forces.map((f) => ({ node: f.node, ...f.record, remainingMin: f.remainingMin })),
					thisHost: local,
					controller: verdict,
				},
				null,
				2
			)
		);
		process.exit(error ? 1 : 0);
	}
	console.log(`${B}switch${N}`);
	if (error) console.log(`  ${R}unreadable: ${error}${N}`);
	else if (!forces.length) console.log('  nobody is forced');
	else for (const f of forces) console.log(`  ${G}●${N} ${describeForce(f.node, f.record, now)}`);
	console.log(
		`\n${B}this host (${local.host})${N} — the gates saturation applies before promoting it`
	);
	console.log(
		`  load ${local.loadPerCore.toFixed(2)}/core  ${local.loadOk ? G + 'ok' : R + 'over'}${N} (idle is ≤${BACKSTOP_IDLE_MAX_LOAD_PER_CORE})`
	);
	console.log(
		`  memory ${local.memAvailableMb} MB available  ${local.memOk ? G + 'ok' : R + 'low'}${N} (idle is ≥${BACKSTOP_IDLE_MIN_AVAILABLE_MB})`
	);
	console.log(
		`  /tmp ${local.tmpFreeMb} MB free  ${local.tmpOk ? G + 'ok' : R + 'under the mint floor'}${N} (floor ${TMP_FREE_FLOOR_MB}; this one refuses even a FORCED mint)`
	);
	console.log(
		`  → ${
			local.idle
				? G + 'idle: saturation would promote it'
				: local.memOk
					? Y +
						`not idle: saturation (${SATURATION_QUEUE_SECONDS}s) will not promote it; a backlog past ${BACKLOG_QUEUE_SECONDS}s will regardless of load; --force would now`
					: R + 'memory under the floor: neither saturation, a backlog nor --force can mint here'
		}${N}`
	);
	console.log(`\n${B}controller${N} (${verdict.source})`);
	if (verdict.error) console.log(`  ${Y}${verdict.error}${N}`);
	else {
		console.log(
			`  backstop reason: ${verdict.backstopReason ?? 'none'}  (promotes at ${SATURATION_QUEUE_SECONDS}s of queue)`
		);
		console.log(
			`  queued now: ${verdict.queuedNow ?? '?'}  oldest: ${verdict.oldestQueuedMin ?? '?'} min`
		);
		if (verdict.backstopForced === null)
			console.log(`  ${Y}the controller could not read the switch file${N}`);
		else if (verdict.backstopForced.length)
			console.log(
				`  controller sees forced: ${verdict.backstopForced.map((f) => `${f.node} (${f.remainingMin} min left)`).join(', ')}`
			);
	}
	process.exit(error ? 1 : 0);
}

console.error(`${R}one of --force <node>, --off <node>, --status is required${N}`);
process.exit(2);

function localGates() {
	const load1 = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
	const cores = cpus().length;
	const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
	const memAvailableMb = m ? Math.round(Number(m[1]) / 1024) : 0;
	let tmpFreeMb = 0;
	try {
		const s = statfsSync('/tmp');
		tmpFreeMb = Math.floor((s.bavail * s.bsize) / 1048576);
	} catch {
		tmpFreeMb = 0;
	}
	const h = { load1, cores, memAvailableMb };
	return {
		host:
			process.env.HOSTNAME ??
			(existsSync('/etc/hostname') ? readFileSync('/etc/hostname', 'utf8').trim() : 'this box'),
		loadPerCore: cores > 0 ? load1 / cores : Infinity,
		loadOk: cores > 0 && load1 / cores <= BACKSTOP_IDLE_MAX_LOAD_PER_CORE,
		memAvailableMb,
		memOk: memAvailableMb >= BACKSTOP_IDLE_MIN_AVAILABLE_MB,
		tmpFreeMb,
		tmpOk: tmpFreeMb >= TMP_FREE_FLOOR_MB,
		idle: isHostIdle(h),
	};
}

/** The controller's last verdict, read-only, loopback only. `unknown` is never `fine`. */
async function controllerVerdict() {
	const url = (process.env.MGMT_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
	const source = `${url}/api/fleet`;
	let res;
	try {
		res = await fetch(source, { signal: AbortSignal.timeout(3000) });
	} catch (err) {
		return { source, error: `mgmt-api unreachable (${err.message})` };
	}
	if (!res.ok) return { source, error: `mgmt-api returned HTTP ${res.status}` };
	let body;
	try {
		body = await res.json();
	} catch (err) {
		return { source, error: `response was not JSON (${err.message})` };
	}
	const f = body?.fleet ?? {};
	return {
		source,
		error: null,
		backstopReason: f.backstopReason ?? null,
		backstopForced: 'backstopForced' in f ? f.backstopForced : [],
		queuedNow: f.queuedNow ?? null,
		oldestQueuedMin: f.oldestQueuedMin ?? null,
	};
}
