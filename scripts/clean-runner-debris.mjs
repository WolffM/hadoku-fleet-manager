#!/usr/bin/env node
/**
 * clean-runner-debris — reclaim what the runner's self-update leaves behind.
 *
 * Read-only by default. See clean-runner-debris.sh for what is removed and, more
 * importantly, what is not.
 *
 * WHY THIS RUNS DAILY RATHER THAN WEEKLY
 * --------------------------------------
 * A weekly cadence would need a clock offset — "an hour after the daily set" —
 * and a guessed offset is a proxy for the thing you actually want, which is
 * ordering. The cron worker already gives ordering for free: jobs inside a
 * profile execute sequentially, which is why `ci:fleet-coverage` can be
 * documented as LAST in the last daily profile. So this is appended THERE
 * instead of given a schedule of its own.
 *
 * Daily is also cheaper than weekly in the only sense that matters. The run is
 * O(runners) stat calls when there is nothing to clean, and there IS nothing to
 * clean on any day the runner did not upgrade itself — which is most days. The
 * cost of running it daily is a rounding error; the benefit is that debris never
 * accumulates for six days before anyone touches it. Same reasoning as the tier
 * reconcile: cheap when clean, so run it often.
 *
 * USAGE
 *   fleet cleanup                 # dry run
 *   fleet cleanup --confirm
 *   fleet cleanup --machine claw-2 --confirm
 *   fleet cleanup --json
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, machineArg, runOn, selectMachines } from './lib/fleet-exec.mjs';
import { manifest as manifestFile } from '../dist/lib/fleet-paths.js';
import { reposOnNode } from './lib/placement-rules.mjs';
import { reclaimableCaches } from './lib/tool-caches.mjs';
import { createEmitter } from './lib/emit.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { knownDownNodes, knownDownNote } from './lib/known-down.mjs';
import { overdueFindings, recordSweeps } from './lib/cache-sweep-log.mjs';
import { errText } from './lib/term.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_SRC = resolve(__dirname, 'clean-runner-debris.sh');

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const JSON_OUT = args.includes('--json');
// Via `machineArg`, not a private copy — the copy had the same hole, and this
// subcommand is one of the five under the `--json` contract (`ci:claw-cleanup`),
// so a silently fleet-wide `--confirm` here runs from a cron every night.
// `--diag-keep-days` and `--tmp-keep-min` each swallow the token after them, so
// their VALUES must not be mistaken for stray positionals.
const ONLY = machineArg(args, { valueFlags: ['--diag-keep-days', '--tmp-keep-min'] });
const DIAG_KEEP_DAYS = args.includes('--diag-keep-days')
	? Number(args[args.indexOf('--diag-keep-days') + 1])
	: 14;
const TMP_KEEP_MIN = args.includes('--tmp-keep-min')
	? Number(args[args.indexOf('--tmp-keep-min') + 1])
	: 60;

// One stdout discipline, shared — see lib/emit.mjs. `emit` is the ONLY write
// to stdout below, which is what makes "print before the JSON" unreachable
// rather than merely absent.
const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;
// Per NODE, and the nodes run concurrently (see the bottom of the file), so
// this is also the whole run's ceiling. It must sit well inside mgmt-api's
// 600 s for `ci:claw-cleanup`, or the consumer kills the run before a slow
// node's own timeout can name it. Measured 2026-11-03 once #50's lsof fixes
// landed: every node 2-10 s (hokon slowest), from 600 s+ before.
const NODE_TIMEOUT_MS = 90_000;
const GB = (kb) => (kb / 1048576).toFixed(2);

const script = readFileSync(SCRIPT_SRC, 'utf8');
const FLEET = loadManifest();
const nodes = selectMachines(FLEET, { only: ONLY }).map(([name]) => name);

/**
 * Covered repos, for the tool-cache reclaim. Read once.
 *
 * REPORTED, NEVER DELETED HERE. A cache is shared per-tool and a wrong verdict
 * costs an expensive rebuild on a node that was fine, so this names what has
 * been abandoned and leaves the removal to an operator who can see the list.
 * `--confirm` on this subcommand already runs nightly from `ci:claw-cleanup`,
 * and a cron that deletes caches on inference is not a thing to add quietly.
 */
let coveredRepos = [];
try {
	coveredRepos =
		JSON.parse(readFileSync(manifestFile('fleet-runner-coverage.json'), 'utf8')).repos ?? [];
} catch {
	// Unreadable coverage means every repo looks unserved, which would report the
	// whole fleet's caches as abandoned. Empty disables the reclaim instead — see
	// tool-caches.mjs: no coverage, no verdict.
	coveredRepos = [];
}

if (!nodes.length) {
	console.error(`clean-runner-debris: no nodes${ONLY ? ` matching --machine ${ONLY}` : ''}`);
	process.exit(1);
}

log(
	`Mode: ${CONFIRM ? 'APPLY' : 'DRY RUN (no deletions)'}   keeping _diag < ${DIAG_KEEP_DAYS}d, ` +
		`tmpfs basetemps < ${TMP_KEEP_MIN}min\n`
);

const results = [];
let totalKb = 0;
// A node a human powered off is EXPECTED down. It is still PRINTED, and still
// not cleaned — the deferral suppresses the failure, never the evidence, and
// expires after DEFER_DAYS. See lib/expected-down.mjs.
const DRAINS = readDrains();
// Already paged as down by runner-health's own offline alert (observed,
// never a declaration — see lib/known-down.mjs).
const KNOWN_DOWN = knownDownNodes();

async function cleanNode(m) {
	const lines = [];
	const say = (l) => lines.push(l);
	// TOOL CACHES this node keeps for work it no longer does, decided up here
	// from ownership (tool-caches.mjs), BEFORE the node is asked anything. Only
	// THOSE paths go down to be sized: `du` over a cache the node still owns
	// answers a question nobody asks, and on claw-1's spinning disk a cold walk
	// of its own ~/.cache/trunk (403k files) took 66s of a 90s budget
	// (fleet-manager#65).
	//
	// GATED ON HAVING COVERAGE AT ALL. With an empty repo list every node serves
	// nothing, so every declared cache reads as abandoned and this would report
	// the entire fleet's caches for deletion off the back of one unreadable file.
	// "I could not look" must not render as "all of it is garbage".
	const abandoned = coveredRepos.length
		? reclaimableCaches({
				node: m,
				caches: FLEET.toolCaches ?? {},
				reposOn: (n) => reposOnNode(n, coveredRepos, FLEET),
			}).filter((c) => typeof c.path === 'string')
		: [];
	const cachePaths = abandoned.map((c) => c.path).join(' ');
	// NODE_MAX_CONCURRENT is the only honest source for "how many JIT slots
	// should exist here" — the node has no record of its own ceiling, only the
	// operator manifest on THIS controller does (CLAUDE.md: a manifest is
	// operator config read on the controller, never re-derived on the node).
	// Absent or non-numeric goes through as empty: the .sh treats that as
	// "could not look" and refuses to prune JIT slots at all, never as "no
	// ceiling, delete anything past slot0".
	const mc = FLEET.machines?.[m]?.maxConcurrent;
	const MAX_CONCURRENT_NODE = typeof mc === 'number' && Number.isFinite(mc) ? mc : '';
	const payload =
		`APPLY=${CONFIRM ? 1 : 0}\nDIAG_KEEP_DAYS=${DIAG_KEEP_DAYS}\nTMP_KEEP_MIN=${TMP_KEEP_MIN}\n` +
		// The node's tmpfs, named here and nowhere else: the script has no
		// default, so a caller that forgets it sweeps nothing rather than /tmp.
		`TMPFS_ROOT=/tmp\n` +
		`MAX_CONCURRENT_NODE='${MAX_CONCURRENT_NODE}'\nCACHE_PATHS='${cachePaths}'\n${script}`;
	const r = await runOn(m, payload, {
		as: 'ci',
		timeoutMs: NODE_TIMEOUT_MS,
		maxBuffer: 32 * 1024 * 1024,
	});
	const summary = r.out.split('\n').find((l) => l.startsWith('SUMMARY ')) ?? '';
	if (!r.ok && !summary) {
		const defer = deferralFor(m, DRAINS);
		if (defer.deferred) {
			say(`── ${m}\n   · ${deferralNote(m, defer)} — not cleaned`);
			return {
				lines,
				kb: 0,
				result: { machine: m, ok: true, expectedDown: true, skipped: 'expected down' },
			};
		}
		const down = KNOWN_DOWN.get(m);
		if (down) {
			say(`── ${m}\n   · ${knownDownNote(down)} — not cleaned`);
			return {
				lines,
				kb: 0,
				result: { machine: m, ok: true, knownDown: down, skipped: 'known down' },
			};
		}
		say(`── ${m}\n   ✗ unreachable: ${r.out.trim().slice(0, 160)}`);
		return { lines, kb: 0, result: { machine: m, ok: false, error: r.out.trim().slice(0, 300) } };
	}
	const f = Object.fromEntries(
		summary
			.replace('SUMMARY ', '')
			.split(' ')
			.filter(Boolean)
			.map((kv) => kv.split('='))
	);
	// tmpfs_kb is reported and summed with the rest, but it is RAM, not disk —
	// see the tmpfs block in clean-runner-debris.sh. It is called out separately
	// below so a reader never reads it as free disk.
	const kb =
		Number(f.stale_kb ?? 0) +
		Number(f.update_kb ?? 0) +
		Number(f.orphan_kb ?? 0) +
		Number(f.diag_kb ?? 0) +
		Number(f.tmpfs_kb ?? 0) +
		Number(f.venv_kb ?? 0) +
		Number(f.trunk_kb ?? 0) +
		Number(f.android_kb ?? 0) +
		Number(f.unclassified_kb ?? 0);
	// What the backstop sweep found that no rule names, by class. Printed and
	// carried in --json so a new kind of debris is visible the first night it
	// appears, which is the point of reporting it at all.
	const unclassified = r.out
		.split('\n')
		.filter((l) => l.startsWith('UNCLASSIFIED '))
		.map((l) =>
			Object.fromEntries(
				l
					.slice('UNCLASSIFIED '.length)
					.split(' ')
					.map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])
			)
		)
		.map((u) => ({ root: u.root, class: u.class, n: Number(u.n), kb: Number(u.kb) }));
	const busy = Number(f.busy_skipped ?? 0);
	say(
		`── ${m}${r.local ? ' (local)' : ''}\n` +
			`   stale ${GB(f.stale_kb ?? 0)} GB   _update ${GB(f.update_kb ?? 0)} GB   ` +
			// Reported on its own line rather than folded into `stale`, because an
			// orphan is a DIFFERENT fault: stale/_update are the runner's own
			// self-update litter and are expected, while an orphan is a removal
			// this fleet started and did not finish. A number that only ever moves
			// when something went wrong should not share a column with one that
			// moves every week.
			`orphaned-removal ${GB(f.orphan_kb ?? 0)} GB   ` +
			`_diag>${DIAG_KEEP_DAYS}d ${GB(f.diag_kb ?? 0)} GB   ⇒ ${GB(kb)} GB` +
			(busy ? `   (${busy} runner(s) busy, skipped)` : '') +
			`\n   free after: ${GB(f.free_kb ?? 0)} GB` +
			(Number(f.tmpfs_used_kb ?? 0)
				? `\n   tmpfs /tmp: ${GB(f.tmpfs_used_kb)} GB resident in RAM, ${GB(f.tmpfs_kb ?? 0)} GB reclaimable`
				: '') +
			(Number(f.trunk_kb ?? 0) ? `\n   trunk cache, aged out: ${GB(f.trunk_kb)} GB` : '') +
			(Number(f.android_kb ?? 0) ? `\n   android sdk, unread: ${GB(f.android_kb)} GB` : '') +
			// SAID, so a node that is busy every night is seen never being pruned.
			(/^SKIP-CACHES /m.test(r.out)
				? '\n   trunk + android caches: not swept, a job was running'
				: '') +
			(/^SKIP-ANDROID /m.test(r.out)
				? '\n   android sdk: not swept, no read times on its mount'
				: '') +
			// A venv whose interpreter is gone (#127): named per path, because each
			// one is a checkout that would have failed its next job.
			(Number(f.venv_kb ?? 0)
				? `\n   broken venvs (interpreter gone): ${GB(f.venv_kb)} GB` +
					r.out
						.split('\n')
						.filter((l) => l.startsWith('BROKEN-VENV '))
						.map((l) => `\n     ${l.slice('BROKEN-VENV '.length)}`)
						.join('')
				: '') +
			(Number(f.unclassified_kb ?? 0)
				? `\n   unclassified (no rule names it, untouched a day): ${GB(f.unclassified_kb)} GB` +
					unclassified
						.map((u) => `\n     ${u.class}  ×${u.n}  ${GB(u.kb)} GB  (${u.root})`)
						.join('')
				: '')
	);
	if (abandoned.length) {
		// PRESENT ∩ ABANDONED. Ownership says a cache is no longer earned; the node
		// says whether it is still on disk. Reporting the intersection is what stops
		// this naming a directory that was already removed — and it is what gives
		// the line a size, without which an operator has nothing to act on.
		const present = new Map(
			r.out
				.split('\n')
				.filter((l) => l.startsWith('CACHE-PRESENT '))
				.map((l) => l.split(' '))
				.map(([, path, kb]) => [path, Number(kb) || 0])
		);
		const live = abandoned.filter((c) => present.has(c.path));
		for (const c of live) {
			say(`     CACHE-ABANDONED ${c.path}  ${GB(present.get(c.path))} GB — ${c.reason}`);
		}
	}

	// FALSE when a running job held the bounded caches back: lib/cache-sweep-log.mjs
	// counts those nights, and the refresh cycle drains a node that piles them up.
	const cachesSwept = !/^SKIP-CACHES /m.test(r.out);
	return {
		lines,
		kb,
		result: { machine: m, ok: true, ...f, reclaimKb: kb, unclassified, cachesSwept },
	};
}

// CONCURRENTLY, each node on its own clock (#50). One after another, every
// node shared mgmt-api's single 600 s budget for the whole run, so one slow
// node spent it and the cron died naming nobody; on 2026-11-01..03 that was
// hokon, whose un-flagged `lsof` resolved every socket's name for 6 minutes.
// Each node now gets NODE_TIMEOUT_MS, a hang fails as THAT node's finding, and
// the run ends inside the consumer's budget. One stderr line per node as it
// finishes carries its duration, so the slow one is named even in --json.
const runs = await Promise.all(
	nodes.map(async (m) => {
		const t0 = Date.now();
		const run = await cleanNode(m);
		const seconds = Math.round((Date.now() - t0) / 1000);
		console.error(`clean-runner-debris: ${m} ${run.result.ok ? 'done' : 'FAILED'} in ${seconds}s`);
		return { ...run, result: { ...run.result, seconds } };
	})
);
// Printed in manifest order once all are back, so the report reads the same
// whichever node answered first.
for (const run of runs) {
	for (const l of run.lines) log(l);
	results.push(run.result);
	totalKb += run.kb;
}

// The sweep record, and what it says about nodes no night has reached. Only an
// APPLY run writes it or judges it: a dry run is someone looking, not the cron.
let findings = [];
if (CONFIRM) {
	try {
		const swept = recordSweeps(results, { confirm: CONFIRM });
		findings = overdueFindings(swept, nodes, Date.now());
	} catch (e) {
		findings = [{ machine: null, kind: 'sweep-log-unwritable', reason: errText(e) }];
	}
}

if (JSON_OUT) {
	emitter.emit({
		confirm: CONFIRM,
		totalReclaimGb: Number(GB(totalKb)),
		results,
		findings,
		// ADDITIVE (wave gates1 lane A): already paged down by runner-health's
		// own per-node offline alert, not a fresh finding here — see
		// lib/known-down.mjs.
		knownDown: results.filter((r) => r.knownDown).map((r) => ({ node: r.machine, ...r.knownDown })),
	});
} else {
	log(
		`\n${CONFIRM ? 'Reclaimed' : 'Reclaimable'}: ${GB(totalKb)} GB across ${results.filter((r) => r.ok).length} node(s)`
	);
	if (!CONFIRM) log('Dry run only. Re-run with --confirm to delete.');
	const busy = results.reduce((n, r) => n + Number(r.busy_skipped ?? 0), 0);
	if (busy)
		log(`${busy} runner(s) were mid-job and were skipped — they are picked up on the next run.`);
	for (const f of findings) log(`✗ ${f.kind}: ${f.reason}`);
}

process.exit(results.some((r) => !r.ok) || findings.length ? 1 : 0);
