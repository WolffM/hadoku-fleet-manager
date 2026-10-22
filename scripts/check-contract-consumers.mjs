#!/usr/bin/env node
/**
 * check-contract-consumers — every declared consumer of this CLI's output must
 * exist, know its own job name, and still hold the property it was declared for.
 *
 * TWO CONTRACTS, because there are two ways to consume this CLI: `JSON_CONTRACT`
 * (ten crons parsing stdout as JSON) and `PROSE_CONTRACT` (one job reading
 * stdout+stderr against a regex). The second was added on 2026-09-07 after a
 * provenance banner shipped to every subcommand's stderr with a producer-side
 * test that covered the JSON half exactly — and could not see the prose half,
 * because nothing had written it down. See `lib/json-contract.mjs`.
 *
 * WHY, IN ONE MEASUREMENT
 * -----------------------
 * `JSON_CONTRACT` declares which mgmt-api cron jobs parse this CLI's stdout, and
 * `json-contract.test.mjs` proves the PRODUCER side of each: the subcommand
 * resolves, it handles `--json`, it writes stdout only through `lib/emit.mjs`.
 * All of that was true of `ci:fleet-benchmark` from the day it was declared.
 *
 * The consumer it named — `services/mgmt-api/src/routes/jobs/fleet-benchmark-check.ts`
 * — did not exist for three days, and nothing said so. The entry was written in
 * the same commit that made the subcommand nightly-safe: the producer shipped,
 * the coupling was written down, and the other half was left for a repo the
 * author was not in. Anyone reading the list saw `ci:fleet-benchmark` and
 * believed the fleet was re-measuring itself nightly.
 *
 * CLAUDE.md says "the LIST is the declaration", and it says so because the prose
 * beside it carried a stale count twice. A list whose entries are ASPIRATIONAL
 * is worse than a stale count: it reads as evidence. This gate is what makes the
 * list mean what it claims.
 *
 * WHAT IT PROVES, AND WHAT IT DELIBERATELY DOES NOT
 * ------------------------------------------------
 * It proves the consumer file is on disk and mentions the job name — enough to
 * catch "declared but never written" and "renamed on one side only", which are
 * the two ways this drifts. It does NOT prove the job is SCHEDULED; that lives
 * in `services/cron-worker/profiles.json` and is already gated on the other side
 * by hadoku_site's `check:cron-registry`, which fails when a schedule names a
 * job the registry lacks. Two gates, one from each end, and neither can be
 * derived from the other.
 *
 * A MISSING CHECKOUT FAILS, LOUDLY
 * --------------------------------
 * This reads a SIBLING repo, so it can be run somewhere hadoku_site is not on
 * disk — and "I could not look" must never render as "nothing is wrong". A
 * missing site checkout is reported as such and exits non-zero, rather than
 * quietly finding zero problems in zero files. That is the same rule
 * `check-identity-model` and `check-header-fleet` follow for the same reason.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { reposDir, siteRoot } from './lib/paths.mjs';
import { blankComments } from './lib/blank-comments.mjs';
import {
	JSON_CONTRACT,
	PROSE_CONTRACT,
	evidenceRegExp,
	parseAuditGates,
	suppressesBanner,
} from './lib/json-contract.mjs';
import { createEmitter } from './lib/emit.mjs';
import { provenance, provenanceLine } from '../dist/lib/provenance.js';
import { hubRepo } from '../dist/lib/fleet-config.js';

const out = createEmitter();

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	console.log(
		`fleet contract-consumers — every --json contract entry names a real consumer\n\n` +
			`  --json    machine-readable findings\n\n` +
			`Reads scripts/lib/json-contract.mjs and checks each entry's \`consumer\`\n` +
			`path exists in the ${hubRepo()} checkout and mentions the job name.\n` +
			`PROSE_CONTRACT entries are checked further: the consumer must suppress\n` +
			`this CLI's provenance banner, and the banner must satisfy no gate's\n` +
			`\`evidence\` regex.\n`
	);
	process.exit(0);
}

/**
 * A floor, not the count. Measured 2026-09-07: 13 of the 19 gates run through
 * this CLI. The number moves; a parse yielding a handful means the table
 * changed shape and every evidence check is asserting over nothing.
 */
const MIN_FLEET_GATES = 8;

/**
 * The banner strings to test a gate's `evidence` against.
 *
 * Built with the REAL formatter (`provenanceLine`), never a copy of its shape —
 * a hand-written sample would keep passing after the format changed, which is
 * the failure this whole file exists to prevent one layer up.
 *
 * Three samples, because the banner carries OPERATOR-CONTROLLED PATHS and the
 * path is what matches: what this box resolves right now, the operator's
 * `~/repos` layout (which is what an operator reproducing a cron finding by
 * hand uses — issue #4's own scenario, and where `check:ci-watch` was measured
 * failing), and the unresolved form. Samples cannot prove the class — a
 * checkout under `~/tools` would satisfy `check:tool-inventory` and no sample
 * here would show it. Rule 1 is what closes the class; this is the measured
 * case, kept because it is the one that actually happened.
 */
function bannerSamples() {
	const live = provenance();
	const repos = join(reposDir(), hubRepo());
	// Deduped: on an operator box the live resolution and the `~/repos` sample are
	// the same string, and reporting one finding twice reads as two problems.
	return [
		...new Set([
			provenanceLine(live),
			provenanceLine({
				site: repos,
				manifests: join(repos, 'scripts', 'admin'),
				version: live.version,
			}),
			provenanceLine({
				site: `<unresolved: the ${hubRepo()} checkout does not exist>`,
				manifests: '<unresolved: FLEET_MANIFEST_DIR does not exist>',
				version: live.version,
			}),
		]),
	];
}

const findings = [];
const ok = [];

let root;
try {
	root = siteRoot();
} catch (err) {
	root = null;
	findings.push({
		kind: 'NO-CHECKOUT',
		why: `cannot resolve the ${hubRepo()} checkout: ${err instanceof Error ? err.message : String(err)}`,
	});
}

if (root && !existsSync(root)) {
	findings.push({ kind: 'NO-CHECKOUT', why: `${hubRepo()} checkout not on disk at ${root}` });
	root = null;
}

if (root) {
	for (const entry of JSON_CONTRACT) {
		const rel = entry.consumer;
		if (!rel) {
			findings.push({
				kind: 'NO-CONSUMER-DECLARED',
				job: entry.job,
				sub: entry.sub,
				why: `entry for ${entry.job} declares no consumer path`,
			});
			continue;
		}
		const abs = join(root, rel);
		if (!existsSync(abs)) {
			findings.push({
				kind: 'MISSING',
				job: entry.job,
				sub: entry.sub,
				consumer: rel,
				why:
					`${entry.job} names ${rel}, which does not exist. The contract asserts a cron ` +
					`consumes \`fleet ${entry.sub}\`; nothing does. Either write the consumer or ` +
					`remove the entry — an aspirational entry reads as evidence.`,
			});
			continue;
		}
		// A file that exists but never mentions the job is the rename case: one
		// side moved and the other did not, which the existence check alone misses.
		const body = readFileSync(abs, 'utf8');
		if (!body.includes(entry.job)) {
			findings.push({
				kind: 'NAME-DRIFT',
				job: entry.job,
				sub: entry.sub,
				consumer: rel,
				why: `${rel} exists but never mentions "${entry.job}" — the two sides have drifted`,
			});
			continue;
		}
		ok.push({ job: entry.job, sub: entry.sub, consumer: rel });
	}

	for (const entry of PROSE_CONTRACT) {
		const rel = entry.consumer;
		const abs = join(root, rel);
		if (!existsSync(abs)) {
			findings.push({
				kind: 'MISSING',
				job: entry.job,
				consumer: rel,
				why:
					`${entry.job} names ${rel}, which does not exist. It is declared as reading ` +
					`this CLI's stdout+stderr as prose; nothing does.`,
			});
			continue;
		}
		const raw = readFileSync(abs, 'utf8');
		if (!raw.includes(entry.job)) {
			findings.push({
				kind: 'NAME-DRIFT',
				job: entry.job,
				consumer: rel,
				why: `${rel} exists but never mentions "${entry.job}" — the two sides have drifted`,
			});
			continue;
		}
		const body = blankComments(raw);

		// RULE 1 — THE MECHANISM. The consumer must silence the banner. This is
		// the rule that closes the CLASS: with the banner absent, nothing this
		// CLI's WRAPPER writes can reach a gate's verdict, whatever the banner
		// happens to say and whatever the gate happens to match on.
		const suppressed = suppressesBanner(body);
		if (!suppressed) {
			findings.push({
				kind: 'BANNER-NOT-SUPPRESSED',
				job: entry.job,
				consumer: rel,
				why:
					`${rel} merges stdout and stderr into one value and judges gates by a regex ` +
					`over it, but never sets ${entry.requires}=1. Every subcommand's provenance ` +
					`banner therefore lands in that value: it can satisfy a gate's \`evidence\` on ` +
					`its own, and it makes \`out.trim()\` never empty, which is what \`spawnError\` ` +
					`tests to tell "it never started" from "it found something". Set ` +
					`${entry.requires}: '1' in the gate environment.`,
			});
		}

		// RULE 2 — WHICH GATES THAT ACTUALLY COSTS, and ONLY when rule 1 is
		// already broken.
		//
		// Conditional on purpose. Once the banner is suppressed it is not in the
		// consumer's `out` at all, so asking whether it WOULD have matched is a
		// question about a string nobody sees — and a gate that stays red for a
		// state that is safe is a gate nobody reads, which is a worse outcome
		// than not having written it. So rule 2 does not stand alone: it turns
		// "you dropped FLEET_NO_BANNER" into "you dropped it and HERE is the gate
		// that now passes on a path", which is the difference between a finding
		// and an actionable one.
		//
		// Only `script: 'fleet'` gates can ever see this CLI's output; the other
		// six run `scripts/admin/*.mjs` and are not ours to reason about.
		if (!suppressed) {
			const fleetGates = parseAuditGates(body).filter((g) => g.script === 'fleet');
			if (fleetGates.length < MIN_FLEET_GATES) {
				// A parse of nothing is not a pass. If the table moved, the loop
				// below would test the banner against an empty list and say clean.
				findings.push({
					kind: 'GATE-TABLE-UNREADABLE',
					job: entry.job,
					consumer: rel,
					why:
						`parsed ${fleetGates.length} \`script: 'fleet'\` gate(s) from ${rel}, expected at ` +
						`least ${MIN_FLEET_GATES}. The GATES table moved or changed shape, so the ` +
						`evidence check below is looking at nothing.`,
				});
			}
			for (const banner of bannerSamples()) {
				for (const g of fleetGates) {
					if (!evidenceRegExp(g.evidence).test(banner)) continue;
					findings.push({
						kind: 'BANNER-SATISFIES-EVIDENCE',
						job: entry.job,
						consumer: rel,
						gate: g.id,
						why:
							`${g.id}'s evidence ${g.evidence} is satisfied by this CLI's banner ALONE ` +
							`(${banner}). A gate that exits 0 having printed nothing would report ` +
							`ok: true instead of "exited 0 but printed nothing showing it looked". ` +
							`No gate may get easier to pass the worse the failure gets.`,
					});
				}
			}
		}
		if (!findings.some((f) => f.job === entry.job)) {
			ok.push({ job: entry.job, sub: 'prose', consumer: rel });
		}
	}

	// ZERO ENTRIES CHECKED IS A FAILURE. An empty contract would sail through
	// every loop above and report a clean sweep of nothing — the same shape as a
	// manifest resolving to an empty directory and reporting a healthy fleet of
	// zero machines.
	if (!JSON_CONTRACT.length) {
		findings.push({
			kind: 'EMPTY-CONTRACT',
			why: 'JSON_CONTRACT holds no entries, so this gate checked nothing',
		});
	}
	if (!PROSE_CONTRACT.length) {
		findings.push({
			kind: 'EMPTY-CONTRACT',
			why: 'PROSE_CONTRACT holds no entries, so the prose half checked nothing',
		});
	}
}

out.log(
	`Contract entries: ${JSON_CONTRACT.length} json + ${PROSE_CONTRACT.length} prose   ` +
		`consumers verified: ${ok.length}`
);
for (const f of findings) {
	out.warn(`${f.kind.padEnd(21)} ${f.job ?? ''}`);
	out.warn(`  ${f.why}`);
}
for (const o of ok) out.log(`  ✓ ${o.job.padEnd(22)} ${o.consumer}`);
if (!findings.length)
	out.log('✓ every contract entry names a consumer that exists and knows its job name');

if (out.json) {
	out.emit({
		entries: JSON_CONTRACT.length + PROSE_CONTRACT.length,
		jsonEntries: JSON_CONTRACT.length,
		proseEntries: PROSE_CONTRACT.length,
		verified: ok.length,
		findings,
		ok,
		lines: out.held(),
	});
}

process.exit(findings.length ? 1 : 0);
