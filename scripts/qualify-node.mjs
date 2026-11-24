#!/usr/bin/env node
/**
 * fleet qualify — hold ONE node out of service and run the qualification
 * playlist against it (wave bootcamp2, operator-approved 2026-11-11).
 *
 *   fleet qualify --machine claw-5 --dry-run   what would run; drains nothing
 *   fleet qualify --machine claw-5 --json      run the window, record the results
 *   fleet qualify --next --json                the scheduled form: the most overdue node, or none
 *   fleet qualify --seed-baselines [--write]   learn each node's last ledger window into
 *                                              node-baselines.json (dry run without --write)
 *   fleet qualify --machine claw-9 --disks     the storage disk checks (SMR, SMART) on every
 *                                              candidate disk; read-only, drains nothing
 *   fleet qualify --machine claw-9 --burn-in <serial> [--confirm] [--minutes N]
 *                                              burn ONE disk in, by serial: its plan without
 *                                              --confirm; with it, up to N (170) min under the
 *                                              drain, resuming where the last run stopped
 *                                              (lib/qualify-disk-burnin.mjs)
 *   fleet qualify --machine claw-10 --wipe <serial> [--confirm]
 *                                              what an old disk carries; with --confirm, record
 *                                              it and clear it so its burn-in can write (#156)
 *   fleet qualify --machine claw-8 --disk-bench  the zone's disks benched on their mount and judged
 *                                              against the pool's other zones (drains; #156)
 *   fleet qualify --machine claw-8 --node-impact the node soaked under Garage's resync + scrub load
 *                                              on its zone: CI's p75 unit, PSI, heat, root fsync
 *   (every disk form's step is read against the kernel log: a link error REJECTS the
 *   disk, persisted in disk-rejections.json; lib/qualify-disk-forms.mjs)
 *
 * `--machine` (or `--next`) is REQUIRED. A qualification drains a node for up to
 * QUALIFY_WINDOW_MINUTES; there is no fleet-wide form, by design (one node at a
 * time for a window that drains, never the backstop — lib/qualify-runner.mjs
 * `refusal`; a read-only `--disks` run takes no capacity and skips the lock).
 *
 * Results go to `qualify-results.json` in the state directory
 * (lib/qualify-results.mjs). Nothing here writes the manifest; a derived
 * `maxConcurrent` is lane Q6's, in shadow first.
 *
 * `--json` emits `{ ok, node, status, reason, results, findings, unreadable,
 * weakPoints, baseline }`. Since #129 a node is judged against its OWN range
 * (lib/qualify-baseline.mjs): `findings` holds every fail whose bar is absolute
 * and every reading outside the node's learned range (`kind: 'absolute'|'drift'`);
 * a hardware bar the node misses is a `weakPoints` entry, recorded in
 * `node-baselines.json` and never a finding; `baseline` is each reading's
 * verdict against the range. `unreadable` holds every
 * `could-not-look` (and a window that never opened), each with its reason — the
 * shape `classifyEmittedDoc` (src/job-run-store.ts) reads. A refusal is exit 2.
 *
 * EXIT: 0 when every test passed; 1 on any fail or could-not-look; 2 refused.
 */
import process from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateDir } from '../dist/lib/fleet-paths.js';
import { createEmitter } from './lib/emit.mjs';
import { deferralFor, readDrains } from './lib/expected-down.mjs';
import { busyCount, drain, isDrained, undrain, waitUntilDrained } from './lib/drain-wait.mjs';
import { loadManifest, machineArg, runOn } from './lib/fleet-exec.mjs';
import { QUALIFY_TESTS } from './lib/qualify-playlist.mjs';
import { readDiskRejections, recordDiskRejections } from './lib/disk-rejections.mjs';
import { DISK_VALUE_FLAGS, selectDiskForm } from './lib/qualify-disk-forms.mjs';
import { readDeclared } from './lib/garage-layout-declared.mjs';
import { mountPointFor } from './lib/storage-format.mjs';
import { ROOT_ZONE_DIR } from '../dist/lib/capability-registry-storage.js';
import { QUALIFY_WINDOW_MINUTES } from './lib/qualify-registry.mjs';
import { readQualifyResults, recordQualifyResults } from './lib/qualify-results.mjs';
import { judgeWindow, seedFromLedger } from './lib/qualify-baseline.mjs';
import { nodeQuantities, readNodeBaselines, recordNodeBaselines } from './lib/node-baselines.mjs';
import { nextNode, runQualification } from './lib/qualify-runner.mjs';
import { spawnJsonToFile } from './lib/spawn-json.mjs';

const emitter = createEmitter({ argv: process.argv });
const log = (m) => emitter.log(m);
const DRY_RUN = process.argv.includes('--dry-run');
const PROVE_JOB = join(dirname(fileURLToPath(import.meta.url)), 'prove-job.mjs');

const finish = (doc, code) => {
	if (emitter.json) emitter.emit(doc);
	process.exit(code);
};
if (process.argv.includes('--seed-baselines')) {
	// One-off: learn each node's last ledger window into a store that never saw
	// it (#129). Dry run unless --write; a node the store already knows is skipped.
	const write = process.argv.includes('--write');
	const ledger = readQualifyResults(stateDir());
	const store = readNodeBaselines(stateDir());
	if (!ledger.ok || !store.ok) {
		const reason = ledger.ok ? store.reason : ledger.reason;
		log(`fleet qualify --seed-baselines: could not read: ${reason}`);
		finish({ ok: false, error: reason }, 1);
	}
	const seeds = seedFromLedger(ledger.results, store.store);
	const failed = [];
	for (const s of seeds) {
		log(
			`${write ? 'seed' : 'would seed'} ${s.node} (${s.at}): ${s.window.readings.length} reading(s); ` +
				`weak points: ${s.window.weak.map((w) => w.test).join(', ') || 'none'}; ` +
				`absolute findings: ${s.window.findings.length}`
		);
		if (!write) continue;
		const r = recordNodeBaselines(stateDir(), s.node, s.window, s.at);
		if (!r.ok) failed.push({ node: s.node, reason: r.reason });
	}
	if (!seeds.length)
		log('fleet qualify --seed-baselines: every node in the ledger is already known');
	finish(
		{
			ok: !failed.length,
			written: write,
			seeds: seeds.map((s) => ({
				node: s.node,
				at: s.at,
				readings: s.window.readings.length,
				weakPoints: s.window.weak.map((w) => w.test),
			})),
			failed,
		},
		failed.length ? 1 : 0
	);
}

const manifest = loadManifest();
const NEXT = process.argv.includes('--next');
let node = machineArg(process.argv.slice(2), { valueFlags: DISK_VALUE_FLAGS });
if (NEXT && node) {
	log('fleet qualify: --next and --machine are exclusive; --next picks the node');
	finish({ ok: false, error: '--next and --machine are exclusive' }, 2);
}
if (NEXT) {
	// The scheduled form (ci:qualify): the one node most overdue, or none.
	const read = readQualifyResults(stateDir());
	if (!read.ok) {
		log(`fleet qualify --next: the qualification ledger is unreadable: ${read.reason}`);
		finish(
			{
				ok: false,
				status: 'could-not-look',
				reason: read.reason,
				findings: [],
				unreadable: [{ reason: `the qualification ledger is unreadable: ${read.reason}` }],
			},
			1
		);
	}
	const pick = nextNode({
		manifest,
		results: read.results,
		drains: readDrains(),
		tests: [...QUALIFY_TESTS],
		nowMs: Date.now(),
	});
	if (!pick.node) {
		log(`fleet qualify --next: nothing to do — ${pick.why}`);
		finish(
			{
				ok: true,
				status: 'none-due',
				node: null,
				reason: pick.why,
				results: [],
				findings: [],
				unreadable: [],
			},
			0
		);
	}
	log(`fleet qualify --next: ${pick.node} (${pick.why}; due: ${pick.due.join(', ')})`);
	node = pick.node;
}
if (!node) {
	log(
		'fleet qualify: --machine <node> (or --next) is required; a qualification holds ONE node out of service'
	);
	finish({ ok: false, error: '--machine is required' }, 2);
}

const machine = manifest.machines?.[node];
if (!machine) {
	log(`fleet qualify: ${node} is not in the manifest`);
	finish({ ok: false, error: `${node} is not in the manifest` }, 2);
}

// THE DISK FORMS (storage bootcamp F2 #137, admission #156): one node, never --next.
let tests = [...QUALIFY_TESTS];
const form = await selectDiskForm({
	argv: process.argv,
	node,
	next: NEXT,
	rejected: () => readDiskRejections(stateDir()),
	pool: () => {
		const d = readDeclared();
		const l = readQualifyResults(stateDir());
		if (d.error || !l.ok) return { ok: false, reason: d.error ?? l.reason };
		return { ok: true, declared: d.declared, results: l.results };
	},
	zonePaths: { rootZoneDir: ROOT_ZONE_DIR, mountPointFor },
	planExec: (script, o = {}) => runOn(node, script, { timeoutMs: 120_000, ...o, as: 'admin' }),
	log,
});
if (form?.done) finish(form.done.doc, form.done.code);
if (form) tests = form.tests;

/** The node while it is drained, for the signal handler below. */
const state = { held: null };
for (const sig of ['SIGINT', 'SIGTERM']) {
	process.once(sig, () => {
		// A process killed mid-window must not leave the node out of service.
		if (state.held) undrain(state.held);
		process.exit(sig === 'SIGINT' ? 130 : 143);
	});
}

const out = await runQualification({
	node,
	machine,
	manifest,
	tests,
	windowMinutes: QUALIFY_WINDOW_MINUTES,
	dryRun: DRY_RUN,
	log,
	state,
	deps: {
		readDrains: () => readDrains(),
		isDrained,
		drain,
		undrain,
		waitQuiet: (n) =>
			waitUntilDrained({
				node: n,
				busy: busyCount,
				clock: { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
			}),
		// A down node is said with the drain behind it when there is one
		// (expected-down-guard pairs every runOn here with deferralFor).
		runOn: async (n, script, o) => {
			const r = await runOn(n, script, { ...o, as: o.as });
			if (!r.ok && !r.stdout) {
				const d = deferralFor(n, readDrains());
				if (d.deferred) r.stderr = `${r.stderr ?? ''} (${d.why})`.trim();
			}
			return r;
		},
		proveJob: (args) =>
			spawnJsonToFile(process.execPath, [PROVE_JOB, ...args], { timeoutMs: 60 * 60_000 }),
		now: Date.now,
	},
});

if (out.status === 'refused') {
	log(`fleet qualify: REFUSED — ${out.reason}`);
	finish({ ok: false, node, status: out.status, reason: out.reason, results: [] }, 2);
}

const at = new Date().toISOString();
// A window that never opened is recorded too: it is a fact about the node, and
// `--next` reads `last.at` to put a node that was too busy behind the others.
const recorded =
	out.status === 'ran' || out.status === 'could-not-look'
		? recordQualifyResults(stateDir(), node, out.results, at)
		: { ok: true };
if (!recorded.ok) log(`✗ results not recorded: ${recorded.reason}`);
// A disk an onboarding step rejected is persisted by serial (#156), so the next
// scan lists it as rejected even after a reboot clears the kernel log.
const rejectedNow = recordDiskRejections(stateDir(), node, out.results ?? [], at);
if (!rejectedNow.ok) log(`✗ disk rejections not recorded: ${rejectedNow.reason}`);
for (const s of rejectedNow.added ?? []) log(`   REJECTED ${s}: persisted in disk-rejections.json`);

// Judge the window against this node's own range (#129): a hardware bar it
// misses is a weak point, a reading outside its range is a drift finding. An
// unreadable store judges nothing relative, so every fail stays a finding: the
// gate never gets easier because the baseline could not be read.
const judging = out.status === 'ran' || out.status === 'could-not-look';
const baselines = judging ? readNodeBaselines(stateDir()) : { ok: true, store: null };
const judged = baselines.ok
	? judgeWindow({
			node,
			results: judging ? out.results : [],
			quantities: baselines.store ? nodeQuantities(baselines.store, node) : {},
		})
	: null;
const learned =
	judged && judging ? recordNodeBaselines(stateDir(), node, judged, at) : { ok: true };
if (!learned.ok) log(`✗ baselines not recorded: ${learned.reason}`);
for (const j of judged?.judged ?? [])
	log(
		`   baseline ${j.quantity} = ${j.value}: ${j.verdict}${j.direction ? ` (${j.direction})` : ''}` +
			(j.n ? ` vs ${j.mean} ± ${j.band} (n=${j.n})` : '')
	);
for (const w of judged?.weak ?? []) log(`   weak point ${w.test}: ${w.reason}`);

const findings = judged
	? judged.findings
	: out.results
			.filter((r) => r.status === 'fail')
			.map((r) => ({ node, test: r.id, kind: 'absolute', reason: `${r.id}: ${r.reason}` }));
const unreadable = [
	...(out.status === 'could-not-look' && !out.results.length ? [{ node, reason: out.reason }] : []),
	...(out.status === 'dry-run'
		? []
		: out.results
				.filter((r) => r.status === 'could-not-look')
				.map((r) => ({ node, test: r.id, reason: `${r.id}: ${r.reason}` }))),
	...(recorded.ok ? [] : [{ node, reason: `results not recorded: ${recorded.reason}` }]),
	...(baselines.ok
		? []
		: [
				{
					node,
					reason: `the node baselines are unreadable, so every fail is a finding: ${baselines.reason}`,
				},
			]),
	...(learned.ok ? [] : [{ node, reason: `baselines not recorded: ${learned.reason}` }]),
	...(rejectedNow.ok
		? []
		: [{ node, reason: `disk rejections not recorded: ${rejectedNow.reason}` }]),
	...(out.undrainFailed
		? [{ node, reason: `STILL DRAINED: the window could not lift its drain: ${out.undrainFailed}` }]
		: []),
];

if (out.status === 'dry-run') {
	log(`fleet qualify ${node} — DRY RUN, nothing drained: ${out.reason}`);
	for (const r of out.results) log(`   ${r.id}: ${r.reason}`);
} else if (out.reason) log(`fleet qualify ${node}: ${out.status} — ${out.reason}`);

const ok = out.status !== 'dry-run' && !findings.length && !unreadable.length;
finish(
	{
		ok: out.status === 'dry-run' ? true : ok,
		node,
		status: out.status,
		reason: out.reason,
		results: out.results,
		findings,
		unreadable,
		weakPoints: judged?.weak ?? [],
		baseline: judged?.judged ?? [],
	},
	out.status === 'dry-run' ? 0 : ok ? 0 : 1
);
