/**
 * `fleet bootcamp --write`'s manifest facet write — split out of
 * scripts/bootcamp.mjs (wave 5p lane D) so the CLI stays under the 800-line
 * ceiling. Takes the CLI's flags and run-scoped state through `ctx`; never
 * imports the CLI.
 */
import { manifestPath } from './fleet-exec.mjs';
import { carryMeasurements } from './idle-measure.mjs';
import { landingLine } from './manifest-target.mjs';
import { manifestEdit } from './manifest-edit.mjs';
import { sameCapabilityRecord } from './bootcamp-required.mjs';

/**
 * What `--write` did to the record, for a caller that reads the document.
 * `null` without `--write`.
 */
export async function writeManifestFacet(ctx) {
	if (!ctx.WRITE) return null;
	const { report, log, NO_PUSH } = ctx;
	// THIS NO LONGER WRITES `machines[].labels` AT ALL.
	//
	// It used to append every `unclaimed` capability to the node's `labels`
	// array, which was the right move while a declaration was how a label
	// reached a registration. It is not any more: `nodeOffer` (src/lib/capability-offer.ts,
	// issue #19) derives a node's label offer from `$capabilities.earned`, and
	// every mint, warm listener, placement check and reconciled registration
	// reads that one answer. So the facet below is the whole write.
	//
	// It is also now the only SAFE write. Under the 2026-09-10 `earned`
	// semantics a proven capability is any capability the probe executed, and
	// appending those to `labels` would have declared `ffmpeg`, `gh`,
	// `python-venv`, `python-toolcache`, `playwright` and `jitconfig` as GitHub
	// runner labels on all eight machines — which `validateCapabilities`
	// rejects as `surface-mismatch` (a toolchain capability applies to every
	// node, so routing on it says nothing) and which re-introduces exactly the
	// hand-declared labels the 2026-09-07 "derived, never declared" decision
	// removes.
	const mp = manifestPath();
	let recorded = 0;
	// CHANGED, not merely re-probed. See the `sameCapabilityRecord` block below.
	let changed = 0;
	const at = new Date().toISOString();
	// `manifestEdit` (scripts/lib/manifest-edit.mjs, wave 5c F4) owns: asking
	// `writeTarget` BEFORE anything is written (the refusal this most needs to
	// make — the deploy tree — is one where the write SUCCEEDS and is erased
	// later, and a read-back cannot catch that, only refusing the target can),
	// a FRESH read, rendering through `renderJson` (#12), writing ATOMICALLY,
	// reading back and comparing, and `landWrite`. This closure only decides
	// WHAT changes and whether anything needs writing at all.
	const result = await manifestEdit(
		(raw) => {
			for (const [name, r] of Object.entries(report)) {
				const node = raw.machines?.[name];
				if (!node) continue;
				// THE SUPPLY LEDGER'S CAPABILITY FACET — P1.1. `$benchmark` (fleet
				// benchmark) and `$measured` (fleet enroll) already write a
				// `{at, by, ...}` block straight onto this same machine entry; nothing
				// did that for what bootcamp proves, so the earned/blocked/unprobed
				// verdict lived only in a run's stdout and the manifest kept the
				// labels a human had asserted, with no record of when — or whether —
				// they were last checked. This is written for EVERY node this run
				// could reach, not only the ones with something new to report, because
				// it is a snapshot of what the probe found, not a diff. A node this
				// run could not reach keeps whatever `$capabilities` it already had
				// rather than being overwritten with silence — "I could not look" must
				// not read as "nothing is here". See
				// docs/planning/supply-ledger-2026-09-07.md.
				const prev = node.$capabilities;
				// THE IDLE MEASUREMENT BEHIND EACH IDLE-ONLY VERDICT (2026-10-10):
				// `{ value, idle: true, earned, at }`, so a reader can tell an earn
				// taken on a quiet node from one that predates the rule (no entry). It
				// moves only when the verdict does — `carryMeasurements` says why
				// (#59) — and an unjudged run leaves it exactly as it was.
				const measurements = carryMeasurements(prev, r.measuredIdle, at);
				const record = {
					at,
					by: 'fleet bootcamp',
					declared: r.declared,
					earned: r.earned,
					unclaimed: r.unclaimed,
					unearned: r.unearned,
					blocked: r.blocked,
					prereqs: r.prereqs,
					unprobed: r.unprobed,
					...(Object.keys(measurements).length ? { measurements } : {}),
				};
				// `at` MEANS "WHEN THIS FINDING LAST CHANGED", NOT "WHEN WE LAST LOOKED".
				//
				// Issue #59. The stamp above is fresh on every pass, so a node whose
				// probe returned exactly what it returned last time still produced a
				// changed file — and this writer LANDS ITS WRITES AS COMMITS on
				// hadoku_site (`manifest-target.mjs`, and it has to: a write there that
				// is not a commit is erased by the next redeploy). hadoku_site's
				// `redeploy-mgmt-api.yml` filters on this exact path, so every
				// no-op bootcamp restarted the production API. Observed on claw-9,
				// 2026-09-23: `538c9d00` and `3faeb8fe`, eleven minutes apart, one
				// changed line each, and the line was `at`.
				//
				// Carrying the PREVIOUS `at` forward when nothing else moved is what
				// makes the write byte-identical, which is what makes `manifestEdit`
				// report `changed: false` and commit nothing. "When did we last look"
				// is still answered — on stdout, below, where a run's own bookkeeping
				// belongs.
				//
				// AND THE GATE READS OBSERVED STATE, not this writer's intent
				// (CLAUDE.md): the comparison is against what is ON DISK in the
				// manifest, not against a record this process wrote earlier.
				if (sameCapabilityRecord(prev, record)) record.at = prev.at;
				else changed++;
				node.$capabilities = record;
				recorded++;
			}
			return changed > 0;
		},
		{
			target: mp,
			writer: 'bootcamp',
			// THE SUBJECT COUNTS WHAT MOVED. `${recorded}` here read "for 1 node(s)"
			// on a commit whose only changed line was a timestamp (#59). Evaluated
			// lazily — only once `changed` is known — because `manifestEdit` calls
			// this after the closure above has run.
			reason: () => `$capabilities for ${changed} node(s)`,
			push: !NO_PUSH,
		}
	);
	let written;
	if ('ok' in result && result.ok === false) {
		log(result.why);
		ctx.findings++;
		written = { ok: false, reason: `${result.reason}: ${result.why}` };
	} else if (!result.changed) {
		if (recorded) {
			written = { ok: true, reason: 'unchanged' };
			// RE-PROBED AND IDENTICAL. Not "nothing to write" — every node this run
			// reached was read, and the record already in the manifest is the record
			// this run would have written. Saying so is the point: a run that goes
			// quiet here is indistinguishable from one that probed nobody, which is
			// the "exit 0 with no evidence" shape this repo refuses everywhere else.
			log(
				`\n✓ ${recorded} capability record(s) re-probed and UNCHANGED — nothing written, ` +
					`nothing committed.\n` +
					`  \`$capabilities.at\` still reads when each finding last CHANGED, not when it ` +
					`was last checked;\n` +
					`  restamping it on every pass is what made an idempotent run redeploy mgmt-api (#59).`
			);
		} else {
			log(`\n  nothing to write — no node reachable`);
			written = { ok: false, reason: 'no node reachable' };
		}
	} else {
		// FORMATTED THE WAY THE OWNING REPO WOULD (#12), which is not optional for
		// a file that lives in hadoku_site's checkout rather than this one. See
		// `manifest-edit.mjs` for why an unresolvable prettier degrades to plain
		// output rather than throwing or claiming the write was clean.
		log(
			`\n✓ wrote ${changed} changed capability record(s) of ${recorded} re-probed — ` +
				'`$capabilities` only, never `labels`'
		);
		if (result.formatter) log(`  formatted by ${result.formatter}`);
		else
			log(
				`  ! UNFORMATTED: no prettier could be resolved from ${mp}'s own tree, so this is plain\n` +
					`    JSON.stringify output. The records are correct and saved; the owning repo's\n` +
					`    format:check will very likely reject the file until it is run through prettier there.`
			);
		// AND NOW MAKE IT SURVIVE. The commit is the only part of this that a
		// redeploy cannot undo (the write that was erased 40 seconds later on
		// 2026-09-14 had already done everything else right).
		const landed = result.landed;
		log(landingLine(landed, { writer: 'bootcamp' }));
		if (!landed.ok) ctx.findings++;
		written = landed.ok
			? { ok: true, reason: landed.reason ?? 'landed' }
			: { ok: false, reason: `${landed.reason}: ${landed.why ?? ''}`.trim() };
	}
	return written;
}
