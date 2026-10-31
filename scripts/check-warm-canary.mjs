#!/usr/bin/env node
/**
 * check-warm-canary — proves the warm cache of one can actually HOLD a
 * listener, the way `jit-canary.yml` proves the ephemeral dispatcher can
 * actually mint one (P4.5, issue #7).
 *
 * WHY THIS EXISTS
 * ---------------
 * The warm cache had never filled a single slot for as long as it existed
 * (issue #7): every fill failed, on every eligible node, every minute, and
 * nothing noticed until a tracker session read `pm2 logs` by hand. On an idle
 * fleet a healthy cache and a broken one look identical from outside — no
 * fills either way — which is exactly the ambiguity `jit-canary.yml` exists to
 * remove for the JIT path. This is that guarantee for the warm path.
 *
 * WHY THIS DOES NOT NEED A JOB, UNLIKE jit-canary
 * ------------------------------------------------
 * `jit-canary` forces a job onto a `jit-canary`-labelled runner because a JIT
 * mint has no other observable trace until GitHub schedules something onto
 * it. A warm listener is the opposite: it is a STANDING registration, so its
 * existence is itself observable without waiting for traffic. This script
 * ssh's every ELIGIBLE candidate node directly and asks systemd whether an
 * active `warm-*` unit is running — the same question `currentWarmSlot()`
 * (src/runners/ephemeral-exec.ts) asks in-process on every tick. Reading the
 * NODE, never mgmt-api's own bookkeeping, is this repo's rule for every fact
 * in this workstream (§12.8, B9): a verifier that trusted its own writer's
 * memory could not fail.
 *
 * ELIGIBLE is the dispatcher's own rule, reused rather than re-typed:
 * ephemeral, not drained, not a guest, and MEASURED usable memory whose warm
 * half holds one busy listener (a job's worth, `jobReserve`'s node answer)
 * beside the 50% mint reserve — `warmEligibleSlots`/`warmCacheEligible`
 * are imported from the BUILT package (`dist/runners/ephemeral.js`), the same
 * pattern `fleet-exec.mjs` already uses for `isLocalNode`, so there is exactly
 * one implementation of the threshold to drift from.
 *
 * WIRING (cross-repo, out of scope for this checkout)
 * -----------------------------------------------------
 * `jit-canary` is wired into hadoku_site's own `.github/workflows/` and its
 * `ci:audit-gates` GATES table lives in that repo's `audit-gates.ts`.
 * MIGRATED (wave 5f lane B): `ci:audit-gates` now runs this one with `--json`
 * and judges it by the `GateDoc` below rather than a regex over
 * stdout+stderr — see `src/lib/job-registry.ts`'s `coversSubs` entry
 * (`contract: 'json'`) and `scripts/lib/json-contract.mjs`'s derivation of
 * `JSON_CONTRACT` from it. `audit-gates.ts` falls back to the old
 * exit-code+evidence rule when stdout is not a `GateDoc` (an older
 * fleet-manager), so the two repos can land in either order.
 *
 * @guards src/runners/ephemeral.ts
 */
import process from 'node:process';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest, runOnSync, selectNodes } from './lib/fleet-exec.mjs';
import { stateDir } from './lib/paths.mjs';
import { createEmitter } from './lib/emit.mjs';
import { buildGateDoc } from './lib/gate-doc.mjs';
import { warmCanaryVerdict, slowTierCandidates } from './lib/warm-canary.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
// The BUILT copy, deliberately — see the header note above and
// scripts/lib/fleet-exec.mjs's own note on importing isLocalNode the same way.
import {
	unitMemoryMaxMb,
	warmCacheEligible,
	warmEligibleSlots,
	warmRunnerName,
} from '../dist/runners/ephemeral.js';
import { jobReserve } from '../dist/runners/ephemeral-shared.js';
import { effectiveHosting, readHostingDoc } from '../dist/runners/hosting-record.js';
import { buildSpeedModel } from '../dist/runners/speed-tier.js';

const JSON_OUT = process.argv.includes('--json');
const out = createEmitter({ argv: process.argv });

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	out.log('fleet warm-canary — proves the warm cache of one can hold a listener');
	out.log('');
	out.log('  --json    machine-readable verdict');
	out.log('');
	out.log("ssh's every eligible ephemeral, non-drained node (same rule the dispatcher");
	out.log('enforces) and asks systemd whether an active warm-* unit is registered there.');
	out.log('Fails if no candidate node exists, none could be reached, none has enough');
	out.log('measured capacity, or none is actually holding a listener.');
	process.exit(0);
}

/**
 * The persisted job history, for the speed model. A missing file or an
 * unparsable line yields fewer records, never an error: with less history no
 * node reads as slow, so the canary keeps demanding a listener on every
 * candidate (the strict direction).
 */
function readJobHistory() {
	const path = join(stateDir(), 'job-history.jsonl');
	if (!existsSync(path)) return [];
	const records = [];
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const t = line.trim();
		if (!t) continue;
		try {
			records.push(JSON.parse(t));
		} catch {
			// a truncated final line costs one record, by the writer's design
		}
	}
	return records;
}

/** Shared hosting slices: the warm tick plans around installed memory less each one. */
const SHARED_HOSTING = effectiveHosting(readHostingDoc(stateDir()));

function measure(node, m) {
	const floorMb = m.minFreeMb ?? 1536;
	// The verdict's floor carries the slice, as the warm tick's `usableMb`
	// does; the per-unit cap below does not, as the minter's does not.
	const minFreeMb = floorMb + (SHARED_HOSTING[node]?.memoryMb ?? 0);
	const unmeasured = { node, reachable: false, totalMb: null, minFreeMb, jobMb: 0, role: m.role };
	const mem = runOnSync(node, "free -m | awk '/^Mem:/{print $2}'", { as: 'admin' });
	if (!mem.ok) return { ...unmeasured, activeRepo: null };
	const totalMb = Number(mem.stdout.trim());
	if (!Number.isFinite(totalMb) || totalMb <= 0) return { ...unmeasured, activeRepo: null };
	// A MINT's worth, derived exactly as the warm tick derives it — see the
	// eligibility call in dispatchWarmCache.
	const jobMb = jobReserve({
		nodeJobP95Mb: m.jobP95Mb,
		capMb: unitMemoryMaxMb({
			requestedMb: m.slice?.unitMaxMb,
			sliceCeilingMb: totalMb - floorMb,
		}),
	}).mb;

	// The marker `warm-provision.sh` writes at mint time — see currentWarmSlot()
	// in src/runners/ephemeral-exec.ts for the same read, in-process.
	const marker = runOnSync(node, 'f="$HOME/.hadoku/warm/repo"; [ -f "$f" ] && cat "$f" || true', {
		as: 'ci',
	});
	const repo = marker.ok ? marker.stdout.trim() : '';
	let activeRepo = null;
	if (repo) {
		const unit = warmRunnerName(node, repo);
		const active = runOnSync(
			node,
			`XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active ${unit} 2>/dev/null || true`,
			{ as: 'ci' }
		);
		// A marker with no live unit behind it is STALE, not evidence of a warm
		// listener — same rule currentWarmSlot() applies in-process.
		if (active.ok && active.stdout.trim().startsWith('active')) activeRepo = repo;
	}
	return { node, reachable: true, totalMb, minFreeMb, jobMb, role: m.role, activeRepo };
}

function main() {
	const manifest = loadManifest();
	/**
	 * A GUEST IS NOT A CANDIDATE, BY ROLE — not by happening to lack a key.
	 *
	 * The warm cache holds a listener the DISPATCHER minted, and a guest is never
	 * a mint target: it lends the fleet a standing registration and is otherwise
	 * none of the fleet chain's business (operator, 2026-09-14). The filter below
	 * already excluded it today, but only incidentally — the guest declares no
	 * `ephemeral` key, so one manifest edit was all that stood between this and a
	 * sweep that ssh'd the guest and read its systemd. `selectNodes` states the
	 * rule instead of relying on that, and hands back the skip so it can be said
	 * out loud rather than vanishing from a report.
	 */
	const { nodes: selected, skippedByRole } = selectNodes(manifest, {
		where: (m) => m.ephemeral === true,
	});

	/**
	 * A node drained for maintenance cannot hold a warm listener BY DESIGN — the
	 * dispatcher it mirrors (`ephemeral-tick.ts`'s `drainedNodes` set, consumed
	 * by `ephemeral.ts`'s eligibility refusal) excludes EVERY drained node,
	 * ANY `kind`, with NO age limit. Candidacy here has to match that exactly,
	 * not `deferralFor`'s narrower rule: a `training` drain is reachable,
	 * eligible by measured memory, and — correctly, by the dispatcher's own
	 * design — holds no listener, so measuring it and feeding that into
	 * `warmCanaryVerdict`'s per-node check produces "N of M eligible node(s)
	 * not holding a warm listener" for a node that was never going to hold one.
	 * That is a false `@here` with the wrong reason, the opposite of what this
	 * lane exists to fix.
	 *
	 * This still replaced a raw read of `fleet-drain.json` — one of the six
	 * duplicate readers `lib/expected-down.mjs`'s header names — with the
	 * canonical `readDrains()`, which is the real fix: one fewer place this
	 * file re-opens that JSON by hand. The exclusion RULE itself (any row,
	 * any kind, any age) was correct all along; what changed is only which
	 * function reads the file. `deferralFor` is used purely for the PRINTED
	 * reason below — kind and age are worth saying even when they are not
	 * what decided candidacy.
	 */
	const drains = readDrains();
	const hasDrainRow = (name) => Boolean(drains?.[name]);
	const drainedCandidates = selected.filter(([name]) => hasDrainRow(name));
	// The slow tier never holds a warm listener (#83); see slowTierCandidates.
	const slowTier = slowTierCandidates(
		readJobHistory(),
		Object.keys(manifest.machines ?? {}),
		buildSpeedModel,
		Date.now()
	);
	const isSlow = (name) => slowTier.some((s) => s.node === name);
	const active = selected.filter(([name]) => !hasDrainRow(name) && !isSlow(name));

	const measurements = active.map(([name, m]) => measure(name, m));
	const verdict = warmCanaryVerdict(measurements, { warmEligibleSlots, warmCacheEligible });
	const drained = drainedCandidates.map(([name]) => name);

	if (JSON_OUT) {
		// GateDoc (wave 5f lane B). `unreachable` is "I could not look" — never
		// folded into a per-node finding, and it BLOCKS judging the rest: a
		// candidate that did not answer might have been warm or broken, so the
		// eligible ones are not scored for "not warm" while any are unreachable
		// (same reasoning warmCanaryVerdict itself already applies to `ok`).
		const unreadable = verdict.unreachable.map((node) => ({
			node,
			why: 'could not reach this node to measure warm-cache capacity',
		}));
		const findings = [];
		if (!verdict.unreachable.length) {
			for (const node of verdict.eligible) {
				if (!verdict.warm.some((w) => w.node === node)) {
					findings.push({
						node,
						kind: 'not-warm',
						reason: `${node} is eligible for a warm listener but is not holding one`,
					});
				}
			}
		}
		// A whole-fleet refusal with no single node to blame (no candidate
		// exists at all, or none is eligible) still needs ONE finding — a
		// GateDoc with ok:false and both arrays empty says nothing to a reader.
		if (!verdict.ok && !findings.length && !unreadable.length) {
			findings.push({ node: null, kind: 'warm-canary-refused', reason: verdict.reason });
		}
		// Alongside the verdict, never inside `eligible`: a node this run chose not
		// to look at is not a node it measured and found wanting.
		out.emit({
			...verdict,
			skippedByRole,
			drained,
			slowTier,
			...buildGateDoc({
				findings,
				unreadable,
				ok: verdict.ok,
				why: verdict.ok ? undefined : verdict.reason,
			}),
		});
	} else if (verdict.ok) {
		for (const s of skippedByRole) out.log(`  · ${s.node} [skipped: guest] — ${s.why}`);
		for (const [name] of drainedCandidates)
			out.log(`  · ${deferralNote(name, deferralFor(name, drains))} — not probed`);
		for (const s of slowTier)
			out.log(
				`  · ${s.node} [slow tier, p25 ${s.p25}] — never holds a warm listener (#83), not probed`
			);
		out.log(
			`✓ warm cache canary: ${verdict.warm.map((w) => `${w.node} (${w.repo})`).join(', ')} ` +
				`— ${verdict.eligible.length} eligible node(s) checked` +
				(verdict.unreachable.length ? `, ${verdict.unreachable.join(', ')} unreachable` : '') +
				(skippedByRole.length ? `, ${skippedByRole.length} guest(s) skipped by role` : '')
		);
	} else {
		for (const s of skippedByRole) console.error(`  · ${s.node} [skipped: guest] — ${s.why}`);
		for (const [name] of drainedCandidates)
			console.error(`  · ${deferralNote(name, deferralFor(name, drains))} — not probed`);
		for (const s of slowTier)
			console.error(
				`  · ${s.node} [slow tier, p25 ${s.p25}] — never holds a warm listener (#83), not probed`
			);
		console.error(`✗ warm cache canary: ${verdict.reason}`);
	}
	process.exit(verdict.ok ? 0 : 1);
}

main();
