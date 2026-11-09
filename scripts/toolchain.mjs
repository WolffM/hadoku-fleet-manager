#!/usr/bin/env node
/**
 * fleet toolchain — is every node able to BUILD the same things?
 *
 * RENAMED from `check-fleet-toolchain.mjs` (wave gates2 lane F1a). The probing
 * and judging logic — `runDoctor` and everything it calls — moved to
 * `scripts/lib/toolchain-doctor.mjs`, which `fleet converge-toolchain --refresh`
 * now ALSO calls directly, so the nightly cadence folds in the tool-CACHE
 * drift (hostedtoolcache, `ensurepip`, pnpm's store) this subcommand used to
 * re-read an hour later on its own cron (retired wave gates2 lane F2, with
 * its backstop-readiness block carried through to `--refresh` too,
 * hadoku_site#527 — see `MANUAL['toolchain']` in `src/lib/job-registry.ts`).
 * THIS FILE IS KEPT, UNCHANGED IN SHAPE, as a real, working subcommand: a
 * read-only per-node diagnostic (`--machine <n> --json`) that touches
 * nothing, unlike `--refresh`'s drain cycle — useful on its own even with no
 * cron behind it.
 *
 * Read-only. Exit 1 on drift, so a human (or `fleet converge-toolchain
 * --refresh`'s own nightly pass) can act on it.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadManifest, machineArg } from './lib/fleet-exec.mjs';
import { isLocalNode } from '../dist/lib/node-identity.js';
import { createEmitter } from './lib/emit.mjs';
import { runDoctor, TOLERANCE_MINUTES } from './lib/toolchain-doctor.mjs';

async function main() {
	const JSON_OUT = process.argv.includes('--json');
	// One stdout discipline, shared — see lib/emit.mjs. `emit` is the ONLY write
	// to stdout below, which is what makes "print before the JSON" unreachable
	// rather than merely absent.
	const emitter = createEmitter({ json: JSON_OUT });
	const log = emitter.log;

	const manifest = loadManifest();
	const ONLY = machineArg();
	let result;
	try {
		result = await runDoctor({ manifest, only: ONLY });
	} catch (err) {
		// The probe itself broke, so nothing was measured. Under `--json` that is
		// still ONE document with the reason, never an empty stdout: the cron
		// reads an empty stdout as "the checker broke" and discards why.
		const error = `the toolchain probe failed before any node was judged: ${err.message}`;
		console.error(error);
		if (JSON_OUT) {
			emitter.emit({
				ok: false,
				error,
				toolCache: {},
				machines: [],
				noneProbed: error,
			});
		}
		process.exit(1);
	}
	const { toolCache, report, latest } = result;
	// ZERO NODES PROBED IS NOT A CLEAN FLEET (#98). `--machine` with a typo, or a
	// manifest where every node is excluded, probed nothing and exited 0 with
	// "Every node matches".
	const noneProbed =
		report.length === 0
			? ONLY
				? `--machine ${ONLY} selected no probeable node — check the name against the manifest`
				: `no node was probed — every machine in the manifest is excluded`
			: null;
	if (noneProbed) console.error(`✗ ${noneProbed}. Nothing probed is not "nothing drifted".`);

	log('Toolchain declared: tool cache, plus every REPAIRS tool each node carries.');
	log(
		`Tool cache: ${Object.entries(toolCache)
			.filter(([k]) => !k.startsWith('$'))
			.map(([l, v]) => `${l} ${v.join('/')}`)
			.join(', ')}\n`
	);

	if (JSON_OUT) {
		emitter.emit({
			toolCache,
			machines: report,
			// ADDITIVE: what upstream said per tool, so an `unknown` is diagnosable.
			toolLatest: latest,
			toolToleranceMinutes: TOLERANCE_MINUTES,
			// ADDITIVE (#98): why a run that probed nothing failed. `null` otherwise.
			noneProbed,
		});
	} else {
		for (const r of report) {
			if (r.unreachable) {
				log(
					r.expectedDown
						? `── ${r.machine}  [expected down]\n   ${r.drainNote}`
						: `── ${r.machine}\n   UNREACHABLE — ${r.error}`
				);
				continue;
			}
			const flag = r.drift ? 'DRIFT' : 'ok';
			log(`── ${r.machine}  [${flag}]`);
			log(`   ${r.os}   python3 ${r.python}   venv-capable: ${r.ensurepip ? 'yes' : 'NO'}`);
			if (!r.toolCacheWritable) log(`   ! /opt/hostedtoolcache is NOT writable by the runner user`);
			if (r.missingCache.length) log(`   ! missing tool cache: ${r.missingCache.join(', ')}`);
			if (r.tools && r.tools.length === 0) {
				log(
					`   ! zero REPAIRS tools were evaluated here — "nothing checked" is not ` +
						`"nothing wrong"`
				);
			}
			for (const t of r.toolFindings) log(`   ! tool ${t.id} [${t.status}]: ${t.reason}`);
			for (const a of r.advisories ?? []) log(`   advisory: ${a.message}\n     ${a.fix}`);
			if (r.pnpmDrift) {
				// TWO CAUSES REACH THIS SAME MISSING DIRECTORY, AND THEY HAVE
				// DIFFERENT REMEDIES. Until 2026-09-09 this printed the shadowing
				// story for both, so claw-7 and claw-8 were told to run
				// `sudo corepack enable` on nodes where pnpm ALREADY resolved to
				// corepack's shim — a no-op that would have left the drift exactly
				// where it was. A finding that names the wrong cause is
				// unactionable, which is the whole point of saying WHY.
				//
				// The probe already carries the evidence that separates them:
				// `pnpm_bin` is the RESOLVED binary. Corepack's shim lives under a
				// corepack dist; an npm-global pnpm does not.
				const shadowed = !/corepack/.test(r.pnpmBin ?? '');
				log(
					`   ! pnpm ${r.pnpm ?? '?'} (${r.pnpmBin ?? '?'}) reports a store directory that ` +
						`does not exist.`
				);
				log(
					shadowed
						? `     A globally-installed pnpm is shadowing corepack, and the store doctor ` +
								`trusts this path — so corruption repair is a silent no-op. ` +
								`Fix: sudo corepack enable`
						: `     pnpm IS corepack's shim here, so nothing is shadowing it — the store has ` +
								`simply never been created. It is made lazily by the first package fetch, ` +
								`and \`pnpm store prune\` against a missing store is a no-op. ` +
								`Fix: fetch one package as the runner user FROM ITS HOME — pnpm keeps the ` +
								`store on the filesystem it hardlinks into, and /tmp is tmpfs here, so a ` +
								`/tmp warm-up builds a store in RAM and changes nothing.`
				);
			}
			if (r.backstop) {
				const b = r.backstop;
				const sliceContrast =
					b.unitCapReachesSlice === null
						? ''
						: b.unitCapReachesSlice
							? ` — reaches its ${b.sliceMaxMb} MB slice, as a claw's units do (#26)`
							: ` against a ${b.sliceMaxMb} MB slice — claws' units reach their slice ` +
								`(#26); a job needing more than ${b.unitMaxMb[0]} MB is OOM-killed here ` +
								`even though the slice could hold it`;
				const unitCapLine =
					b.unitMaxMb.length === 0
						? 'no runner units found'
						: b.unitMaxMb.length === 1
							? `flat ${b.unitMaxMb[0]} MB across ${b.unitCount} unit(s)${sliceContrast}`
							: `NOT FLAT — ${b.unitMaxMb.join('/')} MB across ${b.unitCount} unit(s)`;
				const availLine =
					b.availableMb === null
						? 'unknown — could not read MemAvailable'
						: `${b.available === false ? 'no' : b.available === true ? 'yes' : 'unknown'} — ` +
							`${(b.availableMb / 1024).toFixed(1)} GB free` +
							(b.floorMb === null ? '' : ` (floor ${(b.floorMb / 1024).toFixed(1)} GB)`) +
							(b.topHolder && b.topHolder.cmd
								? ` — top holder: ${b.topHolder.cmd} (~${b.topHolder.rssMb} MB)`
								: '');
				const harvestLine = b.harvesterDrift
					? `STALE — ${b.harvesterPath === null ? 'no running harvester' : b.harvesterBytes === null ? `${b.harvesterPath} unreadable` : `${b.harvesterBytes} B at ${b.harvesterPath}`} vs ${b.harvesterRepoBytes} B shipped by this package (by CONTENT, sha256)`
					: `current (${b.harvesterBytes} B, sha256 matches)`;
				log(`   BACKSTOP READINESS (advisory — informational only, never a finding):`);
				log(`     per-unit memory cap: ${unitCapLine}`);
				log(`     backstop available: ${availLine}`);
				log(`     harvester: ${harvestLine}`);
				// #79 hygiene — reported, never repaired: each advisory names its own
				// one-line fix for the OPERATOR to run by hand on the backstop.
				for (const adv of b.advisories ?? []) {
					log(`     advisory [${adv.id}]: ${adv.message}`);
					log(`       fix: ${adv.fix}`);
				}
			}
		}
	}

	const drifted = report.filter((r) => r.drift && !r.unreachable);
	// Only UNEXPECTED unreachability fails. A deferred node is still listed above.
	const unreachable = report.filter((r) => r.unreachable && !r.expectedDown);
	const expectedDown = report.filter((r) => r.unreachable && r.expectedDown);

	if (drifted.length && !JSON_OUT) {
		log('\nTo converge:');
		for (const r of drifted) {
			// One suggestion per LANGUAGE, not per version: the seed copies the whole
			// language tree, so emitting it per missing version prints the same
			// command three times and invites someone to run it three times.
			for (const lang of [...new Set(r.missingCache.map((k) => k.split('/')[0]))]) {
				// Seed from a node that HAS it rather than downloading: the version
				// already on a claw is the one the workflows are pinned to, and
				// actions/python-versions has no trixie build to download anyway.
				const donor = report.find(
					(d) =>
						!d.unreachable &&
						Object.entries(d.cache ?? {}).some(([k, v]) => v && k.startsWith(`${lang}/`))
				);
				if (!donor) {
					log(`  # ${lang} missing on ${r.machine} and NO node has it to copy from`);
					continue;
				}
				// The target may be THIS host, which cannot ssh itself — the same trap
				// that made the fast loop read hokon as permanently saturated.
				const sink = isLocalNode(r.machine)
					? `tar -C /opt/hostedtoolcache -xf -`
					: `ssh ${r.machine} "tar -C /opt/hostedtoolcache -xf -"`;
				log(
					`  # seed ${lang} on ${r.machine} from ${donor.machine}:\n` +
						`  ssh ${donor.machine} "tar -C /opt/hostedtoolcache -cf - ${lang}" | ${sink}`
				);
			}
		}
	}

	if (!JSON_OUT) {
		log(
			`\n${drifted.length ? `${drifted.length} node(s) DRIFTED` : noneProbed ? 'No node was probed.' : 'Every node matches the declared toolchain.'}` +
				(unreachable.length ? `  (${unreachable.length} unreachable)` : '') +
				(expectedDown.length ? `  (${expectedDown.length} expected down)` : '')
		);
	}
	process.exit(drifted.length || unreachable.length || noneProbed ? 1 : 0);
}

// Run only as the entry point, so a test can import the pure halves (today,
// only through `scripts/lib/toolchain-doctor.mjs`).
const entry = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (entry === realpathSync(fileURLToPath(import.meta.url))) await main();
